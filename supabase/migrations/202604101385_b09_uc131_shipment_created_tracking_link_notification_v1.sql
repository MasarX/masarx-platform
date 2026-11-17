BEGIN;

SELECT pg_advisory_lock(hashtext('202604101385_b09_uc131_shipment_created_tracking_link_notification_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'shipment_created_notification_policy',
  'Shipment-created SMS notification policy with tracking-link message rendering.',
  TRUE,
  TRUE,
  TRUE,
  'skip',
  '["global","tenant","client","sender"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'shipment_created_notification_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Shipment Created Notification Policy",
    "type": "object",
    "additionalProperties": true,
    "required": [
      "version",
      "enabled",
      "channel",
      "message_template",
      "tracking_link_base_url",
      "tracking_link_path"
    ],
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": "boolean" },
      "channel": { "type": "string", "enum": ["sms"] },
      "priority": { "type": "integer", "minimum": 0 },
      "max_retries": { "type": "integer", "minimum": 0 },
      "tracking_link_base_url": { "type": "string" },
      "tracking_link_path": { "type": "string" },
      "message_template": { "type": "string" }
    }
  }'::jsonb,
  'Shipment-created SMS notification policy resolved through the settings ladder.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'channel', 'sms',
      'priority', 80,
      'max_retries', 3,
      'tracking_link_base_url', 'https://nzxmhryhtqlzoshjkyozkpup.example.invalid',
      'tracking_link_path', '/track/',
      'message_template', 'Your shipment {{tracking_number}} is ready. Track it here: {{tracking_link}}'
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  deprecated_at = NULL,
  updated_at = now();

DO $$
DECLARE
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_settings_version_number INT;
BEGIN
  SELECT settings_id, settings_version_id, settings_version_number
    INTO v_settings_id, v_settings_version_id, v_settings_version_number
    FROM public.upsert_settings_value_v1(
    'shipment_created_notification_policy',
    'global',
    NULL,
    '{
      "version": 1,
      "enabled": true,
      "channel": "sms",
      "priority": 80,
      "max_retries": 3,
      "tracking_link_base_url": "https://nzxmhryhtqlzoshjkyozkpup.example.invalid",
      "tracking_link_path": "/track/",
      "message_template": "Your shipment {{tracking_number}} is ready. Track it here: {{tracking_link}}"
    }'::jsonb,
    1,
    'Seed shipment created notification policy'
  );
END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_created_notification_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_meta JSONB := COALESCE(v_ctx->'payload'->'resource'->'metadata', '{}'::jsonb);
  v_shipment_id UUID := COALESCE(
    NULLIF(v_ctx#>>'{shipment,id}', '')::UUID,
    NULLIF(v_ctx->>'shipment_id', '')::UUID,
    NULLIF(v_ctx->>'planned_shipment_id', '')::UUID,
    NULLIF(v_ctx#>>'{workflow,context_patch,shipment,id}', '')::UUID
  );
  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_recipient_id UUID := NULL;
  v_settings RECORD;
  v_settings_resolution_id UUID := NULL;
  v_scope_path JSONB := '[]'::jsonb;
  v_shipment RECORD;
  v_recipient RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_render_context JSONB := '{}'::jsonb;
  v_tracking_link_base TEXT := 'https://nzxmhryhtqlzoshjkyozkpup.example.invalid';
  v_tracking_link_path TEXT := '/track/';
  v_tracking_link TEXT := NULL;
  v_message_template TEXT := 'Your shipment {{tracking_number}} is ready. Track it here: {{tracking_link}}';
  v_message TEXT := NULL;
  v_priority INT := 80;
  v_max_retries INT := 3;
  v_enabled BOOLEAN := TRUE;
  v_channel TEXT := 'sms';
  v_outbound_id UUID := NULL;
  v_decision_outcome TEXT := 'skipped';
  v_decision_reason TEXT := NULL;
  v_corr UUID := NULL;
  v_response public.workflow_handler_response;
BEGIN
  BEGIN
    v_corr := NULLIF(v_ctx->>'correlation_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_corr := NULL;
  END;

  IF v_shipment_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  SELECT s.id, s.organization_id, s.client_id, s.sender_id, s.tracking_number, s.recipient_id, s.metadata
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = v_shipment_id
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'shipment_not_found');
    RETURN v_response;
  END IF;

  v_org_id := v_shipment.organization_id;
  v_client_id := v_shipment.client_id;
  v_sender_id := v_shipment.sender_id;
  v_recipient_id := COALESCE(
    v_shipment.recipient_id,
    NULLIF(v_meta->>'recipient_id', '')::UUID,
    NULLIF(v_ctx->>'recipient_id', '')::UUID,
    NULLIF(v_ctx#>>'{workflow,context_patch,shipment,recipient_id}', '')::UUID
  );

  IF v_shipment.recipient_id IS NULL AND v_recipient_id IS NOT NULL THEN
    UPDATE public.shipments
       SET recipient_id = v_recipient_id,
           updated_at = now()
     WHERE id = v_shipment_id
       AND recipient_id IS NULL;
  END IF;

  SELECT r.id, NULLIF(btrim(r.name), '') AS name, NULLIF(btrim(r.email), '') AS email, NULLIF(btrim(r.phone_number), '') AS phone_number
    INTO v_recipient
    FROM public.recipients r
   WHERE r.id = v_recipient_id
   LIMIT 1;

  v_render_context := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_shipment_id,
    'tracking_number', v_shipment.tracking_number,
    'tracking_link', NULL,
    'recipient_id', v_recipient_id,
    'recipient_name', v_recipient.name,
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id
  ));

  SELECT *
    INTO v_settings
    FROM public.resolve_settings_row_from_context(
      'shipment_created_notification_policy',
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id
      ))
    )
   LIMIT 1;

  IF v_settings.settings_id IS NOT NULL THEN
    v_scope_path := COALESCE(v_settings.scope_path, '[]'::jsonb);
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'shipment_created_notification_policy',
      p_winning_scope_type := v_settings.scope_type,
      p_winning_scope_id := v_settings.scope_id,
      p_winning_settings_id := v_settings.settings_id,
      p_winning_settings_version_id := v_settings.settings_version_id,
      p_winning_version := v_settings.version,
      p_scope_path := v_scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'shipment_id', v_shipment_id
      )),
      p_merge_notes := NULL
    );

    v_policy := COALESCE(v_settings.value, '{}'::jsonb);
    BEGIN
      v_enabled := COALESCE(NULLIF(v_policy->>'enabled', '')::BOOLEAN, TRUE);
    EXCEPTION
      WHEN others THEN
        v_enabled := TRUE;
    END;
    BEGIN
      v_priority := COALESCE(NULLIF(v_policy->>'priority', '')::INT, v_priority);
    EXCEPTION
      WHEN others THEN
        v_priority := 80;
    END;
    BEGIN
      v_max_retries := COALESCE(NULLIF(v_policy->>'max_retries', '')::INT, v_max_retries);
    EXCEPTION
      WHEN others THEN
        v_max_retries := 3;
    END;

    v_channel := lower(COALESCE(NULLIF(btrim(v_policy->>'channel'), ''), 'sms'));
    v_tracking_link_base := COALESCE(NULLIF(btrim(v_policy->>'tracking_link_base_url'), ''), v_tracking_link_base);
    v_tracking_link_path := COALESCE(NULLIF(btrim(v_policy->>'tracking_link_path'), ''), v_tracking_link_path);
    v_message_template := COALESCE(NULLIF(v_policy->>'message_template', ''), v_message_template);
  END IF;

  IF NOT v_enabled THEN
    v_decision_outcome := 'skipped';
    v_decision_reason := 'policy_disabled';
  ELSIF v_channel <> 'sms' THEN
    v_decision_outcome := 'skipped';
    v_decision_reason := 'unsupported_channel';
  ELSIF v_recipient_id IS NULL THEN
    v_decision_outcome := 'skipped';
    v_decision_reason := 'recipient_missing';
  ELSIF v_recipient.id IS NULL THEN
    v_decision_outcome := 'skipped';
    v_decision_reason := 'recipient_not_found';
  ELSIF v_recipient.phone_number IS NULL THEN
    v_decision_outcome := 'skipped';
    v_decision_reason := 'recipient_phone_missing';
  ELSE
    v_tracking_link := rtrim(v_tracking_link_base, '/') || '/' || ltrim(v_tracking_link_path, '/');
    v_render_context := jsonb_strip_nulls(v_render_context || jsonb_build_object('tracking_link', v_tracking_link));
    v_message := trim(both '"' FROM public.render_template(to_jsonb(v_message_template), v_render_context)::text);
    IF v_message IS NULL OR btrim(v_message) = '' THEN
      v_decision_outcome := 'skipped';
      v_decision_reason := 'message_template_empty';
    ELSE
      BEGIN
        INSERT INTO public.outbound_calls (
          call_type,
          target_type,
          target_id,
          method,
          url,
          headers,
          body,
          priority,
          max_retries,
          context,
          correlation_id,
          shipment_id
        )
        VALUES (
          'comms_sms',
          'recipient',
          v_recipient_id,
          'POST',
          'comms://sms',
          '{}'::jsonb,
          jsonb_strip_nulls(jsonb_build_object(
            'stage', 'shipment_created',
            'message', v_message,
            'tracking_number', v_shipment.tracking_number,
            'tracking_link', v_tracking_link,
            'shipment_id', v_shipment_id,
            'recipient_id', v_recipient_id,
            'payload', jsonb_strip_nulls(jsonb_build_object(
              'shipment_id', v_shipment_id,
              'tracking_number', v_shipment.tracking_number,
              'tracking_link', v_tracking_link
            ))
          )),
          GREATEST(COALESCE(v_priority, 80), 0),
          GREATEST(COALESCE(v_max_retries, 3), 0),
          jsonb_strip_nulls(jsonb_build_object(
            'source', 'shipment_created_notification',
            'workflow_run_id', p_run.id,
            'workflow_run_step_id', p_step.id,
            'settings_resolution_id', v_settings_resolution_id
          )),
          v_corr,
          v_shipment_id
        )
        RETURNING id INTO v_outbound_id;

        v_decision_outcome := 'queued';
        v_decision_reason := 'shipment_created_notification_enqueued';
      EXCEPTION
        WHEN others THEN
          v_decision_outcome := 'failed';
          v_decision_reason := SQLERRM;
      END;
    END IF;
  END IF;

  BEGIN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'outbound_call',
      p_resource_type := 'shipment',
      p_resource_id := v_shipment_id,
      p_decision_point := 'shipment_created_notification',
      p_decision_outcome := v_decision_outcome,
      p_performed_by_system := 'workflow_handlers.execute_shipment_created_notification_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_shipment_id,
        'tracking_number', v_shipment.tracking_number,
        'tracking_link', v_tracking_link,
        'recipient_id', v_recipient_id,
        'channel', 'sms',
        'outbound_call_id', v_outbound_id,
        'settings_resolution_id', v_settings_resolution_id
      )),
      p_decision_reason := v_decision_reason,
      p_settings_resolution_id := v_settings_resolution_id
    );
  EXCEPTION
    WHEN others THEN
      NULL;
  END;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'queued', v_decision_outcome = 'queued',
    'channel', 'sms',
    'outbound_call_id', v_outbound_id,
    'tracking_number', v_shipment.tracking_number,
    'tracking_link', v_tracking_link,
    'recipient_id', v_recipient_id,
    'reason', CASE WHEN v_decision_outcome = 'queued' THEN NULL ELSE v_decision_reason END
  ));
  v_response.context_patch := jsonb_build_object('shipment_created_notification', v_response.operation_result);
  RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_created_notification_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Shipment-created SMS notification step that resolves policy rows, renders the tracking link message, and queues outbound comms.';

REVOKE ALL ON FUNCTION workflow_handlers.execute_shipment_created_notification_v1(public.workflow_run_steps, public.workflow_runs, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_shipment_created_notification_v1(public.workflow_run_steps, public.workflow_runs, JSONB) TO service_role;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'shipment_created_notification',
  'workflow_handlers',
  'execute_shipment_created_notification_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Shipment-created tracking-link SMS notification step.',
  'docs/ops/runbooks/communications-hardening.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

DO $$
DECLARE
  v_template_id UUID;
  v_step_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'shipment_manual_create_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'shipment_manual_create_v1 template not found';
  END IF;

  SELECT id
    INTO v_step_id
    FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'shipment_created_notification'
   LIMIT 1;

  IF v_step_id IS NULL THEN
    INSERT INTO public.workflow_template_steps (
      id,
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      metadata,
      handler_key,
      handler_version,
      enabled,
      created_at,
      updated_at
    )
    VALUES (
      gen_random_uuid(),
      v_template_id,
      2,
      'send_shipment_created_notification',
      'shipment_created_notification_policy',
      'always',
      jsonb_build_object(
        'context_key', 'shipment_created_notification',
        'notification_path', '$.context.workflow.context_patch.shipment_created_notification'
      ),
      'shipment_created_notification',
      'v1',
      TRUE,
      now(),
      now()
    );
  ELSE
    UPDATE public.workflow_template_steps
       SET sequence_order = 2,
           operation_name = 'send_shipment_created_notification',
           operation_settings_category = 'shipment_created_notification_policy',
           transition_condition = 'always',
           metadata = jsonb_build_object(
             'context_key', 'shipment_created_notification',
             'notification_path', '$.context.workflow.context_patch.shipment_created_notification'
           ),
           handler_key = 'shipment_created_notification',
           handler_version = 'v1',
           enabled = TRUE,
           updated_at = now()
     WHERE id = v_step_id;
  END IF;
END;
$$;

WITH recalculated AS (
  SELECT
    workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          sequence_order,
          COALESCE(operation_name, ''),
          COALESCE(operation_settings_category, ''),
          COALESCE(transition_condition, ''),
          COALESCE(handler_key, ''),
          COALESCE(handler_version, ''),
          COALESCE(metadata::text, '')
        ),
        '||' ORDER BY sequence_order
      )
    ) AS checksum
  FROM public.workflow_template_steps
  WHERE workflow_template_id = (
    SELECT id FROM public.workflow_templates WHERE name = 'shipment_manual_create_v1' LIMIT 1
  )
  GROUP BY workflow_template_id
)
UPDATE public.workflow_templates wt
   SET steps_checksum = recalculated.checksum,
       updated_at = now()
  FROM recalculated
 WHERE wt.id = recalculated.workflow_template_id;

SELECT pg_advisory_unlock(hashtext('202604101385_b09_uc131_shipment_created_tracking_link_notification_v1'));
COMMIT;

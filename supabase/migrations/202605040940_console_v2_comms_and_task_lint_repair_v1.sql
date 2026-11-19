-- Repair Console V2 comms enqueue and task completion lint failures.
--
-- This migration is append-only. It replaces invalid current function bodies
-- without rewriting their original migrations.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605040940_console_v2_comms_and_task_lint_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.run_task_completion_effects_v1(
  p_task_id UUID,
  p_task_event_id UUID,
  p_actor_system TEXT DEFAULT 'dispatch_exception_resolution',
  p_context_overrides JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_task public.tasks%ROWTYPE;
  v_task_event public.task_events%ROWTYPE;
  v_task_type_key TEXT := NULL;
  v_template_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_step RECORD;
  v_step_error TEXT := NULL;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 requires service_role context'
      USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR p_task_event_id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 requires task_id and task_event_id';
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   LIMIT 1;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task % not found', p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_task_event
    FROM public.task_events te
   WHERE te.id = p_task_event_id
     AND te.task_id = p_task_id
   LIMIT 1;

  IF v_task_event.id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_event % not found for task %', p_task_event_id, p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_type missing for task %', p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = 'task_completion_effects_v1'
     AND wt.status = 'active'
   ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_completion_effects_v1 template missing'
      USING ERRCODE = '23503';
  END IF;

  v_workflow_run_id := public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_task.organization_id,
        'client_id', v_task.client_id,
        'sender_id', v_task.sender_id,
        'resource_type', COALESCE(NULLIF(btrim(COALESCE(v_task.resource_type, '')), ''), 'task'),
        'resource_id', COALESCE(v_task.resource_id, v_task.id),
        'payload', jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_task.organization_id,
          'client_id', v_task.client_id,
          'sender_id', v_task.sender_id,
          'resource_type', v_task.resource_type,
          'resource_id', v_task.resource_id,
          'task_id', v_task.id,
          'task_event_id', v_task_event.id,
          'task_type_key', lower(v_task_type_key),
          'task_event_payload', COALESCE(v_task_event.payload, '{}'::jsonb),
          'task_event_created_at', v_task_event.created_at,
          'actor_user_id', v_task_event.actor_user_id,
          'actor_system', COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'dispatch_exception_resolution')
        ))
      ) || COALESCE(p_context_overrides, '{}'::jsonb)
    )
  );

  v_progress := public.progress_workflow_run(v_workflow_run_id);

  SELECT
    wr.workflow_status,
    wr.last_error,
    wts.operation_result,
    wts.last_error AS step_last_error
  INTO v_step
  FROM public.workflow_runs wr
  LEFT JOIN public.workflow_run_steps wts
    ON wts.workflow_run_id = wr.id
  WHERE wr.id = v_workflow_run_id
  ORDER BY wts.sequence_order DESC NULLS LAST
  LIMIT 1;

  IF COALESCE(v_step.workflow_status, '') IN ('failed', 'blocked', 'cancelled') THEN
    v_step_error := COALESCE(
      NULLIF(
        v_step.step_last_error::text,
        ''
      ),
      NULLIF(v_step.last_error::text, ''),
      'workflow_failed'
    );

    RAISE EXCEPTION 'run_task_completion_effects_v1 failed for task %: %',
      p_task_id,
      v_step_error;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', v_workflow_run_id,
    'workflow_status', v_step.workflow_status,
    'progress_status', v_progress->>'status',
    'operation_result', v_step.operation_result
  ));
END;
$function$;

COMMENT ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB)
  IS 'Service-only helper that starts the canonical task_completion_effects_v1 workflow for a specific completed task event and returns the terminal step result.';

REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_comms_attempt_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_user_org_id UUID := public.current_user_org_id();
  v_shipment_id UUID := NULL;
  v_shipment public.shipments%ROWTYPE;
  v_channel TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'channel', '')), ''));
  v_call_type TEXT := NULL;
  v_template_id UUID := NULL;
  v_template_key TEXT := NULL;
  v_template public.message_templates%ROWTYPE;
  v_message_text TEXT := NULL;
  v_recipient public.recipients%ROWTYPE;
  v_recipient_override JSONB := COALESCE(v_args->'recipient_override', '{}'::jsonb);
  v_correlation_id UUID := gen_random_uuid();
  v_policy JSONB := '{}'::jsonb;
  v_allowed_channels JSONB := '[]'::jsonb;
  v_allow_operator BOOLEAN := FALSE;
  v_settings_resolution_id UUID := NULL;
  v_provider_id UUID := NULL;
  v_operation public.operation_templates%ROWTYPE;
  v_headers JSONB := '{}'::jsonb;
  v_body JSONB := '{}'::jsonb;
  v_render_context JSONB := '{}'::jsonb;
  v_outbound_call_id UUID := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('comms', 'write') THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 requires comms.write capability'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_shipment_id := NULLIF(v_args->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_template_id := NULLIF(v_args->>'template_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;

  v_template_key := NULLIF(btrim(COALESCE(v_args->>'template_key', '')), '');
  v_message_text := NULLIF(COALESCE(v_args->>'message_text', ''), '');

  IF v_shipment_id IS NULL OR v_channel IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'invalid_request')
    );
  END IF;

  SELECT *
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = v_shipment_id
     AND (
       public.is_platform_user()
       OR (
         v_scope_type = 'tenant'
         AND s.organization_id = v_user_org_id
       )
       OR (
         v_scope_type = 'client'
         AND s.client_id = v_scope_id
       )
       OR (
         v_scope_type = 'sender'
         AND s.sender_id = v_scope_id
       )
     )
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 forbidden or shipment not found: %', v_shipment_id
      USING ERRCODE = '42501';
  END IF;

  SELECT r.*
    INTO v_recipient
    FROM public.recipients r
   WHERE r.id = v_shipment.recipient_id
   LIMIT 1;

  SELECT rp.value, rp.settings_version_id
    INTO v_policy, v_settings_resolution_id
    FROM public.resolve_communication_policy(
      jsonb_build_object(
        'organization_id', v_shipment.organization_id,
        'client_id', v_shipment.client_id,
        'sender_id', v_shipment.sender_id,
        'shipment_id', v_shipment.id
      )
    ) AS rp
   LIMIT 1;

  v_policy := COALESCE(v_policy, '{}'::jsonb);
  v_allowed_channels := COALESCE(v_policy->'allowed_channels', '[]'::jsonb);

  BEGIN
    v_allow_operator := COALESCE(NULLIF(v_policy->>'allow_operator_initiated_send', '')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_allow_operator := FALSE;
  END;

  IF v_allow_operator IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'comms_operator_initiated_disabled',
        'policy_key', 'communication_policy.allow_operator_initiated_send'
      ),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  IF jsonb_typeof(v_allowed_channels) <> 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(v_allowed_channels) AS ch(value)
       WHERE lower(ch.value) = v_channel
     ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'comms_channel_not_allowed',
        'channel', v_channel,
        'allowed_channels', v_allowed_channels
      ),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  v_call_type := CASE v_channel
    WHEN 'sms' THEN 'comms_sms'
    WHEN 'whatsapp' THEN 'comms_whatsapp'
    WHEN 'email' THEN 'comms_email'
    WHEN 'voice' THEN 'comms_voice'
    WHEN 'call' THEN 'comms_voice'
    ELSE NULL
  END;

  IF v_call_type IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_channel_not_supported', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  BEGIN
    v_provider_id := NULLIF(v_args->>'provider_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_provider_id := NULL;
  END;

  IF v_provider_id IS NULL THEN
    BEGIN
      v_provider_id := NULLIF(v_policy #>> ARRAY['operator_initiated', v_channel, 'provider_id'], '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_provider_id := NULL;
    END;
  END IF;

  IF v_provider_id IS NULL THEN
    SELECT p.id
      INTO v_provider_id
      FROM public.providers p
      JOIN public.operation_templates ot
        ON ot.provider_id = p.id
     WHERE p.organization_id = v_shipment.organization_id
       AND p.provider_type = 'comms'
       AND p.enabled IS TRUE
       AND ot.call_type = v_call_type
     ORDER BY p.priority_rank DESC, p.updated_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  IF v_provider_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_provider_missing', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  SELECT ot.*
    INTO v_operation
    FROM public.operation_templates ot
   WHERE ot.provider_id = v_provider_id
     AND ot.call_type = v_call_type
   ORDER BY ot.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_operation.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_operation_template_missing', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  IF v_template_id IS NULL AND v_template_key IS NULL THEN
    SELECT item.value
      INTO v_template_key
      FROM jsonb_array_elements_text(COALESCE(v_policy->'templates', '[]'::jsonb)) AS item(value)
     LIMIT 1;
  END IF;

  SELECT mt.*
    INTO v_template
    FROM public.message_templates mt
   WHERE mt.organization_id = v_shipment.organization_id
     AND mt.archived IS DISTINCT FROM TRUE
     AND (
       (v_template_id IS NOT NULL AND mt.id = v_template_id)
       OR (
         v_template_id IS NULL
         AND v_template_key IS NOT NULL
         AND mt.template_name = v_template_key
       )
     )
   ORDER BY mt.updated_at DESC NULLS LAST
   LIMIT 1;

  v_render_context := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_shipment.id,
    'tracking_number', v_shipment.tracking_number,
    'client_reference_number', v_shipment.client_reference_number,
    'carrier_reference_number', v_shipment.carrier_reference_number,
    'recipient_name', v_recipient.name,
    'recipient_phone', COALESCE(v_recipient_override->>'phone_number', v_recipient.phone_number),
    'channel', v_channel
  ));

  IF v_message_text IS NULL AND v_template.id IS NOT NULL THEN
    v_template_id := v_template.id;
    v_message_text := trim(both '"' FROM public.render_template(to_jsonb(v_template.body_template), v_render_context)::text);
  END IF;

  IF v_message_text IS NULL OR btrim(v_message_text) = '' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_template_missing', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  v_render_context := jsonb_strip_nulls(v_render_context || jsonb_build_object(
    'message_text', v_message_text,
    'template_id', v_template_id
  ));

  IF v_operation.headers_template IS NOT NULL THEN
    v_headers := COALESCE(public.render_template(v_operation.headers_template, v_render_context), '{}'::jsonb);
  END IF;

  IF v_operation.body_template IS NOT NULL THEN
    v_body := COALESCE(public.render_template(v_operation.body_template, v_render_context), '{}'::jsonb);
  ELSE
    v_body := jsonb_strip_nulls(jsonb_build_object(
      'message_text', v_message_text,
      'template_id', v_template_id,
      'recipient', jsonb_strip_nulls(jsonb_build_object(
        'id', v_recipient.id,
        'phone_number', COALESCE(v_recipient_override->>'phone_number', v_recipient.phone_number),
        'email', COALESCE(v_recipient_override->>'email', v_recipient.email)
      ))
    ));
  END IF;

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
    correlation_id,
    shipment_id,
    context
  )
  VALUES (
    v_call_type,
    'provider',
    v_provider_id,
    v_operation.method,
    v_operation.url_template,
    COALESCE(v_headers, '{}'::jsonb),
    COALESCE(v_body, '{}'::jsonb),
    100,
    3,
    v_correlation_id,
    v_shipment.id,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'console.shipments_drawer.send_now',
      'requested_by_user_id', v_user_id,
      'recipient_id', v_recipient.id,
      'client_id', v_shipment.client_id,
      'sender_id', v_shipment.sender_id,
      'channel', v_channel,
      'template_id', v_template_id,
      'operation_template_id', v_operation.id,
      'settings_resolution_id', v_settings_resolution_id
    ))
  )
  RETURNING id INTO v_outbound_call_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'comms_attempt_id', v_outbound_call_id,
    'outbound_call_id', v_outbound_call_id,
    'shipment_id', v_shipment.id,
    'channel', v_channel,
    'template_id', v_template_id,
    'status', 'queued',
    'correlation_id', v_correlation_id::text,
    'settings_resolution_id', v_settings_resolution_id
  );
END;
$function$;

COMMENT ON FUNCTION public.enqueue_comms_attempt_v1(JSONB)
  IS 'W13-5 operator-initiated comms enqueue for Console V2. Policy-gated by communication_policy.allow_operator_initiated_send and row-driven provider/template configuration; writes queued work to outbound_calls.';

REVOKE ALL ON FUNCTION public.enqueue_comms_attempt_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_comms_attempt_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_comms_attempt_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_comms_attempt_v1(JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.enqueue_comms_attempt_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.enqueue_comms_attempt_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605040940_console_v2_comms_and_task_lint_repair_v1'));
COMMIT;

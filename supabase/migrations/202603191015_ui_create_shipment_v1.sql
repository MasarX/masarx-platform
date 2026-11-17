-- Migration: UI shipment manual-create workflow contract
-- Purpose:
--   - Provide an authenticated UI-facing shipment-create RPC for Console and Portal.
--   - Route manual create through a dedicated reserve/create workflow so it emits the
--     same workflow, decision-log, and audit correlation evidence as ingress create.
--   - Preserve duplicate detection in workflow_handlers.execute_shipment_create_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191015_ui_create_shipment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_template_id UUID;
  v_reserve_step_id UUID;
  v_create_step_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'shipment_manual_create_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    INSERT INTO public.workflow_templates (
      name,
      description,
      version,
      status,
      scope_type,
      scope_id,
      notes,
      published_at
    )
    VALUES (
      'shipment_manual_create_v1',
      'Manual shipment creation workflow for authenticated Console and Portal users.',
      1,
      'active',
      'global',
      NULL,
      'Authoritative UI shipment-create workflow (reserve identifiers + create shipment).',
      now()
    )
    RETURNING id INTO v_template_id;
  ELSE
    UPDATE public.workflow_templates
       SET description = 'Manual shipment creation workflow for authenticated Console and Portal users.',
           status = 'active',
           scope_type = 'global',
           scope_id = NULL,
           notes = 'Authoritative UI shipment-create workflow (reserve identifiers + create shipment).',
           published_at = COALESCE(published_at, now()),
           updated_at = now()
     WHERE id = v_template_id;
  END IF;

  SELECT id
    INTO v_reserve_step_id
    FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'reserve_shipment_identifiers'
   ORDER BY sequence_order
   LIMIT 1;

  IF v_reserve_step_id IS NULL THEN
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
      0,
      'reserve_identifiers',
      'workflow',
      'always',
      jsonb_build_object(
        'resource_type', 'shipment'
      ),
      'reserve_shipment_identifiers',
      'v1',
      TRUE,
      now(),
      now()
    );
  ELSE
    UPDATE public.workflow_template_steps
       SET sequence_order = 0,
           operation_name = 'reserve_identifiers',
           operation_settings_category = 'workflow',
           transition_condition = 'always',
           metadata = jsonb_build_object('resource_type', 'shipment'),
           handler_key = 'reserve_shipment_identifiers',
           handler_version = 'v1',
           enabled = TRUE,
           updated_at = now()
     WHERE id = v_reserve_step_id;
  END IF;

  SELECT id
    INTO v_create_step_id
    FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'shipment_create'
   ORDER BY sequence_order
   LIMIT 1;

  IF v_create_step_id IS NULL THEN
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
      1,
      'create_shipment',
      'workflow',
      'always',
      '{}'::jsonb,
      'shipment_create',
      'v1',
      TRUE,
      now(),
      now()
    );
  ELSE
    UPDATE public.workflow_template_steps
       SET sequence_order = 1,
           operation_name = 'create_shipment',
           operation_settings_category = 'workflow',
           transition_condition = 'always',
           metadata = '{}'::jsonb,
           handler_key = 'shipment_create',
           handler_version = 'v1',
           enabled = TRUE,
           updated_at = now()
     WHERE id = v_create_step_id;
  END IF;
END;
$$;

WITH recalculated AS (
  SELECT
    wts.workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          wts.sequence_order,
          COALESCE(wts.operation_name, ''),
          COALESCE(wts.operation_settings_category, ''),
          COALESCE(wts.transition_condition, ''),
          COALESCE(wts.handler_key, ''),
          COALESCE(wts.handler_version, ''),
          COALESCE(wts.metadata::TEXT, '')
        ),
        '||' ORDER BY wts.sequence_order
      )
    ) AS checksum
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id = (
    SELECT id FROM public.workflow_templates WHERE name = 'shipment_manual_create_v1' LIMIT 1
  )
  GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
   SET steps_checksum = recalculated.checksum,
       updated_at = now()
  FROM recalculated
 WHERE wt.id = recalculated.workflow_template_id;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_create_v1(
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
    v_ctx_patch JSONB := COALESCE(v_ctx->'workflow'->'context_patch', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
    v_resource JSONB := COALESCE(v_payload->'resource', '{}'::jsonb);

    v_org UUID := COALESCE(
        NULLIF(v_ctx->>'organization_id', '')::UUID,
        NULLIF(v_ctx_patch->>'organization_id', '')::UUID
    );
    v_client UUID := COALESCE(
        NULLIF(v_ctx->>'client_id', '')::UUID,
        NULLIF(v_ctx_patch->>'client_id', '')::UUID
    );
    v_sender UUID := COALESCE(
        NULLIF(v_ctx->>'sender_id', '')::UUID,
        NULLIF(v_ctx_patch->>'sender_id', '')::UUID
    );
    v_planned_id UUID := COALESCE(
        NULLIF(v_ctx->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx->>'planned_resource_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_resource_id', '')::UUID,
        NULLIF((v_ctx->'shipment'->>'id'), '')::UUID,
        NULLIF((v_ctx_patch->'shipment'->>'id'), '')::UUID
    );
    v_planned_tracking TEXT := COALESCE(
        NULLIF(v_ctx->>'planned_tracking_number', ''),
        NULLIF(v_ctx_patch->>'planned_tracking_number', ''),
        NULLIF((v_ctx->'shipment'->>'tracking_number'), ''),
        NULLIF((v_ctx_patch->'shipment'->>'tracking_number'), '')
    );
    v_service_type TEXT := COALESCE(NULLIF(v_ctx->>'service_type', ''), 'delivery');
    v_status TEXT := COALESCE(NULLIF(v_ctx->>'initial_status', ''), 'pending');
    v_metadata_source UUID := COALESCE(
        NULLIF(v_ctx->>'webhook_id', '')::UUID,
        NULLIF(v_ctx_patch->>'webhook_id', '')::UUID
    );
    v_requested_by UUID := COALESCE(
        NULLIF(v_ctx->>'requested_by', '')::UUID,
        NULLIF(v_ctx_patch->>'requested_by', '')::UUID
    );

    v_client_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'client_reference_number', ''),
        NULLIF(v_ctx_patch->>'client_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_resource->>'client_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,client_reference_number}', '')
    );
    v_carrier_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'carrier_reference_number', ''),
        NULLIF(v_ctx_patch->>'carrier_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_resource->>'carrier_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,carrier_reference_number}', '')
    );

    v_logistics_refs JSONB;
    v_reference_map JSONB := '{}'::jsonb;
    v_refs JSONB := '{}'::jsonb;
    v_ref_meta JSONB;
    v_input_metadata JSONB := '{}'::jsonb;

    v_correlation_id UUID;
    v_row_id UUID;
    v_tracking_number TEXT;
    v_operation TEXT := 'inserted';
    v_result public.workflow_handler_response;
BEGIN
    BEGIN
      v_correlation_id := NULLIF(v_ctx->>'correlation_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_correlation_id := NULL;
    END;
    IF v_correlation_id IS NULL THEN
      BEGIN
        v_correlation_id := NULLIF(v_ctx_patch->>'correlation_id', '')::UUID;
      EXCEPTION
        WHEN others THEN
          v_correlation_id := NULL;
      END;
    END IF;

    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN
        RAISE EXCEPTION 'execute_shipment_create_v1: missing required context (org %, client %, tracking %)',
            v_org, v_client, v_planned_tracking;
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    IF jsonb_typeof(v_resource->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_resource->'references';
    END IF;
    IF jsonb_typeof(v_ctx->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx->'references';
    END IF;
    IF jsonb_typeof(v_ctx_patch->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx_patch->'references';
    END IF;
    IF jsonb_typeof(v_resource->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_resource->'metadata';
    END IF;
    IF jsonb_typeof(v_ctx->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_ctx->'metadata';
    END IF;
    IF jsonb_typeof(v_ctx_patch->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_ctx_patch->'metadata';
    END IF;

    v_logistics_refs := NULL;
    IF jsonb_typeof(v_resource->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_resource->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_resource->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_resource->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_number';
    END IF;

    v_refs := jsonb_strip_nulls(
      v_reference_map || jsonb_build_object(
        'client_reference_number', NULLIF(btrim(v_client_reference), ''),
        'carrier_reference_number', NULLIF(btrim(v_carrier_reference), '')
      )
    );
    IF v_logistics_refs IS NOT NULL THEN
      v_refs := jsonb_strip_nulls(v_refs || jsonb_build_object('logistics_reference_number', v_logistics_refs));
    END IF;

    SELECT resolved.shipment_id, resolved.tracking_number, resolved.operation
      INTO v_row_id, v_tracking_number, v_operation
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client,
        v_planned_tracking,
        v_client_reference
      ) AS resolved
     LIMIT 1;

    IF v_row_id IS NULL THEN
      BEGIN
        INSERT INTO public.shipments (
            id,
            organization_id,
            client_id,
            sender_id,
            service_type,
            tracking_number,
            carrier_reference_number,
            client_reference_number,
            status,
            box_count,
            metadata
        )
        VALUES (
            v_planned_id,
            v_org,
            v_client,
            v_sender,
            v_service_type,
            v_planned_tracking,
            NULLIF(btrim(v_carrier_reference), ''),
            NULLIF(btrim(v_client_reference), ''),
            v_status,
            1,
            jsonb_strip_nulls(
              v_input_metadata ||
              jsonb_build_object(
                'created_by', 'workflow',
                'workflow_run_id', p_run.id,
                'source_webhook_id', v_metadata_source,
                'requested_by', v_requested_by,
                'correlation_id', v_correlation_id
              )
            )
        );
      EXCEPTION
        WHEN unique_violation THEN
          SELECT resolved.shipment_id, resolved.tracking_number, resolved.operation
            INTO v_row_id, v_tracking_number, v_operation
            FROM public.resolve_shipment_create_duplicate_v1(
              v_client,
              v_planned_tracking,
              v_client_reference
            ) AS resolved
           LIMIT 1;

          IF v_row_id IS NULL THEN
            RAISE;
          END IF;
      END;

      IF v_row_id IS NULL THEN
        v_row_id := v_planned_id;
        v_tracking_number := v_planned_tracking;
      END IF;
    END IF;

    IF v_operation = 'reused' THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'shipment_create',
        p_resource_type := 'shipment',
        p_resource_id := v_row_id,
        p_decision_point := 'tracking_unique',
        p_decision_outcome := 'reused_existing_shipment',
        p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'planned_shipment_id', v_planned_id,
          'planned_tracking_number', v_planned_tracking,
          'client_reference_number', NULLIF(btrim(v_client_reference), '')
        )),
        p_decision_reason := 'tracking_number already exists for this client',
        p_settings_resolution_id := NULL
      );
    ELSIF v_operation = 'reused_client_reference' THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'shipment_create',
        p_resource_type := 'shipment',
        p_resource_id := v_row_id,
        p_decision_point := 'client_reference_unique',
        p_decision_outcome := 'reused_existing_shipment',
        p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'planned_shipment_id', v_planned_id,
          'planned_tracking_number', v_planned_tracking,
          'client_reference_number', NULLIF(btrim(v_client_reference), ''),
          'existing_tracking_number', v_tracking_number
        )),
        p_decision_reason := 'client_reference_number already exists for this client',
        p_settings_resolution_id := NULL
      );
    END IF;

    UPDATE public.shipments
       SET client_reference_number = COALESCE(NULLIF(btrim(public.shipments.client_reference_number), ''), NULLIF(btrim(v_client_reference), ''), public.shipments.client_reference_number),
           carrier_reference_number = COALESCE(NULLIF(btrim(public.shipments.carrier_reference_number), ''), NULLIF(btrim(v_carrier_reference), ''), public.shipments.carrier_reference_number),
           updated_at = now()
     WHERE id = v_row_id
       AND client_id = v_client
       AND (
         ((public.shipments.client_reference_number IS NULL OR btrim(public.shipments.client_reference_number) = '') AND NULLIF(btrim(v_client_reference), '') IS NOT NULL)
         OR ((public.shipments.carrier_reference_number IS NULL OR btrim(public.shipments.carrier_reference_number) = '') AND NULLIF(btrim(v_carrier_reference), '') IS NOT NULL)
       );

    IF v_row_id IS NOT NULL AND v_refs IS NOT NULL AND v_refs <> '{}'::jsonb THEN
      v_ref_meta := jsonb_strip_nulls(jsonb_build_object(
        'source', 'workflow',
        'workflow_run_id', p_run.id,
        'workflow_run_step_id', p_step.id,
        'webhook_id', v_metadata_source,
        'requested_by', v_requested_by,
        'correlation_id', v_correlation_id
      ));

      PERFORM public.upsert_shipment_reference_numbers_v1(
        p_organization_id := v_org,
        p_client_id := v_client,
        p_shipment_id := v_row_id,
        p_reference_map := v_refs,
        p_source_type := 'workflow',
        p_source_id := NULL,
        p_metadata := v_ref_meta
      );
    END IF;

    v_result.status := 'completed';
    v_result.workflow_status := CASE
      WHEN v_operation IN ('reused', 'reused_client_reference')
           AND v_planned_id IS NOT NULL
           AND v_row_id <> v_planned_id THEN 'completed'
      ELSE NULL
    END;
    v_result.next_run_at := NULL;
    v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_row_id,
        'tracking_number', v_tracking_number,
        'operation', v_operation
    ));
    v_result.context_patch := jsonb_build_object(
        'shipment', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row_id,
            'tracking_number', v_tracking_number,
            'client_reference_number', NULLIF(btrim(v_client_reference), '')
        ))
    );
    v_result.last_error := NULL;
    v_result.retry_attempt := 1;
    v_result.max_retries := 1;

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Create shipments row from planned id/tracking in workflow context; idempotent by approved duplicate keys and enriched with correlation/request metadata.';

CREATE OR REPLACE FUNCTION public.ui_create_shipment_v1(
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_service_type TEXT DEFAULT NULL,
  p_tracking_number TEXT DEFAULT NULL,
  p_client_reference_number TEXT DEFAULT NULL,
  p_carrier_reference_number TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_template_id UUID;
  v_client_id UUID := p_client_id;
  v_sender_id UUID := p_sender_id;
  v_sender_client_id UUID;
  v_sender_org_id UUID;
  v_service_type TEXT := COALESCE(NULLIF(btrim(COALESCE(p_service_type, '')), ''), 'delivery');
  v_status TEXT := COALESCE(NULLIF(btrim(COALESCE(p_status, '')), ''), 'pending');
  v_tracking_number TEXT := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_client_reference_number TEXT := NULLIF(btrim(COALESCE(p_client_reference_number, '')), '');
  v_carrier_reference_number TEXT := NULLIF(btrim(COALESCE(p_carrier_reference_number, '')), '');
  v_metadata JSONB := CASE
    WHEN jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) = 'object' THEN COALESCE(p_metadata, '{}'::jsonb)
    ELSE '{}'::jsonb
  END;
  v_correlation_id UUID := gen_random_uuid();
  v_run_id UUID;
  v_context JSONB;
  v_run_context JSONB := '{}'::jsonb;
  v_progress JSONB;
  v_create_result JSONB := '{}'::jsonb;
  v_shipment_id UUID;
  v_attempt INT;
  v_workflow_status TEXT;
  v_operation TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires authenticated user';
  END IF;

  PERFORM public.assert_capability_v1('shipments.write', v_scope_type, v_scope_id);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires organization context';
  END IF;

  IF v_scope_type = 'client' AND v_scope_id IS NOT NULL THEN
    IF v_client_id IS NOT NULL AND v_client_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 client scope cannot create for another client';
    END IF;
    v_client_id := v_scope_id;
  END IF;

  IF v_scope_type = 'sender' AND v_scope_id IS NOT NULL THEN
    IF v_sender_id IS NOT NULL AND v_sender_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender scope cannot create for another sender';
    END IF;
    v_sender_id := v_scope_id;
  END IF;

  IF v_sender_id IS NOT NULL THEN
    SELECT s.client_id, c.organization_id
      INTO v_sender_client_id, v_sender_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_sender_id
     LIMIT 1;

    IF v_sender_client_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender not found';
    END IF;
    IF v_sender_org_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender is outside the current organization';
    END IF;
    IF v_client_id IS NULL THEN
      v_client_id := v_sender_client_id;
    ELSIF v_client_id <> v_sender_client_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender must belong to the selected client';
    END IF;
  END IF;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires client_id';
  END IF;

  PERFORM 1
    FROM public.clients c
   WHERE c.id = v_client_id
     AND c.organization_id = v_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 client is outside the current organization';
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'shipment_manual_create_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 workflow template shipment_manual_create_v1 not found';
  END IF;

  PERFORM set_config('request.correlation_id', v_correlation_id::text, true);

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'trigger_source', 'manual',
      'correlation_id', v_correlation_id,
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'requested_by', auth.uid(),
      'service_type', v_service_type,
      'initial_status', v_status,
      'planned_tracking_number', v_tracking_number,
      'client_reference_number', v_client_reference_number,
      'carrier_reference_number', v_carrier_reference_number,
      'payload', jsonb_build_object(
        'resource', jsonb_strip_nulls(
          jsonb_build_object(
            'type', 'shipment',
            'service_type', v_service_type,
            'tracking_number', v_tracking_number,
            'client_reference_number', v_client_reference_number,
            'carrier_reference_number', v_carrier_reference_number,
            'status', v_status,
            'metadata', jsonb_strip_nulls(
              v_metadata
              || jsonb_build_object(
                'source', 'ui.manual_create',
                'requested_by', auth.uid(),
                'correlation_id', v_correlation_id
              )
            )
          )
        )
      ),
      'ui', jsonb_build_object(
        'source', 'shipment_manual_create',
        'workflow_template_id', v_template_id
      )
    )
  );

  v_run_id := public.start_workflow_run(v_template_id, v_context);

  UPDATE public.workflow_runs
     SET triggered_by_request_id = COALESCE(triggered_by_request_id, v_correlation_id),
         updated_at = now()
   WHERE id = v_run_id;

  FOR v_attempt IN 1..6 LOOP
    SELECT public.progress_workflow_run(v_run_id) INTO v_progress;

    SELECT workflow_status, context
      INTO v_workflow_status, v_run_context
      FROM public.workflow_runs
     WHERE id = v_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'waiting', 'blocked');
  END LOOP;

  SELECT step.operation_result
    INTO v_create_result
    FROM public.workflow_run_steps step
   WHERE step.workflow_run_id = v_run_id
     AND step.handler_key = 'shipment_create'
   ORDER BY step.sequence_order
   LIMIT 1;

  BEGIN
    v_shipment_id := COALESCE(
      NULLIF(v_run_context#>>'{shipment,id}', '')::UUID,
      NULLIF(v_run_context#>>'{workflow,context_patch,shipment,id}', '')::UUID,
      NULLIF(v_create_result->>'shipment_id', '')::UUID,
      NULLIF(v_run_context->>'planned_shipment_id', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL AND v_client_id IS NOT NULL THEN
    SELECT resolved.shipment_id, resolved.operation
      INTO v_shipment_id, v_operation
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client_id,
        COALESCE(NULLIF(v_run_context#>>'{shipment,tracking_number}', ''), v_tracking_number),
        v_client_reference_number
      ) AS resolved
     LIMIT 1;
  END IF;

  v_operation := COALESCE(
    v_create_result->>'operation',
    v_operation,
    CASE WHEN v_shipment_id IS NOT NULL THEN 'inserted' ELSE NULL END
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status', CASE
        WHEN v_workflow_status = 'completed' AND v_shipment_id IS NOT NULL THEN 'shipment_created'
        ELSE COALESCE(v_workflow_status, 'workflow_started')
      END,
      'workflow_template_id', v_template_id,
      'workflow_run_id', v_run_id,
      'workflow_status', v_workflow_status,
      'correlation_id', v_correlation_id,
      'shipment_id', v_shipment_id,
      'tracking_number', COALESCE(
        NULLIF(v_run_context#>>'{shipment,tracking_number}', ''),
        NULLIF(v_create_result->>'tracking_number', ''),
        v_tracking_number
      ),
      'operation', v_operation
    )
  );
END;
$$;

COMMENT ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  IS 'Authenticated UI shipment-create RPC that resolves scope, starts shipment_manual_create_v1, stamps correlation evidence, and returns shipment/workflow metadata.';

REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603191015_ui_create_shipment_v1'));
COMMIT;

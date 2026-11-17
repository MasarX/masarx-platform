-- Migration: Shipment create handler (Option B)
-- Purpose: Insert shipments row using planned id + tracking from workflow context

BEGIN;

SET search_path TO public, workflow_handlers, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_create_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_org UUID := NULLIF(v_ctx->>'organization_id','')::UUID;
    v_client UUID := NULLIF(v_ctx->>'client_id','')::UUID;
    v_sender UUID := NULLIF(v_ctx->>'sender_id','')::UUID;
    v_planned_id UUID := NULLIF(v_ctx->>'planned_shipment_id','')::UUID;
    v_planned_tracking TEXT := NULLIF(v_ctx->>'planned_tracking_number','');
    v_service_type TEXT := COALESCE(NULLIF(v_ctx->>'service_type',''), 'delivery');
    v_status TEXT := COALESCE(NULLIF(v_ctx->>'initial_status',''), 'pending');
    v_row_id UUID;
    v_result public.workflow_handler_response;
    v_operation TEXT := 'inserted';
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', false);

    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN
        RAISE EXCEPTION 'execute_shipment_create_v1: missing required context (org, client, planned_tracking)';
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    INSERT INTO public.shipments (
        id, organization_id, client_id, sender_id, service_type,
        tracking_number, status, box_count, metadata
    ) VALUES (
        v_planned_id, v_org, v_client, v_sender, v_service_type,
        v_planned_tracking, v_status, 1,
        jsonb_strip_nulls(jsonb_build_object(
            'created_by', 'workflow',
            'workflow_run_id', p_run.id,
            'source_webhook_id', NULLIF(v_ctx->>'webhook_id','')::UUID
        ))
    )
    ON CONFLICT DO NOTHING;

    SELECT id INTO v_row_id
      FROM public.shipments
     WHERE client_id = v_client
       AND tracking_upper = upper(v_planned_tracking)
     LIMIT 1;

    IF v_row_id IS NULL THEN
        -- Unlikely but guard: if row not visible yet, use planned id
        v_row_id := v_planned_id;
    ELSE
        IF v_row_id <> v_planned_id THEN
            v_operation := 'reused';
        END IF;
    END IF;

    v_result.status := 'completed';
    v_result.workflow_status := NULL;
    v_result.next_run_at := NULL;
    v_result.operation_result := jsonb_build_object(
        'shipment_id', v_row_id,
        'tracking_number', v_planned_tracking,
        'operation', v_operation
    );
    v_result.context_patch := jsonb_build_object(
        'shipment', jsonb_build_object('id', v_row_id, 'tracking_number', v_planned_tracking)
    );
    v_result.last_error := NULL;
    v_result.retry_attempt := 1;
    v_result.max_retries := 1;

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Create shipments row from planned id/tracking in workflow context; idempotent by (client_id, tracking_upper).';

-- Register handler in operation_handlers
INSERT INTO operation_handlers AS oh (
    handler_key, handler_schema, handler_name, handler_signature, handler_version, is_active, notes, doc_url
)
VALUES (
    'shipment_create', 'workflow_handlers', 'execute_shipment_create_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE,
    'Insert shipments row from planned id + tracking.', 'docs/ops/runbooks/workflow_engine_runbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- Prepend handler as first step in async_provider_dispatch_v1 (sequence_order 0)
DO $$
DECLARE
  v_tpl UUID;
  v_step_id UUID := gen_random_uuid();
BEGIN
  SELECT id INTO v_tpl FROM workflow_templates WHERE name = 'async_provider_dispatch_v1' LIMIT 1;
  IF v_tpl IS NOT NULL THEN
    INSERT INTO workflow_template_steps (
      id, workflow_template_id, sequence_order,
      operation_name, operation_settings_category, transition_condition,
      handler_key, handler_version, metadata, manual_action_required, enabled
    ) VALUES (
      v_step_id, v_tpl, 0,
      'create_shipment', 'workflow', 'always',
      'shipment_create', 'v1', '{}'::jsonb, FALSE, TRUE
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

COMMIT;


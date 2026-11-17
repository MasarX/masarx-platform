-- Migration: shipment create handler context fallback
-- Purpose: allow execute_shipment_create_v1 to read planned identifiers from nested context patches

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
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_ctx_patch JSONB := COALESCE(v_ctx->'workflow'->'context_patch', '{}'::jsonb);
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
    v_row_id UUID;
    v_result public.workflow_handler_response;
    v_operation TEXT := 'inserted';
BEGIN
    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN
        RAISE EXCEPTION 'execute_shipment_create_v1: missing required context (org %, client %, tracking %)',
            v_org, v_client, v_planned_tracking;
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    INSERT INTO public.shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
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
        v_status,
        1,
        jsonb_strip_nulls(jsonb_build_object(
            'created_by', 'workflow',
            'workflow_run_id', p_run.id,
            'source_webhook_id', v_metadata_source
        ))
    )
    ON CONFLICT DO NOTHING;

    SELECT id
      INTO v_row_id
      FROM public.shipments
     WHERE client_id = v_client
       AND tracking_upper = upper(v_planned_tracking)
     LIMIT 1;

    IF v_row_id IS NULL THEN
        v_row_id := v_planned_id;
    ELSIF v_row_id <> v_planned_id THEN
        v_operation := 'reused';
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
        'shipment', jsonb_build_object(
            'id', v_row_id,
            'tracking_number', v_planned_tracking
        )
    );
    v_result.last_error := NULL;
    v_result.retry_attempt := 1;
    v_result.max_retries := 1;

    RETURN v_result;
END;
$function$;

COMMIT;

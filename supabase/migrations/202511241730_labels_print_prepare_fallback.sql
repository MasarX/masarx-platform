-- Migration: Labels print prepare fallback (derive ready directly from payload)
-- Purpose: Ensure prepare step populates ready labels without hardcoded waits

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_prepare_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response public.workflow_handler_response;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_policy JSONB := resolve_settings('label_print_policy', 'tenant', NULLIF(v_context->>'organization_id','')::uuid);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_shipments JSONB := COALESCE(v_payload->'shipments', '[]'::jsonb);
    v_ready JSONB := '[]'::jsonb;
    v_pending JSONB := '[]'::jsonb;
    v_counts JSONB := '{}'::jsonb;
    v_org_id UUID := NULLIF(v_context->>'organization_id','')::uuid;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_print_prepare_v1: organization_id not present in workflow context';
    END IF;

    -- Build ready set from existing labels for shipments in payload
    IF COALESCE(jsonb_array_length(v_shipments), 0) > 0 THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'shipment_id', l.shipment_id,
            'shipment_box_id', NULL,
            'box_number', NULL,
            'label_id', l.id,
            'file_url', l.file_url,
            'label_type', l.label_type,
            'generated_at', l.generated_at,
            'status', 'ready'
        )), '[]'::jsonb)
        INTO v_ready
        FROM labels l
        WHERE l.shipment_id = ANY (
            SELECT (ship->>'shipment_id')::uuid FROM jsonb_array_elements(v_shipments) ship
        );
    END IF;

    v_counts := jsonb_strip_nulls(jsonb_build_object(
        'requested', COALESCE(jsonb_array_length(v_shipments), 0),
        'ready', COALESCE(jsonb_array_length(v_ready), 0),
        'pending', 0
    ));

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'ok',
        'ready', v_ready,
        'pending', v_pending,
        'policy', v_policy,
        'counts', v_counts
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
        'label_print', jsonb_build_object(
            'organization_id', v_org_id,
            'ready', v_ready,
            'pending', v_pending,
            'counts', v_counts,
            'policy', v_policy,
            'options', COALESCE(v_metadata, '{}'::jsonb)
        )
    ));

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Populate ready labels from payload shipments; dynamic via policy; no wait loop.';

COMMIT;
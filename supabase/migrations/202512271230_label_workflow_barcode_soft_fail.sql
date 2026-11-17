-- Migration: Soften barcode_generate_v1 when barcode value missing and align handler statuses.
-- Rationale: Avoid failing label workflows when payload omits tracking_number (bulk requests); keep handler status valid.

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_barcode_generate_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
) RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_org_id UUID := COALESCE(
        NULLIF(v_context->>'organization_id', '')::uuid,
        NULLIF(v_payload->>'organization_id', '')::uuid,
        NULLIF(v_label_state->>'organization_id', '')::uuid
    );
    v_barcode TEXT := COALESCE(
        v_payload->>'tracking_number',
        v_payload->>'barcode_value',
        v_label_state->>'tracking_number',
        v_label_state->>'barcode_value'
    );
    v_bucket TEXT := current_setting('app.label_asset_bucket', TRUE);
    v_path TEXT;
    v_response workflow_handler_response;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_barcode_generate_v1: organization_id required';
    END IF;

    IF v_barcode IS NULL OR length(v_barcode) = 0 THEN
        v_barcode := NULLIF(btrim(COALESCE(
            v_label_state->'shipments'->0->>'tracking_number',
            v_label_state->'shipments'->0->>'barcode_value',
            v_label_state->'shipments'->0->>'barcode',
            v_payload->'shipments'->0->>'tracking_number',
            v_payload->'shipments'->0->>'barcode_value',
            v_payload->'shipments'->0->>'barcode'
        )), '');
    END IF;

    IF v_barcode IS NULL OR length(v_barcode) = 0 THEN
        v_context := jsonb_set(v_context, '{label_print,barcode_asset}', 'null'::jsonb, TRUE);
        v_context := jsonb_set(v_context, '{label_print,barcode_warning}', to_jsonb('barcode_value_missing'), TRUE);

        v_response.status := 'completed';
        v_response.workflow_status := 'continue';
        v_response.next_run_at := NULL;
        v_response.operation_result := jsonb_build_object('status', 'skipped', 'reason', 'barcode_value_missing');
        v_response.context_patch := v_context;
        RETURN v_response;
    END IF;

    v_bucket := COALESCE(v_bucket, 'label-render-assets');
    v_path := format('%s/barcodes/%s.png', v_org_id, v_barcode);

    v_response.status := 'completed';
    v_response.workflow_status := 'continue';
    v_response.next_run_at := NULL;
    v_response.operation_result := '{}'::jsonb;
    v_response.context_patch := jsonb_set(COALESCE(v_context, '{}'::jsonb), '{label_print,barcode_asset}', to_jsonb(jsonb_build_object(
        'bucket', v_bucket,
        'path', v_path,
        'value', v_barcode
    )), TRUE);
    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_barcode_generate_v1(workflow_run_steps, workflow_runs, jsonb)
    IS 'Compute barcode asset path for Code128 PNG; soft-fail to continue workflow when barcode value missing.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_render_v2(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
) RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response workflow_handler_response;
BEGIN
    v_response.status := 'completed';
    v_response.workflow_status := 'continue';
    v_response.next_run_at := NULL;
    v_response.operation_result := '{}'::jsonb;
    v_response.context_patch := COALESCE(p_run.context, '{}'::jsonb);
    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_render_v2(workflow_run_steps, workflow_runs, jsonb)
    IS 'Render labels via service-role worker (text+image). Handler is pass-through with completed/continue.';

COMMIT;

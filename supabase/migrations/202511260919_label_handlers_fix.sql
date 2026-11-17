-- Migration: Fix label workflow handlers (barcode_generate_v1, label_render_v2, label_bundle_v2)
-- Align workflow_handler_response fields and remove p_step.operation_settings dependency.

BEGIN;

-- Ensure we use the latest type definition: (status, workflow_status, next_run_at, operation_result, context_patch)

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
    v_barcode TEXT := COALESCE(v_payload->>'tracking_number', v_payload->>'barcode_value', v_label_state->>'tracking_number');
    v_bucket TEXT := current_setting('app.label_asset_bucket', TRUE);
    v_path TEXT;
    v_response workflow_handler_response;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_barcode_generate_v1: organization_id required';
    END IF;
    IF v_barcode IS NULL OR length(v_barcode) = 0 THEN
        RAISE EXCEPTION 'execute_barcode_generate_v1: barcode value required';
    END IF;
    v_bucket := COALESCE(v_bucket, 'label-render-assets');
    v_path := format('%s/barcodes/%s.png', v_org_id, v_barcode);

    v_response.status := 'ok';
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
    IS 'Compute barcode asset path for Code128 PNG (label-render-assets/<org>/barcodes/<value>.png); worker generates asset.';

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
    v_response.status := 'ok';
    v_response.workflow_status := 'continue';
    v_response.next_run_at := NULL;
    v_response.operation_result := '{}'::jsonb;
    v_response.context_patch := COALESCE(p_run.context, '{}'::jsonb);
    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_render_v2(workflow_run_steps, workflow_runs, jsonb)
    IS 'Render labels via service-role worker (text+image). Handler is pass-through with ok/continue.';

-- Replace label_bundle_v2 to read settings from p_context (jsonb) and avoid operation_settings
CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v2(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_context jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_settings JSONB := COALESCE(p_context, '{}'::jsonb);
    v_label_job_ids UUID[];
    v_job_count INT;
    v_ready_count INT;
    v_failed_count INT;
    v_paths JSONB;
    v_output_name TEXT;
    v_org UUID;
BEGIN
    v_label_job_ids := ARRAY(
        SELECT value::uuid
        FROM jsonb_array_elements_text(v_settings->'label_job_ids')
    );

    IF v_label_job_ids IS NULL OR array_length(v_label_job_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'label_bundle_v2: label_job_ids required';
    END IF;

    SELECT organization_id
    INTO v_org
    FROM label_jobs
    WHERE id = v_label_job_ids[1];

    SELECT COUNT(*) INTO v_job_count
    FROM label_jobs
    WHERE id = ANY (v_label_job_ids);

    IF v_job_count <> array_length(v_label_job_ids, 1) THEN
        RAISE EXCEPTION 'label_bundle_v2: some jobs missing';
    END IF;

    SELECT COUNT(*) INTO v_ready_count
    FROM label_jobs
    WHERE id = ANY (v_label_job_ids) AND status = 'succeeded' AND output_file_url IS NOT NULL;

    SELECT COUNT(*) INTO v_failed_count
    FROM label_jobs
    WHERE id = ANY (v_label_job_ids) AND status = 'failed';

    IF v_failed_count > 0 THEN
        RETURN jsonb_build_object('status', 'failed', 'reason', 'label_jobs_failed');
    END IF;

    IF v_ready_count <> v_job_count THEN
        RETURN jsonb_build_object('status', 'pending', 'reason', 'waiting_for_label_jobs');
    END IF;

    SELECT jsonb_agg(jsonb_build_object('id', id, 'path', output_file_url))
    INTO v_paths
    FROM label_jobs
    WHERE id = ANY (v_label_job_ids);

    v_output_name := COALESCE(v_settings->>'output_name', format('bundles/%s/%s.pdf', v_org, gen_random_uuid()));

    RETURN jsonb_build_object(
        'status', 'ready_to_merge',
        'label_jobs', v_paths,
        'output_path', v_output_name
    );
END;
$$;

COMMIT;

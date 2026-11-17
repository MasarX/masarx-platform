-- Migration: label_bundle_v2 handler (ready_to_merge using label_jobs outputs)
-- Purpose: Provide a lightweight bundle handler that waits for label_jobs to succeed,
--          returns their output_file_url list and a target output_path for merging
--          (merge done in worker; no re-render, no new tables).

BEGIN;

SET search_path TO public, pg_temp;

-- Idempotency: allow changing parameter defaults across shared CI DBs.
DROP FUNCTION IF EXISTS workflow_handlers.execute_label_bundle_v2(workflow_run_steps, workflow_runs, JSONB);

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v2(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_context JSONB
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_settings JSONB := COALESCE(p_step.operation_settings, '{}'::jsonb);
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

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v2(workflow_run_steps, workflow_runs, JSONB)
    IS 'Label bundle v2: wait for label_jobs to succeed, return paths and output_path for worker merge (no render in handler).';

DO $$
BEGIN
  IF to_regclass('public.operation_handler_registry') IS NOT NULL THEN
    INSERT INTO operation_handler_registry (handler_key, handler_version, module_name, function_name, doc_url)
    VALUES ('label_bundle', 'v2', 'workflow_handlers', 'execute_label_bundle_v2', 'docs/ops/runbooks/label_renderer_runbook.md#bundle')
    ON CONFLICT (handler_key, handler_version) DO UPDATE
    SET module_name = EXCLUDED.module_name,
        function_name = EXCLUDED.function_name,
        doc_url = EXCLUDED.doc_url;
  ELSE
    RAISE NOTICE 'operation_handler_registry missing; skipping registry insert for label_bundle v2';
  END IF;
END;
$$;

COMMIT;

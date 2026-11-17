-- Migration: Fix label_bundle_v2 handler settings source (context-driven)
-- Purpose: Ensure execute_label_bundle_v2 reads settings from p_context (jsonb) rather than p_step fields
--          so db-lint passes and the handler stays compatible with workflow_run_steps type.

BEGIN;

SET search_path TO public, pg_temp;

-- Idempotency: allow changing parameter defaults across shared CI DBs.
DROP FUNCTION IF EXISTS workflow_handlers.execute_label_bundle_v2(workflow_run_steps, workflow_runs, JSONB);

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

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v2(workflow_run_steps, workflow_runs, jsonb)
    IS 'Label bundle v2: wait for label_jobs to succeed, return paths and output_path for worker merge (no render in handler).';

COMMIT;


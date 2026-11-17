-- Migration: label_bundle_v2 quick poll policy
-- Purpose:
--  - Add policy-driven in-handler quick rechecks to reduce pending handoff latency.
--  - Keep async workflow contract (pending/failed/ready_to_merge) and avoid hardcoded waits.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

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
    v_policy JSONB := '{}'::jsonb;
    v_quick_poll_attempts INT := 0;
    v_quick_poll_interval_ms INT := 75;
    v_checked_attempts INT := 0;
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

    v_policy := COALESCE(
      CASE
        WHEN v_org IS NOT NULL THEN resolve_settings('label_print_policy', 'tenant', v_org)
        ELSE NULL
      END,
      resolve_settings('label_print_policy', 'global', NULL),
      '{}'::jsonb
    );

    v_quick_poll_attempts := LEAST(
      GREATEST(
        COALESCE(
          NULLIF(v_settings->>'quick_poll_attempts', '')::INT,
          NULLIF(v_policy->>'quick_poll_attempts', '')::INT,
          0
        ),
        0
      ),
      20
    );
    v_quick_poll_interval_ms := LEAST(
      GREATEST(
        COALESCE(
          NULLIF(v_settings->>'quick_poll_interval_ms', '')::INT,
          NULLIF(v_policy->>'quick_poll_interval_ms', '')::INT,
          75
        ),
        25
      ),
      2000
    );

    LOOP
      SELECT COUNT(*) INTO v_ready_count
      FROM label_jobs
      WHERE id = ANY (v_label_job_ids)
        AND status = 'succeeded'
        AND output_file_url IS NOT NULL;

      SELECT COUNT(*) INTO v_failed_count
      FROM label_jobs
      WHERE id = ANY (v_label_job_ids)
        AND status = 'failed';

      IF v_failed_count > 0 OR v_ready_count = v_job_count OR v_checked_attempts >= v_quick_poll_attempts THEN
        EXIT;
      END IF;

      v_checked_attempts := v_checked_attempts + 1;
      PERFORM pg_sleep((v_quick_poll_interval_ms::numeric) / 1000.0);
    END LOOP;

    IF v_failed_count > 0 THEN
        RETURN jsonb_build_object(
          'status', 'failed',
          'reason', 'label_jobs_failed',
          'failed_count', v_failed_count,
          'quick_poll_attempts', v_checked_attempts,
          'quick_poll_interval_ms', v_quick_poll_interval_ms
        );
    END IF;

    IF v_ready_count <> v_job_count THEN
        RETURN jsonb_build_object(
          'status', 'pending',
          'reason', 'waiting_for_label_jobs',
          'ready_count', v_ready_count,
          'job_count', v_job_count,
          'quick_poll_attempts', v_checked_attempts,
          'quick_poll_interval_ms', v_quick_poll_interval_ms
        );
    END IF;

    SELECT jsonb_agg(jsonb_build_object('id', id, 'path', output_file_url))
    INTO v_paths
    FROM label_jobs
    WHERE id = ANY (v_label_job_ids);

    v_output_name := COALESCE(v_settings->>'output_name', format('bundles/%s/%s.pdf', v_org, gen_random_uuid()));

    RETURN jsonb_build_object(
        'status', 'ready_to_merge',
        'label_jobs', v_paths,
        'output_path', v_output_name,
        'quick_poll_attempts', v_checked_attempts,
        'quick_poll_interval_ms', v_quick_poll_interval_ms
    );
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v2(workflow_run_steps, workflow_runs, jsonb)
    IS 'Label bundle v2: wait for label_jobs with policy-driven quick polls, return ready_to_merge paths when complete.';

COMMIT;

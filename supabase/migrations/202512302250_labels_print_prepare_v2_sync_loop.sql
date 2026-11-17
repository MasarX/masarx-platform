-- Migration: Labels print prepare v2 (sync render loop)
-- Purpose:
--  - Invoke the label renderer in bounded batches until pending labels are ready
--    (or policy max calls reached) to deliver a synchronous UX.
-- Notes:
--  - Keeps workflow ordering intact by reusing prepare v1 for evaluation.
--  - Uses row-driven policy knobs (label_print_policy.render_*).

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_prepare_v2(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
  v_response workflow_handler_response;
  v_policy JSONB := '{}'::jsonb;
  v_pending JSONB := '[]'::jsonb;
  v_org_id UUID := NULL;

  v_render_enabled BOOLEAN := TRUE;
  v_render_max_jobs INT := 25;
  v_render_job_concurrency INT := 10;
  v_render_lease_seconds INT := 60;
  v_render_max_calls INT := 20;

  v_call_idx INT := 0;
  v_pending_count INT := 0;
BEGIN
  v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);

  IF v_response.status IS DISTINCT FROM 'pending' THEN
    RETURN v_response;
  END IF;

  v_policy := COALESCE(v_response.operation_result->'policy', '{}'::jsonb);
  v_org_id := NULLIF(v_response.context_patch->'label_print'->>'organization_id', '')::uuid;

  v_render_enabled := COALESCE((v_policy->>'render_invoke_enabled')::BOOLEAN, TRUE);
  IF NOT v_render_enabled OR v_org_id IS NULL THEN
    RETURN v_response;
  END IF;

  v_render_max_jobs := COALESCE(NULLIF((v_policy->>'render_max_jobs')::INT, 0), 25);
  v_render_job_concurrency := COALESCE(NULLIF((v_policy->>'render_job_concurrency')::INT, 0), 10);
  v_render_lease_seconds := COALESCE(NULLIF((v_policy->>'render_lease_seconds')::INT, 0), 60);
  v_render_max_calls := COALESCE(NULLIF((v_policy->>'render_max_calls')::INT, 0), 20);

  v_render_max_jobs := LEAST(GREATEST(v_render_max_jobs, 1), 100);
  v_render_job_concurrency := LEAST(GREATEST(v_render_job_concurrency, 1), 10);
  v_render_lease_seconds := LEAST(GREATEST(v_render_lease_seconds, 60), 600);
  v_render_max_calls := LEAST(GREATEST(v_render_max_calls, 1), 50);

  FOR v_call_idx IN 1..v_render_max_calls LOOP
    IF v_response.status IS DISTINCT FROM 'pending' THEN
      EXIT;
    END IF;

    v_pending := COALESCE(v_response.operation_result->'pending', '[]'::jsonb);
    IF jsonb_typeof(v_pending) IS DISTINCT FROM 'array' THEN
      EXIT;
    END IF;

    v_pending_count := jsonb_array_length(v_pending);
    IF v_pending_count <= 0 THEN
      EXIT;
    END IF;

    BEGIN
      PERFORM invoke_label_renderer(
        NULL,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org_id,
          'lease_seconds', v_render_lease_seconds,
          'max_jobs', LEAST(v_render_max_jobs, v_pending_count),
          'job_concurrency', v_render_job_concurrency
        ))
      );
    EXCEPTION WHEN OTHERS THEN
      v_response.last_error := SQLERRM;
      RETURN v_response;
    END;

    -- Re-evaluate immediately after invoking the renderer (sync path).
    v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);
  END LOOP;

  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v2(workflow_run_steps, workflow_runs, JSONB)
  IS 'Prepare labels for bundling (v2): batch enqueue + synchronous invoke_label_renderer loop (policy-driven render_* knobs).';

COMMIT;


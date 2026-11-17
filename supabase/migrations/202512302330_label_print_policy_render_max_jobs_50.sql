-- Migration: label_print_policy default render_max_jobs=50
-- Purpose:
--  - Reduce synchronous label rendering latency for large bundles (e.g., 100 labels)
--    by processing more jobs per edge worker invocation (fewer calls).
-- Notes:
--  - Row-driven: tenants/clients/senders can override via settings ladder.

BEGIN;

SET search_path TO public, workflow_handlers, pg_temp;

-- =============================================================================
-- Section 1: Tune active global label_print_policy.render_max_jobs default
-- =============================================================================

WITH current_global AS (
  SELECT settings_version_id
  FROM settings
  WHERE category = 'label_print_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY last_updated DESC
  LIMIT 1
),
updated AS (
  UPDATE settings_versions sv
  SET value =
    jsonb_set(
      sv.value,
      '{render_max_jobs}',
      to_jsonb(50),
      true
    ),
    change_reason = 'Tune label_print_policy render_max_jobs default to 50 for faster synchronous bundles',
    approved_at = workflow_now(),
    effective_from = workflow_now()
  FROM current_global cg
  WHERE sv.id = cg.settings_version_id
  RETURNING sv.value
),
applied AS (
  UPDATE settings s
  SET cached_value = updated.value,
      last_updated = workflow_now()
  FROM updated
  WHERE s.category = 'label_print_policy'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  RETURNING s.id
)
SELECT 'label_print_policy render_max_jobs default applied' AS status;

-- =============================================================================
-- Section 2: Align v2 prepare fallback defaults (when policy missing)
-- =============================================================================

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
  v_render_max_jobs INT := 50;
  v_render_job_concurrency INT := 10;
  v_render_lease_seconds INT := 60;
  v_render_max_calls INT := 20;

  v_call_count INT := 0;
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

  v_render_max_jobs := COALESCE(NULLIF((v_policy->>'render_max_jobs')::INT, 0), 50);
  v_render_job_concurrency := COALESCE(NULLIF((v_policy->>'render_job_concurrency')::INT, 0), 10);
  v_render_lease_seconds := COALESCE(NULLIF((v_policy->>'render_lease_seconds')::INT, 0), 60);
  v_render_max_calls := COALESCE(NULLIF((v_policy->>'render_max_calls')::INT, 0), 20);

  v_render_max_jobs := LEAST(GREATEST(v_render_max_jobs, 1), 100);
  v_render_job_concurrency := LEAST(GREATEST(v_render_job_concurrency, 1), 10);
  v_render_lease_seconds := LEAST(GREATEST(v_render_lease_seconds, 60), 600);
  v_render_max_calls := LEAST(GREATEST(v_render_max_calls, 1), 50);

  WHILE v_call_count < v_render_max_calls LOOP
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
      PERFORM public.invoke_label_renderer(
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

    v_response := workflow_handlers.execute_label_print_prepare_v1(p_step, p_run, p_operation_result);
    v_call_count := v_call_count + 1;
  END LOOP;

  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v2(workflow_run_steps, workflow_runs, JSONB)
  IS 'Prepare labels for bundling (v2): batch enqueue + synchronous invoke_label_renderer loop (policy-driven render_* knobs).';

COMMIT;


-- Migration: expose workflow progress budget context to handlers
-- Purpose:
--   - Let handlers read the active inline/poll progression budget instead of guessing from static policy.
--   - Keep progress orchestration generic while allowing budget-aware wait behavior in downstream handlers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063200_progress_workflow_budget_context_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.progress_workflow_run_until_wait_v1(
  p_workflow_run_id uuid,
  p_operation_result jsonb DEFAULT '{}'::jsonb,
  p_budget_ms int DEFAULT NULL,
  p_max_steps int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_budget_ms int := LEAST(GREATEST(COALESCE(p_budget_ms, 150), 25), 5000);
  v_max_steps int := LEAST(GREATEST(COALESCE(p_max_steps, 3), 1), 50);
  v_started_at timestamptz := clock_timestamp();
  v_elapsed_ms int := 0;
  v_remaining_ms int := 0;
  v_steps int := 0;
  v_waited_ms int := 0;
  v_last jsonb := jsonb_build_object('workflow_run_id', p_workflow_run_id, 'status', 'idle');
  v_injected_operation_result jsonb := COALESCE(p_operation_result, '{}'::jsonb);
  v_status text := '';
  v_has_step boolean := false;
  v_next_run_at timestamptz := NULL;
  v_wait_ms int := 0;
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'progress_workflow_run_until_wait_v1 requires workflow_run_id';
  END IF;

  WHILE v_steps < v_max_steps LOOP
    v_elapsed_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::int;
    EXIT WHEN v_elapsed_ms >= v_budget_ms;

    v_remaining_ms := GREATEST(v_budget_ms - v_elapsed_ms, 0);
    PERFORM set_config('masarx.workflow_progress_budget_ms', v_budget_ms::text, true);
    PERFORM set_config('masarx.workflow_progress_elapsed_ms', v_elapsed_ms::text, true);
    PERFORM set_config('masarx.workflow_progress_remaining_ms', v_remaining_ms::text, true);

    v_last := public.progress_workflow_run(p_workflow_run_id, v_injected_operation_result);
    v_steps := v_steps + 1;
    v_injected_operation_result := '{}'::jsonb;
    v_status := lower(COALESCE(v_last->>'status', ''));
    v_has_step := NULLIF(v_last->>'step_id', '') IS NOT NULL;
    v_next_run_at := NULL;

    BEGIN
      v_next_run_at := NULLIF(v_last->>'next_run_at', '')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      v_next_run_at := NULL;
    END;

    EXIT WHEN v_status IN ('failed', 'cancelled', 'blocked');
    IF v_status = 'completed' AND NOT v_has_step THEN
      EXIT;
    END IF;

    IF v_status IN ('pending', 'waiting') AND v_next_run_at IS NOT NULL THEN
      v_elapsed_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::int;
      v_remaining_ms := GREATEST(v_budget_ms - v_elapsed_ms, 0);
      v_wait_ms := GREATEST(CEIL(EXTRACT(EPOCH FROM (v_next_run_at - clock_timestamp())) * 1000.0)::int, 0);

      IF v_wait_ms = 0 THEN
        CONTINUE;
      END IF;

      IF v_wait_ms <= v_remaining_ms THEN
        PERFORM pg_sleep((v_wait_ms::numeric) / 1000.0);
        v_waited_ms := v_waited_ms + v_wait_ms;
        CONTINUE;
      END IF;
    END IF;

    EXIT WHEN v_status IN ('pending', 'waiting', 'in_progress');
  END LOOP;

  v_elapsed_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::int;

  RETURN jsonb_strip_nulls(
    COALESCE(v_last, '{}'::jsonb)
    || jsonb_build_object(
      'attempts', v_steps,
      'elapsed_ms', v_elapsed_ms,
      'budget_ms', v_budget_ms,
      'max_steps', v_max_steps,
      'waited_ms', v_waited_ms
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'status', 'failed',
      'error', SQLERRM,
      'attempts', v_steps,
      'elapsed_ms', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::int,
      'budget_ms', v_budget_ms,
      'max_steps', v_max_steps,
      'waited_ms', v_waited_ms
    );
END;
$$;

COMMENT ON FUNCTION public.progress_workflow_run_until_wait_v1(uuid, jsonb, int, int)
  IS 'Advance a workflow run through immediately-available steps, bridge short due waits within budget, and expose active budget context to handlers.';

SELECT pg_advisory_unlock(hashtext('202603063200_progress_workflow_budget_context_v1'));
COMMIT;

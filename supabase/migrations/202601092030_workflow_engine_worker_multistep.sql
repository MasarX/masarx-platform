-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: Workflow engine worker multi-step per run
-- Purpose:
--   - Reduce workflow latency by allowing a single tick to advance multiple immediate steps
--     for the same workflow_run (until waiting/run completion), instead of one step per tick.
--   - Keep limits configurable via workflow_defaults.max_steps_per_tick (global) with safe defaults.
-- Date: 2026-01-09

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.run_workflow_engine_worker()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_processed_steps INT := 0;
  v_error BOOLEAN := FALSE;
  v_pending_run RECORD;
  v_progress JSONB;
  v_defaults JSONB;
  v_max_steps_per_tick INT := 5;
  v_i INT;
  v_status TEXT;
  v_next_run_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_engine_worker');
  IF NOT v_throttle.should_run THEN
    RETURN jsonb_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
  BEGIN
    v_max_steps_per_tick := COALESCE(NULLIF(v_defaults->>'max_steps_per_tick', '')::INT, v_max_steps_per_tick);
  EXCEPTION
    WHEN others THEN
      v_max_steps_per_tick := 5;
  END;
  v_max_steps_per_tick := LEAST(GREATEST(v_max_steps_per_tick, 1), 25);

  v_context := public.create_request_context('workflow_engine_worker');

  FOR v_pending_run IN
    SELECT wr.id
    FROM public.workflow_runs wr
    WHERE wr.workflow_status IN ('pending', 'in_progress', 'waiting')
      AND EXISTS (
        SELECT 1
        FROM public.workflow_run_steps wrs
        WHERE wrs.workflow_run_id = wr.id
          AND wrs.step_status = 'pending'
          AND wrs.run_at <= now()
      )
    ORDER BY wr.updated_at ASC
    LIMIT v_throttle.batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_i := 0;
      LOOP
        v_i := v_i + 1;
        EXIT WHEN v_i > v_max_steps_per_tick;

        v_progress := public.progress_workflow_run(v_pending_run.id);
        v_status := NULLIF(v_progress->>'status', '');

        BEGIN
          v_next_run_at := (v_progress->>'next_run_at')::timestamptz;
        EXCEPTION
          WHEN others THEN
            v_next_run_at := NULL;
        END;

        -- If a step executed, count it.
        IF v_progress ? 'step_id' THEN
          v_processed_steps := v_processed_steps + 1;
        END IF;

        -- Stop when the engine indicates waiting/scheduling, or when it is no longer returning a step.
        IF v_status IN ('waiting', 'failed', 'cancelled') THEN
          EXIT;
        END IF;
        IF v_next_run_at IS NOT NULL THEN
          EXIT;
        END IF;
        IF (v_progress ? 'step_id') IS FALSE THEN
          EXIT;
        END IF;
      END LOOP;
    EXCEPTION
      WHEN OTHERS THEN
        v_error := TRUE;
        -- Keep the tick resilient; the engine persists per-run failure state.
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_processed_steps);
  PERFORM public.update_cron_config('workflow_engine_worker');

  RETURN jsonb_build_object(
    'status', 'completed',
    'items_processed', v_processed_steps,
    'error_occurred', v_error,
    'max_steps_per_tick', v_max_steps_per_tick
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_engine_worker()
  IS 'Progress workflow runs by invoking progress_workflow_run() for runs with due steps; advances multiple steps per run per tick (configurable).';

COMMIT;

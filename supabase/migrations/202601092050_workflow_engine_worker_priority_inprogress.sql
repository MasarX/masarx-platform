-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: Workflow engine worker prioritization
-- Purpose:
--   - Prevent starvation of partially-progressed runs by prioritizing workflow_status=in_progress
--     (then waiting) over brand-new pending runs.
--   - Keep selection row-driven via cron_config and continue to rely on progress_workflow_run for
--     per-run correctness/locking.
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
    ORDER BY
      CASE wr.workflow_status
        WHEN 'in_progress' THEN 0
        WHEN 'waiting' THEN 1
        WHEN 'pending' THEN 2
        ELSE 3
      END,
      wr.updated_at ASC,
      wr.created_at ASC
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

        IF v_progress ? 'step_id' THEN
          v_processed_steps := v_processed_steps + 1;
        END IF;

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
  IS 'Progress workflow runs by invoking progress_workflow_run() for due runs; prioritizes in_progress/waiting to reduce starvation.';

COMMIT;

-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: Workflow engine worker tick (pg_cron)
-- Purpose:
--   - Ensure workflow_runs progress autonomously in cloud by periodically invoking progress_workflow_run()
--     for runs that have pending steps due.
--   - Keep behavior row-driven via cron_config (batch_size / enabled / interval) and follow existing
--     worker patterns (check_throttle + request_context + update_cron_config).
-- Date: 2026-01-09

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

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
  v_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_pending_run RECORD;
  v_progress JSONB;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_engine_worker');
  IF NOT v_throttle.should_run THEN
    RETURN jsonb_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

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
    ORDER BY wr.created_at ASC
    LIMIT v_throttle.batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_progress := public.progress_workflow_run(v_pending_run.id);
      v_processed := v_processed + 1;

      -- Optional: if engine returned next_run_at, persist it as the run's updated_at only.
      -- Step-level run_at scheduling is handled inside progress_workflow_run().
    EXCEPTION
      WHEN OTHERS THEN
        v_error := TRUE;
        -- Do not fail the worker tick on a single bad run; rely on engine/internal error handling.
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_processed);
  PERFORM public.update_cron_config('workflow_engine_worker');

  RETURN jsonb_build_object(
    'status', 'completed',
    'items_processed', v_processed,
    'error_occurred', v_error
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_engine_worker()
  IS 'Progress workflow runs by invoking progress_workflow_run() for runs that have due pending steps.';

-- Register worker in worker_registry / cron_config (row-driven throttle config).
INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'workflow_engine_worker',
  'workflow',
  'Advances workflow_runs by executing due workflow_run_steps via progress_workflow_run().',
  '*/1 * * * *',
  '{"batch_size": 50, "timeout_seconds": 60, "retry_policy": {"max_retries": 5, "backoff": "exponential"}}'::jsonb,
  true
)
ON CONFLICT (worker_name) DO UPDATE
SET
  worker_type = EXCLUDED.worker_type,
  description = EXCLUDED.description,
  schedule = EXCLUDED.schedule,
  config = EXCLUDED.config,
  is_active = EXCLUDED.is_active,
  updated_at = now();

INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'workflow_engine_worker',
  60,
  50,
  true,
  'Throttle config for workflow engine tick (advances due steps).'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

-- Schedule via pg_cron (idempotent replace).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'run_workflow_engine_worker') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workflow_engine_tick') THEN
      PERFORM cron.unschedule((SELECT jobid FROM cron.job WHERE jobname = 'workflow_engine_tick'));
    END IF;

    PERFORM cron.schedule('workflow_engine_tick', '*/1 * * * *', 'SELECT public.run_workflow_engine_worker();');
  END IF;
END $$;

COMMIT;

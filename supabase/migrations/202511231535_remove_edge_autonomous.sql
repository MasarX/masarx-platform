-- Migration: Remove autonomous edge batch helpers in favor of strict workflow-only dispatch
-- Purpose: Drop helper functions and unschedule cron jobs introduced for api-caller batch.

BEGIN;

-- Unschedule known job names if present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'api_caller_batch_tick') THEN
    PERFORM cron.unschedule((SELECT jobid FROM cron.job WHERE jobname='api_caller_batch_tick'));
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'outbound_worker_tick') THEN
    PERFORM cron.unschedule((SELECT jobid FROM cron.job WHERE jobname='outbound_worker_tick'));
  END IF;
END $$;

-- Drop helpers if they exist (ignore missing)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='run_api_caller_batch') THEN
    DROP FUNCTION public.run_api_caller_batch(INT);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='resolve_api_caller_endpoint') THEN
    DROP FUNCTION public.resolve_api_caller_endpoint();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='resolve_edge_task_token') THEN
    DROP FUNCTION public.resolve_edge_task_token();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='resolve_anon_key') THEN
    DROP FUNCTION public.resolve_anon_key();
  END IF;
END $$;

COMMIT;


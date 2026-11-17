-- Plan: PLAN-202601-logestechs-outbound-http2-fix / Step: S06
-- Migration: Add edge api-caller autonomous worker (DB-side tick)
-- Purpose:
--   - Provide public.run_edge_api_caller_worker() expected by pgTAP contract.
--   - Schedule api_caller_batch_tick to invoke the worker (row-driven via cron_config + edge_dispatch_policy).
-- Date: 2026-01-10

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.run_edge_api_caller_worker()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_settings JSONB;
  v_batch INT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('edge_api_caller_worker');
  IF NOT v_throttle.should_run THEN
    RETURN jsonb_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);

  BEGIN
    v_batch := COALESCE(NULLIF(v_settings->>'batch_size', '')::INT, NULLIF(v_throttle.batch_size, 0), 25);
  EXCEPTION
    WHEN others THEN
      v_batch := COALESCE(NULLIF(v_throttle.batch_size, 0), 25);
  END;
  v_batch := LEAST(GREATEST(v_batch, 1), 1000);

  v_context := public.create_request_context('edge_api_caller_worker');

  BEGIN
    v_result := public.run_api_caller_batch(v_batch);
    v_processed := 1;
  EXCEPTION
    WHEN others THEN
      v_error := TRUE;
      v_result := jsonb_build_object('error', SQLERRM);
  END;

  PERFORM public.complete_request_context(v_context, v_error, v_processed);
  PERFORM public.update_cron_config('edge_api_caller_worker');

  RETURN jsonb_build_object(
    'status', 'completed',
    'items_processed', v_processed,
    'error_occurred', v_error,
    'batch', v_batch,
    'result', v_result
  );
END;
$$;

COMMENT ON FUNCTION public.run_edge_api_caller_worker()
  IS 'Autonomous tick to invoke edge api-caller batch execution (row-driven via cron_config + edge_dispatch_policy).';

INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'edge_api_caller_worker',
  'outbound',
  'Invokes Edge api-caller to execute outbound_calls intended for edge (pending_edge).',
  '*/1 * * * *',
  '{"batch_size": 25}'::jsonb,
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
  'edge_api_caller_worker',
  60,
  25,
  TRUE,
  'DB tick that calls Edge api-caller batch runner'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'api_caller_batch_tick') THEN
    PERFORM cron.unschedule('api_caller_batch_tick');
  END IF;

  PERFORM cron.schedule('api_caller_batch_tick', '*/1 * * * *', 'SELECT public.run_edge_api_caller_worker();');
END $$;

COMMIT;

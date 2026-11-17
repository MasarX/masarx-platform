-- Migration: Schedule alert aggregation/dispatch workers
-- Purpose: Make alert_rules actionable autonomously by ensuring workers are registered and scheduled via pg_cron.
-- Date: 2025-12-13

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Ensure alert_dispatch_worker exists in worker_registry + cron_config for check_throttle().
INSERT INTO worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'alert_dispatch_worker',
  'monitoring',
  'Dispatches alert_triggers by enqueueing notification jobs (queue-only).',
  '*/1 * * * *',
  jsonb_build_object(
    'batch_size', 100,
    'timeout_seconds', 30,
    'operation_types', jsonb_build_array('monitoring')
  ),
  TRUE
)
ON CONFLICT (worker_name) DO UPDATE
SET
  worker_type = EXCLUDED.worker_type,
  description = EXCLUDED.description,
  schedule = EXCLUDED.schedule,
  config = EXCLUDED.config,
  is_active = EXCLUDED.is_active,
  updated_at = now();

INSERT INTO cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'alert_dispatch_worker',
  60,
  100,
  TRUE,
  'Alert dispatch every minute (self-throttled via cron_config)'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  last_run_at = NULL;

-- Unschedule any existing jobs to avoid duplicates, then schedule ticks.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alert_aggregation_tick') THEN
    PERFORM cron.unschedule('alert_aggregation_tick');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alert_dispatch_tick') THEN
    PERFORM cron.unschedule('alert_dispatch_tick');
  END IF;
END $$;

SELECT cron.schedule(
  'alert_aggregation_tick',
  '*/1 * * * *',
  $$SELECT public.run_alert_aggregation_worker();$$
);

SELECT cron.schedule(
  'alert_dispatch_tick',
  '*/1 * * * *',
  $$SELECT public.run_alert_dispatch_worker();$$
);

COMMIT;


-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: Increase workflow_engine_worker batch_size
-- Purpose:
--   - Reduce end-to-end latency under backlog by increasing the default batch_size
--     in cron_config for workflow_engine_worker.
--   - This remains row-driven: operators can tune cron_config without code changes.
-- Date: 2026-01-09

BEGIN;

INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'workflow_engine_worker',
  60,
  500,
  true,
  'Throttle config for workflow engine tick (advances due steps). Increased batch_size for backlog resilience.'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

COMMIT;

-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: Backfill workflow_engine_worker in worker_registry
-- Purpose:
--   - Ensure worker_registry contains workflow_engine_worker prior to any cron_config upserts that
--     reference it via FK (cron_config.worker_name -> worker_registry.worker_name).
--   - This is an idempotent backfill to remediate env drift where migration history exists but the
--     worker row is missing (e.g., after partial seed resets).
-- Date: 2026-01-09

BEGIN;

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

COMMIT;


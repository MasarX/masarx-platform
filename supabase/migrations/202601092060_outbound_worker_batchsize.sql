-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: outbound_worker batch_size increase
-- Purpose:
--   - Reduce backlog latency for outbound_calls (including geocoding/provider dispatch) by allowing
--     the scheduled outbound_worker tick to claim/process more work per run.
--   - Row-driven via cron_config only; no worker logic changes.
-- Date: 2026-01-09

BEGIN;

UPDATE public.cron_config
   SET batch_size = GREATEST(batch_size, 500),
       updated_at = now(),
       notes = COALESCE(notes, '') || ' | batch_size bumped to >=500 for backlog drain'
 WHERE worker_name = 'outbound_worker';

COMMIT;

-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: usage_events FK index hygiene (non-partial FK-supporting indexes)
-- Date: 2026-01-31
--
-- Why:
--   - FK index hygiene pgTAP requires non-partial supporting indexes for foreign keys.
--   - usage_events initially used partial time indexes; convert to non-partial without losing access patterns.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601312110_usage_events_fk_index_hygiene_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Replace partial FK-adjacent indexes with non-partial equivalents.
DROP INDEX IF EXISTS public.idx_usage_events_actor_time;
DROP INDEX IF EXISTS public.idx_usage_events_client_time;
DROP INDEX IF EXISTS public.idx_usage_events_sender_time;

CREATE INDEX IF NOT EXISTS idx_usage_events_actor_time
  ON public.usage_events (actor_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_client_time
  ON public.usage_events (client_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_sender_time
  ON public.usage_events (sender_id, occurred_at DESC);

SELECT pg_advisory_unlock(hashtext('202601312110_usage_events_fk_index_hygiene_fix'));
COMMIT;


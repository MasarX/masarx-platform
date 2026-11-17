-- Plan: PLAN-202601-finance-events-ledger-foundation / Step: S04
-- Migration: finance_events partition tree RLS/grants lockdown (prevent partition bypass)
-- Date: 2026-01-21
--
-- Why:
--   - partitioning_config tables (RANGE / HASH+RANGE) must have RLS + least-privilege grants
--     enforced on *all* descendants, not just the parent table.
--   - create_next_partitions enforces this for newly-created partitions, but existing
--     partitions created outside it must be backfilled.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212840_finance_events_partition_rls_lockdown'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.finance_events') IS NOT NULL THEN
    PERFORM public.enforce_partition_tree_service_only_v1('public.finance_events'::regclass);
  END IF;

  IF to_regclass('public.finance_event_dedupe') IS NOT NULL THEN
    PERFORM public.enforce_service_only_rls_v1('public.finance_event_dedupe'::regclass);
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202601212840_finance_events_partition_rls_lockdown'));
COMMIT;


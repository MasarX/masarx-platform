-- Migration: Align weekly partition cron schedule to ISO week start
-- Purpose: Run create_next_partitions/apply_partition_index_templates after the ISO week boundary (Monday),
--          ensuring partitions_ahead coverage is always satisfied.
-- Date: 2025-12-13 10:30 UTC

BEGIN;

-- Ensure pg_cron is available
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Reschedule weekly maintenance jobs to Monday 00:00 UTC (ISO week starts Monday)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_create_next') THEN
    PERFORM cron.unschedule('partition_create_next');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_apply_index_templates') THEN
    PERFORM cron.unschedule('partition_apply_index_templates');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit_ensure_triggers') THEN
    PERFORM cron.unschedule('audit_ensure_triggers');
  END IF;
END $$;

SELECT cron.schedule(
  'partition_create_next',
  '0 0 * * 1',
  $$SELECT * FROM public.create_next_partitions();$$
);

SELECT cron.schedule(
  'partition_apply_index_templates',
  '5 0 * * 1',
  $$SELECT * FROM public.apply_partition_index_templates();$$
);

SELECT cron.schedule(
  'audit_ensure_triggers',
  '10 0 * * 1',
  $$SELECT * FROM public.ensure_audit_triggers();$$
);

-- Apply once now (idempotent) to keep coverage correct immediately
SELECT * FROM public.create_next_partitions();

COMMIT;


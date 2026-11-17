-- Plan: PLAN-202512-unified-jobs-maintenance / Step: S04
-- Migration: Schedule missing workers via pg_cron
-- Purpose: Ensure all registered workers with cron_config can actually run (no missed background jobs).
-- Date: 2025-12-28

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Unschedule any existing jobs to avoid duplicates, then schedule ticks using
-- worker_registry.schedule as the single source of truth for cadence.
DO $$
DECLARE
  v_worker_name TEXT;
  v_jobname TEXT;
  v_schedule TEXT;
  v_command TEXT;
BEGIN
  FOREACH v_worker_name IN ARRAY ARRAY[
    'domain_events_worker',
    'cache_cleanup_worker',
    'campaign_enrollment_worker',
    'campaign_dispatcher_worker',
    'circuit_breaker_recovery_worker'
  ]
  LOOP
    v_jobname := v_worker_name || '_tick';

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_jobname) THEN
      PERFORM cron.unschedule(v_jobname);
    END IF;

    SELECT wr.schedule
      INTO v_schedule
      FROM public.worker_registry wr
     WHERE wr.worker_name = v_worker_name
     LIMIT 1;

    v_schedule := COALESCE(NULLIF(btrim(v_schedule), ''), '*/1 * * * *');
    v_command := format('SELECT public.run_%s();', v_worker_name);

    PERFORM cron.schedule(v_jobname, v_schedule, v_command);
  END LOOP;
END $$;

COMMIT;

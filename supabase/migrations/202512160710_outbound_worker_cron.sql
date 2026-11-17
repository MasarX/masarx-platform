-- Plan: PLAN-202512-comms-prod-ready-p0p2-v3 / Step: S01
-- Migration: Schedule outbound worker via pg_cron
-- Purpose: Ensure outbound_calls progress in cloud by scheduling run_outbound_worker().
-- Date: 2025-12-16

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
DECLARE
  v_jobid INTEGER;
BEGIN
  SELECT jobid
    INTO v_jobid
    FROM cron.job
   WHERE jobname = 'outbound_worker_tick'
   LIMIT 1;

  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;

  PERFORM cron.schedule(
    'outbound_worker_tick',
    '*/1 * * * *',
    'SELECT public.run_outbound_worker();'
  );
END;
$$;

COMMIT;


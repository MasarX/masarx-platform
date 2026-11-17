-- Migration: Edge job requeue cron
-- Purpose: Ensure expired edge leases are recycled automatically every minute.
-- Date: 2025-10-15

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
DECLARE
    v_jobid INTEGER;
BEGIN
    SELECT jobid
    INTO v_jobid
    FROM cron.job
    WHERE jobname = 'edge_requeue_expired_jobs'
    LIMIT 1;

    IF v_jobid IS NOT NULL THEN
        PERFORM cron.unschedule(v_jobid);
    END IF;
END;
$$;

SELECT cron.schedule(
    'edge_requeue_expired_jobs',
    '*/1 * * * *',
    $$SELECT requeue_expired_edge_jobs(500);$$
);

COMMIT;

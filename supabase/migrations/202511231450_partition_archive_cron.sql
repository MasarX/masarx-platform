-- Migration: Schedule partition archiving job (pg_cron)
-- Purpose: Run archive_old_partitions monthly to enforce retention policies
-- Date: 2025-11-23 14:50

BEGIN;

-- Ensure pg_cron is available
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Unschedule existing to avoid duplicates
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_archive_old') THEN
        PERFORM cron.unschedule('partition_archive_old');
    END IF;
END $$;

-- Run on the 1st of each month at 01:00 UTC
SELECT cron.schedule(
    'partition_archive_old',
    '0 1 1 * *',
    $$SELECT * FROM public.archive_old_partitions();$$
);

COMMIT;


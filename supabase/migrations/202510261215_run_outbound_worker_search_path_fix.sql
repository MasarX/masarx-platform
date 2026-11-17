-- Migration: Ensure run_outbound_worker resolves core helpers via public schema
-- Purpose: Set an explicit search_path on the worker function so unqualified
--          references (e.g., check_throttle, update_cron_config) resolve
--          reliably regardless of caller role/session defaults.

BEGIN;

ALTER FUNCTION public.run_outbound_worker()
  SET search_path TO public, pg_temp;

COMMIT;


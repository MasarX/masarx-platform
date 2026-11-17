-- Migration: Pin search_path for run_domain_events_worker (SECURITY DEFINER)
-- Purpose:
--   - Ensure run_domain_events_worker passes pgTAP 045_secdef_search_path.sql
--     by pinning search_path to safe schemas.
-- Date: 2025-12-14

BEGIN;

ALTER FUNCTION public.run_domain_events_worker()
  SET search_path TO public, extensions, pg_temp;

COMMIT;


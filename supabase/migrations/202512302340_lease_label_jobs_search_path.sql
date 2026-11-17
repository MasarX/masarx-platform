-- Migration: Pin search_path for lease_label_jobs (SECURITY DEFINER)
-- Purpose:
--  - Ensure SECURITY DEFINER functions pin search_path to safe schemas.
--  - Required by pgTAP 045_secdef_search_path.sql.

BEGIN;

ALTER FUNCTION public.lease_label_jobs(UUID, INTEGER, INTEGER)
  SET search_path TO public, pg_temp;

COMMIT;


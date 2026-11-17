-- Migration: upsert_webhook_ingest_policy search_path fix
-- Purpose:
--   - Ensure the SECURITY DEFINER function upsert_webhook_ingest_policy()
--     pins search_path to public,pg_temp in line with 045_secdef_search_path.sql.

BEGIN;

ALTER FUNCTION public.upsert_webhook_ingest_policy(TEXT, UUID, JSONB)
  SET search_path TO public, pg_temp;

COMMIT;


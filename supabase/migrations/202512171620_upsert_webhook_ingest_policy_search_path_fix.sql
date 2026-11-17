-- Migration: Pin search_path for upsert_webhook_ingest_policy
-- Purpose:
--   - Ensure SECURITY DEFINER helper upsert_webhook_ingest_policy pins search_path to
--     safe schemas (public, extensions, pg_temp) to satisfy secdef hardening checks.

BEGIN;

ALTER FUNCTION public.upsert_webhook_ingest_policy(TEXT, UUID, JSONB)
    SET search_path = public, extensions, pg_temp;

COMMIT;


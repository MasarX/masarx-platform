-- Migration: Pin SECDEF search_path for upsert_webhook_ingest_policy
-- Purpose:
--   - Ensure public.upsert_webhook_ingest_policy satisfies pgTAP guard 045_secdef_search_path.sql.
--   - Prevent search_path injection by pinning a safe, public-first search_path at the function level.
-- Date: 2025-12-17

BEGIN;

ALTER FUNCTION public.upsert_webhook_ingest_policy(
  text,
  uuid,
  jsonb
) SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMIT;


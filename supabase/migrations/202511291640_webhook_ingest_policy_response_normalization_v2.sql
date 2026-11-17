-- Migration: webhook_ingest_policy response.* field normalization v2
-- Purpose:
--   - Re-apply normalization for any webhook_ingest_policy settings_versions
--     rows that still contain a top-level "response" key, after introducing
--     the upsert_webhook_ingest_policy normalization logic.

BEGIN;

UPDATE public.settings_versions
SET value = value - 'response'
WHERE category = 'webhook_ingest_policy'
  AND (value ? 'response');

COMMIT;


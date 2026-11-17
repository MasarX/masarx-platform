-- Migration: webhook_ingest_policy response.* field normalization v3
-- Purpose:
--   - Final sweep to remove any remaining legacy top-level "response" keys
--     from webhook_ingest_policy settings_versions rows after test helper
--     updates, keeping schema aligned with pgTAP expectations.

BEGIN;

UPDATE public.settings_versions
SET value = value - 'response'
WHERE category = 'webhook_ingest_policy'
  AND (value ? 'response');

COMMIT;


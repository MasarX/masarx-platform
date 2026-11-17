-- Migration: webhook_ingest_policy response.* field normalization v4
-- Purpose:
--   - Final clean-up after adjusting provider importer tests to stop
--     writing legacy \"response\" keys into webhook_ingest_policy values.

BEGIN;

UPDATE public.settings_versions
SET value = value - 'response'
WHERE category = 'webhook_ingest_policy'
  AND (value ? 'response');

COMMIT;


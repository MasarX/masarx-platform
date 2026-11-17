-- Migration: webhook_ingest_policy response.* field normalization
-- Purpose:
--   - Normalize legacy webhook_ingest_policy settings_versions rows that still
--     contain a top-level "response" object alongside "ack".
--   - The canonical schema stores acknowledgement behaviour under "ack"
--     (including any response mapping), so "response" at the top level is
--     redundant and causes pgTAP to flag schema drift.

BEGIN;

-- Normalize all webhook_ingest_policy versions by dropping the legacy
-- top-level "response" key while preserving "ack" semantics.
UPDATE public.settings_versions
SET value = value - 'response'
WHERE category = 'webhook_ingest_policy'
  AND (value ? 'response');

COMMIT;


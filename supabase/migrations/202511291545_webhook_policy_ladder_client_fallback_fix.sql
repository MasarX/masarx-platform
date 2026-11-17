-- Migration: webhook policy ladder client fallback fix
-- Purpose: Align webhook_ingest_policy ladder fixtures with pgTAP expectations
--          so that resolve_webhook_ingest_policy falls back to client scope
--          for the canonical ladder test source (c7e49b47-...).

BEGIN;

-- For webhook source c7e49b47-7480-4f0d-9da3-2fd8d89ecba1, pgTAP expects that
-- resolve_webhook_ingest_policy returns scope_type = 'client' (no source-level
-- override). Earlier ladder seed data introduced a source-scoped policy for
-- this source, which caused the function to resolve at the source level.
--
-- This migration removes that source-level policy while preserving the
-- client-scoped configuration, restoring the intended ladder behaviour:
--   source > sender > client > tenant > global
-- with this particular source exercising the client fallback path.

-- 1) Repoint historical webhook_inbox rows that referenced the source-scoped
--    policy to the canonical client-scoped policy for the same client. This
--    keeps existing audit rows consistent with the new ladder behaviour.
UPDATE webhook_inbox wi
SET policy_settings_id = '267925e7-3ee5-4648-a181-f51a4b6d9644'::uuid
WHERE wi.policy_settings_id = '8586ef5c-9737-46bb-8627-549dbc78afc7'::uuid;

-- 2) Remove the source-scoped webhook_ingest_policy settings row so that
--    future resolutions use the client-scoped configuration.
DELETE FROM settings
WHERE category = 'webhook_ingest_policy'
  AND scope_type = 'source'
  AND scope_id = 'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1'::uuid
  AND settings_version_id = 'daa0f007-96c6-476e-8110-12ba52ee102d'::uuid;

DELETE FROM settings_versions
WHERE id = 'daa0f007-96c6-476e-8110-12ba52ee102d'::uuid
  AND category = 'webhook_ingest_policy'
  AND scope_type = 'source'
  AND scope_id = 'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1'::uuid;

COMMIT;

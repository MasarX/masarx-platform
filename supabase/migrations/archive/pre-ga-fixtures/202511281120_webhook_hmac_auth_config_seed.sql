-- Migration: Seed HMAC auth config for test-hmac-source
-- Purpose:
--   - Provide a signing_secret for HMAC validation used by webhook-ingest tests.
--   - Attach auth_config_id to the source-level webhook_ingest_policy so
--     workflow_intake_webhook can validate signatures and return 200 on success.

BEGIN;

-- 1) Ensure a dedicated provider exists for HMAC webhook auth under Test Organization Alpha
INSERT INTO providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status)
SELECT
  '0f0f0f0f-1111-2222-3333-444444444444'::uuid,
  org.id,
  'webhook_hmac_test',
  'webhook',
  TRUE,
  10,
  'healthy'
FROM organizations AS org
WHERE org.slug = 'test-org-alpha'
  AND NOT EXISTS (
    SELECT 1 FROM providers WHERE id = '0f0f0f0f-1111-2222-3333-444444444444'::uuid
  );

-- 2) Seed provider_auth_configs with signing_secret for HMAC verification
INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials, expires_at)
SELECT
  'aaaa0000-1111-2222-3333-bbbbbbbbbbbb'::uuid,
  '0f0f0f0f-1111-2222-3333-444444444444'::uuid,
  'api_key',
  jsonb_build_object('signing_secret', 'EXAMPLE_PASSWORD'),
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM provider_auth_configs WHERE id = 'aaaa0000-1111-2222-3333-bbbbbbbbbbbb'::uuid
);

-- 3) Attach auth_config_id to the source-level webhook_ingest_policy for test-hmac-source
UPDATE settings AS s
SET cached_value = jsonb_set(
  cached_value,
  '{validation,hmac,auth_config_id}',
  to_jsonb('aaaa0000-1111-2222-3333-bbbbbbbbbbbb'::uuid),
  TRUE
)
WHERE s.category = 'webhook_ingest_policy'
  AND s.scope_type = 'source'
  AND s.scope_id = '2bdad0d1-400b-4370-a303-6912e8d4db7e'::uuid
  AND (
    cached_value->'validation'->'hmac'->>'auth_config_id' IS NULL
    OR cached_value->'validation'->'hmac'->>'auth_config_id' = ''
  );

COMMIT;


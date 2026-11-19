-- Test Suite: Logestechs status webhook mirror configuration
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM schema_registry
    WHERE category = 'client_webhook_policy'
      AND version = 1
      AND is_active = TRUE
  ),
  'schema_registry includes client_webhook_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM settings
    WHERE category = 'client_webhook_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'global client_webhook_policy default is seeded'
);

CREATE TEMP TABLE tmp_client_policy_scope (
  organization_id UUID,
  client_id UUID,
  sender_id UUID
);
INSERT INTO tmp_client_policy_scope
VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid());

-- Defer tenant bootstrap until the fixture has truthful client/sender context
-- so fail-closed plugin activation can resolve an active source binding.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO organizations (id, name, slug)
SELECT
  organization_id,
  'pgTAP Logestechs Org',
  'pgtap-org-' || substr(replace(organization_id::text, '-', ''), 1, 12)
FROM tmp_client_policy_scope
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO clients (id, organization_id, name, slug, status)
SELECT
  client_id,
  organization_id,
  'pgTAP Logestechs Client',
  'pgtap-client-' || substr(replace(client_id::text, '-', ''), 1, 12),
  'active'
FROM tmp_client_policy_scope
ON CONFLICT (id) DO NOTHING;

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
SELECT
  sender_id,
  client_id,
  'pgTAP Logestechs Sender',
  'pgTAP Logestechs Sender',
  TRUE,
  'active'
FROM tmp_client_policy_scope
ON CONFLICT (id) DO NOTHING;

SELECT bootstrap_tenant_onboarding_v1(
  organization_id,
  'pgtap:logestechs-status-webhook-mirror-fixture-bootstrap'
)
FROM tmp_client_policy_scope;

WITH tenant_sv AS (
  INSERT INTO settings_versions_p0 (
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'client_webhook_policy',
    'tenant',
    organization_id,
    organization_id,
    1,
    jsonb_build_object(
      'version', 1,
      'enabled', FALSE,
      'url', 'https://example.invalid/tenant/logestechs',
      'method', 'POST',
      'headers', jsonb_build_object('content-type', 'application/json'),
      'payload', jsonb_build_object('mode', 'passthrough_raw'),
      'filter', jsonb_build_object('mode', 'all', 'statuses', jsonb_build_array())
    ),
    1,
    'pgtap seed tenant client_webhook_policy',
    now(),
    now()
  FROM tmp_client_policy_scope
  RETURNING id, scope_id, scope_hash, value
)
INSERT INTO settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'client_webhook_policy',
  'tenant',
  scope_id,
  scope_hash,
  id,
  value,
  now()
FROM tenant_sv
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

WITH client_sv AS (
  INSERT INTO settings_versions_p0 (
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'client_webhook_policy',
    'client',
    client_id,
    client_id,
    1,
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'url', 'https://example.invalid/webhooks/logestechs',
      'method', 'POST',
      'headers', jsonb_build_object('content-type', 'application/json'),
      'payload', jsonb_build_object('mode', 'passthrough_raw'),
      'filter', jsonb_build_object('mode', 'all', 'statuses', jsonb_build_array())
    ),
    1,
    'pgtap seed client_webhook_policy',
    now(),
    now()
  FROM tmp_client_policy_scope
  RETURNING id, scope_id, scope_hash, value
)
INSERT INTO settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'client_webhook_policy',
  'client',
  scope_id,
  scope_hash,
  id,
  value,
  now()
FROM client_sv
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

SELECT is(
  (
    SELECT scope_type
    FROM resolve_settings_row_from_context(
      'client_webhook_policy',
      jsonb_build_object(
        'organization_id', (SELECT organization_id FROM tmp_client_policy_scope),
        'client_id', (SELECT client_id FROM tmp_client_policy_scope)
      )
    )
  ),
  'client',
  'resolve_settings_row_from_context prefers client-scoped client_webhook_policy'
);

SELECT is(
  (
    SELECT scope_type
    FROM resolve_settings_row_from_context(
      'client_webhook_policy',
      jsonb_build_object('organization_id', (SELECT organization_id FROM tmp_client_policy_scope))
    )
  ),
  'tenant',
  'resolve_settings_row_from_context falls back to tenant scope'
);

SELECT * FROM finish();

ROLLBACK;

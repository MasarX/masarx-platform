-- Test Suite: renderer_defaults tenant override (transactional fixture)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

-- This fixture owns client/sender setup. Defer organization bootstrap until
-- the source-binding context exists, then run canonical onboarding explicitly.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
VALUES (
  '2bee6f1b-7184-4e22-8f3e-0744efaed257',
  'Renderer Defaults Tenant',
  'renderer-defaults-tenant-fixture',
  'Asia/Riyadh',
  'en-US',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    timezone = EXCLUDED.timezone,
    locale = EXCLUDED.locale,
    billing_status = EXCLUDED.billing_status,
    updated_at = now();
SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO clients (id, organization_id, name, slug, status)
VALUES (
  '2bee6f1b-7184-4e22-8f3e-0744efaed258',
  '2bee6f1b-7184-4e22-8f3e-0744efaed257',
  'Renderer Defaults Client',
  'renderer-defaults-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  '2bee6f1b-7184-4e22-8f3e-0744efaed259',
  '2bee6f1b-7184-4e22-8f3e-0744efaed258',
  'Renderer Defaults Sender',
  'Renderer Defaults Sender',
  false,
  true,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    brand_name = EXCLUDED.brand_name,
    status = EXCLUDED.status,
    updated_at = now();

SELECT public.bootstrap_tenant_onboarding_v1(
  '2bee6f1b-7184-4e22-8f3e-0744efaed257',
  'pgtap:renderer-defaults-tenant-fixture-bootstrap'
);

WITH version_ins AS (
  UPDATE settings_versions
  SET value = '{"fallback_title":"Tenant Renderer","primary_color":"#0D3A74"}'::jsonb,
      change_reason = 'pgtap tenant renderer_defaults fixture',
      approved_at = COALESCE(approved_at, now()),
      effective_from = COALESCE(effective_from, now())
  WHERE category = 'renderer_defaults'
    AND scope_type = 'tenant'
    AND scope_hash = '2bee6f1b-7184-4e22-8f3e-0744efaed257'
    AND effective_until IS NULL
    AND approved_at IS NOT NULL
  RETURNING id, scope_id, scope_hash, value
),
settings_ins AS (
  INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    gen_random_uuid(),
    'renderer_defaults',
    'tenant',
    version_ins.scope_id,
    version_ins.scope_hash,
    version_ins.id,
    version_ins.value,
    now()
  FROM version_ins
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated
  RETURNING scope_id
)
SELECT is(
  (
    SELECT resolve_settings('renderer_defaults', 'tenant', settings_ins.scope_id)
    FROM settings_ins
    LIMIT 1
  ),
  '{"fallback_title":"Tenant Renderer","primary_color":"#0D3A74"}'::jsonb,
  'Tenant renderer_defaults override is applied from transactional fixture'
);

SELECT * FROM finish();

ROLLBACK;

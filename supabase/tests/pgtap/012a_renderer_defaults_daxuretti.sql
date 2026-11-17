-- Test Suite: renderer_defaults tenant override (transactional fixture)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

WITH org_seed AS (
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (
    gen_random_uuid(),
    'Renderer Defaults Tenant',
    format('renderer-defaults-%s', substr(gen_random_uuid()::text, 1, 8)),
    'Asia/Riyadh',
    'en-US',
    'active'
  )
  RETURNING id
),
version_ins AS (
  INSERT INTO settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    gen_random_uuid(),
    'renderer_defaults',
    'tenant',
    org_seed.id,
    org_seed.id,
    1,
    '{"fallback_title":"Tenant Renderer","primary_color":"#0D3A74"}'::jsonb,
    'pgtap tenant renderer_defaults fixture',
    now(),
    now()
  FROM org_seed
  RETURNING id, scope_id
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
    version_ins.scope_id,
    version_ins.id,
    '{"fallback_title":"Tenant Renderer","primary_color":"#0D3A74"}'::jsonb,
    now()
  FROM version_ins
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

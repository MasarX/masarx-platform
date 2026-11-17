-- Test Suite: renderer_defaults settings resolution

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- 1) Global should exist (seeded by migration) and return a value
SELECT ok(
  resolve_settings('renderer_defaults', 'global', NULL) IS NOT NULL,
  'Global renderer_defaults returns a value'
);

-- 2) Tenant falls back to global when not set
SELECT ok(
  resolve_settings('renderer_defaults', 'tenant', 'aaaaaaaa-0000-0000-0000-00000000abcd'::uuid) IS NOT NULL,
  'Tenant renderer_defaults falls back to global when unset'
);

-- 3) Tenant override wins over global
WITH ins AS (
  INSERT INTO settings_versions (
    category, scope_type, scope_id, version, value, approved_at
  ) VALUES (
    'renderer_defaults', 'tenant', 'aaaaaaaa-0000-0000-0000-00000000abce'::uuid, 1,
    '{"fallback_title":"Tenant Brand","primary_color":"#123456"}'::jsonb,
    now()
  )
  RETURNING id
)
INSERT INTO settings (
  category, scope_type, scope_id, settings_version_id, cached_value, last_updated
)
SELECT 'renderer_defaults', 'tenant', 'aaaaaaaa-0000-0000-0000-00000000abce'::uuid, id,
       '{"fallback_title":"Tenant Brand","primary_color":"#123456"}'::jsonb, now()
FROM ins;

SELECT is(
  resolve_settings('renderer_defaults', 'tenant', 'aaaaaaaa-0000-0000-0000-00000000abce'::uuid),
  '{"fallback_title":"Tenant Brand","primary_color":"#123456"}'::jsonb,
  'Tenant-specific renderer_defaults override is returned'
);

SELECT finish();

ROLLBACK;


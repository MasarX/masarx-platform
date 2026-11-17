-- Test Suite: tracking_policy basics and generator output

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- 1) tracking_policy in schema_registry
SELECT ok(
  EXISTS (
    SELECT 1 FROM schema_registry WHERE category = 'tracking_policy' AND version = 1 AND is_active = true
  ),
  'tracking_policy.v1 registered in schema_registry'
);

-- 2) Global settings seeded
SELECT ok(
  EXISTS (
    SELECT 1 FROM settings WHERE category = 'tracking_policy' AND scope_type = 'global' AND scope_id IS NULL
  ),
  'Global tracking_policy settings exist'
);

-- 3) shipments has tracking_upper STORED column
SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shipments' AND column_name = 'tracking_upper'
  ),
  'shipments.tracking_upper column exists'
);

-- 4) generator returns uppercase base string under default policy
SELECT matches(
  (
    SELECT generate_tracking_number('tenant', NULL, (SELECT cached_value FROM settings WHERE category='tracking_policy' AND scope_type='global' AND scope_id IS NULL))
  ),
  '^[A-Z0-9-]+$'::text,
  'generate_tracking_number returns uppercase alphanumerics'::text
);

SELECT * FROM finish();

ROLLBACK;

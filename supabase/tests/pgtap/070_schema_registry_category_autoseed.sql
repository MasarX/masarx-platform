-- Test: schema_registry inserts auto-seed settings_category_registry
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- schema_registry is migration/admin-owned; this test exercises the auto-seed
-- trigger without granting runtime service roles direct registry writes.

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'pgtap_schema_registry_autoseed_test'
  ),
  'precondition: category not present in settings_category_registry'
);

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'pgtap_schema_registry_autoseed_test',
  1,
  '{"type":"object","additionalProperties":true}'::jsonb,
  'pgTAP: exercise schema_registry -> settings_category_registry auto-seed trigger',
  '[]'::jsonb,
  TRUE
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'pgtap_schema_registry_autoseed_test'
  ),
  'schema_registry write auto-seeds settings_category_registry row'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'pgtap_schema_registry_autoseed_test'
      AND version = 1
      AND is_active = TRUE
  ),
  'schema_registry row inserted successfully under FK enforcement'
);

SELECT finish();

ROLLBACK;

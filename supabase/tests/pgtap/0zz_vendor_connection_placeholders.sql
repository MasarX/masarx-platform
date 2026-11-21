BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SET LOCAL pgtap.vendor_company_id = '999999';
SET LOCAL pgtap.vendor_base_url = 'https://vendor.example.invalid';

SELECT is(
  (SELECT array_agg(DISTINCT metadata->>'company_id')
     FROM public.providers WHERE name = 'logestechs_3pl'),
  ARRAY[current_setting('pgtap.vendor_company_id')],
  'vendor providers have a synthetic company id by default'
);

SELECT is(
  (SELECT array_agg(DISTINCT metadata->>'base_url')
     FROM public.providers WHERE name = 'logestechs_3pl'),
  ARRAY[current_setting('pgtap.vendor_base_url')],
  'vendor providers have a reserved example base URL by default'
);

SELECT is(
  (SELECT array_agg(DISTINCT operation.url_template)
     FROM public.operation_templates AS operation
     JOIN public.providers AS provider ON provider.id = operation.provider_id
    WHERE provider.name = 'logestechs_3pl'
      AND operation.operation_name = 'logestechs_create_shipment_v1'),
  ARRAY[current_setting('pgtap.vendor_base_url') || '/api/v2/shipments'],
  'the seeded vendor operation uses the reserved example base URL'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings AS setting
      JOIN public.settings_versions_p0 AS version
        ON version.id = setting.settings_version_id AND version.scope_hash = setting.scope_hash
     WHERE setting.category = 'logestechs_v2_account'
       AND setting.scope_type = 'global'
       AND version.value->>'company_id' = current_setting('pgtap.vendor_company_id')
       AND setting.cached_value->>'company_id' = current_setting('pgtap.vendor_company_id')
  ),
  'the seeded global account version and its cached setting use the synthetic id'
);

SELECT public.ensure_provider_account_settings_category_v1('logestechs_v2_account');

SELECT is(
  (SELECT array_agg(DISTINCT example.value->>'company_id')
     FROM public.schema_registry AS registry
    CROSS JOIN LATERAL jsonb_array_elements(registry.examples) AS example(value)
    WHERE registry.category = 'logestechs_v2_account' AND registry.version = 1),
  ARRAY[current_setting('pgtap.vendor_company_id')],
  'provider-account schema registration generates synthetic ids in examples'
);

SELECT * FROM finish();
ROLLBACK;

-- Test Suite: Short-code registry writes only on reverse geocode
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);
SET search_path TO public, pgtap, extensions;

-- Fixture: org/client/sender/address
INSERT INTO public.organizations (id, name, slug)
VALUES ('08200000-0000-0000-0000-000000000001', 'PGTAP Geo Org 082', 'pgtap-geo-082')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '08200000-0000-0000-0000-000000000002',
  '08200000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 082',
  'pgtap-geo-client-082'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '08200000-0000-0000-0000-000000000003',
  '08200000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 082',
  'PGTAP Geo Sender 082'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  '99990000-0000-0000-0000-000000400001',
  'pgtap_geo_registry_082',
  'Fixture workflow for short-code registry tests',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
)
VALUES (
  '99990000-0000-0000-0000-000000000002',
  '99990000-0000-0000-0000-000000400001',
  1,
  'cache_write',
  'always',
  'geocode_cache',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  line1,
  city,
  province,
  country,
  validation_status,
  sa_short_code,
  created_at,
  updated_at
) VALUES (
  '08200000-0000-0000-0000-000000000004',
  '08200000-0000-0000-0000-000000000001',
  '08200000-0000-0000-0000-000000000002',
  '{"line1":"TEST0001","country":"SA"}',
  'TEST0001',
  'Riyadh',
  'Riyadh',
  'SA',
  'pending',
  'TEST0001',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

-- Non-reverse run: registry write should be skipped.
SELECT set_config('app.workflow_run_id', '08200000-0000-0000-0000-000000000010', true);
INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '08200000-0000-0000-0000-000000000010',
  '99990000-0000-0000-0000-000000400001',
  1,
  'pgtap',
  'in_progress',
  jsonb_build_object(
    'organization_id', '08200000-0000-0000-0000-000000000001',
    'client_id', '08200000-0000-0000-0000-000000000002',
    'sender_id', '08200000-0000-0000-0000-000000000003',
    'address_id', '08200000-0000-0000-0000-000000000004',
    'geocoding', jsonb_build_object(
      'short_code', 'TEST0001',
      'reverse_geocode', false
    )
  )
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', '08200000-0000-0000-0000-000000000011', true);
INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
) VALUES (
  '08200000-0000-0000-0000-000000000011',
  '08200000-0000-0000-0000-000000000010',
  '99990000-0000-0000-0000-000000000002',
  1,
  'pending',
  'cache_write',
  'geocode_cache',
  'v1',
  1,
  jsonb_build_object('action', 'write'),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT workflow_handlers.execute_geocode_cache_v1_base(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '08200000-0000-0000-0000-000000000011'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '08200000-0000-0000-0000-000000000010'),
  jsonb_build_object(
    'geocode',
    jsonb_build_object(
      'provider_name', 'here_geocoding',
      'coordinates', jsonb_build_object('latitude', 24.7, 'longitude', 46.7),
      'formatted_address', 'Test Address',
      'metadata', jsonb_build_object(
        'parsed', jsonb_build_object(
          'street', 'Test Street',
          'city', 'Riyadh',
          'country_code', 'SA'
        )
      )
    )
  )
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.address_code_registry
    WHERE code_value = 'TEST0001'
      AND code_type = 'sa_short_code'
  ),
  0,
  'short-code registry not written when reverse_geocode is false'
);

-- Reverse run: registry write should succeed.
SELECT set_config('app.workflow_run_id', '08200000-0000-0000-0000-000000000020', true);
INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '08200000-0000-0000-0000-000000000020',
  '99990000-0000-0000-0000-000000400001',
  1,
  'pgtap',
  'in_progress',
  jsonb_build_object(
    'organization_id', '08200000-0000-0000-0000-000000000001',
    'client_id', '08200000-0000-0000-0000-000000000002',
    'sender_id', '08200000-0000-0000-0000-000000000003',
    'address_id', '08200000-0000-0000-0000-000000000004',
    'geocoding', jsonb_build_object(
      'short_code', 'TEST0001',
      'reverse_geocode', true
    )
  )
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', '08200000-0000-0000-0000-000000000021', true);
INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
) VALUES (
  '08200000-0000-0000-0000-000000000021',
  '08200000-0000-0000-0000-000000000020',
  '99990000-0000-0000-0000-000000000002',
  1,
  'pending',
  'cache_write',
  'geocode_cache',
  'v1',
  1,
  jsonb_build_object('action', 'write'),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT workflow_handlers.execute_geocode_cache_v1_base(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '08200000-0000-0000-0000-000000000021'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '08200000-0000-0000-0000-000000000020'),
  jsonb_build_object(
    'geocode',
    jsonb_build_object(
      'provider_name', 'here_geocoding',
      'coordinates', jsonb_build_object('latitude', 24.7, 'longitude', 46.7),
      'formatted_address', 'Test Address',
      'metadata', jsonb_build_object(
        'parsed', jsonb_build_object(
          'street', 'Test Street',
          'city', 'Riyadh',
          'country_code', 'SA'
        )
      )
    )
  )
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.address_code_registry
    WHERE code_value = 'TEST0001'
      AND code_type = 'sa_short_code'
  ),
  1,
  'short-code registry written when reverse_geocode is true'
);

SELECT * FROM finish();
ROLLBACK;

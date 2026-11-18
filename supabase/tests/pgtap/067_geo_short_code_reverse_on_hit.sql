-- Test Suite: Short-code registry reverse geocode on hit
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SET search_path TO public, pgtap, extensions;

-- -----------------------------------------------------------------------------
-- Fixture data
-- -----------------------------------------------------------------------------
-- This fixture owns source-binding setup, so defer bootstrap until client/sender
-- context exists and fail-closed plugin activation has truthful binding inputs.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO public.organizations (id, name, slug)
VALUES ('06700000-0000-0000-0000-000000000001', 'PGTAP Geo Org 067', 'pgtap-geo-067')
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  '06700000-0000-0000-0000-000000000002',
  '06700000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 067',
  'pgtap-geo-client-067',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES (
  '06700000-0000-0000-0000-000000000003',
  '06700000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 067',
  'PGTAP Geo Sender 067',
  TRUE,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
  '06700000-0000-0000-0000-000000000001',
  'pgtap:geo-short-code-reverse-fixture-bootstrap'
);

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  line1,
  normalized_line1,
  district,
  city,
  province,
  postal_code,
  country,
  validation_status,
  sa_short_code,
  created_at,
  updated_at
) VALUES (
  '06700000-0000-0000-0000-000000000004',
  '06700000-0000-0000-0000-000000000001',
  '06700000-0000-0000-0000-000000000002',
  '{"line1":"ABCD1234","country":"SA"}',
  'ABCD1234',
  NULL,
  NULL,
  'Riyadh',
  'Riyadh',
  NULL,
  'SA',
  'pending',
  'ABCD1234',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

INSERT INTO public.address_code_registry (
  country_code,
  code_type,
  code_value,
  coordinates,
  formatted_address,
  provider_name,
  confidence_score,
  accuracy_type,
  resolved_at,
  created_at,
  updated_at
) VALUES (
  'SA',
  'sa_short_code',
  'ABCD1234',
  ST_SetSRID(ST_MakePoint(46.7, 24.7), 4326)::geography,
  'Test Address 067',
  'short_code_registry',
  0.99,
  'short_code_registry',
  now(),
  now(),
  now()
)
ON CONFLICT (country_code, code_type, code_value) DO NOTHING;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
) VALUES (
  '06700000-0000-0000-0000-000000000005',
  'pgtap_geo_short_code_067',
  'PGTAP short code reverse geocode test',
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
) VALUES (
  '06700000-0000-0000-0000-000000000006',
  '06700000-0000-0000-0000-000000000005',
  1,
  'short_code_lookup',
  'always',
  'geo_short_code_registry',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '06700000-0000-0000-0000-000000000007', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '06700000-0000-0000-0000-000000000007',
  '06700000-0000-0000-0000-000000000005',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '06700000-0000-0000-0000-000000000001',
    'client_id', '06700000-0000-0000-0000-000000000002',
    'sender_id', '06700000-0000-0000-0000-000000000003',
    'address_id', '06700000-0000-0000-0000-000000000004'
  )
)
ON CONFLICT (id) DO NOTHING;

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
  enqueued_at,
  created_at,
  updated_at
) VALUES (
  '06700000-0000-0000-0000-000000000008',
  '06700000-0000-0000-0000-000000000007',
  '06700000-0000-0000-0000-000000000006',
  1,
  'pending',
  'short_code_lookup',
  'geo_short_code_registry',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

WITH policy AS (
  SELECT jsonb_build_object(
    'matching_plugins', jsonb_build_array(
      jsonb_build_object(
        'name', 'short_code',
        'enabled', TRUE,
        'params', jsonb_build_object(
          'reverse_geocode_on_hit', TRUE,
          'code_type', 'sa_short_code',
          'country', 'SA',
          'code_regex', '^[A-Z]{4}[0-9]{4}$',
          'hydrate_address', TRUE,
          'confidence', 0.99
        )
      )
    )
  ) AS value
), settings_version AS (
  SELECT *
  FROM public.upsert_settings_value_v1(
    'geocoding_policy',
    'sender',
    '06700000-0000-0000-0000-000000000003'::uuid,
    (SELECT value FROM policy),
    1,
    'pgtap: 067_geo_short_code_reverse_on_hit policy seed'
  )
)
SELECT 1 FROM settings_version;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'geocoding_policy:%';

CREATE TEMP TABLE tmp_short_code_reverse AS
SELECT workflow_handlers.execute_geo_short_code_registry_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '06700000-0000-0000-0000-000000000008'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '06700000-0000-0000-0000-000000000007'),
  '{}'::jsonb
) AS resp;

-- -----------------------------------------------------------------------------
-- Assertions
-- -----------------------------------------------------------------------------
SELECT ok(
  COALESCE((SELECT (((resp).context_patch->'geocoding'->>'reverse_geocode')::boolean) FROM tmp_short_code_reverse), FALSE),
  'short_code registry reverse sets reverse_geocode'
);

SELECT ok(
  (SELECT (resp).context_patch->'geocoding' ? 'provided_coordinates' FROM tmp_short_code_reverse),
  'short_code registry reverse includes provided_coordinates'
);

SELECT ok(
  NOT (SELECT (resp).context_patch->'geocoding' ? 'successful' FROM tmp_short_code_reverse),
  'short_code registry reverse does not mark geocoding successful'
);

SELECT is(
  (SELECT (resp).operation_result->>'matched' FROM tmp_short_code_reverse),
  'true',
  'short_code registry hit reports matched'
);

SELECT finish();

ROLLBACK;

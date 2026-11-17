-- Test Suite: Coordinate handler skips reverse_local for short-codes
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SET search_path TO public, pgtap, extensions;

-- -----------------------------------------------------------------------------
-- Fixture data
-- -----------------------------------------------------------------------------
INSERT INTO public.organizations (id, name, slug)
VALUES ('07600000-0000-0000-0000-000000000001', 'PGTAP Geo Org 076', 'pgtap-geo-076')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '07600000-0000-0000-0000-000000000002',
  '07600000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 076',
  'pgtap-geo-client-076'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '07600000-0000-0000-0000-000000000003',
  '07600000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 076',
  'PGTAP Geo Sender 076'
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
  '07600000-0000-0000-0000-000000000004',
  '07600000-0000-0000-0000-000000000001',
  '07600000-0000-0000-0000-000000000002',
  '{"line1":"ABCD1234","country":"SA"}',
  'ABCD1234',
  'Riyadh',
  'Riyadh',
  'SA',
  'pending',
  'ABCD1234',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
) VALUES (
  '07600000-0000-0000-0000-000000000005',
  'pgtap_geo_coordinate_076',
  'PGTAP coordinate skip reverse_local for short-code',
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
  '07600000-0000-0000-0000-000000000006',
  '07600000-0000-0000-0000-000000000005',
  1,
  'validate_coordinates',
  'always',
  'geo_coordinate',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '07600000-0000-0000-0000-000000000007', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '07600000-0000-0000-0000-000000000007',
  '07600000-0000-0000-0000-000000000005',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '07600000-0000-0000-0000-000000000001',
    'client_id', '07600000-0000-0000-0000-000000000002',
    'sender_id', '07600000-0000-0000-0000-000000000003',
    'address_id', '07600000-0000-0000-0000-000000000004',
    'shipment', jsonb_build_object(
      'coordinates', jsonb_build_object('latitude', 24.7, 'longitude', 46.7)
    ),
    'geocoding', jsonb_build_object(
      'short_code', 'ABCD1234'
    )
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
  '07600000-0000-0000-0000-000000000008',
  '07600000-0000-0000-0000-000000000007',
  '07600000-0000-0000-0000-000000000006',
  1,
  'pending',
  'validate_coordinates',
  'geo_coordinate',
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
        'name', 'reverse',
        'enabled', TRUE
      ),
      jsonb_build_object(
        'name', 'reverse_local',
        'enabled', TRUE,
        'params', jsonb_build_object(
          'skip_when_short_code', TRUE,
          'confidence', 0.99
        )
      )
    )
  ) AS value
),
settings_version AS (
  SELECT *
  FROM public.upsert_settings_value_v1(
    'geocoding_policy',
    'sender',
    '07600000-0000-0000-0000-000000000003'::uuid,
    (SELECT value FROM policy),
    1,
    'pgtap: 076_geo_coordinate_skip_reverse_local_short_code policy seed'
  )
)
SELECT 1 FROM settings_version;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'geocoding_policy:%';

CREATE TEMP TABLE tmp_geo_coordinate_076 AS
SELECT workflow_handlers.execute_geo_coordinate_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '07600000-0000-0000-0000-000000000008'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '07600000-0000-0000-0000-000000000007'),
  '{}'::jsonb
) AS resp;

-- Second run: omit geocoding.short_code and intentionally mismatch client_id in context.
-- Short-code presence should still be detected from the persisted address row.

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '07600000-0000-0000-0000-00000000000A',
  '07600000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 076 (mismatch)',
  'pgtap-geo-client-076-mismatch'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '07600000-0000-0000-0000-00000000000B',
  '07600000-0000-0000-0000-00000000000A',
  'PGTAP Geo Sender 076 (mismatch)',
  'PGTAP Geo Sender 076 (mismatch)'
)
ON CONFLICT (id) DO NOTHING;

-- Mutate the existing workflow run context (guardrails-safe because app.workflow_run_id stays aligned)
-- to simulate the mismatched client_id case.
UPDATE public.workflow_runs
SET context = jsonb_set(
  jsonb_set(
    (context #- '{geocoding,short_code}'),
    '{client_id}',
    to_jsonb('07600000-0000-0000-0000-00000000000A'::text),
    true
  ),
  '{sender_id}',
  to_jsonb('07600000-0000-0000-0000-00000000000B'::text),
  true
)
WHERE id = '07600000-0000-0000-0000-000000000007';

CREATE TEMP TABLE tmp_geo_coordinate_076_mismatch AS
SELECT workflow_handlers.execute_geo_coordinate_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '07600000-0000-0000-0000-000000000008'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '07600000-0000-0000-0000-000000000007'),
  '{}'::jsonb
) AS resp;

-- -----------------------------------------------------------------------------
-- Assertions
-- -----------------------------------------------------------------------------
SELECT is(
  (SELECT (resp).operation_result->>'short_code_present' FROM tmp_geo_coordinate_076),
  'true',
  'coordinate handler detects short_code'
);

SELECT is(
  (SELECT (resp).operation_result->>'skip_local_when_short_code' FROM tmp_geo_coordinate_076),
  'true',
  'coordinate handler applies skip_when_short_code policy'
);

SELECT ok(
  COALESCE((SELECT (((resp).context_patch->'geocoding'->>'reverse_geocode')::boolean) FROM tmp_geo_coordinate_076), FALSE),
  'coordinate handler sets reverse_geocode when skipping reverse_local'
);

SELECT ok(
  (SELECT (resp).operation_result->'local_reverse_match' IS NULL FROM tmp_geo_coordinate_076),
  'coordinate handler does not emit local_reverse_match when skipped'
);

SELECT is(
  (SELECT (resp).operation_result->>'short_code_present' FROM tmp_geo_coordinate_076_mismatch),
  'true',
  'coordinate handler detects short_code from persisted address even when client_id mismatched'
);

SELECT ok(
  COALESCE((SELECT (((resp).context_patch->'geocoding'->>'reverse_geocode')::boolean) FROM tmp_geo_coordinate_076_mismatch), FALSE),
  'coordinate handler sets reverse_geocode when skipping reverse_local (mismatched client)'
);

SELECT finish();

ROLLBACK;

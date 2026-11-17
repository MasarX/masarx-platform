-- Test Suite: Local lookup skips short-code when policy enabled
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);
SET search_path TO pg_temp, public, extensions, pgtap;

CREATE OR REPLACE FUNCTION pg_temp._todo()
RETURNS text
LANGUAGE sql
AS $$
  SELECT NULL::text;
$$;

-- -----------------------------------------------------------------------------
-- Fixture data
-- -----------------------------------------------------------------------------
INSERT INTO public.organizations (id, name, slug)
VALUES ('08400000-0000-0000-0000-000000000001', 'PGTAP Geo Org 084', 'pgtap-geo-084')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '08400000-0000-0000-0000-000000000002',
  '08400000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 084',
  'pgtap-geo-client-084'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '08400000-0000-0000-0000-000000000003',
  '08400000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 084',
  'PGTAP Geo Sender 084'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  line1,
  normalized_line1,
  city,
  province,
  country,
  validation_status,
  sa_short_code,
  created_at,
  updated_at
) VALUES (
  '08400000-0000-0000-0000-000000000004',
  '08400000-0000-0000-0000-000000000001',
  '08400000-0000-0000-0000-000000000002',
  '{"line1":"ABCD1234","country":"SA","short_code":"ABCD1234","sa_short_code":"ABCD1234"}',
  'ABCD1234',
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
  '08400000-0000-0000-0000-000000000005',
  'pgtap_geo_local_lookup_084',
  'PGTAP local lookup skip short-code',
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
  '08400000-0000-0000-0000-000000000006',
  '08400000-0000-0000-0000-000000000005',
  1,
  'local_lookup',
  'always',
  'geo_local_lookup',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '08400000-0000-0000-0000-000000000007', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '08400000-0000-0000-0000-000000000007',
  '08400000-0000-0000-0000-000000000005',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '08400000-0000-0000-0000-000000000001',
    'client_id', '08400000-0000-0000-0000-000000000002',
    'sender_id', '08400000-0000-0000-0000-000000000003',
    'address_id', '08400000-0000-0000-0000-000000000004',
    'geocoding', jsonb_build_object('short_code', 'ABCD1234')
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
  '08400000-0000-0000-0000-000000000008',
  '08400000-0000-0000-0000-000000000007',
  '08400000-0000-0000-0000-000000000006',
  1,
  'pending',
  'local_lookup',
  'geo_local_lookup',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

WITH policy AS (
  SELECT jsonb_build_object(
    'local_lookup', jsonb_build_object(
      'enabled', TRUE,
      'skip_when_short_code', TRUE
    ),
    'matching_plugins', jsonb_build_array(
      jsonb_build_object('name', 'perfect', 'enabled', TRUE),
      jsonb_build_object('name', 'fuzzy', 'enabled', TRUE),
      jsonb_build_object('name', 'short_code', 'enabled', TRUE, 'params', jsonb_build_object(
        'code_regex', '^[A-Z]{4}[0-9]{4}$'
      ))
    )
  ) AS value
),
settings_version AS (
  SELECT *
  FROM public.upsert_settings_value_v1(
    'geocoding_policy',
    'sender',
    '08400000-0000-0000-0000-000000000003'::uuid,
    (SELECT value FROM policy),
    1,
    'pgtap: 084_geo_local_lookup_skip_short_code policy seed'
  )
)
SELECT 1 FROM settings_version;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'geocoding_policy:%';

CREATE TEMP TABLE tmp_geo_local_lookup_084 AS
SELECT workflow_handlers.execute_geo_local_lookup_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '08400000-0000-0000-0000-000000000008'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '08400000-0000-0000-0000-000000000007'),
  '{}'::jsonb
) AS resp;

SET search_path TO pg_temp, public, extensions, pgtap;

SELECT extensions.ok(
  (SELECT to_jsonb(resp)->'operation_result'->>'reason' FROM tmp_geo_local_lookup_084) = 'local_lookup_skipped_short_code',
  'local lookup skips when short code present'::text
);

SELECT extensions.ok(
  (SELECT (to_jsonb(resp)->'operation_result'->>'matched')::boolean FROM tmp_geo_local_lookup_084) = false,
  'local lookup returns matched=false on short code skip'::text
);

SELECT extensions.ok(
  (SELECT to_jsonb(resp)->'context_patch'->'geocoding'->>'short_code' FROM tmp_geo_local_lookup_084) = 'ABCD1234',
  'short code persisted in context patch'::text
);

SELECT * FROM finish();
ROLLBACK;

-- Test Suite: Geo decision fail-fast for short-code reverse errors
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);
SET search_path TO public, pgtap, extensions;

-- ---------------------------------------------------------------------------
-- Fixture data
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name, slug)
VALUES ('07900000-0000-0000-0000-000000000001', 'PGTAP Geo Org 079', 'pgtap-geo-079')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '07900000-0000-0000-0000-000000000002',
  '07900000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 079',
  'pgtap-geo-client-079'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '07900000-0000-0000-0000-000000000003',
  '07900000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 079',
  'PGTAP Geo Sender 079'
)
ON CONFLICT (id) DO NOTHING;

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
  '07900000-0000-0000-0000-000000000004',
  '07900000-0000-0000-0000-000000000001',
  '07900000-0000-0000-0000-000000000002',
  'TEST0000',
  'TEST0000',
  NULL,
  NULL,
  'Example City',
  'Example City',
  NULL,
  'SA',
  'pending',
  'TEST0000',
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
  '07900000-0000-0000-0000-000000000005',
  'pgtap_geo_decision_079',
  'PGTAP geo decision fail-fast test',
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
  '07900000-0000-0000-0000-000000000010',
  '07900000-0000-0000-0000-000000000005',
  1,
  'evaluate_result',
  'always',
  'geo_decision',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '07900000-0000-0000-0000-000000000006', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '07900000-0000-0000-0000-000000000006',
  '07900000-0000-0000-0000-000000000005',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '07900000-0000-0000-0000-000000000001',
    'client_id', '07900000-0000-0000-0000-000000000002',
    'sender_id', '07900000-0000-0000-0000-000000000003',
    'address_id', '07900000-0000-0000-0000-000000000004',
    'geocoding', jsonb_build_object('short_code', 'TEST0000')
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
  '07900000-0000-0000-0000-000000000007',
  '07900000-0000-0000-0000-000000000006',
  '07900000-0000-0000-0000-000000000010',
  1,
  'pending',
  'evaluate_result',
  'geo_decision',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.geocoding_attempts (
  organization_id,
  client_id,
  sender_id,
  address_id,
  workflow_run_step_id,
  provider_name,
  attempt_order,
  attempt_type,
  status,
  confidence,
  metadata,
  created_at,
  updated_at
) VALUES (
  '07900000-0000-0000-0000-000000000001',
  '07900000-0000-0000-0000-000000000002',
  '07900000-0000-0000-0000-000000000003',
  '07900000-0000-0000-0000-000000000004',
  '07900000-0000-0000-0000-000000000007',
  'here_geocoding',
  1,
  'primary',
  'failed',
  NULL,
  jsonb_build_object('response_status_code', 500),
  now(),
  now()
);

WITH base AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS policy
),
patched AS (
  SELECT jsonb_set(
    policy,
    '{matching_plugins}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN lower(elem->>'name') = 'short_code' THEN
            jsonb_set(
              COALESCE(elem, '{}'::jsonb),
              '{params,fail_on_reverse_error}',
              'true'::jsonb,
              TRUE
            )
          ELSE elem
        END
        ORDER BY ordinality
      )
      FROM jsonb_array_elements(COALESCE(policy->'matching_plugins', '[]'::jsonb)) WITH ORDINALITY AS a(elem, ordinality)
    ),
    TRUE
  ) AS value
  FROM base
),
settings_version AS (
  SELECT *
  FROM public.upsert_settings_value_v1(
    'geocoding_policy',
    'sender',
    '07900000-0000-0000-0000-000000000003'::uuid,
    (SELECT value FROM patched),
    1,
    'pgtap: 079_geo_decision_fail_fast_short_code policy seed'
  )
)
SELECT 1 FROM settings_version;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'geocoding_policy:%';

CREATE TEMP TABLE tmp_geo_decision_fail_fast AS
SELECT workflow_handlers.execute_geo_decision_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '07900000-0000-0000-0000-000000000007'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '07900000-0000-0000-0000-000000000006'),
  '{}'::jsonb
) AS resp;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
SET search_path TO extensions, public, pgtap;

SELECT extensions.ok(
  (SELECT (resp).status FROM tmp_geo_decision_fail_fast) = 'failed',
  'geo_decision fails fast when short-code reverse provider errors'
);

SELECT extensions.ok(
  (SELECT (resp).workflow_status FROM tmp_geo_decision_fail_fast) = 'failed',
  'geo_decision propagates workflow_status failed on short-code error'
);

SELECT extensions.ok(
  (SELECT (resp).last_error FROM tmp_geo_decision_fail_fast) = 'short_code_reverse_failed',
  'geo_decision surfaces short_code_reverse_failed'
);

SELECT finish();

ROLLBACK;

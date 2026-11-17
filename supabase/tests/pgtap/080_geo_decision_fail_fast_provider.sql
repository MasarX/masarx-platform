-- Test Suite: Geo decision fail-fast for provider errors
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);
SET search_path TO public, pgtap, extensions;

-- ---------------------------------------------------------------------------
-- Fixture data
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name, slug)
VALUES ('08000000-0000-0000-0000-000000000001', 'PGTAP Geo Org 080', 'pgtap-geo-080')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '08000000-0000-0000-0000-000000000002',
  '08000000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 080',
  'pgtap-geo-client-080'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '08000000-0000-0000-0000-000000000003',
  '08000000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 080',
  'PGTAP Geo Sender 080'
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
  created_at,
  updated_at
) VALUES (
  '08000000-0000-0000-0000-000000000004',
  '08000000-0000-0000-0000-000000000001',
  '08000000-0000-0000-0000-000000000002',
  '{"line1":"Test address","country":"SA"}',
  'Test address',
  NULL,
  NULL,
  'Riyadh',
  'Riyadh',
  NULL,
  'SA',
  'pending',
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
  '08000000-0000-0000-0000-000000000005',
  'pgtap_geo_decision_080',
  'PGTAP geo decision provider fail-fast test',
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
  '08000000-0000-0000-0000-000000000010',
  '08000000-0000-0000-0000-000000000005',
  1,
  'evaluate_result',
  'always',
  'geo_decision',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '08000000-0000-0000-0000-000000000006', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '08000000-0000-0000-0000-000000000006',
  '08000000-0000-0000-0000-000000000005',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '08000000-0000-0000-0000-000000000001',
    'client_id', '08000000-0000-0000-0000-000000000002',
    'sender_id', '08000000-0000-0000-0000-000000000003',
    'address_id', '08000000-0000-0000-0000-000000000004'
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
  '08000000-0000-0000-0000-000000000007',
  '08000000-0000-0000-0000-000000000006',
  '08000000-0000-0000-0000-000000000010',
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
  '08000000-0000-0000-0000-000000000001',
  '08000000-0000-0000-0000-000000000002',
  '08000000-0000-0000-0000-000000000003',
  '08000000-0000-0000-0000-000000000004',
  '08000000-0000-0000-0000-000000000007',
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
    '{provider_error}',
    jsonb_build_object(
      'fail_fast', true,
      'provider_names', jsonb_build_array('here_geocoding')
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
    '08000000-0000-0000-0000-000000000003'::uuid,
    (SELECT value FROM patched),
    1,
    'pgtap: 080_geo_decision_fail_fast_provider policy seed'
  )
)
SELECT 1 FROM settings_version;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'geocoding_policy:%';

CREATE TEMP TABLE tmp_geo_decision_fail_fast_provider AS
SELECT workflow_handlers.execute_geo_decision_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '08000000-0000-0000-0000-000000000007'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '08000000-0000-0000-0000-000000000006'),
  '{}'::jsonb
) AS resp;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
SET search_path TO extensions, public, pgtap;

SELECT extensions.ok(
  (SELECT (resp).status FROM tmp_geo_decision_fail_fast_provider) = 'failed',
  'geo_decision fails fast when provider errors and fail_fast enabled'
);

SELECT extensions.ok(
  (SELECT (resp).workflow_status FROM tmp_geo_decision_fail_fast_provider) = 'failed',
  'geo_decision propagates workflow_status failed on provider error'
);

SELECT extensions.ok(
  (SELECT (resp).last_error FROM tmp_geo_decision_fail_fast_provider) = 'provider_failed',
  'geo_decision surfaces provider_failed'
);

SELECT finish();

ROLLBACK;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SET search_path TO public, pgtap, extensions;

CREATE TEMP TABLE tmp_api_gateway_materialize_guard (
  source_id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  route_id UUID,
  mapping_config_id UUID,
  provider_type TEXT,
  source_name TEXT,
  workflow_template_id UUID,
  workflow_template_version INT,
  request_id UUID,
  run_match_id UUID,
  run_mismatch_id UUID,
  step_match_id UUID,
  step_mismatch_id UUID,
  mismatch_org_id UUID,
  mismatch_client_id UUID
);

INSERT INTO tmp_api_gateway_materialize_guard (
  source_id,
  organization_id,
  client_id,
  sender_id,
  route_id,
  mapping_config_id,
  provider_type,
  source_name,
  workflow_template_id,
  workflow_template_version
)
SELECT
  ws.id,
  ws.organization_id,
  s.client_id,
  ws.sender_id,
  r.id,
  ws.mapping_config_id,
  ws.provider_type,
  ws.name,
  wt.id,
  wt.version
FROM public.webhook_sources ws
JOIN public.senders s
  ON s.id = ws.sender_id
JOIN public.api_routes r
  ON r.enabled = TRUE
JOIN public.api_route_packs p
  ON p.id = r.pack_id
JOIN public.workflow_templates wt
  ON wt.name = 'api_gateway_logestechs_v2_create_geocode_first_v1'
 AND wt.status = 'active'
WHERE ws.enabled = TRUE
  AND ws.organization_id IS NOT NULL
  AND s.client_id IS NOT NULL
  AND p.name = 'logestechs_v2_mirror'
  AND upper(r.method) = 'POST'
  AND r.path_template = '/api/ship/request/by-email'
ORDER BY ws.updated_at DESC, r.updated_at DESC, wt.updated_at DESC
LIMIT 1;

SELECT ok(
  EXISTS (SELECT 1 FROM tmp_api_gateway_materialize_guard),
  'materialize guard prereqs present'
);

WITH ins_webhook_source AS (
  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    enabled,
    sender_id
  )
  SELECT
    gen_random_uuid(),
    t.organization_id,
    'pgtap-mat-guard-' || left(gen_random_uuid()::text, 12),
    coalesce(nullif(t.source_name, ''), 'PGTAP Materialize Guard Source'),
    t.provider_type,
    'pgtap-mat-guard-token-' || left(gen_random_uuid()::text, 18),
    t.mapping_config_id,
    TRUE,
    t.sender_id
  FROM tmp_api_gateway_materialize_guard t
  RETURNING id
)
UPDATE tmp_api_gateway_materialize_guard t
SET source_id = ins_webhook_source.id
FROM ins_webhook_source;

INSERT INTO public.organizations (id, name, slug)
VALUES ('07900000-0000-0000-0000-000000000001', 'PGTAP Materialize Guard Org', 'pgtap-mat-guard')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '07900000-0000-0000-0000-000000000002',
  '07900000-0000-0000-0000-000000000001',
  'PGTAP Materialize Guard Client',
  'pgtap-mat-guard-client'
)
ON CONFLICT (id) DO NOTHING;

UPDATE tmp_api_gateway_materialize_guard
SET mismatch_org_id = '07900000-0000-0000-0000-000000000001',
    mismatch_client_id = '07900000-0000-0000-0000-000000000002',
    run_match_id = gen_random_uuid(),
    run_mismatch_id = gen_random_uuid(),
    step_match_id = gen_random_uuid(),
    step_mismatch_id = gen_random_uuid();

WITH ins_request AS (
  INSERT INTO public.api_gateway_requests (
    organization_id,
    client_id,
    sender_id,
    source_id,
    correlation_id,
    route_id,
    settings_resolution_id,
    method,
    path,
    query_string,
    request_headers,
    request_body,
    received_at,
    created_at,
    updated_at
  )
  SELECT
    t.organization_id,
    t.client_id,
    t.sender_id,
    t.source_id,
    gen_random_uuid(),
    t.route_id,
    NULL,
    'POST',
    '/api/ship/request/by-email',
    NULL,
    '{}'::jsonb,
    jsonb_build_object(
      'destinationAddress', jsonb_build_object(
        'addressLine1', 'RAW_LINE1',
        'addressLine2', 'RAW_LINE2',
        'city', 'Riyadh',
        'region', 'Riyadh',
        'country', 'SA',
        'zipCode', '00000'
      )
    ),
    now(),
    now(),
    now()
  FROM tmp_api_gateway_materialize_guard t
  RETURNING id
)
UPDATE tmp_api_gateway_materialize_guard t
SET request_id = ins_request.id
FROM ins_request;

SELECT set_config(
  'app.workflow_run_id',
  (SELECT run_match_id::text FROM tmp_api_gateway_materialize_guard LIMIT 1),
  true
);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context,
  metadata,
  created_at,
  updated_at
)
SELECT
  t.run_match_id,
  t.workflow_template_id,
  t.workflow_template_version,
  'api',
  'in_progress',
  jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', t.run_match_id,
    'organization_id', t.organization_id,
    'client_id', t.client_id,
    'sender_id', t.sender_id,
    'source_id', t.source_id,
    'api_gateway', jsonb_build_object(
      'api_gateway_request_id', t.request_id
    )
  )),
  '{}'::jsonb,
  now(),
  now()
FROM tmp_api_gateway_materialize_guard t;

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  max_retries,
  metadata,
  handler_key,
  handler_version,
  enqueued_at,
  created_at,
  updated_at
)
SELECT
  t.step_match_id,
  t.run_match_id,
  (SELECT id FROM public.workflow_template_steps WHERE workflow_template_id = t.workflow_template_id ORDER BY sequence_order ASC LIMIT 1),
  1,
  'in_progress',
  'materialize_addresses',
  1,
  '{}'::jsonb,
  'api_gateway_materialize_addresses',
  'v1',
  now(),
  now(),
  now()
FROM tmp_api_gateway_materialize_guard t;

SELECT set_config(
  'app.workflow_run_id',
  (SELECT run_mismatch_id::text FROM tmp_api_gateway_materialize_guard LIMIT 1),
  true
);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context,
  metadata,
  created_at,
  updated_at
)
SELECT
  t.run_mismatch_id,
  t.workflow_template_id,
  t.workflow_template_version,
  'api',
  'in_progress',
  jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', t.run_mismatch_id,
    'organization_id', t.mismatch_org_id,
    'client_id', t.mismatch_client_id,
    'sender_id', t.sender_id,
    'source_id', t.source_id,
    'api_gateway', jsonb_build_object(
      'api_gateway_request_id', t.request_id
    )
  )),
  '{}'::jsonb,
  now(),
  now()
FROM tmp_api_gateway_materialize_guard t;

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  max_retries,
  metadata,
  handler_key,
  handler_version,
  enqueued_at,
  created_at,
  updated_at
)
SELECT
  t.step_mismatch_id,
  t.run_mismatch_id,
  (SELECT id FROM public.workflow_template_steps WHERE workflow_template_id = t.workflow_template_id ORDER BY sequence_order ASC LIMIT 1),
  1,
  'in_progress',
  'materialize_addresses',
  1,
  '{}'::jsonb,
  'api_gateway_materialize_addresses',
  'v1',
  now(),
  now(),
  now()
FROM tmp_api_gateway_materialize_guard t;

SELECT lives_ok($$
  SELECT workflow_handlers.execute_api_gateway_materialize_addresses_v1(s, r)
  FROM tmp_api_gateway_materialize_guard t
  JOIN public.workflow_run_steps s ON s.id = t.step_match_id
  JOIN public.workflow_runs r ON r.id = t.run_match_id;
$$, 'materialize ok with matching context');

SELECT throws_ok($$
  SELECT workflow_handlers.execute_api_gateway_materialize_addresses_v1(s, r)
  FROM tmp_api_gateway_materialize_guard t
  JOIN public.workflow_run_steps s ON s.id = t.step_mismatch_id
  JOIN public.workflow_runs r ON r.id = t.run_mismatch_id;
$$, 'P0001', 'api_gateway materialize: request org/client mismatch');

SELECT * FROM finish();

ROLLBACK;

-- Test Suite: API Gateway - Workflow dispatch overrides destination address lines

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

CREATE TEMP TABLE tmp_api_gateway_dispatch_test (
  source_id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  route_id UUID,
  provider_id UUID,
  workflow_template_id UUID,
  workflow_template_version INT,
  request_id UUID,
  address_id UUID,
  run_id UUID,
  step_id UUID,
  outbound_call_id UUID
);

INSERT INTO tmp_api_gateway_dispatch_test (
  source_id,
  organization_id,
  client_id,
  sender_id,
  route_id,
  provider_id,
  workflow_template_id,
  workflow_template_version
)
SELECT
  ws.id,
  ws.organization_id,
  s.client_id,
  ws.sender_id,
  r.id,
  r.provider_id,
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
  EXISTS (SELECT 1 FROM tmp_api_gateway_dispatch_test),
  'test prereqs present (source + route + workflow template)'
);

-- Materialize destination address and apply HERE patch (simulates post-HERE effective lines).
UPDATE tmp_api_gateway_dispatch_test t
SET address_id = NULLIF(
  (workflow_handlers.api_gateway_materialize_address_v1(
    t.organization_id,
    t.client_id,
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
    jsonb_build_object(
      'destination_line1_path', 'destinationAddress.addressLine1',
      'destination_line2_path', 'destinationAddress.addressLine2',
      'destination_city_path', 'destinationAddress.city',
      'destination_province_path', 'destinationAddress.region',
      'destination_country_path', 'destinationAddress.country',
      'destination_postal_path', 'destinationAddress.zipCode'
    ),
    'destination'
  )->>'address_id'),
  ''
)::uuid;

SELECT ok(
  (SELECT address_id IS NOT NULL FROM tmp_api_gateway_dispatch_test LIMIT 1),
  'address materialized'
);

SELECT ok(
  (
    SELECT public.apply_address_patch_v1(
      t.address_id,
      t.client_id,
      t.organization_id,
      'here_reverse',
      jsonb_build_object(
        'line1', 'HERE_LINE1',
        'line2', 'HERE_LINE2',
        'normalized_line1', 'HERE_LINE1',
        'normalized_line2', 'HERE_LINE2'
      ),
      'pgtap',
      'client',
      t.client_id
    ) IS NOT NULL
    FROM tmp_api_gateway_dispatch_test t
    LIMIT 1
  ),
  'address patched (here_reverse)'
);

-- Create gateway request + workflow run/step.
UPDATE tmp_api_gateway_dispatch_test
SET run_id = gen_random_uuid(),
    step_id = gen_random_uuid();

-- Workflow guardrails require app.workflow_run_id to be present and match inserted rows.
SELECT set_config(
  'app.workflow_run_id',
  (SELECT run_id::text FROM tmp_api_gateway_dispatch_test LIMIT 1),
  true
);

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
  FROM tmp_api_gateway_dispatch_test t
  RETURNING id
)
UPDATE tmp_api_gateway_dispatch_test t
SET request_id = ins_request.id
FROM ins_request;

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  triggered_by_request_id,
  entry_point,
  workflow_status,
  context,
  metadata,
  idempotency_key,
  created_at,
  updated_at
)
SELECT
  t.run_id,
  t.workflow_template_id,
  t.workflow_template_version,
  NULL,
  'api',
  'in_progress',
  jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', t.run_id,
    'organization_id', t.organization_id,
    'client_id', t.client_id,
    'sender_id', t.sender_id,
    'source_id', t.source_id,
    'correlation_id', gen_random_uuid(),
    'address_id', t.address_id,
    'api_gateway', jsonb_strip_nulls(jsonb_build_object(
      'api_gateway_request_id', t.request_id,
      'route_id', t.route_id,
      'route_name', 'logestechs_v2_create_shipment_by_email',
      'provider_id', t.provider_id,
      'upstream_method', 'POST',
      'upstream_url', 'https://example.test/api/ship/request/by-email',
      'outbound_headers', '{}'::jsonb,
      'request_body', jsonb_build_object(
        'destinationAddress', jsonb_build_object(
          'addressLine1', 'RAW_LINE1',
          'addressLine2', 'RAW_LINE2'
        )
      )
    ))
  )),
  '{}'::jsonb,
  NULL,
  now(),
  now()
FROM tmp_api_gateway_dispatch_test t;

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
  t.step_id,
  t.run_id,
  (SELECT id FROM public.workflow_template_steps WHERE workflow_template_id = t.workflow_template_id ORDER BY sequence_order DESC LIMIT 1),
  99,
  'in_progress',
  'dispatch_create',
  3,
  jsonb_build_object(
    'address_line_overrides', jsonb_build_object(
      'line1_path', jsonb_build_array('destinationAddress', 'addressLine1'),
      'line2_path', jsonb_build_array('destinationAddress', 'addressLine2')
    )
  ),
  'api_gateway_dispatch_outbound',
  'v1',
  now(),
  now(),
  now()
FROM tmp_api_gateway_dispatch_test t;

-- Execute dispatch handler (enqueue outbound call).
SELECT workflow_handlers.execute_api_gateway_dispatch_outbound_v1(s, r) AS res
FROM tmp_api_gateway_dispatch_test t
JOIN public.workflow_run_steps s ON s.id = t.step_id
JOIN public.workflow_runs r ON r.id = t.run_id;

-- Persist outbound_call_id from the step operation_result (SSOT for handler output).
UPDATE tmp_api_gateway_dispatch_test t
SET outbound_call_id = (s.operation_result->>'outbound_call_id')::uuid
FROM public.workflow_run_steps s
WHERE s.id = t.step_id;

SELECT is(
  (
    SELECT oc.body #>> '{destinationAddress,addressLine1}'
    FROM tmp_api_gateway_dispatch_test t
    JOIN public.outbound_calls oc ON oc.id = t.outbound_call_id
    LIMIT 1
  ),
  'HERE_LINE1',
  'outbound payload uses SSOT effective destination line1'
);

SELECT * FROM finish();

ROLLBACK;

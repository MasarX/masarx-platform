BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO extensions, public, workflow_handlers, pg_temp;

SELECT plan(8);

SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO public.organizations (id, name, slug, created_at, updated_at)
VALUES (
  '97000000-0000-0000-0000-000000000001',
  'pgTAP API gateway wait org',
  'pgtap-api-gateway-wait-org',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO public.clients (id, organization_id, name, slug, status, created_at, updated_at)
VALUES (
  '97000000-0000-0000-0000-000000000002',
  '97000000-0000-0000-0000-000000000001',
  'pgTAP API gateway wait client',
  'pgtap-api-gateway-wait-client',
  'active',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status, created_at, updated_at)
VALUES (
  '97000000-0000-0000-0000-000000000003',
  '97000000-0000-0000-0000-000000000002',
  'pgTAP API gateway wait sender',
  'pgTAP API gateway wait sender',
  TRUE,
  'active',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
  '97000000-0000-0000-0000-000000000001',
  'pgtap:api-gateway-wait-for-shipment-failure-state-fixture-bootstrap'
);

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000004',
  '97000000-0000-0000-0000-000000000001',
  'webhook_inbound',
  'pgtap-api-gateway-wait',
  '{}'::jsonb,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  mapping_config_id,
  auth_token_hash,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000005',
  '97000000-0000-0000-0000-000000000001',
  'pgtap-api-gateway-wait-source',
  'pgTAP API gateway wait source',
  'api_gateway',
  '97000000-0000-0000-0000-000000000004',
  'pgtap-api-gateway-wait-token-hash',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.providers (
  id,
  organization_id,
  name,
  provider_type,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000006',
  '97000000-0000-0000-0000-000000000001',
  'pgTAP API gateway wait provider',
  '3pl',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.api_route_packs (id, name, created_at, updated_at)
VALUES (
  '97000000-0000-0000-0000-000000000007',
  'pgtap_api_gateway_wait_pack',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  method,
  path_template,
  scope_type,
  scope_id,
  upstream_method,
  upstream_path_template,
  policy,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000008',
  '97000000-0000-0000-0000-000000000007',
  'pgtap_api_gateway_wait_route',
  'POST',
  '/api/ship/request/by-email',
  'tenant',
  '97000000-0000-0000-0000-000000000001',
  'POST',
  '/api/ship/request/by-email',
  '{}'::jsonb,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000009',
  'pgtap_api_gateway_wait_for_shipment_failure_state',
  'pgTAP API gateway wait_for_shipment failure state',
  1,
  'active',
  'global',
  now(),
  now()
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
  metadata,
  enabled,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000010',
  '97000000-0000-0000-0000-000000000009',
  1,
  'wait_for_shipment',
  'always',
  'wait_for_shipment',
  'v1',
  jsonb_build_object('poll_interval_seconds', 2, 'max_wait_seconds', 60),
  TRUE,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000011', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000011',
  '97000000-0000-0000-0000-000000000009',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '97000000-0000-0000-0000-000000000001',
    'api_gateway', jsonb_build_object(
      'route_id', '97000000-0000-0000-0000-000000000008',
      'api_gateway_request_id', '97000000-0000-0000-0000-000000000013',
      'outbound_call_id', '97000000-0000-0000-0000-000000000014'
    )
  ),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000021', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000021',
  '97000000-0000-0000-0000-000000000009',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '97000000-0000-0000-0000-000000000001',
    'api_gateway_request_id', '97000000-0000-0000-0000-000000000023'
  ),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000031', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000031',
  '97000000-0000-0000-0000-000000000009',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '97000000-0000-0000-0000-000000000001',
    'api_gateway', jsonb_build_object(
      'route_id', '97000000-0000-0000-0000-000000000008',
      'api_gateway_request_id', '97000000-0000-0000-0000-000000000033',
      'outbound_call_id', '97000000-0000-0000-0000-000000000034'
    )
  ),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000011', true);

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  retry_attempt,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000012',
  '97000000-0000-0000-0000-000000000011',
  '97000000-0000-0000-0000-000000000010',
  1,
  'pending',
  'wait_for_shipment',
  'wait_for_shipment',
  'v1',
  1,
  3,
  jsonb_build_object('poll_interval_seconds', 2, 'max_wait_seconds', 60),
  now() - interval '1 minute',
  now() - interval '1 minute',
  now() - interval '1 minute'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000021', true);

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  retry_attempt,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000022',
  '97000000-0000-0000-0000-000000000021',
  '97000000-0000-0000-0000-000000000010',
  1,
  'pending',
  'wait_for_shipment',
  'wait_for_shipment',
  'v1',
  1,
  3,
  jsonb_build_object('poll_interval_seconds', 2, 'max_wait_seconds', 1),
  now() - interval '5 seconds',
  now() - interval '5 seconds',
  now() - interval '5 seconds'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000031', true);

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  retry_attempt,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000032',
  '97000000-0000-0000-0000-000000000031',
  '97000000-0000-0000-0000-000000000010',
  1,
  'pending',
  'wait_for_shipment',
  'wait_for_shipment',
  'v1',
  1,
  3,
  jsonb_build_object('poll_interval_seconds', 2, 'max_wait_seconds', 60),
  now() - interval '1 minute',
  now() - interval '1 minute',
  now() - interval '1 minute'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.api_gateway_requests (
  id,
  organization_id,
  client_id,
  sender_id,
  source_id,
  correlation_id,
  route_id,
  method,
  path,
  request_headers,
  request_body,
  outbound_call_id,
  created_at,
  updated_at
)
VALUES
(
  '97000000-0000-0000-0000-000000000013',
  '97000000-0000-0000-0000-000000000001',
  '97000000-0000-0000-0000-000000000002',
  '97000000-0000-0000-0000-000000000003',
  '97000000-0000-0000-0000-000000000005',
  '97000000-0000-0000-0000-000000000015',
  '97000000-0000-0000-0000-000000000008',
  'POST',
  '/api/ship/request/by-email',
  '{}'::jsonb,
  '{}'::jsonb,
  NULL,
  now(),
  now()
),
(
  '97000000-0000-0000-0000-000000000023',
  '97000000-0000-0000-0000-000000000001',
  '97000000-0000-0000-0000-000000000002',
  '97000000-0000-0000-0000-000000000003',
  '97000000-0000-0000-0000-000000000005',
  '97000000-0000-0000-0000-000000000025',
  '97000000-0000-0000-0000-000000000008',
  'POST',
  '/api/ship/request/by-email',
  '{}'::jsonb,
  '{}'::jsonb,
  NULL,
  now(),
  now()
),
(
  '97000000-0000-0000-0000-000000000033',
  '97000000-0000-0000-0000-000000000001',
  '97000000-0000-0000-0000-000000000002',
  '97000000-0000-0000-0000-000000000003',
  '97000000-0000-0000-0000-000000000005',
  '97000000-0000-0000-0000-000000000035',
  '97000000-0000-0000-0000-000000000008',
  'POST',
  '/api/ship/request/by-email',
  '{}'::jsonb,
  '{}'::jsonb,
  NULL,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000011', true);
SELECT set_config('app.workflow_run_step_id', '97000000-0000-0000-0000-000000000012', true);

INSERT INTO public.outbound_calls (
  id,
  workflow_run_step_id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  headers,
  body,
  status,
  response_status_code,
  response_body,
  error_message,
  created_at,
  updated_at,
  completed_at
)
VALUES (
  '97000000-0000-0000-0000-000000000014',
  '97000000-0000-0000-0000-000000000012',
  'provider_api',
  'provider',
  '97000000-0000-0000-0000-000000000006',
  'POST',
  'https://example.test/api/ship/request/by-email',
  '{}'::jsonb,
  '{}'::jsonb,
  'permanently_failed',
  401,
  jsonb_build_object('error', 'credential rejected'),
  'credential rejected',
  now() - interval '1 minute',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

UPDATE public.workflow_run_steps
   SET operation_started_at = now() - interval '5 seconds'
 WHERE id = '97000000-0000-0000-0000-000000000022';

UPDATE public.api_gateway_requests
   SET workflow_run_id = '97000000-0000-0000-0000-000000000011',
       outbound_call_id = '97000000-0000-0000-0000-000000000014',
       updated_at = now()
 WHERE id = '97000000-0000-0000-0000-000000000013';

SELECT set_config('app.workflow_run_id', '97000000-0000-0000-0000-000000000031', true);
SELECT set_config('app.workflow_run_step_id', '97000000-0000-0000-0000-000000000032', true);

INSERT INTO public.outbound_calls (
  id,
  workflow_run_step_id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  headers,
  body,
  status,
  response_status_code,
  response_body,
  error_message,
  created_at,
  updated_at,
  completed_at
)
VALUES (
  '97000000-0000-0000-0000-000000000034',
  '97000000-0000-0000-0000-000000000032',
  'provider_api',
  'provider',
  '97000000-0000-0000-0000-000000000006',
  'POST',
  'https://example.test/api/ship/request/by-email',
  '{}'::jsonb,
  '{}'::jsonb,
  'permanently_failed',
  401,
  jsonb_build_object('error', 'credential rejected after shipment'),
  'credential rejected after shipment',
  now() - interval '1 minute',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

UPDATE public.api_gateway_requests
   SET workflow_run_id = '97000000-0000-0000-0000-000000000031',
       outbound_call_id = '97000000-0000-0000-0000-000000000034',
       updated_at = now()
 WHERE id = '97000000-0000-0000-0000-000000000033';

INSERT INTO public.shipments (
  id,
  organization_id,
  client_id,
  sender_id,
  service_type,
  tracking_number,
  client_reference_number,
  box_count,
  status,
  metadata,
  created_at,
  updated_at
)
VALUES (
  '97000000-0000-0000-0000-000000000036',
  '97000000-0000-0000-0000-000000000001',
  '97000000-0000-0000-0000-000000000002',
  '97000000-0000-0000-0000-000000000003',
  'delivery',
  'PGTAP-API-WAIT-LINK-001',
  'PGTAP-API-WAIT-LINK-CLIENT-001',
  1,
  'pending',
  jsonb_build_object(
    'source',
    jsonb_build_object(
      'api_gateway_request_id',
      '97000000-0000-0000-0000-000000000033'
    )
  ),
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).status
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000011'
  ),
  'failed',
  'wait_for_shipment fails closed when provider dispatch is terminal failed'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).workflow_status
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000011'
  ),
  'failed',
  'wait_for_shipment propagates workflow failure on provider dispatch failure'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).last_error
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000011'
  ),
  'provider_outbound_permanently_failed',
  'wait_for_shipment exposes a safe provider failure code'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).operation_result#>>'{provider_failure,status}'
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000011'
  ),
  'permanently_failed',
  'wait_for_shipment operation result carries outbound failure state'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).status
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000031'
  ),
  'completed',
  'wait_for_shipment completes when shipment lineage exists even if outbound later failed'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).operation_result->>'shipment_id'
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000031'
  ),
  '97000000-0000-0000-0000-000000000036',
  'wait_for_shipment returns the canonical shipment id before provider failure diagnostics'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).status
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000021'
  ),
  'failed',
  'wait_for_shipment timeout uses the persisted operation start'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).operation_result->>'reason'
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = '97000000-0000-0000-0000-000000000021'
  ),
  'timeout',
  'wait_for_shipment timeout result is explicit'
);

SELECT * FROM finish();
ROLLBACK;

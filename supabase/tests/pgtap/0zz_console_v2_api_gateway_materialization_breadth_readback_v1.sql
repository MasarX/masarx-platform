-- pgTAP: Console V2 API Gateway materialization breadth readback.
-- This stays on the API Gateway path and does not retest webhook semantics.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(22);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '20530174-0000-4000-8000-000000000001'::uuid,
  'Console V2 API Gateway Materialization Breadth Org',
  'console-v2-api-gateway-materialization-breadth-org'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  '20530174-0000-4000-8000-000000000002'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  'Console V2 API Gateway Materialization Breadth Client',
  'console-v2-api-gateway-materialization-breadth-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.senders (id, client_id, name, status)
VALUES (
  '20530174-0000-4000-8000-000000000003'::uuid,
  '20530174-0000-4000-8000-000000000002'::uuid,
  'Console V2 API Gateway Materialization Breadth Sender',
  'active'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  '20530174-0000-4000-8000-000000000004'::uuid,
  'api_gateway_inbound',
  'tenant.default.shipment.reschedule',
  jsonb_build_object('target', 'shipments.reschedule'),
  1,
  'Console V2 API Gateway materialization breadth test mapping'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
  SET mapping_config = EXCLUDED.mapping_config,
      updated_at = now();

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  sender_id,
  enabled
)
VALUES (
  '20530174-0000-4000-8000-000000000005'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  'console-v2-api-gateway-materialization-breadth-source',
  'Console V2 API Gateway Materialization Breadth Source',
  'api_gateway',
  'console-v2-api-gateway-materialization-breadth-token',
  '20530174-0000-4000-8000-000000000004'::uuid,
  '20530174-0000-4000-8000-000000000003'::uuid,
  TRUE
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      sender_id = EXCLUDED.sender_id,
      updated_at = now();

INSERT INTO public.api_route_packs (id, name, description, enabled)
VALUES (
  '20530174-0000-4000-8000-000000000006'::uuid,
  'console-v2-api-gateway-materialization-breadth-pack',
  'Console V2 API gateway materialization breadth test pack',
  TRUE
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  policy
)
VALUES (
  '20530174-0000-4000-8000-000000000007'::uuid,
  '20530174-0000-4000-8000-000000000006'::uuid,
  'Console V2 materialization breadth reschedule route',
  TRUE,
  'PATCH',
  '/api/materialization-breadth/{shipmentId}/reschedule',
  'source',
  '20530174-0000-4000-8000-000000000005'::uuid,
  jsonb_build_object(
    'postprocess', jsonb_build_object(
      'enabled', TRUE,
      'mode', 'shipment_reschedule_v1',
      'canonical_intent', 'shipment.reschedule',
      'extract', jsonb_build_object('reschedule_date_path', 'delivery.date')
    ),
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '20530174-0000-4000-8000-000000000004',
      'mapping_key', 'tenant.default.shipment.reschedule',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.reschedule',
      'route_scope_type', 'source'
    )
  )
)
ON CONFLICT (id) DO UPDATE
  SET policy = EXCLUDED.policy,
      enabled = TRUE,
      updated_at = now();

SELECT is(
  public.api_gateway_shipment_mutation_default_workflow_template_v1('shipment.reschedule'),
  'api_gateway_shipment_mutation_default_v1',
  'API Gateway shipment.reschedule routes resolve to the canonical typed mutation workflow template'
);

SELECT is(
  (
    SELECT policy #>> '{workflow,template_name}'
    FROM public.api_routes
    WHERE id = '20530174-0000-4000-8000-000000000007'::uuid
  ),
  'api_gateway_shipment_mutation_default_v1',
  'enabled reschedule route receives workflow template default without app-side branching'
);

SELECT is(
  (
    SELECT policy #>> '{delivery,mode}'
    FROM public.api_routes
    WHERE id = '20530174-0000-4000-8000-000000000007'::uuid
  ),
  'accepted_async',
  'enabled reschedule route receives accepted-async delivery default'
);

INSERT INTO public.recipients (
  id,
  organization_id,
  client_id,
  external_id,
  name,
  phone_number,
  preferred_language
)
VALUES (
  '20530174-0000-4000-8000-000000000008'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  '20530174-0000-4000-8000-000000000002'::uuid,
  'recipient-materialization-breadth-001',
  'Materialization Breadth Receiver',
  '+966500000174',
  'en'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  normalized_line1,
  city,
  province,
  country,
  validation_status
)
VALUES (
  '20530174-0000-4000-8000-000000000009'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  '20530174-0000-4000-8000-000000000002'::uuid,
  'Riyadh, Saudi Arabia',
  'Riyadh',
  'Riyadh',
  'Riyadh',
  'SA',
  'valid'
)
ON CONFLICT (id, client_id) DO UPDATE
  SET validation_status = EXCLUDED.validation_status,
      updated_at = now();

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
  query_string,
  request_headers,
  request_body,
  received_at
)
VALUES (
  '20530174-0000-4000-8000-000000000010'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  '20530174-0000-4000-8000-000000000002'::uuid,
  '20530174-0000-4000-8000-000000000003'::uuid,
  '20530174-0000-4000-8000-000000000005'::uuid,
  '20530174-0000-4000-8000-000000000011'::uuid,
  '20530174-0000-4000-8000-000000000007'::uuid,
  'PATCH',
  '/api/materialization-breadth/API-MAT-001/reschedule',
  'proof=materialization-breadth',
  jsonb_build_object(
    'authorization', 'REDACTED',
    'idempotency-key', 'idem-materialization-breadth-001',
    'x-masarx-replay-of', '20530174-0000-4000-8000-0000000000aa'
  ),
  jsonb_build_object(
    'password', 'REDACTED',
    'delivery', jsonb_build_object('date', '2026-06-01')
  ),
  now()
)
ON CONFLICT (id) DO UPDATE
  SET request_headers = EXCLUDED.request_headers,
      request_body = EXCLUDED.request_body,
      received_at = EXCLUDED.received_at,
      updated_at = now();

INSERT INTO public.shipments (
  id,
  organization_id,
  client_id,
  sender_id,
  service_type,
  tracking_number,
  client_reference_number,
  box_count,
  recipient_id,
  destination_address_id,
  status,
  metadata
)
VALUES (
  '20530174-0000-4000-8000-000000000012'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  '20530174-0000-4000-8000-000000000002'::uuid,
  '20530174-0000-4000-8000-000000000003'::uuid,
  'delivery',
  'API-MAT-BREADTH-001',
  'API-MAT-BREADTH-CLIENT-001',
  1,
  '20530174-0000-4000-8000-000000000008'::uuid,
  '20530174-0000-4000-8000-000000000009'::uuid,
  'pending',
  jsonb_build_object(
    'source',
    jsonb_build_object('api_gateway_request_id', '20530174-0000-4000-8000-000000000010')
  )
)
ON CONFLICT DO NOTHING;

INSERT INTO public.shipment_actions (
  id,
  shipment_id,
  organization_id,
  client_id,
  action_type,
  action_category,
  canonical_status,
  action_data,
  timestamp,
  created_at,
  performed_by_system
)
VALUES (
  '20530174-0000-4000-8000-000000000013'::uuid,
  '20530174-0000-4000-8000-000000000012'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  '20530174-0000-4000-8000-000000000002'::uuid,
  'api_gateway_materialized',
  'operational',
  'pending',
  jsonb_build_object(
    'api_gateway_request_id', '20530174-0000-4000-8000-000000000010',
    'operation', 'inserted',
    'recipient_id', '20530174-0000-4000-8000-000000000008',
    'destination_address_id', '20530174-0000-4000-8000-000000000009'
  ),
  now(),
  now(),
  'pgtap.console_v2_api_gateway_materialization_breadth'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.decision_log (
  id,
  organization_id,
  decision_category,
  resource_type,
  resource_id,
  decision_point,
  decision_outcome,
  decision_inputs,
  decision_reason,
  performed_by_system,
  correlation_id,
  timestamp
)
VALUES (
  '20530174-0000-4000-8000-000000000014'::uuid,
  '20530174-0000-4000-8000-000000000001'::uuid,
  'transformation',
  'api_gateway_request',
  '20530174-0000-4000-8000-000000000010'::uuid,
  'api_gateway_request_mapping',
  'applied',
  jsonb_build_object(
    'mapping',
    jsonb_build_object(
      'mapping_config_id', '20530174-0000-4000-8000-000000000004',
      'mapping_key', 'tenant.default.shipment.reschedule',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.reschedule'
    )
  ),
  'API Gateway request mapping applied',
  'pgtap.console_v2_api_gateway_materialization_breadth',
  '20530174-0000-4000-8000-000000000011'::uuid,
  now()
)
ON CONFLICT DO NOTHING;

SELECT is(
  (SELECT idempotency_key FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'idem-materialization-breadth-001',
  'request directory exposes API Gateway idempotency key readback'
);

SELECT is(
  (SELECT replay_of_request_id FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  '20530174-0000-4000-8000-0000000000aa',
  'request directory exposes replay lineage readback'
);

SELECT is(
  (SELECT mutation_intent FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'shipment.reschedule',
  'request directory exposes canonical mutation intent readback'
);

SELECT is(
  (SELECT request_mapping_config_id FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  '20530174-0000-4000-8000-000000000004',
  'request directory exposes route mapping config readback'
);

SELECT is(
  (SELECT request_mapping_key FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'tenant.default.shipment.reschedule',
  'request directory exposes route mapping key readback'
);

SELECT is(
  (SELECT request_mapping_type FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'api_gateway_inbound',
  'request directory exposes route mapping type readback'
);

SELECT is(
  (SELECT request_mapping_target FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'shipments.reschedule',
  'request directory exposes route mapping target readback'
);

SELECT ok(
  (SELECT request_mapping_applied FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'request directory exposes applied mapping decision lineage'
);

SELECT is(
  (SELECT materialization_action_id::text FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  '20530174-0000-4000-8000-000000000013',
  'request directory exposes materialization action lineage'
);

SELECT is(
  (SELECT materialization_operation FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'inserted',
  'request directory exposes materialization operation readback'
);

SELECT is(
  (SELECT recipient_label FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'Materialization Breadth Receiver',
  'request directory exposes recipient readback for new/existing recipient inspection'
);

SELECT is(
  (SELECT recipient_external_id FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'recipient-materialization-breadth-001',
  'request directory exposes recipient external-id readback'
);

SELECT is(
  (SELECT destination_city FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'Riyadh',
  'request directory exposes destination address readback'
);

SELECT is(
  (SELECT destination_validation_status FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'valid',
  'request directory exposes destination validation status readback'
);

SELECT is(
  (SELECT request_body->>'password' FROM public.v_api_gateway_request_directory WHERE request_id = '20530174-0000-4000-8000-000000000010'::uuid),
  'REDACTED',
  'request directory preserves redacted request-body proof'
);

SELECT ok(
  (
    SELECT bool_and(COALESCE(resource->'select', '[]'::jsonb) ? wanted.field)
    FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
    CROSS JOIN (
      VALUES
        ('idempotency_key'),
        ('replay_of_request_id'),
        ('mutation_intent'),
        ('request_mapping_config_id'),
        ('request_mapping_key'),
        ('request_mapping_type'),
        ('request_mapping_target'),
        ('request_mapping_applied'),
        ('materialization_action_id'),
        ('materialization_operation'),
        ('recipient_label'),
        ('destination_city')
    ) AS wanted(field)
    WHERE resource->>'key' = 'api_gateway_requests'
  ),
  'ui_read_registry exposes API Gateway materialization breadth columns to Console V2'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_api_gateway_request_directory'::regclass),
  '{security_invoker=true}',
  'v_api_gateway_request_directory remains security_invoker'
);

SELECT ok(
  position(
    '''payload'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb)'
    IN pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
  ) > 0,
  'API Gateway workflow context exposes mapped request payload at the root for canonical shipment handlers'
);

SELECT ok(
  position(
    '''transformed_payload'', CASE'
    IN pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
  ) > 0,
  'API Gateway workflow context marks mapped payloads as transformed_payload for materialization handlers'
);

SELECT * FROM finish();

ROLLBACK;

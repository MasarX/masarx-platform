-- pgTAP: Console API Gateway update/delete action readback.
-- Proves provider-success update/delete requests expose canonical shipment
-- action lineage in the same request-first Console projection.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '20602165-0000-4000-8000-000000000001'::uuid,
  'Console API Gateway Update Delete Readback Org',
  'console-api-gateway-update-delete-readback-org'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  '20602165-0000-4000-8000-000000000002'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  'Console API Gateway Update Delete Readback Client',
  'console-api-gateway-update-delete-readback-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.senders (id, client_id, name, status)
VALUES (
  '20602165-0000-4000-8000-000000000003'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'Console API Gateway Update Delete Readback Sender',
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
  '20602165-0000-4000-8000-000000000004'::uuid,
  'api_gateway_inbound',
  'tenant.default.shipment.update-delete',
  jsonb_build_object('target', 'shipments.update'),
  1,
  'Console API Gateway update/delete readback test mapping'
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
  '20602165-0000-4000-8000-000000000005'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  'console-api-gateway-update-delete-readback-source',
  'Console API Gateway Update Delete Readback Source',
  'api_gateway',
  'console-api-gateway-update-delete-readback-token',
  '20602165-0000-4000-8000-000000000004'::uuid,
  '20602165-0000-4000-8000-000000000003'::uuid,
  TRUE
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      sender_id = EXCLUDED.sender_id,
      updated_at = now();

INSERT INTO public.api_route_packs (id, name, description, enabled)
VALUES (
  '20602165-0000-4000-8000-000000000006'::uuid,
  'console-api-gateway-update-delete-readback-pack',
  'Console API gateway update/delete readback test pack',
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
VALUES
(
  '20602165-0000-4000-8000-000000000007'::uuid,
  '20602165-0000-4000-8000-000000000006'::uuid,
  'Console update readback route',
  TRUE,
  'PUT',
  '/api/update-delete-readback/{shipmentId}',
  'source',
  '20602165-0000-4000-8000-000000000005'::uuid,
  jsonb_build_object(
    'postprocess', jsonb_build_object(
      'enabled', TRUE,
      'mode', 'shipment_update_v1',
      'canonical_intent', 'shipment.update'
    ),
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '20602165-0000-4000-8000-000000000004',
      'mapping_key', 'tenant.default.shipment.update-delete',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.update',
      'route_scope_type', 'source'
    )
  )
),
(
  '20602165-0000-4000-8000-000000000008'::uuid,
  '20602165-0000-4000-8000-000000000006'::uuid,
  'Console delete readback route',
  TRUE,
  'DELETE',
  '/api/update-delete-readback/{shipmentId}',
  'source',
  '20602165-0000-4000-8000-000000000005'::uuid,
  jsonb_build_object(
    'postprocess', jsonb_build_object(
      'enabled', TRUE,
      'mode', 'shipment_cancel_v1',
      'canonical_intent', 'shipment.delete'
    ),
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '20602165-0000-4000-8000-000000000004',
      'mapping_key', 'tenant.default.shipment.update-delete',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.delete',
      'route_scope_type', 'source'
    )
  )
)
ON CONFLICT (id) DO UPDATE
  SET policy = EXCLUDED.policy,
      enabled = TRUE,
      updated_at = now();

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
  '20602165-0000-4000-8000-000000000009'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'recipient-update-delete-readback-001',
  'Update Delete Readback Receiver',
  '+966500021650',
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
VALUES
(
  '20602165-0000-4000-8000-000000000010'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'Riyadh, Saudi Arabia',
  'Riyadh',
  'Riyadh',
  'Riyadh',
  'SA',
  'valid'
),
(
  '20602165-0000-4000-8000-000000000011'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'Jeddah, Saudi Arabia',
  'Jeddah',
  'Jeddah',
  'Makkah',
  'SA',
  'valid'
)
ON CONFLICT (id, client_id) DO UPDATE
  SET validation_status = EXCLUDED.validation_status,
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
  '20602165-0000-4000-8000-000000000012'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  '20602165-0000-4000-8000-000000000003'::uuid,
  'delivery',
  'API-UPDATE-DELETE-001',
  'API-UPDATE-DELETE-CLIENT-001',
  1,
  '20602165-0000-4000-8000-000000000009'::uuid,
  '20602165-0000-4000-8000-000000000011'::uuid,
  'cancelled',
  '{}'::jsonb
)
ON CONFLICT DO NOTHING;

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
VALUES
(
  '20602165-0000-4000-8000-000000000013'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  '20602165-0000-4000-8000-000000000003'::uuid,
  '20602165-0000-4000-8000-000000000005'::uuid,
  '20602165-0000-4000-8000-000000000014'::uuid,
  '20602165-0000-4000-8000-000000000007'::uuid,
  'PUT',
  '/api/update-delete-readback/API-UPDATE-DELETE-001',
  'proof=update',
  jsonb_build_object('authorization', 'REDACTED', 'idempotency-key', 'idem-update-delete-readback-update'),
  jsonb_build_object('destinationAddress', jsonb_build_object('city', 'Jeddah')),
  now()
),
(
  '20602165-0000-4000-8000-000000000015'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  '20602165-0000-4000-8000-000000000003'::uuid,
  '20602165-0000-4000-8000-000000000005'::uuid,
  '20602165-0000-4000-8000-000000000016'::uuid,
  '20602165-0000-4000-8000-000000000008'::uuid,
  'DELETE',
  '/api/update-delete-readback/API-UPDATE-DELETE-001',
  'proof=delete',
  jsonb_build_object('authorization', 'REDACTED', 'idempotency-key', 'idem-update-delete-readback-delete'),
  jsonb_build_object('reason', 'cancelled by client'),
  now()
)
ON CONFLICT (id) DO UPDATE
  SET request_headers = EXCLUDED.request_headers,
      request_body = EXCLUDED.request_body,
      received_at = EXCLUDED.received_at,
      updated_at = now();

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
VALUES
(
  '20602165-0000-4000-8000-000000000017'::uuid,
  '20602165-0000-4000-8000-000000000012'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'address_update',
  'administrative',
  NULL,
  jsonb_build_object(
    'api_gateway_request_id', '20602165-0000-4000-8000-000000000013',
    'route_id', '20602165-0000-4000-8000-000000000007',
    'address_id', '20602165-0000-4000-8000-000000000011'
  ),
  now() - interval '1 minute',
  now() - interval '1 minute',
  'workflow_handlers.process_api_gateway_shipment_update_v1'
),
(
  '20602165-0000-4000-8000-000000000018'::uuid,
  '20602165-0000-4000-8000-000000000012'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'status_change',
  'operational',
  'cancelled',
  jsonb_build_object(
    'api_gateway_request_id', '20602165-0000-4000-8000-000000000015',
    'route_id', '20602165-0000-4000-8000-000000000008',
    'provider_shipment_id', 'API-UPDATE-DELETE-001'
  ),
  now(),
  now(),
  'workflow_handlers.process_api_gateway_outbound_response_v1'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.shipment_actions (
  id, shipment_id, organization_id, client_id, action_type, action_category,
  canonical_status, action_data, timestamp, created_at, performed_by_system
)
VALUES
(
  '20602165-0000-4000-8000-000000000019'::uuid,
  '20602165-0000-4000-8000-000000000012'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'api_gateway_materialized',
  'administrative',
  NULL,
  jsonb_build_object(
    'api_gateway_request_id', '20602165-0000-4000-8000-000000000013',
    'operation', 'created'
  ),
  now() + interval '1 minute',
  now() + interval '1 minute',
  'workflow_handlers.process_api_gateway_outbound_response_v1'
),
(
  '20602165-0000-4000-8000-000000000020'::uuid,
  '20602165-0000-4000-8000-000000000012'::uuid,
  '20602165-0000-4000-8000-000000000001'::uuid,
  '20602165-0000-4000-8000-000000000002'::uuid,
  'api_gateway_materialized',
  'administrative',
  NULL,
  jsonb_build_object(
    'api_gateway_request_id', '20602165-0000-4000-8000-000000000015',
    'operation', 'created'
  ),
  now() + interval '1 minute',
  now() + interval '1 minute',
  'workflow_handlers.process_api_gateway_outbound_response_v1'
)
ON CONFLICT (id) DO NOTHING;


SELECT is(
  (SELECT mutation_intent FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000013'::uuid),
  'shipment.update',
  'request directory exposes update route mutation intent'
);

SELECT is(
  (SELECT shipment_id::text FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000013'::uuid),
  '20602165-0000-4000-8000-000000000012',
  'request directory links update request to the canonical shipment'
);

SELECT is(
  (SELECT materialization_action_id::text FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000013'::uuid),
  '20602165-0000-4000-8000-000000000017',
  'request directory exposes provider-success update action lineage'
);

SELECT is(
  (SELECT materialization_operation FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000013'::uuid),
  'updated',
  'request directory derives update materialization operation'
);

SELECT is(
  (SELECT destination_city FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000013'::uuid),
  'Jeddah',
  'request directory exposes post-update destination readback'
);

SELECT is(
  (SELECT idempotency_key FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000013'::uuid),
  'idem-update-delete-readback-update',
  'request directory keeps update idempotency readback'
);

SELECT is(
  (SELECT mutation_intent FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000015'::uuid),
  'shipment.delete',
  'request directory exposes delete route mutation intent'
);

SELECT is(
  (SELECT shipment_id::text FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000015'::uuid),
  '20602165-0000-4000-8000-000000000012',
  'request directory links delete request to the canonical shipment'
);

SELECT is(
  (SELECT materialization_action_id::text FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000015'::uuid),
  '20602165-0000-4000-8000-000000000018',
  'request directory exposes provider-success delete action lineage'
);

SELECT is(
  (SELECT materialization_operation FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000015'::uuid),
  'cancelled',
  'request directory derives delete materialization operation'
);

SELECT is(
  (SELECT shipment_status FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000015'::uuid),
  'cancelled',
  'request directory exposes post-delete shipment status readback'
);

SELECT is(
  (SELECT request_body->>'reason' FROM public.v_api_gateway_request_directory WHERE request_id = '20602165-0000-4000-8000-000000000015'::uuid),
  'cancelled by client',
  'request directory keeps delete request body readback'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_api_gateway_request_directory'::regclass),
  '{security_invoker=true}',
  'v_api_gateway_request_directory remains security_invoker'
);

SELECT * FROM finish();

ROLLBACK;

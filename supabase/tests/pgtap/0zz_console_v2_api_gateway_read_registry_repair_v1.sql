-- pgTAP: Console V2 API/provider intake observability reads are registered
-- through backend-backed resources.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(43);

SELECT ok(
  (
    SELECT bool_and(resource ? 'key')
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' IN (
       'api_gateway_observability',
       'api_gateway_rate_limits_summary',
       'api_gateway_requests',
       'provider_health_logs'
     )
  ),
  'global read registry carries all API gateway live resources'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'api_gateway_observability'
  ),
  'public.v_api_gateway_observability',
  'api_gateway_observability reads the canonical security-invoker projection'
);

SELECT ok(
  COALESCE((
    SELECT (resource->'select') ?& ARRAY['has_request_headers', 'response_size_bytes']
       AND NOT (resource->'select') ?| ARRAY['request_headers', 'request_body', 'response_body', 'response_body_sample']
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS resource
     WHERE resource->>'key' = 'api_gateway_observability'
  ), FALSE),
  'api gateway observability keeps drawer status without returning request headers or response bodies'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'api_gateway_rate_limits_summary'
  ),
  'public.v_api_gateway_rate_limits_summary',
  'api_gateway_rate_limits_summary reads the canonical security-invoker projection'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'api_gateway_requests'
  ),
  'public.v_api_gateway_request_directory',
  'api_gateway_requests tab reads the request-first intake projection'
);

SELECT is(
  (
    SELECT resource->>'capability_read'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'provider_health_logs'
  ),
  'api_gateway.read',
  'provider_health_logs is gated by api_gateway.read'
);

SELECT ok(
  (
    SELECT (resource->'select') ? 'client_label'
       AND (resource->'select') ? 'sender_label'
       AND (resource->'select') ? 'shipment_id'
       AND (resource->'select') ? 'tracking_number'
       AND (resource->'select') ? 'shipment_status'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'api_gateway_requests'
  ),
  'api_gateway_requests registry exposes operator labels and shipment handoff fields'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_api_gateway_observability'::regclass),
  '{security_invoker=true}',
  'v_api_gateway_observability remains security_invoker'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_api_gateway_rate_limits_summary'::regclass),
  '{security_invoker=true}',
  'v_api_gateway_rate_limits_summary remains security_invoker'
);

SELECT ok(
  to_regclass('public.v_api_gateway_request_directory') IS NOT NULL,
  'v_api_gateway_request_directory exists'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_api_gateway_request_directory'::regclass),
  '{security_invoker=true}',
  'v_api_gateway_request_directory remains security_invoker'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND EXISTS (
         SELECT wanted.key
           FROM (VALUES
             ('api_gateway_observability'),
             ('api_gateway_rate_limits_summary'),
             ('api_gateway_requests'),
             ('provider_health_logs')
           ) AS wanted(key)
          WHERE NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
             WHERE resource->>'key' = wanted.key
               AND resource->>'capability_read' = 'api_gateway.read'
          )
       )
  ),
  'all scoped read registries expose API gateway resources with api_gateway.read'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'Console V2 API Gateway Registry Org',
  'console-v2-api-gateway-registry-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (
  id,
  organization_id,
  name,
  slug,
  status
)
VALUES (
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'Console V2 API Gateway Registry Client',
  'console-v2-api-gateway-registry-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.senders (
  id,
  client_id,
  name,
  status
)
VALUES (
  '13ddf94f-fc6a-4d36-bd8a-e524f2f4e01c'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  'Console V2 API Gateway Registry Sender',
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
  '6321ce49-3c4d-4d8e-9c3e-f4f511e0f9d2'::uuid,
  'webhook_inbound',
  'console-v2-api-gateway-registry-map',
  '{"target":"shipments.create"}'::jsonb,
  1,
  'Console V2 API gateway registry test mapping'
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
  enabled
)
VALUES (
  'f1e63934-5eea-4426-9e2e-304fcfe56190'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'console-v2-api-gateway-registry-source',
  'Console V2 API Gateway Registry Source',
  'api_gateway',
  'console-v2-api-gateway-registry-token',
  '6321ce49-3c4d-4d8e-9c3e-f4f511e0f9d2'::uuid,
  TRUE
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status)
VALUES (
  'd56e51af-9d32-4a7b-8ff3-1cf152c06de1'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'Console V2 API Gateway Registry Provider',
  'http',
  TRUE,
  990,
  'healthy'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      updated_at = now();

INSERT INTO public.api_route_packs (
  id,
  name,
  description,
  enabled
)
VALUES (
  '6e5ea52b-50e2-47b7-9d9f-7d90c885a4f1'::uuid,
  'console-v2-api-gateway-registry-pack',
  'Console V2 API gateway registry test pack',
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
  '1dc4045f-7fb4-48ad-94a0-64172e5e0c8b'::uuid,
  '6e5ea52b-50e2-47b7-9d9f-7d90c885a4f1'::uuid,
  'Registry request test',
  TRUE,
  'POST',
  '/api/ship/request/by-email',
  'global',
  NULL,
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
VALUES (
  '9ec51e78-898e-46ec-95b7-d98e6a30c66b'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  '13ddf94f-fc6a-4d36-bd8a-e524f2f4e01c'::uuid,
  'f1e63934-5eea-4426-9e2e-304fcfe56190'::uuid,
  '101cb91d-1af4-41eb-bd13-c9ace4860500'::uuid,
  COALESCE(
    (
      SELECT id
        FROM public.api_routes
       WHERE upper(method) = 'POST'
         AND path_template = '/api/ship/request/by-email'
       ORDER BY created_at
       LIMIT 1
    ),
    '1dc4045f-7fb4-48ad-94a0-64172e5e0c8b'::uuid
  ),
  'POST',
  '/api/ship/request/by-email',
  NULL,
  '{"authorization":"<redacted>"}'::jsonb,
  '{"pkg":{"recipientName":"Registry Recipient"}}'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET received_at = EXCLUDED.received_at,
      updated_at = now();

INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edc1'::uuid,
  'console_v2_api_gateway_registry_failure_template',
  'Console V2 API gateway registry failure projection template',
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
)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edc2'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc1'::uuid,
  1,
  'provider_dispatch',
  'always',
  'provider_dispatch',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '8061cd90-e981-4e71-949b-442f7094edc3', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edc3'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc1'::uuid,
  1,
  'api',
  'in_progress',
  '{}'::jsonb
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
)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edc4'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc3'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc2'::uuid,
  1,
  'failed',
  'provider_dispatch',
  'provider_dispatch',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO UPDATE
  SET step_status = EXCLUDED.step_status,
      updated_at = now();

SELECT set_config('app.workflow_run_step_id', '8061cd90-e981-4e71-949b-442f7094edc4', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', '8061cd90-e981-4e71-949b-442f7094edc4', true);

INSERT INTO public.outbound_calls (
  id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  headers,
  body,
  status,
  response_status_code,
  error_message,
  priority,
  retry_count,
  max_retries,
  scheduled_at,
  created_at,
  workflow_run_step_id
)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edc5'::uuid,
  'provider_api',
  'provider',
  'd56e51af-9d32-4a7b-8ff3-1cf152c06de1'::uuid,
  'POST',
  'https://provider.example.test/api/ship/request/by-email',
  '{}'::jsonb,
  '{"payload":true}'::jsonb,
  'permanently_failed',
  400,
  'credential rejected',
  100,
  0,
  0,
  now(),
  now(),
  '8061cd90-e981-4e71-949b-442f7094edc4'::uuid
)
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      response_status_code = EXCLUDED.response_status_code,
      error_message = EXCLUDED.error_message,
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
  outbound_call_id,
  workflow_run_id,
  received_at
)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edc6'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  '13ddf94f-fc6a-4d36-bd8a-e524f2f4e01c'::uuid,
  'f1e63934-5eea-4426-9e2e-304fcfe56190'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc7'::uuid,
  COALESCE(
    (
      SELECT id
        FROM public.api_routes
       WHERE upper(method) = 'POST'
         AND path_template = '/api/ship/request/by-email'
       ORDER BY created_at
       LIMIT 1
    ),
    '1dc4045f-7fb4-48ad-94a0-64172e5e0c8b'::uuid
  ),
  'POST',
  '/api/ship/request/by-email',
  NULL,
  '{"authorization":"<redacted>"}'::jsonb,
  '{"pkg":{"recipientName":"Registry Failed Recipient"}}'::jsonb,
  '8061cd90-e981-4e71-949b-442f7094edc5'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc3'::uuid,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET outbound_call_id = EXCLUDED.outbound_call_id,
      workflow_run_id = EXCLUDED.workflow_run_id,
      received_at = EXCLUDED.received_at,
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
  outbound_call_id,
  workflow_run_id,
  received_at
)
VALUES (
  '8061cd90-e981-4e71-949b-442f7094edc8'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  '13ddf94f-fc6a-4d36-bd8a-e524f2f4e01c'::uuid,
  'f1e63934-5eea-4426-9e2e-304fcfe56190'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc9'::uuid,
  COALESCE(
    (
      SELECT id
        FROM public.api_routes
       WHERE upper(method) = 'POST'
         AND path_template = '/api/ship/request/by-email'
       ORDER BY created_at
       LIMIT 1
    ),
    '1dc4045f-7fb4-48ad-94a0-64172e5e0c8b'::uuid
  ),
  'POST',
  '/api/ship/request/by-email',
  NULL,
  '{"authorization":"<redacted>"}'::jsonb,
  '{"pkg":{"recipientName":"Registry Materialized Diagnostic Recipient"}}'::jsonb,
  '8061cd90-e981-4e71-949b-442f7094edc5'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edc3'::uuid,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET outbound_call_id = EXCLUDED.outbound_call_id,
      workflow_run_id = EXCLUDED.workflow_run_id,
      received_at = EXCLUDED.received_at,
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
  '8061cd90-e981-4e71-949b-442f7094edca'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  '13ddf94f-fc6a-4d36-bd8a-e524f2f4e01c'::uuid,
  'f1e63934-5eea-4426-9e2e-304fcfe56190'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edcb'::uuid,
  COALESCE(
    (
      SELECT id
        FROM public.api_routes
       WHERE upper(method) = 'POST'
         AND path_template = '/api/ship/request/by-email'
       ORDER BY created_at
       LIMIT 1
    ),
    '1dc4045f-7fb4-48ad-94a0-64172e5e0c8b'::uuid
  ),
  'POST',
  '/api/ship/request/by-email',
  NULL,
  '{"authorization":"<redacted>"}'::jsonb,
  '{"pkg":{"recipientName":"Registry Duplicate Replay Recipient"}}'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET received_at = EXCLUDED.received_at,
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
  '8061cd90-e981-4e71-949b-442f7094edcd'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  NULL,
  NULL,
  'f1e63934-5eea-4426-9e2e-304fcfe56190'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edce'::uuid,
  COALESCE(
    (
      SELECT id
        FROM public.api_routes
       WHERE upper(method) = 'POST'
         AND path_template = '/api/ship/request/by-email'
       ORDER BY created_at
       LIMIT 1
    ),
    '1dc4045f-7fb4-48ad-94a0-64172e5e0c8b'::uuid
  ),
  'POST',
  '/api/ship/request/by-email',
  NULL,
  '{"authorization":"<redacted>"}'::jsonb,
  '{"pkg":{"recipientName":"Registry Missing Binding Recipient"}}'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
  SET received_at = EXCLUDED.received_at,
      updated_at = now();

SELECT public.log_decision(
  p_organization_id := '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  p_decision_category := 'settings_resolution',
  p_resource_type := 'api_gateway_request',
  p_resource_id := '8061cd90-e981-4e71-949b-442f7094edcd'::uuid,
  p_decision_point := 'api_gateway_source_sender_client_checked',
  p_decision_outcome := 'rejected',
  p_performed_by_system := 'pgtap.console_v2_api_gateway_read_registry_repair',
  p_correlation_id := '8061cd90-e981-4e71-949b-442f7094edce'::uuid,
  p_decision_inputs := jsonb_build_object(
    'method', 'POST',
    'path', '/api/ship/request/by-email',
    'route_id', COALESCE(
      (
        SELECT id
          FROM public.api_routes
         WHERE upper(method) = 'POST'
           AND path_template = '/api/ship/request/by-email'
         ORDER BY created_at
         LIMIT 1
      ),
      '1dc4045f-7fb4-48ad-94a0-64172e5e0c8b'::uuid
    ),
    'canonical_intent', 'shipment.create',
    'source_id', 'f1e63934-5eea-4426-9e2e-304fcfe56190'
  ),
  p_decision_reason := 'API Gateway shipment-create source must be bound to an active sender/client before intake can create shipment workflow state.'
);

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
  metadata
)
VALUES (
  '77a9af25-2c62-4a6f-a7a8-59f6aeab3125'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  '13ddf94f-fc6a-4d36-bd8a-e524f2f4e01c'::uuid,
  'delivery',
  'API-REQ-LINK-001',
  'API-REQ-LINK-CLIENT-001',
  1,
  'created',
  jsonb_build_object(
    'source',
    jsonb_build_object(
      'api_gateway_request_id',
      '9ec51e78-898e-46ec-95b7-d98e6a30c66b'
    )
  )
)
ON CONFLICT DO NOTHING;

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
  metadata
)
VALUES (
  '77a9af25-2c62-4a6f-a7a8-59f6aeab3126'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  '13ddf94f-fc6a-4d36-bd8a-e524f2f4e01c'::uuid,
  'delivery',
  'API-REQ-LINK-FAILED-001',
  'API-REQ-LINK-FAILED-CLIENT-001',
  1,
  'pending',
  jsonb_build_object(
    'source',
    jsonb_build_object(
      'api_gateway_request_id',
      '8061cd90-e981-4e71-949b-442f7094edc8'
    )
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
  '8061cd90-e981-4e71-949b-442f7094edcc'::uuid,
  '77a9af25-2c62-4a6f-a7a8-59f6aeab3126'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'b2bc5f7c-8795-4147-a736-c017f0f957e1'::uuid,
  'api_gateway_materialized',
  'operational',
  'pending',
  jsonb_build_object(
    'api_gateway_request_id', '8061cd90-e981-4e71-949b-442f7094edca',
    'operation', 'linked_existing_shipment',
    'client_reference_number', 'API-REQ-LINK-FAILED-CLIENT-001'
  ),
  now(),
  now(),
  'pgtap.console_v2_api_gateway_read_registry_repair'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '35e7dd59-3d8f-4a28-9c92-d7d2996e9a9f'::uuid,
  '8061cd90-e981-4e71-949b-442f7094edbf'::uuid,
  'console-v2-api-gateway-registry@example.test',
  'Console V2 API Gateway Registry Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', '35e7dd59-3d8f-4a28-9c92-d7d2996e9a9f', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '35e7dd59-3d8f-4a28-9c92-d7d2996e9a9f',
    'role', 'authenticated',
    'email', 'console-v2-api-gateway-registry@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('api_gateway_observability', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'api_gateway_observability lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('api_gateway_rate_limits_summary', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'api_gateway_rate_limits_summary lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('api_gateway_requests', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'api_gateway_requests projection lists through ui_list_resource_v1'
);

SELECT is(
  (
    SELECT (public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )->>'total')::INT
  ),
  1,
  'api_gateway_requests request-first projection returns the pre-dispatch intake row'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,path}'
  ),
  '/api/ship/request/by-email',
  'api_gateway_requests projection exposes the inbound path'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,method}'
  ),
  'POST',
  'api_gateway_requests projection exposes the inbound method'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,source_label}'
  ),
  'Console V2 API Gateway Registry Source',
  'api_gateway_requests projection exposes source context'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,client_label}'
  ),
  'Console V2 API Gateway Registry Client',
  'api_gateway_requests projection exposes operator client context'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,sender_label}'
  ),
  'Console V2 API Gateway Registry Sender',
  'api_gateway_requests projection exposes operator sender context'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,shipment_id}'
  ),
  '77a9af25-2c62-4a6f-a7a8-59f6aeab3125',
  'api_gateway_requests projection exposes linked shipment context'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,tracking_number}'
  ),
  'API-REQ-LINK-001',
  'api_gateway_requests projection exposes linked shipment tracking number'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,shipment_status}'
  ),
  'created',
  'api_gateway_requests projection exposes linked shipment status'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,intake_state}'
  ),
  'shipment_materialized',
  'api_gateway_requests projection lets linked shipment lineage win over pre-dispatch state'
);

SELECT ok(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,error_code}'
  ) IS NULL,
  'api_gateway_requests projection clears synthetic pre-dispatch error once shipment materializes'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edc6"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,intake_state}'
  ),
  'provider_failed',
  'api_gateway_requests projection exposes provider failure instead of stale workflow queued state'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edc6"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,error_code}'
  ),
  'credential rejected',
  'api_gateway_requests projection exposes provider failure message'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edc8"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,intake_state}'
  ),
  'shipment_materialized',
  'api_gateway_requests projection lets linked shipment lineage win over provider failure state'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edc8"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,error_code}'
  ),
  'credential rejected',
  'api_gateway_requests projection preserves provider diagnostic when materialized shipment has failed outbound readback'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edc8"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,tracking_number}'
  ),
  'API-REQ-LINK-FAILED-001',
  'api_gateway_requests projection keeps shipment handoff visible with provider diagnostics'
);

SELECT ok(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"9ec51e78-898e-46ec-95b7-d98e6a30c66b"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>'{items,0,status_code}' = 'null'::jsonb
  ),
  'api_gateway_requests projection keeps status_code null until backend dispatch exists'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edcd"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,intake_state}'
  ),
  'source_binding_rejected',
  'api_gateway_requests projection exposes missing sender/client rejection state'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edcd"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,error_code}'
  ),
  'api_gateway_source_missing_sender_client',
  'api_gateway_requests projection exposes missing sender/client error code'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edcd"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,status_code}'
  ),
  '400',
  'api_gateway_requests projection exposes missing sender/client status code'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edcd"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,outbound_error_message}'
  ),
  'API Gateway shipment-create source must be bound to an active sender/client before intake can create shipment workflow state.',
  'api_gateway_requests projection exposes missing sender/client operator message'
);

SELECT ok(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edcd"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>'{items,0,shipment_id}' = 'null'::jsonb
  ),
  'api_gateway_requests projection does not fabricate a shipment for missing sender/client rejection'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edca"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,shipment_id}'
  ),
  '77a9af25-2c62-4a6f-a7a8-59f6aeab3126',
  'api_gateway_requests projection resolves duplicate/replay shipment handoff from shipment_actions lineage'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edca"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,tracking_number}'
  ),
  'API-REQ-LINK-FAILED-001',
  'api_gateway_requests projection exposes tracking for action-lineage duplicate/replay handoff'
);

SELECT is(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edca"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,intake_state}'
  ),
  'shipment_materialized',
  'api_gateway_requests projection treats action-lineage duplicate/replay as materialized'
);

SELECT ok(
  (
    SELECT public.ui_list_resource_v1(
      'api_gateway_requests',
      '{"request_id":"8061cd90-e981-4e71-949b-442f7094edca"}'::jsonb,
      5,
      0,
      NULL::jsonb
    )#>>'{items,0,error_code}'
  ) IS NULL,
  'api_gateway_requests projection does not show not_dispatched for action-lineage duplicate/replay handoff'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('provider_health_logs', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'provider_health_logs lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('api_routes', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'api_routes registry remains available for the routes tab'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;

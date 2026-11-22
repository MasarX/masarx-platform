CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

SELECT has_function(
  'public',
  'integration_plugin_default_route_policy_v1',
  ARRAY['text', 'jsonb', 'uuid'],
  'integration_plugin_default_route_policy_v1 exists'
);

SELECT has_function(
  'public',
  'integration_plugin_resolve_api_route_path_v1',
  ARRAY['text', 'uuid', 'text', 'text', 'text', 'uuid'],
  'integration_plugin_resolve_api_route_path_v1 exists'
);

SELECT is(
  public.integration_plugin_default_route_policy_v1(
    'api',
    jsonb_build_object('template_name', 'api_gateway_shipment_create_default_v1', 'intent', 'shipment.create'),
    NULL
  ) #>> '{postprocess,mode}',
  'shipment_create_v1',
  'API shipment-create plugins default to shipment_create_v1 postprocess'
);

SELECT is(
  (
    public.integration_plugin_default_route_policy_v1(
      'api',
      jsonb_build_object('template_name', 'api_gateway_shipment_create_default_v1', 'intent', 'shipment.create'),
      NULL
    ) #>> '{postprocess,label,enabled}'
  )::boolean,
  TRUE,
  'API shipment-create plugins default label queueing on'
);

SELECT is(
  public.integration_plugin_default_route_policy_v1(
    'api',
    jsonb_build_object('template_name', 'api_gateway_shipment_create_default_v1', 'intent', 'shipment.create'),
    NULL
  ) #>> '{postprocess,label,label_type}',
  'shipping',
  'API shipment-create plugins default to shipping labels'
);

SELECT is(
  public.integration_plugin_default_route_policy_v1(
    'api',
    jsonb_build_object('template_name', 'api_gateway_shipment_create_default_v1', 'intent', 'shipment.create'),
    NULL
  ) #>> '{postprocess,extract,provider_tracking_number_path}',
  'barcode',
  'API shipment-create plugins default to common provider tracking extraction'
);

SELECT is(
  public.integration_plugin_default_route_policy_v1(
    'api',
    jsonb_build_object('template_name', 'api_gateway_shipment_create_default_v1', 'intent', 'shipment.create'),
    NULL
  ) #>> '{postprocess,extract,recipient_phone_path}',
  'recipient.phone',
  'API shipment-create plugins default to common request recipient extraction'
);

SELECT is(
  public.integration_plugin_default_route_policy_v1(
    'webhook',
    jsonb_build_object('template_name', 'api_gateway_shipment_create_default_v1', 'intent', 'shipment.create'),
    NULL
  ),
  '{}'::jsonb,
  'Webhook plugins do not inherit API route postprocess defaults'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    LIKE '%integration_plugin_default_route_policy_v1(%',
  'activation merges row-driven default route policy'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_validate_v1(uuid,jsonb,boolean)'::regprocedure)
    LIKE '%integration_plugin_egress_policy%'
    AND pg_get_functiondef('public.integration_plugin_validate_v1(uuid,jsonb,boolean)'::regprocedure)
      LIKE '%http_allowed_hosts%',
  'plugin validation resolves row-driven egress policy http host exceptions'
);

SELECT ok(
  pg_get_functiondef('public.resolve_effective_outbound_egress_policy_v1(uuid)'::regprocedure)
    LIKE '%http_allowed_hosts%',
  'outbound edge dispatch keeps row-driven integration plugin HTTP host exceptions in the effective egress policy'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd4622230-0000-4000-8000-000000000101'::uuid,
  'Console V2 Plugin Label Defaults Org',
  'console-v2-plugin-label-defaults-org'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'd4622230-0000-4000-8000-000000000102'::uuid,
  'd4622230-0000-4000-8000-000000000101'::uuid,
  'Console V2 Plugin Label Defaults Client',
  'console-v2-plugin-label-defaults-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  'd4622230-0000-4000-8000-000000000103'::uuid,
  'd4622230-0000-4000-8000-000000000102'::uuid,
  'Console V2 Plugin Label Defaults Sender',
  'Console V2 Plugin Label Defaults Sender',
  FALSE,
  TRUE,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    status = EXCLUDED.status;

INSERT INTO public.api_route_packs (
  id,
  name,
  enabled,
  scope_type,
  scope_id,
  managed_by,
  managed_metadata
)
VALUES (
  'd4622230-0000-4000-8000-000000000107'::uuid,
  'console-v2-plugin-label-defaults-existing-pack',
  TRUE,
  'tenant',
  'd4622230-0000-4000-8000-000000000101'::uuid,
  'platform',
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET enabled = EXCLUDED.enabled,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id;

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  method,
  path_template,
  scope_type,
  scope_id,
  policy,
  managed_by,
  managed_metadata
)
VALUES (
  'd4622230-0000-4000-8000-000000000108'::uuid,
  'd4622230-0000-4000-8000-000000000107'::uuid,
  'console-v2-plugin-label-defaults-existing-route',
  'POST',
  '/plugin-label-defaults/orders',
  'tenant',
  'd4622230-0000-4000-8000-000000000101'::uuid,
  '{}'::jsonb,
  'platform',
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET method = EXCLUDED.method,
    path_template = EXCLUDED.path_template,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id;

SELECT public.upsert_settings_value_v1(
  'integration_plugin_egress_policy',
  'tenant',
  'd4622230-0000-4000-8000-000000000101'::uuid,
  jsonb_build_object(
    'version', 1,
    'enforce_https_only', TRUE,
    'block_private_networks', TRUE,
    'http_allowed_hosts', jsonb_build_array('provider.example.test'),
    'allowed_methods', jsonb_build_array('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
    'max_payload_bytes', 262144,
    'max_timeout_seconds', 60,
    'follow_redirects', FALSE,
    'header_allowlist', jsonb_build_array('accept', 'content-type', 'authorization', 'x-api-key', 'api-key', 'user-agent')
  ),
  1,
  'pgTAP local Plugin Studio provider host exception'
);

INSERT INTO public.integration_plugins (
  id,
  organization_id,
  plugin_key,
  name,
  plugin_kind,
  status,
  managed_by
)
VALUES (
  'd4622230-0000-4000-8000-000000000104'::uuid,
  'd4622230-0000-4000-8000-000000000101'::uuid,
  'console-v2-plugin-label-defaults',
  'Console V2 Plugin Label Defaults',
  'api',
  'approved',
  'integration_plugin'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    plugin_kind = EXCLUDED.plugin_kind,
    status = EXCLUDED.status;

INSERT INTO public.integration_plugin_versions (
  id,
  plugin_id,
  organization_id,
  version_no,
  status,
  source_type,
  source_payload,
  normalized_contract,
  inbound_config,
  mapping_config,
  workflow_binding,
  outbound_operations,
  auth_bindings,
  metadata
)
VALUES (
  'd4622230-0000-4000-8000-000000000105'::uuid,
  'd4622230-0000-4000-8000-000000000104'::uuid,
  'd4622230-0000-4000-8000-000000000101'::uuid,
  1,
  'approved',
  'curl',
  jsonb_build_object('curl', 'curl https://vendor.example.test/v1/orders'),
  '{}'::jsonb,
  jsonb_build_object(
    'route',
    jsonb_build_object(
      'method', 'POST',
      'path_template', '/plugin-label-defaults/orders',
      'upstream_method', 'POST',
      'upstream_path_template', '/v1/orders',
      'upstream_base_url', 'https://vendor.example.test'
    )
  ),
  '{}'::jsonb,
  jsonb_build_object('template_name', 'api_gateway_shipment_create_default_v1', 'intent', 'shipment.create'),
  jsonb_build_array(
    jsonb_build_object(
      'operation_name', 'forward_event',
      'method', 'POST',
      'url_template', 'https://vendor.example.test/v1/orders',
      'headers_template', jsonb_build_object('content-type', 'application/json'),
      'body_template', jsonb_build_object('payload', '$.payload'),
      'request_mappings', jsonb_build_object('body', jsonb_build_object('payload', '$.payload')),
      'timeout_seconds', 30
    )
  ),
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    workflow_binding = EXCLUDED.workflow_binding,
    inbound_config = EXCLUDED.inbound_config,
    outbound_operations = EXCLUDED.outbound_operations;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  status,
  access_scope_type,
  access_scope_id
)
VALUES (
  'd4622230-0000-4000-8000-000000000106'::uuid,
  'd4622230-0000-4000-8000-000000000101'::uuid,
  'console-v2-plugin-label-defaults@example.test',
  'Console V2 Plugin Label Defaults Auditor',
  'super_admin',
  'active',
  'platform',
  NULL
)
ON CONFLICT (id) DO UPDATE
SET user_type = EXCLUDED.user_type,
    status = EXCLUDED.status,
    access_scope_type = EXCLUDED.access_scope_type,
    access_scope_id = EXCLUDED.access_scope_id;

SELECT set_config('request.jwt.claim.sub', 'd4622230-0000-4000-8000-000000000106', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d4622230-0000-4000-8000-000000000106","role":"authenticated"}',
  true
);

SELECT is(
  (
    public.integration_plugin_validate_v1(
      'd4622230-0000-4000-8000-000000000105'::uuid,
      '{}'::jsonb,
      FALSE
    ) ->> 'ok'
  )::boolean,
  TRUE,
  'plugin validation allows explicit row-driven HTTP proof host while keeping HTTPS as default'
);

CREATE TEMP TABLE pgtap_plugin_label_activation AS
SELECT public.integration_plugin_activate_v1(
  'd4622230-0000-4000-8000-000000000105'::uuid,
  'tenant',
  'd4622230-0000-4000-8000-000000000101'::uuid,
  'pgTAP plugin label default proof'
) AS result;

SELECT is(
  (
    SELECT ar.path_template
      FROM pgtap_plugin_label_activation r
      JOIN public.api_routes ar
        ON ar.id = (r.result->>'api_route_id')::uuid
  ),
  '/plugins/console-v2-plugin-label-defaults/plugin-label-defaults/orders',
  'activation namespaces Plugin Studio API route when the requested route path is already claimed'
);

SELECT is(
  (
    SELECT ar.policy #>> '{postprocess,mode}'
      FROM pgtap_plugin_label_activation r
      JOIN public.api_routes ar
        ON ar.id = (r.result->>'api_route_id')::uuid
  ),
  'shipment_create_v1',
  'activation materializes shipment_create_v1 postprocess policy'
);

SELECT is(
  (
    SELECT (ar.policy #>> '{postprocess,label,enabled}')::boolean
      FROM pgtap_plugin_label_activation r
      JOIN public.api_routes ar
        ON ar.id = (r.result->>'api_route_id')::uuid
  ),
  TRUE,
  'activation materializes label queueing policy'
);

SELECT is(
  (
    SELECT ar.policy #>> '{postprocess,extract,provider_tracking_number_path}'
      FROM pgtap_plugin_label_activation r
      JOIN public.api_routes ar
        ON ar.id = (r.result->>'api_route_id')::uuid
  ),
  'barcode',
  'activation materializes default provider tracking extraction policy'
);

SELECT is(
  (
    SELECT p.metadata->>'base_url'
      FROM pgtap_plugin_label_activation r
      JOIN public.providers p
        ON p.id = (r.result->>'provider_id')::uuid
  ),
  'https://vendor.example.test',
  'activation materializes provider base_url from operator-authored source URL'
);

SELECT * FROM finish();
ROLLBACK;

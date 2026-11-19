-- pgTAP: Console V2 plugin export handoff returns backend-readable,
-- tenant-scoped handoff data for the active plugin version.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(26);

SELECT has_function(
  'public',
  'integration_plugin_export_handoff_v1',
  ARRAY['uuid', 'text'],
  'public plugin export handoff RPC exists'
);

SELECT has_function(
  'api',
  'integration_plugin_export_handoff_v1',
  ARRAY['uuid', 'text'],
  'api plugin export handoff wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.integration_plugin_export_handoff_v1(uuid,text)',
    'EXECUTE'
  ),
  'authenticated users can call api plugin export handoff wrapper'
);

SELECT matches(
  pg_get_functiondef('public.integration_plugin_export_handoff_v1(uuid,text)'::regprocedure),
  'integration_plugins\.write',
  'export handoff backend capability gate requires integration_plugins.write because handoff includes source-token setup data'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'Console V2 Plugin Export Handoff Org',
  'console-v2-plugin-export-handoff-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  'e4872250-0000-4000-8000-000000000002'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'webhook_inbound',
  'console-v2-plugin-export-handoff',
  '{"target":"shipments.create","version":1}'::jsonb,
  1,
  'Console V2 plugin export handoff pgTAP mapping'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    mapping_config = EXCLUDED.mapping_config;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES ('e4872250-0000-4000-8000-000000000021', 'e4872250-0000-4000-8000-000000000001',
        'Export fixture client', 'export-fixture-client', 'active');

INSERT INTO public.senders (id, client_id, name, brand_name, status)
VALUES ('e4872250-0000-4000-8000-000000000022', 'e4872250-0000-4000-8000-000000000021',
        'Export fixture sender', 'Fixture', 'active');

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  enabled,
  rate_limit_per_hour,
  managed_metadata,
  sender_id
)
VALUES (
  'e4872250-0000-4000-8000-000000000003'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-export-handoff-source',
  'Console V2 Plugin Export Handoff Source',
  'generic',
  'pgtap-export-handoff-token',
  'e4872250-0000-4000-8000-000000000002'::uuid,
  TRUE,
  240,
  '{"managed_by":"integration_plugin"}'::jsonb,
  'e4872250-0000-4000-8000-000000000022'::uuid
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    sender_id = EXCLUDED.sender_id,
    enabled = TRUE,
    mapping_config_id = EXCLUDED.mapping_config_id,
    managed_metadata = EXCLUDED.managed_metadata;

INSERT INTO public.integration_plugins (
  id,
  organization_id,
  plugin_key,
  name,
  plugin_kind,
  status,
  rollout_tier,
  reusable_within_tenant,
  managed_by
)
VALUES (
  'e4872250-0000-4000-8000-000000000004'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-export-handoff',
  'Console V2 Plugin Export Handoff',
  'webhook',
  'active',
  'tenant',
  TRUE,
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
  validation_summary,
  metadata
)
VALUES (
  'e4872250-0000-4000-8000-000000000005'::uuid,
  'e4872250-0000-4000-8000-000000000004'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  1,
  'active',
  'webhook_sample',
  '{}'::jsonb,
  '{"source_type":"webhook_sample","plugin_kind":"webhook"}'::jsonb,
  '{"webhook":{"event_type_path":"event.type"}}'::jsonb,
  '{"target":"shipments.create","version":1}'::jsonb,
  '{"mode":"attach_existing","template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET plugin_id = EXCLUDED.plugin_id,
    organization_id = EXCLUDED.organization_id,
    status = EXCLUDED.status,
    workflow_binding = EXCLUDED.workflow_binding;

UPDATE public.integration_plugins
   SET active_version_id = 'e4872250-0000-4000-8000-000000000005'::uuid
 WHERE id = 'e4872250-0000-4000-8000-000000000004'::uuid;

INSERT INTO public.integration_plugin_bindings (
  id,
  plugin_version_id,
  organization_id,
  scope_type,
  scope_id,
  binding_type,
  runtime_resource_type,
  runtime_resource_id,
  enabled,
  activation_payload
)
VALUES (
  'e4872250-0000-4000-8000-000000000006'::uuid,
  'e4872250-0000-4000-8000-000000000005'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'tenant',
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'webhook_source',
  'webhook_sources',
  'e4872250-0000-4000-8000-000000000003'::uuid,
  TRUE,
  '{"issued_token":"pgtap-export-handoff-token"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET plugin_version_id = EXCLUDED.plugin_version_id,
    organization_id = EXCLUDED.organization_id,
    runtime_resource_id = EXCLUDED.runtime_resource_id,
    enabled = TRUE,
    activation_payload = EXCLUDED.activation_payload;

INSERT INTO public.api_route_packs (
  id,
  name,
  description,
  enabled
)
VALUES (
  'e4872250-0000-4000-8000-000000000008'::uuid,
  'console-v2-plugin-export-handoff-pack',
  'Console V2 plugin export handoff API route pack',
  TRUE
)
ON CONFLICT (id) DO UPDATE
SET enabled = TRUE;

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
  'e4872250-0000-4000-8000-000000000009'::uuid,
  'e4872250-0000-4000-8000-000000000008'::uuid,
  'Console V2 Plugin Export Handoff API Route',
  TRUE,
  'POST',
  '/api/plugin-export-handoff/shipments',
  'tenant',
  'e4872250-0000-4000-8000-000000000001'::uuid,
  '{"intent":"shipment.create"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET pack_id = EXCLUDED.pack_id,
    route_name = EXCLUDED.route_name,
    enabled = TRUE,
    method = EXCLUDED.method,
    path_template = EXCLUDED.path_template,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    policy = EXCLUDED.policy;

INSERT INTO public.integration_plugins (
  id,
  organization_id,
  plugin_key,
  name,
  plugin_kind,
  status,
  rollout_tier,
  reusable_within_tenant,
  managed_by
)
VALUES (
  'e4872250-0000-4000-8000-000000000010'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-export-handoff-api',
  'Console V2 Plugin Export Handoff API',
  'api',
  'active',
  'tenant',
  TRUE,
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
  validation_summary,
  metadata
)
VALUES (
  'e4872250-0000-4000-8000-000000000011'::uuid,
  'e4872250-0000-4000-8000-000000000010'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  1,
  'active',
  'openapi',
  '{}'::jsonb,
  '{"source_type":"openapi","plugin_kind":"api"}'::jsonb,
  '{"route":{"path_template":"/api/plugin-export-handoff/shipments","method":"POST"}}'::jsonb,
  '{"target":"shipments.create","version":1}'::jsonb,
  '{"mode":"attach_existing","template_name":"api_gateway_shipment_create_v1","intent":"shipment.create"}'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET plugin_id = EXCLUDED.plugin_id,
    organization_id = EXCLUDED.organization_id,
    status = EXCLUDED.status,
    workflow_binding = EXCLUDED.workflow_binding;

UPDATE public.integration_plugins
   SET active_version_id = 'e4872250-0000-4000-8000-000000000011'::uuid
 WHERE id = 'e4872250-0000-4000-8000-000000000010'::uuid;

INSERT INTO public.integration_plugin_bindings (
  id,
  plugin_version_id,
  organization_id,
  scope_type,
  scope_id,
  binding_type,
  runtime_resource_type,
  runtime_resource_id,
  enabled,
  activation_payload
)
VALUES (
  'e4872250-0000-4000-8000-000000000012'::uuid,
  'e4872250-0000-4000-8000-000000000011'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'tenant',
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'webhook_source',
  'webhook_sources',
  'e4872250-0000-4000-8000-000000000003'::uuid,
  TRUE,
  '{"issued_token":"pgtap-export-handoff-token"}'::jsonb
),
(
  'e4872250-0000-4000-8000-000000000013'::uuid,
  'e4872250-0000-4000-8000-000000000011'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'tenant',
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'api_route',
  'api_routes',
  'e4872250-0000-4000-8000-000000000009'::uuid,
  TRUE,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET plugin_version_id = EXCLUDED.plugin_version_id,
    organization_id = EXCLUDED.organization_id,
    runtime_resource_type = EXCLUDED.runtime_resource_type,
    runtime_resource_id = EXCLUDED.runtime_resource_id,
    enabled = TRUE,
    activation_payload = EXCLUDED.activation_payload;

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
  'e4872250-0000-4000-8000-000000000007'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-export-handoff-auditor@example.test',
  'Console V2 Plugin Export Handoff Auditor',
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
  'e4872250-0000-4000-8000-000000000015'::uuid,
  'e4872250-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-export-handoff-readonly@example.test',
  'Console V2 Plugin Export Handoff Readonly',
  'billing_viewer',
  'active',
  'tenant',
  NULL
)
ON CONFLICT (id) DO UPDATE
SET user_type = EXCLUDED.user_type,
    status = EXCLUDED.status,
    access_scope_type = EXCLUDED.access_scope_type,
    access_scope_id = EXCLUDED.access_scope_id;

SELECT set_config('request.jwt.claim.sub', 'e4872250-0000-4000-8000-000000000007', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e4872250-0000-4000-8000-000000000007","role":"authenticated"}',
  true
);

CREATE TEMP TABLE pgtap_plugin_export_handoff_result AS
SELECT api.integration_plugin_export_handoff_v1(
  'e4872250-0000-4000-8000-000000000005'::uuid,
  'https://console.example.test/'
) AS result;

SELECT is(
  (SELECT result->>'kind' FROM pgtap_plugin_export_handoff_result),
  'webhook',
  'export handoff returns webhook kind'
);

SELECT is(
  (SELECT result->>'endpoint' FROM pgtap_plugin_export_handoff_result),
  'https://console.example.test/functions/v1/webhook-receiver',
  'export handoff returns trimmed webhook receiver endpoint'
);

SELECT is(
  (SELECT result->>'token' FROM pgtap_plugin_export_handoff_result),
  'pgtap-export-handoff-token',
  'export handoff returns the active source token for operator redaction'
);

SELECT is(
  (SELECT result #>> '{headers,authorization}' FROM pgtap_plugin_export_handoff_result),
  'Bearer pgtap-export-handoff-token',
  'export handoff returns bearer authorization header for operator redaction'
);

SELECT matches(
  (SELECT result->>'sample_curl' FROM pgtap_plugin_export_handoff_result),
  'Bearer pgtap-export-handoff-token',
  'export handoff sample curl includes bearer-token setup data'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_integration_plugin_directory d
     WHERE d.id = 'e4872250-0000-4000-8000-000000000004'::uuid
       AND d.active_version_id = 'e4872250-0000-4000-8000-000000000005'::uuid
  ),
  'plugin directory readback resolves the active version used for export handoff'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = 'e4872250-0000-4000-8000-000000000005'::uuid
       AND b.binding_type = 'webhook_source'
       AND b.enabled = TRUE
       AND b.activation_payload->>'issued_token' = 'pgtap-export-handoff-token'
  ),
  'plugin binding readback confirms source token lineage'
);

SELECT set_config('request.jwt.claim.sub', 'e4872250-0000-4000-8000-000000000015', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e4872250-0000-4000-8000-000000000015","role":"authenticated"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    SELECT api.integration_plugin_export_handoff_v1(
      'e4872250-0000-4000-8000-000000000005'::uuid,
      'https://console.example.test/'
    )
  $$,
  '42501',
  NULL,
  'export handoff denies token-bearing readback without integration_plugins.write'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'e4872250-0000-4000-8000-000000000007', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e4872250-0000-4000-8000-000000000007","role":"authenticated"}',
  true
);

UPDATE public.webhook_sources
   SET enabled = FALSE
 WHERE id = 'e4872250-0000-4000-8000-000000000003'::uuid;

SELECT throws_like(
  $$
    SELECT api.integration_plugin_export_handoff_v1(
      'e4872250-0000-4000-8000-000000000005'::uuid,
      'https://console.example.test/'
    )
  $$,
  '%requires an enabled tenant webhook source%',
  'export handoff fails closed when runtime webhook source is disabled'
);

UPDATE public.webhook_sources
   SET enabled = TRUE,
       auth_token = 'pgtap-export-handoff-token-mismatch'
 WHERE id = 'e4872250-0000-4000-8000-000000000003'::uuid;

CREATE TEMP TABLE pgtap_plugin_export_handoff_refresh_result AS
SELECT api.integration_plugin_export_handoff_v1(
  'e4872250-0000-4000-8000-000000000005'::uuid,
  'https://console.example.test/'
) AS result;

SELECT ok(
  (SELECT COALESCE(length(result->>'token'), 0) >= 32 FROM pgtap_plugin_export_handoff_refresh_result),
  'export handoff refreshes a concrete token when webhook source token diverges from binding'
);

SELECT isnt(
  (SELECT result->>'token' FROM pgtap_plugin_export_handoff_refresh_result),
  'pgtap-export-handoff-token',
  'export handoff refresh does not return the stale binding token'
);

SELECT isnt(
  (SELECT result->>'token' FROM pgtap_plugin_export_handoff_refresh_result),
  'pgtap-export-handoff-token-mismatch',
  'export handoff refresh does not return the superseded source token'
);

SELECT ok(
  (
    SELECT crypt(r.result->>'token', s.auth_token_hash) = s.auth_token_hash
      FROM pgtap_plugin_export_handoff_refresh_result r
      JOIN public.webhook_sources s
        ON s.id = 'e4872250-0000-4000-8000-000000000003'::uuid
  ),
  'export handoff refreshed token matches canonical webhook source hash'
);

SELECT is(
  (
    SELECT b.activation_payload->>'issued_token'
      FROM public.integration_plugin_bindings b
     WHERE b.id = 'e4872250-0000-4000-8000-000000000006'::uuid
  ),
  (SELECT result->>'token' FROM pgtap_plugin_export_handoff_refresh_result),
  'export handoff refresh updates plugin binding token lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.webhook_source_token_history h
     WHERE h.source_id = 'e4872250-0000-4000-8000-000000000003'::uuid
       AND h.retired_reason = 'rotated'
       AND crypt('pgtap-export-handoff-token-mismatch', h.retired_auth_token_hash) = h.retired_auth_token_hash
       AND h.correlation_id = (
         SELECT (b.activation_payload->>'issued_token_refresh_correlation_id')::uuid
           FROM public.integration_plugin_bindings b
          WHERE b.runtime_resource_id = h.source_id
            AND b.plugin_version_id = 'e4872250-0000-4000-8000-000000000005'
            AND b.binding_type = 'webhook_source' AND b.enabled
       )
  ),
  'export handoff refresh preserves retired source-token hash lineage without raw token storage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log dl
      JOIN public.integration_plugin_bindings b
        ON b.id = 'e4872250-0000-4000-8000-000000000006'::uuid
     WHERE dl.resource_type = 'webhook_source'
       AND dl.resource_id = 'e4872250-0000-4000-8000-000000000003'::uuid
       AND dl.decision_point = 'integration_plugin_export_handoff_v1'
       AND dl.decision_outcome = 'rotated'
       AND dl.correlation_id = (b.activation_payload->>'issued_token_refresh_correlation_id')::uuid
  ),
  'export handoff refresh writes token-rotation decision lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events de
      JOIN public.integration_plugin_bindings b
        ON b.id = 'e4872250-0000-4000-8000-000000000006'::uuid
     WHERE de.resource_type = 'webhook_source'
       AND de.resource_id = 'e4872250-0000-4000-8000-000000000003'::uuid
       AND de.event_type = 'webhook_source.token_rotated'
       AND de.correlation_id = (b.activation_payload->>'issued_token_refresh_correlation_id')::uuid
  ),
  'export handoff refresh emits workflow-engine-first domain event lineage'
);

UPDATE public.webhook_sources
   SET enabled = TRUE,
       auth_token = 'pgtap-export-handoff-token'
 WHERE id = 'e4872250-0000-4000-8000-000000000003'::uuid;

UPDATE public.integration_plugin_bindings
   SET activation_payload = (
         jsonb_set(
           COALESCE(activation_payload, '{}'::jsonb),
           '{issued_token}',
           to_jsonb('pgtap-export-handoff-token'::text),
           TRUE
         )
         - 'issued_token_refreshed_at'
         - 'issued_token_refreshed_by'
         - 'issued_token_refresh_reason'
         - 'issued_token_refresh_correlation_id'
       )
 WHERE id IN (
   'e4872250-0000-4000-8000-000000000006'::uuid,
   'e4872250-0000-4000-8000-000000000012'::uuid
 );

CREATE TEMP TABLE pgtap_plugin_export_handoff_api_result AS
SELECT api.integration_plugin_export_handoff_v1(
  'e4872250-0000-4000-8000-000000000011'::uuid,
  'https://console.example.test/'
) AS result;

SELECT is(
  (SELECT result->>'endpoint' FROM pgtap_plugin_export_handoff_api_result),
  'https://console.example.test/functions/v1/api-gateway/t/pgtap-export-handoff-token/api/plugin-export-handoff/shipments',
  'api export handoff returns concrete API Gateway route endpoint'
);

SELECT is(
  (SELECT result->>'method' FROM pgtap_plugin_export_handoff_api_result),
  'POST',
  'api export handoff returns route method'
);

UPDATE public.api_routes
   SET enabled = FALSE
 WHERE id = 'e4872250-0000-4000-8000-000000000009'::uuid;

SELECT throws_like(
  $$
    SELECT api.integration_plugin_export_handoff_v1(
      'e4872250-0000-4000-8000-000000000011'::uuid,
      'https://console.example.test/'
    )
  $$,
  '%requires a concrete enabled api route%',
  'api export handoff fails closed when route binding points to a disabled route'
);

SELECT throws_like(
  $$
    SELECT api.integration_plugin_export_handoff_v1(
      'e4872250-0000-4000-8000-000000000005'::uuid,
      NULL
    )
  $$,
  '%requires a concrete base_url%',
  'export handoff fails closed when base_url is not concrete'
);

UPDATE public.integration_plugin_bindings
   SET enabled = FALSE
 WHERE id = 'e4872250-0000-4000-8000-000000000006'::uuid;

SELECT throws_like(
  $$
    SELECT api.integration_plugin_export_handoff_v1(
      'e4872250-0000-4000-8000-000000000005'::uuid,
      'https://console.example.test/'
    )
  $$,
  '%requires a webhook source runtime binding%',
  'export handoff fails closed when no enabled source token binding exists'
);

SELECT * FROM finish();
ROLLBACK;

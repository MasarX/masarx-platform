-- Proves Plugin Studio API activation contracts resolve real source context
-- and sanitize provider-bound headers before API Gateway egress.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

SELECT has_function(
  'public',
  'integration_plugin_activation_requires_source_sender_v1',
  ARRAY['text', 'jsonb', 'jsonb'],
  'source sender requirement helper exists'
);

SELECT has_function(
  'public',
  'integration_plugin_resolve_activation_sender_v1',
  ARRAY['uuid', 'text', 'uuid'],
  'activation sender resolver exists'
);

SELECT has_function(
  'public',
  'integration_plugin_activation_provider_base_url_v1',
  ARRAY['uuid'],
  'activation provider base URL resolver exists'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.integration_plugin_activation_requires_source_sender_v1(text,jsonb,jsonb)',
    'EXECUTE'
  ),
  FALSE,
  'source sender requirement helper is not directly executable by authenticated users'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.integration_plugin_resolve_activation_sender_v1(uuid,text,uuid)',
    'EXECUTE'
  ),
  FALSE,
  'activation sender resolver is not directly executable by authenticated users'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.integration_plugin_activation_provider_base_url_v1(uuid)',
    'EXECUTE'
  ),
  FALSE,
  'activation provider base URL resolver is not directly executable by authenticated users'
);

SELECT is(
  public.integration_plugin_default_workflow_binding_v1('api', NULL)->>'intent',
  'shipment.create',
  'API Plugin Studio default workflow binding carries shipment.create intent'
);

SELECT ok(
  COALESCE(
    (
      public.integration_plugin_resolve_policy_v1('integration_plugin_policy', NULL)
        #> '{studio_defaults,source_binding,api,required_for_templates}'
    ) ? 'api_gateway_shipment_create_default_v1',
    FALSE
  ),
  'integration_plugin_policy marks API shipment-create template as source-binding-required'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd4622230-0000-4000-8000-000000000001'::uuid,
  'Console V2 Plugin Source Binding Org',
  'console-v2-plugin-source-binding-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'd4622230-0000-4000-8000-000000000002'::uuid,
  'd4622230-0000-4000-8000-000000000001'::uuid,
  'Console V2 Plugin Source Binding Client',
  'console-v2-plugin-source-binding-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  'd4622230-0000-4000-8000-000000000003'::uuid,
  'd4622230-0000-4000-8000-000000000002'::uuid,
  COALESCE(public.resolve_saas_onboarding_policy_v1() #>> '{client_defaults,default_sender_name}', 'Default Sender'),
  'Console V2 Plugin Source Binding Sender',
  false,
  true,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    name = EXCLUDED.name;

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
  'd4622230-0000-4000-8000-000000000004'::uuid,
  'd4622230-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-source-binding',
  'Console V2 Plugin Source Binding',
  'api',
  'approved',
  'tenant',
  true,
  'integration_plugin'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    plugin_kind = EXCLUDED.plugin_kind;

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
  'd4622230-0000-4000-8000-000000000005'::uuid,
  'd4622230-0000-4000-8000-000000000004'::uuid,
  'd4622230-0000-4000-8000-000000000001'::uuid,
  1,
  'approved',
  'curl',
  '{}'::jsonb,
  '{}'::jsonb,
  '{"route":{"method":"POST","path_template":"/v1/orders","upstream_method":"POST","upstream_path_template":"/v1/orders"}}'::jsonb,
  '{"target":"shipments.create","version":1}'::jsonb,
  '{"mode":"attach_existing","template_name":"api_gateway_shipment_create_default_v1","intent":"shipment.create"}'::jsonb,
  '[{"operation_name":"forward_event","method":"POST","url_template":"https://provider.example.test/v1/orders"}]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET workflow_binding = EXCLUDED.workflow_binding,
    status = EXCLUDED.status,
    outbound_operations = EXCLUDED.outbound_operations;

SELECT ok(
  public.integration_plugin_activation_requires_source_sender_v1(
    'api',
    '{"mode":"attach_existing","template_name":"api_gateway_shipment_create_default_v1","intent":"shipment.create"}'::jsonb,
    public.integration_plugin_resolve_policy_v1('integration_plugin_policy', 'd4622230-0000-4000-8000-000000000001'::uuid)
  ),
  'API shipment-create activation requires source sender/client binding'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.senders s
      JOIN public.clients c
        ON c.id = s.client_id
     WHERE s.id = public.integration_plugin_resolve_activation_sender_v1(
       'd4622230-0000-4000-8000-000000000005'::uuid,
       'tenant',
       'd4622230-0000-4000-8000-000000000001'::uuid
     )
       AND c.organization_id = 'd4622230-0000-4000-8000-000000000001'::uuid
       AND COALESCE(s.status, 'active') = 'active'
  ),
  'tenant-scoped API activation resolves an active sender owned by the tenant'
);

SELECT is(
  public.integration_plugin_activation_provider_base_url_v1('d4622230-0000-4000-8000-000000000005'::uuid),
  'https://provider.example.test',
  'provider base URL resolves from outbound operation URL template'
);

SELECT is(
  public.api_gateway_sanitize_outbound_headers_v1(
    '{"traceparent":"00-test","tracestate":"state","x-correlation-id":"corr","user-agent":"PowerShell","content-type":"application/json"}'::jsonb
  ),
  '{"content-type":"application/json"}'::jsonb,
  'outbound header sanitizer strips runtime trace/correlation headers and keeps provider content type'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    LIKE '%integration_plugin_resolve_activation_sender_v1(v_version.id, v_scope_type, v_scope_id)%'
    AND pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
      LIKE '%integration_plugin_activation_provider_base_url_v1(v_version.id)%',
  'activation core calls sender and provider base URL resolvers'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    LIKE '%source_binding_source%'
    AND pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
      LIKE '%base_url%',
  'activation core persists source binding and provider base URL metadata'
);

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
  'd4622230-0000-4000-8000-000000000006'::uuid,
  'd4622230-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-source-binding-auditor@example.test',
  'Console V2 Plugin Source Binding Auditor',
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

SELECT set_config('request.jwt.claim.sub', 'd4622230-0000-4000-8000-000000000006', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d4622230-0000-4000-8000-000000000006","role":"authenticated"}',
  true
);

CREATE TEMP TABLE pgtap_plugin_activation_result AS
SELECT public.integration_plugin_activate_v1(
  'd4622230-0000-4000-8000-000000000005'::uuid,
  'tenant',
  'd4622230-0000-4000-8000-000000000001'::uuid,
  'pgTAP source binding activation proof'
) AS result;

SELECT ok(
  (SELECT result ?& ARRAY['webhook_source_id', 'api_route_id', 'provider_id'] FROM pgtap_plugin_activation_result),
  'activation returns source, API route, and provider runtime asset ids'
);

SELECT is(
  (
    SELECT ws.sender_id
      FROM pgtap_plugin_activation_result r
      JOIN public.webhook_sources ws
        ON ws.id = (r.result->>'webhook_source_id')::uuid
  ),
  public.integration_plugin_resolve_activation_sender_v1(
    'd4622230-0000-4000-8000-000000000005'::uuid,
    'tenant',
    'd4622230-0000-4000-8000-000000000001'::uuid
  ),
  'activation materializes plugin-managed source with resolved sender binding'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pgtap_plugin_activation_result r
      JOIN public.webhook_sources ws
        ON ws.id = (r.result->>'webhook_source_id')::uuid
      JOIN public.senders s
        ON s.id = ws.sender_id
     WHERE ws.managed_metadata->>'source_sender_id' = s.id::text
       AND ws.managed_metadata->>'source_client_id' = s.client_id::text
       AND ws.managed_metadata->>'source_binding_source' = 'integration_plugin_policy'
  ),
  'activation persists source sender/client binding metadata on the runtime source'
);

SELECT is(
  (
    SELECT p.metadata->>'base_url'
      FROM pgtap_plugin_activation_result r
      JOIN public.providers p
        ON p.id = (r.result->>'provider_id')::uuid
  ),
  'https://provider.example.test',
  'activation materializes provider base_url from outbound operation config'
);

SELECT is(
  (
    SELECT ar.policy #>> '{workflow,intent}'
      FROM pgtap_plugin_activation_result r
      JOIN public.api_routes ar
        ON ar.id = (r.result->>'api_route_id')::uuid
  ),
  'shipment.create',
  'activation materializes API route workflow intent from row-driven binding'
);

SELECT * FROM finish();
ROLLBACK;

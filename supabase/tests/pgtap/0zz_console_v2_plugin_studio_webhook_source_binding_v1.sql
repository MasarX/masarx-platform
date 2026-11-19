-- pgTAP: Plugin Studio webhook shipment-create activation must materialize a
-- sender/client-bound runtime source with shipment-create policy and mapping
-- readback.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

SELECT is(
  public.integration_plugin_default_workflow_binding_v1('webhook', NULL)->>'intent',
  'shipment.create',
  'webhook Plugin Studio default workflow binding carries shipment.create intent'
);

SELECT ok(
  COALESCE(
    (
      public.integration_plugin_resolve_policy_v1('integration_plugin_policy', NULL)
        #> '{studio_defaults,source_binding,webhook,required_for_templates}'
    ) ? 'webhook_shipment_create_v1',
    FALSE
  ),
  'integration_plugin_policy marks webhook shipment-create template as source-binding-required'
);

SELECT ok(
  public.integration_plugin_activation_requires_source_sender_v1(
    'webhook',
    '{"mode":"attach_existing","template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb,
    public.integration_plugin_resolve_policy_v1('integration_plugin_policy', NULL)
  ),
  'webhook shipment-create activation requires source sender/client binding'
);

SELECT is(
  (
    SELECT lv.metadata#>>'{payload,shipment,tracking_number}'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'webhook_sample_payload'
       AND lv.value = 'shipment_created_default'
       AND COALESCE(lv.status, 'active') = 'active'
     LIMIT 1
  ),
  '{{tracking_number}}',
  'backend-owned default webhook tester sample exposes shipment.tracking_number token'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd4622231-0000-4000-8000-000000000001'::uuid,
  'Console V2 Plugin Studio Webhook Org',
  'console-v2-plugin-studio-webhook-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'd4622231-0000-4000-8000-000000000002'::uuid,
  'd4622231-0000-4000-8000-000000000001'::uuid,
  'Console V2 Plugin Studio Webhook Client',
  'console-v2-plugin-studio-webhook-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  'd4622231-0000-4000-8000-000000000003'::uuid,
  'd4622231-0000-4000-8000-000000000002'::uuid,
  COALESCE(public.resolve_saas_onboarding_policy_v1() #>> '{client_defaults,default_sender_name}', 'Default Sender'),
  'Console V2 Plugin Studio Webhook Sender',
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
  'd4622231-0000-4000-8000-000000000004'::uuid,
  'd4622231-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-studio-webhook-source-binding',
  'Console V2 Plugin Studio Webhook Source Binding',
  'webhook',
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
  'd4622231-0000-4000-8000-000000000005'::uuid,
  'd4622231-0000-4000-8000-000000000004'::uuid,
  'd4622231-0000-4000-8000-000000000001'::uuid,
  1,
  'approved',
  'webhook_sample',
  '{"event":{"type":"shipment.created"},"shipment":{"tracking_number":"WH-STUDIO-001","reference":"WH-STUDIO-001","recipient":{"external_id":"REC-WH-STUDIO-001","name":"Noura Studio","phone":"+12025550181","email":"noura.studio@example.test"},"destination":{"line1":"King Fahd Road","city":"Riyadh","country":"SA"}}}'::jsonb,
  '{"source_type":"webhook_sample","plugin_kind":"webhook"}'::jsonb,
  '{"webhook":{"event_type_path":"event.type"}}'::jsonb,
  '{
    "version":1,
    "target":"shipments.create",
    "enabled":true,
    "transforms":{
      "shipment":{"tracking_number":["shipment.tracking_number","tracking_number"],"external_id":["shipment.reference","external_id"],"reference_number":["shipment.reference","reference"]},
      "recipient":{"external_id":["shipment.recipient.external_id"],"name":["Example Entity ntvplorhukthpmnmvgrstqzp"],"phone":["shipment.recipient.phone"],"email":["shipment.recipient.email"]},
      "address":{"line1":["shipment.destination.line1"],"city":["shipment.destination.city"],"country_code":["shipment.destination.country"]}
    },
    "metadata":{"canonical_intent":"shipment.create","mapping_profile":"plugin_studio_webhook_shipment_create_v1"}
  }'::jsonb,
  '{"mode":"attach_existing","template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET workflow_binding = EXCLUDED.workflow_binding,
    mapping_config = EXCLUDED.mapping_config,
    status = EXCLUDED.status;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.senders s
      JOIN public.clients c
        ON c.id = s.client_id
     WHERE s.id = public.integration_plugin_resolve_activation_sender_v1(
       'd4622231-0000-4000-8000-000000000005'::uuid,
       'tenant',
       'd4622231-0000-4000-8000-000000000001'::uuid
     )
       AND c.organization_id = 'd4622231-0000-4000-8000-000000000001'::uuid
       AND COALESCE(s.status, 'active') = 'active'
       AND COALESCE(c.status, 'active') = 'active'
  ),
  'tenant-scoped webhook activation resolves an active sender owned by the tenant'
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
  'd4622231-0000-4000-8000-000000000006'::uuid,
  'd4622231-0000-4000-8000-000000000001'::uuid,
  'console-v2-plugin-studio-webhook-auditor@example.test',
  'Console V2 Plugin Studio Webhook Auditor',
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

SELECT set_config('request.jwt.claim.sub', 'd4622231-0000-4000-8000-000000000006', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d4622231-0000-4000-8000-000000000006","role":"authenticated"}',
  true
);

CREATE TEMP TABLE pgtap_plugin_studio_webhook_activation AS
SELECT public.integration_plugin_activate_v1(
  'd4622231-0000-4000-8000-000000000005'::uuid,
  'tenant',
  'd4622231-0000-4000-8000-000000000001'::uuid,
  'pgTAP Plugin Studio webhook source binding activation proof'
) AS result;

SELECT ok(
  (SELECT result ? 'webhook_source_id' FROM pgtap_plugin_studio_webhook_activation),
  'webhook activation returns plugin-managed source id'
);

SELECT is(
  (
    SELECT ws.sender_id
      FROM pgtap_plugin_studio_webhook_activation r
      JOIN public.webhook_sources ws
        ON ws.id = (r.result->>'webhook_source_id')::uuid
  ),
  public.integration_plugin_resolve_activation_sender_v1(
    'd4622231-0000-4000-8000-000000000005'::uuid,
    'tenant',
    'd4622231-0000-4000-8000-000000000001'::uuid
  ),
  'plugin-managed webhook source is bound to the resolved tenant sender after activation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pgtap_plugin_studio_webhook_activation r
      JOIN public.webhook_sources ws
        ON ws.id = (r.result->>'webhook_source_id')::uuid
      JOIN public.senders s
        ON s.id = ws.sender_id
     WHERE ws.managed_metadata->>'source_sender_id' = s.id::text
       AND ws.managed_metadata->>'source_client_id' = s.client_id::text
       AND ws.managed_metadata->>'source_binding_source' = 'integration_plugin_policy'
  ),
  'plugin-managed webhook source persists source sender/client metadata'
);

SELECT is(
  (
    SELECT mc.mapping_config->>'target'
      FROM pgtap_plugin_studio_webhook_activation r
      JOIN public.webhook_sources ws
        ON ws.id = (r.result->>'webhook_source_id')::uuid
      JOIN public.mapping_configs mc
        ON mc.id = ws.mapping_config_id
  ),
  'shipments.create',
  'plugin-managed webhook source mapping targets shipment create'
);

SELECT is(
  (
    SELECT mc.mapping_config#>>'{transforms,shipment,tracking_number,0}'
      FROM pgtap_plugin_studio_webhook_activation r
      JOIN public.webhook_sources ws
        ON ws.id = (r.result->>'webhook_source_id')::uuid
      JOIN public.mapping_configs mc
        ON mc.id = ws.mapping_config_id
  ),
  'shipment.tracking_number',
  'plugin-managed webhook source mapping keeps shipment tracking transform'
);

SELECT is(
  (
    SELECT p.policy #>> '{workflow,intent}'
      FROM pgtap_plugin_studio_webhook_activation r,
           public.resolve_webhook_ingest_policy(
             p_webhook_source_id := (r.result->>'webhook_source_id')::uuid
           ) AS p
      LIMIT 1
  ),
  'shipment.create',
  'plugin-managed webhook source policy uses shipment.create intent'
);

SELECT is(
  (
    SELECT p.policy #>> '{workflow,template_name}'
      FROM pgtap_plugin_studio_webhook_activation r,
           public.resolve_webhook_ingest_policy(
             p_webhook_source_id := (r.result->>'webhook_source_id')::uuid
           ) AS p
      LIMIT 1
  ),
  'webhook_shipment_create_v1',
  'plugin-managed webhook source policy keeps webhook shipment-create template'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pgtap_plugin_studio_webhook_activation r
      JOIN public.integration_plugin_bindings b
        ON b.runtime_resource_type = 'webhook_sources'
       AND b.runtime_resource_id = (r.result->>'webhook_source_id')::uuid
     WHERE b.activation_payload->>'source_client_id' = 'd4622231-0000-4000-8000-000000000002'
  ),
  'plugin binding activation payload exposes source client readback'
);

SELECT * FROM finish();
ROLLBACK;

-- pgTAP: Console V2 webhook source remediation accepts enabled
-- operator-created webhook_inbound shipment-create mappings without requiring a
-- plugin runtime version, and still repairs a source-scoped ingest policy.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(5);

SELECT has_function(
  'public',
  'ensure_webhook_source_plugin_binding_v1',
  ARRAY['uuid'],
  'source policy repair helper exists for operator mapping remediation'::text
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd1413000-0000-4000-8000-000000000001'::uuid,
  'Console V2 Operator Mapping Org',
  'console-v2-operator-mapping-org'
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
  'd1413000-0000-4000-8000-000000000010'::uuid,
  'd1413000-0000-4000-8000-000000000001'::uuid,
  'console-v2-operator-mapping@example.test',
  'Console V2 Operator Mapping Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'd1413000-0000-4000-8000-000000000020'::uuid,
  'd1413000-0000-4000-8000-000000000001'::uuid,
  'Console V2 Operator Mapping Client',
  'console-v2-operator-mapping-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  'd1413000-0000-4000-8000-000000000030'::uuid,
  'd1413000-0000-4000-8000-000000000020'::uuid,
  'Console V2 Operator Mapping Sender',
  'Console V2 Operator Mapping Sender',
  false,
  true,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    client_id = EXCLUDED.client_id,
    status = EXCLUDED.status;

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  managed_by,
  managed_metadata,
  notes
)
VALUES (
  'd1413000-0000-4000-8000-000000000040'::uuid,
  'd1413000-0000-4000-8000-000000000001'::uuid,
  'webhook_inbound',
  'console.v2.operator.mapping.policy',
  '{"target":"shipments.create","enabled":true,"operator_policy_test":true}'::jsonb,
  1,
  'platform',
  '{}'::jsonb,
  'Console V2 operator-created source-bindable mapping pgTAP fixture'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    mapping_type = EXCLUDED.mapping_type,
    mapping_key = EXCLUDED.mapping_key,
    mapping_config = EXCLUDED.mapping_config,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now();

SELECT set_config('request.jwt.claim.sub', 'd1413000-0000-4000-8000-000000000010', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'd1413000-0000-4000-8000-000000000010',
    'role', 'authenticated',
    'email', 'console-v2-operator-mapping@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;

CREATE TEMP TABLE _operator_mapping_source_upsert AS
SELECT public.ui_upsert_webhook_source_v1(jsonb_build_object(
  'organization_id', 'd1413000-0000-4000-8000-000000000001',
  'source_identifier', 'console-v2-operator-mapping-policy',
  'name', 'Console V2 Operator Mapping Policy',
  'provider_type', 'generic',
  'mapping_config_id', 'd1413000-0000-4000-8000-000000000040',
  'sender_id', 'd1413000-0000-4000-8000-000000000030',
  'rate_limit_per_hour', 1000,
  'enabled', true
)) AS result;

RESET ROLE;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;

SELECT ok(
  (SELECT result#>>'{source_binding_repair,policy_repair,mode}' FROM _operator_mapping_source_upsert)
    = 'operator_webhook_inbound_mapping',
  'ui_upsert_webhook_source_v1 repairs policy for enabled operator-created webhook_inbound mappings'::text
);

SELECT ok(
  (
    SELECT mapping_config_id::text
      FROM public.webhook_sources
     WHERE source_identifier = 'console-v2-operator-mapping-policy'
     LIMIT 1
  ) = 'd1413000-0000-4000-8000-000000000040',
  'webhook source stores the operator-created mapping profile'::text
);

SELECT ok(
  (
    SELECT count(*)::int
      FROM public.integration_plugin_bindings b
      JOIN public.webhook_sources ws ON ws.id = b.runtime_resource_id
     WHERE ws.source_identifier = 'console-v2-operator-mapping-policy'
       AND b.runtime_resource_type = 'webhook_sources'
       AND b.enabled IS TRUE
  ) = 0,
  'operator mapping remediation leaves no active plugin runtime binding'::text
);

SELECT ok(
  (
    SELECT p.policy#>>'{workflow,intent}'
      FROM public.webhook_sources ws
      CROSS JOIN LATERAL public.resolve_webhook_ingest_policy(ws.id) AS p
     WHERE ws.source_identifier = 'console-v2-operator-mapping-policy'
     LIMIT 1
  ) = 'shipment.create',
  'operator mapping remediation creates a source-scoped shipment-create ingest policy'::text
);

SELECT * FROM finish();
ROLLBACK;

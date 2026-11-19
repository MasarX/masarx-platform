-- pgTAP: Console V2 webhook sources can bind a shipment sender/client so
-- receiver-authenticated shipment webhooks can resolve real backend context.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(22);

SELECT has_function(
  'public',
  'ui_upsert_webhook_source_v1',
  ARRAY['jsonb'],
  'public.ui_upsert_webhook_source_v1(jsonb) exists for Console V2 source writes'
);

SELECT has_function(
  'api',
  'ui_upsert_webhook_source_v1',
  ARRAY['jsonb'],
  'api.ui_upsert_webhook_source_v1(jsonb) exposes the browser-safe source write wrapper'
);

SELECT has_function(
  'public',
  'ensure_webhook_source_plugin_binding_v1',
  ARRAY['uuid'],
  'public.ensure_webhook_source_plugin_binding_v1(uuid) exists for source policy repair'
);

SELECT has_column(
  'public',
  'v_webhook_source_directory',
  'sender_id',
  'webhook source directory exposes the bound sender id'
);

SELECT has_column(
  'public',
  'v_webhook_source_directory',
  'client_id',
  'webhook source directory exposes the sender-derived client id'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.settings', 'SELECT'),
  'authenticated operators cannot read raw settings for webhook source directory projection'
);

SELECT ok(
  pg_get_viewdef('public.v_webhook_source_directory'::regclass, true) NOT ILIKE '%JOIN public.settings%'
    AND pg_get_viewdef('public.v_webhook_source_directory'::regclass, true) NOT ILIKE '%JOIN settings%',
  'webhook source directory resolves policy display fields without a direct settings join'
);

INSERT INTO public.organizations (id, name, slug)
VALUES
  ('c8f1d8f3-1e7f-4fb5-9f75-79f369473a01'::uuid, 'Console V2 Webhook Binding Org A', 'console-v2-webhook-binding-org-a'),
  ('c8f1d8f3-1e7f-4fb5-9f75-79f369473a02'::uuid, 'Console V2 Webhook Binding Org B', 'console-v2-webhook-binding-org-b')
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
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a10'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a01'::uuid,
  'console-v2-webhook-binding@example.test',
  'Console V2 Webhook Binding Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
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
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a11'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a02'::uuid,
  'console-v2-webhook-binding-org-b@example.test',
  'Console V2 Webhook Binding Org B Operator',
  'ops_admin',
  'tenant',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES
  ('c8f1d8f3-1e7f-4fb5-9f75-79f369473a21'::uuid, 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a01'::uuid, 'Console Binding Client A', 'console-binding-client-a', 'active'),
  ('c8f1d8f3-1e7f-4fb5-9f75-79f369473a22'::uuid, 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a02'::uuid, 'Console Binding Client B', 'console-binding-client-b', 'active')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES
  ('c8f1d8f3-1e7f-4fb5-9f75-79f369473a31'::uuid, 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a21'::uuid, 'Console Binding Sender A', 'Console Sender A', false, true, 'active'),
  ('c8f1d8f3-1e7f-4fb5-9f75-79f369473a32'::uuid, 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a22'::uuid, 'Console Binding Sender B', 'Console Sender B', false, true, 'active')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    client_id = EXCLUDED.client_id,
    status = EXCLUDED.status;

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
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a41'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a01'::uuid,
  'console-v2-webhook-source-sender-binding',
  'Console V2 Webhook Sender Binding Plugin',
  'webhook',
  'active',
  'tenant',
  true,
  'platform'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    updated_at = now();

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
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a42'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a41'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a01'::uuid,
  1,
  'active',
  'webhook_sample',
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{"target":"shipments.create","rules":[]}'::jsonb,
  '{"template_name":"async_provider_dispatch_v1","intent":"shipment.create"}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    mapping_config = EXCLUDED.mapping_config,
    workflow_binding = EXCLUDED.workflow_binding,
    updated_at = now();

UPDATE public.integration_plugins
   SET active_version_id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a42'::uuid
 WHERE id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a41'::uuid;

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  managed_metadata,
  notes
)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a40'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a01'::uuid,
  'webhook_inbound',
  'integration_plugin:c8f1d8f3-1e7f-4fb5-9f75-79f369473a42:source:tenant:c8f1d8f3-1e7f-4fb5-9f75-79f369473a01',
  '{"target":"shipments.create","rules":[]}'::jsonb,
  1,
  jsonb_build_object('plugin_version_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a42'),
  'Console V2 webhook source sender binding pgTAP mapping'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    mapping_config = EXCLUDED.mapping_config,
    managed_metadata = EXCLUDED.managed_metadata,
    mapping_key = EXCLUDED.mapping_key,
    updated_at = now();

SELECT set_config('request.jwt.claim.sub', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a10', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a10',
    'role', 'authenticated',
    'email', 'console-v2-webhook-binding@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SET LOCAL search_path TO public, pg_temp;

CREATE TEMP TABLE _webhook_source_upsert_result AS
SELECT public.ui_upsert_webhook_source_v1(jsonb_build_object(
  'organization_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a01',
  'source_identifier', 'console-v2-webhook-source-sender-binding',
  'name', 'Console V2 Webhook Sender Binding',
  'provider_type', 'generic',
  'mapping_config_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a40',
  'sender_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a31',
  'rate_limit_per_hour', 1200,
  'enabled', true
)) AS result;

CREATE TEMP TABLE _webhook_source_repair_result AS
SELECT result#>>'{source_binding_repair,ok}' AS repair_ok
  FROM _webhook_source_upsert_result;

CREATE TEMP TABLE _webhook_source_before_clear AS
SELECT sender_id::text AS sender_id
  FROM public.webhook_sources
 WHERE source_identifier = 'console-v2-webhook-source-sender-binding';

CREATE TEMP TABLE _webhook_source_directory_before_clear AS
SELECT sender_label, client_label
  FROM public.v_webhook_source_directory
 WHERE source_identifier = 'console-v2-webhook-source-sender-binding';

CREATE TEMP TABLE _webhook_source_ui_readback AS
SELECT public.ui_get_resource_v1(
    'webhook_source_directory',
    (
      SELECT id
        FROM public.webhook_sources
       WHERE source_identifier = 'console-v2-webhook-source-sender-binding'
    )
  ) AS row;

CREATE TEMP TABLE _webhook_source_policy_scope_target AS
SELECT id AS source_id
  FROM public.webhook_sources
 WHERE source_identifier = 'console-v2-webhook-source-sender-binding'
 LIMIT 1;

RESET ROLE;
SET LOCAL search_path TO public, pg_temp;

CREATE TEMP TABLE _webhook_source_token_lookup AS
SELECT client_id::text AS client_id
  FROM public.get_webhook_source_by_token(
    (SELECT result->>'auth_token' FROM _webhook_source_upsert_result LIMIT 1)
  );

-- The test runs inside the transaction that writes the new source policy.
UPDATE public.settings_versions sv
   SET effective_from = transaction_timestamp()
  FROM public.settings s
  JOIN public.webhook_sources ws ON s.scope_id = ws.id
 WHERE sv.id = s.settings_version_id
   AND s.category = 'webhook_ingest_policy' AND s.scope_type = 'source'
   AND ws.source_identifier = 'console-v2-webhook-source-sender-binding';

CREATE TEMP TABLE _webhook_source_plugin_policy_readback AS
SELECT b.plugin_version_id::text AS plugin_version_id,
       p.policy#>>'{workflow,intent}' AS policy_intent
  FROM public.webhook_sources ws
  JOIN public.integration_plugin_bindings b
    ON b.runtime_resource_type = 'webhook_sources'
   AND b.runtime_resource_id = ws.id AND b.enabled
   AND b.binding_type = 'webhook_source'
  CROSS JOIN LATERAL public.resolve_webhook_ingest_policy(ws.id) p
 WHERE ws.source_identifier = 'console-v2-webhook-source-sender-binding'
   AND p.scope_type = 'source' AND p.scope_id = ws.id;

SET LOCAL ROLE authenticated;
SET LOCAL search_path TO public, pg_temp;

CREATE TEMP TABLE _webhook_source_clear_result (
  sqlstate text,
  message text
);

DO $$
BEGIN
  BEGIN
    PERFORM public.ui_upsert_webhook_source_v1(jsonb_build_object(
      'source_id', (
        SELECT id
          FROM public.webhook_sources
         WHERE source_identifier = 'console-v2-webhook-source-sender-binding'
      ),
      'sender_id', NULL
    ));
    INSERT INTO _webhook_source_clear_result(sqlstate, message)
    VALUES ('00000', 'no error');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _webhook_source_clear_result(sqlstate, message)
    VALUES (SQLSTATE, SQLERRM);
  END;
END
$$;

CREATE TEMP TABLE _webhook_source_after_clear AS
SELECT sender_id::text AS sender_id
  FROM public.webhook_sources
 WHERE source_identifier = 'console-v2-webhook-source-sender-binding';

CREATE TEMP TABLE _webhook_source_cross_org_error (
  sqlstate text,
  message text
);

DO $$
BEGIN
  BEGIN
    PERFORM public.ui_upsert_webhook_source_v1(jsonb_build_object(
      'organization_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a01',
      'source_identifier', 'console-v2-webhook-cross-org-sender',
      'name', 'Console V2 Cross Org Sender',
      'provider_type', 'generic',
      'mapping_config_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a40',
      'sender_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a32',
      'enabled', true
    ));
    INSERT INTO _webhook_source_cross_org_error(sqlstate, message)
    VALUES ('00000', 'no error');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _webhook_source_cross_org_error(sqlstate, message)
    VALUES (SQLSTATE, SQLERRM);
  END;
END
$$;

RESET ROLE;
SET LOCAL search_path TO public, extensions, pg_temp;

SELECT is(
  (SELECT result->>'ok' FROM _webhook_source_upsert_result LIMIT 1),
  'true',
  'source upsert succeeds through the authenticated Console RPC'
);

SELECT is(
  length((SELECT result->>'auth_token' FROM _webhook_source_upsert_result LIMIT 1)),
  64,
  'new source returns a one-time receiver token for browser testing'
);

SELECT is(
  (SELECT repair_ok FROM _webhook_source_repair_result LIMIT 1),
  'true',
  'source upsert returns successful source policy repair evidence'
);

SELECT is(
  (SELECT sender_id FROM _webhook_source_before_clear LIMIT 1),
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a31',
  'source row persists the selected shipment sender'
);

SELECT is(
  (SELECT sender_label FROM _webhook_source_directory_before_clear LIMIT 1),
  'Console Binding Sender A',
  'directory projection surfaces the sender label for operators'
);

SELECT is(
  (SELECT client_label FROM _webhook_source_directory_before_clear LIMIT 1),
  'Console Binding Client A',
  'directory projection surfaces the sender-derived client label for operators'
);

SELECT is(
  (SELECT row->>'sender_label' FROM _webhook_source_ui_readback LIMIT 1),
  'Console Binding Sender A',
  'browser readback can fetch the source sender binding through ui_get_resource_v1'
);

SELECT is(
  (SELECT client_id FROM _webhook_source_token_lookup LIMIT 1),
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a21',
  'receiver token lookup resolves the sender-derived client for webhook shipment creation'
);

SELECT is(
  (SELECT plugin_version_id FROM _webhook_source_plugin_policy_readback),
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a42',
  'source upsert creates a runtime plugin binding for the selected shipment mapping'
);

SELECT is(
  (SELECT policy_intent FROM _webhook_source_plugin_policy_readback),
  'shipment.create',
  'source upsert repairs source-level webhook ingest policy for shipment materialization'
);

SELECT is(
  (SELECT sqlstate FROM _webhook_source_clear_result LIMIT 1),
  '23502',
  'upsert RPC rejects clearing sender binding for shipment-create mappings'
);

SELECT is(
  (SELECT sender_id FROM _webhook_source_after_clear LIMIT 1),
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473a31',
  'source row keeps sender_id when shipment-create clear is rejected'
);

SELECT is(
  (SELECT sqlstate FROM _webhook_source_cross_org_error LIMIT 1),
  '42501',
  'upsert RPC rejects sender bindings from another tenant'
);

SELECT set_config('request.jwt.claim.sub', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a11', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473a11',
    'role', 'authenticated',
    'email', 'console-v2-webhook-binding-org-b@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    SELECT 1
      FROM public.webhook_source_directory_policy_summary_v1(
        (SELECT source_id FROM _webhook_source_policy_scope_target LIMIT 1)
      )
  $$,
  '42501',
  'webhook source policy is not available',
  'webhook source policy summary helper denies direct cross-tenant reads without exposing the source id'
);

SELECT throws_ok(
  $$
    SELECT 1
      FROM public.webhook_source_directory_policy_summary_v1(
        'c8f1d8f3-1e7f-4fb5-9f75-79f36947ffff'::uuid
      )
  $$,
  '42501',
  'webhook source policy is not available',
  'webhook source policy summary helper uses the same generic response for unavailable source ids'
);

RESET ROLE;
SET LOCAL search_path TO public, extensions, pg_temp;

SELECT * FROM finish();

ROLLBACK;

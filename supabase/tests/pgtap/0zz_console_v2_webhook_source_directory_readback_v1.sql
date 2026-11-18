-- pgTAP: Console V2 webhook source token rotation can read back the
-- backend-backed directory projection after mutation.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(16);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'public.v_webhook_source_directory',
  'webhook_source_directory reads the canonical operator projection'
);

SELECT is(
  (
    SELECT resource->>'id_column'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'id',
  'webhook_source_directory identifies rows by source id'
);

SELECT is(
  (
    SELECT resource->>'capability_read'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'webhooks.read',
  'webhook_source_directory is gated by webhooks.read'
);

SELECT is(
  (
    SELECT resource->>'capability_write'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'webhooks.write',
  'webhook_source_directory keeps the source mutation capability lineage'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,tenant}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_sources'
  ),
  'organization_id',
  'webhook_sources registry scopes tenant reads by organization_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,client}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_sources'
  ),
  'client_id',
  'webhook_sources registry scopes client reads by source client_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,sender}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_sources'
  ),
  'sender_id',
  'webhook_sources registry scopes sender reads by source sender_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,tenant}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'organization_id',
  'webhook_source_directory registry scopes tenant reads by organization_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,client}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'client_id',
  'webhook_source_directory registry scopes client reads by source client_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,sender}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'sender_id',
  'webhook_source_directory registry scopes sender reads by source sender_id'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_webhook_source_directory'::regclass),
  '{security_invoker=true}',
  'v_webhook_source_directory remains security_invoker'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'webhook_source_directory'
            AND resource->>'relation' = 'public.v_webhook_source_directory'
            AND resource->>'capability_read' = 'webhooks.read'
       )
  ),
  'all scoped read registries expose webhook_source_directory'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
  'Console V2 Webhook Source Directory Org',
  'console-v2-webhook-source-directory-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  '6a29701f-ff61-47a7-a51a-48c68e5cfd10'::uuid,
  'webhook_inbound',
  'console-v2-source-directory-test',
  '{"target":"shipments.create","rules":[]}'::jsonb,
  1,
  'Console V2 webhook source directory readback test mapping'
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
  rate_limit_per_hour,
  enabled
)
VALUES (
  '34f5e45d-2084-4afd-833c-42197241683e'::uuid,
  'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
  'console-v2-source-directory-test',
  'Console V2 Source Directory Test',
  'generic',
  'console-v2-source-directory-test-token',
  '6a29701f-ff61-47a7-a51a-48c68e5cfd10'::uuid,
  100,
  true
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    auth_token = EXCLUDED.auth_token,
    mapping_config_id = EXCLUDED.mapping_config_id,
    updated_at = now();

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
  'bf013b6a-cb0b-4040-bd0d-36bf6dc693d0'::uuid,
  'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
  'console-v2-source-directory@example.test',
  'Console V2 Source Directory Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'bf013b6a-cb0b-4040-bd0d-36bf6dc693d0', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'bf013b6a-cb0b-4040-bd0d-36bf6dc693d0',
    'role', 'authenticated',
    'email', 'console-v2-source-directory@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('webhook_source_directory', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'webhook_source_directory lists through ui_list_resource_v1'
);

SELECT lives_ok(
  $$ SELECT public.ui_get_resource_v1('webhook_source_directory', '34f5e45d-2084-4afd-833c-42197241683e'::uuid) $$,
  'webhook_source_directory reads a source projection through ui_get_resource_v1'
);

SELECT is(
  public.ui_get_resource_v1('webhook_source_directory', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'source_identifier',
  'console-v2-source-directory-test',
  'webhook_source_directory readback returns the backend source reference'
);

SELECT isnt(
  public.ui_get_resource_v1('webhook_source_directory', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'auth_token_masked',
  'console-v2-source-directory-test-token',
  'webhook_source_directory readback exposes only token status, not token material'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;

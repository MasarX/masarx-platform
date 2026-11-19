-- pgTAP: Console V2 plugin runtime binding reads expose governance context
-- without leaking activation secrets.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_plugin_runtime_binding_redacted_readback_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000099301855';
  v_user UUID := '00000000-0000-0000-0000-000099301856';
  v_plugin UUID := '00000000-0000-0000-0000-000099301857';
  v_version UUID := '00000000-0000-0000-0000-000099301858';
  v_binding UUID := '00000000-0000-0000-0000-000099301859';
  v_runtime_resource UUID := '00000000-0000-0000-0000-000099301860';
  v_binding_get JSONB;
  v_binding_list JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Plugin Runtime Redaction Org', 'console-v2-plugin-runtime-redaction')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'console-v2-plugin-runtime-redaction@example.com',
    'Console V2 Plugin Runtime Redaction Admin',
    'super_admin',
    'active',
    'platform',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.integration_plugins (
    id,
    organization_id,
    plugin_key,
    name,
    plugin_kind,
    status,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    v_plugin,
    v_org,
    'console-v2-plugin-runtime-redaction',
    'Console V2 Plugin Runtime Redaction',
    'webhook',
    'active',
    jsonb_build_object('vendor', 'Runtime Redaction'),
    v_user,
    v_user
  )
  ON CONFLICT (organization_id, plugin_key) DO UPDATE
     SET status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         updated_by = EXCLUDED.updated_by,
         updated_at = now();

  INSERT INTO public.integration_plugin_versions (
    id,
    plugin_id,
    organization_id,
    version_no,
    status,
    source_type,
    created_by,
    updated_by
  )
  VALUES (
    v_version,
    v_plugin,
    v_org,
    1,
    'active',
    'manual',
    v_user,
    v_user
  )
  ON CONFLICT (plugin_id, version_no) DO UPDATE
     SET status = EXCLUDED.status,
         updated_by = EXCLUDED.updated_by,
         updated_at = now();

  UPDATE public.integration_plugins
     SET active_version_id = v_version,
         updated_by = v_user,
         updated_at = now()
   WHERE id = v_plugin;

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
    activation_payload,
    metadata,
    created_by
  )
  VALUES (
    v_binding,
    v_version,
    v_org,
    'tenant',
    v_org,
    'webhook_source',
    'webhook_sources',
    v_runtime_resource,
    TRUE,
    jsonb_build_object(
      'source_identifier', 'runtime-redaction-source',
      'issued_token', 'raw-runtime-issued-token',
      'headers', jsonb_build_object('authorization', 'Bearer raw-runtime-bearer'),
      'endpoint', 'https://provider.example.test/hook?api_key=raw-runtime-query-key'
    ),
    jsonb_build_object(
      'operator_note', 'safe runtime note',
      'secret_hint', 'raw-runtime-metadata-secret'
    ),
    v_user
  )
  ON CONFLICT ON CONSTRAINT integration_plugin_bindings_unique_scope_resource DO UPDATE
     SET activation_payload = EXCLUDED.activation_payload,
         metadata = EXCLUDED.metadata,
         enabled = EXCLUDED.enabled,
         updated_at = now();

  RETURN NEXT is(
    (
      SELECT resource->>'relation'
        FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
       WHERE resource->>'key' = 'integration_plugin_bindings'
       LIMIT 1
    ),
    'public.v_integration_plugin_binding_directory',
    'integration_plugin_bindings generic read routes through the redacted runtime binding directory'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'v_integration_plugin_binding_directory'
         AND c.relkind = 'v'
         AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
    ),
    'runtime binding directory is a security_invoker view'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.integration_plugin_bindings
       WHERE id = v_binding
         AND activation_payload->>'issued_token' = 'raw-runtime-issued-token'
    ),
    'canonical binding table retains activation token for backend-only handoff helpers'
  );

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_user::text,
      'organization_id', v_org::text,
      'access_scope_type', 'platform'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_binding_get := public.ui_get_resource_v1('integration_plugin_bindings', v_binding);
  v_binding_list := public.ui_list_resource_v1(
    'integration_plugin_bindings',
    jsonb_build_object('plugin_version_id', v_version::text),
    10,
    0,
    NULL::jsonb
  );

  RETURN NEXT ok(
    v_binding_get->>'runtime_resource_type' = 'webhook_sources'
    AND v_binding_get#>>'{activation_payload,source_identifier}' = 'runtime-redaction-source',
    'ui_get_resource_v1(integration_plugin_bindings) preserves runtime binding identity and source label'
  );

  RETURN NEXT is(
    v_binding_get#>>'{activation_payload,issued_token}',
    'REDACTED',
    'ui_get_resource_v1(integration_plugin_bindings) redacts issued token'
  );

  RETURN NEXT is(
    v_binding_get#>>'{activation_payload,headers,authorization}',
    'REDACTED',
    'ui_get_resource_v1(integration_plugin_bindings) redacts authorization header'
  );

  RETURN NEXT ok(
    (v_binding_get#>>'{activation_payload,endpoint}') LIKE '%api_key=REDACTED%',
    'ui_get_resource_v1(integration_plugin_bindings) redacts query credentials in runtime endpoint'
  );

  RETURN NEXT ok(
    v_binding_get#>>'{metadata,operator_note}' = 'safe runtime note'
    AND v_binding_get#>>'{metadata,secret_hint}' = 'REDACTED',
    'ui_get_resource_v1(integration_plugin_bindings) keeps safe metadata and redacts secret-shaped metadata keys'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_binding_list->'items', '[]'::jsonb)) AS item
       WHERE item::text LIKE '%raw-runtime-issued-token%'
          OR item::text LIKE '%raw-runtime-bearer%'
          OR item::text LIKE '%raw-runtime-query-key%'
          OR item::text LIKE '%raw-runtime-metadata-secret%'
    ),
    'ui_list_resource_v1(integration_plugin_bindings) never includes raw runtime activation secrets'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_plugin_runtime_binding_redacted_readback_v1();

SELECT * FROM finish();
ROLLBACK;

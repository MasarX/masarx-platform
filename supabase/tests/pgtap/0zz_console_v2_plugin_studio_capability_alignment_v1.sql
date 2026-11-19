BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000cb10';
  v_ops UUID := '00000000-0000-0000-0000-00000000cb11';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Plugin Studio Capability Alignment Org', 'plugin-studio-capability-alignment')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'plugin-studio-capability-alignment@example.com',
    'Plugin Studio Capability Alignment',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id,
      updated_at = now();

  PERFORM set_config('test.plugin_studio_ops_user', v_ops::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}', '[]'::jsonb)) AS section(value),
           jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
     WHERE item.value->>'key' = 'int-plugin-studio'
       AND item.value->>'capability' = 'integration_plugins.write'
       AND COALESCE(item.value->>'route', item.value->>'href', item.value->>'path') = '/integrations/plugin-studio'
  ),
  'Plugin Studio navigation uses integration_plugins.write'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value),
           jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
     WHERE s.category = 'ui_navigation'
       AND item.value->>'key' = 'int-plugin-studio'
       AND item.value->>'capability' IS DISTINCT FROM 'integration_plugins.write'
  ),
  'all active Plugin Studio navigation rows avoid stale integrations.write gate'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands', '[]'::jsonb)) AS command(value)
     WHERE command.value->>'key' IN (
       'integrations.install_plugin',
       'integrations.create_plugin',
       'integrations.uninstall_plugin'
     )
       AND command.value->>'capability' IS DISTINCT FROM 'integration_plugins.write'
  ),
  'plugin lifecycle commands use integration_plugins.write'
);

SELECT is(
  (
    SELECT command.value->>'label'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands', '[]'::jsonb)) AS command(value)
     WHERE command.value->>'key' = 'integrations.uninstall_plugin'
       AND command.value->>'target' = 'integration_plugin_rollback_v1'
     LIMIT 1
  ),
  'Rollback integration plugin release',
  'plugin rollback command label does not imply deletion'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_path_query_first(sv.value, '$.roles[*] ? (@.key == "ops_admin").capability_keys') caps
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND caps @> '["integration_plugins.write"]'::jsonb
  ),
  'ops_admin role carries integration_plugins.write for Plugin Studio authoring'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource(value)
     WHERE resource.value->>'key' = 'integration_plugin_directory'
       AND resource.value->>'relation' = 'public.v_integration_plugin_directory'
       AND resource.value->>'capability_read' = 'integration_plugins.read'
  ),
  'integration_plugin_directory read registry supports Catalog no-reload readback'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource(value)
          WHERE resource.value->>'key' = 'integration_plugin_directory'
            AND resource.value->>'relation' = 'public.v_integration_plugin_directory'
            AND resource.value->>'capability_read' = 'integration_plugins.read'
       )
  ),
  'all ui_read_registry scopes include integration_plugin_directory readback resource'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'plugin_studio_source_type'
       AND lv.status = 'active'
  ),
  4,
  'Plugin Studio source-type lookup rows are backend seeded'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'plugin_studio_plugin_kind'
       AND lv.status = 'active'
  ),
  2,
  'Plugin Studio plugin-kind lookup rows are backend seeded'
);

SELECT is(
  (
    SELECT lv.metadata->>'payload_mode'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'plugin_studio_source_type'
       AND lv.value = 'curl'
  ),
  'wrap_curl',
  'Plugin Studio curl source type carries row-driven payload mode'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.plugin_studio_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM api.list_lookup_values_v1('plugin_studio_plugin_kind') AS row
     WHERE row.value = 'api'
       AND row.is_default IS TRUE
       AND row.metadata->>'hint' = 'outbound HTTP'
  ),
  'Plugin Studio plugin-kind lookups hydrate through api.list_lookup_values_v1'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;

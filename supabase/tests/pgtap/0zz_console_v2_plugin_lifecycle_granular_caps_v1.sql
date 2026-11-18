SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT ok(
  (
    SELECT COALESCE(
      (
        SELECT jsonb_agg(item.value->>'key')
          FROM jsonb_array_elements(
            COALESCE(public.resolve_settings_merged('access_control_policy', 'global', NULL)->'capabilities', '[]'::jsonb)
          ) AS item(value)
         WHERE item.value->>'key' IN (
           'integration_plugins.read',
           'integration_plugins.write',
           'integration_plugins.test',
           'integration_plugins.approve',
           'integration_plugins.activate'
         )
      ),
      '[]'::jsonb
    ) @> '[
      "integration_plugins.read",
      "integration_plugins.write",
      "integration_plugins.test",
      "integration_plugins.approve",
      "integration_plugins.activate"
    ]'::jsonb
  ),
  'access control policy exposes granular integration plugin lifecycle capabilities'
);

SELECT ok(
  (
    SELECT COALESCE(role.value->'capability_keys', '[]'::jsonb)
      FROM jsonb_array_elements(
        COALESCE(public.resolve_settings_merged('access_control_policy', 'global', NULL)->'roles', '[]'::jsonb)
      ) AS role(value)
     WHERE role.value->>'key' = 'tenant_integrations_approver'
     LIMIT 1
  ) @> '[
    "integration_plugins.read",
    "integration_plugins.test",
    "integration_plugins.approve",
    "integration_plugins.activate"
  ]'::jsonb,
  'tenant_integrations_approver carries read/test/approve/activate capabilities'
);

SELECT ok(
  NOT ((
    SELECT COALESCE(role.value->'capability_keys', '[]'::jsonb)
      FROM jsonb_array_elements(
        COALESCE(public.resolve_settings_merged('access_control_policy', 'global', NULL)->'roles', '[]'::jsonb)
      ) AS role(value)
     WHERE role.value->>'key' = 'tenant_integrations_approver'
     LIMIT 1
  ) ? 'integration_plugins.write'),
  'tenant_integrations_approver does not carry draft authoring write capability'
);

SELECT is(
  public.resolve_settings_merged('access_control_policy', 'global', NULL)
    #>> '{resource_map,integration_plugin_validation_runs,write}',
  'integration_plugins.test',
  'validation run writes map to integration_plugins.test'
);

SELECT is(
  public.resolve_settings_merged('access_control_policy', 'global', NULL)
    #>> '{resource_map,integration_plugin_approval_events,write}',
  'integration_plugins.approve',
  'approval event writes map to integration_plugins.approve'
);

SELECT is(
  public.resolve_settings_merged('access_control_policy', 'global', NULL)
    #>> '{resource_map,integration_plugin_bindings,write}',
  'integration_plugins.activate',
  'runtime binding writes map to integration_plugins.activate'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        COALESCE(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands', '[]'::jsonb)
      ) AS command(value)
     WHERE command.value->>'key' IN ('integrations.install_plugin', 'integrations.create_plugin')
       AND command.value->>'capability' = 'integration_plugins.write'
  ),
  'draft-create plugin commands remain gated by integration_plugins.write'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        COALESCE(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}', '[]'::jsonb)
      ) AS section(value),
      jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
     WHERE item.value->>'key' = 'int-plugin-studio'
       AND item.value->>'capability' = 'integration_plugins.write'
  ),
  'Plugin Studio authoring navigation remains gated by integration_plugins.write'
);

SELECT * FROM finish();
ROLLBACK;

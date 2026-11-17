-- Test Suite: UI command registry defaults
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'commands'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'commands') AS value
          WHERE value->>'key' = 'settings_change_request'
       )
  ),
  'ui_command_registry includes settings_change_request'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'commands'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'commands') AS value
          WHERE value->>'key' = 'access_policy_change_request'
       )
  ),
  'ui_command_registry includes access_policy_change_request'
);

SELECT is(
  (
    SELECT value->>'schema_category'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS value
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND value->>'key' = 'access_policy_change_request'
     LIMIT 1
  ),
  'access_control_policy',
  'access_policy_change_request schema_category set'
);

SELECT is(
  (
    SELECT value#>>'{route_targets,console,path}'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS value
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND value->>'key' = 'settings_change_request'
     LIMIT 1
  ),
  '/settings/request',
  'settings_change_request route target set'
);

SELECT is(
  (
    SELECT value#>>'{route_targets,console,path}'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS value
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND value->>'key' = 'access_policy_change_request'
     LIMIT 1
  ),
  '/access-policy/request',
  'access_policy_change_request route target set'
);

SELECT finish();

ROLLBACK;

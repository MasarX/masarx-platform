-- Test Suite: UI security resources (registry + RLS)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT has_table('public', 'provider_auth_configs', 'provider_auth_configs table exists');
SELECT has_table('public', 'audit_table_changes', 'audit_table_changes table exists');

SELECT ok(
  (SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'provider_auth_configs'),
  'RLS enabled on provider_auth_configs'
);

SELECT ok(
  (SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'audit_table_changes'),
  'RLS enabled on audit_table_changes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies pol
     WHERE pol.schemaname = 'public'
       AND pol.tablename = 'provider_auth_configs'
       AND pol.policyname = 'provider_auth_configs_select'
  ),
  'provider_auth_configs_select policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies pol
     WHERE pol.schemaname = 'public'
       AND pol.tablename = 'audit_table_changes'
       AND pol.policyname = 'audit_table_changes_select'
  ),
  'audit_table_changes_select policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'provider_auth_configs'
       )
  ),
  'ui_read_registry includes provider_auth_configs'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'audit_table_changes'
       )
  ),
  'ui_read_registry includes audit_table_changes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'token_rotation_requests'
       )
  ),
  'ui_read_registry includes token_rotation_requests'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resource_map'
       AND cached_value->'resource_map' ? 'provider_auth_configs'
  ),
  'access_control_policy resource_map includes provider_auth_configs'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resource_map'
       AND cached_value->'resource_map' ? 'audit_table_changes'
  ),
  'access_control_policy resource_map includes audit_table_changes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resource_map'
       AND cached_value->'resource_map' ? 'token_rotation_requests'
  ),
  'access_control_policy resource_map includes token_rotation_requests'
);

SELECT finish();

ROLLBACK;

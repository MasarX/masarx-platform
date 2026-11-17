BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT ok(
  NOT has_table_privilege('ui_rpc_executor', 'public.provider_auth_configs', 'UPDATE')
  AND NOT has_table_privilege('ui_rpc_executor', 'public.provider_auth_configs', 'INSERT')
  AND NOT has_table_privilege('ui_rpc_executor', 'public.provider_auth_configs', 'DELETE'),
  'executor has no provider credential table writes');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
  WHERE object_id = 'public.provider_auth_configs'::regclass
    AND privilege IN ('UPDATE', 'INSERT', 'DELETE')
  ), 'executor plan has no provider credential table writes');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
  WHERE s.category = 'ui_read_registry' AND resource->>'key' = 'provider_auth_configs'
    AND (resource->>'relation' IS DISTINCT FROM 'public.provider_auth_configs_visible_v1'
      OR resource ? 'read_relation')
  ), 'provider auth registry stays on the visible read view');
SELECT ok(NOT has_table_privilege('ui_rpc_executor', 'public.provider_auth_configs', 'TRUNCATE'),
  'executor cannot truncate provider credentials');
SELECT ok(NOT has_table_privilege('ui_rpc_executor', 'public.provider_auth_configs', 'REFERENCES'),
  'executor has no provider credential reference privilege');

SELECT * FROM finish();
ROLLBACK;

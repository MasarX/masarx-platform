-- pgTAP: Console V2 workflow capability alias repair covers scoped policies.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type <> 'global'
  ),
  'fixture includes scoped access_control_policy rows that can override global grants'
);

SELECT is_empty(
  $$
  SELECT s.scope_type, s.scope_id, role->>'key' AS role_key
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
   WHERE s.category = 'access_control_policy'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(COALESCE(role->'capability_keys', '[]'::jsonb)) AS key
        WHERE key IN ('workflow_runs.read', 'workflow_runs.write', 'workflows.write')
     )
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(COALESCE(role->'capability_keys', '[]'::jsonb)) AS key
        WHERE key IN ('*', 'workflows.read')
     )
  $$,
  'every scoped/global role that can read legacy workflow runs can read Console V2 workflow surfaces'
);

SELECT is_empty(
  $$
  SELECT s.scope_type, s.scope_id, role->>'key' AS role_key
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
   WHERE s.category = 'access_control_policy'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(COALESCE(role->'capability_keys', '[]'::jsonb)) AS key
        WHERE key = 'workflow_runs.write'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(COALESCE(role->'capability_keys', '[]'::jsonb)) AS key
        WHERE key IN ('*', 'workflows.write')
     )
  $$,
  'every scoped/global role that can write legacy workflow runs can write Console V2 workflow surfaces'
);

SELECT is_empty(
  $$
  SELECT s.scope_type, s.scope_id
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS capability
        WHERE capability->>'key' = 'workflows.read'
     )
  $$,
  'every access_control_policy scope registers workflows.read in the capability catalog'
);

SELECT is_empty(
  $$
  SELECT s.scope_type, s.scope_id
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS capability
        WHERE capability->>'key' = 'workflows.write'
     )
  $$,
  'every access_control_policy scope registers workflows.write in the capability catalog'
);

SELECT * FROM finish();
ROLLBACK;

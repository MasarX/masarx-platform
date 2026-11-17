-- Plan: PLAN-202602-fieldops-web-preview-support-v1 / Step: S99
-- pgTAP: access_control_policy includes mobile task capabilities for ops_admin

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS cap
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND cap->>'key' = 'tasks.read'
  ),
  'access_control_policy capabilities include tasks.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS cap
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND cap->>'key' = 'tasks.complete'
  ),
  'access_control_policy capabilities include tasks.complete'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
        ELSE '[]'::jsonb
      END
    ) AS cap(value)
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND role->>'key' = 'ops_admin'
      AND cap.value = 'tasks.read'
  ),
  'ops_admin role includes tasks.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
        ELSE '[]'::jsonb
      END
    ) AS cap(value)
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND role->>'key' = 'ops_admin'
      AND cap.value = 'tasks.complete'
  ),
  'ops_admin role includes tasks.complete'
);

SELECT * FROM finish();

ROLLBACK;

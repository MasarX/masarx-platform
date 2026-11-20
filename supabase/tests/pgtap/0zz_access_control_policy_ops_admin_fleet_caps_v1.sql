-- pgTAP: access_control_policy ops_admin fleet capability guard

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
      AND lower(COALESCE(cap->>'key', '')) = 'fleet.read'
  ),
  'access_control_policy global policy declares fleet.read'
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
      AND lower(COALESCE(cap->>'key', '')) = 'fleet.write'
  ),
  'access_control_policy global policy declares fleet.write'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
    WHERE s.category = 'access_control_policy'
      AND lower(COALESCE(role->>'key', '')) = 'ops_admin'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
            ELSE '[]'::jsonb
          END
        ) AS cap(value)
        WHERE cap.value = '*'
           OR lower(cap.value) = 'fleet.read'
      )
  ),
  'every access_control_policy ops_admin row includes fleet.read or wildcard'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
    WHERE s.category = 'access_control_policy'
      AND lower(COALESCE(role->>'key', '')) = 'ops_admin'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
            ELSE '[]'::jsonb
          END
        ) AS cap(value)
        WHERE cap.value = '*'
           OR lower(cap.value) = 'fleet.write'
      )
  ),
  'every access_control_policy ops_admin row includes fleet.write or wildcard'
);

SELECT * FROM finish();

ROLLBACK;

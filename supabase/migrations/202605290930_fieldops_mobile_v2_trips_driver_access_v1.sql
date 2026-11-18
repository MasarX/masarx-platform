-- Migration: FieldOps Mobile V2 trips driver access
-- Date: 2026-05-29
-- Purpose:
--   Keep the Mobile V2 Trips lane discoverable through row-driven access
--   policy. The navigation item already exists and is gated by trips.read;
--   driver runtime roles need that same capability so the visible shell can
--   reach trips without bypassing ui_navigation_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605290930_fieldops_mobile_v2_trips_driver_access_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'rbac_permission',
  'RBAC permissions registry (stable keys) for RLS/RPC predicates',
  'security',
  'tier_1',
  TRUE
)
ON CONFLICT (category) DO NOTHING;

WITH permission_definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'rbac_permission'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  pd.id,
  'trips.read',
  'Trips Read',
  'Read FieldOps Mobile V2 trip lists and trip navigation.',
  9470,
  FALSE,
  'active',
  jsonb_build_object(
    'resource', 'trips',
    'action', 'read',
    'source', 'fieldops_mobile_v2_trips_driver_access_v1'
  )
FROM permission_definition pd
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       status = 'active',
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now();

WITH permission_registry AS (
  SELECT lv.id
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'trips.read'
   LIMIT 1
),
template_perm_map AS (
  SELECT *
    FROM (VALUES
      ('driver'),
      ('fieldops_money_driver')
    ) AS v(template_key)
)
INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
SELECT
  t.id,
  p.id,
  jsonb_build_object(
    'seed', TRUE,
    'template_key', t.key,
    'source', 'fieldops_mobile_v2_trips_driver_access_v1'
  )
FROM template_perm_map m
JOIN public.rbac_role_templates t
  ON t.key = m.template_key
CROSS JOIN permission_registry p
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

WITH permission_registry AS (
  SELECT lv.id
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'trips.read'
   LIMIT 1
)
INSERT INTO public.rbac_role_permissions (
  organization_id,
  role_id,
  permission_id,
  metadata
)
SELECT
  r.organization_id,
  r.id,
  p.id,
  jsonb_build_object(
    'seed', TRUE,
    'role_key', r.key,
    'source', 'fieldops_mobile_v2_trips_driver_access_v1'
  )
FROM public.rbac_roles r
CROSS JOIN permission_registry p
WHERE r.key IN ('driver', 'fieldops_money_driver')
ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.fieldops_mobile_v2_trips_driver_policy_v1(p_policy JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_caps JSONB := COALESCE(p_policy->'capabilities', '[]'::jsonb);
  v_roles JSONB := COALESCE(p_policy->'roles', '[]'::jsonb);
  v_assignments JSONB := COALESCE(p_policy->'assignments', '{}'::jsonb);
  v_user_type_assignments JSONB := COALESCE(p_policy#>'{assignments,user_type}', '{}'::jsonb);
  v_role JSONB;
  v_role_keys JSONB;
  v_role_idx INTEGER;
  v_role_name TEXT;
BEGIN
  IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
    v_caps := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
    v_roles := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_assignments) IS DISTINCT FROM 'object' THEN
    v_assignments := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(v_user_type_assignments) IS DISTINCT FROM 'object' THEN
    v_user_type_assignments := '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_caps) cap
     WHERE cap->>'key' = 'trips.read'
  ) THEN
    v_caps := v_caps || jsonb_build_array(jsonb_build_object(
      'key', 'trips.read',
      'label', 'Trips read',
      'category', 'operate'
    ));
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY['driver', 'fieldops_money_driver'] LOOP
    IF NOT (v_user_type_assignments ? v_role_name) THEN
      v_user_type_assignments := jsonb_set(
        v_user_type_assignments,
        ARRAY[v_role_name],
        jsonb_build_array(v_role_name),
        TRUE
      );
    END IF;
  END LOOP;

  FOR v_role_idx IN 0 .. GREATEST(jsonb_array_length(v_roles) - 1, -1) LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' IN ('driver', 'fieldops_money_driver') THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF jsonb_typeof(v_role_keys) IS DISTINCT FROM 'array' THEN
        v_role_keys := '[]'::jsonb;
      END IF;
      IF NOT (v_role_keys @> to_jsonb('trips.read'::text))
         AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
        v_role_keys := v_role_keys || to_jsonb('trips.read'::text);
      END IF;
      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys, TRUE);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role, TRUE);
    END IF;
  END LOOP;

  v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_assignments, TRUE);
  v_policy := jsonb_set(v_policy, '{capabilities}', v_caps, TRUE);
  v_policy := jsonb_set(v_policy, '{roles}', v_roles, TRUE);
  v_policy := jsonb_set(v_policy, '{assignments}', v_assignments, TRUE);
  RETURN v_policy;
END;
$$;

DO $do$
DECLARE
  v_rec RECORD;
  v_next JSONB;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
BEGIN
  FOR v_rec IN
    SELECT id, category, scope_type, scope_id, value
      FROM public.settings_versions
     WHERE category = 'access_control_policy'
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
     ORDER BY scope_type, scope_id NULLS FIRST, version
  LOOP
    v_next := pg_temp.fieldops_mobile_v2_trips_driver_policy_v1(v_rec.value);
    IF v_next IS NOT DISTINCT FROM v_rec.value THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET effective_until = GREATEST(now(), effective_from + interval '1 millisecond')
     WHERE id = v_rec.id;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = v_rec.category
       AND scope_type = v_rec.scope_type
       AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(v_rec.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at
    ) VALUES (
      v_rec.category,
      v_rec.scope_type,
      v_rec.scope_id,
      v_next_version,
      v_next,
      1,
      'FieldOps Mobile V2 trips: grant trips.read access to driver runtime roles.',
      now()
    )
    RETURNING id INTO v_new_settings_version_id;

    UPDATE public.settings
       SET settings_version_id = v_new_settings_version_id,
           cached_value = v_next,
           last_updated = now()
     WHERE category = v_rec.category
       AND scope_type = v_rec.scope_type
       AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(v_rec.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%'
      OR cache_key LIKE 'ui_navigation:%';
END;
$do$;

SELECT pg_notify('pgrst', 'reload schema');

SELECT pg_advisory_unlock(hashtext('202605290930_fieldops_mobile_v2_trips_driver_access_v1'));
COMMIT;

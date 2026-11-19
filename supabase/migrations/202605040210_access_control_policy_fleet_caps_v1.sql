-- Migration: Register fleet capabilities and decision category policy
-- Date: 2026-05-03
-- Purpose:
--   Align the capability-policy catalog with the canonical RBAC fleet catalog
--   so fleet RPCs gated by assert_capability_v1('fleet.write') resolve from
--   row-driven policy instead of seed/test assumptions.
--   Also register the decision category emitted by the canonical fleet
--   assignment RPC so decision_log lookup enforcement remains fail-closed.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031380_access_control_policy_fleet_caps_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH def AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'user_type'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  def.id,
  'fleet_manager',
  'Fleet Manager',
  'Manage fleet assets and assignments',
  60,
  false,
  jsonb_build_object('default_scope_type', 'tenant')
FROM def
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    metadata = public.deep_merge_jsonb(COALESCE(public.lookup_values.metadata, '{}'::jsonb), EXCLUDED.metadata),
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status
)
SELECT
  ld.id,
  'fleet.driver_assigned',
  'Fleet Driver Assigned',
  'Vehicle assignment decisions emitted by assign_driver_to_vehicle_v1.',
  146,
  false,
  'active'
FROM public.lookup_definitions ld
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    updated_at = now();

DO $$
DECLARE
  v_current JSONB;
  v_caps JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_cap JSONB;
  v_role JSONB;
  v_role_caps JSONB := '[]'::jsonb;
  v_resource TEXT;
  v_has_fleet_manager BOOLEAN := FALSE;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'fleet.read',
      'label', 'Fleet read',
      'description', 'Read fleet assets, driver profiles, assignments, and maintenance.',
      'category', 'operations'
    ),
    jsonb_build_object(
      'key', 'fleet.write',
      'label', 'Fleet write',
      'description', 'Manage fleet assets, driver assignments, driver documents, and maintenance.',
      'category', 'operations'
    )
  );
  v_fleet_manager_role JSONB := jsonb_build_object(
    'key', 'fleet_manager',
    'label', 'Fleet Manager',
    'description', 'Manage fleet assets and assignments',
    'capability_keys', jsonb_build_array('fleet.read', 'fleet.write', 'tasks.read')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
    v_caps := '[]'::jsonb;
  END IF;

  FOR v_cap IN SELECT * FROM jsonb_array_elements(v_new_caps) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_caps) AS item
      WHERE item->>'key' = v_cap->>'key'
    ) THEN
      v_caps := v_caps || jsonb_build_array(v_cap);
    END IF;
  END LOOP;

  v_roles := '[]'::jsonb;
  FOR v_role IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb)) LOOP
    IF v_role->>'key' IN ('ops_admin', 'fleet_manager') THEN
      v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF jsonb_typeof(v_role_caps) IS DISTINCT FROM 'array' THEN
        v_role_caps := '[]'::jsonb;
      END IF;

      v_role := jsonb_set(
        v_role,
        '{capability_keys}',
        to_jsonb(ARRAY(
          SELECT DISTINCT cap
          FROM (
            SELECT jsonb_array_elements_text(v_role_caps) AS cap
            UNION ALL SELECT unnest(
              CASE
                WHEN v_role->>'key' = 'fleet_manager'
                  THEN ARRAY['fleet.read', 'fleet.write', 'tasks.read']::text[]
                ELSE ARRAY['fleet.read', 'fleet.write']::text[]
              END
            ) AS cap
          ) AS caps
          ORDER BY cap
        )),
        true
      );
    END IF;

    IF v_role->>'key' = 'fleet_manager' THEN
      v_has_fleet_manager := TRUE;
    END IF;

    v_roles := v_roles || jsonb_build_array(v_role);
  END LOOP;

  IF NOT v_has_fleet_manager THEN
    v_roles := v_roles || jsonb_build_array(v_fleet_manager_role);
  END IF;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
  IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
    v_resource_map := '{}'::jsonb;
  END IF;

  FOREACH v_resource IN ARRAY ARRAY[
    'fleet',
    'drivers',
    'driver_profiles',
    'driver_documents',
    'driver_compliance_events',
    'vehicles',
    'vehicle_types',
    'vehicle_assignments',
    'vehicle_events',
    'vehicle_maintenance_windows'
  ]::text[]
  LOOP
    v_resource_map := jsonb_set(
      v_resource_map,
      ARRAY[v_resource],
      jsonb_build_object('read', 'fleet.read', 'write', 'fleet.write'),
      true
    );
  END LOOP;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps, true);
  v_current := jsonb_set(v_current, '{roles}', v_roles, true);
  v_current := jsonb_set(v_current, '{assignments,user_type,fleet_manager}', jsonb_build_array('fleet_manager'), true);
  v_current := jsonb_set(v_current, '{resource_map}', v_resource_map, true);

  WITH current_policy AS (
    SELECT s.settings_version_id,
           sv.value,
           sv.version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current_policy.version + 1,
           change_reason = 'Register fleet.read/fleet.write capabilities and fleet_manager role in access_control_policy.',
           approved_at = now(),
           effective_from = now()
      FROM current_policy
     WHERE sv.id = current_policy.settings_version_id
       AND v_current IS DISTINCT FROM current_policy.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';
END $$;

SELECT pg_advisory_unlock(hashtext('202605031380_access_control_policy_fleet_caps_v1'));
COMMIT;

-- Migration: Dispatch fleet setup access policy v1
-- Purpose:
--   - Keep fleet setup RPCs on the canonical assert_capability_v1 path.
--   - Add fleet.read/fleet.write to access_control_policy for tenant operators
--     used by Dispatch route scan-out proof setup.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202607032215_dispatch_fleet_setup_access_policy_v1'));

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
  'Tenant fleet operator role for fleet setup and assignment operations',
  6,
  false,
  jsonb_build_object('default_scope_type', 'tenant')
FROM def
ON CONFLICT (lookup_definition_id, value)
DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  status = 'active',
  updated_at = now();

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_caps JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_role_source JSONB := '[]'::jsonb;
  v_role JSONB;
  v_cap JSONB;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'fleet.read',
      'label', 'Fleet read',
      'category', 'operations',
      'description', 'Read fleet driver, vehicle, and active assignment projections.'
    ),
    jsonb_build_object(
      'key', 'fleet.write',
      'label', 'Fleet write',
      'category', 'operations',
      'description', 'Create fleet driver profiles, vehicles, and active vehicle assignments.'
    )
  );
  v_assignments JSONB := '{}'::jsonb;
  v_user_type_assignments JSONB := '{}'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_key TEXT;
BEGIN
  FOR v_row IN
    SELECT
      s.id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    FOR v_cap IN
      SELECT value
      FROM jsonb_array_elements(v_new_caps) AS value
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_caps) AS item(value)
        WHERE item.value->>'key' = v_cap->>'key'
      ) THEN
        v_caps := v_caps || jsonb_build_array(v_cap);
      END IF;
    END LOOP;

    v_role_source := COALESCE(v_current->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_role_source) IS DISTINCT FROM 'array' THEN
      v_role_source := '[]'::jsonb;
    END IF;

    v_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value
      FROM jsonb_array_elements(v_role_source) AS value
    LOOP
      IF v_role->>'key' IN ('ops_admin', 'fleet_manager') THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          to_jsonb(ARRAY(
            SELECT DISTINCT cap
            FROM (
              SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
              UNION ALL SELECT 'fleet.read'
              UNION ALL SELECT 'fleet.write'
            ) AS caps
            ORDER BY cap
          )),
          TRUE
        );
      END IF;

      v_roles := v_roles || jsonb_build_array(v_role);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_role_source) AS item(value)
      WHERE item.value->>'key' = 'fleet_manager'
    ) THEN
      v_roles := v_roles || jsonb_build_array(
        jsonb_build_object(
          'key', 'fleet_manager',
          'label', 'Fleet Manager',
          'capability_keys', jsonb_build_array('fleet.read', 'fleet.write')
        )
      );
    END IF;

    v_assignments := COALESCE(v_current->'assignments', '{}'::jsonb);
    IF jsonb_typeof(v_assignments) IS DISTINCT FROM 'object' THEN
      v_assignments := '{}'::jsonb;
    END IF;
    v_user_type_assignments := COALESCE(v_assignments->'user_type', '{}'::jsonb);
    IF jsonb_typeof(v_user_type_assignments) IS DISTINCT FROM 'object' THEN
      v_user_type_assignments := '{}'::jsonb;
    END IF;

    v_user_type_assignments := jsonb_set(
      v_user_type_assignments,
      '{fleet_manager}',
      jsonb_build_array('fleet_manager'),
      TRUE
    );
    v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_assignments, TRUE);

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    FOREACH v_key IN ARRAY ARRAY[
      'drivers',
      'driver_profiles',
      'driver_profile_picker',
      'vehicles',
      'vehicle_directory',
      'vehicle_assignments'
    ]
    LOOP
      v_resource_map := jsonb_set(
        v_resource_map,
        ARRAY[v_key],
        jsonb_build_object('read', 'fleet.read', 'write', 'fleet.write'),
        TRUE
      );
    END LOOP;

    v_next := jsonb_set(v_current, '{capabilities}', v_caps, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_roles, TRUE);
    v_next := jsonb_set(v_next, '{assignments}', v_assignments, TRUE);
    v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
      SET value = v_next,
          version = COALESCE(v_row.version, 0) + 1,
          change_reason = 'Enable fleet setup capabilities for Dispatch route scan-out proof setup.',
          approved_at = now(),
          effective_from = now()
      WHERE id = v_row.settings_version_id;

      UPDATE public.settings
      SET cached_value = v_next,
          last_updated = now()
      WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

COMMIT;

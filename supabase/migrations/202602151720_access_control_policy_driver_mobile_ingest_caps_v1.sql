-- Plan: PLAN-202602-fieldops-driver-go-live / Step: S04
-- Migration: Add driver role + mobile ingest capabilities to access_control_policy defaults (FieldOps).
-- Purpose:
--   - Keep FieldOps mobile module access policy-driven (no frontend bypass).
--   - Add `scan_events.write` + `location_pings.write` capabilities.
--   - Add/align `driver` role and map `user_type=driver` to that role.
--   - Ensure `ops_admin` also receives these capabilities for FieldOps ops testing.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602151720_access_control_policy_driver_mobile_ingest_caps_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_updated_roles JSONB := '[]'::jsonb;
  v_role JSONB;
  v_role_key TEXT;
  v_role_caps JSONB;
  v_seen_driver BOOLEAN := FALSE;

  v_assignments JSONB := '{}'::jsonb;
  v_user_type_map JSONB := '{}'::jsonb;
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

  ---------------------------------------------------------------------------
  -- Capabilities: ensure scan/location ingest keys exist.
  ---------------------------------------------------------------------------
  v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_capabilities) AS item
     WHERE item->>'key' = 'scan_events.write'
  ) THEN
    v_capabilities :=
      v_capabilities ||
      jsonb_build_array(
        jsonb_build_object(
          'key', 'scan_events.write',
          'label', 'Scan events write',
          'description', 'Record scan events from FieldOps devices'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_capabilities) AS item
     WHERE item->>'key' = 'location_pings.write'
  ) THEN
    v_capabilities :=
      v_capabilities ||
      jsonb_build_array(
        jsonb_build_object(
          'key', 'location_pings.write',
          'label', 'Location pings write',
          'description', 'Record location pings from FieldOps devices'
        )
      );
  END IF;

  ---------------------------------------------------------------------------
  -- Roles: add/align driver and ensure ops_admin includes needed caps.
  ---------------------------------------------------------------------------
  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);

  FOR v_role IN SELECT * FROM jsonb_array_elements(v_roles) LOOP
    v_role_key := NULLIF(v_role->>'key', '');
    v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);

    IF v_role_key IN ('ops_admin', 'driver') THEN
      IF jsonb_typeof(v_role_caps) = 'array'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_role_caps) AS value
            WHERE value = 'tasks.read' OR value = '*'
         ) THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          v_role_caps || jsonb_build_array('tasks.read'),
          true
        );
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      END IF;

      IF jsonb_typeof(v_role_caps) = 'array'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_role_caps) AS value
            WHERE value = 'tasks.complete' OR value = '*'
         ) THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          v_role_caps || jsonb_build_array('tasks.complete'),
          true
        );
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      END IF;

      IF jsonb_typeof(v_role_caps) = 'array'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_role_caps) AS value
            WHERE value = 'scan_events.write' OR value = '*'
         ) THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          v_role_caps || jsonb_build_array('scan_events.write'),
          true
        );
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      END IF;

      IF jsonb_typeof(v_role_caps) = 'array'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_role_caps) AS value
            WHERE value = 'location_pings.write' OR value = '*'
         ) THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          v_role_caps || jsonb_build_array('location_pings.write'),
          true
        );
      END IF;
    END IF;

    IF v_role_key = 'driver' THEN
      v_seen_driver := TRUE;
    END IF;

    v_updated_roles := v_updated_roles || jsonb_build_array(v_role);
  END LOOP;

  IF v_seen_driver IS FALSE THEN
    v_updated_roles :=
      v_updated_roles ||
      jsonb_build_array(
        jsonb_build_object(
          'key', 'driver',
          'label', 'Driver',
          'capability_keys', jsonb_build_array(
            'tasks.read',
            'tasks.complete',
            'scan_events.write',
            'location_pings.write'
          )
        )
      );
  END IF;

  ---------------------------------------------------------------------------
  -- Assignments: map user_type driver -> driver role
  ---------------------------------------------------------------------------
  v_assignments := COALESCE(v_current->'assignments', '{}'::jsonb);
  v_user_type_map := COALESCE(v_assignments->'user_type', '{}'::jsonb);

  IF (v_user_type_map ? 'driver') IS FALSE THEN
    v_user_type_map := jsonb_set(v_user_type_map, '{driver}', jsonb_build_array('driver'), true);
  END IF;

  v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_map, true);

  ---------------------------------------------------------------------------
  -- Persist (bump settings_versions version and cached_value)
  ---------------------------------------------------------------------------
  v_next := v_current;
  v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, true);
  v_next := jsonb_set(v_next, '{roles}', v_updated_roles, true);
  v_next := jsonb_set(v_next, '{assignments}', v_assignments, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_next,
           version = current.version + 1,
           change_reason = 'Add driver role + scan/location ingest capabilities (FieldOps)',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_next IS DISTINCT FROM current.value
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
END $$;

SELECT pg_advisory_unlock(hashtext('202602151720_access_control_policy_driver_mobile_ingest_caps_v1'));
COMMIT;

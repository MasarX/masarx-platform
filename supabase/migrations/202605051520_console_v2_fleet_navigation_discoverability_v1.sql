-- Migration: Console V2 fleet navigation discoverability
-- Purpose:
--   Console V2 fleet routes are domain workbenches, not raw resource-table
--   pages. Keep live ui_navigation row-driven and ensure every global/scoped
--   Console navigation policy exposes the fleet workbenches through the main
--   Operate shell and command palette.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051520_console_v2_fleet_navigation_discoverability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_sections JSONB := '[]'::jsonb;
  v_updated_sections JSONB := '[]'::jsonb;
  v_section JSONB := NULL;
  v_items JSONB := '[]'::jsonb;
  v_has_operate BOOLEAN := FALSE;
  v_fleet_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'operate-fleet-drivers',
      'key', 'operate-fleet-drivers',
      'label', 'Drivers',
      'href', '/operate/fleet/drivers',
      'route', '/operate/fleet/drivers',
      'resource', 'drivers',
      'capability', 'fleet.read',
      'icon', 'user'
    ),
    jsonb_build_object(
      'id', 'operate-fleet-vehicles',
      'key', 'operate-fleet-vehicles',
      'label', 'Vehicles',
      'href', '/operate/fleet/vehicles',
      'route', '/operate/fleet/vehicles',
      'resource', 'vehicle_directory',
      'capability', 'fleet.read',
      'icon', 'truck'
    ),
    jsonb_build_object(
      'id', 'operate-fleet-driver-applications',
      'key', 'operate-fleet-driver-applications',
      'label', 'Driver applications',
      'href', '/operate/fleet/driver-applications',
      'route', '/operate/fleet/driver-applications',
      'resource', 'driver_application_directory',
      'capability', 'fleet.read',
      'icon', 'user'
    )
  );
  v_operate_section JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_has_operate := FALSE;
    v_updated_sections := '[]'::jsonb;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      IF COALESCE(v_section->>'id', '') IN ('operations', 'operate') THEN
        v_has_operate := TRUE;
        v_items := COALESCE(v_section->'items', '[]'::jsonb);
        IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
          v_items := '[]'::jsonb;
        END IF;

        SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
         WHERE COALESCE(item.value->>'id', item.value->>'key', '') NOT IN (
                 'operate-fleet-drivers',
                 'operate-fleet-vehicles',
                 'operate-fleet-driver-applications'
               )
           AND COALESCE(item.value->>'resource', '') NOT IN (
                 'drivers',
                 'vehicle_directory',
                 'driver_application_directory'
               )
           AND COALESCE(item.value->>'route', item.value->>'href', '') NOT IN (
                 '/operate/fleet/drivers',
                 '/operate/fleet/vehicles',
                 '/operate/fleet/driver-applications',
                 '/console/resources/drivers',
                 '/console/resources/vehicles',
                 '/console/resources/driver_applications'
               );

        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_items, '[]'::jsonb) || v_fleet_items,
          TRUE
        );
      END IF;

      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_operate THEN
      v_operate_section := jsonb_build_object(
        'id', 'operations',
        'label', 'Operations',
        'items', v_fleet_items
      );

      IF jsonb_array_length(v_updated_sections) > 0 AND (v_updated_sections->0->>'id') = 'home' THEN
        v_updated_sections := jsonb_build_array(v_updated_sections->0, v_operate_section) || (v_updated_sections - 0);
      ELSE
        v_updated_sections := jsonb_build_array(v_operate_section) || v_updated_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 fleet workbenches in main navigation',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605051520_console_v2_fleet_navigation_discoverability_v1'));

COMMIT;

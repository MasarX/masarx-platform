-- Migration: Console V2 fleet registry scoped backfill
-- Purpose:
--   Fleet operator screens read multiple related live resources from one
--   domain view. Existing tenant-scoped ui_read_registry rows can miss those
--   fleet resources even when the global registry has them, causing backend
--   mode Console V2 pages to fail before rendering. Keep the registry
--   row-driven by backfilling scoped rows from canonical global resources.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051430_console_v2_fleet_registry_scope_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_required_keys TEXT[] := ARRAY[
    'driver_directory',
    'driver_application_directory',
    'driver_documents',
    'driver_compliance_events',
    'drivers',
    'hubs',
    'fleet_user_options',
    'vehicle_directory',
    'vehicle_assignments',
    'vehicle_documents',
    'vehicle_types',
    'vehicle_events',
    'vehicle_maintenance_directory'
  ];
  v_defaults JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'driver_directory',
      'relation', 'public.v_driver_directory',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
        jsonb_build_object('key', 'current_branch_id', 'column', 'current_branch_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'driver_application_directory',
      'relation', 'public.v_driver_application_directory',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'requested_organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'email', 'column', 'email', 'op', 'ilike'),
        jsonb_build_object('key', 'full_name', 'column', 'full_name', 'op', 'ilike')
      )
    ),
    jsonb_build_object(
      'key', 'driver_documents',
      'relation', 'public.driver_documents',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'expires_at', 'direction', 'asc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
        jsonb_build_object('key', 'doc_type', 'column', 'doc_type', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'driver_compliance_events',
      'relation', 'public.driver_compliance_events',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
        jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'drivers',
      'relation', 'public.drivers',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'hubs',
      'relation', 'public.hubs',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'code', 'direction', 'asc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'code', 'column', 'code', 'op', 'ilike'),
        jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'fleet_user_options',
      'relation', 'public.users',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'full_name', 'direction', 'asc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'email', 'column', 'email', 'op', 'ilike'),
        jsonb_build_object('key', 'full_name', 'column', 'full_name', 'op', 'ilike'),
        jsonb_build_object('key', 'user_type', 'column', 'user_type', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_directory',
      'relation', 'public.v_vehicle_directory',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'plate_number', 'column', 'plate_number', 'op', 'ilike'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'current_branch_id', 'column', 'current_branch_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_assignments',
      'relation', 'public.vehicle_assignments',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'started_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'vehicle_id', 'column', 'vehicle_id', 'op', 'eq'),
        jsonb_build_object('key', 'assigned_to_user_id', 'column', 'assigned_to_user_id', 'op', 'eq'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_documents',
      'relation', 'public.vehicle_documents',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'expires_at', 'direction', 'asc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'vehicle_id', 'column', 'vehicle_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'doc_type', 'column', 'doc_type', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_types',
      'relation', 'public.vehicle_types',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'key', 'column', 'key', 'op', 'ilike'),
        jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_events',
      'relation', 'public.vehicle_events',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'vehicle_id', 'column', 'vehicle_id', 'op', 'eq'),
        jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_maintenance_directory',
      'relation', 'public.v_vehicle_maintenance_directory',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'window_start_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'vehicle_id', 'column', 'vehicle_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      )
    )
  );
  v_global_version_id UUID;
  v_global_current JSONB;
  v_global_resources JSONB;
  v_canonical_resources JSONB;
  v_resource JSONB;
  v_filtered JSONB;
  v_next JSONB;
  v_row RECORD;
BEGIN
  SELECT s.settings_version_id, COALESCE(s.cached_value, '{"resources":[]}'::jsonb)
    INTO v_global_version_id, v_global_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_global_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_global_resources := COALESCE(v_global_current->'resources', '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
    INTO v_filtered
    FROM jsonb_array_elements(v_global_resources) WITH ORDINALITY AS resource(value, ordinality)
   WHERE NOT (resource.value->>'key' = ANY(v_required_keys));

  v_global_resources := v_filtered || v_defaults;

  v_global_current := jsonb_set(v_global_current, '{resources}', v_global_resources, TRUE);

  UPDATE public.settings_versions
     SET value = v_global_current,
         updated_at = now(),
         change_reason = 'Ensure Console V2 fleet resources exist in global ui_read_registry'
   WHERE id = v_global_version_id;

  UPDATE public.settings
     SET cached_value = v_global_current,
         last_updated = now()
   WHERE settings_version_id = v_global_version_id;

  SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
    INTO v_canonical_resources
    FROM jsonb_array_elements(v_global_resources) WITH ORDINALITY AS resource(value, ordinality)
   WHERE resource.value->>'key' = ANY(v_required_keys);

  IF jsonb_array_length(v_canonical_resources) <> array_length(v_required_keys, 1) THEN
    RAISE EXCEPTION 'global ui_read_registry is missing one or more Console V2 fleet resources';
  END IF;

  FOR v_row IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
  LOOP
    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_row.cached_value->'resources', '[]'::jsonb))
        WITH ORDINALITY AS resource(value, ordinality)
     WHERE NOT (resource.value->>'key' = ANY(v_required_keys));

    v_next := jsonb_set(
      v_row.cached_value,
      '{resources}',
      v_filtered || v_canonical_resources,
      TRUE
    );

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now(),
           change_reason = 'Backfill scoped Console V2 fleet registry resources from global registry'
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.setting_id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605051430_console_v2_fleet_registry_scope_backfill_v1'));

COMMIT;

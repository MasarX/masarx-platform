-- Console V2 Dispatch live registry for route-run directory projection.
--
-- Dispatch refresh reads route_run_directory alongside route_runs,
-- route_stops, and assignment ledgers. The projection view already exists;
-- this migration makes it available through the canonical ui_read_registry
-- path so operators refresh backend-derived driver/assignment context.

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := '{}'::jsonb;
  v_resources JSONB := '[]'::jsonb;
  v_next JSONB := '{}'::jsonb;
  v_resource JSONB := jsonb_build_object(
    'key', 'route_run_directory',
    'relation', 'public.v_route_run_directory',
    'id_column', 'id',
    'capability_read', 'routes.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'allow_view_relation', TRUE,
    'default_sort', jsonb_build_object('column', 'planned_date', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
      jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
      jsonb_build_object('key', 'route_plan_id', 'column', 'route_plan_id', 'op', 'eq')
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      v_current := '{}'::jsonb;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_resources := (
      SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb)
        FROM jsonb_array_elements(v_resources) AS item(value)
       WHERE item.value->>'key' <> 'route_run_directory'
    ) || jsonb_build_array(v_resource);

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'console v2 dispatch route_run_directory registry',
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

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := '{}'::jsonb;
  v_resources JSONB := '[]'::jsonb;
  v_next JSONB := '{}'::jsonb;
  v_resource JSONB;
  v_dispatch_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'route_run_assignments',
      'relation', 'public.route_run_assignments',
      'id_column', 'id',
      'capability_read', 'routes.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'assigned_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'route_run_id', 'column', 'route_run_id', 'op', 'eq'),
        jsonb_build_object('key', 'assignment_status', 'column', 'assignment_status', 'op', 'eq'),
        jsonb_build_object('key', 'assignment_mode', 'column', 'assignment_mode', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'route_run_assignment_events',
      'relation', 'public.route_run_assignment_events',
      'id_column', 'id',
      'capability_read', 'routes.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'route_run_id', 'column', 'route_run_id', 'op', 'eq'),
        jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq'),
        jsonb_build_object('key', 'assignment_mode', 'column', 'assignment_mode', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'route_stop_reassignment_events',
      'relation', 'public.route_stop_reassignment_events',
      'id_column', 'id',
      'capability_read', 'routes.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'route_stop_id', 'column', 'route_stop_id', 'op', 'eq'),
        jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
        jsonb_build_object('key', 'source_route_run_id', 'column', 'source_route_run_id', 'op', 'eq'),
        jsonb_build_object('key', 'target_route_run_id', 'column', 'target_route_run_id', 'op', 'eq')
      )
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      v_current := '{}'::jsonb;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    FOR v_resource IN
      SELECT value
        FROM jsonb_array_elements(v_dispatch_resources)
    LOOP
      v_resources := (
        SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb)
          FROM jsonb_array_elements(v_resources) AS item(value)
         WHERE item.value->>'key' <> v_resource->>'key'
      ) || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'console v2 dispatch assignment ledger registry',
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

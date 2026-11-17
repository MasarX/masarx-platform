-- Migration: Restore canonical api route manifest registry relations
-- Purpose:
--   - Keep routes/route_stops generic reads aligned with the browser-safe
--     api.route_runs/api.route_stops views.
--   - Preserve the explicit allow_view_relation opt-in required by
--     ui_list_resource_v1/ui_get_resource_v1 for approved view-backed reads.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102150_route_manifest_ui_registry_api_relation_restore_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_routes_resource_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'key', 'routes',
    'label', 'Routes',
    'relation', 'api.route_runs',
    'allow_view_relation', TRUE,
    'id_column', 'id',
    'capability_read', 'routes.read',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'branch_id',
      'driver_user_id',
      'vehicle_id',
      'status',
      'planned_date',
      'planned_start_at',
      'planned_end_at',
      'route_plan_id',
      'route_assignment',
      'metadata',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
      jsonb_build_object('key', 'route_plan_id', 'column', 'route_plan_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'planned_date', 'direction', 'desc')
  );
$$;

COMMENT ON FUNCTION public.ui_read_registry_routes_resource_v1()
  IS 'Canonical ui_read_registry resource payload for browser-safe route manifest reads through api.route_runs.';

CREATE OR REPLACE FUNCTION public.ui_read_registry_route_stops_resource_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'key', 'route_stops',
    'label', 'Route Stops',
    'relation', 'api.route_stops',
    'allow_view_relation', TRUE,
    'id_column', 'id',
    'capability_read', 'routes.read',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'route_run_id',
      'client_id',
      'shipment_id',
      'stop_kind',
      'sequence_order',
      'planned_start_at',
      'planned_end_at',
      'route_run_status',
      'driver_user_id',
      'vehicle_id',
      'branch_id',
      'route_plan_id',
      'planned_date',
      'route_planned_start_at',
      'route_planned_end_at',
      'route_assignment',
      'metadata',
      'created_at',
      'updated_at',
      'cod_amount',
      'cod_currency',
      'payment',
      'expected_amount',
      'collection_required',
      'allowed_methods',
      'payment_mode_label'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'route_run_id', 'column', 'route_run_id', 'op', 'eq'),
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'stop_kind', 'column', 'stop_kind', 'op', 'eq'),
      jsonb_build_object('key', 'route_run_status', 'column', 'route_run_status', 'op', 'eq'),
      jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'sequence_order', 'direction', 'asc')
  );
$$;

COMMENT ON FUNCTION public.ui_read_registry_route_stops_resource_v1()
  IS 'Canonical ui_read_registry resource payload for browser-safe route stop manifest reads through api.route_stops.';

DO $do$
DECLARE
  v_routes_resource JSONB := public.ui_read_registry_routes_resource_v1();
  v_route_stops_resource JSONB := public.ui_read_registry_route_stops_resource_v1();
  v_setting RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_item JSONB := NULL;
BEGIN
  FOR v_setting IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND sv.effective_until IS NULL
  LOOP
    v_current := COALESCE(v_setting.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_updated_resources := '[]'::jsonb;
    FOR v_item IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_item->>'key' = 'routes' THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_routes_resource);
      ELSIF v_item->>'key' = 'route_stops' THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_route_stops_resource);
      ELSE
        v_updated_resources := v_updated_resources || jsonb_build_array(v_item);
      END IF;
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Restore routes/route_stops ui_read_registry relations to api manifest views with explicit view opt-in.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604102150_route_manifest_ui_registry_api_relation_restore_v1'));

COMMIT;

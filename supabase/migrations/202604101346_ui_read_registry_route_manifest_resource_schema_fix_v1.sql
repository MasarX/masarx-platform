-- Migration: Canonicalize route manifest ui_read_registry resources
-- Purpose:
--   - Reconcile the UC077 route manifest resources with the canonical
--     ui_read_registry schema contract.
--   - Replace legacy primary_key/select_fields + array default_sort payloads
--     with schema-compliant id_column/select + object default_sort values
--     across every active ui_read_registry scope row.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101346_ui_read_registry_route_manifest_resource_schema_fix_v1'));
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
    'relation', 'public.route_runs_visible_v1',
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
  IS 'Canonical ui_read_registry resource payload for executor-scoped route runs.';

CREATE OR REPLACE FUNCTION public.ui_read_registry_route_stops_resource_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'key', 'route_stops',
    'label', 'Route Stops',
    'relation', 'public.route_stops_visible_v1',
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
  IS 'Canonical ui_read_registry resource payload for executor-scoped route stops.';

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
  v_routes_found BOOLEAN := FALSE;
  v_route_stops_found BOOLEAN := FALSE;
BEGIN
  FOR v_setting IN
    SELECT
      s.id AS settings_id,
      s.scope_type,
      s.scope_id,
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
    v_routes_found := FALSE;
    v_route_stops_found := FALSE;

    FOR v_item IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_item->>'key' = 'routes' THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_routes_resource);
        v_routes_found := TRUE;
      ELSIF v_item->>'key' = 'route_stops' THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_route_stops_resource);
        v_route_stops_found := TRUE;
      ELSE
        v_updated_resources := v_updated_resources || jsonb_build_array(v_item);
      END IF;
    END LOOP;

    IF NOT v_routes_found THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_routes_resource);
    END IF;

    IF NOT v_route_stops_found THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_route_stops_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Canonicalize route manifest ui_read_registry resources to schema-compliant defaults',
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

SELECT pg_advisory_unlock(hashtext('202604101346_ui_read_registry_route_manifest_resource_schema_fix_v1'));

COMMIT;

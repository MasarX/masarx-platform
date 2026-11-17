BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20260915001000_residual_db_qualification_repairs_v1'));

REVOKE INSERT, UPDATE, DELETE ON TABLE public.workflow_template_steps FROM authenticated;

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
      'planned_window_start_at',
      'planned_window_end_at',
      'route_run_status',
      'driver_user_id',
      'vehicle_id',
      'branch_id',
      'route_plan_id',
      'planned_date',
      'route_planned_start_at',
      'route_planned_end_at',
      'route_assignment',
      'destination_address',
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

DO $repair$
DECLARE
  r RECORD;
  item JSONB;
  resources JSONB;
  next_value JSONB;
BEGIN
  PERFORM 1
    FROM public.settings_versions
   WHERE category = 'ui_read_registry'
     AND effective_until IS NULL
     AND approved_at IS NOT NULL
   ORDER BY id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved ui_read_registry baseline missing';
  END IF;

  FOR r IN
    SELECT s.scope_type, s.scope_id, s.cached_value, sv.value, sv.schema_version,
           sv.category AS version_category, sv.scope_type AS version_scope_type,
           sv.scope_id AS version_scope_id, sv.approved_at, sv.effective_until
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
     ORDER BY s.id
     FOR UPDATE OF s
  LOOP
    IF jsonb_typeof(r.value->'resources') IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    resources := '[]'::jsonb;
    FOR item IN
      SELECT value FROM jsonb_array_elements(r.value->'resources')
    LOOP
      IF item->>'key' = 'route_stops'
         AND COALESCE(NULLIF(btrim(item->>'read_relation'), ''), item->>'relation')
             IN ('api.route_stops', 'public.route_stops_visible_v1')
         AND jsonb_typeof(item->'select') = 'array'
         AND NOT item->'select' ? 'destination_address' THEN
        item := jsonb_set(item, '{select}', item->'select' || jsonb_build_array('destination_address'));
      END IF;
      resources := resources || jsonb_build_array(item);
    END LOOP;

    next_value := jsonb_set(r.value, '{resources}', resources);
    IF next_value IS DISTINCT FROM r.value THEN
      IF r.cached_value IS DISTINCT FROM r.value
         OR r.version_category IS DISTINCT FROM 'ui_read_registry'
         OR r.version_scope_type IS DISTINCT FROM r.scope_type
         OR r.version_scope_id IS DISTINCT FROM r.scope_id
         OR r.approved_at IS NULL
         OR r.effective_until IS NOT NULL THEN
        RAISE EXCEPTION 'Route-stop registry repair requires matching current approved authority';
      END IF;

      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', r.scope_type, r.scope_id, next_value, r.schema_version,
        'Expose canonical route-stop destination address in explicit selections');
    END IF;
  END LOOP;
END;
$repair$;

COMMIT;

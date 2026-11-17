BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20260911233000_route_stop_registry_window_columns_v1'));
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
DO $repair$
DECLARE r RECORD; item JSONB; resources JSONB; selected JSONB; next_value JSONB;
BEGIN
 PERFORM 1 FROM public.settings_versions WHERE category='ui_read_registry'
  AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 FOR r IN SELECT s.id,s.scope_type,s.scope_id,s.cached_value,sv.value,sv.schema_version,
  sv.category AS version_category,sv.scope_type AS version_scope_type,
  sv.scope_id AS version_scope_id,sv.approved_at,sv.effective_until
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='ui_read_registry' ORDER BY s.id FOR UPDATE OF s LOOP
  IF jsonb_typeof(r.value->'resources') IS DISTINCT FROM 'array' THEN
   CONTINUE; -- No matching resource is established; preserve unrelated malformed state.
  END IF;
  resources := '[]'::jsonb;
  FOR item IN SELECT value FROM jsonb_array_elements(r.value->'resources') LOOP
   IF item->>'key'='route_stops'
    AND COALESCE(NULLIF(btrim(item->>'read_relation'),''),item->>'relation')
      IN ('api.route_stops','public.route_stops_visible_v1')
    AND jsonb_typeof(item->'select')='array'
    AND (item->'select' ?| ARRAY['planned_start_at','planned_end_at']) THEN
    -- Rewrite only known stale names on canonical relations; preserve overrides,
    -- omitted selections and every other field. If a canonical spelling already
    -- exists, remove its stale alias only; do not deduplicate unrelated entries.
    SELECT jsonb_agg(CASE value
      WHEN '"planned_start_at"'::jsonb THEN '"planned_window_start_at"'::jsonb
      WHEN '"planned_end_at"'::jsonb THEN '"planned_window_end_at"'::jsonb ELSE value END ORDER BY ord)
     INTO selected FROM jsonb_array_elements(item->'select') WITH ORDINALITY e(value,ord)
     WHERE NOT (value='"planned_start_at"'::jsonb AND item->'select' ? 'planned_window_start_at')
       AND NOT (value='"planned_end_at"'::jsonb AND item->'select' ? 'planned_window_end_at');
    item := jsonb_set(item,'{select}',selected);
   END IF;
   resources := resources || jsonb_build_array(item);
  END LOOP;
  next_value := jsonb_set(r.value,'{resources}',resources);
  IF next_value IS DISTINCT FROM r.value THEN
   IF r.cached_value IS DISTINCT FROM r.value
    OR r.version_category IS DISTINCT FROM 'ui_read_registry'
    OR r.version_scope_type IS DISTINCT FROM r.scope_type
    OR r.version_scope_id IS DISTINCT FROM r.scope_id
    OR r.approved_at IS NULL OR r.effective_until IS NOT NULL THEN
    RAISE EXCEPTION 'Route-stop repair requires matching current approved registry version';
   END IF;
   PERFORM public.upsert_settings_value_v1('ui_read_registry',r.scope_type,r.scope_id,next_value,
    r.schema_version,'Repair route-stop planned-window selection names on canonical projections');
  END IF;
 END LOOP;
END;
$repair$;
COMMIT;

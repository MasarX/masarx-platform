BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';

DO $registry$
DECLARE
  current_registry record;
  driver_position text;
  driver_resource jsonb;
  next_projection jsonb;
  next_value jsonb;
BEGIN
  -- The RPC uses the global projection even when a scoped registry presents the resource.
  SELECT s.id, s.scope_type, sv.value, sv.schema_version INTO STRICT current_registry
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
  WHERE s.category = 'ui_read_registry' AND s.scope_type = public.get_root_scope_type_key_v1()
    AND s.scope_id IS NULL
  FOR UPDATE OF s;

  SELECT (entry.ordinal - 1)::text, entry.value INTO STRICT driver_position, driver_resource
  FROM jsonb_array_elements(current_registry.value->'resources') WITH ORDINALITY AS entry(value, ordinal)
  WHERE entry.value->>'key' = 'driver_directory';

  IF COALESCE(NULLIF(btrim(driver_resource->>'read_relation'), ''), driver_resource->>'relation')
       IS DISTINCT FROM 'public.v_driver_directory'
     OR jsonb_typeof(driver_resource->'select') IS DISTINCT FROM 'array'
     OR driver_resource->'select' = '[]'::jsonb THEN
    RAISE EXCEPTION 'Unexpected driver directory projection in ui_read_registry settings row %', current_registry.id;
  END IF;

  SELECT (driver_resource->'select') || COALESCE(jsonb_agg(field ORDER BY ordinal), '[]'::jsonb)
    INTO next_projection
  FROM unnest(ARRAY['deliveries_today', 'deliveries_week', 'on_time_pct', 'customer_rating'])
    WITH ORDINALITY AS kpi(field, ordinal)
  WHERE NOT (driver_resource->'select' ? field);

  next_value := jsonb_set(current_registry.value, ARRAY['resources', driver_position, 'select'], next_projection);
  IF next_value IS DISTINCT FROM current_registry.value THEN
    PERFORM public.upsert_settings_value_v1('ui_read_registry', current_registry.scope_type,
      NULL, next_value, current_registry.schema_version, 'Project delivery KPIs for the driver directory');
  END IF;
END;
$registry$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
COMMIT;

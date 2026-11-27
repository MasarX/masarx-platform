BEGIN;

SET LOCAL lock_timeout = '30s';

-- Enforce the registry bounds for both versioned writes and the resolver cache.
CREATE FUNCTION public.validate_ui_live_refresh_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_live_refresh jsonb := (to_jsonb(NEW)->TG_ARGV[0])->'live_refresh';
  v_live_refresh_schema jsonb;
  v_properties jsonb;
  v_key text;
  v_bounds jsonb;
  v_number numeric;
BEGIN
  IF jsonb_typeof(v_live_refresh) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_presentation_policy row %: live_refresh must be an object', NEW.id
      USING ERRCODE = '23514';
  END IF;

  -- shortcut: bounds come from the newest active schema; validate per row schema_version when a second schema version is active.
  SELECT schema #> '{properties,live_refresh}'
    INTO v_live_refresh_schema
    FROM public.schema_registry
   WHERE category = NEW.category
     AND is_active
   ORDER BY version DESC
   LIMIT 1;

  v_properties := v_live_refresh_schema->'properties';
  IF jsonb_typeof(v_properties) IS DISTINCT FROM 'object' OR v_properties = '{}'::jsonb THEN
    RAISE EXCEPTION 'ui_presentation_policy row %: missing live_refresh schema properties', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF v_live_refresh_schema->'additionalProperties' = 'false'::jsonb AND EXISTS (
    SELECT 1
      FROM jsonb_object_keys(v_live_refresh) AS supplied(key)
     WHERE NOT (v_properties ? supplied.key)
  ) THEN
    RAISE EXCEPTION 'ui_presentation_policy row %: unknown key in live_refresh', NEW.id
      USING ERRCODE = '23514';
  END IF;

  FOR v_key, v_bounds IN SELECT key, value FROM jsonb_each(v_properties) LOOP
    v_number := CASE WHEN jsonb_typeof(v_live_refresh->v_key) = 'number'
                     THEN (v_live_refresh->>v_key)::numeric END;
    IF (v_number = trunc(v_number) AND
        v_number BETWEEN (v_bounds->>'minimum')::numeric AND (v_bounds->>'maximum')::numeric) IS NOT TRUE THEN
      RAISE EXCEPTION 'ui_presentation_policy row %: invalid live_refresh.%', NEW.id, v_key
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_ui_live_refresh_write_v1() FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;

CREATE TRIGGER validate_ui_live_refresh_version_v1
  BEFORE INSERT OR UPDATE OF category, value ON public.settings_versions
  FOR EACH ROW WHEN (NEW.category = 'ui_presentation_policy' AND NEW.value ? 'live_refresh')
  EXECUTE FUNCTION public.validate_ui_live_refresh_write_v1('value');

CREATE TRIGGER validate_ui_live_refresh_cache_v1
  BEFORE INSERT OR UPDATE OF category, cached_value ON public.settings
  FOR EACH ROW WHEN (NEW.category = 'ui_presentation_policy' AND NEW.cached_value ? 'live_refresh')
  EXECUTE FUNCTION public.validate_ui_live_refresh_write_v1('cached_value');

DO $migration$
DECLARE
  v_category constant text := 'ui_presentation_policy';
  v_live_refresh constant jsonb := '{
    "poll_interval_ms": 30000,
    "offline_after_ms": 60000,
    "max_reconnects": 3,
    "refetch_interval_ms": 10000
  }';
  v_schema_version integer;
  v_base_value jsonb;
BEGIN
  UPDATE public.schema_registry
     SET schema = jsonb_set(schema, '{properties,live_refresh}', '{
           "type": "object",
           "additionalProperties": false,
           "properties": {
             "poll_interval_ms": {"type": "integer", "minimum": 5000, "maximum": 300000},
             "offline_after_ms": {"type": "integer", "minimum": 15000, "maximum": 600000},
             "max_reconnects": {"type": "integer", "minimum": 1, "maximum": 10},
             "refetch_interval_ms": {"type": "integer", "minimum": 2000, "maximum": 60000}
           },
           "required": ["poll_interval_ms", "offline_after_ms", "max_reconnects", "refetch_interval_ms"]
         }'::jsonb),
         examples = jsonb_set(examples, '{0,live_refresh}', v_live_refresh)
   WHERE category = v_category
     AND is_active
  RETURNING version INTO STRICT v_schema_version;

  SELECT sv.value INTO STRICT v_base_value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = v_category
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND sv.approved_at IS NOT NULL
     AND sv.effective_until IS NULL;

  -- System seeds have no application user. Record the migration role in the change reason.
  PERFORM public.upsert_settings_value_v1(
    v_category,
    'global',
    NULL,
    jsonb_set(v_base_value, '{live_refresh}', v_live_refresh),
    v_schema_version,
    format('Seed Console V2 live refresh defaults (migration actor: %s)', current_user)
  );
END;
$migration$;

COMMIT;

BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';

DO $registry$
DECLARE
  v_registry record;
  v_resource jsonb;
  v_next jsonb;
BEGIN
  SELECT s.scope_type, sv.value, sv.schema_version INTO STRICT v_registry
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
  WHERE s.category = 'ui_read_registry' AND s.scope_type = public.get_root_scope_type_key_v1()
    AND s.scope_id IS NULL
  FOR UPDATE OF s;

  SELECT item INTO STRICT v_resource
  FROM jsonb_array_elements(v_registry.value->'resources') AS item
  WHERE item->>'key' = 'route_stop_reassignment_events';

  IF v_resource->>'relation' IS DISTINCT FROM 'public.route_stop_reassignment_events'
     OR v_resource->>'capability_read' IS DISTINCT FROM 'routes.read'
     OR (v_resource ? 'scope_columns' AND jsonb_typeof(v_resource->'scope_columns') <> 'object')
     OR COALESCE(v_resource#>>'{scope_columns,tenant}', 'organization_id') <> 'organization_id' THEN
    RAISE EXCEPTION 'Unexpected read-scope registry entry: %', v_resource->>'key';
  END IF;

  SELECT jsonb_set(v_registry.value, '{resources}', jsonb_agg(
    CASE WHEN item->>'key' = v_resource->>'key' THEN item || jsonb_build_object(
      'read_scope_types', jsonb_build_array('tenant'),
      'scope_columns', COALESCE(item->'scope_columns', '{}'::jsonb) || '{"tenant":"organization_id"}'::jsonb
    ) ELSE item END ORDER BY ordinal
  )) INTO v_next
  FROM jsonb_array_elements(v_registry.value->'resources') WITH ORDINALITY AS entry(item, ordinal);

  IF v_next IS DISTINCT FROM v_registry.value THEN
    PERFORM public.upsert_settings_value_v1('ui_read_registry', v_registry.scope_type,
      NULL, v_next, v_registry.schema_version, 'Restore read-scope guard');
    DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
  END IF;
END;
$registry$;

COMMIT;

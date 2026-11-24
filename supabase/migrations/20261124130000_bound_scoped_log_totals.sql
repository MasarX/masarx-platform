BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

DO $migration$
DECLARE
  definition text := pg_get_functiondef(
    'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure
  );
  old_declaration constant text := 'v_total BIGINT := 0;';
  old_strategies constant text := $sql$v_total_strategy NOT IN ('exact', 'estimate')$sql$;
  old_count constant text := $sql$  IF v_total_strategy = 'estimate' THEN
    v_sql := format(
      'EXPLAIN (FORMAT JSON) SELECT 1 FROM %I.%I WHERE %s',
      v_schema,
      v_table,
      v_where
    );
    EXECUTE v_sql INTO v_explain;
    v_total := COALESCE(NULLIF((v_explain->0->'Plan'->>'Plan Rows'), '')::bigint, 0);
    v_total_is_estimate := TRUE;
  ELSE
    v_sql := format($sql$;
  new_count constant text := $sql$  IF v_total_strategy = 'exact_then_estimate' THEN
    EXECUTE format(
      'SELECT COUNT(*) FROM (SELECT 1 FROM %I.%I WHERE %s LIMIT $1) visible_rows',
      v_schema, v_table, v_where
    ) INTO v_total USING v_max_page_size + 1;
    v_total_strategy := CASE WHEN v_total > v_max_page_size THEN 'estimate' ELSE 'exact' END;
  END IF;

  IF v_total_strategy = 'estimate' THEN
    v_sql := format(
      'EXPLAIN (FORMAT JSON) SELECT 1 FROM %I.%I WHERE %s',
      v_schema,
      v_table,
      v_where
    );
    EXECUTE v_sql INTO v_explain;
    v_total := COALESCE(GREATEST(v_total, NULLIF((v_explain->0->'Plan'->>'Plan Rows'), '')::bigint), 0);
    v_total_is_estimate := TRUE;
  ELSIF v_total IS NULL THEN
    v_sql := format($sql$;
BEGIN
  IF cardinality(string_to_array(definition, old_declaration)) <> 2
     OR cardinality(string_to_array(definition, old_strategies)) <> 2
     OR cardinality(string_to_array(definition, old_count)) <> 2 THEN
    RAISE EXCEPTION 'Unexpected ui_list_resource_v1 definition while bounding log totals';
  END IF;
  definition := replace(definition, old_declaration, 'v_total BIGINT;');
  definition := replace(definition, old_strategies,
    $sql$v_total_strategy NOT IN ('exact', 'estimate', 'exact_then_estimate')$sql$);
  EXECUTE replace(definition, old_count, new_count);
END;
$migration$;

DO $registry$
DECLARE
  current_registry record;
  next_value jsonb;
BEGIN
  SELECT s.scope_type, sv.value, sv.schema_version INTO STRICT current_registry
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
  WHERE s.category = 'ui_read_registry' AND s.scope_type = public.get_root_scope_type_key_v1()
    AND s.scope_id IS NULL
  FOR UPDATE OF s;

  SELECT jsonb_set(current_registry.value, '{resources}', jsonb_agg(
    CASE WHEN entry.value->>'key' IN ('decision_log', 'settings_resolution_log', 'webhook_inbox')
      THEN entry.value || '{"total_strategy":"exact_then_estimate"}'::jsonb
      ELSE entry.value END ORDER BY entry.ordinal
  )) INTO next_value
  FROM jsonb_array_elements(current_registry.value->'resources') WITH ORDINALITY AS entry(value, ordinal);

  IF next_value IS DISTINCT FROM current_registry.value THEN
    PERFORM public.upsert_settings_value_v1('ui_read_registry', current_registry.scope_type,
      NULL, next_value, current_registry.schema_version, 'Bound scoped log totals to the configured page size');
  END IF;
END;
$registry$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
COMMIT;

-- Generic UI reads and mutation returns share a registry-declared projection.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261026190000_ui_read_registry_projection_v1'));

-- One allowlist for read/write output and caller-supplied column access.
CREATE OR REPLACE FUNCTION public.ui_read_projection_columns_v1(
  p_resource JSONB,
  p_relation REGCLASS
)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $projection$
DECLARE
  v_columns TEXT[];
BEGIN
  IF jsonb_typeof(p_resource->'select') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ui_read_registry resource % requires a non-empty select array', p_resource->>'key';
  END IF;
  IF jsonb_array_length(p_resource->'select') = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_resource->'select') entry
                WHERE jsonb_typeof(entry) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'ui_read_registry resource % requires a non-empty select array of column names', p_resource->>'key';
  END IF;
  IF p_resource ? 'columns' AND jsonb_typeof(p_resource->'columns') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ui_read_registry resource % columns must be an array', p_resource->>'key';
  END IF;

  SELECT array_agg(a.attname::text ORDER BY a.attnum)
    INTO v_columns
    FROM pg_attribute a
   WHERE a.attrelid = p_relation
     AND a.attnum > 0 AND NOT a.attisdropped
     AND (a.attname::text IN (SELECT jsonb_array_elements_text(p_resource->'select'))
       OR a.attname::text IN (SELECT entry->>'key'
                             FROM jsonb_array_elements(COALESCE(p_resource->'columns', '[]'::jsonb)) entry)
       OR a.attname::text = COALESCE(p_resource->>'id_column', 'id'));

  IF NOT COALESCE(COALESCE(p_resource->>'id_column', 'id') = ANY(v_columns), FALSE) THEN
    RAISE EXCEPTION 'ui_read_registry resource % id_column not found in relation', p_resource->>'key';
  END IF;
  RETURN v_columns;
END;
$projection$;

REVOKE ALL ON FUNCTION public.ui_read_projection_columns_v1(JSONB, REGCLASS)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.ui_read_projection_columns_v1(JSONB, REGCLASS)
  IS 'Internal registry output allowlist intersected with live relation columns; missing select fails closed.';

-- Caller filters cannot infer hidden values through counts or aggregates.
CREATE OR REPLACE FUNCTION public.ui_read_caller_filter_sql_v1(
  p_filters JSONB,
  p_defs JSONB,
  p_projection_keys TEXT[]
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_key TEXT;
  v_defs JSONB;
BEGIN
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'object' THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE filter_nodes(node) AS (
    SELECT p_filters
    UNION ALL
    SELECT rule
      FROM filter_nodes
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(node->'rules') = 'array'
          THEN node->'rules' ELSE '[]'::jsonb END
      ) rule
  ), caller_keys(key) AS (
    SELECT node->>'key' FROM filter_nodes
     WHERE p_filters ? 'rules'
       AND jsonb_typeof(node) = 'object'
       AND jsonb_typeof(node->'rules') IS DISTINCT FROM 'array'
    UNION ALL
    SELECT btrim(key) FROM jsonb_object_keys(p_filters) key
     WHERE NOT (p_filters ? 'rules')
  )
  SELECT def->>'key' INTO v_key
    FROM jsonb_array_elements(COALESCE(p_defs, '[]'::jsonb)) def
    JOIN caller_keys requested ON requested.key = def->>'key'
   WHERE NOT COALESCE(def->>'column' = ANY(p_projection_keys), FALSE)
   LIMIT 1;

  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'ui_read_registry filter column not allowed: %', v_key;
  END IF;

  SELECT COALESCE(jsonb_agg(def ORDER BY ordinal), '[]'::jsonb) INTO v_defs
    FROM jsonb_array_elements(COALESCE(p_defs, '[]'::jsonb)) WITH ORDINALITY AS definitions(def, ordinal)
   WHERE def->>'column' = ANY(p_projection_keys);

  IF p_filters ? 'rules' THEN
    RETURN public.ui_filter_tree_sql_v1(p_filters, v_defs);
  END IF;
  RETURN public.ui_filter_flat_sql_v1(p_filters, v_defs, p_projection_keys);
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_read_caller_filter_sql_v1(JSONB, JSONB, TEXT[])
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.ui_read_caller_filter_sql_v1(JSONB, JSONB, TEXT[])
  IS 'Internal caller-only filter compiler; rejects hidden declared columns and preserves trusted base filters separately.';

CREATE OR REPLACE FUNCTION public.ui_get_resource_v1(
  p_resource TEXT,
  p_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_scope_column TEXT;
  v_capability TEXT;
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_where TEXT := 'TRUE';
  v_sql TEXT;
  v_item JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires id';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 relation not found: %', v_relation;
  END IF;

  IF v_scope_type IN ('tenant','client','sender') THEN
    v_scope_column := v_resource#>>ARRAY['scope_columns', v_scope_type];
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_where := v_where || format(' AND %I = %L', v_scope_column, v_scope_id);
    END IF;
  END IF;

  PERFORM public.ui_assert_read_relation_allowed_v1(
    'ui_get_resource_v1',
    v_relation,
    v_schema,
    v_table
  );

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  v_where := v_where || format(' AND %I = %L', v_id_column, p_id);

  v_sql := format(
    'SELECT row_to_json(t)::jsonb FROM (SELECT %s FROM %I.%I WHERE %s LIMIT 1) t',
    v_select_cols,
    v_schema,
    v_table,
    v_where
  );

  EXECUTE v_sql INTO v_item;
  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_list_resource_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_sort JSONB DEFAULT NULL::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
SET row_security TO 'on'
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_pagination JSONB := public.resolve_settings_merged('ui_pagination', v_scope_type, v_scope_id);
  v_max_page_size INT := 200;
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_scope_column TEXT;
  v_capability TEXT;
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_sort_key TEXT;
  v_sort_dir_input TEXT;
  v_where TEXT := 'TRUE';
  v_filter_sql TEXT;
  v_base_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_reloptions TEXT[];
  v_view_security_invoker BOOLEAN := FALSE;
  v_sql TEXT;
  v_items JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
  v_total_strategy TEXT := 'exact';
  v_total_is_estimate BOOLEAN := FALSE;
  v_estimate_filtered_totals BOOLEAN := TRUE;
  v_has_caller_filters BOOLEAN := FALSE;
  v_explain JSONB;
BEGIN
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  IF v_pagination IS NOT NULL THEN
    v_max_page_size := COALESCE((v_pagination->>'max_page_size')::int, v_max_page_size);
  END IF;
  v_max_page_size := LEAST(GREATEST(v_max_page_size, 1), 1000);

  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_list_resource_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_list_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';
  v_total_strategy := lower(COALESCE(NULLIF(v_resource->>'total_strategy', ''), v_total_strategy));
  IF v_total_strategy NOT IN ('exact', 'estimate') THEN
    v_total_strategy := 'exact';
  END IF;
  v_estimate_filtered_totals := CASE lower(COALESCE(v_resource->>'estimate_filtered_totals', 'true'))
    WHEN 'false' THEN FALSE
    WHEN '0' THEN FALSE
    WHEN 'no' THEN FALSE
    WHEN 'off' THEN FALSE
    ELSE TRUE
  END;
  v_has_caller_filters := COALESCE(jsonb_typeof(p_filters) = 'object' AND p_filters <> '{}'::jsonb, FALSE);

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 resource missing relation';
  END IF;
  v_sort_col := COALESCE(v_resource#>>ARRAY['default_sort', 'column'], v_id_column);
  v_sort_dir := COALESCE(NULLIF(lower(v_resource#>>ARRAY['default_sort', 'direction']), ''), 'desc');

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_list_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity, c.reloptions
    INTO v_relkind, v_rls_enabled, v_reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IN ('r', 'p') THEN
    IF v_rls_enabled IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ui_list_resource_v1 relation missing RLS: %', v_relation;
    END IF;
  ELSIF v_relkind = 'v' THEN
    v_view_security_invoker := COALESCE(v_reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true'];
    IF v_view_security_invoker IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ui_list_resource_v1 view missing security_invoker: %', v_relation;
    END IF;
  ELSE
    RAISE EXCEPTION 'ui_list_resource_v1 relation not allowed: %', v_relation;
  END IF;

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  IF v_scope_type IN ('tenant', 'client', 'sender') THEN
    v_scope_column := v_resource#>>ARRAY['scope_columns', v_scope_type];
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_where := v_where || format(' AND %I = %L', v_scope_column, v_scope_id);
    END IF;
  END IF;

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    IF v_base_filter_sql IS NOT NULL AND btrim(v_base_filter_sql) <> '' THEN
      v_where := v_where || ' AND ' || v_base_filter_sql;
    END IF;
  END IF;

  IF jsonb_typeof(p_sort) = 'object' THEN
    v_sort_key := NULLIF(p_sort->>'key', '');
    v_sort_dir_input := lower(NULLIF(p_sort->>'direction', ''));
    IF v_sort_key IS NOT NULL AND v_sort_key = ANY(v_projection_keys) THEN
      v_sort_col := v_sort_key;
      IF v_sort_dir_input IN ('asc', 'desc') THEN
        v_sort_dir := v_sort_dir_input;
      END IF;
    END IF;
  END IF;

  v_filter_sql := public.ui_read_caller_filter_sql_v1(
    p_filters,
    COALESCE(v_resource->'filters', '[]'::jsonb),
    v_projection_keys
  );
  IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
    v_where := v_where || ' AND ' || v_filter_sql;
  END IF;

  IF v_total_strategy = 'estimate'
     AND v_has_caller_filters
     AND v_estimate_filtered_totals IS DISTINCT FROM TRUE THEN
    v_total_strategy := 'exact';
  END IF;

  IF v_total_strategy = 'estimate' THEN
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
    v_sql := format(
      'SELECT COUNT(*) FROM %I.%I WHERE %s',
      v_schema,
      v_table,
      v_where
    );
    EXECUTE v_sql INTO v_total;
  END IF;

  v_sql := format(
    'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (SELECT %s FROM %I.%I WHERE %s ORDER BY %I %s LIMIT %s OFFSET %s) t',
    v_select_cols,
    v_schema,
    v_table,
    v_where,
    v_sort_col,
    CASE WHEN v_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END,
    LEAST(GREATEST(p_limit, 1), v_max_page_size),
    GREATEST(p_offset, 0)
  );

  EXECUTE v_sql INTO v_items;

  RETURN jsonb_build_object(
    'resource', p_resource,
    'keys', to_jsonb(v_projection_keys),
    'items', COALESCE(v_items, '[]'::jsonb),
    'limit', LEAST(GREATEST(p_limit, 1), v_max_page_size),
    'offset', GREATEST(p_offset, 0),
    'total', COALESCE(v_total, 0),
    'total_strategy', v_total_strategy,
    'total_is_estimate', v_total_is_estimate
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_get_resource_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_get_resource_v1(TEXT, UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INTEGER, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INTEGER, INTEGER, JSONB) TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.ui_resource_metrics_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_columns TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_scope_column TEXT;
  v_capability TEXT;
  v_select_keys TEXT[];
  v_projection_keys TEXT[];
  v_numeric_cols TEXT[];
  v_metrics_sql TEXT;
  v_metrics JSONB := '{}'::jsonb;
  v_total BIGINT := 0;
  v_where TEXT := 'TRUE';
  v_base_filter_sql TEXT;
  v_filter_key TEXT;
  v_filter_sql TEXT;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 requires resource key';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 relation not found: %', v_relation;
  END IF;

  PERFORM public.ui_assert_read_relation_allowed_v1(
    'ui_resource_metrics_v1',
    v_relation,
    v_schema,
    v_table
  );

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );

  IF jsonb_typeof(v_resource->'select') = 'array' THEN
    SELECT array_agg(value::text)
      INTO v_select_keys
      FROM jsonb_array_elements_text(v_resource->'select');
  END IF;
  IF v_select_keys IS NULL OR array_length(v_select_keys, 1) IS NULL THEN
    v_select_keys := ARRAY[v_id_column];
  END IF;

  IF p_columns IS NOT NULL AND array_length(p_columns, 1) IS NOT NULL THEN
    v_select_keys := ARRAY(
      SELECT key
        FROM unnest(v_select_keys) AS key
       WHERE key = ANY(p_columns)
    );
  END IF;

  SELECT array_agg(column_name::text)
    INTO v_numeric_cols
    FROM information_schema.columns
   WHERE table_schema = v_schema
     AND table_name = v_table
     AND column_name = ANY(v_select_keys)
     AND data_type IN (
       'smallint',
       'integer',
       'bigint',
       'numeric',
       'decimal',
       'real',
       'double precision'
     );

  IF v_scope_type IN ('tenant','client','sender') THEN
    v_scope_column := v_resource#>>ARRAY['scope_columns', v_scope_type];
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_where := v_where || format(' AND %I = %L', v_scope_column, v_scope_id);
    END IF;
  END IF;

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    IF v_base_filter_sql IS NOT NULL AND btrim(v_base_filter_sql) <> '' THEN
      v_where := v_where || ' AND ' || v_base_filter_sql;
    END IF;
  END IF;

  v_filter_sql := public.ui_read_caller_filter_sql_v1(
    p_filters,
    COALESCE(v_resource->'filters', '[]'::jsonb),
    v_projection_keys
  );
  IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
    v_where := v_where || ' AND ' || v_filter_sql;
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM %I.%I WHERE %s', v_schema, v_table, v_where)
    INTO v_total;

  IF v_numeric_cols IS NOT NULL AND array_length(v_numeric_cols, 1) IS NOT NULL THEN
    v_metrics_sql := 'SELECT jsonb_build_object(';
    FOR v_filter_key IN SELECT unnest(v_numeric_cols) LOOP
      v_metrics_sql := v_metrics_sql || format(
        '%L, jsonb_build_object(''count'', COUNT(%I), ''sum'', SUM(%I), ''avg'', AVG(%I), ''min'', MIN(%I), ''max'', MAX(%I)),',
        v_filter_key,
        v_filter_key,
        v_filter_key,
        v_filter_key,
        v_filter_key,
        v_filter_key
      );
    END LOOP;
    v_metrics_sql := trim(trailing ',' from v_metrics_sql) || format(') FROM %I.%I WHERE %s', v_schema, v_table, v_where);
    EXECUTE v_metrics_sql INTO v_metrics;
  END IF;

  RETURN jsonb_build_object(
    'resource', p_resource,
    'total', COALESCE(v_total, 0),
    'columns', COALESCE(v_metrics, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_filter_distinct_values_v1(
  p_resource TEXT,
  p_filter_key TEXT,
  p_query TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_capability TEXT;
  v_scope_column TEXT;
  v_filter JSONB;
  v_column TEXT;
  v_where TEXT := 'TRUE';
  v_query TEXT := NULLIF(btrim(p_query), '');
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_sql TEXT;
  v_values JSONB := '[]'::jsonb;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 requires resource key';
  END IF;
  IF p_filter_key IS NULL OR btrim(p_filter_key) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 requires filter key';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 resource missing relation';
  END IF;

  v_capability := v_resource->>'capability_read';
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 relation not found: %', v_relation;
  END IF;

  PERFORM public.ui_assert_read_relation_allowed_v1(
    'ui_filter_distinct_values_v1',
    v_relation,
    v_schema,
    v_table
  );

  IF v_scope_type IN ('tenant','client','sender') THEN
    v_scope_column := v_resource#>>ARRAY['scope_columns', v_scope_type];
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_where := v_where || format(' AND %I = %L', v_scope_column, v_scope_id);
    END IF;
  END IF;

  SELECT value INTO v_filter
    FROM jsonb_array_elements(COALESCE(v_resource->'filters', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_filter_key
   LIMIT 1;

  IF v_filter IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 unknown filter %', p_filter_key;
  END IF;

  v_column := NULLIF(v_filter->>'column', '');
  IF v_column IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 filter missing column: %', p_filter_key;
  END IF;

  IF NOT COALESCE(v_column = ANY(public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  )), FALSE) THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 filter column not allowed: %', p_filter_key;
  END IF;

  IF v_query IS NOT NULL THEN
    v_where := v_where || format(' AND %I::text ILIKE %L', v_column, '%' || v_query || '%');
  END IF;

  v_sql := format(
    'SELECT COALESCE(jsonb_agg(value), ''[]''::jsonb) FROM (' ||
    'SELECT %1$I::text AS value FROM %2$I.%3$I ' ||
    'WHERE %4$s AND %1$I IS NOT NULL AND NULLIF(btrim(%1$I::text), '''') IS NOT NULL ' ||
    'GROUP BY 1 ' ||
    'ORDER BY count(*) DESC, value ASC ' ||
    'LIMIT %5$s' ||
    ') t',
    v_column,
    v_schema,
    v_table,
    v_where,
    v_limit
  );

  EXECUTE v_sql INTO v_values;
  RETURN v_values;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_update_resource_v1(
  p_resource TEXT,
  p_id TEXT,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_id_type TEXT;
  v_capability TEXT;
  v_columns JSONB;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_edit_mode TEXT;
  v_edit_permission TEXT;
  v_col_def JSONB;
  v_patch_cols TEXT[] := ARRAY[]::TEXT[];
  v_col TEXT;
  v_col_type TEXT;
  v_set_parts TEXT[] := ARRAY[]::TEXT[];
  v_cols_def TEXT[] := ARRAY[]::TEXT[];
  v_cols_list TEXT[] := ARRAY[]::TEXT[];
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_sql TEXT;
  v_result JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires id';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires patch object';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  v_columns := v_resource->'columns';
  IF jsonb_typeof(v_columns) <> 'array' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 resource missing column metadata';
  END IF;

  FOR v_col IN SELECT key FROM jsonb_each(p_patch) LOOP
    IF v_col = v_id_column THEN
      RAISE EXCEPTION 'ui_update_resource_v1 cannot update id column';
    END IF;

    SELECT value INTO v_col_def
      FROM jsonb_array_elements(v_columns) AS value
     WHERE value->>'key' = v_col
     LIMIT 1;

    IF v_col_def IS NULL THEN
      RAISE EXCEPTION 'ui_update_resource_v1 unknown column %', v_col;
    END IF;

    v_edit_mode := lower(COALESCE(NULLIF(v_col_def->>'edit_mode', ''), 'none'));
    IF v_edit_mode NOT IN ('inline','modal','form') THEN
      RAISE EXCEPTION 'ui_update_resource_v1 column not editable: %', v_col;
    END IF;

    v_edit_permission := NULLIF(v_col_def->>'edit_permission', '');
    IF v_edit_permission IS NOT NULL THEN
      PERFORM public.assert_capability_v1(v_edit_permission, v_scope_type, v_scope_id);
    END IF;

    v_patch_cols := array_append(v_patch_cols, v_col);
  END LOOP;

  IF array_length(v_patch_cols, 1) IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires editable patch columns';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 id column not found: %', v_id_column;
  END IF;

  FOR v_col IN SELECT unnest(v_patch_cols) LOOP
    SELECT format_type(a.atttypid, a.atttypmod)
      INTO v_col_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = v_schema
       AND c.relname = v_table
       AND a.attname = v_col
       AND a.attnum > 0
       AND a.attisdropped = false
     LIMIT 1;

    IF v_col_type IS NULL THEN
      RAISE EXCEPTION 'ui_update_resource_v1 column not found: %', v_col;
    END IF;

    v_cols_def := array_append(v_cols_def, format('%I %s', v_col, v_col_type));
    v_cols_list := array_append(v_cols_list, format('%I', v_col));
    v_set_parts := array_append(v_set_parts, format('%I = patch.%I', v_col, v_col));
  END LOOP;

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('t.%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  v_sql := format(
    'WITH patch AS (SELECT %s FROM jsonb_to_record($1) AS x(%s)) UPDATE %I.%I AS t SET %s FROM patch WHERE t.%I = $2::%s RETURNING (SELECT to_jsonb(projected) FROM (SELECT %s) projected)',
    array_to_string(v_cols_list, ', '),
    array_to_string(v_cols_def, ', '),
    v_schema,
    v_table,
    array_to_string(v_set_parts, ', '),
    v_id_column,
    v_id_type,
    v_select_cols
  );

  EXECUTE v_sql INTO v_result USING p_patch, p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_delete_resource_v1(
  p_resource TEXT,
  p_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_id_type TEXT;
  v_capability TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_sql TEXT;
  v_result JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires id';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 id column not found: %', v_id_column;
  END IF;

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('t.%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  v_sql := format(
    'DELETE FROM %I.%I AS t WHERE t.%I = $1::%s RETURNING (SELECT to_jsonb(projected) FROM (SELECT %s) projected)',
    v_schema,
    v_table,
    v_id_column,
    v_id_type,
    v_select_cols
  );

  EXECUTE v_sql INTO v_result USING p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ui_update_resource_v1(TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_update_resource_v1(TEXT, TEXT, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ui_delete_resource_v1(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_delete_resource_v1(TEXT, TEXT) TO authenticated, service_role;

-- Import workers call this definer helper; direct browser execution bypasses governed imports.
REVOKE ALL ON FUNCTION public.tabular_import_write_row_v1(TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tabular_import_write_row_v1(TEXT, TEXT, JSONB, TEXT) TO service_role;

-- Existing select-all registries need explicit safe metadata before reads fail closed.
-- Preserve scoped overrides, resource order, relation routing and version history.
DO $registry$
DECLARE
  v_row RECORD;
  v_next JSONB;
  v_resource JSONB;
  v_original JSONB;
  v_resources JSONB;
  v_projection TEXT[];
  v_filter JSONB;
  v_filters JSONB;
  v_column TEXT;
  v_sort_column TEXT;
  v_relation REGCLASS;
  v_sensitive_pattern CONSTANT TEXT := '(secret|token|credential|password|vault|key|hash|ip|email|phone|payload|headers|body|metadata)|(^|[^a-z0-9])(otp|pin|auth|session|cookie|jwt|signature|private|iban|card|national|iqama|address|mobile|raw|salt|nonce|dsn)([^a-z0-9]|$)';
  v_base_before TEXT;
  v_additions CONSTANT JSONB := '{
    "shipments": ["id","tracking_number","status","created_at","client_id","sender_id","organization_id"],
    "schema_registry": ["id","category","version","schema","description","examples","is_active","created_at","deprecated_at"],
    "operation_handlers": ["handler_key","handler_schema","handler_name","handler_signature","handler_version","is_active","created_by","created_at","updated_at","notes","doc_url","ui_label","ui_category","ui_description","config_schema_category"],
    "workflow_template_steps": ["id","workflow_template_id","sequence_order","operation_name","operation_settings_category","transition_condition","condition_jsonlogic","next_operation_name","next_operation_priority","next_operation_delay_seconds","manual_action_required","metadata","enabled","created_at","updated_at","handler_key","handler_version"],
    "workflow_templates": ["description","steps_checksum","updated_at"],
    "webhook_source_directory": ["id","organization_id","source_identifier","name","provider_type","mapping_config_id","rate_limit_per_hour","enabled","created_at","updated_at","mapping_label","last_event_at","last_event_status","event_count_24h","error_count_24h","is_healthy","has_recent_errors","auth_token_masked","sender_id","client_id","sender_label","client_label","hmac_enabled","hmac_header","hmac_algorithm","hmac_signature_encoding","lifecycle_state","archived_at","archived_by","archive_reason"],
    "api_gateway_auth_rejections": ["id","service","surface","credential_kind","failure_code","http_status","organization_id","source_id","webhook_source_id","source_label","source_identifier","provider_type","client_id","client_label","sender_id","sender_label","correlation_id","request_id","method","path","retired_reason","provider_credential_state","occurred_at","created_at","source_resolved","rejection_class"],
    "webhook_auth_rejections": ["id","service","surface","credential_kind","failure_code","http_status","organization_id","source_id","webhook_source_id","source_label","source_identifier","provider_type","client_id","client_label","sender_id","sender_label","correlation_id","request_id","method","path","retired_reason","provider_credential_state","occurred_at","created_at","source_resolved","rejection_class"],
    "webhook_sources": ["id","organization_id","source_identifier","name","provider_type","mapping_config_id","rate_limit_per_hour","enabled","created_at","updated_at","mapping_label","last_event_at","last_event_status","event_count_24h","error_count_24h","is_healthy","has_recent_errors","auth_token_masked","sender_id","client_id","sender_label","client_label","hmac_enabled","hmac_header","hmac_algorithm","hmac_signature_encoding","lifecycle_state","archived_at","archived_by","archive_reason"],
    "workflow_run_triggers": ["id","organization_id","scope_type","scope_id","source_workflow_template_id","target_workflow_template_id","source_statuses","enabled","last_scanned_completed_at","created_by","created_at","updated_at","notes"],
    "workflow_schedule_triggers": ["id","organization_id","scope_type","scope_id","workflow_template_id","schedule","enabled","next_run_at","last_run_at","last_run_id","last_error","last_error_at","created_by","created_at","updated_at","notes"],
    "workflow_trigger_fires": ["id","organization_id","workflow_run_trigger_id","source_workflow_run_id","target_workflow_run_id","fire_status","claimed_at","claimed_by","attempts","last_error","created_at","updated_at"],
    "workflow_run_steps": ["workflow_template_step_id","retry_attempt","max_retries","fallback_invoked","decision_log_id","created_at","updated_at","run_at","handler_version"],
    "workflow_runs": ["max_retries"]
  }'::jsonb;
BEGIN
  FOR v_row IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry'
    ORDER BY s.id
    FOR UPDATE OF s, sv
  LOOP
    IF jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry resources must be an array';
    END IF;
    v_resources := '[]'::jsonb;
    FOR v_original IN SELECT value FROM jsonb_array_elements(v_row.value->'resources') LOOP
      v_resource := v_original;
      -- Restore the previously reviewed display contracts before classifying live metadata.
      IF v_additions ? (v_resource->>'key') THEN
        SELECT jsonb_set(v_resource, '{select}', jsonb_agg(to_jsonb(column_name) ORDER BY first_ordinal))
          INTO v_resource
          FROM (
            SELECT column_name, min(ordinal) AS first_ordinal
              FROM jsonb_array_elements_text(
                COALESCE(v_resource->'select', '[]'::jsonb) || (v_additions->(v_resource->>'key'))
              ) WITH ORDINALITY AS columns(column_name, ordinal)
             GROUP BY column_name
          ) deduplicated;
      END IF;
      v_relation := to_regclass(COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation'));
      v_projection := public.ui_read_projection_columns_v1(v_resource, v_relation);
      IF jsonb_typeof(v_resource->'filters') = 'array' THEN
        v_filters := '[]'::jsonb;
        FOR v_filter IN SELECT value FROM jsonb_array_elements(v_resource->'filters') LOOP
          v_column := v_filter->>'column';
          IF NOT COALESCE(v_column = ANY(v_projection), FALSE) THEN
            IF v_column IS NULL OR v_column ~* v_sensitive_pattern OR NOT EXISTS (
              SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_relation
                AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = v_column
            ) THEN
              RAISE NOTICE 'ui_read_registry projection scope=%/% resource=% filter=% column=% action=drop_unprojected_filter',
                v_row.scope_type, v_row.scope_id, v_resource->>'key', v_filter->>'key', v_column;
              CONTINUE;
            END IF;
            v_resource := jsonb_set(v_resource, '{select}', v_resource->'select' || jsonb_build_array(v_column));
            v_projection := array_append(v_projection, v_column);
            RAISE NOTICE 'ui_read_registry projection scope=%/% resource=% filter=% column=% action=append_safe_select',
              v_row.scope_type, v_row.scope_id, v_resource->>'key', v_filter->>'key', v_column;
          END IF;
          v_filters := v_filters || jsonb_build_array(v_filter);
        END LOOP;
        v_resource := jsonb_set(v_resource, '{filters}', v_filters);
      END IF;
      v_sort_column := v_resource#>>'{default_sort,column}';
      IF v_sort_column IS NOT NULL AND NOT (v_sort_column = ANY(v_projection)) THEN
        IF v_sort_column ~* v_sensitive_pattern OR NOT EXISTS (
          SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_relation
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = v_sort_column
        ) THEN
          v_resource := v_resource - 'default_sort';
          RAISE NOTICE 'ui_read_registry projection scope=%/% resource=% sort=% action=drop_unprojected_sort',
            v_row.scope_type, v_row.scope_id, v_resource->>'key', v_sort_column;
        ELSE
          v_resource := jsonb_set(v_resource, '{select}', v_resource->'select' || jsonb_build_array(v_sort_column));
          RAISE NOTICE 'ui_read_registry projection scope=%/% resource=% sort=% action=append_safe_select',
            v_row.scope_type, v_row.scope_id, v_resource->>'key', v_sort_column;
        END IF;
      END IF;
      IF jsonb_typeof(v_original->'base_filter') = 'object' THEN
        v_base_before := public.ui_filter_tree_sql_v1(v_original->'base_filter', COALESCE(v_original->'filters','[]'::jsonb));
        IF v_base_before IS DISTINCT FROM public.ui_filter_tree_sql_v1(
             v_resource->'base_filter', COALESCE(v_resource->'filters','[]'::jsonb)) THEN
          RAISE EXCEPTION 'ui_read_registry resource % base filter requires explicit review', v_resource->>'key';
        END IF;
      END IF;
      v_resources := v_resources || jsonb_build_array(v_resource);
    END LOOP;
    v_next := jsonb_set(v_row.value, '{resources}', v_resources);

    IF v_next IS DISTINCT FROM v_row.value THEN
      PERFORM 1 FROM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id, v_next, v_row.schema_version,
        'Reconcile live UI projections and remove sensitive or invalid caller filters');
    END IF;
  END LOOP;
END;
$registry$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';

COMMIT;

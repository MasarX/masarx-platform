-- Distinct suggestions must use the same registry row predicate as list and metrics.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261027010000_ui_filter_distinct_base_filter_v1'));

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
  v_base_filter_sql TEXT;
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

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    IF v_base_filter_sql IS NOT NULL AND btrim(v_base_filter_sql) <> '' THEN
      v_where := v_where || ' AND ' || v_base_filter_sql;
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

REVOKE ALL ON FUNCTION public.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) TO authenticated, service_role;

COMMIT;

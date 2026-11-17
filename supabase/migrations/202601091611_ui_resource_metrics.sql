SELECT pg_advisory_lock(hashtext('202601091611_ui_resource_metrics'));

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
  v_numeric_cols TEXT[];
  v_metrics_sql TEXT;
  v_metrics JSONB := '{}'::jsonb;
  v_total BIGINT := 0;
  v_where TEXT := 'TRUE';
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_filter JSONB;
  v_filter_key TEXT;
  v_filter_column TEXT;
  v_filter_op TEXT;
  v_filter_value TEXT;
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

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 relation missing RLS: %', v_relation;
  END IF;

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

  IF jsonb_typeof(v_resource->'filters') = 'array'
     AND jsonb_typeof(p_filters) = 'object' THEN
    IF p_filters ? 'rules' THEN
      v_filter_sql := public.ui_filter_tree_sql_v1(p_filters, v_resource->'filters');
      IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
        v_where := v_where || ' AND ' || v_filter_sql;
      END IF;
    ELSE
      FOR v_filter IN SELECT jsonb_array_elements(v_resource->'filters') LOOP
        v_filter_key := NULLIF(v_filter->>'key', '');
        v_filter_column := NULLIF(v_filter->>'column', '');
        IF v_filter_key IS NULL OR v_filter_column IS NULL THEN
          CONTINUE;
        END IF;
        v_filter_value := NULLIF(p_filters->>v_filter_key, '');
        IF v_filter_value IS NULL THEN
          CONTINUE;
        END IF;
        v_filter_op := lower(COALESCE(NULLIF(v_filter->>'op', ''), 'eq'));
        CASE v_filter_op
          WHEN 'eq' THEN v_filter_sql := format('%I = %L', v_filter_column, v_filter_value);
          WHEN 'ne' THEN v_filter_sql := format('%I <> %L', v_filter_column, v_filter_value);
          WHEN 'gt' THEN v_filter_sql := format('%I > %L', v_filter_column, v_filter_value);
          WHEN 'gte' THEN v_filter_sql := format('%I >= %L', v_filter_column, v_filter_value);
          WHEN 'lt' THEN v_filter_sql := format('%I < %L', v_filter_column, v_filter_value);
          WHEN 'lte' THEN v_filter_sql := format('%I <= %L', v_filter_column, v_filter_value);
          WHEN 'ilike' THEN v_filter_sql := format('%I ILIKE %L', v_filter_column, v_filter_value);
          ELSE
            RAISE EXCEPTION 'ui_resource_metrics_v1 unsupported filter op %', v_filter_op;
        END CASE;
        v_where := v_where || ' AND ' || v_filter_sql;
      END LOOP;
    END IF;
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

SELECT pg_advisory_unlock(hashtext('202601091611_ui_resource_metrics'));

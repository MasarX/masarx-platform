-- Migration: ui_list_resource_v1 always selects all columns and returns keys
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191500_ui_list_resource_all_columns_keys'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_list_resource_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_sort JSONB DEFAULT NULL
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
  v_pagination JSONB := public.resolve_settings_merged('ui_pagination', v_scope_type, v_scope_id);
  v_max_page_size INT := 200;
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_scope_column TEXT;
  v_capability TEXT;
  v_select_cols TEXT := '*';
  v_select_keys TEXT[];
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_sort_key TEXT;
  v_sort_dir_input TEXT;
  v_where TEXT := 'TRUE';
  v_filter JSONB;
  v_filter_key TEXT;
  v_filter_column TEXT;
  v_filter_op TEXT;
  v_filter_value TEXT;
  v_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_items JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
BEGIN
  IF v_pagination IS NOT NULL THEN
    v_max_page_size := COALESCE((v_pagination->>'max_page_size')::int, v_max_page_size);
  END IF;
  v_max_page_size := LEAST(GREATEST(v_max_page_size, 1), 1000);

  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_list_resource_v1 requires resource key';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_list_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 resource missing relation';
  END IF;
  v_sort_col := COALESCE(v_resource#>>ARRAY['default_sort','column'], v_id_column);
  v_sort_dir := COALESCE(NULLIF(lower(v_resource#>>ARRAY['default_sort','direction']), ''), 'desc');

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_list_resource_v1 resource missing relation';
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

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_list_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_list_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  SELECT array_agg(cols.column_name::text ORDER BY cols.ordinal_position)
    INTO v_select_keys
    FROM information_schema.columns cols
   WHERE cols.table_schema = v_schema
     AND cols.table_name = v_table;
  IF v_select_keys IS NULL OR array_length(v_select_keys, 1) IS NULL THEN
    v_select_keys := ARRAY[v_id_column];
  END IF;

  IF v_scope_type IN ('tenant','client','sender') THEN
    v_scope_column := v_resource#>>ARRAY['scope_columns', v_scope_type];
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_where := v_where || format(' AND %I = %L', v_scope_column, v_scope_id);
    END IF;
  END IF;

  IF jsonb_typeof(p_sort) = 'object' THEN
    v_sort_key := NULLIF(p_sort->>'key', '');
    v_sort_dir_input := lower(NULLIF(p_sort->>'direction', ''));
    IF v_sort_key IS NOT NULL AND v_sort_key = ANY(v_select_keys) THEN
      v_sort_col := v_sort_key;
      IF v_sort_dir_input IN ('asc', 'desc') THEN
        v_sort_dir := v_sort_dir_input;
      END IF;
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
            RAISE EXCEPTION 'ui_list_resource_v1 unsupported filter op %', v_filter_op;
        END CASE;
        v_where := v_where || ' AND ' || v_filter_sql;
      END LOOP;
    END IF;
  END IF;

  v_sql := format(
    'SELECT COUNT(*) FROM %I.%I WHERE %s',
    v_schema,
    v_table,
    v_where
  );
  EXECUTE v_sql INTO v_total;

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
    'keys', to_jsonb(v_select_keys),
    'items', COALESCE(v_items, '[]'::jsonb),
    'limit', LEAST(GREATEST(p_limit, 1), v_max_page_size),
    'offset', GREATEST(p_offset, 0),
    'total', COALESCE(v_total, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INT, INT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INT, INT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601191500_ui_list_resource_all_columns_keys'));
COMMIT;


-- Plan: B09 Exception, reattempt & returns loop
-- Migration: UC114 NDR UI contract v1
-- Date: 2026-04-03
--
-- Purpose:
--   - Finish the Portal/Console NDR ownership surface using task-backed alias resources.
--   - Add fixed base-filter support to the canonical UI read RPCs so alias queues stay row-driven.
--   - Expose a safe claim command RPC through the api schema for browser/server clients pinned to db.schema=api.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604032230_uc114_ndr_ui_contract_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_filter_tree_sql_v1(
  p_filter JSONB,
  p_defs JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_rules JSONB;
  v_group_op TEXT := lower(COALESCE(NULLIF(p_filter->>'op', ''), 'and'));
  v_parts TEXT[] := ARRAY[]::TEXT[];
  v_rule JSONB;
  v_sql TEXT;
  v_key TEXT;
  v_def JSONB;
  v_column TEXT;
  v_op_def TEXT;
  v_value JSONB;
  v_value_text TEXT;
  v_values TEXT[];
  v_value_sql TEXT;
BEGIN
  IF p_filter IS NULL OR jsonb_typeof(p_filter) <> 'object' THEN
    RETURN NULL;
  END IF;

  v_rules := p_filter->'rules';
  IF jsonb_typeof(v_rules) = 'array' THEN
    FOR v_rule IN SELECT jsonb_array_elements(v_rules) LOOP
      v_sql := public.ui_filter_tree_sql_v1(v_rule, p_defs);
      IF v_sql IS NOT NULL AND btrim(v_sql) <> '' THEN
        v_parts := array_append(v_parts, v_sql);
      END IF;
    END LOOP;

    IF array_length(v_parts, 1) IS NULL THEN
      RETURN NULL;
    END IF;

    IF v_group_op NOT IN ('and', 'or') THEN
      v_group_op := 'and';
    END IF;

    RETURN '(' || array_to_string(v_parts, ' ' || upper(v_group_op) || ' ') || ')';
  END IF;

  v_key := NULLIF(p_filter->>'key', '');
  IF v_key IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT value
    INTO v_def
    FROM jsonb_array_elements(COALESCE(p_defs, '[]'::jsonb)) AS value
   WHERE value->>'key' = v_key
   LIMIT 1;

  IF v_def IS NULL THEN
    RETURN NULL;
  END IF;

  v_column := NULLIF(v_def->>'column', '');
  IF v_column IS NULL THEN
    RETURN NULL;
  END IF;

  v_op_def := lower(COALESCE(NULLIF(p_filter->>'op', ''), NULLIF(v_def->>'op', ''), 'eq'));

  IF v_op_def = 'is_null' THEN
    RETURN format('%I IS NULL', v_column);
  END IF;

  IF v_op_def = 'not_null' THEN
    RETURN format('%I IS NOT NULL', v_column);
  END IF;

  v_value := p_filter->'value';
  IF v_value IS NULL OR v_value = 'null'::jsonb THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_value) = 'array' THEN
    SELECT array_agg(quote_literal(value))
      INTO v_values
      FROM jsonb_array_elements_text(v_value);

    IF v_values IS NULL OR array_length(v_values, 1) IS NULL THEN
      RETURN NULL;
    END IF;

    CASE v_op_def
      WHEN 'eq' THEN
        RETURN format('%I IN (%s)', v_column, array_to_string(v_values, ', '));
      WHEN 'ne' THEN
        RETURN format('%I NOT IN (%s)', v_column, array_to_string(v_values, ', '));
      WHEN 'ilike' THEN
        RETURN format('%I ILIKE ANY (ARRAY[%s])', v_column, array_to_string(v_values, ', '));
      ELSE
        RAISE EXCEPTION 'ui_filter_tree_sql_v1 unsupported filter op %', v_op_def;
    END CASE;
  END IF;

  v_value_text := NULLIF(p_filter->>'value', '');
  IF v_value_text IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_value_text = '$current_user' THEN
    v_value_sql := 'auth.uid()';
  ELSIF v_value_text = '$now' THEN
    v_value_sql := 'statement_timestamp()';
  ELSE
    v_value_sql := format('%L', v_value_text);
  END IF;

  CASE v_op_def
    WHEN 'eq' THEN RETURN format('%I = %s', v_column, v_value_sql);
    WHEN 'ne' THEN RETURN format('%I <> %s', v_column, v_value_sql);
    WHEN 'gt' THEN RETURN format('%I > %s', v_column, v_value_sql);
    WHEN 'gte' THEN RETURN format('%I >= %s', v_column, v_value_sql);
    WHEN 'lt' THEN RETURN format('%I < %s', v_column, v_value_sql);
    WHEN 'lte' THEN RETURN format('%I <= %s', v_column, v_value_sql);
    WHEN 'ilike' THEN RETURN format('%I ILIKE %s', v_column, v_value_sql);
    ELSE
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 unsupported filter op %', v_op_def;
  END CASE;
END;
$$;

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
  v_filter_keys TEXT[] := ARRAY[]::text[];
  v_filter JSONB;
  v_filter_key TEXT;
  v_filter_column TEXT;
  v_filter_op TEXT;
  v_filter_value TEXT;
  v_filter_sql TEXT;
  v_base_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_items JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
  v_total_strategy TEXT := 'exact';
  v_total_is_estimate BOOLEAN := FALSE;
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

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r', 'p') THEN
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
    IF v_sort_key IS NOT NULL AND v_sort_key = ANY(v_select_keys) THEN
      v_sort_col := v_sort_key;
      IF v_sort_dir_input IN ('asc', 'desc') THEN
        v_sort_dir := v_sort_dir_input;
      END IF;
    END IF;
  END IF;

  IF jsonb_typeof(p_filters) = 'object' THEN
    IF p_filters ? 'rules' THEN
      IF jsonb_typeof(v_resource->'filters') = 'array' THEN
        v_filter_sql := public.ui_filter_tree_sql_v1(p_filters, v_resource->'filters');
        IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
          v_where := v_where || ' AND ' || v_filter_sql;
        END IF;
      END IF;
    ELSE
      IF jsonb_typeof(v_resource->'filters') = 'array' THEN
        SELECT array_agg(NULLIF(value->>'key', ''))
          INTO v_filter_keys
          FROM jsonb_array_elements(v_resource->'filters') AS value
         WHERE NULLIF(value->>'key', '') IS NOT NULL;
        v_filter_keys := COALESCE(v_filter_keys, ARRAY[]::text[]);

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

      FOR v_filter_key, v_filter_value IN
        SELECT key, value FROM jsonb_each_text(p_filters)
      LOOP
        v_filter_key := NULLIF(btrim(v_filter_key), '');
        IF v_filter_key IS NULL THEN
          CONTINUE;
        END IF;
        IF v_filter_key = ANY(v_filter_keys) THEN
          CONTINUE;
        END IF;
        v_filter_value := NULLIF(btrim(v_filter_value), '');
        IF v_filter_value IS NULL THEN
          CONTINUE;
        END IF;
        IF v_filter_key = ANY(v_select_keys) THEN
          v_where := v_where || format(' AND %I = %L', v_filter_key, v_filter_value);
        END IF;
      END LOOP;
    END IF;
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
    'keys', to_jsonb(v_select_keys),
    'items', COALESCE(v_items, '[]'::jsonb),
    'limit', LEAST(GREATEST(p_limit, 1), v_max_page_size),
    'offset', GREATEST(p_offset, 0),
    'total', COALESCE(v_total, 0),
    'total_strategy', v_total_strategy,
    'total_is_estimate', v_total_is_estimate
  );
END;
$$;

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
  v_select_cols TEXT := '*';
  v_where TEXT := 'TRUE';
  v_base_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_item JSONB;
BEGIN
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires id';
  END IF;

  SELECT value
    INTO v_resource
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

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'ui_get_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_get_resource_v1 relation missing RLS: %', v_relation;
  END IF;

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
  v_base_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_filter JSONB;
  v_filter_key TEXT;
  v_filter_column TEXT;
  v_filter_op TEXT;
  v_filter_value TEXT;
  v_filter_sql TEXT;
BEGIN
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_resource
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

  IF v_relkind IS NULL OR v_relkind NOT IN ('r', 'p') THEN
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
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_values JSONB := '[]'::jsonb;
BEGIN
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 requires resource key';
  END IF;
  IF p_filter_key IS NULL OR btrim(p_filter_key) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 requires filter key';
  END IF;

  SELECT value
    INTO v_resource
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

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 relation missing RLS: %', v_relation;
  END IF;

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

  SELECT value
    INTO v_filter
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

CREATE OR REPLACE FUNCTION public.ui_execute_task_claim_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
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
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB;
  v_capability TEXT;
  v_selection JSONB;
  v_mode TEXT;
  v_min INT;
  v_max INT;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_count INT := 0;
  v_user_id UUID := auth.uid();
  v_notes TEXT := NULLIF(btrim(COALESCE(p_params->>'notes', '')), '');
  v_result JSONB := '[]'::jsonb;
  v_selection_id_text TEXT;
  v_selection_uuid UUID;
  v_task public.tasks%ROWTYPE;
  v_visible_task JSONB;
  v_event RECORD;
  v_item JSONB;
  v_claimed_count INT := 0;
  v_already_assigned_count INT := 0;
  v_conflict_count INT := 0;
  v_status TEXT := 'noop';
BEGIN
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_task_claim_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_task_claim_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_task_claim_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_task_claim_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_task_claim_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_task_claim_v1 selection above maximum %', v_max;
  END IF;

  FOREACH v_selection_id_text IN ARRAY v_ids LOOP
    BEGIN
      v_selection_uuid := NULLIF(btrim(v_selection_id_text), '')::uuid;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_task_claim_v1 invalid task id %', v_selection_id_text;
    END;

    IF v_selection_uuid IS NULL THEN
      CONTINUE;
    END IF;

    v_visible_task := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
    IF v_visible_task IS NULL THEN
      RAISE EXCEPTION 'ui_execute_task_claim_v1 task % is not visible in resource %', v_selection_uuid, p_resource_key
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_task
      FROM public.tasks t
     WHERE t.id = v_selection_uuid
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_execute_task_claim_v1 task not found %', v_selection_uuid;
    END IF;

    IF v_task.assigned_to IS NULL THEN
      SELECT *
        INTO v_event
        FROM public.assign_task_v1(
          v_task.id,
          v_user_id,
          format(
            'ui-task-claim:%s:%s:%s:%s',
            lower(p_action_key),
            lower(p_resource_key),
            v_task.id,
            v_user_id
          ),
          COALESCE(v_notes, format('Claimed from %s queue', p_resource_key))
        );

      v_item := jsonb_build_object(
        'task_id', v_event.task_id,
        'task_event_id', v_event.task_event_id,
        'status', 'claimed'
      );
      v_claimed_count := v_claimed_count + 1;
    ELSIF v_task.assigned_to = v_user_id THEN
      v_item := jsonb_build_object(
        'task_id', v_task.id,
        'task_event_id', NULL,
        'status', 'already_assigned'
      );
      v_already_assigned_count := v_already_assigned_count + 1;
    ELSE
      v_item := jsonb_build_object(
        'task_id', v_task.id,
        'task_event_id', NULL,
        'status', 'conflict',
        'assigned_to', v_task.assigned_to
      );
      v_conflict_count := v_conflict_count + 1;
    END IF;

    v_result := v_result || jsonb_build_array(v_item);
  END LOOP;

  IF v_claimed_count > 0 AND v_conflict_count = 0 THEN
    v_status := 'task_claimed';
  ELSIF v_claimed_count > 0 AND v_conflict_count > 0 THEN
    v_status := 'task_claimed_partial';
  ELSIF v_already_assigned_count > 0 AND v_conflict_count = 0 THEN
    v_status := 'already_assigned';
  ELSIF v_conflict_count > 0 THEN
    v_status := 'claim_conflict';
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'resource', p_resource_key,
    'claimed_count', v_claimed_count,
    'already_assigned_count', v_already_assigned_count,
    'conflict_count', v_conflict_count,
    'results', v_result
  );
END;
$$;

COMMENT ON FUNCTION public.ui_execute_task_claim_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Claim visible task-backed queue items for the current authenticated user via assign_task_v1 without widening ui_execute_command_v1.';

CREATE OR REPLACE FUNCTION api.ui_execute_task_claim_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_execute_task_claim_v1($1, $2, $3, $4, $5, $6);
$$;

REVOKE ALL ON FUNCTION api.ui_execute_task_claim_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_task_claim_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_task_claim_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

DO $do$
DECLARE
  v_global JSONB := NULL;
  v_tasks_resource JSONB := NULL;
  v_tasks_resource_patch JSONB := jsonb_build_object(
    'select', jsonb_build_array(
      'id',
      'status',
      'status_reason',
      'priority',
      'queue_key',
      'assigned_to',
      'assigned_at',
      'sla_minutes',
      'sla_due_at',
      'sla_breached_at',
      'task_type_key',
      'resource_type',
      'resource_id',
      'client_id',
      'sender_id',
      'organization_id',
      'metadata',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'queue_key', 'column', 'queue_key', 'op', 'eq'),
      jsonb_build_object('key', 'assigned_to', 'column', 'assigned_to', 'op', 'eq'),
      jsonb_build_object('key', 'resource_type', 'column', 'resource_type', 'op', 'eq'),
      jsonb_build_object('key', 'resource_id', 'column', 'resource_id', 'op', 'eq'),
      jsonb_build_object('key', 'task_type_key', 'column', 'task_type_key', 'op', 'eq'),
      jsonb_build_object('key', 'sla_due_at', 'column', 'sla_due_at', 'op', 'gte'),
      jsonb_build_object('key', 'sla_breached_at', 'column', 'sla_breached_at', 'op', 'gte'),
      jsonb_build_object('key', 'completed_at', 'column', 'completed_at', 'op', 'gte'),
      jsonb_build_object('key', 'canceled_at', 'column', 'canceled_at', 'op', 'gte')
    ),
    'column_labels', jsonb_build_object(
      'queue_key', 'Queue',
      'assigned_to', 'Owner',
      'assigned_at', 'Owner claimed at',
      'sla_minutes', 'Resolution SLA (minutes)',
      'sla_due_at', 'Resolution SLA due at',
      'sla_breached_at', 'Resolution SLA breached at',
      'task_type_key', 'Task type'
    )
  );
  v_canonical_resources JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_next_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_resource_key TEXT := NULL;
  v_target_key TEXT := NULL;
  v_next JSONB := NULL;
BEGIN
  SELECT sv.value
    INTO v_global
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_global IS NULL OR jsonb_typeof(v_global) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'uc114_ndr_ui_contract_v1: ui_read_registry global settings missing';
  END IF;

  SELECT item
    INTO v_tasks_resource
    FROM jsonb_array_elements(COALESCE(v_global->'resources', '[]'::jsonb)) AS item
   WHERE item->>'key' = 'tasks'
   LIMIT 1;

  IF v_tasks_resource IS NULL THEN
    RAISE EXCEPTION 'uc114_ndr_ui_contract_v1: ui_read_registry tasks resource missing';
  END IF;

  v_tasks_resource := public.deep_merge_jsonb(v_tasks_resource, v_tasks_resource_patch);

  v_canonical_resources := jsonb_set(v_canonical_resources, ARRAY['tasks'], v_tasks_resource, TRUE);

  v_canonical_resources := jsonb_set(
    v_canonical_resources,
    ARRAY['dispatch_exception_review'],
    public.deep_merge_jsonb(
      v_tasks_resource,
      jsonb_build_object(
        'key', 'dispatch_exception_review',
        'label', 'Dispatch Exception Review',
        'description', 'Shipment-level NDR review queue with owner and SLA visibility.',
        'default_sort', jsonb_build_object('column', 'sla_due_at', 'direction', 'asc'),
        'base_filter', jsonb_build_object(
          'op', 'and',
          'rules', jsonb_build_array(
            jsonb_build_object('key', 'task_type_key', 'op', 'eq', 'value', 'dispatch_exception_review'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'completed'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'canceled'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'exception')
          )
        )
      )
    ),
    TRUE
  );

  v_canonical_resources := jsonb_set(
    v_canonical_resources,
    ARRAY['dispatch_exception_review_mine'],
    public.deep_merge_jsonb(
      v_tasks_resource,
      jsonb_build_object(
        'key', 'dispatch_exception_review_mine',
        'label', 'My Exception Reviews',
        'description', 'Dispatch exception reviews currently assigned to me.',
        'default_sort', jsonb_build_object('column', 'sla_due_at', 'direction', 'asc'),
        'base_filter', jsonb_build_object(
          'op', 'and',
          'rules', jsonb_build_array(
            jsonb_build_object('key', 'task_type_key', 'op', 'eq', 'value', 'dispatch_exception_review'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'completed'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'canceled'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'exception'),
            jsonb_build_object('key', 'assigned_to', 'op', 'eq', 'value', '$current_user')
          )
        )
      )
    ),
    TRUE
  );

  v_canonical_resources := jsonb_set(
    v_canonical_resources,
    ARRAY['unassigned_exceptions'],
    public.deep_merge_jsonb(
      v_tasks_resource,
      jsonb_build_object(
        'key', 'unassigned_exceptions',
        'label', 'Unassigned Exceptions',
        'description', 'Dispatch exception reviews without an owner.',
        'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
        'base_filter', jsonb_build_object(
          'op', 'and',
          'rules', jsonb_build_array(
            jsonb_build_object('key', 'task_type_key', 'op', 'eq', 'value', 'dispatch_exception_review'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'completed'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'canceled'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'exception'),
            jsonb_build_object('key', 'assigned_to', 'op', 'is_null')
          )
        )
      )
    ),
    TRUE
  );

  v_canonical_resources := jsonb_set(
    v_canonical_resources,
    ARRAY['sla_deadline_alerts'],
    public.deep_merge_jsonb(
      v_tasks_resource,
      jsonb_build_object(
        'key', 'sla_deadline_alerts',
        'label', 'SLA Deadline Alerts',
        'description', 'Dispatch exception reviews that have reached or breached their SLA.',
        'default_sort', jsonb_build_object('column', 'sla_due_at', 'direction', 'asc'),
        'base_filter', jsonb_build_object(
          'op', 'and',
          'rules', jsonb_build_array(
            jsonb_build_object('key', 'task_type_key', 'op', 'eq', 'value', 'dispatch_exception_review'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'completed'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'canceled'),
            jsonb_build_object('key', 'status', 'op', 'ne', 'value', 'exception'),
            jsonb_build_object('key', 'sla_due_at', 'op', 'not_null'),
            jsonb_build_object('key', 'sla_due_at', 'op', 'lte', 'value', '$now')
          )
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_next_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_resource_key := lower(NULLIF(btrim(COALESCE(v_resource->>'key', '')), ''));
      IF v_resource_key IS NOT NULL AND (v_canonical_resources ? v_resource_key) THEN
        v_resource := public.deep_merge_jsonb(v_canonical_resources->v_resource_key, v_resource);
      END IF;
      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    FOREACH v_target_key IN ARRAY ARRAY[
      'tasks',
      'dispatch_exception_review',
      'dispatch_exception_review_mine',
      'unassigned_exceptions',
      'sla_deadline_alerts'
    ]
    LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_next_resources) AS item
         WHERE lower(COALESCE(item->>'key', '')) = v_target_key
      ) THEN
        v_next_resources := v_next_resources || jsonb_build_array(v_canonical_resources->v_target_key);
      END IF;
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Sync UC114 task-backed NDR resources into scoped ui_read_registry rows.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_global JSONB := NULL;
  v_tasks_complete JSONB := NULL;
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB;
  v_command_key TEXT := NULL;
  v_target_key TEXT := NULL;
BEGIN
  SELECT sv.value
    INTO v_global
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_global IS NULL OR jsonb_typeof(v_global) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'uc114_ndr_ui_contract_v1: ui_command_registry global settings missing';
  END IF;

  SELECT item
    INTO v_tasks_complete
    FROM jsonb_array_elements(COALESCE(v_global->'commands', '[]'::jsonb)) AS item
   WHERE item->>'key' = 'tasks.complete'
   LIMIT 1;

  IF v_tasks_complete IS NULL THEN
    RAISE EXCEPTION 'uc114_ndr_ui_contract_v1: tasks.complete command missing from global ui_command_registry';
  END IF;

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['dispatch_exception_review.complete'],
    public.deep_merge_jsonb(
      v_tasks_complete,
      jsonb_build_object(
        'key', 'dispatch_exception_review.complete',
        'label', 'Complete review',
        'description', 'Complete the selected dispatch exception review task.',
        'schema_category', 'resource:dispatch_exception_review'
      )
    ),
    TRUE
  );

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['dispatch_exception_review_mine.complete'],
    public.deep_merge_jsonb(
      v_tasks_complete,
      jsonb_build_object(
        'key', 'dispatch_exception_review_mine.complete',
        'label', 'Complete review',
        'description', 'Complete the selected review from my queue.',
        'schema_category', 'resource:dispatch_exception_review_mine'
      )
    ),
    TRUE
  );

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['sla_deadline_alerts.complete'],
    public.deep_merge_jsonb(
      v_tasks_complete,
      jsonb_build_object(
        'key', 'sla_deadline_alerts.complete',
        'label', 'Complete review',
        'description', 'Complete the selected overdue dispatch exception review.',
        'schema_category', 'resource:sla_deadline_alerts'
      )
    ),
    TRUE
  );

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['unassigned_exceptions.claim'],
    jsonb_build_object(
      'key', 'unassigned_exceptions.claim',
      'label', 'Take ownership',
      'description', 'Assign the selected unassigned exception review to the current user.',
      'capability', 'tasks.write',
      'schema_category', 'resource:unassigned_exceptions',
      'selection', jsonb_build_object('mode', 'any', 'min_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_task_claim_v1'
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key IS NOT NULL AND (v_canonical_commands ? v_command_key) THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    FOREACH v_target_key IN ARRAY ARRAY[
      'dispatch_exception_review.complete',
      'dispatch_exception_review_mine.complete',
      'sla_deadline_alerts.complete',
      'unassigned_exceptions.claim'
    ]
    LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_next_commands) AS item
         WHERE COALESCE(item->>'key', '') = v_target_key
      ) THEN
        v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->v_target_key);
      END IF;
    END LOOP;

    v_current := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_row.version + 1,
           change_reason = 'Sync UC114 NDR commands into scoped ui_command_registry rows.',
           approved_at = workflow_now(),
           effective_from = workflow_now()
     WHERE id = v_row.settings_version_id
       AND v_current IS DISTINCT FROM v_row.value;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = workflow_now()
     WHERE id = v_row.settings_id
       AND v_current IS DISTINCT FROM v_row.value;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_source_sections JSONB := '[]'::jsonb;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB := '[]'::jsonb;
  v_has_operations BOOLEAN := FALSE;
  v_console_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-dispatch-exception-review',
      'label', 'Dispatch Exception Review',
      'href', '/console/operations/exceptions/dispatch_exception_review',
      'resource', 'dispatch_exception_review',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'console-dispatch-exception-review-mine',
      'label', 'My Exception Reviews',
      'href', '/console/operations/exceptions/dispatch_exception_review_mine',
      'resource', 'dispatch_exception_review_mine',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'console-unassigned-exceptions',
      'label', 'Unassigned Exceptions',
      'href', '/console/operations/exceptions/unassigned_exceptions',
      'resource', 'unassigned_exceptions',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'console-sla-deadline-alerts',
      'label', 'SLA Deadline Alerts',
      'href', '/console/operations/exceptions/sla_deadline_alerts',
      'resource', 'sla_deadline_alerts',
      'capability', 'tasks.read'
    )
  );
  v_portal_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-dispatch-exception-review',
      'label', 'Dispatch Exception Review',
      'href', '/portal/operations/exceptions/dispatch_exception_review',
      'resource', 'dispatch_exception_review',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'portal-dispatch-exception-review-mine',
      'label', 'My Exception Reviews',
      'href', '/portal/operations/exceptions/dispatch_exception_review_mine',
      'resource', 'dispatch_exception_review_mine',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'portal-unassigned-exceptions',
      'label', 'Unassigned Exceptions',
      'href', '/portal/operations/exceptions/unassigned_exceptions',
      'resource', 'unassigned_exceptions',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'portal-sla-deadline-alerts',
      'label', 'SLA Deadline Alerts',
      'href', '/portal/operations/exceptions/sla_deadline_alerts',
      'resource', 'sla_deadline_alerts',
      'capability', 'tasks.read'
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_source_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' NOT IN (
           'console-dispatch-exception-review',
           'console-dispatch-exception-review-mine',
           'console-unassigned-exceptions',
           'console-sla-deadline-alerts'
         );
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_console_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_console_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_console_items)
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

    v_source_sections := COALESCE(v_next#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' NOT IN (
           'portal-dispatch-exception-review',
           'portal-dispatch-exception-review-mine',
           'portal-unassigned-exceptions',
           'portal-sla-deadline-alerts'
         );
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_portal_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_next, '{apps,portal,sections}', v_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Sync UC114 exception queue navigation into scoped ui_navigation rows.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604032230_uc114_ndr_ui_contract_v1'));
COMMIT;

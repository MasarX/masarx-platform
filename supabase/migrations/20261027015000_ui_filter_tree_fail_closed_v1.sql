-- Registry predicates reject discarded rules; caller filters retain their guarded UX.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261027015000_ui_filter_tree_fail_closed_v1'));

-- Repair scoped registry predicates before enabling the strict compiler.
DO $registry$
DECLARE
  v_row RECORD;
  v_next JSONB;
  v_service_filter CONSTANT JSONB := '[{"key":"service","column":"service","op":"eq"}]'::jsonb;
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
    SELECT jsonb_set(v_row.value, '{resources}', COALESCE(jsonb_agg(
      CASE WHEN resource->>'key' IN ('api_gateway_auth_rejections', 'webhook_auth_rejections')
        AND NOT COALESCE(resource->'filters', '[]'::jsonb) @> v_service_filter THEN
        jsonb_set(resource, '{filters}', (
          SELECT COALESCE(jsonb_agg(def ORDER BY filter_ordinal), '[]'::jsonb)
          FROM jsonb_array_elements(COALESCE(resource->'filters', '[]'::jsonb))
            WITH ORDINALITY AS filters(def, filter_ordinal)
          WHERE def->>'key' IS DISTINCT FROM 'service'
        ) || v_service_filter)
      ELSE resource END ORDER BY ordinal), '[]'::jsonb))
    INTO v_next
    FROM jsonb_array_elements(v_row.value->'resources') WITH ORDINALITY AS resources(resource, ordinal);

    IF v_next IS DISTINCT FROM v_row.value THEN
      PERFORM 1 FROM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id, v_next, v_row.schema_version,
        'Declare service filters before strict authentication-rejection predicates');
    END IF;
  END LOOP;
END;
$registry$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';

-- The sole compiler carries strictness through every nested rule.
CREATE OR REPLACE FUNCTION public.ui_filter_tree_sql_v1(
  p_filter JSONB,
  p_defs JSONB,
  p_strict BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $function$
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
  v_resolver TEXT;
BEGIN
  IF p_filter IS NULL OR jsonb_typeof(p_filter) <> 'object' THEN
    IF p_strict IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: expected an object';
    END IF;
    RETURN NULL;
  END IF;

  IF p_strict IS DISTINCT FROM FALSE AND p_filter ? 'rules'
     AND jsonb_typeof(p_filter->'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: rules must be an array';
  END IF;

  v_rules := p_filter->'rules';
  IF jsonb_typeof(v_rules) = 'array' THEN
    FOR v_rule IN SELECT jsonb_array_elements(v_rules) LOOP
      v_sql := public.ui_filter_tree_sql_v1(v_rule, p_defs, p_strict);
      IF v_sql IS NOT NULL AND btrim(v_sql) <> '' THEN
        v_parts := array_append(v_parts, v_sql);
      END IF;
    END LOOP;

    IF array_length(v_parts, 1) IS NULL THEN
      IF p_strict IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: empty group';
      END IF;
      RETURN NULL;
    END IF;

    IF v_group_op NOT IN ('and', 'or') THEN
      IF p_strict IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: unknown group op';
      END IF;
      v_group_op := 'and';
    END IF;

    RETURN '(' || array_to_string(v_parts, ' ' || upper(v_group_op) || ' ') || ')';
  END IF;

  v_key := NULLIF(p_filter->>'key', '');
  IF v_key IS NULL THEN
    IF p_strict IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: missing filter key';
    END IF;
    RETURN NULL;
  END IF;

  SELECT value
    INTO v_def
    FROM jsonb_array_elements(COALESCE(p_defs, '[]'::jsonb)) AS value
   WHERE value->>'key' = v_key
   LIMIT 1;

  IF v_def IS NULL THEN
    IF p_strict IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: unknown filter key';
    END IF;
    RETURN NULL;
  END IF;

  v_column := NULLIF(v_def->>'column', '');
  IF v_column IS NULL THEN
    IF p_strict IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: missing filter column';
    END IF;
    RETURN NULL;
  END IF;

  v_op_def := lower(COALESCE(NULLIF(p_filter->>'op', ''), NULLIF(v_def->>'op', ''), 'eq'));
  v_resolver := lower(COALESCE(NULLIF(v_def->>'resolver', ''), ''));

  IF v_op_def = 'is_null' THEN
    RETURN format('%I IS NULL', v_column);
  END IF;

  IF v_op_def = 'not_null' THEN
    RETURN format('%I IS NOT NULL', v_column);
  END IF;

  v_value := p_filter->'value';
  IF v_value IS NULL OR v_value = 'null'::jsonb THEN
    IF p_strict IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: missing filter value';
    END IF;
    RETURN NULL;
  END IF;

  IF v_resolver = 'task_text' THEN
    IF v_op_def NOT IN ('eq', 'ilike') OR jsonb_typeof(v_value) <> 'string' THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 task text requires a string equality query';
    END IF;
    v_value_text := NULLIF(btrim(p_filter->>'value'), '');
    IF v_value_text IS NULL THEN
      IF p_strict IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: empty task text value';
      END IF;
      RETURN NULL;
    END IF;
    -- The finite scoped resolver runs once per statement, never once per task row.
    RETURN format(
      '%I = ANY(((SELECT public.ui_search_task_ids_v1(%L))::uuid[]))',
      v_column,
      v_value_text
    );
  END IF;

  IF v_resolver = 'shipment_identifier' THEN
    IF v_op_def NOT IN ('eq', 'ilike') THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 unsupported shipment identifier op %', v_op_def;
    END IF;

    IF jsonb_typeof(v_value) = 'array' THEN
      SELECT array_agg(format('%L', value))
        INTO v_values
        FROM jsonb_array_elements_text(v_value) AS value
       WHERE NULLIF(btrim(value), '') IS NOT NULL;

      IF v_values IS NULL OR array_length(v_values, 1) IS NULL THEN
        IF p_strict IS DISTINCT FROM FALSE THEN
          RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: empty shipment identifier values';
        END IF;
        RETURN NULL;
      END IF;

      RETURN format(
        '%I = ANY(public.ui_search_shipment_identifier_ids_v1(ARRAY[%s]))',
        v_column,
        array_to_string(v_values, ', ')
      );
    END IF;

    v_value_text := NULLIF(btrim(p_filter->>'value'), '');
    IF v_value_text IS NULL THEN
      IF p_strict IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: empty shipment identifier value';
      END IF;
      RETURN NULL;
    END IF;

    RETURN format(
      '%I = ANY(public.ui_search_shipment_identifier_ids_v1(ARRAY[%L]))',
      v_column,
      v_value_text
    );
  END IF;

  IF jsonb_typeof(v_value) = 'array' THEN
    SELECT array_agg(quote_literal(value))
      INTO v_values
      FROM jsonb_array_elements_text(v_value)
     WHERE NULLIF(btrim(value), '') IS NOT NULL;

    IF v_values IS NULL OR array_length(v_values, 1) IS NULL THEN
      IF p_strict IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: empty filter values';
      END IF;
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
    IF p_strict IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 invalid filter: empty filter value';
    END IF;
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
$function$;

REVOKE ALL ON FUNCTION public.ui_filter_tree_sql_v1(JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_filter_tree_sql_v1(JSONB, JSONB, BOOLEAN) TO authenticated, service_role;

-- Existing registry base-filter callers use the strict signature without changing their read contracts.
CREATE OR REPLACE FUNCTION public.ui_filter_tree_sql_v1(
  p_filter JSONB,
  p_defs JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  RETURN public.ui_filter_tree_sql_v1(p_filter, p_defs, TRUE);
END;
$function$;

COMMENT ON FUNCTION public.ui_filter_tree_sql_v1(JSONB, JSONB)
  IS 'Strict registry tree compiler; invalid rules and empty groups raise instead of dropping predicates.';

-- Keep existing signatures, attributes and ACLs through CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.ui_filter_flat_sql_v1(
  p_filters JSONB,
  p_defs JSONB,
  p_select_keys TEXT[] DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_parts TEXT[] := ARRAY[]::TEXT[];
  v_key TEXT;
  v_value JSONB;
  v_filter_sql TEXT;
  v_value_text TEXT;
  v_values TEXT[];
BEGIN
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'object' OR p_filters ? 'rules' THEN
    RETURN NULL;
  END IF;

  FOR v_key, v_value IN
    SELECT key, value
    FROM jsonb_each(p_filters)
  LOOP
    v_key := NULLIF(btrim(v_key), '');
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    v_filter_sql := NULL;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_defs, '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = v_key
    ) THEN
      v_filter_sql := public.ui_filter_tree_sql_v1(
        jsonb_build_object('key', v_key, 'value', v_value),
        p_defs, FALSE
      );
    ELSIF p_select_keys IS NOT NULL AND v_key = ANY(p_select_keys) THEN
      IF v_value IS NULL OR v_value = 'null'::jsonb THEN
        CONTINUE;
      END IF;

      IF jsonb_typeof(v_value) = 'array' THEN
        SELECT array_agg(format('%L', value))
          INTO v_values
          FROM jsonb_array_elements_text(v_value) AS value
         WHERE NULLIF(btrim(value), '') IS NOT NULL;

        IF v_values IS NOT NULL AND array_length(v_values, 1) IS NOT NULL THEN
          v_filter_sql := format('%I IN (%s)', v_key, array_to_string(v_values, ', '));
        END IF;
      ELSE
        v_value_text := NULLIF(btrim(p_filters->>v_key), '');
        IF v_value_text IS NOT NULL THEN
          v_filter_sql := format('%I = %L', v_key, v_value_text);
        END IF;
      END IF;
    END IF;

    IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
      v_parts := array_append(v_parts, v_filter_sql);
    END IF;
  END LOOP;

  IF array_length(v_parts, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN '(' || array_to_string(v_parts, ' AND ') || ')';
END;
$function$;

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
    RETURN public.ui_filter_tree_sql_v1(p_filters, v_defs, FALSE);
  END IF;
  RETURN public.ui_filter_flat_sql_v1(p_filters, v_defs, p_projection_keys);
END;
$function$;

-- Retain signatures, security attributes, guards and ACLs; constrain the same target statement.
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
  v_base_filter_sql TEXT;
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

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    v_where := v_where || ' AND ' || v_base_filter_sql;
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
  v_base_filter_sql TEXT;
  v_where TEXT := 'TRUE';
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

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    v_where := v_where || ' AND ' || v_base_filter_sql;
  END IF;

  -- Resolve predicates against target columns even when patch keys overlap.
  v_sql := format(
    'WITH patch AS (SELECT %s FROM jsonb_to_record($1) AS x(%s)) UPDATE %I.%I AS t SET %s FROM patch WHERE t.%I = $2::%s AND (SELECT %s FROM (SELECT t.*) AS base_row) RETURNING (SELECT to_jsonb(projected) FROM (SELECT %s) projected)',
    array_to_string(v_cols_list, ', '),
    array_to_string(v_cols_def, ', '),
    v_schema,
    v_table,
    array_to_string(v_set_parts, ', '),
    v_id_column,
    v_id_type,
    v_where,
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
  v_base_filter_sql TEXT;
  v_where TEXT := 'TRUE';
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

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    v_where := v_where || ' AND ' || v_base_filter_sql;
  END IF;

  v_sql := format(
    'DELETE FROM %I.%I AS t WHERE t.%I = $1::%s AND (%s) RETURNING (SELECT to_jsonb(projected) FROM (SELECT %s) projected)',
    v_schema,
    v_table,
    v_id_column,
    v_id_type,
    v_where,
    v_select_cols
  );

  EXECUTE v_sql INTO v_result USING p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

COMMIT;

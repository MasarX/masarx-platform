-- Plan: PLAN-202602-ux-upgrade-notion-level-v1 / Step: S02
-- Migration: UI filter value autocomplete - distinct values RPC (config-driven via ui_read_registry filters)
BEGIN;

SELECT pg_advisory_lock(hashtext('202602150810_ui_filter_distinct_values_v1'));

SET search_path TO public, extensions, pg_temp;

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
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
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

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 relation missing RLS: %', v_relation;
  END IF;

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

REVOKE ALL ON FUNCTION public.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) TO authenticated, service_role;

-- PostgREST boundary: expose via `api` schema wrapper with identical name.
CREATE OR REPLACE FUNCTION api.ui_filter_distinct_values_v1(
  p_resource TEXT,
  p_filter_key TEXT,
  p_query TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_filter_distinct_values_v1($1, $2, $3, $4);
$$;

REVOKE ALL ON FUNCTION api.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_filter_distinct_values_v1(TEXT, TEXT, TEXT, INT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602150810_ui_filter_distinct_values_v1'));

COMMIT;


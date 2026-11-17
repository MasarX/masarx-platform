-- F675: canonical task read projection; task writes retain public.tasks.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260908113000_task_controls_read_contract_v1'));

-- RLS applies for direct callers. Explicit scope also applies when reached through
-- the existing SECURITY DEFINER UI readers; their owner is not caller authority.
CREATE VIEW api.tasks_controls_v1 WITH (security_invoker = true) AS
WITH task_projection AS (
 SELECT t.*,
   COALESCE(rs.planned_window_start_at, rr.planned_start_at) AS planned_at,
   COALESCE(NULLIF(t.metadata->>'area',''), NULLIF(t.metadata#>>'{address,district}',''),
     NULLIF(t.metadata#>>'{address,city}',''), NULLIF(t.metadata->>'city',''), '') AS area,
   COALESCE(NULLIF(t.metadata->>'reference',''), NULLIF(t.metadata#>>'{customer,reference}',''), t.id::text) AS sort_code
 FROM public.tasks t
 LEFT JOIN public.route_stops_visible_v1 rs
   ON t.resource_type = 'route_stop' AND t.resource_id = rs.id
   AND t.organization_id = rs.organization_id
   AND (t.client_id IS NULL OR t.client_id = rs.client_id)
 LEFT JOIN api.route_runs rr
   ON t.resource_type = 'route_run' AND t.resource_id = rr.id
   AND t.organization_id = rr.organization_id
 WHERE auth.role() = 'service_role'
    OR (public.user_has_capability_v1('tasks.read', public.current_user_scope_type(), public.current_user_scope_id())
      AND (public.is_platform_user()
        OR (public.current_user_scope_type() = 'tenant' AND t.organization_id = public.current_user_org_id())
        OR (public.current_user_scope_type() = 'client' AND t.client_id = public.current_user_client_id())
        OR (public.current_user_scope_type() = 'sender' AND t.sender_id = public.current_user_sender_id())))
), classified AS (
 SELECT task_projection.*, CASE
   WHEN planned_at IS NULL THEN 'later'
   WHEN planned_at <= statement_timestamp() + INTERVAL '60 minutes' THEN 'now'
   WHEN planned_at::date = CURRENT_DATE THEN 'today'
   ELSE 'later' END AS urgency
 FROM task_projection
)
SELECT classified.*,
 CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END AS urgency_order,
 jsonb_build_array(CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END,
   -priority::numeric, CASE WHEN planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM planned_at),0), sort_code, id::text) AS smart_order,
 jsonb_build_array(-priority::numeric, sort_code, id::text) AS sort_priority,
 jsonb_build_array(CASE WHEN planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM planned_at),0), sort_code, id::text) AS sort_eta,
 jsonb_build_array(area, sort_code, id::text) AS sort_area,
 CASE WHEN urgency = 'now' THEN 1 ELSE 0 END AS urgency_now,
 CASE WHEN urgency = 'today' THEN 1 ELSE 0 END AS urgency_today,
 CASE WHEN urgency = 'later' THEN 1 ELSE 0 END AS urgency_later
FROM classified;
REVOKE ALL ON api.tasks_controls_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON api.tasks_controls_v1 TO authenticated, service_role;
COMMENT ON VIEW api.tasks_controls_v1 IS
 'Canonical task read projection with explicit caller scope; exact actor-visible route planned time, never SLA or arbitrary metadata IDs. No task mutation authority.';

-- Same finite resolver pattern as canonical shipment identifier search. Raw text
-- is a literal substring, not a wildcard expression or arbitrary JSON search.
CREATE FUNCTION public.ui_search_task_ids_v1(p_query TEXT)
RETURNS UUID[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $search$
DECLARE
 v_scope_type TEXT := public.current_user_scope_type();
 v_scope_id UUID := public.current_user_scope_id();
 v_query TEXT := NULLIF(btrim(p_query), '');
 v_ids UUID[];
BEGIN
 IF auth.uid() IS NULL THEN
   RAISE EXCEPTION 'ui_search_task_ids_v1 requires authenticated user';
 END IF;
 IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
   v_scope_id := public.current_user_org_id();
 END IF;
 PERFORM public.assert_capability_v1('tasks.read', v_scope_type, v_scope_id);
 IF v_query IS NULL THEN RETURN ARRAY[]::uuid[]; END IF;
 SELECT COALESCE(array_agg(t.id ORDER BY t.id), ARRAY[]::uuid[]) INTO v_ids
 FROM api.tasks_controls_v1 t
 LEFT JOIN LATERAL (
   SELECT string_agg(value #>> '{}', ' ' ORDER BY node_ord, key_ord) AS text_value
   FROM unnest(ARRAY[t.metadata, t.metadata->'route_stop', t.metadata->'address',
     t.metadata->'customer', t.metadata->'contact', t.metadata->'location'])
     WITH ORDINALITY AS nodes(node, node_ord)
   CROSS JOIN unnest(ARRAY['title','label','name','task_label','customer_name','customer',
     'ref','reference','reference_number','order_number','shipment_ref','shipment_number',
     'tracking_number','city','district','province','area','place','line1',
     'normalized_line1','raw_input','kind','stop_kind','task_type','type','type_key'])
     WITH ORDINALITY AS keys(key, key_ord)
   CROSS JOIN LATERAL (SELECT node->key AS value) selected
   WHERE jsonb_typeof(value) = 'string'
 ) text_fields ON TRUE
 WHERE strpos(lower(concat_ws(' ', t.id::text, t.resource_id::text,
   t.task_type_key, text_fields.text_value)), lower(v_query)) > 0;
 RETURN v_ids;
END;
$search$;
REVOKE ALL ON FUNCTION public.ui_search_task_ids_v1(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_search_task_ids_v1(TEXT) TO authenticated, service_role;

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
  v_select_cols TEXT := '*';
  v_select_keys TEXT[];
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_sort_key TEXT;
  v_group_key TEXT;
  v_group_sort TEXT;
  v_order_sql TEXT;
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

  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
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

  v_order_sql := format('%I %s', v_sort_col, CASE WHEN v_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END);
  v_group_key := NULLIF(p_sort->>'group_key', '');
  IF v_group_key IS NOT NULL THEN
    IF NOT COALESCE(v_group_key = ANY(v_select_keys), FALSE)
       OR NOT COALESCE((v_resource#>'{task_controls,group_columns}') ? v_group_key, FALSE) THEN
      RAISE EXCEPTION 'ui_list_resource_v1 unconfigured group column %', v_group_key;
    END IF;
    v_group_sort := COALESCE(NULLIF(v_resource#>>ARRAY['task_controls','group_sort_columns',v_group_key], ''), v_group_key);
    IF NOT COALESCE(v_group_sort = ANY(v_select_keys), FALSE) THEN
      RAISE EXCEPTION 'ui_list_resource_v1 invalid configured group sort column %', v_group_sort;
    END IF;
    v_order_sql := format('%I ASC, ', v_group_sort) || v_order_sql;
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
      v_filter_sql := public.ui_filter_flat_sql_v1(
        p_filters,
        COALESCE(v_resource->'filters', '[]'::jsonb),
        v_select_keys
      );
      IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
        v_where := v_where || ' AND ' || v_filter_sql;
      END IF;
    END IF;
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
    'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (SELECT %s FROM %I.%I WHERE %s ORDER BY %s LIMIT %s OFFSET %s) t',
    v_select_cols,
    v_schema,
    v_table,
    v_where,
    v_order_sql,
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
$function$;

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

  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
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

  IF jsonb_typeof(p_filters) = 'object' THEN
    IF p_filters ? 'rules' THEN
      v_filter_sql := public.ui_filter_tree_sql_v1(
        p_filters,
        COALESCE(v_resource->'filters', '[]'::jsonb)
      );
      IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
        v_where := v_where || ' AND ' || v_filter_sql;
      END IF;
    ELSE
      v_filter_sql := public.ui_filter_flat_sql_v1(
        p_filters,
        COALESCE(v_resource->'filters', '[]'::jsonb),
        v_select_keys
      );
      IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
        v_where := v_where || ' AND ' || v_filter_sql;
      END IF;
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

  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
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

  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
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

CREATE OR REPLACE FUNCTION public.ui_filter_tree_sql_v1(
  p_filter JSONB,
  p_defs JSONB
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
  v_resolver := lower(COALESCE(NULLIF(v_def->>'resolver', ''), ''));

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

  IF v_resolver = 'task_text' THEN
    IF v_op_def NOT IN ('eq', 'ilike') OR jsonb_typeof(v_value) <> 'string' THEN
      RAISE EXCEPTION 'ui_filter_tree_sql_v1 task text requires a string equality query';
    END IF;
    v_value_text := NULLIF(btrim(p_filter->>'value'), '');
    IF v_value_text IS NULL THEN RETURN NULL; END IF;
    RETURN format('%I = ANY(public.ui_search_task_ids_v1(%L))', v_column, v_value_text);
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
$function$;
-- Extend only the existing read/write split: relation remains the write identity.
DO $registry$
DECLARE
 v_schema public.schema_registry%ROWTYPE;
 v_schema_version INTEGER;
 v_row RECORD;
 v_task JSONB;
 v_next JSONB;
 v_resources JSONB;
 v_filters JSONB;
 v_select JSONB;
 v_promoted INTEGER := 0;
BEGIN
 LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_schema FROM public.schema_registry
 WHERE category = 'ui_read_registry' AND is_active
 ORDER BY version DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(v_schema.schema#>'{properties,resources,items,properties}') IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'active UI read registry schema is missing or malformed';
 END IF;
 SELECT COALESCE(MAX(version),0)+1 INTO v_schema_version FROM public.schema_registry
 WHERE category = 'ui_read_registry';
 INSERT INTO public.schema_registry(category,version,schema,description,examples,is_active)
 VALUES ('ui_read_registry',v_schema_version,
   jsonb_set(jsonb_set(v_schema.schema,
     '{properties,resources,items,properties,read_relation}', '{"type":"string","minLength":1}'::jsonb,TRUE),
     '{properties,resources,items,properties,task_controls}', '{"type":"object"}'::jsonb,TRUE),
   'Canonical task controls with an optional scoped read relation',v_schema.examples,TRUE);
 UPDATE public.schema_registry SET is_active = FALSE
 WHERE category = 'ui_read_registry' AND version <> v_schema_version AND is_active;

 FOR v_row IN
   SELECT s.id AS settings_id,s.settings_version_id,s.category,s.scope_type,s.scope_id,
     s.scope_hash,s.cached_value,sv.value
   FROM public.settings s JOIN public.settings_versions sv
     ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'ui_read_registry'
   ORDER BY s.id
   FOR UPDATE OF s,sv
 LOOP
   IF v_row.cached_value IS DISTINCT FROM v_row.value
      OR jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'UI read registry settings pair is inconsistent: %',v_row.settings_id;
   END IF;
   SELECT item INTO v_task FROM jsonb_array_elements(v_row.value->'resources') item
   WHERE item->>'key' = 'tasks';
   IF NOT FOUND THEN CONTINUE; END IF;
   IF (SELECT count(*) FROM jsonb_array_elements(v_row.value->'resources') item WHERE item->>'key' = 'tasks') <> 1
      OR v_task->>'relation' IS DISTINCT FROM 'public.tasks'
      OR v_task->>'id_column' IS DISTINCT FROM 'id'
      OR v_task->>'capability_read' IS DISTINCT FROM 'tasks.read'
      OR v_task->'scope_columns' IS DISTINCT FROM '{"tenant":"organization_id","client":"client_id","sender":"sender_id"}'::jsonb THEN
     RAISE EXCEPTION 'task registry authority differs from the selected canonical contract: %',v_row.settings_id;
   END IF;
   IF NULLIF(v_task->>'read_relation','') IS NOT NULL THEN
     RAISE EXCEPTION 'task read projection already configured; reconcile instead of overwrite';
   END IF;

   -- Explicit equality definitions preserve the flat-reader fallback when a saved
   -- flat filter is composed with the new controls into an AND filter tree.
   SELECT COALESCE(v_task->'filters','[]'::jsonb) ||
     COALESCE(jsonb_agg(jsonb_build_object('key',column_name,'column',column_name,'op','eq') ORDER BY ordinal_position),'[]'::jsonb)
   INTO v_filters FROM information_schema.columns c
   WHERE table_schema='public' AND table_name='tasks'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_task->'filters','[]'::jsonb)) f
       WHERE f->>'key'=c.column_name);
   IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_filters) f WHERE f->>'key' IN ('query','urgency')) THEN
     RAISE EXCEPTION 'task control filter keys already configured; reconcile instead of overwrite';
   END IF;
   v_filters := v_filters || jsonb_build_array(
     jsonb_build_object('key','query','column','id','op','eq','resolver','task_text'),
     jsonb_build_object('key','urgency','column','urgency','op','eq'));
   SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO v_select FROM (
     SELECT value,min(ord) AS ord
     FROM jsonb_array_elements(COALESCE(v_task->'select','[]'::jsonb) ||
       '["planned_at","urgency","urgency_order","smart_order","sort_priority","sort_eta","sort_area","area","urgency_now","urgency_today","urgency_later"]'::jsonb)
       WITH ORDINALITY selected(value,ord)
     GROUP BY value
   ) selected;
   v_task := v_task || jsonb_build_object(
     'read_relation','api.tasks_controls_v1','select',v_select,'filters',v_filters,
     'task_controls',jsonb_build_object(
       'query_filter','query','urgency_filter','urgency',
       'group_columns',jsonb_build_array('urgency','task_type_key','queue_key','area'),
       'group_sort_columns',jsonb_build_object('urgency','urgency_order'),
       'sort_options',jsonb_build_array(
         jsonb_build_object('key','smart_order','label_key','smart','direction','asc'),
         jsonb_build_object('key','sort_priority','label_key','priority','direction','asc'),
         jsonb_build_object('key','sort_eta','label_key','eta','direction','asc'),
         jsonb_build_object('key','sort_area','label_key','area','direction','asc')),
       'metric_columns',jsonb_build_object('now','urgency_now','today','urgency_today','later','urgency_later')));
   SELECT jsonb_agg(CASE WHEN item->>'key'='tasks' THEN v_task ELSE item END ORDER BY ord)
   INTO v_resources FROM jsonb_array_elements(v_row.value->'resources') WITH ORDINALITY r(item,ord);
   v_next := jsonb_set(v_row.value,'{resources}',v_resources);
   WITH closed AS (
     UPDATE public.settings_versions
     SET effective_until=GREATEST(clock_timestamp(),effective_from+INTERVAL '1 microsecond'),updated_at=clock_timestamp()
     WHERE id=v_row.settings_version_id AND scope_hash=v_row.scope_hash AND effective_until IS NULL
     RETURNING id
   ), inserted AS (
     INSERT INTO public.settings_versions(id,category,scope_type,scope_id,scope_hash,version,value,
       schema_version,change_reason,approved_at,effective_from)
     SELECT gen_random_uuid(),v_row.category,v_row.scope_type,v_row.scope_id,v_row.scope_hash,
       (SELECT COALESCE(MAX(candidate.version),0)+1 FROM public.settings_versions candidate
        WHERE candidate.category=v_row.category AND candidate.scope_type=v_row.scope_type AND candidate.scope_hash=v_row.scope_hash),
       v_next,v_schema_version,'Preserve task controls on the canonical read/write identity',
       clock_timestamp(),clock_timestamp()
     FROM closed RETURNING id,value
   )
   UPDATE public.settings s SET settings_version_id=inserted.id,cached_value=inserted.value,last_updated=clock_timestamp()
   FROM inserted WHERE s.id=v_row.settings_id AND s.settings_version_id=v_row.settings_version_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'task registry promotion lost pointer CAS'; END IF;
   v_promoted := v_promoted+1;
 END LOOP;
 IF v_promoted=0 THEN RAISE EXCEPTION 'canonical task registry settings missing'; END IF;
 DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
END;
$registry$;
COMMIT;

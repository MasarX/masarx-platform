-- Console V2 customer read scope hardening.
--
-- The shared ui_read_registry path is security-definer for browser-safe reads,
-- so client/sender scoped callers must never fall through to broad projection
-- rows when a resource lacks an explicit scope column. Repair the customer
-- projection registry entries and make the read helpers fail closed for
-- client/sender callers without a declared scope column.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605152230_console_v2_ui_read_customer_scope_fail_closed_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_scope_column_v1(
  p_resource JSONB,
  p_resource_key TEXT,
  p_scope_type TEXT,
  p_rpc_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), 'global'));
  v_scope_column TEXT;
BEGIN
  IF v_scope_type NOT IN ('tenant', 'client', 'sender') THEN
    RETURN NULL;
  END IF;

  v_scope_column := p_resource#>>ARRAY['scope_columns', v_scope_type];

  IF NULLIF(v_scope_column, '') IS NULL AND v_scope_type IN ('client', 'sender') THEN
    RAISE EXCEPTION '% resource % missing % scope column',
      COALESCE(NULLIF(p_rpc_name, ''), 'ui_read'),
      COALESCE(NULLIF(p_resource_key, ''), '<unknown>'),
      v_scope_type
      USING ERRCODE = '42501';
  END IF;

  RETURN NULLIF(v_scope_column, '');
END;
$$;

COMMENT ON FUNCTION public.ui_read_scope_column_v1(JSONB, TEXT, TEXT, TEXT) IS
  'Returns the ui_read_registry scope column for tenant/client/sender reads and fail-closes client/sender scoped reads when no scope column is declared.';

REVOKE ALL ON FUNCTION public.ui_read_scope_column_v1(JSONB, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_scope_column_v1(JSONB, TEXT, TEXT, TEXT) TO authenticated, service_role;

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_next JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);

    SELECT COALESCE(
             jsonb_agg(
               CASE resource->>'key'
                 WHEN 'client_summary' THEN
                   jsonb_set(
                     resource,
                     '{scope_columns}',
                     COALESCE(resource->'scope_columns', '{}'::jsonb)
                       || jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
                     TRUE
                   )
                 WHEN 'sender_summary' THEN
                   jsonb_set(
                     resource,
                     '{scope_columns}',
                     COALESCE(resource->'scope_columns', '{}'::jsonb)
                       || jsonb_build_object('tenant', 'organization_id_resolved', 'client', 'client_id', 'sender', 'sender_id'),
                     TRUE
                   )
                 ELSE resource
               END
               ORDER BY ordinality
             ),
             '[]'::jsonb
           )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
           WITH ORDINALITY AS r(resource, ordinality);

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Console V2: fail-close customer ui_read client/sender scopes',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%client_summary%'
      OR cache_key LIKE 'ui_list_resource:%sender_summary%'
      OR cache_key LIKE 'ui_list_resource:%recipient_directory%';
END;
$registry$;

CREATE OR REPLACE FUNCTION public.ui_list_resource_v1(p_resource text, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_sort jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
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

  SELECT array_agg(cols.column_name::text ORDER BY cols.ordinal_position)
    INTO v_select_keys
    FROM information_schema.columns cols
   WHERE cols.table_schema = v_schema
     AND cols.table_name = v_table;
  IF v_select_keys IS NULL OR array_length(v_select_keys, 1) IS NULL THEN
    v_select_keys := ARRAY[v_id_column];
  END IF;

  IF v_scope_type IN ('tenant', 'client', 'sender') THEN
    v_scope_column := public.ui_read_scope_column_v1(v_resource, p_resource, v_scope_type, 'ui_list_resource_v1');
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
$function$;

CREATE OR REPLACE FUNCTION public.ui_get_resource_v1(p_resource text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET row_security TO 'on'
AS $function$
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
    v_scope_column := public.ui_read_scope_column_v1(v_resource, p_resource, v_scope_type, 'ui_get_resource_v1');
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
$function$;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'client_summary'
            AND resource#>>'{scope_columns,tenant}' = 'organization_id'
            AND resource#>>'{scope_columns,client}' = 'client_id'
       )
  ) THEN
    RAISE EXCEPTION 'client_summary missing tenant/client scope columns in one or more ui_read_registry rows';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'sender_summary'
            AND resource#>>'{scope_columns,tenant}' = 'organization_id_resolved'
            AND resource#>>'{scope_columns,client}' = 'client_id'
            AND resource#>>'{scope_columns,sender}' = 'sender_id'
       )
  ) THEN
    RAISE EXCEPTION 'sender_summary missing tenant/client/sender scope columns in one or more ui_read_registry rows';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings_cache
     WHERE cache_key LIKE 'ui_read_registry:%'
        OR cache_key LIKE 'ui_list_resource:%client_summary%'
        OR cache_key LIKE 'ui_list_resource:%sender_summary%'
        OR cache_key LIKE 'ui_list_resource:%recipient_directory%'
  ) THEN
    RAISE EXCEPTION 'customer ui_read scope cache was not invalidated';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202605152230_console_v2_ui_read_customer_scope_fail_closed_v1'));

COMMIT;

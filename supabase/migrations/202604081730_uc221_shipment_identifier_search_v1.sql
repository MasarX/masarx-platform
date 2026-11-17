-- Spec-Issue: #2157 / Step: E01
-- Migration: Shipment identifier search UI contract
-- Date: 2026-04-08
--
-- Purpose:
-- - Resolve visible shipments from any canonical identifier, including shipment ID,
--   tracking/client/carrier/system references, recipient phone, shipment reference rows,
--   and correlation IDs.
-- - Keep Console/Portal shipment search on the canonical ui_read_registry/ui_list_resource_v1
--   path instead of introducing a parallel search RPC or app-side joins.
-- - Ensure ui_list_resource_v1 and ui_resource_metrics_v1 consume the same flat-filter compiler
--   so helper-backed filters stay list/metrics consistent.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604081730_uc221_shipment_identifier_search_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_search_shipment_identifier_ids_v1(
  p_queries TEXT[]
)
RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_can_read_audit_log BOOLEAN := FALSE;
  v_can_read_requests BOOLEAN := FALSE;
  v_ids UUID[] := ARRAY[]::uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_search_shipment_identifier_ids_v1 requires authenticated user';
  END IF;

  IF COALESCE(array_length(p_queries, 1), 0) = 0 THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  PERFORM public.assert_capability_v1('shipments.read', v_scope_type, v_scope_id);
  v_can_read_audit_log := public.user_has_capability_v1('audit_log.read', v_scope_type, v_scope_id);
  v_can_read_requests := public.user_has_capability_v1('requests.read', v_scope_type, v_scope_id);

  WITH normalized_queries AS (
    SELECT DISTINCT
      btrim(query_text) AS raw_query,
      upper(NULLIF(btrim(query_text), '')) AS reference_upper,
      public.normalize_phone_number(query_text) AS phone_normalized,
      CASE
        WHEN btrim(query_text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN btrim(query_text)::uuid
        ELSE NULL::uuid
      END AS query_uuid
    FROM unnest(COALESCE(p_queries, ARRAY[]::TEXT[])) AS query_text
    WHERE NULLIF(btrim(query_text), '') IS NOT NULL
  ),
  visible_shipments AS (
    SELECT
      s.id,
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.recipient_id,
      s.tracking_upper,
      upper(NULLIF(btrim(s.client_reference_number), '')) AS client_reference_upper,
      upper(NULLIF(btrim(s.carrier_reference_number), '')) AS carrier_reference_upper,
      upper(NULLIF(btrim(s.lmd_system_reference), '')) AS lmd_reference_upper
    FROM public.shipments s
    WHERE public.is_platform_user()
       OR (
         v_scope_type = 'tenant'
         AND s.organization_id = v_scope_id
       )
       OR (
         v_scope_type = 'client'
         AND s.client_id = v_scope_id
       )
       OR (
         v_scope_type = 'sender'
         AND s.sender_id = v_scope_id
       )
  ),
  matched_shipments AS (
    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq
      ON (
        (nq.query_uuid IS NOT NULL AND vs.id = nq.query_uuid)
        OR (nq.reference_upper IS NOT NULL AND vs.tracking_upper = nq.reference_upper)
        OR (nq.reference_upper IS NOT NULL AND vs.client_reference_upper = nq.reference_upper)
        OR (nq.reference_upper IS NOT NULL AND vs.carrier_reference_upper = nq.reference_upper)
        OR (nq.reference_upper IS NOT NULL AND vs.lmd_reference_upper = nq.reference_upper)
      )

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN public.shipment_reference_numbers srn
      ON srn.shipment_id = vs.id
     AND srn.client_id = vs.client_id
    JOIN normalized_queries nq
      ON nq.reference_upper IS NOT NULL
     AND srn.reference_value_upper = nq.reference_upper

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN public.recipients r
      ON r.id = vs.recipient_id
     AND r.client_id = vs.client_id
    JOIN normalized_queries nq
      ON nq.phone_normalized IS NOT NULL
     AND r.phone_number_normalized = nq.phone_normalized

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq
      ON nq.query_uuid IS NOT NULL
    JOIN public.workflow_runs wr
      ON (v_can_read_audit_log OR v_can_read_requests)
     AND wr.triggered_by_request_id = nq.query_uuid
     AND (
       wr.context->>'shipment_id' = vs.id::text
       OR wr.context->'shipment'->>'id' = vs.id::text
       OR wr.context->'transformed_payload'->>'shipment_id' = vs.id::text
     )

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq
      ON nq.query_uuid IS NOT NULL
    JOIN public.decision_log dl
      ON v_can_read_audit_log
     AND dl.organization_id = vs.organization_id
     AND dl.correlation_id = nq.query_uuid
     AND (
       (dl.resource_type = 'shipment' AND dl.resource_id = vs.id)
       OR EXISTS (
         SELECT 1
         FROM public.workflow_runs wr
         WHERE wr.triggered_by_request_id = dl.correlation_id
           AND (
             wr.context->>'shipment_id' = vs.id::text
             OR wr.context->'shipment'->>'id' = vs.id::text
             OR wr.context->'transformed_payload'->>'shipment_id' = vs.id::text
           )
       )
     )

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq
      ON nq.query_uuid IS NOT NULL
    JOIN public.domain_events de
      ON v_can_read_requests
     AND de.organization_id = vs.organization_id
     AND de.correlation_id = nq.query_uuid
     AND de.resource_type = 'shipment'
     AND de.resource_id = vs.id

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq
      ON nq.query_uuid IS NOT NULL
    JOIN public.outbound_calls oc
      ON (v_can_read_audit_log OR v_can_read_requests)
     AND oc.correlation_id = nq.query_uuid
     AND oc.shipment_id = vs.id
  )
  SELECT COALESCE(array_agg(matched_shipments.id ORDER BY matched_shipments.id), ARRAY[]::uuid[])
    INTO v_ids
    FROM matched_shipments;

  RETURN COALESCE(v_ids, ARRAY[]::uuid[]);
END;
$function$;

COMMENT ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[])
  IS 'Resolve visible shipment ids for the authenticated caller from canonical shipment identifiers and capability-gated correlation ids.';

REVOKE ALL ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[]) TO authenticated, service_role;

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
        p_defs
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

CREATE OR REPLACE FUNCTION public.ui_list_resource_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_sort JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
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
  v_select_keys TEXT[];
  v_numeric_cols TEXT[];
  v_metrics_sql TEXT;
  v_metrics JSONB := '{}'::jsonb;
  v_total BIGINT := 0;
  v_where TEXT := 'TRUE';
  v_base_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_filter_key TEXT;
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

  v_select_keys := COALESCE(
    p_columns,
    ARRAY(
      SELECT cols.column_name::TEXT
      FROM information_schema.columns cols
      WHERE cols.table_schema = v_schema
        AND cols.table_name = v_table
      ORDER BY cols.ordinal_position
    )
  );
  IF v_select_keys IS NULL OR array_length(v_select_keys, 1) IS NULL THEN
    v_select_keys := ARRAY[v_id_column];
  END IF;

  SELECT array_agg(column_name::TEXT ORDER BY column_name)
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
    v_metrics_sql := trim(trailing ',' from v_metrics_sql)
      || format(') FROM %I.%I WHERE %s', v_schema, v_table, v_where);
    EXECUTE v_metrics_sql INTO v_metrics;
  END IF;

  RETURN jsonb_build_object(
    'resource', p_resource,
    'total', COALESCE(v_total, 0),
    'columns', COALESCE(v_metrics, '{}'::jsonb)
  );
END;
$function$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_next_resources JSONB := '[]'::jsonb;
  v_resource JSONB := NULL;
  v_resource_key TEXT := NULL;
  v_filters JSONB := '[]'::jsonb;
  v_next_filters JSONB := '[]'::jsonb;
  v_filter JSONB := NULL;
  v_filter_key TEXT := NULL;
BEGIN
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
      CONTINUE;
    END IF;

    v_next_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_resource_key := lower(NULLIF(btrim(COALESCE(v_resource->>'key', '')), ''));
      IF v_resource_key = 'shipments' THEN
        v_filters := COALESCE(v_resource->'filters', '[]'::jsonb);
        IF jsonb_typeof(v_filters) IS DISTINCT FROM 'array' THEN
          v_filters := '[]'::jsonb;
        END IF;

        v_next_filters := '[]'::jsonb;
        FOR v_filter IN
          SELECT value
          FROM jsonb_array_elements(v_filters) AS value
        LOOP
          v_filter_key := lower(NULLIF(btrim(COALESCE(v_filter->>'key', '')), ''));
          IF v_filter_key IN ('identifier', 'tracking_number', 'client_reference_number', 'carrier_reference_number', 'client_id', 'sender_id', 'status') THEN
            CONTINUE;
          END IF;
          v_next_filters := v_next_filters || jsonb_build_array(v_filter);
        END LOOP;

        v_next_filters := jsonb_build_array(
          jsonb_build_object(
            'key', 'identifier',
            'label', 'Identifier',
            'column', 'id',
            'op', 'eq',
            'resolver', 'shipment_identifier'
          ),
          jsonb_build_object(
            'key', 'status',
            'label', 'Status',
            'column', 'status',
            'op', 'eq'
          ),
          jsonb_build_object(
            'key', 'tracking_number',
            'label', 'Tracking number',
            'column', 'tracking_number',
            'op', 'ilike'
          ),
          jsonb_build_object(
            'key', 'client_reference_number',
            'label', 'Client reference number',
            'column', 'client_reference_number',
            'op', 'ilike'
          ),
          jsonb_build_object(
            'key', 'carrier_reference_number',
            'label', 'Carrier reference number',
            'column', 'carrier_reference_number',
            'op', 'ilike'
          ),
          jsonb_build_object(
            'key', 'client_id',
            'label', 'Client ID',
            'column', 'client_id',
            'op', 'eq'
          ),
          jsonb_build_object(
            'key', 'sender_id',
            'label', 'Sender ID',
            'column', 'sender_id',
            'op', 'eq'
          )
        ) || v_next_filters;

        v_resource := jsonb_set(v_resource, '{filters}', v_next_filters, TRUE);
      END IF;

      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_row.version + 1,
           change_reason = 'Sync shipment identifier search filters into ui_read_registry rows.',
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

SELECT pg_advisory_unlock(hashtext('202604081730_uc221_shipment_identifier_search_v1'));
COMMIT;

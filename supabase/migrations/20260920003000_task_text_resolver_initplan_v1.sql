-- Evaluate the finite task-text resolver once per generated statement while
-- preserving its complete scoped ID set and all existing filter semantics.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260920003000_task_text_resolver_initplan_v1'));

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
    -- The scalar subquery is an uncorrelated InitPlan. It preserves the full
    -- resolver array while preventing a full resolver scan per outer task row.
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

REVOKE ALL ON FUNCTION public.ui_filter_tree_sql_v1(JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_filter_tree_sql_v1(JSONB, JSONB) TO authenticated, service_role;

COMMIT;

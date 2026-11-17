-- Migration: UI reorder resource RPC (registry-driven)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191700_ui_reorder_resource_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_reorder_resource_v1(
  p_resource TEXT,
  p_ids TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
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
  v_reorder JSONB;
  v_order_column TEXT;
  v_order_type TEXT;
  v_group_column TEXT;
  v_group_type TEXT;
  v_require_full BOOLEAN := true;
  v_post_action TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_count INT;
  v_unique_count INT;
  v_found_count INT := 0;
  v_group_distinct INT := 0;
  v_group_value TEXT;
  v_group_total INT := 0;
  v_updated_count INT := 0;
  v_sql TEXT;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 requires resource key';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 requires ids';
  END IF;

  v_count := array_length(p_ids, 1);
  IF v_count < 1 THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 requires ids';
  END IF;

  SELECT COUNT(*) INTO v_unique_count
  FROM (SELECT DISTINCT value FROM unnest(p_ids) AS value) AS distinct_ids;
  IF v_unique_count <> v_count THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 ids must be unique';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 resource missing relation';
  END IF;

  v_reorder := v_resource->'reorder';
  IF jsonb_typeof(v_reorder) <> 'object' THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 reorder config missing for %', p_resource;
  END IF;

  v_order_column := NULLIF(v_reorder->>'order_column', '');
  v_group_column := NULLIF(v_reorder->>'group_column', '');
  v_post_action := NULLIF(v_reorder->>'post_action', '');
  v_capability := COALESCE(NULLIF(v_reorder->>'capability', ''), v_capability);
  v_require_full := COALESCE(NULLIF(v_reorder->>'require_full', '')::boolean, true);

  IF v_order_column IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 reorder order_column missing for %', p_resource;
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
    RAISE EXCEPTION 'ui_reorder_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 relation missing RLS: %', v_relation;
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
    RAISE EXCEPTION 'ui_reorder_resource_v1 id column not found: %', v_id_column;
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_order_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_order_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;
  IF v_order_type IS NULL THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 order column not found: %', v_order_column;
  END IF;
  IF lower(v_order_type) NOT IN ('smallint', 'integer', 'bigint') THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 order column must be integer: %', v_order_column;
  END IF;

  IF v_group_column IS NOT NULL THEN
    SELECT format_type(a.atttypid, a.atttypmod)
      INTO v_group_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = v_schema
       AND c.relname = v_table
       AND a.attname = v_group_column
       AND a.attnum > 0
       AND a.attisdropped = false
     LIMIT 1;
    IF v_group_type IS NULL THEN
      RAISE EXCEPTION 'ui_reorder_resource_v1 group column not found: %', v_group_column;
    END IF;
  END IF;

  IF v_group_column IS NOT NULL THEN
    v_sql := format(
      'SELECT t.%I::text FROM %I.%I t WHERE t.%I = $1::%s',
      v_group_column,
      v_schema,
      v_table,
      v_id_column,
      v_id_type
    );
    EXECUTE v_sql INTO v_group_value USING p_ids[1];
    IF v_group_value IS NULL THEN
      RAISE EXCEPTION 'ui_reorder_resource_v1 could not find % for id %', p_resource, p_ids[1];
    END IF;

    v_sql := format(
      'SELECT COUNT(*), COUNT(DISTINCT t.%I::text) FROM %I.%I t JOIN unnest($1::text[]) AS ids(value) ON t.%I = ids.value::%s',
      v_group_column,
      v_schema,
      v_table,
      v_id_column,
      v_id_type
    );
    EXECUTE v_sql INTO v_found_count, v_group_distinct USING p_ids;

    IF v_found_count <> v_count THEN
      RAISE EXCEPTION 'ui_reorder_resource_v1 could not find all ids for %', p_resource;
    END IF;
    IF v_group_distinct <> 1 THEN
      RAISE EXCEPTION 'ui_reorder_resource_v1 ids span multiple groups for %', p_resource;
    END IF;

    IF v_require_full THEN
      v_sql := format(
        'SELECT COUNT(*) FROM %I.%I t WHERE t.%I = $1::%s',
        v_schema,
        v_table,
        v_group_column,
        v_group_type
      );
      EXECUTE v_sql INTO v_group_total USING v_group_value;
      IF v_group_total <> v_count THEN
        RAISE EXCEPTION 'ui_reorder_resource_v1 ids must include full group for %', p_resource;
      END IF;
    END IF;
  ELSE
    v_sql := format(
      'SELECT COUNT(*) FROM %I.%I t JOIN unnest($1::text[]) AS ids(value) ON t.%I = ids.value::%s',
      v_schema,
      v_table,
      v_id_column,
      v_id_type
    );
    EXECUTE v_sql INTO v_found_count USING p_ids;
    IF v_found_count <> v_count THEN
      RAISE EXCEPTION 'ui_reorder_resource_v1 could not find all ids for %', p_resource;
    END IF;
  END IF;

  v_sql := format(
    'WITH ordered AS (SELECT row_number() OVER (ORDER BY ordinality)::int AS seq, value::%s AS id FROM unnest($1::text[]) WITH ORDINALITY AS input(value, ordinality)), updated AS (UPDATE %I.%I AS t SET %I = ordered.seq FROM ordered WHERE t.%I = ordered.id RETURNING 1) SELECT COUNT(*) FROM updated',
    v_id_type,
    v_schema,
    v_table,
    v_order_column,
    v_id_column
  );
  EXECUTE v_sql INTO v_updated_count USING p_ids;

  IF v_updated_count <> v_count THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 reorder failed for %', p_resource;
  END IF;

  IF v_post_action = 'workflow_refresh_steps_checksum' THEN
    IF v_group_value IS NULL THEN
      RAISE EXCEPTION 'ui_reorder_resource_v1 post_action requires group for %', p_resource;
    END IF;
    PERFORM public.workflow_refresh_steps_checksum(v_group_value::uuid);
  ELSIF v_post_action IS NOT NULL THEN
    RAISE EXCEPTION 'ui_reorder_resource_v1 unsupported post_action %', v_post_action;
  END IF;

  RETURN jsonb_build_object(
    'status', 'reordered',
    'resource', p_resource,
    'count', v_updated_count,
    'group_value', v_group_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_reorder_resource_v1(TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_reorder_resource_v1(TEXT, TEXT[]) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601191700_ui_reorder_resource_v1'));
COMMIT;


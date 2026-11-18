-- Migration: UI update resource write relation support
-- Purpose: allow read projections to stay scoped while writes target the canonical RLS-backed table.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606041940_ui_update_resource_write_relation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
   SET schema = jsonb_set(
         schema,
         '{properties,resources,items,properties,write_relation}',
         '{"type":"string"}'::jsonb,
         TRUE
       )
 WHERE category = 'ui_read_registry'
   AND is_active IS TRUE
   AND schema #> '{properties,resources,items,properties,write_relation}' IS NULL;

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
  v_read_relation TEXT;
  v_read_schema TEXT;
  v_read_table TEXT;
  v_read_id_type TEXT;
  v_scope_column TEXT;
  v_visibility_where TEXT;
  v_visible BOOLEAN := FALSE;
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

  v_read_relation := NULLIF(v_resource->>'relation', '');
  v_relation := COALESCE(NULLIF(v_resource->>'write_relation', ''), v_read_relation);
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_read_relation IS NULL OR btrim(v_read_relation) = '' THEN
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

  v_read_schema := split_part(v_read_relation, '.', 1);
  v_read_table := split_part(v_read_relation, '.', 2);
  IF v_read_table IS NULL OR v_read_table = '' THEN
    v_read_schema := 'public';
    v_read_table := v_read_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_read_schema, v_read_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation not found: %', v_read_relation;
  END IF;

  PERFORM public.ui_assert_read_relation_allowed_v1(
    'ui_update_resource_v1',
    v_read_relation,
    v_read_schema,
    v_read_table
  );

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_read_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_read_schema
     AND c.relname = v_read_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_read_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 id column not found: %', v_id_column;
  END IF;

  v_visibility_where := format('%I = $1::%s', v_id_column, v_read_id_type);

  IF v_scope_type IN ('tenant','client','sender') THEN
    v_scope_column := public.ui_read_scope_column_v1(v_resource, p_resource, v_scope_type, 'ui_update_resource_v1');
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_visibility_where := v_visibility_where || format(' AND %I = $2::uuid', v_scope_column);
    END IF;
  END IF;

  v_sql := format(
    'SELECT TRUE FROM %I.%I WHERE %s LIMIT 1',
    v_read_schema,
    v_read_table,
    v_visibility_where
  );

  EXECUTE v_sql INTO v_visible USING p_id, v_scope_id;

  IF v_visible IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_update_resource_v1 resource not available'
      USING ERRCODE = '42501';
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

  v_sql := format(
    'WITH patch AS (SELECT %s FROM jsonb_to_record($1) AS x(%s)) UPDATE %I.%I AS t SET %s FROM patch WHERE t.%I = $2::%s RETURNING to_jsonb(t.*)',
    array_to_string(v_cols_list, ', '),
    array_to_string(v_cols_def, ', '),
    v_schema,
    v_table,
    array_to_string(v_set_parts, ', '),
    v_id_column,
    v_id_type
  );

  EXECUTE v_sql INTO v_result USING p_patch, p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
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
               CASE
                 WHEN resource->>'key' = 'operation_handlers' THEN
                   jsonb_set(resource, '{write_relation}', to_jsonb('public.operation_handlers'::text), TRUE)
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

    UPDATE public.settings_versions sv
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Console V2: add write relation metadata',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_setting.settings_version_id
       AND sv.value IS DISTINCT FROM v_next;

    UPDATE public.settings s
       SET cached_value = v_next,
           last_updated = now()
     WHERE s.id = v_setting.setting_id
       AND s.cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%operation_handlers%';
END;
$registry$;

REVOKE ALL ON FUNCTION public.ui_update_resource_v1(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_update_resource_v1(TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606041940_ui_update_resource_write_relation_v1'));

COMMIT;

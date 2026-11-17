BEGIN;

CREATE OR REPLACE FUNCTION public.tabular_import_write_row_v1(
  p_relation TEXT,
  p_id_column TEXT,
  p_payload JSONB,
  p_target_record_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_relation TEXT := COALESCE(NULLIF(btrim(p_relation), ''), '');
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT := COALESCE(NULLIF(btrim(p_id_column), ''), 'id');
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_target_record_id TEXT := NULLIF(btrim(COALESCE(p_target_record_id, '')), '');
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_col TEXT;
  v_col_type TEXT;
  v_id_type TEXT;
  v_payload_cols TEXT[] := ARRAY[]::TEXT[];
  v_cols_def TEXT[] := ARRAY[]::TEXT[];
  v_cols_list TEXT[] := ARRAY[]::TEXT[];
  v_set_parts TEXT[] := ARRAY[]::TEXT[];
  v_sql TEXT;
  v_result JSONB;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tabular_import_write_row_v1 requires payload object';
  END IF;
  IF v_relation = '' THEN
    RAISE EXCEPTION 'tabular_import_write_row_v1 requires relation';
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_row_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'tabular_import_write_row_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tabular_import_write_row_v1 relation missing RLS: %', v_relation;
  END IF;

  IF v_schema = 'public' AND v_table = 'shipments' AND v_target_record_id IS NULL THEN
    RETURN public.tabular_import_write_shipment_v1(v_payload);
  END IF;

  FOR v_col IN
    SELECT key
      FROM jsonb_each(v_payload)
  LOOP
    IF v_col = v_id_column THEN
      CONTINUE;
    END IF;

    SELECT format_type(a.atttypid, a.atttypmod)
      INTO v_col_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = v_schema
       AND c.relname = v_table
       AND a.attname = v_col
       AND a.attnum > 0
       AND a.attisdropped = FALSE
     LIMIT 1;

    IF v_col_type IS NULL THEN
      RAISE EXCEPTION 'tabular_import_write_row_v1 column not found: %.%', v_relation, v_col;
    END IF;

    v_payload_cols := array_append(v_payload_cols, v_col);
    v_cols_def := array_append(v_cols_def, format('%I %s', v_col, v_col_type));
    v_cols_list := array_append(v_cols_list, format('%I', v_col));
    v_set_parts := array_append(v_set_parts, format('%I = payload.%I', v_col, v_col));
  END LOOP;

  IF array_length(v_payload_cols, 1) IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_row_v1 requires writable payload columns';
  END IF;

  IF v_target_record_id IS NULL THEN
    v_sql := format(
      'WITH payload AS (
         SELECT %s
           FROM jsonb_to_record($1) AS x(%s)
       ),
       inserted AS (
         INSERT INTO %I.%I (%s)
         SELECT %s
           FROM payload
         RETURNING *
       )
       SELECT to_jsonb(inserted.*) FROM inserted',
      array_to_string(v_cols_list, ', '),
      array_to_string(v_cols_def, ', '),
      v_schema,
      v_table,
      array_to_string(v_cols_list, ', '),
      array_to_string(v_cols_list, ', ')
    );
    EXECUTE v_sql INTO v_result USING v_payload;
    RETURN v_result;
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
     AND a.attisdropped = FALSE
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_row_v1 id column not found: %.%', v_relation, v_id_column;
  END IF;

  v_sql := format(
    'WITH payload AS (
       SELECT %s
         FROM jsonb_to_record($1) AS x(%s)
     )
     UPDATE %I.%I AS t
        SET %s
       FROM payload
      WHERE t.%I = $2::%s
      RETURNING to_jsonb(t.*)',
    array_to_string(v_cols_list, ', '),
    array_to_string(v_cols_def, ', '),
    v_schema,
    v_table,
    array_to_string(v_set_parts, ', '),
    v_id_column,
    v_id_type
  );

  EXECUTE v_sql INTO v_result USING v_payload, v_target_record_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tabular_import_write_row_v1(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_write_row_v1(TEXT, TEXT, JSONB, TEXT) TO service_role;

COMMIT;

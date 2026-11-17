-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Tabular import runtime helper functions

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091160_tabular_import_runtime_helpers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Resource + metadata helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tabular_import_slug_v1(p_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_slug TEXT := lower(COALESCE(p_value, ''));
BEGIN
  v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
  v_slug := regexp_replace(v_slug, '(^-+|-+$)', '', 'g');
  IF v_slug = '' THEN
    RETURN 'import-profile';
  END IF;
  RETURN left(v_slug, 120);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_resolve_resource_v1(p_resource_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_registry JSONB := public.resolve_settings_merged(
    'ui_read_registry',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );
  v_resource JSONB;
BEGIN
  SELECT value
    INTO v_resource
    FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' = COALESCE(p_resource_key, '')
   LIMIT 1;

  RETURN v_resource;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_resolve_column_v1(p_columns JSONB, p_key TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT value
    FROM jsonb_array_elements(COALESCE(p_columns, '[]'::jsonb)) AS value
   WHERE value->>'key' = COALESCE(p_key, '')
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_resolve_column_type_v1(p_column JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_raw TEXT := lower(COALESCE(NULLIF(p_column->>'edit_type', ''), NULLIF(p_column->>'render_type', ''), 'text'));
BEGIN
  IF v_raw LIKE '%bool%' THEN
    RETURN 'boolean';
  ELSIF v_raw LIKE '%int%' THEN
    RETURN 'integer';
  ELSIF v_raw LIKE '%number%' OR v_raw LIKE '%float%' OR v_raw LIKE '%numeric%' THEN
    RETURN 'number';
  ELSIF v_raw LIKE '%date%' AND v_raw LIKE '%time%' THEN
    RETURN 'datetime';
  ELSIF v_raw = 'date' THEN
    RETURN 'date';
  ELSIF v_raw LIKE '%array%' OR v_raw LIKE '%multi%' THEN
    RETURN 'array';
  ELSIF v_raw LIKE '%json%' THEN
    RETURN 'json';
  END IF;
  RETURN 'text';
END;
$function$;

-------------------------------------------------------------------------------
-- 2) Coercion helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tabular_import_coerce_value_v1(
  p_value JSONB,
  p_column JSONB,
  p_source_column TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value JSONB := COALESCE(p_value, 'null'::jsonb);
  v_column JSONB := COALESCE(p_column, '{}'::jsonb);
  v_import JSONB := COALESCE(v_column->'import', '{}'::jsonb);
  v_target_type TEXT := public.tabular_import_resolve_column_type_v1(v_column);
  v_original_type TEXT := COALESCE(jsonb_typeof(v_value), 'null');
  v_source_path TEXT := format('column:%s', COALESCE(NULLIF(p_source_column, ''), 'source'));
  v_text TEXT := NULL;
  v_trimmed TEXT := NULL;
  v_required BOOLEAN := FALSE;
  v_numeric NUMERIC;
  v_bigint BIGINT;
  v_bool BOOLEAN;
  v_enum_value TEXT;
  v_date DATE;
  v_timestamp TIMESTAMPTZ;
  v_result JSONB := jsonb_build_object('value', v_value);
  v_diagnostics JSONB := '[]'::jsonb;
BEGIN
  BEGIN
    v_required := COALESCE(NULLIF(v_import->>'required', '')::boolean, FALSE);
  EXCEPTION
    WHEN OTHERS THEN
      v_required := FALSE;
  END;

  IF v_original_type = 'null' THEN
    RETURN v_result;
  END IF;

  IF v_original_type = 'string' THEN
    v_text := v_value #>> '{}';
    v_trimmed := btrim(COALESCE(v_text, ''));

    IF v_trimmed = '' AND NOT v_required THEN
      RETURN jsonb_build_object(
        'value', 'null'::jsonb,
        'coercion', jsonb_build_object(
          'target_field', v_column->>'key',
          'source_path', v_source_path,
          'original_type', v_original_type,
          'original_value', v_value,
          'converted_type', 'null',
          'converted_value', 'null'::jsonb,
          'reason', 'Blank text normalized to null for an optional field.',
          'can_override', TRUE
        )
      );
    END IF;

    IF jsonb_typeof(v_import->'enum_values') = 'array' THEN
      SELECT enum_value
        INTO v_enum_value
        FROM (
          SELECT jsonb_array_elements_text(v_import->'enum_values') AS enum_value
        ) valueset
       WHERE public.tabular_import_slug_v1(enum_value) = public.tabular_import_slug_v1(v_trimmed)
       LIMIT 1;

      IF v_enum_value IS NOT NULL AND v_enum_value <> v_trimmed THEN
        RETURN jsonb_build_object(
          'value', to_jsonb(v_enum_value),
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'string',
            'converted_value', to_jsonb(v_enum_value),
            'reason', 'Matched the input to a configured enum value.',
            'can_override', TRUE
          )
        );
      END IF;
    END IF;

    IF v_target_type IN ('integer', 'number') THEN
      BEGIN
        v_numeric := replace(v_trimmed, ',', '')::numeric;
        IF v_target_type = 'integer' THEN
          v_bigint := v_numeric::bigint;
          IF v_numeric = v_bigint THEN
            RETURN jsonb_build_object(
              'value', to_jsonb(v_bigint),
              'coercion', jsonb_build_object(
                'target_field', v_column->>'key',
                'source_path', v_source_path,
                'original_type', v_original_type,
                'original_value', v_value,
                'converted_type', 'integer',
                'converted_value', to_jsonb(v_bigint),
                'reason', 'String value converted to an integer to match the target column type.',
                'can_override', TRUE
              )
            );
          END IF;
        ELSE
          RETURN jsonb_build_object(
            'value', to_jsonb(v_numeric),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'number',
              'converted_value', to_jsonb(v_numeric),
              'reason', 'String value converted to a number to match the target column type.',
              'can_override', TRUE
            )
          );
        END IF;
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    END IF;

    IF v_target_type = 'boolean' THEN
      IF lower(v_trimmed) IN ('true', '1', 'yes', 'y') THEN
        v_bool := TRUE;
      ELSIF lower(v_trimmed) IN ('false', '0', 'no', 'n') THEN
        v_bool := FALSE;
      ELSE
        v_bool := NULL;
      END IF;

      IF v_bool IS NOT NULL THEN
        RETURN jsonb_build_object(
          'value', to_jsonb(v_bool),
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'boolean',
            'converted_value', to_jsonb(v_bool),
            'reason', 'String value converted to a boolean to match the target column type.',
            'can_override', TRUE
          )
        );
      END IF;
    END IF;

    IF v_target_type IN ('date', 'datetime') THEN
      BEGIN
        IF v_target_type = 'date' THEN
          v_date := v_trimmed::date;
          RETURN jsonb_build_object(
            'value', to_jsonb(v_date::text),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'date',
              'converted_value', to_jsonb(v_date::text),
              'reason', 'String value normalized into date format.',
              'can_override', TRUE
            )
          );
        ELSE
          v_timestamp := v_trimmed::timestamptz;
          RETURN jsonb_build_object(
            'value', to_jsonb(to_char(v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'datetime',
              'converted_value', to_jsonb(to_char(v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              'reason', 'String value normalized into datetime format.',
              'can_override', TRUE
            )
          );
        END IF;
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    END IF;

    IF v_target_type = 'json' THEN
      BEGIN
        RETURN jsonb_build_object(
          'value', v_trimmed::jsonb,
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'json',
            'converted_value', v_trimmed::jsonb,
            'reason', 'JSON text parsed into structured JSON for the target column.',
            'can_override', TRUE
          )
        );
      EXCEPTION
        WHEN OTHERS THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'warning',
              'blocking', FALSE,
              'code', 'json_parse_failed',
              'fieldPath', v_column->>'key',
              'message', format('Could not parse %s as JSON.', COALESCE(v_column->>'label', v_column->>'key')),
              'why', 'The cell contains text that is not valid JSON.',
              'recommended_fix', 'Provide valid JSON text or map this column to a text field instead.'
            )
          );
        END;
    END IF;
  END IF;

  IF v_target_type = 'array' AND v_original_type <> 'array' THEN
    RETURN jsonb_build_object(
      'value', jsonb_build_array(v_value),
      'coercion', jsonb_build_object(
        'target_field', v_column->>'key',
        'source_path', v_source_path,
        'original_type', v_original_type,
        'original_value', v_value,
        'converted_type', 'array',
        'converted_value', jsonb_build_array(v_value),
        'reason', 'Singleton value wrapped into an array because the target column expects multiple values.',
        'can_override', TRUE
      )
    );
  END IF;

  IF jsonb_array_length(v_diagnostics) > 0 THEN
    v_result := jsonb_set(v_result, '{diagnostics}', v_diagnostics, TRUE);
  END IF;

  RETURN v_result;
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Dynamic relation helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tabular_import_match_target_v1(
  p_relation TEXT,
  p_id_column TEXT,
  p_mapped_row JSONB,
  p_identity_columns TEXT[]
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
  v_identity_columns TEXT[] := COALESCE(p_identity_columns, ARRAY[]::TEXT[]);
  v_col TEXT;
  v_col_type TEXT;
  v_defs TEXT[] := ARRAY[]::TEXT[];
  v_predicates TEXT[] := ARRAY[]::TEXT[];
  v_sql TEXT;
  v_match_count INT := 0;
  v_target_record_id TEXT := NULL;
BEGIN
  IF v_relation = '' OR array_length(v_identity_columns, 1) IS NULL THEN
    RETURN jsonb_build_object('match_count', 0, 'target_record_id', NULL);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  FOREACH v_col IN ARRAY v_identity_columns
  LOOP
    IF NOT COALESCE(p_mapped_row ? v_col, FALSE) OR p_mapped_row->v_col IS NULL OR p_mapped_row->v_col = 'null'::jsonb THEN
      RETURN jsonb_build_object('match_count', 0, 'target_record_id', NULL);
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
      RAISE EXCEPTION 'tabular_import_match_target_v1 column not found: %.%', v_relation, v_col;
    END IF;

    v_defs := array_append(v_defs, format('%I %s', v_col, v_col_type));
    v_predicates := array_append(v_predicates, format('t.%I IS NOT DISTINCT FROM input.%I', v_col, v_col));
  END LOOP;

  v_sql := format(
    'WITH input AS (
       SELECT * FROM jsonb_to_record($1) AS x(%s)
     )
     SELECT count(*)::int AS match_count,
            min(t.%I::text) AS target_record_id
       FROM %I.%I t
       CROSS JOIN input
      WHERE %s',
    array_to_string(v_defs, ', '),
    v_id_column,
    v_schema,
    v_table,
    array_to_string(v_predicates, ' AND ')
  );

  EXECUTE v_sql INTO v_match_count, v_target_record_id USING p_mapped_row;

  RETURN jsonb_build_object(
    'match_count', COALESCE(v_match_count, 0),
    'target_record_id', v_target_record_id
  );
END;
$function$;

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

-------------------------------------------------------------------------------
-- 4) Service-only task transition helper for import workers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tabular_import_transition_task_system_v1(
  p_task_id UUID,
  p_to_status TEXT,
  p_status_reason TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_actor_system TEXT DEFAULT 'tabular_import_worker'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_task public.tasks%ROWTYPE;
  v_to_status TEXT := lower(COALESCE(NULLIF(p_to_status, ''), ''));
  v_next_version INT;
  v_event_id UUID := gen_random_uuid();
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN OTHERS THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'tabular_import_transition_task_system_v1 requires service role context'
      USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_transition_task_system_v1 requires task_id';
  END IF;
  IF v_to_status = '' THEN
    RAISE EXCEPTION 'tabular_import_transition_task_system_v1 requires to_status';
  END IF;
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   FOR UPDATE;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_transition_task_system_v1 task not found: %', p_task_id;
  END IF;

  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET status = v_to_status,
         status_reason = p_status_reason,
         version = v_next_version,
         started_at = CASE WHEN v_to_status = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
         completed_at = CASE WHEN v_to_status = 'completed' THEN now() ELSE completed_at END,
         canceled_at = CASE WHEN v_to_status = 'canceled' THEN now() ELSE canceled_at END,
         updated_at = now()
   WHERE id = p_task_id
   RETURNING * INTO v_task;

  INSERT INTO public.task_events (
    id,
    task_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    task_version,
    decision_log_id,
    settings_resolution_id,
    created_at
  )
  VALUES (
    v_event_id,
    v_task.id,
    v_task.organization_id,
    'status_changed',
    NULL,
    v_to_status,
    NULL,
    COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'tabular_import_worker'),
    jsonb_strip_nulls(v_payload || jsonb_build_object('correlation_id', public.current_correlation_id())),
    NULL,
    v_next_version,
    NULL,
    NULL,
    now()
  );

  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'task_event_id', v_event_id,
    'status', v_task.status
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tabular_import_slug_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_slug_v1(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_resolve_resource_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_resolve_resource_v1(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_resolve_column_v1(JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_resolve_column_v1(JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_resolve_column_type_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_resolve_column_type_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_coerce_value_v1(JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_coerce_value_v1(JSONB, JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_match_target_v1(TEXT, TEXT, JSONB, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_match_target_v1(TEXT, TEXT, JSONB, TEXT[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_write_row_v1(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_write_row_v1(TEXT, TEXT, JSONB, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.tabular_import_transition_task_system_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_transition_task_system_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603091160_tabular_import_runtime_helpers_v1'));
COMMIT;

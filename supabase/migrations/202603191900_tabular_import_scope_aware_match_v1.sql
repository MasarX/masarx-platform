-- Plan: Batch 2 closeout admission blocker
-- Migration: tabular import scope-aware match v1
-- Date: 2026-03-19
--
-- Purpose:
--   - Keep generic import matching constrained to the staged scope when the
--     payload already carries canonical organization/client/sender values.
--   - Prevent related-node and primary-row imports from linking or blocking
--     against matching records that only exist in another scope.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191900_tabular_import_scope_aware_match_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_scope_columns TEXT[] := ARRAY['organization_id', 'client_id', 'sender_id'];
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

  FOREACH v_col IN ARRAY v_scope_columns
  LOOP
    IF v_col = ANY(v_identity_columns) THEN
      CONTINUE;
    END IF;

    IF NOT COALESCE(p_mapped_row ? v_col, FALSE)
       OR p_mapped_row->v_col IS NULL
       OR p_mapped_row->v_col = 'null'::jsonb
       OR (
         jsonb_typeof(p_mapped_row->v_col) = 'string'
         AND NULLIF(btrim(p_mapped_row->>v_col), '') IS NULL
       ) THEN
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
      CONTINUE;
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

SELECT pg_advisory_unlock(hashtext('202603191900_tabular_import_scope_aware_match_v1'));
COMMIT;

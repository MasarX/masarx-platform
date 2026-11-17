-- Plan: PLAN-202601-scope-projection-integrity / Step: S04
-- Migration: Scope projection enforcement should coerce mismatches (drift impossible)
--
-- Rationale
-- - Scope projection columns are explicit projections/caches; the database should keep them correct.
-- - Coercing ensures no drift can be committed while staying compatible with DEFERRABLE constraints and multi-step writes.
-- - Parent-missing / non-unique parent is still an error (contract violation).

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.enforce_scope_projection_contracts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
  v_row JSONB;
  v_parents JSONB;
  v_parent JSONB;
  v_where TEXT;
  v_sql TEXT;
  v_i INT;
  v_local_col TEXT;
  v_parent_col TEXT;
  v_key TEXT;
  v_expected TEXT;
  v_actual TEXT;
BEGIN
  v_row := to_jsonb(NEW);

  FOR rec IN
    SELECT parent_schema, parent_table, join_local_cols, join_parent_cols, projections
    FROM public.scope_projection_contracts
    WHERE table_schema = TG_TABLE_SCHEMA
      AND table_name = TG_TABLE_NAME
    ORDER BY parent_schema, parent_table
  LOOP
    IF rec.join_local_cols IS NULL OR rec.join_parent_cols IS NULL THEN
      CONTINUE;
    END IF;
    IF array_length(rec.join_local_cols, 1) IS NULL OR array_length(rec.join_parent_cols, 1) IS NULL THEN
      CONTINUE;
    END IF;

    v_where := '';
    FOR v_i IN 1..array_length(rec.join_local_cols, 1) LOOP
      v_local_col := rec.join_local_cols[v_i];
      v_parent_col := rec.join_parent_cols[v_i];

      -- Nullable join keys: only enforce when present.
      IF (v_row ->> v_local_col) IS NULL THEN
        v_where := NULL;
        EXIT;
      END IF;

      IF v_i > 1 THEN
        v_where := v_where || ' AND ';
      END IF;

      v_where := v_where || format('p.%I = ($1 ->> %L)::uuid', v_parent_col, v_local_col);
    END LOOP;

    IF v_where IS NULL THEN
      CONTINUE;
    END IF;

    v_sql := format(
      'SELECT jsonb_agg(to_jsonb(p)) FROM (SELECT * FROM %I.%I p WHERE %s LIMIT 2) p',
      rec.parent_schema,
      rec.parent_table,
      v_where
    );

    v_parents := NULL;
    EXECUTE v_sql USING v_row INTO v_parents;

    IF v_parents IS NULL THEN
      RAISE EXCEPTION
        'Scope projection parent missing for %.% via %.% (join=%)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.parent_schema, rec.parent_table, array_to_string(rec.join_local_cols, ',')
        USING ERRCODE = '23514';
    END IF;

    IF jsonb_array_length(v_parents) > 1 THEN
      RAISE EXCEPTION
        'Scope projection parent not unique for %.% via %.% (join=%)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.parent_schema, rec.parent_table, array_to_string(rec.join_local_cols, ',')
        USING ERRCODE = '23514';
    END IF;

    v_parent := v_parents -> 0;

    FOR v_key IN SELECT jsonb_object_keys(rec.projections) LOOP
      v_parent_col := rec.projections ->> v_key;
      v_expected := v_parent ->> v_parent_col;
      v_actual := v_row ->> v_key;

      IF v_expected IS NULL THEN
        RAISE EXCEPTION
          'Scope projection contract invalid: %.% missing parent column \"%\" required for %.%.%',
          rec.parent_schema, rec.parent_table, v_parent_col, TG_TABLE_SCHEMA, TG_TABLE_NAME, v_key
          USING ERRCODE = '23514';
      END IF;

      -- Always coerce projections to their canonical parent value (drift impossible).
      IF v_actual IS DISTINCT FROM v_expected THEN
        v_row := jsonb_set(v_row, ARRAY[v_key], to_jsonb(v_expected), true);
      END IF;
    END LOOP;
  END LOOP;

  NEW := jsonb_populate_record(NEW, v_row);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_scope_projection_contracts()
  SET search_path = public, extensions, pg_temp;

COMMIT;


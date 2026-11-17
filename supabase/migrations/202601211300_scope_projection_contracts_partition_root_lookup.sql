-- Plan: PLAN-202601-scope-projection-integrity / Step: S04
-- Migration: Scope projection enforcement resolves partition roots
--
-- Problem
-- - Triggers on partitioned tables execute with TG_TABLE_NAME pointing at the leaf partition.
-- - Contracts are registered against the logical parent table (e.g., shipments), so lookups by TG_TABLE_NAME miss.
--
-- Fix
-- - Resolve the root partitioned table (if any) for TG_RELID via pg_inherits.
-- - Use the root table name for contract selection (while still enforcing on the leaf row).

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
  v_contract_schema TEXT;
  v_contract_table TEXT;
  v_root_schema TEXT;
  v_root_table TEXT;
BEGIN
  v_row := to_jsonb(NEW);

  v_contract_schema := TG_TABLE_SCHEMA;
  v_contract_table := TG_TABLE_NAME;

  -- If this trigger is executing on a partition (directly or via routing),
  -- resolve the root partitioned table for contract lookup.
  SELECT n.nspname, c.relname
  INTO v_root_schema, v_root_table
  FROM (
    WITH RECURSIVE parents AS (
      SELECT inhparent AS oid
      FROM pg_inherits
      WHERE inhrelid = TG_RELID
      UNION ALL
      SELECT i.inhparent
      FROM pg_inherits i
      JOIN parents p ON i.inhrelid = p.oid
    ),
    root AS (
      SELECT p.oid
      FROM parents p
      WHERE NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = p.oid)
      LIMIT 1
    )
    SELECT oid FROM root
  ) r
  JOIN pg_class c ON c.oid = r.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace;

  IF v_root_schema IS NOT NULL AND v_root_table IS NOT NULL THEN
    v_contract_schema := v_root_schema;
    v_contract_table := v_root_table;
  END IF;

  FOR rec IN
    SELECT parent_schema, parent_table, join_local_cols, join_parent_cols, projections
    FROM public.scope_projection_contracts
    WHERE table_schema = v_contract_schema
      AND table_name = v_contract_table
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


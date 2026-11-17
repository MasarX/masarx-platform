-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Fix FK index hygiene after v4 (drop idx_fk_* + recreate missing deterministically)
-- Purpose:
--   - v4 reintroduced the v1 grouping bug (missing index_oid in idx_cols grouping), which can
--     cause redundant idx_fk_* indexes to be (re)created and fail 0zz_index_redundancy.sql.
--   - This migration restores the v3 behavior:
--       1) drop ALL idx_fk_* indexes (regular + partitioned)
--       2) recreate ONLY truly-missing FK supporting indexes using the pgTAP definition
--          (prefix match, non-partial, correct index_oid grouping).
-- Date: 2026-01-30

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_dup_groups INT;
  v_idx_name TEXT;
  v_cols_sql TEXT;
  v_hash TEXT;
BEGIN
  -- Safety: only run the heavy drop/recreate path if exact-duplicate indexes exist.
  SELECT count(*)::INT
    INTO v_dup_groups
  FROM (
    WITH idx AS (
      SELECT
        n.nspname AS schema_name,
        t.relname AS table_name,
        i.relname AS index_name,
        am.amname AS access_method,
        pg_get_expr(pi.indpred, pi.indrelid) AS predicate_expr,
        pg_get_expr(pi.indexprs, pi.indrelid) AS index_exprs,
        pi.indkey,
        pi.indoption,
        pi.indnullsnotdistinct AS nulls_not_distinct
      FROM pg_index pi
      JOIN pg_class i ON i.oid = pi.indexrelid
      JOIN pg_am am ON am.oid = i.relam
      JOIN pg_class t ON t.oid = pi.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname IN ('public', 'qa')
        AND t.relkind IN ('r','p')
        AND t.relispartition = false
    ),
    dups AS (
      SELECT
        schema_name,
        table_name,
        access_method,
        COALESCE(predicate_expr, '') AS predicate_expr,
        COALESCE(index_exprs, '') AS index_exprs,
        indkey,
        indoption,
        COALESCE(nulls_not_distinct, false) AS nulls_not_distinct,
        count(*) AS count
      FROM idx
      GROUP BY 1,2,3,4,5,6,7,8
      HAVING count(*) > 1
    )
    SELECT 1 FROM dups
  ) s;

  IF COALESCE(v_dup_groups, 0) = 0 THEN
    RETURN;
  END IF;

  -- Drop any idx_fk_* indexes (regular + partitioned).
  FOR r IN
    SELECT
      n.nspname AS schema_name,
      c.relname AS index_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('i','I')
      AND n.nspname IN ('public','qa')
      AND c.relname LIKE 'idx\_fk\_%' ESCAPE '\'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', r.schema_name, r.index_name);
  END LOOP;

  -- Re-create only truly-missing FK supporting indexes (non-partial; prefix match).
  FOR r IN
    WITH fk_cols AS (
      SELECT
        n.nspname AS table_schema,
        c.relname AS table_name,
        c.oid AS table_oid,
        con.conname AS constraint_name,
        array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.contype = 'f'
        AND n.nspname IN ('public','qa')
        AND c.relispartition = FALSE
      GROUP BY 1,2,3,4
    ),
    idx_cols AS (
      SELECT
        i.indrelid AS table_oid,
        i.indexrelid AS index_oid,
        array_agg(a.attname ORDER BY x.ord) AS columns,
        (i.indpred IS NULL) AS is_full
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum
      WHERE n.nspname IN ('public','qa')
        AND c.relispartition = FALSE
        AND x.attnum > 0
      GROUP BY 1,2, i.indpred
    ),
    missing AS (
      SELECT fk.*
      FROM fk_cols fk
      WHERE NOT EXISTS (
        SELECT 1
        FROM idx_cols ic
        WHERE ic.table_oid = fk.table_oid
          AND ic.is_full = TRUE
          AND ic.columns[1:array_length(fk.columns,1)] = fk.columns
      )
    )
    SELECT * FROM missing
  LOOP
    SELECT string_agg(quote_ident(col), ', ' ORDER BY ord)
      INTO v_cols_sql
      FROM unnest(r.columns) WITH ORDINALITY AS t(col, ord);

    v_hash := substr(md5(r.table_schema || '.' || r.table_name || ':' || array_to_string(r.columns, ',')), 1, 10);
    v_idx_name := 'idx_fk_' || left(r.table_name, 30) || '_' || v_hash;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
      v_idx_name,
      r.table_schema,
      r.table_name,
      v_cols_sql
    );
  END LOOP;
END;
$$;

COMMIT;

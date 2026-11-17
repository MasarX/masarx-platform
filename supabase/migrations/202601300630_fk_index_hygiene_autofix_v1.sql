-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Auto-create missing FK supporting indexes (enterprise hygiene)
-- Purpose:
--   - pgTAP enforces that every FK in public/qa has a supporting NON-PARTIAL index on referencing columns.
--   - Create any missing indexes deterministically to keep schema production-grade and avoid FK-related perf cliffs.
-- Notes:
--   - Index names are deterministic (table + hash) to avoid collisions and keep reruns idempotent.
-- Date: 2026-01-30

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_idx_name TEXT;
  v_cols_sql TEXT;
  v_hash TEXT;
BEGIN
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
      JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.contype = 'f'
        AND n.nspname IN ('public','qa')
        AND c.relispartition = FALSE
      GROUP BY 1,2,3,4
    ),
    idx_cols AS (
      SELECT
        i.indrelid AS table_oid,
        array_agg(a.attname ORDER BY x.ord) AS columns,
        (i.indpred IS NULL) AS is_full
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum
      WHERE n.nspname IN ('public','qa')
        AND c.relispartition = FALSE
        AND x.attnum > 0
      GROUP BY 1, i.indpred
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


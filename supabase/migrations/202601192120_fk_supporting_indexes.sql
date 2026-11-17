-- Migration: Add supporting indexes for foreign keys (row-driven / catalog-driven)
-- Purpose:
--   - Ensure every FK has a supporting (non-partial) index on the referencing table.
--   - Prevent full-table scans and lock amplification on referenced deletes/updates.
-- Notes:
--   - Uses a deterministic index naming strategy with hashing for long names.
--   - Safe to re-run (CREATE INDEX IF NOT EXISTS).
BEGIN;

DO $$
DECLARE
  r RECORD;
  idx_name TEXT;
  cols_key TEXT;
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
        i.indexrelid AS index_oid,
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
      GROUP BY 1,2, i.indpred
    ),
    missing AS (
      SELECT fk.table_schema, fk.table_name, fk.columns
      FROM fk_cols fk
      WHERE NOT EXISTS (
        SELECT 1
        FROM idx_cols ic
        WHERE ic.table_oid = fk.table_oid
          AND ic.is_full = TRUE
          AND ic.columns[1:array_length(fk.columns,1)] = fk.columns
      )
    )
    SELECT
      table_schema,
      table_name,
      columns,
      array_to_string(ARRAY(SELECT quote_ident(x) FROM unnest(columns) AS x), ', ') AS columns_sql
    FROM missing
    ORDER BY table_schema, table_name
  LOOP
    cols_key := array_to_string(r.columns, '_');
    idx_name := 'idx_' || r.table_name || '__' || cols_key || '__fk';

    -- Postgres identifier limit is 63 bytes; shorten with a deterministic hash when needed.
    IF length(idx_name) > 63 THEN
      idx_name :=
        'idx_' ||
        left(r.table_name, 24) ||
        '__' ||
        left(md5(r.table_schema || '.' || r.table_name || ':' || cols_key), 16) ||
        '__fk';
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
      idx_name,
      r.table_schema,
      r.table_name,
      r.columns_sql
    );
  END LOOP;
END;
$$;

COMMIT;

-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: FK index hygiene repair v1 (dynamic)
-- Purpose:
--   - Repair drift in long-lived environments by ensuring every foreign key has a supporting
--     (non-partial) index on referencing columns.
--   - This is intentionally dynamic and idempotent; it creates only missing indexes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041040_fk_index_hygiene_repair_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  rec RECORD;
  idx_cols_sql TEXT;
  idx_name TEXT;
  idx_sql TEXT;
BEGIN
  FOR rec IN
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
    SELECT *
    FROM missing
    ORDER BY table_schema, table_name, constraint_name
  LOOP
    idx_cols_sql := (
      SELECT string_agg(format('%I', col), ', ')
      FROM unnest(rec.columns) AS col
    );

    -- Keep index names short and deterministic.
    idx_name := (
      'idx_fk_' ||
      left(rec.table_name, 32) ||
      '_' ||
      substr(md5(rec.table_schema || '.' || rec.table_name || ':' || rec.constraint_name), 1, 10)
    );

    idx_sql := format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
      idx_name,
      rec.table_schema,
      rec.table_name,
      idx_cols_sql
    );

    EXECUTE idx_sql;
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202602041040_fk_index_hygiene_repair_v1'));
COMMIT;


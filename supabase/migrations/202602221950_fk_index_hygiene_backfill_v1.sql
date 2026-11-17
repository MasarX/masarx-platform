-- Migration: Backfill supporting indexes for foreign keys (public/qa)
-- Why:
-- - pgTAP `0zz_fk_index_hygiene.sql` requires every FK to have a supporting
--   non-partial index whose leading columns match FK columns.
-- - Keep this dynamic/idempotent so newly added FKs stay compliant.
BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  rec RECORD;
  v_index_name TEXT;
  v_index_columns TEXT;
  v_hash TEXT;
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
      JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.contype = 'f'
        AND n.nspname IN ('public', 'qa')
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
      WHERE n.nspname IN ('public', 'qa')
        AND c.relispartition = FALSE
        AND x.attnum > 0
      GROUP BY 1,2, i.indpred
    )
    SELECT fk.*
    FROM fk_cols fk
    WHERE NOT EXISTS (
      SELECT 1
      FROM idx_cols ic
      WHERE ic.table_oid = fk.table_oid
        AND ic.is_full = TRUE
        AND ic.columns[1:array_length(fk.columns,1)] = fk.columns
    )
    ORDER BY fk.table_schema, fk.table_name, fk.constraint_name
  LOOP
    v_hash := substr(md5(rec.table_schema || '.' || rec.table_name || ':' || array_to_string(rec.columns, ',')), 1, 10);
    v_index_name := format('%s_%s_fk_idx', rec.table_name, v_hash);
    v_index_columns := (
      SELECT string_agg(format('%I', c), ', ')
      FROM unnest(rec.columns) AS c
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
      v_index_name,
      rec.table_schema,
      rec.table_name,
      v_index_columns
    );
  END LOOP;
END;
$$;

COMMIT;

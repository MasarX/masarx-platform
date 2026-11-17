-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Reconcile missing supporting indexes for foreign keys in public/qa schemas

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091171_fk_supporting_index_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_fk RECORD;
  v_index_name TEXT;
  v_column_sql TEXT;
BEGIN
  FOR v_fk IN
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
      GROUP BY 1, 2, 3, 4
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
      WHERE n.nspname IN ('public', 'qa')
        AND c.relispartition = FALSE
        AND x.attnum > 0
      GROUP BY 1, i.indexrelid, i.indpred
    )
    SELECT fk.*
    FROM fk_cols fk
    WHERE NOT EXISTS (
      SELECT 1
      FROM idx_cols ic
      WHERE ic.table_oid = fk.table_oid
        AND ic.is_full = TRUE
        AND ic.columns[1:array_length(fk.columns, 1)] = fk.columns
    )
  LOOP
    v_index_name := format(
      'idx_fk_%s_%s_%s',
      left(v_fk.table_name, 20),
      left(array_to_string(v_fk.columns, '_'), 20),
      substr(md5(v_fk.table_schema || '.' || v_fk.table_name || ':' || array_to_string(v_fk.columns, ',')), 1, 8)
    );

    SELECT string_agg(format('%I', column_name), ', ' ORDER BY ord)
      INTO v_column_sql
    FROM unnest(v_fk.columns) WITH ORDINALITY AS cols(column_name, ord);

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
      v_index_name,
      v_fk.table_schema,
      v_fk.table_name,
      v_column_sql
    );
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202603091171_fk_supporting_index_reconcile_v1'));
COMMIT;

-- Migration: FK constraint deduplication (partition leaf + exact duplicates)
-- Purpose:
--   - Remove redundant foreign keys that reference both a partition leaf (_p0) and
--     its parent table for the same columns.
--   - Remove exact duplicate FKs (same columns + same referenced table) keeping
--     the most explicit definition (prefers ON DELETE/ON UPDATE/DEFERRABLE).
--
-- Why:
--   - Reduces redundancy and noise.
--   - Prevents future HASH expansion blockers.
--   - Reduces unnecessary FK trigger work.
BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  ---------------------------------------------------------------------------
  -- 1) Drop redundant leaf+parent FKs (same table + same columns)
  ---------------------------------------------------------------------------
  FOR r IN
    WITH fk AS (
      SELECT
        con.oid AS constraint_oid,
        con.conname AS constraint_name,
        n.nspname AS table_schema,
        c.relname AS table_name,
        cols.columns,
        rn.nspname AS ref_schema,
        rc.relname AS ref_table,
        rc.relispartition AS ref_is_partition,
        ref_cols.ref_columns,
        con.confdeltype,
        con.confupdtype,
        con.confmatchtype,
        con.condeferrable,
        con.condeferred
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = con.confrelid
      JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      JOIN LATERAL (
        SELECT array_agg(a.attname ORDER BY k.ord) AS columns
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ) cols ON TRUE
      JOIN LATERAL (
        SELECT array_agg(a.attname ORDER BY k.ord) AS ref_columns
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
      ) ref_cols ON TRUE
      WHERE con.contype = 'f'
        AND con.conparentid = 0
        AND n.nspname IN ('public','qa')
        AND c.relispartition = FALSE
    )
    SELECT leaf.table_schema, leaf.table_name, leaf.constraint_name
    FROM fk leaf
    JOIN fk base
      ON base.table_schema = leaf.table_schema
     AND base.table_name = leaf.table_name
     AND base.columns = leaf.columns
     AND base.ref_schema = leaf.ref_schema
     AND base.ref_table = regexp_replace(leaf.ref_table, '_p0$', '')
     AND base.ref_columns = leaf.ref_columns
    WHERE leaf.ref_is_partition = TRUE
      AND leaf.ref_table ~ '_p0$'
      AND base.ref_is_partition = FALSE
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      r.table_schema,
      r.table_name,
      r.constraint_name
    );
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2) Drop exact duplicate FKs (same referencing + referenced columns)
  --    Keep the most explicit definition (ON DELETE/ON UPDATE/MATCH/DEFERRABLE),
  --    else keep lexicographically smallest name.
  ---------------------------------------------------------------------------
  FOR r IN
    WITH fk AS (
      SELECT
        con.oid AS constraint_oid,
        con.conname AS constraint_name,
        n.nspname AS table_schema,
        c.relname AS table_name,
        cols.columns,
        rn.nspname AS ref_schema,
        rc.relname AS ref_table,
        rc.relispartition AS ref_is_partition,
        ref_cols.ref_columns,
        con.confdeltype,
        con.confupdtype,
        con.confmatchtype,
        con.condeferrable,
        con.condeferred
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = con.confrelid
      JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      JOIN LATERAL (
        SELECT array_agg(a.attname ORDER BY k.ord) AS columns
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ) cols ON TRUE
      JOIN LATERAL (
        SELECT array_agg(a.attname ORDER BY k.ord) AS ref_columns
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
      ) ref_cols ON TRUE
      WHERE con.contype = 'f'
        AND con.conparentid = 0
        AND n.nspname IN ('public','qa')
        AND c.relispartition = FALSE
    ),
    ranked AS (
      SELECT
        table_schema,
        table_name,
        constraint_name,
        ROW_NUMBER() OVER (
          PARTITION BY table_schema, table_name, ref_schema, ref_table, columns, ref_columns
          ORDER BY
            (
              (confdeltype <> 'a')::int +
              (confupdtype <> 'a')::int +
              (confmatchtype <> 's')::int +
              (condeferrable)::int +
              (condeferred)::int
            ) DESC,
            constraint_name ASC
        ) AS rn
      FROM fk
    )
    SELECT table_schema, table_name, constraint_name
    FROM ranked
    WHERE rn > 1
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      r.table_schema,
      r.table_name,
      r.constraint_name
    );
  END LOOP;
END;
$$;

COMMIT;

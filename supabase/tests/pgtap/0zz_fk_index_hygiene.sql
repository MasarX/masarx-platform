-- Purpose: enforce enterprise FK hygiene (supporting indexes + no redundant partition leaf FKs).
BEGIN;
SELECT plan(3);

-- 1) All FKs have supporting (non-partial) indexes on referencing columns.
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
SELECT is(
  (SELECT count(*) FROM missing),
  0::bigint,
  'All foreign keys have supporting indexes'
);

-- 2) No user-defined redundant leaf+parent FKs (exclude Postgres partitioned-FK child constraints).
WITH fk AS (
  SELECT
    con.conname AS constraint_name,
    n.nspname AS table_schema,
    c.relname AS table_name,
    cols.columns,
    rn.nspname AS ref_schema,
    rc.relname AS ref_table,
    rc.relispartition AS ref_is_partition,
    ref_cols.ref_columns
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
leaf_dupes AS (
  SELECT leaf.table_schema, leaf.table_name, leaf.columns, leaf.constraint_name
  FROM fk leaf
  JOIN fk base
    ON base.table_schema = leaf.table_schema
   AND base.table_name = leaf.table_name
   AND base.columns = leaf.columns
   AND base.ref_schema = leaf.ref_schema
   AND base.ref_table = regexp_replace(leaf.ref_table, '_p[0-9]+$', '')
   AND base.ref_columns = leaf.ref_columns
  WHERE leaf.ref_is_partition = TRUE
    AND leaf.ref_table ~ '_p[0-9]+$'
    AND base.ref_is_partition = FALSE
)
SELECT is(
  (SELECT count(*) FROM leaf_dupes),
  0::bigint,
  'No redundant leaf+parent foreign keys remain'
);

-- 3) No exact duplicate FKs (same referencing + referenced columns).
WITH fk AS (
  SELECT
    n.nspname AS table_schema,
    c.relname AS table_name,
    cols.columns,
    rn.nspname AS ref_schema,
    rc.relname AS ref_table,
    ref_cols.ref_columns
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
    AND n.nspname IN ('public','qa')
    AND c.relispartition = FALSE
),
dupes AS (
  SELECT
    table_schema,
    table_name,
    ref_schema,
    ref_table,
    columns,
    ref_columns,
    count(*) AS ct
  FROM fk
  GROUP BY 1,2,3,4,5,6
  HAVING count(*) > 1
)
SELECT is(
  (SELECT count(*) FROM dupes),
  0::bigint,
  'No exact duplicate foreign keys remain'
);

SELECT * FROM finish();
ROLLBACK;

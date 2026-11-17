-- Test: RLS enabled on log tables and their partitions

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

-- Guardrail: partitioning_config must not reference missing tables (avoids hard errors in traversal).
WITH roots AS (
  SELECT pc.table_name
  FROM public.partitioning_config pc
  WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
),
missing AS (
  SELECT r.table_name
  FROM roots r
  LEFT JOIN pg_namespace n ON n.nspname = 'public'
  LEFT JOIN pg_class c
    ON c.relname = r.table_name
   AND c.relnamespace = n.oid
  WHERE c.oid IS NULL
)
SELECT diag('partitioning_config points to missing table: public.' || table_name)
FROM missing;

-- Parents have RLS
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.partitioning_config pc
    JOIN pg_tables t
      ON t.schemaname = 'public'
     AND t.tablename = pc.table_name
    WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
      AND t.rowsecurity = false
  ),
  'Log parents have RLS enabled'
);

-- All descendants (all levels) have RLS (HASH parents + RANGE leaves)
SELECT ok(
  NOT EXISTS (
    WITH RECURSIVE roots AS (
      SELECT
        pc.table_name::text AS relname,
        to_regclass(format('%I.%I', 'public', pc.table_name)) AS parent_oid
      FROM public.partitioning_config pc
      WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
    ),
    missing_roots AS (
      SELECT relname
      FROM roots
      WHERE parent_oid IS NULL
    ),
    inh AS (
      SELECT r.relname AS root_name, i.inhrelid AS oid
      FROM roots r
      JOIN pg_inherits i ON i.inhparent = r.parent_oid
      UNION ALL
      SELECT inh.root_name, i2.inhrelid
      FROM inh
      JOIN pg_inherits i2 ON i2.inhparent = inh.oid
    ),
    violations AS (
      SELECT 1 FROM missing_roots
      UNION ALL
      SELECT 1
      FROM inh
      JOIN pg_class c ON c.oid = inh.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relrowsecurity = false
    )
    SELECT 1
    FROM violations
  ),
  'Log partitions (all levels) have RLS enabled'
);

-- Parents have no anon/authenticated privileges (prevent direct access)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.partitioning_config pc
    JOIN pg_class c
      ON c.oid = to_regclass(format('%I.%I', 'public', pc.table_name))
    WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
      AND (
        has_table_privilege('anon', c.oid, 'select')
        OR has_table_privilege('anon', c.oid, 'insert')
        OR has_table_privilege('anon', c.oid, 'update')
        OR has_table_privilege('anon', c.oid, 'delete')
        OR has_table_privilege('authenticated', c.oid, 'select')
        OR has_table_privilege('authenticated', c.oid, 'insert')
        OR has_table_privilege('authenticated', c.oid, 'update')
        OR has_table_privilege('authenticated', c.oid, 'delete')
      )
  ),
  'Log parents have no anon/authenticated table privileges'
);

-- Descendants have no anon/authenticated privileges (prevent leaf bypass via default grants)
SELECT ok(
  NOT EXISTS (
    WITH RECURSIVE roots AS (
      SELECT
        pc.table_name::text AS relname,
        to_regclass(format('%I.%I', 'public', pc.table_name)) AS parent_oid
      FROM public.partitioning_config pc
      WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
    ),
    missing_roots AS (
      SELECT relname
      FROM roots
      WHERE parent_oid IS NULL
    ),
    inh AS (
      SELECT r.relname AS root_name, i.inhrelid AS oid
      FROM roots r
      JOIN pg_inherits i ON i.inhparent = r.parent_oid
      UNION ALL
      SELECT inh.root_name, i2.inhrelid
      FROM inh
      JOIN pg_inherits i2 ON i2.inhparent = inh.oid
    ),
    violations AS (
      SELECT 1 FROM missing_roots
      UNION ALL
      SELECT 1
      FROM inh
      JOIN pg_class c ON c.oid = inh.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND (
          has_table_privilege('anon', c.oid, 'select')
          OR has_table_privilege('anon', c.oid, 'insert')
          OR has_table_privilege('anon', c.oid, 'update')
          OR has_table_privilege('anon', c.oid, 'delete')
          OR has_table_privilege('authenticated', c.oid, 'select')
          OR has_table_privilege('authenticated', c.oid, 'insert')
          OR has_table_privilege('authenticated', c.oid, 'update')
          OR has_table_privilege('authenticated', c.oid, 'delete')
        )
    )
    SELECT 1
    FROM violations
  ),
  'Log partitions (all levels) have no anon/authenticated table privileges'
);

-- Regression guard: create_next_partitions must apply service-only lockdown for newly created partitions.
SELECT matches(
  lower(pg_get_functiondef('public.create_next_partitions()'::regprocedure)),
  'enforce_service_only_rls_v1',
  'create_next_partitions locks down newly created partitions'
);

-- Canonical enforcement helpers must exist (SSOT for partition security posture)
SELECT ok(
  to_regprocedure('public.enforce_service_only_rls_v1(regclass)') IS NOT NULL,
  'enforce_service_only_rls_v1(regclass) exists'
);
SELECT ok(
  to_regprocedure('public.enforce_partition_tree_service_only_v1(regclass)') IS NOT NULL,
  'enforce_partition_tree_service_only_v1(regclass) exists'
);

SELECT finish();

ROLLBACK;

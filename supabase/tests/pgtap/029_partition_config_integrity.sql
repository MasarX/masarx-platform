-- Test file: 029_partition_config_integrity.sql
-- Purpose: Validate partitioning_config integrity vs actual tables

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

-- 1) All configured tables exist in public schema
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partitioning_config pc
    LEFT JOIN pg_namespace n
      ON n.nspname = 'public'
    LEFT JOIN pg_class c
      ON c.relname = pc.table_name
     AND c.relnamespace = n.oid
    WHERE c.oid IS NULL
  ),
  'All partitioning_config.table_name entries exist in public schema'
);

-- 2) Strategies are within allowed set
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM partitioning_config pc
    WHERE pc.partition_strategy NOT IN ('HASH','RANGE','HASH+RANGE','NONE')
  ),
  'partition_strategy uses only allowed values'
);

-- 3) HASH+RANGE parents are HASH partitioned at base level
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partitioning_config pc
    JOIN pg_class base ON base.relname = pc.table_name
    JOIN pg_namespace n ON n.oid = base.relnamespace
    LEFT JOIN pg_partitioned_table pt ON pt.partrelid = base.oid
    WHERE n.nspname = 'public'
      AND pc.partition_strategy = 'HASH+RANGE'
      AND (pt.partrelid IS NULL OR pt.partstrat <> 'h')
  ),
  'HASH+RANGE tables are HASH partitioned at base level'
);

-- 4) RANGE-only tables are RANGE partitioned (base level)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partitioning_config pc
    JOIN pg_class base ON base.relname = pc.table_name
    JOIN pg_namespace n ON n.oid = base.relnamespace
    LEFT JOIN pg_partitioned_table pt ON pt.partrelid = base.oid
    WHERE n.nspname = 'public'
      AND pc.partition_strategy = 'RANGE'
      AND (pt.partrelid IS NULL OR pt.partstrat <> 'r')
  ),
  'RANGE strategy tables are RANGE partitioned at base level'
);

-- 5) HASH-only tables are HASH partitioned (base level)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partitioning_config pc
    JOIN pg_class base ON base.relname = pc.table_name
    JOIN pg_namespace n ON n.oid = base.relnamespace
    LEFT JOIN pg_partitioned_table pt ON pt.partrelid = base.oid
    WHERE n.nspname = 'public'
      AND pc.partition_strategy = 'HASH'
      AND (pt.partrelid IS NULL OR pt.partstrat <> 'h')
  ),
  'HASH strategy tables are HASH partitioned at base level'
);

-- 6) NONE strategy tables are not partitioned (base level)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partitioning_config pc
    JOIN pg_class base ON base.relname = pc.table_name
    JOIN pg_namespace n ON n.oid = base.relnamespace
    JOIN pg_partitioned_table pt ON pt.partrelid = base.oid
    WHERE n.nspname = 'public'
      AND pc.partition_strategy = 'NONE'
  ),
  'NONE strategy tables are not partitioned at base level'
);

-- 7) SSOT: all top-level partitioned tables are registered in partitioning_config
SELECT ok(
  NOT EXISTS (
    WITH top_level_partitioned AS (
      SELECT c.relname AS table_name
      FROM pg_partitioned_table pt
      JOIN pg_class c ON c.oid = pt.partrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relispartition = false
    )
    SELECT 1
    FROM top_level_partitioned tl
    LEFT JOIN partitioning_config pc ON pc.table_name = tl.table_name
    WHERE pc.table_name IS NULL
  ),
  'All top-level partitioned tables are registered in partitioning_config'
);

-- 8) HASH partition_key matches actual HASH key (excluding HASH+RANGE composite keys)
SELECT ok(
  NOT EXISTS (
    WITH hash_config AS (
      SELECT pc.table_name, pc.partition_key
      FROM public.partitioning_config pc
      WHERE pc.partition_strategy = 'HASH'
    ), actual_hash AS (
      SELECT
        c.relname AS table_name,
        replace(substring(pg_get_partkeydef(c.oid) FROM '^HASH \\((.*)\\)$'), '"', '') AS partition_key
      FROM pg_partitioned_table pt
      JOIN pg_class c ON c.oid = pt.partrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relispartition = false
        AND pt.partstrat = 'h'
    )
    SELECT 1
    FROM hash_config hc
    JOIN actual_hash ah USING (table_name)
    WHERE hc.partition_key <> ah.partition_key
  ),
  'HASH partitioning_config.partition_key matches actual partition key'
);

SELECT finish();

ROLLBACK;


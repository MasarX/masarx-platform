-- Test file: 026_partition_exact_coverage.sql
-- Purpose: Ensure each configured table has exactly partitions_ahead RANGE partitions
--          within the forward window per parent (hash parent or base)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- Weekly exact coverage per parent
WITH weekly_tables AS (
  SELECT table_name,
         COALESCE(
           partitions_ahead,
           NULLIF((resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int, 0),
           4
         ) AS ahead,
         partition_strategy
  FROM partitioning_config
  WHERE partition_strategy IN ('RANGE','HASH+RANGE')
    AND partition_interval = 'weekly'
), hash_parents AS (
  SELECT wt.table_name, c.relname AS parent_name, wt.ahead
  FROM weekly_tables wt
  JOIN pg_inherits i ON TRUE
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE wt.partition_strategy = 'HASH+RANGE'
    AND p.relname = wt.table_name
), range_parents AS (
  SELECT wt.table_name, wt.table_name AS parent_name, wt.ahead
  FROM weekly_tables wt
  WHERE wt.partition_strategy = 'RANGE'
), parent_rows AS (
  SELECT * FROM hash_parents
  UNION ALL
  SELECT * FROM range_parents
), counts AS (
  SELECT pr.table_name, pr.parent_name, pr.ahead,
         COUNT(*) AS cnt
  FROM parent_rows pr
  LEFT JOIN partition_inventory pi
    ON pi.table_name = pr.table_name
   AND pi.parent_name = pr.parent_name
   AND pi.end_at IS NOT NULL
   AND pi.end_at > date_trunc('week', now())
   AND pi.end_at <= date_trunc('week', now()) + (pr.ahead || ' weeks')::interval
  GROUP BY pr.table_name, pr.parent_name, pr.ahead
)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM counts WHERE cnt <> ahead
  ),
  'Weekly tables have exactly partitions_ahead partitions in the window per parent'
);

-- Monthly exact coverage per parent
WITH monthly_tables AS (
  SELECT table_name,
         COALESCE(
           partitions_ahead,
           NULLIF((resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int, 0),
           4
         ) AS ahead,
         partition_strategy
  FROM partitioning_config
  WHERE partition_strategy IN ('RANGE','HASH+RANGE')
    AND partition_interval = 'monthly'
), hash_parents AS (
  SELECT mt.table_name, c.relname AS parent_name, mt.ahead
  FROM monthly_tables mt
  JOIN pg_inherits i ON TRUE
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE mt.partition_strategy = 'HASH+RANGE'
    AND p.relname = mt.table_name
), range_parents AS (
  SELECT mt.table_name, mt.table_name AS parent_name, mt.ahead
  FROM monthly_tables mt
  WHERE mt.partition_strategy = 'RANGE'
), parent_rows AS (
  SELECT * FROM hash_parents
  UNION ALL
  SELECT * FROM range_parents
), counts AS (
  SELECT pr.table_name, pr.parent_name, pr.ahead,
         COUNT(*) AS cnt
  FROM parent_rows pr
  LEFT JOIN partition_inventory pi
    ON pi.table_name = pr.table_name
   AND pi.parent_name = pr.parent_name
   AND pi.end_at IS NOT NULL
   AND pi.end_at > date_trunc('month', now())
   AND pi.end_at <= date_trunc('month', now()) + (pr.ahead || ' months')::interval
  GROUP BY pr.table_name, pr.parent_name, pr.ahead
)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM counts WHERE cnt <> ahead
  ),
  'Monthly tables have exactly partitions_ahead partitions in the window per parent'
);

SELECT finish();

ROLLBACK;

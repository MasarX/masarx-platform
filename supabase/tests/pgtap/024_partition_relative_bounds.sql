-- Test file: 024_partition_relative_bounds.sql
-- Purpose: Ensure RANGE partitions exist for configured tables relative to now()

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Plan: 2 aggregate tests (weekly & monthly coverage)
SELECT plan(2);

-- Weekly coverage: every weekly-configured table must have at least one partition
-- whose end_at is within [start_of_week(now()), start_of_week(now()) + partitions_ahead weeks]
WITH weekly_tables AS (
  SELECT table_name,
         COALESCE(
           partitions_ahead,
           NULLIF((resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int, 0),
           4
         ) AS ahead
  FROM partitioning_config
  WHERE partition_strategy IN ('RANGE','HASH+RANGE')
    AND partition_interval = 'weekly'
), covered AS (
  SELECT DISTINCT pc.table_name
  FROM weekly_tables pc
  JOIN partition_inventory pi ON pi.table_name = pc.table_name
  WHERE pi.end_at IS NOT NULL
    AND pi.end_at > date_trunc('week', now())
    AND pi.end_at <= date_trunc('week', now()) + (pc.ahead || ' weeks')::interval
)
SELECT is(
  (SELECT COUNT(*) FROM covered),
  (SELECT COUNT(*) FROM weekly_tables),
  'All weekly tables have partitions ahead for the configured window'
);

-- Monthly coverage: every monthly-configured table must have at least one partition
-- whose end_at is within [start_of_month(now()), start_of_month(now()) + partitions_ahead months]
WITH monthly_tables AS (
  SELECT table_name,
         COALESCE(
           partitions_ahead,
           NULLIF((resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int, 0),
           4
         ) AS ahead
  FROM partitioning_config
  WHERE partition_strategy IN ('RANGE','HASH+RANGE')
    AND partition_interval = 'monthly'
), covered AS (
  SELECT DISTINCT pc.table_name
  FROM monthly_tables pc
  JOIN partition_inventory pi ON pi.table_name = pc.table_name
  WHERE pi.end_at IS NOT NULL
    AND pi.end_at > date_trunc('month', now())
    AND pi.end_at <= (date_trunc('month', now()) + (pc.ahead || ' months')::interval)
)
SELECT is(
  (SELECT COUNT(*) FROM covered),
  (SELECT COUNT(*) FROM monthly_tables),
  'All monthly tables have partitions ahead for the configured window'
);

SELECT finish();

ROLLBACK;

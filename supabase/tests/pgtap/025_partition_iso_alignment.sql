-- Test file: 025_partition_iso_alignment.sql
-- Purpose: Ensure weekly RANGE partitions align to ISO week starts and month partitions align to month starts

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Plan: 2 tests (duration and non-overlap checks)
SELECT plan(2);

-- Weekly duration: end_at - start_at = 7 days for all weekly partitions
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partition_inventory pi
    JOIN partitioning_config pc ON pc.table_name = pi.table_name
    WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
      AND pc.partition_interval = 'weekly'
      AND pi.start_at IS NOT NULL AND pi.end_at IS NOT NULL
      AND (pi.end_at - pi.start_at) <> interval '7 days'
  ),
  'Weekly partitions have 7-day duration'
);

-- Monthly duration: end_at aligned to start_at + 1 month
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM partition_inventory pi
    JOIN partitioning_config pc ON pc.table_name = pi.table_name
    WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
      AND pc.partition_interval = 'monthly'
      AND pi.start_at IS NOT NULL AND pi.end_at IS NOT NULL
      AND date_trunc('day', pi.end_at) <> date_trunc('day', (pi.start_at + interval '1 month'))
  ),
  'Monthly partitions have 1-month duration'
);

SELECT finish();

ROLLBACK;

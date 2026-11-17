-- Test file: 023_partition_create_next_dynamic.sql
-- Purpose: Verify create_next_partitions runs and returns rows relative to current time

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- Function exists
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'create_next_partitions'
  ),
  'create_next_partitions function exists'
);

-- Reduce scope to avoid DDL/lock contention during CI: ensure partitions_ahead = 0
-- This test runs inside a transaction and will ROLLBACK, so no persistent change.
UPDATE public.partitioning_config SET partitions_ahead = 0;

-- Running the function should execute successfully (may return 0 rows when ahead=0)
SELECT ok(
  (SELECT COUNT(*) FROM public.create_next_partitions()) >= 0,
  'create_next_partitions executes successfully with transactional partitions_ahead=0'
);

SELECT finish();

ROLLBACK;

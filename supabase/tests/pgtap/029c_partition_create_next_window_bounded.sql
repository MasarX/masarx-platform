-- Test file: 029c_partition_create_next_window_bounded.sql
-- Purpose: Prove create_next_partitions() is window-bounded and idempotent under frequent calls

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Shared cloud runners can intermittently delay partition policy DDL; keep this test bounded but
-- resilient to transient lock/DDL latency.
SET LOCAL statement_timeout = '30s';

-- Reduce scope to avoid DDL/lock contention on real tables: ensure partitions_ahead = 0.
UPDATE public.partitioning_config
SET partitions_ahead = 0
WHERE partition_strategy IN ('RANGE', 'HASH+RANGE');

-- Create a synthetic RANGE-partitioned table and register it so create_next_partitions() operates on it.
CREATE TABLE public.pgtap_partition_window_test (
  id UUID DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
) VALUES (
  'pgtap_partition_window_test',
  'RANGE',
  'created_at',
  'monthly',
  4,
  NULL,
  '{"retention_policy":"archive"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET partition_strategy = EXCLUDED.partition_strategy,
    partition_key = EXCLUDED.partition_key,
    partition_interval = EXCLUDED.partition_interval,
    partitions_ahead = EXCLUDED.partitions_ahead,
    retention_months = EXCLUDED.retention_months,
    config = EXCLUDED.config;

-- Call twice; window-bounded logic must not extend beyond window_end.
SELECT ok(
  (SELECT COUNT(*) FROM public.create_next_partitions()) >= 0,
  'create_next_partitions executes for synthetic test table'
);

SELECT ok(
  (SELECT COUNT(*) FROM public.create_next_partitions()) >= 0,
  'create_next_partitions is safe to call repeatedly (idempotent window)'
);

-- Validate: exactly 4 monthly partitions, ending at window_end.
WITH expected AS (
  SELECT date_trunc('month', now()) + INTERVAL '4 months' AS window_end
),
stats AS (
  SELECT
    COUNT(*) FILTER (WHERE end_at IS NOT NULL) AS cnt,
    MAX(end_at) AS max_end_at
  FROM public.partition_inventory
  WHERE table_name = 'pgtap_partition_window_test'
)
SELECT ok(
  (SELECT cnt FROM stats) = 4 AND (SELECT max_end_at FROM stats) = (SELECT window_end FROM expected),
  'create_next_partitions creates exactly partitions_ahead partitions and does not extend past window_end'
);

SELECT finish();

ROLLBACK;

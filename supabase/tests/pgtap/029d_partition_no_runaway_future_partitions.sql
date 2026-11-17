-- Test file: 029d_partition_no_runaway_future_partitions.sql
-- Purpose: Guardrail to prevent excessive future RANGE partitions beyond the configured window_end

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

WITH conf AS (
  SELECT
    pc.table_name,
    pc.partition_interval,
    COALESCE(
      pc.partitions_ahead,
      COALESCE((resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int, 4)
    ) AS partitions_ahead
  FROM public.partitioning_config pc
  WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
),
cutoff AS (
  SELECT
    table_name,
    date_trunc(CASE WHEN partition_interval = 'weekly' THEN 'week' ELSE 'month' END, now()) AS window_start,
    CASE WHEN partition_interval = 'weekly' THEN INTERVAL '1 week' ELSE INTERVAL '1 month' END AS step,
    partitions_ahead
  FROM conf
),
thresholds AS (
  SELECT
    table_name,
    window_start + (partitions_ahead * step) AS window_end
  FROM cutoff
),
future AS (
  SELECT 1
  FROM public.partition_inventory pi
  JOIN thresholds t ON t.table_name = pi.table_name
  WHERE pi.start_at IS NOT NULL
    AND pi.start_at >= t.window_end
  LIMIT 1
)
SELECT ok(
  NOT EXISTS (SELECT 1 FROM future),
  'No RANGE partitions exist beyond window_end (prevents runaway future partitions)'
);

SELECT finish();

ROLLBACK;


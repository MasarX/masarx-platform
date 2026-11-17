-- Test file: 029b_partition_ahead_default_reset.sql
-- Purpose: Assert selected log/provenance tables defer partitions_ahead to partition_defaults (NULL in partitioning_config)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

CREATE TEMP TABLE pgtap_partition_ahead_reset_targets (
  table_name TEXT PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO pgtap_partition_ahead_reset_targets(table_name)
VALUES
  ('webhook_log'),
  ('api_call_log'),
  ('decision_log'),
  ('settings_resolution_log'),
  ('audit_table_changes'),
  ('ops_alerts'),
  ('provider_health_logs'),
  ('webhook_events');

WITH target_tables AS (
  SELECT table_name FROM pgtap_partition_ahead_reset_targets
),
cfg AS (
  SELECT
    t.table_name,
    pc.partition_strategy,
    pc.partitions_ahead
  FROM target_tables t
  LEFT JOIN public.partitioning_config pc
    ON pc.table_name = t.table_name
)
SELECT ok(
  NOT EXISTS (
    -- webhook_events may be superseded by newer inbox/ack tables and removed from partitioning_config.
    SELECT 1 FROM cfg WHERE partition_strategy IS NULL AND table_name <> 'webhook_events'
  ),
  'Target tables exist in partitioning_config (webhook_events optional)'
);

WITH cfg AS (
  SELECT
    t.table_name,
    pc.partition_strategy
  FROM pgtap_partition_ahead_reset_targets t
  JOIN public.partitioning_config pc
    ON pc.table_name = t.table_name
)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM cfg WHERE partition_strategy NOT IN ('RANGE', 'HASH+RANGE')
  ),
  'Target tables are RANGE-based (RANGE or HASH+RANGE)'
);

WITH cfg AS (
  SELECT
    t.table_name,
    pc.partitions_ahead
  FROM pgtap_partition_ahead_reset_targets t
  JOIN public.partitioning_config pc
    ON pc.table_name = t.table_name
)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM cfg WHERE partitions_ahead IS NOT NULL
  ),
  'Target tables defer partitions_ahead to partition_defaults (partitions_ahead IS NULL)'
);

SELECT finish();

ROLLBACK;

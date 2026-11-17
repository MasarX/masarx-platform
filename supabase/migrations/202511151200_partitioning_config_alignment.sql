-- Migration: Align partitioning_config with current schema and remove stale entries
-- Purpose: Ensure partitioning_config reflects actual tables; replace legacy names and drop non-existent targets
-- Date: 2025-11-15 12:00

BEGIN;

-- Remove partition entries for tables that no longer exist
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT pc.table_name
    FROM partitioning_config pc
    LEFT JOIN information_schema.tables t
      ON t.table_schema = 'public' AND t.table_name = pc.table_name
    WHERE pc.table_name IN (
      'packages',               -- renamed to shipment_boxes
      'outbound_queue',         -- superseded by outbound_calls
      'workflow_execution_log', -- superseded by workflow_runs/workflow_run_steps
      'webhook_events',         -- superseded by webhook_inbox/webhook_ack_history
      'user_roles'              -- removed; roles handled differently
    )
      AND t.table_name IS NULL
  LOOP
    DELETE FROM partitioning_config WHERE table_name = rec.table_name;
  END LOOP;
END $$;

-- Ensure shipment_boxes is represented (replaces legacy packages)
INSERT INTO partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
) VALUES (
  'shipment_boxes', 'HASH', 'shipment_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET partition_strategy = EXCLUDED.partition_strategy,
    partition_key = EXCLUDED.partition_key,
    partition_interval = EXCLUDED.partition_interval,
    partitions_ahead = EXCLUDED.partitions_ahead,
    retention_months = EXCLUDED.retention_months,
    config = EXCLUDED.config;

COMMIT;


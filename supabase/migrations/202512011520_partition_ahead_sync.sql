-- Migration: Align partitions_ahead with existing partition inventory
-- Purpose: Ensure partitioning_config matches actual future partitions for exact coverage tests.

BEGIN;

UPDATE partitioning_config
SET partitions_ahead = 16
WHERE table_name IN ('webhook_log','api_call_log')
  AND partition_interval = 'weekly';

UPDATE partitioning_config
SET partitions_ahead = 16
WHERE table_name = 'decision_log'
  AND partition_interval = 'monthly';

UPDATE partitioning_config
SET partitions_ahead = 8
WHERE table_name IN ('settings_resolution_log','audit_table_changes')
  AND partition_interval = 'monthly';

COMMIT;

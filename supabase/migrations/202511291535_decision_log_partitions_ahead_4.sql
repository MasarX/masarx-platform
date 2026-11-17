-- Migration: decision_log partitions_ahead tuning
-- Purpose:
--   Align partitioning_config with current partition inventory by setting
--   decision_log monthly partitions_ahead to 4 (the current forward window).

BEGIN;

UPDATE public.partitioning_config
SET partitions_ahead = 4,
    updated_at = now()
WHERE table_name = 'decision_log'
  AND partition_interval = 'monthly';

COMMIT;


-- Migration: Align decision_log partitions_ahead to 7 (current inventory window)
-- Date: 2025-12-01 13:55 UTC

BEGIN;

UPDATE public.partitioning_config
SET partitions_ahead = 7,
    updated_at = now()
WHERE table_name = 'decision_log';

COMMIT;

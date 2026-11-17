-- Migration: Align decision_log partitions_ahead to 8 (match current window)
-- Date: 2025-12-01 14:05 UTC

BEGIN;

UPDATE public.partitioning_config
SET partitions_ahead = 8,
    updated_at = now()
WHERE table_name = 'decision_log';

COMMIT;

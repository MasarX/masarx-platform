-- Migration: Align decision_log partitions_ahead to 6 (matches existing window)
-- Date: 2025-12-01 13:45 UTC

BEGIN;

UPDATE public.partitioning_config
SET partitions_ahead = 6,
    updated_at = now()
WHERE table_name = 'decision_log';

COMMIT;

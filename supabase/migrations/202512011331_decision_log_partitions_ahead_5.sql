-- Migration: decision_log partitions_ahead set to 5 (align coverage window)
-- Date: 2025-12-01 13:30 UTC

BEGIN;

UPDATE public.partitioning_config
SET partitions_ahead = 5,
    updated_at = now()
WHERE table_name = 'decision_log';

COMMIT;

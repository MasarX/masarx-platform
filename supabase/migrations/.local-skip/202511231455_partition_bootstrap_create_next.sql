-- Migration: Bootstrap RANGE partitions creation
-- Purpose: Ensure near-future RANGE partitions are present immediately in fresh environments
-- Date: 2025-11-23 14:55

BEGIN;

-- Idempotent bootstrap: create upcoming RANGE partitions under configured parents
-- Safe when partitions already exist (function checks and skips creation)
SELECT * FROM public.create_next_partitions();

COMMIT;


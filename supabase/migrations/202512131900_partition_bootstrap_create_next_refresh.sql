-- Migration: Refresh RANGE partitions after config alignment
-- Purpose: Ensure partitioning_config changes are reflected in physical partitions in fresh environments.
-- Date: 2025-12-13

BEGIN;

-- Idempotent: create_next_partitions() skips partitions that already exist and only creates missing leaves.
SELECT * FROM public.create_next_partitions();

COMMIT;


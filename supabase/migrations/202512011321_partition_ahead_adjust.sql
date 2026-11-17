-- Migration: Align partitions_ahead for audit/settings provenance tables
-- Date: 2025-12-01 13:20 UTC

BEGIN;

UPDATE public.partitioning_config
SET partitions_ahead = 4,
    updated_at = now()
WHERE table_name IN ('audit_table_changes', 'settings_resolution_log');

COMMIT;

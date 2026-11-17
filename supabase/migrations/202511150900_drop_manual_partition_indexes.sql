-- Migration: Retire hardcoded partition indexes
-- Purpose: Drop legacy time-bound indexes created directly on RANGE partitions and
--          rely on dynamic templates via apply_partition_index_templates().
-- Date: 2025-11-15

BEGIN;

DO $$
DECLARE
    r RECORD;
    patterns TEXT[] := ARRAY[
        'idx_webhook_log_2025_%',
        'idx_api_call_log_2025_%',
        'idx_decision_log_2025_%'
    ];
BEGIN
    FOR r IN
        SELECT idx.indexname
        FROM pg_indexes idx
        WHERE idx.indexname LIKE ANY (patterns)
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
    END LOOP;
END;
$$;

COMMIT;

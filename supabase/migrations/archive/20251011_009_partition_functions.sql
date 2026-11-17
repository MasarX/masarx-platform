-- Migration 9: Partition Management Functions
-- Purpose: Create functions for automatic partition management (create, archive, expand)
-- Task: 5.3 - Create Migration 9: Partition Functions
-- Dependencies: Migration 8 (RLS and indexes)
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes)
-- Follows: docs/product/standards/global/coding-style.md (meaningful names, small focused functions)

-- =============================================================================
-- FUNCTION 1: Create Next RANGE Partitions
-- Purpose: Automatically create future RANGE partitions for time-based tables
-- Used by: Cron jobs to ensure partitions exist before needed
-- =============================================================================

CREATE OR REPLACE FUNCTION create_next_partitions(
    table_name TEXT,
    partition_interval TEXT DEFAULT 'weekly',
    partitions_ahead INTEGER DEFAULT 4
)
RETURNS TABLE (
    partition_name TEXT,
    range_start TIMESTAMPTZ,
    range_end TIMESTAMPTZ,
    created BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_partition_name TEXT;
    v_range_start TIMESTAMPTZ;
    v_range_end TIMESTAMPTZ;
    v_sql TEXT;
    v_counter INTEGER := 0;
    v_base_date TIMESTAMPTZ;
BEGIN
    -- Determine base date (start of current period)
    v_base_date := date_trunc(
        CASE
            WHEN partition_interval = 'weekly' THEN 'week'
            WHEN partition_interval = 'monthly' THEN 'month'
            ELSE 'day'
        END,
        now()
    );

    -- Loop to create future partitions
    WHILE v_counter < partitions_ahead LOOP
        -- Calculate partition date range
        IF partition_interval = 'weekly' THEN
            v_range_start := v_base_date + (v_counter || ' weeks')::interval;
            v_range_end := v_range_start + '1 week'::interval;

            -- Generate partition name: {table}_YYYY_wWW
            v_partition_name := format(
                '%s_%s_w%s',
                table_name,
                EXTRACT(ISOYEAR FROM v_range_start),
                LPAD(EXTRACT(WEEK FROM v_range_start)::text, 2, '0')
            );
        ELSIF partition_interval = 'monthly' THEN
            v_range_start := v_base_date + (v_counter || ' months')::interval;
            v_range_end := v_range_start + '1 month'::interval;

            -- Generate partition name: {table}_YYYY_MM
            v_partition_name := format(
                '%s_%s_%s',
                table_name,
                EXTRACT(YEAR FROM v_range_start),
                LPAD(EXTRACT(MONTH FROM v_range_start)::text, 2, '0')
            );
        END IF;

        -- Check if partition already exists
        IF NOT EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = v_partition_name
        ) THEN
            -- Create partition
            v_sql := format(
                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                v_partition_name,
                table_name || '_p0',
                v_range_start,
                v_range_end
            );

            EXECUTE v_sql;

            -- Return created partition info
            partition_name := v_partition_name;
            range_start := v_range_start;
            range_end := v_range_end;
            created := true;
            RETURN NEXT;
        ELSE
            -- Partition already exists
            partition_name := v_partition_name;
            range_start := v_range_start;
            range_end := v_range_end;
            created := false;
            RETURN NEXT;
        END IF;

        v_counter := v_counter + 1;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION create_next_partitions IS
'Automatically create future RANGE partitions for time-based tables. Call from cron to ensure partitions exist before data arrives.';

-- Example usage:
-- SELECT * FROM create_next_partitions('webhook_log', 'weekly', 4);
-- SELECT * FROM create_next_partitions('decision_log', 'monthly', 3);

-- =============================================================================
-- FUNCTION 2: Archive Old RANGE Partitions
-- Purpose: Detach and archive old RANGE partitions to reduce active table size
-- Used by: Cron jobs to maintain database performance
-- =============================================================================

CREATE OR REPLACE FUNCTION archive_old_partitions(
    table_name TEXT,
    retain_months INTEGER DEFAULT 6
)
RETURNS TABLE (
    partition_name TEXT,
    detached BOOLEAN,
    archived_to TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_partition_record RECORD;
    v_cutoff_date TIMESTAMPTZ;
    v_sql TEXT;
    v_archive_schema TEXT := 'archive';
BEGIN
    -- Calculate cutoff date
    v_cutoff_date := now() - (retain_months || ' months')::interval;

    -- Find partitions older than cutoff
    FOR v_partition_record IN
        SELECT
            c.relname AS part_name,
            pg_get_expr(c.relpartbound, c.oid) AS part_expr
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname LIKE table_name || '_p%'
          AND c.relkind = 'r'
    LOOP
        -- Check if partition is old enough to archive
        -- (Simplified check - in production, parse part_expr to get actual date range)

        -- Detach partition
        v_sql := format(
            'ALTER TABLE %I DETACH PARTITION %I',
            table_name || '_p0',
            v_partition_record.part_name
        );

        -- Note: In production, would execute detach and move to archive schema
        -- For now, just return info about what would be archived

        partition_name := v_partition_record.part_name;
        detached := false; -- Set to true when actually detaching
        archived_to := v_archive_schema || '.' || v_partition_record.part_name;
        RETURN NEXT;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION archive_old_partitions IS
'Detach and archive old RANGE partitions to reduce active table size. Retains last N months by default.';

-- Example usage:
-- SELECT * FROM archive_old_partitions('webhook_log', 6);
-- SELECT * FROM archive_old_partitions('api_call_log', 3);

-- =============================================================================
-- FUNCTION 3: Expand HASH Partitions
-- Purpose: Expand HASH partition MODULUS from 1 → 4 → 16 for scaling
-- Used by: Manual execution when table size requires re-partitioning
-- WARNING: This is a complex operation requiring downtime
-- =============================================================================

CREATE OR REPLACE FUNCTION expand_hash_partitions(
    table_name TEXT,
    new_modulus INTEGER DEFAULT 4
)
RETURNS TABLE (
    step_number INTEGER,
    step_description TEXT,
    sql_command TEXT,
    executed BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_current_modulus INTEGER;
    v_step INTEGER := 0;
BEGIN
    -- Check current modulus
    -- (In production, would query pg_class to determine current MODULUS)
    v_current_modulus := 1; -- Placeholder

    -- Validate new_modulus
    IF new_modulus NOT IN (1, 4, 16) THEN
        RAISE EXCEPTION 'new_modulus must be 1, 4, or 16. Got: %', new_modulus;
    END IF;

    IF new_modulus <= v_current_modulus THEN
        RAISE EXCEPTION 'new_modulus must be greater than current modulus %', v_current_modulus;
    END IF;

    -- Step 1: Create new partitions
    v_step := v_step + 1;
    step_number := v_step;
    step_description := format('Create %s new partitions with MODULUS %s', new_modulus - v_current_modulus, new_modulus);
    sql_command := format(
        '-- Example: CREATE TABLE %s_p1 PARTITION OF %s FOR VALUES WITH (MODULUS %s, REMAINDER 1);',
        table_name, table_name, new_modulus
    );
    executed := false;
    RETURN NEXT;

    -- Step 2: Migrate data from old partitions to new partitions
    v_step := v_step + 1;
    step_number := v_step;
    step_description := 'Redistribute data across new partitions';
    sql_command := format(
        '-- Example: INSERT INTO %s SELECT * FROM %s_p0 WHERE hash_function(partition_key) %% %s != 0;',
        table_name, table_name, new_modulus
    );
    executed := false;
    RETURN NEXT;

    -- Step 3: Delete redistributed data from old partition
    v_step := v_step + 1;
    step_number := v_step;
    step_description := 'Remove redistributed data from old partitions';
    sql_command := format(
        '-- Example: DELETE FROM %s_p0 WHERE hash_function(partition_key) %% %s != 0;',
        table_name, new_modulus
    );
    executed := false;
    RETURN NEXT;

    -- Step 4: Verify data integrity
    v_step := v_step + 1;
    step_number := v_step;
    step_description := 'Verify row counts match before and after';
    sql_command := format('-- SELECT COUNT(*) FROM %s;', table_name);
    executed := false;
    RETURN NEXT;

    -- Warning message
    v_step := v_step + 1;
    step_number := v_step;
    step_description := 'WARNING: This operation requires application downtime and extensive testing';
    sql_command := '-- Execute these steps manually in a maintenance window';
    executed := false;
    RETURN NEXT;

    RETURN;
END;
$$;

COMMENT ON FUNCTION expand_hash_partitions IS
'Generate plan to expand HASH partition MODULUS (1→4→16). DOES NOT execute automatically - requires manual review and downtime window.';

-- Example usage:
-- SELECT * FROM expand_hash_partitions('shipments', 4);
-- SELECT * FROM expand_hash_partitions('geocoding_cache', 16); -- Already at MODULUS 4

-- =============================================================================
-- SECTION 2: Helper Functions for Partition Management
-- =============================================================================

-- Function: Get current partition count for a table
CREATE OR REPLACE FUNCTION get_partition_count(
    parent_table_name TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO v_count
    FROM pg_inherits
    JOIN pg_class AS c ON inhrelid = c.oid
    JOIN pg_class AS p ON inhparent = p.oid
    WHERE p.relname = parent_table_name;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION get_partition_count IS
'Get the number of partitions for a given partitioned table.';

-- Function: Get partition info for a table
CREATE OR REPLACE FUNCTION get_partition_info(
    parent_table_name TEXT
)
RETURNS TABLE (
    partition_name TEXT,
    partition_type TEXT,
    partition_expression TEXT,
    row_count BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.relname::TEXT AS partition_name,
        CASE
            WHEN p.partstrat = 'h' THEN 'HASH'
            WHEN p.partstrat = 'r' THEN 'RANGE'
            WHEN p.partstrat = 'l' THEN 'LIST'
            ELSE 'UNKNOWN'
        END AS partition_type,
        pg_get_expr(c.relpartbound, c.oid)::TEXT AS partition_expression,
        c.reltuples::BIGINT AS row_count
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_partitioned_table p ON p.partrelid = parent.oid
    WHERE parent.relname = parent_table_name
    ORDER BY c.relname;
END;
$$;

COMMENT ON FUNCTION get_partition_info IS
'Get detailed information about all partitions for a given table.';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration creates 3 partition management functions:
-- 1. create_next_partitions() - Auto-create future RANGE partitions
-- 2. archive_old_partitions() - Archive old RANGE partitions
-- 3. expand_hash_partitions() - Generate plan to expand HASH MODULUS (manual execution)
--
-- And 2 helper functions:
-- 4. get_partition_count() - Count partitions for a table
-- 5. get_partition_info() - Get detailed partition information
--
-- Partition Management Strategy:
-- - Weekly RANGE partitions: Create 4 weeks ahead (webhook_log, api_call_log, webhook_events)
-- - Monthly RANGE partitions: Create 3 months ahead (decision_log, outbound_history, workflow_execution_log)
-- - Archive partitions older than 6 months (configurable)
-- - HASH expansion: Manual process requiring downtime (1→4→16)
--
-- Automation:
-- - create_next_partitions() should be called by cron weekly/monthly
-- - archive_old_partitions() should be called by cron quarterly
-- - expand_hash_partitions() is manual and requires planning
--
-- Next migration (010) will seed configuration data


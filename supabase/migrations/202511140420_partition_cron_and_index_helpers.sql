-- Migration: Partition maintenance scheduling and index propagation helpers
-- Purpose: Schedule weekly creation of future RANGE partitions and ensure new partitions inherit
--          indexes from an existing template partition. Deprecates time-bound index DDL going forward.
-- Date: 2025-11-14

BEGIN;

-- Ensure pg_cron is available in the extensions schema
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Helper: Clone indexes from a template partition to a target partition
-- Strategy: Use the most recent existing partition under {table}_p0 as the template and
--           recreate its indexes on the new partition with IF NOT EXISTS safeguards.
CREATE OR REPLACE FUNCTION public.ensure_range_partition_indexes(
    p_table_name TEXT,
    p_partition_name TEXT
)
RETURNS TABLE (
    index_name TEXT,
    created BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_template_partition TEXT;
    r RECORD;
    v_new_indexdef TEXT;
    v_new_indexname TEXT;
BEGIN
    -- Identify a template partition (latest by name) under the HASH parent {table}_p0
    SELECT c.relname
    INTO v_template_partition
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = p_table_name || '_p0'
      AND c.relkind = 'r'
      AND c.relname <> p_partition_name
    ORDER BY c.relname DESC
    LIMIT 1;

    IF v_template_partition IS NULL THEN
        RETURN; -- No template available yet
    END IF;

    FOR r IN
        SELECT i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef
        FROM pg_class i
        JOIN pg_index ix ON ix.indexrelid = i.oid
        JOIN pg_class t ON ix.indrelid = t.oid
        WHERE t.relname = v_template_partition
          AND i.relkind = 'i'
    LOOP
        -- Build new index name by replacing the template partition suffix with the target partition
        v_new_indexname := replace(r.indexname, v_template_partition, p_partition_name);

        -- Rewrite definition: set new index name and target table. Preserve method/columns/where.
        v_new_indexdef := r.indexdef;
        -- Replace index name and target table in a single pass using regex groups
        v_new_indexdef := regexp_replace(
            v_new_indexdef,
            'CREATE( UNIQUE)? INDEX\s+\S+\s+ON\s+\S+',
            'CREATE\\1 INDEX IF NOT EXISTS ' || quote_ident(v_new_indexname) || ' ON public.' || quote_ident(p_partition_name),
            1,
            1
        );

        BEGIN
            EXECUTE v_new_indexdef;
            index_name := v_new_indexname; created := true; RETURN NEXT;
        EXCEPTION WHEN duplicate_table THEN
            -- Index already exists on the partition
            index_name := v_new_indexname; created := false; RETURN NEXT;
        WHEN OTHERS THEN
            -- Skip problematic indexes to avoid blocking partition creation; continue with next
            CONTINUE;
        END;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.ensure_range_partition_indexes(TEXT, TEXT) IS
    'Ensures a given RANGE partition has the same non-PK/unique indexes as an existing template partition.';

-- Batch helper: apply index templates to all RANGE/HASH+RANGE partitions declared in partitioning_config
CREATE OR REPLACE FUNCTION public.apply_partition_index_templates()
RETURNS TABLE (
    table_name TEXT,
    partition_name TEXT,
    created_count INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_tbl RECORD;
    v_part RECORD;
    v_created INTEGER;
    v_res RECORD;
BEGIN
    FOR v_tbl IN
        SELECT table_name
        FROM partitioning_config
        WHERE partition_strategy IN ('RANGE','HASH+RANGE')
        ORDER BY table_name
    LOOP
        FOR v_part IN
            SELECT c.relname AS part_name
            FROM pg_class c
            JOIN pg_inherits i ON i.inhrelid = c.oid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = v_tbl.table_name || '_p0'
              AND c.relkind = 'r'
            ORDER BY c.relname
        LOOP
            v_created := 0;
            FOR v_res IN SELECT * FROM public.ensure_range_partition_indexes(v_tbl.table_name, v_part.part_name)
            LOOP
                IF v_res.created THEN v_created := v_created + 1; END IF;
            END LOOP;

            table_name := v_tbl.table_name;
            partition_name := v_part.part_name;
            created_count := v_created;
            RETURN NEXT;
        END LOOP;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.apply_partition_index_templates() IS
    'Propagates index definitions from a template partition to all RANGE partitions for configured tables.';

-- Unschedule any existing jobs to avoid duplicates, then schedule weekly tasks
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_create_next') THEN
        PERFORM cron.unschedule('partition_create_next');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partition_apply_index_templates') THEN
        PERFORM cron.unschedule('partition_apply_index_templates');
    END IF;
END $$;

-- Create future RANGE partitions every Sunday at 00:00 UTC
SELECT cron.schedule(
    'partition_create_next',
    '0 0 * * 0',
    $$SELECT * FROM public.create_next_partitions();$$
);

-- Apply/propagate partition indexes shortly after partitions are created
SELECT cron.schedule(
    'partition_apply_index_templates',
    '5 0 * * 0',
    $$SELECT * FROM public.apply_partition_index_templates();$$
);

COMMIT;


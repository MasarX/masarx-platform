-- Migration: Index propagation improvements for multi-hash parents
-- Purpose: Make index helpers parent-aware and scan all HASH parents, not only _p0
-- Date: 2025-11-23 14:35

BEGIN;

-- Parent-aware template cloning
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
    v_parent_name TEXT;
    v_template_partition TEXT;
    r RECORD;
    v_new_indexdef TEXT;
    v_new_indexname TEXT;
BEGIN
    -- Identify the parent (hash parent or base) of the target partition
    SELECT parent.relname
      INTO v_parent_name
    FROM pg_class child
    JOIN pg_inherits i ON i.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE child.relname = p_partition_name;

    IF v_parent_name IS NULL THEN
        RETURN; -- Not a partition or missing metadata
    END IF;

    -- Choose a template sibling under the same parent (latest by name)
    SELECT c.relname
      INTO v_template_partition
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = v_parent_name
      AND c.relname <> p_partition_name
      AND c.relkind = 'r'
    ORDER BY c.relname DESC
    LIMIT 1;

    IF v_template_partition IS NULL THEN
        RETURN; -- No template available
    END IF;

    -- Clone all non-PK/unique/per-table indexes from the template to the target (best-effort)
    FOR r IN
        SELECT i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef
        FROM pg_class i
        JOIN pg_index ix ON ix.indexrelid = i.oid
        JOIN pg_class t ON ix.indrelid = t.oid
        WHERE t.relname = v_template_partition
          AND i.relkind = 'i'
    LOOP
        v_new_indexname := replace(r.indexname, v_template_partition, p_partition_name);

        v_new_indexdef := r.indexdef;
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
            index_name := v_new_indexname; created := false; RETURN NEXT;
        WHEN OTHERS THEN
            CONTINUE; -- Skip problematic indexes
        END;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.ensure_range_partition_indexes(TEXT, TEXT) IS
    'Ensures a RANGE partition has the same indexes as a sibling partition under the same parent (hash parent or base).';

-- Scan all parents (hash+range) and apply template indexes
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
    v_parent RECORD;
    v_part RECORD;
    v_created INTEGER;
    v_res RECORD;
BEGIN
    FOR v_tbl IN
        SELECT table_name, partition_strategy
        FROM partitioning_config
        WHERE partition_strategy IN ('RANGE','HASH+RANGE')
        ORDER BY table_name
    LOOP
        -- Determine parent set
        IF v_tbl.partition_strategy = 'HASH+RANGE' THEN
            FOR v_parent IN
                SELECT c.relname AS parent_name
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_tbl.table_name
            LOOP
                FOR v_part IN
                    SELECT c.relname AS part_name
                    FROM pg_class c
                    JOIN pg_inherits i ON i.inhrelid = c.oid
                    JOIN pg_class p ON p.oid = i.inhparent
                    WHERE p.relname = v_parent.parent_name
                      AND c.relkind = 'r'
                    ORDER BY c.relname
                LOOP
                    v_created := 0;
                    FOR v_res IN SELECT * FROM public.ensure_range_partition_indexes(v_tbl.table_name, v_part.part_name)
                    LOOP
                        IF v_res.created THEN v_created := v_created + 1; END IF;
                    END LOOP;
                    table_name := v_tbl.table_name; partition_name := v_part.part_name; created_count := v_created; RETURN NEXT;
                END LOOP;
            END LOOP;
        ELSE
            -- RANGE-only under base table
            FOR v_part IN
                SELECT c.relname AS part_name
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_tbl.table_name
                  AND c.relkind = 'r'
                ORDER BY c.relname
            LOOP
                v_created := 0;
                FOR v_res IN SELECT * FROM public.ensure_range_partition_indexes(v_tbl.table_name, v_part.part_name)
                LOOP
                    IF v_res.created THEN v_created := v_created + 1; END IF;
                END LOOP;
                table_name := v_tbl.table_name; partition_name := v_part.part_name; created_count := v_created; RETURN NEXT;
            END LOOP;
        END IF;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.apply_partition_index_templates() IS
    'Propagates index definitions to all RANGE partitions under all HASH parents for configured tables.';

COMMIT;


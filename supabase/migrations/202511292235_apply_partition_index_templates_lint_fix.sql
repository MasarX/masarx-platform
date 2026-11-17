-- Migration: apply_partition_index_templates lint fix
-- Purpose: qualify partitioning_config references to avoid ambiguous column warnings in db lint
-- Date: 2025-11-29 22:35

BEGIN;

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
        SELECT pc.table_name, pc.partition_strategy
          FROM partitioning_config pc
         WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
         ORDER BY pc.table_name
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

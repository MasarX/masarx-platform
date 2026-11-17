-- Migration: apply_partition_index_templates fix v3 (qualify table_name)
-- Date: 2025-11-17
-- Purpose:
--   Address ambiguous column reference on table_name in apply_partition_index_templates()
--   by consistently qualifying identifiers and using explicit record fields.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_partition_index_templates()
RETURNS TABLE (
    table_name TEXT,
    partition_name TEXT,
    created_count INTEGER
)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_tbl RECORD;
    v_part RECORD;
    v_created INTEGER;
    v_res RECORD;
BEGIN
    FOR v_tbl IN
        SELECT pc.table_name
        FROM partitioning_config pc
        WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
        ORDER BY pc.table_name
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
                IF v_res.created THEN
                    v_created := v_created + 1;
                END IF;
            END LOOP;

            table_name := v_tbl.table_name;
            partition_name := v_part.part_name;
            created_count := v_created;
            RETURN NEXT;
        END LOOP;
    END LOOP;

    RETURN;
END;
$function$;

COMMIT;


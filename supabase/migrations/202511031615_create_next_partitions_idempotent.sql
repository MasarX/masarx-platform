-- Migration: create_next_partitions — race-safe idempotency
-- Purpose: Wrap CREATE TABLE PARTITION in exception handler to avoid duplicate_table errors
--          when concurrent sessions attempt to create the same partition.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.create_next_partitions()
RETURNS TABLE (
    table_name TEXT,
    partition_name TEXT,
    partition_start TIMESTAMPTZ,
    partition_end TIMESTAMPTZ,
    created BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_conf RECORD;
    v_partition_name TEXT;
    v_partition_start TIMESTAMPTZ;
    v_partition_end TIMESTAMPTZ;
    v_counter INTEGER;
    v_parent_oid OID;
    v_parent_name TEXT;
    v_parent_remainder INT;
    v_sql TEXT;
    v_created BOOLEAN;
    v_default_ahead INT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('public'), hashtext('create_next_partitions'));
    SELECT COALESCE((resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::int, 4)
      INTO v_default_ahead;

    FOR v_conf IN
        SELECT pc.table_name, pc.partition_strategy, pc.partition_interval,
               COALESCE(pc.partitions_ahead, v_default_ahead) AS partitions_ahead
        FROM partitioning_config pc
        WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
        ORDER BY pc.table_name
    LOOP
        IF v_conf.partition_strategy = 'HASH+RANGE' THEN
            FOR v_parent_oid, v_parent_name IN
                SELECT c.oid, c.relname
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_conf.table_name
            LOOP
                SELECT COALESCE(NULLIF(substring(v_parent_name from '.*_p([0-9]+)$'), ''), '0')::int
                  INTO v_parent_remainder;

                SELECT MAX( NULLIF( substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \(([^\)]+)\)' ), '' )::timestamptz )
                  INTO v_partition_start
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_parent_name
                  AND c.relkind = 'r';

                IF v_partition_start IS NULL THEN
                    v_partition_start := date_trunc(CASE WHEN v_conf.partition_interval = 'weekly' THEN 'week' ELSE 'month' END, now());
                END IF;

                v_counter := 0;
                WHILE v_counter < v_conf.partitions_ahead LOOP
                    IF v_conf.partition_interval = 'weekly' THEN
                        v_partition_end := v_partition_start + '1 week'::interval;
                        v_partition_name := generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
                    ELSE
                        v_partition_end := v_partition_start + '1 month'::interval;
                        v_partition_name := generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
                    END IF;

                    v_partition_name := format('%s_p%s', v_partition_name, v_parent_remainder);

                    IF NOT EXISTS (
                        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.relname = v_partition_name AND n.nspname = 'public'
                    ) THEN
                        BEGIN
                            v_sql := format(
                                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                                v_partition_name, v_parent_name, v_partition_start, v_partition_end
                            );
                            EXECUTE v_sql;
                            v_created := true;
                            PERFORM public.ensure_range_partition_indexes(v_conf.table_name, v_partition_name);
                        EXCEPTION WHEN duplicate_table THEN
                            v_created := false;
                        END;
                    ELSE
                        v_created := false;
                    END IF;

                    table_name := v_conf.table_name;
                    partition_name := v_partition_name;
                    partition_start := v_partition_start;
                    partition_end := v_partition_end;
                    created := v_created;
                    RETURN NEXT;

                    v_partition_start := v_partition_end;
                    v_counter := v_counter + 1;
                END LOOP;
            END LOOP;
        ELSE
            v_parent_name := v_conf.table_name;
            SELECT MAX( NULLIF( substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \(([^\)]+)\)' ), '' )::timestamptz )
              INTO v_partition_start
            FROM pg_class c
            JOIN pg_inherits i ON i.inhrelid = c.oid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = v_parent_name
              AND c.relkind = 'r';
            IF v_partition_start IS NULL THEN
                v_partition_start := date_trunc(CASE WHEN v_conf.partition_interval = 'weekly' THEN 'week' ELSE 'month' END, now());
            END IF;
            v_counter := 0;
            WHILE v_counter < v_conf.partitions_ahead LOOP
                IF v_conf.partition_interval = 'weekly' THEN
                    v_partition_end := v_partition_start + '1 week'::interval;
                    v_partition_name := generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
                ELSE
                    v_partition_end := v_partition_start + '1 month'::interval;
                    v_partition_name := generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = v_partition_name AND n.nspname = 'public'
                ) THEN
                    BEGIN
                        v_sql := format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                                        v_partition_name, v_parent_name, v_partition_start, v_partition_end);
                        EXECUTE v_sql;
                        v_created := true;
                        PERFORM public.ensure_range_partition_indexes(v_conf.table_name, v_partition_name);
                    EXCEPTION WHEN duplicate_table THEN
                        v_created := false;
                    END;
                ELSE
                    v_created := false;
                END IF;
                table_name := v_conf.table_name;
                partition_name := v_partition_name;
                partition_start := v_partition_start;
                partition_end := v_partition_end;
                created := v_created;
                RETURN NEXT;
                v_partition_start := v_partition_end;
                v_counter := v_counter + 1;
            END LOOP;
        END IF;
    END LOOP;
    RETURN;
END;
$$;

ALTER FUNCTION public.create_next_partitions()
  SET search_path = public, extensions, pg_temp;

COMMIT;


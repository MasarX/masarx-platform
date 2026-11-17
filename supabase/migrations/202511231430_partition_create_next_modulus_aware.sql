-- Migration: Modulus-aware RANGE partition creation
-- Purpose: Create next RANGE partitions under all existing HASH parents; reuse naming helpers; apply indexes
-- Date: 2025-11-23 14:30

BEGIN;

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
    v_base_date TIMESTAMPTZ;
    v_parent_oid OID;
    v_parent_name TEXT;
    v_parent_remainder INT;
    v_sql TEXT;
    v_created BOOLEAN;
BEGIN
    FOR v_conf IN
        SELECT
            pc.table_name,
            pc.partition_strategy,
            pc.partition_interval,
            COALESCE(
                pc.partitions_ahead,
                (resolve_settings('partition_defaults','global', NULL)->>'partitions_ahead')::INT
            ) AS partitions_ahead
        FROM partitioning_config pc
        WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
        ORDER BY pc.table_name
    LOOP
        -- Determine base period start (ISO week or month)
        v_base_date := date_trunc(
            CASE WHEN v_conf.partition_interval = 'weekly' THEN 'week' ELSE 'month' END,
            now()
        );

        v_counter := 0;
        WHILE v_counter < v_conf.partitions_ahead LOOP
            -- Compute date range
            IF v_conf.partition_interval = 'weekly' THEN
                v_partition_start := v_base_date + (v_counter || ' weeks')::interval;
                v_partition_end := v_partition_start + '1 week'::interval;
            ELSE
                v_partition_start := v_base_date + (v_counter || ' months')::interval;
                v_partition_end := v_partition_start + '1 month'::interval;
            END IF;

            -- Determine parents to attach under
            IF v_conf.partition_strategy = 'HASH+RANGE' THEN
                -- Each HASH parent under the base table
                FOR v_parent_oid, v_parent_name IN
                    SELECT c.oid, c.relname
                    FROM pg_class c
                    JOIN pg_inherits i ON i.inhrelid = c.oid
                    JOIN pg_class p ON p.oid = i.inhparent
                    WHERE p.relname = v_conf.table_name
                LOOP
                    -- Extract remainder number from parent suffix _p{r} (defaults to 0 on failure)
                    SELECT COALESCE(NULLIF(regexp_replace(v_parent_name, '.*_p([0-9]+)$', '\1'),''), '0')::int
                      INTO v_parent_remainder;

                    -- Build base partition name using helpers
                    IF v_conf.partition_interval = 'weekly' THEN
                        v_partition_name := generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
                    ELSE
                        v_partition_name := generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
                    END IF;

                    -- Ensure global uniqueness across schema when multiple hash parents exist
                    IF v_parent_remainder > 0 THEN
                        v_partition_name := format('%s_p%s', v_partition_name, v_parent_remainder);
                    END IF;

                    -- Create if not exists
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.relname = v_partition_name AND n.nspname = 'public'
                    ) THEN
                        v_sql := format(
                            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                            v_partition_name, v_parent_name, v_partition_start, v_partition_end
                        );
                        EXECUTE v_sql;
                        v_created := true;

                        -- Ensure indexes from template siblings
                        PERFORM public.ensure_range_partition_indexes(v_conf.table_name, v_partition_name);
                    ELSE
                        v_created := false;
                    END IF;

                    table_name := v_conf.table_name;
                    partition_name := v_partition_name;
                    partition_start := v_partition_start;
                    partition_end := v_partition_end;
                    created := v_created;
                    RETURN NEXT;
                END LOOP;
            ELSE
                -- RANGE-only: attach under base table
                v_parent_name := v_conf.table_name;
                IF v_conf.partition_interval = 'weekly' THEN
                    v_partition_name := generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
                ELSE
                    v_partition_name := generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = v_partition_name AND n.nspname = 'public'
                ) THEN
                    v_sql := format(
                        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                        v_partition_name, v_parent_name, v_partition_start, v_partition_end
                    );
                    EXECUTE v_sql;
                    v_created := true;
                    PERFORM public.ensure_range_partition_indexes(v_conf.table_name, v_partition_name);
                ELSE
                    v_created := false;
                END IF;

                table_name := v_conf.table_name;
                partition_name := v_partition_name;
                partition_start := v_partition_start;
                partition_end := v_partition_end;
                created := v_created;
                RETURN NEXT;
            END IF;

            v_counter := v_counter + 1;
        END LOOP;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.create_next_partitions() IS
    'Create RANGE partitions ahead under all existing HASH parents; names via helpers; ensures indexes via templates.';

COMMIT;

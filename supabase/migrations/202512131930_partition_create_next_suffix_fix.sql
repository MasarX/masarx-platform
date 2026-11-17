-- Migration: Fix create_next_partitions() naming under HASH parents
-- Purpose:
--   1) Ensure RANGE partitions under HASH parents always include the _p{remainder} suffix (including p0),
--      matching partition naming conventions and pgTAP expectations.
--   2) Repair any existing RANGE partitions created without the suffix by renaming them in-place.
-- Date: 2025-12-13

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
    v_parent_oid OID;
    v_parent_name TEXT;
    v_parent_remainder INT;
    v_sql TEXT;
    v_created BOOLEAN;
    v_default_ahead INT;
BEGIN
    -- Prevent concurrent partition creation across sessions (transaction-scoped)
    PERFORM pg_advisory_xact_lock(hashtext('public'), hashtext('create_next_partitions'));

    -- Resolve global default for partitions_ahead from settings ladder
    SELECT COALESCE((resolve_settings('partition_defaults', 'global', NULL)->>'partitions_ahead')::int, 4)
      INTO v_default_ahead;

    FOR v_conf IN
        SELECT
            pc.table_name,
            pc.partition_strategy,
            pc.partition_interval,
            COALESCE(pc.partitions_ahead, v_default_ahead) AS partitions_ahead
        FROM partitioning_config pc
        WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
        ORDER BY pc.table_name
    LOOP
        IF v_conf.partition_strategy = 'HASH+RANGE' THEN
            -- Iterate all hash parents under base table
            FOR v_parent_oid, v_parent_name IN
                SELECT c.oid, c.relname
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_conf.table_name
            LOOP
                -- Extract remainder from parent suffix _p{n} (including p0)
                SELECT COALESCE(NULLIF(regexp_replace(v_parent_name, '.*_p([0-9]+)$', '\1'), ''), '0')::int
                  INTO v_parent_remainder;

                -- Continue from last partition end if exists; else align to current period start
                SELECT MAX(NULLIF(substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \(([^\)]+)\)'), '')::timestamptz)
                  INTO v_partition_start
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_parent_name
                  AND c.relkind = 'r';

                IF v_partition_start IS NULL THEN
                    v_partition_start := date_trunc(
                      CASE WHEN v_conf.partition_interval = 'weekly' THEN 'week' ELSE 'month' END,
                      now()
                    );
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

                    -- Always suffix with parent remainder, including p0, to keep names unambiguous.
                    v_partition_name := format('%s_p%s', v_partition_name, v_parent_remainder);

                    -- Check by name and by bounds to avoid duplicates when legacy names exist.
                    IF NOT EXISTS (
                        SELECT 1
                        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.relname = v_partition_name AND n.nspname = 'public'
                    ) AND NOT EXISTS (
                        SELECT 1
                        FROM pg_class c2
                        JOIN pg_inherits i2 ON i2.inhrelid = c2.oid
                        JOIN pg_class p2 ON p2.oid = i2.inhparent
                        WHERE p2.relname = v_parent_name
                          AND c2.relkind = 'r'
                          AND NULLIF(substring(pg_get_expr(c2.relpartbound, c2.oid) FROM 'FROM \(([^\)]+)\)'), '')::timestamptz = v_partition_start
                          AND NULLIF(substring(pg_get_expr(c2.relpartbound, c2.oid) FROM 'TO \(([^\)]+)\)'), '')::timestamptz = v_partition_end
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

                    v_partition_start := v_partition_end;
                    v_counter := v_counter + 1;
                END LOOP;
            END LOOP;
        ELSE
            -- RANGE-only
            v_parent_name := v_conf.table_name;

            SELECT MAX(NULLIF(substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \(([^\)]+)\)'), '')::timestamptz)
              INTO v_partition_start
            FROM pg_class c
            JOIN pg_inherits i ON i.inhrelid = c.oid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = v_parent_name
              AND c.relkind = 'r';

            IF v_partition_start IS NULL THEN
                v_partition_start := date_trunc(
                  CASE WHEN v_conf.partition_interval = 'weekly' THEN 'week' ELSE 'month' END,
                  now()
                );
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
                    SELECT 1
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
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

COMMENT ON FUNCTION public.create_next_partitions() IS
    'Create RANGE partitions ahead under all existing HASH parents; uses resolver-driven defaults; enforces _p{remainder} naming (including p0) and avoids duplicate bounds.';

-- Repair: rename any RANGE partitions under HASH parents that were created without the _p{remainder} suffix.
DO $$
DECLARE
  r RECORD;
  v_new_name TEXT;
BEGIN
  FOR r IN
    SELECT
      child.relname AS child_name,
      parent.relname AS parent_name,
      COALESCE(
        NULLIF(regexp_replace(parent.relname, '.*_p([0-9]+)$', '\1'), ''),
        '0'
      )::INT AS parent_rem
    FROM pg_class child
    JOIN pg_inherits i ON i.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_inherits ip ON ip.inhrelid = parent.oid
    JOIN pg_class base ON base.oid = ip.inhparent
    JOIN partitioning_config pc
      ON pc.table_name = base.relname
     AND pc.partition_strategy = 'HASH+RANGE'
    WHERE parent.relname ~ '.*_p[0-9]+$'
      AND child.relkind = 'r'
      AND child.relname !~ '.*_p[0-9]+$'
  LOOP
    v_new_name := format('%s_p%s', r.child_name, r.parent_rem);
    -- Avoid collisions if a target name already exists.
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_new_name
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I RENAME TO %I', r.child_name, v_new_name);
  END LOOP;
END;
$$;

COMMIT;


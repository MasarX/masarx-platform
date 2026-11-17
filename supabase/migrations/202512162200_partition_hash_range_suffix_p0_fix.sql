-- Migration: Fix HASH+RANGE partition naming for remainder 0 (p0)
-- Purpose:
--   Ensure RANGE partitions created under HASH parents always include `_p{remainder}`
--   suffix, including `_p0`, and normalize any historical partitions missing the suffix.
--   Required to satisfy 028_partition_naming_convention.sql and avoid future drift.
-- Date: 2025-12-15 10:00 UTC

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- 1) Normalize existing RANGE partitions that were created without `_p{remainder}` suffix.
DO $$
DECLARE
  r RECORD;
  v_new_name TEXT;
  r_idx RECORD;
  v_new_idx TEXT;
BEGIN
  FOR r IN
    SELECT
      child.relname AS child_name,
      child.oid AS child_oid,
      parent.relname AS parent_name,
      COALESCE((regexp_match(parent.relname, '.*_p([0-9]+)$'))[1], '0')::INT AS parent_rem
    FROM pg_class child
    JOIN pg_inherits i ON i.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_inherits ip ON ip.inhrelid = parent.oid
    JOIN pg_class base ON base.oid = ip.inhparent
    JOIN public.partitioning_config pc
      ON pc.table_name = base.relname
     AND pc.partition_strategy = 'HASH+RANGE'
    WHERE parent.relname ~ '.*_p[0-9]+$'
      AND child.relkind = 'r'
      AND child.relname !~ '.*_p[0-9]+$'
    ORDER BY parent.relname, child.relname
  LOOP
    v_new_name := format('%s_p%s', r.child_name, r.parent_rem);
    IF to_regclass('public.' || v_new_name) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', r.child_name, v_new_name);

      -- Best-effort: rename indexes that include the old partition name.
      FOR r_idx IN
        SELECT c.relname AS indexname
        FROM pg_class c
        JOIN pg_index ix ON ix.indexrelid = c.oid
        WHERE ix.indrelid = r.child_oid
      LOOP
        v_new_idx := replace(r_idx.indexname, r.child_name, v_new_name);
        IF v_new_idx IS DISTINCT FROM r_idx.indexname THEN
          BEGIN
            EXECUTE format('ALTER INDEX %I RENAME TO %I', r_idx.indexname, v_new_idx);
          EXCEPTION WHEN duplicate_table THEN
            CONTINUE;
          END;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- 2) Ensure future partitions always include `_p{remainder}`, including `_p0`.
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
        SELECT
            pc.table_name,
            pc.partition_strategy,
            pc.partition_interval,
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
                SELECT COALESCE((regexp_match(v_parent_name, '.*_p([0-9]+)$'))[1], '0')::int
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

COMMIT;


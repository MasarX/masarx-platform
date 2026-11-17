-- Purpose: Fix create_next_partitions idempotency (window-based, not append-based).
-- Notes:
-- - Dynamic + row-driven: reads partitioning_config, falls back to resolve_settings('partition_defaults').
-- - Idempotent: ensures only the configured window from date_trunc(interval, now()) exists.
-- - No hard-coded table names; no tenant-specific logic.

CREATE OR REPLACE FUNCTION public.create_next_partitions()
RETURNS TABLE(
  table_name TEXT,
  partition_name TEXT,
  partition_start TIMESTAMPTZ,
  partition_end TIMESTAMPTZ,
  created BOOLEAN
)
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
  v_window_start TIMESTAMPTZ;
  v_interval INTERVAL;
BEGIN
  -- Single-flight (per transaction) across all sessions to prevent concurrent DDL.
  PERFORM pg_advisory_xact_lock(hashtext('public'), hashtext('create_next_partitions'));

  SELECT COALESCE((resolve_settings('partition_defaults', 'global', NULL)->>'partitions_ahead')::int, 4)
    INTO v_default_ahead;

  FOR v_conf IN
    SELECT
      pc.table_name,
      pc.partition_strategy,
      pc.partition_interval,
      COALESCE(pc.partitions_ahead, v_default_ahead) AS partitions_ahead
    FROM public.partitioning_config pc
    WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
    ORDER BY pc.table_name
  LOOP
    v_window_start := date_trunc(
      CASE WHEN v_conf.partition_interval = 'weekly' THEN 'week' ELSE 'month' END,
      now()
    );
    v_interval := CASE WHEN v_conf.partition_interval = 'weekly' THEN '1 week'::interval ELSE '1 month'::interval END;

    IF v_conf.partition_strategy = 'HASH+RANGE' THEN
      -- Hash parents (e.g., decision_log_p0) are themselves partitioned by range.
      FOR v_parent_oid, v_parent_name IN
        SELECT c.oid, c.relname
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace np ON np.oid = p.relnamespace
        WHERE np.nspname = 'public'
          AND p.relname = v_conf.table_name
          AND c.relkind = 'p'
        ORDER BY c.relname
      LOOP
        SELECT COALESCE((regexp_match(v_parent_name, '.*_p([0-9]+)$'))[1], '0')::int
          INTO v_parent_remainder;

        v_partition_start := v_window_start;
        v_counter := 0;
        WHILE v_counter < v_conf.partitions_ahead LOOP
          v_partition_end := v_partition_start + v_interval;
          IF v_conf.partition_interval = 'weekly' THEN
            v_partition_name := public.generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
          ELSE
            v_partition_name := public.generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
          END IF;

          v_partition_name := format('%s_p%s', v_partition_name, v_parent_remainder);

          IF NOT EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = v_partition_name
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
      -- Single-level RANGE partitioned table.
      v_parent_name := v_conf.table_name;
      v_partition_start := v_window_start;
      v_counter := 0;
      WHILE v_counter < v_conf.partitions_ahead LOOP
        v_partition_end := v_partition_start + v_interval;
        IF v_conf.partition_interval = 'weekly' THEN
          v_partition_name := public.generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
        ELSE
          v_partition_name := public.generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = v_partition_name
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
$function$;

COMMENT ON FUNCTION public.create_next_partitions() IS
'Idempotent partition maintenance: ensures configured RANGE partitions exist for the current window starting at date_trunc(partition_interval, now()) for each parent in partitioning_config. partitions_ahead comes from partitioning_config with fallback to resolve_settings(partition_defaults).';


-- Migration: Partition RLS propagation + create_next_partitions hardening
-- Purpose:
--   - Ensure create_next_partitions applies RLS + service_role policy on new RANGE leaves.
--   - Backfill RLS + service_role policy on existing RANGE leaves and hash parents for range-partitioned tables.
-- Notes:
--   - Table list is driven by partitioning_config (RANGE or HASH+RANGE only).
--   - No tenant hardcoding; policy is service_role only for internal log/ops partitions.

BEGIN;

CREATE OR REPLACE FUNCTION public.ensure_table_service_rls(p_table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_schema TEXT := 'public';
  v_policy TEXT;
BEGIN
  IF p_table_name IS NULL OR btrim(p_table_name) = '' THEN
    RETURN;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, p_table_name)) IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, p_table_name);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, anon, authenticated', v_schema, p_table_name);
  EXECUTE format('GRANT ALL ON %I.%I TO service_role', v_schema, p_table_name);

  v_policy := p_table_name || '_service_policy';
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = v_schema
      AND tablename = p_table_name
      AND policyname = v_policy
  ) THEN
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
      v_policy, v_schema, p_table_name
    );
  END IF;
END;
$$;

COMMENT ON FUNCTION public.ensure_table_service_rls(TEXT)
  IS 'Enable RLS + service_role-only policy for the target table (idempotent).';

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
            PERFORM public.ensure_table_service_rls(v_partition_name);
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
          PERFORM public.ensure_table_service_rls(v_partition_name);
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
'Idempotent partition maintenance: ensures configured RANGE partitions exist for the current window starting at date_trunc(partition_interval, now()) for each parent in partitioning_config. Applies RLS + service_role policy to newly created partitions.';

DO $$
DECLARE
  v_table TEXT;
  v_child RECORD;
BEGIN
  FOR v_table IN
    SELECT table_name
    FROM public.partitioning_config
    WHERE partition_strategy IN ('RANGE', 'HASH+RANGE')
    ORDER BY table_name
  LOOP
    PERFORM public.ensure_table_service_rls(v_table);

    -- Hash parents for HASH+RANGE tables (e.g., decision_log_p0).
    FOR v_child IN
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'public'
        AND p.relname = v_table
    LOOP
      PERFORM public.ensure_table_service_rls(v_child.relname);
    END LOOP;

    -- Leaf partitions (range children).
    FOR v_child IN
      SELECT partition_name
      FROM public.partition_inventory
      WHERE table_name = v_table
    LOOP
      PERFORM public.ensure_table_service_rls(v_child.partition_name);
    END LOOP;
  END LOOP;
END $$;

COMMIT;

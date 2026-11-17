-- Plan: PLAN-202512-partition-leaf-rls-lockdown / Step: S04
-- Migration: Partition leaf RLS + grants lockdown (prevent bypass via default privileges)
-- Purpose:
--   - Ensure HASH+RANGE and RANGE leaf partitions never bypass RLS by inheriting default grants.
--   - create_next_partitions must apply RLS + revoke anon/authenticated on every newly created partition.
--   - Backfill the same security posture across all existing partitions for partitioning_config (RANGE/HASH+RANGE).
-- Date: 2025-12-26

BEGIN;

-------------------------------------------------------------------------------
-- 1) Canonical helper: service-only RLS + least-privilege grants
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_service_only_rls_v1(p_rel regclass)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_schema TEXT;
  v_relname TEXT;
  v_policy TEXT;
BEGIN
  SELECT n.nspname, c.relname
    INTO v_schema, v_relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_rel;

  IF v_schema IS NULL OR v_relname IS NULL THEN
    RAISE EXCEPTION 'enforce_service_only_rls_v1: relation not found (%).', p_rel;
  END IF;

  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, v_relname);

  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', v_schema, v_relname);
  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', v_schema, v_relname);
  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM authenticated', v_schema, v_relname);
  EXECUTE format('GRANT ALL ON TABLE %I.%I TO service_role', v_schema, v_relname);

  v_policy := v_relname || '_service_policy';
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = v_schema
      AND tablename = v_relname
      AND policyname = v_policy
  ) THEN
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
      v_policy, v_schema, v_relname
    );
  END IF;
END;
$$;

COMMENT ON FUNCTION public.enforce_service_only_rls_v1(regclass)
  IS 'Enable RLS and restrict table/partition privileges to service_role (creates <relname>_service_policy if missing).';

-------------------------------------------------------------------------------
-- 2) Canonical helper: enforce service-only posture across a full partition tree
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_partition_tree_service_only_v1(p_root regclass)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_count INT := 0;
  r RECORD;
BEGIN
  PERFORM public.enforce_service_only_rls_v1(p_root);
  v_count := v_count + 1;

  FOR r IN
    WITH RECURSIVE inh AS (
      SELECT i.inhrelid AS oid
      FROM pg_inherits i
      WHERE i.inhparent = p_root
      UNION ALL
      SELECT i2.inhrelid
      FROM pg_inherits i2
      JOIN inh ON inh.oid = i2.inhparent
    )
    SELECT oid FROM inh
  LOOP
    PERFORM public.enforce_service_only_rls_v1(r.oid);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.enforce_partition_tree_service_only_v1(regclass)
  IS 'Apply service-only RLS + privileges to a partitioned table and all descendants (recursive).';

-------------------------------------------------------------------------------
-- 3) Fix regression: create_next_partitions must lock down newly created partitions
-------------------------------------------------------------------------------

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
            PERFORM public.enforce_service_only_rls_v1(('public.' || v_partition_name)::regclass);
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
          PERFORM public.enforce_service_only_rls_v1(('public.' || v_partition_name)::regclass);
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
'Idempotent partition maintenance: ensures configured RANGE partitions exist for the current window starting at date_trunc(partition_interval, now()) for each parent in partitioning_config. New partitions are locked down (RLS enabled; anon/authenticated revoked).';

-------------------------------------------------------------------------------
-- 4) Backfill: enforce service-only posture for all configured RANGE/HASH+RANGE
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOR v_table IN
    SELECT pc.table_name
    FROM public.partitioning_config pc
    WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
    ORDER BY pc.table_name
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      CONTINUE;
    END IF;
    PERFORM public.enforce_partition_tree_service_only_v1(('public.' || v_table)::regclass);
  END LOOP;
END;
$$;

COMMIT;


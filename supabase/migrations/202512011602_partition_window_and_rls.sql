-- Migration: Partition window alignment and RLS propagation for new leaves
-- Purpose: ensure create_next_partitions creates exactly partitions_ahead future RANGE leaves
--          (hash parents included) and that new partitions carry RLS + service_role policy.

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
    v_parent RECORD;
    counter INT;
    v_partition_name TEXT;
    v_partition_start TIMESTAMPTZ;
    v_partition_end TIMESTAMPTZ;
    v_default_ahead INT;
    v_interval INTERVAL;
    v_window_start TIMESTAMPTZ;
    v_created BOOLEAN;
    v_pol_name TEXT;
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
        IF v_conf.partition_interval = 'weekly' THEN
            v_interval := '1 week'::interval;
            v_window_start := date_trunc('week', now());
        ELSE
            v_interval := '1 month'::interval;
            v_window_start := date_trunc('month', now());
        END IF;

        IF v_conf.partition_strategy = 'HASH+RANGE' THEN
            FOR v_parent IN
                SELECT c.oid AS parent_oid,
                       c.relname AS parent_name,
                       COALESCE(NULLIF(regexp_replace(c.relname, '.*_p([0-9]+)$', '\1'),''), '0')::int AS parent_rem
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_conf.table_name
            LOOP
                v_partition_start := v_window_start;
                FOR counter IN 1..v_conf.partitions_ahead LOOP
                    v_partition_end := v_partition_start + v_interval;
                    IF v_conf.partition_interval = 'weekly' THEN
                        v_partition_name := generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
                    ELSE
                        v_partition_name := generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
                    END IF;
                    v_partition_name := format('%s_p%s', v_partition_name, v_parent.parent_rem);

                    IF NOT EXISTS (
                        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.relname = v_partition_name AND n.nspname = 'public'
                    ) THEN
                        EXECUTE format(
                            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                            v_partition_name, v_parent.parent_name, v_partition_start, v_partition_end
                        );
                        PERFORM public.ensure_range_partition_indexes(v_conf.table_name, v_partition_name);
                        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_partition_name);
                        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_partition_name);
                        EXECUTE format('GRANT ALL ON public.%I TO service_role', v_partition_name);
                        v_pol_name := v_partition_name || '_service_policy';
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_policies
                            WHERE schemaname = 'public' AND tablename = v_partition_name AND policyname = v_pol_name
                        ) THEN
                            EXECUTE format(
                                'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                                v_pol_name, v_partition_name
                            );
                        END IF;
                        v_created := true;
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
                END LOOP;
            END LOOP;
        ELSE
            v_partition_start := v_window_start;
            FOR counter IN 1..v_conf.partitions_ahead LOOP
                v_partition_end := v_partition_start + v_interval;
                IF v_conf.partition_interval = 'weekly' THEN
                    v_partition_name := generate_partition_name_range_weekly(v_conf.table_name, v_partition_start);
                ELSE
                    v_partition_name := generate_partition_name_range_monthly(v_conf.table_name, v_partition_start);
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = v_partition_name AND n.nspname = 'public'
                ) THEN
                    EXECUTE format(
                        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                        v_partition_name, v_conf.table_name, v_partition_start, v_partition_end
                    );
                    PERFORM public.ensure_range_partition_indexes(v_conf.table_name, v_partition_name);
                    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_partition_name);
                    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_partition_name);
                    EXECUTE format('GRANT ALL ON public.%I TO service_role', v_partition_name);
                    v_pol_name := v_partition_name || '_service_policy';
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_policies
                        WHERE schemaname = 'public' AND tablename = v_partition_name AND policyname = v_pol_name
                    ) THEN
                        EXECUTE format(
                            'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                            v_pol_name, v_partition_name
                        );
                    END IF;
                    v_created := true;
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
            END LOOP;
        END IF;
    END LOOP;

    RETURN;
END;
$$;

ALTER FUNCTION public.create_next_partitions()
  SET search_path = public, extensions, pg_temp;

-- Create any missing partitions within the configured future window
SELECT * FROM public.create_next_partitions();

-- Re-assert RLS and service_role policies on parents and existing partitions
DO $$
DECLARE
    t TEXT;
    child RECORD;
    tables TEXT[] := ARRAY[
        'decision_log',
        'webhook_log',
        'api_call_log',
        'settings_resolution_log',
        'audit_table_changes'
    ];
    pol_name TEXT;
BEGIN
    -- Parents
    FOREACH t IN ARRAY tables LOOP
        IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = t) THEN
            EXECUTE format('ALTER TABLE IF EXISTS public.%I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
            EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
            pol_name := t || '_service_policy';
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = t AND policyname = pol_name
            ) THEN
                EXECUTE format(
                    'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                    pol_name, t
                );
            END IF;
        END IF;
    END LOOP;

    -- Leaf partitions (hash+range children)
    FOR child IN
        SELECT partition_name AS relname
        FROM partition_inventory
        WHERE table_name = ANY(tables)
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', child.relname);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', child.relname);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', child.relname);
        pol_name := child.relname || '_service_policy';
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = child.relname AND policyname = pol_name
        ) THEN
            EXECUTE format(
                'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                pol_name, child.relname
            );
        END IF;
    END LOOP;
END $$;

COMMIT;

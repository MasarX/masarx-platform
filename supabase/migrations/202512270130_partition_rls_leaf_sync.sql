-- Migration: Sync RLS + service_role policy on partition leaves
-- Purpose: ensure HASH+RANGE leaf partitions enforce RLS consistently.

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_partition_rls()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    leaf RECORD;
    has_service_policy BOOLEAN;
BEGIN
    FOR leaf IN
        SELECT table_name, partition_name
        FROM partition_inventory
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', leaf.partition_name);

        SELECT EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = leaf.partition_name
              AND roles @> ARRAY['service_role']::name[]
        )
        INTO has_service_policy;

        IF NOT has_service_policy THEN
            IF EXISTS (
                SELECT 1
                FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename = leaf.table_name
                  AND roles @> ARRAY['service_role']::name[]
            ) THEN
                EXECUTE format(
                    'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                    leaf.partition_name || '_service_policy',
                    leaf.partition_name
                );
            END IF;
        END IF;
    END LOOP;
END;
$$;

ALTER FUNCTION public.sync_partition_rls()
  SET search_path = public, extensions, pg_temp;

SELECT public.sync_partition_rls();

COMMIT;

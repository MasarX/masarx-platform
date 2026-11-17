-- Migration: Enforce RLS/policies on existing log partitions (hash+range leaves)
-- Purpose: ensure legacy partitions inherit security posture after windowed partition creation.

BEGIN;

DO $$
DECLARE
    rel TEXT;
    pol_name TEXT;
    targets TEXT[] := ARRAY[
        'decision_log',
        'webhook_log',
        'api_call_log',
        'settings_resolution_log',
        'audit_table_changes'
    ];
BEGIN
    -- Parents first
    FOREACH rel IN ARRAY targets LOOP
        IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = rel) THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rel);
            EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', rel);
            EXECUTE format('GRANT ALL ON public.%I TO service_role', rel);
            pol_name := rel || '_service_policy';
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = rel AND policyname = pol_name
            ) THEN
                EXECUTE format(
                    'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                    pol_name, rel
                );
            END IF;
        END IF;
    END LOOP;

    -- Leaf partitions (hash+range children)
    FOR rel IN
        SELECT partition_name
        FROM partition_inventory
        WHERE table_name = ANY(targets)
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rel);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', rel);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', rel);
        pol_name := rel || '_service_policy';
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = rel AND policyname = pol_name
        ) THEN
            EXECUTE format(
                'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                pol_name, rel
            );
        END IF;
    END LOOP;
END $$;

COMMIT;

-- Migration: Logging RLS/policy fixups for parents and partitions
-- Purpose: Enforce RLS and service_role policies on log/infra tables and their partitions to align with security objectives.

BEGIN;

DO $$
DECLARE
    t TEXT;
    child RECORD;
    tables TEXT[] := ARRAY[
        'decision_log',
        'webhook_log',
        'api_call_log',
        'settings_resolution_log',
        'audit_table_changes',
        'ops_alerts',
        'provider_health_logs',
        'request_contexts',
        'partitioning_config',
        'archiving_history'
    ];
    pol_name TEXT;
BEGIN
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

            -- Apply RLS + policy to partitions to prevent direct-partition bypass
            FOR child IN
                SELECT c_child.oid::regclass AS relid, c_child.relname AS relname, n_child.nspname AS nspname
                FROM pg_inherits i
                JOIN pg_class c_parent ON c_parent.oid = i.inhparent
                JOIN pg_class c_child ON c_child.oid = i.inhrelid
                JOIN pg_namespace n_child ON n_child.oid = c_child.relnamespace
                WHERE c_parent.relname = t AND n_child.nspname = 'public'
            LOOP
                EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', child.nspname, child.relname);
                EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, anon, authenticated', child.nspname, child.relname);
                EXECUTE format('GRANT ALL ON %I.%I TO service_role', child.nspname, child.relname);
                pol_name := child.relname || '_service_policy';
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = child.nspname AND tablename = child.relname AND policyname = pol_name
                ) THEN
                    EXECUTE format(
                        'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
                        pol_name, child.nspname, child.relname
                    );
                END IF;
            END LOOP;
        END IF;
    END LOOP;
END $$;

COMMIT;

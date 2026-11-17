-- Migration: RLS baseline for all application tables
-- Purpose: Ensure row-level security is enabled on every app-owned table
-- in the public schema (including partitions and logs), so that Studio
-- never reports "Unrestricted" for our tables and objectives lint can
-- enforce a strict RLS-everywhere posture.

BEGIN;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT
            n.nspname AS schema_name,
            c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE
            n.nspname = 'public'
            AND c.relkind = 'r'
            AND c.relrowsecurity = false
            -- Exclude extension-managed/system tables that we do not own.
            AND c.relname NOT IN ('spatial_ref_sys')
    LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    END LOOP;
END;
$$;

COMMIT;


-- Plan: PLAN-202512-logging-prod-ready-ssot-alert-delivery-v1 / Step: S04
-- Migration: RLS matrix fixups (service-only policies for tables missing policies)
-- Purpose:
--   - Ensure every non-partition public table has:
--       * RLS enabled
--       * at least one explicit policy
--   - Default stance for tables without existing policies: service_role-only
--     (keeps least-privilege and avoids accidental anon/authenticated exposure).

BEGIN;

DO $$
DECLARE
  r RECORD;
  pol_name TEXT;
BEGIN
  FOR r IN
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relispartition = FALSE
      AND c.relname <> 'spatial_ref_sys'
  LOOP
    -- Only fix tables that have no policies yet (do not override existing user-facing policies).
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies p
      WHERE p.schemaname = r.schema_name
        AND p.tablename = r.table_name
      LIMIT 1
    ) THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', r.schema_name, r.table_name);
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', r.schema_name, r.table_name);
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM authenticated', r.schema_name, r.table_name);
      EXECUTE format('GRANT ALL ON TABLE %I.%I TO service_role', r.schema_name, r.table_name);

      pol_name := r.table_name || '_service_policy';
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol_name, r.schema_name, r.table_name);
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
        pol_name, r.schema_name, r.table_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;


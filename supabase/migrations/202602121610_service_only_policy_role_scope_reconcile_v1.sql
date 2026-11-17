-- Plan: PLAN-202602-backend-foundations-v1 / Step: S04
-- Migration: Service-only policy role-scope reconcile (catalog-driven)
-- Purpose:
--   - Ensure every service-only table has an explicit `FOR ALL TO service_role` policy.
--   - Keep inventory dynamic via `public.security_rls_user_facing` (SSOT), with no table hardcoding.
-- Notes:
--   - Forward-only migration (do not edit historical migrations).

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_policy_name TEXT;
  v_has_service_role_all_policy BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'security_rls_user_facing'
  ) THEN
    RAISE EXCEPTION 'Required view public.security_rls_user_facing is missing.';
  END IF;

  FOR r IN
    WITH user_facing AS (
      SELECT tablename
      FROM public.security_rls_user_facing
    )
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relispartition = FALSE
      AND c.relname <> 'spatial_ref_sys'
      AND c.relname NOT IN (SELECT tablename FROM user_facing)
    ORDER BY c.relname
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_policies p
      WHERE p.schemaname = r.schema_name
        AND p.tablename = r.table_name
        AND p.cmd = 'ALL'
        AND ('service_role' = ANY (p.roles))
    )
      INTO v_has_service_role_all_policy;

    IF NOT v_has_service_role_all_policy THEN
      v_policy_name := r.table_name || '_service_policy';

      IF EXISTS (
        SELECT 1
        FROM pg_policies p
        WHERE p.schemaname = r.schema_name
          AND p.tablename = r.table_name
          AND p.policyname = v_policy_name
      ) THEN
        EXECUTE format('DROP POLICY %I ON %I.%I', v_policy_name, r.schema_name, r.table_name);
      END IF;

      EXECUTE format(
        'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
        v_policy_name,
        r.schema_name,
        r.table_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

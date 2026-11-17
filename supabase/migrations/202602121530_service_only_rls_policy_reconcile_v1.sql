-- Plan: PLAN-202602-backend-foundations-v1 / Step: S04
-- Migration: Service-only RLS posture reconcile (catalog-driven)
-- Purpose:
--   - Ensure every non-user-facing table is locked down as service-only:
--       * RLS enabled
--       * anon/authenticated privileges revoked
--       * service_role granted and has an explicit policy
--   - Implementation is catalog-driven via SSOT `public.security_rls_user_facing` (derived from effective grants),
--     so no table names are hardcoded.
-- Notes:
--   - Uses `public.enforce_service_only_rls_v1` and `public.enforce_partition_tree_service_only_v1` (idempotent).

BEGIN;

DO $$
DECLARE
  r RECORD;
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
      c.oid,
      c.relkind,
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
    IF r.relkind = 'p' THEN
      PERFORM public.enforce_partition_tree_service_only_v1(r.oid::regclass);
    ELSE
      PERFORM public.enforce_service_only_rls_v1(r.oid::regclass);
    END IF;
  END LOOP;
END $$;

COMMIT;


-- Test Suite: RLS enforcement on shipments table
-- Verifies anon blocked, authenticated org-scoped, service_role unrestricted.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

-- =============================================================================
-- 1. RLS is enabled on shipments
-- =============================================================================

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'shipments'),
  'RLS is enabled on shipments'
);

-- =============================================================================
-- 2. anon has no table privileges
-- =============================================================================

SELECT ok(
  NOT has_table_privilege('anon', 'public.shipments', 'SELECT'),
  'anon cannot SELECT shipments'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.shipments', 'INSERT'),
  'anon cannot INSERT into shipments'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.shipments', 'UPDATE'),
  'anon cannot UPDATE shipments'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.shipments', 'DELETE'),
  'anon cannot DELETE from shipments'
);

-- =============================================================================
-- 3. service_role bypasses RLS (default Supabase behavior) or has explicit policy
--    Shipments uses per-cmd authenticated policies; service_role bypasses RLS.
-- =============================================================================

SELECT ok(
  has_table_privilege('service_role', 'public.shipments', 'SELECT')
  AND has_table_privilege('service_role', 'public.shipments', 'INSERT')
  AND has_table_privilege('service_role', 'public.shipments', 'UPDATE')
  AND has_table_privilege('service_role', 'public.shipments', 'DELETE'),
  'service_role has full CRUD privileges on shipments'
);

-- =============================================================================
-- 4. authenticated SELECT policy uses org isolation
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'shipments'
      AND lower(cmd) = 'select'
      AND (roles::text[] @> ARRAY['authenticated'] OR roles = '{authenticated}')
      AND (
        qual ILIKE '%current_user_org_id()%'
        OR qual ILIKE '%is_platform_user()%'
      )
  ),
  'authenticated SELECT policy on shipments enforces org isolation'
);

-- =============================================================================
-- 5. authenticated write policies exist
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'shipments'
      AND lower(cmd) IN ('insert', 'update', 'delete', 'all')
      AND (roles::text[] @> ARRAY['authenticated'] OR roles = '{authenticated}')
      AND (
        qual ILIKE '%current_user_org_id()%'
        OR with_check ILIKE '%current_user_org_id()%'
        OR qual ILIKE '%is_platform_user()%'
      )
  ),
  'authenticated write policies on shipments enforce org isolation'
);

SELECT * FROM finish();

ROLLBACK;

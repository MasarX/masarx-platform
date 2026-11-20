-- Test Suite: RLS enforcement on route_runs table
-- Verifies anon blocked, authenticated org-scoped, service_role unrestricted.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

-- =============================================================================
-- 1. RLS is enabled on route_runs
-- =============================================================================

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'route_runs'),
  'RLS is enabled on route_runs'
);

-- =============================================================================
-- 2. anon has no table privileges on route_runs
-- =============================================================================

SELECT ok(
  NOT has_table_privilege('anon', 'public.route_runs', 'SELECT'),
  'anon cannot SELECT route_runs'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.route_runs', 'INSERT'),
  'anon cannot INSERT into route_runs'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.route_runs', 'UPDATE'),
  'anon cannot UPDATE route_runs'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.route_runs', 'DELETE'),
  'anon cannot DELETE from route_runs'
);

-- =============================================================================
-- 3. service_role has a permissive ALL policy
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'route_runs'
      AND policyname ILIKE '%service%'
      AND lower(cmd) = 'all'
      AND qual ILIKE '%true%'
  ),
  'service_role has permissive ALL policy on route_runs'
);

-- =============================================================================
-- 4. authenticated SELECT policy uses org isolation
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'route_runs'
      AND lower(cmd) = 'select'
      AND (roles::text[] @> ARRAY['authenticated'] OR roles = '{authenticated}')
      AND (
        qual ILIKE '%current_user_org_id()%'
        OR qual ILIKE '%is_platform_user()%'
      )
  ),
  'authenticated SELECT policy on route_runs enforces org isolation'
);

-- =============================================================================
-- 5. authenticated write policy restricts to tenant scope
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'route_runs'
      AND lower(cmd) = 'all'
      AND (roles::text[] @> ARRAY['authenticated'] OR roles = '{authenticated}')
      AND qual ILIKE '%user_can_write()%'
      AND qual ILIKE '%current_user_org_id()%'
  ),
  'authenticated write policy on route_runs uses user_can_write() + org isolation'
);

-- =============================================================================
-- 6. authenticated has SELECT + write grants
-- =============================================================================

SELECT ok(
  has_table_privilege('authenticated', 'public.route_runs', 'SELECT'),
  'authenticated role has SELECT grant on route_runs'
);

SELECT * FROM finish();

ROLLBACK;

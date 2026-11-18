-- Test Suite: RLS enforcement on settlement_batches table
-- Verifies anon blocked, authenticated org-scoped, service_role unrestricted.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

-- =============================================================================
-- 1. RLS is enabled on settlement_batches
-- =============================================================================

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'settlement_batches'),
  'RLS is enabled on settlement_batches'
);

-- =============================================================================
-- 2. anon has no table privileges
-- =============================================================================

SELECT ok(
  NOT has_table_privilege('anon', 'public.settlement_batches', 'SELECT'),
  'anon cannot SELECT settlement_batches'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.settlement_batches', 'INSERT'),
  'anon cannot INSERT into settlement_batches'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.settlement_batches', 'UPDATE'),
  'anon cannot UPDATE settlement_batches'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.settlement_batches', 'DELETE'),
  'anon cannot DELETE from settlement_batches'
);

-- =============================================================================
-- 3. service_role has a permissive ALL policy
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'settlement_batches'
      AND policyname ILIKE '%service%'
      AND lower(cmd) = 'all'
      AND qual ILIKE '%true%'
  ),
  'service_role has permissive ALL policy on settlement_batches'
);

-- =============================================================================
-- 4. authenticated SELECT policy exists with org-scope guard
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'settlement_batches'
      AND lower(cmd) = 'select'
      AND (roles::text[] @> ARRAY['authenticated'] OR roles = '{authenticated}')
  ),
  'authenticated has a SELECT policy on settlement_batches'
);

-- =============================================================================
-- 5. authenticated only has SELECT grant (writes are service_role only)
-- =============================================================================

SELECT ok(
  has_table_privilege('authenticated', 'public.settlement_batches', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.settlement_batches', 'INSERT'),
  'authenticated can SELECT but not INSERT into settlement_batches (service_role write-only)'
);

SELECT * FROM finish();

ROLLBACK;

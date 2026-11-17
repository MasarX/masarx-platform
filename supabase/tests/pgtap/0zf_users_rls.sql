-- Test: Users table RLS coverage
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND rowsecurity = TRUE
  ),
  'users has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND policyname = 'users_authenticated_select'
      AND 'authenticated' = ANY (roles)
  ),
  'users_authenticated_select policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND policyname = 'users_service_policy'
      AND 'service_role' = ANY (roles)
  ),
  'users_service_policy policy exists'
);

SELECT * FROM finish();
ROLLBACK;

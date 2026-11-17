-- Test: Observability RLS policies
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'decision_log'
      AND rowsecurity = TRUE
  ),
  'decision_log has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'settings_resolution_log'
      AND rowsecurity = TRUE
  ),
  'settings_resolution_log has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_log'
      AND policyname = 'decision_log_authenticated_read'
      AND 'authenticated' = ANY (roles)
  ),
  'decision_log_authenticated_read policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'settings_resolution_log'
      AND policyname = 'settings_resolution_log_authenticated_read'
      AND 'authenticated' = ANY (roles)
  ),
  'settings_resolution_log_authenticated_read policy exists'
);

SELECT * FROM finish();
ROLLBACK;

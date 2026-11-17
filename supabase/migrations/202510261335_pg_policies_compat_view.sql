-- Migration: Provide compatibility view for pg_policies (polname alias)

BEGIN;

CREATE OR REPLACE VIEW public.pg_policies AS
SELECT
  schemaname,
  tablename,
  policyname AS polname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_catalog.pg_policies;

COMMENT ON VIEW public.pg_policies IS 'Compatibility wrapper exposing polname for legacy checks';

COMMIT;


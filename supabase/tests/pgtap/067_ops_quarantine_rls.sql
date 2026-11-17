-- Test file: 067_ops_quarantine_rls.sql
-- Purpose: Verify RLS and service_role policy on ops_quarantine.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='ops_quarantine'),
  'RLS enabled on ops_quarantine'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='ops_quarantine'
      AND roles @> ARRAY['service_role'::name]
  ),
  'ops_quarantine has a service_role policy'
);

SELECT finish();

ROLLBACK;

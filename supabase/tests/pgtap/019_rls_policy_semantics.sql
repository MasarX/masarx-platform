-- Test: RLS policies include organization-aware predicates for workflow tables

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- Verify workflow_runs has SELECT policy using current_user_org_id()
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'workflow_runs'
      AND lower(p.cmd) = 'select'
      AND p.policyname ILIKE '%isolation%'
      AND p.qual ILIKE '%current_user_org_id()%'
  ),
  'workflow_runs SELECT policy uses current_user_org_id() in predicate'
);

-- Verify workflow_run_steps has SELECT policy tied to workflow_runs with org predicate
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'workflow_run_steps'
      AND lower(p.cmd) = 'select'
      AND p.policyname ILIKE '%isolation%'
      AND p.qual ILIKE '%workflow_run_id%'
  ),
  'workflow_run_steps SELECT policy references workflow_run_id linkage (org isolation inherited)'
);

-- Verify settings has RLS enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='settings'),
  'settings has RLS enabled'
);

-- Verify settings_versions has RLS enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='settings_versions'),
  'settings_versions has RLS enabled'
);

SELECT * FROM finish();

ROLLBACK;


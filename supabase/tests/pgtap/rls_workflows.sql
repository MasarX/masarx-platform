-- Test Suite: RLS enforcement on workflow_runs and workflow_templates
-- Verifies anon blocked, authenticated org-scoped, service_role unrestricted.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

-- =============================================================================
-- SECTION 1: workflow_runs
-- =============================================================================

-- 1.1 RLS is enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'workflow_runs'),
  'RLS is enabled on workflow_runs'
);

-- 1.2 anon has no privileges
SELECT ok(
  NOT has_table_privilege('anon', 'public.workflow_runs', 'SELECT'),
  'anon cannot SELECT workflow_runs'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.workflow_runs', 'INSERT'),
  'anon cannot INSERT into workflow_runs'
);

-- 1.3 service_role has permissive ALL policy
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_runs'
      AND policyname ILIKE '%service%'
      AND lower(cmd) = 'all'
      AND qual ILIKE '%true%'
  ),
  'service_role has permissive ALL policy on workflow_runs'
);

-- 1.4 authenticated SELECT policy uses org isolation
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_runs'
      AND lower(cmd) = 'select'
      AND policyname ILIKE '%isolation%'
      AND qual ILIKE '%current_user_org_id()%'
  ),
  'authenticated SELECT policy on workflow_runs uses current_user_org_id() isolation'
);

-- =============================================================================
-- SECTION 2: workflow_templates
-- =============================================================================

-- 2.1 RLS is enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'workflow_templates'),
  'RLS is enabled on workflow_templates'
);

-- 2.2 anon has no privileges
SELECT ok(
  NOT has_table_privilege('anon', 'public.workflow_templates', 'SELECT'),
  'anon cannot SELECT workflow_templates'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.workflow_templates', 'INSERT'),
  'anon cannot INSERT into workflow_templates'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.workflow_templates', 'UPDATE'),
  'anon cannot UPDATE workflow_templates'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.workflow_templates', 'DELETE'),
  'anon cannot DELETE from workflow_templates'
);

-- 2.3 service_role has permissive ALL policy
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_templates'
      AND policyname ILIKE '%service_role%'
      AND lower(cmd) = 'all'
      AND qual ILIKE '%true%'
  ),
  'service_role has permissive ALL policy on workflow_templates'
);

-- 2.4 authenticated SELECT policy uses scope-based isolation
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_templates'
      AND lower(cmd) = 'select'
      AND (roles::text[] @> ARRAY['authenticated'] OR roles = '{authenticated}')
      AND qual ILIKE '%workflow_template_scope_allowed%'
  ),
  'authenticated SELECT policy on workflow_templates uses workflow_template_scope_allowed()'
);

-- =============================================================================
-- SECTION 3: workflow_run_steps (linked via workflow_runs)
-- =============================================================================

-- 3.1 RLS is enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'workflow_run_steps'),
  'RLS is enabled on workflow_run_steps'
);

-- 3.2 authenticated SELECT policy references workflow_run_id linkage
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_run_steps'
      AND lower(cmd) = 'select'
      AND policyname ILIKE '%isolation%'
      AND qual ILIKE '%workflow_run_id%'
  ),
  'workflow_run_steps SELECT policy inherits org isolation via workflow_run_id'
);

SELECT * FROM finish();

ROLLBACK;

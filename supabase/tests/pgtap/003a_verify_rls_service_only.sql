-- Plan: PLAN-202602-backend-foundations-v1 / Step: S04
-- Test file: 003a_verify_rls_service_only.sql
-- Purpose: Verify RLS + explicit service_role policies on all service-only tables (catalog-driven).
-- Notes:
--   - Service-only table inventory is derived from `public.security_rls_user_facing` (SSOT).
--   - Service-only implies: no anon/authenticated grants + RLS enabled + explicit service_role policy.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'security_rls_user_facing'
  ),
  'security_rls_user_facing view exists'
);

-- 1) Service-only tables have RLS enabled
WITH user_facing AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
candidates AS (
  SELECT c.oid, c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = FALSE
    AND c.relname <> 'spatial_ref_sys'
    AND c.relname NOT IN (SELECT tablename FROM user_facing)
),
missing AS (
  SELECT c.tablename
  FROM candidates c
  LEFT JOIN pg_tables p
    ON p.schemaname = 'public' AND p.tablename = c.tablename
  WHERE COALESCE(p.rowsecurity, false) = false
)
SELECT diag('Missing RLS on service-only table: ' || tablename)
FROM missing;

WITH user_facing AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
candidates AS (
  SELECT c.oid, c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = FALSE
    AND c.relname <> 'spatial_ref_sys'
    AND c.relname NOT IN (SELECT tablename FROM user_facing)
),
missing AS (
  SELECT c.tablename
  FROM candidates c
  LEFT JOIN pg_tables p
    ON p.schemaname = 'public' AND p.tablename = c.tablename
  WHERE COALESCE(p.rowsecurity, false) = false
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing),
  0,
  'All service-only tables have RLS enabled'
);

-- 2) Service-only tables have an explicit service_role ALL policy (deny-by-default with no policy is not sufficient)
WITH user_facing AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
candidates AS (
  SELECT c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = FALSE
    AND c.relname <> 'spatial_ref_sys'
    AND c.relname NOT IN (SELECT tablename FROM user_facing)
),
missing AS (
  SELECT c.tablename
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = c.tablename
      AND ('service_role' = ANY (p.roles))
      AND p.cmd = 'ALL'
  )
)
SELECT diag('Missing service_role ALL policy on service-only table: ' || tablename)
FROM missing;

WITH user_facing AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
candidates AS (
  SELECT c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = FALSE
    AND c.relname <> 'spatial_ref_sys'
    AND c.relname NOT IN (SELECT tablename FROM user_facing)
),
missing AS (
  SELECT c.tablename
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = c.tablename
      AND ('service_role' = ANY (p.roles))
      AND p.cmd = 'ALL'
  )
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing),
  0,
  'All service-only tables have a service_role ALL policy'
);

-- 3) Service-only tables have no anon/authenticated grants (defense in depth: avoid accidental exposure)
WITH user_facing AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
candidates AS (
  SELECT c.oid, c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = FALSE
    AND c.relname <> 'spatial_ref_sys'
    AND c.relname NOT IN (SELECT tablename FROM user_facing)
),
leaked AS (
  SELECT c.tablename
  FROM candidates c
  WHERE has_table_privilege('anon', c.oid, 'select')
     OR has_table_privilege('anon', c.oid, 'insert')
     OR has_table_privilege('anon', c.oid, 'update')
     OR has_table_privilege('anon', c.oid, 'delete')
     OR has_table_privilege('authenticated', c.oid, 'select')
     OR has_table_privilege('authenticated', c.oid, 'insert')
     OR has_table_privilege('authenticated', c.oid, 'update')
     OR has_table_privilege('authenticated', c.oid, 'delete')
)
SELECT diag('Service-only table has leaked anon/authenticated grant: ' || tablename)
FROM leaked;

WITH user_facing AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
candidates AS (
  SELECT c.oid, c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = FALSE
    AND c.relname <> 'spatial_ref_sys'
    AND c.relname NOT IN (SELECT tablename FROM user_facing)
),
leaked AS (
  SELECT c.tablename
  FROM candidates c
  WHERE has_table_privilege('anon', c.oid, 'select')
     OR has_table_privilege('anon', c.oid, 'insert')
     OR has_table_privilege('anon', c.oid, 'update')
     OR has_table_privilege('anon', c.oid, 'delete')
     OR has_table_privilege('authenticated', c.oid, 'select')
     OR has_table_privilege('authenticated', c.oid, 'insert')
     OR has_table_privilege('authenticated', c.oid, 'update')
     OR has_table_privilege('authenticated', c.oid, 'delete')
)
SELECT is(
  (SELECT COUNT(*)::INT FROM leaked),
  0,
  'All service-only tables have no anon/authenticated grants'
);

SELECT finish();

ROLLBACK;

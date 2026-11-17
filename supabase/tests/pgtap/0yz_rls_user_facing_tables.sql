-- Plan: PLAN-202512-rls-backlog-and-prod-postdeploy-verify-v1 / Step: S04
-- Purpose: Generic RLS + policy coverage for user-facing tables.
-- Notes: Requires view public.security_rls_user_facing (SSOT) to exist.

BEGIN;

SELECT plan(3);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'security_rls_user_facing'
  ),
  'security_rls_user_facing view exists'
);

WITH candidates AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
missing AS (
  SELECT c.tablename
  FROM candidates c
  LEFT JOIN pg_tables p
    ON p.schemaname = 'public' AND p.tablename = c.tablename
  WHERE COALESCE(p.rowsecurity, false) = false
)
SELECT is((SELECT COUNT(*)::INT FROM missing), 0,
           'All user-facing tables in security_rls_user_facing have RLS enabled')
;

-- User-facing implies readable by authenticated; require an explicit SELECT/ALL policy (deny-by-default with no policy is not sufficient).
WITH candidates AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
missing AS (
  SELECT c.tablename
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = c.tablename
      AND ('authenticated' = ANY (p.roles))
      AND p.cmd IN ('SELECT', 'ALL')
  )
)
SELECT diag('Missing authenticated SELECT/ALL policy: ' || tablename)
FROM missing;

WITH candidates AS (
  SELECT tablename
  FROM public.security_rls_user_facing
),
missing AS (
  SELECT c.tablename
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = c.tablename
      AND ('authenticated' = ANY (p.roles))
      AND p.cmd IN ('SELECT', 'ALL')
  )
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing),
  0,
  'All user-facing tables in security_rls_user_facing have an authenticated SELECT policy'
);

SELECT * FROM finish();

ROLLBACK;

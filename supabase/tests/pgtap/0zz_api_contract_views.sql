-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Test: API contract views coverage (user-facing public tables -> api views)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT has_schema('api', 'api schema exists');

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relkind IN ('r','p')
      AND c.relispartition = FALSE
  ),
  0,
  'api schema contains no base tables'
);

WITH missing AS (
  SELECT t.tablename
  FROM public.security_rls_user_facing t
  LEFT JOIN pg_namespace n
    ON n.nspname = 'api'
  LEFT JOIN pg_class c
    ON c.relnamespace = n.oid
   AND c.relname = t.tablename
   AND c.relkind = 'v'
  WHERE c.oid IS NULL
)
SELECT diag('Missing api contract view: ' || tablename)
FROM missing;

WITH missing AS (
  SELECT t.tablename
  FROM public.security_rls_user_facing t
  LEFT JOIN pg_namespace n
    ON n.nspname = 'api'
  LEFT JOIN pg_class c
    ON c.relnamespace = n.oid
   AND c.relname = t.tablename
   AND c.relkind = 'v'
  WHERE c.oid IS NULL
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing),
  0,
  'All user-facing public tables have api contract views'
);

WITH non_invoker AS (
  SELECT t.tablename
  FROM public.security_rls_user_facing t
  JOIN pg_namespace n
    ON n.nspname = 'api'
  JOIN pg_class c
    ON c.relnamespace = n.oid
   AND c.relname = t.tablename
   AND c.relkind = 'v'
  WHERE NOT (COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true'])
)
SELECT diag('Non security_invoker api contract view: ' || tablename)
FROM non_invoker;

WITH non_invoker AS (
  SELECT t.tablename
  FROM public.security_rls_user_facing t
  JOIN pg_namespace n
    ON n.nspname = 'api'
  JOIN pg_class c
    ON c.relnamespace = n.oid
   AND c.relname = t.tablename
   AND c.relkind = 'v'
  WHERE NOT (COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true'])
)
SELECT is(
  (SELECT COUNT(*)::INT FROM non_invoker),
  0,
  'All api contract views are security_invoker'
);

SELECT * FROM finish();

ROLLBACK;


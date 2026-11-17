-- Plan: PLAN-202601-schema-reaudit-v2 / Step: S95
-- Test: `anon` has no access to the Data API contract surface (`api` schema).
--
-- Rationale
-- - Enterprise default: no unauthenticated access to application data.
-- - Defense-in-depth: `anon` should not even have schema USAGE on internal schemas.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  NOT has_schema_privilege('anon', 'api', 'usage'),
  'anon has no USAGE on schema api'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND (
        has_table_privilege('anon', c.oid, 'select') OR
        has_table_privilege('anon', c.oid, 'insert') OR
        has_table_privilege('anon', c.oid, 'update') OR
        has_table_privilege('anon', c.oid, 'delete')
      )
  ),
  0::bigint,
  'anon has no relation privileges on any api object'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api'
      AND has_function_privilege('anon', p.oid, 'execute')
  ),
  0::bigint,
  'anon has no EXECUTE on api functions'
);

SELECT ok(
  NOT has_schema_privilege('anon', 'public', 'usage'),
  'anon has no USAGE on schema public'
);

SELECT finish();

ROLLBACK;


-- Plan: PLAN-202601-schema-reaudit-v2 / Step: S95
-- Test: `anon` has access only to the exact public tracking API facade.
--
-- Rationale
-- - Enterprise default: no unauthenticated access to application data.
-- - The public tracking page requires one whitelisted browser-safe RPC.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  has_schema_privilege('anon', 'api', 'usage'),
  'anon has api schema USAGE for the exact public tracking facade'
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
      AND p.oid <> 'api.public_tracking_config_v1()'::regprocedure
  ),
  0::bigint,
  'anon has no EXECUTE on api functions outside the public tracking facade'
);

SELECT ok(
  NOT has_schema_privilege('anon', 'public', 'usage'),
  'anon has no USAGE on schema public'
);

SELECT finish();

ROLLBACK;


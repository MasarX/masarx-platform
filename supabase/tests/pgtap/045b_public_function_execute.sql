BEGIN;
SET LOCAL search_path TO pg_catalog, public, extensions, pgtap, pg_temp;

SELECT plan(3);

CREATE TEMP VIEW public_execute_functions AS
SELECT p.oid AS function_oid
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'api')
  AND p.prokind <> 'p'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend AS d
    WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid
      AND d.objsubid = 0
      AND d.refclassid = 'pg_extension'::regclass
      AND d.deptype = 'e'
  )
  AND EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  );

SELECT is(
  (SELECT count(*) FROM pg_temp.public_execute_functions),
  0::bigint,
  'Application functions in public and api have no PUBLIC EXECUTE grant'
);

CREATE FUNCTION public.public_execute_guard_fixture_v1()
RETURNS integer LANGUAGE sql AS 'SELECT 1';

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_temp.public_execute_functions
    WHERE function_oid = 'public.public_execute_guard_fixture_v1()'::regprocedure
  ),
  'PUBLIC EXECUTE guard detects the default grant on an invoker function'
);

REVOKE EXECUTE ON FUNCTION public.public_execute_guard_fixture_v1() FROM PUBLIC;

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_temp.public_execute_functions
    WHERE function_oid = 'public.public_execute_guard_fixture_v1()'::regprocedure
  ),
  'PUBLIC EXECUTE guard accepts the same function after exact-signature revocation'
);

SELECT finish();
ROLLBACK;

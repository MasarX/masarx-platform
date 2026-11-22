BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(NOT EXISTS (
  SELECT 1
  FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
  WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
), 'tighten function privileges')
FROM pg_proc AS proc
WHERE proc.oid = 'public.worker_action_call_supplier_api(uuid,jsonb,jsonb)'::regprocedure;

SELECT is(has_function_privilege(role_name, 'public.worker_action_call_supplier_api(uuid,jsonb,jsonb)', 'EXECUTE'),
          role_name = 'service_role',
          'tighten function privileges')
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name);

SELECT * FROM finish();
ROLLBACK;

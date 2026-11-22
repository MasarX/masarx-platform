BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT ok(NOT EXISTS (
  SELECT 1
  FROM aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
  WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
), 'tighten function privileges')
FROM pg_proc AS proc
WHERE proc.oid IN (
  'public.worker_action_call_supplier_api(uuid,jsonb,jsonb)'::regprocedure,
  'public.enqueue_outbound_call_from_operation_template_v1(uuid,jsonb,jsonb,uuid,integer,integer,text)'::regprocedure,
  'public.build_outbound_call_dispatch_from_operation_template_v1(uuid,jsonb,jsonb,jsonb,text)'::regprocedure
);

SELECT is(has_function_privilege(role_name, signature, 'EXECUTE'),
          role_name = 'service_role',
          'tighten function privileges')
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
CROSS JOIN (VALUES
  ('public.worker_action_call_supplier_api(uuid,jsonb,jsonb)'),
  ('public.enqueue_outbound_call_from_operation_template_v1(uuid,jsonb,jsonb,uuid,integer,integer,text)'),
  ('public.build_outbound_call_dispatch_from_operation_template_v1(uuid,jsonb,jsonb,jsonb,text)')
) AS functions(signature);

SELECT * FROM finish();
ROLLBACK;

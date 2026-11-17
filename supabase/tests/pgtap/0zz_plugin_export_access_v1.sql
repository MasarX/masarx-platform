-- RPC access metadata complements native token and actor regressions.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

SELECT ok(NOT has_function_privilege('anon',
  'public.integration_plugin_export_handoff_v1(uuid,text)', 'EXECUTE'),
  'anonymous callers cannot export credentials through public RPC');
SELECT ok(NOT has_function_privilege('anon',
  'api.integration_plugin_export_handoff_v1(uuid,text)', 'EXECUTE'),
  'anonymous callers cannot export credentials through API RPC');
SELECT ok(has_function_privilege('authenticated',
  'public.integration_plugin_export_handoff_v1(uuid,text)', 'EXECUTE'),
  'authenticated callers reach the capability-gated public RPC');
SELECT ok(has_function_privilege('authenticated',
  'api.integration_plugin_export_handoff_v1(uuid,text)', 'EXECUTE'),
  'authenticated callers reach the capability-gated API RPC');
SELECT ok((SELECT NOT prosecdef FROM pg_proc
  WHERE oid='api.integration_plugin_export_handoff_v1(uuid,text)'::regprocedure),
  'API wrapper retains invoker security');
SELECT ok(public.integration_plugin_scope_belongs_org_v1(
  'tenant','00000000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-4000-8000-000000000002'::uuid) IS FALSE,
  'binding scope predicate rejects a different tenant');

SELECT finish();
ROLLBACK;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

SELECT plan(28);

CREATE TEMP TABLE ingress_rpc_contract AS
SELECT
  name,
  to_regprocedure('api.' || signature) AS rpc,
  return_type,
  default_count,
  edge_role
FROM (VALUES
  ('workflow_intake_webhook', 'workflow_intake_webhook(text,jsonb,text,jsonb)',
   'jsonb', 1, 'edge_webhook_role'),
  ('workflow_intake_api_gateway_v1', 'workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)',
   'jsonb', 3, 'edge_api_gateway_role'),
  ('get_webhook_edge_dispatch_jobs', 'get_webhook_edge_dispatch_jobs(uuid)',
   'TABLE(job_id uuid, timeout_seconds integer)', 0, 'edge_webhook_role')
) AS contract(name, signature, return_type, default_count, edge_role);

SELECT ok(rpc IS NOT NULL, format('api.%s has the canonical signature', name))
FROM ingress_rpc_contract ORDER BY name;

SELECT is(pg_get_function_result(rpc), return_type, format('api.%s preserves its return type', name))
FROM ingress_rpc_contract ORDER BY name;

SELECT is(p.pronargdefaults::integer, c.default_count, format('api.%s preserves its defaults', c.name))
FROM ingress_rpc_contract c LEFT JOIN pg_proc p ON p.oid = c.rpc ORDER BY c.name;

SELECT ok(NOT p.prosecdef AND p.provolatile = 'v', format('api.%s is a volatile invoker', c.name))
FROM ingress_rpc_contract c LEFT JOIN pg_proc p ON p.oid = c.rpc ORDER BY c.name;

SELECT ok(strpos(p.prosrc, 'public.' || c.name || '(') > 0,
          format('api.%s delegates to its public implementation', c.name))
FROM ingress_rpc_contract c LEFT JOIN pg_proc p ON p.oid = c.rpc ORDER BY c.name;

SELECT ok(
  has_schema_privilege(edge_role::name, 'api', 'USAGE') AND
  has_function_privilege(edge_role::name, rpc, 'EXECUTE'),
  format('%s can execute api.%s', edge_role, name)
)
FROM ingress_rpc_contract ORDER BY name;

SELECT ok(NOT has_function_privilege('anon', rpc, 'EXECUTE'),
          format('anon cannot execute api.%s', name))
FROM ingress_rpc_contract ORDER BY name;

SELECT ok(NOT has_function_privilege('authenticated', rpc, 'EXECUTE'),
          format('authenticated cannot execute api.%s', name))
FROM ingress_rpc_contract ORDER BY name;

SELECT ok(
  has_schema_privilege('service_role', 'api', 'USAGE') AND
  has_function_privilege('service_role', rpc, 'EXECUTE'),
  format('service_role can execute api.%s', name)
)
FROM ingress_rpc_contract WHERE edge_role = 'edge_webhook_role' ORDER BY name;

SELECT ok(pg_has_role('service_role', 'edge_api_gateway_role', 'MEMBER'),
          'service_role retains gateway role membership');

SELECT ok(has_schema_privilege('service_role', 'api', 'USAGE'),
          'service_role can use the api schema');

SELECT * FROM finish();
ROLLBACK;

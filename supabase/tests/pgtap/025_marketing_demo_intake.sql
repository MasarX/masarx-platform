BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

-- 1) marketing_demo_requests has RLS enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='marketing_demo_requests'),
  'RLS enabled on marketing_demo_requests'
);

-- 2) marketing_demo_requests has service_role policy
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='marketing_demo_requests'
      AND roles @> ARRAY['service_role'::name]
  ),
  'marketing_demo_requests has a service_role policy'
);

-- 3) RPC exists
SELECT has_function(
  'public',
  'marketing_demo_request_create_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
  'marketing_demo_request_create_v1 exists'
);

-- 4) RPC is SECURITY DEFINER (bypasses table RLS; execution restricted via grants)
SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'public.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'
    )
      AND p.prokind = 'f'
  ),
  'marketing_demo_request_create_v1 is SECURITY DEFINER'
);

-- 5) api wrapper exists (PostgREST exposes `api` schema by default)
SELECT has_function(
  'api',
  'marketing_demo_request_create_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
  'api.marketing_demo_request_create_v1 exists'
);

-- 6) service-only mutation is not executable by edge_api_gateway_role
SELECT ok(
  NOT has_function_privilege(
    'edge_api_gateway_role',
    'api.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role cannot EXECUTE api.marketing_demo_request_create_v1'
);

-- 7) anon cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE api.marketing_demo_request_create_v1'
);

-- 8) authenticated cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE api.marketing_demo_request_create_v1'
);

-- 9) service-only implementation is not executable by edge_api_gateway_role
SELECT ok(
  NOT has_function_privilege(
    'edge_api_gateway_role',
    'public.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role cannot EXECUTE marketing_demo_request_create_v1'
);

-- 10) anon cannot execute public function
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE marketing_demo_request_create_v1'
);

-- 11) authenticated cannot execute public function
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE marketing_demo_request_create_v1'
);

-- 12) anon cannot SELECT the SSOT table
SELECT ok(
  NOT has_table_privilege('anon', 'public.marketing_demo_requests', 'SELECT'),
  'anon cannot SELECT marketing_demo_requests'
);

SELECT finish();

ROLLBACK;

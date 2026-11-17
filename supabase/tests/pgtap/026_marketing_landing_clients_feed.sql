BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

-- 1) public RPC exists
SELECT has_function(
  'public',
  'marketing_landing_clients_list_v1',
  ARRAY['text'],
  'public.marketing_landing_clients_list_v1 exists'
);

-- 2) public RPC is SECURITY DEFINER
SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.marketing_landing_clients_list_v1(text)')
      AND p.prokind = 'f'
  ),
  'public.marketing_landing_clients_list_v1 is SECURITY DEFINER'
);

-- 3) api wrapper exists
SELECT has_function(
  'api',
  'marketing_landing_clients_list_v1',
  ARRAY['text'],
  'api.marketing_landing_clients_list_v1 exists'
);

-- 4) edge_api_gateway_role can execute api wrapper
SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'api.marketing_landing_clients_list_v1(text)',
    'EXECUTE'
  ),
  'edge_api_gateway_role can EXECUTE api.marketing_landing_clients_list_v1'
);

-- 5) anon cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.marketing_landing_clients_list_v1(text)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE api.marketing_landing_clients_list_v1'
);

-- 6) authenticated cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.marketing_landing_clients_list_v1(text)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE api.marketing_landing_clients_list_v1'
);

-- 7) edge_api_gateway_role can execute public implementation
SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'public.marketing_landing_clients_list_v1(text)',
    'EXECUTE'
  ),
  'edge_api_gateway_role can EXECUTE public.marketing_landing_clients_list_v1'
);

-- 8) anon cannot execute public implementation
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.marketing_landing_clients_list_v1(text)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE public.marketing_landing_clients_list_v1'
);

-- 9) authenticated cannot execute public implementation
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.marketing_landing_clients_list_v1(text)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE public.marketing_landing_clients_list_v1'
);

-- 10) settings category is registered
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'marketing_landing_clients_policy'
  ),
  'marketing_landing_clients_policy exists in settings_category_registry'
);

-- 11) global default settings row exists
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'marketing_landing_clients_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'marketing_landing_clients_policy has global default in settings'
);

-- 12) function call is stable and safe
SELECT lives_ok(
  $$ SELECT * FROM public.marketing_landing_clients_list_v1('en') LIMIT 1; $$,
  'marketing_landing_clients_list_v1 executes'
);

SELECT finish();

ROLLBACK;


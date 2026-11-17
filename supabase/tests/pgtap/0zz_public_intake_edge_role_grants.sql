BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT ok(
  NOT has_function_privilege(
    'edge_api_gateway_role',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role cannot execute service-only api.marketing_lead_request_create_v1'
);

SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'api.marketing_landing_clients_list_v1(text)',
    'EXECUTE'
  ),
  'edge_api_gateway_role can execute api.marketing_landing_clients_list_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'edge_api_gateway_role',
    'api.tenant_signup_policy_v1()',
    'EXECUTE'
  ),
  'edge_api_gateway_role cannot execute service-only api.tenant_signup_policy_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'edge_api_gateway_role',
    'api.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role cannot execute service-only api.tenant_signup_request_create_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot execute api.marketing_lead_request_create_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'authenticated cannot execute api.tenant_signup_request_create_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.tenant_signup_policy_v1()',
    'EXECUTE'
  ),
  'authenticated cannot execute api.tenant_signup_policy_v1'
);

SELECT ok(
  pg_has_role('authenticator', 'edge_api_caller_role', 'MEMBER'),
  'authenticator can assume edge_api_caller_role through the existing role chain'
);

SELECT ok(
  has_function_privilege('service_role', 'api.tenant_signup_policy_v1()', 'EXECUTE'),
  'service_role can execute api.tenant_signup_policy_v1'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'api.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'service_role can execute api.tenant_signup_request_create_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.tenant_signup_policy_v1()', 'EXECUTE'),
  'anon cannot execute api.tenant_signup_policy_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)', 'EXECUTE'),
  'anon cannot execute api.tenant_signup_request_create_v1'
);

SELECT finish();

ROLLBACK;

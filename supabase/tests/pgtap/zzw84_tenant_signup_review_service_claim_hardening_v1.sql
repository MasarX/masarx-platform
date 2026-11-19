-- pgTAP: tenant signup review service-claim hardening contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

SELECT has_function(
  'public',
  'request_role_is_service_claim_v1',
  ARRAY[]::text[],
  'public.request_role_is_service_claim_v1 is registered'
);

SELECT has_function(
  'public',
  'tenant_signup_review_apply_v1',
  ARRAY['uuid', 'text', 'uuid', 'text', 'uuid', 'boolean', 'text', 'jsonb'],
  'public.tenant_signup_review_apply_v1 hardened wrapper is registered'
);

SELECT has_function(
  'public',
  'tenant_signup_review_apply_v1_impl_202605031930',
  ARRAY['uuid', 'text', 'uuid', 'text', 'uuid', 'boolean', 'text', 'jsonb'],
  'private tenant signup review implementation is retained'
);

SELECT has_function(
  'api',
  'tenant_signup_review_apply_v1',
  ARRAY['uuid', 'text', 'uuid', 'text', 'uuid', 'boolean', 'text', 'jsonb'],
  'api.tenant_signup_review_apply_v1 service edge wrapper is registered'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'tenant_signup_review_apply_v1'
    LIMIT 1),
  true,
  'public tenant signup review wrapper is SECURITY DEFINER'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api'
      AND p.proname = 'tenant_signup_review_apply_v1'
    LIMIT 1),
  false,
  'api tenant signup review wrapper is SECURITY INVOKER'
);

SELECT ok(
  lower(pg_get_functiondef('public.request_role_is_service_claim_v1()'::regprocedure)) NOT LIKE '%session_user%',
  'service detector does not use legacy session identity'
);

SELECT ok(
  lower(pg_get_functiondef('public.request_role_is_service_claim_v1()'::regprocedure)) NOT LIKE '%current_user%',
  'service detector does not use elevated definer identity'
);

SELECT ok(
  lower(pg_get_functiondef('public.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)'::regprocedure)) NOT LIKE '%session_user%',
  'public review wrapper does not use legacy session identity'
);

SELECT ok(
  lower(pg_get_functiondef('public.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)'::regprocedure)) NOT LIKE '%current_user%',
  'public review wrapper does not use elevated definer identity'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'service_role can execute hardened public review wrapper'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute hardened public review wrapper directly'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute hardened public review wrapper directly'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'api.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'service_role can execute api review wrapper'
);

SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'api.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'trusted edge DB role can execute api review wrapper'
);

SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'public.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'trusted edge DB role can execute public review wrapper reached by api wrapper'
);

SELECT ok(
  pg_get_functiondef('public.request_role_is_service_claim_v1()'::regprocedure) LIKE '%edge_api_gateway_role%',
  'service detector explicitly allows the trusted edge DB role by claim'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute api review wrapper directly'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute api review wrapper directly'
);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.tenant_signup_review_apply_v1_impl_202605031930(uuid,text,uuid,text,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'private provisioning implementation is not directly executable by service_role'
);

SELECT is(
  public.tenant_signup_review_apply_v1(
    NULL,
    'approved',
    NULL,
    NULL,
    NULL,
    false,
    NULL,
    '{}'::jsonb
  ) #>> '{error,code}',
  'service_role_required',
  'non-service local calls fail before provisioning implementation'
);

SELECT * FROM finish();
ROLLBACK;

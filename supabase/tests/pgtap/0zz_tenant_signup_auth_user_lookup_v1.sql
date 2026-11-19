-- pgTAP: trusted tenant signup Auth user lookup for approval recovery.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

SELECT has_function(
  'public',
  'tenant_signup_find_auth_user_id_by_email_v1',
  ARRAY['text'],
  'public tenant signup Auth user lookup is registered'
);

SELECT has_function(
  'api',
  'tenant_signup_find_auth_user_id_by_email_v1',
  ARRAY['text'],
  'api tenant signup Auth user lookup wrapper is registered'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'tenant_signup_find_auth_user_id_by_email_v1'
    LIMIT 1),
  true,
  'public tenant signup Auth lookup is SECURITY DEFINER'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api'
      AND p.proname = 'tenant_signup_find_auth_user_id_by_email_v1'
    LIMIT 1),
  false,
  'api tenant signup Auth lookup is SECURITY INVOKER'
);

SELECT ok(
  pg_get_functiondef('public.tenant_signup_find_auth_user_id_by_email_v1(text)'::regprocedure) LIKE '%auth.users%',
  'public tenant signup Auth lookup reads the canonical auth.users store'
);

SELECT ok(
  lower(pg_get_functiondef('public.tenant_signup_find_auth_user_id_by_email_v1(text)'::regprocedure)) NOT LIKE '%session_user%',
  'public tenant signup Auth lookup does not use session_user'
);

SELECT ok(
  lower(pg_get_functiondef('public.tenant_signup_find_auth_user_id_by_email_v1(text)'::regprocedure)) NOT LIKE '%current_user%',
  'public tenant signup Auth lookup does not use current_user'
);

SELECT ok(
  has_function_privilege('service_role', 'public.tenant_signup_find_auth_user_id_by_email_v1(text)', 'EXECUTE'),
  'service_role can execute public tenant signup Auth lookup'
);

SELECT ok(
  has_function_privilege('edge_api_gateway_role', 'public.tenant_signup_find_auth_user_id_by_email_v1(text)', 'EXECUTE'),
  'trusted edge role can execute public tenant signup Auth lookup'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.tenant_signup_find_auth_user_id_by_email_v1(text)', 'EXECUTE'),
  'authenticated cannot execute public tenant signup Auth lookup'
);

SELECT ok(
  has_function_privilege('service_role', 'api.tenant_signup_find_auth_user_id_by_email_v1(text)', 'EXECUTE'),
  'service_role can execute api tenant signup Auth lookup'
);

SELECT ok(
  has_function_privilege('edge_api_gateway_role', 'api.tenant_signup_find_auth_user_id_by_email_v1(text)', 'EXECUTE'),
  'trusted edge role can execute api tenant signup Auth lookup'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'api.tenant_signup_find_auth_user_id_by_email_v1(text)', 'EXECUTE'),
  'authenticated cannot execute api tenant signup Auth lookup'
);

DO $$
DECLARE
  v_auth_user_id UUID := '00000000-0000-0000-0000-000001645001';
  v_email TEXT := 'tenant-signup-existing-auth-pgtap@example.invalid';
BEGIN
  INSERT INTO auth.users (
    id, aud, role, email, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  VALUES (
    v_auth_user_id, 'authenticated', 'authenticated', v_email,
    now(), '{}'::jsonb, '{}'::jsonb, now() - interval '1 hour', now()
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        updated_at = EXCLUDED.updated_at;

  PERFORM set_config('request.jwt.claim.role', 'edge_api_gateway_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"edge_api_gateway_role"}', true);

  PERFORM is(
    public.tenant_signup_find_auth_user_id_by_email_v1(upper(v_email))::text,
    v_auth_user_id::text,
    'trusted edge claim resolves existing Auth user by case-insensitive email'
  );

  PERFORM is(
    api.tenant_signup_find_auth_user_id_by_email_v1('  ' || v_email || '  ')::text,
    v_auth_user_id::text,
    'api wrapper trims email and returns the same Auth user'
  );

  PERFORM is(
    public.tenant_signup_find_auth_user_id_by_email_v1('')::text,
    NULL,
    'blank email returns null without scanning Auth users'
  );
END;
$$;

SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);

SELECT throws_ok(
  $$ SELECT public.tenant_signup_find_auth_user_id_by_email_v1('tenant-signup-existing-auth-pgtap@example.invalid') $$,
  '42501',
  'tenant_signup_find_auth_user_id_by_email_v1 requires trusted edge/service role',
  'non-trusted claims fail closed'
);

SELECT * FROM finish();
ROLLBACK;

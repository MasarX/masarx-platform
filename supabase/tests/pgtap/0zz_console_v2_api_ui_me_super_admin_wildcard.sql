-- pgTAP: Console V2 live identity uses the API-schema ui_me_v1 wrapper.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_api_ui_me_super_admin_wildcard()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_me JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Wildcard Org', 'console-v2-wildcard-' || left(v_org::text, 8));

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id,
    status
  )
  VALUES (
    v_user,
    v_org,
    'console-v2-wildcard-super-admin@example.test',
    'Console V2 Wildcard Super Admin',
    'super_admin',
    'platform',
    NULL,
    'active'
  );

  RETURN NEXT has_function('api', 'ui_me_v1', ARRAY[]::text[], 'api.ui_me_v1 exists for browser Supabase clients');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_me_v1()', 'EXECUTE'),
    'authenticated can execute api.ui_me_v1'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'email', 'console-v2-wildcard-super-admin@example.test'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_me_v1() INTO v_me;

  RETURN NEXT is(
    v_me #>> '{user,user_type}',
    'super_admin',
    'api.ui_me_v1 hydrates the platform super_admin user type'
  );
  RETURN NEXT is(
    v_me #>> '{access_scope,scope_type}',
    'platform',
    'api.ui_me_v1 hydrates platform access scope'
  );
  RETURN NEXT ok(
    (v_me->'capabilities') @> '["*"]'::jsonb,
    'api.ui_me_v1 returns backend canonical wildcard capability for super_admin'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_api_ui_me_super_admin_wildcard();

SELECT * FROM finish();

ROLLBACK;

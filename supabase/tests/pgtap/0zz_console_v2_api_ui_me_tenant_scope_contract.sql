-- pgTAP: Console V2 live identity returns frontend-safe tenant scope.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_api_ui_me_tenant_scope_contract()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_me JSONB;
  v_public_me JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Tenant Scope Org', 'console-v2-tenant-scope-' || left(v_org::text, 8));

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
    'console-v2-tenant-scope@example.test',
    'Console V2 Tenant Operator',
    'ops_admin',
    'tenant',
    NULL,
    'active'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);

  INSERT INTO public.rbac_user_role_assignments (
    organization_id,
    user_id,
    role_id,
    assigned_by_user_id,
    metadata
  )
  SELECT
    v_org,
    v_user,
    r.id,
    v_user,
    jsonb_build_object('source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  RETURN NEXT has_function('api', 'ui_me_v1', ARRAY[]::text[], 'api.ui_me_v1 exists for browser Supabase clients');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_me_v1()', 'EXECUTE'),
    'authenticated can execute api.ui_me_v1'
  );
  RETURN NEXT has_function('public', 'ui_me_v1', ARRAY[]::text[], 'public identity function exists');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.ui_me_v1()', 'EXECUTE'),
    'authenticated can execute public.ui_me_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege('anon', 'public.ui_me_v1()', 'EXECUTE'),
    'anonymous users cannot execute public.ui_me_v1'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'email', 'console-v2-tenant-scope@example.test'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_me_v1() INTO v_me;
  SELECT public.ui_me_v1() INTO v_public_me;

  RETURN NEXT is(
    v_me #>> '{access_scope,scope_type}',
    'tenant',
    'api.ui_me_v1 hydrates tenant access scope'
  );
  RETURN NEXT is(
    v_me #>> '{access_scope,scope_id}',
    NULL,
    'api.ui_me_v1 returns NULL tenant scope_id for frontend identity guard'
  );
  RETURN NEXT is(
    v_me #>> '{user,access_scope_id}',
    NULL,
    'api.ui_me_v1 returns NULL user access_scope_id for tenant users'
  );
  RETURN NEXT ok(
    COALESCE(jsonb_array_length(v_me->'capabilities'), 0) > 0,
    'api.ui_me_v1 returns tenant operator capabilities'
  );
  RETURN NEXT is(
    v_public_me #> '{access_scope,scope_id}',
    'null'::jsonb,
    'public.ui_me_v1 returns a null frontend scope ID for tenant users'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_api_ui_me_tenant_scope_contract();

SELECT * FROM finish();

ROLLBACK;

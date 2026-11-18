-- pgTAP: policy resolution scope stays separate from nullable frontend identity scope.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(34);

CREATE OR REPLACE FUNCTION pg_temp.test_command_scope_identity_guard_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_tenant_user UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_client_user UUID := gen_random_uuid();
  v_sender_user UUID := gen_random_uuid();
  v_invited_user UUID := gen_random_uuid();
  v_inactive_user UUID := gen_random_uuid();
  v_suspended_user UUID := gen_random_uuid();
  v_missing_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_api_me JSONB;
  v_public_me JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    sort_order,
    is_default,
    status
  )
  SELECT
    d.id,
    v.value,
    v.label,
    v.sort_order,
    FALSE,
    'active'
  FROM public.lookup_definitions d
  CROSS JOIN (
    VALUES
      ('invited', 'Invited', 910),
      ('inactive', 'Inactive', 920)
  ) AS v(value, label, sort_order)
  WHERE d.category = 'user_status'
  ON CONFLICT (lookup_definition_id, value) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_org,
    'Command Scope Identity Org',
    'command-scope-identity-' || left(v_org::text, 8)
  );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'Command Scope Identity Client',
    'command-scope-client-' || left(v_client::text, 8),
    'active'
  );

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (
    v_sender,
    v_client,
    'Command Scope Identity Sender',
    'active'
  );

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
  VALUES
    (
      v_tenant_user,
      v_org,
      'command-scope-tenant@example.test',
      'Command Scope Tenant Operator',
      'ops_admin',
      'tenant',
      NULL,
      'active'
    ),
    (
      v_platform_user,
      v_org,
      'command-scope-platform@example.test',
      'Command Scope Platform Operator',
      'super_admin',
      'platform',
      NULL,
      'active'
    ),
    (
      v_client_user,
      v_org,
      'command-scope-client@example.test',
      'Command Scope Client Operator',
      'account_manager',
      'client',
      v_client,
      'active'
    ),
    (
      v_sender_user,
      v_org,
      'command-scope-sender@example.test',
      'Command Scope Sender Operator',
      'account_manager',
      'sender',
      v_sender,
      'active'
    ),
    (
      v_invited_user,
      v_org,
      'command-scope-invited@example.test',
      'Command Scope Invited Operator',
      'ops_admin',
      'tenant',
      NULL,
      'invited'
    ),
    (
      v_inactive_user,
      v_org,
      'command-scope-inactive@example.test',
      'Command Scope Inactive Operator',
      'ops_admin',
      'tenant',
      NULL,
      'inactive'
    ),
    (
      v_suspended_user,
      v_org,
      'command-scope-suspended@example.test',
      'Command Scope Suspended Operator',
      'ops_admin',
      'tenant',
      NULL,
      'suspended'
    );

  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM public.provision_rbac_roles_from_templates_v1(
    v_org,
    ARRAY['ops_admin'],
    v_tenant_user
  );

  INSERT INTO public.rbac_user_role_assignments (
    organization_id,
    user_id,
    role_id,
    assigned_by_user_id,
    metadata
  )
  SELECT
    v_org,
    v_tenant_user,
    r.id,
    v_tenant_user,
    jsonb_build_object('source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  RETURN NEXT has_function(
    'api',
    'ui_me_v1',
    ARRAY[]::text[],
    'api.ui_me_v1 exists for browser Supabase clients'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_me_v1()', 'EXECUTE'),
    'authenticated can execute api.ui_me_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege('anon', 'api.ui_me_v1()', 'EXECUTE'),
    'anon cannot execute api.ui_me_v1'
  );
  RETURN NEXT has_function(
    'public',
    'ui_me_v1',
    ARRAY[]::text[],
    'public.ui_me_v1 exists for shared identity hydration'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.ui_me_v1()', 'EXECUTE'),
    'authenticated can execute public.ui_me_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege('anon', 'public.ui_me_v1()', 'EXECUTE'),
    'anon cannot execute public.ui_me_v1'
  );

  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_tenant_user::text,
      'role', 'authenticated',
      'email', 'command-scope-tenant@example.test'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_me_v1() INTO v_api_me;
  SELECT public.ui_me_v1() INTO v_public_me;

  RETURN NEXT is(
    public.current_user_scope_id(),
    v_org,
    'tenant policy scope resolves to organization id'
  );
  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_type}',
    'tenant',
    'api.ui_me_v1 returns tenant identity type'
  );
  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_id}',
    NULL,
    'api.ui_me_v1 keeps tenant frontend identity scope id null'
  );
  RETURN NEXT is(
    v_public_me #>> '{access_scope,scope_id}',
    NULL,
    'public.ui_me_v1 keeps tenant frontend identity scope id null'
  );
  RETURN NEXT is(
    v_api_me - 'settings_resolution_id',
    v_public_me - 'settings_resolution_id',
    'tenant api.ui_me_v1 matches stable public identity contract fields'
  );
  RETURN NEXT ok(
    COALESCE(jsonb_array_length(v_api_me->'capabilities'), 0) > 0,
    'policy scope still resolves tenant operator capabilities'
  );
  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_label}',
    'Command Scope Identity Org',
    'tenant identity remains readable without exposing policy scope id'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_platform_user::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_me_v1() INTO v_api_me;
  SELECT public.ui_me_v1() INTO v_public_me;

  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_type}',
    'platform',
    'platform identity type remains frontend canonical'
  );
  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_id}',
    NULL,
    'platform frontend identity scope id remains null'
  );
  RETURN NEXT ok(
    v_api_me->'capabilities' ? '*',
    'platform super admin resolves global wildcard capability'
  );
  RETURN NEXT is(
    v_api_me - 'settings_resolution_id',
    v_public_me - 'settings_resolution_id',
    'platform api.ui_me_v1 matches stable public identity contract fields'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_client_user::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_me_v1() INTO v_api_me;
  SELECT public.ui_me_v1() INTO v_public_me;

  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_id}',
    v_client::text,
    'client frontend identity returns the exact stored scope id'
  );
  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_label}',
    'Command Scope Identity Client',
    'client frontend identity returns the canonical client label'
  );
  RETURN NEXT is(
    v_api_me - 'settings_resolution_id',
    v_public_me - 'settings_resolution_id',
    'client api.ui_me_v1 matches stable public identity contract fields'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_sender_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sender_user::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_me_v1() INTO v_api_me;
  SELECT public.ui_me_v1() INTO v_public_me;

  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_id}',
    v_sender::text,
    'sender frontend identity returns the exact stored scope id'
  );
  RETURN NEXT is(
    v_api_me #>> '{access_scope,scope_label}',
    'Command Scope Identity Sender',
    'sender frontend identity returns the canonical sender label'
  );
  RETURN NEXT is(
    v_api_me - 'settings_resolution_id',
    v_public_me - 'settings_resolution_id',
    'sender api.ui_me_v1 matches stable public identity contract fields'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_invited_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_invited_user::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    'SELECT public.ui_me_v1()',
    'ui_me_v1 requires an active Console user profile',
    'public.ui_me_v1 fails closed for invited users'
  );
  RETURN NEXT throws_ok(
    'SELECT api.ui_me_v1()',
    'ui_me_v1 requires an active Console user profile',
    'api.ui_me_v1 fails closed for invited users'
  );
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT status FROM public.users WHERE id = v_invited_user),
    'invited',
    'identity hydration does not activate invited users'
  );

  PERFORM set_config('request.jwt.claim.sub', v_inactive_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_inactive_user::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    'SELECT public.ui_me_v1()',
    'ui_me_v1 requires an active Console user profile',
    'public.ui_me_v1 fails closed for inactive users'
  );
  RETURN NEXT throws_ok(
    'SELECT api.ui_me_v1()',
    'ui_me_v1 requires an active Console user profile',
    'api.ui_me_v1 fails closed for inactive users'
  );
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT status FROM public.users WHERE id = v_inactive_user),
    'inactive',
    'identity hydration leaves inactive users unchanged'
  );

  PERFORM set_config('request.jwt.claim.sub', v_suspended_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_suspended_user::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    'SELECT public.ui_me_v1()',
    'ui_me_v1 requires an active Console user profile',
    'public.ui_me_v1 fails closed for suspended users'
  );
  RETURN NEXT throws_ok(
    'SELECT api.ui_me_v1()',
    'ui_me_v1 requires an active Console user profile',
    'api.ui_me_v1 fails closed for suspended users'
  );
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT status FROM public.users WHERE id = v_suspended_user),
    'suspended',
    'identity hydration leaves suspended users unchanged'
  );

  PERFORM set_config('request.jwt.claim.sub', v_missing_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_missing_user::text,
      'role', 'authenticated',
      'email', 'missing-command-scope-identity@example.test'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    'SELECT public.ui_me_v1()',
    'ui_me_v1 requires a Console user profile',
    'public.ui_me_v1 fails closed when the authenticated profile is missing'
  );
  RETURN NEXT throws_ok(
    'SELECT api.ui_me_v1()',
    'ui_me_v1 requires a Console user profile',
    'api.ui_me_v1 preserves the fail-closed identity contract'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_command_scope_identity_guard_v1();

SELECT * FROM finish();

ROLLBACK;

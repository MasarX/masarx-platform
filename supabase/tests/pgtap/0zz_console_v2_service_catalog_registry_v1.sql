-- pgTAP: Console V2 service catalog registry is complete for backend-backed UI.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_service_catalog_registry_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000054211001';
  v_user UUID := '00000000-0000-0000-0000-000054211002';
  v_registry JSONB;
  v_offerings JSONB;
  v_levels JSONB;
  v_branches JSONB;
  v_subscriptions JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Service Catalog Registry Org', 'console-v2-service-catalog-registry')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_tenant_service_catalog_defaults_v1(
    v_org,
    public.resolve_saas_onboarding_policy_v1(),
    'pgtap:console-service-catalog-registry'
  );

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    'console-v2-service-catalog-registry@example.test',
    'Console V2 Service Catalog Registry',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

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

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  SELECT public.ui_rpc_registry_v1('tenant', v_org)
    INTO v_registry;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_registry->'resources') AS item(value)
       WHERE item.value->>'key' = 'service_offering_directory'
         AND item.value->>'relation' = 'api.service_offering_directory'
         AND item.value->>'read_relation' = 'public.console_service_offering_api_read_v1'
    ),
    'tenant ui_read_registry exposes service_offering_directory'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_registry->'resources') AS item(value)
       WHERE item.value->>'key' = 'service_level_directory'
         AND item.value->>'relation' = 'api.service_level_directory'
    ),
    'tenant ui_read_registry exposes service_level_directory'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_registry->'resources') AS item(value)
       WHERE item.value->>'key' = 'branches'
         AND item.value->>'relation' = 'public.v_branch_directory'
    ),
    'tenant ui_read_registry exposes branches for the create-offering selector'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_registry->'resources') AS item(value)
       WHERE item.value->>'key' = 'subscriptions'
         AND item.value->>'relation' = 'public.subscriptions'
    ),
    'tenant ui_read_registry exposes subscriptions for catalog counters'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'email', 'console-v2-service-catalog-registry@example.test'
    )::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_list_resource_v1('service_offering_directory', '{}'::jsonb, 20, 0, '[]'::jsonb)
    INTO v_offerings;
  SELECT api.ui_list_resource_v1('service_level_directory', '{}'::jsonb, 20, 0, '[]'::jsonb)
    INTO v_levels;
  SELECT api.ui_list_resource_v1('branches', '{}'::jsonb, 20, 0, '[]'::jsonb)
    INTO v_branches;
  SELECT api.ui_list_resource_v1('subscriptions', '{}'::jsonb, 20, 0, '[]'::jsonb)
    INTO v_subscriptions;

  RETURN NEXT ok(
    COALESCE(jsonb_array_length(v_offerings->'items'), 0) > 0,
    'api.ui_list_resource_v1 returns service offerings for the tenant operator'
  );

  RETURN NEXT ok(
    COALESCE(jsonb_array_length(v_levels->'items'), 0) > 0,
    'api.ui_list_resource_v1 returns service levels for the tenant operator'
  );

  RETURN NEXT ok(
    jsonb_typeof(v_branches->'items') = 'array',
    'api.ui_list_resource_v1 can read branches for the tenant operator'
  );

  RETURN NEXT ok(
    jsonb_typeof(v_subscriptions->'items') = 'array',
    'api.ui_list_resource_v1 can read subscriptions for the tenant operator'
  );

  RETURN NEXT is(
    (
      SELECT row.metadata->>'lifecycle'
        FROM api.list_lookup_values_v1('service_offering_status') AS row
       WHERE row.value = 'active'
       LIMIT 1
    ),
    'active',
    'live service_offering_status lookup carries lifecycle metadata for frontend KPIs'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_service_catalog_registry_v1();

SELECT * FROM finish();

ROLLBACK;

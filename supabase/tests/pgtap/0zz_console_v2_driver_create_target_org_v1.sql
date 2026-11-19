-- pgTAP: Console V2 platform-led tenant onboarding must create drivers in
-- the selected tenant, while normal tenant users remain scoped to their own org.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT has_function(
  'api',
  'create_driver_v1',
  ARRAY['jsonb'],
  'api.create_driver_v1(jsonb) exists for browser Supabase clients'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.create_driver_v1(jsonb)', 'EXECUTE'),
  'authenticated users can execute api.create_driver_v1 through capability gates'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.create_driver_v1(jsonb)')) ~ 'p_args->>''organization_id''',
  'create_driver_v1 accepts an explicit organization_id target'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.create_driver_v1(jsonb)')) ~ 'NOT public\.is_platform_user\(\)',
  'create_driver_v1 permits cross-tenant targeting only for platform users'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.create_driver_v1(jsonb)')) ~ 'v_user\.organization_id <> v_target_org_id',
  'create_driver_v1 validates the selected driver user belongs to the target tenant'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'decision_category'
      AND lv.value = 'fleet.driver_created'
      AND lv.status = 'active'
  ),
  'decision_category lookup includes fleet.driver_created for driver creation audit logs'
);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_platform_create_driver_target_org()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_platform_org UUID := '57140460-2e69-4c86-8140-011ec18f7c00'::uuid;
  v_target_org UUID := '57140460-2e69-4c86-8140-011ec18f7c01'::uuid;
  v_other_org UUID := '57140460-2e69-4c86-8140-011ec18f7c02'::uuid;
  v_platform_user UUID := '57140460-2e69-4c86-8140-011ec18f7c10'::uuid;
  v_target_user UUID := '57140460-2e69-4c86-8140-011ec18f7c11'::uuid;
  v_tenant_user UUID := '57140460-2e69-4c86-8140-011ec18f7c12'::uuid;
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_platform_org, 'Console V2 Driver Platform Org', 'console-v2-driver-platform-org'),
    (v_target_org, 'Console V2 Driver Target Org', 'console-v2-driver-target-org'),
    (v_other_org, 'Console V2 Driver Other Org', 'console-v2-driver-other-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status
  )
  VALUES
    (
      v_platform_user,
      v_platform_org,
      'console-v2-driver-platform@example.test',
      'Console V2 Driver Platform Admin',
      'super_admin',
      'platform',
      NULL,
      'active'
    ),
    (
      v_target_user,
      v_target_org,
      'console-v2-driver-target@example.test',
      'Console V2 Driver Target User',
      'driver',
      'tenant',
      NULL,
      'active'
    ),
    (
      v_tenant_user,
      v_other_org,
      'console-v2-driver-tenant@example.test',
      'Console V2 Driver Tenant Admin',
      'ops_admin',
      'tenant',
      NULL,
      'active'
    )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      status = EXCLUDED.status;

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_platform_user,
      'role', 'authenticated',
      'email', 'console-v2-driver-platform@example.test'
    )::TEXT,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.create_driver_v1(
    jsonb_build_object(
      'organization_id', v_target_org,
      'user_id', v_target_user,
      'driver_code', 'PGTAP-TARGET-ORG',
      'status', 'active'
    )
  ) INTO v_result;

  RETURN NEXT ok(
    (v_result->>'ok')::BOOLEAN
      AND v_result->>'organization_id' = v_target_org::TEXT
      AND v_result->>'driver_user_id' = v_target_user::TEXT,
    'platform operator can create driver in selected active tenant'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.driver_profiles dp
      WHERE dp.organization_id = v_target_org
        AND dp.user_id = v_target_user
        AND dp.driver_code = 'PGTAP-TARGET-ORG'
    ),
    'create_driver_v1 persists the driver profile under the selected tenant'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_tenant_user,
      'role', 'authenticated',
      'email', 'console-v2-driver-tenant@example.test'
    )::TEXT,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT api.create_driver_v1(
          jsonb_build_object(
            'organization_id', %L,
            'user_id', %L,
            'driver_code', 'PGTAP-DENIED',
            'status', 'active'
          )
        )
      $sql$,
      v_target_org::TEXT,
      v_target_user::TEXT
    ),
    '42501',
    NULL,
    'non-platform tenant user cannot create driver outside their own tenant'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_platform_create_driver_target_org();

SELECT * FROM finish();

ROLLBACK;

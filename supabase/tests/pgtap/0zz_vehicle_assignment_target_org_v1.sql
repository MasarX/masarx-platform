-- pgTAP: Console platform-led vehicle assignment must bind the selected
-- tenant vehicle to a selected tenant driver while tenant users stay scoped.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT has_function(
  'api',
  'assign_driver_to_vehicle_v1',
  ARRAY['jsonb'],
  'api.assign_driver_to_vehicle_v1(jsonb) exists for browser Supabase clients'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.assign_driver_to_vehicle_v1(jsonb)', 'EXECUTE'),
  'authenticated users can execute api.assign_driver_to_vehicle_v1 through capability gates'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.assign_driver_to_vehicle_v1(jsonb)')) ~ 'p_args->>''organization_id''',
  'assign_driver_to_vehicle_v1 accepts an explicit organization_id target'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.assign_driver_to_vehicle_v1(jsonb)')) ~ 'NOT public\.is_platform_user\(\)',
  'assign_driver_to_vehicle_v1 permits cross-tenant targeting only for platform users'
);

CREATE OR REPLACE FUNCTION pg_temp.test_console_platform_vehicle_assignment_target_org()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_platform_org UUID := '57140462-2e69-4c86-8140-011ec18f7c00'::uuid;
  v_target_org UUID := '57140462-2e69-4c86-8140-011ec18f7c01'::uuid;
  v_other_org UUID := '57140462-2e69-4c86-8140-011ec18f7c02'::uuid;
  v_platform_user UUID := '57140462-2e69-4c86-8140-011ec18f7c10'::uuid;
  v_tenant_user UUID := '57140462-2e69-4c86-8140-011ec18f7c11'::uuid;
  v_driver_user UUID := '57140462-2e69-4c86-8140-011ec18f7c12'::uuid;
  v_vehicle UUID := '57140462-2e69-4c86-8140-011ec18f7c20'::uuid;
  v_branch UUID := '57140462-2e69-4c86-8140-011ec18f7c21'::uuid;
  v_driver_profile UUID := '57140462-2e69-4c86-8140-011ec18f7c30'::uuid;
  v_result JSONB;
  v_assignment UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_platform_org, 'Console Vehicle Assignment Platform Org', 'console-vehicle-assignment-platform-org'),
    (v_target_org, 'Console Vehicle Assignment Target Org', 'console-vehicle-assignment-target-org'),
    (v_other_org, 'Console Vehicle Assignment Other Org', 'console-vehicle-assignment-other-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_target_org, 'vehicle-assignment-main', 'Vehicle Assignment Branch', 'UTC', TRUE)
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      code = EXCLUDED.code,
      name = EXCLUDED.name,
      is_active = EXCLUDED.is_active;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status
  )
  VALUES
    (
      v_platform_user,
      v_platform_org,
      'console-vehicle-assignment-platform@example.test',
      'Console Vehicle Assignment Platform Admin',
      'super_admin',
      'platform',
      NULL,
      'active'
    ),
    (
      v_tenant_user,
      v_other_org,
      'console-vehicle-assignment-tenant@example.test',
      'Console Vehicle Assignment Tenant Admin',
      'ops_admin',
      'tenant',
      NULL,
      'active'
    ),
    (
      v_driver_user,
      v_target_org,
      'console-vehicle-assignment-driver@example.test',
      'Console Vehicle Assignment Driver',
      'driver',
      'tenant',
      NULL,
      'active'
    )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      status = EXCLUDED.status;

  INSERT INTO public.vehicles (id, organization_id, branch_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_target_org, v_branch, 'PGTAP-ASSIGN-TARGET', 'active', TRUE)
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      branch_id = EXCLUDED.branch_id,
      plate_number = EXCLUDED.plate_number,
      status = EXCLUDED.status,
      is_active = EXCLUDED.is_active;

  INSERT INTO public.driver_profiles (id, organization_id, user_id, driver_code, status)
  VALUES (v_driver_profile, v_target_org, v_driver_user, 'PGTAP-ASSIGN-DRIVER', 'active')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_id = EXCLUDED.user_id,
      driver_code = EXCLUDED.driver_code,
      status = EXCLUDED.status;

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_platform_user,
      'role', 'authenticated',
      'email', 'console-vehicle-assignment-platform@example.test'
    )::TEXT,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.assign_driver_to_vehicle_v1(
    jsonb_build_object(
      'organization_id', v_target_org,
      'vehicle_id', v_vehicle,
      'driver_user_id', v_driver_user
    )
  ) INTO v_result;

  v_assignment := (v_result->>'vehicle_assignment_id')::UUID;

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::BOOLEAN, FALSE)
      AND v_result->>'organization_id' = v_target_org::TEXT
      AND v_result->>'driver_user_id' = v_driver_user::TEXT
      AND v_result ? 'vehicle_assignment_id',
    'platform operator can assign selected tenant driver to selected tenant vehicle'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.vehicle_assignments va
      WHERE va.id = v_assignment
        AND va.organization_id = v_target_org
        AND va.vehicle_id = v_vehicle
        AND va.assigned_to_user_id = v_driver_user
        AND va.status = 'active'
        AND va.ended_at IS NULL
    ),
    'assign_driver_to_vehicle_v1 persists the active assignment under the selected tenant'
  );

  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_tenant_user,
      'role', 'authenticated',
      'email', 'console-vehicle-assignment-tenant@example.test'
    )::TEXT,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT api.assign_driver_to_vehicle_v1(
          jsonb_build_object(
            'organization_id', %L,
            'vehicle_id', %L,
            'driver_user_id', %L
          )
        )
      $sql$,
      v_target_org::TEXT,
      v_vehicle::TEXT,
      v_driver_user::TEXT
    ),
    '42501',
    NULL,
    'non-platform tenant user cannot assign a vehicle outside their own tenant'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_platform_vehicle_assignment_target_org();

SELECT * FROM finish();

ROLLBACK;

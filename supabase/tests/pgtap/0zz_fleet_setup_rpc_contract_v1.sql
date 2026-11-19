-- pgTAP: Fleet setup RPC contract for Dispatch assignment proof prep.
-- Proves Console-safe api wrappers delegate to canonical public RPCs and write
-- backend SSOT rows/readback projections without direct UI table mutation.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

CREATE OR REPLACE FUNCTION test_fleet_setup_rpc_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '0fd00300-0000-0000-0000-000000000001'::uuid;
  v_branch UUID := '0fd00300-0000-0000-0000-000000000101'::uuid;
  v_fleet_user UUID := '0fd00300-0000-0000-0000-000000000201'::uuid;
  v_limited_user UUID := '0fd00300-0000-0000-0000-000000000202'::uuid;
  v_driver_user UUID := '0fd00300-0000-0000-0000-000000000203'::uuid;
  v_vehicle_type UUID := '0fd00300-0000-0000-0000-000000000301'::uuid;

  v_driver_result JSONB;
  v_vehicle_result JSONB;
  v_assign_result JSONB;
  v_driver_profile_id UUID;
  v_vehicle_id UUID;
  v_assignment_id UUID;
BEGIN
  RETURN NEXT has_function('public', 'create_driver_v1', ARRAY['jsonb'], 'public.create_driver_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'create_vehicle_v1', ARRAY['jsonb'], 'public.create_vehicle_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'assign_driver_to_vehicle_v1', ARRAY['jsonb'], 'public.assign_driver_to_vehicle_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'create_driver_v1', ARRAY['jsonb'], 'api.create_driver_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'create_vehicle_v1', ARRAY['jsonb'], 'api.create_vehicle_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'assign_driver_to_vehicle_v1', ARRAY['jsonb'], 'api.assign_driver_to_vehicle_v1(jsonb) exists');

  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.create_driver_v1(jsonb)', 'EXECUTE')
    AND NOT COALESCE(has_function_privilege('anon', 'api.create_driver_v1(jsonb)', 'EXECUTE'), FALSE),
    'api.create_driver_v1 is executable for authenticated users and denied to anon'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.create_vehicle_v1(jsonb)', 'EXECUTE')
    AND NOT COALESCE(has_function_privilege('anon', 'api.create_vehicle_v1(jsonb)', 'EXECUTE'), FALSE),
    'api.create_vehicle_v1 is executable for authenticated users and denied to anon'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.assign_driver_to_vehicle_v1(jsonb)', 'EXECUTE')
    AND NOT COALESCE(has_function_privilege('anon', 'api.assign_driver_to_vehicle_v1(jsonb)', 'EXECUTE'), FALSE),
    'api.assign_driver_to_vehicle_v1 is executable for authenticated users and denied to anon'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Fleet Setup RPC Contract Org', 'fleet-setup-rpc-contract');

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'fleet-setup', 'Fleet Setup Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES
    (v_fleet_user, v_org, 'fleet-setup-manager@example.com', 'Fleet Setup Manager', 'fleet_manager', 'tenant', NULL, 'active'),
    (v_limited_user, v_org, 'fleet-setup-limited@example.com', 'Fleet Setup Limited', 'client_admin', 'tenant', NULL, 'active'),
    (v_driver_user, v_org, 'fleet-setup-driver@example.com', 'Fleet Setup Driver', 'driver', 'tenant', NULL, 'active');

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active, metadata)
  VALUES (
    v_vehicle_type,
    v_org,
    'fleet-setup-van',
    'Fleet Setup Van',
    TRUE,
    jsonb_build_object('source', '0zz_fleet_setup_rpc_contract_v1')
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['fleet_manager'], v_fleet_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_fleet_user, r.id, v_fleet_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.create_driver_v1(jsonb_build_object('driver_user_id', %L, 'driver_code', 'FSET-DENIED')) $q$,
      v_driver_user
    ),
    '42501',
    NULL,
    'limited user cannot set up a driver profile through api.create_driver_v1'
  );

  PERFORM set_config('request.jwt.claim.sub', v_fleet_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  v_driver_result := api.create_driver_v1(jsonb_build_object(
    'driver_user_id', v_driver_user,
    'driver_code', 'FSET-DRV-01',
    'metadata', jsonb_build_object('source', '0zz_fleet_setup_rpc_contract_v1')
  ));
  v_driver_profile_id := (v_driver_result->>'driver_profile_id')::uuid;

  RETURN NEXT ok(COALESCE((v_driver_result->>'ok')::boolean, FALSE), 'api.create_driver_v1 returns ok');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.driver_profiles dp
       WHERE dp.id = v_driver_profile_id
         AND dp.organization_id = v_org
         AND dp.user_id = v_driver_user
         AND dp.status IS NOT NULL
    ),
    'api.create_driver_v1 writes canonical driver_profiles row'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.driver_profile_picker_v1 dp
       WHERE dp.id = v_driver_user
         AND dp.organization_id = v_org
         AND dp.name = 'Fleet Setup Driver'
         AND dp.driver_code = 'FSET-DRV-01'
    ),
    'driver profile picker projects created driver profile for same-context readback'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_fleet_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  v_vehicle_result := api.create_vehicle_v1(jsonb_build_object(
    'plate_number', 'FSET-100',
    'vehicle_type_id', v_vehicle_type,
    'branch_id', v_branch,
    'make', 'MasarX',
    'model', 'Dispatch Proof Van',
    'metadata', jsonb_build_object('source', '0zz_fleet_setup_rpc_contract_v1')
  ));
  v_vehicle_id := (v_vehicle_result->>'vehicle_id')::uuid;

  RETURN NEXT ok(COALESCE((v_vehicle_result->>'ok')::boolean, FALSE), 'api.create_vehicle_v1 returns ok');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicles v
       WHERE v.id = v_vehicle_id
         AND v.organization_id = v_org
         AND v.branch_id = v_branch
         AND v.vehicle_type_id = v_vehicle_type
         AND v.plate_number = 'FSET-100'
    ),
    'api.create_vehicle_v1 writes canonical vehicles row'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.v_vehicle_directory vd
       WHERE vd.id = v_vehicle_id
         AND vd.organization_id = v_org
         AND vd.branch_id = v_branch
         AND vd.vehicle_type_id = v_vehicle_type
         AND vd.plate_number = 'FSET-100'
    ),
    'vehicle directory projects created vehicle for same-context readback'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_fleet_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  v_assign_result := api.assign_driver_to_vehicle_v1(jsonb_build_object(
    'vehicle_id', v_vehicle_id,
    'driver_user_id', v_driver_user,
    'branch_id', v_branch,
    'metadata', jsonb_build_object('source', '0zz_fleet_setup_rpc_contract_v1')
  ));
  v_assignment_id := (v_assign_result->>'vehicle_assignment_id')::uuid;

  RETURN NEXT ok(COALESCE((v_assign_result->>'ok')::boolean, FALSE), 'api.assign_driver_to_vehicle_v1 returns ok');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicle_assignments va
       WHERE va.id = v_assignment_id
         AND va.organization_id = v_org
         AND va.vehicle_id = v_vehicle_id
         AND va.assigned_to_user_id = v_driver_user
         AND va.branch_id = v_branch
         AND va.status = 'active'
         AND va.ended_at IS NULL
    ),
    'api.assign_driver_to_vehicle_v1 writes canonical active vehicle assignment'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.v_vehicle_directory vd
       WHERE vd.id = v_vehicle_id
         AND vd.current_driver_user_id = v_driver_user
    )
    AND EXISTS (
      SELECT 1
        FROM public.driver_profile_picker_v1 dp
       WHERE dp.id = v_driver_user
         AND dp.vehicle_id = v_vehicle_id
    ),
    'fleet directory projections read back the driver/vehicle assignment in place'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.domain_events de
       WHERE de.organization_id = v_org
         AND de.resource_id = v_driver_profile_id
         AND de.resource_type = 'driver_profile'
         AND de.event_type = 'fleet.driver_created'
    )
    AND EXISTS (
      SELECT 1
        FROM public.domain_events de
       WHERE de.organization_id = v_org
         AND de.resource_id = v_vehicle_id
         AND de.resource_type = 'vehicle'
         AND de.event_type = 'fleet.vehicle_created'
    )
    AND EXISTS (
      SELECT 1
        FROM public.domain_events de
       WHERE de.organization_id = v_org
         AND de.resource_id = v_assignment_id
         AND de.resource_type = 'vehicle_assignment'
         AND de.event_type = 'fleet.driver_assigned'
    ),
    'setup RPCs write canonical domain event lineage'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.organization_id = v_org
         AND dl.resource_id = v_assignment_id
         AND dl.resource_type = 'vehicle_assignment'
         AND dl.decision_category = 'fleet.driver_assigned'
         AND dl.performed_by_system = 'assign_driver_to_vehicle_v1'
    ),
    'assignment setup writes canonical decision_log lineage'
  );

  RETURN;
END;
$function$;

SELECT * FROM test_fleet_setup_rpc_contract_v1();

SELECT * FROM finish();

ROLLBACK;

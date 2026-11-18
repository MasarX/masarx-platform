-- pgTAP: Console V2 fleet vehicle write actions deny lower-permission users
-- before mutating vehicles, assignments, or vehicle lifecycle ledgers.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

CREATE OR REPLACE FUNCTION test_console_v2_fleet_vehicle_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000f751'::UUID;
  v_branch UUID := '00000000-0000-0000-0000-00000000f752'::UUID;
  v_ops UUID := '00000000-0000-0000-0000-00000000f753'::UUID;
  v_limited UUID := '00000000-0000-0000-0000-00000000f754'::UUID;
  v_driver_user UUID := '00000000-0000-0000-0000-00000000f755'::UUID;
  v_vehicle_type UUID := '00000000-0000-0000-0000-00000000f756'::UUID;
  v_active_vehicle UUID := '00000000-0000-0000-0000-00000000f757'::UUID;
  v_oos_vehicle UUID := '00000000-0000-0000-0000-00000000f758'::UUID;
  v_driver_profile UUID := '00000000-0000-0000-0000-00000000f759'::UUID;
  v_assignment UUID := '00000000-0000-0000-0000-00000000f75a'::UUID;
  v_ops_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'create_vehicle_v1', ARRAY['jsonb'], 'public.create_vehicle_v1(jsonb) exists');
  RETURN NEXT ok(
    to_regprocedure('api.create_vehicle_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.create_vehicle_v1(jsonb)', 'EXECUTE'),
    'api.create_vehicle_v1 wrapper is available to authenticated users'
  );
  RETURN NEXT ok(
    to_regprocedure('api.assign_driver_to_vehicle_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.assign_driver_to_vehicle_v1(jsonb)', 'EXECUTE'),
    'api.assign_driver_to_vehicle_v1 wrapper is available to authenticated users'
  );
  RETURN NEXT ok(
    to_regprocedure('api.mark_vehicle_oos_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.mark_vehicle_oos_v1(jsonb)', 'EXECUTE'),
    'api.mark_vehicle_oos_v1 wrapper is available to authenticated users'
  );
  RETURN NEXT ok(
    to_regprocedure('api.restore_vehicle_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.restore_vehicle_v1(jsonb)', 'EXECUTE'),
    'api.restore_vehicle_v1 wrapper is available to authenticated users'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Fleet Vehicle Denied Org', 'console-v2-fleet-vehicle-denied');

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'fleet-denied', 'Fleet Denied Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES
    (v_ops, v_org, 'fleet-vehicle-denied-ops@example.com', 'Fleet Vehicle Denied Ops', 'fleet_manager', 'tenant', NULL, 'active'),
    (v_limited, v_org, 'fleet-vehicle-denied-limited@example.com', 'Fleet Vehicle Denied Limited', 'client_admin', 'tenant', NULL, 'active'),
    (v_driver_user, v_org, 'fleet-vehicle-denied-driver@example.com', 'Fleet Vehicle Denied Driver', 'driver', 'tenant', NULL, 'active');

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type, v_org, 'fleet-denied-van', 'Fleet Denied Van', TRUE);

  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES
    (v_active_vehicle, v_org, v_branch, v_vehicle_type, 'DENIED-ACTIVE-1', 'active', TRUE),
    (v_oos_vehicle, v_org, v_branch, v_vehicle_type, 'DENIED-OOS-1', 'oos', TRUE);

  INSERT INTO public.driver_profiles (id, organization_id, user_id, status)
  VALUES (v_driver_profile, v_org, v_driver_user, 'active');

  INSERT INTO public.vehicle_assignments (id, organization_id, vehicle_id, assigned_to_user_id, branch_id, status, started_at)
  VALUES (v_assignment, v_org, v_active_vehicle, v_driver_user, v_branch, 'active', now() - interval '1 hour');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['fleet_manager'], v_ops);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_ops, r.id, v_ops, jsonb_build_object('seed', TRUE, 'source', 'pgtap')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);

  RETURN NEXT ok(
    NOT public.user_has_capability_v1('fleet.write', 'tenant', v_org),
    'limited fleet user lacks tenant fleet.write'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  RETURN NEXT ok(
    public.user_has_capability_v1('fleet.write', 'tenant', v_org),
    'fleet ops user has tenant fleet.write'
  );

  PERFORM set_config('request.jwt.claim.sub', v_limited::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.create_vehicle_v1(jsonb_build_object('plate_number', 'DENIED-CREATE-1', 'vehicle_type_id', %L, 'branch_id', %L)) $q$,
      v_vehicle_type,
      v_branch
    ),
    '42501',
    NULL,
    'limited user denied public create_vehicle_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.create_vehicle_v1(jsonb_build_object('plate_number', 'DENIED-CREATE-2', 'vehicle_type_id', %L, 'branch_id', %L)) $q$,
      v_vehicle_type,
      v_branch
    ),
    '42501',
    NULL,
    'limited user denied api create_vehicle_v1'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.vehicles WHERE organization_id = v_org),
    2,
    'denied create attempts write no vehicle rows'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.assign_driver_to_vehicle_v1(jsonb_build_object('vehicle_id', %L, 'driver_user_id', %L)) $q$,
      v_active_vehicle,
      v_driver_user
    ),
    '42501',
    NULL,
    'limited user denied public assign_driver_to_vehicle_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.assign_driver_to_vehicle_v1(jsonb_build_object('vehicle_id', %L, 'driver_user_id', %L)) $q$,
      v_active_vehicle,
      v_driver_user
    ),
    '42501',
    NULL,
    'limited user denied api assign_driver_to_vehicle_v1'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    (SELECT COUNT(*)::INT FROM public.vehicle_assignments WHERE organization_id = v_org) = 1
    AND EXISTS (
      SELECT 1
        FROM public.vehicle_assignments
       WHERE id = v_assignment
         AND organization_id = v_org
         AND vehicle_id = v_active_vehicle
         AND assigned_to_user_id = v_driver_user
         AND status = 'active'
         AND ended_at IS NULL
    ),
    'denied assignment attempts leave active assignment unchanged'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.mark_vehicle_oos_v1(jsonb_build_object('vehicle_id', %L, 'reason', 'denied oos attempt')) $q$,
      v_active_vehicle
    ),
    '42501',
    NULL,
    'limited user denied public mark_vehicle_oos_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.mark_vehicle_oos_v1(jsonb_build_object('vehicle_id', %L, 'reason', 'denied oos attempt')) $q$,
      v_active_vehicle
    ),
    '42501',
    NULL,
    'limited user denied api mark_vehicle_oos_v1'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicles
       WHERE id = v_active_vehicle
         AND organization_id = v_org
         AND status = 'active'
    )
    AND EXISTS (
      SELECT 1
        FROM public.vehicle_assignments
       WHERE id = v_assignment
         AND status = 'active'
         AND ended_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
        FROM public.vehicle_events
       WHERE organization_id = v_org
         AND vehicle_id = v_active_vehicle
         AND event_type = 'oos_marked'
    ),
    'denied OOS attempts leave vehicle, assignment, and event ledger unchanged'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.restore_vehicle_v1(jsonb_build_object('vehicle_id', %L, 'notes', 'denied restore attempt')) $q$,
      v_oos_vehicle
    ),
    '42501',
    NULL,
    'limited user denied public restore_vehicle_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.restore_vehicle_v1(jsonb_build_object('vehicle_id', %L, 'notes', 'denied restore attempt')) $q$,
      v_oos_vehicle
    ),
    '42501',
    NULL,
    'limited user denied api restore_vehicle_v1'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicles
       WHERE id = v_oos_vehicle
         AND organization_id = v_org
         AND status = 'oos'
    )
    AND NOT EXISTS (
      SELECT 1
        FROM public.vehicle_events
       WHERE organization_id = v_org
         AND vehicle_id = v_oos_vehicle
         AND event_type = 'oos_restored'
    ),
    'denied restore attempts leave OOS vehicle and event ledger unchanged'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_ops::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  v_ops_result := api.create_vehicle_v1(jsonb_build_object(
    'plate_number', 'OPS-CREATE-1',
    'vehicle_type_id', v_vehicle_type,
    'branch_id', v_branch,
    'metadata', jsonb_build_object('source', 'pgtap')
  ));
  RETURN NEXT ok(
    COALESCE((v_ops_result->>'ok')::BOOLEAN, FALSE)
    AND v_ops_result ? 'vehicle_id',
    'fleet ops user can still create vehicles through api wrapper'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_console_v2_fleet_vehicle_write_denied_state_v1();

SELECT * FROM finish();

ROLLBACK;

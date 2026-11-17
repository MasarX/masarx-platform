-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Fleet foundation v1 (vehicles + assignments + maintenance windows)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(34);

CREATE OR REPLACE FUNCTION test_fleet_foundation_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0f100000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0f200000-0000-0000-0000-000000000002'::uuid;

  v_branch1 UUID := '0f100000-0000-0000-0000-000000000101'::uuid;
  v_branch2 UUID := '0f200000-0000-0000-0000-000000000102'::uuid;

  v_client1 UUID := '0f100000-0000-0000-0000-000000000201'::uuid;
  v_sender1 UUID := '0f100000-0000-0000-0000-000000000301'::uuid;

  v_tenant_user1 UUID := '0f100000-0000-0000-0000-000000000401'::uuid;
  v_tenant_user2 UUID := '0f200000-0000-0000-0000-000000000402'::uuid;
  v_client_user1 UUID := '0f100000-0000-0000-0000-000000000403'::uuid;
  v_sender_user1 UUID := '0f100000-0000-0000-0000-000000000404'::uuid;

  v_vehicle_type1 UUID := '0f100000-0000-0000-0000-000000000501'::uuid;
  v_vehicle_type2 UUID := '0f200000-0000-0000-0000-000000000502'::uuid;

  v_vehicle1 UUID := '0f100000-0000-0000-0000-000000000601'::uuid;
  v_vehicle2 UUID := '0f200000-0000-0000-0000-000000000602'::uuid;
  v_vehicle3 UUID := '0f100000-0000-0000-0000-000000000603'::uuid;

  v_assignment1 UUID := '0f100000-0000-0000-0000-000000000701'::uuid;
  v_assignment2 UUID := '0f100000-0000-0000-0000-000000000702'::uuid;

  v_window1 UUID := '0f100000-0000-0000-0000-000000000801'::uuid;
BEGIN
  RETURN NEXT has_table('public', 'vehicle_types', 'vehicle_types table exists');
  RETURN NEXT has_table('public', 'vehicles', 'vehicles table exists');
  RETURN NEXT has_table('public', 'vehicle_assignments', 'vehicle_assignments table exists');
  RETURN NEXT has_table('public', 'vehicle_maintenance_windows', 'vehicle_maintenance_windows table exists');

  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'vehicle_types'), 'RLS enabled on vehicle_types');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'vehicles'), 'RLS enabled on vehicles');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'vehicle_assignments'), 'RLS enabled on vehicle_assignments');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'vehicle_maintenance_windows'), 'RLS enabled on vehicle_maintenance_windows');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'vehicle_types'),
    'vehicle_types registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'vehicles'),
    'vehicles registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'vehicle_assignments'),
    'vehicle_assignments registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'vehicle_maintenance_windows'),
    'vehicle_maintenance_windows registered in table_contracts'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'vehicles'
        AND indexname = 'idx_vehicles_org_plate_upper'
    ),
    'vehicles has idx_vehicles_org_plate_upper'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'vehicle_assignments'
        AND indexname = 'idx_vehicle_assignments_vehicle_active'
    ),
    'vehicle_assignments has idx_vehicle_assignments_vehicle_active'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Fleet Org 1', 'fleet-org-' || left(v_org1::text, 8)),
    (v_org2, 'Fleet Org 2', 'fleet-org-' || left(v_org2::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_branch1, v_org1, 'fleet-b1', 'Fleet Branch 1', 'UTC', TRUE),
    (v_branch2, v_org2, 'fleet-b2', 'Fleet Branch 2', 'UTC', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client1, v_org1, 'Fleet Client', 'fleet-client-' || left(v_client1::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender1, v_client1, 'Fleet Sender', 'Fleet Sender', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES
    (v_tenant_user1, v_org1, 'fleet-u1-' || left(v_tenant_user1::text, 8) || '@example.com', 'Fleet Tenant 1', 'tenant', NULL),
    (v_tenant_user2, v_org2, 'fleet-u2-' || left(v_tenant_user2::text, 8) || '@example.com', 'Fleet Tenant 2', 'tenant', NULL),
    (v_client_user1, v_org1, 'fleet-cu-' || left(v_client_user1::text, 8) || '@example.com', 'Fleet Client User', 'client', v_client1),
    (v_sender_user1, v_org1, 'fleet-su-' || left(v_sender_user1::text, 8) || '@example.com', 'Fleet Sender User', 'sender', v_sender1);

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES
    (v_vehicle_type1, v_org1, 'van', 'Van', TRUE),
    (v_vehicle_type2, v_org2, 'truck', 'Truck', TRUE);

  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES
    (v_vehicle1, v_org1, v_branch1, v_vehicle_type1, 'ABC-123', 'active', TRUE),
    (v_vehicle2, v_org2, v_branch2, v_vehicle_type2, 'XYZ-999', 'active', TRUE);

  RETURN NEXT lives_ok(
    format(
      $q$ INSERT INTO public.vehicle_assignments (id, organization_id, vehicle_id, assigned_to_user_id, branch_id, status)
          VALUES (%L, %L, %L, %L, %L, 'active') $q$,
      v_assignment1,
      v_org1,
      v_vehicle1,
      v_tenant_user1,
      v_branch1
    ),
    'vehicle_assignments insert allowed when org matches'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicles (organization_id, branch_id, vehicle_type_id, status)
          VALUES (%L, %L, %L, 'active') $q$,
      v_org1,
      v_branch2,
      v_vehicle_type1
    ),
    '23514',
    format('vehicles: organization mismatch (vehicle org %s, branch org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicles (organization_id, branch_id, vehicle_type_id, status)
          VALUES (%L, %L, %L, 'active') $q$,
      v_org1,
      v_branch1,
      v_vehicle_type2
    ),
    '23514',
    format('vehicles: organization mismatch (vehicle org %s, vehicle_type org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicle_assignments (organization_id, vehicle_id, assigned_to_user_id, branch_id, status)
          VALUES (%L, %L, %L, %L, 'active') $q$,
      v_org1,
      v_vehicle1,
      v_tenant_user1,
      v_branch2
    ),
    '23514',
    format('vehicle_assignments: organization mismatch (assignment org %s, branch org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicle_assignments (organization_id, vehicle_id, assigned_to_user_id, branch_id, status)
          VALUES (%L, %L, %L, %L, 'active') $q$,
      v_org1,
      v_vehicle1,
      v_tenant_user2,
      v_branch1
    ),
    '23514',
    format('vehicle_assignments: organization mismatch (assignment org %s, user org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicle_maintenance_windows (organization_id, vehicle_id, window_start_at, window_end_at)
          VALUES (%L, %L, now(), now() + interval '1 hour') $q$,
      v_org1,
      v_vehicle2
    ),
    '23514',
    format('vehicle_maintenance_windows: organization mismatch (window org %s, vehicle org %s)', v_org1, v_org2)
  );

  -- RBAC: fleet writes require fleet.write (least privilege).
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicle_types (organization_id, key, name, is_active)
          VALUES (%L, 'bike', 'Bike', TRUE) $q$,
      v_org1
    ),
    '42501',
    'new row violates row-level security policy for table "vehicle_types"'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicles (organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
          VALUES (%L, %L, %L, 'BBB-111', 'active', TRUE) $q$,
      v_org1,
      v_branch1,
      v_vehicle_type1
    ),
    '42501',
    'new row violates row-level security policy for table "vehicles"'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicle_assignments (organization_id, vehicle_id, assigned_to_user_id, branch_id, status)
          VALUES (%L, %L, %L, %L, 'active') $q$,
      v_org1,
      v_vehicle1,
      v_tenant_user1,
      v_branch1
    ),
    '42501',
    'new row violates row-level security policy for table "vehicle_assignments"'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.vehicle_maintenance_windows (organization_id, vehicle_id, window_start_at, window_end_at)
          VALUES (%L, %L, now(), now() + interval '1 hour') $q$,
      v_org1,
      v_vehicle1
    ),
    '42501',
    'new row violates row-level security policy for table "vehicle_maintenance_windows"'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_tenant_user1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_tenant_user1, r.id, v_tenant_user1, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1
    AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  INSERT INTO public.vehicle_types (organization_id, key, name, is_active)
  VALUES (v_org1, 'bike', 'Bike', TRUE);
  RETURN NEXT ok(
    (SELECT COUNT(*)::INT FROM public.vehicle_types WHERE organization_id = v_org1 AND key = 'bike') = 1,
    'RBAC: fleet_manager can write vehicle_types'
  );

  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle3, v_org1, v_branch1, v_vehicle_type1, 'BBB-111', 'active', TRUE);
  RETURN NEXT ok(
    (SELECT COUNT(*)::INT FROM public.vehicles WHERE organization_id = v_org1 AND id = v_vehicle3) = 1,
    'RBAC: fleet_manager can write vehicles'
  );

  INSERT INTO public.vehicle_assignments (id, organization_id, vehicle_id, assigned_to_user_id, branch_id, status)
  VALUES (v_assignment2, v_org1, v_vehicle3, v_tenant_user1, v_branch1, 'active');
  RETURN NEXT ok(
    (SELECT COUNT(*)::INT FROM public.vehicle_assignments WHERE organization_id = v_org1 AND id = v_assignment2) = 1,
    'RBAC: fleet_manager can write vehicle_assignments'
  );

  INSERT INTO public.vehicle_maintenance_windows (id, organization_id, vehicle_id, window_start_at, window_end_at)
  VALUES (v_window1, v_org1, v_vehicle3, now(), now() + interval '1 hour');
  RETURN NEXT ok(
    (SELECT COUNT(*)::INT FROM public.vehicle_maintenance_windows WHERE organization_id = v_org1 AND id = v_window1) = 1,
    'RBAC: fleet_manager can write vehicle_maintenance_windows'
  );

  -- tenant user (org1) can read fleet for own org only
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.vehicles), 2, 'tenant user sees own org vehicles only');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.vehicle_types), 2, 'tenant user sees own org vehicle_types only');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.vehicle_assignments), 2, 'tenant user sees own org vehicle_assignments only');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.vehicle_maintenance_windows), 1, 'tenant user sees own org vehicle_maintenance_windows only');

  -- client/sender users cannot read fleet
  PERFORM set_config('request.jwt.claim.sub', v_client_user1::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.vehicles), 0, 'client user cannot read vehicles');

  PERFORM set_config('request.jwt.claim.sub', v_sender_user1::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.vehicles), 0, 'sender user cannot read vehicles');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN;
END;
$function$;

SELECT * FROM test_fleet_foundation_v1();

SELECT * FROM finish();

ROLLBACK;

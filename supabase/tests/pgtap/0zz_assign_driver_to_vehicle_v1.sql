-- Plan: PHASE B / B2 — pgTAP for assign_driver_to_vehicle_v1
-- Asserts the canonical contract: capability gate (fleet.write), denied path,
-- happy path emits domain_event + decision_log + closes prior active assignment,
-- ladder context recorded, RLS prevents cross-tenant visibility of the row.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

CREATE OR REPLACE FUNCTION test_assign_driver_to_vehicle_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb01000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0fb01000-0000-0000-0000-000000000002'::uuid;
  v_client1 UUID := '0fb01000-0000-0000-0000-000000000201'::uuid;
  v_client2 UUID := '0fb01000-0000-0000-0000-000000000202'::uuid;
  v_sender1 UUID := '0fb01000-0000-0000-0000-000000000301'::uuid;
  v_sender2 UUID := '0fb01000-0000-0000-0000-000000000302'::uuid;
  v_branch1 UUID := '0fb01000-0000-0000-0000-000000000101'::uuid;
  v_branch2 UUID := '0fb01000-0000-0000-0000-000000000102'::uuid;

  v_admin_user1 UUID := '0fb01000-0000-0000-0000-000000000401'::uuid;
  v_unprivileged_user1 UUID := '0fb01000-0000-0000-0000-000000000402'::uuid;
  v_driver_user1 UUID := '0fb01000-0000-0000-0000-000000000501'::uuid;
  v_driver_user2 UUID := '0fb01000-0000-0000-0000-000000000502'::uuid;
  v_admin_user2 UUID := '0fb01000-0000-0000-0000-000000000403'::uuid;

  v_vehicle_type1 UUID := '0fb01000-0000-0000-0000-000000000601'::uuid;
  v_vehicle1 UUID := '0fb01000-0000-0000-0000-000000000701'::uuid;
  v_vehicle_type2 UUID := '0fb01000-0000-0000-0000-000000000602'::uuid;
  v_vehicle2 UUID := '0fb01000-0000-0000-0000-000000000702'::uuid;

  v_dp1 UUID := '0fb01000-0000-0000-0000-000000000801'::uuid;
  v_dp2 UUID := '0fb01000-0000-0000-0000-000000000802'::uuid;

  v_prior_assignment UUID := '0fb01000-0000-0000-0000-000000000901'::uuid;

  v_result JSONB;
  v_assignment_id UUID;
BEGIN
  -- 0) RPC must exist
  RETURN NEXT has_function('public', 'assign_driver_to_vehicle_v1', ARRAY['jsonb'],
                           'assign_driver_to_vehicle_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Assign Org 1', 'assign-org-' || right(replace(v_org1::text, '-', ''), 12)),
    (v_org2, 'Assign Org 2', 'assign-org-' || right(replace(v_org2::text, '-', ''), 12));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client1, v_org1, 'Assign Client 1', 'assign-client-' || right(replace(v_client1::text, '-', ''), 12), 'active'),
    (v_client2, v_org2, 'Assign Client 2', 'assign-client-' || right(replace(v_client2::text, '-', ''), 12), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender1, v_client1, 'Assign Sender 1', 'Assign Sender 1', TRUE, 'active'),
    (v_sender2, v_client2, 'Assign Sender 2', 'Assign Sender 2', TRUE, 'active');

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org1,
    'pgtap:assign-driver-to-vehicle-org1-fixture-bootstrap'
  );
  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org2,
    'pgtap:assign-driver-to-vehicle-org2-fixture-bootstrap'
  );

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_branch1, v_org1, 'assign-b1', 'Assign Branch 1', 'UTC', TRUE),
    (v_branch2, v_org2, 'assign-b2', 'Assign Branch 2', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_admin_user1, v_org1, 'assign-au1-' || left(v_admin_user1::text, 8) || '@example.com', 'Assign Admin 1', 'fleet_manager', 'tenant', NULL),
    (v_unprivileged_user1, v_org1, 'assign-uu1-' || left(v_unprivileged_user1::text, 8) || '@example.com', 'Assign Unprivileged', 'client_admin', 'tenant', NULL),
    (v_driver_user1, v_org1, 'assign-du1-' || left(v_driver_user1::text, 8) || '@example.com', 'Assign Driver 1', 'driver', 'tenant', NULL),
    (v_driver_user2, v_org2, 'assign-du2-' || left(v_driver_user2::text, 8) || '@example.com', 'Assign Driver 2', 'driver', 'tenant', NULL),
    (v_admin_user2, v_org2, 'assign-au2-' || left(v_admin_user2::text, 8) || '@example.com', 'Assign Admin 2', 'fleet_manager', 'tenant', NULL);

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES
    (v_vehicle_type1, v_org1, 'van-' || left(v_vehicle_type1::text, 6), 'Van', TRUE),
    (v_vehicle_type2, v_org2, 'van-' || left(v_vehicle_type2::text, 6), 'Van', TRUE);

  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES
    (v_vehicle1, v_org1, v_branch1, v_vehicle_type1, 'ASN-100', 'active', TRUE),
    (v_vehicle2, v_org2, v_branch2, v_vehicle_type2, 'ASN-200', 'active', TRUE);

  INSERT INTO public.driver_profiles (id, organization_id, user_id, status)
  VALUES
    (v_dp1, v_org1, v_driver_user1, 'active'),
    (v_dp2, v_org2, v_driver_user2, 'active');

  -- Provision fleet_manager for v_admin_user1 only
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_admin_user1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_admin_user1, r.id, v_admin_user1,
         jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  -- 1) Denied path: unprivileged tenant user cannot call the RPC
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_unprivileged_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT throws_ok(
    format($q$ SELECT public.assign_driver_to_vehicle_v1(jsonb_build_object('vehicle_id', %L, 'driver_user_id', %L)) $q$,
           v_vehicle1, v_driver_user1),
    '42501',
    NULL,
    'unprivileged tenant user is denied (Capability denied: fleet.write)'
  );

  -- 2) Happy path: fleet_manager can assign; envelope is canonical
  PERFORM set_config('request.jwt.claim.sub', v_admin_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  -- Seed a prior active assignment to test idempotent close-and-rebind
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.vehicle_assignments (id, organization_id, vehicle_id, assigned_to_user_id, branch_id, status, started_at)
  VALUES (v_prior_assignment, v_org1, v_vehicle1, v_admin_user1, v_branch1, 'active', now() - interval '1 day');

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  v_result := public.assign_driver_to_vehicle_v1(
    jsonb_build_object('vehicle_id', v_vehicle1, 'driver_user_id', v_driver_user1)
  );

  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'happy-path returns ok=TRUE');
  RETURN NEXT ok(v_result ? 'vehicle_assignment_id', 'envelope contains vehicle_assignment_id');
  RETURN NEXT ok(v_result ? 'correlation_id', 'envelope contains correlation_id');
  RETURN NEXT is(
    (v_result->>'closed_prior_active')::INT,
    1,
    'closed exactly one prior active assignment (idempotent rebind)'
  );

  v_assignment_id := (v_result->>'vehicle_assignment_id')::UUID;

  -- 3) Decision log + domain event were recorded for the new assignment
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.decision_log
       WHERE resource_id = v_assignment_id
         AND resource_type = 'vehicle_assignment'
         AND decision_category = 'fleet.driver_assigned'
         AND performed_by_system = 'assign_driver_to_vehicle_v1'
    ),
    'decision_log row written for new assignment with canonical category'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.domain_events
       WHERE resource_id = v_assignment_id
         AND resource_type = 'vehicle_assignment'
         AND event_type = 'fleet.driver_assigned'
    ),
    'domain_events row enqueued with canonical event_type'
  );

  -- 4) Ladder/policy resolution context recorded in metadata
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.vehicle_assignments va
       WHERE va.id = v_assignment_id
         AND va.metadata ? 'fleet_policy_resolution'
         AND va.metadata ? 'correlation_id'
    ),
    'new assignment row metadata records fleet_policy resolution + correlation_id'
  );

  -- 5) Cross-tenant guard: org1 fleet_manager cannot assign org2's vehicle
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT throws_ok(
    format($q$ SELECT public.assign_driver_to_vehicle_v1(jsonb_build_object('vehicle_id', %L, 'driver_user_id', %L)) $q$,
           v_vehicle2, v_driver_user1),
    '42501',
    NULL,
    'cross-org reassignment is rejected (vehicle belongs to another organization)'
  );

  -- 6) RLS isolation: org2 admin cannot see org1's new assignment row
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org2, ARRAY['fleet_manager'], v_admin_user2);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org2, v_admin_user2, r.id, v_admin_user2,
         jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org2 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin_user2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.vehicle_assignments WHERE id = v_assignment_id),
    0,
    'RLS: org2 admin does not see org1 vehicle_assignments rows'
  );

  -- 7) Argument validation: missing vehicle_id is a 22023
  PERFORM set_config('request.jwt.claim.sub', v_admin_user1::text, true);
  RETURN NEXT throws_ok(
    $q$ SELECT public.assign_driver_to_vehicle_v1(jsonb_build_object('driver_user_id', '0fb01000-0000-0000-0000-000000000501')) $q$,
    '22023',
    NULL,
    'missing vehicle_id raises 22023'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_assign_driver_to_vehicle_v1();

SELECT * FROM finish();

ROLLBACK;

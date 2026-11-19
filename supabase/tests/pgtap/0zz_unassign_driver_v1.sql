-- Plan: PHASE B / B2 — pgTAP for unassign_driver_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

CREATE OR REPLACE FUNCTION test_unassign_driver_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb02000-0000-0000-0000-000000000001'::uuid;
  v_branch1 UUID := '0fb02000-0000-0000-0000-000000000101'::uuid;
  v_admin1 UUID := '0fb02000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb02000-0000-0000-0000-000000000402'::uuid;
  v_driver_user1 UUID := '0fb02000-0000-0000-0000-000000000501'::uuid;
  v_vehicle_type1 UUID := '0fb02000-0000-0000-0000-000000000601'::uuid;
  v_vehicle1 UUID := '0fb02000-0000-0000-0000-000000000701'::uuid;
  v_dp1 UUID := '0fb02000-0000-0000-0000-000000000801'::uuid;
  v_assignment1 UUID := '0fb02000-0000-0000-0000-000000000901'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'unassign_driver_v1', ARRAY['jsonb'],
                           'unassign_driver_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Unassign Org', 'unassign-' || left(v_org1::text, 8));
  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch1, v_org1, 'unassign-b1', 'B1', 'UTC', TRUE);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'unassign-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'unassign-u1@example.com', 'Unpriv', 'client_admin', 'tenant'),
    (v_driver_user1, v_org1, 'unassign-d1@example.com', 'Driver', 'driver', 'tenant');
  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type1, v_org1, 'van-' || left(v_vehicle_type1::text, 6), 'Van', TRUE);
  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle1, v_org1, v_branch1, v_vehicle_type1, 'UN-100', 'active', TRUE);
  INSERT INTO public.driver_profiles (id, organization_id, user_id, status)
  VALUES (v_dp1, v_org1, v_driver_user1, 'active');
  INSERT INTO public.vehicle_assignments (id, organization_id, vehicle_id, assigned_to_user_id, branch_id, status, started_at)
  VALUES (v_assignment1, v_org1, v_vehicle1, v_driver_user1, v_branch1, 'active', now() - interval '2 hours');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_admin1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_admin1, r.id, v_admin1, jsonb_build_object('seed', TRUE)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  -- 1) Denied path
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_unpriv1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.unassign_driver_v1(jsonb_build_object('vehicle_id', %L)) $q$, v_vehicle1),
    '42501', NULL,
    'unprivileged user is denied'
  );

  -- 2) Happy path: closes the active row
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  v_result := public.unassign_driver_v1(jsonb_build_object('vehicle_id', v_vehicle1, 'reason', 'shift_end'));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is((v_result->>'closed_count')::INT, 1, 'closed exactly one row');

  -- 3) Idempotent: second call closes nothing
  v_result := public.unassign_driver_v1(jsonb_build_object('vehicle_id', v_vehicle1));
  RETURN NEXT is((v_result->>'closed_count')::INT, 0, 'second call is idempotent (closed_count=0)');

  -- 4) decision_log + domain_events recorded
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.decision_log
       WHERE decision_category = 'fleet.driver_unassigned'
         AND performed_by_system = 'unassign_driver_v1'
    ),
    'decision_log entry recorded for unassignment'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.domain_events
       WHERE event_type = 'fleet.driver_unassigned'
         AND organization_id = v_org1
    ),
    'domain_events row enqueued for unassignment'
  );

  -- 5) Argument validation
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(
    $q$ SELECT public.unassign_driver_v1(jsonb_build_object()) $q$,
    '22023', NULL,
    'missing identifiers raises 22023'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_unassign_driver_v1();
SELECT * FROM finish();
ROLLBACK;

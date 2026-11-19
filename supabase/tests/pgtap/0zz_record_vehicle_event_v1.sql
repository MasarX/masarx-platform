-- Plan: PHASE B / B2 — pgTAP for record_vehicle_event_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_record_vehicle_event_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb08000-0000-0000-0000-000000000001'::uuid;
  v_branch1 UUID := '0fb08000-0000-0000-0000-000000000101'::uuid;
  v_admin1 UUID := '0fb08000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb08000-0000-0000-0000-000000000402'::uuid;
  v_vehicle_type1 UUID := '0fb08000-0000-0000-0000-000000000601'::uuid;
  v_vehicle1 UUID := '0fb08000-0000-0000-0000-000000000701'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'record_vehicle_event_v1', ARRAY['jsonb'],
                           'record_vehicle_event_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Event Org', 'event-' || left(v_org1::text, 8));
  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch1, v_org1, 'event-b1', 'B1', 'UTC', TRUE);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'event-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'event-u1@example.com', 'Unpriv', 'client_admin', 'tenant');
  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type1, v_org1, 'van-' || left(v_vehicle_type1::text, 6), 'Van', TRUE);
  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle1, v_org1, v_branch1, v_vehicle_type1, 'EV-100', 'active', TRUE);

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_admin1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_admin1, r.id, v_admin1, jsonb_build_object('seed', TRUE)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  -- 1) Denied
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_unpriv1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.record_vehicle_event_v1(jsonb_build_object('vehicle_id', %L, 'event_type', 'fuel')) $q$, v_vehicle1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) Unknown event_type rejected
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.record_vehicle_event_v1(jsonb_build_object('vehicle_id', %L, 'event_type', 'unknown_evt_xyz')) $q$, v_vehicle1),
    '22023', NULL, 'unknown event_type rejected (not in lookup)'
  );

  -- 3) Negative odometer rejected
  RETURN NEXT throws_ok(
    format($q$ SELECT public.record_vehicle_event_v1(jsonb_build_object('vehicle_id', %L, 'event_type', 'odometer', 'odometer_km', '-5')) $q$, v_vehicle1),
    '22023', NULL, 'negative odometer rejected'
  );

  -- 4) Happy path: fuel
  v_result := public.record_vehicle_event_v1(jsonb_build_object(
    'vehicle_id', v_vehicle1,
    'event_type', 'fuel',
    'fuel_liters', '42.5',
    'cost_amount', '210.00',
    'cost_currency', 'SAR',
    'odometer_km', '12345'
  ));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is(v_result->>'event_type', 'fuel', 'envelope event_type=fuel');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.vehicle_events
       WHERE vehicle_id = v_vehicle1
         AND event_type = 'fuel'
         AND fuel_liters = 42.5
         AND cost_currency = 'SAR'
    ),
    'vehicle_events row inserted with fuel telemetry'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_record_vehicle_event_v1();
SELECT * FROM finish();
ROLLBACK;

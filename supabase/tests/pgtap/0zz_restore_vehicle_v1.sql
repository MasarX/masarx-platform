-- Plan: PHASE B / B2 — pgTAP for restore_vehicle_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_restore_vehicle_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb04000-0000-0000-0000-000000000001'::uuid;
  v_branch1 UUID := '0fb04000-0000-0000-0000-000000000101'::uuid;
  v_admin1 UUID := '0fb04000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb04000-0000-0000-0000-000000000402'::uuid;
  v_vehicle_type1 UUID := '0fb04000-0000-0000-0000-000000000601'::uuid;
  v_vehicle1 UUID := '0fb04000-0000-0000-0000-000000000701'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'restore_vehicle_v1', ARRAY['jsonb'],
                           'restore_vehicle_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Restore Org', 'restore-' || left(v_org1::text, 8));
  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch1, v_org1, 'restore-b1', 'B1', 'UTC', TRUE);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'restore-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'restore-u1@example.com', 'Unpriv', 'client_admin', 'tenant');
  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type1, v_org1, 'van-' || left(v_vehicle_type1::text, 6), 'Van', TRUE);
  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle1, v_org1, v_branch1, v_vehicle_type1, 'RST-100', 'oos', TRUE);

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
    format($q$ SELECT public.restore_vehicle_v1(jsonb_build_object('vehicle_id', %L)) $q$, v_vehicle1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) Happy path: oos -> active
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  v_result := public.restore_vehicle_v1(jsonb_build_object('vehicle_id', v_vehicle1, 'notes', 'engine_repaired'));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is(
    (SELECT status FROM public.vehicles WHERE id = v_vehicle1),
    'active',
    'vehicles.status restored to active'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.vehicle_events
             WHERE vehicle_id = v_vehicle1 AND event_type = 'oos_restored'),
    'vehicle_events row appended (oos_restored)'
  );

  -- 3) Idempotent re-call: status remains active; new audit row appended
  v_result := public.restore_vehicle_v1(jsonb_build_object('vehicle_id', v_vehicle1));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'idempotent re-call still ok');
  RETURN NEXT is(
    (v_result->>'was_oos')::boolean,
    FALSE,
    'second call reports was_oos=FALSE (noop status)'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_restore_vehicle_v1();
SELECT * FROM finish();
ROLLBACK;

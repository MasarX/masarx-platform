-- Plan: PHASE B / B2 — pgTAP for record_hours_of_service_segment_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

CREATE OR REPLACE FUNCTION test_record_hours_of_service_segment_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb0e000-0000-0000-0000-000000000001'::uuid;
  v_admin1 UUID := '0fb0e000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb0e000-0000-0000-0000-000000000402'::uuid;
  v_driver_user1 UUID := '0fb0e000-0000-0000-0000-000000000501'::uuid;
  v_dp1 UUID := '0fb0e000-0000-0000-0000-000000000801'::uuid;
  v_result JSONB;
  v_first_segment_id UUID;
  v_second_segment_id UUID;
BEGIN
  RETURN NEXT has_function('public', 'record_hours_of_service_segment_v1', ARRAY['jsonb'],
                           'record_hours_of_service_segment_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'HOS RPC Org', 'hosrpc-' || left(v_org1::text, 8));
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'hosrpc-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'hosrpc-u1@example.com', 'Unpriv', 'client_admin', 'tenant'),
    (v_driver_user1, v_org1, 'hosrpc-d1@example.com', 'Driver', 'driver', 'tenant');
  INSERT INTO public.driver_profiles (id, organization_id, user_id, status)
  VALUES (v_dp1, v_org1, v_driver_user1, 'active');

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
    format($q$ SELECT public.record_hours_of_service_segment_v1(jsonb_build_object('driver_user_id', %L, 'duty_status', 'driving')) $q$, v_driver_user1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) Required duty_status
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.record_hours_of_service_segment_v1(jsonb_build_object('driver_user_id', %L)) $q$, v_driver_user1),
    '22023', NULL, 'duty_status required'
  );

  -- 3) Lookup-driven duty_status validation (unknown rejected)
  RETURN NEXT throws_ok(
    format($q$ SELECT public.record_hours_of_service_segment_v1(jsonb_build_object('driver_user_id', %L, 'duty_status', 'undefined_zzz')) $q$, v_driver_user1),
    '22023', NULL, 'unknown duty_status rejected (not in lookup)'
  );

  -- 4) Happy path: open driving segment
  v_result := public.record_hours_of_service_segment_v1(jsonb_build_object(
    'driver_user_id', v_driver_user1,
    'duty_status', 'driving',
    'segment_start', (now() - interval '1 hour')::text,
    'notes', 'shift_start'
  ));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is((v_result->>'closed_open_count')::INT, 0, 'first segment closes 0 open segments');
  v_first_segment_id := (v_result->>'driver_hours_of_service_id')::UUID;
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.driver_hours_of_service
       WHERE id = v_first_segment_id
         AND duty_status = 'driving'
         AND segment_end IS NULL
    ),
    'first segment persisted as open (segment_end IS NULL)'
  );

  -- 5) New segment closes the prior open segment (single-open invariant)
  v_result := public.record_hours_of_service_segment_v1(jsonb_build_object(
    'driver_user_id', v_driver_user1,
    'duty_status', 'off_duty',
    'notes', 'break'
  ));
  RETURN NEXT is((v_result->>'closed_open_count')::INT, 1, 'second segment closes the prior open segment');
  v_second_segment_id := (v_result->>'driver_hours_of_service_id')::UUID;
  RETURN NEXT ok(
    (SELECT segment_end IS NOT NULL FROM public.driver_hours_of_service WHERE id = v_first_segment_id)
    AND
    (SELECT segment_end IS NULL FROM public.driver_hours_of_service WHERE id = v_second_segment_id),
    'first segment now closed; second segment open (single-open invariant holds)'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_record_hours_of_service_segment_v1();
SELECT * FROM finish();
ROLLBACK;

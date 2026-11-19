-- Plan: PHASE B / B2 — pgTAP for create_driver_compliance_event_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_create_driver_compliance_event_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb0d000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0fb0d000-0000-0000-0000-000000000002'::uuid;
  v_admin1 UUID := '0fb0d000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb0d000-0000-0000-0000-000000000402'::uuid;
  v_admin2 UUID := '0fb0d000-0000-0000-0000-000000000403'::uuid;
  v_driver_user1 UUID := '0fb0d000-0000-0000-0000-000000000501'::uuid;
  v_driver_user2 UUID := '0fb0d000-0000-0000-0000-000000000502'::uuid;
  v_dp1 UUID := '0fb0d000-0000-0000-0000-000000000801'::uuid;
  v_dp2 UUID := '0fb0d000-0000-0000-0000-000000000802'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'create_driver_compliance_event_v1', ARRAY['jsonb'],
                           'create_driver_compliance_event_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Compliance Org 1', 'cmp-' || right(replace(v_org1::text, '-', ''), 12)),
    (v_org2, 'Compliance Org 2', 'cmp-' || right(replace(v_org2::text, '-', ''), 12));
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'cmp-a1@example.com', 'Admin 1', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'cmp-u1@example.com', 'Unpriv', 'client_admin', 'tenant'),
    (v_admin2, v_org2, 'cmp-a2@example.com', 'Admin 2', 'fleet_manager', 'tenant'),
    (v_driver_user1, v_org1, 'cmp-d1@example.com', 'Driver 1', 'driver', 'tenant'),
    (v_driver_user2, v_org2, 'cmp-d2@example.com', 'Driver 2', 'driver', 'tenant');
  INSERT INTO public.driver_profiles (id, organization_id, user_id, status)
  VALUES
    (v_dp1, v_org1, v_driver_user1, 'active'),
    (v_dp2, v_org2, v_driver_user2, 'active');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_admin1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_admin1, r.id, v_admin1, jsonb_build_object('seed', TRUE)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org2, ARRAY['fleet_manager'], v_admin2);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org2, v_admin2, r.id, v_admin2, jsonb_build_object('seed', TRUE)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org2 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  -- 1) Denied
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_unpriv1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.create_driver_compliance_event_v1(jsonb_build_object('driver_user_id', %L, 'event_type', 'manual_check')) $q$, v_driver_user1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) event_type required
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.create_driver_compliance_event_v1(jsonb_build_object('driver_user_id', %L)) $q$, v_driver_user1),
    '22023', NULL, 'event_type required'
  );

  -- 3) Cross-org guard
  RETURN NEXT throws_ok(
    format($q$ SELECT public.create_driver_compliance_event_v1(jsonb_build_object('driver_profile_id', %L, 'event_type', 'manual_check')) $q$, v_dp2),
    '42501', NULL, 'cross-org driver_profile_id rejected'
  );

  -- 4) Happy path: by driver_user_id
  v_result := public.create_driver_compliance_event_v1(jsonb_build_object(
    'driver_user_id', v_driver_user1,
    'event_type', 'training_completed',
    'payload', jsonb_build_object('course', 'defensive_driving', 'score', 95),
    'notes', 'annual_refresher'
  ));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is(v_result->>'event_type', 'training_completed', 'envelope event_type=training_completed');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.driver_compliance_events
       WHERE id = (v_result->>'driver_compliance_event_id')::uuid
         AND user_id = v_driver_user1
         AND event_type = 'training_completed'
         AND payload->>'course' = 'defensive_driving'
    ),
    'driver_compliance_events row inserted with payload preserved'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_create_driver_compliance_event_v1();
SELECT * FROM finish();
ROLLBACK;

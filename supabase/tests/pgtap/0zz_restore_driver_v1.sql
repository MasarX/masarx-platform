-- Plan: PHASE B / B2 — pgTAP for restore_driver_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_restore_driver_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb0c000-0000-0000-0000-000000000001'::uuid;
  v_admin1 UUID := '0fb0c000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb0c000-0000-0000-0000-000000000402'::uuid;
  v_driver_user1 UUID := '0fb0c000-0000-0000-0000-000000000501'::uuid;
  v_driver_user2 UUID := '0fb0c000-0000-0000-0000-000000000502'::uuid;
  v_dp1 UUID := '0fb0c000-0000-0000-0000-000000000801'::uuid;
  v_dp2 UUID := '0fb0c000-0000-0000-0000-000000000802'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'restore_driver_v1', ARRAY['jsonb'],
                           'restore_driver_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'RestoreDr Org', 'rdr-' || left(v_org1::text, 8));
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'rdr-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'rdr-u1@example.com', 'Unpriv', 'client_admin', 'tenant'),
    (v_driver_user1, v_org1, 'rdr-d1@example.com', 'Driver1', 'driver', 'tenant'),
    (v_driver_user2, v_org1, 'rdr-d2@example.com', 'Driver2', 'driver', 'tenant');
  INSERT INTO public.driver_profiles (id, organization_id, user_id, status)
  VALUES
    (v_dp1, v_org1, v_driver_user1, 'suspended'),
    (v_dp2, v_org1, v_driver_user2, 'active');

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
    format($q$ SELECT public.restore_driver_v1(jsonb_build_object('driver_profile_id', %L)) $q$, v_dp1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) Cannot restore active driver
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.restore_driver_v1(jsonb_build_object('driver_profile_id', %L)) $q$, v_dp2),
    '22023', NULL, 'already-active driver not restorable'
  );

  -- 3) Happy path
  v_result := public.restore_driver_v1(jsonb_build_object('driver_profile_id', v_dp1, 'notes', 'cleared_by_legal'));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is(
    (SELECT status FROM public.driver_profiles WHERE id = v_dp1),
    'active',
    'driver_profiles.status=active after restore'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.driver_compliance_events
             WHERE user_id = v_driver_user1
               AND event_type = 'driver_restored'),
    'compliance ledger row appended (driver_restored)'
  );

  -- 4) Driver_user_id form also works
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.driver_profiles SET status = 'inactive' WHERE id = v_dp1;
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  v_result := public.restore_driver_v1(jsonb_build_object('driver_user_id', v_driver_user1));
  RETURN NEXT is((v_result->>'previous_status')::text, 'inactive', 'driver_user_id form works (inactive -> active)');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_restore_driver_v1();
SELECT * FROM finish();
ROLLBACK;

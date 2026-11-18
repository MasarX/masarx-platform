-- Plan: PHASE B / B2 — pgTAP for cancel_maintenance_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_cancel_maintenance_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb07000-0000-0000-0000-000000000001'::uuid;
  v_client1 UUID := '0fb07000-0000-0000-0000-000000000011'::uuid;
  v_sender1 UUID := '0fb07000-0000-0000-0000-000000000021'::uuid;
  v_branch1 UUID := '0fb07000-0000-0000-0000-000000000101'::uuid;
  v_admin1 UUID := '0fb07000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb07000-0000-0000-0000-000000000402'::uuid;
  v_vehicle_type1 UUID := '0fb07000-0000-0000-0000-000000000601'::uuid;
  v_vehicle1 UUID := '0fb07000-0000-0000-0000-000000000701'::uuid;
  v_window1 UUID := '0fb07000-0000-0000-0000-000000000801'::uuid;
  v_window2 UUID := '0fb07000-0000-0000-0000-000000000802'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'cancel_maintenance_v1', ARRAY['jsonb'],
                           'cancel_maintenance_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Cancel Org', 'cancel-' || left(v_org1::text, 8));
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client1, v_org1, 'Cancel Client', 'cancel-client-' || left(v_client1::text, 8), 'active');
  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender1, v_client1, 'Cancel Sender', 'Cancel Sender', TRUE, 'active');
  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org1, 'pgtap:cancel-maintenance-fixture-bootstrap');
  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch1, v_org1, 'cancel-b1', 'B1', 'UTC', TRUE);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'cancel-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'cancel-u1@example.com', 'Unpriv', 'client_admin', 'tenant');
  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type1, v_org1, 'van-' || left(v_vehicle_type1::text, 6), 'Van', TRUE);
  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle1, v_org1, v_branch1, v_vehicle_type1, 'CN-100', 'active', TRUE);
  INSERT INTO public.vehicle_maintenance_windows (id, organization_id, vehicle_id, window_start_at, window_end_at, status)
  VALUES
    (v_window1, v_org1, v_vehicle1, now() + interval '1 day', now() + interval '1 day 2 hours', 'scheduled'),
    (v_window2, v_org1, v_vehicle1, now() - interval '1 day', now() - interval '23 hours', 'completed');

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
    format($q$ SELECT public.cancel_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', %L, 'reason', 'shop_closed')) $q$, v_window1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) Reason required
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.cancel_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', %L)) $q$, v_window1),
    '22023', NULL, 'reason required'
  );

  -- 3) Cannot cancel completed window
  RETURN NEXT throws_ok(
    format($q$ SELECT public.cancel_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', %L, 'reason', 'shop_closed')) $q$, v_window2),
    '22023', NULL, 'completed window not cancellable'
  );

  -- 4) Happy path
  v_result := public.cancel_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', v_window1, 'reason', 'shop_closed'));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is(
    (SELECT status FROM public.vehicle_maintenance_windows WHERE id = v_window1),
    'cancelled',
    'window status set to cancelled'
  );
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.decision_log
             WHERE decision_category = 'fleet.maintenance_cancelled'
               AND performed_by_system = 'cancel_maintenance_v1'),
    'decision_log entry recorded'
  );

  RETURN;
END;
$function$;

SELECT * FROM test_cancel_maintenance_v1();
SELECT * FROM finish();
ROLLBACK;

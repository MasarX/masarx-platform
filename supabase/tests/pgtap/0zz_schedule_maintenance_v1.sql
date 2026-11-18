-- Plan: PHASE B / B2 — pgTAP for schedule_maintenance_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

CREATE OR REPLACE FUNCTION test_schedule_maintenance_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb05000-0000-0000-0000-000000000001'::uuid;
  v_branch1 UUID := '0fb05000-0000-0000-0000-000000000101'::uuid;
  v_admin1 UUID := '0fb05000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb05000-0000-0000-0000-000000000402'::uuid;
  v_vehicle_type1 UUID := '0fb05000-0000-0000-0000-000000000601'::uuid;
  v_vehicle1 UUID := '0fb05000-0000-0000-0000-000000000701'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'schedule_maintenance_v1', ARRAY['jsonb'],
                           'schedule_maintenance_v1(JSONB) exists');
  RETURN NEXT has_column('public', 'vehicle_maintenance_windows', 'status',
                         'vehicle_maintenance_windows.status column exists');
  RETURN NEXT has_column('public', 'vehicle_maintenance_windows', 'scheduled_by_user_id',
                         'vehicle_maintenance_windows.scheduled_by_user_id column exists');
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.lookup_definitions ld
              JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
             WHERE ld.category = 'maintenance_window_status'
               AND lv.value IN ('scheduled','completed','cancelled')
             GROUP BY ld.id
             HAVING COUNT(*) = 3),
    'maintenance_window_status lookup seeded'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Schedule Org', 'schedule-' || left(v_org1::text, 8));
  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch1, v_org1, 'sched-b1', 'B1', 'UTC', TRUE);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'sched-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'sched-u1@example.com', 'Unpriv', 'client_admin', 'tenant');
  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type1, v_org1, 'van-' || left(v_vehicle_type1::text, 6), 'Van', TRUE);
  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle1, v_org1, v_branch1, v_vehicle_type1, 'SC-100', 'active', TRUE);

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
    format($q$ SELECT public.schedule_maintenance_v1(jsonb_build_object('vehicle_id', %L, 'window_start_at', (now())::text, 'window_end_at', (now() + interval '2 hours')::text)) $q$, v_vehicle1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) Missing window args
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.schedule_maintenance_v1(jsonb_build_object('vehicle_id', %L)) $q$, v_vehicle1),
    '22023', NULL, 'missing window args raises 22023'
  );

  -- 3) Reversed time range rejected
  RETURN NEXT throws_ok(
    format($q$ SELECT public.schedule_maintenance_v1(jsonb_build_object('vehicle_id', %L, 'window_start_at', (now() + interval '2 hours')::text, 'window_end_at', (now())::text)) $q$, v_vehicle1),
    '22023', NULL, 'reversed time range raises 22023'
  );

  -- 4) Happy path
  v_result := public.schedule_maintenance_v1(jsonb_build_object(
    'vehicle_id', v_vehicle1,
    'window_start_at', (now() + interval '1 day')::text,
    'window_end_at', (now() + interval '1 day 2 hours')::text,
    'reason', 'oil_change'
  ));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is(v_result->>'status', 'scheduled', 'envelope status=scheduled');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.vehicle_maintenance_windows
       WHERE id = (v_result->>'vehicle_maintenance_window_id')::uuid
         AND status = 'scheduled'
         AND scheduled_by_user_id = v_admin1
    ),
    'maintenance window row inserted with status=scheduled'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_schedule_maintenance_v1();
SELECT * FROM finish();
ROLLBACK;

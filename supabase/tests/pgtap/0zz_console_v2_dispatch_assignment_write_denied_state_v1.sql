-- pgTAP: Console V2 dispatch route assignment writes deny lower-permission users
-- before mutating route assignments, route-stop ownership, or reassignment ledgers.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_dispatch_assignment_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_limited UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_route RECORD;
  v_stop_id UUID := NULL;
  v_ops_result JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'api',
    'ui_execute_route_run_assign_v1',
    ARRAY['text','text','text[]','text','integer','jsonb'],
    'api.ui_execute_route_run_assign_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_route_stop_reassign_v1',
    ARRAY['text','text','text[]','text','integer','jsonb'],
    'api.ui_execute_route_stop_reassign_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_execute_route_run_assign_v1(text, text, text[], text, integer, jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_execute_route_run_assign_v1'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_execute_route_stop_reassign_v1(text, text, text[], text, integer, jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_execute_route_stop_reassign_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Dispatch Assignment Denied Org', 'dispatch-assignment-denied-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'dad-' || lower(left(v_org::text, 6)), 'Dispatch Assignment Denied Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Dispatch Assignment Denied Client', 'dispatch-assignment-denied-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (
      v_ops,
      v_org,
      'dispatch-assignment-denied-ops-' || left(v_ops::text, 8) || '@example.com',
      'Dispatch Assignment Denied Ops',
      'ops_admin',
      'active',
      'tenant',
      NULL
    ),
    (
      v_limited,
      v_org,
      'dispatch-assignment-denied-limited-' || left(v_limited::text, 8) || '@example.com',
      'Dispatch Assignment Denied Limited',
      'client_admin',
      'active',
      'tenant',
      NULL
    ),
    (
      v_driver,
      v_org,
      'dispatch-assignment-denied-driver-' || left(v_driver::text, 8) || '@example.com',
      'Dispatch Assignment Denied Driver',
      'driver',
      'active',
      'tenant',
      NULL
    );

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_org, 'DAD-' || upper(left(v_vehicle::text, 6)), 'active', TRUE);

  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_org, v_client, 'DAD-' || upper(left(gen_random_uuid()::text, 8)), 'delivery', 'pending'),
    (v_org, v_client, 'DAD-' || upper(left(gen_random_uuid()::text, 8)), 'delivery', 'pending');

  SELECT *
    INTO v_route
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'stops', (
          SELECT jsonb_agg(
            jsonb_build_object(
              'client_id', s.client_id,
              'shipment_id', s.id,
              'stop_kind', 'delivery',
              'sequence_order', s.sequence_order
            )
            ORDER BY s.sequence_order
          )
          FROM (
            SELECT
              id,
              client_id,
              row_number() OVER (ORDER BY created_at, id) AS sequence_order
              FROM public.shipments
             WHERE organization_id = v_org
             ORDER BY created_at, id
          ) s
        )
      )
    )
   LIMIT 1;

  SELECT rs.id
    INTO v_stop_id
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_route.route_run_id
   ORDER BY rs.sequence_order, rs.created_at, rs.id
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_limited::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(
    NOT public.user_has_resource_capability_v1('routes', 'write', 'tenant', v_org),
    'limited dispatch user lacks tenant routes.write'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ops::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  RETURN NEXT ok(
    public.user_has_resource_capability_v1('routes', 'write', 'tenant', v_org),
    'ops dispatch user has tenant routes.write'
  );

  PERFORM set_config('request.jwt.claim.sub', v_limited::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_limited::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.ui_execute_route_run_assign_v1('route_runs.assign', 'route_runs', ARRAY[%L], %L, 1, jsonb_build_object('organization_id', %L, 'driver_user_id', %L, 'vehicle_id', %L, 'idempotency_key', 'dispatch-denied-public-assign')) $q$,
      v_route.route_run_id::text,
      v_route.route_run_id::text,
      v_org,
      v_driver,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied public ui_execute_route_run_assign_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.ui_execute_route_run_assign_v1('route_runs.assign', 'route_runs', ARRAY[%L], %L, 1, jsonb_build_object('organization_id', %L, 'driver_user_id', %L, 'vehicle_id', %L, 'idempotency_key', 'dispatch-denied-api-assign')) $q$,
      v_route.route_run_id::text,
      v_route.route_run_id::text,
      v_org,
      v_driver,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied api ui_execute_route_run_assign_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.ui_execute_route_stop_reassign_v1('route_stops.reassign', 'route_stops', ARRAY[%L], %L, 1, jsonb_build_object('driver_user_id', %L, 'vehicle_id', %L, 'idempotency_key', 'dispatch-denied-public-reassign')) $q$,
      v_stop_id::text,
      v_stop_id::text,
      v_driver,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied public ui_execute_route_stop_reassign_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.ui_execute_route_stop_reassign_v1('route_stops.reassign', 'route_stops', ARRAY[%L], %L, 1, jsonb_build_object('driver_user_id', %L, 'vehicle_id', %L, 'idempotency_key', 'dispatch-denied-api-reassign')) $q$,
      v_stop_id::text,
      v_stop_id::text,
      v_driver,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied api ui_execute_route_stop_reassign_v1'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.route_run_assignments WHERE organization_id = v_org),
    0,
    'denied route assignment writes no route_run_assignments rows'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.route_run_assignment_events WHERE organization_id = v_org),
    0,
    'denied route assignment writes no route_run_assignment_events rows'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.route_stop_reassignment_events WHERE organization_id = v_org),
    0,
    'denied stop reassignment writes no route_stop_reassignment_events rows'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.route_runs WHERE organization_id = v_org),
    1,
    'denied stop reassignment does not create a target route_run'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
        FROM public.route_stops
       WHERE organization_id = v_org
         AND route_run_id = v_route.route_run_id
    ),
    2,
    'denied stop reassignment leaves all stops on the source route'
  );
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.tasks t
        JOIN public.task_types tt ON tt.id = t.task_type_id
       WHERE tt.organization_id = v_org
         AND tt.key = 'route_stop_execute'
         AND t.assigned_to = v_driver
    ),
    'denied assignment attempts leave route-stop tasks unassigned from target driver'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ops::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_ops_result := api.ui_execute_route_run_assign_v1(
    'route_runs.assign',
    'route_runs',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'organization_id', v_org,
      'driver_user_id', v_driver,
      'vehicle_id', v_vehicle,
      'idempotency_key', 'dispatch-denied-ops-assign'
    )
  );

  RETURN NEXT is(v_ops_result->>'status', 'assigned', 'ops user can still assign route through api wrapper');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT driver_user_id::text FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    v_driver::text,
    'ops assignment stores selected driver in assignment projection'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
        FROM public.tasks t
        JOIN public.task_types tt ON tt.id = t.task_type_id
       WHERE tt.organization_id = v_org
         AND tt.key = 'route_stop_execute'
         AND t.assigned_to = v_driver
         AND EXISTS (
           SELECT 1
             FROM public.route_stops rs
            WHERE rs.id = t.resource_id
              AND rs.route_run_id = v_route.route_run_id
         )
    ),
    '2',
    'ops assignment syncs route_stop_execute tasks to selected driver'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_dispatch_assignment_write_denied_state_v1();

SELECT * FROM finish();

ROLLBACK;

-- Plan: PLAN-202604-b06-route-stop-mid-execution-reassignment / Step: E01
-- pgTAP: UC078 route stop mid-execution reassignment v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

CREATE OR REPLACE FUNCTION pg_temp.test_uc078_route_stop_mid_execution_reassignment_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_route_plan UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_driver_one UUID := gen_random_uuid();
  v_driver_two UUID := gen_random_uuid();
  v_vehicle_one UUID := gen_random_uuid();
  v_vehicle_two UUID := gen_random_uuid();
  v_partner_route RECORD;
  v_stop_route RECORD;
  v_direct_error TEXT := NULL;
  v_partner_result JSONB := NULL;
  v_stop_result JSONB := NULL;
  v_target_route_id UUID := NULL;
  v_stop_to_move UUID := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function('public', 'unassign_task_v1', ARRAY['uuid','text','text'], 'public.unassign_task_v1 exists');
  RETURN NEXT has_function('public', 'route_run_prepare_partner_handoff_v1', ARRAY['uuid','uuid[]','text','text'], 'public.route_run_prepare_partner_handoff_v1 exists');
  RETURN NEXT has_function('public', 'reassign_route_stops_v1', ARRAY['jsonb'], 'public.reassign_route_stops_v1 exists');
  RETURN NEXT has_function('public', 'ui_execute_route_stop_reassign_v1', ARRAY['text','text','text[]','text','integer','jsonb'], 'public.ui_execute_route_stop_reassign_v1 exists');
  RETURN NEXT has_function('api', 'ui_execute_route_stop_reassign_v1', ARRAY['text','text','text[]','text','integer','jsonb'], 'api.ui_execute_route_stop_reassign_v1 exists');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_execute_route_stop_reassign_v1(text, text, text[], text, integer, jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_execute_route_stop_reassign_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'route_stop_reassignment_events'
         AND c.relrowsecurity
    ),
    'route_stop_reassignment_events has RLS enabled'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND p.tablename = 'route_stop_reassignment_events'
         AND p.policyname = 'route_stop_reassignment_events_service_policy'
    ),
    'route_stop_reassignment_events has a service-only RLS policy'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'route_stops.reassign'
         AND item.value#>>'{execution,rpc}' = 'ui_execute_route_stop_reassign_v1'
    ),
    'ui_command_registry exposes route_stops.reassign'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC078 pgTap Org', 'uc078-pgtap-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'uc078', 'UC078 Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'UC078 Client', 'uc078-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_operator, v_org, 'uc078-ops-' || left(v_operator::text, 8) || '@example.com', 'UC078 Ops', 'ops_admin', 'active', 'tenant'),
    (v_driver_one, v_org, 'uc078-driver-a-' || left(v_driver_one::text, 8) || '@example.com', 'UC078 Driver A', 'driver', 'active', 'tenant'),
    (v_driver_two, v_org, 'uc078-driver-b-' || left(v_driver_two::text, 8) || '@example.com', 'UC078 Driver B', 'driver', 'active', 'tenant');

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES
    (v_vehicle_one, v_org, 'UC078-A-' || upper(left(v_vehicle_one::text, 4)), 'active', TRUE),
    (v_vehicle_two, v_org, 'UC078-B-' || upper(left(v_vehicle_two::text, 4)), 'active', TRUE);

  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_org, v_client, 'UC078-PARTNER-1', 'delivery', 'pending'),
    (v_org, v_client, 'UC078-PARTNER-2', 'delivery', 'pending'),
    (v_org, v_client, 'UC078-STOP-1', 'delivery', 'pending'),
    (v_org, v_client, 'UC078-STOP-2', 'delivery', 'pending');

  SELECT *
    INTO v_partner_route
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'stops', (
          SELECT jsonb_agg(
            jsonb_build_object(
              'client_id', seeded.client_id,
              'shipment_id', seeded.id,
              'stop_kind', 'delivery',
              'sequence_order', seeded.sequence_order
            )
            ORDER BY seeded.sequence_order
          )
          FROM (
            SELECT
              s.id,
              s.client_id,
              row_number() OVER (ORDER BY s.tracking_number) AS sequence_order
            FROM public.shipments s
            WHERE s.organization_id = v_org
              AND s.tracking_number LIKE 'UC078-PARTNER-%'
          ) seeded
        )
      )
    )
   LIMIT 1;

  SELECT *
    INTO v_stop_route
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'stops', (
          SELECT jsonb_agg(
            jsonb_build_object(
              'client_id', seeded.client_id,
              'shipment_id', seeded.id,
              'stop_kind', 'delivery',
              'sequence_order', seeded.sequence_order
            )
            ORDER BY seeded.sequence_order
          )
          FROM (
            SELECT
              s.id,
              s.client_id,
              row_number() OVER (ORDER BY s.tracking_number) AS sequence_order
            FROM public.shipments s
            WHERE s.organization_id = v_org
              AND s.tracking_number LIKE 'UC078-STOP-%'
          ) seeded
        )
      )
    )
   LIMIT 1;

  INSERT INTO public.route_plans (id, organization_id, branch_id, planned_date, status, inputs, metadata)
  VALUES (
    v_route_plan,
    v_org,
    v_branch,
    current_date,
    'applied',
    jsonb_build_object('source', 'uc078-route-plan-reassign-regression'),
    jsonb_build_object('proof', 'route-plan source runs can be split without route_plan_id reuse')
  );

  UPDATE public.route_runs
     SET route_plan_id = v_route_plan
   WHERE id = v_stop_route.route_run_id;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_partner_route.route_run_id::text],
    v_partner_route.route_run_id::text,
    1,
    jsonb_build_object(
      'driver_user_id', v_driver_one,
      'vehicle_id', v_vehicle_one,
      'idempotency_key', 'uc078-pgtap-route-base'
    )
  );

  BEGIN
    PERFORM *
      FROM api.assign_route_run_v1(
        jsonb_build_object(
          'route_run_id', v_partner_route.route_run_id,
          'partner_id', 'partner-1',
          'partner_name', 'Partner Fleet'
        )
      );
  EXCEPTION
    WHEN others THEN
      v_direct_error := SQLERRM;
  END;

  RETURN NEXT ok(
    COALESCE(v_direct_error, '') LIKE '%partner_fleet handoff%',
    'direct partner takeover remains blocked without explicit handoff prep'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.route_runs
     SET status = 'in_progress'
   WHERE id = v_partner_route.route_run_id;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_partner_result := api.ui_execute_route_run_assign_v1(
    'routes.reassign',
    'routes',
    ARRAY[v_partner_route.route_run_id::text],
    v_partner_route.route_run_id::text,
    1,
    jsonb_build_object(
      'partner_id', 'partner-1',
      'partner_name', 'Partner Fleet',
      'reassignment_reason', 'Vehicle breakdown escalation',
      'idempotency_key', 'uc078-pgtap-route-partner'
    )
  );

  RETURN NEXT is(v_partner_result#>>'{items,0,assignment_mode}', 'partner_fleet', 'route reassignment UI executor supports partner_fleet takeover');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT assignment_mode FROM public.route_run_assignments WHERE route_run_id = v_partner_route.route_run_id),
    'partner_fleet',
    'route_run_assignments stores partner_fleet mode after explicit handoff'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::text
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.organization_id = v_org
        AND tt.key = 'route_stop_execute'
        AND t.assigned_to IS NULL
        AND EXISTS (
          SELECT 1
            FROM public.route_stops rs
           WHERE rs.id = t.resource_id
             AND rs.route_run_id = v_partner_route.route_run_id
        )
    ),
    '2',
    'partner handoff clears route_stop task ownership'
  );

  UPDATE public.route_runs
     SET status = 'in_progress'
   WHERE id = v_stop_route.route_run_id;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_stop_route.route_run_id::text],
    v_stop_route.route_run_id::text,
    1,
    jsonb_build_object(
      'driver_user_id', v_driver_one,
      'vehicle_id', v_vehicle_one,
      'idempotency_key', 'uc078-pgtap-stop-base'
    )
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT rs.id
    INTO v_stop_to_move
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_stop_route.route_run_id
   ORDER BY rs.sequence_order DESC, rs.created_at DESC, rs.id DESC
   LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_stop_result := api.ui_execute_route_stop_reassign_v1(
    'route_stops.reassign',
    'route_stops',
    ARRAY[v_stop_to_move::text],
    v_stop_to_move::text,
    1,
    jsonb_build_object(
      'driver_user_id', v_driver_two,
      'vehicle_id', v_vehicle_two,
      'reassignment_reason', 'Capacity rebalance',
      'idempotency_key', 'uc078-pgtap-stop-reassign'
    )
  );

  BEGIN
    v_target_route_id := NULLIF(v_stop_result#>>'{items,0,target_route_run_id}', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_target_route_id := NULL;
  END;

  RETURN NEXT ok(v_target_route_id IS NOT NULL, 'route_stops.reassign creates a target route_run');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.route_runs rr
       WHERE rr.id = v_target_route_id
         AND rr.route_plan_id IS NULL
         AND rr.metadata->'stop_reassignment'->>'source_route_run_id' = v_stop_route.route_run_id::text
    ),
    'route-plan source split creates target run without reusing unique route_plan_id'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT COUNT(*)::text FROM public.route_stops WHERE route_run_id = v_stop_route.route_run_id),
    '1',
    'source route retains only the remaining stop after split reassignment'
  );
  RETURN NEXT is(
    (SELECT driver_user_id::text FROM public.route_run_assignments WHERE route_run_id = v_target_route_id),
    v_driver_two::text,
    'target route assignment points to the reassigned driver'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::text FROM public.route_stop_reassignment_events WHERE route_stop_id = v_stop_to_move),
    '1',
    'route_stop_reassignment_events captures the moved stop'
  );
  RETURN NEXT is(
    (SELECT payload->>'reassignment_reason' FROM public.route_stop_reassignment_events WHERE route_stop_id = v_stop_to_move LIMIT 1),
    'Capacity rebalance',
    'route_stop_reassignment_events stores the reassignment_reason'
  );
  RETURN NEXT is(
    (SELECT t.assigned_to::text
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.organization_id = v_org
        AND tt.key = 'route_stop_execute'
        AND EXISTS (
          SELECT 1
            FROM public.route_stops rs
           WHERE rs.id = t.resource_id
             AND rs.route_run_id = v_target_route_id
        )
      LIMIT 1
    ),
    v_driver_two::text,
    'moved route_stop task ownership follows the new route assignment'
  );
END;
$function$;

SELECT * FROM pg_temp.test_uc078_route_stop_mid_execution_reassignment_v1();

SELECT * FROM finish();
ROLLBACK;

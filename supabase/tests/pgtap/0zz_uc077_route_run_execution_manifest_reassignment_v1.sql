-- Plan: PLAN-202604-b06-route-run-execution-manifest / Step: E01
-- pgTAP: UC077 route run execution manifest + reassignment normalization v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

CREATE OR REPLACE FUNCTION pg_temp.test_uc077_route_run_execution_manifest_reassignment_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_driver_one UUID := gen_random_uuid();
  v_driver_two UUID := gen_random_uuid();
  v_vehicle_one UUID := gen_random_uuid();
  v_vehicle_two UUID := gen_random_uuid();
  v_route RECORD;
  v_assign_result JSONB := NULL;
  v_reassign_result JSONB := NULL;
  v_manifest JSONB := NULL;
  v_projection JSONB := NULL;
  v_event RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function('public', 'route_run_assignment_projection_v1', ARRAY['uuid'], 'public.route_run_assignment_projection_v1 exists');
  RETURN NEXT has_function('public', 'route_run_execution_manifest_v1', ARRAY['uuid'], 'public.route_run_execution_manifest_v1 exists');
  RETURN NEXT has_function('public', 'ui_route_run_execution_manifest_v1', ARRAY['uuid'], 'public.ui_route_run_execution_manifest_v1 exists');
  RETURN NEXT has_function('api', 'ui_route_run_execution_manifest_v1', ARRAY['uuid'], 'api.ui_route_run_execution_manifest_v1 exists');
  RETURN NEXT has_column('api', 'route_runs', 'route_execution_manifest', 'api.route_runs exposes route_execution_manifest');
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_route_run_execution_manifest_v1(uuid)', 'EXECUTE'),
    'authenticated can execute api.ui_route_run_execution_manifest_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'routes.reassign'
         AND item.value#>>'{execution,rpc}' = 'ui_execute_route_run_assign_v1'
    ),
    'ui_command_registry exposes routes.reassign'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC077 pgTap Org', 'uc077-pgtap-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'uc077', 'UC077 Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'UC077 Client', 'uc077-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_operator, v_org, 'uc077-ops-' || left(v_operator::text, 8) || '@example.com', 'UC077 Ops', 'ops_admin', 'active', 'tenant'),
    (v_driver_one, v_org, 'uc077-driver-a-' || left(v_driver_one::text, 8) || '@example.com', 'UC077 Driver A', 'driver', 'active', 'tenant'),
    (v_driver_two, v_org, 'uc077-driver-b-' || left(v_driver_two::text, 8) || '@example.com', 'UC077 Driver B', 'driver', 'active', 'tenant');

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES
    (v_vehicle_one, v_org, 'UC077-A-' || upper(left(v_vehicle_one::text, 4)), 'active', TRUE),
    (v_vehicle_two, v_org, 'UC077-B-' || upper(left(v_vehicle_two::text, 4)), 'active', TRUE);

  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_org, v_client, 'UC077-PGTAP-1', 'delivery', 'pending'),
    (v_org, v_client, 'UC077-PGTAP-2', 'delivery', 'pending');

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
          ) s
        )
      )
    )
   LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_assign_result := api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'driver_user_id', v_driver_one,
      'vehicle_id', v_vehicle_one,
      'idempotency_key', 'uc077-pgtap-assign-1'
    )
  );

  RETURN NEXT is(v_assign_result->>'status', 'assigned', 'routes.assign returns assigned status');

  v_manifest := api.ui_route_run_execution_manifest_v1(v_route.route_run_id);
  RETURN NEXT is(v_manifest->>'route_run_id', v_route.route_run_id::text, 'ui manifest returns route_run_id');
  RETURN NEXT is(v_manifest#>>'{route_assignment,driver_user_id}', v_driver_one::text, 'ui manifest overlays current assignment');
  RETURN NEXT is((v_manifest->>'stop_count')::text, '2', 'ui manifest returns stop_count');
  RETURN NEXT is(jsonb_array_length(COALESCE(v_manifest->'stops', '[]'::jsonb))::text, '2', 'ui manifest exposes stop list');

  SELECT route_execution_manifest, route_assignment
    INTO v_manifest, v_projection
    FROM api.route_runs
   WHERE id = v_route.route_run_id;

  RETURN NEXT ok(v_manifest->>'manifest_hash' IS NOT NULL, 'api.route_runs exposes manifest hash');
  RETURN NEXT is(v_projection->>'driver_user_id', v_driver_one::text, 'api.route_runs route_assignment prefers assignment projection');

  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.route_runs
     SET status = 'in_progress'
   WHERE id = v_route.route_run_id;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_reassign_result := api.ui_execute_route_run_assign_v1(
    'routes.reassign',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'driver_user_id', v_driver_two,
      'vehicle_id', v_vehicle_two,
      'reassignment_reason', 'Breakdown cover',
      'idempotency_key', 'uc077-pgtap-reassign-1'
    )
  );

  RETURN NEXT is(v_reassign_result->>'status', 'assigned', 'routes.reassign uses canonical assign RPC status');

  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT event_type, payload
    INTO v_event
    FROM public.route_run_assignment_events
   WHERE route_run_id = v_route.route_run_id
   ORDER BY assignment_version DESC, created_at DESC
   LIMIT 1;

  RETURN NEXT is(v_event.event_type, 'reassigned', 'latest route_run_assignment_event is normalized to reassigned');
  RETURN NEXT is(v_event.payload->>'reassignment_reason', 'Breakdown cover', 'reassignment event payload carries reassignment_reason');
  RETURN NEXT is(v_event.payload#>>'{previous_assignment,driver_user_id}', v_driver_one::text, 'reassignment event payload carries previous assignment snapshot');

  SELECT route_execution_manifest, route_assignment
    INTO v_manifest, v_projection
    FROM api.route_runs
   WHERE id = v_route.route_run_id;

  RETURN NEXT is(v_projection->>'driver_user_id', v_driver_two::text, 'assignment projection updates after reassignment');
  RETURN NEXT is(v_projection#>>'{metadata,reassignment_reason}', 'Breakdown cover', 'assignment projection metadata stores reassignment_reason');
  RETURN NEXT is(v_manifest#>>'{route_assignment,driver_user_id}', v_driver_two::text, 'manifest overlays the reassigned driver');
  RETURN NEXT is(v_manifest#>>'{route_assignment,metadata,previous_assignment,driver_user_id}', v_driver_one::text, 'manifest preserves previous assignment snapshot');
  RETURN NEXT is(v_manifest#>>'{route_assignment,metadata,reassignment_reason}', 'Breakdown cover', 'manifest preserves reassignment_reason');
  RETURN NEXT is(v_manifest#>>'{stops,0,task,assigned_to}', v_driver_two::text, 'manifest stop list reflects reassigned route_stop task ownership');
END;
$function$;

SELECT * FROM pg_temp.test_uc077_route_run_execution_manifest_reassignment_v1();

SELECT * FROM finish();
ROLLBACK;

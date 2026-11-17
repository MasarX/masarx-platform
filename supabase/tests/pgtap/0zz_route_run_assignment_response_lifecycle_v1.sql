-- pgTAP: UC080 route-run assignment response lifecycle v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(26);

CREATE OR REPLACE FUNCTION pg_temp.test_route_run_assignment_response_lifecycle_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_shipment1 UUID := gen_random_uuid();
  v_shipment2 UUID := gen_random_uuid();
  v_route RECORD;
  v_route2 RECORD;
  v_assignment_id UUID := gen_random_uuid();
  v_ack JSONB := NULL;
  v_accept JSONB := NULL;
  v_refuse JSONB := NULL;
  v_refuse_replay JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value INTO v_access
  FROM public.settings
  WHERE category = 'access_control_policy'
    AND scope_type = 'global'
  LIMIT 1;

  SELECT cached_value INTO v_registry
  FROM public.settings
  WHERE category = 'ui_command_registry'
    AND scope_type = 'global'
  LIMIT 1;

  RETURN NEXT has_function('public', 'respond_route_run_assignment_v1', ARRAY['jsonb'], 'public.respond_route_run_assignment_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'respond_route_run_assignment_v1', ARRAY['jsonb'], 'api.respond_route_run_assignment_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'ui_execute_route_run_assignment_response_v1', ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'], 'public.ui_execute_route_run_assignment_response_v1(...) exists');
  RETURN NEXT has_function('api', 'ui_execute_route_run_assignment_response_v1', ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'], 'api.ui_execute_route_run_assignment_response_v1(...) exists');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_access->'capabilities', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'routes.read'
    ),
    'access_control_policy exposes routes.read capability'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_runs.acknowledge_assignment'
        AND item.value->>'schema_category' = 'resource:routes'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_route_run_assignment_response_v1'
    ),
    'ui_command_registry exposes route_runs.acknowledge_assignment through the dedicated RPC'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_runs.accept_assignment'
        AND item.value->>'schema_category' = 'resource:routes'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_route_run_assignment_response_v1'
    ),
    'ui_command_registry exposes route_runs.accept_assignment through the dedicated RPC'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_runs.refuse_assignment'
        AND item.value->>'schema_category' = 'resource:routes'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_route_run_assignment_response_v1'
        AND item.value#>>'{execution,input_schema,fields,0,key}' = 'refusal_reason'
    ),
    'ui_command_registry exposes route_runs.refuse_assignment with refusal_reason input schema'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'route_run_assignments'
        AND indexname = 'idx_route_run_assignments_responded_by_user'
    ),
    'route_run_assignments has a responded_by_user_id supporting index'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Route Assignment Response Org', 'route-response-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'rar-' || lower(left(v_org::text, 6)), 'Route Assignment Response Branch');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Route Assignment Response Client', 'route-assignment-response-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_ops, v_org, 'ops-' || left(v_ops::text, 8) || '@example.com', 'Route Ops', 'ops_admin', 'active', 'tenant'),
    (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'Route Driver', 'driver', 'active', 'tenant');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.shipments (
    id, organization_id, client_id, tracking_number, status, service_type, created_at, updated_at
  )
  VALUES
    (v_shipment1, v_org, v_client, 'RRA-R1-' || upper(left(v_shipment1::text, 8)), 'pending', 'delivery', now(), now()),
    (v_shipment2, v_org, v_client, 'RRA-R2-' || upper(left(v_shipment2::text, 8)), 'pending', 'delivery', now(), now());

  SELECT *
    INTO v_route
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'planned_date', '2026-04-06',
        'idempotency_key', 'pgtap-route-run-assignment-response-ack',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
        )
      )
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.route_run_assignments (
    id,
    organization_id,
    route_run_id,
    assignment_status,
    assignment_mode,
    assignment_version,
    driver_user_id,
    vehicle_id,
    partner,
    assigned_by_user_id,
    assigned_at,
    notes,
    metadata
  )
  VALUES (
    v_assignment_id,
    v_org,
    v_route.route_run_id,
    'assigned',
    'internal_driver',
    1,
    v_driver,
    v_vehicle,
    NULL,
    v_ops,
    now(),
    'Seeded route run assignment for UC080 response tests',
    '{}'::jsonb
  );

  UPDATE public.route_runs
     SET driver_user_id = v_driver,
         vehicle_id = v_vehicle,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{route_assignment}',
           jsonb_strip_nulls(
             jsonb_build_object(
               'route_run_assignment_id', v_assignment_id,
               'assignment_status', 'assigned',
               'assignment_mode', 'internal_driver',
               'assignment_version', 1,
               'driver_user_id', v_driver,
               'vehicle_id', v_vehicle,
               'assigned_by_user_id', v_ops,
               'assigned_at', now(),
               'notes', 'Seeded route run assignment for UC080 response tests'
             )
           ),
           true
         )
   WHERE id = v_route.route_run_id;

  RETURN NEXT is(
    (SELECT assignment_status FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    'assigned',
    'route run assignment seeds the assignment projection'
  );
  RETURN NEXT is(
    (SELECT assignment_status FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    'assigned',
    'route_run_assignments stores assigned state before responses'
  );

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_ack := api.ui_execute_route_run_assignment_response_v1(
    'route_runs.acknowledge_assignment',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'idempotency_key', 'pgtap-route-run-assignment-response-ack-response'
    )
  );

  RETURN NEXT is(v_ack->>'status', 'acknowledged', 'assigned driver can acknowledge route assignment');
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(
    (SELECT assignment_status FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    'acknowledged',
    'route_run_assignments stores acknowledged status'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.route_run_assignments
      WHERE route_run_id = v_route.route_run_id
        AND acknowledged_at IS NOT NULL
        AND accepted_at IS NULL
        AND refused_at IS NULL
        AND responded_by_user_id = v_driver
    ),
    'acknowledgement persists timestamps and actor'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  v_accept := api.ui_execute_route_run_assignment_response_v1(
    'route_runs.accept_assignment',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'idempotency_key', 'pgtap-route-run-assignment-response-accept-response'
    )
  );

  RETURN NEXT is(v_accept->>'status', 'accepted', 'assigned driver can accept a previously acknowledged route assignment');
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(
    (SELECT assignment_status FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    'accepted',
    'route_run_assignments stores accepted status'
  );
  RETURN NEXT is(
    (SELECT assignment_version FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id),
    3,
    'assignment_version advances across assignment, acknowledgement, and acceptance'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM api.route_runs
      WHERE id = v_route.route_run_id
        AND route_assignment->>'assignment_status' = 'accepted'
    ),
    'api.route_runs projects accepted route assignment metadata'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.route_run_assignment_events WHERE route_run_id = v_route.route_run_id),
    2,
    'acknowledgement and acceptance each create an event row'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT *
    INTO v_route2
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'planned_date', '2026-04-06',
        'idempotency_key', 'pgtap-route-run-assignment-response-refuse',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE postgres';

  v_assignment_id := gen_random_uuid();
  INSERT INTO public.route_run_assignments (
    id,
    organization_id,
    route_run_id,
    assignment_status,
    assignment_mode,
    assignment_version,
    driver_user_id,
    vehicle_id,
    partner,
    assigned_by_user_id,
    assigned_at,
    notes,
    metadata
  )
  VALUES (
    v_assignment_id,
    v_org,
    v_route2.route_run_id,
    'assigned',
    'internal_driver',
    1,
    v_driver,
    v_vehicle,
    NULL,
    v_ops,
    now(),
    'Seeded route run assignment for UC080 response tests',
    '{}'::jsonb
  );

  UPDATE public.route_runs
     SET driver_user_id = v_driver,
         vehicle_id = v_vehicle,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{route_assignment}',
           jsonb_strip_nulls(
             jsonb_build_object(
               'route_run_assignment_id', v_assignment_id,
               'assignment_status', 'assigned',
               'assignment_mode', 'internal_driver',
               'assignment_version', 1,
               'driver_user_id', v_driver,
               'vehicle_id', v_vehicle,
               'assigned_by_user_id', v_ops,
               'assigned_at', now(),
               'notes', 'Seeded route run assignment for UC080 response tests'
             )
           ),
           true
         )
   WHERE id = v_route2.route_run_id;

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_refuse := api.ui_execute_route_run_assignment_response_v1(
    'route_runs.refuse_assignment',
    'routes',
    ARRAY[v_route2.route_run_id::text],
    v_route2.route_run_id::text,
    1,
    jsonb_build_object(
      'refusal_reason', 'Vehicle unavailable',
      'response_notes', 'Need a larger truck for this route.',
      'idempotency_key', 'pgtap-route-run-assignment-response-refuse-response'
    )
  );

  RETURN NEXT is(v_refuse->>'status', 'refused', 'assigned driver can refuse route assignment');
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(
    (SELECT assignment_status FROM public.route_run_assignments WHERE route_run_id = v_route2.route_run_id),
    'refused',
    'route_run_assignments stores refused status'
  );
  RETURN NEXT is(
    (SELECT refusal_reason FROM public.route_run_assignments WHERE route_run_id = v_route2.route_run_id),
    'Vehicle unavailable',
    'route_run_assignments stores refusal_reason'
  );
  RETURN NEXT is(
    (SELECT response_notes FROM public.route_run_assignments WHERE route_run_id = v_route2.route_run_id),
    'Need a larger truck for this route.',
    'route_run_assignments stores response_notes'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  v_refuse_replay := api.ui_execute_route_run_assignment_response_v1(
    'route_runs.refuse_assignment',
    'routes',
    ARRAY[v_route2.route_run_id::text],
    v_route2.route_run_id::text,
    1,
    jsonb_build_object(
      'refusal_reason', 'Vehicle unavailable',
      'response_notes', 'Need a larger truck for this route.',
      'idempotency_key', 'pgtap-route-run-assignment-response-refuse-response'
    )
  );

  RETURN NEXT ok(
    COALESCE((v_refuse_replay->'items'->0->>'updated')::boolean, FALSE) IS FALSE,
    'replaying the same refusal idempotency key returns updated=false'
  );
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.route_run_assignment_events WHERE route_run_id = v_route2.route_run_id),
    1,
    'refusal replay does not duplicate event rows'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM public.respond_route_run_assignment_v1(
          jsonb_build_object(
            'route_run_id', '%1$s'::uuid,
            'response_status', 'refused',
            'refusal_reason', 'Wrong vehicle',
            'actor_user_id', '%2$s'::uuid,
            'actor_system', 'pgtap-route-run-assignment-response-invalid'
          )
        )
      $sql$,
      v_route.route_run_id,
      v_driver
    ),
    '23514',
    'respond_route_run_assignment_v1 cannot transition accepted to refused',
    'accepted assignment cannot be refused'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_run_assignment_response_lifecycle_v1();

SELECT * FROM finish();

ROLLBACK;


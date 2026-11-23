-- pgTAP: UC076 route run assignment lifecycle foundation v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(53);

CREATE OR REPLACE FUNCTION pg_temp.test_route_run_assignment_lifecycle_foundation_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_commands JSONB := NULL;
  v_navigation JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_other_operator UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_other_driver UUID := gen_random_uuid();
  v_other_vehicle UUID := gen_random_uuid();
  v_route RECORD;
  v_route_two RECORD;
  v_other_route UUID := gen_random_uuid();
  v_assign_result JSONB := NULL;
  v_assign_replay JSONB := NULL;
  v_partner_result JSONB := NULL;
  v_list JSONB := NULL;
  v_readback JSONB;
  v_absent JSONB;
  v_assignment_id UUID;
  v_assignment_version INTEGER;
  v_synthetic_assignment UUID := gen_random_uuid();
  v_missing_event JSONB;
  v_case RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value INTO v_access FROM public.settings WHERE category = 'access_control_policy' AND scope_type = 'global' LIMIT 1;
  SELECT cached_value INTO v_registry FROM public.settings WHERE category = 'ui_read_registry' AND scope_type = 'global' LIMIT 1;
  SELECT cached_value INTO v_commands FROM public.settings WHERE category = 'ui_command_registry' AND scope_type = 'global' LIMIT 1;
  SELECT cached_value INTO v_navigation FROM public.settings WHERE category = 'ui_navigation' AND scope_type = 'global' LIMIT 1;

  RETURN NEXT has_function('public', 'assign_route_run_v1', ARRAY['jsonb'], 'public.assign_route_run_v1 exists');
  RETURN NEXT has_function('public', 'ui_execute_route_run_assign_v1', ARRAY['text','text','text[]','text','integer','jsonb'], 'public.ui_execute_route_run_assign_v1 exists');
  RETURN NEXT has_function('api', 'ui_execute_route_run_assign_v1', ARRAY['text','text','text[]','text','integer','jsonb'], 'api.ui_execute_route_run_assign_v1 exists');
  RETURN NEXT ok(
    has_function_privilege('service_role', 'public.assign_task_system_v1(uuid,uuid,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.assign_task_system_v1(uuid,uuid,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.assign_task_system_v1(uuid,uuid,text,text,text)', 'EXECUTE'),
    'route follow-up task assignment stays service-only'
  );
  RETURN NEXT ok(has_function_privilege('authenticated', 'api.ui_execute_route_run_assign_v1(text, text, text[], text, integer, jsonb)', 'EXECUTE'), 'authenticated can execute api.ui_execute_route_run_assign_v1');
  RETURN NEXT ok(has_table_privilege('authenticated', 'api.route_runs', 'SELECT'), 'authenticated can select api.route_runs');
  RETURN NEXT is(v_access#>>'{resource_map,routes,read}', 'routes.read', 'resource_map wires routes.read');
  RETURN NEXT is(v_access#>>'{resource_map,routes,write}', 'routes.write', 'resource_map wires routes.write');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'routes'
         AND item.value->>'relation' = 'api.route_runs'
         AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) = TRUE
         AND item.value->>'capability_read' = 'routes.read'
    ),
    'ui_read_registry exposes routes against api.route_runs for generic reads'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'key' = 'routes.assign'
         AND item.value#>>'{execution,rpc}' = 'ui_execute_route_run_assign_v1'
    ),
    'ui_command_registry exposes routes.assign'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
       WHERE section.value->>'id' = 'operations'
         AND item.value->>'resource' = 'routes'
    ),
    'console operations navigation includes routes'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'route_run_assignments'
         AND c.relrowsecurity
    ),
    'route_run_assignments has RLS enabled'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND p.tablename = 'route_run_assignments'
         AND p.policyname = 'route_run_assignments_service_policy'
    ),
    'route_run_assignments has a service-only RLS policy'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'route_run_assignment_events'
         AND c.relrowsecurity
    ),
    'route_run_assignment_events has RLS enabled'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND p.tablename = 'route_run_assignment_events'
         AND p.policyname = 'route_run_assignment_events_service_policy'
    ),
    'route_run_assignment_events has a service-only RLS policy'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'route_run_assignments'
         AND indexname = 'idx_route_run_assignments_driver_user'
    ),
    'route_run_assignments has a full driver_user_id supporting index'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'route_run_assignments'
         AND indexname = 'idx_route_run_assignments_vehicle'
    ),
    'route_run_assignments has a full vehicle_id supporting index'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'route_run_assignments'
         AND indexname = 'idx_route_run_assignments_assigned_by_user'
    ),
    'route_run_assignments has an assigned_by_user_id supporting index'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'route_run_assignment_events'
         AND indexname = 'idx_route_run_assignment_events_org_created'
    ),
    'route_run_assignment_events has an organization_id supporting index'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'route_run_assignment_events'
         AND indexname = 'idx_route_run_assignment_events_driver_user'
    ),
    'route_run_assignment_events has a driver_user_id supporting index'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'route_run_assignment_events'
         AND indexname = 'idx_route_run_assignment_events_vehicle'
    ),
    'route_run_assignment_events has a vehicle_id supporting index'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'route_run_assignment_events'
         AND indexname = 'idx_route_run_assignment_events_actor_user'
    ),
    'route_run_assignment_events has an actor_user_id supporting index'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC076 pgTap Org', 'uc076-pgtap-' || left(v_org::text, 8));

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'Other Route Fixture', 'route-fixture-' || v_other_org::text);

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'uc076', 'UC076 Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'UC076 Client', 'uc076-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_operator, v_org, 'uc076-ops-' || left(v_operator::text, 8) || '@example.com', 'UC076 Ops', 'ops_admin', 'active', 'tenant'),
    (v_driver, v_org, 'uc076-driver-' || left(v_driver::text, 8) || '@example.com', 'UC076 Driver', 'driver', 'active', 'tenant');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_other_driver, v_other_org, 'route-' || v_other_driver::text || chr(64) || concat_ws('.', 'example', 'invalid'),
      'Other Fixture Driver', 'driver', 'active', 'tenant');

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_org, 'UC076-' || upper(left(v_vehicle::text, 6)), 'active', TRUE);

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES (v_other_vehicle, v_other_org, 'TEST-' || upper(left(v_other_vehicle::text, 6)), 'active', TRUE);

  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_org, v_client, 'UC076-PGTAP-1', 'delivery', 'pending'),
    (v_org, v_client, 'UC076-PGTAP-2', 'delivery', 'pending'),
    (v_org, v_client, 'UC076-PGTAP-3', 'delivery', 'pending');

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
             LIMIT 2
          ) s
        )
      )
    )
   LIMIT 1;

  SELECT *
    INTO v_route_two
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'stops', (
          SELECT jsonb_build_array(
            jsonb_build_object(
              'client_id', s.client_id,
              'shipment_id', s.id,
              'stop_kind', 'delivery',
              'sequence_order', 1
            )
          )
          FROM public.shipments s
          WHERE s.organization_id = v_org
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT 1
        )
      )
    )
   LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format($sql$
      SELECT api.ui_execute_route_run_assign_v1(
        'routes.assign', 'routes', ARRAY[%L], %L, 1, jsonb_build_object('driver_user_id', %L, 'vehicle_id', %L)
      )
    $sql$, v_route.route_run_id, v_route.route_run_id, v_other_driver, v_vehicle),
    '42501', NULL, 'route assignment denies an active driver from another tenant'
  );
  RETURN NEXT throws_ok(
    format($sql$
      SELECT api.ui_execute_route_run_assign_v1(
        'routes.assign', 'routes', ARRAY[%L], %L, 1, jsonb_build_object('driver_user_id', %L, 'vehicle_id', %L)
      )
    $sql$, v_route.route_run_id, v_route.route_run_id, v_driver, v_other_vehicle),
    '42501', NULL, 'route assignment denies an active vehicle from another tenant'
  );

  v_assign_result := api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'driver_user_id', v_driver,
      'vehicle_id', v_vehicle,
      'idempotency_key', 'uc076-pgtap-assign-1'
    )
  );

  RETURN NEXT is(v_assign_result->>'status', 'assigned', 'route assignment ui RPC reports assigned');
  RETURN NEXT is((v_assign_result#>>'{items,0,assignment_mode}'), 'internal_driver', 'assignment returns internal_driver mode');
  v_assignment_id := (v_assign_result#>>'{items,0,route_run_assignment_id}')::uuid;
  v_assignment_version := (v_assign_result#>>'{items,0,assignment_version}')::integer;
  v_readback := api.ui_route_run_assignment_readback_v1(v_route.route_run_id, v_assignment_id, v_assignment_version);
  RETURN NEXT ok(
    v_readback->>'visible' = 'true'
    AND v_readback#>>'{assignment,id}' = v_assignment_id::text
    AND v_readback#>>'{assignment,route_run_id}' = v_route.route_run_id::text
    AND v_readback#>>'{assignment,assignment_version}' = v_assignment_version::text
    AND v_readback#>>'{event,route_run_assignment_id}' = v_assignment_id::text
    AND v_readback#>>'{event,route_run_id}' = v_route.route_run_id::text
    AND v_readback#>>'{event,assignment_version}' = v_assignment_version::text,
    'API readback confirms the exact canonical assignment and event'
  );
  RETURN NEXT is(
    public.ui_route_run_assignment_readback_v1(v_route.route_run_id, v_assignment_id, v_assignment_version),
    v_readback, 'public and API assignment readback have identical scoped results'
  );
  FOR v_case IN SELECT * FROM (VALUES
    (v_route.route_run_id, v_assignment_id, v_assignment_version + 1, 'wrong version'),
    (v_route.route_run_id, gen_random_uuid(), v_assignment_version, 'absent assignment'),
    (v_route_two.route_run_id, v_assignment_id, v_assignment_version, 'cross-route assignment')
  ) AS cases(route_id, assignment_id, version, label)
  LOOP
    v_absent := api.ui_route_run_assignment_readback_v1(v_case.route_id, v_case.assignment_id, v_case.version);
    RETURN NEXT ok(
      v_absent->>'visible' = 'false'
      AND v_absent->'assignment' = 'null'::jsonb AND v_absent->'event' = 'null'::jsonb,
      'assignment readback rejects ' || v_case.label
    );
  END LOOP;
  FOR v_case IN SELECT * FROM (VALUES
    (NULL::uuid, v_assignment_id, v_assignment_version, 'null route'),
    (v_route.route_run_id, NULL::uuid, v_assignment_version, 'null assignment'),
    (v_route.route_run_id, v_assignment_id, NULL::integer, 'null version'),
    (v_route.route_run_id, v_assignment_id, 0, 'zero version')
  ) AS cases(route_id, assignment_id, version, label)
  LOOP
    RETURN NEXT throws_ok(
      format('SELECT api.ui_route_run_assignment_readback_v1(%L::uuid,%L::uuid,%L::integer)',
        v_case.route_id, v_case.assignment_id, v_case.version),
      '23514', 'ui_route_run_assignment_readback_v1 requires a route, assignment, and positive version',
      'assignment readback rejects ' || v_case.label
    );
  END LOOP;
  BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    INSERT INTO public.route_run_assignments (
      id, organization_id, route_run_id, assignment_mode, driver_user_id, vehicle_id, assigned_by_user_id
    ) VALUES (v_synthetic_assignment, v_org, v_route_two.route_run_id, 'internal_driver', v_driver, v_vehicle, v_operator);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_missing_event := api.ui_route_run_assignment_readback_v1(v_route_two.route_run_id, v_synthetic_assignment, 1);
    RAISE EXCEPTION USING ERRCODE = 'ZX222', MESSAGE = 'rollback synthetic missing-event fixture';
  EXCEPTION WHEN SQLSTATE 'ZX222' THEN NULL;
  END;
  RETURN NEXT ok(
    v_missing_event->>'visible' = 'false'
    AND v_missing_event#>>'{assignment,id}' = v_synthetic_assignment::text
    AND v_missing_event->'event' = 'null'::jsonb,
    'existing assignment without its event cannot report visible success'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.ui_route_run_assignment_readback_v1(uuid,uuid,integer)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.ui_route_run_assignment_readback_v1(uuid,uuid,integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.ui_route_run_assignment_readback_v1(uuid,uuid,integer)', 'EXECUTE'),
    'public assignment readback grants exclude anon'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_route_run_assignment_readback_v1(uuid,uuid,integer)', 'EXECUTE')
    AND has_function_privilege('service_role', 'api.ui_route_run_assignment_readback_v1(uuid,uuid,integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.ui_route_run_assignment_readback_v1(uuid,uuid,integer)', 'EXECUTE'),
    'API assignment readback grants exclude anon'
  );
  RETURN NEXT ok(
    (SELECT count(*) = 2 AND count(DISTINCT item->>'key') = 2 AND bool_and(COALESCE(
      item#>>'{execution,readback,rpc}' = 'ui_route_run_assignment_readback_v1'
      AND item#>>'{execution,readback,success_path}' = 'visible'
      AND item#>'{execution,readback,params}' = jsonb_build_object(
        'p_route_run_id', jsonb_build_object('source', 'result', 'path', 'items.0.route_run_id'),
        'p_route_run_assignment_id', jsonb_build_object('source', 'result', 'path', 'items.0.route_run_assignment_id'),
        'p_assignment_version', jsonb_build_object('source', 'result', 'path', 'items.0.assignment_version')
      ), FALSE))
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) item
      WHERE item->>'key' IN ('routes.assign', 'routes.reassign')),
    'assignment commands read back the exact result identity before success'
  );
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT assignment_mode FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id), 'internal_driver', 'projection stores internal driver mode');
  RETURN NEXT is((SELECT vehicle_id::text FROM public.route_run_assignments WHERE route_run_id = v_route.route_run_id), v_vehicle::text, 'projection stores selected vehicle_id');
  RETURN NEXT is((SELECT driver_user_id::text FROM public.route_runs WHERE id = v_route.route_run_id), v_driver::text, 'route_runs driver_user_id is updated');
  RETURN NEXT is((SELECT vehicle_id::text FROM public.route_runs WHERE id = v_route.route_run_id), v_vehicle::text, 'route_runs vehicle_id is updated');
  RETURN NEXT is(
    (SELECT COUNT(*)::text
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.organization_id = v_org
        AND tt.key = 'route_stop_execute'
        AND t.assigned_to = v_driver
        AND EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.id = t.resource_id AND rs.route_run_id = v_route.route_run_id)
    ),
    '2',
    'route_stop_execute tasks are assigned to the internal driver'
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_assign_replay := api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_route.route_run_id::text],
    v_route.route_run_id::text,
    1,
    jsonb_build_object(
      'driver_user_id', v_driver,
      'vehicle_id', v_vehicle,
      'idempotency_key', 'uc076-pgtap-assign-1'
    )
  );

  RETURN NEXT is((v_assign_replay#>>'{items,0,created}'), 'false', 'idempotency replay returns created=false');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.route_run_assignment_events WHERE route_run_id = v_route.route_run_id), '1', 'idempotency replay does not create a second assignment event');

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_partner_result := api.ui_execute_route_run_assign_v1(
    'routes.assign',
    'routes',
    ARRAY[v_route_two.route_run_id::text],
    v_route_two.route_run_id::text,
    1,
    jsonb_build_object(
      'partner_id', 'partner-1',
      'partner_name', 'Fast Partner Fleet'
    )
  );

  RETURN NEXT is((v_partner_result#>>'{items,0,assignment_mode}'), 'partner_fleet', 'partner assignment returns partner_fleet mode');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT assignment_mode FROM public.route_run_assignments WHERE route_run_id = v_route_two.route_run_id), 'partner_fleet', 'projection stores partner_fleet mode');

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_operator::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_list := public.ui_list_resource_v1('routes', '{}'::jsonb, 25, 0, NULL);
  RETURN NEXT is(v_list->>'resource', 'routes', 'ui_list_resource_v1 exposes routes resource');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_list->'items', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'id' = v_route.route_run_id::text
         AND item.value#>>'{route_assignment,assignment_mode}' = 'internal_driver'
    ),
    'ui_list_resource_v1(routes) surfaces route assignment metadata'
  );

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  RETURN NEXT throws_ok(
    format('SELECT api.ui_route_run_assignment_readback_v1(%L::uuid,%L::uuid,%L::integer)',
      v_route_two.route_run_id, v_partner_result#>>'{items,0,route_run_assignment_id}',
      v_partner_result#>>'{items,0,assignment_version}'),
    '42501', NULL, 'driver cannot read back another executor route assignment'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_other_operator, v_other_org, 'route-' || v_other_operator::text || chr(64) || concat_ws('.', 'example', 'invalid'),
          'Other Fixture Operator', 'ops_admin', 'active', 'tenant');
  INSERT INTO public.route_runs (id, organization_id)
  VALUES (v_other_route, v_other_org);

  PERFORM set_config('request.jwt.claim.sub', v_other_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other_operator::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(
    public.ui_get_resource_v1('routes', v_other_route)->>'id',
    v_other_route::text,
    'the foreign operator has route read authority in its own tenant'
  );
  RETURN NEXT throws_ok(
    format('SELECT api.ui_route_run_assignment_readback_v1(%L::uuid,%L::uuid,%L::integer)',
      v_route.route_run_id, v_assignment_id, v_assignment_version),
    '42501', format('route %s is not visible for assignment readback', v_route.route_run_id),
    'a foreign tenant operator cannot read the exact assignment event'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_run_assignment_lifecycle_foundation_v1();

SELECT * FROM finish();

ROLLBACK;

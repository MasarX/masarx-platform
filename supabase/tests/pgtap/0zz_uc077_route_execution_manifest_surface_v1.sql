-- pgTAP: UC077 route execution manifest surface v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(53);

CREATE OR REPLACE FUNCTION pg_temp.test_uc077_route_execution_manifest_surface_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_navigation JSONB := NULL;
  v_platform UUID := gen_random_uuid();
  v_platform_home_org UUID := gen_random_uuid();
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_driver_one UUID := gen_random_uuid();
  v_driver_two UUID := gen_random_uuid();
  v_vehicle_one UUID := gen_random_uuid();
  v_vehicle_two UUID := gen_random_uuid();
  v_route_one UUID := gen_random_uuid();
  v_route_two UUID := gen_random_uuid();
  v_address_b UUID := gen_random_uuid();
  v_task UUID;
  v_created RECORD;
  v_step public.workflow_run_steps%ROWTYPE;
  v_run public.workflow_runs%ROWTYPE;
  v_response public.workflow_handler_response;
  v_claims_before TEXT;
  v_other_client UUID := gen_random_uuid();
  v_address UUID := gen_random_uuid();
  v_stop_one UUID;
  v_stop_other UUID;
  v_shipment_one UUID := gen_random_uuid();
  v_shipment_two UUID := gen_random_uuid();
  v_shipment_three UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_access
    FROM public.settings
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_navigation
    FROM public.settings
   WHERE category = 'ui_navigation'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function(
    'public',
    'route_run_actor_can_read_v1',
    ARRAY['uuid', 'uuid', 'uuid'],
    'public.route_run_actor_can_read_v1(uuid, uuid, uuid) exists'
  );
  RETURN NEXT has_view('public', 'route_runs_visible_v1', 'public.route_runs_visible_v1 exists');
  RETURN NEXT has_view('public', 'route_stops_visible_v1', 'public.route_stops_visible_v1 exists');
  RETURN NEXT ok(has_table_privilege('authenticated', 'api.route_runs', 'SELECT'), 'authenticated can select api.route_runs');
  RETURN NEXT ok(has_table_privilege('authenticated', 'api.route_stops', 'SELECT'), 'authenticated can select api.route_stops');
  RETURN NEXT ok(has_function_privilege('authenticated', 'public.ui_route_run_assignment_projection_v1(uuid)', 'EXECUTE'), 'authenticated can execute ui_route_run_assignment_projection_v1');
  RETURN NEXT ok(has_function_privilege('authenticated', 'public.ui_route_run_execution_manifest_v1(uuid)', 'EXECUTE'), 'authenticated can execute ui_route_run_execution_manifest_v1');
  RETURN NEXT ok(has_function_privilege('authenticated', 'public.route_run_scan_out_reconciliation_v1(uuid)', 'EXECUTE'), 'authenticated can execute route_run_scan_out_reconciliation_v1');
  RETURN NEXT is(v_access#>>'{resource_map,route_stops,read}', 'routes.read', 'resource_map wires route_stops.read to routes.read');
  RETURN NEXT is(v_access#>>'{resource_map,route_stops,write}', 'routes.write', 'resource_map wires route_stops.write to routes.write');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'routes'
        AND item.value->>'relation' = 'api.route_runs'
        AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) = TRUE
    ),
    'ui_read_registry routes resource now uses api.route_runs for generic reads'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'route_stops'
        AND item.value->>'relation' = 'api.route_stops'
        AND COALESCE((item.value->>'allow_view_relation')::boolean, FALSE) = TRUE
        AND item.value->>'capability_read' = 'routes.read'
    ),
    'ui_read_registry exposes route_stops through api.route_stops for generic reads'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'route_stops'
    ),
    'console operations navigation includes route_stops'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'route_stops'
    ),
    'portal operations navigation includes route_stops'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC077 Manifest Org', 'uc077-manifest-' || left(v_org::text, 8));
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_platform_home_org, 'UC077 Platform Home', 'uc077-platform-' || left(v_platform_home_org::text, 8));
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_platform, v_platform_home_org, 'uc077-platform-' || left(v_platform::text, 8) || '@example.com',
    'UC077 Platform', 'ops_admin', 'active', 'platform');

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'uc077', 'UC077 Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'UC077 Client', 'uc077-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_other_client, v_org, 'Other map client', 'map-other-' || left(v_other_client::text,8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_ops, v_org, 'uc077-ops-' || left(v_ops::text, 8) || '@example.com', 'UC077 Ops', 'ops_admin', 'active', 'tenant'),
    (v_driver_one, v_org, 'uc077-driver1-' || left(v_driver_one::text, 8) || '@example.com', 'UC077 Driver One', 'driver', 'active', 'tenant'),
    (v_driver_two, v_org, 'uc077-driver2-' || left(v_driver_two::text, 8) || '@example.com', 'UC077 Driver Two', 'driver', 'active', 'tenant');

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES
    (v_vehicle_one, v_org, 'UC077-A', 'active', TRUE),
    (v_vehicle_two, v_org, 'UC077-B', 'active', TRUE);

  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_shipment_one, v_org, v_client, 'UC077-PGTAP-1', 'delivery', 'pending'),
    (v_shipment_two, v_org, v_client, 'UC077-PGTAP-2', 'delivery', 'pending'),
    (v_shipment_three, v_org, v_client, 'UC077-PGTAP-3', 'delivery', 'pending');

  INSERT INTO public.addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status, sa_short_code, coordinates)
  VALUES (v_address, v_org, v_client, 'Canonical address', 'Riyadh', 'Riyadh', 'SA', 'pending', 'ABCD1234',
    ST_SetSRID(ST_MakePoint(46.7, 24.7), 4326)::geography);
  INSERT INTO public.addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
  VALUES (v_address, v_org, v_other_client, 'Wrong client address', 'Jeddah', 'Makkah', 'SA', 'invalid');
  UPDATE public.shipments SET destination_address_id = v_address WHERE id = v_shipment_one AND client_id = v_client;

  INSERT INTO public.route_runs (
    id,
    organization_id,
    branch_id,
    driver_user_id,
    vehicle_id,
    status,
    planned_date,
    metadata
  )
  VALUES
    (
      v_route_one,
      v_org,
      v_branch,
      v_driver_one,
      v_vehicle_one,
      'planned',
      CURRENT_DATE,
      jsonb_build_object(
        'route_assignment',
        jsonb_build_object(
          'assignment_status', 'assigned',
          'assignment_mode', 'internal_driver',
          'driver_user_id', v_driver_one,
          'vehicle_id', v_vehicle_one
        )
      )
    ),
    (
      v_route_two,
      v_org,
      v_branch,
      v_driver_two,
      v_vehicle_two,
      'planned',
      CURRENT_DATE,
      jsonb_build_object(
        'route_assignment',
        jsonb_build_object(
          'assignment_status', 'assigned',
          'assignment_mode', 'internal_driver',
          'driver_user_id', v_driver_two,
          'vehicle_id', v_vehicle_two
        )
      )
    );

  INSERT INTO public.route_stops (
    organization_id,
    route_run_id,
    client_id,
    shipment_id,
    stop_kind,
    sequence_order
  )
  VALUES
    (v_org, v_route_one, v_client, v_shipment_one, 'delivery', 1),
    (v_org, v_route_one, v_client, v_shipment_two, 'delivery', 2),
    (v_org, v_route_two, v_client, v_shipment_three, 'delivery', 1);

  SELECT id INTO v_stop_one FROM public.route_stops WHERE route_run_id = v_route_one AND shipment_id = v_shipment_one;
  SELECT id INTO v_stop_other FROM public.route_stops WHERE route_run_id = v_route_two;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN NEXT is(public.route_stop_task_contact_metadata_v1(v_stop_one)#>>'{address,id}', v_address::text, 'service workflow context retains canonical address');
  RETURN NEXT is(public.route_stop_task_contact_metadata_v1(v_stop_one)#>>'{address,validation_status}', 'pending', 'coordinates never imply address approval');
  RETURN NEXT is((public.route_stop_task_contact_metadata_v1(v_stop_one)#>>'{address,coordinates,latitude}')::numeric, 24.7::numeric, 'canonical numeric latitude');
  RETURN NEXT is((public.route_stop_task_contact_metadata_v1(v_stop_one)#>>'{address,coordinates,longitude}')::numeric, 46.7::numeric, 'canonical numeric longitude');
  RETURN NEXT is(public.route_stop_task_contact_metadata_v1(v_stop_one)#>>'{address,raw_input}', 'Canonical address', 'duplicate address UUID is bound to shipment client');
  UPDATE public.addresses SET validation_status = 'valid' WHERE id = v_address AND client_id = v_client;

  INSERT INTO public.task_types (organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_org, 'route_stop_execute', 'Route Stop Execute', TRUE, 50, 'default')
  ON CONFLICT (organization_id, key) DO NOTHING;
  INSERT INTO public.addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
  VALUES (v_address_b, v_org, v_client, 'Destination B', 'Riyadh', 'Riyadh', 'SA', 'valid');
  SELECT * INTO v_created FROM public.create_task_system_v1(jsonb_build_object(
    'task_type_key','route_stop_execute','context',jsonb_build_object('organization_id',v_org),
    'resource_type','route_stop','resource_id',v_stop_one,
    'idempotency_key','map-atomic-' || v_stop_one::text,
    'metadata',jsonb_build_object('unrelated','preserved'),'actor_system','dispatch_engine'));
  v_task := v_created.task_id;
  RETURN NEXT is((SELECT metadata#>>'{address,coordinates,latitude}' FROM public.tasks WHERE id=v_task), '24.7', 'actual task insertion trigger captures address A coordinates');
  UPDATE public.shipments SET destination_address_id=v_address_b WHERE id=v_shipment_one AND client_id=v_client;
  UPDATE public.tasks SET metadata=metadata || '{"touched":true}'::jsonb WHERE id=v_task;
  RETURN NEXT ok((SELECT metadata#>>'{address,id}'=v_address_b::text AND NOT (metadata->'address') ? 'coordinates' FROM public.tasks WHERE id=v_task), 'actual task update trigger atomically replaces A by valid B without coordinates');
  UPDATE public.shipments SET destination_address_id=v_address WHERE id=v_shipment_one AND client_id=v_client;
  PERFORM public.route_run_sync_stop_task_metadata_v1(v_route_one);
  RETURN NEXT is((SELECT metadata#>>'{address,coordinates,latitude}' FROM public.tasks WHERE id=v_task), '24.7', 'route sync restores current A snapshot');
  UPDATE public.shipments SET destination_address_id=v_address_b WHERE id=v_shipment_one AND client_id=v_client;
  PERFORM public.route_run_sync_stop_task_metadata_v1(v_route_one);
  RETURN NEXT ok((SELECT metadata#>>'{address,id}'=v_address_b::text AND NOT (metadata->'address') ? 'coordinates' FROM public.tasks WHERE id=v_task), 'route sync replaces A with coordinate-free B without deep-merge residue');
  UPDATE public.shipments SET destination_address_id=NULL WHERE id=v_shipment_one AND client_id=v_client;
  UPDATE public.tasks SET metadata=metadata || '{"touched":true}'::jsonb WHERE id=v_task;
  RETURN NEXT ok((SELECT NOT metadata ? 'address' FROM public.tasks WHERE id=v_task), 'actual trigger clears removed destination address');
  RETURN NEXT is((SELECT metadata->>'unrelated' FROM public.tasks WHERE id=v_task), 'preserved', 'atomic replacement preserves unrelated metadata');
  UPDATE public.shipments SET destination_address_id=v_address_b WHERE id=v_shipment_one AND client_id=v_client;
  v_step.id := gen_random_uuid();
  v_step.metadata := jsonb_build_object('items_jsonpath','$.stops','task_type_key','route_stop_execute','resource_type','route_stop',
    'task_metadata',jsonb_build_object('address',jsonb_build_object('id',v_address,'coordinates',jsonb_build_object('latitude',1,'longitude',2))));
  v_run.id := gen_random_uuid();
  v_run.context := jsonb_build_object('organization_id',v_org,'stops',jsonb_build_array(v_stop_one));
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_driver_one,'organization_id',v_org,'access_scope_type','tenant')::text,true);
  v_claims_before := current_setting('request.jwt.claims',true);
  v_response := workflow_handlers.execute_task_enqueue_many_v1(v_step,v_run,'{}'::jsonb);
  v_task := (v_response.operation_result#>>'{task_ids,0}')::uuid;
  RETURN NEXT ok((SELECT metadata#>>'{address,id}'=v_address_b::text AND NOT (metadata->'address') ? 'coordinates' FROM public.tasks WHERE id=v_task), 'actual workflow fanout discards stale base address before task creation');
  RETURN NEXT is(current_setting('request.jwt.claims',true),v_claims_before,'fanout restores its caller claims');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  UPDATE public.shipments SET destination_address_id=v_address WHERE id=v_shipment_one AND client_id=v_client;

  RETURN NEXT ok(
    public.route_run_assignment_projection_v1(v_route_one) IS NULL,
    'route_run_assignment_projection_v1 returns NULL when the canonical assignment row is absent'
  );
  RETURN NEXT is(
    COALESCE(
      public.route_run_execution_manifest_build_v1(v_route_one)->'route_assignment',
      'null'::jsonb
    ),
    'null'::jsonb,
    'execution manifest leaves route_assignment null when only metadata fallback exists'
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'role', 'authenticated',
      'sub', v_driver_one::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_driver_one::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(public.route_stop_task_contact_metadata_v1(v_stop_other), '{}'::jsonb, 'direct contact helper hides another driver route');
  RETURN NEXT is((SELECT destination_address->>'id' FROM api.route_stops WHERE id = v_stop_one), v_address::text, 'API projects scoped destination identity');
  RETURN NEXT is((SELECT destination_address->>'validation_status' FROM api.route_stops WHERE id = v_stop_one), 'valid', 'API reads current exact validation without task refresh');
  RETURN NEXT is(public.ui_get_resource_v1('route_stops', v_stop_one)#>>'{destination_address,sa_short_code}', 'ABCD1234', 'registry includes canonical short code');
  RETURN NEXT is(jsonb_typeof((SELECT destination_address#>'{coordinates,latitude}' FROM api.route_stops WHERE id = v_stop_one)), 'number', 'API coordinate is numeric JSON');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_driver_one,'organization_id',gen_random_uuid(),'access_scope_type','tenant')::text, true);
  RETURN NEXT is(public.route_stop_task_contact_metadata_v1(v_stop_one), '{}'::jsonb, 'mismatched organization fails closed');
  RETURN NEXT is(public.route_run_actor_can_read_v1(v_org, v_route_one, v_driver_one), FALSE, 'shared route guard rejects mismatched organization claim');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_driver_one,'access_scope_type','tenant')::text, true);
  RETURN NEXT is(public.route_run_actor_can_read_v1(v_org, v_route_one, v_driver_one), TRUE, 'missing optional organization claim uses canonical tenant authority');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_driver_one,'organization_id',v_org,'access_scope_type','tenant')::text, true);
  RETURN NEXT is(public.route_run_actor_can_read_v1(v_org, v_route_one, v_driver_one), TRUE, 'matching organization claim retains driver route authority');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_driver_one,'organization_id',NULL,'access_scope_type','tenant')::text, true);
  RETURN NEXT is(public.route_run_actor_can_read_v1(v_org, v_route_one, v_driver_one), FALSE, 'explicit null organization claim fails closed');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_driver_one,'organization_id',123,'access_scope_type','tenant')::text, true);
  RETURN NEXT is(public.route_run_actor_can_read_v1(v_org, v_route_one, v_driver_one), FALSE, 'nonstring organization claim fails closed');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','service_role','organization_id',gen_random_uuid())::text, true);
  RETURN NEXT is(public.route_run_actor_can_read_v1(v_org, v_route_one, v_driver_one), TRUE, 'service-role route authority retains its existing organization-independent contract');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_driver_one,'organization_id',v_org,'access_scope_type','tenant')::text, true);
  RETURN NEXT is((SELECT destination_address FROM api.route_stops WHERE route_run_id = v_route_one AND shipment_id = v_shipment_two), NULL::jsonb, 'absent destination does not invent address approval');

  RETURN NEXT is(
    public.ui_get_resource_v1('routes', v_route_one)->>'id',
    v_route_one::text,
    'ui_get_resource_v1 returns the assigned route for the driver'
  );
  RETURN NEXT ok(
    public.ui_get_resource_v1('routes', v_route_two) IS NULL,
    'ui_get_resource_v1 hides routes assigned to other drivers'
  );
  RETURN NEXT is(
    (public.ui_list_resource_v1('routes', '{}'::jsonb, 25, 0, NULL)->>'total')::int,
    1,
    'ui_list_resource_v1 supports security_invoker route views'
  );
  RETURN NEXT is(
    (public.ui_resource_metrics_v1('route_stops', '{}'::jsonb, NULL)->>'total')::int,
    2,
    'ui_resource_metrics_v1 supports security_invoker route_stop views'
  );
  RETURN NEXT is(
    public.ui_filter_distinct_values_v1('route_stops', 'route_run_status', NULL, 10)#>>'{0}',
    'planned',
    'ui_filter_distinct_values_v1 supports security_invoker route_stop views'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_runs),
    1,
    'driver-scoped api.route_runs only returns the assigned route'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_stops WHERE route_run_id = v_route_one),
    2,
    'driver-scoped api.route_stops returns the assigned stop list'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_stops WHERE route_run_id = v_route_two),
    0,
    'driver-scoped api.route_stops hides stops for other drivers'
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_runs),
    2,
    'tenant ops with routes.write sees the full route inventory'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_stops),
    3,
    'tenant ops with routes.write sees the full route stop manifest inventory'
  );

  PERFORM set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',v_platform,
    'organization_id',v_platform_home_org,'access_scope_type','platform')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_platform::text, true);
  RETURN NEXT is(public.route_run_actor_can_read_v1(v_org, v_route_one, v_driver_one), TRUE,
    'authorized platform actor retains cross-tenant route access with its home organization claim');

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_uc077_route_execution_manifest_surface_v1();

SELECT * FROM finish();

ROLLBACK;

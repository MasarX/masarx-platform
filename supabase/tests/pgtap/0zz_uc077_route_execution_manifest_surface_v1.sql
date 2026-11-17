-- pgTAP: UC077 route execution manifest surface v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(26);

CREATE OR REPLACE FUNCTION pg_temp.test_uc077_route_execution_manifest_surface_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_navigation JSONB := NULL;
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

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'uc077', 'UC077 Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'UC077 Client', 'uc077-client-' || left(v_client::text, 8), 'active');

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

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_uc077_route_execution_manifest_surface_v1();

SELECT * FROM finish();

ROLLBACK;

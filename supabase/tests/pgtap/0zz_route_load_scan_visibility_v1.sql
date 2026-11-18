-- pgTAP: Caller-scoped route-load summary; raw telemetry remains service-only.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

CREATE OR REPLACE FUNCTION pg_temp.test_route_load_scan_visibility_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_other_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_other_client UUID := gen_random_uuid();
  v_driver_one UUID := gen_random_uuid();
  v_driver_two UUID := gen_random_uuid();
  v_scan_actor UUID := gen_random_uuid();
  v_readonly UUID := gen_random_uuid();
  v_platform UUID := gen_random_uuid();
  v_vehicle_one UUID := gen_random_uuid();
  v_vehicle_two UUID := gen_random_uuid();
  v_other_vehicle UUID := gen_random_uuid();
  v_route_one UUID := gen_random_uuid();
  v_route_two UUID := gen_random_uuid();
  v_other_route UUID := gen_random_uuid();
  v_stop_one UUID := gen_random_uuid();
  v_stop_two UUID := gen_random_uuid();
  v_other_stop UUID := gen_random_uuid();
  v_shipment_one UUID := gen_random_uuid();
  v_shipment_two UUID := gen_random_uuid();
  v_empty_shipment UUID := gen_random_uuid();
  v_empty_stop UUID := gen_random_uuid();
  v_policy JSONB;
  v_other_shipment UUID := gen_random_uuid();
BEGIN
  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.scan_events', 'SELECT'),
    'authenticated cannot directly read telemetry'
  );
  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.scan_events', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.scan_events', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.scan_events', 'DELETE'),
    'authenticated has no direct telemetry mutation privileges'
  );
  RETURN NEXT ok(
    NOT has_table_privilege('anon', 'public.scan_events', 'SELECT'),
    'anon cannot SELECT scan_events'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.route_stop_load_scan_summary_v1(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.route_stop_load_scan_summary_v1(uuid)', 'EXECUTE'),
    'only authenticated callers can invoke the scoped summary'
  );
  RETURN NEXT ok(
    NOT has_function_privilege('service_role', 'public.route_stop_load_scan_summary_v1(uuid)', 'EXECUTE'),
    'service role has no direct summary EXECUTE privilege'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Tenant RBAC Scan Grant Org', 'tenant-rbac-scan-grant-' || left(v_org::text, 8)),
    (v_other_org, 'Tenant RBAC Scan Grant Other Org', 'tenant-rbac-scan-grant-other-' || left(v_other_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES
    (v_branch, v_org, 'trg-' || left(v_branch::text, 8), 'Tenant RBAC Scan Grant Branch', 'Asia/Riyadh'),
    (v_other_branch, v_other_org, 'trg-' || left(v_other_branch::text, 8), 'Tenant RBAC Scan Grant Other Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client, v_org, 'Tenant RBAC Scan Grant Client', 'tenant-rbac-scan-grant-client-' || left(v_client::text, 8), 'active'),
    (v_other_client, v_other_org, 'Tenant RBAC Scan Grant Other Client', 'tenant-rbac-scan-grant-other-client-' || left(v_other_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_driver_one, v_org, 'trg-driver1-' || left(v_driver_one::text, 8) || '@example.com', 'Tenant RBAC Driver One', 'driver', 'active', 'tenant'),
    (v_driver_two, v_org, 'trg-driver2-' || left(v_driver_two::text, 8) || '@example.com', 'Tenant RBAC Driver Two', 'driver', 'active', 'tenant'),
    (v_scan_actor, v_org, 'trg-loader-' || left(v_scan_actor::text, 8) || '@example.com', 'Tenant RBAC Loader', 'ops_admin', 'active', 'tenant'),
    (v_readonly, v_org, 'trg-reader-' || left(v_readonly::text, 8) || '@example.com', 'Caller without route capability', 'account_manager', 'active', 'tenant'),
    (v_platform, v_org, 'trg-platform-' || left(v_platform::text, 8) || '@example.com', 'Cross-tenant platform reader', 'super_admin', 'active', 'platform');

  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1('global', NULL, FALSE) LIMIT 1;
  SELECT jsonb_set(v_policy, '{roles}', jsonb_agg(CASE
    WHEN role->>'key' = 'account_manager' THEN jsonb_set(role, '{capability_keys}', '["shipments.read"]')
    ELSE role END)) INTO v_policy
  FROM jsonb_array_elements(v_policy->'roles') AS role;
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org, v_policy, 1,
    'Synthetic read-only route-summary denial fixture');

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES
    (v_vehicle_one, v_org, 'TRG-1-' || left(v_vehicle_one::text, 4), 'active', TRUE),
    (v_vehicle_two, v_org, 'TRG-2-' || left(v_vehicle_two::text, 4), 'active', TRUE),
    (v_other_vehicle, v_other_org, 'TRG-O-' || left(v_other_vehicle::text, 4), 'active', TRUE);

  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_shipment_one, v_org, v_client, 'TRG-' || left(v_shipment_one::text, 8), 'delivery', 'pending'),
    (v_shipment_two, v_org, v_client, 'TRG-' || left(v_shipment_two::text, 8), 'delivery', 'pending'),
    (v_empty_shipment, v_org, v_client, 'TRG-' || left(v_empty_shipment::text, 8), 'delivery', 'pending'),
    (v_other_shipment, v_other_org, v_other_client, 'TRG-' || left(v_other_shipment::text, 8), 'delivery', 'pending');

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, vehicle_id, status, planned_date, metadata)
  VALUES
    (
      v_route_one,
      v_org,
      v_branch,
      v_driver_one,
      v_vehicle_one,
      'planned',
      CURRENT_DATE,
      jsonb_build_object('route_assignment', jsonb_build_object('assignment_status', 'assigned', 'assignment_mode', 'internal_driver', 'driver_user_id', v_driver_one, 'vehicle_id', v_vehicle_one))
    ),
    (
      v_route_two,
      v_org,
      v_branch,
      v_driver_two,
      v_vehicle_two,
      'planned',
      CURRENT_DATE,
      jsonb_build_object('route_assignment', jsonb_build_object('assignment_status', 'assigned', 'assignment_mode', 'internal_driver', 'driver_user_id', v_driver_two, 'vehicle_id', v_vehicle_two))
    ),
    (
      v_other_route,
      v_other_org,
      v_other_branch,
      NULL,
      v_other_vehicle,
      'planned',
      CURRENT_DATE,
      '{}'::jsonb
    );

  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
  VALUES
    (v_stop_one, v_org, v_route_one, v_client, v_shipment_one, 'delivery', 1),
    (v_stop_two, v_org, v_route_two, v_client, v_shipment_two, 'delivery', 1),
    (v_empty_stop, v_org, v_route_one, v_client, v_empty_shipment, 'delivery', 2),
    (v_other_stop, v_other_org, v_other_route, v_other_client, v_other_shipment, 'delivery', 1);

  INSERT INTO public.scan_events (
    id,
    organization_id,
    actor_user_id,
    route_run_id,
    route_stop_id,
    branch_id,
    client_id,
    shipment_id,
    scan_type,
    barcode,
    captured_at
  )
  VALUES
    (gen_random_uuid(), v_org, v_scan_actor, v_route_one, v_stop_one, v_branch, v_client, v_shipment_one, 'load', 'TRG-LOAD-1', now()),
    (gen_random_uuid(), v_org, v_scan_actor, v_route_two, v_stop_two, v_branch, v_client, v_shipment_two, 'load', 'TRG-LOAD-2', now()),
    (gen_random_uuid(), v_other_org, NULL, v_other_route, v_other_stop, v_other_branch, v_other_client, v_other_shipment, 'load', 'TRG-LOAD-OTHER', now()),
    (gen_random_uuid(), v_org, v_driver_one, v_route_one, v_stop_one, v_branch, v_client, v_shipment_one, 'pickup', 'TRG-PICKUP-1', now() + INTERVAL '1 hour');

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
    (SELECT load_scan_count FROM public.route_stop_load_scan_summary_v1(v_stop_one)),
    1,
    'assigned driver reads the authorized load-scan count'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.route_stop_load_scan_summary_v1(v_stop_two)),
    0,
    'summary hides another driver route'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.route_stop_load_scan_summary_v1(v_other_stop)),
    0,
    'summary hides another tenant route'
  );
  RETURN NEXT is(
    (SELECT last_load_scanned_at FROM public.route_stop_load_scan_summary_v1(v_stop_one)),
    now(),
    'caller-owned non-load scan does not affect the summary timestamp'
  );
  RETURN NEXT is(
    (SELECT COALESCE(load_scan_count, -1)::int FROM api.route_stops WHERE id = v_stop_one),
    1,
    'driver api.route_stops resolves the scoped load-scan aggregate'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_stops WHERE id = v_stop_two),
    0,
    'driver api.route_stops still hides another driver route stop'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_stops WHERE id = v_other_stop),
    0,
    'driver api.route_stops still hides another tenant route stop'
  );

  RETURN NEXT ok(
    (SELECT load_scan_count = 0 AND last_load_scanned_at IS NULL
     FROM public.route_stop_load_scan_summary_v1(v_empty_stop)),
    'authorized stop without load scans returns zero and null'
  );
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
      WHERE r.ev_class = 'public.route_stops_visible_v1'::regclass
        AND d.refobjid = 'public.scan_events'::regclass
    ),
    'invoker view has no direct raw telemetry dependency'
  );

  RETURN NEXT throws_ok(
    'SELECT COUNT(*) FROM public.scan_events', '42501', 'permission denied for table scan_events',
    'authenticated cannot read raw scans, including its own non-load event'
  );

  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_readonly, 'organization_id', v_org, 'access_scope_type', 'tenant'
  )::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_readonly::text, true);
  RETURN NEXT ok(
    public.user_has_resource_capability_v1('shipments', 'read', 'tenant', v_org)
      AND NOT public.user_has_resource_capability_v1('shipments', 'write', 'tenant', v_org)
      AND NOT public.user_has_resource_capability_v1('routes', 'read', 'tenant', v_org)
      AND NOT public.user_has_resource_capability_v1('routes', 'write', 'tenant', v_org),
    'negative fixture has no route capability'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.route_stop_load_scan_summary_v1(v_stop_one)), 0,
    'caller without route capability receives no summary row'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM api.route_stops WHERE id = v_stop_one), 0,
    'caller without route capability cannot read the route-stop projection'
  );

  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_platform, 'organization_id', v_org, 'access_scope_type', 'platform'
  )::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_platform::text, true);
  RETURN NEXT is(
    (SELECT load_scan_count FROM public.route_stop_load_scan_summary_v1(v_other_stop)), 1,
    'platform reader receives the real load count from another organization'
  );
  RETURN NEXT is(
    (SELECT load_scan_count::int FROM api.route_stops WHERE id = v_other_stop), 1,
    'platform route-stop projection retains cross-organization scan progress'
  );

  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  EXECUTE 'SET LOCAL ROLE anon';
  RETURN NEXT throws_ok(
    format('SELECT * FROM public.route_stop_load_scan_summary_v1(%L::uuid)', v_stop_one),
    '42501', NULL::text, 'anonymous summary query is denied'
  );
  RETURN NEXT throws_ok(
    'SELECT * FROM api.route_stops LIMIT 1', '42501', NULL::text,
    'anonymous route-stop query is denied'
  );

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(
    'SELECT * FROM public.route_stops_visible_v1 LIMIT 1', '42501', NULL::text,
    'service role cannot read the authenticated-only route-stop projection'
  );
  RETURN NEXT throws_ok(
    'SELECT * FROM api.route_stops LIMIT 1', '42501', NULL::text,
    'service role cannot read the authenticated-only route-stop API view'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_route_load_scan_visibility_v1();

SELECT * FROM finish();

ROLLBACK;

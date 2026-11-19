-- pgTAP: Console V2 dispatch departure confirmation denies lower-permission
-- route users before mutating route departure status or metadata.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_dispatch_departure_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_owner UUID := gen_random_uuid();
  v_assignment UUID := gen_random_uuid();
  v_route RECORD;
  v_stop_one UUID := NULL;
  v_stop_two UUID := NULL;
  v_shipment_one UUID := NULL;
  v_shipment_two UUID := NULL;
  v_scan_out JSONB := '{}'::jsonb;
  v_ops_result JSONB := '{}'::jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'confirm_route_run_departure_v1',
    ARRAY['jsonb'],
    'public.confirm_route_run_departure_v1 exists'
  );
  RETURN NEXT has_function(
    'public',
    'ui_confirm_route_run_departure_v1',
    ARRAY['jsonb'],
    'public.ui_confirm_route_run_departure_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_confirm_route_run_departure_v1',
    ARRAY['jsonb'],
    'api.ui_confirm_route_run_departure_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.ui_confirm_route_run_departure_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute public.ui_confirm_route_run_departure_v1'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.ui_confirm_route_run_departure_v1(jsonb)', 'EXECUTE'),
    'authenticated can execute api.ui_confirm_route_run_departure_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege('authenticated', 'public.confirm_route_run_departure_v1(jsonb)', 'EXECUTE'),
    'authenticated cannot execute canonical confirm_route_run_departure_v1 directly'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Dispatch Departure Denied Org', 'dispatch-departure-denied-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone)
  VALUES (v_branch, v_org, 'ddd-' || lower(left(v_org::text, 6)), 'Dispatch Departure Denied Branch', 'Asia/Riyadh');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Dispatch Departure Denied Client', 'dispatch-departure-denied-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (
      v_ops,
      v_org,
      'dispatch-departure-denied-ops-' || left(v_ops::text, 8) || '@example.com',
      'Dispatch Departure Denied Ops',
      'ops_admin',
      'active',
      'tenant',
      NULL
    ),
    (
      v_driver,
      v_org,
      'dispatch-departure-denied-driver-' || left(v_driver::text, 8) || '@example.com',
      'Dispatch Departure Denied Limited Driver',
      'driver',
      'active',
      'tenant',
      NULL
    ),
    (
      v_owner,
      v_org,
      'dispatch-departure-denied-owner-' || left(v_owner::text, 8) || '@example.com',
      'Dispatch Departure Denied Owner',
      'driver',
      'active',
      'tenant',
      NULL
    );

  INSERT INTO public.shipments (organization_id, client_id, tracking_number, service_type, status)
  VALUES
    (v_org, v_client, 'DDD-' || upper(left(gen_random_uuid()::text, 8)), 'delivery', 'pending'),
    (v_org, v_client, 'DDD-' || upper(left(gen_random_uuid()::text, 8)), 'delivery', 'pending');

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

  UPDATE public.route_runs
     SET driver_user_id = v_owner,
         updated_at = workflow_now()
   WHERE id = v_route.route_run_id;

  INSERT INTO public.route_run_assignments (
    id,
    organization_id,
    route_run_id,
    assignment_status,
    assignment_mode,
    assignment_version,
    driver_user_id,
    assigned_by_user_id,
    assigned_at,
    notes,
    metadata
  )
  VALUES (
    v_assignment,
    v_org,
    v_route.route_run_id,
    'assigned',
    'internal_driver',
    1,
    v_driver,
    v_ops,
    workflow_now(),
    'Seeded read-visible lower-permission assignment for departure denied-state proof',
    jsonb_build_object('source', 'pgtap', 'purpose', 'departure-denied-state')
  );

  SELECT rs.id, rs.shipment_id
    INTO v_stop_one, v_shipment_one
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_route.route_run_id
   ORDER BY rs.sequence_order, rs.created_at, rs.id
   LIMIT 1;

  SELECT rs.id, rs.shipment_id
    INTO v_stop_two, v_shipment_two
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_route.route_run_id
     AND rs.id <> v_stop_one
   ORDER BY rs.sequence_order, rs.created_at, rs.id
   LIMIT 1;

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
    (gen_random_uuid(), v_org, v_driver, v_route.route_run_id, v_stop_one, v_branch, v_client, v_shipment_one, 'load', 'DDD-LOAD-001', now()),
    (gen_random_uuid(), v_org, v_driver, v_route.route_run_id, v_stop_two, v_branch, v_client, v_shipment_two, 'load', 'DDD-LOAD-002', now());

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(
    public.user_has_resource_capability_v1('routes', 'read', 'tenant', v_org),
    'limited route user has tenant routes.read'
  );
  RETURN NEXT ok(
    NOT public.user_has_resource_capability_v1('routes', 'write', 'tenant', v_org),
    'limited route user lacks tenant routes.write'
  );
  RETURN NEXT ok(
    public.user_has_capability_v1('tasks.complete', 'tenant', v_org),
    'limited route user has tenant tasks.complete but still lacks route write authority'
  );

  v_scan_out := api.route_run_scan_out_reconciliation_v1(v_route.route_run_id);
  RETURN NEXT ok(
    COALESCE((v_scan_out->>'ready_for_departure')::BOOLEAN, FALSE)
      AND COALESCE((v_scan_out->>'missing_stop_count')::INT, -1) = 0
      AND COALESCE((v_scan_out->>'unexpected_scan_count')::INT, -1) = 0,
    'limited route user can still run read-scoped scan-out reconciliation'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.ui_confirm_route_run_departure_v1(jsonb_build_object('route_run_id', %L)) $q$,
      v_route.route_run_id::text
    ),
    '42501',
    NULL,
    'limited route user denied public departure confirmation'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.ui_confirm_route_run_departure_v1(jsonb_build_object('route_run_id', %L)) $q$,
      v_route.route_run_id::text
    ),
    '42501',
    NULL,
    'limited route user denied api departure confirmation'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT status FROM public.route_runs WHERE id = v_route.route_run_id),
    'planned',
    'denied departure confirmation leaves route_run status unchanged'
  );
  RETURN NEXT is(
    COALESCE((SELECT metadata->'route_departure'->>'confirmed_at' FROM public.route_runs WHERE id = v_route.route_run_id), ''),
    '',
    'denied departure confirmation writes no route_departure confirmation'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ops::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(
    public.user_has_resource_capability_v1('routes', 'write', 'tenant', v_org),
    'ops dispatch user has tenant routes.write'
  );
  RETURN NEXT ok(
    public.user_has_capability_v1('tasks.complete', 'tenant', v_org),
    'ops dispatch user has tenant tasks.complete'
  );

  v_ops_result := api.ui_confirm_route_run_departure_v1(
    jsonb_build_object('route_run_id', v_route.route_run_id)
  );

  RETURN NEXT is(v_ops_result->>'status', 'in_progress', 'ops user confirms departure through api wrapper');
  RETURN NEXT ok(
    NULLIF(v_ops_result#>>'{route_departure,confirmed_at}', '') IS NOT NULL,
    'ops departure result returns route_departure confirmation timestamp'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT status FROM public.route_runs WHERE id = v_route.route_run_id),
    'in_progress',
    'ops departure confirmation updates route_run status'
  );
  RETURN NEXT is(
    (SELECT metadata->'route_departure'->>'confirmed_by_user_id' FROM public.route_runs WHERE id = v_route.route_run_id),
    v_ops::text,
    'ops departure confirmation records confirming user in route metadata'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_dispatch_departure_write_denied_state_v1();

SELECT * FROM finish();

ROLLBACK;

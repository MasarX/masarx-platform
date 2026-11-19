-- pgTAP: Console V2 pickup wave create/assign denies lower-permission users
-- before route, stop, shipment, or shipment-action side effects.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(27);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_pickup_wave_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_limited UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_create_shipment UUID := gen_random_uuid();
  v_assign_shipment UUID := gen_random_uuid();
  v_route_run UUID := gen_random_uuid();
  v_route_stop UUID := gen_random_uuid();
  v_route_runs_before INT := 0;
  v_route_stops_before INT := 0;
  v_actions_before INT := 0;
  v_assign_result JSONB := '{}'::jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function('public', 'create_pickup_wave_v1', ARRAY['jsonb'], 'public.create_pickup_wave_v1 exists');
  RETURN NEXT has_function('api', 'create_pickup_wave_v1', ARRAY['jsonb'], 'api.create_pickup_wave_v1 exists');
  RETURN NEXT has_function('public', 'assign_pickup_wave_v1', ARRAY['jsonb'], 'public.assign_pickup_wave_v1 exists');
  RETURN NEXT has_function('api', 'assign_pickup_wave_v1', ARRAY['jsonb'], 'api.assign_pickup_wave_v1 exists');

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Pickup Wave Denied Org', 'pickup-wave-denied-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, branch_type, is_active)
  VALUES (v_branch, v_org, 'pwd-' || lower(left(v_org::text, 6)), 'Pickup Wave Denied Branch', 'Asia/Riyadh', 'warehouse', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'pickup-wave-denied-ops-' || left(v_ops::text, 8) || '@example.com', 'Pickup Wave Denied Ops', 'ops_admin', 'active', 'tenant', NULL),
    (v_limited, v_org, 'pickup-wave-denied-limited-' || left(v_limited::text, 8) || '@example.com', 'Pickup Wave Denied Limited', 'client_admin', 'active', 'tenant', NULL),
    (v_driver, v_org, 'pickup-wave-denied-driver-' || left(v_driver::text, 8) || '@example.com', 'Pickup Wave Denied Driver', 'driver', 'active', 'tenant', NULL);

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_ops);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_ops, r.id, v_ops, jsonb_build_object('source', 'pgtap', 'template_key', r.key)
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Pickup Wave Denied Client', 'pickup-wave-denied-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Pickup Wave Denied Sender', 'Pickup Wave Denied Sender', TRUE, 'active');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status, box_count)
  VALUES
    (v_create_shipment, v_org, v_client, v_sender, 'pickup', 'PWD-CREATE-' || upper(left(v_create_shipment::text, 8)), 'pickup_requested', 2),
    (v_assign_shipment, v_org, v_client, v_sender, 'pickup', 'PWD-ASSIGN-' || upper(left(v_assign_shipment::text, 8)), 'pickup_scheduled', 3);

  INSERT INTO public.route_runs (id, organization_id, branch_id, status, metadata)
  VALUES (
    v_route_run,
    v_org,
    v_branch,
    'planned',
    jsonb_build_object(
      'pickup_wave',
      jsonb_build_object(
        'wave_kind', 'pickup',
        'shipment_ids', jsonb_build_array(v_assign_shipment),
        'shipment_count', 1,
        'idempotency_key', 'pgtap-pickup-wave-denied-existing'
      )
    )
  );

  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order)
  VALUES (v_route_stop, v_org, v_route_run, v_client, v_assign_shipment, 'pickup', 1);

  SELECT COUNT(*)::INT INTO v_route_runs_before FROM public.route_runs WHERE organization_id = v_org;
  SELECT COUNT(*)::INT INTO v_route_stops_before FROM public.route_stops WHERE organization_id = v_org;
  SELECT COUNT(*)::INT INTO v_actions_before FROM public.shipment_actions WHERE organization_id = v_org;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_limited::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(NOT public.user_has_permission_v1('fleet.write', v_org), 'limited pickup user lacks fleet.write permission');
  RETURN NEXT throws_ok(
    format($q$ SELECT public.create_pickup_wave_v1(jsonb_build_object('organization_id', %L::uuid, 'shipment_ids', jsonb_build_array(%L::uuid), 'idempotency_key', 'pgtap-pickup-wave-denied-public-create')) $q$, v_org::text, v_create_shipment::text),
    '42501',
    NULL,
    'limited user denied public pickup wave creation'
  );
  RETURN NEXT throws_ok(
    format($q$ SELECT api.create_pickup_wave_v1(jsonb_build_object('organization_id', %L::uuid, 'shipment_ids', jsonb_build_array(%L::uuid), 'idempotency_key', 'pgtap-pickup-wave-denied-api-create')) $q$, v_org::text, v_create_shipment::text),
    '42501',
    NULL,
    'limited user denied api pickup wave creation'
  );
  RETURN NEXT throws_ok(
    format($q$ SELECT public.assign_pickup_wave_v1(jsonb_build_object('organization_id', %L::uuid, 'route_run_id', %L::uuid, 'driver_user_id', %L::uuid, 'idempotency_key', 'pgtap-pickup-wave-denied-public-assign')) $q$, v_org::text, v_route_run::text, v_driver::text),
    '42501',
    NULL,
    'limited user denied public pickup wave assignment'
  );
  RETURN NEXT throws_ok(
    format($q$ SELECT api.assign_pickup_wave_v1(jsonb_build_object('organization_id', %L::uuid, 'route_run_id', %L::uuid, 'driver_user_id', %L::uuid, 'idempotency_key', 'pgtap-pickup-wave-denied-api-assign')) $q$, v_org::text, v_route_run::text, v_driver::text),
    '42501',
    NULL,
    'limited user denied api pickup wave assignment'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_runs WHERE organization_id = v_org), v_route_runs_before, 'denied pickup wave create/assign writes no extra route_runs');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_stops WHERE organization_id = v_org), v_route_stops_before, 'denied pickup wave create/assign writes no extra route_stops');
  RETURN NEXT is((SELECT status FROM public.shipments WHERE id = v_create_shipment), 'pickup_requested', 'denied pickup wave creation leaves request shipment status unchanged');
  RETURN NEXT is((SELECT status FROM public.shipments WHERE id = v_assign_shipment), 'pickup_scheduled', 'denied pickup wave assignment leaves wave shipment status unchanged');
  RETURN NEXT is((SELECT driver_user_id::TEXT FROM public.route_runs WHERE id = v_route_run), NULL, 'denied pickup wave assignment leaves route driver unassigned');
  RETURN NEXT is(COALESCE((SELECT metadata->'pickup_assignment'->>'assigned_at' FROM public.route_runs WHERE id = v_route_run), ''), '', 'denied pickup wave assignment writes no route assignment metadata');
  RETURN NEXT is((SELECT driver_user_id::TEXT FROM public.shipments WHERE id = v_assign_shipment), NULL, 'denied pickup wave assignment leaves shipment driver unassigned');
  RETURN NEXT is(COALESCE((SELECT metadata->'pickup_assignment'->>'route_run_id' FROM public.shipments WHERE id = v_assign_shipment), ''), '', 'denied pickup wave assignment writes no shipment assignment metadata');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.shipment_actions WHERE organization_id = v_org), v_actions_before, 'denied pickup wave actions write no shipment_actions');

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ops::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(public.user_has_permission_v1('fleet.write', v_org), 'ops pickup user has fleet.write permission');

  v_assign_result := api.assign_pickup_wave_v1(
    jsonb_build_object(
      'organization_id', v_org,
      'route_run_id', v_route_run,
      'driver_user_id', v_driver,
      'idempotency_key', 'pgtap-pickup-wave-ops-assign'
    )
  );

  RETURN NEXT is(v_assign_result->>'route_run_id', v_route_run::text, 'ops user assigns pickup wave through api wrapper');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT driver_user_id::TEXT FROM public.route_runs WHERE id = v_route_run), v_driver::text, 'allowed pickup wave assignment updates route driver');
  RETURN NEXT is((SELECT driver_user_id::TEXT FROM public.shipments WHERE id = v_assign_shipment), v_driver::text, 'allowed pickup wave assignment updates shipment driver');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.shipment_actions WHERE organization_id = v_org AND shipment_id = v_assign_shipment AND action_type = 'pickup_wave_assign'), 1, 'allowed pickup wave assignment writes one shipment action');
  RETURN NEXT is((SELECT driver_user_id::TEXT FROM public.route_run_assignments WHERE route_run_id = v_route_run), v_driver::text, 'allowed pickup wave assignment writes canonical route_run_assignments driver');
  RETURN NEXT is((SELECT assignment_mode FROM public.route_run_assignments WHERE route_run_id = v_route_run), 'internal_driver', 'allowed pickup wave assignment records internal driver assignment mode');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.route_run_assignment_events WHERE route_run_id = v_route_run AND event_type = 'assigned'), 1, 'allowed pickup wave assignment writes assignment event ledger');
  RETURN NEXT is((SELECT assigned_to::TEXT FROM public.tasks WHERE task_type_key = 'route_stop_execute' AND resource_type = 'route_stop' AND resource_id = v_route_stop ORDER BY created_at DESC LIMIT 1), v_driver::text, 'allowed pickup wave assignment syncs route stop execute task owner');

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_pickup_wave_write_denied_state_v1();

SELECT * FROM finish();

ROLLBACK;

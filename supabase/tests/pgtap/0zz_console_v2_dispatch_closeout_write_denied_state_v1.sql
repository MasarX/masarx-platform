-- pgTAP: Console V2 dispatch route-stop closeout denies lower-permission
-- users before task, event, workflow, or shipment-action side effects.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_dispatch_closeout_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_limited UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_task_type_stop UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_created RECORD;
  v_task_created RECORD;
  v_route_run_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
  v_driver_event_id UUID := NULL;
  v_task_events_before INT := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'transition_task_v1',
    ARRAY['uuid','text','text','jsonb','text'],
    'public.transition_task_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'transition_task_v1',
    ARRAY['uuid','text','text','jsonb','text'],
    'api.transition_task_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.transition_task_v1(uuid, text, text, jsonb, text)', 'EXECUTE'),
    'authenticated can execute public.transition_task_v1'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.transition_task_v1(uuid, text, text, jsonb, text)', 'EXECUTE'),
    'authenticated can execute api.transition_task_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Dispatch Closeout Denied Org', 'dispatch-closeout-denied-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'dcd-' || lower(left(v_org::text, 6)), 'Dispatch Closeout Denied Branch', 'Asia/Riyadh', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (
      v_driver,
      v_org,
      'dispatch-closeout-denied-driver-' || left(v_driver::text, 8) || '@example.com',
      'Dispatch Closeout Denied Driver',
      'driver',
      'active',
      'tenant',
      NULL
    ),
    (
      v_limited,
      v_org,
      'dispatch-closeout-denied-limited-' || left(v_limited::text, 8) || '@example.com',
      'Dispatch Closeout Denied Limited',
      'client_admin',
      'active',
      'tenant',
      NULL
    );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Dispatch Closeout Denied Client', 'dispatch-closeout-denied-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Dispatch Closeout Denied Sender', 'Dispatch Closeout Denied Sender', TRUE, 'active');

  INSERT INTO public.vehicles (id, organization_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_org, 'DCD-' || upper(left(v_vehicle::text, 6)), 'active', TRUE);

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type_stop, v_org, 'route_stop_execute', 'Route Stop Execute', TRUE, 50, 'default');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'DCD-' || upper(left(v_shipment::text, 8)), 'out_for_delivery');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'dispatch-closeout-denied-route',
        'stops', jsonb_build_array(
          jsonb_build_object(
            'client_id', v_client,
            'shipment_id', v_shipment,
            'stop_kind', 'delivery',
            'sequence_order', 1
          )
        )
      )
    )
   LIMIT 1;

  v_route_run_id := v_created.route_run_id;
  v_route_stop_id := (v_created.stop_ids)[1];

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'dispatch-closeout-denied-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id := v_task_created.task_id;

  RETURN NEXT ok(v_route_run_id IS NOT NULL, 'route_run fixture created');
  RETURN NEXT ok(v_route_stop_id IS NOT NULL, 'route_stop fixture created');
  RETURN NEXT ok(v_task_id IS NOT NULL, 'route_stop_execute task fixture created');

  SELECT COUNT(*)::INT
    INTO v_task_events_before
    FROM public.task_events
   WHERE task_id = v_task_id;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_limited::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(
    NOT public.user_has_permission_v1('tasks.complete', v_org),
    'limited closeout user lacks tasks.complete permission'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT * FROM public.transition_task_v1(%L::uuid, 'completed', 'delivered', jsonb_build_object('route_stop_completion', jsonb_build_object('completion_kind', 'full'), 'delivery_completion', jsonb_build_object('completion_kind', 'full')), 'dispatch-closeout-denied-public') $q$,
      v_task_id::text
    ),
    '42501',
    NULL,
    'limited user denied public transition_task_v1 closeout'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT * FROM api.transition_task_v1(%L::uuid, 'completed', 'delivered', jsonb_build_object('route_stop_completion', jsonb_build_object('completion_kind', 'full'), 'delivery_completion', jsonb_build_object('completion_kind', 'full')), 'dispatch-closeout-denied-api') $q$,
      v_task_id::text
    ),
    '42501',
    NULL,
    'limited user denied api transition_task_v1 closeout'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT status FROM public.tasks WHERE id = v_task_id),
    'open',
    'denied closeout leaves task status open'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.task_events WHERE task_id = v_task_id),
    v_task_events_before,
    'denied closeout writes no additional task_events'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.domain_events WHERE organization_id = v_org),
    0,
    'denied closeout writes no domain_events'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.shipment_actions WHERE shipment_id = v_shipment),
    0,
    'denied closeout writes no shipment_actions'
  );
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment),
    'out_for_delivery',
    'denied closeout leaves shipment status unchanged'
  );
  RETURN NEXT is(
    COALESCE((SELECT metadata->'route_closeout'->>'completed_stop_count' FROM public.route_runs WHERE id = v_route_run_id), ''),
    '',
    'denied closeout writes no route closeout metadata'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  RETURN NEXT ok(
    public.user_has_permission_v1('tasks.complete', v_org),
    'driver closeout user has tasks.complete permission'
  );

  SELECT task_event_id
    INTO v_driver_event_id
    FROM api.transition_task_v1(
      v_task_id,
      'completed',
      'delivered',
      jsonb_build_object(
        'route_stop_completion', jsonb_build_object('completion_kind', 'full'),
        'delivery_completion', jsonb_build_object('completion_kind', 'full')
      ),
      'dispatch-closeout-driver-api'
    )
   LIMIT 1;

  RETURN NEXT ok(v_driver_event_id IS NOT NULL, 'driver can close route-stop task through api wrapper');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT status FROM public.tasks WHERE id = v_task_id),
    'completed',
    'driver closeout updates task status'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.task_events WHERE task_id = v_task_id),
    v_task_events_before + 1,
    'driver closeout writes one additional task_event'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.domain_events de
       WHERE de.organization_id = v_org
         AND de.event_type = 'task.completed.route_stop_execute'
         AND de.payload->>'task_event_id' = v_driver_event_id::text
    ),
    'driver closeout enqueues route-stop completion domain_event'
  );
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment),
    'out_for_delivery',
    'task transition alone does not fabricate shipment completion before finalize workflow'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_dispatch_closeout_write_denied_state_v1();

SELECT * FROM finish();

ROLLBACK;

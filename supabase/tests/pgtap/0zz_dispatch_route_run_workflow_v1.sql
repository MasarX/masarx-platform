-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Dispatch route run workflow v1 (route_run_create + task_enqueue_many)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

CREATE OR REPLACE FUNCTION pg_temp.test_dispatch_route_run_workflow_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_template_id UUID;

  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();

  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();

  v_vehicle UUID := gen_random_uuid();

  v_task_type UUID := gen_random_uuid();

  v_shipment1 UUID := gen_random_uuid();
  v_shipment2 UUID := gen_random_uuid();

  v_run UUID;
  v_progress JSONB;
  v_run_status TEXT;
  v_iter INT;

  v_route_run_id UUID;
  v_stop_count INT;
  v_task_count INT;

  v_idem_key TEXT := 'pgtap-dispatch-idem-1';
  v_created1 RECORD;
  v_created2 RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'route_run_create' AND is_active IS TRUE),
    'handler registered: route_run_create'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'task_enqueue_many' AND is_active IS TRUE),
    'handler registered: task_enqueue_many'
  );

  RETURN NEXT has_function('public', 'create_route_run_v1', ARRAY['jsonb'], 'service RPC exists: create_route_run_v1(jsonb)');
  RETURN NEXT has_column('public', 'route_runs', 'idempotency_key', 'route_runs has idempotency_key');
  RETURN NEXT has_column('public', 'route_runs', 'idempotency_hash', 'route_runs has idempotency_hash');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'route_runs'
        AND indexname = 'idx_route_runs_org_idempotency'
    ),
    'route_runs has idx_route_runs_org_idempotency'
  );

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_run_v1'
   LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: dispatch_route_run_v1');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    2,
    'dispatch_route_run_v1 has 2 steps'
  );
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1), 'route_run_create', 'step 1 handler_key = route_run_create');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 2), 'task_enqueue_many', 'step 2 handler_key = task_enqueue_many');

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Dispatch Workflow Org', 'dispatch-wf-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'br-' || left(v_branch::text, 8), 'Branch ' || left(v_branch::text, 8), 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'Driver ' || left(v_driver::text, 8), 'tenant');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Dispatch Client', 'dispatch-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Dispatch Sender', 'Dispatch Sender', TRUE, 'active');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type, v_org, 'route_stop_execute', 'Route Stop Execute', TRUE, 50, 'default');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_shipment1, v_org, v_client, v_sender, 'delivery', 'pgtap-dispatch-' || left(v_shipment1::text, 8), 'created'),
    (v_shipment2, v_org, v_client, v_sender, 'delivery', 'pgtap-dispatch-' || left(v_shipment2::text, 8), 'created');

  -- Idempotency semantics for create_route_run_v1 (service-only).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_created1
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', v_idem_key,
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
        )
      )
    )
    LIMIT 1;

  SELECT *
    INTO v_created2
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', v_idem_key,
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
        )
      )
    )
    LIMIT 1;

  RETURN NEXT is(v_created1.created, TRUE, 'create_route_run_v1 first call created=true');
  RETURN NEXT is(v_created2.created, FALSE, 'create_route_run_v1 second call created=false (idempotent)');
  RETURN NEXT is(v_created1.route_run_id::text, v_created2.route_run_id::text, 'create_route_run_v1 idempotency returns same route_run_id');

  -- End-to-end workflow execution: route_run_create + task_enqueue_many.
  v_run := public.start_workflow_run(
    v_template_id,
    jsonb_build_object(
      'organization_id', v_org,
      'branch_id', v_branch,
      'driver_user_id', v_driver,
      'vehicle_id', v_vehicle,
      'stops', jsonb_build_array(
        jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment1, 'stop_kind', 'delivery', 'sequence_order', 1),
        jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 2)
      )
    )
  );

  v_progress := public.progress_workflow_run(v_run);
  FOR v_iter IN 1..10 LOOP
    SELECT workflow_status INTO v_run_status
    FROM public.workflow_runs
    WHERE id = v_run;

    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    v_progress := public.progress_workflow_run(v_run);
  END LOOP;

  RETURN NEXT is(COALESCE(v_run_status, ''), 'completed', 'dispatch_route_run_v1 workflow run finalizes');

  SELECT (context->'dispatch'->>'route_run_id')::uuid
    INTO v_route_run_id
    FROM public.workflow_runs
   WHERE id = v_run;

  RETURN NEXT ok(v_route_run_id IS NOT NULL, 'workflow context includes dispatch.route_run_id');

  SELECT COUNT(*)::int
    INTO v_stop_count
    FROM public.route_stops
   WHERE route_run_id = v_route_run_id;

  RETURN NEXT is(v_stop_count, 2, 'route_stops created for route_run (2 stops)');

  SELECT COUNT(*)::int
    INTO v_task_count
    FROM public.tasks
   WHERE organization_id = v_org
     AND resource_type = 'route_stop'
     AND resource_id IN (SELECT id FROM public.route_stops WHERE route_run_id = v_route_run_id);

  RETURN NEXT is(v_task_count, 2, 'tasks created for route_stop resources (2 tasks)');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_dispatch_route_run_workflow_v1();

SELECT * FROM finish();

ROLLBACK;

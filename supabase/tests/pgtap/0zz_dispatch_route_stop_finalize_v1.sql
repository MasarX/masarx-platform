-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Dispatch route stop finalize v1 (task completion -> domain_event -> workflow -> shipment_actions)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(70);

CREATE OR REPLACE FUNCTION pg_temp.test_dispatch_route_stop_finalize_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_template_id UUID;

  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_ops_owner UUID := gen_random_uuid();

  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();

  v_vehicle UUID := gen_random_uuid();

  v_task_type_stop UUID := gen_random_uuid();
  v_task_type_noop UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_shipment2 UUID := gen_random_uuid();
  v_shipment3 UUID := gen_random_uuid();
  v_shipment4 UUID := gen_random_uuid();

  v_created RECORD;
  v_route_run_id UUID;
  v_route_stop_id UUID;

  v_task_created RECORD;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_console_closeout_readback RECORD;

  v_domain_event_id UUID;
  v_domain_event_run_id UUID;
  v_run_status TEXT;
  v_iter INT;
  v_step_error TEXT;

  v_actions_count INT;

  v_artifact_id UUID;
  v_shipment_action_id UUID;
  v_actions_count2 INT;
  v_shipment_action_id2 UUID;
  v_task_id2 UUID;
  v_task_done_event_id2 UUID;
  v_domain_event_id2 UUID;
  v_domain_event_run_id2 UUID;
  v_run_status2 TEXT;
  v_followup_tasks_count INT;
  v_task_id3 UUID;
  v_task_done_event_id3 UUID;
  v_domain_event_id3 UUID;
  v_domain_event_run_id3 UUID;
  v_run_status3 TEXT;
  v_followup_tasks_count3 INT;
  v_task_id4 UUID;
  v_task_done_event_id4 UUID;
  v_domain_event_id4 UUID;
  v_domain_event_run_id4 UUID;
  v_run_status4 TEXT;
  v_actions_count4 INT;
  v_shipment_action_id4 UUID;
  v_followup_tasks_count4 INT;
  v_cod_payment_collection JSONB := jsonb_build_object(
    'outcome', 'collected',
    'method', 'cash',
    'expected_amount', 580,
    'collected_amount', 580,
    'variance_amount', 0,
    'has_discrepancy', FALSE,
    'discrepancy_kind', 'matched',
    'currency', 'SAR',
    'receipt_context', 'cashier-count-77'
  );

  v_noop_task_created RECORD;
  v_noop_task_id UUID;
  v_noop_done_event UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_trigger('public', 'task_events', 'trg_task_events_completed_domain_event', 'task_events completion trigger exists');
  RETURN NEXT has_function('public', 'domain_event_from_task_event_completed_v1', ARRAY[]::text[], 'task completion trigger fn exists');
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'route_stop_finalize' AND is_active IS TRUE),
    'handler registered: route_stop_finalize'
  );

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_stop_finalize_v1'
   LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: dispatch_route_stop_finalize_v1');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    1,
    'dispatch_route_stop_finalize_v1 has 1 step'
  );
  RETURN NEXT is(
    (SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1),
    'route_stop_finalize',
    'step 1 handler_key = route_stop_finalize'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.route_stop_execute')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.route_stop_execute -> dispatch_route_stop_finalize_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Dispatch Stop Finalize Org', 'dispatch-stop-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'br-' || left(v_branch::text, 8), 'Branch ' || left(v_branch::text, 8), 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_driver,
    v_org,
    'driver-' || left(v_driver::text, 8) || '@example.com',
    'Driver ' || left(v_driver::text, 8),
    'driver',
    'tenant'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_ops_owner,
    v_org,
    'ops-owner-' || left(v_ops_owner::text, 8) || '@example.com',
    'Ops Owner ' || left(v_ops_owner::text, 8),
    'ops_admin',
    'tenant'
  );

  -- RBAC: task mutation RPCs are permission-gated; grant driver permissions for the actor user.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Dispatch Client', 'dispatch-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Dispatch Sender', 'Dispatch Sender', TRUE, 'active');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES
    (v_task_type_stop, v_org, 'route_stop_execute', 'Route Stop Execute', TRUE, 50, 'default'),
    (v_task_type_noop, v_org, 'noop_task', 'Noop Task', TRUE, 50, 'default');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status, cod_amount, cod_currency)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'PGTAPSTOP' || upper(left(v_shipment::text, 8)), 'out_for_delivery', 580, 'SAR');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment2, v_org, v_client, v_sender, 'delivery', 'PGTAPSTOP2' || upper(left(v_shipment2::text, 8)), 'out_for_delivery');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment3, v_org, v_client, v_sender, 'delivery', 'PGTAPSTOP3' || upper(left(v_shipment3::text, 8)), 'out_for_delivery');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment4, v_org, v_client, v_sender, 'delivery', 'PGTAPSTOP4' || upper(left(v_shipment4::text, 8)), 'out_for_delivery');

  -- Register an evidence artifact (service-only) and attach it to the stop completion payload via policy-driven jsonpath.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT artifact_id
    INTO v_artifact_id
    FROM public.register_artifact_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'storage_bucket', 'evidence',
        'storage_key', 'pgtap/dispatch/pod-sig.png',
        'mime_type', 'image/png',
        'size_bytes', 1234,
        'sha256', repeat('a', 64),
        'source_system', 'pgtap',
        'metadata', jsonb_build_object('artifact_kind', 'photo')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_artifact_id IS NOT NULL, 'register_artifact_v1 returns artifact_id');

  -- Create route_run + route_stop via canonical service RPC.
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
        'idempotency_key', 'pgtap-stop-finalize-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;

  v_route_run_id := v_created.route_run_id;
  v_route_stop_id := (v_created.stop_ids)[1];

  RETURN NEXT ok(v_route_stop_id IS NOT NULL, 'create_route_run_v1 returns stop_id');

  -- Create stop task as system.
  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-stop-finalize-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id := v_task_created.task_id;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'create_task_system_v1 creates route_stop task');

  -- Complete task as authenticated driver (creates task_events row, triggers domain_event enqueue).
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'delivered',
      p_payload := jsonb_build_object(
        'handover_mode', 'mailroom',
        'recipient_name', 'Faisal QA',
        'recipient_class', 'mailroom',
        'completion_notes', 'Handoff confirmed at building mailroom',
        'artifact_ids', jsonb_build_array(v_artifact_id),
        'payment_collection', v_cod_payment_collection,
        'delivery_completion', jsonb_build_object(
          'completion_kind', 'full',
          'payment_collection', v_cod_payment_collection
        ),
        'pod', jsonb_build_object(
          'signature_ref', 'storage://pgtap/sig.png',
          'handover_mode', 'mailroom',
          'recipient_name', 'Faisal QA',
          'recipient_class', 'mailroom'
        ),
        'scans', jsonb_build_array(jsonb_build_object('code', 'BOX1', 'at', now()))
      ),
      p_idempotency_key := 'pgtap-stop-finalize-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'driver transitions route_stop task to completed');

  SELECT *
    INTO v_console_closeout_readback
    FROM api.ui_finalize_route_stop_closeout_event_v1(v_task_done_event_id)
   LIMIT 1;

  RETURN NEXT is(
    v_console_closeout_readback.workflow_status,
    'completed',
    'Console V2 closeout readback wrapper progresses canonical route-stop workflow'
  );
  RETURN NEXT ok(
    v_console_closeout_readback.shipment_action_id IS NOT NULL,
    'Console V2 closeout readback wrapper returns shipment_action proof'
  );

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_id, v_domain_event_run_id
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_id::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  RETURN NEXT ok(v_domain_event_id IS NOT NULL, 'domain_event enqueued for task.completed.route_stop_execute');

  -- Dispatch domain events into workflow engine.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_domain_event_run_id
      FROM public.domain_events
     WHERE id = v_domain_event_id;
    EXIT WHEN v_domain_event_run_id IS NOT NULL;
  END LOOP;

  RETURN NEXT ok(v_domain_event_run_id IS NOT NULL, 'domain_event dispatched to workflow_run');

  -- Progress workflow run to completion (should execute route_stop_finalize).
  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status FROM public.workflow_runs WHERE id = v_domain_event_run_id;
    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id);
  END LOOP;

  IF v_run_status IS DISTINCT FROM 'completed' THEN
    SELECT COALESCE(last_error, '')::text
      INTO v_step_error
      FROM public.workflow_run_steps
     WHERE workflow_run_id = v_domain_event_run_id
       AND sequence_order = 1
     LIMIT 1;

    RETURN NEXT diag('route_stop_finalize last_error=' || COALESCE(NULLIF(v_step_error, ''), '<empty>'));
  END IF;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(COALESCE(v_run_status, ''), 'completed', 'dispatch_route_stop_finalize_v1 workflow run completes');
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment AND client_id = v_client),
    'delivered',
    'shipment status updated to delivered'
  );

  SELECT COUNT(*)::int
    INTO v_actions_count
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text;

  RETURN NEXT is(v_actions_count, 1, 'shipment_action inserted once (idempotent by task_event_id)');

  SELECT id
    INTO v_shipment_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text
   ORDER BY sa.timestamp DESC
   LIMIT 1;

  RETURN NEXT ok(v_shipment_action_id IS NOT NULL, 'shipment_action id captured for evidence linking');
  RETURN NEXT is(
    (SELECT sa.action_data->'task_event_payload'->>'handover_mode' FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'mailroom',
    'shipment_action preserves task_event_payload.handover_mode'
  );
  RETURN NEXT is(
    (SELECT sa.action_data->'task_event_payload'->>'recipient_class' FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'mailroom',
    'shipment_action preserves task_event_payload.recipient_class'
  );
  RETURN NEXT is(
    (SELECT sa.action_data->'task_event_payload'->>'recipient_name' FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'Faisal QA',
    'shipment_action preserves task_event_payload.recipient_name'
  );
  RETURN NEXT is(
    (SELECT sa.action_data->'task_event_payload'->'pod'->>'handover_mode' FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'mailroom',
    'shipment_action preserves POD handover_mode'
  );
  RETURN NEXT is(
    (SELECT sa.action_data->'task_event_payload'->'pod'->>'recipient_name' FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'Faisal QA',
    'shipment_action preserves POD recipient_name'
  );

  RETURN NEXT is(
    (SELECT sa.handover_mode FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'mailroom',
    'shipment_action projects handover_mode for UI reads'
  );

  RETURN NEXT is(
    (SELECT sa.recipient_class FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'mailroom',
    'shipment_action projects recipient_class for UI reads'
  );

  RETURN NEXT is(
    (SELECT sa.recipient_name FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'Faisal QA',
    'shipment_action projects recipient_name for UI reads'
  );

  RETURN NEXT is(
    (SELECT sa.completion_notes FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'Handoff confirmed at building mailroom',
    'shipment_action projects completion_notes for UI reads'
  );
  RETURN NEXT is(
    (SELECT sa.action_data #>> '{task_event_payload,delivery_completion,payment_collection,outcome}' FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'collected',
    'shipment_action preserves delivery_completion payment collection outcome'
  );
  RETURN NEXT is(
    (SELECT sa.payment_collection_outcome FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'collected',
    'shipment_action projects COD collection outcome for UI reads'
  );
  RETURN NEXT is(
    (SELECT sa.payment_collection_method FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'cash',
    'shipment_action projects COD payment method for UI reads'
  );
  RETURN NEXT ok(
    (SELECT sa.payment_expected_amount = 580::numeric FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'shipment_action projects COD expected amount for UI reads'
  );
  RETURN NEXT ok(
    (SELECT sa.payment_collected_amount = 580::numeric FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'shipment_action projects COD collected amount for UI reads'
  );
  RETURN NEXT ok(
    (SELECT sa.payment_variance_amount = 0::numeric FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'shipment_action projects COD variance amount for UI reads'
  );
  RETURN NEXT ok(
    (SELECT sa.payment_has_discrepancy IS FALSE FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'shipment_action projects COD discrepancy state for UI reads'
  );
  RETURN NEXT is(
    (SELECT sa.payment_discrepancy_kind FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'matched',
    'shipment_action projects COD discrepancy kind for UI reads'
  );
  RETURN NEXT is(
    (SELECT sa.payment_currency FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'SAR',
    'shipment_action projects COD currency for UI reads'
  );
  RETURN NEXT is(
    (SELECT sa.payment_receipt_context FROM public.shipment_actions sa WHERE sa.id = v_shipment_action_id),
    'cashier-count-77',
    'shipment_action projects COD receipt context for UI reads'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.artifact_links al
     WHERE al.organization_id = v_org
       AND al.artifact_id = v_artifact_id
       AND al.resource_type = 'shipment_action'
       AND al.resource_id = v_shipment_action_id
       AND al.relation_type = 'pod'),
    1,
    'evidence artifact linked to shipment_action via artifact_links'
  );
  RETURN NEXT ok(
    (SELECT delivered_at IS NOT NULL FROM public.shipments WHERE id = v_shipment AND client_id = v_client),
    'shipment.delivered_at recorded for completed delivery'
  );
  RETURN NEXT is(
    (SELECT status FROM public.route_runs WHERE id = v_route_run_id),
    'completed',
    'route run status updated to completed'
  );
  RETURN NEXT ok(
    (SELECT ended_at IS NOT NULL FROM public.route_runs WHERE id = v_route_run_id),
    'route run ended_at recorded'
  );
  RETURN NEXT is(
    COALESCE((SELECT (metadata->'route_closeout'->>'completed_stop_count')::int FROM public.route_runs WHERE id = v_route_run_id), 0),
    1,
    'route_closeout completed_stop_count recorded'
  );
  RETURN NEXT is(
    COALESCE((SELECT (metadata->'route_closeout'->>'remaining_stop_count')::int FROM public.route_runs WHERE id = v_route_run_id), -1),
    0,
    'route_closeout remaining_stop_count recorded'
  );

  -- Policy gate: a different task type should NOT enqueue domain_event (no workflow_template_id configured).
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT *
    INTO v_noop_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'noop_task',
        'context', jsonb_build_object('organization_id', v_org),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-noop-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;
  v_noop_task_id := v_noop_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_noop_done_event
    FROM public.transition_task_v1(
      p_task_id := v_noop_task_id,
      p_to_status := 'completed',
      p_status_reason := 'done',
      p_payload := jsonb_build_object('source', 'pgtap'),
      p_idempotency_key := 'pgtap-noop-done'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.domain_events WHERE organization_id = v_org AND event_type = 'task.completed.noop_task' AND (payload->>'task_event_id') = v_noop_done_event::text),
    0,
    'no domain_event enqueued for task.completed.noop_task (policy-gated)'
  );

  -- Idempotency: enqueue duplicate domain_event for same task_event_id; handler must not double-insert shipment_actions.
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.enqueue_domain_event(
    p_organization_id := v_org,
    p_event_type := 'task.completed.route_stop_execute',
    p_resource_type := 'route_stop',
    p_resource_id := v_route_stop_id,
    p_payload := jsonb_build_object(
      'task_event_id', v_task_done_event_id,
      'task_id', v_task_id,
      'task_type_key', 'route_stop_execute',
      'resource_type', 'route_stop',
      'resource_id', v_route_stop_id,
      'actor_user_id', v_driver,
      'task_event_payload', jsonb_build_object('correlation_id', gen_random_uuid())
    ),
    p_correlation_id := NULL
  );

  UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
  PERFORM public.run_domain_events_worker();

  EXECUTE 'SET LOCAL ROLE postgres';

  -- Ensure still exactly one shipment_action for the original task_event_id.
  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_shipment
       AND sa.organization_id = v_org
       AND sa.client_id = v_client
       AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text),
    1,
    'duplicate domain_event does not create duplicate shipment_action (idempotent by task_event_id)'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.artifact_links al
     WHERE al.organization_id = v_org
       AND al.artifact_id = v_artifact_id
       AND al.resource_type = 'shipment_action'
       AND al.resource_id = v_shipment_action_id
       AND al.relation_type = 'pod'),
    1,
    'duplicate domain_event does not create duplicate artifact_link (idempotent by task_event_id)'
  );

  -- Exception outcome: status_reason=access_restricted should map to delivery_failed + exception action semantics + follow-up task.
  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-stop-finalize-route-run-2',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment2, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;

  v_route_stop_id := (v_created.stop_ids)[1];

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-stop-finalize-task-2',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id2 := v_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id2
    FROM public.transition_task_v1(
      p_task_id := v_task_id2,
      p_to_status := 'completed',
      p_status_reason := 'access_restricted',
      p_payload := jsonb_build_object(
        'source', 'pgtap',
        'completion_notes', 'Security denied access at the gate',
        'geostamp', jsonb_build_object(
          'latitude', 24.7136,
          'longitude', 46.6753,
          'accuracy_m', 8
        )
      ),
      p_idempotency_key := 'pgtap-stop-finalize-done-2'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_id2, v_domain_event_run_id2
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_id2::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_domain_event_run_id2
      FROM public.domain_events
     WHERE id = v_domain_event_id2;
    EXIT WHEN v_domain_event_run_id2 IS NOT NULL;
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';
  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status2 FROM public.workflow_runs WHERE id = v_domain_event_run_id2;
    EXIT WHEN v_run_status2 IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id2);
  END LOOP;

  IF v_run_status2 IS DISTINCT FROM 'completed' THEN
    SELECT COALESCE(last_error, '')::text
      INTO v_step_error
      FROM public.workflow_run_steps
     WHERE workflow_run_id = v_domain_event_run_id2
       AND sequence_order = 1
     LIMIT 1;

    RETURN NEXT diag('route_stop_finalize access_restricted last_error=' || COALESCE(NULLIF(v_step_error, ''), '<empty>'));
  END IF;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(COALESCE(v_run_status2, ''), 'completed', 'dispatch_route_stop_finalize_v1 completes for exception outcome');
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment2 AND client_id = v_client),
    'delivery_failed',
    'shipment status updated to delivery_failed for access_restricted'
  );

  SELECT COUNT(*)::int
    INTO v_actions_count2
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment2
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id2::text;

  RETURN NEXT is(v_actions_count2, 1, 'shipment_action inserted once for exception outcome (idempotent by task_event_id)');

  SELECT id
    INTO v_shipment_action_id2
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment2
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id2::text
   ORDER BY sa.timestamp DESC
   LIMIT 1;

  RETURN NEXT is(
    (SELECT action_category FROM public.shipment_actions WHERE id = v_shipment_action_id2),
    'exception',
    'shipment_action action_category=exception for access_restricted'
  );

  RETURN NEXT is(
    (SELECT action_type FROM public.shipment_actions WHERE id = v_shipment_action_id2),
    'exception',
    'shipment_action action_type=exception for access_restricted'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.decision_log dl
     WHERE dl.organization_id = v_org
       AND dl.resource_type = 'shipment'
       AND dl.resource_id = v_shipment2
       AND dl.decision_point = 'route_stop_followup_task'
       AND dl.decision_outcome = 'exception'
       AND dl.decision_reason ILIKE '%create_task_system_v1 requires service_role context%'),
    0,
    'access_restricted follow-up task creation does not log a service-role context exception'
  );

  SELECT COUNT(*)::int
    INTO v_followup_tasks_count
    FROM public.tasks t
    JOIN public.task_types tt ON tt.id = t.task_type_id
   WHERE t.organization_id = v_org
     AND tt.key = 'dispatch_exception_review'
     AND t.resource_type = 'shipment'
     AND t.resource_id = v_shipment2;

  RETURN NEXT is(v_followup_tasks_count, 1, 'follow-up task created for exception outcome');
  RETURN NEXT is(
    (SELECT assigned_to
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.organization_id = v_org
        AND tt.key = 'dispatch_exception_review'
        AND t.resource_type = 'shipment'
        AND t.resource_id = v_shipment2
      ORDER BY t.created_at DESC
      LIMIT 1),
    v_ops_owner,
    'follow-up task assigned to tenant ops owner'
  );
  RETURN NEXT ok(
    (SELECT assigned_at IS NOT NULL
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.organization_id = v_org
        AND tt.key = 'dispatch_exception_review'
        AND t.resource_type = 'shipment'
        AND t.resource_id = v_shipment2
      ORDER BY t.created_at DESC
      LIMIT 1),
    'follow-up task assigned_at is populated'
  );
  RETURN NEXT is(
    (SELECT queue_key
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.organization_id = v_org
        AND tt.key = 'dispatch_exception_review'
        AND t.resource_type = 'shipment'
        AND t.resource_id = v_shipment2
      ORDER BY t.created_at DESC
      LIMIT 1),
    'dispatch',
    'follow-up task queue_key resolves from task assignment defaults'
  );
  RETURN NEXT is(
    (SELECT sla_minutes
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.organization_id = v_org
        AND tt.key = 'dispatch_exception_review'
        AND t.resource_type = 'shipment'
        AND t.resource_id = v_shipment2
      ORDER BY t.created_at DESC
      LIMIT 1),
    60,
    'follow-up task SLA minutes resolve from task assignment defaults'
  );
  RETURN NEXT is(
    (SELECT COALESCE(t.metadata->'assignment_defaults'->>'queue_key', '')
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.organization_id = v_org
        AND tt.key = 'dispatch_exception_review'
        AND t.resource_type = 'shipment'
        AND t.resource_id = v_shipment2
      ORDER BY t.created_at DESC
      LIMIT 1),
    'dispatch',
    'follow-up task metadata persists assignment_defaults.queue_key'
  );
  RETURN NEXT ok(
    (SELECT t.sla_due_at > t.created_at
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.organization_id = v_org
        AND tt.key = 'dispatch_exception_review'
        AND t.resource_type = 'shipment'
        AND t.resource_id = v_shipment2
      ORDER BY t.created_at DESC
      LIMIT 1),
    'follow-up task SLA due_at is after creation time'
  );

  -- Idempotency: duplicate domain_event does not create duplicate follow-up task.
  EXECUTE 'SET LOCAL ROLE service_role';

  PERFORM public.enqueue_domain_event(
    p_organization_id := v_org,
    p_event_type := 'task.completed.route_stop_execute',
    p_resource_type := 'route_stop',
    p_resource_id := v_route_stop_id,
    p_payload := jsonb_build_object(
      'task_event_id', v_task_done_event_id2,
      'task_id', v_task_id2,
      'task_type_key', 'route_stop_execute',
      'resource_type', 'route_stop',
      'resource_id', v_route_stop_id,
      'actor_user_id', v_driver,
      'task_event_payload', jsonb_build_object('correlation_id', gen_random_uuid())
    ),
    p_correlation_id := NULL
  );

  UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
  PERFORM public.run_domain_events_worker();

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.tasks t
     JOIN public.task_types tt ON tt.id = t.task_type_id
     WHERE t.organization_id = v_org
       AND tt.key = 'dispatch_exception_review'
       AND t.resource_type = 'shipment'
       AND t.resource_id = v_shipment2),
    1,
    'duplicate domain_event does not create duplicate follow-up task (idempotent)'
  );

  -- Outcome: phone_unreachable should use taxonomy defaults (delivery_failed + exception semantics + dispatch_exception_review follow-up).
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-stop-finalize-route-run-4',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment4, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;

  v_route_stop_id := (v_created.stop_ids)[1];

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-stop-finalize-task-4',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id4 := v_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id4
    FROM public.transition_task_v1(
      p_task_id := v_task_id4,
      p_to_status := 'completed',
      p_status_reason := 'phone_unreachable',
      p_payload := jsonb_build_object('source', 'pgtap'),
      p_idempotency_key := 'pgtap-stop-finalize-done-4'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_id4, v_domain_event_run_id4
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_id4::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_domain_event_run_id4
      FROM public.domain_events
     WHERE id = v_domain_event_id4;
    EXIT WHEN v_domain_event_run_id4 IS NOT NULL;
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';
  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status4 FROM public.workflow_runs WHERE id = v_domain_event_run_id4;
    EXIT WHEN v_run_status4 IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id4);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(COALESCE(v_run_status4, ''), 'completed', 'dispatch_route_stop_finalize_v1 completes for phone_unreachable outcome');
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment4 AND client_id = v_client),
    'delivery_failed',
    'shipment status updated to delivery_failed for phone_unreachable'
  );

  SELECT COUNT(*)::int
    INTO v_actions_count4
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment4
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id4::text;

  RETURN NEXT is(v_actions_count4, 1, 'shipment_action inserted once for phone_unreachable outcome');

  SELECT id
    INTO v_shipment_action_id4
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment4
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id4::text
   ORDER BY sa.timestamp DESC
   LIMIT 1;

  RETURN NEXT is(
    (SELECT action_category FROM public.shipment_actions WHERE id = v_shipment_action_id4),
    'exception',
    'shipment_action action_category=exception for phone_unreachable'
  );

  RETURN NEXT is(
    (SELECT action_type FROM public.shipment_actions WHERE id = v_shipment_action_id4),
    'exception',
    'shipment_action action_type=exception for phone_unreachable'
  );

  SELECT COUNT(*)::int
    INTO v_followup_tasks_count4
    FROM public.tasks t
    JOIN public.task_types tt ON tt.id = t.task_type_id
   WHERE t.organization_id = v_org
     AND tt.key = 'dispatch_exception_review'
     AND t.resource_type = 'shipment'
     AND t.resource_id = v_shipment4;

  RETURN NEXT is(v_followup_tasks_count4, 1, 'dispatch_exception_review follow-up task created for phone_unreachable outcome');

  -- Outcome: customer_refused should map to return_to_origin + dispatch_rto_pickup follow-up task (policy-driven).
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-stop-finalize-route-run-3',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment3, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;

  v_route_stop_id := (v_created.stop_ids)[1];

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-stop-finalize-task-3',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id3 := v_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id3
    FROM public.transition_task_v1(
      p_task_id := v_task_id3,
      p_to_status := 'completed',
      p_status_reason := 'customer_refused',
      p_payload := jsonb_build_object('source', 'pgtap'),
      p_idempotency_key := 'pgtap-stop-finalize-done-3'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_id3, v_domain_event_run_id3
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_id3::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_domain_event_run_id3
      FROM public.domain_events
     WHERE id = v_domain_event_id3;
    EXIT WHEN v_domain_event_run_id3 IS NOT NULL;
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';
  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status3 FROM public.workflow_runs WHERE id = v_domain_event_run_id3;
    EXIT WHEN v_run_status3 IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id3);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(COALESCE(v_run_status3, ''), 'completed', 'dispatch_route_stop_finalize_v1 completes for customer_refused outcome');
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment3 AND client_id = v_client),
    'return_to_origin',
    'shipment status updated to return_to_origin for customer_refused'
  );

  SELECT COUNT(*)::int
    INTO v_followup_tasks_count3
    FROM public.tasks t
    JOIN public.task_types tt ON tt.id = t.task_type_id
   WHERE t.organization_id = v_org
     AND tt.key = 'dispatch_rto_pickup'
     AND t.resource_type = 'shipment'
     AND t.resource_id = v_shipment3;

  RETURN NEXT is(v_followup_tasks_count3, 1, 'dispatch_rto_pickup follow-up task created for customer_refused outcome');

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_dispatch_route_stop_finalize_v1();

SELECT * FROM finish();

ROLLBACK;

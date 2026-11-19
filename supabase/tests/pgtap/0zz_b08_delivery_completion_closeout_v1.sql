-- Plan: Batch 8 delivery completion closeout / Step: E04
-- pgTAP: partial delivery can be recorded by delivered_box_numbers and projected onto shipment_actions UI reads

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

CREATE OR REPLACE FUNCTION pg_temp.test_b08_delivery_completion_closeout_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_task_type_stop UUID := gen_random_uuid();

  v_shipment UUID := gen_random_uuid();
  v_route_stop_id UUID;
  v_route_run_id UUID;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_domain_event_id UUID;
  v_workflow_run_id UUID;
  v_run_status TEXT;
  v_action_id UUID;
  v_iter INT;
  v_created RECORD;
  v_task_created RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.operation_handlers
      WHERE handler_key = 'route_stop_finalize'
        AND handler_schema = 'workflow_handlers'
        AND handler_name = format('execute_route_stop_finalize_%s', handler_version)
        AND handler_version ~ '^v[0-9]+$'
        AND regexp_replace(handler_version, '^v', '')::INT >= 9
        AND is_active IS TRUE
    ),
    'route_stop_finalize handler is v9 or newer'
  );
  RETURN NEXT has_view('api', 'shipment_actions', 'api.shipment_actions view exists');
  RETURN NEXT col_type_is('api', 'shipment_actions', 'delivery_completion_kind', 'text', 'api.shipment_actions exposes delivery_completion_kind');
  RETURN NEXT col_type_is('api', 'shipment_actions', 'delivered_box_count', 'integer', 'api.shipment_actions exposes delivered_box_count');
  RETURN NEXT col_type_is('api', 'shipment_actions', 'remaining_box_count', 'integer', 'api.shipment_actions exposes remaining_box_count');

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B08 UC098 Org', 'b08-uc098-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'br-' || left(v_branch::text, 8), 'B08 UC098 Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'B08 Driver', 'tenant');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B08 UC098 Client', 'b08-uc098-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'B08 UC098 Sender', 'B08 UC098 Sender', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:b08-delivery-completion-fixture-bootstrap');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type_stop, v_org, 'route_stop_execute', 'Route Stop Execute', TRUE, 50, 'default');

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    box_count
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'B08UC098' || upper(left(v_shipment::text, 8)),
    'out_for_delivery',
    3
  );

  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.ensure_shipment_boxes(v_shipment, 3);

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b08-uc098-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client, 'shipment_id', v_shipment, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;
  v_route_stop_id := (v_created.stop_ids)[1];
  v_route_run_id := v_created.route_run_id;

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-b08-uc098-task',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;
  v_task_id := v_task_created.task_id;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM public.transition_task_v1(
          p_task_id := '%1$s'::uuid,
          p_to_status := 'completed',
          p_status_reason := 'partial_delivery',
          p_payload := jsonb_build_object(
            'handover_mode', 'mailroom',
            'recipient_name', 'B08 Mailroom',
            'recipient_class', 'mailroom',
            'completion_notes', 'invalid delivered_box_numbers should fail',
            'delivery_completion', jsonb_build_object(
              'completion_kind', 'partial',
              'delivered_box_numbers', jsonb_build_array(1, 'foo')
            ),
            'source', 'pgtap',
            'run', gen_random_uuid()::text
          ),
          p_idempotency_key := 'pgtap-b08-uc098-partial-invalid-box-numbers'
        )
      $sql$,
      v_task_id
    ),
    '23514',
    'route_stop_finalize: delivered_box_numbers must contain positive integers',
    'partial delivery rejects invalid delivered_box_numbers'
  );

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM public.transition_task_v1(
          p_task_id := '%1$s'::uuid,
          p_to_status := 'completed',
          p_status_reason := 'partial_delivery',
          p_payload := jsonb_build_object(
            'handover_mode', 'mailroom',
            'recipient_name', 'B08 Mailroom',
            'recipient_class', 'mailroom',
            'completion_notes', 'out-of-range delivered_box_numbers should fail',
            'delivery_completion', jsonb_build_object(
              'completion_kind', 'partial',
              'delivered_box_numbers', jsonb_build_array(1, 4)
            ),
            'source', 'pgtap',
            'run', gen_random_uuid()::text
          ),
          p_idempotency_key := 'pgtap-b08-uc098-partial-out-of-range'
        )
      $sql$,
      v_task_id
    ),
    '23514',
    format('route_stop_finalize: delivered_box_numbers must belong to shipment %s', v_shipment),
    'partial delivery rejects out-of-range delivered_box_numbers'
  );

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM public.transition_task_v1(
          p_task_id := '%1$s'::uuid,
          p_to_status := 'completed',
          p_status_reason := 'partial_delivery',
          p_payload := jsonb_build_object(
            'handover_mode', 'mailroom',
            'recipient_name', 'B08 Mailroom',
            'recipient_class', 'mailroom',
            'completion_notes', 'empty delivered_box_numbers should fail',
            'delivery_completion', jsonb_build_object(
              'completion_kind', 'partial',
              'delivered_box_numbers', jsonb_build_array()
            ),
            'source', 'pgtap',
            'run', gen_random_uuid()::text
          ),
          p_idempotency_key := 'pgtap-b08-uc098-partial-empty'
        )
      $sql$,
      v_task_id
    ),
    '23514',
    'route_stop_finalize: partial_delivery requires delivered_box_ids or delivered_box_numbers',
    'partial delivery rejects empty delivered_box_numbers'
  );

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM public.transition_task_v1(
          p_task_id := '%1$s'::uuid,
          p_to_status := 'completed',
          p_status_reason := 'partial_delivery',
          p_payload := jsonb_build_object(
            'handover_mode', 'mailroom',
            'recipient_name', 'B08 Mailroom',
            'recipient_class', 'mailroom',
            'completion_notes', 'all-box partial delivery should fail',
            'delivery_completion', jsonb_build_object(
              'completion_kind', 'partial',
              'delivered_box_numbers', jsonb_build_array(1, 2, 3)
            ),
            'source', 'pgtap',
            'run', gen_random_uuid()::text
          ),
          p_idempotency_key := 'pgtap-b08-uc098-partial-all-boxes'
        )
      $sql$,
      v_task_id
    ),
    '23514',
    format(
      'route_stop_finalize: partial_delivery requires a strict subset of shipment boxes (shipment box_count=%s delivered=%s)',
      3,
      3
    ),
    'partial delivery rejects all-box delivered_box_numbers'
  );

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'partial_delivery',
      p_payload := jsonb_build_object(
        'handover_mode', 'mailroom',
        'recipient_name', 'B08 Mailroom',
        'recipient_class', 'mailroom',
        'completion_notes', 'Two boxes handed over; one remains outstanding.',
        'delivery_completion', jsonb_build_object(
          'completion_kind', 'partial',
          'delivered_box_numbers', jsonb_build_array(1, 2)
        ),
        'source', 'pgtap',
        'run', gen_random_uuid()::text
      ),
      p_idempotency_key := 'pgtap-b08-uc098-done'
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_id, v_workflow_run_id
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.route_stop_execute'
     AND (de.payload->>'task_event_id') = v_task_done_event_id::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_workflow_run_id
      FROM public.domain_events
     WHERE id = v_domain_event_id;
    EXIT WHEN v_workflow_run_id IS NOT NULL;
  END LOOP;

  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status FROM public.workflow_runs WHERE id = v_workflow_run_id;
    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_workflow_run_id);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id
    INTO v_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text
   ORDER BY sa.timestamp DESC
   LIMIT 1;

  RETURN NEXT is(v_run_status, 'completed', 'partial-delivery workflow run completes');
  RETURN NEXT is((SELECT status FROM public.shipments WHERE id = v_shipment), 'out_for_delivery', 'partial delivery leaves shipment out_for_delivery');
  RETURN NEXT ok((SELECT delivered_at IS NULL FROM public.shipments WHERE id = v_shipment), 'partial delivery leaves shipments.delivered_at null');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.shipment_boxes WHERE shipment_id = v_shipment AND status = 'delivered'), 2, 'partial delivery marks two boxes delivered');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.shipment_boxes WHERE shipment_id = v_shipment AND status = 'pending'), 1, 'partial delivery leaves one box pending');
  RETURN NEXT is((SELECT sa.action_data->'delivery_completion'->>'completion_kind' FROM public.shipment_actions sa WHERE sa.id = v_action_id), 'partial', 'shipment_action records partial delivery completion kind');
  RETURN NEXT is((SELECT sa.action_data->'delivery_completion'->>'delivered_box_count' FROM public.shipment_actions sa WHERE sa.id = v_action_id), '2', 'shipment_action records delivered box count');
  RETURN NEXT is((SELECT sa.action_data->'delivery_completion'->>'remaining_box_count' FROM public.shipment_actions sa WHERE sa.id = v_action_id), '1', 'shipment_action records remaining box count');
  RETURN NEXT ok(
    (SELECT action_data->'delivery_completion'->'delivered_box_numbers' = '[1, 2]'::jsonb FROM public.shipment_actions WHERE id = v_action_id),
    'shipment_action records delivered box numbers in order'
  );
  RETURN NEXT is((SELECT delivery_completion_kind FROM public.shipment_actions WHERE id = v_action_id), 'partial', 'generated completion kind projection is populated');
  RETURN NEXT is((SELECT delivered_box_count::TEXT FROM public.shipment_actions WHERE id = v_action_id), '2', 'generated delivered box count projection is populated');
  RETURN NEXT is((SELECT remaining_box_count::TEXT FROM public.shipment_actions WHERE id = v_action_id), '1', 'generated remaining box count projection is populated');
  RETURN NEXT is((SELECT status FROM public.route_runs WHERE id = v_route_run_id), 'completed', 'single-stop partial delivery closes the route run');
END;
$function$;

SELECT * FROM pg_temp.test_b08_delivery_completion_closeout_v1();

SELECT * FROM finish();
ROLLBACK;

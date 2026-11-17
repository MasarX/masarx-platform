-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Task completion effects v1 (task completion -> domain_event -> workflow -> shipment_actions)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(40);

CREATE OR REPLACE FUNCTION pg_temp.test_task_completion_effects_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_template_id UUID;

  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();

  v_shipment_reschedule UUID := gen_random_uuid();
  v_shipment_return UUID := gen_random_uuid();
  v_shipment_swap UUID := gen_random_uuid();

  v_task_created RECORD;
  v_task_id UUID;
  v_task_done_event_id UUID;

  v_domain_event_id UUID;
  v_domain_event_run_id UUID;
  v_run_status TEXT;
  v_iter INT;

  v_actions_count INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_trigger('public', 'task_events', 'trg_task_events_completed_domain_event', 'task_events completion trigger exists');
  RETURN NEXT has_function('public', 'domain_event_from_task_event_completed_v1', ARRAY[]::text[], 'task completion trigger fn exists');
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'task_completion_effects' AND is_active IS TRUE),
    'handler registered: task_completion_effects'
  );

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'task_completion_effects_v1'
   LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: task_completion_effects_v1');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    1,
    'task_completion_effects_v1 has 1 step'
  );
  RETURN NEXT is(
    (SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1),
    'task_completion_effects',
    'step 1 handler_key = task_completion_effects'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.dispatch_reschedule_delivery')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.dispatch_reschedule_delivery -> task_completion_effects_v1'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.dispatch_return_pickup')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.dispatch_return_pickup -> task_completion_effects_v1'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.dispatch_swap_completion')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.dispatch_swap_completion -> task_completion_effects_v1'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.warehouse_receive')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.warehouse_receive -> task_completion_effects_v1'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.warehouse_sort')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.warehouse_sort -> task_completion_effects_v1'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.warehouse_stage')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.warehouse_stage -> task_completion_effects_v1'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.warehouse_load_vehicle')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.warehouse_load_vehicle -> task_completion_effects_v1'
  );

  RETURN NEXT is(
    COALESCE(NULLIF(public.resolve_domain_event_policy(v_org, 'task.completed.warehouse_exception_hold')->>'workflow_template_id', ''), ''),
    v_template_id::text,
    'domain_event_policy maps task.completed.warehouse_exception_hold -> task_completion_effects_v1'
  );

  RETURN NEXT ok(
    COALESCE((
      SELECT (s.cached_value->'task_type_map' ? 'warehouse_receive')
      FROM public.settings s
      WHERE s.category = 'task_completion_effects_policy'
        AND s.scope_type = 'global'
        AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      LIMIT 1
    ), FALSE),
    'task_completion_effects_policy contains warehouse_receive effect'
  );

  RETURN NEXT ok(
    COALESCE((
      SELECT (s.cached_value->'task_type_map' ? 'warehouse_sort')
      FROM public.settings s
      WHERE s.category = 'task_completion_effects_policy'
        AND s.scope_type = 'global'
        AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      LIMIT 1
    ), FALSE),
    'task_completion_effects_policy contains warehouse_sort effect'
  );

  RETURN NEXT ok(
    COALESCE((
      SELECT (s.cached_value->'task_type_map' ? 'warehouse_stage')
      FROM public.settings s
      WHERE s.category = 'task_completion_effects_policy'
        AND s.scope_type = 'global'
        AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      LIMIT 1
    ), FALSE),
    'task_completion_effects_policy contains warehouse_stage effect'
  );

  RETURN NEXT ok(
    COALESCE((
      SELECT (s.cached_value->'task_type_map' ? 'warehouse_load_vehicle')
      FROM public.settings s
      WHERE s.category = 'task_completion_effects_policy'
        AND s.scope_type = 'global'
        AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      LIMIT 1
    ), FALSE),
    'task_completion_effects_policy contains warehouse_load_vehicle effect'
  );

  RETURN NEXT ok(
    COALESCE((
      SELECT (s.cached_value->'task_type_map' ? 'warehouse_exception_hold')
      FROM public.settings s
      WHERE s.category = 'task_completion_effects_policy'
        AND s.scope_type = 'global'
        AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      LIMIT 1
    ), FALSE),
    'task_completion_effects_policy contains warehouse_exception_hold effect'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Task Effects Org', 'task-effects-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_ops, v_org, 'ops-' || left(v_ops::text, 8) || '@example.com', 'Ops ' || left(v_ops::text, 8), 'tenant');

  -- RBAC: task mutation RPCs are permission-gated; grant ops_admin to the actor user.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_ops);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_ops, r.id, v_ops, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Task Effects Client', 'task-effects-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Task Effects Sender', 'Task Effects Sender', TRUE, 'active');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES
    (v_shipment_reschedule, v_org, v_client, v_sender, 'delivery', 'pgtap-task-effects-reschedule-' || left(v_shipment_reschedule::text, 8), 'delivery_failed'),
    (v_shipment_return, v_org, v_client, v_sender, 'delivery', 'pgtap-task-effects-return-' || left(v_shipment_return::text, 8), 'delivered'),
    (v_shipment_swap, v_org, v_client, v_sender, 'swap', 'pgtap-task-effects-swap-' || left(v_shipment_swap::text, 8), 'delivery_failed');

  -- Create follow-up task as system (service role).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'dispatch_reschedule_delivery',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'shipment',
        'resource_id', v_shipment_reschedule,
        'idempotency_key', 'pgtap-task-effects-reschedule',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id := v_task_created.task_id;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'create_task_system_v1 creates dispatch_reschedule_delivery task');

  -- Complete task as authenticated operator (enqueues domain_event).
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'rescheduled',
      p_payload := jsonb_build_object('note', 'pgtap rescheduled'),
      p_idempotency_key := 'pgtap-task-effects-reschedule-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'operator transitions follow-up task to completed');

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id, workflow_run_id
    INTO v_domain_event_id, v_domain_event_run_id
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.dispatch_reschedule_delivery'
     AND (de.payload->>'task_event_id') = v_task_done_event_id::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  RETURN NEXT ok(v_domain_event_id IS NOT NULL, 'domain_event enqueued for task.completed.dispatch_reschedule_delivery');

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

  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status FROM public.workflow_runs WHERE id = v_domain_event_run_id;
    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(COALESCE(v_run_status, ''), 'completed', 'task_completion_effects_v1 completes');

  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_reschedule AND client_id = v_client),
    'pending',
    'shipment status updated to pending after reschedule follow-up task completion'
  );

  SELECT COUNT(*)::int
    INTO v_actions_count
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_reschedule
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text;

  RETURN NEXT is(v_actions_count, 1, 'shipment_action emitted exactly once for follow-up task completion');

  RETURN NEXT is(
    (SELECT COALESCE(canonical_status, '') FROM public.shipment_actions sa
      WHERE sa.shipment_id = v_shipment_reschedule
        AND sa.organization_id = v_org
        AND sa.client_id = v_client
        AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text
      ORDER BY sa.created_at DESC
      LIMIT 1),
    'pending',
    'shipment_action canonical_status reflects pending'
  );

  -- Return pickup follow-up task completion.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'dispatch_return_pickup',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'shipment',
        'resource_id', v_shipment_return,
        'idempotency_key', 'pgtap-task-effects-return',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id := v_task_created.task_id;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'create_task_system_v1 creates dispatch_return_pickup task');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'picked_up',
      p_payload := jsonb_build_object('note', 'pgtap return pickup'),
      p_idempotency_key := 'pgtap-task-effects-return-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'operator transitions dispatch_return_pickup task to completed');

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id, workflow_run_id
    INTO v_domain_event_id, v_domain_event_run_id
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.dispatch_return_pickup'
     AND (de.payload->>'task_event_id') = v_task_done_event_id::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  RETURN NEXT ok(v_domain_event_id IS NOT NULL, 'domain_event enqueued for task.completed.dispatch_return_pickup');

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

  v_run_status := NULL;
  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status FROM public.workflow_runs WHERE id = v_domain_event_run_id;
    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(COALESCE(v_run_status, ''), 'completed', 'task_completion_effects_v1 completes (return pickup)');

  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_return AND client_id = v_client),
    'return_to_origin',
    'shipment status updated to return_to_origin after return pickup follow-up task completion'
  );

  SELECT COUNT(*)::int
    INTO v_actions_count
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_return
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text;

  RETURN NEXT is(v_actions_count, 1, 'shipment_action emitted exactly once for return pickup task completion');

  RETURN NEXT is(
    (SELECT COALESCE(canonical_status, '') FROM public.shipment_actions sa
      WHERE sa.shipment_id = v_shipment_return
        AND sa.organization_id = v_org
        AND sa.client_id = v_client
        AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text
      ORDER BY sa.created_at DESC
      LIMIT 1),
    'return_to_origin',
    'shipment_action canonical_status reflects return_to_origin'
  );

  -- Swap completion follow-up task completion.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'dispatch_swap_completion',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'shipment',
        'resource_id', v_shipment_swap,
        'idempotency_key', 'pgtap-task-effects-swap',
        'actor_system', 'dispatch_engine'
      )
    )
   LIMIT 1;

  v_task_id := v_task_created.task_id;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'create_task_system_v1 creates dispatch_swap_completion task');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'swapped',
      p_payload := jsonb_build_object('note', 'pgtap swap completion'),
      p_idempotency_key := 'pgtap-task-effects-swap-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'operator transitions dispatch_swap_completion task to completed');

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id, workflow_run_id
    INTO v_domain_event_id, v_domain_event_run_id
    FROM public.domain_events de
   WHERE de.organization_id = v_org
     AND de.event_type = 'task.completed.dispatch_swap_completion'
     AND (de.payload->>'task_event_id') = v_task_done_event_id::text
   ORDER BY de.created_at DESC
   LIMIT 1;

  RETURN NEXT ok(v_domain_event_id IS NOT NULL, 'domain_event enqueued for task.completed.dispatch_swap_completion');

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

  v_run_status := NULL;
  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status FROM public.workflow_runs WHERE id = v_domain_event_run_id;
    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id);
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(COALESCE(v_run_status, ''), 'completed', 'task_completion_effects_v1 completes (swap completion)');

  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_swap AND client_id = v_client),
    'delivered',
    'shipment status updated to delivered after swap completion follow-up task completion'
  );

  SELECT COUNT(*)::int
    INTO v_actions_count
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_swap
     AND sa.organization_id = v_org
     AND sa.client_id = v_client
     AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text;

  RETURN NEXT is(v_actions_count, 1, 'shipment_action emitted exactly once for swap completion task completion');

  RETURN NEXT is(
    (SELECT COALESCE(canonical_status, '') FROM public.shipment_actions sa
      WHERE sa.shipment_id = v_shipment_swap
        AND sa.organization_id = v_org
        AND sa.client_id = v_client
        AND (sa.action_data->>'task_event_id') = v_task_done_event_id::text
      ORDER BY sa.created_at DESC
      LIMIT 1),
    'delivered',
    'shipment_action canonical_status reflects delivered'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_task_completion_effects_v1();

SELECT * FROM finish();

ROLLBACK;

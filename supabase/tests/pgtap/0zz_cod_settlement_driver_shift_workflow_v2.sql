-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: COD driver shift settlement workflow v2 (variance gate + optional manager task + finance transfer)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(78);

CREATE OR REPLACE FUNCTION pg_temp.test_cod_settlement_driver_shift_workflow_v2()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_template_id UUID;

  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_cashier UUID := gen_random_uuid();
  v_manager UUID := gen_random_uuid();

  v_task_type_handover UUID := gen_random_uuid();
  v_task_type_cashier UUID := gen_random_uuid();
  v_task_type_manager UUID := gen_random_uuid();

  v_client_a UUID := gen_random_uuid();
  v_sender_a UUID := gen_random_uuid();
  v_vehicle_a UUID := gen_random_uuid();
  v_shipment_a UUID := gen_random_uuid();
  v_route_seed_a RECORD;
  v_route_stop_a UUID;

  v_client_b UUID := gen_random_uuid();
  v_sender_b UUID := gen_random_uuid();
  v_vehicle_b UUID := gen_random_uuid();
  v_shipment_b UUID := gen_random_uuid();
  v_route_seed_b RECORD;
  v_route_stop_b UUID;

  v_run_a UUID;
  v_run_b UUID;

  v_progress JSONB;
  v_ctx JSONB;

  v_settlement_batch_id UUID;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_requires_manager BOOLEAN := FALSE;
  v_driver_shift_session_id UUID;
  v_cash_drawer_session_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'task_enqueue' AND is_active IS TRUE),
    'handler registered: task_enqueue'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'task_wait' AND is_active IS TRUE),
    'handler registered: task_wait'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'settlement_batch' AND is_active IS TRUE),
    'handler registered: settlement_batch'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'finance_transfer' AND is_active IS TRUE),
    'handler registered: finance_transfer'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'variance_gate' AND is_active IS TRUE),
    'handler registered: variance_gate'
  );

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'cod_driver_shift_settlement_v2'
    LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: cod_driver_shift_settlement_v2');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    11,
    'template has 11 steps'
  );

  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1), 'settlement_batch', 'step 1 handler_key = settlement_batch');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 2), 'task_enqueue', 'step 2 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 3), 'task_wait', 'step 3 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 4), 'task_enqueue', 'step 4 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 5), 'task_wait', 'step 5 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 6), 'variance_gate', 'step 6 handler_key = variance_gate');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 7), 'finance_transfer', 'step 7 handler_key = finance_transfer');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 8), 'settlement_batch', 'step 8 handler_key = settlement_batch');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 9), 'task_enqueue', 'step 9 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 10), 'task_wait', 'step 10 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 11), 'settlement_batch', 'step 11 handler_key = settlement_batch');

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'COD Settlement Workflow v2 Org', 'cod-settle-v2-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'b-' || left(v_branch::text, 8), 'Branch ' || left(v_branch::text, 8), TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'Driver ' || left(v_driver::text, 8), 'tenant'),
    (v_cashier, v_org, 'cashier-' || left(v_cashier::text, 8) || '@example.com', 'Cashier ' || left(v_cashier::text, 8), 'tenant'),
    (v_manager, v_org, 'manager-' || left(v_manager::text, 8) || '@example.com', 'Manager ' || left(v_manager::text, 8), 'tenant');

  -- RBAC: task mutation RPCs are permission-gated; grant baseline roles to the actor users.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver', 'ops_admin'], v_manager);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_cashier, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_manager, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES
    (v_task_type_handover, v_org, 'cod_cash_handover', 'COD Cash Handover', TRUE, 50, 'default'),
    (v_task_type_cashier, v_org, 'cod_cashier_count', 'COD Cashier Count', TRUE, 50, 'default'),
    (v_task_type_manager, v_org, 'cod_manager_approval', 'COD Manager Approval', TRUE, 50, 'default');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client_a, v_org, 'COD Settlement Client A', 'cod-settlement-client-a-' || left(v_client_a::text, 8), 'active'),
    (v_client_b, v_org, 'COD Settlement Client B', 'cod-settlement-client-b-' || left(v_client_b::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender_a, v_client_a, 'COD Settlement Sender A', 'COD Settlement Sender A', TRUE, 'active'),
    (v_sender_b, v_client_b, 'COD Settlement Sender B', 'COD Settlement Sender B', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', TRUE);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:cod-settlement-driver-shift-v2-fixture-bootstrap');

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES
    (v_vehicle_a, v_org, 'active', TRUE),
    (v_vehicle_b, v_org, 'active', TRUE);

  INSERT INTO public.shipments (
    id, organization_id, client_id, sender_id, service_type, tracking_number, status, box_count, cod_amount, cod_currency
  )
  VALUES
    (v_shipment_a, v_org, v_client_a, v_sender_a, 'delivery', 'CODSETA' || upper(left(v_shipment_a::text, 8)), 'out_for_delivery', 1, 100, 'SAR'),
    (v_shipment_b, v_org, v_client_b, v_sender_b, 'delivery', 'CODSETB' || upper(left(v_shipment_b::text, 8)), 'out_for_delivery', 1, 100, 'SAR');

  SELECT *
    INTO v_route_seed_a
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle_a,
        'idempotency_key', 'pgtap-v2-route-seed-a',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client_a, 'shipment_id', v_shipment_a, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;
  v_route_stop_a := (v_route_seed_a.stop_ids)[1];

  SELECT *
    INTO v_route_seed_b
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle_b,
        'idempotency_key', 'pgtap-v2-route-seed-b',
        'stops', jsonb_build_array(
          jsonb_build_object('client_id', v_client_b, 'shipment_id', v_shipment_b, 'stop_kind', 'delivery', 'sequence_order', 1)
        )
      )
    )
   LIMIT 1;
  v_route_stop_b := (v_route_seed_b.stop_ids)[1];

  -- Seed canonical delivery payment collection truth as test owner; the
  -- service-role workflow execution starts after these fixture rows.
  INSERT INTO public.shipment_actions (
    organization_id,
    client_id,
    shipment_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_system,
    action_data,
    timestamp
  )
  VALUES (
    v_org,
    v_client_a,
    v_shipment_a,
    'status_change',
    'operational',
    'delivered',
    'pgtap',
    jsonb_build_object(
      'route_stop_id', v_route_stop_a,
      'delivery_completion', jsonb_build_object(
        'completion_kind', 'full',
        'payment_collection', jsonb_build_object(
          'required', TRUE,
          'outcome', 'collected',
          'method', 'cash',
          'expected_amount', 100,
          'collected_amount', 100,
          'variance_amount', 0,
          'has_discrepancy', FALSE,
          'discrepancy_kind', 'matched',
          'currency', 'SAR',
          'allowed_methods', jsonb_build_array('cash'),
          'payment_mode_label', 'Cash',
          'receipt_context', 'scenario-a-seed'
        )
      )
    ),
    now() - make_interval(hours => 6)
  );

  INSERT INTO public.shipment_actions (
    organization_id,
    client_id,
    shipment_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_system,
    action_data,
    timestamp
  )
  VALUES (
    v_org,
    v_client_b,
    v_shipment_b,
    'status_change',
    'operational',
    'delivered',
    'pgtap',
    jsonb_build_object(
      'route_stop_id', v_route_stop_b,
      'delivery_completion', jsonb_build_object(
        'completion_kind', 'full',
        'payment_collection', jsonb_build_object(
          'required', TRUE,
          'outcome', 'collected',
          'method', 'cash',
          'expected_amount', 100,
          'collected_amount', 100,
          'variance_amount', 0,
          'has_discrepancy', FALSE,
          'discrepancy_kind', 'matched',
          'currency', 'SAR',
          'allowed_methods', jsonb_build_array('cash'),
          'payment_mode_label', 'Cash',
          'receipt_context', 'scenario-b-seed'
        )
      )
    ),
    now() - make_interval(hours => 2)
  );

  -- Service-role workflow execution (auth.uid() NULL; actor_system captured via app.actor_system).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  ---------------------------------------------------------------------------
  -- Scenario A: variance within tolerance (manager steps skipped)
  ---------------------------------------------------------------------------

  v_run_a := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'cod',
      'scope_type', 'driver_shift',
      'branch_id', v_branch,
      'subject_type', 'user',
      'subject_id', v_driver,
      'window_start_at', now() - make_interval(hours => 8),
      'window_end_at', now() - make_interval(hours => 4),
      'trigger_source', 'pgtap'
    ))
  );

  RETURN NEXT ok(v_run_a IS NOT NULL, 'scenario A: start_workflow_run returns run_id');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 1 completes');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  v_settlement_batch_id := NULLIF(v_ctx->>'settlement_batch_id', '')::uuid;
  RETURN NEXT ok(v_settlement_batch_id IS NOT NULL, 'scenario A: context has settlement_batch_id');
  RETURN NEXT is(v_ctx->'settlement'->>'expected_amount', '100', 'scenario A: settlement context uses canonical COD expected amount');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 2 completes');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario A: step 3 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_task_id := NULLIF((v_ctx->'driver_handover_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT ops_session_id
    INTO v_driver_shift_session_id
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'driver_shift',
      'branch_id', v_branch,
      'idempotency_key', 'pgtap-v2-a-driver-shift'
    ))
   LIMIT 1;

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'handover completed',
      p_payload := jsonb_build_object('amount', 80, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_driver_shift_session_id),
      p_idempotency_key := 'pgtap-v2-a-driver-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario A: driver completes handover task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_a AND sequence_order = 3;

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 3 completes after driver completion');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 4 completes');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario A: step 5 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_task_id := NULLIF((v_ctx->'cashier_count_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_cashier::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT ops_session_id
    INTO v_cash_drawer_session_id
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'branch_cash_drawer',
      'branch_id', v_branch,
      'idempotency_key', 'pgtap-v2-a-cash-drawer'
    ))
   LIMIT 1;

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'cashier counted and accepted',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_cash_drawer_session_id),
      p_idempotency_key := 'pgtap-v2-a-cashier-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario A: cashier completes count task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_a AND sequence_order = 5;

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 5 completes after cashier completion');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  RETURN NEXT is(v_ctx->'cod_variance'->>'expected_amount', '100', 'scenario A: variance gate expected amount comes from settlement summary');
  RETURN NEXT is(v_ctx->'cod_variance'->>'actual_amount', '100', 'scenario A: variance gate actual amount uses cashier count');
  BEGIN v_requires_manager := COALESCE((v_ctx->'cod_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
  RETURN NEXT is(v_requires_manager, FALSE, 'scenario A: variance does not require manager approval');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 7 completes (finance transfer)');

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    2,
    'scenario A: two finance events attached (cod_handover)'
  );
  RETURN NEXT is(
    (SELECT MIN(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    100::numeric,
    'scenario A: finance transfer amount matches cashier count (min)'
  );
  RETURN NEXT is(
    (SELECT MAX(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    100::numeric,
    'scenario A: finance transfer amount matches cashier count (max)'
  );

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 8 completes (lock)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 9 completes (manager enqueue skipped)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  RETURN NEXT ok(
    NULLIF(btrim(COALESCE(v_ctx->'manager_approval_task'->>'task_id', '')), '') IS NULL,
    'scenario A: manager approval task_id is absent'
  );

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 10 completes (manager wait skipped)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 11 completes (approve)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: workflow run finalizes');
  RETURN NEXT is((SELECT workflow_status FROM public.workflow_runs WHERE id = v_run_a), 'completed', 'scenario A: workflow_runs.workflow_status is completed');
  RETURN NEXT is((SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'approved', 'scenario A: settlement batch approved');
  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.tasks t
     JOIN public.task_types tt ON tt.id = t.task_type_id
     WHERE t.organization_id = v_org
       AND t.resource_type = 'settlement_batch'
       AND t.resource_id = v_settlement_batch_id
       AND tt.key = 'cod_manager_approval'),
    0,
    'scenario A: no manager task created'
  );

  ---------------------------------------------------------------------------
  -- Scenario B: variance requires manager approval
  ---------------------------------------------------------------------------

  v_run_b := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'cod',
      'scope_type', 'driver_shift',
      'branch_id', v_branch,
      'subject_type', 'user',
      'subject_id', v_driver,
      'window_start_at', now() - make_interval(hours => 4),
      'window_end_at', now(),
      'trigger_source', 'pgtap'
    ))
  );

  RETURN NEXT ok(v_run_b IS NOT NULL, 'scenario B: start_workflow_run returns run_id');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 1 completes');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  v_settlement_batch_id := NULLIF(v_ctx->>'settlement_batch_id', '')::uuid;
  RETURN NEXT is(v_ctx->'settlement'->>'expected_amount', '100', 'scenario B: settlement context uses canonical COD expected amount');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 2 completes');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 3 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'driver_handover_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'handover completed',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_driver_shift_session_id),
      p_idempotency_key := 'pgtap-v2-b-driver-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: driver completes handover task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 3;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 3 completes after driver completion');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 4 completes');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 5 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'cashier_count_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_cashier::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'cashier counted with variance',
      p_payload := jsonb_build_object('amount', 90, 'currency', 'SAR', 'source', 'pgtap', 'ops_session_id', v_cash_drawer_session_id),
      p_idempotency_key := 'pgtap-v2-b-cashier-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: cashier completes count task (variance)');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 5;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 5 completes after cashier completion');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  RETURN NEXT is(v_ctx->'cod_variance'->>'expected_amount', '100', 'scenario B: variance gate expected amount comes from settlement summary');
  RETURN NEXT is(v_ctx->'cod_variance'->>'actual_amount', '90', 'scenario B: variance gate actual amount uses cashier count');
  BEGIN v_requires_manager := COALESCE((v_ctx->'cod_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
  RETURN NEXT is(v_requires_manager, TRUE, 'scenario B: variance requires manager approval');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 7 completes (finance transfer)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 8 completes (lock)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 9 completes (manager task enqueued)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'manager_approval_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'scenario B: manager approval task_id exists');
  RETURN NEXT is(
    (SELECT metadata->'allowed_actions' FROM public.tasks WHERE id = v_task_id),
    jsonb_build_array('approve', 'reject'),
    'scenario B: manager approval task exposes row-driven approve/reject actions'
  );
  RETURN NEXT is(
    (SELECT queue_key FROM public.tasks WHERE id = v_task_id),
    'finance',
    'scenario B: manager approval task is routed to finance queue'
  );
  RETURN NEXT is(
    (SELECT metadata->>'description' FROM public.tasks WHERE id = v_task_id),
    'Review the COD variance decision and approve or reject the settlement closeout.',
    'scenario B: manager approval task carries operator decision description'
  );

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 10 pending while manager task is open');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_manager::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'variance approved',
      p_payload := jsonb_build_object('approved', TRUE, 'source', 'pgtap'),
      p_idempotency_key := 'pgtap-v2-b-manager-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: manager completes approval task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 10;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 10 completes after manager approval');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 11 completes (approve)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: workflow run finalizes');

  RETURN NEXT is((SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'approved', 'scenario B: settlement batch approved');
  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.tasks t
     JOIN public.task_types tt ON tt.id = t.task_type_id
     WHERE t.organization_id = v_org
       AND t.resource_type = 'settlement_batch'
       AND t.resource_id = v_settlement_batch_id
       AND tt.key = 'cod_manager_approval'),
    1,
    'scenario B: manager task created'
  );
  RETURN NEXT is(
    (SELECT MIN(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    90::numeric,
    'scenario B: finance transfer amount matches cashier count (min)'
  );
  RETURN NEXT is(
    (SELECT MAX(fe.amount)::numeric
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'cod_handover'),
    90::numeric,
    'scenario B: finance transfer amount matches cashier count (max)'
  );

  RETURN;
END;
$$;

SELECT * FROM pg_temp.test_cod_settlement_driver_shift_workflow_v2();

SELECT * FROM finish();

ROLLBACK;

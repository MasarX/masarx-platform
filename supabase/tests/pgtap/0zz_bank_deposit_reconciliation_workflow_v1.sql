-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Bank deposit reconciliation workflow v1 (deposit slip -> bank match -> variance gate -> optional manager approval -> finance transfer)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(72);

CREATE OR REPLACE FUNCTION pg_temp.test_bank_deposit_reconciliation_workflow_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_template_id UUID;

  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();

  v_cashier UUID := gen_random_uuid();
  v_accounting UUID := gen_random_uuid();
  v_manager UUID := gen_random_uuid();

  v_task_type_slip UUID := gen_random_uuid();
  v_task_type_bank_match UUID := gen_random_uuid();
  v_task_type_manager UUID := gen_random_uuid();

  v_run_a UUID;
  v_run_b UUID;

  v_progress JSONB;
  v_ctx JSONB;

  v_settlement_batch_id UUID;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_requires_manager BOOLEAN := FALSE;
  v_cash_drawer_session_id UUID := NULL;
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
   WHERE name = 'bank_deposit_reconciliation_v1'
    LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: bank_deposit_reconciliation_v1');
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

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'settlement_kind'
        AND lv.value = 'deposit'
        AND lv.status = 'active'
    ),
    'lookup has settlement_kind=deposit'
  );

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Deposit Workflow Org', 'deposit-wf-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Deposit Workflow Client', 'deposit-wf-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Deposit Workflow Sender', 'Deposit Workflow Sender', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:bank-deposit-workflow-fixture-bootstrap');

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'b-' || left(v_branch::text, 8), 'Branch ' || left(v_branch::text, 8), TRUE);

  -- Deterministic settlement_policy for pgTAP: ensure manager approval is required for any non-zero variance.
  -- This avoids coupling to mutable global settings in cloud environments.
  PERFORM *
    FROM public.upsert_settings_value_v1(
      'settlement_policy',
      'tenant',
      v_org,
      jsonb_build_object(
        'version', 1,
        'enabled', true,
        'batch_scopes', jsonb_build_array('branch_day'),
        'locking', jsonb_build_object('require_manager_approval', true, 'max_variance_amount', 0)
      ),
      1,
      'pgtap: deposit reconciliation deterministic settlement policy'
    );

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_cashier, v_org, 'cashier-' || left(v_cashier::text, 8) || '@example.com', 'Cashier ' || left(v_cashier::text, 8), 'tenant'),
    (v_accounting, v_org, 'acct-' || left(v_accounting::text, 8) || '@example.com', 'Accounting ' || left(v_accounting::text, 8), 'tenant'),
    (v_manager, v_org, 'manager-' || left(v_manager::text, 8) || '@example.com', 'Manager ' || left(v_manager::text, 8), 'tenant');

  -- RBAC: task mutation RPCs are permission-gated; grant ops_admin to actor users (cashier/accounting/manager).
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_manager);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_cashier, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_accounting, r.id, v_manager, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
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
    (v_task_type_slip, v_org, 'bank_deposit_slip_create', 'Bank Deposit Slip Create', TRUE, 50, 'default'),
    (v_task_type_bank_match, v_org, 'bank_deposit_bank_match', 'Bank Deposit Bank Match', TRUE, 50, 'default'),
    (v_task_type_manager, v_org, 'bank_deposit_manager_approval', 'Bank Deposit Manager Approval', TRUE, 50, 'default');

  -- Service-role workflow execution (auth.uid() NULL; actor_system captured via app.actor_system).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  ---------------------------------------------------------------------------
  -- Scenario A: no variance (manager steps skipped)
  ---------------------------------------------------------------------------

  v_run_a := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'deposit',
      'scope_type', 'branch_day',
      'branch_id', v_branch,
      'subject_type', 'branch',
      'subject_id', v_branch,
      'window_start_at', now() - make_interval(days => 1),
      'window_end_at', now(),
      'trigger_source', 'pgtap'
    ))
  );

  RETURN NEXT ok(v_run_a IS NOT NULL, 'scenario A: start_workflow_run returns run_id');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 1 completes');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  v_settlement_batch_id := NULLIF(v_ctx->>'settlement_batch_id', '')::uuid;
  RETURN NEXT ok(v_settlement_batch_id IS NOT NULL, 'scenario A: context has settlement_batch_id');

  RETURN NEXT is((SELECT kind FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'deposit', 'scenario A: settlement batch kind=deposit');
  RETURN NEXT is((SELECT scope_type FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'branch_day', 'scenario A: settlement batch scope_type=branch_day');
  RETURN NEXT is((SELECT branch_id FROM public.settlement_batches WHERE id = v_settlement_batch_id), v_branch, 'scenario A: settlement batch branch_id matches');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 2 completes');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario A: step 3 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_task_id := NULLIF((v_ctx->'deposit_slip_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_cashier::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT ops_session_id
    INTO v_cash_drawer_session_id
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'branch_cash_drawer',
      'branch_id', v_branch,
      'idempotency_key', 'pgtap-deposit-a-cash-drawer'
    ))
   LIMIT 1;

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'deposit slip created',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'deposit_slip_ref', 'DS-A', 'source', 'pgtap', 'ops_session_id', v_cash_drawer_session_id),
      p_idempotency_key := 'pgtap-deposit-a-slip-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario A: cashier completes deposit slip task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_a AND sequence_order = 3;

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 3 completes after slip completion');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 4 completes');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario A: step 5 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_task_id := NULLIF((v_ctx->'bank_match_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_accounting::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'bank matched deposit',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'bank_ref', 'BK-A', 'source', 'pgtap'),
      p_idempotency_key := 'pgtap-deposit-a-bankmatch-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario A: accounting completes bank match task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_a AND sequence_order = 5;

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 5 completes after bank match');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_requires_manager := COALESCE((v_ctx->'deposit_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
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
       AND fe.event_type = 'deposit'),
    2,
    'scenario A: two finance events attached (deposit)'
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
       AND fe.event_type = 'deposit'),
    100::numeric,
    'scenario A: finance transfer amount matches bank match (min)'
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
       AND fe.event_type = 'deposit'),
    100::numeric,
    'scenario A: finance transfer amount matches bank match (max)'
  );

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 8 completes (lock)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 9 completes (manager enqueue skipped)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 10 completes (manager wait skipped)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 11 completes (approve)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: workflow run finalizes');

  RETURN NEXT is((SELECT workflow_status FROM public.workflow_runs WHERE id = v_run_a), 'completed', 'scenario A: workflow_runs.workflow_status is completed');
  RETURN NEXT is((SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'approved', 'scenario A: settlement batch status is approved');

  ---------------------------------------------------------------------------
  -- Scenario B: variance requires manager approval
  ---------------------------------------------------------------------------

  v_run_b := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'deposit',
      'scope_type', 'branch_day',
      'branch_id', v_branch,
      'subject_type', 'branch',
      'subject_id', v_branch,
      'window_start_at', now() - make_interval(days => 1),
      'window_end_at', now(),
      'trigger_source', 'pgtap'
    ))
  );

  RETURN NEXT ok(v_run_b IS NOT NULL, 'scenario B: start_workflow_run returns run_id');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 1 completes');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  v_settlement_batch_id := NULLIF(v_ctx->>'settlement_batch_id', '')::uuid;
  RETURN NEXT ok(v_settlement_batch_id IS NOT NULL, 'scenario B: context has settlement_batch_id');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 2 completes');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 3 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'deposit_slip_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_cashier::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'deposit slip created',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'deposit_slip_ref', 'DS-B', 'source', 'pgtap', 'ops_session_id', v_cash_drawer_session_id),
      p_idempotency_key := 'pgtap-deposit-b-slip-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: cashier completes deposit slip task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 3;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 3 completes after slip completion');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 4 completes');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 5 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'bank_match_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_accounting::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'bank matched deposit',
      p_payload := jsonb_build_object('amount', 99, 'currency', 'SAR', 'bank_ref', 'BK-B', 'source', 'pgtap'),
      p_idempotency_key := 'pgtap-deposit-b-bankmatch-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: accounting completes bank match task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 5;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 5 completes after bank match');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_requires_manager := COALESCE((v_ctx->'deposit_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
  RETURN NEXT is(v_requires_manager, TRUE, 'scenario B: variance requires manager approval');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 7 completes (finance transfer)');

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'deposit'),
    2,
    'scenario B: two finance events attached (deposit)'
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
       AND fe.event_type = 'deposit'),
    99::numeric,
    'scenario B: finance transfer amount matches bank match (min)'
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
       AND fe.event_type = 'deposit'),
    99::numeric,
    'scenario B: finance transfer amount matches bank match (max)'
  );

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 8 completes (lock)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 9 completes (manager enqueue)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 10 starts as pending');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_task_id := NULLIF((v_ctx->'deposit_manager_approval_task'->>'task_id'), '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_manager::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'manager approved variance',
      p_payload := jsonb_build_object('approved', true, 'source', 'pgtap'),
      p_idempotency_key := 'pgtap-deposit-b-manager-done'
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

  RETURN NEXT is((SELECT workflow_status FROM public.workflow_runs WHERE id = v_run_b), 'completed', 'scenario B: workflow_runs.workflow_status is completed');
  RETURN NEXT is((SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'approved', 'scenario B: settlement batch status is approved');

  RETURN;
END;
$$;

SELECT * FROM pg_temp.test_bank_deposit_reconciliation_workflow_v1();

SELECT * FROM finish();

ROLLBACK;

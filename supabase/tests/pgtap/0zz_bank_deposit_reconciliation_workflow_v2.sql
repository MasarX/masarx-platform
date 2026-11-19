-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Bank deposit reconciliation workflow v2 (deposit slip -> bank statement match -> finance transfer -> variance gate)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(67);

CREATE OR REPLACE FUNCTION pg_temp.test_bank_deposit_reconciliation_workflow_v2()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_template_id UUID;

  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_bank_account UUID := gen_random_uuid();

  v_cashier UUID := gen_random_uuid();
  v_manager UUID := gen_random_uuid();

  v_task_type_slip UUID := gen_random_uuid();
  v_task_type_manager UUID := gen_random_uuid();

  v_settings_version UUID;
  v_settlement_policy_settings_version UUID;
  v_settlement_policy_value JSONB := jsonb_build_object(
    'version', 1,
    'enabled', true,
    'batch_scopes', jsonb_build_array('branch_day'),
    'locking', jsonb_build_object('require_manager_approval', true, 'max_variance_amount', 0)
  );
  v_bank_reconciliation_policy_value JSONB := jsonb_build_object(
    'version', 1,
    'enabled', true,
    'default_bank_account_key', 'main',
    'bank_statement_event_type', 'bank_statement',
    'match', jsonb_build_object('window_days_before', 2, 'window_days_after', 2, 'amount_tolerance', 20, 'require_unique', true)
  );

  v_run_a UUID;
  v_run_b UUID;

  v_progress JSONB;
  v_ctx JSONB;

  v_settlement_batch_id UUID;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_cash_drawer_session_id UUID := NULL;

  v_stmt_finance_event_id UUID;
  v_requires_manager BOOLEAN := FALSE;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'bank_statement_match' AND is_active IS TRUE),
    'handler registered: bank_statement_match'
  );
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
   WHERE name = 'bank_deposit_reconciliation_v2'
    LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: bank_deposit_reconciliation_v2');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    10,
    'template has 10 steps'
  );

  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1), 'settlement_batch', 'step 1 handler_key = settlement_batch');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 2), 'task_enqueue', 'step 2 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 3), 'task_wait', 'step 3 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 4), 'bank_statement_match', 'step 4 handler_key = bank_statement_match');
  RETURN NEXT is(
    (SELECT metadata->>'bank_account_id_path'
       FROM public.workflow_template_steps
      WHERE workflow_template_id = v_template_id
        AND sequence_order = 4),
    '$.context.payload.bank_account_id',
    'step 4 resolves explicit bank_account_id from workflow context payload'
  );
  RETURN NEXT is(
    (SELECT metadata->>'bank_account_key_path'
       FROM public.workflow_template_steps
      WHERE workflow_template_id = v_template_id
        AND sequence_order = 4),
    '$.context.payload.bank_account_key',
    'step 4 resolves explicit bank_account_key from workflow context payload'
  );
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 5), 'finance_transfer', 'step 5 handler_key = finance_transfer');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 6), 'variance_gate', 'step 6 handler_key = variance_gate');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 7), 'settlement_batch', 'step 7 handler_key = settlement_batch');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 8), 'task_enqueue', 'step 8 handler_key = task_enqueue');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 9), 'task_wait', 'step 9 handler_key = task_wait');
  RETURN NEXT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 10), 'settlement_batch', 'step 10 handler_key = settlement_batch');

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
  VALUES (v_org, 'Deposit Workflow v2 Org', 'deposit-wf2-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Deposit Workflow v2 Client', 'deposit-wf2-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Deposit Workflow v2 Sender', 'Deposit Workflow v2 Sender', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:bank-deposit-workflow-v2-fixture-bootstrap');

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'b-' || left(v_branch::text, 8), 'Branch ' || left(v_branch::text, 8), TRUE);

  -- Deterministic settlement_policy for pgTAP: ensure manager approval is required for any non-zero variance.
  -- New org onboarding can pre-seed this category, so mutate existing row when present.
  SELECT s.settings_version_id
    INTO v_settlement_policy_settings_version
    FROM public.settings s
   WHERE s.category = 'settlement_policy'
     AND s.scope_type = 'tenant'
     AND s.scope_id = v_org
   LIMIT 1;

  IF v_settlement_policy_settings_version IS NULL THEN
    v_settlement_policy_settings_version := gen_random_uuid();

    INSERT INTO public.settings_versions (id, category, scope_type, scope_id, version, value, schema_version, approved_at)
    VALUES (
      v_settlement_policy_settings_version,
      'settlement_policy',
      'tenant',
      v_org,
      1,
      v_settlement_policy_value,
      1,
      now()
    );

    INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
    VALUES (
      'settlement_policy',
      'tenant',
      v_org,
      v_settlement_policy_settings_version,
      v_settlement_policy_value,
      now()
    );
  ELSE
    UPDATE public.settings_versions
       SET value = v_settlement_policy_value,
           schema_version = 1,
           approved_at = COALESCE(approved_at, now())
     WHERE id = v_settlement_policy_settings_version;

    UPDATE public.settings
       SET cached_value = v_settlement_policy_value,
           last_updated = now()
     WHERE category = 'settlement_policy'
       AND scope_type = 'tenant'
       AND scope_id = v_org;
  END IF;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_cashier, v_org, 'cashier-' || left(v_cashier::text, 8) || '@example.com', 'Cashier ' || left(v_cashier::text, 8), 'tenant'),
    (v_manager, v_org, 'manager-' || left(v_manager::text, 8) || '@example.com', 'Manager ' || left(v_manager::text, 8), 'tenant');

  -- RBAC: task mutation RPCs are permission-gated; grant ops_admin to actor users (cashier/manager).
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_manager);

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
    (v_task_type_slip, v_org, 'bank_deposit_slip_create', 'Bank Deposit Slip Create', TRUE, 50, 'default'),
    (v_task_type_manager, v_org, 'bank_deposit_manager_approval', 'Bank Deposit Manager Approval', TRUE, 50, 'default');

  INSERT INTO public.bank_accounts (id, organization_id, key, name, bank_name, currency, is_active, metadata)
  VALUES (v_bank_account, v_org, 'main', 'Main', 'Test Bank', 'SAR', TRUE, jsonb_build_object('source', 'pgtap'));

  -- Enable bank_reconciliation_policy at tenant scope with a default bank account.
  SELECT s.settings_version_id
    INTO v_settings_version
    FROM public.settings s
   WHERE s.category = 'bank_reconciliation_policy'
     AND s.scope_type = 'tenant'
     AND s.scope_id = v_org
   LIMIT 1;

  IF v_settings_version IS NULL THEN
    v_settings_version := gen_random_uuid();

    INSERT INTO public.settings_versions (id, category, scope_type, scope_id, version, value, schema_version, approved_at)
    VALUES (
      v_settings_version,
      'bank_reconciliation_policy',
      'tenant',
      v_org,
      1,
      v_bank_reconciliation_policy_value,
      1,
      now()
    );

    INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
    VALUES ('bank_reconciliation_policy', 'tenant', v_org, v_settings_version, v_bank_reconciliation_policy_value, now());
  ELSE
    UPDATE public.settings_versions
       SET value = v_bank_reconciliation_policy_value,
           schema_version = 1,
           approved_at = COALESCE(approved_at, now())
     WHERE id = v_settings_version;

    UPDATE public.settings
       SET cached_value = v_bank_reconciliation_policy_value,
           last_updated = now()
     WHERE category = 'bank_reconciliation_policy'
       AND scope_type = 'tenant'
       AND scope_id = v_org;
  END IF;

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
      'idempotency_key', 'pgtap-deposit2-a-cash-drawer'
    ))
   LIMIT 1;

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'deposit slip created',
      p_payload := jsonb_build_object('amount', 100, 'currency', 'SAR', 'deposit_slip_ref', 'DS-A', 'source', 'pgtap', 'ops_session_id', v_cash_drawer_session_id),
      p_idempotency_key := 'pgtap-deposit2-a-slip-done'
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
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario A: step 4 starts as pending (no statement yet)');

  SELECT finance_event_id
    INTO v_stmt_finance_event_id
    FROM public.record_bank_statement_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'bank_account_key', 'main',
        'event_type', 'bank_statement',
        'direction', 'in',
        'amount', 100,
        'currency', 'SAR',
        'idempotency_key', 'pgtap-deposit2-a-statement-1'
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_stmt_finance_event_id IS NOT NULL, 'scenario A: record_bank_statement_event_v1 creates statement finance_event');

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_a AND sequence_order = 4;

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 4 completes after statement event exists');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 5 completes (finance transfer)');

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
    'scenario A: two finance events attached (deposit transfer)'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'bank_statement'),
    1,
    'scenario A: one finance event attached (bank_statement)'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int
     FROM public.settlement_batch_finance_events sbfe
     JOIN public.finance_events fe
       ON fe.id = sbfe.finance_event_id
      AND fe.organization_id = sbfe.organization_id
      AND fe.occurred_at = sbfe.finance_occurred_at
     WHERE sbfe.settlement_batch_id = v_settlement_batch_id
       AND sbfe.organization_id = v_org
       AND fe.event_type = 'deposit'
       AND fe.direction = 'in'
       AND fe.account_type = 'bank_account'
       AND fe.account_id = v_bank_account),
    1,
    'scenario A: deposit in-event uses bank_account account_type/id'
  );

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_a;
  BEGIN v_requires_manager := COALESCE((v_ctx->'deposit_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
  RETURN NEXT is(v_requires_manager, FALSE, 'scenario A: variance does not require manager approval');

  RETURN NEXT ok(
    (v_ctx->'deposit_variance'->>'cod_policy_settings_resolution_id') IS NULL,
    'scenario A: cod_policy_settings_resolution_id is NULL (use_cod_policy=false)'
  );
  RETURN NEXT ok(
    (v_ctx->'deposit_variance'->>'settlement_policy_settings_resolution_id') IS NOT NULL,
    'scenario A: settlement_policy_settings_resolution_id is present'
  );

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 7 completes (lock)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 8 completes (manager enqueue skipped)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 9 completes (manager wait skipped)');

  v_progress := progress_workflow_run(v_run_a);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario A: step 10 completes (approve)');

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
      p_idempotency_key := 'pgtap-deposit2-b-slip-done'
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
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 4 starts as pending (no statement yet)');

  SELECT finance_event_id
    INTO v_stmt_finance_event_id
    FROM public.record_bank_statement_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'bank_account_key', 'main',
        'event_type', 'bank_statement',
        'direction', 'in',
        'amount', 90,
        'currency', 'SAR',
        'idempotency_key', 'pgtap-deposit2-b-statement-1'
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_stmt_finance_event_id IS NOT NULL, 'scenario B: record_bank_statement_event_v1 creates statement finance_event');

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 4;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 4 completes after statement event exists');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 5 completes (finance transfer)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 6 completes (variance gate)');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_b;
  BEGIN v_requires_manager := COALESCE((v_ctx->'deposit_variance'->>'requires_manager_approval')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_manager := FALSE; END;
  RETURN NEXT is(v_requires_manager, TRUE, 'scenario B: variance requires manager approval');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 7 completes (lock)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 8 completes (manager task enqueued)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'pending', 'scenario B: step 9 starts as pending (wait manager)');

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
      p_idempotency_key := 'pgtap-deposit2-b-manager-done'
    )
   LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'scenario B: manager completes approval task');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps SET run_at = now()
   WHERE workflow_run_id = v_run_b AND sequence_order = 9;

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 9 completes after manager approval');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: step 10 completes (approve)');

  v_progress := progress_workflow_run(v_run_b);
  RETURN NEXT is(v_progress->>'status', 'completed', 'scenario B: workflow run finalizes');

  RETURN NEXT is((SELECT workflow_status FROM public.workflow_runs WHERE id = v_run_b), 'completed', 'scenario B: workflow_runs.workflow_status is completed');
  RETURN NEXT is((SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id), 'approved', 'scenario B: settlement batch status is approved');

  RETURN;
END;
$$;

SELECT * FROM pg_temp.test_bank_deposit_reconciliation_workflow_v2();

SELECT * FROM finish();

ROLLBACK;

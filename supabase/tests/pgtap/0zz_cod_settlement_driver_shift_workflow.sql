-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: COD driver shift settlement workflow skeleton (task-based)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(25);

CREATE OR REPLACE FUNCTION pg_temp.test_cod_settlement_driver_shift_workflow()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_template_id UUID;
  v_run_id UUID;

  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_task_type UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();

  v_progress JSONB;
  v_ctx JSONB;

  v_settlement_batch_id UUID;
  v_task_id UUID;
  v_task_event_id UUID;
  v_task_done_event_id UUID := NULL;
  v_driver_shift_session_id UUID := NULL;

  v_step2_result JSONB;
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

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'cod_driver_shift_settlement_v1'
    LIMIT 1;

  RETURN NEXT ok(v_template_id IS NOT NULL, 'workflow template exists: cod_driver_shift_settlement_v1');
  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id),
    4,
    'template has 4 steps'
  );
  RETURN NEXT is(
    (SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 1),
    'settlement_batch',
    'step 1 handler_key = settlement_batch'
  );
  RETURN NEXT is(
    (SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 2),
    'task_enqueue',
    'step 2 handler_key = task_enqueue'
  );
  RETURN NEXT is(
    (SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 3),
    'task_wait',
    'step 3 handler_key = task_wait'
  );
  RETURN NEXT is(
    (SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id = v_template_id AND sequence_order = 4),
    'settlement_batch',
    'step 4 handler_key = settlement_batch'
  );

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'COD Settlement Workflow Org', 'cod-settle-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'COD Settlement Workflow Client', 'cod-settle-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'COD Settlement Workflow Sender', 'COD Settlement Workflow Sender', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', TRUE);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:cod-settlement-driver-shift-v1-fixture-bootstrap');

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'b-' || left(v_branch::text, 8), 'Branch ' || left(v_branch::text, 8), TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (
    v_driver,
    v_org,
    'driver-' || left(v_driver::text, 8) || '@example.com',
    'Driver ' || left(v_driver::text, 8),
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

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type, v_org, 'cod_cash_handover', 'COD Cash Handover', TRUE, 50, 'default');

  -- Service-role workflow execution (auth.uid() NULL; actor_system captured via app.actor_system).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  v_run_id := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'cod',
      'scope_type', 'driver_shift',
      'branch_id', v_branch,
      'subject_type', 'user',
      'subject_id', v_driver,
      'window_start_at', now() - make_interval(hours => 8),
      'window_end_at', now(),
      'trigger_source', 'pgtap'
    ))
  );

  RETURN NEXT ok(v_run_id IS NOT NULL, 'start_workflow_run returns run_id');

  -- Step 1: create settlement batch
  v_progress := progress_workflow_run(v_run_id);
  IF COALESCE(v_progress->>'status', '') <> 'completed' THEN
    RETURN NEXT diag('step 1 error: ' || COALESCE(v_progress->>'error', v_progress::text));
  END IF;
  RETURN NEXT is(v_progress->>'status', 'completed', 'step 1 completes');

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_id;
  v_settlement_batch_id := NULLIF(v_ctx->>'settlement_batch_id', '')::uuid;
  RETURN NEXT ok(v_settlement_batch_id IS NOT NULL, 'workflow context has settlement_batch_id');
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.settlement_batches WHERE id = v_settlement_batch_id AND organization_id = v_org),
    'settlement_batches row created'
  );

  -- Step 2: enqueue COD cash handover task
  v_progress := progress_workflow_run(v_run_id);
  RETURN NEXT is(v_progress->>'status', 'completed', 'step 2 completes');

  SELECT operation_result
    INTO v_step2_result
    FROM public.workflow_run_steps
   WHERE workflow_run_id = v_run_id
     AND sequence_order = 2;

  BEGIN
    v_task_id := NULLIF(btrim(COALESCE(v_step2_result->>'task_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_id := NULL;
  END;

  SELECT context INTO v_ctx FROM public.workflow_runs WHERE id = v_run_id;
  IF v_task_id IS NULL THEN
    BEGIN
      v_task_id := NULLIF((v_ctx->'cash_handover_task'->>'task_id'), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_task_id := NULL;
    END;
  END IF;

  RETURN NEXT ok(v_task_id IS NOT NULL, 'workflow context/step result has cash handover task_id');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.tasks t
      WHERE t.id = v_task_id
        AND t.organization_id = v_org
        AND t.resource_type = 'settlement_batch'
        AND t.resource_id = v_settlement_batch_id
    ),
    'task created for settlement_batch resource'
  );

  v_task_event_id := NULLIF(v_step2_result->>'task_event_id', '')::uuid;
  RETURN NEXT ok(v_task_event_id IS NOT NULL, 'step 2 operation_result includes task_event_id');
  RETURN NEXT is(
    (SELECT actor_system FROM public.task_events WHERE id = v_task_event_id),
    'workflow_engine',
    'task created event captures actor_system=workflow_engine'
  );

  -- Step 3: wait (should be pending while task is open)
  v_progress := progress_workflow_run(v_run_id);
  RETURN NEXT is(v_progress->>'status', 'pending', 'step 3 starts as pending');

  -- Complete task as authenticated driver
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  IF v_task_id IS NOT NULL THEN
    SELECT ops_session_id
      INTO v_driver_shift_session_id
      FROM public.open_ops_session_v1(jsonb_build_object(
        'session_type', 'driver_shift',
        'branch_id', v_branch,
        'idempotency_key', 'pgtap-cod-v1-driver-shift'
      ))
     LIMIT 1;

    SELECT task_event_id
      INTO v_task_done_event_id
      FROM public.transition_task_v1(
        p_task_id := v_task_id,
        p_to_status := 'completed',
        p_status_reason := 'handover completed',
        p_payload := jsonb_build_object('source', 'pgtap', 'ops_session_id', v_driver_shift_session_id),
        p_idempotency_key := 'pgtap-cod-handover-done'
      )
     LIMIT 1;
  ELSE
    v_task_done_event_id := NULL;
  END IF;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'driver transitions task to completed');

  -- Force wait step runnable now, then proceed
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  UPDATE public.workflow_run_steps
     SET run_at = now()
   WHERE workflow_run_id = v_run_id
      AND sequence_order = 3;

  v_progress := progress_workflow_run(v_run_id);
  RETURN NEXT is(v_progress->>'status', 'completed', 'step 3 completes after task completion');

  -- Step 4: lock settlement batch
  v_progress := progress_workflow_run(v_run_id);
  RETURN NEXT is(v_progress->>'status', 'completed', 'step 4 completes');

  -- Finalize run (no pending steps)
  v_progress := progress_workflow_run(v_run_id);
  RETURN NEXT is(v_progress->>'status', 'completed', 'workflow run finalizes');

  RETURN NEXT is(
    (SELECT workflow_status FROM public.workflow_runs WHERE id = v_run_id),
    'completed',
    'workflow_runs.workflow_status is completed'
  );

  RETURN NEXT is(
    (SELECT status FROM public.settlement_batches WHERE id = v_settlement_batch_id),
    'locked',
    'settlement batch locked'
  );
  RETURN;
END;
$$;

SELECT * FROM pg_temp.test_cod_settlement_driver_shift_workflow();

SELECT * FROM finish();

ROLLBACK;

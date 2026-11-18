BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(47);

SELECT has_function('public', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid', 'text'], 'canonical cancellation accepts a reason');
SELECT has_function('api', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid', 'text'], 'API cancellation accepts a reason');
SELECT has_function('api', 'ui_tabular_import_profiles_v1', ARRAY['text', 'jsonb'], 'scope-aware profile lookup remains exposed');
SELECT ok(has_function_privilege('service_role', 'api.process_tabular_import_run_v1(uuid,integer)', 'EXECUTE'), 'service role can process a bounded start batch');
SELECT ok(NOT has_function_privilege('authenticated', 'api.process_tabular_import_run_v1(uuid,integer)', 'EXECUTE'), 'authenticated users cannot invoke the processor');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_cancel_tabular_import_run_v1(uuid,text)', 'EXECUTE'), 'anonymous users cannot cancel');
SELECT matches(pg_get_functiondef('public.ui_cancel_tabular_import_run_v1(uuid,text)'::regprocedure), 'FOR UPDATE', 'cancellation serializes with the existing worker run lock');

CREATE FUNCTION pg_temp.import_lifecycle_snapshot(p_run_id UUID)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'run', to_jsonb(r),
    'rows', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.row_number), '[]'::jsonb)
               FROM public.tabular_import_run_rows x WHERE x.run_id = r.id),
    'task', (SELECT to_jsonb(t) FROM public.tasks t WHERE t.id = r.task_id),
    'task_events', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
                     FROM public.task_events e WHERE e.task_id = r.task_id),
    'decisions', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb)
                   FROM public.decision_log d WHERE d.resource_id = r.id),
    'domain_events', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
                       FROM public.domain_events e WHERE e.resource_id = r.id)
  ) FROM public.tabular_import_runs r WHERE r.id = p_run_id;
$$;

CREATE FUNCTION pg_temp.test_import_cancellation_lineage()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_denied_actor UUID := gen_random_uuid();
  v_type UUID := gen_random_uuid();
  v_task UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_terminal UUID;
  v_terminal_task UUID;
  v_status TEXT;
  v_correlation UUID := gen_random_uuid();
  v_snapshot JSONB;
  v_success_row JSONB;
  v_result JSONB;
  v_expected JSONB;
  v_capability TEXT;
  v_resource JSONB;
  v_partial UUID := gen_random_uuid();
  v_partial_task UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id, name, slug) VALUES
    (v_org, 'Import lifecycle', 'import-life-' || left(v_org::text, 8)),
    (v_other_org, 'Other import lifecycle', 'import-life-' || left(v_other_org::text, 8));
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_actor, v_org, v_actor::text || '@example.com', 'Import operator', 'ops_admin', 'active', 'tenant'),
    (v_denied_actor, v_org, v_denied_actor::text || '@example.com', 'Read-only operator', 'account_manager', 'active', 'tenant');
  INSERT INTO public.task_types(id, organization_id, key, name)
  VALUES (v_type, v_org, 'tabular_import.process', 'Tabular import');
  INSERT INTO public.tasks(id, organization_id, task_type_id, resource_type, resource_id, status, priority)
  VALUES (v_task, v_org, v_type, 'tabular_import_run', v_run, 'open', 50);
  INSERT INTO public.tabular_import_runs(id, organization_id, resource_key, relation_name, status, task_id, summary)
  VALUES (v_run, v_org, 'shipments', 'public.shipments', 'processing', v_task, '{"preserved":"summary"}');
  INSERT INTO public.tabular_import_run_rows(run_id, organization_id, row_number, action, execution_status, target_record_id, processed_at)
  VALUES
    (v_run, v_org, 2, 'create', 'queued', NULL, NULL),
    (v_run, v_org, 3, 'create', 'succeeded', 'confirmed-record', now() - interval '1 day');
  SELECT to_jsonb(r) INTO v_success_row FROM public.tabular_import_run_rows r WHERE run_id = v_run AND row_number = 3;
  v_snapshot := pg_temp.import_lifecycle_snapshot(v_run);

  RETURN NEXT throws_ok(format('SELECT public.ui_cancel_tabular_import_run_v1(NULL::uuid, %L)', 'reason'), '22023', 'ui_cancel_tabular_import_run_v1 requires run id', 'null run is rejected');
  RETURN NEXT throws_ok(format('SELECT public.ui_cancel_tabular_import_run_v1(%L::uuid, NULL::text)', v_run), '22023', 'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason', 'null reason is rejected');
  RETURN NEXT throws_ok(format('SELECT public.ui_cancel_tabular_import_run_v1(%L::uuid, %L)', v_run, ''), '22023', 'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason', 'empty reason is rejected');
  RETURN NEXT throws_ok(format('SELECT api.ui_cancel_tabular_import_run_v1(%L::uuid, %L)', v_run, '   '), '22023', 'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason', 'blank API reason is rejected');
  RETURN NEXT throws_ok(format('SELECT public.ui_cancel_tabular_import_run_v1(%L::uuid)', v_run), '22023', 'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason', 'legacy public signature cannot mutate without a reason');
  RETURN NEXT throws_ok(format('SELECT api.ui_cancel_tabular_import_run_v1(%L::uuid)', v_run), '22023', 'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason', 'legacy API signature cannot mutate without a reason');
  v_terminal := gen_random_uuid();
  RETURN NEXT throws_ok(format('SELECT api.ui_cancel_tabular_import_run_v1(%L::uuid, %L)', v_terminal, 'reason'), 'P0002', format('ui_cancel_tabular_import_run_v1 run %s not found', v_terminal), 'missing run is rejected');
  RETURN NEXT is(pg_temp.import_lifecycle_snapshot(v_run), v_snapshot, 'invalid reasons leave run, rows, task and audit untouched');

  UPDATE public.users SET organization_id = v_other_org WHERE id = v_actor;
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_actor)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.ui_cancel_tabular_import_run_v1(%L::uuid, %L)', v_run, 'cross tenant'), '42501', 'ui_cancel_tabular_import_run_v1 cannot cancel another organization', 'cross-tenant cancellation is denied');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(pg_temp.import_lifecycle_snapshot(v_run), v_snapshot, 'cross-tenant denial makes no changes');
  UPDATE public.users SET organization_id = v_org WHERE id = v_actor;

  PERFORM set_config('request.jwt.claim.sub', v_denied_actor::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_denied_actor)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_resource := public.tabular_import_resolve_resource_v1('shipments');
  v_capability := COALESCE(NULLIF(v_resource#>>'{import,capability}', ''), NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''), 'system.write');
  RETURN NEXT is(public.user_capability_eval_v1(v_capability, 'tenant', v_org)->>'allowed', 'false', 'read-only fixture lacks the resource import capability');
  RETURN NEXT throws_ok(format('SELECT api.ui_cancel_tabular_import_run_v1(%L::uuid, %L)', v_run, 'no capability'), '42501', 'Capability denied: ' || v_capability, 'same-tenant cancellation still requires the resource capability');
  RETURN NEXT throws_ok(format('SELECT api.process_tabular_import_run_v1(%L::uuid, 1)', v_run), '42501', 'permission denied for function process_tabular_import_run_v1', 'processor is not exposed to an authenticated caller');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(pg_temp.import_lifecycle_snapshot(v_run), v_snapshot, 'capability denial leaves all import state untouched');

  PERFORM set_config('request.jwt.claim.sub', v_actor::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_actor)::text, TRUE);
  PERFORM set_config('request.correlation_id', v_correlation::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(public.user_capability_eval_v1(v_capability, 'tenant', v_org)->>'allowed', 'true', 'operator fixture has the resource import capability');
  v_result := api.ui_cancel_tabular_import_run_v1(v_run, '  Duplicate source file  ');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(v_result->>'status', 'canceled', 'canonical readback confirms cancellation');
  RETURN NEXT is(v_result#>>'{summary,cancel_reason}', 'Duplicate source file', 'trimmed reason is persisted');
  RETURN NEXT is(v_result#>>'{summary,cancellation,actor_user_id}', v_actor::text, 'cancellation records the actor');
  RETURN NEXT is(v_result#>>'{summary,cancellation,correlation_id}', v_correlation::text, 'cancellation reuses request correlation');
  RETURN NEXT is(v_result#>>'{summary,cancellation,canceled_at}', v_result->>'canceled_at', 'audit timestamp matches the canonical cancellation timestamp');
  RETURN NEXT is(v_result#>>'{summary,preserved}', 'summary', 'existing summary is preserved');
  RETURN NEXT is(v_result->>'updated_by', v_actor::text, 'canonical run records the actor');
  RETURN NEXT is((SELECT execution_status FROM public.tabular_import_run_rows WHERE run_id = v_run AND row_number = 2), 'canceled', 'unprocessed row is canceled');
  RETURN NEXT is((SELECT to_jsonb(r) FROM public.tabular_import_run_rows r WHERE run_id = v_run AND row_number = 3), v_success_row, 'already successful row is unchanged');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = v_task), 'canceled', 'existing task transition cancels the task');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.task_events WHERE task_id = v_task AND to_status = 'canceled' AND payload->>'reason' = 'Duplicate source file' AND payload->>'actor_user_id' = v_actor::text AND payload->>'correlation_id' = v_correlation::text), 'task event retains the reason, actor and correlation');
  RETURN NEXT is((SELECT count(*)::int FROM public.decision_log WHERE resource_id = v_run AND decision_category = 'imports.cancel' AND decision_reason = 'Duplicate source file' AND decision_inputs->>'actor_user_id' = v_actor::text AND correlation_id = v_correlation), 1, 'one canonical decision audit is written');
  RETURN NEXT is((SELECT count(*)::int FROM public.domain_events WHERE resource_id = v_run AND event_type = 'tabular_import_run.canceled' AND payload->>'reason' = 'Duplicate source file' AND payload->>'actor_user_id' = v_actor::text AND correlation_id = v_correlation AND status = 'pending'), 1, 'one domain event is ready for the existing worker');

  -- The historical terminal-22023 variant is deliberately not the current contract.
  FOREACH v_status IN ARRAY ARRAY['completed', 'completed_with_errors', 'failed', 'canceled'] LOOP
    v_terminal := gen_random_uuid();
    v_terminal_task := gen_random_uuid();
    INSERT INTO public.tasks(id, organization_id, task_type_id, resource_type, resource_id, status, priority)
    VALUES (v_terminal_task, v_org, v_type, 'tabular_import_run', v_terminal, 'open', 50);
    INSERT INTO public.tabular_import_runs(id, organization_id, resource_key, relation_name, status, task_id, summary, completed_at)
    VALUES (v_terminal, v_org, 'shipments', 'public.shipments', v_status, v_terminal_task, '{"cancel_reason":"original reason","preserved":"terminal"}', now() - interval '1 day');
    INSERT INTO public.tabular_import_run_rows(run_id, organization_id, row_number, action, execution_status)
    VALUES (v_terminal, v_org, 2, 'create', 'queued');
    PERFORM public.tabular_import_transition_task_system_v1(v_terminal_task, 'open', 'prior_event', '{"prior":"terminal"}', 'lineage_test');
    INSERT INTO public.decision_log(id, organization_id, decision_category, resource_type, resource_id, decision_point, decision_outcome, decision_inputs, performed_by_system)
    VALUES (gen_random_uuid(), v_org, 'imports.cancel', 'tabular_import_run', v_terminal, 'prior_event', 'cancelled', '{"prior":"terminal"}', 'lineage_test');
    INSERT INTO public.domain_events(organization_id, event_type, resource_type, resource_id, payload)
    VALUES (v_org, 'tabular_import_run.prior_event', 'tabular_import_run', v_terminal, '{"prior":"terminal"}');
    v_snapshot := pg_temp.import_lifecycle_snapshot(v_terminal);
    v_expected := public.ui_get_tabular_import_run_v1(v_terminal);
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT is(api.ui_cancel_tabular_import_run_v1(v_terminal, 'late cancellation'), v_expected, v_status || ' returns exact canonical readback rather than historical 22023');
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT is(pg_temp.import_lifecycle_snapshot(v_terminal), v_snapshot, v_status || ' leaves run, rows, task, task events, decision and domain audit unchanged');
  END LOOP;

  INSERT INTO public.tasks(id, organization_id, task_type_id, resource_type, resource_id, status, priority)
  VALUES (v_partial_task, v_org, v_type, 'tabular_import_run', v_partial, 'open', 2147483647);
  INSERT INTO public.tabular_import_runs(id, organization_id, resource_key, relation_name, status, task_id)
  VALUES (v_partial, v_org, 'shipments', 'public.shipments', 'processing', v_partial_task);
  INSERT INTO public.tabular_import_run_rows(run_id, organization_id, row_number, action, execution_status)
  VALUES (v_partial, v_org, 2, 'create', 'queued');
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role', 'sub', v_actor)::text, TRUE);
  v_result := public.claim_next_tabular_import_task_v1('lineage-test-worker');
  RETURN NEXT is(v_result->>'run_id', v_partial::text, 'existing worker can claim a partially processed start batch');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = v_partial_task), 'in_progress', 'partial run claim takes canonical task ownership');
  v_snapshot := pg_temp.import_lifecycle_snapshot(v_partial);
  v_result := public.claim_next_tabular_import_task_v1('second-test-worker');
  RETURN NEXT ok(v_result IS NULL OR v_result->>'run_id' <> v_partial::text, 'another worker never reclaims an in-progress task');
  RETURN NEXT is(pg_temp.import_lifecycle_snapshot(v_partial), v_snapshot, 'active worker task, rows and audit remain unchanged');
END;
$$;

SELECT * FROM pg_temp.test_import_cancellation_lineage();
SELECT * FROM finish();
ROLLBACK;

BEGIN;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(28);

CREATE FUNCTION pg_temp.test_import_worker_completion()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_payload JSONB;
  v_rows JSONB;
  v_prepared JSONB;
  v_run UUID;
  v_small UUID;
  v_result JSONB;
  v_claim JSONB;
  v_report UUID;
BEGIN
  INSERT INTO public.organizations(id, name, slug)
  VALUES (v_org, 'Import worker completion', 'import-worker-' || left(v_org::text, 8));
  INSERT INTO public.clients(id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Import worker client', 'import-worker-' || left(v_client::text, 8), 'active');
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (v_actor, v_org, v_actor::text || '@example.com', 'Import worker operator', 'ops_admin', 'active', 'tenant', NULL);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_actor)::text, TRUE);

  SELECT jsonb_agg(jsonb_build_object(
    'Client Id', v_client, 'External Id', 'worker-' || n,
    'Name', 'Worker recipient ' || n, 'Phone Number', '+9665' || lpad(n::text, 8, '0'),
    'Email', 'worker-' || n || '@example.com', 'Preferred Language', 'en'
  ) ORDER BY n) INTO v_rows FROM generate_series(1, 501) n;
  v_payload := jsonb_build_object(
    'resource_key', 'recipients', 'write_mode', 'create', 'source_format', 'csv',
    'source_file_name', 'worker-completion.csv',
    'header_fingerprint', 'client_id|email|external_id|name|phone_number|preferred_language',
    'headers', jsonb_build_array('Client Id', 'External Id', 'Name', 'Phone Number', 'Email', 'Preferred Language'),
    'rules', jsonb_build_array(
      jsonb_build_object('source_column', 'Client Id', 'target_field', 'client_id', 'enabled', TRUE),
      jsonb_build_object('source_column', 'External Id', 'target_field', 'external_id', 'enabled', TRUE),
      jsonb_build_object('source_column', 'Name', 'target_field', 'name', 'enabled', TRUE),
      jsonb_build_object('source_column', 'Phone Number', 'target_field', 'phone_number', 'enabled', TRUE),
      jsonb_build_object('source_column', 'Email', 'target_field', 'email', 'enabled', TRUE),
      jsonb_build_object('source_column', 'Preferred Language', 'target_field', 'preferred_language', 'enabled', TRUE)
    ), 'rows', v_rows
  );
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_prepared := api.tabular_import_prepare_v1(v_payload);
  v_run := (v_prepared->>'run_id')::uuid;
  RETURN NEXT is((v_prepared->>'total_rows')::int, 501, 'actual prepare stages all 501 source rows');
  RETURN NEXT is((v_prepared->>'blocked_count')::int, 0, 'all native recipient fixtures pass preparation');
  RETURN NEXT is((v_prepared->>'will_create')::int, 501, 'native prepare plans 501 real recipient creations');
  v_result := api.ui_start_tabular_import_run_v1(v_run, NULL);
  RETURN NEXT is(v_result->>'status', 'queued', 'actual authenticated start queues the native run');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.tasks SET priority = 2147483647 WHERE id = (SELECT task_id FROM public.tabular_import_runs WHERE id = v_run);
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role', 'sub', v_actor)::text, TRUE);

  v_result := public.process_tabular_import_run_v1(v_run, 100);
  RETURN NEXT is((v_result->>'created_count')::int, 100, 'bounded kickoff writes the first 100 real rows');
  RETURN NEXT is(v_result->>'status', 'processing', '401 rows remain after kickoff');
  RETURN NEXT ok(NOT (v_result ? 'remaining'), 'actual processor returns a canonical snapshot without remaining');
  v_claim := public.claim_next_tabular_import_task_v1('native-completion-worker');
  RETURN NEXT is(v_claim->>'run_id', v_run::text, 'worker owns the partially processed kickoff run');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = (v_claim->>'task_id')::uuid), 'in_progress', 'worker owns the task across its batches');
  v_result := public.process_tabular_import_run_v1(v_run, 200);
  RETURN NEXT is((v_result->>'created_count')::int, 300, 'first worker batch reaches 300 real records');
  RETURN NEXT is(v_result->>'status', 'processing', 'first worker batch leaves the run active');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = (v_claim->>'task_id')::uuid), 'in_progress', 'first batch retains the original claim');
  v_result := public.process_tabular_import_run_v1(v_run, 200);
  RETURN NEXT is((v_result->>'created_count')::int, 500, 'second worker batch reaches 500 real records');
  RETURN NEXT is(v_result->>'status', 'processing', 'the last row requires another owned batch');
  v_result := public.process_tabular_import_run_v1(v_run, 200);
  RETURN NEXT is((v_result->>'created_count')::int, 501, 'last owned batch completes all source rows');
  RETURN NEXT is(v_result->>'status', 'completed', 'canonical run completes after all batches');
  RETURN NEXT is((SELECT count(*)::int FROM public.recipients WHERE organization_id = v_org AND client_id = v_client), 501, 'all 501 destination records exist');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = (v_claim->>'task_id')::uuid), 'completed', 'the processor completes the original worker task');
  RETURN NEXT ok(v_result->>'report_id' IS NOT NULL, 'native completion persists the operation report');

  -- One real existing row and one new row reproduce terminal kickoff before worker claim.
  v_rows := jsonb_build_array(v_rows->0, jsonb_build_object(
    'Client Id', v_client, 'External Id', 'worker-502', 'Name', 'Worker recipient 502',
    'Phone Number', '+966500000502', 'Email', 'worker-502@example.com', 'Preferred Language', 'en'
  ));
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_actor)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_prepared := api.tabular_import_prepare_v1(jsonb_set(v_payload, '{rows}', v_rows));
  v_small := (v_prepared->>'run_id')::uuid;
  RETURN NEXT is((v_prepared->>'will_skip')::int, 1, 'actual duplicate recipient is staged as skipped');
  RETURN NEXT is((v_prepared->>'will_create')::int, 1, 'the small run also contains one real new recipient');
  PERFORM api.ui_start_tabular_import_run_v1(v_small, NULL);
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role', 'sub', v_actor)::text, TRUE);
  v_result := public.process_tabular_import_run_v1(v_small, 100);
  RETURN NEXT is(v_result->>'status', 'completed_with_errors', 'small kickoff becomes terminal before a worker claims it');
  RETURN NEXT is((v_result->>'created_count')::int, 1, 'small kickoff creates its new recipient exactly once');
  RETURN NEXT is((v_result->>'skipped_count')::int, 1, 'small kickoff retains the actual skipped record');
  RETURN NEXT is((SELECT status FROM public.tasks WHERE id = (v_result->>'task_id')::uuid), 'completed', 'terminal kickoff already completes its task');
  RETURN NEXT ok(EXISTS(
    SELECT 1 FROM public.tabular_import_runs r
     WHERE r.id = v_small AND r.status IN ('completed', 'completed_with_errors', 'failed')
       AND r.error_artifact_id IS NULL AND EXISTS (
         SELECT 1 FROM public.tabular_import_run_rows rr WHERE rr.run_id = r.id
           AND (rr.action IN ('skip', 'block', 'failed') OR rr.execution_status IN ('skipped', 'blocked', 'failed'))
       )
  ), 'terminal kickoff remains eligible for idle error-export finalization');
  v_report := (v_result->>'report_id')::uuid;
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.mapping_operation_reports WHERE id = v_report AND next_steps::text LIKE '%annotated error export%'), 'persisted report requires the finalizer export');
  v_result := public.process_tabular_import_run_v1(v_small, 100);
  RETURN NEXT is(v_result->>'report_id', v_report::text, 'terminal processor readback does not recreate work or its report');
END;
$$;

SELECT * FROM pg_temp.test_import_worker_completion();
SELECT * FROM finish();
ROLLBACK;

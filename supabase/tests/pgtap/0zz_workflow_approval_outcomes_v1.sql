BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(9);

CREATE FUNCTION pg_temp.test_workflow_approval_outcomes()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_requester uuid := gen_random_uuid();
  v_reviewer uuid := gen_random_uuid();
  v_settings_version uuid;
  v_task uuid := gen_random_uuid();
  v_zone_request uuid := gen_random_uuid();
  v_run public.workflow_runs;
  v_other_run public.workflow_runs;
  v_step public.workflow_run_steps;
  v_response public.workflow_handler_response;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Approval fixture tenant', 'approval-fixture-' || v_org::text);
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Approval fixture client', 'approval-fixture-' || v_client::text, 'active');
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:approval-outcomes');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_requester, v_org, v_requester::text || '@example.test', 'Fixture Requester', 'ops_admin', 'active', 'tenant'),
         (v_reviewer, v_org, v_reviewer::text || '@example.test', 'Fixture Reviewer', 'ops_admin', 'active', 'tenant');

  PERFORM set_config('request.jwt.claim.sub', v_requester::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_requester)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT settings_version_id INTO STRICT v_settings_version
    FROM public.request_settings_change_v1(
      'ui_presentation_policy', 'tenant', v_org,
      public.resolve_settings('ui_presentation_policy', 'global', NULL::uuid), 'Synthetic approval request'
    );
  EXECUTE 'RESET ROLE';

  INSERT INTO public.workflow_runs (workflow_template_id, workflow_template_version, entry_point, context)
  SELECT id, version, 'manual', jsonb_build_object('organization_id', v_org)
    FROM public.workflow_templates
   WHERE name = 'zone_override_approval_v1' AND status = 'active' AND scope_type = 'global' AND scope_id IS NULL
   ORDER BY version DESC LIMIT 1
   RETURNING * INTO STRICT v_run;

  INSERT INTO public.manual_review_tasks (id, organization_id, client_id, task_type, resource_type, resource_id, metadata)
  VALUES (v_task, v_org, v_client, 'settings_approval', 'settings_version', v_settings_version,
          jsonb_build_object('workflow_run_id', v_run.id));
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(
    format('SELECT api.resolve_manual_review_task_v1(%L::uuid, %L, %L)', v_task, 'approved', 'Self review'),
    '42501', 'resolve_manual_review_task_v1 cannot resolve your own request',
    'settings requester with review capability cannot resolve the same task'
  );
  PERFORM set_config('request.jwt.claim.sub', v_reviewer::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_reviewer)::text, true);
  RETURN NEXT is((api.resolve_manual_review_task_v1(v_task, 'rejected', 'Distinct reviewer')).resolution_outcome,
                 'rejected', 'a distinct tenant reviewer can reject a settings request');
  RETURN NEXT is((api.resolve_manual_review_task_v1(v_task, 'approved', 'Repeated decision')).resolution_outcome,
                 'rejected', 'a repeated decision preserves the original manual review result');
  EXECUTE 'RESET ROLE';

  v_step.operation_result := jsonb_build_object('manual_review_task_id', v_task);
  v_other_run := v_run;
  v_other_run.id := gen_random_uuid();
  RETURN NEXT throws_ok(
    format('SELECT workflow_handlers.execute_settings_apply_v1(%L::public.workflow_run_steps, %L::public.workflow_runs)',
           v_step, v_other_run),
    '42501', 'settings_apply: manual review does not belong to this workflow run',
    'settings apply rejects a fallback task ID from a different run'
  );
  v_response := workflow_handlers.execute_settings_apply_v1(v_step, v_run);
  RETURN NEXT is(v_response.status, 'failed', 'settings apply resolves a same-run fallback task without applying rejection');
  RETURN NEXT is((workflow_handlers.execute_manual_review_wait_v1(v_step, v_run)).status, 'failed',
                 'manual review rejection fails an ordinary waiting step');

  SELECT metadata INTO STRICT v_step.metadata FROM public.workflow_template_steps
   WHERE workflow_template_id = v_run.workflow_template_id AND handler_key = 'manual_review_wait';
  RETURN NEXT is((workflow_handlers.execute_manual_review_wait_v1(v_step, v_run)).status, 'completed',
                 'zone override wait completes a recorded rejection for terminal handling');

  INSERT INTO public.zone_override_requests (
    id, organization_id, shipment_id, shipment_client_id, source_exception_id, requested_zone_id,
    request_reason, status, workflow_run_id, requested_by, reviewed_by, resolution_outcome
  ) VALUES (v_zone_request, v_org, gen_random_uuid(), v_client, gen_random_uuid(), gen_random_uuid(),
            'Synthetic zone decision', 'rejected', v_run.id, v_requester, v_reviewer, 'rejected');

  v_run.context := jsonb_build_object('zone_override_request_id', v_zone_request);
  v_response := workflow_handlers.execute_zone_override_apply_v1(v_step, v_run, '{"resolution_outcome":"approved"}');
  RETURN NEXT is(v_response.operation_result, jsonb_build_object(
     'zone_override_request_id', v_zone_request, 'resolution_outcome', 'rejected', 'applied', false
  ), 'zone override honors the recorded rejection over caller input');
  v_other_run.context := v_run.context;
  RETURN NEXT throws_ok(
    format('SELECT workflow_handlers.execute_zone_override_apply_v1(%L::public.workflow_run_steps, %L::public.workflow_runs)',
           v_step, v_other_run),
    '42501', 'zone override request does not belong to this workflow run',
    'zone override apply rejects a request from a different run'
  );
END;
$test$;

SELECT * FROM pg_temp.test_workflow_approval_outcomes();
SELECT * FROM finish();
ROLLBACK;

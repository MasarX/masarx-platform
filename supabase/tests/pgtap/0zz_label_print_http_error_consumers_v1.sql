-- Real consumer functions; transport/callback mocks and all fixtures roll back.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT no_plan();

CREATE TEMP TABLE label_http_cases (name text, envelope jsonb, failed boolean);
INSERT INTO label_http_cases VALUES
 ('worker-limit', '{"completed":true,"status":546,"body":{"code":"WORKER_LIMIT","message":"provider-private","bundle":{"signed_url":"https://example.test/provider-private"}}}', true),
 ('bad-gateway-text', '{"completed":true,"status":502,"body":"provider-private"}', true),
 ('transport-error', '{"completed":true,"status":0,"body":{"error":"provider-private"}}', true),
 ('success', '{"completed":true,"status":200,"body":{"status":"ok","marker":"success-preserved"}}', false),
 ('accepted', '{"completed":true,"status":202,"body":{"status":"pending","marker":"queue-preserved"}}', false),
 ('incomplete', '{"completed":false,"status":null,"body":{}}', false),
 ('explicit-failure', '{"completed":true,"status":200,"body":{"status":"failed","error":"renderer_failure"}}', true),
 ('explicit-error', '{"completed":true,"status":200,"body":{"error":"renderer_failure"}}', true);
CREATE TEMP TABLE label_http_calls (kind text, request_id bigint, payload jsonb);

CREATE OR REPLACE FUNCTION public.check_async_response(p_request_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $$
BEGIN
  INSERT INTO pg_temp.label_http_calls VALUES ('poll', p_request_id, NULL);
  RETURN current_setting('label_http.response')::jsonb;
END;
$$;
CREATE OR REPLACE FUNCTION public.invoke_label_renderer_print_sync_v1(
 p_workflow_run_id uuid, p_workflow_run_step_id uuid, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp AS $$
BEGIN
  INSERT INTO pg_temp.label_http_calls VALUES ('dispatch', 16701, p_payload);
  RETURN current_setting('label_http.response')::jsonb || '{"request_id":16701}'::jsonb;
END;
$$;
CREATE OR REPLACE FUNCTION public.progress_workflow_run_step_result_v1(
 p_workflow_run_id uuid, p_workflow_run_step_id uuid,
 p_operation_result jsonb DEFAULT '{}'::jsonb,
 p_budget_ms int DEFAULT NULL, p_max_steps int DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $$
BEGIN
  INSERT INTO pg_temp.label_http_calls VALUES ('callback', NULL, p_operation_result);
  IF p_operation_result->>'status' = 'failed' THEN
    UPDATE public.workflow_runs SET workflow_status = 'failed',
      failure_reason = 'label_print_execute_http_error', updated_at = now()
    WHERE id = p_workflow_run_id;
  END IF;
  RETURN jsonb_build_object('status', 'pending');
END;
$$;

CREATE FUNCTION pg_temp.label_http_consumer_cases()
RETURNS SETOF text LANGUAGE plpgsql AS $test$
DECLARE
  v_case record;
  v_lane text;
  v_run public.workflow_runs;
  v_step public.workflow_run_steps;
  v_result jsonb;
  v_payload jsonb;
  v_org uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_template uuid := gen_random_uuid();
  v_template_step uuid;
  v_run_id uuid;
  v_step_id uuid;
  v_context jsonb;
  v_label text;
  v_http_error boolean;
  v_count int;
  v_sequence int := 0;
BEGIN
  -- Exercise the real fresh-scope resolver: no rows means no downloadable artifact.
  v_step.id := gen_random_uuid();
  v_step.retry_attempt := 2;
  v_step.max_retries := 7;
  v_run.id := gen_random_uuid();
  v_run.metadata := '{}'::jsonb;
  FOR v_lane IN SELECT unnest(ARRAY['direct', 'poll']) LOOP
    FOR v_case IN SELECT * FROM pg_temp.label_http_cases LOOP
      TRUNCATE pg_temp.label_http_calls;
      PERFORM set_config('label_http.response', v_case.envelope::text, true);
      v_run.context := jsonb_build_object('organization_id', v_org, 'label_print',
        jsonb_build_object('organization_id', v_org, 'policy', '{}'::jsonb,
          'targets', jsonb_build_array(jsonb_build_object('shipment_id', gen_random_uuid())),
          'execute_async', CASE WHEN v_lane = 'poll' THEN '{"request_id":16701}'::jsonb ELSE '{}'::jsonb END));
      SELECT to_jsonb(workflow_handlers.execute_label_print_execute_v1(v_step, v_run, '{}'::jsonb))
        INTO v_result;
      v_label := v_lane || '/' || v_case.name;
      RETURN NEXT is(v_result->>'status', CASE WHEN v_case.failed THEN 'failed' ELSE 'pending' END,
        v_label || ' canonical outcome without a fabricated artifact');
      SELECT count(*) INTO v_count FROM pg_temp.label_http_calls WHERE kind = 'dispatch';
      RETURN NEXT is(v_count, CASE WHEN v_lane = 'direct' THEN 1 ELSE 0 END,
        v_label || ' never redispatches an existing request');
      v_http_error := COALESCE((v_case.envelope->>'completed')::boolean, false)
        AND COALESCE((v_case.envelope->>'status')::int, 0) NOT BETWEEN 200 AND 299;
      IF v_http_error THEN
        RETURN NEXT is(v_result #> '{operation_result,execute}', jsonb_build_object(
          'status', 'failed', 'error', 'label_print_execute_http_error',
          'http_status', COALESCE((v_case.envelope->>'status')::int, 0)),
          v_label || ' failed HTTP payload is stable and contains no provider body');
        RETURN NEXT ok(v_result::text NOT LIKE '%provider-private%', v_label || ' provider secrets absent');
      ELSIF COALESCE((v_case.envelope->>'completed')::boolean, false) THEN
        RETURN NEXT is(v_result #> '{operation_result,execute}', v_case.envelope->'body',
          v_label || ' successful transport preserves the renderer result');
      END IF;
      IF NOT v_case.failed THEN
        RETURN NEXT is((v_result->>'retry_attempt')::int, 3, v_label || ' keeps bounded poll retry count');
        RETURN NEXT is(v_result #>> '{context_patch,label_print,execute_async,request_id}', '16701',
          v_label || ' keeps the exact request identity');
      END IF;
    END LOOP;
  END LOOP;

  INSERT INTO public.organizations(id, name, slug)
  VALUES (v_org, 'Label HTTP consumer fixture', 'label-http-' || v_org);
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (v_actor, v_org, 'label-http-' || v_actor || '@example.test', 'Label HTTP fixture', 'ops_admin', 'active', 'tenant', NULL);
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_actor);
  INSERT INTO public.rbac_user_role_assignments(organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_actor, r.id, v_actor, '{"source":"pgtap"}'::jsonb
  FROM public.rbac_roles r WHERE r.organization_id = v_org AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;
  INSERT INTO public.workflow_templates(id, name, description, version, status, scope_type, scope_id)
  VALUES (v_template, 'label_http_' || v_template, 'Rollback-only HTTP fixture', 1, 'active', 'tenant', v_org);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  RETURN NEXT ok(public.user_has_capability_v1('workflow_runs.read',
    public.current_user_scope_type(), public.current_user_scope_id()),
    'UI fixture has the actual scoped workflow-read capability');

  FOR v_lane IN SELECT unnest(ARRAY['execute_async', 'bundle_async']) LOOP
    v_template_step := gen_random_uuid();
    v_sequence := v_sequence + 1;
    INSERT INTO public.workflow_template_steps(id, workflow_template_id, sequence_order,
      operation_name, operation_settings_category, transition_condition, metadata,
      handler_key, handler_version, enabled)
    VALUES (v_template_step, v_template, v_sequence, 'execute_label_print', 'workflow', 'always', '{}',
      CASE WHEN v_lane = 'execute_async' THEN 'label_print_execute' ELSE 'label_bundle' END, 'v1', true);
    FOR v_case IN SELECT * FROM pg_temp.label_http_cases LOOP
      TRUNCATE pg_temp.label_http_calls;
      PERFORM set_config('label_http.response', v_case.envelope::text, true);
      v_run_id := gen_random_uuid();
      v_step_id := gen_random_uuid();
      v_label := 'ui/' || v_lane || '/' || v_case.name;
      v_context := jsonb_build_object('organization_id', v_org, 'label_print',
        jsonb_build_object(v_lane, jsonb_build_object('request_id', 16701)));
      PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
      INSERT INTO public.workflow_runs(id, workflow_template_id, workflow_template_version,
        entry_point, workflow_status, context, metadata)
      VALUES (v_run_id, v_template, 1, 'test', 'in_progress', v_context, '{}');
      INSERT INTO public.workflow_run_steps(id, workflow_run_id, workflow_template_step_id,
        sequence_order, step_status, operation_name, max_retries, metadata,
        handler_key, handler_version, enqueued_at)
      VALUES (v_step_id, v_run_id, v_template_step, v_sequence, 'pending', 'execute_label_print', 7, '{}',
        CASE WHEN v_lane = 'execute_async' THEN 'label_print_execute' ELSE 'label_bundle' END, 'v1', now());
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_result := public.ui_get_workflow_run_output_status_v1(v_run_id, NULL);
      EXECUTE 'SET LOCAL ROLE postgres';
      SELECT count(*) INTO v_count FROM pg_temp.label_http_calls WHERE kind = 'callback';
      RETURN NEXT is(v_count, CASE WHEN (v_case.envelope->>'completed')::boolean THEN 1 ELSE 0 END,
        v_label || ' only reconciles completed transport');
      IF (v_case.envelope->>'completed')::boolean THEN
        SELECT payload INTO STRICT v_payload FROM pg_temp.label_http_calls WHERE kind = 'callback';
        RETURN NEXT is(v_payload->>'status', CASE WHEN v_case.failed THEN 'failed' ELSE 'completed' END,
          v_label || ' callback distinguishes HTTP failure');
        v_payload := v_payload->CASE WHEN v_lane = 'execute_async' THEN 'execute' ELSE 'bundle' END;
        IF COALESCE((v_case.envelope->>'status')::int, 0) NOT BETWEEN 200 AND 299 THEN
          RETURN NEXT is(v_payload, jsonb_build_object('status', 'failed',
            'error', 'label_print_execute_http_error',
            'http_status', COALESCE((v_case.envelope->>'status')::int, 0)),
            v_label || ' callback has only safe HTTP failure fields');
          RETURN NEXT ok(v_result::text NOT LIKE '%provider-private%', v_label || ' UI does not expose provider body');
        ELSE
          RETURN NEXT is(v_payload, v_case.envelope->'body', v_label || ' 2xx renderer body preserved');
        END IF;
      END IF;
      SELECT count(*) INTO v_count FROM pg_temp.label_http_calls WHERE kind = 'dispatch';
      RETURN NEXT is(v_count, 0, v_label || ' UI never redispatches');
    END LOOP;
  END LOOP;
END;
$test$;
SELECT * FROM pg_temp.label_http_consumer_cases();
SELECT * FROM finish();
ROLLBACK;

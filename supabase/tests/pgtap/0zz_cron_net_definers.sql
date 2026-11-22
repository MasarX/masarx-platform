BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(32);

SELECT is(has_function_privilege(role_name, signature, 'EXECUTE'),
          role_name = 'service_role' AND service_polling,
          format('%s execute privilege on %s', role_name, signature))
FROM (VALUES
  ('public.ops_sweeper_ensure_cron_jobs(jsonb)', false),
  ('public.check_async_response(bigint)', true),
  ('public.ops_sweeper_label_renderer_cron_guard(jsonb)', false),
  ('public.update_cron_config(text)', false),
  ('public.run_ops_sweeper_worker()', false),
  ('public.run_edge_api_caller_worker()', false)
) AS routines(signature, service_polling)
CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name);

SET LOCAL ROLE postgres;

SELECT ok(EXISTS (
  SELECT 1 FROM cron.job j
  WHERE j.jobname = tick.jobname AND j.command = tick.command
    AND j.username = current_user
    AND has_function_privilege(j.username, tick.signature, 'EXECUTE')
    AND has_function_privilege(j.username, 'public.update_cron_config(text)', 'EXECUTE')
), tick.jobname || ' keeps its command and scheduler role privileges')
FROM (VALUES
  ('ops_sweeper_tick', 'SELECT public.run_ops_sweeper_worker();', 'public.run_ops_sweeper_worker()'),
  ('api_caller_batch_tick', 'SELECT public.run_edge_api_caller_worker();', 'public.run_edge_api_caller_worker()'),
  ('workflow_engine_tick', 'CALL public.run_workflow_engine_worker_batch_v1();', 'public.run_workflow_engine_worker_batch_v1()')
) AS tick(jobname, command, signature);

UPDATE public.settings
SET cached_value = '{"enabled":true,"tasks":[
  {"task_key":"ensure_cron_jobs","handler_key":"ops_sweeper_ensure_cron_jobs","arguments":{"jobs":[
    {"jobname":"pgtap_sweeper_fixture_tick","worker_name":"cache_cleanup_worker"}
  ]}},
  {"task_key":"label_renderer_cron_guard","handler_key":"ops_sweeper_label_renderer_cron_guard"}
]}'::jsonb
WHERE category = 'ops_sweeper_policy' AND scope_type = 'global' AND scope_id IS NULL;

UPDATE public.settings SET cached_value = jsonb_set(cached_value, '{providers}', '[]'::jsonb)
WHERE category = 'label_provider' AND scope_type = 'global' AND scope_id IS NULL;

UPDATE public.cron_config SET enabled = true, last_run_at = NULL
WHERE worker_name IN ('ops_sweeper_worker', 'edge_api_caller_worker');

WITH tick AS MATERIALIZED (SELECT public.run_ops_sweeper_worker()::jsonb AS result)
SELECT is(result #>> '{results,0,result,created}', '1', 'sweeper dispatches the cron reconciliation handler') FROM tick
UNION ALL
SELECT is(result #>> '{results,1,result,status}', 'disabled', 'sweeper dispatches the label renderer guard') FROM tick;

SELECT ok(EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'pgtap_sweeper_fixture_tick'
    AND command = 'SELECT public.run_cache_cleanup_worker();' AND username = current_user
), 'sweeper registers the fixture job as the scheduler owner');

-- Supply a batch response without invoking the external worker.
CREATE OR REPLACE FUNCTION public.run_api_caller_batch(p_batch integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT '{"status":"fixture"}'::jsonb $$;

SELECT is(public.run_edge_api_caller_worker() #>> '{result,status}', 'fixture',
          'edge caller tick reaches the batch dispatcher under the scheduler role');

SELECT is(last_run_at, now(), worker_name || ' updates its cadence through the shared helper')
FROM public.cron_config WHERE worker_name IN ('ops_sweeper_worker', 'edge_api_caller_worker');

-- Reuse a completed transport fixture across the polling callers.
INSERT INTO net._http_response (id, status_code, headers, content, created)
VALUES (7100031, 502, '{}'::jsonb, '{"status":"failed","error":"fixture_response"}', now());

UPDATE public.settings SET cached_value = jsonb_set(cached_value, '{enabled}', 'false'::jsonb)
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;

CREATE OR REPLACE FUNCTION public.dispatch_api_request_v1(
  p_url text, p_method text DEFAULT 'POST', p_headers jsonb DEFAULT '{}'::jsonb,
  p_body jsonb DEFAULT '{}'::jsonb, p_timeout_seconds integer DEFAULT NULL
)
RETURNS bigint LANGUAGE sql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT 7100031::bigint $$;

SET LOCAL ROLE service_role;
SELECT is(public.check_async_response(7100031) #>> '{body,error}', 'fixture_response',
          'service role reads the completed response');
SELECT is(public.call_api_wait('https://example.test/fixture', 'POST', '{}', '{}', 1, 1) ->> 'status', '502',
          'blocking API wrapper reads the completed response');
SET LOCAL ROLE postgres;

CREATE FUNCTION pg_temp.check_workflow_polling()
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_template uuid := gen_random_uuid();
  v_label uuid := gen_random_uuid();
  v_run public.workflow_runs;
  v_step public.workflow_run_steps;
  v_print_status text;
  v_bundle_error text;
  v_ui_result jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Workflow polling fixture', 'workflow-polling-' || v_org);
  v_run.id := gen_random_uuid();
  v_run.metadata := '{}'::jsonb;
  v_step.id := gen_random_uuid();
  v_step.retry_attempt := 2;
  v_step.max_retries := 7;

  v_run.context := jsonb_build_object('organization_id', v_org, 'label_print', jsonb_build_object(
    'organization_id', v_org, 'policy', '{}'::jsonb,
    'targets', jsonb_build_array(jsonb_build_object('shipment_id', gen_random_uuid())),
    'execute_async', '{"request_id":7100031}'::jsonb));
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SET LOCAL ROLE service_role;
  v_print_status := (workflow_handlers.execute_label_print_execute_v1(v_step, v_run)).operation_result #>> '{execute,http_status}';
  v_run.context := jsonb_build_object('label_print', jsonb_build_object(
    'organization_id', v_org, 'policy', '{"default_expires_seconds":60,"max_labels_per_bundle":10}'::jsonb,
    'fresh_generation_required', true, 'fresh_resolve_mode', 'workflow_scope_only',
    'ready', jsonb_build_array(jsonb_build_object('label_id', v_label, 'file_url', 'https://example.test/label.pdf')),
    'bundle_async', jsonb_build_object('request_id', 7100031,
      'request_payload', jsonb_build_object('bundle', jsonb_build_object('label_ids', jsonb_build_array(v_label))))));
  v_bundle_error := (workflow_handlers.execute_label_bundle_v1(v_step, v_run)).last_error;
  SET LOCAL ROLE postgres;
  RETURN NEXT is(v_print_status, '502', 'service workflow print handler settles its transport response');
  RETURN NEXT is(v_bundle_error, 'fixture_response', 'service workflow bundle handler settles its transport response');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (v_actor, v_org, 'workflow-polling-' || v_actor || '@example.test', 'Workflow polling fixture', 'ops_admin', 'active', 'tenant', NULL);
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_actor);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_actor, id, v_actor, '{"source":"pgtap"}'::jsonb
  FROM public.rbac_roles WHERE organization_id = v_org AND key = 'ops_admin' ON CONFLICT DO NOTHING;
  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type, scope_id)
  VALUES (v_template, 'workflow_polling_' || v_template, 'Workflow polling fixture', 1, 'active', 'tenant', v_org);
  PERFORM set_config('app.workflow_run_id', v_run.id::text, true);
  INSERT INTO public.workflow_runs (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, metadata)
  VALUES (v_run.id, v_template, 1, 'test', 'in_progress', jsonb_build_object('organization_id', v_org,
    'label_print', '{"execute_async":{"request_id":7100031},"bundle_async":{"request_id":7100031}}'::jsonb), '{}'::jsonb);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  SET LOCAL ROLE authenticated;
  v_ui_result := api.ui_get_workflow_run_output_status_v1(v_run.id, NULL);
  SET LOCAL ROLE postgres;
  RETURN NEXT ok(v_ui_result @> '{"print_async_completed":true,"bundle_async_completed":true}'::jsonb,
    'authenticated workflow output RPC reads scoped transport completion');
END;
$$;

SELECT * FROM pg_temp.check_workflow_polling();
SELECT * FROM finish();
ROLLBACK;

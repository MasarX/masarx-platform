BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT ok(EXISTS (
  SELECT 1 FROM cron.job j
  JOIN pg_proc p ON p.oid = 'public.run_outbound_wake_sweep_v1()'::regprocedure
  WHERE j.jobname = 'outbound_wake_sweep' AND j.active AND j.schedule = '* * * * *'
    AND j.command = 'SELECT public.run_outbound_wake_sweep_v1();' AND j.username = pg_get_userbyid(p.proowner)
), 'the existing sweep keeps its cadence and calls the owner-only helper');
SELECT ok(NOT EXISTS (
  SELECT FROM (VALUES ('anon'), ('authenticated'), ('service_role')) r(role_name)
  WHERE has_function_privilege(role_name, 'public.run_outbound_wake_sweep_v1()', 'EXECUTE')
     OR has_function_privilege(role_name, 'public.outbound_wake_relay_state_v1()', 'EXECUTE')
), 'API roles cannot invoke the sweep or inspect raw relay policy');

CREATE TEMP TABLE wake_fixture AS SELECT
  gen_random_uuid() AS org, gen_random_uuid() AS template, gen_random_uuid() AS template_step,
  gen_random_uuid() AS run, gen_random_uuid() AS run_step, gen_random_uuid() AS job,
  'https://' || gen_random_uuid() || '.' || 'invalid' AS origin;
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Outbound wake test', 'outbound-wake-test-' || org FROM wake_fixture;
INSERT INTO public.workflow_templates (id, name, version, status, scope_type, scope_id)
SELECT template, 'outbound_wake_' || template, 1, 'active', 'tenant', org FROM wake_fixture;
INSERT INTO public.workflow_template_steps
  (id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version)
SELECT template_step, template, 1, 'outbound_http', 'always', 'outbound_http', 'v1' FROM wake_fixture;
INSERT INTO public.workflow_runs
  (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context)
SELECT run, template, 1, 'test', 'pending', jsonb_build_object('organization_id', org) FROM wake_fixture;
INSERT INTO public.workflow_run_steps
  (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, handler_key, handler_version, max_retries)
SELECT run_step, run, template_step, 1, 'pending', 'outbound_http', 'outbound_http', 'v1', 1 FROM wake_fixture;
DO $$ BEGIN
  PERFORM set_config('app.workflow_run_id', run::text, true),
          set_config('app.workflow_run_step_id', run_step::text, true),
          set_config('masarx.workflow_run_step_id', run_step::text, true),
          set_config('masarx.workflow_engine', '1', true)
  FROM wake_fixture;
END $$;
INSERT INTO public.outbound_calls (id, call_type, target_type, target_id, method, url, status, context, workflow_run_step_id)
SELECT job, 'provider_api', 'provider', gen_random_uuid(), 'POST', origin || '/fixture', 'pending_edge',
       jsonb_build_object('organization_id', org), run_step FROM wake_fixture;

DO $$ BEGIN
  PERFORM public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
    jsonb_build_object('endpoint_url', origin || '/functions/v1/api-caller', 'enabled', true), 1, 'wake fixture')
  FROM wake_fixture;
  PERFORM public.run_outbound_wake_sweep_v1();
END $$;

SELECT is(count(*), 1::bigint, 'matching policy queues one credential-free wake')
FROM net.http_request_queue q CROSS JOIN wake_fixture f
WHERE q.url = f.origin || '/functions/v1/outbound-wake' AND q.method = 'POST'
  AND q.headers - 'Content-Type' - 'content-type' = '{}'::jsonb AND convert_from(q.body, 'UTF8')::jsonb = '{}'::jsonb;
SELECT is(count(*), 0::bigint, 'matching policy emits no blocked signal')
FROM public.ops_alerts WHERE alert_type = 'outbound_wake_relay_blocked';

UPDATE public.settings s SET cached_value = jsonb_set(s.cached_value, '{endpoint_url}', to_jsonb(f.origin || '/other'))
FROM wake_fixture f WHERE s.category = 'edge_dispatch_policy' AND s.scope_type = 'global' AND s.scope_id IS NULL;
SELECT ok(NOT endpoint_matches AND blocked_with_pending_work, 'mismatched policy is blocked before the next sweep')
FROM public.outbound_wake_relay_state_v1();

DO $$ BEGIN
  PERFORM public.run_outbound_wake_sweep_v1();
  UPDATE public.settings SET cached_value = cached_value - 'endpoint_url'
  WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
  PERFORM public.run_outbound_wake_sweep_v1();
END $$;
SELECT ok(endpoint IS NULL AND NOT endpoint_matches AND blocked_with_pending_work, 'missing policy is blocked as well')
FROM public.outbound_wake_relay_state_v1();
SELECT is(count(*), 1::bigint, 'blocked sweeps queue zero additional requests')
FROM net.http_request_queue q CROSS JOIN wake_fixture f WHERE starts_with(q.url, f.origin);
SELECT is(count(*), 1::bigint, 'blocked sweeps emit one fixed-code signal for the minute')
FROM public.ops_alerts WHERE alert_type = 'outbound_wake_relay_blocked'
  AND organization_id = public.marketplace_system_org_id_v1() AND message = alert_type AND details IS NULL;

SELECT * FROM finish();
ROLLBACK;

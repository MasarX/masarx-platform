BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(31);

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
  gen_random_uuid() AS org, gen_random_uuid() AS provider, gen_random_uuid() AS template, gen_random_uuid() AS template_step,
  gen_random_uuid() AS run, gen_random_uuid() AS run_step, gen_random_uuid() AS job,
  'https://' || gen_random_uuid() || '.' || 'invalid' AS origin;
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Outbound wake test', 'outbound-wake-test-' || org FROM wake_fixture;
INSERT INTO public.providers (id, organization_id, name, provider_type)
SELECT provider, org, 'Outbound wake test provider', 'http' FROM wake_fixture;
INSERT INTO public.workflow_templates (id, name, version, status, scope_type, scope_id)
SELECT template, 'outbound_wake_' || template, 1, 'active', 'tenant', org FROM wake_fixture;
INSERT INTO public.workflow_template_steps
  (id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version)
SELECT template_step, template, 1, 'outbound_http', 'always', 'outbound_http', 'v1' FROM wake_fixture;
DO $$ BEGIN
  PERFORM set_config('app.workflow_run_id', run::text, true),
          set_config('app.workflow_run_step_id', run_step::text, true),
          set_config('masarx.workflow_run_step_id', run_step::text, true),
          set_config('masarx.workflow_engine', '1', true)
  FROM wake_fixture;
END $$;
INSERT INTO public.workflow_runs
  (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context)
SELECT run, template, 1, 'test', 'pending', jsonb_build_object('organization_id', org) FROM wake_fixture;
INSERT INTO public.workflow_run_steps
  (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, handler_key, handler_version, max_retries)
SELECT run_step, run, template_step, 1, 'pending', 'outbound_http', 'outbound_http', 'v1', 1 FROM wake_fixture;
INSERT INTO public.outbound_calls (id, call_type, target_type, target_id, method, url, status, context, workflow_run_step_id)
SELECT job, 'provider_api', 'provider', provider, 'POST', origin || '/fixture', 'pending_edge',
       jsonb_build_object('organization_id', org), run_step FROM wake_fixture;

-- Readiness checks the legacy credential column. Use a generated marker in this rollback-only fixture.
INSERT INTO public.provider_auth_configs (provider_id, auth_type, credentials)
SELECT id, 'shared_secret', jsonb_build_object('shared_secret', gen_random_uuid()::text)
FROM public.providers WHERE name = 'edge_api_caller' LIMIT 1;

UPDATE public.outbound_calls SET scheduled_at = now() + interval '1 day'
WHERE id <> (SELECT job FROM wake_fixture) AND status IN ('pending', 'pending_edge', 'failed')
  AND (scheduled_at <= now() OR scheduled_at IS NULL);

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
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.claim_pending_jobs(1) c WHERE c.job_id = f.job
), 'explicitly enabled Edge dispatch keeps the due pending_edge job off the SQL claim')
FROM wake_fixture f;

UPDATE public.settings s SET cached_value = jsonb_set(s.cached_value, '{endpoint_url}', to_jsonb(f.origin || '/other'))
FROM wake_fixture f WHERE s.category = 'edge_dispatch_policy' AND s.scope_type = 'global' AND s.scope_id IS NULL;
UPDATE public.outbound_calls SET scheduled_at = now() + interval '1 day'
WHERE id = (SELECT job FROM wake_fixture);
SELECT ok(NOT endpoint_matches AND NOT blocked_with_pending_work, 'future-scheduled work does not block the readout')
FROM public.outbound_wake_relay_state_v1();

UPDATE public.outbound_calls SET scheduled_at = now() WHERE id = (SELECT job FROM wake_fixture);
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

-- Stub only the network transport so the real claim and worker can run without sending HTTP.
CREATE TEMP TABLE wake_sql_transports (url text);
CREATE OR REPLACE FUNCTION public.dispatch_api_request_v1(
  p_url text, p_method text DEFAULT 'POST', p_headers jsonb DEFAULT '{}'::jsonb,
  p_body jsonb DEFAULT '{}'::jsonb, p_timeout_seconds integer DEFAULT NULL
) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO public, extensions, pg_temp
AS $mock$
  INSERT INTO pg_temp.wake_sql_transports VALUES (p_url);
  SELECT -1::bigint
$mock$;

CREATE FUNCTION pg_temp.check_edge_dispatch_disabled(p_case text)
RETURNS SETOF text LANGUAGE plpgsql AS $test$
DECLARE
  v_fixture pg_temp.wake_fixture%ROWTYPE;
  v_minute CONSTANT timestamptz := date_trunc('minute', statement_timestamp(), 'UTC');
  v_result jsonb;
  v_transport_count bigint;
  v_net_count bigint;
BEGIN
  SELECT * INTO STRICT v_fixture FROM pg_temp.wake_fixture;
  RETURN NEXT is(public.resolve_edge_dispatch_enabled_v1(), false, p_case || ': resolver defaults to disabled');

  UPDATE public.outbound_calls
  SET status = 'pending_edge', scheduled_at = now(), lease_expires_at = NULL
  WHERE id = v_fixture.job;
  RETURN NEXT ok(NOT EXISTS (
    SELECT 1 FROM public.claim_pending_jobs(1) WHERE job_id = v_fixture.job
  ), p_case || ': SQL claim leaves the due pending_edge job for Edge');

  -- A previous case may have raised the same alarm in this minute.
  DELETE FROM public.ops_alerts
  WHERE organization_id = public.marketplace_system_org_id_v1()
    AND created_at = v_minute AND alert_type = 'outbound_wake_relay_blocked';
  PERFORM public.run_outbound_wake_sweep_v1();
  PERFORM public.run_outbound_wake_sweep_v1();
  RETURN NEXT is((
    SELECT count(*) FROM public.ops_alerts
    WHERE organization_id = public.marketplace_system_org_id_v1()
      AND created_at = v_minute AND alert_type = 'outbound_wake_relay_blocked'
  ), 1::bigint, p_case || ': due pending_edge work emits one blocked relay alarm per minute');

  RETURN NEXT ok(EXISTS (
    SELECT 1 FROM public.claim_pending_edge_job_ids_v1(1)
    WHERE job_id = v_fixture.job AND lease_token IS NOT NULL
  ), p_case || ': Edge claims the exact due pending_edge job with a lease');

  v_result := public.call_api(v_fixture.origin, p_timeout_seconds => 1);
  RETURN NEXT ok(NOT (v_result ? 'edge_dispatch') AND v_result->>'request_id' = '-1',
                 p_case || ': call_api uses the SQL transport');
  v_result := public.call_api_wait(v_fixture.origin, p_timeout_seconds => 1, p_wait_seconds => 1);
  RETURN NEXT ok(NOT (v_result ? 'edge_dispatch') AND v_result->>'request_id' = '-1',
                 p_case || ': call_api_wait uses the SQL transport');

  UPDATE public.outbound_calls
  SET status = 'pending', scheduled_at = now(), lease_expires_at = NULL,
      context = context - 'async_request_id' - 'edge_dispatch'
  WHERE id = v_fixture.job;
  PERFORM set_config('app.force_worker', 'outbound_worker', true);
  SELECT count(*) INTO v_transport_count FROM pg_temp.wake_sql_transports;
  SELECT count(*) INTO v_net_count FROM net.http_request_queue;
  DELETE FROM public.ops_alerts
  WHERE organization_id = public.marketplace_system_org_id_v1()
    AND created_at = v_minute AND alert_type = 'outbound_wake_relay_blocked';
  PERFORM public.run_outbound_worker();
  PERFORM public.run_outbound_wake_sweep_v1();
  RETURN NEXT ok(EXISTS (
    SELECT 1 FROM public.outbound_calls WHERE id = v_fixture.job AND status = 'pending_edge' AND lease_expires_at IS NULL
      AND (context ? 'edge_dispatch') AND NOT (context ? 'async_request_id')
  ) AND (SELECT count(*) FROM pg_temp.wake_sql_transports) = v_transport_count
    AND (SELECT count(*) FROM net.http_request_queue) = v_net_count
    AND (SELECT count(*) FROM public.ops_alerts
      WHERE organization_id = public.marketplace_system_org_id_v1() AND created_at = v_minute
        AND alert_type = 'outbound_wake_relay_blocked') = 1,
    p_case || ': the worker queues for Edge and a blocked sweep raises one signal without SQL transport');
END;
$test$;

DELETE FROM public.settings WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
SELECT * FROM pg_temp.check_edge_dispatch_disabled('missing policy row');

DO $$ BEGIN
  PERFORM public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
    jsonb_build_object('endpoint_url', origin || '/functions/v1/api-caller'), 1, 'wake fixture without enabled')
  FROM wake_fixture;
END $$;
SELECT * FROM pg_temp.check_edge_dispatch_disabled('missing enabled key');

UPDATE public.settings SET cached_value = cached_value || jsonb_build_object('enabled', 'maybe')
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
SELECT * FROM pg_temp.check_edge_dispatch_disabled('malformed enabled value');

SELECT * FROM finish();
ROLLBACK;

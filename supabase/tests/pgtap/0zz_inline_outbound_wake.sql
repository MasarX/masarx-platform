BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(27);

CREATE TEMP TABLE inline_wake_fixture AS SELECT
  gen_random_uuid() AS org, gen_random_uuid() AS provider,
  'https://' || gen_random_uuid() || '.' || 'invalid' AS origin,
  jsonb_build_object('timeout_seconds', 1, 'poll_max_seconds', 0, 'poll_interval_ms', 50,
    'pending_reschedule_seconds', 30, 'lease_seconds', 30) AS options;
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Inline wake fixture', 'inline-wake-' || org FROM inline_wake_fixture;
INSERT INTO public.providers (id, organization_id, name, provider_type)
SELECT provider, org, 'Inline wake fixture provider', 'http' FROM inline_wake_fixture;

CREATE TEMP TABLE inline_wake_jobs AS
SELECT lane, gen_random_uuid() AS job
FROM (VALUES ('first'), ('within'), ('after'), ('disabled'), ('invalid'), ('failure'),
  ('reply-first'), ('reply-within'), ('reply-disabled'), ('reply-invalid'), ('reply-failure')) AS lanes(lane);
INSERT INTO public.outbound_calls
  (id, call_type, target_type, target_id, method, url, status, scheduled_at, context)
SELECT job, 'provider_api', 'provider', provider, 'POST', origin || '/' || job, 'pending', now(),
  jsonb_build_object('organization_id', org)
FROM inline_wake_jobs CROSS JOIN inline_wake_fixture;
SELECT public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
  jsonb_build_object('enabled', true, 'endpoint_url', origin || '/functions/v1/api-caller/'),
  1, 'Inline wake fixture') FROM inline_wake_fixture;
UPDATE public.cron_config SET enabled = true, last_run_at = clock_timestamp(),
  inline_wake_not_before = NULL, inline_wake_pending = false
WHERE worker_name = 'outbound_wake_relay';

CREATE FUNCTION pg_temp.inline_wake_dispatch(p_lane text)
RETURNS jsonb LANGUAGE sql AS $fixture$
  SELECT public.dispatch_outbound_call_inline(job, options)
  FROM pg_temp.inline_wake_jobs CROSS JOIN pg_temp.inline_wake_fixture WHERE lane = p_lane;
$fixture$;

CREATE FUNCTION pg_temp.inline_wake_queue_count()
RETURNS bigint LANGUAGE sql AS $fixture$
  SELECT count(*) FROM net.http_request_queue q CROSS JOIN pg_temp.inline_wake_fixture f
  WHERE starts_with(q.url, f.origin);
$fixture$;

SELECT is(pg_temp.inline_wake_dispatch(lane),
  jsonb_build_object('status', 'pending', 'job_id', job, 'http_status', 202, 'completed', false),
  'inline wake preserves the successful handoff envelope') FROM inline_wake_jobs WHERE lane = 'first';
SELECT is(pg_temp.inline_wake_queue_count(), 1::bigint, 'first inline handoff queues exactly one request');
SELECT ok(EXISTS (
  SELECT 1 FROM net.http_request_queue q CROSS JOIN inline_wake_fixture f
  WHERE q.url = f.origin || '/functions/v1/outbound-wake?inline=1' AND q.method = 'POST'
    AND q.headers - 'Content-Type' - 'content-type' = '{}'::jsonb
    AND convert_from(q.body, 'UTF8')::jsonb = '{}'::jsonb
), 'inline producer sends only the fixed signal and empty wake envelope');

SELECT is(api.try_start_outbound_wake_v1(), false, 'inline fixture holds the ordinary sweep slot');
WITH admission AS MATERIALIZED (SELECT api.try_start_inline_outbound_wake_v1() AS wait_ms)
SELECT ok((wait_ms BETWEEN 0 AND 2000) IS TRUE,
  'a producer reservation has its own admission and coalescing deadline') FROM admission;
SELECT is(api.try_start_inline_outbound_wake_v1(), NULL::integer, 'the inline admission slot cannot be spent twice');
SELECT ok(has_function_privilege('edge_api_caller_role', 'api.try_start_inline_outbound_wake_v1()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.try_start_inline_outbound_wake_v1()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'api.try_start_inline_outbound_wake_v1()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.post_outbound_wake_v1(text,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.try_post_inline_outbound_wake_v1()', 'EXECUTE')
  AND NOT has_function_privilege('edge_api_caller_role', 'public.try_post_inline_outbound_wake_v1()', 'EXECUTE'),
  'inline wake transport remains owner-only and admission is denied to browser roles');

DO $$ BEGIN
  -- Set the age without relying on the test runner's wall time or sleeping.
  UPDATE public.cron_config SET inline_wake_not_before = clock_timestamp() + interval '2 seconds'
  WHERE worker_name = 'outbound_wake_relay';
  PERFORM pg_temp.inline_wake_dispatch('within');
END $$;
SELECT is(pg_temp.inline_wake_queue_count(), 1::bigint, 'a second inline handoff inside the window queues no extra signal');

UPDATE public.cron_config SET inline_wake_not_before = clock_timestamp() - interval '1 second'
WHERE worker_name = 'outbound_wake_relay';
DO $$ BEGIN PERFORM pg_temp.inline_wake_dispatch('after'); END $$;
SELECT is(pg_temp.inline_wake_queue_count(), 2::bigint, 'an inline handoff after the window can queue a new signal');

UPDATE public.settings SET cached_value = jsonb_set(cached_value, '{enabled}', 'false')
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
SELECT is(api.try_start_inline_outbound_wake_v1(), NULL::integer, 'disabling dispatch also closes an already reserved inline admission');
UPDATE public.cron_config SET inline_wake_not_before = NULL
WHERE worker_name = 'outbound_wake_relay';
DO $$ BEGIN PERFORM pg_temp.inline_wake_dispatch('disabled'); END $$;
SELECT is(pg_temp.inline_wake_queue_count(), 2::bigint, 'an inline handoff with dispatch disabled sends no signal');

UPDATE public.settings s SET cached_value = s.cached_value || jsonb_build_object('enabled', true, 'endpoint_url', f.origin || '/other')
FROM inline_wake_fixture f WHERE s.category = 'edge_dispatch_policy' AND s.scope_type = 'global' AND s.scope_id IS NULL;
DO $$ BEGIN PERFORM pg_temp.inline_wake_dispatch('invalid'); END $$;
SELECT is(pg_temp.inline_wake_queue_count(), 2::bigint, 'an inline handoff with a mismatched endpoint sends no signal');

UPDATE public.settings s SET cached_value = jsonb_set(s.cached_value, '{endpoint_url}', to_jsonb(f.origin || '/functions/v1/api-caller'))
FROM inline_wake_fixture f WHERE s.category = 'edge_dispatch_policy' AND s.scope_type = 'global' AND s.scope_id IS NULL;

-- Supply an already queued job from the core while exercising the real reply dispatch wrapper.
CREATE OR REPLACE FUNCTION public.send_comms_reply_core(
  p_webhook_id uuid, p_webhook_source_id uuid, p_comm jsonb, p_organization_id uuid
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO public, extensions, pg_temp AS $fixture$
  SELECT jsonb_build_object('queued', true, 'outbound_call_id', p_webhook_id);
$fixture$;

SELECT public.upsert_settings_value_v1('comms_reply_policy', 'global', NULL,
  '{"enabled":true,"dispatch":{"mode":"edge","timeout_seconds":10}}'::jsonb,
  1, 'Inline wake fixture');

CREATE FUNCTION pg_temp.inline_wake_reply_handed_off(p_lane text)
RETURNS boolean LANGUAGE plpgsql AS $fixture$
DECLARE
  v_job uuid;
  v_org uuid;
  v_result jsonb;
BEGIN
  SELECT job, org INTO STRICT v_job, v_org
  FROM pg_temp.inline_wake_jobs CROSS JOIN pg_temp.inline_wake_fixture WHERE lane = p_lane;
  v_result := public.send_comms_reply(v_job, NULL, '{}'::jsonb, v_org);
  RETURN v_result IS NOT DISTINCT FROM jsonb_build_object(
    'queued', true, 'outbound_call_id', v_job, 'dispatch_mode', 'edge',
    'dispatch', jsonb_build_object('status', 'queued', 'mode', 'edge', 'timeout_seconds', 10)
  ) AND EXISTS (SELECT 1 FROM public.outbound_calls WHERE id = v_job AND status = 'pending_edge');
END;
$fixture$;

UPDATE public.cron_config SET inline_wake_not_before = NULL, inline_wake_pending = false
WHERE worker_name = 'outbound_wake_relay';
SELECT ok(pg_temp.inline_wake_reply_handed_off('reply-first'), 'edge-mode reply preserves its result and hands off the job');
SELECT is((SELECT count(*) FROM net.http_request_queue q CROSS JOIN inline_wake_fixture f
  WHERE q.url = f.origin || '/functions/v1/outbound-wake?inline=1'),
  3::bigint, 'first edge-mode reply queues exactly one wake');

UPDATE public.cron_config SET inline_wake_not_before = clock_timestamp() + interval '2 seconds'
WHERE worker_name = 'outbound_wake_relay' AND inline_wake_not_before IS NOT NULL;
SELECT ok(pg_temp.inline_wake_reply_handed_off('reply-within'), 'a coalesced edge-mode reply still hands off its job');
SELECT is(pg_temp.inline_wake_queue_count(), 3::bigint, 'a second edge-mode reply inside the window queues no extra wake');

UPDATE public.cron_config SET inline_wake_not_before = NULL WHERE worker_name = 'outbound_wake_relay';
UPDATE public.settings SET cached_value = jsonb_set(cached_value, '{enabled}', 'false')
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
SELECT ok(pg_temp.inline_wake_reply_handed_off('reply-disabled'), 'edge-mode reply hands off its job with Edge dispatch disabled');
SELECT is(pg_temp.inline_wake_queue_count(), 3::bigint, 'an edge-mode reply with dispatch disabled queues no wake');

UPDATE public.settings s SET cached_value = s.cached_value || jsonb_build_object('enabled', true, 'endpoint_url', f.origin || '/other')
FROM inline_wake_fixture f WHERE s.category = 'edge_dispatch_policy' AND s.scope_type = 'global' AND s.scope_id IS NULL;
SELECT ok(pg_temp.inline_wake_reply_handed_off('reply-invalid'), 'edge-mode reply hands off its job with a mismatched endpoint');
SELECT is(pg_temp.inline_wake_queue_count(), 3::bigint, 'an edge-mode reply with a mismatched endpoint queues no wake');

UPDATE public.settings s SET cached_value = jsonb_set(s.cached_value, '{endpoint_url}', to_jsonb(f.origin || '/functions/v1/api-caller'))
FROM inline_wake_fixture f WHERE s.category = 'edge_dispatch_policy' AND s.scope_type = 'global' AND s.scope_id IS NULL;
CREATE TEMP SEQUENCE inline_wake_failure_attempt;
CREATE OR REPLACE FUNCTION public.post_outbound_wake_v1(p_endpoint text, p_inline boolean)
RETURNS void LANGUAGE plpgsql AS $fixture$
BEGIN
  PERFORM nextval('pg_temp.inline_wake_failure_attempt');
  RAISE EXCEPTION 'synthetic outbound wake transport failure';
END;
$fixture$;
SELECT is(pg_temp.inline_wake_dispatch(lane),
  jsonb_build_object('status', 'pending', 'job_id', job, 'http_status', 202, 'completed', false),
  'a transport failure preserves the inline handoff envelope') FROM inline_wake_jobs WHERE lane = 'failure';
SELECT ok(is_called, 'the failing inline wake was attempted') FROM pg_temp.inline_wake_failure_attempt;
SELECT ok(o.status = 'pending_edge' AND o.lease_expires_at IS NULL AND o.edge_lease_token IS NULL,
  'wake failure leaves a claimable handoff for the minute sweep')
FROM public.outbound_calls o JOIN inline_wake_jobs j ON j.job = o.id WHERE j.lane = 'failure';
SELECT is(pg_temp.inline_wake_queue_count(), 3::bigint, 'the failed inline wake adds no queued request');
SELECT ok(pg_temp.inline_wake_reply_handed_off('reply-failure'), 'wake failure preserves the edge-mode reply result and handoff');
SELECT is(last_value, 2::bigint, 'the reply also attempted the failing wake') FROM pg_temp.inline_wake_failure_attempt;
SELECT is(pg_temp.inline_wake_queue_count(), 3::bigint, 'the failed reply wake adds no queued request');

SELECT * FROM finish();
ROLLBACK;

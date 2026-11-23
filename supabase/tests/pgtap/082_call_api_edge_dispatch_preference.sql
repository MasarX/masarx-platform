-- Plan: PLAN-202601-demo-speed-here-failfast / Step: S04
-- Purpose: call_api prefers edge dispatch when edge_dispatch_policy is enabled.
BEGIN;
SELECT plan(4);

CREATE TEMP TABLE pgtap_edge_policy_fixture AS
SELECT ('https://' || gen_random_uuid() || '.' || 'invalid') AS origin;
SELECT public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
  jsonb_build_object('enabled', true, 'endpoint_url', origin || '/functions/v1/api-caller'),
  1, 'Synthetic Edge contract fixture')
FROM pgtap_edge_policy_fixture;

CREATE TEMP TABLE pgtap_edge_call_counts AS
SELECT (SELECT count(*) FROM net.http_request_queue) AS transport, (SELECT count(*) FROM public.outbound_calls) AS jobs;
SELECT ok(public.resolve_settings('edge_dispatch_policy', 'global', NULL)
  @> jsonb_build_object('enabled', true, 'endpoint_url', origin || '/functions/v1/api-caller'),
  'the effective Edge policy is explicitly enabled for the exact fixture') FROM pgtap_edge_policy_fixture;

SELECT ok(public.call_api(origin, 'GET', '{"accept":"application/json","x-client-id":"fixture"}', '{}', 1)
  @> jsonb_build_object('status', 202, 'completed', false, 'edge_dispatch', jsonb_build_object(
    'url', origin, 'method', 'GET', 'headers', '{"accept":"application/json","x-client-id":"fixture"}'::jsonb)),
  'call_api returns edge_dispatch with the exact approved credential-free headers when enabled')
FROM pgtap_edge_policy_fixture;

SELECT throws_ok(format('SELECT public.call_api(%L, %L, %L::jsonb, %L::jsonb, 1)',
    origin, 'GET', jsonb_build_object('authorization', gen_random_uuid()::text), '{}'),
  '22023', 'outbound_credential_headers_refused', 'enabled call refuses credential headers before handoff')
FROM pgtap_edge_policy_fixture;
UPDATE public.settings SET cached_value = jsonb_set(cached_value, '{enabled}', 'false')
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
DO $$ BEGIN
  PERFORM public.call_api(origin, 'GET', jsonb_build_object('x-api-key', gen_random_uuid()::text), '{}', 1)
  FROM pg_temp.pgtap_edge_policy_fixture;
  RAISE EXCEPTION 'the disabled fixture accepted a credential header';
EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM <> 'outbound_credential_headers_refused' THEN RAISE; END IF;
END $$;
SELECT ok((SELECT count(*) FROM net.http_request_queue) = transport
  AND (SELECT count(*) FROM public.outbound_calls) = jobs,
  'credential refusal under either policy creates neither a transport request nor a queued job')
FROM pgtap_edge_call_counts;

SELECT * FROM finish();
ROLLBACK;

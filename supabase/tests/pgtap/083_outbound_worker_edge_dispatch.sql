-- Plan: PLAN-202601-demo-speed-here-failfast / Step: S04
-- Purpose: run_outbound_worker marks outbound_calls as pending_edge when call_api returns edge_dispatch.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

CREATE TEMP TABLE pgtap_edge_policy_fixture AS
SELECT ('https://' || gen_random_uuid() || '.' || 'invalid') AS origin;
SELECT public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
  jsonb_build_object('enabled', true, 'endpoint_url', origin || '/functions/v1/api-caller'),
  1, 'Synthetic Edge contract fixture')
FROM pgtap_edge_policy_fixture;

CREATE TEMP TABLE pgtap_edge_worker_fixture AS
SELECT gen_random_uuid() AS org, gen_random_uuid() AS client,
       gen_random_uuid() AS job, (SELECT origin || '/worker' FROM pgtap_edge_policy_fixture) AS url;
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Outbound worker organization', 'outbound-worker-' || org FROM pgtap_edge_worker_fixture;
SELECT set_config('app.organization_onboarding_source', '', true);
INSERT INTO public.clients (id, organization_id, name, slug, status)
SELECT client, org, 'Outbound worker client', 'outbound-client-' || client, 'active'
FROM pgtap_edge_worker_fixture;
SELECT ok(public.resolve_settings('edge_dispatch_policy', 'global', NULL)
  @> jsonb_build_object('enabled', true, 'endpoint_url', origin || '/functions/v1/api-caller'),
  'edge dispatch fixture selects its exact enabled endpoint') FROM pgtap_edge_policy_fixture;
SELECT ok(EXISTS (SELECT FROM public.clients c WHERE c.id = f.client AND c.organization_id = f.org),
  'the Edge dispatch fixture owns its exact client') FROM pgtap_edge_worker_fixture;

SELECT set_config('app.workflow_run_id', 'd8300000-0000-0000-0000-000000000084', true);
SELECT set_config('app.workflow_run_step_id', 'd8300000-0000-0000-0000-000000000085', true);
SELECT set_config('masarx.workflow_engine', '1', true);
SELECT set_config('masarx.workflow_run_step_id', 'd8300000-0000-0000-0000-000000000085', true);
SELECT set_config('app.force_worker', 'outbound_worker', true);

INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'd8300000-0000-0000-0000-000000000083',
  'pgtap_outbound_edge_dispatch',
  'Fixture workflow for outbound edge dispatch test',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
)
VALUES (
  'd8300000-0000-0000-0000-000000000085',
  'd8300000-0000-0000-0000-000000000083',
  1,
  'outbound_http',
  'always',
  'outbound_http',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'd8300000-0000-0000-0000-000000000084',
  'd8300000-0000-0000-0000-000000000083',
  1,
  'test',
  'pending',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'd8300000-0000-0000-0000-000000000085',
  'd8300000-0000-0000-0000-000000000084',
  'd8300000-0000-0000-0000-000000000085',
  1,
  'pending',
  'outbound_http',
  'outbound_http',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbound_calls (
  id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  headers,
  body,
  status,
  priority,
  max_retries,
  scheduled_at,
  workflow_run_step_id
)
SELECT
  job,
  'provider_api',
  'client',
  client,
  'GET',
  url,
  '{"accept":"application/json"}'::jsonb,
  '{}'::jsonb,
  'pending',
  1000000,
  1,
  now() - interval '1 minute',
  'd8300000-0000-0000-0000-000000000085'
FROM pgtap_edge_worker_fixture
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    workflow_run_step_id = EXCLUDED.workflow_run_step_id;

UPDATE public.outbound_calls SET scheduled_at = now() + interval '100 years'
WHERE id <> (SELECT job FROM pgtap_edge_worker_fixture)
  AND status IN ('pending', 'pending_edge', 'failed') AND scheduled_at <= now();
CREATE TEMP TABLE pgtap_edge_worker_baseline AS SELECT count(*) AS total FROM net.http_request_queue;
CREATE TEMP TABLE pgtap_edge_worker_result AS SELECT public.run_outbound_worker() AS result;
SELECT ok(result->>'status' = 'completed' AND result->>'items_processed' = '1'
  AND EXISTS (SELECT FROM public.outbound_calls o WHERE o.id = f.job
    AND o.status = 'pending_edge' AND o.lease_expires_at IS NULL AND o.edge_lease_token IS NULL
    AND o.headers = '{"accept":"application/json"}'::jsonb
    AND o.context->'edge_dispatch' @> '{"method":"GET","headers":{"accept":"application/json"}}'::jsonb
    AND NOT (o.context->'edge_dispatch' ?| ARRAY['url','body','authorization'])
    AND NOT (o.context ? 'async_request_id')),
  'the actual worker hands off exactly its job with safe metadata')
FROM pgtap_edge_worker_result CROSS JOIN pgtap_edge_worker_fixture f;

CREATE TEMP TABLE pgtap_edge_worker_claim AS SELECT * FROM public.claim_pending_edge_job_ids_v1(1);
SELECT ok(
  (SELECT count(*) FROM net.http_request_queue) = (SELECT total FROM pgtap_edge_worker_baseline)
  AND NOT EXISTS (SELECT FROM cron.job WHERE jobname = 'api_caller_batch_tick'
    OR command ~* '\m(run_edge_api_caller_worker|run_api_caller_batch)\M')
  AND (SELECT array_agg(job_id) FROM pgtap_edge_worker_claim WHERE lease_token IS NOT NULL) = ARRAY[f.job]
  AND EXISTS (SELECT FROM pgtap_edge_worker_claim l
    WHERE public.get_claimed_edge_job_call_spec_v1(l.job_id, l.lease_token)
      @> jsonb_build_object('url', f.url, 'method', 'GET', 'headers', '{"accept":"application/json"}'::jsonb)),
  'the exact handoff claims successfully with the tick absent and no pg_net request')
FROM pgtap_edge_worker_fixture f;

SELECT * FROM finish();
ROLLBACK;

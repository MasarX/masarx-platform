BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);
SELECT public.create_next_partitions();

CREATE TEMP TABLE outbound_expiry_fixture AS
SELECT gen_random_uuid() AS org, gen_random_uuid() AS provider, gen_random_uuid() AS credential,
       gen_random_uuid() AS template, gen_random_uuid() AS template_step,
       gen_random_uuid() AS run, gen_random_uuid() AS run_step,
       gen_random_uuid() AS job, gen_random_uuid() AS correlation,
       'https://' || gen_random_uuid() || '.' || 'invalid' || '/dispatch' AS url,
       encode(gen_random_bytes(20), 'hex') AS api_key;

INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Outbound expiry fixture', 'outbound-expiry-' || org FROM outbound_expiry_fixture;
INSERT INTO public.providers (id, organization_id, name, provider_type)
SELECT provider, org, 'Outbound expiry provider', 'http' FROM outbound_expiry_fixture;
INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials, expires_at)
SELECT credential, provider, 'api_key', jsonb_build_object('api_key', api_key), now() - interval '1 minute'
FROM outbound_expiry_fixture;

INSERT INTO public.workflow_templates (id, name, version, status, scope_type, scope_id)
SELECT template, 'outbound_expiry_' || template, 1, 'active', 'tenant', org FROM outbound_expiry_fixture;
INSERT INTO public.workflow_template_steps
  (id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version)
SELECT template_step, template, 1, 'outbound_http', 'always', 'outbound_http', 'v1' FROM outbound_expiry_fixture;
SELECT set_config('app.workflow_run_id', run::text, true),
       set_config('app.workflow_run_step_id', run_step::text, true),
       set_config('masarx.workflow_run_step_id', run_step::text, true),
       set_config('masarx.workflow_engine', '1', true)
FROM outbound_expiry_fixture;
INSERT INTO public.workflow_runs
  (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context)
SELECT run, template, 1, 'test', 'pending', jsonb_build_object('organization_id', org) FROM outbound_expiry_fixture;
INSERT INTO public.workflow_run_steps
  (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, handler_key, handler_version, max_retries)
SELECT run_step, run, template_step, 1, 'pending', 'outbound_http', 'outbound_http', 'v1', 1 FROM outbound_expiry_fixture;

INSERT INTO public.outbound_calls
  (id, call_type, target_type, target_id, method, url, body, status, scheduled_at, retry_count, max_retries,
   correlation_id, workflow_run_step_id, context)
SELECT job, 'provider_api', 'provider', provider, 'POST', url, jsonb_build_object('marker', job),
       'pending_edge', now() - interval '1 second', 0, 1, correlation, run_step,
       jsonb_build_object('organization_id', org, 'auth',
         jsonb_build_object('mode', 'api_key_header', 'header', 'x-api-key', 'auth_config_id', credential))
FROM outbound_expiry_fixture;

CREATE TEMP TABLE outbound_expired_claim AS
SELECT claim.* FROM outbound_expiry_fixture f CROSS JOIN LATERAL public.claim_edge_job_by_id_v1(f.job) claim;

SELECT ok(EXISTS (
  SELECT FROM outbound_expired_claim c JOIN public.outbound_calls o ON o.id = c.job_id
  WHERE c.job_id = f.job AND o.status = 'in_progress_edge'
    AND o.edge_lease_token = c.lease_token AND o.lease_expires_at > now()
), 'the due job is claimed with a live lease') FROM outbound_expiry_fixture f;
SELECT ok(public.get_claimed_edge_job_call_spec_v1(job_id, lease_token) IS NULL,
  'the expired credential yields no dispatch spec') FROM outbound_expired_claim;
SELECT is(o.error_message, 'credential_expired', 'the job records credential expiry')
FROM outbound_expiry_fixture f JOIN public.outbound_calls o ON o.id = f.job;
SELECT ok(o.status = 'pending_edge' AND o.scheduled_at = now() + interval '1 minute'
  AND o.edge_lease_token IS NULL AND o.lease_expires_at IS NULL
  AND o.retry_count = 0 AND o.completed_at IS NULL AND o.response_status_code IS NULL,
  'the job waits one minute with no lease, retry consumed or completion')
FROM outbound_expiry_fixture f JOIN public.outbound_calls o ON o.id = f.job;
SELECT ok(NOT EXISTS (SELECT FROM net.http_request_queue q WHERE q.url = f.url),
  'expiry queues no pg_net request for the job') FROM outbound_expiry_fixture f;
SELECT ok(NOT EXISTS (SELECT FROM public.api_call_log l WHERE l.correlation_id = f.correlation),
  'expiry writes no API call audit for the job') FROM outbound_expiry_fixture f;
SELECT ok(NOT EXISTS (SELECT FROM public.decision_log l WHERE l.resource_id = f.job AND l.decision_point = 'edge_claim_spec'),
  'expiry writes no terminal spec decision for the job') FROM outbound_expiry_fixture f;

UPDATE public.provider_auth_configs SET expires_at = now() + interval '1 day'
WHERE id = (SELECT credential FROM outbound_expiry_fixture);
SELECT throws_ok(format('SELECT * FROM public.claim_edge_job_by_id_v1(%L)', job),
  'P0001', format('claim_edge_job_by_id_v1: outbound call %s is not claimable', job),
  'repair leaves the backoff in effect until the job is due') FROM outbound_expiry_fixture;

-- Simulate reaching the due time within this transaction.
UPDATE public.outbound_calls SET scheduled_at = now()
WHERE id = (SELECT job FROM outbound_expiry_fixture);
CREATE TEMP TABLE outbound_repaired_claim AS
SELECT claim.* FROM outbound_expiry_fixture f CROSS JOIN LATERAL public.claim_edge_job_by_id_v1(f.job) claim;

SELECT ok(EXISTS (
  SELECT FROM outbound_expired_claim e JOIN outbound_repaired_claim r USING (job_id)
  JOIN public.outbound_calls o ON o.id = r.job_id
  WHERE r.job_id = f.job AND r.lease_token <> e.lease_token AND o.edge_lease_token = r.lease_token
    AND o.status = 'in_progress_edge' AND o.lease_expires_at > now()
), 'the repaired job is claimed under a fresh live lease') FROM outbound_expiry_fixture f;
SELECT throws_ok(format('SELECT public.get_claimed_edge_job_call_spec_v1(%L, %L)', job_id, lease_token),
  'P0001', format('get_claimed_edge_job_call_spec_v1: active lease for job %s not found', job_id),
  'the original token is rejected while the fresh lease is active') FROM outbound_expired_claim;
SELECT ok(public.get_claimed_edge_job_call_spec_v1(c.job_id, c.lease_token) @> jsonb_build_object(
  'url', f.url, 'method', 'POST', 'body', jsonb_build_object('marker', f.job),
  'headers', jsonb_build_object('x-api-key', f.api_key)),
  'the fresh token resolves the request with the repaired credential')
FROM outbound_repaired_claim c JOIN outbound_expiry_fixture f ON f.job = c.job_id;

-- The fenced RPC normalizes resolver failures, so check SQLSTATE at the resolver boundary.
UPDATE public.provider_auth_configs
SET credentials = credentials || jsonb_build_object('revoked', 'yes-please'), expires_at = now() - interval '1 minute'
WHERE id = (SELECT credential FROM outbound_expiry_fixture);
SELECT throws_ok(format('SELECT public.get_job_call_spec(%L)', job),
  'P0001', format('get_job_call_spec: credentials_missing (auth_config_id=%s job_id=%s)', credential, job),
  'an expired credential with a malformed revoked marker reports credentials_missing') FROM outbound_expiry_fixture;

SELECT * FROM finish();
ROLLBACK;

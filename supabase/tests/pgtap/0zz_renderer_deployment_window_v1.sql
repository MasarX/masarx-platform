BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT no_plan();

CREATE TEMP TABLE renderer_rollout_fixture AS
SELECT gen_random_uuid() AS org, encode(gen_random_bytes(20), 'hex') AS credential,
       concat('https', '://', 'renderer', '.', 'example', '.', 'test', '/functions/v1/label-renderer') AS endpoint;

INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Renderer rollout fixture', 'renderer-rollout-' || org FROM renderer_rollout_fixture;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.upsert_label_provider_settings_v1('global', NULL, jsonb_build_object('version', 1, 'providers',
  jsonb_build_array(jsonb_build_object('name', 'renderer-rollout-fixture', 'invoke_url', endpoint,
    'invoke_secret', credential))), 'Renderer rollout fixture') FROM renderer_rollout_fixture;

CREATE TEMP TABLE rollout_receipts AS
SELECT 'render' AS kind, public.invoke_label_renderer(1) AS receipt
UNION ALL
SELECT 'print', public.invoke_label_renderer_print_sync_v1(gen_random_uuid(), gen_random_uuid(),
  jsonb_build_object('organization_id', org, 'execute_dispatch_mode', 'sync_wait')) FROM renderer_rollout_fixture;
SELECT ok(receipt @> '{"status":202,"completed":false}'::jsonb AND receipt ? 'edge_job_id',
  kind || ' accepts the request during the deployment window') FROM rollout_receipts;

CREATE TEMP TABLE previous_worker_claims AS
SELECT r.kind, (r.receipt->>'request_id')::bigint AS request_id, claim.*
FROM rollout_receipts r CROSS JOIN LATERAL public.claim_edge_job_by_id_v1((r.receipt->>'edge_job_id')::uuid) claim;
SELECT is((SELECT count(*) FROM previous_worker_claims), 2::bigint, 'previous worker initially claims both queued jobs');

SELECT set_config('request.method', 'POST', true);
SELECT set_config('request.headers', '{}', true);
SELECT is(public.get_claimed_edge_job_call_spec_v1(job_id, lease_token), NULL::jsonb,
  kind || ' gives no dispatch spec to the previous HTTP worker') FROM previous_worker_claims;
SELECT ok(o.status = 'pending_edge' AND o.scheduled_at > now() AND o.completed_at IS NULL
    AND o.edge_lease_token IS NULL AND public.check_async_response(c.request_id)->>'completed' = 'false',
  c.kind || ' retains its original pending request for the upgraded worker')
FROM previous_worker_claims c JOIN public.outbound_calls o ON o.id = c.job_id;
SELECT throws_ok(format('SELECT public.get_claimed_edge_job_call_spec_v1(%L::uuid,%L::uuid)', job_id, lease_token),
  'P0001', format('get_claimed_edge_job_call_spec_v1: active lease for job %s not found', job_id),
  kind || ' refuses to use the released lease again') FROM previous_worker_claims;

-- Advance eligibility without waiting on the wall clock.
UPDATE public.outbound_calls SET scheduled_at = now() WHERE id IN (SELECT job_id FROM previous_worker_claims);
SELECT set_config('request.headers', '{"x-masarx-renderer-transport":"1"}', true);
CREATE TEMP TABLE upgraded_worker_claims AS
SELECT c.kind, c.request_id, c.lease_token AS old_token, claim.*
FROM previous_worker_claims c CROSS JOIN LATERAL public.claim_edge_job_by_id_v1(c.job_id) claim;
SELECT is((SELECT count(*) FROM upgraded_worker_claims), 2::bigint, 'upgraded worker acquires each original job once');
SELECT ok(lease_token IS DISTINCT FROM old_token
    AND public.get_claimed_edge_job_call_spec_v1(job_id, lease_token) ? 'renderer_credential_ref',
  kind || ' uses a new lease with the current renderer protocol') FROM upgraded_worker_claims;
SELECT public.mark_claimed_edge_job_success_v1(job_id, lease_token, 200, '{}'::jsonb, '{"ok":true}'::jsonb, 1)
FROM upgraded_worker_claims;
SELECT ok(public.check_async_response(request_id) @> '{"completed":true,"body":{"ok":true}}'::jsonb,
  kind || ' settles its original receipt after the upgrade') FROM upgraded_worker_claims;
SELECT throws_ok(format('SELECT public.claim_edge_job_by_id_v1(%L::uuid)', job_id),
  'P0001', format('claim_edge_job_by_id_v1: outbound call %s is not claimable', job_id),
  kind || ' cannot be dispatched twice after successful completion') FROM upgraded_worker_claims;

SELECT * FROM finish();
ROLLBACK;

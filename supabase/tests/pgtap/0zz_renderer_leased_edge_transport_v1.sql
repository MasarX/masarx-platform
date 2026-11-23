BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT no_plan();

CREATE TEMP TABLE renderer_transport_case AS
SELECT gen_random_uuid() AS org, encode(gen_random_bytes(20), 'hex') AS credential,
       concat('https', '://', 'renderer', '.', 'example', '.', 'test', '/functions/v1/label-renderer') AS endpoint,
       concat('https', '://', 'example', '.', 'test', '/functions/v1/label-renderer') AS placeholder,
       (SELECT count(*) FROM net.http_request_queue) AS initial_net_rows;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.upsert_label_provider_settings_v1('global', NULL, jsonb_build_object('version', 1, 'providers',
  jsonb_build_array(jsonb_build_object('name', 'renderer-fixture', 'invoke_url', placeholder,
    'invoke_secret', credential))), 'Renderer transport fixture') FROM renderer_transport_case;

SELECT is(public.invoke_label_renderer(1, NULL) #>> '{body,reason}', 'placeholder_url',
  'placeholder returns a stable unavailable state');
SELECT ok(NOT EXISTS (SELECT FROM public.outbound_calls WHERE renderer_request_id IS NOT NULL),
  'placeholder leaves the renderer queue empty');

-- Bind a tenant renderer to a real, generated reference without placing the credential in the job.
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Renderer queue fixture', 'renderer-queue-' || org FROM renderer_transport_case;
SELECT public.upsert_label_provider_settings_v1('global', NULL, jsonb_build_object('version', 1, 'providers',
  jsonb_build_array(jsonb_build_object('name', 'renderer-fixture', 'invoke_url', endpoint,
    'invoke_secret', credential))), 'Renderer transport fixture') FROM renderer_transport_case;

UPDATE public.outbound_calls SET scheduled_at = now() + interval '100 years'
WHERE status IN ('pending', 'pending_edge', 'failed') AND scheduled_at <= now();
CREATE TEMP TABLE renderer_receipts AS
SELECT 'jobs' AS mode, public.invoke_label_renderer(1) AS receipt
UNION ALL
SELECT 'payload' AS mode, public.invoke_label_renderer(1, '{}'::jsonb) AS receipt
UNION ALL
SELECT 'print', public.invoke_label_renderer_print_sync_v1(gen_random_uuid(), gen_random_uuid(),
  jsonb_build_object('organization_id', org)) FROM renderer_transport_case;

SELECT ok(receipt @> '{"status":202,"completed":false}'::jsonb AND receipt ? 'edge_job_id',
  mode || ' returns an async Edge receipt') FROM renderer_receipts;
SELECT ok(o.renderer_credential_ref IS NOT NULL AND o.headers = '{}'::jsonb
        AND position(f.credential IN to_jsonb(o)::text) = 0,
          r.mode || ' retains only the bound credential reference')
FROM renderer_receipts r JOIN public.outbound_calls o ON o.id = (r.receipt->>'edge_job_id')::uuid
CROSS JOIN renderer_transport_case f;

UPDATE public.settings SET cached_value = jsonb_set(cached_value, '{enabled}', 'false'::jsonb)
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
SELECT is((SELECT count(*) FROM public.claim_pending_jobs(10)), 0::bigint,
  'SQL fallback cannot claim a renderer job even when Edge is considered unavailable');
SELECT is((SELECT count(*) FROM public.claim_pending_edge_jobs(10)), 0::bigint,
  'legacy Edge claimant cannot acquire renderer work');

CREATE TEMP TABLE renderer_leases AS
SELECT r.mode, (r.receipt->>'request_id')::bigint AS request_id, claim.*
FROM renderer_receipts r CROSS JOIN LATERAL public.claim_edge_job_by_id_v1((r.receipt->>'edge_job_id')::uuid) claim;
SELECT throws_ok(format('SELECT public.get_claimed_edge_job_call_spec_v1(%L::uuid, %L::uuid)', job_id, gen_random_uuid()),
  'P0001', format('get_claimed_edge_job_call_spec_v1: active lease for job %s not found', job_id),
  mode || ' wrong lease cannot obtain a spec') FROM renderer_leases;
SELECT ok((spec->>'url') = f.endpoint AND spec ? 'renderer_credential_ref'
  AND NOT (spec->'headers' ? 'authorization') AND position(f.credential IN spec::text) = 0,
  mode || ' active lease obtains a pinned, credential-free spec')
FROM renderer_leases l CROSS JOIN renderer_transport_case f
CROSS JOIN LATERAL (SELECT public.get_claimed_edge_job_call_spec_v1(l.job_id, l.lease_token) AS spec) s;

SELECT is(public.check_async_response(request_id)->>'completed', 'false',
  mode || ' readback remains pending during the lease') FROM renderer_leases;
SELECT public.mark_claimed_edge_job_success_v1(job_id, lease_token, 200, '{}'::jsonb, '{"ok":true}'::jsonb, 1)
FROM renderer_leases;
SELECT is(public.check_async_response(request_id)->'body', '{"ok":true}'::jsonb,
  mode || ' readback returns the settled Edge response') FROM renderer_leases;

CREATE TEMP TABLE renderer_rejected_receipts AS
SELECT code, public.invoke_label_renderer(1) AS receipt FROM (VALUES (401), (403)) statuses(code);
CREATE TEMP TABLE renderer_rejected_leases AS
SELECT r.code, claim.* FROM renderer_rejected_receipts r
CROSS JOIN LATERAL public.claim_edge_job_by_id_v1((r.receipt->>'edge_job_id')::uuid) claim;
SELECT public.mark_claimed_edge_job_failure_v1(job_id, lease_token, code, '{}', '{}', 'renderer_gateway_rejected', 1)
FROM renderer_rejected_leases;
SELECT ok(o.status = 'permanently_failed' AND o.error_message = 'renderer_gateway_rejected'
  AND o.response_status_code = l.code AND o.retry_count = 0 AND o.completed_at IS NOT NULL
  AND o.lease_expires_at IS NULL AND o.edge_lease_token IS NULL,
  l.code || ' rejects the renderer invocation permanently and clears its lease')
FROM renderer_rejected_leases l JOIN public.outbound_calls o ON o.id = l.job_id;
SELECT throws_ok(format('SELECT public.claim_edge_job_by_id_v1(%L::uuid)', job_id), 'P0001',
  format('claim_edge_job_by_id_v1: outbound call %s is not claimable', job_id),
  code || ' cannot be claimed again') FROM renderer_rejected_leases;

SELECT throws_ok(format('SELECT public.%I(%L, %L, %L::jsonb, %L::jsonb, 1%s)',
    transport, endpoint, 'POST', jsonb_build_object(header, credential), '{}',
    CASE WHEN transport = 'call_api_wait' THEN ', 1' ELSE '' END), '22023',
  'outbound_credential_headers_refused', transport || ' refuses ' || header)
FROM renderer_transport_case CROSS JOIN unnest(ARRAY['dispatch_api_request_v1', 'call_api', 'call_api_wait']) transport
CROSS JOIN unnest(ARRAY['AUTHORIZATION', 'Cookie', 'Proxy-Authorization', 'X-API-KEY', 'apikey',
  'D360-API-Key', 'X-Provider-Auth', 'Api-Key', 'X-Auth-Token', 'X-Webhook-Token']) header;

SELECT is((SELECT count(*) FROM net.http_request_queue), initial_net_rows,
  'renderer calls and credential refusals create zero pg_net rows') FROM renderer_transport_case;

UPDATE public.label_jobs SET scheduled_at = now() + interval '100 years'
WHERE status = 'pending' AND scheduled_at <= now();
SELECT is(public.ops_sweeper_label_renderer_cron_guard('{}')->>'status', 'enabled',
  'the renderer is configured and the cron guard enables its tick');
CREATE TEMP TABLE renderer_idle_counts AS SELECT
  (SELECT count(*) FROM public.workflow_runs) AS runs,
  (SELECT count(*) FROM public.workflow_run_steps) AS steps,
  (SELECT count(*) FROM public.outbound_calls) AS calls;
DO $tick$
BEGIN
  EXECUTE (SELECT command FROM cron.job WHERE jobname = 'label_renderer_dispatch');
END;
$tick$;
SELECT ok(runs = (SELECT count(*) FROM public.workflow_runs)
  AND steps = (SELECT count(*) FROM public.workflow_run_steps)
  AND calls = (SELECT count(*) FROM public.outbound_calls),
  'an idle configured cron tick writes no workflow run, step, or outbound job') FROM renderer_idle_counts;

SELECT * FROM finish();
ROLLBACK;

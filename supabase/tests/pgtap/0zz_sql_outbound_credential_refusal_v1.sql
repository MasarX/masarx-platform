BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);
SELECT public.create_next_partitions();
SELECT set_config('app.force_worker', 'outbound_worker', true);

CREATE TEMP TABLE outbound_refusal_fixture AS SELECT gen_random_uuid() AS org,
  gen_random_uuid() AS provider, concat('https', '://', 'egress', '.', 'example', '.', 'test', '/') AS url,
  jsonb_build_object('timeout_seconds', 1, 'poll_max_seconds', 0, 'poll_interval_ms', 50,
    'pending_reschedule_seconds', 60, 'lease_seconds', 60) AS options,
  (SELECT count(*) FROM net.http_request_queue) AS net_rows;
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Outbound refusal fixture', 'outbound-refusal-' || org FROM outbound_refusal_fixture;
INSERT INTO public.providers (id, organization_id, name, provider_type)
SELECT provider, org, 'Outbound refusal provider', 'http' FROM outbound_refusal_fixture;
UPDATE public.settings SET cached_value = COALESCE(cached_value, '{}'::jsonb)
  || jsonb_build_object('enabled', true, 'endpoint_url', (SELECT url FROM outbound_refusal_fixture))
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
UPDATE public.outbound_calls SET scheduled_at = now() + interval '100 years'
WHERE status IN ('pending', 'pending_edge', 'failed') AND scheduled_at <= now();

CREATE TEMP TABLE outbound_refusal_jobs AS
SELECT lane, refuses, gen_random_uuid() AS job, now() - interval '1 minute' AS due
FROM (VALUES ('worker', true), ('worker', false), ('inline', true), ('inline', false)) queue(lane, refuses);
INSERT INTO public.outbound_calls (id, call_type, target_type, target_id, method, url, headers, body,
  status, priority, retry_count, max_retries, scheduled_at, context)
SELECT job, 'provider_api', 'provider', provider, 'POST', url || job,
  jsonb_build_object('accept', 'application/json', 'company-id', provider::text, 'x-client-id', org::text)
    || CASE WHEN refuses THEN jsonb_build_object('authorization', encode(gen_random_bytes(20), 'hex')) ELSE '{}'::jsonb END,
  jsonb_build_object('marker', job), 'pending', CASE WHEN refuses THEN 100 ELSE 90 END, 0, 3,
  CASE WHEN lane = 'worker' THEN due ELSE now() + interval '1 minute' END,
  jsonb_build_object('organization_id', org)
FROM outbound_refusal_jobs CROSS JOIN outbound_refusal_fixture;

SELECT is(public.run_outbound_worker()->>'items_processed', '2', 'the worker continues past one refused job');
UPDATE public.outbound_calls o SET scheduled_at = j.due FROM outbound_refusal_jobs j
WHERE o.id = j.job AND j.lane = 'inline';
SELECT is(public.dispatch_outbound_call_inline(job, options)->>'reason', 'outbound_credential_headers_refused',
  'inline reports credential refusal for just this job')
FROM outbound_refusal_jobs CROSS JOIN outbound_refusal_fixture WHERE lane = 'inline' AND refuses;
SELECT is(public.dispatch_outbound_call_inline(job, options)->>'status', 'pending', 'the next inline call hands off normally')
FROM outbound_refusal_jobs CROSS JOIN outbound_refusal_fixture WHERE lane = 'inline' AND NOT refuses;

SELECT ok(o.status = 'permanently_failed' AND o.error_message = 'outbound_credential_headers_refused'
  AND o.completed_at IS NOT NULL AND o.retry_count = 0 AND o.scheduled_at = j.due
  AND o.lease_expires_at IS NULL AND o.edge_lease_token IS NULL
  AND NOT (o.context ?| ARRAY['edge_dispatch','async_request_id']),
  j.lane || ' refusal is terminal and schedules no retry or transport')
FROM outbound_refusal_jobs j JOIN public.outbound_calls o ON o.id = j.job WHERE j.refuses ORDER BY j.lane;
SELECT ok(o.status = 'pending_edge' AND o.lease_expires_at IS NULL AND o.edge_lease_token IS NULL
  AND o.context#>'{edge_dispatch,headers}' = jsonb_build_object(
    'accept', 'application/json', 'company-id', f.provider::text, 'x-client-id', f.org::text),
  j.lane || ' control is durably queued with the supported noncredential headers')
FROM outbound_refusal_jobs j JOIN public.outbound_calls o ON o.id = j.job
CROSS JOIN outbound_refusal_fixture f WHERE NOT j.refuses ORDER BY j.lane;

CREATE TEMP TABLE outbound_refusal_leases AS SELECT * FROM public.claim_pending_edge_job_ids_v1(1);
INSERT INTO outbound_refusal_leases SELECT * FROM public.claim_pending_edge_job_ids_v1(1);
SELECT ok((SELECT array_agg(job_id ORDER BY job_id) FROM outbound_refusal_leases WHERE lease_token IS NOT NULL)
  = (SELECT array_agg(job ORDER BY job) FROM outbound_refusal_jobs WHERE NOT refuses),
  'the leased claimant gets exactly the two controls with tokens');
SELECT ok(public.get_claimed_edge_job_call_spec_v1(job_id, lease_token) @> jsonb_build_object(
  'url', url || job_id, 'method', 'POST', 'body', jsonb_build_object('marker', job_id)),
  'the lease resolves the exact queued credential-free request')
FROM outbound_refusal_leases CROSS JOIN outbound_refusal_fixture;
SELECT public.mark_claimed_edge_job_success_v1(job_id, lease_token, 200, '{}', '{"ok":true}', 1)
FROM outbound_refusal_leases;
SELECT ok((SELECT count(*) FROM public.outbound_calls o JOIN outbound_refusal_jobs j ON o.id = j.job
  WHERE NOT j.refuses AND o.status = 'completed' AND o.retry_count = 0 AND o.edge_lease_token IS NULL) = 2,
  'both controls complete on the leased Edge path');
SELECT is((SELECT count(*) FROM net.http_request_queue), net_rows, 'the mixed lanes create zero pg_net rows')
FROM outbound_refusal_fixture;

SELECT * FROM finish();
ROLLBACK;

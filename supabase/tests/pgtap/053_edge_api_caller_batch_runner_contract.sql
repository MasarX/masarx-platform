-- Plan: PLAN-202601-logestechs-outbound-http2-fix / Step: S95
-- Purpose: Contract checks for edge api-caller autonomous execution primitives.

BEGIN;

SELECT plan(3);

SELECT ok(
  to_regprocedure('public.run_api_caller_batch(int)') IS NULL,
  'run_api_caller_batch(int) is retired for every role'
);

SELECT ok(
  to_regprocedure('public.run_edge_api_caller_worker()') IS NULL,
  'run_edge_api_caller_worker() is retired for every role'
);

UPDATE public.settings SET cached_value = (cached_value - 'endpoint_url') || '{"enabled":false}'::jsonb
WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
UPDATE public.outbound_calls SET scheduled_at = now() + interval '100 years'
WHERE status IN ('pending', 'pending_edge', 'failed') AND scheduled_at <= now();
CREATE TEMP TABLE retired_sql_claim_fixture AS
SELECT gen_random_uuid() AS sql_job, gen_random_uuid() AS edge_job, gen_random_uuid() AS target,
  gen_random_uuid() AS org,
  concat('https', '://', 'egress', '.', 'example', '.', 'test', '/') AS url;
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Retired SQL claim fixture', 'retired-sql-claim-' || org FROM retired_sql_claim_fixture;
INSERT INTO public.providers (id, organization_id, name, provider_type)
SELECT target, org, 'Retired SQL claim provider', 'http' FROM retired_sql_claim_fixture;
INSERT INTO public.outbound_calls (id, call_type, target_type, target_id, method, url, status, scheduled_at, context)
SELECT sql_job, 'provider_api', 'provider', target, 'POST', url || sql_job, 'pending', now(), jsonb_build_object('organization_id', org)
FROM retired_sql_claim_fixture
UNION ALL
SELECT edge_job, 'provider_api', 'provider', target, 'POST', url || edge_job, 'pending_edge', now(), jsonb_build_object('organization_id', org)
FROM retired_sql_claim_fixture;

CREATE TEMP TABLE retired_sql_claim AS SELECT job_id FROM public.claim_pending_jobs(10);
CREATE TEMP TABLE retired_edge_claim AS SELECT * FROM public.claim_pending_edge_job_ids_v1(1);
SELECT ok(
  (SELECT array_agg(job_id) FROM retired_sql_claim) = ARRAY[sql_job]
  AND (SELECT array_agg(job_id) FROM retired_edge_claim WHERE lease_token IS NOT NULL) = ARRAY[edge_job],
  'with Edge configuration unavailable, SQL claims only pending and the leased claimant still gets pending_edge'
) FROM retired_sql_claim_fixture;

SELECT * FROM finish();

ROLLBACK;

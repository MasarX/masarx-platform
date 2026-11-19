BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- Seed minimal org + provider for outbound_calls targeting (idempotent).
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO public.organizations (id, name, slug)
VALUES ('cccccccc-0000-0000-0000-000000000001', 'Edge Claim Org', 'edge-claim-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES ('cccccccc-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', 'Edge Claim Client', 'edge-claim-client', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES ('cccccccc-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000003', 'Edge Claim Sender', 'Edge Claim Sender', TRUE, 'active')
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.organization_onboarding_source', '', true);
SELECT public.bootstrap_tenant_onboarding_v1('cccccccc-0000-0000-0000-000000000001', 'pgtap:edge-claim-spec-guard-fixture-bootstrap');

INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, metadata)
VALUES (
  'cccccccc-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000001',
  'Edge Claim Provider',
  'http',
  TRUE,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'dddd0aa0-0000-0000-0000-0000000000aa', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'bbbb0aa0-0000-0000-0000-0000000000aa',
  'pgtap_claim_pending_edge_jobs_spec_guard',
  'Fixture workflow for edge-claim spec guard tests',
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
  'cccc0aa0-0000-0000-0000-0000000000aa',
  'bbbb0aa0-0000-0000-0000-0000000000aa',
  1,
  'workflow_control',
  'always',
  'workflow_control',
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
  'dddd0aa0-0000-0000-0000-0000000000aa',
  'bbbb0aa0-0000-0000-0000-0000000000aa',
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
  'eeee0aa0-0000-0000-0000-0000000000aa',
  'dddd0aa0-0000-0000-0000-0000000000aa',
  'cccc0aa0-0000-0000-0000-0000000000aa',
  1,
  'pending',
  'workflow_control',
  'workflow_control',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', 'eeee0aa0-0000-0000-0000-0000000000aa', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'eeee0aa0-0000-0000-0000-0000000000aa', true);

-- Insert a misconfigured job that would previously crash claim_pending_edge_jobs via get_job_call_spec().
INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'cccccccc-0000-0000-0000-000000000010',
  'provider_api',
  'provider',
  'cccccccc-0000-0000-0000-000000000002',
  'POST',
  'https://example.test/bad-edge-claim',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending_edge',
  2147483647,
  0,
  1,
  now() - interval '1 minute',
  now(),
  jsonb_build_object(
    'organization_id', 'cccccccc-0000-0000-0000-000000000001',
    'auth', jsonb_build_object('mode', 'api_key_query', 'query_param', 'token')
  ),
  'eeee0aa0-0000-0000-0000-0000000000aa'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    lease_expires_at = NULL,
    context = EXCLUDED.context,
    workflow_run_step_id = EXCLUDED.workflow_run_step_id;

-- Insert a valid job that should still be claimed even when a bad job exists.
INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'cccccccc-0000-0000-0000-000000000011',
  'provider_api',
  'provider',
  'cccccccc-0000-0000-0000-000000000002',
  'POST',
  'https://example.test/good-edge-claim',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending_edge',
  2147483646,
  0,
  1,
  now() - interval '1 minute',
  now(),
  jsonb_build_object('organization_id', 'cccccccc-0000-0000-0000-000000000001'),
  'eeee0aa0-0000-0000-0000-0000000000aa'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    lease_expires_at = NULL,
    context = EXCLUDED.context,
    workflow_run_step_id = EXCLUDED.workflow_run_step_id;

-- Act: claim a batch. The function must NOT raise, must permanently_fail the bad job, and must claim the good job.
SELECT ok(
  EXISTS(SELECT 1 FROM public.claim_pending_edge_jobs(10) WHERE job_id = 'cccccccc-0000-0000-0000-000000000011'),
  'claim_pending_edge_jobs claims a valid job even when another job has invalid auth/spec'
);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'cccccccc-0000-0000-0000-000000000010'),
  'permanently_failed',
  'invalid job is marked permanently_failed instead of crashing the batch'
);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'cccccccc-0000-0000-0000-000000000011'),
  'in_progress_edge',
  'valid job is moved to in_progress_edge'
);

-- Optional: decision_log entry exists for the spec failure (org-scoped).
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000001'
      AND decision_category = 'outbound_call'
      AND resource_id = 'cccccccc-0000-0000-0000-000000000010'
      AND decision_point = 'edge_claim_spec'
      AND decision_outcome = 'permanently_failed'
  ),
  'spec failure is logged to decision_log for audit/alerting'
);

SELECT finish();

ROLLBACK;

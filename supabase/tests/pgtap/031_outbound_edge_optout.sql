-- Test Suite: Edge opt-out enforcement (claim_pending_edge_jobs)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Ensure time partitions exist for decision_log inserts during the test window.
SELECT public.create_next_partitions();

SELECT plan(4);

-- Keep this test deterministic on shared cloud DBs by ensuring no unrelated
-- due edge jobs are claimed/returned by claim_pending_edge_jobs().
UPDATE public.outbound_calls
   SET scheduled_at = now() + interval '100 years'
 WHERE status IN ('pending_edge', 'failed')
   AND scheduled_at <= now()
   AND (lease_expires_at IS NULL OR lease_expires_at < now())
   AND (status <> 'failed' OR retry_count < max_retries);

-- Seed minimal org + client + sender + recipient with WhatsApp opt-out.
-- This fixture owns source-binding setup, so defer bootstrap until client/sender context exists.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO public.organizations (id, name, slug)
VALUES ('cccccccc-0000-0000-0000-000000000031', 'Edge OptOut Org', 'edge-optout-org')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    updated_at = now();
SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'cccccccc-0000-0000-0000-000000000032',
  'cccccccc-0000-0000-0000-000000000031',
  'Edge OptOut Client',
  'edge-optout-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  'cccccccc-0000-0000-0000-000000000132',
  'cccccccc-0000-0000-0000-000000000032',
  'Edge OptOut Sender',
  'Edge OptOut Sender',
  false,
  true,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    brand_name = EXCLUDED.brand_name,
    status = EXCLUDED.status,
    updated_at = now();

SELECT public.bootstrap_tenant_onboarding_v1(
  'cccccccc-0000-0000-0000-000000000031',
  'pgtap:outbound-edge-optout-fixture-bootstrap'
);

INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, preferred_language)
VALUES (
  'cccccccc-0000-0000-0000-000000000033',
  'cccccccc-0000-0000-0000-000000000031',
  'cccccccc-0000-0000-0000-000000000032',
  'Opted Out Recipient',
  '+966500000031',
  'en'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.recipient_preferences (recipient_id, channel, language, opted_out, opted_out_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000033',
  'whatsapp',
  'en',
  TRUE,
  now()
)
ON CONFLICT (recipient_id, channel) DO UPDATE
SET opted_out = EXCLUDED.opted_out,
    opted_out_at = EXCLUDED.opted_out_at,
    updated_at = now();

-- Provider + job to be claimed by edge.
INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, metadata)
VALUES (
  'cccccccc-0000-0000-0000-000000000034',
  'cccccccc-0000-0000-0000-000000000031',
  'edge_optout_provider',
  'comms',
  TRUE,
  jsonb_build_object('base_url', 'https://example.test')
)
ON CONFLICT (id) DO NOTHING;

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'ffff0310-0000-0000-0000-000000000031', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'dddd0310-0000-0000-0000-000000000031',
  'pgtap_outbound_edge_optout',
  'Fixture workflow for edge opt-out tests',
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
  'eeee0310-0000-0000-0000-000000000031',
  'dddd0310-0000-0000-0000-000000000031',
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
  'ffff0310-0000-0000-0000-000000000031',
  'dddd0310-0000-0000-0000-000000000031',
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
  'aaaa0310-0000-0000-0000-000000000031',
  'ffff0310-0000-0000-0000-000000000031',
  'eeee0310-0000-0000-0000-000000000031',
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

SELECT set_config('app.workflow_run_step_id', 'aaaa0310-0000-0000-0000-000000000031', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'aaaa0310-0000-0000-0000-000000000031', true);

INSERT INTO public.outbound_calls (
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
  retry_count,
  max_retries,
  scheduled_at,
  created_at,
  context,
  workflow_run_step_id
)
VALUES (
  'cccccccc-0000-0000-0000-000000000035',
  'comms_whatsapp',
  'provider',
  'cccccccc-0000-0000-0000-000000000034',
  'POST',
  'https://example.test/whatsapp',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending_edge',
  2147480000,
  0,
  3,
  now() - interval '1 minute',
  now(),
  jsonb_build_object(
    'organization_id', 'cccccccc-0000-0000-0000-000000000031',
    'client_id', 'cccccccc-0000-0000-0000-000000000032',
    'recipient_id', 'cccccccc-0000-0000-0000-000000000033'
  ),
  'aaaa0310-0000-0000-0000-000000000031'
)
ON CONFLICT (id) DO NOTHING;

-- Claim should skip opted-out comms_whatsapp jobs (no dispatch rows returned).
SELECT is(
  (SELECT count(*) FROM public.claim_pending_edge_jobs(10) WHERE job_id = 'cccccccc-0000-0000-0000-000000000035'),
  0::bigint,
  'claim_pending_edge_jobs skips opted-out comms_whatsapp jobs'
);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'cccccccc-0000-0000-0000-000000000035'),
  'skipped',
  'opt-out enforcement sets outbound_calls.status=skipped'
);

SELECT is(
  (SELECT error_message FROM public.outbound_calls WHERE id = 'cccccccc-0000-0000-0000-000000000035'),
  'recipient_opted_out',
  'opt-out enforcement records error_message=recipient_opted_out'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log
    WHERE resource_type = 'outbound_call'
      AND resource_id = 'cccccccc-0000-0000-0000-000000000035'
      AND decision_point = 'opt_out_enforcement'
      AND decision_outcome = 'skipped'
  ),
  'opt-out skip is logged to decision_log'
);

SELECT finish();

ROLLBACK;

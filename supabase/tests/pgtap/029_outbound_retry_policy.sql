BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'outbound_retry_policy' AND version = 1 AND is_active = TRUE
  ),
  'schema_registry includes outbound_retry_policy v1'
);

SELECT ok(
  public.resolve_settings('outbound_retry_policy', 'global', NULL) IS NOT NULL,
  'outbound_retry_policy global setting is present'
);

-- Keep this test deterministic on shared cloud DBs by ensuring no unrelated
-- due edge jobs are claimed (or fail claim due to missing auth configs).
UPDATE public.outbound_calls
   SET scheduled_at = now() + interval '100 years'
 WHERE status IN ('pending_edge', 'failed')
   AND scheduled_at <= now()
   AND (lease_expires_at IS NULL OR lease_expires_at < now())
   AND (status <> 'failed' OR retry_count < max_retries);

-- Seed minimal org + provider for outbound_calls targeting. This fixture owns
-- source-binding setup, so defer bootstrap until client/sender context exists.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO public.organizations (id, name, slug)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'Retry Org', 'retry-org')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    updated_at = now();
SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000101',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Retry Client',
  'retry-client',
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
  'bbbbbbbb-0000-0000-0000-000000000201',
  'bbbbbbbb-0000-0000-0000-000000000101',
  'Retry Sender',
  'Retry Sender',
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
  'bbbbbbbb-0000-0000-0000-000000000001',
  'pgtap:outbound-retry-policy-fixture-bootstrap'
);

INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, metadata)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Retry Provider',
  'http',
  TRUE,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'cccc0290-0000-0000-0000-000000000029', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'aaaa0290-0000-0000-0000-000000000029',
  'pgtap_outbound_retry_policy',
  'Fixture workflow for outbound retry policy tests',
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
  'bbbb0290-0000-0000-0000-000000000029',
  'aaaa0290-0000-0000-0000-000000000029',
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
  'cccc0290-0000-0000-0000-000000000029',
  'aaaa0290-0000-0000-0000-000000000029',
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
  'dddd0290-0000-0000-0000-000000000029',
  'cccc0290-0000-0000-0000-000000000029',
  'bbbb0290-0000-0000-0000-000000000029',
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

SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('app.workflow_run_step_id', 'dddd0290-0000-0000-0000-000000000029', true);
SELECT set_config('platform.workflow_run_step_id', 'dddd0290-0000-0000-0000-000000000029', true);

-- Future-scheduled pending_edge job should not be claimed.
INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000010',
  'provider_api',
  'provider',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'POST',
  'https://example.test/retry',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending_edge',
  2147480000,
  0,
  3,
  now() + interval '1 day',
  now(),
  jsonb_build_object('organization_id', 'bbbbbbbb-0000-0000-0000-000000000001'),
  'dddd0290-0000-0000-0000-000000000029'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.claim_pending_edge_jobs(1);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000010'),
  'pending_edge',
  'claim_pending_edge_jobs does not claim pending_edge jobs before scheduled_at'
);

-- Due pending_edge job should be claimed (highest priority wins).
UPDATE public.outbound_calls
   SET scheduled_at = now() - interval '1 minute'
 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000010';

SELECT public.claim_pending_edge_jobs(10);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000010'),
  'in_progress_edge',
  'claim_pending_edge_jobs claims due pending_edge jobs'
);

-- Failed jobs (retry scheduled) should also be claimable by edge when due.
INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000011',
  'provider_api',
  'provider',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'POST',
  'https://example.test/retry2',
  '{}'::jsonb,
  '{}'::jsonb,
  'failed',
  2147480001,
  0,
  3,
  now() - interval '1 minute',
  now(),
  jsonb_build_object('organization_id', 'bbbbbbbb-0000-0000-0000-000000000001'),
  'dddd0290-0000-0000-0000-000000000029'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.claim_pending_edge_jobs(10);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000011'),
  'in_progress_edge',
  'claim_pending_edge_jobs claims due failed jobs (retry scheduled)'
);

-- Override global outbound_retry_policy deterministically for the remaining assertions.
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'http', jsonb_build_object(
      'retryable_status_codes', jsonb_build_array(0, 500, 429),
      'retryable_status_ranges', jsonb_build_array(jsonb_build_array(500, 599)),
      'permanent_status_ranges', jsonb_build_array(jsonb_build_array(400, 499)),
      'retry_after_header', 'retry-after'
    ),
    'backoff_seconds', jsonb_build_array(10, 20, 30),
    'max_retry_delay_seconds', 60,
    'respect_retry_after', TRUE
  ) AS value
),
updated_versions AS (
  UPDATE public.settings_versions sv
     SET value = payload.value,
         version = 999,
         schema_version = 1,
         created_at = now()
    FROM payload
   WHERE sv.category = 'outbound_retry_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_id IS NULL
  RETURNING sv.id, payload.value AS value
),
inserted_versions AS (
  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version, change_reason, approved_at, effective_from, created_at
  )
  SELECT
    'outbound_retry_policy',
    'global',
    NULL::uuid,
    999,
    payload.value,
    1,
    'pgtap override outbound_retry_policy',
    now(),
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (SELECT 1 FROM updated_versions)
  RETURNING id, value
),
version_row AS (
  SELECT id, value FROM updated_versions
  UNION ALL
  SELECT id, value FROM inserted_versions
  LIMIT 1
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'outbound_retry_policy', 'global', NULL::uuid, version_row.id, version_row.value, now()
FROM version_row
ON CONFLICT (category, scope_type, scope_hash)
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;

-- Retryable failure should schedule a retry (status=failed) and push scheduled_at forward.
INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000020',
  'provider_api',
  'provider',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'POST',
  'https://example.test/retry3',
  '{}'::jsonb,
  '{}'::jsonb,
  'in_progress_edge',
  100,
  0,
  3,
  now(),
  now(),
  jsonb_build_object('organization_id', 'bbbbbbbb-0000-0000-0000-000000000001'),
  'dddd0290-0000-0000-0000-000000000029'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.mark_outbound_call_failure(
  'bbbbbbbb-0000-0000-0000-000000000020',
  500,
  '{}'::jsonb,
  jsonb_build_object('error', 'server error'),
  'HTTP 500'
);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000020'),
  'failed',
  'mark_outbound_call_failure schedules retryable failures as status=failed'
);

SELECT ok(
  (SELECT scheduled_at > now() FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000020'),
  'retryable failure pushes scheduled_at forward for backoff'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log
    WHERE resource_type = 'outbound_call'
      AND resource_id = 'bbbbbbbb-0000-0000-0000-000000000020'
      AND decision_category = 'outbound_call'
      AND settings_resolution_id IS NOT NULL
  ),
  'outbound_call failure decision links settings_resolution_id for retry policy audit'
);

-- Explicit retryable codes must override permanent ranges (e.g., 429 inside 400-499).
INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000022',
  'provider_api',
  'provider',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'POST',
  'https://example.test/retry429',
  '{}'::jsonb,
  '{}'::jsonb,
  'in_progress_edge',
  100,
  0,
  3,
  now(),
  now(),
  jsonb_build_object('organization_id', 'bbbbbbbb-0000-0000-0000-000000000001'),
  'dddd0290-0000-0000-0000-000000000029'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.mark_outbound_call_failure(
  'bbbbbbbb-0000-0000-0000-000000000022',
  429,
  jsonb_build_object('retry-after', '55'),
  jsonb_build_object('error', 'rate limited'),
  'HTTP 429'
);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000022'),
  'failed',
  'explicit retryable codes override permanent status ranges (429 retries)'
);

SELECT ok(
  (SELECT scheduled_at > now() FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000022'),
  '429 retry schedules scheduled_at forward for backoff'
);

-- Permanent failures should stop immediately (status=permanently_failed) regardless of remaining retries.
INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000021',
  'provider_api',
  'provider',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'POST',
  'https://example.test/permanent',
  '{}'::jsonb,
  '{}'::jsonb,
  'in_progress_edge',
  100,
  0,
  3,
  now(),
  now(),
  jsonb_build_object('organization_id', 'bbbbbbbb-0000-0000-0000-000000000001'),
  'dddd0290-0000-0000-0000-000000000029'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.mark_outbound_call_failure(
  'bbbbbbbb-0000-0000-0000-000000000021',
  400,
  '{}'::jsonb,
  jsonb_build_object('error', 'bad request'),
  'HTTP 400'
);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'bbbbbbbb-0000-0000-0000-000000000021'),
  'permanently_failed',
  'permanent status codes bypass retries and become permanently_failed'
);

SELECT finish();

ROLLBACK;

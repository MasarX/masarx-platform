BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Inline dispatch is tested without external HTTP by pre-seeding pg_net's response table
-- and attaching the async_request_id to an outbound_calls row.
INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaaaaaa-0000-0000-0000-000000000010', 'Inline Dispatch Org', 'inline-dispatch-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.providers (id, organization_id, name, provider_type)
VALUES (
  'ffffffff-0000-0000-0000-000000000010',
  'aaaaaaaa-0000-0000-0000-000000000010',
  'Inline Dispatch Provider',
  'http'
)
ON CONFLICT (id) DO NOTHING;

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'dddd0bb0-0000-0000-0000-0000000000bb', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'bbbb0bb0-0000-0000-0000-0000000000bb',
  'pgtap_outbound_inline_dispatch',
  'Fixture workflow for inline dispatch tests',
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
  'cccc0bb0-0000-0000-0000-0000000000bb',
  'bbbb0bb0-0000-0000-0000-0000000000bb',
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
  'dddd0bb0-0000-0000-0000-0000000000bb',
  'bbbb0bb0-0000-0000-0000-0000000000bb',
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
  'eeee0bb0-0000-0000-0000-0000000000bb',
  'dddd0bb0-0000-0000-0000-0000000000bb',
  'cccc0bb0-0000-0000-0000-0000000000bb',
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

SELECT set_config('app.workflow_run_step_id', 'eeee0bb0-0000-0000-0000-0000000000bb', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'eeee0bb0-0000-0000-0000-0000000000bb', true);

-- Deterministic async response id.
CREATE TEMP TABLE pgtap_inline_req(id BIGINT);
INSERT INTO pgtap_inline_req(id) VALUES (9100000001);

INSERT INTO net._http_response (id, status_code, headers, content, created)
SELECT
  r.id,
  200,
  '{}'::jsonb,
  '{"ok":true}',
  now()
FROM pgtap_inline_req r;

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
  context,
  created_at,
  workflow_run_step_id
) VALUES (
  'ffffffff-0000-0000-0000-000000000011',
  'provider_api',
  'provider',
  'ffffffff-0000-0000-0000-000000000010',
  'POST',
  'https://example.test/api',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending',
  100,
  0,
  1,
  now(),
  jsonb_build_object('async_request_id', (SELECT id FROM pgtap_inline_req LIMIT 1)),
  now(),
  'eeee0bb0-0000-0000-0000-0000000000bb'
)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE pgtap_inline_result(status TEXT);
INSERT INTO pgtap_inline_result(status)
SELECT (
  public.dispatch_outbound_call_inline(
    'ffffffff-0000-0000-0000-000000000011',
    jsonb_build_object(
      'timeout_seconds', 10,
      'poll_max_seconds', 0,
      'poll_interval_ms', 200,
      'pending_reschedule_seconds', 30,
      'lease_seconds', 30,
      'performed_by_system', 'pgtap_inline_dispatch'
    )
  )->>'status'
);

-- Defensive: some legacy handlers still mutate session search_path; restore before assertions.
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

SELECT is(
  (SELECT status FROM pgtap_inline_result LIMIT 1),
  'completed',
  'dispatch_outbound_call_inline completes from async pg_net response'
);

SELECT is(
  (SELECT status FROM public.outbound_calls WHERE id = 'ffffffff-0000-0000-0000-000000000011'),
  'completed',
  'outbound_calls marked completed'
);

SELECT ok(
  NOT COALESCE(
    (SELECT (COALESCE(context, '{}'::jsonb) ? 'async_request_id') FROM public.outbound_calls WHERE id = 'ffffffff-0000-0000-0000-000000000011'),
    FALSE
  ),
  'async_request_id cleared on completion'
);

SELECT finish();

ROLLBACK;

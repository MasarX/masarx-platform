-- Test Suite: API gateway dispatch outbound is blocked until wait_workflow completes
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SET search_path TO public, pgtap, extensions;

-- Minimal workflow template + run with wait_workflow pending before dispatch.
INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
) VALUES (
  '07700000-0000-0000-0000-000000000001',
  'pgtap_api_gateway_dispatch_guard_077',
  'PGTAP dispatch_outbound guard waits for wait_workflow',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  metadata,
  handler_key,
  handler_version,
  enabled
) VALUES (
  '07700000-0000-0000-0000-000000000002',
  '07700000-0000-0000-0000-000000000001',
  1,
  'wait_geocoding',
  'always',
  jsonb_build_object('poll_interval_seconds', 5, 'max_wait_seconds', 60),
  'wait_workflow',
  'v1',
  TRUE
), (
  '07700000-0000-0000-0000-000000000003',
  '07700000-0000-0000-0000-000000000001',
  2,
  'dispatch_create',
  'always',
  '{}'::jsonb,
  'api_gateway_dispatch_outbound',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '07700000-0000-0000-0000-000000000010', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '07700000-0000-0000-0000-000000000010',
  '07700000-0000-0000-0000-000000000001',
  1,
  'pgtap',
  'in_progress',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  retry_attempt,
  enqueued_at,
  created_at,
  updated_at
) VALUES (
  '07700000-0000-0000-0000-000000000011',
  '07700000-0000-0000-0000-000000000010',
  '07700000-0000-0000-0000-000000000002',
  1,
  'pending',
  'wait_geocoding',
  'wait_workflow',
  'v1',
  99,
  0,
  now(),
  now(),
  now()
), (
  '07700000-0000-0000-0000-000000000012',
  '07700000-0000-0000-0000-000000000010',
  '07700000-0000-0000-0000-000000000003',
  2,
  'pending',
  'dispatch_create',
  'api_gateway_dispatch_outbound',
  'v1',
  99,
  0,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE tmp_dispatch_guard_077 AS
SELECT workflow_handlers.execute_api_gateway_dispatch_outbound_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '07700000-0000-0000-0000-000000000012'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '07700000-0000-0000-0000-000000000010'),
  '{}'::jsonb
) AS resp;

SELECT is(
  (SELECT (resp).status FROM tmp_dispatch_guard_077),
  'pending',
  'dispatch_outbound returns pending when wait_workflow step not completed'
);

SELECT is(
  (SELECT (resp).operation_result->>'blocked_by' FROM tmp_dispatch_guard_077),
  'wait_workflow',
  'dispatch_outbound explains it is blocked by wait_workflow'
);

SELECT finish();

ROLLBACK;

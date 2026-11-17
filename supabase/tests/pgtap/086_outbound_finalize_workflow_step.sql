BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

WITH target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
)
SELECT ok(
  id IS NOT NULL,
  'client available for outbound finalize test'
)
FROM target;

SELECT set_config('masarx.workflow_engine', '1', true);
SELECT set_config('app.workflow_run_id', 'd8600000-0000-0000-0000-000000000003', true);

INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'd8600000-0000-0000-0000-000000000001',
  'pgtap_outbound_finalize',
  'Fixture workflow for outbound finalize test',
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
  'd8600000-0000-0000-0000-000000000002',
  'd8600000-0000-0000-0000-000000000001',
  1,
  'outbound_http',
  'always',
  'outbound_http',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

WITH target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
)
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
SELECT
  'd8600000-0000-0000-0000-000000000003',
  'd8600000-0000-0000-0000-000000000001',
  1,
  'test',
  'in_progress',
  jsonb_build_object('client_id', target.id)
FROM target
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
  updated_at,
  operation_started_at
)
VALUES (
  'd8600000-0000-0000-0000-000000000004',
  'd8600000-0000-0000-0000-000000000003',
  'd8600000-0000-0000-0000-000000000002',
  1,
  'in_progress',
  'outbound_http',
  'outbound_http',
  'v1',
  1,
  now(),
  now(),
  now(),
  now() - interval '2 seconds'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', 'd8600000-0000-0000-0000-000000000004', true);
WITH target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
)
INSERT INTO outbound_calls (
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
  max_retries,
  scheduled_at,
  workflow_run_step_id,
  response_status_code,
  response_headers,
  response_body,
  completed_at,
  error_message
)
SELECT
  'd8600000-0000-0000-0000-000000000005',
  'provider_api',
  'client',
  target.id,
  'GET',
  'https://example.com',
  '{}'::jsonb,
  '{}'::jsonb,
  'completed',
  1000,
  1,
  now() - interval '1 minute',
  'd8600000-0000-0000-0000-000000000004',
  200,
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  NULL
FROM target
ON CONFLICT (id) DO NOTHING;

SELECT public.finalize_outbound_workflow_step_v1('d8600000-0000-0000-0000-000000000005');

SELECT is(
  (SELECT step_status FROM workflow_run_steps WHERE id = 'd8600000-0000-0000-0000-000000000004'),
  'completed',
  'finalize marks outbound step completed'
);

SELECT is(
  (SELECT operation_result->>'outbound_call_id' FROM workflow_run_steps WHERE id = 'd8600000-0000-0000-0000-000000000004'),
  'd8600000-0000-0000-0000-000000000005',
  'finalize stores outbound_call_id in operation_result'
);

SELECT ok(
  (SELECT decision_log_id IS NOT NULL FROM workflow_run_steps WHERE id = 'd8600000-0000-0000-0000-000000000004'),
  'finalize records decision log id'
);

SELECT set_config('app.workflow_run_id', 'd8600000-0000-0000-0000-000000000006', true);
WITH target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
)
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
SELECT
  'd8600000-0000-0000-0000-000000000006',
  'd8600000-0000-0000-0000-000000000001',
  1,
  'test',
  'in_progress',
  jsonb_build_object('client_id', target.id)
FROM target
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
  updated_at,
  operation_started_at
)
VALUES (
  'd8600000-0000-0000-0000-000000000007',
  'd8600000-0000-0000-0000-000000000006',
  'd8600000-0000-0000-0000-000000000002',
  1,
  'in_progress',
  'outbound_http',
  'outbound_http',
  'v1',
  1,
  now(),
  now(),
  now(),
  now() - interval '2 seconds'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', 'd8600000-0000-0000-0000-000000000007', true);
WITH target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
)
INSERT INTO outbound_calls (
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
  max_retries,
  scheduled_at,
  workflow_run_step_id,
  response_status_code,
  response_headers,
  response_body,
  completed_at,
  error_message
)
SELECT
  'd8600000-0000-0000-0000-000000000008',
  'provider_api',
  'client',
  target.id,
  'GET',
  'https://example.com',
  '{}'::jsonb,
  '{}'::jsonb,
  'permanently_failed',
  1000,
  1,
  now() - interval '1 minute',
  'd8600000-0000-0000-0000-000000000007',
  500,
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  'pgtap_failure'
FROM target
ON CONFLICT (id) DO NOTHING;

SELECT public.finalize_outbound_workflow_step_v1('d8600000-0000-0000-0000-000000000008');

SELECT is(
  (SELECT step_status FROM workflow_run_steps WHERE id = 'd8600000-0000-0000-0000-000000000007'),
  'failed',
  'finalize marks outbound step failed'
);

SELECT is(
  (SELECT workflow_status FROM workflow_runs WHERE id = 'd8600000-0000-0000-0000-000000000006'),
  'failed',
  'finalize marks workflow run failed when outbound permanently failed'
);

SELECT set_config('masarx.workflow_engine', '', true);
SELECT set_config('app.workflow_run_id', '', true);
SELECT set_config('app.workflow_run_step_id', '', true);

SELECT * FROM finish();
ROLLBACK;

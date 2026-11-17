-- Test Suite: workflow_control fail action + wait_for_shipment handler
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

-- Core entities for shipment wait test.
INSERT INTO organizations (id, name, slug)
VALUES ('aaaaaaaa-0000-0000-0000-000000000111', 'Workflow Test Org', 'wf-test-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, organization_id, name, slug, status)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000111',
  'aaaaaaaa-0000-0000-0000-000000000111',
  'Workflow Test Client',
  'wf-test-client',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES (
  'cccccccc-0000-0000-0000-000000000111',
  'bbbbbbbb-0000-0000-0000-000000000111',
  'Workflow Test Sender',
  'Workflow Test Sender',
  TRUE,
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  city,
  province,
  country,
  validation_status,
  created_at,
  updated_at
)
VALUES (
  'dddddddd-0000-0000-0000-000000000111',
  'aaaaaaaa-0000-0000-0000-000000000111',
  'bbbbbbbb-0000-0000-0000-000000000111',
  'Test Address',
  'Riyadh',
  'Riyadh',
  'SA',
  'valid',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

-- workflow_control fail action.
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000111',
  'pgtap_workflow_control_fail',
  'pgTAP workflow_control fail handler',
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
  metadata,
  enabled
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000112',
  'eeeeeeee-0000-0000-0000-000000000111',
  1,
  'provider_error',
  'always',
  'workflow_control',
  'v1',
  jsonb_build_object('action', 'fail', 'reason', 'provider_error'),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000113', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000113',
  'eeeeeeee-0000-0000-0000-000000000111',
  1,
  'test',
  'pending',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000113', true);

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
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000114',
  'eeeeeeee-0000-0000-0000-000000000113',
  'eeeeeeee-0000-0000-0000-000000000112',
  1,
  'pending',
  'provider_error',
  'workflow_control',
  'v1',
  1,
  jsonb_build_object('action', 'fail', 'reason', 'provider_error'),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000113'
  ),
  'failed',
  'workflow_control fail returns failed status'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).workflow_status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000113'
  ),
  'failed',
  'workflow_control fail sets workflow_status=failed'
);

-- workflow_control fail action with conditional context.
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000201',
  'pgtap_workflow_control_conditional',
  'pgTAP workflow_control conditional fail handler',
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
  metadata,
  enabled
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000202',
  'eeeeeeee-0000-0000-0000-000000000201',
  1,
  'provider_error',
  'always',
  'workflow_control',
  'v1',
  jsonb_build_object(
    'action',
    'fail',
    'fail_when',
    'context_truthy',
    'context_path',
    'flags.force_fail',
    'reason',
    'provider_failed'
  ),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000203', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000203',
  'eeeeeeee-0000-0000-0000-000000000201',
  1,
  'test',
  'pending',
  jsonb_build_object('flags', jsonb_build_object('force_fail', false))
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
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000204',
  'eeeeeeee-0000-0000-0000-000000000203',
  'eeeeeeee-0000-0000-0000-000000000202',
  1,
  'pending',
  'provider_error',
  'workflow_control',
  'v1',
  1,
  jsonb_build_object(
    'action',
    'fail',
    'fail_when',
    'context_truthy',
    'context_path',
    'flags.force_fail',
    'reason',
    'provider_failed'
  ),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000203'
  ),
  'completed',
  'workflow_control conditional fail skips when context flag is false'
);

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000205', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000205',
  'eeeeeeee-0000-0000-0000-000000000201',
  1,
  'test',
  'pending',
  jsonb_build_object('flags', jsonb_build_object('force_fail', true))
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
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000206',
  'eeeeeeee-0000-0000-0000-000000000205',
  'eeeeeeee-0000-0000-0000-000000000202',
  1,
  'pending',
  'provider_error',
  'workflow_control',
  'v1',
  1,
  jsonb_build_object(
    'action',
    'fail',
    'fail_when',
    'context_truthy',
    'context_path',
    'flags.force_fail',
    'reason',
    'provider_failed'
  ),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000205'
  ),
  'failed',
  'workflow_control conditional fail triggers when context flag is true'
);

-- wait_for_shipment handler.
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'ffffffff-0000-0000-0000-000000000111',
  'pgtap_wait_for_shipment',
  'pgTAP wait_for_shipment handler',
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
  metadata,
  enabled
)
VALUES (
  'ffffffff-0000-0000-0000-000000000112',
  'ffffffff-0000-0000-0000-000000000111',
  1,
  'wait_for_shipment',
  'always',
  'wait_for_shipment',
  'v1',
  jsonb_build_object('poll_interval_seconds', 5, 'max_wait_seconds', 60),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'ffffffff-0000-0000-0000-000000000113', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'ffffffff-0000-0000-0000-000000000113',
  'ffffffff-0000-0000-0000-000000000111',
  1,
  'test',
  'pending',
  jsonb_build_object('api_gateway_request_id', '99990000-0000-0000-0000-000000000111')
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'ffffffff-0000-0000-0000-000000000113', true);

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
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'ffffffff-0000-0000-0000-000000000114',
  'ffffffff-0000-0000-0000-000000000113',
  'ffffffff-0000-0000-0000-000000000112',
  1,
  'pending',
  'wait_for_shipment',
  'wait_for_shipment',
  'v1',
  3,
  jsonb_build_object('poll_interval_seconds', 5, 'max_wait_seconds', 60),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'ffffffff-0000-0000-0000-000000000113'
  ),
  'pending',
  'wait_for_shipment returns pending when shipment is missing'
);

INSERT INTO shipments (
  id,
  organization_id,
  client_id,
  sender_id,
  service_type,
  tracking_number,
  box_count,
  destination_address_id,
  status,
  status_updated_at,
  metadata,
  created_at,
  updated_at
)
VALUES (
  '99999999-0000-0000-0000-000000000111',
  'aaaaaaaa-0000-0000-0000-000000000111',
  'bbbbbbbb-0000-0000-0000-000000000111',
  'cccccccc-0000-0000-0000-000000000111',
  'delivery',
  'PITCH-WAIT-001',
  1,
  'dddddddd-0000-0000-0000-000000000111',
  'pending',
  now(),
  jsonb_build_object('source', jsonb_build_object('api_gateway_request_id', '99990000-0000-0000-0000-000000000111')),
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'ffffffff-0000-0000-0000-000000000113'
  ),
  'completed',
  'wait_for_shipment completes once shipment exists'
);

SELECT ok(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).context_patch->>'shipment_id'
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'ffffffff-0000-0000-0000-000000000113'
  ) = '99999999-0000-0000-0000-000000000111',
  'wait_for_shipment patches shipment_id in context'
);

SELECT * FROM finish();

ROLLBACK;

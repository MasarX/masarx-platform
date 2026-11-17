-- Test Suite: Comms delivery receipts update comms_attempts (Dialog360-style status callbacks)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(
  to_regprocedure('public.process_comms_delivery_receipt(uuid,uuid,jsonb,uuid)') IS NOT NULL,
  'process_comms_delivery_receipt(uuid,uuid,jsonb,uuid) exists'
);

-- Seed minimal org + provider + templates so mark_outbound_call_success can create a comms_attempt.
INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaaaaaa-0000-0000-0000-000000000030', 'Comms Receipt Org', 'comms-receipt-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, metadata)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000031',
  'aaaaaaaa-0000-0000-0000-000000000030',
  'comms_receipt_provider',
  'comms',
  TRUE,
  jsonb_build_object('base_url', 'https://example.test')
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000032',
  'provider_response',
  'comms_receipt_provider::send_whatsapp::v1',
  jsonb_build_object(
    'success_path', '$.messages[0].id',
    'field_mappings', jsonb_build_object(
      'message_id', '$.messages[0].id',
      'status', '$.messages[0].status',
      'timestamp', '$.messages[0].timestamp'
    )
  ),
  1,
  'Comms receipt test response mapping'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.operation_templates (
  id,
  provider_id,
  handler_key,
  operation_name,
  method,
  url_template,
  headers_template,
  body_template,
  request_mappings,
  mapping_config_id,
  timeout_seconds,
  metadata
)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000033',
  'aaaaaaaa-0000-0000-0000-000000000031',
  'outbound_http',
  'comms_receipt_send_v1',
  'POST',
  'https://example.test/send',
  jsonb_build_object('content-type', 'application/json'),
  '{}'::jsonb,
  NULL,
  'aaaaaaaa-0000-0000-0000-000000000032',
  30,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'dddd0300-0000-0000-0000-000000000030', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'bbbb0300-0000-0000-0000-000000000030',
  'pgtap_comms_status_receipts',
  'Fixture workflow for comms receipt tests',
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
  'cccc0300-0000-0000-0000-000000000030',
  'bbbb0300-0000-0000-0000-000000000030',
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
  'dddd0300-0000-0000-0000-000000000030',
  'bbbb0300-0000-0000-0000-000000000030',
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
  'eeee0300-0000-0000-0000-000000000030',
  'dddd0300-0000-0000-0000-000000000030',
  'cccc0300-0000-0000-0000-000000000030',
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

SELECT set_config('app.workflow_run_step_id', 'eeee0300-0000-0000-0000-000000000030', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'eeee0300-0000-0000-0000-000000000030', true);

INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id,
  method, url, headers, body,
  status, priority, retry_count, max_retries,
  scheduled_at, created_at, context, workflow_run_step_id
)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000034',
  'comms_whatsapp',
  'provider',
  'aaaaaaaa-0000-0000-0000-000000000031',
  'POST',
  'https://example.test/send',
  '{}'::jsonb,
  '{}'::jsonb,
  'in_progress_edge',
  100,
  0,
  2,
  now(),
  now(),
  jsonb_build_object(
    'organization_id', 'aaaaaaaa-0000-0000-0000-000000000030',
    'operation_template_id', 'aaaaaaaa-0000-0000-0000-000000000033'
  ),
  'eeee0300-0000-0000-0000-000000000030'
)
ON CONFLICT (id) DO NOTHING;

-- Simulate a successful provider send (creates comms_attempts via process_outbound_response_v1).
DO $$
BEGIN
  PERFORM public.mark_outbound_call_success(
    'aaaaaaaa-0000-0000-0000-000000000034',
    200,
    '{}'::jsonb,
    jsonb_build_object(
      'messages',
      jsonb_build_array(
        jsonb_build_object(
          'id', 'msg-030',
          'status', 'accepted',
          'timestamp', '1700000000'
        )
      )
    ),
    12
  );
END;
$$;

SELECT is(
  (
    SELECT status
    FROM public.comms_attempts
    WHERE outbound_call_id = 'aaaaaaaa-0000-0000-0000-000000000034'
      AND attempt_number = 1
    LIMIT 1
  ),
  'sent',
  'comms_attempts row created with status=sent on successful outbound response'
);

SELECT is(
  (
    SELECT provider_message_id
    FROM public.comms_attempts
    WHERE outbound_call_id = 'aaaaaaaa-0000-0000-0000-000000000034'
      AND attempt_number = 1
    LIMIT 1
  ),
  'msg-030',
  'provider_message_id extracted via mapping_config'
);

WITH receipt AS (
  SELECT public.process_comms_delivery_receipt(
    p_webhook_id := 'aaaaaaaa-0000-0000-0000-000000000035',
    p_webhook_source_id := 'aaaaaaaa-0000-0000-0000-000000000036',
    p_comm := jsonb_build_object('message_id', 'msg-030', 'status', 'delivered'),
    p_organization_id := 'aaaaaaaa-0000-0000-0000-000000000030'
  ) AS r
)
SELECT is(
  ((SELECT r FROM receipt) ->> 'updated_count')::INT,
  1,
  'delivery receipt updates exactly one comms_attempt'
);

SELECT is(
  (SELECT status FROM public.comms_attempts WHERE provider_message_id = 'msg-030' LIMIT 1),
  'delivered',
  'delivery receipt updates comms_attempts.status'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log
    WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000030'
      AND decision_category = 'provider_callback'
      AND resource_type = 'webhook_inbox'
      AND resource_id = 'aaaaaaaa-0000-0000-0000-000000000035'
      AND decision_point = 'comms_delivery_receipt'
      AND decision_outcome = 'delivered'
  ),
  'delivery receipt writes provider_callback decision_log entry'
);

SELECT finish();

ROLLBACK;

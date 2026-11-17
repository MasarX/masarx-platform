-- Test Suite: Outbound Worker behaviour

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Increase statement timeout to avoid cancellation in cloud during worker execution
SET LOCAL statement_timeout TO '120s';

SELECT plan(17);

SELECT has_role('edge_api_caller_role');
SELECT ok(
    has_function_privilege('edge_api_caller_role', 'public.log_api_call_event(uuid,jsonb,jsonb,int,int,text)', 'EXECUTE'),
    'edge_api_caller_role can execute public.log_api_call_event'
);
SELECT ok(
    has_function_privilege('edge_api_caller_role', 'api.log_api_call_event(uuid,jsonb,jsonb,int,int,text)', 'EXECUTE'),
    'edge_api_caller_role can execute api.log_api_call_event'
);
SELECT ok(
    NOT has_function_privilege('anon', 'public.log_api_call_event(uuid,jsonb,jsonb,int,int,text)', 'EXECUTE'),
    'anon cannot execute public.log_api_call_event'
);
SELECT ok(
    NOT has_function_privilege('anon', 'api.log_api_call_event(uuid,jsonb,jsonb,int,int,text)', 'EXECUTE'),
    'anon cannot execute api.log_api_call_event'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'public.log_api_call_event(uuid,jsonb,jsonb,int,int,text)', 'EXECUTE'),
    'authenticated cannot execute public.log_api_call_event'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'api.log_api_call_event(uuid,jsonb,jsonb,int,int,text)', 'EXECUTE'),
    'authenticated cannot execute api.log_api_call_event'
);

-- Reset throttle so worker can run immediately
UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'outbound_worker';

SELECT is(
    (SELECT (run_outbound_worker())->>'status'),
    'completed',
    'Outbound worker executes successfully with empty queue'
);

-- Set up a pending outbound call (HTTP may fail or remain pending depending on pg_net/network availability)
INSERT INTO organizations (id, name, slug)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'Outbound Org', 'outbound-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO providers (id, organization_id, name, provider_type)
VALUES (
    'ffffffff-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'Outbound Test Provider',
    'http'
)
ON CONFLICT (id) DO NOTHING;

-- Seed a workflow run/step so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'ffffffff-0000-0000-0000-000000000100', true);
INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
VALUES (
  'ffffffff-0000-0000-0000-000000000102',
  'pgtap_outbound_worker_template',
  'pgTAP outbound worker guard context',
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
  'ffffffff-0000-0000-0000-000000000103',
  'ffffffff-0000-0000-0000-000000000102',
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
  'ffffffff-0000-0000-0000-000000000100',
  'ffffffff-0000-0000-0000-000000000102',
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
  'ffffffff-0000-0000-0000-000000000101',
  'ffffffff-0000-0000-0000-000000000100',
  'ffffffff-0000-0000-0000-000000000103',
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

SELECT set_config('app.workflow_run_step_id', 'ffffffff-0000-0000-0000-000000000101', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'ffffffff-0000-0000-0000-000000000101', true);

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
    retry_count,
    max_retries,
    scheduled_at,
    created_at,
    workflow_run_step_id
) VALUES (
    'ffffffff-0000-0000-0000-000000000002',
    'provider_api',
    'provider',
    'ffffffff-0000-0000-0000-000000000001',
    'POST',
    'https://example.test/api',
    '{"Content-Type": "application/json"}'::jsonb,
    '{"payload": true}'::jsonb,
    'pending',
    100,
    0,
    2,
    now(),
    now(),
    'ffffffff-0000-0000-0000-000000000101'
) ON CONFLICT (id) DO NOTHING;

-- Reset throttle and execute worker to process the pending call
UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'outbound_worker';

SELECT is(
    (SELECT (run_outbound_worker())->>'status'),
    'completed',
    'Outbound worker returns completed after attempting HTTP request'
);

SELECT ok(
    (SELECT status FROM outbound_calls WHERE id = 'ffffffff-0000-0000-0000-000000000002')
    IN ('failed', 'pending', 'pending_edge'),
  'Outbound call marked for retry, async polling, or edge dispatch when in-database HTTP execution unavailable'
);

-- Async polling guard: when async_request_id exists, worker must poll net._http_response
-- instead of re-sending the outbound HTTP request (prevents duplicate sends).
CREATE TEMP TABLE pgtap_async_req(id BIGINT);
INSERT INTO pgtap_async_req(id)
SELECT COALESCE((SELECT max(id) FROM net._http_response), 0) + 100000;

-- Seed a deterministic pg_net response row inside this transaction (no external HTTP dependency).
INSERT INTO net._http_response (id, status_code, headers, content, created)
SELECT
  r.id,
  404,
  '{}'::jsonb,
  '{"meta":{"success":false,"http_code":404,"developer_message":"Not Found"}}',
  now()
FROM pgtap_async_req r;

SELECT ok(
  COALESCE((public.check_async_response((SELECT id FROM pgtap_async_req LIMIT 1))->>'completed')::BOOLEAN, FALSE),
  'pg_net response available for async polling'
);

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
    retry_count,
    max_retries,
    scheduled_at,
    created_at,
    context,
    workflow_run_step_id
) VALUES (
    'ffffffff-0000-0000-0000-000000000003',
    'provider_api',
    'provider',
    'ffffffff-0000-0000-0000-000000000001',
    'GET',
    'https://invalid.invalid/should-not-be-called',
    '{}'::jsonb,
    '{}'::jsonb,
    'pending',
    999,
    0,
    1,
    now(),
    now(),
    jsonb_build_object('async_request_id', (SELECT id FROM pgtap_async_req LIMIT 1)),
    'ffffffff-0000-0000-0000-000000000101'
);

-- Reset throttle and execute worker to poll the async_request_id and complete the job.
UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'outbound_worker';
SELECT run_outbound_worker();

SELECT is(
  (SELECT status FROM outbound_calls WHERE id = 'ffffffff-0000-0000-0000-000000000003'),
  'permanently_failed',
  'Outbound worker finalizes job by polling async_request_id (no duplicate send)'
);

SELECT is(
  (SELECT response_status_code FROM outbound_calls WHERE id = 'ffffffff-0000-0000-0000-000000000003'),
  404,
  'Outbound worker uses pg_net response for async_request_id polling'
);

SELECT ok(
  NOT COALESCE((SELECT (context ? 'async_request_id') FROM outbound_calls WHERE id = 'ffffffff-0000-0000-0000-000000000003'), FALSE),
  'Outbound worker clears async_request_id after completion'
);

-- Response processing (SSOT): on successful completion, worker must invoke orchestrate_api_response_processing()
-- which records comms_attempts (and provider_usage_tracking) for comms_* call types.
CREATE TEMP TABLE pgtap_async_req_success(id BIGINT);
INSERT INTO pgtap_async_req_success(id)
SELECT COALESCE((SELECT max(id) FROM net._http_response), 0) + 100001;

INSERT INTO net._http_response (id, status_code, headers, content, created)
SELECT
  r.id,
  200,
  '{}'::jsonb,
  '{"messages":[{"id":"wamid.pgtap.success"}]}',
  now()
FROM pgtap_async_req_success r;

INSERT INTO providers (id, organization_id, name, provider_type, metadata)
VALUES (
  'ffffffff-0000-0000-0000-000000000004',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Outbound Test WhatsApp Provider',
  'comms',
  jsonb_build_object('channel', 'whatsapp')
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes, created_at, updated_at)
VALUES (
  'ffffffff-0000-0000-0000-000000000010',
  'provider_response',
  'pgtap::comms_whatsapp::v1',
  jsonb_build_object(
    'success_path', '$.messages[0].id',
    'field_mappings', jsonb_build_object(
      'message_id', '$.messages[0].id'
    )
  ),
  1,
  'pgTAP provider_response mapping for comms_whatsapp outbound worker processing',
  now(),
  now()
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    mapping_version = EXCLUDED.mapping_version,
    notes = EXCLUDED.notes,
    updated_at = now();

INSERT INTO operation_templates (
  id,
  provider_id,
  operation_name,
  call_type,
  handler_key,
  method,
  url_template,
  mapping_config_id,
  timeout_seconds,
  created_at,
  updated_at
)
VALUES (
  'ffffffff-0000-0000-0000-000000000011',
  'ffffffff-0000-0000-0000-000000000004',
  'pgtap_send_whatsapp',
  'comms_whatsapp',
  'outbound_http',
  'POST',
  'https://example.test/whatsapp',
  'ffffffff-0000-0000-0000-000000000010',
  30,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

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
  retry_count,
  max_retries,
  scheduled_at,
  created_at,
  context,
  workflow_run_step_id
)
VALUES (
  'ffffffff-0000-0000-0000-000000000005',
  'comms_whatsapp',
  'provider',
  'ffffffff-0000-0000-0000-000000000004',
  'POST',
  'https://example.test/whatsapp',
  '{}'::jsonb,
  jsonb_build_object('to', '555000000000', 'type', 'text', 'text', jsonb_build_object('body', 'hello')),
  'pending',
  9999,
  0,
  1,
  now(),
  now(),
  jsonb_build_object(
    'async_request_id', (SELECT id FROM pgtap_async_req_success LIMIT 1),
    'operation_template_id', 'ffffffff-0000-0000-0000-000000000011',
    'organization_id', 'aaaaaaaa-0000-0000-0000-000000000001'
  ),
  'ffffffff-0000-0000-0000-000000000101'
);

UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'outbound_worker';
SELECT run_outbound_worker();

SELECT is(
  (SELECT status FROM outbound_calls WHERE id = 'ffffffff-0000-0000-0000-000000000005'),
  'completed',
  'Outbound worker finalizes comms_whatsapp job and marks completed'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM comms_attempts
    WHERE outbound_call_id = 'ffffffff-0000-0000-0000-000000000005'
      AND attempt_number = 1
      AND status = 'sent'
  ),
  'Outbound worker processes comms response and records comms_attempts (SSOT)'
);

SELECT is(
  (
    SELECT provider_message_id
    FROM comms_attempts
    WHERE outbound_call_id = 'ffffffff-0000-0000-0000-000000000005'
      AND attempt_number = 1
  ),
  'wamid.pgtap.success',
  'Comms attempt captures provider_message_id via mapping_config (row-driven)'
);

SELECT finish();

ROLLBACK;

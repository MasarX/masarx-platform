-- Test Suite: Runtime Helpers (resolve_settings, check_throttle, resolve_organization_id_strict)
-- Executes after migrations have created base tables.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

-- ============================================================================
-- Fixture data
-- ============================================================================
-- Clear prior campaign_policy fixture rows to keep idempotent across seeds/reruns.
DELETE FROM settings
WHERE category = 'campaign_policy'
  AND scope_type IN ('global', 'tenant', 'client')
  AND (scope_id IS NULL OR scope_id IN (
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001'
      ));

DELETE FROM settings_versions
WHERE category = 'campaign_policy'
  AND scope_type IN ('global', 'tenant', 'client')
  AND (scope_id IS NULL OR scope_id IN (
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001'
      ));

WITH org AS (
    INSERT INTO organizations (id, name, slug)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'Test Org', 'test-org')
    RETURNING id
), client AS (
    INSERT INTO clients (id, organization_id, name, slug)
    SELECT 'bbbbbbbb-0000-0000-0000-000000000001', id, 'Test Client', 'test-client'
    FROM org
    RETURNING id, organization_id
), sender AS (
    INSERT INTO senders (id, client_id, name, brand_name)
    SELECT 'cccccccc-0000-0000-0000-000000000001', id, 'Test Sender', 'Test Brand'
    FROM client
    RETURNING id, client_id
), provider AS (
    INSERT INTO providers (id, organization_id, name, provider_type)
    SELECT 'dddddddd-0000-0000-0000-000000000001', id, 'Test Provider', 'http'
    FROM org
    RETURNING id, organization_id
), recipient AS (
    INSERT INTO recipients (id, organization_id, client_id, name, phone_number)
    SELECT '99999999-0000-0000-0000-000000000001', organization_id, id, 'Runtime Recipient', '+12025550123'
    FROM client
    ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        client_id = EXCLUDED.client_id,
        name = EXCLUDED.name,
        phone_number = EXCLUDED.phone_number
    RETURNING id, organization_id
), shipment AS (
    INSERT INTO shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        status
    )
    SELECT
        '88888888-0000-0000-0000-000000000001',
        c.organization_id,
        c.id,
        s.id,
        'delivery',
        'TRK-RUNTIME-001',
        'pending'
    FROM client c
    JOIN sender s ON s.client_id = c.id
    ON CONFLICT (id, client_id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        sender_id = EXCLUDED.sender_id,
        service_type = EXCLUDED.service_type,
        tracking_number = EXCLUDED.tracking_number,
        status = EXCLUDED.status
    RETURNING id, organization_id
), svc AS (
    INSERT INTO settings_versions (id, category, scope_type, scope_id, version, value, approved_at)
    VALUES
        ('eeeeeeee-0000-0000-0000-000000000001', 'campaign_policy', 'global', NULL, 1, '{"enrollment_enabled": false}'::jsonb, now()),
        ('eeeeeeee-0000-0000-0000-000000000002', 'campaign_policy', 'tenant', 'aaaaaaaa-0000-0000-0000-000000000001', 1, '{"enrollment_enabled": true}'::jsonb, now()),
        ('eeeeeeee-0000-0000-0000-000000000003', 'campaign_policy', 'client', 'bbbbbbbb-0000-0000-0000-000000000001', 1, '{"enrollment_enabled": true, "max_daily": 25}'::jsonb, now())
    ON CONFLICT DO NOTHING
    RETURNING id, category, scope_type, scope_id, value
)
INSERT INTO settings (id, category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT gen_random_uuid(), category, scope_type, scope_id, id, value, now()
FROM svc
ON CONFLICT (category, scope_type, scope_id) DO NOTHING;

INSERT INTO worker_registry (
    worker_name,
    worker_type,
    description,
    schedule,
    config,
    is_active
) VALUES (
    'test_worker',
    'maintenance',
    'Temporary worker for throttle tests',
    '* * * * *',
    '{"interval_seconds": 60, "batch_size": 5}'::jsonb,
    TRUE
) ON CONFLICT (worker_name) DO NOTHING;

-- Ensure cron_config entries exist for throttle tests.
INSERT INTO cron_config (worker_name, interval_seconds, batch_size, last_run_at, enabled, notes)
VALUES ('test_worker', 60, 5, NULL, TRUE, 'Temporary worker for throttle tests')
ON CONFLICT (worker_name) DO NOTHING;

-- Ensure outbound_call fixtures satisfy workflow-engine guards.
SELECT set_config('app.workflow_run_id', '77777777-0000-0000-0000-000000000100', true);

INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
VALUES (
  '77777777-0000-0000-0000-000000000102',
  'pgtap_runtime_outbound_template',
  'pgTAP runtime outbound organization resolver fixture',
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
  '77777777-0000-0000-0000-000000000103',
  '77777777-0000-0000-0000-000000000102',
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
  '77777777-0000-0000-0000-000000000100',
  '77777777-0000-0000-0000-000000000102',
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
  '77777777-0000-0000-0000-000000000101',
  '77777777-0000-0000-0000-000000000100',
  '77777777-0000-0000-0000-000000000103',
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

SELECT set_config('app.workflow_run_step_id', '77777777-0000-0000-0000-000000000101', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', '77777777-0000-0000-0000-000000000101', true);

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
    '77777777-0000-0000-0000-000000000201',
    'comms_sms',
    'recipient',
    '99999999-0000-0000-0000-000000000001',
    'POST',
    'comms://sms',
    '{}'::jsonb,
    '{}'::jsonb,
    'pending',
    100,
    0,
    2,
    now(),
    now(),
    '77777777-0000-0000-0000-000000000101'
), (
    '77777777-0000-0000-0000-000000000202',
    'comms_sms',
    'recipient',
    '99999999-0000-0000-0000-000000000999',
    'POST',
    'comms://sms',
    '{}'::jsonb,
    '{}'::jsonb,
    'pending',
    100,
    0,
    2,
    now(),
    now(),
    '77777777-0000-0000-0000-000000000101'
)
ON CONFLICT (id) DO UPDATE
SET target_type = EXCLUDED.target_type,
    target_id = EXCLUDED.target_id,
    shipment_id = EXCLUDED.shipment_id,
    workflow_run_step_id = EXCLUDED.workflow_run_step_id;

UPDATE outbound_calls
SET shipment_id = '88888888-0000-0000-0000-000000000001'
WHERE id = '77777777-0000-0000-0000-000000000202';

-- ============================================================================
-- Tests
-- ============================================================================

SELECT is(
    (resolve_settings('campaign_policy'::text, 'sender'::text, 'cccccccc-0000-0000-0000-000000000001'::uuid)->>'enrollment_enabled')::BOOLEAN,
    TRUE,
    'Sender inherits campaign policy from client/tenant/global ladder'
);

SELECT is(
    resolve_settings('non_existent_policy'::text, 'client'::text, 'bbbbbbbb-0000-0000-0000-000000000001'::uuid),
    NULL::JSONB,
    'Unknown configuration category returns NULL'
);

SELECT is(
    resolve_organization_id_strict('provider', 'dddddddd-0000-0000-0000-000000000001'),
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    'resolve_organization_id_strict finds provider organization'
);

SELECT is(
    resolve_organization_id_strict('outbound_call', '77777777-0000-0000-0000-000000000201'),
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    'resolve_organization_id_strict finds outbound_call organization from recipient target'
);

SELECT is(
    resolve_organization_id_strict('outbound_call', '77777777-0000-0000-0000-000000000202'),
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    'resolve_organization_id_strict falls back to shipment organization for outbound_call'
);

SELECT is(
    (SELECT batch_size FROM check_throttle('test_worker')),
    5,
    'check_throttle returns configured batch size'
);

SELECT is(
    (SELECT should_run FROM check_throttle('test_worker')),
    TRUE,
    'check_throttle allows first run when interval not elapsed'
);

UPDATE cron_config SET last_run_at = now() WHERE worker_name = 'test_worker';

SELECT is(
    (SELECT should_run FROM check_throttle('test_worker')),
    FALSE,
    'check_throttle prevents execution when interval not elapsed'
);

SELECT finish();

ROLLBACK;

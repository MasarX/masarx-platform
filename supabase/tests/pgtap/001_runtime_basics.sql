-- Test Suite: Runtime Helpers (resolve_settings, check_throttle, resolve_organization_id_strict)
-- Executes after migrations have created base tables.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

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

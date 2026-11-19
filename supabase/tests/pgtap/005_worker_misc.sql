-- Test Suite: Campaign, alert, circuit, cache workers

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

-- Reset throttles
UPDATE cron_config
SET last_run_at = NULL,
    batch_size = CASE
        WHEN worker_name IN ('campaign_enrollment_worker', 'campaign_dispatcher_worker')
            THEN GREATEST(COALESCE(batch_size, 1), 10000)
        ELSE batch_size
    END
WHERE worker_name IN (
    'campaign_enrollment_worker',
    'campaign_dispatcher_worker',
    'alert_aggregation_worker',
    'circuit_breaker_recovery_worker',
    'cache_cleanup_worker'
);

-- Fixtures -------------------------------------------------------------------
-- This fixture owns client/sender setup. Defer organization bootstrap until
-- the source-binding context exists, then run canonical onboarding explicitly.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO organizations (id, name, slug)
VALUES ('aaaa2000-0000-0000-0000-000000000005', 'Misc Org', 'misc-org')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    updated_at = now();
SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO clients (id, organization_id, name, slug, status)
VALUES (
    'bbbb2000-0000-0000-0000-000000000005',
    'aaaa2000-0000-0000-0000-000000000005',
    'Misc Client',
    'misc-client',
    'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
    'cccc2000-0000-0000-0000-000000000005',
    'bbbb2000-0000-0000-0000-000000000005',
    'Misc Sender',
    'Misc Sender',
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
    'aaaa2000-0000-0000-0000-000000000005',
    'pgtap:worker-misc-fixture-bootstrap'
);

INSERT INTO shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status
) VALUES (
    'dddd2000-0000-0000-0000-000000000005',
    'aaaa2000-0000-0000-0000-000000000005',
    'bbbb2000-0000-0000-0000-000000000005',
    'cccc2000-0000-0000-0000-000000000005',
    'delivery',
    'TRK-MISC-001',
    'pending'
) ON CONFLICT (id, client_id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    sender_id = EXCLUDED.sender_id,
    service_type = EXCLUDED.service_type,
    tracking_number = EXCLUDED.tracking_number,
    status = 'pending';

DELETE FROM campaign_enrollments
WHERE shipment_id = 'dddd2000-0000-0000-0000-000000000005';

-- Campaign policy (client scope)
SELECT *
FROM public.upsert_settings_value_v1(
    'campaign_policy',
    'client',
    'bbbb2000-0000-0000-0000-000000000005',
    '{"enrollment_enabled": true, "campaign_key": "welcome", "metadata": {"channel": "sms"}}'::jsonb,
    1,
    'pgtap: worker misc campaign policy fixture'
);

-- Ensure sender-level precedence resolves the same deterministic fixture policy.
SELECT *
FROM public.upsert_settings_value_v1(
    'campaign_policy',
    'sender',
    'cccc2000-0000-0000-0000-000000000005',
    '{"enrollment_enabled": true, "campaign_key": "welcome", "metadata": {"channel": "sms"}}'::jsonb,
    1,
    'pgtap: worker misc sender campaign policy fixture'
);

-- Alert rule
INSERT INTO alert_rules (id, organization_id, rule_name, trigger_source, trigger_conditions, alert_channels)
VALUES (
    'ffff2000-0000-0000-0000-000000000005',
    'aaaa2000-0000-0000-0000-000000000005',
    'test-alert',
    'decision_log',
    '{"decision_category": "outbound_call"}'::jsonb,
    '["email"]'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- Seed decision log entry so alert fires
INSERT INTO decision_log (
    id,
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    performed_by_system,
    timestamp
) VALUES (
    gen_random_uuid(),
    'aaaa2000-0000-0000-0000-000000000005',
    'outbound_call',
    'outbound_call',
    gen_random_uuid(),
    'http_execution',
    'error',
    'outbound_worker',
    now()
) ON CONFLICT (id, organization_id, timestamp) DO NOTHING;

-- Provider / circuit breaker
INSERT INTO providers (id, organization_id, name, provider_type)
VALUES ('aaaa3000-0000-0000-0000-000000000005', 'aaaa2000-0000-0000-0000-000000000005', 'Circuit Provider', 'http')
ON CONFLICT (id) DO NOTHING;

INSERT INTO circuit_breaker_state (
    id, provider_id, operation_name, state, half_open_test_at
) VALUES (
    'bbbb3000-0000-0000-0000-000000000005',
    'aaaa3000-0000-0000-0000-000000000005',
    'send_sms',
    'half_open',
    now()
) ON CONFLICT (id) DO NOTHING;

-- Cache entry
INSERT INTO settings_cache (id, cache_key, resolved_value, expires_at)
VALUES (
    'cccc3000-0000-0000-0000-000000000005',
    'campaign_policy:client:bbbb2000-0000-0000-0000-000000000005',
    '{"value": "cached"}'::jsonb,
    now() - interval '1 minute'
) ON CONFLICT (id) DO NOTHING;

-- Worker executions -----------------------------------------------------------
SELECT is(
    (run_campaign_enrollment_worker()->>'status'),
    'completed',
    'Campaign enrollment worker completes'
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM campaign_enrollments
        WHERE shipment_id = 'dddd2000-0000-0000-0000-000000000005'
          AND status = 'enrolled'
    ),
    'Shipment enrolled into campaign'
);

UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'campaign_dispatcher_worker';

SELECT is(
    (run_campaign_dispatcher_worker()->>'status'),
    'completed',
    'Campaign dispatcher worker completes'
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM campaign_enrollments
        WHERE shipment_id = 'dddd2000-0000-0000-0000-000000000005'
          AND status = 'dispatched'
    ),
    'Enrollment dispatched'
);

UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'alert_aggregation_worker';

SELECT is(
    (run_alert_aggregation_worker()->>'status'),
    'completed',
    'Alert aggregation worker completes'
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM decision_log
        WHERE decision_category = 'alert_evaluation'
          AND resource_type = 'alert_rule'
          AND decision_outcome = 'alert_triggered'
    ),
    'Alert evaluation logged with trigger'
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM alert_triggers
        WHERE alert_rule_id = 'ffff2000-0000-0000-0000-000000000005'
          AND organization_id = 'aaaa2000-0000-0000-0000-000000000005'
          AND resource_type = 'decision_log'
    ),
    'Alert aggregation worker writes alert_triggers rows'
);

UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'circuit_breaker_recovery_worker';

SELECT is(
    (run_circuit_breaker_recovery_worker()->>'status'),
    'completed',
    'Circuit breaker recovery worker completes'
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM circuit_breaker_state
        WHERE id = 'bbbb3000-0000-0000-0000-000000000005'
          AND state = 'closed'
    ),
    'Circuit breaker closed after recovery'
);

UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'cache_cleanup_worker';

SELECT is(
    (run_cache_cleanup_worker()->>'status'),
    'completed',
    'Cache cleanup worker completes'
);

SELECT ok(
    NOT EXISTS (
        SELECT 1 FROM settings_cache WHERE id = 'cccc3000-0000-0000-0000-000000000005'
    ),
    'Expired settings cache entries removed'
);

SELECT finish();

ROLLBACK;

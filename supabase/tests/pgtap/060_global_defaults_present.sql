-- Test: Global defaults presence and resolver checks

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

-- Presence in schema_registry or settings (global)
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='response_policy' AND scope_type='global' AND scope_id IS NULL), 'response_policy seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='error_policy' AND scope_type='global' AND scope_id IS NULL), 'error_policy seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='idempotency_defaults' AND scope_type='global' AND scope_id IS NULL), 'idempotency_defaults seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='rate_limit_policy' AND scope_type='global' AND scope_id IS NULL), 'rate_limit_policy seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='retry_backoff_policy' AND scope_type='global' AND scope_id IS NULL), 'retry_backoff_policy seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='schedule_policy' AND scope_type='global' AND scope_id IS NULL), 'schedule_policy seeded (global)');

-- Resolver returns non-null
SELECT ok(public.resolve_settings('response_policy','global',NULL) IS NOT NULL, 'resolve_settings returns response_policy');
SELECT ok(public.resolve_settings('error_policy','global',NULL) IS NOT NULL, 'resolve_settings returns error_policy');
SELECT ok(public.resolve_settings('idempotency_defaults','global',NULL) IS NOT NULL, 'resolve_settings returns idempotency_defaults');
SELECT ok(public.resolve_settings('rate_limit_policy','global',NULL) IS NOT NULL, 'resolve_settings returns rate_limit_policy');
SELECT ok(public.resolve_settings('retry_backoff_policy','global',NULL) IS NOT NULL, 'resolve_settings returns retry_backoff_policy');
SELECT ok(public.resolve_settings('schedule_policy','global',NULL) IS NOT NULL, 'resolve_settings returns schedule_policy');

SELECT finish();

ROLLBACK;


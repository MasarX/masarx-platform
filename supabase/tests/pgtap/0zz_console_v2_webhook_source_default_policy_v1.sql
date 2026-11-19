-- pgTAP: Console V2 webhook source default rate limit resolves from live DB
-- settings rows, not frontend seed-only data.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT is(
  (
    SELECT safe_missing_behavior
    FROM public.settings_category_registry
    WHERE category = 'webhook_source_default_policy'
  ),
  'hard_fail',
  'webhook_source_default_policy is registered as hard-fail'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'webhook_source_default_policy'
      AND version = 1
      AND is_active IS TRUE
      AND schema #>> '{properties,default_rate_limit_per_hour,type}' = 'integer'
  ),
  'webhook_source_default_policy has an active schema for default_rate_limit_per_hour'
);

SELECT is(
  (
    SELECT cached_value->>'default_rate_limit_per_hour'
    FROM public.settings
    WHERE category = 'webhook_source_default_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ),
  '1000',
  'global settings projection caches the webhook source rate-limit default'
);

SELECT is(
  (
    SELECT value->>'default_rate_limit_per_hour'
    FROM public.settings_versions
    WHERE category = 'webhook_source_default_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
  ),
  '1000',
  'approved current settings version stores the webhook source rate-limit default'
);

CREATE TEMP TABLE _webhook_source_default_policy_global AS
SELECT *
FROM public.resolve_settings_row_from_policy_context_v1(
  'webhook_source_default_policy',
  '{}'::jsonb
);

SELECT is(
  (SELECT value->>'default_rate_limit_per_hour' FROM _webhook_source_default_policy_global LIMIT 1),
  '1000',
  'settings resolver returns the global webhook source rate-limit default'
);

CREATE TEMP TABLE _webhook_source_default_policy_tenant AS
SELECT *
FROM public.resolve_settings_row_from_policy_context_v1(
  'webhook_source_default_policy',
  jsonb_build_object(
    'tenant',
    jsonb_build_object('id', '7e60f822-d019-4075-8090-d9970a729b15')
  )
);

SELECT is(
  (SELECT value->>'default_rate_limit_per_hour' FROM _webhook_source_default_policy_tenant LIMIT 1),
  '1000',
  'settings resolver falls back to global default for tenant context'
);

SELECT is(
  (
    SELECT settings_version_id::text
    FROM public.settings
    WHERE category = 'webhook_source_default_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ),
  (
    SELECT id::text
    FROM public.settings_versions
    WHERE category = 'webhook_source_default_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
    LIMIT 1
  ),
  'settings projection points at the approved current webhook source default version'
);

SELECT * FROM finish();

ROLLBACK;

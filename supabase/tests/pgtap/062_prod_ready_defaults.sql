-- Test Suite: Prod-ready defaults (contracts + global seeds)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(30);

-- Schema contracts present
SELECT ok(EXISTS(SELECT 1 FROM schema_registry WHERE category='api_caller_policy' AND version=1 AND is_active), 'schema_registry api_caller_policy v1 present');
SELECT ok(EXISTS(SELECT 1 FROM schema_registry WHERE category='campaign_policy' AND version=1 AND is_active), 'schema_registry campaign_policy v1 present');
SELECT ok(EXISTS(SELECT 1 FROM schema_registry WHERE category='domain_event_policy' AND version=1 AND is_active), 'schema_registry domain_event_policy v1 present');
SELECT ok(EXISTS(SELECT 1 FROM schema_registry WHERE category='webhook_intake' AND version=1 AND is_active), 'schema_registry webhook_intake v1 present');
SELECT ok(EXISTS(SELECT 1 FROM schema_registry WHERE category='renderer_defaults' AND version=1 AND is_active), 'schema_registry renderer_defaults v1 present');

-- Global settings rows present
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='api_caller_policy' AND scope_type='global' AND scope_id IS NULL), 'api_caller_policy seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='campaign_policy' AND scope_type='global' AND scope_id IS NULL), 'campaign_policy seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='domain_event_policy' AND scope_type='global' AND scope_id IS NULL), 'domain_event_policy seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='webhook_intake' AND scope_type='global' AND scope_id IS NULL), 'webhook_intake seeded (global)');
SELECT ok(EXISTS(SELECT 1 FROM settings WHERE category='renderer_defaults' AND scope_type='global' AND scope_id IS NULL), 'renderer_defaults seeded (global)');

-- Resolver returns non-null objects
SELECT ok(public.resolve_settings('api_caller_policy','global',NULL) IS NOT NULL, 'resolve_settings returns api_caller_policy');
SELECT ok(public.resolve_settings('campaign_policy','global',NULL) IS NOT NULL, 'resolve_settings returns campaign_policy');
SELECT ok(public.resolve_settings('domain_event_policy','global',NULL) IS NOT NULL, 'resolve_settings returns domain_event_policy');
SELECT ok(public.resolve_settings('webhook_intake','global',NULL) IS NOT NULL, 'resolve_settings returns webhook_intake');
SELECT ok(public.resolve_settings('renderer_defaults','global',NULL) IS NOT NULL, 'resolve_settings returns renderer_defaults');

-- Baseline values (prod-safe)
SELECT is((public.resolve_settings('api_caller_policy','global',NULL)->>'default_timeout_seconds')::int, 30, 'api_caller_policy default_timeout_seconds=30');
SELECT is((public.resolve_settings('campaign_policy','global',NULL)->>'enrollment_enabled')::boolean, false, 'campaign_policy enrollment disabled by default');
SELECT is(public.resolve_settings('domain_event_policy','global',NULL)->'defaults'->>'action', 'skip', 'domain_event_policy default action is skip');
SELECT is((public.resolve_settings('webhook_intake','global',NULL)->'defaults'->>'accepted_async_status')::int, 202, 'webhook_intake accepted_async_status=202');
SELECT is(public.resolve_settings('renderer_defaults','global',NULL)->>'fallback_title', 'MasarX Waybill', 'renderer_defaults fallback_title seeded');
SELECT is(public.resolve_settings('renderer_defaults','global',NULL)->>'brand_name', 'MasarX', 'renderer_defaults brand_name seeded');
SELECT is(public.resolve_settings('renderer_defaults','global',NULL)->>'template_key', 'waybill_v1', 'renderer_defaults template_key targets waybill_v1');

-- Derived payload view fields for label defaults
SELECT has_column('public', 'shipment_label_payload_v', 'payment_term_label', 'shipment_label_payload_v exposes payment_term_label');
SELECT has_column('public', 'shipment_label_payload_v', 'service_level_label', 'shipment_label_payload_v exposes service_level_label');
SELECT has_column('public', 'shipment_label_payload_v', 'cod_label', 'shipment_label_payload_v exposes cod_label');
SELECT has_column('public', 'shipment_label_payload_v', 'weight_label', 'shipment_label_payload_v exposes weight_label');
SELECT has_column('public', 'shipment_label_payload_v', 'destination_city_code', 'shipment_label_payload_v exposes destination_city_code');

-- resolve_label_template requires organization context; use a fresh org with no tenant overrides
-- to validate global fallback behaviour deterministically. Seed the minimal sender/client context
-- before onboarding so fail-closed plugin activation has a truthful source binding.
DO $$
DECLARE
  v_org_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_sender_id UUID := gen_random_uuid();
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (
    v_org_id,
    'Prod Ready Defaults Org',
    format('prod-defaults-%s', substr(v_org_id::text, 1, 8)),
    'Asia/Riyadh',
    'en-US',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (
    v_client_id,
    v_org_id,
    'Prod Ready Defaults Client',
    format('prod-defaults-client-%s', substr(v_client_id::text, 1, 8)),
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender_id,
    v_client_id,
    'Prod Ready Defaults Sender',
    'Prod Ready Defaults Sender',
    TRUE,
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:prod-ready-defaults-fixture-bootstrap'
  );

  PERFORM set_config('pgtap.label_defaults_org_id', v_org_id::text, true);
END $$;

-- Label default wiring
SELECT is(
  (
    SELECT template_snapshot ->> 'template_key'
    FROM resolve_label_template(current_setting('pgtap.label_defaults_org_id')::uuid, NULL::uuid, NULL::uuid, 'shipping')
    LIMIT 1
  ),
  'waybill_v1',
  'Global label template_key is waybill_v1'
);

SELECT ok(
  (
    SELECT template_snapshot -> 'renderer_config' -> 'assets' -> 0 ->> 'path'
    FROM resolve_label_template(current_setting('pgtap.label_defaults_org_id')::uuid, NULL::uuid, NULL::uuid, 'shipping')
    LIMIT 1
  )::text LIKE '%logo%.png',
  'Label template logo asset path present'
);

SELECT cmp_ok(
  (
    SELECT jsonb_array_length(template_snapshot -> 'renderer_config' -> 'blocks')
    FROM resolve_label_template(current_setting('pgtap.label_defaults_org_id')::uuid, NULL::uuid, NULL::uuid, 'shipping')
    LIMIT 1
  ),
  '>=',
  10,
  'Label template includes structured block layout'
);

SELECT finish();

ROLLBACK;

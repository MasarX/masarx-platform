-- Migration: test webhook source seed
-- Purpose: Ensure canonical test organization/client/sender/mapping/webhook_source
--          used by policy ladder pgTAP suites exist in all environments.
-- Context:
--   - Parent (mhln) contains manually seeded test fixtures that are referenced by
--     pgTAP (e.g. webhook source d78922af-...).
--   - Fresh branch/projects created from the repo migrations were missing these rows,
--     causing pgTAP failures (webhook source not found).
--   - This migration backfills those fixtures in an idempotent, non-destructive way.

BEGIN;

-------------------------------------------------------------------------------
-- 1. Organization: Test Organization Alpha
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test tenant fixture id, used only in tests */
INSERT INTO organizations (id, name, slug, timezone, locale, default_settings, billing_status)
SELECT
  'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  'Test Organization Alpha',
  'test-org-alpha',
  'Asia/Riyadh',
  'ar-SA',
  NULL,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM organizations WHERE id = 'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid
);

-------------------------------------------------------------------------------
-- 2. Client under Test Organization Alpha
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test client fixture id, used only in tests */
INSERT INTO clients (id, organization_id, name, slug, sla_tier, settings_override, status)
SELECT
  'd68fbb7c-9b5e-4a1d-8df0-57e78a57c993'::uuid,
  'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  'البشيري, الطريقي and الشتيوي',
  'test-client-1-1',
  'economy',
  '{}'::jsonb,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM clients WHERE id = 'd68fbb7c-9b5e-4a1d-8df0-57e78a57c993'::uuid
);

-------------------------------------------------------------------------------
-- 3. Sender fixture for webhook source tests
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test sender fixture id, used only in tests */
INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, settings_override, status)
SELECT
  'd1a90236-2ed4-4b55-9bc3-16a7500eea93'::uuid,
  'd68fbb7c-9b5e-4a1d-8df0-57e78a57c993'::uuid,
  'عنون Group',
  'Realigned user-facing implementation',
  FALSE,
  TRUE,
  '{}'::jsonb,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM senders WHERE id = 'd1a90236-2ed4-4b55-9bc3-16a7500eea93'::uuid
);

-------------------------------------------------------------------------------
-- 4. Mapping config for basic shipment.created inbound webhook
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test mapping id, used only in tests */
INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
SELECT
  '8ae0b582-1a63-467c-b3ab-c4208dfd0a20'::uuid,
  'webhook_inbound',
  'test-basic-source::shipment.created',
  jsonb_build_object(
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'status', 'shipment.status',
        'delivered_at', 'shipment.delivered_at',
        'tracking_number', 'shipment.tracking_number'
      )
    ),
    'description', 'Basic shipment.created mapping for integration tests',
    'event_type_path', 'event.type',
    'external_id_path', 'event.id'
  ),
  2,
  'Basic shipment.created mapping for integration tests'
WHERE NOT EXISTS (
  SELECT 1 FROM mapping_configs WHERE id = '8ae0b582-1a63-467c-b3ab-c4208dfd0a20'::uuid
);

-------------------------------------------------------------------------------
-- 5. Webhook source fixture used by policy ladder tests
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test webhook source id, used only in tests */
INSERT INTO webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id,
  auth_token_hash
)
SELECT
  'd78922af-ce74-4d3f-88cc-0a0640a6bd2d'::uuid,
  'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  'test-basic-source',
  'Test Shopify Webhook Source',
  'shopify',
  NULL,
  '8ae0b582-1a63-467c-b3ab-c4208dfd0a20'::uuid,
  1000,
  TRUE,
  'd1a90236-2ed4-4b55-9bc3-16a7500eea93'::uuid,
  '$2a$06$wvyqiYwfwPhMb36p.L04Qed0.8zL6MS7f3Mq2J9nJ0oZLX2l8vrKG'
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE id = 'd78922af-ce74-4d3f-88cc-0a0640a6bd2d'::uuid
);

COMMIT;


-- Migration: HERE provider mock flag and baseline webhook sources
-- Purpose:
--   1) Enable mock responses for the HERE geocoding provider in dev/test
--      environments by setting providers.metadata.mock = true when not set.
--   2) Ensure baseline webhook sources used by webhook-ingest integration
--      tests exist: test-basic-source, test-hmac-source, test-async-source.

BEGIN;

-- 1) HERE provider mock flag (do not override explicit non-mock configs)
UPDATE providers
SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{mock}',
    'true'::jsonb,
    TRUE
)
WHERE name = 'here_geocoding'
  AND COALESCE(metadata->>'mock', '') = '';

-- 2) Baseline webhook sources under Test Organization Alpha

-- HMAC and async sources re-use Test Organization Alpha client/sender and
-- dedicated mappings. Basic source is already seeded by 202511261340.

-- Ensure HMAC mapping exists
INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
SELECT
  '8ae0b582-1a63-467c-b3ab-c4208dfd0a21'::uuid,
  'webhook_inbound',
  'test-hmac-source::shipment.created',
  jsonb_build_object(
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'status', 'shipment.status',
        'delivered_at', 'shipment.delivered_at',
        'tracking_number', 'shipment.tracking_number'
      )
    ),
    'description', 'HMAC shipment.created mapping for integration tests',
    'event_type_path', 'event.type',
    'external_id_path', 'event.id'
  ),
  1,
  'HMAC shipment.created mapping for integration tests'
WHERE NOT EXISTS (
  SELECT 1 FROM mapping_configs WHERE id = '8ae0b582-1a63-467c-b3ab-c4208dfd0a21'::uuid
);

-- Ensure async mapping exists
INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
SELECT
  '8ae0b582-1a63-467c-b3ab-c4208dfd0a22'::uuid,
  'webhook_inbound',
  'test-async-source::shipment.created',
  jsonb_build_object(
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'status', 'shipment.status',
        'delivered_at', 'shipment.delivered_at',
        'tracking_number', 'shipment.tracking_number'
      )
    ),
    'description', 'Async shipment.created mapping for integration tests',
    'event_type_path', 'event.type',
    'external_id_path', 'event.id'
  ),
  1,
  'Async shipment.created mapping for integration tests'
WHERE NOT EXISTS (
  SELECT 1 FROM mapping_configs WHERE id = '8ae0b582-1a63-467c-b3ab-c4208dfd0a22'::uuid
);

-- HMAC webhook source
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
  sender_id
)
SELECT
  '2bdad0d1-400b-4370-a303-6912e8d4db7e'::uuid,
  'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  'test-hmac-source',
  'HMAC Test Webhook Source',
  'erp',
  'EXAMPLE_PASSWORD',
  '8ae0b582-1a63-467c-b3ab-c4208dfd0a21'::uuid,
  1000,
  TRUE,
  'd1a90236-2ed4-4b55-9bc3-16a7500eea93'::uuid
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE id = '2bdad0d1-400b-4370-a303-6912e8d4db7e'::uuid
);

-- Async webhook source
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
  sender_id
)
SELECT
  '4d411726-4124-4e38-93fe-134196649901'::uuid,
  'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  'test-async-source',
  'Async Test Webhook Source',
  'shopify',
  'EXAMPLE_PASSWORD',
  '8ae0b582-1a63-467c-b3ab-c4208dfd0a22'::uuid,
  1000,
  TRUE,
  'd1a90236-2ed4-4b55-9bc3-16a7500eea93'::uuid
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE id = '4d411726-4124-4e38-93fe-134196649901'::uuid
);

COMMIT;

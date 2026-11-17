-- Migration: seed webhook sources for per-client ACK testing

BEGIN;

SET search_path TO public, pg_temp;

-- Safe, row-driven inserts: only create sources when referenced org/mapping rows exist.
-- This avoids FK violations and keeps idempotent behavior.

WITH org_a AS (
  SELECT id AS organization_id FROM organizations WHERE id = 'ce455733-0968-43c4-b0d6-5bc027638d70'::uuid
), map AS (
  SELECT id AS mapping_config_id FROM mapping_configs WHERE id = '8ae0b582-1a63-467c-b3ab-c4208dfd0a20'::uuid
)
INSERT INTO webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token,
    mapping_config_id, rate_limit_per_hour, enabled, sender_id
)
SELECT
  'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1'::uuid,
  org_a.organization_id,
  'test-client-a-ack',
  'Test Client A ACK Source',
  'shopify',
  'client-a-ack-token',
  map.mapping_config_id,
  1000,
  TRUE,
  'a1a88f3d-195d-4df2-918b-1495458314f0'::uuid
FROM org_a, map
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE source_identifier = 'test-client-a-ack'
);

WITH org_b AS (
  SELECT id AS organization_id FROM organizations WHERE id = 'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid
), map AS (
  SELECT id AS mapping_config_id FROM mapping_configs WHERE id = '8ae0b582-1a63-467c-b3ab-c4208dfd0a20'::uuid
)
INSERT INTO webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token,
    mapping_config_id, rate_limit_per_hour, enabled, sender_id
)
SELECT
  'd6f62df9-1395-481c-baab-3c709f5a7b6f'::uuid,
  org_b.organization_id,
  'test-client-b-ack',
  'Test Client B ACK Source',
  'shopify',
  'EXAMPLE_PASSWORD',
  map.mapping_config_id,
  1000,
  TRUE,
  '0986fb8b-4197-49ed-a3b9-72be37a9a736'::uuid
FROM org_b, map
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE source_identifier = 'test-client-b-ack'
);

COMMIT;

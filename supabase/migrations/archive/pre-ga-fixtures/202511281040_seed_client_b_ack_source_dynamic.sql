-- Migration: Seed webhook source for Client B ACK tests (dynamic)
-- Purpose:
--   Provide a webhook_sources row with auth_token=EXAMPLE_PASSWORD wired
--   to an existing Test Organization Alpha client/sender so ACK mapping
--   tests can exercise workflow_intake_webhook end-to-end.

BEGIN;

SET search_path TO public, pg_temp;

WITH org_b AS (
  SELECT id AS organization_id
  FROM organizations
  WHERE slug = 'test-org-alpha'
  LIMIT 1
), client_b AS (
  SELECT c.id AS client_id, c.organization_id
  FROM clients c
  JOIN org_b o ON o.organization_id = c.organization_id
  ORDER BY c.created_at
  LIMIT 1
), sender_b AS (
  SELECT s.id AS sender_id, s.client_id
  FROM senders s
  JOIN client_b c ON c.client_id = s.client_id
  ORDER BY s.created_at
  LIMIT 1
), mapping AS (
  SELECT id AS mapping_config_id
  FROM mapping_configs
  WHERE id = '8ae0b582-1a63-467c-b3ab-c4208dfd0a20'::uuid
  LIMIT 1
)
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
  'd6f62df9-1395-481c-baab-3c709f5a7b6f'::uuid,
  c.organization_id,
  'test-client-b-ack',
  'Test Client B ACK Source (dynamic)',
  'shopify',
  'EXAMPLE_PASSWORD',
  m.mapping_config_id,
  1000,
  TRUE,
  s.sender_id
FROM client_b c
JOIN sender_b s ON s.client_id = c.client_id
JOIN mapping m ON TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE auth_token = 'EXAMPLE_PASSWORD'
);

COMMIT;


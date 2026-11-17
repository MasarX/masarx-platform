-- Migration: webhook policy ladder seed
-- Purpose: Backfill canonical webhook ingest policy ladder fixtures used by pgTAP
--          (035_policy_ladder.sql) so that all environments (local and cloud)
--          behave identically to the parent project.
-- Context:
--   - Parent (mhln) has manually seeded fixtures for:
--       - Automation QA organization + Client A ACK org / client
--       - Senders and webhook_sources for source/client/global ladder tests
--       - settings_versions + settings rows for webhook_ingest_policy
--   - Fresh databases built from migrations only were missing these rows,
--     causing ladder tests to fail or raise "webhook source not found".
--   - This migration seeds those fixtures in an idempotent, non-destructive way.

BEGIN;

-------------------------------------------------------------------------------
-- 1. Automation QA Organization (ce455733-...)
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical automation QA org id for ladder tests */
INSERT INTO organizations (id, name, slug, timezone, locale, default_settings, billing_status)
SELECT
  'ce455733-0968-43c4-b0d6-5bc027638d70'::uuid,
  'Automation QA Organization',
  'automation-qa-org',
  'Asia/Riyadh',
  'ar-SA',
  NULL,
  'active'
WHERE NOT EXISTS (
  -- Use slug as the idempotent key to avoid duplicate-key errors when an
  -- Automation QA org has already been seeded by earlier migrations.
  -- This keeps the seed non-destructive for existing environments while
  -- still creating the canonical row on fresh databases.
  SELECT 1 FROM organizations WHERE slug = 'automation-qa-org'
);

-------------------------------------------------------------------------------
-- 2. Client A ACK Org + Client A
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical ACK org/client used only in tests */
INSERT INTO organizations (id, name, slug, timezone, locale, default_settings, billing_status)
SELECT
  '32a8d616-d270-4a8e-8f15-010fa3c209c2'::uuid,
  'Client A ACK Org',
  'ack-org-a-mhz878ke-p4lt',
  'Asia/Riyadh',
  'en-US',
  NULL,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM organizations WHERE id = '32a8d616-d270-4a8e-8f15-010fa3c209c2'::uuid
);

INSERT INTO clients (id, organization_id, name, slug, sla_tier, settings_override, status)
SELECT
  '2d075f66-1617-4a13-bddf-224a26edfa88'::uuid,
  '32a8d616-d270-4a8e-8f15-010fa3c209c2'::uuid,
  'Client A',
  'ack-client-a-mhz878pb-r821',
  'standard',
  '{}'::jsonb,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM clients WHERE id = '2d075f66-1617-4a13-bddf-224a26edfa88'::uuid
);

-------------------------------------------------------------------------------
-- 3. Additional client/sender under Test Organization Alpha (client-1-3)
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical client fixture id used only in tests */
INSERT INTO clients (id, organization_id, name, slug, sla_tier, settings_override, status)
SELECT
  '8e8a4604-a0ef-4c02-87b2-db66ef3a60b1'::uuid,
  'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  'زروق - النجار',
  'test-client-1-3',
  'standard',
  '{}'::jsonb,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM clients WHERE id = '8e8a4604-a0ef-4c02-87b2-db66ef3a60b1'::uuid
);

/* objectives:allow TENANT_LITERAL Justification: canonical sender fixture ids used only in tests */
INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, settings_override, status)
SELECT
  'b254db5d-3cf4-4bed-9653-8b60e7f0f896'::uuid,
  '8e8a4604-a0ef-4c02-87b2-db66ef3a60b1'::uuid,
  'الطويل, البشيري and الصفار',
  'Re-engineered regional matrix',
  FALSE,
  FALSE,
  '{}'::jsonb,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM senders WHERE id = 'b254db5d-3cf4-4bed-9653-8b60e7f0f896'::uuid
);

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, settings_override, status)
SELECT
  '4704c01b-8cf6-44ab-8ccd-7f11d991861e'::uuid,
  '2d075f66-1617-4a13-bddf-224a26edfa88'::uuid,
  'Client A Sender',
  'Client A Sender Brand',
  FALSE,
  FALSE,
  '{}'::jsonb,
  'active'
WHERE NOT EXISTS (
  SELECT 1 FROM senders WHERE id = '4704c01b-8cf6-44ab-8ccd-7f11d991861e'::uuid
);

-------------------------------------------------------------------------------
-- 4. ACK response mapping used by client/source policies
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test mapping id used only in ladder tests */
INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
SELECT
  '99990000-0000-0000-0000-000000400001'::uuid,
  'webhook_response',
  'client_ack::logestechs_v1',
  '{
    "body": {
      "status": "accepted",
      "resource_id": "{{ resource.id }}",
      "tracking_number": "{{ resource.tracking_number }}",
      "workflow_run_id": "{{ workflow_run_id }}"
    },
    "headers": {
      "content-type": "application/json",
      "x-client-ack": "logestechs"
    },
    "status_code": 200
  }'::jsonb,
  153,
  'Per-client ACK body for Logestechs Automation Client 2'
WHERE NOT EXISTS (
  SELECT 1 FROM mapping_configs WHERE id = '99990000-0000-0000-0000-000000400001'::uuid
);

-------------------------------------------------------------------------------
-- 5. Webhook sources for client and source ladder tests
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test webhook source ids used only in ladder tests */
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
  'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1'::uuid,
  'ce455733-0968-43c4-b0d6-5bc027638d70'::uuid,
  'test-client-a-ack',
  'Test Client A ACK Source',
  'shopify',
  NULL,
  '99990000-0000-0000-0000-000000400001'::uuid,
  1000,
  TRUE,
  '4704c01b-8cf6-44ab-8ccd-7f11d991861e'::uuid,
  '$2a$06$R3L4geNvu1O94SWAkaiTperSyxhAwb..0jogoiiu.0258X7xkZeJS'
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE id = 'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1'::uuid
);

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
  'd428eb7a-f019-4a29-8d8d-ebc19e625871'::uuid,
  'e5e9cafd-e2fc-4a55-8294-dd792ec8303a'::uuid,
  'test-client-1-3-webhook',
  'Client test-client-1-3 Webhook Source',
  'shopify',
  NULL,
  '8ae0b582-1a63-467c-b3ab-c4208dfd0a20'::uuid,
  1000,
  TRUE,
  'b254db5d-3cf4-4bed-9653-8b60e7f0f896'::uuid,
  '$2a$06$PCxSfpu1uKjkFttV.1iHXutTvS7tkOJT/t0AXBf1X2uKDJWmPU0VW'
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_sources WHERE id = 'd428eb7a-f019-4a29-8d8d-ebc19e625871'::uuid
);

-------------------------------------------------------------------------------
-- 6. settings_versions + settings rows for webhook_ingest_policy ladder
-------------------------------------------------------------------------------

/* objectives:allow TENANT_LITERAL Justification: canonical test settings_version ids used only in ladder tests */
INSERT INTO settings_versions (id, category, scope_type, scope_id, version, value)
SELECT
  '77770000-0000-0000-0000-000000000001'::uuid,
  'webhook_ingest_policy',
  'global',
  NULL,
  1,
  '{
    "ack": {
      "mode": "accepted_async",
      "status_code": 202,
      "default_headers": {
        "content-type": "application/json"
      }
    },
    "schema": {
      "version": "v1",
      "registry": "schema_registry"
    },
    "logging": {
      "decision_point": "workflow_intake_response"
    },
    "version": 1,
    "workflow": {
      "intent": "shipment_create"
    },
    "validation": {
      "idempotency": {
        "body_path": "event.id"
      }
    }
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM settings_versions WHERE id = '77770000-0000-0000-0000-000000000001'::uuid
);

INSERT INTO settings_versions (id, category, scope_type, scope_id, version, value)
SELECT
  'd4dbfc16-7a73-4cec-92ce-741a755bc526'::uuid,
  'webhook_ingest_policy',
  'client',
  '2d075f66-1617-4a13-bddf-224a26edfa88'::uuid,
  1,
  '{
    "ack": {
      "mode": "synchronous_success",
      "status_code": 200,
      "response_mapping_id": "99990000-0000-0000-0000-000000400001"
    },
    "workflow": {
      "intent": "shipment_create"
    },
    "validation": {
      "idempotency": {
        "body_path": "event.id"
      }
    }
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM settings_versions WHERE id = 'd4dbfc16-7a73-4cec-92ce-741a755bc526'::uuid
);

INSERT INTO settings_versions (id, category, scope_type, scope_id, version, value)
SELECT
  'daa0f007-96c6-476e-8110-12ba52ee102d'::uuid,
  'webhook_ingest_policy',
  'source',
  'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1'::uuid,
  1,
  '{
    "ack": {
      "mode": "synchronous_success",
      "status_code": 200,
      "default_headers": {
        "content-type": "application/json"
      },
      "response_mapping_id": "99990000-0000-0000-0000-000000400001"
    },
    "schema": {
      "version": "v1",
      "registry": "schema_registry"
    },
    "workflow": {
      "intent": "shipment_create"
    },
    "validation": {
      "idempotency": {
        "body_path": "event.id"
      }
    }
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM settings_versions WHERE id = 'daa0f007-96c6-476e-8110-12ba52ee102d'::uuid
);

/* objectives:allow TENANT_LITERAL Justification: canonical test settings ids used only in ladder tests */
INSERT INTO settings (id, category, scope_type, scope_id, settings_version_id, cached_value)
SELECT
  '66660000-0000-0000-0000-000000000001'::uuid,
  'webhook_ingest_policy',
  'global',
  NULL,
  '77770000-0000-0000-0000-000000000001'::uuid,
  '{
    "ack": {
      "mode": "accepted_async",
      "status_code": 202,
      "default_headers": {
        "content-type": "application/json"
      }
    },
    "schema": {
      "version": "v1",
      "registry": "schema_registry"
    },
    "logging": {
      "decision_point": "workflow_intake_response"
    },
    "version": 1,
    "workflow": {
      "intent": "shipment_create"
    },
    "validation": {
      "idempotency": {
        "body_path": "event.id"
      }
    }
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM settings WHERE id = '66660000-0000-0000-0000-000000000001'::uuid
);

INSERT INTO settings (id, category, scope_type, scope_id, settings_version_id, cached_value)
SELECT
  'b93606ec-90fe-4387-bcc7-6ec00aaa8707'::uuid,
  'webhook_ingest_policy',
  'client',
  '2d075f66-1617-4a13-bddf-224a26edfa88'::uuid,
  'd4dbfc16-7a73-4cec-92ce-741a755bc526'::uuid,
  '{
    "ack": {
      "mode": "synchronous_success",
      "status_code": 200,
      "response_mapping_id": "99990000-0000-0000-0000-000000400001"
    },
    "workflow": {
      "intent": "shipment_create"
    },
    "validation": {
      "idempotency": {
        "body_path": "event.id"
      }
    }
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM settings WHERE id = 'b93606ec-90fe-4387-bcc7-6ec00aaa8707'::uuid
);

INSERT INTO settings (id, category, scope_type, scope_id, settings_version_id, cached_value)
SELECT
  '8586ef5c-9737-46bb-8627-549dbc78afc7'::uuid,
  'webhook_ingest_policy',
  'source',
  'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1'::uuid,
  'daa0f007-96c6-476e-8110-12ba52ee102d'::uuid,
  '{
    "ack": {
      "mode": "synchronous_success",
      "status_code": 200,
      "default_headers": {
        "content-type": "application/json"
      },
      "response_mapping_id": "99990000-0000-0000-0000-000000400001"
    },
    "schema": {
      "version": "v1",
      "registry": "schema_registry"
    },
    "workflow": {
      "intent": "shipment_create"
    },
    "validation": {
      "idempotency": {
        "body_path": "event.id"
      }
    }
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM settings WHERE id = '8586ef5c-9737-46bb-8627-549dbc78afc7'::uuid
);

COMMIT;

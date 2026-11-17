-- Migration: Set global webhook_ingest_policy to accepted_async by default
-- Purpose: Align global policy with async acceptance (202) expected by integration tests
-- Notes:
--  - Uses upsert_webhook_ingest_policy helper to respect versioning and scope ladder
--  - Points response_mapping_id to global::ack_async_v1 (202)
--  - Idempotent: running multiple times will create/point to the latest version

BEGIN;

SET search_path TO public;

-- Define the desired policy payload (ack mode accepted_async, 202 mapping)
WITH desired AS (
  SELECT $$
  {
    "version": 2,
    "ack": {
      "mode": "accepted_async",
      "status_code": 202,
      "response_mapping_id": "88880000-0000-0000-0000-000000000002",
      "default_headers": { "cache-control": "no-store" }
    },
    "validation": {
      "idempotency": {
        "header": "Idempotency-Key",
        "dedupe_window_seconds": 3600
      }
    },
    "workflow": null,
    "logging": {
      "decision_point": "http_response",
      "include_payload": false
    }
  }
  $$::jsonb AS policy
),
needed AS (
  SELECT 1
  WHERE NOT EXISTS (
    SELECT 1 FROM settings_versions
    WHERE category = 'webhook_ingest_policy' AND scope_type = 'global'
  )
)
SELECT upsert_webhook_ingest_policy('global', NULL, desired.policy)
FROM desired, needed;

COMMIT;

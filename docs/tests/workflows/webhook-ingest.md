# Workflow: Webhook Ingestion & HTTP Response Persistence

## Overview

This workflow covers the path from an inbound webhook hitting the edge function to the workflow-engine owned persistence layers (`webhook_inbox`, `webhook_response_events`, `webhook_response_latest`, `decision_log`). The seed baseline registers two webhook sources:

| Source | Token | Mapping | Policy |
| --- | --- | --- | --- |
| `test-basic-source` | `EXAMPLE_PASSWORD` | `webhook_inbound / test-basic-source::shipment.created` | Global policy (synchronous response, no HMAC) |
| `test-hmac-source` | `EXAMPLE_PASSWORD` | `webhook_inbound / test-hmac-source::shipment.created` | Source-level policy (HMAC-SHA256 + idempotency) |

## Scenarios & Automation

| Scenario | Payload Fixture | Command | Assertions |
| --- | --- | --- | --- |
| Basic webhook, synchronous response | `tests/fixtures/webhooks/basic_shipment_created.json` | `npm test` (`tests/integration/webhook-ingest.test.js`) | HTTP 200, `webhook_inbox.processing_status = in_progress`, `webhook_response_events.http_status_code = 200`, `response_outcome = response_sent` |
| JSON Schema toggle | Same payload with policy `validation.json_schema_id` set | `npm run test:integration -- tests/integration/webhook-ingest-schema.test.js` | Response records `validation_results.json_schema` (skipped/passed/failed); status remains 2xx unless validation enforces fail |
| HMAC success | `tests/fixtures/webhooks/hmac_shipment_created.json` (signed with seed secret) | `npm test` | HTTP 200, `validation_results.hmac.status = passed`, response history status 200 |
| HMAC failure | Same payload with wrong signature | `npm test` | HTTP 400, response history status 400 and outcome `response_failed` |
| Throughput & latency | Generated inline by k6 | `npm run test:load:cloud` | Env-driven (e.g. PARTITION_VUS=10, p95 < PARTITION_P95_MS) |

## Current Contract Notes

- `x-correlation-id` is the persisted intake correlation SSOT surfaced back by the edge wrappers. The HTTP tests assert it matches `webhook_inbox.correlation_id` for the same intake.
- The edge wrappers normalize both the response header and ACK body from the persisted `webhook_inbox.correlation_id` so downstream logs, retries, and body assertions stay in lockstep with the stored intake row.
- The current core RPC still returns `correlation_id` in the ACK body payload rather than as a top-level response field, so the wrappers keep the payload-compatible fallback for cases where the direct row read is unavailable.
- `shipment_return` currently reserves identifiers and returns a `resource` payload in the ACK body.
- Per-client ACK mapping coverage is currently exercised with `accepted_async`/`202` semantics.

## Manual SQL Verification

```sql
-- Webhook inbox entry (baseline metadata)
SELECT provider_type, processing_status, idempotency_key
FROM webhook_inbox
WHERE webhook_source_id = (
  SELECT id
  FROM webhook_sources
  WHERE organization_id = :organization_id
    AND source_identifier = 'test-basic-source'
)
ORDER BY created_at DESC
LIMIT 1;

-- Latest HTTP response snapshot (projection view)
SELECT http_status_code, response_outcome, response_reason
FROM webhook_response_latest
WHERE webhook_inbox_id = :webhook_inbox_id;

-- Response history / audit trail
SELECT http_status_code, response_outcome, validation_results
FROM webhook_response_events
WHERE webhook_source_id = (
  SELECT id
  FROM webhook_sources
  WHERE organization_id = :organization_id
    AND source_identifier = 'test-hmac-source'
)
ORDER BY created_at DESC;

-- Decision log trail
SELECT decision_point, decision_outcome, decision_inputs->>'processing_time_ms'
FROM decision_log
WHERE resource_type = 'webhook_inbox'
ORDER BY timestamp DESC
LIMIT 5;

-- Follow-up workflow audit
SELECT sequence_order, step_status, decision_log_id
FROM workflow_run_steps
WHERE workflow_run_id = :workflow_run_id
ORDER BY sequence_order;
```

## Extending Coverage

1. Add new payload fixtures under `tests/fixtures/webhooks/`.
2. Insert provider/source/policy rows in the seed script with deterministic identifiers.
3. Add Jest tests mirroring the fixture name and expected behaviour (e.g., throttle errors, async response).
4. Document the scenario here (table + SQL snippet).

By keeping the seed data and documentation aligned, webhook regression tests remain deterministic and easy to reason about.

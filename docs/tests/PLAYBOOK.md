# Testing Playbook


- Start from a clean environment before executing scenarios:
  - Cloud (recommended for destructive testing): `npm run cloud:provision` (project-per-workspace)
  - Local (optional): `npm run local:start` then `npx supabase@2 db reset --yes`
- Seed the deterministic baseline: `ENV_FILE=config/env/.env.cloud node scripts/data/seed-test-data.js <volume>` (or `ENV_FILE=config/env/.env.local ...` for local).
- When the product blueprint changes, update this document and the automation backlog in the same commit.

## Execution Overview

1. Environment check:
   - Cloud: `config/env/.env.cloud` present (and org tokens available if provisioning).
   - Local: Docker Desktop, Supabase CLI, Node.js 18+, psql.
2. Reset/provision and seed: provision an isolated cloud project (preferred) or reset a local stack, then run `node scripts/data/seed-test-data.js <volume>` (see `docs/tests/SEED_BASELINES.md`).
3. Automation wave: run the canonical gate (`npm test` -> `npm run verify:cloud:core`) and any targeted commands listed per scenario.
4. Manual validation: execute the SQL or API checks noted per scenario, confirm UI dashboards where relevant.
5. Log verification: confirm that `decision_log`, `settings_resolution_log`, `workflow_execution_log`, and other audit tables contain the expected entries.
6. Evidence capture: archive logs, SQL exports, and screenshots using the scenario IDs.

### Cloud Supabase Runs

- Ensure `config/env/.env.cloud` is present (or set `ENV_FILE=config/env/.env.cloud` in your shell).
- Prefer a fresh isolated project when you need a clean slate: `npm run cloud:provision -- "<workspace-name>"`.
- Apply migrations (included in the gate): `npm run db:push`.
- Deploy edge functions + secrets (included in the gate): `npm run deploy:edge`.
- Run the hosted automation wave (canonical gate):
  ```bash
  npm test # alias for npm run verify:cloud:core
  ```
  Note: `verify:cloud:core` deploys edge functions before running integration suites that hit `/functions/v1/*` so tests always run against the repo's deployed code.
- Seed additional fixtures when a scenario needs it: `node scripts/data/seed-test-data.js 100` (or `10000` for larger flows).
- When debugging, prefer the RPC helpers added on 2025-10-15 (`count_api_call_log()`, `get_recent_outbound_calls(p_limit)`, `get_webhook_source_by_token(p_token)`) instead of ad-hoc SQL.
- If duplicate webhook tests fail, confirm the `webhook_ingest_policy` ladder has either a per-source idempotency override or that the client sends `Idempotency-Key` headers (global policy uses headers by default).

## Combined workflow scenarios

Use an isolated test environment and one generated shipment identifier per run. Carry that identifier through each step and use it to correlate the persisted evidence.

| Scenario | Steps | Evidence |
| --- | --- | --- |
| Synchronous intake | WH-001, WH-006, SHP-001, GEO-001, LAB-001 | One shipment, the expected HTTP acknowledgment, an address resolution result and a generated label |
| Asynchronous intake | WH-004, WH-002, SHP-001, OUT-002 | One durable workflow across repeated requests and a callback linked to it |
| Communications failover | COM-001, COM-002, COM-003, COM-004 | The correct locale, a recorded budget decision and a traceable failover |

Use the individual scenario entries to distinguish existing automated coverage from manual verification.

## How to Read Each Scenario

- Use case: behaviour being validated.
- Config references: product documentation anchors.
- Preconditions: data, fixtures, or feature toggles required.
- Automation: commands or suites (Existing, Planned, Gap).
- Manual validation: SQL or API checks for state transitions.
- Log expectations: specific log tables or triggers that must fire.
- Evidence target: suggested file name for archived proof.
- Coverage status: Existing, Planned (extension required), or Gap (no automation yet).

### 1. Platform Setup and Configuration Governance

#### SETUP-001 - Baseline migrations and deterministic seed
- Use case: Replay migrations within SLA and hydrate canonical orgs, clients, and webhook infrastructure.
- Automation: Provision/reset a clean environment, then run `node scripts/data/seed-test-data.js 10000` and `npm run test:pgtap` (Existing).
- Manual validation:
  - `SELECT COUNT(*) FROM organizations;`
  - `SELECT scope_type, scope_id FROM settings WHERE category = 'webhook_ingest_policy';`
- Log expectations: `schema_migration_log` records migration batches and `seed_run_log` captures seeding stages.
- Coverage status: Existing.

#### SETUP-002 - Settings ladder and overrides per tenant or sender
- Use case: Confirm the registry-driven override ladder (default order `Global < Tenant < Client < Sender < Source/Resource`) resolves policies correctly.
- Preconditions: Clear cache via `TRUNCATE settings_cache`.
- Automation: `npm test -- --testNamePattern="settings resolution"` (`tests/integration/settings-resolution.test.js`, Existing).
- Manual validation: Inspect `settings_cache` and `settings_resolution_log` for each sender.
- Coverage status: Existing.

#### SETUP-003 - RBAC ladders and role isolation
- Use case: Ensure Supabase roles (service, anon, client) respect the RLS matrix.
- Preconditions: JWT fixtures in `tests/fixtures/auth/`.
- Automation: Extend `tests/integration/rls-policies.test.js` to impersonate each role (Planned).
- Manual validation: Run `SELECT * FROM shipments LIMIT 5;` using each JWT via PostgREST; compare row visibility (partition leaves remain service-role only).
- Coverage status: Gap.

#### SETUP-004 - Client workflow policy baselines
- Use case: Seed deterministic geocoding/comms/callback/3PL settings per client to exercise all workflow branches.
- Preconditions: `node scripts/data/seed-test-data.js` executed.
- Automation: `tests/integration/workflows/policy-seeding.test.js` (Existing) verifies seeded JSON matches provider IDs.
- Manual validation: `SELECT slug, category, cached_value FROM settings WHERE scope_type = 'client';`.
- Log expectations: `decision_log` logs downstream workflow actions using these policies.
- Coverage status: Existing.

### 2. Inbound Webhook Processing

#### WH-001 - Provider A synchronous 200 ACK
- Use case: Shopify-style webhook (`test-basic-source`) returns HTTP 200 and persists an inbox row.
- Preconditions: Bearer token `EXAMPLE_PASSWORD`, mapping `test-basic-source::shipment.created`.
- Automation: `npm test -- --testNamePattern="basic webhook"` (Existing).
- Manual validation:
  - `SELECT processing_status FROM webhook_inbox WHERE webhook_source_id = (SELECT id FROM webhook_sources WHERE organization_id = :organization_id AND source_identifier = 'test-basic-source') ORDER BY created_at DESC LIMIT 1;`
- Coverage status: Existing.

#### WH-002 - Duplicate replay idempotency
- Use case: Replay with identical idempotency key is ignored after the first success.
- Config references: `docs/tests/workflows/webhook-ingest.md:16`, `docs/tests/providers/shopify.md:36`.
- Preconditions: Execute WH-001 first.
- Automation: `npm test -- --testNamePattern="duplicate replay"` (Existing).
- Manual validation:
  - `SELECT response_outcome FROM webhook_response_events WHERE idempotency_key = '<event-id>' ORDER BY response_created_at;`
- Log expectations: `decision_log` entry `decision_outcome='duplicate_ignored'`, no `alert_events` triggered.
- Coverage status: Existing.

#### WH-003 - Invalid token rejection
- Use case: Unauthorized webhook request is rejected without persistence.
- Preconditions: None beyond seed.
  - Automation: `tests/integration/webhook-ingest.test.js` invalid token suite (Existing).
- Manual validation: Issue curl request expecting HTTP 401 and verify `SELECT COUNT(*) FROM webhook_inbox WHERE created_at > NOW() - INTERVAL '5 minutes';` matches baseline.
- Log expectations: `access_log` entry with `outcome='unauthorized'`, no `decision_log` entry for processing.
  - Coverage status: Existing.

#### WH-004 - Provider B async handshake (202 then callback)
- Use case: Async provider receives HTTP 202, the system processes internally, then posts a completion callback.
- Preconditions: Sender policy enabling async ack, callback mock endpoint available.
- Automation: New suite `tests/integration/webhook-handshake.test.js` (Planned).
- Manual validation:
  - `SELECT http_status_code, response_outcome FROM webhook_response_events WHERE webhook_source_id = (SELECT id FROM webhook_sources WHERE organization_id = :organization_id AND source_identifier = 'test-async-source');`
  - `SELECT status FROM outbound_calls WHERE call_type = 'provider_callback';`
- Log expectations: `decision_log` records `decision_outcome='ack_deferred'` and later a provider callback decision (`decision_category='provider_callback'`), with `workflow_execution_log` entries for the workflow follow-up steps.
- Coverage status: Gap.

#### WH-005 - Callback failure triggers ops alert
- Use case: Async provider callback fails and an ops alert is raised.
- Preconditions: Same as WH-004, mock callback returns HTTP 500.
- Automation: Extend async suite to assert alert creation (Planned).
- Manual validation: `SELECT * FROM alert_events ORDER BY created_at DESC LIMIT 1;`.
- Coverage status: Gap.

#### WH-006 - Mapping schema drift detection
- Use case: Detect missing or mismatched fields during payload transformation.
- Preconditions: Fixture omitting required property.
- Automation: New Jest case asserting transformation failure path (Gap).
- Manual validation: `SELECT * FROM manual_review_queue ORDER BY created_at DESC LIMIT 1;` for routed payloads.
- Log expectations: `decision_log` entry `decision_category='mapping_validation'` with failure details, optional `mapping_audit` snapshot.
- Coverage status: Gap.

### 3. Shipment Lifecycle and Data Pipelines

#### SHP-001 - Service type coverage
- Use case: Shipments ingest correctly for delivery, pickup, swap, and RTO.
- Preconditions: Fixtures under `tests/fixtures/webhooks/service_types/`.
- Automation: New suite `tests/integration/shipment-service-types.test.js` (Planned).
- Manual validation: `SELECT service_type, COUNT(*) FROM shipments GROUP BY service_type;`.
- Log expectations: `decision_log` entries `decision_category='service_routing'` per shipment.
- Coverage status: Gap.

#### SHP-002 - Status progression and communications linkage
- Use case: Lifecycle transitions (`created -> in_transit -> delivered/cancelled`) trigger communication hooks.
- Preconditions: Status update fixtures, communications templates active.
- Automation: Extend integration suite `tests/integration/status-updates.test.js` (Planned).
- Manual validation: Compare `shipment_events` and `outbound_calls` records for the same shipment.
- Coverage status: Gap.

#### SHP-003 - Exception handling to manual review
- Use case: Failed ingestion routes shipments to the manual review queue.
- Preconditions: Payload causing validation failure.
- Automation: Add Jest case verifying queue entry (Gap).
- Manual validation: `SELECT * FROM manual_review_queue ORDER BY created_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry `decision_category='exception_routing'`, optional `alert_events` for high severity.
- Coverage status: Gap.

### 4. Geocoding and Address Intelligence

#### GEO-001 - Primary provider success
- Use case: Geocoding worker resolves address via primary provider.
- Preconditions: provider_auth_configs seeded for here_geocoding; geocoding job queued.
- Automation: `tests/integration/workflows/geocoding.test.js` (Existing - skips automatically if HERE sandbox key missing).
- Manual validation: `SELECT confidence, provider FROM geocoding_cache ORDER BY created_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry `decision_outcome='primary_success'`, `geocoding_attempts` audit row.
- Coverage status: Existing (HERE sandbox smoke covered; worker linkage still pending).

#### GEO-002 - Primary failure with fallback success
- Use case: Primary failure triggers fallback provider.
- Preconditions: Mock primary failure, fallback credentials stored in provider_auth_configs (or update provider defaults).
- Automation: `tests/integration/geocoding.workflow.test.js` exercises fallback-required branch (Existing).
- Manual validation: `SELECT attempt_order, provider_name, status, confidence FROM geocoding_attempts WHERE address_id = '<fixture>' ORDER BY attempt_order;`.
- Log expectations: `decision_log` entries `decision_outcome='primary_failed'` and `decision_outcome='fallback_success'`.
- Coverage status: Existing.

#### GEO-003 - Cache hit bypass
- Use case: Repeat address uses cache instead of external call.
- Preconditions: Seed a successful attempt (GEO-001), then rerun lookup on the same address.
- Automation: `tests/integration/geocoding.workflow.test.js` exercises the cache-hit branch (no new provider dispatch).
- Manual validation: `SELECT provider_name, is_primary, geocoded_at FROM geocodes WHERE address_id = '<fixture>' ORDER BY geocoded_at DESC LIMIT 1;` should show an existing cache row reused.
- Log expectations: `geocoding_queue_status_v` shows zero pending provider steps; `decision_log` retains the prior `decision_outcome='success'` without new outbound calls.
- Coverage status: Existing.

#### GEO-004 - Low confidence routes to manual review
- Use case: Confidence below threshold sends request to manual geocoding queue.
- Preconditions: Settings override lowering confidence threshold.
- Automation: `tests/integration/geocoding.workflow.test.js` covers manual review enqueue path (Existing).
- Manual validation: `SELECT queue_assignment, reason FROM manual_review_tasks ORDER BY created_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry `decision_outcome='manual_review_required'`, optional `alert_events` if SLA breach.
- Coverage status: Existing.

### 5. Label Generation and Documents

#### LAB-001 - Label generation after successful geocoding
- Use case: Post-geocode workflow produces labels and stores the PDF.
- Preconditions: Label templates seeded, storage mock active.
- Automation: New suite `tests/integration/label-generation.test.js` (Gap).
- Manual validation: `SELECT status, storage_path FROM labels ORDER BY created_at DESC LIMIT 1;`.
- Coverage status: Gap.

#### LAB-002 - Label storage failure with retry backoff
- Use case: Storage outage triggers retry schedule and ops alert.
- Preconditions: Failure flag injected in storage mock.
- Automation: Extend label suite to simulate failure (Gap).
- Manual validation: `SELECT retry_count, next_retry_at FROM labels ORDER BY updated_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry `decision_outcome='retry_scheduled'`, `ops_alerts` entry when retries exhausted.
- Coverage status: Gap.

#### LAB-003 - Client-specific template selection
- Use case: Client override selects alternate label template.
- Preconditions: Settings override for chosen client.
- Automation: Label suite verifying template resolution (Gap).
- Manual validation: `SELECT template_id FROM labels ORDER BY created_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry includes `decision_inputs.scope_path` showing ladder result.
- Coverage status: Gap.

### 6. Outbound API and 3PL Integration

#### OUT-001 - Provider A direct order submission
- Use case: Outbound worker submits shipment to 3PL and records success.
- Preconditions: `provider_auth_configs` row for `logestechs_3pl` present (see seed/migration) and `RUN_LIVE_3PL_TESTS=true`.
- Automation: `tests/integration/workflows/outbound-3pl.test.js` (Existing - live call gated behind env flag).
- Manual validation: `SELECT status, response_code FROM outbound_calls WHERE provider_id = (SELECT id FROM providers WHERE name = 'alpha_3pl');`.
- Log expectations: `decision_log` entry `decision_category='provider_call'`, optional `outbound_call_logs` row.
- Coverage status: Existing (smoke) - worker/circuit breaker coverage still pending.

#### OUT-002 - Provider B async callback
- Use case: System posts completion callback after internal workflow completes.
- Preconditions: Async policy active, callback mock available.
- Automation: Shared with WH-004 suite (Gap).
- Manual validation: `SELECT * FROM provider_callbacks ORDER BY sent_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry `decision_category='provider_callback'`, `workflow_execution_log` referencing outbound run.
- Coverage status: Gap.

#### OUT-003 - Circuit breaker and retry policy
- Use case: Repeated failures trip circuit breaker and schedule recovery probe.
- Preconditions: Provider mock forced to return HTTP 500.
- Automation: Extend outbound suite to assert breaker states (Gap).
- Manual validation:
  - `SELECT * FROM circuit_breaker_events ORDER BY occurred_at DESC LIMIT 1;`
  - `SELECT status FROM outbound_calls WHERE status = 'failed';`
- Log expectations: `decision_log` entries for `open`, `half_open`, and `closed` transitions, `alert_events` when breaker opens.
- Coverage status: Gap.

### 7. Communications and Campaigns

#### COM-001 - Shipment created SMS notification
- Use case: Shipment creation triggers customer SMS through communications worker.
- Preconditions: Template `shipment_created_sms` active, provider enabled.
- Automation: `tests/integration/workflows/ui-create-shipment.test.js` (workflow-step regression) and `tests/integration/workflows/communications.test.js` (live provider smoke gated by `RUN_LIVE_COMMS_TESTS=true`).
- Manual validation: `SELECT call_type, status FROM outbound_calls WHERE call_type = 'comms_sms' ORDER BY created_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry `decision_category='outbound_call'` with `decision_point='shipment_created_notification'`, plus the outbound comms audit row.
- Coverage status: Implemented (workflow-step regression covers shipment-created SMS queueing; live provider smoke remains optional).

#### COM-002 - Multi-language template resolution
- Use case: Sender language override returns localized template.
- Preconditions: Sender `preferred_language = 'ar'`.
- Automation: Extend comms suite (Gap).
- Manual validation: Review outbound payload snapshot for language tag.
- Log expectations: `decision_log` entry `decision_outcome='template_resolved'` with locale metadata.
- Coverage status: Gap.

#### COM-003 - Budget enforcement and throttling
- Use case: Budget pools cap communications volume.
- Preconditions: Budget pool configured with low limit.
- Automation: Extend comms suite to exceed limit (Gap).
- Manual validation: `SELECT * FROM budget_events ORDER BY occurred_at DESC LIMIT 5;`.
- Log expectations: `decision_log` entry `decision_category='provider_budget'`, `alert_events` if budgets exhausted.
- Coverage status: Gap.

#### COM-004 - Provider failover (SMS to WhatsApp)
- Use case: SMS outage forces alternate channel.
- Preconditions: Disable SMS provider (`providers.enabled = false`).
- Automation: Extend comms suite to simulate outage (Gap).
- Manual validation: Compare `outbound_calls` showing WhatsApp fallback.
- Log expectations: `decision_log` entry `decision_outcome='channel_failover'`, `provider_health_logs` entry for outage.
- Coverage status: Gap.

### 8. Background Workers and Scheduling

#### WRK-001 - Worker registry integrity
- Use case: Registry matches the seven core workers and active flags follow spec.
- Preconditions: Seed executed.
- Automation: `npm run test:pgtap` (Existing).
- Manual validation: `SELECT handler_key, is_active FROM worker_action_handlers ORDER BY handler_key;`.
- Log expectations: `decision_log` entry `decision_category='worker_registry'` whenever activation changes.
- Coverage status: Existing.

#### WRK-002 - Cron throttling and lock behaviour
- Use case: Workers respect `cron_config` throttle and skip when locked.
- Preconditions: Adjust `cron_config` to short interval.
- Automation: Add integration test invoking worker twice rapidly (Gap).
- Manual validation: Inspect worker logs or query `worker_runs` to confirm skip reason.
- Log expectations: `decision_log` entry `decision_outcome='throttle_skip'`, `worker_run_log` row capturing lock state.
- Coverage status: Gap.

#### WRK-003 - Workflow intake chaining
- Use case: Async webhook acknowledgement launches the configured workflow via `workflow_intake_webhook`.
- Preconditions: Source-scoped policy defines `workflow.template_id`.
- Automation: `tests/integration/workflow-intake.test.js` (Existing) plus planned Logestechs provider suite.
- Manual validation: `SELECT workflow_run_id, processing_status FROM webhook_inbox WHERE id = '<webhook_id>';` then `SELECT workflow_status FROM workflow_runs WHERE id = '<workflow_run_id>';`.
- Log expectations: `decision_log` entry `decision_point='workflow_intake_ack'` links to the run; `workflow_execution_log` captures subsequent steps.
- Coverage status: Existing (intake) / Gap (provider-specific chaining).

#### WRK-004 - Partition expansion functions
- Use case: Scheduled job creates new partitions deterministically.
- Preconditions: Partition functions deployed.
- Automation: `tests/integration/partition-functions.test.js` (Existing).
- Manual validation: `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'shipments_p%';`.
- Log expectations: `decision_log` entry `decision_outcome='partition_created'` for each expansion.
- Coverage status: Existing.

### 9. Security and Isolation

#### SEC-001 - Cross-tenant RLS enforcement
- Use case: Org cannot access another org's data.
- Preconditions: JWT fixtures.
- Automation: `tests/integration/rls-policies.test.js` (Existing).
- Manual validation: Run PostgREST queries with each JWT and compare results.
- Log expectations: RLS denials produce `decision_log` entry `decision_outcome='rls_denied'` and `audit_log` trace.
- Coverage status: Existing.

#### SEC-002 - Policy override precedence (source beats client beats global)
- Use case: Higher-scope policies override lower ones.
- Preconditions: Insert conflicting overrides for a webhook source.
- Automation: Extend settings resolution suite (Gap).
- Manual validation: `SELECT scope_type, cached_value FROM settings_cache WHERE category = 'webhook_ingest_policy';`.
- Log expectations: `decision_log` entry includes `decision_inputs.scope_path`, `settings_resolution_log` row points to winning scope.
- Coverage status: Gap.

#### SEC-003 - Provider auth rotation
- Use case: Rotating provider secret invalidates old calls and accepts new.
- Preconditions: Dual secrets seeded.
- Automation: New QA script `scripts/qa/rotate-provider-secret.js` and Jest assertions (Gap).
- Manual validation: Trigger webhook with old secret (expect failure) and new secret (expect success).
- Log expectations: `decision_log` entry `decision_category='provider_auth'`, `audit_log` row for secret update.
- Coverage status: Gap.

### 10. Observability and Alerts

#### OBS-001 - Decision log completeness
- Use case: Every workflow step writes to `decision_log` with correlation data.
- Preconditions: Run representative workflows (WH-001, GEO-001, LAB-001, COM-001).
- Automation: Add helper in integration tests verifying expected decision points (Gap).
- Manual validation: `SELECT decision_point, decision_outcome FROM decision_log WHERE resource_id = <shipment_id>;`.
- Coverage status: Gap.

#### OBS-002 - Ops alert guard on acknowledgement failures
- Use case: Failed ACK triggers alert worker.
- Preconditions: Force HMAC failure scenario.
- Automation: Extend existing Jest HMAC test to assert alert (Gap).
- Manual validation: `SELECT * FROM ops_alerts ORDER BY created_at DESC LIMIT 1;`.
- Coverage status: Gap.

#### OBS-003 - Provider health monitoring
- Use case: Health monitor detects provider outage and logs recovery.
- Preconditions: Schedule health monitor worker.
- Automation: New integration or cron test (Gap).
- Manual validation: `SELECT * FROM provider_health_logs ORDER BY checked_at DESC LIMIT 5;`.
- Log expectations: `decision_log` entries `decision_outcome='provider_down'` and `decision_outcome='provider_recovered'`.
- Coverage status: Gap.

### 11. Performance and Scale

#### PERF-001 - Baseline load (20 VUs, p95 < 150 ms)
- Use case: Webhook ingestion meets SLA under standard load.
- Config references: `docs/tests/workflows/load-performance.md:11`, `docs/tests/workflows/webhook-ingest.md:20`.
- Preconditions: Seed 10k shipments, Docker available.
- Automation: `npm run test:load` (Existing).
- Manual validation: Review k6 summary; `SELECT COUNT(*) FROM webhook_inbox WHERE created_at > NOW() - INTERVAL '5 minutes';`.
- Log expectations: k6 output saved, optional `load_test_log` entry if script writes to DB.
- Coverage status: Existing.

#### PERF-002 - Partition expansion stress (100k inserts)
- Use case: High-volume ingestion preserves partition balance.
- Preconditions: `node scripts/data/seed-test-data.js 100000`.
- Automation: Extend k6 scenario or dedicated script (Gap).
- Manual validation: `SELECT partition_name, COUNT(*) FROM v_shipment_partition_distribution;`.
- Log expectations: `decision_log` entries `decision_outcome='partition_created'`, `performance_metrics` records for throughput.
- Coverage status: Gap.

#### PERF-003 - Settings cache churn under load
- Use case: High-frequency settings resolution stays within cache miss budget.
- Preconditions: Enable cache metrics instrumentation.
- Automation: Add performance test capturing cache hits and misses (Gap).
- Manual validation: `SELECT * FROM settings_cache_metrics ORDER BY recorded_at DESC;`.
- Log expectations: `decision_log` entries summarise cache misses for audits.
- Coverage status: Gap.

### 12. Failure and Recovery

#### FAIL-001 - Supabase outage drill
- Use case: Workers back off and alerts fire during database outage.
- Preconditions: Ability to stop Supabase stack safely.
- Automation: Manual drill (Gap).
- Manual validation: Observe worker logs, confirm resume, verify `ops_alerts` entry for outage.
- Log expectations: `decision_log` entries `decision_outcome='db_unavailable'` and `decision_outcome='db_recovered'`.
- Coverage status: Gap.

#### FAIL-002 - Migration rollback and reseed
- Use case: Reset database and reseed without residual artifacts.
- Preconditions: None beyond access.
- Automation: Provision/reset a clean environment, then run `node scripts/data/seed-test-data.js 100`.
- Manual validation: Compare table counts before and after reset.
- Log expectations: `schema_migration_log` shows rollback and reapply, `seed_run_log` captures reseed.
- Coverage status: Existing.

#### FAIL-003 - Provider SLA breach escalation
- Use case: Late callback triggers SLA breach workflow and client communications.
- Preconditions: Async provider with SLA threshold configured.
- Automation: Add integration test simulating delayed completion (Gap).
- Manual validation: `SELECT * FROM sla_breach_events ORDER BY occurred_at DESC LIMIT 1;`.
- Log expectations: `decision_log` entry `decision_outcome='sla_breach'`, communications log for client notice.
- Coverage status: Gap.


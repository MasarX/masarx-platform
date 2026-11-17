# Subsystem Implementation Guide (Engine-First, Decision-First)

Goals
- 100% engine-first: all work starts via `webhook_inbox` (external) or `domain_events` (internal) and runs through `workflow_runs`/`workflow_run_steps`.
- 100% decision-first: every branch records an audit in `decision_log` with organization, resource, decision point/outcome, inputs, and reason.
- Configuration-first: behavior lives in `settings/settings_versions`, `operation_templates`, `operation_handlers`, `mapping_configs`, `message_templates`, `label_template_specs`.
- Zero redundancy: no subsystem-specific log/audit tables. Views are allowed for read convenience.
 - Idempotent starts: starting the same template for the same logical resource must reuse an existing run.

Required Tables/Views
- Engine: `workflow_runs`, `workflow_run_steps`, `operation_handlers`, `workflow_templates`, `workflow_template_steps`.
- Triggers: `webhook_inbox` (intake), `domain_events` (internal signals).
- Audit: `decision_log` (single ledger), `observability_events_v` (unified view).

Entry Patterns
- External: insert into `webhook_inbox` (Edge function or proxy) -> intake template starts -> steps materialized.
- Internal: call a SECDEF `enqueue_*` function that inserts into `domain_events` -> `run_domain_events_worker()` consults policy in `settings` and starts the configured template.

Handler Pattern
- Register a handler in `operation_handlers` with key + schema + function signature `(workflow_run_steps, workflow_runs, jsonb)`.
- Implement handler under `workflow_handlers.*` to perform atomic work and return `workflow_handler_response`.
- Handlers must emit `decision_log` (success/fail/retry) with strong context.
- Context rules: prefer context-derived identifiers (organization_id, client_id, shipment_id) and allow nested `context.payload` merging. Avoid hard-coded parameter reads. See manual-review enqueue sample below.

Workflow Template & Steps
- Create a new row in `workflow_templates` (status=`active`).
- Insert `workflow_template_steps` with an ordered sequence, setting `handler_key` to your registered key. `operation_name` is a logical label.
- Steps may consult config via `settings`, `operation_templates`, `mapping_configs`, etc.
- Prefer generic guardrails instead of bespoke branching:
  - `context_set_defaults` to apply non-stomping defaults from step metadata (keeps behavior row-driven).
  - `context_require` to enforce required context keys/paths, with policy-safe `on_missing` behavior (fail vs early-complete).

Start Idempotency
- The engine computes a dynamic idempotency key at start time and stores it in `workflow_runs.idempotency_key` (unique per `workflow_template_id`).
- Priority order for the key (first match wins):
  - `context.idempotency_key` (explicit)
  - `resource_type` + `resource_id`
  - `domain_event_id`
  - `shipment_id` / `address_id`
- If no safe key exists, the run is started without an idempotency key. Prefer passing an explicit `idempotency_key` in contexts for high-traffic triggers.
- Materialization is de-duplicated per `sequence_order` to guard against accidental duplicate template steps.

Webhook Intake Defaults (Dynamic)
- Store global/tenant defaults under `settings(category='webhook_intake')`:
  - `defaults.accepted_async_status`, `defaults.synchronous_success_status`, `defaults.bad_request_status`, `defaults.error_status`, `defaults.poll_attempts`, `defaults.poll_interval_ms`.
- `workflow_intake_webhook(token, headers, raw_body, payload)` resolves defaults via `resolve_webhook_intake_defaults(organization_id)` and policy via `resolve_webhook_ingest_policy(webhook_source_id)`.
- Synchronous and async responses inherit policy/defaults; HMAC validation outcomes turn the response into a synchronous failure and log `http_response_emitted` decisions.

Manual Review (Example)
- Enqueue step (`manual_review`) lifts organization/client/shipment from `context` or nested `context.payload`, creates a `manual_review_tasks` row, writes the new `manual_review_task_id` into run context, and logs `decision_log` with `decision_category='manual_review'`.
- Assign (`manual_review_assign`) and resolve (`manual_review_resolve`) accept `manual_review_task_id` from operation_result, step result, or run context to avoid brittle parameter passing; both steps log decisions with assigned user and resolution notes respectively.

Acceptance Checklist (Additions)
- Webhook intake tests use dynamic defaults; no literal HTTP codes in runtime or tests.
- Manual-review lifecycle runs end-to-end (enqueue -> assign -> resolve) with decisions and proper context lifting; RLS covers `manual_review_tasks`.

Policy Wiring
- Add/patch `settings_versions` (category `domain_event_policy`) to map your `event_type` to the workflow template ID (optionally include `context_patch`).
- Publish to `settings` for the relevant scope (tenant/client/sender/global).

Decision Logging Rules
- Call `log_decision(organization_id, category, resource_type, resource_id, decision_point, decision_outcome, performed_by_system, correlation_id, decision_inputs, decision_reason)` from handlers and workflow transitions.
- Never write to custom log tables.

Outbound Calls
- All rows in `outbound_calls` must come from a workflow step; `workflow_run_step_id` is required.
- `non_engine_outbound_calls_v` must be empty (CI enforces this).

Acceptance Checklist
- Engine entry present (webhook or domain event).
- Handler registered and callable; template + steps created; policy wired in `settings`.
- All actions emit `decision_log`; no subsystem-specific logs added.
- pgTAP passes compliance gates; integration test exercises the full path.
 - Starting the template twice for the same logical resource yields a single `workflow_runs` row (idempotent).

CI Compliance (Required)
- Engine-only outbound calls: `non_engine_outbound_calls_v` must be empty (CI fails if not).
- Decision-first: expect recent decision counts for your subsystem under `decision_log` (category should match your handlers).
- Webhook response health: watch `response_failed` and failure reasons; HMAC and policy misconfig are the most common.
- How to run locally:
  - `ENV_FILE=config/env/.env.cloud npm run ci:summary` (JSON summary; also writes a Markdown step summary in GitHub Actions)
  - `SELECT jsonb_pretty(ci_observability_summary());` for SQL-only inspection.
  - Inspect the view: `SELECT * FROM ci_observability_summary_v LIMIT 1;`

Tips
- Use `tests/utils/policies.js` to upsert settings/policies in tests instead of raw INSERTs; this keeps tests dynamic and consistent with CI expectations.
- If you add a new subsystem, validate engine+decision compliance with pgTAP first, then add an integration test exercising the full path.

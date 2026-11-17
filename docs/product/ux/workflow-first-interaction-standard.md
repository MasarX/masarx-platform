# Workflow-First Interaction Standard (Request -> Approve -> Apply -> Audit)

## Purpose
- Enforce a consistent request lifecycle across Console and Portal.
- Prevent direct mutations; all changes are commands with approvals and audit trails.

## Core entities and identifiers
- request_id: the command/request created by the UI.
- workflow_run_id: workflow execution linked to the request.
- correlation_id: cross-system trace key.
- decision_log_id: recorded approval and policy decisions.

## Action discovery
- The UI reads ui_command_registry_v1 for available actions, required capability, and payload schema.
- The UI reads ui_policy_preview_v1 to show approval requirements before submit.
- Actions are hidden or disabled when capability is missing or policy denies.

## Policy resolution and provenance
- Policy evaluation must use the registry-driven scope ladder (default global -> tenant -> client -> sender, category-specific).
- The UI must surface the resolved policy source and settings_resolution_id when available.
- Decision views link to decision_log and settings_resolution_log for provenance.

## Request creation
- Forms are schema-driven from schema_registry.
- Required capability and approval policy are displayed on the form.
- Submit creates a request and returns request_id + workflow_run_id.
- Duplicate submits should be deduped by idempotency key; UI should render the existing request if returned.

## Request idempotency and dedupe
- Each request submission must include an idempotency key derived from form payload + scope.
- If the backend returns an existing request, UI must show the existing lifecycle and prevent duplicates.

## Request lifecycle states
- draft -> submitted -> in_review -> approved/rejected -> applied/failed
- Terminal states: rejected, applied, failed.
- UI must render a timeline with timestamps and actor attribution for each state.

## Approve workflow (Console)
- Approvers see policy and capability context, not role names.
- Approval decision creates a decision_log entry and links to the workflow run.
- UI must show decision rationale and policy resolution path (settings ladder).

## Approval toggle (future-ready)
- Approval is required today by policy; UI must not assume auto-apply.
- When policy flips to no-approval, the same request UI still works without any front-end change.

## Apply workflow
- Applied state shows the resulting domain event identifiers and any downstream workflow runs.
- Failed state includes error category (validation, policy, system) and retry eligibility.

## Audit requirements
- Every request detail view must link to decision log and domain events via correlation_id.
- The UI must render the resolved scope (registry-driven ladder path; default global -> tenant -> client -> sender) and source of policy.
- The UI must surface settings_resolution_id and link to settings_resolution_log when policy evaluation is involved.

## Errors and messaging
- Validation error: field-level errors from schema validation.
- Policy denied: show required capability and resolved policy summary.
- Workflow failure: show failure reason and retry if policy allows.
- Network error: retry with backoff and preserve draft state.

## Consistent UI components
- Request summary panel: status badge, request_id, workflow_run_id, correlation_id.
- Approval card: policy, required capability, approver actions, decision history.
- Audit strip: decision_log + domain_events preview.

## Stop-the-line rules
- If a feature proposes direct UPDATE/DELETE, convert it to a request command.
- If a view requires fixed roles or tenant IDs, replace with capability and scope resolution.

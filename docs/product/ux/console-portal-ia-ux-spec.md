# Console and Portal IA + UX Specification

## Purpose
- Define implementation-ready information architecture and UX rules for Console and Portal.
- Enforce workflow-first behavior: request -> approve -> apply -> audit.
- Stay capability-driven and row-driven (no role or tenant hardcoding).

## Non-negotiables
- No direct mutations from the UI. Every change is a command request with a traceable workflow run.
- Menus, pages, and actions are capability-driven and policy-driven, sourced from backend registries.
- All reads are from canonical read models (workflow runs, decision log, domain events, settings, requests).
- Every view must expose auditability: correlation_id, request_id, workflow_run_id, settings_resolution_id when policy evaluation applies.

## Shared IA principles
- Capability-driven navigation: navigation items resolve from capability registry + policy evaluation.
- Schema-driven forms: request payloads are rendered from schema registry and validation rules.
- Request-first UX: pages show request lifecycle and required approvals as first-class UI elements.
- Policy visibility: each action displays required capability, approval policy, and current eligibility.
- Single source of truth: avoid local caches that diverge from read API outputs.
- Ladder-resolved policy: surface the registry-driven scope path (default global -> tenant -> client -> sender) used to resolve policy.
- RLS boundaries are explicit: when data is denied, render the policy/permission reason and next allowed action.

## Workflow and approval visibility (global)
- Every mutation is a request command (approval required now; future automation is a policy toggle, not a UI change).
- Show the approval requirement on action entry, confirm screen, and request detail.
- Policy previews must come from policy evaluation endpoints; UI cannot infer approval rules.

## Data contract and performance posture
- All list views default to server-driven pagination and filtering; client pagination is only allowed for small datasets when enabled by `ui_pagination`.
- Use virtualization for large tables; preserve canonical sort order from the read API.
- Render stale indicators when read models are behind; provide explicit refresh.

## Console IA (privileged, capability-driven)
- Home
  - KPIs, queue snapshot, incident health.
- Workflows
  - Manual review queue, my tasks, request history, decision trace.
- Operations
  - Shipments, addresses, recipients, label bundles/jobs, webhook intake observability.
- Configuration
  - Settings (view + request change), policies (read), lookups (request).
- Integrations
  - Webhook sources (create/rotate/disable), API gateway routes (read), provider auth (request).
- Security
  - Users, scope assignments, access policy (request + role/capability editor), token rotation (request), audit logs.
- Observability
  - Domain events, workflow runs, decision log, correlation trace.

## Portal IA (least-privilege, request-only)
- Home
  - KPIs, shipment health, open requests.
- Shipments
  - List/detail, tracking, label download.
- Requests
  - Create request (schema-driven), request history, statuses.
  - Access policy change request (role + capability editor).
- Help
  - Support/contact, evidence download.

## UX foundations (Console + Portal)
- Layout
  - Persistent left navigation with capability-gated sections.
  - Page header with scope selector (tenant/client/sender) and request status badges.
- Lists
- Default to server-driven pagination, filtering, and sort; only enable client pagination for low-row datasets via `ui_pagination` settings.
- Grouping and page size follow `ui_table_views` defaults and are adjustable per view.
- Row selection is available to stage bulk actions when configured; selection alone does not change data.
- Empty states must provide an allowed next action (if any) or explain policy constraints.
- Detail views
  - Always show: status, identifiers, timestamps, approvals, and audit trail.
  - Provide request lifecycle timeline and decision log excerpts.
- Errors and messaging
  - Use consistent error taxonomy: validation, policy denied, workflow failed, network.
  - Surface actionable retry guidance only when policy allows resubmission.

## Design system contract (tokens + components)
- Tokens are the single source of truth for colors, typography, spacing, and motion.
- Theme overrides are resolved by settings (no per-tenant hardcoding).
- Components must support RTL, keyboard navigation, and accessible labeling by default.

## Capability-driven contract (UI expectations)
- UI reads the capability registry and policy evaluation outputs; no role-based branching.
- Capabilities map to actions and routes, not personas.
- If a capability is missing, the UI hides or disables the action with a clear policy reason.

## Workflow-first UX contract (high level)
- Actions always start as requests with a schema-defined payload and deterministic status.
- Requests render: payload summary, current state, required approvals, and run history.
- Requests always provide an audit view linking to decision_log and domain_events.

## Label download UX contract (summary)
- UI never accesses the labels bucket directly.
- Download links are signed URLs returned by workflow/edge and can expire.
- Provide a refresh action that re-signs without reprinting; reprint is a separate request.

## i18n/RTL and accessibility alignment
- RTL-first: layout, spacing, and iconography must mirror cleanly without custom forks.
- Locale formatting is settings-driven (no fixed locale or timezone).
- Follow baseline accessibility standards in the frontend accessibility spec and extend per console/portal requirements.

## Related specs
- Page matrix: `docs/product/ux/console-portal-page-matrix.md`
- Workflow-first interaction standard: `docs/product/ux/workflow-first-interaction-standard.md`
- Label download UX: `docs/product/ux/label-download-ux.md`
- i18n/RTL + a11y requirements: `docs/product/ux/i18n-rtl-a11y-requirements.md`

# Console and Portal Page Matrix

Generated: 2026-04-13
Sources:
- `apps/console/app`
- `apps/portal/app`
- `apps/shared/app-layout.tsx`
- `docs/marketing/landing-v2/index.html`

## Scope model

- **Landing/Public surface**: `docs/marketing/landing-v2/*` (static marketing page, contact intake, client proof rendering, dynamic docs links).
- **Auth surface**: route endpoints `/auth/callback` and `/auth/sign-out` for `@masarx/auth` callback/sign-out flow on dedicated app hosts.
- **Console and Portal shell**: `apps/shared/app-layout.tsx` drives locale, config, theme, telemetry, navigation, capabilities, and auth gating via `AuthGate`.
- **Context**: every console/portal page uses shared `createUiServerClient().context(appKey)` and permission-aware navigation data from `ui.context`.
- **API surface**: `/api/ui-event` and `/api/resource-download` are frontend server endpoints for telemetry events and signed resource downloads.
- **Field Ops execution boundary**: route acceptance, scan-out, stop progress, customer contact, delivery completion, exceptions, and shift closeout remain Field Ops-owned executor journeys. Console and Portal may expose oversight or support views for the same route/task resources, but they must not become the primary mutation surface for driver execution.

## Routing conventions

- App roots are host-root for dedicated app domains: `/`.
- `/signin` is the explicit alias that redirects to `/` for canonical auth entry.
- Navigation is capability-aware from `ui_navigation_v1`; route visibility follows returned sections/capabilities.
- All non-shared page routes must tolerate denied state when capability or policy is missing.
- Access detail routes support `resource`/`template_id`/`run_id` style params and rely on API-level capability checks.

## Shared page states (all pages)

- `loading`: initial fetch, context hydration, or suspense fallback.
- `empty`: no results, with next action or policy rationale.
- `error`: backend/request error with retry path when allowed.
- `denied`: capability/policy denied with reason and request-ability state.
- `submitted`: mutation accepted and queued/queued-with-policy.
- `stale`: data older than configured refresh window with refresh CTA.

## Console route matrix

| Page | Route | State model | Notes |
| --- | --- | --- | --- |
| Home | `/` | loading, empty, error, stale | Home dashboard and summary shell. |
| Tracking operator handoff | `/operate/shipments` | loading, empty, error, denied, stale | Authenticated `shipments.read` destination reusing `ShipmentResourcePage`; exact scoped configured identifier in `focus`, optional `tab=timeline`, and the existing timeline/POD permissions. Unknown, ambiguous, or stale supplied identities never open a different shipment. |
| Reporting alias | `/reporting` | redirect | Preserves the historical entry point by redirecting to `/#shipment-reporting`; no separate reporting implementation. |
| Sign-in | `/signin` | loading, error, denied | Explicit sign-in route alias for auth entry. |
| Access overview | `/access` | loading, empty, error, denied | Access and identity summary. |
| Access policy | `/access-policy` | loading, empty, error, denied | Reads current policy and effective scope permissions. |
| Access policy request | `/access-policy/request` | loading, empty, error, denied, submitted | Policy change request mutation path. |
| Settings request | `/settings/request` | loading, error, denied, submitted | Settings change request mutation path. |
| Onboarding readiness | `/onboarding/readiness` | loading, empty, error, denied, stale | Operator-ready onboarding defaults/readiness view for workflow baseline, plugin baseline, pending credentials, and drift findings. |
| Organization readiness | `/organizations/readiness` | loading, empty, error, denied, stale | Ops-facing alias for onboarding readiness under the organizations namespace. |
| Manual review queue | `/workflows/queue` | loading, empty, error, denied, stale | Queue list + optional direct task details via `id` query. |
| Manual review detail | `/workflows/queue?id=:task_id` | loading, error, denied, stale | Same component family; task-level detail via query fallback. |
| Manual review detail | `/workflows/queue/:task_id` | loading, error, denied, stale | Path-based detail route (new phase-1 remediation) to improve deep-link stability. |
| My tasks | `/workflows/tasks` | loading, empty, error, denied | Personal/manual task listing. |
| Request history | `/workflows/requests` | loading, empty, error, denied | Audit of request lifecycle. |
| Overlaps explorer | `/workflows/overlaps` | loading, empty, error, denied, stale | Conflict simulation and overlap explorer view. |
| Workflow templates | `/workflows/templates` | loading, empty, error, denied | Template list and search/filter. |
| New workflow template | `/workflows/templates/new` | loading, error, denied, submitted | Template create and validation states. |
| Workflow template detail | `/workflows/templates/:template_id` | loading, error, denied, stale, submitted | Template details + edits + save/replay-ready actions. |
| Workflow runs | `/workflows/runs` | loading, empty, error, denied | Console workflow run inventory and filters. |
| Workflow run detail | `/workflows/runs/:run_id` | loading, error, denied, stale | Workflow execution trace entry with step/correlation context. |
| Operations routes | `/operations/routes` | loading, empty, error, denied, stale | Registry-driven routes operations workspace, including B04 zone visibility lanes such as `zones`, `zone_districts`, `baskets`, `basket_items`, and `basket_transitions`; warehouse transfer resources such as `warehouse_transfers`, `warehouse_transfer_items`, `handling_units`, and `scan_events`; plus route-planning lanes such as `route_plans`, the scoped route manifest resources `routes` (UI registry over `public.route_runs_visible_v1`, with browser-safe `api.route_runs` also exposed) and `route_stops` (UI registry over `public.route_stops_visible_v1`, with browser-safe `api.route_stops` also exposed), tenant-visible `user_devices`, and shipment inventory when enabled through settings. Driver-scoped reads only expose the assigned route and its stop list, while tenant operators with `routes.write` retain the full route inventory. Route-plan planning exposes UC071 delivery-wave creation through `api.ui_build_delivery_wave_route_plan_v1(jsonb)`, UC072 sequencing through `api.ui_solve_route_plan_v1(jsonb)`, and UC075 publish visibility through `api.ui_publish_route_plan_v1(jsonb)` on the same browser-safe contract. UC074 planning-only rebalance is available through `api.ui_rebalance_route_plan_v1(jsonb)` on the same contract. Generic resource detail remains on the RLS-backed `public.route_plans` contract, while published execution-pack reads use `api.ui_route_plan_execution_pack_v1(uuid)`. UC076 route ownership now uses the dedicated `api.ui_execute_route_run_assign_v1(...)` contract, the shared assignment modal carries `assignment_mode` guidance for `internal_driver`, `partner_fleet`, and `alternate_capacity_pool`, selected-stop split reassignment is exposed through `api.ui_execute_route_stop_reassign_v1(jsonb)` plus the `route_stops.reassign` registry action, warehouse transfer dispatch remains available through `ui_execute_warehouse_transfer_dispatch_v1`, shipment re-sort after corrected address or route metadata stays shipment-scoped through the dedicated `shipments.resort` action and `api.ui_execute_shipment_resort_v1(...)`, and shipment cohort delete/reschedule stay on `api.ui_execute_shipment_batch_operation_v1(...)` rather than the generic command executor. |
| Operations route detail | `/operations/routes/:resource` | loading, empty, error, denied, stale | Dynamic resource detail within routes workspace, including B04 delivery-zone and basket drill-in through `zones`, `zone_districts`, `baskets`, `basket_items`, and `basket_transitions`; transfer manifest membership drill-in through `warehouse_transfer_items`; route-plan detail through the canonical `route_plans` resource contract; route-run assignment through `ui_execute_route_run_assign_v1`; due-wave creation through `api.ui_build_delivery_wave_route_plan_v1(jsonb)`; sequence optimization through `ui_execute_route_plan_solve_v1`; publish closeout through `ui_execute_route_plan_publish_v1`; published execution-pack reads through `api.ui_route_plan_execution_pack_v1(uuid)`; planning-only rebalance through `ui_execute_route_plan_rebalance_v1`; transfer release through `ui_execute_warehouse_transfer_dispatch_v1`; shipment re-sort through `ui_execute_shipment_resort_v1` / `api.ui_execute_shipment_resort_v1`; shipment cohort cancel/reschedule through `ui_execute_shipment_batch_operation_v1`; operator device-governance actions through `ui_execute_user_device_revoke_v1`; and the canonical stop-list manifest lane through `route_stops` backed by `public.route_stops_visible_v1` / `api.route_stops`, including the selected-stop `route_stops.reassign` action via `ui_execute_route_stop_reassign_v1` / `api.ui_execute_route_stop_reassign_v1`. Reassignment keeps `reassignment_reason` mandatory while exposing the same alternate-capacity guidance on the shared route action modal. |
| Operations exceptions | `/operations/exceptions` | loading, empty, error, denied, stale | Exceptions routing/inbound-policy surface, including the UC114 NDR owner/SLA queues. |
| Operations exception detail | `/operations/exceptions/:resource` | loading, empty, error, denied, stale | Dynamic exception detail and action surfaces for resources such as `dispatch_exception_review`, `dispatch_exception_review_mine`, `unassigned_exceptions`, and `sla_deadline_alerts`. |
| Command catalog | `/commands` | loading, empty, error, denied | Registry-driven command command center. |
| Service catalog | `/catalog/service-offerings` | loading, empty, error, denied, submitted | Canonical service-level and offering catalog bound to active lookup values and active branches. |
| Shipment create command | `/commands/shipments.create` | loading, error, denied, submitted | Authenticated shipment-create command surface. |
| Label designer | `/platform/labels` | loading, empty, error, denied | Canonical Console V2 Label Designer & templates workbench. `/labels/designer` redirects here as a compatibility alias. |
| Organization requests | `/organizations/requests` | loading, empty, error, denied, submitted | Tenant signup/request review surface. |
| Onboarding readiness | `/onboarding/readiness` | loading, empty, error, denied, stale | Tenant onboarding defaults health, blocking drift, pending credentials, and last reconcile visibility for operator go-live review. |
| Marketplace reviews | `/marketplace/reviews` | loading, empty, error, denied, stale | Console approval queue for freelancer-driver and provider-tenant onboarding. |
| Marketplace participants | `/marketplace/participants` | loading, empty, error, denied, stale | Registry-backed participant inventory and risk/compliance drill-in. |
| Marketplace disputes | `/marketplace/disputes` | loading, empty, error, denied, stale, submitted | Platform dispute workspace with review, outcome, and audit paths. |
| Marketplace settlements | `/marketplace/settlements` | loading, empty, error, denied, stale, submitted | Internal settlement operations and settlement-readiness review. |
| COD reconciliation | `/marketplace/cod-reconciliation` | loading, empty, unavailable | Read-only Console workspace over the capability-checked `cod_reconciliation` registry resource (`api.cod_reconciliation`, `shipments.read`); filters and bounded pagination expose canonical payment-collection amounts with displayed-row currency totals. Missing access, invalid registry/data contracts, and read failures use the unavailable state; no settlement mutation. |
| Marketplace contracts | `/marketplace/contracts` | loading, empty, error, denied, stale | Contract list across awarded marketplace work. |
| New vehicle | `/fleet/vehicles/new` | loading, error, denied, submitted | Authorized tenant-scoped, registry/schema-driven vehicle creation. |
| Operations tracking map | `/operations/tracking-map` | loading, empty, error, denied | Registry-backed geographic pins with shipment-table fallback and policy-governed map rendering. |
| Marketplace contract room | `/marketplace/contracts/:id` | loading, error, denied, stale, submitted | Contract room with commercial terms, milestones, and settlement/dispute links. |
| Customer shipment changes | `/operations/customer-shipment-changes` | loading, empty, error, denied, stale, submitted | Dedicated workspace for customer-requested shipment changes with before/requested/current diff review. |
| Shipment amend/cancel | `/operations/shipment-amend-cancel` | loading, empty, error, denied, submitted | Workflow-engine backed amend/cancel workspace for pre-dispatch shipment mutation requests. |
| Pickup requests | `/operations/pickups/requests` | loading, empty, error, denied, submitted | Custom pickup request ledger and create flow backed by `public.pickup_requests` and `public.create_pickup_request_v1(jsonb)`. |
| Pickup waves | `/operations/pickups/waves` | loading, empty, error, denied, submitted | Custom pickup wave ledger and assignment flow backed by `public.pickup_waves`, `public.create_pickup_wave_v1(jsonb)`, and `public.assign_pickup_wave_v1(jsonb)`. |
| Pickup failures | `/operations/pickups/failures` | loading, empty, error, denied | Custom pickup failure ledger backed by `public.pickup_failures`. |
| Public tracking requests | `/operations/public-tracking-requests` | loading, empty, error, denied, stale | Public tracking support-case queue for ops review. |
| Workflow bindings | `/workflows/bindings` | loading, empty, error, denied, stale, submitted | Binding inventory, resolved scope provenance, clone override, reset, and studio deep-link workspace. |
| Provider auth | `/integrations/provider-auth` | loading, empty, error, denied | Provider auth configuration surface. |
| Mapping studio | `/integrations/mappings/new` | loading, error, denied, submitted, stale | Shared artifact-driven mapping studio for runtime mappings and governed drafts. |
| Universal import | `/imports/new` | loading, error, denied, submitted, stale | Shared resource import workspace that preselects the current table, auto-stages CSV/XLSX dry-runs, and persists reusable profiles plus import reports. |
| Integration plugins | `/integrations/plugins` | loading, empty, error, denied, stale | Tenant integration plugin catalog and lifecycle overview. |
| Integration health | `/integrations/health` | loading, empty, error, denied | Integration health and component status. |
| Webhook tester | `/integrations/webhook-tester` | loading, error, denied, submitted | Operator webhook request testing. |
| Integration plugin create | `/integrations/plugins/new` | loading, error, denied, submitted | Wizard entry for draft generation/import mapping. |
| Integration plugin detail | `/integrations/plugins/:plugin_id` | loading, empty, error, denied, stale | Plugin summary, version list, approval and activation state. |
| Integration plugin version detail | `/integrations/plugins/:plugin_id/versions/:version` | loading, empty, error, denied, stale, submitted | Version-level bindings, validation evidence, approval and activation actions. |
| Automation marketplace | `/automation/marketplace` | loading, empty, error, denied | Scoped catalog of immutable workflow and plugin snapshots. |
| Automation listing detail | `/automation/marketplace/:listing_id` | loading, error, denied, stale | Canonical listing/version readback and authorized install or append links. |
| Automation publish | `/automation/marketplace/publish` | loading, error, denied, submitted | Create or append an immutable version; public distribution still requires review. |
| Automation reviews | `/automation/marketplace/reviews` | loading, empty, error, denied | Authorized publication review queue. |
| Automation review decision | `/automation/marketplace/reviews/decide` | loading, error, denied, submitted | Capability-gated decision with canonical review/version/listing readback. |
| Automation install | `/automation/marketplace/install` | loading, error, denied, submitted | Installer-owned draft or transactional activation; unsupported secret placeholders cannot activate. |
| Automation installs | `/automation/marketplace/installs` | loading, empty, error, denied, stale | Scoped local copies and derived approved-upgrade availability. |
| Automation install management | `/automation/marketplace/installs/manage` | loading, error, denied, submitted, stale | Preview/apply/fork and unchanged binding confirmation; changed bindings require a fresh copy. |
| Automation connections | `/automation/marketplace/connections` | loading, empty, error, denied, stale | Scoped connection inventory without saved credentials. |
| Automation connection management | `/automation/marketplace/connections/manage` | loading, error, denied, submitted | Credential/configuration checks, rotation/revocation, and owner-configured OAuth; local checks are not remote verification. |
| Domain events | `/observability/domain-events` | loading, empty, error, denied | Read stream for platform events. |
| Domain event detail | `/observability/domain-events/:event_id` | loading, error, denied | Event detail and associated trace link. |
| Workflow runs list | `/observability/workflow-runs` | loading, empty, error, denied | Workflow run observability list. |
| Workflow run detail | `/observability/workflow-runs/:run_id` | loading, error, denied, stale | Includes run diagnostics and event correlation. |
| Trace detail | `/observability/trace/:correlation_id` | loading, error, denied | Correlation trace viewer. |
| Audit logs | `/security/audit-logs` | loading, empty, error, denied | Security/audit event browsing. |
| Token rotation | `/security/token-rotation` | loading, empty, error, denied, submitted | Security governance workflow surface. |
| Resource view | `/resources/:resource` | loading, empty, error, denied, stale | Generic registry-driven resource workspace; shipment resources surface the shared `shipments.print_labels` bulk action, workflow-backed `shipments.delete` / `shipments.reschedule` cohort actions, and the guarded `shipments.update_geocode` single-shipment action through the canonical command registry. |
| Users | `/resources/users` | loading, empty, error, denied, stale | Registry-backed user inventory; invite and resend controls require the current tenant invite authority and `users.manage` capability. |
| Invite user | `/resources/users/invite` | loading, error, denied, submitted | Tenant-authorized invite form using the same-origin invite endpoint and current server-validated role/scope options. |
| Shipments list | `/resources/shipments` | loading, empty, error, denied, stale | Shipment inventory and list workspace; the shipment wrapper adds one identifier search entrypoint for shipment ID, tracking/order references, phone, and capability-gated correlation IDs, while bulk/detail print still uses the shared `shipments.print_labels` command, shipment cohort delete/reschedule flow through `ui_execute_shipment_batch_operation_v1`, and the guarded `shipments.update_geocode` action keeps Console and Portal on one canonical manual-fix path. |
| Shipment create resource | `/resources/shipments/new` | loading, error, denied, submitted | Authenticated shipment-create resource surface. |
| Warehouse transfers list | `/resources/warehouse_transfers` | loading, empty, error, denied, stale | Authenticated warehouse transfer manifest inventory and transfer execution workspace. Detail and bulk actions now include `warehouse_transfers.dispatch`, which starts the canonical transfer workflow through `ui_execute_warehouse_transfer_dispatch_v1`, plus `warehouse_transfers.scan_departure` and `warehouse_transfers.scan_arrival`, which record the load/unload checkpoint scans and complete the active dispatch/receive task through `ui_execute_warehouse_transfer_checkpoint_v1`. |
| Warehouse transfer create resource | `/resources/warehouse_transfers/new` | loading, error, denied, submitted | Authenticated warehouse transfer manifest-create surface. |
| Auth callback | `/auth/callback` | loading, error | Redirect target from identity provider callback. |
| Invite confirmation | `/auth/invite-confirm` (`GET`, `POST`) | confirmation, error | GET only shows the confirmation form. A bounded same-origin POST verifies the invite token through the existing Auth cookie adapter, then redirects only to the configured Console origin; token hashes and provider/session details are not forwarded. |
| Sign-out | `/auth/sign-out` | loading, error | Terminates active session and redirect flow. |
| UI event endpoint | `/api/ui-event` (`POST`) | loading, error | Batch/event telemetry ingress with request id propagation. |
| Resource import API | `/api/resource-import` (`POST`) | loading, error | Same-origin browser import facade for file upload, dry-run, start, polling, and cancel. |
| Tenant user invite API | `/api/tenant-user-invite` (`POST`) | loading, error, denied, submitted | Trusted-browser, authenticated invite/resend facade; SQL rechecks tenant authority and records provider/membership outcomes without treating email acceptance as confirmed membership. |
| Resource download API | `/api/resource-download` (`GET`) | loading, error | Signed download URL endpoint with multi-id support. |
| Automation OAuth start | `/api/automation-marketplace/oauth/start` (`POST`) | loading, error, denied | Authenticated JSON start with exact trusted provider binding; default-empty configuration fails closed. |
| Automation OAuth callback | `/api/automation-marketplace/oauth/callback` (`GET`) | loading, error, denied | Session-owned, expiring, single-use PKCE completion with canonical callback identity. |
| Automation OAuth refresh | `/api/automation-marketplace/oauth/refresh` (`POST`) | loading, error, denied | Authenticated, generation-bound credential refresh without automatic retries. |
| Automation OAuth proof authorize | `/api/automation-marketplace/oauth-stub/authorize` (`GET`) | error, denied | Deterministic proof route; disabled outside explicitly authorized tests. |
| Automation OAuth proof token | `/api/automation-marketplace/oauth-stub/token` (`POST`) | error, denied | Deterministic proof route; disabled outside explicitly authorized tests and never production provider configuration. |

## Portal route matrix

| Page | Route | State model | Notes |
| --- | --- | --- | --- |
| Home | `/` | loading, empty, error, denied | Portal landing dashboard. |
| Sign-in | `/signin` | loading, error, denied | Explicit sign-in route alias for auth entry. |
| Tracking | `/tracking` | loading, empty, error, denied | Tracking query entry + result filtering. Authenticated shipment results reuse the shipment detail footer, including canonical timeline events and signed proof-of-delivery asset downloads when policy-visible artifacts exist. |
| Commands catalog | `/commands` | loading, empty, error, denied | Command catalog for tenant users. |
| Shipment create command | `/commands/shipments.create` | loading, error, denied, submitted | Tenant shipment-create command surface. |
| Label designer | `/labels/designer` | loading, empty, error, denied | Label designer parity surface. |
| Help | `/help` | loading, empty, error | Static/help content with policy-aware shell. |
| Mapping studio entrypoint | `/integrations/mappings` | loading, error, denied | Portal hub for starting new mapping drafts and reopening persisted operation reports. |
| Mapping studio | `/integrations/mappings/new` | loading, error, denied, submitted, stale | Shared artifact-driven mapping studio for runtime mappings and governed drafts. |
| Universal import | `/imports/new` | loading, error, denied, submitted, stale | Shared resource import workspace that preselects the current table, auto-stages CSV/XLSX dry-runs, and persists reusable profiles plus import reports. |
| Access overview | `/access` | loading, empty, error, denied | Access and scope overview. |
| Access policy | `/access-policy` | loading, empty, error, denied | Policy status and readable policy details. |
| Access policy request | `/access-policy/request` | loading, empty, error, denied, submitted | Tenant-level policy request. |
| Onboarding readiness | `/onboarding/readiness` | loading, empty, error, denied, stale | Client-safe onboarding health summary showing required defaults, pending credential tasks, and latest reconcile status. |
| Settings request | `/settings/request` | loading, error, denied, submitted | Tenant-level settings change requests. |
| Onboarding readiness | `/onboarding/readiness` | loading, empty, error, denied, stale | Client-visible readiness summary for baseline workflow/plugin onboarding state and pending operator follow-up. |
| Settings readiness | `/settings/readiness` | loading, empty, error, denied, stale | Settings-scoped alias for onboarding readiness and current baseline install state. |
| Operations routes | `/operations/routes` | loading, empty, error, denied, stale | Registry-driven routes operations workspace, including B04 zone visibility lanes such as `zones`, `zone_districts`, `baskets`, `basket_items`, and `basket_transitions`; `warehouse_transfers`, `warehouse_transfer_items`, `handling_units`, `scan_events`; `route_plans`; the scoped route manifest resources `routes` (UI registry over `public.route_runs_visible_v1`, with browser-safe `api.route_runs` also exposed) and `route_stops` (UI registry over `public.route_stops_visible_v1`, with browser-safe `api.route_stops` also exposed); `user_devices`; and shipment inventory for tenant transfer, dispatch planning, route assignment, and device-governance oversight when enabled through settings. Driver-scoped reads only expose the assigned route and its stop list, while tenant operators with `routes.write` retain the full route inventory. Route-plan planning flows through `api.ui_build_delivery_wave_route_plan_v1(jsonb)` for UC071, `api.ui_solve_route_plan_v1(jsonb)` for UC072, and `api.ui_publish_route_plan_v1(jsonb)` for UC075 on the same route-plan surface. Generic resource detail stays on the RLS-backed `public.route_plans` contract, while published execution-pack reads use `api.ui_route_plan_execution_pack_v1(uuid)`. UC076 route ownership uses `api.ui_execute_route_run_assign_v1(...)`, the route action modal exposes `assignment_mode` guidance for `internal_driver`, `partner_fleet`, and `alternate_capacity_pool`, selected-stop split reassignment uses `api.ui_execute_route_stop_reassign_v1(jsonb)` plus `route_stops.reassign`, warehouse transfer dispatch uses `ui_execute_warehouse_transfer_dispatch_v1(...)`, shipment re-sort after corrected address or route metadata stays on the dedicated `shipments.resort` / `api.ui_execute_shipment_resort_v1(...)` contract, and shipment cohort delete/reschedule stay on `api.ui_execute_shipment_batch_operation_v1(...)`. |
| Operations route detail | `/operations/routes/:resource` | loading, empty, error, denied, stale | Dynamic resource detail within routes workspace, including B04 delivery-zone and basket drill-in through `zones`, `zone_districts`, `baskets`, `basket_items`, and `basket_transitions`; transfer manifest membership detail through `warehouse_transfer_items`; route-plan detail through the canonical `route_plans` resource; route-run assignment through `ui_execute_route_run_assign_v1`; due-wave creation through `api.ui_build_delivery_wave_route_plan_v1(jsonb)`; sequence optimization through `ui_execute_route_plan_solve_v1`; publish closeout through `ui_execute_route_plan_publish_v1`; published execution-pack reads through `api.ui_route_plan_execution_pack_v1(uuid)`; transfer release through `ui_execute_warehouse_transfer_dispatch_v1`; shipment re-sort through `ui_execute_shipment_resort_v1` / `api.ui_execute_shipment_resort_v1`; shipment cohort cancel/reschedule through `ui_execute_shipment_batch_operation_v1`; operator device revocation through `ui_execute_user_device_revoke_v1`; and the canonical stop-list manifest lane through `route_stops` backed by `public.route_stops_visible_v1` / `api.route_stops`, including the selected-stop `route_stops.reassign` action via `ui_execute_route_stop_reassign_v1` / `api.ui_execute_route_stop_reassign_v1`. Reassignment keeps `reassignment_reason` mandatory and exposes the same alternate-capacity guidance on the shared route action modal. |
| Customer shipment changes | `/operations/customer-shipment-changes` | loading, empty, error, denied, stale, submitted | Dedicated customer-requested shipment change review workspace with before/requested/current diff panels and approve/reject actions. |
| Shipment amend/cancel | `/operations/shipment-amend-cancel` | loading, empty, error, denied, submitted | Workflow-engine backed amend/cancel workspace for pre-dispatch shipment mutation requests. |
| Pickup requests | `/operations/pickups/requests` | loading, empty, error, denied, submitted | Custom pickup request ledger and create flow backed by `public.pickup_requests` and `public.create_pickup_request_v1(jsonb)`. |
| Pickup waves | `/operations/pickups/waves` | loading, empty, error, denied, submitted | Custom pickup wave ledger and assignment flow backed by `public.pickup_waves`, `public.create_pickup_wave_v1(jsonb)`, and `public.assign_pickup_wave_v1(jsonb)`. |
| Pickup failures | `/operations/pickups/failures` | loading, empty, error, denied | Custom pickup failure ledger backed by `public.pickup_failures`. |
| Public tracking requests | `/operations/public-tracking-requests` | loading, empty, error, denied, stale | Review-focused alias over customer shipment changes for public tracking support cases. |
| Operations exceptions | `/operations/exceptions` | loading, empty, error, denied, stale | Tenant-level exception workspace, including the shared-shell NDR owner/SLA and tenant-resolution queues. |
| Operations exception detail | `/operations/exceptions/:resource` | loading, empty, error, denied, stale | Dynamic exception detail and actions for `dispatch_exception_review`, `dispatch_exception_review_mine`, `unassigned_exceptions`, and `sla_deadline_alerts`; tenant resolution submits canonical `resolution_action` selected from the `ndr_action` lookup category through `ui_execute_dispatch_exception_resolution_v1`. |
| Customer shipment changes | `/operations/customer-shipment-changes` | loading, empty, error, denied, stale, submitted | Dedicated workspace for customer-requested shipment changes with before/requested/current diff review. |
| Public tracking requests | `/operations/public-tracking-requests` | loading, empty, error, denied, stale | Review-focused alias for pending public-tracking shipment change requests. |
| Workflows queue | `/workflows/queue` | loading, empty, error, denied, stale | Queue of manual review operations. |
| Workflows queue detail | `/workflows/queue?id=:task_id` | loading, error, denied, stale | Legacy query-based queue detail route retained for compatibility. |
| Manual review detail | `/workflows/queue/:task_id` | loading, error, denied, stale | Path-based detail route added for deep-link parity with other entity pages. |
| Marketplace requests | `/marketplace/requests` | loading, empty, error, denied, stale | Marketplace demand board for tenant requesters. |
| Marketplace request create | `/marketplace/requests/new` | loading, error, denied, submitted | Schema-driven request composer using request-kind registry metadata. |
| Marketplace request workspace | `/marketplace/requests/:id` | loading, error, denied, stale, submitted | Request detail with release, counter, award, and work-package timeline. |
| Marketplace provider workboard | `/marketplace/provider` | loading, empty, error, denied, stale, submitted | Provider-facing board for offers, pending awards, availability, and active work packages. |
| Marketplace private pools | `/marketplace/private-pools` | loading, empty, error, denied, stale, submitted | Preferred provider and pool membership management. |
| Marketplace network | `/marketplace/network` | loading, empty, error, denied, stale | Curated network browse and eligibility visibility preview. |
| Marketplace contracts | `/marketplace/contracts` | loading, empty, error, denied, stale | Contract list for awarded marketplace work. |
| Marketplace contract room | `/marketplace/contracts/:id` | loading, error, denied, stale, submitted | Contract room with terms, milestones, dispute entry, and settlement summary. |
| Marketplace settlements | `/marketplace/settlements` | loading, empty, error, denied, stale, submitted | Internal settlement visibility for tenant-side marketplace work. |
| Marketplace work packages | `/marketplace/work-packages` | loading, empty, error, denied, stale | Awarded execution bridge from contract to operational work packages. |
| My tasks | `/workflows/tasks` | loading, empty, error, denied | Personal/manual task listing. |
| Workflow overlaps | `/workflows/overlaps` | loading, empty, error, denied, stale | Overlap/conflict analysis workspace. |
| Workflow templates | `/workflows/templates` | loading, empty, error, denied | Template list and search/filter. |
| Workflow template create | `/workflows/templates/new` | loading, error, denied, submitted | Create workspace and validation states. |
| Workflow template detail | `/workflows/templates/:template_id` | loading, error, denied, stale, submitted | View/edit/template actions. |
| Workflow bindings | `/workflows/bindings` | loading, empty, error, denied, stale, submitted | Binding inventory, resolved scope provenance, clone override, reset, and studio deep-link workspace. |
| Workflow runs | `/workflows/runs` | loading, empty, error, denied | Portal workflow run inventory and filters. |
| Workflow run detail | `/workflows/runs/:run_id` | loading, error, denied, stale | Tenant-level run diagnostics and actions. |
| Trace detail | `/observability/trace/:correlation_id` | loading, error, denied | Correlation trace viewer. |
| Auth callback | `/auth/callback` | loading, error | Redirect target from identity provider callback. |
| Sign-out | `/auth/sign-out` | loading, error | Terminates active session and redirect flow. |
| UI event endpoint | `/api/ui-event` (`POST`) | loading, error | Batch/event telemetry ingress with request id propagation. |
| Resource import API | `/api/resource-import` (`POST`) | loading, error | Same-origin browser import facade for file upload, dry-run, start, polling, and cancel. |
| Resource download API | `/api/resource-download` (`GET`) | loading, error | Signed download URL endpoint with multi-id support. Shipment POD asset downloads require both `resource=shipment_pod_asset` and `shipment_id`, and they must resolve through the caller-visible shipment contract before any signed URL is returned. |
| Resource view | `/resources/:resource` | loading, empty, error, denied, stale | Generic registry-driven resource workspace; shipment resources surface the shared `shipments.print_labels` bulk action, workflow-backed `shipments.delete` / `shipments.reschedule` cohort actions, and the guarded `shipments.update_geocode` single-shipment action through the canonical command registry. |
| Shipments list | `/resources/shipments` | loading, empty, error, denied, stale | Shipment inventory and list workspace; the shipment wrapper adds one identifier search entrypoint for shipment ID, tracking/order references, phone, and capability-gated correlation IDs, while bulk/detail print still uses the shared `shipments.print_labels` command, shipment cohort delete/reschedule flow through `ui_execute_shipment_batch_operation_v1`, the guarded `shipments.update_geocode` action keeps Console and Portal on one canonical manual-fix path, and shipment detail exposes the canonical timeline plus signed POD asset download links sourced from `shipment_actions` + `artifact_links`. |
| Shipment create resource | `/resources/shipments/new` | loading, error, denied, submitted | Tenant shipment-create resource surface. |
| Warehouse transfers list | `/resources/warehouse_transfers` | loading, empty, error, denied, stale | Tenant warehouse transfer manifest inventory and transfer execution workspace. Detail and bulk actions now include `warehouse_transfers.dispatch`, which starts the canonical transfer workflow through `ui_execute_warehouse_transfer_dispatch_v1`, plus `warehouse_transfers.scan_departure` and `warehouse_transfers.scan_arrival`, which record the load/unload checkpoint scans and complete the active dispatch/receive task through `ui_execute_warehouse_transfer_checkpoint_v1`. |
| Warehouse transfer create resource | `/resources/warehouse_transfers/new` | loading, error, denied, submitted | Tenant warehouse transfer manifest-create surface. |

## Landing page matrix

| Surface element | Coverage state | Contract/source |
| --- | --- | --- |
| Primary sections (`#product`, `#integration`, `#how`, `#capabilities`, `#who`, `#enterprise`, `#faq`, `#contact`) | implemented | `docs/marketing/landing-v2/index.html` + `app.js` |
| Contact intake form | implemented (runtime endpoint + validation + turnstile) | `docs/marketing/landing-v2/app.js` + `LANDING_CONTACT_ENDPOINT` |
| SEO/meta + social tags | implemented | `docs/marketing/landing-v2/index.html` |
| Dark mode + language toggles | implemented client-side | `docs/marketing/landing-v2/app.js` + runtime config |

## Data dependency model (all surfaces)

- Shared: locale/config from `getPublicConfig`, `getUiDefaults`, and `createAppContext`.
- Console/Portal page data: context-aware and capability-driven from `createUiServerClient().context` and `@masarx/ui` page components.
- API endpoints used in current surface matrix:
  - `/auth/callback`, `/auth/sign-out`
  - `/api/ui-event`
  - `/api/resource-download`
  - landing contact and client lookup endpoints (runtime-configured)

## Coverage quality notes

- The route map above reflects all currently implemented frontend routes in-tree as of 2026-04-13.
- No implemented console or portal route is omitted from this matrix.
- No `TODO` placeholder routes were found in route entry points under `apps/console/app` and `apps/portal/app`.

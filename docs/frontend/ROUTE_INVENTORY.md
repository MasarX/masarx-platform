# Frontend Route Inventory

Generated: 2026-02-15
Updated: 2026-04-10 (Added B04 route-workspace zone visibility, shipment re-sort, route assignment, route-stop split reassignment, route-stop manifest visibility, route-plan publish execution-pack notes, and the portal mapping hub route)

## Summary

| App     | Route Count |
|---------|-------------|
| Console | 38          |
| Portal  | 37          |
| **Total** | **75**    |

All page routes use the `withConsoleConfig` or `withPortalConfig` HOC pattern. Most pages delegate rendering to shared `@masarx/ui` server components that handle their own data fetching, error handling, and state management.

### State Coverage Legend

- Loading: Suspense boundary or async loading indicator present
- Error: Error state handled and rendered with a user-visible message
- Empty: Empty/no-data state rendered
- Success: Normal data-present rendering path

---

## Console Routes

### Dashboard and Core

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/` | `DashboardPage` | `auth.getSession`, `ui.context`, `ui.dashboardConfig`, `fetchCommandRegistry`, `ui.readRegistry`, `ui.dashboardMetrics`, `ui.listResource` | Y | Y | Y | Y | Suspense wrapper via local `_components/` module; async server component returns null when no session. Empty states for actions and modules sections. |
| `/access` | `AccessPage` | `ui.me` | Y | Y | Y | Y | Empty state when no capabilities. |
| `/access-policy` | `AccessPolicyPage` (local wrapper) | `ui.me`, `ui.accessPolicy` | Y | Y | Y | Y | Suspense fallback via local wrapper. Handles capability-denied as separate blocked state. |
| `/access-policy/request` | `AccessPolicyRequestPage` | `ui.me`, `ui.accessPolicy`, `ui.requestAccessPolicyChange` (server action) | Y | Y | X | Y | Suspense wrapper via local `_components/` module. Denied state handled. No explicit empty state. |
| `/commands` | `CommandCatalogPage` | `fetchCommandRegistry`, `ui.me` | Y | Y | Y | Y | Empty state for filtered and unfiltered views. |

### Integrations

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/integrations/provider-auth` | `ResourcePage` (local wrapper) | `ui.readRegistry`, `ui.me`, `ui.settingsPreview`, `ui.filterOperators`, `ui.tableViews`, `fetchCommandRegistry`, `ui.listResource`, `ui.getResource`, `ui.resourceMetrics`, `ui.relatedResources` | Y | Y | Y | Y | Full ResourcePage with all state coverage. resourceKey=`provider_auth_configs`. |

### Marketplace

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/marketplace/reviews` | `MarketplaceParticipantRequestsPage` | `ui.me`, `ui.listResource("marketplace_participant_requests")`, `fetchCommandRegistry` | Y | Y | Y | Y | Console queue for marketplace onboarding and approval review. |
| `/marketplace/participants` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_participants`. |
| `/marketplace/disputes` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_disputes`. |
| `/marketplace/settlements` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_settlements`. |
| `/marketplace/contracts` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_contracts`. |
| `/marketplace/contracts/[id]` | `MarketplaceContractRoomPage` | `ui.marketplaceContractRoom`, `ui.marketplaceSettlementWorkspace`, `ui.marketplaceDisputeWorkspace`, `ui.executeCommand` | Y | Y | Y | Y | Contract room with milestones, settlement summary, and dispute trace. |

### Observability

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/observability/domain-events` | `ResourcePage` (local wrapper) | `ui.readRegistry`, `ui.me`, `ui.settingsPreview`, `ui.filterOperators`, `ui.tableViews`, `fetchCommandRegistry`, `ui.listResource` | Y | Y | Y | Y | resourceKey=`domain_events`. |
| `/observability/domain-events/[event_id]` | `ResourcePage` (local wrapper) | Same as ResourcePage + custom detail footer with trace/workflow-run links | Y | Y | Y | Y | Renders related trace and workflow run links in detail footer. |
| `/observability/trace/[correlation_id]` | `ObservabilityTracePage` (shared component) | `ui.getTrace`, `ui.settingsPreview` | Y | Y | Y | Y | Shared component imported from `apps/shared/observability-trace-page.tsx` to match portal parity and avoid duplicate implementations. Suspense boundary via local wrapper. |
| `/observability/workflow-runs` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`workflow_runs`. |
| `/observability/workflow-runs/[run_id]` | `WorkflowRunPage` | `ui.readRegistry`, `ui.me`, `ui.settingsPreview`, `ui.getResource("workflow_runs")`, `ui.listResource("workflow_run_steps")` | Y | Y | Y | Y | Suspense via local wrapper.Error states for detail and steps independently. Empty states for outputs and steps. |

### Operations

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/operations/exceptions` | `RouteOperationsWorkspacePage` | `auth.getSession`, `ui.context`, `ui.readRegistry`, `fetchCommandRegistry`, `ui.dashboardMetrics` / `ui.listResource` (counts) | Y | Y | Y | Y | Suspense via local wrapper. Session check returns null if unauthenticated. Workspace selector for exception resources, including UC114 task-backed NDR lanes `dispatch_exception_review`, `dispatch_exception_review_mine`, `unassigned_exceptions`, and `sla_deadline_alerts`, plus the B04 wrong-zone alias lane `wrong_zone_exceptions`. |
| `/operations/exceptions/[resource]` | `RouteOperationsWorkspacePage` | Same as above + delegates to `ResourcePage` for selected resource | Y | Y | Y | Y | Dynamic resource key from URL param. Batch 3 warehouse intake/scanning surfaces, the B04 wrong-zone alias lane `wrong_zone_exceptions`, and UC114 NDR owner/SLA queues land here through registry wiring, not bespoke pages. |
| `/operations/shipment-amend-cancel` | `ShipmentAmendCancelPage` | `ui.rpc("shipment_amend_cancel_options_v1")`, `ui.rpc("shipment_amend_cancel_v1")` (server action) | Y | Y | Y | Y | Authenticated single-shipment amend/cancel workspace. Address defaults come from current shipment data or `shipment_operation_policy.address.default_country_code`. |
| `/operations/pickups/requests` | `PickupRequestsPage` | `ui.me`, direct read of `public.pickup_requests`, `ui.rpc("create_pickup_request_v1")` (server action) | Y | Y | Y | Y | Custom hosted pickup request list/create page. Uses direct public-view reads because `ui_list_resource_v1` cannot target views. |
| `/operations/pickups/waves` | `PickupWavesPage` | `ui.me`, direct read of `public.pickup_waves`, `ui.rpc("create_pickup_wave_v1")`, `ui.rpc("assign_pickup_wave_v1")` (server actions) | Y | Y | Y | Y | Custom hosted pickup wave list/create/assign page. Uses direct public-view reads because `ui_list_resource_v1` cannot target views. |
| `/operations/pickups/failures` | `PickupFailuresPage` | `ui.me`, direct read of `public.pickup_failures` | Y | Y | Y | Y | Custom hosted pickup failure ledger. Uses direct public-view reads because `ui_list_resource_v1` cannot target views. |
| `/operations/routes` | `RouteOperationsWorkspacePage` | Same as exceptions variant but `resourceSelector="all"` | Y | Y | Y | Y | Shows all operation resources, not just exceptions. B04 zone visibility resources (`zones`, `zone_districts`, `baskets`, `basket_items`, `basket_transitions`), Warehouse Batch 3 resources (`warehouse_transfers`, `warehouse_transfer_items`, `handling_units`, `scan_events`), route planning projections (`route_plans`), the route manifest resources (`routes` via `public.route_runs_visible_v1` inside the UI resource layer plus browser-safe `api.route_runs`, and `route_stops` via `public.route_stops_visible_v1` plus browser-safe `api.route_stops`), B07 device governance (`user_devices`), and shipment inventory are expected to appear here through `ui_navigation` + `ui_read_registry`. Driver-scoped reads only expose the assigned route manifest and stop list, while tenant operators with `routes.write` retain the full route inventory. Generic workspace reads resolve `route_plans` via `public.route_plans`, while browser-safe route-plan writes include `api.ui_build_delivery_wave_route_plan_v1(jsonb)` for UC071, `api.ui_solve_route_plan_v1(jsonb)` plus the registry action `route_plans.solve_sequence` for UC072, `api.ui_publish_route_plan_v1(jsonb)` plus the registry action `route_plans.publish` for UC075, and planning-only rebalance through `api.ui_rebalance_route_plan_v1(jsonb)` plus `route_plans.rebalance` for UC074. Browser-safe route ownership writes use the dedicated `api.ui_execute_route_run_assign_v1(...)` command contract for UC076, the shared route action modal now surfaces `assignment_mode` guidance for `internal_driver`, `partner_fleet`, and `alternate_capacity_pool`, browser-safe selected-stop split reassignment uses `api.ui_execute_route_stop_reassign_v1(jsonb)` plus the `route_stops.reassign` registry action so operators can move visible stops between eligible runs without bypassing task or handoff SSOT, shipment-level re-sort after address or route changes uses the dedicated `api.ui_execute_shipment_resort_v1(...)` browser-safe command path, shipment cohort delete/reschedule now use `ui_execute_shipment_batch_operation_v1` for workflow-backed cancel/reschedule without widening `ui_execute_command_v1`, and the guarded shipment requeue path uses `shipments.update_geocode` via `ui_execute_shipment_update_geocode_v1` for manual geocode fixes without widening the generic executor. Warehouse transfer operators can release a visible draft manifest through `ui_execute_warehouse_transfer_dispatch_v1` or capture departure and arrival checkpoints through `ui_execute_warehouse_transfer_checkpoint_v1`, which keeps pack/dispatch/receive progression on the canonical `warehouse_transfer_execute_v1` workflow trail instead of fabricating transfer state client-side. The same route workspace also exposes the canonical route-load scan-out and departure confirmation path through `api.ui_route_run_execution_manifest_v1(uuid)` and `api.ui_confirm_route_run_departure_v1(jsonb)`, while task-context customer and support contacts remain row-driven through `communication_policy.support_contacts` and the route-stop contact snapshot contract. |
| `/operations/routes/[resource]` | `RouteOperationsWorkspacePage` | Same as above + delegates to `ResourcePage` | Y | Y | Y | Y | Dynamic resource key from URL param. The same route workspace now exposes B04 delivery-zone and basket drill-in through `zones`, `zone_districts`, `baskets`, `basket_items`, and `basket_transitions` without introducing a separate write surface. Shipment detail and bulk actions can re-run one visible shipment through canonical basket-policy sorting via `ui_execute_shipment_resort_v1` / `api.ui_execute_shipment_resort_v1` and the registry action `shipments.resort`, invoke shipment cohort cancel/reschedule through `ui_execute_shipment_batch_operation_v1`, and invoke the guarded single-shipment requeue action `shipments.update_geocode` through `ui_execute_shipment_update_geocode_v1`. `user_devices` detail actions use the dedicated `ui_execute_user_device_revoke_v1` RPC instead of the generic command executor. Route-plan operators can build due delivery waves through `api.ui_build_delivery_wave_route_plan_v1(jsonb)`, optimize stop sequence through the dedicated `ui_execute_route_plan_solve_v1` command path, publish/read the execution pack through `ui_execute_route_plan_publish_v1` and `api.ui_route_plan_execution_pack_v1(uuid)` without bypassing the route-plan SSOT, and rebalance selected shipments through `ui_execute_route_plan_rebalance_v1` while keeping route runs as downstream projections only. The `routes` detail lane now reads the scoped route manifest through `public.route_runs_visible_v1` / `api.route_runs`, route-level ownership changes still flow through `ui_execute_route_run_assign_v1`, the shared route action modal retains the same `assignment_mode` guidance for alternate-capacity dispatch, the `route_stops` detail lane exposes the canonical stop list through `public.route_stops_visible_v1` / `api.route_stops` plus the selected-stop `route_stops.reassign` action backed by `ui_execute_route_stop_reassign_v1` / `api.ui_execute_route_stop_reassign_v1`, and warehouse transfer detail can trigger `ui_execute_warehouse_transfer_dispatch_v1` plus the `warehouse_transfers.scan_departure` / `warehouse_transfers.scan_arrival` checkpoint actions through `ui_execute_warehouse_transfer_checkpoint_v1` on the same route-operations surface. The detail lane also carries route-load departure confirmation through `api.ui_confirm_route_run_departure_v1(jsonb)` and the task-context contact snapshot contract so customer/support contact handling stays canonical rather than hardcoded. |

### Resources

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/resources/[resource]` | `ResourcePage` (local wrapper) | `ui.readRegistry`, `ui.me`, `ui.settingsPreview`, `ui.filterOperators`, `ui.tableViews`, `fetchCommandRegistry`, `ui.listResource`, `ui.getResource`, `ui.resourceMetrics`, `ui.relatedResources` | Y | Y | Y | Y | Dynamic resource key. Full state coverage. Handles not-found with suggestions, timeout, capability-denied. When `resource=shipments`, the shipment-specific wrapper also adds the registry-backed `identifier` search entrypoint (shipment ID, tracking/order references, phone, and capability-gated correlation IDs) and renders the detail-footer timeline backed by `ui_get_shipment_timeline_v1`; trace drill-down stays gated by `audit_log.read`. |

### Security

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/security/audit-logs` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`audit_table_changes`. |
| `/security/token-rotation` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`token_rotation_requests`. |

### Settings

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/settings/request` | `SettingsRequestPage` | `ui.me`, `ui.listResource("settings_category_registry")`, `ui.settingsPreview`, `ui.requestSettingsChange` (server action) | Y | Y | Y | Y | Suspense via local wrapper.Handles blocked (capability denied), error, and ready states. Empty when no categories. |

### Workflows

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/workflows/overlaps` | `WorkflowOverlapExplorerPage` | `ui.settingsPreview`, `listAllResources("workflow_templates")` | Y | Y | Y | Y | Suspense via local wrapper.Error and empty states for overlap groups. Filter form included. |
| `/workflows/queue` | `ManualReviewQueuePage` | `ui.me` + all ResourcePage RPCs (delegates to `ResourcePage` with resourceKey=`manual_review_tasks`), `ui.resolveManualReviewTask` (server action) | Y | Y | Y | Y | No Suspense at page level (ResourcePage has its own via local wrapper). Resolve form in detail footer. |
| `/workflows/queue/[task_id]` | `ManualReviewQueuePage` | `ui.me` + ResourcePage RPCs (`manual_review_tasks`) , `ui.resolveManualReviewTask` (server action) | Y | Y | Y | Y | Detail view for a selected manual-review task. |
| `/workflows/requests` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`requests`. |
| `/workflows/runs/[run_id]` | `WorkflowRunPage` | `ui.readRegistry`, `ui.me`, `ui.settingsPreview`, `ui.getResource("workflow_runs")`, `ui.listResource("workflow_run_steps")` | Y | Y | Y | Y | Same component as observability variant. Includes trace link. |
| `/workflows/tasks` | `ManualReviewQueuePage` | Same as queue variant | Y | Y | Y | Y | `defaultAssignedToCurrentUser` enabled. Filters by current user's tasks. |
| `/workflows/templates` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`workflow_templates`. Header actions for overlap explorer and new template. Detail footer with studio link. |
| `/workflows/templates/[template_id]` | `WorkflowTemplateStudioPage` | `ui.readRegistry`, `ui.me`, `ui.settingsPreview`, `ui.getResource("workflow_templates")`, `listAllResources("workflow_template_steps")`, `ui.listResource("workflow_runs")`, `listAllResources("workflow_schedule_triggers")`, `listAllResources("workflow_templates")`, `listAllResources("workflow_run_triggers")` (x2), `ui.listResource("webhook_sources")`, `ui.settingsPreview("webhook_ingest_policy")` (per source) | Y | Y | Y | Y | Suspense via local wrapper.Most complex page. Independent error states per section (detail, steps, runs, triggers, overlaps). Not-found detection for template. |
| `/workflows/templates/new` | `WorkflowTemplateCreatePage` | `ui.me`, `ui.readRegistry`, `ui.listResource("workflow_templates")` | Y | Y | X | Y | Suspense via local wrapper.Error displayed inline for template list load failure. No explicit empty state (form always shown). |

---

## Portal Routes

### Dashboard and Core

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/` | `DashboardPage` | `auth.getSession`, `ui.context`, `ui.dashboardConfig`, `fetchCommandRegistry`, `ui.readRegistry`, `ui.dashboardMetrics`, `ui.listResource` | Y | Y | Y | Y | Same component as console. Returns null when no session. |
| `/access` | `AccessPage` | `ui.me` | Y | Y | Y | Y | Same component as console variant. |
| `/access-policy` | `AccessPolicyPage` (local wrapper) | `ui.me`, `ui.accessPolicy` | Y | Y | Y | Y | Suspense fallback via local wrapper. |
| `/access-policy/request` | `AccessPolicyRequestPage` | `ui.me`, `ui.accessPolicy`, `ui.requestAccessPolicyChange` (server action) | Y | Y | X | Y | No explicit empty state. |
| `/commands` | `CommandCatalogPage` | `fetchCommandRegistry`, `ui.me` | Y | Y | Y | Y | Same component as console variant. |
| `/help` | Inline component (no shared UI) | None | N/A | N/A | N/A | Y | Static page. Uses only `t()` for i18n. No data fetching, no error/loading/empty states. |
| `/integrations/mappings` | `PortalMappingsPage` | None | N/A | N/A | N/A | Y | Portal mapping hub for starting new drafts and reopening persisted operation reports. Links to `/integrations/mappings/new` and the report resource index. |

### Operations

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/operations/exceptions` | `RouteOperationsWorkspacePage` | `auth.getSession`, `ui.context`, `ui.readRegistry`, `fetchCommandRegistry`, `ui.dashboardMetrics` / `ui.listResource` | Y | Y | Y | Y | Same component as console. Warehouse intake holds, the B04 wrong-zone alias lane `wrong_zone_exceptions`, scan-review lanes, and UC114 NDR owner/SLA queues resolve here from the shared registry contract. |
| `/operations/exceptions/[resource]` | `RouteOperationsWorkspacePage` | Same as above + `ResourcePage` delegation | Y | Y | Y | Y | Dynamic resource key. Includes `wrong_zone_exceptions`, `dispatch_exception_review`, `dispatch_exception_review_mine`, `unassigned_exceptions`, and `sla_deadline_alerts`. |
| `/operations/shipment-amend-cancel` | `ShipmentAmendCancelPage` | `ui.rpc("shipment_amend_cancel_options_v1")`, `ui.rpc("shipment_amend_cancel_v1")` (server action) | Y | Y | Y | Y | Authenticated single-shipment amend/cancel workspace. Address defaults come from current shipment data or `shipment_operation_policy.address.default_country_code`. |
| `/operations/pickups/requests` | `PickupRequestsPage` | `ui.me`, direct read of `public.pickup_requests`, `ui.rpc("create_pickup_request_v1")` (server action) | Y | Y | Y | Y | Custom hosted pickup request list/create page. Uses direct public-view reads because `ui_list_resource_v1` cannot target views. |
| `/operations/pickups/waves` | `PickupWavesPage` | `ui.me`, direct read of `public.pickup_waves`, `ui.rpc("create_pickup_wave_v1")`, `ui.rpc("assign_pickup_wave_v1")` (server actions) | Y | Y | Y | Y | Custom hosted pickup wave list/create/assign page. Uses direct public-view reads because `ui_list_resource_v1` cannot target views. |
| `/operations/pickups/failures` | `PickupFailuresPage` | `ui.me`, direct read of `public.pickup_failures` | Y | Y | Y | Y | Custom hosted pickup failure ledger. Uses direct public-view reads because `ui_list_resource_v1` cannot target views. |
| `/operations/routes` | `RouteOperationsWorkspacePage` | Same as exceptions with `resourceSelector="all"` | Y | Y | Y | Y | Registry-driven operational workspace for shipment, route, zone, basket, warehouse intake, route planning, and device-governance resources, including `zones`, `zone_districts`, `baskets`, `basket_items`, `basket_transitions`, `warehouse_transfers`, `warehouse_transfer_items`, `handling_units`, `scan_events`, `route_plans`, the scoped manifest resources `routes` (UI registry over `public.route_runs_visible_v1`, with browser-safe `api.route_runs` also exposed) and `route_stops` (UI registry over `public.route_stops_visible_v1`, with browser-safe `api.route_stops` also exposed), `user_devices`, and shipment inventory when enabled. Route-plan planning uses the authenticated browser-safe RPCs `api.ui_build_delivery_wave_route_plan_v1(jsonb)`, `api.ui_solve_route_plan_v1(jsonb)`, and `api.ui_publish_route_plan_v1(jsonb)` on the same SSOT surface, while published execution-pack reads use `api.ui_route_plan_execution_pack_v1(uuid)`. Route-run ownership uses `api.ui_execute_route_run_assign_v1(...)`, the shared route action modal documents `assignment_mode` values for `internal_driver`, `partner_fleet`, and `alternate_capacity_pool`, selected-stop split reassignment uses `api.ui_execute_route_stop_reassign_v1(jsonb)` plus the `route_stops.reassign` registry action, shipment re-sort after address or route changes uses the dedicated `api.ui_execute_shipment_resort_v1(...)` mutation path, and warehouse transfer operators can dispatch or checkpoint visible manifests through `ui_execute_warehouse_transfer_dispatch_v1(...)` and `ui_execute_warehouse_transfer_checkpoint_v1(...)`. |
| `/operations/routes/[resource]` | `RouteOperationsWorkspacePage` | Same as above + `ResourcePage` delegation | Y | Y | Y | Y | The shared route workspace gives tenant operators direct B04 delivery-zone and basket visibility through `zones`, `zone_districts`, `baskets`, `basket_items`, and `basket_transitions`. Shipment detail and bulk actions can re-sort one visible shipment through the `shipments.resort` command and `ui_execute_shipment_resort_v1` / `api.ui_execute_shipment_resort_v1` after corrected address or route metadata, invoke shipment cohort cancel/reschedule through `ui_execute_shipment_batch_operation_v1`, and requeue one visible shipment through `shipments.update_geocode`. `user_devices` detail actions route through `ui_execute_user_device_revoke_v1` for operator revocation. Route-plan detail can trigger due delivery-wave creation through `api.ui_build_delivery_wave_route_plan_v1(jsonb)`, optimize sequence through `ui_execute_route_plan_solve_v1`, and publish/read the execution pack through `ui_execute_route_plan_publish_v1` and `api.ui_route_plan_execution_pack_v1(uuid)` while keeping route runs as downstream projections only; the `routes` detail lane performs authoritative internal-driver, partner-fleet, or alternate-capacity assignment through `ui_execute_route_run_assign_v1`, keeps `reassignment_reason` mandatory for dispatch moves, the `route_stops` detail lane provides the canonical executor stop list through `public.route_stops_visible_v1` / `api.route_stops` plus the selected-stop `route_stops.reassign` action backed by `ui_execute_route_stop_reassign_v1` / `api.ui_execute_route_stop_reassign_v1`, and warehouse transfer detail exposes the `warehouse_transfers.dispatch`, `warehouse_transfers.scan_departure`, and `warehouse_transfers.scan_arrival` actions through `ui_execute_warehouse_transfer_dispatch_v1` and `ui_execute_warehouse_transfer_checkpoint_v1`, so Portal/Console operators can move the canonical transfer workflow from draft to in-transit to received without bypassing scan or task SSOT. |

### Marketplace

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/marketplace/requests` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_requests`. |
| `/marketplace/requests/new` | `MarketplaceRequestCreatePage` | `ui.me`, `ui.marketplaceRequestKinds`, `ui.marketplaceCreateRequest`, `ui.marketplacePublishRequest` | Y | Y | X | Y | Request-kind schema-driven create flow. |
| `/marketplace/requests/[id]` | `MarketplaceRequestWorkspacePage` | `ui.marketplaceRequestWorkspace`, `ui.marketplaceOfferLedger`, `ui.executeCommand` | Y | Y | Y | Y | Request detail with counter, award, and release actions. |
| `/marketplace/provider` | `MarketplaceProviderWorkboardPage` | `ui.marketplaceProviderWorkboard`, `ui.marketplaceOfferLedger`, `ui.executeCommand` | Y | Y | Y | Y | Provider-facing offer, award, and availability workspace. |
| `/marketplace/private-pools` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_private_pools`. |
| `/marketplace/network` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_participants`. Filtered curated-network browse surface. |
| `/marketplace/contracts` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_contracts`. |
| `/marketplace/contracts/[id]` | `MarketplaceContractRoomPage` | `ui.marketplaceContractRoom`, `ui.marketplaceSettlementWorkspace`, `ui.marketplaceDisputeWorkspace`, `ui.executeCommand` | Y | Y | Y | Y | Tenant contract room with work-package and dispute summary. |
| `/marketplace/settlements` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_settlements`. |
| `/marketplace/work-packages` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`marketplace_work_packages`. |

### Resources

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/resources/[resource]` | `ResourcePage` (local wrapper) | Same as console ResourcePage RPCs | Y | Y | Y | Y | Full state coverage. When `resource=shipments`, the shipment-specific wrapper also adds the registry-backed `identifier` search entrypoint (shipment ID, tracking/order references, phone, and capability-gated correlation IDs) and renders a detail-footer timeline backed by `ui_get_shipment_timeline_v1`; trace drill-down stays gated by `audit_log.read`. |

### Settings

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/settings/request` | `SettingsRequestPage` | `ui.me`, `ui.listResource("settings_category_registry")`, `ui.settingsPreview`, `ui.requestSettingsChange` (server action) | Y | Y | Y | Y | Same component as console. |

### Tracking (Portal-only)

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/tracking` | `TrackingPage` | `ui.trackingRegistry` + delegates to `ResourcePage` when search active | Y | Y | Y | Y | No Suspense at page level. Error state for config load. Empty state when no search term entered. ResourcePage handles results. |

### Observability (Portal-only)

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/observability/trace/[correlation_id]` | `ObservabilityTracePage` (shared component) | `ui.getTrace`, `ui.settingsPreview` | Y | Y | Y | Y | Shared component imported from `apps/shared/observability-trace-page.tsx`; enables the same trace drilldown UX as console. |

### Workflows

| Route Path | Component | RPCs Called | Loading | Error | Empty | Success | Notes |
|---|---|---|---|---|---|---|---|
| `/workflows/overlaps` | `WorkflowOverlapExplorerPage` | `ui.settingsPreview`, `listAllResources("workflow_templates")` | Y | Y | Y | Y | Same component as console. |
| `/workflows/queue` | `ManualReviewQueuePage` | `ui.me` + ResourcePage RPCs, `ui.resolveManualReviewTask` (server action) | Y | Y | Y | Y | Same component as console. |
| `/workflows/queue/[task_id]` | `ManualReviewQueuePage` | `ui.me` + ResourcePage RPCs (`manual_review_tasks`), `ui.resolveManualReviewTask` (server action) | Y | Y | Y | Y | Detail view for a selected manual-review task. |
| `/workflows/runs/[run_id]` | `WorkflowRunPage` | `ui.readRegistry`, `ui.me`, `ui.settingsPreview`, `ui.getResource("workflow_runs")`, `ui.listResource("workflow_run_steps")` | Y | Y | Y | Y | `includeTraceLink` -- trace link now enabled in portal variant. |
| `/workflows/tasks` | `ManualReviewQueuePage` | Same as queue | Y | Y | Y | Y | `defaultAssignedToCurrentUser` enabled. |
| `/workflows/templates` | `ResourcePage` (local wrapper) | Same as ResourcePage RPCs | Y | Y | Y | Y | resourceKey=`workflow_templates`. Header actions for overlap explorer and new template. |
| `/workflows/templates/[template_id]` | `WorkflowTemplateStudioPage` | Same as console variant (full template studio RPCs) | Y | Y | Y | Y | Same component as console. |
| `/workflows/templates/new` | `WorkflowTemplateCreatePage` | `ui.me`, `ui.readRegistry`, `ui.listResource("workflow_templates")` | Y | Y | X | Y | No explicit empty state. |

---

## Observations

### State Coverage (Updated 2026-04-07)

All 75 routes now have loading coverage through local wrapper components or direct shell entrypoints in `apps/*/app/_components/` and `apps/*/app/`. The wrapper pattern uses `<Suspense fallback={<LoadingState variant="page" />}>` around each shared `@masarx/ui` server component.

**Remaining minor gaps (by design):**
- `/access-policy/request` (both apps) -- No explicit empty state (form is always shown)
- `/workflows/templates/new` (both apps) -- No explicit empty state (create form is always rendered)
- `/help` (portal only) -- Static page, no data fetching; loading/error/empty states are N/A
- `/integrations/mappings` (portal only) -- Hub entrypoint with no direct data fetch; loading/error/empty states are N/A

### Console-only Routes (not in Portal)

- `/integrations/provider-auth` -- Provider auth config management
- `/marketplace/reviews` -- Marketplace onboarding review queue
- `/marketplace/participants` -- Marketplace participant inventory
- `/marketplace/disputes` -- Marketplace dispute queue
- `/marketplace/settlements` -- Marketplace settlement operations
- `/marketplace/contracts` -- Marketplace contract list
- `/marketplace/contracts/[id]` -- Marketplace contract room
- `/observability/domain-events` -- Domain event list
- `/observability/domain-events/[event_id]` -- Domain event detail
- `/observability/workflow-runs` -- Workflow run list
- `/observability/workflow-runs/[run_id]` -- Workflow run detail (observability context)
- `/security/audit-logs` -- Audit log viewer
- `/security/token-rotation` -- Token rotation requests
- `/workflows/requests` -- Workflow requests list

### Portal-only Routes (not in Console)

- `/marketplace/requests` -- Marketplace request board
- `/marketplace/requests/new` -- Marketplace request composer
- `/marketplace/requests/[id]` -- Marketplace request workspace
- `/marketplace/provider` -- Provider workboard
- `/marketplace/private-pools` -- Private pool management
- `/marketplace/network` -- Curated network browse
- `/marketplace/contracts` -- Marketplace contracts list
- `/marketplace/contracts/[id]` -- Marketplace contract room
- `/marketplace/settlements` -- Marketplace settlement view
- `/marketplace/work-packages` -- Marketplace work-package list
- `/help` -- Static help page
- `/tracking` -- Shipment/item tracking with search form
- `/observability/trace/[correlation_id]` -- Trace viewer

### Shared Component Reuse

Most routes are thin wrappers around shared `@masarx/ui` components:
- `ResourcePage` -- Used by 12 routes (console) and 8 routes (portal)
- `RouteOperationsWorkspacePage` -- Used by 4 routes per app
- `ManualReviewQueuePage` -- Used by 2 routes per app (queue + tasks)
- `WorkflowRunPage` -- Used by 2 routes in console, 1 in portal
- `DashboardPage`, `AccessPage`, `AccessPolicyPage`, `AccessPolicyRequestPage`, `CommandCatalogPage`, `SettingsRequestPage`, `WorkflowOverlapExplorerPage`, `WorkflowTemplateStudioPage`, `WorkflowTemplateCreatePage` -- Each used once per app

### RPC Client Pattern

All server-side data fetching uses `createUiServerClient()` from `@masarx/api/server`. Authentication is handled via `createServerClient()` from `@masarx/auth` (used in `DashboardPage` and `RouteOperationsWorkspacePage`). Server actions for mutations use the same `createUiServerClient()` instantiated inside the action.

---

## Top 10 Critical User Journeys

| # | Journey | Routes Involved | E2E Coverage |
|---|---------|----------------|-------------|
| 1 | Sign-in → Dashboard overview | `/` | `console-signed-in-coverage`, `portal-signed-in-coverage` |
| 2 | Resource CRUD (list → detail → inline edit) | `/resources/[resource]` | `resource-detail-*.spec`, `resource-table-*.spec`, `action-*.spec` |
| 3 | Workflow Template Studio (create → edit → preview) | `/workflows/templates/new`, `/workflows/templates/[template_id]` | `console-workflow-template-studio.spec`, `portal-workflow-template-studio.spec` |
| 4 | Operations workspace (route selection → exception drill-down) | `/operations/routes`, `/operations/routes/[resource]`, `/operations/exceptions`, `/operations/exceptions/[resource]` | `console-signed-in-coverage`, `portal-signed-in-coverage` |
| 5 | Manual review queue (list → resolve task) | `/workflows/queue`, `/workflows/tasks` | `console-manual-review.spec` |
| 6 | Access policy management (view → request change) | `/access`, `/access-policy`, `/access-policy/request` | `nav-access.spec`, `console-signed-in-coverage` |
| 7 | Settings request (select category → submit request) | `/settings/request` | `console-signed-in-coverage` |
| 8 | Workflow run inspection (list → run detail → trace) | `/workflows/runs/[run_id]`, `/observability/trace/[correlation_id]` | `console-signed-in-coverage` |
| 9 | Command catalog (browse → filter → execute) | `/commands` | `console-command-catalog.spec`, `portal-command-catalog.spec` |
| 10 | Shipment tracking (search → results) | `/tracking` (portal-only) | `portal-tracking.spec`, `portal-signed-in-coverage` |

## E2E Coverage Matrix

E2E coverage is primarily delivered by the signed-in coverage specs (`console-signed-in-coverage.spec.ts` and `portal-signed-in-coverage.spec.ts`), which combine filesystem discovery with the authenticated navigation contract and validate each reachable route loads without errors. Authenticated sweeps intentionally skip generic `:resource` template expansion, navigation-derived `/resources/*` routes, and the dedicated `/imports/new` flow; feature specs own deep resource and import coverage, while signed-in coverage follows static pages, navigation-exposed non-resource routes, and the focused dynamic route set.

| Coverage Type | Mechanism | Route Count |
|--------------|-----------|-------------|
| Signed-in route load (console) | `console-signed-in-coverage.spec.ts` | 34/34 |
| Signed-in route load (portal) | `portal-signed-in-coverage.spec.ts` | 30/30 |
| Feature-specific flows | Individual spec files | ~15 key flows |
| Accessibility | `a11y/*.spec.ts` | Shared patterns |

### Routes with Feature-Specific E2E Coverage

| Route | Spec File(s) |
|-------|-------------|
| `/resources/[resource]` | `resource-detail-*.spec`, `resource-table-*.spec`, `action-*.spec` (20+ files) |
| `/imports/new` | `console-resource-import-smoke.spec.ts`, `portal-resource-import-smoke.spec.ts` |
| `/workflows/templates/[template_id]` | `console-workflow-template-studio.spec`, `portal-workflow-template-studio.spec` |
| `/workflows/queue` | `console-manual-review.spec` |
| `/commands` | `console-command-catalog.spec`, `portal-command-catalog.spec` |
| `/tracking` | `portal-tracking.spec` |
| `/access`, `/access-policy` | `nav-access.spec` |
| `/integrations/provider-auth` | `console-integrations.spec` |
| `/observability/*` | `console-observability.spec` |
| `/security/*` | `console-security.spec` |

### Routes Covered Only by Signed-In Coverage (No Feature Spec)

- `/` (Dashboard) — covered by signed-in load test, no dedicated interaction spec
- `/settings/request` — signed-in load only
- `/workflows/overlaps` — signed-in load only
- `/workflows/templates/new` — signed-in load only
- `/help` (portal) — signed-in load only
- `/integrations/mappings` (portal) — signed-in load only

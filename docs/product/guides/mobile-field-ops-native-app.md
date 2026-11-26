# Mobile Field Ops Native App (SSOT-first, Policy-driven)

## Goals (must match core objectives)
- SIMPLE: thin client; server owns decisions; minimal bespoke logic.
- SCALABLE: offline outbox + idempotent RPCs; telemetry ledgers partitioned; no chatty APIs.
- DYNAMIC: UI, roles, modules, actions, and requirements resolved via settings ladder + registries.
- ZERO REDUNDANCY / ZERO HARD CODING: write shared behavior once in reusable packages; no tenant/client/sender conditionals in the app.
- SSOT: every action becomes a ledger row (`task_events`, `scan_events`, `location_pings`, `ops_session_events`) and decisions are logged (`decision_log`, `settings_resolution_log`).

## What the mobile app is (and is not)
- The app is a **task execution client**: it renders allowed work, captures evidence, and appends events.
- The app is not a "business rules engine": it must not duplicate SLA logic, routing logic, scan/POD rules, or role matrices in code.

## Reuse Strategy (write-once)
- Keep the mobile app as a thin shell under `apps/fieldops`.
- Put reusable logic in workspace packages (shared by web + mobile) instead of copying files:
  - `@masarx/config`: config parsing/normalization; add helpers so RN can supply env from Expo config without duplicating logic.
  - `@masarx/auth`: shared Supabase client creation; add a mobile entrypoint that uses secure storage on device.
  - `@masarx/api`: shared RPC wrappers + types; design so the Supabase client can be injected (web/mobile share the same API surface).
  - `@masarx/mobile-core`: outbox/sync/idempotency + SQLite storage primitives. Keep business rules out of this package.
- Reuse server-side SSOT + policies (don't re-implement):
  - Telemetry + ingest policies: `mobile_ingest_policy`, `location_tracking_policy`, `scan_policy`, `pod_policy`, `mobile_push_policy`, `mobile_attestation_policy`.
  - Idempotent RPCs: `register_user_device_v1`, `record_location_ping_v1`, `record_scan_event_v1`, `record_scan_events_batch_v1`, `open_ops_session_v1`, `transition_ops_session_v1`, `transition_task_v1`.
  - Mobile/PostgREST clients pinned to `db.schema=api` must call the `api.*` wrappers for browser-safe schema access. Batch 3 explicitly requires `api.record_scan_events_batch_v1` and `api.transition_task_v1`, while `public.*` remains the canonical implementation layer.
  - UI telemetry: `ui_event_log` via `ui_log_events_v1`.

## Row-driven UI model (mobile = config)
- Navigation/modules come from `ui_navigation` with `apps.mobile` (ladder-resolved) and are filtered by capabilities/access policy server-side.
- Screen behavior comes from registries + schemas:
  - `ui_read_registry` (resources/columns/filters/related)
  - `ui_command_registry` (actions, selection rules, execution type)
  - `ui_tracking_registry` (copy + labels for tracking and search)
- Mobile-only UX rules must be settings rows (not constants):
  - `mobile_visibility_policy`, `mobile_diagnostics_policy`, `mobile_push_policy`, `driver_safety_policy`, `ux_safety_policy`, `device_policy`, `navigation_policy`, `map_policy`, `communication_policy`, `address_policy` (as needed).
  - `location_tracking_policy` drives background behavior (`background_enabled`, `request_background_permission`, `foreground_accuracy`, `background_accuracy`, interval controls, and Android notification text).
  - Category-specific resolver wrappers are canonical read paths (`resolve_mobile_visibility_policy`, `resolve_mobile_diagnostics_policy`, `resolve_device_policy`, `resolve_navigation_policy`, `resolve_map_policy`, `resolve_communication_policy`, `resolve_address_policy`, `resolve_driver_safety_policy`, `resolve_ux_safety_policy`).

Native tool routes (mobile `href`)
- The Field Ops app supports `ui_navigation.apps.mobile` items that target native-only modules via `href`:
  - `/mobile/outbox` (queued/failed writes; retry/clear flows)
  - `/mobile/scan` (manual + camera barcode capture -> `record_scan_event_v1`)
    - Scan input mode is policy/platform-driven (`camera`/`scanner`) with persisted user preference and safe fallback per platform.
    - While driving lock is active, scan capture/submit is blocked and the UI remains explicit about lock state.
    - Warehouse checkpoint scans are sequence-enforced and append-only: `warehouse_checkpoint` capture must follow the resolved checkpoint order, bulk manifest/container capture must fan out through `api.record_scan_events_batch_v1`, and corrections must append a new supervised scan row instead of mutating the original event.
  - `/mobile/location` (one-shot capture -> `record_location_ping_v1`)
- `/mobile/route` (route surface backed by task read models plus the assigned route manifest contract: driver-visible `routes`, `route_stops`, and `api.ui_route_run_execution_manifest_v1` stay scoped to the assigned route run and ordered stop list)
    - Orders map mode builds a clustered scatter surface from route coordinates using `map_policy.clustering` controls (enabled, grid size, min cluster size); no hardcoded tenant rules.
    - Route detail extensions are policy-driven: address fields from `address_policy`, contact channels/templates from `communication_policy`, navigation links from `navigation_policy`, and task-context customer/support snapshots from `route_stop_task_contact_metadata_v1`; support contacts stay row-driven through `communication_policy.support_contacts`.
    - Route list cards are surface-aware (sequence/kind/ETA/status/place) without per-tenant hardcoding.
    - When a driver shift is active, the client must attach the current `ops_session_id` to stop completion, stop exception, route-load scan-out, and departure confirmation writes so `task_events`, `scan_events`, `ops_session_events`, and `route_runs.metadata.route_departure` stay traceable through one authoritative session ledger.
    - Route departure is gated: the driver scans the route load first, then confirms departure only after the route-load reconciliation is clean and the manifest shows the expected stop/ shipment counts.
  - `/mobile/settlements` (settlement ledger surface backed by `settlements` read models)
    - Settlement detail extension supports counted-amount entry with double-confirm behavior driven by `ux_safety_policy.require_double_tap_for`.
    - Settlement list cards are surface-aware (status/expected/counted) using dynamic key extraction.
  - `/mobile/more` (policy controls for visibility, route view, diagnostics, and safety summaries)
    - Diagnostics mode may apply a temporary platform override (`android`/`ios`/`scanner`) for QA parity checks; runtime platform remains the default when override is off.
    - Includes connectivity + outbox summary with explicit sync action (`Sync now`) for offline-first operational clarity.
    - Diagnostics mode also shows recent outbox RPC entries so queued/failed actions remain observable without switching screens.
    - Surfaces access/module context (`scope` + enabled module labels) derived from navigation/access payloads to keep role/scope decisions visible and auditable.
    - Diagnostics mode can force online/offline simulation for QA; when enabled, effective connectivity follows the simulation toggle while runtime network remains unchanged.
    - Display preferences are operator-controlled and persisted in canonical local KV (`locale`, `direction`, `theme`); direction defaults from locale when unset, and theme uses native appearance mapping (`system`/`light`/`dark`) for platform-consistent rendering.
- `/mobile/diagnostics` (policy-gated internal visibility via `mobile_diagnostics_policy`)
- Background location tasking remains optional and policy-gated; when enabled, captures still write through the same Outbox + `record_location_ping_v1` path.
- Pickup route-stop execution reuses the same composer flow as delivery, but the shell should present pickup-aware labels and payload fields:
  - completion captures `confirmed_quantity`, `handover_contact_name`, `handover_notes`, and `receipt_context`
  - failure captures pickup reasons like `sender_unavailable`, `pickup_not_ready`, `access_restricted`, and `quantity_mismatch`
  - route-stop pickup exceptions still finalize the stop through the completed task-transition bridge, so the app must not invent a separate pickup state machine
- Delivery completion uses the same composer and canonical `tasks.complete` command, but selected `delivery_handover_mode` rows may require a saved recipient signature. The mobile shell must honor the lookup metadata and fail closed before queueing when signature proof is required.
- Delivery POD capture must also persist canonical proof anchors: `pod.captured_at` plus a normalized proof geostamp (`latitude`, `longitude`, optional `accuracy_m`) so shipment actions, tracking, and support views all resolve from the same backend truth.

## Driver reassignment requests
- The row-driven route-stop command uses the existing composer and scoped candidate RPC, retaining active same-organization driver identity, capacity remaining, ETA, and distance. Missing lookup data is not an unrestricted driver chooser.
- The durable Edge command records the enqueue-time actor as an expectation. The user-authenticated preparation RPC compares it to the verified caller and stores immutable stop/source-assignment/target/reason intent with a stable client idempotency key.
- Only the service-only submit RPC builds the workflow payload. Success requires the configured binding’s task-producing step to complete and the exact Dispatch review task to exist; replay returns the same linked identities.
- A request does not move a stop. An operator uses canonical UC078 reassignment. Its exact event may close only matching linked tasks through a private owner-privilege trigger and canonical task transition, without changing JWT claims.

## Auth UX (mobile)
- Sign-in is controlled by `NEXT_PUBLIC_AUTH_METHODS` (`password` and/or `magic_link`).
- `magic_link` uses an OTP code verification flow (`verifyOtp`) to avoid deep-link coupling.
- Sign-out wipes local SQLite outbox/cache and secure storage.
- Route-stop incident reporting keeps every actor/scope-bound queue receipt in one versioned KV list before outbox enqueue. Foreground and background sync retain only matched incident task/event IDs; the selected task shows each verified incident type, statement, review task, evidence count, route stop, and current source-task status only after a fresh online `api.ui_get_route_stop_incident_readback_v1` read. Offline, loading, or failed reads show pending feedback and a manual refresh path; a queued or synced action alone is not incident proof.

## Device setup (required for ingest)
- On first run (when online), register the device via `register_user_device_v1` and persist `device_id` in secure storage.
- Scan/location RPCs attach `device_id` and may be blocked by policy when missing (`mobile_ingest_policy.require_device`).
- Push token registration is controlled by `mobile_push_policy` and updates `user_devices.push_token` through the same idempotent `register_user_device_v1` path.
- Console/Portal device-governance support reads the same `public.user_devices` ledger through the registry-driven `user_devices` resource, and operator revoke flows must use `api.ui_execute_user_device_revoke_v1` so browser clients stay pinned to `db.schema=api`.
- Attestation challenge + envelope flow is controlled by `mobile_attestation_policy`; clients request one-time challenges via `issue_mobile_attestation_challenge_v1` and attach attestation metadata to ingest writes.

## SSOT contracts (mobile)
- `ui_me_v1`
- `ui_navigation_v1` (`apps.mobile`)
- `ui_read_registry_v1`
- `ui_command_registry_v1`
- `ui_execute_command_v1`

## Offline-first Outbox (required)
- All write operations enqueue an Outbox record first (durable local storage).
- Departure requests use the same durable outbox and foreground/background drainer. An offline request stays pending until connection and server approval; it never authorizes the driver to depart. Replay must retain the original actor/scope and route/stop/task/session context. A different login or scope cannot send the previous driver's request. The server rechecks route ownership, lineage and current load reconciliation, and serializes duplicate confirmations on the route row. Show confirmed only after matching canonical `route_departure.confirmed_at` readback; a removed queue row, sync completion or failed readback is not confirmation.
- Outbox entries must include:
  - `id`, `rpc`, `args`, `transport`, `created_at`, `updated_at`, `status`, `attempt_count`, `next_attempt_at`, `last_error`. The optional transport is `rpc` (including legacy SQLite rows) or `edge`; both use the same queue and recovery path.
- Sync rules:
  - Idempotent server RPCs are mandatory (dedupe on `(org,idempotency_key)` or equivalent).
  - The app must surface "Queued / Syncing / Failed" states; failures become actionable.
  - Never "fake success" when offline; show pending state until server confirmation or explicit policy allows optimistic UI. An item is synced only when its ID appears in that sync invocation’s positive completion receipt after execution and queue removal; an absent or cleared row is not proof.
  - Route/settlement interaction telemetry (`mobile_route_navigate`, `mobile_route_contact`, `mobile_settlement_counted`) is queued through `ui_log_events_v1` for auditability and diagnostics.

### Outbox diagnostics

Outbox diagnostics preserve the complete fixed messages `AssertionError`, `Assertion failed` and `Unexpected token < in JSON`. Additional text goes through the normal redactor.

| Diagnostic text | Withholding reason |
| --- | --- |
| Database uniqueness and foreign-key details | Constraint details can include record identifiers and values. The client can still use the conflict category when available. |
| Authentication, session, signature, PIN or key messages | Free-form messages can contain credentials or identity data. |
| Prose containing ambiguous credential terms | The redactor cannot establish the source or meaning of arbitrary prose. |
| ANSI formatting or unit symbols that normalize outside the supported character set | Withholding keeps the diagnostic character boundary predictable. |
| URLs with a `code` query parameter | A query parameter can carry a one-time credential. |
| Text combining colons and `@` in a credential-shaped segment | The redactor treats ambiguous user information as sensitive. |

## Implementation (write-once)
- Shared engine: `@masarx/mobile-core` provides a generic Outbox + sync loop (no business rules).
- Durable store: `@masarx/mobile-core/sqlite` implements a SQLite-backed store using `expo-sqlite` (Expo-managed; production-safe).
- Field Ops app (`apps/fieldops`) uses the Outbox for telemetry first (`ui_log_events_v1`) and expands to domain writes next (task transitions, scans, location pings) via idempotent RPCs.
- Read caching: `@masarx/mobile-core/sqlite` also provides a simple SQLite key/value cache for offline-friendly read models (cache is never SSOT).

## Safety-first UX (drivers)
- Glanceable lists, large targets, minimal text entry.
- Risky actions require confirmation patterns controlled by policy (double-tap, hold-to-confirm, supervisor unlock).
- While moving: reduce interactions (policy-driven driving mode).
  - Current speed is derived from captured location telemetry (`coords.speed`) and can be diagnostics-overridden for QA.
  - Locking is enforced by `driver_safety_policy.driving_mode` (`enabled`, `lock_when_moving`, `lock_threshold_kph`, `allowed_nav_keys_while_moving`) across module navigation and detail/action entry points.
  - Locked route map remains glanceable while blocking detail/action execution until speed drops below threshold.

## Security model (enterprise)
- No service-role secrets on device.
- All reads/writes via authenticated user JWT + RLS + SECURITY DEFINER RPCs with least-privilege grants.
- The outbox redactor handles accidental credential disclosure in supported diagnostic formats. Keep arbitrary ASCII rewrites of credential field names outside that contract. Treat messages from untrusted sources as untrusted data and use typed error codes for user-facing diagnostics.
- Device registration via `register_user_device_v1` (store push token + versions + metadata; policy-gated).
- Device attestation foundation is policy-driven (`mobile_attestation_policy`) and enforced server-side on mobile ingest ledgers:
  - Server issues one-time challenges (`issue_mobile_attestation_challenge_v1`) and validates challenge freshness/consumption.
  - Trigger-based enforcement gates `user_devices`, `scan_events`, `location_pings`, and `ops_sessions` for Field Ops events.
  - Rollout mode is row-driven (`off|monitor|enforce`) with safe global defaults.

## How to add a new mobile feature (no hardcoding)
- Add/extend a settings category + JSON schema in `schema_registry` with safe global defaults.
- Add or reuse an idempotent RPC/write-path (SECDEF) that writes to a canonical ledger/projection and logs decisions.
- Add registry rows for UI/resources/commands; do not add hardcoded screen routing.
- Add tests:
  - pgTAP for RLS/policies/ladder precedence/invariants.
  - Integration/E2E for the end-to-end mobile action (enqueue -> sync -> server ledger updated).


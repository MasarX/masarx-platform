#!/usr/bin/env node
// lint-capabilities.mjs — cross-checks the FE capability catalog (the
// `capabilities` array exported from `src/lib/seed-raw/registry.js`) against
// the canonical backend SSOT declarations under `supabase/migrations/`.
//
// Why this lint exists:
//   The console-v2 FE seed-driven gating MUST stay aligned with the backend
//   capability/permission registry. If the FE invents a string that the
//   backend never registered, the production fail-closed posture would deny
//   every gated action for that key. If the backend registers a key that the
//   FE never surfaces, operators can't reach functionality they were granted.
//   Either direction is a SSOT drift bug.
//
// Canonical backend declarations come from THREE places (all treated as SSOT):
//   1. `supabase/migrations/202601022113_access_control_policy_core.sql`
//      — JSON `{"key": "..."}` entries inside the global access_control_policy
//      seed (`capabilities` array of the policy JSON).
//   2. Wave-extension migrations that augment that same global policy via
//      `jsonb_build_object('key', '...', 'label', ...)` (e.g.,
//      `202602201020_access_control_policy_tenant_signup_requests_v1.sql`).
//   3. RBAC permission registry seeds — `lookup_values` rows under
//      `lookup_definitions.category = 'rbac_permission'` (e.g.,
//      `202601300030_rbac_foundation_v1.sql`,
//      `202604062250_rbac_routes_permissions_seed_v1.sql`).
//
// Drift policy (configurable via the explicit lists below; everything else
// fails closed — no implicit waivers):
//   - ALIAS_MAP: documented FE-side surface aliases that map to a canonical
//     backend capability/permission. The canonical key MUST exist in the
//     backend registries; the alias is then accepted as covered.
//   - FE_ONLY_PENDING: FE-only capability strings that the backend has not
//     yet registered (Wave-3 surfaces awaiting RLS/seed wiring). Each entry
//     must include a TODO/issue reference inline.
//   - BACKEND_ONLY_ACCEPTED: backend capabilities intentionally not surfaced
//     in console-v2 (mobile-only, internal RPC plumbing, deep marketplace
//     internals consumed only by edge functions, etc.).
//
// Usage:
//   node scripts/lint-capabilities.mjs
//
// Exit codes:
//   0 — capabilities aligned (with documented waivers applied)
//   1 — drift detected (printed to stderr)

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const APP_ROOT = resolve(__dirname, '..');
// Paths can be overridden via env vars for test isolation. Production CI uses
// the defaults (FE registry under apps/console-v2 and migrations under
// supabase/migrations at the repo root).
const REGISTRY_PATH = process.env.LINT_CAPABILITIES_REGISTRY_PATH
  ? resolve(process.env.LINT_CAPABILITIES_REGISTRY_PATH)
  : join(APP_ROOT, 'src', 'lib', 'seed-raw', 'registry.js');
const MIGRATIONS_DIR = process.env.LINT_CAPABILITIES_MIGRATIONS_DIR
  ? resolve(process.env.LINT_CAPABILITIES_MIGRATIONS_DIR)
  : join(REPO_ROOT, 'supabase', 'migrations');

// ---------------------------------------------------------------------------
// ALIAS_MAP — FE surface alias -> canonical backend capability/permission key
// ---------------------------------------------------------------------------
//
// Each entry says: "the FE intentionally uses <alias> at the call-site, but
// the backend canonical SSOT for the same gate is <canonical>". The lint
// treats the alias as covered iff <canonical> exists in the backend
// declarations.
//
// Add new entries with a one-line rationale and a migration cite.
const ALIAS_MAP = Object.freeze({
  // CLAIM-CATALOG-OFFERINGS — service catalog write seam. Backend SSOT is
  // `agreements.write` per
  // supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
  // (service_levels_write_policy + service_offerings_write_policy). The FE
  // surfaces a friendlier alias `service_offerings.write` for call-site
  // descriptiveness; both are granted alongside `agreements.write` in
  // seed.js dev_roles so the surface flows end-to-end without role drift.
  'service_offerings.write': 'agreements.write',
  // service_offerings.read mirrors the read seam — backend reads tunnel
  // through `agreements.read` (RBAC permission registry, see
  // 202601300030_rbac_foundation_v1.sql:44).
  'service_offerings.read': 'agreements.read',
});

// ---------------------------------------------------------------------------
// FE_ONLY_PENDING — FE strings not yet declared in any backend migration.
// ---------------------------------------------------------------------------
//
// These are knowingly drifted up. Each entry must reference the surface
// claim (Wave/CLAIM tag) and the open follow-up that will add the canonical
// backend declaration. Keep this list small — every entry is technical debt.
const FE_ONLY_PENDING = Object.freeze(new Set([
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — API gateway observability
  // surfaces. Backend RLS exists on public.api_call_log /
  // api_gateway_requests / api_gateway_rate_limits / api_routes /
  // api_route_packs / provider_health_logs but no capability/permission
  // string is registered yet. Follow-up: register `api_gateway.read|write`
  // in the access_control_policy seed extension.
  'api_gateway.read',
  'api_gateway.write',
  // CLAIM-SUPPORT-CASES (Wave 3, Phase C) — support triage surfaces. Backend
  // resource registry currently gates support_cases via `shipments.read`
  // (see 202603061345 ui_read_registry seed at :1651). Follow-up: register
  // distinct `support.read|write` capabilities for least-privilege gating.
  'support.read',
  'support.write',
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — alerts management. RLS exists
  // on public.alert_rules / alert_triggers / ops_alerts but no capability
  // string registered. Follow-up: register `alerts.read|write` capabilities.
  'alerts.read',
  'alerts.write',
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — feature-flag management. RLS
  // exists on public.feature_flags but no capability string registered.
  // Follow-up: register `feature_flags.read|write` capabilities.
  'feature_flags.read',
  'feature_flags.write',
  // CLAIM-NETWORK-MARKETPLACE — `marketplace.read|write` are roll-up surface
  // gates for the operator console. Backend declares fine-grained
  // marketplace_*.read|write per resource (see
  // 202603071110_marketplace_network_registry_rls_v1.sql) plus action-scoped
  // capabilities (`marketplace.award`, `marketplace.settle`, etc.).
  // Follow-up: either register the roll-up `marketplace.read|write` keys or
  // refactor the FE to gate on the per-resource keys.
  'marketplace.read',
  'marketplace.write',
  // CLAIM-NETWORK-BRANCHES — branches surface gate. Backend write policy
  // gates on `agreements.write` (202601300340), but the FE intentionally
  // names the surface `branches.read|write` for operator clarity. The read
  // gate has no canonical permission yet (RLS is tenant-scoped).
  // Follow-up: register `branches.read|write` in rbac_permission registry
  // or alias to `agreements.write` (decision pending in CLAIM-NETWORK-BRANCHES
  // audit).
  'branches.read',
  'branches.write',
  // CLAIM-FINANCE-BILLING — billing surface gates. Backend RLS exists on
  // billing_invoices / billing_invoice_lines / billing_invoice_events /
  // subscriptions / usage_events but no `billing.read|write` capability is
  // registered yet. `invoices.send|refund` are split-out write authorities.
  // Follow-up: register the four billing capabilities.
  'billing.read',
  'billing.write',
  'invoices.send',
  'invoices.refund',
  // CLAIM-FLEET-DRIVERS — Wave 10 D3 closure: the FE-invented
  // `drivers.read|drivers.write|compliance.write` keys have been retired in
  // favor of the canonical `fleet.read|fleet.write` SSOT (already gated on
  // driver_profiles / driver_documents / driver_compliance_events per the
  // canonical RBAC foundation 202601300030 + verify_driver_document_v1
  // assertion 202604280050:43). No FE-pending entries needed.
  // Surface roll-up gates with no direct backend equivalent (consumed by
  // the navigation.js menu rather than by individual RPC asserts). These
  // are intentional UI conveniences; backend gating happens on the
  // per-resource keys when the surface drills into a resource.
  'cod.read',                  // -> finance.read (see seed.js dev_roles)
  'disputes.read',             // -> finance.read
  'finance.write',             // umbrella write surface
  'imports.write',             // -> tabular_import.process (action-scoped)
  'devices.write',             // -> user_devices.write
  'insights.read',             // analytics surface roll-up
  'integrations.write',        // -> integration_plugins.write
  'labels.write',              // -> label_design.write
  'network.read',              // navigation roll-up
  'observability.read',        // -> audit_log.read + workflow_runs.read
  'pickups.read',              // -> tasks.read (no canonical pickups key)
  'settlements.read',          // -> finance.read
  'settlements.write',         // -> finance.write
  'settings.write',            // -> settings.request + settings.approve
  'warehouse.read',            // -> warehouse_transfers.read + handling_units.read
  'warehouse.write',           // -> warehouse_transfers.write + handling_units.write
  'workflows.read',            // -> workflow_runs.read
  'workflows.write',           // -> workflow_runs.write
  'zones.read',                // network/zones surface gate
  'zones.write',               // network/zones surface gate
  // W38-OPERATIONS P2-1 closure — FE-side operator-surface capability
  // strings used by Button capability props on shipments.tsx /
  // returned-to-branch.tsx.
  // `comms.write` is canonical (asserted server-side by
  // enqueue_comms_attempt_v1 via user_has_resource_capability_v1('comms',
  // 'write') per supabase/migrations/202604301600:122-126), but the
  // capability is registered through the dynamic
  // `user_has_resource_capability_v1` resolver pattern rather than as a
  // discrete migration string in rbac_permission. Follow-up: add a
  // dedicated entry in access_control_policy_core seed for parity with
  // `users.manage` etc.
  // `warehouse.scan` and `labels.reprint` are FE-only UX gates with no
  // direct backend permission registration; backend enforcement flows
  // through warehouse-table RLS (record_scan_event_v1) and labels-table
  // RLS (request_label_reprint) respectively. Follow-up: align FE Button
  // capability strings to canonical `warehouse.write` / `labels.write`
  // OR register dedicated permission keys in a future migration.
  'comms.write',
  'warehouse.scan',
  'labels.reprint',
]));

// ---------------------------------------------------------------------------
// BACKEND_ONLY_ACCEPTED — canonical backend keys not surfaced in console-v2.
// ---------------------------------------------------------------------------
//
// These belong to surfaces console-v2 doesn't host (mobile, internal edge
// plumbing, action-scoped capabilities consumed only by RPC bodies, etc.).
// Adding a key here is a deliberate decision NOT to expose it in the
// operator console. New FE modules that gate on a key should remove it from
// this list and add it to the FE registry.
const BACKEND_ONLY_ACCEPTED = Object.freeze(new Set([
  // -- Action-scoped capabilities consumed inside RPC bodies (not gated at
  // -- a console surface; the surface gates on the umbrella read/write).
  'access_policy.approve',
  'access_policy.request',
  'addresses.write',           // surface uses addresses.read; writes flow via shipments.write
  'agreements.read',           // see ALIAS_MAP for `service_offerings.read`
  'agreements.write',          // canonical for service_offerings + branches surfaces
  'api_routes.read',           // backend ingress observability internal
  'baskets.read',              // marketplace baskets — internal
  'baskets.write',
  'dispatch_exception_review.complete',
  'dispatch_exception_review_mine.complete',
  'fleet.read',                // FE surfaces drivers.* / vehicles.* aliases
  'fleet.write',
  'finance.read',              // FE umbrella surface; cod/settlements/billing roll up here
  'handling_units.read',       // warehouse internals
  'handling_units.write',
  // Integration plugin lifecycle — admin-tooling internal RPCs (no console
  // surface in v2 yet; these flow through the integrations module roll-up).
  'integration_plugins.activate',
  'integration_plugins.approve',
  'integration_plugins.read',
  'integration_plugins.test',
  'integration_plugins.write',
  // Label rendering subsystem — drives label-renderer edge function gates
  // (consumed by labels.read at the surface; design tooling is staff-only).
  'label_design.read',
  'label_design.write',
  'labels.download',           // RPC-level capability (surface gates on labels.read)
  // FieldOps Mobile V2-only gates. Console V2 does not host these runtime
  // surfaces; the native app consumes them through row-driven mobile
  // navigation/RPC policy and the console proof lives in Mobile V2 evidence.
  'cash_drop.write',
  'kyc.write',
  'hold.read',
  'hold.write',
  'location_pings.write',      // mobile-only (Field Ops app)
  'manual_review.read',        // surface uses pickups.read / tasks.read aggregations
  'manual_review.resolve',
  'mappings.read',             // mapping studio internals
  'mappings.write',
  // Marketplace action-scoped capabilities — fine-grained RPC asserts.
  // Console surfaces (network/marketplace) gate on the roll-up
  // `marketplace.read|write` (see FE_ONLY_PENDING). Each of these is
  // consumed inside its corresponding RPC body.
  'marketplace.accept_award',
  'marketplace.approve',
  'marketplace.award',
  'marketplace.complete_work',
  'marketplace.counter',
  'marketplace.dispute',
  'marketplace.expire',
  'marketplace.finalize_settlement',
  'marketplace.publish_availability',
  'marketplace.quote',
  'marketplace.reject_award',
  'marketplace.release',
  'marketplace.reopen',
  'marketplace.reverse_settlement',
  'marketplace.settle',
  'marketplace.submit_offer',
  // Marketplace per-resource RLS keys — FE surfaces use the roll-up; the
  // per-resource keys are RLS-internal.
  'marketplace_awards.read',
  'marketplace_awards.write',
  'marketplace_contracts.read',
  'marketplace_contracts.write',
  'marketplace_disputes.read',
  'marketplace_disputes.write',
  'marketplace_offers.read',
  'marketplace_offers.write',
  // marketplace_participant_requests.read|review are now surfaced in the FE
  // capabilities array (Wave 10 — codemod migrated participant-applications.tsx
  // to CAP.MARKETPLACE_PARTICIPANT_REQUESTS_READ|REVIEW). Removed from
  // backend-only-accepted accordingly.
  'marketplace_participants.read',
  'marketplace_participants.write',
  'marketplace_reputation_snapshots.read',
  'marketplace_requests.read',
  'marketplace_requests.write',
  'marketplace_verification_records.read',
  'marketplace_verification_records.write',
  'marketplace_work_packages.read',
  'marketplace_work_packages.write',
  // Exception action-scoped capabilities consumed inside RPC bodies.
  'mis_sort_exceptions.resolve_reassign',
  'operation_handlers.write',  // workflow handler internals
  'organizations.write',       // FE surfaces organizations.read; writes are
                               // tenant_signup_requests.review + RPC-level
  'provider_auth.read',        // integrations internals
  'requests.create',           // policy-request flow (FE uses inline UI)
  'requests.read',             // policy-request flow
  // Route plan RPC-scoped capabilities — surface gates on route_plans.read|write
  // (which IS in the backend declarations — verified by the lint).
  'route_plans.publish',
  'route_plans.rebalance',
  'route_plans.solve_sequence',
  // Route run / route stop / route assignment capabilities — driver-mobile only.
  'route_runs.assign',         // Console command key, not a FE capability gate
  'route_runs.accept_assignment',
  'route_runs.acknowledge_assignment',
  'route_runs.confirm_departure', // Console command key, not a FE capability gate
  'route_runs.refuse_assignment',
  'route_stops.reassign',
  'routes.assign',
  'routes.reassign',
  'scan_events.read',          // warehouse + driver mobile
  'scan_events.write',
  'settings.approve',          // FE surfaces settings.write at the surface
  'settings.request',
  'settings_category_registry.read', // Access/RBAC metadata plumbing; Console settings metadata reads gate on console_metadata.read/settings.read.
  'shipments.delete',          // RPC-scoped (surface uses shipments.write)
  'shipments.edit',
  'shipments.print_labels',
  'shipments.reschedule',
  'shipments.resort',
  'shipments.update_geocode',
  'sla_deadline_alerts.complete',
  'tabular_import.process',
  // Task action-scoped capabilities consumed by mobile + RPC bodies.
  'tasks.arrived',
  'tasks.close_route',
  'tasks.complete',
  'tasks.en_route',
  'tasks.exception',
  'tasks.open',
  'tasks.transition',          // Console command key, not a FE capability gate
  'trips.read',                // mobile-only (Field Ops app)
  'token_rotation.approve',    // platform/security-admin only
  'token_rotation.read',
  'token_rotation.request',
  'unassigned_exceptions.claim',
  'usage.read',                // SaaS metering — internal
  'user_devices.read',         // FE uses devices.write surface alias
  'user_devices.revoke',
  'user_devices.write',
  'users.manage',              // platform-admin only (FE uses organizations.read)
  'users.read',
  // Warehouse transfer action-scoped capabilities (surface uses
  // warehouse.read|write roll-up).
  'warehouse_transfers.dispatch',
  'warehouse_transfers.read',
  'warehouse_transfers.reconcile_destination',
  'warehouse_transfers.scan_arrival',
  'warehouse_transfers.scan_departure',
  'warehouse_transfers.write',
  'wallet.read',               // mobile-only (Field Ops app)
  'webhooks.archive_source',   // command key is routed and gated by webhooks.write in Console V2
  'webhook_sources.read',      // surface uses webhooks.read
  'workflow_runs.read',        // FE surface gate is workflows.read
  'workflow_runs.write',       // FE surface gate is workflows.write
  // Zone exception action-scoped capabilities consumed by mobile + RPC bodies.
  'wrong_zone_exceptions.request_zone_override',
  'wrong_zone_exceptions.resolve_reassign',
]));

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Parse the FE `capabilities = [ '...', '...' ]` literal. */
function extractFrontendCapabilities() {
  const text = readFileSync(REGISTRY_PATH, 'utf8');
  const match = text.match(/export\s+const\s+capabilities\s*=\s*\[([\s\S]*?)\];/);
  if (!match) {
    throw new Error(`Could not locate \`export const capabilities\` array in ${REGISTRY_PATH}`);
  }
  const block = match[1];
  // Strip line comments so commented-out strings aren't picked up.
  const stripped = block.replace(/\/\/[^\n]*/g, '');
  const out = new Set();
  for (const m of stripped.matchAll(/'([a-zA-Z][\w]*\.[a-z][\w.]*)'/g)) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Parse canonical backend capability/permission DECLARATIONS from migrations.
 *
 * We treat the following patterns as authoritative declarations:
 *   1. `"key":"foo.bar"` — JSON entries inside the access_control_policy seed.
 *   2. `jsonb_build_object('key', 'foo.bar', ...)` — wave-extension capability
 *      additions to the same global policy.
 *   3. `VALUES ('foo.bar', '<label>', ...)` rows in files that mention
 *      `'rbac_permission'` (the lookup_values seed for the permissions
 *      registry consumed by user_has_permission_v1).
 *   4. `TEXT[] := ARRAY['foo.bar', 'baz.qux', ...]` — Phase B5+ pattern where
 *      caps are batch-registered by iterating an array literal and emitting
 *      `jsonb_build_object('key', v_new_cap, ...)` per entry. The literal
 *      strings inside the ARRAY[...] are the canonical declarations.
 *      Constrained to files that mention `access_control_policy` (the SSOT
 *      seed) to avoid catching unrelated array literals.
 */
function extractBackendDeclarations() {
  const out = new Set();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const reJsonKey = /"key"\s*:\s*"([a-z][a-z_]*\.[a-z][a-z_]*)"/g;
  const reBuildObj = /jsonb_build_object\(\s*'key'\s*,\s*'([a-z][a-z_]*\.[a-z][a-z_]*)'/g;
  // For rbac_permission seed rows: each row in a multi-row VALUES block looks
  // like `('foo.bar', '<label>', ...)`. The first row is preceded by `VALUES`,
  // subsequent rows by a comma. We match either. Constrained to files that
  // declare `rbac_permission` to avoid catching unrelated tuple literals.
  const reLookupVals = /(?:VALUES|,)\s*\(\s*'([a-z][a-z_]*\.[a-z][a-z_]*)'\s*,\s*'/g;
  // Phase B5+ pattern — TEXT[] := ARRAY[...] of capability strings used to
  // batch-register caps into access_control_policy.
  const reTargetCapsArray = /TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/g;
  const reCapInArray = /'([a-z][a-z_]*\.[a-z][a-z_]*)'/g;
  for (const filename of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    let m;
    reJsonKey.lastIndex = 0;
    while ((m = reJsonKey.exec(text)) !== null) out.add(m[1]);
    reBuildObj.lastIndex = 0;
    while ((m = reBuildObj.exec(text)) !== null) out.add(m[1]);
    if (text.includes('rbac_permission')) {
      reLookupVals.lastIndex = 0;
      while ((m = reLookupVals.exec(text)) !== null) out.add(m[1]);
    }
    if (text.includes('access_control_policy')) {
      reTargetCapsArray.lastIndex = 0;
      while ((m = reTargetCapsArray.exec(text)) !== null) {
        const body = m[1];
        let cm;
        reCapInArray.lastIndex = 0;
        while ((cm = reCapInArray.exec(body)) !== null) out.add(cm[1]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drift computation
// ---------------------------------------------------------------------------

function computeDrift(fe, backend) {
  // Drift up: FE strings unaccounted-for in backend.
  // A string is accounted-for if it is:
  //   - present in backend, OR
  //   - aliased via ALIAS_MAP (and the canonical target IS in backend), OR
  //   - listed in FE_ONLY_PENDING.
  const driftUp = [];
  const aliasFailures = [];
  for (const cap of fe) {
    if (backend.has(cap)) continue;
    if (FE_ONLY_PENDING.has(cap)) continue;
    if (Object.prototype.hasOwnProperty.call(ALIAS_MAP, cap)) {
      const canonical = ALIAS_MAP[cap];
      if (backend.has(canonical)) continue;
      aliasFailures.push({ alias: cap, canonical });
      continue;
    }
    driftUp.push(cap);
  }

  // Drift down: backend strings unaccounted-for in FE.
  // A backend string is accounted-for if it is:
  //   - present in FE, OR
  //   - the canonical target of an ALIAS_MAP entry whose alias IS in FE, OR
  //   - listed in BACKEND_ONLY_ACCEPTED.
  const aliasTargets = new Set();
  for (const [alias, canonical] of Object.entries(ALIAS_MAP)) {
    if (fe.has(alias)) aliasTargets.add(canonical);
  }
  const driftDown = [];
  for (const cap of backend) {
    if (fe.has(cap)) continue;
    if (aliasTargets.has(cap)) continue;
    if (BACKEND_ONLY_ACCEPTED.has(cap)) continue;
    driftDown.push(cap);
  }

  return { driftUp: driftUp.sort(), driftDown: driftDown.sort(), aliasFailures };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let fe, backend;
  try {
    fe = extractFrontendCapabilities();
    backend = extractBackendDeclarations();
  } catch (err) {
    console.error(`lint-capabilities: extraction failed: ${err.message}`);
    process.exit(1);
  }

  const { driftUp, driftDown, aliasFailures } = computeDrift(fe, backend);

  const failed = driftUp.length > 0 || driftDown.length > 0 || aliasFailures.length > 0;
  if (!failed) {
    console.log(
      `All capabilities aligned (${fe.size} FE, ${backend.size} backend, ` +
      `${Object.keys(ALIAS_MAP).length} aliases, ${FE_ONLY_PENDING.size} FE-pending, ` +
      `${BACKEND_ONLY_ACCEPTED.size} backend-only-accepted).`
    );
    process.exit(0);
  }

  console.error('lint-capabilities: SSOT drift detected between FE and backend.');
  if (driftUp.length > 0) {
    console.error('');
    console.error(`  Drift UP (${driftUp.length}) — FE has strings that are NOT declared in any backend migration`);
    console.error('  and are NOT documented in ALIAS_MAP / FE_ONLY_PENDING:');
    for (const cap of driftUp) console.error(`    - ${cap}`);
    console.error('');
    console.error('  To resolve: add a backend migration declaring the capability, OR add the key to');
    console.error('  ALIAS_MAP (with a canonical backend target), OR add to FE_ONLY_PENDING with a');
    console.error('  documented follow-up migration plan.');
  }
  if (driftDown.length > 0) {
    console.error('');
    console.error(`  Drift DOWN (${driftDown.length}) — backend declares strings that the FE does NOT register`);
    console.error('  and that are NOT documented in BACKEND_ONLY_ACCEPTED:');
    for (const cap of driftDown) console.error(`    - ${cap}`);
    console.error('');
    console.error('  To resolve: add the key to the FE capabilities array (so the relevant module can');
    console.error('  gate on it), OR add to BACKEND_ONLY_ACCEPTED with a documented rationale.');
  }
  if (aliasFailures.length > 0) {
    console.error('');
    console.error(`  Alias failures (${aliasFailures.length}) — ALIAS_MAP target NOT in backend:`);
    for (const { alias, canonical } of aliasFailures) {
      console.error(`    - ${alias} -> ${canonical}  (canonical missing from backend declarations)`);
    }
  }
  process.exit(1);
}

main();

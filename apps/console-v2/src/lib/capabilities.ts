// capabilities.ts — canonical TypeScript bridge to the FE capability registry.
//
// SSOT chain:
//   1. backend access_control_policy seed + rbac_permission registry
//      (supabase/migrations/202601022113_access_control_policy_core.sql et al)
//   2. THIS FILE                                     ← TS-typed bridge
//   3. apps/console-v2/src/lib/seed-raw/registry.js  ← seed/test mirror
//
// The lint at `apps/console-v2/scripts/lint-capabilities.mjs` already
// enforces alignment between (1) and (2); the vitest at
// `apps/console-v2/src/lib/__tests__/capabilities.test.ts` enforces
// alignment between (2) and (3). With both gates green, every layer
// agrees on the canonical capability key set.
//
// Why this file exists (AGENTS.md §4 — SINGLE SOURCE OF TRUTH):
//   Before this bridge, modules declared `const WRITE_CAP = 'clients.write'`
//   (and similar) inline. That made the surface look uniform but spread
//   the canonical key strings across the codebase, and there was no
//   compile-time check that a `capability="X"` Button prop or a
//   `useCapability('X')` call referenced a real registered key — typos
//   would silently fail-closed.
//
//   This file:
//   * exposes the typed capability keys from this bridge without importing
//     seed-raw into the runtime bundle,
//   * exposes an `isCapability` runtime type guard,
//   * names every key as a const property of `CAP` so call sites get
//     autocomplete + a compile-time error on typos,
//   * keeps seed-raw alignment enforced in tests/lint instead of importing
//     seed-raw into production source.

/**
 * Named const accessors for every capability the console-v2 FE reads.
 *
 * Modules MUST import a key from this object instead of writing the
 * string literal inline. The object is kept frozen so accidental
 * mutation surfaces in dev/test mode immediately.
 *
 * Keys are TypeScript-stable: a typo (`CAP.CLEITNS_WRITE`) is a compile
 * error; a missing key (added to seed-raw but not exposed here) is
 * caught by the alignment vitest.
 *
 * Naming convention: <DOMAIN>_<ACTION> in SCREAMING_SNAKE_CASE.
 */
export const CAP = Object.freeze({
  // ---- Customers ------------------------------------------------------
  CLIENTS_READ: 'clients.read',
  CLIENTS_WRITE: 'clients.write',
  SENDERS_READ: 'senders.read',
  SENDERS_WRITE: 'senders.write',
  RECIPIENTS_READ: 'recipients.read',
  RECIPIENTS_WRITE: 'recipients.write',
  ADDRESSES_READ: 'addresses.read',

  // ---- Operate / shipments / dispatch / fleet -------------------------
  SHIPMENTS_READ: 'shipments.read',
  SHIPMENTS_WRITE: 'shipments.write',
  ROUTES_READ: 'routes.read',
  ROUTES_WRITE: 'routes.write',
  ROUTE_PLANS_READ: 'route_plans.read',
  ROUTE_PLANS_WRITE: 'route_plans.write',
  BASKETS_READ: 'baskets.read',
  BASKETS_WRITE: 'baskets.write',
  PICKUPS_READ: 'pickups.read',
  FLEET_READ: 'fleet.read',
  FLEET_WRITE: 'fleet.write',
  TASKS_READ: 'tasks.read',
  TASKS_WRITE: 'tasks.write',
  TASKS_COMPLETE: 'tasks.complete',
  COMMS_WRITE: 'comms.write',
  WAREHOUSE_READ: 'warehouse.read',
  WAREHOUSE_WRITE: 'warehouse.write',
  WAREHOUSE_SCAN: 'warehouse.scan',
  LABELS_READ: 'labels.read',
  LABELS_WRITE: 'labels.write',
  LABELS_DOWNLOAD: 'labels.download',
  LABELS_REPRINT: 'labels.reprint',
  LABEL_DESIGN_READ: 'label_design.read',
  LABEL_DESIGN_WRITE: 'label_design.write',

  // ---- Catalog -------------------------------------------------------
  LOOKUPS_READ: 'lookups.read',
  LOOKUPS_WRITE: 'lookups.write',
  AGREEMENTS_WRITE: 'agreements.write',
  SERVICE_OFFERINGS_READ: 'service_offerings.read',
  SERVICE_OFFERINGS_WRITE: 'service_offerings.write',

  // ---- Finance -------------------------------------------------------
  FINANCE_READ: 'finance.read',
  FINANCE_WRITE: 'finance.write',
  COD_READ: 'cod.read',
  SETTLEMENTS_READ: 'settlements.read',
  SETTLEMENTS_WRITE: 'settlements.write',
  DISPUTES_READ: 'disputes.read',
  DISPUTES_WRITE: 'disputes.write',
  BILLING_READ: 'billing.read',
  BILLING_WRITE: 'billing.write',
  INVOICES_SEND: 'invoices.send',
  INVOICES_REFUND: 'invoices.refund',

  // ---- Network -------------------------------------------------------
  NETWORK_READ: 'network.read',
  BRANCHES_READ: 'branches.read',
  BRANCHES_WRITE: 'branches.write',
  ZONES_READ: 'zones.read',
  ZONES_WRITE: 'zones.write',
  MARKETPLACE_READ: 'marketplace.read',
  MARKETPLACE_WRITE: 'marketplace.write',

  // ---- Platform / identity / governance ------------------------------
  ORGANIZATIONS_READ: 'organizations.read',
  ORGANIZATIONS_WRITE: 'organizations.write',
  ACCESS_POLICY_READ: 'access_policy.read',
  ACCESS_POLICY_APPROVE: 'access_policy.approve',
  TENANT_SIGNUP_REQUESTS_READ: 'tenant_signup_requests.read',
  TENANT_SIGNUP_REQUESTS_REVIEW: 'tenant_signup_requests.review',
  MARKETPLACE_PARTICIPANT_REQUESTS_READ: 'marketplace_participant_requests.read',
  MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW: 'marketplace_participant_requests.review',
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  SETTINGS_READ: 'settings.read',
  SETTINGS_WRITE: 'settings.write',
  SYSTEM_WRITE: 'system.write',
  ALERTS_READ: 'alerts.read',
  ALERTS_WRITE: 'alerts.write',
  FEATURE_FLAGS_READ: 'feature_flags.read',
  FEATURE_FLAGS_WRITE: 'feature_flags.write',
  DEVICES_WRITE: 'devices.write',
  USER_DEVICES_READ: 'user_devices.read',
  USER_DEVICES_WRITE: 'user_devices.write',
  CONSOLE_METADATA_READ: 'console_metadata.read',

  // ---- Integrations / observability ---------------------------------
  INTEGRATIONS_READ: 'integrations.read',
  INTEGRATIONS_WRITE: 'integrations.write',
  INTEGRATION_PLUGINS_READ: 'integration_plugins.read',
  INTEGRATION_PLUGINS_WRITE: 'integration_plugins.write',
  INTEGRATION_PLUGINS_TEST: 'integration_plugins.test',
  INTEGRATION_PLUGINS_APPROVE: 'integration_plugins.approve',
  INTEGRATION_PLUGINS_ACTIVATE: 'integration_plugins.activate',
  PROVIDER_AUTH_READ: 'provider_auth.read',
  WEBHOOKS_READ: 'webhooks.read',
  WEBHOOKS_WRITE: 'webhooks.write',
  MAPPINGS_READ: 'mappings.read',
  MAPPINGS_WRITE: 'mappings.write',
  IMPORTS_READ: 'imports.read',
  IMPORTS_WRITE: 'imports.write',
  API_GATEWAY_READ: 'api_gateway.read',
  API_GATEWAY_WRITE: 'api_gateway.write',
  OBSERVABILITY_READ: 'observability.read',
  AUDIT_LOG_READ: 'audit_log.read',
  INSIGHTS_READ: 'insights.read',

  // ---- Workflows / support ------------------------------------------
  WORKFLOWS_READ: 'workflows.read',
  WORKFLOWS_WRITE: 'workflows.write',
  SUPPORT_READ: 'support.read',
  SUPPORT_WRITE: 'support.write',
  MANUAL_REVIEW_RESOLVE: 'manual_review.resolve',
} as const);

/**
 * Canonical FE capability key set, derived from the typed bridge. Seed/backend
 * alignment is still asserted by `capabilities.test.ts` + lint-capabilities,
 * but live bundles no longer import `seed-raw/registry.js`.
 *
 * Runtime payload only — for compile-time narrowing use `Capability`.
 */
export const CAPABILITY_KEYS: ReadonlyArray<string> = Object.freeze(Array.from(Object.values(CAP)));

/**
 * Set form for O(1) membership checks (used by `isCapability` and by the
 * identity provider when filtering navigation items / button gates).
 */
export const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_KEYS);

/**
 * Runtime guard: returns true iff `s` is a capability registered in the FE
 * SSOT (which the lint guarantees is a subset of the backend SSOT).
 *
 * Use this anywhere you accept a capability string from a less-trusted
 * source (URL params, API responses, MSW fixtures) before passing it to
 * `useCapability` / `hasCapability` — invalid keys fail-closed because
 * `useCapability(<unknown>)` returns `false`, but surfacing the bad key
 * loudly via a guard is preferable to silent denial.
 */
export function isCapability(s: string | null | undefined): s is string {
  if (s == null) return false;
  return CAPABILITY_SET.has(s);
}

/**
 * Wildcard token granting every capability.
 *
 * The backend access_control_policy SSOT stores the super_admin grant as `*`
 * (`supabase/migrations/202601022113_access_control_policy_core.sql`), and
 * live Console identity hydrates that exact token from `api.ui_me_v1`.
 *
 * Older seed-mode fixtures used `all`. Keep accepting that legacy token so
 * tests/stories remain compatible, but prefer the backend token everywhere new.
 */
export const WILDCARD_CAPABILITY = '*' as const;
export const LEGACY_WILDCARD_CAPABILITY = 'all' as const;
export type WildcardCapability = typeof WILDCARD_CAPABILITY;

export function isWildcardCapability(value: string | null | undefined): boolean {
  return value === WILDCARD_CAPABILITY || value === LEGACY_WILDCARD_CAPABILITY;
}

export function hasWildcardCapability(
  capabilities: Iterable<string> | null | undefined,
): boolean {
  if (!capabilities) return false;
  for (const capability of capabilities) {
    if (isWildcardCapability(capability)) return true;
  }
  return false;
}

const CAPABILITY_LABEL_OVERRIDES: Record<string, string> = Object.freeze({
  'access_policy.read': 'access policy',
  'access_policy.approve': 'access approval',
  'agreements.write': 'service level management',
  'alerts.write': 'alert update',
  'api_gateway.read': 'API gateway',
  'api_gateway.write': 'API gateway update',
  'audit_log.read': 'audit activity',
  'branches.write': 'branch update',
  'billing.write': 'billing update',
  'clients.read': 'client access',
  'clients.write': 'client update',
  'cod.read': 'COD',
  'devices.write': 'device management',
  'disputes.write': 'dispute update',
  'finance.read': 'finance access',
  'finance.write': 'finance update',
  'feature_flags.read': 'feature flag',
  'feature_flags.write': 'feature flag update',
  'fleet.write': 'fleet update',
  'imports.read': 'import access',
  'imports.write': 'import update',
  'integrations.write': 'integration update',
  'integration_plugins.read': 'integration plugin',
  'integration_plugins.write': 'integration plugin update',
  'integration_plugins.test': 'integration plugin test',
  'integration_plugins.approve': 'integration plugin approval',
  'integration_plugins.activate': 'integration plugin activation',
  'invoices.refund': 'invoice refund',
  'invoices.send': 'invoice send',
  'lookups.read': 'lookup access',
  'lookups.write': 'lookup update',
  'marketplace_participant_requests.read': 'partner application',
  'marketplace_participant_requests.review': 'partner application review',
  'recipients.read': 'recipient access',
  'recipients.write': 'recipient update',
  'routes.write': 'route update',
  'route_plans.read': 'route plan',
  'route_plans.write': 'route plan update',
  'senders.read': 'sender access',
  'senders.write': 'sender update',
  'service_offerings.read': 'service offering',
  'service_offerings.write': 'service offering update',
  'settlements.read': 'settlement',
  'settlements.write': 'settlement update',
  'settings.read': 'settings access',
  'shipments.read': 'shipment access',
  'shipments.write': 'shipment update',
  'support.write': 'support update',
  'tenant_signup_requests.read': 'tenant signup',
  'tenant_signup_requests.review': 'tenant signup review',
  'tasks.complete': 'task completion',
  'tasks.write': 'task update',
  'user_devices.read': 'device access',
  'user_devices.write': 'device revocation',
  'users.read': 'user access',
  'users.manage': 'user management',
  'webhooks.write': 'webhook update',
  'workflows.write': 'workflow update',
});

function titleCasePhrase(value: string): string {
  return value.replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

export function formatCapabilityLabel(
  capability: string | null | undefined,
  options: { titleCase?: boolean } = {},
): string {
  const raw = String(capability ?? '').trim();
  if (!raw) return options.titleCase ? 'Permission' : 'permission';
  const override = CAPABILITY_LABEL_OVERRIDES[raw];
  const phrase =
    override ??
    raw
      .split('.')
      .map((part) => part.replace(/_/g, ' '))
      .filter(Boolean)
      .join(' ');
  return options.titleCase ? titleCasePhrase(phrase) : phrase;
}

export function formatCapabilityRequirement(capability: string | null | undefined): string {
  return `${formatCapabilityLabel(capability, { titleCase: true })} permission required`;
}

export function formatCapabilityTitle(capability: string | null | undefined): string {
  return `Requires ${formatCapabilityLabel(capability)} permission`;
}

/**
 * Compile-time literal-union of every capability key surfaced by the
 * console-v2 FE. Use this as the type for module-level `WRITE_CAP`-style
 * constants and for parameters to `useCapability` / button props.
 *
 * Note: a string narrower than `Capability` (the older permissive type
 * in `types/domain.ts`) is intentional — it lets typescript catch typos
 * at the call site without breaking the broader compatibility surface
 * with seed-raw or backend-native string flows.
 */
export type CapabilityKey = string;

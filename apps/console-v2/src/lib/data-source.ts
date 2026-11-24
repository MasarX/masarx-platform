// data-source.ts — SINGLE adapter. Mirrors api.* RPC shapes (AGENTS.md line 43).
// Modules MUST NOT import from /data directly; everything routes through this file.
//
// ============================================================================
// SWAP-SEAM CONTRACT (canonical — read before editing any adapter below)
// ============================================================================
//
// This file is the ONLY place that knows about the data backend. Every adapter
// follows the same one-line branch:
//
//   const client = getSupabaseClient();
//   if (client) {
//     const { data, error } = await client.rpc('<canonical_rpc>', args);
//     if (error) throw new Error(error.message);
//     return data as <ReturnShape>;
//   }
//   // …in-memory fallback (seed-raw/*) …
//
// The cutover from in-memory (demo) mode to live Supabase is a PURE ENVIRONMENT
// CHANGE — no source edits required:
//
//   1. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the deploy env.
//   2. `getSupabaseClient()` (lib/supabase.ts) starts returning a non-null client.
//   3. Every adapter automatically routes through `client.rpc(...)`.
//   4. The in-memory branch becomes dead code on production builds.
//
// INVARIANTS (do not break):
//   - This is the ONLY file that changes at cutover. Modules call api.* (which
//     calls this file) and never reach into seed-raw/* or supabase directly.
//   - External signatures here are precisely typed so consumers get full TS
//     checking; the seed import is intentionally `as any` because seed-raw/*.js
//     has no .d.ts (schema-free authoring is by design).
//   - Each adapter MUST mirror the canonical RPC shape exactly — return types
//     are bound to the contract so the swap is a body change, not a signature
//     change. Adapters that materialize canonical-arg payloads (e.g. the
//     6-arg `dispatch_exception_resolution_v1`) keep the FE compat shape on the
//     outside and the canonical shape on the wire.
//   - Cutover order is environment-driven only. Do NOT add per-adapter env
//     toggles; the single seam is `getSupabaseClient()` returning null vs. not.
//
// See `apps/console-v2/.env.example` for the env contract and
// `apps/console-v2/src/lib/supabase.ts` for the factory implementation.
// ============================================================================
//
// The internal seed import is intentionally untyped (`as any`): seed-raw/*.js is
// a JavaScript module without `.d.ts`, and authoring full types for it adds no
// safety beyond the EXTERNAL signatures exported here. The exports themselves
// are precisely typed so consumers (api.ts, modules) get real TypeScript checks.

// The seed catalog is loaded through the bundle-aware seam in `seed-loader.ts`.
// In seed mode (`VITE_USE_SEED !== 'false'`, default), it dynamically imports
// `./seed-raw/seed.js` at module init via top-level await. In live mode
// (`VITE_USE_SEED=false`), the import is unreachable and Rollup tree-shakes the
// seed graph out of the production bundle. EXTERNAL signatures below stay
// precisely typed; the runtime `seed` reference is permissive (`any`) so
// existing call sites continue to compile unchanged.
import { seed as seedNamespace, SEED_MODE_ENABLED } from './seed-loader';
import { getSupabaseClient } from './supabase';
import { isShipmentCreateIntent } from './webhook-intents';
import { hostedInviteRedirect } from './hosted-redirect';
import { normalizeShipmentTimelineRows, type ShipmentTimelineRow } from './shipment-timeline';
import type { IntegrationPluginMutationOptions } from './data-source/integrations';
import { asNonEmptyString, booleanReadback, type ResourceRow } from './data-source/shared';
import {
  API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_INTERVAL_MS,
  API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_TIMEOUT_MS,
  API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE,
  API_GATEWAY_EDGE_INVOKE_TIMEOUT_MS,
  API_GATEWAY_REQUEST_READBACK_AFTER_INVOKE_TIMEOUT_MS,
  API_GATEWAY_REQUEST_READBACK_INTERVAL_MS,
  API_GATEWAY_REQUEST_READBACK_TIMEOUT_MS,
  API_GATEWAY_TERMINAL_SETTLE_AFTER_FIRST_READBACK_MS,
  apiGatewayAuthRejectionMessage,
  apiGatewayEdgeAuthErrorMessage,
  type ApiGatewayInvokeMethod,
  apiGatewayReadbackOccurredAfter,
  apiGatewayReadbackTerminal,
  assertApiGatewaySelectedSourceMatchesReadback,
  buildApiGatewayRequestResult,
  buildApiGatewaySyntheticResult,
  buildWebhookReceiverSyntheticResult,
  buildWebhookReceiverTestResult,
  findNestedNumber,
  findNestedString,
  normalizeApiGatewayMethod,
  type RunApiGatewayRequestTestArgs,
  type RunApiGatewayRequestTestResult,
  type RunWebhookReceiverTestArgs,
  type RunWebhookReceiverTestResult,
  splitApiGatewayPath,
  WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS,
  WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS,
  WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS,
  WEBHOOK_RECEIVER_READBACK_AFTER_INVOKE_TIMEOUT_MS,
  WEBHOOK_RECEIVER_READBACK_INTERVAL_MS,
  WEBHOOK_RECEIVER_TERMINAL_READBACK_TIMEOUT_MS,
  withApiGatewayInvokeTimeout,
} from './data-source/external-intake-readback';
import {
  projectIntegrationCredentialDirectory as _projectIntegrationCredentialDirectory,
  projectMappingConfigDirectory as _projectMappingConfigDirectory,
  projectWebhookInboxDirectory as _projectWebhookInboxDirectory,
  projectWebhookSourceDirectory as _projectWebhookSourceDirectory,
} from './data-source/integration-directory-projections';
import {
  type LogisticsCustomerMigrationArgs,
  type LogisticsCustomerMigrationConfigArgs,
  type LogisticsCustomerMigrationConfigResult,
  type LogisticsCustomerMigrationResult,
} from './data-source/customer-logistics-migration';
import {
  LEGACY_WILDCARD_CAPABILITY,
  WILDCARD_CAPABILITY,
  hasWildcardCapability,
  isWildcardCapability,
} from './capabilities';
import type { UiOnboardingReadiness } from '../types/domain';

export type {
  RunApiGatewayRequestTestArgs,
  RunApiGatewayRequestTestResult,
  RunWebhookReceiverTestArgs,
  RunWebhookReceiverTestResult,
} from './data-source/external-intake-readback';
export type {
  LogisticsCustomerMigrationArgs,
  LogisticsCustomerMigrationConfigArgs,
  LogisticsCustomerMigrationConfigResult,
  LogisticsCustomerMigrationResult,
} from './data-source/customer-logistics-migration';

export const seed: any = seedNamespace;

export function liveBackendUnavailableError(adapterName: string): Error {
  return new Error(
    `${adapterName}: VITE_USE_SEED=false disables Console V2 seed fallbacks; configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY so the request reaches the live api-schema backend.`,
  );
}

// ----------- Mutable runtime store (in-memory) -----------
interface EvidenceCallback {
  (entry: Record<string, unknown>): void;
}

interface RuntimeState {
  user: Record<string, unknown> & {
    role: string;
    access_scope_type: 'platform' | 'tenant' | 'client' | 'sender';
    access_scope_id: string | null;
    organization_id: string;
  };
  capabilities: Set<string>;
  scope: Record<string, unknown>;
  evidence_subscribers: Set<EvidenceCallback>;
}

// In live mode (`VITE_USE_SEED=false`) the seed namespace is empty, so every
// `seed.<key>` lookup below resolves to `undefined`; the spread + nullish
// coalescing pattern keeps state initialization safe in both modes. Live mode
// surfaces (auth, scope) are populated by IdentityProvider after the Supabase
// session resolves — these defaults are the pre-auth bootstrap shape.
const seedCurrentUser = (seed.current_user as Record<string, unknown> | undefined) ?? {};
const seedCurrentCapabilities = (seed.current_capabilities as string[] | undefined) ?? [];
const seedCurrentScope = (seed.current_scope as Record<string, unknown> | undefined) ?? {};

export const state: RuntimeState = {
  // Pre-auth bootstrap user. In seed mode the seed catalog populates every
  // field (role/scope/org_id) at module init. In live mode the seed namespace
  // is empty (`{}`) and these fields stay empty/null until IdentityProvider
  // overrides them with the real Supabase session payload — empty values are
  // intentional sentinels (no tenant-coupled defaults baked into source).
  // Scope/id invariants mirror `users_access_scope_consistency_check` from
  // `supabase/migrations/202512291310_users_access_scope_model.sql`.
  user: {
    ...seedCurrentUser,
    role: (seedCurrentUser as { role?: string })?.role ?? '',
    access_scope_type: ((seedCurrentUser as { access_scope_type?: string })?.access_scope_type ?? 'platform') as
      'platform' | 'tenant' | 'client' | 'sender',
    access_scope_id: ((seedCurrentUser as { access_scope_id?: string | null })?.access_scope_id ?? null),
    organization_id: ((seedCurrentUser as { organization_id?: string })?.organization_id ?? ''),
  },
  capabilities: new Set<string>(seedCurrentCapabilities),
  scope: { ...seedCurrentScope },
  evidence_subscribers: new Set<EvidenceCallback>(),
};

// Synthetic decision_log stream — emits one new entry every ~6s to drive Evidence Rail
const SYNTHETIC_CATEGORIES: Array<readonly [string, string, string]> = [
  ['route_assignment', 'tenant', 'srlv_8331'],
  ['geocoding', 'client', 'srlv_8328'],
  ['comms_scheduling', 'tenant', 'srlv_8327'],
  ['rate_limiting', 'global', 'srlv_8320'],
  ['provider_selection', 'tenant', 'srlv_8318'],
  ['cod_collection', 'client', 'srlv_8315'],
  ['workflow_trigger', 'client', 'srlv_8310'],
  ['retry_logic', 'tenant', 'srlv_8302'],
];
let syntheticIndex = 0;
let syntheticCounter = 5822;

// SCHEMA-DRIFT NOTE (Wave 11 / W11-5 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §6):
// Synthetic streamer for the Evidence Rail. Aligned to canonical
// `public.decision_log` shape:
//   • `timestamp` is the canonical column (renamed from FE-side `occurred_at`).
//   • `resolved_from` is NOT a column on `decision_log`; it is projected from
//     `settings_resolution_log.winning_scope_type` via JOIN. Emitted here as
//     an extended field so consumers (Statusbar, decisions.tsx, decisionTrail)
//     can render scope context without an extra round-trip.
function nextSyntheticDecision(): Record<string, unknown> {
  const tuple = SYNTHETIC_CATEGORIES[syntheticIndex % SYNTHETIC_CATEGORIES.length]!;
  const [category, scope, srlvBase] = tuple;
  syntheticIndex++;
  syntheticCounter++;
  return {
    id: `dlog_${syntheticCounter}`,
    timestamp: new Date().toISOString(),
    decision_category: category,
    resource_type: 'shipment',
    resource_id: `shp_938${1300 + (syntheticCounter % 60)}`,
    resolved_from: scope,
    settings_resolution_id: `${srlvBase.split('_')[0]}_${8332 + syntheticIndex}`,
  };
}

// Synthetic decision_log emitter is seed-mode only. In live mode the Evidence
// Rail is fed by `listDecisionLog()` reads against the real `decision_log`
// table; emitting synthetic entries on top of that would corrupt the audit
// view. Gating on `SEED_MODE_ENABLED` ensures the timer is dead code in
// production builds (Rollup folds the literal false).
if (SEED_MODE_ENABLED) {
  setInterval(() => {
    const entry = nextSyntheticDecision();
    state.evidence_subscribers.forEach((cb) => {
      try {
        cb(entry);
      } catch {
        // never let a subscriber throw take down the timer
      }
    });
  }, 6000);
}

// ----------- Identity & capabilities -----------
// Returns the current user/scope as a permissive record. Consumers
// (IdentityProvider) re-cast to the canonical `User` / `Scope` shapes from
// `types/domain` — keeping the seam permissive while the rest of this file
// stays strictly typed. The runtime shape is a superset of those domain types.
export function getCurrentUser(): Record<string, unknown> {
  return state.user as unknown as Record<string, unknown>;
}
export function getCurrentScope(): Record<string, unknown> {
  return state.scope;
}
export function getCapabilities(): string[] {
  return Array.from(state.capabilities);
}
export function hasCapability(cap?: string | null): boolean {
  if (!cap) return true;
  if (hasWildcardCapability(state.capabilities)) return true;
  return state.capabilities.has(cap);
}
/**
 * Switch the live demo's role.
 *
 * Each canonical role declares its `access_scope_type` (and an
 * `access_scope_id` for client/sender) in `seed-raw/seed.js#dev_roles`. This
 * function mirrors that mapping into runtime state so the new
 * `useIdentity().isPlatformUser() / isTenantUser() / isPortalUser()` helpers
 * (and the AppGuard at the shell root) reflect the switch immediately.
 *
 * Invariants enforced (mirror `users_access_scope_consistency_check` from
 * `supabase/migrations/202512291310_users_access_scope_model.sql`):
 *   - platform/tenant -> access_scope_id := null
 *   - client/sender   -> access_scope_id := role's seeded scope_id
 *
 * Mode handling (closes Wave 1 residual: setRole live-mode bypass):
 *   - Seed mode: read role definitions from `seed.dev_roles` (existing path).
 *   - Live mode (`getSupabaseClient()` returns non-null): no demo dev-role
 *     switcher applies — production identity comes from the real Supabase
 *     session via `IdentityProvider`. The function exits as a no-op so the
 *     missing `seed.dev_roles` array doesn't surface a `TypeError`.
 *
 * If a future surface needs operator-driven role impersonation in live mode,
 * the canonical seam is a backend RPC (`set_active_role_v1` etc.) that
 * `assert_capability_v1`-gates and writes a `decision_log` entry — never a
 * client-side seed lookup.
 */
export function setRole(roleId: string): void {
  if (!SEED_MODE_ENABLED || getSupabaseClient() !== null) {
    // Live mode: dev-role impersonation is a seed-only affordance. No-op
    // here; identity is owned by IdentityProvider + Supabase session.
    return;
  }
  const devRoles = (seed.dev_roles as
    | Array<{
        id: string;
        capabilities: string[] | 'all';
        access_scope_type?: 'platform' | 'tenant' | 'client' | 'sender';
        access_scope_id?: string | null;
      }>
    | undefined) ?? [];
  const role = devRoles.find((r) => r.id === roleId);
  if (!role) return;
  // Default tier defensively to 'tenant' (matches backend default in the
  // migration) if a seeded role omits it.
  const tier = role.access_scope_type ?? 'tenant';
  // For platform/tenant tiers the backend constraint forces scope_id NULL.
  const nextScopeId =
    tier === 'platform' || tier === 'tenant' ? null : (role.access_scope_id ?? null);
  state.user = {
    ...state.user,
    role: role.id,
    access_scope_type: tier,
    access_scope_id: nextScopeId,
  };
  if (typeof role.capabilities === 'string' && isWildcardCapability(role.capabilities)) {
    state.capabilities = new Set(seed.current_capabilities as string[]);
    state.capabilities.add(WILDCARD_CAPABILITY);
    state.capabilities.add(LEGACY_WILDCARD_CAPABILITY);
  } else {
    state.capabilities = new Set(Array.isArray(role.capabilities) ? role.capabilities : [role.capabilities]);
  }
}

// ----------- Organizations (TenantPicker source for platform users) -----------
// Mirrors `ui_list_resource_v1('organizations')` against `public.organizations`.
// Returns the seed orgs (Rashed Logistics + Swift Express KSA) so platform
// users can switch tenant context in the demo. Live RPC swap-seam: see file
// header (canonical RPC: `ui_list_resource_v1` with `{ p_resource: 'organizations' }`).
export interface OrganizationRow {
  id: string;
  name: string;
  tenant_type?: string;
  status?: string;
  created_at?: string;
}
export async function listOrganizations(): Promise<OrganizationRow[]> {
  await sleep(20);
  return (seed.organizations as OrganizationRow[] | undefined) ?? [];
}

// ----------- Registries (drive the dynamic UI) -----------
// These helpers stay synchronous for existing module call sites, but in live
// mode they hydrate a small api-schema cache behind the same seam. Seed remains
// the no-client fallback; production calls route through api.* RPC/resource
// wrappers and reuse the cached shape on subsequent reads.
interface LookupOptionRow {
  value: string;
  label: string;
  tone?: string;
  rank?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}

interface SettingsCategoryRow {
  category: string;
  domain: string;
  scopes: string[];
  approval_required?: boolean;
  schema_id: string;
  [key: string]: unknown;
}

export const liveMetadataCache: {
  navigation?: unknown;
  readRegistry?: unknown;
  commandRegistry?: unknown;
  settingsCategories?: SettingsCategoryRow[];
  lookups: Record<string, LookupOptionRow[]>;
  workflowTemplateIds: Record<string, string | null>;
  driverHoursOfService: Record<string, DriverHoursOfServiceRecord | null>;
} = {
  lookups: {},
  workflowTemplateIds: {},
  driverHoursOfService: {},
};

const liveMetadataPending = new Set<string>();
let liveMetadataHydration: Promise<void> | null = null;
let liveMetadataHydrationFailed = false;

function clearLiveBootMetadataCache(): void {
  liveMetadataCache.navigation = undefined;
  liveMetadataCache.readRegistry = undefined;
  liveMetadataCache.commandRegistry = undefined;
  liveMetadataCache.settingsCategories = undefined;
  liveMetadataCache.lookups = {};
  liveMetadataPending.clear();
}

function shouldFailClosedLiveMetadata(): boolean {
  return hasConsoleLiveBackend() && liveMetadataHydrationFailed;
}

export function hasConsoleLiveBackend(): boolean {
  return Boolean(getSupabaseClient());
}

export function isConsoleSeedModeEnabled(): boolean {
  return SEED_MODE_ENABLED;
}

function setLiveNavigationCache(value: unknown): void {
  liveMetadataCache.navigation = liveMetadataCache.readRegistry !== undefined
    ? reconcileNavigationCapabilitiesFromReadRegistry(value, liveMetadataCache.readRegistry)
    : value;
}

function setLiveReadRegistryCache(value: unknown): void {
  liveMetadataCache.readRegistry = value;
  if (liveMetadataCache.navigation !== undefined) {
    liveMetadataCache.navigation = reconcileNavigationCapabilitiesFromReadRegistry(
      liveMetadataCache.navigation,
      value,
    );
  }
}

export function getNavigation(): unknown {
  if (liveMetadataCache.navigation !== undefined) return liveMetadataCache.navigation;
  if (shouldFailClosedLiveMetadata()) return { groups: [] };
  primeLiveMetadata('navigation', loadLiveNavigation, setLiveNavigationCache);
  return seed.navigation ?? { groups: [] };
}
export function getReadRegistry(): unknown {
  if (liveMetadataCache.readRegistry !== undefined) return liveMetadataCache.readRegistry;
  if (shouldFailClosedLiveMetadata()) return {};
  primeLiveMetadata('read_registry', loadLiveReadRegistry, setLiveReadRegistryCache);
  return seed.ui_read_registry ?? {};
}
export function getCommandRegistry(): unknown {
  if (liveMetadataCache.commandRegistry !== undefined) return liveMetadataCache.commandRegistry;
  if (shouldFailClosedLiveMetadata()) return [];
  primeLiveMetadata('command_registry', loadLiveCommandRegistry, (value) => {
    liveMetadataCache.commandRegistry = value;
  });
  return seed.ui_command_registry ?? [];
}
export function getSettingsCategories(): unknown {
  if (liveMetadataCache.settingsCategories !== undefined) return liveMetadataCache.settingsCategories;
  if (shouldFailClosedLiveMetadata()) return [];
  primeLiveMetadata('settings_categories', loadLiveSettingsCategories, (value) => {
    liveMetadataCache.settingsCategories = value;
  });
  return seed.settings_category_registry ?? [];
}
export function getLookups(category: string): LookupOptionRow[] {
  const seedRows = (seed.lookups?.[category] ?? []) as LookupOptionRow[];
  const liveRows = liveMetadataCache.lookups[category];
  if (liveRows && liveRows.length > 0) return liveRows;
  if (shouldFailClosedLiveMetadata()) return [];
  primeLiveMetadata(`lookup:${category}`, () => loadLiveLookupRows(category), (value) => {
    liveMetadataCache.lookups[category] = value;
  });
  if (hasConsoleLiveBackend()) return SEED_MODE_ENABLED ? seedRows : [];
  return seedRows;
}
export async function getLookupsLive(category: string): Promise<LookupOptionRow[]> {
  if (shouldFailClosedLiveMetadata()) return [];
  const rows = (await loadLiveLookupRows(category)) ?? [];
  liveMetadataCache.lookups[category] = rows;
  return rows;
}
export function lookupRow(category: string, value: string): LookupOptionRow | null {
  const normalized = String(value ?? '');
  if (!normalized) return null;
  return getLookups(category).find((row) => row.value === normalized) ?? null;
}
function lookupBundledRow(category: string, value: string): LookupOptionRow | null {
  const normalized = String(value ?? '');
  if (!normalized) return null;
  const rows = (seed.lookups?.[category] ?? []) as LookupOptionRow[];
  return rows.find((row) => row.value === normalized) ?? null;
}
export function lookupCommandContractRow(category: string, value: string): LookupOptionRow | null {
  const normalized = String(value ?? '');
  if (!normalized) return null;
  const liveRow = liveMetadataCache.lookups[category]?.find((row) => row.value === normalized) ?? null;
  if (liveRow) return liveRow;
  if (hasConsoleLiveBackend()) return null;
  return lookupBundledRow(category, normalized);
}
export function getDevRoles(): Array<{ id: string; name?: string; capabilities: string[] | 'all' }> {
  return (seed.dev_roles as Array<{ id: string; name?: string; capabilities: string[] | 'all' }> | undefined) ?? [];
}

// ----------- Generic registry-driven reads (mirror ui_list_resource_v1, ui_get_resource_v1) -----------
type ResourceMap = Record<string, ResourceRow[]>;

// Flatten the seed.workflow_run_steps map ({ wfr_id: [...steps] }) into a single
// list with `workflow_run_id` populated on each row, matching the shape returned by
// `ui_list_resource_v1('workflow_run_steps', { filter: { workflow_run_id }})` against
// `public.workflow_run_steps`.
function _flattenWorkflowRunSteps(): ResourceRow[] {
  const map = (seed as Record<string, unknown>).workflow_run_steps as Record<string, unknown[]> | undefined;
  if (!map) return [];
  const out: ResourceRow[] = [];
  for (const [runId, steps] of Object.entries(map)) {
    if (!Array.isArray(steps)) continue;
    steps.forEach((s, i) => {
      const r = (s ?? {}) as Record<string, unknown>;
      out.push({ ...r, workflow_run_id: runId, ordinal: i });
    });
  }
  return out;
}

// W22 — Project the existing seed-raw/workflows.js `workflow_runs` entries
// (joined with workflow_templates) into the canonical
// `v_workflow_run_directory` view shape
// (supabase/migrations/202604302100_v_workflow_run_directory.sql).
//
// Closes the W10-6 deferred RENAME cascade by exposing both canonical
// SSOT columns (`workflow_status`, `entry_point`, `failure_reason`,
// `workflow_template_id`) AND the legacy display aliases (`status`,
// `triggered_by`, `error`, `template_id`, `run_id`) on the same view.
// FE row interface stays stable across cutover; production swap is a
// single getSupabaseClient() branch flip in
// ui_list_resource_v1('workflow_run_directory').
//
// In live mode this projection is unused — the live branch reads
// directly from `v_workflow_run_directory`.
function _projectWorkflowRunDirectory(): ResourceRow[] {
  const runs = ((seed as Record<string, unknown>).workflow_runs ?? []) as Array<{
    id: string;
    run_id?: string;
    template_id?: string;
    workflow_template_id?: string;
    template_name?: string;
    status?: string;
    workflow_status?: string;
    started_at?: string | null;
    completed_at?: string | null;
    duration_ms?: number | null;
    correlation_id?: string | null;
    triggered_by?: string;
    entry_point?: string;
    error?: string;
    failure_reason?: string;
    retry_count?: number;
    max_retries?: number;
    context?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    last_error?: Record<string, unknown> | null;
    current_step_id?: string | null;
    workflow_template_version?: number;
    created_at?: string;
    updated_at?: string;
  }>;
  const templates = ((seed as Record<string, unknown>).workflow_templates ?? []) as Array<{
    id: string;
    name?: string;
    version?: string | number;
  }>;
  const templateById = new Map<string, (typeof templates)[number]>();
  for (const t of templates) templateById.set(t.id, t);

  return runs.map((r) => {
    const canonicalTemplateId = r.workflow_template_id ?? r.template_id ?? null;
    const canonicalStatus = r.workflow_status ?? r.status ?? null;
    const canonicalEntry = r.entry_point ?? r.triggered_by ?? null;
    const canonicalFailure = r.failure_reason ?? r.error ?? null;
    const tpl = canonicalTemplateId ? templateById.get(canonicalTemplateId) : undefined;
    const startedMs = r.started_at ? Date.parse(r.started_at) : NaN;
    const completedMs = r.completed_at ? Date.parse(r.completed_at) : NaN;
    const derivedDuration =
      Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
        ? completedMs - startedMs
        : null;
    return {
      id: r.id,
      // FE display alias (canonical SSOT remains workflow_runs.id).
      run_id: r.run_id ?? null,
      workflow_template_id: canonicalTemplateId,
      // legacy alias for the FE rename target.
      template_id: canonicalTemplateId,
      template_name: r.template_name ?? tpl?.name ?? null,
      template_version: tpl?.version ?? null,
      workflow_status: canonicalStatus,
      // legacy alias for the FE rename target.
      status: canonicalStatus,
      entry_point: canonicalEntry,
      // legacy alias for the FE rename target.
      triggered_by: canonicalEntry,
      failure_reason: canonicalFailure,
      // legacy alias for the FE rename target.
      error: canonicalFailure,
      started_at: r.started_at ?? null,
      completed_at: r.completed_at ?? null,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
      duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : derivedDuration,
      correlation_id: r.correlation_id ?? null,
      retry_count: typeof r.retry_count === 'number' ? r.retry_count : 0,
      max_retries: r.max_retries ?? null,
      context: r.context ?? null,
      metadata: r.metadata ?? null,
      last_error: r.last_error ?? null,
      current_step_id: r.current_step_id ?? null,
      workflow_template_version: r.workflow_template_version ?? null,
    } as ResourceRow;
  });
}

// W22 — Project the existing seed-raw/workflows.js `workflow_templates`
// entries (joined with workflow_template_steps + workflow_runs +
// workflow_binding_dispatches) into the canonical
// `v_workflow_template_directory` view shape
// (supabase/migrations/202604302110_v_workflow_template_directory.sql).
//
// Closes the W10-6 cascade items (`template_id` display alias +
// `step_count` / `active_run_count` / `total_run_count` /
// `last_run_at` / `last_run_status` / `binding_count` /
// `is_published`) without inventing FE-only fields. FE row interface
// keeps the canonical columns AND legacy display aliases; production
// cutover is a single getSupabaseClient() branch flip in
// ui_list_resource_v1('workflow_template_directory').
function _projectWorkflowTemplateDirectory(): ResourceRow[] {
  const templates = ((seed as Record<string, unknown>).workflow_templates ?? []) as Array<{
    id: string;
    template_id?: string;
    name?: string;
    description?: string;
    version?: string | number;
    status?: string;
    scope_type?: string;
    scope_id?: string | null;
    created_by?: string;
    created_at?: string;
    published_at?: string | null;
    retired_at?: string | null;
    notes?: string;
    steps_checksum?: string;
    steps?: unknown[];
  }>;
  const runs = ((seed as Record<string, unknown>).workflow_runs ?? []) as Array<{
    template_id?: string;
    workflow_template_id?: string;
    status?: string;
    workflow_status?: string;
    created_at?: string;
  }>;
  const dispatches = ((seed as Record<string, unknown>).workflow_binding_dispatches ?? []) as Array<{
    workflow_template_id?: string;
  }>;

  const ACTIVE_RUN_STATES = new Set(['pending', 'in_progress', 'running', 'queued']);
  const stepsByTemplate = new Map<string, number>();
  for (const t of templates) {
    const steps = Array.isArray(t.steps) ? t.steps.length : 0;
    stepsByTemplate.set(t.id, steps);
  }
  const activeRunsByTemplate = new Map<string, number>();
  const totalRunsByTemplate = new Map<string, number>();
  const lastRunAtByTemplate = new Map<string, string>();
  const lastRunStatusByTemplate = new Map<string, string>();
  for (const r of runs) {
    const tplId = r.workflow_template_id ?? r.template_id;
    if (!tplId) continue;
    const status = r.workflow_status ?? r.status ?? '';
    totalRunsByTemplate.set(tplId, (totalRunsByTemplate.get(tplId) ?? 0) + 1);
    if (ACTIVE_RUN_STATES.has(status)) {
      activeRunsByTemplate.set(tplId, (activeRunsByTemplate.get(tplId) ?? 0) + 1);
    }
    const ca = r.created_at;
    if (ca) {
      const prior = lastRunAtByTemplate.get(tplId);
      if (!prior || ca > prior) {
        lastRunAtByTemplate.set(tplId, ca);
        lastRunStatusByTemplate.set(tplId, status);
      }
    }
  }
  const bindingCountByTemplate = new Map<string, number>();
  for (const d of dispatches) {
    if (!d.workflow_template_id) continue;
    bindingCountByTemplate.set(
      d.workflow_template_id,
      (bindingCountByTemplate.get(d.workflow_template_id) ?? 0) + 1,
    );
  }

  return templates.map((t) => {
    const isPublished =
      t.status === 'active' && t.published_at != null && String(t.published_at).length > 0;
    return {
      id: t.id,
      workflow_template_id: t.id,
      // legacy display alias preserved (carried by seed; live view computes
      // from name + version slug).
      template_id: t.template_id ?? null,
      name: t.name ?? null,
      description: t.description ?? null,
      version: t.version ?? null,
      status: t.status ?? null,
      scope_type: t.scope_type ?? null,
      scope_id: t.scope_id ?? null,
      created_by: t.created_by ?? null,
      created_at: t.created_at ?? null,
      published_at: t.published_at ?? null,
      retired_at: t.retired_at ?? null,
      notes: t.notes ?? null,
      steps_checksum: t.steps_checksum ?? null,
      step_count: stepsByTemplate.get(t.id) ?? 0,
      active_run_count: activeRunsByTemplate.get(t.id) ?? 0,
      total_run_count: totalRunsByTemplate.get(t.id) ?? 0,
      last_run_at: lastRunAtByTemplate.get(t.id) ?? null,
      last_run_status: lastRunStatusByTemplate.get(t.id) ?? null,
      binding_count: bindingCountByTemplate.get(t.id) ?? 0,
      is_published: isPublished,
    } as ResourceRow;
  });
}

// W22 — Project the existing seed-raw/workflows.js `workflow_bindings`
// entries (mapped to canonical workflow_binding_registry shape via the
// `webhook.${event}.default` binding_key composition) into the canonical
// `v_workflow_binding_directory` view shape
// (supabase/migrations/202604302120_v_workflow_binding_directory.sql).
//
// The seed-mode FE binding shape (id/event/template_id/condition/priority)
// is a legacy projection. This helper exposes BOTH the legacy shape AND
// the canonical shape (binding_key + dispatch counters) so the FE row
// interface can collapse to canonical column names + projection columns
// at cutover. Production swap reads directly from
// `v_workflow_binding_directory`.
function _projectWorkflowBindingDirectory(): ResourceRow[] {
  const bindings = ((seed as Record<string, unknown>).workflow_bindings ?? []) as Array<{
    id: string;
    event?: string;
    template_id?: string;
    workflow_template_id?: string;
    stage_key?: string;
    condition?: Record<string, unknown> | null;
    priority?: number;
    status?: string;
  }>;
  const dispatches = ((seed as Record<string, unknown>).workflow_binding_dispatches ?? []) as Array<{
    binding_key?: string;
    stage_key?: string;
    workflow_template_id?: string;
    workflow_run_id?: string;
    outcome?: string;
    created_at?: string;
  }>;
  const templates = ((seed as Record<string, unknown>).workflow_templates ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const templateNameById = new Map<string, string>();
  for (const t of templates) {
    if (t.name) templateNameById.set(t.id, t.name);
  }

  // Group dispatches by binding_key for counter projections.
  const dispatchesByBindingKey = new Map<string, typeof dispatches>();
  for (const d of dispatches) {
    if (!d.binding_key) continue;
    const arr = dispatchesByBindingKey.get(d.binding_key) ?? [];
    arr.push(d);
    dispatchesByBindingKey.set(d.binding_key, arr);
  }

  return bindings.map((b) => {
    const stageKey = b.stage_key ?? 'default';
    // Canonical binding_key composition: `${event}.${stage_key}`
    const bindingKey = b.event ? `${b.event}.${stageKey}` : b.id;
    const templateId = b.workflow_template_id ?? b.template_id ?? null;
    const dispatchList = dispatchesByBindingKey.get(bindingKey) ?? [];
    const dispatchCount = dispatchList.length;
    const completedCount = dispatchList.filter((d) => d.outcome === 'completed').length;
    const failedCount = dispatchList.filter((d) => d.outcome === 'failed').length;
    const waitingCount = dispatchList.filter((d) => d.outcome === 'waiting').length;
    const startedCount = dispatchList.filter((d) => d.outcome === 'started').length;
    // Most-recent dispatch (by created_at) drives the last_dispatch_* projections.
    const sorted = [...dispatchList].sort((a, b2) => {
      const aT = a.created_at ?? '';
      const bT = b2.created_at ?? '';
      return aT < bT ? 1 : aT > bT ? -1 : 0;
    });
    const last = sorted[0];
    const defaultTemplateId = last?.workflow_template_id ?? templateId;
    const isActive = (b.status ?? 'workflow_configurable') === 'workflow_configurable';

    return {
      // Canonical SSOT.
      binding_key: bindingKey,
      // FE alias (legacy seed key).
      id: bindingKey,
      // Carry the legacy seed columns alongside canonical projections so the
      // existing studio surface keeps round-tripping during the cutover.
      label: b.event ?? bindingKey,
      description: null,
      resource_type: null,
      actor_surface: 'edge_function',
      entrypoint_type: 'edge',
      current_execution_kind: 'workflow_native',
      configurability_status: b.status ?? 'workflow_configurable',
      owner: 'workflows',
      migration_phase: 'phase_3',
      is_business_affecting: true,
      created_at: null,
      updated_at: null,
      stage_count: 1, // seed legacy shape carries one stage per binding ('default')
      dispatch_count: dispatchCount,
      last_dispatch_at: last?.created_at ?? null,
      last_dispatch_outcome: last?.outcome ?? null,
      default_workflow_template_id: defaultTemplateId,
      default_template_name: defaultTemplateId
        ? templateNameById.get(defaultTemplateId) ?? null
        : null,
      last_workflow_run_id: last?.workflow_run_id ?? null,
      completed_dispatch_count: completedCount,
      failed_dispatch_count: failedCount,
      waiting_dispatch_count: waitingCount,
      started_dispatch_count: startedCount,
      is_active: isActive,
    } as ResourceRow;
  });
}

// W11-1 / W8-4 — Project the existing marketplace.js `settlement_batches`
// seed entries into the canonical `v_settlement_batch_summary` view shape
// (supabase/migrations/202604301120_v_settlement_batch_summary.sql).
//
// The seed entries already carry the five derived fields inline
// (`expected_amount`, `collected_amount`, `remitted_amount`, `posted_at`,
// `variance_flag`); the projection just renames `scope` → `scope_type` to
// match the canonical column (the SQL view exposes `sb.scope_type`) and
// exposes the canonical primary-key shape so resource list / get callers
// have a stable id column.
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_settlement_batch_summary`. The seed
// projection keeps demo-mode parity with the live shape so module
// callsites stay stable.
function _projectSettlementBatchSummary(): ResourceRow[] {
  const batches = ((seed as Record<string, unknown>).settlement_batches ?? []) as Array<{
    id: string;
    organization_id?: string;
    kind?: string;
    scope?: string;
    scope_type?: string;
    branch_id?: string | null;
    client_id?: string | null;
    sender_id?: string | null;
    subject_type?: string | null;
    subject_id?: string | null;
    partner_id?: string | null;
    participant_id?: string | null;
    supplier_participant_profile_id?: string | null;
    status?: string;
    expected_amount?: number;
    collected_amount?: number;
    remitted_amount?: number;
    posted_at?: string | null;
    variance_flag?: boolean;
    window_start_at?: string;
    window_end_at?: string;
    created_at?: string;
    updated_at?: string;
  }>;
  return batches.map((b) => {
    const expected = typeof b.expected_amount === 'number' ? b.expected_amount : 0;
    const collected = typeof b.collected_amount === 'number' ? b.collected_amount : 0;
    const remitted = typeof b.remitted_amount === 'number' ? b.remitted_amount : 0;
    // Canonical view: variance_flag = ABS(expected - collected) > threshold.
    // In seed mode we accept either the explicit flag (legacy) or derive it
    // from the amount delta with default threshold 0 (matches the SQL view's
    // global_threshold fallback when no settlement_policy is seeded).
    const derivedVariance = Math.abs(expected - collected) > 0;
    return {
      id: b.id,
      organization_id: b.organization_id ?? null,
      kind: b.kind ?? null,
      scope_type: b.scope_type ?? b.scope ?? null,
      status: b.status ?? null,
      window_start_at: b.window_start_at ?? null,
      window_end_at: b.window_end_at ?? null,
      created_at: b.created_at ?? null,
      updated_at: b.updated_at ?? null,
      expected_amount: expected,
      collected_amount: collected,
      remitted_amount: remitted,
      posted_at: b.posted_at ?? null,
      variance_flag: typeof b.variance_flag === 'boolean' ? b.variance_flag : derivedVariance,
      branch_id: b.branch_id ?? null,
      client_id: b.client_id ?? null,
      sender_id: b.sender_id ?? null,
      subject_type: b.subject_type ?? null,
      subject_id: b.subject_id ?? null,
      partner_id: b.partner_id ?? null,
      participant_id: b.participant_id ?? null,
      supplier_participant_profile_id: b.supplier_participant_profile_id ?? null,
    } as ResourceRow;
  });
}

// CATALOG D3 close-out (W9-5). Derive a registry-shaped projection of
// public.lookup_definitions from the existing `seed.lookup_definitions` array.
// The seed array carries `category / owner_role / approval_policy / is_mutable
// / description`; we synthesize a deterministic `id` (`lkd_<category>`) so
// resource list / get callers have a stable primary key. Production swap is a
// single getSupabaseClient() branch in ui_list_resource_v1 (no module change).
//
// W14-5 additive-merge invariant — this projection runs at every
// `RESOURCE_DATA()` call (RESOURCE_DATA is a function, not a frozen object),
// so it sees the live `seed.lookup_definitions` array including any
// per-feature `Object.assign(...)` / `lookup_definitions.push(...)` extensions
// landed at module-init time. Do NOT memoize the projection at module scope:
// W13-4 reverted because a hoisted const captured the array before per-feature
// seed files (catalog-offerings.js, fleet-vehicles.js, network-marketplace.js,
// platform-flags.js, …) finished merging. Regression guard:
// `apps/console-v2/src/modules/catalog/__tests__/lookups.test.tsx` →
// "W14-5 additive-merge invariant".
function _lookupDefinitionsCatalog(): ResourceRow[] {
  const defs = ((seed as Record<string, unknown>).lookup_definitions ?? []) as Array<{
    category: string;
    owner_role?: string;
    approval_policy?: string;
    is_mutable?: boolean;
    description?: string;
  }>;
  return defs.map((d) => ({
    id: `lkd_${d.category}`,
    category: d.category,
    description: d.description ?? null,
    owner_role: d.owner_role ?? null,
    approval_policy: d.approval_policy ?? null,
    is_mutable: d.is_mutable ?? true,
  }));
}

// Derive a registry-shaped projection of public.lookup_values from the keyed
// `seed.lookups` map (`{ category: [{value,label,tone,rank,is_default}] }`).
// Each row is normalized to the canonical migration columns: lookup_definition_id
// (FK projection: `lkd_<category>`), value, label, sort_order, is_default,
// status, plus a metadata jsonb that carries the FE-derived `tone` so consumers
// of the canonical column shape (e.g. lookups module future swap to
// useResourceList) keep tone rendering on the original metadata seam.
//
// W14-5 additive-merge invariant — this projection re-reads
// `(seed as Record<…>).lookups` at every call (RESOURCE_DATA is a function,
// not a frozen object). Per-feature seed files mutate the same `lookups`
// object reference at module-init time via `Object.assign(lookups, { …new
// categories… })` (catalog-offerings.js → service_offering_status,
// fleet-vehicles.js → vehicle_status, network-marketplace.js →
// marketplace_offer_status / marketplace_award_status / marketplace_request_
// status, finance-billing.js → billing_*, platform-flags.js → flag_*,
// network-zones.js → zone_*, support.js → support_*, platform-alerts.js →
// alert_rule_*, identity-sessions.js → session_*, driver-applications.js →
// driver_application_*, network-branches.js → branch_capacity_*,
// insights-apigw.js → api_gateway_*). Because seed.js does `export *` from
// every per-feature module, all merges land before this function is first
// invoked.
//
// W13-4 reverted because the original audit overlooked that
// `Object.assign(lookups, …)` mutates the shared object reference but does NOT
// rebind any consumer-side const that captured the pre-merge snapshot. Keeping
// the read inside the projection function guarantees we always see the latest
// merged state. Regression guard:
// `apps/console-v2/src/modules/catalog/__tests__/lookups.test.tsx` →
// "W14-5 additive-merge invariant".
function _lookupValuesCatalog(): ResourceRow[] {
  const lookups = ((seed as Record<string, unknown>).lookups ?? {}) as Record<
    string,
    Array<{
      value: string;
      label: string;
      tone?: string;
      metadata?: Record<string, unknown>;
      rank?: number;
      sort_order?: number;
      is_default?: boolean;
      status?: string;
      effective_from?: string | null;
      effective_until?: string | null;
    }>
  >;
  const out: ResourceRow[] = [];
  for (const [category, values] of Object.entries(lookups)) {
    if (!Array.isArray(values)) continue;
    for (const v of values) {
      const sortOrder = v.sort_order ?? v.rank ?? null;
      out.push({
        id: `lkv_${category}_${v.value}`,
        lookup_definition_id: `lkd_${category}`,
        category,
        value: v.value,
        label: v.label,
        sort_order: sortOrder,
        is_default: v.is_default ?? false,
        status: v.status ?? 'active',
        effective_from: v.effective_from ?? null,
        effective_until: v.effective_until ?? null,
        metadata: {
          ...(v.metadata ?? {}),
          ...(v.tone ? { tone: v.tone } : {}),
        },
      });
    }
  }
  return out;
}

// W31 — Project the existing seed-raw/catalog-offerings.js `service_offerings`
// + `service_levels` entries (joined with branches/zones/organizations +
// subscriptions) into the canonical `v_service_offering_directory` view shape
// (supabase/migrations/202604302900_v_service_offering_directory.sql).
//
// Closes the CATALOG paired-projection seam:
//   - tenant_label (organizations.name via service_levels.organization_id)
//   - level_key/level_name/level_is_active (service_levels join)
//   - branch_name (branches.name)
//   - zone_label (zones.name; NULL for branch-wide offerings)
//   - display_name/display_slug/effective_status (metadata.display.*)
//   - base_price/currency/max_weight_kg (canonical metadata jsonb)
//   - active_subscription_count (subscriptions filtered by metadata.
//     service_offering_id pointer per W17-1)
//   - is_active_window/is_archived/is_draft (status flags)
//   - age_seconds/age_hours/last_updated_at (temporal projections)
//
// SSOT preserved: the underlying public.service_offerings / service_levels
// remain authoritative; this projection seam derives display + counter
// fields so the FE renders without ad-hoc client-side joins. Production swap:
// a single getSupabaseClient() branch in ui_list_resource_v1 returns the
// canonical view rows; module call sites stay stable because the registry
// resolves `service_offering_directory` to `v_service_offering_directory`.
function _projectServiceOfferingDirectory(): ResourceRow[] {
  const offerings = ((seed as Record<string, unknown>).service_offerings ?? []) as Array<{
    id: string;
    service_level_id?: string;
    branch_id?: string;
    zone_id?: string | null;
    effective_from?: string;
    effective_to?: string | null;
    priority?: number;
    is_active?: boolean;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
  }>;
  const levels = ((seed as Record<string, unknown>).service_levels ?? []) as Array<{
    id: string;
    organization_id?: string;
    key?: string;
    name?: string;
    is_active?: boolean;
  }>;
  const branches = ((seed as Record<string, unknown>).branches ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const zones = ((seed as Record<string, unknown>).network_zones ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const orgs = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const subscriptions = ((seed as Record<string, unknown>).subscriptions ?? []) as Array<{
    status?: string;
    metadata?: Record<string, unknown>;
  }>;

  const levelById = new Map<string, (typeof levels)[number]>();
  for (const l of levels) levelById.set(l.id, l);
  const branchById = new Map<string, (typeof branches)[number]>();
  for (const b of branches) branchById.set(b.id, b);
  const zoneById = new Map<string, (typeof zones)[number]>();
  for (const z of zones) zoneById.set(z.id, z);
  const orgById = new Map<string, (typeof orgs)[number]>();
  for (const o of orgs) orgById.set(o.id, o);

  // Pre-compute active subscription counts grouped by service_offering_id (W17-1).
  const activeSubsByOffering = new Map<string, number>();
  for (const s of subscriptions) {
    const offId = (s.metadata?.['service_offering_id'] ?? '') as string;
    if (!offId || s.status !== 'active') continue;
    activeSubsByOffering.set(offId, (activeSubsByOffering.get(offId) ?? 0) + 1);
  }

  const nowMs = Date.now();
  return offerings.map((o) => {
    const md = (o.metadata ?? {}) as Record<string, unknown>;
    const display = (md.display ?? {}) as Record<string, unknown>;
    const displayName = typeof display.name === 'string' ? (display.name as string) : null;
    const displaySlug = typeof display.slug === 'string' ? (display.slug as string) : null;
    const displayStatus =
      typeof display.status === 'string' ? (display.status as string) : null;
    const isActive = o.is_active ?? false;
    const effectiveStatus = displayStatus ?? (isActive ? 'active' : 'archived');
    const basePrice = typeof md.base_price === 'number' ? (md.base_price as number) : null;
    const currency = typeof md.currency === 'string' ? (md.currency as string) : null;
    const maxWeight =
      typeof md.max_weight_kg === 'number' ? (md.max_weight_kg as number) : null;
    const level = o.service_level_id ? levelById.get(o.service_level_id) : undefined;
    const org = level?.organization_id ? orgById.get(level.organization_id) : undefined;
    const branch = o.branch_id ? branchById.get(o.branch_id) : undefined;
    const zone = o.zone_id ? zoneById.get(o.zone_id) : undefined;
    const effectiveFromMs = o.effective_from ? Date.parse(o.effective_from) : 0;
    const effectiveToMs = o.effective_to ? Date.parse(o.effective_to) : null;
    const isActiveWindow =
      isActive
      && (Number.isFinite(effectiveFromMs) ? nowMs >= effectiveFromMs : true)
      && (effectiveToMs == null || (Number.isFinite(effectiveToMs) && nowMs < effectiveToMs));
    const createdAtMs = o.created_at ? Date.parse(o.created_at) : nowMs;
    const ageSeconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
    return {
      id: o.id,
      service_level_id: o.service_level_id ?? null,
      branch_id: o.branch_id ?? null,
      zone_id: o.zone_id ?? null,
      effective_from: o.effective_from ?? null,
      effective_to: o.effective_to ?? null,
      priority: o.priority ?? 0,
      is_active: isActive,
      metadata: md,
      created_at: o.created_at ?? null,
      updated_at: o.updated_at ?? null,
      organization_id: level?.organization_id ?? null,
      level_key: level?.key ?? null,
      level_name: level?.name ?? null,
      level_is_active: level?.is_active ?? null,
      tenant_label: org?.name ?? null,
      branch_name: branch?.name ?? null,
      zone_label: zone?.name ?? null,
      display_name: displayName,
      display_slug: displaySlug,
      effective_status: effectiveStatus,
      base_price: basePrice,
      currency,
      max_weight_kg: maxWeight,
      active_subscription_count: activeSubsByOffering.get(o.id) ?? 0,
      is_active_window: isActiveWindow,
      is_archived: effectiveStatus === 'archived',
      is_draft: effectiveStatus === 'draft',
      age_seconds: ageSeconds,
      age_hours: Math.floor(ageSeconds / 3600),
      last_updated_at: o.updated_at ?? null,
    } as ResourceRow;
  });
}

// W31 — Project the existing seed-raw/catalog-offerings.js `service_levels`
// entries (joined with organizations + service_offerings + subscriptions)
// into the canonical `v_service_level_directory` view shape
// (supabase/migrations/202604302910_v_service_level_directory.sql).
function _projectServiceLevelDirectory(): ResourceRow[] {
  const levels = ((seed as Record<string, unknown>).service_levels ?? []) as Array<{
    id: string;
    organization_id?: string;
    key?: string;
    name?: string;
    description?: string;
    is_active?: boolean;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
  }>;
  const offerings = ((seed as Record<string, unknown>).service_offerings ?? []) as Array<{
    service_level_id?: string;
    is_active?: boolean;
  }>;
  const subscriptions = ((seed as Record<string, unknown>).subscriptions ?? []) as Array<{
    organization_id?: string;
    plan_key?: string;
    status?: string;
  }>;
  const orgs = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const orgById = new Map<string, (typeof orgs)[number]>();
  for (const o of orgs) orgById.set(o.id, o);

  // Pre-compute offering counts per service_level_id.
  const offCountByLevel = new Map<string, number>();
  const activeOffByLevel = new Map<string, number>();
  for (const o of offerings) {
    if (!o.service_level_id) continue;
    offCountByLevel.set(o.service_level_id, (offCountByLevel.get(o.service_level_id) ?? 0) + 1);
    if (o.is_active) {
      activeOffByLevel.set(
        o.service_level_id,
        (activeOffByLevel.get(o.service_level_id) ?? 0) + 1,
      );
    }
  }

  // Pre-compute active subscription counts per (organization_id, plan_key).
  const activeSubsByOrgPlan = new Map<string, number>();
  for (const s of subscriptions) {
    if (!s.organization_id || !s.plan_key || s.status !== 'active') continue;
    const key = `${s.organization_id}::${s.plan_key}`;
    activeSubsByOrgPlan.set(key, (activeSubsByOrgPlan.get(key) ?? 0) + 1);
  }

  const nowMs = Date.now();
  return levels.map((l) => {
    const md = (l.metadata ?? {}) as Record<string, unknown>;
    const tier = typeof md.tier === 'string' ? (md.tier as string) : null;
    const priorityRank = typeof md.priority_rank === 'number' ? (md.priority_rank as number) : null;
    const slaMinutes = typeof md.sla_minutes === 'number' ? (md.sla_minutes as number) : null;
    const slaLabel = typeof md.sla_label === 'string' ? (md.sla_label as string) : null;
    const colorToken = typeof md.color_token === 'string' ? (md.color_token as string) : null;
    const org = l.organization_id ? orgById.get(l.organization_id) : undefined;
    const subKey = l.organization_id && l.key ? `${l.organization_id}::${l.key}` : '';
    const createdAtMs = l.created_at ? Date.parse(l.created_at) : nowMs;
    const ageSeconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
    return {
      id: l.id,
      organization_id: l.organization_id ?? null,
      key: l.key ?? null,
      name: l.name ?? null,
      description: l.description ?? null,
      is_active: l.is_active ?? false,
      metadata: md,
      created_at: l.created_at ?? null,
      updated_at: l.updated_at ?? null,
      tenant_label: org?.name ?? null,
      tier,
      priority_rank: priorityRank,
      sla_minutes: slaMinutes,
      sla_label: slaLabel,
      color_token: colorToken,
      offering_count: offCountByLevel.get(l.id) ?? 0,
      active_offering_count: activeOffByLevel.get(l.id) ?? 0,
      active_subscription_count: subKey ? (activeSubsByOrgPlan.get(subKey) ?? 0) : 0,
      age_seconds: ageSeconds,
      age_hours: Math.floor(ageSeconds / 3600),
      last_updated_at: l.updated_at ?? null,
    } as ResourceRow;
  });
}

// W31 — Project the existing seed-raw/lookups.js + catalog-offerings.js
// `lookup_definitions` + `lookup_values` entries into the canonical
// `v_lookup_definition_directory` view shape
// (supabase/migrations/202604302920_v_lookup_definition_directory.sql).
//
// Reuses the same projection helpers (_lookupDefinitionsCatalog +
// _lookupValuesCatalog) so the seed-mode and live-mode reads stay aligned;
// the additional aggregation derives the per-definition counters
// (value_count + active/draft/archived/retired splits) and default-value
// resolution (first is_default=TRUE row by sort_order asc).
function _projectLookupDefinitionDirectory(): ResourceRow[] {
  const defs = _lookupDefinitionsCatalog();
  const values = _lookupValuesCatalog();
  const valuesByDef = new Map<string, ResourceRow[]>();
  for (const v of values) {
    const defId = (v.lookup_definition_id ?? '') as string;
    if (!defId) continue;
    const arr = valuesByDef.get(defId) ?? [];
    arr.push(v);
    valuesByDef.set(defId, arr);
  }
  const nowMs = Date.now();
  return defs.map((d) => {
    const list = valuesByDef.get(d.id as string) ?? [];
    let active = 0;
    let draft = 0;
    let archived = 0;
    let retired = 0;
    let lastValueUpdatedAt: string | null = null;
    let defaultRow: ResourceRow | null = null;
    let defaultRowSort: number | null = null;
    for (const v of list) {
      const status = (v.status ?? '') as string;
      if (status === 'active') active += 1;
      else if (status === 'draft') draft += 1;
      else if (status === 'archived') archived += 1;
      // Treat any retired_at !== null as retired
      if (v.retired_at) retired += 1;
      const upd = (v.updated_at ?? null) as string | null;
      if (upd && (!lastValueUpdatedAt || upd > lastValueUpdatedAt)) {
        lastValueUpdatedAt = upd;
      }
      const isDefault = v.is_default === true;
      if (isDefault) {
        const sortOrder = typeof v.sort_order === 'number' ? (v.sort_order as number) : null;
        if (
          defaultRow == null
          || (sortOrder != null && (defaultRowSort == null || sortOrder < defaultRowSort))
        ) {
          defaultRow = v;
          defaultRowSort = sortOrder;
        }
      }
    }
    const created = (d.created_at ?? null) as string | null;
    const createdAtMs = created ? Date.parse(created) : nowMs;
    const ageSeconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
    return {
      id: d.id,
      category: d.category,
      description: d.description ?? null,
      owner_role: d.owner_role ?? null,
      approval_policy: d.approval_policy ?? null,
      is_mutable: d.is_mutable,
      created_by: d.created_by ?? null,
      created_at: d.created_at ?? null,
      updated_at: d.updated_at ?? null,
      value_count: list.length,
      active_value_count: active,
      draft_value_count: draft,
      archived_value_count: archived,
      retired_value_count: retired,
      default_value: defaultRow ? (defaultRow.value as string) : null,
      default_value_label: defaultRow ? (defaultRow.label as string) : null,
      has_default: defaultRow != null,
      last_value_updated_at: lastValueUpdatedAt,
      age_seconds: ageSeconds,
      age_hours: Math.floor(ageSeconds / 3600),
      last_updated_at: (d.updated_at ?? null) as string | null,
    } as ResourceRow;
  });
}

// Derive the operation_templates catalog from workflow template steps so the
// "Operations" palette tab reflects the live op surface area without inventing data.
// Mirrors `SELECT id, operation_name, kind, category, timeout_seconds, description
// FROM public.operation_templates ORDER BY operation_name`.
function _operationTemplatesCatalog(): ResourceRow[] {
  const seen = new Set<string>();
  const rows: ResourceRow[] = [];
  const tpls = (seed.workflow_templates as Array<Record<string, unknown>> | undefined) ?? [];
  for (const t of tpls) {
    const steps = (t as { steps?: Array<Record<string, unknown>> }).steps ?? [];
    for (const s of steps) {
      const op = (s.op as string | undefined) ?? '';
      if (!op || seen.has(op)) continue;
      seen.add(op);
      const kindRaw = (s.kind as string | undefined) ?? 'action';
      const family = op.split('.')[0] ?? 'misc';
      const description =
        kindRaw === 'trigger'
          ? `Inbound entrypoint for ${op}`
          : kindRaw === 'transform'
            ? `Mapping/transform · ${op}`
            : kindRaw === 'guard'
              ? `Guard · ${op}`
              : kindRaw === 'manual'
                ? `Manual review · ${op}`
                : `Action · ${op}`;
      rows.push({
        id: `op_${family}_${op.replace(/\W+/g, '_')}`,
        operation_name: op,
        kind: kindRaw,
        category: family,
        timeout_seconds: 30,
        description,
      });
    }
  }
  return rows;
}

// W11-4 — Project the existing fleet-drivers.js `driver_profiles` seed
// entries into the canonical `driver_profile_summary_v1` view shape
// (supabase/migrations/202604301430_driver_profile_summary_v1.sql).
//
// The seed entries already carry the rich derived fields inline
// (name/initials/license_*/current_*/hours_of_service_state/compliance_score/
// phone/emergency_*/deliveries_*/on_time_pct/customer_rating); the projection
// just exposes them under the canonical projection-view key so the FE swap
// from seed → live is a single registry relation flip.
//
// In live mode (getSupabaseClient() set) this projection is unused — the live
// branch reads directly from `driver_profile_summary_v1`. The seed projection
// keeps demo-mode parity with the live shape so module call sites stay stable.
function _projectDriverProfileSummary(): ResourceRow[] {
  const rows = ((seed as Record<string, unknown>).driver_profiles ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...r } as ResourceRow));
}

// W19-5 — Virtual projection that re-shapes canonical `driver_profiles` rows
// (the SSOT registered under the `driver_profiles` resource) into the picker
// shape consumed by dispatch.tsx, pickups.tsx, and fleet/vehicles.tsx
// (`{ id: users.id, name, vehicle_id, skills }`). This eliminates the prior
// parallel `domain-routes.drivers` 6-row array — the picker now sources
// directly from the canonical 12-driver roster and cannot drift.
//
// Projection contract (single source of truth = `driver_profiles`):
//   • id           ← driver_profiles.user_id   (users.id; what the picker map keys on)
//   • name         ← driver_profiles.name      (mirrors users.full_name SSOT)
//   • vehicle_id   ← driver_profiles.current_vehicle_id (active assignment)
//   • skills       ← []                        (no canonical column on
//                                                driver_profiles; consumers
//                                                do not read this field — it
//                                                exists only to preserve
//                                                shape parity)
//
// Production swap path: the registry alias `drivers` resolves to this
// projection for seed mode; live mode would project the same shape from a
// `driver_profile_picker_v1` view (or an inline SELECT) — the FE call sites
// stay stable. See `__audit__/DECISIONS/REGISTRY-ALIASES.md` §4.
function _projectDriverPickers(): ResourceRow[] {
  const rows = ((seed as Record<string, unknown>).driver_profiles ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.user_id as string,
    name: r.name as string,
    vehicle_id: (r.current_vehicle_id ?? null) as string | null,
    skills: [] as string[],
  } as ResourceRow));
}

// W11-4 — Project the existing fleet-vehicles.js `vehicles` seed entries
// into the canonical `vehicles_with_state_v1` view shape
// (supabase/migrations/202604301440_vehicles_with_state_v1.sql).
//
// The seed entries carry plate/vin/type_id/type_name/current_driver_user_id/
// current_branch_id/status/fuel_level/odometer_km/last_telemetry_at inline.
// The projection surfaces canonical column names alongside the legacy aliases
// (plate_number alongside plate, vehicle_type_id alongside type_id) so the
// module call sites continue to render through the FE row interface during
// the W11-4 incremental rollout. Production cutover serves the canonical
// names from the SQL view directly.
function _projectVehiclesWithState(): ResourceRow[] {
  const rows = ((seed as Record<string, unknown>).vehicles ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...r,
    plate_number: r.plate_number ?? r.plate,
    vehicle_type_id: r.vehicle_type_id ?? r.type_id,
  } as ResourceRow));
}

// W29 — Project existing fleet-vehicles.js `vehicles` + `vehicle_assignments`
// + `vehicle_events` + `vehicle_maintenance_windows` + `branches` +
// `vehicle_types` seed entries into the canonical `v_vehicle_directory` view
// shape (supabase/migrations/202604302700_v_vehicle_directory.sql).
//
// Surfaces branch + vehicle_type label joins, active assignment resolution
// (current_driver_user_id / current_driver_label / assignment_age_seconds),
// telemetry aggregates (last_event_at / event_count_24h), maintenance
// counters (maintenance_window_count / active_maintenance_count /
// maintenance_due), and status booleans (is_oos / is_in_maintenance) so
// demo behavior stays in lock-step with the canonical view.
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_vehicle_directory`. The seed
// projection keeps demo-mode parity with the live shape so module call
// sites stay stable.
function _projectVehicleDirectory(): ResourceRow[] {
  const vehicles = ((seed as Record<string, unknown>).vehicles ?? []) as Array<Record<string, unknown>>;
  const types = ((seed as Record<string, unknown>).vehicle_types ?? []) as Array<Record<string, unknown>>;
  const branches = ((seed as Record<string, unknown>).hubs ?? []) as Array<Record<string, unknown>>;
  const assignments = ((seed as Record<string, unknown>).vehicle_assignments ?? []) as Array<Record<string, unknown>>;
  const events = ((seed as Record<string, unknown>).vehicle_events ?? []) as Array<Record<string, unknown>>;
  const maint = ((seed as Record<string, unknown>).vehicle_maintenance_windows ?? []) as Array<Record<string, unknown>>;
  const drivers = ((seed as Record<string, unknown>).driver_profiles ?? []) as Array<Record<string, unknown>>;

  const typeById = new Map<string, Record<string, unknown>>();
  for (const t of types) typeById.set(String(t.id), t);
  const branchById = new Map<string, Record<string, unknown>>();
  for (const b of branches) branchById.set(String(b.id), b);
  const driverNameByUser = new Map<string, string>();
  for (const d of drivers) {
    if (d.user_id) driverNameByUser.set(String(d.user_id), String(d.name ?? ''));
  }

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const sevenDays = 7 * oneDay;

  return vehicles.map((v) => {
    const vehicleId = String(v.id);
    const typeId = String(v.vehicle_type_id ?? v.type_id ?? '');
    const branchId = String(v.branch_id ?? v.current_branch_id ?? '');
    const t = typeId ? typeById.get(typeId) : undefined;
    const b = branchId ? branchById.get(branchId) : undefined;

    const myAssignments = assignments.filter((a) => String(a.vehicle_id) === vehicleId);
    const active = myAssignments.find(
      (a) => (a.status ?? 'active') === 'active' && (a.ended_at == null),
    );
    const driverUserId = active
      ? String(active.assigned_to_user_id ?? active.driver_user_id ?? '') || null
      : null;
    const driverLabel = driverUserId ? (driverNameByUser.get(driverUserId) ?? null) : null;
    const startedAt = active?.started_at ? String(active.started_at) : null;
    const assignmentAgeSeconds = startedAt
      ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))
      : null;

    const myEvents = events.filter((e) => String(e.vehicle_id) === vehicleId);
    const occurredTimes = myEvents
      .map((e) => (e.occurred_at ? new Date(String(e.occurred_at)).getTime() : NaN))
      .filter((ts) => !Number.isNaN(ts));
    const lastEventTs = occurredTimes.length > 0 ? Math.max(...occurredTimes) : null;
    const lastEventAt = lastEventTs ? new Date(lastEventTs).toISOString() : null;
    const eventCount24h = occurredTimes.filter((ts) => ts >= now - oneDay).length;

    const myMaint = maint.filter((m) => String(m.vehicle_id) === vehicleId);
    const maintCount = myMaint.length;
    const activeMaintCount = myMaint.filter((m) => {
      if ((m.status ?? 'scheduled') !== 'scheduled') return false;
      const start = m.window_start_at ?? m.planned_start;
      const end = m.window_end_at ?? m.planned_end;
      if (!start || !end) return false;
      const s = new Date(String(start)).getTime();
      const e = new Date(String(end)).getTime();
      return s <= now && e >= now;
    }).length;
    const maintenanceDue = myMaint.some((m) => {
      if ((m.status ?? 'scheduled') !== 'scheduled') return false;
      const start = m.window_start_at ?? m.planned_start;
      const end = m.window_end_at ?? m.planned_end;
      if (!start || !end) return false;
      const s = new Date(String(start)).getTime();
      const e = new Date(String(end)).getTime();
      return (s <= now && e >= now) || (s >= now && s <= now + sevenDays);
    });

    const branchLabel = b
      ? (b.code && b.name ? `${b.code} · ${b.name}` : (b.name ?? b.code ?? null))
      : null;

    return {
      ...v,
      plate_number: v.plate_number ?? v.plate,
      vehicle_type_id: typeId || null,
      branch_id: branchId || null,
      branch_label: branchLabel ?? null,
      vehicle_type_label: t?.name ?? null,
      vehicle_type_key: t?.key ?? t?.kind ?? null,
      current_driver_user_id: driverUserId,
      current_driver_label: driverLabel,
      current_branch_id: branchId || null,
      active_assignment_branch_id: active?.branch_id ?? null,
      active_assignment_started_at: startedAt,
      assignment_age_seconds: assignmentAgeSeconds,
      last_event_at: lastEventAt,
      event_count_24h: eventCount24h,
      maintenance_window_count: maintCount,
      active_maintenance_count: activeMaintCount,
      maintenance_due: maintenanceDue,
      // W35b — canonical OOS predicate matches `v_vehicle_directory.is_oos`
      // in `supabase/migrations/202604303000_v_vehicle_directory_status_canonicalize.sql`
      // and the canonical `vehicle_status` lookup value `'oos'` (rank 25) per
      // `supabase/migrations/202604280020_mark_vehicle_oos_v1.sql:20`.
      is_oos: v.status === 'oos',
      is_in_maintenance: v.status === 'in_maintenance' || activeMaintCount > 0,
    } as ResourceRow;
  });
}

// W29 — Project existing fleet-drivers.js `driver_profiles` + `driver_documents`
// + `driver_compliance_events` + `driver_hours_of_service` + active
// `vehicle_assignments` seed entries into the canonical `v_driver_directory`
// view shape (supabase/migrations/202604302710_v_driver_directory.sql).
//
// Surfaces user_full_name / vehicle_label / branch_label joins, document
// aggregates (document_count / expired_document_count /
// expiring_document_count / earliest_document_expiry), compliance
// aggregates, HOS counters + active segment resolution, and status
// booleans (is_active / is_suspended / has_expired_documents / tenure_seconds).
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_driver_directory`.
function _projectDriverDirectory(): ResourceRow[] {
  const drivers = ((seed as Record<string, unknown>).driver_profiles ?? []) as Array<Record<string, unknown>>;
  const documents = ((seed as Record<string, unknown>).driver_documents ?? []) as Array<Record<string, unknown>>;
  const events = ((seed as Record<string, unknown>).driver_compliance_events ?? []) as Array<Record<string, unknown>>;
  const hosRaw = ((seed as Record<string, unknown>).driver_hours_of_service ?? {}) as
    Record<string, { today?: Array<Record<string, unknown>>; week_total?: Record<string, number> }>;
  const assignments = ((seed as Record<string, unknown>).vehicle_assignments ?? []) as Array<Record<string, unknown>>;
  const vehicles = ((seed as Record<string, unknown>).vehicles ?? []) as Array<Record<string, unknown>>;
  const branches = ((seed as Record<string, unknown>).hubs ?? []) as Array<Record<string, unknown>>;

  const branchById = new Map<string, Record<string, unknown>>();
  for (const b of branches) branchById.set(String(b.id), b);
  const vehicleById = new Map<string, Record<string, unknown>>();
  for (const v of vehicles) vehicleById.set(String(v.id), v);

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const thirtyDays = 30 * oneDay;
  const todayMs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();

  return drivers.map((d) => {
    const userId = d.user_id ? String(d.user_id) : '';
    const driverId = String(d.id);

    // Documents indexed by user_id (canonical) — the seed uses driver_id
    // (legacy alias) but each row carries the same user_id reference via
    // the W13-3 additive alias path.
    const myDocs = documents.filter(
      (doc) => String(doc.driver_id ?? doc.user_id ?? '') === driverId
              || String(doc.user_id ?? '') === userId,
    );
    const docCount = myDocs.length;
    let expiredDocCount = 0;
    let expiringDocCount = 0;
    let earliestExpiry: number | null = null;
    for (const doc of myDocs) {
      if (!doc.expires_at) continue;
      const expMs = new Date(String(doc.expires_at)).getTime();
      if (Number.isNaN(expMs)) continue;
      if (expMs <= todayMs) expiredDocCount += 1;
      else if (expMs <= todayMs + thirtyDays) expiringDocCount += 1;
      if (earliestExpiry == null || expMs < earliestExpiry) earliestExpiry = expMs;
    }

    const myEvents = events.filter(
      (e) => String(e.driver_id ?? e.user_id ?? '') === driverId
            || String(e.user_id ?? '') === userId,
    );
    const eventCount = myEvents.length;
    let event24h = 0;
    let critical = 0;
    let lastEventTs: number | null = null;
    for (const e of myEvents) {
      const tsRaw = e.created_at ?? e.occurred_at;
      if (!tsRaw) continue;
      const ts = new Date(String(tsRaw)).getTime();
      if (Number.isNaN(ts)) continue;
      if (ts >= now - oneDay) event24h += 1;
      const sev = (e.payload as Record<string, unknown> | undefined)?.severity ?? e.severity;
      if (sev === 'critical') critical += 1;
      if (lastEventTs == null || ts > lastEventTs) lastEventTs = ts;
    }

    const hos = hosRaw[driverId];
    const todaySegments = hos?.today ?? [];
    const hosCount = todaySegments.length;
    const hosCount24h = todaySegments.length;
    const activeSegment = todaySegments.find((s) => !s.segment_end);
    const lastActiveAt = todaySegments.length > 0
      ? new Date().toISOString().slice(0, 10) + 'T00:00:00Z'
      : null;

    const active = assignments.find(
      (a) => (a.status ?? 'active') === 'active'
            && a.ended_at == null
            && String(a.assigned_to_user_id ?? a.driver_user_id ?? '') === userId,
    );
    const vehicleId = active
      ? String(active.vehicle_id ?? d.current_vehicle_id ?? '')
      : String(d.current_vehicle_id ?? '');
    const activeBranchId = active?.branch_id ?? active?.current_branch_id ?? null;
    const branchId = activeBranchId != null
      ? String(activeBranchId)
      : String(d.current_branch_id ?? '');
    const vehicle = vehicleId ? vehicleById.get(vehicleId) : undefined;
    const branch = branchId ? branchById.get(branchId) : undefined;
    const branchLabel = branch
      ? (branch.code && branch.name ? `${branch.code} · ${branch.name}` : (branch.name ?? branch.code ?? null))
      : null;

    const tenureSeconds = d.hired_at
      ? Math.max(0, Math.round((now - new Date(String(d.hired_at)).getTime()) / 1000))
      : null;

    return {
      ...d,
      user_full_name: d.name ?? null,
      user_email: d.email ?? null,
      current_vehicle_id: vehicleId || null,
      current_branch_id: branchId || null,
      active_assignment_started_at: active?.started_at ?? null,
      vehicle_plate: vehicle?.plate_number ?? vehicle?.plate ?? null,
      vehicle_label: vehicle?.plate_number ?? vehicle?.plate ?? null,
      branch_label: branchLabel,
      document_count: docCount,
      expired_document_count: expiredDocCount,
      expiring_document_count: expiringDocCount,
      earliest_document_expiry: earliestExpiry
        ? new Date(earliestExpiry).toISOString().slice(0, 10)
        : null,
      compliance_event_count: eventCount,
      compliance_event_count_24h: event24h,
      critical_compliance_count: critical,
      last_compliance_event_at: lastEventTs ? new Date(lastEventTs).toISOString() : null,
      hos_segment_count: hosCount,
      hos_segment_count_24h: hosCount24h,
      last_active_at: lastActiveAt,
      hos_active_segment_id: (activeSegment?.id ?? null) as string | null,
      hos_active_duty_status: (activeSegment?.type ?? activeSegment?.duty_status ?? null) as string | null,
      hos_active_segment_started_at: (activeSegment?.start_at ?? null) as string | null,
      is_active: d.status === 'active',
      is_suspended: d.status === 'suspended',
      is_inactive: d.status === 'inactive',
      has_expired_documents: expiredDocCount > 0,
      has_expiring_documents: expiringDocCount > 0,
      tenure_seconds: tenureSeconds,
    } as ResourceRow;
  });
}

// W29 — Project existing seed-raw/driver-applications.js `driver_applications`
// entries into the canonical `v_driver_application_directory` view shape
// (supabase/migrations/202604302720_v_driver_application_directory.sql).
//
// Filters to `requested_participant_type_key === 'freelancer_driver'` and
// surfaces reviewer_label, capabilities/documents counts, lifecycle
// booleans (is_pending / is_approved / is_rejected / is_withdrawn /
// is_terminal), age_seconds, decision_age_seconds, and sla_breach.
function _projectDriverApplicationDirectory(): ResourceRow[] {
  const apps = ((seed as Record<string, unknown>).driver_applications ?? []) as Array<Record<string, unknown>>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<Record<string, unknown>>;
  const userById = new Map<string, Record<string, unknown>>();
  for (const u of users) userById.set(String(u.id), u);

  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  return apps
    .filter((a) => {
      const k = a.requested_participant_type_key;
      // Default to freelancer_driver when key absent (the seed surface is
      // already scoped to the driver intake table per the FE module's
      // contract; the filter mirrors the canonical SQL view's WHERE).
      return k == null || k === 'freelancer_driver';
    })
    .map((a) => {
      const reviewerId = a.reviewed_by ? String(a.reviewed_by) : null;
      const reviewer = reviewerId ? userById.get(reviewerId) : undefined;
      const caps = Array.isArray(a.capabilities_requested)
        ? (a.capabilities_requested as unknown[])
        : [];
      const docs = Array.isArray(a.verification_documents)
        ? (a.verification_documents as Array<Record<string, unknown>>)
        : [];
      const submitted = docs.filter((d) => d.status === 'submitted').length;
      const missing = docs.filter((d) => d.status === 'missing').length;

      const createdMs = a.created_at ? new Date(String(a.created_at)).getTime() : null;
      const reviewedMs = a.reviewed_at ? new Date(String(a.reviewed_at)).getTime() : null;
      const ageSeconds = createdMs != null
        ? Math.max(0, Math.round((now - createdMs) / 1000))
        : null;
      const decisionAgeSeconds = reviewedMs != null
        ? Math.max(0, Math.round((now - reviewedMs) / 1000))
        : null;
      const slaBreach = a.status === 'pending'
        && createdMs != null
        && createdMs < now - sevenDays;

      return {
        ...a,
        requested_participant_type_key:
          a.requested_participant_type_key ?? 'freelancer_driver',
        reviewer_label: reviewer?.full_name ?? null,
        reviewer_email: reviewer?.email ?? null,
        capabilities_count: caps.length,
        verification_documents_count: docs.length,
        submitted_document_count: submitted,
        missing_document_count: missing,
        is_pending: a.status === 'pending',
        is_approved: a.status === 'approved',
        is_rejected: a.status === 'rejected',
        is_withdrawn: a.status === 'withdrawn',
        is_terminal: a.status === 'approved' || a.status === 'rejected' || a.status === 'withdrawn',
        age_seconds: ageSeconds,
        decision_age_seconds: decisionAgeSeconds,
        sla_breach: slaBreach,
      } as ResourceRow;
    });
}

// W29 — Project existing fleet-vehicles.js `vehicle_maintenance_windows`
// seed entries into the canonical `v_vehicle_maintenance_directory` view
// shape (supabase/migrations/202604302730_v_vehicle_maintenance_directory.sql).
//
// Surfaces vehicle_label / vehicle_type_label / scheduled_by_label joins,
// derived lifecycle booleans (is_scheduled / is_completed / is_cancelled /
// is_in_progress / is_overdue / is_terminal), and age/duration aggregates
// (age_seconds / duration_seconds / starts_in_seconds /
// completed_age_seconds / cancelled_age_seconds).
function _projectVehicleMaintenanceDirectory(): ResourceRow[] {
  const windows = ((seed as Record<string, unknown>).vehicle_maintenance_windows ?? []) as Array<Record<string, unknown>>;
  const vehicles = ((seed as Record<string, unknown>).vehicles ?? []) as Array<Record<string, unknown>>;
  const types = ((seed as Record<string, unknown>).vehicle_types ?? []) as Array<Record<string, unknown>>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<Record<string, unknown>>;

  const vehicleById = new Map<string, Record<string, unknown>>();
  for (const v of vehicles) vehicleById.set(String(v.id), v);
  const typeById = new Map<string, Record<string, unknown>>();
  for (const t of types) typeById.set(String(t.id), t);
  const userById = new Map<string, Record<string, unknown>>();
  for (const u of users) userById.set(String(u.id), u);

  const now = Date.now();

  return windows.map((m) => {
    const status = String(m.status ?? 'scheduled');
    const startRaw = m.window_start_at ?? m.planned_start;
    const endRaw = m.window_end_at ?? m.planned_end;
    const startMs = startRaw ? new Date(String(startRaw)).getTime() : null;
    const endMs = endRaw ? new Date(String(endRaw)).getTime() : null;
    const createdMs = m.created_at ? new Date(String(m.created_at)).getTime() : null;
    const completedMs = m.completed_at ? new Date(String(m.completed_at)).getTime() : null;
    const cancelledMs = m.cancelled_at ? new Date(String(m.cancelled_at)).getTime() : null;

    const vehicle = m.vehicle_id ? vehicleById.get(String(m.vehicle_id)) : undefined;
    const type = vehicle?.vehicle_type_id
      ? typeById.get(String(vehicle.vehicle_type_id))
      : (vehicle?.type_id ? typeById.get(String(vehicle.type_id)) : undefined);
    const scheduler = m.scheduled_by_user_id
      ? userById.get(String(m.scheduled_by_user_id))
      : undefined;

    const isInProgress = status === 'scheduled'
      && startMs != null && endMs != null
      && startMs <= now && endMs >= now;
    const isOverdue = status === 'scheduled'
      && endMs != null && endMs < now;

    return {
      ...m,
      window_start_at: startRaw ?? null,
      window_end_at: endRaw ?? null,
      reason: m.reason ?? m.scheduled_kind ?? null,
      status,
      vehicle_label: vehicle?.plate_number ?? vehicle?.plate ?? null,
      vehicle_plate: vehicle?.plate_number ?? vehicle?.plate ?? null,
      vehicle_type_label: type?.name ?? null,
      scheduled_by_label: scheduler?.full_name ?? null,
      scheduled_by_email: scheduler?.email ?? null,
      is_scheduled: status === 'scheduled',
      is_completed: status === 'completed',
      is_cancelled: status === 'cancelled',
      is_terminal: status === 'completed' || status === 'cancelled',
      is_in_progress: isInProgress,
      is_overdue: isOverdue,
      age_seconds: createdMs != null
        ? Math.max(0, Math.round((now - createdMs) / 1000))
        : null,
      duration_seconds: startMs != null && endMs != null
        ? Math.max(0, Math.round((endMs - startMs) / 1000))
        : null,
      starts_in_seconds: startMs != null && startMs > now
        ? Math.round((startMs - now) / 1000)
        : null,
      completed_age_seconds: completedMs != null
        ? Math.max(0, Math.round((now - completedMs) / 1000))
        : null,
      cancelled_age_seconds: cancelledMs != null
        ? Math.max(0, Math.round((now - cancelledMs) / 1000))
        : null,
    } as ResourceRow;
  });
}

// W30 — Project existing `kpi_definitions` + `kpi_rollups_daily` seed entries
// into the canonical `v_kpi_rollup_directory` view shape
// (supabase/migrations/202604302800_v_kpi_rollup_directory.sql).
//
// Surfaces resolved kpi_label / kpi_unit / group_label / format / tone
// (resolved from the definition jsonb), latest day / value_num / numerator /
// denominator, scope_label (derived from dimensions JSONB), age_seconds, and
// lifecycle booleans (is_active / is_fresh / is_stale / has_rollup).
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_kpi_rollup_directory`.
function _projectKpiRollupDirectory(): ResourceRow[] {
  const defs = ((seed as Record<string, unknown>).kpi_definitions ?? []) as Array<Record<string, unknown>>;
  const rolls = ((seed as Record<string, unknown>).kpi_rollups_daily ?? []) as Array<Record<string, unknown>>;
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Index latest rollup per (organization_id, kpi_key) — most recent day +
  // updated_at wins.
  const rollupByKey = new Map<string, Record<string, unknown>>();
  for (const r of rolls) {
    const key = `${String(r.organization_id ?? '')}::${String(r.kpi_key ?? '')}`;
    const prior = rollupByKey.get(key);
    if (!prior) {
      rollupByKey.set(key, r);
      continue;
    }
    const priorDay = new Date(String(prior.day ?? '')).getTime();
    const nextDay = new Date(String(r.day ?? '')).getTime();
    if (nextDay > priorDay) rollupByKey.set(key, r);
  }

  return defs.map((d) => {
    const orgId = String(d.organization_id ?? '');
    const kpiKey = String(d.key ?? '');
    const definition = (d.definition ?? {}) as Record<string, unknown>;
    const groupLabel = typeof definition.group === 'string' ? definition.group : null;
    const format = typeof definition.format === 'string' ? definition.format : null;
    const tone = typeof definition.tone === 'string' ? definition.tone : null;
    const toneThresholds = (definition.tone_thresholds ?? {}) as Record<string, unknown>;

    const rollup = rollupByKey.get(`${orgId}::${kpiKey}`);
    const dimensions = (rollup?.dimensions ?? {}) as Record<string, unknown>;
    let scopeLabel: string;
    if (typeof dimensions.branch_id === 'string') scopeLabel = `branch:${dimensions.branch_id}`;
    else if (typeof dimensions.zone_id === 'string') scopeLabel = `zone:${dimensions.zone_id}`;
    else if (typeof dimensions.service_level === 'string') scopeLabel = `service:${dimensions.service_level}`;
    else scopeLabel = 'tenant';

    const updatedAtRaw = rollup?.updated_at ?? rollup?.created_at ?? null;
    const updatedMs = updatedAtRaw ? new Date(String(updatedAtRaw)).getTime() : null;
    const ageSeconds = updatedMs != null ? Math.max(0, Math.round((now - updatedMs) / 1000)) : null;
    const isFresh = updatedMs != null && now - updatedMs < oneDayMs;
    const isStale = updatedMs == null || now - updatedMs >= oneDayMs;

    return {
      id: rollup?.id ? String(rollup.id) : `${d.id}::no_rollup`,
      organization_id: orgId || null,
      definition_id: d.id ?? null,
      kpi_key: kpiKey,
      kpi_label: d.name ?? null,
      kpi_description: d.description ?? null,
      kpi_unit: d.unit ?? null,
      group_label: groupLabel,
      format,
      tone,
      tone_thresholds: toneThresholds,
      day: rollup?.day ?? null,
      value_num: rollup?.value_num ?? null,
      numerator: rollup?.numerator ?? null,
      denominator: rollup?.denominator ?? null,
      dimensions,
      scope_label: scopeLabel,
      rollup_created_at: rollup?.created_at ?? null,
      rollup_updated_at: updatedAtRaw,
      age_seconds: ageSeconds,
      is_active: typeof d.is_active === 'boolean' ? d.is_active : true,
      is_fresh: isFresh,
      is_stale: isStale,
      has_rollup: rollup != null,
    } as ResourceRow;
  });
}

// W30 — Project existing `decision_log` seed entries joined to
// `settings_resolution_log` into the canonical `v_decision_log_directory`
// view shape (supabase/migrations/202604302810_v_decision_log_directory.sql).
//
// Surfaces canonical decision_log columns plus projected resolved_from
// (= settings_resolution_log.winning_scope_type), scope_path / scope_category
// / winning_settings_id / winning_settings_version_id / winning_version,
// age_seconds, has_correlation, has_resolution.
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_decision_log_directory`.
function _projectDecisionLogDirectory(): ResourceRow[] {
  const decisions = ((seed as Record<string, unknown>).decision_log ?? []) as Array<Record<string, unknown>>;
  const resolutions = ((seed as Record<string, unknown>).settings_resolution_log ?? []) as Array<Record<string, unknown>>;
  const now = Date.now();

  const resolutionById = new Map<string, Record<string, unknown>>();
  for (const r of resolutions) resolutionById.set(String(r.id), r);

  return decisions.map((d) => {
    const timestampRaw = d.timestamp ?? null;
    const timestampMs = timestampRaw ? new Date(String(timestampRaw)).getTime() : null;
    const ageSeconds = timestampMs != null ? Math.max(0, Math.round((now - timestampMs) / 1000)) : null;
    const resolutionId = d.settings_resolution_id ? String(d.settings_resolution_id) : null;
    const resolution = resolutionId ? resolutionById.get(resolutionId) : null;

    return {
      id: d.id,
      organization_id: d.organization_id ?? null,
      timestamp: timestampRaw,
      decision_category: d.decision_category ?? null,
      decision_point: d.decision_point ?? null,
      decision_outcome: d.decision_outcome ?? null,
      decision_inputs: d.decision_inputs ?? null,
      decision_reason: d.decision_reason ?? null,
      resource_type: d.resource_type ?? null,
      resource_id: d.resource_id ?? null,
      correlation_id: d.correlation_id ?? null,
      settings_resolution_id: resolutionId,
      performed_by_system: d.performed_by_system ?? null,
      // Resolution-projected fields. The seed `decision_log` entries already
      // carry a `resolved_from` field that mirrors the canonical projection
      // (FE-side seed legacy; W11-5 noted it as PROJECTED). We prefer the
      // joined value when the resolution row resolves; fallback to the seed
      // value otherwise so demo behavior stays stable.
      resolved_from: resolution?.winning_scope_type ?? d.resolved_from ?? null,
      scope_path: resolution?.scope_path ?? [],
      scope_category: resolution?.category ?? null,
      winning_settings_id: resolution?.winning_settings_id ?? null,
      winning_settings_version_id: resolution?.winning_settings_version_id ?? null,
      winning_version: resolution?.winning_version ?? null,
      scope_resolved_at: resolution?.resolved_at ?? null,
      age_seconds: ageSeconds,
      has_correlation: d.correlation_id != null,
      has_resolution: resolutionId != null,
    } as ResourceRow;
  });
}

// W30 — Project existing `settings_resolution_log` seed entries into the
// canonical `v_settings_resolution_directory` view shape
// (supabase/migrations/202604302820_v_settings_resolution_directory.sql).
//
// Surfaces canonical columns plus derived ladder_levels_visited
// (jsonb_array_length(scope_path)), override_count (non-global has_value=true
// entries), age_seconds, and winner-bucket booleans
// (is_global_winner / is_tenant_winner / is_client_winner / is_sender_winner).
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_settings_resolution_directory`.
function _projectSettingsResolutionDirectory(): ResourceRow[] {
  const resolutions = ((seed as Record<string, unknown>).settings_resolution_log ?? []) as Array<Record<string, unknown>>;
  const now = Date.now();

  return resolutions.map((r) => {
    const resolvedAtRaw = r.resolved_at ?? null;
    const resolvedMs = resolvedAtRaw ? new Date(String(resolvedAtRaw)).getTime() : null;
    const ageSeconds = resolvedMs != null ? Math.max(0, Math.round((now - resolvedMs) / 1000)) : null;
    const scopePath = Array.isArray(r.scope_path) ? (r.scope_path as Array<Record<string, unknown>>) : [];
    const ladderLevelsVisited = scopePath.length;
    const overrideCount = scopePath.filter((elem) => {
      if (!elem || typeof elem !== 'object') return false;
      const hasValue = (elem as { has_value?: unknown }).has_value === true;
      const scopeType = String((elem as { scope_type?: unknown }).scope_type ?? '');
      return hasValue && scopeType !== 'global';
    }).length;
    const winningScope = String(r.winning_scope_type ?? '');

    return {
      id: r.id,
      organization_id: r.organization_id ?? null,
      resolved_at: resolvedAtRaw,
      created_at: r.created_at ?? resolvedAtRaw,
      category: r.category ?? null,
      scope_path: scopePath,
      winning_scope_type: r.winning_scope_type ?? null,
      winning_scope_id: r.winning_scope_id ?? null,
      winning_settings_id: r.winning_settings_id ?? null,
      winning_settings_version_id: r.winning_settings_version_id ?? null,
      winning_version: r.winning_version ?? null,
      merge_notes: r.merge_notes ?? null,
      inputs: r.inputs ?? null,
      ladder_levels_visited: ladderLevelsVisited,
      override_count: overrideCount,
      age_seconds: ageSeconds,
      is_global_winner: winningScope === 'global',
      is_tenant_winner: winningScope === 'tenant',
      is_client_winner: winningScope === 'client',
      is_sender_winner: winningScope === 'sender' || winningScope === 'source' || winningScope === 'resource',
    } as ResourceRow;
  });
}

// W30 — Project existing `ui_event_log` seed entries into the canonical
// `v_ui_event_log_directory` view shape
// (supabase/migrations/202604302830_v_ui_event_log_directory.sql).
//
// Surfaces canonical columns plus path_label (= event_context OR meta->>path),
// command_label (= event_name OR meta->>command), age_seconds, and lifecycle
// booleans (is_action / has_resolution / has_scope).
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_ui_event_log_directory`.
function _projectUiEventLogDirectory(): ResourceRow[] {
  const events = ((seed as Record<string, unknown>).ui_event_log ?? []) as Array<Record<string, unknown>>;
  const now = Date.now();

  return events.map((e) => {
    const createdRaw = e.created_at ?? null;
    const createdMs = createdRaw ? new Date(String(createdRaw)).getTime() : null;
    const ageSeconds = createdMs != null ? Math.max(0, Math.round((now - createdMs) / 1000)) : null;
    const meta = (e.meta && typeof e.meta === 'object') ? (e.meta as Record<string, unknown>) : {};
    const eventContext = typeof e.event_context === 'string' ? e.event_context.trim() : '';
    const eventName = typeof e.event_name === 'string' ? e.event_name.trim() : '';
    const metaPath = typeof meta.path === 'string' ? meta.path.trim() : '';
    const metaCommand = typeof meta.command === 'string' ? meta.command.trim() : '';
    const pathLabel = eventContext || metaPath || null;
    const commandLabel = eventName || metaCommand || null;
    const eventType = String(e.event_type ?? '');
    const isAction = /\.action\b|\.click\b|\.submit\b/i.test(eventType);

    return {
      id: e.id,
      organization_id: e.organization_id ?? null,
      user_id: e.user_id ?? null,
      app: e.app ?? null,
      event_type: e.event_type ?? null,
      event_context: e.event_context ?? null,
      event_name: e.event_name ?? null,
      event_message: e.event_message ?? null,
      settings_resolution_id: e.settings_resolution_id ?? null,
      scope_type: e.scope_type ?? null,
      scope_id: e.scope_id ?? null,
      meta,
      digest: e.digest ?? null,
      created_at: createdRaw,
      path_label: pathLabel,
      command_label: commandLabel,
      age_seconds: ageSeconds,
      is_action: isAction,
      has_resolution: e.settings_resolution_id != null,
      has_scope: e.scope_type != null,
    } as ResourceRow;
  });
}

// W11-2 — Project the existing network-branches.js `branches` seed entries
// into the canonical `v_branch_summary` view shape
// (supabase/migrations/202604301400_v_branch_summary.sql).
//
// The seed entries already carry the projection counters inline
// (capacity_per_day, booked_today, active_vehicles, active_routes,
// manager_user_id, cutoff_time); the projection just renames
// `type` → `branch_type` and exposes a stable `branch_id` PK so registry-driven
// `useResourceList<BranchSummaryRow>('branch_summary')` resolves consistently
// with the live SQL view shape.
//
// In live mode (getSupabaseClient() set) this projection is unused — the live
// branch reads directly from `v_branch_summary`. The seed projection keeps
// demo-mode parity with the live shape so module callsites stay stable.
function _projectBranchSummary(): ResourceRow[] {
  const branches = ((seed as Record<string, unknown>).branches ?? []) as Array<{
    id: string;
    organization_id?: string;
    code?: string;
    name?: string;
    type?: string;
    branch_type?: string;
    is_active?: boolean;
    timezone?: string;
    capacity_per_day?: number;
    booked_today?: number;
    active_vehicles?: number;
    active_routes?: number;
    manager_user_id?: string | null;
    cutoff_time?: string | null;
    coordinates?: { lat?: unknown; lng?: unknown; latitude?: unknown; longitude?: unknown } | null;
    lat?: number | string | null;
    lng?: number | string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
    updated_at?: string;
  }>;
  return branches.map((b) => ({
    branch_id: b.id,
    id: b.id,
    organization_id: b.organization_id ?? null,
    code: b.code ?? null,
    name: b.name ?? null,
    branch_type: b.branch_type ?? b.type ?? null,
    is_active: typeof b.is_active === 'boolean' ? b.is_active : true,
    timezone: b.timezone ?? null,
    capacity_per_day: typeof b.capacity_per_day === 'number' ? b.capacity_per_day : 0,
    booked_today: typeof b.booked_today === 'number' ? b.booked_today : 0,
    active_vehicles: typeof b.active_vehicles === 'number' ? b.active_vehicles : 0,
    active_routes: typeof b.active_routes === 'number' ? b.active_routes : 0,
    manager_user_id: b.manager_user_id ?? null,
    cutoff_time: b.cutoff_time ?? null,
    lat: _numberFromUnknown(b.lat ?? b.latitude ?? b.coordinates?.lat ?? b.coordinates?.latitude),
    lng: _numberFromUnknown(b.lng ?? b.longitude ?? b.coordinates?.lng ?? b.coordinates?.longitude),
    updated_at: b.updated_at ?? null,
  } as ResourceRow));
}

// W18-3 — Project the existing network-branches.js `branch_capacity_windows`
// seed entries into the canonical `v_branch_capacity_heatmap` view shape
// (supabase/migrations/202604301420_v_branch_capacity_heatmap.sql).
//
// Canonical SSOT is `public.branch_capacity_windows`
// (`(branch_id, zone_id, day_of_week, window_start_local TIME,
// window_end_local TIME, capacity JSONB, …)`). The view fans the
// [window_start_local, window_end_local) range into per-hour cells with
// `(weekday, hour, capacity_units, booked_units)` projections. The seed
// already stores rows in the FE heatmap shape (one row per hour with
// inline `capacity_units` + `booked_units`) so the projection is a typed
// pass-through — it just re-keys `weekday`/`hour` and adds the synthesized
// `source_window_id` / `id` so registry-driven
// `useResourceList<BranchCapacityHeatmapCell>('branch_capacity_heatmap')`
// resolves consistently with the live SQL view shape.
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_branch_capacity_heatmap`. The seed
// projection keeps demo-mode parity with the live shape so module
// callsites stay stable.
function _projectBranchCapacityHeatmap(): ResourceRow[] {
  const windows = ((seed as Record<string, unknown>).branch_capacity_windows ?? []) as Array<{
    id?: string;
    branch_id: string;
    zone_id?: string | null;
    weekday: number;
    hour: number;
    capacity_units?: number;
    booked_units?: number | null;
    priority?: number;
    updated_at?: string;
  }>;
  return windows.map((w) => {
    const sourceId = w.id ?? `bcw_${w.branch_id}_${w.weekday}_${w.hour}`;
    return {
      id: `${sourceId}_${w.hour}`,
      source_window_id: sourceId,
      branch_id: w.branch_id,
      zone_id: w.zone_id ?? null,
      weekday: w.weekday,
      hour: w.hour,
      capacity_units: typeof w.capacity_units === 'number' ? w.capacity_units : 0,
      booked_units: typeof w.booked_units === 'number' ? w.booked_units : null,
      priority: typeof w.priority === 'number' ? w.priority : 0,
      updated_at: w.updated_at ?? null,
    } as ResourceRow;
  });
}

type ZoneGeometryRecord = {
  kind: 'polygon';
  source: 'canonical_district_centroids';
  paths: Array<[number, number]>;
};

export function _numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function _districtCentroidPoint(row: Record<string, unknown> | undefined): [number, number] | null {
  if (!row) return null;
  const lng = _numberFromUnknown(row.centroid_lng ?? row.lng ?? row.longitude);
  const lat = _numberFromUnknown(row.centroid_lat ?? row.lat ?? row.latitude);
  if (lng == null || lat == null) return null;
  return [lng, lat];
}

function _closeRing(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length === 0) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return points;
  return [...points, first];
}

function _boxAroundPoint([lng, lat]: [number, number], radius = 0.018): Array<[number, number]> {
  return _closeRing([
    [lng - radius, lat - radius],
    [lng + radius, lat - radius],
    [lng + radius, lat + radius],
    [lng - radius, lat + radius],
  ]);
}

function _boxAroundLine(a: [number, number], b: [number, number], radius = 0.014): Array<[number, number]> {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * radius;
  const ny = (dx / len) * radius;
  return _closeRing([
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ]);
}

function _cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function _convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p] as const)).values()]
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (sorted.length <= 1) return sorted;
  const lower: Array<[number, number]> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && _cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i]!;
    while (upper.length >= 2 && _cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function _zoneGeometryFromDistrictCentroids(points: Array<[number, number]>): ZoneGeometryRecord | null {
  const unique = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p] as const)).values()];
  if (unique.length === 0) return null;
  if (unique.length === 1) {
    return { kind: 'polygon', source: 'canonical_district_centroids', paths: _boxAroundPoint(unique[0]!) };
  }
  const hull = _convexHull(unique);
  const paths = hull.length >= 3 ? _closeRing(hull) : _boxAroundLine(unique[0]!, unique[1]!);
  return { kind: 'polygon', source: 'canonical_district_centroids', paths };
}

// W11-2 + W80 — Project the existing network-zones.js seed entries (zones +
// branch_zones + zone_districts + zone_override_requests + canonical_districts)
// into the canonical `v_zone_summary` view shape
// (supabase/migrations/202604301410_v_zone_summary.sql).
//
// The projection computes the four derived counters (branch_count,
// district_count, pending_overrides, last_override_at) on the fly from the
// related seed slices. `hub_code` is taken from the linked branch with the
// lowest priority; `color_token` is the FE-side metadata equivalent of the
// canonical zones.metadata->>'color_token' projection. `geometry` is derived
// from canonical district centroid rows, matching the live view contract.
//
// In live mode (getSupabaseClient() set) this projection is unused — the live
// branch reads directly from `v_zone_summary`. Keeps demo-mode parity with
// the live shape so module callsites stay stable.
function _projectZoneSummary(): ResourceRow[] {
  const zones = ((seed as Record<string, unknown>).zones ?? []) as Array<{
    id: string;
    organization_id?: string;
    name?: string;
    slug?: string;
    is_active?: boolean;
    description?: string;
    notes?: string;
    color_token?: string;
    hub_code?: string;
    status?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
  }>;
  const links = ((seed as Record<string, unknown>).branch_zones ?? []) as Array<{
    branch_id?: string;
    zone_id: string;
    priority?: number;
  }>;
  const districts = ((seed as Record<string, unknown>).zone_districts ?? []) as Array<{
    zone_id: string;
    canonical_district_id?: string;
    district_id?: string;
  }>;
  const canonicalDistricts = ((seed as Record<string, unknown>).canonical_districts ?? []) as Array<Record<string, unknown> & {
    id: string;
  }>;
  const overrides = ((seed as Record<string, unknown>).zone_override_requests ?? []) as Array<{
    zone_id: string;
    status?: string;
    decision_at?: string | null;
    updated_at?: string;
    created_at?: string;
  }>;

  const branchCountByZone = new Map<string, Set<string>>();
  for (const l of links) {
    if (!l.zone_id) continue;
    const set = branchCountByZone.get(l.zone_id) ?? new Set<string>();
    if (l.branch_id) set.add(l.branch_id);
    branchCountByZone.set(l.zone_id, set);
  }
  const districtCountByZone = new Map<string, number>();
  const districtPointsByZone = new Map<string, Array<[number, number]>>();
  const districtById = new Map<string, (typeof canonicalDistricts)[number]>();
  for (const d of canonicalDistricts) districtById.set(d.id, d);
  for (const d of districts) {
    if (!d.zone_id) continue;
    districtCountByZone.set(d.zone_id, (districtCountByZone.get(d.zone_id) ?? 0) + 1);
    const districtId = d.canonical_district_id ?? d.district_id ?? null;
    const point = districtId ? _districtCentroidPoint(districtById.get(districtId)) : null;
    if (point) {
      const points = districtPointsByZone.get(d.zone_id) ?? [];
      points.push(point);
      districtPointsByZone.set(d.zone_id, points);
    }
  }
  const pendingByZone = new Map<string, number>();
  const lastOverrideByZone = new Map<string, string>();
  for (const o of overrides) {
    if (!o.zone_id) continue;
    if (o.status === 'pending') {
      pendingByZone.set(o.zone_id, (pendingByZone.get(o.zone_id) ?? 0) + 1);
    }
    const cand = o.updated_at ?? o.decision_at ?? o.created_at ?? null;
    if (cand) {
      const prior = lastOverrideByZone.get(o.zone_id);
      if (!prior || cand > prior) lastOverrideByZone.set(o.zone_id, cand);
    }
  }
  // Deterministic hub_code: lowest priority branch link, falling back to seed.hub_code.
  const hubByZone = new Map<string, string>();
  const sortedLinks = [...links].sort((a, b) => {
    const pa = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
    const pb = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return String(a.branch_id ?? '').localeCompare(String(b.branch_id ?? ''));
  });
  for (const l of sortedLinks) {
    if (!l.zone_id || hubByZone.has(l.zone_id)) continue;
    if (l.branch_id) hubByZone.set(l.zone_id, l.branch_id);
  }

  return zones.map((z) => {
    const isActive = typeof z.is_active === 'boolean'
      ? z.is_active
      : (z.status ? z.status === 'active' : true);
    const colorToken = z.color_token
      ?? (z.metadata && typeof z.metadata === 'object' && z.metadata !== null
        ? (z.metadata as Record<string, unknown>).color_token as string | undefined
        : undefined)
      ?? null;
    return {
      zone_id: z.id,
      id: z.id,
      organization_id: z.organization_id ?? null,
      name: z.name ?? null,
      slug: z.slug ?? null,
      is_active: isActive,
      description: z.description ?? z.notes ?? null,
      created_at: z.created_at ?? null,
      updated_at: z.updated_at ?? null,
      branch_count: branchCountByZone.get(z.id)?.size ?? 0,
      district_count: districtCountByZone.get(z.id) ?? 0,
      pending_overrides: pendingByZone.get(z.id) ?? 0,
      last_override_at: lastOverrideByZone.get(z.id) ?? null,
      hub_code: z.hub_code ?? hubByZone.get(z.id) ?? null,
      color_token: colorToken,
      geometry: _zoneGeometryFromDistrictCentroids(districtPointsByZone.get(z.id) ?? []),
    } as ResourceRow;
  });
}

// W20 — Project the existing network-branches.js `branch_zones` seed
// entries (joined with branches + zones for label projection) into the
// canonical `v_branch_zone_directory` view shape
// (supabase/migrations/202604301800_v_branch_zone_directory.sql). Closes
// the deferred §10 BranchZoneRow.branch_label projection in
// __audit__/SCHEMA-DRIFT/NETWORK.md (W18-3 deferral).
//
// The seed-side `branch_zones` rows already carry an FE-projected
// `branch_label` inline (mirrors `branches.name`); this projection
// re-derives the same value from the canonical `branches` slice so the
// live + demo paths converge on the same shape. In live mode
// (getSupabaseClient() set) this projection is unused — the live branch
// reads directly from `v_branch_zone_directory`.
function _projectZonePerformanceMetrics(): ResourceRow[] {
  const map = ((seed as Record<string, unknown>).zone_performance_metrics ?? {}) as Record<
    string,
    ZonePerformanceMetricsRecord | undefined
  >;
  const zones = ((seed as Record<string, unknown>).zones ?? []) as Array<{
    id: string;
    organization_id?: string;
  }>;
  const orgByZone = new Map<string, string | undefined>();
  for (const z of zones) orgByZone.set(z.id, z.organization_id);
  return Object.entries(map).map(([zoneId, metrics]) => ({
    id: zoneId,
    zone_id: zoneId,
    organization_id: orgByZone.get(zoneId) ?? null,
    shipments_today: metrics?.shipments_today ?? 0,
    shipments_week: metrics?.shipments_week ?? 0,
    on_time_pct: metrics?.on_time_pct ?? null,
    capacity_saturation_pct: metrics?.capacity_saturation_pct ?? 0,
    spark_today: metrics?.spark_today ?? [],
    spark_week: metrics?.spark_week ?? [],
  }));
}

function _projectBranchZoneDirectory(): ResourceRow[] {
  const links = ((seed as Record<string, unknown>).branch_zones ?? []) as Array<{
    id?: string;
    branch_id?: string;
    zone_id: string;
    priority?: number;
    created_at?: string;
    branch_label?: string;
  }>;
  const branches = ((seed as Record<string, unknown>).branches ?? []) as Array<{
    id: string;
    code?: string;
    name?: string;
    branch_type?: string;
    type?: string;
  }>;
  const zones = ((seed as Record<string, unknown>).zones ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;
  const branchById = new Map<string, (typeof branches)[number]>();
  for (const b of branches) branchById.set(b.id, b);
  const zoneById = new Map<string, (typeof zones)[number]>();
  for (const z of zones) zoneById.set(z.id, z);

  return links.map((l) => {
    const b = l.branch_id ? branchById.get(l.branch_id) : undefined;
    const z = l.zone_id ? zoneById.get(l.zone_id) : undefined;
    // Prefer canonical branches.name; fall back to branches.code; lastly to
    // the seed-inlined `branch_label` for legacy rows that pre-date the
    // canonical roster materialisation.
    const branchLabel = b?.name ?? b?.code ?? l.branch_label ?? null;
    return {
      id: l.id ?? `${l.branch_id ?? 'unknown'}_${l.zone_id}`,
      branch_id: l.branch_id ?? null,
      zone_id: l.zone_id,
      priority: typeof l.priority === 'number' ? l.priority : null,
      created_at: l.created_at ?? null,
      branch_label: branchLabel,
      hub_code: b?.code ?? null,
      branch_type: b?.branch_type ?? b?.type ?? null,
      zone_label: z?.name ?? null,
      zone_slug: z?.slug ?? null,
    } as ResourceRow;
  });
}

// W21 — Project the existing domain-shipments.js `clients` + `senders` +
// `recipients` + `shipments` seed entries into the canonical
// `v_client_summary` view shape
// (supabase/migrations/202604302000_v_client_summary.sql).
//
// Closes the deferred CUSTOMERS surface-bind gaps (sender_count,
// recipient_count, active_shipments, total_shipments, last_shipment_at,
// contract_active, has_warehouse) without inventing FE-only fields. The
// view is the canonical projection seam; the FE row interface
// `ClientRow` keeps the canonical columns and reads counter context
// through `useResourceList<ClientSummaryRow>('client_summary')`.
//
// In live mode (getSupabaseClient() set) this projection is unused — the
// live branch reads directly from `v_client_summary`. The seed
// projection keeps demo-mode parity with the live shape.
function _projectClientSummary(): ResourceRow[] {
  const clients = ((seed as Record<string, unknown>).clients ?? []) as Array<{
    id: string;
    organization_id?: string;
    name?: string;
    slug?: string;
    sla_tier?: string;
    status?: string;
    account_manager_id?: string | null;
    contract_start_date?: string | null;
    contract_end_date?: string | null;
    suspension_reason?: string | null;
    warehouse_address_id?: string | null;
    billing_settings?: Record<string, unknown> | null;
    settings_override?: Record<string, unknown> | null;
    updated_at?: string;
  }>;
  const senders = ((seed as Record<string, unknown>).senders ?? []) as Array<{
    client_id?: string;
    status?: string;
  }>;
  const recipients = ((seed as Record<string, unknown>).recipients ?? []) as Array<{
    client_id?: string;
  }>;
  const shipments = ((seed as Record<string, unknown>).shipments ?? []) as Array<{
    client_id?: string;
    status?: string;
    created_at?: string;
  }>;

  const senderCountByClient = new Map<string, number>();
  for (const s of senders) {
    if (!s.client_id || s.status !== 'active') continue;
    senderCountByClient.set(s.client_id, (senderCountByClient.get(s.client_id) ?? 0) + 1);
  }
  const recipientCountByClient = new Map<string, number>();
  for (const r of recipients) {
    if (!r.client_id) continue;
    recipientCountByClient.set(
      r.client_id,
      (recipientCountByClient.get(r.client_id) ?? 0) + 1,
    );
  }
  const TERMINAL_SHIPMENT_STATES = new Set([
    'delivered',
    'cancelled',
    'returned_to_sender',
  ]);
  const activeShipmentsByClient = new Map<string, number>();
  const totalShipmentsByClient = new Map<string, number>();
  const lastShipmentAtByClient = new Map<string, string>();
  for (const sh of shipments) {
    if (!sh.client_id) continue;
    totalShipmentsByClient.set(
      sh.client_id,
      (totalShipmentsByClient.get(sh.client_id) ?? 0) + 1,
    );
    if (sh.status && !TERMINAL_SHIPMENT_STATES.has(sh.status)) {
      activeShipmentsByClient.set(
        sh.client_id,
        (activeShipmentsByClient.get(sh.client_id) ?? 0) + 1,
      );
    }
    const cand = sh.created_at;
    if (cand) {
      const prior = lastShipmentAtByClient.get(sh.client_id);
      if (!prior || cand > prior) lastShipmentAtByClient.set(sh.client_id, cand);
    }
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return clients.map((c) => {
    const contractActive =
      c.status === 'active' &&
      (!c.contract_end_date || c.contract_end_date >= today);
    return {
      client_id: c.id,
      id: c.id,
      organization_id: c.organization_id ?? null,
      name: c.name ?? null,
      slug: c.slug ?? null,
      sla_tier: c.sla_tier ?? null,
      status: c.status ?? null,
      account_manager_id: c.account_manager_id ?? null,
      contract_start_date: c.contract_start_date ?? null,
      contract_end_date: c.contract_end_date ?? null,
      suspension_reason: c.suspension_reason ?? null,
      warehouse_address_id: c.warehouse_address_id ?? null,
      billing_settings: c.billing_settings ?? null,
      settings_override: c.settings_override ?? null,
      updated_at: c.updated_at ?? null,
      sender_count: senderCountByClient.get(c.id) ?? 0,
      recipient_count: recipientCountByClient.get(c.id) ?? 0,
      active_shipments: activeShipmentsByClient.get(c.id) ?? 0,
      total_shipments: totalShipmentsByClient.get(c.id) ?? 0,
      last_shipment_at: lastShipmentAtByClient.get(c.id) ?? null,
      contract_active: contractActive,
      has_warehouse: c.warehouse_address_id != null,
    } as ResourceRow;
  });
}

// W21 — Project the existing domain-shipments.js `senders` seed entries
// (joined with clients + shipments) into the canonical `v_sender_summary`
// view shape (supabase/migrations/202604302010_v_sender_summary.sql).
//
// Closes the deferred CUSTOMERS surface-bind gaps for senders
// (client_label, client_slug, sla_tier_inherited, organization_id_resolved,
// effective_warehouse_id, has_warehouse, active/total shipments counters,
// last_shipment_at). Mirrors the SQL view's COALESCE for
// effective_warehouse_id (sender override → client default).
//
// In live mode this projection is unused — the live branch reads directly
// from `v_sender_summary`.
function _projectSenderSummary(): ResourceRow[] {
  const senders = ((seed as Record<string, unknown>).senders ?? []) as Array<{
    id: string;
    client_id?: string;
    name?: string;
    brand_name?: string | null;
    auto_provisioned?: boolean;
    auto_recreate?: boolean;
    warehouse_address_id?: string | null;
    settings_override?: Record<string, unknown> | null;
    status?: string;
    updated_at?: string;
  }>;
  const clients = ((seed as Record<string, unknown>).clients ?? []) as Array<{
    id: string;
    organization_id?: string;
    name?: string;
    slug?: string;
    sla_tier?: string;
    warehouse_address_id?: string | null;
  }>;
  const shipments = ((seed as Record<string, unknown>).shipments ?? []) as Array<{
    sender_id?: string;
    status?: string;
    created_at?: string;
  }>;

  const clientById = new Map<string, (typeof clients)[number]>();
  for (const c of clients) clientById.set(c.id, c);

  const TERMINAL_SHIPMENT_STATES = new Set([
    'delivered',
    'cancelled',
    'returned_to_sender',
  ]);
  const activeBySender = new Map<string, number>();
  const totalBySender = new Map<string, number>();
  const lastBySender = new Map<string, string>();
  for (const sh of shipments) {
    if (!sh.sender_id) continue;
    totalBySender.set(sh.sender_id, (totalBySender.get(sh.sender_id) ?? 0) + 1);
    if (sh.status && !TERMINAL_SHIPMENT_STATES.has(sh.status)) {
      activeBySender.set(sh.sender_id, (activeBySender.get(sh.sender_id) ?? 0) + 1);
    }
    const cand = sh.created_at;
    if (cand) {
      const prior = lastBySender.get(sh.sender_id);
      if (!prior || cand > prior) lastBySender.set(sh.sender_id, cand);
    }
  }

  return senders.map((s) => {
    const c = s.client_id ? clientById.get(s.client_id) : undefined;
    return {
      sender_id: s.id,
      id: s.id,
      client_id: s.client_id ?? null,
      name: s.name ?? null,
      brand_name: s.brand_name ?? null,
      auto_provisioned: typeof s.auto_provisioned === 'boolean' ? s.auto_provisioned : false,
      auto_recreate: typeof s.auto_recreate === 'boolean' ? s.auto_recreate : false,
      warehouse_address_id: s.warehouse_address_id ?? null,
      settings_override: s.settings_override ?? null,
      status: s.status ?? null,
      updated_at: s.updated_at ?? null,
      client_label: c?.name ?? null,
      client_slug: c?.slug ?? null,
      sla_tier_inherited: c?.sla_tier ?? null,
      organization_id_resolved: c?.organization_id ?? null,
      effective_warehouse_id: s.warehouse_address_id ?? c?.warehouse_address_id ?? null,
      has_warehouse: s.warehouse_address_id != null,
      active_shipments: activeBySender.get(s.id) ?? 0,
      total_shipments: totalBySender.get(s.id) ?? 0,
      last_shipment_at: lastBySender.get(s.id) ?? null,
    } as ResourceRow;
  });
}

// W21 — Project the existing domain-shipments.js `recipients` seed entries
// (joined with clients + shipments) into the canonical
// `v_recipient_directory` view shape
// (supabase/migrations/202604302020_v_recipient_directory.sql).
//
// Closes deferred CUSTOMERS surface-bind for recipient context (client
// join label + last shipment status + derived booleans).
//
// In live mode this projection is unused — the live branch reads directly
// from `v_recipient_directory`.
function _projectRecipientDirectory(): ResourceRow[] {
  const recipients = ((seed as Record<string, unknown>).recipients ?? []) as Array<{
    id: string;
    organization_id?: string;
    client_id?: string;
    external_id?: string | null;
    name?: string;
    phone_number?: string;
    phone_validation_status?: string | null;
    email?: string | null;
    preferred_language?: string;
    preferred_comm_channel?: string;
    quiet_hours_start?: string | null;
    quiet_hours_end?: string | null;
    communication_preferences?: Record<string, unknown> | null;
    updated_at?: string;
  }>;
  const clients = ((seed as Record<string, unknown>).clients ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;
  const shipments = ((seed as Record<string, unknown>).shipments ?? []) as Array<{
    recipient_id?: string;
    status?: string;
    created_at?: string;
  }>;

  const clientById = new Map<string, (typeof clients)[number]>();
  for (const c of clients) clientById.set(c.id, c);

  const totalByRecipient = new Map<string, number>();
  const lastShipByRecipient = new Map<string, { created_at: string; status?: string }>();
  for (const sh of shipments) {
    if (!sh.recipient_id) continue;
    totalByRecipient.set(
      sh.recipient_id,
      (totalByRecipient.get(sh.recipient_id) ?? 0) + 1,
    );
    const prior = lastShipByRecipient.get(sh.recipient_id);
    if (sh.created_at && (!prior || sh.created_at > prior.created_at)) {
      lastShipByRecipient.set(sh.recipient_id, { created_at: sh.created_at, status: sh.status });
    }
  }

  return recipients.map((r) => {
    const c = r.client_id ? clientById.get(r.client_id) : undefined;
    const last = lastShipByRecipient.get(r.id);
    return {
      recipient_id: r.id,
      id: r.id,
      organization_id: r.organization_id ?? null,
      client_id: r.client_id ?? null,
      external_id: r.external_id ?? null,
      name: r.name ?? null,
      phone_number: r.phone_number ?? null,
      phone_validation_status: r.phone_validation_status ?? null,
      email: r.email ?? null,
      preferred_language: r.preferred_language ?? null,
      preferred_comm_channel: r.preferred_comm_channel ?? null,
      quiet_hours_start: r.quiet_hours_start ?? null,
      quiet_hours_end: r.quiet_hours_end ?? null,
      communication_preferences: r.communication_preferences ?? null,
      updated_at: r.updated_at ?? null,
      client_label: c?.name ?? null,
      client_slug: c?.slug ?? null,
      total_shipments: totalByRecipient.get(r.id) ?? 0,
      last_shipment_at: last?.created_at ?? null,
      last_shipment_status: last?.status ?? null,
      phone_validated: r.phone_validation_status === 'valid',
      has_quiet_hours:
        r.quiet_hours_start != null && r.quiet_hours_end != null,
    } as ResourceRow;
  });
}

// W25 — Project the existing finance-billing.js `billing_invoices` +
// `billing_invoice_lines` + `billing_invoice_events` seed entries into the
// canonical `v_billing_invoice_directory` view shape
// (supabase/migrations/202604302300_v_billing_invoice_directory.sql).
//
// In live mode (getSupabaseClient() set) this projection is unused — the live
// branch reads directly from `v_billing_invoice_directory`. The seed
// projection mirrors the live SQL view shape so module call sites stay stable
// across the cutover.
//
// Seed mode handles the FE alias shadows (`period_start`/`period_end` →
// canonical `period_start_at`/`period_end_at`, `total_amount` → canonical
// `total`, `due_date` → canonical `due_at`, `sent_at` → canonical `issued_at`).
// Production reads canonical columns directly.
function _projectBillingInvoiceDirectory(): ResourceRow[] {
  const invoices = ((seed as Record<string, unknown>).billing_invoices ?? []) as Array<{
    id: string;
    organization_id?: string;
    client_id?: string;
    sender_id?: string | null;
    client_label?: string;
    invoice_number?: string;
    status?: string;
    status_reason?: string | null;
    currency?: string;
    subtotal?: number;
    tax_total?: number;
    total?: number;
    total_amount?: number;
    amount_paid?: number;
    amount_due?: number;
    period_start?: string;
    period_end?: string;
    period_start_at?: string;
    period_end_at?: string;
    issued_at?: string | null;
    sent_at?: string | null;
    due_at?: string | null;
    due_date?: string | null;
    paid_at?: string | null;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
  }>;
  const lines = ((seed as Record<string, unknown>).billing_invoice_lines ?? []) as Array<{
    invoice_id: string;
    qty?: number;
    unit_price?: number;
    line_total?: number;
    amount?: number;
  }>;
  const events = ((seed as Record<string, unknown>).billing_invoice_events ?? []) as Array<{
    invoice_id: string;
    event_type?: string;
    occurred_at?: string;
    created_at?: string;
  }>;
  const clients = ((seed as Record<string, unknown>).clients ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;
  const senders = ((seed as Record<string, unknown>).senders ?? []) as Array<{
    id: string;
    name?: string;
  }>;

  const clientById = new Map<string, (typeof clients)[number]>();
  for (const c of clients) clientById.set(c.id, c);
  const senderById = new Map<string, (typeof senders)[number]>();
  for (const s of senders) senderById.set(s.id, s);

  const lineCountByInv = new Map<string, number>();
  const lineTotalByInv = new Map<string, number>();
  for (const l of lines) {
    if (!l.invoice_id) continue;
    lineCountByInv.set(l.invoice_id, (lineCountByInv.get(l.invoice_id) ?? 0) + 1);
    const amt =
      typeof l.amount === 'number'
        ? l.amount
        : typeof l.line_total === 'number'
          ? l.line_total
          : (typeof l.qty === 'number' && typeof l.unit_price === 'number'
              ? l.qty * l.unit_price
              : 0);
    lineTotalByInv.set(l.invoice_id, (lineTotalByInv.get(l.invoice_id) ?? 0) + amt);
  }

  const lastEventByInv = new Map<string, { at: string; type: string }>();
  const sentAtByInv = new Map<string, string>();
  const refundedAtByInv = new Map<string, string>();
  const voidedAtByInv = new Map<string, string>();
  for (const e of events) {
    const at = e.occurred_at ?? e.created_at;
    if (!e.invoice_id || !at) continue;
    const prior = lastEventByInv.get(e.invoice_id);
    if (!prior || at > prior.at) {
      lastEventByInv.set(e.invoice_id, { at, type: e.event_type ?? '' });
    }
    if (e.event_type === 'sent') {
      const ps = sentAtByInv.get(e.invoice_id);
      if (!ps || at > ps) sentAtByInv.set(e.invoice_id, at);
    } else if (e.event_type === 'refunded') {
      const ps = refundedAtByInv.get(e.invoice_id);
      if (!ps || at > ps) refundedAtByInv.set(e.invoice_id, at);
    } else if (e.event_type === 'voided') {
      const ps = voidedAtByInv.get(e.invoice_id);
      if (!ps || at > ps) voidedAtByInv.set(e.invoice_id, at);
    }
  }

  const now = Date.now();
  return invoices.map((inv) => {
    const c = inv.client_id ? clientById.get(inv.client_id) : undefined;
    const s = inv.sender_id ? senderById.get(inv.sender_id) : undefined;
    const due = inv.due_at ?? inv.due_date ?? null;
    const dueMs = due ? Date.parse(due) : NaN;
    const isOverdue =
      inv.status === 'overdue' ||
      (inv.status === 'sent' && Number.isFinite(dueMs) && now > dueMs);
    const paymentStatus =
      inv.paid_at != null
        ? 'paid'
        : isOverdue
          ? 'overdue'
          : inv.status === 'voided'
            ? 'voided'
            : inv.status === 'refunded'
              ? 'refunded'
              : inv.status === 'sent'
                ? 'sent'
                : 'draft';
    const createdMs = inv.created_at ? Date.parse(inv.created_at) : NaN;
    const ageDays = Number.isFinite(createdMs)
      ? Math.max(0, Math.floor((now - createdMs) / 86_400_000))
      : 0;
    const lastEvent = lastEventByInv.get(inv.id);
    return {
      invoice_id: inv.id,
      id: inv.id,
      organization_id: inv.organization_id ?? null,
      client_id: inv.client_id ?? null,
      sender_id: inv.sender_id ?? null,
      invoice_number: inv.invoice_number ?? null,
      status: inv.status ?? 'draft',
      status_reason: inv.status_reason ?? null,
      // W78 (Cross-cutting Cycle F-R-18 P1) — strict no-fallback at the
      // projection layer. The canonical default currency is `tenant_currency.iso_code`
      // resolved by consumers via `useResolveSettings('tenant_currency')`;
      // synthesizing a literal `'sar'` here masks unseeded invoices with a
      // silent default. Surface the gap as `null` so consumers fail loud
      // (e.g. fmtCurrency renders `(missing)`). AGENTS.md §2 ZERO HARDCODING
      // + §4 SSOT + §6 row-driven config.
      currency: inv.currency ?? null,
      subtotal: typeof inv.subtotal === 'number' ? inv.subtotal : 0,
      tax_total: typeof inv.tax_total === 'number' ? inv.tax_total : 0,
      total: typeof inv.total === 'number' ? inv.total : (inv.total_amount ?? 0),
      amount_paid: typeof inv.amount_paid === 'number' ? inv.amount_paid : 0,
      amount_due: typeof inv.amount_due === 'number' ? inv.amount_due : 0,
      period_start_at: inv.period_start_at ?? inv.period_start ?? null,
      period_end_at: inv.period_end_at ?? inv.period_end ?? null,
      issued_at: inv.issued_at ?? inv.sent_at ?? null,
      due_at: due,
      paid_at: inv.paid_at ?? null,
      metadata: inv.metadata ?? {},
      created_at: inv.created_at ?? null,
      updated_at: inv.updated_at ?? null,
      client_label: c?.name ?? inv.client_label ?? null,
      client_slug: c?.slug ?? null,
      sender_label: s?.name ?? null,
      line_count: lineCountByInv.get(inv.id) ?? 0,
      line_total_amount: lineTotalByInv.get(inv.id) ?? 0,
      last_event_at: lastEvent?.at ?? null,
      last_event_type: lastEvent?.type ?? null,
      sent_at: sentAtByInv.get(inv.id) ?? inv.sent_at ?? null,
      refunded_at: refundedAtByInv.get(inv.id) ?? null,
      voided_at: voidedAtByInv.get(inv.id) ?? null,
      is_overdue: isOverdue,
      payment_status: paymentStatus,
      age_days: ageDays,
    } as ResourceRow;
  });
}

// W25 — Project the existing marketplace.js `marketplace_disputes` seed
// entries into the canonical `v_dispute_directory` view shape
// (supabase/migrations/202604302310_v_dispute_directory.sql).
//
// In live mode (getSupabaseClient() set) this projection is unused — the live
// branch reads directly from `v_dispute_directory`. The seed projection
// mirrors the live SQL view shape so module call sites stay stable across the
// cutover.
function _projectDisputeDirectory(): ResourceRow[] {
  const disputes = ((seed as Record<string, unknown>).marketplace_disputes ?? []) as Array<{
    id: string;
    created_at?: string;
    updated_at?: string;
    request_id?: string | null;
    contract_id?: string | null;
    work_package_id?: string | null;
    opened_by_organization_id?: string | null;
    counterparty_organization_id?: string | null;
    opened_by_user_id?: string | null;
    resolved_by_user_id?: string | null;
    status?: string;
    category?: string;
    title?: string;
    description?: string;
    resolution?: string;
    resolved_at?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  const orgs = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<{
    id: string;
    full_name?: string;
    name?: string;
  }>;
  const shipments = ((seed as Record<string, unknown>).shipments ?? []) as Array<{
    id: string;
    tracking_number?: string | null;
    client_id?: string | null;
    client_reference_number?: string | null;
    external_id?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  const contracts = ((seed as Record<string, unknown>).marketplace_contracts ?? []) as Array<{
    id: string;
    participant_id?: string | null;
    supplier_participant_profile_id?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  const orgById = new Map<string, (typeof orgs)[number]>();
  for (const o of orgs) orgById.set(o.id, o);
  const userById = new Map<string, (typeof users)[number]>();
  for (const u of users) userById.set(u.id, u);
  const shipmentClientByRef = new Map<string, string>();
  for (const shipment of shipments) {
    const clientId = shipment.client_id;
    if (!clientId) continue;
    const md = shipment.metadata ?? {};
    for (const value of [
      shipment.id,
      shipment.tracking_number,
      shipment.client_reference_number,
      shipment.external_id,
      md.tracking_number,
      md.shipment_ref,
    ]) {
      if (typeof value === 'string' && value.trim()) shipmentClientByRef.set(value, clientId);
    }
  }
  const partnerByContractId = new Map<string, string>();
  for (const contract of contracts) {
    const md = contract.metadata ?? {};
    const partnerId =
      contract.supplier_participant_profile_id ??
      contract.participant_id ??
      (typeof md.supplier_participant_profile_id === 'string'
        ? md.supplier_participant_profile_id
        : undefined) ??
      (typeof md.participant_id === 'string' ? md.participant_id : undefined);
    if (contract.id && partnerId) partnerByContractId.set(contract.id, partnerId);
  }

  const now = Date.now();
  return disputes.map((d) => {
    const md = d.metadata ?? {};
    const escCount = (() => {
      const v = (md as Record<string, unknown>)['escalation_count'];
      return typeof v === 'number' ? v : Number(v) || 0;
    })();
    const escAt = (() => {
      const v = (md as Record<string, unknown>)['escalation_at'];
      return typeof v === 'string' ? v : null;
    })();
    const shipmentRef = (() => {
      const v = (md as Record<string, unknown>)['shipment_ref'];
      return typeof v === 'string' ? v : null;
    })();
    const amountSar = (() => {
      const v = (md as Record<string, unknown>)['amount_sar'];
      return typeof v === 'number' ? v : Number(v) || 0;
    })();
    const createdMs = d.created_at ? Date.parse(d.created_at) : NaN;
    const ageSec = Number.isFinite(createdMs)
      ? Math.max(0, Math.floor((now - createdMs) / 1000))
      : 0;
    const ageHours = Math.floor(ageSec / 3600);
    const isTerminal = d.status === 'resolved' || d.status === 'rejected';
    const opener = d.opened_by_organization_id
      ? orgById.get(d.opened_by_organization_id)
      : undefined;
    const cpty = d.counterparty_organization_id
      ? orgById.get(d.counterparty_organization_id)
      : undefined;
    const openerUser = d.opened_by_user_id ? userById.get(d.opened_by_user_id) : undefined;
    const resolverUser = d.resolved_by_user_id ? userById.get(d.resolved_by_user_id) : undefined;
    const shipmentClientId = shipmentRef ? shipmentClientByRef.get(shipmentRef) ?? null : null;
    const contractPartnerId = d.contract_id ? partnerByContractId.get(d.contract_id) ?? null : null;
    return {
      dispute_id: d.id,
      id: d.id,
      created_at: d.created_at ?? null,
      updated_at: d.updated_at ?? null,
      request_id: d.request_id ?? null,
      contract_id: d.contract_id ?? null,
      work_package_id: d.work_package_id ?? null,
      opened_by_organization_id: d.opened_by_organization_id ?? null,
      counterparty_organization_id: d.counterparty_organization_id ?? null,
      opened_by_user_id: d.opened_by_user_id ?? null,
      resolved_by_user_id: d.resolved_by_user_id ?? null,
      status: d.status ?? 'open',
      category: d.category ?? 'general',
      title: d.title ?? null,
      description: d.description ?? null,
      resolution: d.resolution ?? null,
      resolved_at: d.resolved_at ?? null,
      metadata: md,
      opened_by_label: opener?.name ?? null,
      counterparty_label: cpty?.name ?? null,
      opened_by_user_label: openerUser?.full_name ?? openerUser?.name ?? null,
      resolved_by_user_label: resolverUser?.full_name ?? resolverUser?.name ?? null,
      contract_status: null, // seed marketplace_contracts not enriched here
      work_package_status: null,
      request_label: null,
      shipment_ref: shipmentRef,
      amount_sar: amountSar,
      escalation_count: escCount,
      escalation_at: escAt,
      is_escalated: escCount > 0,
      is_terminal: isTerminal,
      age_seconds: ageSec,
      age_hours: ageHours,
      client_id: shipmentClientId,
      shipment_client_id: shipmentClientId,
      partner_id: contractPartnerId,
      participant_id: contractPartnerId,
      supplier_participant_profile_id: contractPartnerId,
    } as ResourceRow;
  });
}

// W26 — Project the existing support.js `support_cases` seed entries (joined
// with clients + senders + recipients + shipments + support_users) into the
// canonical `v_support_case_directory` view shape
// (supabase/migrations/202604302400_v_support_case_directory.sql).
//
// Closes the SUPPORT surface-bind gaps:
//   - client_label / client_slug / sender_label / sender_brand_label /
//     assignee_label (canonical foreign joins).
//   - recipient_label / recipient_phone / shipment_tracking_number
//     (polymorphic resource resolutions; canonical schema uses
//     `(resource_type, resource_id)` pair, FE keeps typed alias shadows
//     `recipient_id` / `related_shipment_id`).
//   - last_message_at / message_count / sla_breached (projected from
//     v_support_case_summary baseline; B3 W3-2 closure).
//   - age_seconds / age_hours (now()-aware derivation, deterministic at read).
//   - is_open / is_terminal / resolution_label (status booleans + chip target).
//
// In live mode this projection is unused — the live branch reads directly
// from `v_support_case_directory`. The seed projection mirrors the live SQL
// view shape so module call sites stay stable across the cutover.
function _projectSupportCaseDirectory(): ResourceRow[] {
  const cases = ((seed as Record<string, unknown>).support_cases ?? []) as Array<{
    id: string;
    organization_id?: string;
    client_id?: string | null;
    sender_id?: string | null;
    recipient_id?: string | null;
    related_shipment_id?: string | null;
    resource_type?: string | null;
    resource_id?: string | null;
    status?: string;
    status_reason?: string | null;
    priority?: string;
    subject?: string | null;
    channel?: string | null;
    tags?: string[];
    assigned_to?: string | null;
    assigned_at?: string | null;
    sla_minutes?: number | null;
    sla_due_at?: string | null;
    opened_at?: string | null;
    resolved_at?: string | null;
    closed_at?: string | null;
    idempotency_key?: string | null;
    version?: number;
    metadata?: Record<string, unknown>;
    created_at?: string | null;
    updated_at?: string | null;
    last_message_at?: string | null;
    message_count?: number;
    sla_breached?: boolean;
  }>;
  const clients = ((seed as Record<string, unknown>).clients ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;
  const senders = ((seed as Record<string, unknown>).senders ?? []) as Array<{
    id: string;
    name?: string;
    brand_name?: string;
  }>;
  const recipients = ((seed as Record<string, unknown>).recipients ?? []) as Array<{
    id: string;
    name?: string;
    phone_number?: string;
  }>;
  const shipments = ((seed as Record<string, unknown>).shipments ?? []) as Array<{
    id: string;
    tracking_number?: string;
  }>;
  const supportUsers = ((seed as Record<string, unknown>).support_users ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const messages = ((seed as Record<string, unknown>).support_messages ?? []) as Array<{
    support_case_id?: string;
    sent_at?: string;
    created_at?: string;
  }>;

  const clientById = new Map<string, (typeof clients)[number]>();
  for (const c of clients) clientById.set(c.id, c);
  const senderById = new Map<string, (typeof senders)[number]>();
  for (const s of senders) senderById.set(s.id, s);
  const recipientById = new Map<string, (typeof recipients)[number]>();
  for (const r of recipients) recipientById.set(r.id, r);
  const shipmentById = new Map<string, (typeof shipments)[number]>();
  for (const sh of shipments) shipmentById.set(sh.id, sh);
  const userById = new Map<string, (typeof supportUsers)[number]>();
  for (const u of supportUsers) userById.set(u.id, u);

  // Derive last_message_at / message_count from canonical messages when the
  // seed row didn't pre-compute them (matches the live v_support_case_summary
  // LATERAL aggregate). Seed pre-computed values still win to preserve the
  // existing demo SLA breach scenarios.
  const lastMsgAtByCase = new Map<string, string>();
  const msgCountByCase = new Map<string, number>();
  for (const m of messages) {
    if (!m.support_case_id) continue;
    msgCountByCase.set(
      m.support_case_id,
      (msgCountByCase.get(m.support_case_id) ?? 0) + 1,
    );
    const at = m.sent_at ?? m.created_at;
    if (at) {
      const prior = lastMsgAtByCase.get(m.support_case_id);
      if (!prior || at > prior) lastMsgAtByCase.set(m.support_case_id, at);
    }
  }

  const TERMINAL_STATUSES = new Set(['resolved', 'closed', 'canceled']);
  const OPEN_STATUSES = new Set(['open', 'in_progress']);

  const now = Date.now();
  return cases.map((sc) => {
    const status = sc.status ?? 'open';
    const isTerminal = TERMINAL_STATUSES.has(status);
    const isOpen = OPEN_STATUSES.has(status);
    // Polymorphic resource pair derivation: prefer canonical
    // (resource_type, resource_id) when set; fall back to the legacy FE
    // alias shadows so seed rows that haven't migrated yet still project.
    let resourceType: string | null = sc.resource_type ?? null;
    let resourceId: string | null = sc.resource_id ?? null;
    if (!resourceType && !resourceId) {
      if (sc.recipient_id) {
        resourceType = 'recipient';
        resourceId = sc.recipient_id;
      } else if (sc.related_shipment_id) {
        resourceType = 'shipment';
        resourceId = sc.related_shipment_id;
      }
    }
    const recipientId =
      resourceType === 'recipient' ? resourceId : sc.recipient_id ?? null;
    const relatedShipmentId =
      resourceType === 'shipment' ? resourceId : sc.related_shipment_id ?? null;
    const recipient = recipientId ? recipientById.get(recipientId) : undefined;
    const shipment = relatedShipmentId ? shipmentById.get(relatedShipmentId) : undefined;
    const client = sc.client_id ? clientById.get(sc.client_id) : undefined;
    const sender = sc.sender_id ? senderById.get(sc.sender_id) : undefined;
    const assignee = sc.assigned_to ? userById.get(sc.assigned_to) : undefined;

    const openedAt = sc.opened_at ?? sc.created_at ?? null;
    const openedMs = openedAt ? Date.parse(openedAt) : NaN;
    const ageSeconds = Number.isFinite(openedMs)
      ? Math.max(0, Math.floor((now - openedMs) / 1000))
      : 0;
    const ageHours = Math.floor(ageSeconds / 3600);

    const resolutionLabel = (() => {
      if (sc.status_reason && sc.status_reason.trim() !== '') return sc.status_reason;
      if (isTerminal) return status;
      return null;
    })();

    return {
      id: sc.id,
      organization_id: sc.organization_id ?? null,
      client_id: sc.client_id ?? null,
      sender_id: sc.sender_id ?? null,
      resource_type: resourceType,
      resource_id: resourceId,
      recipient_id: recipientId,
      related_shipment_id: relatedShipmentId,
      status,
      status_reason: sc.status_reason ?? null,
      priority: sc.priority ?? 'medium',
      subject: sc.subject ?? null,
      channel: sc.channel ?? null,
      tags: Array.isArray(sc.tags) ? sc.tags : [],
      assigned_to: sc.assigned_to ?? null,
      assigned_at: sc.assigned_at ?? null,
      sla_minutes: sc.sla_minutes ?? null,
      sla_due_at: sc.sla_due_at ?? null,
      opened_at: openedAt,
      resolved_at: sc.resolved_at ?? null,
      closed_at: sc.closed_at ?? null,
      idempotency_key: sc.idempotency_key ?? null,
      version: sc.version ?? 1,
      metadata: sc.metadata ?? {},
      created_at: sc.created_at ?? null,
      updated_at: sc.updated_at ?? null,
      // Derived joins
      client_label: client?.name ?? null,
      client_slug: client?.slug ?? null,
      sender_label: sender?.name ?? null,
      sender_brand_label: sender?.brand_name ?? null,
      recipient_label: recipient?.name ?? null,
      recipient_phone: recipient?.phone_number ?? null,
      shipment_tracking_number: shipment?.tracking_number ?? null,
      assignee_label: assignee?.name ?? null,
      // Computed fields from v_support_case_summary baseline
      last_message_at: sc.last_message_at ?? lastMsgAtByCase.get(sc.id) ?? null,
      message_count:
        typeof sc.message_count === 'number'
          ? sc.message_count
          : msgCountByCase.get(sc.id) ?? 0,
      sla_breached: typeof sc.sla_breached === 'boolean' ? sc.sla_breached : false,
      // Age derivations
      age_seconds: ageSeconds,
      age_hours: ageHours,
      // Status booleans
      is_open: isOpen,
      is_terminal: isTerminal,
      resolution_label: resolutionLabel,
    } as ResourceRow;
  });
}

// W26 — Project the existing support.js `support_messages` seed entries
// (joined with support_users) into the canonical `v_support_message_directory`
// view shape (supabase/migrations/202604302410_v_support_message_directory.sql).
//
// Closes the SUPPORT message-side surface-bind:
//   - sent_at / author_user_id (FE alias shadows for canonical created_at /
//     actor_user_id).
//   - author_role enum derivation (operator/customer/system from direction +
//     actor; mirrors the SQL view's CASE expression).
//   - author_label resolution (users.full_name OR actor_system OR 'system').
//   - has_artifact convenience flag.
//
// The FE seed already carries `author_role` + `author_name` precomputed (the
// projection preserves those values and only fills derived fields when they're
// missing on the row). In live mode this projection is unused — the live
// branch reads directly from `v_support_message_directory`.
function _projectSupportMessageDirectory(): ResourceRow[] {
  const messages = ((seed as Record<string, unknown>).support_messages ?? []) as Array<{
    id: string;
    support_case_id?: string;
    organization_id?: string;
    direction?: string;
    channel?: string;
    actor_user_id?: string | null;
    author_user_id?: string | null;
    actor_system?: string | null;
    author_role?: string;
    author_name?: string;
    body?: string;
    artifact_id?: string | null;
    attachments?: Array<{ id: string; name: string; href?: string }>;
    metadata?: Record<string, unknown>;
    created_at?: string | null;
    sent_at?: string | null;
  }>;
  const supportUsers = ((seed as Record<string, unknown>).support_users ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const userById = new Map<string, (typeof supportUsers)[number]>();
  for (const u of supportUsers) userById.set(u.id, u);

  return messages.map((m) => {
    const direction = m.direction ?? 'inbound';
    const actorUserId = m.actor_user_id ?? m.author_user_id ?? null;
    const actorSystem = m.actor_system ?? null;
    // Author role derivation matches the SQL view's CASE expression.
    const authorRole = (() => {
      if (m.author_role) return m.author_role;
      if (direction === 'outbound' && actorUserId) return 'operator';
      if (direction === 'inbound') return 'customer';
      if (direction === 'internal') return 'system';
      if (!actorUserId && actorSystem) return 'system';
      return 'system';
    })();
    const user = actorUserId ? userById.get(actorUserId) : undefined;
    const authorLabel = m.author_name ?? user?.name ?? actorSystem ?? 'system';
    const sentAt = m.sent_at ?? m.created_at ?? null;
    const hasArtifact =
      m.artifact_id != null ||
      (Array.isArray(m.attachments) && m.attachments.length > 0);

    return {
      id: m.id,
      support_case_id: m.support_case_id ?? null,
      organization_id: m.organization_id ?? null,
      direction,
      channel: m.channel ?? null,
      actor_user_id: actorUserId,
      actor_system: actorSystem,
      body: m.body ?? null,
      artifact_id: m.artifact_id ?? null,
      metadata: m.metadata ?? {},
      created_at: m.created_at ?? sentAt,
      // FE alias shadows
      sent_at: sentAt,
      author_user_id: actorUserId,
      // Derived
      author_role: authorRole,
      author_label: authorLabel,
      has_artifact: hasArtifact,
    } as ResourceRow;
  });
}

// W27 integration directory seed projections live in ./data-source/integration-directory-projections.
// W27 — Project the existing integrations.js `integration_plugins` seed
// entries (joined with integration_plugin_versions + bindings) into the
// canonical `v_integration_plugin_directory` view shape
// (supabase/migrations/202604302540_v_integration_plugin_directory.sql).
//
// Closes the INTEGRATIONS catalog-side surface-bind:
//   - vendor (jsonb-path projection from metadata.vendor; closes W18-4 §7
//     deferral with a canonical column shadow).
//   - version_label (active version's `v{version_no}` display string).
//   - version_count + latest_version_no + latest_version_status.
//   - active_version_status (from active_version_id row).
//   - binding_count + active_binding_count + install_count alias.
//   - has_active_version + is_pending_review (status booleans).
//
// The seed currently uses string `version` (e.g. 'v3.4.1') while canonical
// schema is `version_no INTEGER`. The projection emits the seed's `version`
// string when it parses to a meaningful label; otherwise it falls back to
// `v{count}` per the canonical convention.
function _projectIntegrationPluginDirectory(): ResourceRow[] {
  const plugins = ((seed as Record<string, unknown>).integration_plugins ?? []) as Array<{
    id: string;
    organization_id?: string;
    plugin_key?: string;
    name?: string;
    description?: string | null;
    plugin_kind?: string;
    status?: string;
    rollout_tier?: string;
    reusable_within_tenant?: boolean;
    base_plugin_id?: string | null;
    active_version_id?: string | null;
    managed_by?: string;
    metadata?: Record<string, unknown>;
    created_by?: string | null;
    updated_by?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    // Seed-only legacy field; preserved as the source for `vendor` when
    // metadata.vendor is absent (closes W18-4 §7 read-side parity).
    vendor?: string;
    version?: string;
  }>;
  const versions = ((seed as Record<string, unknown>).integration_plugin_versions ?? []) as Array<{
    id: string;
    plugin_id?: string;
    version_no?: number;
    version?: string;
    status?: string;
    created_at?: string;
  }>;
  const bindings = ((seed as Record<string, unknown>).integration_plugin_bindings ?? []) as Array<{
    plugin_version_id?: string;
    enabled?: boolean;
  }>;

  const versionsByPlugin = new Map<string, Array<(typeof versions)[number]>>();
  for (const v of versions) {
    if (!v.plugin_id) continue;
    const arr = versionsByPlugin.get(v.plugin_id) ?? [];
    arr.push(v);
    versionsByPlugin.set(v.plugin_id, arr);
  }
  const versionById = new Map<string, (typeof versions)[number]>();
  for (const v of versions) versionById.set(v.id, v);

  const bindingCountByVersion = new Map<string, number>();
  const activeBindingCountByVersion = new Map<string, number>();
  for (const b of bindings) {
    if (!b.plugin_version_id) continue;
    bindingCountByVersion.set(
      b.plugin_version_id,
      (bindingCountByVersion.get(b.plugin_version_id) ?? 0) + 1,
    );
    if (b.enabled !== false) {
      activeBindingCountByVersion.set(
        b.plugin_version_id,
        (activeBindingCountByVersion.get(b.plugin_version_id) ?? 0) + 1,
      );
    }
  }

  return plugins.map((p) => {
    const md = (p.metadata ?? {}) as Record<string, unknown>;
    const vendorFromMetadata = typeof md.vendor === 'string' ? (md.vendor as string) : null;
    const vendor = vendorFromMetadata ?? p.vendor ?? null;

    const pluginVersions = versionsByPlugin.get(p.id) ?? [];
    const activeVersion = p.active_version_id ? versionById.get(p.active_version_id) : undefined;
    const versionLabel = (() => {
      if (activeVersion?.version) return activeVersion.version;
      if (typeof activeVersion?.version_no === 'number') return 'v' + activeVersion.version_no;
      // Fallback: when seed only has the plugin's own `version` string
      // (legacy shape), surface that on the active label.
      if (p.active_version_id && p.version) return p.version;
      return null;
    })();
    // Sort by version_no DESC then created_at DESC to find latest.
    const sortedVersions = [...pluginVersions].sort((a, b) => {
      const an = typeof a.version_no === 'number' ? a.version_no : 0;
      const bn = typeof b.version_no === 'number' ? b.version_no : 0;
      if (bn !== an) return bn - an;
      const at = a.created_at ?? '';
      const bt = b.created_at ?? '';
      return bt.localeCompare(at);
    });
    const latestVersion = sortedVersions[0];
    const latestVersionNo = (() => {
      if (typeof latestVersion?.version_no === 'number') return latestVersion.version_no;
      return null;
    })();
    const latestVersionStatus = latestVersion?.status ?? null;

    let bindingCount = 0;
    let activeBindingCount = 0;
    for (const v of pluginVersions) {
      bindingCount += bindingCountByVersion.get(v.id) ?? 0;
      activeBindingCount += activeBindingCountByVersion.get(v.id) ?? 0;
    }

    const isPendingReview =
      latestVersionStatus === 'draft' || latestVersionStatus === 'submitted';

    return {
      id: p.id,
      organization_id: p.organization_id ?? null,
      plugin_key: p.plugin_key ?? null,
      name: p.name ?? null,
      description: p.description ?? null,
      plugin_kind: p.plugin_kind ?? null,
      status: p.status ?? null,
      rollout_tier: p.rollout_tier ?? null,
      reusable_within_tenant: p.reusable_within_tenant ?? null,
      base_plugin_id: p.base_plugin_id ?? null,
      active_version_id: p.active_version_id ?? null,
      managed_by: p.managed_by ?? null,
      metadata: md,
      created_by: p.created_by ?? null,
      updated_by: p.updated_by ?? null,
      created_at: p.created_at ?? null,
      updated_at: p.updated_at ?? null,
      // Derived jsonb-path projection
      vendor,
      // Version metadata
      version_label: versionLabel,
      active_version_status: activeVersion?.status ?? null,
      version_count: pluginVersions.length,
      latest_version_no: latestVersionNo,
      latest_version_status: latestVersionStatus,
      // Binding usage counters
      binding_count: bindingCount,
      install_count: bindingCount,
      active_binding_count: activeBindingCount,
      // Status flags
      has_active_version: p.active_version_id != null,
      is_pending_review: isPendingReview,
    } as ResourceRow;
  });
}

// W11-3 / W6-6 — Project the existing platform-flags.js `feature_flags` seed
// entries into the canonical `v_feature_flag_summary` view shape
// (supabase/migrations/202604300100_v_feature_flag_summary.sql). The seed
// entries already carry every projected field inline so this is a typed
// pass-through. In live mode (getSupabaseClient() set) this projection is
// unused — the live branch reads directly from `v_feature_flag_summary`.
function _projectFeatureFlagSummary(): ResourceRow[] {
  const flags = ((seed as Record<string, unknown>).feature_flags ?? []) as Array<
    Record<string, unknown>
  >;
  return flags.map((f) => {
    const id = (f.id as string | undefined) ?? '';
    const name = (f.key as string | undefined) ?? '';
    return {
      id,
      key: name,
      label: (f.label as string | undefined) ?? name,
      description: (f.description as string | undefined) ?? null,
      status: (f.status as string | undefined) ?? 'off',
      rollout_percentage:
        typeof f.rollout_percentage === 'number' ? f.rollout_percentage : 0,
      targeting: (f.targeting as Record<string, unknown> | undefined) ?? {
        summary: 'no overrides',
        scopes: [],
      },
      scope_type: (f.scope_type as string | undefined) ?? 'global',
      scope_id: (f.scope_id as string | undefined) ?? 'global',
      kill_switch: typeof f.kill_switch === 'boolean' ? f.kill_switch : false,
      owners: Array.isArray(f.owners) ? f.owners : [],
      last_updated_at: (f.last_updated_at as string | undefined) ?? null,
      last_updated_by_user_id:
        (f.last_updated_by_user_id as string | undefined) ?? null,
      created_at: (f.created_at as string | undefined) ?? null,
      updated_at: (f.last_updated_at as string | undefined) ?? null,
    } as ResourceRow;
  });
}

// W11-3 — Project the existing warehouse.js `warehouse_transfers` seed
// entries into the canonical `v_warehouse_transfer_summary` view shape
// (supabase/migrations/202604301500_v_warehouse_transfer_summary.sql). The
// seed entries already carry the FE-shaped aggregate fields inline; the
// projection synthesizes the canonical column names (transfer_code/
// from_branch_id/to_branch_id) plus `variance_count` and `posted_at` so
// callers binding to either alias stay stable across the cutover. In live
// mode this projection is unused — the live branch reads directly from
// `v_warehouse_transfer_summary`. Mirrors the SQL view's variance semantics:
// `variance_flag` only fires for post-arrival statuses
// (received/reconciled/on_hold).
function _projectWarehouseTransferSummary(): ResourceRow[] {
  const transfers = ((seed as Record<string, unknown>).warehouse_transfers ?? []) as Array<
    Record<string, unknown>
  >;
  return transfers.map((t) => {
    const itemCount = typeof t.item_count === 'number' ? (t.item_count as number) : 0;
    const receivedCount =
      typeof t.received_count === 'number' ? (t.received_count as number) : 0;
    const status = (t.status as string | undefined) ?? '';
    const computedVarianceFlag =
      itemCount > receivedCount &&
      ['received', 'reconciled', 'on_hold'].includes(status);
    const updatedAt = (t.updated_at as string | undefined) ?? null;
    return {
      id: (t.id as string | undefined) ?? '',
      organization_id: (t.organization_id as string | undefined) ?? null,
      transfer_code:
        (t.transfer_code as string | undefined) ??
        (t.transfer_id as string | undefined) ??
        null,
      transfer_id:
        (t.transfer_id as string | undefined) ??
        (t.transfer_code as string | undefined) ??
        null,
      from_branch_id:
        (t.from_branch_id as string | undefined) ??
        (t.origin_hub as string | undefined) ??
        null,
      to_branch_id:
        (t.to_branch_id as string | undefined) ??
        (t.destination_hub as string | undefined) ??
        null,
      origin_hub:
        (t.origin_hub as string | undefined) ??
        (t.from_branch_id as string | undefined) ??
        null,
      destination_hub:
        (t.destination_hub as string | undefined) ??
        (t.to_branch_id as string | undefined) ??
        null,
      status,
      dispatched_at: (t.dispatched_at as string | undefined) ?? null,
      received_at: (t.received_at as string | undefined) ?? null,
      // Mirror SQL view: COALESCE(received_at, dispatched_at). Planned/draft
      // transfers (no dispatch yet) project posted_at = NULL.
      posted_at:
        (t.posted_at as string | undefined) ??
        (t.received_at as string | undefined) ??
        (t.dispatched_at as string | undefined) ??
        null,
      item_count: itemCount,
      received_count: receivedCount,
      variance_count:
        typeof t.variance_count === 'number'
          ? (t.variance_count as number)
          : Math.max(itemCount - receivedCount, 0),
      variance_flag:
        typeof t.variance_flag === 'boolean'
          ? (t.variance_flag as boolean)
          : computedVarianceFlag,
      hold_reason: (t.hold_reason as string | undefined) ?? null,
      created_at: (t.created_at as string | undefined) ?? null,
      updated_at: updatedAt,
    } as ResourceRow;
  });
}

// W28 — Project the existing platform-alerts.js `alert_rules` + `alert_triggers`
// seed entries into the canonical `v_alert_rule_directory` view shape
// (supabase/migrations/202604302600_v_alert_rule_directory.sql). The seed
// entries carry the legacy FE shape (`name` / `condition` / `severity` /
// `channel`) which the projection rewrites into canonical column names plus
// derived counters (last_triggered_at / trigger_count_24h / ack_count_24h /
// resolved_count_24h / is_throttled / is_paused) and label rollups
// (severity_label, created_by_label, condition_summary, alert_channels_count).
// In live mode this projection is unused — the live branch reads directly
// from `v_alert_rule_directory`.
function _projectAlertRuleDirectory(): ResourceRow[] {
  const rules = ((seed as Record<string, unknown>).alert_rules ?? []) as Array<{
    id: string;
    organization_id?: string;
    name?: string;
    rule_name?: string;
    condition?: Record<string, unknown> | null;
    trigger_conditions?: Record<string, unknown> | null;
    severity?: string;
    channel?: string;
    alert_channels?: string[];
    enabled?: boolean;
    priority?: number;
    trigger_source?: string;
    throttle_window_minutes?: number;
    created_by?: string;
    created_at?: string;
    updated_at?: string;
  }>;
  const triggers = ((seed as Record<string, unknown>).alert_triggers ?? []) as Array<{
    rule_id?: string;
    fired_at?: string;
    status?: string;
    payload?: Record<string, unknown>;
  }>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<{
    id: string;
    full_name?: string;
    email?: string;
  }>;
  const userById = new Map(users.map((u) => [u.id, u]));

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const aggByRule = new Map<
    string,
    { last: number | null; count24h: number; ack24h: number; resolved24h: number }
  >();
  for (const t of triggers) {
    const rid = t.rule_id;
    if (!rid) continue;
    const ts = t.fired_at ? Date.parse(t.fired_at) : NaN;
    if (Number.isNaN(ts)) continue;
    const cur = aggByRule.get(rid) ?? {
      last: null,
      count24h: 0,
      ack24h: 0,
      resolved24h: 0,
    };
    if (cur.last === null || ts > cur.last) cur.last = ts;
    if (now - ts <= day) {
      cur.count24h += 1;
      if (t.status === 'acknowledged') cur.ack24h += 1;
      if (t.status === 'resolved') cur.resolved24h += 1;
    }
    aggByRule.set(rid, cur);
  }

  const summarizeFlat = (c: Record<string, unknown> | null | undefined): string => {
    if (!c || Object.keys(c).length === 0) return '— always —';
    const entries = Object.entries(c);
    const allFlat = entries.every(
      ([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
    );
    if (!allFlat) return 'complex';
    return entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k} = ${String(v)}`)
      .join(' AND ');
  };

  return rules.map((r) => {
    const channels = Array.isArray(r.alert_channels)
      ? r.alert_channels
      : r.channel
        ? [r.channel]
        : [];
    const trigCond = (r.trigger_conditions ?? r.condition ?? null) as
      | Record<string, unknown>
      | null;
    const agg = aggByRule.get(r.id);
    const lastTriggeredAt = agg?.last ? new Date(agg.last).toISOString() : null;
    const throttleMinutes = typeof r.throttle_window_minutes === 'number'
      ? r.throttle_window_minutes
      : 15;
    const isThrottled =
      agg?.last !== undefined &&
      agg?.last !== null &&
      now - agg.last <= throttleMinutes * 60 * 1000;
    const enabled = r.enabled !== false;
    const owner = r.created_by ? userById.get(r.created_by) : undefined;
    return {
      id: r.id,
      organization_id: r.organization_id ?? null,
      rule_name: r.rule_name ?? r.name ?? '',
      enabled,
      priority: typeof r.priority === 'number' ? r.priority : 0,
      trigger_source: r.trigger_source ?? null,
      trigger_conditions: trigCond,
      throttle_window_minutes: throttleMinutes,
      throttle_key_fields: null,
      alert_severity_lookup_id: null,
      alert_channels: channels,
      message_template_id: null,
      message_variables: null,
      created_by: r.created_by ?? null,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
      severity_label: r.severity ?? null,
      created_by_label: owner?.full_name ?? null,
      created_by_email: owner?.email ?? null,
      condition_summary: summarizeFlat(trigCond),
      alert_channels_count: channels.length,
      last_triggered_at: lastTriggeredAt,
      trigger_count_24h: agg?.count24h ?? 0,
      ack_count_24h: agg?.ack24h ?? 0,
      resolved_count_24h: agg?.resolved24h ?? 0,
      is_throttled: !!isThrottled,
      is_paused: !enabled,
    } as ResourceRow;
  });
}

// W56-B (F5) — Project the existing platform-alerts.js `alert_triggers` seed
// entries into the canonical `v_alert_trigger_summary` view shape
// (supabase/migrations/202604301700_v_alert_trigger_summary.sql). Each row
// surfaces `id`, `rule_id`, `fired_at`, `payload`, `status` plus joined
// `severity` / `message` / `acknowledged_at` for the Recent triggers + Active
// alerts panes consumed by `useResourceList<>('alert_trigger_summary')` in
// platform/alerts.tsx. Closes the registry/RESOURCE_DATA gap (the registry
// declared the resource but RESOURCE_DATA had no entry, breaking ladder
// resolution). Mirrors the W11/W18/W20-…/W28 paired-projection pattern.
function _projectAlertTriggerSummary(): ResourceRow[] {
  const triggers = ((seed as Record<string, unknown>).alert_triggers ?? []) as Array<{
    id?: string;
    rule_id?: string;
    fired_at?: string;
    payload?: Record<string, unknown>;
    status?: string;
    severity?: string;
    message?: string;
    acknowledged_at?: string;
    resolution_notes?: string;
  }>;
  const rules = ((seed as Record<string, unknown>).alert_rules ?? []) as Array<{
    id?: string;
    severity?: string;
  }>;
  const ruleSeverityById = new Map(
    rules
      .filter((r) => typeof r.id === 'string')
      .map((r) => [r.id as string, (r.severity as string | undefined) ?? null]),
  );
  return triggers.map((t) => {
    const ruleSeverity = (t.rule_id ? ruleSeverityById.get(t.rule_id) : null) ?? null;
    return {
      id: t.id ?? null,
      rule_id: t.rule_id ?? null,
      fired_at: t.fired_at ?? null,
      payload: (t.payload ?? null) as Record<string, unknown> | null,
      status: t.status ?? 'fired',
      severity: t.severity ?? ruleSeverity,
      message: t.message ?? null,
      acknowledged_at: t.acknowledged_at ?? null,
      resolution_notes: t.resolution_notes ?? null,
    } as ResourceRow;
  });
}

// W28 — Project the existing labels.js `label_template_specs` + `label_jobs`
// seed entries into the canonical `v_label_template_directory` view shape
// (supabase/migrations/202604302610_v_label_template_directory.sql). The seed
// entries carry the legacy FE shape (top-level `name` / `dimensions` / `dpi`
// / `barcode_format`) so the projection rewrites them into canonical column
// names (`template_key`) and renderer_config jsonb-path projections (closing
// the W10-5 §8 REMOVE deferral) plus job-lifecycle aggregates.
function _projectLabelTemplateDirectory(): ResourceRow[] {
  const specs = ((seed as Record<string, unknown>).label_template_specs ?? []) as Array<{
    id: string;
    organization_id?: string;
    name?: string;
    template_key?: string;
    version?: number;
    template_scope_type?: string;
    template_scope_id?: string;
    dimensions?: string;
    dpi?: number;
    barcode_format?: string;
    renderer_config?: Record<string, unknown>;
    asset_refs?: unknown[];
    created_by?: string;
    created_at?: string;
  }>;
  const jobs = ((seed as Record<string, unknown>).label_jobs ?? []) as Array<{
    id: string;
    spec_id?: string;
    template_id?: string;
    status?: string;
    queued_at?: string;
    scheduled_at?: string;
  }>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<{
    id: string;
    full_name?: string;
    email?: string;
  }>;
  const orgs = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;
  const userById = new Map(users.map((u) => [u.id, u]));
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const jobAggByTemplate = new Map<
    string,
    {
      render_count: number;
      render_count_24h: number;
      last_used_at: number | null;
      completed_count: number;
      failed_count: number;
    }
  >();
  for (const j of jobs) {
    const tid = j.template_id ?? j.spec_id;
    if (!tid) continue;
    const scheduled = j.scheduled_at ?? j.queued_at;
    const ts = scheduled ? Date.parse(scheduled) : NaN;
    const cur = jobAggByTemplate.get(tid) ?? {
      render_count: 0,
      render_count_24h: 0,
      last_used_at: null,
      completed_count: 0,
      failed_count: 0,
    };
    cur.render_count += 1;
    if (!Number.isNaN(ts)) {
      if (now - ts <= day) cur.render_count_24h += 1;
      if (cur.last_used_at === null || ts > cur.last_used_at) cur.last_used_at = ts;
    }
    if (j.status === 'completed' || j.status === 'succeeded') cur.completed_count += 1;
    if (j.status === 'failed') cur.failed_count += 1;
    jobAggByTemplate.set(tid, cur);
  }

  // Group templates by (organization_id, template_key) to compute version_count
  // + max_version (mirrors the SQL view's version_agg CTE).
  const versionAgg = new Map<
    string,
    { version_count: number; max_version: number }
  >();
  for (const s of specs) {
    const key = `${s.organization_id ?? ''}:${s.template_key ?? s.name ?? ''}`;
    const cur = versionAgg.get(key) ?? { version_count: 0, max_version: 0 };
    cur.version_count += 1;
    const v = typeof s.version === 'number' ? s.version : 1;
    if (v > cur.max_version) cur.max_version = v;
    versionAgg.set(key, cur);
  }

  return specs.map((s) => {
    const rc = (s.renderer_config ?? {}) as Record<string, unknown>;
    const dimensions =
      typeof rc.dimensions === 'string'
        ? (rc.dimensions as string)
        : (s.dimensions ?? null);
    const dpiRaw = rc.dpi;
    const dpi =
      typeof dpiRaw === 'number'
        ? dpiRaw
        : typeof dpiRaw === 'string' && dpiRaw !== ''
          ? Number.parseInt(dpiRaw, 10)
          : (s.dpi ?? null);
    const barcodeFormat =
      typeof rc.barcode_format === 'string'
        ? (rc.barcode_format as string)
        : (s.barcode_format ?? null);
    const activeVersionId =
      typeof rc.active_version_id === 'string' ? (rc.active_version_id as string) : null;
    const owner = s.created_by ? userById.get(s.created_by) : undefined;
    const org = s.organization_id ? orgById.get(s.organization_id) : undefined;
    const agg = jobAggByTemplate.get(s.id);
    const versionKey = `${s.organization_id ?? ''}:${s.template_key ?? s.name ?? ''}`;
    const va = versionAgg.get(versionKey) ?? { version_count: 1, max_version: 1 };
    const ver = typeof s.version === 'number' ? s.version : 1;
    return {
      id: s.id,
      organization_id: s.organization_id ?? null,
      template_key: s.template_key ?? s.name ?? '',
      version: ver,
      template_scope_type: s.template_scope_type ?? 'tenant',
      template_scope_id: s.template_scope_id ?? null,
      renderer_config: rc,
      asset_refs: Array.isArray(s.asset_refs) ? s.asset_refs : [],
      created_by: s.created_by ?? null,
      created_at: s.created_at ?? null,
      dimensions,
      dpi: typeof dpi === 'number' && !Number.isNaN(dpi) ? dpi : null,
      barcode_format: barcodeFormat,
      active_version_id: activeVersionId,
      tenant_label: org?.name ?? null,
      tenant_slug: org?.slug ?? null,
      created_by_label: owner?.full_name ?? null,
      created_by_email: owner?.email ?? null,
      render_count: agg?.render_count ?? 0,
      render_count_24h: agg?.render_count_24h ?? 0,
      last_used_at: agg?.last_used_at ? new Date(agg.last_used_at).toISOString() : null,
      completed_count: agg?.completed_count ?? 0,
      failed_count: agg?.failed_count ?? 0,
      version_count: va.version_count,
      is_active_version: ver === va.max_version,
      asset_count: Array.isArray(s.asset_refs) ? s.asset_refs.length : 0,
    } as ResourceRow;
  });
}

// W28 — Project the existing imports.js `import_jobs` seed entries into the
// canonical `v_import_job_directory` view shape
// (supabase/migrations/202604302620_v_import_job_directory.sql). The seed
// entries already mirror the canonical column shape 1:1; the projection adds
// derived label rollups (tenant_label / submitted_by_label / submitted_by_email),
// NULL-safe numeric defaults (row_count_value / error_count_value), lifecycle
// flags (is_terminal / is_active / is_failed / has_errors), and timing
// aggregates (duration_seconds / queue_wait_seconds / age_seconds /
// error_summary_count).
function _projectImportJobDirectory(): ResourceRow[] {
  const jobs = ((seed as Record<string, unknown>).import_jobs ?? []) as Array<{
    id: string;
    organization_id?: string;
    kind?: string;
    source?: string;
    status?: string;
    submitted_at?: string;
    started_at?: string | null;
    completed_at?: string | null;
    submitted_by_user_id?: string | null;
    row_count?: number | null;
    error_count?: number | null;
    error_summary?: Record<string, unknown> | null;
    correlation_id?: string | null;
    cancelled_reason?: string | null;
    created_at?: string;
    updated_at?: string;
  }>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<{
    id: string;
    full_name?: string;
    email?: string;
  }>;
  const orgs = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;
  const userById = new Map(users.map((u) => [u.id, u]));
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  const now = Date.now();

  return jobs.map((j) => {
    const rowCount = typeof j.row_count === 'number' ? j.row_count : 0;
    const errorCount = typeof j.error_count === 'number' ? j.error_count : 0;
    const submittedAt = j.submitted_at ? Date.parse(j.submitted_at) : NaN;
    const startedAt = j.started_at ? Date.parse(j.started_at) : NaN;
    const completedAt = j.completed_at ? Date.parse(j.completed_at) : NaN;
    const isTerminal = ['completed', 'failed', 'cancelled'].includes(j.status ?? '');
    const isActive = ['queued', 'running'].includes(j.status ?? '');
    const isFailed = j.status === 'failed';
    const hasErrors = errorCount > 0;
    const durationSeconds =
      !Number.isNaN(startedAt) && !Number.isNaN(completedAt)
        ? (completedAt - startedAt) / 1000
        : null;
    const queueWaitSeconds =
      !Number.isNaN(submittedAt) && !Number.isNaN(startedAt)
        ? (startedAt - submittedAt) / 1000
        : null;
    const ageSeconds = !Number.isNaN(submittedAt) ? (now - submittedAt) / 1000 : 0;
    const errorSummary = (j.error_summary ?? {}) as Record<string, unknown>;
    const errors = (errorSummary['errors'] ?? errorSummary['sample_errors']) as
      | unknown[]
      | undefined;
    const errorSummaryCount = Array.isArray(errors) ? errors.length : 0;
    const owner = j.submitted_by_user_id ? userById.get(j.submitted_by_user_id) : undefined;
    const org = j.organization_id ? orgById.get(j.organization_id) : undefined;
    return {
      id: j.id,
      organization_id: j.organization_id ?? null,
      kind: j.kind ?? '',
      source: j.source ?? 'file_upload',
      status: j.status ?? 'queued',
      submitted_at: j.submitted_at ?? null,
      started_at: j.started_at ?? null,
      completed_at: j.completed_at ?? null,
      submitted_by_user_id: j.submitted_by_user_id ?? null,
      row_count: typeof j.row_count === 'number' ? j.row_count : null,
      error_count: typeof j.error_count === 'number' ? j.error_count : null,
      error_summary: errorSummary,
      correlation_id: j.correlation_id ?? null,
      cancelled_reason: j.cancelled_reason ?? null,
      created_at: j.created_at ?? null,
      updated_at: j.updated_at ?? null,
      tenant_label: org?.name ?? null,
      tenant_slug: org?.slug ?? null,
      submitted_by_label: owner?.full_name ?? null,
      submitted_by_email: owner?.email ?? null,
      row_count_value: rowCount,
      error_count_value: errorCount,
      is_terminal: isTerminal,
      is_active: isActive,
      is_failed: isFailed,
      has_errors: hasErrors,
      duration_seconds: durationSeconds,
      queue_wait_seconds: queueWaitSeconds,
      age_seconds: ageSeconds,
      error_summary_count: errorSummaryCount,
    } as ResourceRow;
  });
}

// W23 — Project the existing seed-raw/identity-users.js `users` entries
// (joined with seed-raw/seed.js `organizations` + seed-raw/rbac.js
// `rbac_user_role_assignments` + `rbac_roles`) into the canonical
// `v_user_directory` view shape
// (supabase/migrations/202604302200_v_user_directory.sql).
//
// Closes the W19-3 deferred paired-RPC residual for IDENTITY by exposing
// canonical SSOT columns (organization_id / access_scope_type) AND the
// FE-shaped projection aliases (organization_label, organization_slug,
// access_scope_label, active_role_count, active_role_keys, tier flags)
// on the same projection seam. Production cutover is a single
// getSupabaseClient() branch flip in
// `ui_list_resource_v1('user_directory')` — module call sites stay
// stable.
//
// In live mode this projection is unused — the live branch reads
// directly from `v_user_directory`.
function _projectUserDirectory(): ResourceRow[] {
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<{
    id: string;
    organization_id?: string;
    email?: string;
    full_name?: string;
    user_type?: string;
    status?: string;
    access_scope_type?: string;
    access_scope_id?: string | null;
    created_at?: string;
    last_login_at?: string | null;
  }>;
  const organizations = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;
  const assignments = ((seed as Record<string, unknown>).rbac_user_role_assignments ?? []) as Array<{
    user_id?: string;
    role_id?: string;
    role_key?: string;
    revoked_at?: string | null;
  }>;
  const roles = ((seed as Record<string, unknown>).rbac_roles ?? []) as Array<{
    id: string;
    key?: string;
  }>;

  const orgById = new Map<string, (typeof organizations)[number]>();
  for (const o of organizations) orgById.set(o.id, o);
  const roleById = new Map<string, (typeof roles)[number]>();
  for (const r of roles) roleById.set(r.id, r);

  // Active assignments (revoked_at is null) keyed by user_id.
  const activeRolesByUser = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (!a.user_id || a.revoked_at != null) continue;
    const key = a.role_key ?? roleById.get(a.role_id ?? '')?.key;
    if (!key) continue;
    let set = activeRolesByUser.get(a.user_id);
    if (!set) {
      set = new Set<string>();
      activeRolesByUser.set(a.user_id, set);
    }
    set.add(key);
  }

  return users.map((u) => {
    const org = u.organization_id ? orgById.get(u.organization_id) : undefined;
    const activeKeys = activeRolesByUser.get(u.id) ?? new Set<string>();
    const activeKeyList = Array.from(activeKeys).sort();
    const scopeType = u.access_scope_type ?? null;
    const scopeLabel = scopeType
      ? scopeType.charAt(0).toUpperCase() + scopeType.slice(1)
      : null;
    return {
      id: u.id,
      organization_id: u.organization_id ?? null,
      email: u.email ?? null,
      full_name: u.full_name ?? null,
      user_type: u.user_type ?? null,
      status: u.status ?? null,
      access_scope_type: scopeType,
      access_scope_id: u.access_scope_id ?? null,
      created_at: u.created_at ?? null,
      last_login_at: u.last_login_at ?? null,
      organization_label: org?.name ?? null,
      organization_slug: org?.slug ?? null,
      access_scope_label: scopeLabel,
      active_role_count: activeKeyList.length,
      active_role_keys: activeKeyList,
      is_platform_user: scopeType === 'platform',
      is_tenant_user: scopeType === 'tenant',
      is_client_user: scopeType === 'client',
      is_sender_user: scopeType === 'sender',
    } as ResourceRow;
  });
}

// W39 PLATFORM closure — Project existing seed-raw/mobile.js `user_devices`
// seed entries into the canonical `v_user_device_summary` view shape
// (supabase/migrations/202604303100_v_user_device_summary.sql).
//
// Surfaces canonical user_devices columns + FE alias projections
// (`platform`, `device_id`) + jsonb-projected fields (`model`,
// `attestation_status`, `attestation_trusted_at`) + 4 derived attestation
// state booleans (is_attestation_trusted/pending/failed/revoked) so the
// mobile-policy.tsx DeviceRow consumer can drop the metadata-helper
// bridge once the getSupabaseClient() branch in ui_list_resource_v1
// flips. Production cutover is a single registry branch flip — module
// call sites stay stable.
//
// In live mode this projection is unused — the live branch reads
// directly from `v_user_device_summary`.
function _projectUserDeviceSummary(): ResourceRow[] {
  const devices = ((seed as Record<string, unknown>).user_devices ?? []) as Array<{
    id: string;
    organization_id?: string;
    user_id?: string;
    device_id?: string;
    device_identifier_sha256?: string;
    device_label?: string;
    platform?: string;
    device_platform?: string;
    app_version?: string;
    os_version?: string;
    last_seen_at?: string;
    revoked_at?: string | null;
    revoked_by_user_id?: string | null;
    revoked_reason?: string | null;
    is_revoked?: boolean;
    push_token?: string | null;
    push_token_cleared?: boolean;
    metadata?: Record<string, unknown> | null;
    created_at?: string;
    updated_at?: string;
  }>;
  return devices.map((d) => {
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    const att = (meta['attestation'] ?? null) as Record<string, unknown> | null;
    const status = att && typeof att['status'] === 'string' ? String(att['status']) : null;
    const trustedAt =
      att && typeof att['trusted_at'] === 'string' ? String(att['trusted_at']) : null;
    const model = typeof meta['model'] === 'string' ? String(meta['model']) : null;
    const platform = d.device_platform ?? d.platform ?? null;
    const deviceIdentifier = d.device_identifier_sha256 ?? d.device_id ?? null;
    const lowerStatus = (status ?? '').toLowerCase();
    return {
      id: d.id,
      organization_id: d.organization_id ?? null,
      user_id: d.user_id ?? null,
      device_platform: platform,
      device_identifier_sha256: deviceIdentifier,
      device_label: d.device_label ?? null,
      app_version: d.app_version ?? null,
      os_version: d.os_version ?? null,
      last_seen_at: d.last_seen_at ?? null,
      revoked_at: d.revoked_at ?? null,
      revoked_by_user_id: d.revoked_by_user_id ?? null,
      revoked_reason: d.revoked_reason ?? null,
      is_revoked: d.is_revoked ?? Boolean(d.revoked_at),
      push_token_cleared: d.push_token_cleared ?? (d.push_token == null),
      created_at: d.created_at ?? null,
      updated_at: d.updated_at ?? null,
      // FE alias projections (legacy keys retained for back-compat).
      platform,
      device_id: deviceIdentifier,
      // jsonb-projected fields (matches mobile-policy.tsx FE helper output).
      model,
      attestation_status: status,
      attestation_trusted_at: trustedAt,
      // Derived attestation booleans (mirrors view CASE expressions).
      is_attestation_trusted: lowerStatus === 'trusted',
      is_attestation_pending: lowerStatus === 'pending',
      is_attestation_failed: lowerStatus === 'failed',
      is_attestation_revoked: lowerStatus === 'revoked',
      metadata: d.metadata ?? null,
    } as ResourceRow;
  });
}

// W23 — Project the existing seed-raw/rbac.js `rbac_roles` entries (joined
// with `rbac_role_permissions` + `rbac_user_role_assignments` +
// `organizations`) into the canonical `v_rbac_role_summary` view shape
// (supabase/migrations/202604302210_v_rbac_role_summary.sql).
//
// Surfaces FE-shaped derived counters (permission_count,
// permission_values, assignment_count + active_assignment_count +
// revoked_assignment_count, last_assigned_at, role_tier) without
// duplicating them onto the canonical `rbac_roles` row interface.
// Production cutover is a single getSupabaseClient() branch flip in
// `ui_list_resource_v1('rbac_role_summary')`.
//
// In live mode this projection is unused — the live branch reads
// directly from `v_rbac_role_summary`.
function _projectRbacRoleSummary(): ResourceRow[] {
  const roles = ((seed as Record<string, unknown>).rbac_roles ?? []) as Array<{
    id: string;
    organization_id?: string;
    key?: string;
    name?: string;
    description?: string | null;
    is_active?: boolean;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    permission_count?: number;
    assignment_count?: number;
  }>;
  const rolePermissions = ((seed as Record<string, unknown>).rbac_role_permissions ??
    []) as Array<{
    role_id?: string;
    permission_value?: string;
  }>;
  const assignments = ((seed as Record<string, unknown>).rbac_user_role_assignments ??
    []) as Array<{
    role_id?: string;
    revoked_at?: string | null;
    assigned_at?: string;
  }>;
  const organizations = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
    slug?: string;
  }>;

  const orgById = new Map<string, (typeof organizations)[number]>();
  for (const o of organizations) orgById.set(o.id, o);

  // Permission rollups by role.
  const permsByRole = new Map<string, Set<string>>();
  for (const rp of rolePermissions) {
    if (!rp.role_id || !rp.permission_value) continue;
    let set = permsByRole.get(rp.role_id);
    if (!set) {
      set = new Set<string>();
      permsByRole.set(rp.role_id, set);
    }
    set.add(rp.permission_value);
  }

  // Assignment rollups by role.
  const assignActiveByRole = new Map<string, number>();
  const assignRevokedByRole = new Map<string, number>();
  const lastAssignedByRole = new Map<string, string>();
  for (const a of assignments) {
    if (!a.role_id) continue;
    if (a.revoked_at == null) {
      assignActiveByRole.set(a.role_id, (assignActiveByRole.get(a.role_id) ?? 0) + 1);
    } else {
      assignRevokedByRole.set(a.role_id, (assignRevokedByRole.get(a.role_id) ?? 0) + 1);
    }
    if (a.assigned_at) {
      const prior = lastAssignedByRole.get(a.role_id);
      if (!prior || a.assigned_at > prior) lastAssignedByRole.set(a.role_id, a.assigned_at);
    }
  }

  return roles.map((r) => {
    const org = r.organization_id ? orgById.get(r.organization_id) : undefined;
    const permSet = permsByRole.get(r.id) ?? new Set<string>();
    const permValues = Array.from(permSet).sort();
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const tierRaw = meta['tier'];
    const tier =
      typeof tierRaw === 'string' && tierRaw.length > 0 ? tierRaw : 'functional';
    const activeCount =
      assignActiveByRole.get(r.id) ?? (typeof r.assignment_count === 'number' ? r.assignment_count : 0);
    const revokedCount = assignRevokedByRole.get(r.id) ?? 0;
    return {
      id: r.id,
      organization_id: r.organization_id ?? null,
      key: r.key ?? null,
      name: r.name ?? null,
      description: r.description ?? null,
      is_active: r.is_active ?? true,
      metadata: r.metadata ?? {},
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
      organization_label: org?.name ?? null,
      organization_slug: org?.slug ?? null,
      role_tier: tier,
      permission_count:
        permValues.length > 0
          ? permValues.length
          : typeof r.permission_count === 'number'
            ? r.permission_count
            : 0,
      permission_values: permValues,
      assignment_count: activeCount,
      active_assignment_count: activeCount,
      revoked_assignment_count: revokedCount,
      last_assigned_at: lastAssignedByRole.get(r.id) ?? null,
    } as ResourceRow;
  });
}

// W23 — Project the existing seed-raw/intake.js `tenant_signup_requests`
// entries (joined with seed-raw/identity-users.js `users` for reviewer
// labels + seed-raw/seed.js `organizations` for approved-org labels)
// into the canonical `v_tenant_signup_request_summary` view shape
// (supabase/migrations/202604302220_v_tenant_signup_request_summary.sql).
//
// Surfaces FE-shaped attestation rollups (attestation_count,
// attestation_passed_count, attestation_complete derived BOOLEAN that
// AND-folds turnstile_verified), marketing consent flag, status
// booleans, and decision_age_seconds without duplicating them onto the
// canonical `tenant_signup_requests` row interface. Production cutover
// is a single getSupabaseClient() branch flip in
// `ui_list_resource_v1('tenant_signup_request_summary')`.
//
// In live mode this projection is unused — the live branch reads
// directly from `v_tenant_signup_request_summary`.
function _projectTenantSignupRequestSummary(): ResourceRow[] {
  const requests = ((seed as Record<string, unknown>).tenant_signup_requests ??
    []) as Array<{
    id: string;
    created_at?: string;
    updated_at?: string;
    status?: string;
    review_decision?: string | null;
    email?: string;
    full_name?: string;
    organization_name?: string;
    organization_slug?: string;
    website_url?: string;
    phone?: string;
    notes?: string;
    locale?: string;
    page_url?: string;
    referrer?: string;
    origin?: string;
    marketing?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    ip_hash?: string;
    turnstile_verified?: boolean;
    reviewed_at?: string | null;
    reviewed_by?: string | null;
    reviewed_by_label?: string | null;
    review_reason?: string | null;
    decision_metadata?: Record<string, unknown>;
    approved_organization_id?: string | null;
    approved_user_id?: string | null;
    approved_auth_user_id?: string | null;
    invite_email_sent_at?: string | null;
    invite_redirect_to?: string | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
    last_error_at?: string | null;
  }>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<{
    id: string;
    email?: string;
    full_name?: string;
  }>;
  const organizations = ((seed as Record<string, unknown>).organizations ?? []) as Array<{
    id: string;
    name?: string;
  }>;

  const userById = new Map<string, (typeof users)[number]>();
  for (const u of users) userById.set(u.id, u);
  const orgById = new Map<string, (typeof organizations)[number]>();
  for (const o of organizations) orgById.set(o.id, o);

  const nowMs = Date.now();

  return requests.map((t) => {
    const meta = (t.metadata ?? {}) as Record<string, unknown>;
    const attestationsRaw = (meta['attestations'] ?? {}) as Record<string, unknown>;
    let attCount = 0;
    let attPassedCount = 0;
    for (const value of Object.values(attestationsRaw)) {
      if (typeof value === 'boolean') {
        attCount += 1;
        if (value) attPassedCount += 1;
      }
    }
    const turnstilePassed =
      typeof t.turnstile_verified === 'boolean'
        ? t.turnstile_verified
        : Boolean(meta['turnstile_verified']);
    const attComplete =
      attCount > 0 && attCount === attPassedCount && turnstilePassed;
    const marketing = (t.marketing ?? {}) as Record<string, unknown>;
    const consentRaw = marketing['consent'];
    const consent = typeof consentRaw === 'boolean' ? consentRaw : false;
    const status = (t.status ?? 'pending').toLowerCase();
    const reviewer = t.reviewed_by ? userById.get(t.reviewed_by) : undefined;
    const approvedOrg = t.approved_organization_id
      ? orgById.get(t.approved_organization_id)
      : undefined;
    const approvedUser = t.approved_user_id
      ? userById.get(t.approved_user_id)
      : undefined;
    const reviewedAtMs = t.reviewed_at ? Date.parse(t.reviewed_at) : NaN;
    const decisionAgeSeconds =
      Number.isFinite(reviewedAtMs) && reviewedAtMs <= nowMs
        ? Math.floor((nowMs - reviewedAtMs) / 1000)
        : null;
    return {
      id: t.id,
      created_at: t.created_at ?? null,
      updated_at: t.updated_at ?? t.created_at ?? null,
      status,
      review_decision: t.review_decision ?? null,
      email: t.email ?? null,
      full_name: t.full_name ?? null,
      organization_name: t.organization_name ?? null,
      organization_slug: t.organization_slug ?? null,
      website_url: t.website_url ?? null,
      phone: t.phone ?? null,
      notes: t.notes ?? null,
      locale: t.locale ?? null,
      page_url: t.page_url ?? null,
      referrer: t.referrer ?? null,
      origin: t.origin ?? null,
      marketing: t.marketing ?? {},
      metadata: t.metadata ?? {},
      ip_hash: t.ip_hash ?? null,
      turnstile_verified: turnstilePassed,
      reviewed_at: t.reviewed_at ?? null,
      reviewed_by: t.reviewed_by ?? null,
      review_reason: t.review_reason ?? null,
      decision_metadata: t.decision_metadata ?? {},
      approved_organization_id: t.approved_organization_id ?? null,
      approved_user_id: t.approved_user_id ?? null,
      approved_auth_user_id: t.approved_auth_user_id ?? null,
      invite_email_sent_at: t.invite_email_sent_at ?? null,
      invite_redirect_to: t.invite_redirect_to ?? null,
      last_error_code: t.last_error_code ?? null,
      last_error_message: t.last_error_message ?? null,
      last_error_at: t.last_error_at ?? null,
      reviewer_label: reviewer?.full_name ?? t.reviewed_by_label ?? null,
      reviewer_email: reviewer?.email ?? null,
      approved_organization_label: approvedOrg?.name ?? null,
      approved_user_email: approvedUser?.email ?? null,
      attestation_count: attCount,
      attestation_passed_count: attPassedCount,
      attestation_complete: attComplete,
      has_marketing_consent: consent,
      is_pending: status === 'pending',
      is_approved: status === 'approved',
      is_rejected: status === 'rejected',
      decision_age_seconds: decisionAgeSeconds,
    } as ResourceRow;
  });
}

// W24 — Project the existing seed-raw/domain-shipments.js `shipments` entries
// (joined with addresses + clients + senders + recipients +
// shipment_boxes + labels + scan_events + comms_attempts + tasks) into the
// canonical `v_shipment_directory` view shape
// (supabase/migrations/202604302230_v_shipment_directory.sql).
//
// Closes the documented OPERATIONS schema-drift residuals on
// `Shipment.destination_city` (FE-aliased projection from addresses.city)
// and the per-shipment derived counters that were previously computed
// per-render by drawer tabs (box_actual_count, label_count,
// scan_event_count, last_scan_at, comms_attempt_count, active_task_count).
// The derived `is_at_risk` flag mirrors the FE `isShipmentRisk()` helper
// exported from `apps/console-v2/src/modules/operate/shipments.tsx` so the
// production cutover swap converges seed + live without surface drift.
//
// In live mode this projection is unused — the live branch reads directly
// from `v_shipment_directory`.
function _projectShipmentDirectory(): ResourceRow[] {
  const shipments = ((seed as Record<string, unknown>).shipments ?? []) as Array<{
    id: string;
    client_id?: string;
    organization_id?: string;
    sender_id?: string | null;
    recipient_id?: string | null;
    tracking_number?: string;
    client_reference_number?: string | null;
    carrier_reference_number?: string | null;
    service_type?: string;
    service_level?: string | null;
    status?: string;
    status_updated_at?: string;
    cod_amount?: number | null;
    cod_currency?: string | null;
    declared_value?: number | null;
    box_count?: number;
    promised_delivery_date?: string;
    priority_score?: number | null;
    origin_address_id?: string | null;
    destination_address_id?: string | null;
    metadata?: Record<string, unknown> | null;
    created_at?: string;
    updated_at?: string;
    // Legacy projection alias (canonical resolved through addresses.city).
    destination_city?: string;
    origin_city?: string;
  }>;
  const addresses = ((seed as Record<string, unknown>).addresses ?? []) as Array<{
    id: string;
    city?: string;
    district?: string;
  }>;
  const clients = ((seed as Record<string, unknown>).clients ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const senders = ((seed as Record<string, unknown>).senders ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const recipients = ((seed as Record<string, unknown>).recipients ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const shipmentBoxes = ((seed as Record<string, unknown>).shipment_boxes ?? []) as Array<{
    shipment_id?: string;
  }>;
  const labels = ((seed as Record<string, unknown>).labels ?? []) as Array<{
    shipment_id?: string;
  }>;
  const scanEvents = ((seed as Record<string, unknown>).scan_events ?? []) as Array<{
    shipment_id?: string;
    occurred_at?: string;
    captured_at?: string;
  }>;
  const commsAttempts = ((seed as Record<string, unknown>).comms_attempts ?? []) as Array<{
    shipment_id?: string;
  }>;
  const tasks = ((seed as Record<string, unknown>).tasks ?? []) as Array<{
    resource_type?: string;
    resource_id?: string;
    status?: string;
  }>;

  const addrById = new Map<string, (typeof addresses)[number]>();
  for (const a of addresses) addrById.set(a.id, a);
  const clientById = new Map<string, (typeof clients)[number]>();
  for (const c of clients) clientById.set(c.id, c);
  const senderById = new Map<string, (typeof senders)[number]>();
  for (const s of senders) senderById.set(s.id, s);
  const recipientById = new Map<string, (typeof recipients)[number]>();
  for (const r of recipients) recipientById.set(r.id, r);

  const boxActualByShipment = new Map<string, number>();
  for (const b of shipmentBoxes) {
    if (!b.shipment_id) continue;
    boxActualByShipment.set(b.shipment_id, (boxActualByShipment.get(b.shipment_id) ?? 0) + 1);
  }
  const labelCountByShipment = new Map<string, number>();
  for (const l of labels) {
    if (!l.shipment_id) continue;
    labelCountByShipment.set(l.shipment_id, (labelCountByShipment.get(l.shipment_id) ?? 0) + 1);
  }
  const scanCountByShipment = new Map<string, number>();
  const lastScanByShipment = new Map<string, string>();
  for (const s of scanEvents) {
    if (!s.shipment_id) continue;
    scanCountByShipment.set(s.shipment_id, (scanCountByShipment.get(s.shipment_id) ?? 0) + 1);
    const occurred = s.captured_at ?? s.occurred_at ?? null;
    if (occurred) {
      const prior = lastScanByShipment.get(s.shipment_id);
      if (!prior || occurred > prior) lastScanByShipment.set(s.shipment_id, occurred);
    }
  }
  const commsByShipment = new Map<string, number>();
  for (const c of commsAttempts) {
    if (!c.shipment_id) continue;
    commsByShipment.set(c.shipment_id, (commsByShipment.get(c.shipment_id) ?? 0) + 1);
  }
  const TERMINAL_TASK_STATES = new Set(['completed', 'cancelled', 'rejected', 'expired']);
  const activeTaskByShipment = new Map<string, number>();
  for (const t of tasks) {
    if (t.resource_type !== 'shipment' || !t.resource_id) continue;
    if (t.status && TERMINAL_TASK_STATES.has(t.status)) continue;
    activeTaskByShipment.set(t.resource_id, (activeTaskByShipment.get(t.resource_id) ?? 0) + 1);
  }
  // is_at_risk derivation mirrors apps/console-v2/src/modules/operate/shipments.tsx#isShipmentRisk.
  const today = new Date().toISOString().slice(0, 10);
  function isAtRisk(s: { status?: string; promised_delivery_date?: string }): boolean {
    if (s.status === 'failed_attempt') return true;
    if (s.status === 'out_for_delivery' && s.promised_delivery_date) {
      // Compare as ISO timestamps (date-only suffices because promised_delivery_date is YYYY-MM-DD).
      return String(s.promised_delivery_date).slice(0, 10) < today;
    }
    return false;
  }

  return shipments.map((s) => {
    const da = s.destination_address_id ? addrById.get(s.destination_address_id) : undefined;
    const oa = s.origin_address_id ? addrById.get(s.origin_address_id) : undefined;
    const c = s.client_id ? clientById.get(s.client_id) : undefined;
    const sn = s.sender_id ? senderById.get(s.sender_id) : undefined;
    const rc = s.recipient_id ? recipientById.get(s.recipient_id) : undefined;
    return {
      id: s.id,
      client_id: s.client_id ?? null,
      organization_id: s.organization_id ?? null,
      sender_id: s.sender_id ?? null,
      recipient_id: s.recipient_id ?? null,
      tracking_number: s.tracking_number ?? null,
      client_reference_number: s.client_reference_number ?? null,
      carrier_reference_number: s.carrier_reference_number ?? null,
      service_type: s.service_type ?? null,
      service_level: s.service_level ?? null,
      status: s.status ?? null,
      status_updated_at: s.status_updated_at ?? null,
      cod_amount: s.cod_amount ?? null,
      cod_currency: s.cod_currency ?? null,
      declared_value: s.declared_value ?? null,
      box_count: s.box_count ?? null,
      promised_delivery_date: s.promised_delivery_date ?? null,
      priority_score: s.priority_score ?? null,
      origin_address_id: s.origin_address_id ?? null,
      destination_address_id: s.destination_address_id ?? null,
      metadata: s.metadata ?? null,
      created_at: s.created_at ?? null,
      updated_at: s.updated_at ?? null,
      // Address joins (canonical destination_city / origin_city resolution).
      destination_city: da?.city ?? s.destination_city ?? null,
      destination_district: da?.district ?? null,
      origin_city: oa?.city ?? s.origin_city ?? null,
      origin_district: oa?.district ?? null,
      // Counterparty labels (canonical clients.name / senders.name / recipients.name).
      client_label: c?.name ?? null,
      sender_label: sn?.name ?? null,
      recipient_label: rc?.name ?? null,
      // Counter projections (derived from canonical event/child tables).
      box_actual_count: boxActualByShipment.get(s.id) ?? 0,
      label_count: labelCountByShipment.get(s.id) ?? 0,
      scan_event_count: scanCountByShipment.get(s.id) ?? 0,
      last_scan_at: lastScanByShipment.get(s.id) ?? null,
      comms_attempt_count: commsByShipment.get(s.id) ?? 0,
      active_task_count: activeTaskByShipment.get(s.id) ?? 0,
      is_at_risk: isAtRisk(s),
    } as ResourceRow;
  });
}

// W24 — Project the existing seed-raw/domain-routes.js `route_runs` entries
// (joined with branches + users + vehicles + route_stops + shipments +
// route_run_assignments) into the canonical `v_route_run_directory` view
// shape (supabase/migrations/202604302240_v_route_run_directory.sql).
//
// Closes the W14-1 deferred render-time aggregations by exposing canonical
// SSOT columns AND the FE-shaped derived projections (run_display_id,
// branch_label, driver_label, vehicle_label, stop_count, cod_total,
// assignment_status / assignment_mode / partner_name / is_partner_run) on
// the same registry seam. Production cutover is a single
// getSupabaseClient() branch flip in
// `ui_list_resource_v1('route_run_directory')`.
//
// In live mode this projection is unused — the live branch reads directly
// from `v_route_run_directory`.
function _projectRouteRunDirectory(): ResourceRow[] {
  const runs = ((seed as Record<string, unknown>).route_runs ?? []) as Array<{
    id: string;
    organization_id?: string;
    branch_id?: string | null;
    driver_user_id?: string | null;
    vehicle_id?: string | null;
    status?: string;
    planned_date?: string | null;
    planned_start_at?: string | null;
    planned_end_at?: string | null;
    started_at?: string | null;
    ended_at?: string | null;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    // Legacy aliases the seed still carries for non-dispatch consumers.
    run_id?: string;
    driver?: string;
    vehicle?: string;
  }>;
  const branches = ((seed as Record<string, unknown>).branches ?? []) as Array<{
    id: string;
    code?: string;
    name?: string;
    branch_type?: string;
  }>;
  const hubs = ((seed as Record<string, unknown>).hubs ?? []) as Array<{
    id: string;
    code?: string;
    name?: string;
  }>;
  // The driver picker projection aliases users.id (W19-5 ALIAS CONTRACT).
  const drivers = ((seed as Record<string, unknown>).drivers ?? []) as Array<{
    id: string;
    name?: string;
  }>;
  const users = ((seed as Record<string, unknown>).users ?? []) as Array<{
    id: string;
    full_name?: string;
    email?: string;
  }>;
  const vehicles = ((seed as Record<string, unknown>).vehicles ?? []) as Array<{
    id: string;
    plate_number?: string;
    plate?: string;
    vin?: string;
    code?: string;
  }>;
  const stops = ((seed as Record<string, unknown>).route_stops ?? []) as Array<{
    route_run_id?: string;
    shipment_id?: string;
  }>;
  const shipments = ((seed as Record<string, unknown>).shipments ?? []) as Array<{
    id: string;
    cod_amount?: number | null;
  }>;
  const assignments = ((seed as Record<string, unknown>).route_run_assignments ?? []) as Array<{
    id: string;
    route_run_id?: string;
    assignment_status?: string;
    assignment_mode?: string;
    assignment_version?: number;
    driver_user_id?: string | null;
    vehicle_id?: string | null;
    partner?: { partner_id?: string | null; partner_name?: string | null } | null;
    assigned_at?: string;
  }>;

  const branchById = new Map<string, (typeof branches)[number]>();
  for (const b of branches) branchById.set(b.id, b);
  // Hubs intentionally fall back into the branch lookup since the legacy
  // seed sometimes carries a hub_*-prefixed id where production uses the
  // canonical branch UUID.
  const hubById = new Map<string, (typeof hubs)[number]>();
  for (const h of hubs) hubById.set(h.id, h);
  const userById = new Map<string, (typeof users)[number]>();
  for (const u of users) userById.set(u.id, u);
  const driverById = new Map<string, (typeof drivers)[number]>();
  for (const d of drivers) driverById.set(d.id, d);
  const vehicleById = new Map<string, (typeof vehicles)[number]>();
  for (const v of vehicles) vehicleById.set(v.id, v);
  const shipmentById = new Map<string, (typeof shipments)[number]>();
  for (const s of shipments) shipmentById.set(s.id, s);

  const stopCountByRun = new Map<string, number>();
  const codTotalByRun = new Map<string, number>();
  for (const st of stops) {
    if (!st.route_run_id) continue;
    stopCountByRun.set(st.route_run_id, (stopCountByRun.get(st.route_run_id) ?? 0) + 1);
    const ship = st.shipment_id ? shipmentById.get(st.shipment_id) : undefined;
    const cod = typeof ship?.cod_amount === 'number' ? ship.cod_amount : 0;
    codTotalByRun.set(st.route_run_id, (codTotalByRun.get(st.route_run_id) ?? 0) + cod);
  }

  // Active assignment selection (highest assignment_version among non-cancelled).
  const activeAssignmentByRun = new Map<string, (typeof assignments)[number]>();
  for (const a of assignments) {
    if (!a.route_run_id) continue;
    if (a.assignment_status === 'cancelled') continue;
    const prior = activeAssignmentByRun.get(a.route_run_id);
    if (!prior) {
      activeAssignmentByRun.set(a.route_run_id, a);
      continue;
    }
    const priorVersion = prior.assignment_version ?? 0;
    const candidateVersion = a.assignment_version ?? 0;
    if (candidateVersion > priorVersion) {
      activeAssignmentByRun.set(a.route_run_id, a);
    }
  }

  return runs.map((rr) => {
    // Branch lookup: prefer canonical branches.id; fall back to hubs (legacy
    // seed sometimes uses hub_*-prefixed ids that align with branches.id per
    // CLAIM-NETWORK-BRANCHES). Only canonical branches expose `branch_type`.
    const canonicalBranch = rr.branch_id ? branchById.get(rr.branch_id) : undefined;
    const fallbackHub = !canonicalBranch && rr.branch_id ? hubById.get(rr.branch_id) : undefined;
    const branchLabelSource =
      canonicalBranch?.name ?? canonicalBranch?.code ?? fallbackHub?.name ?? fallbackHub?.code ?? null;
    const branchCode = canonicalBranch?.code ?? fallbackHub?.code ?? null;
    const branchType = canonicalBranch?.branch_type ?? null;
    const driverUser = rr.driver_user_id ? userById.get(rr.driver_user_id) : undefined;
    const driverPicker = rr.driver_user_id ? driverById.get(rr.driver_user_id) : undefined;
    const driverLabel =
      driverUser?.full_name ?? driverPicker?.name ?? driverUser?.email ?? rr.driver ?? rr.driver_user_id ?? null;
    const vehicle = rr.vehicle_id ? vehicleById.get(rr.vehicle_id) : undefined;
    const vehicleLabel =
      vehicle?.plate_number ?? vehicle?.plate ?? vehicle?.vin ?? vehicle?.code ?? rr.vehicle ?? rr.vehicle_id ?? null;
    const aa = activeAssignmentByRun.get(rr.id);
    const partnerName =
      aa?.partner?.partner_name ?? aa?.partner?.partner_id ?? null;
    const isPartner =
      lookupRow('route_assignment_mode', aa?.assignment_mode ?? '')?.metadata?.is_partner === true;
    const compactId = String(rr.id).replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
    const runDisplayId = `RUN-${compactId}`;
    return {
      id: rr.id,
      organization_id: rr.organization_id ?? null,
      branch_id: rr.branch_id ?? null,
      driver_user_id: rr.driver_user_id ?? null,
      vehicle_id: rr.vehicle_id ?? null,
      status: rr.status ?? null,
      planned_date: rr.planned_date ?? null,
      planned_start_at: rr.planned_start_at ?? null,
      planned_end_at: rr.planned_end_at ?? null,
      started_at: rr.started_at ?? null,
      ended_at: rr.ended_at ?? null,
      metadata: rr.metadata ?? null,
      created_at: rr.created_at ?? null,
      updated_at: rr.updated_at ?? null,
      run_display_id: runDisplayId,
      branch_label: branchLabelSource,
      branch_code: branchCode,
      branch_type: branchType,
      driver_label: driverLabel,
      vehicle_label: vehicleLabel,
      stop_count: stopCountByRun.get(rr.id) ?? 0,
      cod_total: codTotalByRun.get(rr.id) ?? 0,
      assignment_id: aa?.id ?? null,
      assignment_status: aa?.assignment_status ?? null,
      assignment_mode: aa?.assignment_mode ?? null,
      assignment_version: aa?.assignment_version ?? null,
      assignment_assigned_at: aa?.assigned_at ?? null,
      assignment_driver_user_id: aa?.driver_user_id ?? null,
      assignment_vehicle_id: aa?.vehicle_id ?? null,
      partner_payload: aa?.partner ?? null,
      partner_name: partnerName,
      is_partner_run: !!isPartner,
    } as ResourceRow;
  });
}

// W24 — Project the existing seed-raw/domain-routes.js `route_plans` entries
// (joined with branches + route_runs + route_stops + route_plan_events) into
// the canonical `v_route_plan_directory` view shape
// (supabase/migrations/202604302250_v_route_plan_directory.sql).
//
// Closes the deferred FE-only fields (`plan_id`, `wave_label`, `hub`,
// `stops`, `runs`, `drivers_notified`, `applied`) by exposing canonical
// SSOT columns AND the FE-shaped derived projections on the same registry
// seam. The seed currently materialises legacy aliases inline; the
// projection re-derives them from the canonical inputs so the live + demo
// paths converge on the same shape.
//
// In live mode this projection is unused — the live branch reads directly
// from `v_route_plan_directory`.
function _projectRoutePlanDirectory(): ResourceRow[] {
  const plans = ((seed as Record<string, unknown>).route_plans ?? []) as Array<{
    id: string;
    organization_id?: string;
    branch_id?: string;
    planned_date?: string;
    status?: string;
    status_reason?: string | null;
    requested_by_user_id?: string | null;
    requested_at?: string | null;
    solved_at?: string | null;
    applied_at?: string | null;
    idempotency_key?: string | null;
    version?: number;
    metadata?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    // Legacy seed-only aliases for FE consumers that still reference them.
    plan_id?: string;
    wave_label?: string;
    hub?: string;
    stops?: number;
    runs?: number;
    drivers_notified?: number;
    applied?: number;
  }>;
  const branches = ((seed as Record<string, unknown>).branches ?? []) as Array<{
    id: string;
    code?: string;
    name?: string;
  }>;
  const hubs = ((seed as Record<string, unknown>).hubs ?? []) as Array<{
    id: string;
    code?: string;
    name?: string;
  }>;
  const runs = ((seed as Record<string, unknown>).route_runs ?? []) as Array<{
    id?: string;
    route_plan_id?: string;
  }>;
  const stops = ((seed as Record<string, unknown>).route_stops ?? []) as Array<{
    id?: string;
    route_run_id?: string;
  }>;
  const planEvents = ((seed as Record<string, unknown>).route_plan_events ?? []) as Array<{
    route_plan_id?: string;
    event_type?: string;
    actor_user_id?: string;
  }>;

  const branchById = new Map<string, (typeof branches)[number]>();
  for (const b of branches) branchById.set(b.id, b);
  const hubById = new Map<string, (typeof hubs)[number]>();
  for (const h of hubs) hubById.set(h.id, h);

  // run_count: route_runs JOIN route_plan_id.
  const runCountByPlan = new Map<string, number>();
  const runIdsByPlan = new Map<string, Set<string>>();
  for (const rr of runs) {
    if (!rr.route_plan_id || !rr.id) continue;
    runCountByPlan.set(rr.route_plan_id, (runCountByPlan.get(rr.route_plan_id) ?? 0) + 1);
    let set = runIdsByPlan.get(rr.route_plan_id);
    if (!set) {
      set = new Set<string>();
      runIdsByPlan.set(rr.route_plan_id, set);
    }
    set.add(rr.id);
  }
  // stop_count: route_stops JOIN route_runs JOIN route_plan_id.
  const stopCountByPlan = new Map<string, number>();
  for (const st of stops) {
    if (!st.route_run_id) continue;
    for (const [planId, runSet] of runIdsByPlan) {
      if (runSet.has(st.route_run_id)) {
        stopCountByPlan.set(planId, (stopCountByPlan.get(planId) ?? 0) + 1);
        break;
      }
    }
  }
  // drivers_notified_count: DISTINCT actor_user_id on driver_notified events.
  const notifiedByPlan = new Map<string, Set<string>>();
  for (const ev of planEvents) {
    if (!ev.route_plan_id || ev.event_type !== 'driver_notified' || !ev.actor_user_id) continue;
    let set = notifiedByPlan.get(ev.route_plan_id);
    if (!set) {
      set = new Set<string>();
      notifiedByPlan.set(ev.route_plan_id, set);
    }
    set.add(ev.actor_user_id);
  }

  return plans.map((rp) => {
    // Branch lookup: prefer canonical branches.id; fall back to hubs (legacy
    // seed uses hub_* code-style ids that align with branches.id per
    // CLAIM-NETWORK-BRANCHES seed). The legacy `hub` alias is the FE-display
    // branch code (e.g. RUH-N).
    const branch = rp.branch_id ? branchById.get(rp.branch_id) ?? hubById.get(rp.branch_id) : undefined;
    const branchCode = branch?.code ?? rp.hub ?? null;
    const branchLabel = branch?.name ?? rp.hub ?? null;
    const compactId = String(rp.id).replace(/-/g, '').toUpperCase().slice(0, 6);
    const planDisplayId = rp.plan_id ?? `PLN-${compactId}`;
    const meta = rp.metadata ?? {};
    const inputs = rp.inputs ?? {};
    const waveLabel =
      (typeof (meta as Record<string, unknown>).wave_label === 'string'
        ? ((meta as Record<string, unknown>).wave_label as string)
        : null) ??
      (typeof (inputs as Record<string, unknown>).wave_label === 'string'
        ? ((inputs as Record<string, unknown>).wave_label as string)
        : null) ??
      rp.wave_label ?? null;
    const waveKey =
      (typeof (meta as Record<string, unknown>).wave === 'string'
        ? ((meta as Record<string, unknown>).wave as string)
        : null) ??
      (typeof (inputs as Record<string, unknown>).wave === 'string'
        ? ((inputs as Record<string, unknown>).wave as string)
        : null) ??
      (typeof (meta as Record<string, unknown>).wave_id === 'string'
        ? ((meta as Record<string, unknown>).wave_id as string)
        : null) ??
      (typeof (inputs as Record<string, unknown>).wave_id === 'string'
        ? ((inputs as Record<string, unknown>).wave_id as string)
        : null) ??
      null;
    const driversNotifiedCount = notifiedByPlan.get(rp.id)?.size ?? rp.drivers_notified ?? 0;
    const isApplied = rp.applied_at != null
      ? true
      : typeof rp.applied === 'number' && rp.applied > 0;
    return {
      id: rp.id,
      organization_id: rp.organization_id ?? null,
      branch_id: rp.branch_id ?? null,
      planned_date: rp.planned_date ?? null,
      status: rp.status ?? null,
      status_reason: rp.status_reason ?? null,
      requested_by_user_id: rp.requested_by_user_id ?? null,
      requested_at: rp.requested_at ?? null,
      solved_at: rp.solved_at ?? null,
      applied_at: rp.applied_at ?? null,
      idempotency_key: rp.idempotency_key ?? null,
      version: rp.version ?? null,
      metadata: rp.metadata ?? null,
      created_at: rp.created_at ?? null,
      updated_at: rp.updated_at ?? null,
      plan_display_id: planDisplayId,
      branch_label: branchLabel,
      branch_code: branchCode,
      wave_label: waveLabel,
      wave_key: waveKey,
      run_count: runCountByPlan.get(rp.id) ?? rp.runs ?? 0,
      stop_count: stopCountByPlan.get(rp.id) ?? rp.stops ?? 0,
      drivers_notified_count: driversNotifiedCount,
      is_applied: isApplied,
    } as ResourceRow;
  });
}

const buildSeedResourceMap = (): ResourceMap => ({
  shipments: seed.shipments,
  // W24 — paired projection view `public.v_shipment_directory`
  // (supabase/migrations/202604302230_v_shipment_directory.sql). Read-only;
  // SSOT remains shipments. Closes deferred OPERATIONS surface-bind gaps
  // (destination_city alias, box_actual_count, label_count,
  // scan_event_count, last_scan_at, comms_attempt_count, active_task_count,
  // is_at_risk derived flag) without inventing FE-only fields. Mirrors the
  // W11/W18/W20/W21/W22/W23 paired-projection pattern.
  shipment_directory: _projectShipmentDirectory(),
  route_plans: seed.route_plans,
  // W24 — paired projection view `public.v_route_plan_directory`
  // (supabase/migrations/202604302250_v_route_plan_directory.sql). Read-only;
  // SSOT remains route_plans. Closes deferred OPERATIONS surface-bind gaps
  // (plan_display_id alias from PK, branch_label/branch_code joins,
  // wave_label/wave_key from metadata/inputs JSONB, run_count, stop_count,
  // drivers_notified_count, is_applied derived flag).
  route_plan_directory: _projectRoutePlanDirectory(),
  route_runs: seed.route_runs,
  // W24 — paired projection view `public.v_route_run_directory`
  // (supabase/migrations/202604302240_v_route_run_directory.sql). Read-only;
  // SSOT remains route_runs. Closes deferred OPERATIONS surface-bind gaps
  // (run_display_id alias from PK, branch_label / driver_label /
  // vehicle_label joins, stop_count + cod_total derived counters,
  // assignment_status / assignment_mode / partner_name / is_partner_run
  // projected from active route_run_assignments).
  route_run_directory: _projectRouteRunDirectory(),
  route_stops: seed.route_stops,
  // OPERATIONS REAUDIT D4 (W9-4) — three new SSOT exposures from the route
  // assignment lifecycle backend. All read-only on operator surface; write
  // seams are ui_execute_route_run_assign_v1 and ui_execute_route_stop_
  // reassign_v1 (already wired via dispatch.tsx). Backend SSOT:
  //   • route_run_assignments          · 202604061430:49  (projection of current state)
  //   • route_run_assignment_events    · 202604061430:173 (append-only lifecycle ledger)
  //   • route_stop_reassignment_events · 202604101715:274 (append-only stop reassign audit)
  // Production swap: a single getSupabaseClient() branch in ui_list_resource_v1
  // returns the canonical projection — operator surface module call sites stay
  // stable because resolution is registry-driven.
  route_run_assignments: seed.route_run_assignments,
  route_run_assignment_events: seed.route_run_assignment_events,
  route_stop_reassignment_events: seed.route_stop_reassignment_events,
  baskets: seed.baskets,
  basket_items: seed.basket_items,
  basket_transitions: seed.basket_transitions,
  tasks: seed.tasks,
  // CLAIM-OPERATIONS-WIRING (Phase C1) — registry-driven read seams that the
  // operator surface previously read from `api.seed.*` directly. Mapping these
  // through `ui_list_resource_v1` keeps shipment drawer tabs (Boxes / Labels /
  // Scans / Comms) and exceptions queue tabs (Attempts / Events) on the
  // canonical seam so the production swap is a single getSupabaseClient()
  // branch flip — module call sites stay stable. Source migrations:
  //   • task_events     · supabase/migrations/202601212300_tasks_ssot_core.sql:458
  //   • scan_events     · supabase/migrations/202601251060_scan_events_v1.sql:49
  //   • shipment_boxes  · supabase/migrations/202510110006_domain_tables_partitioned.sql
  //   • comms_attempts  · public.comms_attempts (read seam; Phase G migration)
  //   • wave_catalog    · public.wave_catalog (read seam; Phase G migration)
  task_events: seed.task_events,
  scan_events: seed.scan_events,
  shipment_boxes: seed.shipment_boxes,
  comms_attempts: seed.comms_attempts,
  wave_catalog: seed.wave_catalog,
  settlement_batches: seed.settlement_batches,
  // W11-1 / W8-4 — paired projection view `public.v_settlement_batch_summary`
  // (supabase/migrations/202604301120_v_settlement_batch_summary.sql).
  // Surfaces the FE-shaped derived fields (expected_amount, collected_amount,
  // remitted_amount, posted_at, variance_flag) without duplicating them onto
  // the canonical `settlement_batches` row interface. In live mode the
  // adapter routes `ui_list_resource_v1('settlement_batch_summary')` through
  // the canonical view (same seam as every other registry-driven read). In
  // seed mode we project the existing marketplace.js settlement_batches
  // entries — they already carry the derived fields inline — into the
  // canonical view shape.
  settlement_batch_summary: _projectSettlementBatchSummary(),
  workflow_templates: seed.workflow_templates,
  workflow_runs: seed.workflow_runs,
  workflow_run_steps: _flattenWorkflowRunSteps(),
  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_run_triggers (workflow→workflow
  // chaining), workflow_schedule_triggers (cron scheduled runs), and
  // workflow_binding_dispatches (binding execution ledger) projections.
  // Production swap: a single getSupabaseClient() branch in ui_list_resource_v1
  // returns the canonical projection — operator surface module call sites stay
  // stable because resolution is registry-driven. Source migrations:
  //   • workflow_run_triggers       · supabase/migrations/202601281600_workflow_run_triggers.sql:14
  //   • workflow_schedule_triggers  · supabase/migrations/202601212101_workflow_schedule_triggers.sql:14
  //   • workflow_binding_dispatches · supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql:224
  workflow_run_triggers: seed.workflow_run_triggers,
  workflow_schedule_triggers: seed.workflow_schedule_triggers,
  workflow_binding_dispatches: seed.workflow_binding_dispatches,
  // W22 — paired projection views for WORKFLOWS:
  //   • public.v_workflow_run_directory       (supabase/migrations/202604302100_v_workflow_run_directory.sql)
  //   • public.v_workflow_template_directory  (supabase/migrations/202604302110_v_workflow_template_directory.sql)
  //   • public.v_workflow_binding_directory   (supabase/migrations/202604302120_v_workflow_binding_directory.sql)
  // Read-only; SSOT remains workflow_runs / workflow_templates /
  // workflow_binding_registry. Production cutover: a single
  // getSupabaseClient() branch in ui_list_resource_v1 returns the
  // canonical projection — module call sites stay stable because
  // resolution is registry-driven. The seed-mode projections derive the
  // FE counters and legacy display aliases from the same seed slices the
  // surface already consumes so demo behavior is unchanged. Closes the
  // W10-6 deferred RENAME cascade by exposing the canonical SSOT (e.g.
  // `workflow_status`, `entry_point`, `failure_reason`) AND the legacy
  // display aliases (e.g. `status`, `triggered_by`, `error`) on the
  // same projection seam. Mirrors the W11/W18/W20/W21 paired-projection
  // pattern.
  workflow_run_directory: _projectWorkflowRunDirectory(),
  workflow_template_directory: _projectWorkflowTemplateDirectory(),
  workflow_binding_directory: _projectWorkflowBindingDirectory(),
  operation_templates: _operationTemplatesCatalog(),
  integration_plugins: seed.integration_plugins,
  integration_plugin_versions: seed.integration_plugin_versions,
  // W27 — paired projection views for INTEGRATIONS:
  //   • public.v_webhook_source_directory          (supabase/migrations/202604302500_v_webhook_source_directory.sql)
  //   • public.v_webhook_inbox_directory           (supabase/migrations/202604302510_v_webhook_inbox_directory.sql)
  //   • public.v_mapping_config_directory          (supabase/migrations/202604302520_v_mapping_config_directory.sql)
  //   • public.v_integration_credential_directory  (supabase/migrations/202604302530_v_integration_credential_directory.sql)
  //   • public.v_integration_plugin_directory      (supabase/migrations/202604302540_v_integration_plugin_directory.sql)
  // Read-only; SSOT remains webhook_sources / webhook_inbox / mapping_configs /
  // provider_auth_configs / integration_plugins. Production cutover: a single
  // getSupabaseClient() branch in ui_list_resource_v1 returns the canonical
  // projection — module call sites stay stable because resolution is
  // registry-driven. Seed-mode projections derive mapping_label / event_count_24h
  // / error_count_24h / rule_count / is_healthy / has_recent_errors /
  // auth_token_masked (sources); source_label / replay_count / age_seconds /
  // is_actionable / is_terminal (inbox); target / rules_count / source_count /
  // rule_usage_count / is_in_use / has_rules (mappings); status /
  // days_until_expiry / provider_label / provider_kind / provider_vendor /
  // is_expiring / is_expired (credentials); vendor / version_label /
  // version_count / binding_count / has_active_version / is_pending_review
  // (plugins) so demo behavior is unchanged. Mirrors the
  // W11/W18/W20/W21/W25/W26 paired-projection pattern.
  webhook_source_directory: _projectWebhookSourceDirectory(seed),
  webhook_inbox_directory: _projectWebhookInboxDirectory(seed, lookupBundledRow),
  webhook_auth_rejections: seed.webhook_auth_rejections,
  mapping_config_directory: _projectMappingConfigDirectory(seed),
  integration_credential_directory: _projectIntegrationCredentialDirectory(seed),
  integration_plugin_directory: _projectIntegrationPluginDirectory(),
  integration_plugin_validation_runs: seed.integration_plugin_validation_runs,
  integration_plugin_approval_events: seed.integration_plugin_approval_events,
  integration_plugin_bindings: seed.integration_plugin_bindings,
  decision_log: seed.decision_log,
  warehouse_transfers: seed.warehouse_transfers,
  // W11-3 — paired projection view `public.v_warehouse_transfer_summary`
  // (supabase/migrations/202604301500_v_warehouse_transfer_summary.sql).
  // Surfaces FE-shaped derived aggregates (item_count, received_count,
  // variance_count, variance_flag, posted_at, hold_reason).
  warehouse_transfer_summary: _projectWarehouseTransferSummary(),
  // W28 — paired projection views for PLATFORM:
  //   • public.v_alert_rule_directory      (supabase/migrations/202604302600_v_alert_rule_directory.sql)
  //   • public.v_label_template_directory  (supabase/migrations/202604302610_v_label_template_directory.sql)
  //   • public.v_import_job_directory      (supabase/migrations/202604302620_v_import_job_directory.sql)
  // Read-only; SSOT remains alert_rules / label_template_specs / import_jobs.
  // Production cutover: a single getSupabaseClient() branch in
  // ui_list_resource_v1 returns the canonical projection — module call sites
  // stay stable because resolution is registry-driven. Seed-mode projections
  // derive severity_label / created_by_label / condition_summary /
  // last_triggered_at / trigger_count_24h / ack_count_24h / is_throttled
  // (alert_rule_directory); dimensions / dpi / barcode_format /
  // active_version_id (renderer_config jsonb) + tenant_label /
  // created_by_label + render_count / completed_count / failed_count /
  // version_count / is_active_version (label_template_directory);
  // tenant_label / submitted_by_label / row_count_value / error_count_value
  // / is_terminal / is_failed / has_errors / duration_seconds /
  // queue_wait_seconds / age_seconds / error_summary_count
  // (import_job_directory) so demo behavior is unchanged. Mirrors the
  // W11/W18/W20/W21/W22/W23/W24/W25/W26/W27 paired-projection pattern.
  alert_rule_directory: _projectAlertRuleDirectory(),
  // W56-B (F5) — Paired projection view `public.v_alert_trigger_summary`
  // (supabase/migrations/202604301700_v_alert_trigger_summary.sql). Closes
  // the resource registry / RESOURCE_DATA gap (registry declared the
  // resource but RESOURCE_DATA had no projection, breaking ladder
  // resolution for `useResourceList<>('alert_trigger_summary')`).
  alert_trigger_summary: _projectAlertTriggerSummary(),
  label_template_directory: _projectLabelTemplateDirectory(),
  import_job_directory: _projectImportJobDirectory(),
  domain_events: seed.domain_events,
  // Wave 6 — INSIGHTS audit reconciliation. Canonical ledger SSOT is
  // public.audit_table_changes (supabase/migrations/202512011211_audit_table_changes.sql).
  //
  // ALIAS CONTRACT (W19-5 — see __audit__/DECISIONS/REGISTRY-ALIASES.md §6):
  // W6-3 reconciliation is COMPLETE. The legacy `audit_log` `RESOURCE_DATA`
  // pass-through has been retired in W19-5: a repo-wide grep confirmed no
  // `useResourceList<>('audit_log')` consumer existed anywhere in the codebase
  // (the only `audit_log`-shape readers route through the legacy
  // `listAuditLog` adapter -> `useAuditLog` hook, which reads `seed.audit_log`
  // directly — not via `RESOURCE_DATA`). Removing the pass-through eliminates
  // the redundant alias from the resource registry surface while preserving
  // the legacy adapter contract for dashboard.tsx + shipments.tsx +
  // exceptions.tsx (the three remaining `useAuditLog` callers; their
  // canonical-shape migration to `useResourceList<>('audit_table_changes')`
  // is tracked in __audit__/CROSSWALK/INSIGHTS.md).
  //
  // Capability key `audit_log.read` is the canonical capability namespace
  // retained per
  // supabase/migrations/202601022113_access_control_policy_core.sql:215,241
  // — only the backing relation was reconciled, not the capability key.
  audit_table_changes: seed.audit_table_changes,
  ui_event_log: seed.ui_event_log,
  marketplace_participants: seed.marketplace_participants,
  // W18-2 — canonical `marketplace_contracts` mapping moved to the
  // CLAIM-NETWORK-MARKETPLACE block below (lifecycle shape from
  // network-marketplace.js). Legacy partial-roster pass-through retired
  // and `marketplace_contracts_v2` alias unified — see
  // `__audit__/DECISIONS/REGISTRY-ALIASES.md` §3 closure.
  marketplace_disputes: seed.marketplace_disputes,
  finance_events_ledger: seed.finance_events_ledger,
  bank_accounts: seed.bank_accounts,
  finance_events_bank_statement: seed.finance_events_bank_statement,
  // CLAIM-FINANCE-WIRING (Phase B5/C4) — bank_recon_matches read seam.
  // Mirrors `public.bank_recon_matches` from supabase/migrations/
  // 202604281075_bank_recon_matches_v1.sql. Surfaced in /finance/bank-recon
  // for the Manage matches drawer (Match / Unmatch lifecycle audit).
  bank_recon_matches: seed.bank_recon_matches ?? [],
  clients: seed.clients,
  senders: seed.senders,
  recipients: seed.recipients,
  // W21 — paired projection views for CUSTOMERS:
  //   • public.v_client_summary       (supabase/migrations/202604302000_v_client_summary.sql)
  //   • public.v_sender_summary       (supabase/migrations/202604302010_v_sender_summary.sql)
  //   • public.v_recipient_directory  (supabase/migrations/202604302020_v_recipient_directory.sql)
  // Read-only; SSOT remains clients / senders / recipients. Production
  // cutover: a single getSupabaseClient() branch in ui_list_resource_v1
  // returns the canonical projection — module call sites stay stable
  // because resolution is registry-driven. The seed-mode projections
  // derive the FE counters from the same seed slices the surface already
  // consumes so demo behavior is unchanged. Closes deferred CUSTOMERS
  // surface-bind gaps (sender_count, recipient_count, client_label,
  // active/total shipments, last_shipment_at/status, contract_active,
  // has_warehouse, effective_warehouse_id, etc.) without inventing
  // FE-only fields. Mirrors the W11/W18/W20 NETWORK pattern.
  client_summary: _projectClientSummary(),
  sender_summary: _projectSenderSummary(),
  recipient_directory: _projectRecipientDirectory(),
  // W25 — paired projection views for FINANCE:
  //   • public.v_billing_invoice_directory  (supabase/migrations/202604302300_v_billing_invoice_directory.sql)
  //   • public.v_dispute_directory          (supabase/migrations/202604302310_v_dispute_directory.sql)
  // Read-only; SSOT remains billing_invoices / marketplace_disputes.
  // Production cutover: a single getSupabaseClient() branch in
  // ui_list_resource_v1 returns the canonical projection — module call
  // sites stay stable because resolution is registry-driven. Seed-mode
  // projections derive client_label / sender_label / line_count /
  // line_total_amount / event timestamps / payment_status / is_overdue
  // (billing) and opened_by_label / counterparty_label / shipment_ref /
  // amount_sar / escalation_count / is_terminal / is_escalated / age_*
  // (disputes) so demo behavior is unchanged. Mirrors the W11/W18/W20/W21
  // paired-projection pattern.
  billing_invoice_directory: _projectBillingInvoiceDirectory(),
  dispute_directory: _projectDisputeDirectory(),
  addresses: seed.addresses,
  geocodes: seed.geocodes,
  // ALIAS CONTRACT (W19-5 — see __audit__/DECISIONS/REGISTRY-ALIASES.md §5):
  // `hubs` is a deliberate non-breaking compatibility shim per Phase G2
  // hubs deprecation (__audit__/DECISIONS/HUBS.md). `/network/hubs` redirects
  // to `/network/branches`; this resource pass-through serves four sibling
  // consumers that call `useResourceList<HubRow>('hubs')` for hub-by-id
  // lookups: route-plans.tsx, tracking-map.tsx, fleet/drivers.tsx,
  // fleet/vehicles.tsx.
  //
  // Why this stays as a shim (W19-5 verification): the four consumers read
  // a hub-shape projection (`{ id, code, name, city, cutoff_time,
  // staging_capacity }`) that does NOT match the canonical
  // `branches` row shape (`{ id, code, name, address (jsonb),
  // operating_hours (jsonb), capacity_per_day, ... }`) — the FE alias
  // uses `city` (extracted from `branches.address->>'city'`), `cutoff_time`
  // (extracted from `branches.operating_hours`), and `staging_capacity`
  // (a hub-specific projection). Migration requires either (a) introducing
  // a `branches_hub_picker_v1` projection helper, or (b) refactoring all
  // four consumers to read `branches` and resolve fields via JSONB joins.
  // Cascade exceeds the W16-4 deferral threshold (4 modules + type
  // refactors + projection helper). Deferred to a dedicated migration.
  //
  // The legacy hub IDs (`hub_ruh_n`, `hub_ruh_s`, `hub_jed_n`, `hub_dmm_c`)
  // intentionally match `branches[].id` per the CLAIM-NETWORK-BRANCHES seed,
  // so the data is consistent — only the shape differs.
  // No registry resource declared for this key (FE-only seed pass-through).
  hubs: seed.hubs,
  // W17-5 — legacy `zones: seed.zones` (hub-keyed picker shape from
  // domain-routes.js) removed. The canonical `zones` resource now sources
  // from `seed.zones` exported by `network-zones.js` and is registered
  // under the canonical `zones` key further below (alongside zone_districts /
  // zone_override_requests / branch_zones). See
  // `__audit__/DECISIONS/REGISTRY-ALIASES.md` §1 closure.
  // ALIAS CONTRACT (W19-5 — see __audit__/DECISIONS/REGISTRY-ALIASES.md §4):
  // `drivers` is a FE-only **virtual projection** of the canonical
  // `driver_profiles` SSOT (registered as the `driver_profiles` /
  // `driver_profile_summary` resource). The legacy parallel 6-row array
  // from `seed-raw/domain-routes.js` has been retired; this entry now
  // derives its rows at module-load time via `_projectDriverPickers()` so
  // the picker UIs (dispatch.tsx, pickups.tsx, fleet/vehicles.tsx) and the
  // canonical roster never drift.
  //
  // Picker shape contract (`{ id: users.id, name, vehicle_id, skills }`):
  //   • id         ← driver_profiles.user_id (used as the lookup key in
  //                  driver-by-user_id maps because route_runs and
  //                  pickup_waves persist the user_id, not the
  //                  driver_profiles.id surrogate)
  //   • name       ← driver_profiles.name
  //   • vehicle_id ← driver_profiles.current_vehicle_id
  //   • skills     ← [] (kept for shape parity; no consumer reads it)
  //
  // Production swap path: cutover is a single getSupabaseClient() branch
  // flip in ui_list_resource_v1 — the live mode would project the same
  // picker shape from a server-side `driver_profile_picker_v1` view (or
  // inline SELECT). FE call sites stay stable.
  drivers: _projectDriverPickers(),
  vehicles: seed.vehicles,
  organizations: seed.organizations,
  user_devices: seed.user_devices,
  // W39 PLATFORM closure — paired projection view
  // public.v_user_device_summary (read-only; SSOT remains user_devices).
  // Migration: 202604303100_v_user_device_summary.sql. Production cutover
  // is a single getSupabaseClient() branch in ui_list_resource_v1
  // (registry-driven, FE call sites stay stable). Seed-mode projection
  // mirrors the canonical view shape (top-level model / attestation_status
  // / attestation_trusted_at + derived booleans) so demo behavior matches
  // the live projection.
  user_device_summary: _projectUserDeviceSummary(),
  webhook_inbox: seed.webhook_inbox,
  webhook_sources: _projectWebhookSourceDirectory(seed),
  tenant_signup_requests: seed.tenant_signup_requests,
  // W31 (G5) — canonical projections for marketing intake.
  // Mirrors `marketing_intake_recent_v1` view + `marketing_intake_metrics_24h`
  // aggregation. The FE module previously inlined these as
  // SAMPLE_INTAKE_EVENTS / INTAKE_METRICS_24H; the canonical seed lives in
  // `seed-raw/intake.js#marketing_intake_events / marketing_intake_metrics_24h`
  // and is now consumed via `useResourceList('marketing_intake_recent')` /
  // `useResourceList('marketing_intake_metrics_24h')`.
  marketing_intake_recent: seed.marketing_intake_events,
  marketing_intake_metrics_24h: seed.marketing_intake_metrics_24h
    ? [seed.marketing_intake_metrics_24h]
    : [],
  label_template_specs: seed.label_template_specs,
  label_versions: seed.label_versions,
  label_jobs: seed.label_jobs,
  labels: seed.labels,
  provider_health_latest: seed.provider_health_metrics,
  circuit_breaker_dashboard: seed.circuit_breaker_state,
  provider_auth_configs: _projectIntegrationCredentialDirectory(seed),
  providers: seed.providers,
  mapping_configs: seed.mapping_configs,
  workflow_bindings: seed.workflow_bindings,
  recent_workflow_events: seed.recent_workflow_events,
  settings_versions: seed.settings_versions,
  // CLAIM-FLEET-DRIVERS (Wave 1, Phase A). Mirrors the canonical driver
  // projection tables (driver_profiles + driver_documents +
  // driver_compliance_events) from
  // supabase/migrations/202601311230_enterprise_ops_v1.sql:333-440.
  driver_profiles: seed.driver_profiles,
  driver_documents: seed.driver_documents,
  driver_compliance_events: seed.driver_compliance_events,
  // Phase D1 (CLAIM-FLEET-DRIVER-APPLICATIONS). Operator-side review surface
  // for the freelancer_driver subset of `public.marketplace_participant_requests`
  // (canonical SSOT per supabase/migrations/202603071100_marketplace_network_
  // foundation_v1.sql:598-641). Approve / Reject / Request docs decisions
  // route through `marketplace_participant_request_review_apply_v1` (already
  // wired via useReviewMarketplaceParticipantRequest in queries.ts:1448-1452).
  // Production cutover: a single supabase branch in this map filters
  // `marketplace_participant_requests` by `requested_participant_type_key=
  // 'freelancer_driver'` and exposes the rows under the same key — module
  // call sites in driver-applications.tsx stay stable.
  driver_applications: seed.driver_applications,
  // CLAIM-FLEET-VEHICLES (Wave 1, Phase A). Mirrors the canonical fleet
  // foundation tables (vehicle_types + vehicle_assignments + vehicle_events +
  // vehicle_maintenance_windows) from
  // supabase/migrations/202601231000_fleet_foundation_v1.sql.
  // Note: the legacy `vehicles` mapping above is intentionally preserved —
  // this re-binding wins because seed.vehicles is now sourced from
  // `seed-raw/fleet-vehicles.js` (richer canonical schema with plate, vin,
  // type_id, status, fuel_level, odometer_km, last_telemetry_at).
  vehicle_types: seed.vehicle_types,
  vehicle_assignments: seed.vehicle_assignments,
  vehicle_events: seed.vehicle_events,
  vehicle_documents: seed.vehicle_documents,
  vehicle_maintenance_windows: seed.vehicle_maintenance_windows,
  // W11-4 — paired projection view `public.driver_profile_summary_v1`
  // (supabase/migrations/202604301430_driver_profile_summary_v1.sql).
  // Joins driver_profiles + users + driver_documents + vehicle_assignments
  // and projects the FE-friendly DriverProfileRow shape (name, initials,
  // license_number, license_class, license_expires_at, current_vehicle_id,
  // current_branch_id, hours_of_service_state, compliance_score, phone,
  // emergency_*, deliveries_*, on_time_pct, customer_rating). In live mode the
  // adapter routes `ui_list_resource_v1('driver_profile_summary')` through
  // the canonical view; in seed mode we project the existing fleet-drivers.js
  // `driver_profiles` entries — they already carry the derived fields inline —
  // into the canonical projection shape so callsites stay stable.
  driver_profile_summary: _projectDriverProfileSummary(),
  // W11-4 — paired projection view `public.vehicles_with_state_v1`
  // (supabase/migrations/202604301440_vehicles_with_state_v1.sql).
  // Joins vehicles + vehicle_types + vehicle_assignments + vehicle_events
  // and projects the FE-friendly VehicleRow.full shape with telemetry
  // (current_driver_user_id, current_branch_id, fuel_level, odometer_km,
  // last_telemetry_at, type_name). Production cutover is a single
  // getSupabaseClient() branch flip in ui_list_resource_v1.
  vehicles_with_state: _projectVehiclesWithState(),
  // W29 FLEET closure — paired projection views (read-only; SSOT remains
  // vehicles / driver_profiles / marketplace_participant_requests /
  // vehicle_maintenance_windows). Migrations:
  //   • 202604302700_v_vehicle_directory.sql
  //   • 202604302710_v_driver_directory.sql
  //   • 202604302720_v_driver_application_directory.sql
  //   • 202604302730_v_vehicle_maintenance_directory.sql
  // Production cutover: a single getSupabaseClient() branch in
  // ui_list_resource_v1 returns the canonical projection — module call
  // sites stay stable because resolution is registry-driven. Seed-mode
  // projections derive branch/vehicle/driver labels, lifecycle counters,
  // status booleans, and age aggregates from the same seed slices the
  // surfaces already consume so demo behavior is unchanged.
  vehicle_directory: _projectVehicleDirectory(),
  driver_directory: _projectDriverDirectory(),
  driver_application_directory: _projectDriverApplicationDirectory(),
  vehicle_maintenance_directory: _projectVehicleMaintenanceDirectory(),
  // CLAIM-NETWORK-ZONES (Wave 1, Phase A). Mirrors public.zones /
  // public.zone_districts / public.zone_override_requests + branch_zones from
  // supabase/migrations/202512261200_zones_baskets.sql.
  //
  // W17-5 — registry key renamed from the legacy alias `network_zones` to the
  // canonical `zones` per `__audit__/DECISIONS/REGISTRY-ALIASES.md` §1 closure.
  // The legacy hub-keyed picker shape that previously occupied the `zones`
  // pass-through (sourced from `domain-routes.js`) was removed in the same
  // wave (no `useResourceList<>('zones')` consumer ever requested it).
  zones: seed.zones,
  zone_districts: seed.zone_districts,
  zone_override_requests: seed.zone_override_requests,
  branch_zones: seed.branch_zones,
  canonical_districts: seed.canonical_districts,
  // Phase C2 NETWORK gap fill: surface canonical_cities + geocoding_attempts
  // so `geocoding.tsx` Canonical + Policy tabs no longer silent-fail.
  // Backend SSOT: `public.canonical_cities` (202510110006_domain_tables_partitioned.sql:386)
  //               `public.geocoding_attempts` (202511130011_geocoding_attempts_table.sql:7)
  canonical_cities: seed.canonical_cities,
  geocoding_attempts: seed.geocoding_attempts,
  // Orchestrator patch: NETWORK-BRANCHES stalled before adding these. Mirrors
  // public.branches / branch_memberships / branch_capacity_windows /
  // branch_coverage_windows (supabase/migrations/202601212340_branches_coverage_foundation.sql).
  //
  // W18-1 — alias `branch_zone_links` was unified into the canonical
  // `branch_zones` entry above (closes __audit__/DECISIONS/REGISTRY-ALIASES.md
  // §2). The /network/branches surface and the /network/zones surface now
  // both consume `branch_zones` with the merged capability gate
  // (`branches.read` for read, `branches.write` for write — the canonical
  // write capability for `branch_zone_assign_v1`).
  branches: seed.branches,
  branch_memberships: seed.branch_memberships,
  branch_capacity_windows: seed.branch_capacity_windows,
  branch_coverage_windows: seed.branch_coverage_windows,
  // W11-2 — paired projection views `public.v_branch_summary` /
  // `public.v_zone_summary` (supabase/migrations/202604301400_v_branch_summary.sql,
  // 202604301410_v_zone_summary.sql). Read-only; SSOT remains branches/zones.
  // Production cutover: a single getSupabaseClient() branch in ui_list_resource_v1
  // returns the canonical projection — module call sites stay stable because
  // resolution is registry-driven. The seed-mode projections derive the FE
  // counters from the same seed slices the surface already consumes so demo
  // behavior is unchanged.
  branch_summary: _projectBranchSummary(),
  zone_summary: _projectZoneSummary(),
  zone_performance_metrics: _projectZonePerformanceMetrics(),
  // W18-3 — paired projection view `public.v_branch_capacity_heatmap`
  // (supabase/migrations/202604301420_v_branch_capacity_heatmap.sql).
  // Read-only; SSOT remains `public.branch_capacity_windows`. The
  // projection fans canonical (day_of_week, [window_start_local,
  // window_end_local)) ranges into per-hour heatmap cells with
  // (weekday, hour, capacity_units, booked_units). The FE heatmap on
  // `branches.tsx` reads through this projection so the renderer no
  // longer depends on FE-fictional `hour` / `capacity_units` columns
  // on the base table.
  branch_capacity_heatmap: _projectBranchCapacityHeatmap(),
  // W20 — paired projection view `public.v_branch_zone_directory`
  // (supabase/migrations/202604301800_v_branch_zone_directory.sql).
  // Read-only; SSOT remains `public.branch_zones`. Projects per-row
  // (branch_label, hub_code, branch_type, zone_label, zone_slug) from
  // the join branch_zones + branches + zones, closing the deferred §10
  // BranchZoneRow.branch_label projection in
  // __audit__/SCHEMA-DRIFT/NETWORK.md (W18-3 deferral).
  branch_zone_directory: _projectBranchZoneDirectory(),
  // CLAIM-NETWORK-MARKETPLACE (Wave 2, Phase B). Mirrors the canonical
  // marketplace lifecycle tables (offers / awards / contracts / requests /
  // request_items / request_kinds / availability_windows /
  // reputation_snapshots / events).
  //
  // W18-2 — alias unification (closes
  // `__audit__/DECISIONS/REGISTRY-ALIASES.md` §3): the previously-disjoint
  // `marketplace_contracts_v2` resource key has been collapsed back onto
  // the canonical `marketplace_contracts` key after `partners.tsx` was
  // migrated from the legacy partial-roster shape (id / participant_id /
  // start_date / end_date / status / terms_summary) to the canonical
  // lifecycle shape (started_at / ends_at / terms / award_id /
  // metadata.contract_no). The legacy partial-roster pass-through from
  // marketplace.js was retired in the same wave; both /network/partners
  // and /network/marketplace now read the same lifecycle projection.
  marketplace_offers: seed.marketplace_offers,
  marketplace_awards: seed.marketplace_awards,
  marketplace_contracts: seed.marketplace_contracts,
  marketplace_requests: seed.marketplace_requests,
  marketplace_request_items: seed.marketplace_request_items,
  marketplace_request_kinds: seed.marketplace_request_kinds,
  marketplace_availability_windows: seed.marketplace_availability_windows,
  marketplace_reputation_snapshots: seed.marketplace_reputation_snapshots,
  marketplace_events: seed.marketplace_events,
  // W13-4 — canonical participant graph (multi-table) + reputation event
  // ledger. Aligns the FE registry to the canonical schema in
  // supabase/migrations/202603071100_marketplace_network_foundation_v1.sql so
  // the participant drawer / reputation drawer consume the full graph instead
  // of the flat single-row shape that earlier audits flagged on
  // MarketplaceParticipantRow. Capability gate stays `marketplace.read` for
  // SELECT and `marketplace.write` for review actions; production swap is a
  // single getSupabaseClient() branch flip in `ui_list_resource_v1`.
  marketplace_participant_profiles: seed.marketplace_participant_profiles,
  marketplace_participant_memberships: seed.marketplace_participant_memberships,
  marketplace_participant_capabilities: seed.marketplace_participant_capabilities,
  marketplace_verification_records: seed.marketplace_verification_records,
  marketplace_reputation_events: seed.marketplace_reputation_events,
  // Phase D5 — non-driver marketplace participant onboarding queue. Mirrors
  // public.marketplace_participant_requests (canonical SSOT) per
  // supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:598
  // and is exposed via the registry resource declared in
  // 202603071140_marketplace_ui_access_v1.sql:198-212. Driver applications
  // (requested_participant_type_key='freelancer_driver') flow through the
  // Fleet domain surface; the /network/participant-applications module
  // surfaces every non-driver applicant type (provider_tenant /
  // partner_carrier / partner_fleet / …). The canonical review path is
  // marketplace_participant_request_review_apply_v1 (already wired in api.ts +
  // queries.ts under useReviewMarketplaceParticipantRequest).
  marketplace_participant_requests: seed.marketplace_participant_requests,
  // CLAIM-FINANCE-BILLING (Wave 2, Phase B). Mirrors the canonical billing
  // projection contract (billing_invoices / billing_invoice_lines /
  // billing_invoice_events / subscriptions / subscription_events /
  // usage_events / commercial_agreements / commercial_agreement_terms).
  // RLS gated by billing.read / billing.write / invoices.send /
  // invoices.refund (declared in the capability catalog in registry.js).
  billing_invoices: seed.billing_invoices,
  billing_invoice_lines: seed.billing_invoice_lines,
  billing_invoice_events: seed.billing_invoice_events,
  subscriptions: seed.subscriptions,
  subscription_events: seed.subscription_events,
  usage_events: seed.usage_events,
  commercial_agreements: seed.commercial_agreements,
  commercial_agreement_terms: seed.commercial_agreement_terms,
  // CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B). Mirrors the canonical service
  // catalog tables (public.service_levels + public.service_offerings) from
  // supabase/migrations/202601212700_branch_capacity_catalog.sql:68-180.
  // RLS write gate is `agreements.write` per
  // supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql;
  // surface aliases `service_offerings.read` / `service_offerings.write` are
  // declared in registry.js and granted alongside `agreements.write` in
  // seed.js (super_admin / ops_admin / account_manager).
  service_levels: seed.service_levels,
  service_offerings: seed.service_offerings,
  // CATALOG D3 close-out (W9-5). Mirrors public.lookup_definitions +
  // public.lookup_values from supabase/migrations/202510110003_mapping_lookup.sql
  // lines 12-66. Module call sites can now swap from `api.seed.lookupsModule()`
  // to `useResourceList('lookup_values')` and from `api.seed.lookupDefinitions()`
  // to `useResourceList('lookup_definitions')`.
  lookup_definitions: _lookupDefinitionsCatalog(),
  lookup_values: _lookupValuesCatalog(),
  // W31 — paired projection views for CATALOG:
  //   • public.v_service_offering_directory   (supabase/migrations/202604302900_v_service_offering_directory.sql)
  //   • public.v_service_level_directory      (supabase/migrations/202604302910_v_service_level_directory.sql)
  //   • public.v_lookup_definition_directory  (supabase/migrations/202604302920_v_lookup_definition_directory.sql)
  // Read-only; SSOT remains service_offerings / service_levels /
  // lookup_definitions / lookup_values. Production cutover: a single
  // getSupabaseClient() branch in ui_list_resource_v1 returns the canonical
  // projection — module call sites stay stable because resolution is
  // registry-driven. Seed-mode projections derive tenant_label / level_key /
  // branch_name / zone_label / display_name / display_slug / effective_status /
  // base_price / currency / max_weight_kg / active_subscription_count /
  // is_active_window / is_archived / is_draft (offering directory);
  // tenant_label / tier / priority_rank / sla_minutes / sla_label / color_token /
  // offering_count / active_offering_count / active_subscription_count
  // (level directory); value_count / active/draft/archived/retired splits /
  // default_value / default_value_label / has_default / last_value_updated_at
  // (lookup directory) so demo behavior is unchanged. Mirrors the
  // W11/W18/W20/W21/W22/W23/W24/W25/W26/W27/W28/W29/W30 paired-projection
  // pattern.
  service_offering_directory: _projectServiceOfferingDirectory(),
  service_level_directory: _projectServiceLevelDirectory(),
  lookup_definition_directory: _projectLookupDefinitionDirectory(),
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C). Mirrors the canonical API
  // gateway observability tables (public.api_call_log /
  // public.api_gateway_requests / public.api_gateway_rate_limits /
  // public.api_routes / public.api_route_packs / public.provider_health_logs).
  // RLS gated by api_gateway.read / api_gateway.write (declared in the
  // capability catalog in registry.js). Datadog APM / Honeycomb / Postman
  // observability parity surface.
  api_call_log: seed.api_call_log,
  api_gateway_requests: seed.api_gateway_requests,
  api_gateway_auth_rejections: seed.api_gateway_auth_rejections,
  api_gateway_rate_limits: seed.api_gateway_rate_limits,
  api_routes: seed.api_routes,
  api_route_packs: seed.api_route_packs,
  provider_health_logs: seed.provider_health_logs,
  // W14-2 — paired projection seeds backing the canonical SQL views
  // `public.v_api_gateway_observability` + `public.v_api_gateway_rate_limits_summary`.
  // FE consumers (`useResourceList<ApiCallRow>('api_gateway_observability')`
  // + `useResourceList<RateLimitRow>('api_gateway_rate_limits_summary')`)
  // close the W11/W13-deferred drift on `ApiCallRow` (8 REMOVE + 6 RENAME)
  // and `RateLimitRow` (4 REMOVE + 2 RENAME) per
  // `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1-§2`.
  api_gateway_observability: seed.api_gateway_observability,
  api_gateway_rate_limits_summary: seed.api_gateway_rate_limits_summary,
  // CLAIM-INSIGHTS-REPORTING (Phase F1). Mirrors public.kpi_definitions +
  // public.kpi_rollups_daily from
  // supabase/migrations/202601311830_kpi_catalog_rollups_v1.sql. /insights/
  // reporting cards consume `useKpiRollup(definition_key)` — every card now
  // resolves a real rollup row instead of a hardcoded literal.
  kpi_definitions: seed.kpi_definitions,
  kpi_rollups_daily: seed.kpi_rollups_daily,
  // W30 — paired projection seeds backing the canonical SQL views
  // `public.v_kpi_rollup_directory`, `public.v_decision_log_directory`,
  // `public.v_settings_resolution_directory`, and `public.v_ui_event_log_directory`.
  // FE consumers subscribe via canonical registry keys
  // (kpi_rollup_directory / decision_log_directory /
  //  settings_resolution_directory / ui_event_log_directory) so the
  // /insights/* surfaces resolve canonical join projections without per-row
  // jsonb digging in the FE. SSOT remains the canonical base tables;
  // production swap is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 and the surfaces stay registry-driven.
  // See `apps/console-v2/__audit__/SCHEMA-DRIFT/INSIGHTS.md`.
  kpi_rollup_directory: _projectKpiRollupDirectory(),
  decision_log_directory: _projectDecisionLogDirectory(),
  settings_resolution_directory: _projectSettingsResolutionDirectory(),
  ui_event_log_directory: _projectUiEventLogDirectory(),
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C). Mirrors the canonical alerting
  // tables (public.alert_rules + public.alert_triggers + public.ops_alerts).
  // RLS gated by alerts.read / alerts.write (declared in the capability
  // catalog in registry.js). The condition column on alert_rules round-trips
  // through the shared `_bindings/condition-model.ts` primitive (cross-module
  // reuse with workflow_bindings — see __audit__/COVERAGE/PLATFORM-ALERTS.md).
  alert_rules: seed.alert_rules,
  alert_triggers: seed.alert_triggers,
  ops_alerts: seed.ops_alerts,
  // W16-5 (CLAIM-PLATFORM-IMPORTS) — canonical import_jobs lifecycle SSOT.
  // Mirrors public.import_jobs from
  // supabase/migrations/202604301900_import_jobs.sql. RLS gated by
  // imports.read / imports.write (declared in registry.js capability
  // catalog). Submit / Cancel actions route through canonical RPCs
  // (import_job_create_v1 / import_job_cancel_v1 per
  // supabase/migrations/202604301905_import_job_rpcs_v1.sql). Replaces the
  // /platform/imports PREVIEW chip with a real DataTable.
  import_jobs: seed.import_jobs,
  // CLAIM-SUPPORT-CASES (Wave 3, Phase C). Mirrors the canonical support
  // projection tables (public.support_cases / public.support_messages /
  // public.support_case_events) from
  // supabase/migrations/202601311720_support_cases_foundation_v1.sql.
  // RLS gated by support.read / support.write. Operator user roster
  // `support_users` is exposed under its own key so the assignee picker +
  // queue avatar resolution can read it without a separate RPC call.
  //
  // Wave 5 RE-AUDIT (SUPPORT.md §8 D2) — `support_cases` is now keyed off
  // the `v_support_case_summary` registry relation (B3 migration
  // 202604271210). Seed rows already carry the computed fields
  // (`last_message_at`, `message_count`, `sla_breached`) so the seed-mode
  // payload mirrors the view shape; cloud cutover swaps the read seam to
  // the view without module-side change.
  support_cases: seed.support_cases,
  support_messages: seed.support_messages,
  support_case_events: seed.support_case_events,
  support_users: seed.support_users,
  // W26 — paired projection views for SUPPORT:
  //   • public.v_support_case_directory      (supabase/migrations/202604302400_v_support_case_directory.sql)
  //   • public.v_support_message_directory   (supabase/migrations/202604302410_v_support_message_directory.sql)
  // Read-only; SSOT remains support_cases / support_messages. Production
  // cutover: a single getSupabaseClient() branch in ui_list_resource_v1
  // returns the canonical projection — module call sites stay stable
  // because resolution is registry-driven. Seed-mode projections derive
  // client_label / sender_label / assignee_label / recipient_label /
  // shipment_tracking_number / last_message_at / message_count /
  // age_seconds / age_hours / is_open / is_terminal / resolution_label
  // (cases) and sent_at / author_role / author_label / has_artifact
  // (messages) so demo behavior is unchanged. Mirrors the W11/W18/W20/W21/W25
  // paired-projection pattern.
  support_case_directory: _projectSupportCaseDirectory(),
  support_message_directory: _projectSupportMessageDirectory(),
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C). Mirrors the canonical
  // public.feature_flags table (id, key, label, description, status ∈
  // {on, off, percentage}, rollout_percentage, targeting jsonb, scope_type,
  // scope_id, kill_switch, last_updated_at, last_updated_by_user_id). RLS
  // gated by feature_flags.read / feature_flags.write (declared in the
  // capability catalog in registry.js). LaunchDarkly / Unleash / GrowthBook
  // parity surface — `targeting.scopes` carries per-scope override entries so
  // the LadderViz can render the resolved Global → Tenant → Client → Sender
  // path without fabricating data at render time.
  feature_flags: seed.feature_flags,
  // W11-3 / W6-6 — paired projection view `public.v_feature_flag_summary`
  // (supabase/migrations/202604300100_v_feature_flag_summary.sql). Surfaces
  // FE-shaped derived fields (key/label/status/targeting/kill_switch/
  // owners/last_updated_at/last_updated_by_user_id).
  feature_flag_summary: _projectFeatureFlagSummary(),
  // CLAIM-IDENTITY-SESSIONS (Phase E2). Operator-visible auth sessions roster.
  // Architectural reality: Supabase manages user sessions in auth.sessions
  // (auth schema, server-internal). The recommended production SSOT is to
  // expose a tenant-scoped RLS view `public.user_sessions_v` that joins
  // auth.sessions with public.users for visibility. Demo mode synthesizes a
  // structurally identical row shape (mirrors auth.sessions + joined
  // public.users.email) so `useResourceList<UserSessionRow>('user_sessions')`
  // flips to a live read with a single getSupabaseClient() branch at cutover
  // (no module-side change). Capability gates (mirrored from registry.js):
  // `users.read` (self-only), `users.manage` (admin-wide). Per-row Revoke
  // routes through Phase B6 RPC `revoke_session_v1` (capability `users.manage`).
  user_sessions: seed.user_sessions,
  // CLAIM-PLATFORM-USERS (Phase D4). Operator-visible users roster. Mirrors
  // public.users (id, organization_id, email, full_name, user_type,
  // access_scope_type, access_scope_id, status, last_login_at, created_at)
  // per supabase/migrations/202510110002_configuration_core.sql:41-52 +
  // 202512291310_users_access_scope_model.sql:13-29. RLS gated by
  // `users.read` + `users.manage` (registry.js + dev_roles seed). Production
  // cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable.
  users: seed.users,
  // Fleet driver creation reads the same canonical users relation through the
  // fleet-scoped registry key so fleet.write operators can create driver
  // profiles without broad users.manage access.
  fleet_user_options: seed.users,
  // CLAIM-IDENTITY-RBAC (Phase E3). Mirrors public.rbac_roles +
  // public.rbac_role_permissions + public.rbac_user_role_assignments from
  // supabase/migrations/202601300030_rbac_foundation_v1.sql plus
  // public.rbac_role_templates from
  // supabase/migrations/202601300050_rbac_role_templates_v1.sql. Capability
  // gates `access_policy.read` (visibility) + `access_policy.approve` (mutate).
  rbac_roles: seed.rbac_roles,
  rbac_role_permissions: seed.rbac_role_permissions,
  rbac_user_role_assignments: seed.rbac_user_role_assignments,
  rbac_role_templates: seed.rbac_role_templates,
  capability_grant_requests: [],
  // W23 IDENTITY paired projection views — the FE consumes the canonical
  // SSOT columns through `useResourceList<...>('users')` etc., AND the
  // FE-shaped derived projections (organization_label, active_role_keys,
  // attestation_complete, …) through these new directory keys. Production
  // cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable.
  //   • public.v_user_directory                    (supabase/migrations/202604302200_v_user_directory.sql)
  //   • public.v_rbac_role_summary                 (supabase/migrations/202604302210_v_rbac_role_summary.sql)
  //   • public.v_tenant_signup_request_summary     (supabase/migrations/202604302220_v_tenant_signup_request_summary.sql)
  user_directory: _projectUserDirectory(),
  rbac_role_summary: _projectRbacRoleSummary(),
  tenant_signup_request_summary: _projectTenantSignupRequestSummary(),
  // CLAIM-OBJECTIVES-LADDER (Phase G3). Mirrors public.scope_type_registry
  // from supabase/migrations/202601301100_scope_registry_ssot.sql:24 + 267.
  // `ladder_rank` defines the canonical override-ladder ordering (Global 0 <
  // Tenant 10 < Client 20 < Sender 30 < Source/Resource 40). FE surfaces
  // (config.tsx + feature-flags.tsx) consume this through
  // `useResourceList('scope_type_registry')` instead of inline `SCOPE_RANK`
  // literals, eliminating the drift risk between two hand-maintained tables.
  scope_type_registry: seed.scope_type_registry,
  settings_category_registry: seed.settings_category_registry,
  // W56-B-2 closure (F6) — registry-driven seams for the legacy `api.seed.*`
  // accessors. Each entry maps the canonical seed-raw export through
  // `ui_list_resource_v1` so module call sites resolve via
  // `useResourceList<T>('<resource_key>')` instead of bypassing the typed
  // contract via the deprecated `api.seed.*` namespace. Production cutover is
  // a single getSupabaseClient() branch flip in `ui_list_resource_v1`.
  //
  // FINANCE — synthetic projection over finance_events + shipments/tasks/
  // route_runs. Source: src/lib/seed-raw/marketplace.js#cod_entries.
  cod_entries: seed.cod_entries,
  // PLATFORM - Planning OS read-only mirror of GitHub Project 6. Demo source:
  // src/lib/seed-raw/planning-os.js. Live source: backend-projected,
  // RLS-backed public.planning_os_project_items and
  // public.planning_os_execution_cards, refreshed by
  // scripts/ops/planning-os/sync-console-v2-mirror.js and read through
  // ui_list_resource_v1. The seed rows are only the no-backend fallback.
  planning_os_project_items: seed.project_items,
  planning_os_execution_cards: seed.execution_cards,
  // PLATFORM — Auth email URL policy mirror. Source:
  // src/lib/seed-raw/planning-os.js#auth_email_url_policy. Single-row config
  // surfaced as a 1-row list for registry uniformity. Production cutover
  // resolves through `auth_email_url_policy` settings ladder + CI workflow
  // sync (see .github/workflows/sync-auth-email-url.yml).
  auth_email_url_policy: seed.auth_email_url_policy
    ? [seed.auth_email_url_policy]
    : [],
  // PLATFORM - Release / same-SHA proof governance. Production resolves through
  // public.release_deploy_proof_governance_v1 via ui_list_resource_v1.
  release_deploy_proof_governance: seed.release_deploy_proof_governance,
  // PLATFORM — Warehouse transfer detail tables. Source:
  // src/lib/seed-raw/warehouse.js. Mirrors public.warehouse_transfer_items +
  // public.warehouse_checkpoint_scans. Exception holds are task projections in
  // live mode and must not be queried as a standalone registry resource.
  warehouse_transfer_items: seed.warehouse_transfer_items,
  warehouse_checkpoint_scans: seed.warehouse_checkpoint_scans,
  warehouse_exception_hold: seed.warehouse_exception_hold,
});

// The projection graph is only reachable in demo builds.
export const RESOURCE_DATA = SEED_MODE_ENABLED ? buildSeedResourceMap : (): ResourceMap => ({});

export interface ListOpts {
  filter?: Record<string, unknown>;
  sort?: { key: string; dir?: 'asc' | 'desc' };
  page?: number;
  page_size?: number;
}

export interface ListResult<T = ResourceRow> {
  rows: T[];
  total: number;
  page?: number;
  page_size?: number;
}

type LiveRpcError = { message?: string };
type LiveRpcResult<T> = { data: T | null; error: LiveRpcError | null };
type LiveRpcTarget = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<LiveRpcResult<T>>;
};
type LiveRpcClient = LiveRpcTarget & {
  schema?: (schema: string) => LiveRpcTarget;
};

export function liveRpcTarget(): LiveRpcTarget | null {
  const client = getSupabaseClient() as unknown as LiveRpcClient | null;
  if (!client) return null;
  return typeof client.schema === 'function' ? client.schema('api') : client;
}

export async function liveRpc<T = unknown>(
  rpcName: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null } | null> {
  const target = liveRpcTarget();
  if (!target) {
    if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError(`RPC ${rpcName}`);
    return null;
  }
  const { data, error } = await target.rpc<T>(rpcName, args);
  if (error) throw new Error(error.message ?? `RPC ${rpcName} failed`);
  return { data };
}

function isMissingLiveRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /could not find the function|function .* was not found|PGRST202/i.test(message);
}

function isStatementTimeoutLiveRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /canceling statement due to statement timeout|statement timeout|57014/i.test(message);
}

async function optionalLiveRpc<T = unknown>(
  rpcName: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null } | null> {
  try {
    return await liveRpc<T>(rpcName, args);
  } catch (error) {
    if (isMissingLiveRpcError(error)) return null;
    throw error;
  }
}

export function firstRpcRow<T = Record<string, unknown>>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] ?? null) as T | null;
  if (data && typeof data === 'object') return data as T;
  return null;
}

export function isRouteStopCloseoutTransition(toStatus: string, payload: Record<string, unknown>): boolean {
  if (toStatus.trim().toLowerCase() !== 'completed') return false;
  return Boolean(payload.delivery_completion || payload.route_stop_completion);
}

export async function finalizeRouteStopCloseoutEvent(taskEventId: string): Promise<void> {
  const result = await liveRpc('ui_finalize_route_stop_closeout_event_v1', {
    p_task_event_id: taskEventId,
  });
  const row = firstRpcRow<Record<string, unknown>>(result?.data);
  if (!row?.shipment_action_id) {
    throw new Error('route-stop closeout shipment_action readback unavailable');
  }
}

export function normalizeLiveListResult<T = ResourceRow>(
  data: unknown,
  page: number,
  pageSize: number,
): ListResult<T> {
  const rec = (data ?? {}) as Record<string, unknown>;
  const rowsSource = Array.isArray(rec.rows)
    ? rec.rows
    : Array.isArray(rec.items)
      ? rec.items
      : Array.isArray(rec.data)
        ? rec.data
        : Array.isArray(data)
          ? data
          : [];
  const limit = typeof rec.limit === 'number' ? rec.limit : pageSize;
  const offset = typeof rec.offset === 'number' ? rec.offset : page * pageSize;
  return {
    rows: rowsSource as T[],
    total: typeof rec.total === 'number' ? rec.total : rowsSource.length,
    page: typeof rec.page === 'number' ? rec.page : Math.floor(offset / Math.max(limit, 1)),
    page_size: typeof rec.page_size === 'number' ? rec.page_size : limit,
  };
}

function liveSort(sort?: { key: string; dir?: 'asc' | 'desc' }): Record<string, unknown> | null {
  if (!sort) return null;
  return { key: sort.key, direction: sort.dir ?? 'asc' };
}

export function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== ''),
  );
}

function primeLiveMetadata<T>(
  cacheKey: string,
  load: () => Promise<T | null>,
  apply: (value: T) => void,
): void {
  if (!getSupabaseClient() || liveMetadataPending.has(cacheKey)) return;
  liveMetadataPending.add(cacheKey);
  void load()
    .then((value) => {
      if (value !== null && value !== undefined) apply(value);
    })
    .catch(() => {
      // Synchronous helpers must preserve the seed/no-crash fallback. Async
      // query surfaces expose live errors through their own promises.
    })
    .finally(() => {
      liveMetadataPending.delete(cacheKey);
    });
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeLiveNavigationPayload(value: unknown): unknown {
  const rec = objectRecord(value);
  const app = String(rec.app ?? 'console');
  const sourceGroups =
    Array.isArray(rec.groups)
      ? rec.groups
      : Array.isArray(rec.sections)
        ? rec.sections
        : Array.isArray(objectRecord(objectRecord(rec.apps).console).sections)
          ? (objectRecord(objectRecord(rec.apps).console).sections as unknown[])
          : [];

  return {
    app,
    groups: sourceGroups.map((group) => {
      const g = objectRecord(group);
      const items = Array.isArray(g.items) ? g.items : [];
      return {
        ...g,
        id: String(g.id ?? g.key ?? ''),
        items: items.map((item) => {
          const row = objectRecord(item);
          return {
            ...row,
            key: String(row.key ?? row.id ?? ''),
            route: String(row.route ?? row.href ?? row.path ?? ''),
          };
        }),
      };
    }),
  };
}

function reconcileNavigationCapabilitiesFromReadRegistry(navigation: unknown, readRegistry: unknown): unknown {
  const nav = objectRecord(navigation);
  const groups = Array.isArray(nav.groups) ? nav.groups : [];
  const registry = objectRecord(readRegistry);

  return {
    ...nav,
    groups: groups.map((group) => {
      const g = objectRecord(group);
      const items = Array.isArray(g.items) ? g.items : [];
      return {
        ...g,
        items: items.map((item) => {
          const row = objectRecord(item);
          if (
            hasNonEmptyCapabilityValue(row.capability) ||
            hasNonEmptyCapabilityValue(row.capabilities) ||
            hasNonEmptyCapabilityValue(row.capability_any)
          ) {
            return row;
          }
          const resourceKey = String(row.resource ?? row.resource_key ?? '');
          const resource = objectRecord(registry[resourceKey]);
          const capabilityRead = typeof resource.capability_read === 'string'
            ? resource.capability_read.trim()
            : '';
          if (!resourceKey || !capabilityRead) return row;
          return {
            ...row,
            capability: capabilityRead,
            capabilities: [capabilityRead],
          };
        }),
      };
    }),
  };
}

function hasNonEmptyCapabilityValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((item) => typeof item === 'string' && item.trim().length > 0);
}

function normalizeRegistryPayload(value: unknown): Record<string, unknown> {
  const rec = objectRecord(value);
  const resourcesRecord = objectRecord(rec.resources);
  if (Object.keys(resourcesRecord).length > 0) return resourcesRecord;
  if (!Array.isArray(rec.resources)) return rec;
  return Object.fromEntries(
    rec.resources
      .map((resource) => objectRecord(resource))
      .filter((resource) => typeof resource.key === 'string' && resource.key)
      .map((resource) => [String(resource.key), resource]),
  );
}

function normalizeCommandRegistryPayload(value: unknown): unknown[] {
  const rec = objectRecord(value);
  if (Array.isArray(rec.commands)) return rec.commands;
  if (Array.isArray(value)) return value;
  return [];
}

function normalizeSettingsCategoryRow(row: Record<string, unknown>): SettingsCategoryRow {
  const metadata = objectRecord(row.metadata);
  const allowedScopes = Array.isArray(row.scopes)
    ? row.scopes
    : Array.isArray(row.allowed_scopes)
      ? row.allowed_scopes
      : Array.isArray(metadata.scopes)
        ? metadata.scopes
        : [];
  const category = String(row.category ?? row.key ?? '');
  return {
    ...row,
    category,
    domain: String(row.domain ?? metadata.domain ?? 'General'),
    scopes: allowedScopes.map((scope) => String(scope)),
    approval_required: Boolean(
      row.approval_required ??
      row.requires_approval ??
      row.side_effecting ??
      metadata.approval_required ??
      false,
    ),
    schema_id: String(row.schema_id ?? row.schema_category ?? metadata.schema_id ?? `${category}.v1`),
  };
}

function normalizeLookupRow(row: Record<string, unknown>): LookupOptionRow {
  const metadata = { ...objectRecord(row.metadata) };
  for (const key of ['next_status', 'icon', 'confirmation', 'destructive']) {
    if (metadata[key] === undefined && row[key] !== undefined) metadata[key] = row[key];
  }
  const rank = row.rank ?? row.sort_order ?? metadata.rank;
  return {
    value: String(row.value ?? ''),
    label: String(row.label ?? metadata.label ?? row.value ?? ''),
    tone: (row.tone ?? metadata.tone) as string | undefined,
    rank: typeof rank === 'number' ? rank : undefined,
    is_default: Boolean(row.is_default ?? metadata.is_default ?? false),
    metadata,
  };
}

async function loadLiveNavigation(): Promise<unknown | null> {
  const live = await liveRpc('ui_navigation_v1', { p_app: 'console' });
  return live ? normalizeLiveNavigationPayload(live.data) : null;
}

async function loadLiveReadRegistry(): Promise<unknown | null> {
  let live: { data: unknown | null } | null;
  try {
    live = await liveRpc('ui_read_registry_v1');
  } catch (error) {
    if (!isStatementTimeoutLiveRpcError(error)) throw error;
    live = await liveRpc('ui_read_registry_v1');
  }
  return live ? normalizeRegistryPayload(live.data) : null;
}

async function loadLiveCommandRegistry(): Promise<unknown[] | null> {
  const live = await liveRpc('ui_command_registry_v1');
  return live ? normalizeCommandRegistryPayload(live.data) : null;
}

async function loadLiveSettingsCategories(): Promise<SettingsCategoryRow[] | null> {
  const live = await ui_list_resource_v1<Record<string, unknown>>('settings_category_registry', {
    page_size: 500,
    sort: { key: 'category', dir: 'asc' },
  });
  return live.rows.map(normalizeSettingsCategoryRow);
}

async function loadLiveLookupRows(category: string): Promise<LookupOptionRow[] | null> {
  const canonical = await liveRpc<Record<string, unknown>[]>('list_lookup_values_v1', {
    p_category: category,
  });
  if (canonical) {
    return (Array.isArray(canonical.data) ? canonical.data : [])
      .map(normalizeLookupRow)
      .filter((row) => row.value);
  }
  const live = await ui_list_resource_v1<Record<string, unknown>>('lookup_values', {
    filter: { category, status: 'active' },
    page_size: 500,
    sort: { key: 'sort_order', dir: 'asc' },
  });
  return live.rows.map(normalizeLookupRow).filter((row) => row.value);
}

function normalizeLookupCatalogPayload(data: unknown): Record<string, LookupOptionRow[]> {
  const grouped: Record<string, LookupOptionRow[]> = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [category, rows] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      grouped[category] = rows
        .map((rawRow) => normalizeLookupRow(objectRecord(rawRow)))
        .filter((row) => row.value);
    }
    return grouped;
  }

  for (const rawRow of Array.isArray(data) ? data : []) {
    const rec = objectRecord(rawRow);
    const category = String(rec.category ?? '');
    if (!category) continue;
    const row = normalizeLookupRow(rec);
    if (!row.value) continue;
    grouped[category] ??= [];
    grouped[category].push(row);
  }
  return grouped;
}

async function loadLiveLookupCatalog(): Promise<Record<string, LookupOptionRow[]> | null> {
  const jsonCatalog = await optionalLiveRpc<Record<string, unknown>>('list_lookup_values_catalog_json_v1', {
    p_include_inactive: false,
  });
  if (jsonCatalog) return normalizeLookupCatalogPayload(jsonCatalog.data);

  const live = await optionalLiveRpc<Record<string, unknown>[]>('list_lookup_values_catalog_v1', {
    p_include_inactive: false,
  });
  if (!live) {
    const lookupRows = await ui_list_resource_v1<Record<string, unknown>>('lookup_values', {
      filter: { status: 'active' },
      page_size: 5000,
      sort: { key: 'category', dir: 'asc' },
    });
    return normalizeLookupCatalogPayload(lookupRows.rows);
  }
  return normalizeLookupCatalogPayload(live.data);
}

export async function hydrateConsoleLiveMetadata(): Promise<void> {
  if (!hasConsoleLiveBackend()) return;
  if (liveMetadataHydration) return liveMetadataHydration;

  liveMetadataHydration = (async () => {
    const [navigation, readRegistry, commandRegistry, settingsCategories, lookups] =
      await Promise.all([
        loadLiveNavigation(),
        loadLiveReadRegistry(),
        loadLiveCommandRegistry(),
        loadLiveSettingsCategories(),
        loadLiveLookupCatalog(),
      ]);

    if (readRegistry !== null && readRegistry !== undefined) setLiveReadRegistryCache(readRegistry);
    if (navigation !== null && navigation !== undefined) {
      setLiveNavigationCache(navigation);
    }
    if (commandRegistry !== null && commandRegistry !== undefined) liveMetadataCache.commandRegistry = commandRegistry;
    if (settingsCategories !== null && settingsCategories !== undefined) {
      liveMetadataCache.settingsCategories = settingsCategories;
    }
    if (lookups !== null && lookups !== undefined) liveMetadataCache.lookups = lookups;
    liveMetadataHydrationFailed = false;
  })().catch((error) => {
    liveMetadataHydrationFailed = true;
    clearLiveBootMetadataCache();
    liveMetadataHydration = null;
    throw error;
  });

  return liveMetadataHydration;
}

export async function loadLiveWorkflowTemplateId(templateKey: string): Promise<string | null> {
  const live = await ui_list_resource_v1<Record<string, unknown>>('workflow_templates', {
    filter: { template_key: templateKey, status: 'active' },
    page_size: 1,
  });
  const row = live.rows[0];
  const id = row?.id ?? row?.workflow_template_id ?? null;
  return typeof id === 'string' && id ? id : null;
}

export function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function nestedScopeId(input: Record<string, unknown>, key: string): string | null {
  const direct = input[key];
  if (typeof direct === 'string') return direct || null;
  if (direct && typeof direct === 'object') {
    const id = (direct as Record<string, unknown>).id;
    return typeof id === 'string' && id ? id : null;
  }
  return null;
}

export function normalizePolicyContext(scopeContext: Record<string, unknown> = state.scope): Record<string, unknown> {
  return compactRecord({
    ...scopeContext,
    organization_id:
      scopeContext.organization_id ??
      scopeContext.tenant_id ??
      nestedScopeId(scopeContext, 'tenant') ??
      state.user.organization_id ??
      null,
    client_id: scopeContext.client_id ?? nestedScopeId(scopeContext, 'client') ?? null,
    sender_id: scopeContext.sender_id ?? nestedScopeId(scopeContext, 'sender') ?? null,
    webhook_source_id:
      scopeContext.webhook_source_id ??
      scopeContext.source_id ??
      nestedScopeId(scopeContext, 'source') ??
      null,
    resource_id: scopeContext.resource_id ?? nestedScopeId(scopeContext, 'resource') ?? null,
  });
}

export function normalizeSettingsScope(scope: unknown): { scope_type: string; scope_id: string | null } {
  const rec = (scope && typeof scope === 'object' ? scope : {}) as Record<string, unknown>;
  if (typeof rec.scope_type === 'string') {
    return {
      scope_type: rec.scope_type,
      scope_id: typeof rec.scope_id === 'string' && rec.scope_id ? rec.scope_id : null,
    };
  }
  for (const key of ['resource', 'source', 'sender', 'client', 'tenant', 'global']) {
    const id = nestedScopeId(rec, key);
    if (key === 'global' || id) {
      return { scope_type: key, scope_id: key === 'global' ? null : id };
    }
  }
  return {
    scope_type: state.user.access_scope_type === 'platform' ? 'global' : state.user.access_scope_type,
    scope_id: state.user.access_scope_id ?? null,
  };
}

export async function getLiveShipmentClientId(shipmentId?: string | null): Promise<string | null> {
  if (!shipmentId) return null;
  const live = await liveRpc<Record<string, unknown> | null>('ui_get_resource_v1', {
    p_resource: 'shipments',
    p_id: shipmentId,
  });
  const row = live ? firstRpcRow<Record<string, unknown>>(live.data) : null;
  return (row?.client_id as string | undefined) ?? null;
}

export function normalizeDeliverySlotWindow(row: Record<string, unknown>): DeliverySlotWindow {
  const slotDate = String(row.slot_date ?? '');
  const start = String(row.window_start_local ?? '');
  const end = String(row.window_end_local ?? '');
  const capacityId = row.capacity_window_id ? String(row.capacity_window_id) : '';
  const rawRemaining = row.remaining ?? row.capacity_remaining;
  const remaining =
    rawRemaining == null || rawRemaining === ''
      ? null
      : Number(rawRemaining);
  return {
    window_id: capacityId || `win_${slotDate}_${start}_${end}`.replace(/[^a-zA-Z0-9]+/g, '_'),
    slot_date: slotDate,
    window_start_local: start,
    window_end_local: end,
    remaining: Number.isFinite(remaining) ? remaining : null,
  };
}

export async function ui_list_resource_v1<T = ResourceRow>(key: string, opts: ListOpts = {}): Promise<ListResult<T>> {
  const page_size = opts.page_size || 100;
  const page = opts.page || 0;
  const live = await liveRpc('ui_list_resource_v1', {
    p_resource: key === 'workflow_templates' ? 'workflow_templates_console' : key,
    p_filters: opts.filter ?? {},
    p_limit: page_size,
    p_offset: page * page_size,
    p_sort: liveSort(opts.sort),
  });
  if (live) {
    return normalizeLiveListResult<T>(live.data, page, page_size);
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_list_resource_v1');
  await sleep(40);
  // Wave 6 W6-3 + W54-F — registry-driven capability gate (fail-closed).
  // Every registered resource enforces the `capability_read` declared on
  // its `ui_read_registry` entry; the gate is derived from the registry
  // itself (not a hardcoded subset) so adding a registry entry
  // automatically enrolls the corresponding read seam in capability
  // gating. Module call sites resolving through `ui_list_resource_v1`
  // see a uniform `capability_denied` error on caps the caller lacks.
  //
  // Resilience clause: the gate still respects the precedent that a
  // registry entry with `capability_read` undefined or unknown to the
  // current capability registry is treated as ungated (fail-open). This
  // preserves the historical "preserve test stability" guarantee for
  // resource entries seeded ahead of the corresponding capability
  // catalog wave.
  const registry = (seed.ui_read_registry ?? {}) as Record<
    string,
    { capability_read?: string; capability_write?: string }
  >;
  const requiredCap = registry[key]?.capability_read;
  if (requiredCap && !hasCapability(requiredCap)) {
    const err = new Error(`Capability denied: ${requiredCap}`) as Error & {
      code?: string;
      capability?: string;
    };
    err.code = 'capability_denied';
    err.capability = requiredCap;
    throw err;
  }
  const data = RESOURCE_DATA()[key] || [];
  let rows = [...data];
  if (opts.filter) {
    const filter = opts.filter;
    rows = rows.filter((r) =>
      Object.entries(filter).every(([k, v]) => {
        if (v == null) return true;
        const rec = r as Record<string, unknown>;
        if (k === 'identifier' && (key === 'shipments' || key === 'shipment_directory')) {
          const needle = String(v).trim().toLowerCase();
          return [
            rec.id,
            rec.tracking_number,
            rec.client_reference_number,
            rec.carrier_reference_number,
          ].some((candidate) => String(candidate ?? '').trim().toLowerCase() === needle);
        }
        return rec[k] === v;
      }),
    );
  }
  if (opts.sort) {
    const { key: sortKey, dir = 'asc' } = opts.sort;
    rows.sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey] as unknown;
      const bv = (b as Record<string, unknown>)[sortKey] as unknown;
      if (av === bv) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return ((av as number | string) < (bv as number | string) ? -1 : 1) * (dir === 'asc' ? 1 : -1);
    });
  }
  return {
    rows: rows.slice(page * page_size, (page + 1) * page_size) as T[],
    total: rows.length,
    page,
    page_size,
  };
}

export async function ui_list_resource_complete<T = ResourceRow>(
  key: string,
  opts: ListOpts = {},
): Promise<ListResult<T>> {
  if (opts.page != null) return ui_list_resource_v1<T>(key, opts);

  const first = await ui_list_resource_v1<T>(key, { ...opts, page: 0 });
  const rows = [...first.rows];
  const total = Number.isFinite(first.total) ? Math.max(first.total, rows.length) : rows.length;
  const pageSize = first.page_size ?? first.rows.length;
  if (rows.length < total && (pageSize <= 0 || first.rows.length === 0)) {
    throw new Error(
      `ui_list_resource_complete(${key}) readback incomplete: received ${rows.length} of ${total} rows`,
    );
  }
  if (rows.length >= total) {
    return { ...first, rows, total, page: 0, page_size: rows.length };
  }

  const maxPages = Math.ceil(total / pageSize);
  for (let page = 1; page < maxPages && rows.length < total; page += 1) {
    const next = await ui_list_resource_v1<T>(key, {
      ...opts,
      page,
      page_size: pageSize,
    });
    if (next.rows.length === 0) {
      throw new Error(
        `ui_list_resource_complete(${key}) readback incomplete: page ${page} returned 0 rows after ${rows.length} of ${total}`,
      );
    }
    rows.push(...next.rows);
  }
  if (rows.length < total) {
    throw new Error(
      `ui_list_resource_complete(${key}) readback incomplete: received ${rows.length} of ${total} rows`,
    );
  }

  return {
    rows,
    total,
    page: 0,
    page_size: rows.length,
  };
}

export async function ui_get_resource_v1<T = ResourceRow>(key: string, id: string): Promise<T | null> {
  if (key === 'tabular_import_runs') {
    const detail = await liveRpc<T | null>('ui_get_tabular_import_run_v1', {
      p_run_id: id,
    });
    if (detail) {
      return firstRpcRow<T>(detail.data);
    }
  }

  const live = await liveRpc<T | null>('ui_get_resource_v1', {
    p_resource: key === 'workflow_templates' ? 'workflow_templates_console' : key,
    p_id: id,
  });
  if (live) {
    return firstRpcRow<T>(live.data);
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_get_resource_v1');
  await sleep(20);
  const list = RESOURCE_DATA()[key] || [];
  const row = list.find((r) => {
    const rec = r as Record<string, unknown>;
    return (
      rec.id === id ||
      rec.transfer_id === id ||
      rec.tracking_number === id ||
      rec.run_id === id ||
      rec.plan_id === id ||
      rec.task_id === id
    );
  });
  return (row ?? null) as T | null;
}

export async function ui_resource_metrics_v1(key: string, _opts: ListOpts = {}): Promise<{ total: number }> {
  const live = await liveRpc<Record<string, unknown>>('ui_resource_metrics_v1', {
    p_resource: key === 'workflow_templates' ? 'workflow_templates_console' : key,
    p_filters: _opts.filter ?? {},
    p_columns: null,
  });
  if (live) {
    const rec = (live.data ?? {}) as Record<string, unknown>;
    return {
      ...(rec as { total: number }),
      total: typeof rec.total === 'number' ? rec.total : 0,
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_resource_metrics_v1');
  await sleep(30);
  const list = RESOURCE_DATA()[key] || [];
  return { total: list.length };
}

function normalizeReadinessScopeType(scopeType?: string | null): UiOnboardingReadiness['scope_type'] {
  if (scopeType === 'global' || scopeType === 'tenant' || scopeType === 'client' || scopeType === 'sender') {
    return scopeType;
  }
  return 'tenant';
}

function buildSeedOnboardingReadiness(
  scopeType?: string | null,
  scopeId?: string | null,
): UiOnboardingReadiness {
  const normalizedScopeType = normalizeReadinessScopeType(scopeType);
  const settingsRows = ((seed.settings_category_registry ?? []) as unknown[]).filter(Boolean);
  const workflowRows = ((seed.workflow_bindings ?? []) as unknown[]).filter(Boolean);
  const pluginRows = ((seed.integration_plugins ?? []) as Array<Record<string, unknown>>).filter(Boolean);
  const pluginItems = pluginRows.map((plugin) => ({
    plugin_key: String(plugin.plugin_key ?? plugin.key ?? plugin.id ?? 'plugin'),
    plugin_name: String(plugin.name ?? plugin.plugin_name ?? plugin.plugin_key ?? plugin.id ?? 'Plugin'),
    status: String(plugin.status ?? 'healthy'),
    activation_mode: String(plugin.activation_mode ?? plugin.mode ?? 'auto_activate'),
    enabled: typeof plugin.enabled === 'boolean' ? plugin.enabled : true,
    credentials_status: String(plugin.credentials_status ?? 'healthy'),
    blocking: false,
  }));

  return {
    scope_type: normalizedScopeType,
    scope_id: scopeId ?? (normalizedScopeType === 'tenant' ? state.user.organization_id : null),
    organization_id: state.user.organization_id || null,
    generated_at: new Date().toISOString(),
    overall_status: 'healthy',
    healthy: true,
    settings_defaults: {
      status: 'healthy',
      healthy: true,
      required_count: settingsRows.length,
      present_count: settingsRows.length,
      missing_categories: [],
    },
    workflow_bindings: {
      status: 'healthy',
      healthy: true,
      baseline_profile: 'default',
      required_count: workflowRows.length,
      present_count: workflowRows.length,
      missing_stages: [],
    },
    integration_plugins: {
      status: 'healthy',
      healthy: true,
      baseline_profile: 'default',
      required_count: pluginItems.length,
      healthy_count: pluginItems.length,
      pending_credentials_count: 0,
      blocking_count: 0,
      items: pluginItems,
    },
    blocking_findings: [],
  };
}

export async function ui_get_onboarding_readiness_v1(
  argsOrScopeType?: { scope_type?: string | null; scope_id?: string | null } | string | null,
  scopeIdArg?: string | null,
): Promise<UiOnboardingReadiness> {
  const scopeType =
    typeof argsOrScopeType === 'object' && argsOrScopeType !== null
      ? argsOrScopeType.scope_type
      : argsOrScopeType;
  const scopeId =
    typeof argsOrScopeType === 'object' && argsOrScopeType !== null
      ? argsOrScopeType.scope_id
      : scopeIdArg;
  const live = await liveRpc<UiOnboardingReadiness>('ui_get_onboarding_readiness_v1', {
    p_scope_type: normalizeReadinessScopeType(scopeType),
    p_scope_id: scopeId ?? null,
  });
  if (live) {
    if (!live.data) throw new Error('ui_get_onboarding_readiness_v1 returned no readiness snapshot');
    return live.data;
  }

  await sleep(30);
  return buildSeedOnboardingReadiness(scopeType, scopeId);
}

export async function ui_execute_onboarding_bootstrap_v1(args: {
  scope_type?: string | null;
  scope_id?: string | null;
}): Promise<Record<string, unknown>> {
  const scopeType = normalizeReadinessScopeType(args.scope_type);
  const scopeId = asNonEmptyString(args.scope_id);
  const live = await liveRpc<Record<string, unknown>>('ui_execute_onboarding_bootstrap_v1', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_onboarding_bootstrap_v1', [
      'readiness',
      'bootstrap_run_id',
      'workflow_run_id',
    ]);
    return {
      ...rec,
      ok: true,
      scope_type: String(rec.scope_type ?? scopeType),
      scope_id: String(rec.scope_id ?? scopeId),
    };
  }

  await sleep(30);
  return {
    ok: true,
    scope_type: scopeType,
    scope_id: scopeId,
    readiness: buildSeedOnboardingReadiness(scopeType, scopeId),
  };
}

export async function ui_get_shipment_timeline_v1(shipmentId: string): Promise<ShipmentTimelineRow[]> {
  const live = await liveRpc('ui_get_shipment_timeline_v1', {
    p_shipment_id: shipmentId,
  });
  if (live) return normalizeShipmentTimelineRows(live.data);

  await sleep(60);
  return normalizeShipmentTimelineRows(seed.shipmentTimeline(shipmentId));
}

// ----------- Dashboard projection (mirrors a planned api.ui_resource_metrics_v1('dashboard_kpis')) -----------
export async function dashboardKpis(): Promise<
  Array<{ label: string; key: string; value: number | string; delta?: string; tone?: string; spark?: number[] }>
> {
  const { dashboardKpis } = await import('./data-source/insights');
  return dashboardKpis();
}

// ----------- KPI rollup resolver (Phase F1 / CLAIM-INSIGHTS-REPORTING) -----------
//
// Resolves the most-recent rollup row for a given canonical KPI key from
// `public.kpi_rollups_daily` and joins it with the matching
// `public.kpi_definitions` row so the FE can render a typed card without
// inventing tone thresholds, units, or delta strings. Mirrors the canonical
// projection contract in
// supabase/migrations/202601311830_kpi_catalog_rollups_v1.sql.
//
// Production cutover plan: when a canonical `compute_kpi_rollup_v1` RPC ships
// the live branch routes through `client.rpc(...)`. Until then, the adapter
// falls through to a direct read from the registered resources
// (`kpi_definitions` + `kpi_rollups_daily`) — same shape either way.
export interface KpiRollupResolution {
  kpi_key: string;
  label: string;
  group: string;
  value_num: number | null;
  numerator: number | null;
  denominator: number | null;
  format: string;
  unit: string | null;
  tone: 'good' | 'warn' | 'danger' | 'info' | 'neutral';
  delta: string | null;
  day: string | null;
  scope_organization_id: string | null;
  settings_resolution_id: string;
}

export interface ComputeKpiRollupArgs {
  definition_key: string;
  day?: string;
  window_days?: number;
  scope?: { organization_id?: string | null } | null;
}

export async function compute_kpi_rollup_v1(
  args: ComputeKpiRollupArgs,
): Promise<KpiRollupResolution> {
  const { compute_kpi_rollup_v1 } = await import('./data-source/insights');
  return compute_kpi_rollup_v1(args);
}

// ----------- Bank account balance projection (W11-1 / W8-4 paired) -----------
//
// Facade over canonical projection RPC `public.compute_bank_account_balance_v1`
// (migration 202604301110_compute_bank_account_balance_v1.sql).
//
// Projects the three FE-derived totals — `balance`, `last_match_at`,
// `open_items` — that previously lived directly on the FE `BankAccountRow`
// interface. With the canonical projection RPC shipped in W8-4, the FE row
// interface drops these derived fields and modules consume them through the
// paired hook `useBankAccountBalance(account_id)` (queries.ts).
//
// Production swap: a single `getSupabaseClient()` branch routes through
// `client.rpc('compute_bank_account_balance_v1', { p_args: { bank_account_id } })`.
// The fallback (in-memory mode) computes balance/open_items/last_match_at
// from the same seed sources the bank_recon module already reads
// (`bank_accounts`, `finance_events_bank_statement`, `bank_recon_matches`)
// so demo behavior stays identical to the live projection contract.
export interface BankAccountBalanceResult {
  ok: true;
  bank_account_id: string;
  organization_id: string | null;
  currency: string | null;
  balance: number;
  last_match_at: string | null;
  open_items: number;
  correlation_id?: string;
  settings_resolution_id?: string;
}

export interface ComputeBankAccountBalanceArgs {
  bank_account_id: string;
}

export async function compute_bank_account_balance_v1(
  args: ComputeBankAccountBalanceArgs,
): Promise<BankAccountBalanceResult> {
  const { compute_bank_account_balance_v1 } = await import('./data-source/insights');
  return compute_bank_account_balance_v1(args);
}

// ----------- Settings + ladder -----------
export interface SettingsResolutionResult {
  value: unknown;
  resolved_from: string;
  ladder_path: Array<{
    rank: number;
    scope_type: string;
    scope_id: string | null;
    has_value: boolean;
    version?: unknown;
    value?: unknown;
  }>;
  settings_resolution_id: string;
  override_of: unknown;
}

export interface MobilePolicyResolutionResult {
  category: string;
  value: unknown;
  resolved_from: string;
  ladder_path: Array<{
    rank: number;
    scope_type: string;
    scope_id: string | null;
    has_value: boolean;
    value: unknown;
  }>;
  settings_resolution_id: string;
  override_of: string | null;
  resolver: string;
}

export async function resolveSettings(
  category: string,
  scopeContext: Record<string, unknown> = state.scope,
): Promise<SettingsResolutionResult> {
  const { resolveSettings } = await import('./data-source/settings');
  return resolveSettings(category, scopeContext);
}

// Mobile policies share the canonical ladder shape with `resolveSettings` so
// the same `LadderViz` primitive can render them. Live mode calls the
// category-specific api-schema resolver (`resolve_<category>`). Seed mode keeps
// the local `mobile_policy_resolved` snapshot as the fallback.
export async function resolveMobilePolicy(
  category: string,
  scopeContext: Record<string, unknown> = state.scope,
): Promise<MobilePolicyResolutionResult | null> {
  const { resolveMobilePolicy } = await import('./data-source/settings');
  return resolveMobilePolicy(category, scopeContext);
}

// ----------- Access control policy resolver -----------
//
// CLAIM-IDENTITY-CAPS — frontend-side adapter for the canonical evaluator
// `public.resolve_access_control_policy_v1` (defined in
// supabase/migrations/202601022113_access_control_policy_core.sql:554). The
// canonical RPC RETURNS:
//   (policy JSONB, settings_id UUID, settings_version_id UUID,
//    scope_type TEXT, scope_id UUID, scope_path JSONB,
//    settings_resolution_id UUID)
//
// Live mode (env wired): the seam branches into `client.rpc(...)`.
// Demo mode (no env): synthesizes a representative resolution from the FE
// seed (`dev_roles` + capability catalog + ui_read_registry) so the surface
// continues to work without any backend env vars. The shape is bound to
// the canonical contract so swapping is a pure environment change.
export interface AccessPolicyResolutionResult {
  policy: unknown;
  settings_id: string;
  settings_version_id: string;
  scope_type: string;
  scope_id: string | null;
  scope_path: Array<{ scope_type: string; scope_id: string | null }>;
  settings_resolution_id: string;
}

export async function resolve_access_control_policy_v1(
  args: { scope_type?: string; scope_id?: string | null } = {},
): Promise<AccessPolicyResolutionResult> {
  const { resolve_access_control_policy_v1 } = await import('./data-source/settings');
  return resolve_access_control_policy_v1(args);
}

// ----------- Per-capability evaluator (LadderViz drilldown) -----------
//
// CLAIM-IDENTITY-CAPS / Phase E4 — frontend-side adapter for the canonical
// evaluator `public.user_capability_eval_v1` (defined in
// supabase/migrations/202601022113_access_control_policy_core.sql:764). The
// canonical RPC RETURNS a JSONB envelope:
//   { allowed, reason, capability_key, scope_type, scope_id, role_keys,
//     granted_capabilities, policy_source: { settings_id, settings_version_id,
//     policy_scope_type, policy_scope_id, scope_path } }
//
// Live mode (env wired): the seam branches into `client.rpc(...)`.
// Demo mode (no env): synthesizes a representative evaluation using the
// in-memory access-control resolver + capability set so the drilldown UI
// (`<CapabilityEvalDrilldown>`) keeps working without backend env vars.
// The shape is bound to the canonical contract so swapping is a pure
// environment change.
export interface UserCapabilityEvalPolicySource {
  settings_id?: string;
  settings_version_id?: string;
  policy_scope_type?: string;
  policy_scope_id?: string | null;
  scope_path?: Array<{ scope_type: string; scope_id: string | null }>;
}
export interface UserCapabilityEvalResult {
  allowed: boolean;
  reason: string;
  capability_key: string;
  scope_type: string;
  scope_id: string | null;
  role_keys: string[];
  granted_capabilities: string[];
  policy_source: UserCapabilityEvalPolicySource;
}
export interface UserCapabilityEvalArgs {
  capability_key: string;
  scope_type?: string;
  scope_id?: string | null;
  /** See api.ts — only used by the in-memory adapter. */
  user_id?: string;
}

export async function user_capability_eval_v1(
  args: UserCapabilityEvalArgs,
): Promise<UserCapabilityEvalResult> {
  const { user_capability_eval_v1 } = await import('./data-source/settings');
  return user_capability_eval_v1(args);
}

export async function proposeSettingsChange(
  category: string,
  scope: unknown,
  value: unknown,
  opts: { dryRun?: boolean; justification?: string } = {},
): Promise<{
  diff: { from: string; to: unknown };
  blast_radius: string;
  approval_required: boolean;
  settings_resolution_id: string;
  dry_run: boolean;
  justification: string | null;
}> {
  const { proposeSettingsChange } = await import('./data-source/settings');
  return proposeSettingsChange(category, scope, value, opts);
}

export interface ApplySettingsValueResult {
  ok: boolean;
  applied: boolean;
  category: string;
  scope_type: string;
  scope_id: string | null;
  settings_id?: string;
  settings_version_id: string;
  settings_version_number?: number;
  settings_resolution_id: string;
  domain_event_id?: string;
}

export async function applySettingsValue(
  category: string,
  scope: unknown,
  value: unknown,
  opts: { justification?: string } = {},
): Promise<ApplySettingsValueResult> {
  const { applySettingsValue } = await import('./data-source/settings');
  return applySettingsValue(category, scope, value, opts);
}

// ----------- Decision / Resolution / UI Event / Audit -----------
export type LogFilter = {
  category?: string;
  id?: string;
  resource_id?: string;
  resource_type?: string;
  limit?: number;
};

export async function listDecisionLog(filters: LogFilter = {}): Promise<Record<string, unknown>[]> {
  const pageSize = filters.limit ?? 50;
  const liveFilters: Record<string, unknown> = {};
  if (filters.category) liveFilters.decision_category = filters.category;
  if (filters.id) liveFilters.id = filters.id;
  if (filters.resource_id) liveFilters.resource_id = filters.resource_id;
  if (filters.resource_type) liveFilters.resource_type = filters.resource_type;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'decision_log',
    p_filters: liveFilters,
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'timestamp', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows;
  }

  await sleep(30);
  let rows = [...((seed.decision_log as Record<string, unknown>[]) ?? [])];
  if (filters.category) rows = rows.filter((r) => (r as { decision_category?: string }).decision_category === filters.category);
  if (filters.id) rows = rows.filter((r) => String((r as { id?: unknown }).id ?? '') === filters.id);
  if (filters.resource_id) rows = rows.filter((r) => String((r as { resource_id?: unknown }).resource_id ?? '') === filters.resource_id);
  if (filters.resource_type) rows = rows.filter((r) => String((r as { resource_type?: unknown }).resource_type ?? '') === filters.resource_type);
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
}

export async function listResolutionLog(filters: LogFilter = {}): Promise<Record<string, unknown>[]> {
  const { listResolutionLog } = await import('./data-source/insights');
  return listResolutionLog(filters);
}
export async function listAuditLog(filters: { limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const { listAuditLog } = await import('./data-source/insights');
  return listAuditLog(filters);
}
export async function listUiEventLog(filters: { limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const { listUiEventLog } = await import('./data-source/insights');
  return listUiEventLog(filters);
}

export function streamEvidence(callback: EvidenceCallback): () => void {
  const client = getSupabaseClient();
  if (client) {
    let cancelled = false;
    const seen = new Set<string>();
    const emitRows = (rows: Record<string, unknown>[]) => {
      for (const row of rows.slice().reverse()) {
        const key = String(row.id ?? row.decision_log_id ?? row.timestamp ?? JSON.stringify(row));
        if (seen.has(key)) continue;
        seen.add(key);
        callback(row);
      }
    };

    void listDecisionLog({ limit: 5 })
      .then((rows) => {
        if (!cancelled) emitRows(rows);
      })
      .catch(() => {
        // Evidence stream is best-effort; dashboard/statusbar reads must not crash.
      });

    const realtimeEnabled =
      (import.meta.env.VITE_REALTIME_ENABLED as string | undefined) === 'true' ||
      (import.meta.env.VITE_REALTIME_ENABLED as string | undefined) === '1';
    let channel: unknown = null;
    if (realtimeEnabled && typeof (client as { channel?: unknown }).channel === 'function') {
      channel = (client as {
        channel: (name: string) => {
          on: (
            event: string,
            filter: Record<string, unknown>,
            handler: (payload: { new?: Record<string, unknown> | null }) => void,
          ) => { subscribe: () => unknown };
        };
      })
        .channel('decision_log:evidence')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'decision_log' },
          (payload) => {
            if (payload.new) emitRows([payload.new]);
          },
        )
        .subscribe();
    }

    const intervalId = realtimeEnabled
      ? null
      : globalThis.setInterval(() => {
          void listDecisionLog({ limit: 1 })
            .then((rows) => {
              if (!cancelled) emitRows(rows);
            })
            .catch(() => {
              // best-effort polling fallback
            });
        }, 15000);

    return () => {
      cancelled = true;
      if (intervalId !== null) globalThis.clearInterval(intervalId);
      try {
        if (channel && typeof (channel as { unsubscribe?: () => unknown }).unsubscribe === 'function') {
          (channel as { unsubscribe: () => unknown }).unsubscribe();
        }
        const remove = (client as { removeChannel?: (c: unknown) => unknown }).removeChannel;
        if (channel && typeof remove === 'function') remove.call(client, channel);
      } catch {
        // teardown is best-effort
      }
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('streamEvidence');
  state.evidence_subscribers.add(callback);
  // Emit the last few decisions immediately
  ((seed.decision_log as Record<string, unknown>[]) ?? [])
    .slice(0, 5)
    .reverse()
    .forEach((d, i) => {
      setTimeout(() => callback(d), 200 + i * 80);
    });
  return () => {
    state.evidence_subscribers.delete(callback);
  };
}

// ----------- Driver hours-of-service (canonical accessor) ------------
// W34c — replaces the direct `seed-raw/fleet-drivers.js` import in
// `operate/fleet/drivers.tsx`. Routes through the data-source seam so
// the live cutover swaps in `resolve_driver_hours_of_service_v1(driver_id)`
// without changing any consumer call site. The shape mirrors the FE
// projection consumed by the drivers studio (today + week_total).
// Mirrors HoursOfServiceMeter.DutySegment (canonical contract).
export interface DriverHoursOfServiceTodaySegment {
  type: 'driving' | 'on_duty' | 'off_duty' | 'sleeper';
  durationMinutes: number;
}

export interface DriverHoursOfServiceRecord {
  today: DriverHoursOfServiceTodaySegment[];
  week_total: { driving: number; on_duty: number; off_duty: number; sleeper: number };
}

function normalizeDriverHoursOfServiceRecord(value: unknown): DriverHoursOfServiceRecord | null {
  const rec = objectRecord(value);
  const todaySource = Array.isArray(rec.today) ? rec.today : [];
  const today = todaySource
    .map((segment) => {
      const row = objectRecord(segment);
      const type = asNonEmptyString(row.type ?? row.duty_status);
      const durationRaw = row.durationMinutes ?? row.duration_minutes;
      const durationMinutes =
        typeof durationRaw === 'number'
          ? durationRaw
          : Number.parseInt(String(durationRaw ?? ''), 10);
      if (
        type !== 'driving' &&
        type !== 'on_duty' &&
        type !== 'off_duty' &&
        type !== 'sleeper'
      ) {
        return null;
      }
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
      return { type, durationMinutes } as DriverHoursOfServiceTodaySegment;
    })
    .filter((segment): segment is DriverHoursOfServiceTodaySegment => segment !== null);
  const week = objectRecord(rec.week_total);
  return {
    today,
    week_total: {
      driving: Number(week.driving ?? 0) || 0,
      on_duty: Number(week.on_duty ?? 0) || 0,
      off_duty: Number(week.off_duty ?? 0) || 0,
      sleeper: Number(week.sleeper ?? 0) || 0,
    },
  };
}

export async function loadLiveDriverHoursOfService(
  driverId: string,
): Promise<DriverHoursOfServiceRecord | null> {
  if (!driverId.trim()) return null;
  const live = await liveRpc<unknown>('resolve_driver_hours_of_service_v1', {
    p_driver_id: driverId,
  });
  return normalizeDriverHoursOfServiceRecord(live?.data ?? null);
}

export function resolve_driver_hours_of_service_v1(
  driver_id: string,
): DriverHoursOfServiceRecord | null {
  const cached = liveMetadataCache.driverHoursOfService[driver_id];
  if (cached !== undefined) return cached;

  const map = ((seed as Record<string, unknown>).driver_hours_of_service ?? {}) as Record<
    string,
    DriverHoursOfServiceRecord | undefined
  >;
  if (getSupabaseClient()) {
    primeLiveMetadata(
      `driver_hos:${driver_id}`,
      () => loadLiveDriverHoursOfService(driver_id),
      (value) => {
        liveMetadataCache.driverHoursOfService[driver_id] = value;
      },
    );
    return SEED_MODE_ENABLED ? map[driver_id] ?? null : null;
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC resolve_driver_hours_of_service_v1');
  return map[driver_id] ?? null;
}

export async function read_driver_hours_of_service_v1(
  driver_id: string,
): Promise<DriverHoursOfServiceRecord | null> {
  const { read_driver_hours_of_service_v1 } = await import('./data-source/fleet');
  return read_driver_hours_of_service_v1(driver_id);
}

// ----------- Zone performance metrics (canonical accessor) ------------
// W54-E — replaces the direct `seed-raw/network-zones.js` import in
// `network/zones.tsx` (the `zone_performance_metrics` map). Routes through
// the data-source seam so the live cutover can swap to the materialized
// view `mv_zone_performance_v1` projection (or canonical RPC) without
// changing any consumer call site. Mirrors the W34c
// `resolve_driver_hours_of_service_v1` pattern.
export interface ZonePerformanceMetricsRecord {
  shipments_today: number;
  shipments_week: number;
  on_time_pct: number | null;
  capacity_saturation_pct: number;
  spark_today: number[];
  spark_week: number[];
}

export function resolve_zone_performance_metrics_v1(
  zone_id: string,
): ZonePerformanceMetricsRecord | null {
  const map = ((seed as Record<string, unknown>).zone_performance_metrics ?? {}) as Record<
    string,
    ZonePerformanceMetricsRecord | undefined
  >;
  return map[zone_id] ?? null;
}

// W34c — canonical task_type_catalog default-actions accessor. Replaces the
// inline `TASK_TYPE_DEFAULT_ACTIONS` Record literal in
// `modules/workflows/_review-queue/views.ts`. Live cutover swaps to the
// backend RPC `resolve_task_type_default_actions_v1(task_type)`.
export function resolve_task_type_default_actions_v1(task_type: string): string[] {
  const rows = ((seed as Record<string, unknown>).task_type_catalog ?? []) as Array<{
    task_type?: string;
    default_actions?: string[];
  }>;
  const row = rows.find((r) => r.task_type === task_type);
  return Array.isArray(row?.default_actions) ? (row?.default_actions as string[]) : [];
}

// W34c — canonical workflow template id resolver. Modules pass the canonical
// `template_key` (e.g. 'cod_driver_shift_settlement_v2') and receive the
// effective template id for the current execution mode. In demo mode the
// FE seed uses workspace ids (`tpl_*`); in live mode the backend RPC swap
// returns the canonical UUID. Replaces the inline `99990000-...` UUID
// literals previously present in finance/bank-recon.tsx + finance/cod.tsx.
export function resolve_workflow_template_id_v1(template_key: string): string | null {
  if (!template_key) return null;
  if (liveMetadataCache.workflowTemplateIds[template_key] !== undefined) {
    return liveMetadataCache.workflowTemplateIds[template_key];
  }
  const rows = ((seed as Record<string, unknown>).workflow_templates ?? []) as Array<{
    id?: string;
    template_key?: string;
    canonical_uuid?: string;
  }>;
  const row = rows.find((r) => r.template_key === template_key);
  const seedValue = row?.canonical_uuid ?? row?.id ?? null;
  primeLiveMetadata(`workflow_template:${template_key}`, () => loadLiveWorkflowTemplateId(template_key), (value) => {
    liveMetadataCache.workflowTemplateIds[template_key] = value;
  });
  if (!row) {
    return getSupabaseClient() ? template_key : null;
  }
  // Always prefer `canonical_uuid` (cloud SSOT identity). The start-run
  // seam accepts either the canonical UUID or the FE seed `id`, so the
  // returned value is stable across demo/live mode and tests can assert
  // against the canonical UUID.
  return seedValue;
}

// ----------- Tasks -----------
export type TaskFilter = { task_type?: string; assigned_to?: string; at_risk?: boolean };

export async function listTasks(filters: TaskFilter = {}): Promise<Record<string, unknown>[]> {
  const { listTasks } = await import('./data-source/tasks');
  return listTasks(filters);
}
export async function transition_task_v1(
  taskId: string,
  transition: { next_status?: string; payload?: Record<string, unknown>; [k: string]: unknown },
): Promise<{ ok: true; task: Record<string, unknown> | undefined; task_event_id?: string | null }> {
  const { transition_task_v1 } = await import('./data-source/tasks');
  return transition_task_v1(taskId, transition);
}

export async function resolve_manual_review_task_v1(
  taskId: string,
  resolution: { resolution_outcome?: string; resolution_notes?: string | null },
): Promise<Record<string, unknown>> {
  const { resolve_manual_review_task_v1 } = await import('./data-source/tasks');
  return resolve_manual_review_task_v1(taskId, resolution);
}

export interface AssignTaskArgs extends Record<string, unknown> {
  task_id: string;
  assigned_to: string;
  idempotency_key?: string | null;
  notes?: string | null;
}

export interface OpenOpsSessionArgs extends Record<string, unknown> {
  session_type: string;
  branch_id?: string | null;
  session_code?: string | null;
  idempotency_key: string;
  metadata?: Record<string, unknown>;
}

export interface OpenOpsSessionResult extends Record<string, unknown> {
  ops_session_id: string;
  created: boolean;
}

export async function assign_task_v1(
  args: AssignTaskArgs,
): Promise<{ task_id: string; task_event_id: string | null; task?: Record<string, unknown> }> {
  const { assign_task_v1 } = await import('./data-source/tasks');
  return assign_task_v1(args);
}

export async function open_ops_session_v1(args: OpenOpsSessionArgs): Promise<OpenOpsSessionResult> {
  const { open_ops_session_v1 } = await import('./data-source/tasks');
  return open_ops_session_v1(args);
}

// ----------- Shipments -----------
export interface UiCreateShipmentArgs extends Record<string, unknown> {
  client_id?: string | null;
  organization_id?: string | null;
  sender_id?: string | null;
  recipient_id?: string | null;
  new_recipient?: Record<string, unknown> | null;
  destination_address?: Record<string, unknown> | null;
  service_type?: string | null;
  service_offering_id?: string | null;
  tracking_number?: string | null;
  client_reference_number?: string | null;
  carrier_reference_number?: string | null;
  status?: string | null;
  cod_amount?: number | null;
  cod_currency?: string | null;
  promised_delivery_date?: string | null;
  promised_window_start_at?: string | null;
  promised_window_end_at?: string | null;
  priority_score?: number | null;
  metadata?: Record<string, unknown> | null;
  dry_run?: boolean;
}

export interface UiCreateShipmentResult extends Record<string, unknown> {
  status: string;
  workflow_template_id?: string | null;
  workflow_run_id?: string | null;
  workflow_status?: string | null;
  correlation_id?: string | null;
  shipment_id?: string | null;
  tracking_number?: string | null;
  operation?: string | null;
  recipient_id?: string | null;
  label_job_id?: string | null;
  address_workflow_run_id?: string | null;
  dry_run?: boolean;
}

export async function ui_create_shipment_v1(
  args: UiCreateShipmentArgs,
): Promise<UiCreateShipmentResult> {
  const { ui_create_shipment_v1 } = await import('./data-source/shipments');
  return ui_create_shipment_v1(args);
}

export async function shipment_amend_cancel_v1(
  shipmentId: string,
  op: string | Record<string, unknown>,
  payload: Record<string, unknown> = {},
  opts: { dryRun?: boolean } = {},
): Promise<{
  ok: true;
  workflow_template: string;
  workflow_run_id: string;
  started_via: string;
  canonical_entrypoint: string;
  dry_run: boolean;
  diff: Record<string, unknown> | null;
  settings_resolution_id: string;
}> {
  const { shipment_amend_cancel_v1 } = await import('./data-source/shipments');
  return shipment_amend_cancel_v1(shipmentId, op, payload, opts);
}

export async function shipment_amend_cancel_options_v1(
  shipmentId: string,
): Promise<Record<string, unknown>> {
  const { shipment_amend_cancel_options_v1 } = await import('./data-source/shipments');
  return shipment_amend_cancel_options_v1(shipmentId);
}
export interface ShipmentResortResult extends Record<string, unknown> {
  ok: true;
  status?: string;
  basket_policy_applied: boolean;
}

export function backendOutcomeError(rec: Record<string, unknown>, fallback: string): Error | null {
  if (rec.ok === false) {
    const rawError = rec.error;
    if (typeof rawError === 'string' && rawError.trim()) return new Error(rawError);
    if (rawError && typeof rawError === 'object') {
      const error = rawError as Record<string, unknown>;
      const code = typeof error.code === 'string' && error.code.trim() ? error.code : '';
      const message = typeof error.message === 'string' && error.message.trim() ? error.message : '';
      return new Error(message || code || fallback);
    }
    return new Error(fallback);
  }
  const status = typeof rec.status === 'string' ? rec.status.toLowerCase() : '';
  if (['blocked', 'failed', 'error', 'rejected'].includes(status)) {
    const reason =
      typeof rec.reason === 'string' && rec.reason.trim()
        ? rec.reason
        : typeof rec.message === 'string' && rec.message.trim()
          ? rec.message
          : fallback;
    return new Error(reason);
  }
  return null;
}

function backendFailureText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const rec = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'reason', 'failure_reason', 'last_error', 'code']) {
    const text = backendFailureText(rec[key]);
    if (text) return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function backendReadbackFailureError(rec: Record<string, unknown>, fallback: string): Error | null {
  const status = (
    asNonEmptyString(rec.workflow_status) ??
    asNonEmptyString(rec.status) ??
    asNonEmptyString(rec.step_status) ??
    ''
  ).toLowerCase();
  if (!['blocked', 'failed', 'error', 'rejected'].includes(status)) return null;
  const reason =
    backendFailureText(rec.failure_reason) ||
    backendFailureText(rec.last_error) ||
    backendFailureText(rec.error) ||
    backendFailureText(rec.reason) ||
    backendFailureText(rec.message);
  return new Error(reason ? `${fallback}: ${reason}` : fallback);
}

export function requireLiveRpcRecord(data: unknown, fallback: string): Record<string, unknown> {
  const rec = firstRpcRow<Record<string, unknown>>(data);
  if (!rec || Object.keys(rec).length === 0) throw new Error(fallback);
  return rec;
}

export function requireLiveStringField(
  rec: Record<string, unknown>,
  keys: readonly string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = asNonEmptyString(rec[key]);
    if (value) return value;
  }
  throw new Error(fallback);
}

export function requireLiveNumberField(
  rec: Record<string, unknown>,
  keys: readonly string[],
  fallback: string,
): number {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) continue;
    const value = Number(rec[key]);
    if (Number.isFinite(value)) return value;
  }
  throw new Error(fallback);
}

export const LIVE_MUTATION_EVIDENCE_KEYS = [
  'correlation_id',
  'settings_resolution_id',
  'workflow_run_id',
  'workflow_template_id',
  'task_id',
  'event_id',
  'domain_event_id',
  'decision_log_id',
  'audit_log_id',
  'scan_event_id',
  'label_job_id',
  'label_version_id',
  'job_id',
  'action_id',
  'request_id',
  'tenant_signup_request_id',
  'organization_id',
  'route_plan_id',
  'route_run_id',
  'route_stop_id',
  'assignment_id',
  'route_run_assignment_id',
  'route_stop_reassignment_event_id',
  'vehicle_id',
  'driver_id',
  'driver_profile_id',
  'document_id',
  'vehicle_document_id',
  'driver_document_id',
  'driver_hours_of_service_id',
  'maintenance_window_id',
  'vehicle_event_id',
  'import_job_id',
  'support_case_id',
  'support_message_id',
  'billing_invoice_id',
  'finance_event_id',
  'settlement_batch_id',
  'count',
  'success_count',
  'succeeded_count',
  'failed_count',
  'affected_count',
  'vehicle_maintenance_window_id',
] as const;

function hasLiveEvidenceField(rec: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) return false;
    const value = rec[key];
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.length > 0;
    return value != null && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0;
  });
}

export function requireLiveEvidence(
  rec: Record<string, unknown>,
  keys: readonly string[],
  fallback: string,
): void {
  if (!hasLiveEvidenceField(rec, keys)) throw new Error(fallback);
}

export function requireLiveMutationResult(
  data: unknown,
  rpcName: string,
  evidenceKeys: readonly string[] = [],
): Record<string, unknown> {
  const rec = requireLiveRpcRecord(data, `${rpcName} returned no backend outcome`);
  const outcomeError = backendOutcomeError(rec, `${rpcName} was rejected by the backend`);
  if (outcomeError) throw outcomeError;
  requireLiveEvidence(
    rec,
    [...evidenceKeys, ...LIVE_MUTATION_EVIDENCE_KEYS],
    `${rpcName} did not return backend execution evidence`,
  );
  return rec;
}

export async function livePArgsMutationResult(
  rpcName: string,
  args: Record<string, unknown>,
  evidenceKeys: readonly string[],
): Promise<Record<string, unknown> | null> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, { p_args: args });
  if (!live) return null;
  return requireLiveMutationResult(live.data, rpcName, evidenceKeys);
}

export function requireLiveDomainEvidence(
  rec: Record<string, unknown>,
  rpcName: string,
  keys: readonly string[],
  label: string,
): void {
  requireLiveEvidence(rec, keys, `${rpcName} did not return backend ${label} evidence`);
}

export function withRequiredLiveStringField<T>(
  rec: Record<string, unknown>,
  keys: readonly string[],
  targetKey: string,
  fallback: string,
): T {
  const value = requireLiveStringField(rec, keys, fallback);
  return { ...rec, [targetKey]: value } as T;
}

export function requireLiveLabelDraftResult(data: unknown, rpcName: string): LabelDesignerDraftMutationResult {
  const rec = requireLiveRpcRecord(data, `${rpcName} returned no backend outcome`);
  if (rec.ok === false) return rec as LabelDesignerDraftMutationResult;
  const draft = objectRecord(rec.draft);
  const draftId =
    asNonEmptyString(draft.id) ??
    asNonEmptyString(rec.draft_id) ??
    asNonEmptyString(rec.label_design_draft_id) ??
    asNonEmptyString(rec.id);
  if (!draftId) throw new Error(`${rpcName} did not return backend draft evidence`);
  return rec as LabelDesignerDraftMutationResult;
}

export async function requireLiveLabelDraftMutationReadback(
  result: LabelDesignerDraftMutationResult,
  rpcName: string,
): Promise<LabelDesignerDraftMutationResult> {
  if (result.ok === false) return result;
  const draft = result.draft;
  const draftId = asNonEmptyString(draft?.id) ?? asNonEmptyString(result.draft_id);
  const scopeType = draft?.scope_type;
  const scopeId = asNonEmptyString(draft?.scope_id);
  if (!draftId || !scopeType || !scopeId) {
    throw new Error(`${rpcName} did not return draft scope for backend readback`);
  }
  const readback = await label_designer_list_drafts(scopeType, scopeId);
  const readbackDraft = readback.drafts.find((row) => row.id === draftId);
  if (!readbackDraft) {
    throw new Error(`${rpcName} backend draft list readback missing draft`);
  }
  return { ...result, draft: readbackDraft };
}

export function requireLiveLabelValidationResult(data: unknown): LabelDesignerDraftValidationResult {
  const rec = requireLiveRpcRecord(
    data,
    'label_designer_validate_label_design_draft returned no backend validation outcome',
  );
  if (typeof rec.ok !== 'boolean') {
    throw new Error('label_designer_validate_label_design_draft did not return backend validation evidence');
  }
  const errors = Array.isArray(rec.errors)
    ? rec.errors
    : Array.isArray(rec.validation_errors)
      ? rec.validation_errors
      : [];
  return {
    ...rec,
    ok: rec.ok,
    errors: errors as Array<Record<string, unknown>>,
  } as LabelDesignerDraftValidationResult;
}

export function requireLiveLabelPublishResult(data: unknown): LabelDesignerDraftPublishResult {
  const rec = requireLiveRpcRecord(
    data,
    'label_designer_publish_label_design_draft returned no backend publish outcome',
  );
  if (rec.ok === false) return rec as LabelDesignerDraftPublishResult;
  requireLiveEvidence(
    rec,
    [
      'settings_version_id',
      'settings_resolution_id',
      'published_settings_version_id',
      'label_version_id',
      'correlation_id',
    ],
    'label_designer_publish_label_design_draft did not return backend publish evidence',
  );
  return rec as LabelDesignerDraftPublishResult;
}

export async function requireLiveResourceReadback(
  resourceKey: string,
  id: string,
  rpcName: string,
): Promise<Record<string, unknown>> {
  const live = resourceKey === 'tabular_import_runs'
    ? await liveRpc<Record<string, unknown> | null>('ui_get_tabular_import_run_v1', {
        p_run_id: id,
      })
    : await liveRpc<Record<string, unknown> | null>('ui_get_resource_v1', {
        p_resource: resourceKey,
        p_id: id,
      });
  if (!live) throw new Error(`${rpcName} backend readback requires a live backend`);
  const row = firstRpcRow<Record<string, unknown>>(live.data);
  if (!row || Object.keys(row).length === 0) {
    throw new Error(`${rpcName} backend readback missing ${resourceKey}:${id}`);
  }
  return row;
}

export async function readLiveResourceListReadback(
  resourceKey: string,
  filters: Record<string, unknown>,
  rpcName: string,
): Promise<Array<Record<string, unknown>>> {
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: resourceKey,
    p_filters: compactRecord(filters),
    p_limit: 25,
    p_offset: 0,
    p_sort: null,
  });
  if (!live) throw new Error(`${rpcName} ${resourceKey} readback requires a live backend`);
  return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 25).rows;
}

export async function requireLiveResourceListReadback(
  resourceKey: string,
  filters: Record<string, unknown>,
  rpcName: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await readLiveResourceListReadback(resourceKey, filters, rpcName);
  if (rows.length === 0) {
    throw new Error(`${rpcName} backend readback missing ${resourceKey}`);
  }
  return rows;
}

export async function requireLiveResourceAbsenceReadback(
  resourceKey: string,
  filters: Record<string, unknown>,
  rpcName: string,
  label: string,
): Promise<void> {
  const rows = await readLiveResourceListReadback(resourceKey, filters, rpcName);
  if (rows.length > 0) {
    throw new Error(`${rpcName} backend readback still lists ${label}`);
  }
}

export const SA_SHORT_ADDRESS_READBACK_KEYS = [
  'sa_short_code',
  'short_national_address',
  'short_address',
  'shortAddress',
  'address_short',
  'short_code',
  'shortCode',
] as const;

export async function requireLiveRouteRunAssignmentReadback(
  rpcName: string,
  runId: string,
  rec: Record<string, unknown>,
): Promise<void> {
  await requireLiveResourceReadback('route_runs', runId, rpcName);
  const assignmentId = asNonEmptyString(rec.route_run_assignment_id) ?? asNonEmptyString(rec.assignment_id);
  if (assignmentId) {
    await requireLiveResourceReadback('route_run_assignments', assignmentId, rpcName);
  } else {
    await requireLiveResourceListReadback('route_run_assignments', { route_run_id: runId }, rpcName);
  }
  const eventId =
    asNonEmptyString(rec.route_run_assignment_event_id) ??
    asNonEmptyString(rec.assignment_event_id) ??
    asNonEmptyString(rec.event_id);
  if (eventId) {
    await requireLiveResourceReadback('route_run_assignment_events', eventId, rpcName);
  } else {
    await requireLiveResourceListReadback('route_run_assignment_events', { route_run_id: runId }, rpcName);
  }
}

export async function ui_execute_shipment_resort_v1(shipmentId: string): Promise<ShipmentResortResult> {
  const { ui_execute_shipment_resort_v1 } = await import('./data-source/shipments');
  return ui_execute_shipment_resort_v1(shipmentId);
}

export interface ShipmentUpdateGeocodeResult extends Record<string, unknown> {
  ok: true;
  status: string;
  action_key: string;
  resource_key: string;
  count: number;
  workflow_run_id: string;
  items?: Array<Record<string, unknown>>;
}

export async function ui_execute_shipment_update_geocode_v1(
  shipmentId: string,
  params: Record<string, unknown> = {},
): Promise<ShipmentUpdateGeocodeResult> {
  const { ui_execute_shipment_update_geocode_v1 } = await import('./data-source/shipments');
  return ui_execute_shipment_update_geocode_v1(shipmentId, params);
}

// W13-5 — operator-initiated comms attempt enqueue. Closes OPERATIONS D3 §3
// (CommsTab "Send now" orphan-toast). Routes to canonical
// `public.enqueue_comms_attempt_v1(p_args jsonb)` migration when supabase
// client is configured; otherwise returns the canonical envelope shape so the
// FE swap is a single env-flip away. Policy gate is
// `communication_policy.allow_operator_initiated_send` (see migration
// 202604280200_enqueue_comms_attempt_v1.sql for canonical RPC contract).
export async function enqueue_comms_attempt_v1(
  args: {
    shipment_id: string;
    channel: string;
    template_id?: string;
    recipient_override?: Record<string, unknown>;
  },
): Promise<{
  ok: true;
  comms_attempt_id: string;
  shipment_id: string;
  channel: string;
  template_id: string | null;
  status: 'queued';
  correlation_id: string;
  settings_resolution_id: string;
}> {
  const liveMode = Boolean(liveRpcTarget());
  const result = await phaseC6Rpc('enqueue_comms_attempt_v1', args, 'comms_attempt');
  if (liveMode) {
    const attemptId =
      asNonEmptyString(result.comms_attempt_id) ??
      asNonEmptyString(result.id);
    if (!attemptId) {
      throw new Error('enqueue_comms_attempt_v1 did not return comms_attempt_id');
    }
    await requireLiveResourceReadback('comms_attempts', attemptId, 'enqueue_comms_attempt_v1');
    await requireLiveResourceReadback('shipments', args.shipment_id, 'enqueue_comms_attempt_v1');
  }
  if ((result as { ok?: boolean }).ok === undefined) {
    // phaseC6Rpc seed envelope path — supplement seam-shape fields the FE
    // surfaces in toasts (`shipment_id`, `channel`, `status`).
    return {
      ok: true,
      comms_attempt_id: (result as { comms_attempt_id?: string }).comms_attempt_id ?? 'cma_' + Math.floor(Math.random() * 90000),
      shipment_id: args.shipment_id,
      channel: args.channel,
      template_id: args.template_id ?? null,
      status: 'queued',
      correlation_id: (result as { correlation_id?: string }).correlation_id ?? '0x' + Math.random().toString(16).slice(2, 10),
      settings_resolution_id: (result as { settings_resolution_id?: string }).settings_resolution_id ?? 'srlv_' + Math.floor(Math.random() * 9000),
    };
  }
  return result as {
    ok: true;
    comms_attempt_id: string;
    shipment_id: string;
    channel: string;
    template_id: string | null;
    status: 'queued';
    correlation_id: string;
    settings_resolution_id: string;
  };
}
export async function ui_execute_shipment_batch_operation_v1(
  ids: string[],
  op: string,
  payload: Record<string, unknown>,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: true; count: number; op: string; dry_run: boolean }> {
  const { ui_execute_shipment_batch_operation_v1 } = await import('./data-source/shipments');
  return ui_execute_shipment_batch_operation_v1(ids, op, payload, opts);
}

// ----------- Baskets -----------
//
// Dedicated Console V2 basket transition seam. Reads use the registry-backed
// public.baskets / basket_items / basket_transitions resources; writes route
// through ui_update_basket_state_v1 so the state update is centralized and the
// DB trigger records the append-only transition ledger.
export async function ui_update_basket_state_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = getSupabaseClient();
  if (client) {
    return phaseC6Rpc('ui_update_basket_state_v1', args, 'basket');
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('ui_update_basket_state_v1');
  await sleep(60);
  const basketId = String(args.basket_id ?? args.id ?? '').trim();
  const nextState = String(args.state ?? args.new_state ?? '').trim();
  if (!basketId) throw new Error('ui_update_basket_state_v1 requires basket_id');
  if (!nextState) throw new Error('ui_update_basket_state_v1 requires state');

  const baskets = (seed as { baskets?: Array<Record<string, unknown>> }).baskets ?? [];
  const basket = baskets.find((row) => row.id === basketId);
  if (!basket) throw new Error(`basket_not_found:${basketId}`);

  const previousState = basket.state ?? null;
  const now = new Date().toISOString();
  basket.state = nextState;
  basket.updated_at = now;
  basket.version = Number(basket.version ?? 1) + 1;

  const transitions = (seed as { basket_transitions?: Array<Record<string, unknown>> }).basket_transitions;
  const transitionId = nextResourceId('basket_transition');
  if (Array.isArray(transitions)) {
    transitions.unshift({
      id: transitionId,
      basket_id: basketId,
      previous_state: previousState,
      new_state: nextState,
      changed_at: now,
      changed_by: state.user.id,
      notes: typeof args.reason === 'string' ? args.reason : null,
    });
  }

  return buildEnvelope({
    basket_id: basketId,
    previous_state: previousState,
    new_state: nextState,
    state: nextState,
    transition_id: transitionId,
    transitioned_at: now,
  });
}

export interface BasketCreateMutationResult extends Record<string, unknown> {
  ok: true;
  basket_id: string;
  zone_id?: string | null;
  basket_type?: string | null;
  state?: string;
  capacity_count?: number | null;
  expires_at?: string | null;
  correlation_id: string;
  settings_resolution_id?: string;
}

export interface BasketUpdateMutationResult extends Record<string, unknown> {
  ok: true;
  basket_id: string;
  changed?: Record<string, unknown>;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function basket_create_v1(
  args: Record<string, unknown>,
): Promise<BasketCreateMutationResult> {
  const { basket_create_v1 } = await import('./data-source/dispatch');
  return basket_create_v1(args);
}

export async function basket_update_v1(
  args: Record<string, unknown>,
): Promise<BasketUpdateMutationResult> {
  const { basket_update_v1 } = await import('./data-source/dispatch');
  return basket_update_v1(args);
}

export interface RoutePlanCreateInput {
  organization_id?: string | null;
  branch_id: string;
  planned_date: string;
  inputs?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export async function ui_create_route_plan_v1(
  input: RoutePlanCreateInput,
): Promise<{ ok: true; route_plan_id: string; status: string; plan_id: string }> {
  const { ui_create_route_plan_v1 } = await import('./data-source/dispatch');
  return ui_create_route_plan_v1(input);
}

export async function ui_solve_route_plan_v1(planId: string): Promise<{ ok: true; plan_id: string; status: string }> {
  const { ui_solve_route_plan_v1 } = await import('./data-source/dispatch');
  return ui_solve_route_plan_v1(planId);
}
export async function ui_freeze_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; status: string; constraint_validation: { fail_count: number } }> {
  const { ui_freeze_route_plan_v1 } = await import('./data-source/dispatch');
  return ui_freeze_route_plan_v1(planId);
}
export async function ui_publish_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; execution_pack_hash: string }> {
  const { ui_publish_route_plan_v1 } = await import('./data-source/dispatch');
  return ui_publish_route_plan_v1(planId);
}

export interface RoutePlanExecutionPack extends Record<string, unknown> {
  route_plan_id?: string;
  execution_pack_hash?: string;
  stop_count?: number;
  shipment_count?: number;
}

export async function ui_route_plan_execution_pack_v1(
  planId: string,
): Promise<RoutePlanExecutionPack | null> {
  const { ui_route_plan_execution_pack_v1 } = await import('./data-source/dispatch');
  return ui_route_plan_execution_pack_v1(planId);
}
export async function ui_apply_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; status: string; runs_materialized: number }> {
  const { ui_apply_route_plan_v1 } = await import('./data-source/dispatch');
  return ui_apply_route_plan_v1(planId);
}

export interface RoutePlanRebalanceInput {
  source_route_plan_id: string;
  target_route_plan_id?: string | null;
  shipment_ids: string[];
  target_branch_id?: string | null;
  idempotency_key?: string | null;
  metadata?: Record<string, unknown>;
}
export async function ui_rebalance_route_plan_v1(
  input: RoutePlanRebalanceInput,
): Promise<{ ok: true; plan_id: string; moves_applied: number }> {
  const { ui_rebalance_route_plan_v1 } = await import('./data-source/dispatch');
  return ui_rebalance_route_plan_v1(input);
}

export interface RoutePlanConstraintCheck {
  name: string;
  passed: number;
  failed: number;
  status: 'pass' | 'warn' | 'danger';
  detail?: string;
}

export async function route_plan_validate_constraints_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; fail_count: number; items: RoutePlanConstraintCheck[] }> {
  const { route_plan_validate_constraints_v1 } = await import('./data-source/dispatch');
  return route_plan_validate_constraints_v1(planId);
}

export interface RouteRunAssignTarget {
  organization_id?: string;
  driver_user_id?: string;
  vehicle_id?: string;
  partner_id?: string;
  partner_name?: string;
  notes?: string;
  assignment_mode?: string;
  use_alternate_capacity?: boolean;
  idempotency_key?: string;
  reassignment_reason?: string;
  metadata?: Record<string, unknown>;
}

export interface RouteRunAssignmentResponseParams {
  response_notes?: string;
  refusal_reason?: string;
  response_metadata?: Record<string, unknown>;
  idempotency_key?: string;
}

export interface RouteRunAssignmentResponseResult extends Record<string, unknown> {
  ok: true;
  run_id: string;
  route_run_id: string;
  route_run_assignment_id?: string;
  assignment_status: string;
  assignment_version?: number;
  responded_by_user_id?: string | null;
  acknowledged_at?: string | null;
  accepted_at?: string | null;
  refused_at?: string | null;
  refusal_reason?: string | null;
  response_notes?: string | null;
  created?: boolean;
}

export async function ui_execute_route_run_assign_v1(
  runId: string,
  target: RouteRunAssignTarget | unknown,
): Promise<{ ok: true; run_id: string; target: RouteRunAssignTarget | unknown }> {
  const { ui_execute_route_run_assign_v1 } = await import('./data-source/dispatch');
  return ui_execute_route_run_assign_v1(runId, target);
}

export async function ui_execute_route_run_assignment_response_v1(
  runId: string,
  actionKey: string,
  params: RouteRunAssignmentResponseParams = {},
): Promise<RouteRunAssignmentResponseResult> {
  const { ui_execute_route_run_assignment_response_v1 } = await import('./data-source/dispatch');
  return ui_execute_route_run_assignment_response_v1(runId, actionKey, params);
}

export interface RouteStopReassignTarget {
  target_route_run_id?: string;
  driver_user_id?: string;
  vehicle_id?: string;
  partner_id?: string;
  partner_name?: string;
  notes?: string;
  reassignment_reason?: string;
  metadata?: Record<string, unknown>;
}
export async function ui_execute_route_stop_reassign_v1(
  stopIds: string[],
  target: RouteStopReassignTarget | unknown,
): Promise<{ ok: true; count: number; target: RouteStopReassignTarget | unknown; assignment_status: string }> {
  const { ui_execute_route_stop_reassign_v1 } = await import('./data-source/dispatch');
  return ui_execute_route_stop_reassign_v1(stopIds, target);
}
export async function ui_confirm_route_run_departure_v1(
  runId: string,
): Promise<{ ok: true; departure_confirmed_at: string; run_id: string }> {
  const { ui_confirm_route_run_departure_v1 } = await import('./data-source/dispatch');
  return ui_confirm_route_run_departure_v1(runId);
}
export async function route_run_scan_out_reconciliation_v1(
  runId: string,
): Promise<{ ok: true; expected: number; scanned: number; discrepancies: string[]; run_id: string }> {
  const { route_run_scan_out_reconciliation_v1 } = await import('./data-source/dispatch');
  return route_run_scan_out_reconciliation_v1(runId);
}

export async function pickup_requests_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const { pickup_requests_list_v1 } = await import('./data-source/dispatch');
  return pickup_requests_list_v1(filter);
}
export async function pickup_waves_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const { pickup_waves_list_v1 } = await import('./data-source/dispatch');
  return pickup_waves_list_v1(filter);
}
export async function pickup_failures_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const { pickup_failures_list_v1 } = await import('./data-source/dispatch');
  return pickup_failures_list_v1(filter);
}

export async function create_pickup_request_v1(payload: unknown): Promise<{
  ok: true;
  shipment_id: string;
  tracking_number?: string;
  created?: boolean;
  operation?: string;
  [key: string]: unknown;
}> {
  const { create_pickup_request_v1 } = await import('./data-source/dispatch');
  return create_pickup_request_v1(payload);
}

export async function create_pickup_wave_v1(payload: unknown): Promise<{ ok: true; wave_id: string }> {
  const { create_pickup_wave_v1 } = await import('./data-source/dispatch');
  return create_pickup_wave_v1(payload);
}
export async function assign_pickup_wave_v1(
  waveId: string,
  target: unknown,
): Promise<{ ok: true; wave_id: string; target: unknown }> {
  const { assign_pickup_wave_v1 } = await import('./data-source/dispatch');
  return assign_pickup_wave_v1(waveId, target);
}

// ----------- NDR / Exceptions -----------
// Canonical 6-arg signature per migration
// 202604091530_b09_ndr_resolution_orchestration_v1.sql line 2476:
//   ui_execute_dispatch_exception_resolution_v1(
//     action_key TEXT,
//     resource_key TEXT,
//     selection_ids TEXT[],
//     selection_id TEXT,
//     selection_count INTEGER,
//     params JSONB
//   )
// The FE keeps a thin compatibility shape `(taskId, resolution, opts)` that
// callers can use today; the adapter materializes the canonical 6-arg
// payload below so the swap-seam (see file header) only swaps the body, not
// the FE call sites. The adapter also accepts callers that already pass the
// canonical 6-arg payload via `opts.canonical` (preferred for new code).
export interface DispatchExceptionResolutionCanonicalArgs {
  action_key: string;
  resource_key: string;
  selection_ids: string[];
  selection_id: string;
  selection_count: number;
  params: Record<string, unknown>;
}
export interface DispatchExceptionResolutionOpts {
  dryRun?: 'preview' | boolean;
  canonical?: Partial<DispatchExceptionResolutionCanonicalArgs>;
}

export function normalizeDispatchResolutionLiveResult(
  data: unknown,
  taskId: string,
  resolution: unknown,
  dryRun: boolean,
  canonical: DispatchExceptionResolutionCanonicalArgs,
): {
  ok: true;
  task_id: string;
  resolution: unknown;
  dry_run: boolean;
  canonical_entrypoint: string;
  canonical_args: DispatchExceptionResolutionCanonicalArgs;
  policy: string;
  settings_resolution_id: string;
  apply_status: 'preview' | 'completed' | 'scheduled' | 'pending_review' | 'blocked' | 'mixed';
  results: Array<{ task_id: string; outcome: string; [k: string]: unknown }>;
} {
  const rec = requireLiveMutationResult(data, dryRun
    ? 'preview_dispatch_exception_resolution_v1'
    : 'ui_execute_dispatch_exception_resolution_v1', [
    'task_id',
    'items',
    'results',
    'workflow_run_id',
    'settings_resolution_id',
  ]);
  const items = Array.isArray(rec.items)
    ? rec.items
    : Array.isArray(rec.results)
      ? rec.results
      : [];
  if (items.length === 0 && !asNonEmptyString(rec.task_id ?? rec.id)) {
    throw new Error('Dispatch exception resolution did not return task result evidence');
  }
  const applyStatus = dryRun
    ? 'preview'
    : requireLiveStringField(
        rec,
        ['apply_status', 'status'],
        'Dispatch exception resolution did not return apply status',
      );
  const results = (items.length ? items : [{ task_id: taskId, status: applyStatus }])
    .map((item) => {
      const row = objectRecord(item);
      const outcome = asNonEmptyString(row.outcome ?? row.status) ?? applyStatus;
      return {
        ...row,
        task_id: String(row.task_id ?? row.id ?? taskId),
        outcome: outcome === 'completed' ? 'ok' : outcome,
      };
    });
  const firstPreview = objectRecord(objectRecord(results[0]).preview);
  return {
    ok: true,
    task_id: taskId,
    resolution,
    dry_run: dryRun,
    canonical_entrypoint: dryRun
      ? 'api.preview_dispatch_exception_resolution_v1'
      : 'api.ui_execute_dispatch_exception_resolution_v1',
    canonical_args: canonical,
    policy: 'ndr_policy',
    settings_resolution_id: String(
      rec.settings_resolution_id ??
      firstPreview.settings_resolution_id ??
      '',
    ),
    apply_status: applyStatus as 'preview' | 'completed' | 'scheduled' | 'pending_review' | 'blocked' | 'mixed',
    results,
  };
}

export type DispatchExceptionResolutionResult = ReturnType<typeof normalizeDispatchResolutionLiveResult>;

export const CONSOLE_DISPATCH_SCAN_DEVICE_STORAGE_KEY = 'nzxmhryhtqlzoshjkyozkpup.example.invalidnsoleV2.dispatchScanDeviceSeed';

export async function ui_execute_dispatch_exception_resolution_v1(
  taskId: string,
  resolution: unknown,
  opts: DispatchExceptionResolutionOpts = {},
): Promise<{
  ok: true;
  task_id: string;
  resolution: unknown;
  dry_run: boolean;
  canonical_entrypoint: string;
  canonical_args: DispatchExceptionResolutionCanonicalArgs;
  policy: string;
  settings_resolution_id: string;
  apply_status: 'preview' | 'completed' | 'scheduled' | 'pending_review' | 'blocked' | 'mixed';
  results: Array<{ task_id: string; outcome: string; [k: string]: unknown }>;
}> {
  const { ui_execute_dispatch_exception_resolution_v1 } = await import('./data-source/dispatch');
  return ui_execute_dispatch_exception_resolution_v1(taskId, resolution, opts);
}

// ----------- Returned to branch -----------
export interface WarehouseScanCorrectionRequestArgs {
  scan_event_id: string;
  correction_reason: string;
  corrected_barcode: string;
  metadata?: Record<string, unknown>;
}

export async function ui_request_warehouse_scan_correction_v1(
  args: WarehouseScanCorrectionRequestArgs,
): Promise<Record<string, unknown>> {
  const { ui_request_warehouse_scan_correction_v1 } = await import('./data-source/dispatch');
  return ui_request_warehouse_scan_correction_v1(args);
}

export async function record_scan_event_v1(
  payload: Record<string, unknown>,
): Promise<{ ok: true; scan_event_id: string; created?: boolean }> {
  const { record_scan_event_v1 } = await import('./data-source/dispatch');
  return record_scan_event_v1(payload);
}
export const return_to_branch_shipments_v1 = {
  async list(_filter?: unknown): Promise<Record<string, unknown>[]> {
    const pageSize = 100;
    const live = await liveRpc('ui_list_resource_v1', {
      p_resource: 'return_to_branch_shipments',
      p_filters: {},
      p_limit: pageSize,
      p_offset: 0,
      p_sort: liveSort({ key: 'updated_at', dir: 'desc' }),
    });
    if (live) {
      return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows;
    }

    await sleep(40);
    return (seed.shipments as Array<{ status: string } & Record<string, unknown>>)
      .filter((s) => s.status === 'returned_to_branch')
      .slice(0, 8);
  },
};

// CLAIM-OPERATIONS-WIRING (Phase C1) — `public.resolve_ndr_branch_next_action_v1`
// (supabase/migrations/202604101380_b09_return_to_branch_intake_visibility_replay_v1.sql:271,
//  supabase/migrations/202604101131_b09_return_to_branch_intake_visibility_v1.sql:269).
//
// Returns the recommended branch next-action for a returned-to-branch
// shipment by resolving `ndr_policy.action_map` through the canonical
// settings ladder. Backend signature accepts (organization_id, client_id,
// sender_id, service_type, dispatch_exception_reason, resolution_action,
// task_type_key, shipment_action_type, review_status, allowed_ndr_actions).
// FE callers pass an opinionated subset; the adapter mirrors the
// production RPC's text return shape so the swap is one-line.
export interface NdrBranchNextActionArgs {
  organization_id?: string | null;
  client_id?: string | null;
  sender_id?: string | null;
  service_type?: string | null;
  dispatch_exception_reason?: string | null;
  resolution_action?: string | null;
  task_type_key?: string | null;
  shipment_action_type?: string | null;
  review_status?: string | null;
  allowed_ndr_actions?: string[] | null;
}
export async function resolve_ndr_branch_next_action_v1(
  args: NdrBranchNextActionArgs = {},
): Promise<string> {
  const { resolve_ndr_branch_next_action_v1 } = await import('./data-source/dispatch');
  return resolve_ndr_branch_next_action_v1(args);
}

// ----------- Phase C6 helpers -----------
//
// The C6 wave wires PLATFORM + FLEET + SUPPORT mutations through canonical
// RPCs (Phase B1/B2/B3). Each canonical RPC returns
//   { ok, <resource>_id, correlation_id, settings_resolution_id }
// so we share two tiny helpers that the in-memory branch uses to mirror the
// canonical envelope exactly. Production swap is environment-only.
let mutationCounter = 0;
export function nextCorrelationId(): string {
  mutationCounter++;
  return `cor_${Date.now().toString(36)}_${mutationCounter}`;
}
export function nextResourceId(prefix: string): string {
  mutationCounter++;
  return `${prefix}_${Date.now().toString(36)}_${mutationCounter}`;
}
export function buildEnvelope(extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    correlation_id: nextCorrelationId(),
    settings_resolution_id: 'srlv_demo',
    ...extras,
  };
}

function tenantSignupSeedRequest(requestId: string): Record<string, unknown> | null {
  const requests = (seed as { tenant_signup_requests?: Array<Record<string, unknown>> }).tenant_signup_requests ?? [];
  return requests.find((request) => request.id === requestId) ?? null;
}

function tenantSignupProvisioningSlug(requestId: string, request: Record<string, unknown> | null): string {
  const source =
    asNonEmptyString(request?.organization_slug)
    ?? asNonEmptyString(request?.organization_name)
    ?? requestId;
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || requestId.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

export function buildTenantSignupReviewSeedResult(
  requestId: string,
  decision: string,
): Record<string, unknown> {
  const request = tenantSignupSeedRequest(requestId);
  const reviewedAt = new Date().toISOString();
  const base: Record<string, unknown> = {
    tenant_signup_request_id: requestId,
    decision,
    status: decision,
    reviewed_at: reviewedAt,
  };

  if (decision !== 'approved') return base;

  const slug = tenantSignupProvisioningSlug(requestId, request);
  const approvedOrganizationId =
    asNonEmptyString(request?.approved_organization_id) ?? `org_${slug}`;

  return {
    ...base,
    approved_organization_id: approvedOrganizationId,
    organization_id: approvedOrganizationId,
    approved_user_id: asNonEmptyString(request?.approved_user_id) ?? `usr_${slug}_admin`,
    approved_auth_user_id: asNonEmptyString(request?.approved_auth_user_id) ?? `auth_${slug}_admin`,
    invite_email_sent_at: asNonEmptyString(request?.invite_email_sent_at) ?? reviewedAt,
    invite_redirect_to: asNonEmptyString(request?.invite_redirect_to) ?? hostedInviteRedirect(),
  };
}

export function buildMutationFallbackEnvelope(
  args: Record<string, unknown>,
  resourceKeyHint?: string,
): Record<string, unknown> {
  const idKey = resourceKeyHint ? `${resourceKeyHint}_id` : null;
  const passedId = idKey ? (args[idKey] as string | undefined) : undefined;
  const extras: Record<string, unknown> = {};
  if (idKey) {
    extras[idKey] = passedId ?? nextResourceId(resourceKeyHint!);
  }
  return buildEnvelope(extras);
}

/**
 * Generic Phase C6 mutation adapter. The 41 RPCs in C6 share an identical
 * shape: `<rpc_name>(p_args jsonb)` returning the canonical envelope. The
 * in-memory branch does not actually persist (all canonical writes flow only
 * through the live Supabase client) — it returns the envelope so toast +
 * cache invalidation behave identically across modes. To keep zero
 * redundancy we route every C6 RPC through this single function.
 */
async function phaseC6Rpc(
  rpcName: string,
  args: Record<string, unknown>,
  resourceKeyHint?: string,
): Promise<Record<string, unknown>> {
  const target = liveRpcTarget();
  if (target) {
    const { data, error } = await target.rpc(rpcName, { p_args: args });
    if (error) throw new Error(error.message);
    const evidenceKeys = resourceKeyHint ? [`${resourceKeyHint}_id`, 'id'] : [];
    return requireLiveMutationResult(data, rpcName, evidenceKeys);
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError(`RPC ${rpcName}`);
  await sleep(60);
  // Mirror the canonical envelope; surface the inferred resource id when the
  // caller passed one (so optimistic UI can echo it). Unknown ids are minted.
  return buildMutationFallbackEnvelope(args, resourceKeyHint);
}

async function phaseC6ApiRpc(
  rpcName: string,
  args: Record<string, unknown>,
  resourceKeyHint?: string,
): Promise<Record<string, unknown>> {
  const target = liveRpcTarget();
  if (target) {
    const { data, error } = await target.rpc(rpcName, { p_args: args });
    if (error) throw new Error(error.message);
    const evidenceKeys = resourceKeyHint ? [`${resourceKeyHint}_id`, 'id'] : [];
    return requireLiveMutationResult(data, rpcName, evidenceKeys);
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError(`RPC ${rpcName}`);
  await sleep(60);
  const idKey = resourceKeyHint ? `${resourceKeyHint}_id` : null;
  const passedId = idKey ? (args[idKey] as string | undefined) : undefined;
  const extras: Record<string, unknown> = {};
  if (idKey) {
    extras[idKey] = passedId ?? nextResourceId(resourceKeyHint!);
  }
  return buildEnvelope(extras);
}

export async function requireLiveUserLifecycleReadback(
  rpcName: string,
  targetUserId: string,
): Promise<{
  user: Record<string, unknown> | null;
  directory: Record<string, unknown> | null;
}> {
  if (!liveRpcTarget()) return { user: null, directory: null };
  const user = await requireLiveResourceReadback('users', targetUserId, rpcName);
  const directory = await requireLiveResourceReadback('user_directory', targetUserId, rpcName);
  return { user, directory };
}

export function assertLiveUserScopeReadback(
  rpcName: string,
  readback: { user?: Record<string, unknown> | null; directory?: Record<string, unknown> | null },
  expectedScopeType?: string | null,
  expectedScopeId?: string | null,
): void {
  const scopeType = asNonEmptyString(expectedScopeType) ?? 'tenant';
  const scopeId = asNonEmptyString(expectedScopeId);
  for (const [name, row] of Object.entries(readback)) {
    if (!row) continue;
    if (asNonEmptyString(row.access_scope_type) !== scopeType) {
      throw new Error(`${rpcName} backend readback ${name} access scope type mismatch`);
    }
    const rowScopeId = asNonEmptyString(row.access_scope_id);
    if (scopeType === 'client' || scopeType === 'sender') {
      if (!scopeId || rowScopeId !== scopeId) {
        throw new Error(`${rpcName} backend readback ${name} access scope id mismatch`);
      }
    } else if (scopeId && rowScopeId !== scopeId) {
      throw new Error(`${rpcName} backend readback ${name} access scope id mismatch`);
    }
  }
}

async function requireLiveUserSessionRevocationReadback(
  rpcName: string,
  targetUserId: string,
  sessionId: string | null | undefined,
  result: Record<string, unknown>,
  revokedReason: string | null | undefined,
): Promise<Record<string, unknown>> {
  const normalizedSessionId = asNonEmptyString(sessionId);
  const live = await liveRpc<Record<string, unknown>>('ui_list_user_sessions_v1', {
    p_target_user_id: targetUserId,
    p_limit: 50,
  });
  if (!live) throw new Error(`${rpcName} session readback requires a live backend`);
  const rows = normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 50).rows;
  const revocationAuditId = asNonEmptyString(result.revocation_audit_id);
  const candidates = rows.filter((row) => {
    const userMatches = asNonEmptyString(row.user_id) === targetUserId;
    const sessionMatches = !normalizedSessionId || asNonEmptyString(row.id) === normalizedSessionId;
    return userMatches && sessionMatches;
  });
  const revoked = candidates.find((row) => {
    const status = asNonEmptyString(row.revocation_status);
    const auditMatches = !revocationAuditId || asNonEmptyString(row.revocation_audit_id) === revocationAuditId;
    return Boolean(status) && auditMatches;
  });
  if (!revoked) {
    throw new Error(`${rpcName} backend readback missing revoked session evidence`);
  }
  const status = asNonEmptyString(revoked.revocation_status)?.toLowerCase();
  if (status === 'failed') {
    throw new Error(`${rpcName} backend readback session revocation failed`);
  }
  const expectedReason = asNonEmptyString(revokedReason);
  if (expectedReason) {
    const metadata = objectRecord(revoked.metadata);
    const readbackReason =
      asNonEmptyString(revoked.revocation_reason) ??
      asNonEmptyString(revoked.reason) ??
      asNonEmptyString(metadata.reason);
    if (readbackReason !== expectedReason) {
      throw new Error(`${rpcName} backend readback missing persisted revocation reason`);
    }
  }
  return revoked;
}

// ----------- Warehouse -----------
//
// Canonical RPC `public.warehouse_transfer_execute_v1(p_args jsonb)` —
// Phase B1 migration 202604280140. Capability: warehouse.write. Replaces the
// pre-Phase-B no-op stub and the synthetic `data-source.ts:1113` shim noted
// in PLATFORM crosswalk gap P0.
export interface WarehouseTransferExecuteResult extends Record<string, unknown> {
  ok: true;
  warehouse_transfer_id: string;
  correlation_id: string;
  settings_resolution_id?: string;
}
export interface WarehouseTransferManifestCreateResult extends Record<string, unknown> {
  ok: true;
  warehouse_transfer_id: string;
  transfer_code: string;
  created: boolean;
  item_count: number;
}
export async function create_warehouse_transfer_manifest_v1(
  args: Record<string, unknown>,
): Promise<WarehouseTransferManifestCreateResult> {
  const { create_warehouse_transfer_manifest_v1 } = await import('./data-source/dispatch');
  return create_warehouse_transfer_manifest_v1(args);
}
export async function warehouse_transfer_execute_v1(
  payload: Record<string, unknown> = {},
): Promise<WarehouseTransferExecuteResult> {
  const result = await phaseC6Rpc('warehouse_transfer_execute_v1', payload, 'warehouse_transfer');
  return result as WarehouseTransferExecuteResult;
}
// W35e-4 — Aligned to canonical jsonb envelope per
// supabase/migrations/202601261740_warehouse_transfer_reconcile_finalize_v1.sql.
// Live mode routes through the api-schema `transition_warehouse_transfer_v1`
// wrapper so browser clients stay on the exposed schema boundary. Envelope:
// { ok, warehouse_transfer_id, updated, status, dispatched_at, received_at }.
// In-memory seed mode keeps the legacy minimal stub shape so existing tests
// continue to assert on adapter input only (warehouse.test.tsx W35e-4 spies
// on the adapter call, not on its return shape).
export async function transition_warehouse_transfer_v1(
  args: { warehouse_transfer_id: string; to_status: string; [k: string]: unknown },
): Promise<{ ok: true; warehouse_transfer_id: string; to_status: string; [k: string]: unknown }> {
  const { transition_warehouse_transfer_v1 } = await import('./data-source/dispatch');
  return transition_warehouse_transfer_v1(args);
}

export interface WarehouseTransferUiActionResult extends Record<string, unknown> {
  ok: true;
  action_key: string;
  resource_key: string;
  warehouse_transfer_id: string;
  count: number;
}

export async function ui_execute_warehouse_transfer_dispatch_v1(
  args: { warehouse_transfer_id: string; params?: Record<string, unknown> },
): Promise<WarehouseTransferUiActionResult> {
  const { ui_execute_warehouse_transfer_dispatch_v1 } = await import('./data-source/dispatch');
  return ui_execute_warehouse_transfer_dispatch_v1(args);
}

export async function ui_execute_warehouse_transfer_checkpoint_v1(
  args: {
    action_key: 'warehouse_transfers.scan_departure' | 'warehouse_transfers.scan_arrival';
    warehouse_transfer_id: string;
    barcode: string;
    handling_unit_code?: string | null;
    device_id?: string | null;
    ops_session_id?: string | null;
    notes?: string | null;
  },
): Promise<WarehouseTransferUiActionResult> {
  const { ui_execute_warehouse_transfer_checkpoint_v1 } = await import('./data-source/dispatch');
  return ui_execute_warehouse_transfer_checkpoint_v1(args);
}

export async function ui_execute_warehouse_transfer_reconcile_v1(
  args: {
    warehouse_transfer_id: string;
    received_shipment_count: number;
    damaged_shipment_count?: number;
    missing_shipment_count?: number;
    unmanifested_shipment_count?: number;
    reconcile_notes?: string | null;
  },
): Promise<WarehouseTransferUiActionResult> {
  const { ui_execute_warehouse_transfer_reconcile_v1 } = await import('./data-source/dispatch');
  return ui_execute_warehouse_transfer_reconcile_v1(args);
}

// ----------- Phase C6 PLATFORM mutations (alerts, feature flags, access, organizations) -----------

// PLATFORM/alerts
export const create_alert_rule_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('create_alert_rule_v1', args, 'alert_rule');
export const update_alert_rule_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('update_alert_rule_v1', args, 'alert_rule');
export const pause_alert_rule_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('pause_alert_rule_v1', args, 'alert_rule');
export const resume_alert_rule_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('resume_alert_rule_v1', args, 'alert_rule');
export const delete_alert_rule_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('delete_alert_rule_v1', args, 'alert_rule');
export const test_alert_rule_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('test_alert_rule_v1', args, 'alert_rule');

function resolveOpsAlertReadbackId(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  rpcName: string,
): string {
  const alertId =
    asNonEmptyString(result.ops_alert_id) ??
    asNonEmptyString(result.id) ??
    asNonEmptyString(args.ops_alert_id);
  if (!alertId) {
    throw new Error(`${rpcName} did not expose ops_alert_id for backend readback`);
  }
  return alertId;
}

function requireOpsAlertReadbackTimestamp(
  row: Record<string, unknown>,
  field: 'acknowledged_at' | 'resolved_at',
  alertId: string,
  rpcName: string,
): void {
  if (!asNonEmptyString(row[field])) {
    throw new Error(`${rpcName} backend readback missing ${field} for ops_alerts:${alertId}`);
  }
}

async function requireLiveOpsAlertReadback(
  rpcName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  field: 'acknowledged_at' | 'resolved_at',
): Promise<void> {
  if (!liveRpcTarget()) return;
  const alertId = resolveOpsAlertReadbackId(result, args, rpcName);
  const row = await requireLiveResourceReadback('ops_alerts', alertId, rpcName);
  requireOpsAlertReadbackTimestamp(row, field, alertId, rpcName);
  if (field === 'resolved_at') {
    const expectedNotes = asNonEmptyString(args.resolution_notes);
    if (expectedNotes && asNonEmptyString(row.resolution_notes) !== expectedNotes) {
      throw new Error(`${rpcName} backend readback resolution_notes mismatch for ops_alerts:${alertId}`);
    }
  }
}

export async function acknowledge_ops_alert_v1(args: Record<string, unknown>) {
  const result = await phaseC6Rpc('acknowledge_ops_alert_v1', args, 'ops_alert');
  await requireLiveOpsAlertReadback('acknowledge_ops_alert_v1', args, result, 'acknowledged_at');
  return result;
}

export async function resolve_ops_alert_v1(args: Record<string, unknown>) {
  const result = await phaseC6Rpc('resolve_ops_alert_v1', args, 'ops_alert');
  await requireLiveOpsAlertReadback('resolve_ops_alert_v1', args, result, 'resolved_at');
  return result;
}

// PLATFORM/feature flags
export const create_feature_flag_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('create_feature_flag_v1', args, 'feature_flag');
export const update_feature_flag_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('update_feature_flag_v1', args, 'feature_flag');
export const toggle_feature_flag_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('toggle_feature_flag_v1', args, 'feature_flag');
export const engage_kill_switch_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('engage_kill_switch_v1', args, 'feature_flag');
export const release_kill_switch_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('release_kill_switch_v1', args, 'feature_flag');
export const set_rollout_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('set_rollout_v1', args, 'feature_flag');
export const bulk_toggle_feature_flags_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('bulk_toggle_feature_flags_v1', args);

// PLATFORM/access — replaces PREVIEW chip
function readCapabilityGrantReadback(
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const readback = result.request_readback;
  return readback && typeof readback === 'object' && !Array.isArray(readback)
    ? readback as Record<string, unknown>
    : null;
}

function requireCapabilityGrantReadbackMatch(
  readback: Record<string, unknown>,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  const requestId =
    asNonEmptyString(readback.id)
      ?? asNonEmptyString(readback.capability_grant_request_id);
  if (!requestId) {
    throw new Error('request_capability_grant_v1 backend readback missing capability_grant_requests.id');
  }
  const returnedRequestId = asNonEmptyString(result.capability_grant_request_id);
  if (returnedRequestId && returnedRequestId !== requestId) {
    throw new Error('request_capability_grant_v1 backend readback request id mismatch');
  }

  const expectedCapability = asNonEmptyString(args.capability_key);
  if (expectedCapability && asNonEmptyString(readback.capability_key) !== expectedCapability) {
    throw new Error('request_capability_grant_v1 backend readback mismatch for capability_key');
  }

  const expectedScopeType = asNonEmptyString(args.scope_type) ?? 'tenant';
  if (asNonEmptyString(readback.scope_type) !== expectedScopeType) {
    throw new Error('request_capability_grant_v1 backend readback mismatch for scope_type');
  }

  const expectedScopeId = asNonEmptyString(args.scope_id);
  if (expectedScopeId && asNonEmptyString(readback.scope_id) !== expectedScopeId) {
    throw new Error('request_capability_grant_v1 backend readback mismatch for scope_id');
  }

  const expectedReason = asNonEmptyString(args.reason);
  if (expectedReason && asNonEmptyString(readback.reason) !== expectedReason) {
    throw new Error('request_capability_grant_v1 backend readback mismatch for reason');
  }

  const expectedDuration = args.duration_hours;
  if (expectedDuration !== undefined && expectedDuration !== null && String(expectedDuration).trim() !== '') {
    const readbackDuration = readback.duration_hours;
    if (Number(readbackDuration) !== Number(expectedDuration)) {
      throw new Error('request_capability_grant_v1 backend readback mismatch for duration_hours');
    }
  }

  if (asNonEmptyString(readback.status) !== 'pending') {
    throw new Error('request_capability_grant_v1 backend readback status is not pending');
  }
}

function requireLiveCapabilityGrantReadback(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  if (!liveRpcTarget()) return;
  const readback = readCapabilityGrantReadback(result);
  if (!readback) {
    throw new Error('request_capability_grant_v1 did not return capability_grant_requests readback');
  }
  requireCapabilityGrantReadbackMatch(readback, args, result);
}

export async function request_capability_grant_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('request_capability_grant_v1', args, 'capability_grant_request');
  requireLiveCapabilityGrantReadback(args, result);
  return result;
}

function requireCapabilityGrantReviewReadbackMatch(
  readback: Record<string, unknown>,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): { requestId: string; decision: string } {
  const rpcName = 'ui_review_capability_grant_request_v1';
  const requestId =
    asNonEmptyString(readback.id)
      ?? asNonEmptyString(readback.capability_grant_request_id)
      ?? asNonEmptyString(result.capability_grant_request_id);
  if (!requestId) {
    throw new Error(`${rpcName} backend readback missing capability_grant_requests.id`);
  }
  const expectedRequestId =
    asNonEmptyString(args.request_id)
      ?? asNonEmptyString(args.capability_grant_request_id)
      ?? asNonEmptyString(result.capability_grant_request_id);
  if (expectedRequestId && expectedRequestId !== requestId) {
    throw new Error(`${rpcName} backend readback request id mismatch`);
  }

  const rawDecision = asNonEmptyString(args.decision) ?? asNonEmptyString(args.status);
  const normalizedDecision =
    rawDecision && ['approve', 'approved'].includes(rawDecision.toLowerCase())
      ? 'approved'
      : rawDecision && ['deny', 'denied', 'reject', 'rejected'].includes(rawDecision.toLowerCase())
        ? 'denied'
        : asNonEmptyString(result.status);
  if (!normalizedDecision || !['approved', 'denied'].includes(normalizedDecision)) {
    throw new Error(`${rpcName} backend readback invalid expected decision`);
  }

  if (asNonEmptyString(readback.status) !== normalizedDecision) {
    throw new Error(`${rpcName} backend readback status mismatch`);
  }

  const expectedNotes = asNonEmptyString(args.decision_notes) ?? asNonEmptyString(args.notes);
  if (expectedNotes && asNonEmptyString(readback.decision_notes) !== expectedNotes) {
    throw new Error(`${rpcName} backend readback decision_notes mismatch`);
  }

  const readbackCorrelation = asNonEmptyString(readback.correlation_id);
  const resultCorrelation = asNonEmptyString(result.correlation_id);
  if (resultCorrelation && readbackCorrelation !== resultCorrelation) {
    throw new Error(`${rpcName} backend readback correlation_id mismatch`);
  }

  if (normalizedDecision === 'approved') {
    const roleId = asNonEmptyString(result.rbac_role_id) ?? asNonEmptyString(readback.approved_role_id);
    const assignmentId =
      asNonEmptyString(result.rbac_user_role_assignment_id)
      ?? asNonEmptyString(readback.approved_assignment_id);
    if (!roleId) {
      throw new Error(`${rpcName} approved readback missing rbac_role_id`);
    }
    if (!assignmentId) {
      throw new Error(`${rpcName} approved readback missing rbac_user_role_assignment_id`);
    }
  }

  return { requestId, decision: normalizedDecision };
}

async function requireLiveCapabilityGrantReviewReadback(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  if (!liveRpcTarget()) return;
  const readback = readCapabilityGrantReadback(result);
  if (!readback) {
    throw new Error('ui_review_capability_grant_request_v1 did not return capability_grant_requests readback');
  }
  const { requestId, decision } = requireCapabilityGrantReviewReadbackMatch(readback, args, result);
  const row = await requireLiveResourceReadback(
    'capability_grant_requests',
    requestId,
    'ui_review_capability_grant_request_v1',
  );
  if (asNonEmptyString(row.status) !== decision) {
    throw new Error('ui_review_capability_grant_request_v1 backend resource readback status mismatch');
  }
}

export async function ui_review_capability_grant_request_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(
    'ui_review_capability_grant_request_v1',
    args,
    'capability_grant_request',
  );
  await requireLiveCapabilityGrantReviewReadback(args, result);
  return result;
}

// PLATFORM/imports — W16-5. Canonical write RPCs replacing the PREVIEW chip.
// Migrations of record:
//   • import_job_create_v1   202604301905
//   • import_job_cancel_v1   202604301905
// Both RPCs accept a single jsonb envelope (`p_args`) and return the canonical
// envelope `{ ok, import_job_id, status, correlation_id, settings_resolution_id }`.
export async function requireLiveImportJobReadback(
  rpcName: string,
  importJobId: string,
  expected?: { status?: string; cancelledReason?: string },
): Promise<void> {
  const job = await requireLiveResourceReadback('import_jobs', importJobId, rpcName);
  if (expected?.status && String(job.status ?? '') !== expected.status) {
    throw new Error(`${rpcName} backend readback status mismatch for import_jobs:${importJobId}`);
  }
  if (expected?.cancelledReason !== undefined) {
    const jobReason = String(job.cancelled_reason ?? '').trim();
    if (jobReason !== expected.cancelledReason) {
      throw new Error(`${rpcName} backend readback cancellation reason mismatch for import_jobs:${importJobId}`);
    }
  }
  const directory = await requireLiveResourceReadback('import_job_directory', importJobId, rpcName);
  if (expected?.status && String(directory.status ?? '') !== expected.status) {
    throw new Error(`${rpcName} backend readback status mismatch for import_job_directory:${importJobId}`);
  }
  if (expected?.cancelledReason !== undefined) {
    const directoryReason = String(directory.cancelled_reason ?? '').trim();
    if (directoryReason !== expected.cancelledReason) {
      throw new Error(`${rpcName} backend readback cancellation reason mismatch for import_job_directory:${importJobId}`);
    }
  }
}

function resolveImportJobId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.import_job_id)
    ?? asNonEmptyString(rec.job_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.import_job_id)
    ?? asNonEmptyString(args.job_id)
    ?? asNonEmptyString(args.id);
}

export async function import_job_create_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('import_job_create_v1', args, 'import_job');
  if (liveRpcTarget()) {
    const importJobId = resolveImportJobId(result, args);
    if (!importJobId) throw new Error('import_job_create_v1 did not return import_job_id');
    await requireLiveImportJobReadback('import_job_create_v1', importJobId);
  }
  return result;
}
export async function import_job_cancel_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reason = asNonEmptyString(args.reason);
  if (!reason) throw new Error('import_job_cancel_v1 requires cancellation reason');
  const result = await phaseC6Rpc('import_job_cancel_v1', args, 'import_job');
  if (liveRpcTarget()) {
    const importJobId = resolveImportJobId(result, args);
    if (!importJobId) throw new Error('import_job_cancel_v1 did not return import_job_id');
    await requireLiveImportJobReadback('import_job_cancel_v1', importJobId, {
      status: 'cancelled',
      cancelledReason: reason,
    });
  }
  return result;
}

// PLATFORM/access — RBAC role-management lifecycle (Phase E3 / IDENTITY P0).
// All five mutation RPCs are now SHIPPED canonical:
//   - rbac_create_role_v1     202604290100 (idempotent on org+key)
//   - rbac_update_role_v1     202604290110 (partial mutation; key immutable)
//   - rbac_delete_role_v1     202604290120 (soft-delete + revoke active assignments)
//   - rbac_grant_role_v1      202604290130 (idempotent on active assignment)
//   - rbac_revoke_role_v1     202604290140 (assignment_id OR user+role; idempotent)
// Each enforces capability `access_policy.approve`, writes append-only
// decision_log + domain_events, and returns the canonical envelope. The Wave 6
// promotion replaces the generic phaseC6Rpc shim with typed facades so the
// envelope shape is enforced at the FE adapter layer.
//
// `provision_rbac_roles_from_templates_v1` was already SHIPPED (202601300050:215);
// it stays on phaseC6Rpc since its signature differs (template-driven bootstrap).

export interface RbacRoleMutationResult extends Record<string, unknown> {
  ok: true;
  rbac_role_id: string;
  action?: string;
  idempotent_no_op?: boolean;
  assignments_revoked?: number;
  correlation_id: string;
  settings_resolution_id?: string;
}

export interface RbacUserRoleAssignmentMutationResult extends Record<string, unknown> {
  ok: true;
  rbac_user_role_assignment_id: string | null;
  action?: string;
  idempotent_no_op?: boolean;
  correlation_id: string;
  settings_resolution_id?: string;
}

export interface RbacTemplateProvisionRoleResult extends Record<string, unknown> {
  template_key?: string | null;
  role_id?: string | null;
  rbac_role_id?: string | null;
  created?: boolean;
}

export interface RbacTemplateProvisionMutationResult extends Record<string, unknown> {
  ok: true;
  rbac_role_id: string;
  rbac_roles?: RbacTemplateProvisionRoleResult[];
  organization_id?: string;
  template_keys?: string[];
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function rbac_create_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const { rbac_create_role_v1 } = await import('./data-source/platform');
  return rbac_create_role_v1(args);
}

export async function rbac_update_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const { rbac_update_role_v1 } = await import('./data-source/platform');
  return rbac_update_role_v1(args);
}

export async function rbac_delete_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const { rbac_delete_role_v1 } = await import('./data-source/platform');
  return rbac_delete_role_v1(args);
}

export async function rbac_grant_role_v1(
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> {
  const { rbac_grant_role_v1 } = await import('./data-source/platform');
  return rbac_grant_role_v1(args);
}

export async function rbac_revoke_role_v1(
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> {
  const { rbac_revoke_role_v1 } = await import('./data-source/platform');
  return rbac_revoke_role_v1(args);
}

export async function provision_rbac_roles_from_templates_v1(
  args: Record<string, unknown>,
): Promise<RbacTemplateProvisionMutationResult> {
  const { requireLiveRbacTemplateProvisionReadback } = await import('./data-source/platform');
  const result = await phaseC6Rpc('provision_rbac_roles_from_templates_v1', args, 'rbac_role');
  if (liveRpcTarget()) {
    await requireLiveRbacTemplateProvisionReadback(
      'provision_rbac_roles_from_templates_v1',
      result,
      args,
    );
  }
  return result as RbacTemplateProvisionMutationResult;
}

// PLATFORM/organizations — live Console review must enter through the browser-safe
// `tenant-signup-review` edge function. Approval needs the edge helper because it
// creates/invites the Auth user before applying the scalar
// tenant_signup_review_apply_v1(...) RPC. Demo mode keeps the canonical envelope
// shape so tests and optimistic UI remain deterministic without a Supabase client.
export async function readFunctionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const candidate = error as {
    message?: string;
    context?: {
      json?: () => Promise<unknown>;
      text?: () => Promise<string>;
    };
  };
  try {
    const json = await candidate.context?.json?.();
    if (json && typeof json === 'object') {
      const envelope = json as Record<string, unknown>;
      const nested = envelope.error && typeof envelope.error === 'object'
        ? (envelope.error as Record<string, unknown>)
        : {};
      const message =
        asNonEmptyString(nested.message) ??
        asNonEmptyString(envelope.error) ??
        asNonEmptyString(envelope.message);
      if (message) return message;
      const code =
        asNonEmptyString(nested.code) ??
        asNonEmptyString(envelope.code);
      if (code) return code;
    }
  } catch {
    // Fall through to text/message fallback.
  }
  try {
    const text = await candidate.context?.text?.();
    const message = asNonEmptyString(text);
    if (message) return message;
  } catch {
    // Fall through to message fallback.
  }
  return asNonEmptyString(candidate.message) ?? fallback;
}

export function requireFunctionMutationResult(
  data: unknown,
  functionName: string,
  evidenceKeys: readonly string[],
  options: { allowedBusinessStatuses?: readonly string[] } = {},
): { envelope: Record<string, unknown>; result: Record<string, unknown>; merged: Record<string, unknown> } {
  const envelope = objectRecord(data);
  const result = objectRecord(envelope.result);
  const merged = { ...result, ...envelope };
  if (Object.keys(merged).length === 0) {
    throw new Error(`${functionName} returned no backend outcome`);
  }
  const outcomeError = backendOutcomeError(merged, `${functionName} was rejected by the backend`);
  const status = asNonEmptyString(merged.status)?.toLowerCase();
  const allowedBusinessStatus =
    merged.ok === true &&
    status != null &&
    options.allowedBusinessStatuses?.some((allowed) => allowed.toLowerCase() === status);
  if (outcomeError && !allowedBusinessStatus) throw outcomeError;
  requireLiveEvidence(
    merged,
    evidenceKeys,
    `${functionName} did not return backend execution evidence`,
  );
  return { envelope, result, merged };
}

export const TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS = 10;
export const TENANT_SIGNUP_REVIEW_READBACK_DELAY_MS = 250;

export async function tenant_signup_review_apply_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { tenant_signup_review_apply_v1 } = await import('./data-source/platform');
  return tenant_signup_review_apply_v1(args);
}

export interface DataSourceTenantSignupConsoleRequestArgs extends Record<string, unknown> {
  email: string;
  full_name: string;
  organization_name: string;
  organization_slug?: string | null;
  website_url?: string | null;
  phone?: string | null;
  notes?: string | null;
  locale?: string | null;
}

export async function tenant_signup_console_request_v1(
  args: DataSourceTenantSignupConsoleRequestArgs,
): Promise<Record<string, unknown>> {
  const { tenant_signup_console_request_v1 } = await import('./data-source/platform');
  return tenant_signup_console_request_v1(args);
}

export interface DataSourceOrganizationProfileUpdateArgs extends Record<string, unknown> {
  organization_id: string;
  name?: string;
  timezone?: string;
  locale?: string;
  logo_url?: string;
  primary_color?: string;
  secondary_color?: string;
  file_name?: string;
  file_base64?: string;
  content_type?: string;
  default_settings_patch?: Record<string, unknown>;
}

export function assertReadbackValue(
  actual: unknown,
  expected: unknown,
  path: string,
  rpcName: string,
): void {
  const matches =
    typeof expected === 'object' && expected !== null
      ? JSON.stringify(actual ?? null) === JSON.stringify(expected)
      : actual === expected;
  if (!matches) {
    throw new Error(`${rpcName} backend readback mismatch for ${path}`);
  }
}

export async function ui_update_organization_profile_v1(
  args: DataSourceOrganizationProfileUpdateArgs,
): Promise<Record<string, unknown>> {
  const { ui_update_organization_profile_v1 } = await import('./data-source/platform');
  return ui_update_organization_profile_v1(args);
}

export interface DataSourceTenantUserInviteArgs extends Record<string, unknown> {
  email: string;
  full_name: string;
  role_key: string;
  user_type?: string | null;
  organization_id?: string | null;
  access_scope_type?: string;
  access_scope_id?: string | null;
  send_invite_email?: boolean;
  invite_redirect_to?: string | null;
  resend_existing_invite?: boolean;
}

export async function ui_list_tenant_invitable_roles_v1(
  args: { organization_id?: string | null } = {},
): Promise<ListResult<ResourceRow>> {
  const { ui_list_tenant_invitable_roles_v1 } = await import('./data-source/platform');
  return ui_list_tenant_invitable_roles_v1(args);
}

export async function tenant_user_invite_v1(
  args: DataSourceTenantUserInviteArgs,
): Promise<Record<string, unknown>> {
  const { tenant_user_invite_v1 } = await import('./data-source/platform');
  return tenant_user_invite_v1(args);
}

// ----------- Phase C6 FLEET mutations (vehicles + drivers) -----------

// FLEET/vehicles
async function requireLiveVehicleReadback(
  vehicleId: string,
  rpcName: string,
): Promise<void> {
  // Fleet vehicle UI readback is intentionally through the registry-backed
  // directory projection. The raw `vehicles` resource is not exposed to
  // browser callers in live lanes.
  await requireLiveResourceReadback('vehicle_directory', vehicleId, rpcName);
}

async function requireLiveVehicleAssignmentReadback(
  rpcName: string,
  vehicleId: string,
  assignmentId?: string | null,
): Promise<void> {
  const normalizedAssignmentId = asNonEmptyString(assignmentId);
  if (normalizedAssignmentId) {
    await requireLiveResourceReadback('vehicle_assignments', normalizedAssignmentId, rpcName);
  } else {
    await requireLiveResourceListReadback('vehicle_assignments', { vehicle_id: vehicleId }, rpcName);
  }
}

async function requireLiveVehicleEventReadback(
  rpcName: string,
  vehicleId: string,
  eventId?: string | null,
): Promise<void> {
  const normalizedEventId = asNonEmptyString(eventId);
  if (normalizedEventId) {
    await requireLiveResourceReadback('vehicle_events', normalizedEventId, rpcName);
  } else {
    await requireLiveResourceListReadback('vehicle_events', { vehicle_id: vehicleId }, rpcName);
  }
}

async function requireLiveVehicleDocumentReadback(
  rpcName: string,
  vehicleDocumentId: string,
): Promise<void> {
  await requireLiveResourceReadback('vehicle_documents', vehicleDocumentId, rpcName);
}

async function requireLiveVehicleMaintenanceReadback(
  rpcName: string,
  maintenanceWindowId: string,
): Promise<void> {
  // Browser-facing Console reads maintenance windows through
  // `vehicle_maintenance_directory`. Some live lanes expose the projection in
  // `ui_read_registry` without exposing the raw SSOT table as a UI resource, so
  // attempt the raw table readback but do not let it mask the canonical browser
  // projection confirmation.
  await requireLiveResourceReadback('vehicle_maintenance_windows', maintenanceWindowId, rpcName)
    .catch(() => undefined);
  await requireLiveResourceReadback('vehicle_maintenance_directory', maintenanceWindowId, rpcName);
}

export const create_vehicle_v1 = (args: Record<string, unknown>): Promise<Record<string, unknown>> => (async () => {
  const result = await phaseC6Rpc('create_vehicle_v1', args, 'vehicle');
  if (liveRpcTarget()) {
    const vehicleId =
      asNonEmptyString(result.vehicle_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.vehicle_id);
    if (!vehicleId) throw new Error('create_vehicle_v1 did not return vehicle_id');
    await requireLiveVehicleReadback(vehicleId, 'create_vehicle_v1');
  }
  return result;
})();
export const upload_vehicle_document_v1 = (args: Record<string, unknown>): Promise<Record<string, unknown>> => (async () => {
  const result = await phaseC6Rpc('upload_vehicle_document_v1', args, 'vehicle_document');
  if (liveRpcTarget()) {
    const vehicleDocumentId =
      asNonEmptyString(result.vehicle_document_id) ??
      asNonEmptyString(result.document_id) ??
      asNonEmptyString(result.id);
    if (!vehicleDocumentId) throw new Error('upload_vehicle_document_v1 did not return vehicle_document_id');
    await requireLiveVehicleDocumentReadback('upload_vehicle_document_v1', vehicleDocumentId);
    const vehicleId = asNonEmptyString(result.vehicle_id) ?? asNonEmptyString(args.vehicle_id);
    if (vehicleId) await requireLiveVehicleReadback(vehicleId, 'upload_vehicle_document_v1');
  }
  return result;
})();
export async function assign_driver_to_vehicle_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('assign_driver_to_vehicle_v1', args, 'vehicle_assignment');
  if (liveRpcTarget()) {
    const vehicleId =
      asNonEmptyString(result.vehicle_id) ??
      asNonEmptyString(args.vehicle_id);
    if (!vehicleId) throw new Error('assign_driver_to_vehicle_v1 did not return vehicle_id');
    const assignmentId =
      asNonEmptyString(result.vehicle_assignment_id) ??
      asNonEmptyString(result.assignment_id) ??
      asNonEmptyString(result.id);
    await requireLiveVehicleReadback(vehicleId, 'assign_driver_to_vehicle_v1');
    await requireLiveVehicleAssignmentReadback('assign_driver_to_vehicle_v1', vehicleId, assignmentId);
  }
  return result;
}
export async function unassign_driver_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('unassign_driver_v1', args, 'vehicle_assignment');
  if (liveRpcTarget()) {
    const vehicleId =
      asNonEmptyString(result.vehicle_id) ??
      asNonEmptyString(args.vehicle_id);
    const assignmentId =
      asNonEmptyString(result.vehicle_assignment_id) ??
      asNonEmptyString(result.assignment_id) ??
      asNonEmptyString(args.vehicle_assignment_id) ??
      asNonEmptyString(args.assignment_id) ??
      asNonEmptyString(result.id);
    if (!vehicleId && !assignmentId) throw new Error('unassign_driver_v1 did not return vehicle assignment evidence');
    if (vehicleId) await requireLiveVehicleReadback(vehicleId, 'unassign_driver_v1');
    if (vehicleId || assignmentId) {
      await requireLiveVehicleAssignmentReadback('unassign_driver_v1', vehicleId ?? '', assignmentId);
    }
  }
  return result;
}
export async function mark_vehicle_oos_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('mark_vehicle_oos_v1', args, 'vehicle');
  if (liveRpcTarget()) {
    const vehicleId =
      asNonEmptyString(result.vehicle_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.vehicle_id);
    if (!vehicleId) throw new Error('mark_vehicle_oos_v1 did not return vehicle_id');
    const eventId = asNonEmptyString(result.vehicle_event_id) ?? asNonEmptyString(result.event_id);
    await requireLiveVehicleReadback(vehicleId, 'mark_vehicle_oos_v1');
    await requireLiveVehicleEventReadback('mark_vehicle_oos_v1', vehicleId, eventId);
  }
  return result;
}
export async function restore_vehicle_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('restore_vehicle_v1', args, 'vehicle');
  if (liveRpcTarget()) {
    const vehicleId =
      asNonEmptyString(result.vehicle_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.vehicle_id);
    if (!vehicleId) throw new Error('restore_vehicle_v1 did not return vehicle_id');
    const eventId = asNonEmptyString(result.vehicle_event_id) ?? asNonEmptyString(result.event_id);
    await requireLiveVehicleReadback(vehicleId, 'restore_vehicle_v1');
    await requireLiveVehicleEventReadback('restore_vehicle_v1', vehicleId, eventId);
  }
  return result;
}
function resolveVehicleMaintenanceWindowId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.vehicle_maintenance_window_id)
    ?? asNonEmptyString(rec.maintenance_window_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.vehicle_maintenance_window_id)
    ?? asNonEmptyString(args.maintenance_window_id);
}

async function vehicleMaintenanceMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'maintenance_window');
  if (liveRpcTarget()) {
    const maintenanceWindowId = resolveVehicleMaintenanceWindowId(result, args);
    if (!maintenanceWindowId) throw new Error(`${rpcName} did not return vehicle_maintenance_window_id`);
    await requireLiveVehicleMaintenanceReadback(rpcName, maintenanceWindowId);
    const vehicleId = asNonEmptyString(result.vehicle_id) ?? asNonEmptyString(args.vehicle_id);
    if (vehicleId) await requireLiveVehicleReadback(vehicleId, rpcName);
  }
  return result;
}

export const schedule_maintenance_v1 = (args: Record<string, unknown>) =>
  vehicleMaintenanceMutation('schedule_maintenance_v1', args);
export const complete_maintenance_v1 = (args: Record<string, unknown>) =>
  vehicleMaintenanceMutation('complete_maintenance_v1', args);
export const cancel_maintenance_v1 = (args: Record<string, unknown>) =>
  vehicleMaintenanceMutation('cancel_maintenance_v1', args);
export async function record_vehicle_event_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('record_vehicle_event_v1', args, 'vehicle_event');
  if (liveRpcTarget()) {
    const vehicleId =
      asNonEmptyString(result.vehicle_id) ??
      asNonEmptyString(args.vehicle_id);
    if (!vehicleId) throw new Error('record_vehicle_event_v1 did not return vehicle_id');
    const eventId = asNonEmptyString(result.vehicle_event_id) ?? asNonEmptyString(result.event_id) ?? asNonEmptyString(result.id);
    await requireLiveVehicleEventReadback('record_vehicle_event_v1', vehicleId, eventId);
    await requireLiveVehicleReadback(vehicleId, 'record_vehicle_event_v1');
  }
  return result;
}

// FLEET/drivers
async function requireLiveDriverProfileReadback(
  driverProfileId: string,
  rpcName: string,
): Promise<void> {
  await requireLiveResourceReadback('driver_directory', driverProfileId, rpcName);
}

async function requireLiveDriverDocumentReadback(
  driverDocumentId: string,
  rpcName: string,
): Promise<void> {
  await requireLiveResourceReadback('driver_documents', driverDocumentId, rpcName);
}

async function requireLiveDriverComplianceEventReadback(
  driverComplianceEventId: string,
  rpcName: string,
): Promise<void> {
  await requireLiveResourceReadback('driver_compliance_events', driverComplianceEventId, rpcName);
}

async function requireLiveDriverHoursOfServiceReadback(
  driverProfileId: string,
  dutyStatus: string | null,
  rpcName: string,
  segmentId?: string | null,
): Promise<void> {
  const live = await liveRpc<unknown>('resolve_driver_hours_of_service_v1', {
    p_driver_id: driverProfileId,
  });
  if (!live) throw new Error(`${rpcName} hours-of-service readback requires a live backend`);
  const rec = normalizeDriverHoursOfServiceRecord(live.data);
  if (!rec) throw new Error(`${rpcName} backend readback missing driver hours-of-service:${driverProfileId}`);
  const hasDutyEvidence =
    rec.today.length > 0 ||
    Object.values(rec.week_total).some((value) => Number(value) > 0);
  if (!hasDutyEvidence) {
    throw new Error(`${rpcName} backend readback missing driver hours-of-service:${driverProfileId}`);
  }
  if (dutyStatus && rec.today.length > 0 && !rec.today.some((segment) => segment.type === dutyStatus)) {
    throw new Error(`${rpcName} backend readback did not include duty_status ${dutyStatus}`);
  }
  if (segmentId) {
    const segment = await requireLiveResourceReadback('driver_hours_of_service', segmentId, rpcName);
    if (asNonEmptyString(segment.driver_id) !== driverProfileId) {
      throw new Error(`${rpcName} backend readback segment driver mismatch:${segmentId}`);
    }
    if (dutyStatus && asNonEmptyString(segment.duty_status) !== dutyStatus) {
      throw new Error(`${rpcName} backend readback segment duty_status mismatch:${segmentId}`);
    }
    if (segment.segment_end != null) {
      throw new Error(`${rpcName} backend readback segment is not active/open:${segmentId}`);
    }
    const directory = await requireLiveResourceReadback('driver_directory', driverProfileId, rpcName);
    if (asNonEmptyString(directory.hos_active_segment_id) !== segmentId) {
      throw new Error(`${rpcName} backend readback did not project active HOS segment:${segmentId}`);
    }
    if (dutyStatus && asNonEmptyString(directory.hos_active_duty_status) !== dutyStatus) {
      throw new Error(`${rpcName} backend readback did not project active duty_status ${dutyStatus}`);
    }
    if (Number(directory.hos_segment_count_24h) < 1) {
      throw new Error(`${rpcName} backend readback missing HOS segment count:${driverProfileId}`);
    }
  }
}

export async function create_driver_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('create_driver_v1', args, 'driver_profile');
  if (liveRpcTarget()) {
    const driverProfileId =
      asNonEmptyString(result.driver_profile_id) ??
      asNonEmptyString(result.driver_id) ??
      asNonEmptyString(result.id);
    if (!driverProfileId) throw new Error('create_driver_v1 did not return driver_profile_id');
    await requireLiveDriverProfileReadback(driverProfileId, 'create_driver_v1');
  }
  return result;
}
export async function upload_driver_document_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('upload_driver_document_v1', args, 'driver_document');
  if (liveRpcTarget()) {
    const driverDocumentId =
      asNonEmptyString(result.driver_document_id) ??
      asNonEmptyString(result.document_id) ??
      asNonEmptyString(result.id);
    if (!driverDocumentId) throw new Error('upload_driver_document_v1 did not return driver_document_id');
    await requireLiveDriverDocumentReadback(driverDocumentId, 'upload_driver_document_v1');
  }
  return result;
}
async function driverProfileStatusMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'driver');
  if (liveRpcTarget()) {
    const driverProfileId =
      asNonEmptyString(result.driver_profile_id) ??
      asNonEmptyString(result.driver_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.driver_profile_id) ??
      asNonEmptyString(args.driver_id);
    if (!driverProfileId) throw new Error(`${rpcName} did not return driver_profile_id`);
    await requireLiveDriverProfileReadback(driverProfileId, rpcName);
  }
  return result;
}

export const suspend_driver_v1 = (args: Record<string, unknown>) =>
  driverProfileStatusMutation('suspend_driver_v1', args);
export const restore_driver_v1 = (args: Record<string, unknown>) =>
  driverProfileStatusMutation('restore_driver_v1', args);

async function driverDocumentMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'driver_document');
  if (liveRpcTarget()) {
    const driverDocumentId =
      asNonEmptyString(result.driver_document_id) ??
      asNonEmptyString(result.document_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.driver_document_id) ??
      asNonEmptyString(args.document_id);
    if (!driverDocumentId) throw new Error(`${rpcName} did not return driver_document_id`);
    await requireLiveDriverDocumentReadback(driverDocumentId, rpcName);
    const driverProfileId =
      asNonEmptyString(result.driver_profile_id) ??
      asNonEmptyString(result.driver_id) ??
      asNonEmptyString(args.driver_profile_id) ??
      asNonEmptyString(args.driver_id);
    if (driverProfileId) await requireLiveDriverProfileReadback(driverProfileId, rpcName);
  }
  return result;
}

export const verify_driver_document_v1 = (args: Record<string, unknown>) =>
  driverDocumentMutation('verify_driver_document_v1', args);
export const reject_driver_document_v1 = (args: Record<string, unknown>) =>
  driverDocumentMutation('reject_driver_document_v1', args);
export async function create_driver_compliance_event_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('create_driver_compliance_event_v1', args, 'driver_compliance_event');
  if (liveRpcTarget()) {
    const eventId =
      asNonEmptyString(result.driver_compliance_event_id) ??
      asNonEmptyString(result.compliance_event_id) ??
      asNonEmptyString(result.id);
    if (!eventId) throw new Error('create_driver_compliance_event_v1 did not return driver_compliance_event_id');
    await requireLiveDriverComplianceEventReadback(eventId, 'create_driver_compliance_event_v1');
    const driverProfileId =
      asNonEmptyString(result.driver_profile_id) ??
      asNonEmptyString(result.driver_id) ??
      asNonEmptyString(args.driver_profile_id) ??
      asNonEmptyString(args.driver_id);
    if (driverProfileId) await requireLiveDriverProfileReadback(driverProfileId, 'create_driver_compliance_event_v1');
  }
  return result;
}
export async function record_hours_of_service_segment_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(
    'record_hours_of_service_segment_v1',
    args,
    'driver_hours_of_service',
  );
  if (liveRpcTarget()) {
    const driverProfileId =
      asNonEmptyString(result.driver_profile_id) ??
      asNonEmptyString(args.driver_profile_id) ??
      asNonEmptyString(args.driver_id);
    if (!driverProfileId) {
      throw new Error('record_hours_of_service_segment_v1 did not return driver_profile_id');
    }
    await requireLiveDriverHoursOfServiceReadback(
      driverProfileId,
      asNonEmptyString(result.duty_status ?? args.duty_status),
      'record_hours_of_service_segment_v1',
      asNonEmptyString(result.driver_hours_of_service_id ?? result.hours_of_service_id ?? result.id),
    );
  }
  return result;
}

// ----------- Phase C6 SUPPORT mutations (cases + messages) -----------
//
// Wave 5 RE-AUDIT (SUPPORT.md §8 D1) — payload-key alignment:
// FE call sites send canonical Phase B3 RPC contract keys directly
// (`assigned_to`, `support_case_ids`, `resolution`). The data-source mutations
// therefore pass the already-canonical payload through to phaseC6Rpc and the
// cloud client without any rename, satisfying the strict `23502` arg-key
// contract on the canonical RPC bodies.

export const create_support_case_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('create_support_case_v1', args, 'support_case');
export const update_support_case_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('update_support_case_v1', args, 'support_case');
export const assign_support_case_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('assign_support_case_v1', args, 'support_case');
export const escalate_support_case_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('escalate_support_case_v1', args, 'support_case');
export const bulk_assign_support_cases_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('bulk_assign_support_cases_v1', args);
export const resolve_support_case_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('resolve_support_case_v1', args, 'support_case');
export const bulk_resolve_support_cases_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('bulk_resolve_support_cases_v1', args);
export const reopen_support_case_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('reopen_support_case_v1', args, 'support_case');
export const send_support_message_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('send_support_message_v1', args, 'support_message');
export const add_support_tag_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('add_support_tag_v1', args, 'support_case');
export async function public_tracking_review_request_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { public_tracking_review_request_v1 } = await import('./data-source/platform');
  return public_tracking_review_request_v1(args);
}

// ----------- Phase B5/C4 FINANCE mutations -----------
//
// Each RPC accepts a single jsonb envelope `p_args` and returns
//   { ok, <resource>_id, correlation_id, settings_resolution_id, ... }.
// All flow through the canonical phaseC6Rpc helper for zero-redundancy
// (the helper is named after C6 only because it landed first; the envelope
// shape is the same across B-suite jsonb RPCs, by design).
//
// Migrations of record (verified):
//   • create_billing_invoice_v1     202604281010
//   • update_billing_invoice_v1     202604281020
//   • void_billing_invoice_v1       202604281030
//   • billing_invoice_send_v1       202604281040
//   • billing_invoice_refund_v1     202604281050
//   • apply_settlement_v1           202604281060
//   • reject_settlement_v1          202604281070
//   • bank_recon_match_v1           202604281080
//   • bank_recon_unmatch_v1         202604281090
//   • dispute_resolve_v1            202604281100
//   • dispute_reject_v1             202604281110
//   • cancel_subscription_v1        202604281120
//
// Capability split (mirror of B5 access_control_policy registration in
// 202604281000_phase_b5_finance_caps_v1.sql):
//   • billing.write     — create / update / void / cancel_subscription
//   • invoices.send     — send (broadcast)
//   • invoices.refund   — refund
//   • settlements.write — apply / reject
//   • finance.write     — bank_recon_match / unmatch (reuse canonical RBAC)
//   • disputes.write    — dispute_resolve / dispute_reject (NEW per B5)

// FINANCE — billing invoices
function compactStringIds(values: unknown[]): string[] {
  return Array.from(new Set(values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value.map((item) => asNonEmptyString(item)).filter((item): item is string => Boolean(item));
    }
    const id = asNonEmptyString(value);
    return id ? [id] : [];
  })));
}

function resolveBillingInvoiceIds(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const rowIds = Array.isArray(rec.results)
    ? rec.results.flatMap((row) => {
      const rowRec = objectRecord(row);
      const result = objectRecord(rowRec.result);
      return [
        asNonEmptyString(rowRec.billing_invoice_id),
        asNonEmptyString(result.billing_invoice_id),
        asNonEmptyString(result.id),
      ];
    })
    : [];
  return compactStringIds([
    rec.billing_invoice_id,
    rec.invoice_id,
    rec.id,
    args.billing_invoice_id,
    args.invoice_id,
    args.billing_invoice_ids,
    args.invoice_ids,
    rowIds,
  ]);
}

async function requireLiveBillingInvoiceReadback(
  rpcName: string,
  billingInvoiceIds: string[],
): Promise<void> {
  if (billingInvoiceIds.length === 0) {
    throw new Error(`${rpcName} did not return billing_invoice_id`);
  }
  for (const billingInvoiceId of billingInvoiceIds) {
    await requireLiveResourceReadback('billing_invoices', billingInvoiceId, rpcName);
    await requireLiveResourceReadback('billing_invoice_directory', billingInvoiceId, rpcName);
  }
}

async function billingInvoiceMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'billing_invoice');
  if (liveRpcTarget()) {
    await requireLiveBillingInvoiceReadback(rpcName, resolveBillingInvoiceIds(result, args));
  }
  return result;
}

export const create_billing_invoice_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('create_billing_invoice_v1', args);
export const update_billing_invoice_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('update_billing_invoice_v1', args);
export const void_billing_invoice_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('void_billing_invoice_v1', args);
export const billing_invoice_send_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('billing_invoice_send_v1', args);
export async function ui_bulk_billing_invoice_send_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_bulk_billing_invoice_send_v1', args);
  if (liveRpcTarget()) {
    await requireLiveBillingInvoiceReadback('ui_bulk_billing_invoice_send_v1', resolveBillingInvoiceIds(result, args));
  }
  return result;
}
export const billing_invoice_refund_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('billing_invoice_refund_v1', args);
export const billing_invoice_mark_paid_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('billing_invoice_mark_paid_v1', args);

async function requireLiveSubscriptionReadback(
  rpcName: string,
  subscriptionId: string,
  eventId?: string | null,
): Promise<void> {
  await requireLiveResourceReadback('subscriptions', subscriptionId, rpcName);
  const normalizedEventId = asNonEmptyString(eventId);
  if (normalizedEventId) {
    await requireLiveResourceReadback('subscription_events', normalizedEventId, rpcName);
  }
}

export async function cancel_subscription_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('cancel_subscription_v1', args, 'subscription');
  if (liveRpcTarget()) {
    const subscriptionId =
      asNonEmptyString(result.subscription_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.subscription_id);
    if (!subscriptionId) throw new Error('cancel_subscription_v1 did not return subscription_id');
    await requireLiveSubscriptionReadback(
      'cancel_subscription_v1',
      subscriptionId,
      asNonEmptyString(result.subscription_event_id) ?? asNonEmptyString(result.event_id),
    );
  }
  return result;
}

export async function requireLiveFinanceEventReadback(
  rpcName: string,
  financeEventId: string,
): Promise<void> {
  await requireLiveResourceReadback('finance_events_ledger', financeEventId, rpcName);
}

export async function apply_settlement_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { apply_settlement_v1 } = await import('./data-source/finance');
  return apply_settlement_v1(args);
}
export async function reject_settlement_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { reject_settlement_v1 } = await import('./data-source/finance');
  return reject_settlement_v1(args);
}
export async function ui_create_settlement_batch_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ui_create_settlement_batch_v1 } = await import('./data-source/finance');
  return ui_create_settlement_batch_v1(args);
}
export async function ui_transition_settlement_batch_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ui_transition_settlement_batch_v1 } = await import('./data-source/finance');
  return ui_transition_settlement_batch_v1(args);
}
export async function ui_record_cod_remittance_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ui_record_cod_remittance_v1 } = await import('./data-source/finance');
  return ui_record_cod_remittance_v1(args);
}
export async function ui_adjust_cod_collection_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ui_adjust_cod_collection_v1 } = await import('./data-source/finance');
  return ui_adjust_cod_collection_v1(args);
}
export async function ui_reverse_finance_event_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ui_reverse_finance_event_v1 } = await import('./data-source/finance');
  return ui_reverse_finance_event_v1(args);
}

// FINANCE — bank reconciliation
async function bankReconMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'bank_recon_match');
  if (liveRpcTarget()) {
    const matchId =
      asNonEmptyString(result.bank_recon_match_id) ??
      asNonEmptyString(result.match_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.bank_recon_match_id);
    if (!matchId) throw new Error(`${rpcName} did not return bank_recon_match_id`);
    await requireLiveResourceReadback('bank_recon_matches', matchId, rpcName);
    const financeEventId =
      asNonEmptyString(result.finance_event_id) ??
      asNonEmptyString(args.bank_statement_event_id);
    if (financeEventId) {
      await requireLiveFinanceEventReadback(rpcName, financeEventId);
    }
  }
  return result;
}

export const bank_recon_match_v1 = (args: Record<string, unknown>) =>
  bankReconMutation('bank_recon_match_v1', args);
export const bank_recon_unmatch_v1 = (args: Record<string, unknown>) =>
  bankReconMutation('bank_recon_unmatch_v1', args);
export async function ui_record_bank_statement_event_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_record_bank_statement_event_v1', args, 'finance_event');
  if (liveRpcTarget()) {
    const financeEventId =
      asNonEmptyString(result.finance_event_id) ??
      asNonEmptyString(result.id);
    if (!financeEventId) throw new Error('ui_record_bank_statement_event_v1 did not return finance_event_id');
    await requireLiveFinanceEventReadback('ui_record_bank_statement_event_v1', financeEventId);
    await requireLiveResourceReadback('finance_events_bank_statement', financeEventId, 'ui_record_bank_statement_event_v1');
  }
  return result;
}

// FINANCE — disputes (FINANCE namespace; distinct from MARKETPLACE)
export async function ui_create_bank_account_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_create_bank_account_v1', args, 'bank_account');
  if (liveRpcTarget()) {
    const bankAccountId =
      asNonEmptyString(result.bank_account_id) ??
      asNonEmptyString(result.id);
    if (!bankAccountId) throw new Error('ui_create_bank_account_v1 did not return bank_account_id');
    await requireLiveResourceReadback('bank_accounts', bankAccountId, 'ui_create_bank_account_v1');
  }
  return result;
}

function resolveDisputeIds(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const rowIds = Array.isArray(rec.results)
    ? rec.results.flatMap((row) => {
      const rowRec = objectRecord(row);
      const result = objectRecord(rowRec.result);
      return [
        asNonEmptyString(rowRec.dispute_id),
        asNonEmptyString(result.dispute_id),
        asNonEmptyString(result.id),
      ];
    })
    : [];
  return compactStringIds([
    rec.dispute_id,
    rec.id,
    args.dispute_id,
    args.dispute_ids,
    rowIds,
  ]);
}

async function requireLiveDisputeReadback(
  rpcName: string,
  disputeIds: string[],
): Promise<void> {
  if (disputeIds.length === 0) throw new Error(`${rpcName} did not return dispute_id`);
  for (const disputeId of disputeIds) {
    await requireLiveResourceReadback('marketplace_disputes', disputeId, rpcName);
    await requireLiveResourceReadback('dispute_directory', disputeId, rpcName);
  }
}

async function disputeMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'dispute');
  if (liveRpcTarget()) {
    await requireLiveDisputeReadback(rpcName, resolveDisputeIds(result, args));
  }
  return result;
}

export const dispute_resolve_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_resolve_v1', args);
export const dispute_reject_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_reject_v1', args);
export async function ui_bulk_dispute_action_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_bulk_dispute_action_v1', args);
  if (liveRpcTarget()) {
    await requireLiveDisputeReadback('ui_bulk_dispute_action_v1', resolveDisputeIds(result, args));
  }
  return result;
}
// W8-4 / W9-3 — non-terminal dispute lifecycle (acknowledge + escalate).
// Migrations: 202604301140 (acknowledge) + 202604301150 (escalate).
// Same `phaseC6Rpc` substrate as resolve/reject so the seam stays uniform;
// `marketplace_disputes` invalidation flows through the queries.ts hook layer.
export const dispute_acknowledge_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_acknowledge_v1', args);
export const dispute_escalate_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_escalate_v1', args);

// ----------- Phase C2 NETWORK mutations (zones / marketplace / branches) -----------
//
// All NETWORK domain canonical write RPCs route through the same `phaseC6Rpc`
// helper for zero redundancy. Three families:
//
// 1. ZONES lifecycle / overrides (canonical RPCs ship in Phase B4)
//    • suspend_zone_v1                        202604281200
//    • restore_zone_v1                        202604281210
//    • request_zone_override_v1               202604061530 (uc062)
//    • ui_execute_zone_override_request_v1    202604061530 (uc062)
//
// 2. MARKETPLACE lifecycle (canonical RPCs ship in 202603071120)
//    • marketplace_offer_submit_v1            :2030
//    • marketplace_offer_withdraw_v1          :2169
//    • marketplace_award_offer_v1             :2219
//    • marketplace_award_respond_v1           :2367
//    • marketplace_request_create_v1          :1673
//    • marketplace_request_publish_v1         :1886
//    • marketplace_request_cancel_v1          :1974
//    • marketplace_dispute_open_v1            :2651
//    • marketplace_dispute_resolve_v1         :2758
//    • marketplace_work_package_materialize_v1 :2554
//    • marketplace_participant_request_review_apply_v1 :1445
//    • marketplace_refresh_reputation_snapshot_v1 :506
//
// 3. BRANCHES + ZONES create/district (canonical RPCs PENDING — routed through
//    phaseC6Rpc with the same envelope shape so callers swap one line at the
//    seam once backend RPCs ship). Audit reference:
//    apps/console-v2/__audit__/CROSSWALK/NETWORK.md §1.1, §1.2, §3.1.

// NETWORK/zones lifecycle
export const suspend_zone_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('suspend_zone_v1', args, 'zone');
export const restore_zone_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('restore_zone_v1', args, 'zone');

// NETWORK/zone overrides (canonical workflow-engine path for zone reassignment)
export const request_zone_override_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('request_zone_override_v1', args, 'zone_override_request');
export const ui_execute_zone_override_request_v1 = (args: Record<string, unknown>) =>
  phaseC6Rpc('ui_execute_zone_override_request_v1', args, 'zone_override_request');

// NETWORK/zones create + districts — canonical write RPCs SHIPPED in
// W9-1 migrations 202604300440/450/460. Each RPC enforces zones.write,
// emits decision_log + domain_events, and returns the canonical envelope.
// The typed facades replace the generic phaseC6Rpc shim so the envelope
// shape is enforced at the FE adapter layer (mirrors the Wave 6 RBAC
// promotion pattern).

export interface ZoneCreateResult extends Record<string, unknown> {
  ok: true;
  zone_id: string;
  initial_district_count?: number;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function zone_create_v1(
  args: Record<string, unknown>,
): Promise<ZoneCreateResult> {
  const { zone_create_v1 } = await import('./data-source/network');
  return zone_create_v1(args);
}

export interface ZoneProfileMutationResult extends Record<string, unknown> {
  ok: true;
  zone_id: string;
  changed?: Record<string, unknown>;
  is_active?: boolean;
  lifecycle?: string;
  already_processed?: boolean;
  correlation_id: string | null;
  settings_resolution_id?: string | null;
  decision_log_id?: string | null;
}

export async function zone_update_v1(
  args: Record<string, unknown>,
): Promise<ZoneProfileMutationResult> {
  const { zone_update_v1 } = await import('./data-source/network');
  return zone_update_v1(args);
}

export async function zone_delete_v1(
  args: Record<string, unknown>,
): Promise<ZoneProfileMutationResult> {
  const { zone_delete_v1 } = await import('./data-source/network');
  return zone_delete_v1(args);
}

export interface ZoneDistrictMutationResult extends Record<string, unknown> {
  ok: true;
  zone_district_id: string;
  already_processed?: boolean;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function zone_district_add_v1(
  args: Record<string, unknown>,
): Promise<ZoneDistrictMutationResult> {
  const { zone_district_add_v1 } = await import('./data-source/network');
  return zone_district_add_v1(args);
}

export async function zone_district_remove_v1(
  args: Record<string, unknown>,
): Promise<ZoneDistrictMutationResult> {
  const { zone_district_remove_v1 } = await import('./data-source/network');
  return zone_district_remove_v1(args);
}

// NETWORK/marketplace
//
// Marketplace RPCs predate the shared Phase C6 `(p_args jsonb)` contract and
// expose named Postgres parameters through the api schema. Keep the mapping
// here explicit so live Console V2 calls exercise the real RPC signatures.
async function marketplaceNamedRpc(
  rpcName: string,
  rpcArgs: Record<string, unknown>,
  fallbackArgs: Record<string, unknown>,
  resourceKeyHint?: string,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, rpcArgs);
  if (live) {
    const evidenceKeys = resourceKeyHint ? [`${resourceKeyHint}_id`, 'id', 'refreshed_count'] : ['refreshed_count'];
    const rec = requireLiveMutationResult(
      live.data,
      rpcName,
      evidenceKeys,
    );
    requireLiveDomainEvidence(rec, rpcName, evidenceKeys, resourceKeyHint ?? 'marketplace mutation');
    return rec;
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(fallbackArgs, resourceKeyHint);
}

function metadataWithReason(args: Record<string, unknown>): Record<string, unknown> {
  const metadata = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
    ? { ...(args.metadata as Record<string, unknown>) }
    : {};
  const reason = asNonEmptyString(args.reason);
  if (reason && metadata.reason === undefined) metadata.reason = reason;
  return metadata;
}

function normalizeMarketplaceAwardDecision(args: Record<string, unknown>): string | null {
  const raw = asNonEmptyString(args.decision) ?? asNonEmptyString(args.response);
  const value = raw?.toLowerCase();
  if (!value) return null;
  if (value === 'accept' || value === 'accepted' || value === 'approve' || value === 'approved') {
    return 'approve';
  }
  if (
    value === 'reject' ||
    value === 'rejected' ||
    value === 'cancel' ||
    value === 'cancelled' ||
    value === 'canceled'
  ) {
    return 'reject';
  }
  return value;
}

export const marketplace_offer_submit_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_offer_submit_v1',
    {
      p_request_id: args.request_id,
      p_message: asNonEmptyString(args.message) ?? null,
      p_terms: args.terms ?? {},
      p_pricing: args.pricing ?? {},
      p_expires_at: args.expires_at ?? null,
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_offer',
  );

export const marketplace_offer_withdraw_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_offer_withdraw_v1',
    {
      p_offer_id: args.offer_id,
      p_reason: asNonEmptyString(args.reason) ?? null,
    },
    args,
    'marketplace_offer',
  );

export const marketplace_award_offer_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_award_offer_v1',
    {
      p_offer_id: args.offer_id,
      p_award_reason: asNonEmptyString(args.award_reason) ?? asNonEmptyString(args.reason) ?? null,
      p_award_terms: args.award_terms ?? {},
      p_expires_at: args.expires_at ?? null,
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_award',
  );

export const marketplace_award_respond_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_award_respond_v1',
    {
      p_award_id: args.award_id,
      p_decision: normalizeMarketplaceAwardDecision(args),
      p_metadata: metadataWithReason(args),
    },
    args,
    'marketplace_award',
  );

export const marketplace_request_create_v1 = (args: Record<string, unknown>) => {
  const details = args.request_details && typeof args.request_details === 'object'
    ? (args.request_details as Record<string, unknown>)
    : {};
  const title =
    asNonEmptyString(args.title) ??
    asNonEmptyString(details.title) ??
    asNonEmptyString(details.lane) ??
    asNonEmptyString(args.request_kind_key) ??
    asNonEmptyString(args.request_kind) ??
    'Marketplace request';
  return marketplaceNamedRpc(
    'marketplace_request_create_v1',
    {
      p_request_kind_key: args.request_kind_key ?? args.request_kind,
      p_title: title,
      p_summary: asNonEmptyString(args.summary) ?? null,
      p_request_details: args.request_details ?? {},
      p_items: args.items ?? args.request_items ?? [],
      p_private_pool: args.private_pool ?? [],
      p_expires_at: args.expires_at ?? null,
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_request',
  );
};

export const marketplace_request_publish_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_request_publish_v1',
    {
      p_request_id: args.request_id,
      p_release_state: asNonEmptyString(args.release_state) ?? null,
    },
    args,
    'marketplace_request',
  );

export const marketplace_request_cancel_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_request_cancel_v1',
    {
      p_request_id: args.request_id,
      p_reason: asNonEmptyString(args.reason) ?? null,
    },
    args,
    'marketplace_request',
  );

export const marketplace_dispute_open_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_dispute_open_v1',
    {
      p_contract_id: args.contract_id ?? null,
      p_work_package_id: args.work_package_id ?? null,
      p_title: asNonEmptyString(args.title) ?? null,
      p_description: asNonEmptyString(args.description) ?? null,
      p_category: asNonEmptyString(args.category) ?? 'general',
      p_metadata: {
        ...metadataWithReason(args),
        ...(args.request_id ? { request_id: args.request_id } : {}),
      },
    },
    args,
    'marketplace_dispute',
  );

export const marketplace_dispute_resolve_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_dispute_resolve_v1',
    {
      p_dispute_id: args.dispute_id,
      p_resolution: args.resolution,
      p_status: asNonEmptyString(args.status) ?? 'resolved',
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_dispute',
  );

export const marketplace_work_package_materialize_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_work_package_materialize_v1',
    {
      p_work_package_id: args.work_package_id ?? null,
      p_award_id: args.award_id ?? null,
      p_execution_ref: args.execution_ref ?? {},
      p_summary: args.summary ?? {},
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_work_package',
  );

export const PARTICIPANT_REVIEW_READBACK_ATTEMPTS = 10;
export const PARTICIPANT_REVIEW_READBACK_DELAY_MS = 250;

export async function marketplace_participant_request_review_apply_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { marketplace_participant_request_review_apply_v1 } = await import('./data-source/network');
  return marketplace_participant_request_review_apply_v1(args);
}

export const marketplace_refresh_reputation_snapshot_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_refresh_reputation_snapshots_for_visible_v1',
    {
      p_participant_profile_id: args.participant_profile_id ?? null,
    },
    args,
    'marketplace_reputation_snapshot',
  );

// NETWORK/branches — canonical write RPCs SHIPPED in W8-1 + W9-1 migrations:
//   - branch_create_v1                  202604300210
//   - branch_update_v1                  202604300220
//   - mark_branch_oos_v1                202604300230 (FE facade keeps
//                                       `branch_mark_oos_v1` name; calls
//                                       backend `mark_branch_oos_v1` RPC)
//   - branch_zone_assign_v1             202604300240
//   - branch_zone_unassign_v1           202604300250
//   - add_branch_member_v1              202604300400 (W9-1)
//   - remove_branch_member_v1           202604300410 (W9-1)
//   - branch_capacity_window_set_v1     202604300420 (W9-1)
//   - branch_coverage_window_upsert_v1  202604300430 (W9-1)
// All enforce branches.write capability + tenant guard, emit decision_log +
// domain_events, and return the canonical envelope. The typed facades
// replace the generic phaseC6Rpc shim so the envelope shape is enforced at
// the FE adapter layer (mirrors the Wave 6 RBAC promotion pattern).

export interface BranchMutationResult extends Record<string, unknown> {
  ok: true;
  branch_id: string;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function branch_create_v1(
  args: Record<string, unknown>,
): Promise<BranchMutationResult> {
  const { branch_create_v1 } = await import('./data-source/network');
  return branch_create_v1(args);
}

export async function branch_update_v1(
  args: Record<string, unknown>,
): Promise<BranchMutationResult> {
  const { branch_update_v1 } = await import('./data-source/network');
  return branch_update_v1(args);
}

export interface BranchMarkOosResult extends Record<string, unknown> {
  ok: true;
  branch_ids: string[];
  already_oos: string[];
  updated_count: number;
  already_processed?: boolean;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function branch_mark_oos_v1(
  args: Record<string, unknown>,
): Promise<BranchMarkOosResult> {
  const { branch_mark_oos_v1 } = await import('./data-source/network');
  return branch_mark_oos_v1(args);
}

export interface BranchZoneMutationResult extends Record<string, unknown> {
  ok: true;
  branch_zone_id: string;
  already_processed?: boolean;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function branch_zone_assign_v1(
  args: Record<string, unknown>,
): Promise<BranchZoneMutationResult> {
  const { branch_zone_assign_v1 } = await import('./data-source/network');
  return branch_zone_assign_v1(args);
}

export async function branch_zone_unassign_v1(
  args: Record<string, unknown>,
): Promise<BranchZoneMutationResult> {
  const { branch_zone_unassign_v1 } = await import('./data-source/network');
  return branch_zone_unassign_v1(args);
}

export interface BranchMembershipMutationResult extends Record<string, unknown> {
  ok: true;
  branch_membership_id: string;
  already_processed?: boolean;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function add_branch_member_v1(
  args: Record<string, unknown>,
): Promise<BranchMembershipMutationResult> {
  const { add_branch_member_v1 } = await import('./data-source/network');
  return add_branch_member_v1(args);
}

export async function remove_branch_member_v1(
  args: Record<string, unknown>,
): Promise<BranchMembershipMutationResult> {
  const { remove_branch_member_v1 } = await import('./data-source/network');
  return remove_branch_member_v1(args);
}

export interface BranchCapacityWindowMutationResult extends Record<string, unknown> {
  ok: true;
  branch_capacity_window_id: string;
  already_processed?: boolean;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function branch_capacity_window_set_v1(
  args: Record<string, unknown>,
): Promise<BranchCapacityWindowMutationResult> {
  const { branch_capacity_window_set_v1 } = await import('./data-source/network');
  return branch_capacity_window_set_v1(args);
}

export interface BranchCoverageWindowMutationResult extends Record<string, unknown> {
  ok: true;
  branch_coverage_window_id: string;
  action?: 'created' | 'updated';
  already_processed?: boolean;
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function branch_coverage_window_upsert_v1(
  args: Record<string, unknown>,
): Promise<BranchCoverageWindowMutationResult> {
  const { branch_coverage_window_upsert_v1 } = await import('./data-source/network');
  return branch_coverage_window_upsert_v1(args);
}

// ----------- INSIGHTS / API gateway operational write RPCs -----------
//
// Phase B5 canonical write RPCs backing the api-gateway Block source +
// Adjust rate limit operator actions (REAUDIT INSIGHTS §D1, §D2). Both share
// the standard envelope (`p_args jsonb` -> `{ ok, source_id, ... , correlation_id }`).
// Capability: api_gateway.write. Production cutover routes through
// `client.rpc(...)` via `phaseC6Rpc` once the seam returns a real client.
//
// Migrations of record:
//   • block_api_gateway_source_v1            202604280330
//   • adjust_api_gateway_rate_limit_v1       202604280331

export interface BlockApiGatewaySourceArgs extends Record<string, unknown> {
  source_id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

function resolveApiGatewaySourceId(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  rpcName: string,
): string {
  return requireLiveStringField(
    { ...args, ...result },
    ['source_id', 'webhook_source_id', 'id'],
    `${rpcName} did not return source_id`,
  );
}

function requireApiGatewayBooleanReadback(
  row: Record<string, unknown>,
  field: string,
  expected: boolean,
  rpcName: string,
  projection: string,
): void {
  const actual = booleanReadback(row[field]);
  if (actual !== expected) {
    throw new Error(`${rpcName} backend readback did not reflect ${projection}.${field}`);
  }
}

function requireApiGatewayNumberReadback(
  row: Record<string, unknown>,
  field: string,
  expected: number,
  rpcName: string,
  projection: string,
): void {
  const actual = Number(row[field]);
  if (!Number.isFinite(actual) || actual !== expected) {
    throw new Error(`${rpcName} backend readback did not reflect ${projection}.${field}`);
  }
}

async function requireApiGatewaySourceReadback(
  rpcName: string,
  sourceId: string,
  expected: { enabled?: boolean; rateLimitPerHour?: number },
): Promise<void> {
  const source = await requireLiveResourceReadback('webhook_sources', sourceId, rpcName);
  if (expected.enabled !== undefined) {
    requireApiGatewayBooleanReadback(source, 'enabled', expected.enabled, rpcName, 'webhook_sources');
  }
  if (expected.rateLimitPerHour !== undefined) {
    requireApiGatewayNumberReadback(
      source,
      'rate_limit_per_hour',
      expected.rateLimitPerHour,
      rpcName,
      'webhook_sources',
    );
  }

  const directoryRows = await requireLiveResourceListReadback(
    'webhook_source_directory',
    { id: sourceId },
    rpcName,
  );
  const directory = directoryRows.find((row) => asNonEmptyString(row.id) === sourceId) ?? directoryRows[0]!;

  if (expected.enabled !== undefined) {
    requireApiGatewayBooleanReadback(
      directory,
      'enabled',
      expected.enabled,
      rpcName,
      'webhook_source_directory',
    );
  }
  if (expected.rateLimitPerHour !== undefined) {
    requireApiGatewayNumberReadback(
      directory,
      'rate_limit_per_hour',
      expected.rateLimitPerHour,
      rpcName,
      'webhook_source_directory',
    );
  }
}

async function requireApiGatewayRateLimitSummaryReadback(
  sourceId: string,
  expectedLimitPerHour: number,
  rpcName: string,
): Promise<void> {
  const summaryRows = await requireLiveResourceListReadback(
    'api_gateway_rate_limits_summary',
    { source_id: sourceId },
    rpcName,
  );
  const summary = summaryRows.find((row) => asNonEmptyString(row.source_id) === sourceId) ?? summaryRows[0]!;
  requireApiGatewayNumberReadback(
    summary,
    'limit_per_hour',
    expectedLimitPerHour,
    rpcName,
    'api_gateway_rate_limits_summary',
  );
  const expectedLimitPerMin = Math.floor(expectedLimitPerHour / 60);
  requireApiGatewayNumberReadback(
    summary,
    'limit_per_min',
    expectedLimitPerMin,
    rpcName,
    'api_gateway_rate_limits_summary',
  );
}

export async function block_api_gateway_source_v1(
  args: BlockApiGatewaySourceArgs,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('block_api_gateway_source_v1', args, 'source');
  if (liveRpcTarget()) {
    const sourceId = resolveApiGatewaySourceId(result, args, 'block_api_gateway_source_v1');
    await requireApiGatewaySourceReadback('block_api_gateway_source_v1', sourceId, {
      enabled: false,
    });
  }
  return result;
}

export interface AdjustApiGatewayRateLimitArgs extends Record<string, unknown> {
  source_id: string;
  /** Server-canonical bucket size (per hour). One of limit_per_hour /
   *  limit_per_min must be present; the FE form passes both for traceability. */
  limit_per_hour?: number;
  /** FE-side per-minute display value; the backend derives `limit_per_hour`
   *  as `limit_per_min × 60` when only the per-min value is supplied. */
  limit_per_min?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

function expectedApiGatewayLimitPerHour(args: AdjustApiGatewayRateLimitArgs): number {
  const perHour = Number(args.limit_per_hour);
  if (Number.isFinite(perHour)) return perHour;
  const perMin = Number(args.limit_per_min);
  if (Number.isFinite(perMin)) return perMin * 60;
  throw new Error('adjust_api_gateway_rate_limit_v1 requires limit_per_hour or limit_per_min');
}

export async function adjust_api_gateway_rate_limit_v1(
  args: AdjustApiGatewayRateLimitArgs,
): Promise<Record<string, unknown>> {
  const expectedLimitPerHour = expectedApiGatewayLimitPerHour(args);
  const result = await phaseC6Rpc('adjust_api_gateway_rate_limit_v1', args, 'source');
  if (liveRpcTarget()) {
    const sourceId = resolveApiGatewaySourceId(result, args, 'adjust_api_gateway_rate_limit_v1');
    await requireApiGatewaySourceReadback('adjust_api_gateway_rate_limit_v1', sourceId, {
      rateLimitPerHour: expectedLimitPerHour,
    });
    await requireApiGatewayRateLimitSummaryReadback(
      sourceId,
      expectedLimitPerHour,
      'adjust_api_gateway_rate_limit_v1',
    );
  }
  return result;
}

// ----------- Phase C5 INTEGRATIONS + WORKFLOWS mutations -----------
//
// These wrap Phase B6 canonical RPCs that back the Mapping Studio, webhook
// ingress vault (sources/rules/credentials), webhook_inbox replay/force-status,
// integration_plugins lifecycle, and workflow templates/runs/bindings/review.
// Most share the canonical envelope shape with `phaseC6Rpc` (single jsonb
// `p_args`, returns `{ ok, <resource>_id, correlation_id, settings_resolution_id }`).
// Mapping save/report keep their older exposed PostgREST argument names
// (`p_artifact` / `p_report`) and therefore use typed adapters below.
// Production cutover is environment-only: when `getSupabaseClient()` returns
// a real client, every adapter routes through the api schema RPC contract.
//
// Migrations of record (verified):
//   • ui_upsert_webhook_source_v1            (Phase B6)
//   • ui_rotate_webhook_source_token_v1      (Phase B6)
//   • ui_upsert_mapping_artifact_v1          202603091130_api_mapping_studio_contract_v1.sql:14
//   • ui_create_mapping_operation_report_v1  202603091130:14
//   • mapping_config_promote_v1              (Phase B6)
//   • ui_upsert_provider_auth_config_v1      (Phase B6)
//   • ui_revoke_provider_auth_config_v1      (Phase B6)
//   • integration_plugin_generate_draft_v1   202602220040:98 (api wrapper 202602220050:13)
//   • integration_plugin_rotate_credentials_v1 202602220040:1408
//   • integration_plugin_rollback_v1         202602220040:1764 / 202602220080:398
//   • webhook_inbox_replay_v1                (Phase B6)
//   • webhook_inbox_force_status_v1          (Phase B6)
//   • ui_create_workflow_template_v1         202601192300_ui_create_workflow_template_v1.sql:7
//   • ui_set_workflow_template_status_v1     (Phase B6 — activate/deactivate)
//   • register_workflow_binding_v1           (Phase B6 — wraps ui_workflow_binding_clone_override_v1)
//   • simulate_binding_dispatch_v1           (Phase B6)
//   • bulk_transition_tasks_v1               (Phase B6)

// INTEGRATIONS — webhook_sources (Create/Update/Toggle/Rotate-token/Archive)
export interface UpsertWebhookSourceArgs extends Record<string, unknown> {
  source_id?: string | null;
  organization_id?: string | null;
  source_identifier?: string;
  name?: string;
  provider_type?: string;
  mapping_config_id?: string | null;
  sender_id?: string | null;
  rate_limit_per_hour?: number | null;
  enabled?: boolean;
  hmac_enabled?: boolean;
  hmac_auth_config_id?: string | null;
  hmac_header?: string | null;
  hmac_algorithm?: string | null;
  hmac_signature_encoding?: string | null;
}
export interface ArchiveWebhookSourceArgs extends Record<string, unknown> {
  source_id: string;
  reason: string;
}
async function webhookSourceMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { resolveWebhookSourceId, requireWebhookSourceMutationReadback } =
    await import('./data-source/integrations');
  const result = await phaseC6Rpc(rpcName, args, 'webhook_source');
  if (liveRpcTarget()) {
    const sourceId = resolveWebhookSourceId(result, args);
    if (!sourceId) throw new Error(`${rpcName} did not return webhook_source_id`);
    const sourceReadback = await requireLiveResourceReadback('webhook_sources', sourceId, rpcName);
    const directoryReadback = await requireLiveResourceReadback('webhook_source_directory', sourceId, rpcName);
    requireWebhookSourceMutationReadback(sourceReadback, directoryReadback, args, result, rpcName);
  }
  return result;
}

export const ui_upsert_webhook_source_v1 = (args: UpsertWebhookSourceArgs) =>
  webhookSourceMutation('ui_upsert_webhook_source_v1', args);
export const ui_rotate_webhook_source_token_v1 = (args: { source_id: string }) =>
  webhookSourceMutation('ui_rotate_webhook_source_token_v1', args);
export async function ui_archive_webhook_source_v1(args: ArchiveWebhookSourceArgs) {
  const { resolveWebhookSourceId, requireWebhookSourceArchiveReadback } =
    await import('./data-source/integrations');
  const result = await phaseC6Rpc('ui_archive_webhook_source_v1', args, 'webhook_source');
  if (liveRpcTarget()) {
    const sourceId = resolveWebhookSourceId(result, args);
    if (!sourceId) throw new Error('ui_archive_webhook_source_v1 did not return webhook_source_id');
    const sourceReadback = await requireLiveResourceReadback('webhook_sources', sourceId, 'ui_archive_webhook_source_v1');
    const directoryReadback = await requireLiveResourceReadback('webhook_source_directory', sourceId, 'ui_archive_webhook_source_v1');
    requireWebhookSourceArchiveReadback(sourceReadback, directoryReadback, 'ui_archive_webhook_source_v1');
  }
  return result;
}

// INTEGRATIONS — Mapping Studio (Create/Edit/Promote-version)
export interface UpsertMappingArtifactArgs extends Record<string, unknown> {
  artifact?: string;
  mapping_config_id?: string | null;
  mapping_type?: string;
  mapping_key?: string;
  mapping_config?: Record<string, unknown>;
  notes?: string | null;
}
export interface UpsertApiGatewayRouteMappingArgs extends Record<string, unknown> {
  api_route_id: string;
  mapping_config_id: string;
  organization_id?: string | null;
  target?: string | null;
}
export async function ui_upsert_mapping_artifact_v1(
  args: UpsertMappingArtifactArgs,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('ui_upsert_mapping_artifact_v1', {
    p_artifact: args,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_upsert_mapping_artifact_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_upsert_mapping_artifact_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'mapping_config_id',
      'mapping_artifact_id',
      'artifact_id',
      'id',
    ], 'ui_upsert_mapping_artifact_v1 did not return backend mapping artifact evidence');
    const mappingConfigId =
      asNonEmptyString(rec.mapping_config_id) ??
      asNonEmptyString(args.mapping_config_id);
    if (!mappingConfigId) throw new Error('ui_upsert_mapping_artifact_v1 did not return mapping_config_id');
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'ui_upsert_mapping_artifact_v1');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'ui_upsert_mapping_artifact_v1');
    return rec;
  }

  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'mapping_config');
}
export async function ui_delete_mapping_config_v1(
  args: { mapping_config_id: string },
): Promise<Record<string, unknown>> {
  const { ui_delete_mapping_config_v1 } = await import('./data-source/integrations');
  return ui_delete_mapping_config_v1(args);
}
export async function ui_upsert_api_gateway_route_mapping_v1(
  args: UpsertApiGatewayRouteMappingArgs,
): Promise<Record<string, unknown>> {
  const { ui_upsert_api_gateway_route_mapping_v1 } = await import('./data-source/integrations');
  return ui_upsert_api_gateway_route_mapping_v1(args);
}
export async function ui_create_mapping_operation_report_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('ui_create_mapping_operation_report_v1', {
    p_report: args,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_create_mapping_operation_report_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_create_mapping_operation_report_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'mapping_operation_report_id',
      'operation_report_id',
      'report_id',
      'id',
    ], 'ui_create_mapping_operation_report_v1 did not return backend report evidence');
    const reportId =
      asNonEmptyString(rec.mapping_operation_report_id) ??
      asNonEmptyString(rec.operation_report_id) ??
      asNonEmptyString(rec.report_id) ??
      asNonEmptyString(rec.id);
    if (!reportId) throw new Error('ui_create_mapping_operation_report_v1 did not return mapping_operation_report_id');
    await requireLiveResourceReadback('mapping_operation_reports', reportId, 'ui_create_mapping_operation_report_v1');
    return rec;
  }

  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'mapping_operation_report');
}
export async function mapping_config_promote_v1(
  args: { mapping_config_id: string; target_version?: number },
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('mapping_config_promote_v1', args, 'mapping_config');
  if (liveRpcTarget()) {
    const mappingConfigId =
      asNonEmptyString(result.mapping_config_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.mapping_config_id);
    if (!mappingConfigId) throw new Error('mapping_config_promote_v1 did not return mapping_config_id');
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'mapping_config_promote_v1');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'mapping_config_promote_v1');
  }
  return result;
}
export async function ui_test_mapping_config_v1(
  mappingConfigId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ui_test_mapping_config_v1 } = await import('./data-source/integrations');
  return ui_test_mapping_config_v1(mappingConfigId, payload);
}

// INTEGRATIONS — provider_auth_configs (Create/Update/Rotate/Revoke)
export interface UpsertProviderAuthConfigArgs extends Record<string, unknown> {
  config_id?: string | null;
  provider_id?: string;
  auth_type?: string;
  credentials?: Record<string, unknown>;
  expires_at?: string | null;
}
export interface BindProviderAccountCredentialArgs extends Record<string, unknown> {
  route_method?: string;
  route_path?: string;
  route_id?: string | null;
  organization_id?: string | null;
  tenant_id?: string | null;
  scope_type?: 'tenant' | 'source';
  scope_id?: string | null;
  source_id?: string | null;
  provider_account_category?: string;
  provider_id?: string | null;
  auth_config_id?: string | null;
  provider_auth_config_id?: string | null;
  config_id?: string | null;
  auth_type?: string;
  company_id?: string;
  credentials?: Record<string, unknown>;
  credentials_vault_id?: string | null;
  expires_at?: string | null;
  reason?: string | null;
  notes?: string | null;
}
export type UnbindProviderAccountCredentialArgs = Pick<
  BindProviderAccountCredentialArgs,
  | 'route_method'
  | 'route_path'
  | 'route_id'
  | 'organization_id'
  | 'tenant_id'
  | 'scope_type'
  | 'scope_id'
  | 'source_id'
  | 'provider_account_category'
  | 'company_id'
  | 'reason'
  | 'notes'
>;
async function providerAuthConfigMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const adapter = await import('./data-source/integrations');
  return adapter.providerAuthConfigMutation(rpcName, args);
}

export const ui_upsert_provider_auth_config_v1 = (args: UpsertProviderAuthConfigArgs) =>
  providerAuthConfigMutation('ui_upsert_provider_auth_config_v1', args);
export async function ui_bind_provider_account_credential_v1(
  args: BindProviderAccountCredentialArgs,
): Promise<Record<string, unknown>> {
  const { ui_bind_provider_account_credential_v1 } = await import('./data-source/integrations');
  return ui_bind_provider_account_credential_v1(args);
}
export async function ui_unbind_provider_account_credential_v1(
  args: UnbindProviderAccountCredentialArgs,
): Promise<Record<string, unknown>> {
  const { ui_unbind_provider_account_credential_v1 } = await import('./data-source/integrations');
  return ui_unbind_provider_account_credential_v1(args);
}
export const ui_revoke_provider_auth_config_v1 = (args: { config_id: string; reason?: string | null }) =>
  providerAuthConfigMutation('ui_revoke_provider_auth_config_v1', args);
export const integration_plugin_rotate_credentials_v1 = (args: Record<string, unknown>) =>
  providerAuthConfigMutation('integration_plugin_rotate_credentials_v1', args);

export async function ui_execute_provider_circuit_reset_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ui_execute_provider_circuit_reset_v1 } = await import('./data-source/integrations');
  return ui_execute_provider_circuit_reset_v1(args);
}

export async function ui_execute_provider_circuit_probe_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ui_execute_provider_circuit_probe_v1 } = await import('./data-source/integrations');
  return ui_execute_provider_circuit_probe_v1(args);
}

// INTEGRATIONS — integration_plugins catalog (Install/Rollback)
export interface IntegrationPluginGenerateDraftArgs extends Record<string, unknown> {
  plugin_name?: string;
  plugin_kind?: string;
  source_type?: string;
  inbound_config?: Record<string, unknown>;
  vendor?: string;
}

async function integrationPluginMutation(
  rpcName: string,
  args: Record<string, unknown>,
  options?: IntegrationPluginMutationOptions,
): Promise<Record<string, unknown>> {
  const adapter = await import('./data-source/integrations');
  return adapter.integrationPluginMutation(rpcName, args, options);
}

export const integration_plugin_generate_draft_v1 = (args: IntegrationPluginGenerateDraftArgs) =>
  integrationPluginMutation('integration_plugin_generate_draft_v1', args);

export async function ui_upsert_logistics_customer_migration_config_v1(
  args: LogisticsCustomerMigrationConfigArgs,
): Promise<LogisticsCustomerMigrationConfigResult> {
  const { ui_upsert_logistics_customer_migration_config_v1 } = await import('./data-source/integrations');
  return ui_upsert_logistics_customer_migration_config_v1(args);
}

export async function ui_execute_logistics_customer_migration_v1(
  args: LogisticsCustomerMigrationArgs,
): Promise<LogisticsCustomerMigrationResult> {
  const { ui_execute_logistics_customer_migration_v1 } = await import('./data-source/integrations');
  return ui_execute_logistics_customer_migration_v1(args);
}
export const integration_plugin_rollback_v1 = (args: {
  plugin_id: string;
  target_plugin_version_id?: string | null;
  reason?: string | null;
}) =>
  integrationPluginMutation('integration_plugin_rollback_v1', args, {
    approvalAction: 'rolled_back',
    requireBinding: true,
  });

export const plugin_deactivate_v1 = (args: {
  plugin_id: string;
  plugin_version_id?: string | null;
  reason?: string | null;
}) =>
  integrationPluginMutation('plugin_deactivate_v1', {
    ...args,
    expected_binding_enabled: false,
  }, {
    approvalAction: 'deactivated',
    requireBinding: true,
    requireBindingChangeCount: false,
    fallbackResourceKey: 'integration_plugin',
  });

export interface IntegrationPluginExportHandoffArgs extends Record<string, unknown> {
  plugin_version_id: string;
  base_url?: string | null;
}

export async function integration_plugin_export_handoff_v1(
  args: IntegrationPluginExportHandoffArgs,
): Promise<Record<string, unknown>> {
  const { integration_plugin_export_handoff_v1 } = await import('./data-source/integrations');
  return integration_plugin_export_handoff_v1(args);
}

// INTEGRATIONS — plugin lifecycle Submit/Approve/Activate/Set-binding (W9-2)
//
// Wave 9 W9-2 (CLAIM-INTEGRATIONS REVISION 36% — W7 audit P0 #4): adapters
// for the new canonical jsonb-arg shim RPCs that close the missing 4
// transitions in the catalog drawer. Each adapter routes through
// `phaseC6Rpc` (live: `client.rpc(<name>, {p_args})`).
//
// Backend SSOT: supabase/migrations/202604301210_plugin_lifecycle_jsonb_shims_v1.sql.
//   • plugin_submit_v1        — wraps integration_plugin_submit_v1
//   • plugin_approve_v1       — wraps integration_plugin_approve_v1
//   • plugin_activate_v1      — wraps integration_plugin_activate_v1
//   • plugin_deactivate_v1    — disables active runtime bindings and clears
//                                active_version_id while preserving reactivation
//   • plugin_set_binding_v1   — toggles integration_plugin_bindings
//                                + linked runtime resource enabled flag
export interface PluginSubmitArgs extends Record<string, unknown> {
  plugin_version_id: string;
  reason?: string | null;
}
export const plugin_submit_v1 = (args: PluginSubmitArgs) =>
  integrationPluginMutation('plugin_submit_v1', args, {
    approvalAction: 'submitted',
    fallbackResourceKey: 'integration_plugin_version',
  });

export interface PluginApproveArgs extends Record<string, unknown> {
  plugin_version_id: string;
  decision: 'approved' | 'rejected';
  reason?: string | null;
}
export const plugin_approve_v1 = (args: PluginApproveArgs) =>
  integrationPluginMutation('plugin_approve_v1', args, {
    approvalAction: args.decision,
    fallbackResourceKey: 'integration_plugin_version',
  });

export interface PluginActivateArgs extends Record<string, unknown> {
  plugin_version_id: string;
  scope_type?: string | null;
  scope_id?: string | null;
  reason?: string | null;
}
export const plugin_activate_v1 = (args: PluginActivateArgs) =>
  integrationPluginMutation('plugin_activate_v1', args, {
    requireBinding: true,
    fallbackResourceKey: 'integration_plugin_version',
  });

export interface PluginSetBindingArgs extends Record<string, unknown> {
  plugin_version_id: string;
  enabled: boolean;
  scope_type?: string | null;
  scope_id?: string | null;
}
export const plugin_set_binding_v1 = (args: PluginSetBindingArgs) =>
  integrationPluginMutation('plugin_set_binding_v1', args, {
    requireBinding: true,
    fallbackResourceKey: 'integration_plugin_version',
  });

// INTEGRATIONS — webhook_inbox replay + force-status
//
// Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #1/#2): canonical Phase B6 RPC contract
// keys are `webhook_inbox_id` + `target_status` (migrations 202604280219 /
// 202604280220). FE-flavored aliases `inbox_id` / `status` are translated at
// the api.ts facade boundary; this layer accepts canonical keys post-adapter.
export interface WebhookInboxReplayArgs extends Record<string, unknown> {
  inbox_id?: string;
  webhook_inbox_id?: string;
  reason?: string | null;
}
function resolveWebhookInboxId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.webhook_inbox_id)
    ?? asNonEmptyString(rec.inbox_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.webhook_inbox_id)
    ?? asNonEmptyString(args.inbox_id);
}

async function webhookInboxMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'webhook_inbox');
  if (liveRpcTarget()) {
    const inboxId = resolveWebhookInboxId(result, args);
    if (!inboxId) throw new Error(`${rpcName} did not return webhook_inbox_id`);
    await requireLiveResourceReadback('webhook_inbox', inboxId, rpcName);
    await requireLiveResourceReadback('webhook_inbox_directory', inboxId, rpcName);
  }
  return result;
}

export const webhook_inbox_replay_v1 = (args: WebhookInboxReplayArgs) =>
  webhookInboxMutation('webhook_inbox_replay_v1', args);
export interface WebhookInboxRetryAsNewIntakeArgs extends Record<string, unknown> {
  webhook_inbox_id: string;
  reason?: string | null;
}
export const ui_retry_webhook_inbox_as_new_intake_v1 = async (
  args: WebhookInboxRetryAsNewIntakeArgs,
) => {
  const result = await phaseC6Rpc('ui_retry_webhook_inbox_as_new_intake_v1', args, 'webhook_inbox');
  if (liveRpcTarget()) {
    const originalInboxId = asNonEmptyString(result.webhook_inbox_id) ?? asNonEmptyString(args.webhook_inbox_id);
    if (!originalInboxId) throw new Error('ui_retry_webhook_inbox_as_new_intake_v1 did not return webhook_inbox_id');
    await requireLiveResourceReadback('webhook_inbox', originalInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
    await requireLiveResourceReadback('webhook_inbox_directory', originalInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
    const newInboxId = asNonEmptyString(result.new_webhook_inbox_id);
    if (newInboxId) {
      await requireLiveResourceReadback('webhook_inbox', newInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
      await requireLiveResourceReadback('webhook_inbox_directory', newInboxId, 'ui_retry_webhook_inbox_as_new_intake_v1');
    }
  }
  return result;
};
export interface WebhookInboxForceStatusArgs extends Record<string, unknown> {
  inbox_id?: string;
  webhook_inbox_id?: string;
  status?: string;
  target_status?: string;
  reason?: string | null;
}
export const webhook_inbox_force_status_v1 = (args: WebhookInboxForceStatusArgs) =>
  webhookInboxMutation('webhook_inbox_force_status_v1', args);

// WORKFLOWS — templates lifecycle (Create/Activate/Deactivate)
export interface CreateWorkflowTemplateArgs extends Record<string, unknown> {
  name: string;
  description?: string | null;
  clone_from?: string | null;
  trigger?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
}
export const ui_create_workflow_template_v1 = (args: CreateWorkflowTemplateArgs) =>
  phaseC6Rpc('ui_create_workflow_template_v1', args, 'workflow_template');
export interface SetWorkflowTemplateStatusArgs extends Record<string, unknown> {
  template_id: string;
  status: 'draft' | 'active' | 'inactive' | 'retired';
}
export const ui_set_workflow_template_status_v1 = (args: SetWorkflowTemplateStatusArgs) =>
  phaseC6Rpc('ui_set_workflow_template_status_v1', args, 'workflow_template');

// WORKFLOWS — template step lifecycle
export interface WorkflowTemplateVersionDiffArgs extends Record<string, unknown> {
  workflow_template_id: string;
  source_workflow_template_id?: string | null;
  source_template_id?: string | null;
}
export interface WorkflowTemplateVersionDiffResult extends Record<string, unknown> {
  ok: true;
  workflow_template_id: string;
  source_workflow_template_id: string;
  current_version?: string;
  source_version?: string;
  current_step_count?: number;
  source_step_count?: number;
  added_steps?: Array<Record<string, unknown>>;
  removed_steps?: Array<Record<string, unknown>>;
  modified_steps?: Array<Record<string, unknown>>;
  unchanged_steps?: Array<Record<string, unknown>>;
}
export const workflow_template_version_diff_v1 = (
  args: WorkflowTemplateVersionDiffArgs,
): Promise<WorkflowTemplateVersionDiffResult> =>
  phaseC6Rpc(
    'workflow_template_version_diff_v1',
    args,
    'workflow_template',
  ) as Promise<WorkflowTemplateVersionDiffResult>;

export interface RestoreWorkflowTemplateArgs extends Record<string, unknown> {
  workflow_template_id: string;
  source_workflow_template_id?: string | null;
  source_template_id?: string | null;
  reason?: string | null;
}
export interface RestoreWorkflowTemplateResult extends Record<string, unknown> {
  ok: true;
  workflow_template_id: string;
  source_workflow_template_id: string;
  prior_version?: string;
  restored_version?: string;
  current_version?: string;
  source_version?: string;
  restored_step_count?: number;
  steps_checksum?: string | null;
  correlation_id?: string | null;
  settings_resolution_id?: string | null;
}
function numberReadback(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
export const restore_workflow_template_v1 = async (
  args: RestoreWorkflowTemplateArgs,
): Promise<RestoreWorkflowTemplateResult> => {
  const result = await phaseC6Rpc(
    'restore_workflow_template_v1',
    args,
    'workflow_template',
  ) as RestoreWorkflowTemplateResult;
  if (liveRpcTarget()) {
    const templateId =
      asNonEmptyString(result.workflow_template_id)
      ?? asNonEmptyString(args.workflow_template_id);
    if (!templateId) throw new Error('restore_workflow_template_v1 did not return workflow_template_id');
    await requireLiveResourceReadback('workflow_templates', templateId, 'restore_workflow_template_v1');
    const directory = await requireLiveResourceReadback(
      'workflow_template_directory',
      templateId,
      'restore_workflow_template_v1',
    );
    const expectedCount = numberReadback(result.restored_step_count);
    const actualCount = numberReadback(directory.step_count);
    if (expectedCount != null && actualCount !== expectedCount) {
      throw new Error('restore_workflow_template_v1 backend readback step count mismatch');
    }
  }
  return result;
};

export interface WorkflowTemplateStepMutationResult extends Record<string, unknown> {
  ok: true;
  workflow_template_id: string;
  workflow_template_step_id: string;
  action: 'created' | 'updated' | 'duplicated' | 'deleted' | 'soft_deleted';
  correlation_id?: string;
  settings_resolution_id?: string;
}
export interface CreateWorkflowTemplateStepArgs extends Record<string, unknown> {
  workflow_template_id: string;
  step: Record<string, unknown>;
}
export interface UpdateWorkflowTemplateStepArgs extends Record<string, unknown> {
  workflow_template_step_id: string;
  workflow_template_id?: string;
  patch: Record<string, unknown>;
  reason?: string;
}
export interface DuplicateWorkflowTemplateStepArgs extends Record<string, unknown> {
  workflow_template_step_id: string;
  workflow_template_id?: string;
}
export interface DeleteWorkflowTemplateStepArgs extends Record<string, unknown> {
  workflow_template_step_id: string;
  workflow_template_id?: string;
  reason?: string;
}

function workflowTemplateStepResultId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.workflow_template_step_id)
    ?? asNonEmptyString(rec.step_id)
    ?? asNonEmptyString(args.workflow_template_step_id)
    ?? asNonEmptyString(args.step_id);
}

function workflowTemplateStepTemplateId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.workflow_template_id)
    ?? asNonEmptyString(rec.template_id)
    ?? asNonEmptyString(args.workflow_template_id)
    ?? asNonEmptyString(args.template_id);
}

function requireWorkflowTemplateStepReadback(
  row: Record<string, unknown>,
  expectedStepId: string,
  expectedTemplateId: string | null,
  rpcName: string,
): void {
  if (asNonEmptyString(row.id) !== expectedStepId) {
    throw new Error(`${rpcName} backend readback returned the wrong workflow_template_step`);
  }
  if (expectedTemplateId && asNonEmptyString(row.workflow_template_id) !== expectedTemplateId) {
    throw new Error(`${rpcName} backend readback returned a step outside the workflow template`);
  }
}

async function workflowTemplateStepMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<WorkflowTemplateStepMutationResult> {
  const result = await phaseC6Rpc(
    rpcName,
    args,
    'workflow_template_step',
  ) as WorkflowTemplateStepMutationResult;
  if (liveRpcTarget()) {
    const stepId = workflowTemplateStepResultId(result, args);
    const templateId = workflowTemplateStepTemplateId(result, args);
    if (!stepId) throw new Error(`${rpcName} did not return workflow_template_step_id`);
    if (!templateId) throw new Error(`${rpcName} did not return workflow_template_id`);

    await requireLiveResourceReadback('workflow_templates', templateId, rpcName);
    await requireLiveResourceReadback('workflow_template_directory', templateId, rpcName);

    if (result.deleted === true && result.soft_deleted !== true) {
      await requireLiveResourceAbsenceReadback(
        'workflow_template_steps',
        { id: stepId },
        rpcName,
        `workflow_template_steps:${stepId}`,
      );
    } else {
      const stepReadback = await requireLiveResourceReadback(
        'workflow_template_steps',
        stepId,
        rpcName,
      );
      requireWorkflowTemplateStepReadback(stepReadback, stepId, templateId, rpcName);
      if (result.soft_deleted === true && booleanReadback(stepReadback.enabled) !== false) {
        throw new Error(`${rpcName} backend readback did not reflect soft-deleted step state`);
      }
    }
  }
  return result;
}

export const ui_create_workflow_template_step_v1 = (
  args: CreateWorkflowTemplateStepArgs,
): Promise<WorkflowTemplateStepMutationResult> =>
  workflowTemplateStepMutation('ui_create_workflow_template_step_v1', args);
export const ui_update_workflow_template_step_v1 = (
  args: UpdateWorkflowTemplateStepArgs,
): Promise<WorkflowTemplateStepMutationResult> =>
  workflowTemplateStepMutation('ui_update_workflow_template_step_v1', args);
export const ui_duplicate_workflow_template_step_v1 = (
  args: DuplicateWorkflowTemplateStepArgs,
): Promise<WorkflowTemplateStepMutationResult> =>
  workflowTemplateStepMutation('ui_duplicate_workflow_template_step_v1', args);
export const ui_delete_workflow_template_step_v1 = (
  args: DeleteWorkflowTemplateStepArgs,
): Promise<WorkflowTemplateStepMutationResult> =>
  workflowTemplateStepMutation('ui_delete_workflow_template_step_v1', args);

// WORKFLOWS — bindings lifecycle (Register/Simulate)
//
// Wave 5 RE-AUDIT closure (W10-3): data-source argument shapes match the
// canonical Phase B6 RPC contracts so there is no contract drift even at
// the seam layer. Backend SSOT (verified):
//   - register_workflow_binding_v1   202604280221 (workflow_template_id)
//   - simulate_binding_dispatch_v1   202604280222 (binding_key + stage_key)
//   - bulk_transition_tasks_v1       202604280223 (to_status)
// The `api.ts` facade still translates FE-flavored aliases defensively
// (template_id -> workflow_template_id, next_status -> to_status) but call
// sites send canonical names.
export interface RegisterWorkflowBindingArgs extends Record<string, unknown> {
  binding_key?: string;
  stage_key?: string;
  scope_type?: string;
  scope_id?: string | null;
  event?: string;
  /** Canonical RPC arg (migration 202604280221:28). Replaces legacy
   *  `template_id`; the api facade adapter at `api.ts:1623-1632` still
   *  translates the legacy alias defensively for any straggling caller. */
  workflow_template_id?: string;
  condition?: Record<string, unknown> | null;
  inline_progress_steps?: number | null;
  priority?: number;
  enabled?: boolean;
  notes?: string | null;
}
export const register_workflow_binding_v1 = (args: RegisterWorkflowBindingArgs) =>
  phaseC6Rpc('register_workflow_binding_v1', args, 'workflow_binding_registration');
export interface SimulateBindingDispatchArgs extends Record<string, unknown> {
  /** Canonical RPC arg (migration 202604280222:26). Composed
   *  `${event}.${stage_key}` — NOT the FE row UUID. */
  binding_key?: string;
  /** Canonical RPC arg (migration 202604280222:27). Defaults to 'default'
   *  when the legacy seed row does not specify a stage. */
  stage_key?: string;
  scope_type?: string;
  scope_id?: string | null;
  inputs?: Record<string, unknown>;
  /** FE-only sample event metadata; unused by canonical RPC. Kept so the
   *  test condition row action can pass the row's event type for telemetry
   *  without mutating canonical args. */
  event?: string;
  payload?: Record<string, unknown>;
}
export const simulate_binding_dispatch_v1 = (args: SimulateBindingDispatchArgs) =>
  phaseC6Rpc('simulate_binding_dispatch_v1', args, 'workflow_binding_simulation');

// WORKFLOWS — review-queue bulk transition
export interface BulkTransitionTasksArgs extends Record<string, unknown> {
  task_ids: string[];
  /** Canonical RPC arg (migration 202604280223:26). Replaces legacy
   *  `next_status`; the api facade adapter at `api.ts:1636-1645` still
   *  translates the legacy alias defensively for any straggling caller. */
  to_status: string;
  reason?: string | null;
  payload?: Record<string, unknown>;
  action_kind?: string;
}
async function requireLiveBulkTaskTransitionReadback(
  result: Record<string, unknown>,
  args: BulkTransitionTasksArgs,
): Promise<void> {
  const expectedPayload = args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
    ? args.payload
    : null;
  const outcomes = Array.isArray(result.outcomes)
    ? result.outcomes.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : [];
  const taskIdsFromArgs = Array.isArray(args.task_ids)
    ? args.task_ids.map((id) => asNonEmptyString(id)).filter((id): id is string => !!id)
    : [];
  const successful = outcomes
    .filter((row) => row.ok !== false)
    .map((row) => ({
      taskId: asNonEmptyString(row.task_id) ?? asNonEmptyString(row.id),
      taskEventId: asNonEmptyString(row.task_event_id),
    }))
    .filter((row): row is { taskId: string; taskEventId: string | null } => !!row.taskId);

  const tasksToVerify = successful.length > 0
    ? successful
    : taskIdsFromArgs.map((taskId) => ({ taskId, taskEventId: null }));

  if (tasksToVerify.length === 0) {
    throw new Error('bulk_transition_tasks_v1 did not return backend task transition evidence');
  }

  await Promise.all(tasksToVerify.map(async ({ taskId, taskEventId }) => {
    await requireLiveResourceReadback('tasks', taskId, 'bulk_transition_tasks_v1');
    const taskEvents = taskEventId
      ? [await requireLiveResourceReadback('task_events', taskEventId, 'bulk_transition_tasks_v1')]
      : await requireLiveResourceListReadback('task_events', { task_id: taskId }, 'bulk_transition_tasks_v1');
    if (expectedPayload && Object.keys(expectedPayload).length > 0) {
      const event = taskEvents.find((row) => String(row.task_id ?? '') === taskId) ?? taskEvents[0];
      const eventPayload = event && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      for (const [key, value] of Object.entries(expectedPayload)) {
        if (JSON.stringify(eventPayload[key] ?? null) !== JSON.stringify(value ?? null)) {
          throw new Error(`bulk_transition_tasks_v1 backend task_event payload mismatch for ${taskId}:${key}`);
        }
      }
    }
  }));
}

export const bulk_transition_tasks_v1 = async (args: BulkTransitionTasksArgs) => {
  const result = await phaseC6Rpc('bulk_transition_tasks_v1', args);
  if (liveRpcTarget()) {
    await requireLiveBulkTaskTransitionReadback(result, args);
  }
  return result;
};

// ----------- Delivery slots -----------
// CLAIM-LIFECYCLE-LINK Gap 2: extend the synthetic adapter so each window
// carries a stable `window_id` (operators select on it; the chosen id flows
// back to `reserve_delivery_slot_v1`). When a `slot_date` is provided we
// scope the returned windows to that date, mirroring the canonical RPC
// contract; otherwise we return the full multi-day catalog so existing
// callers (which pass no args) keep working.
export interface DeliverySlotWindow {
  window_id: string;
  slot_date: string;
  window_start_local: string;
  window_end_local: string;
  remaining: number | null;
}

export const DELIVERY_SLOT_CATALOG: DeliverySlotWindow[] = [
  { window_id: 'win_2026_04_26_am', slot_date: '2026-04-26', window_start_local: '10:00', window_end_local: '12:00', remaining: 12 },
  { window_id: 'win_2026_04_26_mid', slot_date: '2026-04-26', window_start_local: '13:00', window_end_local: '15:00', remaining: 8 },
  { window_id: 'win_2026_04_26_pm', slot_date: '2026-04-26', window_start_local: '16:00', window_end_local: '18:00', remaining: 4 },
  { window_id: 'win_2026_04_27_am', slot_date: '2026-04-27', window_start_local: '10:00', window_end_local: '12:00', remaining: 14 },
  { window_id: 'win_2026_04_27_mid', slot_date: '2026-04-27', window_start_local: '13:00', window_end_local: '15:00', remaining: 9 },
  { window_id: 'win_2026_04_27_pm', slot_date: '2026-04-27', window_start_local: '16:00', window_end_local: '18:00', remaining: 6 },
  { window_id: 'win_2026_04_28_am', slot_date: '2026-04-28', window_start_local: '10:00', window_end_local: '12:00', remaining: 15 },
  { window_id: 'win_2026_04_28_mid', slot_date: '2026-04-28', window_start_local: '13:00', window_end_local: '15:00', remaining: 11 },
  { window_id: 'win_2026_04_28_pm', slot_date: '2026-04-28', window_start_local: '16:00', window_end_local: '18:00', remaining: 7 },
];

export async function list_delivery_slots_v1(
  args?: { shipment_id?: string; slot_date?: string } | unknown,
): Promise<DeliverySlotWindow[]> {
  const { list_delivery_slots_v1 } = await import('./data-source/shipments');
  return list_delivery_slots_v1(args);
}
export async function reserve_delivery_slot_v1({
  slot_date,
  shipment_id,
  window_id,
  ...rest
}: {
  slot_date: string;
  shipment_id?: string;
  window_id?: string;
  [key: string]: unknown;
}): Promise<{ ok: true; slot_date: string; shipment_id?: string; window_id?: string; reserved_at: string }> {
  const clientId = (rest.client_id as string | undefined) ?? await getLiveShipmentClientId(shipment_id);
  let windowStart = rest.window_start_local as string | undefined;
  let windowEnd = rest.window_end_local as string | undefined;
  if (window_id && shipment_id && clientId && (!windowStart || !windowEnd)) {
    const windows = await list_delivery_slots_v1({ shipment_id, client_id: clientId, slot_date });
    const selected = windows.find((window) => window.window_id === window_id);
    windowStart = selected?.window_start_local ?? windowStart;
    windowEnd = selected?.window_end_local ?? windowEnd;
  }
  const live = await liveRpc<Record<string, unknown>>('reserve_delivery_slot_v1', {
    p_input: {
      ...rest,
      shipment_id,
      client_id: clientId,
      slot_date,
      window_id,
      window_start_local: windowStart,
      window_end_local: windowEnd,
      performed_by_system: rest.performed_by_system ?? 'console-v2',
    },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'reserve_delivery_slot_v1', [
      'reservation_id',
      'slot_reservation_id',
      'reserved_at',
      'shipment_id',
      'action_id',
    ]);
    const reservedAt = asNonEmptyString(rec.reserved_at ?? rec.applied_at ?? rec.created_at) ?? '';
    return {
      ok: true,
      slot_date,
      shipment_id,
      window_id,
      reserved_at: reservedAt,
      ...rec,
    } as { ok: true; slot_date: string; shipment_id?: string; window_id?: string; reserved_at: string };
  }

  await sleep(80);
  return { ok: true, slot_date, shipment_id, window_id, reserved_at: new Date().toISOString() };
}

// ----------- COD / Settlements -----------
export async function compute_cod_payment_collection_summary_v1(scope?: unknown): Promise<{
  scope: unknown;
  expected: number;
  collected: number;
  remitted: number;
  variance: number;
}> {
  const { compute_cod_payment_collection_summary_v1 } = await import('./data-source/finance');
  return compute_cod_payment_collection_summary_v1(scope);
}

// ----------- Labels -----------
export type LabelDesignScopeType = 'tenant' | 'client' | 'sender';

export interface LabelDesignDraft extends Record<string, unknown> {
  id: string;
  organization_id: string | null;
  scope_type: LabelDesignScopeType;
  scope_id: string;
  label_type: string;
  draft_name: string | null;
  draft_value: Record<string, unknown>;
  status: 'draft' | 'published' | 'archived';
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  published_settings_version_id?: string | null;
  published_at?: string | null;
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
}

export interface LabelDesignerDraftListResult extends Record<string, unknown> {
  ok: boolean;
  drafts: LabelDesignDraft[];
}

export interface LabelDesignerDraftMutationResult extends Record<string, unknown> {
  ok: boolean;
  draft?: LabelDesignDraft;
  error?: Record<string, unknown>;
}

export interface LabelDesignerDraftValidationResult extends Record<string, unknown> {
  ok: boolean;
  errors: Array<Record<string, unknown>>;
  error?: Record<string, unknown>;
}

export interface LabelDesignerDraftPublishResult extends Record<string, unknown> {
  ok: boolean;
  settings_version_id?: string;
  scope_type?: string;
  scope_id?: string;
  schema_version?: number;
  version?: number;
  error?: Record<string, unknown>;
  validation_errors?: Array<Record<string, unknown>>;
}

export interface LabelDesignerAsset extends Record<string, unknown> {
  name: string;
  path: string;
}

export interface LabelDesignerAssetListResult extends Record<string, unknown> {
  ok: boolean;
  assets: LabelDesignerAsset[];
  error?: Record<string, unknown>;
}

export interface LabelDesignerAssetUploadArgs extends Record<string, unknown> {
  file_name: string;
  file_base64: string;
  content_type?: string | null;
}

export interface LabelDesignerAssetUploadResult extends Record<string, unknown> {
  ok: boolean;
  path?: string;
  error?: Record<string, unknown>;
}

export interface LabelDesignerFieldCatalogField extends Record<string, unknown> {
  key?: string;
  value_path?: string;
  label_en?: string;
  label_ar?: string;
  group?: string;
  data_type?: string;
  example?: unknown;
}

export interface LabelDesignerFieldCatalogValue extends Record<string, unknown> {
  version?: number;
  fields: LabelDesignerFieldCatalogField[];
}

export interface LabelDesignerFieldCatalogResult extends Record<string, unknown> {
  ok: boolean;
  value: LabelDesignerFieldCatalogValue;
  error?: Record<string, unknown>;
}

export interface LabelDesignerEffectiveConfigResult extends Record<string, unknown> {
  ok: boolean;
  value: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface LabelRendererReadinessResult extends Record<string, unknown> {
  ok: boolean;
  scope?: Record<string, unknown>;
  renderer_provider?: Record<string, unknown>;
  render_policy?: Record<string, unknown>;
  print_profile?: Record<string, unknown>;
  printer_certification?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface LabelPrinterCertificationArgs extends Record<string, unknown> {
  scope_type: LabelDesignScopeType;
  scope_id: string;
  evidence_reference: string;
  printer_model: string;
  printer_serial?: string | null;
  test_artifact_ref?: string | null;
  result?: 'passed' | 'failed' | 'conditional';
  change_reason?: string | null;
}

export interface LabelPrinterCertificationResult extends Record<string, unknown> {
  ok: boolean;
  scope_type?: string;
  scope_id?: string | null;
  settings_id?: string;
  settings_version_id?: string;
  settings_version_number?: number;
  certification?: Record<string, unknown>;
  readiness?: LabelRendererReadinessResult;
  error?: Record<string, unknown>;
}

export interface LabelDesignerSamplePayloadResult extends Record<string, unknown> {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface LabelDesignerPreviewArgs extends Record<string, unknown> {
  draft_id: string;
  label_type?: string | null;
  shipment_id: string;
  shipment_box_id?: string | null;
}

export interface LabelDesignerPreviewResult extends Record<string, unknown> {
  ok: boolean;
  pdf_base64?: string;
  renderer_metadata?: Record<string, unknown>;
  validation?: Record<string, unknown> | null;
  error?: Record<string, unknown>;
}

export const localLabelDesignDrafts: LabelDesignDraft[] = [];
export const localLabelDesignerAssets: LabelDesignerAsset[] = [];

export function assertLabelDesignScope(scopeType: string, scopeId: string): asserts scopeType is LabelDesignScopeType {
  if (!['tenant', 'client', 'sender'].includes(scopeType)) {
    throw new Error('label designer scope must be tenant, client, or sender');
  }
  if (!asNonEmptyString(scopeId)) {
    throw new Error('label designer scope_id is required');
  }
}

export async function label_designer_list_drafts(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerDraftListResult> {
  const { label_designer_list_drafts } = await import('./data-source/labels');
  return label_designer_list_drafts(scopeType, scopeId);
}

export async function label_designer_get_field_catalog(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerFieldCatalogResult> {
  const { label_designer_get_field_catalog } = await import('./data-source/labels');
  return label_designer_get_field_catalog(scopeType, scopeId);
}

async function labelDesignerEffectiveConfigRpc(
  rpcName: string,
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> {
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelDesignerEffectiveConfigResult>(rpcName, {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      `${rpcName} returned no backend effective config`,
    );
    const value = rec.value && typeof rec.value === 'object' && !Array.isArray(rec.value)
      ? rec.value as Record<string, unknown>
      : {};
    return { ...rec, ok: rec.ok !== false, value };
  }

  await sleep(30);
  return { ok: true, value: {} };
}

export const label_designer_get_effective_label_design = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_effective_label_design', scopeType, scopeId);

export const label_designer_get_effective_label_render_policy = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_effective_label_render_policy', scopeType, scopeId);

export const label_designer_get_effective_label_print_profile = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_effective_label_print_profile', scopeType, scopeId);

export const label_designer_get_label_media_catalog = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_label_media_catalog', scopeType, scopeId);

export async function ui_label_renderer_readiness_v1(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelRendererReadinessResult> {
  const { ui_label_renderer_readiness_v1 } = await import('./data-source/labels');
  return ui_label_renderer_readiness_v1(scopeType, scopeId);
}

export async function ui_record_label_printer_certification_v1(
  args: LabelPrinterCertificationArgs,
): Promise<LabelPrinterCertificationResult> {
  const { ui_record_label_printer_certification_v1 } = await import('./data-source/labels');
  return ui_record_label_printer_certification_v1(args);
}

export async function label_designer_get_sample_payload(args: {
  shipment_id: string;
  shipment_box_id?: string | null;
}): Promise<LabelDesignerSamplePayloadResult> {
  const { label_designer_get_sample_payload } = await import('./data-source/labels');
  return label_designer_get_sample_payload(args);
}

export async function label_designer_create_draft(args: {
  scope_type: LabelDesignScopeType;
  scope_id: string;
  label_type?: string;
  draft_name?: string | null;
  draft_value: Record<string, unknown>;
}): Promise<LabelDesignerDraftMutationResult> {
  const { label_designer_create_draft } = await import('./data-source/labels');
  return label_designer_create_draft(args);
}

export async function label_designer_update_draft(args: {
  draft_id: string;
  label_type?: string | null;
  draft_name?: string | null;
  draft_value?: Record<string, unknown> | null;
}): Promise<LabelDesignerDraftMutationResult> {
  const { label_designer_update_draft } = await import('./data-source/labels');
  return label_designer_update_draft(args);
}

export async function label_designer_archive_draft(args: {
  draft_id: string;
  archive_reason?: string | null;
}): Promise<LabelDesignerDraftMutationResult> {
  const { label_designer_archive_draft } = await import('./data-source/labels');
  return label_designer_archive_draft(args);
}

export async function label_designer_validate_label_design_draft(
  draftId: string,
): Promise<LabelDesignerDraftValidationResult> {
  const { label_designer_validate_label_design_draft } = await import('./data-source/labels');
  return label_designer_validate_label_design_draft(draftId);
}

export async function label_designer_publish_label_design_draft(
  draftId: string,
  changeReason?: string | null,
  readbackScope?: { scopeType?: string | null; scopeId?: string | null },
): Promise<LabelDesignerDraftPublishResult> {
  const { label_designer_publish_label_design_draft } = await import('./data-source/labels');
  return label_designer_publish_label_design_draft(draftId, changeReason, readbackScope);
}

export async function label_designer_list_assets(): Promise<LabelDesignerAssetListResult> {
  const { label_designer_list_assets } = await import('./data-source/labels');
  return label_designer_list_assets();
}

export async function label_designer_upload_asset(
  args: LabelDesignerAssetUploadArgs,
): Promise<LabelDesignerAssetUploadResult> {
  const { label_designer_upload_asset } = await import('./data-source/labels');
  return label_designer_upload_asset(args);
}

export async function label_designer_delete_asset(
  path: string,
): Promise<{ ok: boolean; path?: string; error?: Record<string, unknown> }> {
  const { label_designer_delete_asset } = await import('./data-source/labels');
  return label_designer_delete_asset(path);
}

export async function label_designer_preview_label_design_draft(
  args: LabelDesignerPreviewArgs,
): Promise<LabelDesignerPreviewResult> {
  const { label_designer_preview_label_design_draft } = await import('./data-source/labels');
  return label_designer_preview_label_design_draft(args);
}

export async function request_label_reprint(
  labelId: string,
  { reason }: { reason: string },
): Promise<{
  ok: true;
  label_id: string;
  reason: string;
  label_job_id?: string | null;
  new_version_id?: string | null;
}> {
  const adapter = await import('./data-source/labels');
  return adapter.request_label_reprint(labelId, { reason });
}

export interface TargetLabelRequestArgs extends Record<string, unknown> {
  organization_id?: string | null;
  target_type: string;
  target_id: string;
  target_box_id?: string | null;
  label_type?: string | null;
  requested_source?: string | null;
  job_purpose?: string | null;
}

export interface TargetLabelRequestResult extends Record<string, unknown> {
  ok: true;
  label_job_id: string;
  target_type: string;
  target_id: string;
  target_box_id?: string | null;
  label_type?: string | null;
  status?: string | null;
  job?: Record<string, unknown> | null;
}

export async function ui_request_label_generation_target_v1(
  args: TargetLabelRequestArgs,
): Promise<TargetLabelRequestResult> {
  const targetId = asNonEmptyString(args.target_id);
  const targetType = asNonEmptyString(args.target_type);
  if (!targetType) throw new Error('Target label type is required');
  if (!targetId) throw new Error('Target label id is required');

  const client = getSupabaseClient();
  if (client) {
    const result = await phaseC6Rpc('ui_request_label_generation_target_v1', {
      ...args,
      target_type: targetType,
      target_id: targetId,
      requested_source: asNonEmptyString(args.requested_source) ?? 'console-v2',
    }, 'label_job');
    const labelJobId =
      asNonEmptyString(result.label_job_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString((result.job as Record<string, unknown> | undefined)?.id);
    if (!labelJobId) throw new Error('Target label request did not return a label job id');

    const job = await requireLiveResourceReadback('label_jobs', labelJobId, 'ui_request_label_generation_target_v1');
    const readbackTargetId = asNonEmptyString(job.target_id);
    const readbackTargetType = asNonEmptyString(job.target_type);
    if (readbackTargetId !== targetId) {
      throw new Error(`Target label job readback belongs to ${readbackTargetId ?? 'unknown'}, expected ${targetId}`);
    }
    if (!readbackTargetType) {
      throw new Error('Target label job readback missing target_type');
    }

    return {
      ok: true,
      label_job_id: labelJobId,
      target_type: readbackTargetType,
      target_id: readbackTargetId,
      target_box_id: asNonEmptyString(job.target_box_id),
      label_type: asNonEmptyString(job.label_type),
      status: asNonEmptyString(job.status),
      job,
      ...result,
    } as TargetLabelRequestResult;
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('ui_request_label_generation_target_v1');
  await sleep(80);
  return {
    ok: true,
    label_job_id: 'ljob_target_' + Date.now(),
    target_type: targetType,
    target_id: targetId,
    target_box_id: asNonEmptyString(args.target_box_id),
    label_type: asNonEmptyString(args.label_type) ?? null,
    status: 'pending',
    job: null,
  };
}

export interface CompleteLabelJobResult extends Record<string, unknown> {
  ok: true;
  label_job_id: string;
  status: 'completed';
  correlation_id: string;
  settings_resolution_id?: string;
}

export async function complete_label_job(
  jobId: string,
  payload: unknown,
): Promise<CompleteLabelJobResult> {
  const args = { label_job_id: jobId, ...(payload as Record<string, unknown> | undefined) };
  const client = getSupabaseClient();
  if (client) {
    const { requireLiveCompleteLabelJobReadback } = await import('./data-source/labels');
    const result = await phaseC6Rpc('complete_label_job', args, 'label_jobs');
    await requireLiveCompleteLabelJobReadback(jobId, result);
    return result as CompleteLabelJobResult;
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('complete_label_job');
  await sleep(80);
  return {
    ok: true,
    label_job_id: jobId,
    status: 'completed',
    correlation_id: 'corr_' + Date.now(),
  };
}

// W54-F — typed adapter for the canonical ui_log_event_v1 telemetry seam.
// Live mode routes through `client.rpc('ui_log_event_v1', { p_event, p_app })`
// when the Supabase client is wired; in-memory mode no-ops with the canonical
// echo shape so spy assertions remain stable across both branches.
export interface UiLogEventResult extends Record<string, unknown> {
  ok: true;
  app: string;
  logged_at: string;
  event_id?: string | null;
  readback?: Record<string, unknown> | null;
}
export interface UiLogEventOptions {
  requireReadback?: boolean;
}
export async function ui_log_event_v1(
  eventJson: unknown,
  app: string = 'console',
  options: UiLogEventOptions = {},
): Promise<UiLogEventResult> {
  const { ui_log_event_v1 } = await import('./data-source/workflows');
  return ui_log_event_v1(eventJson, app, options);
}

export interface WorkflowScheduleRunNowResult extends Record<string, unknown> {
  ok: true;
  status: string;
  workflow_schedule_trigger_id: string;
  workflow_template_id: string | null;
  workflow_run_id: string | null;
  last_run_at?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
}

export interface WorkflowScheduleCreateResult extends Record<string, unknown> {
  ok: true;
  status: string;
  workflow_schedule_trigger_id: string;
  workflow_template_id: string | null;
  schedule: Record<string, unknown>;
  context_patch: Record<string, unknown>;
  scope_type: string | null;
  scope_id: string | null;
  enabled: boolean;
  next_run_at: string | null;
  notes?: string | null;
}

export interface WorkflowRunTriggerCreateResult extends Record<string, unknown> {
  ok: true;
  status: string;
  workflow_run_trigger_id: string;
  source_workflow_template_id: string | null;
  target_workflow_template_id: string | null;
  source_statuses: string[];
  context_patch: Record<string, unknown>;
  scope_type: string | null;
  scope_id: string | null;
  enabled: boolean;
  notes?: string | null;
}

export interface WorkflowRunTriggerUpdateResult extends WorkflowRunTriggerCreateResult {
  status: 'updated' | string;
  updated_at?: string | null;
}

export interface WorkflowRunTriggerDeleteResult extends Record<string, unknown> {
  ok: true;
  status: 'deleted' | string;
  workflow_run_trigger_id: string;
  source_workflow_template_id: string | null;
  target_workflow_template_id: string | null;
  scope_type: string | null;
  scope_id: string | null;
  enabled: boolean;
  deleted_at?: string | null;
  workflow_trigger_fires_count: number;
}

export interface WorkflowScheduleTaskPayloadRepairResult extends Record<string, unknown> {
  ok: true;
  status: string;
  workflow_schedule_trigger_id: string;
  workflow_template_id: string | null;
  workflow_template_step_id: string | null;
  operation_name: string | null;
  task_type_key: string | null;
  queue_key: string | null;
  priority: number | null;
  sla_minutes: number | null;
  resource_type: string | null;
  resource_id: string | null;
  updated_at: string | null;
  context_patch?: Record<string, unknown> | null;
}

export async function ui_create_workflow_schedule_trigger_v1(args: {
  workflow_template_id: string;
  schedule: Record<string, unknown>;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
}): Promise<WorkflowScheduleCreateResult> {
  const { ui_create_workflow_schedule_trigger_v1 } = await import('./data-source/workflows');
  return ui_create_workflow_schedule_trigger_v1(args);
}

export async function ui_create_workflow_run_trigger_v1(args: {
  source_workflow_template_id: string;
  target_workflow_template_id: string;
  source_statuses?: string[] | null;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
  scope_id?: string | null;
}): Promise<WorkflowRunTriggerCreateResult> {
  const { ui_create_workflow_run_trigger_v1 } = await import('./data-source/workflows');
  return ui_create_workflow_run_trigger_v1(args);
}

export async function ui_update_workflow_run_trigger_v1(args: {
  workflow_run_trigger_id: string;
  source_workflow_template_id?: string | null;
  target_workflow_template_id?: string | null;
  source_statuses?: string[] | null;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
  scope_id?: string | null;
}): Promise<WorkflowRunTriggerUpdateResult> {
  const { ui_update_workflow_run_trigger_v1 } = await import('./data-source/workflows');
  return ui_update_workflow_run_trigger_v1(args);
}

export async function ui_delete_workflow_run_trigger_v1(
  workflowRunTriggerId: string,
  scopeIdArg?: string | null,
): Promise<WorkflowRunTriggerDeleteResult> {
  const { ui_delete_workflow_run_trigger_v1 } = await import('./data-source/workflows');
  return ui_delete_workflow_run_trigger_v1(workflowRunTriggerId, scopeIdArg);
}

export async function ui_run_workflow_schedule_trigger_v1(
  workflowScheduleTriggerId: string,
): Promise<WorkflowScheduleRunNowResult> {
  const { ui_run_workflow_schedule_trigger_v1 } = await import('./data-source/workflows');
  return ui_run_workflow_schedule_trigger_v1(workflowScheduleTriggerId);
}

export async function ui_repair_workflow_schedule_task_payload_v1(
  workflowScheduleTriggerId: string,
  taskPayload: Record<string, unknown> = {},
): Promise<WorkflowScheduleTaskPayloadRepairResult> {
  const { ui_repair_workflow_schedule_task_payload_v1 } = await import('./data-source/workflows');
  return ui_repair_workflow_schedule_task_payload_v1(workflowScheduleTriggerId, taskPayload);
}

// ----------- Mobile -----------
export interface UserDeviceRevokeResult extends Record<string, unknown> {
  ok: true;
  status: string;
  device_id: string;
  revoked_at: string;
  action_key: string;
  resource_key: string;
  count: number;
  items?: Array<Record<string, unknown>>;
}

export async function ui_execute_user_device_revoke_v1(
  deviceId: string,
  revokedReason: string,
): Promise<UserDeviceRevokeResult> {
  const { ui_execute_user_device_revoke_v1 } = await import('./data-source/platform');
  return ui_execute_user_device_revoke_v1(deviceId, revokedReason);
}

// ----------- Identity / sessions (Phase E2) -----------
//
// Canonical write seam mirrors `public.revoke_session_v1(p_args jsonb)` per
// supabase/migrations/202604280212_revoke_session_v1.sql. The RPC writes a
// revocation INTENT row to `public.revocation_audit` (status='pending') and
// emits `domain_events.session.revocation_requested`; the actual
// auth.sessions termination is performed by an out-of-band edge worker
// calling Supabase Admin API `auth.admin.signOut(user_id)`.
//
// Behavior:
//   • Live (Supabase client present): routes through phaseC6Rpc which calls
//     `client.rpc('revoke_session_v1', { p_args: args })`.
//   • In-memory: synthesizes the canonical envelope (revocation_audit_id,
//     correlation_id, status='pending') so the FE wiring is environment-only.
//
// In-memory mode also mutates the local `user_sessions` seed with pending
// revocation evidence. This mirrors live backend readback and keeps the
// visible row in place until the out-of-band termination worker completes.
export interface DataSourceRevokeSessionArgs extends Record<string, unknown> {
  target_user_id: string;
  session_id?: string | null;
  reason: string;
}
export async function revoke_session_v1(
  args: DataSourceRevokeSessionArgs,
): Promise<Record<string, unknown>> {
  const reason = asNonEmptyString(args.reason);
  if (!reason) throw new Error('revoke_session_v1 requires reason');
  const rpcArgs = { ...args, reason };
  const { requireLiveUserSecurityActionReadback } = await import('./data-source/platform');
  const result = await phaseC6Rpc('revoke_session_v1', rpcArgs, 'revocation_audit');
  if (liveRpcTarget()) {
    await requireLiveUserSessionRevocationReadback(
      'revoke_session_v1',
      rpcArgs.target_user_id,
      rpcArgs.session_id,
      result,
      reason,
    );
    await requireLiveUserSecurityActionReadback(
      'revoke_session_v1',
      rpcArgs.target_user_id,
      'revoke_session_v1',
      result,
      reason,
    );
  }
  // Live mode owns mutation server-side. In-memory mode marks the local seed
  // with the same pending revocation evidence returned by the backend-backed
  // session readback RPC; auth session termination is out-of-band.
  const client = getSupabaseClient();
  if (!client) {
    const targetUserId = rpcArgs.target_user_id;
    const sessionId = rpcArgs.session_id;
    const sessions = (seed as { user_sessions?: Array<Record<string, unknown>> })
      .user_sessions;
    if (Array.isArray(sessions)) {
      const now = new Date().toISOString();
      sessions.forEach((row) => {
        if (row.user_id !== targetUserId) return;
        if (sessionId != null && row.id !== sessionId) return;
        row.revocation_status = 'pending';
        row.revocation_reason = reason;
        row.revocation_requested_at = now;
      });
    }
  }
  return {
    ok: true,
    target_user_id: rpcArgs.target_user_id,
    status: 'pending',
    ...result,
  };
}

export interface UserSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  organization_id?: string | null;
  user_email?: string | null;
  user_agent?: string | null;
  ip?: string | null;
  aal?: string | null;
  factor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  not_after?: string | null;
  is_current?: boolean | null;
  revocation_audit_id?: string | null;
  revocation_status?: string | null;
  revocation_reason?: string | null;
  revocation_requested_at?: string | null;
  revocation_processed_at?: string | null;
  revocation_correlation_id?: string | null;
}

export async function ui_list_user_sessions_v1(
  targetUserId?: string | null,
  limit = 50,
): Promise<ListResult<UserSessionRow>> {
  const { ui_list_user_sessions_v1 } = await import('./data-source/platform');
  return ui_list_user_sessions_v1(targetUserId, limit);
}

// ----------- Identity / user lifecycle (W37) -----------
//
// Canonical write seam for the 5 user-lifecycle RPCs. REAUDIT4 IDENTITY found
// that the FE hooks in `lib/queries.ts` were still routing through the
// synthetic `runCommand` substrate even though the canonical `_v1` RPCs DO
// exist as of:
//   • supabase/migrations/202604300300_grant_user_role_v1.sql
//   • supabase/migrations/202604300310_revoke_user_role_v1.sql
//   • supabase/migrations/202604300320_suspend_user_v1.sql
//   • supabase/migrations/202604300330_reactivate_user_v1.sql
//   • supabase/migrations/202604300340_force_password_reset_v1.sql
//
// Each RPC reads `p_args->>'target_user_id'` (UUID) plus per-RPC fields
// (`role_key`, `reason`, `email`). All 5 emit a domain_event + decision_log row
// + return a canonical envelope (`ok`, `target_user_id`, ...).
//
// Behavior:
//   • Live (Supabase client present): phaseC6Rpc dispatches `client.rpc('<name>',
//     { p_args: args })`.
//   • In-memory: synthesize a canonical envelope so the FE wiring is
//     environment-only. The local `users` seed status mutation for suspend /
//     reactivate keeps optimistic refresh consistent — same pattern as
//     revoke_session_v1's user_sessions prune above.
export interface DataSourceGrantUserRoleArgs extends Record<string, unknown> {
  target_user_id: string;
  role_key: string;
  reason?: string;
  organization_id?: string;
}
export async function grant_user_role_v1(
  args: DataSourceGrantUserRoleArgs,
): Promise<Record<string, unknown>> {
  const { requireLiveUserRoleAssignmentReadback, requireLiveUserSecurityActionReadback } = await import('./data-source/platform');
  const result = await phaseC6Rpc('grant_user_role_v1', args, 'user_role_assignment');
  const { directory } = await requireLiveUserLifecycleReadback('grant_user_role_v1', args.target_user_id);
  const assignmentId =
    asNonEmptyString(result.rbac_user_role_assignment_id) ??
    asNonEmptyString(result.user_role_assignment_id) ??
    asNonEmptyString(result.assignment_id);
  await requireLiveUserRoleAssignmentReadback(
    'grant_user_role_v1',
    args.target_user_id,
    args.role_key,
    assignmentId,
    directory,
    'active',
  );
  if (liveRpcTarget()) {
    await requireLiveUserSecurityActionReadback(
      'grant_user_role_v1',
      args.target_user_id,
      'grant_user_role_v1',
      result,
      args.reason,
      { roleKey: args.role_key, assignmentId },
    );
  }
  return { ok: true, target_user_id: args.target_user_id, role_key: args.role_key, ...result };
}

export interface DataSourceRevokeUserRoleArgs extends Record<string, unknown> {
  target_user_id: string;
  role_key: string;
  reason?: string;
  organization_id?: string;
}
export async function revoke_user_role_v1(
  args: DataSourceRevokeUserRoleArgs,
): Promise<Record<string, unknown>> {
  const { requireLiveUserRoleAssignmentReadback, requireLiveUserSecurityActionReadback } = await import('./data-source/platform');
  const result = await phaseC6Rpc('revoke_user_role_v1', args, 'user_role_assignment');
  const { directory } = await requireLiveUserLifecycleReadback('revoke_user_role_v1', args.target_user_id);
  const assignmentId =
    asNonEmptyString(result.rbac_user_role_assignment_id) ??
    asNonEmptyString(result.user_role_assignment_id) ??
    asNonEmptyString(result.assignment_id);
  await requireLiveUserRoleAssignmentReadback(
    'revoke_user_role_v1',
    args.target_user_id,
    args.role_key,
    assignmentId,
    directory,
    'revoked',
  );
  if (liveRpcTarget()) {
    await requireLiveUserSecurityActionReadback(
      'revoke_user_role_v1',
      args.target_user_id,
      'revoke_user_role_v1',
      result,
      args.reason,
      { roleKey: args.role_key, assignmentId },
    );
  }
  return { ok: true, target_user_id: args.target_user_id, role_key: args.role_key, ...result };
}

export interface DataSourceSuspendUserArgs extends Record<string, unknown> {
  target_user_id?: string;
  user_id?: string;
  reason?: string;
}
export async function suspend_user_v1(
  args: DataSourceSuspendUserArgs,
): Promise<Record<string, unknown>> {
  const targetUserId = asNonEmptyString(args.target_user_id) ?? asNonEmptyString(args.user_id);
  if (!targetUserId) throw new Error('suspend_user_v1 requires target_user_id');
  const rpcArgs = { ...args, target_user_id: targetUserId };
  const { requireLiveUserSecurityActionReadback } = await import('./data-source/platform');
  const result = await phaseC6Rpc('suspend_user_v1', rpcArgs, 'user');
  const readback = await requireLiveUserLifecycleReadback('suspend_user_v1', targetUserId);
  if (liveRpcTarget()) {
    await requireLiveUserSecurityActionReadback(
      'suspend_user_v1',
      targetUserId,
      'suspend_user_v1',
      result,
      rpcArgs.reason,
    );
  }
  // In-memory mode: mirror canonical `users.status='suspended'` so the optimistic
  // refresh + AppGuard suspended-branch check stays consistent without round-trip.
  const client = getSupabaseClient();
  if (!client) {
    const users = (seed as { users?: Array<Record<string, unknown>> }).users;
    if (Array.isArray(users)) {
      const target = users.find((u) => u.id === targetUserId);
      if (target) target.status = 'suspended';
    }
  }
  if (readback.user) {
    return {
      ok: true,
      target_user_id: targetUserId,
      ...result,
      status: readback.user.status ?? result.status,
    };
  }
  return { ok: true, target_user_id: targetUserId, status: 'suspended', ...result };
}

export interface DataSourceReactivateUserArgs extends Record<string, unknown> {
  target_user_id?: string;
  user_id?: string;
  reason?: string;
}
export async function reactivate_user_v1(
  args: DataSourceReactivateUserArgs,
): Promise<Record<string, unknown>> {
  const targetUserId = asNonEmptyString(args.target_user_id) ?? asNonEmptyString(args.user_id);
  if (!targetUserId) throw new Error('reactivate_user_v1 requires target_user_id');
  const rpcArgs = { ...args, target_user_id: targetUserId };
  const { requireLiveUserSecurityActionReadback } = await import('./data-source/platform');
  const result = await phaseC6Rpc('reactivate_user_v1', rpcArgs, 'user');
  const readback = await requireLiveUserLifecycleReadback('reactivate_user_v1', targetUserId);
  if (liveRpcTarget()) {
    await requireLiveUserSecurityActionReadback(
      'reactivate_user_v1',
      targetUserId,
      'reactivate_user_v1',
      result,
      rpcArgs.reason,
    );
  }
  const client = getSupabaseClient();
  if (!client) {
    const users = (seed as { users?: Array<Record<string, unknown>> }).users;
    if (Array.isArray(users)) {
      const target = users.find((u) => u.id === targetUserId);
      if (target) target.status = 'active';
    }
  }
  if (readback.user) {
    return {
      ok: true,
      target_user_id: targetUserId,
      ...result,
      status: readback.user.status ?? result.status,
    };
  }
  return { ok: true, target_user_id: targetUserId, status: 'active', ...result };
}

export interface DataSourceForcePasswordResetArgs extends Record<string, unknown> {
  target_user_id: string;
  email?: string;
  reason: string;
}
export async function force_password_reset_v1(
  args: DataSourceForcePasswordResetArgs,
): Promise<Record<string, unknown>> {
  const reason = asNonEmptyString(args.reason);
  if (!reason) throw new Error('force_password_reset_v1 requires reason');
  const rpcArgs = { ...args, reason };
  const { requireLiveUserSecurityActionReadback } = await import('./data-source/platform');
  const result = await phaseC6Rpc('force_password_reset_v1', rpcArgs, 'user');
  await requireLiveUserLifecycleReadback('force_password_reset_v1', rpcArgs.target_user_id);
  if (liveRpcTarget()) {
    await requireLiveUserSecurityActionReadback(
      'force_password_reset_v1',
      rpcArgs.target_user_id,
      'force_password_reset_v1',
      result,
      reason,
    );
  }
  return { ok: true, target_user_id: rpcArgs.target_user_id, ...result };
}

export interface UserSecurityActionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  timestamp?: string | null;
  decision_category?: string | null;
  decision_point?: string | null;
  decision_outcome?: string | null;
  decision_reason?: string | null;
  decision_inputs?: Record<string, unknown> | null;
  resource_type?: string | null;
  resource_id?: string | null;
  correlation_id?: string | null;
  settings_resolution_id?: string | null;
  performed_by_system?: string | null;
  password_reset_intent_id?: string | null;
  role_key?: string | null;
  session_id?: string | null;
  action_reason?: string | null;
  invite_email?: string | null;
  invite_email_sent?: string | null;
  send_invite_email_requested?: string | null;
  invite_redirect_to?: string | null;
  accepted_from_status?: string | null;
  accepted_to_status?: string | null;
}

export async function ui_list_user_security_actions_v1(
  targetUserId: string,
  limit = 10,
): Promise<ListResult<UserSecurityActionRow>> {
  const { ui_list_user_security_actions_v1 } = await import('./data-source/platform');
  return ui_list_user_security_actions_v1(targetUserId, limit);
}

// ----------- Plugin tester -----------
//
// Wave 9 W9-2 (CLAIM-INTEGRATIONS REVISION 36% — W7 audit P0 #3):
// Replaces the synthetic 6-step trace with the canonical
// `public.test_integration_plugin_v1(p_args jsonb)` RPC (capability
// `integration_plugins.test`). The RPC persists a row in
// `integration_plugin_validation_runs` (run_type='test') and returns a
// deterministic step trace derived from the plugin contract shape.
// Backend SSOT: supabase/migrations/202604301200_test_integration_plugin_v1.sql.
//
// In-memory branch keeps a deterministic trace shape so Webhook tester unit
// tests stay environment-agnostic (the live branch dispatches the real RPC
// through the Phase C6 substrate).
export interface RunPluginTestResult extends Record<string, unknown> {
  ok: true;
  plugin_id: string;
  plugin_version_id?: string;
  validation_run_id?: string;
  duration_ms: number;
  steps: Array<Record<string, unknown>>;
  correlation_id?: string;
  settings_resolution_id?: string;
}
export async function runPluginTest(
  pluginId: string,
  payload: unknown,
  pluginVersionId?: string | null,
): Promise<RunPluginTestResult> {
  const { runPluginTest } = await import('./data-source/external-intake');
  return runPluginTest(pluginId, payload, pluginVersionId);
}

async function readApiGatewayRequestTestReadback(
  filters: Array<Record<string, unknown>>,
): Promise<ResourceRow | null> {
  for (const filter of filters) {
    const rows = await readLiveResourceListReadback('api_gateway_requests', filter, 'api-gateway');
    const row = rows[0];
    if (row) return row;
  }
  return null;
}

async function readApiGatewayAuthRejectionReadback(
  args: {
    correlationId: string;
    method: string;
    path: string;
    startedAtMs: number;
    allowRecentFallback?: boolean;
  },
): Promise<ResourceRow | null> {
  const correlationRows = await readLiveResourceListReadback(
    'api_gateway_auth_rejections',
    { correlation_id: args.correlationId },
    'api-gateway',
  );
  const correlationRow = correlationRows.find((row) => apiGatewayReadbackOccurredAfter(row, args.startedAtMs));
  if (correlationRow) return correlationRow;

  if (!args.allowRecentFallback) return null;

  const invalidTokenRows = await readLiveResourceListReadback(
    'api_gateway_auth_rejections',
    { failure_code: 'invalid_token' },
    'api-gateway',
  );
  const normalizedMethod = args.method.toUpperCase();
  return invalidTokenRows.find((row) => {
    const rowMethod = asNonEmptyString(row.method)?.toUpperCase();
    const rowPath = asNonEmptyString(row.path);
    return (
      apiGatewayReadbackOccurredAfter(row, args.startedAtMs) &&
      (!rowMethod || rowMethod === normalizedMethod) &&
      (!rowPath || rowPath === args.path)
    );
  }) ?? null;
}

async function readWebhookReceiverAuthRejectionReadback(
  args: {
    correlationId: string;
    idempotencyKey: string;
    startedAtMs: number;
  },
): Promise<ResourceRow | null> {
  const filters: Array<Record<string, unknown>> = [
    { correlation_id: args.correlationId },
    args.correlationId !== args.idempotencyKey ? { correlation_id: args.idempotencyKey } : null,
    { request_id: args.idempotencyKey },
  ].filter(Boolean) as Array<Record<string, unknown>>;
  for (const filter of filters) {
    const rows = await readLiveResourceListReadback('webhook_auth_rejections', filter, 'webhook-receiver');
    const row = rows.find((candidate) => apiGatewayReadbackOccurredAfter(candidate, args.startedAtMs));
    if (row) return row;
  }
  return null;
}

async function readWebhookReceiverAuthRejectionUntil(
  args: {
    correlationId: string;
    idempotencyKey: string;
    startedAtMs: number;
  },
): Promise<ResourceRow | null> {
  const deadline = performance.now() + WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS;
  while (performance.now() <= deadline) {
    try {
      const row = await readWebhookReceiverAuthRejectionReadback(args);
      if (row) return row;
    } catch {
      // Older deployments may not expose webhook_auth_rejections yet. Keep the
      // canonical inbox readback path authoritative for non-auth failures.
      return null;
    }
    if (performance.now() >= deadline) break;
    await sleep(WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS);
  }
  return null;
}

function apiGatewayDirectFetchConfig(): { baseUrl: string; anonKey: string } | null {
  if (import.meta.env.MODE === 'test' && import.meta.env.VITE_API_GATEWAY_DIRECT_FETCH_TEST !== '1') {
    return null;
  }
  const baseUrl = asNonEmptyString(import.meta.env.VITE_SUPABASE_URL)?.replace(/\/+$/, '');
  const anonKey = asNonEmptyString(import.meta.env.VITE_SUPABASE_ANON_KEY);
  if (!baseUrl || !anonKey || typeof fetch !== 'function') return null;
  return { baseUrl, anonKey };
}

function webhookReceiverDirectFetchConfig(): { baseUrl: string; anonKey: string } | null {
  if (import.meta.env.MODE === 'test' && import.meta.env.VITE_WEBHOOK_RECEIVER_DIRECT_FETCH_TEST !== '1') {
    return null;
  }
  const baseUrl = asNonEmptyString(import.meta.env.VITE_SUPABASE_URL)?.replace(/\/+$/, '');
  const anonKey = asNonEmptyString(import.meta.env.VITE_SUPABASE_ANON_KEY);
  if (!baseUrl || !anonKey || typeof fetch !== 'function') return null;
  return { baseUrl, anonKey };
}

async function invokeApiGatewayEdge(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  invokeName: string,
  args: {
    method: ApiGatewayInvokeMethod;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  },
): Promise<{ data: Record<string, unknown>; error: { message?: string } | null }> {
  const directConfig = apiGatewayDirectFetchConfig();
  if (!directConfig) {
    const { data, error } = await withApiGatewayInvokeTimeout(
      client.functions.invoke<Record<string, unknown>>(invokeName, {
        method: args.method,
        body: args.method === 'GET' ? undefined : args.payload,
        headers: args.headers,
      }),
    );
    return { data: objectRecord(data), error };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_GATEWAY_EDGE_INVOKE_TIMEOUT_MS);
  try {
    const response = await fetch(`${directConfig.baseUrl}/functions/v1/${invokeName}`, {
      method: args.method,
      headers: {
        ...args.headers,
        apikey: directConfig.anonKey,
        authorization: `Bearer ${directConfig.anonKey}`,
        'content-type': 'application/json',
        'x-client-info': 'console-v2',
      },
      body: args.method === 'GET' ? undefined : JSON.stringify(args.payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        data = objectRecord(JSON.parse(text));
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const message =
        findNestedString(data, ['message', 'error', 'code', 'failure_code']) ??
        `api-gateway failed with HTTP ${response.status}`;
      return {
        data: {
          ...data,
          status: response.status,
          status_code: response.status,
        },
        error: { message },
      };
    }
    return { data, error: null };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function invokeWebhookReceiverEdge(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  args: {
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  },
): Promise<{ data: Record<string, unknown> | null; error: { message?: string } | null }> {
  const directConfig = webhookReceiverDirectFetchConfig();
  if (!directConfig) {
    const { data, error } = await client.functions.invoke<Record<string, unknown>>('webhook-receiver', {
      body: args.payload,
      headers: args.headers,
    });
    return { data: objectRecord(data), error };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS);
  try {
    const response = await fetch(`${directConfig.baseUrl}/functions/v1/webhook-receiver`, {
      method: 'POST',
      headers: {
        ...args.headers,
        apikey: directConfig.anonKey,
        authorization: `Bearer ${directConfig.anonKey}`,
        'content-type': 'application/json',
        'x-client-info': 'console-v2',
      },
      body: JSON.stringify(args.payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        data = objectRecord(JSON.parse(text));
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const message =
        findNestedString(data, ['response_reason', 'ack_reason', 'reason', 'message', 'error', 'code', 'failure_code']) ??
        `webhook-receiver failed with HTTP ${response.status}`;
      return {
        data: {
          ...data,
          status: response.status,
          status_code: response.status,
          http_status: response.status,
        },
        error: { message },
      };
    }
    return { data, error: null };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { data: null, error: null };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForApiGatewayInvokeOrAuthRejection(
  invokePromise: Promise<{ data: Record<string, unknown>; error: { message?: string } | null }>,
  args: {
    correlationId: string;
    method: ApiGatewayInvokeMethod;
    path: string;
    startedAtMs: number;
  },
): Promise<
  | { type: 'invoke'; result: { data: Record<string, unknown>; error: { message?: string } | null } }
  | { type: 'auth_rejection'; row: ResourceRow }
> {
  const wrapped = invokePromise.then(
    (result) => ({ status: 'fulfilled' as const, result }),
    (error) => ({ status: 'rejected' as const, error }),
  );
  const deadline = performance.now() + API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_TIMEOUT_MS;
  while (performance.now() <= deadline) {
    const settled = await Promise.race([
      wrapped,
      sleep(API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_INTERVAL_MS).then(() => null),
    ]);
    if (settled) {
      if (settled.status === 'fulfilled') {
        return { type: 'invoke', result: settled.result };
      }
      throw settled.error;
    }
    try {
      const authRejection = await readApiGatewayAuthRejectionReadback({
        correlationId: args.correlationId,
        method: args.method,
        path: args.path,
        startedAtMs: args.startedAtMs,
      });
      if (authRejection) return { type: 'auth_rejection', row: authRejection };
    } catch {
      // Some older API lanes may not expose the rejection projection yet. Keep
      // the main invoke/request readback path authoritative in that case.
    }
  }
  throw new Error(API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE);
}

export async function runApiGatewayRequestTest(
  args: RunApiGatewayRequestTestArgs,
): Promise<RunApiGatewayRequestTestResult> {
  const token = asNonEmptyString(args.auth_token);
  if (!token) throw new Error('API Gateway source token is required');
  const { path, query } = splitApiGatewayPath(args.path, args.query_string);
  const method = normalizeApiGatewayMethod(args.method);
  const correlationId =
    asNonEmptyString(args.correlation_id) ??
    asNonEmptyString(args.idempotency_key) ??
    `console-api-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const idempotencyKey = asNonEmptyString(args.idempotency_key) ?? correlationId;
  const client = getSupabaseClient();
  if (!client) {
    if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('edge api-gateway');
    return buildApiGatewaySyntheticResult(
      {
        ...args,
        method,
        path,
        query_string: query,
        correlation_id: correlationId,
        idempotency_key: idempotencyKey,
      },
      nextCorrelationId,
    );
  }

  const operatorHeaders = objectRecord(args.headers);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(operatorHeaders)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || value == null) continue;
    if (normalizedKey.toLowerCase() === 'content-type') continue;
    headers[normalizedKey] = String(value);
  }
  headers['x-webhook-token'] = token;
  headers['x-correlation-id'] = correlationId;
  headers['idempotency-key'] = idempotencyKey;
  const replayOf = asNonEmptyString(args.replay_of);
  if (replayOf) {
    headers['x-masarx-replay-of'] = replayOf;
  }

  const invokeName = `api-gateway${path}${query ? `?${query}` : ''}`;
  const payload = args.payload ?? {};
  const startedAtMs = Date.now();
  let response: Record<string, unknown> = {};
  let invokeErrorMessage: string | null = null;
  try {
    const invokePromise = withApiGatewayInvokeTimeout(
      invokeApiGatewayEdge(client, invokeName, { method, payload, headers }),
    );
    const invokeOutcome = await waitForApiGatewayInvokeOrAuthRejection(invokePromise, {
      correlationId,
      method,
      path,
      startedAtMs,
    });
    if (invokeOutcome.type === 'auth_rejection') {
      assertApiGatewaySelectedSourceMatchesReadback(args, invokeOutcome.row);
      throw new Error(apiGatewayAuthRejectionMessage(invokeOutcome.row));
    }
    const { data, error } = invokeOutcome.result;
    if (error) {
      invokeErrorMessage = await readFunctionErrorMessage(error, 'api-gateway failed');
      response = { ...objectRecord(data), error: invokeErrorMessage };
    } else {
      response = objectRecord(data);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('API Gateway auth rejected by backend readback')) {
      throw err;
    }
    invokeErrorMessage = err instanceof Error ? err.message : API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE;
    response = { error: invokeErrorMessage };
  }

  const responseRequestId = findNestedString(response, ['api_gateway_request_id', 'request_id']);
  const responseCorrelationId = findNestedString(response, ['correlation_id']) ?? correlationId;
  const filters = [
    responseRequestId ? { request_id: responseRequestId } : null,
    { correlation_id: responseCorrelationId },
    responseCorrelationId !== correlationId ? { correlation_id: correlationId } : null,
  ].filter(Boolean) as Array<Record<string, unknown>>;

  const expectShipment = args.expect_shipment !== false;
  const responseIsEmpty = Object.keys(response).length === 0;
  const responseStatus = findNestedNumber(response, ['status', 'status_code', 'http_status']);
  const responseHasErrorSignal =
    Boolean(findNestedString(response, ['error', 'code', 'message', 'failure_code'])) ||
    (responseStatus != null && responseStatus >= 400);
  if (invokeErrorMessage || responseIsEmpty || (!responseRequestId && responseHasErrorSignal)) {
    try {
      const exactAuthRejection = await readApiGatewayAuthRejectionReadback({
        correlationId: responseCorrelationId,
        method,
        path,
        startedAtMs,
      });
      if (exactAuthRejection) {
        assertApiGatewaySelectedSourceMatchesReadback(args, exactAuthRejection);
        throw new Error(apiGatewayAuthRejectionMessage(exactAuthRejection));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('API Gateway auth rejected by backend readback')) {
        throw err;
      }
      // Older deployments may not expose api_gateway_auth_rejections yet.
      // Continue to the canonical request readback path when that projection
      // is unavailable instead of failing unrelated successful tests.
    }
    const edgeAuthMessage = apiGatewayEdgeAuthErrorMessage(response, invokeErrorMessage);
    if (edgeAuthMessage) {
      throw new Error(edgeAuthMessage);
    }
  }
  if (invokeErrorMessage) {
    try {
      const authRejection = await readApiGatewayAuthRejectionReadback({
        correlationId: responseCorrelationId,
        method,
        path,
        startedAtMs,
        allowRecentFallback: true,
      });
      if (authRejection) {
        assertApiGatewaySelectedSourceMatchesReadback(args, authRejection);
        throw new Error(apiGatewayAuthRejectionMessage(authRejection));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('API Gateway auth rejected by backend readback')) {
        throw err;
      }
      // If the auth-rejection projection is temporarily unavailable, keep the
      // canonical request-readback wait below so non-auth failures still settle.
    }
  }
  const readbackTimeoutMs = invokeErrorMessage === API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE
    ? API_GATEWAY_REQUEST_READBACK_AFTER_INVOKE_TIMEOUT_MS
    : API_GATEWAY_REQUEST_READBACK_TIMEOUT_MS;
  const deadline = performance.now() + readbackTimeoutMs;
  let readback: ResourceRow | null = null;
  let firstReadbackAt: number | null = null;
  while (performance.now() <= deadline) {
    readback = await readApiGatewayRequestTestReadback(filters);
    if (readback && apiGatewayReadbackTerminal(readback, expectShipment)) break;
    if (readback) {
      firstReadbackAt ??= performance.now();
      if (performance.now() - firstReadbackAt >= API_GATEWAY_TERMINAL_SETTLE_AFTER_FIRST_READBACK_MS) break;
    }
    if (performance.now() >= deadline) break;
    await sleep(API_GATEWAY_REQUEST_READBACK_INTERVAL_MS);
  }

  if (!readback) {
    if (invokeErrorMessage) throw new Error(invokeErrorMessage);
    throw new Error('api-gateway request did not produce backend request readback');
  }
  assertApiGatewaySelectedSourceMatchesReadback(args, readback);

  const result = buildApiGatewayRequestResult(
    {
      ...args,
      method,
      path,
      query_string: query,
      correlation_id: responseCorrelationId,
      idempotency_key: idempotencyKey,
    },
    response,
    readback,
    { invokeErrorMessage },
  );
  if (result.shipment_id) {
    await requireLiveResourceReadback('shipments', result.shipment_id, 'api-gateway');
    await requireLiveResourceReadback('shipment_directory', result.shipment_id, 'api-gateway');
  }
  if (expectShipment && result.intake_state === 'shipment_materialized' && !result.shipment_id) {
    throw new Error('api-gateway materialized shipment without canonical shipment readback');
  }
  return result;
}

export async function runWebhookReceiverTest(
  args: RunWebhookReceiverTestArgs,
): Promise<RunWebhookReceiverTestResult> {
  const token = asNonEmptyString(args.auth_token);
  if (!token) throw new Error('Intake source token is required');
  const payload: Record<string, unknown> =
    args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
      ? args.payload as Record<string, unknown>
      : {};
  const fallbackUuid = (): string => {
    const timestampHex = Date.now().toString(16).padStart(12, '0').slice(-12);
    const randomHex = Math.random().toString(16).slice(2).padEnd(20, '0').slice(0, 20);
    return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-4${randomHex.slice(0, 3)}-8${randomHex.slice(3, 6)}-${randomHex.slice(6, 18)}`;
  };
  const idempotencyKey =
    asNonEmptyString(args.idempotency_key) ?? globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
  const signature = asNonEmptyString(args.signature);
  const client = getSupabaseClient();
  if (!client) {
    if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('edge webhook-receiver');
    return buildWebhookReceiverSyntheticResult({ ...args, idempotency_key: idempotencyKey }, nextCorrelationId);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-webhook-token': token,
    'idempotency-key': idempotencyKey,
    'x-correlation-id': idempotencyKey,
  };
  if (signature) headers['x-signature'] = signature;

  const startedAt = performance.now();
  const invokeResult = await Promise.race([
    invokeWebhookReceiverEdge(client, { payload, headers }).then((result) => ({ ...result, timed_out: false as const })),
    sleep(WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS).then(() => ({
      data: null,
      error: null,
      timed_out: true as const,
    })),
  ]);
  const invokeErrorMessage = invokeResult.error
    ? await readFunctionErrorMessage(invokeResult.error, 'webhook-receiver failed')
    : null;
  const response = invokeErrorMessage
    ? {
        ...objectRecord(invokeResult.data),
        accepted: false,
        error: invokeErrorMessage,
        ack_reason:
          findNestedString(invokeResult.data, ['response_reason', 'ack_reason', 'reason', 'message', 'error', 'code', 'failure_code']) ??
          invokeErrorMessage,
        response_outcome:
          findNestedString(invokeResult.data, ['response_outcome']) ?? 'response_failed',
        idempotency_key: idempotencyKey,
      }
    : invokeResult.timed_out
    ? {
        accepted: true,
        invoke_timeout: true,
        idempotency_key: idempotencyKey,
        message: 'webhook-receiver edge invocation timed out; using canonical inbox readback',
      }
    : objectRecord(invokeResult.data);
  let workflowRunId = findNestedString(response, ['workflow_run_id']);
  const followupWorkflowRunId = findNestedString(response, ['followup_workflow_run_id']);
  const correlationId = findNestedString(response, ['correlation_id']) ?? idempotencyKey;
  let ackOutcome = findNestedString(response, ['ack_outcome']);
  let responseOutcome =
    findNestedString(response, ['response_outcome']) ??
    (response.accepted === true || findNestedString(response, ['status']) === 'accepted_async'
      ? 'accepted'
      : null);
  let ackStatusCode = findNestedNumber(response, ['ack_status_code', 'status_code']);
  let ackReason = findNestedString(response, ['ack_reason']);
  let webhookId = findNestedString(response, ['webhook_id']);
  let canonicalIntent = findNestedString(response, ['canonical_intent']);
  let authRejectionId: string | null = null;
  let authRejectionFailureCode: string | null = null;
  let authRejectionFailureMessage: string | null = null;
  let authRejectionHttpStatus: number | null = null;
  let authRejectionSourceLabel: string | null = null;
  let authRejectionSourceIdentifier: string | null = null;
  let authRejectionSourceResolved: boolean | null = null;
  let authRejectionTokenFingerprint: string | null = null;
  let authRejectionRejectionClass: string | null = null;

  let workflowSteps: ResourceRow[] = [];
  let shipmentId: string | null = null;
  let trackingNumber = findNestedString(response, ['tracking_number', 'planned_tracking_number']);
  let webhookProcessingStatus: string | null = null;
  let sourceLabel: string | null = null;
  let sourceIdentifier: string | null = null;
  let providerTypeLabel: string | null = null;
  let mappingConfigId: string | null = null;
  let mappingLabel: string | null = null;
  let mappingTarget: string | null = null;
  let mappingVersion: number | null = null;
  let mappingRulesCount: number | null = null;
  let errorMessage: string | null = invokeErrorMessage;
  let isTerminal: boolean | null = null;
  let isActionable: boolean | null = null;
  const applyWebhookDirectoryReadback = (row: ResourceRow): void => {
    const rowIsTerminal = typeof row.is_terminal === 'boolean' ? row.is_terminal : null;
    webhookId = webhookId ?? asNonEmptyString(row.id);
    workflowRunId = workflowRunId ?? asNonEmptyString(row.workflow_run_id);
    canonicalIntent = canonicalIntent ?? asNonEmptyString(row.canonical_intent);
    trackingNumber = trackingNumber ?? asNonEmptyString(row.tracking_number);
    ackOutcome = asNonEmptyString(row.ack_outcome) ?? ackOutcome;
    responseOutcome = asNonEmptyString(row.response_outcome) ?? responseOutcome;
    ackStatusCode = findNestedNumber(row, ['ack_status_code', 'response_status_code', 'status_code']) ?? ackStatusCode;
    ackReason = asNonEmptyString(row.ack_reason) ?? asNonEmptyString(row.response_reason) ?? ackReason;
    webhookProcessingStatus = asNonEmptyString(row.processing_status);
    sourceLabel = asNonEmptyString(row.source_label);
    sourceIdentifier = asNonEmptyString(row.source_identifier);
    providerTypeLabel = asNonEmptyString(row.provider_type_label);
    mappingConfigId = asNonEmptyString(row.mapping_config_id);
    mappingLabel = asNonEmptyString(row.mapping_label);
    mappingTarget = asNonEmptyString(row.mapping_target);
    mappingVersion = typeof row.mapping_version === 'number' ? row.mapping_version : null;
    mappingRulesCount = typeof row.mapping_rules_count === 'number' ? row.mapping_rules_count : null;
    errorMessage = asNonEmptyString(row.error_message);
    isTerminal = rowIsTerminal;
    isActionable = typeof row.is_actionable === 'boolean' ? row.is_actionable : null;
    if (rowIsTerminal === true) {
      shipmentId = shipmentId ?? asNonEmptyString(row.shipment_id);
    }
  };
  const readWebhookDirectory = async (
    filters: Array<Record<string, unknown>>,
  ): Promise<boolean> => {
    for (const filter of filters) {
      const readback = await ui_list_resource_v1<ResourceRow>('webhook_inbox_directory', {
        filter,
        page_size: 1,
      });
      const row = readback.rows[0];
      if (!row) continue;
      applyWebhookDirectoryReadback(row);
      return true;
    }
    return false;
  };
  const readWebhookDirectoryUntil = async (
    filters: Array<Record<string, unknown>>,
    timeoutMs: number,
    requireWorkflowRun = false,
  ): Promise<boolean> => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() <= deadline) {
      const found = await readWebhookDirectory(filters);
      if (found && (!requireWorkflowRun || Boolean(workflowRunId))) return true;
      if (performance.now() >= deadline) break;
      await sleep(WEBHOOK_RECEIVER_READBACK_INTERVAL_MS);
    }
    return false;
  };
  const isWebhookReceiverTerminalFailure = (status: string | null): boolean => {
    const value = String(status ?? '').trim().toLowerCase();
    return (
      value.includes('fail') ||
      value === 'error' ||
      value === 'errored' ||
      value === 'rejected' ||
      value === 'dead_lettered'
    );
  };
  const applyWebhookAuthRejectionReadback = (row: ResourceRow): void => {
    authRejectionId = asNonEmptyString(row.id);
    authRejectionFailureCode = asNonEmptyString(row.failure_code);
    authRejectionFailureMessage = asNonEmptyString(row.failure_message);
    authRejectionHttpStatus = findNestedNumber(row, ['http_status']);
    authRejectionSourceLabel = asNonEmptyString(row.source_label);
    authRejectionSourceIdentifier = asNonEmptyString(row.source_identifier);
    authRejectionSourceResolved = typeof row.source_resolved === 'boolean' ? row.source_resolved : null;
    authRejectionTokenFingerprint = asNonEmptyString(row.token_fingerprint);
    authRejectionRejectionClass = asNonEmptyString(row.rejection_class);
    ackOutcome = 'auth_rejected';
    responseOutcome = 'auth_rejected';
    ackStatusCode = ackStatusCode ?? authRejectionHttpStatus ?? 401;
    ackReason = ackReason ?? authRejectionFailureMessage ?? authRejectionFailureCode ?? 'auth_rejected';
    errorMessage = errorMessage ?? authRejectionFailureMessage ?? authRejectionFailureCode;
    sourceLabel = sourceLabel ?? authRejectionSourceLabel;
    sourceIdentifier = sourceIdentifier ?? authRejectionSourceIdentifier;
    webhookProcessingStatus = webhookProcessingStatus ?? 'auth_rejected';
    isTerminal = true;
    isActionable = false;
  };
  const responseStatus = findNestedNumber(response, ['status', 'status_code', 'http_status']);
  const edgeRejectedWithoutLineage =
    !workflowRunId &&
    typeof responseStatus === 'number' &&
    responseStatus >= 400 &&
    responseStatus < 500;
  const responseHasAuthSignal =
    Boolean(invokeErrorMessage) ||
    responseStatus === 401 ||
    responseStatus === 403 ||
    /unauthorized|invalid_token|forbidden|auth/i.test(
      [
        findNestedString(response, ['error', 'message', 'code', 'failure_code']),
        invokeErrorMessage,
      ].filter(Boolean).join(' '),
    );
  if (responseHasAuthSignal && !workflowRunId && !edgeRejectedWithoutLineage) {
    const authRejection = await readWebhookReceiverAuthRejectionUntil({
      correlationId,
      idempotencyKey,
      startedAtMs: startedAt,
    });
    if (authRejection) {
      applyWebhookAuthRejectionReadback(authRejection);
    }
  }
  if (edgeRejectedWithoutLineage && !authRejectionId) {
    ackOutcome = ackOutcome ?? 'response_failed';
    responseOutcome = responseOutcome ?? 'response_failed';
    ackStatusCode = ackStatusCode ?? responseStatus;
    ackReason =
      ackReason ??
      findNestedString(response, ['response_reason', 'ack_reason', 'reason', 'message', 'error', 'code', 'failure_code']) ??
      invokeErrorMessage ??
      `webhook-receiver failed with HTTP ${responseStatus}`;
    errorMessage = errorMessage ?? ackReason;
    webhookProcessingStatus = webhookProcessingStatus ?? 'response_failed';
    isTerminal = true;
    isActionable = false;
  }
  if (!workflowRunId) {
    const foundReplayReadback = authRejectionId || edgeRejectedWithoutLineage
      ? false
      : await readWebhookDirectoryUntil(
          [
            webhookId ? { id: webhookId } : null,
            { idempotency_key: idempotencyKey },
            { correlation_id: correlationId },
          ].filter(Boolean) as Array<Record<string, unknown>>,
          WEBHOOK_RECEIVER_READBACK_AFTER_INVOKE_TIMEOUT_MS,
          false,
        );
    const terminalFailureWithoutWorkflow =
      foundReplayReadback &&
      isTerminal === true &&
      isWebhookReceiverTerminalFailure(webhookProcessingStatus);
    const terminalAuthRejectionWithoutWorkflow = Boolean(authRejectionId);
    if (
      (!foundReplayReadback || !workflowRunId) &&
      !terminalFailureWithoutWorkflow &&
      !terminalAuthRejectionWithoutWorkflow &&
      !edgeRejectedWithoutLineage
    ) {
      throw new Error(invokeErrorMessage ?? 'webhook-receiver did not return workflow_run_id evidence');
    }
  }
  try {
    const workflowIds = Array.from(new Set([workflowRunId, followupWorkflowRunId].filter(Boolean)));
    const stepResults = await Promise.all(
      workflowIds.map((id) =>
        ui_list_resource_v1<ResourceRow>('workflow_run_steps', {
          filter: { workflow_run_id: id },
          page_size: 50,
        }),
      ),
    );
    workflowSteps = stepResults.flatMap((result) => result.rows);
    trackingNumber = trackingNumber ?? findNestedString(workflowSteps, ['tracking_number', 'planned_tracking_number']);
  } catch {
    // The receiver evidence is still useful; the UI will show that step/shipment
    // readback is pending rather than treating the edge call as full readiness.
  }
  if (!authRejectionId && workflowRunId) {
    await readWebhookDirectory([
      webhookId ? { id: webhookId } : null,
      { workflow_run_id: workflowRunId },
      { idempotency_key: idempotencyKey },
      { correlation_id: correlationId },
    ].filter(Boolean) as Array<Record<string, unknown>>);
  }
  const webhookPayloadIntent = findNestedString(payload, ['event_type', 'type', 'intent', 'target']);
  const shipmentCreateReadbackRequired = [canonicalIntent, mappingTarget, webhookPayloadIntent]
    .some((value) => isShipmentCreateIntent(value));
  const shouldPollShipmentCreateTerminalReadback = !Object.is(isTerminal, false);
  try {
    const readDirectoryOnce = async (): Promise<boolean> => {
      const readbackFilters = [
        webhookId ? { id: webhookId } : null,
        workflowRunId ? { workflow_run_id: workflowRunId } : null,
        { idempotency_key: idempotencyKey },
        { correlation_id: correlationId },
      ].filter(Boolean) as Array<Record<string, unknown>>;
      const found = await readWebhookDirectory(readbackFilters);
      return found && (isTerminal === true || Boolean(shipmentId));
    };
    if (!authRejectionId && !edgeRejectedWithoutLineage && shipmentCreateReadbackRequired && shouldPollShipmentCreateTerminalReadback) {
      const deadline = performance.now() + WEBHOOK_RECEIVER_TERMINAL_READBACK_TIMEOUT_MS;
      do {
        const complete = await readDirectoryOnce();
        if (complete) break;
        if (performance.now() >= deadline) break;
        await sleep(WEBHOOK_RECEIVER_READBACK_INTERVAL_MS);
      } while (!shipmentId || isTerminal !== true);
    }
  } catch {
    // Keep the receiver result visible; missing directory readback prevents
    // production readiness proof and is surfaced as pending UI evidence.
  }

  const shipmentCreateTerminalFailure = isWebhookReceiverTerminalFailure(webhookProcessingStatus);
  if (shipmentCreateReadbackRequired && shipmentCreateTerminalFailure) {
    shipmentId = null;
    trackingNumber = null;
  }

  if (!shipmentId && isTerminal === true && trackingNumber && !shipmentCreateTerminalFailure) {
    try {
      const readback = await ui_list_resource_v1<ResourceRow>('shipment_directory', {
        filter: { identifier: trackingNumber },
        page_size: 1,
      });
      const row = readback.rows[0];
      shipmentId = asNonEmptyString(row?.id) ?? asNonEmptyString(row?.shipment_id) ?? shipmentId;
    } catch {
      // Tracking-only evidence keeps the receiver result visible, but the
      // shipment action remains disabled until a canonical id can be read.
    }
  }

  if (shipmentId) {
    await requireLiveResourceReadback('shipments', shipmentId, 'webhook-receiver');
    await requireLiveResourceReadback('shipment_directory', shipmentId, 'webhook-receiver');
  }

  if (shipmentCreateReadbackRequired && !authRejectionId && isTerminal === true && !shipmentId && !shipmentCreateTerminalFailure) {
    throw new Error('webhook-receiver completed shipment.create without shipment readback');
  }

  return buildWebhookReceiverTestResult({
    receiverStatus: ackStatusCode ?? 200,
    durationMs: Math.round(performance.now() - startedAt),
    correlationId,
    idempotencyKey,
    ackOutcome,
    responseOutcome,
    ackStatusCode,
    ackReason,
    workflowRunId,
    followupWorkflowRunId,
    webhookId,
    canonicalIntent,
    webhookProcessingStatus,
    sourceLabel,
    sourceIdentifier,
    providerTypeLabel,
    mappingConfigId,
    mappingLabel,
    mappingTarget,
    mappingVersion,
    mappingRulesCount,
    errorMessage,
    isTerminal,
    isActionable,
    shipmentId,
    trackingNumber,
    authRejectionId,
    authRejectionFailureCode,
    authRejectionFailureMessage,
    authRejectionHttpStatus,
    authRejectionSourceLabel,
    authRejectionSourceIdentifier,
    authRejectionSourceResolved,
    authRejectionTokenFingerprint,
    authRejectionRejectionClass,
    response,
    workflowSteps,
  });
}

// ----------- Plugin Studio 4-stage authoring loop -----------
//
// Wires the `integration-plugin-studio` edge function (Deno) which exposes 4
// canonical endpoints used by the operator authoring UX:
//
//   POST /functions/v1/integration-plugin-studio/parse
//        body: { source_type: 'curl'|'openapi'|'webhook_sample'|'manual', source_payload, plugin_kind?, organization_id?, persist_draft? }
//        returns: { ok, normalized_contract, mapping_suggestion, draft?, correlation_id }
//        capability: integration_plugins.write | mappings.write | webhooks.write | system.write
//
//   POST /functions/v1/integration-plugin-studio/infer
//        body: { normalized_contract | source_*, organization_id? }
//        returns: { ok, mapping_suggestion, outbound_suggestions, normalized_contract, draft?, correlation_id }
//        capability: same union as parse
//
//   POST /functions/v1/integration-plugin-studio/preview
//        body: { artifact: 'integration_plugin'|'webhook_inbound'|'api_outbound', mapping_config, target_schema?, organization_id? }
//        returns: { ok, artifact, normalized_contract, mapping_suggestion, review:{diagnostics, coercions, review_summary}, save_modes, correlation_id }
//        capability: integration_plugins.read | .write | mappings.read | .write | webhooks.read | .write | api_routes.read | system.write
//
//   POST /functions/v1/integration-plugin-studio/save
//        body: { artifact, save_mode?, mapping_config, organization_id?, … }
//        returns: { ok, artifact, save_mode:'direct'|'draft', normalized_contract, review, result, report, correlation_id }
//        capability: artifact-specific (mappings.write for tabular_import / webhook_inbound, system.write for api_outbound, integration_plugins.write for draft mode on integration_plugin)
//
// Backend SSOT: supabase/functions/integration-plugin-studio/index.ts.
//
// The FE adapters call `supabase.functions.invoke('integration-plugin-studio/<stage>', { body })`
// when a live client is available. The in-memory branch returns deterministic
// envelopes that mirror the edge fn shape so unit tests and the demo build stay
// environment-agnostic.

export type PluginStudioSourceType = 'curl' | 'openapi' | 'webhook_sample' | 'manual';
export type PluginStudioArtifact = 'tabular_import' | 'webhook_inbound' | 'api_outbound' | 'integration_plugin';
export type PluginStudioSaveMode = 'direct' | 'draft';

export interface PluginStudioParseArgs extends Record<string, unknown> {
  source_type: PluginStudioSourceType | string;
  source_payload: unknown;
  plugin_kind?: 'webhook' | 'api' | string;
  organization_id?: string | null;
  plugin_name?: string;
  plugin_key?: string | null;
  description?: string | null;
  persist_draft?: boolean;
}

export interface PluginStudioNormalizedContract extends Record<string, unknown> {
  source_type: string;
  plugin_kind: 'webhook' | 'api' | string;
  route?: Record<string, unknown>;
  webhook?: Record<string, unknown>;
  sample_schema?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PluginStudioParseResult extends Record<string, unknown> {
  ok: true;
  endpoint: 'parse';
  normalized_contract: PluginStudioNormalizedContract;
  mapping_suggestion: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  correlation_id: string;
}

export interface PluginStudioInferArgs extends PluginStudioParseArgs {
  normalized_contract?: PluginStudioNormalizedContract;
}

export interface PluginStudioInferResult extends Record<string, unknown> {
  ok: true;
  endpoint: 'infer';
  mapping_suggestion: Record<string, unknown>;
  outbound_suggestions: Array<Record<string, unknown>>;
  normalized_contract: PluginStudioNormalizedContract;
  draft: Record<string, unknown> | null;
  correlation_id: string;
}

export interface PluginStudioPreviewArgs extends Record<string, unknown> {
  artifact: PluginStudioArtifact;
  organization_id?: string | null;
  normalized_contract?: PluginStudioNormalizedContract;
  source_type?: PluginStudioSourceType | string;
  source_payload?: unknown;
  plugin_kind?: 'webhook' | 'api' | string;
  mapping_config?: Record<string, unknown>;
  target_schema?: Record<string, unknown>;
  request_config?: Record<string, unknown>;
  workflow_binding?: Record<string, unknown>;
  save_mode?: PluginStudioSaveMode;
}

export interface PluginStudioReview extends Record<string, unknown> {
  mapping_config: Record<string, unknown>;
  coerced_preview: Record<string, unknown>;
  coercions: Array<Record<string, unknown>>;
  diagnostics: Array<{
    level: 'error' | 'warning' | 'info';
    blocking: boolean;
    code: string;
    fieldPath?: string | null;
    message: string;
    why: string;
    recommended_fix: string;
    source_policy?: string | null;
    settings_resolution_id?: string | null;
  }>;
  review_summary: {
    blocking_count: number;
    warning_count: number;
    coercion_count: number;
    next_steps: string[];
    egress_policy_resolution_id: string | null;
  };
}

export interface PluginStudioPreviewResult extends Record<string, unknown> {
  ok: true;
  endpoint: 'preview';
  artifact: PluginStudioArtifact;
  normalized_contract: PluginStudioNormalizedContract | null;
  mapping_suggestion: Record<string, unknown>;
  review: PluginStudioReview;
  save_modes: {
    direct_allowed: boolean;
    draft_allowed: boolean;
    recommended: PluginStudioSaveMode | null;
  };
  correlation_id: string;
}

export interface PluginStudioSaveArgs extends PluginStudioPreviewArgs {
  save_mode?: PluginStudioSaveMode;
  plugin_name?: string;
  plugin_key?: string | null;
  description?: string | null;
}

export interface PluginStudioSaveResult extends Record<string, unknown> {
  ok: true;
  endpoint: 'save';
  artifact: PluginStudioArtifact;
  save_mode: PluginStudioSaveMode;
  normalized_contract: PluginStudioNormalizedContract | null;
  review: PluginStudioReview;
  result: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  correlation_id: string;
}

export interface EdgeStudioErrorEnvelope {
  error?: { code?: string; message?: string };
  message?: string;
  ok?: false;
}

export const PLUGIN_STUDIO_FN = 'integration-plugin-studio';

/**
 * Stage 1 — `parse`. Normalizes a raw source (curl text, OpenAPI doc, webhook
 * sample JSON, or manual config) into the canonical `normalized_contract` shape
 * and produces an initial deterministic mapping suggestion. Optionally persists
 * a draft plugin version when `persist_draft=true`.
 */
export async function plugin_studio_parse_v1(
  args: PluginStudioParseArgs,
): Promise<PluginStudioParseResult> {
  const { plugin_studio_parse_v1 } = await import('./data-source/plugin-studio');
  return plugin_studio_parse_v1(args);
}

/**
 * Stage 2 — `infer`. Takes a normalized contract (or raw source) and produces a
 * mapping suggestion plus outbound operation suggestions for API plugins.
 */
export async function plugin_studio_infer_v1(
  args: PluginStudioInferArgs,
): Promise<PluginStudioInferResult> {
  const { plugin_studio_infer_v1 } = await import('./data-source/plugin-studio');
  return plugin_studio_infer_v1(args);
}

/**
 * Stage 3 — `preview`. Validates a candidate mapping against the target schema,
 * resolves egress/header policy, returns blocking/non-blocking diagnostics,
 * coercions, and the recommended save mode (direct vs draft).
 */
export async function plugin_studio_preview_v1(
  args: PluginStudioPreviewArgs,
): Promise<PluginStudioPreviewResult> {
  const { plugin_studio_preview_v1 } = await import('./data-source/plugin-studio');
  return plugin_studio_preview_v1(args);
}

/**
 * Stage 4 — `save`. Persists the artifact (draft for `integration_plugin` via
 * `integration_plugin_generate_draft_v1`; direct for tabular/webhook/api via
 * `ui_upsert_mapping_artifact_v1`) and writes a canonical operation report
 * through `ui_create_mapping_operation_report_v1`.
 *
 * Throws when blocking diagnostics exist or no eligible save mode is available
 * (the edge fn returns 400/403 with a structured error envelope which is
 * surfaced as `Error.message` here).
 */
export async function plugin_studio_save_v1(
  args: PluginStudioSaveArgs,
): Promise<PluginStudioSaveResult> {
  const { plugin_studio_save_v1 } = await import('./data-source/plugin-studio');
  return plugin_studio_save_v1(args);
}

// ----------- Resource Import Studio file pipeline -----------
//
// The Imports page has two canonical seams:
//   1. public.import_jobs (queue ledger) via import_job_create_v1/cancel.
//   2. resource-import-studio edge function for CSV/XLS/XLSX parsing,
//      mapping-profile resolution, dry-run creation, and tabular run start.
//
// This adapter keeps the edge path environment-only: live clients invoke the
// edge function; seed mode returns a deterministic dry-run envelope with the
// same top-level shape so the UI and tests stay stable.
export interface ResourceImportStudioPrepareArgs extends Record<string, unknown> {
  file: File;
  resource_key: string;
  write_mode?: string;
  rule_source?: string;
  sheet_name?: string | null;
  rules?: unknown[];
  row_overrides?: Record<string, unknown>;
  scope_context?: Record<string, unknown>;
}

export interface ResourceImportStudioPrepareResult extends Record<string, unknown> {
  ok: true;
  dry_run: Record<string, unknown>;
  profile_match: Record<string, unknown> | null;
  available_profiles: unknown[];
  resolved_rules: unknown[];
  correlation_id: string;
}

export interface ResourceImportStudioStartArgs extends Record<string, unknown> {
  run_id: string;
  save_profile?: Record<string, unknown> | null;
}

export interface ResourceImportStudioStartResult extends Record<string, unknown> {
  ok: true;
  run: Record<string, unknown>;
  report: Record<string, unknown> | null;
  correlation_id: string;
}

export interface ResourceImportStudioCancelArgs extends Record<string, unknown> {
  run_id: string;
  reason: string;
}

export interface ResourceImportStudioCancelResult extends Record<string, unknown> {
  ok: true;
  run: Record<string, unknown>;
  correlation_id: string;
}

export const RESOURCE_IMPORT_STUDIO_FN = 'resource-import-studio';

export const RESOURCE_IMPORT_PREPARE_READBACK_COUNT_KEYS = [
  'total_rows',
  'valid_rows',
  'will_create',
  'will_update',
  'will_skip',
  'blocked_count',
  'warning_count',
  'created_count',
  'updated_count',
  'skipped_count',
  'failed_count',
] as const;

export const RESOURCE_IMPORT_PREPARE_READBACK_SUMMARY_KEYS = [
  'unmatched_headers',
  'unresolved_targets',
  'automatic_corrections',
  'blocking_diagnostics',
  'warning_diagnostics',
  'rows_preview',
  'related_node_summary',
  'related_nodes',
  'available_related_nodes',
  'resolved_rules',
  'scope_context',
] as const;

export async function resource_import_studio_prepare_v1(
  args: ResourceImportStudioPrepareArgs,
): Promise<ResourceImportStudioPrepareResult> {
  const { resource_import_studio_prepare_v1 } = await import('./data-source/resource-import');
  return resource_import_studio_prepare_v1(args);
}

export async function resource_import_studio_start_v1(
  args: ResourceImportStudioStartArgs,
): Promise<ResourceImportStudioStartResult> {
  const { resource_import_studio_start_v1 } = await import('./data-source/resource-import');
  return resource_import_studio_start_v1(args);
}

export async function resource_import_studio_cancel_v1(
  args: ResourceImportStudioCancelArgs,
): Promise<ResourceImportStudioCancelResult> {
  const { resource_import_studio_cancel_v1 } = await import('./data-source/resource-import');
  return resource_import_studio_cancel_v1(args);
}

export type ResourceDownloadResource =
  | 'labels'
  | 'label_jobs'
  | 'label_versions'
  | 'label_artifacts'
  | 'shipment_pod_asset';

export interface ResourceDownloadUrlArgs extends Record<string, unknown> {
  resource: ResourceDownloadResource | string;
  id: string;
  shipment_id?: string | null;
  workflow_run_id?: string | null;
  expires_seconds?: number | null;
}

export interface ResourceDownloadUrlResult extends Record<string, unknown> {
  url: string;
  expires_at?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
}

export async function resolve_resource_download_url_v1(
  args: ResourceDownloadUrlArgs,
): Promise<ResourceDownloadUrlResult> {
  const { resolve_resource_download_url_v1 } = await import('./data-source/resource-import');
  return resolve_resource_download_url_v1(args);
}

// ----------- Workflow runs (canonical RPCs) -----------
// Real backend RPCs (verified): public.start_workflow_run(uuid, jsonb) RETURNS uuid;
// public.progress_workflow_run(uuid, jsonb) RETURNS jsonb; public.close_workflow_run(uuid, text) RETURNS void.
// See supabase/migrations/202510150004_phase3_db_functions.sql plus the long fixup chain.
// Operator action variants (manual_override, reopen_pending, retry, pause, resume) are
// expressed as `action` keys inside the `progress_workflow_run` jsonb payload — there are
// NO dedicated `_manual_override` / `_reopen_pending` RPCs in the backend.
export interface WorkflowRunStartContext extends Record<string, unknown> {
  ui?: {
    dry_run?: boolean;
    sample_payload?: unknown;
    replay_of?: string;
    allow_inactive?: boolean;
  };
}

export interface SyntheticRunStep {
  id: string;
  step_id: string;
  label: string;
  kind?: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'pending' | 'running';
  duration_ms: number | null;
  enqueued_at: string;
  operation_started_at?: string;
  operation_completed_at?: string;
  operation_result?: Record<string, unknown> | null;
  last_error?: string | null;
  retry_attempt?: number;
  decision_log_id?: string;
}

export const _runStepCache = new Map<string, SyntheticRunStep[]>();

export async function start_workflow_run(
  templateId: string,
  context: WorkflowRunStartContext = {},
): Promise<{
  ok: true;
  workflow_run_id: string;
  workflow_template_id: string;
  workflow_status: 'pending' | 'running';
  dry_run: boolean;
  idempotency_key: string;
  correlation_id: string;
  started_at: string;
  canonical_entrypoint: 'progress_workflow_run';
}> {
  const { start_workflow_run } = await import('./data-source/workflows');
  return start_workflow_run(templateId, context);
}

/**
 * Mirrors `public.progress_workflow_run(uuid, jsonb) RETURNS jsonb`.
 *
 * The third `action` argument is encoded into the canonical payload
 * (real backend reads it from the jsonb `action` key). Operator variants such
 * as `manual_override` / `reopen_pending` / `retry` / `pause` / `resume` ride
 * through the same RPC — no separate functions exist.
 */
export async function progress_workflow_run(
  runId: string,
  payload?: unknown,
  action?: 'progress' | 'manual_override' | 'reopen_pending' | 'retry' | 'pause' | 'resume',
): Promise<{
  ok: true;
  workflow_run_id: string;
  workflow_status: 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused';
  duration_ms: number;
  steps: SyntheticRunStep[];
  payload?: unknown;
  action?: typeof action;
}> {
  const { progress_workflow_run } = await import('./data-source/workflows');
  return progress_workflow_run(runId, payload, action);
}

export async function progress_workflow_run_until_wait_v1(
  runId: string,
  payload?: unknown,
  opts: { budget_ms?: number; max_steps?: number } = {},
): Promise<{
  ok: true;
  workflow_run_id: string;
  workflow_status: 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused';
  duration_ms: number;
  steps: SyntheticRunStep[];
  payload?: unknown;
}> {
  const { progress_workflow_run_until_wait_v1 } = await import('./data-source/workflows');
  return progress_workflow_run_until_wait_v1(runId, payload, opts);
}

export async function progress_workflow_run_base(
  runId: string,
  payload?: unknown,
): Promise<{ ok: true; workflow_run_id: string; payload?: unknown }> {
  const { progress_workflow_run_base } = await import('./data-source/workflows');
  return progress_workflow_run_base(runId, payload);
}

/**
 * Mirrors `public.close_workflow_run(uuid, text) RETURNS void`.
 * The richer `closed_at`/`workflow_status` envelope is FE-side enrichment for
 * the in-memory adapter; on Supabase swap, derive `closed_at` from a follow-up
 * `ui_list_resource_v1('workflow_runs', { filter: { id }})` read.
 */
export async function close_workflow_run(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<{ ok: true; workflow_run_id: string; workflow_status: typeof status; closed_at: string }> {
  const { close_workflow_run } = await import('./data-source/workflows');
  return close_workflow_run(runId, status);
}

// Operation templates type — kept exported for module typing convenience.
// Backed by `ui_list_resource_v1('operation_templates')` (sourced from the
// _operationTemplatesCatalog() seed-derivation in this same file). On Supabase
// swap this surfaces directly from `public.operation_templates`.
export interface OperationTemplate extends Record<string, unknown> {
  id: string;
  operation_name: string;
  kind: 'trigger' | 'transform' | 'guard' | 'action' | 'error' | 'manual';
  category: string;
  timeout_seconds: number;
  description: string;
}

// ----------- Trace (canonical ui_get_trace_v1 envelope) -----------
//
// Mirrors `public.ui_get_trace_v1(uuid)` per
// `supabase/migrations/202601051630_ui_get_trace_v1.sql:6,56-62` — returns
// `{ correlation_id, observability_events, domain_events, workflow_runs }`.
// On Supabase swap, the live branch routes through `client.rpc(...)`. In
// demo mode we synthesize a representative 3-section envelope from a
// deterministic seed of the correlation_id so the FE renders something
// useful without backend.
//
// The legacy `{ spans: [...] }` shape (REAUDIT INSIGHTS §D3) is retired —
// the FE consumer now reads observability_events directly and treats each
// event as a timeline row.
export async function ui_get_trace_v1(correlationId: string): Promise<{
  correlation_id: string;
  observability_events: Array<Record<string, unknown>>;
  domain_events: Array<Record<string, unknown>>;
  workflow_runs: Array<Record<string, unknown>>;
}> {
  const { ui_get_trace_v1 } = await import('./data-source/insights');
  return ui_get_trace_v1(correlationId);
}

// ----------- Planning OS -----------
export async function listProjectItems(): Promise<unknown> {
  const target = liveRpcTarget();
  if (target) {
    const res = await ui_list_resource_v1('planning_os_project_items', { page_size: 50 });
    return res.rows;
  }
  await sleep(40);
  return seed.project_items;
}
export async function listExecutionCards(): Promise<unknown> {
  const target = liveRpcTarget();
  if (target) {
    const res = await ui_list_resource_v1('planning_os_execution_cards', { page_size: 50 });
    return res.rows;
  }
  await sleep(40);
  return seed.execution_cards;
}
export async function listWorkerClaims(): Promise<unknown> {
  await sleep(40);
  return seed.worker_claims;
}
export async function getAuthEmailUrlPolicy(): Promise<unknown> {
  const target = liveRpcTarget();
  if (target) {
    const res = await ui_list_resource_v1('auth_email_url_policy', { page_size: 1 });
    return res.rows[0] ?? null;
  }
  await sleep(40);
  return seed.auth_email_url_policy;
}

// ----------- Phase B6: Customers (clients/senders) lifecycle RPCs -----------
//
// Mirrors:
//   • public.client_suspend_v1(p_args jsonb)     — supabase/migrations/202604280214_client_suspend_v1.sql
//   • public.client_reactivate_v1(p_args jsonb)  — supabase/migrations/202604280215_client_reactivate_v1.sql
//   • public.sender_suspend_v1(p_args jsonb)     — supabase/migrations/202604280216_sender_suspend_v1.sql
//   • public.sender_reactivate_v1(p_args jsonb)  — supabase/migrations/202604280217_sender_reactivate_v1.sql
//
// Capability: clients.write / senders.write. RPC contract returns:
//   { ok, client_id|sender_id, idempotent_no_op, correlation_id, settings_resolution_id }.
// Live mode branches into client.rpc(...). Demo mode mutates seed rows in place
// and returns a structurally-identical envelope.

export interface ClientLifecycleResult {
  ok: true;
  client_id: string;
  idempotent_no_op: boolean;
  correlation_id: string;
  settings_resolution_id: string;
}

export interface SenderLifecycleResult {
  ok: true;
  sender_id: string;
  idempotent_no_op: boolean;
  correlation_id: string;
  settings_resolution_id: string;
}

export function nextCorrelationIdHex(): string {
  // Mirrors `encode(gen_random_bytes(8), 'hex')` shape (16 hex chars).
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export async function client_suspend_v1(args: {
  client_id: string;
  organization_id?: string;
  reason?: string;
}): Promise<ClientLifecycleResult> {
  const { client_suspend_v1 } = await import('./data-source/customers');
  return client_suspend_v1(args);
}

export async function client_reactivate_v1(args: {
  client_id: string;
  organization_id?: string;
}): Promise<ClientLifecycleResult> {
  const { client_reactivate_v1 } = await import('./data-source/customers');
  return client_reactivate_v1(args);
}

export async function sender_suspend_v1(args: {
  sender_id: string;
  reason?: string;
}): Promise<SenderLifecycleResult> {
  const { sender_suspend_v1 } = await import('./data-source/customers');
  return sender_suspend_v1(args);
}

export async function sender_reactivate_v1(args: {
  sender_id: string;
}): Promise<SenderLifecycleResult> {
  const { sender_reactivate_v1 } = await import('./data-source/customers');
  return sender_reactivate_v1(args);
}

// ----------- Wave 6: Customers create/update RPCs -----------
//
// Mirrors:
//   • public.client_create_v1(p_args jsonb)     — supabase/migrations/202604301000_client_create_v1.sql
//   • public.client_update_v1(p_args jsonb)     — supabase/migrations/202604301010_client_update_v1.sql
//   • public.sender_create_v1(p_args jsonb)     — supabase/migrations/202604301020_sender_create_v1.sql
//   • public.sender_update_v1(p_args jsonb)     — supabase/migrations/202604301030_sender_update_v1.sql
//   • public.recipient_create_v1(p_args jsonb)  — supabase/migrations/202605031940_recipient_create_delete_v1.sql
//   • public.recipient_update_v1(p_args jsonb)  — supabase/migrations/202604301040_recipient_update_v1.sql
//   • public.recipient_delete_v1(p_args jsonb)  — supabase/migrations/202605031940_recipient_create_delete_v1.sql
//
// Capabilities: clients.write / senders.write / recipients.write.
// Update RPCs forbid status mutations (lifecycle owned by suspend/reactivate).
// Live mode branches into client.rpc(...). Demo mode mutates seed rows in place
// and returns a structurally-identical envelope.

export interface ClientCreateResult {
  ok: true;
  client_id: string;
  correlation_id: string;
  settings_resolution_id: string;
}

export type ClientUpdateResult = ClientLifecycleResult;

export interface SenderCreateResult {
  ok: true;
  sender_id: string;
  correlation_id: string;
  settings_resolution_id: string;
}

export type SenderUpdateResult = SenderLifecycleResult;

export interface RecipientCreateResult {
  ok: true;
  recipient_id: string;
  correlation_id: string;
  settings_resolution_id: string;
}

export interface RecipientUpdateResult {
  ok: true;
  recipient_id: string;
  idempotent_no_op: boolean;
  correlation_id: string;
  settings_resolution_id: string;
}

export interface RecipientDeleteResult {
  ok: true;
  recipient_id: string;
  deleted: boolean;
  shipment_reference_count?: number;
  correlation_id: string;
  settings_resolution_id: string;
}

export async function client_create_v1(args: {
  name: string;
  slug: string;
  sla_tier?: string;
  account_manager_id?: string | null;
  contract_start_date?: string | null;
  contract_end_date?: string | null;
  organization_id?: string;
  settings_override?: Record<string, unknown> | null;
}): Promise<ClientCreateResult> {
  const { client_create_v1 } = await import('./data-source/customers');
  return client_create_v1(args);
}

export async function client_update_v1(args: {
  client_id: string;
  organization_id?: string;
  patch?: Record<string, unknown>;
  name?: string;
  sla_tier?: string;
  account_manager_id?: string | null;
  contract_start_date?: string | null;
  contract_end_date?: string | null;
  billing_settings?: Record<string, unknown> | null;
  settings_override?: Record<string, unknown> | null;
}): Promise<ClientUpdateResult> {
  const { client_update_v1 } = await import('./data-source/customers');
  return client_update_v1(args);
}

export async function sender_create_v1(args: {
  client_id: string;
  name: string;
  brand_name?: string;
  auto_recreate?: boolean;
  settings_override?: Record<string, unknown> | null;
}): Promise<SenderCreateResult> {
  const { sender_create_v1 } = await import('./data-source/customers');
  return sender_create_v1(args);
}

export async function sender_update_v1(args: {
  sender_id: string;
  name?: string;
  brand_name?: string | null;
  auto_recreate?: boolean;
  warehouse_address_id?: string | null;
  settings_override?: Record<string, unknown> | null;
}): Promise<SenderUpdateResult> {
  const { sender_update_v1 } = await import('./data-source/customers');
  return sender_update_v1(args);
}

export async function recipient_create_v1(args: {
  client_id: string;
  name: string;
  phone_number: string;
  email?: string | null;
  external_id?: string | null;
  preferred_language?: string;
  preferred_comm_channel?: string;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  communication_preferences?: Record<string, unknown> | null;
  organization_id?: string;
}): Promise<RecipientCreateResult> {
  const { recipient_create_v1 } = await import('./data-source/customers');
  return recipient_create_v1(args);
}

export async function recipient_update_v1(args: {
  recipient_id: string;
  name?: string;
  phone_number?: string;
  email?: string | null;
  external_id?: string | null;
  preferred_language?: string;
  preferred_comm_channel?: string;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  communication_preferences?: Record<string, unknown> | null;
}): Promise<RecipientUpdateResult> {
  const { recipient_update_v1 } = await import('./data-source/customers');
  return recipient_update_v1(args);
}

export async function recipient_delete_v1(args: {
  recipient_id: string;
  reason?: string;
}): Promise<RecipientDeleteResult> {
  const { recipient_delete_v1 } = await import('./data-source/customers');
  return recipient_delete_v1(args);
}

// ----------- Phase B6: Catalog service offering RPCs -----------
//
// Mirrors:
//   • public.service_offering_create_v1(p_args)  — supabase/migrations/202604280201_service_offering_create_v1.sql
//   • public.service_offering_update_v1(p_args)  — supabase/migrations/202604280202_service_offering_update_v1.sql
//   • public.service_offering_archive_v1(p_args) — supabase/migrations/202604280203_service_offering_archive_v1.sql
//   • public.service_offering_toggle_v1(p_args)  — supabase/migrations/202604280204_service_offering_toggle_v1.sql
//   • public.service_level_create_v1(p_args)     — supabase/migrations/202604280205_service_level_create_v1.sql
//   • public.service_level_update_v1(p_args)     — supabase/migrations/202604280206_service_level_update_v1.sql
//
// Capability: agreements.write (alias service_offerings.write).

export interface ServiceOfferingMutationResult {
  ok: true;
  service_offering_id: string;
  idempotent_no_op?: boolean;
  correlation_id: string;
  settings_resolution_id: string;
}

export interface ServiceLevelMutationResult {
  ok: true;
  service_level_id: string;
  correlation_id: string;
  settings_resolution_id: string;
}

export async function service_offering_create_v1(args: {
  service_level_id: string;
  branch_id?: string | null;
  zone_id?: string | null;
  priority?: number;
  metadata?: Record<string, unknown>;
}): Promise<ServiceOfferingMutationResult> {
  const { service_offering_create_v1 } = await import('./data-source/catalog');
  return service_offering_create_v1(args);
}

export async function service_offering_update_v1(args: {
  service_offering_id: string;
  zone_id?: string | null;
  priority?: number;
  effective_from?: string;
  effective_to?: string | null;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
  price?: { base_price: number; currency: string };
}): Promise<ServiceOfferingMutationResult> {
  const { service_offering_update_v1 } = await import('./data-source/catalog');
  return service_offering_update_v1(args);
}

export async function service_offering_archive_v1(args: {
  service_offering_id: string;
  reason?: string;
}): Promise<ServiceOfferingMutationResult> {
  const { service_offering_archive_v1 } = await import('./data-source/catalog');
  return service_offering_archive_v1(args);
}

export async function service_offering_toggle_v1(args: {
  service_offering_id: string;
  is_active?: boolean;
}): Promise<ServiceOfferingMutationResult> {
  const { service_offering_toggle_v1 } = await import('./data-source/catalog');
  return service_offering_toggle_v1(args);
}

export async function service_level_create_v1(args: {
  key: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  organization_id?: string;
}): Promise<ServiceLevelMutationResult> {
  const { service_level_create_v1 } = await import('./data-source/catalog');
  return service_level_create_v1(args);
}

export async function service_level_update_v1(args: {
  service_level_id: string;
  name?: string;
  description?: string;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<ServiceLevelMutationResult> {
  const { service_level_update_v1 } = await import('./data-source/catalog');
  return service_level_update_v1(args);
}

// ----------- Phase B6: Catalog lookup RPCs -----------
//
// Mirrors:
//   • public.lookup_definition_create_v1(p_args)  — supabase/migrations/202604280207_lookup_definition_create_v1.sql
//   • public.lookup_value_create_v1(p_args)       — supabase/migrations/202604280208_lookup_value_create_v1.sql
//   • public.lookup_value_update_v1(p_args)       — supabase/migrations/202604280209_lookup_value_update_v1.sql
//   • public.lookup_value_archive_v1(p_args)      — supabase/migrations/202604280210_lookup_value_archive_v1.sql
//   • public.lookup_value_promote_v1(p_args)      — supabase/migrations/202604280211_lookup_value_promote_v1.sql
//
// Capability: lookups.write.

export interface LookupDefinitionMutationResult {
  ok: true;
  lookup_definition_id: string;
  category: string;
  correlation_id: string;
  settings_resolution_id: string;
}

export interface LookupValueMutationResult {
  ok: true;
  lookup_value_id: string;
  status?: string;
  idempotent_no_op?: boolean;
  correlation_id: string;
  settings_resolution_id: string;
}

export async function lookup_definition_create_v1(args: {
  category: string;
  description?: string;
  owner_role?: string;
  approval_policy?: string;
  is_mutable?: boolean;
  scope_type?: string;
  organization_id?: string;
}): Promise<LookupDefinitionMutationResult> {
  const { lookup_definition_create_v1 } = await import('./data-source/catalog');
  return lookup_definition_create_v1(args);
}

export async function lookup_value_create_v1(args: {
  lookup_definition_id?: string;
  category?: string;
  value: string;
  label: string;
  description?: string;
  sort_order?: number;
  metadata?: Record<string, unknown>;
  status?: 'draft' | 'active' | 'archived';
}): Promise<LookupValueMutationResult> {
  const { lookup_value_create_v1 } = await import('./data-source/catalog');
  return lookup_value_create_v1(args);
}

export async function lookup_value_update_v1(args: {
  lookup_value_id: string;
  label?: string;
  description?: string;
  sort_order?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<LookupValueMutationResult> {
  const { lookup_value_update_v1 } = await import('./data-source/catalog');
  return lookup_value_update_v1(args);
}

export async function lookup_value_archive_v1(args: {
  lookup_value_id: string;
  reason?: string;
}): Promise<LookupValueMutationResult> {
  const { lookup_value_archive_v1 } = await import('./data-source/catalog');
  return lookup_value_archive_v1(args);
}

export async function lookup_value_promote_v1(args: {
  lookup_value_id: string;
  effective_from?: string;
  effective_until?: string | null;
}): Promise<LookupValueMutationResult> {
  const { lookup_value_promote_v1 } = await import('./data-source/catalog');
  return lookup_value_promote_v1(args);
}

// ----------- Generic command runner -----------
function commandParamsRecord(params: unknown, dryRun: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = params && typeof params === 'object' && !Array.isArray(params)
    ? { ...(params as Record<string, unknown>) }
    : params === undefined
      ? {}
      : { value: params };
  if (base.dry_run === undefined) base.dry_run = dryRun;
  return base;
}

function commandSelectionIds(params: Record<string, unknown>): string[] {
  const raw = params.selected_ids ?? params.selection_ids ?? params.ids;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  const single = asNonEmptyString(params.selection_id ?? params.selected_id ?? params.id);
  return single ? [single] : [];
}

export async function runCommand(
  commandKey: string,
  params: unknown,
  opts: { dryRun?: boolean } = {},
): Promise<{
  ok: true;
  command: string;
  params: unknown;
  dry_run: boolean;
  settings_resolution_id: string;
  workflow_run_id: string;
}> {
  const dryRun = !!opts.dryRun;
  const liveParams = commandParamsRecord(params, dryRun);
  const selectedIds = commandSelectionIds(liveParams);
  const resourceKey =
    asNonEmptyString(liveParams.resource_key ?? liveParams.resourceKey ?? liveParams.resource) ??
    asNonEmptyString(commandKey.split('.')[0]) ??
    '';
  const selectionCount =
    typeof liveParams.selection_count === 'number' && Number.isFinite(liveParams.selection_count)
      ? liveParams.selection_count
      : selectedIds.length;
  const selectionId =
    asNonEmptyString(liveParams.selection_id ?? liveParams.selected_id) ??
    (selectedIds.length === 1 ? selectedIds[0]! : null);
  const live = await liveRpc<Record<string, unknown>>('ui_execute_command_v1', {
    p_action_key: commandKey,
    p_resource_key: resourceKey,
    p_selection_ids: selectedIds,
    p_selection_id: selectionId,
    p_selection_count: selectionCount,
    p_params: liveParams,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      `Command ${commandKey} returned no backend outcome`,
    );
    const outcomeError = backendOutcomeError(rec, `Command ${commandKey} failed`);
    if (outcomeError) throw outcomeError;
    const evidenceId =
      asNonEmptyString(rec.workflow_run_id) ??
      asNonEmptyString(rec.settings_resolution_id) ??
      asNonEmptyString(rec.correlation_id) ??
      asNonEmptyString(rec.label_job_id) ??
      asNonEmptyString(rec.job_id) ??
      asNonEmptyString(rec.task_id) ??
      asNonEmptyString(rec.event_id);
    if (!evidenceId) {
      throw new Error(`Command ${commandKey} did not return backend execution evidence`);
    }
    await requireCommandReadback(commandKey, rec, dryRun);
    return {
      ...rec,
      ok: true,
      command: String(rec.command ?? rec.action_key ?? commandKey),
      params,
      dry_run: Boolean(rec.dry_run ?? dryRun),
      settings_resolution_id: String(rec.settings_resolution_id ?? ''),
      workflow_run_id: String(rec.workflow_run_id ?? ''),
    };
  }

  await sleep(120);
  return {
    ok: true,
    command: commandKey,
    params,
    dry_run: dryRun,
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
    workflow_run_id: 'wfr_' + Date.now(),
  };
}

async function requireCommandReadback(
  commandKey: string,
  rec: Record<string, unknown>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  if (commandKey !== 'shipments.print_labels') return;

  const labelJobId = asNonEmptyString(rec.label_job_id) ?? asNonEmptyString(rec.job_id);
  if (labelJobId) {
    const job = await ui_get_resource_v1<Record<string, unknown>>('label_jobs', labelJobId);
    if (!job) throw new Error('Command shipments.print_labels backend readback missing label_jobs');
    const jobError = backendReadbackFailureError(job, 'Command shipments.print_labels label job failed');
    if (jobError) throw jobError;
    return;
  }

  const workflowRunId = asNonEmptyString(rec.workflow_run_id);
  if (!workflowRunId) {
    throw new Error('Command shipments.print_labels did not return workflow_run_id or label_job_id');
  }

  const jobs = await ui_list_resource_complete<Record<string, unknown>>('label_jobs', {
    filter: { workflow_run_id: workflowRunId },
    sort: { key: 'created_at', dir: 'desc' },
    page_size: 25,
  });
  const failedJob = jobs.rows.find((job) => backendReadbackFailureError(job, 'Command shipments.print_labels label job failed'));
  if (failedJob) {
    throw backendReadbackFailureError(failedJob, 'Command shipments.print_labels label job failed');
  }

  const run = await ui_get_resource_v1<Record<string, unknown>>('workflow_runs', workflowRunId);
  if (!run) {
    throw new Error('Command shipments.print_labels backend readback missing workflow_runs or label_jobs');
  }
  const runError = backendReadbackFailureError(run, 'Command shipments.print_labels workflow failed');
  if (runError) throw runError;
  if (jobs.rows.length > 0) return;
}

// ----------- Helpers -----------
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// W17-3: pickup seed shapes now mirror canonical RPC projections from
// `supabase/migrations/202603191730_pickup_api_list_rpcs_v1.sql`.
//
// `api.pickup_requests_list_v1` (line 65-98) returns `shipment_id, sender_id,
// client_id, requested_window_start_at, box_count, status, ...`. The seed row
// shape adopts the canonical column names; FE display joins (sender label,
// client label) are deferred to G1 paired registry projection — for the
// synthetic adapter these are surfaced as text identifiers.
export function pickupRequestsSeed(): Record<string, unknown>[] {
  return [
    { id: 'pr_881', shipment_id: 'PR-2026-0481', sender_id: 'Exampleparcel JED Warehouse', client_id: 'Exampleparcel KSA', requested_window_start_at: '2026-04-25T14:00:00Z', box_count: 22, status: 'pending' },
    { id: 'pr_880', shipment_id: 'PR-2026-0480', sender_id: 'Examplemart RUH DC', client_id: 'Examplemart KSA', requested_window_start_at: '2026-04-25T15:30:00Z', box_count: 14, status: 'assigned' },
    { id: 'pr_879', shipment_id: 'PR-2026-0479', sender_id: 'Exampleoutlet Main Branch', client_id: 'Exampleoutlet', requested_window_start_at: '2026-04-25T11:00:00Z', box_count: 8, status: 'completed' },
    { id: 'pr_878', shipment_id: 'PR-2026-0478', sender_id: 'Exampleparcel RUH Warehouse', client_id: 'Exampleparcel KSA', requested_window_start_at: '2026-04-25T16:00:00Z', box_count: 31, status: 'pending' },
  ];
}
// W17-3: `api.pickup_waves_list_v1` (line 215-348) returns `branch_id,
// route_run_id, status, planned_*, driver_user_id, vehicle_id, pickup_wave,
// pickup_assignment, pickup_stop_count, total_box_count, shipments`. The seed
// row shape adopts the canonical column names; the human-readable `wave_id`
// label was dropped (canonical SSOT is route_run_id). FE display joins
// (branch name, driver name) are deferred to G1 paired registry projection.
export function pickupWavesSeed(): Record<string, unknown>[] {
  return [
    { id: 'pwv_221', route_run_id: '00000000-0000-4000-8000-000000000221', branch_id: 'RUH-N', driver_user_id: 'Khalid Al-Otaibi', pickup_stop_count: 4, total_box_count: 67, status: 'in_progress' },
    { id: 'pwv_220', route_run_id: '00000000-0000-4000-8000-000000000220', branch_id: 'RUH-S', driver_user_id: 'Tariq Al-Mutairi', pickup_stop_count: 3, total_box_count: 38, status: 'completed' },
    { id: 'pwv_219', route_run_id: '00000000-0000-4000-8000-000000000219', branch_id: 'JED-N', driver_user_id: '', pickup_stop_count: 5, total_box_count: 88, status: 'planned' },
  ];
}
// W17-3: `api.pickup_failures_list_v1` (line 350-…) returns `shipment_id,
// tracking_number, status, failed_at, failure_reason, failure_action_data,
// followup_tasks, pickup_request`. The seed row shape adopts the canonical
// column names. `retry_strategy` was already dropped in W13-2 (no canonical
// column; resolved via `pickup_policy` ladder).
export function pickupFailuresSeed(): Record<string, unknown>[] {
  return [
    { id: 'pf_71', shipment_id: 'PR-2026-0476', failure_reason: 'Sender not ready', failed_at: '2026-04-25T12:30:00Z' },
    { id: 'pf_70', shipment_id: 'PR-2026-0475', failure_reason: 'Out of zone', failed_at: '2026-04-25T11:15:00Z' },
    { id: 'pf_69', shipment_id: 'PR-2026-0474', failure_reason: 'Driver no-show', failed_at: '2026-04-25T09:00:00Z' },
  ];
}

// ----------- Single export object for modules -----------
export const api = {
  // Identity / scope
  getCurrentUser, getCurrentScope, getCapabilities, hasCapability, setRole,
  listOrganizations,
  // Registries
  getNavigation, getReadRegistry, getCommandRegistry, getSettingsCategories, getLookups, lookupRow, getDevRoles,
  // Generic reads
  ui_list_resource_v1, ui_list_resource_complete, ui_get_resource_v1, ui_resource_metrics_v1,
  ui_get_onboarding_readiness_v1, ui_execute_onboarding_bootstrap_v1, ui_get_shipment_timeline_v1,
  // Dashboard
  dashboardKpis,
  // KPI rollups (Phase F1 / CLAIM-INSIGHTS-REPORTING) — mirrors the canonical
  // public.kpi_definitions + public.kpi_rollups_daily projection.
  compute_kpi_rollup_v1,
  // Settings + ladder
  resolveSettings, resolveMobilePolicy, proposeSettingsChange, applySettingsValue,
  // Access policy (canonical evaluator — mirrors public.resolve_access_control_policy_v1)
  resolve_access_control_policy_v1,
  // Per-capability evaluator (mirrors public.user_capability_eval_v1)
  user_capability_eval_v1,
  // Logs
  listDecisionLog, listResolutionLog, listAuditLog, listUiEventLog, streamEvidence,
  // Tasks
  listTasks, transition_task_v1, resolve_manual_review_task_v1, ui_request_warehouse_scan_correction_v1,
  // Shipments
  ui_create_shipment_v1, shipment_amend_cancel_options_v1, shipment_amend_cancel_v1, ui_execute_shipment_resort_v1, ui_execute_shipment_update_geocode_v1, ui_execute_shipment_batch_operation_v1,
  // Baskets
  ui_update_basket_state_v1, basket_create_v1, basket_update_v1,
  // Route plans/runs
  ui_create_route_plan_v1, ui_solve_route_plan_v1, ui_freeze_route_plan_v1,
  ui_publish_route_plan_v1, ui_route_plan_execution_pack_v1, ui_apply_route_plan_v1, ui_rebalance_route_plan_v1,
  route_plan_validate_constraints_v1,
  ui_execute_route_run_assign_v1, ui_execute_route_stop_reassign_v1,
  ui_confirm_route_run_departure_v1, route_run_scan_out_reconciliation_v1,
  // Pickups
  pickup_requests_list_v1, pickup_waves_list_v1, pickup_failures_list_v1,
  create_pickup_request_v1, create_pickup_wave_v1, assign_pickup_wave_v1,
  // NDR
  ui_execute_dispatch_exception_resolution_v1,
  // Returned to branch
  record_scan_event_v1, return_to_branch_shipments_v1, resolve_ndr_branch_next_action_v1,
  // Warehouse
  create_warehouse_transfer_manifest_v1, warehouse_transfer_execute_v1, transition_warehouse_transfer_v1,
  // Delivery slots
  list_delivery_slots_v1, reserve_delivery_slot_v1,
  // COD / settlements
  compute_cod_payment_collection_summary_v1,
  ui_record_cod_remittance_v1, ui_adjust_cod_collection_v1, ui_reverse_finance_event_v1,
  // Fleet
  create_vehicle_v1, upload_vehicle_document_v1,
  create_driver_v1, upload_driver_document_v1,
  // Labels
  label_designer_get_field_catalog,
  label_designer_get_effective_label_design,
  label_designer_get_effective_label_render_policy,
  label_designer_get_effective_label_print_profile,
  label_designer_get_label_media_catalog,
  ui_label_renderer_readiness_v1,
  ui_record_label_printer_certification_v1,
  label_designer_get_sample_payload,
  label_designer_list_drafts, label_designer_create_draft, label_designer_update_draft, label_designer_archive_draft,
  label_designer_validate_label_design_draft, label_designer_publish_label_design_draft,
  label_designer_list_assets, label_designer_upload_asset, label_designer_delete_asset,
  label_designer_preview_label_design_draft,
  request_label_reprint, resolve_resource_download_url_v1,
  // Mobile
  ui_execute_user_device_revoke_v1,
  // Identity / sessions (Phase E2)
  revoke_session_v1,
  tenant_signup_console_request_v1,
  ui_update_organization_profile_v1, ui_list_tenant_invitable_roles_v1, tenant_user_invite_v1,
  // Plugin
  runPluginTest,
  // INTEGRATIONS P0 (W12-2) — plugin-studio 4-stage authoring loop wired to the
  // `integration-plugin-studio` edge function (parse|infer|preview|save).
  // Backend SSOT: supabase/functions/integration-plugin-studio/index.ts.
  plugin_studio_parse_v1, plugin_studio_infer_v1,
  plugin_studio_preview_v1, plugin_studio_save_v1,
  resource_import_studio_prepare_v1, resource_import_studio_start_v1, resource_import_studio_cancel_v1,
  // Workflows (canonical RPCs only — operator action variants ride through
  // progress_workflow_run's `action` jsonb key; workflow_run_steps + operation_templates
  // are read via the generic ui_list_resource_v1 substrate)
  start_workflow_run, progress_workflow_run, progress_workflow_run_until_wait_v1, progress_workflow_run_base,
  close_workflow_run, ui_create_workflow_schedule_trigger_v1, ui_create_workflow_run_trigger_v1,
  ui_update_workflow_run_trigger_v1, ui_delete_workflow_run_trigger_v1,
  ui_run_workflow_schedule_trigger_v1, ui_repair_workflow_schedule_task_payload_v1,
  // Trace (canonical ui_get_trace_v1 envelope per REAUDIT INSIGHTS §D3)
  ui_get_trace_v1,
  // Planning OS
  listProjectItems, listExecutionCards, listWorkerClaims, getAuthEmailUrlPolicy,
  // Commands
  runCommand,
  // Phase C5 — INTEGRATIONS (sources / rules / mapping / credentials / catalog / inbox)
  ui_upsert_webhook_source_v1, ui_rotate_webhook_source_token_v1, ui_archive_webhook_source_v1,
  ui_upsert_mapping_artifact_v1, ui_delete_mapping_config_v1, ui_upsert_api_gateway_route_mapping_v1, ui_create_mapping_operation_report_v1,
  mapping_config_promote_v1, ui_test_mapping_config_v1,
  ui_upsert_provider_auth_config_v1, ui_bind_provider_account_credential_v1,
  ui_revoke_provider_auth_config_v1, integration_plugin_rotate_credentials_v1,
  ui_execute_provider_circuit_reset_v1,
  ui_execute_provider_circuit_probe_v1,
  integration_plugin_generate_draft_v1, integration_plugin_rollback_v1, plugin_deactivate_v1,
  ui_upsert_logistics_customer_migration_config_v1,
  ui_execute_logistics_customer_migration_v1,
  integration_plugin_export_handoff_v1,
  // W9-2 — plugin lifecycle Submit/Approve/Activate/Set-binding canonical shims
  plugin_submit_v1, plugin_approve_v1, plugin_activate_v1, plugin_set_binding_v1,
  webhook_inbox_replay_v1, ui_retry_webhook_inbox_as_new_intake_v1, webhook_inbox_force_status_v1,
  // Phase C5 — WORKFLOWS (templates / bindings / review)
  ui_create_workflow_template_v1, ui_set_workflow_template_status_v1,
  workflow_template_version_diff_v1, restore_workflow_template_v1,
  ui_create_workflow_template_step_v1, ui_update_workflow_template_step_v1,
  ui_duplicate_workflow_template_step_v1, ui_delete_workflow_template_step_v1,
  register_workflow_binding_v1, simulate_binding_dispatch_v1,
  assign_task_v1, bulk_transition_tasks_v1,
  // Phase B5/C4 — FINANCE
  create_billing_invoice_v1, update_billing_invoice_v1, void_billing_invoice_v1,
  billing_invoice_send_v1, ui_bulk_billing_invoice_send_v1,
  billing_invoice_refund_v1, billing_invoice_mark_paid_v1, cancel_subscription_v1,
  apply_settlement_v1, reject_settlement_v1,
  ui_create_settlement_batch_v1, ui_transition_settlement_batch_v1,
  bank_recon_match_v1, bank_recon_unmatch_v1, ui_record_bank_statement_event_v1,
  ui_create_bank_account_v1,
  dispute_resolve_v1, dispute_reject_v1, ui_bulk_dispute_action_v1,
  dispute_acknowledge_v1, dispute_escalate_v1,
  // Phase B5 — INSIGHTS / api-gateway operational write contract
  // (REAUDIT INSIGHTS §D1, §D2 closure)
  block_api_gateway_source_v1, adjust_api_gateway_rate_limit_v1,
};

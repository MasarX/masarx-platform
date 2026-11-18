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
import { hostedInviteRedirect } from './hosted-redirect';
import { normalizeShipmentTimelineRows, type ShipmentTimelineRow } from './shipment-timeline';
import { isShipmentCreateIntent } from './webhook-intents';
import { coordinatePairFromUnknown } from './geo-coordinates';
import { asNonEmptyString, type ResourceRow } from './data-source/shared';
import {
  API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_INTERVAL_MS,
  API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_TIMEOUT_MS,
  API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE,
  API_GATEWAY_EDGE_INVOKE_TIMEOUT_MS,
  API_GATEWAY_REQUEST_READBACK_AFTER_INVOKE_TIMEOUT_MS,
  API_GATEWAY_REQUEST_READBACK_INTERVAL_MS,
  API_GATEWAY_REQUEST_READBACK_TIMEOUT_MS,
  API_GATEWAY_TERMINAL_SETTLE_AFTER_FIRST_READBACK_MS,
  WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS,
  WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS,
  WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS,
  WEBHOOK_RECEIVER_READBACK_AFTER_INVOKE_TIMEOUT_MS,
  WEBHOOK_RECEIVER_READBACK_INTERVAL_MS,
  WEBHOOK_RECEIVER_TERMINAL_READBACK_TIMEOUT_MS,
  apiGatewayAuthRejectionMessage,
  apiGatewayEdgeAuthErrorMessage,
  apiGatewayReadbackOccurredAfter,
  apiGatewayReadbackTerminal,
  assertApiGatewaySelectedSourceMatchesReadback,
  buildApiGatewayRequestResult,
  buildApiGatewaySyntheticResult,
  buildWebhookReceiverTestResult,
  buildWebhookReceiverSyntheticResult,
  findNestedNumber,
  findNestedString,
  normalizeApiGatewayMethod,
  splitApiGatewayPath,
  withApiGatewayInvokeTimeout,
  type ApiGatewayInvokeMethod,
  type RunApiGatewayRequestTestArgs,
  type RunApiGatewayRequestTestResult,
  type RunWebhookReceiverTestArgs,
  type RunWebhookReceiverTestResult,
} from './data-source/external-intake-readback';
import {
  projectIntegrationCredentialDirectory as _projectIntegrationCredentialDirectory,
  projectMappingConfigDirectory as _projectMappingConfigDirectory,
  projectWebhookInboxDirectory as _projectWebhookInboxDirectory,
  projectWebhookSourceDirectory as _projectWebhookSourceDirectory,
} from './data-source/integration-directory-projections';
import {
  CAP,
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

const seed: any = seedNamespace;

function liveBackendUnavailableError(adapterName: string): Error {
  return new Error(
    `${adapterName}: VITE_USE_SEED=false disables Console V2 seed fallbacks; configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY so the request reaches the live api-schema backend.`,
  );
}

function assertSeedFallbackAllowed(adapterName: string): void {
  if (!SEED_MODE_ENABLED) {
    throw liveBackendUnavailableError(adapterName);
  }
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

const state: RuntimeState = {
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

const liveMetadataCache: {
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

function _numberFromUnknown(value: unknown): number | null {
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

const RESOURCE_DATA = (): ResourceMap => ({
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
  // Mirrors public.webhook_rules from
  // supabase/migrations/202510110004_webhook_integration.sql:248+.
  // Surfaces the routing rules operator UI under /integrations/rules.
  webhook_rules: seed.webhook_rules,
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

function liveRpcTarget(): LiveRpcTarget | null {
  const client = getSupabaseClient() as unknown as LiveRpcClient | null;
  if (!client) return null;
  return typeof client.schema === 'function' ? client.schema('api') : client;
}

async function liveRpc<T = unknown>(
  rpcName: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null } | null> {
  const target = liveRpcTarget();
  if (!target) {
    assertSeedFallbackAllowed(`RPC ${rpcName}`);
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

function firstRpcRow<T = Record<string, unknown>>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] ?? null) as T | null;
  if (data && typeof data === 'object') return data as T;
  return null;
}

function isRouteStopCloseoutTransition(toStatus: string, payload: Record<string, unknown>): boolean {
  if (toStatus.trim().toLowerCase() !== 'completed') return false;
  return Boolean(payload.delivery_completion || payload.route_stop_completion);
}

async function finalizeRouteStopCloseoutEvent(taskEventId: string): Promise<void> {
  const result = await liveRpc('ui_finalize_route_stop_closeout_event_v1', {
    p_task_event_id: taskEventId,
  });
  const row = firstRpcRow<Record<string, unknown>>(result?.data);
  if (!row?.shipment_action_id) {
    throw new Error('route-stop closeout shipment_action readback unavailable');
  }
}

function normalizeLiveListResult<T = ResourceRow>(
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

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
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

function objectRecord(value: unknown): Record<string, unknown> {
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

async function loadLiveWorkflowTemplateId(templateKey: string): Promise<string | null> {
  const live = await ui_list_resource_v1<Record<string, unknown>>('workflow_templates', {
    filter: { template_key: templateKey, status: 'active' },
    page_size: 1,
  });
  const row = live.rows[0];
  const id = row?.id ?? row?.workflow_template_id ?? null;
  return typeof id === 'string' && id ? id : null;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function nestedScopeId(input: Record<string, unknown>, key: string): string | null {
  const direct = input[key];
  if (typeof direct === 'string') return direct || null;
  if (direct && typeof direct === 'object') {
    const id = (direct as Record<string, unknown>).id;
    return typeof id === 'string' && id ? id : null;
  }
  return null;
}

function normalizePolicyContext(scopeContext: Record<string, unknown> = state.scope): Record<string, unknown> {
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

function normalizeSettingsScope(scope: unknown): { scope_type: string; scope_id: string | null } {
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

async function getLiveShipmentClientId(shipmentId?: string | null): Promise<string | null> {
  if (!shipmentId) return null;
  const live = await liveRpc<Record<string, unknown> | null>('ui_get_resource_v1', {
    p_resource: 'shipments',
    p_id: shipmentId,
  });
  const row = live ? firstRpcRow<Record<string, unknown>>(live.data) : null;
  return (row?.client_id as string | undefined) ?? null;
}

function normalizeDeliverySlotWindow(row: Record<string, unknown>): DeliverySlotWindow {
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
    p_resource: key,
    p_filters: opts.filter ?? {},
    p_limit: page_size,
    p_offset: page * page_size,
    p_sort: liveSort(opts.sort),
  });
  if (live) {
    return normalizeLiveListResult<T>(live.data, page, page_size);
  }

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
    p_resource: key,
    p_id: id,
  });
  if (live) {
    return firstRpcRow<T>(live.data);
  }

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
    p_resource: key,
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
  const live = await liveRpc('ui_list_resource_v1', {
    p_resource: 'kpi_rollup_directory',
    p_filters: {},
    p_limit: 12,
    p_offset: 0,
    p_sort: { key: 'rank', direction: 'asc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 12).rows.map((row) => ({
      label: String(row.label ?? row.name ?? row.group_label ?? row.kpi_key ?? row.key ?? 'KPI'),
      key: String(row.kpi_key ?? row.key ?? row.id ?? ''),
      value: (row.display_value ?? row.value ?? row.value_num ?? row.numerator ?? 0) as number | string,
      delta: row.delta == null ? undefined : String(row.delta),
      tone: row.tone == null ? undefined : String(row.tone),
      spark: Array.isArray(row.spark) ? (row.spark as number[]) : undefined,
    }));
  }

  await sleep(20);
  const runs = seed.route_runs as Array<{ status: string; stops: number; risk?: boolean }>;
  const tasks = seed.tasks as Array<{ task_type: string; status: string }>;
  return [
    {
      label: 'Active runs',
      key: 'active_runs',
      value: runs.filter((r) => r.status !== 'completed' && r.status !== 'cancelled').length,
      delta: '+12 vs avg',
      tone: 'neutral',
      spark: [4, 8, 6, 9, 12, 11, 14],
    },
    {
      label: 'Stops in flight',
      key: 'stops',
      value: runs.reduce((s, r) => s + r.stops, 0),
      delta: '94% on-time',
      tone: 'good',
      spark: [22, 28, 30, 27, 35, 32, 38],
    },
    {
      label: 'At-risk SLA',
      key: 'at_risk',
      value:
        runs.filter((r) => r.risk).length +
        tasks.filter((t) => t.task_type === 'dispatch_exception_review' && t.status === 'open').length,
      delta: '↑ in last 15m',
      tone: 'warn',
      spark: [2, 1, 3, 4, 3, 5, 6],
    },
    { label: 'Failed attempts', key: 'failed', value: 14, delta: 'NDR queue · 6', tone: 'danger', spark: [1, 0, 2, 1, 2, 3, 1] },
    { label: 'Unassigned', key: 'unassigned', value: 23, delta: '4 partner-eligible', tone: 'info', spark: [5, 4, 6, 5, 7, 6, 8] },
    { label: 'Avg solve', key: 'avg_solve', value: '1.4s', delta: 'p95 · 3.8s', tone: 'neutral', spark: [1.2, 1.4, 1.3, 1.5, 1.2, 1.4, 1.4] },
  ];
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

function _resolveKpiTone(
  defn: Record<string, unknown> | undefined,
  value: number | null,
): KpiRollupResolution['tone'] {
  if (value === null || value === undefined) return 'neutral';
  const block = (defn?.tone_thresholds as Record<string, unknown> | undefined) ?? undefined;
  const fallback = (defn?.tone as KpiRollupResolution['tone'] | undefined) ?? 'neutral';
  if (!block) return fallback;
  const ga = typeof block.good_at_or_above === 'number' ? (block.good_at_or_above as number) : null;
  const wb = typeof block.warn_below === 'number' ? (block.warn_below as number) : null;
  const gb = typeof block.good_at_or_below === 'number' ? (block.good_at_or_below as number) : null;
  const wa = typeof block.warn_above === 'number' ? (block.warn_above as number) : null;
  const da = typeof block.danger_above === 'number' ? (block.danger_above as number) : null;
  // Higher-is-better
  if (ga !== null) {
    if (value >= ga) return 'good';
    if (wb !== null && value < wb) return 'danger';
    return 'warn';
  }
  // Lower-is-better
  if (gb !== null) {
    if (value <= gb) return 'good';
    if (da !== null && value > da) return 'danger';
    if (wa !== null && value > wa) return 'warn';
  }
  return fallback;
}

function _resolveKpiDelta(
  rollupMeta: Record<string, unknown> | undefined,
  defnMeta: Record<string, unknown> | undefined,
  todayValue: number | null,
  prevValue: number | null,
  format: string,
): string | null {
  const explicit = (rollupMeta?.delta_text as string | undefined) ?? null;
  if (explicit && explicit.trim()) return explicit;
  const label = (defnMeta?.delta_label as string | undefined) ?? '';
  if (todayValue === null || prevValue === null) return label || null;
  const diff = todayValue - prevValue;
  if (Math.abs(diff) < 0.0001) return label || null;
  const sign = diff > 0 ? '+' : '−';
  const abs = Math.abs(diff);
  let formatted: string;
  if (format === 'percent') formatted = `${sign}${abs.toFixed(1)} pts`;
  else if (format === 'duration_minutes') formatted = `${sign}${abs.toFixed(0)}m`;
  else if (format === 'duration_seconds') formatted = `${sign}${abs.toFixed(1)}s`;
  else formatted = `${sign}${Math.round(abs)}`;
  return label ? `${formatted} · ${label}` : formatted;
}

export async function compute_kpi_rollup_v1(
  args: ComputeKpiRollupArgs,
): Promise<KpiRollupResolution> {
  const client = getSupabaseClient();
  if (client) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `compute_kpi_rollup_v2` (migration 202605020200_w44_rpc_v2_normalizations.sql).
    // Envelope: { ok, rows: [<row>] } where each row matches the *_v1 RETURNS
    // TABLE shape. The exported adapter signature is unchanged.
    const { data, error } = await client.rpc('compute_kpi_rollup_v2', {
      p_args: {
        definition_key: args.definition_key,
        day: args.day ?? null,
        window_days: args.window_days ?? 1,
        scope_organization_id:
          args.scope?.organization_id ?? state.user.organization_id ?? null,
      },
    });
    if (error) {
      // Tolerate the canonical RPC not yet existing — fall through to the
      // direct-read path below so the surface remains functional during the
      // backend rollout window.
      if (!/function|not found|undefined|does not exist/i.test(error.message)) {
        throw new Error(error.message);
      }
    } else if (data) {
      const envelope = data as { ok?: boolean; rows?: unknown[] };
      const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
      const row = rows[0];
      if (row) return row as KpiRollupResolution;
    }
  }
  await sleep(20);

  const orgId = args.scope?.organization_id ?? state.user.organization_id ?? null;
  const defs = (RESOURCE_DATA().kpi_definitions ?? []) as Array<{
    key: string;
    organization_id: string;
    name: string;
    unit: string | null;
    definition: Record<string, unknown>;
  }>;
  const rolls = (RESOURCE_DATA().kpi_rollups_daily ?? []) as Array<{
    organization_id: string;
    kpi_key: string;
    day: string;
    value_num: number | null;
    numerator: number | null;
    denominator: number | null;
    metadata: Record<string, unknown>;
  }>;

  const def = defs.find(
    (d) => d.key === args.definition_key && (orgId === null || d.organization_id === orgId),
  );
  if (!def) {
    throw new Error(`kpi_definition_not_found:${args.definition_key}`);
  }
  const matching = rolls
    .filter(
      (r) =>
        r.kpi_key === args.definition_key &&
        (orgId === null || r.organization_id === orgId),
    )
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const target = args.day
    ? (matching.find((r) => r.day === args.day) ?? matching[0] ?? null)
    : (matching[0] ?? null);
  const previous = (matching[1] ?? null) as
    | { value_num: number | null; numerator: number | null; denominator: number | null; day: string }
    | null;

  const definition = (def.definition ?? {}) as Record<string, unknown>;
  const format = (definition.format as string | undefined) ?? 'integer';
  const groupKey = (definition.group as string | undefined) ?? 'general';

  const tone = _resolveKpiTone(definition, target?.value_num ?? null);
  const delta = _resolveKpiDelta(
    target?.metadata,
    definition,
    target?.value_num ?? null,
    previous?.value_num ?? null,
    format,
  );

  return {
    kpi_key: def.key,
    label: def.name,
    group: groupKey,
    value_num: target?.value_num ?? null,
    numerator: target?.numerator ?? null,
    denominator: target?.denominator ?? null,
    format,
    unit: def.unit ?? null,
    tone,
    delta,
    day: target?.day ?? null,
    scope_organization_id: orgId,
    settings_resolution_id: `srlv_kpi_${def.key}`,
  };
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
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.rpc('compute_bank_account_balance_v1', {
      p_args: { bank_account_id: args.bank_account_id },
    });
    if (error) throw new Error(error.message);
    if (data) return data as BankAccountBalanceResult;
  }
  await sleep(20);

  // Fallback: project from seed bank_accounts + finance_events_bank_statement
  // + bank_recon_matches. Mirrors the SQL contract in
  // 202604301110_compute_bank_account_balance_v1.sql:99-134.
  const accounts = (RESOURCE_DATA().bank_accounts ?? []) as Array<{
    id: string;
    organization_id?: string;
    currency?: string;
    balance?: number;
    last_match_at?: string | null;
    open_items?: number;
  }>;
  const account = accounts.find((a) => a.id === args.bank_account_id);
  if (!account) {
    throw new Error(`bank_account_not_found:${args.bank_account_id}`);
  }
  const statements = (RESOURCE_DATA().finance_events_bank_statement ?? []) as Array<{
    id: string;
    account_id?: string;
    direction?: 'in' | 'out';
    amount?: number;
    occurred_at?: string;
    attached?: boolean;
  }>;
  const matches = (RESOURCE_DATA().bank_recon_matches ?? []) as Array<{
    id: string;
    bank_statement_event_id?: string;
    status?: 'matched' | 'unmatched';
    updated_at?: string;
  }>;

  // Ledger-derived balance: sum(in) - sum(out) over this account's bank-statement events.
  const accountStatements = statements.filter((s) => s.account_id === args.bank_account_id);
  let derivedBalance = 0;
  for (const s of accountStatements) {
    const amt = typeof s.amount === 'number' ? s.amount : 0;
    if (s.direction === 'in') derivedBalance += amt;
    else if (s.direction === 'out') derivedBalance -= amt;
  }

  // Open items: bank_statement events without an active matched row.
  const matchedStatementIds = new Set(
    matches
      .filter((m) => m.status === 'matched' && m.bank_statement_event_id)
      .map((m) => m.bank_statement_event_id as string),
  );
  const derivedOpenItems = accountStatements.filter(
    (s) => !matchedStatementIds.has(s.id) && s.attached !== true,
  ).length;

  // Last match: MAX(updated_at) of matched matches whose statement event belongs to this account.
  const accountStatementIds = new Set(accountStatements.map((s) => s.id));
  let derivedLastMatchAt: string | null = null;
  for (const m of matches) {
    if (m.status !== 'matched') continue;
    if (!m.bank_statement_event_id || !accountStatementIds.has(m.bank_statement_event_id)) continue;
    const updated = m.updated_at ?? null;
    if (!updated) continue;
    if (derivedLastMatchAt === null || updated > derivedLastMatchAt) derivedLastMatchAt = updated;
  }

  // Tolerate empty-ledger demo seeds: prefer derived values when the seed
  // produced any bank-statement events for this account; otherwise fall back
  // to the seed's pre-computed snapshot (so demo cards keep showing data).
  const hasLedgerActivity = accountStatements.length > 0 || matches.length > 0;
  return {
    ok: true,
    bank_account_id: args.bank_account_id,
    organization_id: account.organization_id ?? state.user.organization_id ?? null,
    currency: account.currency ?? null,
    balance: hasLedgerActivity ? derivedBalance : (account.balance ?? 0),
    last_match_at: derivedLastMatchAt ?? account.last_match_at ?? null,
    open_items: hasLedgerActivity ? derivedOpenItems : (account.open_items ?? 0),
    correlation_id: `cor_demo_${args.bank_account_id}`,
    settings_resolution_id: `srlv_demo_${args.bank_account_id}`,
  };
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

function mobilePolicyResolverName(category: string): string {
  if (!/^[a-z][a-z0-9_]*_policy$/.test(category)) {
    throw new Error(`Invalid mobile policy category: ${category}`);
  }
  return `resolve_${category}`;
}

function mobilePolicyResolutionFromRow(
  category: string,
  resolver: string,
  row: Record<string, unknown>,
): MobilePolicyResolutionResult {
  const scopePath = Array.isArray(row.scope_path) ? (row.scope_path as Array<Record<string, unknown>>) : [];
  const resolvedFrom = String(row.scope_type ?? 'global');
  const resolvedScopeId = (row.scope_id as string | null | undefined) ?? null;
  const ladderPath = scopePath.length > 0
    ? scopePath.map((step, index) => {
        const scopeType = String(step.scope_type ?? '');
        const scopeId = (step.scope_id as string | null | undefined) ?? null;
        const isWinner = scopeType === resolvedFrom && (scopeId ?? null) === (resolvedScopeId ?? null);
        return {
          rank: typeof step.rank === 'number' ? step.rank : index,
          scope_type: scopeType,
          scope_id: scopeId,
          has_value: isWinner,
          value: isWinner ? row.value : null,
        };
      })
    : [{
        rank: 0,
        scope_type: resolvedFrom,
        scope_id: resolvedScopeId,
        has_value: true,
        value: row.value,
      }];

  return {
    category,
    value: row.value,
    resolved_from: resolvedFrom,
    ladder_path: ladderPath,
    settings_resolution_id: String(row.settings_resolution_id ?? row.settings_version_id ?? row.settings_id ?? ''),
    override_of: null,
    resolver,
  };
}

export async function resolveSettings(
  category: string,
  scopeContext: Record<string, unknown> = state.scope,
): Promise<SettingsResolutionResult> {
  const live = await liveRpc<unknown>('resolve_settings_row_from_policy_context_v1', {
    p_category: category,
    p_context: normalizePolicyContext(scopeContext),
  });
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data);
    if (!row) throw new Error(`resolve_settings_row_from_policy_context_v1 returned no row for ${category}`);
    const scopePath = Array.isArray(row.scope_path) ? (row.scope_path as Array<Record<string, unknown>>) : [];
    const resolvedFrom = String(row.scope_type ?? 'global');
    const resolvedScopeId = (row.scope_id as string | null | undefined) ?? null;
    return {
      value: row.value,
      resolved_from: resolvedFrom,
      ladder_path: scopePath.map((step, index) => {
        const scopeType = String(step.scope_type ?? '');
        const scopeId = (step.scope_id as string | null | undefined) ?? null;
        const isWinner = scopeType === resolvedFrom && (scopeId ?? null) === (resolvedScopeId ?? null);
        return {
          rank: index,
          scope_type: scopeType,
          scope_id: scopeId,
          has_value: isWinner,
          version: isWinner ? row.version : undefined,
          value: isWinner ? row.value : undefined,
        };
      }),
      settings_resolution_id: String(row.settings_resolution_id ?? row.settings_version_id ?? row.settings_id ?? ''),
      override_of: null,
    };
  }

  await sleep(30);
  // AGENTS.md §3 (ROW-DRIVEN) + §4 (SSOT): derive the ladder ordering from
  // the canonical `scope_type_registry` rows (sorted by `ladder_rank`)
  // instead of an inline literal tuple. Adding a new tier or re-ranking is
  // a row mutation; the FE picks it up without source change.
  type ScopeRegistryRow = {
    scope_type: string;
    ladder_rank: number;
    is_enabled: boolean;
  };
  const scopeRegistry = (seed.scope_type_registry as ScopeRegistryRow[]) ?? [];
  const enabledScopes = scopeRegistry
    .filter((r) => r.is_enabled !== false)
    .slice()
    .sort((a, b) => a.ladder_rank - b.ladder_rank);
  // Highest specificity first (descending ladder_rank) so we pick the most
  // specific override before falling through to less specific scopes.
  const ranksDesc = enabledScopes.slice().reverse();

  const path: SettingsResolutionResult['ladder_path'] = [];
  let winning: { scope_type: string; scope_id: string | null; version: unknown; value: unknown; ladder_rank: number } | null = null;
  const settingsVersions = seed.settings_versions as Array<{
    category: string;
    scope_type: string;
    scope_id: string;
    status: string;
    version: unknown;
    value: unknown;
  }>;

  for (let i = 0; i < enabledScopes.length; i++) {
    // Walk LSB-first (global → tenant → ...) for path order; reverse for
    // pick-most-specific-first uses below.
    const reg = enabledScopes[i]!;
    const scopeType = reg.scope_type;
    const scopeIdRaw = (scopeContext as Record<string, { id?: string } | undefined>)[scopeType]?.id ?? (scopeType === 'global' ? 'global' : null);
    const scopeId: string | null = scopeIdRaw ?? null;
    const row = scopeId
      ? settingsVersions.find(
          (s) => s.category === category && s.scope_type === scopeType && s.scope_id === scopeId && s.status === 'active',
        )
      : null;
    path.push({
      rank: reg.ladder_rank,
      scope_type: scopeType,
      scope_id: scopeId,
      has_value: !!row,
      version: row?.version,
      value: row?.value,
    });
  }

  // Pick winner — most specific (highest ladder_rank) row that has a value.
  for (const reg of ranksDesc) {
    const entry = path.find((p) => p.scope_type === reg.scope_type);
    if (entry?.has_value) {
      winning = {
        scope_type: reg.scope_type,
        scope_id: entry.scope_id,
        version: entry.version,
        value: entry.value,
        ladder_rank: reg.ladder_rank,
      };
      break;
    }
  }

  // override_of: the next-most-specific row that ALSO had a value (the row
  // that the winner overrides).
  let override_of: unknown = null;
  if (winning) {
    const lessSpecific = ranksDesc
      .filter((reg) => reg.ladder_rank < winning!.ladder_rank)
      .map((reg) => path.find((p) => p.scope_type === reg.scope_type))
      .filter((entry): entry is NonNullable<typeof entry> => entry?.has_value === true);
    if (lessSpecific.length > 0) override_of = lessSpecific[0];
  }

  return {
    value: winning?.value,
    resolved_from: winning?.scope_type ?? 'global',
    ladder_path: path,
    settings_resolution_id: `srlv_${Math.floor(Math.random() * 9000) + 1000}`,
    override_of,
  };
}

// Mobile policies share the canonical ladder shape with `resolveSettings` so
// the same `LadderViz` primitive can render them. Live mode calls the
// category-specific api-schema resolver (`resolve_<category>`). Seed mode keeps
// the local `mobile_policy_resolved` snapshot as the fallback.
export async function resolveMobilePolicy(
  category: string,
  scopeContext: Record<string, unknown> = state.scope,
): Promise<MobilePolicyResolutionResult | null> {
  const resolver = mobilePolicyResolverName(category);
  const live = await liveRpc<unknown>(resolver, {
    p_context: normalizePolicyContext(scopeContext),
  });
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data);
    return row ? mobilePolicyResolutionFromRow(category, resolver, row) : null;
  }

  await sleep(20);
  const resolvedSeed = (seed.mobile_policy_resolved?.[category] as Record<string, unknown> | undefined) ?? null;
  if (resolvedSeed == null) return null;
  const value = resolvedSeed.value ?? resolvedSeed;
  const seedResolvedFrom = typeof resolvedSeed.resolved_from === 'string'
    ? resolvedSeed.resolved_from
    : null;
  // Walk the canonical ladder for visualization. Seed snapshots store the
  // winning value only, so non-winning steps intentionally render as inherited.
  const reg = (seed.settings_category_registry as Array<{ category: string; scopes?: string[] }>).
    find((c) => c.category === category);
  const allowedScopes = (reg?.scopes ?? ['global', 'tenant']) as string[];
  const scopeRanks: Record<string, number> = { global: 0, tenant: 1, client: 2, sender: 3, source: 4, resource: 5 };
  const winningScope = seedResolvedFrom ?? 'global';
  const ladder_path = allowedScopes.map((scopeType) => {
    const scopeId = scopeType === 'global'
      ? 'global'
      : ((scopeContext as Record<string, { id?: string } | undefined>)[scopeType]?.id ?? null);
    const isWinning = scopeType === winningScope;
    return {
      rank: scopeRanks[scopeType] ?? 99,
      scope_type: scopeType,
      scope_id: scopeId,
      has_value: isWinning,
      value: isWinning ? value : null,
    };
  });
  // override_of: the next-lower-rank scope below winning that also "had" a value
  // (always null in synthetic mode — production will compute correctly).
  return {
    category,
    value,
    resolved_from: winningScope,
    ladder_path,
    settings_resolution_id: String(resolvedSeed.settings_resolution_id ?? resolvedSeed.srlv ?? `srlv_${Math.floor(Math.random() * 9000) + 1000}`),
    override_of: typeof resolvedSeed.overrides === 'string' ? resolvedSeed.overrides : null,
    resolver,
  };
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
  const live = await liveRpc<AccessPolicyResolutionResult & { ok?: boolean }>('resolve_access_control_policy_v2', {
    p_args: {
      scope_type: args.scope_type ?? null,
      scope_id: args.scope_id ?? null,
    },
  });
  if (live) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `resolve_access_control_policy_v2` (migration
    // 202605020200_w44_rpc_v2_normalizations.sql). Envelope:
    // { ok, policy, settings_id, settings_version_id, scope_type, scope_id,
    //   scope_path, settings_resolution_id }. The exported adapter signature
    // is unchanged.
    const envelope = (live.data ?? null) as
      | (AccessPolicyResolutionResult & { ok?: boolean })
      | null;
    if (!envelope || envelope.settings_id == null) {
      throw new Error('resolve_access_control_policy_v1 returned no rows');
    }
    return {
      policy: envelope.policy,
      settings_id: envelope.settings_id,
      settings_version_id: envelope.settings_version_id,
      scope_type: envelope.scope_type,
      scope_id: envelope.scope_id,
      scope_path: envelope.scope_path,
      settings_resolution_id: envelope.settings_resolution_id,
    };
  }

  await sleep(30);

  // Resolve effective scope: caller-provided -> user's access_scope -> 'global'.
  const effectiveScopeType =
    args.scope_type ??
    (state.user.access_scope_type === 'platform' ? 'global' : state.user.access_scope_type) ??
    'global';
  const effectiveScopeId = args.scope_id ?? state.user.access_scope_id ?? null;

  // Synthesize ladder scope_path from current scope context (matches the
  // backend `resolve_scope_path_v1` shape: ordered ancestor walk
  // most-specific -> root). We mirror the JSONB array contract verbatim.
  const scope_path: Array<{ scope_type: string; scope_id: string | null }> = [];
  if (effectiveScopeType === 'global') {
    scope_path.push({ scope_type: 'global', scope_id: null });
  } else {
    const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
    const ladderOrder: string[] = ['tenant', 'client', 'sender', 'source', 'resource'];
    const includeUpTo = ladderOrder.indexOf(effectiveScopeType);
    if (includeUpTo >= 0) {
      // Most-specific-first walk down to root for canonical scope_path order.
      for (let i = includeUpTo; i >= 0; i--) {
        const key = ladderOrder[i] as string;
        const id = key === effectiveScopeType ? effectiveScopeId : (scopeCtx[key]?.id ?? null);
        scope_path.push({ scope_type: key, scope_id: id });
      }
    } else {
      scope_path.push({ scope_type: effectiveScopeType, scope_id: effectiveScopeId });
    }
    // Always include 'global' as the root.
    scope_path.push({ scope_type: 'global', scope_id: null });
  }

  // Build a representative `policy` JSONB body that mirrors the canonical
  // access_control_policy seed shape (capabilities catalog + roles +
  // resource_map). The capability catalog comes from registry.capabilities
  // (re-exported through seed.js) which is itself pinned to the backend SSOT
  // in 202601022113_access_control_policy_core.sql.
  const seedCapabilities = (seed.capabilities ?? []) as string[];
  const capabilities = seedCapabilities.map((key) => ({ key, label: key }));
  const devRoles = (seed.dev_roles ?? []) as Array<{ id: string; label: string; capabilities: string[] | string }>;
  const roles = devRoles.map((r) => ({
    key: r.id,
    label: r.label,
    capability_keys:
      typeof r.capabilities === 'string' && isWildcardCapability(r.capabilities)
        ? ['*']
        : Array.isArray(r.capabilities)
          ? r.capabilities
          : [r.capabilities],
  }));
  const readRegistry = (seed.ui_read_registry ?? {}) as Record<
    string,
    { capability_read?: string; capability_write?: string }
  >;
  const resource_map: Record<string, { read?: string; write?: string }> = {};
  for (const [resourceKey, def] of Object.entries(readRegistry)) {
    const r = def?.capability_read;
    const w = def?.capability_write;
    if (r || w) {
      resource_map[resourceKey] = {
        ...(r ? { read: r } : {}),
        ...(w ? { write: w } : {}),
      };
    }
  }

  const policy = {
    capabilities,
    roles,
    assignments: { user_type: Object.fromEntries(roles.map((r) => [r.key, [r.key]])) },
    resource_map,
    denies: [] as unknown[],
  };

  return {
    policy,
    settings_id: 'set_access_control_policy_demo',
    settings_version_id: 'sv_access_control_policy_demo',
    scope_type: effectiveScopeType,
    scope_id: effectiveScopeId,
    scope_path,
    settings_resolution_id: `srlv_${Math.floor(Math.random() * 9000) + 1000}`,
  };
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
  const rpcName = args.user_id ? 'user_capability_eval_for_user_v1' : 'user_capability_eval_v2';
  const live = await liveRpc<{ ok?: boolean; eval?: UserCapabilityEvalResult } | UserCapabilityEvalResult>(rpcName, {
    p_args: {
      capability_key: args.capability_key,
      scope_type: args.scope_type ?? null,
      scope_id: args.scope_id ?? null,
      target_user_id: args.user_id ?? null,
      user_id: args.user_id ?? null,
    },
  });
  if (live) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `user_capability_eval_v2` (migration
    // 202605020200_w44_rpc_v2_normalizations.sql). Envelope:
    // { ok, eval: <UserCapabilityEvalResult> }. The exported adapter
    // signature is unchanged.
    const envelope = (live.data ?? {}) as { ok?: boolean; eval?: UserCapabilityEvalResult };
    return (envelope.eval ?? (live.data as UserCapabilityEvalResult));
  }

  // Demo synthesis — reuses the in-memory access-control resolver to derive a
  // canonical-shaped envelope. Mirrors the SQL evaluator path:
  //   resolve_access_control_policy_v1 -> access_eval_capability_v1 ->
  //   user_capability_eval_v1.
  await sleep(20);

  const resolution = await resolve_access_control_policy_v1({
    scope_type: args.scope_type,
    scope_id: args.scope_id ?? null,
  });

  // Determine the role keys for the evaluated user. In demo mode we evaluate
  // against the current logged-in user (data-source state) — the production
  // RPC always evaluates for `auth.uid()`. When `user_id` is supplied, we
  // log it but still use the current user's role/cap set since the demo
  // `users` table is single-user.
  const userRole = state.user.role;
  const userCaps = new Set<string>(state.capabilities);

  // `granted_capabilities` mirrors the backend resolver: the union of all
  // capability keys produced by the user's role assignments inside the
  // resolved policy. In demo mode, the in-memory `state.capabilities` is the
  // SSOT for this user × scope.
  const grantedCapabilities = Array.from(userCaps);

  // Wildcard role (`WILDCARD_CAPABILITY` = '*') — backend's `super_admin`
  // analog — short-circuits to allowed. Otherwise check explicit catalog
  // membership.
  const wildcard = hasWildcardCapability(userCaps);
  const allowed = wildcard || userCaps.has(args.capability_key);

  // Reason taxonomy mirrors `access_eval_capability_v1`:
  //   - 'allowed_by_role'        -> capability granted via role assignment
  //   - 'allowed_by_wildcard'    -> role has '*' (super_admin)
  //   - 'denied_no_role_grant'   -> resolved policy has no grant for this cap
  //   - 'unauthenticated'        -> no auth.uid() (not reachable in demo)
  const reason = wildcard
    ? 'allowed_by_wildcard'
    : allowed
      ? 'allowed_by_role'
      : 'denied_no_role_grant';

  return {
    allowed,
    reason,
    capability_key: args.capability_key,
    scope_type: resolution.scope_type,
    scope_id: resolution.scope_id,
    role_keys: [userRole],
    granted_capabilities: grantedCapabilities,
    policy_source: {
      settings_id: resolution.settings_id,
      settings_version_id: resolution.settings_version_id,
      policy_scope_type: resolution.scope_type,
      policy_scope_id: resolution.scope_id,
      scope_path: resolution.scope_path,
    },
  };
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
  const normalizedScope = normalizeSettingsScope(scope);
  const liveTarget = liveRpcTarget();
  if (liveTarget) {
    if (opts.dryRun) {
      const current = await resolveSettings(category, {
        [normalizedScope.scope_type]: normalizedScope.scope_id ? { id: normalizedScope.scope_id } : undefined,
      });
      return {
        diff: { from: 'current', to: value },
        blast_radius:
          normalizedScope.scope_type === 'global'
            ? 'global · all tenants'
            : `${normalizedScope.scope_type} · ${normalizedScope.scope_id ?? 'unscoped'}`,
        approval_required: true,
        settings_resolution_id: current.settings_resolution_id,
        dry_run: true,
        justification: opts.justification ?? null,
      };
    }
    const { data, error } = await liveTarget.rpc('request_settings_change_v1', {
      p_category: category,
      p_scope_type: normalizedScope.scope_type,
      p_scope_id: normalizedScope.scope_id,
      p_value: value,
      p_change_reason: opts.justification ?? 'requested via Console V2',
      p_effective_from: null,
    });
    if (error) throw new Error(error.message);
    const rec = firstRpcRow<Record<string, unknown>>(data) ?? ((data ?? {}) as Record<string, unknown>);
    return {
      diff: { from: 'current', to: value },
      blast_radius:
        normalizedScope.scope_type === 'global'
          ? 'global · all tenants'
          : `${normalizedScope.scope_type} · ${normalizedScope.scope_id ?? 'unscoped'}`,
      approval_required: Boolean(rec.approval_required ?? true),
      settings_resolution_id: String(
        rec.settings_resolution_id ??
          rec.settings_version_id ??
          rec.settings_change_request_id ??
          rec.id ??
          '',
      ),
      dry_run: false,
      justification: opts.justification ?? null,
    };
  }

  await sleep(80);
  const seedScope = normalizeSettingsScope(scope);
  const reg = (seed.settings_category_registry as Array<{
    category: string;
    scopes?: string[];
    approval_required?: boolean;
  }>).find((c) => c.category === category);
  return {
    diff: { from: 'previous', to: value },
    blast_radius:
      reg?.scopes?.indexOf(seedScope.scope_type) === 0 ? 'global · all tenants' : `${seedScope.scope_type} · ${seedScope.scope_id}`,
    approval_required: !!reg?.approval_required,
    settings_resolution_id: `srlv_${Math.floor(Math.random() * 9000) + 1000}`,
    dry_run: !!opts.dryRun,
    justification: opts.justification ?? null,
  };
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
  const normalizedScope = normalizeSettingsScope(scope);
  const liveTarget = liveRpcTarget();
  if (liveTarget) {
    const { data, error } = await liveTarget.rpc('ui_apply_settings_value_v1', {
      p_category: category,
      p_scope_type: normalizedScope.scope_type,
      p_scope_id: normalizedScope.scope_id,
      p_value: value,
      p_change_reason: opts.justification ?? 'applied via Console V2',
    });
    if (error) throw new Error(error.message);
    const rec = firstRpcRow<Record<string, unknown>>(data) ?? ((data ?? {}) as Record<string, unknown>);
    return {
      ok: Boolean(rec.ok ?? true),
      applied: Boolean(rec.applied ?? true),
      category: String(rec.category ?? category),
      scope_type: String(rec.scope_type ?? normalizedScope.scope_type),
      scope_id: (rec.scope_id as string | null | undefined) ?? normalizedScope.scope_id,
      settings_id: rec.settings_id ? String(rec.settings_id) : undefined,
      settings_version_id: String(rec.settings_version_id ?? rec.settings_resolution_id ?? ''),
      settings_version_number:
        typeof rec.settings_version_number === 'number' ? rec.settings_version_number : undefined,
      settings_resolution_id: String(rec.settings_resolution_id ?? rec.settings_version_id ?? ''),
      domain_event_id: rec.domain_event_id ? String(rec.domain_event_id) : undefined,
    };
  }

  await sleep(80);
  const settingsVersions = seed.settings_versions as Array<{
    category: string;
    scope_type: string;
    scope_id: string;
    status: string;
    version: number;
    value: unknown;
  }>;
  for (const row of settingsVersions) {
    if (
      row.category === category &&
      row.scope_type === normalizedScope.scope_type &&
      row.scope_id === (normalizedScope.scope_id ?? 'global') &&
      row.status === 'active'
    ) {
      row.status = 'superseded';
    }
  }
  const version =
    Math.max(
      0,
      ...settingsVersions
        .filter(
          (row) =>
            row.category === category &&
            row.scope_type === normalizedScope.scope_type &&
            row.scope_id === (normalizedScope.scope_id ?? 'global'),
        )
        .map((row) => Number(row.version) || 0),
    ) + 1;
  const settingsVersionId = `sv_apply_${Date.now()}`;
  settingsVersions.push({
    category,
    scope_type: normalizedScope.scope_type,
    scope_id: normalizedScope.scope_id ?? 'global',
    status: 'active',
    version,
    value,
  });
  return {
    ok: true,
    applied: true,
    category,
    scope_type: normalizedScope.scope_type,
    scope_id: normalizedScope.scope_id,
    settings_version_id: settingsVersionId,
    settings_version_number: version,
    settings_resolution_id: settingsVersionId,
  };
}

// ----------- Decision / Resolution / UI Event / Audit -----------
type LogFilter = {
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
  const pageSize = filters.limit ?? 50;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'settings_resolution_log',
    p_filters: filters.category ? { category: filters.category } : {},
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'resolved_at', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows;
  }

  await sleep(30);
  let rows = [...((seed.settings_resolution_log as Record<string, unknown>[]) ?? [])];
  if (filters.category) rows = rows.filter((r) => (r as { category?: string }).category === filters.category);
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
}
export async function listAuditLog(filters: { limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const pageSize = filters.limit ?? 50;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'audit_table_changes',
    p_filters: {},
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'created_at', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows.map((row) => {
      const pk = row.pk;
      return {
        ...row,
        occurred_at: row.occurred_at ?? row.created_at,
        table: row.table ?? row.table_name,
        actor: row.actor ?? row.changed_by,
        pk: pk && typeof pk === 'object' && 'id' in pk ? (pk as { id?: unknown }).id : pk,
      };
    });
  }

  if (!hasCapability(CAP.AUDIT_LOG_READ)) {
    const err = new Error(`Capability denied: ${CAP.AUDIT_LOG_READ}`) as Error & {
      code?: string;
      capability?: string;
    };
    err.code = 'capability_denied';
    err.capability = CAP.AUDIT_LOG_READ;
    throw err;
  }
  await sleep(30);
  let rows = [...((seed.audit_log as Record<string, unknown>[]) ?? [])];
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
}
export async function listUiEventLog(filters: { limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const pageSize = filters.limit ?? 50;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'ui_event_log',
    p_filters: {},
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'created_at', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows;
  }

  await sleep(30);
  let rows = [...((seed.ui_event_log as Record<string, unknown>[]) ?? [])];
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
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

  assertSeedFallbackAllowed('streamEvidence');
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

async function loadLiveDriverHoursOfService(
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
  assertSeedFallbackAllowed('RPC resolve_driver_hours_of_service_v1');
  return map[driver_id] ?? null;
}

export async function read_driver_hours_of_service_v1(
  driver_id: string,
): Promise<DriverHoursOfServiceRecord | null> {
  const map = ((seed as Record<string, unknown>).driver_hours_of_service ?? {}) as Record<
    string,
    DriverHoursOfServiceRecord | undefined
  >;
  if (getSupabaseClient()) {
    const live = await loadLiveDriverHoursOfService(driver_id);
    liveMetadataCache.driverHoursOfService[driver_id] = live;
    return SEED_MODE_ENABLED ? live ?? map[driver_id] ?? null : live;
  }
  assertSeedFallbackAllowed('RPC resolve_driver_hours_of_service_v1');
  const value = map[driver_id] ?? null;
  liveMetadataCache.driverHoursOfService[driver_id] = value;
  return value;
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
type TaskFilter = { task_type?: string; assigned_to?: string; at_risk?: boolean };

function normalizeTaskListRow(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = objectRecord(row.metadata) ?? {};
  const id = asNonEmptyString(row.id);
  const taskType =
    asNonEmptyString(row.task_type) ??
    asNonEmptyString(row.task_type_key) ??
    asNonEmptyString(metadata.task_type_key) ??
    asNonEmptyString(metadata.task_type);
  const queue =
    asNonEmptyString(row.queue) ??
    asNonEmptyString(row.queue_key) ??
    asNonEmptyString(metadata.queue_key) ??
    asNonEmptyString(metadata.queue);
  const subject =
    asNonEmptyString(row.subject) ??
    asNonEmptyString(metadata.subject) ??
    asNonEmptyString(metadata.title);
  const description =
    asNonEmptyString(row.description) ??
    asNonEmptyString(metadata.description);
  const resourceType = asNonEmptyString(row.resource_type) ?? asNonEmptyString(metadata.resource_type);
  const resourceId = asNonEmptyString(row.resource_id) ?? asNonEmptyString(metadata.resource_id);
  const shipmentId =
    asNonEmptyString(row.shipment_id) ??
    asNonEmptyString(metadata.shipment_id) ??
    (resourceType === 'shipment' ? resourceId : null);
  const allowedActionsRaw = row.allowed_actions ?? metadata.allowed_actions ?? metadata.allowed_ndr_actions;
  const allowedActions = Array.isArray(allowedActionsRaw)
    ? allowedActionsRaw.map((action) => asNonEmptyString(action)).filter((action): action is string => !!action)
    : null;

  const normalized: Record<string, unknown> = { ...row };
  const taskId = asNonEmptyString(row.task_id) ?? asNonEmptyString(metadata.task_id) ?? (id ? `TSK-${id.slice(0, 8).toUpperCase()}` : null);
  if (taskId) normalized.task_id = taskId;
  if (taskType) {
    normalized.task_type = taskType;
    normalized.task_type_key = asNonEmptyString(row.task_type_key) ?? taskType;
  }
  if (queue) {
    normalized.queue = queue;
    normalized.queue_key = asNonEmptyString(row.queue_key) ?? queue;
  }
  if (subject) normalized.subject = subject;
  if (description) normalized.description = description;
  if (shipmentId) normalized.shipment_id = shipmentId;
  if (allowedActions) normalized.allowed_actions = allowedActions;
  if (row.evidence_required == null && typeof metadata.evidence_required === 'boolean') {
    normalized.evidence_required = metadata.evidence_required;
  }
  return normalized;
}

export async function listTasks(filters: TaskFilter = {}): Promise<Record<string, unknown>[]> {
  const target = liveRpcTarget();
  if (target) {
    const p_filters = compactRecord({
      task_type_key: filters.task_type,
      assigned_to: filters.assigned_to,
    });
    const result = await ui_list_resource_complete<Record<string, unknown>>('tasks', {
      filter: p_filters,
      sort: { key: 'created_at', dir: 'desc' },
    });
    let rows = result.rows.map(normalizeTaskListRow);
    if (filters.at_risk) {
      rows = rows.filter((r) => new Date((r as { sla_due_at?: string }).sla_due_at ?? 0).getTime() < Date.now());
    }
    return rows;
  }

  await sleep(30);
  let rows = [...((seed.tasks as Record<string, unknown>[]) ?? [])];
  if (filters.task_type) rows = rows.filter((r) => (r as { task_type?: string }).task_type === filters.task_type);
  if (filters.assigned_to) rows = rows.filter((r) => (r as { assigned_to?: string }).assigned_to === filters.assigned_to);
  if (filters.at_risk)
    rows = rows.filter((r) => new Date((r as { sla_due_at?: string }).sla_due_at ?? 0).getTime() < Date.now());
  return rows.map(normalizeTaskListRow);
}
export async function transition_task_v1(
  taskId: string,
  transition: { next_status?: string; payload?: Record<string, unknown>; [k: string]: unknown },
): Promise<{ ok: true; task: Record<string, unknown> | undefined; task_event_id?: string | null }> {
  const target = liveRpcTarget();
  if (target) {
    const toStatus = String(transition.next_status ?? transition.to_status ?? 'completed');
    const payload = (transition.payload && typeof transition.payload === 'object')
      ? transition.payload
      : {};
    const { data, error } = await target.rpc('transition_task_v1', {
      p_task_id: taskId,
      p_to_status: toStatus,
      p_status_reason: transition.status_reason ?? null,
      p_payload: payload,
      p_idempotency_key: transition.idempotency_key ?? null,
    });
    if (error) throw new Error(error.message);
    requireLiveMutationResult(data, 'transition_task_v1', ['task_id', 'id', 'task_event_id']);
    const taskEventId = asNonEmptyString(firstRpcRow<Record<string, unknown>>(data)?.task_event_id);
    if (taskEventId && isRouteStopCloseoutTransition(toStatus, payload)) {
      await finalizeRouteStopCloseoutEvent(taskEventId);
    }
    await requireLiveTaskEventReadback('transition_task_v1', taskId, taskEventId);
    const task = await ui_get_resource_v1<Record<string, unknown>>('tasks', taskId);
    if (!task) throw new Error('transition_task_v1 backend readback missing tasks');
    const taskStatus = String(task.status ?? '').trim().toLowerCase();
    const expectedStatus = toStatus.trim().toLowerCase();
    const statusMatches = taskStatus === expectedStatus;
    if (!statusMatches) {
      throw new Error(`transition_task_v1 backend readback status mismatch: expected ${expectedStatus}, got ${taskStatus || 'missing'}`);
    }
    return { ok: true, task: normalizeTaskListRow(task), task_event_id: taskEventId };
  }

  assertSeedFallbackAllowed('transition_task_v1');
  await sleep(80);
  const tasks = seed.tasks as Array<Record<string, unknown> & { id: string; status: string }>;
  const task = tasks.find((t) => t.id === taskId);
  let taskEventId: string | null = null;
  if (task) {
    const previousStatus = task.status;
    const toStatus = transition.next_status || String(transition.to_status ?? 'completed');
    task.status = toStatus;
    // Persist arbitrary payload fields (e.g. snooze_until ISO) so callers
    // can verify the seam received the row-driven payload, mirroring how
    // `transition_task_v1` would land columns/JSON on the real task row.
    const payload = transition.payload;
    if (payload && typeof payload === 'object') {
      for (const [k, v] of Object.entries(payload)) {
        (task as Record<string, unknown>)[k] = v;
      }
    }
    taskEventId = `tev_transition_${taskId}_${Date.now()}`;
    const taskEvents = seed.task_events as Array<Record<string, unknown>> | undefined;
    taskEvents?.push?.({
      id: taskEventId,
      task_id: taskId,
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      event_type: 'status_changed',
      event: 'status_changed',
      actor: state.user.id,
      from_status: previousStatus,
      to_status: toStatus,
      payload: payload ?? {},
      idempotency_key: transition.idempotency_key ?? null,
    });
  }
  return { ok: true, task: task as Record<string, unknown> | undefined, task_event_id: taskEventId };
}

export async function resolve_manual_review_task_v1(
  taskId: string,
  resolution: { resolution_outcome?: string; resolution_notes?: string | null },
): Promise<Record<string, unknown>> {
  const target = liveRpcTarget();
  if (target) {
    const outcome = String(resolution.resolution_outcome ?? 'approved').trim().toLowerCase();
    const { data, error } = await target.rpc('resolve_manual_review_task_v1', {
      p_task_id: taskId,
      p_resolution_outcome: outcome,
      p_resolution_notes: resolution.resolution_notes ?? null,
    });
    if (error) throw new Error(error.message);
    requireLiveMutationResult(data, 'resolve_manual_review_task_v1', ['id', 'status', 'resolution_outcome']);
    const row = await requireLiveResourceReadback(
      'manual_review_tasks',
      taskId,
      'resolve_manual_review_task_v1',
    );
    const status = String(row.status ?? '').trim().toLowerCase();
    const readbackOutcome = String(row.resolution_outcome ?? '').trim().toLowerCase();
    if (status !== 'resolved') {
      throw new Error(`resolve_manual_review_task_v1 backend readback status mismatch: expected resolved, got ${status || 'missing'}`);
    }
    if (readbackOutcome !== outcome) {
      throw new Error(`resolve_manual_review_task_v1 backend readback outcome mismatch: expected ${outcome}, got ${readbackOutcome || 'missing'}`);
    }
    return row;
  }

  assertSeedFallbackAllowed('resolve_manual_review_task_v1');
  await sleep(60);
  const seedRows = (seed as { manual_review_tasks?: Array<Record<string, unknown> & { id: string }> }).manual_review_tasks ?? [];
  const task = seedRows.find((t) => t.id === taskId);
  if (!task) throw new Error(`manual_review_task not found: ${taskId}`);
  task.status = 'resolved';
  task.resolution_outcome = resolution.resolution_outcome ?? 'approved';
  task.resolution_notes = resolution.resolution_notes ?? null;
  task.resolved_at = new Date().toISOString();
  task.updated_at = task.resolved_at;
  return task;
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

async function requireLiveTaskEventReadback(
  rpcName: string,
  taskId: string,
  taskEventId?: string | null,
): Promise<void> {
  const normalizedEventId = asNonEmptyString(taskEventId);
  if (normalizedEventId) {
    await requireLiveResourceReadback('task_events', normalizedEventId, rpcName);
  } else {
    await requireLiveResourceListReadback('task_events', { task_id: taskId }, rpcName);
  }
}

export async function assign_task_v1(
  args: AssignTaskArgs,
): Promise<{ task_id: string; task_event_id: string | null; task?: Record<string, unknown> }> {
  const taskId = asNonEmptyString(args.task_id);
  const assignedTo = asNonEmptyString(args.assigned_to);
  if (!taskId) throw new Error('assign_task_v1 requires task_id');
  if (!assignedTo) throw new Error('assign_task_v1 requires assigned_to');

  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>('assign_task_v1', {
    p_task_id: taskId,
    p_assigned_to: assignedTo,
    p_idempotency_key: args.idempotency_key ?? null,
    p_notes: args.notes ?? null,
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'assign_task_v1', ['task_id', 'task_event_id']);
    const returnedTaskId = requireLiveStringField(
      row,
      ['task_id', 'id'],
      'assign_task_v1 did not return task_id',
    );
    const taskEventId = asNonEmptyString(row.task_event_id);
    const task = await requireLiveResourceReadback('tasks', returnedTaskId, 'assign_task_v1');
    await requireLiveTaskEventReadback('assign_task_v1', returnedTaskId, taskEventId);
    return {
      task_id: returnedTaskId,
      task_event_id: taskEventId,
      task: normalizeTaskListRow(task),
    };
  }

  await sleep(80);
  const tasks = seed.tasks as Array<Record<string, unknown> & { id: string; assigned_to?: string | null; version?: number }>;
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`assign_task_v1 task not found: ${taskId}`);
  task.assigned_to = assignedTo;
  task.assigned_at = new Date().toISOString();
  task.version = typeof task.version === 'number' ? task.version + 1 : 1;
  const taskEventId = `tev_assign_${taskId}_${Date.now()}`;
  const taskEvents = seed.task_events as Array<Record<string, unknown>> | undefined;
  taskEvents?.push?.({
    id: taskEventId,
    task_id: taskId,
    occurred_at: task.assigned_at,
    event: 'assigned',
    actor: state.user.id,
    assigned_to: assignedTo,
    notes: args.notes ?? null,
    idempotency_key: args.idempotency_key ?? null,
  });
  return { task_id: taskId, task_event_id: taskEventId, task: normalizeTaskListRow(task) };
}

export async function open_ops_session_v1(args: OpenOpsSessionArgs): Promise<OpenOpsSessionResult> {
  const sessionType = asNonEmptyString(args.session_type);
  const idempotencyKey = asNonEmptyString(args.idempotency_key);
  if (!sessionType) throw new Error('open_ops_session_v1 requires session_type');
  if (!idempotencyKey) throw new Error('open_ops_session_v1 requires idempotency_key');

  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>('open_ops_session_v1', {
    p_input: compactRecord({
      session_type: sessionType,
      branch_id: args.branch_id ?? null,
      session_code: args.session_code ?? null,
      idempotency_key: idempotencyKey,
      metadata: args.metadata ?? {},
    }),
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'open_ops_session_v1', ['ops_session_id']);
    const opsSessionId = requireLiveStringField(
      row,
      ['ops_session_id', 'id'],
      'open_ops_session_v1 did not return ops_session_id',
    );
    await requireLiveResourceReadback('ops_sessions', opsSessionId, 'open_ops_session_v1');
    return {
      ...row,
      ops_session_id: opsSessionId,
      created: row.created === true,
    };
  }

  assertSeedFallbackAllowed('open_ops_session_v1');
  return {
    ops_session_id: `ops_${sessionType}_${Date.now().toString(36)}`,
    created: true,
  };
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

function normalizeUiCreateShipmentResult(
  rec: Record<string, unknown>,
  dryRun: boolean,
): UiCreateShipmentResult {
  return {
    ...rec,
    status: String(rec.status ?? (dryRun ? 'shipment_create_preview' : 'workflow_started')),
    workflow_template_id: rec.workflow_template_id == null ? null : String(rec.workflow_template_id),
    workflow_run_id: rec.workflow_run_id == null ? null : String(rec.workflow_run_id),
    workflow_status: rec.workflow_status == null ? null : String(rec.workflow_status),
    correlation_id: rec.correlation_id == null ? null : String(rec.correlation_id),
    shipment_id: rec.shipment_id == null ? null : String(rec.shipment_id),
    tracking_number: rec.tracking_number == null ? null : String(rec.tracking_number),
    operation: rec.operation == null ? null : String(rec.operation),
    recipient_id: rec.recipient_id == null ? null : String(rec.recipient_id),
    label_job_id: rec.label_job_id == null ? null : String(rec.label_job_id),
    address_workflow_run_id: rec.address_workflow_run_id == null ? null : String(rec.address_workflow_run_id),
    dry_run: Boolean(rec.dry_run ?? dryRun),
  };
}

function promoteManualShipmentIntakeEvidence(
  rec: Record<string, unknown>,
  dryRun: boolean,
): Record<string, unknown> {
  const nested = objectRecord(dryRun ? rec.shipment_preview : rec.shipment_result);
  const addressResult = objectRecord(rec.address_result);
  const promoted: Record<string, unknown> = { ...rec };
  const promoteString = (targetKey: string, values: unknown[]): void => {
    if (asNonEmptyString(promoted[targetKey])) return;
    const value = values.map(asNonEmptyString).find(Boolean);
    if (value) promoted[targetKey] = value;
  };

  promoteString('workflow_template_id', [
    nested.workflow_template_id,
    nested.workflow_template,
    nested.template_id,
  ]);
  promoteString('workflow_run_id', [nested.workflow_run_id, nested.run_id]);
  promoteString('workflow_status', [nested.workflow_status]);
  promoteString('correlation_id', [nested.correlation_id]);
  promoteString('shipment_id', [nested.shipment_id]);
  promoteString('tracking_number', [nested.tracking_number]);
  promoteString('operation', [nested.operation]);
  promoteString('recipient_id', [nested.recipient_id]);
  promoteString('label_job_id', [nested.label_job_id]);
  promoteString('address_workflow_run_id', [addressResult.workflow_run_id, nested.address_workflow_run_id]);

  return promoted;
}

function isManualShipmentIntakeReuseResult(rec: Record<string, unknown>): boolean {
  const status = String(rec.status ?? '').toLowerCase();
  const operation = String(rec.operation ?? '').toLowerCase();
  return (
    rec.duplicate_reused === true ||
    status === 'manual_shipment_intake_reused' ||
    operation === 'reused' ||
    operation.startsWith('reused_')
  );
}

function seedCreateManualShipmentResult(
  args: UiCreateShipmentArgs,
  dryRun: boolean,
): UiCreateShipmentResult {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const tracking = args.tracking_number ?? `SHP-${Math.floor(1000000 + Math.random() * 8999999)}`;
  const shipmentId = `shp_${nowMs}`;
  const recipientId = args.recipient_id ?? (args.new_recipient ? `rcp_${nowMs}` : null);
  const addressId = args.destination_address ? `addr_${nowMs}` : null;
  const labelId = `lbl_${shipmentId}_1`;
  const labelJobId = `lj_${nowMs}`;
  const labelSpec = ((seed.label_template_specs ?? []) as Array<Record<string, unknown>>)
    .find((spec) => String(spec.status ?? 'active') === 'active')
    ?? ((seed.label_template_specs ?? []) as Array<Record<string, unknown>>)[0]
    ?? {};
  const rendererConfig = (labelSpec.renderer_config ?? {}) as Record<string, unknown>;
  const serviceLookups = ((seed.lookups?.service_type ?? []) as Array<Record<string, unknown>>)
    .map((row) => String(row.value ?? '').trim())
    .filter(Boolean);
  const serviceOffering = ((seed.service_offerings ?? []) as Array<Record<string, unknown>>)
    .find((offering) => offering.id === args.service_offering_id);
  const serviceLevel = ((seed.service_levels ?? []) as Array<Record<string, unknown>>)
    .find((level) => level.id === serviceOffering?.service_level_id);
  const serviceLevelKey = String(serviceLevel?.key ?? '').trim();
  const requestedServiceType = String(args.service_type ?? '').trim();
  const serviceType =
    (serviceLookups.includes(serviceLevelKey) && serviceLevelKey)
    || (serviceLookups.includes(requestedServiceType) && requestedServiceType)
    || serviceLookups[0]
    || requestedServiceType
    || null;

  if (!dryRun) {
    const newRecipient = (args.new_recipient ?? null) as Record<string, unknown> | null;
    const destinationAddress = (args.destination_address ?? null) as Record<string, unknown> | null;
    if (newRecipient && recipientId) {
      const recipients = (seed.recipients ?? []) as Array<Record<string, unknown>>;
      if (!recipients.some((recipient) => recipient.id === recipientId)) {
        recipients.unshift({
          id: recipientId,
          organization_id: args.organization_id ?? null,
          client_id: args.client_id ?? null,
          status: 'active',
          created_at: nowIso,
          updated_at: nowIso,
          ...newRecipient,
        });
      }
    }
    if (destinationAddress && addressId) {
      const addresses = (seed.addresses ?? []) as Array<Record<string, unknown>>;
      addresses.unshift({
        id: addressId,
        organization_id: args.organization_id ?? null,
        client_id: args.client_id ?? null,
        recipient_id: recipientId,
        normalized_line1: destinationAddress.line1 ?? null,
        street: destinationAddress.line1 ?? null,
        district: destinationAddress.district ?? null,
        city: destinationAddress.city ?? null,
        country: destinationAddress.country ?? null,
        postal_code: destinationAddress.postal_code ?? null,
        validation_status: 'pending',
        created_at: nowIso,
        updated_at: nowIso,
        ...destinationAddress,
      });
    }
    const shipments = (seed.shipments ?? []) as Array<Record<string, unknown>>;
    shipments.unshift({
      id: shipmentId,
      tracking_number: tracking,
      client_reference_number: args.client_reference_number ?? null,
      carrier_reference_number: args.carrier_reference_number ?? null,
      client_id: args.client_id ?? null,
      sender_id: args.sender_id ?? null,
      organization_id: args.organization_id ?? null,
      recipient_id: recipientId,
      destination_address_id: addressId,
      service_type: serviceType,
      status: args.status ?? 'pending',
      cod_amount: args.cod_amount ?? 0,
      cod_currency: args.cod_currency ?? null,
      promised_delivery_date: args.promised_delivery_date ?? null,
      box_count: 1,
      created_at: nowIso,
      updated_at: nowIso,
      destination_city: (args.destination_address as Record<string, unknown> | null | undefined)?.city ?? null,
      metadata: {
        ...(args.metadata ?? {}),
        requested_service_type: args.service_type ?? null,
        service_offering_id: args.service_offering_id ?? null,
        service_offering_label: serviceOffering?.display_name ?? serviceOffering?.name ?? null,
        service_level_id: serviceLevel?.id ?? null,
        service_level_key: serviceLevelKey || null,
        manual_intake_source: 'console_v2.shipment_create',
      },
    });
    ((seed.shipment_boxes ?? []) as Array<Record<string, unknown>>).push({
      id: `sbx_${shipmentId}_1`,
      shipment_id: shipmentId,
      box_number: 1,
      barcode: `${tracking}:1`,
    });
    ((seed.labels ?? []) as Array<Record<string, unknown>>).push({
      id: labelId,
      shipment_id: shipmentId,
      barcode: `${tracking}:1`,
      active_version_id: rendererConfig.active_version_id ?? null,
      print_count: 0,
      last_printed_at: null,
    });
    ((seed.label_jobs ?? []) as Array<Record<string, unknown>>).push({
      id: labelJobId,
      label_id: labelId,
      target_id: shipmentId,
      target_box_id: `sbx_${shipmentId}_1`,
      target_metadata: { box_index: 1 },
      spec_id: labelSpec.id ?? null,
      status: 'queued',
      queued_at: nowIso,
      completed_at: null,
      file_url: null,
    });
  }

  return {
    status: dryRun ? 'shipment_create_preview' : 'shipment_created',
    workflow_template_id: 'tpl_create_shipment',
    workflow_run_id: dryRun ? null : `wfr_${nowMs}`,
    workflow_status: dryRun ? 'preview' : 'completed',
    correlation_id: `cor_${Math.random().toString(36).slice(2, 10)}`,
    shipment_id: dryRun ? null : shipmentId,
    tracking_number: tracking,
    operation: dryRun ? 'preview' : 'inserted',
    recipient_id: dryRun ? null : recipientId,
    label_job_id: dryRun ? null : labelJobId,
    address_workflow_run_id: dryRun || !args.destination_address ? null : `wfr_address_${nowMs}`,
    dry_run: dryRun,
  };
}

export async function ui_create_shipment_v1(
  args: UiCreateShipmentArgs,
): Promise<UiCreateShipmentResult> {
  const dryRun = Boolean(args.dry_run);
  const hasManualIntakeEnvelope = Boolean(args.new_recipient || args.destination_address);
  const metadata: Record<string, unknown> = {
    ...(args.metadata ?? {}),
  };
  if (args.service_offering_id) metadata.service_offering_id = args.service_offering_id;
  if (args.organization_id) metadata.organization_id = args.organization_id;
  if (args.recipient_id) metadata.recipient_id = args.recipient_id;
  if (args.cod_amount != null) metadata.cod_amount = args.cod_amount;
  if (args.cod_currency) metadata.cod_currency = args.cod_currency;
  if (args.promised_delivery_date) metadata.promised_delivery_date = args.promised_delivery_date;
  if (args.promised_window_start_at) metadata.promised_window_start_at = args.promised_window_start_at;
  if (args.promised_window_end_at) metadata.promised_window_end_at = args.promised_window_end_at;
  if (args.priority_score != null) metadata.priority_score = args.priority_score;

  if (hasManualIntakeEnvelope) {
    const liveManual = await liveRpc<Record<string, unknown>>('ui_create_manual_shipment_intake_v1', {
      p_args: {
        organization_id: args.organization_id ?? null,
        client_id: args.client_id ?? null,
        sender_id: args.sender_id ?? null,
        recipient_id: args.recipient_id ?? null,
        new_recipient: args.new_recipient ?? null,
        destination_address: args.destination_address ?? null,
        service_type: args.service_type ?? null,
        service_offering_id: args.service_offering_id ?? null,
        tracking_number: args.tracking_number ?? null,
        client_reference_number: args.client_reference_number ?? null,
        carrier_reference_number: args.carrier_reference_number ?? null,
        status: args.status ?? 'pending',
        cod_amount: args.cod_amount ?? null,
        cod_currency: args.cod_currency ?? null,
        metadata,
        request_label: true,
        dry_run: dryRun,
      },
    });
    if (liveManual) {
      const rec = requireLiveManualShipmentIntakeResult(liveManual.data, dryRun);
      const reusedManualIntake = isManualShipmentIntakeReuseResult(rec);
      if (!dryRun) {
        requireLiveStringField(
          rec,
          ['shipment_id'],
          'ui_create_manual_shipment_intake_v1 did not return shipment_id',
        );
        if (!reusedManualIntake) {
          requireLiveStringField(
            rec,
            ['workflow_run_id'],
            'ui_create_manual_shipment_intake_v1 did not return workflow_run_id',
          );
        }
        requireLiveStringField(
          rec,
          ['tracking_number'],
          'ui_create_manual_shipment_intake_v1 did not return tracking_number',
        );
      }
      const result = normalizeUiCreateShipmentResult(rec, dryRun);
      if (!dryRun) {
        await requireLiveShipmentCreateReadback('ui_create_manual_shipment_intake_v1', args, result, rec);
      }
      return result;
    }
  }

  const live = await liveRpc<Record<string, unknown>>('ui_create_shipment_v1', {
    p_client_id: args.client_id ?? null,
    p_sender_id: args.sender_id ?? null,
    p_service_type: args.service_type ?? null,
    p_tracking_number: args.tracking_number ?? null,
    p_client_reference_number: args.client_reference_number ?? null,
    p_carrier_reference_number: args.carrier_reference_number ?? null,
    p_status: args.status ?? 'pending',
    p_metadata: dryRun
      ? { ...metadata, ui: { dry_run: true } }
      : metadata,
  });
  if (live) {
    const rec = requireLiveMutationResult(
      live.data,
      'ui_create_shipment_v1',
      dryRun
        ? ['correlation_id', 'workflow_template_id', 'workflow_run_id', 'tracking_number']
        : ['shipment_id', 'workflow_run_id', 'tracking_number'],
    );
    if (!dryRun) {
      requireLiveStringField(rec, ['shipment_id'], 'ui_create_shipment_v1 did not return shipment_id');
      requireLiveStringField(rec, ['workflow_run_id'], 'ui_create_shipment_v1 did not return workflow_run_id');
      requireLiveStringField(rec, ['tracking_number'], 'ui_create_shipment_v1 did not return tracking_number');
    }
    const result = normalizeUiCreateShipmentResult(rec, dryRun);
    if (!dryRun) {
      await requireLiveShipmentCreateReadback('ui_create_shipment_v1', args, result, rec);
    }
    return result;
  }

  assertSeedFallbackAllowed('ui_create_shipment_v1');
  await sleep(120);
  return seedCreateManualShipmentResult(args, dryRun);
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
  const rawOp = typeof op === 'string' ? op : String((op as Record<string, unknown>).action ?? 'amend');
  const lookupBackendOperation = lookupCommandContractRow('shipment_amend_op', rawOp)?.metadata?.backend_operation;
  const operation =
    typeof lookupBackendOperation === 'string' && lookupBackendOperation.length > 0
      ? lookupBackendOperation
      : rawOp === 'amend_field' || rawOp === 'amend'
        ? 'modify'
        : rawOp;
  const effectivePayload = typeof op === 'string' ? payload : op;
  const mutationSource =
    typeof effectivePayload.source === 'string' && effectivePayload.source.trim()
      ? effectivePayload.source
      : null;
  const payloadWithoutSource =
    mutationSource && operation === 'modify'
      ? Object.fromEntries(Object.entries(effectivePayload).filter(([key]) => key !== 'source'))
      : effectivePayload;
  const inputPayload =
    payloadWithoutSource && (payloadWithoutSource.changes || payloadWithoutSource.address || payloadWithoutSource.destination_address)
      ? payloadWithoutSource
      : operation === 'address'
        ? { address: payloadWithoutSource }
        : operation === 'modify'
          ? { changes: payloadWithoutSource }
          : payloadWithoutSource;
  const live = await liveRpc<Record<string, unknown>>('shipment_amend_cancel_v1', {
    p_input: {
      shipment_id: shipmentId,
      operation,
      surface: 'console',
      dry_run: !!opts.dryRun,
      ...(mutationSource ? { source: mutationSource } : {}),
      ...inputPayload,
    },
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Shipment mutation returned no backend outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'Shipment mutation was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const dryRun = Boolean(rec.dry_run ?? opts.dryRun);
    const workflowRunId = asNonEmptyString(rec.workflow_run_id);
    let workflowTemplate = asNonEmptyString(
      rec.workflow_template ??
      rec.workflow_template_name ??
      rec.workflow_template_id,
    );
    if (!dryRun && !workflowRunId) {
      throw new Error('Shipment mutation did not return workflow_run_id');
    }
    if (!dryRun && !workflowTemplate && workflowRunId) {
      const workflowRun = await requireLiveResourceReadback('workflow_runs', workflowRunId, 'shipment_amend_cancel_v1');
      workflowTemplate = asNonEmptyString(
        workflowRun.workflow_template_name ??
        workflowRun.template_name ??
        workflowRun.workflow_template_id,
      );
    }
    if (!dryRun && !workflowTemplate) {
      throw new Error('Shipment mutation did not return workflow_template or readable workflow run template evidence');
    }
    if (!dryRun) {
      await requireLiveShipmentMutationReadback('shipment_amend_cancel_v1', {
        shipmentId,
        workflowRunId,
        operation,
        payload: inputPayload,
        result: rec,
        // Shipment operators may not have workflow-log read permission. The
        // RPC response carries workflow template/run evidence, while shipment
        // visibility is proven from shipment/domain readback below.
        requireWorkflowRunReadback: false,
      });
    }
    return {
      ...rec,
      ok: true,
      workflow_template: workflowTemplate ?? '',
      workflow_run_id: workflowRunId ?? '',
      started_via: String(rec.started_via ?? (dryRun ? 'dry_run_preview' : 'start_workflow_run')),
      canonical_entrypoint: String(rec.canonical_entrypoint ?? (dryRun ? 'not_started' : 'progress_workflow_run')),
      dry_run: dryRun,
      diff: (rec.diff as Record<string, unknown> | null | undefined) ?? null,
      settings_resolution_id: String(rec.settings_resolution_id ?? ''),
    };
  }

  await sleep(150);
  return {
    ok: true,
    workflow_template: 'tpl_amend_cancel',
    workflow_run_id: opts.dryRun ? '' : 'wfr_synthetic_' + Date.now(),
    started_via: opts.dryRun ? 'dry_run_preview' : 'start_workflow_run',
    canonical_entrypoint: opts.dryRun ? 'not_started' : 'progress_workflow_run',
    dry_run: !!opts.dryRun,
    diff: opts.dryRun ? { ...effectivePayload } : null,
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function shipment_amend_cancel_options_v1(
  shipmentId: string,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('shipment_amend_cancel_options_v1', {
    p_shipment_id: shipmentId,
  });
  if (live) {
    return requireLiveRpcRecord(
      live.data,
      'Shipment operation policy returned no backend state',
    );
  }

  await sleep(60);
  const shipment = ((seed as { shipments?: Array<Record<string, unknown>> }).shipments ?? [])
    .find((row) => String(row.id ?? row.shipment_id ?? '') === shipmentId);
  const status = String(shipment?.status ?? 'unknown');
  const allowedStatuses = ['created', 'pending'];
  const isSeedPolicyEligible = Boolean(shipment) && allowedStatuses.includes(status);
  const guard = (operation: string) => ({
    operation,
    allowed: isSeedPolicyEligible,
    reason: isSeedPolicyEligible ? null : (shipment ? 'status_not_allowed' : 'backend_policy_unavailable'),
    lock_source: 'shipment_operation_policy',
    status,
    allowed_statuses: allowedStatuses,
  });

  return {
    shipment_id: shipmentId,
    tracking_number: shipment?.tracking_number ?? null,
    status,
    lock_source: 'shipment_operation_policy',
    policy: {},
    operations: {
      modify: guard('modify'),
      reschedule: guard('reschedule'),
      address: guard('address'),
      cancel: guard('cancel'),
    },
  };
}
export interface ShipmentResortResult extends Record<string, unknown> {
  ok: true;
  status?: string;
  basket_policy_applied: boolean;
}

function backendOutcomeError(rec: Record<string, unknown>, fallback: string): Error | null {
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

function requireLiveRpcRecord(data: unknown, fallback: string): Record<string, unknown> {
  const rec = firstRpcRow<Record<string, unknown>>(data);
  if (!rec || Object.keys(rec).length === 0) throw new Error(fallback);
  return rec;
}

function requireLiveStringField(
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

function requireLiveNumberField(
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

const LIVE_MUTATION_EVIDENCE_KEYS = [
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

function requireLiveEvidence(
  rec: Record<string, unknown>,
  keys: readonly string[],
  fallback: string,
): void {
  if (!hasLiveEvidenceField(rec, keys)) throw new Error(fallback);
}

function requireLiveMutationResult(
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

function requireLiveManualShipmentIntakeResult(data: unknown, dryRun: boolean): Record<string, unknown> {
  const rpcName = 'ui_create_manual_shipment_intake_v1';
  const rec = requireLiveRpcRecord(data, `${rpcName} returned no backend outcome`);
  const outcomeError = backendOutcomeError(rec, `${rpcName} was rejected by the backend`);
  if (outcomeError) throw outcomeError;
  const promoted = promoteManualShipmentIntakeEvidence(rec, dryRun);
  const reusedManualIntake = isManualShipmentIntakeReuseResult(promoted);
  requireLiveEvidence(
    promoted,
    [
      ...(dryRun
        ? ['correlation_id', 'workflow_template_id', 'workflow_run_id', 'tracking_number']
        : reusedManualIntake
          ? ['shipment_id', 'tracking_number']
          : ['shipment_id', 'workflow_run_id', 'tracking_number']),
      ...LIVE_MUTATION_EVIDENCE_KEYS,
    ],
    `${rpcName} did not return backend execution evidence`,
  );
  return promoted;
}

async function livePArgsMutationResult(
  rpcName: string,
  args: Record<string, unknown>,
  evidenceKeys: readonly string[],
): Promise<Record<string, unknown> | null> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, { p_args: args });
  if (!live) return null;
  return requireLiveMutationResult(live.data, rpcName, evidenceKeys);
}

function requireLiveDomainEvidence(
  rec: Record<string, unknown>,
  rpcName: string,
  keys: readonly string[],
  label: string,
): void {
  requireLiveEvidence(rec, keys, `${rpcName} did not return backend ${label} evidence`);
}

function withRequiredLiveStringField<T>(
  rec: Record<string, unknown>,
  keys: readonly string[],
  targetKey: string,
  fallback: string,
): T {
  const value = requireLiveStringField(rec, keys, fallback);
  return { ...rec, [targetKey]: value } as T;
}

function requireLiveLabelDraftResult(data: unknown, rpcName: string): LabelDesignerDraftMutationResult {
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

async function requireLiveLabelDraftMutationReadback(
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

function requireLiveLabelValidationResult(data: unknown): LabelDesignerDraftValidationResult {
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

function requireLiveLabelPublishResult(data: unknown): LabelDesignerDraftPublishResult {
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

async function requireLiveResourceReadback(
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

async function readLiveResourceListReadback(
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

async function requireLiveResourceListReadback(
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

async function requireLiveResourceAbsenceReadback(
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

async function requireLiveShipmentWorkflowReadback(
  rpcName: string,
  {
    shipmentId,
    workflowRunId,
    labelJobId,
  }: {
    shipmentId?: string | null;
    workflowRunId?: string | null;
    labelJobId?: string | null;
  },
): Promise<void> {
  const normalizedShipmentId = asNonEmptyString(shipmentId);
  const normalizedWorkflowRunId = asNonEmptyString(workflowRunId);
  const normalizedLabelJobId = asNonEmptyString(labelJobId);

  if (normalizedShipmentId) {
    await requireLiveResourceReadback('shipments', normalizedShipmentId, rpcName);
  }
  if (normalizedWorkflowRunId) {
    await requireLiveResourceReadback('workflow_runs', normalizedWorkflowRunId, rpcName);
  }
  if (normalizedLabelJobId) {
    await requireLiveResourceReadback('label_jobs', normalizedLabelJobId, rpcName);
  }
}

const SA_SHORT_ADDRESS_READBACK_KEYS = [
  'sa_short_code',
  'short_national_address',
  'short_address',
  'shortAddress',
  'address_short',
  'short_code',
  'shortCode',
] as const;

function normalizeSaShortAddress(value: unknown): string | null {
  const text = asNonEmptyString(value);
  if (!text) return null;
  return text.replace(/\s+/g, '').toUpperCase();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return objectRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return objectRecord(value);
}

function addressSubmissionCandidates(row: Record<string, unknown>): Array<Record<string, unknown>> {
  const rawInput = parseJsonRecord(row.raw_input);
  return [
    row,
    rawInput,
    objectRecord(rawInput.provided_coordinates),
    objectRecord(rawInput.coordinates),
    objectRecord(row.coordinates),
    objectRecord(row.geocoding_context),
    objectRecord(row.metadata),
  ];
}

function canonicalAddressReadbackCandidates(row: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    row,
    objectRecord(row.coordinates),
    objectRecord(row.geocoding_context),
    objectRecord(row.metadata),
  ];
}

function pickAddressShortCode(row: Record<string, unknown>, canonicalOnly = false): string | null {
  const candidates = canonicalOnly ? canonicalAddressReadbackCandidates(row) : addressSubmissionCandidates(row);
  for (const candidate of candidates) {
    for (const key of SA_SHORT_ADDRESS_READBACK_KEYS) {
      const normalized = normalizeSaShortAddress(candidate[key]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function pickAddressCoordinate(row: Record<string, unknown>, axis: 'lat' | 'lng', canonicalOnly = false): number | null {
  const keys = axis === 'lat'
    ? ['latitude', 'lat', 'destination_latitude', 'dest_latitude']
    : ['longitude', 'lng', 'destination_longitude', 'dest_longitude'];
  const candidates = canonicalOnly ? canonicalAddressReadbackCandidates(row) : addressSubmissionCandidates(row);
  for (const candidate of candidates) {
    const directPair = coordinatePairFromUnknown(candidate.coordinates);
    if (directPair) return directPair[axis];
    for (const key of keys) {
      const value = _numberFromUnknown(candidate[key]);
      if (value != null) return value;
    }
  }
  return null;
}

function requireSubmittedAddressReadback(
  rpcName: string,
  submittedAddress: Record<string, unknown>,
  addressRow: Record<string, unknown>,
): void {
  const submittedShortCode = pickAddressShortCode(submittedAddress);
  if (submittedShortCode) {
    const readbackShortCode = pickAddressShortCode(addressRow, true);
    if (readbackShortCode !== submittedShortCode) {
      throw new Error(`${rpcName} backend address readback did not project Saudi short national address to canonical address fields`);
    }
  }

  const submittedLat = pickAddressCoordinate(submittedAddress, 'lat');
  const submittedLng = pickAddressCoordinate(submittedAddress, 'lng');
  if (submittedLat != null || submittedLng != null) {
    const readbackLat = pickAddressCoordinate(addressRow, 'lat', true);
    const readbackLng = pickAddressCoordinate(addressRow, 'lng', true);
    if (
      submittedLat == null ||
      submittedLng == null ||
      readbackLat == null ||
      readbackLng == null ||
      Math.abs(readbackLat - submittedLat) > 0.000001 ||
      Math.abs(readbackLng - submittedLng) > 0.000001
    ) {
      throw new Error(`${rpcName} backend address readback did not project provided coordinates to canonical address fields`);
    }
  }
}

async function requireLiveShipmentCreateReadback(
  rpcName: string,
  args: UiCreateShipmentArgs,
  result: UiCreateShipmentResult,
  rec: Record<string, unknown>,
): Promise<void> {
  const shipmentId = asNonEmptyString(result.shipment_id);
  if (!shipmentId) throw new Error(`${rpcName} did not return shipment_id`);

  const shipmentRow = await requireLiveResourceReadback('shipments', shipmentId, rpcName);
  await requireLiveResourceReadback('shipment_directory', shipmentId, rpcName);
  const shipmentMetadata = objectRecord(shipmentRow.metadata);
  const expectedBranchId = asNonEmptyString(shipmentMetadata.service_offering_branch_id);
  if (expectedBranchId && asNonEmptyString(shipmentRow.branch_id) !== expectedBranchId) {
    throw new Error(`${rpcName} backend readback did not project service_offering_branch_id to shipments.branch_id`);
  }
  const expectedZoneId = asNonEmptyString(shipmentMetadata.service_offering_zone_id);
  if (expectedZoneId && asNonEmptyString(shipmentRow.zone_id) !== expectedZoneId) {
    throw new Error(`${rpcName} backend readback did not project service_offering_zone_id to shipments.zone_id`);
  }
  const expectedServiceLevel = asNonEmptyString(shipmentMetadata.service_level_key);
  const actualServiceLevel = asNonEmptyString(shipmentRow.service_level);
  if (
    expectedServiceLevel &&
    (!actualServiceLevel || actualServiceLevel.toLowerCase() !== expectedServiceLevel.toLowerCase())
  ) {
    throw new Error(`${rpcName} backend readback did not project service_level_key to shipments.service_level`);
  }

  const workflowRunId = asNonEmptyString(result.workflow_run_id);
  if (workflowRunId) {
    await requireLiveResourceReadback('workflow_runs', workflowRunId, rpcName);
  }

  const recipientId =
    asNonEmptyString(result.recipient_id) ??
    asNonEmptyString(args.recipient_id) ??
    asNonEmptyString(shipmentRow.recipient_id);
  if (args.new_recipient && !recipientId) {
    throw new Error(`${rpcName} did not return recipient_id for inline recipient readback`);
  }
  if (recipientId) {
    await requireLiveResourceReadback('recipients', recipientId, rpcName);
    await requireLiveResourceReadback('recipient_directory', recipientId, rpcName);
  }

  const duplicateReuse = isManualShipmentIntakeReuseResult(rec);
  if (args.destination_address && !duplicateReuse) {
    const addressResult = objectRecord(rec.address_result);
    const destinationAddressId =
      asNonEmptyString(shipmentRow.destination_address_id) ??
      asNonEmptyString(rec.destination_address_id) ??
      asNonEmptyString(rec.address_id) ??
      asNonEmptyString(addressResult.destination_address_id) ??
      asNonEmptyString(addressResult.address_id);
    if (!destinationAddressId) {
      throw new Error(`${rpcName} did not expose destination_address_id for address readback`);
    }
    const addressRow = await requireLiveResourceReadback('addresses', destinationAddressId, rpcName);
    requireSubmittedAddressReadback(rpcName, args.destination_address, addressRow);
  } else if (args.destination_address) {
    const destinationAddressId = asNonEmptyString(shipmentRow.destination_address_id);
    if (destinationAddressId) {
      const addressRow = await requireLiveResourceReadback('addresses', destinationAddressId, rpcName);
      requireSubmittedAddressReadback(rpcName, args.destination_address, addressRow);
    }
  }

  const labelJobId = asNonEmptyString(result.label_job_id);
  if (labelJobId) {
    const labelJob = await requireLiveResourceReadback('label_jobs', labelJobId, rpcName);
    const labelId =
      asNonEmptyString(rec.label_id) ??
      asNonEmptyString(labelJob.label_id);
    if (labelId) {
      await requireLiveResourceReadback('labels', labelId, rpcName);
    }
    const labelVersionId =
      asNonEmptyString(rec.label_version_id) ??
      asNonEmptyString(labelJob.label_version_id) ??
      asNonEmptyString(labelJob.active_version_id);
    if (labelVersionId) {
      await requireLiveResourceReadback('label_versions', labelVersionId, rpcName);
    }
  }
}

async function requireLiveShipmentMutationReadback(
  rpcName: string,
  {
    shipmentId,
    workflowRunId,
    labelJobId,
    operation,
    payload,
    result,
    requireWorkflowRunReadback = true,
  }: {
    shipmentId?: string | null;
    workflowRunId?: string | null;
    labelJobId?: string | null;
    operation?: string | null;
    payload?: Record<string, unknown> | null;
    result?: Record<string, unknown> | null;
    requireWorkflowRunReadback?: boolean;
  },
): Promise<void> {
  const normalizedShipmentId = asNonEmptyString(shipmentId);
  const shipmentRow = normalizedShipmentId
    ? await requireLiveResourceReadback('shipments', normalizedShipmentId, rpcName)
    : {};
  if (normalizedShipmentId) {
    await requireLiveResourceReadback('shipment_directory', normalizedShipmentId, rpcName);
  }
  const normalizedWorkflowRunId = asNonEmptyString(workflowRunId);
  if (normalizedWorkflowRunId && requireWorkflowRunReadback) {
    await requireLiveResourceReadback('workflow_runs', normalizedWorkflowRunId, rpcName);
  }
  const normalizedLabelJobId = asNonEmptyString(labelJobId);
  if (normalizedLabelJobId) {
    await requireLiveResourceReadback('label_jobs', normalizedLabelJobId, rpcName);
  }

  const normalizedPayload = objectRecord(payload);
  const normalizedResult = objectRecord(result);
  const operationResult = objectRecord(normalizedResult.operation_result);
  const reserveResult = objectRecord(operationResult.reserve_result);
  const actionId =
    asNonEmptyString(normalizedResult.shipment_action_id) ??
    asNonEmptyString(operationResult.shipment_action_id) ??
    asNonEmptyString(reserveResult.action_id) ??
    asNonEmptyString(normalizedResult.action_id);
  if (actionId) {
    await requireLiveResourceReadback('shipment_actions', actionId, rpcName);
  }
  const addressPayload = objectRecord(normalizedPayload.address);
  const destinationAddressPayload = objectRecord(normalizedPayload.destination_address);
  const touchesAddress =
    operation === 'address' ||
    Object.keys(addressPayload).length > 0 ||
    Object.keys(destinationAddressPayload).length > 0;
  if (touchesAddress) {
    const addressResult = objectRecord(normalizedResult.address_result);
    const destinationAddressId =
      asNonEmptyString(normalizedResult.destination_address_id) ??
      asNonEmptyString(normalizedResult.address_id) ??
      asNonEmptyString(operationResult.destination_address_id) ??
      asNonEmptyString(operationResult.address_id) ??
      asNonEmptyString(addressResult.destination_address_id) ??
      asNonEmptyString(addressResult.address_id) ??
      asNonEmptyString(shipmentRow.destination_address_id);
    if (!destinationAddressId) {
      throw new Error(`${rpcName} did not expose destination_address_id for address readback`);
    }
    await requireLiveResourceReadback('addresses', destinationAddressId, rpcName);
    const geocodeWorkflowRunId =
      asNonEmptyString(operationResult.geocode_workflow_run_id) ??
      asNonEmptyString(operationResult.address_workflow_run_id);
    if (geocodeWorkflowRunId) {
      await requireLiveResourceReadback('workflow_runs', geocodeWorkflowRunId, rpcName);
    }
  }

  const changes = objectRecord(normalizedPayload.changes);
  const boxes = objectRecord(changes.boxes);
  const boxIds = new Set<string>();
  for (const boxId of Object.keys(boxes)) {
    const normalizedBoxId = asNonEmptyString(boxId);
    if (normalizedBoxId) boxIds.add(normalizedBoxId);
  }
  const returnedBoxId =
    asNonEmptyString(normalizedResult.shipment_box_id) ??
    asNonEmptyString(normalizedResult.box_id) ??
    asNonEmptyString(normalizedResult.target_box_id);
  if (returnedBoxId) boxIds.add(returnedBoxId);
  for (const boxId of boxIds) {
    await requireLiveResourceReadback('shipment_boxes', boxId, rpcName);
  }

  const touchesCod = ['cod_amount', 'cod_currency', 'cod_method', 'payment_collection_method'].some((key) =>
    Object.prototype.hasOwnProperty.call(changes, key) ||
    Object.prototype.hasOwnProperty.call(normalizedPayload, key),
  );
  if (touchesCod) {
    const actionId =
      asNonEmptyString(normalizedResult.shipment_action_id) ??
      asNonEmptyString(normalizedResult.action_id) ??
      asNonEmptyString(normalizedResult.cod_action_id);
    if (actionId) {
      await requireLiveResourceReadback('shipment_actions', actionId, rpcName);
    }
  }
}

async function requireLiveRouteRunAssignmentReadback(
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
  const live = await liveRpc<Record<string, unknown>>('ui_execute_shipment_resort_v1', {
    p_action_key: 'shipments.resort',
    p_resource_key: 'shipments',
    p_selection_ids: [shipmentId],
    p_selection_id: shipmentId,
    p_selection_count: 1,
    p_params: {},
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Shipment resort returned no backend outcome',
    );
    const error = backendOutcomeError(rec, 'Shipment resort was rejected by the backend');
    if (error) throw error;
    await requireLiveShipmentWorkflowReadback('ui_execute_shipment_resort_v1', {
      shipmentId,
      workflowRunId: asNonEmptyString(rec.workflow_run_id),
    });
    return {
      ok: true,
      basket_policy_applied: true,
      ...rec,
    } as ShipmentResortResult;
  }

  await sleep(80);
  return { ok: true, basket_policy_applied: true };
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
  if (!shipmentId) throw new Error('shipment_id is required to requeue geocoding');

  const live = await liveRpc<Record<string, unknown>>('ui_execute_shipment_update_geocode_v1', {
    p_action_key: 'shipments.update_geocode',
    p_resource_key: 'shipments',
    p_selection_ids: [shipmentId],
    p_selection_id: shipmentId,
    p_selection_count: 1,
    p_params: {
      workflow_template_name: 'shipment_update_geocode_v1',
      ...params,
    },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_shipment_update_geocode_v1', [
      'workflow_run_id',
    ]);
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id'],
      'ui_execute_shipment_update_geocode_v1 did not return workflow_run_id',
    );
    await requireLiveShipmentWorkflowReadback('ui_execute_shipment_update_geocode_v1', {
      shipmentId,
      workflowRunId,
    });
    const itemRecords = Array.isArray(rec.items) ? (rec.items as Array<Record<string, unknown>>) : [];
    const firstItemString = (keys: readonly string[]): string | null => {
      for (const item of itemRecords) {
        for (const key of keys) {
          const value = asNonEmptyString(item[key]);
          if (value) return value;
        }
      }
      return null;
    };
    const geocodeWorkflowStatus = (
      asNonEmptyString(rec.geocode_workflow_status)
      ?? firstItemString(['geocode_workflow_status'])
    )?.toLowerCase();
    const geocodeWorkflowRunId =
      asNonEmptyString(rec.geocode_workflow_run_id) ??
      firstItemString(['geocode_workflow_run_id']);
    if (geocodeWorkflowStatus && ['failed', 'cancelled', 'blocked'].includes(geocodeWorkflowStatus)) {
      throw new Error(
        `ui_execute_shipment_update_geocode_v1 nested geocode workflow ${geocodeWorkflowStatus}`
        + (geocodeWorkflowRunId ? ` (${geocodeWorkflowRunId})` : ''),
      );
    }
    if (geocodeWorkflowRunId) {
      await requireLiveResourceReadback('workflow_runs', geocodeWorkflowRunId, 'ui_execute_shipment_update_geocode_v1');
    }
    const geocodingAttemptId =
      asNonEmptyString(rec.geocoding_attempt_id) ??
      asNonEmptyString(rec.attempt_id) ??
      firstItemString(['geocoding_attempt_id', 'attempt_id']);
    const geocodeId =
      asNonEmptyString(rec.geocode_id) ??
      firstItemString(['geocode_id']);
    const manualReviewTaskId =
      asNonEmptyString(rec.manual_review_task_id) ??
      asNonEmptyString(rec.review_task_id) ??
      asNonEmptyString(rec.task_id) ??
      firstItemString(['manual_review_task_id', 'review_task_id', 'task_id']);
    if (geocodingAttemptId) {
      await requireLiveResourceReadback('geocoding_attempts', geocodingAttemptId, 'ui_execute_shipment_update_geocode_v1');
    }
    if (geocodeId) {
      await requireLiveResourceReadback('geocodes', geocodeId, 'ui_execute_shipment_update_geocode_v1');
    }
    if (manualReviewTaskId) {
      await requireLiveResourceReadback('manual_review_tasks', manualReviewTaskId, 'ui_execute_shipment_update_geocode_v1');
    }
    return {
      ok: true,
      status: String(rec.status ?? 'workflow_started'),
      action_key: String(rec.action_key ?? 'shipments.update_geocode'),
      resource_key: String(rec.resource_key ?? 'shipments'),
      count: Number(rec.count ?? 1),
      workflow_run_id: workflowRunId,
      items: Array.isArray(rec.items) ? (rec.items as Array<Record<string, unknown>>) : undefined,
      ...rec,
    } as ShipmentUpdateGeocodeResult;
  }

  await sleep(80);
  const workflowRunId = 'wfr_geocode_' + Date.now();
  return {
    ok: true,
    status: 'completed',
    action_key: 'shipments.update_geocode',
    resource_key: 'shipments',
    count: 1,
    workflow_run_id: workflowRunId,
    items: [
      {
        shipment_id: shipmentId,
        address_id: typeof params.address_id === 'string' ? params.address_id : null,
        destination_address_id:
          typeof params.destination_address_id === 'string' ? params.destination_address_id : null,
        workflow_run_id: workflowRunId,
        status: 'completed',
      },
    ],
  };
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
  const operation = op === 'delete' ? 'cancel' : op;
  let actionKey: 'shipments.delete' | 'shipments.reschedule';
  if (operation === 'cancel') {
    actionKey = 'shipments.delete';
  } else if (operation === 'reschedule') {
    actionKey = 'shipments.reschedule';
  } else {
    throw new Error(`ui_execute_shipment_batch_operation_v1 unsupported operation ${operation}`);
  }
  const live = await liveRpc<Record<string, unknown>>('ui_execute_shipment_batch_operation_v1', {
    p_action_key: actionKey,
    p_resource_key: 'shipments',
    p_selection_ids: ids,
    p_selection_id: ids.length === 1 ? ids[0] : null,
    p_selection_count: ids.length,
    p_params: {
      ...payload,
      operation,
      surface: 'console',
      dry_run: !!opts.dryRun,
    },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_shipment_batch_operation_v1', [
      'workflow_run_id',
      'items',
      'count',
      'success_count',
      'affected_count',
    ]);
    const count = requireLiveNumberField(
      rec,
      ['count', 'success_count', 'affected_count'],
      'Shipment batch operation did not return an affected count',
    );
    if (!opts.dryRun) {
      for (const id of ids) {
        await requireLiveResourceReadback('shipments', id, 'ui_execute_shipment_batch_operation_v1');
      }
      const workflowRunId = asNonEmptyString(rec.workflow_run_id);
      if (workflowRunId) {
        await requireLiveResourceReadback('workflow_runs', workflowRunId, 'ui_execute_shipment_batch_operation_v1');
      }
    }
    return {
      ...rec,
      ok: true,
      count,
      op: operation,
      dry_run: !!opts.dryRun,
    } as { ok: true; count: number; op: string; dry_run: boolean };
  }

  await sleep(120);
  return { ok: true, count: ids.length, op, dry_run: !!opts.dryRun };
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

  assertSeedFallbackAllowed('ui_update_basket_state_v1');
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

function defaultLookupValue(category: string): string | null {
  const rows = getLookups(category) as unknown as Array<Record<string, unknown>>;
  const preferred = rows.find((row) => row.is_default === true) ?? rows[0];
  return asNonEmptyString(preferred?.value);
}

export async function basket_create_v1(
  args: Record<string, unknown>,
): Promise<BasketCreateMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('basket_create_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'basket_create_v1', [
      'basket_id',
    ]) as BasketCreateMutationResult;
  }

  await sleep(60);
  const organizationId =
    asNonEmptyString(args.organization_id) ??
    asNonEmptyString(state.user.organization_id) ??
    asNonEmptyString((state.scope?.tenant as Record<string, unknown> | undefined)?.id);
  if (!organizationId) throw new Error('basket_create_v1 requires organization_id or tenant scope');

  const basketType = asNonEmptyString(args.basket_type) ?? defaultLookupValue('basket_type');
  const basketState = asNonEmptyString(args.state) ?? defaultLookupValue('basket_state');
  if (!basketState) throw new Error('basket_create_v1 requires a basket_state lookup default');

  const capacityRaw = args.capacity_count;
  const capacity = capacityRaw === undefined || capacityRaw === null || capacityRaw === ''
    ? null
    : Number(capacityRaw);
  if (capacity != null && (!Number.isFinite(capacity) || capacity < 1)) {
    throw new Error('basket_create_v1 capacity_count must be positive');
  }

  const expiresAt =
    asNonEmptyString(args.expires_at) ??
    (() => {
      const minutesRaw = args.expires_in_minutes;
      if (minutesRaw === undefined || minutesRaw === null || minutesRaw === '') return null;
      const minutes = Number(minutesRaw);
      if (!Number.isFinite(minutes) || minutes < 1) {
        throw new Error('basket_create_v1 expires_in_minutes must be positive');
      }
      return new Date(Date.now() + minutes * 60_000).toISOString();
    })();

  const basketId = nextResourceId('basket');
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    id: basketId,
    organization_id: organizationId,
    zone_id: asNonEmptyString(args.zone_id),
    basket_type: basketType,
    state: basketState,
    current_count: 0,
    capacity_count: capacity,
    expires_at: expiresAt,
    version: 1,
    created_at: now,
    updated_at: now,
    sort_branch_id: asNonEmptyString(args.sort_branch_id),
    sort_service_key: asNonEmptyString(args.sort_service_key),
    sort_route_key: asNonEmptyString(args.sort_route_key),
    sort_priority_key: asNonEmptyString(args.sort_priority_key),
  };
  const baskets = (seed as { baskets?: Array<Record<string, unknown>> }).baskets;
  if (Array.isArray(baskets)) baskets.unshift(row);

  return buildEnvelope({
    basket_id: basketId,
    zone_id: row.zone_id,
    basket_type: basketType,
    state: basketState,
    capacity_count: capacity,
    expires_at: expiresAt,
  }) as BasketCreateMutationResult;
}

export async function basket_update_v1(
  args: Record<string, unknown>,
): Promise<BasketUpdateMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('basket_update_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'basket_update_v1', [
      'basket_id',
    ]) as BasketUpdateMutationResult;
  }

  await sleep(60);
  const basketId = asNonEmptyString(args.basket_id) ?? asNonEmptyString(args.id);
  if (!basketId) throw new Error('basket_update_v1 requires basket_id');
  const patch = objectRecord(args.patch);
  if (!Object.keys(patch).length) throw new Error('basket_update_v1 requires a non-empty patch');
  const allowedPatchKeys = new Set([
    'zone_id',
    'basket_type',
    'capacity_count',
    'expires_at',
    'sort_branch_id',
    'sort_service_key',
    'sort_route_key',
    'sort_priority_key',
  ]);
  const unsupportedPatchKeys = Object.keys(patch).filter((key) => !allowedPatchKeys.has(key)).sort();
  if (unsupportedPatchKeys.length) {
    throw new Error(`basket_update_v1 unsupported patch keys: ${unsupportedPatchKeys.join(', ')}`);
  }

  const baskets = (seed as { baskets?: Array<Record<string, unknown>> }).baskets ?? [];
  const basket = baskets.find((row) => row.id === basketId);
  if (!basket) throw new Error(`basket_not_found:${basketId}`);

  const changed: Record<string, unknown> = {};
  if (patch.zone_id !== undefined) {
    const zoneId = asNonEmptyString(patch.zone_id) ?? null;
    basket.zone_id = zoneId;
    changed.zone_id = zoneId;
  }
  if (patch.basket_type !== undefined) {
    const basketType = asNonEmptyString(patch.basket_type);
    if (!basketType) throw new Error('basket_update_v1 basket_type cannot be blank');
    basket.basket_type = basketType;
    changed.basket_type = basketType;
  }
  if (patch.capacity_count !== undefined) {
    const capacity = patch.capacity_count === null || patch.capacity_count === ''
      ? null
      : Number(patch.capacity_count);
    if (capacity != null && (!Number.isFinite(capacity) || capacity < 1)) {
      throw new Error('basket_update_v1 capacity_count must be positive');
    }
    if (capacity != null && capacity < Number(basket.current_count ?? 0)) {
      throw new Error('basket_update_v1 capacity_count cannot be below current_count');
    }
    basket.capacity_count = capacity;
    changed.capacity_count = capacity;
  }
  if (patch.expires_at !== undefined) {
    const expiresAt = asNonEmptyString(patch.expires_at) ?? null;
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('basket_update_v1 expires_at must be a valid timestamp');
    }
    basket.expires_at = expiresAt;
    changed.expires_at = expiresAt;
  }
  for (const key of ['sort_branch_id', 'sort_service_key', 'sort_route_key', 'sort_priority_key']) {
    if (patch[key] !== undefined) {
      const next = asNonEmptyString(patch[key]) ?? null;
      basket[key] = next;
      changed[key] = next;
    }
  }

  basket.version = Number(basket.version ?? 1) + 1;
  basket.updated_at = new Date().toISOString();

  return buildEnvelope({
    basket_id: basketId,
    changed,
  }) as BasketUpdateMutationResult;
}

// ----------- Route plans / runs / stops -----------
//
// Stubs mirror the cloud `api.*` surface from these migrations:
//   - 202604032350_route_plan_ui_api_contract_v1.sql        (ui_create/freeze/apply)
//   - 202604041520_route_plan_sequence_optimizer_v1.sql     (ui_solve)
//   - 202604061030_route_plan_publish_execution_pack_v1.sql (ui_publish)
//   - 202604061315_route_plan_rebalance_v1.sql              (ui_rebalance)
//   - 202604061140_route_plan_constraint_guards_v1.sql      (route_plan_validate_constraints)
//   - 202604061430_uc076_route_run_assignment_lifecycle_foundation_v1.sql
//   - 202604081330_uc077_route_run_execution_manifest_reassignment_v1.sql
//   - 202604101500_uc082_route_run_scan_out_departure_gate_v1.sql
//   - 202604101715_uc078_route_stop_mid_execution_reassignment_v1.sql

async function requireLiveRoutePlanReadback(
  routePlanId: string,
  expectedStatus: string | null,
  rpcName: string,
): Promise<Record<string, unknown>> {
  const row = await requireLiveResourceReadback('route_plans', routePlanId, rpcName);
  const readbackPlanId =
    asNonEmptyString(row.id) ??
    asNonEmptyString(row.route_plan_id) ??
    asNonEmptyString(row.plan_id);
  if (!readbackPlanId) {
    throw new Error(`${rpcName} backend readback missing route_plan_id`);
  }
  if (readbackPlanId !== routePlanId) {
    throw new Error(`${rpcName} backend readback returned route_plan_id ${readbackPlanId}`);
  }
  const status = requireLiveStringField(
    row,
    ['status', 'route_plan_status'],
    `${rpcName} backend readback missing route plan status`,
  );
  if (expectedStatus && status !== expectedStatus) {
    throw new Error(`${rpcName} backend readback status ${status} did not match ${expectedStatus}`);
  }
  return row;
}

function routePlanConstraintValidationEvidence(
  mutationRow: Record<string, unknown>,
  readbackRow: Record<string, unknown>,
): Record<string, unknown> {
  const mutationValidation = objectRecord(mutationRow.constraint_validation);
  if (Object.keys(mutationValidation).length) return mutationValidation;

  const readbackValidation = objectRecord(readbackRow.constraint_validation);
  if (Object.keys(readbackValidation).length) return readbackValidation;

  const readbackMetadata = objectRecord(readbackRow.metadata);
  const metadataValidation = objectRecord(readbackMetadata.constraint_validation);
  if (Object.keys(metadataValidation).length) return metadataValidation;

  return {};
}

function routePlanConstraintFailCount(validation: Record<string, unknown>): number {
  const explicit = Number(validation.fail_count ?? validation.failure_count ?? validation.failed_count);
  if (Number.isFinite(explicit)) return explicit;

  const violations = validation.violations;
  if (Array.isArray(violations)) return violations.length;

  const failures = validation.failures;
  if (Array.isArray(failures)) return failures.length;

  return 0;
}

async function requireLiveRoutePlanExecutionPackReadback(
  routePlanId: string,
  executionPackHash: string,
  rpcName: string,
): Promise<void> {
  const live = await liveRpc<Record<string, unknown> | null>('ui_route_plan_execution_pack_v1', {
    p_route_plan_id: routePlanId,
  });
  if (!live) throw new Error(`${rpcName} execution-pack readback requires a live backend`);
  const row = firstRpcRow<Record<string, unknown>>(live.data);
  if (!row || Object.keys(row).length === 0) {
    throw new Error(`${rpcName} backend readback missing route-plan execution pack:${routePlanId}`);
  }
  const readbackHash = requireLiveStringField(
    row,
    ['execution_pack_hash', 'published_execution_pack_hash'],
    `${rpcName} backend readback missing execution_pack_hash`,
  );
  if (readbackHash !== executionPackHash) {
    throw new Error(`${rpcName} backend readback execution_pack_hash did not match`);
  }
}

async function requireLiveRouteRunsReadback(
  routePlanId: string,
  rpcName: string,
): Promise<void> {
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'route_runs',
    p_filters: { route_plan_id: routePlanId },
    p_limit: 25,
    p_offset: 0,
    p_sort: null,
  });
  if (!live) throw new Error(`${rpcName} route-run readback requires a live backend`);
  const rows = normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 25).rows;
  if (rows.length === 0) {
    throw new Error(`${rpcName} backend readback missing materialized route_runs:${routePlanId}`);
  }
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
  const live = await liveRpc('ui_create_route_plan_v1', {
    p_input: input,
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_create_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'workflow_run_id',
    ]);
    const routePlanId = requireLiveStringField(
      row,
      ['route_plan_id', 'plan_id', 'id'],
      'Route plan create did not return route_plan_id',
    );
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan create did not return status',
    );
    await requireLiveRoutePlanReadback(routePlanId, status, 'ui_create_route_plan_v1');
    return {
      ...row,
      ok: true,
      route_plan_id: routePlanId,
      status,
      plan_id: String(row.plan_id ?? routePlanId),
    };
  }

  await sleep(180);
  const id = 'rpl_new_' + Math.floor(Math.random() * 90000);
  return {
    ok: true,
    route_plan_id: id,
    status: 'draft',
    plan_id: `PLN-${input.planned_date.replaceAll('-', '').slice(2)}-${input.branch_id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`,
  };
}

export async function ui_solve_route_plan_v1(planId: string): Promise<{ ok: true; plan_id: string; status: string }> {
  const live = await liveRpc('ui_solve_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_solve_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'workflow_run_id',
    ]);
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan solve did not return status',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    await requireLiveRoutePlanReadback(routePlanId, status, 'ui_solve_route_plan_v1');
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      status,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, status: 'solved' };
}
export async function ui_freeze_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; status: string; constraint_validation: { fail_count: number } }> {
  const live = await liveRpc('ui_freeze_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_freeze_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'workflow_run_id',
    ]);
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan freeze did not return status',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    const readback = await requireLiveRoutePlanReadback(routePlanId, status, 'ui_freeze_route_plan_v1');
    const constraintValidation = routePlanConstraintValidationEvidence(row, readback);
    if (!Object.keys(constraintValidation).length) {
      throw new Error('Route plan freeze backend readback missing constraint validation');
    }
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      status,
      constraint_validation: {
        ...constraintValidation,
        fail_count: routePlanConstraintFailCount(constraintValidation),
      },
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, status: 'frozen', constraint_validation: { fail_count: 0 } };
}
export async function ui_publish_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; execution_pack_hash: string }> {
  const live = await liveRpc('ui_publish_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_publish_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'execution_pack_hash',
    ]);
    const executionPackHash = requireLiveStringField(
      row,
      ['execution_pack_hash', 'published_execution_pack_hash'],
      'Route plan publish did not return execution_pack_hash',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    await requireLiveRoutePlanReadback(routePlanId, 'published', 'ui_publish_route_plan_v1');
    await requireLiveRoutePlanExecutionPackReadback(
      routePlanId,
      executionPackHash,
      'ui_publish_route_plan_v1',
    );
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      execution_pack_hash: executionPackHash,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, execution_pack_hash: '0x' + Math.random().toString(16).slice(2, 10) };
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
  const live = await liveRpc<Record<string, unknown> | null>('ui_route_plan_execution_pack_v1', {
    p_route_plan_id: planId,
  });
  if (live) {
    const rec = firstRpcRow<Record<string, unknown>>(live.data);
    if (!rec) return null;
    return {
      ...rec,
      route_plan_id: String(rec.route_plan_id ?? planId),
      execution_pack_hash: asNonEmptyString(rec.execution_pack_hash) ?? undefined,
      stop_count: Number(rec.stop_count ?? 0),
      shipment_count: Number(rec.shipment_count ?? 0),
    };
  }

  await sleep(80);
  const plan = ((RESOURCE_DATA().route_plans ?? []) as Record<string, unknown>[])
    .find((row) => row.id === planId || row.plan_id === planId);
  const status = asNonEmptyString(plan?.status);
  if (!plan || (status !== 'published' && status !== 'applied')) return null;
  const stopCount = Number(plan.stops ?? 0);
  return {
    route_plan_id: String(plan.id ?? planId),
    route_plan_status: status,
    execution_pack_hash: asNonEmptyString(plan.execution_pack_hash ?? plan.published_execution_pack_hash) ?? `seed-${planId}`,
    stop_count: stopCount,
    shipment_count: stopCount,
  };
}
export async function ui_apply_route_plan_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; status: string; runs_materialized: number }> {
  const live = await liveRpc('ui_apply_route_plan_v1', {
    p_input: { route_plan_id: planId },
  });
  if (live) {
    const rows = Array.isArray(live.data) ? live.data : [];
    const row = requireLiveMutationResult(live.data, 'ui_apply_route_plan_v1', [
      'route_plan_id',
      'plan_id',
      'route_run_id',
      'route_run_ids',
      'runs_materialized',
    ]);
    const routeRunIds = Array.isArray(row.route_run_ids) ? row.route_run_ids : [];
    const singleRouteRunId = asNonEmptyString(row.route_run_id);
    const runsMaterialized =
      rows.length ||
      routeRunIds.length ||
      (singleRouteRunId ? 1 : Number(row.runs_materialized ?? row.run_count));
    if (!Number.isFinite(runsMaterialized) || runsMaterialized <= 0) {
      throw new Error('Route plan apply did not return materialized route-run evidence');
    }
    const status = requireLiveStringField(
      row,
      ['status', 'route_plan_status'],
      'Route plan apply did not return status',
    );
    const routePlanId = String(row.route_plan_id ?? row.plan_id ?? planId);
    await requireLiveRoutePlanReadback(routePlanId, status, 'ui_apply_route_plan_v1');
    await requireLiveRouteRunsReadback(routePlanId, 'ui_apply_route_plan_v1');
    return {
      ...row,
      ok: true,
      plan_id: routePlanId,
      status,
      runs_materialized: runsMaterialized,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: planId, status: 'applied', runs_materialized: 18 };
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
  const shipmentIds = Array.isArray(input.shipment_ids) ? input.shipment_ids : [];
  const live = await liveRpc('ui_rebalance_route_plan_v1', {
    p_input: input,
  });
  if (live) {
    const row = requireLiveMutationResult(live.data, 'ui_rebalance_route_plan_v1', [
      'source_route_plan_id',
      'target_route_plan_id',
      'moved_stop_count',
      'moves_applied',
      'workflow_run_id',
    ]);
    const movesApplied = requireLiveNumberField(
      row,
      ['moved_stop_count', 'moves_applied', 'count', 'affected_count'],
      'Route plan rebalance did not return moved stop count',
    );
    const sourceRoutePlanId = requireLiveStringField(
      row,
      ['source_route_plan_id'],
      'Route plan rebalance did not return source_route_plan_id',
    );
    const targetRoutePlanId = requireLiveStringField(
      row,
      ['target_route_plan_id'],
      'Route plan rebalance did not return target_route_plan_id',
    );
    if (sourceRoutePlanId !== input.source_route_plan_id) {
      throw new Error('Route plan rebalance returned a different source_route_plan_id');
    }
    if (input.target_route_plan_id && targetRoutePlanId !== input.target_route_plan_id) {
      throw new Error('Route plan rebalance returned a different target_route_plan_id');
    }
    await requireLiveRoutePlanReadback(
      sourceRoutePlanId,
      asNonEmptyString(row.source_status) ?? null,
      'ui_rebalance_route_plan_v1 source',
    );
    await requireLiveRoutePlanReadback(
      targetRoutePlanId,
      asNonEmptyString(row.target_status) ?? null,
      'ui_rebalance_route_plan_v1 target',
    );
    return {
      ...row,
      ok: true,
      plan_id: sourceRoutePlanId,
      moves_applied: movesApplied,
    };
  }

  await sleep(180);
  return { ok: true, plan_id: input.source_route_plan_id, moves_applied: shipmentIds.length };
}

export interface RoutePlanConstraintCheck {
  name: string;
  passed: number;
  failed: number;
  status: 'pass' | 'warn' | 'danger';
  detail?: string;
}

function routePlanConstraintStatus(value: unknown, failed: number): RoutePlanConstraintCheck['status'] {
  const status = asNonEmptyString(value);
  if (status === 'pass' || status === 'warn' || status === 'danger') return status;
  return failed > 0 ? 'danger' : 'pass';
}

function normalizeRoutePlanConstraintItem(value: unknown, index: number): RoutePlanConstraintCheck {
  const rec = objectRecord(value);
  if (!Object.keys(rec).length) {
    throw new Error(`Route plan constraint validation check ${index + 1} missing backend evidence`);
  }
  const failed = requireLiveNumberField(
    rec,
    ['failed', 'fail_count', 'failed_count'],
    `Route plan constraint validation check ${index + 1} missing failed count`,
  );
  const passed = requireLiveNumberField(
    rec,
    ['passed', 'pass_count', 'passed_count'],
    `Route plan constraint validation check ${index + 1} missing passed count`,
  );
  return {
    name: requireLiveStringField(
      rec,
      ['name', 'check_name', 'code'],
      `Route plan constraint validation check ${index + 1} missing name`,
    ),
    passed,
    failed,
    status: routePlanConstraintStatus(rec.status, failed),
    detail: asNonEmptyString(rec.detail) ?? asNonEmptyString(rec.message) ?? undefined,
  };
}

function normalizeCanonicalRoutePlanConstraintItems(rec: Record<string, unknown>): RoutePlanConstraintCheck[] {
  if (typeof rec.valid !== 'boolean') {
    throw new Error('Route plan constraint validation did not return valid flag');
  }
  if (!Array.isArray(rec.violations)) {
    throw new Error('Route plan constraint validation did not return constraint check evidence');
  }
  if (rec.violations.length === 0) {
    if (rec.valid !== true) {
      throw new Error('Route plan constraint validation did not return violation evidence');
    }
    return [{
      name: rec.enabled === false ? 'route_plan_constraint_policy_disabled' : 'route_plan_constraints',
      passed: 1,
      failed: 0,
      status: 'pass',
    }];
  }
  return rec.violations.map((value, index) => {
    const violation = objectRecord(value);
    if (!Object.keys(violation).length) {
      throw new Error(`Route plan constraint validation violation ${index + 1} missing backend evidence`);
    }
    return {
      name: asNonEmptyString(violation.code) ?? `constraint_violation_${index + 1}`,
      passed: 0,
      failed: 1,
      status: routePlanConstraintStatus(violation.status, 1),
      detail: asNonEmptyString(violation.message) ?? asNonEmptyString(violation.detail) ?? undefined,
    };
  });
}

export async function route_plan_validate_constraints_v1(
  planId: string,
): Promise<{ ok: true; plan_id: string; fail_count: number; items: RoutePlanConstraintCheck[] }> {
  const live = await liveRpc<Record<string, unknown>>('route_plan_validate_constraints_v1', {
    p_route_plan_id: planId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'route_plan_validate_constraints_v1 returned no backend validation outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'route_plan_validate_constraints_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const routePlanId = requireLiveStringField(
      rec,
      ['route_plan_id', 'plan_id'],
      'Route plan constraint validation did not return route_plan_id',
    );
    if (routePlanId !== planId) {
      throw new Error('Route plan constraint validation returned a different route_plan_id');
    }
    requireLiveEvidence(
      rec,
      ['items', 'checks', 'validated_at', 'settings_id', 'settings_version_id', 'policy_version'],
      'route_plan_validate_constraints_v1 did not return backend validation evidence',
    );
    const directItems = Array.isArray(rec.items)
      ? rec.items
      : Array.isArray(rec.checks)
        ? rec.checks
        : [];
    const items = directItems.length > 0
      ? directItems.map(normalizeRoutePlanConstraintItem)
      : normalizeCanonicalRoutePlanConstraintItems(rec);
    if (items.length === 0) {
      throw new Error('Route plan constraint validation did not return constraint check evidence');
    }
    const failCount = Number.isFinite(Number(rec.fail_count))
      ? Number(rec.fail_count)
      : items.reduce((acc, item) => acc + Number(item.failed ?? 0), 0);
    return {
      ok: true,
      plan_id: routePlanId,
      fail_count: failCount,
      items,
    };
  }

  await sleep(120);
  const items: RoutePlanConstraintCheck[] = [
    { name: 'Driver capabilities', passed: 5, failed: 0, status: 'pass' },
    { name: 'Vehicle type fit', passed: 5, failed: 0, status: 'pass' },
    {
      name: 'Vehicle metadata (refrig / hazmat)',
      passed: 4,
      failed: 1,
      status: 'warn',
      detail: 'plan stop 18 requires refrig vehicle but assigned vehicle has no refrig metadata',
    },
    { name: 'Working-hours window', passed: 5, failed: 0, status: 'pass' },
    { name: 'Stop time-windows', passed: 5, failed: 0, status: 'pass' },
    { name: 'Hub cutoff', passed: 5, failed: 0, status: 'pass' },
  ];
  const fail_count = items.reduce((acc, c) => acc + c.failed, 0);
  return { ok: true, plan_id: planId, fail_count, items };
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

function responseStatusForRouteRunAssignmentAction(actionKey: string): string {
  switch (actionKey) {
    case 'route_runs.acknowledge_assignment':
      return 'acknowledged';
    case 'route_runs.accept_assignment':
      return 'accepted';
    case 'route_runs.refuse_assignment':
      return 'refused';
    default:
      return 'assigned';
  }
}

export async function ui_execute_route_run_assign_v1(
  runId: string,
  target: RouteRunAssignTarget | unknown,
): Promise<{ ok: true; run_id: string; target: RouteRunAssignTarget | unknown }> {
  const live = await liveRpc<Record<string, unknown>>('ui_execute_route_run_assign_v1', {
    p_action_key: 'route_runs.assign',
    p_resource_key: 'route_runs',
    p_selection_ids: [runId],
    p_selection_id: runId,
    p_selection_count: 1,
    p_params: target && typeof target === 'object' ? target as Record<string, unknown> : { target },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_route_run_assign_v1', [
      'route_run_id',
      'run_id',
      'assignment_id',
      'route_run_assignment_id',
      'count',
      'status',
    ]);
    const resolvedRunId = String(rec.route_run_id ?? rec.run_id ?? runId);
    await requireLiveRouteRunAssignmentReadback('ui_execute_route_run_assign_v1', resolvedRunId, rec);
    return { ...rec, ok: true, run_id: String(rec.route_run_id ?? rec.run_id ?? runId), target } as {
      ok: true;
      run_id: string;
      target: RouteRunAssignTarget | unknown;
    };
  }

  await sleep(80);
  return { ok: true, run_id: runId, target };
}

export async function ui_execute_route_run_assignment_response_v1(
  runId: string,
  actionKey: string,
  params: RouteRunAssignmentResponseParams = {},
): Promise<RouteRunAssignmentResponseResult> {
  const responseStatus = responseStatusForRouteRunAssignmentAction(actionKey);
  const live = await liveRpc<Record<string, unknown>>('ui_execute_route_run_assignment_response_v1', {
    p_action_key: actionKey,
    p_resource_key: 'routes',
    p_selection_ids: [runId],
    p_selection_id: runId,
    p_selection_count: 1,
    p_params: compactRecord({
      ...params,
      response_status: responseStatus,
    }),
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_route_run_assignment_response_v1', [
      'status',
      'items',
      'count',
    ]);
    const items = Array.isArray(rec.items) ? rec.items : [];
    const item = objectRecord(items[0]);
    const resolvedRunId = asNonEmptyString(item.route_run_id) ?? asNonEmptyString(rec.route_run_id) ?? runId;
    const assignmentStatus =
      asNonEmptyString(item.assignment_status) ??
      asNonEmptyString(rec.assignment_status) ??
      asNonEmptyString(rec.status) ??
      responseStatus;
    const assignmentId =
      asNonEmptyString(item.route_run_assignment_id) ??
      asNonEmptyString(rec.route_run_assignment_id) ??
      asNonEmptyString(rec.assignment_id);
    await requireLiveRouteRunAssignmentReadback(
      'ui_execute_route_run_assignment_response_v1',
      resolvedRunId,
      { ...rec, ...item, route_run_assignment_id: assignmentId },
    );
    const assignment = assignmentId
      ? await requireLiveResourceReadback(
          'route_run_assignments',
          assignmentId,
          'ui_execute_route_run_assignment_response_v1',
        )
      : (await requireLiveResourceListReadback(
          'route_run_assignments',
          { route_run_id: resolvedRunId },
          'ui_execute_route_run_assignment_response_v1',
        ))[0];
    if (assignment && asNonEmptyString(assignment.assignment_status) !== assignmentStatus) {
      throw new Error('ui_execute_route_run_assignment_response_v1 backend readback assignment_status mismatch');
    }
    return {
      ...rec,
      ...item,
      ok: true,
      run_id: resolvedRunId,
      route_run_id: resolvedRunId,
      route_run_assignment_id: assignmentId ?? undefined,
      assignment_status: assignmentStatus,
      assignment_version: Number(item.assignment_version ?? rec.assignment_version) || undefined,
      responded_by_user_id: asNonEmptyString(item.responded_by_user_id) ?? null,
      acknowledged_at: asNonEmptyString(item.acknowledged_at) ?? null,
      accepted_at: asNonEmptyString(item.accepted_at) ?? null,
      refused_at: asNonEmptyString(item.refused_at) ?? null,
      refusal_reason: asNonEmptyString(item.refusal_reason) ?? null,
      response_notes: asNonEmptyString(item.response_notes) ?? null,
      created: typeof item.created === 'boolean' ? item.created : undefined,
    };
  }

  await sleep(80);
  return {
    ok: true,
    run_id: runId,
    route_run_id: runId,
    assignment_status: responseStatus,
  };
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
  const live = await liveRpc<Record<string, unknown>>('ui_execute_route_stop_reassign_v1', {
    p_action_key: 'route_stops.reassign',
    p_resource_key: 'route_stops',
    p_selection_ids: stopIds,
    p_selection_id: stopIds.length === 1 ? stopIds[0] : null,
    p_selection_count: stopIds.length,
    p_params: target && typeof target === 'object' ? target as Record<string, unknown> : { target },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_route_stop_reassign_v1', [
      'route_stop_reassignment_event_id',
      'route_run_assignment_id',
      'assignment_id',
      'count',
      'success_count',
      'affected_count',
      'status',
    ]);
    const count = requireLiveNumberField(
      rec,
      ['count', 'success_count', 'affected_count'],
      'Route stop reassignment did not return affected count',
    );
    const targetRecord = target && typeof target === 'object' ? target as Record<string, unknown> : {};
    const targetRouteRunId = asNonEmptyString(targetRecord.target_route_run_id);
    for (const stopId of stopIds) {
      const stop = await requireLiveResourceReadback('route_stops', stopId, 'ui_execute_route_stop_reassign_v1');
      if (targetRouteRunId && asNonEmptyString(stop.route_run_id) !== targetRouteRunId) {
        throw new Error('ui_execute_route_stop_reassign_v1 backend readback route_stop target route_run_id did not match');
      }
    }
    const assignmentId = asNonEmptyString(rec.route_run_assignment_id) ?? asNonEmptyString(rec.assignment_id);
    if (assignmentId) {
      await requireLiveResourceReadback('route_run_assignments', assignmentId, 'ui_execute_route_stop_reassign_v1');
    } else if (targetRouteRunId) {
      await requireLiveResourceListReadback(
        'route_run_assignments',
        { route_run_id: targetRouteRunId },
        'ui_execute_route_stop_reassign_v1',
      );
    }
    const eventId =
      asNonEmptyString(rec.route_stop_reassignment_event_id) ??
      asNonEmptyString(rec.reassignment_event_id) ??
      asNonEmptyString(rec.event_id);
    if (eventId) {
      await requireLiveResourceReadback('route_stop_reassignment_events', eventId, 'ui_execute_route_stop_reassign_v1');
    } else {
      for (const stopId of stopIds) {
        await requireLiveResourceListReadback(
          'route_stop_reassignment_events',
          { route_stop_id: stopId },
          'ui_execute_route_stop_reassign_v1',
        );
      }
    }
    return {
      ...rec,
      ok: true,
      count,
      target,
      assignment_status: String(rec.assignment_status ?? rec.status),
    } as { ok: true; count: number; target: RouteStopReassignTarget | unknown; assignment_status: string };
  }

  await sleep(80);
  return { ok: true, count: stopIds.length, target, assignment_status: 'reassigned' };
}
export async function ui_confirm_route_run_departure_v1(
  runId: string,
): Promise<{ ok: true; departure_confirmed_at: string; run_id: string }> {
  const live = await liveRpc<Record<string, unknown>>('ui_confirm_route_run_departure_v1', {
    p_input: { route_run_id: runId },
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Departure confirmation returned no backend outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'Departure confirmation was rejected by the backend');
    if (outcomeError) throw outcomeError;
    if (String(rec.status ?? '').trim().toLowerCase() === 'route_departure_blocked') {
      const rawError = objectRecord(rec.error);
      const message =
        asNonEmptyString(rawError.message) ??
        asNonEmptyString(rec.message) ??
        asNonEmptyString(rawError.code) ??
        'Departure confirmation was blocked by scan-out reconciliation';
      throw new Error(message);
    }
    const routeRunId = String(rec.route_run_id ?? rec.run_id ?? runId);
    const routeRun = await requireLiveResourceReadback('route_runs', routeRunId, 'ui_confirm_route_run_departure_v1');
    const metadata = objectRecord(routeRun.metadata);
    const rpcDeparture = objectRecord(rec.route_departure);
    const routeRunDeparture = objectRecord(routeRun.route_departure);
    const metadataRouteDeparture = objectRecord(metadata.route_departure);
    const readbackConfirmedAt =
      asNonEmptyString(routeRunDeparture.confirmed_at) ??
      asNonEmptyString(metadataRouteDeparture.confirmed_at);
    if (!readbackConfirmedAt) {
      throw new Error('ui_confirm_route_run_departure_v1 backend readback missing route_runs departure confirmation');
    }
    const confirmedAt =
      asNonEmptyString(rpcDeparture.confirmed_at) ??
      asNonEmptyString(rec.departure_confirmed_at) ??
      asNonEmptyString(rec.confirmed_at) ??
      readbackConfirmedAt;
    return {
      ...rec,
      ok: true,
      departure_confirmed_at: confirmedAt,
      run_id: routeRunId,
    } as { ok: true; departure_confirmed_at: string; run_id: string };
  }

  await sleep(120);
  return { ok: true, departure_confirmed_at: new Date().toISOString(), run_id: runId };
}
export async function route_run_scan_out_reconciliation_v1(
  runId: string,
): Promise<{ ok: true; expected: number; scanned: number; discrepancies: string[]; run_id: string }> {
  const live = await liveRpc<Record<string, unknown>>('route_run_scan_out_reconciliation_v1', {
    p_route_run_id: runId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Scan-out reconciliation returned no backend outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'Scan-out reconciliation was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const expected = requireLiveNumberField(
      rec,
      ['expected', 'expected_count', 'expected_stop_count', 'expected_shipment_count'],
      'Scan-out reconciliation did not return an expected count',
    );
    const scanned = requireLiveNumberField(
      rec,
      ['scanned', 'scanned_count', 'scanned_stop_count', 'scanned_shipment_count'],
      'Scan-out reconciliation did not return a scanned count',
    );
    const rawDiscrepancies = Array.isArray(rec.discrepancies) ? rec.discrepancies.map(String) : [];
    const missingCount = Number(rec.missing_stop_count ?? rec.missing_shipment_count ?? 0);
    const unexpectedCount = Number(rec.unexpected_scan_count ?? 0);
    const duplicateCount = Number(rec.duplicate_scan_count ?? 0);
    const synthesizedDiscrepancies = [
      ...rawDiscrepancies,
      ...(missingCount > 0 ? [`Missing ${missingCount} route load scan${missingCount === 1 ? '' : 's'}`] : []),
      ...(unexpectedCount > 0 ? [`Unexpected ${unexpectedCount} route load scan${unexpectedCount === 1 ? '' : 's'}`] : []),
      ...(duplicateCount > 0 ? [`Duplicate ${duplicateCount} route load scan${duplicateCount === 1 ? '' : 's'}`] : []),
    ];
    if (rec.ready_for_departure === false && synthesizedDiscrepancies.length === 0) {
      synthesizedDiscrepancies.push('Route load scan-out is not ready for departure');
    }
    const routeRunId = String(rec.route_run_id ?? rec.run_id ?? runId);
    await requireLiveResourceReadback('route_runs', routeRunId, 'route_run_scan_out_reconciliation_v1');
    if (expected > 0) {
      await requireLiveResourceListReadback(
        'route_stops',
        { route_run_id: routeRunId },
        'route_run_scan_out_reconciliation_v1',
      );
    }
    return {
      ...rec,
      ok: true,
      expected,
      scanned,
      discrepancies: synthesizedDiscrepancies,
      run_id: routeRunId,
    } as { ok: true; expected: number; scanned: number; discrepancies: string[]; run_id: string };
  }

  await sleep(80);
  return { ok: true, expected: 22, scanned: 22, discrepancies: [], run_id: runId };
}

// ----------- Pickups -----------
function pickupFilter(filter?: unknown): Record<string, unknown> {
  const rec = objectRecord(filter);
  const nested = objectRecord(rec.filter ?? rec.filters ?? rec);
  if (rec.filter == null && rec.filters == null) return nested;
  return {
    ...nested,
    limit: rec.limit ?? nested.limit,
    page_size: rec.page_size ?? nested.page_size,
    pageSize: rec.pageSize ?? nested.pageSize,
    page: rec.page ?? nested.page,
    offset: rec.offset ?? nested.offset,
    p_offset: rec.p_offset ?? nested.p_offset,
  };
}

function pickupLimit(filter: Record<string, unknown>): number {
  const raw = filter.limit ?? filter.page_size ?? filter.pageSize;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 100;
}

function pickupOffset(filter: Record<string, unknown>, limit: number): number {
  const raw = filter.offset ?? filter.p_offset;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const rawPage = filter.page;
  const page = typeof rawPage === 'number' ? rawPage : Number(rawPage);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) * limit : 0;
}

function pickupHasExplicitPagination(filter: Record<string, unknown>): boolean {
  return (
    filter.limit != null ||
    filter.page_size != null ||
    filter.pageSize != null ||
    filter.page != null ||
    filter.offset != null ||
    filter.p_offset != null
  );
}

function pickupUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return values.length ? values : null;
}

function normalizePickupRows(data: unknown, idKey: string): Record<string, unknown>[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(objectRecord(data).rows)
      ? objectRecord(data).rows as unknown[]
      : [];
  return rows.map((row) => {
    const rec = objectRecord(row);
    const id = rec.id ?? rec[idKey];
    return id == null ? rec : { id: String(id), ...rec };
  });
}

async function requireLivePickupWaveReadback(
  routeRunId: string,
  rpcName: string,
  expectedDriverUserId?: string | null,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>[] | { rows?: Record<string, unknown>[] }>(
    'pickup_waves_list_v1',
    {
      p_route_run_ids: [routeRunId],
      p_status: null,
      p_limit: 1,
      p_offset: 0,
    },
  );
  if (!live) throw new Error(`${rpcName} pickup-wave readback requires a live backend`);
  const row = normalizePickupRows(live.data, 'route_run_id')
    .find((candidate) => {
      const id =
        asNonEmptyString(candidate.route_run_id) ??
        asNonEmptyString(candidate.id);
      return id === routeRunId;
    });
  if (!row) {
    throw new Error(`${rpcName} backend readback missing pickup wave:${routeRunId}`);
  }
  if (expectedDriverUserId) {
    const readbackDriverUserId = asNonEmptyString(row.driver_user_id);
    if (readbackDriverUserId !== expectedDriverUserId) {
      throw new Error(`${rpcName} backend readback did not persist pickup driver assignment`);
    }
    const assignments = await requireLiveResourceListReadback(
      'route_run_assignments',
      { route_run_id: routeRunId },
      rpcName,
    );
    const activeAssignment = assignments.find((assignment) =>
      !['cancelled', 'canceled', 'completed'].includes(String(assignment.assignment_status ?? '').toLowerCase()),
    );
    if (asNonEmptyString(activeAssignment?.driver_user_id) !== expectedDriverUserId) {
      throw new Error(`${rpcName} backend readback did not persist Dispatch route assignment`);
    }
    await requireLiveResourceListReadback('route_run_assignment_events', { route_run_id: routeRunId }, rpcName);
    const stops = await requireLiveResourceListReadback('route_stops', { route_run_id: routeRunId }, rpcName);
    for (const stop of stops) {
      const stopId = asNonEmptyString(stop.id);
      if (!stopId) continue;
      const tasks = await requireLiveResourceListReadback(
        'tasks',
        {
          task_type_key: 'route_stop_execute',
          resource_type: 'route_stop',
          resource_id: stopId,
        },
        rpcName,
      );
      if (!tasks.some((task) =>
        asNonEmptyString(task.task_type_key ?? task.task_type) === 'route_stop_execute'
        && asNonEmptyString(task.assigned_to) === expectedDriverUserId,
      )) {
        throw new Error(`${rpcName} backend readback did not assign Dispatch route-stop task ${stopId}`);
      }
    }
  }
  return row;
}

async function livePickupRows(
  rpcName: string,
  args: Record<string, unknown>,
  idKey: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>[] | null> {
  const limit = pickupLimit(params);
  const firstOffset = pickupOffset(params, limit);
  const explicitPagination = pickupHasExplicitPagination(params);
  const rows: Record<string, unknown>[] = [];

  for (let offset = firstOffset; ; offset += limit) {
    const live = await liveRpc<Record<string, unknown>[] | { rows?: Record<string, unknown>[] }>(
      rpcName,
      {
        ...args,
        p_limit: limit,
        p_offset: offset,
      },
    );
    if (!live) return null;
    const pageRows = normalizePickupRows(live.data, idKey);
    rows.push(...pageRows);
    if (explicitPagination || pageRows.length < limit || pageRows.length === 0) break;
  }

  return rows;
}

export async function pickup_requests_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const params = pickupFilter(filter);
  const rows = await livePickupRows(
    'pickup_requests_list_v1',
    {
      p_client_id: asNonEmptyString(params.client_id) ?? null,
      p_sender_id: asNonEmptyString(params.sender_id) ?? null,
      p_status: asNonEmptyString(params.status) ?? null,
    },
    'shipment_id',
    params,
  );
  if (rows) {
    return { rows, total: rows.length };
  }

  await sleep(40);
  return { rows: pickupRequestsSeed(), total: 14 };
}
export async function pickup_waves_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const params = pickupFilter(filter);
  const rows = await livePickupRows(
    'pickup_waves_list_v1',
    {
      p_route_run_ids: pickupUuidArray(params.route_run_ids ?? params.routeRunIds ?? params.ids),
      p_status: asNonEmptyString(params.status) ?? null,
    },
    'route_run_id',
    params,
  );
  if (rows) {
    return { rows, total: rows.length };
  }

  await sleep(40);
  return { rows: pickupWavesSeed(), total: 6 };
}
export async function pickup_failures_list_v1(
  filter?: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const params = pickupFilter(filter);
  const rows = await livePickupRows(
    'pickup_failures_list_v1',
    {
      p_shipment_ids: pickupUuidArray(params.shipment_ids ?? params.shipmentIds ?? params.ids),
      p_client_id: asNonEmptyString(params.client_id) ?? null,
      p_sender_id: asNonEmptyString(params.sender_id) ?? null,
      p_status: asNonEmptyString(params.status) ?? null,
    },
    'shipment_id',
    params,
  );
  if (rows) {
    return { rows, total: rows.length };
  }

  await sleep(40);
  return { rows: pickupFailuresSeed(), total: 3 };
}

async function requireLivePickupRequestReadback(
  shipmentId: string,
  rpcName: string,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>[] | { rows?: Record<string, unknown>[] }>(
    'pickup_requests_list_v1',
    {
      p_client_id: null,
      p_sender_id: null,
      p_status: null,
      p_limit: 100,
      p_offset: 0,
    },
  );
  if (!live) throw new Error(`${rpcName} pickup-request readback requires a live backend`);
  const row = normalizePickupRows(live.data, 'shipment_id')
    .find((candidate) => {
      const id =
        asNonEmptyString(candidate.shipment_id) ??
        asNonEmptyString(candidate.id);
      return id === shipmentId;
    });
  if (!row) {
    throw new Error(`${rpcName} backend readback missing pickup request:${shipmentId}`);
  }
  return row;
}

export async function create_pickup_request_v1(payload: unknown): Promise<{
  ok: true;
  shipment_id: string;
  tracking_number?: string;
  created?: boolean;
  operation?: string;
  [key: string]: unknown;
}> {
  const live = await liveRpc<Record<string, unknown>>('create_pickup_request_v1', {
    p_input: objectRecord(payload),
  });
  if (live) {
    const rec = (live.data ?? {}) as Record<string, unknown>;
    if (rec.ok === false) {
      const error = objectRecord(rec.error);
      throw new Error(String(error.message ?? error.code ?? 'create_pickup_request_v1 failed'));
    }
    const shipmentId = asNonEmptyString(rec.shipment_id);
    if (!shipmentId) throw new Error('create_pickup_request_v1 response missing shipment_id');
    await requireLivePickupRequestReadback(shipmentId, 'create_pickup_request_v1');
    return {
      ok: true,
      shipment_id: shipmentId,
      ...rec,
    };
  }

  await sleep(120);
  return {
    ok: true,
    shipment_id: 'shp_pickup_' + Date.now(),
    tracking_number: 'PICKUP-SEED-' + Date.now(),
    created: true,
    operation: 'created',
  };
}

export async function create_pickup_wave_v1(payload: unknown): Promise<{ ok: true; wave_id: string }> {
  const live = await liveRpc<Record<string, unknown>>('create_pickup_wave_v1', {
    p_input: objectRecord(payload),
  });
  if (live) {
    const rec = (live.data ?? {}) as Record<string, unknown>;
    if (rec.ok === false) {
      const error = objectRecord(rec.error);
      throw new Error(String(error.message ?? error.code ?? 'create_pickup_wave_v1 failed'));
    }
    const waveId = asNonEmptyString(rec.wave_id ?? rec.route_run_id);
    if (!waveId) throw new Error('create_pickup_wave_v1 response missing route_run_id');
    await requireLivePickupWaveReadback(waveId, 'create_pickup_wave_v1');
    return {
      ok: true,
      wave_id: waveId,
      ...rec,
    } as { ok: true; wave_id: string };
  }

  await sleep(120);
  return { ok: true, wave_id: 'pwv_' + Date.now() };
}
export async function assign_pickup_wave_v1(
  waveId: string,
  target: unknown,
): Promise<{ ok: true; wave_id: string; target: unknown }> {
  const targetRecord = objectRecord(target);
  const routeRunId = asNonEmptyString(targetRecord.route_run_id) ?? waveId;
  const driverTargetId = asNonEmptyString(targetRecord.driver_user_id) ?? 'partner';
  const inputRecord: Record<string, unknown> = {
    ...targetRecord,
    route_run_id: routeRunId,
    idempotency_key: asNonEmptyString(targetRecord.idempotency_key)
      ?? `console-v2:assign_pickup_wave_v1:${routeRunId}:${driverTargetId}`,
  };
  const live = await liveRpc<Record<string, unknown>>('assign_pickup_wave_v1', {
    p_input: inputRecord,
  });
  if (live) {
    const rec = (live.data ?? {}) as Record<string, unknown>;
    if (rec.ok === false) {
      const error = objectRecord(rec.error);
      throw new Error(String(error.message ?? error.code ?? 'assign_pickup_wave_v1 failed'));
    }
    const waveIdOut = asNonEmptyString(rec.wave_id ?? rec.route_run_id ?? waveId);
    if (!waveIdOut) throw new Error('assign_pickup_wave_v1 response missing route_run_id');
    await requireLivePickupWaveReadback(
      waveIdOut,
      'assign_pickup_wave_v1',
      asNonEmptyString(inputRecord.driver_user_id),
    );
    return {
      ok: true,
      wave_id: waveIdOut,
      target,
      ...rec,
    } as { ok: true; wave_id: string; target: unknown };
  }

  await sleep(80);
  return { ok: true, wave_id: waveId, target };
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

function dispatchResolutionString(resolution: unknown): string {
  if (typeof resolution === 'string' && resolution.trim()) return resolution.trim();
  const rec = objectRecord(resolution);
  return (
    asNonEmptyString(rec.resolution_action) ??
    asNonEmptyString(rec.ndr_action) ??
    asNonEmptyString(rec.resolution) ??
    'reschedule'
  );
}

function materializeDispatchResolutionArgs(
  taskId: string,
  resolution: unknown,
  opts: DispatchExceptionResolutionOpts,
): { dryRun: boolean; resolutionStr: string; canonical: DispatchExceptionResolutionCanonicalArgs } {
  const dryRun = !!opts.dryRun;
  const resolutionStr = dispatchResolutionString(resolution);
  const resolutionRec = objectRecord(resolution);
  const params = {
    ...objectRecord(opts.canonical?.params),
  };
  if (!asNonEmptyString(params.resolution_action ?? params.ndr_action)) {
    params.resolution_action = resolutionStr;
  }
  const notes = asNonEmptyString(resolutionRec.resolution_notes ?? resolutionRec.notes);
  if (notes && !asNonEmptyString(params.resolution_notes)) {
    params.resolution_notes = notes;
  }
  if (dryRun && params.dry_run === undefined) {
    params.dry_run = true;
  }

  return {
    dryRun,
    resolutionStr,
    canonical: {
      action_key: opts.canonical?.action_key ?? 'dispatch_exception_review.complete',
      resource_key: opts.canonical?.resource_key ?? 'dispatch_exception_review',
      selection_ids: opts.canonical?.selection_ids ?? [taskId],
      selection_id: opts.canonical?.selection_id ?? taskId,
      selection_count: opts.canonical?.selection_count ?? 1,
      params,
    },
  };
}

function normalizeDispatchResolutionLiveResult(
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

type DispatchExceptionResolutionResult = ReturnType<typeof normalizeDispatchResolutionLiveResult>;

async function requireLiveDispatchExceptionResolutionReadback(
  result: DispatchExceptionResolutionResult,
  canonical: DispatchExceptionResolutionCanonicalArgs,
): Promise<void> {
  const resultRows = result.results.map((row) => objectRecord(row));
  const taskIds = new Set<string>();
  const taskEventIds = new Set<string>();
  const workflowRunIds = new Set<string>();
  const shipmentActionIds = new Set<string>();

  for (const id of [result.task_id, canonical.selection_id, ...canonical.selection_ids]) {
    const normalized = asNonEmptyString(id);
    if (normalized) taskIds.add(normalized);
  }

  for (const row of resultRows) {
    for (const key of ['task_id', 'id', 'downstream_task_id', 'manual_review_task_id', 'resolution_task_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) taskIds.add(normalized);
    }
    for (const key of ['task_event_id', 'downstream_task_event_id', 'resolution_task_event_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) taskEventIds.add(normalized);
    }
    for (const key of ['workflow_run_id', 'resolution_workflow_run_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) workflowRunIds.add(normalized);
    }
    for (const key of ['shipment_action_id', 'resolution_direct_shipment_action_id']) {
      const normalized = asNonEmptyString(row[key]);
      if (normalized) shipmentActionIds.add(normalized);
    }
  }

  if (taskIds.size === 0) {
    throw new Error('ui_execute_dispatch_exception_resolution_v1 did not return task readback evidence');
  }

  await Promise.all([...taskIds].map((taskId) =>
    requireLiveResourceReadback('tasks', taskId, 'ui_execute_dispatch_exception_resolution_v1'),
  ));
  await Promise.all([...taskEventIds].map((taskEventId) =>
    requireLiveResourceReadback('task_events', taskEventId, 'ui_execute_dispatch_exception_resolution_v1'),
  ));
  await Promise.all([...workflowRunIds].flatMap((workflowRunId) => [
    requireLiveResourceReadback('workflow_runs', workflowRunId, 'ui_execute_dispatch_exception_resolution_v1'),
    requireLiveResourceListReadback(
      'workflow_run_steps',
      { workflow_run_id: workflowRunId },
      'ui_execute_dispatch_exception_resolution_v1',
    ),
  ]));
  await Promise.all([...shipmentActionIds].map((shipmentActionId) =>
    requireLiveResourceReadback('shipment_actions', shipmentActionId, 'ui_execute_dispatch_exception_resolution_v1'),
  ));
}

function normalizeScanEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const rec = objectRecord(payload);
  const scanType = asNonEmptyString(rec.scan_type) ?? 'scan';
  const metadataIn = objectRecord(rec.metadata);
  const barcode =
    asNonEmptyString(rec.barcode) ??
    asNonEmptyString(rec.tracking_number) ??
    asNonEmptyString(rec.trackingNumber) ??
    asNonEmptyString(rec.handling_unit_code) ??
    asNonEmptyString(rec.warehouse_transfer_code) ??
    asNonEmptyString(rec.shipment_id);
  const link =
    asNonEmptyString(rec.route_stop_id) ??
    asNonEmptyString(rec.warehouse_transfer_id) ??
    asNonEmptyString(rec.shipment_id) ??
    asNonEmptyString(rec.handling_unit_id);
  return {
    ...rec,
    scan_type: scanType,
    ...(barcode ? { barcode } : {}),
    metadata: {
      ...metadataIn,
      ...(rec.tracking_number && !metadataIn.tracking_number ? { tracking_number: rec.tracking_number } : {}),
    },
    idempotency_key:
      asNonEmptyString(rec.idempotency_key) ??
      ['console-v2', scanType, barcode ?? 'unbound', link ?? ''].filter(Boolean).join(':'),
  };
}

const CONSOLE_DISPATCH_SCAN_DEVICE_STORAGE_KEY = 'nzxmhryhtqlzoshjkyozkpup.example.invalidnsoleV2.dispatchScanDeviceSeed';

function dispatchScanNeedsConsoleDevice(input: Record<string, unknown>): boolean {
  if (asNonEmptyString(input.device_id)) return false;
  const metadata = objectRecord(input.metadata);
  return (
    String(input.scan_type ?? '').trim().toLowerCase() === 'load' &&
    asNonEmptyString(metadata.source) === 'console_v2_dispatch'
  );
}

function readOrCreateDispatchScanDeviceSeed(): string {
  const existing = (() => {
    try {
      return globalThis.localStorage?.getItem(CONSOLE_DISPATCH_SCAN_DEVICE_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  })();
  if (existing.trim()) return existing.trim();

  const generated =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `console-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    globalThis.localStorage?.setItem(CONSOLE_DISPATCH_SCAN_DEVICE_STORAGE_KEY, generated);
  } catch {
    // Non-browser test runtimes can still register a per-call device identifier.
  }
  return generated;
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof globalThis.TextEncoder !== 'function') return input;
  const bytes = new TextEncoder().encode(input);
  const hash = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function attachConsoleDispatchScanDevice(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!dispatchScanNeedsConsoleDevice(input)) return input;

  const origin = (() => {
    try {
      return globalThis.location?.origin ?? 'console-v2';
    } catch {
      return 'console-v2';
    }
  })();
  const identifier = await sha256Hex(`${origin}:${readOrCreateDispatchScanDeviceSeed()}`);
  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>('register_user_device_v1', {
    p_device: {
      device_platform: 'web',
      device_identifier_sha256: identifier,
      device_label: 'Console V2 Dispatch scanner',
      metadata: {
        source: 'console_v2_dispatch',
        surface: 'dispatch_scan_out',
      },
    },
  });
  if (!live) return input;

  const row = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
  const deviceId = asNonEmptyString(row.device_id);
  if (!deviceId) {
    throw new Error('register_user_device_v1 did not return device_id for Dispatch scan');
  }
  return { ...input, device_id: deviceId };
}

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
  const { dryRun, canonical } = materializeDispatchResolutionArgs(taskId, resolution, opts);
  const live = await liveRpc<Record<string, unknown>>(
    dryRun ? 'preview_dispatch_exception_resolution_v1' : 'ui_execute_dispatch_exception_resolution_v1',
    {
      p_action_key: canonical.action_key,
      p_resource_key: canonical.resource_key,
      p_selection_ids: canonical.selection_ids,
      p_selection_id: canonical.selection_id,
      p_selection_count: canonical.selection_count,
      p_params: canonical.params,
    },
  );
  if (live) {
    const result = normalizeDispatchResolutionLiveResult(live.data, taskId, resolution, dryRun, canonical);
    if (!dryRun) {
      await requireLiveDispatchExceptionResolutionReadback(result, canonical);
    }
    return result;
  }

  await sleep(120);
  return {
    ok: true,
    task_id: taskId,
    resolution,
    dry_run: dryRun,
    canonical_entrypoint: 'public.ui_execute_dispatch_exception_resolution_v1',
    canonical_args: canonical,
    policy: 'ndr_policy',
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
    apply_status: dryRun ? 'preview' : 'completed',
    results: [{ task_id: taskId, outcome: 'ok' }],
  };
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
  const scanEventId = String(args.scan_event_id ?? '').trim();
  const correctionReason = String(args.correction_reason ?? '').trim();
  const correctedBarcode = String(args.corrected_barcode ?? '').trim();
  if (!scanEventId) throw new Error('ui_request_warehouse_scan_correction_v1 requires scan_event_id');
  if (!correctionReason) throw new Error('ui_request_warehouse_scan_correction_v1 requires correction_reason');
  if (!correctedBarcode) throw new Error('ui_request_warehouse_scan_correction_v1 requires corrected_barcode');

  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>(
    'ui_request_warehouse_scan_correction_v1',
    {
      p_scan_event_id: scanEventId,
      p_correction_reason: correctionReason,
      p_corrected_barcode: correctedBarcode,
      p_params: args.metadata ?? {},
    },
  );
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) {
      throw new Error('ui_request_warehouse_scan_correction_v1 backend readback missing task_id');
    }
    await ui_get_resource_v1<Record<string, unknown>>('tasks', taskId);
    return row;
  }

  assertSeedFallbackAllowed('ui_request_warehouse_scan_correction_v1');
  await sleep(70);
  const taskId = `tsk_scan_corr_${Date.now()}`;
  const scans = seed.warehouse_checkpoint_scans as Array<Record<string, unknown>>;
  const scan = scans.find((row) => row.id === scanEventId);
  const tasks = seed.tasks as Array<Record<string, unknown>>;
  tasks.push({
    id: taskId,
    task_id: taskId.toUpperCase(),
    task_type: 'warehouse_scan_supervisor_approval',
    task_type_key: 'warehouse_scan_supervisor_approval',
    subject: `Scan correction · ${String(scan?.barcode ?? scan?.checkpoint ?? scanEventId)}`,
    resource_type: 'scan_event',
    resource_id: scanEventId,
    queue: 'warehouse',
    queue_key: 'warehouse',
    priority: 1,
    status: 'open',
    metadata: {
      subject: `Scan correction · ${String(scan?.barcode ?? scan?.checkpoint ?? scanEventId)}`,
      source: 'console_v2.warehouse.scan_correction_request',
      task_type_key: 'warehouse_scan_supervisor_approval',
      scan_correction: {
        original_scan_event_id: scanEventId,
        warehouse_transfer_id: scan?.transfer_id ?? null,
        corrected_barcode: correctedBarcode,
        correction_reason: correctionReason,
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return {
    status: 'requested',
    task_id: taskId,
    scan_event_id: scanEventId,
    warehouse_transfer_id: scan?.transfer_id ?? null,
    corrected_barcode: correctedBarcode,
    correction_reason: correctionReason,
  };
}

export async function record_scan_event_v1(
  payload: Record<string, unknown>,
): Promise<{ ok: true; scan_event_id: string; created?: boolean }> {
  const input = await attachConsoleDispatchScanDevice(normalizeScanEventPayload(payload));
  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>(
    'record_scan_event_v1',
    { p_scan: input },
  );
  if (live) {
    const row = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    const liveOk = row.ok == null ? true : Boolean(row.ok);
    if (!liveOk) {
      throw new Error(String(row.error ?? row.message ?? 'record_scan_event_v1 failed'));
    }
    const scanEventId = String(row.scan_event_id ?? row.id ?? '').trim();
    if (!scanEventId) {
      throw new Error('record_scan_event_v1 did not return scan_event_id');
    }
    return {
      ...row,
      ok: true,
      scan_event_id: scanEventId,
      created: row.created == null ? true : Boolean(row.created),
    };
  }

  await sleep(60);
  const scanEventId = 'sce_' + Date.now();
  if (String(input.scan_type ?? '').toLowerCase() === 'correction') {
    const scans = seed.warehouse_checkpoint_scans as Array<Record<string, unknown>>;
    scans.push({
      id: scanEventId,
      transfer_id: input.warehouse_transfer_id ?? input.transfer_id ?? null,
      warehouse_transfer_id: input.warehouse_transfer_id ?? input.transfer_id ?? null,
      shipment_id: input.shipment_id ?? null,
      scan_type: 'correction',
      barcode: input.barcode,
      checkpoint: 'correction',
      sequence: null,
      occurred_at: new Date().toISOString(),
      correction_of_scan_event_id: input.correction_of_scan_event_id ?? null,
      correction_reason: input.correction_reason ?? null,
      correction_approval_task_id: input.correction_approval_task_id ?? null,
      metadata: input.metadata ?? {},
    });
  }
  return { ok: true, scan_event_id: scanEventId };
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
  const client = getSupabaseClient();
  if (client) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `resolve_ndr_branch_next_action_v2` (migration
    // 202605020200_w44_rpc_v2_normalizations.sql). Envelope: { ok, action }.
    // The exported adapter signature is unchanged.
    const { data, error } = await client.rpc('resolve_ndr_branch_next_action_v2', {
      p_args: {
        organization_id: args.organization_id ?? null,
        client_id: args.client_id ?? null,
        sender_id: args.sender_id ?? null,
        service_type: args.service_type ?? null,
        dispatch_exception_reason: args.dispatch_exception_reason ?? null,
        resolution_action: args.resolution_action ?? null,
        task_type_key: args.task_type_key ?? null,
        shipment_action_type: args.shipment_action_type ?? null,
        review_status: args.review_status ?? null,
        allowed_ndr_actions: args.allowed_ndr_actions ?? null,
      },
    });
    if (error) throw new Error(error.message);
    const envelope = (data ?? null) as { ok?: boolean; action?: string } | null;
    return envelope?.action ?? 'hold';
  }
  // In-memory fallback: read ndr_policy from seed and project a
  // recommendation. Mirrors the canonical RPC's behavior (returns 'hold' if
  // org missing; reads ndr_policy.action_map; falls back to first
  // allowed_ndr_actions entry; final fallback 'reschedule').
  await sleep(40);
  if (!args.organization_id) return 'hold';
  const allowed = (args.allowed_ndr_actions ?? []) as string[];
  const reason = (args.dispatch_exception_reason ?? '').toLowerCase();
  // Heuristic mirrors the seeded `ndr_policy.action_map` shape.
  if (reason.includes('refused') || reason.includes('damaged')) return 'customer_pickup';
  if (reason.includes('address') || reason.includes('zone')) return 'reschedule';
  if (allowed.length > 0) return allowed[0]!;
  return 'reschedule';
}

// ----------- Phase C6 helpers -----------
//
// The C6 wave wires PLATFORM + FLEET + SUPPORT mutations through canonical
// RPCs (Phase B1/B2/B3). Each canonical RPC returns
//   { ok, <resource>_id, correlation_id, settings_resolution_id }
// so we share two tiny helpers that the in-memory branch uses to mirror the
// canonical envelope exactly. Production swap is environment-only.
let mutationCounter = 0;
function nextCorrelationId(): string {
  mutationCounter++;
  return `cor_${Date.now().toString(36)}_${mutationCounter}`;
}
function nextResourceId(prefix: string): string {
  mutationCounter++;
  return `${prefix}_${Date.now().toString(36)}_${mutationCounter}`;
}
function buildEnvelope(extras: Record<string, unknown> = {}): Record<string, unknown> {
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

function buildTenantSignupReviewSeedResult(
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

function buildMutationFallbackEnvelope(
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
  assertSeedFallbackAllowed(`RPC ${rpcName}`);
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
  assertSeedFallbackAllowed(`RPC ${rpcName}`);
  await sleep(60);
  const idKey = resourceKeyHint ? `${resourceKeyHint}_id` : null;
  const passedId = idKey ? (args[idKey] as string | undefined) : undefined;
  const extras: Record<string, unknown> = {};
  if (idKey) {
    extras[idKey] = passedId ?? nextResourceId(resourceKeyHint!);
  }
  return buildEnvelope(extras);
}

async function requireLiveUserLifecycleReadback(
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

function assertLiveUserScopeReadback(
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

async function requireLiveUserDeviceRevokeReadback(
  rpcName: string,
  deviceId: string,
  revokedReason?: string | null,
): Promise<{
  device: Record<string, unknown>;
  summary: Record<string, unknown>;
}> {
  const device = await requireLiveResourceReadback('user_devices', deviceId, rpcName);
  const summary = await requireLiveResourceReadback('user_device_summary', deviceId, rpcName);
  const readbacks = [device, summary];
  for (const row of readbacks) {
    const revokedAt = asNonEmptyString(row.revoked_at);
    const isRevoked = row.is_revoked === true || Boolean(revokedAt);
    if (!isRevoked) {
      throw new Error(`${rpcName} backend readback device ${deviceId} is not revoked`);
    }
  }
  const expectedReason = asNonEmptyString(revokedReason);
  if (expectedReason) {
    const readbackReason = asNonEmptyString(summary.revoked_reason) ?? asNonEmptyString(device.revoked_reason);
    if (readbackReason !== expectedReason) {
      throw new Error(`${rpcName} backend readback missing device revocation reason`);
    }
  }
  return { device, summary };
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

async function requireLiveUserSecurityActionReadback(
  rpcName: string,
  targetUserId: string,
  decisionPoint: string,
  result: Record<string, unknown>,
  actionReason: string | null | undefined,
  expected?: {
    roleKey?: string | null;
    assignmentId?: string | null;
    inviteEmail?: string | null;
    inviteEmailSent?: boolean | null;
    sendInviteEmailRequested?: boolean | null;
    inviteRedirectTo?: string | null;
  },
): Promise<Record<string, unknown>> {
  const expectedIntentId = asNonEmptyString(result.password_reset_intent_id);
  const expectedDecisionId = asNonEmptyString(result.settings_resolution_id);
  const expectedCorrelationId = asNonEmptyString(result.correlation_id);
  const expectedRoleKey = asNonEmptyString(expected?.roleKey);
  const expectedAssignmentId = asNonEmptyString(expected?.assignmentId);
  const expectedInviteEmail = asNonEmptyString(expected?.inviteEmail)?.toLowerCase();
  const expectedInviteEmailSent = expected?.inviteEmailSent;
  const expectedSendInviteEmailRequested = expected?.sendInviteEmailRequested;
  const expectedInviteRedirectTo = expected?.inviteRedirectTo;
  const inviteRedirectMatchesReadback = (readbackValue: string | null | undefined) => {
    if (expectedInviteRedirectTo === undefined) return true;
    if (expectedInviteRedirectTo === null) return readbackValue == null;
    if (readbackValue === expectedInviteRedirectTo) return true;
    const normalizeRootUrl = (value: string | null | undefined) => {
      const raw = asNonEmptyString(value);
      if (!raw) return null;
      try {
        const parsed = new URL(raw);
        if (parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin;
      } catch {
        return raw;
      }
      return raw;
    };
    return normalizeRootUrl(readbackValue) === normalizeRootUrl(expectedInviteRedirectTo);
  };
  const hasOwn = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);
  const boolMatches = (value: unknown, expectedValue: boolean | null | undefined) => {
    if (expectedValue == null) return true;
    if (typeof value === 'boolean') return value === expectedValue;
    const raw = asNonEmptyString(value)?.toLowerCase();
    if (raw === 'true' || raw === 't' || raw === '1' || raw === 'yes') return expectedValue === true;
    if (raw === 'false' || raw === 'f' || raw === '0' || raw === 'no') return expectedValue === false;
    return false;
  };
  let match: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = await liveRpc<Record<string, unknown>>('ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
    if (!live) throw new Error(`${rpcName} user security action readback requires a live backend`);
    const rows = normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 5).rows;
    match = rows.find((row) => {
      const inputs = objectRecord(row.decision_inputs);
      const intentId =
        asNonEmptyString(row.password_reset_intent_id) ??
        asNonEmptyString(inputs.password_reset_intent_id);
      const targetMatches =
        asNonEmptyString(row.resource_id) === targetUserId ||
        asNonEmptyString(inputs.target_user_id) === targetUserId;
      const pointMatches = asNonEmptyString(row.decision_point) === decisionPoint;
      const intentMatches = !expectedIntentId || intentId === expectedIntentId;
      const decisionMatches = !expectedDecisionId || asNonEmptyString(row.id) === expectedDecisionId;
      const correlationMatches = !expectedCorrelationId || asNonEmptyString(row.correlation_id) === expectedCorrelationId;
      const roleKey =
        asNonEmptyString(row.role_key) ??
        asNonEmptyString(inputs.role_key);
      const readbackAssignmentId =
        asNonEmptyString(inputs.rbac_user_role_assignment_id) ??
        asNonEmptyString(inputs.user_role_assignment_id) ??
        asNonEmptyString(inputs.assignment_id);
      const resourceType = asNonEmptyString(row.resource_type);
      const resourceId = asNonEmptyString(row.resource_id);
      const rowCarriesAssignmentResource =
        resourceType === 'rbac_user_role_assignment' ||
        resourceType === 'user_role_assignment' ||
        resourceType === 'role_assignment';
      const assignmentMatches =
        !expectedAssignmentId ||
        readbackAssignmentId === expectedAssignmentId ||
        (rowCarriesAssignmentResource && resourceId === expectedAssignmentId) ||
        (!readbackAssignmentId && !rowCarriesAssignmentResource);
      const roleMatches = !expectedRoleKey || roleKey === expectedRoleKey;
      const inviteEmail =
        asNonEmptyString(row.invite_email)?.toLowerCase() ??
        asNonEmptyString(inputs.email)?.toLowerCase();
      const inviteEmailMatches = !expectedInviteEmail || inviteEmail === expectedInviteEmail;
      const inviteEmailSentMatches = boolMatches(
        row.invite_email_sent ?? inputs.invite_email_sent,
        expectedInviteEmailSent,
      );
      const sendInviteEmailMatches = boolMatches(
        row.send_invite_email_requested ?? inputs.send_invite_email_requested,
        expectedSendInviteEmailRequested,
      );
      const readbackRedirect =
        asNonEmptyString(row.invite_redirect_to) ??
        asNonEmptyString(inputs.invite_redirect_to);
      const inviteRedirectRecorded =
        hasOwn(inputs, 'invite_redirect_to') ||
        asNonEmptyString(row.invite_redirect_to) != null;
      const inviteRedirectMatches =
        expectedInviteRedirectTo === undefined ||
        (expectedInviteRedirectTo === null
          ? inviteRedirectRecorded && readbackRedirect == null
          : inviteRedirectMatchesReadback(readbackRedirect));
      return targetMatches &&
        pointMatches &&
        intentMatches &&
        decisionMatches &&
        correlationMatches &&
        assignmentMatches &&
        roleMatches &&
        inviteEmailMatches &&
        inviteEmailSentMatches &&
        sendInviteEmailMatches &&
        inviteRedirectMatches;
    });
    if (match) break;
    if (attempt < 4) await sleep(300);
  }
  if (!match) {
    throw new Error(`${rpcName} backend readback missing user security action`);
  }
  const expectedReason = asNonEmptyString(actionReason);
  if (expectedReason) {
    const inputs = objectRecord(match.decision_inputs);
    const readbackReason =
      asNonEmptyString(match.action_reason) ??
      asNonEmptyString(match.decision_reason) ??
      asNonEmptyString(inputs.reason);
    if (readbackReason !== expectedReason) {
      throw new Error(`${rpcName} backend readback missing persisted action reason`);
    }
  }
  return match;
}

async function requireLiveUserRoleAssignmentReadback(
  rpcName: string,
  targetUserId: string,
  roleKey?: string | null,
  assignmentId?: string | null,
  directory?: Record<string, unknown> | null,
  expectedStatus: 'active' | 'revoked' = 'active',
): Promise<void> {
  const normalizedRoleKey = asNonEmptyString(roleKey);
  await requireLiveRbacAssignmentReadback(rpcName, {
    assignmentId,
    targetUserId,
    roleKey: normalizedRoleKey,
    expectedStatus,
  });
  if (normalizedRoleKey && directory) {
    const activeRoleKeys = Array.isArray(directory.active_role_keys)
      ? directory.active_role_keys.map((value) => String(value))
      : [];
    if (expectedStatus === 'active' && activeRoleKeys.length > 0 && !activeRoleKeys.includes(normalizedRoleKey)) {
      throw new Error(`${rpcName} backend readback missing active role ${normalizedRoleKey}`);
    }
    if (expectedStatus === 'revoked' && activeRoleKeys.includes(normalizedRoleKey)) {
      throw new Error(`${rpcName} backend readback still has active role ${normalizedRoleKey}`);
    }
  }
}

async function requireLiveRbacRoleReadback(
  rpcName: string,
  roleId: string,
  options: {
    args?: Record<string, unknown>;
    assertMutableFields?: boolean;
    requireInactive?: boolean;
    requireAssignmentsRevoked?: boolean;
  } = {},
): Promise<{
  role: Record<string, unknown>;
  summary: Record<string, unknown>;
}> {
  const role = await requireLiveResourceReadback('rbac_roles', roleId, rpcName);
  const summary = await requireLiveResourceReadback('rbac_role_summary', roleId, rpcName);
  const args = options.args ?? {};
  const expectedOrganizationId = asNonEmptyString(args.organization_id);
  if (expectedOrganizationId) assertReadbackValue(role.organization_id, expectedOrganizationId, 'rbac_roles.organization_id', rpcName);

  const expectedKey = asNonEmptyString(args.key);
  if (expectedKey) assertReadbackValue(role.key, expectedKey, 'rbac_roles.key', rpcName);

  if (options.assertMutableFields) {
    const expectedName = asNonEmptyString(args.name);
    if (expectedName) assertReadbackValue(role.name, expectedName, 'rbac_roles.name', rpcName);
    if (Object.prototype.hasOwnProperty.call(args, 'description')) {
      assertReadbackValue(
        role.description ?? null,
        asNonEmptyString(args.description),
        'rbac_roles.description',
        rpcName,
      );
    }
    if (Object.prototype.hasOwnProperty.call(args, 'is_active')) {
      assertReadbackValue(Boolean(role.is_active), Boolean(args.is_active), 'rbac_roles.is_active', rpcName);
    }
  }

  if (options.requireInactive) {
    if (role.is_active !== false || summary.is_active !== false) {
      throw new Error(`${rpcName} backend readback role ${roleId} is still active`);
    }
  }

  if (options.requireAssignmentsRevoked) {
    const assignments = await readLiveResourceListReadback('rbac_user_role_assignments', { role_id: roleId }, rpcName);
    const active = assignments.filter((row) => !asNonEmptyString(row.revoked_at));
    if (active.length > 0) {
      throw new Error(`${rpcName} backend readback role ${roleId} still has active assignments`);
    }
  }

  return { role, summary };
}

async function requireLiveRbacAssignmentReadback(
  rpcName: string,
  {
    assignmentId,
    targetUserId,
    roleId,
    roleKey,
    expectedStatus,
  }: {
    assignmentId?: string | null;
    targetUserId?: string | null;
    roleId?: string | null;
    roleKey?: string | null;
    expectedStatus?: 'active' | 'revoked';
  },
): Promise<void> {
  const normalizedAssignmentId = asNonEmptyString(assignmentId);
  const normalizedTargetUserId = asNonEmptyString(targetUserId);
  const normalizedRoleId = asNonEmptyString(roleId);
  const normalizedRoleKey = asNonEmptyString(roleKey);
  let assignmentRows: Array<Record<string, unknown>> = [];
  if (normalizedAssignmentId) {
    assignmentRows = [
      await requireLiveResourceReadback('rbac_user_role_assignments', normalizedAssignmentId, rpcName),
    ];
  } else if (normalizedTargetUserId) {
    assignmentRows = await readLiveResourceListReadback(
      'rbac_user_role_assignments',
      { user_id: normalizedTargetUserId },
      rpcName,
    );
  } else {
    throw new Error(`${rpcName} backend readback missing rbac assignment target`);
  }

  const scopedRows = assignmentRows.filter((row) => {
    const roleIdMatches = !normalizedRoleId || asNonEmptyString(row.role_id) === normalizedRoleId;
    const roleKeyMatches = !normalizedRoleKey || asNonEmptyString(row.role_key) === normalizedRoleKey;
    return roleIdMatches && roleKeyMatches;
  });

  if (expectedStatus === 'active') {
    const active = scopedRows.find((row) => !asNonEmptyString(row.revoked_at));
    if (!active) {
      throw new Error(`${rpcName} backend readback missing active rbac assignment`);
    }
  } else if (expectedStatus === 'revoked') {
    const active = scopedRows.find((row) => !asNonEmptyString(row.revoked_at));
    if (active) {
      throw new Error(`${rpcName} backend readback assignment ${active.id ?? normalizedAssignmentId ?? normalizedTargetUserId} is still active`);
    }
  } else if (scopedRows.length === 0) {
    throw new Error(`${rpcName} backend readback missing rbac assignment`);
  }

  for (const row of scopedRows) {
    if (normalizedTargetUserId) assertReadbackValue(row.user_id, normalizedTargetUserId, 'rbac_user_role_assignments.user_id', rpcName);
    if (normalizedRoleId) assertReadbackValue(row.role_id, normalizedRoleId, 'rbac_user_role_assignments.role_id', rpcName);
    if (normalizedRoleKey) assertReadbackValue(row.role_key, normalizedRoleKey, 'rbac_user_role_assignments.role_key', rpcName);
  }

  const readbackRoleId =
    assignmentRows
      .map((row) => asNonEmptyString(row.role_id) ?? asNonEmptyString(row.rbac_role_id))
      .find(Boolean) ?? normalizedRoleId ?? null;
  if (readbackRoleId) {
    await requireLiveRbacRoleReadback(rpcName, readbackRoleId);
  }
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
  const live = await liveRpc<Record<string, unknown>>('create_warehouse_transfer_manifest_v1', {
    p_input: args,
  });
  if (live) {
    const envelope = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    const transferCode = asNonEmptyString(envelope.transfer_code ?? args.transfer_code) ?? '';
    return {
      ...envelope,
      ok: true,
      warehouse_transfer_id: String(
        envelope.warehouse_transfer_id ??
          envelope.transfer_id ??
          envelope.id ??
          nextResourceId('warehouse_transfer'),
      ),
      transfer_code: transferCode,
      created: envelope.created !== false,
      item_count: Number(
        envelope.item_count ??
          (Array.isArray(args.shipment_ids) ? args.shipment_ids.length : 0),
      ),
    };
  }

  assertSeedFallbackAllowed('create_warehouse_transfer_manifest_v1');
  await sleep(80);
  const transferCode =
    asNonEmptyString(args.transfer_code) ?? `WTR-${Date.now().toString(36).toUpperCase()}`;
  return {
    ok: true,
    warehouse_transfer_id: nextResourceId('warehouse_transfer'),
    transfer_code: transferCode,
    created: true,
    item_count: Array.isArray(args.shipment_ids) ? args.shipment_ids.length : 0,
    correlation_id: nextCorrelationId(),
    settings_resolution_id: 'srlv_demo',
  };
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
  const live = await liveRpc<Record<string, unknown> | Record<string, unknown>[]>(
    'transition_warehouse_transfer_v1',
    { p_input: args },
  );
  if (live) {
    const envelope = firstRpcRow<Record<string, unknown>>(live.data) ?? {};
    return {
      ok: true,
      warehouse_transfer_id: String(envelope.warehouse_transfer_id ?? args.warehouse_transfer_id),
      to_status: String(envelope.status ?? envelope.to_status ?? args.to_status),
      updated: envelope.updated ?? false,
      status: envelope.status ?? args.to_status,
      dispatched_at: envelope.dispatched_at ?? null,
      received_at: envelope.received_at ?? null,
    };
  }
  await sleep(80);
  return {
    ok: true,
    warehouse_transfer_id: args.warehouse_transfer_id,
    to_status: args.to_status,
  };
}

export interface WarehouseTransferUiActionResult extends Record<string, unknown> {
  ok: true;
  action_key: string;
  resource_key: string;
  warehouse_transfer_id: string;
  count: number;
}

function warehouseTransferUiArgs(
  actionKey: string,
  warehouseTransferId: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    p_action_key: actionKey,
    p_resource_key: 'warehouse_transfers',
    p_selection_ids: [warehouseTransferId],
    p_selection_id: warehouseTransferId,
    p_selection_count: 1,
    p_params: params,
  };
}

function normalizeWarehouseTransferUiResult(
  data: unknown,
  actionKey: string,
  warehouseTransferId: string,
): WarehouseTransferUiActionResult {
  const rec = firstRpcRow<Record<string, unknown>>(data) ?? {};
  return {
    ...rec,
    ok: true,
    action_key: String(rec.action_key ?? actionKey),
    resource_key: String(rec.resource_key ?? 'warehouse_transfers'),
    warehouse_transfer_id: String(rec.warehouse_transfer_id ?? warehouseTransferId),
    count: Number(rec.count ?? 1),
  };
}

export async function ui_execute_warehouse_transfer_dispatch_v1(
  args: { warehouse_transfer_id: string; params?: Record<string, unknown> },
): Promise<WarehouseTransferUiActionResult> {
  const params = args.params ?? {};
  const actionKey = 'warehouse_transfers.dispatch';
  const live = await liveRpc<Record<string, unknown>>(
    'ui_execute_warehouse_transfer_dispatch_v1',
    warehouseTransferUiArgs(actionKey, args.warehouse_transfer_id, params),
  );
  if (live) return normalizeWarehouseTransferUiResult(live.data, actionKey, args.warehouse_transfer_id);

  await sleep(80);
  return {
    ok: true,
    action_key: actionKey,
    resource_key: 'warehouse_transfers',
    warehouse_transfer_id: args.warehouse_transfer_id,
    count: 1,
    status: 'workflow_started',
  };
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
  const { action_key, warehouse_transfer_id, ...params } = args;
  const live = await liveRpc<Record<string, unknown>>(
    'ui_execute_warehouse_transfer_checkpoint_v1',
    warehouseTransferUiArgs(action_key, warehouse_transfer_id, params),
  );
  if (live) return normalizeWarehouseTransferUiResult(live.data, action_key, warehouse_transfer_id);

  await sleep(80);
  return {
    ok: true,
    action_key,
    resource_key: 'warehouse_transfers',
    warehouse_transfer_id,
    count: 1,
    scan_event_id: `sce_${Date.now()}`,
    scan_created: true,
  };
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
  const { warehouse_transfer_id, ...params } = args;
  const actionKey = 'warehouse_transfers.reconcile_destination';
  const live = await liveRpc<Record<string, unknown>>(
    'ui_execute_warehouse_transfer_reconcile_v1',
    warehouseTransferUiArgs(actionKey, warehouse_transfer_id, params),
  );
  if (live) return normalizeWarehouseTransferUiResult(live.data, actionKey, warehouse_transfer_id);

  await sleep(80);
  return {
    ok: true,
    action_key: actionKey,
    resource_key: 'warehouse_transfers',
    warehouse_transfer_id,
    count: 1,
    status: 'task_completed',
  };
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
async function requireLiveImportJobReadback(
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

interface RbacTemplateProvisionRoleResult extends Record<string, unknown> {
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

function normalizeRbacTemplateProvisionRoles(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): RbacTemplateProvisionRoleResult[] {
  const rows = Array.isArray(rec.rbac_roles)
    ? (rec.rbac_roles as RbacTemplateProvisionRoleResult[])
    : [];
  if (rows.length > 0) return rows;
  const roleId =
    asNonEmptyString(rec.rbac_role_id) ??
    asNonEmptyString(rec.role_id) ??
    asNonEmptyString(rec.id);
  if (!roleId) return [];
  const templateKey =
    asNonEmptyString(args.template_key) ??
    (Array.isArray(args.template_keys)
      ? args.template_keys.map(asNonEmptyString).find(Boolean)
      : null);
  return [{ role_id: roleId, template_key: templateKey ?? null }];
}

function normalizeRbacPermissionValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item))
    .map((item) => item.trim())
    .sort((a, b) => a.localeCompare(b));
}

async function requireLiveRbacTemplatePermissionReadback(
  rpcName: string,
  templateKey: string,
  roleSummary: Record<string, unknown>,
): Promise<void> {
  const templateRows = await requireLiveResourceListReadback(
    'rbac_role_templates',
    { key: templateKey },
    rpcName,
  );
  const template = templateRows.find((row) => asNonEmptyString(row.key) === templateKey);
  if (!template) {
    throw new Error(`${rpcName} backend readback missing rbac_role_templates:${templateKey}`);
  }

  const expectedValues = normalizeRbacPermissionValues(template.permission_values);
  const actualValues = normalizeRbacPermissionValues(roleSummary.permission_values);
  const expectedCount =
    typeof template.permission_count === 'number'
      ? template.permission_count
      : expectedValues.length;
  const actualCount =
    typeof roleSummary.permission_count === 'number'
      ? roleSummary.permission_count
      : actualValues.length;
  if (expectedCount > 0 && actualCount < expectedCount) {
    throw new Error(`${rpcName} backend readback role ${templateKey} has fewer permissions than its template`);
  }
  if (expectedValues.length > 0) {
    const actualSet = new Set(actualValues);
    const missing = expectedValues.filter((permission) => !actualSet.has(permission));
    if (missing.length > 0) {
      throw new Error(`${rpcName} backend readback role ${templateKey} missing template permissions: ${missing.join(', ')}`);
    }
  }
}

async function requireLiveRbacTemplateProvisionReadback(
  rpcName: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<void> {
  const roles = normalizeRbacTemplateProvisionRoles(result, args);
  if (roles.length === 0) {
    throw new Error(`${rpcName} did not return provisioned RBAC role evidence`);
  }

  for (const provisioned of roles) {
    const roleId =
      asNonEmptyString(provisioned.role_id) ??
      asNonEmptyString(provisioned.rbac_role_id);
    if (!roleId) {
      throw new Error(`${rpcName} did not return provisioned RBAC role id`);
    }
    const { role, summary } = await requireLiveRbacRoleReadback(rpcName, roleId);
    const templateKey = asNonEmptyString(provisioned.template_key);
    if (templateKey) {
      const roleKey = asNonEmptyString(role.key) ?? asNonEmptyString(summary.key);
      if (roleKey !== templateKey) {
        throw new Error(`${rpcName} backend readback role ${roleId} did not match template ${templateKey}`);
      }
      await requireLiveRbacTemplatePermissionReadback(rpcName, templateKey, summary);
    }
  }
}

export async function rbac_create_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const live = await livePArgsMutationResult('rbac_create_role_v1', args, ['rbac_role_id', 'role_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RbacRoleMutationResult>(
      live,
      ['rbac_role_id', 'role_id', 'id'],
      'rbac_role_id',
      'rbac_create_role_v1 did not return rbac_role_id',
    );
    const idempotent = live.idempotent_no_op === true || asNonEmptyString(live.action) === 'noop';
    await requireLiveRbacRoleReadback('rbac_create_role_v1', result.rbac_role_id, {
      args,
      assertMutableFields: !idempotent,
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_role_id: (args.role_id as string | undefined) ?? nextResourceId('rbac_role'),
    action: 'created',
    idempotent_no_op: false,
  }) as RbacRoleMutationResult;
}

export async function rbac_update_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const live = await livePArgsMutationResult('rbac_update_role_v1', args, ['rbac_role_id', 'role_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RbacRoleMutationResult>(
      live,
      ['rbac_role_id', 'role_id', 'id'],
      'rbac_role_id',
      'rbac_update_role_v1 did not return rbac_role_id',
    );
    await requireLiveRbacRoleReadback('rbac_update_role_v1', result.rbac_role_id, {
      args,
      assertMutableFields: true,
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_role_id: (args.role_id as string | undefined) ?? nextResourceId('rbac_role'),
    action: 'updated',
  }) as RbacRoleMutationResult;
}

export async function rbac_delete_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const live = await livePArgsMutationResult('rbac_delete_role_v1', args, ['rbac_role_id', 'role_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RbacRoleMutationResult>(
      live,
      ['rbac_role_id', 'role_id', 'id'],
      'rbac_role_id',
      'rbac_delete_role_v1 did not return rbac_role_id',
    );
    await requireLiveRbacRoleReadback('rbac_delete_role_v1', result.rbac_role_id, {
      args,
      requireInactive: true,
      requireAssignmentsRevoked: Number(live.assignments_revoked ?? 0) > 0,
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_role_id: (args.role_id as string | undefined) ?? nextResourceId('rbac_role'),
    action: 'deleted',
    idempotent_no_op: false,
    assignments_revoked: 0,
  }) as RbacRoleMutationResult;
}

export async function rbac_grant_role_v1(
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> {
  const live = await livePArgsMutationResult('rbac_grant_role_v1', args, [
    'rbac_user_role_assignment_id',
    'assignment_id',
    'id',
  ]);
  if (live) {
    const result = withRequiredLiveStringField<RbacUserRoleAssignmentMutationResult>(
      live,
      ['rbac_user_role_assignment_id', 'assignment_id', 'id'],
      'rbac_user_role_assignment_id',
      'rbac_grant_role_v1 did not return role assignment evidence',
    );
    await requireLiveRbacAssignmentReadback('rbac_grant_role_v1', {
      assignmentId: result.rbac_user_role_assignment_id,
      targetUserId: asNonEmptyString(args.user_id) ?? asNonEmptyString(args.target_user_id),
      roleId: asNonEmptyString(args.role_id),
      expectedStatus: 'active',
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_user_role_assignment_id: nextResourceId('rbac_user_role_assignment'),
    action: 'granted',
    idempotent_no_op: false,
  }) as RbacUserRoleAssignmentMutationResult;
}

export async function rbac_revoke_role_v1(
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> {
  const live = await livePArgsMutationResult('rbac_revoke_role_v1', args, [
    'rbac_user_role_assignment_id',
    'assignment_id',
    'id',
    'target_user_id',
    'role_id',
    'role_key',
    'action',
  ]);
  if (live) {
    requireLiveDomainEvidence(
      live,
      'rbac_revoke_role_v1',
      ['rbac_user_role_assignment_id', 'assignment_id', 'id', 'target_user_id', 'role_id', 'role_key', 'action'],
      'role assignment',
    );
    const assignmentId =
      asNonEmptyString(live.rbac_user_role_assignment_id) ??
      asNonEmptyString(live.assignment_id) ??
      asNonEmptyString(live.id);
    const result = {
      ...live,
      rbac_user_role_assignment_id: assignmentId ?? null,
    } as RbacUserRoleAssignmentMutationResult;
    await requireLiveRbacAssignmentReadback('rbac_revoke_role_v1', {
      assignmentId,
      targetUserId:
        asNonEmptyString(live.target_user_id) ??
        asNonEmptyString(args.target_user_id) ??
        asNonEmptyString(args.user_id),
      roleId: asNonEmptyString(live.role_id) ?? asNonEmptyString(args.role_id),
      expectedStatus: 'revoked',
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_user_role_assignment_id:
      (args.assignment_id as string | undefined) ?? nextResourceId('rbac_user_role_assignment'),
    action: 'revoked',
    idempotent_no_op: false,
  }) as RbacUserRoleAssignmentMutationResult;
}

export async function provision_rbac_roles_from_templates_v1(
  args: Record<string, unknown>,
): Promise<RbacTemplateProvisionMutationResult> {
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
async function readFunctionErrorMessage(error: unknown, fallback: string): Promise<string> {
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

function requireFunctionMutationResult(
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

async function requireLiveTenantSignupRequestReadback(
  rpcName: string,
  requestId: string,
): Promise<{ request: Record<string, unknown>; summary: Record<string, unknown> }> {
  const request = await requireLiveResourceReadback('tenant_signup_requests', requestId, rpcName);
  const summary = await requireLiveResourceReadback('tenant_signup_request_summary', requestId, rpcName);
  return { request, summary };
}

const TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS = 10;
const TENANT_SIGNUP_REVIEW_READBACK_DELAY_MS = 250;

function tenantSignupReviewReadbackStates(
  request: Record<string, unknown>,
  summary: Record<string, unknown>,
): string[] {
  return [
    asNonEmptyString(request.review_decision),
    asNonEmptyString(request.status),
    asNonEmptyString(summary.review_decision),
    asNonEmptyString(summary.status),
  ].map((value) => value?.toLowerCase()).filter((value): value is string => Boolean(value));
}

async function requireLiveResourceReadbackEventually(
  resourceKey: string,
  id: string,
  rpcName: string,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS; attempt += 1) {
    try {
      return await requireLiveResourceReadback(resourceKey, id, rpcName);
    } catch (err) {
      lastError = err;
      if (attempt < TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS) {
        await sleep(TENANT_SIGNUP_REVIEW_READBACK_DELAY_MS);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${rpcName} backend readback missing ${resourceKey}:${id}`);
}

async function requireLiveTenantSignupReviewReadback(
  rpcName: string,
  requestId: string,
  decision: string,
  merged: Record<string, unknown>,
): Promise<{ request: Record<string, unknown>; summary: Record<string, unknown> }> {
  const expectedDecision = decision.toLowerCase();
  let latest: { request: Record<string, unknown>; summary: Record<string, unknown> } | null = null;
  let observedRequestState: string[] = [];
  for (let attempt = 1; attempt <= TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS; attempt += 1) {
    latest = await requireLiveTenantSignupRequestReadback(rpcName, requestId);
    observedRequestState = tenantSignupReviewReadbackStates(latest.request, latest.summary);
    if (observedRequestState.includes(expectedDecision)) break;
    if (attempt < TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS) {
      await sleep(TENANT_SIGNUP_REVIEW_READBACK_DELAY_MS);
    }
  }
  if (!latest || !observedRequestState.includes(expectedDecision)) {
    const observed = observedRequestState.length ? observedRequestState.join(', ') : 'none';
    throw new Error(`${rpcName} backend readback did not reflect ${expectedDecision} decision (observed: ${observed})`);
  }
  const { request, summary } = latest;

  if (expectedDecision !== 'approved') return { request, summary };

  const organizationId =
    asNonEmptyString(merged.approved_organization_id) ??
    asNonEmptyString(merged.organization_id) ??
    asNonEmptyString(request.approved_organization_id) ??
    asNonEmptyString(summary.approved_organization_id);
  const userId =
    asNonEmptyString(merged.approved_user_id) ??
    asNonEmptyString(merged.user_id) ??
    asNonEmptyString(request.approved_user_id) ??
    asNonEmptyString(summary.approved_user_id);
  if (!organizationId) throw new Error(`${rpcName} approval readback missing approved organization`);
  if (!userId) throw new Error(`${rpcName} approval readback missing approved user`);

  await requireLiveResourceReadbackEventually('organizations', organizationId, rpcName);
  await requireLiveResourceReadbackEventually('users', userId, rpcName);
  await requireLiveResourceReadbackEventually('user_directory', userId, rpcName);
  return { request, summary };
}

export async function tenant_signup_review_apply_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId =
    asNonEmptyString(args.request_id) ??
    asNonEmptyString(args.tenant_signup_request_id) ??
    asNonEmptyString(args.id);
  const decision = asNonEmptyString(args.decision)?.toLowerCase() ?? null;
  if (!requestId) throw new Error('tenant_signup_request_id is required');
  if (!decision) throw new Error('decision is required');

  const client = getSupabaseClient();
  if (client) {
    const metadata =
      args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : args.decision_metadata && typeof args.decision_metadata === 'object' && !Array.isArray(args.decision_metadata)
          ? (args.decision_metadata as Record<string, unknown>)
          : undefined;
    const body: Record<string, unknown> = {
      request_id: requestId,
      decision,
    };
    const reason = asNonEmptyString(args.reason) ?? asNonEmptyString(args.decision_reason);
    if (reason) body.reason = reason;
    const inviteRedirectTo = asNonEmptyString(args.invite_redirect_to) ?? hostedInviteRedirect();
    if (inviteRedirectTo) body.invite_redirect_to = inviteRedirectTo;
    if (metadata) body.metadata = metadata;

    const invokeResult = await client.functions.invoke<Record<string, unknown>>(
      'tenant-signup-review',
      { body },
    );
    const { data, error } = invokeResult ?? {};
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'tenant signup review failed'));
    }

    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'tenant-signup-review',
      [
        'id',
        'status',
        'tenant_signup_request_id',
        'request_id',
        'reviewed_at',
        'organization_id',
        'approved_organization_id',
        'user_id',
        'approved_user_id',
        'invite_id',
        'invite_email_sent_at',
      ],
      { allowedBusinessStatuses: ['rejected'] },
    );
    const alreadyProcessed = Boolean(merged.already_processed ?? result.already_processed);
    const returnedRequestId =
      asNonEmptyString(merged.tenant_signup_request_id) ??
      asNonEmptyString(merged.request_id) ??
      asNonEmptyString(merged.id);
    if (!returnedRequestId) throw new Error('tenant-signup-review did not return request evidence');
    const returnedDecision =
      asNonEmptyString(alreadyProcessed ? result.review_decision : null) ??
      asNonEmptyString(alreadyProcessed ? result.status : null) ??
      asNonEmptyString(alreadyProcessed ? merged.review_decision : null) ??
      asNonEmptyString(alreadyProcessed ? merged.status : null) ??
      asNonEmptyString(merged.decision) ??
      asNonEmptyString(merged.review_decision) ??
      asNonEmptyString(merged.status);
    if (!returnedDecision) throw new Error('tenant-signup-review did not return decision status');
    const reviewReadback = await requireLiveTenantSignupReviewReadback(
      'tenant-signup-review',
      returnedRequestId,
      returnedDecision,
      merged,
    );
    const readback = { ...reviewReadback.request, ...reviewReadback.summary };
    if (returnedDecision.toLowerCase() === 'approved') {
      requireLiveEvidence(
        { ...merged, ...readback },
        [
          'organization_id',
          'approved_organization_id',
          'user_id',
          'approved_user_id',
          'approved_auth_user_id',
          'invite_id',
          'invite_email_sent_at',
        ],
        'tenant-signup-review approval did not return provisioning or invite evidence',
      );
    }
    const status =
      asNonEmptyString(readback.status) ??
      asNonEmptyString(merged.status) ??
      returnedDecision;
    const reviewDecision =
      asNonEmptyString(readback.review_decision) ??
      asNonEmptyString(merged.review_decision) ??
      returnedDecision;
    const approvedOrganizationId =
      asNonEmptyString(merged.approved_organization_id) ??
      asNonEmptyString(merged.organization_id) ??
      asNonEmptyString(merged.tenant_id) ??
      asNonEmptyString(readback.approved_organization_id) ??
      null;
    const approvedUserId =
      asNonEmptyString(merged.approved_user_id) ??
      asNonEmptyString(merged.user_id) ??
      asNonEmptyString(readback.approved_user_id) ??
      null;
    const approvedAuthUserId =
      asNonEmptyString(merged.approved_auth_user_id) ??
      asNonEmptyString(merged.invited_auth_user_id) ??
      asNonEmptyString(readback.approved_auth_user_id) ??
      null;
    const inviteEmailSentAt =
      asNonEmptyString(merged.invite_email_sent_at) ??
      asNonEmptyString(readback.invite_email_sent_at) ??
      null;
    const readbackInviteRedirectTo =
      asNonEmptyString(merged.invite_redirect_to) ??
      asNonEmptyString(readback.invite_redirect_to) ??
      null;
    return {
      ...readback,
      ...result,
      ...envelope,
      ok: true,
      tenant_signup_request_id: returnedRequestId,
      request_id: returnedRequestId,
      id: returnedRequestId,
      decision: reviewDecision,
      status,
      review_decision: reviewDecision,
      approved_organization_id: approvedOrganizationId,
      approved_user_id: approvedUserId,
      approved_auth_user_id: approvedAuthUserId,
      invite_email_sent_at: inviteEmailSentAt,
      invite_redirect_to: readbackInviteRedirectTo,
    };
  }

  assertSeedFallbackAllowed('tenant_signup_review_apply_v1');
  await sleep(60);
  return buildEnvelope(buildTenantSignupReviewSeedResult(requestId, decision));
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
  const email = asNonEmptyString(args.email)?.toLowerCase();
  const fullName = asNonEmptyString(args.full_name);
  const organizationName = asNonEmptyString(args.organization_name);
  if (!email) throw new Error('email is required');
  if (!fullName) throw new Error('full_name is required');
  if (!organizationName) throw new Error('organization_name is required');

  const body = {
    ...args,
    email,
    full_name: fullName,
    organization_name: organizationName,
  };

  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'tenant-signup-console-request',
      { body },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'tenant signup console request failed'));
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'tenant-signup-console-request',
      ['tenant_signup_request_id', 'request_id', 'id', 'status'],
    );
    const requestId =
      asNonEmptyString(merged.tenant_signup_request_id) ??
      asNonEmptyString(merged.request_id) ??
      asNonEmptyString(merged.id);
    if (!requestId) throw new Error('tenant-signup-console-request did not return request id');
    const status = requireLiveStringField(
      merged,
      ['status'],
      'tenant-signup-console-request did not return status',
    );
    const requestReadback = await requireLiveTenantSignupRequestReadback(
      'tenant-signup-console-request',
      requestId,
    );
    const readback = { ...requestReadback.summary, ...requestReadback.request };
    const readbackStatus = asNonEmptyString(readback.status) ?? status;
    return {
      ...result,
      ...envelope,
      ...readback,
      ok: true,
      tenant_signup_request_id: requestId,
      request_id: requestId,
      id: requestId,
      status: readbackStatus,
    };
  }

  assertSeedFallbackAllowed('tenant_signup_console_request_v1');
  await sleep(60);
  const requests = (seed as { tenant_signup_requests?: Array<Record<string, unknown>> }).tenant_signup_requests ?? [];
  const requestId = `tsr_console_${Date.now()}`;
  const now = new Date().toISOString();
  const row = {
    id: requestId,
    email,
    full_name: fullName,
    organization_name: organizationName,
    organization_slug: asNonEmptyString(args.organization_slug) ?? null,
    website_url: asNonEmptyString(args.website_url) ?? null,
    phone: asNonEmptyString(args.phone) ?? null,
    notes: asNonEmptyString(args.notes) ?? null,
    locale: asNonEmptyString(args.locale) ?? 'en',
    status: 'pending',
    org_name: organizationName,
    industry: 'console',
    size: 'pending',
    received_at: now,
    created_at: now,
    updated_at: now,
    turnstile_verified: true,
    marketing: { source: 'console-v2' },
    metadata: { created_via: 'tenant-signup-console-request' },
  };
  requests.unshift(row);
  return buildEnvelope({
    id: requestId,
    tenant_signup_request_id: requestId,
    status: 'pending',
  });
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergePlainObjects(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') continue;
    const previous = next[key];
    if (
      previous &&
      typeof previous === 'object' &&
      !Array.isArray(previous) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      next[key] = mergePlainObjects(previous as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      next[key] = value;
    }
  }
  return next;
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

function assertReadbackValue(
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

function assertReadbackContainsPatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  path: string,
  rpcName: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    const nextPath = `${path}.${key}`;
    const actualValue = actual[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assertReadbackContainsPatch(objectRecord(actualValue), value as Record<string, unknown>, nextPath, rpcName);
    } else {
      assertReadbackValue(actualValue, value, nextPath, rpcName);
    }
  }
}

function requireOrganizationProfileReadback(
  args: DataSourceOrganizationProfileUpdateArgs,
  merged: Record<string, unknown>,
  readback: Record<string, unknown>,
  rpcName: string,
): void {
  for (const key of ['name', 'timezone', 'locale']) {
    const expected = asNonEmptyString(args[key]);
    if (expected) assertReadbackValue(readback[key], expected, key, rpcName);
  }

  const expectedBranding = compactRecord({
    logo_url: asNonEmptyString(args.logo_url) ?? undefined,
    logo_file_name: asNonEmptyString(args.file_name) ?? asNonEmptyString(args.logo_file_name) ?? undefined,
    logo_content_type: asNonEmptyString(args.content_type) ?? asNonEmptyString(args.logo_content_type) ?? undefined,
    primary_color: asNonEmptyString(args.primary_color) ?? undefined,
    secondary_color: asNonEmptyString(args.secondary_color) ?? undefined,
    logo_storage_bucket: asNonEmptyString(args.logo_storage_bucket) ?? undefined,
    logo_storage_key: asNonEmptyString(args.logo_storage_key) ?? undefined,
    logo_artifact_id: asNonEmptyString(args.logo_artifact_id) ?? undefined,
    ...objectRecord(merged.branding),
  });
  const expectedSettingsPatch = plainObject(args.default_settings_patch);
  if (Object.keys(expectedBranding).length === 0 && Object.keys(expectedSettingsPatch).length === 0) return;

  const settings = objectRecord(readback.default_settings);
  if (Object.keys(settings).length === 0) {
    throw new Error(`${rpcName} backend readback missing organizations.default_settings`);
  }
  if (Object.keys(expectedBranding).length > 0) {
    assertReadbackContainsPatch(objectRecord(settings.branding), expectedBranding, 'default_settings.branding', rpcName);
  }
  if (Object.keys(expectedSettingsPatch).length > 0) {
    assertReadbackContainsPatch(settings, expectedSettingsPatch, 'default_settings', rpcName);
  }
}

export async function ui_update_organization_profile_v1(
  args: DataSourceOrganizationProfileUpdateArgs,
): Promise<Record<string, unknown>> {
  const organizationId = asNonEmptyString(args.organization_id);
  if (!organizationId) throw new Error('organization_id is required');

  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'organization-profile',
      { body: args },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'organization profile update failed'));
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'organization-profile',
      [
        'updated_at',
        'branding',
        'profile',
        'changed',
        'changed_fields',
        'default_settings',
        'settings_resolution_id',
      ],
    );
    const returnedOrganizationId =
      asNonEmptyString(merged.organization_id) ??
      asNonEmptyString(merged.id);
    if (!returnedOrganizationId) throw new Error('organization-profile did not return organization_id');
    const readback = await requireLiveResourceReadback('organizations', returnedOrganizationId, 'organization-profile');
    requireOrganizationProfileReadback(args, merged, readback, 'organization-profile');
    return { ...result, ...envelope, ok: true, organization_id: returnedOrganizationId, readback };
  }

  assertSeedFallbackAllowed('ui_update_organization_profile_v1');
  await sleep(60);
  const organizations = (seed as { organizations?: Array<Record<string, unknown>> }).organizations ?? [];
  const target = organizations.find((row) => row.id === organizationId);
  if (target) {
    const existingSettings = plainObject(target.default_settings);
    const existingBranding = plainObject(existingSettings.branding);
    const brandingPatch = {
      logo_url: asNonEmptyString(args.logo_url) ?? undefined,
      logo_file_name: asNonEmptyString(args.file_name) ?? asNonEmptyString(args.logo_file_name),
      logo_content_type: asNonEmptyString(args.content_type) ?? asNonEmptyString(args.logo_content_type),
      primary_color: asNonEmptyString(args.primary_color) ?? undefined,
      secondary_color: asNonEmptyString(args.secondary_color) ?? undefined,
    };
    if (asNonEmptyString(args.name)) target.name = asNonEmptyString(args.name)!;
    if (asNonEmptyString(args.timezone)) target.timezone = asNonEmptyString(args.timezone)!;
    if (asNonEmptyString(args.locale)) target.locale = asNonEmptyString(args.locale)!;
    target.default_settings = mergePlainObjects(existingSettings, {
      branding: mergePlainObjects(existingBranding, brandingPatch),
      ...plainObject(args.default_settings_patch),
    });
  }

  return buildEnvelope({
    organization_id: organizationId,
    name: target?.name ?? args.name,
    branding: plainObject(plainObject(target?.default_settings).branding),
  });
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
  const organizationId =
    asNonEmptyString(args.organization_id) ??
    asNonEmptyString(state.user.organization_id) ??
    asNonEmptyString((state.scope?.tenant as Record<string, unknown> | undefined)?.id);
  if (!organizationId) throw new Error('organization_id is required');

  const live = await liveRpc('ui_list_tenant_invitable_roles_v1', {
    p_organization_id: organizationId,
  });
  if (live) return normalizeLiveListResult<ResourceRow>(live.data, 0, 200);

  await sleep(30);
  if (!hasCapability('users.manage')) {
    const err = new Error('Capability denied: users.manage') as Error & {
      code?: string;
      capability?: string;
    };
    err.code = 'capability_denied';
    err.capability = 'users.manage';
    throw err;
  }
  const rows = (RESOURCE_DATA().rbac_role_summary ?? [])
    .filter((row) => {
      const rec = row as Record<string, unknown>;
      return rec.organization_id === organizationId && rec.is_active !== false;
    })
    .map((row) => {
      const rec = row as Record<string, unknown>;
      return {
        id: rec.id,
        role_id: rec.id,
        organization_id: rec.organization_id,
        role_key: rec.key ?? rec.role_key,
        key: rec.key ?? rec.role_key,
        name: rec.name ?? rec.key ?? rec.role_key,
        description: rec.description ?? null,
        is_active: rec.is_active !== false,
      } as ResourceRow;
    })
    .sort((a, b) => String(a.role_key ?? a.key ?? '').localeCompare(String(b.role_key ?? b.key ?? '')));

  return {
    rows,
    total: rows.length,
    page: 0,
    page_size: rows.length || 200,
  };
}

export async function tenant_user_invite_v1(
  args: DataSourceTenantUserInviteArgs,
): Promise<Record<string, unknown>> {
  const email = asNonEmptyString(args.email)?.toLowerCase();
  const fullName = asNonEmptyString(args.full_name);
  const roleKey = asNonEmptyString(args.role_key)?.toLowerCase();
  if (!email) throw new Error('email is required');
  if (!fullName) throw new Error('full_name is required');
  if (!roleKey) throw new Error('role_key is required');

  const client = getSupabaseClient();
  if (client) {
    const shouldSendInviteEmail = args.send_invite_email !== false;
    const redirect = shouldSendInviteEmail
      ? asNonEmptyString(args.invite_redirect_to) ?? hostedInviteRedirect()
      : null;
    const body = {
      ...args,
      email,
      full_name: fullName,
      role_key: roleKey,
      send_invite_email: shouldSendInviteEmail,
      invite_redirect_to: redirect,
    };
    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'tenant-user-invite',
      { body },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'tenant user invite failed'));
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'tenant-user-invite',
      ['user_id', 'auth_user_id', 'id', 'invite_id', 'invite_email_sent_at'],
    );
    const returnedUserId =
      asNonEmptyString(merged.user_id) ??
      asNonEmptyString(merged.auth_user_id) ??
      asNonEmptyString(merged.id);
    if (!returnedUserId) throw new Error('tenant-user-invite did not return user evidence');
    const assignmentId =
      asNonEmptyString(merged.rbac_user_role_assignment_id) ??
      asNonEmptyString(merged.user_role_assignment_id) ??
      asNonEmptyString(merged.assignment_id);
    const lifecycleReadback = await requireLiveUserLifecycleReadback('tenant-user-invite', returnedUserId);
    assertLiveUserScopeReadback(
      'tenant-user-invite',
      lifecycleReadback,
      asNonEmptyString(args.access_scope_type) ?? 'tenant',
      asNonEmptyString(args.access_scope_id),
    );
    await requireLiveUserRoleAssignmentReadback(
      'tenant-user-invite',
      returnedUserId,
      roleKey,
      assignmentId,
      lifecycleReadback.directory,
    );
    await requireLiveUserSecurityActionReadback(
      'tenant-user-invite',
      returnedUserId,
      'tenant_user_invite_apply_v1',
      merged,
      null,
      {
        roleKey,
        assignmentId,
        inviteEmail: email,
        inviteEmailSent: merged.invite_email_sent === true || merged.invite_email_sent === 'true',
        sendInviteEmailRequested: shouldSendInviteEmail,
        inviteRedirectTo: redirect,
      },
    );
    return {
      ...result,
      ...envelope,
      ok: true,
      user_id: returnedUserId,
      email: asNonEmptyString(merged.email) ?? email,
      role_key: asNonEmptyString(merged.role_key) ?? roleKey,
    };
  }

  assertSeedFallbackAllowed('tenant_user_invite_v1');
  await sleep(60);
  const users = (seed as { users?: Array<Record<string, unknown>> }).users ?? [];
  const organizationId =
    asNonEmptyString(args.organization_id) ??
    asNonEmptyString(state.user.organization_id) ??
    asNonEmptyString((state.scope?.tenant as Record<string, unknown> | undefined)?.id);
  if (!organizationId) throw new Error('organization_id is required');
  const userId = `usr_invited_${email.replace(/[^a-z0-9]+/g, '_')}`;
  const accessScopeType = asNonEmptyString(args.access_scope_type) ?? 'tenant';
  const userTypeRows = getLookups('user_type');
  const requestedUserType = asNonEmptyString(args.user_type);
  const userType =
    requestedUserType ??
    (userTypeRows.some((row) => row.value === roleKey)
      ? roleKey
      : userTypeRows.find((row) => row.is_default)?.value ?? userTypeRows[0]?.value ?? 'ops_admin');
  const accessScopeId =
    accessScopeType === 'client' || accessScopeType === 'sender'
      ? asNonEmptyString(args.access_scope_id)
      : null;
  const existing = users.find((row) => String(row.email ?? '').toLowerCase() === email);
  if (existing) {
    existing.full_name = fullName;
    existing.user_type = userType;
    existing.status = existing.status === 'suspended' ? existing.status : 'invited';
    existing.access_scope_type = accessScopeType;
    existing.access_scope_id = accessScopeId;
  } else {
    users.push({
      id: userId,
      organization_id: organizationId,
      email,
      full_name: fullName,
      user_type: userType,
      access_scope_type: accessScopeType,
      access_scope_id: accessScopeId,
      status: 'invited',
      last_login_at: null,
      created_at: new Date().toISOString(),
    });
  }

  return buildEnvelope({
    user_id: existing?.id ?? userId,
    organization_id: organizationId,
    email,
    full_name: fullName,
    role_key: roleKey,
    status: 'invited',
    invite_email_sent: false,
  });
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
  const target = liveRpcTarget();
  if (target) {
    const { data, error } = await target.rpc('public_tracking_review_request_v1', { p_input: args });
    if (error) throw new Error(error.message);
    return requireLiveMutationResult(data, 'public_tracking_review_request_v1', [
      'support_case_id',
      'outcome',
    ]);
  }
  assertSeedFallbackAllowed('RPC public_tracking_review_request_v1');
  await sleep(60);
  const decision = String(args.decision ?? '').toLowerCase();
  const outcome = decision.startsWith('reject') ? 'rejected' : 'applied';
  return buildEnvelope({
    support_case_id: args.support_case_id,
    outcome,
  });
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

// FINANCE — settlements
async function requireLiveSettlementBatchReadback(
  rpcName: string,
  settlementBatchId: string,
): Promise<void> {
  await requireLiveResourceReadback('settlement_batches', settlementBatchId, rpcName);
  await requireLiveResourceReadback('settlement_batch_summary', settlementBatchId, rpcName);
}

async function requireLiveFinanceEventReadback(
  rpcName: string,
  financeEventId: string,
): Promise<void> {
  await requireLiveResourceReadback('finance_events_ledger', financeEventId, rpcName);
}

async function requireLiveFinanceMutationReadback(
  rpcName: string,
  rec: Record<string, unknown>,
  args: Record<string, unknown> = {},
  idTarget: 'settlement_batch' | 'finance_event' | null = null,
): Promise<void> {
  const resultId = asNonEmptyString(rec.id);
  const settlementBatchId =
    asNonEmptyString(rec.settlement_batch_id) ??
    asNonEmptyString(args.settlement_batch_id) ??
    (idTarget === 'settlement_batch' ? resultId : null);
  if (settlementBatchId) {
    await requireLiveSettlementBatchReadback(rpcName, settlementBatchId);
  }
  const financeEventIds = Array.from(new Set([
    asNonEmptyString(rec.finance_event_id),
    asNonEmptyString(rec.from_finance_event_id),
    asNonEmptyString(rec.to_finance_event_id),
    asNonEmptyString(rec.reversed_finance_event_id),
    asNonEmptyString(rec.reversal_finance_event_id),
    idTarget === 'finance_event' ? resultId : null,
  ].filter((value): value is string => Boolean(value))));
  for (const financeEventId of financeEventIds) {
    await requireLiveFinanceEventReadback(rpcName, financeEventId);
  }
  const codEntryId =
    asNonEmptyString(rec.cod_entry_id) ??
    asNonEmptyString(args.cod_entry_id);
  if (codEntryId) {
    await requireLiveResourceReadback('cod_entries', codEntryId, rpcName);
  }
}

async function liveFinanceMutationResult(
  rpcName: string,
  args: Record<string, unknown>,
  evidenceKeys: string[],
  idTarget: 'settlement_batch' | 'finance_event' | null = null,
): Promise<Record<string, unknown> | null> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, { p_args: args });
  if (!live) return null;
  const rec = requireLiveMutationResult(live.data, rpcName, evidenceKeys);
  await requireLiveFinanceMutationReadback(rpcName, rec, args, idTarget);
  return rec;
}

export async function apply_settlement_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('apply_settlement_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  assertSeedFallbackAllowed('RPC apply_settlement_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}
export async function reject_settlement_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('reject_settlement_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  assertSeedFallbackAllowed('RPC reject_settlement_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}
export async function ui_create_settlement_batch_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_create_settlement_batch_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  assertSeedFallbackAllowed('RPC ui_create_settlement_batch_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}
export async function ui_transition_settlement_batch_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_transition_settlement_batch_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  assertSeedFallbackAllowed('RPC ui_transition_settlement_batch_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}
export async function ui_record_cod_remittance_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_record_cod_remittance_v1', args, [
    'finance_event_id',
    'from_finance_event_id',
    'to_finance_event_id',
    'settlement_batch_id',
    'settlement_event_id',
  ]);
  if (live) return live;
  assertSeedFallbackAllowed('RPC ui_record_cod_remittance_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'finance_event');
}
export async function ui_adjust_cod_collection_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_adjust_cod_collection_v1', args, [
    'finance_event_id',
    'settlement_batch_id',
    'settlement_event_id',
  ]);
  if (live) return live;
  assertSeedFallbackAllowed('RPC ui_adjust_cod_collection_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'finance_event');
}
export async function ui_reverse_finance_event_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_reverse_finance_event_v1', args, [
    'finance_event_id',
    'reversed_finance_event_id',
    'reversal_finance_event_id',
    'id',
  ], 'finance_event');
  if (live) return live;
  assertSeedFallbackAllowed('RPC ui_reverse_finance_event_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'finance_event');
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
  const live = await liveRpc<Record<string, unknown>>('zone_create_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_create_v1', [
      'zone_id',
    ]) as ZoneCreateResult;
  }

  await sleep(60);
  return buildEnvelope({
    zone_id: (args.zone_id as string | undefined) ?? nextResourceId('zone'),
    initial_district_count: Array.isArray(args.initial_district_ids)
      ? (args.initial_district_ids as unknown[]).length
      : 0,
  }) as ZoneCreateResult;
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
  const live = await liveRpc<Record<string, unknown>>('zone_update_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_update_v1', [
      'zone_id',
    ]) as ZoneProfileMutationResult;
  }

  await sleep(60);
  const zoneId = asNonEmptyString(args.zone_id) ?? asNonEmptyString(args.id);
  if (!zoneId) throw new Error('zone_update_v1 requires zone_id');
  const patch = objectRecord(args.patch);
  const zones = (seed as { zones?: Array<Record<string, unknown>> }).zones ?? [];
  const zone = zones.find((row) => row.id === zoneId);
  if (!zone) throw new Error(`zone_not_found:${zoneId}`);

  const changed: Record<string, unknown> = {};
  const nextMetadata = objectRecord(zone.metadata);
  if (patch.name !== undefined) {
    const next = asNonEmptyString(patch.name);
    if (!next) throw new Error('zone_update_v1 name cannot be blank');
    zone.name = next;
    changed.name = next;
  }
  if (patch.slug !== undefined) {
    const next = asNonEmptyString(patch.slug)?.toLowerCase();
    if (!next) throw new Error('zone_update_v1 slug cannot be blank');
    zone.slug = next;
    changed.slug = next;
  }
  if (patch.description !== undefined) {
    const next = asNonEmptyString(patch.description);
    zone.description = next;
    zone.notes = next ?? '';
    changed.description = next;
  }
  if (patch.sort_order !== undefined) {
    const next = Number(patch.sort_order);
    if (!Number.isFinite(next)) throw new Error('zone_update_v1 sort_order must be numeric');
    zone.sort_order = next;
    changed.sort_order = next;
  }
  const metadataPatch = objectRecord(patch.metadata);
  for (const [key, value] of Object.entries(metadataPatch)) {
    nextMetadata[key] = value;
  }
  if (patch.color_token !== undefined) {
    const next = asNonEmptyString(patch.color_token)?.toLowerCase() ?? null;
    nextMetadata.color_token = next;
    zone.color_token = next ?? undefined;
    changed.color_token = next;
  }
  zone.metadata = nextMetadata;
  zone.updated_at = new Date().toISOString();

  return buildEnvelope({
    zone_id: zoneId,
    changed,
  }) as ZoneProfileMutationResult;
}

export async function zone_delete_v1(
  args: Record<string, unknown>,
): Promise<ZoneProfileMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('zone_delete_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_delete_v1', [
      'zone_id',
    ]) as ZoneProfileMutationResult;
  }

  await sleep(60);
  const zoneId = asNonEmptyString(args.zone_id) ?? asNonEmptyString(args.id);
  if (!zoneId) throw new Error('zone_delete_v1 requires zone_id');
  const zones = (seed as { zones?: Array<Record<string, unknown>> }).zones ?? [];
  const zone = zones.find((row) => row.id === zoneId);
  if (!zone) throw new Error(`zone_not_found:${zoneId}`);
  const metadata = objectRecord(zone.metadata);
  const alreadyProcessed = zone.is_active === false && metadata.lifecycle === 'retired';
  if (!alreadyProcessed) {
    const now = new Date().toISOString();
    zone.is_active = false;
    zone.status = 'retired';
    zone.metadata = {
      ...metadata,
      lifecycle: 'retired',
      retired_at: now,
      retired_by_user_id: state.user.id ?? null,
      retired_reason: asNonEmptyString(args.reason),
      retired_metadata: objectRecord(args.metadata),
    };
    zone.updated_at = now;
  }

  return buildEnvelope({
    zone_id: zoneId,
    is_active: false,
    lifecycle: 'retired',
    already_processed: alreadyProcessed,
  }) as ZoneProfileMutationResult;
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
  const live = await liveRpc<Record<string, unknown>>('zone_district_add_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_district_add_v1', [
      'zone_district_id',
    ]) as ZoneDistrictMutationResult;
  }
  await sleep(60);
  return buildEnvelope({
    zone_district_id:
      (args.zone_district_id as string | undefined) ?? nextResourceId('zone_district'),
    already_processed: false,
  }) as ZoneDistrictMutationResult;
}

export async function zone_district_remove_v1(
  args: Record<string, unknown>,
): Promise<ZoneDistrictMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('zone_district_remove_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_district_remove_v1', [
      'zone_district_id',
    ]) as ZoneDistrictMutationResult;
  }
  await sleep(60);
  return buildEnvelope({
    zone_district_id:
      (args.zone_district_id as string | undefined) ?? nextResourceId('zone_district'),
    already_processed: false,
  }) as ZoneDistrictMutationResult;
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

function normalizeParticipantReviewDecision(value: string | null | undefined): string | null {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) return null;
  if (normalized === 'approve') return 'approved';
  if (normalized === 'reject') return 'rejected';
  return normalized;
}

function assertParticipantReviewReadbackState(
  row: Record<string, unknown>,
  expectedDecision: string,
  resourceKey: string,
  requestId: string,
): void {
  const expected = normalizeParticipantReviewDecision(expectedDecision);
  if (!expected) return;
  const status = asNonEmptyString(row.status)?.toLowerCase() ?? null;
  const reviewDecision = asNonEmptyString(row.review_decision)?.toLowerCase() ?? null;
  const reviewedAt = asNonEmptyString(row.reviewed_at);
  if (expected === 'approved' || expected === 'rejected') {
    if (status !== expected && reviewDecision !== expected) {
      throw new Error(
        `marketplace-participant-review backend readback ${resourceKey}:${requestId} is not ${expected}`,
      );
    }
    if (!reviewedAt) {
      throw new Error(
        `marketplace-participant-review backend readback ${resourceKey}:${requestId} missing reviewed_at`,
      );
    }
    return;
  }
  if (expected === 'request_additional_docs') {
    const decisionMetadata = row.decision_metadata && typeof row.decision_metadata === 'object' && !Array.isArray(row.decision_metadata)
      ? row.decision_metadata as Record<string, unknown>
      : {};
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    if (decisionMetadata.request_additional_docs !== true && metadata.request_additional_docs !== true) {
      throw new Error(
        `marketplace-participant-review backend readback ${resourceKey}:${requestId} missing request_additional_docs evidence`,
      );
    }
  }
}

const PARTICIPANT_REVIEW_READBACK_ATTEMPTS = 10;
const PARTICIPANT_REVIEW_READBACK_DELAY_MS = 250;

async function requireParticipantReviewStateReadback(
  resourceKey: string,
  requestId: string,
  rpcName: string,
  decision: string,
): Promise<Record<string, unknown>> {
  const readRow = async () => {
    if (resourceKey === 'marketplace_participant_requests') {
      const rows = await readLiveResourceListReadback(
        resourceKey,
        { id: requestId },
        rpcName,
      );
      const row = rows[0];
      if (!row || Object.keys(row).length === 0) {
        throw new Error(`${rpcName} backend readback missing ${resourceKey}:${requestId}`);
      }
      return row;
    }
    return requireLiveResourceReadback(resourceKey, requestId, rpcName);
  };
  let row = await readRow();
  let lastStateError: unknown;
  for (let attempt = 1; attempt <= PARTICIPANT_REVIEW_READBACK_ATTEMPTS; attempt += 1) {
    try {
      assertParticipantReviewReadbackState(row, decision, resourceKey, requestId);
      return row;
    } catch (err) {
      lastStateError = err;
      if (attempt >= PARTICIPANT_REVIEW_READBACK_ATTEMPTS) break;
      await sleep(PARTICIPANT_REVIEW_READBACK_DELAY_MS);
      row = await readRow();
    }
  }
  throw lastStateError instanceof Error
    ? lastStateError
    : new Error(`${rpcName} backend readback ${resourceKey}:${requestId} did not reflect review state`);
}

async function participantReviewSuccessFromReadback({
  requestId,
  decision,
  metadata,
  merged = {},
  result = {},
  envelope = {},
  recoveredFromFunctionError,
  functionErrorMessage,
}: {
  requestId: string;
  decision: string;
  metadata: Record<string, unknown>;
  merged?: Record<string, unknown>;
  result?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
  recoveredFromFunctionError?: boolean;
  functionErrorMessage?: string;
}): Promise<Record<string, unknown>> {
  const normalizedDecision = normalizeParticipantReviewDecision(decision);
  const requestReadback = await requireParticipantReviewStateReadback(
    'marketplace_participant_requests',
    requestId,
    'marketplace-participant-review',
    decision,
  );
  const returnedDecision =
    asNonEmptyString(merged.decision) ??
    asNonEmptyString(merged.status) ??
    asNonEmptyString(requestReadback.review_decision) ??
    asNonEmptyString(requestReadback.status) ??
    normalizedDecision;
  if (!returnedDecision) throw new Error('marketplace-participant-review did not return decision status');
  const participantType =
    asNonEmptyString(requestReadback.requested_participant_type_key) ??
    asNonEmptyString(merged.requested_participant_type_key) ??
    asNonEmptyString(metadata.participant_type);
  const driverApplicationReadback = participantType === 'freelancer_driver'
    ? await requireParticipantReviewStateReadback(
        'driver_application_directory',
        requestId,
        'marketplace-participant-review',
        decision,
      )
    : null;
  return {
    ...result,
    ...envelope,
    ok: true,
    marketplace_participant_request_id: requestId,
    participant_request_readback: requestReadback,
    ...(driverApplicationReadback ? { driver_application_readback: driverApplicationReadback } : {}),
    decision: returnedDecision,
    ...(recoveredFromFunctionError
      ? {
          recovered_from_function_error: true,
          function_error_message: functionErrorMessage,
        }
      : {}),
  };
}

export async function marketplace_participant_request_review_apply_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId =
    asNonEmptyString(args.participant_request_id) ??
    asNonEmptyString(args.request_id) ??
    asNonEmptyString(args.id);
  const decision = asNonEmptyString(args.decision)?.toLowerCase() ?? null;
  if (!requestId) throw new Error('participant_request_id is required');
  if (!decision) throw new Error('decision is required');

  const client = getSupabaseClient();
  if (client) {
    const metadata = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
      ? (args.metadata as Record<string, unknown>)
      : {};
    const requestedDocuments = Array.isArray(args.requested_documents)
      ? args.requested_documents.filter((doc): doc is string => typeof doc === 'string' && doc.trim().length > 0)
      : [];
    const note = asNonEmptyString(args.note);
    const decisionMetadata = {
      ...metadata,
      ...(requestedDocuments.length ? { requested_documents: requestedDocuments } : {}),
      ...(note ? { note } : {}),
    };
    const body: Record<string, unknown> = {
      request_id: requestId,
      decision,
      metadata: decisionMetadata,
    };
    const reason = asNonEmptyString(args.reason) ?? note ?? asNonEmptyString(metadata.reason);
    if (reason) body.reason = reason;
    const normalizedDecision = normalizeParticipantReviewDecision(decision);
    const inviteRedirectTo =
      asNonEmptyString(args.invite_redirect_to) ??
      (normalizedDecision === 'approved' ? hostedInviteRedirect() : null);
    if (inviteRedirectTo) body.invite_redirect_to = inviteRedirectTo;

    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'marketplace-participant-review',
      { body },
    );
    if (error) {
      const errorMessage = await readFunctionErrorMessage(error, 'marketplace participant review failed');
      try {
        return await participantReviewSuccessFromReadback({
          requestId,
          decision,
          metadata,
          recoveredFromFunctionError: true,
          functionErrorMessage: errorMessage,
        });
      } catch {
        throw new Error(errorMessage);
      }
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'marketplace-participant-review',
      [
        'marketplace_participant_request_id',
        'participant_request_id',
        'request_id',
        'id',
        'reviewed_at',
        'decision_log_id',
        'domain_event_id',
        'participant_profile_id',
      ],
    );
    const returnedRequestId =
      asNonEmptyString(merged.marketplace_participant_request_id) ??
      asNonEmptyString(merged.participant_request_id) ??
      asNonEmptyString(merged.request_id) ??
      asNonEmptyString(merged.id);
    if (!returnedRequestId) {
      throw new Error('marketplace-participant-review did not return participant request evidence');
    }
    return participantReviewSuccessFromReadback({
      requestId: returnedRequestId,
      decision,
      metadata,
      merged,
      result,
      envelope,
    });
  }

  assertSeedFallbackAllowed('marketplace_participant_request_review_apply_v1');
  await sleep(60);
  return buildEnvelope({
    marketplace_participant_request_id: requestId,
    decision,
  });
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
  const live = await livePArgsMutationResult('branch_create_v1', args, ['branch_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchMutationResult>(
      live,
      ['branch_id', 'id'],
      'branch_id',
      'branch_create_v1 did not return branch_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_id: (args.branch_id as string | undefined) ?? nextResourceId('branch'),
  }) as BranchMutationResult;
}

export async function branch_update_v1(
  args: Record<string, unknown>,
): Promise<BranchMutationResult> {
  const live = await livePArgsMutationResult('branch_update_v1', args, ['branch_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchMutationResult>(
      live,
      ['branch_id', 'id'],
      'branch_id',
      'branch_update_v1 did not return branch_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_id: (args.branch_id as string | undefined) ?? nextResourceId('branch'),
  }) as BranchMutationResult;
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
  // Backend RPC name is `mark_branch_oos_v1`; FE facade keeps the
  // `branch_mark_oos_v1` name to avoid breaking existing call sites.
  const live = await livePArgsMutationResult('mark_branch_oos_v1', args, [
    'branch_ids',
    'branch_id',
    'already_oos',
    'updated_count',
  ]);
  if (live) {
    requireLiveDomainEvidence(
      live,
      'mark_branch_oos_v1',
      ['branch_ids', 'branch_id', 'already_oos'],
      'branch selection',
    );
    const updatedCount = requireLiveNumberField(
      live,
      ['updated_count', 'count', 'affected_count'],
      'mark_branch_oos_v1 did not return updated_count',
    );
    const branchIds = Array.isArray(live.branch_ids)
      ? live.branch_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : asNonEmptyString(live.branch_id)
        ? [asNonEmptyString(live.branch_id)!]
        : [];
    const alreadyOos = Array.isArray(live.already_oos)
      ? live.already_oos.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    return {
      ...live,
      branch_ids: branchIds.length ? branchIds : alreadyOos,
      already_oos: alreadyOos,
      updated_count: updatedCount,
    } as BranchMarkOosResult;
  }
  await sleep(60);
  const ids = Array.isArray(args.branch_ids)
    ? (args.branch_ids as string[])
    : args.branch_id
      ? [args.branch_id as string]
      : [];
  return buildEnvelope({
    branch_ids: ids,
    already_oos: [],
    updated_count: ids.length,
  }) as BranchMarkOosResult;
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
  const live = await livePArgsMutationResult('branch_zone_assign_v1', args, ['branch_zone_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchZoneMutationResult>(
      live,
      ['branch_zone_id', 'id'],
      'branch_zone_id',
      'branch_zone_assign_v1 did not return branch_zone_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_zone_id: nextResourceId('branch_zone'),
    already_processed: false,
  }) as BranchZoneMutationResult;
}

export async function branch_zone_unassign_v1(
  args: Record<string, unknown>,
): Promise<BranchZoneMutationResult> {
  const live = await livePArgsMutationResult('branch_zone_unassign_v1', args, ['branch_zone_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchZoneMutationResult>(
      live,
      ['branch_zone_id', 'id'],
      'branch_zone_id',
      'branch_zone_unassign_v1 did not return branch_zone_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_zone_id:
      (args.branch_zone_id as string | undefined) ?? nextResourceId('branch_zone'),
    already_processed: false,
  }) as BranchZoneMutationResult;
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
  const live = await livePArgsMutationResult('add_branch_member_v1', args, [
    'branch_membership_id',
    'membership_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchMembershipMutationResult>(
      live,
      ['branch_membership_id', 'membership_id', 'id'],
      'branch_membership_id',
      'add_branch_member_v1 did not return branch_membership_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_membership_id: nextResourceId('branch_membership'),
    already_processed: false,
  }) as BranchMembershipMutationResult;
}

export async function remove_branch_member_v1(
  args: Record<string, unknown>,
): Promise<BranchMembershipMutationResult> {
  const live = await livePArgsMutationResult('remove_branch_member_v1', args, [
    'branch_membership_id',
    'membership_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchMembershipMutationResult>(
      live,
      ['branch_membership_id', 'membership_id', 'id'],
      'branch_membership_id',
      'remove_branch_member_v1 did not return branch_membership_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_membership_id:
      (args.membership_id as string | undefined) ?? nextResourceId('branch_membership'),
    already_processed: false,
  }) as BranchMembershipMutationResult;
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
  const live = await livePArgsMutationResult('branch_capacity_window_set_v1', args, [
    'branch_capacity_window_id',
    'capacity_window_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchCapacityWindowMutationResult>(
      live,
      ['branch_capacity_window_id', 'capacity_window_id', 'id'],
      'branch_capacity_window_id',
      'branch_capacity_window_set_v1 did not return branch_capacity_window_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_capacity_window_id:
      (args.capacity_window_id as string | undefined) ?? nextResourceId('branch_capacity_window'),
    already_processed: false,
  }) as BranchCapacityWindowMutationResult;
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
  const live = await livePArgsMutationResult('branch_coverage_window_upsert_v1', args, [
    'branch_coverage_window_id',
    'coverage_window_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchCoverageWindowMutationResult>(
      live,
      ['branch_coverage_window_id', 'coverage_window_id', 'id'],
      'branch_coverage_window_id',
      'branch_coverage_window_upsert_v1 did not return branch_coverage_window_id',
    );
  }
  await sleep(60);
  const isUpdate = typeof args.coverage_window_id === 'string' && args.coverage_window_id;
  return buildEnvelope({
    branch_coverage_window_id:
      (args.coverage_window_id as string | undefined) ?? nextResourceId('branch_coverage_window'),
    action: isUpdate ? 'updated' : 'created',
    already_processed: false,
  }) as BranchCoverageWindowMutationResult;
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
//   • ui_upsert_webhook_rule_v1              (Phase B6)
//   • ui_delete_webhook_rule_v1              (Phase B6)
//   • ui_reorder_webhook_rule_v1             (Phase B6)
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
function resolveWebhookSourceId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.webhook_source_id)
    ?? asNonEmptyString(rec.source_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.webhook_source_id)
    ?? asNonEmptyString(args.source_id);
}

function booleanReadback(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 't', '1', 'yes', 'enabled'].includes(normalized)) return true;
    if (['false', 'f', '0', 'no', 'disabled'].includes(normalized)) return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function requireWebhookSourceFieldReadback(
  row: Record<string, unknown>,
  field: string,
  expected: unknown,
  rpcName: string,
): void {
  if (expected === undefined) return;
  const actual = row[field];
  if (field === 'rate_limit_per_hour' && (expected === null || expected === '')) {
    const actualNumber = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(actualNumber) || actualNumber < 1) {
      throw new Error(`${rpcName} backend readback did not resolve intake source ${field}`);
    }
    return;
  }
  if (field === 'enabled') {
    const actualBool = booleanReadback(actual);
    if (actualBool !== Boolean(expected)) {
      throw new Error(`${rpcName} backend readback did not reflect intake source enabled state`);
    }
    return;
  }
  if (expected === null || expected === '') {
    if (actual != null && String(actual).trim() !== '') {
      throw new Error(`${rpcName} backend readback did not clear intake source ${field}`);
    }
    return;
  }
  if (field === 'rate_limit_per_hour') {
    const actualNumber = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(actualNumber) || actualNumber !== Number(expected)) {
      throw new Error(`${rpcName} backend readback did not reflect intake source ${field}`);
    }
    return;
  }
  const actualString = asNonEmptyString(actual);
  if (actualString !== String(expected).trim()) {
    throw new Error(`${rpcName} backend readback did not reflect intake source ${field}`);
  }
}

function requireWebhookSourceMutationReadback(
  sourceReadback: Record<string, unknown>,
  directoryReadback: Record<string, unknown>,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  rpcName: string,
): void {
  for (const field of [
    'name',
    'source_identifier',
    'provider_type',
    'mapping_config_id',
    'sender_id',
    'rate_limit_per_hour',
    'enabled',
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, field)) {
      requireWebhookSourceFieldReadback(sourceReadback, field, args[field], rpcName);
      requireWebhookSourceFieldReadback(directoryReadback, field, args[field], rpcName);
    }
  }
  if (asNonEmptyString(result.auth_token) && !asNonEmptyString(directoryReadback.auth_token_masked)) {
    throw new Error(`${rpcName} backend readback did not expose redacted intake source token state`);
  }
}

function webhookSourceArchivedAt(row: Record<string, unknown>): string | null {
  return asNonEmptyString(row.archived_at)
    ?? asNonEmptyString(objectRecord(row.managed_metadata).archived_at);
}

function requireWebhookSourceArchiveReadback(
  sourceReadback: Record<string, unknown>,
  directoryReadback: Record<string, unknown>,
  rpcName: string,
): void {
  for (const row of [sourceReadback, directoryReadback]) {
    const enabled = booleanReadback(row.enabled);
    if (enabled !== false) {
      throw new Error(`${rpcName} backend readback did not disable archived intake source`);
    }
    const metadata = objectRecord(row.managed_metadata);
    const lifecycleState = asNonEmptyString(row.lifecycle_state)
      ?? asNonEmptyString(metadata.lifecycle);
    if (lifecycleState !== 'archived' && !webhookSourceArchivedAt(row)) {
      throw new Error(`${rpcName} backend readback did not expose intake source archive metadata`);
    }
  }
}

async function webhookSourceMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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

// INTEGRATIONS — webhook_rules (Create/Update/Reorder/Delete)
export interface UpsertWebhookRuleArgs extends Record<string, unknown> {
  rule_id?: string | null;
  webhook_source_id?: string;
  name?: string;
  event_type?: string;
  priority?: number;
  mapping_config_id?: string | null;
  workflow_template_id?: string | null;
  domain_category?: string | null;
  enabled?: boolean;
}
function resolveWebhookRuleId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.webhook_rule_id)
    ?? asNonEmptyString(rec.rule_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.webhook_rule_id)
    ?? asNonEmptyString(args.rule_id);
}

function requireWebhookRuleFieldReadback(
  row: Record<string, unknown>,
  field: string,
  expected: unknown,
  rpcName: string,
): void {
  if (expected === undefined || expected === null || expected === '') return;
  const actual = row[field];
  if (field === 'enabled') {
    const actualBool = booleanReadback(actual);
    if (actualBool !== Boolean(expected)) {
      throw new Error(`${rpcName} backend readback did not reflect webhook rule enabled state`);
    }
    return;
  }
  if (field === 'priority') {
    const actualNumber = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(actualNumber) || actualNumber !== Number(expected)) {
      throw new Error(`${rpcName} backend readback did not reflect webhook rule priority`);
    }
    return;
  }
  const actualString = asNonEmptyString(actual);
  if (actualString !== String(expected).trim()) {
    throw new Error(`${rpcName} backend readback did not reflect webhook rule ${field}`);
  }
}

function requireWebhookRuleMutationReadback(
  row: Record<string, unknown>,
  ruleId: string,
  args: Record<string, unknown>,
  rpcName: string,
): void {
  if (asNonEmptyString(row.id) !== ruleId) {
    throw new Error(`${rpcName} backend readback returned the wrong webhook rule`);
  }
  for (const field of [
    'webhook_source_id',
    'name',
    'event_type',
    'priority',
    'mapping_config_id',
    'workflow_template_id',
    'domain_category',
    'enabled',
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, field)) {
      requireWebhookRuleFieldReadback(row, field, args[field], rpcName);
    }
  }
}

async function webhookRuleMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'webhook_rule');
  if (liveRpcTarget()) {
    const ruleId = resolveWebhookRuleId(result, args);
    if (!ruleId) throw new Error(`${rpcName} did not return webhook_rule_id`);
    if (rpcName === 'ui_delete_webhook_rule_v1') {
      await requireLiveResourceAbsenceReadback(
        'webhook_rules',
        { id: ruleId },
        rpcName,
        `webhook_rules:${ruleId}`,
      );
    } else {
      const readback = await requireLiveResourceReadback('webhook_rules', ruleId, rpcName);
      requireWebhookRuleMutationReadback(readback, ruleId, args, rpcName);
    }
  }
  return result;
}

export const ui_upsert_webhook_rule_v1 = (args: UpsertWebhookRuleArgs) =>
  webhookRuleMutation('ui_upsert_webhook_rule_v1', args);
export const ui_delete_webhook_rule_v1 = (args: { rule_id: string }) =>
  webhookRuleMutation('ui_delete_webhook_rule_v1', args);
export const ui_reorder_webhook_rule_v1 = (args: { rule_id: string; priority: number }) =>
  webhookRuleMutation('ui_reorder_webhook_rule_v1', args);

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
  const mappingConfigId = asNonEmptyString(args.mapping_config_id);
  if (!mappingConfigId) throw new Error('ui_delete_mapping_config_v1 requires mapping_config_id');

  const live = await liveRpc<Record<string, unknown>>('ui_delete_resource_v1', {
    p_resource: 'mapping_configs',
    p_id: mappingConfigId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_delete_mapping_config_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_delete_mapping_config_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const deletedId =
      asNonEmptyString(rec.mapping_config_id) ??
      asNonEmptyString(rec.id);
    if (deletedId !== mappingConfigId) {
      throw new Error('ui_delete_mapping_config_v1 backend outcome did not match the requested mapping');
    }
    const mappingReadback = await ui_list_resource_v1<Record<string, unknown>>('mapping_configs', {
      filter: { id: mappingConfigId },
      page_size: 1,
    });
    if (mappingReadback.rows.some((row) => asNonEmptyString(row.id) === mappingConfigId)) {
      throw new Error('ui_delete_mapping_config_v1 confirmation still shows the mapping in Intake mappings');
    }
    const directoryReadback = await ui_list_resource_v1<Record<string, unknown>>('mapping_config_directory', {
      filter: { id: mappingConfigId },
      page_size: 1,
    });
    if (directoryReadback.rows.some((row) => asNonEmptyString(row.id) === mappingConfigId)) {
      throw new Error('ui_delete_mapping_config_v1 confirmation still shows the mapping in External Intake usage');
    }
    return {
      ...rec,
      mapping_config_id: mappingConfigId,
    };
  }

  await sleep(60);
  return buildMutationFallbackEnvelope({ mapping_config_id: mappingConfigId }, 'mapping_config');
}
export async function ui_upsert_api_gateway_route_mapping_v1(
  args: UpsertApiGatewayRouteMappingArgs,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('ui_upsert_api_gateway_route_mapping_v1', {
    p_args: args,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_upsert_api_gateway_route_mapping_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'ui_upsert_api_gateway_route_mapping_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const routeId =
      asNonEmptyString(rec.api_route_id) ??
      asNonEmptyString(args.api_route_id);
    const mappingConfigId =
      asNonEmptyString(rec.mapping_config_id) ??
      asNonEmptyString(args.mapping_config_id);
    if (!routeId) throw new Error('ui_upsert_api_gateway_route_mapping_v1 did not return api_route_id');
    if (!mappingConfigId) throw new Error('ui_upsert_api_gateway_route_mapping_v1 did not return mapping_config_id');
    await requireLiveResourceReadback('api_routes', routeId, 'ui_upsert_api_gateway_route_mapping_v1');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'ui_upsert_api_gateway_route_mapping_v1');
    return rec;
  }

  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'api_route');
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
  const mappingId = asNonEmptyString(mappingConfigId);
  const live = await liveRpc<Record<string, unknown>>('ui_test_mapping_config_v1', {
    p_mapping_config_id: mappingId,
    p_payload: payload ?? {},
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'ui_test_mapping_config_v1 returned no result');
    const outcomeError = backendOutcomeError(rec, 'ui_test_mapping_config_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'mapping_operation_report_id',
      'operation_report_id',
      'report_id',
      'report',
    ], 'ui_test_mapping_config_v1 did not return backend mapping operation report evidence');
    const reportId =
      asNonEmptyString(rec.mapping_operation_report_id) ??
      asNonEmptyString(rec.operation_report_id) ??
      asNonEmptyString(rec.report_id);
    if (reportId) {
      await requireLiveResourceReadback('mapping_operation_reports', reportId, 'ui_test_mapping_config_v1');
    }
    return rec;
  }
  await sleep(60);
  return {
    ok: true,
    status: 'succeeded',
    mapping_config_id: mappingId,
    transformed_payload: payload ?? {},
    report_id: `mor_${Date.now()}`,
  };
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
function resolveProviderAuthConfigId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.provider_auth_config_id)
    ?? asNonEmptyString(rec.auth_config_id)
    ?? asNonEmptyString(rec.config_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.provider_auth_config_id)
    ?? asNonEmptyString(args.auth_config_id)
    ?? asNonEmptyString(args.config_id);
}

function requireProviderAuthConfigDirectoryReadback(
  row: Record<string, unknown>,
  args: Record<string, unknown>,
  rpcName: string,
  expectedConfigId: string,
): void {
  if (asNonEmptyString(row.id) !== expectedConfigId) {
    throw new Error(`${rpcName} backend readback did not reflect provider_auth_config_id`);
  }
  if (
    Object.prototype.hasOwnProperty.call(row, 'credentials') ||
    Object.prototype.hasOwnProperty.call(row, 'credentials_vault_id')
  ) {
    throw new Error(`${rpcName} backend readback exposed credential secret fields`);
  }
  const expectedProvider = asNonEmptyString(args.provider_id);
  if (expectedProvider && asNonEmptyString(row.provider_id) !== expectedProvider) {
    throw new Error(`${rpcName} backend readback did not reflect provider_id`);
  }
  const expectedAuthType = asNonEmptyString(args.auth_type);
  if (expectedAuthType && asNonEmptyString(row.auth_type) !== expectedAuthType) {
    throw new Error(`${rpcName} backend readback did not reflect auth_type`);
  }
  if (rpcName === 'ui_revoke_provider_auth_config_v1') {
    const status = asNonEmptyString(row.status);
    if (status !== 'revoked') {
      throw new Error(`${rpcName} backend readback did not reflect revoked status`);
    }
  }
}

async function providerAuthConfigMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult(rpcName, args, [
    'provider_auth_config_id',
    'auth_config_id',
    'config_id',
    'id',
  ]);
  if (live) {
    const configId = resolveProviderAuthConfigId(live, args);
    if (!configId) throw new Error(`${rpcName} did not return provider_auth_config_id`);
    const readback = await requireLiveResourceReadback('integration_credential_directory', configId, rpcName);
    requireProviderAuthConfigDirectoryReadback(readback, args, rpcName, configId);
    return { ...live, provider_auth_config_id: configId };
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'provider_auth_config');
}

export const ui_upsert_provider_auth_config_v1 = (args: UpsertProviderAuthConfigArgs) =>
  providerAuthConfigMutation('ui_upsert_provider_auth_config_v1', args);
export async function ui_bind_provider_account_credential_v1(
  args: BindProviderAccountCredentialArgs,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_bind_provider_account_credential_v1', args, [
    'provider_auth_config_id',
    'auth_config_id',
    'settings_version_id',
    'settings_id',
  ]);
  if (live) {
    const configId = resolveProviderAuthConfigId(live, args);
    if (!configId) throw new Error('ui_bind_provider_account_credential_v1 did not return provider_auth_config_id');
    // Provider-account bindings can attach tenant settings to a global route
    // provider. The direct secret table may stay outside tenant RLS; the
    // redacted credential directory is the browser-safe readback contract.
    const readback = await requireLiveResourceReadback(
      'integration_credential_directory',
      configId,
      'ui_bind_provider_account_credential_v1',
    );
    requireProviderAuthConfigDirectoryReadback(readback, args, 'ui_bind_provider_account_credential_v1', configId);
    return { ...live, provider_auth_config_id: configId };
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'provider_account_credential');
}
export async function ui_unbind_provider_account_credential_v1(
  args: UnbindProviderAccountCredentialArgs,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_unbind_provider_account_credential_v1', args, [
    'settings_version_id',
    'settings_id',
    'provider_account_category',
    'auth_config_id',
  ]);
  if (live) {
    const providerAccountCategory = asNonEmptyString(live.provider_account_category)
      ?? asNonEmptyString(args.provider_account_category)
      ?? 'logestechs_v2_account';
    const scopeType = asNonEmptyString(live.scope_type)
      ?? asNonEmptyString(args.scope_type)
      ?? 'tenant';
    const orgId =
      asNonEmptyString(live.organization_id)
      ?? asNonEmptyString(args.organization_id)
      ?? asNonEmptyString(args.tenant_id);
    const scopeId =
      asNonEmptyString(live.scope_id)
      ?? asNonEmptyString(args.scope_id)
      ?? (scopeType === 'tenant' ? orgId : asNonEmptyString(args.source_id));
    const scopeContext =
      scopeType === 'source'
        ? { webhook_source_id: scopeId, organization_id: orgId }
        : { tenant: { id: scopeId ?? orgId } };
    const readback = await resolveSettings(providerAccountCategory, scopeContext);
    const readbackValue =
      readback.value && typeof readback.value === 'object' && !Array.isArray(readback.value)
        ? readback.value as Record<string, unknown>
        : {};
    if (asNonEmptyString(readbackValue.auth_config_id)) {
      throw new Error('ui_unbind_provider_account_credential_v1 backend readback still exposes auth_config_id');
    }
    if (readbackValue.enabled !== false) {
      throw new Error('ui_unbind_provider_account_credential_v1 backend readback did not disable provider account');
    }
    return { ...live, bound: false, auth_config_id: null };
  }
  await sleep(60);
  return { ...buildMutationFallbackEnvelope(args, 'provider_account_credential_unbound'), bound: false };
}
export const ui_revoke_provider_auth_config_v1 = (args: { config_id: string; reason?: string | null }) =>
  providerAuthConfigMutation('ui_revoke_provider_auth_config_v1', args);
export const integration_plugin_rotate_credentials_v1 = (args: Record<string, unknown>) =>
  providerAuthConfigMutation('integration_plugin_rotate_credentials_v1', args);

export async function ui_execute_provider_circuit_reset_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_execute_provider_circuit_reset_v1', args, [
    'provider_id',
    'operation_name',
    'circuit_breaker_id',
    'decision_log_id',
  ]);
  if (live) {
    const providerId = asNonEmptyString(live.provider_id) ?? asNonEmptyString(args.provider_id);
    const operationName = asNonEmptyString(live.operation_name) ?? asNonEmptyString(args.operation_name);
    if (!providerId || !operationName) {
      throw new Error('ui_execute_provider_circuit_reset_v1 did not return provider circuit identity');
    }

    const breakerRows = await readLiveResourceListReadback(
      'circuit_breaker_dashboard',
      { provider_id: providerId, operation_name: operationName },
      'ui_execute_provider_circuit_reset_v1',
    );
    const breaker = breakerRows.find(
      (row) => asNonEmptyString(row.provider_id) === providerId && asNonEmptyString(row.operation_name) === operationName,
    );
    if (!breaker || asNonEmptyString(breaker.state) !== 'closed') {
      throw new Error('ui_execute_provider_circuit_reset_v1 backend readback did not close the circuit breaker');
    }

    const healthRows = await readLiveResourceListReadback(
      'provider_health_latest',
      { provider_id: providerId },
      'ui_execute_provider_circuit_reset_v1',
    );
    const health = healthRows.find((row) => asNonEmptyString(row.provider_id) === providerId);
    if (!health || asNonEmptyString(health.status) !== 'healthy') {
      throw new Error('ui_execute_provider_circuit_reset_v1 backend readback did not mark provider healthy');
    }

    return live;
  }

  await sleep(60);
  return {
    ...buildMutationFallbackEnvelope(args, 'provider_circuit_reset'),
    provider_id: args.provider_id,
    operation_name: args.operation_name,
    state: 'closed',
    health_status: 'healthy',
  };
}

export async function ui_execute_provider_circuit_probe_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const live = await livePArgsMutationResult('ui_execute_provider_circuit_probe_v1', args, [
    'provider_id',
    'operation_name',
    'circuit_breaker_id',
    'decision_log_id',
  ]);
  if (live) {
    const providerId = asNonEmptyString(live.provider_id) ?? asNonEmptyString(args.provider_id);
    const operationName = asNonEmptyString(live.operation_name) ?? asNonEmptyString(args.operation_name);
    if (!providerId || !operationName) {
      throw new Error('ui_execute_provider_circuit_probe_v1 did not return provider circuit identity');
    }

    const breakerRows = await readLiveResourceListReadback(
      'circuit_breaker_dashboard',
      { provider_id: providerId, operation_name: operationName },
      'ui_execute_provider_circuit_probe_v1',
    );
    const breaker = breakerRows.find(
      (row) => asNonEmptyString(row.provider_id) === providerId && asNonEmptyString(row.operation_name) === operationName,
    );
    if (!breaker || asNonEmptyString(breaker.state) !== 'closed') {
      throw new Error('ui_execute_provider_circuit_probe_v1 backend readback did not close the circuit breaker');
    }

    const healthRows = await readLiveResourceListReadback(
      'provider_health_latest',
      { provider_id: providerId },
      'ui_execute_provider_circuit_probe_v1',
    );
    const health = healthRows.find((row) => asNonEmptyString(row.provider_id) === providerId);
    if (!health || asNonEmptyString(health.status) !== 'healthy') {
      throw new Error('ui_execute_provider_circuit_probe_v1 backend readback did not mark provider healthy');
    }

    return live;
  }

  await sleep(60);
  return {
    ...buildMutationFallbackEnvelope(args, 'provider_circuit_probe'),
    provider_id: args.provider_id,
    operation_name: args.operation_name,
    state: 'closed',
    health_status: 'healthy',
  };
}

// INTEGRATIONS — integration_plugins catalog (Install/Rollback)
export interface IntegrationPluginGenerateDraftArgs extends Record<string, unknown> {
  plugin_name?: string;
  plugin_kind?: string;
  source_type?: string;
  inbound_config?: Record<string, unknown>;
  vendor?: string;
}

function resolveIntegrationPluginId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
  versionRow?: Record<string, unknown> | null,
): string | null {
  return asNonEmptyString(rec.integration_plugin_id)
    ?? asNonEmptyString(rec.plugin_id)
    ?? asNonEmptyString(args.integration_plugin_id)
    ?? asNonEmptyString(args.plugin_id)
    ?? asNonEmptyString(versionRow?.plugin_id);
}

function resolveIntegrationPluginVersionId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.integration_plugin_version_id)
    ?? asNonEmptyString(rec.plugin_version_id)
    ?? asNonEmptyString(rec.version_id)
    ?? asNonEmptyString(rec.to_plugin_version_id)
    ?? asNonEmptyString(args.integration_plugin_version_id)
    ?? asNonEmptyString(args.plugin_version_id)
    ?? asNonEmptyString(args.target_plugin_version_id);
}

async function requireLiveIntegrationPluginReadback(
  rpcName: string,
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
  options: {
    approvalAction?: string | null;
    requireBinding?: boolean;
    requireBindingChangeCount?: boolean;
    allowVersionless?: boolean;
  } = {},
): Promise<void> {
  const versionId = resolveIntegrationPluginVersionId(rec, args);
  let versionRow: Record<string, unknown> | null = null;
  if (versionId) {
    versionRow = await requireLiveResourceReadback('integration_plugin_versions', versionId, rpcName);
  } else if (!options.allowVersionless) {
    throw new Error(`${rpcName} did not return integration_plugin_version_id`);
  }

  const pluginId = resolveIntegrationPluginId(rec, args, versionRow);
  if (!pluginId) throw new Error(`${rpcName} did not return integration_plugin_id`);
  await requireLiveResourceReadback('integration_plugins', pluginId, rpcName);
  await requireLiveResourceReadback('integration_plugin_directory', pluginId, rpcName);

  const action = asNonEmptyString(options.approvalAction);
  if (versionId && action && !rec.already_processed) {
    await requireLiveResourceListReadback(
      'integration_plugin_approval_events',
      { plugin_version_id: versionId, action },
      rpcName,
    );
  }

  if (versionId && options.requireBinding) {
    const bindingRows = await requireLiveResourceListReadback(
      'integration_plugin_bindings',
      { plugin_version_id: versionId },
      rpcName,
    );
    const expectedBindingEnabled = Object.prototype.hasOwnProperty.call(args, 'enabled')
      ? args.enabled
      : args.expected_binding_enabled;
    if (
      Object.prototype.hasOwnProperty.call(args, 'enabled')
      || Object.prototype.hasOwnProperty.call(args, 'expected_binding_enabled')
    ) {
      const expectedEnabled = booleanReadback(expectedBindingEnabled);
      if (expectedEnabled === null) {
        throw new Error(`${rpcName} requires boolean binding enabled readback expectation`);
      }
      const expectedScopeType = asNonEmptyString(args.scope_type)?.toLowerCase() ?? null;
      const expectedScopeId = asNonEmptyString(args.scope_id);
      const scopedRows = bindingRows.filter((row) => {
        const rowScopeType = asNonEmptyString(row.scope_type)?.toLowerCase() ?? null;
        const rowScopeId = asNonEmptyString(row.scope_id);
        return (!expectedScopeType || rowScopeType === expectedScopeType)
          && (!expectedScopeId || rowScopeId === expectedScopeId);
      });
      if (scopedRows.length === 0) {
        throw new Error(`${rpcName} backend readback missing scoped integration_plugin_bindings`);
      }
      const mismatched = scopedRows.find((row) => booleanReadback(row.enabled) !== expectedEnabled);
      if (mismatched) {
        throw new Error(`${rpcName} backend readback did not reflect integration_plugin_bindings.enabled=${expectedEnabled}`);
      }
      const changedCount = Number(rec.changed_count ?? 0);
      if (
        expectedEnabled === false
        && options.requireBindingChangeCount !== false
        && scopedRows.length > 0
        && changedCount <= 0
      ) {
        throw new Error(`${rpcName} backend readback reported no binding changes`);
      }
    }
  }
}

async function integrationPluginMutation(
  rpcName: string,
  args: Record<string, unknown>,
  options?: {
    approvalAction?: string | null;
    requireBinding?: boolean;
    requireBindingChangeCount?: boolean;
    allowVersionless?: boolean;
    fallbackResourceKey?: string;
  },
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, { p_args: args });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, `${rpcName} returned no backend outcome`);
    const lifecycleAction = asNonEmptyString(options?.approvalAction)?.toLowerCase() ?? null;
    const returnedStatus = asNonEmptyString(rec.status)?.toLowerCase() ?? null;
    const expectedRejectedDecision =
      rpcName === 'plugin_approve_v1'
      && lifecycleAction === 'rejected'
      && returnedStatus === 'rejected'
      && rec.ok !== false;
    const outcomeError = expectedRejectedDecision
      ? null
      : backendOutcomeError(rec, `${rpcName} was rejected by the backend`);
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(rec, [
      'integration_plugin_id',
      'plugin_id',
      'integration_plugin_version_id',
      'plugin_version_id',
      'version_id',
      'to_plugin_version_id',
      'status',
      'changed_count',
      'already_processed',
      'correlation_id',
      'settings_resolution_id',
    ], `${rpcName} did not return backend plugin evidence`);
    await requireLiveIntegrationPluginReadback(rpcName, rec, args, options);
    return rec;
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(args, options?.fallbackResourceKey ?? 'integration_plugin');
}

export const integration_plugin_generate_draft_v1 = (args: IntegrationPluginGenerateDraftArgs) =>
  integrationPluginMutation('integration_plugin_generate_draft_v1', args);
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
  const live = await liveRpc<Record<string, unknown>>('integration_plugin_export_handoff_v1', {
    p_plugin_version_id: args.plugin_version_id,
    p_base_url: args.base_url ?? null,
  });
  if (live) {
    const rec = requireLiveRpcRecord(live.data, 'integration_plugin_export_handoff_v1 returned no backend outcome');
    const outcomeError = backendOutcomeError(rec, 'integration_plugin_export_handoff_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(
      rec,
      ['plugin_id', 'plugin_version_id', 'kind', 'endpoint', 'token', 'sample_curl'],
      'integration_plugin_export_handoff_v1 did not return backend handoff evidence',
    );
    const issuedToken = asNonEmptyString(rec.token);
    if (!issuedToken || issuedToken.includes('{{') || issuedToken.includes('}}')) {
      throw new Error('integration_plugin_export_handoff_v1 did not return an issued source token');
    }
    const endpoint = asNonEmptyString(rec.endpoint);
    const sampleCurl = asNonEmptyString(rec.sample_curl);
    if (!endpoint || endpoint.includes('{{') || endpoint.includes('}}') || !sampleCurl || sampleCurl.includes('{{') || sampleCurl.includes('}}')) {
      throw new Error('integration_plugin_export_handoff_v1 did not return a concrete endpoint handoff');
    }
    const pluginVersionId = asNonEmptyString(rec.plugin_version_id) ?? args.plugin_version_id;
    const versionRow = await requireLiveResourceReadback(
      'integration_plugin_versions',
      pluginVersionId,
      'integration_plugin_export_handoff_v1',
    );
    const versionPluginId = asNonEmptyString(versionRow.plugin_id);
    const pluginId = asNonEmptyString(rec.plugin_id) ?? versionPluginId;
    if (!pluginId) throw new Error('integration_plugin_export_handoff_v1 did not return integration_plugin_id');
    if (versionPluginId && pluginId !== versionPluginId) {
      throw new Error('integration_plugin_export_handoff_v1 plugin readback did not match version lineage');
    }
    await requireLiveResourceReadback('integration_plugins', pluginId, 'integration_plugin_export_handoff_v1');
    await requireLiveResourceReadback('integration_plugin_directory', pluginId, 'integration_plugin_export_handoff_v1');
    return rec;
  }
  await sleep(40);
  return {
    ok: true,
    plugin_id: nextResourceId('plg'),
    plugin_version_id: args.plugin_version_id,
    kind: 'webhook',
    endpoint: `${args.base_url ?? '{{BASE_URL}}'}/functions/v1/webhook-receiver`,
    token: '{{TOKEN}}',
    headers: { authorization: 'Bearer {{TOKEN}}' },
    instructions: [
      'Point webhook destination to endpoint.',
      'Send Authorization: Bearer {token}.',
      'Keep payload shape per plugin mapping configuration.',
    ],
    sample_curl: `curl -X POST "${args.base_url ?? '{{BASE_URL}}'}/functions/v1/webhook-receiver" -H "authorization: Bearer {{TOKEN}}" -H "content-type: application/json" -d '{}'`,
  };
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

const DELIVERY_SLOT_CATALOG: DeliverySlotWindow[] = [
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
  const input = ((args ?? {}) as Record<string, unknown>);
  const shipmentId = input.shipment_id as string | undefined;
  const clientId = (input.client_id as string | undefined) ?? await getLiveShipmentClientId(shipmentId);
  const live = await liveRpc('list_delivery_slots_v1', {
    p_input: {
      ...input,
      client_id: clientId,
      start_date: input.start_date ?? input.slot_date,
      days: input.days ?? 1,
      include_unavailable: input.include_unavailable ?? false,
    },
  });
  if (live) {
    const rows = Array.isArray(live.data) ? live.data : [];
    return rows.map((row) => normalizeDeliverySlotWindow(row as Record<string, unknown>));
  }

  await sleep(40);
  const slotDate = (args as { slot_date?: string } | undefined)?.slot_date;
  if (slotDate) {
    const scoped = DELIVERY_SLOT_CATALOG.filter((w) => w.slot_date === slotDate);
    if (scoped.length) return scoped;
    // Synthesize 3 windows for any date the operator picks so the picker
    // always has something to render — matches the RPC's "always returns
    // policy-resolved windows" contract.
    return [
      { window_id: `win_${slotDate}_am`, slot_date: slotDate, window_start_local: '10:00', window_end_local: '12:00', remaining: 10 },
      { window_id: `win_${slotDate}_mid`, slot_date: slotDate, window_start_local: '13:00', window_end_local: '15:00', remaining: 6 },
      { window_id: `win_${slotDate}_pm`, slot_date: slotDate, window_start_local: '16:00', window_end_local: '18:00', remaining: 3 },
    ];
  }
  return DELIVERY_SLOT_CATALOG;
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
  const scopeRec = (scope && typeof scope === 'object' ? scope : {}) as Record<string, unknown>;
  const organizationId =
    scopeRec.organization_id ??
    scopeRec.tenant_id ??
    nestedScopeId(scopeRec, 'tenant') ??
    (typeof scopeRec.tenant === 'string' ? scopeRec.tenant : null) ??
    state.user.organization_id ??
    null;
  const live = await liveRpc<Record<string, unknown>>('compute_cod_payment_collection_summary_v1', {
    p_organization_id: organizationId,
    p_branch_id: scopeRec.branch_id ?? nestedScopeId(scopeRec, 'branch') ?? null,
    p_subject_type: scopeRec.subject_type ?? null,
    p_subject_id: scopeRec.subject_id ?? null,
    p_window_start_at: scopeRec.window_start_at ?? scopeRec.from ?? null,
    p_window_end_at: scopeRec.window_end_at ?? scopeRec.to ?? null,
  });
  if (live) {
    if (!organizationId) throw new Error('compute_cod_payment_collection_summary_v1 requires organization_id');
    const rec = (live.data ?? {}) as Record<string, unknown>;
    const expected = Number(rec.expected_amount ?? rec.expected ?? 0);
    const collected = Number(rec.collected_amount ?? rec.collected ?? 0);
    const remitted = Number(rec.remitted_amount ?? rec.remitted ?? 0);
    return {
      scope,
      expected,
      collected,
      remitted,
      variance: Number(rec.variance_amount ?? rec.variance ?? collected - expected),
    };
  }

  await sleep(60);
  return { scope, expected: 7150, collected: 6970, remitted: 0, variance: -180 };
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

const localLabelDesignDrafts: LabelDesignDraft[] = [];
const localLabelDesignerAssets: LabelDesignerAsset[] = [];

function assertLabelDesignScope(scopeType: string, scopeId: string): asserts scopeType is LabelDesignScopeType {
  if (!['tenant', 'client', 'sender'].includes(scopeType)) {
    throw new Error('label designer scope must be tenant, client, or sender');
  }
  if (!asNonEmptyString(scopeId)) {
    throw new Error('label designer scope_id is required');
  }
}

function localValidateLabelDesign(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ code: 'label_design_invalid', message: 'label_design must be an object' }];
  }
  const rec = value as Record<string, unknown>;
  const templates = rec.templates;
  if (!templates || typeof templates !== 'object' || Array.isArray(templates)) {
    return [{ code: 'templates_missing', message: 'label_design.templates missing' }];
  }
  const errors: Array<Record<string, unknown>> = [];
  for (const [templateKey, template] of Object.entries(templates as Record<string, unknown>)) {
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      errors.push({ code: 'template_invalid', message: 'template must be an object', template_key: templateKey });
      continue;
    }
    const t = template as Record<string, unknown>;
    if (!t.page || typeof t.page !== 'object' || Array.isArray(t.page)) {
      errors.push({ code: 'page_missing', message: 'renderer_config.page missing', template_key: templateKey });
    }
    if (!Array.isArray(t.blocks)) {
      errors.push({ code: 'blocks_missing', message: 'renderer_config.blocks missing', template_key: templateKey });
    }
  }
  return errors;
}

export async function label_designer_list_drafts(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerDraftListResult> {
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelDesignerDraftListResult>('label_designer_list_drafts', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'label_designer_list_drafts returned no backend draft list',
    );
    if (!Array.isArray(rec.drafts)) {
      throw new Error('label_designer_list_drafts did not return backend draft list evidence');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      drafts: rec.drafts as LabelDesignDraft[],
    };
  }

  await sleep(30);
  return {
    ok: true,
    drafts: localLabelDesignDrafts
      .filter((draft) => draft.scope_type === scopeType && draft.scope_id === scopeId)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
  };
}

export async function label_designer_get_field_catalog(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerFieldCatalogResult> {
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelDesignerFieldCatalogResult>('label_designer_get_field_catalog', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'label_designer_get_field_catalog returned no backend field catalog',
    );
    const value = rec.value && typeof rec.value === 'object' && !Array.isArray(rec.value)
      ? rec.value as Record<string, unknown>
      : {};
    const fields = Array.isArray(value.fields) ? value.fields as LabelDesignerFieldCatalogField[] : [];
    if (rec.ok !== false && fields.length === 0) {
      throw new Error('label_designer_get_field_catalog did not return backend field catalog evidence');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      value: {
        ...value,
        fields,
      },
    };
  }

  await sleep(30);
  return { ok: true, value: { version: 1, fields: [] } };
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
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelRendererReadinessResult>('ui_label_renderer_readiness_v1', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'ui_label_renderer_readiness_v1 returned no backend readiness readback',
    );
    return { ...rec, ok: rec.ok !== false };
  }

  await sleep(30);
  return {
    ok: true,
    scope: { scope_type: scopeType, scope_id: scopeId },
    renderer_provider: {
      status: 'ready',
      provider_name: 'seed_renderer',
      invoke_url: 'http://127.0.0.1:54321/functions/v1/label-renderer',
      invoke_secret: 'redacted',
      timeout_ms: '15000',
    },
    render_policy: {
      status: 'ready',
      missing: [],
      value: { header_brand_mode: 'logo', arabic: { enabled: true }, barcode: { gate_mode: 'warn_only' } },
    },
    print_profile: {
      status: 'ready',
      missing: [],
      value: {
        profile_key: 'default_203dpi',
        dpi: 203,
        media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
      },
    },
    printer_certification: {
      status: 'missing',
      missing: ['printer_certification'],
      evidence: {},
    },
  };
}

export async function ui_record_label_printer_certification_v1(
  args: LabelPrinterCertificationArgs,
): Promise<LabelPrinterCertificationResult> {
  assertLabelDesignScope(args.scope_type, args.scope_id);
  const evidenceReference = asNonEmptyString(args.evidence_reference);
  const printerModel = asNonEmptyString(args.printer_model);
  if (!evidenceReference) throw new Error('evidence_reference is required');
  if (!printerModel) throw new Error('printer_model is required');
  const certification = {
    evidence_reference: evidenceReference,
    printer_model: printerModel,
    printer_serial: asNonEmptyString(args.printer_serial) ?? null,
    test_artifact_ref: asNonEmptyString(args.test_artifact_ref) ?? null,
    result: args.result ?? 'passed',
  };
  const live = await liveRpc<LabelPrinterCertificationResult>('ui_record_label_printer_certification_v1', {
    p_scope_type: args.scope_type,
    p_scope_id: args.scope_id,
    p_certification: certification,
    p_change_reason: asNonEmptyString(args.change_reason) ?? 'Recorded label printer certification from Console V2',
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'ui_record_label_printer_certification_v1 returned no backend certification readback',
    );
    if (rec.ok !== false && objectRecord(rec.readiness).printer_certification === undefined) {
      throw new Error('ui_record_label_printer_certification_v1 returned no backend readiness readback');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      readiness: objectRecord(rec.readiness) as LabelRendererReadinessResult,
      certification: objectRecord(rec.certification),
    };
  }

  await sleep(30);
  const seedCertificationId = `cert_${Date.now()}`;
  const readiness: LabelRendererReadinessResult = {
    ok: true,
    scope: { scope_type: args.scope_type, scope_id: args.scope_id },
    renderer_provider: {
      status: 'ready',
      provider_name: 'seed_renderer',
      invoke_url: 'http://127.0.0.1:54321/functions/v1/label-renderer',
      invoke_secret: 'redacted',
      timeout_ms: '15000',
    },
    render_policy: {
      status: 'ready',
      missing: [],
      value: { header_brand_mode: 'logo', arabic: { enabled: true }, barcode: { gate_mode: 'warn_only' } },
    },
    print_profile: {
      status: 'ready',
      missing: [],
      value: {
        profile_key: 'default_203dpi',
        dpi: 203,
        media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
        printer_certification: {
          certification_id: seedCertificationId,
          evidence_reference: evidenceReference,
          printer_model: printerModel,
          printer_serial: asNonEmptyString(args.printer_serial) ?? undefined,
          test_artifact_ref: asNonEmptyString(args.test_artifact_ref) ?? undefined,
          printer_dpi: 203,
          media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
          result: args.result ?? 'passed',
          source: 'console_v2_platform_labels',
        },
      },
    },
    printer_certification: {
      status: 'ready',
      missing: [],
      evidence: {
        certification_id: seedCertificationId,
        evidence_reference: evidenceReference,
        printer_model: printerModel,
        printer_serial: asNonEmptyString(args.printer_serial) ?? undefined,
        test_artifact_ref: asNonEmptyString(args.test_artifact_ref) ?? undefined,
        printer_dpi: 203,
        media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
        result: args.result ?? 'passed',
        source: 'console_v2_platform_labels',
      },
    },
  };
  return {
    ok: true,
    scope_type: args.scope_type,
    scope_id: args.scope_id,
    settings_version_id: nextResourceId('settings_version'),
    settings_version_number: 1,
    certification: objectRecord(readiness.printer_certification?.evidence) as Record<string, unknown>,
    readiness,
  };
}

export async function label_designer_get_sample_payload(args: {
  shipment_id: string;
  shipment_box_id?: string | null;
}): Promise<LabelDesignerSamplePayloadResult> {
  const shipmentId = asNonEmptyString(args.shipment_id);
  if (!shipmentId) throw new Error('shipment_id is required');
  const live = await liveRpc<LabelDesignerSamplePayloadResult>('label_designer_get_sample_payload', {
    p_shipment_id: shipmentId,
    p_shipment_box_id: asNonEmptyString(args.shipment_box_id) ?? null,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'label_designer_get_sample_payload returned no backend payload',
    );
    if (rec.ok !== false && (!rec.payload || typeof rec.payload !== 'object')) {
      throw new Error('label_designer_get_sample_payload did not return backend payload evidence');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      payload: rec.payload && typeof rec.payload === 'object'
        ? rec.payload as Record<string, unknown>
        : undefined,
    };
  }

  await sleep(30);
  return {
    ok: true,
    payload: {
      shipment_id: shipmentId,
      shipment_box_id: asNonEmptyString(args.shipment_box_id) ?? null,
      tracking_number: 'SEED-LABEL-PREVIEW',
      recipient: { name: 'Seed Recipient' },
    },
  };
}

export async function label_designer_create_draft(args: {
  scope_type: LabelDesignScopeType;
  scope_id: string;
  label_type?: string;
  draft_name?: string | null;
  draft_value: Record<string, unknown>;
}): Promise<LabelDesignerDraftMutationResult> {
  assertLabelDesignScope(args.scope_type, args.scope_id);
  const live = await liveRpc<LabelDesignerDraftMutationResult>('label_designer_create_draft', {
    p_scope_type: args.scope_type,
    p_scope_id: args.scope_id,
    p_label_type: args.label_type ?? 'shipping',
    p_draft_name: args.draft_name ?? null,
    p_draft_value: args.draft_value,
  });
  if (live) {
    return requireLiveLabelDraftMutationReadback(
      requireLiveLabelDraftResult(live.data, 'label_designer_create_draft'),
      'label_designer_create_draft',
    );
  }

  await sleep(40);
  const now = new Date().toISOString();
  const draft: LabelDesignDraft = {
    id: nextResourceId('label_design_draft'),
    organization_id: args.scope_type === 'tenant' ? args.scope_id : (asNonEmptyString(state.user.organization_id) ?? null),
    scope_type: args.scope_type,
    scope_id: args.scope_id,
    label_type: args.label_type ?? 'shipping',
    draft_name: asNonEmptyString(args.draft_name) ?? null,
    draft_value: args.draft_value,
    status: 'draft',
    created_by: asNonEmptyString(state.user.id) ?? null,
    created_at: now,
    updated_at: now,
    published_settings_version_id: null,
    published_at: null,
  };
  localLabelDesignDrafts.unshift(draft);
  return { ok: true, draft };
}

export async function label_designer_update_draft(args: {
  draft_id: string;
  label_type?: string | null;
  draft_name?: string | null;
  draft_value?: Record<string, unknown> | null;
}): Promise<LabelDesignerDraftMutationResult> {
  const live = await liveRpc<LabelDesignerDraftMutationResult>('label_designer_update_draft', {
    p_draft_id: args.draft_id,
    p_label_type: args.label_type ?? null,
    p_draft_name: args.draft_name ?? null,
    p_draft_value: args.draft_value ?? null,
  });
  if (live) {
    return requireLiveLabelDraftMutationReadback(
      requireLiveLabelDraftResult(live.data, 'label_designer_update_draft'),
      'label_designer_update_draft',
    );
  }

  await sleep(40);
  const draft = localLabelDesignDrafts.find((row) => row.id === args.draft_id);
  if (!draft) return { ok: false, error: { code: 'draft_not_found', message: 'Draft not found' } };
  if (draft.status !== 'draft') return { ok: false, error: { code: 'draft_not_editable', message: 'Only draft rows are editable' } };
  draft.label_type = args.label_type ?? draft.label_type;
  draft.draft_name = args.draft_name ?? draft.draft_name;
  draft.draft_value = args.draft_value ?? draft.draft_value;
  draft.updated_at = new Date().toISOString();
  return { ok: true, draft };
}

export async function label_designer_archive_draft(args: {
  draft_id: string;
  archive_reason?: string | null;
}): Promise<LabelDesignerDraftMutationResult> {
  const live = await liveRpc<LabelDesignerDraftMutationResult>('label_designer_archive_draft', {
    p_draft_id: args.draft_id,
    p_archive_reason: args.archive_reason ?? null,
  });
  if (live) {
    const result = await requireLiveLabelDraftMutationReadback(
      requireLiveLabelDraftResult(live.data, 'label_designer_archive_draft'),
      'label_designer_archive_draft',
    );
    if (result.ok !== false && result.draft?.status !== 'archived') {
      throw new Error('label_designer_archive_draft backend draft list readback is not archived');
    }
    return result;
  }

  await sleep(40);
  const draft = localLabelDesignDrafts.find((row) => row.id === args.draft_id);
  if (!draft) return { ok: false, error: { code: 'draft_not_found', message: 'Draft not found' } };
  if (draft.status !== 'draft') {
    return { ok: false, error: { code: 'draft_not_archivable', message: 'Only draft rows can be archived' } };
  }
  const now = new Date().toISOString();
  draft.status = 'archived';
  draft.archived_at = now;
  draft.archived_by = asNonEmptyString(state.user.id) ?? null;
  draft.archive_reason = asNonEmptyString(args.archive_reason) ?? 'Archived from Console V2 Labels';
  draft.updated_at = now;
  return { ok: true, draft };
}

export async function label_designer_validate_label_design_draft(
  draftId: string,
): Promise<LabelDesignerDraftValidationResult> {
  const live = await liveRpc<LabelDesignerDraftValidationResult>('label_designer_validate_label_design_draft', {
    p_draft_id: draftId,
  });
  if (live) return requireLiveLabelValidationResult(live.data);

  await sleep(30);
  const draft = localLabelDesignDrafts.find((row) => row.id === draftId);
  if (!draft) {
    return {
      ok: false,
      errors: [],
      error: { code: 'draft_not_found', message: 'Draft not found' },
    };
  }
  const errors = localValidateLabelDesign(draft.draft_value);
  return { ok: errors.length === 0, errors };
}

export async function label_designer_publish_label_design_draft(
  draftId: string,
  changeReason?: string | null,
  readbackScope?: { scopeType?: string | null; scopeId?: string | null },
): Promise<LabelDesignerDraftPublishResult> {
  const live = await liveRpc<LabelDesignerDraftPublishResult>('label_designer_publish_label_design_draft', {
    p_draft_id: draftId,
    p_change_reason: changeReason ?? null,
  });
  if (live) {
    const result = requireLiveLabelPublishResult(live.data);
    if (result.ok !== false) {
      await requirePublishedLabelDraftReadback(draftId, result, readbackScope);
    }
    return result;
  }

  await sleep(50);
  const draft = localLabelDesignDrafts.find((row) => row.id === draftId);
  if (!draft) return { ok: false, error: { code: 'draft_not_found', message: 'Draft not found' } };
  const errors = localValidateLabelDesign(draft.draft_value);
  if (errors.length > 0) {
    return {
      ok: false,
      error: { code: 'validation_failed', message: 'Draft validation failed' },
      validation_errors: errors,
    };
  }
  const now = new Date().toISOString();
  draft.status = 'published';
  draft.published_at = now;
  draft.updated_at = now;
  draft.published_settings_version_id = nextResourceId('settings_version');
  return {
    ok: true,
    settings_version_id: draft.published_settings_version_id,
    scope_type: draft.scope_type,
    scope_id: draft.scope_id,
    schema_version: 1,
    version: localLabelDesignDrafts.filter((row) => row.scope_type === draft.scope_type && row.scope_id === draft.scope_id && row.status === 'published').length,
  };
}

async function requirePublishedLabelDraftReadback(
  draftId: string,
  result: LabelDesignerDraftPublishResult,
  readbackScope?: { scopeType?: string | null; scopeId?: string | null },
): Promise<void> {
  const scopeType = asNonEmptyString(readbackScope?.scopeType) ?? asNonEmptyString(result.scope_type);
  const scopeId = asNonEmptyString(readbackScope?.scopeId) ?? asNonEmptyString(result.scope_id);
  if (!scopeType || !scopeId) {
    throw new Error('label_designer_publish_label_design_draft did not return scope for published draft readback');
  }

  const live = await liveRpc<LabelDesignerDraftListResult>('label_designer_list_drafts', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (!live) return;

  const list = requireLiveRpcRecord(
    live.data,
    'label_designer_publish_label_design_draft published draft readback returned no backend draft list',
  );
  const drafts = Array.isArray(list.drafts) ? list.drafts as LabelDesignDraft[] : [];
  const draft = drafts.find((row) => row.id === draftId);
  if (!draft) {
    throw new Error('label_designer_publish_label_design_draft published draft readback missing draft');
  }
  if (draft.status !== 'published') {
    throw new Error('label_designer_publish_label_design_draft published draft readback is not published');
  }
  const expectedVersion =
    asNonEmptyString(result.settings_version_id) ??
    asNonEmptyString(result.settings_resolution_id) ??
    asNonEmptyString(result.published_settings_version_id);
  const actualVersion = asNonEmptyString(draft.published_settings_version_id);
  if (expectedVersion && actualVersion && expectedVersion !== actualVersion) {
    throw new Error('label_designer_publish_label_design_draft published draft readback version mismatch');
  }
}

async function currentSupabaseAccessToken(client: NonNullable<ReturnType<typeof getSupabaseClient>>): Promise<string> {
  const auth = (client as unknown as {
    auth?: { getSession?: () => Promise<{ data?: { session?: { access_token?: string | null } | null } | null }> };
  }).auth;
  if (typeof auth?.getSession !== 'function') throw new Error('Supabase auth session is required');
  const { data } = await auth.getSession();
  const token = asNonEmptyString(data?.session?.access_token);
  if (!token) throw new Error('Sign in again to manage label designer assets');
  return token;
}

async function invokeLabelDesignerAssets<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const userJwt = await currentSupabaseAccessToken(client);
  const { data, error } = await client.functions.invoke<T>('label-designer-assets', {
    body: {
      ...body,
      user_jwt: userJwt,
    },
  });
  if (error) throw new Error(await readFunctionErrorMessage(error, 'label designer asset request failed'));
  const rec = data && typeof data === 'object' ? data as T : null;
  if (!rec) throw new Error('label-designer-assets returned no backend response');
  const outcomeError = backendOutcomeError(rec, 'label designer asset request was rejected by the backend');
  if (outcomeError) throw outcomeError;
  return rec;
}

export async function label_designer_list_assets(): Promise<LabelDesignerAssetListResult> {
  const live = await invokeLabelDesignerAssets<LabelDesignerAssetListResult>({ mode: 'list' });
  if (live) {
    const assets = Array.isArray(live.assets)
      ? live.assets.filter((asset): asset is LabelDesignerAsset =>
        !!asset && typeof asset === 'object' && !!asNonEmptyString((asset as Record<string, unknown>).path),
      )
      : [];
    return { ...live, ok: live.ok !== false, assets };
  }

  await sleep(30);
  return { ok: true, assets: [...localLabelDesignerAssets] };
}

export async function label_designer_upload_asset(
  args: LabelDesignerAssetUploadArgs,
): Promise<LabelDesignerAssetUploadResult> {
  const fileName = asNonEmptyString(args.file_name);
  const fileBase64 = asNonEmptyString(args.file_base64);
  if (!fileName) throw new Error('Asset file name is required');
  if (!fileBase64) throw new Error('Asset file data is required');
  const live = await invokeLabelDesignerAssets<LabelDesignerAssetUploadResult>({
    mode: 'upload',
    file_name: fileName,
    file_base64: fileBase64,
    content_type: asNonEmptyString(args.content_type) ?? 'application/octet-stream',
  });
  if (live) {
    const path = asNonEmptyString(live.path);
    if (!path) throw new Error('label-designer-assets upload returned no storage path');
    const list = await label_designer_list_assets();
    if (!list.assets.some((asset) => asset.path === path)) {
      throw new Error('label-designer-assets upload readback missing uploaded asset');
    }
    return { ...live, ok: live.ok !== false, path };
  }

  await sleep(40);
  const safeName = fileName.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120);
  const path = `local/designer/${safeName || nextResourceId('label_asset')}`;
  const existing = localLabelDesignerAssets.findIndex((asset) => asset.path === path);
  const asset = { name: safeName, path };
  if (existing >= 0) localLabelDesignerAssets[existing] = asset;
  else localLabelDesignerAssets.unshift(asset);
  return { ok: true, path };
}

export async function label_designer_delete_asset(
  path: string,
): Promise<{ ok: boolean; path?: string; error?: Record<string, unknown> }> {
  const assetPath = asNonEmptyString(path);
  if (!assetPath) throw new Error('Asset path is required');
  const live = await invokeLabelDesignerAssets<{ ok: boolean; path?: string; error?: Record<string, unknown> }>({
    mode: 'delete',
    path: assetPath,
  });
  if (live) {
    const list = await label_designer_list_assets();
    if (list.assets.some((asset) => asset.path === assetPath)) {
      throw new Error('label-designer-assets delete readback still contains deleted asset');
    }
    return { ...live, ok: live.ok !== false, path: assetPath };
  }

  await sleep(30);
  const idx = localLabelDesignerAssets.findIndex((asset) => asset.path === assetPath);
  if (idx >= 0) localLabelDesignerAssets.splice(idx, 1);
  return { ok: true, path: assetPath };
}

export async function label_designer_preview_label_design_draft(
  args: LabelDesignerPreviewArgs,
): Promise<LabelDesignerPreviewResult> {
  const draftId = asNonEmptyString(args.draft_id);
  const shipmentId = asNonEmptyString(args.shipment_id);
  if (!draftId) throw new Error('draft_id is required');
  if (!shipmentId) throw new Error('shipment_id is required');

  const client = getSupabaseClient();
  if (client) {
    const userJwt = await currentSupabaseAccessToken(client);
    const { data, error } = await client.functions.invoke<LabelDesignerPreviewResult>('label-renderer', {
      body: {
        mode: 'designer_preview',
        user_jwt: userJwt,
        draft_id: draftId,
        label_type: asNonEmptyString(args.label_type) ?? 'shipping',
        shipment_id: shipmentId,
        shipment_box_id: asNonEmptyString(args.shipment_box_id) ?? null,
      },
    });
    if (error) throw new Error(await readFunctionErrorMessage(error, 'label designer preview failed'));
    const rec = data && typeof data === 'object' ? data as LabelDesignerPreviewResult : null;
    if (!rec) throw new Error('label-renderer designer preview returned no backend response');
    if (rec.ok !== false && !asNonEmptyString(rec.pdf_base64)) {
      throw new Error('label-renderer designer preview returned no PDF readback');
    }
    return { ...rec, ok: rec.ok !== false };
  }

  await sleep(40);
  return {
    ok: true,
    pdf_base64: 'JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+CmVuZG9iago=',
    renderer_metadata: {
      preview: true,
      draft_id: draftId,
      shipment_id: shipmentId,
    },
    validation: { ok: true, errors: [] },
  };
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
  const live = await liveRpc<unknown>('request_label_reprint', {
    p_label_id: labelId,
    p_reprint_reason: reason,
    p_actor_id: null,
    p_requested_source: 'console-v2',
  });
  if (live) {
    const rec = live.data && typeof live.data === 'object'
      ? live.data as Record<string, unknown>
      : null;
    const labelJobId =
      asNonEmptyString(live.data) ??
      asNonEmptyString(rec?.label_job_id) ??
      asNonEmptyString(rec?.job_id) ??
      asNonEmptyString(rec?.id);
    const labelVersionId =
      asNonEmptyString(rec?.new_version_id) ??
      asNonEmptyString(rec?.label_version_id);
    const evidenceId = labelJobId ?? labelVersionId;
    if (!evidenceId) {
      throw new Error('Label reprint did not return a label job or version id');
    }
    await requireLabelReprintReadback(labelId, {
      versionId: labelVersionId,
      jobId: labelJobId,
      backendId: evidenceId,
    });
    return {
      ok: true,
      label_id: labelId,
      reason,
      label_job_id: labelJobId ?? null,
      new_version_id: labelVersionId ?? null,
    };
  }

  await sleep(120);
  return { ok: true, label_id: labelId, reason, label_job_id: 'ljob_' + Date.now(), new_version_id: null };
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

  assertSeedFallbackAllowed('ui_request_label_generation_target_v1');
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

async function requireLabelReprintReadback(
  labelId: string,
  ids: { versionId?: string | null; jobId?: string | null; backendId?: string | null },
): Promise<void> {
  const candidates: Array<{ resource: 'label_versions' | 'label_jobs'; id: string }> = [];
  const pushCandidate = (resource: 'label_versions' | 'label_jobs', id?: string | null) => {
    const normalized = asNonEmptyString(id);
    if (!normalized) return;
    if (candidates.some((candidate) => candidate.resource === resource && candidate.id === normalized)) return;
    candidates.push({ resource, id: normalized });
  };

  pushCandidate('label_versions', ids.versionId);
  pushCandidate('label_jobs', ids.jobId);
  pushCandidate('label_versions', ids.backendId);
  pushCandidate('label_jobs', ids.backendId);

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const row = await ui_get_resource_v1<Record<string, unknown>>(candidate.resource, candidate.id);
      if (!row) continue;
      const rowLabelId = asNonEmptyString(row.label_id);
      if (rowLabelId && rowLabelId !== labelId) {
        throw new Error(`Label reprint ${candidate.resource} readback belongs to ${rowLabelId}, expected ${labelId}`);
      }
      const metadata = objectRecord(row.target_metadata);
      const sourceArtifactId =
        asNonEmptyString(metadata.source_label_artifact_id) ??
        asNonEmptyString(metadata.label_artifact_id);
      if (!rowLabelId && sourceArtifactId && sourceArtifactId !== labelId) {
        throw new Error(`Label reprint ${candidate.resource} readback belongs to artifact ${sourceArtifactId}, expected ${labelId}`);
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const suffix = lastError instanceof Error && lastError.message ? `: ${lastError.message}` : '';
  throw new Error(`Label reprint backend readback missing label_jobs or label_versions${suffix}`);
}

// W54-F — typed adapter for the canonical complete_label_job seam. Live mode
// routes through `phaseC6Rpc('complete_label_job', payload, 'label_jobs')`;
// the in-memory branch returns a deterministic envelope so unit tests can
// assert on the FE-shaped contract without an environment dependency.
export interface CompleteLabelJobResult extends Record<string, unknown> {
  ok: true;
  label_job_id: string;
  status: 'completed';
  correlation_id: string;
  settings_resolution_id?: string;
}

async function requireLiveCompleteLabelJobReadback(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const labelJobId = asNonEmptyString(result.label_job_id) ?? asNonEmptyString(result.job_id) ?? jobId;
  const job = await requireLiveResourceReadback('label_jobs', labelJobId, 'complete_label_job');
  const status = (asNonEmptyString(job.status) ?? asNonEmptyString(result.status) ?? '').toLowerCase();
  const labelId = asNonEmptyString(job.label_id) ?? asNonEmptyString(result.label_id);
  const shipmentId = asNonEmptyString(job.shipment_id);
  const targetType = asNonEmptyString(job.target_type);

  if (!['completed', 'succeeded', 'success'].includes(status)) return;
  if (!labelId) {
    throw new Error('complete_label_job backend readback missing label identity');
  }

  if (shipmentId) {
    await requireLiveResourceReadback('labels', labelId, 'complete_label_job');
    await requireLiveResourceListReadback('label_versions', { label_job_id: labelJobId }, 'complete_label_job');
    return;
  }

  if (targetType) {
    await requireLiveResourceReadback('label_artifacts', labelId, 'complete_label_job');
  }
}

export async function complete_label_job(
  jobId: string,
  payload: unknown,
): Promise<CompleteLabelJobResult> {
  const args = { label_job_id: jobId, ...(payload as Record<string, unknown> | undefined) };
  const client = getSupabaseClient();
  if (client) {
    const result = await phaseC6Rpc('complete_label_job', args, 'label_jobs');
    await requireLiveCompleteLabelJobReadback(jobId, result);
    return result as CompleteLabelJobResult;
  }
  assertSeedFallbackAllowed('complete_label_job');
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
function normalizeUiLogEventPayload(eventJson: unknown): Record<string, unknown> {
  const source: Record<string, unknown> = eventJson && typeof eventJson === 'object' && !Array.isArray(eventJson)
    ? { ...(eventJson as Record<string, unknown>) }
    : { type: 'ui.event', meta: { value: eventJson } };
  const type = asNonEmptyString(source.type)
    ?? asNonEmptyString(source.kind)
    ?? asNonEmptyString(source.event)
    ?? asNonEmptyString(source.name)
    ?? 'ui.event';
  const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload as Record<string, unknown>
    : {};
  const meta = source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)
    ? { ...(source.meta as Record<string, unknown>) }
    : {};

  Object.entries(payload).forEach(([key, value]) => {
    if (meta[key] === undefined) meta[key] = value;
  });
  if (source.correlation_id !== undefined && meta.correlation_id === undefined) {
    meta.correlation_id = source.correlation_id;
  }

  return {
    ...source,
    type,
    name: asNonEmptyString(source.name) ?? type,
    meta,
  };
}
export async function ui_log_event_v1(
  eventJson: unknown,
  app: string = 'console',
  options: UiLogEventOptions = {},
): Promise<UiLogEventResult> {
  const client = getSupabaseClient();
  const loggedAt = new Date().toISOString();
  if (client) {
    try {
      const auth = (client as unknown as {
        auth?: { getSession?: () => Promise<{ data?: { session?: unknown | null } | null }> };
      }).auth;
      if (typeof auth?.getSession === 'function') {
        const { data } = await auth.getSession();
        if (!data?.session) {
          if (options.requireReadback) {
            throw new Error('ui_log_event_v1 backend readback requires an authenticated session');
          }
          return { ok: true, app, logged_at: loggedAt };
        }
      }
      const result = await client.rpc('ui_log_event_v1', {
        p_event: normalizeUiLogEventPayload(eventJson),
        p_app: app,
      } as never);
      if (result.error) {
        throw new Error(result.error.message ?? 'ui_log_event_v1 failed');
      }
      const row = firstRpcRow<Record<string, unknown>>(result.data);
      const eventId =
        asNonEmptyString(result.data) ??
        asNonEmptyString(row?.id) ??
        asNonEmptyString(row?.event_id);
      if (options.requireReadback) {
        if (!eventId) {
          throw new Error('ui_log_event_v1 did not return ui_event_log id for backend readback');
        }
        const readback = await requireLiveResourceReadback(
          'ui_event_log_directory',
          eventId,
          'ui_log_event_v1',
        );
        return { ok: true, app, logged_at: loggedAt, event_id: eventId, readback };
      }
      return { ok: true, app, logged_at: loggedAt, event_id: eventId ?? null };
    } catch (err) {
      if (options.requireReadback) {
        throw err instanceof Error
          ? err
          : new Error('ui_log_event_v1 backend readback failed');
      }
      // Swallow telemetry errors; envelope still returned.
    }
  }
  if (options.requireReadback) {
    throw new Error('ui_log_event_v1 backend readback requires a live backend');
  }
  return { ok: true, app, logged_at: loggedAt };
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
  const workflowTemplateId = asNonEmptyString(args.workflow_template_id);
  if (!workflowTemplateId) throw new Error('workflow_template_id is required');
  const schedule = args.schedule && typeof args.schedule === 'object' ? args.schedule : {};
  const contextPatch = args.context_patch && typeof args.context_patch === 'object' ? args.context_patch : {};
  const enabled = args.enabled !== false;
  const notes = asNonEmptyString(args.notes);

  const live = await liveRpc<Record<string, unknown>>('ui_create_workflow_schedule_trigger_v1', {
    p_workflow_template_id: workflowTemplateId,
    p_schedule: schedule,
    p_context_patch: contextPatch,
    p_enabled: enabled,
    p_notes: notes ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_create_workflow_schedule_trigger_v1', [
      'workflow_schedule_trigger_id',
    ]);
    const triggerId = asNonEmptyString(rec.workflow_schedule_trigger_id);
    if (!triggerId) {
      throw new Error('ui_create_workflow_schedule_trigger_v1 did not return workflow_schedule_trigger_id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_schedule_triggers',
      triggerId,
      'ui_create_workflow_schedule_trigger_v1',
    );
    if (asNonEmptyString(triggerReadback.workflow_template_id) !== workflowTemplateId) {
      throw new Error('ui_create_workflow_schedule_trigger_v1 backend readback did not match workflow_template_id');
    }
    if (!asNonEmptyString(triggerReadback.next_run_at)) {
      throw new Error('ui_create_workflow_schedule_trigger_v1 backend readback missing workflow_schedule_triggers.next_run_at');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'created'),
      workflow_schedule_trigger_id: triggerId,
      workflow_template_id: asNonEmptyString(triggerReadback.workflow_template_id) ?? workflowTemplateId,
      schedule: (triggerReadback.schedule ?? schedule) as Record<string, unknown>,
      context_patch: (triggerReadback.context_patch ?? contextPatch) as Record<string, unknown>,
      scope_type: asNonEmptyString(triggerReadback.scope_type) ?? null,
      scope_id: asNonEmptyString(triggerReadback.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      next_run_at: asNonEmptyString(triggerReadback.next_run_at) ?? null,
      notes: asNonEmptyString(triggerReadback.notes) ?? notes ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_schedule_trigger.create',
    workflow_template_id: workflowTemplateId,
    schedule,
    enabled,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_schedule_trigger_id: `wst_schedule_${Date.now()}`,
    workflow_template_id: workflowTemplateId,
    schedule,
    context_patch: contextPatch,
    scope_type: null,
    scope_id: null,
    enabled,
    next_run_at: null,
    notes: notes ?? null,
  };
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
  const sourceTemplateId = asNonEmptyString(args.source_workflow_template_id);
  const targetTemplateId = asNonEmptyString(args.target_workflow_template_id);
  if (!sourceTemplateId) throw new Error('source_workflow_template_id is required');
  if (!targetTemplateId) throw new Error('target_workflow_template_id is required');
  if (sourceTemplateId === targetTemplateId) {
    throw new Error('source and target workflow templates must differ');
  }
  const sourceStatuses = Array.isArray(args.source_statuses)
    ? args.source_statuses.map((status) => asNonEmptyString(status)).filter(Boolean) as string[]
    : [];
  const contextPatch = args.context_patch && typeof args.context_patch === 'object' ? args.context_patch : {};
  const enabled = args.enabled !== false;
  const notes = asNonEmptyString(args.notes);
  const scopeId = asNonEmptyString(args.scope_id);

  const live = await liveRpc<Record<string, unknown>>('ui_create_workflow_run_trigger_v1', {
    p_source_workflow_template_id: sourceTemplateId,
    p_target_workflow_template_id: targetTemplateId,
    p_source_statuses: sourceStatuses.length ? sourceStatuses : null,
    p_context_patch: contextPatch,
    p_enabled: enabled,
    p_notes: notes ?? null,
    p_scope_id: scopeId ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_create_workflow_run_trigger_v1', [
      'workflow_run_trigger_id',
    ]);
    const triggerId = asNonEmptyString(rec.workflow_run_trigger_id);
    if (!triggerId) {
      throw new Error('ui_create_workflow_run_trigger_v1 did not return workflow_run_trigger_id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_run_triggers',
      triggerId,
      'ui_create_workflow_run_trigger_v1',
    );
    if (asNonEmptyString(triggerReadback.source_workflow_template_id) !== sourceTemplateId) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback did not match source_workflow_template_id');
    }
    if (asNonEmptyString(triggerReadback.target_workflow_template_id) !== targetTemplateId) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback did not match target_workflow_template_id');
    }
    const readbackStatuses = Array.isArray(triggerReadback.source_statuses)
      ? triggerReadback.source_statuses.map((status) => String(status))
      : sourceStatuses;
    if (readbackStatuses.length === 0) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback missing workflow_run_triggers.source_statuses');
    }
    if (scopeId && asNonEmptyString(triggerReadback.scope_id) !== scopeId) {
      throw new Error('ui_create_workflow_run_trigger_v1 backend readback did not match active tenant scope_id');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'created'),
      workflow_run_trigger_id: triggerId,
      source_workflow_template_id: asNonEmptyString(triggerReadback.source_workflow_template_id) ?? sourceTemplateId,
      target_workflow_template_id: asNonEmptyString(triggerReadback.target_workflow_template_id) ?? targetTemplateId,
      source_statuses: readbackStatuses,
      context_patch: (triggerReadback.context_patch ?? contextPatch) as Record<string, unknown>,
      scope_type: asNonEmptyString(triggerReadback.scope_type) ?? null,
      scope_id: asNonEmptyString(triggerReadback.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      notes: asNonEmptyString(triggerReadback.notes) ?? notes ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_run_trigger.create',
    source_workflow_template_id: sourceTemplateId,
    target_workflow_template_id: targetTemplateId,
    source_statuses: sourceStatuses,
    enabled,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_run_trigger_id: `wrt_trigger_${Date.now()}`,
    source_workflow_template_id: sourceTemplateId,
    target_workflow_template_id: targetTemplateId,
    source_statuses: sourceStatuses.length ? sourceStatuses : ['succeeded'],
    context_patch: contextPatch,
    scope_type: null,
    scope_id: null,
    enabled,
    notes: notes ?? null,
  };
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
  const triggerId = asNonEmptyString(args.workflow_run_trigger_id);
  if (!triggerId) throw new Error('workflow_run_trigger_id is required');
  const sourceTemplateId = asNonEmptyString(args.source_workflow_template_id);
  const targetTemplateId = asNonEmptyString(args.target_workflow_template_id);
  if (sourceTemplateId && targetTemplateId && sourceTemplateId === targetTemplateId) {
    throw new Error('source and target workflow templates must differ');
  }
  const sourceStatuses = Array.isArray(args.source_statuses)
    ? args.source_statuses.map((status) => asNonEmptyString(status)).filter(Boolean) as string[]
    : null;
  const contextPatch = args.context_patch && typeof args.context_patch === 'object' ? args.context_patch : undefined;
  const notes = args.notes === undefined ? undefined : asNonEmptyString(args.notes) ?? '';
  const scopeId = asNonEmptyString(args.scope_id);

  const live = await liveRpc<Record<string, unknown>>('ui_update_workflow_run_trigger_v1', {
    p_workflow_run_trigger_id: triggerId,
    p_source_workflow_template_id: sourceTemplateId ?? null,
    p_target_workflow_template_id: targetTemplateId ?? null,
    p_source_statuses: sourceStatuses && sourceStatuses.length ? sourceStatuses : null,
    p_context_patch: contextPatch ?? null,
    p_enabled: typeof args.enabled === 'boolean' ? args.enabled : null,
    p_notes: notes === undefined ? null : notes,
    p_scope_id: scopeId ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_update_workflow_run_trigger_v1', [
      'workflow_run_trigger_id',
    ]);
    const resultTriggerId = asNonEmptyString(rec.workflow_run_trigger_id);
    if (resultTriggerId !== triggerId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback returned a different trigger id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_run_triggers',
      triggerId,
      'ui_update_workflow_run_trigger_v1',
    );
    if (asNonEmptyString(triggerReadback.deleted_at)) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback returned a deleted workflow trigger');
    }
    if (sourceTemplateId && asNonEmptyString(triggerReadback.source_workflow_template_id) !== sourceTemplateId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match source_workflow_template_id');
    }
    if (targetTemplateId && asNonEmptyString(triggerReadback.target_workflow_template_id) !== targetTemplateId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match target_workflow_template_id');
    }
    const readbackStatuses = Array.isArray(triggerReadback.source_statuses)
      ? triggerReadback.source_statuses.map((status) => String(status))
      : [];
    if (sourceStatuses && sourceStatuses.length && readbackStatuses.length === 0) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback missing workflow_run_triggers.source_statuses');
    }
    if (typeof args.enabled === 'boolean' && Boolean(triggerReadback.enabled) !== args.enabled) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match enabled');
    }
    if (scopeId && asNonEmptyString(triggerReadback.scope_id) !== scopeId) {
      throw new Error('ui_update_workflow_run_trigger_v1 backend readback did not match active tenant scope_id');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'updated'),
      workflow_run_trigger_id: triggerId,
      source_workflow_template_id: asNonEmptyString(triggerReadback.source_workflow_template_id) ?? sourceTemplateId ?? null,
      target_workflow_template_id: asNonEmptyString(triggerReadback.target_workflow_template_id) ?? targetTemplateId ?? null,
      source_statuses: readbackStatuses,
      context_patch: (triggerReadback.context_patch ?? contextPatch ?? {}) as Record<string, unknown>,
      scope_type: asNonEmptyString(triggerReadback.scope_type) ?? null,
      scope_id: asNonEmptyString(triggerReadback.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      notes: asNonEmptyString(triggerReadback.notes) ?? null,
      updated_at: asNonEmptyString(triggerReadback.updated_at) ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_run_trigger.update',
    workflow_run_trigger_id: triggerId,
    enabled: args.enabled,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_run_trigger_id: triggerId,
    source_workflow_template_id: sourceTemplateId ?? null,
    target_workflow_template_id: targetTemplateId ?? null,
    source_statuses: sourceStatuses?.length ? sourceStatuses : ['succeeded'],
    context_patch: contextPatch ?? {},
    scope_type: null,
    scope_id: null,
    enabled: args.enabled ?? true,
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function ui_delete_workflow_run_trigger_v1(
  workflowRunTriggerId: string,
  scopeIdArg?: string | null,
): Promise<WorkflowRunTriggerDeleteResult> {
  const triggerId = asNonEmptyString(workflowRunTriggerId);
  if (!triggerId) throw new Error('workflow_run_trigger_id is required');
  const scopeId = asNonEmptyString(scopeIdArg);

  const live = await liveRpc<Record<string, unknown>>('ui_delete_workflow_run_trigger_v1', {
    p_workflow_run_trigger_id: triggerId,
    p_scope_id: scopeId ?? null,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_delete_workflow_run_trigger_v1', [
      'workflow_run_trigger_id',
    ]);
    const resultTriggerId = asNonEmptyString(rec.workflow_run_trigger_id);
    if (resultTriggerId !== triggerId) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback returned a different trigger id');
    }
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_run_triggers',
      triggerId,
      'ui_delete_workflow_run_trigger_v1',
    );
    if (triggerReadback.enabled) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback did not disable the workflow trigger');
    }
    if (!asNonEmptyString(triggerReadback.deleted_at)) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback missing workflow_run_triggers.deleted_at');
    }
    if (scopeId && asNonEmptyString(triggerReadback.scope_id) !== scopeId) {
      throw new Error('ui_delete_workflow_run_trigger_v1 backend readback did not match active tenant scope_id');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'deleted'),
      workflow_run_trigger_id: triggerId,
      source_workflow_template_id: asNonEmptyString(rec.source_workflow_template_id) ?? null,
      target_workflow_template_id: asNonEmptyString(rec.target_workflow_template_id) ?? null,
      scope_type: asNonEmptyString(rec.scope_type) ?? null,
      scope_id: asNonEmptyString(rec.scope_id) ?? null,
      enabled: Boolean(triggerReadback.enabled),
      deleted_at: asNonEmptyString(triggerReadback.deleted_at) ?? asNonEmptyString(rec.deleted_at) ?? null,
      workflow_trigger_fires_count: Number(rec.workflow_trigger_fires_count ?? 0),
    };
  }

  await ui_log_event_v1({
    event: 'workflow_run_trigger.delete',
    workflow_run_trigger_id: triggerId,
  });
  return {
    ok: true,
    status: 'seed_preview',
    workflow_run_trigger_id: triggerId,
    source_workflow_template_id: null,
    target_workflow_template_id: null,
    scope_type: null,
    scope_id: null,
    enabled: false,
    workflow_trigger_fires_count: 0,
  };
}

export async function ui_run_workflow_schedule_trigger_v1(
  workflowScheduleTriggerId: string,
): Promise<WorkflowScheduleRunNowResult> {
  const triggerId = asNonEmptyString(workflowScheduleTriggerId);
  if (!triggerId) throw new Error('workflow_schedule_trigger_id is required');

  const live = await liveRpc<Record<string, unknown>>('ui_run_workflow_schedule_trigger_v1', {
    p_workflow_schedule_trigger_id: triggerId,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_run_workflow_schedule_trigger_v1', [
      'workflow_schedule_trigger_id',
      'workflow_template_id',
    ]);
    const workflowRunId = asNonEmptyString(rec.workflow_run_id);
    const status = String(rec.status ?? 'workflow_started');
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_schedule_triggers',
      triggerId,
      'ui_run_workflow_schedule_trigger_v1',
    );
    if (status === 'preflight_failed') {
      const lastError = asNonEmptyString(triggerReadback.last_error) ?? asNonEmptyString(rec.last_error);
      if (!lastError) {
        throw new Error('ui_run_workflow_schedule_trigger_v1 preflight readback missing workflow_schedule_triggers.last_error');
      }
      return {
        ...rec,
        ok: true,
        status,
        workflow_schedule_trigger_id: String(rec.workflow_schedule_trigger_id ?? triggerId),
        workflow_template_id: asNonEmptyString(rec.workflow_template_id) ?? null,
        workflow_run_id: null,
        last_run_at: null,
        last_error: lastError,
        last_error_at: asNonEmptyString(triggerReadback.last_error_at) ?? asNonEmptyString(rec.last_error_at) ?? null,
      };
    }
    if (!workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 did not return workflow_run_id');
    }
    const lastRunId = asNonEmptyString(triggerReadback.last_run_id);
    if (lastRunId !== workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not update workflow_schedule_triggers.last_run_id');
    }
    if (!asNonEmptyString(triggerReadback.last_run_at)) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not update workflow_schedule_triggers.last_run_at');
    }
    const runReadback = await requireLiveResourceReadback(
      'workflow_runs',
      workflowRunId,
      'ui_run_workflow_schedule_trigger_v1',
    );
    if (asNonEmptyString(runReadback.id) !== workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not return the created workflow_runs row');
    }
    const directoryRows = await requireLiveResourceListReadback(
      'workflow_run_directory',
      { id: workflowRunId },
      'ui_run_workflow_schedule_trigger_v1',
    );
    const directoryRow = directoryRows.find((row) => asNonEmptyString(row.id) === workflowRunId) ?? directoryRows[0]!;
    if (asNonEmptyString(directoryRow.id) !== workflowRunId) {
      throw new Error('ui_run_workflow_schedule_trigger_v1 backend readback did not return the created workflow_run_directory row');
    }
    return {
      ok: true,
      status,
      workflow_schedule_trigger_id: String(rec.workflow_schedule_trigger_id ?? triggerId),
      workflow_template_id: asNonEmptyString(rec.workflow_template_id) ?? null,
      workflow_run_id: workflowRunId,
      last_run_at: asNonEmptyString(triggerReadback.last_run_at) ?? asNonEmptyString(rec.last_run_at) ?? null,
      ...rec,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_schedule_trigger.run_now',
    workflow_schedule_trigger_id: triggerId,
  });
  return {
    ok: true,
    status: 'workflow_started',
    workflow_schedule_trigger_id: triggerId,
    workflow_template_id: null,
    workflow_run_id: `wfr_schedule_${Date.now()}`,
  };
}

export async function ui_repair_workflow_schedule_task_payload_v1(
  workflowScheduleTriggerId: string,
  taskPayload: Record<string, unknown> = {},
): Promise<WorkflowScheduleTaskPayloadRepairResult> {
  const triggerId = asNonEmptyString(workflowScheduleTriggerId);
  if (!triggerId) throw new Error('workflow_schedule_trigger_id is required');

  const live = await liveRpc<Record<string, unknown>>('ui_repair_workflow_schedule_task_payload_v1', {
    p_workflow_schedule_trigger_id: triggerId,
    p_task_payload: taskPayload,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_repair_workflow_schedule_task_payload_v1', [
      'workflow_schedule_trigger_id',
      'workflow_template_id',
      'task_type_key',
    ]);
    const triggerReadback = await requireLiveResourceReadback(
      'workflow_schedule_triggers',
      triggerId,
      'ui_repair_workflow_schedule_task_payload_v1',
    );
    const contextPatch = (triggerReadback.context_patch ?? rec.context_patch) as Record<string, unknown> | undefined;
    const taskPayloadReadback = (contextPatch?.binding_payload as Record<string, unknown> | undefined)?.task;
    if (!taskPayloadReadback || typeof taskPayloadReadback !== 'object') {
      throw new Error('ui_repair_workflow_schedule_task_payload_v1 backend readback missing binding_payload.task');
    }
    if (asNonEmptyString(triggerReadback.last_error)) {
      throw new Error('ui_repair_workflow_schedule_task_payload_v1 backend readback did not clear workflow_schedule_triggers.last_error');
    }
    return {
      ...rec,
      ok: true,
      status: String(rec.status ?? 'payload_repaired'),
      workflow_schedule_trigger_id: String(rec.workflow_schedule_trigger_id ?? triggerId),
      workflow_template_id: asNonEmptyString(rec.workflow_template_id) ?? null,
      workflow_template_step_id: asNonEmptyString(rec.workflow_template_step_id) ?? null,
      operation_name: asNonEmptyString(rec.operation_name) ?? null,
      task_type_key: asNonEmptyString(rec.task_type_key) ?? null,
      queue_key: asNonEmptyString(rec.queue_key) ?? null,
      priority: typeof rec.priority === 'number' ? rec.priority : null,
      sla_minutes: typeof rec.sla_minutes === 'number' ? rec.sla_minutes : null,
      resource_type: asNonEmptyString(rec.resource_type) ?? null,
      resource_id: asNonEmptyString(rec.resource_id) ?? null,
      updated_at: asNonEmptyString(triggerReadback.updated_at) ?? asNonEmptyString(rec.updated_at) ?? null,
      context_patch: contextPatch ?? null,
    };
  }

  await ui_log_event_v1({
    event: 'workflow_schedule_trigger.task_payload_repair',
    workflow_schedule_trigger_id: triggerId,
  });
  return {
    ok: true,
    status: 'payload_repaired',
    workflow_schedule_trigger_id: triggerId,
    workflow_template_id: null,
    workflow_template_step_id: null,
    operation_name: null,
    task_type_key: asNonEmptyString(taskPayload.task_type_key) ?? null,
    queue_key: asNonEmptyString(taskPayload.queue_key) ?? null,
    priority: typeof taskPayload.priority === 'number' ? taskPayload.priority : null,
    sla_minutes: typeof taskPayload.sla_minutes === 'number' ? taskPayload.sla_minutes : null,
    resource_type: asNonEmptyString(taskPayload.resource_type) ?? null,
    resource_id: asNonEmptyString(taskPayload.resource_id) ?? null,
    updated_at: new Date().toISOString(),
    context_patch: { binding_payload: { task: taskPayload } },
  };
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
  const id = asNonEmptyString(deviceId);
  const reason = asNonEmptyString(revokedReason);
  if (!id) throw new Error('ui_execute_user_device_revoke_v1 requires device_id');
  if (!reason) throw new Error('ui_execute_user_device_revoke_v1 requires revoked_reason');

  const live = await liveRpc<Record<string, unknown>>('ui_execute_user_device_revoke_v1', {
    p_action_key: 'user_devices.revoke',
    p_resource_key: 'user_devices',
    p_selection_ids: [id],
    p_selection_id: id,
    p_selection_count: 1,
    p_params: { revoked_reason: reason },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_user_device_revoke_v1', [
      'device_id',
      'revoked_at',
      'items',
      'count',
    ]);
    const items = Array.isArray(rec.items) ? (rec.items as Array<Record<string, unknown>>) : [];
    const first = items[0] ?? {};
    const readback = await requireLiveUserDeviceRevokeReadback(
      'ui_execute_user_device_revoke_v1',
      id,
      reason,
    );
    const revokedAt = requireLiveStringField(
      {
        ...readback.device,
        ...readback.summary,
        ...rec,
        revoked_at:
          first.revoked_at ??
          rec.revoked_at ??
          readback.summary.revoked_at ??
          readback.device.revoked_at,
      },
      ['revoked_at'],
      'ui_execute_user_device_revoke_v1 did not return backend revocation evidence',
    );
    return {
      ok: true,
      status: String(rec.status ?? first.status ?? 'revoked'),
      device_id: String(first.id ?? rec.device_id ?? id),
      revoked_at: revokedAt,
      action_key: String(rec.action_key ?? 'user_devices.revoke'),
      resource_key: String(rec.resource_key ?? 'user_devices'),
      count: Number(rec.count ?? items.length ?? 1),
      items,
      ...rec,
    };
  }

  await sleep(80);
  const revokedAt = new Date().toISOString();
  return {
    ok: true,
    status: 'revoked',
    device_id: id,
    revoked_at: revokedAt,
    action_key: 'user_devices.revoke',
    resource_key: 'user_devices',
    count: 1,
    items: [{ id, status: 'revoked', revoked_at: revokedAt }],
  };
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
  const pageSize = Math.max(1, Math.min(limit, 100));
  const live = await liveRpc<Record<string, unknown>>('ui_list_user_sessions_v1', {
    p_target_user_id: targetUserId ?? null,
    p_limit: pageSize,
  });
  if (live) return normalizeLiveListResult<UserSessionRow>(live.data, 0, pageSize);

  const rows = ((seed as { user_sessions?: Array<UserSessionRow> }).user_sessions ?? [])
    .filter((row) => !targetUserId || row.user_id === targetUserId)
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(String(a.updated_at ?? a.last_seen_at ?? a.created_at ?? ''));
      const bTime = Date.parse(String(b.updated_at ?? b.last_seen_at ?? b.created_at ?? ''));
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    })
    .slice(0, pageSize);
  return { rows, total: rows.length, page: 0, page_size: pageSize };
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
  if (!targetUserId) {
    return { rows: [], total: 0, page: 0, page_size: limit };
  }
  const live = await liveRpc<Record<string, unknown>>('ui_list_user_security_actions_v1', {
    p_target_user_id: targetUserId,
    p_limit: limit,
  });
  if (live) return normalizeLiveListResult<UserSecurityActionRow>(live.data, 0, limit);

  const rows = ((seed.decision_log ?? []) as UserSecurityActionRow[])
    .filter((row) => row.resource_type === 'user' && String(row.resource_id ?? '') === targetUserId)
    .filter((row) =>
      [
        'grant_user_role_v1',
        'revoke_user_role_v1',
        'revoke_session_v1',
        'suspend_user_v1',
        'reactivate_user_v1',
        'force_password_reset_v1',
        'tenant_user_invite_apply_v1',
      ].includes(String(row.decision_point ?? '')),
    )
    .slice()
    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
    .slice(0, limit);
  return { rows, total: rows.length, page: 0, page_size: limit };
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
  const args: Record<string, unknown> = {
    plugin_id: pluginId,
    payload: payload ?? {},
  };
  if (typeof pluginVersionId === 'string' && pluginVersionId.trim()) {
    args.plugin_version_id = pluginVersionId.trim();
  }
  const live = await liveRpc<RunPluginTestResult>('test_integration_plugin_v1', { p_args: args });
  if (live) {
    const result = requireLiveRpcRecord(
      live.data,
      'test_integration_plugin_v1 returned no backend outcome',
    ) as RunPluginTestResult;
    const outcomeError = backendOutcomeError(result, 'test_integration_plugin_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(result, [
      'validation_run_id',
      'integration_plugin_validation_run_id',
      'plugin_validation_run_id',
    ], 'test_integration_plugin_v1 did not return backend validation evidence');
    const validationRunId = asNonEmptyString(result.validation_run_id)
      ?? asNonEmptyString(result.integration_plugin_validation_run_id)
      ?? asNonEmptyString(result.plugin_validation_run_id);
    if (!validationRunId) {
      throw new Error('test_integration_plugin_v1 did not return validation_run_id');
    }
    await requireLiveResourceReadback(
      'integration_plugin_validation_runs',
      validationRunId,
      'test_integration_plugin_v1',
    );
    if (!Array.isArray(result.steps) || result.steps.length === 0) {
      throw new Error('test_integration_plugin_v1 did not return backend trace steps');
    }
    return {
      ok: true,
      plugin_id: result.plugin_id ?? pluginId,
      plugin_version_id: result.plugin_version_id,
      validation_run_id: validationRunId,
      duration_ms: result.duration_ms ?? 0,
      steps: result.steps ?? [],
      correlation_id: result.correlation_id,
      settings_resolution_id: result.settings_resolution_id,
    };
  }
  // In-memory branch: deterministic trace mirroring the canonical RPC shape.
  await sleep(420);
  const duration = 420 + Math.floor(Math.random() * 80);
  return {
    ok: true,
    plugin_id: pluginId,
    plugin_version_id: `pv_${pluginId}_demo`,
    validation_run_id: nextResourceId('vr'),
    duration_ms: duration,
    steps: [
      { name: 'verify_signature', ok: true, ms: 12, signature_required: true },
      { name: 'parse_payload', ok: true, ms: 24, payload_size: JSON.stringify(payload ?? {}).length },
      { name: 'apply_mapping', ok: true, ms: 88, mapping_present: true },
      { name: 'validate_schema', ok: true, ms: 31, plugin_kind: 'webhook' },
      { name: 'bind_workflow', ok: true, ms: 56, workflow_template_active: true },
      { name: 'respond', ok: true, ms: 14, plugin_status: 'active' },
    ],
    correlation_id: nextCorrelationId(),
    settings_resolution_id: 'srlv_demo',
  };
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
    assertSeedFallbackAllowed('edge api-gateway');
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
  headers['x-idempotency-key'] = idempotencyKey;
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
    assertSeedFallbackAllowed('edge webhook-receiver');
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

async function requireLivePluginStudioSaveReadback(
  result: PluginStudioSaveResult,
): Promise<void> {
  const saved = objectRecord(result.result);
  const report = objectRecord(result.report);
  const mappingConfigId = asNonEmptyString(saved.mapping_config_id)
    ?? asNonEmptyString(result.mapping_config_id);
  if (mappingConfigId) {
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'integration-plugin-studio/save');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'integration-plugin-studio/save');
  }
  const pluginVersionId = asNonEmptyString(saved.plugin_version_id)
    ?? asNonEmptyString(result.plugin_version_id);
  if (pluginVersionId) {
    await requireLiveResourceReadback('integration_plugin_versions', pluginVersionId, 'integration-plugin-studio/save');
  }
  const pluginId = asNonEmptyString(saved.plugin_id)
    ?? asNonEmptyString(result.plugin_id);
  if (pluginId) {
    await requireLiveResourceReadback('integration_plugins', pluginId, 'integration-plugin-studio/save');
    await requireLiveResourceReadback('integration_plugin_directory', pluginId, 'integration-plugin-studio/save');
  }
  const reportId = asNonEmptyString(report.mapping_operation_report_id)
    ?? asNonEmptyString(report.operation_report_id)
    ?? asNonEmptyString(report.report_id)
    ?? asNonEmptyString(report.id)
    ?? asNonEmptyString(result.report_id);
  if (reportId) {
    await requireLiveResourceReadback('mapping_operation_reports', reportId, 'integration-plugin-studio/save');
  }
  if (!mappingConfigId && !pluginVersionId && !pluginId) {
    throw new Error('integration-plugin-studio/save did not return persisted artifact id for readback');
  }
}

interface EdgeStudioErrorEnvelope {
  error?: { code?: string; message?: string };
  message?: string;
  ok?: false;
}

const PLUGIN_STUDIO_FN = 'integration-plugin-studio';

async function invokeStudioStage<TBody extends Record<string, unknown>, TResult>(
  stage: 'parse' | 'infer' | 'preview' | 'save',
  body: TBody,
): Promise<TResult | null> {
  const client = getSupabaseClient();
  if (!client) {
    assertSeedFallbackAllowed(`edge ${PLUGIN_STUDIO_FN}/${stage}`);
    return null;
  }
  // Edge fn resolves the endpoint from the URL path. Supabase JS client builds
  // the URL as `${SUPABASE_URL}/functions/v1/${name}`, so we pass the stage as a
  // sub-path on the function name. The edge fn's `resolveEndpoint` accepts both
  // path-based and `body.action` forms; we set both to be defensive.
  const { data, error } = await client.functions.invoke<TResult>(`${PLUGIN_STUDIO_FN}/${stage}`, {
    body: { ...body, action: stage },
  });
  if (error) {
    // Supabase wraps non-2xx responses in FunctionsHttpError with the response
    // body available via `await error.context?.json()`. Surface the structured
    // edge envelope when available, otherwise fall back to the error message.
    let message = error.message || `integration-plugin-studio/${stage} failed`;
    try {
      const ctx = (error as unknown as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        const envelope = (await ctx.json()) as EdgeStudioErrorEnvelope;
        message = envelope.error?.message || envelope.message || message;
      }
    } catch {
      // best-effort; keep original message
    }
    throw new Error(message);
  }
  if (!data) {
    throw new Error(`integration-plugin-studio/${stage} returned no payload`);
  }
  const rec = objectRecord(data);
  if (Object.keys(rec).length === 0) {
    throw new Error(`integration-plugin-studio/${stage} returned no payload`);
  }
  const outcomeError = backendOutcomeError(rec, `integration-plugin-studio/${stage} was rejected by the backend`);
  if (outcomeError) throw outcomeError;
  requireLiveEvidence(
    rec,
    ['correlation_id'],
    `integration-plugin-studio/${stage} did not return backend edge evidence`,
  );
  if (stage === 'save') {
    requireLiveEvidence(
      rec,
      ['result', 'report', 'plugin_version_id', 'mapping_config_id', 'report_id'],
      'integration-plugin-studio/save did not return backend save evidence',
    );
  }
  return data;
}

function buildSyntheticContract(args: PluginStudioParseArgs): PluginStudioNormalizedContract {
  const explicitKind = args.plugin_kind;
  if (args.source_type === 'curl') {
    const raw = typeof args.source_payload === 'string'
      ? args.source_payload
      : (args.source_payload as { curl?: string; raw?: string } | null)?.curl
        ?? (args.source_payload as { curl?: string; raw?: string } | null)?.raw
        ?? '';
    // Naive curl extraction for the demo branch — only recognizes URL + METHOD
    const urlMatch = /https?:\/\/[^\s'"]+/i.exec(raw);
    const url = urlMatch ? urlMatch[0] : 'https://example.invalid/path';
    let path = '/';
    try {
      path = new URL(url).pathname || '/';
    } catch {
      path = '/';
    }
    const methodMatch = /(?:-X|--request)\s+([A-Z]+)/.exec(raw);
    const method = (methodMatch?.[1] ?? 'POST').toUpperCase();
    return {
      source_type: 'curl',
      plugin_kind: explicitKind ?? 'api',
      route: {
        method,
        path_template: path,
        upstream_method: method,
        upstream_path_template: path,
      },
      sample_schema: { type: 'object', properties: {} },
      metadata: { source_url: url },
    };
  }
  if (args.source_type === 'webhook_sample') {
    const sample = (args.source_payload as { sample?: unknown; payload?: unknown } | null)?.sample
      ?? (args.source_payload as { sample?: unknown; payload?: unknown } | null)?.payload
      ?? args.source_payload
      ?? {};
    return {
      source_type: 'webhook_sample',
      plugin_kind: explicitKind ?? 'webhook',
      webhook: { sample_payload: sample },
      sample_schema: { type: 'object', properties: {} },
      metadata: {},
    };
  }
  if (args.source_type === 'openapi') {
    return {
      source_type: 'openapi',
      plugin_kind: explicitKind ?? 'api',
      route: { method: 'POST', path_template: '/', upstream_method: 'POST', upstream_path_template: '/' },
      sample_schema: { type: 'object', properties: {} },
      metadata: { document_kind: 'openapi' },
    };
  }
  return {
    source_type: 'manual',
    plugin_kind: explicitKind ?? 'webhook',
    webhook: { sample_payload: {} },
    sample_schema: { type: 'object', properties: {} },
    metadata: {},
  };
}

function buildSyntheticMapping(contract: PluginStudioNormalizedContract): Record<string, unknown> {
  return {
    version: 1,
    mode: 'deterministic',
    plugin_kind: contract.plugin_kind,
    fields: [
      { target_field: 'external_id', source_path: '$.id', confidence: 0.75, source: 'deterministic' },
      { target_field: 'event_type', source_path: '$.event', confidence: 0.75, source: 'deterministic' },
    ],
  };
}

function buildSyntheticReview(coerciveBlocking = 0): PluginStudioReview {
  return {
    mapping_config: { version: 1, fields: [] },
    coerced_preview: {},
    coercions: [],
    diagnostics: coerciveBlocking > 0
      ? [{
          level: 'error',
          blocking: true,
          code: 'demo_blocking',
          fieldPath: null,
          message: 'Synthetic blocking diagnostic (demo branch).',
          why: 'In-memory mode; live mode returns real diagnostics from edge fn.',
          recommended_fix: 'Run against a live Supabase project to see real diagnostics.',
        }]
      : [],
    review_summary: {
      blocking_count: coerciveBlocking,
      warning_count: 0,
      coercion_count: 0,
      next_steps: [],
      egress_policy_resolution_id: null,
    },
  };
}

/**
 * Stage 1 — `parse`. Normalizes a raw source (curl text, OpenAPI doc, webhook
 * sample JSON, or manual config) into the canonical `normalized_contract` shape
 * and produces an initial deterministic mapping suggestion. Optionally persists
 * a draft plugin version when `persist_draft=true`.
 */
export async function plugin_studio_parse_v1(
  args: PluginStudioParseArgs,
): Promise<PluginStudioParseResult> {
  const live = await invokeStudioStage<typeof args, PluginStudioParseResult>('parse', args);
  if (live) return live;
  await sleep(160);
  const contract = buildSyntheticContract(args);
  return {
    ok: true,
    endpoint: 'parse',
    normalized_contract: contract,
    mapping_suggestion: buildSyntheticMapping(contract),
    draft: null,
    correlation_id: nextCorrelationId(),
  };
}

/**
 * Stage 2 — `infer`. Takes a normalized contract (or raw source) and produces a
 * mapping suggestion plus outbound operation suggestions for API plugins.
 */
export async function plugin_studio_infer_v1(
  args: PluginStudioInferArgs,
): Promise<PluginStudioInferResult> {
  const live = await invokeStudioStage<typeof args, PluginStudioInferResult>('infer', args);
  if (live) return live;
  await sleep(180);
  const contract = args.normalized_contract ?? buildSyntheticContract(args);
  return {
    ok: true,
    endpoint: 'infer',
    mapping_suggestion: buildSyntheticMapping(contract),
    outbound_suggestions: contract.plugin_kind === 'api'
      ? [{
          operation_name: 'forward_event',
          method: (contract.route as { method?: string } | undefined)?.method ?? 'POST',
          url_template: 'https://example-provider.invalid/',
          headers_template: { 'content-type': 'application/json' },
          body_template: { payload: '$.payload' },
          auth: { mode: 'bearer_token_header' },
          timeout_seconds: 30,
        }]
      : [],
    normalized_contract: contract,
    draft: null,
    correlation_id: nextCorrelationId(),
  };
}

/**
 * Stage 3 — `preview`. Validates a candidate mapping against the target schema,
 * resolves egress/header policy, returns blocking/non-blocking diagnostics,
 * coercions, and the recommended save mode (direct vs draft).
 */
export async function plugin_studio_preview_v1(
  args: PluginStudioPreviewArgs,
): Promise<PluginStudioPreviewResult> {
  const live = await invokeStudioStage<typeof args, PluginStudioPreviewResult>('preview', args);
  if (live) return live;
  await sleep(150);
  const contract = args.normalized_contract ?? buildSyntheticContract({
    source_type: (args.source_type ?? 'manual') as PluginStudioSourceType,
    source_payload: args.source_payload ?? {},
    plugin_kind: args.plugin_kind,
  });
  return {
    ok: true,
    endpoint: 'preview',
    artifact: args.artifact,
    normalized_contract: args.artifact === 'tabular_import' ? null : contract,
    mapping_suggestion: args.mapping_config ?? buildSyntheticMapping(contract),
    review: buildSyntheticReview(),
    save_modes: {
      direct_allowed: args.artifact !== 'integration_plugin',
      draft_allowed: args.artifact !== 'tabular_import',
      recommended: args.artifact === 'integration_plugin' ? 'draft' : 'direct',
    },
    correlation_id: nextCorrelationId(),
  };
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
  const live = await invokeStudioStage<typeof args, PluginStudioSaveResult>('save', args);
  if (live) {
    await requireLivePluginStudioSaveReadback(live);
    return live;
  }
  await sleep(220);
  const contract = args.normalized_contract ?? buildSyntheticContract({
    source_type: (args.source_type ?? 'manual') as PluginStudioSourceType,
    source_payload: args.source_payload ?? {},
    plugin_kind: args.plugin_kind,
  });
  const recommendedMode: PluginStudioSaveMode = args.save_mode
    ?? (args.artifact === 'integration_plugin' ? 'draft' : 'direct');
  return {
    ok: true,
    endpoint: 'save',
    artifact: args.artifact,
    save_mode: recommendedMode,
    normalized_contract: args.artifact === 'tabular_import' ? null : contract,
    review: buildSyntheticReview(),
    result: {
      primary_resource_type: args.artifact,
      primary_resource_id: nextResourceId('art'),
      mapping_config_id: nextResourceId('mc'),
      ...(args.artifact === 'integration_plugin'
        ? { plugin_id: nextResourceId('plg'), plugin_version_id: nextResourceId('pv') }
        : {}),
    },
    report: {
      report_id: nextResourceId('rep'),
      status: 'succeeded',
    },
    correlation_id: nextCorrelationId(),
  };
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

const RESOURCE_IMPORT_STUDIO_FN = 'resource-import-studio';

const RESOURCE_IMPORT_PREPARE_READBACK_COUNT_KEYS = [
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

const RESOURCE_IMPORT_PREPARE_READBACK_SUMMARY_KEYS = [
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

function mergeResourceImportPrepareReadback(
  result: ResourceImportStudioPrepareResult,
  readback: Record<string, unknown>,
): ResourceImportStudioPrepareResult {
  const summary = objectRecord(readback.summary);
  const dryRun = objectRecord(result.dry_run);
  const mergedDryRun: Record<string, unknown> = {
    ...dryRun,
    id: readback.id ?? dryRun.id,
    run_id: readback.id ?? dryRun.run_id,
    resource_key: readback.resource_key ?? dryRun.resource_key,
    write_mode: readback.write_mode ?? dryRun.write_mode,
    source_format: readback.source_format ?? dryRun.source_format,
    source_file_name: readback.source_file_name ?? dryRun.source_file_name,
    header_fingerprint: readback.header_fingerprint ?? dryRun.header_fingerprint,
    sheet_name: readback.sheet_name ?? dryRun.sheet_name,
    status: readback.status ?? dryRun.status,
  };

  for (const key of RESOURCE_IMPORT_PREPARE_READBACK_COUNT_KEYS) {
    if (readback[key] !== undefined && readback[key] !== null) {
      mergedDryRun[key] = readback[key];
    }
  }
  for (const key of RESOURCE_IMPORT_PREPARE_READBACK_SUMMARY_KEYS) {
    if (summary[key] !== undefined && summary[key] !== null) {
      mergedDryRun[key] = summary[key];
    }
  }
  if (readback.rows !== undefined && readback.rows !== null) {
    mergedDryRun.rows = readback.rows;
  } else if (summary.rows_preview !== undefined && summary.rows_preview !== null) {
    mergedDryRun.rows = summary.rows_preview;
  }
  if (summary.related_node_summary !== undefined && summary.related_node_summary !== null) {
    mergedDryRun.related_nodes = summary.related_node_summary;
  }

  const summaryProfileMatch = objectRecord(summary.profile_match);
  const summaryAvailableProfiles = Array.isArray(summary.available_profiles) ? summary.available_profiles : null;
  const summaryResolvedRules = Array.isArray(summary.resolved_rules) ? summary.resolved_rules : null;

  return {
    ...result,
    dry_run: mergedDryRun,
    profile_match: Object.keys(summaryProfileMatch).length > 0 ? summaryProfileMatch : result.profile_match,
    available_profiles: summaryAvailableProfiles ?? result.available_profiles,
    resolved_rules: summaryResolvedRules ?? result.resolved_rules,
  };
}

async function requireLiveResourceImportPrepareReadback(
  result: ResourceImportStudioPrepareResult,
  args: ResourceImportStudioPrepareArgs,
): Promise<Record<string, unknown>> {
  const dryRun = objectRecord(result.dry_run);
  const runId = asNonEmptyString(dryRun.run_id)
    ?? asNonEmptyString(dryRun.id)
    ?? asNonEmptyString(result.run_id);
  if (!runId) throw new Error('resource-import-studio/prepare did not return run_id');
  const readback = await requireLiveResourceReadback('tabular_import_runs', runId, 'resource-import-studio/prepare');
  const status = String(readback.status ?? '').trim();
  if (status !== 'prepared') {
    throw new Error(`resource-import-studio/prepare backend readback status mismatch for tabular_import_runs:${runId}`);
  }
  const expectedResource = asNonEmptyString(dryRun.resource_key)
    ?? asNonEmptyString(args.resource_key);
  const actualResource = asNonEmptyString(readback.resource_key);
  if (expectedResource && actualResource && actualResource !== expectedResource) {
    throw new Error(`resource-import-studio/prepare backend readback resource mismatch for tabular_import_runs:${runId}`);
  }

  const profile = objectRecord(result.profile_match);
  const mappingConfigId = asNonEmptyString(profile.mapping_config_id)
    ?? asNonEmptyString(profile.id);
  if (mappingConfigId) {
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'resource-import-studio/prepare');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'resource-import-studio/prepare');
  }
  return readback;
}

async function requireLiveResourceImportStartReadback(
  result: ResourceImportStudioStartResult,
  args: ResourceImportStudioStartArgs,
): Promise<void> {
  const run = objectRecord(result.run);
  const runId = asNonEmptyString(run.id)
    ?? asNonEmptyString(run.run_id)
    ?? asNonEmptyString(args.run_id);
  if (!runId) throw new Error('resource-import-studio/start did not return run_id');
  const readback = await requireLiveResourceReadback('tabular_import_runs', runId, 'resource-import-studio/start');
  const status = String(readback.status ?? run.status ?? '').trim();
  if (!['queued', 'processing', 'completed', 'completed_with_errors'].includes(status)) {
    throw new Error(`resource-import-studio/start backend readback status mismatch for tabular_import_runs:${runId}`);
  }
  if (['queued', 'processing'].includes(status) && !asNonEmptyString(readback.task_id) && !asNonEmptyString(run.task_id)) {
    throw new Error(`resource-import-studio/start backend readback missing task for tabular_import_runs:${runId}`);
  }

  const importJobId = asNonEmptyString(run.import_job_id)
    ?? asNonEmptyString(result.import_job_id)
    ?? asNonEmptyString(run.job_id)
    ?? asNonEmptyString(result.job_id);
  if (importJobId) {
    await requireLiveImportJobReadback('resource-import-studio/start', importJobId);
  }

  const profile = objectRecord(args.save_profile);
  const mappingConfigId = asNonEmptyString(run.mapping_config_id)
    ?? asNonEmptyString(result.mapping_config_id)
    ?? asNonEmptyString(profile.mapping_config_id)
    ?? asNonEmptyString(profile.id);
  if (mappingConfigId) {
    await requireLiveResourceReadback('mapping_configs', mappingConfigId, 'resource-import-studio/start');
    await requireLiveResourceReadback('mapping_config_directory', mappingConfigId, 'resource-import-studio/start');
  }
}

async function recoverLiveResourceImportStartReadback(
  args: ResourceImportStudioStartArgs,
  failureMessage: string,
): Promise<ResourceImportStudioStartResult | null> {
  const runId = asNonEmptyString(args.run_id);
  if (!runId || !hasConsoleLiveBackend()) return null;
  try {
    const readback = await requireLiveResourceReadback(
      'tabular_import_runs',
      runId,
      'resource-import-studio/start recovery',
    );
    const status = String(readback.status ?? '').trim();
    if (!['queued', 'processing', 'completed', 'completed_with_errors'].includes(status)) return null;
    if (['queued', 'processing'].includes(status) && !asNonEmptyString(readback.task_id)) return null;
    const result: ResourceImportStudioStartResult = {
      ok: true,
      run: {
        ...readback,
        id: asNonEmptyString(readback.id) ?? runId,
        recovered_from_edge_error: failureMessage,
      },
      report: objectRecord(readback.report),
      correlation_id: nextCorrelationId(),
    };
    await requireLiveResourceImportStartReadback(result, args);
    return result;
  } catch {
    return null;
  }
}

async function requireLiveResourceImportCancelReadback(
  result: ResourceImportStudioCancelResult,
  args: ResourceImportStudioCancelArgs,
): Promise<void> {
  const run = objectRecord(result.run);
  const runId = asNonEmptyString(run.id)
    ?? asNonEmptyString(run.run_id)
    ?? asNonEmptyString(args.run_id);
  if (!runId) throw new Error('resource-import-studio/cancel did not return run_id');
  const expectedReason = asNonEmptyString(args.reason);
  if (!expectedReason) throw new Error('resource-import-studio/cancel requires reason');
  const readback = await requireLiveResourceReadback(
    'tabular_import_runs',
    runId,
    'resource-import-studio/cancel',
  );
  const status = String(readback.status ?? run.status ?? '').trim();
  if (status !== 'canceled') {
    throw new Error(`resource-import-studio/cancel backend readback status mismatch for tabular_import_runs:${runId}`);
  }
  const summary = objectRecord(readback.summary);
  const cancellation = objectRecord(summary.cancellation);
  const actualReason = asNonEmptyString(cancellation.reason)
    ?? asNonEmptyString(summary.cancel_reason)
    ?? asNonEmptyString(summary.cancellation_reason);
  if (actualReason !== expectedReason) {
    throw new Error(`resource-import-studio/cancel backend readback reason mismatch for tabular_import_runs:${runId}`);
  }
}

async function readFunctionsErrorMessage(error: unknown, fallback: string): Promise<string> {
  let message = (error as { message?: string } | null)?.message || fallback;
  try {
    const ctx = (error as { context?: Response } | null)?.context;
    if (ctx && typeof ctx.json === 'function') {
      const envelope = (await ctx.json()) as EdgeStudioErrorEnvelope;
      message = envelope.error?.message || envelope.message || message;
    }
  } catch {
    // best-effort; keep original message
  }
  return message;
}

export async function resource_import_studio_prepare_v1(
  args: ResourceImportStudioPrepareArgs,
): Promise<ResourceImportStudioPrepareResult> {
  const client = getSupabaseClient();
  if (client) {
    const form = new FormData();
    form.append('action', 'prepare');
    form.append('file', args.file);
    form.append('resource_key', args.resource_key);
    form.append('write_mode', args.write_mode ?? 'create');
    form.append('rule_source', args.rule_source ?? 'auto');
    if (args.sheet_name) form.append('sheet_name', args.sheet_name);
    if (args.rules) form.append('rules', JSON.stringify(args.rules));
    if (args.row_overrides) form.append('row_overrides', JSON.stringify(args.row_overrides));
    if (args.scope_context) form.append('scope_context', JSON.stringify(args.scope_context));

    const { data, error } = await client.functions.invoke<ResourceImportStudioPrepareResult>(
      RESOURCE_IMPORT_STUDIO_FN,
      { body: form },
    );
    if (error) {
      throw new Error(await readFunctionsErrorMessage(error, `${RESOURCE_IMPORT_STUDIO_FN}/prepare failed`));
    }
    if (!data) throw new Error(`${RESOURCE_IMPORT_STUDIO_FN}/prepare returned no payload`);
    const readback = await requireLiveResourceImportPrepareReadback(data, args);
    return mergeResourceImportPrepareReadback(data, readback);
  }

  assertSeedFallbackAllowed('resource_import_studio_prepare_v1');
  await sleep(140);
  let rowCount = 0;
  try {
    const text = await args.file.text();
    rowCount = Math.max(0, text.split(/\r?\n/).filter((line) => line.trim()).length - 1);
  } catch {
    rowCount = 0;
  }
  const runId = '00000000-0000-4000-8000-' + String(Math.floor(Math.random() * 999999999999)).padStart(12, '0');
  return {
    ok: true,
    dry_run: {
      run_id: runId,
      resource_key: args.resource_key,
      write_mode: args.write_mode ?? 'create',
      total_rows: rowCount,
      valid_rows: rowCount,
      error_rows: 0,
      source_file_name: args.file.name,
    },
    profile_match: null,
    available_profiles: [],
    resolved_rules: [],
    correlation_id: nextCorrelationId(),
  };
}

export async function resource_import_studio_start_v1(
  args: ResourceImportStudioStartArgs,
): Promise<ResourceImportStudioStartResult> {
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<ResourceImportStudioStartResult>(
      RESOURCE_IMPORT_STUDIO_FN,
      {
        body: {
          action: 'start',
          run_id: args.run_id,
          save_profile: args.save_profile ?? null,
        },
      },
    );
    if (error) {
      const message = await readFunctionsErrorMessage(error, `${RESOURCE_IMPORT_STUDIO_FN}/start failed`);
      const recovered = await recoverLiveResourceImportStartReadback(args, message);
      if (recovered) return recovered;
      throw new Error(message);
    }
    if (!data) throw new Error(`${RESOURCE_IMPORT_STUDIO_FN}/start returned no payload`);
    await requireLiveResourceImportStartReadback(data, args);
    return data;
  }

  assertSeedFallbackAllowed('resource_import_studio_start_v1');
  await sleep(120);
  return {
    ok: true,
    run: {
      id: args.run_id,
      status: 'queued',
      started_at: new Date().toISOString(),
    },
    report: null,
    correlation_id: nextCorrelationId(),
  };
}

export async function resource_import_studio_cancel_v1(
  args: ResourceImportStudioCancelArgs,
): Promise<ResourceImportStudioCancelResult> {
  const runId = asNonEmptyString(args.run_id);
  if (!runId) throw new Error('resource-import-studio/cancel requires run_id');
  const reason = asNonEmptyString(args.reason);
  if (!reason) throw new Error('resource-import-studio/cancel requires reason');

  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<ResourceImportStudioCancelResult>(
      RESOURCE_IMPORT_STUDIO_FN,
      {
        body: {
          action: 'cancel',
          run_id: runId,
          reason,
        },
      },
    );
    if (error) {
      throw new Error(await readFunctionsErrorMessage(error, `${RESOURCE_IMPORT_STUDIO_FN}/cancel failed`));
    }
    if (!data) throw new Error(`${RESOURCE_IMPORT_STUDIO_FN}/cancel returned no payload`);
    await requireLiveResourceImportCancelReadback(data, { run_id: runId, reason });
    return data;
  }

  assertSeedFallbackAllowed('resource_import_studio_cancel_v1');
  await sleep(80);
  const now = new Date().toISOString();
  return {
    ok: true,
    run: {
      id: runId,
      status: 'canceled',
      canceled_at: now,
      completed_at: now,
      summary: {
        cancellation: {
          reason,
          canceled_at: now,
        },
        cancel_reason: reason,
      },
    },
    correlation_id: nextCorrelationId(),
  };
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
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<ResourceDownloadUrlResult>(
      'ui-resource-download',
      { body: args },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'ui-resource-download failed'));
    }
    const rec = objectRecord(data);
    const outcomeError = backendOutcomeError(rec, 'ui-resource-download was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const url = asNonEmptyString(rec.url);
    if (!url) {
      throw new Error('ui-resource-download returned no signed URL');
    }
    return {
      ...rec,
      url,
      expires_at: asNonEmptyString(rec.expires_at),
      file_name: asNonEmptyString(rec.file_name),
      mime_type: asNonEmptyString(rec.mime_type),
    };
  }

  assertSeedFallbackAllowed('resolve_resource_download_url_v1');
  throw new Error('resolve_resource_download_url_v1 requires a live backend download service');
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

interface SyntheticRunStep {
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

const _runStepCache = new Map<string, SyntheticRunStep[]>();

function _materializeRunSteps(runId: string): SyntheticRunStep[] {
  const cached = _runStepCache.get(runId);
  if (cached) return cached;
  // Try seed first (deterministic for known runs)
  const seedSteps = (seed.workflow_run_steps as Record<string, unknown[]> | undefined)?.[runId];
  if (Array.isArray(seedSteps)) {
    const list = seedSteps.map((s, i) => {
      const r = s as Record<string, unknown>;
      const enq = (r.started_at as string) ?? new Date().toISOString();
      return {
        id: (r.id as string) ?? `wfs_${runId}_${i}`,
        step_id: (r.step_id as string) ?? `st_${i + 1}`,
        label: (r.label as string) ?? `Step ${i + 1}`,
        status: ((r.status as SyntheticRunStep['status']) ?? 'succeeded'),
        duration_ms: (r.duration_ms as number | null | undefined) ?? null,
        enqueued_at: enq,
        operation_started_at: enq,
        ...((r.duration_ms as number | undefined) != null
          ? { operation_completed_at: new Date(new Date(enq).getTime() + (r.duration_ms as number)).toISOString() }
          : {}),
        operation_result: (r.operation_result as Record<string, unknown> | undefined) ?? null,
        last_error: (r.error as string | undefined) ?? null,
        retry_attempt: (r.retry_attempt as number | undefined) ?? 1,
      } satisfies SyntheticRunStep;
    });
    _runStepCache.set(runId, list);
    return list;
  }
  // Fallback: derive from run + template steps (live behavior parity for newly-started runs)
  const run = (seed.workflow_runs as Record<string, unknown>[] | undefined)?.find(
    (r) => (r as Record<string, unknown>).id === runId,
  ) as Record<string, unknown> | undefined;
  const template = run
    ? (seed.workflow_templates as Record<string, unknown>[] | undefined)?.find(
        (t) => (t as Record<string, unknown>).id === run.template_id,
      )
    : undefined;
  const tplSteps = (template as { steps?: Record<string, unknown>[] } | undefined)?.steps ?? [];
  const main = tplSteps.filter(
    (s) => (s as Record<string, unknown>).branch !== 'error' && (s as Record<string, unknown>).branch !== 'manual',
  );
  const status = (run?.status as string) ?? 'succeeded';
  const startedAt = (run?.started_at as string) ?? new Date().toISOString();
  const out = main.map((s, i) => {
    const r = s as Record<string, unknown>;
    let stepStatus: SyntheticRunStep['status'] = 'succeeded';
    let dur: number | null = 80 + i * 60;
    let err: string | null = null;
    if (status === 'running') {
      if (i === 0) { stepStatus = 'succeeded'; dur = 80; }
      else if (i === 1) { stepStatus = 'running'; dur = null; }
      else { stepStatus = 'pending'; dur = null; }
    } else if (status === 'failed' && i === main.length - 1) {
      stepStatus = 'failed'; dur = 220;
      err = (run?.error as string) ?? 'workflow_handlers.run failed';
    } else if (status === 'failed' && i > main.length - 1) {
      stepStatus = 'skipped'; dur = null;
    }
    const enq = new Date(new Date(startedAt).getTime() + i * 80).toISOString();
    return {
      id: `wfs_${runId}_${i}`,
      step_id: (r.id as string) ?? `st_${i + 1}`,
      label: (r.label as string) ?? `Step ${i + 1}`,
      kind: (r.kind as string) ?? 'action',
      status: stepStatus,
      duration_ms: dur,
      enqueued_at: enq,
      ...(dur != null ? { operation_started_at: enq, operation_completed_at: new Date(new Date(enq).getTime() + dur).toISOString() } : { operation_started_at: enq }),
      operation_result: stepStatus === 'failed' ? { ok: false, error: err } : { ok: true },
      last_error: err,
      retry_attempt: 1,
      decision_log_id: `dlog_run_${runId}_${i}`,
    } satisfies SyntheticRunStep;
  });
  _runStepCache.set(runId, out);
  return out;
}

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
  const liveTemplateId = looksLikeUuid(templateId) ? templateId : (await loadLiveWorkflowTemplateId(templateId)) ?? templateId;
  const live = await liveRpc<Record<string, unknown>>('ui_start_workflow_run_v1', {
    p_workflow_template_id: liveTemplateId,
    p_payload: context,
    p_require_active: context.ui?.allow_inactive ? false : true,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_start_workflow_run_v1', [
      'workflow_run_id',
    ]);
    const runId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'ui_start_workflow_run_v1 did not return workflow_run_id',
    );
    await requireLiveResourceReadback('workflow_runs', runId, 'ui_start_workflow_run_v1');
    await requireLiveResourceListReadback('workflow_run_steps', { workflow_run_id: runId }, 'ui_start_workflow_run_v1');
    const startedAt = String(rec.started_at ?? new Date().toISOString());
    return {
      ok: true,
      workflow_run_id: runId,
      workflow_template_id: String(rec.workflow_template_id ?? liveTemplateId),
      workflow_status: (rec.workflow_status as 'pending' | 'running' | undefined) ?? 'running',
      dry_run: Boolean(context.ui?.dry_run ?? rec.dry_run),
      idempotency_key: String(rec.idempotency_key ?? ''),
      correlation_id: String(rec.correlation_id ?? ''),
      started_at: startedAt,
      canonical_entrypoint: 'progress_workflow_run',
    };
  }

  await sleep(120);
  const dry = !!context.ui?.dry_run;
  const runId = (context.ui?.replay_of ? `wfr_replay_${Date.now()}` : `wfr_${Date.now()}`);
  const correlationId = `cor_${Math.random().toString(36).slice(2, 8)}`;
  const idem = `idem_${templateId}_${Math.random().toString(36).slice(2, 6)}`;
  // Materialize step trace eagerly so progress_workflow_run can return it.
  // W34c — accept either the FE seed `id` or the canonical_uuid so callers
  // routed through `resolve_workflow_template_id_v1(template_key)` stay
  // stable across demo/live mode without a translation layer.
  const t = (seed.workflow_templates as Record<string, unknown>[] | undefined)?.find(
    (x) =>
      (x as Record<string, unknown>).id === templateId ||
      (x as Record<string, unknown>).canonical_uuid === templateId,
  );
  const tplSteps = (t as { steps?: Record<string, unknown>[] } | undefined)?.steps ?? [];
  const main = tplSteps.filter(
    (s) => (s as Record<string, unknown>).branch !== 'error' && (s as Record<string, unknown>).branch !== 'manual',
  );
  const startedAt = new Date().toISOString();
  const trace: SyntheticRunStep[] = main.map((s, i) => {
    const r = s as Record<string, unknown>;
    const dur = 60 + i * 40 + Math.floor(Math.random() * 80);
    const enq = new Date(new Date(startedAt).getTime() + i * 30).toISOString();
    return {
      id: `wfs_${runId}_${i}`,
      step_id: (r.id as string) ?? `st_${i + 1}`,
      label: (r.label as string) ?? `Step ${i + 1}`,
      kind: (r.kind as string) ?? 'action',
      status: 'succeeded',
      duration_ms: dur,
      enqueued_at: enq,
      operation_started_at: enq,
      operation_completed_at: new Date(new Date(enq).getTime() + dur).toISOString(),
      operation_result: { ok: true, dry_run: dry },
      last_error: null,
      retry_attempt: 1,
      decision_log_id: `dlog_${runId}_${i}`,
    };
  });
  _runStepCache.set(runId, trace);
  return {
    ok: true,
    workflow_run_id: runId,
    workflow_template_id: templateId,
    workflow_status: dry ? 'pending' : 'running',
    dry_run: dry,
    idempotency_key: idem,
    correlation_id: correlationId,
    started_at: startedAt,
    canonical_entrypoint: 'progress_workflow_run',
  };
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
  const livePayload =
    payload && typeof payload === 'object'
      ? { ...(payload as Record<string, unknown>), ...(action ? { action } : {}) }
      : { input: payload ?? {}, ...(action ? { action } : {}) };
  const live = await liveRpc<Record<string, unknown>>('progress_workflow_run', {
    p_workflow_run_id: runId,
    p_input: livePayload,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'progress_workflow_run', [
      'workflow_run_id',
      'workflow_status',
      'status',
    ]);
    const workflowStatus = String(rec.workflow_status ?? rec.status ?? '').toLowerCase();
    const errorMessage = asNonEmptyString(rec.error);
    const message = asNonEmptyString(rec.message);
    const isBenignOpenStatus = workflowStatus === 'in_progress' || workflowStatus === 'pending';
    if (workflowStatus === 'failed' || errorMessage || (message && !isBenignOpenStatus)) {
      throw new Error(errorMessage || 'progress_workflow_run returned failed status');
    }
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'progress_workflow_run did not return workflow_run_id',
    );
    const stepsResult = await ui_list_resource_v1<SyntheticRunStep>('workflow_run_steps', {
      filter: { workflow_run_id: runId },
      sort: { key: 'enqueued_at', dir: 'asc' },
    }).catch(() => ({ rows: [] as SyntheticRunStep[], total: 0 }));
    const steps = stepsResult.rows;
    return {
      ok: true,
      workflow_run_id: workflowRunId,
      workflow_status: (rec.workflow_status as 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused' | undefined) ??
        (action === 'pause' ? 'paused' : 'completed'),
      duration_ms: Number(rec.duration_ms ?? steps.reduce((acc, step) => acc + (step.duration_ms ?? 0), 0)),
      steps,
      ...(payload !== undefined ? { payload } : {}),
      ...(action !== undefined ? { action } : {}),
      ...rec,
    } as {
      ok: true;
      workflow_run_id: string;
      workflow_status: 'completed' | 'failed' | 'paused';
      duration_ms: number;
      steps: SyntheticRunStep[];
      payload?: unknown;
      action?: typeof action;
    };
  }

  await sleep(180);
  const steps = _materializeRunSteps(runId);
  const total = steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
  const failed = steps.find((s) => s.status === 'failed');
  return {
    ok: true,
    workflow_run_id: runId,
    workflow_status: action === 'pause' ? 'paused' : failed ? 'failed' : 'completed',
    duration_ms: total,
    steps,
    ...(payload !== undefined ? { payload } : {}),
    ...(action !== undefined ? { action } : {}),
  };
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
  const livePayload = payload && typeof payload === 'object'
    ? { ...(payload as Record<string, unknown>) }
    : { input: payload ?? {} };
  const live = await liveRpc<Record<string, unknown>>('progress_workflow_run_until_wait_v1', {
    p_workflow_run_id: runId,
    p_operation_result: livePayload,
    p_budget_ms: opts.budget_ms ?? 5000,
    p_max_steps: opts.max_steps ?? 8,
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'progress_workflow_run_until_wait_v1', [
      'workflow_run_id',
      'workflow_status',
      'status',
    ]);
    const workflowStatus = String(rec.workflow_status ?? rec.status ?? '').toLowerCase();
    const errorMessage = asNonEmptyString(rec.error);
    const message = asNonEmptyString(rec.message);
    const isBenignOpenStatus = workflowStatus === 'in_progress' || workflowStatus === 'pending' || workflowStatus === 'waiting';
    if (workflowStatus === 'failed' || errorMessage || (message && !isBenignOpenStatus)) {
      throw new Error(errorMessage || 'progress_workflow_run_until_wait_v1 returned failed status');
    }
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'progress_workflow_run_until_wait_v1 did not return workflow_run_id',
    );
    const stepsResult = await ui_list_resource_v1<SyntheticRunStep>('workflow_run_steps', {
      filter: { workflow_run_id: runId },
      sort: { key: 'enqueued_at', dir: 'asc' },
    }).catch(() => ({ rows: [] as SyntheticRunStep[], total: 0 }));
    const steps = stepsResult.rows;
    return {
      ok: true,
      workflow_run_id: workflowRunId,
      workflow_status: (rec.workflow_status as 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused' | undefined) ?? 'in_progress',
      duration_ms: Number(rec.duration_ms ?? steps.reduce((acc, step) => acc + (step.duration_ms ?? 0), 0)),
      steps,
      ...(payload !== undefined ? { payload } : {}),
      ...rec,
    } as {
      ok: true;
      workflow_run_id: string;
      workflow_status: 'completed' | 'failed' | 'in_progress' | 'pending' | 'paused';
      duration_ms: number;
      steps: SyntheticRunStep[];
      payload?: unknown;
    };
  }

  return progress_workflow_run(runId, payload);
}

export async function progress_workflow_run_base(
  runId: string,
  payload?: unknown,
): Promise<{ ok: true; workflow_run_id: string; payload?: unknown }> {
  const live = await liveRpc<Record<string, unknown>>('progress_workflow_run', {
    p_workflow_run_id: runId,
    p_input: payload ?? {},
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'progress_workflow_run', [
      'workflow_run_id',
      'workflow_status',
      'status',
    ]);
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id', 'id'],
      'progress_workflow_run did not return workflow_run_id',
    );
    return {
      ...rec,
      ok: true,
      workflow_run_id: workflowRunId,
      ...(payload !== undefined ? { payload } : {}),
    } as { ok: true; workflow_run_id: string; payload?: unknown };
  }

  await sleep(60);
  return {
    ok: true,
    workflow_run_id: runId,
    ...(payload !== undefined ? { payload } : {}),
  };
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
  const live = await liveRpc<null>('close_workflow_run', {
    p_workflow_run_id: runId,
    p_status: status,
  });
  if (live) {
    const run = await requireLiveResourceReadback('workflow_runs', runId, 'close_workflow_run');
    await requireLiveResourceListReadback('workflow_run_steps', { workflow_run_id: runId }, 'close_workflow_run');
    const readbackStatus = asNonEmptyString(run.workflow_status) ?? asNonEmptyString(run.status);
    if (readbackStatus && readbackStatus !== status) {
      throw new Error('close_workflow_run backend readback status mismatch');
    }
    return {
      ok: true,
      workflow_run_id: runId,
      workflow_status: status,
      closed_at: String(run.completed_at ?? run.closed_at ?? new Date().toISOString()),
    };
  }

  await sleep(80);
  return { ok: true, workflow_run_id: runId, workflow_status: status, closed_at: new Date().toISOString() };
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
  const live = await liveRpc<Record<string, unknown>>('ui_get_trace_v2', {
    p_args: { correlation_id: correlationId },
  });
  if (live) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `ui_get_trace_v2` (migration 202605020200_w44_rpc_v2_normalizations.sql).
    // Envelope: { ok, trace: { correlation_id, observability_events,
    // domain_events, workflow_runs } }. The exported adapter signature is
    // unchanged (still takes a string correlationId).
    const envelope = requireLiveRpcRecord(live.data, 'ui_get_trace_v2 returned no backend trace outcome');
    const outcomeError = backendOutcomeError(envelope, 'ui_get_trace_v2 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const env = objectRecord(envelope.trace);
    if (Object.keys(env).length === 0) {
      throw new Error('ui_get_trace_v2 did not return backend trace evidence');
    }
    const liveCorrelationId = asNonEmptyString(env.correlation_id) ?? asNonEmptyString(envelope.correlation_id);
    if (!liveCorrelationId) {
      throw new Error('ui_get_trace_v2 did not return backend correlation evidence');
    }
    return {
      correlation_id: liveCorrelationId,
      observability_events: (env.observability_events as Array<Record<string, unknown>>) ?? [],
      domain_events: (env.domain_events as Array<Record<string, unknown>>) ?? [],
      workflow_runs: (env.workflow_runs as Array<Record<string, unknown>>) ?? [],
    };
  }

  await sleep(60);
  // Demo synth — derive a small representative 3-section payload anchored on
  // the supplied correlation_id so the FE has stable rows to render.
  const baseTime = Date.now() - 30 * 1000;
  const observability_events = [
    {
      event_id: `oev_${correlationId}_1`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'api_call_log',
      event_type: 'webhook.receive',
      resource_type: 'webhook_inbox',
      resource_id: `wbi_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      status: 'succeeded',
      event_time: new Date(baseTime).toISOString(),
      metadata: { method: 'POST', url: '/v1/webhook', response_status: 202, duration_ms: 28 },
    },
    {
      event_id: `oev_${correlationId}_2`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'decision_log',
      event_type: 'workflow_dispatch',
      resource_type: 'workflow_run',
      resource_id: `wr_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      status: 'started',
      event_time: new Date(baseTime + 12).toISOString(),
      metadata: { decision_point: 'workflow.start_workflow_run', performed_by: 'orchestrator', duration_ms: 14 },
    },
    {
      event_id: `oev_${correlationId}_3`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'decision_log',
      event_type: 'mapping_apply',
      resource_type: 'mapping_config',
      resource_id: `mp_exampleparcel_ksa_v3`,
      correlation_id: correlationId,
      status: 'succeeded',
      event_time: new Date(baseTime + 18).toISOString(),
      metadata: { decision_point: 'mapping.apply', performed_by: 'mapping-engine', duration_ms: 6 },
    },
    {
      event_id: `oev_${correlationId}_4`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'decision_log',
      event_type: 'shipments_create',
      resource_type: 'shipment',
      resource_id: `shp_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      status: 'succeeded',
      event_time: new Date(baseTime + 22).toISOString(),
      metadata: { decision_point: 'shipments.create', performed_by: 'shipments-service', duration_ms: 4 },
    },
  ];
  const domain_events = [
    {
      id: `de_${correlationId}_1`,
      organization_id: state.user.organization_id ?? null,
      event_type: 'shipment.created',
      resource_type: 'shipment',
      resource_id: `shp_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      payload: { tracking_number: 'TR-DEMO-1' },
      created_at: new Date(baseTime + 24).toISOString(),
    },
  ];
  // W27-cycle-D §1 — workflow_runs.status canonical SSOT is the
  // workflow_run_status enum (pending|running|succeeded|failed|timeout|
  // cancelled). The legacy FE-projection alias `'completed'` is retired here;
  // emit the canonical `'succeeded'` value so insights/traces (and any other
  // consumer driven by the workflow_run_status lookup) renders the correct
  // tone without inline equality branches.
  const workflow_runs = [
    {
      id: `wr_${correlationId.slice(0, 6)}`,
      organization_id: state.user.organization_id ?? null,
      workflow_template_id: 'wt_exampleparcel_ksa_v3',
      status: 'succeeded',
      triggered_by_request_id: correlationId,
      created_at: new Date(baseTime + 12).toISOString(),
      completed_at: new Date(baseTime + 28).toISOString(),
    },
  ];
  return {
    correlation_id: correlationId,
    observability_events,
    domain_events,
    workflow_runs,
  };
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

function nextCorrelationIdHex(): string {
  // Mirrors `encode(gen_random_bytes(8), 'hex')` shape (16 hex chars).
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export async function client_suspend_v1(args: {
  client_id: string;
  organization_id?: string;
  reason?: string;
}): Promise<ClientLifecycleResult> {
  const live = await livePArgsMutationResult('client_suspend_v1', args, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientLifecycleResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_suspend_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_suspend_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(80);
  if (!args?.client_id) throw new Error('client_suspend_v1 requires client_id');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = clients.find((r) => r.id === args.client_id);
  if (!row) throw new Error(`client_suspend_v1 client ${args.client_id} not found`);
  const wasSuspended = row.status === 'suspended';
  if (!wasSuspended) {
    row.status = 'suspended';
    row.suspension_reason = args.reason ?? null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    client_id: args.client_id,
    idempotent_no_op: wasSuspended,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function client_reactivate_v1(args: {
  client_id: string;
  organization_id?: string;
}): Promise<ClientLifecycleResult> {
  const live = await livePArgsMutationResult('client_reactivate_v1', args, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientLifecycleResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_reactivate_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_reactivate_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(80);
  if (!args?.client_id) throw new Error('client_reactivate_v1 requires client_id');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = clients.find((r) => r.id === args.client_id);
  if (!row) throw new Error(`client_reactivate_v1 client ${args.client_id} not found`);
  const wasActive = row.status === 'active';
  if (!wasActive) {
    row.status = 'active';
    row.suspension_reason = null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    client_id: args.client_id,
    idempotent_no_op: wasActive,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_suspend_v1(args: {
  sender_id: string;
  reason?: string;
}): Promise<SenderLifecycleResult> {
  const live = await livePArgsMutationResult('sender_suspend_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderLifecycleResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_suspend_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_suspend_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(80);
  if (!args?.sender_id) throw new Error('sender_suspend_v1 requires sender_id');
  const senders = (seed.senders ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = senders.find((r) => r.id === args.sender_id);
  if (!row) throw new Error(`sender_suspend_v1 sender ${args.sender_id} not found`);
  const wasInactive = row.status === 'inactive';
  if (!wasInactive) {
    row.status = 'inactive';
    row.suspension_reason = args.reason ?? null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    sender_id: args.sender_id,
    idempotent_no_op: wasInactive,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_reactivate_v1(args: {
  sender_id: string;
}): Promise<SenderLifecycleResult> {
  const live = await livePArgsMutationResult('sender_reactivate_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderLifecycleResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_reactivate_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_reactivate_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(80);
  if (!args?.sender_id) throw new Error('sender_reactivate_v1 requires sender_id');
  const senders = (seed.senders ?? []) as Array<Record<string, unknown> & { id: string; status: string; suspension_reason?: string | null }>;
  const row = senders.find((r) => r.id === args.sender_id);
  if (!row) throw new Error(`sender_reactivate_v1 sender ${args.sender_id} not found`);
  const wasActive = row.status === 'active';
  if (!wasActive) {
    row.status = 'active';
    row.suspension_reason = null;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    sender_id: args.sender_id,
    idempotent_no_op: wasActive,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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

async function requireLiveCustomerLifecycleReadback(
  rpcName: string,
  resourceKey: string,
  projectionKey: string,
  resourceId: string,
): Promise<void> {
  await requireLiveResourceReadback(resourceKey, resourceId, rpcName);
  await requireLiveResourceReadback(projectionKey, resourceId, rpcName);
}

async function requireLiveCustomerDeletionReadback(
  rpcName: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  if (resourceType === 'recipient') {
    await requireLiveResourceAbsenceReadback('recipients', { id: resourceId }, rpcName, `recipients:${resourceId}`);
    await requireLiveResourceAbsenceReadback(
      'recipient_directory',
      { recipient_id: resourceId },
      rpcName,
      `recipient_directory:${resourceId}`,
    );
  }
  await requireLiveResourceListReadback('decision_log', { resource_type: resourceType, resource_id: resourceId }, rpcName);
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
  const live = await livePArgsMutationResult('client_create_v1', args, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientCreateResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_create_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_create_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(120);
  if (!args?.name) throw new Error('client_create_v1 requires name');
  if (!args?.slug) throw new Error('client_create_v1 requires slug');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown>>;
  if (clients.some((r) => (r as { slug?: string }).slug === args.slug)) {
    throw new Error(`client_create_v1 slug "${args.slug}" already taken`);
  }
  const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
  const id = 'cl_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  // In-memory branch: derive organization_id from the explicit arg or the
  // active tenant scope. No hardcoded tenant fallback (live RPC enforces
  // organization scoping via `auth.jwt()` claims; in-memory must mirror by
  // requiring an explicit value or active scope — never bake a tenant id into
  // source).
  const inMemoryOrgId = args.organization_id ?? scopeCtx.tenant?.id;
  if (!inMemoryOrgId) {
    throw new Error(
      'client_create_v1 (in-memory): organization_id is required when no tenant scope is active',
    );
  }
  clients.unshift({
    id,
    organization_id: inMemoryOrgId,
    name: args.name,
    slug: args.slug,
    sla_tier: args.sla_tier ?? 'standard',
    status: 'active',
    account_manager_id: args.account_manager_id ?? null,
    contract_start_date: args.contract_start_date ?? null,
    contract_end_date: args.contract_end_date ?? null,
    suspension_reason: null,
    settings_override: args.settings_override ?? null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    client_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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
  const patch = (args.patch ?? {}) as Record<string, unknown>;
  const normalizedArgs = { ...args, ...patch };
  delete (normalizedArgs as Record<string, unknown>).patch;
  const live = await livePArgsMutationResult('client_update_v1', normalizedArgs, ['client_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<ClientUpdateResult>(
      live,
      ['client_id', 'id'],
      'client_id',
      'client_update_v1 did not return client_id',
    );
    await requireLiveCustomerLifecycleReadback('client_update_v1', 'clients', 'client_summary', result.client_id);
    return result;
  }
  await sleep(100);
  if (!args?.client_id) throw new Error('client_update_v1 requires client_id');
  if ((normalizedArgs as Record<string, unknown>).status !== undefined) {
    throw new Error('client_update_v1 cannot mutate status — use client_suspend_v1 / client_reactivate_v1');
  }
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = clients.find((r) => r.id === args.client_id);
  if (!row) throw new Error(`client_update_v1 client ${args.client_id} not found`);
  let no_op = true;
  if (normalizedArgs.name !== undefined) { row.name = normalizedArgs.name; no_op = false; }
  if (normalizedArgs.sla_tier !== undefined) { row.sla_tier = normalizedArgs.sla_tier; no_op = false; }
  if (normalizedArgs.account_manager_id !== undefined) { row.account_manager_id = normalizedArgs.account_manager_id; no_op = false; }
  if (normalizedArgs.contract_start_date !== undefined) { row.contract_start_date = normalizedArgs.contract_start_date; no_op = false; }
  if (normalizedArgs.contract_end_date !== undefined) { row.contract_end_date = normalizedArgs.contract_end_date; no_op = false; }
  if (normalizedArgs.billing_settings !== undefined) { row.billing_settings = normalizedArgs.billing_settings; no_op = false; }
  if (normalizedArgs.settings_override !== undefined) { row.settings_override = normalizedArgs.settings_override; no_op = false; }
  if (!no_op) row.updated_at = new Date().toISOString();
  return {
    ok: true,
    client_id: args.client_id,
    idempotent_no_op: no_op,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_create_v1(args: {
  client_id: string;
  name: string;
  brand_name?: string;
  auto_recreate?: boolean;
  settings_override?: Record<string, unknown> | null;
}): Promise<SenderCreateResult> {
  const live = await livePArgsMutationResult('sender_create_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderCreateResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_create_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_create_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(120);
  if (!args?.client_id) throw new Error('sender_create_v1 requires client_id');
  if (!args?.name) throw new Error('sender_create_v1 requires name');
  const senders = (seed.senders ?? []) as Array<Record<string, unknown>>;
  const id = 'snd_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  senders.unshift({
    id,
    client_id: args.client_id,
    name: args.name,
    brand_name: args.brand_name ?? null,
    auto_provisioned: false,
    auto_recreate: args.auto_recreate ?? true,
    status: 'active',
    suspension_reason: null,
    settings_override: args.settings_override ?? null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    sender_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function sender_update_v1(args: {
  sender_id: string;
  name?: string;
  brand_name?: string | null;
  auto_recreate?: boolean;
  warehouse_address_id?: string | null;
  settings_override?: Record<string, unknown> | null;
}): Promise<SenderUpdateResult> {
  const live = await livePArgsMutationResult('sender_update_v1', args, ['sender_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<SenderUpdateResult>(
      live,
      ['sender_id', 'id'],
      'sender_id',
      'sender_update_v1 did not return sender_id',
    );
    await requireLiveCustomerLifecycleReadback('sender_update_v1', 'senders', 'sender_summary', result.sender_id);
    return result;
  }
  await sleep(100);
  if (!args?.sender_id) throw new Error('sender_update_v1 requires sender_id');
  if ((args as Record<string, unknown>).status !== undefined) {
    throw new Error('sender_update_v1 cannot mutate status — use sender_suspend_v1 / sender_reactivate_v1');
  }
  const senders = (seed.senders ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = senders.find((r) => r.id === args.sender_id);
  if (!row) throw new Error(`sender_update_v1 sender ${args.sender_id} not found`);
  let no_op = true;
  if (args.name !== undefined) { row.name = args.name; no_op = false; }
  if (args.brand_name !== undefined) { row.brand_name = args.brand_name; no_op = false; }
  if (args.auto_recreate !== undefined) { row.auto_recreate = args.auto_recreate; no_op = false; }
  if (args.warehouse_address_id !== undefined) { row.warehouse_address_id = args.warehouse_address_id; no_op = false; }
  if (args.settings_override !== undefined) { row.settings_override = args.settings_override; no_op = false; }
  if (!no_op) row.updated_at = new Date().toISOString();
  return {
    ok: true,
    sender_id: args.sender_id,
    idempotent_no_op: no_op,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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
  const live = await livePArgsMutationResult('recipient_create_v1', args, ['recipient_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RecipientCreateResult>(
      live,
      ['recipient_id', 'id'],
      'recipient_id',
      'recipient_create_v1 did not return recipient_id',
    );
    await requireLiveCustomerLifecycleReadback('recipient_create_v1', 'recipients', 'recipient_directory', result.recipient_id);
    return result;
  }
  await sleep(120);
  if (!args?.client_id) throw new Error('recipient_create_v1 requires client_id');
  if (!args?.name) throw new Error('recipient_create_v1 requires name');
  if (!args?.phone_number) throw new Error('recipient_create_v1 requires phone_number');
  const clients = (seed.clients ?? []) as Array<Record<string, unknown> & { id: string; organization_id?: string }>;
  const clientRow = clients.find((r) => r.id === args.client_id);
  if (!clientRow) throw new Error(`recipient_create_v1 client ${args.client_id} not found`);
  const recipients = (seed.recipients ?? []) as Array<Record<string, unknown>>;
  const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
  const id = 'rcp_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  const orgId = args.organization_id ?? clientRow.organization_id ?? scopeCtx.tenant?.id;
  const defaultLanguage = getLookups('preferred_language').find((r) => r.is_default)?.value;
  if (!orgId) {
    throw new Error(
      'recipient_create_v1 (in-memory): organization_id is required when client row has no organization and no tenant scope is active',
    );
  }
  if (!args.preferred_language && !defaultLanguage) {
    throw new Error('recipient_create_v1 (in-memory): preferred_language default lookup is required');
  }
  recipients.unshift({
    id,
    organization_id: orgId,
    client_id: args.client_id,
    external_id: args.external_id ?? null,
    name: args.name,
    phone_number: args.phone_number,
    phone_validation_status: 'pending',
    phone_validated_at: null,
    email: args.email ?? null,
    preferred_language: args.preferred_language ?? defaultLanguage,
    preferred_comm_channel: args.preferred_comm_channel ?? null,
    quiet_hours_start: args.quiet_hours_start ?? null,
    quiet_hours_end: args.quiet_hours_end ?? null,
    communication_preferences: args.communication_preferences ?? null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    recipient_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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
  const live = await livePArgsMutationResult('recipient_update_v1', args, ['recipient_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RecipientUpdateResult>(
      live,
      ['recipient_id', 'id'],
      'recipient_id',
      'recipient_update_v1 did not return recipient_id',
    );
    await requireLiveCustomerLifecycleReadback('recipient_update_v1', 'recipients', 'recipient_directory', result.recipient_id);
    return result;
  }
  await sleep(100);
  if (!args?.recipient_id) throw new Error('recipient_update_v1 requires recipient_id');
  const recipients = (seed.recipients ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = recipients.find((r) => r.id === args.recipient_id);
  if (!row) throw new Error(`recipient_update_v1 recipient ${args.recipient_id} not found`);
  let no_op = true;
  if (args.name !== undefined) { row.name = args.name; no_op = false; }
  if (args.phone_number !== undefined) {
    row.phone_number = args.phone_number;
    row.phone_validation_status = 'pending';
    row.phone_validated_at = null;
    no_op = false;
  }
  if (args.email !== undefined) { row.email = args.email; no_op = false; }
  if (args.external_id !== undefined) { row.external_id = args.external_id; no_op = false; }
  if (args.preferred_language !== undefined) { row.preferred_language = args.preferred_language; no_op = false; }
  if (args.preferred_comm_channel !== undefined) { row.preferred_comm_channel = args.preferred_comm_channel; no_op = false; }
  if (args.quiet_hours_start !== undefined) { row.quiet_hours_start = args.quiet_hours_start; no_op = false; }
  if (args.quiet_hours_end !== undefined) { row.quiet_hours_end = args.quiet_hours_end; no_op = false; }
  if (args.communication_preferences !== undefined) { row.communication_preferences = args.communication_preferences; no_op = false; }
  if (!no_op) row.updated_at = new Date().toISOString();
  return {
    ok: true,
    recipient_id: args.recipient_id,
    idempotent_no_op: no_op,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function recipient_delete_v1(args: {
  recipient_id: string;
  reason?: string;
}): Promise<RecipientDeleteResult> {
  const live = await livePArgsMutationResult('recipient_delete_v1', args, ['recipient_id', 'id', 'deleted']);
  if (live) {
    const result = withRequiredLiveStringField<RecipientDeleteResult>(
      live,
      ['recipient_id', 'id'],
      'recipient_id',
      'recipient_delete_v1 did not return recipient_id',
    );
    await requireLiveCustomerDeletionReadback('recipient_delete_v1', 'recipient', result.recipient_id);
    return result;
  }
  await sleep(100);
  if (!args?.recipient_id) throw new Error('recipient_delete_v1 requires recipient_id');
  const recipients = (seed.recipients ?? []) as Array<Record<string, unknown> & { id: string }>;
  const index = recipients.findIndex((r) => r.id === args.recipient_id);
  if (index < 0) throw new Error(`recipient_delete_v1 recipient ${args.recipient_id} not found`);
  const shipments = (seed.shipments ?? []) as Array<Record<string, unknown> & { recipient_id?: string | null }>;
  const shipmentReferenceCount = shipments.filter((s) => s.recipient_id === args.recipient_id).length;
  recipients.splice(index, 1);
  for (const shipment of shipments) {
    if (shipment.recipient_id === args.recipient_id) shipment.recipient_id = null;
  }
  return {
    ok: true,
    recipient_id: args.recipient_id,
    deleted: true,
    shipment_reference_count: shipmentReferenceCount,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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
  const live = await livePArgsMutationResult('service_offering_create_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_create_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_level_id) throw new Error('service_offering_create_v1 requires service_level_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown>>;
  const id = 'sof_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  offerings.unshift({
    id,
    service_level_id: args.service_level_id,
    branch_id: args.branch_id ?? null,
    zone_id: args.zone_id ?? null,
    priority: Math.max(args.priority ?? 0, 0),
    is_active: true,
    metadata: args.metadata ?? {},
    effective_from: now,
    effective_to: null,
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    service_offering_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_offering_update_v1(args: {
  service_offering_id: string;
  zone_id?: string | null;
  priority?: number;
  effective_from?: string;
  effective_to?: string | null;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<ServiceOfferingMutationResult> {
  const live = await livePArgsMutationResult('service_offering_update_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_update_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_offering_id) throw new Error('service_offering_update_v1 requires service_offering_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = offerings.find((r) => r.id === args.service_offering_id);
  if (!row) throw new Error(`service_offering_update_v1 service_offering ${args.service_offering_id} not found`);
  if (args.zone_id !== undefined) row.zone_id = args.zone_id;
  if (args.priority !== undefined) row.priority = args.priority;
  if (args.effective_from !== undefined) row.effective_from = args.effective_from;
  if (args.effective_to !== undefined) row.effective_to = args.effective_to;
  if (args.is_active !== undefined) row.is_active = args.is_active;
  if (args.metadata !== undefined) {
    row.metadata = { ...((row.metadata as Record<string, unknown> | undefined) ?? {}), ...args.metadata };
  }
  row.updated_at = new Date().toISOString();
  return {
    ok: true,
    service_offering_id: args.service_offering_id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_offering_archive_v1(args: {
  service_offering_id: string;
  reason?: string;
}): Promise<ServiceOfferingMutationResult> {
  const live = await livePArgsMutationResult('service_offering_archive_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_archive_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_offering_id) throw new Error('service_offering_archive_v1 requires service_offering_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown> & { id: string; is_active: boolean; metadata?: Record<string, unknown> }>;
  const row = offerings.find((r) => r.id === args.service_offering_id);
  if (!row) throw new Error(`service_offering_archive_v1 service_offering ${args.service_offering_id} not found`);
  const wasArchived = row.is_active === false;
  if (!wasArchived) {
    row.is_active = false;
    row.metadata = { ...(row.metadata ?? {}), retired_reason: args.reason ?? null };
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    service_offering_id: args.service_offering_id,
    idempotent_no_op: wasArchived,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_offering_toggle_v1(args: {
  service_offering_id: string;
  is_active?: boolean;
}): Promise<ServiceOfferingMutationResult> {
  const live = await livePArgsMutationResult('service_offering_toggle_v1', args, ['service_offering_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceOfferingMutationResult>(
      live,
      ['service_offering_id', 'id'],
      'service_offering_id',
      'service_offering_toggle_v1 did not return service_offering_id',
    );
  }
  await sleep(120);
  if (!args?.service_offering_id) throw new Error('service_offering_toggle_v1 requires service_offering_id');
  const offerings = (seed.service_offerings ?? []) as Array<Record<string, unknown> & { id: string; is_active: boolean }>;
  const row = offerings.find((r) => r.id === args.service_offering_id);
  if (!row) throw new Error(`service_offering_toggle_v1 service_offering ${args.service_offering_id} not found`);
  const target = args.is_active !== undefined ? args.is_active : !row.is_active;
  const idempotent = row.is_active === target;
  if (!idempotent) {
    row.is_active = target;
    (row as Record<string, unknown>).updated_at = new Date().toISOString();
  }
  return {
    ok: true,
    service_offering_id: args.service_offering_id,
    idempotent_no_op: idempotent,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_level_create_v1(args: {
  key: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  organization_id?: string;
}): Promise<ServiceLevelMutationResult> {
  const live = await livePArgsMutationResult('service_level_create_v1', args, ['service_level_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceLevelMutationResult>(
      live,
      ['service_level_id', 'id'],
      'service_level_id',
      'service_level_create_v1 did not return service_level_id',
    );
  }
  await sleep(120);
  if (!args?.key || !args?.name) throw new Error('service_level_create_v1 requires key and name');
  const levels = (seed.service_levels ?? []) as Array<Record<string, unknown>>;
  const id = 'svl_new_' + Math.floor(Math.random() * 90000);
  const now = new Date().toISOString();
  const scopeCtx = state.scope as Record<string, { id?: string } | undefined>;
  levels.unshift({
    id,
    organization_id: args.organization_id ?? scopeCtx.tenant?.id ?? null,
    key: args.key.toLowerCase(),
    name: args.name,
    description: args.description ?? null,
    is_active: true,
    metadata: args.metadata ?? {},
    created_at: now,
    updated_at: now,
  });
  return {
    ok: true,
    service_level_id: id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function service_level_update_v1(args: {
  service_level_id: string;
  name?: string;
  description?: string;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<ServiceLevelMutationResult> {
  const live = await livePArgsMutationResult('service_level_update_v1', args, ['service_level_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<ServiceLevelMutationResult>(
      live,
      ['service_level_id', 'id'],
      'service_level_id',
      'service_level_update_v1 did not return service_level_id',
    );
  }
  await sleep(120);
  if (!args?.service_level_id) throw new Error('service_level_update_v1 requires service_level_id');
  const levels = (seed.service_levels ?? []) as Array<Record<string, unknown> & { id: string }>;
  const row = levels.find((r) => r.id === args.service_level_id);
  if (!row) throw new Error(`service_level_update_v1 service_level ${args.service_level_id} not found`);
  if (args.name !== undefined) row.name = args.name;
  if (args.description !== undefined) row.description = args.description;
  if (args.is_active !== undefined) row.is_active = args.is_active;
  if (args.metadata !== undefined) {
    row.metadata = { ...((row.metadata as Record<string, unknown> | undefined) ?? {}), ...args.metadata };
  }
  row.updated_at = new Date().toISOString();
  return {
    ok: true,
    service_level_id: args.service_level_id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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
  const live = await livePArgsMutationResult('lookup_definition_create_v1', args, ['lookup_definition_id', 'id']);
  if (live) {
    const rec = withRequiredLiveStringField<LookupDefinitionMutationResult>(
      live,
      ['lookup_definition_id', 'id'],
      'lookup_definition_id',
      'lookup_definition_create_v1 did not return lookup_definition_id',
    );
    const category = requireLiveStringField(
      live,
      ['category'],
      'lookup_definition_create_v1 did not return category',
    );
    return { ...rec, category } as LookupDefinitionMutationResult;
  }
  await sleep(120);
  if (!args?.category) throw new Error('lookup_definition_create_v1 requires category');
  const id = 'lkd_new_' + Math.floor(Math.random() * 90000);
  return {
    ok: true,
    lookup_definition_id: id,
    category: args.category.toLowerCase(),
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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
  const live = await livePArgsMutationResult('lookup_value_create_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_create_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.value || !args?.label) {
    throw new Error('lookup_value_create_v1 requires value and label');
  }
  const id = 'lkv_new_' + Math.floor(Math.random() * 90000);
  return {
    ok: true,
    lookup_value_id: id,
    status: args.status ?? 'draft',
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_value_update_v1(args: {
  lookup_value_id: string;
  label?: string;
  description?: string;
  sort_order?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<LookupValueMutationResult> {
  const live = await livePArgsMutationResult('lookup_value_update_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_update_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.lookup_value_id) throw new Error('lookup_value_update_v1 requires lookup_value_id');
  return {
    ok: true,
    lookup_value_id: args.lookup_value_id,
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_value_archive_v1(args: {
  lookup_value_id: string;
  reason?: string;
}): Promise<LookupValueMutationResult> {
  const live = await livePArgsMutationResult('lookup_value_archive_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_archive_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.lookup_value_id) throw new Error('lookup_value_archive_v1 requires lookup_value_id');
  return {
    ok: true,
    lookup_value_id: args.lookup_value_id,
    status: 'archived',
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function lookup_value_promote_v1(args: {
  lookup_value_id: string;
  effective_from?: string;
  effective_until?: string | null;
}): Promise<LookupValueMutationResult> {
  const live = await livePArgsMutationResult('lookup_value_promote_v1', args, ['lookup_value_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<LookupValueMutationResult>(
      live,
      ['lookup_value_id', 'id'],
      'lookup_value_id',
      'lookup_value_promote_v1 did not return lookup_value_id',
    );
  }
  await sleep(120);
  if (!args?.lookup_value_id) throw new Error('lookup_value_promote_v1 requires lookup_value_id');
  return {
    ok: true,
    lookup_value_id: args.lookup_value_id,
    status: 'active',
    correlation_id: nextCorrelationIdHex(),
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
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
function sleep(ms: number): Promise<void> {
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
function pickupRequestsSeed(): Record<string, unknown>[] {
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
function pickupWavesSeed(): Record<string, unknown>[] {
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
function pickupFailuresSeed(): Record<string, unknown>[] {
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
  ui_upsert_webhook_rule_v1, ui_delete_webhook_rule_v1, ui_reorder_webhook_rule_v1,
  ui_upsert_mapping_artifact_v1, ui_delete_mapping_config_v1, ui_upsert_api_gateway_route_mapping_v1, ui_create_mapping_operation_report_v1,
  mapping_config_promote_v1, ui_test_mapping_config_v1,
  ui_upsert_provider_auth_config_v1, ui_bind_provider_account_credential_v1,
  ui_revoke_provider_auth_config_v1, integration_plugin_rotate_credentials_v1,
  ui_execute_provider_circuit_reset_v1,
  ui_execute_provider_circuit_probe_v1,
  integration_plugin_generate_draft_v1, integration_plugin_rollback_v1, plugin_deactivate_v1,
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

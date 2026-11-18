// domain.ts — minimal canonical types. Mirrors backend SSOT shapes (api.ui_list_resource_v1).
// Add fields as modules need them; permissive `Record<string, unknown>` is the escape hatch.

export type Id = string;
export type IsoDate = string;

export interface Scope {
  global?: { id?: Id; label?: string; rank: 1 };
  tenant?: { id: Id; label?: string; rank: 2 };
  client?: { id: Id; label?: string; rank: 3 };
  sender?: { id: Id; label?: string; rank: 4 };
  source?: { id: Id; label?: string; rank: 5 };
  resource?: { id: Id; label?: string; rank: 6 };
}
export type ScopeType = keyof Scope;

/**
 * Access-scope type — mirrors `users.access_scope_type` defined in
 * `supabase/migrations/202512291310_users_access_scope_model.sql`. The four
 * tiers map 1:1 with the backend's RLS helpers (`current_user_scope_type()`,
 * `is_platform_user()`, `current_user_client_id()`, `current_user_sender_id()`).
 *
 * Invariant (mirrors `users_access_scope_consistency_check`):
 *   - `platform` / `tenant` MUST have `access_scope_id === null`
 *   - `client`   / `sender` MUST have `access_scope_id !== null`
 */
export type AccessScopeType = 'platform' | 'tenant' | 'client' | 'sender';

export interface User {
  id: Id;
  name: string;
  initials?: string;
  /**
   * User's primary email (mirrors `auth.users.email` / `users.email`). Optional
   * because pre-IDENTITY surfaces did not require it; the user-menu drawer
   * (E1) renders it when present and falls back gracefully when not.
   */
  email?: string;
  /** Console role key (one of the 5 canonical roles from access_control_policy_core). */
  role: string;
  capabilities: string[];
  /**
   * Mirrors `users.access_scope_type` (4-tier access model). Tier defines
   * which RLS helpers are authoritative for this user. See migration
   * `202512291310_users_access_scope_model.sql`.
   */
  access_scope_type: AccessScopeType;
  /**
   * Mirrors `users.access_scope_id`. NULL for platform/tenant; the bound
   * client_id / sender_id for client / sender scopes (enforced by the
   * `users_access_scope_consistency_check` constraint).
   */
  access_scope_id: Id | null;
  /**
   * The user's home organization (`users.organization_id`). For tenant/client/
   * sender users this also bounds RLS reads via `current_user_org_id()`. For
   * platform users this is the user's identity-home org but does NOT restrict
   * cross-tenant reads (`is_platform_user()` returns true).
   */
  organization_id: Id;
  /**
   * W35e-3 — mirrors `users.status` (canonical column). The `suspend_user_v1`
   * RPC sets this to `'suspended'`; `reactivate_user_v1` resets to `'active'`.
   * Values follow the `user_status` lookup catalog (active|suspended|...).
   * AppGuard treats `'suspended'` as a fail-closed denial state regardless of
   * scope type. Optional because pre-W35e seed/legacy paths may omit it; an
   * undefined value is treated as active for backwards compatibility.
   */
  status?: string;
}

/**
 * Runtime guard mirroring the backend `users_access_scope_consistency_check`
 * constraint. Returns true when the user object satisfies the
 * scope_type / scope_id invariant required by the migration. Throws
 * `assertValidUserAccessScope` for the strict variant.
 */
export function isValidUserAccessScope(
  scopeType: AccessScopeType,
  scopeId: Id | null,
): boolean {
  if (scopeType === 'platform' || scopeType === 'tenant') return scopeId === null;
  return scopeId !== null && scopeId.length > 0;
}

/**
 * Strict assertion variant: throws if the (scope_type, scope_id) pair would be
 * rejected by the backend `users_access_scope_consistency_check` constraint.
 */
export function assertValidUserAccessScope(
  scopeType: AccessScopeType,
  scopeId: Id | null,
): void {
  if (!isValidUserAccessScope(scopeType, scopeId)) {
    if (scopeType === 'platform' || scopeType === 'tenant') {
      throw new Error(
        `access_scope_id must be NULL for access_scope_type=${scopeType}`,
      );
    }
    throw new Error(
      `access_scope_id must be set for access_scope_type=${scopeType}`,
    );
  }
}

export interface CurrentUserContext {
  user: User;
  scope: Scope;
  capabilities: string[];
}

export interface ListResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
}

// SCHEMA-DRIFT NOTE (Wave 11 / W11-5 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §6):
// Aligned to canonical `public.decision_log`
// (supabase/migrations/202510110003_mapping_lookup.sql:129-145):
//   • RENAMED: occurred_at → timestamp (canonical column name)
//   • DROPPED: resolved_from (NOT a column on decision_log; resolved via a join
//     with `settings_resolution_log.winning_scope_type`). Consumers that need
//     scope context extend with `& { resolved_from?: ScopeType }` and read it
//     as a projected/joined enrichment, not as a base-table column.
export interface DecisionLogEntry extends Record<string, unknown> {
  id: Id;
  timestamp: IsoDate;
  decision_category: string;
  settings_resolution_id?: Id;
  resource_id?: Id;
  resource_type?: string;
}

export interface SettingsResolution {
  category: string;
  value: unknown;
  resolved_from: ScopeType;
  ladder_path: Array<{
    rank: number;
    scope_type: ScopeType;
    scope_id: Id | null;
    has_value: boolean;
    value: unknown;
  }>;
  settings_resolution_id: Id;
  override_of?: ScopeType | null;
}

export type OnboardingReadinessStatus =
  | 'healthy'
  | 'pending_credentials'
  | 'blocked'
  | 'not_applicable'
  | 'ready'
  | 'warning'
  | 'unknown';

export interface OnboardingReadinessFinding extends Record<string, unknown> {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  component: string;
  message: string;
  action?: string | null;
}

export interface OnboardingReadinessComponent extends Record<string, unknown> {
  status: OnboardingReadinessStatus;
  healthy: boolean;
  required_count?: number;
  present_count?: number;
  healthy_count?: number;
  blocking_count?: number;
  warning_count?: number;
}

export interface OnboardingReadinessPluginItem extends Record<string, unknown> {
  plugin_key: string;
  status?: string | null;
  enabled?: boolean | null;
  credentials_status?: string | null;
  blocking?: boolean | null;
}

export interface UiOnboardingReadiness extends Record<string, unknown> {
  scope_type: string;
  scope_id: Id | null;
  organization_id?: Id | null;
  generated_at: IsoDate;
  overall_status: OnboardingReadinessStatus;
  healthy: boolean;
  settings_defaults: OnboardingReadinessComponent;
  workflow_bindings: OnboardingReadinessComponent;
  label_design?: OnboardingReadinessComponent;
  integration_plugins: OnboardingReadinessComponent & {
    items?: OnboardingReadinessPluginItem[];
  };
  blocking_findings: OnboardingReadinessFinding[];
}

/**
 * Canonical step shape stored inside `settings_resolution_log.scope_path`
 * (JSONB). Each element captures one rung of the override-ladder traversal
 * (Global -> Tenant -> Client -> Sender -> Source -> Resource) with the
 * winning row's `version` + `value` when `has_value` is true.
 */
export interface ResolutionLadderStep {
  rank: number;
  scope_type: ScopeType;
  scope_id: Id | null;
  has_value: boolean;
  version?: number | null;
  value?: unknown;
}

/**
 * Canonical row shape for `public.settings_resolution_log`
 * (`supabase/migrations/202511021310_settings_resolution_log.sql:12-26`).
 *
 * SCHEMA-DRIFT NOTE (W14-6 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §8):
 * This is the **flat** canonical shape. Earlier waves carried a re-nested
 * `winning` object on the FE; W14-6 flattened it to top-level columns to
 * match the canonical table directly. Consumers that previously read
 * `row.winning.scope_type` now read `row.winning_scope_type`. The
 * `ladder_path` alias has been retired in favour of the canonical
 * `scope_path` JSONB column. Synthetic `winning.value` (projection-derived)
 * is dropped; resolve via `inputs` JSONB or look up the winning settings
 * version when needed.
 */
export interface ResolutionLogRow extends Record<string, unknown> {
  id: Id;                                  // SSOT: settings_resolution_log.id
  organization_id?: Id;                    // SSOT: settings_resolution_log.organization_id
  category: string;                        // SSOT: settings_resolution_log.category
  scope_path: ResolutionLadderStep[];      // SSOT: settings_resolution_log.scope_path (JSONB)
  winning_scope_type: ScopeType;           // SSOT: settings_resolution_log.winning_scope_type
  winning_scope_id: Id | null;             // SSOT: settings_resolution_log.winning_scope_id
  winning_settings_id?: Id | null;         // SSOT: settings_resolution_log.winning_settings_id
  winning_settings_version_id?: Id | null; // SSOT: settings_resolution_log.winning_settings_version_id
  winning_version?: number | null;         // SSOT: settings_resolution_log.winning_version
  merge_notes?: Record<string, unknown> | null; // SSOT: settings_resolution_log.merge_notes
  inputs?: Record<string, unknown> | null;      // SSOT: settings_resolution_log.inputs
  resolved_at: IsoDate;                    // SSOT: settings_resolution_log.resolved_at
  created_at?: IsoDate;                    // SSOT: settings_resolution_log.created_at
}

/**
 * Canonical UI trace envelope returned by `public.ui_get_trace_v1(uuid)`
 * (`supabase/migrations/202601051630_ui_get_trace_v1.sql`). The RPC joins
 * three SSOT sources for a single correlation_id:
 *
 *   • `observability_events` — unified read of decision_log + api_call_log
 *     entries (column shape per `observability_events_v` in
 *     `202512011201_trace_observability_hardening.sql:70`).
 *   • `domain_events`        — engine-first ledger entries.
 *   • `workflow_runs`        — workflow_runs whose triggered_by_request_id
 *     matches.
 *
 * The FE consumes this canonical envelope directly (REAUDIT INSIGHTS §D3
 * closure — no FE-side `spans[]` derivation; the timeline view is rendered
 * from `observability_events.event_time` + `metadata.duration_ms`).
 */
export interface UiTraceObservabilityEvent extends Record<string, unknown> {
  event_id: Id;
  organization_id: Id | null;
  event_source: string;       // 'decision_log' | 'api_call_log' | …
  event_type: string;
  resource_type: string;
  resource_id: Id | null;
  correlation_id: Id;
  status: string;
  event_time: IsoDate;
  metadata: Record<string, unknown>;
}

export interface UiTraceDomainEvent extends Record<string, unknown> {
  id: Id;
  organization_id: Id | null;
  event_type: string;
  resource_type: string;
  resource_id: Id | null;
  correlation_id: Id;
  payload: Record<string, unknown>;
  created_at: IsoDate;
}

export interface UiTraceWorkflowRun extends Record<string, unknown> {
  id: Id;
  organization_id: Id | null;
  workflow_template_id: Id | null;
  status: string;
  triggered_by_request_id: Id;
  created_at: IsoDate;
  completed_at?: IsoDate | null;
}

export interface UiTrace {
  correlation_id: Id;
  observability_events: UiTraceObservabilityEvent[];
  domain_events: UiTraceDomainEvent[];
  workflow_runs: UiTraceWorkflowRun[];
}

/**
 * Capability key — narrowed to the literal union `CapabilityKey` from
 * `@/lib/capabilities` (every key registered in seed-raw + the typed
 * CAP bridge). Wave 19 flip: changed from `string` → literal union so
 * typos at any `useCapability(...)` / `capability=` call site become
 * compile errors. Test fixtures and MSW handlers that need to pass
 * dynamic strings should explicitly cast to `Capability` or use the
 * runtime `isCapability(s)` guard from `@/lib/capabilities`.
 *
 * AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): the canonical FE
 * capability list lives in `apps/console-v2/src/lib/seed-raw/registry.js`
 * and is mirrored to TS via `apps/console-v2/src/lib/capabilities.ts`.
 */
export type { CapabilityKey as Capability } from '@/lib/capabilities';

// api.ts — TYPED facade over the data-source adapter. Modules MUST import from here
// (not from data-source directly). This is the single swap point for production:
// replace these implementations with Supabase RPC and table queries — types stay stable.
//
// Naming mirrors api.* schema RPCs from AGENTS.md line 43.

import * as ds from './data-source';
import type { ListResult, SettingsResolution, DecisionLogEntry, UiTrace, UiOnboardingReadiness } from '../types/domain';
import type {
  RbacRoleMutationResult,
  RbacUserRoleAssignmentMutationResult,
  BranchMutationResult,
  BranchMarkOosResult,
  BranchZoneMutationResult,
  BranchMembershipMutationResult,
  BranchCapacityWindowMutationResult,
  BranchCoverageWindowMutationResult,
  MobilePolicyResolutionResult,
} from './data-source';

// ---------- Generic registry-driven reads ----------
export interface ListOpts {
  filter?: Record<string, unknown>;
  sort?: { key: string; dir?: 'asc' | 'desc' };
  page?: number;
  page_size?: number;
}
export const ui_list_resource_v1 = <T = Record<string, unknown>>(key: string, opts?: ListOpts): Promise<ListResult<T>> =>
  ds.ui_list_resource_v1(key, opts) as Promise<ListResult<T>>;
export const ui_list_resource_complete = <T = Record<string, unknown>>(
  key: string,
  opts?: ListOpts,
): Promise<ListResult<T>> =>
  ds.ui_list_resource_complete(key, opts) as Promise<ListResult<T>>;
export const ui_get_resource_v1 = <T = Record<string, unknown>>(key: string, id: string): Promise<T | null> =>
  ds.ui_get_resource_v1(key, id);
export const ui_resource_metrics_v1 = (key: string, opts?: ListOpts): Promise<{ total: number }> =>
  ds.ui_resource_metrics_v1(key, opts);
export const getLookupsLive = (category: string) => ds.getLookupsLive(category);
export type UserSecurityActionRow = import('./data-source').UserSecurityActionRow;
export const ui_list_user_security_actions_v1 = (
  targetUserId: string,
  limit?: number,
): Promise<ListResult<UserSecurityActionRow>> =>
  ds.ui_list_user_security_actions_v1(targetUserId, limit);
export type UserSessionRow = import('./data-source').UserSessionRow;
export const ui_list_user_sessions_v1 = (
  targetUserId?: string | null,
  limit?: number,
): Promise<ListResult<UserSessionRow>> =>
  ds.ui_list_user_sessions_v1(targetUserId, limit);

// ---------- Driver HOS (canonical accessor) ----------
// W34c — typed facade for the driver HOS map. Modules import this instead
// of pulling `seed-raw/fleet-drivers.js` directly. Live cutover swaps the
// data-source implementation to `resolve_driver_hours_of_service_v1(driver_id)`.
export const resolve_driver_hours_of_service_v1 = (driverId: string) =>
  ds.resolve_driver_hours_of_service_v1(driverId) as
    | import('./data-source').DriverHoursOfServiceRecord
    | null;
export const read_driver_hours_of_service_v1 = (driverId: string) =>
  ds.read_driver_hours_of_service_v1(driverId) as Promise<
    import('./data-source').DriverHoursOfServiceRecord | null
  >;

// ---------- Zone performance metrics (canonical accessor) ----------
// W54-E — typed facade for the zone performance metrics map. Modules
// import this instead of pulling `seed-raw/network-zones.js` directly.
// Live cutover swaps the data-source implementation to the canonical
// `mv_zone_performance_v1` view projection (or
// `resolve_zone_performance_metrics_v1(zone_id)` RPC).
export const resolve_zone_performance_metrics_v1 = (zoneId: string) =>
  ds.resolve_zone_performance_metrics_v1(zoneId) as
    | import('./data-source').ZonePerformanceMetricsRecord
    | null;

// ---------- Task type default actions (canonical accessor) ----------
// W34c — typed facade for the canonical `task_type_catalog.default_actions`
// projection. Used by `_review-queue/views.ts` instead of the prior inline
// `TASK_TYPE_DEFAULT_ACTIONS` Record literal. Live cutover swaps the
// data-source impl to the canonical RPC `resolve_task_type_default_actions_v1`.
export const resolve_task_type_default_actions_v1 = (taskType: string): string[] =>
  ds.resolve_task_type_default_actions_v1(taskType) as string[];

// ---------- Workflow template id resolver (canonical accessor) ----------
// W34c — modules pass the canonical `template_key` (`cod_driver_shift_settlement_v2`,
// `bank_deposit_reconciliation_v2`, ...) and receive the effective template id.
// Demo mode → FE seed `tpl_*` id; live mode → cloud canonical UUID. Replaces
// the inline UUID literals in finance/bank-recon.tsx + finance/cod.tsx.
export const resolve_workflow_template_id_v1 = (templateKey: string): string | null =>
  ds.resolve_workflow_template_id_v1(templateKey) as string | null;

// ---------- Identity / scope ----------
export const getCurrentUser = () => ds.getCurrentUser();
export const getCurrentScope = () => ds.getCurrentScope();
export const getCapabilities = () => ds.getCapabilities() as string[];
export const hasCapability = (cap?: string | null): boolean => ds.hasCapability(cap);
export const setRole = (roleId: string): void => ds.setRole(roleId);

// ---------- Registries ----------
export const getNavigation = () => ds.getNavigation();
export const getReadRegistry = () => ds.getReadRegistry();
export const getCommandRegistry = () => ds.getCommandRegistry();
export const getSettingsCategories = () => ds.getSettingsCategories();
export const getLookups = (category: string) => ds.getLookups(category) as Array<{
  value: string;
  label: string;
  tone?: string;
  rank?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}>;
export const getDevRoles = () => ds.getDevRoles();
export const hasConsoleLiveBackend = () => ds.hasConsoleLiveBackend();
export const isConsoleSeedModeEnabled = () => ds.isConsoleSeedModeEnabled();
export const hydrateConsoleLiveMetadata = () => ds.hydrateConsoleLiveMetadata();

// ---------- Canonical lookup row resolver (typed re-export) ----------
// Cycle E closure (P3 #20): consolidates the module-level
// `@ts-expect-error` directives importing from `@/lib/seed-raw/lookups`.
// This is the SSOT seam for resolving `(category, value)` to the
// canonical lookup row (label/tone/metadata). Returns `null` strict
// when the row is missing — callers fail loud with a danger chip
// (`<category>/<value> (missing)`), never a silent default.
export interface LookupRow {
  value: string;
  label?: string;
  tone?: string;
  rank?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}
export const lookupRow = (category: string, value: string): LookupRow | null =>
  ds.lookupRow(category, value) as LookupRow | null;
export const lookupCommandContractRow = (category: string, value: string): LookupRow | null =>
  ds.lookupCommandContractRow(category, value) as LookupRow | null;

// ---------- Dashboard ----------
export const dashboardKpis = (): Promise<Array<{ label: string; key: string; value: number | string; delta?: string; tone?: string; spark?: number[] }>> =>
  ds.dashboardKpis();

// ---------- KPI rollups (Phase F1 / CLAIM-INSIGHTS-REPORTING) ----------
//
// Facade over the canonical KPI catalog + daily rollups projection from
// supabase/migrations/202601311830_kpi_catalog_rollups_v1.sql. Replaces the
// previous static literal cards on /insights/reporting (`reporting.tsx:64-94`)
// with a typed read seam that resolves through `kpi_rollups_daily` joined to
// `kpi_definitions`. Modules MUST consume this through `useKpiRollup()`
// (queries.ts); module callsites stay stable across the production cutover.
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
export const compute_kpi_rollup_v1 = (
  args: ComputeKpiRollupArgs,
): Promise<KpiRollupResolution> =>
  ds.compute_kpi_rollup_v1(args);

// ---------- Bank account balance projection (W11-1 / W8-4 paired) ----------
//
// Facade over the canonical projection RPC `public.compute_bank_account_balance_v1`
// shipped in supabase/migrations/202604301110_compute_bank_account_balance_v1.sql.
//
// The RPC projects the three FE-derived bank account totals
// (`balance`, `last_match_at`, `open_items`) from the immutable
// `finance_events` ledger + `bank_recon_matches` relation. With the projection
// shipped, the FE `BankAccountRow` interface drops these three derived fields
// and modules consume them through `useBankAccountBalance(account_id)`
// (queries.ts). At cutover, the data-source adapter routes through
// `client.rpc('compute_bank_account_balance_v1', { p_args: { bank_account_id } })`.
export interface BankAccountBalanceResolution {
  ok: true;
  bank_account_id: string;
  organization_id: string | null;
  currency: string | null;
  /** Derived from finance_events: SUM(direction='in') − SUM(direction='out'). */
  balance: number;
  /** MAX(updated_at) of matched bank_recon_matches for this account. */
  last_match_at: string | null;
  /** COUNT of bank_statement events without an active matched row. */
  open_items: number;
  correlation_id?: string;
  settings_resolution_id?: string;
}
export interface ComputeBankAccountBalanceArgs {
  bank_account_id: string;
}
export const compute_bank_account_balance_v1 = (
  args: ComputeBankAccountBalanceArgs,
): Promise<BankAccountBalanceResolution> =>
  ds.compute_bank_account_balance_v1(args);

// ---------- Settings + ladder ----------
export const resolveSettings = (category: string, scopeContext?: unknown): Promise<SettingsResolution> =>
  ds.resolveSettings(category, scopeContext as Record<string, unknown> | undefined) as unknown as Promise<SettingsResolution>;
export const proposeSettingsChange = (category: string, scope: unknown, value: unknown, opts?: { dryRun?: boolean; justification?: string }) =>
  ds.proposeSettingsChange(category, scope, value, opts);
export type ApplySettingsValueResult = ds.ApplySettingsValueResult;
export const applySettingsValue = (
  category: string,
  scope: unknown,
  value: unknown,
  opts?: { justification?: string },
): Promise<ApplySettingsValueResult> =>
  ds.applySettingsValue(category, scope, value, opts);
export type MobilePolicyResolution = MobilePolicyResolutionResult;
export const resolveMobilePolicy = (category: string, scope?: unknown): Promise<MobilePolicyResolution | null> =>
  ds.resolveMobilePolicy(category, scope as Record<string, unknown> | undefined);

// ---------- Access control policy (canonical evaluator) ----------
//
// CLAIM-IDENTITY-CAPS — facade over the canonical Postgres function
// `public.resolve_access_control_policy_v1` defined in
// supabase/migrations/202601022113_access_control_policy_core.sql:554.
//
// The RPC RETURNS:
//   (policy JSONB, settings_id UUID, settings_version_id UUID,
//    scope_type TEXT, scope_id UUID, scope_path JSONB,
//    settings_resolution_id UUID)
//
// Modules MUST consume this through `useResolveAccessPolicy()` (queries.ts)
// — never read seed-driven capability registries directly. At cutover, only
// the data-source adapter swaps to `client.rpc('resolve_access_control_policy_v1', args)`.
export interface AccessPolicyResolution {
  /** JSONB body from `access_control_policy` settings (capabilities, roles, resource_map, denies). */
  policy: unknown;
  settings_id: string;
  settings_version_id: string;
  scope_type: string;
  scope_id: string | null;
  scope_path: Array<{ scope_type: string; scope_id: string | null }>;
  settings_resolution_id: string;
}
export const resolve_access_control_policy_v1 = (
  args: { scope_type?: string; scope_id?: string | null } = {},
): Promise<AccessPolicyResolution> =>
  ds.resolve_access_control_policy_v1(args);

// ---------- Per-capability evaluator (LadderViz drilldown) ----------
//
// CLAIM-IDENTITY-CAPS / Phase E4 — facade over the canonical Postgres function
// `public.user_capability_eval_v1` defined in
// supabase/migrations/202601022113_access_control_policy_core.sql:764.
//
// The RPC RETURNS a JSONB envelope:
//   { allowed: boolean,
//     reason: text,
//     capability_key: text,
//     scope_type: text,
//     scope_id: uuid|null,
//     role_keys: text[],
//     granted_capabilities: text[],
//     policy_source: { settings_id, settings_version_id,
//                      policy_scope_type, policy_scope_id,
//                      scope_path: [{scope_type, scope_id}, ...] } }
//
// Modules MUST consume this through `useUserCapabilityEval()` (queries.ts).
// The drilldown UI (`<CapabilityEvalDrilldown>`) renders the override-ladder
// path from `policy_source.scope_path` so operators can see WHY they have or
// lack a capability. At cutover, only the data-source adapter swaps to
// `client.rpc('user_capability_eval_v1', { p_capability_key, p_scope_type,
// p_scope_id })`.
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
  /**
   * Optional target user id. Backend RPC always evaluates for `auth.uid()`;
   * when set, the in-memory adapter scopes synthesis to a resolved user
   * record (e.g. /platform/users drawer drilldown). At cutover, callers that
   * need cross-user evaluation should call a tenant-admin variant — kept
   * out-of-scope for the v1 contract.
   */
  user_id?: string;
}
export const user_capability_eval_v1 = (
  args: UserCapabilityEvalArgs,
): Promise<UserCapabilityEvalResult> =>
  ds.user_capability_eval_v1(args);

// ---------- Decision / resolution / audit / ui-events ----------
export const listDecisionLog = (
  filters?: { category?: string; id?: string; resource_id?: string; resource_type?: string; limit?: number },
): Promise<DecisionLogEntry[]> =>
  ds.listDecisionLog(filters) as unknown as Promise<DecisionLogEntry[]>;
export const listResolutionLog = (filters?: { category?: string; limit?: number }) =>
  ds.listResolutionLog(filters);
export const listAuditLog = (filters?: { limit?: number }) => ds.listAuditLog(filters);
export const listUiEventLog = (filters?: { limit?: number }) => ds.listUiEventLog(filters);
export const streamEvidence = (cb: (entry: DecisionLogEntry) => void): (() => void) =>
  ds.streamEvidence(cb as (entry: Record<string, unknown>) => void);

// ---------- Tasks SSOT ----------
export const listTasks = (filters?: { task_type?: string; assigned_to?: string; at_risk?: boolean }) =>
  ds.listTasks(filters);
export const transition_task_v1 = (taskId: string, transition: { next_status?: string; [k: string]: unknown }) =>
  ds.transition_task_v1(taskId, transition);

export const resolve_manual_review_task_v1 = (
  taskId: string,
  resolution: { resolution_outcome?: string; resolution_notes?: string | null },
) => ds.resolve_manual_review_task_v1(taskId, resolution);
export interface WarehouseScanCorrectionRequestArgs {
  scan_event_id: string;
  correction_reason: string;
  corrected_barcode: string;
  metadata?: Record<string, unknown>;
}
export const ui_request_warehouse_scan_correction_v1 = (
  args: WarehouseScanCorrectionRequestArgs,
) => ds.ui_request_warehouse_scan_correction_v1(args);
export interface AssignTaskArgs extends Record<string, unknown> {
  task_id: string;
  assigned_to: string;
  idempotency_key?: string | null;
  notes?: string | null;
}
export const assign_task_v1 = (args: AssignTaskArgs) => ds.assign_task_v1(args);
export interface OpenOpsSessionArgs extends Record<string, unknown> {
  session_type: string;
  branch_id?: string | null;
  session_code?: string | null;
  idempotency_key: string;
  metadata?: Record<string, unknown>;
}
export const open_ops_session_v1 = (args: OpenOpsSessionArgs) => ds.open_ops_session_v1(args);

// ---------- Shipments ----------
export const ui_get_shipment_timeline_v1 = (shipmentId: string) => ds.ui_get_shipment_timeline_v1(shipmentId);
export interface ShipmentOperationGuardState extends Record<string, unknown> {
  operation?: string;
  allowed?: boolean;
  reason?: string | null;
  lock_source?: string;
  status?: string;
  allowed_statuses?: string[];
  window_hours?: number | null;
  window_expires_at?: string | null;
}
export interface ShipmentAmendCancelOptions extends Record<string, unknown> {
  shipment_id?: string;
  tracking_number?: string | null;
  status?: string | null;
  lock_source?: string;
  policy?: Record<string, unknown>;
  operations?: {
    modify?: ShipmentOperationGuardState;
    reschedule?: ShipmentOperationGuardState;
    address?: ShipmentOperationGuardState;
    cancel?: ShipmentOperationGuardState;
  };
}
export const shipment_amend_cancel_options_v1 = (shipmentId: string): Promise<ShipmentAmendCancelOptions> =>
  ds.shipment_amend_cancel_options_v1(shipmentId) as Promise<ShipmentAmendCancelOptions>;
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
export const ui_create_shipment_v1 = (
  args: UiCreateShipmentArgs,
): Promise<UiCreateShipmentResult> =>
  ds.ui_create_shipment_v1(args) as Promise<UiCreateShipmentResult>;
export const shipment_amend_cancel_v1 = (
  shipmentId: string,
  op: string,
  payload: Record<string, unknown>,
  opts?: { dryRun?: boolean }
) => ds.shipment_amend_cancel_v1(shipmentId, op, payload, opts);
export const ui_execute_shipment_batch_operation_v1 = (
  ids: string[],
  op: string,
  payload: Record<string, unknown>,
  opts?: { dryRun?: boolean }
) => ds.ui_execute_shipment_batch_operation_v1(ids, op, payload, opts);
export const ui_execute_shipment_resort_v1 = (shipmentId: string) => ds.ui_execute_shipment_resort_v1(shipmentId);
export interface ShipmentUpdateGeocodeArgs extends Record<string, unknown> {
  shipment_id: string;
  address_id?: string;
  destination_address_id?: string;
  params?: Record<string, unknown>;
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
export const ui_execute_shipment_update_geocode_v1 = (
  args: ShipmentUpdateGeocodeArgs,
): Promise<ShipmentUpdateGeocodeResult> => {
  const { shipment_id, params, ...rest } = args;
  return ds.ui_execute_shipment_update_geocode_v1(shipment_id, {
    ...(params ?? {}),
    ...rest,
  }) as Promise<ShipmentUpdateGeocodeResult>;
};

// ---------- Baskets ----------
export const ui_update_basket_state_v1 = (args: Record<string, unknown>) =>
  ds.ui_update_basket_state_v1(args);
export interface BasketCreateArgs extends Record<string, unknown> {
  organization_id?: string | null;
  zone_id?: string | null;
  basket_type?: string | null;
  state?: string | null;
  capacity_count?: number | string | null;
  expires_at?: string | null;
  expires_in_minutes?: number | string | null;
  sort_branch_id?: string | null;
  sort_service_key?: string | null;
  sort_route_key?: string | null;
  sort_priority_key?: string | null;
}
export interface BasketCreateResult extends Record<string, unknown> {
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
export const basket_create_v1 = (args: BasketCreateArgs): Promise<BasketCreateResult> =>
  ds.basket_create_v1(args) as Promise<BasketCreateResult>;
export interface BasketUpdateArgs extends Record<string, unknown> {
  basket_id: string;
  patch: Record<string, unknown>;
}
export interface BasketUpdateResult extends Record<string, unknown> {
  ok: true;
  basket_id: string;
  changed?: Record<string, unknown>;
  correlation_id: string;
  settings_resolution_id?: string;
}
export const basket_update_v1 = (args: BasketUpdateArgs): Promise<BasketUpdateResult> =>
  ds.basket_update_v1(args) as Promise<BasketUpdateResult>;

// W13-5 — operator-initiated comms attempt enqueue (closes OPERATIONS D3 §3,
// CommsTab "Send now" was orphan-toast). Wraps the canonical seam
// `public.enqueue_comms_attempt_v1(p_args jsonb)` with envelope
// `{ shipment_id, channel, template_id?, recipient_override? }` returning
// `{ ok, comms_attempt_id, correlation_id, settings_resolution_id }`. Policy
// gate is `communication_policy.allow_operator_initiated_send`; the canonical
// queue is `public.comms_attempts` with `comms_orchestrator_apply_v1` as the
// existing system-driven path.
export const enqueue_comms_attempt_v1 = (args: {
  shipment_id: string;
  channel: string;
  template_id?: string;
  recipient_override?: Record<string, unknown>;
}) => ds.enqueue_comms_attempt_v1(args);

// ---------- Route plans / runs ----------
//
// Typed shapes mirror the cloud `api.*` route-plan / route-run RPC contract from
// supabase/migrations/20260403…20260410 (route_plan_*, uc076…uc082, ui_route_*).
// Modules MUST import these helpers (not the data-source) so the cutover to
// supabase-js .rpc() is a single-file swap.
export interface RoutePlanCreateInput {
  branch_id: string;
  planned_date: string;
  inputs?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export interface RoutePlanRebalanceInput {
  source_route_plan_id: string;
  target_route_plan_id?: string | null;
  shipment_ids: string[];
  target_branch_id?: string | null;
  idempotency_key?: string | null;
  metadata?: Record<string, unknown>;
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
export interface RouteRunAssignTarget {
  organization_id?: string;
  driver_user_id?: string;
  vehicle_id?: string;
  partner_id?: string;
  partner_name?: string;
  assignment_mode?: string;
  use_alternate_capacity?: boolean;
  idempotency_key?: string;
  notes?: string;
  reassignment_reason?: string;
  metadata?: Record<string, unknown>;
}
export interface RouteRunAssignmentResponseParams {
  response_notes?: string;
  refusal_reason?: string;
  response_metadata?: Record<string, unknown>;
  idempotency_key?: string;
}
export type RouteRunAssignmentResponseResult = import('./data-source').RouteRunAssignmentResponseResult;
export interface RoutePlanConstraintCheck {
  name: string;
  passed: number;
  failed: number;
  status: 'pass' | 'warn' | 'danger';
  detail?: string;
}

export const ui_create_route_plan_v1 = (input: RoutePlanCreateInput): Promise<{
  ok: true; route_plan_id: string; status: string; plan_id: string;
}> => ds.ui_create_route_plan_v1(input);
export const ui_solve_route_plan_v1 = (planId: string): Promise<{
  ok: true; plan_id: string; status: string;
}> => ds.ui_solve_route_plan_v1(planId);
export const ui_freeze_route_plan_v1 = (planId: string): Promise<{
  ok: true; plan_id: string; status: string; constraint_validation: { fail_count: number };
}> => ds.ui_freeze_route_plan_v1(planId);
export const ui_publish_route_plan_v1 = (planId: string): Promise<{
  ok: true; plan_id: string; execution_pack_hash: string;
}> => ds.ui_publish_route_plan_v1(planId);
export type RoutePlanExecutionPack = import('./data-source').RoutePlanExecutionPack;
export const ui_route_plan_execution_pack_v1 = (
  planId: string,
): Promise<RoutePlanExecutionPack | null> =>
  ds.ui_route_plan_execution_pack_v1(planId);
export const ui_apply_route_plan_v1 = (planId: string): Promise<{
  ok: true; plan_id: string; status: string; runs_materialized: number;
}> => ds.ui_apply_route_plan_v1(planId);
export const ui_rebalance_route_plan_v1 = (
  input: RoutePlanRebalanceInput,
): Promise<{ ok: true; plan_id: string; moves_applied: number }> =>
  ds.ui_rebalance_route_plan_v1(input);
export const route_plan_validate_constraints_v1 = (planId: string): Promise<{
  ok: true; plan_id: string; fail_count: number; items: RoutePlanConstraintCheck[];
}> => ds.route_plan_validate_constraints_v1(planId);
export const ui_execute_route_run_assign_v1 = (runId: string, target: RouteRunAssignTarget | unknown): Promise<{
  ok: true; run_id: string; target: RouteRunAssignTarget | unknown;
}> => ds.ui_execute_route_run_assign_v1(runId, target);
export const ui_execute_route_run_assignment_response_v1 = (
  runId: string,
  actionKey: string,
  params?: RouteRunAssignmentResponseParams,
): Promise<RouteRunAssignmentResponseResult> =>
  ds.ui_execute_route_run_assignment_response_v1(runId, actionKey, params);
export const ui_execute_route_stop_reassign_v1 = (
  stopIds: string[],
  target: RouteStopReassignTarget | unknown,
): Promise<{ ok: true; count: number; target: unknown; assignment_status: string }> =>
  ds.ui_execute_route_stop_reassign_v1(stopIds, target);
export const ui_confirm_route_run_departure_v1 = (runId: string): Promise<{
  ok: true; departure_confirmed_at: string; run_id: string;
}> => ds.ui_confirm_route_run_departure_v1(runId);
export const route_run_scan_out_reconciliation_v1 = (runId: string): Promise<{
  ok: true; expected: number; scanned: number; discrepancies: string[]; run_id: string;
}> => ds.route_run_scan_out_reconciliation_v1(runId);

// ---------- Pickups ----------
// Pickup list wrappers are loosely typed at the data-source layer (returns
// `{ rows: Record<string, unknown>[]; total: number }`). Module call sites
// down-cast each row to their canonical FE row interface (PickupRequestRow,
// PickupWaveRow, PickupFailureRow) using the same registry-driven pattern as
// `useResourceList`. The wrappers below take an optional row generic so
// callers can declare the canonical FE row interface inline (e.g.
// `pickup_requests_list_v1<PickupRequestRow>(filter)`) — W56-B (F9) closure.
// The default generic remains `Record<string, unknown>` so existing call
// sites stay source-compatible.
export const pickup_requests_list_v1 = <T extends Record<string, unknown> = Record<string, unknown>>(
  filter?: unknown,
): Promise<{ rows: T[]; total: number }> =>
  ds.pickup_requests_list_v1(filter) as Promise<{ rows: T[]; total: number }>;
export const pickup_waves_list_v1 = <T extends Record<string, unknown> = Record<string, unknown>>(
  filter?: unknown,
): Promise<{ rows: T[]; total: number }> =>
  ds.pickup_waves_list_v1(filter) as Promise<{ rows: T[]; total: number }>;
export const pickup_failures_list_v1 = <T extends Record<string, unknown> = Record<string, unknown>>(
  filter?: unknown,
): Promise<{ rows: T[]; total: number }> =>
  ds.pickup_failures_list_v1(filter) as Promise<{ rows: T[]; total: number }>;
export const create_pickup_request_v1 = (payload: unknown) => ds.create_pickup_request_v1(payload);
export const create_pickup_wave_v1 = (payload: unknown) => ds.create_pickup_wave_v1(payload);
export const assign_pickup_wave_v1 = (waveId: string, target: unknown) => ds.assign_pickup_wave_v1(waveId, target);

// ---------- NDR / scan / warehouse ----------
// Canonical 6-arg signature is documented on the data-source export
// (see DispatchExceptionResolutionOpts.canonical). The legacy 3-arg wrapper
// is preserved so existing call sites compile unchanged; new code passes
// `opts.canonical` to populate the action_key/resource_key/selection_*
// fields the real RPC requires.
export const ui_execute_dispatch_exception_resolution_v1 = (
  taskId: string,
  resolution: unknown,
  opts?: import('./data-source').DispatchExceptionResolutionOpts,
) => ds.ui_execute_dispatch_exception_resolution_v1(taskId, resolution, opts);
export const record_scan_event_v1 = (payload: { scan_type: string; [k: string]: unknown }) =>
  ds.record_scan_event_v1(payload);
export interface WarehouseTransferManifestCreateResult {
  ok: true;
  warehouse_transfer_id: string;
  transfer_code: string;
  created: boolean;
  item_count: number;
  [key: string]: unknown;
}
export const create_warehouse_transfer_manifest_v1 = (
  args: Record<string, unknown>,
): Promise<WarehouseTransferManifestCreateResult> =>
  ds.create_warehouse_transfer_manifest_v1(args) as Promise<WarehouseTransferManifestCreateResult>;
export const warehouse_transfer_execute_v1 = (payload: unknown) =>
  ds.warehouse_transfer_execute_v1(payload as Record<string, unknown> | undefined);
// W35e-4 — Aligned to canonical jsonb envelope per
// supabase/migrations/202601261740_warehouse_transfer_reconcile_finalize_v1.sql.
// The canonical RPC reads `p_input->>'warehouse_transfer_id'` and
// `p_input->>'to_status'` (plus optional `from_status`, `effective_at`,
// `set_*` flags, `vehicle_id`, `driver_user_id`, `organization_id`). Closes
// REAUDIT3/PLATFORM.md P1-1.
//
// Backwards-compatible signature: legacy 2-arg form (`transferId, transition`)
// is still accepted and adapted to the canonical envelope on the way through;
// new callers should pass a single `{ warehouse_transfer_id, to_status, ... }`
// object directly. The data-source adapter accepts both shapes.
export interface TransitionWarehouseTransferArgs extends Record<string, unknown> {
  /** Canonical p_input->>'warehouse_transfer_id'. Required. */
  warehouse_transfer_id: string;
  /** Canonical p_input->>'to_status'. Required (e.g. 'received', 'reconciled'). */
  to_status: string;
  /** Optional p_input->>'from_status' guard. */
  from_status?: string;
  /** Optional p_input->>'effective_at' (ISO timestamp). */
  effective_at?: string;
  /** Optional set_* flags + actor refs read by the canonical RPC. */
  set_dispatched_at?: boolean;
  set_received_at?: boolean;
  set_reconciled_at?: boolean;
  vehicle_id?: string;
  driver_user_id?: string;
  organization_id?: string;
}
export const transition_warehouse_transfer_v1 = (
  argsOrTransferId: TransitionWarehouseTransferArgs | string,
  legacyTransition?: unknown,
) => {
  // Adapt legacy 2-arg `(id, 'receive')` form to the canonical jsonb envelope.
  // The legacy `transition` value (e.g. 'receive', 'reconcile', 'dispatch') maps
  // to canonical `to_status` per the seed-mode dispatcher's prior contract.
  if (typeof argsOrTransferId === 'string') {
    const args: TransitionWarehouseTransferArgs = {
      warehouse_transfer_id: argsOrTransferId,
      to_status: typeof legacyTransition === 'string' ? legacyTransition : '',
    };
    return ds.transition_warehouse_transfer_v1(args);
  }
  return ds.transition_warehouse_transfer_v1(argsOrTransferId);
};
export type WarehouseTransferUiActionResult = import('./data-source').WarehouseTransferUiActionResult;
export type WarehouseTransferCheckpointActionKey =
  | 'warehouse_transfers.scan_departure'
  | 'warehouse_transfers.scan_arrival';
export const ui_execute_warehouse_transfer_dispatch_v1 = (
  args: { warehouse_transfer_id: string; params?: Record<string, unknown> },
): Promise<WarehouseTransferUiActionResult> =>
  ds.ui_execute_warehouse_transfer_dispatch_v1(args);
export const ui_execute_warehouse_transfer_checkpoint_v1 = (
  args: {
    action_key: WarehouseTransferCheckpointActionKey;
    warehouse_transfer_id: string;
    barcode: string;
    handling_unit_code?: string | null;
    device_id?: string | null;
    ops_session_id?: string | null;
    notes?: string | null;
  },
): Promise<WarehouseTransferUiActionResult> =>
  ds.ui_execute_warehouse_transfer_checkpoint_v1(args);
export const ui_execute_warehouse_transfer_reconcile_v1 = (
  args: {
    warehouse_transfer_id: string;
    received_shipment_count: number;
    damaged_shipment_count?: number;
    missing_shipment_count?: number;
    unmanifested_shipment_count?: number;
    reconcile_notes?: string | null;
  },
): Promise<WarehouseTransferUiActionResult> =>
  ds.ui_execute_warehouse_transfer_reconcile_v1(args);
export const return_to_branch_shipments_v1 = {
  list: () => ds.return_to_branch_shipments_v1.list(),
};

// CLAIM-OPERATIONS-WIRING (Phase C1) — facade over the canonical
// `public.resolve_ndr_branch_next_action_v1` RPC. Used by the
// returned-to-branch surface to render a recommended next-action chip per
// row (and surface the same hint in the exceptions queue when a row's
// `dispatch_exception_reason` is well-known).
export interface NdrBranchNextActionArgs extends Record<string, unknown> {
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
export const resolve_ndr_branch_next_action_v1 = (args: NdrBranchNextActionArgs = {}): Promise<string> =>
  ds.resolve_ndr_branch_next_action_v1(args);

// ---------- Delivery slots ----------
export const list_delivery_slots_v1 = (args?: unknown) => ds.list_delivery_slots_v1(args);
// CLAIM-LIFECYCLE-LINK Gap 2: extend caller signature with optional shipment_id
// + window_id so the picked window is forwarded to the RPC. The data-source
// adapter signature was widened to match — production swap stays one-line.
export const reserve_delivery_slot_v1 = (args: { slot_date: string; shipment_id?: string; window_id?: string }) =>
  ds.reserve_delivery_slot_v1(args);

// ---------- COD / settlement ----------
export const compute_cod_payment_collection_summary_v1 = (scope?: unknown) =>
  ds.compute_cod_payment_collection_summary_v1(scope);

// ---------- Labels ----------
export type LabelDesignScopeType = import('./data-source').LabelDesignScopeType;
export type LabelDesignDraft = import('./data-source').LabelDesignDraft;
export type LabelDesignerDraftListResult = import('./data-source').LabelDesignerDraftListResult;
export type LabelDesignerDraftMutationResult = import('./data-source').LabelDesignerDraftMutationResult;
export type LabelDesignerDraftValidationResult = import('./data-source').LabelDesignerDraftValidationResult;
export type LabelDesignerDraftPublishResult = import('./data-source').LabelDesignerDraftPublishResult;
export type LabelDesignerAsset = import('./data-source').LabelDesignerAsset;
export type LabelDesignerAssetListResult = import('./data-source').LabelDesignerAssetListResult;
export type LabelDesignerAssetUploadArgs = import('./data-source').LabelDesignerAssetUploadArgs;
export type LabelDesignerAssetUploadResult = import('./data-source').LabelDesignerAssetUploadResult;
export type LabelDesignerFieldCatalogField = import('./data-source').LabelDesignerFieldCatalogField;
export type LabelDesignerFieldCatalogResult = import('./data-source').LabelDesignerFieldCatalogResult;
export type LabelDesignerEffectiveConfigResult = import('./data-source').LabelDesignerEffectiveConfigResult;
export type LabelRendererReadinessResult = import('./data-source').LabelRendererReadinessResult;
export type LabelPrinterCertificationArgs = import('./data-source').LabelPrinterCertificationArgs;
export type LabelPrinterCertificationResult = import('./data-source').LabelPrinterCertificationResult;
export type LabelDesignerSamplePayloadResult = import('./data-source').LabelDesignerSamplePayloadResult;
export type LabelDesignerPreviewArgs = import('./data-source').LabelDesignerPreviewArgs;
export type LabelDesignerPreviewResult = import('./data-source').LabelDesignerPreviewResult;

export const label_designer_get_field_catalog = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerFieldCatalogResult> =>
  ds.label_designer_get_field_catalog(scopeType, scopeId);

export const label_designer_get_effective_label_design = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  ds.label_designer_get_effective_label_design(scopeType, scopeId);

export const label_designer_get_effective_label_render_policy = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  ds.label_designer_get_effective_label_render_policy(scopeType, scopeId);

export const label_designer_get_effective_label_print_profile = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  ds.label_designer_get_effective_label_print_profile(scopeType, scopeId);

export const label_designer_get_label_media_catalog = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  ds.label_designer_get_label_media_catalog(scopeType, scopeId);

export const ui_label_renderer_readiness_v1 = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelRendererReadinessResult> =>
  ds.ui_label_renderer_readiness_v1(scopeType, scopeId);

export const ui_record_label_printer_certification_v1 = (
  args: LabelPrinterCertificationArgs,
): Promise<LabelPrinterCertificationResult> =>
  ds.ui_record_label_printer_certification_v1(args);

export const label_designer_get_sample_payload = (args: {
  shipment_id: string;
  shipment_box_id?: string | null;
}): Promise<LabelDesignerSamplePayloadResult> =>
  ds.label_designer_get_sample_payload(args);

export const label_designer_list_drafts = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerDraftListResult> =>
  ds.label_designer_list_drafts(scopeType, scopeId);

export const label_designer_create_draft = (args: {
  scope_type: LabelDesignScopeType;
  scope_id: string;
  label_type?: string;
  draft_name?: string | null;
  draft_value: Record<string, unknown>;
}): Promise<LabelDesignerDraftMutationResult> =>
  ds.label_designer_create_draft(args);

export const label_designer_update_draft = (args: {
  draft_id: string;
  label_type?: string | null;
  draft_name?: string | null;
  draft_value?: Record<string, unknown> | null;
}): Promise<LabelDesignerDraftMutationResult> =>
  ds.label_designer_update_draft(args);

export const label_designer_archive_draft = (args: {
  draft_id: string;
  archive_reason?: string | null;
}): Promise<LabelDesignerDraftMutationResult> =>
  ds.label_designer_archive_draft(args);

export const label_designer_validate_label_design_draft = (
  draftId: string,
): Promise<LabelDesignerDraftValidationResult> =>
  ds.label_designer_validate_label_design_draft(draftId);

export const label_designer_publish_label_design_draft = (
  draftId: string,
  changeReason?: string | null,
  readbackScope?: { scopeType?: string | null; scopeId?: string | null },
): Promise<LabelDesignerDraftPublishResult> =>
  ds.label_designer_publish_label_design_draft(draftId, changeReason, readbackScope);

export const label_designer_list_assets = (): Promise<LabelDesignerAssetListResult> =>
  ds.label_designer_list_assets();

export const label_designer_upload_asset = (
  args: LabelDesignerAssetUploadArgs,
): Promise<LabelDesignerAssetUploadResult> =>
  ds.label_designer_upload_asset(args);

export const label_designer_delete_asset = (path: string) =>
  ds.label_designer_delete_asset(path);

export const label_designer_preview_label_design_draft = (
  args: LabelDesignerPreviewArgs,
): Promise<LabelDesignerPreviewResult> =>
  ds.label_designer_preview_label_design_draft(args);

export const request_label_reprint = (labelId: string, args: { reason: string }) =>
  ds.request_label_reprint(labelId, args);
export type TargetLabelRequestArgs = ds.TargetLabelRequestArgs;
export type TargetLabelRequestResult = ds.TargetLabelRequestResult;
export const ui_request_label_generation_target_v1 = (args: TargetLabelRequestArgs) =>
  ds.ui_request_label_generation_target_v1(args);
export const resolve_resource_download_url_v1 = (args: ds.ResourceDownloadUrlArgs) =>
  ds.resolve_resource_download_url_v1(args);
export const complete_label_job = (jobId: string, payload: unknown) =>
  ds.complete_label_job(jobId, payload);

// ---------- Mobile + devices ----------
export interface UserDeviceRevokeArgs extends Record<string, unknown> {
  deviceId: string;
  revokedReason: string;
}
export const ui_execute_user_device_revoke_v1 = (
  deviceId: string,
  revokedReason: string,
) => ds.ui_execute_user_device_revoke_v1(deviceId, revokedReason);

// ---------- Identity / sessions (Phase E2) ----------
//
// Backend SSOT: `public.revoke_session_v1(p_args jsonb)` per
// supabase/migrations/202604280212_revoke_session_v1.sql:21. The RPC writes a
// revocation INTENT row to `public.revocation_audit` (status='pending') and
// emits `domain_events.session.revocation_requested`; the actual
// `auth.sessions` termination is performed by an out-of-band edge worker via
// Supabase Admin API `auth.admin.signOut(user_id)`.
//
// Capability: `users.manage`. Cross-tenant targets are rejected at the RPC
// unless the caller is a platform user.
export interface RevokeSessionArgs extends Record<string, unknown> {
  /** UUID of the user whose session is being revoked. Required. */
  target_user_id: string;
  /** Optional canonical session id (auth.sessions.id). When omitted the worker
   *  signs the user out across all sessions. */
  session_id?: string | null;
  /** Required free-text rationale persisted in revocation audit/readback. */
  reason: string;
}
export interface RevokeSessionResult extends Record<string, unknown> {
  ok: true;
  revocation_audit_id: string;
  target_user_id: string;
  status: 'pending';
  correlation_id: string;
  settings_resolution_id?: string;
}
export const revoke_session_v1 = (args: RevokeSessionArgs): Promise<RevokeSessionResult> =>
  ds.revoke_session_v1(args) as Promise<RevokeSessionResult>;

// ---------- Identity / user lifecycle (W37) ----------
//
// Closes REAUDIT4 IDENTITY P1 (substrate-vs-shipped-RPC drift): the 5 hooks
// previously routed through `runCommand('users.<verb>', ...)` even though the
// canonical `_v1` RPCs DO exist:
//   • supabase/migrations/202604300300_grant_user_role_v1.sql
//   • supabase/migrations/202604300310_revoke_user_role_v1.sql
//   • supabase/migrations/202604300320_suspend_user_v1.sql
//   • supabase/migrations/202604300330_reactivate_user_v1.sql
//   • supabase/migrations/202604300340_force_password_reset_v1.sql
//
// Each RPC is `(p_args jsonb) RETURNS jsonb`, capability-asserted server-side
// (`users.manage`), and emits domain_event + decision_log.
export interface GrantUserRoleArgs extends Record<string, unknown> {
  /** Required. UUID of the target user. */
  target_user_id: string;
  /** Required. Canonical role key (super_admin / ops_admin / account_manager / ...). */
  role_key: string;
  /** Optional free-text rationale (audited in decision_log). */
  reason?: string;
  /** Optional explicit organization id (defaults to caller's org). */
  organization_id?: string;
}
export interface GrantUserRoleResult extends Record<string, unknown> {
  ok: true;
  target_user_id: string;
  role_key: string;
  user_role_assignment_id?: string;
  correlation_id?: string;
  settings_resolution_id?: string;
}
export const grant_user_role_v1 = (args: GrantUserRoleArgs): Promise<GrantUserRoleResult> =>
  ds.grant_user_role_v1(args) as Promise<GrantUserRoleResult>;

export interface RevokeUserRoleArgs extends Record<string, unknown> {
  target_user_id: string;
  role_key: string;
  reason?: string;
  organization_id?: string;
}
export const revoke_user_role_v1 = (args: RevokeUserRoleArgs): Promise<Record<string, unknown>> =>
  ds.revoke_user_role_v1(args);

export interface SuspendUserArgs extends Record<string, unknown> {
  target_user_id: string;
  reason?: string;
}
export const suspend_user_v1 = (args: SuspendUserArgs): Promise<Record<string, unknown>> =>
  ds.suspend_user_v1(args);

export interface ReactivateUserArgs extends Record<string, unknown> {
  target_user_id: string;
  reason?: string;
}
export const reactivate_user_v1 = (args: ReactivateUserArgs): Promise<Record<string, unknown>> =>
  ds.reactivate_user_v1(args);

export interface ForcePasswordResetArgs extends Record<string, unknown> {
  target_user_id: string;
  email?: string;
  reason: string;
}
export const force_password_reset_v1 = (
  args: ForcePasswordResetArgs,
): Promise<Record<string, unknown>> => ds.force_password_reset_v1(args);

// ---------- Workflows ----------
//
// Backend canonical RPC contract (verified in supabase/migrations/**):
//   • public.start_workflow_run(uuid, jsonb) RETURNS uuid
//       → real backend returns the bare new run UUID.
//   • public.progress_workflow_run(uuid, jsonb) RETURNS jsonb
//       → real backend returns a free-form jsonb result envelope (handler chain output).
//   • public.close_workflow_run(uuid, text) RETURNS void
//       → real backend returns nothing.
//
// Adapter-shape note (CONTRACT DRIFT — intentional):
// The TypeScript shapes below (WorkflowRunStartResult / WorkflowRunProgressResult / etc.)
// are richer envelopes that include client-friendly fields (correlation_id, idempotency_key,
// decision_log_id, derived workflow_status). Today these are produced by the in-memory
// `data-source.ts` adapter so the FE can render the Test panel + Run drilldown without
// extra round-trips.
//
// On Supabase swap, the wrapper bodies must be replaced with calls that:
//   1. invoke the canonical RPC, and
//   2. derive the missing envelope fields from companion reads
//      (`ui_list_resource_v1('workflow_runs', { filter: { id: <uuid> } })`,
//       `ui_list_resource_v1('workflow_run_steps', { filter: { workflow_run_id } })`,
//       `decision_log` joins on workflow_run_id).
// Module call sites stay stable.
export interface WorkflowRunStartContext extends Record<string, unknown> {
  ui?: { dry_run?: boolean; sample_payload?: unknown; replay_of?: string; allow_inactive?: boolean };
}
export interface WorkflowRunStartResult {
  ok: true;
  workflow_run_id: string;
  workflow_template_id: string;
  workflow_status: 'pending' | 'running';
  dry_run: boolean;
  idempotency_key: string;
  correlation_id: string;
  started_at: string;
  canonical_entrypoint: 'progress_workflow_run';
}
export type WorkflowRunStepStatus =
  | 'pending'
  | 'in_progress'
  | 'running'
  | 'completed'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'timed_out';
export interface WorkflowRunStep extends Record<string, unknown> {
  id: string;
  step_id: string;
  label?: string | null;
  kind?: string;
  status?: WorkflowRunStepStatus;
  step_status?: WorkflowRunStepStatus;
  duration_ms?: number | null;
  enqueued_at?: string | null;
  operation_started_at?: string;
  operation_completed_at?: string;
  operation_result?: Record<string, unknown> | null;
  last_error?: string | null;
  retry_attempt?: number;
  decision_log_id?: string;
}
export interface WorkflowRunProgressResult {
  ok: true;
  workflow_run_id: string;
  workflow_status: 'completed' | 'failed' | 'paused';
  duration_ms: number;
  steps: WorkflowRunStep[];
  payload?: unknown;
}
export const start_workflow_run = (templateId: string, context: WorkflowRunStartContext = {}): Promise<WorkflowRunStartResult> =>
  ds.start_workflow_run(templateId, context);
export const progress_workflow_run = (
  runId: string,
  payload?: unknown,
  /**
   * Optional action discriminator forwarded as part of the canonical RPC payload
   * (`progress_workflow_run({...payload, action})`). The two former dedicated wrappers
   * `progress_workflow_run_manual_override` and `progress_workflow_run_reopen_pending`
   * are now `action: 'manual_override' | 'reopen_pending'` on the same canonical RPC,
   * matching the backend reality (no separate functions exist; only
   * `public.progress_workflow_run(uuid, jsonb)` is provisioned).
   */
  action?: 'progress' | 'manual_override' | 'reopen_pending' | 'retry' | 'pause' | 'resume',
): Promise<WorkflowRunProgressResult> =>
  ds.progress_workflow_run(runId, payload, action) as unknown as Promise<WorkflowRunProgressResult>;
export const progress_workflow_run_until_wait_v1 = (
  runId: string,
  payload?: unknown,
  opts?: { budget_ms?: number; max_steps?: number },
): Promise<WorkflowRunProgressResult> =>
  ds.progress_workflow_run_until_wait_v1(runId, payload, opts) as unknown as Promise<WorkflowRunProgressResult>;
export const progress_workflow_run_base = (runId: string, payload?: unknown) =>
  ds.progress_workflow_run_base(runId, payload);
export const close_workflow_run = (runId: string, status: 'completed' | 'failed' | 'cancelled') =>
  ds.close_workflow_run(runId, status);

// Workflow run steps reader — sourced via the canonical generic resource RPC
// (`public.ui_list_resource_v1('workflow_run_steps', { filter: { workflow_run_id }})`).
// No dedicated `ui_get_workflow_run_steps_v1` RPC exists in backend; this wrapper
// composes on top of the generic substrate so the swap point stays a single line.
export const ui_get_workflow_run_steps_v1 = async (
  runId: string,
): Promise<{ rows: WorkflowRunStep[]; total: number; workflow_run_id: string }> => {
  const res = await ui_list_resource_v1<WorkflowRunStep>('workflow_run_steps', {
    filter: { workflow_run_id: runId },
    sort: { key: 'enqueued_at', dir: 'asc' },
  });
  return { rows: res.rows, total: res.total, workflow_run_id: runId };
};

export interface OperationTemplate extends Record<string, unknown> {
  id: string;
  operation_name: string;
  kind: 'trigger' | 'transform' | 'guard' | 'action' | 'error' | 'manual';
  category: string;
  timeout_seconds: number;
  description: string;
  // Cycle E (Workflows P1 #1) — canonical projection of
  // `operation_templates.output_schema` (jsonb) + `output_sample` (jsonb).
  // When the canonical row has not yet projected these (preview/dev),
  // the OutputsTab/InputsTab consumer renders a `<StateView kind="empty"
  // />` block (no FE-fabricated synthetic schema or fictional payload).
  output_schema?: Record<string, unknown> | null;
  output_sample?: Record<string, unknown> | null;
}

// Operation templates catalog — sourced via the canonical generic resource RPC
// (`public.ui_list_resource_v1('operation_templates')`). No dedicated
// `ui_list_operation_templates_v1` RPC exists in backend; this wrapper composes
// on top of the generic substrate so the swap point stays a single line.
export const ui_list_operation_templates_v1 = async (): Promise<{ rows: OperationTemplate[]; total: number }> => {
  const res = await ui_list_resource_v1<OperationTemplate>('operation_templates', {
    sort: { key: 'operation_name', dir: 'asc' },
  });
  return { rows: res.rows, total: res.total };
};

// REAUDIT INSIGHTS §D3 — facade is now `_v1` and consumes the canonical
// envelope `{correlation_id, observability_events, domain_events,
// workflow_runs}` from `public.ui_get_trace_v1(uuid)` (migration
// 202601051630_ui_get_trace_v1.sql). The legacy `{spans:[…]}` shape is
// retired; the FE renders the timeline from observability_events directly.
export const ui_get_trace_v1 = (correlationId: string): Promise<UiTrace> =>
  ds.ui_get_trace_v1(correlationId) as unknown as Promise<UiTrace>;
export type RunPluginTestResult = import('./data-source').RunPluginTestResult;
export const runPluginTest = (
  pluginId: string,
  payload: unknown,
  pluginVersionId?: string | null,
) => ds.runPluginTest(pluginId, payload, pluginVersionId);
export type RunWebhookReceiverTestArgs = import('./data-source').RunWebhookReceiverTestArgs;
export type RunWebhookReceiverTestResult = import('./data-source').RunWebhookReceiverTestResult;
export const runWebhookReceiverTest = (args: RunWebhookReceiverTestArgs) =>
  ds.runWebhookReceiverTest(args);
export type RunApiGatewayRequestTestArgs = import('./data-source').RunApiGatewayRequestTestArgs;
export type RunApiGatewayRequestTestResult = import('./data-source').RunApiGatewayRequestTestResult;
export const runApiGatewayRequestTest = (args: RunApiGatewayRequestTestArgs) =>
  ds.runApiGatewayRequestTest(args);

// ---------- INTEGRATIONS P0 (W12-2) — plugin-studio 4-stage authoring loop ----------
//
// Wires the `integration-plugin-studio` edge function (`supabase/functions/`)
// which exposes 4 endpoints used by the operator authoring UX:
//
//   parse   — normalize a curl/openapi/webhook sample into `normalized_contract`
//   infer   — derive a deterministic mapping suggestion + outbound suggestions
//   preview — validate mapping vs. target schema + egress policy, return
//             diagnostics/coercions and recommend save mode (direct vs draft)
//   save    — persist the artifact via `ui_upsert_mapping_artifact_v1` (direct)
//             or `integration_plugin_generate_draft_v1` (draft) and write a
//             canonical operation report through
//             `ui_create_mapping_operation_report_v1`.
//
// All stages call `getSupabaseClient()?.functions.invoke(...)` against the live
// edge fn when env is configured; the in-memory branch returns deterministic
// envelopes that mirror the wire shape so unit tests and the demo build stay
// environment-agnostic.
export type PluginStudioSourceType =
  import('./data-source').PluginStudioSourceType;
export type PluginStudioArtifact =
  import('./data-source').PluginStudioArtifact;
export type PluginStudioSaveMode =
  import('./data-source').PluginStudioSaveMode;
export type PluginStudioParseArgs =
  import('./data-source').PluginStudioParseArgs;
export type PluginStudioParseResult =
  import('./data-source').PluginStudioParseResult;
export type PluginStudioInferArgs =
  import('./data-source').PluginStudioInferArgs;
export type PluginStudioInferResult =
  import('./data-source').PluginStudioInferResult;
export type PluginStudioPreviewArgs =
  import('./data-source').PluginStudioPreviewArgs;
export type PluginStudioPreviewResult =
  import('./data-source').PluginStudioPreviewResult;
export type PluginStudioSaveArgs =
  import('./data-source').PluginStudioSaveArgs;
export type PluginStudioSaveResult =
  import('./data-source').PluginStudioSaveResult;
export type PluginStudioReview =
  import('./data-source').PluginStudioReview;
export type PluginStudioNormalizedContract =
  import('./data-source').PluginStudioNormalizedContract;

export const plugin_studio_parse_v1 = (
  args: PluginStudioParseArgs,
): Promise<PluginStudioParseResult> => ds.plugin_studio_parse_v1(args);
export const plugin_studio_infer_v1 = (
  args: PluginStudioInferArgs,
): Promise<PluginStudioInferResult> => ds.plugin_studio_infer_v1(args);
export const plugin_studio_preview_v1 = (
  args: PluginStudioPreviewArgs,
): Promise<PluginStudioPreviewResult> => ds.plugin_studio_preview_v1(args);
export const plugin_studio_save_v1 = (
  args: PluginStudioSaveArgs,
): Promise<PluginStudioSaveResult> => ds.plugin_studio_save_v1(args);

export type ResourceImportStudioPrepareArgs =
  import('./data-source').ResourceImportStudioPrepareArgs;
export type ResourceImportStudioPrepareResult =
  import('./data-source').ResourceImportStudioPrepareResult;
export type ResourceImportStudioStartArgs =
  import('./data-source').ResourceImportStudioStartArgs;
export type ResourceImportStudioStartResult =
  import('./data-source').ResourceImportStudioStartResult;
export type ResourceImportStudioCancelArgs =
  import('./data-source').ResourceImportStudioCancelArgs;
export type ResourceImportStudioCancelResult =
  import('./data-source').ResourceImportStudioCancelResult;

export const resource_import_studio_prepare_v1 = (
  args: ResourceImportStudioPrepareArgs,
): Promise<ResourceImportStudioPrepareResult> => ds.resource_import_studio_prepare_v1(args);
export const resource_import_studio_start_v1 = (
  args: ResourceImportStudioStartArgs,
): Promise<ResourceImportStudioStartResult> => ds.resource_import_studio_start_v1(args);
export const resource_import_studio_cancel_v1 = (
  args: ResourceImportStudioCancelArgs,
): Promise<ResourceImportStudioCancelResult> => ds.resource_import_studio_cancel_v1(args);

// ---------- Seed bridge (RETIRED — W56-B-2, F6) ----------
//
// The legacy `api.seed.*` namespace was retired in W56-B-2 (Cycle D
// cross-cutting SSOT closure). All ~12 module consumers and ~43 call sites
// migrated to the canonical `useResourceList<T>('<resource_key>')` /
// `api.ui_list_resource_v1<T>` registry-driven seam:
//
//   • src/modules/catalog/lookups.tsx              → useResourceList('lookup_values' / 'lookup_definitions')
//   • src/modules/finance/cod.tsx                  → useResourceList('cod_entries')
//   • src/modules/operate/exceptions.tsx           → useResourceList('shipments') + 'task_events'
//   • src/modules/operate/shipments.tsx            → useResourceList('clients' / 'senders' / 'recipients' / 'addresses' / 'shipment_boxes' / 'scan_events' / 'labels' / 'comms_attempts')
//   • src/modules/platform/auth-email.tsx          → useResourceList('auth_email_url_policy')
//   • src/modules/platform/planning-os.tsx         → useResourceList('planning_os_project_items' / 'planning_os_execution_cards')
//   • src/modules/platform/warehouse.tsx           → useResourceList('warehouse_transfer_summary' / 'warehouse_transfer_items' / 'warehouse_checkpoint_scans' / 'tasks')
//
// New registry entries added in W56-B-2 (mirroring the W54-F pattern):
// `cod_entries`, `planning_os_project_items`, `planning_os_execution_cards`,
// `auth_email_url_policy`, `warehouse_transfer_items`,
// `warehouse_checkpoint_scans`. Each is declared in `seed-raw/registry.js`
// (`ui_read_registry`) with a canonical
// `relation` / `id_column` / `capability_read` / `columns` shape and mirrored
// in `data-source.ts` (`RESOURCE_DATA()`).
//
// Production cutover stays a single getSupabaseClient() branch flip in
// `ui_list_resource_v1` — module call sites stay stable across demo/live
// planes. New modules MUST consume `useResourceList<T>('…')` and MUST NOT
// reintroduce an `api.seed.*` namespace. The seed-loader (`seed-loader.ts`)
// remains the single SSOT for the build-time `SEED_MODE_ENABLED` flag and
// drives the `data-source.ts` adapter; api.ts no longer needs to inspect
// the flag because every previously-gated path is now resolved through
// `ui_list_resource_v1` (which short-circuits to the `getSupabaseClient()`
// branch in live mode).

// ---------- Governance mirrors ----------
export const listProjectItems = () => ds.listProjectItems();
export const listExecutionCards = () => ds.listExecutionCards();
export const listWorkerClaims = () => ds.listWorkerClaims();
export const getAuthEmailUrlPolicy = () => ds.getAuthEmailUrlPolicy();

// ---------- Commands ----------
export const runCommand = (commandKey: string, params: unknown, opts?: { dryRun?: boolean }) =>
  ds.runCommand(commandKey, params, opts);

// ---------- Telemetry (UI events) ----------
export type UiLogEventOptions = ds.UiLogEventOptions;
export type UiLogEventResult = ds.UiLogEventResult;
export const ui_log_event_v1 = (
  eventJson: unknown,
  app = 'console',
  options?: UiLogEventOptions,
) => ds.ui_log_event_v1(eventJson, app, options);
export const ui_create_workflow_schedule_trigger_v1 = (args: {
  workflow_template_id: string;
  schedule: Record<string, unknown>;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
}): Promise<ds.WorkflowScheduleCreateResult> => ds.ui_create_workflow_schedule_trigger_v1(args);
export const ui_create_workflow_run_trigger_v1 = (args: {
  source_workflow_template_id: string;
  target_workflow_template_id: string;
  source_statuses?: string[] | null;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
  scope_id?: string | null;
}): Promise<ds.WorkflowRunTriggerCreateResult> => ds.ui_create_workflow_run_trigger_v1(args);
export const ui_update_workflow_run_trigger_v1 = (args: {
  workflow_run_trigger_id: string;
  source_workflow_template_id?: string | null;
  target_workflow_template_id?: string | null;
  source_statuses?: string[] | null;
  context_patch?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
  scope_id?: string | null;
}): Promise<ds.WorkflowRunTriggerUpdateResult> => ds.ui_update_workflow_run_trigger_v1(args);
export const ui_delete_workflow_run_trigger_v1 = (workflowRunTriggerId: string, scopeId?: string | null) =>
  ds.ui_delete_workflow_run_trigger_v1(workflowRunTriggerId, scopeId);
export const ui_run_workflow_schedule_trigger_v1 = (workflowScheduleTriggerId: string) =>
  ds.ui_run_workflow_schedule_trigger_v1(workflowScheduleTriggerId);
export const ui_repair_workflow_schedule_task_payload_v1 = (
  workflowScheduleTriggerId: string,
  taskPayload: Record<string, unknown> = {},
) => ds.ui_repair_workflow_schedule_task_payload_v1(workflowScheduleTriggerId, taskPayload);

// ---------- PHASE C6: PLATFORM + FLEET + SUPPORT mutation facades ----------
//
// Each facade mirrors a canonical Phase B RPC (single jsonb envelope `p_args`).
// Modules MUST consume these via the corresponding hooks in `queries.ts` so
// cache invalidation + toast plumbing remain uniform. The data-source adapter
// branches once on `getSupabaseClient()` so production cutover is environment-only.
//
// Migrations of record (verified):
//   • create_alert_rule_v1            202604280010
//   • update_alert_rule_v1            202604280020
//   • pause_alert_rule_v1             202604280030
//   • resume_alert_rule_v1            202604280040
//   • delete_alert_rule_v1            202604280050
//   • test_alert_rule_v1              202604280060
//   • acknowledge_ops_alert_v1        202604280070
//   • resolve_ops_alert_v1            202604280080
//   • toggle_feature_flag_v1          202604280090
//   • engage_kill_switch_v1           202604280100
//   • release_kill_switch_v1          202604280110
//   • set_rollout_v1                  202604280120
//   • bulk_toggle_feature_flags_v1    202604280130
//   • warehouse_transfer_execute_v1   202604280140 (replaces 202601 stub)
//   • request_capability_grant_v1     202604280150
//   • create_vehicle_v1               202605041630
//   • upload_vehicle_document_v1      202605041630
//   • assign_driver_to_vehicle_v1     202604280010
//   • unassign_driver_v1              202604280015
//   • mark_vehicle_oos_v1             202604280020
//   • restore_vehicle_v1              202604280025
//   • schedule_maintenance_v1         202604280030
//   • complete_maintenance_v1         202604280035
//   • cancel_maintenance_v1           202604280040
//   • record_vehicle_event_v1         202604280045
//   • verify_driver_document_v1       202604280050
//   • reject_driver_document_v1       202604280055
//   • suspend_driver_v1               202604280060
//   • restore_driver_v1               202604280065
//   • create_driver_compliance_event_v1 202604280070
//   • record_hours_of_service_segment_v1 202604280075
//   • create_support_case_v1          202604271220
//   • update_support_case_v1          202604271221
//   • assign_support_case_v1          202604271222
//   • bulk_assign_support_cases_v1    202604271223
//   • resolve_support_case_v1         202604271224
//   • bulk_resolve_support_cases_v1   202604271225
//   • reopen_support_case_v1          202604271226
//   • send_support_message_v1         202604271227
//   • add_support_tag_v1              202604271228
//   • tenant_signup_review_apply_v1   202602201010

// All RPCs return `{ ok, <resource>_id, correlation_id, settings_resolution_id }` shapes.
export interface MutationEnvelopeResult extends Record<string, unknown> {
  ok: true;
  correlation_id: string;
  settings_resolution_id?: string;
}

// PLATFORM — alerts
export const create_alert_rule_v1 = (args: Record<string, unknown>) => ds.create_alert_rule_v1(args);
export const update_alert_rule_v1 = (args: Record<string, unknown>) => ds.update_alert_rule_v1(args);
export const pause_alert_rule_v1 = (args: Record<string, unknown>) => ds.pause_alert_rule_v1(args);
export const resume_alert_rule_v1 = (args: Record<string, unknown>) => ds.resume_alert_rule_v1(args);
export const delete_alert_rule_v1 = (args: Record<string, unknown>) => ds.delete_alert_rule_v1(args);
export const test_alert_rule_v1 = (args: Record<string, unknown>) => ds.test_alert_rule_v1(args);
export const acknowledge_ops_alert_v1 = (args: Record<string, unknown>) => ds.acknowledge_ops_alert_v1(args);
export const resolve_ops_alert_v1 = (args: Record<string, unknown>) => ds.resolve_ops_alert_v1(args);

// PLATFORM — feature flags
export const toggle_feature_flag_v1 = (args: Record<string, unknown>) => ds.toggle_feature_flag_v1(args);
export const engage_kill_switch_v1 = (args: Record<string, unknown>) => ds.engage_kill_switch_v1(args);
export const release_kill_switch_v1 = (args: Record<string, unknown>) => ds.release_kill_switch_v1(args);
export const set_rollout_v1 = (args: Record<string, unknown>) => ds.set_rollout_v1(args);
export const bulk_toggle_feature_flags_v1 = (args: Record<string, unknown>) => ds.bulk_toggle_feature_flags_v1(args);
export const create_feature_flag_v1 = (args: Record<string, unknown>) => ds.create_feature_flag_v1(args);
export const update_feature_flag_v1 = (args: Record<string, unknown>) => ds.update_feature_flag_v1(args);

// PLATFORM — access (capability grants) replaces PREVIEW
export const request_capability_grant_v1 = (args: Record<string, unknown>) => ds.request_capability_grant_v1(args);
export const ui_review_capability_grant_request_v1 = (args: Record<string, unknown>) =>
  ds.ui_review_capability_grant_request_v1(args);

// PLATFORM — imports (W16-5). Replaces the /platform/imports PREVIEW chip with
// canonical write RPCs against public.import_jobs. Migrations:
//   • import_job_create_v1  202604301905
//   • import_job_cancel_v1  202604301905
// Both return `{ ok, import_job_id, status, correlation_id, settings_resolution_id }`.
export const import_job_create_v1 = (args: Record<string, unknown>) => ds.import_job_create_v1(args);
export const import_job_cancel_v1 = (args: Record<string, unknown>) => ds.import_job_cancel_v1(args);

// PLATFORM — RBAC role-management lifecycle (Phase E3 / IDENTITY P0).
// Backend RPC verification status (capability `access_policy.approve`):
//   - rbac_create_role_v1     SHIPPED in supabase/migrations/202604290100_rbac_create_role_v1.sql.
//   - rbac_update_role_v1     SHIPPED in supabase/migrations/202604290110_rbac_update_role_v1.sql.
//   - rbac_delete_role_v1     SHIPPED in supabase/migrations/202604290120_rbac_delete_role_v1.sql.
//   - rbac_grant_role_v1      SHIPPED in supabase/migrations/202604290130_rbac_grant_role_v1.sql.
//   - rbac_revoke_role_v1     SHIPPED in supabase/migrations/202604290140_rbac_revoke_role_v1.sql.
//   - provision_rbac_roles_from_templates_v1 — SHIPPED in supabase/migrations/202601300050_rbac_role_templates_v1.sql:215-289.
// Backend tables exist + RLS enforced (202601300030 + 202601300050).
// Wave 6 promoted the FE adapters from the generic phaseC6Rpc shim to typed
// facades; api.ts re-exports the typed signatures (Rbac*MutationResult).
export const rbac_create_role_v1 = (args: Record<string, unknown>): Promise<RbacRoleMutationResult> =>
  ds.rbac_create_role_v1(args);
export const rbac_update_role_v1 = (args: Record<string, unknown>): Promise<RbacRoleMutationResult> =>
  ds.rbac_update_role_v1(args);
export const rbac_delete_role_v1 = (args: Record<string, unknown>): Promise<RbacRoleMutationResult> =>
  ds.rbac_delete_role_v1(args);
export const rbac_grant_role_v1 = (
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> => ds.rbac_grant_role_v1(args);
export const rbac_revoke_role_v1 = (
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> => ds.rbac_revoke_role_v1(args);
export const provision_rbac_roles_from_templates_v1 = (args: Record<string, unknown>) =>
  ds.provision_rbac_roles_from_templates_v1(args);
export type { RbacRoleMutationResult, RbacUserRoleAssignmentMutationResult };

// PLATFORM — organizations (tenant signup review)
export const tenant_signup_review_apply_v1 = (args: Record<string, unknown>) => ds.tenant_signup_review_apply_v1(args);
export interface TenantSignupConsoleRequestArgs extends Record<string, unknown> {
  email: string;
  full_name: string;
  organization_name: string;
  organization_slug?: string | null;
  website_url?: string | null;
  phone?: string | null;
  notes?: string | null;
  locale?: string | null;
}
export const tenant_signup_console_request_v1 = (
  args: TenantSignupConsoleRequestArgs,
): Promise<Record<string, unknown>> => ds.tenant_signup_console_request_v1(args);
export interface OrganizationProfileUpdateArgs extends Record<string, unknown> {
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
export const ui_update_organization_profile_v1 = (
  args: OrganizationProfileUpdateArgs,
): Promise<Record<string, unknown>> => ds.ui_update_organization_profile_v1(args);
export const ui_list_tenant_invitable_roles_v1 = (
  args: { organization_id?: string | null } = {},
): Promise<ListResult<Record<string, unknown>>> => ds.ui_list_tenant_invitable_roles_v1(args);
export interface TenantUserInviteArgs extends Record<string, unknown> {
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
export const tenant_user_invite_v1 = (
  args: TenantUserInviteArgs,
): Promise<Record<string, unknown>> => ds.tenant_user_invite_v1(args);
export const ui_get_onboarding_readiness_v1 = (args: {
  scope_type: UiOnboardingReadiness['scope_type'];
  scope_id?: string | null;
}): Promise<UiOnboardingReadiness> => ds.ui_get_onboarding_readiness_v1(args);
export const ui_execute_onboarding_bootstrap_v1 = (args: {
  scope_type: UiOnboardingReadiness['scope_type'];
  scope_id: string;
}): Promise<Record<string, unknown>> => ds.ui_execute_onboarding_bootstrap_v1(args);

// FLEET — vehicles
export const create_vehicle_v1 = (args: Record<string, unknown>) => ds.create_vehicle_v1(args);
export const upload_vehicle_document_v1 = (args: Record<string, unknown>) => ds.upload_vehicle_document_v1(args);
export const assign_driver_to_vehicle_v1 = (args: Record<string, unknown>) => ds.assign_driver_to_vehicle_v1(args);
export const unassign_driver_v1 = (args: Record<string, unknown>) => ds.unassign_driver_v1(args);
export const mark_vehicle_oos_v1 = (args: Record<string, unknown>) => ds.mark_vehicle_oos_v1(args);
export const restore_vehicle_v1 = (args: Record<string, unknown>) => ds.restore_vehicle_v1(args);
export const schedule_maintenance_v1 = (args: Record<string, unknown>) => ds.schedule_maintenance_v1(args);
export const complete_maintenance_v1 = (args: Record<string, unknown>) => ds.complete_maintenance_v1(args);
export const cancel_maintenance_v1 = (args: Record<string, unknown>) => ds.cancel_maintenance_v1(args);
export const record_vehicle_event_v1 = (args: Record<string, unknown>) => ds.record_vehicle_event_v1(args);

// FLEET — drivers
export const create_driver_v1 = (args: Record<string, unknown>) => ds.create_driver_v1(args);
export const upload_driver_document_v1 = (args: Record<string, unknown>) => ds.upload_driver_document_v1(args);
export const suspend_driver_v1 = (args: Record<string, unknown>) => ds.suspend_driver_v1(args);
export const restore_driver_v1 = (args: Record<string, unknown>) => ds.restore_driver_v1(args);
export const verify_driver_document_v1 = (args: Record<string, unknown>) => ds.verify_driver_document_v1(args);
export const reject_driver_document_v1 = (args: Record<string, unknown>) => ds.reject_driver_document_v1(args);
export const create_driver_compliance_event_v1 = (args: Record<string, unknown>) => ds.create_driver_compliance_event_v1(args);
export const record_hours_of_service_segment_v1 = (args: Record<string, unknown>) => ds.record_hours_of_service_segment_v1(args);

// SUPPORT — cases
//
// Wave 5 RE-AUDIT (SUPPORT.md §8 D1) — payload-key alignment:
// The canonical Phase B3 RPCs are strict on argument keys (`23502` raise on
// missing). FE call sites now send the canonical RPC contract keys directly
// (`assigned_to`, `support_case_ids`, `resolution`) so production cloud swap
// passes the contract gate without facade-layer renaming.
//
// Backend SSOT references:
//   - assign_support_case_v1         202604271222  (assigned_to)
//   - bulk_assign_support_cases_v1   202604271223  (support_case_ids, assigned_to)
//   - resolve_support_case_v1        202604271224  (resolution)
//   - bulk_resolve_support_cases_v1  202604271225  (support_case_ids, resolution)
export const create_support_case_v1 = (args: Record<string, unknown>) => ds.create_support_case_v1(args);
export const update_support_case_v1 = (args: Record<string, unknown>) => ds.update_support_case_v1(args);
export const assign_support_case_v1 = (args: Record<string, unknown>) => ds.assign_support_case_v1(args);
export const escalate_support_case_v1 = (args: Record<string, unknown>) => ds.escalate_support_case_v1(args);
export const bulk_assign_support_cases_v1 = (args: Record<string, unknown>) => ds.bulk_assign_support_cases_v1(args);
export const resolve_support_case_v1 = (args: Record<string, unknown>) => ds.resolve_support_case_v1(args);
export const bulk_resolve_support_cases_v1 = (args: Record<string, unknown>) => ds.bulk_resolve_support_cases_v1(args);
export const reopen_support_case_v1 = (args: Record<string, unknown>) => ds.reopen_support_case_v1(args);
export const send_support_message_v1 = (args: Record<string, unknown>) => ds.send_support_message_v1(args);
export const add_support_tag_v1 = (args: Record<string, unknown>) => ds.add_support_tag_v1(args);
export const public_tracking_review_request_v1 = (args: Record<string, unknown>) =>
  ds.public_tracking_review_request_v1(args);

// ---------- PHASE B5/C4: FINANCE mutation facades ----------
//
// Each facade mirrors a Phase B5 canonical RPC. Modules MUST consume these via
// the corresponding hooks in `queries.ts` (useCreateBillingInvoice, useApplySettlement,
// useResolveDispute, ...) so cache invalidation + toast plumbing stay uniform.
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
// Capability split (canonical SSOT — registry seeded by 202604281000):
//   billing.read, billing.write, invoices.send, invoices.refund,
//   settlements.read, settlements.write, disputes.read, disputes.write
//   plus reuse of canonical finance.write for bank_recon match/unmatch.

// FINANCE — billing invoices (typed args + return; matches Phase B5 contract)
//
// Each Result interface mirrors the canonical RPC return envelope from the
// backing migration (RETURN jsonb_build_object(...)). See the migration ids
// noted above each facade for the SSOT shape. The api.ts facade now calls
// `ds.<rpc>(args)` directly (W54-F closure of the typed-contract cleanup) and
// re-types the loose `Promise<Record<string, unknown>>` envelope returned by
// the data-source's generic `phaseC6Rpc(...)` helper to the precise canonical
// `Result` shape so consumers compile against the migration contract.
export interface CreateBillingInvoiceArgs extends Record<string, unknown> {
  client_id: string;
  organization_id?: string | null;
  sender_id?: string;
  currency: string;
  subtotal?: number;
  tax_total?: number;
  total?: number;
  period_start_at?: string;
  period_end_at?: string;
  due_at?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}
// Canonical envelope (202604281010 + 202605171230):
// { ok, billing_invoice_id, invoice_number, correlation_id, settings_resolution_id }
export interface CreateBillingInvoiceResult extends MutationEnvelopeResult {
  billing_invoice_id: string;
  invoice_number?: string;
}
export const create_billing_invoice_v1 = (args: CreateBillingInvoiceArgs): Promise<CreateBillingInvoiceResult> =>
  ds.create_billing_invoice_v1(args) as Promise<CreateBillingInvoiceResult>;

export interface UpdateBillingInvoiceArgs extends Record<string, unknown> {
  billing_invoice_id: string;
  currency?: string;
  subtotal?: number;
  tax_total?: number;
  total?: number;
  period_start_at?: string;
  period_end_at?: string;
  due_at?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281020): { ok, billing_invoice_id, correlation_id, settings_resolution_id, version }
export interface UpdateBillingInvoiceResult extends MutationEnvelopeResult {
  billing_invoice_id: string;
  version: number;
}
export const update_billing_invoice_v1 = (args: UpdateBillingInvoiceArgs): Promise<UpdateBillingInvoiceResult> =>
  ds.update_billing_invoice_v1(args) as Promise<UpdateBillingInvoiceResult>;

export interface VoidBillingInvoiceArgs extends Record<string, unknown> {
  billing_invoice_id: string;
  status_reason: string;
}
// Canonical envelope (202604281030): { ok, billing_invoice_id, correlation_id, settings_resolution_id, version }
export interface VoidBillingInvoiceResult extends MutationEnvelopeResult {
  billing_invoice_id: string;
  version: number;
}
export const void_billing_invoice_v1 = (args: VoidBillingInvoiceArgs): Promise<VoidBillingInvoiceResult> =>
  ds.void_billing_invoice_v1(args) as Promise<VoidBillingInvoiceResult>;

export interface BillingInvoiceSendArgs extends Record<string, unknown> {
  billing_invoice_id: string;
  invoice_number?: string;
  due_at?: string;
}
// Canonical envelope (202604281040): { ok, billing_invoice_id, correlation_id, settings_resolution_id,
//   version, invoice_number, issued_at, already_processed? }
export interface BillingInvoiceSendResult extends MutationEnvelopeResult {
  billing_invoice_id: string;
  version: number;
  invoice_number: string;
  issued_at: string;
  already_processed?: boolean;
}
export const billing_invoice_send_v1 = (args: BillingInvoiceSendArgs): Promise<BillingInvoiceSendResult> =>
  ds.billing_invoice_send_v1(args) as Promise<BillingInvoiceSendResult>;

export interface BulkMutationRowResult extends Record<string, unknown> {
  ok: boolean;
  error?: string;
  error_code?: string;
  result?: Record<string, unknown>;
}
export interface BulkMutationResult extends Record<string, unknown> {
  ok: boolean;
  operation: string;
  succeeded_count: number;
  failed_count: number;
  results: BulkMutationRowResult[];
}
export interface BulkBillingInvoiceSendArgs extends Record<string, unknown> {
  billing_invoice_ids: string[];
  invoice_numbers?: Record<string, string>;
  due_at?: string;
}
export const ui_bulk_billing_invoice_send_v1 = (
  args: BulkBillingInvoiceSendArgs,
): Promise<BulkMutationResult> =>
  ds.ui_bulk_billing_invoice_send_v1(args) as Promise<BulkMutationResult>;

export interface BillingInvoiceRefundArgs extends Record<string, unknown> {
  billing_invoice_id: string;
  refund_amount: number;
  refund_reason: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281050): { ok, billing_invoice_id, correlation_id, settings_resolution_id,
//   version, refunded_amount, status }
export interface BillingInvoiceRefundResult extends MutationEnvelopeResult {
  billing_invoice_id: string;
  version: number;
  refunded_amount: number;
  status: string;
}
export const billing_invoice_refund_v1 = (args: BillingInvoiceRefundArgs): Promise<BillingInvoiceRefundResult> =>
  ds.billing_invoice_refund_v1(args) as Promise<BillingInvoiceRefundResult>;

export interface BillingInvoiceMarkPaidArgs extends Record<string, unknown> {
  billing_invoice_id: string;
  payment_amount: number;
  payment_reference: string;
  paid_at?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202605241430): { ok, billing_invoice_id, correlation_id,
// settings_resolution_id, version, paid_amount, status, paid_at }
export interface BillingInvoiceMarkPaidResult extends MutationEnvelopeResult {
  billing_invoice_id: string;
  version: number;
  paid_amount: number;
  status: string;
  paid_at: string;
}
export const billing_invoice_mark_paid_v1 = (
  args: BillingInvoiceMarkPaidArgs,
): Promise<BillingInvoiceMarkPaidResult> =>
  ds.billing_invoice_mark_paid_v1(args) as Promise<BillingInvoiceMarkPaidResult>;

export interface CancelSubscriptionArgs extends Record<string, unknown> {
  subscription_id: string;
  cancellation_reason: string;
  ends_at?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281120): { ok, subscription_id, correlation_id, settings_resolution_id,
//   version, status, ends_at }
export interface CancelSubscriptionResult extends MutationEnvelopeResult {
  subscription_id: string;
  version: number;
  status: string;
  ends_at: string | null;
}
export const cancel_subscription_v1 = (args: CancelSubscriptionArgs): Promise<CancelSubscriptionResult> =>
  ds.cancel_subscription_v1(args) as Promise<CancelSubscriptionResult>;

// FINANCE — settlements
export interface ApplySettlementArgs extends Record<string, unknown> {
  settlement_batch_id: string;
  approval_notes?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281060): { ok, settlement_batch_id, correlation_id, settings_resolution_id,
//   version, status }
export interface ApplySettlementResult extends MutationEnvelopeResult {
  settlement_batch_id: string;
  version: number;
  status: string;
}
export const apply_settlement_v1 = (args: ApplySettlementArgs): Promise<ApplySettlementResult> =>
  ds.apply_settlement_v1(args) as Promise<ApplySettlementResult>;

export interface RejectSettlementArgs extends Record<string, unknown> {
  settlement_batch_id: string;
  rejection_reason: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281070): { ok, settlement_batch_id, correlation_id, settings_resolution_id,
//   version, status }
export interface RejectSettlementResult extends MutationEnvelopeResult {
  settlement_batch_id: string;
  version: number;
  status: string;
}
export const reject_settlement_v1 = (args: RejectSettlementArgs): Promise<RejectSettlementResult> =>
  ds.reject_settlement_v1(args) as Promise<RejectSettlementResult>;

export interface CreateSettlementBatchArgs extends Record<string, unknown> {
  kind?: string;
  scope_type: string;
  branch_id?: string | null;
  client_id?: string | null;
  sender_id?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  window_start_at?: string | null;
  window_end_at?: string | null;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}
export interface CreateSettlementBatchResult extends MutationEnvelopeResult {
  settlement_batch_id: string;
  settlement_event_id?: string | null;
  created?: boolean;
  version?: number;
  status?: string;
}
export const ui_create_settlement_batch_v1 = (
  args: CreateSettlementBatchArgs,
): Promise<CreateSettlementBatchResult> =>
  ds.ui_create_settlement_batch_v1(args) as Promise<CreateSettlementBatchResult>;

export interface TransitionSettlementBatchArgs extends Record<string, unknown> {
  settlement_batch_id: string;
  to_status: string;
  status_reason?: string;
  payload?: Record<string, unknown>;
  idempotency_key?: string;
  ops_session_id?: string;
}
export interface TransitionSettlementBatchResult extends MutationEnvelopeResult {
  settlement_batch_id: string;
  settlement_event_id?: string | null;
  version?: number;
  status?: string;
}
export const ui_transition_settlement_batch_v1 = (
  args: TransitionSettlementBatchArgs,
): Promise<TransitionSettlementBatchResult> =>
  ds.ui_transition_settlement_batch_v1(args) as Promise<TransitionSettlementBatchResult>;

export interface CodRemittanceArgs extends Record<string, unknown> {
  cod_entry_id?: string | null;
  settlement_batch_id?: string | null;
  amount: number;
  currency?: string;
  reason: string;
  from_account_type?: string | null;
  from_account_id?: string | null;
  to_account_type?: string | null;
  to_account_id?: string | null;
  occurred_at?: string | null;
  idempotency_key?: string;
}
export interface CodRemittanceResult extends MutationEnvelopeResult {
  transfer_id: string;
  from_finance_event_id: string;
  to_finance_event_id: string;
  settlement_event_id?: string | null;
  attached?: boolean;
}
export const ui_record_cod_remittance_v1 = (
  args: CodRemittanceArgs,
): Promise<CodRemittanceResult> =>
  ds.ui_record_cod_remittance_v1(args) as Promise<CodRemittanceResult>;

export interface CodCollectionAdjustmentArgs extends Record<string, unknown> {
  cod_entry_id: string;
  adjustment_amount: number;
  currency?: string;
  reason: string;
  settlement_batch_id?: string | null;
  occurred_at?: string | null;
  idempotency_key?: string;
}
export interface CodCollectionAdjustmentResult extends MutationEnvelopeResult {
  finance_event_id: string;
  settlement_event_id?: string | null;
  attached?: boolean;
}
export const ui_adjust_cod_collection_v1 = (
  args: CodCollectionAdjustmentArgs,
): Promise<CodCollectionAdjustmentResult> =>
  ds.ui_adjust_cod_collection_v1(args) as Promise<CodCollectionAdjustmentResult>;

export interface FinanceEventReverseArgs extends Record<string, unknown> {
  finance_event_id: string;
  finance_occurred_at?: string;
  reason: string;
  idempotency_key?: string;
}
export interface FinanceEventReverseResult extends MutationEnvelopeResult {
  finance_event_id: string;
  reversed_finance_event_id: string;
}
export const ui_reverse_finance_event_v1 = (
  args: FinanceEventReverseArgs,
): Promise<FinanceEventReverseResult> =>
  ds.ui_reverse_finance_event_v1(args) as Promise<FinanceEventReverseResult>;

// FINANCE — bank reconciliation
export interface BankReconMatchArgs extends Record<string, unknown> {
  bank_statement_event_id: string;
  bank_statement_occurred_at: string;
  resource_type: string;
  resource_id: string;
  matched_amount: number;
  currency: string;
  match_reason?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281080): { ok, bank_recon_match_id, correlation_id, settings_resolution_id }
export interface BankReconMatchResult extends MutationEnvelopeResult {
  bank_recon_match_id: string;
}
export const bank_recon_match_v1 = (args: BankReconMatchArgs): Promise<BankReconMatchResult> =>
  ds.bank_recon_match_v1(args) as Promise<BankReconMatchResult>;

export interface BankReconUnmatchArgs extends Record<string, unknown> {
  bank_recon_match_id: string;
  unmatch_reason: string;
}
// Canonical envelope (202604281090): { ok, bank_recon_match_id, correlation_id, settings_resolution_id, status }
export interface BankReconUnmatchResult extends MutationEnvelopeResult {
  bank_recon_match_id: string;
  status: string;
}
export const bank_recon_unmatch_v1 = (args: BankReconUnmatchArgs): Promise<BankReconUnmatchResult> =>
  ds.bank_recon_unmatch_v1(args) as Promise<BankReconUnmatchResult>;

export interface BankStatementIngestArgs extends Record<string, unknown> {
  bank_account_id: string;
  bank_account_key?: string | null;
  direction: string;
  amount: number;
  currency: string;
  occurred_at: string;
  idempotency_key: string;
  metadata?: Record<string, unknown>;
}
export interface BankStatementIngestResult extends MutationEnvelopeResult {
  finance_event_id: string;
  created: boolean;
  decision_log_id?: string | null;
}
export const ui_record_bank_statement_event_v1 = (
  args: BankStatementIngestArgs,
): Promise<BankStatementIngestResult> =>
  ds.ui_record_bank_statement_event_v1(args) as Promise<BankStatementIngestResult>;

// FINANCE — disputes (FINANCE namespace; uses `disputes.write` capability,
// distinct from MARKETPLACE-namespace `marketplace_disputes.write`).
export interface BankAccountCreateArgs extends Record<string, unknown> {
  organization_id?: string | null;
  key: string;
  name: string;
  bank_name?: string | null;
  currency: string;
  iban_last4?: string | null;
  account_last4?: string | null;
  metadata?: Record<string, unknown>;
}
export interface BankAccountCreateResult extends MutationEnvelopeResult {
  bank_account_id: string;
  key: string;
  organization_id: string;
}
export const ui_create_bank_account_v1 = (
  args: BankAccountCreateArgs,
): Promise<BankAccountCreateResult> =>
  ds.ui_create_bank_account_v1(args) as Promise<BankAccountCreateResult>;

export interface DisputeResolveArgs extends Record<string, unknown> {
  dispute_id: string;
  resolution: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281100): { ok, dispute_id, correlation_id, settings_resolution_id, status }
export interface DisputeResolveResult extends MutationEnvelopeResult {
  dispute_id: string;
  status: string;
}
export const dispute_resolve_v1 = (args: DisputeResolveArgs): Promise<DisputeResolveResult> =>
  ds.dispute_resolve_v1(args) as Promise<DisputeResolveResult>;

export interface DisputeRejectArgs extends Record<string, unknown> {
  dispute_id: string;
  rejection_reason: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281110): { ok, dispute_id, correlation_id, settings_resolution_id, status }
export interface DisputeRejectResult extends MutationEnvelopeResult {
  dispute_id: string;
  status: string;
}
export const dispute_reject_v1 = (args: DisputeRejectArgs): Promise<DisputeRejectResult> =>
  ds.dispute_reject_v1(args) as Promise<DisputeRejectResult>;

export interface BulkDisputeActionArgs extends Record<string, unknown> {
  dispute_ids: string[];
  operation: 'resolve' | 'reject' | 'acknowledge' | 'escalate';
  resolution?: string;
  rejection_reason?: string;
  acknowledgement_notes?: string;
  escalation_reason?: string;
  metadata?: Record<string, unknown>;
}
export const ui_bulk_dispute_action_v1 = (
  args: BulkDisputeActionArgs,
): Promise<BulkMutationResult> =>
  ds.ui_bulk_dispute_action_v1(args) as Promise<BulkMutationResult>;

// W8-4 / W9-3 — non-terminal dispute lifecycle (capability: disputes.write).
// Migrations: 202604301140 (acknowledge) + 202604301150 (escalate).
export interface DisputeAcknowledgeArgs extends Record<string, unknown> {
  dispute_id: string;
  acknowledgement_notes?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604301140): { ok, dispute_id, correlation_id,
// settings_resolution_id, status, already_processed? }
export interface DisputeAcknowledgeResult extends MutationEnvelopeResult {
  dispute_id: string;
  status: string;
  already_processed?: boolean;
}
export const dispute_acknowledge_v1 = (
  args: DisputeAcknowledgeArgs,
): Promise<DisputeAcknowledgeResult> =>
  ds.dispute_acknowledge_v1(args) as Promise<DisputeAcknowledgeResult>;

export interface DisputeEscalateArgs extends Record<string, unknown> {
  dispute_id: string;
  escalation_reason: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604301150): { ok, dispute_id, correlation_id,
// settings_resolution_id, status, escalation_count }
export interface DisputeEscalateResult extends MutationEnvelopeResult {
  dispute_id: string;
  status: string;
  escalation_count: number;
}
export const dispute_escalate_v1 = (
  args: DisputeEscalateArgs,
): Promise<DisputeEscalateResult> =>
  ds.dispute_escalate_v1(args) as Promise<DisputeEscalateResult>;

// ---------- INSIGHTS — API gateway operational write contract ----------
//
// REAUDIT INSIGHTS §D1, §D2 closure. Both facades route through the canonical
// envelope (`p_args jsonb` -> `{ ok, source_id, … , correlation_id }`) and
// surface the standard Phase B contract: capability-gated (api_gateway.write),
// idempotent, audit-logged. Modules consume these via `useBlockApiGatewaySource`
// + `useAdjustApiGatewayRateLimit` hooks in queries.ts.
//
// Migrations of record (verified):
//   • block_api_gateway_source_v1            202604280330
//   • adjust_api_gateway_rate_limit_v1       202604280331

export interface BlockApiGatewaySourceArgs extends Record<string, unknown> {
  source_id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const block_api_gateway_source_v1 = (args: BlockApiGatewaySourceArgs) =>
  ds.block_api_gateway_source_v1(args);

export interface AdjustApiGatewayRateLimitArgs extends Record<string, unknown> {
  source_id: string;
  /** Server-canonical bucket size (per hour). One of limit_per_hour /
   *  limit_per_min must be present. */
  limit_per_hour?: number;
  /** FE-side per-minute display value; backend derives `limit_per_hour`
   *  as `limit_per_min × 60` when only the per-min value is supplied. */
  limit_per_min?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const adjust_api_gateway_rate_limit_v1 = (args: AdjustApiGatewayRateLimitArgs) =>
  ds.adjust_api_gateway_rate_limit_v1(args);

// ---------- PHASE C3: CUSTOMERS + CATALOG mutation facades ----------
//
// Each facade mirrors a Phase B6 canonical RPC. Modules MUST consume these via
// the corresponding hooks in `queries.ts` (useSuspendClient, useReactivateSender,
// useCreateServiceOffering, useCreateLookupValue, ...) so cache invalidation +
// toast plumbing stay uniform. The data-source adapter branches once on
// `getSupabaseClient()` so production cutover is environment-only.
//
// Migrations of record (verified):
//   • client_suspend_v1            202604280214
//   • client_reactivate_v1         202604280215
//   • sender_suspend_v1            202604280216
//   • sender_reactivate_v1         202604280217
//   • service_offering_create_v1   202604280201
//   • service_offering_update_v1   202604280202
//   • service_offering_archive_v1  202604280203
//   • service_offering_toggle_v1   202604280204
//   • service_level_create_v1      202604280205
//   • service_level_update_v1      202604280206
//   • lookup_definition_create_v1  202604280207
//   • lookup_value_create_v1       202604280208
//   • lookup_value_update_v1       202604280209
//   • lookup_value_archive_v1      202604280210
//   • lookup_value_promote_v1      202604280211
//
// Capability split (canonical SSOT):
//   clients.write, senders.write,
//   agreements.write (alias service_offerings.write), lookups.write.

// CUSTOMERS — clients lifecycle
export interface ClientSuspendArgs extends Record<string, unknown> {
  client_id: string;
  organization_id?: string;
  reason?: string;
}
export const client_suspend_v1 = (args: ClientSuspendArgs) =>
  ds.client_suspend_v1(args);

export interface ClientReactivateArgs extends Record<string, unknown> {
  client_id: string;
  organization_id?: string;
}
export const client_reactivate_v1 = (args: ClientReactivateArgs) =>
  ds.client_reactivate_v1(args);

// CUSTOMERS — senders lifecycle
export interface SenderSuspendArgs extends Record<string, unknown> {
  sender_id: string;
  reason?: string;
}
export const sender_suspend_v1 = (args: SenderSuspendArgs) =>
  ds.sender_suspend_v1(args);

export interface SenderReactivateArgs extends Record<string, unknown> {
  sender_id: string;
}
export const sender_reactivate_v1 = (args: SenderReactivateArgs) =>
  ds.sender_reactivate_v1(args);

// CUSTOMERS — clients create/update (Wave 6)
//   • client_create_v1   202604301000
//   • client_update_v1   202604301010
export interface ClientCreateArgs extends Record<string, unknown> {
  name: string;
  slug: string;
  sla_tier?: string;
  account_manager_id?: string | null;
  contract_start_date?: string | null;
  contract_end_date?: string | null;
  organization_id?: string;
  settings_override?: Record<string, unknown> | null;
}
export interface ClientCreateResult extends MutationEnvelopeResult {
  client_id: string;
}
export const client_create_v1 = (args: ClientCreateArgs): Promise<ClientCreateResult> =>
  ds.client_create_v1(args) as unknown as Promise<ClientCreateResult>;

export interface ClientUpdateArgs extends Record<string, unknown> {
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
}
export interface ClientUpdateResult extends MutationEnvelopeResult {
  client_id: string;
  idempotent_no_op: boolean;
}
export const client_update_v1 = (args: ClientUpdateArgs): Promise<ClientUpdateResult> =>
  ds.client_update_v1(args) as unknown as Promise<ClientUpdateResult>;

// CUSTOMERS — senders create/update (Wave 6)
//   • sender_create_v1   202604301020
//   • sender_update_v1   202604301030
export interface SenderCreateArgs extends Record<string, unknown> {
  client_id: string;
  name: string;
  brand_name?: string;
  auto_recreate?: boolean;
  settings_override?: Record<string, unknown> | null;
}
export interface SenderCreateResult extends MutationEnvelopeResult {
  sender_id: string;
}
export const sender_create_v1 = (args: SenderCreateArgs): Promise<SenderCreateResult> =>
  ds.sender_create_v1(args) as unknown as Promise<SenderCreateResult>;

export interface SenderUpdateArgs extends Record<string, unknown> {
  sender_id: string;
  name?: string;
  brand_name?: string | null;
  auto_recreate?: boolean;
  warehouse_address_id?: string | null;
  settings_override?: Record<string, unknown> | null;
}
export interface SenderUpdateResult extends MutationEnvelopeResult {
  sender_id: string;
  idempotent_no_op: boolean;
}
export const sender_update_v1 = (args: SenderUpdateArgs): Promise<SenderUpdateResult> =>
  ds.sender_update_v1(args) as unknown as Promise<SenderUpdateResult>;

// CUSTOMERS — recipient operator lifecycle
//   • recipient_create_v1   202605031940
//   • recipient_update_v1   202604301040
//   • recipient_delete_v1   202605031940
//
// Operator-side correction RPC (NDR triage). Distinct from any future
// portal self-edit RPC — see __audit__/CROSSWALK/CUSTOMERS.md §4.3.
export interface RecipientCreateArgs extends Record<string, unknown> {
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
}
export interface RecipientCreateResult extends MutationEnvelopeResult {
  recipient_id: string;
}
export const recipient_create_v1 = (args: RecipientCreateArgs): Promise<RecipientCreateResult> =>
  ds.recipient_create_v1(args) as unknown as Promise<RecipientCreateResult>;

export interface RecipientUpdateArgs extends Record<string, unknown> {
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
}
export interface RecipientUpdateResult extends MutationEnvelopeResult {
  recipient_id: string;
  idempotent_no_op: boolean;
}
export const recipient_update_v1 = (args: RecipientUpdateArgs): Promise<RecipientUpdateResult> =>
  ds.recipient_update_v1(args) as unknown as Promise<RecipientUpdateResult>;

export interface RecipientDeleteArgs extends Record<string, unknown> {
  recipient_id: string;
  reason?: string;
}
export interface RecipientDeleteResult extends MutationEnvelopeResult {
  recipient_id: string;
  deleted: boolean;
  shipment_reference_count?: number;
}
export const recipient_delete_v1 = (args: RecipientDeleteArgs): Promise<RecipientDeleteResult> =>
  ds.recipient_delete_v1(args) as unknown as Promise<RecipientDeleteResult>;

// CATALOG — service offerings
export interface ServiceOfferingCreateArgs extends Record<string, unknown> {
  service_level_id: string;
  branch_id?: string | null;
  zone_id?: string | null;
  priority?: number;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604280201): { ok, service_offering_id, correlation_id, settings_resolution_id }
export interface ServiceOfferingCreateResult extends MutationEnvelopeResult {
  service_offering_id: string;
}
export const service_offering_create_v1 = (args: ServiceOfferingCreateArgs): Promise<ServiceOfferingCreateResult> =>
  ds.service_offering_create_v1(args) as unknown as Promise<ServiceOfferingCreateResult>;

export interface ServiceOfferingUpdateArgs extends Record<string, unknown> {
  service_offering_id: string;
  zone_id?: string | null;
  priority?: number;
  effective_from?: string;
  effective_to?: string | null;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604280202): { ok, service_offering_id, correlation_id, settings_resolution_id }
export interface ServiceOfferingUpdateResult extends MutationEnvelopeResult {
  service_offering_id: string;
}
export const service_offering_update_v1 = (args: ServiceOfferingUpdateArgs): Promise<ServiceOfferingUpdateResult> =>
  ds.service_offering_update_v1(args) as unknown as Promise<ServiceOfferingUpdateResult>;

export interface ServiceOfferingArchiveArgs extends Record<string, unknown> {
  service_offering_id: string;
  reason?: string;
}
// Canonical envelope (202604280203): { ok, service_offering_id, correlation_id, settings_resolution_id }
export interface ServiceOfferingArchiveResult extends MutationEnvelopeResult {
  service_offering_id: string;
}
export const service_offering_archive_v1 = (args: ServiceOfferingArchiveArgs): Promise<ServiceOfferingArchiveResult> =>
  ds.service_offering_archive_v1(args) as unknown as Promise<ServiceOfferingArchiveResult>;

export interface ServiceOfferingToggleArgs extends Record<string, unknown> {
  service_offering_id: string;
  is_active?: boolean;
}
// Canonical envelope (202604280204): { ok, service_offering_id, is_active, correlation_id, settings_resolution_id }
export interface ServiceOfferingToggleResult extends MutationEnvelopeResult {
  service_offering_id: string;
  is_active: boolean;
}
export const service_offering_toggle_v1 = (args: ServiceOfferingToggleArgs): Promise<ServiceOfferingToggleResult> =>
  ds.service_offering_toggle_v1(args) as unknown as Promise<ServiceOfferingToggleResult>;

// CATALOG — service levels
export interface ServiceLevelCreateArgs extends Record<string, unknown> {
  key: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  organization_id?: string;
}
// Canonical envelope (202604280205): { ok, service_level_id, correlation_id, settings_resolution_id }
export interface ServiceLevelCreateResult extends MutationEnvelopeResult {
  service_level_id: string;
}
export const service_level_create_v1 = (args: ServiceLevelCreateArgs): Promise<ServiceLevelCreateResult> =>
  ds.service_level_create_v1(args) as unknown as Promise<ServiceLevelCreateResult>;

export interface ServiceLevelUpdateArgs extends Record<string, unknown> {
  service_level_id: string;
  name?: string;
  description?: string;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604280206): { ok, service_level_id, correlation_id, settings_resolution_id }
export interface ServiceLevelUpdateResult extends MutationEnvelopeResult {
  service_level_id: string;
}
export const service_level_update_v1 = (args: ServiceLevelUpdateArgs): Promise<ServiceLevelUpdateResult> =>
  ds.service_level_update_v1(args) as unknown as Promise<ServiceLevelUpdateResult>;

// CATALOG — lookup definitions
export interface LookupDefinitionCreateArgs extends Record<string, unknown> {
  category: string;
  description?: string;
  owner_role?: string;
  approval_policy?: string;
  is_mutable?: boolean;
  scope_type?: string;
  organization_id?: string;
}
// Canonical envelope (202604280207): { ok, lookup_definition_id, scope_type, correlation_id, settings_resolution_id }
export interface LookupDefinitionCreateResult extends MutationEnvelopeResult {
  lookup_definition_id: string;
  scope_type: string;
}
export const lookup_definition_create_v1 = (args: LookupDefinitionCreateArgs): Promise<LookupDefinitionCreateResult> =>
  ds.lookup_definition_create_v1(args) as unknown as Promise<LookupDefinitionCreateResult>;

// CATALOG — lookup values
export interface LookupValueCreateArgs extends Record<string, unknown> {
  lookup_definition_id?: string;
  category?: string;
  value: string;
  label: string;
  description?: string;
  sort_order?: number;
  metadata?: Record<string, unknown>;
  status?: 'draft' | 'active' | 'archived';
}
// Canonical envelope (202604280208): { ok, lookup_value_id, correlation_id, settings_resolution_id }
export interface LookupValueCreateResult extends MutationEnvelopeResult {
  lookup_value_id: string;
}
export const lookup_value_create_v1 = (args: LookupValueCreateArgs): Promise<LookupValueCreateResult> =>
  ds.lookup_value_create_v1(args) as unknown as Promise<LookupValueCreateResult>;

export interface LookupValueUpdateArgs extends Record<string, unknown> {
  lookup_value_id: string;
  label?: string;
  description?: string;
  sort_order?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604280209): { ok, lookup_value_id, revision, correlation_id, settings_resolution_id }
export interface LookupValueUpdateResult extends MutationEnvelopeResult {
  lookup_value_id: string;
  revision: number;
}
export const lookup_value_update_v1 = (args: LookupValueUpdateArgs): Promise<LookupValueUpdateResult> =>
  ds.lookup_value_update_v1(args) as unknown as Promise<LookupValueUpdateResult>;

export interface LookupValueArchiveArgs extends Record<string, unknown> {
  lookup_value_id: string;
  reason?: string;
}
// Canonical envelope (202604280210): { ok, lookup_value_id, revision, correlation_id, settings_resolution_id }
export interface LookupValueArchiveResult extends MutationEnvelopeResult {
  lookup_value_id: string;
  revision: number;
}
export const lookup_value_archive_v1 = (args: LookupValueArchiveArgs): Promise<LookupValueArchiveResult> =>
  ds.lookup_value_archive_v1(args) as unknown as Promise<LookupValueArchiveResult>;

export interface LookupValuePromoteArgs extends Record<string, unknown> {
  lookup_value_id: string;
  effective_from?: string;
  effective_until?: string | null;
}
// Canonical envelope (202604280211): { ok, lookup_value_id, revision, idempotent_no_op, correlation_id, settings_resolution_id }
export interface LookupValuePromoteResult extends MutationEnvelopeResult {
  lookup_value_id: string;
  revision: number;
  idempotent_no_op: boolean;
}
export const lookup_value_promote_v1 = (args: LookupValuePromoteArgs): Promise<LookupValuePromoteResult> =>
  ds.lookup_value_promote_v1(args) as unknown as Promise<LookupValuePromoteResult>;

// ---------- PHASE C5: INTEGRATIONS + WORKFLOWS mutation facades ----------
//
// Each facade mirrors a Phase B6 canonical RPC. Modules MUST consume these via
// the corresponding hooks in `queries.ts` (useUpsertWebhookSource, etc.) so
// cache invalidation + toast plumbing stay uniform. The data-source adapter
// branches once on `getSupabaseClient()` so production cutover is environment-only.

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
export const ui_upsert_webhook_source_v1 = (args: UpsertWebhookSourceArgs) =>
  ds.ui_upsert_webhook_source_v1(args);
export const ui_rotate_webhook_source_token_v1 = (args: { source_id: string }) =>
  ds.ui_rotate_webhook_source_token_v1(args);
export const ui_archive_webhook_source_v1 = (args: ArchiveWebhookSourceArgs) =>
  ds.ui_archive_webhook_source_v1(args);

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
export const ui_upsert_webhook_rule_v1 = (args: UpsertWebhookRuleArgs) =>
  ds.ui_upsert_webhook_rule_v1(args);
export const ui_delete_webhook_rule_v1 = (args: { rule_id: string }) =>
  ds.ui_delete_webhook_rule_v1(args);
export const ui_reorder_webhook_rule_v1 = (args: { rule_id: string; priority: number }) =>
  ds.ui_reorder_webhook_rule_v1(args);

// INTEGRATIONS — Mapping Studio (Create/Edit/Promote-version)
export interface UpsertMappingArtifactArgs extends Record<string, unknown> {
  artifact?: string;
  mapping_config_id?: string | null;
  mapping_type?: string;
  mapping_key?: string;
  mapping_config?: Record<string, unknown>;
  notes?: string | null;
}
export const ui_upsert_mapping_artifact_v1 = (args: UpsertMappingArtifactArgs) =>
  ds.ui_upsert_mapping_artifact_v1(args);
export const ui_delete_mapping_config_v1 = (args: { mapping_config_id: string }) =>
  ds.ui_delete_mapping_config_v1(args);
export interface UpsertApiGatewayRouteMappingArgs extends Record<string, unknown> {
  api_route_id: string;
  mapping_config_id: string;
  organization_id?: string | null;
  target?: string | null;
}
export const ui_upsert_api_gateway_route_mapping_v1 = (args: UpsertApiGatewayRouteMappingArgs) =>
  ds.ui_upsert_api_gateway_route_mapping_v1(args);
export const ui_create_mapping_operation_report_v1 = (args: Record<string, unknown>) =>
  ds.ui_create_mapping_operation_report_v1(args);
export const mapping_config_promote_v1 = (args: { mapping_config_id: string; target_version?: number }) =>
  ds.mapping_config_promote_v1(args);
export const ui_test_mapping_config_v1 = (
  mapping_config_id: string,
  payload: Record<string, unknown>,
) => ds.ui_test_mapping_config_v1(mapping_config_id, payload);

// INTEGRATIONS — provider_auth_configs (Create/Update/Rotate/Revoke)
export interface UpsertProviderAuthConfigArgs extends Record<string, unknown> {
  config_id?: string | null;
  provider_id?: string;
  auth_type?: string;
  credentials?: Record<string, unknown>;
  expires_at?: string | null;
}
export const ui_upsert_provider_auth_config_v1 = (args: UpsertProviderAuthConfigArgs) =>
  ds.ui_upsert_provider_auth_config_v1(args);
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
export const ui_bind_provider_account_credential_v1 = (args: BindProviderAccountCredentialArgs) =>
  ds.ui_bind_provider_account_credential_v1(args);
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
export const ui_unbind_provider_account_credential_v1 = (args: UnbindProviderAccountCredentialArgs) =>
  ds.ui_unbind_provider_account_credential_v1(args);
export const ui_revoke_provider_auth_config_v1 = (args: { config_id: string; reason?: string | null }) =>
  ds.ui_revoke_provider_auth_config_v1(args);
export const integration_plugin_rotate_credentials_v1 = (args: Record<string, unknown>) =>
  ds.integration_plugin_rotate_credentials_v1(args);
export interface ProviderCircuitResetArgs extends Record<string, unknown> {
  provider_id: string;
  operation_name: string;
  reason?: string | null;
}
export const ui_execute_provider_circuit_reset_v1 = (args: ProviderCircuitResetArgs) =>
  ds.ui_execute_provider_circuit_reset_v1(args);
export type ProviderCircuitProbeArgs = ProviderCircuitResetArgs;
export const ui_execute_provider_circuit_probe_v1 = (args: ProviderCircuitProbeArgs) =>
  ds.ui_execute_provider_circuit_probe_v1(args);

// INTEGRATIONS — integration_plugins catalog (Install/Rollback)
export interface IntegrationPluginGenerateDraftArgs extends Record<string, unknown> {
  plugin_name?: string;
  plugin_kind?: string;
  source_type?: string;
  inbound_config?: Record<string, unknown>;
  vendor?: string;
}
export const integration_plugin_generate_draft_v1 = (args: IntegrationPluginGenerateDraftArgs) =>
  ds.integration_plugin_generate_draft_v1(args);
export const integration_plugin_rollback_v1 = (args: {
  plugin_id: string;
  target_plugin_version_id?: string | null;
  reason?: string | null;
}) =>
  ds.integration_plugin_rollback_v1(args);
export const plugin_deactivate_v1 = (args: PluginDeactivateArgs) =>
  ds.plugin_deactivate_v1(args);
export interface IntegrationPluginExportHandoffArgs extends Record<string, unknown> {
  plugin_version_id: string;
  base_url?: string | null;
}
export interface IntegrationPluginExportHandoffResult extends Record<string, unknown> {
  ok: true;
  plugin_id: string;
  plugin_version_id: string;
  kind: string;
  endpoint: string;
  method?: string;
  token?: string;
  headers?: Record<string, unknown>;
  instructions?: string[];
  sample_curl?: string;
}
export const integration_plugin_export_handoff_v1 = (
  args: IntegrationPluginExportHandoffArgs,
): Promise<IntegrationPluginExportHandoffResult> =>
  ds.integration_plugin_export_handoff_v1(args) as Promise<IntegrationPluginExportHandoffResult>;

// INTEGRATIONS — plugin lifecycle Submit/Approve/Activate/Set-binding (W9-2)
//
// Wave 9 W9-2 (CLAIM-INTEGRATIONS REVISION 36% — W7 audit P0 #4): jsonb-arg
// canonical shims for the existing positional-arg lifecycle RPCs. Each
// adapter is a thin facade over the data-source seam.
//
// Backend SSOT: supabase/migrations/202604301210_plugin_lifecycle_jsonb_shims_v1.sql.
export interface PluginSubmitArgs extends Record<string, unknown> {
  plugin_version_id: string;
  reason?: string | null;
}
export const plugin_submit_v1 = (args: PluginSubmitArgs) =>
  ds.plugin_submit_v1(args);

export interface PluginApproveArgs extends Record<string, unknown> {
  plugin_version_id: string;
  decision: 'approved' | 'rejected';
  reason?: string | null;
}
export const plugin_approve_v1 = (args: PluginApproveArgs) =>
  ds.plugin_approve_v1(args);

export interface PluginActivateArgs extends Record<string, unknown> {
  plugin_version_id: string;
  scope_type?: string | null;
  scope_id?: string | null;
  reason?: string | null;
}
export const plugin_activate_v1 = (args: PluginActivateArgs) =>
  ds.plugin_activate_v1(args);

export interface PluginDeactivateArgs extends Record<string, unknown> {
  plugin_id: string;
  plugin_version_id?: string | null;
  reason?: string | null;
}

export interface PluginSetBindingArgs extends Record<string, unknown> {
  plugin_version_id: string;
  enabled: boolean;
  scope_type?: string | null;
  scope_id?: string | null;
}
export const plugin_set_binding_v1 = (args: PluginSetBindingArgs) =>
  ds.plugin_set_binding_v1(args);

// INTEGRATIONS — webhook_inbox replay + force-status
//
// Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #1/#2) — payload-key alignment:
// The canonical Phase B6 RPCs `webhook_inbox_replay_v1` /
// `webhook_inbox_force_status_v1` are strict on argument keys (`23502`/`22023`
// raise on missing/invalid). The FE row interfaces use `inbox_id` / `status`
// for ergonomic continuity with the WebhookInboxRow shape, but the canonical
// RPC contracts use `webhook_inbox_id` / `target_status`. We translate
// FE-flavored keys -> canonical RPC keys at this facade boundary so modules
// stay row-shape consistent and the cloud cutover sends the contract payloads
// the backend expects. Tests spying on the api facade observe canonical
// post-adapter args.
//
// Backend SSOT references:
//   - webhook_inbox_replay_v1        202604280219  (webhook_inbox_id)
//   - webhook_inbox_force_status_v1  202604280220  (webhook_inbox_id + target_status)

/** Translate FE-flavored WebhookInboxReplayArgs `inbox_id` to the
 *  canonical RPC key `webhook_inbox_id`. Existing canonical key wins on
 *  conflict. Other keys pass through unchanged. */
function adaptWebhookInboxReplayArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (Object.prototype.hasOwnProperty.call(out, 'inbox_id')) {
    if (!Object.prototype.hasOwnProperty.call(out, 'webhook_inbox_id')) {
      out.webhook_inbox_id = out.inbox_id;
    }
    delete out.inbox_id;
  }
  return out;
}

/** Translate FE-flavored WebhookInboxForceStatusArgs `inbox_id` -> `webhook_inbox_id`
 *  and `status` -> `target_status`. Existing canonical keys win on conflict. */
function adaptWebhookInboxForceStatusArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (Object.prototype.hasOwnProperty.call(out, 'inbox_id')) {
    if (!Object.prototype.hasOwnProperty.call(out, 'webhook_inbox_id')) {
      out.webhook_inbox_id = out.inbox_id;
    }
    delete out.inbox_id;
  }
  if (Object.prototype.hasOwnProperty.call(out, 'status')) {
    if (!Object.prototype.hasOwnProperty.call(out, 'target_status')) {
      out.target_status = out.status;
    }
    delete out.status;
  }
  return out;
}

export interface WebhookInboxReplayArgs extends Record<string, unknown> {
  /** FE-flavored alias: translated to canonical `webhook_inbox_id` at the
   *  facade boundary. Prefer passing `webhook_inbox_id` directly. */
  inbox_id?: string;
  webhook_inbox_id?: string;
  reason?: string | null;
}
export const webhook_inbox_replay_v1 = (args: WebhookInboxReplayArgs) =>
  ds.webhook_inbox_replay_v1(adaptWebhookInboxReplayArgs(args));
export interface WebhookInboxRetryAsNewIntakeArgs extends Record<string, unknown> {
  webhook_inbox_id: string;
  reason?: string | null;
}
export const ui_retry_webhook_inbox_as_new_intake_v1 = (args: WebhookInboxRetryAsNewIntakeArgs) =>
  ds.ui_retry_webhook_inbox_as_new_intake_v1(args);
export interface WebhookInboxForceStatusArgs extends Record<string, unknown> {
  /** FE-flavored alias: translated to canonical `webhook_inbox_id` at the
   *  facade boundary. Prefer passing `webhook_inbox_id` directly. */
  inbox_id?: string;
  webhook_inbox_id?: string;
  /** FE-flavored alias: translated to canonical `target_status` at the
   *  facade boundary. Prefer passing `target_status` directly. */
  status?: string;
  target_status?: string;
  reason?: string | null;
}
export const webhook_inbox_force_status_v1 = (args: WebhookInboxForceStatusArgs) =>
  ds.webhook_inbox_force_status_v1(adaptWebhookInboxForceStatusArgs(args));

// WORKFLOWS — templates / bindings / bulk-transition lifecycle
//
// Wave 5 RE-AUDIT (WORKFLOWS.md P0 #2/#3) — payload-key alignment:
// The canonical Phase B6 RPCs are strict on argument keys (`23502` raise on
// missing). The FE row interfaces use `template_id` / `next_status` for
// ergonomic continuity with WorkflowBinding / Task UI shapes, but the
// canonical RPC contracts use `workflow_template_id` / `to_status`. We
// translate FE-flavored keys -> canonical RPC keys at this facade boundary
// so modules stay row-shape consistent and the cloud cutover sends the
// contract payloads the backend expects. Tests spying on the api facade
// observe canonical post-adapter args.
//
// Backend SSOT references:
//   - register_workflow_binding_v1   202604280221  (workflow_template_id)
//   - simulate_binding_dispatch_v1   202604280222  (binding_key + stage_key)
//   - bulk_transition_tasks_v1       202604280223  (to_status)
//   - ui_set_workflow_template_status_v1  202604280310  (template_id — same)

/** Translate FE-flavored RegisterWorkflowBindingArgs `template_id` to the
 *  canonical RPC key `workflow_template_id`. Existing canonical key wins on
 *  conflict. Other keys pass through unchanged. */
function adaptRegisterWorkflowBindingArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (Object.prototype.hasOwnProperty.call(out, 'template_id')) {
    if (!Object.prototype.hasOwnProperty.call(out, 'workflow_template_id')) {
      out.workflow_template_id = out.template_id;
    }
    delete out.template_id;
  }
  return out;
}

/** Translate FE-flavored BulkTransitionTasksArgs `next_status` to the
 *  canonical RPC key `to_status`. Existing canonical key wins on conflict. */
function adaptBulkTransitionTasksArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (Object.prototype.hasOwnProperty.call(out, 'next_status')) {
    if (!Object.prototype.hasOwnProperty.call(out, 'to_status')) {
      out.to_status = out.next_status;
    }
    delete out.next_status;
  }
  return out;
}

export interface CreateWorkflowTemplateArgs extends Record<string, unknown> {
  name: string;
  description?: string | null;
  clone_from?: string | null;
  trigger?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
}
export const ui_create_workflow_template_v1 = (args: CreateWorkflowTemplateArgs) =>
  ds.ui_create_workflow_template_v1(args);
export interface SetWorkflowTemplateStatusArgs extends Record<string, unknown> {
  template_id: string;
  status: 'draft' | 'active' | 'inactive' | 'retired';
}
export const ui_set_workflow_template_status_v1 = (args: SetWorkflowTemplateStatusArgs) =>
  ds.ui_set_workflow_template_status_v1(args);

// WORKFLOWS — template step lifecycle
export type WorkflowTemplateVersionDiffArgs = ds.WorkflowTemplateVersionDiffArgs;
export type WorkflowTemplateVersionDiffResult = ds.WorkflowTemplateVersionDiffResult;
export const workflow_template_version_diff_v1 = (args: WorkflowTemplateVersionDiffArgs) =>
  ds.workflow_template_version_diff_v1(args);
export type RestoreWorkflowTemplateArgs = ds.RestoreWorkflowTemplateArgs;
export type RestoreWorkflowTemplateResult = ds.RestoreWorkflowTemplateResult;
export const restore_workflow_template_v1 = (args: RestoreWorkflowTemplateArgs) =>
  ds.restore_workflow_template_v1(args);

export type WorkflowTemplateStepMutationResult = ds.WorkflowTemplateStepMutationResult;
export type CreateWorkflowTemplateStepArgs = ds.CreateWorkflowTemplateStepArgs;
export type UpdateWorkflowTemplateStepArgs = ds.UpdateWorkflowTemplateStepArgs;
export type DuplicateWorkflowTemplateStepArgs = ds.DuplicateWorkflowTemplateStepArgs;
export type DeleteWorkflowTemplateStepArgs = ds.DeleteWorkflowTemplateStepArgs;
export const ui_create_workflow_template_step_v1 = (
  args: CreateWorkflowTemplateStepArgs,
) => ds.ui_create_workflow_template_step_v1(args);
export const ui_update_workflow_template_step_v1 = (
  args: UpdateWorkflowTemplateStepArgs,
) => ds.ui_update_workflow_template_step_v1(args);
export const ui_duplicate_workflow_template_step_v1 = (
  args: DuplicateWorkflowTemplateStepArgs,
) => ds.ui_duplicate_workflow_template_step_v1(args);
export const ui_delete_workflow_template_step_v1 = (
  args: DeleteWorkflowTemplateStepArgs,
) => ds.ui_delete_workflow_template_step_v1(args);

// WORKFLOWS — bindings lifecycle
export interface RegisterWorkflowBindingArgs extends Record<string, unknown> {
  binding_key?: string;
  stage_key?: string;
  scope_type?: string;
  scope_id?: string | null;
  event?: string;
  /** FE-flavored alias: translated to canonical `workflow_template_id` at the
   *  facade boundary. Prefer passing `workflow_template_id` directly. */
  template_id?: string;
  workflow_template_id?: string;
  condition?: Record<string, unknown> | null;
  priority?: number;
  enabled?: boolean;
}
export const register_workflow_binding_v1 = (args: RegisterWorkflowBindingArgs) =>
  ds.register_workflow_binding_v1(adaptRegisterWorkflowBindingArgs(args));
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
  /** FE-only sample event metadata; unused by canonical RPC. Carried for
   *  telemetry without mutating canonical args. */
  event?: string;
  payload?: Record<string, unknown>;
}
export const simulate_binding_dispatch_v1 = (args: SimulateBindingDispatchArgs) =>
  ds.simulate_binding_dispatch_v1(args);

// WORKFLOWS — review-queue bulk transition
export interface BulkTransitionTasksArgs extends Record<string, unknown> {
  task_ids: string[];
  /** FE-flavored alias: translated to canonical `to_status` at the facade
   *  boundary. Prefer passing `to_status` directly. */
  next_status?: string;
  to_status?: string;
  payload?: Record<string, unknown>;
  action_kind?: string;
}
export const bulk_transition_tasks_v1 = (args: BulkTransitionTasksArgs) =>
  ds.bulk_transition_tasks_v1(
    adaptBulkTransitionTasksArgs(args) as unknown as ds.BulkTransitionTasksArgs,
  );

// ---------- PHASE C2: NETWORK mutation facades ----------
//
// Each facade mirrors a Phase B canonical RPC (single jsonb envelope `p_args`).
// Modules MUST consume these via the corresponding hooks in `queries.ts` so
// cache invalidation + toast plumbing remain uniform. The data-source adapter
// branches once on `getSupabaseClient()` so production cutover is environment-only.
//
// Migrations of record (verified):
//   • suspend_zone_v1                          202604281200
//   • restore_zone_v1                          202604281210
//   • request_zone_override_v1                 202604061530 (uc062)
//   • ui_execute_zone_override_request_v1      202604061530 (uc062)
//   • marketplace_offer_submit_v1              202603071120:2030
//   • marketplace_offer_withdraw_v1            202603071120:2169
//   • marketplace_award_offer_v1               202603071120:2219
//   • marketplace_award_respond_v1             202603071120:2367
//   • marketplace_request_create_v1            202603071120:1673
//   • marketplace_request_publish_v1           202603071120:1886
//   • marketplace_request_cancel_v1            202603071120:1974
//   • marketplace_dispute_open_v1              202603071120:2651
//   • marketplace_dispute_resolve_v1           202603071120:2758
//   • marketplace_work_package_materialize_v1  202603071120:2554
//   • marketplace_participant_request_review_apply_v1 202603071120:1445
//   • marketplace_refresh_reputation_snapshot_v1 202603071120:506
//
// Pending canonical RPCs (routed via phaseC6Rpc until backend ships):
//   • branch_create_v1, branch_update_v1, branch_mark_oos_v1
//   • branch_zone_assign_v1, branch_zone_unassign_v1
//   • add_branch_member_v1, remove_branch_member_v1
//   • branch_capacity_window_set_v1, branch_coverage_window_upsert_v1
//   • zone_create_v1, zone_district_add_v1, zone_district_remove_v1
//
// Capability split (canonical SSOT):
//   zones.write, marketplace.write, branches.write.

// NETWORK — zones lifecycle (canonical Phase B4)
export interface SuspendZoneArgs extends Record<string, unknown> {
  zone_id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281200): { ok, zone_id, is_active, already_processed, correlation_id, decision_log_id }
// Note: zone lifecycle RPCs use `decision_log_id` rather than `settings_resolution_id`,
// and `correlation_id` may be null when the call is an idempotent no-op short-circuit.
export interface SuspendZoneResult extends Record<string, unknown> {
  ok: true;
  zone_id: string;
  is_active: boolean;
  already_processed: boolean;
  correlation_id: string | null;
  decision_log_id?: string | null;
}
export const suspend_zone_v1 = (args: SuspendZoneArgs): Promise<SuspendZoneResult> =>
  ds.suspend_zone_v1(args) as Promise<SuspendZoneResult>;

export interface RestoreZoneArgs extends Record<string, unknown> {
  zone_id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (202604281210): { ok, zone_id, is_active, already_processed, correlation_id, decision_log_id }
export interface RestoreZoneResult extends Record<string, unknown> {
  ok: true;
  zone_id: string;
  is_active: boolean;
  already_processed: boolean;
  correlation_id: string | null;
  decision_log_id?: string | null;
}
export const restore_zone_v1 = (args: RestoreZoneArgs): Promise<RestoreZoneResult> =>
  ds.restore_zone_v1(args) as Promise<RestoreZoneResult>;

export interface ZoneUpdateArgs extends Record<string, unknown> {
  zone_id: string;
  patch: Record<string, unknown>;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export interface ZoneUpdateResult extends MutationEnvelopeResult {
  zone_id: string;
  changed?: Record<string, unknown>;
}
export const zone_update_v1 = (args: ZoneUpdateArgs): Promise<ZoneUpdateResult> =>
  ds.zone_update_v1(args) as Promise<ZoneUpdateResult>;

export interface ZoneDeleteArgs extends Record<string, unknown> {
  zone_id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export interface ZoneDeleteResult extends Record<string, unknown> {
  ok: true;
  zone_id: string;
  is_active: boolean;
  lifecycle: string;
  already_processed?: boolean;
  correlation_id: string | null;
  decision_log_id?: string | null;
}
export const zone_delete_v1 = (args: ZoneDeleteArgs): Promise<ZoneDeleteResult> =>
  ds.zone_delete_v1(args) as Promise<ZoneDeleteResult>;

// NETWORK — zone overrides (uc062 workflow-engine path)
export interface RequestZoneOverrideArgs extends Record<string, unknown> {
  current_zone_id?: string | null;
  expected_zone_id?: string | null;
  requested_zone_id: string;
  request_reason: string;
  shipment_id?: string | null;
  metadata?: Record<string, unknown>;
}
// Canonical envelope (uc062): { ok, zone_override_request_id?, correlation_id, settings_resolution_id }
export interface RequestZoneOverrideResult extends MutationEnvelopeResult {
  zone_override_request_id?: string;
}
export const request_zone_override_v1 = (args: RequestZoneOverrideArgs): Promise<RequestZoneOverrideResult> =>
  ds.request_zone_override_v1(args) as Promise<RequestZoneOverrideResult>;

export interface UiExecuteZoneOverrideRequestArgs extends Record<string, unknown> {
  zone_override_request_id?: string;
  request_id?: string;
  decision: 'approve' | 'deny';
  resolution_outcome?: string;
  resolution_notes?: string;
  reviewed_by?: string;
}
// Canonical envelope (uc062): { ok, zone_override_request_id?, correlation_id, settings_resolution_id }
export interface UiExecuteZoneOverrideRequestResult extends MutationEnvelopeResult {
  zone_override_request_id?: string;
}
export const ui_execute_zone_override_request_v1 = (args: UiExecuteZoneOverrideRequestArgs): Promise<UiExecuteZoneOverrideRequestResult> =>
  ds.ui_execute_zone_override_request_v1(args) as Promise<UiExecuteZoneOverrideRequestResult>;

// NETWORK — zones create + districts (canonical write RPCs SHIPPED in W9-1
// migrations 202604300440/450/460). Each facade is typed end-to-end and
// forwards directly to the data-source typed adapter.
export interface ZoneCreateArgs extends Record<string, unknown> {
  name: string;
  slug?: string;
  color_token?: string;
  initial_district_ids?: string[];
  metadata?: Record<string, unknown>;
}
// Canonical envelope: { ok, zone_id, initial_district_count?, correlation_id, settings_resolution_id? }
export interface ZoneCreateResult extends MutationEnvelopeResult {
  zone_id: string;
  initial_district_count?: number;
}
export const zone_create_v1 = (args: ZoneCreateArgs): Promise<ZoneCreateResult> =>
  ds.zone_create_v1(args);

export interface ZoneDistrictAddArgs extends Record<string, unknown> {
  zone_id: string;
  canonical_district_id: string;
  role?: string;
}
// Canonical envelope: { ok, zone_district_id, already_processed, correlation_id, settings_resolution_id? }
export interface ZoneDistrictAddResult extends MutationEnvelopeResult {
  zone_district_id: string;
  already_processed?: boolean;
}
export const zone_district_add_v1 = (args: ZoneDistrictAddArgs): Promise<ZoneDistrictAddResult> =>
  ds.zone_district_add_v1(args);

export interface ZoneDistrictRemoveArgs extends Record<string, unknown> {
  zone_district_id?: string;
  zone_id?: string;
  canonical_district_id?: string;
}
// Canonical envelope: { ok, zone_district_id, already_processed, correlation_id, settings_resolution_id? }
export interface ZoneDistrictRemoveResult extends MutationEnvelopeResult {
  zone_district_id: string;
  already_processed?: boolean;
}
export const zone_district_remove_v1 = (args: ZoneDistrictRemoveArgs): Promise<ZoneDistrictRemoveResult> =>
  ds.zone_district_remove_v1(args);

// NETWORK — marketplace lifecycle (Phase B4 backend, all canonical)
export interface MarketplaceOfferSubmitArgs extends Record<string, unknown> {
  request_id: string;
  participant_profile_id?: string;
  pricing?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}
export const marketplace_offer_submit_v1 = (args: MarketplaceOfferSubmitArgs) =>
  ds.marketplace_offer_submit_v1(args);

export interface MarketplaceOfferWithdrawArgs extends Record<string, unknown> {
  offer_id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_offer_withdraw_v1 = (args: MarketplaceOfferWithdrawArgs) =>
  ds.marketplace_offer_withdraw_v1(args);

export interface MarketplaceAwardOfferArgs extends Record<string, unknown> {
  offer_id: string;
  award_terms?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export const marketplace_award_offer_v1 = (args: MarketplaceAwardOfferArgs) =>
  ds.marketplace_award_offer_v1(args);

export interface MarketplaceAwardRespondArgs extends Record<string, unknown> {
  award_id: string;
  response: 'accept' | 'reject' | 'cancel';
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_award_respond_v1 = (args: MarketplaceAwardRespondArgs) =>
  ds.marketplace_award_respond_v1(args);

export interface MarketplaceRequestCreateArgs extends Record<string, unknown> {
  request_kind?: string;
  request_kind_key?: string;
  request_details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export const marketplace_request_create_v1 = (args: MarketplaceRequestCreateArgs) =>
  ds.marketplace_request_create_v1(args);

export interface MarketplaceRequestPublishArgs extends Record<string, unknown> {
  request_id: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_request_publish_v1 = (args: MarketplaceRequestPublishArgs) =>
  ds.marketplace_request_publish_v1(args);

export interface MarketplaceRequestCancelArgs extends Record<string, unknown> {
  request_id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_request_cancel_v1 = (args: MarketplaceRequestCancelArgs) =>
  ds.marketplace_request_cancel_v1(args);

export interface MarketplaceDisputeOpenArgs extends Record<string, unknown> {
  contract_id?: string | null;
  request_id?: string | null;
  work_package_id?: string | null;
  category?: string;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_dispute_open_v1 = (args: MarketplaceDisputeOpenArgs) =>
  ds.marketplace_dispute_open_v1(args);

export interface MarketplaceDisputeResolveArgs extends Record<string, unknown> {
  dispute_id: string;
  resolution: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_dispute_resolve_v1 = (args: MarketplaceDisputeResolveArgs) =>
  ds.marketplace_dispute_resolve_v1(args);

export interface MarketplaceWorkPackageMaterializeArgs extends Record<string, unknown> {
  award_id: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_work_package_materialize_v1 = (
  args: MarketplaceWorkPackageMaterializeArgs,
) => ds.marketplace_work_package_materialize_v1(args);

export interface MarketplaceParticipantRequestReviewApplyArgs
  extends Record<string, unknown> {
  participant_request_id: string;
  decision: 'approve' | 'approved' | 'reject' | 'rejected' | 'request_additional_docs';
  requested_documents?: string[];
  note?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const marketplace_participant_request_review_apply_v1 = (
  args: MarketplaceParticipantRequestReviewApplyArgs,
) => ds.marketplace_participant_request_review_apply_v1(args);

export interface MarketplaceRefreshReputationSnapshotArgs
  extends Record<string, unknown> {
  participant_profile_id?: string | null;
}
export const marketplace_refresh_reputation_snapshot_v1 = (
  args: MarketplaceRefreshReputationSnapshotArgs,
) => ds.marketplace_refresh_reputation_snapshot_v1(args);

// NETWORK — branches mutations (canonical write RPCs SHIPPED in W8-1 + W9-1).
// Each facade is typed end-to-end (Args + Result) and forwards directly to
// the data-source typed adapter (which calls supabase-js .rpc() in production
// and the in-memory envelope in dev). This replaces the prior phaseC6Rpc
// shim path so call sites get compile-time envelope shape checks.
export interface BranchCreateArgs extends Record<string, unknown> {
  name: string;
  code?: string;
  branch_type?: string;
  timezone?: string;
  address?: Record<string, unknown> | string;
  coordinates?: { lat: number; lng: number } | { latitude: number; longitude: number } | string;
  metadata?: Record<string, unknown>;
}
export const branch_create_v1 = (args: BranchCreateArgs): Promise<BranchMutationResult> =>
  ds.branch_create_v1(args);

export interface BranchUpdateArgs extends Record<string, unknown> {
  branch_id: string;
  patch: Record<string, unknown>;
}
export const branch_update_v1 = (args: BranchUpdateArgs): Promise<BranchMutationResult> =>
  ds.branch_update_v1(args);

export interface BranchMarkOosArgs extends Record<string, unknown> {
  branch_ids: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const branch_mark_oos_v1 = (args: BranchMarkOosArgs): Promise<BranchMarkOosResult> =>
  ds.branch_mark_oos_v1(args);

export interface BranchZoneAssignArgs extends Record<string, unknown> {
  branch_id: string;
  zone_id: string;
  priority?: number;
  role?: string;
}
export const branch_zone_assign_v1 = (
  args: BranchZoneAssignArgs,
): Promise<BranchZoneMutationResult> =>
  ds.branch_zone_assign_v1(args);

export interface BranchZoneUnassignArgs extends Record<string, unknown> {
  branch_zone_id: string;
}
export const branch_zone_unassign_v1 = (
  args: BranchZoneUnassignArgs,
): Promise<BranchZoneMutationResult> =>
  ds.branch_zone_unassign_v1(args);

export interface AddBranchMemberArgs extends Record<string, unknown> {
  branch_id: string;
  user_id: string;
  role_key: string;
}
export const add_branch_member_v1 = (
  args: AddBranchMemberArgs,
): Promise<BranchMembershipMutationResult> =>
  ds.add_branch_member_v1(args);

export interface RemoveBranchMemberArgs extends Record<string, unknown> {
  membership_id: string;
}
export const remove_branch_member_v1 = (
  args: RemoveBranchMemberArgs,
): Promise<BranchMembershipMutationResult> =>
  ds.remove_branch_member_v1(args);

export interface BranchCapacityWindowSetArgs extends Record<string, unknown> {
  capacity_window_id: string;
  capacity_units?: number;
  capacity?: Record<string, unknown>;
}
export const branch_capacity_window_set_v1 = (
  args: BranchCapacityWindowSetArgs,
): Promise<BranchCapacityWindowMutationResult> =>
  ds.branch_capacity_window_set_v1(args);

export interface BranchCoverageWindowUpsertArgs extends Record<string, unknown> {
  branch_id: string;
  coverage_window_id?: string;
  effective_from?: string;
  effective_to?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export const branch_coverage_window_upsert_v1 = (
  args: BranchCoverageWindowUpsertArgs,
): Promise<BranchCoverageWindowMutationResult> =>
  ds.branch_coverage_window_upsert_v1(args);

// Default export: legacy `api.foo()` style for module convenience
export const api = {
  ui_list_resource_v1, ui_list_resource_complete, ui_get_resource_v1, ui_resource_metrics_v1,
  getCurrentUser, getCurrentScope, getCapabilities, hasCapability, setRole,
  getNavigation, getReadRegistry, getCommandRegistry, getSettingsCategories, getLookups, getDevRoles,
  hasConsoleLiveBackend, isConsoleSeedModeEnabled, hydrateConsoleLiveMetadata,
  dashboardKpis,
  // Phase F1 (CLAIM-INSIGHTS-REPORTING) — KPI rollup resolver.
  compute_kpi_rollup_v1,
  // W11-1 / W8-4 — bank account balance projection.
  compute_bank_account_balance_v1,
  resolveSettings, proposeSettingsChange, resolveMobilePolicy,
  resolve_access_control_policy_v1,
  user_capability_eval_v1,
  listDecisionLog, listResolutionLog, listAuditLog, listUiEventLog, streamEvidence,
  listProjectItems, listExecutionCards, listWorkerClaims, getAuthEmailUrlPolicy,
  listTasks, transition_task_v1, resolve_manual_review_task_v1,
  ui_get_shipment_timeline_v1, ui_create_shipment_v1, ui_execute_onboarding_bootstrap_v1,
  shipment_amend_cancel_options_v1, shipment_amend_cancel_v1, ui_execute_shipment_batch_operation_v1,
  ui_execute_shipment_resort_v1, ui_execute_shipment_update_geocode_v1,
  ui_update_basket_state_v1, basket_create_v1, basket_update_v1,
  // W13-5 — operator-initiated comms attempt enqueue.
  enqueue_comms_attempt_v1,
  ui_create_route_plan_v1, ui_solve_route_plan_v1, ui_freeze_route_plan_v1,
  ui_publish_route_plan_v1, ui_route_plan_execution_pack_v1, ui_apply_route_plan_v1, ui_rebalance_route_plan_v1,
  route_plan_validate_constraints_v1,
  ui_execute_route_run_assign_v1, ui_execute_route_run_assignment_response_v1, ui_execute_route_stop_reassign_v1,
  ui_confirm_route_run_departure_v1, route_run_scan_out_reconciliation_v1,
  pickup_requests_list_v1, pickup_waves_list_v1, pickup_failures_list_v1, create_pickup_request_v1, create_pickup_wave_v1, assign_pickup_wave_v1,
  ui_execute_dispatch_exception_resolution_v1, record_scan_event_v1,
  warehouse_transfer_execute_v1, transition_warehouse_transfer_v1, return_to_branch_shipments_v1,
  resolve_ndr_branch_next_action_v1,
  list_delivery_slots_v1, reserve_delivery_slot_v1,
  compute_cod_payment_collection_summary_v1,
  label_designer_get_field_catalog,
  label_designer_get_effective_label_design,
  label_designer_get_effective_label_render_policy,
  label_designer_get_effective_label_print_profile,
  label_designer_get_label_media_catalog,
  ui_label_renderer_readiness_v1,
  ui_record_label_printer_certification_v1,
  label_designer_list_drafts, label_designer_create_draft, label_designer_update_draft, label_designer_archive_draft,
  label_designer_validate_label_design_draft, label_designer_publish_label_design_draft,
  request_label_reprint, ui_request_label_generation_target_v1, resolve_resource_download_url_v1, complete_label_job,
  ui_execute_user_device_revoke_v1,
  // Identity / sessions (Phase E2)
  ui_list_user_sessions_v1, revoke_session_v1,
  start_workflow_run, progress_workflow_run, progress_workflow_run_until_wait_v1, progress_workflow_run_base,
  close_workflow_run, ui_get_workflow_run_steps_v1, ui_list_operation_templates_v1,
  ui_get_trace_v1, runPluginTest,
  runWebhookReceiverTest, runApiGatewayRequestTest,
  // INTEGRATIONS P0 (W12-2) — plugin-studio 4-stage authoring loop
  plugin_studio_parse_v1, plugin_studio_infer_v1,
  plugin_studio_preview_v1, plugin_studio_save_v1,
  resource_import_studio_prepare_v1, resource_import_studio_start_v1, resource_import_studio_cancel_v1,
  runCommand, ui_log_event_v1, ui_create_workflow_schedule_trigger_v1, ui_create_workflow_run_trigger_v1,
  ui_update_workflow_run_trigger_v1, ui_delete_workflow_run_trigger_v1,
  ui_run_workflow_schedule_trigger_v1, ui_repair_workflow_schedule_task_payload_v1,
  assign_task_v1, open_ops_session_v1,
  // Phase C6 — PLATFORM
  create_alert_rule_v1, update_alert_rule_v1, pause_alert_rule_v1, resume_alert_rule_v1,
  delete_alert_rule_v1, test_alert_rule_v1, acknowledge_ops_alert_v1, resolve_ops_alert_v1,
  toggle_feature_flag_v1, engage_kill_switch_v1, release_kill_switch_v1,
  set_rollout_v1, bulk_toggle_feature_flags_v1, create_feature_flag_v1, update_feature_flag_v1,
  request_capability_grant_v1, ui_review_capability_grant_request_v1, tenant_signup_review_apply_v1,
  tenant_signup_console_request_v1,
  ui_update_organization_profile_v1, ui_list_tenant_invitable_roles_v1, tenant_user_invite_v1,
  // Phase B6 — CUSTOMERS
  recipient_create_v1, recipient_update_v1, recipient_delete_v1,
  // W16-5 — PLATFORM imports
  import_job_create_v1, import_job_cancel_v1,
  // Phase E3 — RBAC role-management lifecycle
  rbac_create_role_v1, rbac_update_role_v1, rbac_delete_role_v1,
  rbac_grant_role_v1, rbac_revoke_role_v1, provision_rbac_roles_from_templates_v1,
  // Phase C6 — FLEET
  create_vehicle_v1, upload_vehicle_document_v1,
  assign_driver_to_vehicle_v1, unassign_driver_v1, mark_vehicle_oos_v1, restore_vehicle_v1,
  schedule_maintenance_v1, complete_maintenance_v1, cancel_maintenance_v1, record_vehicle_event_v1,
  create_driver_v1, upload_driver_document_v1,
  suspend_driver_v1, restore_driver_v1, verify_driver_document_v1, reject_driver_document_v1,
  create_driver_compliance_event_v1, record_hours_of_service_segment_v1,
  // Phase C6 — SUPPORT
  create_support_case_v1, update_support_case_v1, assign_support_case_v1, escalate_support_case_v1, bulk_assign_support_cases_v1,
  resolve_support_case_v1, bulk_resolve_support_cases_v1, reopen_support_case_v1,
  send_support_message_v1, add_support_tag_v1, public_tracking_review_request_v1,
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
  webhook_inbox_replay_v1, ui_retry_webhook_inbox_as_new_intake_v1, webhook_inbox_force_status_v1,
  // Phase C5 — WORKFLOWS (templates / bindings / review)
  ui_create_workflow_template_v1, ui_set_workflow_template_status_v1,
  workflow_template_version_diff_v1, restore_workflow_template_v1,
  ui_create_workflow_template_step_v1, ui_update_workflow_template_step_v1,
  ui_duplicate_workflow_template_step_v1, ui_delete_workflow_template_step_v1,
  register_workflow_binding_v1, simulate_binding_dispatch_v1,
  bulk_transition_tasks_v1,
  // Phase B5/C4 — FINANCE (billing / settlements / bank-recon / disputes)
  create_billing_invoice_v1, update_billing_invoice_v1, void_billing_invoice_v1,
  billing_invoice_send_v1, ui_bulk_billing_invoice_send_v1,
  billing_invoice_refund_v1, billing_invoice_mark_paid_v1, cancel_subscription_v1,
  apply_settlement_v1, reject_settlement_v1,
  ui_create_settlement_batch_v1, ui_transition_settlement_batch_v1,
  ui_record_cod_remittance_v1, ui_adjust_cod_collection_v1, ui_reverse_finance_event_v1,
  bank_recon_match_v1, bank_recon_unmatch_v1, ui_record_bank_statement_event_v1,
  ui_create_bank_account_v1,
  dispute_resolve_v1, dispute_reject_v1, ui_bulk_dispute_action_v1,
  dispute_acknowledge_v1, dispute_escalate_v1,
  // Phase C2 — NETWORK (zones / overrides / marketplace / branches)
  suspend_zone_v1, restore_zone_v1, zone_update_v1, zone_delete_v1,
  request_zone_override_v1, ui_execute_zone_override_request_v1,
  zone_create_v1, zone_district_add_v1, zone_district_remove_v1,
  marketplace_offer_submit_v1, marketplace_offer_withdraw_v1,
  marketplace_award_offer_v1, marketplace_award_respond_v1,
  marketplace_request_create_v1, marketplace_request_publish_v1, marketplace_request_cancel_v1,
  marketplace_dispute_open_v1, marketplace_dispute_resolve_v1,
  marketplace_work_package_materialize_v1,
  marketplace_participant_request_review_apply_v1,
  marketplace_refresh_reputation_snapshot_v1,
  branch_create_v1, branch_update_v1, branch_mark_oos_v1,
  branch_zone_assign_v1, branch_zone_unassign_v1,
  add_branch_member_v1, remove_branch_member_v1,
  branch_capacity_window_set_v1, branch_coverage_window_upsert_v1,
  // Phase B5 — INSIGHTS / api-gateway operational write contract
  // (REAUDIT INSIGHTS §D1, §D2 closure)
  block_api_gateway_source_v1, adjust_api_gateway_rate_limit_v1,
};

export type Api = typeof api;

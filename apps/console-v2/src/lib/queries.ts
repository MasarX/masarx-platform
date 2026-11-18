// queries.ts — TanStack Query keys + hooks. Modules MUST use these (not call api.* directly)
// so cache invalidation, devtools, and refetch on focus all work uniformly.

import { useQuery, useMutation, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query';
import * as api from './api';
import type { ListResult, DecisionLogEntry, SettingsResolution, UiTrace, UiOnboardingReadiness } from '../types/domain';

// Re-export the canonical AccessPolicyResolution shape so callers don't have to
// reach into `lib/api` directly. Mirrors the SQL contract in
// supabase/migrations/202601022113_access_control_policy_core.sql:554.
export type AccessPolicyResolution = api.AccessPolicyResolution;

// ---------- Query keys (single source of truth) ----------
export const qk = {
  list: (resource: string, opts?: api.ListOpts) => ['list', resource, opts] as const,
  completeList: (resource: string, opts?: api.ListOpts) => ['list', resource, 'complete', opts] as const,
  resource: (resource: string, id: string) => ['resource', resource, id] as const,
  metrics: (resource: string, opts?: unknown) => ['metrics', resource, opts] as const,
  shipmentTimeline: (id: string) => ['shipment_timeline', id] as const,
  shipmentOperationOptions: (id: string) => ['shipment_operation_options', id] as const,
  dashboardKpis: () => ['dashboard_kpis'] as const,
  // Phase F1 / CLAIM-INSIGHTS-REPORTING — KPI rollup resolver. Keyed by
  // (definition_key, window_days, scope_organization_id) so cards on
  // /insights/reporting cache independently per tenant + KPI.
  kpiRollup: (definition_key: string, window_days?: number, scopeOrgId?: string | null) =>
    ['kpi_rollup', definition_key, window_days ?? 1, scopeOrgId ?? null] as const,
  decisionLog: (filters?: unknown) => ['decision_log', filters] as const,
  resolutionLog: (filters?: unknown) => ['resolution_log', filters] as const,
  auditLog: (filters?: unknown) => ['audit_log', filters] as const,
  uiEventLog: (filters?: unknown) => ['ui_event_log', filters] as const,
  tasks: (filters?: unknown) => ['tasks', filters] as const,
  resolveSettings: (cat: string, scope?: unknown) => ['settings_resolution', cat, scope] as const,
  resolveSettingsCategory: (cat: string) => ['settings_resolution', cat] as const,
  resolveMobilePolicy: (cat: string, scope?: unknown) => ['mobile_policy', cat, scope] as const,
  resolveMobilePolicyCategory: (cat: string) => ['mobile_policy', cat] as const,
  resolveAccessPolicy: (scopeType?: string, scopeId?: string | null) =>
    ['access_policy_resolution', scopeType ?? null, scopeId ?? null] as const,
  onboardingReadiness: (scopeType: string, scopeId?: string | null) =>
    ['onboarding_readiness', scopeType, scopeId ?? null] as const,
  driverHoursOfService: (driverId?: string | null) =>
    ['driver_hours_of_service', driverId ?? null] as const,
  pickups: {
    requests: (f?: unknown) => ['pickups', 'requests', f] as const,
    waves: (f?: unknown) => ['pickups', 'waves', f] as const,
    failures: (f?: unknown) => ['pickups', 'failures', f] as const,
  },
  trace: (id: string) => ['trace', id] as const,
  returnToBranch: () => ['return_to_branch_shipments_v1'] as const,
  routePlanExecutionPack: (planId: string) => ['route_plan_execution_pack', planId] as const,
  codSummary: (scope?: unknown) => ['cod_summary', scope] as const,
  deliverySlots: (args?: unknown) => ['delivery_slots', args] as const,
  ndrBranchNextAction: (args?: unknown) => ['ndr_branch_next_action', args] as const,
  // W11-1 / W8-4 — bank account balance projection. Keyed by bank_account_id
  // so each card's derived (balance, last_match_at, open_items) caches
  // independently. Backed by canonical RPC `compute_bank_account_balance_v1`
  // (migration 202604301110_compute_bank_account_balance_v1.sql).
  bankAccountBalance: (bankAccountId: string) =>
    ['bank_account_balance', bankAccountId] as const,
  labelDesignerFieldCatalog: (scopeType: string, scopeId?: string | null) =>
    ['label_designer_field_catalog', scopeType, scopeId ?? null] as const,
  labelDesignerEffectiveConfig: (scopeType: string, scopeId?: string | null) =>
    ['label_designer_effective_config', scopeType, scopeId ?? null] as const,
  labelRendererReadiness: (scopeType: string, scopeId?: string | null) =>
    ['label_renderer_readiness', scopeType, scopeId ?? null] as const,
  labelDesignDrafts: (scopeType: string, scopeId?: string | null) =>
    ['label_design_drafts', scopeType, scopeId ?? null] as const,
  labelDesignerAssets: (scopeType: string, scopeId?: string | null) =>
    ['label_designer_assets', scopeType, scopeId ?? null] as const,
  userSecurityActions: (userId?: string | null, limit?: number) =>
    ['user_security_actions', userId ?? null, limit ?? 10] as const,
  userSessions: (userId?: string | null, limit?: number) =>
    ['user_sessions', userId ?? null, limit ?? 50] as const,
} as const;

// ---------- Generic resource hooks ----------
export function useResourceList<T = Record<string, unknown>>(
  resource: string,
  opts?: api.ListOpts,
  queryOpts?: Omit<UseQueryOptions<ListResult<T>>, 'queryKey' | 'queryFn'>
) {
  return useQuery<ListResult<T>>({
    queryKey: qk.list(resource, opts),
    queryFn: () => api.ui_list_resource_v1<T>(resource, opts),
    ...queryOpts,
  });
}

export function useCompleteResourceList<T = Record<string, unknown>>(
  resource: string,
  opts?: api.ListOpts,
  queryOpts?: Omit<UseQueryOptions<ListResult<T>>, 'queryKey' | 'queryFn'>
) {
  return useQuery<ListResult<T>>({
    queryKey: qk.completeList(resource, opts),
    queryFn: () => api.ui_list_resource_complete<T>(resource, opts),
    ...queryOpts,
  });
}

export function useResource<T = Record<string, unknown>>(resource: string, id: string | undefined) {
  return useQuery<T | null>({
    queryKey: qk.resource(resource, id || ''),
    queryFn: () => api.ui_get_resource_v1<T>(resource, id!),
    enabled: !!id,
  });
}

export function useUserSecurityActions(userId: string | undefined, limit = 10) {
  return useQuery<ListResult<api.UserSecurityActionRow>>({
    queryKey: qk.userSecurityActions(userId, limit),
    queryFn: () => api.ui_list_user_security_actions_v1(userId!, limit),
    enabled: Boolean(userId),
  });
}

export function useUserSessions(userId: string | undefined | null, limit = 50, enabled = true) {
  return useQuery<ListResult<api.UserSessionRow>>({
    queryKey: qk.userSessions(userId, limit),
    queryFn: () => api.ui_list_user_sessions_v1(userId ?? null, limit),
    enabled,
  });
}

export function useResourceRowsByIds<T = Record<string, unknown>>(
  resource: string,
  ids: string[],
  queryOpts?: { enabled?: boolean },
) {
  const normalizedIds = Array.from(new Set(ids.filter(Boolean))).sort();
  const enabled = (queryOpts?.enabled ?? true) && normalizedIds.length > 0;
  return useQuery<ListResult<T>>({
    queryKey: ['resources_by_ids', resource, normalizedIds] as const,
    queryFn: async () => {
      const fetchedRows = await Promise.all(
        normalizedIds.map((id) => api.ui_get_resource_v1<T>(resource, id)),
      );
      const rows: T[] = [];
      for (const row of fetchedRows) {
        if (row != null) rows.push(row as T);
      }
      return {
        rows,
        total: rows.length,
        page: 0,
        page_size: rows.length,
      };
    },
    enabled,
  });
}

export function useResourceListsByFilters<T = Record<string, unknown>>(
  resource: string,
  filters: Array<Record<string, unknown>>,
  opts?: Omit<api.ListOpts, 'filter'>,
  queryOpts?: { enabled?: boolean },
) {
  const normalizedFilters = filters.filter((filter) => Object.keys(filter).length > 0);
  const enabled = (queryOpts?.enabled ?? true) && normalizedFilters.length > 0;
  return useQuery<ListResult<T>>({
    queryKey: ['lists_by_filters', resource, normalizedFilters, opts] as const,
    queryFn: async () => {
      const results = await Promise.all(
        normalizedFilters.map((filter) =>
          api.ui_list_resource_complete<T>(resource, {
            ...opts,
            filter,
          }),
        ),
      );
      const rowsById = new Map<string, T>();
      const rowsWithoutId: T[] = [];
      for (const result of results) {
        for (const row of result.rows) {
          const id = (row as Record<string, unknown>).id;
          if (typeof id === 'string' && id) {
            rowsById.set(id, row);
          } else {
            rowsWithoutId.push(row);
          }
        }
      }
      const rows = [...rowsById.values(), ...rowsWithoutId];
      return {
        rows,
        total: rows.length,
        page: 0,
        page_size: rows.length,
      };
    },
    enabled,
  });
}

export function useResourceMetrics(resource: string, opts?: api.ListOpts) {
  return useQuery({
    queryKey: qk.metrics(resource, opts),
    queryFn: () => api.ui_resource_metrics_v1(resource, opts),
  });
}

// ---------- Specific reads ----------
export function useDashboardKpis(
  queryOpts?: Omit<
    UseQueryOptions<
      Array<{ label: string; key: string; value: number | string; delta?: string; tone?: string; spark?: number[] }>
    >,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: qk.dashboardKpis(),
    queryFn: api.dashboardKpis,
    ...queryOpts,
  });
}

/**
 * Phase F1 / CLAIM-INSIGHTS-REPORTING — typed KPI rollup hook.
 *
 * Wraps the canonical KPI resolver `compute_kpi_rollup_v1` (data-source
 * adapter — production swap-seam routes through `client.rpc(...)`) so cards on
 * `/insights/reporting` no longer depend on hardcoded literal values. Mirrors
 * the projection contract in
 * supabase/migrations/202601311830_kpi_catalog_rollups_v1.sql:
 *   • `kpi_definitions(key, name, unit, definition jsonb, ...)`
 *   • `kpi_rollups_daily(kpi_key, day, value_num, numerator, denominator, ...)`
 *
 * The resolver joins the two tables and applies tone thresholds from
 * `definition.tone_thresholds`, returning a typed `KpiRollupResolution` ready
 * for `<KPICard>` consumption (label / value_num / tone / delta / unit).
 *
 * Capability gate is `insights.read` (already declared in the FE registry +
 * backend access_control_policy_core). Tenant scoping resolves via the caller
 * org id — same RLS model as every other tenant-scoped resource.
 */
export function useKpiRollup(
  definition_key: string,
  opts?: { window_days?: number; scope?: { organization_id?: string | null } | null; enabled?: boolean },
) {
  const orgId = opts?.scope?.organization_id ?? null;
  return useQuery<api.KpiRollupResolution>({
    queryKey: qk.kpiRollup(definition_key, opts?.window_days, orgId),
    queryFn: () =>
      api.compute_kpi_rollup_v1({
        definition_key,
        ...(opts?.window_days !== undefined ? { window_days: opts.window_days } : {}),
        ...(opts?.scope ? { scope: opts.scope } : {}),
      }),
    enabled: opts?.enabled !== false && Boolean(definition_key),
  });
}

export function useShipmentTimeline(shipmentId: string | undefined) {
  return useQuery({
    queryKey: qk.shipmentTimeline(shipmentId || ''),
    queryFn: () => api.ui_get_shipment_timeline_v1(shipmentId!),
    enabled: !!shipmentId,
  });
}

export function useShipmentOperationOptions(shipmentId: string | undefined) {
  return useQuery<api.ShipmentAmendCancelOptions>({
    queryKey: qk.shipmentOperationOptions(shipmentId || ''),
    queryFn: () => api.shipment_amend_cancel_options_v1(shipmentId!),
    enabled: !!shipmentId,
  });
}

export function useDecisionLog(
  filters?: { category?: string; limit?: number },
  options?: { enabled?: boolean },
) {
  return useQuery<DecisionLogEntry[]>({
    queryKey: qk.decisionLog(filters),
    queryFn: () => api.listDecisionLog(filters),
    enabled: options?.enabled,
  });
}
export function useResolutionLog(filters?: { category?: string; limit?: number }) {
  return useQuery({ queryKey: qk.resolutionLog(filters), queryFn: () => api.listResolutionLog(filters) });
}
export function useAuditLog(filters?: { limit?: number }) {
  return useQuery({
    queryKey: qk.auditLog(filters),
    queryFn: () => api.listAuditLog(filters),
    retry: false, // capability denial should surface immediately
  });
}
export function useUiEventLog(filters?: { limit?: number }) {
  return useQuery({ queryKey: qk.uiEventLog(filters), queryFn: () => api.listUiEventLog(filters) });
}

export function useTasks(
  filters?: Parameters<typeof api.listTasks>[0],
  queryOpts?: Omit<UseQueryOptions<Awaited<ReturnType<typeof api.listTasks>>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<Awaited<ReturnType<typeof api.listTasks>>>({
    queryKey: qk.tasks(filters),
    queryFn: () => api.listTasks(filters),
    ...queryOpts,
  });
}

export function useResolveSettings(
  category: string,
  scope?: unknown,
  queryOpts?: Omit<UseQueryOptions<SettingsResolution>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<SettingsResolution>({
    queryKey: qk.resolveSettings(category, scope),
    queryFn: () => api.resolveSettings(category, scope),
    enabled: Boolean(category) && (queryOpts?.enabled ?? true),
    ...queryOpts,
  });
}

/**
 * CLAIM-IDENTITY-CAPS — canonical access-policy resolver hook.
 *
 * Wraps the backend evaluator `public.resolve_access_control_policy_v1`
 * (defined in
 * supabase/migrations/202601022113_access_control_policy_core.sql:554) so
 * surfaces consume the override-ladder-resolved policy instead of static
 * frontend seeds. Modules MUST use this hook (not `api.seed.registry()`)
 * for capability/resource matrix reads — the FE seed is for fallback only
 * and will inevitably drift from the backend SSOT.
 *
 * Returns the JSONB `policy` body (capabilities catalog + roles +
 * resource_map + denies) along with the resolved scope and full
 * `scope_path` ladder walk so callers can render a `<LadderViz>` view of
 * how the policy was resolved.
 */
export function useResolveAccessPolicy(
  scopeType?: string,
  scopeId?: string | null,
  queryOpts?: Omit<UseQueryOptions<AccessPolicyResolution>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<AccessPolicyResolution>({
    queryKey: qk.resolveAccessPolicy(scopeType, scopeId),
    queryFn: () => api.resolve_access_control_policy_v1({ scope_type: scopeType, scope_id: scopeId ?? null }),
    enabled: queryOpts?.enabled ?? true,
    ...queryOpts,
  });
}
export function useResolveMobilePolicy(category: string, scope?: unknown) {
  return useQuery<api.MobilePolicyResolution | null>({
    queryKey: qk.resolveMobilePolicy(category, scope),
    queryFn: () => api.resolveMobilePolicy(category, scope),
  });
}

export function usePickupRequests<T extends Record<string, unknown> = Record<string, unknown>>(filter?: unknown) {
  return useQuery({ queryKey: qk.pickups.requests(filter), queryFn: () => api.pickup_requests_list_v1<T>(filter) });
}
export function usePickupWaves<T extends Record<string, unknown> = Record<string, unknown>>(filter?: unknown) {
  return useQuery({ queryKey: qk.pickups.waves(filter), queryFn: () => api.pickup_waves_list_v1<T>(filter) });
}
export function usePickupFailures<T extends Record<string, unknown> = Record<string, unknown>>(filter?: unknown) {
  return useQuery({ queryKey: qk.pickups.failures(filter), queryFn: () => api.pickup_failures_list_v1<T>(filter) });
}

/**
 * REAUDIT INSIGHTS §D3 closure — facade renamed to `ui_get_trace_v1` to
 * match the canonical migration `202601051630_ui_get_trace_v1.sql`. The
 * hook returns the canonical 3-section envelope
 * (`{correlation_id, observability_events, domain_events, workflow_runs}`)
 * directly; the legacy `{spans:[…]}` derivation is retired.
 */
export function useTrace(correlationId: string | undefined) {
  return useQuery<UiTrace>({
    queryKey: qk.trace(correlationId || ''),
    queryFn: () => api.ui_get_trace_v1(correlationId!),
    enabled: !!correlationId,
  });
}
export function useRoutePlanExecutionPack(planId: string | undefined, enabled = true) {
  return useQuery<api.RoutePlanExecutionPack | null>({
    queryKey: qk.routePlanExecutionPack(planId || ''),
    queryFn: () => api.ui_route_plan_execution_pack_v1(planId!),
    enabled: enabled && !!planId,
  });
}
export function useReturnToBranch() {
  return useQuery({
    queryKey: qk.returnToBranch(),
    queryFn: () => api.return_to_branch_shipments_v1.list(),
  });
}

/**
 * CLAIM-OPERATIONS-WIRING (Phase C1) — recommendation hint for the
 * returned-to-branch surface (and exceptions queue when a row carries a
 * known `dispatch_exception_reason`). Backed by the canonical
 * `public.resolve_ndr_branch_next_action_v1` RPC; the operator surface
 * renders this as a small chip ("recommended: reschedule").
 */
export function useNdrBranchNextAction(
  args?: api.NdrBranchNextActionArgs,
  enabled = true,
) {
  return useQuery<string>({
    queryKey: qk.ndrBranchNextAction(args),
    queryFn: () => api.resolve_ndr_branch_next_action_v1(args ?? {}),
    enabled: enabled && !!args?.organization_id,
  });
}
export function useCodSummary(scope?: unknown) {
  return useQuery({ queryKey: qk.codSummary(scope), queryFn: () => api.compute_cod_payment_collection_summary_v1(scope) });
}
export function useDeliverySlots(args?: unknown) {
  return useQuery({ queryKey: qk.deliverySlots(args), queryFn: () => api.list_delivery_slots_v1(args) });
}

/**
 * Strongly-typed delivery-slot lookup keyed on (shipment_id, slot_date).
 * Use this in modals/forms where the picker should only fetch once both
 * inputs are known. Backed by `list_delivery_slots_v1` (canonical RPC); the
 * adapter currently returns synthetic windows in the in-memory data-source
 * and will swap to the production RPC at the seam.
 *
 * Spec-Issue: trace lifecycle close. Step: lifecycle-link.
 */
export function useListDeliverySlots(args?: { shipment_id?: string; slot_date?: string }) {
  const enabled = !!(args?.shipment_id && args?.slot_date);
  return useQuery({
    queryKey: qk.deliverySlots(args),
    queryFn: () => api.list_delivery_slots_v1(args),
    enabled,
  });
}

// ---------- Mutation hooks (canonical pattern: mutate → invalidate → toast) ----------
export function useTransitionTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      taskId: string;
      transition: { next_status?: string; payload?: Record<string, unknown>; [k: string]: unknown };
    }) => api.transition_task_v1(args.taskId, args.transition),
    onSuccess: async () => {
      const resources = [
        'tasks',
        'task_events',
        'workflow_runs',
        'workflow_run_steps',
        'settings_versions',
        'settlement_batches',
        'settlement_batch_summary',
        'route_runs',
        'route_stops',
        'route_run_directory',
        'shipment_actions',
        'shipment_directory',
      ];
      await refreshTaskQueries(qc);
      await refreshListQueries(qc, resources);
      await refreshCompleteListQueries(qc, [
        'tasks',
        'task_events',
        'workflow_runs',
        'workflow_run_steps',
        'settings_versions',
        'settlement_batches',
        'settlement_batch_summary',
        'finance_events',
        'finance_events_ledger',
        'shipment_actions',
        'shipment_directory',
      ]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['settings_resolution'], refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: ['mobile_policy'], refetchType: 'active' }),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: ['settings_resolution'], type: 'active' }),
        qc.refetchQueries({ queryKey: ['mobile_policy'], type: 'active' }),
      ]);
    },
  });
}

export function useResolveManualReviewTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      taskId: string;
      resolution_outcome?: string;
      resolution_notes?: string | null;
    }) => api.resolve_manual_review_task_v1(args.taskId, {
      resolution_outcome: args.resolution_outcome ?? 'approved',
      resolution_notes: args.resolution_notes ?? null,
    }),
    onSuccess: async () => {
      await refreshListQueries(qc, [
        'manual_review_tasks',
        'geocoding_attempts',
        'geocodes',
        'workflow_runs',
        'workflow_run_steps',
        'decision_log',
        'shipment_actions',
        'shipment_directory',
      ]);
      await refreshCompleteListQueries(qc, [
        'manual_review_tasks',
        'workflow_runs',
        'workflow_run_steps',
        'decision_log',
        'shipment_actions',
        'shipment_directory',
      ]);
    },
  });
}

export function useAssignTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.AssignTaskArgs) => api.assign_task_v1(args),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: qk.tasks() });
      await refreshListQueries(qc, ['tasks', 'task_events']);
      await refreshCompleteListQueries(qc, ['tasks', 'task_events']);
    },
  });
}

export function useShipmentAmendCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { shipmentId: string; op: string; payload: Record<string, unknown>; dryRun?: boolean }) =>
      api.shipment_amend_cancel_v1(args.shipmentId, args.op, args.payload, { dryRun: args.dryRun }),
    onSuccess: async (_data, vars) => {
      const refreshes: Array<Promise<unknown>> = [
        refreshShipmentOperationReadModels(qc, vars.shipmentId),
        qc.invalidateQueries({ queryKey: qk.shipmentOperationOptions(vars.shipmentId), refetchType: 'active' }),
      ];
      if (vars.op === 'address') {
        refreshes.push(qc.invalidateQueries({ queryKey: ['resources_by_ids', 'addresses'], refetchType: 'active' }));
        refreshes.push(qc.refetchQueries({ queryKey: ['resources_by_ids', 'addresses'], type: 'active' }));
      }
      await Promise.all(refreshes);
    },
  });
}

// W13-5 — operator-initiated comms attempt enqueue. Closes OPERATIONS D3 §3
// (CommsTab "Send now" orphan-toast). Invalidates the shipment-scoped
// `comms_attempts` registry so the drawer's Comms tab re-reads after enqueue
// and reflects the new `queued` row.
export function useEnqueueCommsAttempt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      shipment_id: string;
      channel: string;
      template_id?: string;
      recipient_override?: Record<string, unknown>;
    }) => api.enqueue_comms_attempt_v1(args),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.list('comms_attempts') });
      if (vars.shipment_id) qc.invalidateQueries({ queryKey: qk.resource('shipments', vars.shipment_id) });
    },
  });
}

export function useShipmentBatchOp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { ids: string[]; op: string; payload: Record<string, unknown>; dryRun?: boolean }) =>
      api.ui_execute_shipment_batch_operation_v1(args.ids, args.op, args.payload, { dryRun: args.dryRun }),
    onSuccess: (_data, vars) => refreshShipmentOperationReadModels(qc, vars.ids),
  });
}

export function useResortShipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shipmentId: string) => api.ui_execute_shipment_resort_v1(shipmentId),
    onSuccess: async (_d, shipmentId) => {
      await Promise.all([
        refreshShipmentOperationReadModels(qc, shipmentId, SHIPMENT_ROUTING_READBACK_RESOURCES),
        qc.invalidateQueries({ queryKey: ['resources_by_ids', 'baskets'], refetchType: 'active' }),
        qc.refetchQueries({ queryKey: ['resources_by_ids', 'baskets'], type: 'active' }),
      ]);
    },
  });
}

export function useRequeueShipmentGeocode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ShipmentUpdateGeocodeArgs) => api.ui_execute_shipment_update_geocode_v1(args),
    onSuccess: (_data, vars) =>
      refreshShipmentOperationReadModels(qc, vars.shipment_id, SHIPMENT_ROUTING_READBACK_RESOURCES),
  });
}

export function useUpdateBasketState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.ui_update_basket_state_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['list', 'baskets'] });
      qc.invalidateQueries({ queryKey: ['resource', 'baskets'] });
      qc.invalidateQueries({ queryKey: ['resources_by_ids', 'baskets'] });
      qc.invalidateQueries({ queryKey: ['list', 'basket_transitions'] });
      qc.invalidateQueries({ queryKey: ['lists_by_filters', 'basket_transitions'] });
    },
  });
}

export function useCreateBasket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BasketCreateArgs) => api.basket_create_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['list', 'baskets'] });
      qc.invalidateQueries({ queryKey: ['resources_by_ids', 'baskets'] });
      qc.invalidateQueries({ queryKey: ['list', 'basket_transitions'] });
      qc.invalidateQueries({ queryKey: ['lists_by_filters', 'basket_transitions'] });
    },
  });
}

export function useUpdateBasket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BasketUpdateArgs) => api.basket_update_v1(args),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ['list', 'baskets'] });
      qc.invalidateQueries({ queryKey: ['resource', 'baskets'] });
      qc.invalidateQueries({ queryKey: ['resources_by_ids', 'baskets'] });
      qc.invalidateQueries({ queryKey: qk.resource('baskets', args.basket_id) });
      qc.invalidateQueries({ queryKey: ['list', 'basket_items'] });
      qc.invalidateQueries({ queryKey: ['lists_by_filters', 'basket_items'] });
      qc.invalidateQueries({ queryKey: ['list', 'basket_transitions'] });
      qc.invalidateQueries({ queryKey: ['lists_by_filters', 'basket_transitions'] });
    },
  });
}

function invalidateListQueries(qc: QueryClient, resources: string[]) {
  return Promise.all(
    resources.flatMap((resource) => [
      qc.invalidateQueries({ queryKey: ['list', resource] }),
      qc.invalidateQueries({ queryKey: ['lists_by_filters', resource] }),
    ]),
  );
}

const SHIPMENT_OPERATION_READBACK_RESOURCES = [
  'shipments',
  'shipment_directory',
  'shipment_actions',
  'decision_log',
  'audit_table_changes',
] as const;

const SHIPMENT_ROUTING_READBACK_RESOURCES = [
  'addresses',
  'geocodes',
  'geocoding_attempts',
  'manual_review_tasks',
  'workflow_runs',
  'workflow_run_steps',
  'baskets',
  'basket_items',
  'basket_transitions',
  'route_runs',
  'route_run_directory',
  'route_stops',
  'route_plans',
  'route_plan_directory',
  'route_plan_delivery_wave_candidates',
] as const;

async function refreshListQueries(qc: QueryClient, resources: string[]) {
  await Promise.all(
    resources.flatMap((resource) => [
      qc.invalidateQueries({ queryKey: ['list', resource], refetchType: 'active' }),
      qc.invalidateQueries({ queryKey: ['lists_by_filters', resource], refetchType: 'active' }),
    ]),
  );
  await Promise.all(
    resources.flatMap((resource) => [
      qc.refetchQueries({ queryKey: ['list', resource], type: 'active' }),
      qc.refetchQueries({ queryKey: ['lists_by_filters', resource], type: 'active' }),
    ]),
  );
}

async function refreshCompleteListQueries(qc: QueryClient, resources: string[]) {
  await Promise.all(
    resources.map((resource) =>
      qc.invalidateQueries({ queryKey: ['list', resource, 'complete'], refetchType: 'active' }),
    ),
  );
  await Promise.all(
    resources.map((resource) =>
      qc.refetchQueries({ queryKey: ['list', resource, 'complete'], type: 'active' }),
    ),
  );
}

async function refreshTaskQueries(qc: QueryClient) {
  await qc.invalidateQueries({ queryKey: ['tasks'], refetchType: 'active' });
  await qc.refetchQueries({ queryKey: ['tasks'], type: 'active' });
}

export async function refreshWorkflowRunReadModels(qc: QueryClient) {
  const resources = ['workflow_runs', 'workflow_run_directory'];
  await Promise.all([
    refreshListQueries(qc, resources),
    refreshCompleteListQueries(qc, resources),
  ]);
}

export async function refreshFinanceWorkflowReadModels(qc: QueryClient) {
  const resources = [
    'tasks',
    'task_events',
    'workflow_runs',
    'workflow_run_steps',
    'settlement_batches',
    'settlement_batch_summary',
    'cod_entries',
    'finance_events',
    'finance_events_ledger',
  ];
  const results = await Promise.allSettled([
    refreshListQueries(qc, resources),
    refreshCompleteListQueries(qc, resources),
    qc.invalidateQueries({ queryKey: ['cod_summary'], refetchType: 'active' }),
    qc.refetchQueries({ queryKey: ['cod_summary'], type: 'active' }),
  ]);

  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.warn('finance workflow read-model refresh failed', result.reason);
    }
  });
}

async function refreshTenantInviteReadModels(qc: QueryClient) {
  const results = await Promise.allSettled([
    refreshListQueries(qc, ['users', 'user_directory', 'rbac_user_role_assignments']),
    refreshCompleteListQueries(qc, ['users', 'user_directory']),
    qc.invalidateQueries({ queryKey: ['user_security_actions'], refetchType: 'active' }),
    qc.refetchQueries({ queryKey: ['user_security_actions'], type: 'active' }),
  ]);

  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.warn('tenant user invite read-model refresh failed', result.reason);
    }
  });
}

export async function refreshShipmentOperationReadModels(
  qc: QueryClient,
  shipmentIds?: string | string[] | null,
  extraResources: readonly string[] = [],
) {
  const resources = Array.from(new Set([...SHIPMENT_OPERATION_READBACK_RESOURCES, ...extraResources]));
  const ids = Array.from(
    new Set((Array.isArray(shipmentIds) ? shipmentIds : shipmentIds ? [shipmentIds] : []).filter(Boolean)),
  );

  await Promise.all([
    refreshListQueries(qc, resources),
    refreshCompleteListQueries(qc, resources),
    qc.invalidateQueries({ queryKey: ['resources_by_ids', 'shipments'], refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: ['resources_by_ids', 'shipment_directory'], refetchType: 'active' }),
    qc.refetchQueries({ queryKey: ['resources_by_ids', 'shipments'], type: 'active' }),
    qc.refetchQueries({ queryKey: ['resources_by_ids', 'shipment_directory'], type: 'active' }),
    ...ids.flatMap((id) => [
      qc.invalidateQueries({ queryKey: qk.resource('shipments', id), refetchType: 'active' }),
      qc.invalidateQueries({ queryKey: qk.shipmentTimeline(id), refetchType: 'active' }),
      qc.refetchQueries({ queryKey: qk.resource('shipments', id), type: 'active' }),
      qc.refetchQueries({ queryKey: qk.shipmentTimeline(id), type: 'active' }),
    ]),
  ]);
}

async function refreshListAndResourceQueries(
  qc: QueryClient,
  resources: string[],
  resource: string,
  id: string | null | undefined,
) {
  await Promise.all([
    refreshListQueries(qc, resources),
    refreshCompleteListQueries(qc, resources),
  ]);
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['resources_by_ids', resource], refetchType: 'active' }),
    id ? qc.invalidateQueries({ queryKey: qk.resource(resource, id), refetchType: 'active' }) : Promise.resolve(),
  ]);
  await Promise.all([
    qc.refetchQueries({ queryKey: ['resources_by_ids', resource], type: 'active' }),
    id ? qc.refetchQueries({ queryKey: qk.resource(resource, id), type: 'active' }) : Promise.resolve(),
  ]);
}

function mutationResultId(value: unknown, ...keys: string[]): string | null {
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

async function refreshRoutePlanReadModels(qc: QueryClient, planId?: string | null) {
  await refreshListQueries(qc, ['route_plans', 'route_plan_directory']);
  if (!planId) return;

  await Promise.all([
    qc.invalidateQueries({ queryKey: ['resources_by_ids', 'route_plans'], refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: ['resources_by_ids', 'route_plan_directory'], refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: qk.resource('route_plans', planId), refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: qk.resource('route_plan_directory', planId), refetchType: 'active' }),
  ]);
  await Promise.all([
    qc.refetchQueries({ queryKey: ['resources_by_ids', 'route_plans'], type: 'active' }),
    qc.refetchQueries({ queryKey: ['resources_by_ids', 'route_plan_directory'], type: 'active' }),
    qc.refetchQueries({ queryKey: qk.resource('route_plans', planId), type: 'active' }),
    qc.refetchQueries({ queryKey: qk.resource('route_plan_directory', planId), type: 'active' }),
  ]);
}

const DISPATCH_READBACK_RESOURCES = [
  'route_runs',
  'route_stops',
  'route_run_directory',
  'route_run_assignments',
  'route_run_assignment_events',
  'route_stop_reassignment_events',
  'tasks',
] as const;

async function invalidateDispatchLists(qc: QueryClient) {
  invalidateListQueries(qc, [...DISPATCH_READBACK_RESOURCES]);
  await refreshCompleteListQueries(qc, [...DISPATCH_READBACK_RESOURCES]);
}

// Route plan lifecycle mutations (canonical SSOT: AGENTS.md lines 45-48 +
// supabase/migrations route_plan_*). Each mutation invalidates both the base
// `route_plans` list and the derived route_plan_directory projection so the
// table re-reads after transitions. Apply additionally invalidates dispatch
// (route_runs / route_stops / route_run_directory).
export function useCreateRoutePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: api.RoutePlanCreateInput) => api.ui_create_route_plan_v1(input),
    onSuccess: (data) => refreshRoutePlanReadModels(qc, data.route_plan_id ?? data.plan_id),
  });
}
export function useSolveRoutePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.ui_solve_route_plan_v1(planId),
    onSuccess: (_data, planId) => refreshRoutePlanReadModels(qc, planId),
    onSettled: (_data, _error, planId) => {
      if (_error) return refreshRoutePlanReadModels(qc, planId);
      return undefined;
    },
  });
}
export function useFreezeRoutePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.ui_freeze_route_plan_v1(planId),
    onSuccess: (_data, planId) => refreshRoutePlanReadModels(qc, planId),
    onSettled: (_data, _error, planId) => {
      if (_error) return refreshRoutePlanReadModels(qc, planId);
      return undefined;
    },
  });
}
export function usePublishRoutePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.ui_publish_route_plan_v1(planId),
    onSuccess: async (_data, planId) => {
      await refreshRoutePlanReadModels(qc, planId);
      await qc.invalidateQueries({ queryKey: qk.routePlanExecutionPack(planId), refetchType: 'active' });
      await qc.refetchQueries({ queryKey: qk.routePlanExecutionPack(planId), type: 'active' });
    },
    onSettled: async (_data, _error, planId) => {
      if (!_error) return;
      await refreshRoutePlanReadModels(qc, planId);
      await qc.invalidateQueries({ queryKey: qk.routePlanExecutionPack(planId), refetchType: 'active' });
    },
  });
}
export function useApplyRoutePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.ui_apply_route_plan_v1(planId),
    onSuccess: async (_data, planId) => {
      await refreshRoutePlanReadModels(qc, planId);
      await invalidateDispatchLists(qc);
    },
    onSettled: async (_data, _error, planId) => {
      if (!_error) return;
      await refreshRoutePlanReadModels(qc, planId);
      await invalidateDispatchLists(qc);
    },
  });
}
export function useRebalanceRoutePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: api.RoutePlanRebalanceInput) =>
      api.ui_rebalance_route_plan_v1(input),
    onSuccess: (data) => refreshRoutePlanReadModels(qc, data.plan_id),
  });
}
export function useValidateRoutePlanConstraints() {
  return useMutation({
    mutationFn: (planId: string) => api.route_plan_validate_constraints_v1(planId),
  });
}

// Dispatch (route runs + stops) mutations. Stop reassign / run assign /
// departure confirm / scan-out reconciliation all touch the dispatch list
// views — invalidate them so the runs and stops panes refresh.
export function useExecuteRouteStopReassign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { stopIds: string[]; target: api.RouteStopReassignTarget }) =>
      api.ui_execute_route_stop_reassign_v1(args.stopIds, args.target),
    onSuccess: () => invalidateDispatchLists(qc),
  });
}
export function useExecuteRouteRunAssign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { runId: string; target: unknown }) => api.ui_execute_route_run_assign_v1(args.runId, args.target),
    onSuccess: () => {
      void invalidateDispatchLists(qc);
    },
  });
}
export function useExecuteRouteRunAssignmentResponse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      runId: string;
      actionKey: string;
      params?: api.RouteRunAssignmentResponseParams;
    }) => api.ui_execute_route_run_assignment_response_v1(args.runId, args.actionKey, args.params),
    onSuccess: () => invalidateDispatchLists(qc),
  });
}
export function useConfirmRouteRunDeparture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.ui_confirm_route_run_departure_v1(runId),
    onSuccess: () => invalidateDispatchLists(qc),
  });
}
export function useReconcileRouteRunScanOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.route_run_scan_out_reconciliation_v1(runId),
    onSuccess: () => invalidateDispatchLists(qc),
  });
}

export function useReserveSlot() {
  return useMutation({
    // CLAIM-LIFECYCLE-LINK Gap 2: also forward shipment_id + window_id when the
    // caller supplies them. The backing RPC `reserve_delivery_slot_v1` accepts
    // optional window resolution context; passing the picked window keeps the
    // operator's selection explicit instead of letting the server pick a
    // default window.
    mutationFn: (args: { slot_date: string; shipment_id?: string; window_id?: string }) =>
      api.reserve_delivery_slot_v1(args),
  });
}

export function useDispatchExceptionResolution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      taskId: string;
      resolution: unknown;
      dryRun?: 'preview' | boolean;
      // Canonical 6-arg payload per migration
      // 202604091530_b09_ndr_resolution_orchestration_v1.sql line 2476.
      // Optional today (legacy callers omit it); the data-source adapter
      // synthesizes defaults when not provided. Pass this for swap-ready code.
      canonical?: Partial<import('./data-source').DispatchExceptionResolutionCanonicalArgs>;
    }) =>
      api.ui_execute_dispatch_exception_resolution_v1(args.taskId, args.resolution, {
        dryRun: args.dryRun,
        ...(args.canonical ? { canonical: args.canonical } : {}),
      }),
    onSuccess: async () => {
      await Promise.all([
        refreshCompleteListQueries(qc, ['task_events']),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: qk.list('task_events') }),
        qc.invalidateQueries({ queryKey: qk.list('workflow_runs') }),
        qc.invalidateQueries({ queryKey: qk.list('shipment_actions') }),
        qc.invalidateQueries({ queryKey: qk.decisionLog() }),
        qc.invalidateQueries({ queryKey: qk.auditLog() }),
        qc.invalidateQueries({ queryKey: qk.returnToBranch() }),
      ]);
    },
  });
}

export function useTransitionWarehouseTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.TransitionWarehouseTransferArgs) =>
      api.transition_warehouse_transfer_v1(args),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.list('warehouse_transfer_summary') }),
        qc.invalidateQueries({ queryKey: qk.list('warehouse_transfer_items') }),
        qc.invalidateQueries({ queryKey: qk.list('warehouse_checkpoint_scans') }),
        qc.invalidateQueries({ queryKey: qk.list('tasks') }),
      ]);
    },
  });
}

function invalidateWarehouseTransferLists(qc: QueryClient) {
  invalidateListQueries(qc, [
    'warehouse_transfer_summary',
    'warehouse_transfer_items',
    'warehouse_checkpoint_scans',
    'tasks',
  ]);
}

export function useCreateWarehouseTransferManifest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      api.create_warehouse_transfer_manifest_v1(args),
    onSuccess: () => invalidateWarehouseTransferLists(qc),
  });
}

export function useWarehouseTransferDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { warehouse_transfer_id: string; params?: Record<string, unknown> }) =>
      api.ui_execute_warehouse_transfer_dispatch_v1(args),
    onSuccess: () => invalidateWarehouseTransferLists(qc),
  });
}

export function useWarehouseTransferCheckpoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Parameters<typeof api.ui_execute_warehouse_transfer_checkpoint_v1>[0]) =>
      api.ui_execute_warehouse_transfer_checkpoint_v1(args),
    onSuccess: () => invalidateWarehouseTransferLists(qc),
  });
}

export function useWarehouseTransferReconcileDestination() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Parameters<typeof api.ui_execute_warehouse_transfer_reconcile_v1>[0]) =>
      api.ui_execute_warehouse_transfer_reconcile_v1(args),
    onSuccess: () => invalidateWarehouseTransferLists(qc),
  });
}

export function useReprintLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { labelId: string; reason: string; shipmentId?: string }) =>
      api.request_label_reprint(args.labelId, { reason: args.reason }),
    onSuccess: async (_data, args) => {
      const labelResources = ['labels', 'label_jobs', 'label_versions', 'label_artifacts', 'label_template_directory', 'shipment_directory'];
      await Promise.all([
        refreshListAndResourceQueries(qc, labelResources, 'labels', args.labelId),
        args.shipmentId
          ? refreshShipmentOperationReadModels(qc, args.shipmentId, labelResources)
          : Promise.resolve(),
      ]);
    },
  });
}

export function useRequestTargetLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.TargetLabelRequestArgs) => api.ui_request_label_generation_target_v1(args),
    onSuccess: async (data) => {
      await refreshListAndResourceQueries(
        qc,
        ['label_jobs', 'label_artifacts', 'label_template_directory'],
        'label_jobs',
        data.label_job_id,
      );
    },
  });
}

export function useLabelDesignDrafts(
  scopeType: api.LabelDesignScopeType,
  scopeId?: string | null,
) {
  return useQuery({
    queryKey: qk.labelDesignDrafts(scopeType, scopeId),
    enabled: !!scopeId,
    queryFn: () => api.label_designer_list_drafts(scopeType, scopeId as string),
  });
}

export function useLabelDesignerFieldCatalog(
  scopeType: api.LabelDesignScopeType,
  scopeId?: string | null,
) {
  return useQuery({
    queryKey: qk.labelDesignerFieldCatalog(scopeType, scopeId),
    enabled: !!scopeId,
    queryFn: () => api.label_designer_get_field_catalog(scopeType, scopeId as string),
  });
}

export function useLabelDesignerEffectiveConfig(
  scopeType: api.LabelDesignScopeType,
  scopeId?: string | null,
) {
  return useQuery({
    queryKey: qk.labelDesignerEffectiveConfig(scopeType, scopeId),
    enabled: !!scopeId,
    queryFn: async () => {
      const [design, renderPolicy, printProfile, mediaCatalog] = await Promise.all([
        api.label_designer_get_effective_label_design(scopeType, scopeId as string),
        api.label_designer_get_effective_label_render_policy(scopeType, scopeId as string),
        api.label_designer_get_effective_label_print_profile(scopeType, scopeId as string),
        api.label_designer_get_label_media_catalog(scopeType, scopeId as string),
      ]);
      return { design, renderPolicy, printProfile, mediaCatalog };
    },
  });
}

export function useLabelRendererReadiness(
  scopeType: api.LabelDesignScopeType,
  scopeId?: string | null,
  queryOpts?: Omit<UseQueryOptions<api.LabelRendererReadinessResult>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<api.LabelRendererReadinessResult>({
    queryKey: qk.labelRendererReadiness(scopeType, scopeId),
    enabled: !!scopeId,
    queryFn: () => api.ui_label_renderer_readiness_v1(scopeType, scopeId as string),
    ...queryOpts,
  });
}

export function useRecordLabelPrinterCertification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.LabelPrinterCertificationArgs) =>
      api.ui_record_label_printer_certification_v1(args),
    onSuccess: async (data, args) => {
      const readinessKey = qk.labelRendererReadiness(args.scope_type, args.scope_id);
      if (data.readiness) {
        qc.setQueryData(readinessKey, data.readiness);
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: readinessKey, refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: qk.labelDesignerEffectiveConfig(args.scope_type, args.scope_id), refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: qk.resolveSettingsCategory('label_print_profile'), refetchType: 'active' }),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: readinessKey, type: 'active' }),
        qc.refetchQueries({ queryKey: qk.labelDesignerEffectiveConfig(args.scope_type, args.scope_id), type: 'active' }),
        qc.refetchQueries({ queryKey: qk.resolveSettingsCategory('label_print_profile'), type: 'active' }),
      ]);
    },
  });
}

export function useLabelDesignerAssets(
  scopeType: api.LabelDesignScopeType,
  scopeId?: string | null,
) {
  return useQuery({
    queryKey: qk.labelDesignerAssets(scopeType, scopeId),
    enabled: !!scopeId,
    queryFn: () => api.label_designer_list_assets(),
  });
}

const LABEL_DESIGN_READBACK_RESOURCES = [
  'label_template_specs',
  'label_template_directory',
  'label_jobs',
  'label_artifacts',
  'settings_versions',
  'settings_resolution_log',
] as const;

async function refreshLabelDesignReadModels(qc: QueryClient, scopeType?: string | null, scopeId?: string | null) {
  const scopeKey = scopeType ?? 'tenant';
  const normalizedScopeId = scopeId ?? null;
  const effectiveConfigKey = qk.labelDesignerEffectiveConfig(scopeKey, normalizedScopeId);
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.labelDesignDrafts(scopeKey, normalizedScopeId), refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: effectiveConfigKey, refetchType: 'active' }),
    qc.refetchQueries({ queryKey: qk.labelDesignDrafts(scopeKey, normalizedScopeId), type: 'active' }),
    qc.refetchQueries({ queryKey: effectiveConfigKey, type: 'active' }),
    refreshListQueries(qc, [...LABEL_DESIGN_READBACK_RESOURCES]),
    refreshCompleteListQueries(qc, [...LABEL_DESIGN_READBACK_RESOURCES]),
  ]);
}

function reconcileLabelDesignDraftReadback(
  qc: QueryClient,
  draft: api.LabelDesignDraft | undefined,
  scopeType?: string | null,
  scopeId?: string | null,
) {
  if (!draft?.id) return;
  const scopeKey = scopeType ?? draft.scope_type ?? 'tenant';
  const normalizedScopeId = scopeId ?? draft.scope_id ?? null;
  qc.setQueryData<api.LabelDesignerDraftListResult | undefined>(
    qk.labelDesignDrafts(scopeKey, normalizedScopeId),
    (current) => {
      const currentDrafts = current?.drafts ?? [];
      return {
        ...(current ?? { ok: true }),
        ok: true,
        drafts: [
          draft,
          ...currentDrafts.filter((row) => row.id !== draft.id),
        ],
      };
    },
  );
}

function reconcileLabelDesignPublishedReadback(
  qc: QueryClient,
  args: { draftId: string; scopeType?: string | null; scopeId?: string | null },
  result: api.LabelDesignerDraftPublishResult,
) {
  if (!args.draftId || result.ok === false) return;
  const scopeKey = args.scopeType ?? result.scope_type ?? 'tenant';
  const normalizedScopeId = args.scopeId ?? result.scope_id ?? null;
  const settingsVersionId = result.settings_version_id ?? null;
  qc.setQueryData<api.LabelDesignerDraftListResult | undefined>(
    qk.labelDesignDrafts(scopeKey, normalizedScopeId),
    (current) => {
      if (!current?.drafts?.length) return current;
      return {
        ...current,
        drafts: current.drafts.map((row) => (
          row.id === args.draftId
            ? {
              ...row,
              status: 'published',
              published_settings_version_id: settingsVersionId ?? row.published_settings_version_id ?? null,
              updated_at: new Date().toISOString(),
              published_at: row.published_at ?? new Date().toISOString(),
            }
            : row
        )),
      };
    },
  );
}

async function refreshLabelDesignerAssetReadModels(
  qc: QueryClient,
  scopeType?: string | null,
  scopeId?: string | null,
) {
  const scopeKey = scopeType ?? 'tenant';
  const normalizedScopeId = scopeId ?? null;
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.labelDesignerAssets(scopeKey, normalizedScopeId), refetchType: 'active' }),
    qc.refetchQueries({ queryKey: qk.labelDesignerAssets(scopeKey, normalizedScopeId), type: 'active' }),
    refreshLabelDesignReadModels(qc, scopeKey, normalizedScopeId),
  ]);
}

export function useCreateLabelDesignDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Parameters<typeof api.label_designer_create_draft>[0]) =>
      api.label_designer_create_draft(args),
    onSuccess: async (data, args) => {
      reconcileLabelDesignDraftReadback(qc, data.draft, args.scope_type, args.scope_id);
      await refreshLabelDesignReadModels(qc, args.scope_type, args.scope_id);
    },
  });
}

export function useUpdateLabelDesignDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Parameters<typeof api.label_designer_update_draft>[0] & { scopeType?: string | null; scopeId?: string | null }) =>
      api.label_designer_update_draft(args),
    onSuccess: async (data, args) => {
      reconcileLabelDesignDraftReadback(qc, data.draft, args.scopeType, args.scopeId);
      await refreshLabelDesignReadModels(qc, args.scopeType, args.scopeId);
    },
  });
}

export function useArchiveLabelDesignDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Parameters<typeof api.label_designer_archive_draft>[0] & { scopeType?: string | null; scopeId?: string | null }) =>
      api.label_designer_archive_draft(args),
    onSuccess: async (data, args) => {
      reconcileLabelDesignDraftReadback(qc, data.draft, args.scopeType, args.scopeId);
      await refreshLabelDesignReadModels(qc, args.scopeType, args.scopeId);
    },
  });
}

export function useValidateLabelDesignDraft() {
  return useMutation({
    mutationFn: (draftId: string) => api.label_designer_validate_label_design_draft(draftId),
  });
}

export function useLabelDesignerSamplePayload() {
  return useMutation({
    mutationFn: (args: Parameters<typeof api.label_designer_get_sample_payload>[0]) =>
      api.label_designer_get_sample_payload(args),
  });
}

export function usePreviewLabelDesignDraft() {
  return useMutation({
    mutationFn: (args: api.LabelDesignerPreviewArgs) =>
      api.label_designer_preview_label_design_draft(args),
  });
}

export function usePublishLabelDesignDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { draftId: string; changeReason?: string | null; scopeType?: string; scopeId?: string }) =>
      api.label_designer_publish_label_design_draft(args.draftId, args.changeReason ?? null, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
      }),
    onSuccess: async (data, args) => {
      reconcileLabelDesignPublishedReadback(qc, args, data);
      await refreshLabelDesignReadModels(qc, args.scopeType, args.scopeId);
    },
  });
}

export function useUploadLabelDesignerAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.LabelDesignerAssetUploadArgs & { scopeType?: string | null; scopeId?: string | null }) =>
      api.label_designer_upload_asset(args),
    onSuccess: (_data, args) => refreshLabelDesignerAssetReadModels(qc, args.scopeType, args.scopeId),
  });
}

export function useDeleteLabelDesignerAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; scopeType?: string | null; scopeId?: string | null }) =>
      api.label_designer_delete_asset(args.path),
    onSuccess: (_data, args) => refreshLabelDesignerAssetReadModels(qc, args.scopeType, args.scopeId),
  });
}

export function useScanEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { scan_type: string; [k: string]: unknown }) => api.record_scan_event_v1(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('scan_events') });
      qc.invalidateQueries({ queryKey: qk.list('route_runs') });
      qc.invalidateQueries({ queryKey: qk.list('route_stops') });
      qc.invalidateQueries({ queryKey: qk.list('route_run_directory') });
      qc.invalidateQueries({ queryKey: qk.list('warehouse_checkpoint_scans') });
      qc.invalidateQueries({ queryKey: qk.list('warehouse_transfer_summary') });
      qc.invalidateQueries({ queryKey: qk.returnToBranch() });
    },
  });
}

export function useRequestWarehouseScanCorrection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.WarehouseScanCorrectionRequestArgs) =>
      api.ui_request_warehouse_scan_correction_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, [
        'tasks',
        'task_events',
        'warehouse_checkpoint_scans',
        'warehouse_transfer_summary',
      ]);
      await refreshCompleteListQueries(qc, [
        'tasks',
        'warehouse_checkpoint_scans',
        'warehouse_transfer_summary',
      ]);
    },
  });
}

export function useWarehouseTransferExecute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.warehouse_transfer_execute_v1(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('warehouse_transfer_summary') });
      qc.invalidateQueries({ queryKey: qk.list('warehouse_transfer_items') });
      qc.invalidateQueries({ queryKey: qk.list('warehouse_checkpoint_scans') });
      qc.invalidateQueries({ queryKey: qk.list('tasks') });
    },
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UserDeviceRevokeArgs) =>
      api.ui_execute_user_device_revoke_v1(args.deviceId, args.revokedReason),
    onSuccess: async () => {
      await refreshListQueries(qc, ['user_devices', 'user_device_summary']);
    },
  });
}

export function useProposeSettingsChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { category: string; scope: unknown; value: unknown; dryRun?: boolean; justification?: string }) =>
      api.proposeSettingsChange(args.category, args.scope, args.value, { dryRun: args.dryRun, justification: args.justification }),
    onSuccess: async (_data, vars) => {
      if (vars.dryRun) return;
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.resolveSettingsCategory(vars.category), refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: qk.resolveMobilePolicyCategory(vars.category), refetchType: 'active' }),
        refreshTaskQueries(qc),
        refreshListQueries(qc, ['tasks', 'workflow_runs', 'workflow_run_steps', 'settings_versions']),
        refreshCompleteListQueries(qc, ['tasks', 'workflow_runs', 'workflow_run_steps', 'settings_versions']),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: qk.resolveSettingsCategory(vars.category), type: 'active' }),
        qc.refetchQueries({ queryKey: qk.resolveMobilePolicyCategory(vars.category), type: 'active' }),
      ]);
    },
  });
}

export function useApplySettingsValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { category: string; scope: unknown; value: unknown; justification?: string }) =>
      api.applySettingsValue(args.category, args.scope, args.value, { justification: args.justification }),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.resolveSettingsCategory(vars.category), refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: qk.resolveMobilePolicyCategory(vars.category), refetchType: 'active' }),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: qk.resolveSettingsCategory(vars.category), type: 'active' }),
        qc.refetchQueries({ queryKey: qk.resolveMobilePolicyCategory(vars.category), type: 'active' }),
      ]);
    },
  });
}

// Workflow run kickoff (canonical entrypoint per
// supabase/migrations/**: public.start_workflow_run(uuid, jsonb) RETURNS uuid).
//
// The data-source seam (`api.start_workflow_run`) wraps this and decorates the
// response with `correlation_id` + `idempotency_key` + `workflow_status` so
// operator surfaces (e.g. Create-shipment composer, Workflow Studio "Run"
// button, intake replay) can render the trace without an extra round-trip.
//
// Composers must use this hook (not call `api.start_workflow_run` directly) so:
//   1. cache invalidation fans out (we eagerly invalidate the workflow_runs
//      list and any caller-supplied `invalidate` resource keys after a non-
//      dry-run kickoff), and
//   2. devtools + Tanstack Query observability stays uniform.
export interface StartWorkflowRunArgs {
  template_id: string;
  payload?: Record<string, unknown>;
  ui?: { dry_run?: boolean; sample_payload?: unknown; replay_of?: string; allow_inactive?: boolean };
  /**
   * Additional list resource keys to invalidate after a successful non-dry-run
   * kickoff (so the new entity becomes visible without a manual refresh).
   * Caller is responsible for choosing canonical keys (e.g. 'shipments').
   */
  invalidate?: string[];
}

export function useStartWorkflowRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: StartWorkflowRunArgs) =>
      api.start_workflow_run(args.template_id, {
        ...(args.payload ?? {}),
        ...(args.ui ? { ui: args.ui } : {}),
      } as api.WorkflowRunStartContext),
    onSuccess: async (res, vars) => {
      if (res?.dry_run) {
        await refreshWorkflowRunReadModels(qc);
        return;
      }
      const resources = ['workflow_runs', ...(vars.invalidate ?? [])];
      await Promise.all([
        refreshListQueries(qc, resources),
        refreshCompleteListQueries(qc, resources),
      ]);
    },
  });
}

export function useCreateShipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UiCreateShipmentArgs) => api.ui_create_shipment_v1(args),
    onSuccess: async (res, vars) => {
      if (vars.dry_run) return;
      await refreshShipmentOperationReadModels(qc, res?.shipment_id ?? null, [
        'addresses',
        'recipients',
        'recipient_directory',
        'labels',
        'label_jobs',
        'label_versions',
        'workflow_runs',
        'workflow_run_steps',
      ]);
    },
  });
}

// ============================================================================
// PHASE C6 — PLATFORM + FLEET + SUPPORT mutation hooks (canonical wiring shape)
// ============================================================================
//
// Each hook follows the canonical pattern (see plan "Mandatory mutation-wiring
// shape"):
//   1. Wrap the api facade entry via `useMutation`
//   2. Invalidate the relevant `qk.list(<resource>)` on success
//   3. Caller code is responsible for `pushToast`-style UX feedback (so the
//      hook stays platform-agnostic and unit-tests don't have to mock toast).
//
// All RPCs accept a single jsonb envelope (`p_args`) and return
// `{ ok, <resource>_id, correlation_id, settings_resolution_id }`.

// ---------- PLATFORM/alerts ----------
const ALERTS_READBACK_RESOURCES = [
  'alert_rules',
  'alert_rule_directory',
  'alert_triggers',
  'alert_trigger_summary',
  'ops_alerts',
];

async function refreshAlertReadModels(qc: QueryClient) {
  await refreshListQueries(qc, ALERTS_READBACK_RESOURCES);
}

export function useCreateAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.create_alert_rule_v1(args),
    onSuccess: () => refreshAlertReadModels(qc),
  });
}
export function useUpdateAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.update_alert_rule_v1(args),
    onSuccess: () => refreshAlertReadModels(qc),
  });
}
export function usePauseAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.pause_alert_rule_v1(args),
    onSuccess: () => refreshAlertReadModels(qc),
  });
}
export function useResumeAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.resume_alert_rule_v1(args),
    onSuccess: () => refreshAlertReadModels(qc),
  });
}
export function useDeleteAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.delete_alert_rule_v1(args),
    onSuccess: () => refreshAlertReadModels(qc),
  });
}
export function useTestAlertRule() {
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.test_alert_rule_v1(args),
  });
}
export function useAcknowledgeOpsAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.acknowledge_ops_alert_v1(args),
    onSuccess: () => {
      void refreshAlertReadModels(qc);
    },
  });
}
export function useResolveOpsAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.resolve_ops_alert_v1(args),
    onSuccess: () => refreshAlertReadModels(qc),
  });
}

// ---------- PLATFORM/imports (W16-5) ----------
//
// Replaces the /platform/imports PREVIEW chip with canonical write RPCs:
//   * import_job_create_v1 — submit a new bulk import job (status=queued)
//   * import_job_cancel_v1 — cancel a queued/running job (status=cancelled)
// Both actively refresh visible import job and directory lists so the
// DataTable reconciles backend state without a browser reload. Capability gate
// at the call-site is `imports.write`
// (registered alongside `imports.read` in the registry catalog and the
// access_control_policy SSOT per
// supabase/migrations/202604301900_import_jobs.sql).
const IMPORT_JOB_READBACK_RESOURCES = ['import_jobs', 'import_job_directory'];

async function refreshImportJobReadModels(qc: QueryClient, importJobId?: string | null) {
  await Promise.all([
    refreshListQueries(qc, IMPORT_JOB_READBACK_RESOURCES),
    refreshCompleteListQueries(qc, IMPORT_JOB_READBACK_RESOURCES),
  ]);
  if (!importJobId) return;
  await Promise.all(
    IMPORT_JOB_READBACK_RESOURCES.map((resource) =>
      Promise.all([
        qc.invalidateQueries({
          queryKey: qk.resource(resource, importJobId),
          refetchType: 'active',
        }),
        qc.refetchQueries({
          queryKey: qk.resource(resource, importJobId),
          type: 'active',
        }),
      ]),
    ),
  );
}

export function useImportJobCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.import_job_create_v1(args),
    onSuccess: (data) => {
      const importJobId =
        typeof data?.import_job_id === 'string' ? data.import_job_id : null;
      return refreshImportJobReadModels(qc, importJobId);
    },
  });
}
export function useImportJobCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.import_job_cancel_v1(args),
    onSuccess: (_data, vars) => {
      const importJobId =
        typeof vars.import_job_id === 'string' ? vars.import_job_id : null;
      return refreshImportJobReadModels(qc, importJobId);
    },
  });
}

export function useResourceImportStudioPrepare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ResourceImportStudioPrepareArgs) =>
      api.resource_import_studio_prepare_v1(args),
    onSuccess: async (data) => {
      const dryRun = data?.dry_run && typeof data.dry_run === 'object'
        ? data.dry_run as Record<string, unknown>
        : {};
      const runIdValue = dryRun.run_id ?? dryRun.id;
      const runId = typeof runIdValue === 'string' ? runIdValue.trim() : '';
      if (runId) {
        await refreshListAndResourceQueries(
          qc,
          ['tabular_import_runs'],
          'tabular_import_runs',
          runId,
        );
        return;
      }
      await refreshListQueries(qc, ['tabular_import_runs']);
    },
  });
}

export function useResourceImportStudioStart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ResourceImportStudioStartArgs) =>
      api.resource_import_studio_start_v1(args),
    onSuccess: async (_data, args) => {
      await refreshListAndResourceQueries(
        qc,
        ['tabular_import_runs', 'import_jobs', 'import_job_directory'],
        'tabular_import_runs',
        args.run_id,
      );
    },
  });
}

export function useResourceImportStudioCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ResourceImportStudioCancelArgs) =>
      api.resource_import_studio_cancel_v1(args),
    onSuccess: async (_data, args) => {
      await refreshListAndResourceQueries(
        qc,
        ['tabular_import_runs', 'import_jobs', 'import_job_directory'],
        'tabular_import_runs',
        args.run_id,
      );
    },
  });
}

// ---------- INSIGHTS / api-gateway operational write hooks ----------
//
// REAUDIT INSIGHTS §D1, §D2 closure. Both hooks invalidate the affected
// resource queries so the api-gateway surface re-renders without a manual
// refetch. Capability gate at the call-site is `api_gateway.write` (the
// canonical key seeded in `202604280330_block_api_gateway_source_v1.sql`).

export function useBlockApiGatewaySource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BlockApiGatewaySourceArgs) =>
      api.block_api_gateway_source_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, [
        'webhook_sources',
        'webhook_source_directory',
        'api_call_log',
        'api_gateway_observability',
        'api_gateway_requests',
        'api_gateway_rate_limits',
        'api_gateway_rate_limits_summary',
      ]);
    },
  });
}

export function useAdjustApiGatewayRateLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.AdjustApiGatewayRateLimitArgs) =>
      api.adjust_api_gateway_rate_limit_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, [
        'webhook_sources',
        'webhook_source_directory',
        'api_call_log',
        'api_gateway_observability',
        'api_gateway_requests',
        'api_gateway_rate_limits',
        'api_gateway_rate_limits_summary',
      ]);
    },
  });
}

export function useRunApiGatewayRequestTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RunApiGatewayRequestTestArgs) =>
      api.runApiGatewayRequestTest(args),
    onError: async () => {
      await refreshListQueries(qc, [
        'api_call_log',
        'api_gateway_observability',
        'api_gateway_requests',
        'api_gateway_auth_rejections',
        'api_gateway_rate_limits_summary',
      ]);
    },
    onSuccess: async (data) => {
      const requestReadback = data?.request_readback && typeof data.request_readback === 'object'
        ? data.request_readback as Record<string, unknown>
        : {};
      const requestIdValue =
        data?.api_gateway_request_id ??
        requestReadback.request_id ??
        requestReadback.id;
      const requestId = typeof requestIdValue === 'string' ? requestIdValue.trim() : '';
      await refreshListAndResourceQueries(
        qc,
        [
          'api_call_log',
          'api_gateway_observability',
          'api_gateway_requests',
          'api_gateway_rate_limits_summary',
          'workflow_runs',
          'workflow_run_steps',
          'outbound_calls',
        ],
        'api_gateway_requests',
        requestId || null,
      );
      const shipmentIdValue = data?.shipment_id ?? requestReadback.shipment_id;
      const shipmentId = typeof shipmentIdValue === 'string' ? shipmentIdValue.trim() : '';
      if (shipmentId) {
        await refreshListAndResourceQueries(
          qc,
          ['shipments', 'shipment_directory', 'shipment_actions', 'decision_log', 'audit_table_changes'],
          'shipments',
          shipmentId,
        );
      }
    },
  });
}

// ---------- PLATFORM/feature_flags ----------
async function refreshFeatureFlagReadModels(qc: QueryClient) {
  await refreshListQueries(qc, ['feature_flags', 'feature_flag_summary']);
}

export function useCreateFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.create_feature_flag_v1(args),
    onSuccess: () => refreshFeatureFlagReadModels(qc),
  });
}
export function useToggleFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.toggle_feature_flag_v1(args),
    onSuccess: () => refreshFeatureFlagReadModels(qc),
  });
}
export function useUpdateFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.update_feature_flag_v1(args),
    onSuccess: () => refreshFeatureFlagReadModels(qc),
  });
}
export function useEngageKillSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.engage_kill_switch_v1(args),
    onSuccess: () => refreshFeatureFlagReadModels(qc),
  });
}
export function useReleaseKillSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.release_kill_switch_v1(args),
    onSuccess: () => refreshFeatureFlagReadModels(qc),
  });
}
export function useSetRollout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.set_rollout_v1(args),
    onSuccess: () => refreshFeatureFlagReadModels(qc),
  });
}
export function useBulkToggleFeatureFlags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.bulk_toggle_feature_flags_v1(args),
    onSuccess: () => refreshFeatureFlagReadModels(qc),
  });
}

// ---------- PLATFORM/access ----------
export function useRequestCapabilityGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.request_capability_grant_v1(args),
    onSuccess: async () => {
      await Promise.all([
        refreshListQueries(qc, ['capability_grant_requests']),
        refreshCompleteListQueries(qc, ['capability_grant_requests']),
      ]);
    },
  });
}

export function useReviewCapabilityGrantRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.ui_review_capability_grant_request_v1(args),
    onSuccess: async () => {
      const requestResources = ['capability_grant_requests'];
      await Promise.all([
        refreshListQueries(qc, requestResources),
        refreshCompleteListQueries(qc, requestResources),
        refreshRbacRoleProjections(qc),
        refreshCompleteListQueries(qc, ['users', 'user_directory']),
      ]);
    },
  });
}

// ---------- PLATFORM/access — RBAC role-management lifecycle (Phase E3) ----------
// All hooks invalidate the affected resource queries so the access surface
// re-renders without a manual refetch. Capability gate at the call-site is
// `access_policy.approve` (governance-grade write authority).
// Shared invalidation helper for RBAC role-management mutations. Every mutation
// must invalidate the canonical `v_rbac_role_summary` projection so role-drawer
// counters, tier rollups, and assignment tallies refresh after the action.
async function refreshRbacRoleProjections(qc: ReturnType<typeof useQueryClient>) {
  const resources = [
    'rbac_roles',
    'rbac_role_summary',
    'rbac_role_permissions',
    'rbac_user_role_assignments',
  ];
  await Promise.all([
    refreshListQueries(qc, resources),
    refreshCompleteListQueries(qc, resources),
  ]);
}

export function useCreateRbacRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.rbac_create_role_v1(args),
    onSuccess: () => refreshRbacRoleProjections(qc),
  });
}
export function useUpdateRbacRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.rbac_update_role_v1(args),
    onSuccess: () => refreshRbacRoleProjections(qc),
  });
}
export function useDeleteRbacRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.rbac_delete_role_v1(args),
    onSuccess: () => refreshRbacRoleProjections(qc),
  });
}
export function useGrantRbacRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.rbac_grant_role_v1(args),
    onSuccess: async () => {
      await refreshRbacRoleProjections(qc);
      await Promise.all([
        refreshListQueries(qc, ['users', 'user_directory']),
        refreshCompleteListQueries(qc, ['users', 'user_directory']),
      ]);
    },
  });
}
export function useRevokeRbacRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.rbac_revoke_role_v1(args),
    onSuccess: async () => {
      await refreshRbacRoleProjections(qc);
      await Promise.all([
        refreshListQueries(qc, ['users', 'user_directory']),
        refreshCompleteListQueries(qc, ['users', 'user_directory']),
      ]);
    },
  });
}
export function useApplyRbacRoleTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.provision_rbac_roles_from_templates_v1(args),
    onSuccess: async () => {
      await refreshRbacRoleProjections(qc);
      await refreshListQueries(qc, ['rbac_role_templates']);
    },
  });
}

// ---------- PLATFORM/organizations (tenant signup review) ----------
export function useTenantSignupReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.tenant_signup_review_apply_v1(args),
    onSuccess: async () => {
      const resources = [
        'tenant_signup_requests',
        'tenant_signup_request_summary',
        'organizations',
        'users',
        'user_directory',
      ];
      await Promise.all([
        refreshListQueries(qc, resources),
        refreshCompleteListQueries(qc, resources),
      ]);
      await qc.invalidateQueries({ queryKey: ['onboarding_readiness'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['onboarding_readiness'], type: 'active' });
    },
  });
}

export function useTenantSignupConsoleRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.TenantSignupConsoleRequestArgs) =>
      api.tenant_signup_console_request_v1(args),
    onSuccess: async () => {
      const resources = [
        'tenant_signup_requests',
        'tenant_signup_request_summary',
      ];
      await Promise.all([
        refreshListQueries(qc, resources),
        refreshCompleteListQueries(qc, resources),
      ]);
    },
  });
}

export function useUpdateOrganizationProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.OrganizationProfileUpdateArgs) =>
      api.ui_update_organization_profile_v1(args),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        refreshListQueries(qc, ['organizations']),
        refreshCompleteListQueries(qc, ['organizations']),
        qc.invalidateQueries({ queryKey: ['resources_by_ids', 'organizations'], refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: qk.resource('organizations', vars.organization_id), refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: ['settings_resolution'], refetchType: 'active' }),
        qc.invalidateQueries({ queryKey: ['onboarding_readiness'], refetchType: 'active' }),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: ['resources_by_ids', 'organizations'], type: 'active' }),
        qc.refetchQueries({ queryKey: qk.resource('organizations', vars.organization_id), type: 'active' }),
        qc.refetchQueries({ queryKey: ['settings_resolution'], type: 'active' }),
        qc.refetchQueries({ queryKey: ['onboarding_readiness'], type: 'active' }),
      ]);
    },
  });
}

export function useOnboardingReadiness(
  scopeType: UiOnboardingReadiness['scope_type'],
  scopeId?: string | null,
  enabled = true,
) {
  return useQuery<UiOnboardingReadiness>({
    queryKey: qk.onboardingReadiness(scopeType, scopeId ?? null),
    queryFn: () => api.ui_get_onboarding_readiness_v1({ scope_type: scopeType, scope_id: scopeId ?? null }),
    enabled: enabled && (scopeType === 'global' || Boolean(scopeId)),
  });
}

// ---------- FLEET/vehicles ----------
const VEHICLE_READBACK_RESOURCES = [
  'vehicles',
  'vehicle_directory',
  'vehicle_documents',
  'vehicle_assignments',
  'vehicle_events',
  'vehicle_maintenance_windows',
  'vehicle_maintenance_directory',
];

async function refreshVehicleReadModels(qc: QueryClient) {
  await refreshListQueries(qc, VEHICLE_READBACK_RESOURCES);
}

export function useCreateVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.create_vehicle_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useUploadVehicleDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.upload_vehicle_document_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useAssignDriverToVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.assign_driver_to_vehicle_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useUnassignDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.unassign_driver_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useMarkVehicleOos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.mark_vehicle_oos_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useRestoreVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.restore_vehicle_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useScheduleMaintenance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.schedule_maintenance_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useCompleteMaintenance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.complete_maintenance_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useCancelMaintenance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.cancel_maintenance_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}
export function useRecordVehicleEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.record_vehicle_event_v1(args),
    onSuccess: () => refreshVehicleReadModels(qc),
  });
}

// ---------- FLEET/drivers ----------
const DRIVER_READBACK_RESOURCES = [
  'driver_profiles',
  'driver_directory',
  'drivers',
  'driver_documents',
  'driver_compliance_events',
  'vehicle_assignments',
];

async function refreshDriverReadModels(
  qc: QueryClient,
  driverIds?: string | string[] | null,
) {
  const ids = Array.from(
    new Set((Array.isArray(driverIds) ? driverIds : driverIds ? [driverIds] : []).filter(Boolean)),
  );

  await Promise.all([
    refreshListQueries(qc, DRIVER_READBACK_RESOURCES),
    refreshCompleteListQueries(qc, DRIVER_READBACK_RESOURCES),
    qc.invalidateQueries({ queryKey: ['resources_by_ids', 'driver_profiles'], refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: ['resources_by_ids', 'driver_directory'], refetchType: 'active' }),
    qc.refetchQueries({ queryKey: ['resources_by_ids', 'driver_profiles'], type: 'active' }),
    qc.refetchQueries({ queryKey: ['resources_by_ids', 'driver_directory'], type: 'active' }),
    ...ids.flatMap((id) => [
      qc.invalidateQueries({ queryKey: qk.resource('driver_profiles', id), refetchType: 'active' }),
      qc.invalidateQueries({ queryKey: qk.resource('driver_directory', id), refetchType: 'active' }),
      qc.refetchQueries({ queryKey: qk.resource('driver_profiles', id), type: 'active' }),
      qc.refetchQueries({ queryKey: qk.resource('driver_directory', id), type: 'active' }),
    ]),
  ]);
}

export function useCreateDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.create_driver_v1(args),
    onSuccess: () => refreshDriverReadModels(qc),
  });
}
export function useUploadDriverDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.upload_driver_document_v1(args),
    onSuccess: () => refreshDriverReadModels(qc),
  });
}
export function useSuspendDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.suspend_driver_v1(args),
    onSuccess: () => refreshDriverReadModels(qc),
  });
}
export function useRestoreDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.restore_driver_v1(args),
    onSuccess: () => refreshDriverReadModels(qc),
  });
}
export function useVerifyDriverDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.verify_driver_document_v1(args),
    onSuccess: () => refreshDriverReadModels(qc),
  });
}
export function useRejectDriverDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.reject_driver_document_v1(args),
    onSuccess: () => refreshDriverReadModels(qc),
  });
}
export function useCreateDriverComplianceEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.create_driver_compliance_event_v1(args),
    onSuccess: () => refreshDriverReadModels(qc),
  });
}
export function useRecordHoursOfServiceSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.record_hours_of_service_segment_v1(args),
    onSuccess: async (result, args) => {
      const driverId =
        typeof result.driver_profile_id === 'string'
          ? result.driver_profile_id
          : typeof result.driver_id === 'string'
            ? result.driver_id
            : typeof args.driver_profile_id === 'string'
              ? args.driver_profile_id
              : typeof args.driver_id === 'string'
                ? args.driver_id
                : null;
      await refreshDriverReadModels(qc, driverId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['driver_hours_of_service'], refetchType: 'active' }),
        driverId
          ? qc.invalidateQueries({ queryKey: qk.driverHoursOfService(driverId), refetchType: 'active' })
          : Promise.resolve(),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: ['driver_hours_of_service'], type: 'active' }),
        driverId
          ? qc.refetchQueries({ queryKey: qk.driverHoursOfService(driverId), type: 'active' })
          : Promise.resolve(),
      ]);
    },
  });
}

export function useDriverHoursOfService(driverId: string | undefined) {
  return useQuery({
    queryKey: qk.driverHoursOfService(driverId),
    queryFn: () => api.read_driver_hours_of_service_v1(driverId!),
    enabled: !!driverId,
  });
}

// ---------- SUPPORT/cases ----------
const SUPPORT_CASE_READBACK_RESOURCES = [
  'support_cases',
  'support_case_directory',
  'support_messages',
  'support_message_directory',
  'support_case_events',
  'customer_shipment_changes',
  'tasks',
];

async function refreshSupportCaseReadModels(qc: QueryClient) {
  await refreshListQueries(qc, SUPPORT_CASE_READBACK_RESOURCES);
}

export function useCreateSupportCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.create_support_case_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}
export function useUpdateSupportCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.update_support_case_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}
export function useAssignSupportCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.assign_support_case_v1(args),
    onSuccess: () => {
      void refreshSupportCaseReadModels(qc);
    },
  });
}
export function useEscalateSupportCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.escalate_support_case_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}
export function useBulkAssignSupportCases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.bulk_assign_support_cases_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}
export function useResolveSupportCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.resolve_support_case_v1(args),
    onSuccess: () => {
      void refreshSupportCaseReadModels(qc);
    },
  });
}
export function useBulkResolveSupportCases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.bulk_resolve_support_cases_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}
export function useReopenSupportCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.reopen_support_case_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}
export function useSendSupportMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.send_support_message_v1(args),
    onSuccess: () => {
      void refreshSupportCaseReadModels(qc);
    },
  });
}
export function useAddSupportTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.add_support_tag_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}
export function usePublicTrackingReviewRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.public_tracking_review_request_v1(args),
    onSuccess: () => refreshSupportCaseReadModels(qc),
  });
}

// ============================================================================
// PHASE B5/C4 — FINANCE mutation hooks (canonical wiring shape)
// ============================================================================
//
// Each hook follows the canonical pattern (see plan "Mandatory mutation-wiring
// shape"):
//   1. Wrap the api facade entry via `useMutation`
//   2. Invalidate the relevant `qk.list(<resource>)` on success
//   3. Caller code is responsible for `pushToast`-style UX feedback (so the
//      hook stays platform-agnostic and unit-tests don't have to mock toast).
//
// All RPCs accept a single jsonb envelope (`p_args`) and return
// `{ ok, <resource>_id, correlation_id, settings_resolution_id, ... }`.

// ---------- FINANCE/billing invoices ----------
const BILLING_READBACK_RESOURCES = [
  'billing_invoices',
  'billing_invoice_directory',
  'billing_invoice_lines',
  'billing_invoice_events',
];

const BILLING_SUBSCRIPTION_READBACK_RESOURCES = [
  'subscriptions',
  'subscription_events',
];

async function refreshBillingInvoiceReadModels(qc: QueryClient, invoiceId?: string | null) {
  await Promise.all([
    refreshListQueries(qc, BILLING_READBACK_RESOURCES),
    refreshCompleteListQueries(qc, BILLING_READBACK_RESOURCES),
  ]);
  if (!invoiceId) return;
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.resource('billing_invoices', invoiceId), refetchType: 'active' }),
    qc.refetchQueries({ queryKey: qk.resource('billing_invoices', invoiceId), type: 'active' }),
  ]);
}

async function refreshBillingSubscriptionReadModels(qc: QueryClient) {
  await Promise.all([
    refreshListQueries(qc, BILLING_SUBSCRIPTION_READBACK_RESOURCES),
    refreshCompleteListQueries(qc, BILLING_SUBSCRIPTION_READBACK_RESOURCES),
  ]);
}

export function useCreateBillingInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.CreateBillingInvoiceArgs) => api.create_billing_invoice_v1(args),
    onSuccess: (data) => refreshBillingInvoiceReadModels(qc, data.billing_invoice_id),
  });
}
export function useUpdateBillingInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UpdateBillingInvoiceArgs) => api.update_billing_invoice_v1(args),
    onSuccess: (_d, vars) => refreshBillingInvoiceReadModels(qc, vars.billing_invoice_id),
  });
}
export function useVoidBillingInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.VoidBillingInvoiceArgs) => api.void_billing_invoice_v1(args),
    onSuccess: (_d, vars) => refreshBillingInvoiceReadModels(qc, vars.billing_invoice_id),
  });
}
export function useSendBillingInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BillingInvoiceSendArgs) => api.billing_invoice_send_v1(args),
    onSuccess: (_data, vars) => refreshBillingInvoiceReadModels(qc, vars.billing_invoice_id),
  });
}
export function useBulkSendBillingInvoices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BulkBillingInvoiceSendArgs) =>
      api.ui_bulk_billing_invoice_send_v1(args),
    onSuccess: () => refreshBillingInvoiceReadModels(qc),
  });
}
export function useRefundBillingInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BillingInvoiceRefundArgs) => api.billing_invoice_refund_v1(args),
    onSuccess: (_data, vars) => refreshBillingInvoiceReadModels(qc, vars.billing_invoice_id),
  });
}
export function useMarkBillingInvoicePaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BillingInvoiceMarkPaidArgs) => api.billing_invoice_mark_paid_v1(args),
    onSuccess: (_data, vars) => refreshBillingInvoiceReadModels(qc, vars.billing_invoice_id),
  });
}
export function useCancelSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.CancelSubscriptionArgs) => api.cancel_subscription_v1(args),
    onSuccess: () => refreshBillingSubscriptionReadModels(qc),
  });
}

// ---------- FINANCE/bank account balance projection (W11-1 / W8-4) ----------
//
// Wraps the canonical projection RPC `compute_bank_account_balance_v1`
// (supabase/migrations/202604301110_compute_bank_account_balance_v1.sql)
// so the bank-recon module no longer reads the three derived totals
// (`balance`, `last_match_at`, `open_items`) from the FE row interface.
// These fields are NOT columns on `public.bank_accounts`; the canonical
// projection derives them from `finance_events` + `bank_recon_matches`.
//
// Modules MUST consume this through `useBankAccountBalance(account_id)`;
// the FE `BankAccountRow` no longer carries derived columns. The hook is
// disabled when `account_id` is empty/undefined to prevent unkeyed fetches.
export function useBankAccountBalance(
  bankAccountId: string | undefined,
  opts?: { enabled?: boolean },
) {
  return useQuery<api.BankAccountBalanceResolution>({
    queryKey: qk.bankAccountBalance(bankAccountId ?? ''),
    queryFn: () =>
      api.compute_bank_account_balance_v1({ bank_account_id: bankAccountId! }),
    enabled: opts?.enabled !== false && Boolean(bankAccountId),
  });
}

// ---------- FINANCE/settlements ----------
const SETTLEMENT_READBACK_RESOURCES = [
  'settlement_batches',
  'settlement_batch_summary',
];

async function refreshSettlementReadModels(qc: QueryClient, settlementBatchId?: string | null) {
  await Promise.all([
    refreshListQueries(qc, SETTLEMENT_READBACK_RESOURCES),
    refreshCompleteListQueries(qc, SETTLEMENT_READBACK_RESOURCES),
  ]);
  if (!settlementBatchId) return;
  await Promise.all([
    qc.invalidateQueries({
      queryKey: qk.resource('settlement_batches', settlementBatchId),
      refetchType: 'active',
    }),
    qc.refetchQueries({
      queryKey: qk.resource('settlement_batches', settlementBatchId),
      type: 'active',
    }),
  ]);
}

export function useCreateSettlementBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.CreateSettlementBatchArgs) =>
      api.ui_create_settlement_batch_v1(args),
    onSuccess: (data) => refreshSettlementReadModels(qc, data.settlement_batch_id),
  });
}
export function useTransitionSettlementBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.TransitionSettlementBatchArgs) =>
      api.ui_transition_settlement_batch_v1(args),
    onSuccess: (_d, vars) => refreshSettlementReadModels(qc, vars.settlement_batch_id),
  });
}
export function useRecordCodRemittance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.CodRemittanceArgs) => api.ui_record_cod_remittance_v1(args),
    onSuccess: async () => {
      await Promise.all([
        refreshListQueries(qc, ['cod_entries', 'finance_events_ledger', 'settlement_batch_summary']),
        refreshCompleteListQueries(qc, ['cod_entries', 'finance_events_ledger', 'settlement_batch_summary']),
      ]);
      await qc.invalidateQueries({ queryKey: ['cod_summary'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['cod_summary'], type: 'active' });
    },
  });
}
export function useAdjustCodCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.CodCollectionAdjustmentArgs) =>
      api.ui_adjust_cod_collection_v1(args),
    onSuccess: async () => {
      await Promise.all([
        refreshListQueries(qc, ['cod_entries', 'finance_events_ledger', 'settlement_batch_summary']),
        refreshCompleteListQueries(qc, ['cod_entries', 'finance_events_ledger', 'settlement_batch_summary']),
      ]);
      await qc.invalidateQueries({ queryKey: ['cod_summary'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['cod_summary'], type: 'active' });
    },
  });
}
export function useReverseFinanceEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.FinanceEventReverseArgs) =>
      api.ui_reverse_finance_event_v1(args),
    onSuccess: async () => {
      await Promise.all([
        refreshListQueries(qc, ['finance_events_ledger']),
        refreshCompleteListQueries(qc, ['finance_events_ledger', 'settlement_batch_summary']),
      ]);
    },
  });
}
export function useApplySettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ApplySettlementArgs) => api.apply_settlement_v1(args),
    onSuccess: (_data, vars) => refreshSettlementReadModels(qc, vars.settlement_batch_id),
  });
}
export function useRejectSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RejectSettlementArgs) => api.reject_settlement_v1(args),
    onSuccess: (_data, vars) => refreshSettlementReadModels(qc, vars.settlement_batch_id),
  });
}
// ---------- FINANCE/bank reconciliation ----------
const BANK_RECON_READBACK_RESOURCES = [
  'bank_accounts',
  'finance_events_bank_statement',
  'finance_events_ledger',
  'bank_recon_matches',
  'settlement_batch_summary',
];

async function refreshBankReconReadModels(qc: QueryClient, bankAccountId?: string | null) {
  await refreshListQueries(qc, BANK_RECON_READBACK_RESOURCES);
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['bank_account_balance'], refetchType: 'active' }),
    bankAccountId
      ? qc.invalidateQueries({ queryKey: qk.bankAccountBalance(bankAccountId), refetchType: 'active' })
      : Promise.resolve(),
  ]);
  await Promise.all([
    qc.refetchQueries({ queryKey: ['bank_account_balance'], type: 'active' }),
    bankAccountId
      ? qc.refetchQueries({ queryKey: qk.bankAccountBalance(bankAccountId), type: 'active' })
      : Promise.resolve(),
  ]);
}

export function useBankReconMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BankReconMatchArgs) => api.bank_recon_match_v1(args),
    onSuccess: () => refreshBankReconReadModels(qc),
  });
}
export function useBankReconUnmatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BankReconUnmatchArgs) => api.bank_recon_unmatch_v1(args),
    onSuccess: () => refreshBankReconReadModels(qc),
  });
}
export function useRecordBankStatementEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BankStatementIngestArgs) =>
      api.ui_record_bank_statement_event_v1(args),
    onSuccess: (_res, vars) => refreshBankReconReadModels(qc, vars.bank_account_id),
  });
}
export function useCreateBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BankAccountCreateArgs) =>
      api.ui_create_bank_account_v1(args),
    onSuccess: (res) => refreshBankReconReadModels(qc, res.bank_account_id),
  });
}

// ---------- FINANCE/disputes (FINANCE namespace) ----------
export function useResolveDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.DisputeResolveArgs) => api.dispute_resolve_v1(args),
    onSuccess: () => {
      void refreshDisputeReadModels(qc);
    },
  });
}
export function useRejectDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.DisputeRejectArgs) => api.dispute_reject_v1(args),
    onSuccess: () => {
      void refreshDisputeReadModels(qc);
    },
  });
}
export function useBulkDisputeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BulkDisputeActionArgs) => api.ui_bulk_dispute_action_v1(args),
    onSuccess: () => {
      void refreshDisputeReadModels(qc);
    },
  });
}
// W8-4 / W9-3 — non-terminal dispute lifecycle hooks (residual gap closure).
// Mirrors useResolveDispute/useRejectDispute so the FE seam stays uniform.
// Capability: disputes.write (assert_capability_v1 inside the canonical RPC).
export function useAcknowledgeDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.DisputeAcknowledgeArgs) => api.dispute_acknowledge_v1(args),
    onSuccess: () => {
      void refreshDisputeReadModels(qc);
    },
  });
}
export function useEscalateDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.DisputeEscalateArgs) => api.dispute_escalate_v1(args),
    onSuccess: () => {
      void refreshDisputeReadModels(qc);
    },
  });
}

function refreshDisputeReadModels(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['list', 'marketplace_disputes'], refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: ['list', 'dispute_directory'], refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: ['lists_by_filters', 'marketplace_disputes'], refetchType: 'active' }),
    qc.invalidateQueries({ queryKey: ['lists_by_filters', 'dispute_directory'], refetchType: 'active' }),
  ]);
}

// ============================================================================
// PHASE C3 — CUSTOMERS + CATALOG mutation hooks
// ============================================================================
//
// Each hook wraps a Phase B6 canonical RPC. Modules MUST consume these (not
// call api.* directly) so cache invalidation + toast plumbing + devtools stay
// uniform. The data-source seam branches once on `getSupabaseClient()` so the
// production swap is environment-only.

// CUSTOMERS — clients lifecycle (Suspend / Reactivate)
export function useSuspendClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ClientSuspendArgs) => api.client_suspend_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(qc, ['clients', 'client_summary'], 'clients', args.client_id),
  });
}
export function useReactivateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ClientReactivateArgs) => api.client_reactivate_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(qc, ['clients', 'client_summary'], 'clients', args.client_id),
  });
}

// CUSTOMERS — senders lifecycle (Suspend / Reactivate)
export function useSuspendSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.SenderSuspendArgs) => api.sender_suspend_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(qc, ['senders', 'sender_summary', 'client_summary'], 'senders', args.sender_id),
  });
}
export function useReactivateSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.SenderReactivateArgs) => api.sender_reactivate_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(qc, ['senders', 'sender_summary', 'client_summary'], 'senders', args.sender_id),
  });
}

// CUSTOMERS — clients create/update (Wave 6)
export function useClientCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ClientCreateArgs) => api.client_create_v1(args),
    onSuccess: (data) =>
      refreshListAndResourceQueries(
        qc,
        ['clients', 'client_summary', 'sender_summary', 'recipient_directory'],
        'clients',
        mutationResultId(data, 'client_id', 'id'),
      ),
  });
}
export function useClientUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ClientUpdateArgs) => api.client_update_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(qc, ['clients', 'client_summary'], 'clients', args.client_id),
  });
}

// CUSTOMERS — senders create/update (Wave 6)
export function useSenderCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.SenderCreateArgs) => api.sender_create_v1(args),
    onSuccess: (data) =>
      refreshListAndResourceQueries(
        qc,
        ['senders', 'sender_summary', 'client_summary'],
        'senders',
        mutationResultId(data, 'sender_id', 'id'),
      ),
  });
}
export function useSenderUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.SenderUpdateArgs) => api.sender_update_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(qc, ['senders', 'sender_summary', 'client_summary'], 'senders', args.sender_id),
  });
}

// CUSTOMERS — recipient operator lifecycle.
// NOTE: console-side operator NDR triage. Portal self-edit is a separate path.
export function useRecipientCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RecipientCreateArgs) => api.recipient_create_v1(args),
    onSuccess: (data) =>
      refreshListAndResourceQueries(
        qc,
        ['recipients', 'recipient_directory', 'client_summary'],
        'recipients',
        mutationResultId(data, 'recipient_id', 'id'),
      ),
  });
}
export function useRecipientUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RecipientUpdateArgs) => api.recipient_update_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(
        qc,
        ['recipients', 'recipient_directory', 'client_summary'],
        'recipients',
        args.recipient_id,
      ),
  });
}
export function useRecipientDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RecipientDeleteArgs) => api.recipient_delete_v1(args),
    onSuccess: (_data, args) =>
      refreshListAndResourceQueries(
        qc,
        ['recipients', 'recipient_directory', 'client_summary'],
        'recipients',
        args.recipient_id,
      ),
  });
}

// CATALOG — service offerings (Create / Update / Archive / Toggle)
export function useCreateServiceOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ServiceOfferingCreateArgs) => api.service_offering_create_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('service_offerings') });
      qc.invalidateQueries({ queryKey: qk.list('service_offering_directory') });
      qc.invalidateQueries({ queryKey: qk.list('service_level_directory') });
    },
  });
}
export function useUpdateServiceOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ServiceOfferingUpdateArgs) => api.service_offering_update_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('service_offerings') });
      qc.invalidateQueries({ queryKey: qk.list('service_offering_directory') });
      qc.invalidateQueries({ queryKey: qk.list('service_level_directory') });
    },
  });
}
export function useArchiveServiceOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ServiceOfferingArchiveArgs) => api.service_offering_archive_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('service_offerings') });
      qc.invalidateQueries({ queryKey: qk.list('service_offering_directory') });
      qc.invalidateQueries({ queryKey: qk.list('service_level_directory') });
    },
  });
}
export function useToggleServiceOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ServiceOfferingToggleArgs) => api.service_offering_toggle_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('service_offerings') });
      qc.invalidateQueries({ queryKey: qk.list('service_offering_directory') });
      qc.invalidateQueries({ queryKey: qk.list('service_level_directory') });
    },
  });
}

// CATALOG — service levels (Create / Update)
export function useCreateServiceLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ServiceLevelCreateArgs) => api.service_level_create_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('service_levels') });
      qc.invalidateQueries({ queryKey: qk.list('service_level_directory') });
      qc.invalidateQueries({ queryKey: qk.list('service_offering_directory') });
    },
  });
}
export function useUpdateServiceLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ServiceLevelUpdateArgs) => api.service_level_update_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('service_levels') });
      qc.invalidateQueries({ queryKey: qk.list('service_level_directory') });
      qc.invalidateQueries({ queryKey: qk.list('service_offering_directory') });
    },
  });
}

// CATALOG — lookup definitions (Create)
export function useCreateLookupDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.LookupDefinitionCreateArgs) => api.lookup_definition_create_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('lookup_definitions') }),
  });
}

// CATALOG — lookup values (Create / Update / Archive / Promote)
export function useCreateLookupValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.LookupValueCreateArgs) => api.lookup_value_create_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('lookup_values') }),
  });
}
export function useUpdateLookupValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.LookupValueUpdateArgs) => api.lookup_value_update_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('lookup_values') }),
  });
}
export function useArchiveLookupValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.LookupValueArchiveArgs) => api.lookup_value_archive_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('lookup_values') }),
  });
}
export function usePromoteLookupValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.LookupValuePromoteArgs) => api.lookup_value_promote_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('lookup_values') }),
  });
}

// ============================================================================
// PHASE C5 — INTEGRATIONS + WORKFLOWS mutation hooks
// ============================================================================
//
// Each hook wraps a Phase B6 canonical RPC. Modules MUST consume these (not
// call api.* directly) so cache invalidation + toast plumbing + devtools stay
// uniform. The data-source seam branches once on `getSupabaseClient()` so the
// production swap is environment-only.

// INTEGRATIONS — webhook_sources (Create / Update / Toggle / Rotate-token / Archive)
const WEBHOOK_SOURCE_READBACK_RESOURCES = ['webhook_sources', 'webhook_source_directory'];

function resolveWebhookSourceReadbackId(data: unknown, args?: Record<string, unknown>): string | null {
  const row = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const candidates = [
    row.webhook_source_id,
    row.source_id,
    row.id,
    args?.source_id,
    args?.webhook_source_id,
    args?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

async function refreshWebhookSourceReadModels(
  qc: QueryClient,
  sourceId?: string | null,
) {
  await Promise.all([
    refreshListQueries(qc, WEBHOOK_SOURCE_READBACK_RESOURCES),
    refreshCompleteListQueries(qc, WEBHOOK_SOURCE_READBACK_RESOURCES),
  ]);
  if (!sourceId) return;
  await Promise.all(
    WEBHOOK_SOURCE_READBACK_RESOURCES.flatMap((resource) => [
      qc.invalidateQueries({ queryKey: ['resources_by_ids', resource], refetchType: 'active' }),
      qc.invalidateQueries({ queryKey: qk.resource(resource, sourceId), refetchType: 'active' }),
    ]),
  );
  await Promise.all(
    WEBHOOK_SOURCE_READBACK_RESOURCES.flatMap((resource) => [
      qc.refetchQueries({ queryKey: ['resources_by_ids', resource], type: 'active' }),
      qc.refetchQueries({ queryKey: qk.resource(resource, sourceId), type: 'active' }),
    ]),
  );
}

export function useUpsertWebhookSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UpsertWebhookSourceArgs) => api.ui_upsert_webhook_source_v1(args),
    onSuccess: (data, args) =>
      refreshWebhookSourceReadModels(qc, resolveWebhookSourceReadbackId(data, args)),
  });
}
export function useArchiveWebhookSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ArchiveWebhookSourceArgs) => api.ui_archive_webhook_source_v1(args),
    onSuccess: (data, args) =>
      refreshWebhookSourceReadModels(qc, resolveWebhookSourceReadbackId(data, args)),
  });
}
export function useRotateWebhookSourceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { source_id: string }) => api.ui_rotate_webhook_source_token_v1(args),
    onSuccess: (data, args) =>
      refreshWebhookSourceReadModels(qc, resolveWebhookSourceReadbackId(data, args)),
  });
}

// INTEGRATIONS — Mapping Studio (Create / Edit / Promote-version)
const MAPPING_PROFILE_READBACK_RESOURCES = [
  'mapping_configs',
  'mapping_config_directory',
  'webhook_sources',
  'webhook_source_directory',
  'webhook_rules',
  'api_routes',
];

export function useUpsertMappingArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UpsertMappingArtifactArgs) => api.ui_upsert_mapping_artifact_v1(args),
    onSuccess: () => invalidateListQueries(qc, MAPPING_PROFILE_READBACK_RESOURCES),
  });
}
export function useDeleteMappingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { mapping_config_id: string }) => api.ui_delete_mapping_config_v1(args),
    onSuccess: () => {
      invalidateListQueries(qc, ['mapping_configs', 'mapping_config_directory']);
    },
  });
}
export function useUpsertApiGatewayRouteMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UpsertApiGatewayRouteMappingArgs) =>
      api.ui_upsert_api_gateway_route_mapping_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['api_routes', 'mapping_configs', 'mapping_config_directory']);
    },
  });
}
export function usePromoteMappingVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { mapping_config_id: string; target_version?: number }) =>
      api.mapping_config_promote_v1(args),
    onSuccess: () => invalidateListQueries(qc, MAPPING_PROFILE_READBACK_RESOURCES),
  });
}

// INTEGRATIONS — provider_auth_configs (Create / Update / Rotate / Revoke).
export function useUpsertProviderAuthConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UpsertProviderAuthConfigArgs) =>
      api.ui_upsert_provider_auth_config_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['provider_auth_configs', 'integration_credential_directory']);
    },
  });
}
export function useBindProviderAccountCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BindProviderAccountCredentialArgs) =>
      api.ui_bind_provider_account_credential_v1(args),
    onSuccess: async (_data, args) => {
      await refreshListQueries(qc, ['provider_auth_configs', 'integration_credential_directory']);
      const providerAccountCategory =
        typeof args.provider_account_category === 'string' && args.provider_account_category.trim()
          ? args.provider_account_category.trim()
          : 'logestechs_v2_account';
      qc.invalidateQueries({ queryKey: qk.resolveSettingsCategory(providerAccountCategory) });
      await qc.refetchQueries({ queryKey: qk.resolveSettingsCategory(providerAccountCategory), type: 'active' });
      await refreshListQueries(qc, ['api_gateway_requests', 'api_routes']);
    },
  });
}
export function useUnbindProviderAccountCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UnbindProviderAccountCredentialArgs) =>
      api.ui_unbind_provider_account_credential_v1(args),
    onSuccess: async (_data, args) => {
      await refreshListQueries(qc, ['provider_auth_configs', 'integration_credential_directory']);
      const providerAccountCategory =
        typeof args.provider_account_category === 'string' && args.provider_account_category.trim()
          ? args.provider_account_category.trim()
          : 'logestechs_v2_account';
      qc.invalidateQueries({ queryKey: qk.resolveSettingsCategory(providerAccountCategory) });
      await qc.refetchQueries({ queryKey: qk.resolveSettingsCategory(providerAccountCategory), type: 'active' });
      await refreshListQueries(qc, ['api_gateway_requests', 'api_routes']);
    },
  });
}
export function useRotateProviderCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) => api.integration_plugin_rotate_credentials_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['provider_auth_configs', 'integration_credential_directory']);
    },
  });
}
export function useRevokeProviderAuthConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { config_id: string; reason?: string | null }) =>
      api.ui_revoke_provider_auth_config_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['provider_auth_configs', 'integration_credential_directory']);
    },
  });
}

export function useResetProviderCircuit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ProviderCircuitResetArgs) =>
      api.ui_execute_provider_circuit_reset_v1(args),
    onSuccess: async () => {
      await Promise.all([
        refreshListQueries(qc, ['provider_health_latest', 'circuit_breaker_dashboard']),
        refreshCompleteListQueries(qc, ['provider_health_latest', 'circuit_breaker_dashboard']),
      ]);
    },
  });
}

export function useProbeProviderCircuit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ProviderCircuitProbeArgs) =>
      api.ui_execute_provider_circuit_probe_v1(args),
    onSuccess: async () => {
      await Promise.all([
        refreshListQueries(qc, ['provider_health_latest', 'circuit_breaker_dashboard']),
        refreshCompleteListQueries(qc, ['provider_health_latest', 'circuit_breaker_dashboard']),
      ]);
    },
  });
}

// INTEGRATIONS — integration_plugins catalog (Install / Rollback)
const INTEGRATION_PLUGIN_READBACK_RESOURCES = [
  'integration_plugins',
  'integration_plugin_versions',
  'integration_plugin_directory',
  'integration_plugin_approval_events',
  'integration_plugin_bindings',
] as const;

async function refreshIntegrationPluginReadModels(qc: QueryClient) {
  await Promise.all([
    refreshListQueries(qc, Array.from(INTEGRATION_PLUGIN_READBACK_RESOURCES)),
    refreshCompleteListQueries(qc, Array.from(INTEGRATION_PLUGIN_READBACK_RESOURCES)),
  ]);
}

export function useInstallIntegrationPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.IntegrationPluginGenerateDraftArgs) =>
      api.integration_plugin_generate_draft_v1(args),
    onSuccess: () => refreshIntegrationPluginReadModels(qc),
  });
}
export function useUninstallIntegrationPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      plugin_id: string;
      target_plugin_version_id?: string | null;
      reason?: string | null;
    }) =>
      api.integration_plugin_rollback_v1(args),
    onSuccess: () => refreshIntegrationPluginReadModels(qc),
  });
}
export function useDeactivateIntegrationPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.PluginDeactivateArgs) => api.plugin_deactivate_v1(args),
    onSuccess: () => refreshIntegrationPluginReadModels(qc),
  });
}

// INTEGRATIONS — plugin lifecycle Submit/Approve/Activate/Set-binding (W9-2)
//
// Wave 9 W9-2 (CLAIM-INTEGRATIONS REVISION 36% — W7 audit P0 #4): hooks for
// the 4 missing catalog drawer lifecycle transitions. Each hook calls into
// the canonical jsonb-arg shim RPC (202604301210) and invalidates
// integration_plugins + integration_plugin_versions list caches so the
// drawer refreshes after the transition lands.
export function useSubmitIntegrationPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.PluginSubmitArgs) => api.plugin_submit_v1(args),
    onSuccess: () => refreshIntegrationPluginReadModels(qc),
  });
}
export function useApproveIntegrationPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.PluginApproveArgs) => api.plugin_approve_v1(args),
    onSuccess: () => refreshIntegrationPluginReadModels(qc),
  });
}
export function useActivateIntegrationPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.PluginActivateArgs) => api.plugin_activate_v1(args),
    onSuccess: () => refreshIntegrationPluginReadModels(qc),
  });
}
export function useSetIntegrationPluginBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.PluginSetBindingArgs) => api.plugin_set_binding_v1(args),
    onSuccess: () => refreshIntegrationPluginReadModels(qc),
  });
}

// INTEGRATIONS — webhook_inbox replay + force-status
export function useReplayWebhookInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.WebhookInboxReplayArgs) => api.webhook_inbox_replay_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['webhook_inbox', 'webhook_inbox_directory']);
      await refreshCompleteListQueries(qc, ['webhook_inbox', 'webhook_inbox_directory']);
    },
  });
}
export function useRetryWebhookInboxAsNewIntake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.WebhookInboxRetryAsNewIntakeArgs) =>
      api.ui_retry_webhook_inbox_as_new_intake_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['webhook_inbox', 'webhook_inbox_directory']);
      await refreshCompleteListQueries(qc, ['webhook_inbox', 'webhook_inbox_directory']);
    },
  });
}
export function useForceWebhookInboxStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.WebhookInboxForceStatusArgs) => api.webhook_inbox_force_status_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['webhook_inbox', 'webhook_inbox_directory']);
      await refreshCompleteListQueries(qc, ['webhook_inbox', 'webhook_inbox_directory']);
    },
  });
}

// WORKFLOWS — templates lifecycle (Create / Activate / Deactivate)
const WORKFLOW_TEMPLATE_READBACK_RESOURCES = [
  'workflow_templates',
  'workflow_template_steps',
  'workflow_template_directory',
  'workflow_bindings',
  'workflow_binding_directory',
  'workflow_runs',
  'workflow_run_directory',
] as const;

const WORKFLOW_BINDING_READBACK_RESOURCES = [
  'workflow_bindings',
  'workflow_binding_directory',
  'workflow_binding_dispatches',
  'workflow_templates',
  'workflow_template_directory',
  'workflow_runs',
  'workflow_run_directory',
] as const;

async function refreshWorkflowTemplateReadModels(qc: QueryClient) {
  await Promise.all([
    refreshListQueries(qc, [...WORKFLOW_TEMPLATE_READBACK_RESOURCES]),
    refreshCompleteListQueries(qc, [...WORKFLOW_TEMPLATE_READBACK_RESOURCES]),
  ]);
}

async function refreshWorkflowBindingReadModels(qc: QueryClient) {
  await Promise.all([
    refreshListQueries(qc, [...WORKFLOW_BINDING_READBACK_RESOURCES]),
    refreshCompleteListQueries(qc, [...WORKFLOW_BINDING_READBACK_RESOURCES]),
  ]);
}

export function useCreateWorkflowTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.CreateWorkflowTemplateArgs) => api.ui_create_workflow_template_v1(args),
    onSuccess: () => refreshWorkflowTemplateReadModels(qc),
  });
}
export function useSetWorkflowTemplateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.SetWorkflowTemplateStatusArgs) => api.ui_set_workflow_template_status_v1(args),
    onSuccess: () => refreshWorkflowTemplateReadModels(qc),
  });
}

export function useRestoreWorkflowTemplateVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RestoreWorkflowTemplateArgs) => api.restore_workflow_template_v1(args),
    onSuccess: () => refreshWorkflowTemplateReadModels(qc),
  });
}

function invalidateWorkflowTemplateStepLifecycle(qc: QueryClient) {
  return refreshWorkflowTemplateReadModels(qc);
}

export function useCreateWorkflowTemplateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.CreateWorkflowTemplateStepArgs) =>
      api.ui_create_workflow_template_step_v1(args),
    onSuccess: () => invalidateWorkflowTemplateStepLifecycle(qc),
  });
}
export function useUpdateWorkflowTemplateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UpdateWorkflowTemplateStepArgs) =>
      api.ui_update_workflow_template_step_v1(args),
    onSuccess: () => invalidateWorkflowTemplateStepLifecycle(qc),
  });
}
export function useDuplicateWorkflowTemplateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.DuplicateWorkflowTemplateStepArgs) =>
      api.ui_duplicate_workflow_template_step_v1(args),
    onSuccess: () => invalidateWorkflowTemplateStepLifecycle(qc),
  });
}
export function useDeleteWorkflowTemplateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.DeleteWorkflowTemplateStepArgs) =>
      api.ui_delete_workflow_template_step_v1(args),
    onSuccess: () => invalidateWorkflowTemplateStepLifecycle(qc),
  });
}

// WORKFLOWS — runs lifecycle (Cancel + Replay).
// Replay starts a new backend run from the same template, preserving the
// original run lineage in payload.ui.replay_of for no-reload table readback.
// Cancel rides through `close_workflow_run('cancelled')`.
export function useReplayWorkflowRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { run_id: string; template_id: string; payload?: Record<string, unknown> }) =>
      api.start_workflow_run(args.template_id, {
        ...(args.payload ?? {}),
        ui: {
          ...((args.payload?.ui as Record<string, unknown> | undefined) ?? {}),
          replay_of: args.run_id,
        },
      } as api.WorkflowRunStartContext),
    onSuccess: async (res, vars) => {
      qc.invalidateQueries({ queryKey: qk.list('workflow_runs') });
      qc.invalidateQueries({ queryKey: qk.list('workflow_run_directory') });
      if (res.workflow_run_id) {
        qc.invalidateQueries({ queryKey: ['workflow_run_steps', res.workflow_run_id] });
      }
      await qc.refetchQueries({ queryKey: qk.list('workflow_run_directory'), type: 'active' });
      if (res.workflow_run_id) {
        await qc.refetchQueries({ queryKey: ['workflow_run_steps', res.workflow_run_id], type: 'active' });
      }
    },
  });
}
export function useCancelWorkflowRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { run_id: string }) => api.close_workflow_run(args.run_id, 'cancelled'),
    onSuccess: async (_res, vars) => {
      qc.invalidateQueries({ queryKey: qk.list('workflow_runs') });
      qc.invalidateQueries({ queryKey: qk.list('workflow_run_directory') });
      qc.invalidateQueries({ queryKey: qk.list('workflow_run_steps') });
      await qc.refetchQueries({ queryKey: qk.list('workflow_run_directory'), type: 'active' });
      await qc.refetchQueries({ queryKey: ['workflow_run_steps', vars.run_id], type: 'active' });
    },
  });
}

// WORKFLOWS — bindings lifecycle
export function useRegisterWorkflowBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RegisterWorkflowBindingArgs) => api.register_workflow_binding_v1(args),
    onSuccess: () => refreshWorkflowBindingReadModels(qc),
  });
}
export function useSimulateBindingDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.SimulateBindingDispatchArgs) => api.simulate_binding_dispatch_v1(args),
    onSuccess: () => refreshWorkflowBindingReadModels(qc),
  });
}

// WORKFLOWS — review-queue bulk transition
export function useBulkTransitionTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BulkTransitionTasksArgs) => api.bulk_transition_tasks_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks() }),
  });
}

// ============================================================================
// PHASE C2: NETWORK mutation hooks
// ============================================================================
//
// Each hook wraps a Phase B canonical RPC (or pending stub) and:
//   1. Calls the typed api facade
//   2. Invalidates the relevant qk.list(<resource>) on success
//   3. Caller code is responsible for `pushToast`-style UX feedback (so the
//      hook stays platform-agnostic and unit tests don't have to mock toast).
//
// Audit reference: apps/console-v2/__audit__/CROSSWALK/NETWORK.md.

// ---------- NETWORK/zones ----------
export function useSuspendZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.SuspendZoneArgs) => api.suspend_zone_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('zones') }),
  });
}
export function useRestoreZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RestoreZoneArgs) => api.restore_zone_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('zones') }),
  });
}
export function useUpdateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ZoneUpdateArgs) => api.zone_update_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('zones') });
      qc.invalidateQueries({ queryKey: qk.list('zone_summary') });
    },
  });
}
export function useDeleteZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ZoneDeleteArgs) => api.zone_delete_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('zones') });
      qc.invalidateQueries({ queryKey: qk.list('zone_summary') });
    },
  });
}
export function useCreateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ZoneCreateArgs) => api.zone_create_v1(args),
    onSuccess: () => invalidateListQueries(qc, ['zones', 'zone_summary', 'zone_districts']),
  });
}
export function useRequestZoneOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RequestZoneOverrideArgs) => api.request_zone_override_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('zone_override_requests') }),
  });
}
export function useExecuteZoneOverrideRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.UiExecuteZoneOverrideRequestArgs) =>
      api.ui_execute_zone_override_request_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('zone_override_requests') }),
  });
}
export function useAddZoneDistrict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ZoneDistrictAddArgs) => api.zone_district_add_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('zone_districts') }),
  });
}
export function useRemoveZoneDistrict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.ZoneDistrictRemoveArgs) => api.zone_district_remove_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('zone_districts') }),
  });
}

// ---------- NETWORK/marketplace ----------
export function useSubmitMarketplaceOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceOfferSubmitArgs) => api.marketplace_offer_submit_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_offers') }),
  });
}
export function useWithdrawMarketplaceOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceOfferWithdrawArgs) => api.marketplace_offer_withdraw_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_offers') }),
  });
}
export function useAwardMarketplaceOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceAwardOfferArgs) => api.marketplace_award_offer_v1(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.list('marketplace_offers') });
      qc.invalidateQueries({ queryKey: qk.list('marketplace_awards') });
    },
  });
}
export function useRespondMarketplaceAward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceAwardRespondArgs) => api.marketplace_award_respond_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_awards') }),
  });
}
export function useCreateMarketplaceRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceRequestCreateArgs) =>
      api.marketplace_request_create_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_requests') }),
  });
}
export function usePublishMarketplaceRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceRequestPublishArgs) =>
      api.marketplace_request_publish_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_requests') }),
  });
}
export function useCancelMarketplaceRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceRequestCancelArgs) =>
      api.marketplace_request_cancel_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_requests') }),
  });
}
export function useOpenMarketplaceDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceDisputeOpenArgs) => api.marketplace_dispute_open_v1(args),
    onSuccess: async () => {
      await Promise.all([
        refreshListQueries(qc, ['marketplace_disputes', 'dispute_directory']),
        refreshCompleteListQueries(qc, ['marketplace_disputes', 'dispute_directory']),
      ]);
    },
  });
}
export function useResolveMarketplaceDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceDisputeResolveArgs) =>
      api.marketplace_dispute_resolve_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_disputes') }),
  });
}
export function useMaterializeMarketplaceWorkPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceWorkPackageMaterializeArgs) =>
      api.marketplace_work_package_materialize_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('marketplace_awards') }),
  });
}
export function useReviewMarketplaceParticipantRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceParticipantRequestReviewApplyArgs) =>
      api.marketplace_participant_request_review_apply_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, [
        'marketplace_participant_requests',
        'driver_application_directory',
        'marketplace_participants',
      ]).catch((err) => {
        console.warn('marketplace participant review list refresh failed', err);
      });
    },
  });
}
export function useRefreshMarketplaceReputation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.MarketplaceRefreshReputationSnapshotArgs) =>
      api.marketplace_refresh_reputation_snapshot_v1(args),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.list('marketplace_reputation_snapshots') }),
  });
}

// ---------- NETWORK/branches ----------
// Canonical RPCs SHIPPED in W8-1 + W9-1: branch_create_v1, branch_update_v1,
// mark_branch_oos_v1, branch_zone_assign/unassign_v1, add_branch_member_v1,
// remove_branch_member_v1, branch_capacity_window_set_v1,
// branch_coverage_window_upsert_v1. Each enforces branches.write capability +
// emits decision_log + domain_events. Hooks call typed api facades.
export function useCreateBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BranchCreateArgs) => api.branch_create_v1(args),
    onSuccess: () => invalidateListQueries(qc, ['branches', 'branch_summary']),
  });
}
export function useUpdateBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BranchUpdateArgs) => api.branch_update_v1(args),
    onSuccess: () => invalidateListQueries(qc, ['branches', 'branch_summary']),
  });
}
export function useMarkBranchOos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BranchMarkOosArgs) => api.branch_mark_oos_v1(args),
    onSuccess: () => invalidateListQueries(qc, ['branches', 'branch_summary']),
  });
}
export function useAssignBranchZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BranchZoneAssignArgs) => api.branch_zone_assign_v1(args),
    onSuccess: () => {
      // W18-1 — `branch_zone_links` alias was unified into canonical `branch_zones`
      // (closes __audit__/DECISIONS/REGISTRY-ALIASES.md §2). Branches/Zones
      // consume this relation through filtered list queries, so invalidate the
      // full resource family rather than only the unfiltered list key.
      invalidateListQueries(qc, ['branch_zones', 'branches', 'branch_summary', 'zones', 'zone_summary']);
    },
  });
}
export function useUnassignBranchZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BranchZoneUnassignArgs) => api.branch_zone_unassign_v1(args),
    onSuccess: () => {
      // W18-1 — `branch_zone_links` alias was unified into canonical `branch_zones`
      // (closes __audit__/DECISIONS/REGISTRY-ALIASES.md §2). Branches/Zones
      // consume this relation through filtered list queries, so invalidate the
      // full resource family rather than only the unfiltered list key.
      invalidateListQueries(qc, ['branch_zones', 'branches', 'branch_summary', 'zones', 'zone_summary']);
    },
  });
}
export function useAddBranchMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.AddBranchMemberArgs) => api.add_branch_member_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('branch_memberships') }),
  });
}
export function useRemoveBranchMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.RemoveBranchMemberArgs) => api.remove_branch_member_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('branch_memberships') }),
  });
}
export function useSetBranchCapacityWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BranchCapacityWindowSetArgs) =>
      api.branch_capacity_window_set_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('branch_capacity_windows') }),
  });
}
export function useUpsertBranchCoverageWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.BranchCoverageWindowUpsertArgs) =>
      api.branch_coverage_window_upsert_v1(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.list('branch_coverage_windows') }),
  });
}

// ---------- IDENTITY/users (Phase D4 — CLAIM-PLATFORM-USERS) ----------
//
// Mutation hooks for the operator users admin module. The hooks invalidate
// both the `users` list (so role / status changes show on the next render)
// and `user_sessions` (so a Suspend or Revoke-session removes the user's
// active sessions from the Sessions tab).
//
// Architectural seams (mirrored in api.ts + data-source.ts):
//   - revoke_session_v1            -> canonical Phase B6 RPC
//                                     (supabase/migrations/202604280212).
//   - grant_user_role_v1 | revoke_user_role_v1 | suspend_user_v1 |
//     reactivate_user_v1            -> canonical Phase C6 *_v1 RPCs (W37
//                                     closure) per
//                                     supabase/migrations/202604300300..202604300330.
//                                     Each RPC asserts capability `users.manage`
//                                     server-side and follows the same INTENT-
//                                     ledger pattern as revoke_session_v1.
//   - force_password_reset_v1      -> canonical *_v1 RPC writes an INTENT row
//                                     to revocation_audit (kind='password_reset')
//                                     per supabase/migrations/202604300340; the
//                                     out-of-band edge worker invokes
//                                     auth.admin.resetPasswordForEmail() /
//                                     auth.admin.generateLink(). Gated by
//                                     `users.manage` for FE parity.

/**
 * Revoke an auth session (or all sessions for a user).
 *
 * Backed by the canonical Phase B6 RPC `public.revoke_session_v1` per
 * supabase/migrations/202604280212_revoke_session_v1.sql:21. The RPC writes a
 * revocation INTENT row to `public.revocation_audit` (status='pending') and
 * emits `domain_events.session.revocation_requested`; the actual
 * `auth.sessions` termination is performed by an out-of-band edge worker
 * via Supabase Admin API `auth.admin.signOut(user_id)`.
 *
 * Capability: `users.manage`. Cross-tenant targets are rejected at the RPC
 * unless the caller is a platform user.
 */
export function useRevokeSession() {
  const qc = useQueryClient();
  const refreshAfterSessionRevoke = async () => {
    await refreshListQueries(qc, ['users', 'user_directory']);
    await refreshCompleteListQueries(qc, ['users', 'user_directory']);
    await qc.invalidateQueries({ queryKey: ['user_sessions'], refetchType: 'active' });
    await qc.refetchQueries({ queryKey: ['user_sessions'], type: 'active' });
    await qc.invalidateQueries({ queryKey: ['user_security_actions'], refetchType: 'active' });
    await qc.refetchQueries({ queryKey: ['user_security_actions'], type: 'active' });
  };
  return useMutation({
    mutationFn: (args: api.RevokeSessionArgs) => api.revoke_session_v1(args),
    onSettled: refreshAfterSessionRevoke,
  });
}

interface UsersCommandArgs extends Record<string, unknown> {
  /** Required. UUID of the target user the lifecycle command applies to. */
  target_user_id: string;
}

interface UsersGrantRoleArgs extends UsersCommandArgs {
  /** Canonical role key (super_admin / ops_admin / account_manager / ...). */
  role_key: string;
  /** Optional free-text rationale (audited in decision_log when shipped). */
  reason?: string;
}

interface UsersRevokeRoleArgs extends UsersCommandArgs {
  role_key: string;
  reason?: string;
}

interface UsersSuspendArgs extends UsersCommandArgs {
  reason?: string;
}

interface UsersReactivateArgs extends UsersCommandArgs {
  reason?: string;
}

interface UsersForcePasswordResetArgs extends UsersCommandArgs {
  /** Optional override email (defaults to the user's primary email). */
  email?: string;
  /** Required operator-entered reason persisted to password reset intent and decision log. */
  reason: string;
}

function reconcileCachedUserLifecycleStatus(
  qc: QueryClient,
  args: UsersCommandArgs,
  result: Record<string, unknown> | undefined,
  fallbackStatus: string,
) {
  const status = typeof result?.status === 'string' && result.status ? result.status : fallbackStatus;
  const targetUserId = args.target_user_id;
  const reconcileRows = <T extends Record<string, unknown>>(current: ListResult<T> | undefined) => {
    if (!current?.rows) return current;
    let changed = false;
    const rows = current.rows.map((row) => {
      if (String(row.id ?? '') !== targetUserId) return row;
      changed = true;
      return { ...row, status } as T;
    });
    return changed ? { ...current, rows } : current;
  };

  for (const resource of ['users', 'user_directory']) {
    qc.setQueriesData<ListResult<Record<string, unknown>>>(
      { queryKey: ['list', resource] },
      reconcileRows,
    );
    qc.setQueriesData<ListResult<Record<string, unknown>>>(
      { queryKey: ['lists_by_filters', resource] },
      reconcileRows,
    );
  }
}

/**
 * Grant a role to a user. W37 closure: routes through canonical
 * `grant_user_role_v1` RPC per
 * supabase/migrations/202604300300_grant_user_role_v1.sql. Closes REAUDIT4
 * IDENTITY P1 (substrate-vs-shipped-RPC drift).
 */
export function useGrantUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UsersGrantRoleArgs) => api.grant_user_role_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['users', 'user_directory', 'rbac_user_role_assignments']);
      await refreshCompleteListQueries(qc, ['users', 'user_directory']);
      await qc.invalidateQueries({ queryKey: ['user_security_actions'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['user_security_actions'], type: 'active' });
    },
  });
}

/**
 * Revoke a role from a user. W37 closure: routes through canonical
 * `revoke_user_role_v1` RPC per
 * supabase/migrations/202604300310_revoke_user_role_v1.sql.
 */
export function useRevokeUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UsersRevokeRoleArgs) => api.revoke_user_role_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['users', 'user_directory', 'rbac_user_role_assignments']);
      await refreshCompleteListQueries(qc, ['users', 'user_directory']);
      await qc.invalidateQueries({ queryKey: ['user_security_actions'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['user_security_actions'], type: 'active' });
    },
  });
}

/**
 * Suspend a user. W37 closure: routes through canonical `suspend_user_v1` RPC
 * per supabase/migrations/202604300320_suspend_user_v1.sql. The RPC sets
 * `public.users.status = 'suspended'`; AppGuard then short-circuits at the FE
 * shell (W35e-3) on the next read.
 */
export function useSuspendUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UsersSuspendArgs) => api.suspend_user_v1(args),
    onSuccess: async (result, args) => {
      reconcileCachedUserLifecycleStatus(qc, args, result, 'suspended');
      await refreshListQueries(qc, ['users', 'user_directory', 'user_sessions', 'rbac_user_role_assignments']);
      await refreshCompleteListQueries(qc, ['users', 'user_directory']);
      await qc.invalidateQueries({ queryKey: ['user_sessions'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['user_sessions'], type: 'active' });
      await qc.invalidateQueries({ queryKey: ['user_security_actions'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['user_security_actions'], type: 'active' });
    },
  });
}

/**
 * Reactivate a suspended user. W37 closure: routes through canonical
 * `reactivate_user_v1` RPC per
 * supabase/migrations/202604300330_reactivate_user_v1.sql.
 */
export function useReactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UsersReactivateArgs) => api.reactivate_user_v1(args),
    onSuccess: async (result, args) => {
      reconcileCachedUserLifecycleStatus(qc, args, result, 'active');
      await refreshListQueries(qc, ['users', 'user_directory']);
      await refreshCompleteListQueries(qc, ['users', 'user_directory']);
      await qc.invalidateQueries({ queryKey: ['user_security_actions'], refetchType: 'active' });
      await qc.refetchQueries({ queryKey: ['user_security_actions'], type: 'active' });
    },
  });
}

/**
 * Force a password reset for a user. W37 closure: routes through canonical
 * `force_password_reset_v1` RPC per
 * supabase/migrations/202604300340_force_password_reset_v1.sql. The canonical
 * path is out-of-band: the RPC writes an INTENT row, then a Supabase edge
 * worker invokes `auth.admin.resetPasswordForEmail()` /
 * `auth.admin.generateLink()`. Capability stays `users.manage` so the
 * operator surface enforces the same posture as `revoke_session_v1`.
 *
 * The RPC returns the reset intent and the drawer reads the backend-backed
 * user security-action stream, so refresh the active drawer evidence query
 * immediately after success. A toast alone is not enough completion proof.
 */
export function useForcePasswordReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UsersForcePasswordResetArgs) => api.force_password_reset_v1(args),
    onSuccess: async () => {
      await refreshListQueries(qc, ['users', 'user_directory']);
      await qc.invalidateQueries({
        queryKey: ['user_security_actions'],
        refetchType: 'active',
      });
      await qc.refetchQueries({
        queryKey: ['user_security_actions'],
        type: 'active',
      });
    },
  });
}

export function useTenantInvitableRoles(args: { organization_id?: string | null } = {}) {
  return useQuery({
    queryKey: ['tenant_invitable_roles', args.organization_id ?? null] as const,
    queryFn: () => api.ui_list_tenant_invitable_roles_v1(args),
    enabled: Boolean(args.organization_id),
  });
}

export function useTenantUserInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: api.TenantUserInviteArgs) => api.tenant_user_invite_v1(args),
    onSuccess: () => refreshTenantInviteReadModels(qc),
  });
}

/**
 * Resolve a user's capability evaluation result (for the Capabilities tab).
 *
 * Backed by `public.user_capability_eval_v1(p_capability_key, p_scope_type,
 * p_scope_id)` per supabase/migrations/202601022113_access_control_policy_core.sql:764.
 * Returns the evaluator JSONB envelope:
 *   { allowed, reason, capability_key, scope_type, scope_id, role_keys,
 *     granted_capabilities, policy_source: { settings_id, settings_version_id,
 *     policy_scope_type, policy_scope_id, scope_path } }
 *
 * The Capabilities tab in /platform/users uses this to render per-capability
 * resolved path with override-source visualization (sets up Phase E4
 * LadderViz). Demo mode synthesizes the evaluator output from
 * `useResolveAccessPolicy` results (the same SSOT walk minus the per-cap
 * audit row write).
 */
export function useUserCapabilityEval(
  capability_key: string | undefined,
  scope_type?: string,
  scope_id?: string | null,
  enabled = true,
  user_id?: string,
) {
  return useQuery<api.UserCapabilityEvalResult>({
    queryKey: ['user_capability_eval_v1', capability_key ?? null, scope_type ?? null, scope_id ?? null, user_id ?? null] as const,
    queryFn: () =>
      api.user_capability_eval_v1({
        capability_key: capability_key as string,
        scope_type,
        scope_id: scope_id ?? null,
        user_id,
      }),
    enabled: enabled && !!capability_key,
  });
}

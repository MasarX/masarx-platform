// route-plans.tsx — Operator Route Plans surface (canonical SSOT: AGENTS.md
// lines 45-48 + supabase/migrations route_plan_*).
//
// Backed by:
//   - public.route_plans / api.route_plans                (202604032350)
//   - api.ui_create_route_plan_v1                         (202604032350)
//   - api.ui_solve_route_plan_v1                          (202604041520)
//   - api.ui_freeze_route_plan_v1                         (202604032350 + 202604061140)
//   - api.ui_publish_route_plan_v1                        (202604061030)
//   - api.ui_apply_route_plan_v1                          (202604032350)
//   - api.ui_rebalance_route_plan_v1                      (202604061315)
//   - public.route_plan_validate_constraints_v1           (202604061140)
//   - api.ui_route_plan_delivery_wave_candidates_v1       (202605070930)
//
// All mutations go through TanStack Query mutation hooks (cache invalidation,
// retry policy, devtools), never directly through `api.*`.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Dot, type DotKind } from '@/components/Dot';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Stepper, type StepperStage } from '@/components/Stepper';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { ReferencePicker, type ReferenceSource } from '@/components/ReferencePicker';
import {
  RouteStopMap,
  type RouteStopMapGeocode,
  type RouteStopMapShipment,
  type RouteStopMapStop,
  type RouteStopMapTileProvider,
} from '@/components/RouteStopMap';
import {
  useResourceList,
  useResourceListsByFilters,
  useResourceRowsByIds,
  useCreateRoutePlan,
  useSolveRoutePlan,
  useFreezeRoutePlan,
  usePublishRoutePlan,
  useApplyRoutePlan,
  useRebalanceRoutePlan,
  useValidateRoutePlanConstraints,
  useRoutePlanExecutionPack,
  useResolveSettings,
} from '@/lib/queries';
import type { RoutePlanConstraintCheck, RoutePlanRebalanceInput } from '@/lib/api';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useCapability, useIdentity } from '@/lib/identity';
import { useI18n } from '@/lib/i18n';
import { CAP } from '@/lib/capabilities';
import { openShipmentContextDrawer, type Shipment } from '@/modules/operate/shipments';
// W54-C — strict canonical lookup resolver (NO inline status→stage map).
import { getLookups, lookupRow, ui_list_resource_v1 } from '@/lib/api';
import { rpc } from '@/lib/supabase';

// Plan lifecycle stages — UX progression. Cloud lookup `route_plan_status`
// (created/submitted/solved/applied/failed/canceled) maps onto a subset; we
// keep the richer six-stage stepper and project the cloud status onto it via
// `mapDbStatusToStage()` so the stepper highlights the cloud-authoritative
// stage in addition to the UX progression.
//
// W54-C closure — stages + projection both resolve from canonical
// `route_plan_status` lookup_values + their `metadata.stage` projection.
// NO inline `PLAN_LIFECYCLE_STAGES` literal array, NO inline switch/map
// hardcoding the cloud-status → UX-stage mapping. The lookup carries
// the canonical stage projection per row (rows without `metadata.stage`
// fall through to their raw value).
function getPlanLifecycleStages(): StepperStage[] {
  // Resolve canonical labels for the six FE-stage taxonomy from lookups
  // so the stepper labels stay row-driven. Falls through to title-cased
  // id when canonical row missing (loud `(missing)` marker added by
  // consumer where applicable).
  const rows = getLookups('route_plan_status');
  const configured = rows
    .filter((row) => row.metadata?.is_lifecycle_stepper === true)
    .sort((a, b) => Number(a.metadata?.stepper_rank ?? a.rank ?? 0) - Number(b.metadata?.stepper_rank ?? b.rank ?? 0));
  const implied = configured.length > 0
    ? configured
    : rows.filter((row) => row.metadata?.stage === row.value);
  const seen = new Set<string>();
  return implied.reduce<StepperStage[]>((stages, row) => {
    const id = String(row.metadata?.stage ?? row.value);
    if (seen.has(id)) return stages;
    seen.add(id);
    stages.push({ id, label: row.label ?? id.charAt(0).toUpperCase() + id.slice(1) });
    return stages;
  }, []);
}

function mapDbStatusToStage(status: string): string {
  // W54-C — projection driven by canonical `route_plan_status.metadata.stage`.
  // Unknown / unmapped status values fall back to the raw value so legacy
  // seed statuses keep working unchanged.
  const row = lookupRow('route_plan_status', status) as
    | { metadata?: { stage?: string } }
    | null;
  return row?.metadata?.stage ?? status;
}

// Wave 6 schema-drift remediation (OPERATIONS Sections 12+13):
// FE row interfaces annotated against canonical `public.route_plans` and
// `public.branches` (resource key 'hubs' aliases branches). Migration cite:
// supabase/migrations/202601311740_route_plans_ssot_v1.sql:48-76 and
// 202601212340_branches_coverage_foundation.sql:19-37. See
// __audit__/SCHEMA-DRIFT/OPERATIONS.md §12-§13.
interface RoutePlanRow extends Record<string, unknown> {
  id: string;                       // SSOT: route_plans.id
  organization_id?: string | null;  // SSOT: route_plans.organization_id
  branch_id?: string | null;        // SSOT: route_plans.branch_id
  planned_date?: string | null;     // SSOT: route_plans.planned_date
  plan_id: string;                  // SSOT: REMOVE — alias of `id` (W7 cascade)
  wave_label: string;               // SSOT: REMOVE — projection (resolve via metadata.wave_label or inputs.wave_label)
  hub: string;                      // SSOT: route_plans.branch_id (uuid; FE displays code via branches join) — RENAME deferred W7
  status: string;                   // SSOT: route_plans.status
  stops: number;                    // SSOT: REMOVE — projection (count via solution payload or route_stops)
  runs: number;                     // SSOT: REMOVE — projection (count of runs in solution)
  drivers_notified?: number;        // SSOT: REMOVE — projection (computed via route_plan_events)
  applied?: number;                 // SSOT: route_plans.applied_at (boolean projection: applied_at IS NOT NULL) — RENAME deferred W7
  updated_at: string;               // SSOT: route_plans.updated_at
  metadata?: Record<string, unknown> | null;
  inputs?: Record<string, unknown> | null;
  solution?: Record<string, unknown> | null;
}

interface RoutePlanInputStop extends RouteStopMapStop {
  client_id?: string | null | undefined;
  stop_kind?: string | null | undefined;
  planned_window_start_at?: string | null | undefined;
  planned_window_end_at?: string | null | undefined;
  sla_tone?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface RoutePlanStopRow extends RouteStopMapStop {
  route_run_id?: string | null;
  stop_kind?: string | null;
  sla_tone?: string | null;
}

interface RoutePlanShipmentRow extends RouteStopMapShipment {
  client_id?: string | null;
  service_type?: string | null;
  status?: string | null;
  created_at?: string | null;
  planned_window_start_at?: string | null;
  planned_window_end_at?: string | null;
  promised_window_start_at?: string | null;
  promised_window_end_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface RoutePlanCandidateRow extends Record<string, unknown> {
  id?: string | null;
  sequence_order?: number | null;
  shipment_id: string;
  client_id: string;
  zone_id?: string | null;
  branch_id?: string | null;
  service_level?: string | null;
  promised_delivery_date?: string | null;
  promised_window_start_at?: string | null;
  promised_window_end_at?: string | null;
  priority_score?: number | null;
  tracking_number?: string | null;
  stop_payload?: Record<string, unknown> | null;
}

interface RoutePlanDeepLinkFocus {
  shipmentId: string | null;
}

function routePlanFocusFromBrowserLocation(): RoutePlanDeepLinkFocus {
  if (typeof window === 'undefined') return { shipmentId: null };
  const params = new URLSearchParams(window.location.search);
  return {
    shipmentId: stringOrNull(params.get('shipment')) ?? stringOrNull(params.get('shipment_id')),
  };
}

interface HubRow extends Record<string, unknown> {
  id: string;                       // SSOT: branches.id (resource key 'hubs' aliases branches)
  code: string;                     // SSOT: branches.code
  name: string;                     // SSOT: branches.name
  city: string;                     // SSOT: REMOVE — projection (resolve via branches.address->>'city' JSONB)
  cutoff_time: string;              // SSOT: REMOVE — projection (resolve via branches.operating_hours JSONB / policy)
}

interface RouteRunPlanLinkRow extends Record<string, unknown> {
  id: string;
  route_plan_id?: string | null;
  plan_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface MapPolicyValue {
  tile_provider?: RouteStopMapTileProvider;
  default_viewport?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}

// W24 — Paired projection view `public.v_route_plan_directory`
// (supabase/migrations/202604302250_v_route_plan_directory.sql). Read-only
// canonical SSOT for the FE-shaped derived projections (plan_display_id,
// branch_label / branch_code, wave_label / wave_key from metadata/inputs
// JSONB, run_count / stop_count / drivers_notified_count counters,
// is_applied derived flag). Module call sites consume this through
// `useResourceList<RoutePlanDirectoryRow>('route_plan_directory')` so the
// production cutover is a single getSupabaseClient() branch flip — the
// canonical RoutePlanRow surface stays stable and the legacy aliases on
// the row interface (`plan_id`, `wave_label`, `hub`, `stops`, `runs`,
// `drivers_notified`, `applied`) resolve through this seam.
export interface RoutePlanDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  branch_id?: string | null;
  planned_date?: string | null;
  status?: string | null;
  status_reason?: string | null;
  applied_at?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  plan_display_id?: string | null;
  branch_label?: string | null;
  branch_code?: string | null;
  wave_label?: string | null;
  wave_key?: string | null;
  run_count?: number;
  stop_count?: number;
  drivers_notified_count?: number;
  is_applied?: boolean;
}

function focusedShipmentCandidateMissingReasons(shipment: Shipment | null, promisedDate: string | null): string[] {
  if (!shipment) return ['shipment status is still loading'];
  const metadata = recordOrNull(shipment.metadata);
  const reasons: string[] = [];
  if (!stringOrNull(shipment.branch_id) && !stringOrNull(metadata?.service_offering_branch_id)) {
    reasons.push('branch/service offering match');
  }
  if (!promisedDate) reasons.push('promised delivery date');
  if (!stringOrNull(shipment.service_level) && !stringOrNull(metadata?.service_level_key)) {
    reasons.push('service level');
  }
  if (!stringOrNull(shipment.destination_address_id)) reasons.push('destination address');
  return reasons;
}

// CLAIM-OPERATIONS-WIRING (Phase C1) — wave_catalog is row-driven via
// `useResourceList('wave_catalog')` (see WaveCatalogRow below). Canonical
// SSOT: `public.wave_catalog` projection (production cutover) /
// `seed-raw/domain-shipments.js#wave_catalog` (seed mode). NO fallback
// constants — when the canonical resource is unseeded, the wave-preset
// control surfaces a loud error StateView.
interface WaveCatalogRow extends Record<string, unknown> {
  id: string;
  label: string;
  window_start?: string;
  window_end?: string;
  active?: boolean;
  sort_order?: number;
}

// SLA breach: a published-but-not-applied plan that's older than the wave
// promise window. The window is canonical row-driven via
// `route_plan_thresholds.wave_promise_window_seconds` (W34c). Production
// also exposes `route_plans.metadata.wave_promise_at` per-plan; this
// heuristic operates as the cross-tenant fallback signal.
function isSlaBreach(plan: RoutePlanRow, windowSeconds: number | undefined): boolean {
  // W71-Operate (Cycle F-R-11) closure — SLA-breach gate resolves through
  // canonical `route_plan_status.metadata.is_sla_breach_eligible` instead
  // of an inline `'published'` literal compare. AGENTS.md §2 (ZERO
  // HARDCODING) + §6 (row-driven by configuration).
  if (lookupRow('route_plan_status', plan.status)?.metadata?.is_sla_breach_eligible !== true) return false;
  if (!Number.isFinite(windowSeconds) || (windowSeconds ?? 0) <= 0) return false;
  const updated = new Date(plan.updated_at).getTime();
  if (!Number.isFinite(updated)) return false;
  return Date.now() - updated > (windowSeconds as number) * 1000;
}

type BulkRoutePlanActionLabel = {
  complete: string;
  failed: string;
  partial: string;
};

function routePlanBulkErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'Unknown error';
}

function routePlanReadErrorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : 'Route plans did not load.';
}

function routePlanDisplayId(plan: RoutePlanRow): string {
  return plan.plan_id || plan.id;
}

async function runBulkRoutePlanAction<T>(
  plans: RoutePlanRow[],
  labels: BulkRoutePlanActionLabel,
  run: (plan: RoutePlanRow) => Promise<T>,
): Promise<void> {
  if (plans.length === 0) return;
  const results = await Promise.allSettled(plans.map((plan) => run(plan)));
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const plan = plans[index];
    return [`${plan ? routePlanDisplayId(plan) : `Plan ${index + 1}`}: ${routePlanBulkErrorMessage(result.reason)}`];
  });
  const successCount = results.length - failures.length;
  const failureSummary = failures.slice(0, 2).join(' · ');
  const overflow = failures.length > 2 ? ` · +${failures.length - 2} more` : '';
  if (failures.length === 0) {
    pushToast(`${labels.complete} · ${successCount} ${successCount === 1 ? 'plan' : 'plans'}`, 'good');
    return;
  }
  if (successCount > 0) {
    pushToast(
      `${labels.partial} · ${successCount} succeeded, ${failures.length} failed · ${failureSummary}${overflow}`,
      'warn',
    );
    return;
  }
  pushToast(`${labels.failed} · ${failures.length} failed · ${failureSummary}${overflow}`, 'danger');
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function routePlanOrganizationId(plan: RoutePlanRow): string | null {
  return stringOrNull(plan.organization_id) ?? stringOrNull(recordOrNull(plan.metadata)?.organization_id);
}

function routePlansShareOrganization(left: RoutePlanRow, right: RoutePlanRow): boolean {
  const leftOrg = routePlanOrganizationId(left);
  const rightOrg = routePlanOrganizationId(right);
  return !leftOrg || !rightOrg || leftOrg === rightOrg;
}

function routePlanTenantLifecycleDisabledReason(
  plan: RoutePlanRow,
  activeTenantId: string | null | undefined,
): string | undefined {
  const planOrgId = routePlanOrganizationId(plan);
  const activeId = stringOrNull(activeTenantId);
  if (planOrgId && (!activeId || planOrgId !== activeId)) {
    return "Switch to this route plan's tenant before changing route-plan lifecycle.";
  }
  return undefined;
}

function routePlanBulkTenantLifecycleDisabledReason(
  plans: RoutePlanRow[],
  activeTenantId: string | null | undefined,
): string | undefined {
  return plans.some((plan) => routePlanTenantLifecycleDisabledReason(plan, activeTenantId))
    ? "Switch to each selected route plan's tenant before changing route-plan lifecycle."
    : undefined;
}

function compactRoutePlanShipmentId(shipmentId: string): string {
  const value = shipmentId.trim();
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function routePlanShipmentReferenceLabel(shipmentId: string, trackingNumber?: string | null): string {
  return stringOrNull(trackingNumber) ?? `Shipment ${compactRoutePlanShipmentId(shipmentId)}`;
}

function routePlanShipmentContextFallback(
  shipmentId: string,
  trackingNumber?: string | null,
  serviceType?: string | null,
): Partial<Shipment> {
  const tracking = stringOrNull(trackingNumber);
  const service = stringOrNull(serviceType);
  return {
    id: shipmentId,
    ...(tracking ? { tracking_number: tracking } : {}),
    ...(service ? { service_type: service } : {}),
  };
}

function plannedStopsFromRoutePlan(plan: RoutePlanRow): RoutePlanInputStop[] {
  const solution = recordOrNull(plan.solution);
  const inputs = recordOrNull(plan.inputs);
  const stopsValue = Array.isArray(solution?.stops)
    ? solution?.stops
    : Array.isArray(inputs?.stops)
      ? inputs?.stops
      : [];

  return stopsValue.reduce<RoutePlanInputStop[]>((acc, value, index) => {
    const stop = recordOrNull(value);
    const shipmentId = stringOrNull(stop?.shipment_id);
    if (!stop || !shipmentId) return acc;
    acc.push({
      id: stringOrNull(stop.id) ?? `${plan.id}:planned:${shipmentId}:${index + 1}`,
      shipment_id: shipmentId,
      client_id: stringOrNull(stop.client_id),
      stop_kind: stringOrNull(stop.stop_kind),
      sequence_order: Number.isFinite(Number(stop.sequence_order))
        ? Number(stop.sequence_order)
        : index + 1,
      planned_window_start_at: stringOrNull(stop.planned_window_start_at),
      planned_window_end_at: stringOrNull(stop.planned_window_end_at),
      sla_tone: stringOrNull(stop.sla_tone),
      metadata: recordOrNull(stop.metadata) ?? undefined,
    });
    return acc;
  }, []);
}

function normalizeCandidateRow(row: RoutePlanCandidateRow): RoutePlanCandidateRow {
  const shipmentId = stringOrNull(row.shipment_id) ?? stringOrNull(row.id) ?? '';
  return {
    ...row,
    id: stringOrNull(row.id) ?? shipmentId,
    shipment_id: shipmentId,
    client_id: stringOrNull(row.client_id) ?? '',
    tracking_number: stringOrNull(row.tracking_number),
    service_level: stringOrNull(row.service_level),
    promised_delivery_date: stringOrNull(row.promised_delivery_date),
    promised_window_start_at: stringOrNull(row.promised_window_start_at),
    promised_window_end_at: stringOrNull(row.promised_window_end_at),
    branch_id: stringOrNull(row.branch_id),
    zone_id: stringOrNull(row.zone_id),
    sequence_order: Number.isFinite(Number(row.sequence_order)) ? Number(row.sequence_order) : null,
    priority_score: Number.isFinite(Number(row.priority_score)) ? Number(row.priority_score) : null,
    stop_payload: recordOrNull(row.stop_payload),
  };
}

function routePlanCandidateLabel(candidate: RoutePlanCandidateRow): string {
  return (
    stringOrNull(candidate.tracking_number) ??
    stringOrNull(candidate.shipment_id) ??
    stringOrNull(candidate.id) ??
    'unlabeled candidate'
  );
}

function routePlanCandidateSubLabel(candidate: RoutePlanCandidateRow): string {
  const parts = [
    stringOrNull(candidate.service_level),
    stringOrNull(candidate.zone_id) ? `zone ${candidate.zone_id}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : 'candidate details pending';
}

function routePlanCandidateWindowLabel(candidate: RoutePlanCandidateRow): string {
  const start = stringOrNull(candidate.promised_window_start_at);
  const end = stringOrNull(candidate.promised_window_end_at);
  if (start && end) return `${start} -> ${end}`;
  return start ?? end ?? 'window pending';
}

function routePlanStopShipmentTrackingNumber(stop: unknown): string | null {
  const row = recordOrNull(stop);
  const metadata = recordOrNull(row?.metadata);
  return stringOrNull(metadata?.tracking_number);
}

function routePlanStopShipmentReferenceLabel(stop: { shipment_id: string }): string {
  return routePlanShipmentReferenceLabel(stop.shipment_id, routePlanStopShipmentTrackingNumber(stop));
}

function routePlanStopFromCandidate(candidate: RoutePlanCandidateRow, index: number): RoutePlanInputStop | null {
  const payload = recordOrNull(candidate.stop_payload);
  const shipmentId = stringOrNull(payload?.shipment_id) ?? stringOrNull(candidate.shipment_id);
  const clientId = stringOrNull(payload?.client_id) ?? stringOrNull(candidate.client_id);
  if (!shipmentId || !clientId) return null;
  const payloadMetadata = recordOrNull(payload?.metadata) ?? {};
  const payloadSequence = Number(payload?.sequence_order);
  const candidateSequence = Number(candidate.sequence_order);
  return {
    id: stringOrNull(payload?.id) ?? `planned:${shipmentId}`,
    shipment_id: shipmentId,
    client_id: clientId,
    stop_kind: stringOrNull(payload?.stop_kind),
    sequence_order: Number.isFinite(payloadSequence)
      ? payloadSequence
      : Number.isFinite(candidateSequence)
        ? candidateSequence
        : index + 1,
    planned_window_start_at:
      stringOrNull(payload?.planned_window_start_at) ?? stringOrNull(candidate.promised_window_start_at),
    planned_window_end_at:
      stringOrNull(payload?.planned_window_end_at) ?? stringOrNull(candidate.promised_window_end_at),
    metadata: {
      ...payloadMetadata,
      selected_by: 'console_v2.route_plans.create',
      tracking_number: candidate.tracking_number ?? payloadMetadata.tracking_number ?? null,
      service_level: candidate.service_level ?? payloadMetadata.service_level ?? null,
    },
  };
}

function useRoutePlanDeliveryWaveCandidates(args: {
  branchId?: string | null;
  plannedDate: string;
  waveId?: string | null;
  organizationId?: string | null;
  enabled?: boolean;
}) {
  const { branchId, plannedDate, waveId, organizationId, enabled = true } = args;
  return useQuery({
    queryKey: ['route_plan_delivery_wave_candidates', organizationId ?? null, branchId ?? null, plannedDate, waveId ?? null],
    enabled: enabled && Boolean(plannedDate),
    queryFn: async () => {
      const input = {
        ...(organizationId ? { organization_id: organizationId } : {}),
        ...(branchId ? { branch_id: branchId } : {}),
        planned_date: plannedDate,
        inputs: { wave_selection: waveId ? { wave_id: waveId } : {} },
      };
      const liveRows = await rpc<RoutePlanCandidateRow[]>(
        'ui_route_plan_delivery_wave_candidates_v1',
        { p_input: input },
      );
      if (Array.isArray(liveRows)) {
        const rows = liveRows.map((row) => normalizeCandidateRow(row));
        return { rows, total: rows.length };
      }
      const fallback = await ui_list_resource_v1<RoutePlanCandidateRow>(
        'route_plan_delivery_wave_candidates',
        {
          filter: {
            ...(organizationId ? { organization_id: organizationId } : {}),
            ...(branchId ? { branch_id: branchId } : {}),
            planned_date: plannedDate,
          },
          sort: { key: 'sequence_order', dir: 'asc' },
          page_size: 1000,
        },
      );
      const rows = (fallback.rows ?? []).map((row) => normalizeCandidateRow(row));
      return { ...fallback, rows, total: rows.length };
    },
  });
}

function shipmentAddressIdForMap(shipment: RoutePlanShipmentRow | undefined): string | null {
  return (
    stringOrNull(shipment?.destination_address_id) ??
    stringOrNull(shipment?.address_id) ??
    stringOrNull(shipment?.recipient_address_id)
  );
}

function useExactPlanStops(plan: RoutePlanRow) {
  const plannedStops = useMemo(() => plannedStopsFromRoutePlan(plan), [plan]);
  const routeRunsQuery = useResourceList<RouteRunPlanLinkRow>(
    'route_runs',
    { filter: { route_plan_id: plan.id }, page_size: 1000 },
    { enabled: Boolean(plan.id) },
  );
  const planRunIds = useMemo(
    () =>
      Array.from(
        new Set(
          (routeRunsQuery.data?.rows ?? [])
            .map((run) => stringOrNull(run.id))
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [routeRunsQuery.data?.rows],
  );
  const routeStopFilters = useMemo(
    () => planRunIds.map((route_run_id) => ({ route_run_id })),
    [planRunIds],
  );
  const routeStopsQuery = useResourceListsByFilters<RoutePlanStopRow>(
    'route_stops',
    routeStopFilters,
    { page_size: 1000 },
    { enabled: planRunIds.length > 0 },
  );
  const materializedStops = routeStopsQuery.data?.rows ?? [];
  const planStops = materializedStops.length > 0 ? materializedStops : plannedStops;
  return {
    planStops,
    isLoading: routeRunsQuery.isLoading || (planRunIds.length > 0 && routeStopsQuery.isLoading),
    isError: routeRunsQuery.isError || routeStopsQuery.isError,
  };
}

function RoutePlanMapPanel({
  plan,
  tileProvider,
  bounds,
}: {
  plan: RoutePlanRow;
  tileProvider: RouteStopMapTileProvider | null;
  bounds: MapPolicyValue['default_viewport'] | null;
}) {
  const { planStops, isLoading: stopsLoading, isError: stopsError } = useExactPlanStops(plan);
  const shipmentIds = useMemo(
    () =>
      Array.from(
        new Set(
          planStops
            .map((stop) => stringOrNull(stop.shipment_id))
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [planStops],
  );
  const shipmentsQuery = useResourceRowsByIds<RoutePlanShipmentRow>('shipments', shipmentIds, {
    enabled: shipmentIds.length > 0,
  });
  const mapShipments = shipmentsQuery.data?.rows ?? [];
  const addressIds = useMemo(
    () =>
      Array.from(
        new Set(
          mapShipments
            .map((shipment) => shipmentAddressIdForMap(shipment))
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [mapShipments],
  );
  const geocodeFilters = useMemo(
    () => addressIds.map((address_id) => ({ address_id })),
    [addressIds],
  );
  const geocodesQuery = useResourceListsByFilters<RouteStopMapGeocode>(
    'geocodes',
    geocodeFilters,
    { page_size: 5 },
    { enabled: addressIds.length > 0 },
  );
  const mapGeocodes = geocodesQuery.data?.rows ?? [];
  const isLoading =
    stopsLoading ||
    (shipmentIds.length > 0 && shipmentsQuery.isLoading) ||
    (addressIds.length > 0 && geocodesQuery.isLoading);
  const isError = stopsError || shipmentsQuery.isError || geocodesQuery.isError;

  if (isError) {
    return (
      <StateView
        kind="error"
        title="Route plan map unavailable"
        hint="Could not load the selected plan stops, shipments, or geocodes."
      />
    );
  }

  if (isLoading) {
    return <StateView kind="loading" hint="Loading selected route plan map..." />;
  }

  return (
    <RouteStopMap
      testId="route-plan-stop-map"
      stops={planStops}
      shipments={mapShipments}
      geocodes={mapGeocodes}
      tileProvider={tileProvider}
      bounds={bounds}
      height={240}
      title="Route plan stop map"
      emptyLabel="No geocoded stops for this plan yet."
    />
  );
}

interface RoutePlanDrawerSnapshot {
  plan: RoutePlanRow;
  stage: string;
  planDisplay: string;
  waveLabel: string;
  branchLabel: string;
  statusLabel: string;
  stopsLabel: string;
  runsLabel: string;
  driversNotifiedLabel: string;
}

function routePlanStatusLabel(status: string): string {
  const row = lookupRow('route_plan_status', status) as { label?: string } | null;
  if (row?.label) return row.label;
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Unknown';
}

function routePlanWithDirectory(
  plan: RoutePlanRow,
  directory: RoutePlanDirectoryRow | null | undefined,
): RoutePlanRow {
  return {
    ...plan,
    organization_id: directory?.organization_id ?? plan.organization_id,
    branch_id: directory?.branch_id ?? plan.branch_id,
    planned_date: directory?.planned_date ?? plan.planned_date,
    plan_id: directory?.plan_display_id ?? plan.plan_id ?? `RPL-${plan.id.slice(-6).toUpperCase()}`,
    wave_label:
      directory?.wave_label ??
      plan.wave_label ??
      String((plan.metadata as { wave_label?: string } | undefined)?.wave_label ?? 'Unassigned wave'),
    hub: directory?.branch_label ?? directory?.branch_code ?? plan.hub ?? 'Unassigned hub',
    status: directory?.status ?? plan.status,
    stops: directory?.stop_count ?? plan.stops ?? 0,
    runs: directory?.run_count ?? plan.runs ?? 0,
    drivers_notified: directory?.drivers_notified_count ?? plan.drivers_notified ?? 0,
    applied: directory?.is_applied ? 1 : (plan.applied ?? 0),
  };
}

function routePlanWithPreservedStops(plan: RoutePlanRow, fallbackPlan: RoutePlanRow): RoutePlanRow {
  if (plannedStopsFromRoutePlan(plan).length > 0) return plan;
  return {
    ...plan,
    inputs: fallbackPlan.inputs,
    solution: fallbackPlan.solution,
  };
}

function useRoutePlanDrawerSnapshot(planId: string, fallbackPlan: RoutePlanRow): RoutePlanDrawerSnapshot {
  const planQuery = useResourceRowsByIds<RoutePlanRow>('route_plans', [planId], { enabled: Boolean(planId) });
  const directoryQuery = useResourceRowsByIds<RoutePlanDirectoryRow>('route_plan_directory', [planId], {
    enabled: Boolean(planId),
  });
  const directory = directoryQuery.data?.rows?.[0] ?? null;
  const livePlan = planQuery.data?.rows?.[0] ?? null;
  const basePlan = livePlan
    ? {
        ...fallbackPlan,
        ...livePlan,
        id: stringOrNull(livePlan.id) ?? fallbackPlan.id,
        inputs: livePlan.inputs ?? fallbackPlan.inputs,
        metadata: livePlan.metadata ?? fallbackPlan.metadata,
        solution: livePlan.solution ?? fallbackPlan.solution,
      }
    : fallbackPlan;
  const plan = routePlanWithDirectory(routePlanWithPreservedStops(basePlan, fallbackPlan), directory);
  return {
    plan,
    stage: mapDbStatusToStage(plan.status),
    planDisplay: directory?.plan_display_id ?? plan.plan_id,
    waveLabel: directory?.wave_label ?? plan.wave_label,
    branchLabel: directory?.branch_label ?? directory?.branch_code ?? plan.hub,
    statusLabel: routePlanStatusLabel(plan.status),
    stopsLabel: String(directory?.stop_count ?? plan.stops ?? 0),
    runsLabel: String(directory?.run_count ?? plan.runs ?? 0),
    driversNotifiedLabel: String(directory?.drivers_notified_count ?? plan.drivers_notified ?? 0),
  };
}

function RoutePlanDrawerTitle({ planId, fallbackPlan }: { planId: string; fallbackPlan: RoutePlanRow }) {
  const snapshot = useRoutePlanDrawerSnapshot(planId, fallbackPlan);
  return <>{snapshot.planDisplay} - {snapshot.waveLabel}</>;
}

function RoutePlanDrawerBody({
  planId,
  fallbackPlan,
  mapTileProvider,
  mapDefaultViewport,
}: {
  planId: string;
  fallbackPlan: RoutePlanRow;
  mapTileProvider: RouteStopMapTileProvider | null;
  mapDefaultViewport: MapPolicyValue['default_viewport'] | null;
}) {
  const snapshot = useRoutePlanDrawerSnapshot(planId, fallbackPlan);
  const validateMutation = useValidateRoutePlanConstraints();
  return (
    <div>
      <Stepper stages={getPlanLifecycleStages()} current={snapshot.stage} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '14px' }}>
        <InfoCard label="Status" value={snapshot.statusLabel} />
        <InfoCard label="Hub" value={snapshot.branchLabel} />
        <InfoCard label="Stops" value={snapshot.stopsLabel} />
        <InfoCard label="Runs" value={snapshot.runsLabel} />
        <InfoCard label="Drivers notified" value={snapshot.driversNotifiedLabel} />
      </div>

      <div style={{ marginTop: '14px' }}>
        <RoutePlanMapPanel
          plan={snapshot.plan}
          tileProvider={mapTileProvider}
          bounds={mapDefaultViewport}
        />
      </div>

      <ExecutionPackPanel planId={planId} enabled={snapshot.stage === 'published' || snapshot.stage === 'applied'} />

      <h4 className="eyebrow" style={{ marginTop: '16px' }}>Planning workflow</h4>
      <div className="card" style={{ fontSize: '11px', lineHeight: 1.6 }}>
        <SeamLine k="Solve" v="Optimize stop order" />
        <SeamLine k="Validate" v="Check capacity and service constraints" />
        <SeamLine k="Freeze" v="Lock the reviewed plan" />
        <SeamLine k="Publish" v="Create the execution package" />
        <SeamLine k="Apply" v="Create dispatch-ready route runs" />
        <SeamLine k="Rebalance" v="Move stops before dispatch" />
      </div>

      <h4 className="eyebrow" style={{ marginTop: '16px' }}>Validate constraints</h4>
      <PlanValidatePanel planId={planId} run={(id) => validateMutation.mutateAsync(id)} />
    </div>
  );
}

function RoutePlanDrawerFooter({
  planId,
  fallbackPlan,
  onRebalance,
}: {
  planId: string;
  fallbackPlan: RoutePlanRow;
  onRebalance: (plan: RoutePlanRow) => void;
}) {
  const snapshot = useRoutePlanDrawerSnapshot(planId, fallbackPlan);
  const solveMutation = useSolveRoutePlan();
  const freezeMutation = useFreezeRoutePlan();
  const publishMutation = usePublishRoutePlan();
  const applyMutation = useApplyRoutePlan();
  const { scope, currentTenantId } = useIdentity();
  const activeTenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantLifecycleDisabledReason = routePlanTenantLifecycleDisabledReason(snapshot.plan, activeTenantId);
  const { planStops: scopedPlanStops } = useExactPlanStops(snapshot.plan);
  const rebalancePlan = useMemo(() => {
    if (scopedPlanStops.length === 0) {
      return routePlanWithPreservedStops(snapshot.plan, fallbackPlan);
    }
    const solution = recordOrNull(snapshot.plan.solution) ?? {};
    return routePlanWithPreservedStops(
      {
        ...snapshot.plan,
        solution: {
          ...solution,
          stops: scopedPlanStops,
        },
      },
      fallbackPlan,
    );
  }, [fallbackPlan, scopedPlanStops, snapshot.plan]);
  return (
    <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
      <Button
        label="Solve"
        iconName="play"
        kind="ghost"
        capability={CAP.ROUTE_PLANS_WRITE}
        disabled={Boolean(tenantLifecycleDisabledReason)}
        title={tenantLifecycleDisabledReason}
        onClick={async () => {
          if (tenantLifecycleDisabledReason) {
            pushToast(tenantLifecycleDisabledReason, 'warn');
            return;
          }
          try {
            await solveMutation.mutateAsync(planId);
            pushToast(`Solved - ${snapshot.planDisplay}`, 'good');
          } catch {
            pushToast('Solve could not be completed. Try again.', 'danger');
          }
        }}
      />
      <Button
        label="Freeze"
        iconName="lock"
        kind="ghost"
        capability={CAP.ROUTE_PLANS_WRITE}
        disabled={Boolean(tenantLifecycleDisabledReason)}
        title={tenantLifecycleDisabledReason}
        onClick={async () => {
          if (tenantLifecycleDisabledReason) {
            pushToast(tenantLifecycleDisabledReason, 'warn');
            return;
          }
          try {
            const res = await freezeMutation.mutateAsync(planId);
            pushToast(
              `Frozen - ${snapshot.planDisplay} - ${res.constraint_validation.fail_count} fails`,
              res.constraint_validation.fail_count > 0 ? 'warn' : 'good',
            );
          } catch {
            pushToast('Freeze could not be completed. Try again.', 'danger');
          }
        }}
      />
      <div style={{ flex: 1 }} />
      <Button
        label="Rebalance..."
        iconName="rotate"
        kind="ghost"
        capability={CAP.ROUTE_PLANS_WRITE}
        disabled={Boolean(tenantLifecycleDisabledReason)}
        title={tenantLifecycleDisabledReason}
        onClick={() => {
          if (tenantLifecycleDisabledReason) {
            pushToast(tenantLifecycleDisabledReason, 'warn');
            return;
          }
          onRebalance({ ...rebalancePlan, id: planId });
        }}
      />
      <Button
        label="Publish"
        iconName="bolt"
        kind="ghost"
        capability={CAP.ROUTE_PLANS_WRITE}
        disabled={Boolean(tenantLifecycleDisabledReason)}
        title={tenantLifecycleDisabledReason}
        onClick={async () => {
          if (tenantLifecycleDisabledReason) {
            pushToast(tenantLifecycleDisabledReason, 'warn');
            return;
          }
          try {
            const res = await publishMutation.mutateAsync(planId);
            pushToast(`Published - pack ${res.execution_pack_hash ?? '-'}`, 'good');
          } catch {
            pushToast('Publish could not be completed. Try again.', 'danger');
          }
        }}
      />
      <Button
        label="Apply"
        iconName="check"
        kind="primary"
        capability={CAP.ROUTE_PLANS_WRITE}
        disabled={Boolean(tenantLifecycleDisabledReason)}
        title={tenantLifecycleDisabledReason}
        onClick={async () => {
          if (tenantLifecycleDisabledReason) {
            pushToast(tenantLifecycleDisabledReason, 'warn');
            return;
          }
          try {
            const res = await applyMutation.mutateAsync(planId);
            pushToast(`Applied - ${res.runs_materialized} runs`, 'good');
          } catch {
            pushToast('Apply could not be completed. Try again.', 'danger');
          }
        }}
      />
    </div>
  );
}

export function RoutePlansModule() {
  const { t } = useI18n();
  const { scope, currentTenantId } = useIdentity();
  const canRead = useCapability(CAP.ROUTE_PLANS_READ);
  const canWrite = useCapability(CAP.ROUTE_PLANS_WRITE);
  const drawer = useDrawer();
  const modal = useModal();
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const [deepLinkFocus, setDeepLinkFocus] = useState<RoutePlanDeepLinkFocus>(() => routePlanFocusFromBrowserLocation());
  const [openedDeepLinkShipmentId, setOpenedDeepLinkShipmentId] = useState<string | null>(null);

  // AGENTS.md §2/§3: Validation fail-count tone band + SLA breach window
  // resolve strictly from canonical `route_plan_thresholds` (W48 + W34c policy
  // seed). No inline magic numbers in the validate-all panel or the SLA chip.
  const routePlanPolicy = useResolveSettings('route_plan_thresholds', undefined, readQueryOptions);
  const routePlanThresholds = routePlanPolicy.data?.value as
    | { fail_count_warn?: number; wave_promise_window_seconds?: number }
    | undefined;
  const failCountWarn = routePlanThresholds?.fail_count_warn;
  const wavePromiseWindowSeconds = routePlanThresholds?.wave_promise_window_seconds;
  const tenantSettingsScope = useMemo(
    () => (scope.tenant?.id ? { organization_id: scope.tenant.id } : undefined),
    [scope.tenant?.id],
  );
  const mapPolicy = useResolveSettings('map_policy', tenantSettingsScope, readQueryOptions);
  const mapPolicyValue = (mapPolicy.data?.value as MapPolicyValue | undefined) ?? null;
  const mapTileProvider = mapPolicyValue?.tile_provider ?? null;
  const mapDefaultViewport = mapPolicyValue?.default_viewport ?? null;

  const routePlansQuery = useResourceList<RoutePlanRow>('route_plans', undefined, readQueryOptions);
  const { data, isLoading } = routePlansQuery;
  // W24 — additive directory projection. The base `route_plans` read seam
  // remains the canonical SSOT; this read enriches the surface with the
  // canonical-resolved branch label, wave label, derived counters, and
  // applied-state through `v_route_plan_directory`.
  const planDirectoryQuery = useResourceList<RoutePlanDirectoryRow>(
    'route_plan_directory',
    undefined,
    readQueryOptions,
  );
  const planDirectoryById = useMemo(() => {
    const map = new Map<string, RoutePlanDirectoryRow>();
    for (const r of planDirectoryQuery.data?.rows ?? []) map.set(r.id, r);
    return map;
  }, [planDirectoryQuery.data]);
  const hubsQuery = useResourceList<HubRow>('hubs', undefined, readQueryOptions);
  const { data: hubsData } = hubsQuery;
  const routeRunsQuery = useResourceList<RouteRunPlanLinkRow>('route_runs', undefined, readQueryOptions);
  const { data: routeRunsData } = routeRunsQuery;
  const stopsQuery = useResourceList<{
    id: string; route_run_id: string; shipment_id: string; sequence_order: number; sla_tone?: string;
  }>('route_stops', undefined, readQueryOptions);
  const { data: stopsData } = stopsQuery;
  // CLAIM-OPERATIONS-WIRING (Phase C1) — wave catalog is row-driven.
  // Resolves through ui_list_resource_v1('wave_catalog'). Mounted at module
  // scope so the canonical resource fires at mount (asserted by
  // `route-plans.wave-catalog.test.tsx`); per-form rendering uses
  // `formWavePresets` (resolves through the same registry seam) so the
  // wave-preset control surfaces a loud error StateView when unseeded.
  useResourceList<WaveCatalogRow>('wave_catalog', {
    sort: { key: 'sort_order', dir: 'asc' },
  }, readQueryOptions);

  const createMutation = useCreateRoutePlan();
  const solveMutation = useSolveRoutePlan();
  const freezeMutation = useFreezeRoutePlan();
  const publishMutation = usePublishRoutePlan();
  const applyMutation = useApplyRoutePlan();
  const rebalanceMutation = useRebalanceRoutePlan();
  const validateMutation = useValidateRoutePlanConstraints();
  const activeTenantId = scope.tenant?.id ?? currentTenantId() ?? null;

  const rawRows = useMemo(() => data?.rows ?? [], [data]);
  const rows = useMemo<RoutePlanRow[]>(
    () =>
      rawRows.map((plan) => routePlanWithDirectory(plan, planDirectoryById.get(plan.id))),
    [rawRows, planDirectoryById],
  );
  const hubs = useMemo(() => hubsData?.rows ?? [], [hubsData]);
  const routeRuns = useMemo(() => routeRunsData?.rows ?? [], [routeRunsData]);
  const stops = useMemo(() => stopsData?.rows ?? [], [stopsData]);
  const routePlanReadError = routePlansQuery.isError
    ? routePlansQuery.error
    : planDirectoryQuery.isError
      ? planDirectoryQuery.error
      : hubsQuery.isError
        ? hubsQuery.error
        : routeRunsQuery.isError
          ? routeRunsQuery.error
          : stopsQuery.isError
            ? stopsQuery.error
            : null;

  function openValidateAllDrawer() {
    drawer.open({
      title: 'Validate constraints · all visible plans',
      size: 'md',
      body: (
        <ValidateAllPanel
          plans={rows}
          run={(planId) => validateMutation.mutateAsync(planId)}
          // Page-level guard ensures failCountWarn is non-null at render time.
          failCountWarn={failCountWarn as number}
        />
      ),
    });
  }

  function routeRunIdsForPlan(planId: string): Set<string> {
    return new Set(
      routeRuns
        .filter((run) => {
          const metadataPlanId =
            typeof run.metadata?.plan_id === 'string' ? run.metadata.plan_id : null;
          return run.route_plan_id === planId || run.plan_id === planId || metadataPlanId === planId;
        })
        .map((run) => run.id)
        .filter(Boolean),
    );
  }

  function stopsForPlan(plan: RoutePlanRow) {
    const planId = plan.id;
    const runIds = routeRunIdsForPlan(planId);
    const materializedStops = stops.filter((stop) => runIds.has(stop.route_run_id));
    return materializedStops.length > 0 ? materializedStops : plannedStopsFromRoutePlan(plan);
  }

  function openRoutePlanShipmentContext(shipmentId: string, fallbackShipment?: Partial<Shipment> | null) {
    modal.close();
    openShipmentContextDrawer(drawer, shipmentId, {
      fallbackShipment: fallbackShipment ?? null,
    });
  }

  function openNewPlanModal(focus?: RoutePlanDeepLinkFocus) {
    function NewPlanForm() {
      const today = new Date().toISOString().slice(0, 10);
      const focusShipmentId = stringOrNull(focus?.shipmentId);
      const focusShipmentQuery = useResourceRowsByIds<Shipment>(
        'shipments',
        focusShipmentId ? [focusShipmentId] : [],
        { enabled: Boolean(focusShipmentId) },
      );
      const focusShipment = focusShipmentQuery.data?.rows[0] ?? null;
      const focusPromisedDate = stringOrNull(focusShipment?.promised_delivery_date);
      // Re-subscribe to wave_catalog inside the form so the component
      // sees the latest registry data (the outer module may have read
      // an empty snapshot before the resource resolved). NO fallback —
      // when the canonical resource is unseeded, the wave control
      // surfaces a loud error StateView.
      const { data: formWaveCatalogData } = useResourceList<WaveCatalogRow>(
        'wave_catalog',
        { sort: { key: 'sort_order', dir: 'asc' } },
      );
      const formWavePresets: WaveCatalogRow[] = useMemo(
        () => (formWaveCatalogData?.rows ?? []).filter((w) => w.active !== false),
        [formWaveCatalogData],
      );
      const [hubId, setHubId] = useState<string>(hubs[0]?.id ?? '');
      // CLAIM-OPERATIONS-WIRING (Phase C1) — default waveId picks the first
      // active row from the canonical wave_catalog (no literal default).
      const [waveId, setWaveId] = useState<string>(() => formWavePresets[0]?.id ?? '');
      const [date, setDate] = useState<string>(today);
      const [pickerOpen, setPickerOpen] = useState<null | 'hub' | 'wave'>(null);
      const [focusDateApplied, setFocusDateApplied] = useState(false);
      const [focusCandidateApplied, setFocusCandidateApplied] = useState(false);
      const candidateOrganizationId = scope.tenant?.id ?? currentTenantId() ?? null;
      const candidateQuery = useRoutePlanDeliveryWaveCandidates({
        branchId: hubId,
        plannedDate: date,
        waveId,
        organizationId: candidateOrganizationId,
      });
      const allCandidateQuery = useRoutePlanDeliveryWaveCandidates({
        branchId: null,
        plannedDate: date,
        waveId,
        organizationId: candidateOrganizationId,
        enabled: hubs.length > 0 || Boolean(focusShipmentId),
      });
      const shipmentCandidates = useMemo(
        () => candidateQuery.data?.rows ?? [],
        [candidateQuery.data?.rows],
      );
      const allShipmentCandidates = useMemo(
        () => allCandidateQuery.data?.rows ?? [],
        [allCandidateQuery.data?.rows],
      );
      const refetchCandidateQuery = candidateQuery.refetch;
      const refetchAllCandidateQuery = allCandidateQuery.refetch;
      useEffect(() => {
        if (!focusShipmentId) return;
        void refetchCandidateQuery();
        void refetchAllCandidateQuery();
      }, [date, focusShipmentId, hubId, refetchAllCandidateQuery, refetchCandidateQuery, waveId]);
      const focusedCandidate = useMemo(
        () => {
          if (!focusShipmentId) return null;
          return [...allShipmentCandidates, ...shipmentCandidates].find((candidate) => {
            const candidateShipmentId = stringOrNull(candidate.shipment_id) ?? stringOrNull(candidate.id);
            return candidateShipmentId === focusShipmentId;
          }) ?? null;
        },
        [allShipmentCandidates, focusShipmentId, shipmentCandidates],
      );
      const displayedShipmentCandidates = useMemo(
        () => {
          if (!focusedCandidate) return shipmentCandidates;
          const focusedShipmentId = stringOrNull(focusedCandidate.shipment_id) ?? stringOrNull(focusedCandidate.id);
          if (!focusedShipmentId) return shipmentCandidates;
          const remainingCandidates = shipmentCandidates.filter((candidate) => {
            const candidateShipmentId = stringOrNull(candidate.shipment_id) ?? stringOrNull(candidate.id);
            return candidateShipmentId !== focusedShipmentId;
          });
          return [focusedCandidate, ...remainingCandidates];
        },
        [focusedCandidate, shipmentCandidates],
      );
      const focusedCandidateMissing = useMemo(
        () => focusedShipmentCandidateMissingReasons(focusShipment, focusPromisedDate),
        [focusPromisedDate, focusShipment],
      );
      const focusedCandidateUnavailable =
        Boolean(focusShipmentId) &&
        !focusedCandidate &&
        !focusShipmentQuery.isLoading &&
        !allCandidateQuery.isLoading &&
        !allCandidateQuery.isError;
      const candidateCountsByHub = useMemo(() => {
        const counts = new Map<string, number>();
        for (const candidate of allShipmentCandidates) {
          const branchId = stringOrNull(candidate.branch_id);
          if (!branchId) continue;
          counts.set(branchId, (counts.get(branchId) ?? 0) + 1);
        }
        return counts;
      }, [allShipmentCandidates]);
      const [selectedShipmentIds, setSelectedShipmentIds] = useState<Set<string>>(
        () => (focusShipmentId ? new Set([focusShipmentId]) : new Set()),
      );
      const [focusAutoSelectEnabled, setFocusAutoSelectEnabled] = useState(Boolean(focusShipmentId));
      const hub = hubs.find((h) => h.id === hubId);
      const wave = formWavePresets.find((w) => w.id === waveId);
      // Auto-select the first canonical wave once the resource resolves.
      useEffect(() => {
        if (!waveId && formWavePresets.length > 0) {
          setWaveId(formWavePresets[0]!.id);
        }
      }, [waveId, formWavePresets]);
      useEffect(() => {
        if (shipmentCandidates.length > 0 || candidateQuery.isLoading || candidateQuery.isError) return;
        const nextHubId = allShipmentCandidates.find((candidate) => {
          const branchId = stringOrNull(candidate.branch_id);
          return branchId && branchId !== hubId;
        })?.branch_id;
        if (typeof nextHubId === 'string' && nextHubId) {
          setHubId(nextHubId);
          setSelectedShipmentIds(focusShipmentId ? new Set([focusShipmentId]) : new Set());
        }
      }, [
        allShipmentCandidates,
        candidateQuery.isError,
        candidateQuery.isLoading,
        focusShipmentId,
        hubId,
        shipmentCandidates.length,
      ]);
      useEffect(() => {
        if (!focusShipmentId || focusDateApplied || !focusPromisedDate) return;
        setDate(focusPromisedDate.slice(0, 10));
        setSelectedShipmentIds(new Set([focusShipmentId]));
        setFocusCandidateApplied(false);
        setFocusDateApplied(true);
      }, [focusDateApplied, focusPromisedDate, focusShipmentId]);
      useEffect(() => {
        if (!focusShipmentId || focusCandidateApplied || allCandidateQuery.isLoading || allCandidateQuery.isError) return;
        if (focusPromisedDate && !focusDateApplied) return;
        if (!focusedCandidate) return;
        const candidateShipmentId = stringOrNull(focusedCandidate.shipment_id) ?? focusShipmentId;
        const candidateBranchId = stringOrNull(focusedCandidate.branch_id);
        if (candidateBranchId && candidateBranchId !== hubId) setHubId(candidateBranchId);
        setSelectedShipmentIds(new Set([candidateShipmentId]));
        setFocusCandidateApplied(true);
      }, [
        allCandidateQuery.isError,
        allCandidateQuery.isLoading,
        allShipmentCandidates,
        focusCandidateApplied,
        focusDateApplied,
        focusPromisedDate,
        focusShipmentId,
        focusedCandidate,
        hubId,
        shipmentCandidates,
      ]);
      useEffect(() => {
        if (!focusShipmentId || !focusedCandidateUnavailable) return;
        setSelectedShipmentIds((prev) => {
          if (!prev.has(focusShipmentId)) return prev;
          const next = new Set(prev);
          next.delete(focusShipmentId);
          return next;
        });
      }, [focusShipmentId, focusedCandidateUnavailable]);
      useEffect(() => {
        if (!focusAutoSelectEnabled || !focusShipmentId || !focusedCandidate || focusedCandidateUnavailable) return;
        const candidateShipmentId = stringOrNull(focusedCandidate.shipment_id) ?? focusShipmentId;
        setSelectedShipmentIds((prev) => {
          if (prev.has(candidateShipmentId)) return prev;
          return new Set([candidateShipmentId]);
        });
      }, [focusAutoSelectEnabled, focusShipmentId, focusedCandidate, focusedCandidateUnavailable]);
      // Strict guard: wave presets are sourced from the canonical
      // `wave_catalog` resource. The wave control surfaces a loud error
      // StateView when the resource is unseeded so operators cannot pick
      // a phantom wave (no fallback constants).
      const wavePresetsEmpty = formWavePresets.length === 0;
      const selectedStops = useMemo(
        () =>
          Array.from(selectedShipmentIds)
            .map((shipmentId) =>
              shipmentCandidates.find((candidate) => candidate.shipment_id === shipmentId) ??
              allShipmentCandidates.find((candidate) => {
                const candidateShipmentId = stringOrNull(candidate.shipment_id) ?? stringOrNull(candidate.id);
                return candidateShipmentId === shipmentId;
              }),
            )
            .filter((candidate): candidate is RoutePlanCandidateRow => candidate != null)
            .map((candidate, index) => routePlanStopFromCandidate(candidate, index))
            .filter((stop): stop is RoutePlanInputStop => stop != null),
        [allShipmentCandidates, selectedShipmentIds, shipmentCandidates],
      );

      function setPlanDate(nextDate: string) {
        setDate(nextDate);
        setSelectedShipmentIds(focusShipmentId ? new Set([focusShipmentId]) : new Set());
        setFocusCandidateApplied(false);
      }

      function toggleShipment(shipmentId: string) {
        if (focusShipmentId && shipmentId === focusShipmentId) {
          setFocusAutoSelectEnabled(false);
        }
        setSelectedShipmentIds((prev) => {
          const next = new Set(prev);
          if (next.has(shipmentId)) next.delete(shipmentId);
          else next.add(shipmentId);
          return next;
        });
      }

      function chooseHub(nextHubId: string) {
        setHubId(nextHubId);
        setSelectedShipmentIds(new Set());
      }

      function hubReadyCount(hubRow: HubRow): number {
        return candidateCountsByHub.get(hubRow.id) ?? 0;
      }

      function hubDisplay(hubRow: HubRow): string {
        const readyCount = hubReadyCount(hubRow);
        const base = `${hubRow.code} · ${hubRow.name}`;
        return readyCount > 0 ? `${base} · ${readyCount} ready` : base;
      }

      function hubSubLabel(hubRow: HubRow): string {
        const branchId = stringOrNull(hubRow.id);
        const branchToken = branchId ? `branch ${branchId.slice(0, 8)}` : 'branch pending';
        return `${hubRow.city ?? 'city pending'} · ${branchToken} · cutoff ${hubRow.cutoff_time}`;
      }

      const hubsForPicker = [...hubs].sort((a, b) => {
        const candidateDelta = hubReadyCount(b) - hubReadyCount(a);
        if (candidateDelta !== 0) return candidateDelta;
        return `${a.code} ${a.name}`.localeCompare(`${b.code} ${b.name}`);
      });

      // ReferencePicker's PickerSource is non-generic; we cast our typed rows
      // to the open record shape for the picker, and back inside display/value.
      const hubReference: Omit<ReferenceSource, 'kind'> = {
        items: hubsForPicker as unknown as Array<Record<string, unknown>>,
        display: (h) => hubDisplay(h as unknown as HubRow),
        value: (h) => (h as unknown as HubRow).id,
        sub: (h) => hubSubLabel(h as unknown as HubRow),
        section: 'Hubs',
      };
      const waveReference: Omit<ReferenceSource, 'kind'> = {
        items: formWavePresets as unknown as Array<Record<string, unknown>>,
        display: (w) => (w as unknown as { label: string }).label,
        value: (w) => (w as unknown as { id: string }).id,
        section: 'Waves',
      };

      return (
        <>
          <p className="state__hint">
            Creates a draft route plan. Use Solve, Freeze, Publish, and Apply after the
            plan is reviewed.
          </p>
          {focusShipmentId ? (
            <div className="card" style={{ marginBottom: '12px', display: 'grid', gap: '6px' }}>
              <Chip size="xs" kind="info" label="API shipment handoff" />
              <div className="mono">{focusShipment?.tracking_number ?? focusShipmentId}</div>
              <div className="state__hint">
                Route plans is reading the shipment and selecting it when it is eligible for the chosen date and hub.
              </div>
            </div>
          ) : null}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px', alignItems: 'center', padding: '4px 4px' }}>
            <label className="mono">Hub</label>
            <button
              type="button"
              className="dt-inline-input"
              style={{ textAlign: 'left' }}
              onClick={() => setPickerOpen('hub')}
              aria-label="Pick hub"
            >
              {hub ? hubDisplay(hub) : 'Pick hub…'}
            </button>
            <label className="mono">Wave</label>
            {wavePresetsEmpty ? (
              <StateView
                kind="error"
                title="Wave presets not configured"
                hint="Configure pickup and delivery wave presets before creating a new route plan."
              />
            ) : (
              <button
                type="button"
                className="dt-inline-input"
                style={{ textAlign: 'left' }}
                onClick={() => setPickerOpen('wave')}
                aria-label="Pick wave"
              >
                {wave?.label ?? 'Pick wave…'}
              </button>
            )}
            <label className="mono">Date</label>
            <input
              className="dt-inline-input"
              type="date"
              value={date}
              onChange={(e) => setPlanDate(e.target.value)}
              onInput={(e) => setPlanDate(e.currentTarget.value)}
              aria-label="Plan date"
            />
          </div>
          <div className="field" style={{ marginTop: '12px' }}>
            <label className="field__label">Shipments to plan ({selectedStops.length} selected)</label>
            {focusedCandidateUnavailable ? (
              <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
                <StateView
                  kind="error"
                  title="Focused API shipment is not route-ready"
                  hint={`Shipment ${focusShipment?.tracking_number ?? focusShipmentId} was found, but it is not in the route-plan candidate list yet. Missing: ${focusedCandidateMissing.join(', ')}.`}
                />
                <Button
                  size="sm"
                  kind="ghost"
                  iconName="eye"
                  label="Open shipment context"
                  capability={CAP.SHIPMENTS_READ}
                  onClick={() => {
                    if (!focusShipmentId) return;
                    openRoutePlanShipmentContext(
                      focusShipmentId,
                      routePlanShipmentContextFallback(
                        focusShipmentId,
                        focusShipment?.tracking_number,
                        focusShipment?.service_type ?? null,
                      ),
                    );
                  }}
                />
              </div>
            ) : null}
            {candidateQuery.isLoading ? (
              <StateView
                kind="loading"
                title="Loading route-plan candidates"
                hint="Reading eligible shipment candidates for this plan."
              />
            ) : candidateQuery.isError ? (
              <StateView
                kind="error"
                title="Candidate source unavailable"
                hint="No eligible shipment rows were returned for this plan."
              />
            ) : displayedShipmentCandidates.length === 0 ? (
              <StateView
                kind="error"
                title="No eligible route-plan candidates"
                hint={
                  focusShipmentId
                    ? 'The focused API shipment is not eligible for this hub/date yet. Confirm promised delivery date, branch, geocode, and service offering details.'
                    : 'No candidate shipments matched this hub and date selection.'
                }
              />
            ) : (
              <div
                className="dt"
                style={{
                  maxHeight: '260px',
                  overflow: 'auto',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                }}
              >
                <table className="dt__table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th aria-label="Select">{}</th>
                      <th>Candidate</th>
                      <th>Promise</th>
                      <th>Planning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedShipmentCandidates.map((candidate) => {
                      const shipmentId = candidate.shipment_id;
                      const candidateLabel = routePlanCandidateLabel(candidate);
                      const referenceLabel = routePlanShipmentReferenceLabel(shipmentId, candidate.tracking_number);
                      const checked = selectedShipmentIds.has(shipmentId);
                      return (
                        <tr key={shipmentId} className={checked ? 'is-selected' : undefined}>
                          <td className="dt-checkbox">
                            <input
                              type="checkbox"
                              aria-label={`Select candidate ${candidateLabel}`}
                              checked={checked}
                              onChange={() => toggleShipment(shipmentId)}
                            />
                          </td>
                          <td>
                            <Button
                              size="sm"
                              kind="ghost"
                              iconName="eye"
                              label={referenceLabel}
                              capability={CAP.SHIPMENTS_READ}
                              ariaLabel={`Open shipment context ${candidateLabel}`}
                              title={shipmentId}
                              onClick={() => {
                                openRoutePlanShipmentContext(
                                  shipmentId,
                                  routePlanShipmentContextFallback(
                                    shipmentId,
                                    candidate.tracking_number,
                                    candidate.service_level,
                                  ),
                                );
                              }}
                            />
                            <div className="state__hint">{routePlanCandidateSubLabel(candidate)}</div>
                          </td>
                          <td>
                            <div className="mono">{candidate.promised_delivery_date ?? 'date pending'}</div>
                            <div className="state__hint">{routePlanCandidateWindowLabel(candidate)}</div>
                          </td>
                          <td>
                            <Chip size="xs" kind="good" label={`eligible #${candidate.sequence_order ?? '-'}`} />
                            {candidate.priority_score != null ? (
                              <span className="state__hint" style={{ marginLeft: '6px' }}>
                                priority {candidate.priority_score}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel', 'Cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Create"
              kind="primary"
              capability={CAP.ROUTE_PLANS_WRITE}
              disabled={!hubId || !waveId || !date || selectedStops.length === 0 || wavePresetsEmpty || createMutation.isPending}
              onClick={async () => {
                try {
                  const res = await createMutation.mutateAsync({
                    ...(candidateOrganizationId ? { organization_id: candidateOrganizationId } : {}),
                    branch_id: hubId,
                    planned_date: date,
                    inputs: {
                      wave_id: waveId,
                      wave_label: wave?.label ?? null,
                      branch_code: hub?.code ?? null,
                      stops: selectedStops,
                    },
                    metadata: {
                      source: 'console_v2.route_plans.create',
                      wave_id: waveId,
                      wave_label: wave?.label ?? null,
                      selected_shipment_count: selectedStops.length,
                    },
                  });
                  modal.close();
                  pushToast(`Plan created · ${res.plan_id}`, 'good');
                } catch {
                  pushToast('Route plan could not be created. Try again.', 'danger');
                }
              }}
            />
          </div>

          {pickerOpen === 'hub' ? (
            <ReferencePicker
              open
              title="Hub"
              source={{ kind: 'reference', ...hubReference }}
              onClose={() => setPickerOpen(null)}
              onPick={(val) => {
                setPickerOpen(null);
                if (typeof val === 'string') chooseHub(val);
              }}
            />
          ) : null}
          {pickerOpen === 'wave' ? (
            <ReferencePicker
              open
              title="Wave"
              source={{ kind: 'reference', ...waveReference }}
              onClose={() => setPickerOpen(null)}
              onPick={(val) => {
                setPickerOpen(null);
                if (typeof val === 'string') setWaveId(val);
              }}
            />
          ) : null}
        </>
      );
    }
    modal.open({ title: 'New route plan', body: <NewPlanForm /> });
  }

  function lifecycleDisabledReasonForPlan(plan: RoutePlanRow): string | undefined {
    return routePlanTenantLifecycleDisabledReason(plan, activeTenantId);
  }

  function lifecycleDisabledReasonForSelectedPlans(plans: RoutePlanRow[]): string | undefined {
    return routePlanBulkTenantLifecycleDisabledReason(plans, activeTenantId);
  }

  function runIfRoutePlanLifecycleAllowed(
    plan: RoutePlanRow,
    run: () => void | Promise<void>,
  ): void | Promise<void> {
    const disabledReason = lifecycleDisabledReasonForPlan(plan);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    return run();
  }

  function runIfSelectedRoutePlansLifecycleAllowed(
    selectedPlans: RoutePlanRow[],
    run: () => void | Promise<void>,
  ): void | Promise<void> {
    const disabledReason = lifecycleDisabledReasonForSelectedPlans(selectedPlans);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    return run();
  }

  useEffect(() => {
    const syncFocusFromLocation = () => {
      const next = routePlanFocusFromBrowserLocation();
      setDeepLinkFocus((prev) => (prev.shipmentId === next.shipmentId ? prev : next));
    };
    window.addEventListener('popstate', syncFocusFromLocation);
    return () => window.removeEventListener('popstate', syncFocusFromLocation);
  }, []);

  useEffect(() => {
    if (!deepLinkFocus.shipmentId) {
      if (openedDeepLinkShipmentId) setOpenedDeepLinkShipmentId(null);
      return;
    }
    if (openedDeepLinkShipmentId === deepLinkFocus.shipmentId || !canRead || !canWrite) return;
    setOpenedDeepLinkShipmentId(deepLinkFocus.shipmentId);
    openNewPlanModal(deepLinkFocus);
  }, [canRead, canWrite, deepLinkFocus, openedDeepLinkShipmentId]);

  function openRebalanceModal(plan: RoutePlanRow) {
    const disabledReason = lifecycleDisabledReasonForPlan(plan);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    const targets = rows.filter(
      (p) => p.id !== plan.id && !lifecycleDisabledReasonForPlan(p) && routePlansShareOrganization(plan, p),
    );
    function RebalanceForm() {
      const formRouteRunsQuery = useResourceList<RouteRunPlanLinkRow>('route_runs', undefined, readQueryOptions);
      const formStopsQuery = useResourceList<{
        id: string; route_run_id: string; shipment_id: string; sequence_order: number; sla_tone?: string;
      }>('route_stops', undefined, readQueryOptions);
      const planStops = useMemo(() => {
        const formRouteRuns = formRouteRunsQuery.data?.rows ?? [];
        const formStops = formStopsQuery.data?.rows ?? [];
        const runIds = new Set(
          formRouteRuns
            .filter((run) => {
              const metadataPlanId =
                typeof run.metadata?.plan_id === 'string' ? run.metadata.plan_id : null;
              return run.route_plan_id === plan.id || run.plan_id === plan.id || metadataPlanId === plan.id;
            })
            .map((run) => run.id)
            .filter(Boolean),
        );
        const materializedStops = formStops.filter((stop) => runIds.has(stop.route_run_id));
        return materializedStops.length > 0 ? materializedStops : plannedStopsFromRoutePlan(plan);
      }, [formRouteRunsQuery.data?.rows, formStopsQuery.data?.rows, plan]);
      const [selected, setSelected] = useState<Set<string>>(new Set());
      const [targetPlanId, setTargetPlanId] = useState<string>(targets[0]?.id ?? '');
      const [pickerOpen, setPickerOpen] = useState(false);
      const target = targets.find((p) => p.id === targetPlanId);
      const targetDisabledReason = target
        ? lifecycleDisabledReasonForPlan(target) ??
          (routePlansShareOrganization(plan, target)
            ? undefined
            : "Pick a target route plan from this route plan's tenant.")
        : 'Pick a target route plan before rebalancing.';

      function toggle(id: string) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }

      const selectedShipmentIds = useMemo(
        () =>
          Array.from(selected)
            .map((stopId) => planStops.find((s) => s.id === stopId)?.shipment_id)
            .filter((shipmentId): shipmentId is string => typeof shipmentId === 'string' && shipmentId.length > 0),
        [selected, planStops],
      );
      const rebalanceInput: RoutePlanRebalanceInput = useMemo(
        () => ({
          source_route_plan_id: plan.id,
          target_route_plan_id: targetPlanId,
          shipment_ids: selectedShipmentIds,
          metadata: {
            source: 'console_v2.route_plans.rebalance',
          },
        }),
        [plan.id, targetPlanId, selectedShipmentIds],
      );
      const canSubmit =
        selected.size > 0 &&
        selectedShipmentIds.length === selected.size &&
        !!targetPlanId &&
        !targetDisabledReason &&
        !rebalanceMutation.isPending;

      // W38-OPERATIONS P2-3 closure — consume canonical
      // v_route_plan_directory projection in the rebalance target picker
      // (the drawer already consumed this at line 478; the modal previously
      // read legacy alias fields directly from RoutePlanRow). Pattern
      // matches the W24 closure already in shipments.tsx + the drawer body
      // here.
      const targetReference: Omit<ReferenceSource, 'kind'> = {
        items: targets as unknown as Array<Record<string, unknown>>,
        display: (p) => {
          const r = p as unknown as RoutePlanRow;
          const dir = planDirectoryById.get(r.id);
          const planLabel = dir?.plan_display_id ?? r.plan_id;
          const waveLabel = dir?.wave_label ?? r.wave_label;
          return `${planLabel} · ${waveLabel}`;
        },
        value: (p) => (p as unknown as RoutePlanRow).id,
        sub: (p) => {
          const r = p as unknown as RoutePlanRow;
          const dir = planDirectoryById.get(r.id);
          const status = dir?.status ?? r.status;
          const stops = dir?.stop_count ?? r.stops;
          const runs = dir?.run_count ?? r.runs;
          return `${status} · ${stops} stops · ${runs} runs`;
        },
        section: 'Plans',
      };

      return (
        <>
          <p className="state__hint">
            Move stops between plans. Affected plans return to planning state so they can
            be solved and published again.
          </p>
          <div className="field" style={{ marginTop: '10px' }}>
            <label className="field__label">Stops to move ({selected.size} selected)</label>
            <div
              className="dt"
              style={{
                maxHeight: '220px',
                overflow: 'auto',
                border: '1px solid var(--line)',
                borderRadius: '4px',
              }}
            >
              <table className="dt__table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th aria-label="Select">{}</th>
                    <th>#</th>
                    <th>Shipment</th>
                    <th>SLA</th>
                  </tr>
                </thead>
                <tbody>
                  {planStops.slice(0, 30).map((s) => {
                    const checked = selected.has(s.id);
                    const trackingNumber = routePlanStopShipmentTrackingNumber(s);
                    const referenceLabel = routePlanStopShipmentReferenceLabel(s);
                    return (
                      <tr key={s.id} className={checked ? 'is-selected' : undefined}>
                        <td className="dt-checkbox">
                          <input
                            type="checkbox"
                            aria-label={`Select stop ${s.shipment_id}`}
                            checked={checked}
                            onChange={() => toggle(s.id)}
                          />
                        </td>
                        <td className="mono">{s.sequence_order}</td>
                        <td>
                          <Button
                            size="sm"
                            kind="ghost"
                            iconName="eye"
                            label={referenceLabel}
                            capability={CAP.SHIPMENTS_READ}
                            ariaLabel={`Open shipment context ${s.shipment_id}`}
                            title={s.shipment_id}
                            onClick={() => {
                              openRoutePlanShipmentContext(
                                s.shipment_id,
                                routePlanShipmentContextFallback(s.shipment_id, trackingNumber, null),
                              );
                            }}
                          />
                        </td>
                        <td>
                          {(() => {
                            // W27 Cycle D — canonical `stop_sla_tone` lookup-driven
                            // tone resolution. Replaces the inline ternary
                            // (`at-risk` → warn / else → good) and the silent
                            // `|| '—'` fallback. Missing canonical row OR empty
                            // projection renders a danger-toned chip with
                            // `(missing)` marker so the operator sees the gap.
                            if (!s.sla_tone) {
                              return (
                                <Chip
                                  size="xs"
                                  kind="danger"
                                  label="stop_sla_tone/(empty) (missing)"
                                />
                              );
                            }
                            const slaRow = lookupRow('stop_sla_tone', s.sla_tone) as
                              | { label?: string; tone?: string }
                              | null;
                            if (!slaRow) {
                              return (
                                <Chip
                                  size="xs"
                                  kind="danger"
                                  label={`stop_sla_tone/${s.sla_tone} (missing)`}
                                />
                              );
                            }
                            return (
                              <Chip
                                size="xs"
                                kind={(slaRow.tone as 'good' | 'warn' | 'danger' | 'info' | 'neutral') ?? 'neutral'}
                                label={slaRow.label ?? s.sla_tone}
                              />
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="field" style={{ marginTop: '10px' }}>
            <label className="field__label">Move to plan</label>
            <button
              type="button"
              className="dt-inline-input"
              style={{ textAlign: 'left', width: '100%' }}
              onClick={() => setPickerOpen(true)}
              aria-label="Pick target plan"
            >
              {target ? `${target.plan_id} · ${target.wave_label}` : 'Pick target plan…'}
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel', 'Cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={`Rebalance · ${selectedShipmentIds.length} stop${selectedShipmentIds.length === 1 ? '' : 's'}`}
              kind="primary"
              capability={CAP.ROUTE_PLANS_WRITE}
              disabled={!canSubmit}
              title={!canSubmit ? targetDisabledReason : undefined}
              onClick={async () => {
                if (targetDisabledReason) {
                  pushToast(targetDisabledReason, 'warn');
                  return;
                }
                try {
                  const res = await rebalanceMutation.mutateAsync(rebalanceInput);
                  modal.close();
                  pushToast(`Rebalanced · ${res.moves_applied} moves applied`, 'good');
                } catch {
                  pushToast('Rebalance could not be completed. Try again.', 'danger');
                }
              }}
            />
          </div>
          {pickerOpen ? (
            <ReferencePicker
              open
              title="Target plan"
              source={{ kind: 'reference', ...targetReference }}
              onClose={() => setPickerOpen(false)}
              onPick={(val) => {
                setPickerOpen(false);
                if (typeof val === 'string') setTargetPlanId(val);
              }}
            />
          ) : null}
        </>
      );
    }
    modal.open({ title: `Rebalance ${plan.plan_id}`, body: <RebalanceForm /> });
  }

  function openPlanDrawer(plan: RoutePlanRow) {
    drawer.open({
      title: <RoutePlanDrawerTitle planId={plan.id} fallbackPlan={plan} />,
      size: 'lg',
      body: (
        <RoutePlanDrawerBody
          planId={plan.id}
          fallbackPlan={plan}
          mapTileProvider={mapTileProvider}
          mapDefaultViewport={mapDefaultViewport}
        />
      ),
      footer: (
        <RoutePlanDrawerFooter
          planId={plan.id}
          fallbackPlan={plan}
          onRebalance={openRebalanceModal}
        />
      ),
    });
  }

  const columns: Array<DataTableColumn<RoutePlanRow>> = [
    { key: 'plan_id', label: 'Plan', mono: true, sortable: true },
    { key: 'wave_label', label: 'Wave', sortable: true, filterable: true },
    { key: 'hub', label: 'Hub', sortable: true, filterable: true },
    { key: 'status', label: 'Status', lookup: 'route_plan_status', sortable: true, filterable: true },
    { key: 'stops', label: 'Stops', align: 'right', sortable: true },
    { key: 'runs', label: 'Runs', align: 'right', sortable: true },
    {
      key: 'sla',
      label: 'SLA',
      sortable: false,
      filterable: false,
      render: (_v, r) =>
        isSlaBreach(r, wavePromiseWindowSeconds) ? (
          <Chip size="xs" kind="warn" label="breach" />
        ) : (
          <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>
        ),
    },
    { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
  ];

  const pills: ReactNode[] = [
    // W56-C closure — `scopeType="tenant"` is the canonical resource-tier literal
    // (route_plans scope via current_user_org_id()). `scopeId` is identity-derived.
    // See shipments.tsx top-of-file ScopePill SSOT note.
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip key="count" size="xs" label={<span className="mono">{`${rows.length} plans`}</span>} />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="routePlans"
          eyebrow="Operate"
          titleAccent="Route"
          titlePlain="plans"
        />
        <StateView
          kind="denied"
          capability={CAP.ROUTE_PLANS_READ}
          hint="You do not have permission to view route plans."
        />
      </div>
    );
  }

  if (failCountWarn == null) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="routePlans"
          eyebrow="Operate"
          titleAccent="Route"
          titlePlain="plans"
        />
        <StateView
          kind="error"
          title="Route-plan thresholds are not configured"
          hint="The warning threshold for failed plans is missing. Finish route planning policy setup before using this surface."
        />
      </div>
    );
  }

  if (routePlanReadError) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="routePlans"
          eyebrow="Operate"
          titleAccent="Route"
          titlePlain="plans"
        />
        <StateView
          kind="error"
          title="Route-plan inventory failed"
          hint={routePlanReadErrorMessage(routePlanReadError)}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="routePlans"
        eyebrow="Operate"
        titleAccent="Route"
        titlePlain="plans"
        pills={pills}
        actions={[
          <Button
            key="validate"
            label="Validate constraints"
            iconName="check"
            kind="ghost"
            capability={CAP.ROUTE_PLANS_READ}
            onClick={openValidateAllDrawer}
          />,
          <Button
            key="new"
            label="New plan"
            iconName="plus"
            kind="primary"
            capability={CAP.ROUTE_PLANS_WRITE}
            onClick={() => openNewPlanModal()}
          />,
        ]}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<RoutePlanRow>
          columns={columns}
          rows={rows}
          viewKey="route_plans"
          entityKind="route_plan"
          onRowClick={openPlanDrawer}
          getRowClass={(r) => (isSlaBreach(r, wavePromiseWindowSeconds) ? 'is-risk' : undefined)}
          bulkActions={[
            {
              label: 'Solve sequence',
              icon: 'play',
              kind: 'primary',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (rs) => Boolean(lifecycleDisabledReasonForSelectedPlans(rs)),
              disabledReason: lifecycleDisabledReasonForSelectedPlans,
              onClick: async (rs) => {
                await runIfSelectedRoutePlansLifecycleAllowed(rs, async () => {
                  await runBulkRoutePlanAction(rs, {
                    complete: 'Solved',
                    partial: 'Solved partially',
                    failed: 'Solve failed',
                  }, (r) => solveMutation.mutateAsync(r.id));
                });
              },
            },
            {
              label: 'Freeze',
              icon: 'lock',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (rs) => Boolean(lifecycleDisabledReasonForSelectedPlans(rs)),
              disabledReason: lifecycleDisabledReasonForSelectedPlans,
              onClick: async (rs) => {
                await runIfSelectedRoutePlansLifecycleAllowed(rs, async () => {
                  await runBulkRoutePlanAction(rs, {
                    complete: 'Frozen',
                    partial: 'Frozen partially',
                    failed: 'Freeze failed',
                  }, (r) => freezeMutation.mutateAsync(r.id));
                });
              },
            },
            {
              label: 'Publish',
              icon: 'bolt',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (rs) => Boolean(lifecycleDisabledReasonForSelectedPlans(rs)),
              disabledReason: lifecycleDisabledReasonForSelectedPlans,
              onClick: async (rs) => {
                await runIfSelectedRoutePlansLifecycleAllowed(rs, async () => {
                  await runBulkRoutePlanAction(rs, {
                    complete: 'Published',
                    partial: 'Published partially',
                    failed: 'Publish failed',
                  }, (r) => publishMutation.mutateAsync(r.id));
                });
              },
            },
            {
              label: 'Apply',
              icon: 'check',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (rs) => Boolean(lifecycleDisabledReasonForSelectedPlans(rs)),
              disabledReason: lifecycleDisabledReasonForSelectedPlans,
              onClick: async (rs) => {
                await runIfSelectedRoutePlansLifecycleAllowed(rs, async () => {
                  await runBulkRoutePlanAction(rs, {
                    complete: 'Applied',
                    partial: 'Applied partially',
                    failed: 'Apply failed',
                  }, (r) => applyMutation.mutateAsync(r.id));
                });
              },
            },
          ]}
          rowActions={[
            { label: 'Open plan', icon: 'eye', onClick: openPlanDrawer },
            {
              label: 'Solve',
              icon: 'play',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (r) => Boolean(lifecycleDisabledReasonForPlan(r)),
              disabledReason: lifecycleDisabledReasonForPlan,
              onClick: async (r) => {
                await runIfRoutePlanLifecycleAllowed(r, async () => {
                  try {
                    await solveMutation.mutateAsync(r.id);
                    pushToast(`Solved · ${r.plan_id}`, 'good');
                  } catch {
                    pushToast('Solve could not be completed. Try again.', 'danger');
                  }
                });
              },
            },
            {
              label: 'Freeze',
              icon: 'lock',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (r) => Boolean(lifecycleDisabledReasonForPlan(r)),
              disabledReason: lifecycleDisabledReasonForPlan,
              onClick: async (r) => {
                await runIfRoutePlanLifecycleAllowed(r, async () => {
                  try {
                    const res = await freezeMutation.mutateAsync(r.id);
                    pushToast(
                      `Frozen · ${r.plan_id} · ${res.constraint_validation.fail_count} fails`,
                      res.constraint_validation.fail_count > 0 ? 'warn' : 'good',
                    );
                  } catch {
                    pushToast('Freeze could not be completed. Try again.', 'danger');
                  }
                });
              },
            },
            {
              label: 'Publish',
              icon: 'bolt',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (r) => Boolean(lifecycleDisabledReasonForPlan(r)),
              disabledReason: lifecycleDisabledReasonForPlan,
              onClick: async (r) => {
                await runIfRoutePlanLifecycleAllowed(r, async () => {
                  try {
                    const res = await publishMutation.mutateAsync(r.id);
                    pushToast(`Published · pack ${res.execution_pack_hash ?? '—'}`, 'good');
                  } catch {
                    pushToast('Publish could not be completed. Try again.', 'danger');
                  }
                });
              },
            },
            {
              label: 'Apply',
              icon: 'check',
              kind: 'primary',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (r) => Boolean(lifecycleDisabledReasonForPlan(r)),
              disabledReason: lifecycleDisabledReasonForPlan,
              onClick: async (r) => {
                await runIfRoutePlanLifecycleAllowed(r, async () => {
                  try {
                    const res = await applyMutation.mutateAsync(r.id);
                    pushToast(`Applied · ${res.runs_materialized} runs`, 'good');
                  } catch {
                    pushToast('Apply could not be completed. Try again.', 'danger');
                  }
                });
              },
            },
            {
              label: 'Rebalance…',
              icon: 'rotate',
              capability: CAP.ROUTE_PLANS_WRITE,
              disabled: (r) => Boolean(lifecycleDisabledReasonForPlan(r)),
              disabledReason: lifecycleDisabledReasonForPlan,
              onClick: openRebalanceModal,
            },
          ]}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

interface InfoCardProps { label: string; value: string }
function InfoCard({ label, value }: InfoCardProps) {
  return (
    <div className="card">
      <div className="eyebrow">{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '20px', letterSpacing: '-0.018em', marginTop: '4px' }}>
        {value}
      </div>
    </div>
  );
}

function ExecutionPackPanel({ planId, enabled }: { planId: string; enabled: boolean }) {
  const pack = useRoutePlanExecutionPack(planId, enabled);
  if (!enabled) {
    return (
      <div className="card mono" style={{ marginTop: '14px', fontSize: '11px', color: 'var(--ink-3)' }}>
        execution pack available after publish
      </div>
    );
  }
  if (pack.isLoading) {
    return (
      <div style={{ marginTop: '14px' }}>
        <StateView kind="loading" />
      </div>
    );
  }
  if (pack.isError) {
    return (
      <div style={{ marginTop: '14px' }}>
        <StateView kind="error" hint={(pack.error as Error)?.message ?? 'execution pack read failed'} />
      </div>
    );
  }
  const data = pack.data;
  if (!data) {
    return (
      <div className="card mono" style={{ marginTop: '14px', fontSize: '11px', color: 'var(--danger-ink)' }}>
        No execution package is available for this route plan yet.
      </div>
    );
  }
  return (
    <div className="card mono" style={{ marginTop: '14px', fontSize: '11px', lineHeight: 1.6 }}>
      <SeamLine k="Pack" v={data.execution_pack_hash ?? 'missing hash'} />
      <SeamLine k="Stops" v={String(data.stop_count ?? 0)} />
      <SeamLine k="Shipments" v={String(data.shipment_count ?? 0)} />
    </div>
  );
}

interface SeamLineProps { k: string; v: string }
function SeamLine({ k, v }: SeamLineProps) {
  return (
    <div style={{ display: 'flex', gap: '8px', padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--ink-3)', minWidth: '90px', fontSize: '10.5px' }}>{k}</span>
      <span style={{ color: 'var(--ink)' }}>{v}</span>
    </div>
  );
}

// Per-plan validation result panel — calls route_plan_validate_constraints_v1
// and renders the items[] array with status dots.
interface PlanValidatePanelProps {
  planId: string;
  run: (planId: string) => Promise<{ items: RoutePlanConstraintCheck[]; fail_count: number }>;
}
function PlanValidatePanel({ planId, run }: PlanValidatePanelProps) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; items: RoutePlanConstraintCheck[]; fail_count: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function handleRun() {
    setState({ kind: 'loading' });
    try {
      const res = await run(planId);
      setState({ kind: 'ready', items: res.items, fail_count: res.fail_count });
    } catch {
      setState({ kind: 'error', message: 'Constraint check could not be completed. Try again.' });
    }
  }

  if (state.kind === 'idle') {
    return (
      <div>
        <p className="state__hint">Run the validator to see driver/vehicle/window/hub policy results.</p>
        <Button
          label="Run validation"
          iconName="check"
          kind="ghost"
          capability={CAP.ROUTE_PLANS_READ}
          onClick={handleRun}
        />
      </div>
    );
  }
  if (state.kind === 'loading') {
    return <StateView kind="loading" />;
  }
  if (state.kind === 'error') {
    return <StateView kind="error" hint={state.message} />;
  }
  return (
    <div className="card" style={{ marginTop: '8px' }}>
      {state.items.map((c) => {
        // CYCLE-E2 STRICT-ISOLATION (P2 #5) — chip tone resolves through the
        // canonical `constraint_check_status` lookup row (no inline ternary
        // over status literals). Render `(missing)` marker when the row is
        // absent so the operator surface is fail-loud.
        const row = lookupRow('constraint_check_status', c.status);
        const dotKind: DotKind = ((row?.tone as DotKind | undefined) ?? 'danger');
        return (
          <div
            key={c.name}
            style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--line)' }}
          >
            <Dot kind={dotKind} />
            <span style={{ flex: 1 }}>
              {c.name}
              {!row ? (
                <span className="mono" style={{ marginLeft: '6px', color: 'var(--danger-ink)' }}>
                  (missing)
                </span>
              ) : null}
            </span>
            <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
              {c.passed} pass · {c.failed} fail
            </span>
          </div>
        );
      })}
      {state.fail_count > 0 ? (
        <div className="card" style={{ background: 'var(--warn-soft)', marginTop: '10px' }}>
          <div className="mono" style={{ fontSize: '10.5px', color: 'var(--warn-ink)' }}>
            {state.fail_count} WARNING{state.fail_count === 1 ? '' : 'S'}
          </div>
          <div style={{ fontSize: '12px', marginTop: '4px' }}>
            {state.items.filter((i) => i.detail).map((i) => i.detail).join(' · ')}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Page-level "Validate all visible plans" panel — runs the validator across
// each row and shows a compact aggregate result. Fail-fast: bubbles the first
// failure into a danger toast and stops further runs.
interface ValidateAllPanelProps {
  plans: RoutePlanRow[];
  run: (planId: string) => Promise<{ fail_count: number }>;
  failCountWarn: number;
}
function ValidateAllPanel({ plans, run, failCountWarn }: ValidateAllPanelProps) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running'; current: number }
    | { kind: 'ready'; results: Array<{ plan_id: string; fail_count: number }> }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function handleRun() {
    setState({ kind: 'running', current: 0 });
    const out: Array<{ plan_id: string; fail_count: number }> = [];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      setState({ kind: 'running', current: i });
      try {
        const res = await run(p.id);
        out.push({ plan_id: p.plan_id, fail_count: res.fail_count });
      } catch {
        setState({ kind: 'error', message: 'Constraint checks could not be completed. Try again.' });
        return;
      }
    }
    setState({ kind: 'ready', results: out });
  }

  if (state.kind === 'idle') {
    return (
      <div>
        <p className="state__hint">
          Checks capacity, skill, and service-window constraints for each visible plan.
        </p>
        <Button
          label={`Run validation · ${plans.length} plans`}
          iconName="check"
          kind="primary"
          onClick={handleRun}
        />
      </div>
    );
  }
  if (state.kind === 'running') {
    return (
      <div>
        <p className="state__hint">Validating {state.current + 1}/{plans.length}…</p>
        <StateView kind="loading" />
      </div>
    );
  }
  if (state.kind === 'error') {
    return <StateView kind="error" hint={state.message} />;
  }
  const totalFails = state.results.reduce((acc, r) => acc + r.fail_count, 0);
  return (
    <div className="card" style={{ marginTop: '8px' }}>
      <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)', marginBottom: '6px' }}>
        Total fails across {state.results.length} plans: {totalFails}
      </div>
      {state.results.map((r) => (
        <div
          key={r.plan_id}
          style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', borderBottom: '1px solid var(--line)' }}
        >
          <Dot kind={r.fail_count === 0 ? 'good' : r.fail_count <= failCountWarn ? 'warn' : 'danger'} />
          <span className="mono" style={{ flex: 1, fontSize: '11px' }}>{r.plan_id}</span>
          <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{r.fail_count} fails</span>
        </div>
      ))}
    </div>
  );
}

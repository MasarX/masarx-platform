// dispatch.tsx — Operator Dispatch Canvas (3-pane: runs / stops / insight rail).
//
// Backed by:
//   - public.route_runs / route_run_assignments (202604061430)
//   - public.route_stops                          (202601231130)
//   - public.vehicles + vehicle_assignments       (202601231000)
//   - api.ui_execute_route_stop_reassign_v1       (202604101715)
//   - api.ui_execute_route_run_assign_v1          (202604061430)
//   - api.ui_confirm_route_run_departure_v1       (202604101500)
//   - public.route_run_scan_out_reconciliation_v1 (202604101500)
//   - resolve_settings('route_assignment_policy') (ladder; resolve_settings_merged)
//
// All mutations go through TanStack Query mutation hooks (cache invalidation,
// retry policy, devtools), never directly through `api.*`.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { LadderViz } from '@/components/LadderViz';
import { PageHeader } from '@/components/PageHeader';
import { KPICard } from '@/components/KPICard';
import { Icon } from '@/components/Icon';
import { StateView } from '@/components/StateView';
import { Dot } from '@/components/Dot';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { ReferencePicker, type ReferenceSource } from '@/components/ReferencePicker';
import {
  RouteStopMap,
  type RouteStopMapGeocode,
  type RouteStopMapTileProvider,
} from '@/components/RouteStopMap';
import {
  OpsScannerPanel,
  type OpsScannerCandidate,
  type OpsScannerMatch,
  type OpsScannerNoMatch,
} from '@/components/OpsScannerPanel';
import {
  openShipmentContextDrawer,
  type Shipment,
} from '@/modules/operate/shipments';
import {
  useDashboardKpis,
  useCompleteResourceList,
  useResource,
  useResourceListsByFilters,
  useResourceRowsByIds,
  useResolveSettings,
  useExecuteRouteStopReassign,
  useExecuteRouteRunAssign,
  useExecuteRouteRunAssignmentResponse,
  useConfirmRouteRunDeparture,
  useReconcileRouteRunScanOut,
  useTransitionTask,
  useScanEvent,
  useResolveMobilePolicy,
  qk,
} from '@/lib/queries';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useCapability, useIdentity } from '@/lib/identity';
import { englishT, fill, useI18n, type Translate } from '@/lib/i18n';
import {
  getCommandRegistry,
  getLookups,
  lookupRow,
  ui_get_resource_v1,
  ui_list_resource_complete,
  type RouteRunAssignmentResponseParams,
  type RouteRunAssignTarget,
  type RouteStopReassignTarget,
} from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { readUrlParam } from '@/lib/url-params';
import { registerConsoleProofArtifact } from '@/lib/proof-artifacts';

// W14-1 (OPERATIONS schema-drift cascade closeout) — RouteRunRow + RouteStopRow
// now mirror the canonical `public.route_runs` and `public.route_stops`
// columns exactly (no FE-invented fields). Backend SSOT:
//   • public.route_runs   · supabase/migrations/202601231130_route_runs_foundation_v1.sql:70-99
//   • public.route_stops  · supabase/migrations/202601231130_route_runs_foundation_v1.sql:192-219
//
// Per __audit__/SCHEMA-DRIFT/OPERATIONS.md §2-§3, the FE previously aliased:
//   - run_id (REMOVE; canonical PK is `id`)
//   - driver / vehicle (RENAME → driver_user_id / vehicle_id; the latter are uuid FKs)
//   - stops / completed (REMOVE; computed by counting route_stops)
//   - sla / eta / partner / risk / risk_note / cod_total (REMOVE; fictional)
//   - recipient_name / district / cod_amount (REMOVE; resolve via shipments / addresses)
//   - sla_tone / status / conflict / tags (REMOVE; computed/fictional)
//   - window_start / window_end (RENAME → planned_window_*_at)
//
// Display values that previously came from these aliases now derive via:
//   - Driver display name → `drivers` resource lookup keyed by driver_user_id.
//   - Vehicle plate display → `vehicles` resource lookup keyed by vehicle_id.
//   - Partner status → `route_run_assignments.assignment_mode === 'partner_fleet'`
//     (canonical assignment SSOT, already wired via runAssignQuery).
//   - Stop counts → useMemo aggregation over route_stops (per route_run_id).
//   - COD float → useMemo aggregation over shipments table joined by stop.shipment_id.
//   - Risk / risk_note → derived from the active route_run_assignment_events
//     ledger (cancelled / handoff transitions surface a tone) and not part of
//     the run row contract anymore.
interface RouteRunRow extends Record<string, unknown> {
  id: string;
  organization_id?: string;
  branch_id?: string | null;
  driver_user_id?: string | null;
  vehicle_id?: string | null;
  status: string;
  planned_date?: string | null;
  planned_start_at?: string | null;
  planned_end_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface RouteStopRow extends Record<string, unknown> {
  id: string;
  organization_id?: string;
  route_run_id: string;
  client_id?: string;
  shipment_id: string;
  stop_kind?: string;
  sequence_order: number;
  planned_window_start_at?: string | null;
  planned_window_end_at?: string | null;
  load_scan_count?: number | string | null;
  load_scan_status?: string | null;
  last_load_scanned_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

// OPERATIONS REAUDIT D4 (W9-4) — three new row contracts mirror the canonical
// table shape exactly (no FE-invented fields). Backend SSOT:
//   • public.route_run_assignments         · 202604061430:49
//   • public.route_run_assignment_events   · 202604061430:173
//   • public.route_stop_reassignment_events · 202604101715:274
interface RouteRunAssignmentRow extends Record<string, unknown> {
  id: string;
  route_run_id: string;
  assignment_status: string;
  assignment_mode: string;
  driver_user_id: string | null;
  vehicle_id: string | null;
  partner: { partner_id?: string | null; partner_name?: string | null } | null;
  assignment_version: number;
  assigned_at: string;
  responded_by_user_id?: string | null;
  acknowledged_at?: string | null;
  accepted_at?: string | null;
  refused_at?: string | null;
  refusal_reason?: string | null;
  response_notes?: string | null;
  response_metadata?: Record<string, unknown>;
}
interface RouteRunAssignmentEventRow extends Record<string, unknown> {
  id: string;
  route_run_id: string;
  assignment_version: number;
  event_type: string;
  from_status: string | null;
  to_status: string;
  assignment_mode: string;
  actor_user_id: string | null;
  notes: string | null;
  created_at: string;
}
interface ScanOutGateSnapshot {
  runId: string;
  status: 'clear' | 'blocked';
  expected: number;
  scanned: number;
  discrepancies: string[];
  checkedAt: string;
  fingerprint: string;
}

interface DispatchRefreshSnapshot {
  runs: RouteRunRow[];
  stops: RouteStopRow[];
  runDirectory: RouteRunDirectoryRow[];
  runAssignments: RouteRunAssignmentRow[];
  runAssignmentEvents: RouteRunAssignmentEventRow[];
  routeStopTasks: RouteStopTaskRow[];
  activeRouteStopTasks: RouteStopTaskRow[];
}

export function routeStopLoadScanStatus(
  stop: Pick<RouteStopRow, 'load_scan_count' | 'load_scan_status' | 'last_load_scanned_at'>,
  t: Translate = englishT,
): { label: string; tone: ChipKind; detail: string | null } {
  const count = Number(stop.load_scan_count ?? 0);
  const rawStatus = String(stop.load_scan_status ?? '').trim().toLowerCase();
  const last = stop.last_load_scanned_at
    ? new Date(stop.last_load_scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  if (rawStatus.includes('duplicate')) {
    return { label: count > 1 ? fill(t('dispatch.loadScan.duplicateCount'), { n: count }) : t('dispatch.loadScan.duplicate'), tone: 'warn', detail: last };
  }
  if (rawStatus.includes('scanned') || rawStatus.includes('clear') || count > 0) {
    return { label: count > 1 ? fill(t('dispatch.loadScan.scannedCount'), { n: count }) : t('dispatch.loadScan.scanned'), tone: 'good', detail: last };
  }
  if (rawStatus.includes('unexpected')) {
    return { label: t('dispatch.loadScan.unexpected'), tone: 'danger', detail: last };
  }
  return { label: t('dispatch.loadScan.missing'), tone: 'neutral', detail: null };
}

export function routeStopDeliveryOption(
  stop: Pick<RouteStopRow, 'metadata'>,
  t: (path: string, fallback?: string) => string,
): { label: string; tone: ChipKind; instruction: string | null } | null {
  const option = objectRecord(stop.metadata?.recipient_delivery_option);
  if (option?.option === 'branch_pickup') {
    return { label: t('deliveryOption.branchPickup', 'Branch pickup'), tone: 'warn', instruction: null };
  }
  if (option?.option !== 'safe_place') return null;
  const place = nonBlankText(option.place) ?? 'other';
  return {
    label: t('deliveryOption.safePlace', 'Safe place: {place}').replace('{place}', t(`deliveryOption.place.${place}`, place)),
    tone: 'info',
    instruction: place === 'other' ? nonBlankText(option.instruction) ?? null : null,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function routeStopCloseoutActionMatches(row: Record<string, unknown>, stopId: string): boolean {
  const actionData = objectRecord(row.action_data);
  const metadata = objectRecord(row.metadata) ?? actionData;
  const taskPayload = objectRecord(row.task_event_payload);
  const deliveryCompletion =
    objectRecord(row.delivery_completion) ??
    objectRecord(row.route_stop_completion) ??
    objectRecord(actionData?.delivery_completion) ??
    objectRecord(actionData?.route_stop_completion) ??
    objectRecord(metadata?.delivery_completion) ??
    objectRecord(metadata?.route_stop_completion) ??
    objectRecord(taskPayload?.delivery_completion) ??
    objectRecord(taskPayload?.route_stop_completion) ??
    objectRecord(taskPayload?.delivery_attempt);
  const routeStopId =
    String(row.route_stop_id ?? '').trim() ||
    String(deliveryCompletion?.route_stop_id ?? '').trim() ||
    String(actionData?.route_stop_id ?? '').trim() ||
    String(taskPayload?.route_stop_id ?? '').trim();
  return routeStopId === stopId && Boolean(deliveryCompletion);
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function routeStopPodProofRequirements(policyValue: unknown, t: Translate = englishT): {
  photoRequired: boolean;
  signatureRequired: boolean;
  otpRequired: boolean;
  identityRequired: boolean;
  minArtifactCount: number;
  label: string;
} {
  const policy = objectRecord(policyValue);
  const requirements = objectRecord(objectRecord(policy?.requirements)?.completed);
  const photoRequired = booleanValue(requirements?.photo_required ?? requirements?.photo) ?? false;
  const signatureRequired = booleanValue(requirements?.signature_required ?? requirements?.signature) ?? false;
  const otpRequired = booleanValue(requirements?.otp_required ?? requirements?.otp) ?? false;
  const identityRequired = booleanValue(requirements?.identity_confirmation_required) ?? false;
  const minArtifactCount = numberValue(requirements?.min_artifact_count);
  const labels = [
    photoRequired ? t('dispatch.pod.photo') : null,
    signatureRequired ? t('dispatch.pod.signature') : null,
    otpRequired ? t('dispatch.pod.otp') : null,
    identityRequired ? t('dispatch.pod.identity') : null,
    minArtifactCount > 0
      ? fill(t(minArtifactCount === 1 ? 'dispatch.pod.artifactOne' : 'dispatch.pod.artifactOther'), { n: minArtifactCount })
      : null,
  ].filter(Boolean);
  return {
    photoRequired,
    signatureRequired,
    otpRequired,
    identityRequired,
    minArtifactCount,
    label: labels.length
      ? fill(t('dispatch.pod.requires'), { list: labels.join(t('dispatch.listSeparator')) })
      : t('dispatch.pod.none'),
  };
}

interface RouteStopReassignEventRow extends Record<string, unknown> {
  id: string;
  route_stop_id: string;
  shipment_id: string;
  source_route_run_id: string;
  target_route_run_id: string;
  event_type: string;
  actor_user_id: string | null;
  notes: string | null;
  created_at: string;
}

// W24 — Paired projection view `public.v_route_run_directory`
// (supabase/migrations/202604302240_v_route_run_directory.sql). Read-only
// canonical SSOT for the FE-shaped derived projections (run_display_id,
// branch_label / branch_code / branch_type, driver_label, vehicle_label,
// stop_count + cod_total derived counters, assignment_status /
// assignment_mode / assignment_version / partner_name / is_partner_run
// from the active route_run_assignments row). The base `RouteRunRow` row
// interface keeps canonical SSOT columns; this directory enriches the
// surface through `useResourceList<RouteRunDirectoryRow>('route_run_directory')`
// so production cutover is a single getSupabaseClient() branch flip — the
// in-memory aggregations below remain a graceful fallback when the
// projection query has not resolved yet.
export interface RouteRunDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  branch_id?: string | null;
  driver_user_id?: string | null;
  vehicle_id?: string | null;
  status?: string | null;
  planned_date?: string | null;
  planned_start_at?: string | null;
  planned_end_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  run_display_id?: string | null;
  branch_label?: string | null;
  branch_code?: string | null;
  branch_type?: string | null;
  driver_label?: string | null;
  vehicle_label?: string | null;
  stop_count?: number;
  cod_total?: number;
  assignment_id?: string | null;
  assignment_status?: string | null;
  assignment_mode?: string | null;
  assignment_version?: number | null;
  assignment_assigned_at?: string | null;
  assignment_driver_user_id?: string | null;
  assignment_vehicle_id?: string | null;
  partner_payload?: Record<string, unknown> | null;
  partner_name?: string | null;
  is_partner_run?: boolean;
}

export function dispatchRunDriverLabel(
  directory: RouteRunDirectoryRow | undefined,
  run: Pick<RouteRunRow, 'driver_user_id'> | undefined,
  driverDisplayName: (id: string | null | undefined) => string,
): string {
  const directoryLabel = String(directory?.driver_label ?? '').trim();
  if (directoryLabel) return directoryLabel;
  return driverDisplayName(run?.driver_user_id ?? directory?.driver_user_id ?? directory?.assignment_driver_user_id ?? null);
}

function nonBlankText(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

const ALTERNATE_CAPACITY_ASSIGNMENT_MODE = 'alternate_capacity_pool';

interface RouteRunAlternateCapacityRequest {
  demandClass?: string;
  marketplaceRequestId: string;
}

export function routeRunAlternateCapacityRequest(
  run: Pick<RouteRunRow, 'metadata'> | null | undefined,
): RouteRunAlternateCapacityRequest | null {
  const metadata = run?.metadata;
  const alternateCapacity =
    metadata && typeof metadata === 'object' ? metadata.alternate_capacity : null;
  if (!alternateCapacity || typeof alternateCapacity !== 'object') return null;
  const raw = alternateCapacity as Record<string, unknown>;
  const marketplaceRequestId = nonBlankText(raw.marketplace_request_id);
  if (!marketplaceRequestId) return null;
  return {
    marketplaceRequestId,
    demandClass: nonBlankText(raw.demand_class),
  };
}

export function routeRunAssignmentModeIsPartner(mode: unknown): boolean {
  const normalized = nonBlankText(mode);
  return normalized ? lookupRow('route_assignment_mode', normalized)?.metadata?.is_partner === true : false;
}

type RouteAssignmentResponseAction =
  | 'route_runs.acknowledge_assignment'
  | 'route_runs.accept_assignment'
  | 'route_runs.refuse_assignment';

interface CommandRegistryRow extends Record<string, unknown> {
  key: string;
  label?: string;
}

function commandLabel(key: string, fallback: string): string {
  const registry = getCommandRegistry() as CommandRegistryRow[] | { commands?: CommandRegistryRow[] };
  const rows = Array.isArray(registry) ? registry : Array.isArray(registry?.commands) ? registry.commands : [];
  return rows.find((row) => row.key === key)?.label ?? fallback;
}

function routeAssignmentResponseActionLabel(action: RouteAssignmentResponseAction, t: Translate = englishT): string {
  switch (action) {
    case 'route_runs.acknowledge_assignment':
      return commandLabel(action, t('dispatch.responseAction.acknowledge'));
    case 'route_runs.accept_assignment':
      return commandLabel(action, t('dispatch.responseAction.accept'));
    case 'route_runs.refuse_assignment':
      return commandLabel(action, t('dispatch.responseAction.refuse'));
    default:
      return action;
  }
}

function routeAssignmentExpectedStatus(action: RouteAssignmentResponseAction): string {
  switch (action) {
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

function routeAssignmentResponseActions(
  status: string | null | undefined,
): RouteAssignmentResponseAction[] {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'assigned') {
    return ['route_runs.acknowledge_assignment', 'route_runs.refuse_assignment'];
  }
  if (normalized === 'acknowledged') {
    return ['route_runs.accept_assignment', 'route_runs.refuse_assignment'];
  }
  return [];
}

export function routeRunAssignmentResponseIsVisibleInDispatch(
  runId: string,
  expectedStatus: string,
  assignments: Array<Pick<RouteRunAssignmentRow, 'route_run_id' | 'assignment_status'>>,
  events: Array<Pick<RouteRunAssignmentEventRow, 'route_run_id' | 'to_status' | 'event_type'>>,
): boolean {
  const normalized = expectedStatus.toLowerCase();
  return assignments.some((assignment) =>
    assignment.route_run_id === runId &&
    String(assignment.assignment_status ?? '').toLowerCase() === normalized,
  ) && events.some((event) =>
    event.route_run_id === runId &&
    (
      String(event.to_status ?? '').toLowerCase() === normalized ||
      String(event.event_type ?? '').toLowerCase() === normalized
    ),
  );
}

export function routeStopReassignOwnerTargetForRun(
  run: Pick<RouteRunRow, 'driver_user_id' | 'vehicle_id'> | null | undefined,
  assignment?: Pick<RouteRunAssignmentRow, 'assignment_mode' | 'driver_user_id' | 'vehicle_id' | 'partner'> | null,
  directory?: Pick<
    RouteRunDirectoryRow,
    | 'assignment_mode'
    | 'assignment_driver_user_id'
    | 'assignment_vehicle_id'
    | 'driver_user_id'
    | 'vehicle_id'
    | 'partner_payload'
    | 'partner_name'
  > | null,
): RouteStopReassignTarget | null {
  const partnerPayload =
    assignment?.partner && typeof assignment.partner === 'object'
      ? assignment.partner
      : directory?.partner_payload && typeof directory.partner_payload === 'object'
        ? directory.partner_payload
        : null;
  const assignmentMode = nonBlankText(assignment?.assignment_mode ?? directory?.assignment_mode);
  const partnerByLookup = routeRunAssignmentModeIsPartner(assignmentMode);
  const partnerId = nonBlankText(partnerPayload?.partner_id);
  const partnerName = nonBlankText(partnerPayload?.partner_name ?? directory?.partner_name);
  if (partnerByLookup || partnerId || partnerName) {
    const partnerTarget: RouteStopReassignTarget = {};
    if (partnerId) partnerTarget.partner_id = partnerId;
    if (partnerName) partnerTarget.partner_name = partnerName;
    return partnerTarget.partner_id || partnerTarget.partner_name ? partnerTarget : null;
  }

  const driverId = nonBlankText(
    assignment?.driver_user_id ??
      directory?.assignment_driver_user_id ??
      run?.driver_user_id ??
      directory?.driver_user_id,
  );
  if (!driverId) return null;
  const driverTarget: RouteStopReassignTarget = { driver_user_id: driverId };
  const vehicleId = nonBlankText(
    assignment?.vehicle_id ??
      directory?.assignment_vehicle_id ??
      run?.vehicle_id ??
      directory?.vehicle_id,
  );
  if (vehicleId) driverTarget.vehicle_id = vehicleId;
  return driverTarget;
}

function routeStopReassignResultTargetRunId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const direct = nonBlankText(record.target_route_run_id);
  if (direct) return direct;
  const items = Array.isArray(record.items) ? record.items : [];
  const first = items[0];
  if (!first || typeof first !== 'object') return null;
  return nonBlankText((first as Record<string, unknown>).target_route_run_id) ?? null;
}

// W14-1 — sibling resource row shapes used for FE-side projection joins. Keep
// these `Record<string, unknown>`-extensions narrow: they only declare the
// fields we read here, so they tolerate the canonical column expansion.
interface DriverLookupRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  name?: string;
  driver_code?: string | null;
  phone?: string | null;
  user_email?: string | null;
  status?: string | null;
  vehicle_id?: string;
}
interface VehicleLookupRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  plate?: string;
  plate_number?: string | null;
  code?: string;
  status?: string | null;
  vehicle_type_label?: string | null;
  type_name?: string | null;
}
interface ShipmentCodLookupRow extends Record<string, unknown> {
  id: string;
  tracking_number?: string | null;
  status?: string | null;
  service_type?: string | null;
  destination_address_id?: string | null;
  address_id?: string | null;
  recipient_address_id?: string | null;
  cod_amount?: number | null;
  cod_currency?: string | null;
}

function shipmentAddressIdForDispatchMap(shipment: ShipmentCodLookupRow | undefined): string | null {
  return (
    nonBlankText(shipment?.destination_address_id) ??
    nonBlankText(shipment?.address_id) ??
    nonBlankText(shipment?.recipient_address_id) ??
    null
  );
}

interface BasketLookupRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  basket_type?: string | null;
  state?: string | null;
  current_count?: number | string | null;
  capacity_count?: number | string | null;
  barcode?: string | null;
  code?: string | null;
  label?: string | null;
}
interface BasketItemLookupRow extends Record<string, unknown> {
  id: string;
  basket_id: string;
  shipment_id: string;
  removed_at?: string | null;
}
interface RouteStopTaskRow extends Record<string, unknown> {
  id: string;
  task_id?: string;
  task_type?: string;
  task_type_key?: string;
  resource_type?: string;
  resource_id?: string;
  shipment_id?: string;
  status?: string;
  status_reason?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown>;
}

export function isDriverAssignableToRouteRun(
  driver: { organization_id?: string | null; status?: string | null },
  run: { organization_id?: string | null } | null | undefined,
  activeTenantId?: string | null,
): boolean {
  const targetOrgId = run?.organization_id ?? activeTenantId ?? null;
  if (targetOrgId && driver.organization_id && driver.organization_id !== targetOrgId) return false;
  const status = String(driver.status ?? 'active').trim().toLowerCase();
  return status === 'active';
}

export function routeRunAssignTargetForDriver(
  driver: { id: string; vehicle_id?: string | null },
  activeTenantId?: string | null,
): RouteRunAssignTarget {
  const target: RouteRunAssignTarget = { driver_user_id: driver.id };
  const organizationId = nonBlankText(activeTenantId);
  const vehicleId = nonBlankText(driver.vehicle_id);
  if (organizationId) target.organization_id = organizationId;
  if (vehicleId) target.vehicle_id = vehicleId;
  return target;
}

export function routeRunDispatchGateFingerprint(
  run: Pick<RouteRunRow, 'id' | 'driver_user_id' | 'vehicle_id'>,
  assignment: Pick<
    RouteRunAssignmentRow,
    'assignment_status' | 'assignment_version' | 'driver_user_id' | 'vehicle_id'
  > | null | undefined,
  stopFingerprint: string,
): string {
  return [
    run.id,
    run.driver_user_id ?? '',
    run.vehicle_id ?? '',
    stopFingerprint,
    assignment?.assignment_status ?? '',
    assignment?.assignment_version ?? '',
    assignment?.driver_user_id ?? '',
    assignment?.vehicle_id ?? '',
  ].join('::');
}

export function routeRunStopFingerprint(
  stops: Array<Pick<RouteStopRow, 'id' | 'sequence_order' | 'shipment_id'>>,
): string {
  return stops
    .map((s) => `${s.id}:${s.sequence_order}:${s.shipment_id}`)
    .sort()
    .join('|');
}

function isRouteStopExecuteTask(task: RouteStopTaskRow): boolean {
  return (task.task_type ?? task.task_type_key) === 'route_stop_execute' && task.resource_type === 'route_stop';
}

export function routeRunAssignmentIsVisibleInDispatch(
  runId: string,
  stopIds: string[],
  assignments: Array<Pick<RouteRunAssignmentRow, 'route_run_id' | 'assignment_status'>>,
  tasks: Array<Pick<RouteStopTaskRow, 'task_type' | 'task_type_key' | 'resource_type' | 'resource_id'>>,
): boolean {
  const hasActiveAssignment = assignments.some((assignment) =>
    assignment.route_run_id === runId &&
    !['cancelled', 'canceled', 'completed'].includes(String(assignment.assignment_status ?? '').toLowerCase()),
  );
  if (!hasActiveAssignment) return false;
  if (stopIds.length === 0) return true;
  const executableStopIds = new Set(
    tasks
      .filter((task) =>
        (task.task_type ?? task.task_type_key) === 'route_stop_execute' &&
        task.resource_type === 'route_stop' &&
        typeof task.resource_id === 'string',
      )
      .map((task) => task.resource_id as string),
  );
  return stopIds.every((stopId) => executableStopIds.has(stopId));
}

export function fieldopsReassignRequestsForRun(
  runId: string,
  tasks: RouteStopTaskRow[],
): RouteStopTaskRow[] {
  return tasks
    .filter((task) => {
      const metadata = objectRecord(task.metadata) ?? {};
      const taskType = task.task_type ?? task.task_type_key;
      const status = String(task.status ?? '').toLowerCase();
      if (taskType !== 'dispatch_exception_review') return false;
      if (task.resource_type !== 'route_stop') return false;
      if (status === 'completed' || status === 'canceled' || status === 'cancelled') return false;
      if (booleanValue(metadata.mobile_v2_reassign_request) !== true) return false;
      return (
        nonBlankText(metadata.source_route_run_id) === runId ||
        nonBlankText(metadata.route_run_id) === runId
      );
    })
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

export function routeRunAlternateCapacityIsVisibleInDispatch(
  runId: string,
  assignments: Array<
    Pick<RouteRunAssignmentRow, 'route_run_id' | 'assignment_status' | 'assignment_mode' | 'partner'>
  >,
  directoryRows: Array<
    Pick<RouteRunDirectoryRow, 'id' | 'assignment_mode' | 'partner_name' | 'is_partner_run' | 'partner_payload'>
  >,
): boolean {
  const assignment = assignments.find((row) =>
    row.route_run_id === runId &&
    row.assignment_mode === ALTERNATE_CAPACITY_ASSIGNMENT_MODE &&
    !['cancelled', 'canceled', 'completed', 'refused'].includes(String(row.assignment_status ?? '').toLowerCase()),
  );
  if (!assignment) return false;
  const assignmentPartner = assignment.partner && typeof assignment.partner === 'object'
    ? assignment.partner as Record<string, unknown>
    : null;
  const directory = directoryRows.find((row) => row.id === runId);
  const directoryPartner = directory?.partner_payload && typeof directory.partner_payload === 'object'
    ? directory.partner_payload as Record<string, unknown>
    : null;
  return (
    directory?.assignment_mode === ALTERNATE_CAPACITY_ASSIGNMENT_MODE &&
    (directory.is_partner_run === true || routeRunAssignmentModeIsPartner(directory.assignment_mode)) &&
    Boolean(
      nonBlankText(directory.partner_name) ||
        nonBlankText(directoryPartner?.partner_name) ||
        nonBlankText(directoryPartner?.partner_id) ||
        nonBlankText(assignmentPartner?.partner_name) ||
        nonBlankText(assignmentPartner?.partner_id),
    )
  );
}

export function routeRunDepartureConfirmedAt(
  run: Pick<RouteRunRow, 'metadata'> | null | undefined,
): string | null {
  const departure = run?.metadata?.route_departure;
  if (!departure || typeof departure !== 'object' || Array.isArray(departure)) return null;
  const confirmedAt = (departure as Record<string, unknown>).confirmed_at;
  return typeof confirmedAt === 'string' && confirmedAt.trim() ? confirmedAt : null;
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

// W54-C closure — strict no-fallback chip resolution. The helpers no
// longer swallow a missing canonical row with a neutral default; they
// surface `(missing)` markers directly so consumers render `danger`-toned
// chips and operators see the gap. Mirrors AGENTS.md §2 (ZERO HARDCODING)
// + §4 (SSOT) and aligns with the `lookupRow`-based pattern across
// W54-A/B/D/E surfaces.
function statusLabel(category: string, value: unknown): string {
  const r = lookupRow(category, String(value)) as { label?: string } | null;
  return r?.label ?? `${category}/${String(value)} (missing)`;
}
function statusTone(category: string, value: unknown): string {
  const r = lookupRow(category, String(value)) as { tone?: string } | null;
  // Missing canonical row → 'danger' so the consumer chip surfaces the
  // gap loudly; downstream chip rendering also injects the (missing)
  // marker via statusLabel.
  return r?.tone ?? 'danger';
}

function taskActionNextStatus(kind: string): string {
  const row = lookupRow('task_action_kind', kind) as
    | { next_status?: string; metadata?: { next_status?: string } }
    | null;
  return row?.next_status ?? row?.metadata?.next_status ?? '';
}

export interface LookupOptionWithMetadata {
  value: string;
  label: string;
  metadata?: Record<string, unknown>;
}

function sortedLookupOptions(category: string): LookupOptionWithMetadata[] {
  return getLookups(category)
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((row) => ({ value: row.value, label: row.label, metadata: row.metadata }));
}

function defaultLookupValue(category: string): string {
  const rows = getLookups(category)
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return rows.find((row) => row.is_default)?.value ?? rows[0]?.value ?? '';
}

function parseBoxNumbers(raw: string): number[] | undefined {
  const tokens = raw.split(/[,\s]+/).map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return undefined;
  return tokens.map((token) => {
    const n = Number(token);
    if (!Number.isInteger(n) || n <= 0) throw new Error('Delivered box numbers must be positive integers');
    return n;
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanOptionalText(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  return value ? value : null;
}

export function sanitizeLast4(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return value ? value.slice(-4) : null;
}

function parseOptionalUuid(raw: string | null | undefined, label: string): string | null {
  const value = cleanOptionalText(raw);
  if (!value) return null;
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a valid UUID`);
  return value.toLowerCase();
}

export function parseProofGeostamp(
  latitudeRaw: string | null | undefined,
  longitudeRaw: string | null | undefined,
  accuracyRaw?: string | null,
): Record<string, number> | null {
  const latitudeText = cleanOptionalText(latitudeRaw);
  const longitudeText = cleanOptionalText(longitudeRaw);
  const accuracyText = cleanOptionalText(accuracyRaw);
  if (!latitudeText && !longitudeText && !accuracyText) return null;
  if (!latitudeText || !longitudeText) throw new Error('Proof geostamp requires both latitude and longitude');
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error('Proof latitude must be between -90 and 90');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Proof longitude must be between -180 and 180');
  }
  const geostamp: Record<string, number> = { latitude, longitude };
  if (accuracyText) {
    const accuracyM = Number(accuracyText);
    if (!Number.isFinite(accuracyM) || accuracyM < 0) {
      throw new Error('Proof accuracy must be a non-negative number');
    }
    geostamp.accuracy_m = accuracyM;
  }
  return geostamp;
}

function paymentDiscrepancyKind(outcome: string, variance: number): string {
  if (outcome === 'refused') return 'refused';
  if (variance > 0) return 'shortfall';
  if (variance < 0) return 'over_collection';
  return 'matched';
}

export function routeStopCodPreview(
  expectedCod: number | null | undefined,
  currency: string | null | undefined,
  paymentOutcome?: string,
  paymentAmount?: string,
  receiptContext?: string,
  t: Translate = englishT,
): { label: string; tone: ChipKind; varianceAmount: number; discrepancyKind: string; hasDiscrepancy: boolean } {
  const expected = Number(expectedCod ?? 0);
  const iso = String(currency ?? '').trim() || 'COD'; // i18n-literal-ok: currency code placeholder
  if (!Number.isFinite(expected) || expected <= 0) {
    return {
      label: t('dispatch.cod.none'),
      tone: 'neutral',
      varianceAmount: 0,
      discrepancyKind: 'not_required',
      hasDiscrepancy: false,
    };
  }
  const outcome = cleanOptionalText(paymentOutcome);
  const amountText = cleanOptionalText(paymentAmount);
  const collected = outcome === 'collected' && amountText ? Number(amountText) : 0;
  const varianceAmount = expected - (Number.isFinite(collected) ? collected : 0);
  const discrepancyKind = outcome ? paymentDiscrepancyKind(outcome, varianceAmount) : 'pending';
  const hasDiscrepancy = outcome === 'refused' || varianceAmount !== 0;
  if (!outcome) {
    return {
      label: fill(t('dispatch.cod.selectOutcome'), { iso, amount: expected }),
      tone: 'warn',
      varianceAmount: expected,
      discrepancyKind,
      hasDiscrepancy: true,
    };
  }
  if (outcome === 'refused') {
    return {
      label: fill(t('dispatch.cod.refused'), { iso, amount: expected }),
      tone: 'danger',
      varianceAmount: expected,
      discrepancyKind,
      hasDiscrepancy: true,
    };
  }
  if (!amountText) {
    return {
      label: fill(t('dispatch.cod.enterAmount'), { iso, amount: expected }),
      tone: 'warn',
      varianceAmount: expected,
      discrepancyKind,
      hasDiscrepancy: true,
    };
  }
  if (!cleanOptionalText(receiptContext)) {
    return {
      label: fill(t('dispatch.cod.addReceipt'), { iso, amount: expected }),
      tone: 'warn',
      varianceAmount,
      discrepancyKind,
      hasDiscrepancy: varianceAmount !== 0,
    };
  }
  if (varianceAmount === 0) {
    return {
      label: fill(t('dispatch.cod.matched'), { iso, amount: expected }),
      tone: 'good',
      varianceAmount,
      discrepancyKind,
      hasDiscrepancy,
    };
  }
  return {
    label: fill(t(discrepancyKind === 'shortfall' ? 'dispatch.cod.shortfall' : 'dispatch.cod.overCollection'), {
      iso,
      amount: Math.abs(varianceAmount),
    }),
    tone: 'danger',
    varianceAmount,
    discrepancyKind,
    hasDiscrepancy,
  };
}

export interface RouteStopCloseoutPayloadArgs {
  stopId: string;
  shipmentId: string;
  completionKind?: string;
  failureReason?: string;
  deliveredBoxNumbers?: string;
  expectedCod?: number | null;
  currency?: string | null;
  paymentOutcome?: string;
  paymentMethod?: string;
  paymentAmount?: string;
  receiptContext?: string;
  notes?: string;
  handoverMode?: string;
  handoverModeRow?: LookupOptionWithMetadata | null;
  recipientName?: string;
  recipientClass?: string;
  recipientIdentityKind?: string;
  recipientIdentityLast4?: string;
  otpLast4?: string;
  signatureArtifactId?: string;
  photoArtifactId?: string;
  capturedAt?: string;
  latitude?: string;
  longitude?: string;
  accuracyM?: string;
}

export function buildRouteStopCloseoutPayload(args: RouteStopCloseoutPayloadArgs): {
  payload: Record<string, unknown>;
  deliveryCompletion: Record<string, unknown>;
  paymentCollection: Record<string, unknown> | null;
} {
  const completionKind = cleanOptionalText(args.completionKind);
  const failureReason = cleanOptionalText(args.failureReason);
  if (!completionKind && !failureReason) throw new Error('Completion kind or failure reason is required');
  const delivered = parseBoxNumbers(args.deliveredBoxNumbers ?? '');
  const amount = cleanOptionalText(args.paymentAmount) ? Number(args.paymentAmount) : null;
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
    throw new Error('Collected amount must be greater than zero');
  }

  const expectedCod = Number(args.expectedCod ?? 0);
  if (!Number.isFinite(expectedCod) || expectedCod < 0) {
    throw new Error('Expected COD must be a non-negative number');
  }
  const paymentOutcome = cleanOptionalText(args.paymentOutcome);
  const paymentMethod = cleanOptionalText(args.paymentMethod);
  const receiptContext = cleanOptionalText(args.receiptContext);
  const hasExpectedCod = expectedCod > 0;
  const hasPaymentInput = Boolean(paymentOutcome || paymentMethod || cleanOptionalText(args.paymentAmount) || receiptContext);
  const isFailedAttempt = Boolean(failureReason);
  if (!hasExpectedCod && hasPaymentInput) {
    throw new Error('COD payment details are only allowed when this stop has expected COD');
  }
  if (!isFailedAttempt && hasExpectedCod && !paymentOutcome) {
    throw new Error('Payment outcome is required for COD closeout');
  }
  if (!isFailedAttempt && paymentOutcome === 'collected') {
    if (!paymentMethod) throw new Error('Payment method is required when COD is collected');
    if (amount == null) throw new Error('Collected amount is required when COD is collected');
    if (!receiptContext) throw new Error('Receipt context is required when COD is collected');
  }
  const varianceAmount = !isFailedAttempt && hasExpectedCod ? expectedCod - (paymentOutcome === 'collected' ? amount ?? 0 : 0) : 0;
  const discrepancyKind = paymentOutcome ? paymentDiscrepancyKind(paymentOutcome, varianceAmount) : null;
  const failedAttemptPaymentCollection = isFailedAttempt && hasExpectedCod
    ? {
        required: true,
        outcome: 'refused',
        method: null,
        expected_amount: expectedCod,
        collected_amount: 0,
        variance_amount: expectedCod,
        has_discrepancy: true,
        discrepancy_kind: 'refused',
        currency: args.currency ?? null,
        receipt_context: receiptContext,
      }
    : null;
  const paymentCollection = failedAttemptPaymentCollection ?? (!isFailedAttempt && hasExpectedCod
    ? {
        required: true,
        outcome: paymentOutcome,
        method: paymentOutcome === 'collected' ? paymentMethod : null,
        expected_amount: expectedCod,
        collected_amount: paymentOutcome === 'collected' ? amount ?? 0 : 0,
        variance_amount: varianceAmount,
        has_discrepancy: paymentOutcome === 'refused' || varianceAmount !== 0,
        discrepancy_kind: discrepancyKind,
        currency: args.currency ?? null,
        receipt_context: receiptContext,
      }
    : null);

  const handoverMode = cleanOptionalText(args.handoverMode);
  const recipientName = cleanOptionalText(args.recipientName);
  const recipientClass = cleanOptionalText(args.recipientClass);
  const recipientIdentityKind = cleanOptionalText(args.recipientIdentityKind);
  const recipientIdentityLast4 = sanitizeLast4(args.recipientIdentityLast4);
  if ((recipientIdentityKind && !recipientIdentityLast4) || (!recipientIdentityKind && recipientIdentityLast4)) {
    throw new Error('Recipient identity proof requires both identity type and last 4');
  }
  const otpLast4 = sanitizeLast4(args.otpLast4);
  const signatureArtifactId = parseOptionalUuid(args.signatureArtifactId, 'Signature artifact ID');
  const photoArtifactId = parseOptionalUuid(args.photoArtifactId, 'Photo artifact ID');
  const requiresSignature = Boolean(args.handoverModeRow?.metadata?.requires_signature);
  if (!isFailedAttempt && requiresSignature && !signatureArtifactId) {
    throw new Error(`${args.handoverModeRow?.label ?? handoverMode ?? 'Selected handover mode'} requires a signature artifact ID`);
  }
  const artifactIds = [signatureArtifactId, photoArtifactId].filter(Boolean) as string[];
  const capturedAt = cleanOptionalText(args.capturedAt);
  const geostamp = parseProofGeostamp(args.latitude, args.longitude, args.accuracyM);
  const completionNotes = cleanOptionalText(args.notes);

  const deliveryProofDetails = {
    ...(handoverMode ? { handover_mode: handoverMode } : {}),
    ...(recipientName ? { recipient_name: recipientName } : {}),
    ...(recipientClass ? { recipient_class: recipientClass } : {}),
    ...(recipientIdentityKind && recipientIdentityLast4
      ? {
          recipient_identity_kind: recipientIdentityKind,
          recipient_identity_last4: recipientIdentityLast4,
        }
      : {}),
    ...(otpLast4 ? { otp_confirmed: true, otp_last4: otpLast4 } : {}),
    ...(signatureArtifactId ? { signature_artifact_id: signatureArtifactId } : {}),
    ...(photoArtifactId ? { photo_artifact_id: photoArtifactId } : {}),
    ...(artifactIds.length ? { artifact_ids: artifactIds } : {}),
    ...(capturedAt ? { captured_at: capturedAt } : {}),
    ...(geostamp ? { geostamp } : {}),
  };
  const exceptionProofDetails = {
    ...(artifactIds.length ? { artifact_ids: artifactIds } : {}),
    ...(capturedAt ? { captured_at: capturedAt } : {}),
    ...(geostamp ? { geostamp } : {}),
  };
  const proofDetails = isFailedAttempt ? exceptionProofDetails : deliveryProofDetails;
  const pod = {
    completion_kind: completionKind ?? (isFailedAttempt ? 'not_delivered' : undefined),
    ...proofDetails,
  };

  const exceptionEvidence = isFailedAttempt
    ? {
        ...(completionNotes ? { notes: completionNotes } : {}),
        ...(capturedAt ? { captured_at: capturedAt } : {}),
        ...(geostamp ? { geostamp } : {}),
        proof_artifact_count: artifactIds.length,
      }
    : null;
  const deliveryAttempt = isFailedAttempt
    ? {
        outcome: 'not_delivered',
        reason: failureReason,
        dispatch_exception_reason: failureReason,
        exception_reason: failureReason,
        attempted_at: capturedAt || new Date().toISOString(),
        ...(artifactIds.length ? { artifact_ids: artifactIds } : {}),
        ...(exceptionEvidence ? { exception_evidence: exceptionEvidence } : {}),
        route_stop_outcome: 'attempted',
      }
    : null;

  const deliveryCompletion = {
    completion_kind: completionKind ?? 'not_delivered',
    ...(delivered ? { delivered_box_numbers: delivered } : {}),
    ...(paymentCollection ? { payment_collection: paymentCollection } : {}),
    ...(completionNotes ? { notes: completionNotes, completion_notes: completionNotes } : {}),
    ...(failureReason ? { status_reason: failureReason, exception_reason: failureReason } : {}),
    ...(deliveryAttempt ? { delivery_attempt: deliveryAttempt } : {}),
    ...proofDetails,
    pod,
  };

  const payload = {
    route_stop_id: args.stopId,
    shipment_id: args.shipmentId,
    route_stop_completion: deliveryCompletion,
    ...(isFailedAttempt ? {} : { delivery_completion: deliveryCompletion }),
    completion_kind: completionKind ?? 'not_delivered',
    ...(failureReason
      ? {
          status_reason: failureReason,
          outcome_reason: failureReason,
          exception_reason: failureReason,
          delivery_attempt: deliveryAttempt,
          exception_evidence: exceptionEvidence,
          ...(hasExpectedCod ? { payment_outcome: 'refused' } : {}),
        }
      : {}),
    ...(paymentCollection ? { payment_collection: paymentCollection } : {}),
    ...proofDetails,
    pod,
  };
  return { payload, deliveryCompletion, paymentCollection };
}

export function routeStopCloseoutDisabledReason(args: {
  task: unknown | null | undefined;
  departureConfirmedAt: string | null | undefined;
  pending?: boolean;
}, t: Translate = englishT): string | null {
  if (!args.task) return t('dispatch.closeoutReason.notReady');
  const status = String((args.task as Record<string, unknown>).status ?? '').trim().toLowerCase();
  if (['completed', 'closed', 'resolved', 'done'].includes(status)) return t('dispatch.closeoutReason.alreadyClosed');
  if (['cancelled', 'canceled', 'void', 'rejected'].includes(status)) return t('dispatch.closeoutReason.notActionable');
  if (!args.departureConfirmedAt) return t('dispatch.closeoutReason.confirmDeparture');
  if (args.pending) return t('dispatch.closeoutReason.saving');
  return null;
}

// W14-1 — short canonical-id label used wherever the dispatch surface
// previously rendered `run.run_id` (a fictional alias). The PK is a UUID; we
// prefix + truncate for the operator display so the chip stays compact.
function runDisplayId(id: string): string {
  return `RUN·${id.slice(-6).toUpperCase()}`;
}

function routeRunDirectoryDisplayId(id: string, directory: RouteRunDirectoryRow | null | undefined): string {
  const projected = typeof directory?.run_display_id === 'string' ? directory.run_display_id.trim() : '';
  return projected || runDisplayId(id);
}

// CLAIM-OPERATIONS-WIRING (Phase C1) — COD float limit reads from the
// canonical `cod.float.max_per_driver` settings category (seed sv_160 /
// sv_161; AGENTS.md ladder). NO fallback constants — when the resolver
// cannot deliver a numeric value, the COD float card surfaces a loud
// error StateView instead of substituting a literal limit.

function operatorEventLabel(value: string | null | undefined): string {
  return String(value ?? 'event')
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function shipmentShortLabel(id: string | null | undefined, t: Translate = englishT): string {
  const suffix = String(id ?? '').slice(-6).toUpperCase();
  return suffix ? fill(t('dispatch.shipmentShort'), { suffix }) : t('dispatch.shipmentBare');
}

function dispatchReadErrorMessage(reason: unknown, t: Translate = englishT): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : t('dispatch.readError');
}

function dispatchMutationErrorMessage(reason: unknown, fallback: string, t: Translate = englishT): string {
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  const departureScanOutMessage = dispatchDepartureScanOutErrorMessage(message, t);
  if (departureScanOutMessage) return departureScanOutMessage;
  return reason instanceof Error && reason.message
    ? reason.message
    : fallback;
}

function dispatchDepartureScanOutErrorMessage(message: string, t: Translate = englishT): string | null {
  const missing = dispatchBracketedValues(message, 'missing_route_stop_ids');
  const duplicate = dispatchBracketedValues(message, 'duplicate_route_stop_ids');
  const unexpected = dispatchBracketedValues(message, 'unexpected_barcodes');
  if (!missing.length && !duplicate.length && !unexpected.length) return null;
  const details = [
    missing.length ? fill(t('dispatch.departureBlocked.missingStops'), { ids: missing.join(', ') }) : null,
    duplicate.length ? fill(t('dispatch.departureBlocked.duplicateStops'), { ids: duplicate.join(', ') }) : null,
    unexpected.length ? fill(t('dispatch.departureBlocked.unexpectedBarcodes'), { ids: unexpected.join(', ') }) : null,
  ].filter(Boolean);
  return fill(t('dispatch.departureBlocked.message'), { details: details.join(t('dispatch.departureBlocked.separator')) });
}

function dispatchBracketedValues(message: string, key: string): string[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedKey}\\s*\\[([^\\]]*)\\]`).exec(message);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

function isDispatchPermissionDeniedError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return message.includes('permission') || message.includes('capability') || message.includes('denied') || message.includes('forbidden');
}

function dispatchText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function routeRunTenantActionDisabledReason(
  run: Pick<RouteRunRow, 'organization_id'> | null | undefined,
  activeTenantId: string | null | undefined,
  t: Translate = englishT,
): string | undefined {
  const runOrgId = dispatchText(run?.organization_id);
  const activeId = dispatchText(activeTenantId);
  if (runOrgId && activeId && runOrgId !== activeId) {
    return t('dispatch.tenant.run');
  }
  return undefined;
}

function routeStopTenantActionDisabledReason(
  stop: Pick<RouteStopRow, 'organization_id'> | null | undefined,
  run: Pick<RouteRunRow, 'organization_id'> | null | undefined,
  activeTenantId: string | null | undefined,
  t: Translate = englishT,
): string | undefined {
  const stopOrgId = dispatchText(run?.organization_id) ?? dispatchText(stop?.organization_id);
  const activeId = dispatchText(activeTenantId);
  if (stopOrgId && activeId && stopOrgId !== activeId) {
    return t('dispatch.tenant.stop');
  }
  return undefined;
}

export function DispatchModule() {
  const { t } = useI18n();
  const { scope, user } = useIdentity();
  const queryClient = useQueryClient();
  const canRead = useCapability(CAP.ROUTES_READ);
  const canWriteRoutes = useCapability(CAP.ROUTES_WRITE);
  const canCompleteTasks = useCapability(CAP.TASKS_COMPLETE);
  const drawer = useDrawer();
  const modal = useModal();
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);

  const { data: kpis } = useDashboardKpis(readQueryOptions);
  const runsQuery = useCompleteResourceList<RouteRunRow>('route_runs', undefined, readQueryOptions);
  const stopsQuery = useCompleteResourceList<RouteStopRow>('route_stops', undefined, readQueryOptions);
  const { data: runsData, isLoading: runsLoading } = runsQuery;
  const { data: stopsData, isLoading: stopsLoading } = stopsQuery;
  // W24 — additive directory projection. The canonical SSOT remains the
  // `route_runs` + `route_stops` reads above; this read enriches the
  // surface with branch/driver/vehicle labels, derived counters, and the
  // active assignment projection through `v_route_run_directory`.
  const runDirectoryQuery = useCompleteResourceList<RouteRunDirectoryRow>(
    'route_run_directory',
    undefined,
    readQueryOptions,
  );
  const runDirectoryById = useMemo(() => {
    const m = new Map<string, RouteRunDirectoryRow>();
    for (const r of runDirectoryQuery.data?.rows ?? []) m.set(r.id, r);
    return m;
  }, [runDirectoryQuery.data]);
  const routeRunLabel = useCallback(
    (routeRunId: string) => routeRunDirectoryDisplayId(routeRunId, runDirectoryById.get(routeRunId)),
    [runDirectoryById],
  );
  const dispatchReadError = runsQuery.isError
    ? runsQuery.error
    : stopsQuery.isError
      ? stopsQuery.error
      : runDirectoryQuery.isError
        ? runDirectoryQuery.error
        : null;
  const tenantSettingsScope = useMemo(
    () => (scope.tenant?.id ? { organization_id: scope.tenant.id } : undefined),
    [scope.tenant?.id],
  );
  const { data: mapPolicy } = useResolveSettings('map_policy', tenantSettingsScope, readQueryOptions);
  const mapPolicyValue = (mapPolicy?.value as MapPolicyValue | undefined) ?? null;
  const mapTileProvider = mapPolicyValue?.tile_provider ?? null;
  const mapDefaultViewport = mapPolicyValue?.default_viewport ?? null;
  const { data: routePolicy } = useResolveSettings('route_assignment_policy', undefined, readQueryOptions);
  // CLAIM-OPERATIONS-WIRING (Phase C1) — canonical resolver call for the
  // COD float limit. The chip below renders the ladder-resolved value
  // strictly; when the resolver has not yet produced a numeric value the
  // insight card surfaces a loud error StateView (no fallback constants).
  const { data: codFloatPolicy, isLoading: codFloatLoading } = useResolveSettings(
    'cod.float.max_per_driver',
    undefined,
    readQueryOptions,
  );
  const codFloatLimit =
    typeof codFloatPolicy?.value === 'number'
      ? (codFloatPolicy.value as number)
      : null;
  // CYCLE-E2 STRICT-ISOLATION (P1 #1) — `tenant_currency` resolves the COD
  // float chip currency through the canonical settings ladder (W30/G1) so
  // the literal `'SAR '` prefix is removed from the operator surface. Fail
  // loud (render `'—'`) when the row is missing rather than fallback.
  const { data: tenantCurrencyPolicy } = useResolveSettings('tenant_currency', undefined, readQueryOptions);
  const tenantCurrencyIso =
    (tenantCurrencyPolicy?.value as { iso_code?: string } | undefined)?.iso_code ?? null;
  // Drivers roster (for the "Assign driver…" picker on each run row + driver
  // display-name resolution since `route_runs.driver_user_id` is a uuid).
  const driversQuery = useCompleteResourceList<DriverLookupRow>('drivers', undefined, readQueryOptions);
  const drivers = useMemo<DriverLookupRow[]>(
    () => driversQuery.data?.rows ?? [],
    [driversQuery.data?.rows],
  );
  // W29 — vehicles resolve through the canonical fleet directory projection
  // used by the fleet screens. SSOT remains public.vehicles, while the
  // operator surface reads v_vehicle_directory for labels, type, and status.
  const vehiclesQuery = useCompleteResourceList<VehicleLookupRow>('vehicle_directory', undefined, readQueryOptions);
  const vehicles = useMemo<VehicleLookupRow[]>(
    () => vehiclesQuery.data?.rows ?? [],
    [vehiclesQuery.data?.rows],
  );
  // W14-1 — shipments lookup so the COD float aggregate over a run's stops
  // resolves through canonical `shipments.cod_amount` (the FE used to read a
  // fictional `route_stops.cod_amount` alias).
  const shipmentsQuery = useCompleteResourceList<ShipmentCodLookupRow>('shipments', undefined, readQueryOptions);
  const shipments = useMemo<ShipmentCodLookupRow[]>(
    () => shipmentsQuery.data?.rows ?? [],
    [shipmentsQuery.data?.rows],
  );
  const shipmentAddressById = useMemo(() => {
    const m = new Map<string, string>();
    for (const shipment of shipments) {
      const addressId = shipmentAddressIdForDispatchMap(shipment);
      if (addressId) m.set(shipment.id, addressId);
    }
    return m;
  }, [shipments]);
  const basketsQuery = useCompleteResourceList<BasketLookupRow>('baskets', undefined, readQueryOptions);
  const basketItemsQuery = useCompleteResourceList<BasketItemLookupRow>(
    'basket_items',
    undefined,
    readQueryOptions,
  );
  const baskets = useMemo<BasketLookupRow[]>(
    () => basketsQuery.data?.rows ?? [],
    [basketsQuery.data?.rows],
  );
  const basketById = useMemo(() => {
    const m = new Map<string, BasketLookupRow>();
    for (const row of baskets) m.set(row.id, row);
    return m;
  }, [baskets]);
  const activeBasketItems = useMemo(
    () => (basketItemsQuery.data?.rows ?? []).filter((row) => !row.removed_at),
    [basketItemsQuery.data?.rows],
  );

  // OPERATIONS REAUDIT D4 (W9-4) — three new SSOT exposures consumed in the
  // dispatch insight rail: assignment projection (current state) + assignment
  // event ledger (run-level audit) + stop reassignment ledger (stop-level
  // audit). All read through the canonical `useResourceList` registry path
  // (registered in seed-raw/registry.js + lib/data-source.ts) so the
  // production swap is a single getSupabaseClient() branch flip.
  const runAssignQuery = useCompleteResourceList<RouteRunAssignmentRow>(
    'route_run_assignments',
    undefined,
    readQueryOptions,
  );
  const runAssignEventsQuery = useCompleteResourceList<RouteRunAssignmentEventRow>(
    'route_run_assignment_events',
    undefined,
    readQueryOptions,
  );
  const stopReassignEventsQuery = useCompleteResourceList<RouteStopReassignEventRow>(
    'route_stop_reassignment_events',
    undefined,
    readQueryOptions,
  );
  const routeStopTasksQuery = useCompleteResourceList<RouteStopTaskRow>('tasks', undefined, readQueryOptions);

  const reassignMutation = useExecuteRouteStopReassign();
  const confirmDepartureMutation = useConfirmRouteRunDeparture();
  const reconcileMutation = useReconcileRouteRunScanOut();
  const transitionTaskMutation = useTransitionTask();
  const scanEventMutation = useScanEvent();
  // CLAIM-OPERATIONS-WIRING (Phase C1) — `useExecuteRouteRunAssign` exists at
  // queries.ts:302 but no module imported it (gap row in
  // __audit__/CROSSWALK/OPERATIONS.md). Wire it in here so the operator can
  // assign a driver to a free-form route_run from the canvas — not just at
  // pickup-wave granularity.
  const runAssignMutation = useExecuteRouteRunAssign();
  const runAssignmentResponseMutation = useExecuteRouteRunAssignmentResponse();
  const activeTenantId = dispatchText(scope.tenant?.id);

  // Dispatch is a working canvas: keep an in-memory copy that mirrors what
  // the demo did with mutable arrays so DnD reassignment is reflected
  // without a full refetch round-trip. Rollback handlers come from the
  // mutation flow (optimistic move + revert on error).
  const [runs, setRuns] = useState<RouteRunRow[]>([]);
  const [stops, setStops] = useState<RouteStopRow[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [dndOver, setDndOver] = useState<string | null>(null);
  const [selectedStops, setSelectedStops] = useState<Set<string>>(new Set());
  const [bulkMoveTargetRunId, setBulkMoveTargetRunId] = useState('');
  const [scanOutGateByRunId, setScanOutGateByRunId] = useState<Record<string, ScanOutGateSnapshot>>({});
  const focusedRouteStopRef = useRef<string | null>(null);
  // The picker drives both the bulk stop reassign flow AND the per-run driver
  // assign flow (CLAIM-OPERATIONS-WIRING Phase C1).
  const [picker, setPicker] = useState<null | { kind: 'bulk' } | { kind: 'assign-driver'; runId: string }>(null);
  const assignableDrivers = useMemo<DriverLookupRow[]>(() => {
    const selectedRun = picker?.kind === 'assign-driver'
      ? runs.find((run) => run.id === picker.runId)
      : null;
    return drivers.filter((driver) =>
      isDriverAssignableToRouteRun(driver, selectedRun, scope.tenant?.id ?? null),
    );
  }, [drivers, picker, runs, scope.tenant?.id]);

  const applyCanonicalRuns = useCallback((rows: RouteRunRow[]) => {
    const nextRuns = rows.map((r) => ({ ...r }));
    setRuns(nextRuns);
    setActiveRunId((current) =>
      current && nextRuns.some((r) => r.id === current) ? current : (nextRuns[0]?.id ?? null),
    );
  }, []);

  const applyCanonicalStops = useCallback((rows: RouteStopRow[]) => {
    const nextStops = rows.map((s) => ({ ...s }));
    const liveStopIds = new Set(nextStops.map((s) => s.id));
    setStops(nextStops);
    setSelectedStops((current) => {
      const kept = new Set(Array.from(current).filter((id) => liveStopIds.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, []);

  function dispatchLifecycleDisabledReasonForRun(run: RouteRunRow | null | undefined): string | undefined {
    return routeRunTenantActionDisabledReason(run, activeTenantId, t);
  }

  function dispatchLifecycleDisabledReasonForStop(stop: RouteStopRow | null | undefined): string | undefined {
    const run = stop ? runs.find((row) => row.id === stop.route_run_id) : null;
    return routeStopTenantActionDisabledReason(stop, run, activeTenantId, t);
  }

  function dispatchLifecycleDisabledReasonForSelectedStops(
    selectedIds: Iterable<string>,
    targetRun?: RouteRunRow | null,
  ): string | undefined {
    const selectedByRun = new Map<string, number>();
    if (targetRun) {
      const targetReason = dispatchLifecycleDisabledReasonForRun(targetRun);
      if (targetReason) return t('dispatch.tenant.selected');
    }
    for (const stopId of selectedIds) {
      const stop = stops.find((row) => row.id === stopId);
      if (dispatchLifecycleDisabledReasonForStop(stop)) {
        return t('dispatch.tenant.selected');
      }
      if (stop?.route_run_id) {
        selectedByRun.set(stop.route_run_id, (selectedByRun.get(stop.route_run_id) ?? 0) + 1);
      }
    }
    for (const [runId, selectedCount] of selectedByRun) {
      const sourceStopCount = stops.filter((stop) => stop.route_run_id === runId).length;
      if (sourceStopCount > 0 && selectedCount >= sourceStopCount) {
        return t('dispatch.tenant.wholeRoute');
      }
    }
    return undefined;
  }

  // Local DnD state is only a temporary interaction buffer. Canonical query
  // rows own the visible canvas after every refetch/mutation refresh.
  useEffect(() => {
    if (runsData?.rows) applyCanonicalRuns(runsData.rows);
  }, [runsData?.rows, applyCanonicalRuns]);
  useEffect(() => {
    if (stopsData?.rows) applyCanonicalStops(stopsData.rows);
  }, [stopsData?.rows, applyCanonicalStops]);

  // W14-1 — sibling-resource indices (memoized). These replace the previously
  // rendered FE alias fields (driver / vehicle / cod_total / partner) with
  // canonical projections joined at render time.
  const driverByUserId = useMemo<Map<string, DriverLookupRow>>(() => {
    const m = new Map<string, DriverLookupRow>();
    for (const d of drivers) m.set(d.id, d);
    return m;
  }, [drivers]);
  const vehicleById = useMemo<Map<string, VehicleLookupRow>>(() => {
    const m = new Map<string, VehicleLookupRow>();
    for (const v of vehicles) m.set(v.id, v);
    return m;
  }, [vehicles]);
  const shipmentCodById = useMemo<Map<string, ShipmentCodLookupRow>>(() => {
    const m = new Map<string, ShipmentCodLookupRow>();
    for (const s of shipments) m.set(s.id, s);
    return m;
  }, [shipments]);
  const assignmentByRunId = useMemo<Map<string, RouteRunAssignmentRow>>(() => {
    const m = new Map<string, RouteRunAssignmentRow>();
    for (const a of runAssignQuery.data?.rows ?? []) m.set(a.route_run_id, a);
    return m;
  }, [runAssignQuery.data]);
  const routeStopTaskByStopId = useMemo<Map<string, RouteStopTaskRow>>(() => {
    const m = new Map<string, RouteStopTaskRow>();
    for (const task of routeStopTasksQuery.data?.rows ?? []) {
      if (!isRouteStopExecuteTask(task)) continue;
      const stopId = task.resource_id;
      if (typeof stopId === 'string' && stopId) m.set(stopId, task);
    }
    return m;
  }, [routeStopTasksQuery.data]);
  // Per-run stop count + completed count + cod aggregate are derived from
  // canonical sources, never from FE-aliased columns. Completion is inferred
  // from `route_stop_reassignment_events`-aware progress when the run carries
  // a started_at timestamp; until backend exposes a per-stop status we surface
  // only the total stop count (canonical) and leave completion blank.
  const stopsCountByRunId = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const s of stops) {
      m.set(s.route_run_id, (m.get(s.route_run_id) ?? 0) + 1);
    }
    return m;
  }, [stops]);
  const codTotalByRunId = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const s of stops) {
      const ship = shipmentCodById.get(s.shipment_id);
      const cod = typeof ship?.cod_amount === 'number' ? (ship.cod_amount as number) : 0;
      m.set(s.route_run_id, (m.get(s.route_run_id) ?? 0) + cod);
    }
    return m;
  }, [stops, shipmentCodById]);
  const stopFingerprintByRunId = useMemo<Map<string, string>>(() => {
    const grouped = new Map<string, string[]>();
    for (const s of stops) {
      const list = grouped.get(s.route_run_id) ?? [];
      list.push(routeRunStopFingerprint([s]));
      grouped.set(s.route_run_id, list);
    }
    const fingerprints = new Map<string, string>();
    for (const [runId, parts] of grouped) {
      fingerprints.set(runId, parts.sort().join('|'));
    }
    return fingerprints;
  }, [stops]);
  const dispatchGateFingerprintByRunId = useMemo<Map<string, string>>(() => {
    const fingerprints = new Map<string, string>();
    for (const r of runs) {
      const assignment = assignmentByRunId.get(r.id);
      fingerprints.set(
        r.id,
        routeRunDispatchGateFingerprint(r, assignment, stopFingerprintByRunId.get(r.id) ?? ''),
      );
    }
    return fingerprints;
  }, [assignmentByRunId, runs, stopFingerprintByRunId]);

  // W14-1 — display helpers. Each one routes through the canonical lookup;
  // when the join can't resolve we fall back to the canonical id so the cell
  // never renders an empty value.
  const driverDisplayName = useCallback(
    (uid: string | null | undefined): string => {
      if (!uid) return '—';
      const d = driverByUserId.get(uid);
      return d?.name ?? `Driver ${uid}`;
    },
    [driverByUserId],
  );
  const vehicleDisplayLabel = useCallback(
    (vid: string | null | undefined): string => {
      if (!vid) return '—';
      const v = vehicleById.get(vid);
      return v?.plate_number ?? v?.plate ?? v?.code ?? fill(t('dispatch.vehicleFallback'), { id: vid });
    },
    [vehicleById, t],
  );
  const basketDisplayLabel = useCallback((basket: BasketLookupRow | null | undefined): string => {
    if (!basket) return t('dispatch.basketFallback');
    const type = basket.basket_type ? statusLabel('basket_type', basket.basket_type) : t('dispatch.basketFallback');
    const current = basket.current_count ?? 0;
    const capacity = basket.capacity_count ?? '—';
    return `${type} · ${current}/${capacity}`;
  }, [t]);
  const isPartnerRun = useCallback(
    (runId: string): boolean => {
      // W71-Operate (Cycle F-R-11) closure — partner-fleet gate resolves
      // through canonical `route_assignment_mode.metadata.is_partner`
      // instead of an inline `'partner_fleet'` literal compare. AGENTS.md
      // §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
      const a = assignmentByRunId.get(runId);
      return routeRunAssignmentModeIsPartner(a?.assignment_mode);
    },
    [assignmentByRunId],
  );
  const partnerNameForRun = useCallback(
    (runId: string): string | null => {
      const a = assignmentByRunId.get(runId);
      return (
        a?.partner?.partner_name ??
        a?.partner?.partner_id ??
        (a?.assignment_mode ? statusLabel('route_assignment_mode', a.assignment_mode) : null)
      );
    },
    [assignmentByRunId],
  );

  useEffect(() => {
    if (!activeRunId && runs.length) {
      setActiveRunId(runs[0]!.id);
    }
  }, [runs, activeRunId]);

  useEffect(() => {
    const focus = readUrlParam('route_stop') ?? readUrlParam('focus');
    if (!focus || focusedRouteStopRef.current === focus) return;
    const stop = stops.find((row) => row.id === focus || row.shipment_id === focus);
    if (!stop) return;
    focusedRouteStopRef.current = focus;
    setActiveRunId(stop.route_run_id);
    setSelectedStops(new Set([stop.id]));
  }, [stops]);

  const activeRun = runs.find((r) => r.id === activeRunId);
  const activeRouteOrgId = activeRun?.organization_id ?? scope.tenant?.id ?? null;
  const activeRunDirectory = activeRun ? runDirectoryById.get(activeRun.id) : undefined;
  const podPolicyScope = useMemo(
    () => ({
      tenant: activeRouteOrgId ? { id: activeRouteOrgId } : undefined,
    }),
    [activeRouteOrgId],
  );
  const podPolicyQuery = useResolveMobilePolicy('pod_policy', podPolicyScope);
  const podProofRequirements = useMemo(
    () => routeStopPodProofRequirements(podPolicyQuery.data?.value, t),
    [podPolicyQuery.data?.value, t],
  );
  const activeStops = useMemo(
    () => stops.filter((stop) => stop.route_run_id === activeRunId),
    [stops, activeRunId],
  );
  // The map only displays the selected run, so resolve its stop addresses.
  const dispatchMapAddressIds = useMemo(
    () =>
      Array.from(
        new Set(
          activeStops
            .map((stop) => shipmentAddressById.get(stop.shipment_id))
            .filter((id): id is string => Boolean(id)),
        ),
      ).sort(),
    [shipmentAddressById, activeStops],
  );
  const dispatchMapGeocodeFilters = useMemo(
    () => dispatchMapAddressIds.map((address_id) => ({ address_id })),
    [dispatchMapAddressIds],
  );
  const geocodesQuery = useResourceListsByFilters<RouteStopMapGeocode>(
    'geocodes',
    dispatchMapGeocodeFilters,
    { page_size: 5 },
    readQueryOptions,
  );
  const geocodes = useMemo<RouteStopMapGeocode[]>(
    () => geocodesQuery.data?.rows ?? [],
    [geocodesQuery.data?.rows],
  );
  const activeRunDirectoryStopCount =
    typeof activeRunDirectory?.stop_count === 'number' ? activeRunDirectory.stop_count : null;
  const activeRunObservedStopCount = activeRun ? (stopsCountByRunId.get(activeRun.id) ?? activeStops.length) : 0;
  const activeRunVisibleStopCount =
    activeRunDirectoryStopCount == null
      ? activeRunObservedStopCount
      : Math.max(activeRunDirectoryStopCount, activeRunObservedStopCount);
  const activeStopsRestricted =
    Boolean(activeRun) && activeRunVisibleStopCount > 0 && activeStops.length === 0;
  const activeStopsRestrictedReason = activeStopsRestricted
    ? t('dispatch.restrictedReason')
    : undefined;
  const activeShipmentIds = useMemo(
    () => Array.from(new Set(activeStops.map((stop) => stop.shipment_id).filter(Boolean))).sort(),
    [activeStops],
  );
  const activeStopIds = useMemo(
    () => Array.from(new Set(activeStops.map((stop) => stop.id).filter(Boolean))).sort(),
    [activeStops],
  );
  const activeShipmentRowsQuery = useResourceRowsByIds<ShipmentCodLookupRow>('shipments', activeShipmentIds, {
    enabled: activeShipmentIds.length > 0,
  });
  const activeRouteStopTasksQuery = useResourceListsByFilters<RouteStopTaskRow>(
    'tasks',
    activeStopIds.map((stopId) => ({
      task_type: 'route_stop_execute',
      resource_type: 'route_stop',
      resource_id: stopId,
    })),
    { page_size: 5 },
    { enabled: activeStopIds.length > 0 },
  );
  const dispatchCriticalReadError = dispatchReadError;
  const dispatchEnrichmentReadError =
    (driversQuery.isError ? driversQuery.error : null) ??
    (vehiclesQuery.isError ? vehiclesQuery.error : null) ??
    (shipmentsQuery.isError ? shipmentsQuery.error : null) ??
    (geocodesQuery.isError ? geocodesQuery.error : null) ??
    (basketsQuery.isError ? basketsQuery.error : null) ??
    (basketItemsQuery.isError ? basketItemsQuery.error : null) ??
    (runAssignQuery.isError ? runAssignQuery.error : null) ??
    (runAssignEventsQuery.isError ? runAssignEventsQuery.error : null) ??
    (stopReassignEventsQuery.isError ? stopReassignEventsQuery.error : null) ??
    (routeStopTasksQuery.isError ? routeStopTasksQuery.error : null) ??
    (activeShipmentRowsQuery.isError ? activeShipmentRowsQuery.error : null) ??
    (activeRouteStopTasksQuery.isError ? activeRouteStopTasksQuery.error : null);
  const activeShipmentCodById = useMemo(() => {
    const m = new Map(shipmentCodById);
    for (const shipment of activeShipmentRowsQuery.data?.rows ?? []) m.set(shipment.id, shipment);
    return m;
  }, [activeShipmentRowsQuery.data?.rows, shipmentCodById]);
  const activeRouteStopTaskByStopId = useMemo(() => {
    const m = new Map(routeStopTaskByStopId);
    for (const task of activeRouteStopTasksQuery.data?.rows ?? []) {
      if (!isRouteStopExecuteTask(task)) continue;
      const stopId = task.resource_id;
      if (typeof stopId === 'string' && stopId) m.set(stopId, task);
    }
    return m;
  }, [activeRouteStopTasksQuery.data?.rows, routeStopTaskByStopId]);
  const activeScannerCandidates = useMemo<OpsScannerCandidate[]>(() => {
    const candidates: OpsScannerCandidate[] = activeStops.map((stop) => {
      const ship = activeShipmentCodById.get(stop.shipment_id);
      const missingShipmentReadback = !ship?.id;
      return {
        id: stop.id,
        kind: 'shipment',
        kindLabel: t('dispatch.scanner.kindShipment'),
        label: ship?.tracking_number ?? String(stop.shipment_id).slice(0, 14),
        description: fill(t('dispatch.scanner.stopDescription'), {
          seq: stop.sequence_order,
          kind: stop.stop_kind ?? t('dispatch.scanner.stopKindFallback'),
        }),
        barcodes: [ship?.tracking_number, stop.shipment_id, stop.id],
        actionLabel: t('dispatch.scanner.recordLoadScan'),
        actionDescription: activeRun
          ? fill(t('dispatch.scanner.routeLoadScan'), { route: routeRunLabel(activeRun.id) })
          : t('dispatch.scanner.routeLoadScanBare'),
        disabled: missingShipmentReadback,
        disabledReason: missingShipmentReadback
          ? t('dispatch.scanner.shipmentNotLoaded')
          : undefined,
        payload: { route_stop_id: stop.id, shipment_id: stop.shipment_id },
      };
    });
    const activeShipmentIds = new Set(activeStops.map((stop) => stop.shipment_id));
    const basketCounts = new Map<string, number>();
    for (const item of activeBasketItems) {
      if (!activeShipmentIds.has(item.shipment_id)) continue;
      basketCounts.set(item.basket_id, (basketCounts.get(item.basket_id) ?? 0) + 1);
    }
    for (const basket of baskets) {
      const basketId = basket.id;
      const shipmentCount = basketCounts.get(basketId) ?? 0;
      const sameRouteOrg = activeRouteOrgId && basket.organization_id
        ? basket.organization_id === activeRouteOrgId
        : false;
      if (activeRouteOrgId && !sameRouteOrg && shipmentCount === 0) continue;
      const basketTypeLabel = basket?.basket_type ? statusLabel('basket_type', basket.basket_type) : t('dispatch.basketFallback');
      const basketStateLabel = basket?.state ? statusLabel('basket_state', basket.state) : undefined;
      const basketLabel = basket?.label ?? basket?.code ?? basketDisplayLabel(basket);
      candidates.push({
        id: `basket:${basketId}`,
        kind: 'basket',
        kindLabel: t('dispatch.scanner.kindBasket'),
        label: String(basketLabel),
        description: shipmentCount
          ? fill(t(shipmentCount === 1 ? 'dispatch.scanner.basketActiveOne' : 'dispatch.scanner.basketActiveOther'), {
            type: basketTypeLabel,
            n: shipmentCount,
          })
          : fill(t('dispatch.scanner.basketNone'), { type: basketTypeLabel }),
        barcodes: [basketId, basket?.barcode, basket?.code, basket?.label],
        actionLabel: t('dispatch.scanner.openBasket'),
        actionDescription: shipmentCount
          ? t('dispatch.scanner.openBasketLinked')
          : t('dispatch.scanner.openBasketPlain'),
        resultLabel: t('dispatch.scanner.basketOpened'),
        statusLabel: basketStateLabel,
        statusTone: basket?.state ? statusTone('basket_state', basket.state) as ChipKind : 'neutral',
        payload: { basket_id: basketId },
      });
    }
    for (const assignedDriver of drivers) {
      const runForDriver = activeRun?.driver_user_id === assignedDriver.id
        ? activeRun
        : runs.find((run) => run.driver_user_id === assignedDriver.id);
      const sameRouteOrg = activeRouteOrgId && assignedDriver.organization_id
        ? assignedDriver.organization_id === activeRouteOrgId
        : false;
      if (activeRouteOrgId && !sameRouteOrg && !runForDriver) continue;
      candidates.push({
        id: `driver:${assignedDriver.id}`,
        kind: 'driver',
        kindLabel: t('dispatch.scanner.kindDriver'),
        label: assignedDriver.name ?? assignedDriver.id,
        description: runForDriver
          ? fill(t('dispatch.scanner.assignedTo'), { route: routeRunLabel(runForDriver.id) })
          : t('dispatch.scanner.driverProfile'),
        barcodes: [assignedDriver.id, assignedDriver.driver_code, assignedDriver.name, assignedDriver.phone],
        actionLabel: t('dispatch.scanner.openDriver'),
        actionDescription: t('dispatch.scanner.openDriverProfile'),
        resultLabel: t('dispatch.scanner.driverOpened'),
        statusLabel: assignedDriver.status ? statusLabel('driver_status', assignedDriver.status) : undefined,
        statusTone: assignedDriver.status ? statusTone('driver_status', assignedDriver.status) as ChipKind : 'neutral',
        payload: { driver_id: assignedDriver.id },
      });
    }
    for (const assignedVehicle of vehicles) {
      const runForVehicle = activeRun?.vehicle_id === assignedVehicle.id
        ? activeRun
        : runs.find((run) => run.vehicle_id === assignedVehicle.id);
      const sameRouteOrg = activeRouteOrgId && assignedVehicle.organization_id
        ? assignedVehicle.organization_id === activeRouteOrgId
        : false;
      if (activeRouteOrgId && !sameRouteOrg && !runForVehicle) continue;
      candidates.push({
        id: `vehicle:${assignedVehicle.id}`,
        kind: 'vehicle',
        kindLabel: t('dispatch.scanner.kindVehicle'),
        label: vehicleDisplayLabel(assignedVehicle.id),
        description: runForVehicle
          ? fill(t('dispatch.scanner.vehicleOn'), { route: routeRunLabel(runForVehicle.id) })
          : t('dispatch.scanner.vehicleProfile'),
        barcodes: [assignedVehicle.id, assignedVehicle.plate_number, assignedVehicle.plate, assignedVehicle.code],
        actionLabel: t('dispatch.scanner.openVehicle'),
        actionDescription: t('dispatch.scanner.openVehicleProfile'),
        resultLabel: t('dispatch.scanner.vehicleOpened'),
        statusLabel: assignedVehicle.status ? statusLabel('vehicle_status', assignedVehicle.status) : undefined,
        statusTone: assignedVehicle.status ? statusTone('vehicle_status', assignedVehicle.status) as ChipKind : 'neutral',
        payload: { vehicle_id: assignedVehicle.id },
      });
    }
    if (activeRun) {
      const directory = runDirectoryById.get(activeRun.id);
      const assignment = assignmentByRunId.get(activeRun.id);
      const routeLabel = routeRunDirectoryDisplayId(activeRun.id, directory);
      candidates.push({
        id: `route:${activeRun.id}`,
        kind: 'route',
        kindLabel: t('dispatch.scanner.kindRoute'),
        label: routeLabel,
        description: fill(t(activeRunVisibleStopCount === 1 ? 'dispatch.scanner.routeActiveOne' : 'dispatch.scanner.routeActiveOther'), {
          n: activeRunVisibleStopCount,
          driver: driverDisplayName(activeRun.driver_user_id),
        }),
        barcodes: [activeRun.id, routeLabel],
        actionLabel: t('dispatch.scanner.openRoute'),
        actionDescription: t('dispatch.scanner.openRouteDispatch'),
        resultLabel: t('dispatch.scanner.routeOpened'),
        statusLabel: activeRun.status ? statusLabel('route_run_status', activeRun.status) : assignment?.assignment_status,
        statusTone: activeRun.status ? statusTone('route_run_status', activeRun.status) as ChipKind : 'neutral',
        payload: { route_run_id: activeRun.id },
      });
    }
    return candidates;
  }, [
    activeBasketItems,
    activeRouteOrgId,
    activeRun,
    activeRunVisibleStopCount,
    activeShipmentCodById,
    activeStops,
    assignmentByRunId,
    basketDisplayLabel,
    baskets,
    driverDisplayName,
    drivers,
    routeRunLabel,
    runDirectoryById,
    runs,
    t,
    vehicleDisplayLabel,
    vehicles,
  ]);
  const dispatchRefreshPending =
    runsQuery.isFetching ||
    stopsQuery.isFetching ||
    runDirectoryQuery.isFetching ||
    runAssignQuery.isFetching ||
    runAssignEventsQuery.isFetching ||
    stopReassignEventsQuery.isFetching ||
    routeStopTasksQuery.isFetching ||
    activeShipmentRowsQuery.isFetching ||
    activeRouteStopTasksQuery.isFetching;
  const activeDispatchGateFingerprint = activeRunId
    ? (dispatchGateFingerprintByRunId.get(activeRunId) ?? '')
    : '';
  const activeDepartureConfirmedAt = routeRunDepartureConfirmedAt(activeRun);
  const activeScanOutGateRaw = activeRunId ? scanOutGateByRunId[activeRunId] : undefined;
  const activeScanOutGate =
    activeScanOutGateRaw?.fingerprint === activeDispatchGateFingerprint
      ? activeScanOutGateRaw
      : undefined;
  const staleScanOutGate = Boolean(activeScanOutGateRaw && !activeScanOutGate);
  const departureGateStatus =
    !activeRun
      ? 'missing-run'
      : activeDepartureConfirmedAt
        ? 'confirmed'
      : activeScanOutGate?.status === 'clear'
        ? 'clear'
        : activeScanOutGate?.status === 'blocked'
          ? 'blocked'
          : staleScanOutGate
            ? 'stale'
            : 'required';
  const departureGateLabel =
    departureGateStatus === 'confirmed'
      ? t('dispatch.gate.confirmed')
      : departureGateStatus === 'clear'
      ? t('dispatch.gate.clear')
      : departureGateStatus === 'blocked'
        ? t('dispatch.gate.blocked')
        : departureGateStatus === 'stale'
          ? t('dispatch.gate.stale')
          : t('dispatch.gate.required');
  const departureGateHint =
    departureGateStatus === 'confirmed'
      ? fill(t('dispatch.gate.confirmedAt'), {
        time: new Date(activeDepartureConfirmedAt ?? '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      })
      : departureGateStatus === 'clear'
      ? fill(t('dispatch.gate.matched'), { scanned: activeScanOutGate?.scanned ?? 0, expected: activeScanOutGate?.expected ?? 0 })
      : departureGateStatus === 'blocked'
        ? fill(t('dispatch.gate.blockedHint'), { scanned: activeScanOutGate?.scanned ?? 0, expected: activeScanOutGate?.expected ?? 0 })
        : departureGateStatus === 'stale'
          ? t('dispatch.gate.staleHint')
          : t('dispatch.gate.requiredHint');
  const activeRunLifecycleDisabledReason = dispatchLifecycleDisabledReasonForRun(activeRun);
  const activeRunAssignment = activeRun ? assignmentByRunId.get(activeRun.id) : undefined;
  const activeRunAssignmentSelfDriver = Boolean(user.id && activeRunAssignment?.driver_user_id === user.id);
  const activeRunAssignmentCanRespond = canWriteRoutes || activeRunAssignmentSelfDriver;
  const activeRunAssignmentResponseDisabledReason =
    activeRunLifecycleDisabledReason ??
    (activeRunAssignmentCanRespond
      ? undefined
      : t('dispatch.perm.respond'));
  const scanOutReconciliationDisabledReason =
    (!activeRun ? t('dispatch.selectRunFirst') : undefined) ??
    activeRunLifecycleDisabledReason ??
    activeStopsRestrictedReason ??
    (!canWriteRoutes ? t('dispatch.perm.reconcile') : undefined);
  const scanOutReconciliationDisabled =
    Boolean(scanOutReconciliationDisabledReason) || reconcileMutation.isPending;
  const reconcileScanOutLabel = activeStopsRestricted ? (
    <>
      <span>{t('dispatch.actions.reconcile')}</span>
      <span className="cap-lock" title={activeStopsRestrictedReason}>
        <Icon name="lock" size={9} />
        <span>{t('dispatch.actions.stopDetailsRestricted')}</span>
      </span>
    </>
  ) : (
    t('dispatch.actions.reconcile')
  );
  const confirmDepartureDisabled =
    !activeRun ||
    Boolean(activeRunLifecycleDisabledReason) ||
    departureGateStatus !== 'clear' ||
    reconcileMutation.isPending ||
    confirmDepartureMutation.isPending;

  const refreshDispatchFromCanonical = useCallback(async (options?: { toast?: boolean; throwOnError?: boolean }) => {
    try {
      const [
        runsResult,
        stopsResult,
        runDirectoryResult,
        runAssignResult,
        runAssignEventsResult,
        stopReassignEventsResult,
        routeStopTasksResult,
        activeShipmentsResult,
        activeRouteStopTasksResult,
      ] = await Promise.all([
        runsQuery.refetch(),
        stopsQuery.refetch(),
        runDirectoryQuery.refetch(),
        runAssignQuery.refetch(),
        runAssignEventsQuery.refetch(),
        stopReassignEventsQuery.refetch(),
        routeStopTasksQuery.refetch(),
        activeShipmentRowsQuery.refetch(),
        activeRouteStopTasksQuery.refetch(),
      ]);
      const error = [
        runsResult,
        stopsResult,
        runDirectoryResult,
        runAssignResult,
        runAssignEventsResult,
        stopReassignEventsResult,
        routeStopTasksResult,
        activeShipmentsResult,
        activeRouteStopTasksResult,
      ].find((result) => result.error)?.error;
      if (error) throw error;
      if (runsResult.data?.rows) applyCanonicalRuns(runsResult.data.rows);
      if (stopsResult.data?.rows) applyCanonicalStops(stopsResult.data.rows);
      if (options?.toast) pushToast(t('dispatch.toast.refreshed'), 'good');
      return {
        runs: runsResult.data?.rows ?? [],
        stops: stopsResult.data?.rows ?? [],
        runDirectory: runDirectoryResult.data?.rows ?? [],
        runAssignments: runAssignResult.data?.rows ?? [],
        runAssignmentEvents: runAssignEventsResult.data?.rows ?? [],
        routeStopTasks: routeStopTasksResult.data?.rows ?? [],
        activeRouteStopTasks: activeRouteStopTasksResult.data?.rows ?? [],
      } satisfies DispatchRefreshSnapshot;
    } catch (err) {
      pushToast(t('dispatch.toast.refreshFailed'), 'danger');
      if (options?.throwOnError) throw err;
      return null;
    }
  }, [
    applyCanonicalRuns,
    applyCanonicalStops,
    runAssignEventsQuery,
    runAssignQuery,
    runDirectoryQuery,
    routeStopTasksQuery,
    activeShipmentRowsQuery,
    activeRouteStopTasksQuery,
    runsQuery,
    stopReassignEventsQuery,
    stopsQuery,
    t,
  ]);

  const assertCanonicalReadback = useCallback(async (resource: string, id: string, label: string) => {
    const row = await queryClient.fetchQuery({
      queryKey: qk.resource(resource, id),
      queryFn: () => ui_get_resource_v1<Record<string, unknown>>(resource, id),
      staleTime: 0,
    });
    if (!row) throw new Error(`${label} read-back unavailable`);
    return row;
  }, [queryClient]);

  const assertScanEventReadback = useCallback(async (scanEventId: string | null | undefined) => {
    const id = String(scanEventId ?? '').trim();
    if (!id) throw new Error('Scan event read-back unavailable');
    await assertCanonicalReadback('scan_events', id, 'Scan event');
  }, [assertCanonicalReadback]);

  const assertRouteStopLoadScanProjection = useCallback(async (stop: RouteStopRow) => {
    const row = await assertCanonicalReadback('route_stops', stop.id, 'Route stop') as RouteStopRow;
    const status = routeStopLoadScanStatus(row);
    if (status.label === 'Missing') {
      throw new Error('Route stop load-scan projection did not update');
    }
  }, [assertCanonicalReadback]);

  const assertRouteStopCloseoutReadback = useCallback(async (stop: RouteStopRow, task: RouteStopTaskRow) => {
    await assertCanonicalReadback('tasks', task.id, 'Stop closeout task');
    await assertCanonicalReadback('route_stops', stop.id, 'Route stop');
    await assertCanonicalReadback('shipments', stop.shipment_id, 'Shipment');
    await assertCanonicalReadback('route_runs', stop.route_run_id, 'Route run');
    const actions = await ui_list_resource_complete<Record<string, unknown>>('shipment_actions', {
      filter: { shipment_id: stop.shipment_id },
      sort: { key: 'timestamp', dir: 'desc' },
      page_size: 25,
    });
    if (!actions.rows.some((row) => routeStopCloseoutActionMatches(row, stop.id))) {
      throw new Error('Shipment action closeout read-back unavailable');
    }
  }, [assertCanonicalReadback]);

  async function handleRefreshDispatch() {
    await refreshDispatchFromCanonical({ toast: true });
  }

  // Drag-drop reassign (single stop → run) with optimistic move + rollback.
  const onDropToRun = useCallback(
    async (targetRunId: string, stopId: string) => {
      if (!stopId) return;
      const stop = stops.find((s) => s.id === stopId);
      if (!stop) return;
      const sourceRunId = stop.route_run_id;
      if (sourceRunId === targetRunId) return;
      const targetRun = runs.find((run) => run.id === targetRunId) ?? null;
      const tenantReason =
        dispatchLifecycleDisabledReasonForStop(stop) ??
        dispatchLifecycleDisabledReasonForRun(targetRun);
      if (tenantReason) {
        pushToast(tenantReason, 'warn');
        return;
      }
      if (!canWriteRoutes) {
        pushToast(t('dispatch.perm.reassign'), 'warn');
        return;
      }
      const target = routeStopReassignOwnerTargetForRun(
        targetRun,
        targetRun ? assignmentByRunId.get(targetRun.id) : null,
        targetRun ? runDirectoryById.get(targetRun.id) : null,
      );
      if (!target) {
        pushToast(t('dispatch.toast.needOwner'), 'warn');
        return;
      }
      try {
        const result = await reassignMutation.mutateAsync({
          stopIds: [stopId],
          target,
        });
        await refreshDispatchFromCanonical({ throwOnError: true });
        setActiveRunId(routeStopReassignResultTargetRunId(result) ?? targetRunId);
        pushToast(fill(t('dispatch.toast.reassignedOne'), { seq: stop.sequence_order, run: routeRunLabel(targetRunId) }), 'good');
      } catch {
        pushToast(t('dispatch.toast.reassignFailed'), 'danger');
      }
    },
    [assignmentByRunId, runDirectoryById, stops, reassignMutation, canWriteRoutes, refreshDispatchFromCanonical, t],
  );

  function openBulkReassignPicker() {
    if (selectedStops.size === 0) {
      pushToast(t('dispatch.toast.selectStops'), 'info');
      return;
    }
    const disabledReason = dispatchLifecycleDisabledReasonForSelectedStops(selectedStops);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    setPicker({ kind: 'bulk' });
  }

  async function handleBulkReassign(targetRunId: string) {
    const ids = Array.from(selectedStops);
    if (!ids.length) {
      pushToast(t('dispatch.toast.selectStops'), 'info');
      return;
    }
    const targetRun = runs.find((run) => run.id === targetRunId) ?? null;
    const disabledReason = dispatchLifecycleDisabledReasonForSelectedStops(ids, targetRun);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    const target = routeStopReassignOwnerTargetForRun(
      targetRun,
      targetRun ? assignmentByRunId.get(targetRun.id) : null,
      targetRun ? runDirectoryById.get(targetRun.id) : null,
    );
    if (!target) {
      pushToast(t('dispatch.toast.needOwner'), 'warn');
      return;
    }
    try {
      const result = await reassignMutation.mutateAsync({
        stopIds: ids,
        target,
      });
      await refreshDispatchFromCanonical({ throwOnError: true });
      setActiveRunId(routeStopReassignResultTargetRunId(result) ?? targetRunId);
      pushToast(fill(t('dispatch.toast.reassignedMany'), { n: ids.length }), 'good');
      setSelectedStops(new Set());
    } catch {
      pushToast(t('dispatch.toast.bulkFailed'), 'danger');
    }
  }

  function toggleStopSelection(id: string) {
    setSelectedStops((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirmDeparture() {
    if (!activeRun) {
      pushToast(t('dispatch.selectRunFirst'), 'info');
      return;
    }
    const tenantReason = dispatchLifecycleDisabledReasonForRun(activeRun);
    if (tenantReason) {
      pushToast(tenantReason, 'warn');
      return;
    }
    if (!canWriteRoutes || !canCompleteTasks) {
      pushToast(t('dispatch.perm.departure'), 'warn');
      return;
    }
    if (departureGateStatus !== 'clear') {
      pushToast(departureGateHint, 'warn');
      return;
    }
    try {
      const res = await confirmDepartureMutation.mutateAsync(activeRun.id);
      await refreshDispatchFromCanonical({ throwOnError: true });
      pushToast(
        fill(t('dispatch.toast.departureConfirmed'), {
          run: routeRunLabel(activeRun.id),
          time: new Date(res.departure_confirmed_at).toLocaleTimeString(),
        }),
        'good',
      );
    } catch (err) {
      pushToast(dispatchMutationErrorMessage(err, t('dispatch.toast.departureFailed'), t), 'danger');
    }
  }

  const waitForRunAssignmentVisibleInDispatch = useCallback(async (runId: string, driverId: string) => {
    let lastSnapshot: DispatchRefreshSnapshot | null = null;
    const selectedDriver = drivers.find((driver) => driver.id === driverId) ?? null;
    const expectedDriverLabel = String(selectedDriver?.name ?? driverDisplayName(driverId)).trim();
    const expectedVehicleId = nonBlankText(selectedDriver?.vehicle_id);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastSnapshot = await refreshDispatchFromCanonical({ throwOnError: true });
      if (!lastSnapshot) continue;
      const expectedStopIds = lastSnapshot.stops
        .filter((stop) => stop.route_run_id === runId)
        .map((stop) => stop.id)
        .filter(Boolean);
      const assignedDriverVisible = lastSnapshot.runAssignments.some((assignment) =>
        assignment.route_run_id === runId &&
        assignment.driver_user_id === driverId &&
        !['cancelled', 'canceled', 'completed'].includes(String(assignment.assignment_status ?? '').toLowerCase()),
      );
      const directoryRun = lastSnapshot.runDirectory.find((row) => row.id === runId);
      const refreshedRun = lastSnapshot.runs.find((run) => run.id === runId);
      const renderedRunRowDriverVisible =
        dispatchRunDriverLabel(directoryRun, refreshedRun, driverDisplayName) === expectedDriverLabel;
      const assignedVehicleVisible = !expectedVehicleId || (
        lastSnapshot.runAssignments.some((assignment) =>
          assignment.route_run_id === runId &&
          assignment.driver_user_id === driverId &&
          assignment.vehicle_id === expectedVehicleId,
        ) &&
        refreshedRun?.vehicle_id === expectedVehicleId &&
        directoryRun?.assignment_vehicle_id === expectedVehicleId
      );
      if (
        lastSnapshot &&
        assignedDriverVisible &&
        assignedVehicleVisible &&
        renderedRunRowDriverVisible &&
        routeRunAssignmentIsVisibleInDispatch(
          runId,
          expectedStopIds,
          lastSnapshot.runAssignments,
          [...lastSnapshot.routeStopTasks, ...lastSnapshot.activeRouteStopTasks],
        )
      ) {
        return;
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    const latestStopCount = lastSnapshot?.stops.filter((stop) => stop.route_run_id === runId).length ?? 0;
    const stopHint = latestStopCount ? ' and a route-stop task row' : '';
    throw new Error(`Driver assignment read-back did not expose the selected driver and vehicle${stopHint} in Dispatch`);
  }, [driverDisplayName, drivers, refreshDispatchFromCanonical]);

  const waitForAlternateCapacityVisibleInDispatch = useCallback(async (runId: string) => {
    let lastSnapshot: DispatchRefreshSnapshot | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastSnapshot = await refreshDispatchFromCanonical({ throwOnError: true });
      if (
        lastSnapshot &&
        routeRunAlternateCapacityIsVisibleInDispatch(
          runId,
          lastSnapshot.runAssignments,
          lastSnapshot.runDirectory,
        )
      ) {
        return;
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    const latestMode = lastSnapshot?.runDirectory.find((row) => row.id === runId)?.assignment_mode ?? 'missing';
    throw new Error(`Alternate capacity assignment read-back did not expose partner ownership in Dispatch (${latestMode})`);
  }, [refreshDispatchFromCanonical]);

  const waitForRunAssignmentResponseVisibleInDispatch = useCallback(async (
    runId: string,
    expectedStatus: string,
  ) => {
    let lastSnapshot: DispatchRefreshSnapshot | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastSnapshot = await refreshDispatchFromCanonical({ throwOnError: true });
      if (
        lastSnapshot &&
        routeRunAssignmentResponseIsVisibleInDispatch(
          runId,
          expectedStatus,
          lastSnapshot.runAssignments,
          lastSnapshot.runAssignmentEvents,
        )
      ) {
        return;
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    const latestStatus = lastSnapshot?.runAssignments.find((row) => row.route_run_id === runId)?.assignment_status ?? 'missing';
    throw new Error(`Assignment response read-back did not expose ${expectedStatus} in Dispatch (${latestStatus})`);
  }, [refreshDispatchFromCanonical]);

  async function handleRouteAssignmentResponse(
    runId: string,
    actionKey: RouteAssignmentResponseAction,
    params: RouteRunAssignmentResponseParams = {},
  ) {
    const run = runs.find((row) => row.id === runId) ?? null;
    const assignment = assignmentByRunId.get(runId);
    const tenantReason = dispatchLifecycleDisabledReasonForRun(run);
    if (tenantReason) {
      pushToast(tenantReason, 'warn');
      return;
    }
    const selfDriver = Boolean(user.id && assignment?.driver_user_id === user.id);
    if (!canWriteRoutes && !selfDriver) {
      pushToast(t('dispatch.perm.respondToast'), 'warn');
      return;
    }
    try {
      const expectedStatus = routeAssignmentExpectedStatus(actionKey);
      const responseParams: RouteRunAssignmentResponseParams = {
        ...params,
        idempotency_key:
          params.idempotency_key ??
          `console-v2-assignment-response-${actionKey}-${runId}-v${assignment?.assignment_version ?? 0}`,
        response_metadata: {
          ...(params.response_metadata ?? {}),
          console_surface: 'operate.dispatch',
          route_run_id: runId,
        },
      };
      setActiveRunId(runId);
      await runAssignmentResponseMutation.mutateAsync({
        runId,
        actionKey,
        params: responseParams,
      });
      await waitForRunAssignmentResponseVisibleInDispatch(runId, expectedStatus);
      pushToast(
        fill(t('dispatch.toast.responseRecorded'), {
          action: routeAssignmentResponseActionLabel(actionKey, t),
          run: routeRunLabel(runId),
        }),
        'good',
      );
    } catch {
      pushToast(t('dispatch.toast.responseFailed'), 'danger');
    }
  }

  function openRouteAssignmentRefusal(runId: string) {
    modal.open({
      title: fill(t('dispatch.assignment.refuseTitle'), { run: routeRunLabel(runId) }),
      body: (
        <AssignmentRefusalForm
          onCancel={() => modal.close()}
          onSubmit={(payload) => {
            modal.close();
            void handleRouteAssignmentResponse(runId, 'route_runs.refuse_assignment', payload);
          }}
        />
      ),
    });
  }

  async function handleAssignDriver(runId: string, driverId: string) {
    const run = runs.find((row) => row.id === runId) ?? null;
    const tenantReason = dispatchLifecycleDisabledReasonForRun(run);
    if (tenantReason) {
      pushToast(tenantReason, 'warn');
      return;
    }
    // Canonical 6-arg target shape per migration
    // 202604061430_uc076_route_run_assignment_lifecycle_foundation_v1.sql:1147
    // (api wrapper). The hook invalidates qk.list('route_runs') so the run
    // row driver string refreshes after success.
    try {
      const selectedDriver = drivers.find((d) => d.id === driverId) ?? null;
      const target = routeRunAssignTargetForDriver(selectedDriver ?? { id: driverId }, scope.tenant?.id);

      setActiveRunId(runId);
      await runAssignMutation.mutateAsync({
        runId,
        target,
      });
      pushToast(
        fill(t('dispatch.toast.driverAssigned'), {
          run: routeRunLabel(runId),
          driver: selectedDriver?.name ?? driverId.slice(0, 8),
        }),
        'good',
      );
      void waitForRunAssignmentVisibleInDispatch(runId, driverId).catch(() => {
        void refreshDispatchFromCanonical({ throwOnError: false });
      });
    } catch (err) {
      pushToast(dispatchMutationErrorMessage(err, t('dispatch.toast.driverAssignFailed'), t), 'danger');
    }
  }

  async function handleAssignAlternateCapacity(runId: string) {
    const run = runs.find((row) => row.id === runId) ?? null;
    const tenantReason = dispatchLifecycleDisabledReasonForRun(run);
    if (tenantReason) {
      pushToast(tenantReason, 'warn');
      return;
    }
    const request = routeRunAlternateCapacityRequest(run);
    if (!request) {
      pushToast(t('dispatch.toast.capacityMissing'), 'warn');
      return;
    }
    try {
      const target: RouteRunAssignTarget = {
        assignment_mode: ALTERNATE_CAPACITY_ASSIGNMENT_MODE,
        use_alternate_capacity: true,
        idempotency_key: `console-v2-alt-capacity-${runId}`,
      };
      if (scope.tenant?.id) target.organization_id = scope.tenant.id;

      setActiveRunId(runId);
      await runAssignMutation.mutateAsync({ runId, target });
      await waitForAlternateCapacityVisibleInDispatch(runId);
      pushToast(
        fill(t('dispatch.toast.capacityAssigned'), {
          run: routeRunLabel(runId),
          demand: request.demandClass ?? t('dispatch.toast.alternateCapacity'),
        }),
        'good',
      );
    } catch {
      pushToast(t('dispatch.toast.capacityFailed'), 'danger');
    }
  }

  async function handleReconcileScanOut() {
    if (!activeRun) {
      pushToast(t('dispatch.selectRunFirst'), 'info');
      return;
    }
    const tenantReason = dispatchLifecycleDisabledReasonForRun(activeRun);
    if (tenantReason) {
      pushToast(tenantReason, 'warn');
      return;
    }
    if (activeStopsRestrictedReason) {
      pushToast(activeStopsRestrictedReason, 'warn');
      return;
    }
    if (!canWriteRoutes) {
      pushToast(t('dispatch.perm.reconcile'), 'warn');
      return;
    }
    try {
      const res = await reconcileMutation.mutateAsync(activeRun.id);
      const refreshed = await refreshDispatchFromCanonical({ throwOnError: true });
      const refreshedRun = refreshed?.runs.find((run) => run.id === activeRun.id) ?? activeRun;
      const refreshedAssignment =
        refreshed?.runAssignments.find((assignment) => assignment.route_run_id === activeRun.id) ??
        assignmentByRunId.get(activeRun.id);
      const refreshedStopFingerprint = refreshed
        ? routeRunStopFingerprint(refreshed.stops.filter((stop) => stop.route_run_id === activeRun.id))
        : activeDispatchGateFingerprint;
      const refreshedGateFingerprint = routeRunDispatchGateFingerprint(
        refreshedRun,
        refreshedAssignment,
        refreshedStopFingerprint,
      );
      setScanOutGateByRunId((current) => ({
        ...current,
        [activeRun.id]: {
          runId: activeRun.id,
          status: res.discrepancies.length === 0 ? 'clear' : 'blocked',
          expected: res.expected,
          scanned: res.scanned,
          discrepancies: res.discrepancies,
          checkedAt: new Date().toISOString(),
          fingerprint: refreshedGateFingerprint,
        },
      }));
      drawer.open({
        title: fill(t('dispatch.reconcile.title'), { run: routeRunLabel(activeRun.id) }),
        size: 'sm',
        body: (
          <div>
            <div className="card" style={{ marginBottom: '8px' }}>
              <div className="eyebrow">{t('dispatch.reconcile.expected')}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '24px', fontWeight: 600 }}>{res.expected}</div>
            </div>
            <div className="card" style={{ marginBottom: '8px' }}>
              <div className="eyebrow">{t('dispatch.reconcile.scanned')}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '24px', fontWeight: 600 }}>{res.scanned}</div>
            </div>
            <div className="card">
              <div className="eyebrow">{t('dispatch.reconcile.discrepancies')}</div>
              {res.discrepancies.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Dot kind="good" />
                  <span>{t('dispatch.reconcile.none')}</span>
                </div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '18px' }}>
                  {res.discrepancies.map((d, i) => (
                    <li key={i} className="mono" style={{ fontSize: '11px' }}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ),
      });
    } catch {
      pushToast(t('dispatch.toast.reconcileFailed'), 'danger');
    }
  }

  async function recordLoadScan(stop: RouteStopRow, barcodeOverride?: string) {
    const tenantReason = dispatchLifecycleDisabledReasonForStop(stop);
    if (tenantReason) {
      pushToast(tenantReason, 'warn');
      return;
    }
    const ship = activeShipmentCodById.get(stop.shipment_id);
    if (!ship?.id) {
      throw new Error('Shipment row read-back is required before recording a route load scan');
    }
    const barcode = String(barcodeOverride || ship?.tracking_number || stop.shipment_id).trim();
    if (!barcode) {
      pushToast(t('dispatch.toast.barcodeRequired'), 'warn');
      return;
    }

    const scanResult = await scanEventMutation.mutateAsync({
      organization_id: activeRun?.organization_id ?? stop.organization_id ?? scope.tenant?.id,
      scan_type: 'load',
      route_run_id: stop.route_run_id,
      route_stop_id: stop.id,
      branch_id: activeRun?.branch_id ?? undefined,
      client_id: stop.client_id,
      shipment_id: stop.shipment_id,
      barcode,
      idempotency_key: `console-v2-load:${stop.route_run_id}:${stop.id}:${barcode.toUpperCase()}`,
      metadata: {
        source: 'console_v2_dispatch',
        action: 'route_load_scan',
      },
    });
    await assertScanEventReadback(scanResult.scan_event_id);
    await assertRouteStopLoadScanProjection(stop);
    await assertCanonicalReadback('route_runs', stop.route_run_id, 'Route run');
    await refreshDispatchFromCanonical({ throwOnError: true });
    pushToast(fill(t('dispatch.toast.loadScanRecorded'), { barcode }), 'good');
  }

  async function recordUnexpectedLoadScan(scan: OpsScannerNoMatch) {
    const barcode = String(scan.normalizedCode || scan.code || '').trim();
    if (!barcode) {
      pushToast(t('dispatch.toast.barcodeRequired'), 'warn');
      return;
    }
    if (!activeRun) {
      pushToast(t('dispatch.toast.selectRunUnexpected'), 'warn');
      return;
    }
    const tenantReason = dispatchLifecycleDisabledReasonForRun(activeRun);
    if (tenantReason) {
      pushToast(tenantReason, 'warn');
      return;
    }

    const scanResult = await scanEventMutation.mutateAsync({
      organization_id: activeRun.organization_id ?? scope.tenant?.id,
      scan_type: 'load',
      route_run_id: activeRun.id,
      branch_id: activeRun.branch_id ?? undefined,
      barcode,
      idempotency_key: `console-v2-load-unexpected:${activeRun.id}:${barcode.toUpperCase()}`,
      metadata: {
        source: 'console_v2_dispatch',
        action: 'unexpected_route_load_scan',
        classification: 'unexpected',
      },
    });
    await assertScanEventReadback(scanResult.scan_event_id);
    await assertCanonicalReadback('route_runs', activeRun.id, 'Route run');
    await refreshDispatchFromCanonical({ throwOnError: true });
    pushToast(fill(t('dispatch.toast.unexpectedRecorded'), { barcode }), 'warn');
  }

  function shipmentContextFallback(shipmentId: string): Partial<Shipment> {
    const row = activeShipmentCodById.get(shipmentId);
    return {
      ...(row ?? {}),
      id: shipmentId,
      tracking_number: row?.tracking_number ?? shipmentId,
      cod_amount: row?.cod_amount ?? undefined,
      cod_currency: row?.cod_currency ?? undefined,
    } as Partial<Shipment>;
  }

  function openShipmentContext(shipmentId: string, initialTab = 'timeline') {
    const fallback = shipmentContextFallback(shipmentId);
    openShipmentContextDrawer(drawer, shipmentId, {
      fallbackShipment: fallback,
      initialTab,
    });
  }

  function formatContextDate(value: unknown): string {
    if (!value) return '—';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function linkedShipmentButtons(linkedStops: RouteStopRow[], emptyLabel: string): ReactNode {
    if (!linkedStops.length) {
      return <div className="state__hint">{emptyLabel}</div>;
    }
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {linkedStops
          .slice()
          .sort((a, b) => a.sequence_order - b.sequence_order)
          .map((stop) => {
            const shipment = activeShipmentCodById.get(stop.shipment_id);
            const scan = routeStopLoadScanStatus(stop, t);
            return (
              <div
                key={stop.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: 8,
                  alignItems: 'center',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{shipment?.tracking_number ?? shipmentShortLabel(stop.shipment_id, t)}</strong>
                    <Chip size="xs" kind={scan.tone} label={scan.label} />
                  </div>
                  <div className="state__hint">
                    {fill(t('dispatch.context.stopLine'), {
                      seq: stop.sequence_order,
                      kind: stop.stop_kind ?? t('dispatch.scanner.stopKindFallback'),
                      window: formatContextDate(stop.planned_window_start_at),
                    })}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  kind="ghost"
                  iconName="eye"
                  label={t('dispatch.context.openShipment')}
                  capability={CAP.SHIPMENTS_READ}
                  onClick={() => openShipmentContext(stop.shipment_id)}
                />
              </div>
            );
          })}
      </div>
    );
  }

  function openRouteContext(routeRunId: string) {
    const run = runs.find((row) => row.id === routeRunId)!;
    if (!run) {
      pushToast(t('dispatch.toast.routeUnavailable'), 'warn');
      return;
    }
    drawer.open({
      title: fill(t('dispatch.context.routeTitle'), { label: routeRunLabel(routeRunId) }),
      body: <ContextDrawerBody area="route" resource="route_runs" id={routeRunId} fallback={run} capability={CAP.ROUTES_READ} details={(row) => routeContextDetails(routeRunId, row)} />,
    });
  }

  function openBasketContext(basketId: string) {
    const basket = basketById.get(basketId)!;
    if (!basket) {
      pushToast(t('dispatch.toast.basketUnavailable'), 'warn');
      return;
    }
    drawer.open({
      title: fill(t('dispatch.context.basketTitle'), { label: basket.label ?? basket.code ?? basket.id }),
      body: <ContextDrawerBody area="basket" resource="baskets" id={basketId} fallback={basket} capability={CAP.BASKETS_READ} details={(row) => basketContextDetails(basketId, row)} />,
    });
  }

  function openDriverContext(driverId: string) {
    const driver = driverByUserId.get(driverId)!;
    if (!driver) {
      pushToast(t('dispatch.toast.driverUnavailable'), 'warn');
      return;
    }
    drawer.open({
      title: fill(t('dispatch.context.driverTitle'), { label: driver.name ?? driver.id }),
      body: <ContextDrawerBody area="driver" resource="drivers" id={driverId} fallback={driver} capability={CAP.FLEET_READ} details={(row) => driverContextDetails(driverId, row)} />,
    });
  }

  function openVehicleContext(vehicleId: string) {
    const vehicle = vehicleById.get(vehicleId)!;
    if (!vehicle) {
      pushToast(t('dispatch.toast.vehicleUnavailable'), 'warn');
      return;
    }
    drawer.open({
      title: fill(t('dispatch.context.vehicleTitle'), { label: vehicleDisplayLabel(vehicle.id) }),
      body: <ContextDrawerBody area="vehicle" resource="vehicle_directory" id={vehicleId} fallback={vehicle} capability={CAP.FLEET_READ} details={(row) => vehicleContextDetails(vehicleId, row)} />,
    });
  }

  // One body for the route, basket, driver and vehicle drawers: each reads its record, then lists its facts and stops.
  function ContextDrawerBody<T>({
    area,
    resource,
    id,
    fallback,
    capability,
    details,
  }: {
    area: 'route' | 'basket' | 'driver' | 'vehicle';
    resource: string;
    id: string;
    fallback: T;
    capability: string;
    details: (row: T) => { rows: KvRow[]; linkedStops: RouteStopRow[]; routeRunId?: string };
  }) {
    const query = useResource<T>(resource, id);
    if (query.error) {
      const denied = isDispatchPermissionDeniedError(query.error);
      return (
        <StateView
          kind={denied ? 'denied' : 'error'}
          title={t(`dispatch.context.${area}.unavailable`)}
          hint={dispatchReadErrorMessage(query.error, t)}
          capability={denied ? capability : undefined}
        />
      );
    }
    const row = query.data ?? (query.isLoading ? fallback : null);
    if (!row && query.isLoading) return <StateView kind="loading" />;
    if (!row) {
      return <StateView kind="empty" title={t(`dispatch.context.${area}.notFound`)} hint={t(`dispatch.context.${area}.notFoundHint`)} />;
    }
    const { rows, linkedStops, routeRunId } = details(row);
    return (
      <div data-testid={`dispatch-${area}-context-drawer`} style={{ display: 'grid', gap: 14 }}>
        <p className="state__hint" style={{ margin: 0 }}>
          {t(`dispatch.context.${area}.intro`)}
        </p>
        <KvGrid rows={rows} />
        {routeRunId ? (
          <Button
            type="button"
            kind="ghost"
            iconName="route"
            label={t('dispatch.context.inspectRoute')}
            capability={CAP.ROUTES_READ}
            onClick={() => openRouteContext(routeRunId)}
          />
        ) : null}
        <div>
          <h3 className="state__title" style={{ margin: '0 0 8px' }}>{t(`dispatch.context.${area}.shipments`)}</h3>
          {linkedShipmentButtons(linkedStops, t(`dispatch.context.${area}.empty`))}
        </div>
      </div>
    );
  }

  function routeContextDetails(routeRunId: string, run: RouteRunRow) {
    const assignment = assignmentByRunId.get(routeRunId);
    const linkedStops = stops.filter((stop) => stop.route_run_id === routeRunId);
    const rows: KvRow[] = [
      { key: 'route', label: t('dispatch.kv.route'), value: routeRunLabel(routeRunId), mono: true },
      { key: 'status', label: t('dispatch.kv.status'), value: run.status, lookup: 'route_run_status' },
      { key: 'planned_date', label: t('dispatch.kv.plannedDate'), value: run.planned_date ?? '—', mono: true },
      { key: 'driver', label: t('dispatch.kv.driver'), value: driverDisplayName(run.driver_user_id) },
      { key: 'vehicle', label: t('dispatch.kv.vehicle'), value: vehicleDisplayLabel(run.vehicle_id) },
      { key: 'stops', label: t('dispatch.kv.stops'), value: linkedStops.length, mono: true },
      { key: 'cod_total', label: t('dispatch.kv.codOnRun'), value: `${tenantCurrencyIso ?? '—'} ${codTotalByRunId.get(routeRunId) ?? 0}`, mono: true },
      { key: 'assignment_mode', label: t('dispatch.kv.assignmentMode'), value: assignment?.assignment_mode ?? '—', lookup: assignment?.assignment_mode ? 'route_assignment_mode' : undefined },
      { key: 'assignment_status', label: t('dispatch.kv.assignmentStatus'), value: assignment?.assignment_status ?? '—' },
      { key: 'departure', label: t('dispatch.kv.departure'), value: routeRunDepartureConfirmedAt(run) ? fill(t('dispatch.context.confirmedAt'), { date: formatContextDate(routeRunDepartureConfirmedAt(run)) }) : t('dispatch.context.notConfirmed') },
    ];
    return { rows, linkedStops };
  }

  function basketContextDetails(basketId: string, basket: BasketLookupRow) {
    const shipmentIdsInBasket = new Set(
      activeBasketItems
        .filter((item) => item.basket_id === basketId)
        .map((item) => item.shipment_id),
    );
    const linkedStops = activeStops.filter((stop) => shipmentIdsInBasket.has(stop.shipment_id));
    const rows: KvRow[] = [
      { key: 'label', label: t('dispatch.kv.basket'), value: basket.label ?? basket.code ?? basket.id },
      { key: 'code', label: t('dispatch.kv.code'), value: basket.code ?? basket.barcode ?? basket.id, mono: true },
      { key: 'type', label: t('dispatch.kv.type'), value: basket.basket_type ?? '—', lookup: basket.basket_type ? 'basket_type' : undefined },
      { key: 'state', label: t('dispatch.kv.state'), value: basket.state ?? '—', lookup: basket.state ? 'basket_state' : undefined },
      { key: 'capacity', label: t('dispatch.kv.capacity'), value: `${basket.current_count ?? linkedStops.length} / ${basket.capacity_count ?? '—'}`, mono: true },
      { key: 'active_route_shipments', label: t('dispatch.kv.onActiveRoute'), value: linkedStops.length, mono: true },
    ];
    return { rows, linkedStops };
  }

  function driverContextDetails(driverId: string, driver: DriverLookupRow) {
    const runForDriver = activeRun?.driver_user_id === driverId ? activeRun : runs.find((run) => run.driver_user_id === driverId);
    const linkedStops = runForDriver ? stops.filter((stop) => stop.route_run_id === runForDriver.id) : [];
    const rows: KvRow[] = [
      { key: 'name', label: t('dispatch.kv.driver'), value: driver.name ?? driver.id },
      { key: 'driver_code', label: t('dispatch.kv.driverCode'), value: driver.driver_code ?? '—', mono: true },
      { key: 'status', label: t('dispatch.kv.status'), value: driver.status ?? '—', lookup: driver.status ? 'driver_status' : undefined },
      { key: 'phone', label: t('dispatch.kv.phone'), value: driver.phone ?? '—', mono: true },
      { key: 'email', label: t('dispatch.kv.email'), value: driver.user_email ?? '—', mono: true },
      { key: 'route', label: t('dispatch.kv.route'), value: runForDriver ? routeRunLabel(runForDriver.id) : t('dispatch.context.noRoute') },
      { key: 'vehicle', label: t('dispatch.kv.vehicle'), value: runForDriver ? vehicleDisplayLabel(runForDriver.vehicle_id) : '—' },
      { key: 'stops', label: t('dispatch.kv.assignedStops'), value: linkedStops.length, mono: true },
    ];
    return { rows, linkedStops, routeRunId: runForDriver?.id };
  }

  function vehicleContextDetails(vehicleId: string, vehicle: VehicleLookupRow) {
    const runForVehicle = activeRun?.vehicle_id === vehicleId ? activeRun : runs.find((run) => run.vehicle_id === vehicleId);
    const linkedStops = runForVehicle ? stops.filter((stop) => stop.route_run_id === runForVehicle.id) : [];
    const rows: KvRow[] = [
      { key: 'vehicle', label: t('dispatch.kv.vehicle'), value: vehicleDisplayLabel(vehicle.id) },
      { key: 'plate', label: t('dispatch.kv.plate'), value: vehicle.plate_number ?? vehicle.plate ?? '—', mono: true },
      { key: 'code', label: t('dispatch.kv.code'), value: vehicle.code ?? '—', mono: true },
      { key: 'type', label: t('dispatch.kv.type'), value: vehicle.vehicle_type_label ?? vehicle.type_name ?? '—' },
      { key: 'status', label: t('dispatch.kv.status'), value: vehicle.status ?? '—', lookup: vehicle.status ? 'vehicle_status' : undefined },
      { key: 'route', label: t('dispatch.kv.route'), value: runForVehicle ? routeRunLabel(runForVehicle.id) : t('dispatch.context.noRoute') },
      { key: 'driver', label: t('dispatch.kv.driver'), value: runForVehicle ? driverDisplayName(runForVehicle.driver_user_id) : '—' },
      { key: 'stops', label: t('dispatch.kv.routeStops'), value: linkedStops.length, mono: true },
    ];
    return { rows, linkedStops, routeRunId: runForVehicle?.id };
  }

  function scannerOpenCapability(match: OpsScannerMatch): string | undefined {
    switch (match.candidate.kind) {
      case 'shipment':
        return CAP.SHIPMENTS_READ;
      case 'basket':
        return CAP.BASKETS_READ;
      case 'driver':
      case 'vehicle':
        return CAP.FLEET_READ;
      case 'route':
        return CAP.ROUTES_READ;
      default:
        return undefined;
    }
  }

  function openScannerContext(match: OpsScannerMatch) {
    const payload = match.candidate.payload ?? {};
    const shipmentId = payload.shipment_id;
    if (match.candidate.kind === 'shipment' && typeof shipmentId === 'string') {
      openShipmentContext(shipmentId);
      return;
    }
    const basketId = payload.basket_id;
    if (match.candidate.kind === 'basket' && typeof basketId === 'string') {
      openBasketContext(basketId);
      return;
    }
    const driverId = payload.driver_id;
    if (match.candidate.kind === 'driver' && typeof driverId === 'string') {
      openDriverContext(driverId);
      return;
    }
    const vehicleId = payload.vehicle_id;
    if (match.candidate.kind === 'vehicle' && typeof vehicleId === 'string') {
      openVehicleContext(vehicleId);
      return;
    }
    const routeRunId = payload.route_run_id;
    if (match.candidate.kind === 'route' && typeof routeRunId === 'string') {
      openRouteContext(routeRunId);
      return;
    }
    pushToast(t('dispatch.toast.scannerUnavailable'), 'warn');
  }

  function openStopCloseout(stop: RouteStopRow, task: RouteStopTaskRow, expectedCod: number | null, currency: string | null) {
    const stopTenantReason = dispatchLifecycleDisabledReasonForStop(stop);
    if (stopTenantReason) {
      pushToast(stopTenantReason, 'warn');
      return;
    }
    let completionKind = defaultLookupValue('delivery_completion_kind');
    let handoverMode = defaultLookupValue('delivery_handover_mode');
    let deliveredBoxNumbers = '';
    const hasExpectedCod = Number(expectedCod ?? 0) > 0;
    let paymentOutcome = '';
    let paymentMethod = hasExpectedCod ? defaultLookupValue('payment_collection_method') : '';
    let paymentAmount = '';
    let receiptContext = '';
    let recipientName = '';
    let recipientClass = '';
    let recipientIdentityKind = '';
    let recipientIdentityLast4 = '';
    let otpLast4 = '';
    let signatureArtifactId = '';
    let photoArtifactId = '';
    let signatureFile: File | null = null;
    let photoFile: File | null = null;
    let closeoutSubmitInFlight = false;
    let signatureFileNameNode: HTMLSpanElement | null = null;
    let photoFileNameNode: HTMLSpanElement | null = null;
    let proofLatitude = '';
    let proofLongitude = '';
    let proofAccuracyM = '';
    let notes = '';
    let failureReason = '';
    const closeoutDraft = { failureReason: '', notes: '' };
    const completionOptions = sortedLookupOptions('delivery_completion_kind');
    const failureReasonOptions = sortedLookupOptions('dispatch_exception_reason');
    const handoverModeOptions = sortedLookupOptions('delivery_handover_mode');
    const paymentOutcomeOptions = sortedLookupOptions('payment_collection_outcome');
    const paymentMethodOptions = sortedLookupOptions('payment_collection_method');
    let codPreviewNode: HTMLDivElement | null = null;
    const updateCodPreview = () => {
      if (!codPreviewNode) return;
      const preview = routeStopCodPreview(expectedCod, currency, paymentOutcome, paymentAmount, receiptContext, t);
      codPreviewNode.textContent = preview.label;
      codPreviewNode.dataset.tone = preview.tone;
    };
    const proofFileFromTransfer = (files: FileList | File[]) =>
      Array.from(files).find((file) => file.type.startsWith('image/') || file.type === 'application/pdf') ?? null;
    const applyProofFile = (kind: 'signature' | 'photo', file: File | null) => {
      if (kind === 'signature') {
        signatureFile = file;
        if (signatureFileNameNode) {
          signatureFileNameNode.textContent = file
            ? fill(t('dispatch.closeout.fileSelected'), { name: file.name })
            : t('dispatch.closeout.signatureHint');
          signatureFileNameNode.dataset.ready = file ? 'true' : 'false';
        }
        signatureArtifactId = '';
        return;
      }
      photoFile = file;
      photoArtifactId = '';
      if (photoFileNameNode) {
        photoFileNameNode.textContent = file
          ? fill(t('dispatch.closeout.fileSelected'), { name: file.name })
          : t('dispatch.closeout.photoHint');
        photoFileNameNode.dataset.ready = file ? 'true' : 'false';
      }
    };
    const pasteProofFile = (kind: 'signature' | 'photo', event: ClipboardEvent<HTMLDivElement>) => {
      const file = proofFileFromTransfer(event.clipboardData.files);
      if (!file) return;
      event.preventDefault();
      applyProofFile(kind, file);
    };
    const dropProofFile = (kind: 'signature' | 'photo', event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const file = proofFileFromTransfer(event.dataTransfer.files);
      if (!file) {
        pushToast(t('dispatch.toast.dropProof'), 'warn');
        return;
      }
      applyProofFile(kind, file);
    };
    modal.open({
      title: fill(t('dispatch.closeout.title'), { seq: stop.sequence_order }),
      body: (
        <div data-testid="route-stop-closeout-modal">
          <p className="state__hint" style={{ margin: '0 0 10px' }}>
            {t('dispatch.closeout.intro')}
          </p>
          <p
            className="state__hint"
            data-testid="route-stop-pod-policy-requirements"
            style={{ margin: '0 0 10px' }}
          >
            {podPolicyQuery.isLoading ? t('dispatch.pod.loading') : podProofRequirements.label}
          </p>
          <div className="field">
            <label className="field__label">{t('dispatch.closeout.completionKind')}</label>
            <select
              data-testid="route-stop-completion-kind"
              defaultValue={completionKind}
              onChange={(e) => {
                completionKind = e.target.value;
              }}
            >
              {completionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label">{t('dispatch.closeout.failureReason')}</label>
            <select
              data-testid="route-stop-failure-reason"
              defaultValue=""
              onChange={(e) => {
                failureReason = e.target.value;
                closeoutDraft.failureReason = e.target.value;
              }}
            >
              <option value="">{t('dispatch.closeout.noneCompleted')}</option>
              {failureReasonOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {failureReasonOptions.length ? (
              <div className="inline-actions" style={{ marginTop: '6px' }}>
                {failureReasonOptions.slice(0, 8).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="btn btn--ghost btn--sm"
                    data-testid={`route-stop-failure-reason-button-${option.value}`}
                    onClick={(event) => {
                      failureReason = option.value;
                      closeoutDraft.failureReason = option.value;
                      const select = document.querySelector('[data-testid="route-stop-failure-reason"]') as HTMLSelectElement | null;
                      if (select) select.value = option.value;
                      event.currentTarget.closest('[role="dialog"]')?.setAttribute('data-failure-reason', option.value);
                      event.currentTarget
                        .closest('.inline-actions')
                        ?.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')
                        .forEach((button) => button.setAttribute('aria-pressed', 'false'));
                      event.currentTarget.setAttribute('aria-pressed', 'true');
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {handoverModeOptions.length ? (
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.handoverMode')}</label>
              <select
                data-testid="route-stop-handover-mode"
                defaultValue={handoverMode}
                onChange={(e) => {
                  handoverMode = e.target.value;
                }}
              >
                {handoverModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          ) : (
            <StateView
              kind="error"
              title={t('dispatch.closeout.handoverMissingTitle')}
              hint={t('dispatch.closeout.handoverMissingHint')}
            />
          )}
          <div className="field">
            <label className="field__label">{t('dispatch.closeout.deliveredBoxes')}</label>
            <input
              data-testid="route-stop-delivered-boxes"
              placeholder="1 2"
              onChange={(e) => {
                deliveredBoxNumbers = e.target.value;
              }}
            />
          </div>
          <div
            className="state__hint"
            data-testid="route-stop-cod-preview"
            ref={(node) => {
              codPreviewNode = node;
              updateCodPreview();
            }}
            style={{ margin: '8px 0' }}
          >
            {routeStopCodPreview(expectedCod, currency, paymentOutcome, paymentAmount, receiptContext, t).label}
          </div>
          {hasExpectedCod ? (
            <>
              <div className="field">
                <label className="field__label">{t('dispatch.closeout.paymentOutcome')}</label>
                <select
                  data-testid="route-stop-payment-outcome"
                  defaultValue={paymentOutcome}
                  onChange={(e) => {
                    paymentOutcome = e.target.value;
                    updateCodPreview();
                  }}
                >
                  <option value="">{t('dispatch.closeout.selectOutcome')}</option>
                  {paymentOutcomeOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label">{t('dispatch.closeout.paymentMethod')}</label>
                <select
                  data-testid="route-stop-payment-method"
                  defaultValue={paymentMethod}
                  onChange={(e) => {
                    paymentMethod = e.target.value;
                  }}
                >
                  {paymentMethodOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label">{t('dispatch.closeout.collectedAmount')}</label>
                <input
                  data-testid="route-stop-payment-amount"
                  inputMode="decimal"
                  pattern="^[0-9]+([.][0-9]{1,2})?$"
                  defaultValue={paymentAmount}
                  onChange={(e) => {
                    paymentAmount = e.target.value;
                    updateCodPreview();
                  }}
                />
              </div>
              <div className="field">
                <label className="field__label">{t('dispatch.closeout.receiptContext')}</label>
                <input
                  data-testid="route-stop-payment-receipt"
                  placeholder={t('dispatch.closeout.receiptPlaceholder')}
                  onChange={(e) => {
                    receiptContext = e.target.value;
                    updateCodPreview();
                  }}
                />
              </div>
            </>
          ) : null}
          <div className="field">
            <label className="field__label">{t('dispatch.closeout.recipientName')}</label>
            <input
              data-testid="route-stop-recipient-name"
              placeholder={t('dispatch.closeout.recipientNamePlaceholder')}
              onChange={(e) => {
                recipientName = e.target.value;
              }}
            />
          </div>
          <div className="field">
            <label className="field__label">{t('dispatch.closeout.recipientClass')}</label>
            <input
              data-testid="route-stop-recipient-class"
              placeholder={t('dispatch.closeout.recipientClassPlaceholder')}
              onChange={(e) => {
                recipientClass = e.target.value;
              }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.identityType')}</label>
              <input
                data-testid="route-stop-identity-kind"
                placeholder={'national_id' /* i18n-literal-ok: identity kind token */}
                onChange={(e) => {
                  recipientIdentityKind = e.target.value;
                }}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.identityLast4')}</label>
              <input
                data-testid="route-stop-identity-last4"
                inputMode="text"
                maxLength={12}
                placeholder="1234"
                onChange={(e) => {
                  recipientIdentityLast4 = e.target.value;
                }}
              />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.otpLast4')}</label>
              <input
                data-testid="route-stop-otp-last4"
                inputMode="text"
                maxLength={12}
                placeholder="4321"
                onChange={(e) => {
                  otpLast4 = e.target.value;
                }}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.signatureProof')}</label>
              <div
                data-testid="route-stop-signature-proof-dropzone"
                role="button"
                tabIndex={0}
                onPaste={(event) => pasteProofFile('signature', event)}
                onDrop={(event) => dropProofFile('signature', event)}
                onDragOver={(event) => event.preventDefault()}
                style={{
                  display: 'grid',
                  gap: 6,
                  padding: '8px',
                  border: '1px dashed var(--line)',
                  borderRadius: 8,
                  background: 'var(--paper-3)',
                }}
              >
                <input
                  data-testid="route-stop-signature-file"
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => {
                    applyProofFile('signature', e.target.files?.[0] ?? null);
                  }}
                />
                <span
                  className="field__hint"
                  data-testid="route-stop-signature-file-name"
                  data-ready="false"
                  ref={(node) => {
                    signatureFileNameNode = node;
                  }}
                >
                  {t('dispatch.closeout.signatureHint')}
                </span>
              </div>
            </div>
          </div>
          <div className="field">
            <label className="field__label">{t('dispatch.closeout.photoProof')}</label>
            <div
              data-testid="route-stop-photo-proof-dropzone"
              role="button"
              tabIndex={0}
              onPaste={(event) => pasteProofFile('photo', event)}
              onDrop={(event) => dropProofFile('photo', event)}
              onDragOver={(event) => event.preventDefault()}
              style={{
                display: 'grid',
                gap: 6,
                padding: '8px',
                border: '1px dashed var(--line)',
                borderRadius: 8,
                background: 'var(--paper-3)',
              }}
            >
              <input
                data-testid="route-stop-photo-file"
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => {
                  applyProofFile('photo', e.target.files?.[0] ?? null);
                }}
              />
              <span
                className="field__hint"
                data-testid="route-stop-photo-file-name"
                data-ready="false"
                ref={(node) => {
                  photoFileNameNode = node;
                }}
              >
                {t('dispatch.closeout.photoHint')}
              </span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.latitude')}</label>
              <input
                data-testid="route-stop-proof-latitude"
                type="number"
                step="0.000001"
                placeholder="24.7136"
                onChange={(e) => {
                  proofLatitude = e.target.value;
                }}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.longitude')}</label>
              <input
                data-testid="route-stop-proof-longitude"
                type="number"
                step="0.000001"
                placeholder="46.6753"
                onChange={(e) => {
                  proofLongitude = e.target.value;
                }}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('dispatch.closeout.accuracy')}</label>
              <input
                data-testid="route-stop-proof-accuracy"
                type="number"
                min="0"
                step="1"
                placeholder="8"
                onChange={(e) => {
                  proofAccuracyM = e.target.value;
                }}
              />
            </div>
          </div>
          <div className="field">
            <label className="field__label">{t('dispatch.closeout.notes')}</label>
            <textarea
              rows={3}
              data-testid="route-stop-closeout-notes"
              onChange={(e) => {
                notes = e.target.value;
                closeoutDraft.notes = e.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('dispatch.closeout.viewProof')}
            iconName="eye"
            kind="ghost"
            capability={CAP.SHIPMENTS_READ}
            onClick={() => {
              modal.close();
              openShipmentContext(stop.shipment_id, 'evidence');
            }}
          />
          <Button
            label={t('dispatch.closeout.submit')}
            iconName="check"
            kind="primary"
            capability={CAP.TASKS_COMPLETE}
            disabled={transitionTaskMutation.isPending || !handoverModeOptions.length || podPolicyQuery.isLoading}
            title={
              !handoverModeOptions.length
                ? t('dispatch.closeout.handoverLookupRequired')
                : podPolicyQuery.isLoading
                  ? t('dispatch.closeout.policyLoading')
                  : undefined
            }
            onClick={async () => {
              if (closeoutSubmitInFlight) {
                pushToast(t('dispatch.toast.closeoutSaving'), 'warn');
                return;
              }
              const stopTenantReason = dispatchLifecycleDisabledReasonForStop(stop);
              if (stopTenantReason) {
                pushToast(stopTenantReason, 'warn');
                return;
              }
              const nextStatus = taskActionNextStatus('resolve');
              if (!nextStatus) {
                pushToast(t('dispatch.toast.nextStatusMissing'), 'danger');
                return;
              }
              try {
                const selectedFailureReason =
                  cleanOptionalText((document.querySelector('[role="dialog"][data-failure-reason]') as HTMLElement | null)?.dataset.failureReason) ??
                  cleanOptionalText(closeoutDraft.failureReason) ??
                  cleanOptionalText((document.querySelector('[data-testid="route-stop-failure-reason"]') as HTMLSelectElement | null)?.value) ??
                  cleanOptionalText(failureReason);
                const closeoutNotes =
                  closeoutDraft.notes ||
                  ((document.querySelector('[data-testid="route-stop-closeout-notes"]') as HTMLTextAreaElement | null)?.value ?? notes);
                const isFailedAttempt = Boolean(selectedFailureReason);
                const isFullDelivery = !isFailedAttempt && completionKind === 'full';
                if (isFullDelivery && podProofRequirements.photoRequired && !photoFile) {
                  pushToast(t('dispatch.toast.photoRequired'), 'danger');
                  return;
                }
                if (isFullDelivery && podProofRequirements.signatureRequired && !signatureFile) {
                  pushToast(t('dispatch.toast.signatureRequired'), 'danger');
                  return;
                }
                const handoverModeRow =
                  handoverModeOptions.find((option) => option.value === handoverMode) ?? null;
                const requiresHandoverSignature = Boolean(handoverModeRow?.metadata?.requires_signature);
                if (!isFailedAttempt && requiresHandoverSignature && !signatureFile && !signatureArtifactId) {
                  pushToast(
                    fill(t('dispatch.toast.handoverSignature'), {
                      mode: handoverModeRow?.label ?? handoverMode ?? t('dispatch.toast.selectedHandover'),
                    }),
                    'danger',
                  );
                  return;
                }
                if (
                  isFullDelivery &&
                  podProofRequirements.minArtifactCount > 0 &&
                  [photoFile, signatureFile].filter(Boolean).length < podProofRequirements.minArtifactCount
                ) {
                  pushToast(
                    fill(
                      t(podProofRequirements.minArtifactCount === 1
                        ? 'dispatch.toast.artifactsRequiredOne'
                        : 'dispatch.toast.artifactsRequiredOther'),
                      { n: podProofRequirements.minArtifactCount },
                    ),
                    'danger',
                  );
                  return;
                }
                if (isFailedAttempt && !failureReasonOptions.some((option) => option.value === selectedFailureReason)) {
                  pushToast(t('dispatch.toast.invalidFailure'), 'danger');
                  return;
                }
                const organizationId = activeRun?.organization_id ?? stop.organization_id ?? scope.tenant?.id ?? '';
                if (!organizationId) throw new Error('Organization context is missing for proof upload');
                closeoutSubmitInFlight = true;
                if (signatureFile && !signatureArtifactId) {
                  signatureArtifactId = await registerConsoleProofArtifact({
                    file: signatureFile,
                    artifactKind: 'signature',
                    organizationId,
                    taskId: task.id,
                    routeStopId: stop.id,
                    routeRunId: stop.route_run_id,
                    shipmentId: stop.shipment_id,
                  });
                }
                if (photoFile && !photoArtifactId) {
                  photoArtifactId = await registerConsoleProofArtifact({
                    file: photoFile,
                    artifactKind: 'photo',
                    organizationId,
                    taskId: task.id,
                    routeStopId: stop.id,
                    routeRunId: stop.route_run_id,
                    shipmentId: stop.shipment_id,
                  });
                }
                const { payload } = buildRouteStopCloseoutPayload({
                  stopId: stop.id,
                  shipmentId: stop.shipment_id,
                  completionKind: isFailedAttempt ? undefined : completionKind,
                  failureReason: selectedFailureReason ?? undefined,
                  deliveredBoxNumbers,
                  expectedCod,
                  currency,
                  paymentOutcome,
                  paymentMethod,
                  paymentAmount,
                  receiptContext,
                  notes: closeoutNotes,
                  handoverMode,
                  handoverModeRow,
                  recipientName,
                  recipientClass,
                  recipientIdentityKind,
                  recipientIdentityLast4,
                  otpLast4,
                  signatureArtifactId,
                  photoArtifactId,
                  latitude: proofLatitude,
                  longitude: proofLongitude,
                  accuracyM: proofAccuracyM,
                  capturedAt: new Date().toISOString(),
                });
                await transitionTaskMutation.mutateAsync({
                  taskId: task.id,
                  transition: {
                    next_status: nextStatus,
                    status_reason: selectedFailureReason ?? completionKind,
                    idempotency_key: `console-v2-route-stop-closeout:${task.id}:${stop.id}:${selectedFailureReason ?? completionKind}`,
                    payload,
                  },
                });
                await assertRouteStopCloseoutReadback(stop, task);
                await refreshDispatchFromCanonical({ throwOnError: true });
                pushToast(fill(t('dispatch.toast.closeoutSaved'), { task: task.task_id ?? task.id, status: nextStatus }), 'good');
                modal.close();
              } catch {
                pushToast(t('dispatch.toast.closeoutFailed'), 'danger');
              } finally {
                closeoutSubmitInFlight = false;
              }
            }}
          />
        </div>
      ),
    });
  }

  const pills: ReactNode[] = [
    // W56-C closure — `scopeType="tenant"` is the canonical resource-tier literal
    // for dispatch (route runs scope at tenant via current_user_org_id()).
    // `scopeId` is identity-derived. See shipments.tsx top-of-file ScopePill SSOT
    // note. The dynamic policy-resolved pill below uses `routePolicy.resolved_from`.
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    activeRun ? (
      <Chip key="run" size="xs" kind="info" label={<span className="mono">{routeRunLabel(activeRun.id)}</span>} />
    ) : null,
    activeRun ? (
      <Chip
        key="scan-out-gate"
        size="xs"
        kind={
          departureGateStatus === 'clear'
            ? 'good'
            : departureGateStatus === 'blocked'
              ? 'danger'
              : 'warn'
        }
        label={departureGateLabel}
      />
    ) : null,
  ].filter(Boolean) as ReactNode[];

  const selectedStopSourceRunIds = new Set(
    Array.from(selectedStops)
      .map((stopId) => stops.find((stop) => stop.id === stopId)?.route_run_id)
      .filter((runId): runId is string => typeof runId === 'string' && Boolean(runId)),
  );
  const selectedStopsDisabledReason = dispatchLifecycleDisabledReasonForSelectedStops(selectedStops);
  const bulkReassignTargetRuns = runs.filter((run) =>
    !selectedStopsDisabledReason &&
    !selectedStopSourceRunIds.has(run.id) &&
    !dispatchLifecycleDisabledReasonForRun(run) &&
    Boolean(routeStopReassignOwnerTargetForRun(run, assignmentByRunId.get(run.id), runDirectoryById.get(run.id))),
  );
  const bulkPickerSource: Omit<ReferenceSource, 'kind'> = {
    items: bulkReassignTargetRuns as unknown as Array<Record<string, unknown>>,
    display: (r) => {
      const row = r as unknown as RouteRunRow;
      return `${routeRunLabel(row.id)} · ${driverDisplayName(row.driver_user_id ?? null)}`;
    },
    value: (r) => (r as unknown as RouteRunRow).id,
    sub: (r) => {
      const row = r as unknown as RouteRunRow;
      const stopCount = stopsCountByRunId.get(row.id) ?? 0;
      return fill(t('dispatch.runs.pickerSub'), { vehicle: vehicleDisplayLabel(row.vehicle_id ?? null), n: stopCount });
    },
    section: t('dispatch.runs.section'),
  };
  const resolvedBulkMoveTargetRunId = bulkReassignTargetRuns.some((run) => run.id === bulkMoveTargetRunId)
    ? bulkMoveTargetRunId
    : (bulkReassignTargetRuns[0]?.id ?? '');

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader moduleKey="dispatch" />
        <StateView
          kind="denied"
          capability={CAP.ROUTES_READ}
          hint={t('dispatch.denied')}
        />
      </div>
    );
  }

  if (dispatchCriticalReadError) {
    return (
      <div className="page">
        <PageHeader moduleKey="dispatch" />
        <StateView
          kind="error"
          title={t('dispatch.loadErrorTitle')}
          hint={dispatchReadErrorMessage(dispatchCriticalReadError, t)}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="dispatch"
        pills={pills}
        actions={[
          <Button
            key="reconcile"
            label={reconcileScanOutLabel}
            iconName="scan"
            kind="ghost"
            capability={CAP.ROUTES_WRITE}
            disabled={scanOutReconciliationDisabled}
            title={scanOutReconciliationDisabledReason}
            onClick={handleReconcileScanOut}
          />,
          <Button
            key="confirm"
            label={t('dispatch.actions.confirmDeparture')}
            iconName="check"
            kind="primary"
            capabilities={[CAP.ROUTES_WRITE, CAP.TASKS_COMPLETE]}
            disabled={confirmDepartureDisabled}
            title={activeRunLifecycleDisabledReason ?? departureGateHint}
            onClick={handleConfirmDeparture}
          />,
        ]}
      />

      {/* KPI strip — driven by useDashboardKpis */}
      <div className="kpi-strip">
        {(kpis ?? []).slice(0, 6).map((k) => (
          <KPICard
            key={k.key}
            label={k.label}
            value={k.value as string | number}
            tone={k.tone as 'good' | 'warn' | 'danger' | 'info' | 'neutral' | undefined}
            delta={k.delta}
            spark={k.spark}
          />
        ))}
      </div>

      {activeRun && departureGateStatus !== 'clear' ? (
        <div className="state__hint" data-testid="departure-gate-hint" style={{ marginTop: '8px' }}>
          {departureGateHint}
        </div>
      ) : null}
      {dispatchEnrichmentReadError ? (
        <div className="state__hint" data-testid="dispatch-enrichment-read-warning" style={{ marginTop: '8px' }}>
          {t('dispatch.enrichmentWarning')}
        </div>
      ) : null}

      {runsLoading || stopsLoading ? (
        <StateView kind="loading" />
      ) : (
        <div className="three-pane">
          {/* Pane 1 — runs list */}
          <div className="pane">
            <div className="pane__header">
              <span className="pane__title" id="dispatch-pane-runs-title">{fill(t('dispatch.runs.title'), { n: runs.length })}</span>
              <div style={{ flex: 1 }} />
              <button
                className="icon-btn"
                title={t('common.refresh')}
                type="button"
                aria-label={t('common.refresh')}
                disabled={dispatchRefreshPending}
                onClick={() => void handleRefreshDispatch()}
              >
                <Icon name="refresh" size={12} />
              </button>
            </div>
            <div className="pane__body" role="region" aria-labelledby="dispatch-pane-runs-title" tabIndex={0}>
              {runs.map((r) => {
                const tone = statusTone('route_run_status', r.status) as
                  | 'good' | 'warn' | 'danger' | 'info' | 'neutral';
                // W24 — Resolve through `v_route_run_directory` projection
                // when available; fall back to in-memory aggregation +
                // lookup helpers for partner/driver/vehicle/stops.
                const directory = runDirectoryById.get(r.id);
                const partnerOwned = directory?.is_partner_run ?? isPartnerRun(r.id);
                const stopCount = directory?.stop_count ?? stopsCountByRunId.get(r.id) ?? 0;
                const driverLabel = partnerOwned
                  ? (directory?.partner_name ?? partnerNameForRun(r.id) ?? '—')
                  : dispatchRunDriverLabel(directory, r, driverDisplayName);
                const vehicleLabel = partnerOwned
                  ? t('dispatch.partnerVehicle')
                  : (directory?.vehicle_label ?? vehicleDisplayLabel(r.vehicle_id ?? null));
                const cls = ['run-row'];
                if (r.id === activeRunId) cls.push('is-active');
                if (dndOver === r.id) cls.push('dnd-over');
                const runLifecycleDisabledReason = dispatchLifecycleDisabledReasonForRun(r);
                const activeAssignment = assignmentByRunId.get(r.id);
                const alternateCapacity = routeRunAlternateCapacityRequest(r);
                const alternateCapacityAlreadyAssigned =
                  activeAssignment?.assignment_mode === ALTERNATE_CAPACITY_ASSIGNMENT_MODE;
                const alternateCapacityBlockedByCurrentOwner =
                  activeAssignment &&
                  !alternateCapacityAlreadyAssigned &&
                  !['cancelled', 'canceled', 'completed', 'refused'].includes(
                    String(activeAssignment.assignment_status ?? '').toLowerCase(),
                  );
                const alternateCapacityDisabledReason =
                  runLifecycleDisabledReason ??
                  (alternateCapacityBlockedByCurrentOwner
                    ? t('dispatch.runs.clearOwner')
                    : undefined);
                const canMoveSelectedHere =
                  selectedStops.size > 0 &&
                  !selectedStopsDisabledReason &&
                  !selectedStopSourceRunIds.has(r.id) &&
                  !runLifecycleDisabledReason &&
                  Boolean(routeStopReassignOwnerTargetForRun(r, activeAssignment, directory));
                return (
                  <div
                    key={r.id}
                    className={cls.join(' ')}
                    onClick={() => {
                      if (canMoveSelectedHere) {
                        void handleBulkReassign(r.id);
                        return;
                      }
                      setActiveRunId(r.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDndOver(r.id);
                    }}
                    onDragLeave={() => setDndOver((cur) => (cur === r.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDndOver(null);
                      const stopId = e.dataTransfer.getData('text/x-stop-id');
                      if (stopId) void onDropToRun(r.id, stopId);
                    }}
                  >
                    <div className="run-row__head">
                      <span className="run-row__id mono">{routeRunLabel(r.id)}</span>
                      <span className="run-row__driver">{driverLabel}</span>
                      <div style={{ flex: 1 }} />
                      {partnerOwned ? <Chip size="xs" kind="info" label={t('dispatch.partnerVehicle')} /> : null}
                      <Chip size="xs" kind={tone} label={statusLabel('route_run_status', r.status)} />
                      {canMoveSelectedHere ? (
                        <Button
                          label={t('dispatch.runs.moveHere')}
                          kind="ghost"
                          size="sm"
                          capability={CAP.ROUTES_WRITE}
                          disabled={reassignMutation.isPending}
                          onClick={(e?: React.MouseEvent) => {
                            e?.stopPropagation?.();
                            void handleBulkReassign(r.id);
                          }}
                        />
                      ) : null}
                      {/* CLAIM-OPERATIONS-WIRING (Phase C1) — operator can
                          assign / reassign a driver per run through the
                          assignment action path (was unwired). */}
                      <Button
                        label={t('dispatch.runs.assignDriver')}
                        iconName="user"
                        kind="ghost"
                        size="sm"
                        capability={CAP.ROUTES_WRITE}
                        disabled={runAssignMutation.isPending || Boolean(runLifecycleDisabledReason)}
                        title={runLifecycleDisabledReason}
                        onClick={(e?: React.MouseEvent) => {
                          e?.stopPropagation?.();
                          if (runLifecycleDisabledReason) {
                            pushToast(runLifecycleDisabledReason, 'warn');
                            return;
                          }
                          setPicker({ kind: 'assign-driver', runId: r.id });
                        }}
                      />
                      {alternateCapacity ? (
                        <Button
                          label={alternateCapacityAlreadyAssigned ? t('dispatch.runs.capacityAssigned') : t('dispatch.runs.assignCapacity')}
                          iconName="shuffle"
                          kind="ghost"
                          size="sm"
                          capability={CAP.ROUTES_WRITE}
                          disabled={
                            runAssignMutation.isPending ||
                            alternateCapacityAlreadyAssigned ||
                            Boolean(alternateCapacityDisabledReason)
                          }
                          title={
                            alternateCapacityDisabledReason ??
                            fill(t('dispatch.runs.capacityRequest'), {
                              demand: alternateCapacity.demandClass ?? t('dispatch.runs.alternate'),
                              id: alternateCapacity.marketplaceRequestId,
                            })
                          }
                          onClick={(e?: React.MouseEvent) => {
                            e?.stopPropagation?.();
                            if (alternateCapacityDisabledReason) {
                              pushToast(alternateCapacityDisabledReason, 'warn');
                              return;
                            }
                            if (!alternateCapacityAlreadyAssigned) {
                              void handleAssignAlternateCapacity(r.id);
                            }
                          }}
                        />
                      ) : null}
                    </div>
                    <div className="run-row__meta">
                      <span>{vehicleLabel}</span>
                      <span>{fill(t('dispatch.runs.stopCount'), { n: stopCount })}</span>
                      {r.planned_start_at ? (
                        <span className="mono">
                          {fill(t('dispatch.runs.start'), {
                            time: new Date(r.planned_start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                          })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pane 2 — stop sequence with multi-select bulk reassign */}
          <div className="pane">
            <div className="pane__header">
              <span className="pane__title" id="dispatch-pane-stops-title">{t('dispatch.stops.title')}</span>
              <div style={{ flex: 1 }} />
              <Button
                label={selectedStops.size ? fill(t('dispatch.stops.reassignCount'), { n: selectedStops.size }) : t('dispatch.stops.reassignIdle')}
                kind="ghost"
                size="sm"
                capability={CAP.ROUTES_WRITE}
                disabled={
                  selectedStops.size === 0 ||
                  reassignMutation.isPending ||
                  Boolean(selectedStopsDisabledReason)
                }
                title={selectedStopsDisabledReason}
                onClick={openBulkReassignPicker}
              />
            </div>
            <div className="pane__body" role="region" aria-labelledby="dispatch-pane-stops-title" tabIndex={0}>
              {selectedStops.size > 0 ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: '8px',
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--line)',
                    background: 'var(--panel-subtle)',
                  }}
                >
                  <label className="field">
                    <span className="field__label">{t('dispatch.stops.targetOwner')}</span>
                    <select
                      value={resolvedBulkMoveTargetRunId}
                      onChange={(event) => setBulkMoveTargetRunId(event.target.value)}
                      disabled={reassignMutation.isPending || bulkReassignTargetRuns.length === 0}
                    >
                      {bulkReassignTargetRuns.length === 0 ? (
                        <option value="">{t('dispatch.stops.noOwner')}</option>
                      ) : null}
                      {bulkReassignTargetRuns.map((run) => (
                        <option key={run.id} value={run.id}>
                          {`${routeRunLabel(run.id)} - ${
                            dispatchRunDriverLabel(
                              runDirectoryById.get(run.id),
                              run,
                              driverDisplayName,
                            ) || t('dispatch.stops.unassigned')
                          }`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={
                      reassignMutation.isPending ||
                      !canWriteRoutes ||
                      !resolvedBulkMoveTargetRunId ||
                      Boolean(selectedStopsDisabledReason)
                    }
                    aria-disabled={
                      reassignMutation.isPending ||
                      !canWriteRoutes ||
                      !resolvedBulkMoveTargetRunId ||
                      Boolean(selectedStopsDisabledReason) ||
                      undefined
                    }
                    title={
                      !canWriteRoutes
                        ? t('dispatch.perm.routesWrite')
                        : selectedStopsDisabledReason
                    }
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (resolvedBulkMoveTargetRunId) void handleBulkReassign(resolvedBulkMoveTargetRunId);
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (resolvedBulkMoveTargetRunId) void handleBulkReassign(resolvedBulkMoveTargetRunId);
                    }}
                  >
                    {t('dispatch.stops.moveSelected')}
                  </button>
                </div>
              ) : null}
              {!activeStops.length ? (
                <div className="state__hint" style={{ padding: '20px', textAlign: 'center' }}>
                  {activeStopsRestricted
                    ? fill(t(activeRunVisibleStopCount === 1 ? 'dispatch.stops.restrictedOne' : 'dispatch.stops.restrictedOther'), {
                      n: activeRunVisibleStopCount,
                    })
                    : t('dispatch.stops.empty')}
                </div>
              ) : (
                <>
                  <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
                    <OpsScannerPanel
                      title={t('dispatch.scanner.panelTitle')}
                      contextLabel={t('dispatch.scanner.panelContext')}
                      candidates={activeScannerCandidates}
                      capability={CAP.TASKS_COMPLETE}
                      actionDisabled={(match, actionableNoMatch) =>
                        Boolean(activeDepartureConfirmedAt) &&
                        (actionableNoMatch || !match || match.candidate.kind === 'shipment')
                      }
                      actionDisabledReason={t('dispatch.scanner.lockedReason')}
                      actionCapability={(match) => {
                        if (!match) return CAP.TASKS_COMPLETE;
                        return ['basket', 'driver', 'vehicle', 'route'].includes(match.candidate.kind)
                          ? scannerOpenCapability(match)
                          : CAP.TASKS_COMPLETE;
                      }}
                      busy={scanEventMutation.isPending}
                      noMatchActionLabel={t('dispatch.scanner.noMatchAction')}
                      noMatchDescription={t('dispatch.scanner.noMatchDescription')}
                      canOpenCandidate={(match) =>
                        !match.candidate.disabled &&
                        ['shipment', 'basket', 'driver', 'vehicle', 'route'].includes(match.candidate.kind)
                      }
                      openCandidateCapability={scannerOpenCapability}
                      onOpenCandidate={openScannerContext}
                      onCommit={async (match: OpsScannerMatch) => {
                        if (['basket', 'driver', 'vehicle', 'route'].includes(match.candidate.kind)) {
                          openScannerContext(match);
                          return;
                        }
                        const stop = activeStops.find((row) => row.id === match.candidate.id);
                        if (!stop) {
                          pushToast(t('dispatch.toast.scannerNotActionable'), 'warn');
                          return;
                        }
                        try {
                          await recordLoadScan(stop, match.code);
                        } catch (err) {
                          pushToast(t('dispatch.toast.loadScanFailed'), 'danger');
                          throw err;
                        }
                      }}
                      onNoMatchCommit={async (scan) => {
                        try {
                          await recordUnexpectedLoadScan(scan);
                        } catch (err) {
                          pushToast(t('dispatch.toast.unexpectedFailed'), 'danger');
                          throw err;
                        }
                      }}
                    />
                  </div>
                  <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
                    <RouteStopMap
                      testId="dispatch-active-run-map"
                      stops={activeStops}
                      shipments={shipments}
                      geocodes={geocodes}
                      tileProvider={mapTileProvider}
                      bounds={mapDefaultViewport}
                      height={220}
                      title={t('dispatch.map.title')}
                      emptyLabel={t('dispatch.map.empty')}
                    />
                  </div>
                  <div className="state__hint" style={{ padding: '8px 14px', fontSize: '10.5px', borderBottom: '1px solid var(--line)' }}>
                    {t('dispatch.stops.tip')}
                  </div>
                  <div className="dt">
                    <table className="dt__table" style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th aria-label={t('dispatch.stops.colSelect')}>{}</th>
                          <th>#</th>
                          <th>{t('dispatch.stops.colShipment')}</th>
                          <th>{t('dispatch.stops.colKind')}</th>
                          <th>{t('dispatch.stops.colWindow')}</th>
                          <th className="cell-num">{t('dispatch.stops.colCod')}</th>
                          <th>{t('dispatch.stops.colLoadScan')}</th>
                          <th>{t('dispatch.stops.colCloseout')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeStops.slice(0, 40).map((s) => {
                          const checked = selectedStops.has(s.id);
                          const ship = activeShipmentCodById.get(s.shipment_id);
                          const stopCod = typeof ship?.cod_amount === 'number' ? (ship.cod_amount as number) : null;
                          const stopTask = activeRouteStopTaskByStopId.get(s.id) ?? null;
                          const stopLifecycleDisabledReason = dispatchLifecycleDisabledReasonForStop(s);
                          const shipmentLabel = ship?.tracking_number ?? String(s.shipment_id).slice(0, 14);
                          const closeoutDisabledReason = stopLifecycleDisabledReason ?? routeStopCloseoutDisabledReason({
                            task: stopTask,
                            departureConfirmedAt: activeDepartureConfirmedAt,
                            pending: transitionTaskMutation.isPending,
                          }, t);
                          const loadScan = routeStopLoadScanStatus(s, t);
                          const deliveryOption = routeStopDeliveryOption(s, t);
                          const start = s.planned_window_start_at
                            ? new Date(s.planned_window_start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : '—';
                          const end = s.planned_window_end_at
                            ? new Date(s.planned_window_end_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : '—';
                          return (
                            <tr
                              key={s.id}
                              className={`dnd-stop ${checked ? 'is-selected' : ''}`}
                              draggable
                              title={t('dispatch.stops.dragHint')}
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/x-stop-id', s.id);
                                e.dataTransfer.setData('text/plain', `${s.shipment_id} stop #${s.sequence_order}`);
                              }}
                            >
                              <td className="dt-checkbox">
                                <input
                                  type="checkbox"
                                  aria-label={fill(t('dispatch.stops.selectStop'), { seq: s.sequence_order })}
                                  checked={checked}
                                  onChange={() => toggleStopSelection(s.id)}
                                />
                              </td>
                              <td className="mono">{String(s.sequence_order)}</td>
                              <td className="mono cell-id">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <Button
                                    label={shipmentLabel}
                                    iconName="eye"
                                    kind="ghost"
                                    size="sm"
                                    capability={CAP.SHIPMENTS_READ}
                                    onClick={(e?: React.MouseEvent) => {
                                      e?.stopPropagation?.();
                                      openShipmentContext(s.shipment_id);
                                    }}
                                  />
                                  <Button
                                    label={t('dispatch.stops.evidence')}
                                    iconName="file"
                                    kind="ghost"
                                    size="sm"
                                    capability={CAP.SHIPMENTS_READ}
                                    onClick={(e?: React.MouseEvent) => {
                                      e?.stopPropagation?.();
                                      openShipmentContext(s.shipment_id, 'evidence');
                                    }}
                                  />
                                </div>
                              </td>
                              <td>
                                {s.stop_kind ?? '—'}
                                {deliveryOption ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBlockStart: 4 }}>
                                    <Chip size="xs" kind={deliveryOption.tone} label={deliveryOption.label} />
                                    {deliveryOption.instruction ? (
                                      <span className="state__hint"><bdi>{deliveryOption.instruction}</bdi></span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </td>
                              <td className="mono">{`${start}–${end}`}</td>
                              <td className="cell-num mono">{stopCod != null ? String(stopCod) : '—'}</td>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <Chip size="xs" kind={loadScan.tone} label={loadScan.label} />
                                  {loadScan.detail ? <span className="mono state__hint">{loadScan.detail}</span> : null}
                                  <Button
                                    label={t('dispatch.stops.scanLoad')}
                                    iconName="scan"
                                    kind="ghost"
                                    size="sm"
                                    capability={CAP.TASKS_COMPLETE}
                                    disabled={
                                      Boolean(activeDepartureConfirmedAt) ||
                                      scanEventMutation.isPending ||
                                      Boolean(stopLifecycleDisabledReason)
                                    }
                                    title={
                                      stopLifecycleDisabledReason ??
                                      (activeDepartureConfirmedAt
                                        ? t('dispatch.stops.departureConfirmed')
                                        : undefined)
                                    }
                                    onClick={async (e?: React.MouseEvent) => {
                                      e?.stopPropagation?.();
                                      if (stopLifecycleDisabledReason) {
                                        pushToast(stopLifecycleDisabledReason, 'warn');
                                        return;
                                      }
                                      try {
                                        await recordLoadScan(s);
                                      } catch {
                                        pushToast(t('dispatch.toast.loadScanFailed'), 'danger');
                                      }
                                    }}
                                  />
                                </div>
                              </td>
                              <td>
                                <Button
                                  label={t('dispatch.stops.closeStop')}
                                  iconName="check"
                                  kind="ghost"
                                  size="sm"
                                  capability={CAP.TASKS_COMPLETE}
                                  disabled={Boolean(closeoutDisabledReason)}
                                  title={closeoutDisabledReason ?? undefined}
                                  onClick={(e?: React.MouseEvent) => {
                                    e?.stopPropagation?.();
                                    if (!stopTask || closeoutDisabledReason) return;
                                    openStopCloseout(s, stopTask, stopCod, ship?.cod_currency ?? tenantCurrencyIso);
                                  }}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Pane 3 — insight rail with LadderViz */}
          <div className="pane">
            <div className="pane__header">
              <span className="pane__title" id="dispatch-pane-insights-title">{t('dispatch.insight.title')}</span>
            </div>
            <div className="pane__body" role="region" aria-labelledby="dispatch-pane-insights-title" tabIndex={0}>
              {activeRun ? (
                <>
                  <InsightCard
                    label={t('dispatch.insight.activeRun')}
                    value={routeRunLabel(activeRun.id)}
                    meta={`${
                      isPartnerRun(activeRun.id)
                        ? (partnerNameForRun(activeRun.id) ?? '—')
                        : driverDisplayName(activeRun.driver_user_id ?? null)
                    } · ${
                      isPartnerRun(activeRun.id)
                        ? t('dispatch.partnerVehicle')
                        : vehicleDisplayLabel(activeRun.vehicle_id ?? null)
                    }`}
                  />
                  <InsightCard
                    label={t('dispatch.insight.stops')}
                    value={String(activeRunVisibleStopCount)}
                    meta={
                      activeRun.planned_start_at
                        ? fill(t('dispatch.runs.start'), {
                          time: new Date(activeRun.planned_start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        })
                        : undefined
                    }
                  />
                  {codFloatLoading ? (
                    <StateView
                      kind="loading"
                      hint={t('dispatch.insight.codLoading')}
                    />
                  ) : codFloatLimit == null ? (
                    <StateView
                      kind="error"
                      title={t('dispatch.insight.codMissingTitle')}
                      hint={t('dispatch.insight.codMissingHint')}
                    />
                  ) : (
                    <InsightCard
                      label={t('dispatch.insight.codFloat')}
                      value={`${tenantCurrencyIso ?? '—'} ${codTotalByRunId.get(activeRun.id) ?? 0}`}
                      meta={
                        codFloatPolicy
                          ? fill(t('dispatch.insight.codLimitScope'), { limit: codFloatLimit, scope: codFloatPolicy.resolved_from })
                          : fill(t('dispatch.insight.codLimit'), { limit: codFloatLimit })
                      }
                      tone={(codTotalByRunId.get(activeRun.id) ?? 0) > codFloatLimit ? 'warn' : undefined}
                    />
                  )}

                  {routePolicy ? (
                    <div className="insight-card">
                      <div className="insight-card__label">{t('dispatch.insight.policy')}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <ScopePill scopeType={routePolicy.resolved_from} />
                        <span style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>{t('dispatch.insight.resolved')}</span>
                      </div>
                      <LadderViz resolution={routePolicy} />
                    </div>
                  ) : null}

                  {/* OPERATIONS REAUDIT D4 (W9-4) — assignment projection card.
                       Reads route_run_assignments registry seam for the active
                       run. Surfaces assigned status,
                       assignment_mode, version, partner JSONB. */}
                  <RouteAssignmentInsight
                    runId={activeRun.id}
                    rows={runAssignQuery.data?.rows ?? []}
                    driverLabelForId={driverDisplayName}
                    canRespond={activeRunAssignmentCanRespond && !activeRunLifecycleDisabledReason}
                    respondDisabledReason={activeRunAssignmentResponseDisabledReason}
                    isResponding={runAssignmentResponseMutation.isPending}
                    onRespond={(action) => {
                      if (action === 'route_runs.refuse_assignment') {
                        openRouteAssignmentRefusal(activeRun.id);
                        return;
                      }
                      void handleRouteAssignmentResponse(activeRun.id, action);
                    }}
                  />

                  {/* OPERATIONS REAUDIT D4 (W9-4) — append-only assignment
                       event ledger for the active run. Mirrors the governed
                       audit trail (assigned -> departed -> handed_off ->
                       cancelled). */}
                  <RouteAssignmentEventsInsight
                    runId={activeRun.id}
                    rows={runAssignEventsQuery.data?.rows ?? []}
                  />

                  {/* OPERATIONS REAUDIT D4 (W9-4) — append-only stop
                       reassignment audit ledger. Filters by source/target
                       run_id so the active run shows both incoming and
                       outgoing reassigns. */}
                  <StopReassignmentInsight
                    runId={activeRun.id}
                    rows={stopReassignEventsQuery.data?.rows ?? []}
                  />

                  <FieldopsReassignRequestsInsight
                    runId={activeRun.id}
                    tasks={routeStopTasksQuery.data?.rows ?? []}
                    driverLabelForId={driverDisplayName}
                  />
                </>
              ) : (
                <StateView kind="empty" hint={t('dispatch.insight.selectRun')} />
              )}
            </div>
          </div>
        </div>
      )}

      {drawer.node}
      {modal.node}
      {picker?.kind === 'bulk' ? (
        <ReferencePicker
          open
          title={t('dispatch.insight.targetRun')}
          source={{ kind: 'reference', ...bulkPickerSource }}
          onClose={() => setPicker(null)}
          onPick={(val) => {
            setPicker(null);
            if (typeof val === 'string') void handleBulkReassign(val);
          }}
        />
      ) : null}
      {picker?.kind === 'assign-driver' ? (
        <ReferencePicker
          open
          title={t('dispatch.insight.assignDriver')}
          source={{
            kind: 'reference',
            items: assignableDrivers as unknown as Array<Record<string, unknown>>,
            display: (d) => (d as { name: string }).name,
            value: (d) => (d as { id: string }).id,
            sub: (d) => (d as { id: string }).id,
            section: t('dispatch.insight.driversSection'),
          }}
          onClose={() => setPicker(null)}
          onPick={(val) => {
            const runId = picker.runId;
            setPicker(null);
            if (typeof val === 'string') void handleAssignDriver(runId, val);
          }}
        />
      ) : null}
    </div>
  );
}

interface InsightCardProps { label: string; value: ReactNode; meta?: ReactNode; tone?: 'warn' | 'danger' }
function InsightCard({ label, value, meta, tone }: InsightCardProps) {
  const cls = ['insight-card', tone === 'warn' ? 'is-risk' : tone === 'danger' ? 'is-danger' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      <div className="insight-card__label">{label}</div>
      <div className="insight-card__value">{value}</div>
      {meta ? <div className="insight-card__meta">{meta}</div> : null}
    </div>
  );
}

// OPERATIONS REAUDIT D4 (W9-4) — read-only insight cards for the three new
// SSOT exposures. Each filters by the active run_id so the audit trail is
// scoped to whatever run the operator is inspecting.

function RouteAssignmentInsight({
  runId,
  rows,
  driverLabelForId,
  canRespond = false,
  respondDisabledReason,
  isResponding = false,
  onRespond,
}: {
  runId: string;
  rows: RouteRunAssignmentRow[];
  driverLabelForId: (id: string | null | undefined) => string;
  canRespond?: boolean;
  respondDisabledReason?: string;
  isResponding?: boolean;
  onRespond?: (action: RouteAssignmentResponseAction) => void;
}) {
  const { t } = useI18n();
  const match = rows.find((r) => r.route_run_id === runId);
  if (!match) {
    return (
      <div className="insight-card" data-testid="route_run_assignments-card">
        <div className="insight-card__label">
          <span>{t('dispatch.assignment.title')}</span>
        </div>
        <div className="insight-card__value" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
          {t('dispatch.assignment.none')}
        </div>
      </div>
    );
  }
  // W27 Cycle D — canonical `route_run_assignment_status` lookup-driven
  // tone resolution. Replaces the inline ternary
  // (completed → good / cancelled → danger / else → info). statusTone
  // surfaces 'danger' when the canonical row is missing so operators see
  // the gap loudly.
  const tone = statusTone('route_run_assignment_status', match.assignment_status) as
    | 'good' | 'warn' | 'danger' | 'info' | 'neutral';
  const actions = routeAssignmentResponseActions(match.assignment_status);
  const responseRows = [
    match.acknowledged_at
      ? fill(t('dispatch.assignment.acknowledged'), { time: new Date(match.acknowledged_at).toLocaleString() })
      : null,
    match.accepted_at ? fill(t('dispatch.assignment.accepted'), { time: new Date(match.accepted_at).toLocaleString() }) : null,
    match.refused_at ? fill(t('dispatch.assignment.refused'), { time: new Date(match.refused_at).toLocaleString() }) : null,
    match.refusal_reason ? fill(t('dispatch.assignment.reason'), { reason: match.refusal_reason }) : null,
    match.response_notes ? fill(t('dispatch.assignment.notes'), { notes: match.response_notes }) : null,
  ].filter((row): row is string => Boolean(row));
  // W71-Operate (Cycle F-R-11) closure — chip labels resolve through the
  // canonical lookup row label instead of rendering the raw enum value
  // directly. Missing canonical row fails loud via the helper's
  // `(missing)` marker. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
  return (
    <div className="insight-card" data-testid="route_run_assignments-card">
      <div className="insight-card__label">
        <span>{t('dispatch.assignment.title')}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Chip size="xs" kind={tone} label={statusLabel('route_run_assignment_status', match.assignment_status)} />
          <Chip size="xs" label={statusLabel('route_assignment_mode', match.assignment_mode)} />
          <span className="mono" style={{ color: 'var(--ink-3)' }}>{`v${match.assignment_version}`}</span>
        </div>
        {match.partner ? (
          <div className="mono" style={{ color: 'var(--ink-3)' }}>
            {fill(t('dispatch.assignment.partner'), {
              name: match.partner.partner_name ?? (match.partner.partner_id ? t('dispatch.assignment.partnerFleet') : '—'),
            })}
          </div>
        ) : null}
        {match.driver_user_id ? (
          <div className="mono" style={{ color: 'var(--ink-3)' }}>{fill(t('dispatch.assignment.driver'), { name: driverLabelForId(match.driver_user_id) })}</div>
        ) : null}
        {responseRows.length > 0 ? (
          <div className="mono" style={{ color: 'var(--ink-3)' }}>
            {responseRows.map((row) => <div key={row}>{row}</div>)}
          </div>
        ) : null}
        {actions.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingTop: '2px' }}>
            {actions.map((action) => (
              <Button
                key={action}
                size="sm"
                kind={action === 'route_runs.refuse_assignment' ? 'danger' : action === 'route_runs.accept_assignment' ? 'primary' : 'ghost'}
                label={routeAssignmentResponseActionLabel(action, t)}
                disabled={!canRespond || isResponding}
                title={!canRespond ? respondDisabledReason : undefined}
                onClick={() => onRespond?.(action)}
              />
            ))}
          </div>
        ) : (
          <div className="state__hint" style={{ fontSize: '11px' }}>
            {t('dispatch.assignment.complete')}
          </div>
        )}
      </div>
    </div>
  );
}

function AssignmentRefusalForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (payload: RouteRunAssignmentResponseParams) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const trimmedReason = reason.trim();
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedReason) return;
    onSubmit({
      refusal_reason: trimmedReason,
      response_notes: notes.trim() || undefined,
    });
  }
  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '10px' }}>
      <label className="field">
        <span>{t('dispatch.assignment.refusalReason')}</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          placeholder={t('dispatch.assignment.refusalPlaceholder')}
          required
        />
      </label>
      <label className="field">
        <span>{t('dispatch.assignment.responseNotes')}</span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          placeholder={t('dispatch.assignment.notesPlaceholder')}
        />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        <Button type="button" kind="ghost" label={t('common.cancel')} onClick={onCancel} />
        <Button type="submit" kind="danger" label={t('dispatch.assignment.recordRefusal')} disabled={!trimmedReason} />
      </div>
    </form>
  );
}

function RouteAssignmentEventsInsight({
  runId,
  rows,
}: {
  runId: string;
  rows: RouteRunAssignmentEventRow[];
}) {
  const { t } = useI18n();
  const filteredAll = rows.filter((r) => r.route_run_id === runId);
  const filtered = filteredAll.slice(-3);
  return (
    <div className="insight-card" data-testid="route_run_assignment_events-card">
      <div className="insight-card__label">
        <span>{t('dispatch.assignment.history')}</span>
        <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--ink-3)' }}>
          {`${filtered.length}/${filteredAll.length}`}
        </span>
      </div>
      {filtered.length === 0 ? (
        <div className="insight-card__value" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
          {t('dispatch.assignment.noEvents')}
        </div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '14px', fontSize: '11px' }}>
          {filtered.map((ev) => (
            <li key={ev.id} className="mono" style={{ color: 'var(--ink-3)' }}>
              {`${operatorEventLabel(ev.event_type)} · ${ev.from_status ? statusLabel('route_run_assignment_status', ev.from_status) : t('dispatch.assignment.start')}→${statusLabel('route_run_assignment_status', ev.to_status)} · v${ev.assignment_version}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StopReassignmentInsight({
  runId,
  rows,
}: {
  runId: string;
  rows: RouteStopReassignEventRow[];
}) {
  const { t } = useI18n();
  const filtered = rows.filter(
    (r) => r.source_route_run_id === runId || r.target_route_run_id === runId,
  );
  return (
    <div className="insight-card" data-testid="route_stop_reassignment_events-card">
      <div className="insight-card__label">
        <span>{t('dispatch.assignment.reassignHistory')}</span>
        <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--ink-3)' }}>
          {String(filtered.length)}
        </span>
      </div>
      {filtered.length === 0 ? (
        <div className="insight-card__value" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
          {t('dispatch.assignment.noReassigns')}
        </div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '14px', fontSize: '11px' }}>
          {filtered.slice(-3).map((ev) => {
            const dir = ev.source_route_run_id === runId ? t('dispatch.assignment.movedOut') : t('dispatch.assignment.movedIn');
            return (
              <li key={ev.id} className="mono" style={{ color: 'var(--ink-3)' }}>
                {`${dir} · ${operatorEventLabel(ev.event_type)} · ${shipmentShortLabel(ev.shipment_id, t)}`}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FieldopsReassignRequestsInsight({
  runId,
  tasks,
  driverLabelForId,
}: {
  runId: string;
  tasks: RouteStopTaskRow[];
  driverLabelForId: (id: string | null | undefined) => string;
}) {
  const { t } = useI18n();
  const requests = fieldopsReassignRequestsForRun(runId, tasks);
  return (
    <div className="insight-card" data-testid="fieldops-reassign-requests-card">
      <div className="insight-card__label">
        <span>{t('dispatch.assignment.mobileRequests')}</span>
        <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--ink-3)' }}>
          {String(requests.length)}
        </span>
      </div>
      {requests.length === 0 ? (
        <div className="insight-card__value" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
          {t('dispatch.assignment.noRequests')}
        </div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '14px', fontSize: '11px' }}>
          {requests.slice(0, 3).map((task) => {
            const metadata = objectRecord(task.metadata) ?? {};
            const targetDriverId = nonBlankText(metadata.target_driver_user_id);
            const reason = nonBlankText(metadata.reason) ?? nonBlankText(metadata.exception_notes);
            const tracking = nonBlankText(metadata.tracking_number);
            return (
              <li key={task.id} className="mono" style={{ color: 'var(--ink-3)' }}>
                {[
                  tracking ?? shipmentShortLabel(nonBlankText(metadata.shipment_id) ?? task.shipment_id ?? task.resource_id ?? task.id, t),
                  targetDriverId ? fill(t('dispatch.assignment.toDriver'), { driver: driverLabelForId(targetDriverId) }) : null,
                  reason ? fill(t('dispatch.assignment.reason'), { reason }) : null,
                ].filter(Boolean).join(' - ')}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

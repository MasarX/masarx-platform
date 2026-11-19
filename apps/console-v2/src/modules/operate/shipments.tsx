// shipments.tsx — TS/React port of demo-v2/assets/js/modules/op-shipments.js
// Shipments registry-driven browser + slide-over with 14 related tabs.
//
// Backed by:
//   • shipments (HASH partitioned by client_id), ui_read_registry.shipments
//   • ui_list_resource_v1, ui_get_shipment_timeline_v1
//   • shipment_amend_cancel_v1 / ui_execute_shipment_resort_v1 /
//     ui_execute_shipment_batch_operation_v1 / request_label_reprint /
//     reserve_delivery_slot_v1
//
// Drawer "related rail" tabs: timeline · evidence · boxes · baskets ·
// recipient · address · cod · route · tasks · comms · labels · scans ·
// decisions · audit.
//
// ─────────────────────────────────────────────────────────────────────────────
// W56-C closure — canonical ScopePill pattern for operate page headers (SSOT).
// ─────────────────────────────────────────────────────────────────────────────
// Operate modules render a `<ScopePill>` in the page header to advertise the
// resource's intrinsic scope tier. The literal `scopeType` ("tenant" or
// "client") IS canonical per-module because the tier is a property of the
// resource (e.g. `shipments` is HASH partitioned by `client_id` → client-tier;
// `route_plans`, `pickups`, `tasks`, `dispatch_runs`, `fleet/*` resolve at
// the tenant tier under `current_user_org_id()`). The literal is NOT a
// hardcoded display value — it mirrors the resource's canonical RLS scope
// from the partitioning + access-policy SSOT (`scope_type_registry`).
//
// What MUST NOT be hardcoded is the `scopeId` — that is always derived from
// `useIdentity()` (`scope.tenant?.id` / `scope.client?.id`) so the pill
// reflects the active access scope. INV-SCOPE compliance is satisfied when
// the ID is identity-derived; the tier literal is the resource contract.
//
// When a page surfaces a *resolved policy* (e.g. `dispatch.tsx` line ~870 with
// `routePolicy.resolved_from`), prefer `<ScopePill scopeType={resolved_from}/>`
// for that secondary chip — that pill advertises the ladder winner, which is
// dynamic. The page-header pill remains the resource-tier literal.
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { RelatedRail, type RelatedTab } from '@/components/RelatedRail';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal, type UseDrawerHandle } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResource,
  useCompleteResourceList,
  useResourceList,
  useResourceListsByFilters,
  useResourceRowsByIds,
  useShipmentTimeline,
  useShipmentOperationOptions,
  useShipmentAmendCancel,
  useShipmentBatchOp,
  useResortShipment,
  useReprintLabel,
  useRequeueShipmentGeocode,
  useListDeliverySlots,
  useResolveSettings,
  useTransitionTask,
  useCreateShipment,
  useEnqueueCommsAttempt,
  useRecipientUpdate,
  qk,
  refreshShipmentOperationReadModels,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { useI18n } from '@/lib/i18n';
import * as api from '@/lib/api';
import { getLookups, lookupRow } from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { humanizeToken } from '@/lib/display-text';
import { normalizeShipmentTimelineRows } from '@/lib/shipment-timeline';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';
import { defaultLabelReprintReason } from '@/lib/label-reprint';
import { e164PhoneError, isE164PhoneNumber, normalizePhoneForMatch } from '@/lib/phone';
import { todayDateInputValue } from '@/lib/date-input';
import { sanitizeOperatorMessage } from '@/components/operatorMessages';
import { reportError } from '@/lib/telemetry';
import type { ListResult } from '@/types/domain';

const AddressTabLazy = lazy(() =>
  import('./shipments-address-tab').then((module) => ({ default: module.AddressTab })),
);

// Wave 6 schema-drift remediation (OPERATIONS Section 1):
// - `risk_flag` REMOVED — fictional column on `public.shipments`. Risk is
//   derived from canonical status (`failed_attempt`, stalled `out_for_delivery`)
//   or via decision_log/policy resolution; FE computes it via `isShipmentRisk()`.
// - `destination_city` retained on the type as an OPTIONAL display alias —
//   canonical source is `addresses.city` joined via `destination_address_id`.
//   The `ui_read_registry.shipments` projection exposes it as a derived column.
//   See `__audit__/SCHEMA-DRIFT/OPERATIONS.md` Section 1 for the resolver
//   contract and Section 14 (tracking-map ShipmentRow) for the parallel finding.
export interface Shipment extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  tracking_number: string;
  client_reference_number?: string;
  carrier_reference_number?: string;
  status: string;
  service_type: string;
  cod_amount?: number;
  cod_currency?: string;
  cod_method?: string;
  payment_collection_method?: string;
  payment_collection_outcome?: string;
  payment_collection_status?: string;
  payment_collection_expected_at?: string;
  promised_delivery_date?: string;
  destination_city?: string; // derived projection alias from `addresses.city`
  destination_address_id?: string;
  recipient_id?: string;
  box_count?: number;
}

const SHIPMENT_SUMMARY_EDIT_KEYS = new Set([
  'client_reference_number',
  'carrier_reference_number',
  'status',
  'service_type',
]);

function normalizeShipmentSummaryEditValue(value: unknown): string {
  return String(value ?? '').trim();
}

function assertShipmentSummaryReadback(
  row: Shipment | null,
  key: string,
  expected: unknown,
): void {
  if (!row) throw new Error('Shipment read-back unavailable');
  const actual = normalizeShipmentSummaryEditValue(row[key]);
  const next = normalizeShipmentSummaryEditValue(expected);
  if (actual !== next) {
    throw new Error(`Shipment ${key} read-back did not match`);
  }
}

type ShipmentOperationName = 'modify' | 'address' | 'reschedule' | 'cancel';

function operationGuard(
  options: api.ShipmentAmendCancelOptions | undefined,
  operation: ShipmentOperationName,
): api.ShipmentOperationGuardState | null {
  const guard = options?.operations?.[operation];
  return guard && typeof guard === 'object' ? guard : null;
}

function operationGuardStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function policyBlockedReasonText(
  guard: api.ShipmentOperationGuardState | null,
  actionLabel: string,
): string {
  const reason = typeof guard?.reason === 'string' && guard.reason.trim()
    ? humanizeToken(guard.reason)
    : 'Policy check did not approve this action';
  const allowedStatuses = operationGuardStringArray(guard?.allowed_statuses);
  const allowedText = allowedStatuses.length
    ? ` Allowed statuses: ${allowedStatuses.map((status) => humanizeToken(status)).join(', ')}.`
    : '';
  return `Shipment policy blocks ${actionLabel}: ${reason}.${allowedText}`;
}

function operationDisabledReason(
  options: api.ShipmentAmendCancelOptions | undefined,
  state: { isLoading: boolean; hasError: boolean },
  operation: ShipmentOperationName,
  actionLabel: string,
): string | undefined {
  if (state.isLoading) return 'Checking shipment policy';
  if (state.hasError || !options) return 'Shipment policy unavailable';
  const guard = operationGuard(options, operation);
  if (guard?.allowed === true) return undefined;
  return policyBlockedReasonText(guard, actionLabel);
}

function anyOperationDisabledReason(
  options: api.ShipmentAmendCancelOptions | undefined,
  state: { isLoading: boolean; hasError: boolean },
  operations: ShipmentOperationName[],
  actionLabel: string,
): string | undefined {
  if (state.isLoading) return 'Checking shipment policy';
  if (state.hasError || !options) return 'Shipment policy unavailable';
  if (operations.some((operation) => operationGuard(options, operation)?.allowed === true)) return undefined;
  return policyBlockedReasonText(operationGuard(options, operations[0]), actionLabel);
}

const ROW_ACTION_POLICY_CHECK_REASON = 'Open detail to check shipment policy first';

interface ShipmentActionPaymentRow extends Record<string, unknown> {
  id: string;
  shipment_id?: string | null;
  timestamp?: string | null;
  created_at?: string | null;
  action_data?: Record<string, unknown> | null;
  payment_collection_outcome?: string | null;
  payment_collection_method?: string | null;
  payment_expected_amount?: number | string | null;
  payment_collected_amount?: number | string | null;
  payment_variance_amount?: number | string | null;
  payment_discrepancy_kind?: string | null;
  payment_currency?: string | null;
  payment_receipt_context?: string | null;
}

interface CodPaymentProjection {
  method?: string | null;
  outcome?: string | null;
  expectedAmount?: number | null;
  collectedAmount?: number | null;
  varianceAmount?: number | null;
  discrepancyKind?: string | null;
  currency?: string | null;
  receiptContext?: string | null;
  occurredAt?: string | null;
}

export interface ShipmentPodEvidenceProjection {
  id: string;
  source: 'shipment_action' | 'task_closeout';
  sourceLabel: string;
  occurredAt?: string | null;
  completionKind?: string | null;
  handoverMode?: string | null;
  recipientName?: string | null;
  recipientClass?: string | null;
  identityKind?: string | null;
  identityLast4?: string | null;
  otpConfirmed?: boolean | null;
  otpLast4?: string | null;
  signatureArtifactId?: string | null;
  photoArtifactId?: string | null;
  artifactIds: string[];
  capturedAt?: string | null;
  geostamp?: Record<string, unknown> | null;
  routeStopId?: string | null;
  taskId?: string | null;
  notes?: string | null;
  paymentCollection?: CodPaymentProjection | null;
}

// W24 — Paired projection view `public.v_shipment_directory`
// (supabase/migrations/202604302230_v_shipment_directory.sql). Read-only
// canonical SSOT for the FE-shaped derived projections (destination_city /
// origin_city joined from addresses, client_label / sender_label /
// recipient_label joined from canonical FK targets, derived counters
// box_actual_count / label_count / scan_event_count / last_scan_at /
// comms_attempt_count / active_task_count, and is_at_risk derived flag).
// The base `Shipment` row interface keeps canonical SSOT columns; this
// directory enriches the drawer + list rendering through
// `useResourceList<ShipmentDirectoryRow>('shipment_directory')` so
// production cutover is a single getSupabaseClient() branch flip.
export interface ShipmentDirectoryRow extends Record<string, unknown> {
  id: string;
  client_id?: string | null;
  destination_city?: string | null;
  destination_district?: string | null;
  origin_city?: string | null;
  origin_district?: string | null;
  client_label?: string | null;
  sender_label?: string | null;
  recipient_label?: string | null;
  box_actual_count?: number;
  label_count?: number;
  scan_event_count?: number;
  last_scan_at?: string | null;
  comms_attempt_count?: number;
  active_task_count?: number;
  is_at_risk?: boolean;
}

const SHIPMENT_LIST_COLUMN_BLUEPRINT: Array<DataTableColumn<Shipment>> = [
  { key: 'tracking_number', label: 'Tracking', mono: true, sortable: true, filterable: true },
  { key: 'client_label', label: 'Client', sortable: true, filterable: true },
  { key: 'recipient_label', label: 'Recipient', sortable: true, filterable: true },
  { key: 'destination_city', label: 'Destination', sortable: true, filterable: true },
  { key: 'service_type', label: 'Service', lookup: 'service_type', editable: true, sortable: true, filterable: true },
  { key: 'status', label: 'Status', lookup: 'shipment_status', editable: true, sortable: true, filterable: true },
  { key: 'promised_delivery_date', label: 'Promised', format: 'datetime', sortable: true, filterable: true },
  { key: 'cod_amount', label: 'COD', type: 'number', align: 'right', format: 'currency', editable: true, sortable: true, filterable: true },
  { key: 'box_actual_count', label: 'Boxes', type: 'number', align: 'right', sortable: true, filterable: true },
  { key: 'active_task_count', label: 'Tasks', type: 'number', align: 'right', sortable: true, filterable: true },
  { key: 'last_scan_at', label: 'Last scan', format: 'datetime', sortable: true, filterable: true },
];

const RECIPIENT_LANGUAGE_LOOKUP_CATEGORY = 'language_code';

function lookupDefaultValue(category: string): string | null {
  const list = (getLookups(category) ?? []) as Array<{ value: string; is_default?: boolean }>;
  return list.find((r) => r.is_default)?.value ?? null;
}

export function resolveShipmentListColumns(
  registryColumns: Array<DataTableColumn<Shipment>> | undefined,
): Array<DataTableColumn<Shipment>> {
  const registryByKey = new Map((registryColumns ?? []).map((column) => [column.key, column]));
  return SHIPMENT_LIST_COLUMN_BLUEPRINT.map((column) => ({
    ...(registryByKey.get(column.key) ?? {}),
    ...column,
    hidden: false,
  }));
}

export function resolveShipmentFocus(search: string, hash: string): string | null {
  const fromSearch = new URLSearchParams(search).get('focus');
  if (fromSearch) return fromSearch;

  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return new URLSearchParams(query).get('focus');
}

function isPermissionDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /42501|permission denied|requires .*permission|requires .*capability/i.test(message);
}

function operatorShipmentCreateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/shipment_status_not_allowed|status/i.test(message)) {
    return 'Shipment creation is blocked by the current shipment state. Check the shipment details and try again.';
  }
  if (/address amendment failed|geocode|address/i.test(message)) {
    return 'Address verification failed. Check the destination address and try again.';
  }
  return sanitizeOperatorMessage(
    message,
    'Shipment could not be created. Check the form and try again.',
  );
}

export function compactReferenceToken(raw: unknown, label = 'Reference'): string {
  const value = String(raw ?? '').trim();
  if (!value) return '—';
  const parts = value
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const meaningful = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const suffix = String(meaningful ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(-6);
  return `${label} #${suffix || 'UNKNOWN'}`;
}

function compactReference(raw: unknown, label = 'Reference'): ReactNode {
  const compact = compactReferenceToken(raw, label);
  if (compact === '—') return compact;
  return (
    <span className="mono" title={`${label} reference`}>
      {compact}
    </span>
  );
}

function titleCaseKey(raw: unknown, fallback = 'Not recorded'): string {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function lookupDisplayValue(lookup: string, value: unknown, fallback = 'Not recorded'): string {
  const token = String(value ?? '').trim();
  if (!token) return fallback;
  return String(lookupRow(lookup, token)?.label ?? titleCaseKey(token, fallback));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedRecord(value: unknown, path: string[]): Record<string, unknown> | null {
  let cursor: unknown = value;
  for (const key of path) {
    const record = asRecord(cursor);
    if (!record) return null;
    cursor = record[key];
  }
  return asRecord(cursor);
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}

function workflowMutationProofRows(
  record: Record<string, unknown>,
  slotDate?: string | null,
): KvRow[] {
  const operationResult = asRecord(record.operation_result) ?? {};
  const reserveResult = asRecord(operationResult.reserve_result) ?? {};
  const rows: KvRow[] = [
    {
      key: 'workflow_status',
      label: 'Workflow status',
      value: titleCaseKey(firstText(record.workflow_status, record.workflow_step_status), 'Not reported'),
    },
    {
      key: 'template',
      label: 'Workflow definition',
      value: firstText(record.workflow_template_name) ?? (firstText(record.workflow_template, record.workflow_template_id) ? 'Ready' : 'Not reported'),
    },
    {
      key: 'run',
      label: 'Workflow',
      value: firstText(record.workflow_run_id) ? 'Started' : 'Not reported',
    },
    {
      key: 'entrypoint',
      label: 'Workflow path',
      value: firstText(record.canonical_entrypoint, record.started_via) ? 'Confirmed' : 'Not reported',
    },
    {
      key: 'slot_date',
      label: 'Reserved date',
      value: firstText(operationResult.slot_date, slotDate) ?? 'Not applicable',
    },
    {
      key: 'shipment_action',
      label: 'Activity',
      value: firstText(record.shipment_action_id, operationResult.shipment_action_id, reserveResult.action_id)
        ? 'Recorded'
        : 'Not reported',
    },
  ];
  return rows.filter((row) => row.value !== 'Not applicable');
}

function previewSummaryRows(value: Record<string, unknown> | null | undefined): KvRow[] {
  const record = value ?? {};
  const importantKeys = [
    'status',
    'workflow_status',
    'operation',
    'op',
    'reason',
    'settings_resolution_id',
    'workflow_template',
    'workflow_run_id',
    'shipment_action_id',
    'slot_date',
  ];
  const seen = new Set<string>();
  const rows: KvRow[] = [];
  for (const key of importantKeys) {
    if (!(key in record)) continue;
    seen.add(key);
    rows.push({
      key,
      label: titleCaseKey(key),
      value: previewSummaryValue(key, record[key]),
    });
  }
  for (const [key, raw] of Object.entries(record)) {
    if (rows.length >= 6) break;
    if (seen.has(key)) continue;
    rows.push({
      key,
      label: titleCaseKey(key),
      value: previewSummaryValue(key, raw),
    });
  }
  return rows.length > 0
    ? rows
    : [{ key: 'result', label: 'Result', value: 'No visible changes returned' }];
}

function previewSummaryValue(key: string, value: unknown): string {
  if (value == null || value === '') return 'Not reported';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/_id$/.test(key) || key.includes('resolution') || key.includes('template')) {
      return compactReferenceToken(value, 'Reference');
    }
    return titleCaseKey(value);
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `${count} detail${count === 1 ? '' : 's'}`;
  }
  return String(value);
}

function WorkflowMutationProof({
  record,
  slotDate,
}: {
  record: Record<string, unknown>;
  slotDate?: string | null;
}): ReactNode {
  return (
    <div data-testid="shipment-workflow-proof" style={{ marginTop: 12 }}>
      <KvGrid rows={workflowMutationProofRows(record, slotDate)} />
    </div>
  );
}

type ShipmentRoutingQueryInvalidator = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

const SHIPMENT_ROUTING_REFRESH_LISTS = [
  'shipments',
  'shipment_directory',
  'geocodes',
  'geocoding_attempts',
  'baskets',
  'basket_items',
  'route_runs',
  'route_run_directory',
  'route_stops',
  'route_plans',
  'route_plan_directory',
  'route_plan_delivery_wave_candidates',
] as const;

export function buildShipmentRoutingRefreshPayload(
  shipment: Pick<Shipment, 'id'> & Record<string, unknown>,
): api.ShipmentUpdateGeocodeArgs {
  const payload: api.ShipmentUpdateGeocodeArgs = { shipment_id: shipment.id };
  const destinationAddressId = firstText(shipment.destination_address_id);
  const addressId = firstText(shipment.address_id);
  if (destinationAddressId) payload.destination_address_id = destinationAddressId;
  if (addressId) payload.address_id = addressId;
  return payload;
}

export function invalidateShipmentRoutingRefreshQueries(
  queryClient: ShipmentRoutingQueryInvalidator,
  shipmentId?: string | null,
): void {
  for (const resource of SHIPMENT_ROUTING_REFRESH_LISTS) {
    queryClient.invalidateQueries({ queryKey: ['list', resource] });
  }
  queryClient.invalidateQueries({ queryKey: ['resources_by_ids', 'baskets'] });
  queryClient.invalidateQueries({ queryKey: ['lists_by_filters', 'basket_items'] });
  if (shipmentId) {
    queryClient.invalidateQueries({ queryKey: qk.resource('shipments', shipmentId) });
  }
}

export function useShipmentRoutingRefresh() {
  const queryClient = useQueryClient();
  const { mutateAsync, isPending } = useRequeueShipmentGeocode();
  const refreshRouting = useCallback(
    async (shipment: Pick<Shipment, 'id'> & Record<string, unknown>) => {
      const payload = buildShipmentRoutingRefreshPayload(shipment);
      const result = await mutateAsync(payload);
      invalidateShipmentRoutingRefreshQueries(queryClient, payload.shipment_id);
      return { payload, result };
    },
    [mutateAsync, queryClient],
  );
  return { refreshRouting, isPending };
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value ?? '').trim();
    if (text && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '').trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function codPaymentProjectionFromAction(row: ShipmentActionPaymentRow | undefined): CodPaymentProjection | null {
  if (!row) return null;
  const actionData = asRecord(row.action_data);
  const payment =
    nestedRecord(actionData, ['delivery_completion', 'payment_collection'])
    ?? nestedRecord(actionData, ['task_event_payload', 'payment_collection'])
    ?? nestedRecord(actionData, ['task_event_payload', 'delivery_completion', 'payment_collection']);
  const projection: CodPaymentProjection = {
    method: firstText(row.payment_collection_method, payment?.method, payment?.payment_method),
    outcome: firstText(row.payment_collection_outcome, payment?.outcome, payment?.payment_outcome),
    expectedAmount: firstNumber(row.payment_expected_amount, payment?.expected_amount),
    collectedAmount: firstNumber(row.payment_collected_amount, payment?.collected_amount),
    varianceAmount: firstNumber(row.payment_variance_amount, payment?.variance_amount),
    discrepancyKind: firstText(row.payment_discrepancy_kind, payment?.discrepancy_kind),
    currency: firstText(row.payment_currency, payment?.currency),
    receiptContext: firstText(row.payment_receipt_context, payment?.receipt_context),
    occurredAt: firstText(row.timestamp, row.created_at),
  };
  return Object.values(projection).some((value) => value != null && value !== '') ? projection : null;
}

function latestCodPaymentProjection(rows: ShipmentActionPaymentRow[] | undefined): CodPaymentProjection | null {
  const candidates = (rows ?? [])
    .map((row) => ({ row, payment: codPaymentProjectionFromAction(row) }))
    .filter((entry): entry is { row: ShipmentActionPaymentRow; payment: CodPaymentProjection } => Boolean(entry.payment));
  candidates.sort((a, b) => {
    const at = Date.parse(String(a.payment.occurredAt ?? a.row.timestamp ?? a.row.created_at ?? ''));
    const bt = Date.parse(String(b.payment.occurredAt ?? b.row.timestamp ?? b.row.created_at ?? ''));
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
  return candidates[0]?.payment ?? null;
}

export function podEvidenceProjectionFromRow(
  row: Record<string, unknown> | undefined,
  source: ShipmentPodEvidenceProjection['source'],
): ShipmentPodEvidenceProjection | null {
  if (!row) return null;
  const actionData = asRecord(row.action_data) ?? row;
  const deliveryCompletion =
    nestedRecord(actionData, ['delivery_completion'])
    ?? nestedRecord(actionData, ['task_event_payload', 'delivery_completion'])
    ?? nestedRecord(actionData, ['route_stop_completion']);
  const taskEventPayload = nestedRecord(actionData, ['task_event_payload']);
  const pod =
    nestedRecord(deliveryCompletion, ['pod'])
    ?? nestedRecord(taskEventPayload, ['pod'])
    ?? nestedRecord(actionData, ['pod'])
    ?? deliveryCompletion
    ?? taskEventPayload
    ?? actionData;

  const signatureArtifactId = firstText(
    row.signature_artifact_id,
    row.pod_signature_artifact_id,
    deliveryCompletion?.signature_artifact_id,
    taskEventPayload?.signature_artifact_id,
    pod.signature_artifact_id,
    actionData.signature_artifact_id,
  );
  const photoArtifactId = firstText(
    row.photo_artifact_id,
    row.pod_photo_artifact_id,
    deliveryCompletion?.photo_artifact_id,
    taskEventPayload?.photo_artifact_id,
    pod.photo_artifact_id,
    actionData.photo_artifact_id,
  );
  const artifactIds = Array.from(
    new Set([
      ...stringArray(deliveryCompletion?.artifact_ids),
      ...stringArray(taskEventPayload?.artifact_ids),
      ...stringArray(pod.artifact_ids),
      ...stringArray(actionData.artifact_ids),
      ...(signatureArtifactId ? [signatureArtifactId] : []),
      ...(photoArtifactId ? [photoArtifactId] : []),
    ]),
  );
  const payment =
    firstRecord(
      deliveryCompletion?.payment_collection,
      taskEventPayload?.payment_collection,
      pod.payment_collection,
      actionData.payment_collection,
    );
  const paymentCollection: CodPaymentProjection | null = payment
    ? {
        method: firstText(row.payment_collection_method, payment.method, payment.payment_method),
        outcome: firstText(row.payment_collection_outcome, payment.outcome, payment.payment_outcome),
        expectedAmount: firstNumber(row.payment_expected_amount, payment.expected_amount),
        collectedAmount: firstNumber(row.payment_collected_amount, payment.collected_amount),
        varianceAmount: firstNumber(row.payment_variance_amount, payment.variance_amount),
        discrepancyKind: firstText(row.payment_discrepancy_kind, payment.discrepancy_kind),
        currency: firstText(row.payment_currency, payment.currency),
        receiptContext: firstText(row.payment_receipt_context, payment.receipt_context),
        occurredAt: firstText(row.timestamp, row.created_at, payment.created_at),
      }
    : null;
  const evidence: ShipmentPodEvidenceProjection = {
    id: String(row.id ?? row.task_id ?? `pod-${source}`),
    source,
    sourceLabel: source === 'shipment_action' ? 'Shipment action' : 'Task closeout',
    occurredAt: firstText(row.timestamp, row.created_at, row.completed_at, taskEventPayload?.created_at),
    completionKind: firstText(
      row.completion_kind,
      deliveryCompletion?.completion_kind,
      taskEventPayload?.completion_kind,
      pod.completion_kind,
    ),
    handoverMode: firstText(
      row.handover_mode,
      deliveryCompletion?.handover_mode,
      taskEventPayload?.handover_mode,
      pod.handover_mode,
    ),
    recipientName: firstText(
      row.recipient_name,
      deliveryCompletion?.recipient_name,
      taskEventPayload?.recipient_name,
      pod.recipient_name,
    ),
    recipientClass: firstText(
      row.recipient_class,
      deliveryCompletion?.recipient_class,
      taskEventPayload?.recipient_class,
      pod.recipient_class,
    ),
    identityKind: firstText(
      row.pod_identity_kind,
      row.recipient_identity_kind,
      deliveryCompletion?.recipient_identity_kind,
      taskEventPayload?.recipient_identity_kind,
      pod.recipient_identity_kind,
    ),
    identityLast4: firstText(
      row.pod_identity_last4,
      row.recipient_identity_last4,
      deliveryCompletion?.recipient_identity_last4,
      taskEventPayload?.recipient_identity_last4,
      pod.recipient_identity_last4,
    ),
    otpConfirmed: firstBoolean(
      row.pod_otp_confirmed,
      row.otp_confirmed,
      deliveryCompletion?.otp_confirmed,
      taskEventPayload?.otp_confirmed,
      pod.otp_confirmed,
    ),
    otpLast4: firstText(
      row.pod_otp_last4,
      row.otp_last4,
      deliveryCompletion?.otp_last4,
      taskEventPayload?.otp_last4,
      pod.otp_last4,
    ),
    signatureArtifactId,
    photoArtifactId,
    artifactIds,
    capturedAt: firstText(
      row.pod_captured_at,
      row.captured_at,
      deliveryCompletion?.captured_at,
      taskEventPayload?.captured_at,
      pod.captured_at,
    ),
    geostamp: firstRecord(
      row.pod_geostamp,
      row.geostamp,
      deliveryCompletion?.geostamp,
      taskEventPayload?.geostamp,
      pod.geostamp,
    ),
    routeStopId: firstText(
      row.route_stop_id,
      actionData.route_stop_id,
      deliveryCompletion?.route_stop_id,
      taskEventPayload?.route_stop_id,
      pod.route_stop_id,
    ),
    taskId: firstText(row.task_id, row.id),
    notes: firstText(row.notes, deliveryCompletion?.notes, deliveryCompletion?.completion_notes, taskEventPayload?.notes),
    paymentCollection,
  };
  const hasEvidence = [
    evidence.handoverMode,
    evidence.recipientName,
    evidence.recipientClass,
    evidence.identityKind,
    evidence.identityLast4,
    evidence.otpLast4,
    evidence.signatureArtifactId,
    evidence.photoArtifactId,
    evidence.paymentCollection?.outcome,
    evidence.paymentCollection?.receiptContext,
    evidence.geostamp,
    ...evidence.artifactIds,
  ].some((value) => value != null && String(value).trim() !== '');
  return hasEvidence ? evidence : null;
}

export function isCompletedRouteStopEvidenceTask(row: Record<string, unknown>): boolean {
  const taskType = String(firstText(row.task_type, row.task_type_key, row.task_type_id) ?? '').trim();
  if (taskType !== 'route_stop_execute') return false;
  if (firstText(row.completed_at, row.closed_at, row.resolved_at)) return true;
  const status = String(firstText(row.status, row.task_status, row.next_status) ?? '').trim().toLowerCase();
  return ['completed', 'closed', 'resolved', 'done'].includes(status);
}

function operatorActorLabel(raw: unknown): string {
  return String(raw ?? '').trim() ? 'Operator' : 'System';
}

function basketDirectZoneLabel(row: Record<string, unknown> | undefined): string | null {
  return row ? firstText(row.zone_label, row.zone_name, row.zone) : null;
}

function zoneDisplayLabel(row: Record<string, unknown> | undefined): string | null {
  return row ? firstText(row.zone_label, row.zone_name, row.label, row.name, row.code) : null;
}

function basketZoneLabel(
  basket: Record<string, unknown> | undefined,
  zoneById: Map<string, Record<string, unknown>>,
): string | null {
  const direct = basketDirectZoneLabel(basket);
  if (direct) return direct;
  const zoneId = basket ? firstText(basket.zone_id) : null;
  if (!zoneId) return null;
  return zoneDisplayLabel(zoneById.get(zoneId));
}

function basketRelationLabel(row: Record<string, unknown> | undefined, zoneOverride?: string | null): string {
  if (!row) return 'Basket assignment';
  const type = titleCaseKey(row.basket_type, 'Basket');
  const zone = firstText(zoneOverride, basketDirectZoneLabel(row)) ?? 'Unzoned';
  const current = Number(row.current_count ?? 0);
  const capacity = row.capacity_count == null ? 'open' : String(row.capacity_count);
  return `${type} · ${zone} · ${current}/${capacity}`;
}

export function canEditShipmentTaskStatus(
  canWriteTasks: boolean,
  canCompleteTasks: boolean,
): boolean {
  void canWriteTasks;
  return canCompleteTasks;
}

export function resolveShipmentTaskTarget(row: Record<string, unknown>): string {
  const taskType = firstText(row.task_type, row.task_type_key, row.task_type_id);
  const metadata = asRecord(row.metadata);
  const routeMetadata =
    asRecord(row.task_type_metadata) ??
    asRecord(metadata?.task_type_metadata) ??
    asRecord(taskType ? lookupRow('task_type', taskType)?.metadata : null);
  const path = firstText(routeMetadata?.console_path, '/workflows/review-queue') ?? '/workflows/review-queue';
  const focusParam = firstText(routeMetadata?.console_focus_param, 'focus') ?? 'focus';
  const focusSource = firstText(routeMetadata?.console_focus_source, 'id') ?? 'id';
  const focusValue = firstText(row[focusSource], row.id, row.task_id);
  if (!focusValue) return path;
  return `${path}?${encodeURIComponent(focusParam)}=${encodeURIComponent(focusValue)}`;
}

/**
 * FE-derived risk indicator. Canonical `public.shipments` has no `risk_flag`
 * column; risk is computed from status (failed_attempt or stalled OFD) until
 * a `resolve_shipment_risk_v1(shipment_id)` policy resolver lands.
 * Parity with seed projection at `seed-raw/domain-shipments.js`.
 *
 * W13-2: exported so other consumers (dashboard ShipmentsQueueBody, etc.)
 * derive risk from canonical fields instead of reading the removed
 * fictional `risk_flag` column.
 */
export function isShipmentRisk(
  s: { status?: string; promised_delivery_date?: string } & Record<string, unknown>,
): boolean {
  // W71-Operate (Cycle F-R-11) closure — risk derivation resolves through
  // canonical `shipment_status` metadata flags (`is_at_risk_eligible` /
  // `requires_promised_check`) instead of inline literal compares.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  const statusValue = s.status ?? '';
  const statusMeta = (lookupRow('shipment_status', statusValue)?.metadata ?? {}) as {
    is_at_risk_eligible?: boolean;
    requires_promised_check?: boolean;
  };
  if (statusMeta.is_at_risk_eligible === true) return true;
  if (statusMeta.requires_promised_check === true && s.promised_delivery_date) {
    // OFD past promised date is at-risk.
    const promised = new Date(s.promised_delivery_date).getTime();
    if (!Number.isNaN(promised) && promised < Date.now()) return true;
  }
  return false;
}

export interface ShipmentLabelRow extends Record<string, unknown> {
  id?: string | null;
  active_version_id?: string | null;
  active_version_number?: number | string | null;
  file_url?: string | null;
  output_file_url?: string | null;
  download_url?: string | null;
  artifact_url?: string | null;
  active_file_url?: string | null;
  active_version_file_url?: string | null;
  last_printed_at?: string | null;
  generated_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface ShipmentLabelJobRow extends Record<string, unknown> {
  id?: string | null;
  shipment_id?: string | null;
  label_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  target_box_id?: string | null;
  status?: string | null;
  job_status?: string | null;
  state?: string | null;
  purpose?: string | null;
  job_purpose?: string | null;
  requested_source?: string | null;
  label_type?: string | null;
  workflow_run_id?: string | null;
  workflow_run_step_id?: string | null;
  file_url?: string | null;
  output_file_url?: string | null;
  download_url?: string | null;
  artifact_url?: string | null;
  queued_at?: string | null;
  requested_at?: string | null;
  scheduled_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ShipmentLabelVersionRow extends Record<string, unknown> {
  id?: string | null;
  label_id?: string | null;
  shipment_id?: string | null;
  label_job_id?: string | null;
  version_number?: number | string | null;
  version_status?: string | null;
  job_purpose?: string | null;
  reprint_reason?: string | null;
  supersedes_version_id?: string | null;
  superseded_by_version_id?: string | null;
  label_type?: string | null;
  barcode?: string | null;
  file_url?: string | null;
  output_file_url?: string | null;
  download_url?: string | null;
  artifact_url?: string | null;
  generated_at?: string | null;
  last_printed_at?: string | null;
  print_count?: number | string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function labelSortTime(row: ShipmentLabelRow): number {
  const raw = row.last_printed_at ?? row.generated_at ?? row.updated_at ?? row.created_at;
  if (!raw) return 0;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function selectActiveShipmentLabel(labels: ShipmentLabelRow[]): ShipmentLabelRow | null {
  const active = labels.filter(
    (label) =>
      typeof label.id === 'string' &&
      label.id.length > 0 &&
      typeof label.active_version_id === 'string' &&
      label.active_version_id.length > 0,
  );
  if (active.length === 0) return null;
  return [...active].sort((a, b) => {
    const versionA = Number(a.active_version_number ?? 0);
    const versionB = Number(b.active_version_number ?? 0);
    if (versionA !== versionB) return versionB - versionA;
    const timeDelta = labelSortTime(b) - labelSortTime(a);
    if (timeDelta !== 0) return timeDelta;
    return String(a.id).localeCompare(String(b.id));
  })[0] ?? null;
}

function asLabelArtifactUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shipmentLabelArtifactUrl(label: ShipmentLabelRow | null | undefined): string | null {
  if (!label) return null;
  return (
    asLabelArtifactUrl(label.file_url) ??
    asLabelArtifactUrl(label.output_file_url) ??
    asLabelArtifactUrl(label.download_url) ??
    asLabelArtifactUrl(label.artifact_url) ??
    asLabelArtifactUrl(label.active_file_url) ??
    asLabelArtifactUrl(label.active_version_file_url)
  );
}

export function shipmentLabelJobArtifactUrl(job: ShipmentLabelJobRow | null | undefined): string | null {
  if (!job) return null;
  return (
    asLabelArtifactUrl(job.output_file_url) ??
    asLabelArtifactUrl(job.file_url) ??
    asLabelArtifactUrl(job.download_url) ??
    asLabelArtifactUrl(job.artifact_url)
  );
}

function shipmentLabelJobHasOpenableArtifact(job: ShipmentLabelJobRow | null | undefined): boolean {
  const status = shipmentLabelJobStatus(job).toLowerCase();
  const completed = status === 'completed' || status === 'succeeded' || status === 'success';
  return completed && Boolean(shipmentLabelJobArtifactUrl(job));
}

function shipmentLabelCount(row: Record<string, unknown> | null | undefined): number {
  const raw = row?.label_count;
  const n = typeof raw === 'number' ? raw : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function withLabelDownloadTimeout<T>(promise: Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: number | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = window.setTimeout(() => {
      timer = null;
      reject(new Error('Label download was not ready in time. Try again.'));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (timer) window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timer) window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForLabelProjection(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const LABEL_JOB_LIVE_REFRESH_MS = 4000;
const LABEL_JOB_TERMINAL_STATUSES = new Set(['completed', 'succeeded', 'success', 'failed', 'error', 'cancelled', 'canceled', 'rejected']);

function shipmentLabelProjectionFingerprint(
  labels: ShipmentLabelRow[],
  jobs: ShipmentLabelJobRow[],
  versions: ShipmentLabelVersionRow[],
): string {
  const labelPart = labels
    .map((row) => [
      row.id,
      row.barcode,
      row.active_version_id,
      row.active_version_number,
      row.print_count,
      row.last_printed_at,
    ].join(':'))
    .sort()
    .join('|');
  const jobPart = jobs
    .map((row) => [
      row.id,
      shipmentLabelJobStatus(row),
      shipmentLabelJobPurpose(row),
      row.completed_at,
      row.output_file_url,
    ].join(':'))
    .sort()
    .join('|');
  const versionPart = versions
    .map((row) => [
      row.id,
      row.version_number,
      row.version_status,
      row.job_purpose,
      row.print_count,
      row.last_printed_at,
    ].join(':'))
    .sort()
    .join('|');
  return `${labelPart}::${jobPart}::${versionPart}`;
}

function labelPrintWorkflowFailure(row: Record<string, unknown> | null | undefined): Error | null {
  if (!row) return null;
  const rawStatus = row.workflow_status ?? row.status ?? row.step_status ?? '';
  const status = String(rawStatus).trim().toLowerCase();
  if (!['blocked', 'cancelled', 'canceled', 'failed', 'error', 'rejected'].includes(status)) {
    return null;
  }
  return new Error('Label print could not be completed. Check the label queue before retrying.');
}

async function readLabelPrintWorkflowFailure(workflowRunId: string | null | undefined): Promise<Error | null> {
  const normalizedId = typeof workflowRunId === 'string' ? workflowRunId.trim() : '';
  if (!normalizedId) return null;
  const row = await api.ui_get_resource_v1<Record<string, unknown>>('workflow_runs', normalizedId);
  return labelPrintWorkflowFailure(row);
}

function labelJobSortTime(row: ShipmentLabelJobRow): number {
  const raw = row.completed_at ?? row.started_at ?? row.queued_at ?? row.scheduled_at ?? row.requested_at ?? row.updated_at ?? row.created_at;
  if (!raw) return 0;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

function selectLatestShipmentLabelJob(rows: ShipmentLabelJobRow[]): ShipmentLabelJobRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const timeDelta = labelJobSortTime(b) - labelJobSortTime(a);
    if (timeDelta !== 0) return timeDelta;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  })[0] ?? null;
}

function shipmentLabelJobStatus(row: ShipmentLabelJobRow | null | undefined): string {
  const raw = row?.status ?? row?.job_status ?? row?.state;
  const value = String(raw ?? '').trim();
  return value || 'unknown';
}

function shipmentLabelJobNeedsLiveRefresh(row: ShipmentLabelJobRow | null | undefined): boolean {
  const status = shipmentLabelJobStatus(row).toLowerCase();
  return Boolean(status) && !LABEL_JOB_TERMINAL_STATUSES.has(status);
}

function shipmentLabelJobPurpose(row: ShipmentLabelJobRow | null | undefined): string | null {
  return row?.purpose ?? row?.job_purpose ?? row?.label_type ?? row?.requested_source ?? null;
}

function shipmentLabelJobQueuedAt(row: ShipmentLabelJobRow | null | undefined): string | null {
  return row?.queued_at ?? row?.scheduled_at ?? row?.requested_at ?? row?.created_at ?? null;
}

function shipmentLabelJobWorkflowRef(row: ShipmentLabelJobRow | null | undefined): string | null {
  return row?.workflow_run_id ?? row?.workflow_run_step_id ?? null;
}

function RefreshRoutingButton({ shipment }: { shipment: Shipment }) {
  const { refreshRouting, isPending } = useShipmentRoutingRefresh();
  const [routingStatus, setRoutingStatus] = useState<{ tone: 'good' | 'danger'; message: string } | null>(null);
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px' }}>
      <Button
        label={isPending ? 'Refreshing routing' : 'Refresh routing'}
        iconName="route"
        kind="ghost"
        capability={CAP.SHIPMENTS_WRITE}
        disabled={isPending}
        title="Refresh routing details for this shipment"
        onClick={async () => {
          setRoutingStatus(null);
          try {
            await refreshRouting(shipment);
            const message = 'Routing refresh queued';
            setRoutingStatus({ tone: 'good', message });
            pushToast(message, 'good');
          } catch (err) {
            const message = 'Routing refresh failed. Try again.';
            setRoutingStatus({ tone: 'danger', message });
            pushToast(message, 'danger');
          }
        }}
      />
      {routingStatus ? (
        <span
          role="status"
          aria-live="polite"
          className="mono"
          style={{
            color: routingStatus.tone === 'good' ? 'var(--good-ink)' : 'var(--danger)',
            fontSize: '11px',
            lineHeight: 1.2,
            maxWidth: '180px',
          }}
        >
          {routingStatus.message}
        </span>
      ) : null}
    </div>
  );
}

function ShipmentFooterReprintLabelButton({
  shipment,
  onOpenLabels,
}: {
  shipment: Shipment;
  onOpenLabels: () => void;
}) {
  const reprint = useReprintLabel();
  const queryClient = useQueryClient();
  const [isReprintSubmitting, setIsReprintSubmitting] = useState(false);
  const labelListOpts = useMemo<api.ListOpts>(() => ({
    filter: { shipment_id: shipment.id },
  }), [shipment.id]);
  const labelJobListOpts = useMemo<api.ListOpts>(() => ({
    filter: { shipment_id: shipment.id },
    sort: { key: 'queued_at', dir: 'desc' },
  }), [shipment.id]);
  const labelVersionListOpts = useMemo<api.ListOpts>(() => ({
    filter: { shipment_id: shipment.id },
    sort: { key: 'version_number', dir: 'desc' },
  }), [shipment.id]);
  const labelsQuery = useResourceList<ShipmentLabelRow>('labels', labelListOpts);
  const activeLabel = selectActiveShipmentLabel(labelsQuery.data?.rows ?? []);
  const activeLabelId = activeLabel?.id ?? null;
  const readFooterLabelProjection = useCallback(async () => {
    const [nextLabels, nextJobs, nextVersions] = await Promise.all([
      api.ui_list_resource_v1<ShipmentLabelRow>('labels', labelListOpts),
      api.ui_list_resource_v1<ShipmentLabelJobRow>('label_jobs', labelJobListOpts),
      api.ui_list_resource_v1<ShipmentLabelVersionRow>('label_versions', labelVersionListOpts),
    ]);
    queryClient.setQueryData(qk.list('labels', labelListOpts), nextLabels);
    queryClient.setQueryData(qk.list('label_jobs', labelJobListOpts), nextJobs);
    queryClient.setQueryData(qk.list('label_versions', labelVersionListOpts), nextVersions);
    return {
      labels: nextLabels.rows ?? [],
      jobs: nextJobs.rows ?? [],
      versions: nextVersions.rows ?? [],
    };
  }, [labelJobListOpts, labelListOpts, labelVersionListOpts, queryClient]);
  const disabledReason = labelsQuery.isLoading
    ? 'Checking active label status'
    : labelsQuery.error
      ? 'Label status unavailable'
      : !activeLabelId
        ? 'Active label required for reprint'
        : isReprintSubmitting
          ? 'Reprint is already syncing'
        : undefined;

  return (
    <Button
      label="Reprint label"
      iconName="refresh"
      kind="ghost"
      capability={CAP.LABELS_REPRINT}
      disabled={Boolean(disabledReason) || reprint.isPending || isReprintSubmitting}
      title={disabledReason ?? 'Queue a label reprint and open label status'}
      onClick={async () => {
        if (!activeLabelId) {
          pushToast('No active label - cannot reprint', 'danger');
          onOpenLabels();
          return;
        }
        const reason = defaultLabelReprintReason();
        if (!reason) {
          pushToast('No label reprint reason is configured.', 'danger');
          return;
        }
        try {
          setIsReprintSubmitting(true);
          const previousProjection = await readFooterLabelProjection();
          const previousFingerprint = shipmentLabelProjectionFingerprint(
            previousProjection.labels,
            previousProjection.jobs,
            previousProjection.versions,
          );
          await reprint.mutateAsync({ labelId: activeLabelId, reason, shipmentId: shipment.id });
          for (let attempt = 0; attempt < 6; attempt += 1) {
            if (attempt > 0) await waitForLabelProjection(attempt === 1 ? 1000 : 1500);
            const nextProjection = await readFooterLabelProjection();
            const nextFingerprint = shipmentLabelProjectionFingerprint(
              nextProjection.labels,
              nextProjection.jobs,
              nextProjection.versions,
            );
            if (nextFingerprint !== previousFingerprint) {
              pushToast('Reprint queued - label status refreshed', 'good');
              onOpenLabels();
              return;
            }
          }
          pushToast('Reprint queued, but label refresh is still pending', 'warn');
          onOpenLabels();
        } catch {
          pushToast('Reprint request could not be started. Try again.', 'danger');
        } finally {
          setIsReprintSubmitting(false);
        }
      }}
    />
  );
}

function ShipmentDrawerFooter({
  shipment,
  onResort,
  onOpenReschedule,
  onOpenLabels,
  onOpenCancelPreview,
  onOpenAmend,
}: {
  shipment: Shipment;
  onResort: () => Promise<void>;
  onOpenReschedule: () => void;
  onOpenLabels: () => void;
  onOpenCancelPreview: () => void;
  onOpenAmend: () => void;
}) {
  const [isResortSubmitting, setIsResortSubmitting] = useState(false);
  const operationOptionsQuery = useShipmentOperationOptions(shipment.id);
  const policyState = {
    isLoading: operationOptionsQuery.isLoading,
    hasError: Boolean(operationOptionsQuery.error),
  };
  const rescheduleDisabledReason = operationDisabledReason(
    operationOptionsQuery.data,
    policyState,
    'reschedule',
    'reschedule',
  );
  const cancelDisabledReason = operationDisabledReason(
    operationOptionsQuery.data,
    policyState,
    'cancel',
    'cancel',
  );
  const amendDisabledReason = anyOperationDisabledReason(
    operationOptionsQuery.data,
    policyState,
    ['modify', 'address'],
    'amend',
  );

  return (
    <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
      <Button
        label="Resort"
        iconName="rotate"
        kind="ghost"
        capability={CAP.SHIPMENTS_WRITE}
        disabled={isResortSubmitting}
        title={isResortSubmitting ? 'Resort is already syncing' : 'Reapply basket policy for this shipment'}
        onClick={() => {
          setIsResortSubmitting(true);
          void onResort().finally(() => setIsResortSubmitting(false));
        }}
      />
      <RefreshRoutingButton shipment={shipment} />
      <Button
        label="Reschedule..."
        iconName="history"
        kind="ghost"
        capability={CAP.SHIPMENTS_WRITE}
        disabled={Boolean(rescheduleDisabledReason)}
        title={rescheduleDisabledReason ?? 'Open delivery slot policy options'}
        onClick={onOpenReschedule}
      />
      <ShipmentFooterReprintLabelButton
        shipment={shipment}
        onOpenLabels={onOpenLabels}
      />
      <div style={{ flex: 1 }} />
      <Button
        label="Preview cancel"
        iconName="close"
        kind="danger"
        capability={CAP.SHIPMENTS_WRITE}
        disabled={Boolean(cancelDisabledReason)}
        title={cancelDisabledReason ?? 'Preview cancel through shipment policy'}
        onClick={onOpenCancelPreview}
      />
      <Button
        label="Amend"
        iconName="edit"
        kind="primary"
        capability={CAP.SHIPMENTS_WRITE}
        disabled={Boolean(amendDisabledReason)}
        title={amendDisabledReason ?? 'Open allowed amendment workflow'}
        onClick={onOpenAmend}
      />
    </div>
  );
}

export function ShipmentsModule() {
  const { t, fmtCurrency, fmtDateTime } = useI18n();
  const { scope, currentTenantId } = useIdentity();
  const queryClient = useQueryClient();
  const go = useConsoleNavigator();
  const canRead = useCapability(CAP.SHIPMENTS_READ);
  const canWrite = useCapability(CAP.SHIPMENTS_WRITE);
  const drawer = useDrawer();
  const modal = useModal();

  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const clientParam = readUrlParam('client');
  const senderParam = readUrlParam('sender');
  const recipientParam = readUrlParam('recipient');
  const shipmentListOpts = useMemo(() => {
    const filter: Record<string, string> = {};
    if (tenantId) filter.organization_id = tenantId;
    if (clientParam) filter.client_id = clientParam;
    if (senderParam) filter.sender_id = senderParam;
    if (recipientParam) filter.recipient_id = recipientParam;
    return Object.keys(filter).length ? { filter } : undefined;
  }, [tenantId, clientParam, senderParam, recipientParam]);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);

  const { data, isLoading, error: shipmentsError } = useResourceList<Shipment>('shipments', shipmentListOpts, readQueryOptions);
  // W24 — additive directory projection. Canonical SSOT remains
  // `shipments`; this read enriches the drawer with FE-shaped projections
  // (destination_city / counterparty labels / per-shipment derived
  // counters / is_at_risk) via `v_shipment_directory`.
  const shipmentDirectoryQuery = useResourceList<ShipmentDirectoryRow>('shipment_directory', shipmentListOpts, readQueryOptions);
  const shipmentDirectoryById = useMemo(() => {
    const map = new Map<string, ShipmentDirectoryRow>();
    for (const r of shipmentDirectoryQuery.data?.rows ?? []) map.set(r.id, r);
    return map;
  }, [shipmentDirectoryQuery.data]);
  const amend = useShipmentAmendCancel();
  const batchOp = useShipmentBatchOp();
  const resort = useResortShipment();
  const reprint = useReprintLabel();

  const rawShipments = data?.rows ?? [];
  const shipments = useMemo<Shipment[]>(
    () =>
      rawShipments.map((shipment) => {
        const directory = shipmentDirectoryById.get(shipment.id);
        return {
          ...shipment,
          ...(directory ?? {}),
          destination_city: directory?.destination_city ?? shipment.destination_city,
        } as Shipment;
      }),
    [rawShipments, shipmentDirectoryById],
  );
  const shipmentLabelReadbackFilters = useMemo(
    () =>
      shipments
        .filter((shipment) => shipmentLabelCount(shipment) > 0)
        .map((shipment) => ({ shipment_id: shipment.id })),
    [shipments],
  );
  const shipmentLabelsReadbackQuery = useResourceListsByFilters<ShipmentLabelRow>(
    'labels',
    shipmentLabelReadbackFilters,
    undefined,
    { enabled: canRead && shipmentLabelReadbackFilters.length > 0 },
  );
  const activeLabelByShipmentId = useMemo(() => {
    const map = new Map<string, ShipmentLabelRow>();
    for (const label of shipmentLabelsReadbackQuery.data?.rows ?? []) {
      const shipmentId = typeof label.shipment_id === 'string' ? label.shipment_id : null;
      const activeVersionId = typeof label.active_version_id === 'string' ? label.active_version_id : null;
      if (!shipmentId || !activeVersionId) continue;
      const current = map.get(shipmentId);
      const active = selectActiveShipmentLabel(current ? [current, label] : [label]);
      if (active) map.set(shipmentId, active);
    }
    return map;
  }, [shipmentLabelsReadbackQuery.data]);
  const focusParam = typeof window === 'undefined'
    ? null
    : resolveShipmentFocus(window.location.search, window.location.hash);
  const focusTabParam = typeof window === 'undefined'
    ? 'timeline'
    : new URLSearchParams(window.location.search).get('tab') ?? 'timeline';
  const focusedShipmentFromList = focusParam
    ? shipments.find((shipment) => shipment.id === focusParam || shipment.tracking_number === focusParam)
    : undefined;
  const focusedShipmentQuery = useResourceList<Shipment>(
    'shipments',
    { filter: focusParam ? { identifier: focusParam } : undefined, page_size: 1 },
    { enabled: Boolean(canRead && focusParam && !focusedShipmentFromList) },
  );
  const focusedShipmentFromLookup = useMemo<Shipment | undefined>(() => {
    const shipment = focusedShipmentQuery.data?.rows?.[0];
    if (!shipment) return undefined;
    const directory = shipmentDirectoryById.get(shipment.id);
    return {
      ...shipment,
      ...(directory ?? {}),
      destination_city: directory?.destination_city ?? shipment.destination_city,
    } as Shipment;
  }, [focusedShipmentQuery.data, shipmentDirectoryById]);
  const visibleShipments = useMemo<Shipment[]>(() => {
    if (!focusedShipmentFromLookup) return shipments;
    const exists = shipments.some((shipment) => shipment.id === focusedShipmentFromLookup.id);
    return exists ? shipments : [focusedShipmentFromLookup, ...shipments];
  }, [focusedShipmentFromLookup, shipments]);
  const openedFocusRef = useRef<string | null>(null);

  async function refetchShipmentOperationViews(shipmentIds: string | string[]) {
    await refreshShipmentOperationReadModels(queryClient, shipmentIds);
  }

  // Derive registry-driven columns. The demo enriched a few keys to be
  // editable / sortable / filterable — we replicate that here so view-stash
  // behavior matches.
  const reg = (api.getReadRegistry() as { shipments?: { columns?: Array<DataTableColumn<Shipment>> } }).shipments;
  const columns: Array<DataTableColumn<Shipment>> = useMemo(() => {
    const resolved = resolveShipmentListColumns(reg?.columns);
    if (canWrite) return resolved;
    return resolved.map((column) =>
      column.editable ? { ...column, editable: false } : column,
    );
  }, [canWrite, reg]);

  // Deep-link: open drawer if the URL has /operate/shipments?focus=<id|tracking>.
  useEffect(() => {
    if (!focusParam) {
      openedFocusRef.current = null;
      return undefined;
    }
    const focusKey = `${focusParam}:${focusTabParam}`;
    if (openedFocusRef.current === focusKey) return undefined;
    const target = focusedShipmentFromList ?? focusedShipmentFromLookup;
    if (!target) return undefined;
    const id = window.setTimeout(() => {
      openShipmentDrawer(target, focusTabParam);
      openedFocusRef.current = focusKey;
    }, 100);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, focusTabParam, focusedShipmentFromList, focusedShipmentFromLookup]);

  function findVisibleShipmentForFocus(focus: string | null | undefined): Shipment | undefined {
    const key = String(focus ?? '').trim();
    if (!key) return undefined;
    return visibleShipments.find((shipment) =>
      shipment.id === key ||
      shipment.tracking_number === key ||
      shipment.client_reference_number === key,
    );
  }

  function createdShipmentFocusOpts(key: string, pageSize: number): api.ListOpts {
    return { filter: { identifier: key }, page_size: pageSize };
  }

  async function requireCreatedShipmentVisibleReadback(focus: string | null | undefined): Promise<Shipment | null> {
    const key = String(focus ?? '').trim();
    if (!key) return null;
    const matches = (row: Record<string, unknown>) =>
      row.id === key ||
      row.shipment_id === key ||
      row.tracking_number === key ||
      row.client_reference_number === key;
    const readbackOpts = createdShipmentFocusOpts(key, 25);
    const [shipmentReadback, directoryReadback] = await Promise.all([
      api.ui_list_resource_v1<Record<string, unknown>>('shipments', readbackOpts),
      api.ui_list_resource_v1<Record<string, unknown>>('shipment_directory', readbackOpts),
    ]);
    const shipmentRow = shipmentReadback.rows.find(matches) ?? null;
    const directoryRow = directoryReadback.rows.find(matches) ?? null;
    if (!shipmentRow || !directoryRow) {
      throw new Error('Created shipment did not appear in backend-refreshed shipment lists.');
    }
    const canonicalShipmentId = String(shipmentRow.id ?? directoryRow.shipment_id ?? directoryRow.id ?? '').trim();
    const focusedShipment = {
      ...shipmentRow,
      ...directoryRow,
      id: canonicalShipmentId || String(shipmentRow.id ?? directoryRow.id ?? ''),
    } as Shipment;
    const focusReadback: ListResult<Record<string, unknown>> = {
      ...shipmentReadback,
      rows: [focusedShipment],
      total: Math.max(1, Number(shipmentReadback.total ?? 1)),
    };
    queryClient.setQueryData(qk.list('shipments', createdShipmentFocusOpts(key, 1)), focusReadback);
    queryClient.setQueryData(qk.list('shipments', readbackOpts), {
      ...shipmentReadback,
      rows: [focusedShipment, ...shipmentReadback.rows.filter((row) => row !== shipmentRow)],
    });
    queryClient.setQueryData(qk.list('shipment_directory', readbackOpts), {
      ...directoryReadback,
      rows: [focusedShipment, ...directoryReadback.rows.filter((row) => row !== directoryRow)],
    });
    queryClient.setQueryData(qk.resource('shipments', focusedShipment.id), focusedShipment);
    return focusedShipment;
  }

  function clearFocusedShipmentContext() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('focus') && !params.has('tab')) return;
    params.delete('focus');
    params.delete('tab');
    openedFocusRef.current = null;
    const nextSearch = params.toString();
    const nextUrl = nextSearch ? `/operate/shipments?${nextSearch}` : '/operate/shipments';
    window.history.pushState(null, '', nextUrl);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  function openCreateShipmentModal() {
    clearFocusedShipmentContext();
    if (drawer.isOpen) drawer.close();

    function NewShipmentForm() {
      // AGENTS.md §2/§3: tenant currency for new shipment COD draft
      // resolves strictly from canonical `tenant_currency.iso_code`
      // (W30/G1). NO 'SAR' literal default.
      const tenantCurrencyPolicy = useResolveSettings('tenant_currency', undefined);
      const tenantCurrencyIso =
        (tenantCurrencyPolicy.data?.value as { iso_code?: string } | undefined)?.iso_code ?? '';
      const phoneCountryPolicy = useResolveSettings(
        'tenant_phone_country_code',
        tenantId ? { organization_id: tenantId } : undefined,
      );
      const phoneCountryValue = phoneCountryPolicy.data?.value as
        | { e164_prefix?: string }
        | undefined;
      const recipientPhonePlaceholder = phoneCountryValue?.e164_prefix
        ? `${phoneCountryValue.e164_prefix}5XXXXXXXX`
        : '+E.164';
      // Canonical UI shipment creation RPC. Manual intake sends one backend
      // envelope so recipient, shipment, destination address, and label
      // queueing stay one workflow-backed operator action.
      const createShipment = useCreateShipment();
      const defaultRecipientLanguage = lookupDefaultValue(RECIPIENT_LANGUAGE_LOOKUP_CATEGORY) ?? '';
      const defaultRecipientChannel = lookupDefaultValue('communication_channel') ?? '';
      const recipientLanguageOptions = useMemo(
        () => (getLookups(RECIPIENT_LANGUAGE_LOOKUP_CATEGORY) ?? []) as Array<{ value: string; label: string }>,
        [],
      );
      const recipientChannelOptions = useMemo(
        () => (getLookups('communication_channel') ?? []) as Array<{ value: string; label: string }>,
        [],
      );
      const [formState, setFormState] = useState({
        client_id: '',
        sender_id: '',
        recipient_id: '',
        // service_offering_id holds the selected catalog row. The backend
        // resolves the shipment service type from the selected offering and
        // row-driven policy, so the composer does not submit a literal default.
        service_offering_id: '',
        cod_amount: 0,
        cod_currency: tenantCurrencyIso,
        client_reference_number: '',
        promised_delivery_date: todayDateInputValue(),
      });
      const [codAmountText, setCodAmountText] = useState('0');
      const [recipientMode, setRecipientMode] = useState<'existing' | 'new'>('existing');
      const [recipientDraft, setRecipientDraft] = useState({
        name: '',
        phone_number: '',
        email: '',
        external_id: '',
        preferred_language: defaultRecipientLanguage,
        preferred_comm_channel: defaultRecipientChannel,
        quiet_hours_start: '',
        quiet_hours_end: '',
      });
      const [recipientSearch, setRecipientSearch] = useState('');
      const [addressDraft, setAddressDraft] = useState({
        line1: '',
        line2: '',
        district: '',
        city: '',
        postal_code: '',
        country: '',
        sa_short_code: '',
        latitude: '',
        longitude: '',
        building_number: '',
        additional_directions: '',
      });
      const clientFilter = useMemo(() => {
        const filter: Record<string, string> = {};
        if (tenantId) filter.organization_id = tenantId;
        if (clientParam) filter.id = clientParam;
        return Object.keys(filter).length ? { filter } : undefined;
      }, [tenantId, clientParam]);
      const senderFilter = useMemo(() => {
        const filter: Record<string, string> = {};
        if (tenantId) filter.organization_id_resolved = tenantId;
        if (clientParam) filter.client_id = clientParam;
        if (senderParam) filter.sender_id = senderParam;
        return Object.keys(filter).length ? { filter } : undefined;
      }, [tenantId, clientParam, senderParam]);
      const recipientFilter = useMemo(() => {
        const filter: Record<string, string> = {};
        if (tenantId) filter.organization_id = tenantId;
        if (clientParam) filter.client_id = clientParam;
        return Object.keys(filter).length ? { filter } : undefined;
      }, [tenantId, clientParam]);
      const offeringFilter = useMemo(
        () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
        [tenantId],
      );
      // CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B). The service offering select used
      // to be a hardcoded ['standard','express','same_day'] tuple. It now reads
      // from the canonical service offering directory projection so live
      // backends expose the active/listable status without app-side joins or a
      // brittle dependency on a separately hydrated lookup cache.
      const offeringsQuery = useCompleteResourceList<{
        id: string;
        is_active: boolean;
        service_level_id?: string | null;
        level_name?: string | null;
        branch_name?: string | null;
        display_name?: string | null;
        base_price?: number | null;
        currency?: string | null;
        is_active_window?: boolean | null;
        is_archived?: boolean | null;
        is_draft?: boolean | null;
        metadata?: {
          display?: { name?: string; status?: string };
          base_price?: number;
          currency?: string;
        };
      }>('service_offering_directory', offeringFilter);
      const offeringRows = (offeringsQuery.data?.rows ?? []).filter((o) => {
        if (!o.is_active) return false;
        if (o.is_active_window === false) return false;
        if (o.is_archived || o.is_draft) return false;
        return true;
      });
      // W56-B-2 closure (F6) — `api.seed.{clients,senders,recipients}()`
      // migrated to canonical `useResourceList<T>('<resource_key>')`. The
      // registry entries already exist (clients/senders/recipients) so the
      // production cutover remains a single getSupabaseClient() branch flip
      // in `ui_list_resource_v1`.
      const clientsQuery = useCompleteResourceList<{ id: string; name: string }>('clients', clientFilter);
      const sendersQuery = useCompleteResourceList<{
        id: string;
        name: string;
        sender_id?: string;
        client_id?: string | null;
        status?: string | null;
      }>(
        senderFilter ? 'sender_summary' : 'senders',
        senderFilter,
      );
      const recipientsQuery = useCompleteResourceList<{
        id: string;
        name: string;
        client_id?: string | null;
        phone_number?: string | null;
        phone?: string | null;
        external_id?: string | null;
      }>('recipients', recipientFilter);
      const seedRows = useMemo<{
        clients: Array<{ id: string; name: string }>;
        senders: Array<{ id: string; name: string; client_id?: string | null; status?: string | null }>;
        recipients: Array<{
          id: string;
          name: string;
          client_id?: string | null;
          phone_number?: string | null;
          phone?: string | null;
          external_id?: string | null;
        }>;
      } | null>(() => {
        if (
          clientsQuery.isLoading ||
          sendersQuery.isLoading ||
          recipientsQuery.isLoading
        ) {
          return null;
        }
        return {
          clients: clientsQuery.data?.rows ?? [],
          senders: (sendersQuery.data?.rows ?? []).map((sender) => ({
            ...sender,
            id: sender.sender_id ?? sender.id,
          })),
          recipients: recipientsQuery.data?.rows ?? [],
        };
      }, [
        clientsQuery.isLoading,
        clientsQuery.data,
        sendersQuery.isLoading,
        sendersQuery.data,
        recipientsQuery.isLoading,
        recipientsQuery.data,
      ]);
      const shipmentDefaultsError =
        offeringsQuery.error ??
        clientsQuery.error ??
        sendersQuery.error ??
        recipientsQuery.error;
      const [err, setErr] = useState<string>('');
      const [dryRunPreview, setDryRunPreview] = useState<Record<string, unknown> | null>(null);
      const [submitting, setSubmitting] = useState<boolean>(false);
      const selectedClientId = formState.client_id || clientParam || '';
      const activeSenderStatus = lookupDefaultValue('sender_status');
      const newRecipientReady =
        recipientDraft.name.trim().length > 0 &&
        recipientDraft.phone_number.trim().length > 0;
      const availableSenders = useMemo(() => {
        const rows = seedRows?.senders ?? [];
        const clientRows =
          !selectedClientId || !rows.some((sender) => sender.client_id)
            ? rows
            : rows.filter((sender) => sender.client_id === selectedClientId);
        if (!activeSenderStatus) return clientRows;
        const activeValue = activeSenderStatus.toLowerCase();
        return clientRows.filter((sender) => {
          if (sender.status == null || sender.status === '') return true;
          return String(sender.status).toLowerCase() === activeValue;
        });
      }, [activeSenderStatus, seedRows, selectedClientId]);
      const availableRecipients = useMemo(() => {
        const rows = seedRows?.recipients ?? [];
        if (!selectedClientId) return rows;
        if (!rows.some((recipient) => recipient.client_id)) return rows;
        return rows.filter((recipient) => recipient.client_id === selectedClientId);
      }, [seedRows, selectedClientId]);
      const duplicateRecipient = useMemo(() => {
        if (recipientMode !== 'new') return null;
        const phone = normalizePhoneForMatch(recipientDraft.phone_number);
        const externalId = recipientDraft.external_id.trim().toLowerCase();
        if (!phone && !externalId) return null;
        return availableRecipients.find((recipient) => {
          const recipientPhone = normalizePhoneForMatch(recipient.phone_number ?? recipient.phone ?? '');
          const recipientExternalId = String(recipient.external_id ?? '').trim().toLowerCase();
          return Boolean(
            (phone && recipientPhone && recipientPhone === phone) ||
            (externalId && recipientExternalId && recipientExternalId === externalId),
          );
        }) ?? null;
      }, [
        availableRecipients,
        recipientDraft.external_id,
        recipientDraft.phone_number,
        recipientMode,
      ]);
      const visibleRecipientOptions = useMemo(() => {
        const needle = recipientSearch.trim().toLowerCase();
        if (!needle) return availableRecipients;
        return availableRecipients.filter((recipient) =>
          [
            recipient.name,
            recipient.phone_number,
            recipient.phone,
            recipient.external_id,
          ].some((value) => String(value ?? '').toLowerCase().includes(needle)),
        );
      }, [availableRecipients, recipientSearch]);
      const recipientOptions = useMemo(() => {
        if (!formState.recipient_id) return visibleRecipientOptions;
        if (visibleRecipientOptions.some((recipient) => recipient.id === formState.recipient_id)) {
          return visibleRecipientOptions;
        }
        const selected = availableRecipients.find((recipient) => recipient.id === formState.recipient_id);
        return selected ? [selected, ...visibleRecipientOptions] : visibleRecipientOptions;
      }, [availableRecipients, formState.recipient_id, visibleRecipientOptions]);
      const recipientReady = recipientMode === 'new'
        ? newRecipientReady
        : !!formState.recipient_id;

      function selectExistingRecipient(recipientId: string) {
        setDryRunPreview(null);
        setRecipientMode('existing');
        setFormState((prev) => ({ ...prev, recipient_id: recipientId }));
        setRecipientSearch('');
        setErr('');
      }

      // Default the picker selection to the first available row once the
      // canonical reads resolve. Row-driven defaults — no hardcoded fallback
      // tenant ids; if any list resolves empty the form must surface the
      // gap upstream rather than masking it.
      useEffect(() => {
        if (!seedRows) return;
        setFormState((s) => {
          const client_id =
            s.client_id && seedRows.clients.some((client) => client.id === s.client_id)
              ? s.client_id
              : seedRows.clients[0]?.id || '';
          const sender_id =
            s.sender_id && availableSenders.some((sender) => sender.id === s.sender_id)
              ? s.sender_id
              : availableSenders[0]?.id || '';
          const recipient_id =
            s.recipient_id && availableRecipients.some((recipient) => recipient.id === s.recipient_id)
              ? s.recipient_id
              : availableRecipients[0]?.id || '';
          if (s.client_id === client_id && s.sender_id === sender_id && s.recipient_id === recipient_id) {
            return s;
          }
          return { ...s, client_id, sender_id, recipient_id };
        });
      }, [seedRows, availableSenders, availableRecipients]);

      useEffect(() => {
        if (!seedRows) return;
        if (availableRecipients.length === 0) {
          setRecipientMode('new');
        }
      }, [seedRows, availableRecipients.length]);

      // Pick the first active offering once the catalog resolves so the form
      // never submits an empty offering reference. Row-driven default — no
      // hardcoded fallback. If the catalog is empty the select stays empty
      // and the operator must address that upstream.
      useEffect(() => {
        if (!formState.service_offering_id && offeringRows.length > 0) {
          const first = offeringRows[0];
          if (first) setFormState((s) => ({ ...s, service_offering_id: first.id }));
        }
      }, [offeringRows, formState.service_offering_id]);

      function update<K extends keyof typeof formState>(key: K, value: (typeof formState)[K]) {
        setErr('');
        setDryRunPreview(null);
        setFormState((prev) => ({ ...prev, [key]: value }));
      }

      function updateRecipientDraft<K extends keyof typeof recipientDraft>(
        key: K,
        value: (typeof recipientDraft)[K],
      ) {
        setErr('');
        setDryRunPreview(null);
        setRecipientDraft((prev) => ({ ...prev, [key]: value }));
      }

      function updateAddressDraft<K extends keyof typeof addressDraft>(
        key: K,
        value: (typeof addressDraft)[K],
      ) {
        setErr('');
        setDryRunPreview(null);
        setAddressDraft((prev) => ({ ...prev, [key]: value }));
      }

      function updateCodAmount(value: string) {
        setErr('');
        setDryRunPreview(null);
        setCodAmountText(value);
        const parsed = value.trim() ? Number(value) : 0;
        if (Number.isFinite(parsed)) {
          setFormState((prev) => ({ ...prev, cod_amount: parsed }));
        }
      }

      function updateClient(client_id: string) {
        setErr('');
        setDryRunPreview(null);
        setRecipientSearch('');
        setFormState((prev) => ({
          ...prev,
          client_id,
          sender_id: '',
          recipient_id: '',
        }));
      }

      async function submit(dryRun: boolean) {
        setErr('');
        setDryRunPreview(null);
        if (!formState.client_id) {
          setErr('Client is required.');
          return;
        }
        if (!formState.sender_id) {
          setErr(availableSenders.length === 0 ? 'No active sender is available for the selected client.' : 'Sender is required.');
          return;
        }
        if (!availableSenders.some((sender) => sender.id === formState.sender_id)) {
          setErr('Sender must belong to the selected client.');
          return;
        }
        if (!formState.recipient_id) {
          if (recipientMode !== 'new') {
            setErr('Recipient is required.');
            return;
          }
        }
        if (recipientMode === 'existing') {
          if (!availableRecipients.some((recipient) => recipient.id === formState.recipient_id)) {
            setErr('Recipient must belong to the selected client.');
            return;
          }
        } else {
          if (!recipientDraft.name.trim()) {
            setErr('Recipient name is required.');
            return;
          }
          if (!recipientDraft.phone_number.trim()) {
            setErr('Recipient phone is required.');
            return;
          }
          if (!isE164PhoneNumber(recipientDraft.phone_number)) {
            setErr(e164PhoneError('Recipient phone'));
            return;
          }
          if (duplicateRecipient) {
            setErr(`Recipient already exists for this client. Use existing recipient: ${duplicateRecipient.name}.`);
            return;
          }
        }
        if (!formState.service_offering_id) {
          setErr('Service offering is required.');
          return;
        }
        if (!formState.client_reference_number) {
          setErr('Client reference is required.');
          return;
        }
        if (!formState.promised_delivery_date) {
          setErr('Promised date is required.');
          return;
        }
        const codAmount = codAmountText.trim() ? Number(codAmountText) : 0;
        if (!Number.isFinite(codAmount) || codAmount < 0) {
          setErr('COD amount must be zero or greater.');
          return;
        }
        if (!addressDraft.line1.trim()) {
          setErr('Address line is required.');
          return;
        }
        if (!addressDraft.city.trim()) {
          setErr('Address city is required.');
          return;
        }
        const latitudeText = addressDraft.latitude.trim();
        const longitudeText = addressDraft.longitude.trim();
        const hasLatitude = latitudeText.length > 0;
        const hasLongitude = longitudeText.length > 0;
        const latitude = hasLatitude ? Number(latitudeText) : null;
        const longitude = hasLongitude ? Number(longitudeText) : null;
        if (hasLatitude !== hasLongitude) {
          setErr('Latitude and longitude must be provided together.');
          return;
        }
        if (
          (hasLatitude && (!Number.isFinite(latitude) || latitude == null || latitude < -90 || latitude > 90)) ||
          (hasLongitude && (!Number.isFinite(longitude) || longitude == null || longitude < -180 || longitude > 180))
        ) {
          setErr('Coordinates must be valid latitude and longitude values.');
          return;
        }
        const shortNationalAddress = addressDraft.sa_short_code.trim().toUpperCase();
        const destinationAddress = {
          line1: addressDraft.line1.trim(),
          ...(addressDraft.line2.trim() ? { line2: addressDraft.line2.trim() } : {}),
          ...(addressDraft.district.trim() ? { district: addressDraft.district.trim() } : {}),
          city: addressDraft.city.trim(),
          ...(addressDraft.postal_code.trim() ? { postal_code: addressDraft.postal_code.trim() } : {}),
          ...(addressDraft.country.trim() ? { country: addressDraft.country.trim() } : {}),
          ...(shortNationalAddress ? { sa_short_code: shortNationalAddress } : {}),
          ...(latitude != null && longitude != null
            ? {
                latitude,
                longitude,
                coordinates: { latitude, longitude },
              }
            : {}),
          ...(addressDraft.building_number.trim() ? { building_number: addressDraft.building_number.trim() } : {}),
          ...(addressDraft.additional_directions.trim()
            ? { additional_directions: addressDraft.additional_directions.trim() }
            : {}),
        };
        const newRecipient = recipientMode === 'new'
          ? {
              name: recipientDraft.name.trim(),
              phone_number: recipientDraft.phone_number.trim(),
              ...(recipientDraft.email.trim() ? { email: recipientDraft.email.trim() } : {}),
              ...(recipientDraft.external_id.trim() ? { external_id: recipientDraft.external_id.trim() } : {}),
              ...(recipientDraft.preferred_language
                ? { preferred_language: recipientDraft.preferred_language }
                : {}),
              ...(recipientDraft.preferred_comm_channel
                ? { preferred_comm_channel: recipientDraft.preferred_comm_channel }
                : {}),
              ...(recipientDraft.quiet_hours_start
                ? { quiet_hours_start: recipientDraft.quiet_hours_start }
                : {}),
              ...(recipientDraft.quiet_hours_end
                ? { quiet_hours_end: recipientDraft.quiet_hours_end }
                : {}),
              communication_preferences: {
                source: 'console_v2.shipment_create_inline_recipient',
              },
            }
          : null;
        setSubmitting(true);
        try {
          const result = await createShipment.mutateAsync({
            organization_id: tenantId,
            client_id: formState.client_id,
            sender_id: formState.sender_id,
            recipient_id: recipientMode === 'existing' ? formState.recipient_id : undefined,
            new_recipient: newRecipient,
            destination_address: destinationAddress,
            service_offering_id: formState.service_offering_id,
            client_reference_number: formState.client_reference_number,
            cod_amount: codAmount,
            cod_currency: formState.cod_currency,
            promised_delivery_date: formState.promised_delivery_date,
            dry_run: dryRun,
          });
          if (dryRun) {
            setDryRunPreview(result as Record<string, unknown>);
            pushToast('Shipment, recipient, address and label preview ready.', 'info');
            return;
          }
          if (!result.shipment_id) {
            throw new Error('Shipment creation did not return a shipment id.');
          }
          const createdShipmentFocus =
            result.shipment_id ?? result.tracking_number ?? formState.client_reference_number;
          const createOperation = String(result.operation ?? '').toLowerCase();
          const reusedExistingShipment =
            result.status === 'manual_shipment_intake_reused' || createOperation.startsWith('reused');
          const createdShipmentReadback = await requireCreatedShipmentVisibleReadback(createdShipmentFocus);
          modal.close();
          pushToast(
            [
              reusedExistingShipment
                ? 'Existing shipment opened'
                : recipientMode === 'new' ? 'Recipient, shipment and address created' : 'Shipment and address created',
              reusedExistingShipment
                ? createOperation === 'reused_client_reference' ? 'duplicate client reference' : 'duplicate reference'
                : result.label_job_id ? 'label queued' : null,
              result.tracking_number ?? formState.client_reference_number,
            ].filter(Boolean).join(' · '),
            'good',
          );
          if (createdShipmentFocus) {
            const existingTarget = reusedExistingShipment
              ? findVisibleShipmentForFocus(createdShipmentFocus)
              : undefined;
            const drawerTarget = existingTarget ?? createdShipmentReadback ?? undefined;
            window.setTimeout(() => {
              if (drawerTarget) {
                openShipmentDrawer(drawerTarget);
                openedFocusRef.current = `${createdShipmentFocus}:timeline`;
              }
              go(`/operate/shipments?focus=${encodeURIComponent(createdShipmentFocus)}`);
            }, 0);
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error ?? 'Shipment creation failed'));
          reportError(err, {
            surface: 'operate.shipments.create',
            operation: 'manual_shipment_final_create',
            organization_id: tenantId,
            client_id: formState.client_id,
            sender_id: formState.sender_id,
            service_offering_id: formState.service_offering_id,
            recipient_mode: recipientMode,
            has_destination_address: true,
            dry_run: false,
          });
          setErr(operatorShipmentCreateErrorMessage(err));
        } finally {
          setSubmitting(false);
        }
      }

      if (shipmentDefaultsError) {
        return (
          <StateView
            kind="error"
            title="Shipment defaults unavailable"
            hint={(shipmentDefaultsError as Error).message}
          />
        );
      }

      if (!seedRows) {
        return <StateView kind="loading" hint="Loading shipment defaults..." />;
      }

      return (
        <>
          <p className="state__hint">
            Submitted through the approved shipment creation workflow.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px', alignItems: 'center', padding: '0 4px' }}>
            <label className="mono" htmlFor="shipment-create-client">Client</label>
            <select id="shipment-create-client" className="dt-inline-input" value={formState.client_id} onChange={(e) => updateClient(e.target.value)}>
              {seedRows.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label className="mono" htmlFor="shipment-create-sender">Sender</label>
            <select id="shipment-create-sender" className="dt-inline-input" value={formState.sender_id} onChange={(e) => update('sender_id', e.target.value)}>
              {availableSenders.length === 0 ? (
                <option value="" disabled>No active sender configured</option>
              ) : (
                availableSenders.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)
              )}
            </select>
            {availableSenders.length === 0 ? (
              <>
                <div />
                <div style={{ color: 'var(--warning-ink)', fontSize: 12 }}>
                  Reactivate or create a sender for this client before receiving shipments.
                </div>
              </>
            ) : null}
            <label
              className="mono"
              htmlFor={recipientMode === 'existing' ? 'shipment-create-recipient' : 'shipment-new-recipient-name'}
            >
              Recipient
            </label>
            <div style={{ display: 'grid', gap: '8px' }}>
              <div role="group" aria-label="Recipient mode" style={{ display: 'flex', gap: 6 }}>
                <Button
                  label="Existing"
                  kind={recipientMode === 'existing' ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    setErr('');
                    setDryRunPreview(null);
                    setRecipientMode('existing');
                  }}
                  disabled={availableRecipients.length === 0}
                />
                <Button
                  label="New recipient"
                  kind={recipientMode === 'new' ? 'primary' : 'ghost'}
                  size="sm"
                  capability={CAP.RECIPIENTS_WRITE}
                  onClick={() => {
                    setErr('');
                    setDryRunPreview(null);
                    setRecipientMode('new');
                  }}
                />
              </div>
              {recipientMode === 'existing' ? (
                <div style={{ display: 'grid', gap: '6px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: '6px', alignItems: 'center' }}>
                    <label className="mono" htmlFor="shipment-create-recipient-search">Find</label>
                    <input
                      id="shipment-create-recipient-search"
                      aria-label="Find recipient"
                      className="dt-inline-input"
                      placeholder="Name, phone, or external ID"
                      value={recipientSearch}
                      onChange={(e) => {
                        setErr('');
                        setDryRunPreview(null);
                        setRecipientSearch(e.target.value);
                      }}
                    />
                  </div>
                  <select
                    id="shipment-create-recipient"
                    className="dt-inline-input"
                    value={formState.recipient_id}
                    onChange={(e) => update('recipient_id', e.target.value)}
                  >
                    {recipientOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {[r.name, r.phone_number ?? r.phone, r.external_id].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </select>
                  {recipientSearch.trim() && visibleRecipientOptions.length === 0 ? (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 8,
                        color: 'var(--ink-2)',
                        fontSize: 12,
                      }}
                    >
                      <span>No matching recipient for this client.</span>
                      <Button
                        label="Create new"
                        kind="ghost"
                        size="sm"
                        capability={CAP.RECIPIENTS_WRITE}
                        onClick={() => {
                          setErr('');
                          setDryRunPreview(null);
                          setRecipientMode('new');
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px', alignItems: 'center' }}>
                  <label className="mono" htmlFor="shipment-new-recipient-name">Recipient name</label>
                  <input
                    id="shipment-new-recipient-name"
                    className="dt-inline-input"
                    value={recipientDraft.name}
                    onChange={(e) => updateRecipientDraft('name', e.target.value)}
                  />
                  <label className="mono" htmlFor="shipment-new-recipient-phone">Recipient phone</label>
                  <input
                    id="shipment-new-recipient-phone"
                    className="dt-inline-input"
                    placeholder={recipientPhonePlaceholder}
                    value={recipientDraft.phone_number}
                    onChange={(e) => updateRecipientDraft('phone_number', e.target.value)}
                  />
                  <label className="mono" htmlFor="shipment-new-recipient-email">Recipient email</label>
                  <input
                    id="shipment-new-recipient-email"
                    className="dt-inline-input"
                    value={recipientDraft.email}
                    onChange={(e) => updateRecipientDraft('email', e.target.value)}
                  />
                  <label className="mono" htmlFor="shipment-new-recipient-external">Recipient external ID</label>
                  <input
                    id="shipment-new-recipient-external"
                    className="dt-inline-input"
                    value={recipientDraft.external_id}
                    onChange={(e) => updateRecipientDraft('external_id', e.target.value)}
                  />
                  <label className="mono" htmlFor="shipment-new-recipient-lang">Language</label>
                  <select
                    id="shipment-new-recipient-lang"
                    className="dt-inline-input"
                    value={recipientDraft.preferred_language}
                    onChange={(e) => updateRecipientDraft('preferred_language', e.target.value)}
                  >
                    {recipientLanguageOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <label className="mono" htmlFor="shipment-new-recipient-channel">Channel</label>
                  <select
                    id="shipment-new-recipient-channel"
                    className="dt-inline-input"
                    value={recipientDraft.preferred_comm_channel}
                    onChange={(e) => updateRecipientDraft('preferred_comm_channel', e.target.value)}
                  >
                    {recipientChannelOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <label className="mono" htmlFor="shipment-new-recipient-quiet-from">Quiet from</label>
                  <input
                    id="shipment-new-recipient-quiet-from"
                    className="dt-inline-input"
                    type="time"
                    placeholder="22:00"
                    value={recipientDraft.quiet_hours_start}
                    onChange={(e) => updateRecipientDraft('quiet_hours_start', e.target.value)}
                  />
                  <label className="mono" htmlFor="shipment-new-recipient-quiet-to">Quiet to</label>
                  <input
                    id="shipment-new-recipient-quiet-to"
                    className="dt-inline-input"
                    type="time"
                    placeholder="08:00"
                    value={recipientDraft.quiet_hours_end}
                    onChange={(e) => updateRecipientDraft('quiet_hours_end', e.target.value)}
                  />
                  {duplicateRecipient ? (
                    <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warning-ink)', fontSize: 12 }}>
                      <span>Existing recipient match: {duplicateRecipient.name}</span>
                      <Button
                        label="Use existing"
                        kind="ghost"
                        size="sm"
                        onClick={() => selectExistingRecipient(duplicateRecipient.id)}
                      />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            <label className="mono" htmlFor="shipment-create-service-offering">Service offering</label>
            <select
              id="shipment-create-service-offering"
              className="dt-inline-input"
              data-testid="shipments-create-service-type"
              value={formState.service_offering_id}
              onChange={(e) => update('service_offering_id', e.target.value)}
            >
              {offeringRows.length === 0 ? (
                <option value="" disabled>
                  {offeringsQuery.isLoading
                    ? 'Loading offerings…'
                    : 'No active service offerings configured'}
                </option>
              ) : (
                offeringRows.map((o) => {
                    const display = (
                      o.display_name
                      ?? o.metadata?.display?.name
                      ?? [o.level_name, o.branch_name].filter(Boolean).join(' · ')
                    ) || 'Service offering display pending';
                    const price = o.base_price ?? o.metadata?.base_price;
                    const ccy = o.currency ?? o.metadata?.currency ?? tenantCurrencyIso ?? '—';
                  return (
                    <option key={o.id} value={o.id}>
                      {price != null ? `${display} · ${price} ${ccy}` : display}
                    </option>
                  );
                })
              )}
            </select>
            <label className="mono" htmlFor="shipment-create-client-reference">Client reference</label>
            <input
              id="shipment-create-client-reference"
              className="dt-inline-input"
              type="text"
              placeholder="e.g. EXAMPLEMARKET-99281"
              value={formState.client_reference_number}
              onChange={(e) => update('client_reference_number', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-cod-amount">COD amount ({tenantCurrencyIso || '—'})</label>
            <input
              id="shipment-create-cod-amount"
              className="dt-inline-input"
              type="text"
              inputMode="decimal"
              pattern="[0-9]*[.]?[0-9]*"
              value={codAmountText}
              onChange={(e) => updateCodAmount(e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-promised-date">Promised date</label>
            <input
              id="shipment-create-promised-date"
              className="dt-inline-input"
              type="date"
              value={formState.promised_delivery_date}
              onInput={(e) => update('promised_delivery_date', e.currentTarget.value)}
              onChange={(e) => update('promised_delivery_date', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-line1">Address line</label>
            <input
              id="shipment-create-address-line1"
              className="dt-inline-input"
              placeholder="Building, street, landmark"
              value={addressDraft.line1}
              onChange={(e) => updateAddressDraft('line1', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-line2">Address line 2</label>
            <input
              id="shipment-create-address-line2"
              className="dt-inline-input"
              placeholder="Apartment, floor, suite"
              value={addressDraft.line2}
              onChange={(e) => updateAddressDraft('line2', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-district">District</label>
            <input
              id="shipment-create-address-district"
              className="dt-inline-input"
              value={addressDraft.district}
              onChange={(e) => updateAddressDraft('district', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-city">City</label>
            <input
              id="shipment-create-address-city"
              className="dt-inline-input"
              value={addressDraft.city}
              onChange={(e) => updateAddressDraft('city', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-postal">Postal code</label>
            <input
              id="shipment-create-address-postal"
              className="dt-inline-input"
              value={addressDraft.postal_code}
              onChange={(e) => updateAddressDraft('postal_code', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-country">Country</label>
            <input
              id="shipment-create-address-country"
              className="dt-inline-input"
              placeholder="Policy default when blank"
              value={addressDraft.country}
              onChange={(e) => updateAddressDraft('country', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-short-code">Saudi short national address</label>
            <input
              id="shipment-create-address-short-code"
              className="dt-inline-input"
              placeholder="e.g. RNQA7082"
              value={addressDraft.sa_short_code}
              onChange={(e) => updateAddressDraft('sa_short_code', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-latitude">Latitude</label>
            <input
              id="shipment-create-address-latitude"
              className="dt-inline-input"
              type="text"
              inputMode="decimal"
              value={addressDraft.latitude}
              onChange={(e) => updateAddressDraft('latitude', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-longitude">Longitude</label>
            <input
              id="shipment-create-address-longitude"
              className="dt-inline-input"
              type="text"
              inputMode="decimal"
              value={addressDraft.longitude}
              onChange={(e) => updateAddressDraft('longitude', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-building">Building no.</label>
            <input
              id="shipment-create-address-building"
              className="dt-inline-input"
              value={addressDraft.building_number}
              onChange={(e) => updateAddressDraft('building_number', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-create-address-notes">Delivery notes</label>
            <input
              id="shipment-create-address-notes"
              className="dt-inline-input"
              value={addressDraft.additional_directions}
              onChange={(e) => updateAddressDraft('additional_directions', e.target.value)}
            />
          </div>
          <div style={{ color: 'var(--danger-ink)', fontSize: '11px', padding: '0 14px', minHeight: '14px' }}>{err}</div>
          {dryRunPreview ? (
            <div
              data-testid="shipment-create-preview-status"
              style={{
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '10px 12px',
                marginTop: 12,
                background: 'var(--surface-2)',
                display: 'grid',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 12 }}>Preview</strong>
                <Chip kind="info" label="No shipment created yet" />
              </div>
              <KvGrid rows={[
                {
                  key: 'status',
                  label: 'Status',
                  value: String(dryRunPreview.status ?? dryRunPreview.workflow_status ?? 'previewed'),
                },
                {
                  key: 'workflow_run',
                  label: 'Workflow',
                  value: dryRunPreview.workflow_run_id ? 'Ready' : 'Pending',
                },
                {
                  key: 'correlation',
                  label: 'Activity',
                  value: dryRunPreview.correlation_id ? 'Prepared' : 'Pending',
                },
                {
                  key: 'recipient_mode',
                  label: 'Recipient mode',
                  value: recipientMode === 'new' ? 'Inline new recipient' : 'Existing recipient',
                },
                {
                  key: 'label_job',
                  label: 'Label',
                  value: dryRunPreview.label_job_id ? 'Ready after creation' : 'Not queued in preview',
                },
              ]} />
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button
              label={t('common.cancel', 'Cancel')}
              kind="ghost"
              onClick={() => modal.close()}
              disabled={submitting}
            />
            <Button
              label="Preview creation"
              kind="ghost"
              capabilities={recipientMode === 'new'
                ? [CAP.SHIPMENTS_WRITE, CAP.RECIPIENTS_WRITE]
                : [CAP.SHIPMENTS_WRITE]}
              onClick={() => submit(true)}
              disabled={submitting}
            />
            <Button
              label={submitting ? 'Creating…' : 'Create'}
              kind="primary"
              capabilities={recipientMode === 'new'
                ? [CAP.SHIPMENTS_WRITE, CAP.RECIPIENTS_WRITE]
                : [CAP.SHIPMENTS_WRITE]}
              onClick={() => submit(false)}
              disabled={
                submitting ||
                !formState.client_id ||
                !formState.sender_id ||
                !recipientReady ||
                !formState.service_offering_id
              }
            />
          </div>
        </>
      );
    }

    modal.open({ title: 'New shipment', body: <NewShipmentForm /> });
  }

  function openCancelPreviewModal(s: Shipment) {
    const applyCancel = async () => {
      modal.open({
        title: `Apply cancel ${s.tracking_number}`,
        body: (
          <StateView
            kind="loading"
            title="Applying cancel workflow"
            hint="Starting the workflow and refreshing the visible shipment context."
          />
        ),
      });
      try {
        const result = await amend.mutateAsync({
          shipmentId: s.id,
          op: 'cancel',
          payload: {
            reason: 'console_v2.shipments.cancel_preview_modal',
            source: 'console_v2.shipments.cancel_preview_modal',
          },
          dryRun: false,
        });
        await refetchShipmentOperationViews(s.id);
        const record = (result ?? {}) as Record<string, unknown>;
        modal.open({
          title: `Cancel applied ${s.tracking_number}`,
          body: (
            <div data-testid="shipment-cancel-apply-result">
              <p className="state__hint">
                Cancel workflow started and the visible shipment views were refreshed.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '10px 0' }}>
                <Chip size="xs" kind="good" label="Workflow started" />
                {record.workflow_run_id ? (
                  <Chip size="xs" kind="info" label="Workflow confirmed" />
                ) : null}
                {record.canonical_entrypoint ? (
                  <Chip size="xs" kind="info" label="Workflow path confirmed" />
                ) : null}
              </div>
              <WorkflowMutationProof record={record} />
            </div>
          ),
          footer: <Button label="Close" kind="ghost" onClick={() => modal.close()} />,
        });
        pushToast(`Cancel workflow started · ${s.tracking_number}`, 'good');
      } catch (caught) {
        const message = caught instanceof Error && caught.message ? caught.message : 'Cancel apply failed';
        modal.open({
          title: `Apply cancel ${s.tracking_number}`,
          body: <StateView kind="error" title="Cancel apply failed" hint={message} />,
          footer: <Button label="Close" kind="ghost" onClick={() => modal.close()} />,
        });
        pushToast(`Cancel apply failed - ${message}`, 'danger');
      }
    };

    modal.open({
      title: `Cancel preview ${s.tracking_number}`,
      body: (
        <StateView
          kind="loading"
          title="Checking cancel policy"
          hint="Checking policy before showing the operator result."
        />
      ),
    });
    void amend.mutateAsync({ shipmentId: s.id, op: 'cancel', payload: {}, dryRun: true })
      .then((result) => {
        const record = (result ?? {}) as Record<string, unknown>;
        const diff = (record.diff as Record<string, unknown> | null | undefined) ?? null;
        modal.open({
          title: `Cancel preview ${s.tracking_number}`,
          body: (
            <div data-testid="shipment-cancel-preview-result">
              <p className="state__hint">
                Policy check completed. Review the result before applying any destructive shipment change.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '10px 0' }}>
                <Chip size="xs" kind="warn" label="Preview" />
                <Chip
                  size="xs"
                  kind={record.settings_resolution_id ? 'info' : 'neutral'}
                  label={
                    record.settings_resolution_id
                      ? 'Policy confirmed'
                      : 'Policy checked'
                  }
                />
                {record.workflow_template ? (
                  <Chip size="xs" kind="info" label="Workflow ready" />
                ) : null}
              </div>
              <KvGrid rows={[
                {
                  key: 'policy',
                  label: 'Policy check',
                  value: record.settings_resolution_id ? 'Passed' : 'Checked',
                },
                {
                  key: 'workflow',
                  label: 'Workflow',
                  value: record.workflow_template ? 'Ready' : 'Pending',
                },
                {
                  key: 'changes',
                  label: 'Change summary',
                  value: diff ? 'Changes prepared for review' : 'No visible field changes returned',
                },
              ]} />
            </div>
          ),
          footer: (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', width: '100%' }}>
              <Button label="Close" kind="ghost" onClick={() => modal.close()} />
              <Button
                label="Apply cancel"
                iconName="close"
                kind="danger"
                capability={CAP.SHIPMENTS_WRITE}
                onClick={() => void applyCancel()}
              />
            </div>
          ),
        });
        pushToast('Cancel preview ready', 'warn');
      })
      .catch((caught) => {
        const message = caught instanceof Error && caught.message ? caught.message : 'Cancel preview failed';
        modal.open({
          title: `Cancel preview ${s.tracking_number}`,
          body: <StateView kind="error" title="Cancel preview failed" hint={message} />,
          footer: <Button label="Close" kind="ghost" onClick={() => modal.close()} />,
        });
        pushToast(`Cancel preview failed - ${message}`, 'danger');
      });
  }

  function openShipmentDrawer(s: Shipment, initialTab = 'timeline') {
    drawer.open({
      title: `${s.tracking_number} · ${s.service_type}`,
      size: 'xl',
      deepLink: `/operate/shipments?focus=${encodeURIComponent(s.id)}`,
      onClose: () => {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const currentFocus = params.get('focus');
        if (currentFocus !== s.id && currentFocus !== s.tracking_number) return;
        clearFocusedShipmentContext();
      },
      body: <ShipmentDetail shipment={s} initialTab={initialTab} />,
      footer: (
        <ShipmentDrawerFooter
          shipment={s}
          onResort={async () => {
            try {
              await resort.mutateAsync(s.id);
              await refetchShipmentOperationViews(s.id);
              pushToast('Resort ok - basket policy reapplied', 'good');
            } catch (err) {
              pushToast('Resort failed. Try again.', 'danger');
            }
          }}
          onOpenReschedule={() => openRescheduleModal(s)}
          onOpenLabels={() => openShipmentDrawer(s, 'labels')}
          onOpenCancelPreview={() => openCancelPreviewModal(s)}
          onOpenAmend={() => openAmendShipmentModal(s)}
        />
      ),
    });
  }

  function openRescheduleModal(s: Shipment) {
    // CLAIM-LIFECYCLE-LINK Gap 2: rebuilt as a 2-step picker.
    // Step 1: operator picks a slot_date.
    // Step 2: list_delivery_slots_v1({shipment_id, slot_date}) fetches the
    //         policy-resolved windows for review.
    // The canonical backend remains slot-date-first: reserve_delivery_slot_v1
    // resolves the final policy window and returns the persisted readback.
    function RescheduleForm() {
      const [slotDate, setSlotDate] = useState<string>('');
      const slotsQuery = useListDeliverySlots({ shipment_id: s.id, slot_date: slotDate });
      const reschedule = useShipmentAmendCancel();
      // Resolved-policy chip — read from the canonical settings resolver so
      // the operator sees the actual ladder source for delivery_slot_policy
      // (override_of trail) rather than a hardcoded scope label.
      const slotPolicy = useResolveSettings('delivery_slot_policy');
      const list = (slotsQuery.data ?? []) as Array<{
        window_id: string;
        slot_date: string;
        window_start_local: string;
        window_end_local: string;
        remaining: number | null;
      }>;
      const applySlotDate = (nextDate: string) => {
        if (nextDate === slotDate) return;
        setSlotDate(nextDate);
      };
      const canApply =
        !!slotDate &&
        !reschedule.isPending &&
        !slotsQuery.isLoading &&
        !slotsQuery.error &&
        list.length > 0;
      return (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
            <Chip
              size="xs"
              kind="info"
              label={
                <span
                  className="mono"
                  title="Resolved through the override ladder"
                  data-testid="reschedule-resolved-policy"
                >
                  Delivery slot policy
                  {slotPolicy.data
                    ? ` · scope: ${slotPolicy.data.resolved_from}`
                    : ' · resolving…'}
                </span>
              }
            />
            <Chip
              size="xs"
              kind="neutral"
              label="Delivery slot policy"
            />
            <Chip
              size="xs"
              kind="neutral"
              label="Reservation workflow"
            />
          </div>
          <p className="state__hint">
            Pick a date to start the reschedule workflow. Available windows are
            checked for operator review; the system confirms the final reserved
            window after apply.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: '10px',
            }}
          >
            <label className="mono" htmlFor="reschedule-date">Date</label>
            <input
              id="reschedule-date"
              data-testid="reschedule-date"
              className="dt-inline-input"
              type="date"
              value={slotDate}
              onInput={(e) => applySlotDate(e.currentTarget.value)}
              onChange={(e) => applySlotDate(e.currentTarget.value)}
              onBlur={(e) => applySlotDate(e.currentTarget.value)}
            />
          </div>
          <div style={{ marginTop: '14px' }}>
            <div className="section-eyebrow" style={{ marginBottom: '6px' }}>Available windows</div>
            {!slotDate ? (
              <StateView kind="empty" hint="Pick a date to load windows." />
            ) : slotsQuery.isLoading ? (
              <StateView kind="loading" hint="Loading windows…" />
            ) : slotsQuery.error ? (
              <StateView kind="error" hint={String(slotsQuery.error)} />
            ) : list.length === 0 ? (
              <StateView kind="empty" hint="No windows available for that date." />
            ) : (
              <div data-testid="reschedule-window-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {list.map((slot) => {
                  return (
                    <span
                      key={slot.window_id}
                      data-testid={`reschedule-window-${slot.window_id}`}
                      data-window-id={slot.window_id}
                      className="chip chip--sm chip--neutral"
                    >
                      <span className="mono">
                        {slot.window_start_local}–{slot.window_end_local}
                      </span>
                      <span style={{ marginInlineStart: '6px', color: 'var(--ink-3)' }}>
                        · {slot.remaining == null ? 'open capacity' : `${slot.remaining} spots`}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel', 'Cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Apply reschedule"
              kind="primary"
              capability={CAP.SHIPMENTS_WRITE}
              disabled={!canApply}
              onClick={async () => {
                if (!slotDate) {
                  modal.close();
                  return;
                }
                if (slotsQuery.isLoading || slotsQuery.error || list.length === 0) {
                  pushToast('Choose a date with an available delivery window before applying reschedule.', 'danger');
                  return;
                }
                modal.open({
                  title: `Apply reschedule ${s.tracking_number}`,
                  body: (
                    <StateView
                      kind="loading"
                      title="Applying reschedule workflow"
                      hint="Starting the workflow and refreshing the visible shipment context."
                    />
                  ),
                });
                try {
                  const result = await reschedule.mutateAsync({
                    shipmentId: s.id,
                    op: 'reschedule',
                    payload: {
                      slot_date: slotDate,
                      source: 'console_v2.shipments.reschedule_modal',
                    },
                    dryRun: false,
                  });
                  await refetchShipmentOperationViews(s.id);
                  const record = (result ?? {}) as Record<string, unknown>;
                  modal.open({
                    title: `Reschedule applied ${s.tracking_number}`,
                    body: (
                      <div data-testid="shipment-reschedule-apply-result">
                        <p className="state__hint">
                          Reschedule workflow started and the visible shipment views were refreshed.
                        </p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '10px 0' }}>
                          <Chip size="xs" kind="good" label="Workflow started" />
                          <Chip size="xs" kind="info" label={`Date ${slotDate}`} />
                          {record.workflow_run_id ? (
                            <Chip size="xs" kind="info" label="Workflow confirmed" />
                          ) : null}
                          {record.canonical_entrypoint ? (
                            <Chip size="xs" kind="info" label="Workflow path confirmed" />
                          ) : null}
                        </div>
                        <WorkflowMutationProof record={record} slotDate={slotDate} />
                      </div>
                    ),
                    footer: <Button label="Close" kind="ghost" onClick={() => modal.close()} />,
                  });
                  pushToast(`Shipment reschedule workflow started for ${slotDate}`, 'good');
                } catch (caught) {
                  const message = caught instanceof Error && caught.message ? caught.message : 'Reschedule apply failed';
                  modal.open({
                    title: `Apply reschedule ${s.tracking_number}`,
                    body: <StateView kind="error" title="Reschedule apply failed" hint={message} />,
                    footer: <Button label="Close" kind="ghost" onClick={() => modal.close()} />,
                  });
                  pushToast(`Reschedule apply failed - ${message}`, 'danger');
                }
              }}
            />
          </div>
        </>
      );
    }
    modal.open({ title: `Reschedule ${s.tracking_number}`, body: <RescheduleForm /> });
  }

  function openAmendShipmentModal(s: Shipment) {
    function normalizedString(value: unknown): string {
      return String(value ?? '').trim();
    }

    function normalizedNumber(value: unknown): number | null {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function AmendShipmentForm() {
      const serviceOptions = (getLookups('service_type') as Array<{ value: string; label?: string }>).filter(
        (row) => row.value,
      );
      const currencyOptions = (getLookups('currency') as Array<{ value: string; label?: string }>).filter(
        (row) => row.value,
      );
      const [draft, setDraft] = useState({
        service_type: normalizedString(s.service_type),
        client_reference_number: normalizedString(s.client_reference_number),
        carrier_reference_number: normalizedString(s.carrier_reference_number),
        cod_amount: normalizedString(s.cod_amount),
        cod_currency: normalizedString(s.cod_currency),
        special_instructions: normalizedString(s.special_instructions),
      });
      const [err, setErr] = useState('');
      const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

      const update = (key: keyof typeof draft, value: string) => {
        setDraft((prev) => ({ ...prev, [key]: value }));
        setErr('');
      };

      const buildPayload = (): Record<string, unknown> => {
        const payload: Record<string, unknown> = {};
        if (draft.service_type !== normalizedString(s.service_type)) {
          payload.service_type = draft.service_type;
        }
        if (draft.client_reference_number !== normalizedString(s.client_reference_number)) {
          payload.client_reference_number = draft.client_reference_number;
        }
        if (draft.carrier_reference_number !== normalizedString(s.carrier_reference_number)) {
          payload.carrier_reference_number = draft.carrier_reference_number;
        }
        const nextCodAmount = normalizedNumber(draft.cod_amount);
        const currentCodAmount = normalizedNumber(s.cod_amount);
        if (nextCodAmount !== currentCodAmount) {
          payload.cod_amount = nextCodAmount ?? 0;
        }
        if (draft.cod_currency !== normalizedString(s.cod_currency)) {
          payload.cod_currency = draft.cod_currency;
        }
        if (draft.special_instructions !== normalizedString(s.special_instructions)) {
          payload.special_instructions = draft.special_instructions;
        }
        return payload;
      };

      async function submit(dryRun: boolean) {
        const payload = buildPayload();
        if (Object.keys(payload).length === 0) {
          setErr('Change at least one shipment field before applying.');
          return;
        }
        setErr('');
        try {
          const result = await amend.mutateAsync({
            shipmentId: s.id,
            op: 'modify',
            payload: {
              ...payload,
              source: 'console_v2.shipments.amend_modal',
            },
            dryRun,
          });
          if (dryRun) {
            setPreview((result as Record<string, unknown>) ?? {});
            pushToast('Shipment amend preview ready', 'info');
            return;
          }
          modal.close();
          pushToast(`Shipment amend workflow started · ${s.tracking_number}`, 'good');
        } catch (caught) {
          const message = caught instanceof Error && caught.message ? caught.message : 'Shipment amend failed';
          setErr(message);
          pushToast(`Shipment amend failed · ${message}`, 'danger');
        }
      }

      return (
        <div data-testid="shipment-amend-form">
          <p className="state__hint">
            Apply shipment changes through the approved workflow. Customer or sender requests remain in the review queue.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '160px minmax(0, 1fr)',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: '10px',
            }}
          >
            <label className="mono" htmlFor="shipment-amend-service">Service</label>
            <select
              id="shipment-amend-service"
              className="dt-inline-input"
              value={draft.service_type}
              onChange={(e) => update('service_type', e.target.value)}
            >
              {serviceOptions.length === 0 ? (
                <option value={draft.service_type}>{draft.service_type || 'Current service'}</option>
              ) : (
                serviceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label ?? option.value}
                  </option>
                ))
              )}
            </select>
            <label className="mono" htmlFor="shipment-amend-client-ref">Client reference</label>
            <input
              id="shipment-amend-client-ref"
              className="dt-inline-input"
              value={draft.client_reference_number}
              onChange={(e) => update('client_reference_number', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-amend-carrier-ref">Carrier reference</label>
            <input
              id="shipment-amend-carrier-ref"
              className="dt-inline-input"
              value={draft.carrier_reference_number}
              onChange={(e) => update('carrier_reference_number', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-amend-cod-amount">COD amount</label>
            <input
              id="shipment-amend-cod-amount"
              className="dt-inline-input"
              type="number"
              value={draft.cod_amount}
              onChange={(e) => update('cod_amount', e.target.value)}
            />
            <label className="mono" htmlFor="shipment-amend-currency">Currency</label>
            <select
              id="shipment-amend-currency"
              className="dt-inline-input"
              value={draft.cod_currency}
              onChange={(e) => update('cod_currency', e.target.value)}
            >
              {currencyOptions.length === 0 ? (
                <option value={draft.cod_currency}>{draft.cod_currency || 'Current currency'}</option>
              ) : (
                currencyOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label ?? option.value}
                  </option>
                ))
              )}
            </select>
            <label className="mono" htmlFor="shipment-amend-instructions">Instructions</label>
            <textarea
              id="shipment-amend-instructions"
              className="dt-inline-input"
              rows={3}
              value={draft.special_instructions}
              onChange={(e) => update('special_instructions', e.target.value)}
            />
          </div>
          {preview ? (
            <div style={{ marginTop: 12 }}>
              <KvGrid rows={previewSummaryRows((preview.diff ?? preview) as Record<string, unknown>)} />
            </div>
          ) : null}
          {err ? <div style={{ color: 'var(--danger-ink)', fontSize: 11, padding: '8px 4px 0' }}>{err}</div> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <Button label={t('common.cancel', 'Cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Preview amend"
              kind="ghost"
              capability={CAP.SHIPMENTS_WRITE}
              disabled={amend.isPending}
              onClick={() => void submit(true)}
            />
            <Button
              label="Apply amend"
              iconName="edit"
              kind="primary"
              capability={CAP.SHIPMENTS_WRITE}
              disabled={amend.isPending}
              onClick={() => void submit(false)}
            />
          </div>
        </div>
      );
    }

    modal.open({ title: `Amend ${s.tracking_number}`, body: <AmendShipmentForm /> });
  }

  async function ensureShipmentOperationAllowed(
    s: Shipment,
    operations: ShipmentOperationName[],
    actionLabel: string,
  ): Promise<boolean> {
    try {
      const options = await api.shipment_amend_cancel_options_v1(s.id);
      queryClient.setQueryData(qk.shipmentOperationOptions(s.id), options);
      const disabledReason = anyOperationDisabledReason(
        options,
        { isLoading: false, hasError: false },
        operations,
        actionLabel,
      );
      if (disabledReason) {
        pushToast(disabledReason, 'danger');
        return false;
      }
      return true;
    } catch {
      pushToast('Shipment policy unavailable', 'danger');
      return false;
    }
  }

  async function openAmendShipmentModalWithPolicy(s: Shipment) {
    if (await ensureShipmentOperationAllowed(s, ['modify', 'address'], 'amend')) {
      openAmendShipmentModal(s);
    }
  }

  async function openCancelPreviewModalWithPolicy(s: Shipment) {
    if (await ensureShipmentOperationAllowed(s, ['cancel'], 'cancel')) {
      openCancelPreviewModal(s);
    }
  }

  function ShipmentDetail({ shipment, initialTab }: { shipment: Shipment; initialTab: string }) {
    return (
      <ShipmentContextPanel
        shipmentId={shipment.id}
        fallbackShipment={shipment}
        allowFallbackWhileLoading
        initialTab={initialTab}
        directoryOverride={shipmentDirectoryById.get(shipment.id)}
      />
    );
  }

  const pills: ReactNode[] = [
    <ScopePill
      key="scope"
      scopeType={scope.client?.id ? 'client' : 'tenant'}
      scopeId={scope.client?.id ?? scope.tenant?.id}
    />,
    <Chip key="reg" size="xs" label="Shipment data" />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="shipments"
          eyebrow="Operate"
          titleAccent="Shipments"
          titlePlain="operations workbench"
        />
        <StateView
          kind="denied"
          capability={CAP.SHIPMENTS_READ}
          hint="You do not have permission to view shipments."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="shipments"
        eyebrow="Operate"
        titleAccent="Shipments"
        titlePlain="operations workbench"
        pills={pills}
        actions={[
          <Button
            key="import"
            label="Import shipments"
            iconName="upload"
            kind="ghost"
            capability={CAP.IMPORTS_WRITE}
            onClick={() => {
              go('/platform/imports');
            }}
          />,
          <Button
            key="bulk"
            label="Bulk amend / cancel"
            iconName="edit"
            kind="ghost"
            capability={CAP.SHIPMENTS_WRITE}
            onClick={() => {
              go('/operate/amend-cancel');
            }}
          />,
          <Button
            key="create"
            label="Create shipment"
            iconName="plus"
            kind="primary"
            capability={CAP.SHIPMENTS_WRITE}
            onClick={openCreateShipmentModal}
          />,
        ]}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : shipmentsError ? (
        <StateView
          kind={isPermissionDeniedError(shipmentsError) ? 'denied' : 'error'}
          title="Shipments unavailable"
          capability={isPermissionDeniedError(shipmentsError) ? CAP.SHIPMENTS_READ : undefined}
          hint={(shipmentsError as Error).message}
        />
      ) : (
        <DataTable<Shipment>
          columns={columns}
          rows={visibleShipments}
          viewKey="shipments"
          entityKind="shipment"
          searchKeys={[
            'tracking_number',
            'client_reference_number',
            'carrier_reference_number',
            'client_label',
            'recipient_label',
            'destination_city',
          ]}
          onRowClick={openShipmentDrawer}
          getRowClass={(r) => (isShipmentRisk(r) ? 'is-risk' : undefined)}
          rowDeepLink={(r) => `/operate/shipments?focus=${encodeURIComponent(r.id)}`}
          onCellEdit={
            canWrite
              ? async (row, key, newValue) => {
                  await amend.mutateAsync({
                    shipmentId: row.id,
                    op: 'amend_field',
                    payload: { [key]: newValue },
                    dryRun: false,
                  });
                  return { ok: true };
                }
              : undefined
          }
          bulkActions={[
            {
              label: 'Bulk cancel preview',
              icon: 'close',
              kind: 'danger',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: async (rows) => {
                const r = (await batchOp.mutateAsync({
                  ids: rows.map((rr) => rr.id),
                  op: 'cancel',
                  payload: {},
                  dryRun: true,
                })) as { count?: number };
                pushToast(`Bulk cancel preview ready - ${r.count ?? rows.length} rows`, 'warn');
              },
            },
            {
              label: 'Bulk cancel apply',
              icon: 'close',
              kind: 'danger',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: async (rows) => {
                const r = (await batchOp.mutateAsync({
                  ids: rows.map((rr) => rr.id),
                  op: 'cancel',
                  payload: { source: 'console_v2.shipments.bulk_cancel_apply' },
                  dryRun: false,
                })) as { count?: number };
                await refetchShipmentOperationViews(rows.map((rr) => rr.id));
                pushToast(`Bulk cancel applied to ${r.count ?? rows.length} rows`, 'good');
              },
            },
            {
              label: 'Resort',
              icon: 'rotate',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: async (rows) => {
                try {
                  await Promise.all(rows.map((r) => resort.mutateAsync(r.id)));
                  await refetchShipmentOperationViews(rows.map((r) => r.id));
                  pushToast(`Resorted ${rows.length} shipments`, 'good');
                } catch (err) {
                  pushToast('Resort failed. Try again.', 'danger');
                }
              },
            },
            {
              label: 'Bulk print labels',
              icon: 'file',
              kind: 'primary',
              capability: CAP.LABELS_DOWNLOAD,
              onClick: async (rows) => {
                const selectedIds = rows.map((r) => r.id).filter(Boolean);
                if (!selectedIds.length) {
                  pushToast('No shipments selected for label printing', 'warn');
                  return;
                }
                const organizationIds = Array.from(
                  new Set(
                    rows
                      .map((r) => (typeof r.organization_id === 'string' ? r.organization_id : ''))
                      .filter(Boolean),
                  ),
                );
                try {
                  await api.runCommand(
                    'shipments.print_labels',
                    {
                      resource_key: 'shipments',
                      selected_ids: selectedIds,
                      selected_id: selectedIds.length === 1 ? selectedIds[0] : undefined,
                      selection_count: selectedIds.length,
                      job_purpose: 'primary',
                      source: 'console_v2.shipments.bulk_print_labels',
                      ...(organizationIds.length === 1 ? { organization_id: organizationIds[0] } : {}),
                    },
                    { dryRun: false },
                  );
                  pushToast(
                    `Print queued for ${selectedIds.length} shipment${selectedIds.length === 1 ? '' : 's'}`,
                    'good',
                  );
                } catch {
                  pushToast('Bulk print request could not be started. Try again.', 'danger');
                }
              },
            },
            // CLAIM-OPERATIONS-WIRING (Phase C1) — bulk Reprint now hits the
            // canonical request_label_reprint RPC per row. Previously this
            // surface only had a per-row Reprint button on the LabelsTab.
            // CYCLE-E2 STRICT-ISOLATION (P1 #3) — label_id resolves through
            // the canonical labels resource per shipment; rows without an
            // active label are skipped (no synthetic id minting).
            {
              label: 'Bulk reprint labels',
              icon: 'refresh',
              capability: CAP.LABELS_REPRINT,
              disabled: (rows) =>
                rows.some((row) => shipmentLabelCount(row) > 0) && shipmentLabelsReadbackQuery.isLoading
                  ? true
                  : rows.every((row) => !activeLabelByShipmentId.has(row.id)),
              disabledReason: (rows) => {
                if (rows.some((row) => shipmentLabelCount(row) > 0) && shipmentLabelsReadbackQuery.isLoading) {
                  return 'Checking active label status';
                }
                if (rows.every((row) => !activeLabelByShipmentId.has(row.id))) {
                  return 'Select at least one shipment with an active label';
                }
                return undefined;
              },
              onClick: async (rows) => {
                const reason = defaultLabelReprintReason();
                if (!reason) {
                  pushToast('No label reprint reason is configured.', 'danger');
                  return;
                }
                const results = await Promise.all(
                  rows.map(async (r) => {
                    const labelId = activeLabelByShipmentId.get(r.id)?.id;
                    if (!labelId) return { ok: false as const, shipmentId: r.id };
                    await reprint.mutateAsync({ labelId, reason, shipmentId: r.id });
                    return { ok: true as const, shipmentId: r.id };
                  }),
                );
                const queued = results.filter((x) => x.ok).length;
                const skipped = results.length - queued;
                if (skipped > 0) {
                  pushToast(
                    `${queued} label reprints queued · ${skipped} skipped without an active label`,
                    queued > 0 ? 'warn' : 'danger',
                  );
                } else {
                  pushToast(`${queued} label reprints queued`, 'good');
                }
              },
            },
          ]}
          rowActions={[
            { label: 'Open detail', icon: 'eye', onClick: openShipmentDrawer },
            {
              label: 'Amend',
              icon: 'edit',
              kind: 'primary',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: (r) => void openAmendShipmentModalWithPolicy(r),
            },
            {
              label: 'Resort (basket policy)',
              icon: 'rotate',
              capability: CAP.SHIPMENTS_WRITE,
              disabled: true,
              disabledReason: ROW_ACTION_POLICY_CHECK_REASON,
              onClick: async (r) => {
                await resort.mutateAsync(r.id);
                await refetchShipmentOperationViews(r.id);
                pushToast('Resort ok', 'good');
              },
            },
            {
              label: 'View decision trail',
              icon: 'trace',
              onClick: (r) => {
                openShipmentDrawer(r, 'decisions');
              },
            },
            {
              label: 'Preview cancel',
              icon: 'close',
              kind: 'danger',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: (r) => void openCancelPreviewModalWithPolicy(r),
            },
          ]}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ---------- Tab components ----------

export interface ShipmentContextPanelProps {
  shipmentId: string;
  fallbackShipment?: Shipment | null;
  allowFallbackWhileLoading?: boolean;
  initialTab?: string;
  directoryOverride?: ShipmentDirectoryRow | null;
}

export function shipmentContextTitle(shipment: Pick<Shipment, 'id'> & Partial<Shipment>): string {
  const tracking = String(shipment.tracking_number ?? shipment.id ?? '').trim();
  const service = String(shipment.service_type ?? '').trim();
  return service ? `${tracking} · ${service}` : tracking || 'Shipment context';
}

export interface OpenShipmentContextDrawerOptions {
  fallbackShipment?: Partial<Shipment> | null;
  initialTab?: string;
  deepLink?: boolean;
}

export function openShipmentContextDrawer(
  drawer: Pick<UseDrawerHandle, 'open'>,
  shipmentId: string,
  options: OpenShipmentContextDrawerOptions = {},
): void {
  drawer.open({
    title: 'Shipment context',
    size: 'xl',
    deepLink: options.deepLink === false
      ? undefined
      : `/operate/shipments?focus=${encodeURIComponent(shipmentId)}`,
    body: (
      <ShipmentContextPanel
        shipmentId={shipmentId}
        fallbackShipment={options.fallbackShipment ? ({ ...options.fallbackShipment, id: shipmentId } as Shipment) : null}
        initialTab={options.initialTab ?? 'timeline'}
      />
    ),
  });
}

export function ShipmentContextPanel({
  shipmentId,
  fallbackShipment = null,
  allowFallbackWhileLoading = false,
  initialTab = 'timeline',
  directoryOverride = null,
}: ShipmentContextPanelProps) {
  const { fmtCurrency, fmtDateTime } = useI18n();
  const canWrite = useCapability(CAP.SHIPMENTS_WRITE);
  const amend = useShipmentAmendCancel();
  const shipmentQuery = useResource<Shipment>('shipments', shipmentId);
  const directoryQuery = useResourceList<ShipmentDirectoryRow>(
    'shipment_directory',
    { filter: { id: shipmentId }, page_size: 1 },
    { enabled: Boolean(shipmentId) && !directoryOverride },
  );
  const labelJobsBadgeQuery = useResourceList<ShipmentLabelJobRow>(
    'label_jobs',
    { filter: { shipment_id: shipmentId } },
    { enabled: Boolean(shipmentId) },
  );
  if (shipmentQuery.error) {
    if (isPermissionDeniedError(shipmentQuery.error)) {
      return (
        <StateView
          kind="denied"
          title="Shipment context unavailable"
          hint="Shipment context requires shipment read permission."
        />
      );
    }
    return <StateView kind="error" title="Shipment context unavailable" hint={(shipmentQuery.error as Error).message} />;
  }
  const shipment =
    shipmentQuery.data ??
    (allowFallbackWhileLoading ? fallbackShipment : null) ??
    null;
  if (!shipment && shipmentQuery.isLoading) {
    const reference = fallbackShipment?.tracking_number ?? shipmentId;
    return (
      <StateView
        kind="loading"
        title="Loading shipment context"
        hint={`Loading shipment record ${reference}.`}
      />
    );
  }
  if (!shipment) {
    return <StateView kind="empty" title="Shipment not found" hint="The selected shipment is not visible in this scope." />;
  }

  // Shared shipment drawer body for every operator surface that references a
  // shipment. This keeps related data in the current workflow instead of
  // forcing raw table pages or route jumps.
  const directory = directoryOverride ?? directoryQuery.data?.rows?.[0] ?? null;
  const destinationLabel = directory?.destination_city ?? shipment.destination_city;
  const queuedLabelJobCount = labelJobsBadgeQuery.data?.total ?? labelJobsBadgeQuery.data?.rows?.length ?? 0;
  const labelBadgeCount = Math.max(directory?.label_count ?? 0, queuedLabelJobCount);
  const summaryRows: KvRow[] = [
    { key: 'tracking_number', label: 'Tracking #', value: shipment.tracking_number, mono: true, editable: false },
    { key: 'client_reference_number', label: 'Client ref', value: shipment.client_reference_number, mono: true, capability: CAP.SHIPMENTS_WRITE },
    { key: 'carrier_reference_number', label: 'Carrier ref', value: shipment.carrier_reference_number, mono: true, capability: CAP.SHIPMENTS_WRITE },
    { key: 'status', label: 'Status', value: shipment.status, lookup: 'shipment_status', capability: CAP.SHIPMENTS_WRITE },
    { key: 'service_type', label: 'Service', value: shipment.service_type, lookup: 'service_type', capability: CAP.SHIPMENTS_WRITE },
    {
      key: 'cod_amount',
      label: 'COD',
      value: shipment.cod_amount ? fmtCurrency(shipment.cod_amount, shipment.cod_currency) : '—',
      mono: true,
      editable: false,
    },
    { key: 'cod_currency', label: 'Currency', value: shipment.cod_currency, lookup: 'currency', editable: false },
    { key: 'promised_delivery_date', label: 'Promised', value: fmtDateTime(shipment.promised_delivery_date ?? ''), editable: false },
    { key: 'destination_city', label: 'Destination', value: destinationLabel, editable: false },
    ...(directory?.client_label
      ? [{ key: 'client_label', label: 'Client', value: directory.client_label, editable: false }]
      : []),
    ...(directory?.sender_label
      ? [{ key: 'sender_label', label: 'Sender', value: directory.sender_label, editable: false }]
      : []),
    ...(directory?.recipient_label
      ? [{ key: 'recipient_label', label: 'Recipient', value: directory.recipient_label, editable: false }]
      : []),
  ];

  const tabs: RelatedTab[] = [
    { id: 'timeline', label: 'Timeline', render: () => <TimelineTab shipmentId={shipment.id} /> },
    { id: 'evidence', label: 'Evidence', render: () => <EvidenceTab shipment={shipment} /> },
    {
      id: 'boxes',
      label: 'Boxes',
      count: directory?.box_actual_count ?? shipment.box_count,
      render: () => <BoxesTab shipmentId={shipment.id} />,
    },
    { id: 'baskets', label: 'Baskets', render: () => <BasketsTab shipmentId={shipment.id} /> },
    { id: 'recipient', label: 'Recipient', count: 1, render: () => <RecipientTab shipment={shipment} /> },
    {
      id: 'address',
      label: 'Address',
      count: 1,
      render: () => (
        <Suspense fallback={<StateView kind="loading" title="Loading address" />}>
          <AddressTabLazy shipment={shipment} />
        </Suspense>
      ),
    },
    { id: 'cod', label: 'COD', count: shipment.cod_amount ? 1 : 0, render: () => <CodTab shipment={shipment} /> },
    { id: 'route', label: 'Route', render: () => <RouteTab shipment={shipment} /> },
    {
      id: 'tasks',
      label: 'Tasks',
      count: directory?.active_task_count,
      render: () => <TasksTab shipment={shipment} />,
    },
    {
      id: 'comms',
      label: 'Comms',
      count: directory?.comms_attempt_count,
      render: () => <CommsTab shipment={shipment} />,
    },
    {
      id: 'labels',
      label: 'Labels',
      count: labelBadgeCount,
      render: () => <LabelsTab shipment={shipment} />,
    },
    {
      id: 'scans',
      label: 'Scans',
      count: directory?.scan_event_count,
      render: () => <ScansTab shipment={shipment} />,
    },
    { id: 'decisions', label: 'Decisions', render: () => <DecisionsTab shipment={shipment} /> },
    { id: 'audit', label: 'Audit', render: () => <AuditTab shipment={shipment} /> },
  ];

  const summary: ReactNode = (
    <div className="rail-body" style={{ paddingBottom: 0 }}>
      <h4 className="eyebrow">Shipment</h4>
      <KvGrid
        rows={summaryRows}
        onEdit={
          canWrite
            ? async (key, value) => {
                try {
                  if (!SHIPMENT_SUMMARY_EDIT_KEYS.has(key)) {
                    throw new Error(`Shipment summary field ${key} is read-only`);
                  }
                  const next = normalizeShipmentSummaryEditValue(value);
                  await amend.mutateAsync({
                    shipmentId: shipment.id,
                    op: 'amend_field',
                    payload: { [key]: next },
                    dryRun: false,
                  });
                  const readback = await api.ui_get_resource_v1<Shipment>('shipments', shipment.id);
                  assertShipmentSummaryReadback(readback, key, next);
                  pushToast(`Saved · ${key}`, 'good');
                } catch {
                  pushToast('Shipment summary could not be updated. Try again.', 'danger');
                }
              }
            : undefined
        }
      />
    </div>
  );

  return <RelatedRail key={`${shipment.id}:${initialTab}`} summary={summary} tabs={tabs} defaultTab={initialTab} />;
}

function TimelineTab({ shipmentId }: { shipmentId: string }) {
  const { data, isLoading, error } = useShipmentTimeline(shipmentId);
  if (isLoading) return <StateView kind="loading" />;
  if (error) return <StateView kind="error" hint={(error as Error).message} />;
  const rows = normalizeShipmentTimelineRows(data);
  return (
    <div className="timeline" style={{ padding: '0 0 8px' }}>
      {rows.map((row, i) => {
        // W77 (Operate Cycle F-R-17 P1) — pending-row modifier resolves
        // canonically through `shipment_timeline_status.<status>.metadata.is_pending`.
        // Replaces literal `row.status === 'pending'` comparison so adding a
        // pending-equivalent status is a single seed update (AGENTS.md §2
        // ZERO HARDCODING + §4 SSOT + §6 row-driven config). Missing canonical
        // row → no modifier class (loud rendering: the operator sees the
        // un-mapped status without a fabricated visual cue).
        const isPending =
          (lookupRow('shipment_timeline_status', row.status ?? '') as { metadata?: { is_pending?: boolean } } | null)
            ?.metadata?.is_pending === true;
        return (
          <div key={`${row.time}-${i}`} className={`timeline__row ${isPending ? 'is-pending' : ''}`}>
            <span className="timeline__node" />
            <span className="timeline__time mono">
              {row.time.split('T')[1]?.slice(0, 5) || row.time}
            </span>
            <div className="timeline__body">
              <div className="timeline__action">{row.action}</div>
              <div className="timeline__detail">{row.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EvidenceTab({ shipment }: { shipment: Shipment }) {
  const { fmtCurrency, fmtDateTime } = useI18n();
  const actionsQuery = useResourceList<Record<string, unknown>>('shipment_actions', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
    page_size: 25,
  });
  const tasksQuery = useResourceList<Record<string, unknown>>('tasks', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'updated_at', dir: 'desc' },
    page_size: 50,
  });

  if (actionsQuery.isLoading || tasksQuery.isLoading) return <StateView kind="loading" />;
  const actionsError = actionsQuery.error ?? null;
  const tasksError = tasksQuery.error ?? null;
  const bothEvidenceStreamsFailed = Boolean(actionsError && tasksError);
  if (bothEvidenceStreamsFailed) {
    const error = actionsError ?? tasksError;
    if (error && isPermissionDeniedError(error)) {
      return (
        <StateView
          kind="denied"
          title="Proof of delivery unavailable"
          hint="Evidence reads require shipment action and task visibility."
        />
      );
    }
    return <StateView kind="error" title="Proof of delivery unavailable" hint={(error as Error | null)?.message} />;
  }
  const partialError = actionsError ?? tasksError;

  const evidence = [
    ...(!actionsError ? actionsQuery.data?.rows ?? [] : [])
      .map((row) => podEvidenceProjectionFromRow(row, 'shipment_action')),
    ...(!tasksError ? tasksQuery.data?.rows ?? [] : [])
      .filter(isCompletedRouteStopEvidenceTask)
      .map((row) => podEvidenceProjectionFromRow(row, 'task_closeout')),
  ]
    .filter((row): row is ShipmentPodEvidenceProjection => Boolean(row))
    .sort((a, b) => {
      const at = Date.parse(String(a.capturedAt ?? a.occurredAt ?? ''));
      const bt = Date.parse(String(b.capturedAt ?? b.occurredAt ?? ''));
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });

  if (!evidence.length) {
    return (
      <div className="state__hint" style={{ padding: '6px 14px' }}>
        No proof of delivery has been captured for this shipment yet. Close the delivery stop from Dispatch to record handover, identity, artifacts, and geostamp evidence.
      </div>
    );
  }

  const latest = evidence[0];
  const geostampText = latest.geostamp
    ? [
        firstText(latest.geostamp.latitude, latest.geostamp.lat),
        firstText(latest.geostamp.longitude, latest.geostamp.lng),
      ]
        .filter(Boolean)
        .join(', ')
    : 'Not captured';
  const identityText = latest.identityKind || latest.identityLast4
    ? `${lookupDisplayValue('recipient_identity_kind', latest.identityKind, titleCaseKey(latest.identityKind))}${latest.identityLast4 ? ` ending ${latest.identityLast4}` : ''}`
    : 'Not captured';
  const artifactSummary = latest.artifactIds.length
    ? `${latest.artifactIds.length} artifact${latest.artifactIds.length === 1 ? '' : 's'} linked`
    : 'No artifact bundle';
  const payment = latest.paymentCollection ?? null;
  const paymentCurrency = payment?.currency ?? shipment.cod_currency ?? '';
  const paymentOutcome = payment?.outcome
    ? lookupDisplayValue('payment_collection_outcome', payment.outcome, titleCaseKey(payment.outcome))
    : 'Not required';
  const paymentMethod = payment?.method
    ? lookupDisplayValue('payment_collection_method', payment.method, titleCaseKey(payment.method))
    : 'Not recorded';
  const paymentExpected = payment?.expectedAmount == null
    ? 'Not recorded'
    : fmtCurrency(payment.expectedAmount, paymentCurrency);
  const paymentCollected = payment?.collectedAmount == null
    ? 'Not recorded'
    : fmtCurrency(payment.collectedAmount, paymentCurrency);
  const paymentVariance = payment?.varianceAmount == null
    ? 'Not recorded'
    : fmtCurrency(payment.varianceAmount, paymentCurrency);
  const rows: KvRow[] = [
    { key: 'handover_mode', label: 'Handover', value: lookupDisplayValue('delivery_handover_mode', latest.handoverMode, 'Not recorded'), editable: false },
    { key: 'recipient_name', label: 'Recipient', value: latest.recipientName ?? latest.recipientClass ?? 'Not recorded', editable: false },
    { key: 'identity', label: 'Identity proof', value: identityText, editable: false },
    { key: 'otp', label: 'OTP', value: latest.otpLast4 ? `Confirmed ending ${latest.otpLast4}` : latest.otpConfirmed ? 'Confirmed' : 'Not captured', editable: false },
    { key: 'signature', label: 'Recipient signature', value: latest.signatureArtifactId ? compactReference(latest.signatureArtifactId, 'Artifact') : 'Not linked', editable: false },
    { key: 'photo', label: 'Proof photo', value: latest.photoArtifactId ? compactReference(latest.photoArtifactId, 'Artifact') : 'Not linked', editable: false },
    { key: 'artifact_bundle', label: 'Artifact bundle', value: artifactSummary, editable: false },
    { key: 'payment_outcome', label: 'Payment outcome', value: paymentOutcome, editable: false },
    { key: 'payment_method', label: 'Payment method', value: paymentMethod, editable: false },
    { key: 'payment_expected', label: 'COD expected', value: paymentExpected, mono: payment?.expectedAmount != null, editable: false },
    { key: 'payment_collected', label: 'COD collected', value: paymentCollected, mono: payment?.collectedAmount != null, editable: false },
    { key: 'payment_variance', label: 'COD variance', value: paymentVariance, mono: payment?.varianceAmount != null, editable: false },
    { key: 'payment_discrepancy', label: 'COD discrepancy', value: payment?.discrepancyKind ? titleCaseKey(payment.discrepancyKind) : 'Not recorded', editable: false },
    { key: 'payment_receipt', label: 'Receipt context', value: payment?.receiptContext ?? 'Not recorded', editable: false },
    { key: 'geostamp', label: 'Geostamp', value: geostampText, mono: geostampText !== 'Not captured', editable: false },
    { key: 'route_stop_id', label: 'Route stop', value: latest.routeStopId ? compactReference(latest.routeStopId, 'Stop') : 'Not linked', mono: Boolean(latest.routeStopId), editable: false },
    { key: 'captured_at', label: 'Captured', value: latest.capturedAt ? fmtDateTime(latest.capturedAt) : 'Not captured', editable: false },
    { key: 'source', label: 'Source', value: latest.sourceLabel, editable: false },
  ];

  return (
    <div className="rail-body" style={{ paddingTop: 0 }} data-testid="shipment-evidence-tab">
      <h4 className="eyebrow">Proof of delivery</h4>
      {partialError ? (
        <div className="state__hint" data-testid="shipment-evidence-partial-read" style={{ padding: '0 14px 8px' }}>
          {isPermissionDeniedError(partialError)
            ? 'Some evidence streams are hidden by permission, but available proof is still shown.'
            : `Some evidence streams are unavailable: ${(partialError as Error).message}`}
        </div>
      ) : null}
      <KvGrid rows={rows} />
      {latest.artifactIds.length ? (
        <div data-testid="shipment-evidence-artifacts" style={{ padding: '6px 14px 10px', display: 'grid', gap: 6 }}>
          <h4 className="eyebrow" style={{ margin: 0 }}>Artifacts</h4>
          {latest.artifactIds.map((artifactId) => (
            <div key={artifactId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="mono">{compactReference(artifactId, 'Artifact')}</span>
              <Button
                label="Copy ID"
                iconName="copy"
                kind="ghost"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard?.writeText(artifactId);
                  pushToast('Artifact ID copied', 'good');
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
      {latest.notes ? (
        <div className="state__hint" style={{ padding: '6px 14px 10px' }}>
          {latest.notes}
        </div>
      ) : null}
      <DataTable
        columns={[
          { key: 'captured', label: 'Captured' },
          { key: 'handover', label: 'Handover' },
          { key: 'recipient', label: 'Recipient' },
          { key: 'artifacts', label: 'Artifacts' },
          { key: 'source', label: 'Source' },
        ]}
        rows={evidence.map((item) => ({
          id: item.id,
          captured: item.capturedAt ? fmtDateTime(item.capturedAt) : item.occurredAt ? fmtDateTime(item.occurredAt) : 'Not captured',
          handover: lookupDisplayValue('delivery_handover_mode', item.handoverMode, 'Not recorded'),
          recipient: item.recipientName ?? item.recipientClass ?? 'Not recorded',
          artifacts: item.artifactIds.length ? String(item.artifactIds.length) : 'None',
          source: item.sourceLabel,
        }))}
        allowSelection={false}
        emptyText="No proof evidence rows found."
      />
    </div>
  );
}

function BoxesTab({ shipmentId }: { shipmentId: string }) {
  // CLAIM-OPERATIONS-WIRING (Phase C1) — read seam moved from `api.seed.*` to
  // canonical resource registry (`ui_list_resource_v1('shipment_boxes')`).
  // Production swap: same call site reads from public.shipment_boxes via
  // ui_read_registry projection.
  //
  // W16-1 — closes OPERATIONS D3 §5/§6 (BoxesTab orphan cell-edit). Wires
  // box cell-edits through `shipment_amend_cancel_v1(op='modify')` with the
  // canonical workflow handler routing changes under
  // `changes.boxes.{box_id}.{key}`. Per the canonical contract
  // (`shipment_modify_v1` workflow template, migration 202603191030 line 30)
  // box-level metadata propagates through the same modify seam used for
  // recipient/COD edits — no per-field op alias required.
  const { data, isLoading, error } = useResourceList<Record<string, unknown>>('shipment_boxes', {
    filter: { shipment_id: shipmentId },
  });
  if (isLoading) return <StateView kind="loading" />;
  if (error) return <StateView kind="error" hint={(error as Error).message} />;
  const boxes = data?.rows ?? [];
  return (
    <DataTable
      columns={[
        { key: 'box_number', label: '#', sortable: true },
        { key: 'barcode', label: 'Barcode', mono: true, sortable: true, filterable: true },
        { key: 'weight_kg', label: 'Weight (kg)', align: 'right', type: 'number' },
        { key: 'fragile', label: 'Fragile', type: 'boolean' },
      ]}
      rows={boxes}
      allowSelection={false}
      emptyText="No boxes recorded for this shipment."
    />
  );
}

function BasketsTab({ shipmentId }: { shipmentId: string }) {
  const { fmtDateTime } = useI18n();
  const [selectedBasketId, setSelectedBasketId] = useState<string | null>(null);
  const itemsQuery = useResourceList<Record<string, unknown>>('basket_items', {
    filter: { shipment_id: shipmentId },
    sort: { key: 'added_at', dir: 'desc' },
    page_size: 500,
  });
  const items = useMemo(() => itemsQuery.data?.rows ?? [], [itemsQuery.data]);
  const basketIds = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((item) => (typeof item.basket_id === 'string' ? item.basket_id : ''))
            .filter(Boolean),
        ),
      ).sort(),
    [items],
  );
  const basketsQuery = useResourceRowsByIds<Record<string, unknown>>('baskets', basketIds, {
    enabled: basketIds.length > 0,
  });
  const basketRows = useMemo(() => basketsQuery.data?.rows ?? [], [basketsQuery.data]);
  const basketZoneIds = useMemo(
    () =>
      Array.from(
        new Set(
          basketRows
            .filter((basket) => !basketDirectZoneLabel(basket))
            .map((basket) => firstText(basket.zone_id))
            .filter((zoneId): zoneId is string => Boolean(zoneId)),
        ),
      ).sort(),
    [basketRows],
  );
  const zonesQuery = useResourceRowsByIds<Record<string, unknown>>('zones', basketZoneIds, {
    enabled: basketZoneIds.length > 0,
  });
  const transitionsQuery = useResourceListsByFilters<Record<string, unknown>>(
    'basket_transitions',
    basketIds.map((basketId) => ({ basket_id: basketId })),
    { sort: { key: 'changed_at', dir: 'desc' }, page_size: 500 },
    { enabled: basketIds.length > 0 },
  );

  if (
    itemsQuery.isLoading ||
    (basketIds.length > 0 && basketsQuery.isLoading) ||
    (basketZoneIds.length > 0 && zonesQuery.isLoading) ||
    (basketIds.length > 0 && transitionsQuery.isLoading)
  ) {
    return <StateView kind="loading" />;
  }

  const error = itemsQuery.error ?? basketsQuery.error ?? zonesQuery.error ?? transitionsQuery.error;
  if (error) {
    if (isPermissionDeniedError(error)) {
      return (
        <StateView
          kind="denied"
          title="Basket assignments unavailable"
          hint="Basket relationship reads require basket and zone access permission."
        />
      );
    }
    return <StateView kind="error" title="Basket assignments unavailable" hint={(error as Error).message} />;
  }

  if (!items.length) {
    return <div className="state__hint">No basket assignment recorded for this shipment.</div>;
  }

  const basketById = new Map(basketRows.map((basket) => [String(basket.id), basket]));
  const zoneById = new Map((zonesQuery.data?.rows ?? []).map((zone) => [String(zone.id), zone]));
  const rows: Array<Record<string, unknown>> = items.map((item) => {
    const basket = basketById.get(String(item.basket_id ?? ''));
    const zoneLabel = basketZoneLabel(basket, zoneById);
    return {
      ...item,
      basket_label: basketRelationLabel(basket, zoneLabel),
      basket_type: basket?.basket_type,
      state: basket?.state,
      zone_label: zoneLabel ?? 'Zone not linked',
      current_count: basket?.current_count,
      capacity_count: basket?.capacity_count,
      expires_at: basket?.expires_at,
    };
  });
  const activeBasketId = selectedBasketId && basketIds.includes(selectedBasketId)
    ? selectedBasketId
    : String(rows[0]?.basket_id ?? '');
  const selectedRow = rows.find((row) => String(row.basket_id ?? '') === activeBasketId) ?? rows[0];
  const selectedBasket = basketById.get(String(selectedRow?.basket_id ?? ''));
  const relationshipRows: KvRow[] = selectedRow
    ? [
        { key: 'basket_label', label: 'Basket', value: selectedRow.basket_label },
        { key: 'basket_type', label: 'Type', value: selectedRow.basket_type, lookup: 'basket_type' },
        { key: 'state', label: 'State', value: selectedRow.state, lookup: 'basket_state' },
        { key: 'zone_label', label: 'Zone', value: selectedRow.zone_label },
        {
          key: 'capacity',
          label: 'Capacity',
          value: `${selectedRow.current_count ?? 0}/${selectedRow.capacity_count ?? 'not set'}`,
          mono: true,
        },
        {
          key: 'relationship_status',
          label: 'Relationship',
          value: selectedRow.removed_at ? 'Removed from basket' : 'Active assignment',
        },
        { key: 'added_at', label: 'Added', value: fmtDateTime(String(selectedRow.added_at ?? '')) },
        { key: 'removed_at', label: 'Removed', value: selectedRow.removed_at ? fmtDateTime(String(selectedRow.removed_at)) : 'Active' },
        {
          key: 'expires_at',
          label: 'Expires',
          value: selectedBasket?.expires_at ? fmtDateTime(String(selectedBasket.expires_at)) : 'No expiry recorded',
        },
      ]
    : [];
  const transitions: Array<Record<string, unknown>> = (transitionsQuery.data?.rows ?? [])
    .filter((transition) => !activeBasketId || String(transition.basket_id ?? '') === activeBasketId)
    .map((transition): Record<string, unknown> => ({
      ...transition,
      basket_label: (() => {
        const basket = basketById.get(String(transition.basket_id ?? ''));
        return basketRelationLabel(basket, basketZoneLabel(basket, zoneById));
      })(),
      actor_label: operatorActorLabel(transition.changed_by),
    }))
    .sort((a, b) => String(b['changed_at'] ?? '').localeCompare(String(a['changed_at'] ?? '')));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <DataTable
        columns={[
          { key: 'basket_label', label: 'Basket', sortable: true, filterable: true },
          { key: 'basket_type', label: 'Type', lookup: 'basket_type', sortable: true, filterable: true },
          { key: 'state', label: 'State', lookup: 'basket_state', sortable: true, filterable: true },
          { key: 'zone_label', label: 'Zone', sortable: true, filterable: true },
          { key: 'current_count', label: 'Count', type: 'number', align: 'right' },
          { key: 'capacity_count', label: 'Capacity', type: 'number', align: 'right' },
          { key: 'added_at', label: 'Added', format: 'datetime', sortable: true },
          { key: 'removed_at', label: 'Removed', format: 'datetime', sortable: true },
          { key: 'expires_at', label: 'Expires', format: 'datetime', sortable: true },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText="No basket assignment recorded for this shipment."
        onRowClick={(row) => {
          const basketId = String(row.basket_id ?? '');
          if (basketId) setSelectedBasketId(basketId);
        }}
        getRowClass={(row) => (String(row.basket_id ?? '') === activeBasketId ? 'is-active' : undefined)}
        rowActions={[
          {
            label: 'Inspect basket relationship',
            icon: 'layers',
            onClick: (row) => {
              const basketId = String(row.basket_id ?? '');
              if (basketId) setSelectedBasketId(basketId);
            },
          },
        ]}
      />
      {relationshipRows.length ? (
        <div className="insight-card">
          <div className="insight-card__title">Basket relationship detail</div>
          <KvGrid rows={relationshipRows} />
        </div>
      ) : null}
      <div className="insight-card">
        <div className="insight-card__title">Basket activity for this shipment</div>
        {transitions.length ? (
          <DataTable
            columns={[
              { key: 'basket_label', label: 'Basket' },
              { key: 'previous_state', label: 'From', lookup: 'basket_state' },
              { key: 'new_state', label: 'To', lookup: 'basket_state' },
              { key: 'changed_at', label: 'Changed', format: 'datetime' },
              { key: 'actor_label', label: 'Changed by' },
              { key: 'notes', label: 'Notes' },
            ]}
            rows={transitions}
            allowSelection={false}
            emptyText="No basket state transitions recorded."
          />
        ) : (
          <div className="state__hint">No basket state transitions recorded.</div>
        )}
      </div>
    </div>
  );
}

function RecipientTab({ shipment }: { shipment: Shipment }) {
  const recipientId = (shipment as { recipient_id?: string }).recipient_id;
  // Keep recipient edits inside the shipment drawer for operator flow, but write
  // to the customer SSOT through recipient_update_v1. Shipment modify only owns
  // shipment fields; recipient profile fields live on public.recipients.
  // W56-B-2 closure (F6) — recipient lookup migrated from `api.seed.recipients()`
  // to an id-scoped canonical registry read so the shipment drawer does not
  // load the global recipient table just to render one shipment.
  const updateRecipient = useRecipientUpdate();
  const canWrite = useCapability(CAP.RECIPIENTS_WRITE);
  const recipientsQuery = useResourceRowsByIds<Record<string, unknown>>(
    'recipients',
    recipientId ? [recipientId] : [],
    { enabled: Boolean(recipientId) },
  );
  const recipient = useMemo<Record<string, unknown> | null | undefined>(() => {
    if (!recipientId) return null;
    if (recipientsQuery.isLoading) return undefined;
    const rows = recipientsQuery.data?.rows ?? [];
    return rows.find((r) => r.id === recipientId) ?? null;
  }, [recipientsQuery.isLoading, recipientsQuery.data, recipientId]);
  if (recipientsQuery.isError) {
    return (
      <StateView
        kind="error"
        title="Recipient unavailable"
        hint={(recipientsQuery.error as Error).message}
      />
    );
  }
  if (recipient === undefined) return <StateView kind="loading" />;
  if (!recipient) return <div className="state__hint">No recipient on this shipment.</div>;
  const rows: KvRow[] = [
    { key: 'name', label: 'Name', value: recipient.name, editable: true },
    { key: 'phone_number', label: 'Phone', value: recipient.phone_number, mono: true, editable: true },
    { key: 'email', label: 'Email', value: recipient.email, mono: true, editable: true },
    { key: 'external_id', label: 'External ID', value: recipient.external_id, mono: true, editable: true },
    { key: 'preferred_language', label: 'Language', value: recipient.preferred_language, editable: true },
    { key: 'preferred_comm_channel', label: 'Channel', value: recipient.preferred_comm_channel, editable: true },
    { key: 'quiet_hours_start', label: 'Quiet from', value: recipient.quiet_hours_start, mono: true, editable: true },
    { key: 'quiet_hours_end', label: 'Quiet to', value: recipient.quiet_hours_end, mono: true, editable: true },
  ];
  return (
    <KvGrid
      rows={rows}
      onEdit={
        canWrite
          ? async (key, value) => {
              try {
                await updateRecipient.mutateAsync({
                  recipient_id: recipientId as string,
                  [key]: value === '—' ? null : value,
                  communication_preferences: {
                    source: 'console_v2.shipments_drawer.recipient_tab',
                    shipment_id: shipment.id,
                  },
                });
                pushToast(`Recipient ${key} updated`, 'good');
              } catch {
                pushToast('Recipient details could not be updated. Try again.', 'danger');
              }
            }
          : undefined
      }
    />
  );
}

function CodTab({ shipment }: { shipment: Shipment }) {
  const { fmtCurrency } = useI18n();
  // W13-5 — closes OPERATIONS D3 §3 (CodTab.onEdit orphan-toast). Wires COD
  // amount/currency edits through `shipment_amend_cancel_v1(op='modify')`.
  // `cod_method` and `expected_at_stop` are display-only (synthetic column,
  // not on `public.shipments` — gated read-only until canonical projection
  // lands).
  const amend = useShipmentAmendCancel();
  const canWrite = useCapability(CAP.SHIPMENTS_WRITE);
  const actionsQuery = useResourceList<ShipmentActionPaymentRow>('shipment_actions', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
    page_size: 25,
  });
  const latestPayment = useMemo(
    () => latestCodPaymentProjection(actionsQuery.data?.rows),
    [actionsQuery.data?.rows],
  );
  if (!shipment.cod_amount) return <div className="state__hint">No COD on this shipment.</div>;
  const paymentMethod = lookupDisplayValue(
    'payment_collection_method',
    latestPayment?.method ?? shipment.payment_collection_method ?? shipment.cod_method,
    'Pending collection proof',
  );
  const collectionStatus = lookupDisplayValue(
    'payment_collection_outcome',
    latestPayment?.outcome ?? shipment.payment_collection_outcome ?? shipment.payment_collection_status,
    'Pending stop closeout',
  );
  const paymentCurrency = latestPayment?.currency ?? shipment.cod_currency;
  const collectedValue = latestPayment?.collectedAmount == null
    ? 'Pending closeout'
    : fmtCurrency(latestPayment.collectedAmount, paymentCurrency);
  const varianceValue = latestPayment?.varianceAmount == null
    ? 'Pending cashier count'
    : fmtCurrency(latestPayment.varianceAmount, paymentCurrency);
  const closeoutTime = latestPayment?.occurredAt
    ?? shipment.payment_collection_expected_at
    ?? 'Resolved when the delivery stop is closed';
  const rows: KvRow[] = [
    { key: 'cod_amount', label: 'Amount', value: fmtCurrency(shipment.cod_amount, shipment.cod_currency), mono: true, editable: true },
    { key: 'cod_currency', label: 'Currency', value: shipment.cod_currency, lookup: 'currency', editable: false },
    { key: 'cod_method', label: 'Collection method', value: paymentMethod, editable: false },
    { key: 'payment_collection_status', label: 'Collection status', value: collectionStatus, editable: false },
    { key: 'payment_collected_amount', label: 'Collected', value: collectedValue, mono: latestPayment?.collectedAmount != null, editable: false },
    { key: 'payment_variance_amount', label: 'Variance', value: varianceValue, mono: latestPayment?.varianceAmount != null, editable: false },
    { key: 'payment_closeout_at', label: 'Closeout event', value: closeoutTime, editable: false },
  ];
  return (
    <KvGrid
      rows={rows}
      onEdit={
        canWrite
          ? async (key, value) => {
              try {
                if (key !== 'cod_amount') {
                  throw new Error(`COD ${key} is read-only until an update workflow is available`);
                }
                await amend.mutateAsync({
                  shipmentId: shipment.id,
                  op: 'modify',
                  payload: {
                    changes: { [key]: value },
                    source: 'console.shipments_drawer.cod_tab',
                  },
                });
                pushToast(`COD ${key} updated`, 'good');
              } catch {
                pushToast('COD details could not be updated. Try again.', 'danger');
              }
            }
          : undefined
      }
    />
  );
}

function RouteTab({ shipment }: { shipment: Shipment }) {
  const go = useConsoleNavigator();
  // W13-5 — closes OPERATIONS D3 §4 (RouteTab.onEdit orphan-toast). Per the
  // deferred decision doc (`__audit__/DECISIONS/SHIPMENTS-DRAWER-CELL-EDITS.md`
  // §4), per-cell route edits are flipped to read-only here because the
  // canonical contract is the orchestrated DnD picker
  // (`ui_execute_route_stop_reassign_v1` / `ui_execute_route_run_assign_v1`),
  // which enforces conflict checks (`route_stop_reassign_events` audit,
  // `route_run_assignment_responses` ledger, `cod.float.max_per_driver`
  // policy). Wiring KvGrid.onEdit to a partial payload would skip these
  // gates, so the row-level affordance is removed and operators are forced
  // through the orchestrated picker on the dispatch surface.
  const stops = useResourceList<Record<string, unknown>>('route_stops', {
    filter: { shipment_id: shipment.id },
    page_size: 25,
  });
  const routeStopRows = stops.data?.rows ?? [];
  const shipmentStops = useMemo(
    () =>
      routeStopRows.filter((stop) => String(stop.shipment_id ?? '') === shipment.id),
    [routeStopRows, shipment.id],
  );
  const routeRunIds = useMemo(
    () =>
      Array.from(
        new Set(
          shipmentStops
            .map((stop) => (typeof stop.route_run_id === 'string' ? stop.route_run_id : ''))
            .filter(Boolean),
        ),
      ).sort(),
    [shipmentStops],
  );
  const runs = useResourceRowsByIds<Record<string, unknown>>('route_runs', routeRunIds, {
    enabled: routeRunIds.length > 0,
  });
  if (stops.isLoading || runs.isLoading) return <StateView kind="loading" />;
  if (stops.isError) {
    return (
      <StateView
        kind="error"
        title="Route stops unavailable"
        hint={(stops.error as Error).message}
      />
    );
  }
  if (runs.isError) {
    return (
      <StateView
        kind="error"
        title="Route run unavailable"
        hint={(runs.error as Error).message}
      />
    );
  }
  if (routeStopRows.length > 0 && shipmentStops.length !== routeStopRows.length) {
    return (
      <StateView
        kind="error"
        title="Route stop scope mismatch"
        hint="Route stop details could not be matched to this shipment. Refresh and try again."
      />
    );
  }
  const stop = shipmentStops[0];
  if (!stop) return <div className="state__hint">Not yet on a route.</div>;
  const routeRunId = typeof stop.route_run_id === 'string' ? stop.route_run_id : '';
  const run = (runs.data?.rows ?? []).find((rr) => rr.id === routeRunId);
  const rows: KvRow[] = [
    { key: 'run_id', label: 'Run', value: run?.run_id ?? '—', mono: true, editable: false },
    { key: 'driver', label: 'Driver', value: run?.driver ?? '—', editable: false },
    { key: 'vehicle', label: 'Vehicle', value: run?.vehicle ?? '—', mono: true, editable: false },
    { key: 'sequence_order', label: 'Stop #', value: String(stop.sequence_order ?? ''), mono: true, editable: false },
    { key: 'window', label: 'Window', value: `${stop.window_start ?? ''}–${stop.window_end ?? ''}`, mono: true, editable: false },
    { key: 'sla_tone', label: 'SLA', value: stop.sla_tone, editable: false },
    { key: 'status', label: 'Status', value: stop.status, editable: false },
  ];
  return (
    <div>
      <div className="state__hint" style={{ padding: '6px 14px' }}>
        Route assignments are read-only here. Use Dispatch to reassign the
        driver or route so conflict checks, audit ledgers, and COD float policy
        are enforced.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 14px 10px' }}>
        <Button
          label="Open dispatch"
          iconName="truck"
          kind="ghost"
          capability={CAP.ROUTES_READ}
          onClick={() => go(`/operate/dispatch?route_stop=${encodeURIComponent(String(stop.id))}`)}
        />
      </div>
      <KvGrid rows={rows} />
    </div>
  );
}

function TasksTab({ shipment }: { shipment: Shipment }) {
  const go = useConsoleNavigator();
  // W16-1 — closes OPERATIONS D3 §5/§6 (TasksTab cell-edit canonical wiring).
  // Aligns to the canonical `public.tasks` projection (`sla_due_at`, `id`,
  // `task_type_id` per migration 202601212300_tasks_ssot_core.sql:362-390).
  // The cell-edit handler now:
  //   1. Routes the only editable column (`status`) through the canonical
  //      `transition_task_v1(next_status)` seam.
  //   2. Reports failures via toast + returns `{ ok: false }` so the
  //      DataTable rolls back the optimistic edit instead of silently
  //      swallowing a rejection.
  //   3. Refuses unknown keys (defensive — non-status columns are
  //      `editable: false` so this branch should never fire today, but the
  //      guard keeps the seam fail-closed if a future column flips to
  //      editable without a paired RPC).
  // The `task_id` column key is the canonical seed projection alias for
  // `tasks.id` (see `__audit__/SCHEMA-DRIFT/OPERATIONS.md` §4); the seed
  // retains it for back-compat until G1 paired projection update lands.
  const tasks = useResourceList<Record<string, unknown>>('tasks', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'sla_due_at', dir: 'asc' },
    page_size: 100,
  });
  const transition = useTransitionTask();
  const canWriteTasks = useCapability(CAP.TASKS_WRITE);
  const canCompleteTasks = useCapability(CAP.TASKS_COMPLETE);
  const canTransitionTask = canEditShipmentTaskStatus(canWriteTasks, canCompleteTasks);
  if (tasks.isLoading) return <StateView kind="loading" />;
  if (tasks.isError) {
    return (
      <StateView
        kind="error"
        title="Tasks unavailable"
        hint={(tasks.error as Error).message}
      />
    );
  }
  const rows = tasks.data?.rows ?? [];
  if (!rows.length) return <div className="state__hint">No related tasks.</div>;
  return (
    <DataTable
      columns={[
        { key: 'task_id', label: 'Task', sortable: true, render: (raw) => compactReference(raw, 'Task') },
        { key: 'task_type', label: 'Type', lookup: 'task_type' },
        { key: 'status', label: 'Status', lookup: 'task_status', editable: canTransitionTask },
        { key: 'sla_due_at', label: 'SLA due', format: 'datetime' },
      ]}
      rows={rows as Array<Record<string, unknown>>}
      allowSelection={false}
      onCellEdit={
        canTransitionTask
          ? async (row, key, value) => {
              if (key !== 'status') {
                return { ok: false, error: `Field ${key} is read-only` };
              }
              const taskId = (row as { id?: string }).id;
              if (!taskId) {
                return { ok: false, error: 'Task id missing' };
              }
              try {
                await transition.mutateAsync({
                  taskId,
                  transition: { next_status: String(value) },
                });
                pushToast(`Task status updated to ${value}`, 'good');
                return { ok: true };
              } catch {
                pushToast('Task status could not be updated. Try again.', 'danger');
                return { ok: false, error: 'Task status could not be updated. Try again.' };
              }
            }
          : undefined
      }
      rowActions={[
        {
          label: 'Open task',
          icon: 'eye',
          onClick: (row) => {
            go(resolveShipmentTaskTarget(row as Record<string, unknown>));
          },
        },
      ]}
    />
  );
}

function CommsTab({ shipment }: { shipment: Shipment }) {
  // CLAIM-OPERATIONS-WIRING (Phase C1) — replaces the 2-row inline literal
  // ('c1' / 'c2') with the canonical comms_attempts read seam. Production
  // swap: `ui_list_resource_v1('comms_attempts', { filter: { shipment_id }})`
  // against public.comms_attempts (Phase G migration).
  //
  // W13-5 — closes OPERATIONS D3 §3 (CommsTab "Send now" orphan-toast).
  // Wires the button through the canonical
  // `enqueue_comms_attempt_v1(shipment_id, channel)` seam (migration
  // 202604301600).
  //
  // W54-C closure — `channel` resolved strictly from canonical
  // `communication_policy.allowed_channels[0]` (NO inline `'sms'`
  // literal). Until a shipment-scoped recipient preference projection lands,
  // we use the first allowed channel from policy as the FE default.
  const { data, isLoading } = useResourceList<Record<string, unknown>>('comms_attempts', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'occurred_at', dir: 'asc' },
  });
  const enqueue = useEnqueueCommsAttempt();
  const commsPolicy = useResolveSettings('communication_policy', undefined);
  const allowedChannels = (commsPolicy.data?.value as { allowed_channels?: string[] } | undefined)?.allowed_channels;
  const defaultChannel = allowedChannels?.[0] ?? null;
  if (isLoading) return <StateView kind="loading" />;
  const rows = data?.rows ?? [];
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
        <Button
          label="Send now"
          iconName="bell"
          kind="primary"
          capability={CAP.COMMS_WRITE}
          onClick={async () => {
            // W54-C — channel resolved from canonical
            // `communication_policy.allowed_channels[0]`. Missing canonical
            // row → loud error toast (NO silent fallback to inline 'sms').
            if (!defaultChannel) {
              pushToast('No approved communication channel is configured.', 'danger');
              return;
            }
            try {
              await enqueue.mutateAsync({
                shipment_id: shipment.id,
                channel: defaultChannel,
              });
              pushToast('Message queued for delivery.', 'good');
            } catch {
              pushToast('Message could not be queued. Try again.', 'danger');
            }
          }}
        />
      </div>
      <DataTable
        columns={[
          { key: 'occurred_at', label: 'When', format: 'datetime' },
          { key: 'channel', label: 'Channel' },
          { key: 'template', label: 'Template', mono: true },
          { key: 'status', label: 'Status' },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText="No comms attempts recorded."
      />
    </div>
  );
}

function LabelsTab({ shipment }: { shipment: Shipment }) {
  const reprint = useReprintLabel();
  const queryClient = useQueryClient();
  const { fmtDateTime } = useI18n();
  const [isPrinting, setIsPrinting] = useState(false);
  const [isReprinting, setIsReprinting] = useState(false);
  const reprintInFlightRef = useRef(false);
  const [downloadingLabelKey, setDownloadingLabelKey] = useState<string | null>(null);
  const [labelDownloadStatus, setLabelDownloadStatus] = useState<{
    tone: 'info' | 'good' | 'warn' | 'danger';
    message: string;
  } | null>(null);
  // CLAIM-OPERATIONS-WIRING (Phase C1) — read seam moved from `api.seed.*` to
  // canonical resource registry (`ui_list_resource_v1('labels')`). Backed by
  // public.labels (HASH partitioned;
  // supabase/migrations/202510110006_domain_tables_partitioned.sql:185).
  const labelListOpts = useMemo<api.ListOpts>(() => ({
    filter: { shipment_id: shipment.id },
  }), [shipment.id]);
  const labelJobListOpts = useMemo<api.ListOpts>(() => ({
    filter: { shipment_id: shipment.id },
    sort: { key: 'queued_at', dir: 'desc' },
  }), [shipment.id]);
  const labelVersionListOpts = useMemo<api.ListOpts>(() => ({
    filter: { shipment_id: shipment.id },
    sort: { key: 'version_number', dir: 'desc' },
  }), [shipment.id]);
  const labelsQuery = useResourceList<ShipmentLabelRow>('labels', labelListOpts);
  const labelJobsQuery = useResourceList<ShipmentLabelJobRow>('label_jobs', labelJobListOpts);
  const labelVersionsQuery = useResourceList<ShipmentLabelVersionRow>('label_versions', labelVersionListOpts);
  const refreshShipmentLabels = useCallback(async () => {
    await Promise.all(
      ['labels', 'label_jobs', 'label_versions', 'shipment_directory'].map((resource) =>
        queryClient.invalidateQueries({ queryKey: ['list', resource] }),
      ),
    );
  }, [queryClient]);
  const readShipmentLabelProjection = useCallback(async () => {
    const [nextLabels, nextJobs, nextVersions] = await Promise.all([
      api.ui_list_resource_v1<ShipmentLabelRow>('labels', labelListOpts),
      api.ui_list_resource_v1<ShipmentLabelJobRow>('label_jobs', labelJobListOpts),
      api.ui_list_resource_v1<ShipmentLabelVersionRow>('label_versions', labelVersionListOpts),
    ]);
    queryClient.setQueryData(qk.list('labels', labelListOpts), nextLabels);
    queryClient.setQueryData(qk.list('label_jobs', labelJobListOpts), nextJobs);
    queryClient.setQueryData(qk.list('label_versions', labelVersionListOpts), nextVersions);
    return {
      labels: nextLabels.rows ?? [],
      jobs: nextJobs.rows ?? [],
      versions: nextVersions.rows ?? [],
    };
  }, [labelJobListOpts, labelListOpts, labelVersionListOpts, queryClient]);
  const waitForShipmentLabelProjection = useCallback(async (
    previousFingerprint: string,
    workflowRunId?: string | null,
  ) => {
    await refreshShipmentLabels();
    let latestFingerprint = previousFingerprint;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await waitForLabelProjection(attempt === 1 ? 1000 : 1500);
      const nextProjection = await readShipmentLabelProjection();
      latestFingerprint = shipmentLabelProjectionFingerprint(
        nextProjection.labels,
        nextProjection.jobs,
        nextProjection.versions,
      );
      if (latestFingerprint !== previousFingerprint) {
        await refreshShipmentLabels();
        return;
      }
      const workflowFailure = await readLabelPrintWorkflowFailure(workflowRunId);
      if (workflowFailure) throw workflowFailure;
    }
    throw new Error('Print queued, but label status did not refresh yet.');
  }, [readShipmentLabelProjection, refreshShipmentLabels]);
  const labels = labelsQuery.data?.rows ?? [];
  const labelJobs = labelJobsQuery.data?.rows ?? [];
  const labelVersions = labelVersionsQuery.data?.rows ?? [];
  const hasActiveLabelJobWork = labelJobs.some((job) => shipmentLabelJobNeedsLiveRefresh(job));
  useEffect(() => {
    if (!hasActiveLabelJobWork) return undefined;
    let disposed = false;
    const reconcile = async () => {
      try {
        const nextProjection = await readShipmentLabelProjection();
        if (!disposed && !nextProjection.jobs.some((job) => shipmentLabelJobNeedsLiveRefresh(job))) {
          setLabelDownloadStatus({ tone: 'good', message: 'Label status refreshed' });
        }
      } catch (err) {
        if (!disposed) {
          setLabelDownloadStatus({
            tone: 'warn',
            message: (err as Error).message || 'Label refresh is still pending',
          });
        }
      }
    };
    const intervalId = window.setInterval(() => {
      void reconcile();
    }, LABEL_JOB_LIVE_REFRESH_MS);
    void reconcile();
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [hasActiveLabelJobWork, readShipmentLabelProjection]);
  if (labelsQuery.isLoading || labelJobsQuery.isLoading || labelVersionsQuery.isLoading) {
    return <StateView kind="loading" />;
  }
  const labelError = labelsQuery.error ?? labelJobsQuery.error ?? labelVersionsQuery.error;
  if (labelError) {
    return (
      <StateView
        kind={isPermissionDeniedError(labelError) ? 'denied' : 'error'}
        title="Labels unavailable"
        capability={isPermissionDeniedError(labelError) ? CAP.LABELS_DOWNLOAD : undefined}
        hint={(labelError as Error).message}
      />
    );
  }
  // CYCLE-E2 STRICT-ISOLATION (P1 #3) — drop the synthesis fallback that
  // minted a label id from the shipment id. The Reprint button is gated on a
  // canonical label row existing for this shipment, with a fail-loud message
  // when none is found.
  const activeLabel = selectActiveShipmentLabel(labels);
  const activeLabelId = activeLabel?.id ?? undefined;
  const activeLabelUrl = shipmentLabelArtifactUrl(activeLabel);
  const latestLabelJob = selectLatestShipmentLabelJob(labelJobs);
  const activeLabelChip = activeLabel
    ? activeLabel.active_version_number
      ? `Active label v${activeLabel.active_version_number}`
      : 'Active label ready'
    : 'No active label';
  const latestJobChip = latestLabelJob
    ? `Latest job: ${humanizeToken(shipmentLabelJobStatus(latestLabelJob))}`
    : 'No label job';

  const openLabelArtifact = async (
    resource: 'labels' | 'label_jobs' | 'label_versions',
    id: string | null | undefined,
  ) => {
    const resourceId = typeof id === 'string' && id.trim() ? id.trim() : null;
    if (!resourceId) {
      pushToast('No label artifact available for download', 'warn');
      return;
    }
    const downloadKey = `${resource}:${resourceId}`;
    setDownloadingLabelKey(downloadKey);
    setLabelDownloadStatus({ tone: 'info', message: 'Preparing label artifact download' });
    pushToast('Preparing label artifact download', 'info', { durationMs: 8000 });
    try {
      const result = await withLabelDownloadTimeout(
        api.resolve_resource_download_url_v1({
          resource,
          id: resourceId,
          expires_seconds: 900,
        }),
      );
      const opened = window.open(result.url, '_blank', 'noopener,noreferrer');
      if (opened) {
        setDownloadingLabelKey(null);
        setLabelDownloadStatus({ tone: 'good', message: 'Opening signed label artifact' });
        pushToast('Opening label artifact', 'good', { durationMs: 15000 });
      } else {
        let copied = false;
        try {
          await withLabelDownloadTimeout(
            navigator.clipboard?.writeText
              ? navigator.clipboard.writeText(result.url)
              : Promise.resolve(),
            3000,
          );
          copied = true;
        } catch {
          // Clipboard can be blocked by browser policy; the signed URL still came from the backend.
        }
        setDownloadingLabelKey(null);
        setLabelDownloadStatus({
          tone: 'warn',
          message: copied
            ? 'Signed label download URL copied; browser blocked the new tab'
            : 'Signed label download URL ready; browser blocked the new tab',
        });
        pushToast(
          copied ? 'Download URL copied; browser blocked the new tab' : 'Download URL ready; browser blocked the new tab',
          'warn',
          { durationMs: 15000 },
        );
      }
    } catch (err) {
      const message = (err as Error).message || 'Label artifact download failed';
      setDownloadingLabelKey(null);
      setLabelDownloadStatus({ tone: 'danger', message });
      pushToast(message, 'danger', { durationMs: 15000 });
    } finally {
      setDownloadingLabelKey(null);
    }
  };

  const printShipmentLabel = async () => {
    setIsPrinting(true);
    const previousProjection = shipmentLabelProjectionFingerprint(labels, labelJobs, labelVersions);
    try {
      const result = await api.runCommand(
        'shipments.print_labels',
        {
          resource_key: 'shipments',
          selected_ids: [shipment.id],
          selected_id: shipment.id,
          selection_count: 1,
          shipment_id: shipment.id,
          job_purpose: 'primary',
          ...(typeof shipment.organization_id === 'string' && shipment.organization_id
            ? { organization_id: shipment.organization_id }
            : {}),
          source: 'console_v2.shipment_drawer.labels_tab',
        },
        { dryRun: false },
      );
      const workflowRunId = typeof (result as Record<string, unknown>).workflow_run_id === 'string'
        ? String((result as Record<string, unknown>).workflow_run_id)
        : null;
      setLabelDownloadStatus({ tone: 'info', message: 'Print queued; waiting for label status' });
      pushToast('Print queued', 'good');
      try {
        await waitForShipmentLabelProjection(previousProjection, workflowRunId);
        setLabelDownloadStatus({ tone: 'good', message: 'Label status refreshed' });
      } catch (err) {
        const message = (err as Error).message || 'Print queued, but label refresh failed';
        const lowerMessage = message.toLowerCase();
        const tone = lowerMessage.includes('failed') || lowerMessage.includes('could not')
          ? 'danger'
          : 'warn';
        setLabelDownloadStatus({ tone, message });
        pushToast(message, tone);
      }
    } catch (err) {
      const message = (err as Error).message || 'Print request failed';
      setLabelDownloadStatus({ tone: 'danger', message });
      pushToast(message, 'danger');
    } finally {
      setIsPrinting(false);
    }
  };
  const submitLabelReprint = async (labelId: string | null | undefined) => {
    if (reprintInFlightRef.current) {
      pushToast('Reprint is already syncing', 'warn');
      return;
    }
    const resolvedLabelId = typeof labelId === 'string' && labelId.trim() ? labelId.trim() : null;
    if (!resolvedLabelId) {
      pushToast('No active label - cannot reprint', 'danger');
      return;
    }
    const reason = defaultLabelReprintReason();
    if (!reason) {
      pushToast('No label reprint reason is configured.', 'danger');
      return;
    }
    const previousProjection = shipmentLabelProjectionFingerprint(labels, labelJobs, labelVersions);
    setLabelDownloadStatus({ tone: 'info', message: 'Reprint queued; waiting for label status' });
    reprintInFlightRef.current = true;
    setIsReprinting(true);
    try {
      await reprint.mutateAsync({ labelId: resolvedLabelId, reason, shipmentId: shipment.id });
      pushToast('Reprint queued', 'good');
      try {
        await waitForShipmentLabelProjection(previousProjection, null);
        setLabelDownloadStatus({ tone: 'good', message: 'Reprint queued; label status refreshed' });
      } catch (err) {
        const message = (err as Error).message || 'Reprint queued, but label refresh failed';
        setLabelDownloadStatus({ tone: 'warn', message });
        pushToast(message, 'warn');
      }
    } catch (err) {
      const message = (err as Error).message || 'Reprint request failed';
      setLabelDownloadStatus({ tone: 'danger', message });
      pushToast(message, 'danger');
    } finally {
      reprintInFlightRef.current = false;
      setIsReprinting(false);
    }
  };
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginBottom: '6px' }}>
        <Button
          label="Print label"
          iconName="file"
          kind="primary"
          capability={CAP.LABELS_DOWNLOAD}
          disabled={isPrinting}
          onClick={printShipmentLabel}
        />
        <Button
          label={downloadingLabelKey === `labels:${activeLabelId}` ? 'Preparing download' : 'Download'}
          iconName="download"
          kind="ghost"
          capability={CAP.LABELS_DOWNLOAD}
          disabled={!activeLabelUrl || downloadingLabelKey === `labels:${activeLabelId}`}
          onClick={() => { void openLabelArtifact('labels', activeLabelId); }}
        />
        <Button
          label="Reprint"
          iconName="refresh"
          kind="primary"
          capability={CAP.LABELS_REPRINT}
          disabled={!activeLabelId || isReprinting}
          onClick={async () => {
            await submitLabelReprint(activeLabelId);
          }}
        />
      </div>
      {!activeLabelId && labels.length === 0 ? (
        <div style={{ marginBottom: '6px', color: 'var(--ink-faint)', fontSize: '11px' }}>
          No active label on this shipment · reprint disabled.
        </div>
      ) : null}
      {labelDownloadStatus ? (
        <div
          role="status"
          style={{
            marginBottom: '6px',
            color: labelDownloadStatus.tone === 'danger'
              ? 'var(--danger)'
              : labelDownloadStatus.tone === 'warn'
                ? 'var(--warn-ink)'
                : labelDownloadStatus.tone === 'good'
                  ? 'var(--good-ink)'
                  : 'var(--ink-faint)',
            fontSize: '11px',
          }}
        >
          {labelDownloadStatus.message}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
        <Chip size="xs" kind={activeLabel ? 'good' : 'neutral'} label={activeLabelChip} />
        <Chip size="xs" kind={latestLabelJob ? 'info' : 'neutral'} label={latestJobChip} />
        {activeLabelUrl ? <Chip size="xs" kind="good" label="Artifact ready" /> : null}
      </div>
      <DataTable
        columns={[
          { key: 'barcode', label: 'Barcode', mono: true },
          { key: 'active_version_id', label: 'Active version', render: (raw) => compactReference(raw, 'Version') },
          { key: 'print_count', label: 'Prints', align: 'right' },
          { key: 'last_printed_at', label: 'Last printed', format: 'datetime' },
          { key: 'reprint_reason', label: 'Reprint reason' },
        ]}
        rows={labels}
        allowSelection={false}
        rowActions={[
          {
            label: 'Download label',
            icon: 'download',
            kind: 'ghost',
            capability: CAP.LABELS_DOWNLOAD,
            disabled: (row) => !row.active_version_id,
            disabledReason: () => 'Active label version required',
            onClick: (row) => { void openLabelArtifact('labels', row.id); },
          },
          {
            label: 'Reprint label',
            icon: 'refresh',
            kind: 'primary',
            capability: CAP.LABELS_REPRINT,
            disabled: (row) => !row.active_version_id || isReprinting,
            disabledReason: (row) => (!row.active_version_id ? 'Active label version required' : 'Reprint is already syncing'),
            onClick: (row) => {
              void submitLabelReprint(row.id)
                .then(() => undefined)
                .catch(() => {
                  pushToast('Reprint request could not be started. Try again.', 'danger');
                });
            },
          },
        ]}
        emptyText="No labels on this shipment."
      />
      <div style={{ marginTop: '14px' }}>
        <div className="state__hint" style={{ marginBottom: '6px' }}>
          Generation and print queue
        </div>
        {!activeLabelId && labelJobs.length > 0 ? (
          <div style={{ marginBottom: '6px', color: 'var(--ink-faint)', fontSize: '11px' }}>
            Label generation or print work exists. Download and reprint unlock after an active label artifact is available.
          </div>
        ) : null}
        <DataTable
          columns={[
            { key: 'id', label: 'Job', render: () => 'Label job' },
            { key: 'status', label: 'Status', render: (_raw, row) => humanizeToken(shipmentLabelJobStatus(row)) },
            { key: 'purpose', label: 'Purpose', render: (_raw, row) => humanizeToken(shipmentLabelJobPurpose(row)) },
            { key: 'target_type', label: 'Target', render: (raw) => humanizeToken(raw) },
            { key: 'queued_at', label: 'Queued', render: (_raw, row) => {
              const value = shipmentLabelJobQueuedAt(row);
              return value ? fmtDateTime(value) : 'Not set';
            } },
            { key: 'completed_at', label: 'Completed', format: 'datetime' },
            { key: 'workflow_run_id', label: 'Workflow', render: (_raw, row) => shipmentLabelJobWorkflowRef(row) ? 'Linked' : '-' },
          ]}
          rows={labelJobs}
          allowSelection={false}
          rowActions={[
            {
              label: 'Open print artifact',
              icon: 'download',
              kind: 'ghost',
              capability: CAP.LABELS_DOWNLOAD,
              disabled: (row) => !shipmentLabelJobHasOpenableArtifact(row),
              disabledReason: () => 'Completed label artifact required',
              onClick: (row) => { void openLabelArtifact('label_jobs', row.id); },
            },
          ]}
          emptyText="No label generation or print jobs queued."
        />
      </div>
      <div style={{ marginTop: '14px' }}>
        <div className="state__hint" style={{ marginBottom: '6px' }}>
          Version history and artifacts
        </div>
        <DataTable
          columns={[
            { key: 'version_number', label: 'Version', align: 'right' },
            { key: 'version_status', label: 'Status', render: (raw) => humanizeToken(raw) },
            { key: 'job_purpose', label: 'Purpose', render: (raw) => humanizeToken(raw) },
            { key: 'label_job_id', label: 'Source job', render: (raw) => raw ? 'Linked' : '-' },
            { key: 'reprint_reason', label: 'Reason' },
            { key: 'generated_at', label: 'Generated', format: 'datetime' },
            { key: 'last_printed_at', label: 'Printed', format: 'datetime' },
            { key: 'print_count', label: 'Prints', align: 'right' },
          ]}
          rows={labelVersions}
          allowSelection={false}
          rowActions={[
            {
              label: 'Open version artifact',
              icon: 'download',
              kind: 'ghost',
              capability: CAP.LABELS_DOWNLOAD,
              onClick: (row) => { void openLabelArtifact('label_versions', row.id); },
            },
          ]}
          emptyText="No label version history recorded for this shipment."
        />
      </div>
    </div>
  );
}

function ScansTab({ shipment }: { shipment: Shipment }) {
  // CLAIM-OPERATIONS-WIRING (Phase C1) — read seam moved from `api.seed.*` to
  // canonical resource registry (`ui_list_resource_v1('scan_events')`).
  // Backed by public.scan_events (HASH partitioned;
  // supabase/migrations/202601251060_scan_events_v1.sql:49).
  const { data, isLoading, error } = useResourceList<Record<string, unknown>>('scan_events', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'occurred_at', dir: 'desc' },
  });
  if (isLoading) return <StateView kind="loading" />;
  if (error) return <StateView kind="error" hint={(error as Error).message} />;
  const scans = data?.rows ?? [];
  return (
    <DataTable
      columns={[
        { key: 'occurred_at', label: 'When', format: 'datetime' },
        { key: 'scan_type', label: 'Scan type', render: (raw) => humanizeToken(raw) },
        { key: 'box_barcode', label: 'Barcode', mono: true },
        { key: 'user_id', label: 'User', render: (raw) => compactReference(raw, 'User') },
        { key: 'notes', label: 'Notes' },
      ]}
      rows={scans}
      allowSelection={false}
      emptyText="No scans yet."
    />
  );
}

function DecisionsTab({ shipment }: { shipment: Shipment }) {
  const go = useConsoleNavigator();
  const destinationAddressId = String(
    (shipment as { destination_address_id?: string | null }).destination_address_id ?? '',
  ).trim();
  const log = useResourceList<Record<string, unknown>>('decision_log', {
    filter: { resource_type: 'shipment', resource_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
  });
  const reviewTasks = useResourceList<Record<string, unknown>>('manual_review_tasks', {
    filter: destinationAddressId ? { address_id: destinationAddressId } : { address_id: '__none__' },
    sort: { key: 'updated_at', dir: 'desc' },
    page_size: 10,
  }, { enabled: Boolean(destinationAddressId) });
  const latestReviewTaskId = useMemo(() => {
    const rows = reviewTasks.data?.rows ?? [];
    return firstText(rows.find((row) => String(row.task_type ?? '').trim().toLowerCase() === 'geocoding')?.id);
  }, [reviewTasks.data?.rows]);
  const reviewDecisionLog = useResourceList<Record<string, unknown>>(
    'decision_log',
    {
      filter: latestReviewTaskId
        ? { resource_type: 'manual_review_task', resource_id: latestReviewTaskId }
        : { resource_type: 'manual_review_task', resource_id: '__none__' },
      sort: { key: 'timestamp', dir: 'desc' },
    },
    { enabled: Boolean(latestReviewTaskId) },
  );
  const rows = useMemo(() => {
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of [...(log.data?.rows ?? []), ...(reviewDecisionLog.data?.rows ?? [])]) {
      const key = String(row.id ?? `${row.resource_type ?? ''}:${row.resource_id ?? ''}:${row.timestamp ?? ''}`);
      byId.set(key, row);
    }
    return Array.from(byId.values()).sort((a, b) => {
      const at = Date.parse(String(a.timestamp ?? a.created_at ?? ''));
      const bt = Date.parse(String(b.timestamp ?? b.created_at ?? ''));
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });
  }, [log.data?.rows, reviewDecisionLog.data?.rows]);
  if (log.isLoading || reviewTasks.isLoading || reviewDecisionLog.isLoading) return <StateView kind="loading" />;
  if (log.error && reviewDecisionLog.error) return <StateView kind="error" hint={(log.error as Error).message} />;
  return (
    <div className="stack">
      {log.error || reviewDecisionLog.error ? (
        <p className="state__hint">
          One decision stream is unavailable, so this view is showing the shipment decision rows that could be read.
        </p>
      ) : null}
      <DataTable
        columns={[
          { key: 'timestamp', label: 'When', format: 'datetime' },
          { key: 'decision_category', label: 'Category', lookup: 'decision_category' },
          { key: 'decision_point', label: 'Decision', render: (raw) => humanizeToken(raw) },
          { key: 'decision_outcome', label: 'Outcome', render: (raw) => humanizeToken(raw) },
          { key: 'resolved_from', label: 'Scope' },
          { key: 'settings_resolution_id', label: 'Resolution', render: (raw) => compactReference(raw, 'Resolution') },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText="No decisions recorded for this shipment."
        rowActions={[
          {
            label: 'View activity',
            icon: 'trace_tree',
            onClick: (row) => {
              go(`/insights/traces?correlation_id=${encodeURIComponent(
                String(row.correlation_id ?? ''),
              )}`);
            },
          },
        ]}
      />
    </div>
  );
}

function AuditTab({ shipment }: { shipment: Shipment }) {
  const log = useResourceList<Record<string, unknown>>('audit_table_changes', {
    filter: { table_name: 'shipments', pk: { id: shipment.id } },
    sort: { key: 'created_at', dir: 'desc' },
  });
  const actions = useResourceList<Record<string, unknown>>('shipment_actions', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
    page_size: 50,
  });
  if (log.isLoading || actions.isLoading) return <StateView kind="loading" />;
  if (log.error && actions.error) {
    return (
      <div className="state state--denied">
        <h3 className="state__title">Audit access denied</h3>
        <p className="state__hint">Audit activity permission is required.</p>
      </div>
    );
  }
  const all = log.data?.rows ?? [];
  const tableRows: Record<string, unknown>[] = log.error
    ? []
    : all
        .filter((row) => auditPkMatchesShipment(row.pk, shipment.id))
        .map((row) => ({
          ...row,
          audit_source: 'System audit',
        }));
  const actionRows: Record<string, unknown>[] = actions.error
    ? []
    : (actions.data?.rows ?? []).map((row) => {
        const actionData = asRecord(row.action_data) ?? {};
        return {
          id: row.id ?? `shipment_action_${row.timestamp ?? row.created_at ?? ''}`,
          created_at: row.timestamp ?? row.created_at,
          op: row.action_type ?? 'shipment_action',
          changed_by: row.performed_by_user_id ?? row.performed_by_system ?? row.created_by ?? row.actor_user_id,
          correlation_id: row.correlation_id ?? actionData.correlation_id,
          audit_source: 'Shipment action',
        };
      });
  const rows: Record<string, unknown>[] = [...tableRows, ...actionRows].sort((a, b) => {
    const at = Date.parse(String(a['created_at'] ?? ''));
    const bt = Date.parse(String(b['created_at'] ?? ''));
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
  return (
    <div className="stack">
      {log.error || actions.error ? (
        <p className="state__hint">
          One audit stream is unavailable, so this view is showing the shipment audit records that could be read.
        </p>
      ) : null}
      <DataTable
        columns={[
          { key: 'created_at', label: 'When', format: 'datetime' },
          { key: 'audit_source', label: 'Source' },
          { key: 'op', label: 'Operation', render: (raw) => humanizeToken(raw) },
          { key: 'changed_by', label: 'Actor', render: (raw) => compactReference(raw, 'Actor') },
          { key: 'correlation_id', label: 'Activity', render: (raw) => (raw ? 'Linked' : '-') },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText="No audit changes recorded for this shipment."
      />
    </div>
  );
}

function auditPkMatchesShipment(pk: unknown, shipmentId: string): boolean {
  if (pk === shipmentId) return true;
  if (typeof pk === 'string') {
    if (pk === shipmentId) return true;
    try {
      return auditPkMatchesShipment(JSON.parse(pk), shipmentId);
    } catch {
      return false;
    }
  }
  if (pk && typeof pk === 'object') {
    const rec = pk as Record<string, unknown>;
    return rec.id === shipmentId || rec.shipment_id === shipmentId;
  }
  return false;
}

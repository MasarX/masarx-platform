// pickups.tsx — TS/React port of demo-v2/assets/js/modules/op-pickups.js
// First-mile orchestration: Requests / Waves / Failures.
// Backed by api.pickup_requests_list_v1 / api.pickup_waves_list_v1 /
// api.pickup_failures_list_v1 / api.create_pickup_wave_v1 /
// api.assign_pickup_wave_v1 (canonical migrations 202603191130 + 202603191730).
//
// CLAIM C hardening sweep + CLAIM-C-FIX (this file):
//   • capability fix: BOTH create_pickup_wave_v1 AND assign_pickup_wave_v1
//     require `fleet.write` (NOT `pickups.write`, which does not exist in any
//     migration). See migration 202603191130_pickup_batch2_foundation_v1.sql
//     line 1581-1582 (create) and line 1982-1983 (assign).
//   • create_pickup_wave_v1 payload key is canonical `shipment_ids` (NOT
//     `request_ids`). See same migration line 1586/1610.
//   • create_pickup_wave_v1 now passes organization_id from current scope
//     (canonical RPC requires it; empty {} payload would fail in production).
//   • assign_pickup_wave_v1 now passes organization_id, route_run_id (the
//     canonical pickup wave UUID), and a real driver_id picked via
//     ReferencePicker against the drivers resource (was literal
//     'driver_default' which the backend would reject as not-a-UUID and
//     "driver not found"). The payload also carries a deterministic
//     idempotency_key so repeat clicks for the same visible assignment
//     transition cannot create duplicate pickup actions or Dispatch assignment
//     ledger versions.
//   • removed unbacked "Mark as resolved" failure action (no backing RPC).
//   • wired "Add to wave…" → opens picker and calls create_pickup_wave_v1.
//   • wired "Reschedule pickup" → shipment_amend_cancel_v1(op:'reschedule').
//   • wired "Open wave detail" → drawer with route_run summary + bulk actions.
//   • wired "Retry now" / Bulk retry on failures → create_pickup_wave_v1.
//   • wired "Open original request" → hash deep-link to /operate/shipments.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { ReferencePicker } from '@/components/ReferencePicker';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  usePickupRequests,
  usePickupWaves,
  usePickupFailures,
  useShipmentAmendCancel,
  useCompleteResourceList,
  // W54-C — strict canonical settings policy resolver for default windows.
  useResolveSettings,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { useCapability, useIdentity } from '@/lib/identity';
import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';

type TabId = 'requests' | 'waves' | 'failures';

// Wave 6 schema-drift remediation (OPERATIONS Sections 7-10):
// FE row interfaces annotated against canonical pickup tables and RPC
// projections. Migration cite: api.pickup_requests_list_v1 / pickup_waves_list_v1 /
// pickup_failures_list_v1 (supabase/migrations/202603191730_pickup_api_list_rpcs_v1.sql).
// See __audit__/SCHEMA-DRIFT/OPERATIONS.md §7-§10.
//
// W17-3 (12 deferred RENAMEs applied):
//   `api.pickup_requests_list_v1` (migration line 65-98) RETURNS TABLE with
//     `organization_id, client_id, sender_id, shipment_id, tracking_number,
//     client_reference_number, carrier_reference_number, status, box_count,
//     requested_window_start_at, requested_window_end_at, origin_address_id,
//     ...`. FE row interface now mirrors the canonical column shape:
//     `request_id`        → `shipment_id`                  (canonical FK)
//     `sender`            → `sender_id`                     (uuid; display via senders join at render time)
//     `client`            → `client_id`                     (uuid; display via clients join at render time)
//     `expected_at`       → `requested_window_start_at`    (canonical column)
//     `package_count`     → `box_count`                     (canonical column)
//   `api.pickup_waves_list_v1` (migration line 215-348) RETURNS TABLE with
//     `organization_id, branch_id, route_run_id, status, planned_*,
//     driver_user_id, vehicle_id, pickup_wave, pickup_assignment,
//     pickup_stop_count, total_box_count, shipments`. FE row interface now
//     mirrors the canonical column shape:
//     `wave_id`           → REMOVED (display label only; canonical is route_run_id)
//     `hub`               → `branch_id`                     (uuid; display via branches join at render time)
//     `driver`            → `driver_user_id`                (uuid; display via users join at render time)
//     `requests`          → `pickup_stop_count`             (canonical column)
//     `package_count`     → `total_box_count`               (canonical column)
//   `api.pickup_failures_list_v1` (migration line 350-…) RETURNS TABLE with
//     `organization_id, client_id, sender_id, shipment_id, tracking_number,
//     status, failed_at, failure_reason, failure_action_data, followup_tasks,
//     pickup_request`. FE row interface now mirrors the canonical column
//     shape:
//     `request_id`        → `shipment_id`                   (canonical FK to originating shipment)
//     `reason`            → `failure_reason`                (canonical column)
interface PickupRequestRow extends Record<string, unknown> {
  id: string;                       // SSOT: pickup_requests.id (RPC-projected)
  shipment_id: string;              // SSOT: pickup_requests_list_v1.shipment_id (canonical FK)
  sender_id: string;                // SSOT: pickup_requests_list_v1.sender_id (uuid; display via senders join)
  client_id: string;                // SSOT: pickup_requests_list_v1.client_id (uuid; display via clients join)
  requested_window_start_at: string; // SSOT: pickup_requests_list_v1.requested_window_start_at (canonical)
  box_count: number;                // SSOT: pickup_requests_list_v1.box_count (canonical)
  status: string;                   // SSOT: pickup_requests_list_v1.status (canonical)
}

interface PickupWaveRow extends Record<string, unknown> {
  id: string;                       // SSOT: pickup_waves.id
  // W17-3: `wave_id` REMOVED — was a synthesized display label only. The
  // canonical pickup wave identifier is `route_run_id` per migration
  // 202603191130_pickup_batch2_foundation_v1.sql line 1940
  // (`assign_pickup_wave_v1` requires `route_run_id`). Display labels are
  // formatted at render time via `waveDisplayLabel(row)`.
  route_run_id?: string;            // SSOT: pickup_waves_list_v1.route_run_id (canonical)
  branch_id: string;                // SSOT: pickup_waves_list_v1.branch_id (uuid; display via branches join)
  driver_user_id: string;           // SSOT: pickup_waves_list_v1.driver_user_id (uuid; display via users join)
  branch_label?: string | null;      // SSOT: optional projection label for operator display
  driver_label?: string | null;      // SSOT: optional projection label for operator display
  pickup_stop_count: number;        // SSOT: pickup_waves_list_v1.pickup_stop_count (canonical)
  total_box_count: number;          // SSOT: pickup_waves_list_v1.total_box_count (canonical)
  status: string;                   // SSOT: pickup_waves_list_v1.status (canonical)
}

// W13-2: dropped fictional `shift` per __audit__/SCHEMA-DRIFT/OPERATIONS.md §9
// (`driver_profiles` has no `shift` column). The driver picker now renders
// `id · vehicle_id` (both canonical: users.id + driver_profiles.current_vehicle_id)
// instead of synthesizing a "07:00-19:00" sub-label from a removed column.
interface DriverRow extends Record<string, unknown> {
  id: string;                       // SSOT: users.id / driver_profiles.user_id
  name: string;                     // SSOT: projection — resolved via users join
  vehicle_id?: string;              // SSOT: driver_profiles.current_vehicle_id
}

interface BranchLookupRow extends Record<string, unknown> {
  id: string;
  name?: string | null;
  code?: string | null;
  slug?: string | null;
}

// W13-2: dropped fictional `retry_strategy` per __audit__/SCHEMA-DRIFT/OPERATIONS.md §10
// (`pickup_failures_list_v1` has no `retry_strategy` column; retry is
// policy-resolved through `pickup_policy`).
// W17-3: applied 2 deferred RENAMEs — `request_id` → `shipment_id` (canonical
// FK to the originating shipment) and `reason` → `failure_reason` (canonical
// column). `api.pickup_failures_list_v1` (migration line 350-…) returns
// `shipment_id, tracking_number, status, failed_at, failure_reason,
// failure_action_data, followup_tasks, pickup_request`.
interface PickupFailureRow extends Record<string, unknown> {
  id: string;                       // SSOT: pickup_failures.id
  shipment_id: string;              // SSOT: pickup_failures_list_v1.shipment_id (canonical FK to originating shipment)
  failure_reason: string;           // SSOT: pickup_failures_list_v1.failure_reason (canonical)
  failed_at: string;                // SSOT: pickup_failures_list_v1.failed_at (canonical)
}

interface PickupClientLookupRow extends Record<string, unknown> {
  id: string;
  name?: string | null;
  display_name?: string | null;
}

interface PickupSenderLookupRow extends Record<string, unknown> {
  id: string;
  name?: string | null;
  display_name?: string | null;
}

export function PickupsModule() {
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.PICKUPS_READ);
  const [activeTab, setActiveTab] = useState<TabId>('requests');
  const [requestReadback, setRequestReadback] = useState<PickupRequestReadback | null>(null);
  const drawer = useDrawer();
  const modal = useModal();

  const requests = usePickupRequests<PickupRequestRow>();
  const waves = usePickupWaves<PickupWaveRow>();
  const failures = usePickupFailures<PickupFailureRow>();
  const amend = useShipmentAmendCancel();

  useEffect(() => {
    if (activeTab === 'requests') {
      void requests.refetch?.();
    } else if (activeTab === 'waves') {
      void waves.refetch?.();
    } else if (activeTab === 'failures') {
      void failures.refetch?.();
    }
  }, [activeTab, requests.refetch, waves.refetch, failures.refetch]);

  // organization_id is mandatory for create_pickup_wave_v1; pull from scope.
  const orgId = scope.tenant?.id ?? null;

  function openShipmentContext(shipmentId: string) {
    openShipmentContextDrawer(drawer, shipmentId);
  }

  const pills: ReactNode[] = [
    // W56-C closure — `scopeType="tenant"` is the canonical resource-tier literal
    // (pickups scope via current_user_org_id()). `scopeId` is identity-derived.
    // See shipments.tsx top-of-file ScopePill SSOT note.
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip key="policy" size="xs" label={<span>Pickup policy configured</span>} />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="pickups"
          eyebrow="Operate"
          titleAccent="Pickups"
          titlePlain="— first-mile orchestration"
        />
        <StateView
          kind="denied"
          capability={CAP.PICKUPS_READ}
          hint="You do not have permission to view pickups."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="pickups"
        eyebrow="Operate"
        titleAccent="Pickups"
        titlePlain="— first-mile orchestration"
        pills={pills}
        actions={[
          <Button
            key="create-request"
            label="Create request"
            iconName="plus"
            kind="primary"
            capability={CAP.SHIPMENTS_WRITE}
            testId="pickup-create-request-open"
            onClick={() => {
              setActiveTab('requests');
              modal.open({
                title: 'Create pickup request',
                body: (
                  <CreatePickupRequestBody
                    orgId={orgId}
                    existingRequests={(requests.data?.rows ?? []) as PickupRequestRow[]}
                    onCreated={async (readback) => {
                      await Promise.all([
                        requests.refetch?.(),
                        waves.refetch?.(),
                        failures.refetch?.(),
                      ]);
                      setRequestReadback(readback);
                      modal.close();
                    }}
                  />
                ),
              });
            }}
          />,
          <Button
            key="create"
            label="Create wave"
            iconName="plus"
            kind="primary"
            capability={CAP.FLEET_WRITE}
            onClick={() => {
              // Canonical create_pickup_wave_v1 requires non-empty shipment_ids
              // (migration 202603191130 line 1586/1610). The header button
              // routes to the Requests tab so the operator can pick which
              // requests to bundle into the new wave.
              setActiveTab('requests');
              pushToast('Select pickup requests below, then "Create wave from selected"', 'info');
            }}
          />,
        ]}
      />

      <div className="tabs">
        {(['requests', 'waves', 'failures'] as const).map((id) => (
          <div
            key={id}
            className={`tabs__tab ${activeTab === id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(id)}
            data-key={id}
          >
            {id.charAt(0).toUpperCase() + id.slice(1)}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {activeTab === 'requests' ? (
          <RequestsTab
            data={requests.data}
            loading={requests.isLoading}
            orgId={orgId}
            waves={(waves.data?.rows ?? []) as PickupWaveRow[]}
            onChanged={() => {
              requests.refetch?.();
              waves.refetch?.();
            }}
            modal={modal}
            amend={amend}
            onOpenShipment={openShipmentContext}
            requestReadback={requestReadback}
          />
        ) : null}
        {activeTab === 'waves' ? (
          <WavesTab
            data={waves.data}
            loading={waves.isLoading}
            orgId={orgId}
            onChanged={() => waves.refetch?.()}
            drawer={drawer}
          />
        ) : null}
        {activeTab === 'failures' ? (
          <FailuresTab
            data={failures.data}
            loading={failures.isLoading}
            orgId={orgId}
            onChanged={() => {
              return Promise.all([
                failures.refetch?.(),
                waves.refetch?.(),
              ]);
            }}
            onOpenShipment={openShipmentContext}
          />
        ) : null}
      </div>

      {drawer.node}
      {modal.node}
    </div>
  );
}

interface ListShape<T> { rows: T[]; total?: number }

type CreatePickupWaveResult = {
  ok?: boolean;
  wave_id?: string;
  route_run_id?: string;
  created?: boolean;
  error?: unknown;
  error_code?: unknown;
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

type CreatePickupRequestResult = {
  ok?: boolean;
  shipment_id?: string;
  tracking_number?: string;
  created?: boolean;
  operation?: string;
  error?: unknown;
  error_code?: unknown;
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

interface PickupRequestReadback {
  shipmentId: string;
  trackingNumber?: string;
  clientReferenceNumber?: string;
  rpc: string;
  refreshedAt: string;
}

interface PickupRetryReadback {
  waveId: string;
  shipmentCount: number;
  rpc: string;
  source: string;
  refreshedAt: string;
}

interface PickupWaveReadback {
  title: string;
  waveId: string;
  shipmentCount?: number;
  waveCount?: number;
  driverLabel?: string;
  rpc: string;
  source: string;
  result: string;
  refreshedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function pickupWaveErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (isRecord(error)) {
    return (
      nonEmptyString(error.message)
      ?? nonEmptyString(error.error_description)
      ?? nonEmptyString(error.code)
      ?? JSON.stringify(error)
    );
  }
  return 'unknown error';
}

function createPickupWaveEnvelopeError(rec: CreatePickupWaveResult): string | null {
  if (rec.error != null) return pickupWaveErrorMessage(rec.error);
  if (rec.ok === false) {
    return (
      nonEmptyString(rec.message)
      ?? nonEmptyString(rec.error_code)
      ?? nonEmptyString(rec.code)
      ?? 'ok=false'
    );
  }
  return null;
}

async function createPickupWaveStrict(payload: unknown): Promise<CreatePickupWaveResult & { wave_id: string }> {
  const res = (await api.create_pickup_wave_v1(payload)) as unknown;
  if (!isRecord(res)) {
    throw new Error('invalid response');
  }
  const rec = res as CreatePickupWaveResult;
  const body = isRecord(rec.data) ? (rec.data as CreatePickupWaveResult) : rec;
  const envelopeError = createPickupWaveEnvelopeError(rec) ?? createPickupWaveEnvelopeError(body);
  if (envelopeError) {
    throw new Error(envelopeError);
  }
  const waveId =
    nonEmptyString(body.wave_id)
    ?? nonEmptyString(body.route_run_id)
    ?? nonEmptyString(rec.wave_id)
    ?? nonEmptyString(rec.route_run_id);
  if (!waveId) {
    throw new Error('response missing route_run_id');
  }
  return { ...rec, ...body, wave_id: waveId };
}

async function createPickupRequestStrict(payload: unknown): Promise<CreatePickupRequestResult & { shipment_id: string }> {
  const res = (await api.create_pickup_request_v1(payload)) as unknown;
  if (!isRecord(res)) {
    throw new Error('invalid response');
  }
  const rec = res as CreatePickupRequestResult;
  const body = isRecord(rec.data) ? (rec.data as CreatePickupRequestResult) : rec;
  const envelopeError = createPickupWaveEnvelopeError(rec) ?? createPickupWaveEnvelopeError(body);
  if (envelopeError) {
    throw new Error(envelopeError);
  }
  const shipmentId =
    nonEmptyString(body.shipment_id)
    ?? nonEmptyString(rec.shipment_id);
  if (!shipmentId) {
    throw new Error('response missing shipment_id');
  }
  return { ...rec, ...body, shipment_id: shipmentId };
}

function pushPickupWaveFailure(error: unknown) {
  pushToast('Pickup wave could not be created. Try again.', 'danger');
}

function pushPickupRequestFailure(error: unknown) {
  pushToast('Pickup request could not be created. Try again.', 'danger');
}

function datetimeLocalOffset(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString().slice(0, 16);
}

function datetimeLocalToTimestamptz(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.endsWith('Z') ? trimmed : `${trimmed}:00Z`;
}

function lookupLabel(row: { id: string; name?: string | null; display_name?: string | null }): string {
  return String(row.display_name ?? row.name ?? row.id).trim();
}

function CreatePickupRequestBody({
  orgId,
  existingRequests,
  onCreated,
}: {
  orgId: string | null;
  existingRequests: PickupRequestRow[];
  onCreated: (readback: PickupRequestReadback) => Promise<void>;
}) {
  const clientsQuery = useCompleteResourceList<PickupClientLookupRow>('clients');
  const sendersQuery = useCompleteResourceList<PickupSenderLookupRow>('senders');
  const clients = (clientsQuery.data?.rows ?? []) as PickupClientLookupRow[];
  const senders = (sendersQuery.data?.rows ?? []) as PickupSenderLookupRow[];
  const defaultClientId = clients[0]?.id ?? existingRequests[0]?.client_id ?? '';
  const defaultSenderId = senders[0]?.id ?? existingRequests[0]?.sender_id ?? '';
  const [clientId, setClientId] = useState(defaultClientId);
  const [senderId, setSenderId] = useState(defaultSenderId);
  const [windowStart, setWindowStart] = useState(datetimeLocalOffset(60));
  const [windowEnd, setWindowEnd] = useState(datetimeLocalOffset(180));
  const [boxCount, setBoxCount] = useState('1');
  const [clientReferenceNumber, setClientReferenceNumber] = useState(`PICKUP-CONSOLE-${Date.now()}`);
  const [trackingNumber, setTrackingNumber] = useState('');
  const [originAddressJson, setOriginAddressJson] = useState(JSON.stringify({
    raw_input: 'First tenant pickup origin',
    line1: 'First tenant pickup origin',
    city: 'Riyadh',
    province: 'Riyadh',
    country: 'SA',
  }, null, 2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId && defaultClientId) setClientId(defaultClientId);
  }, [clientId, defaultClientId]);

  async function submit() {
    if (!orgId) {
      setError('No tenant scope available.');
      return;
    }
    let originAddress: Record<string, unknown>;
    try {
      const parsed = JSON.parse(originAddressJson) as unknown;
      if (!isRecord(parsed)) throw new Error('Origin address must be a JSON object.');
      originAddress = parsed;
    } catch {
      setError('Origin address must be valid JSON.');
      return;
    }
    const start = datetimeLocalToTimestamptz(windowStart);
    const end = datetimeLocalToTimestamptz(windowEnd);
    if (!clientId || !start || !end) {
      setError('Client and pickup window are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createPickupRequestStrict({
        organization_id: orgId,
        client_id: clientId,
        sender_id: senderId || null,
        requested_window_start_at: start,
        requested_window_end_at: end,
        box_count: Number.parseInt(boxCount, 10) || 1,
        tracking_number: trackingNumber || null,
        client_reference_number: clientReferenceNumber || null,
        origin_address: originAddress,
        metadata: {
          source: 'console-v2.operate.pickups.create_request',
        },
      });
      await onCreated({
        shipmentId: res.shipment_id,
        trackingNumber: nonEmptyString(res.tracking_number) ?? undefined,
        clientReferenceNumber: clientReferenceNumber || undefined,
        rpc: 'create_pickup_request_v1',
        refreshedAt: new Date().toISOString(),
      });
      pushToast(res.tracking_number ? `Pickup request created - ${res.tracking_number}` : 'Pickup request created', 'good');
    } catch (err) {
      setError('Pickup request could not be created. Check the form and try again.');
      pushPickupRequestFailure(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        Creates a pickup request and refreshes this list before success is shown.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px', marginTop: '12px' }}>
        <div className="field">
          <label className="field__label">Client</label>
          <select data-testid="pickup-create-request-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {defaultClientId && clients.length === 0 ? <option value={defaultClientId}>{defaultClientId}</option> : null}
            {clients.map((client) => <option key={client.id} value={client.id}>{lookupLabel(client)}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field__label">Sender</label>
          <select data-testid="pickup-create-request-sender" value={senderId} onChange={(e) => setSenderId(e.target.value)}>
            <option value="">No sender</option>
            {defaultSenderId && senders.length === 0 ? <option value={defaultSenderId}>{defaultSenderId}</option> : null}
            {senders.map((sender) => <option key={sender.id} value={sender.id}>{lookupLabel(sender)}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field__label">Window start</label>
          <input data-testid="pickup-create-request-window-start" type="datetime-local" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">Window end</label>
          <input data-testid="pickup-create-request-window-end" type="datetime-local" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">Boxes</label>
          <input data-testid="pickup-create-request-box-count" type="number" min={1} value={boxCount} onChange={(e) => setBoxCount(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">Tracking number</label>
          <input data-testid="pickup-create-request-tracking" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="Optional" />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label className="field__label">Client reference</label>
          <input data-testid="pickup-create-request-client-reference" value={clientReferenceNumber} onChange={(e) => setClientReferenceNumber(e.target.value)} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label className="field__label">Origin address JSON</label>
          <textarea data-testid="pickup-create-request-origin-address" rows={8} value={originAddressJson} onChange={(e) => setOriginAddressJson(e.target.value)} />
        </div>
      </div>
      {error ? <StateView kind="error" title="Pickup request creation failed" hint={error} /> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label="Create pickup request" kind="primary" capability={CAP.SHIPMENTS_WRITE} disabled={submitting} onClick={() => void submit()} testId="pickup-create-request-submit" />
      </div>
    </div>
  );
}

function RequestsTab({
  data,
  loading,
  orgId,
  waves,
  onChanged,
  modal,
  amend,
  onOpenShipment,
  requestReadback,
}: {
  data: ListShape<PickupRequestRow> | undefined;
  loading: boolean;
  orgId: string | null;
  waves: PickupWaveRow[];
  onChanged: () => void | Promise<unknown>;
  modal: ReturnType<typeof useModal>;
  amend: ReturnType<typeof useShipmentAmendCancel>;
  onOpenShipment: (shipmentId: string) => void;
  requestReadback: PickupRequestReadback | null;
}) {
  const go = useConsoleNavigator();
  const [waveReadback, setWaveReadback] = useState<PickupWaveReadback | null>(null);
  const columns: Array<DataTableColumn<PickupRequestRow>> = useMemo(
    () => [
      // W17-3: column keys aligned to canonical pickup_requests_list_v1 columns.
      { key: 'shipment_id', label: 'Request', mono: true, sortable: true, filterable: true },
      { key: 'sender_id', label: 'Sender', sortable: true, filterable: true },
      { key: 'client_id', label: 'Client', sortable: true, filterable: true },
      { key: 'requested_window_start_at', label: 'Expected', format: 'datetime', sortable: true },
      { key: 'box_count', label: 'Packages', align: 'right', type: 'number', sortable: true },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        lookup: 'pickup_request_status',
      },
    ],
    [],
  );

  function openAddToWavePicker(rs: PickupRequestRow[]) {
    // W71-Operate (Cycle F-R-11) closure — assignable-wave gate resolves
    // through canonical `pickup_wave_status.metadata.is_assignable` instead
    // of an inline `'planned'` literal compare. Adding a new "accepts new
    // requests" status now flips a single seed flag rather than touching
    // call sites. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
    const assignable = waves.filter(
      (w) => lookupRow('pickup_wave_status', w.status)?.metadata?.is_assignable === true,
    );
    modal.open({
      title: `Add ${rs.length} request(s) to wave`,
      body: (
        <AddToWaveBody
          requests={rs}
          assignableWaves={assignable}
          orgId={orgId}
          onDone={async (readback) => {
            modal.close();
            await onChanged();
            if (readback) setWaveReadback(readback);
          }}
        />
      ),
    });
  }

  function openReschedulePickup(r: PickupRequestRow) {
    modal.open({
      // W17-3: display canonical shipment_id chip in modal title.
      title: `Reschedule pickup · ${r.shipment_id}`,
      body: (
        <ReschedulePickupBody
          request={r}
          amend={amend}
          onDone={() => {
            modal.close();
            onChanged();
          }}
        />
      ),
    });
  }

  if (loading) return <StateView kind="loading" />;
  async function recordWaveReadback(
    res: CreatePickupWaveResult & { wave_id: string },
    shipmentCount: number,
    source: string,
  ) {
    await onChanged();
    setWaveReadback({
      title: 'Pickup wave status',
      waveId: res.wave_id,
      shipmentCount,
      rpc: 'create_pickup_wave_v1',
      source,
      result: res.created === false ? 'Existing wave reused' : 'Wave created',
      refreshedAt: new Date().toISOString(),
    });
  }
  return (
    <>
    {requestReadback ? (
      <div className="card" aria-label="Pickup request status" style={{ marginBottom: '12px' }}>
        <div className="eyebrow">Pickup request status</div>
        <div className="state__hint">Request created and the pickup queue was refreshed</div>
        <div className="state__hint" style={{ marginTop: '6px' }}>
          {requestReadback.trackingNumber ?? requestReadback.clientReferenceNumber ?? 'Request created'}
        </div>
        <div className="state__hint">Updated {requestReadback.refreshedAt}</div>
      </div>
    ) : null}
    {waveReadback ? <PickupWaveReadbackPanel readback={waveReadback} /> : null}
    <DataTable<PickupRequestRow>
      columns={columns}
      rows={data?.rows ?? []}
      viewKey="pickup_requests"
      entityKind="pickup_request"
      onRowClick={(r) => onOpenShipment(r.shipment_id)}
      rowDeepLink={(r) => `/operate/shipments?focus=${encodeURIComponent(r.shipment_id)}`}
      rowActions={[
        {
          label: 'Add to wave…',
          icon: 'plus',
          kind: 'primary',
          capability: CAP.FLEET_WRITE,
          onClick: (r) => openAddToWavePicker([r]),
        },
        {
          label: 'Reschedule pickup',
          icon: 'history',
          capability: CAP.SHIPMENTS_WRITE,
          onClick: openReschedulePickup,
        },
        {
          label: 'View sender',
          icon: 'right',
          onClick: () => {
            go('/customers/senders');
          },
        },
      ]}
      bulkActions={[
        {
          label: 'Create wave from selected',
          icon: 'plus',
          kind: 'primary',
          capability: CAP.FLEET_WRITE,
          onClick: async (rs) => {
            if (!orgId) {
              pushToast('Tenant context is required to create a pickup wave.', 'warn');
              return;
            }
            // Canonical key is `shipment_ids` (migration 202603191130
            // line 1586/1610), NOT `request_ids`. The synthetic adapter
            // ignores its payload, so the wrong key would only surface in
            // production. Using `shipment_ids` keeps the FE swap-ready.
            // W17-3: row identity is now `shipment_id` (canonical FK).
            try {
              const res = await createPickupWaveStrict({
                organization_id: orgId,
                shipment_ids: rs.map((r) => r.shipment_id),
              });
              await recordWaveReadback(res, rs.length, 'request_bulk_create_wave');
              pushToast(`Pickup wave created - ${rs.length} requests`, 'good');
            } catch (err) {
              pushPickupWaveFailure(err);
            }
          },
        },
        {
          label: 'Add to existing wave…',
          icon: 'plus',
          capability: CAP.FLEET_WRITE,
          onClick: openAddToWavePicker,
        },
      ]}
    />
    </>
  );
}

function AddToWaveBody({
  requests,
  assignableWaves,
  orgId,
  onDone,
}: {
  requests: PickupRequestRow[];
  assignableWaves: PickupWaveRow[];
  orgId: string | null;
  onDone: (readback?: PickupWaveReadback) => void | Promise<void>;
}) {
  // W17-3: pickup wave canonical identifier is `route_run_id` (migration
  // 202603191130 line 1940). The synthesized `wave_id` display label was
  // dropped; we now use `route_run_id` as the radio value SSOT and format
  // the visible label via `waveDisplayLabel(w)`.
  const [pickedWave, setPickedWave] = useState<string>(assignableWaves[0]?.route_run_id ?? '__new__');
  const shipmentIds = requests.map((r) => r.shipment_id);

  return (
    <div>
      <p className="state__hint">
        Either create a new wave from the selected requests, or attach them to an existing planned wave.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
        <label className="card" style={{ cursor: 'pointer' }}>
          <input
            type="radio"
            name="wave"
            value="__new__"
            checked={pickedWave === '__new__'}
            onChange={() => setPickedWave('__new__')}
            style={{ marginRight: '8px' }}
          />
          <strong>Create new wave</strong>
          <span className="mono" style={{ marginLeft: '8px', color: 'var(--ink-3)' }}>{`· ${shipmentIds.length} requests`}</span>
        </label>
        {assignableWaves.map((w) => {
          const value = w.route_run_id ?? w.id;
          const label = waveDisplayLabel(w);
          return (
            <label key={value} className="card" style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name="wave"
                value={value}
                checked={pickedWave === value}
                onChange={() => setPickedWave(value)}
                style={{ marginRight: '8px' }}
              />
              <strong>{label}</strong>
              <span style={{ marginLeft: '8px' }}>{waveBranchLabel(w)}</span>
              <span className="mono" style={{ marginLeft: '8px', color: 'var(--ink-3)' }}>{`· ${w.pickup_stop_count} req · ${w.total_box_count} pkgs`}</span>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label="Cancel" kind="ghost" onClick={() => void onDone()} />
        <Button
          label="Confirm"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          onClick={async () => {
            if (!orgId) {
              pushToast('Tenant context is required to create a pickup wave.', 'warn');
              void onDone();
              return;
            }
            // Canonical payload key is `shipment_ids` (migration 202603191130
            // line 1586/1610). When attaching to an existing wave we also
            // pass route_run_id so the RPC reuses that wave.
            const payload =
              pickedWave === '__new__'
                ? { organization_id: orgId, shipment_ids: shipmentIds }
                : { organization_id: orgId, shipment_ids: shipmentIds, route_run_id: pickedWave };
            try {
              const res = await createPickupWaveStrict(payload);
              pushToast(
                `Pickup wave ${res.created === false ? 'reused' : 'created'} - ${shipmentIds.length} requests`,
                'good',
              );
              await onDone({
                title: 'Pickup wave status',
                waveId: res.wave_id,
                shipmentCount: shipmentIds.length,
                rpc: 'create_pickup_wave_v1',
                source: pickedWave === '__new__' ? 'request_create_wave' : 'request_add_to_existing_wave',
                result: res.created === false ? 'Existing wave reused' : 'Wave created',
                refreshedAt: new Date().toISOString(),
              });
            } catch (err) {
              pushPickupWaveFailure(err);
            }
          }}
        />
      </div>
    </div>
  );
}

// W17-3: helper to format a human-readable label for a pickup wave row.
// `wave_id` was a synthesized FE-only display string; the canonical SSOT is
// `route_run_id` (uuid). This helper preserves the operator-facing chip text
// without re-introducing the dropped column.
function waveDisplayLabel(w: PickupWaveRow): string {
  if (w.route_run_id) return `wave · ${w.route_run_id.slice(0, 8)}…`;
  return `wave · ${w.id}`;
}

function branchLabelMap(rows: BranchLookupRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const branch of rows) {
    const label = String(branch.name ?? branch.code ?? branch.id).trim();
    for (const key of [branch.id, branch.code, branch.slug]) {
      const token = String(key ?? '').trim();
      if (!token) continue;
      map.set(token, label);
      map.set(token.toUpperCase(), label);
      map.set(token.toLowerCase(), label);
    }
  }
  return map;
}

function waveBranchLabel(w: PickupWaveRow, branchLabelById?: Map<string, string>): string {
  const projected = String(w.branch_label ?? '').trim();
  if (projected) return projected;
  const branchId = String(w.branch_id ?? '').trim();
  if (!branchId) return 'Unassigned hub';
  return branchLabelById?.get(branchId) ?? branchLabelById?.get(branchId.toUpperCase()) ?? branchLabelById?.get(branchId.toLowerCase()) ?? `Branch ${branchId}`;
}

function waveDriverLabel(w: PickupWaveRow, driverLabelById?: Map<string, string>): string {
  if (!w.driver_user_id) return 'Unassigned';
  return w.driver_label || driverLabelById?.get(w.driver_user_id) || `Driver ${w.driver_user_id}`;
}

function ReschedulePickupBody({
  request,
  amend,
  onDone,
}: {
  request: PickupRequestRow;
  amend: ReturnType<typeof useShipmentAmendCancel>;
  onDone: () => void;
}) {
  // W54-C — default window times resolved strictly from canonical
  // `pickup_policy.default_window_start` / `default_window_end`. Replaces
  // inline `'14:00'` / `'16:00'` magic literals.
  // W27 Cycle D — `default_reschedule_offsets` (seconds) resolved
  // strictly from canonical `pickup_policy`. Replaces inline `[+1, +2, +3]`
  // day-offset literals. Surfaces a fail-loud StateView when the policy
  // row is missing (no neutral default — operators see the gap).
  const pickupPolicy = useResolveSettings('pickup_policy', undefined);
  const policyValue = pickupPolicy.data?.value as
    | {
        default_window_start?: string;
        default_window_end?: string;
        default_reschedule_offsets?: number[];
      }
    | undefined;
  const offsets = policyValue?.default_reschedule_offsets;
  const today = new Date();
  const dateOpts = (offsets ?? []).map((sec) => new Date(today.getTime() + sec * 1000));
  const [pickedDate, setPickedDate] = useState<string>(dateOpts[0]?.toISOString().slice(0, 10) ?? '');
  const [windowStart, setWindowStart] = useState<string>(policyValue?.default_window_start ?? '');
  const [windowEnd, setWindowEnd] = useState<string>(policyValue?.default_window_end ?? '');

  if (!offsets || offsets.length === 0) {
    return (
      <StateView
        kind="error"
        title="Pickup reschedule policy is not configured"
        hint="Seed the pickup reschedule offsets before rendering the date picker."
      />
    );
  }

  return (
    <div>
      <p className="state__hint">
        Preview or apply a pickup reschedule with the selected service window.
      </p>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">New pickup date</label>
        <select value={pickedDate} onChange={(e) => setPickedDate(e.target.value)}>
          {dateOpts.map((d) => {
            const iso = d.toISOString().slice(0, 10);
            return <option key={iso} value={iso}>{iso}</option>;
          })}
        </select>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="field__label">Window start</label>
          <input type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field__label">Window end</label>
          <input type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label="Cancel" kind="ghost" onClick={onDone} />
        <Button
          label="Preview"
          kind="ghost"
          onClick={async () => {
            // W17-3: canonical FK is `shipment_id` (migration line 69).
            await amend.mutateAsync({
              shipmentId: request.shipment_id,
              op: 'reschedule',
              payload: { window: { start: `${pickedDate}T${windowStart}:00Z`, end: `${pickedDate}T${windowEnd}:00Z` } },
              dryRun: true,
            });
            pushToast('Pickup reschedule preview passed', 'info');
          }}
        />
        <Button
          label="Apply reschedule"
          kind="primary"
          capability={CAP.SHIPMENTS_WRITE}
          onClick={async () => {
            const res = await amend.mutateAsync({
              shipmentId: request.shipment_id,
              op: 'reschedule',
              payload: { window: { start: `${pickedDate}T${windowStart}:00Z`, end: `${pickedDate}T${windowEnd}:00Z` } },
            });
            // W27 Cycle D — strict no-fallback. NO inline 'wfr_unknown'.
            // Mirrors operate/amend-cancel.tsx canonical pattern: when the
            // canonical workflow_run_id is missing, surface a danger toast
            // and abort so operators see the gap loudly.
            const wf = (res as { workflow_run_id?: string }).workflow_run_id;
            if (!wf) {
            pushToast('Pickup workflow could not be started. Try again.', 'danger');
              return;
            }
            pushToast('Pickup workflow started', 'good');
            onDone();
          }}
        />
      </div>
    </div>
  );
}

// Picker target for assign_pickup_wave_v1: either a single wave or a list of
// waves (bulk). The picker resolves a real driver UUID via ReferencePicker
// against the drivers resource and the assign call passes the canonical
// payload `{ organization_id, route_run_id, driver_user_id, idempotency_key }`
// per migration 202603191130_pickup_batch2_foundation_v1.sql lines 1940-1985.
type AssignTarget = { kind: 'single'; wave: PickupWaveRow } | { kind: 'bulk'; waves: PickupWaveRow[] };

function WavesTab({
  data,
  loading,
  orgId,
  onChanged,
  drawer,
}: {
  data: ListShape<PickupWaveRow> | undefined;
  loading: boolean;
  orgId: string | null;
  onChanged: () => void;
  drawer: ReturnType<typeof useDrawer>;
}) {
  const driversQuery = useCompleteResourceList<DriverRow>('drivers');
  const drivers = (driversQuery.data?.rows ?? []) as DriverRow[];
  const branchesQuery = useCompleteResourceList<BranchLookupRow>('branches');
  const branches = (branchesQuery.data?.rows ?? []) as BranchLookupRow[];
  const branchLabelById = useMemo(() => branchLabelMap(branches), [branches]);
  const driverLabelById = useMemo(() => new Map(drivers.map((driver) => [driver.id, driver.name])), [drivers]);
  const waveRows = useMemo(
    () =>
      (data?.rows ?? []).map((wave) => ({
        ...wave,
        branch_label: waveBranchLabel(wave, branchLabelById),
        driver_label: waveDriverLabel(wave, driverLabelById),
      })),
    [data?.rows, branchLabelById, driverLabelById],
  );
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  const [assignmentReadback, setAssignmentReadback] = useState<PickupWaveReadback | null>(null);

  const columns: Array<DataTableColumn<PickupWaveRow>> = useMemo(
    () => [
      // W17-3: column keys aligned to canonical pickup_waves_list_v1 columns.
      // `wave_id` was dropped (display label only); the canonical SSOT chip is
      // route_run_id (uuid) — surfaced in the Wave column with mono formatting.
      { key: 'route_run_id', label: 'Wave', mono: true, sortable: true, filterable: true },
      { key: 'branch_label', label: 'Hub', sortable: true, filterable: true },
      { key: 'driver_label', label: 'Driver', sortable: true, filterable: true },
      { key: 'pickup_stop_count', label: 'Requests', align: 'right', type: 'number', sortable: true },
      { key: 'total_box_count', label: 'Packages', align: 'right', type: 'number', sortable: true },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        lookup: 'pickup_wave_status',
      },
    ],
    [],
  );

  // Canonical assign payload per migration 202603191130 line 1940-1985.
  // Requires: route_run_id + organization_id (server cross-checks) +
  // driver_user_id (must resolve to an active user UUID, not a literal) and a
  // deterministic idempotency_key for the visible assignment transition.
  async function applyAssign(wave: PickupWaveRow, driverId: string) {
    if (!orgId) {
      pushToast('Tenant context is required to assign a driver.', 'warn');
      return null;
    }
    const routeRunId = wave.route_run_id;
    if (!routeRunId) {
      // W17-3: display label is now derived from route_run_id (canonical).
      pushToast(`Wave ${waveDisplayLabel(wave)} has no route run yet - cannot assign`, 'warn');
      return null;
    }
    if (wave.driver_user_id === driverId) {
      pushToast(`Pickup wave already assigned - ${waveDisplayLabel(wave)} - ${driverLabelById.get(driverId) ?? 'selected driver'}`, 'good');
      return null;
    }
    const fromDriver = wave.driver_user_id || 'unassigned';
    return api.assign_pickup_wave_v1(routeRunId, {
      organization_id: orgId,
      route_run_id: routeRunId,
      driver_user_id: driverId,
      idempotency_key: `console-v2:pickup-wave-assign:${orgId}:${routeRunId}:${fromDriver}:${driverId}`,
    });
  }

  async function handlePickedDriver(driverId: string) {
    if (!assignTarget) return;
    if (assignTarget.kind === 'single') {
      const w = assignTarget.wave;
      const result = await applyAssign(w, driverId);
      if (result) {
        await onChanged();
        setAssignmentReadback({
          title: 'Pickup assignment status',
          waveId: result.wave_id,
          waveCount: 1,
          driverLabel: driverLabelById.get(driverId) ?? driverId,
          rpc: 'assign_pickup_wave_v1',
          source: 'wave_assign_driver',
          result: 'Driver assignment confirmed',
          refreshedAt: new Date().toISOString(),
        });
        // W17-3: derive display label from canonical route_run_id.
        pushToast(`Pickup wave assigned - ${waveDisplayLabel(w)} - ${driverLabelById.get(driverId) ?? 'assigned driver'}`, 'good');
        drawer.close();
      }
    } else {
      const ws = assignTarget.waves;
      let okCount = 0;
      for (const w of ws) {
        const result = await applyAssign(w, driverId);
        if (result) okCount++;
      }
      if (okCount > 0) {
        await onChanged();
        setAssignmentReadback({
          title: 'Pickup assignment status',
          waveId: `${okCount} waves`,
          waveCount: okCount,
          driverLabel: driverLabelById.get(driverId) ?? driverId,
          rpc: 'assign_pickup_wave_v1',
          source: 'wave_bulk_assign_driver',
          result: 'Driver assignment confirmed',
          refreshedAt: new Date().toISOString(),
        });
      }
      pushToast(`Pickup waves assigned - ${okCount}/${ws.length} - ${driverLabelById.get(driverId) ?? 'assigned driver'}`, 'good');
    }
    setAssignTarget(null);
  }

  function openWaveDetail(w: PickupWaveRow) {
    const hubLabel = waveBranchLabel(w, branchLabelById);
    const driverLabel = waveDriverLabel(w, driverLabelById);
    drawer.open({
      // W17-3: title resolves canonical branch_id chip (display via branches join
      // is deferred to G1 paired registry projection).
      title: `${waveDisplayLabel(w)} · ${hubLabel}`,
      size: 'lg',
      body: (
        <div>
          <h4 className="eyebrow">Wave summary</h4>
          <div className="card">
            <Kv k="Wave" v={<span className="mono">{waveDisplayLabel(w)}</span>} />
            <Kv k="Route run" v={<span className="mono">{w.route_run_id ?? '—'}</span>} />
            <Kv k="Hub" v={<span>{hubLabel}</span>} />
            <Kv k="Driver" v={w.driver_user_id ? <span>{driverLabel}</span> : <span className="state__hint">Unassigned</span>} />
            <Kv k="Requests" v={String(w.pickup_stop_count)} />
            <Kv k="Packages" v={String(w.total_box_count)} />
            <Kv k="Status" v={<Chip size="xs" label={w.status} />} />
          </div>
          <p className="state__hint" style={{ marginTop: '10px' }}>
            Review pickup wave stops, assigned driver, and route status before dispatch.
          </p>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <div style={{ flex: 1 }} />
          <Button
            label="Assign driver…"
            iconName="user"
            kind="primary"
            capability={CAP.FLEET_WRITE}
            onClick={() => setAssignTarget({ kind: 'single', wave: w })}
          />
        </div>
      ),
    });
  }

  if (loading) return <StateView kind="loading" />;
  return (
    <>
      {assignmentReadback ? <PickupWaveReadbackPanel readback={assignmentReadback} ariaLabel="Pickup assignment status" /> : null}
      <DataTable<PickupWaveRow>
        columns={columns}
        rows={waveRows}
        viewKey="pickup_waves"
        entityKind="pickup_wave"
        onRowClick={openWaveDetail}
        rowActions={[
          {
            label: 'Assign driver…',
            icon: 'user',
            kind: 'primary',
            capability: CAP.FLEET_WRITE,
            onClick: (r) => setAssignTarget({ kind: 'single', wave: r }),
          },
          { label: 'Open wave detail', icon: 'eye', onClick: openWaveDetail },
        ]}
        bulkActions={[
          {
            label: 'Bulk assign',
            icon: 'user',
            kind: 'primary',
            capability: CAP.FLEET_WRITE,
            onClick: (rs) => setAssignTarget({ kind: 'bulk', waves: rs }),
          },
        ]}
      />
      <ReferencePicker
        open={assignTarget != null}
        title={
          assignTarget?.kind === 'single'
            // W17-3: derive display label from canonical route_run_id.
            ? `Assign driver · ${waveDisplayLabel(assignTarget.wave)}`
            : assignTarget?.kind === 'bulk'
              ? `Assign driver · ${assignTarget.waves.length} waves`
              : 'Assign driver'
        }
        source={{
          kind: 'reference',
          items: drivers as unknown as Array<Record<string, unknown>>,
          display: (r) => (r as DriverRow).name,
          value: (r) => (r as DriverRow).id,
          sub: (r) => {
            // W13-2: keep the picker subtitle operator-facing while the
            // selected value remains the canonical driver UUID.
            const d = r as DriverRow;
            return d.vehicle_id ? 'Vehicle assigned' : 'No vehicle assigned';
          },
          section: 'Drivers',
        }}
        onClose={() => setAssignTarget(null)}
        onPick={(val) => {
          if (typeof val === 'string') void handlePickedDriver(val);
        }}
      />
    </>
  );
}

function FailuresTab({
  data,
  loading,
  orgId,
  onChanged,
  onOpenShipment,
}: {
  data: ListShape<PickupFailureRow> | undefined;
  loading: boolean;
  orgId: string | null;
  onChanged: () => void | Promise<unknown>;
  onOpenShipment: (shipmentId: string) => void;
}) {
  const [retryReadback, setRetryReadback] = useState<PickupRetryReadback | null>(null);
  const columns: Array<DataTableColumn<PickupFailureRow>> = useMemo(
    () => [
      // W17-3: column keys aligned to canonical pickup_failures_list_v1 columns.
      { key: 'shipment_id', label: 'Request', mono: true, sortable: true, filterable: true },
      { key: 'failure_reason', label: 'Reason', sortable: true, filterable: true, lookup: 'pickup_failure_reason' },
      { key: 'failed_at', label: 'Failed at', format: 'datetime', sortable: true },
      // W13-2: `retry_strategy` column dropped — fictional FE-only field.
      // Retry policy is resolved per-failure via the canonical `pickup_policy`
      // settings ladder (see `__audit__/SCHEMA-DRIFT/OPERATIONS.md` §10);
      // operator action (Retry now / bulk retry) already triggers
      // `create_pickup_wave_v1` so the column was advisory only.
    ],
    [],
  );
  if (loading) return <StateView kind="loading" />;
  async function recordRetryReadback(
    res: CreatePickupWaveResult & { wave_id: string },
    shipmentCount: number,
    source: string,
  ) {
    await onChanged();
    setRetryReadback({
      waveId: res.wave_id,
      shipmentCount,
      rpc: 'create_pickup_wave_v1',
      source,
      refreshedAt: new Date().toISOString(),
    });
  }
  return (
    <>
    <DataTable<PickupFailureRow>
      columns={columns}
      rows={data?.rows ?? []}
      viewKey="pickup_failures"
      entityKind="pickup_failure"
      onRowClick={(r) => onOpenShipment(r.shipment_id)}
      rowDeepLink={(r) => `/operate/shipments?focus=${encodeURIComponent(r.shipment_id)}`}
      rowActions={[
        {
          label: 'Retry now',
          icon: 'rotate',
          kind: 'primary',
          capability: CAP.FLEET_WRITE,
          onClick: async (r) => {
            if (!orgId) {
              pushToast('Tenant context is required to create a pickup wave.', 'warn');
              return;
            }
            // Canonical key is `shipment_ids` (migration 202603191130
            // line 1586/1610), NOT `request_ids`.
            // W17-3: row identity now sources canonical shipment_id.
            try {
              const res = await createPickupWaveStrict({
                organization_id: orgId,
                shipment_ids: [r.shipment_id],
              });
              await recordRetryReadback(res, 1, 'failure_retry');
              pushToast('Pickup retry wave created', 'good');
            } catch (err) {
              pushPickupWaveFailure(err);
            }
          },
        },
        {
          label: 'Open original request',
          icon: 'right',
          onClick: (r) => onOpenShipment(r.shipment_id),
        },
      ]}
      bulkActions={[
        {
          label: 'Bulk retry',
          icon: 'rotate',
          kind: 'primary',
          capability: CAP.FLEET_WRITE,
          onClick: async (rs) => {
            if (!orgId) {
              pushToast('Tenant context is required to create a pickup wave.', 'warn');
              return;
            }
            // Canonical key is `shipment_ids` (migration 202603191130
            // line 1586/1610), NOT `request_ids`.
            // W17-3: row identity now sources canonical shipment_id.
            try {
              const res = await createPickupWaveStrict({
                organization_id: orgId,
                shipment_ids: rs.map((r) => r.shipment_id),
              });
              await recordRetryReadback(res, rs.length, 'failure_bulk_retry');
              pushToast(`Pickup retry waves queued - ${rs.length} retries`, 'good');
            } catch (err) {
              pushPickupWaveFailure(err);
            }
          },
        },
      ]}
    />
    {retryReadback ? <PickupRetryReadbackPanel readback={retryReadback} /> : null}
    </>
  );
}

function PickupRetryReadbackPanel({ readback }: { readback: PickupRetryReadback }) {
  return (
    <PickupWaveReadbackPanel
      readback={{
        title: 'Pickup retry status',
        waveId: readback.waveId,
        shipmentCount: readback.shipmentCount,
        rpc: readback.rpc,
        source: readback.source,
        result: 'Queued for pickup',
        refreshedAt: readback.refreshedAt,
      }}
      ariaLabel="Pickup retry status"
    />
  );
}

function PickupWaveReadbackPanel({
  readback,
  ariaLabel = 'Pickup wave status',
}: {
  readback: PickupWaveReadback;
  ariaLabel?: string;
}) {
  const isAssignment = readback.source.includes('assign');
  const actionLabel = pickupActionLabel(readback.source);
  const recordedBy =
    readback.rpc === 'assign_pickup_wave_v1'
      ? 'Fleet assignment'
      : 'Pickup orchestration';
  return (
    <section
      className="panel"
      aria-label={ariaLabel}
      style={{ marginTop: '14px', display: 'grid', gap: '10px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 14px' }}>
        <Chip size="sm" kind="good" label={readback.title} />
        <span className="state__hint">Confirmation saved and pickup queues refreshed</span>
      </div>
      <div className="card">
        <Kv k={isAssignment ? 'Assignment reference' : 'Wave reference'} v={<span className="mono">{readback.waveId}</span>} />
        {readback.shipmentCount != null ? <Kv k="Shipments" v={String(readback.shipmentCount)} /> : null}
        {readback.waveCount != null ? <Kv k="Waves" v={String(readback.waveCount)} /> : null}
        {readback.driverLabel ? <Kv k="Driver" v={readback.driverLabel} /> : null}
        <Kv k="Action" v={actionLabel} />
        <Kv k="Recorded by" v={recordedBy} />
        <Kv k="Confirmation" v={readback.result} />
        <Kv k="Queue refresh" v={`Pickup queues refreshed at ${readback.refreshedAt}`} />
      </div>
    </section>
  );
}

function pickupActionLabel(source: string): string {
  switch (source) {
    case 'request_bulk_create_wave':
      return 'Create wave from selected requests';
    case 'request_create_wave':
      return 'Create new pickup wave';
    case 'request_add_to_existing_wave':
      return 'Add requests to existing wave';
    case 'failure_retry':
      return 'Retry failed pickup';
    case 'failure_bulk_retry':
      return 'Bulk retry failed pickups';
    case 'wave_assign_driver':
      return 'Assign driver';
    case 'wave_bulk_assign_driver':
      return 'Bulk assign driver';
    default:
      return 'Pickup update';
  }
}

interface KvProps { k: string; v: ReactNode }
function Kv({ k, v }: KvProps) {
  return (
    <div style={{ display: 'flex', padding: '4px 0', borderBottom: '1px solid var(--line)', fontSize: '11.5px' }}>
      <span className="mono" style={{ color: 'var(--ink-3)', minWidth: '160px' }}>{k}</span>
      <span>{v}</span>
    </div>
  );
}

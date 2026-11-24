// warehouse.tsx — TS/React port of demo-v2/assets/js/modules/platform-warehouse.js
// Transfer kanban (planned → in transit → received → reconciled) +
// item manifest vs receive count + checkpoint scan sequence + exception holds.

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useResourceList,
  useCreateWarehouseTransferManifest,
  useRequestWarehouseScanCorrection,
  useScanEvent,
  useTransitionTask,
  useWarehouseTransferCheckpoint,
  useWarehouseTransferDispatch,
  useWarehouseTransferReconcileDestination,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import {
  getCommandRegistry,
  getLookups,
  lookupRow,
  progress_workflow_run_until_wait_v1,
  type WarehouseTransferCheckpointActionKey,
} from '@/lib/api';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { readUrlParam } from '@/lib/url-params';
import { fill, useI18n, type Translate } from '@/lib/i18n';

// W11-3 schema-drift remediation (PLATFORM §10) — TransferRow is now backed
// by the paired projection view `public.v_warehouse_transfer_summary`
// (supabase/migrations/202604301500_v_warehouse_transfer_summary.sql).
// All fields previously flagged REMOVE/RENAME on the canonical
// `warehouse_transfers` table are now canonical projections on the view:
//   • id              → warehouse_transfers.id
//   • transfer_code   → warehouse_transfers.transfer_code (canonical)
//   • from_branch_id  → warehouse_transfers.from_branch_id (canonical)
//   • to_branch_id    → warehouse_transfers.to_branch_id (canonical)
//   • item_count      → COUNT(warehouse_transfer_items)
//   • received_count  → COUNT(DISTINCT scan_events.shipment_id @ destination)
//   • variance_count  → item_count - received_count (clamped >= 0)
//   • variance_flag   → variance_count > 0 AND status post-arrival
//   • posted_at       → COALESCE(received_at, dispatched_at)
//   • hold_reason     → warehouse_transfers.metadata->>'hold_reason'
// FE-fictional `variance_pct` was dropped (derive client-side as
// (variance_count / item_count) * 100 when needed).
// Legacy aliases (transfer_id / origin_hub / destination_hub) are retained on
// the seed-mode projection so kanban label rendering stays stable until the
// rename pass lands.
interface TransferRow extends Record<string, unknown> {
  id: string;                            // SSOT: v_warehouse_transfer_summary.id
  transfer_code?: string;                // SSOT: v_warehouse_transfer_summary.transfer_code
  transfer_id?: string;                  // Legacy alias kept on seed for label rendering
  from_branch_id?: string;               // SSOT: v_warehouse_transfer_summary.from_branch_id
  to_branch_id?: string;                 // SSOT: v_warehouse_transfer_summary.to_branch_id
  origin_hub?: string;                   // Legacy alias for kanban rendering
  destination_hub?: string;              // Legacy alias for kanban rendering
  item_count: number;                    // SSOT: v_warehouse_transfer_summary.item_count
  received_count: number;                // SSOT: v_warehouse_transfer_summary.received_count
  variance_count?: number;               // SSOT: v_warehouse_transfer_summary.variance_count
  variance_flag?: boolean;               // SSOT: v_warehouse_transfer_summary.variance_flag
  hold_reason?: string;                  // SSOT: v_warehouse_transfer_summary.hold_reason
  posted_at?: string;                    // SSOT: v_warehouse_transfer_summary.posted_at
  status: string;                        // SSOT: warehouse_transfers.status
  dispatched_at?: string;                // SSOT: warehouse_transfers.dispatched_at
  received_at?: string;                  // SSOT: warehouse_transfers.received_at
  updated_at?: string;                   // SSOT: warehouse_transfers.updated_at
}

interface TransferItem {
  id: string;
  transfer_id: string;
  shipment_id: string;
  expected: number;
  received: number;
  status: string;
}

interface WarehouseTask extends Record<string, unknown> {
  id: string;
  task_id?: string;
  task_type?: string;
  task_type_key?: string;
  status: string;
  subject?: string;
  queue?: string;
  queue_key?: string;
  workflow_run_id?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface CheckpointScan {
  id: string;
  transfer_id: string;
  warehouse_transfer_id?: string | null;
  shipment_id: string;
  scan_type?: string;
  barcode?: string | null;
  checkpoint: string;
  sequence: number;
  occurred_at: string;
  user_id?: string;
  correction_of_scan_event_id?: string | null;
  correction_reason?: string | null;
  correction_approval_task_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ExceptionHold {
  id: string;
  transfer_id: string;
  kind: string;
  notes?: string;
  supervisor_approval_task_id?: string;
  created_at?: string;
}

interface BranchOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  name?: string;
  branch_name?: string;
  code?: string;
  city?: string;
  status?: string;
}

interface ShipmentManifestOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  tracking_number?: string;
  tracking?: string;
  client_ref?: string;
  recipient_name?: string;
  status?: string;
}

interface WarehouseSeed {
  warehouse_transfer_items: TransferItem[];
  warehouse_checkpoint_scans: CheckpointScan[];
  warehouse_exception_hold: ExceptionHold[];
}

interface WarehouseListSnapshot {
  transfers: TransferRow[];
  transferItems: TransferItem[];
  checkpointScans: CheckpointScan[];
  exceptionHolds: ExceptionHold[];
  warehouseTasks: WarehouseTask[];
}

interface WarehouseActionReadback {
  action: string;
  warehouse_transfer_id?: string | null;
  transfer_code?: string | null;
  transfer_status?: string | null;
  workflow_run_id?: string | null;
  workflow_status?: string | null;
  label?: string | null;
  count?: number | null;
  item_count?: number | null;
  scan_event_id?: string | null;
  correction_scan_event_id?: string | null;
  correction_approval_task_id?: string | null;
  status?: string | null;
}

// W54-D — kanban column order derives from the canonical
// `warehouse_transfer_status` lookup (rank-sorted) instead of an inline
// literal array. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT). Adding/
// reordering a stage is a row mutation, not a code change.
//
// W-Cycle-E2 (P1 #4) — Computed on each call (no module-top snapshot frozen
// at import time) so the lookup catalog can update post-bootstrap without
// the module losing its row.
function getKanbanColumns(): string[] {
  return getLookups('warehouse_transfer_status')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((r) => r.value);
}

function taskActionNextStatus(kind: string): string {
  const row = lookupRow('task_action_kind', kind) as
    | { next_status?: string; metadata?: { next_status?: string } }
    | null;
  return row?.next_status ?? row?.metadata?.next_status ?? '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'unknown error');
}

function branchLabel(row: BranchOptionRow): string {
  const name = row.name ?? row.branch_name ?? row.code ?? row.id;
  const suffix = [row.city, row.status].filter(Boolean).join(' - ');
  return suffix ? `${name} - ${suffix}` : name;
}

function shipmentManifestLabel(row: ShipmentManifestOptionRow): string {
  const tracking = row.tracking_number ?? row.tracking ?? row.id;
  const details = [row.recipient_name, row.client_ref, row.status].filter(Boolean).join(' - ');
  return details ? `${tracking} - ${details}` : tracking;
}

function defaultTransferCode(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `WTR-${stamp}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

interface CommandRegistryRow extends Record<string, unknown> {
  key: string;
  label?: string;
}

function commandLabel(key: string, fallback: string): string {
  const rows = getCommandRegistry() as CommandRegistryRow[];
  return rows.find((row) => row.key === key)?.label ?? fallback;
}

function parseNonNegativeInt(value: string, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return n;
}

interface CheckpointScanFormProps {
  label: string;
  onCancel: () => void;
  onSubmit: (payload: {
    barcode: string;
    handling_unit_code: string | null;
    notes: string | null;
  }) => Promise<void>;
}

function CheckpointScanForm({ label, onCancel, onSubmit }: CheckpointScanFormProps) {
  const { t } = useI18n();
  const [barcode, setBarcode] = useState('');
  const [handlingUnit, setHandlingUnit] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      setFormError(t('platformWarehouse.checkpointScanForm.scanBarcodeIsRequired'));
      pushToast(t('platformWarehouse.checkpointScanForm.scanBarcodeIsRequired'), 'warn');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({
        barcode: trimmedBarcode,
        handling_unit_code: handlingUnit.trim() || null,
        notes: notes.trim() || null,
      });
    } catch (err) {
      const message = errorMessage(err);
      setFormError(message);
      pushToast(fill(t('platformWarehouse.checkpointScanForm.checkpointScanFailed'), { message: String(message) }), 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form data-testid="warehouse-checkpoint-modal" onSubmit={submit}>
      <p className="state__hint" style={{ margin: '0 0 10px' }}>
        {t('platformWarehouse.checkpointScanForm.runsTheCheckpointScan')}
      </p>
      {formError ? (
        <div className="state state--error" role="alert" style={{ marginBottom: '10px' }}>
          {formError}
        </div>
      ) : null}
      <div className="field">
        <label className="field__label" htmlFor="warehouse-checkpoint-barcode">
          {t('platformWarehouse.checkpointScanForm.scanBarcode')}
        </label>
        <input
          id="warehouse-checkpoint-barcode"
          data-testid="warehouse-checkpoint-barcode"
          placeholder={t('platformWarehouse.checkpointScanForm.bag001Man001')}
          value={barcode}
          onChange={(event) => setBarcode(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="warehouse-checkpoint-handling-unit">
          {t('platformWarehouse.checkpointScanForm.handlingUnitCode')}
        </label>
        <input
          id="warehouse-checkpoint-handling-unit"
          data-testid="warehouse-checkpoint-handling-unit"
          placeholder={t('platformWarehouse.checkpointScanForm.optionalBagContainerCode')}
          value={handlingUnit}
          onChange={(event) => setHandlingUnit(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="warehouse-checkpoint-notes">
          {t('platformWarehouse.checkpointScanForm.notes')}
        </label>
        <textarea
          id="warehouse-checkpoint-notes"
          rows={3}
          data-testid="warehouse-checkpoint-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        <Button label={t('platformWarehouse.checkpointScanForm.cancel')} kind="ghost" onClick={onCancel} disabled={submitting} />
        <Button
          label={submitting ? t('platformWarehouse.checkpointScanForm.recordingScan') : label}
          iconName="scan"
          kind="primary"
          capability={CAP.WAREHOUSE_WRITE}
          type="submit"
          disabled={submitting}
        />
      </div>
    </form>
  );
}

interface ScanCorrectionFormProps {
  mode: 'request' | 'record';
  scan: CheckpointScan;
  defaultBarcode?: string | null;
  defaultReason?: string | null;
  onCancel: () => void;
  onSubmit: (payload: { corrected_barcode: string; correction_reason: string }) => Promise<void>;
}

function ScanCorrectionForm({
  mode,
  scan,
  defaultBarcode,
  defaultReason,
  onCancel,
  onSubmit,
}: ScanCorrectionFormProps) {
  const { t } = useI18n();
  const [barcode, setBarcode] = useState(defaultBarcode ?? scan.barcode ?? '');
  const [reason, setReason] = useState(defaultReason ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const correctedBarcode = barcode.trim();
    const correctionReason = reason.trim();
    if (!correctedBarcode) {
      setFormError(t('platformWarehouse.scanCorrectionForm.correctedBarcodeIsRequired'));
      pushToast(t('platformWarehouse.scanCorrectionForm.correctedBarcodeIsRequired'), 'warn');
      return;
    }
    if (!correctionReason) {
      setFormError(t('platformWarehouse.scanCorrectionForm.correctionReasonIsRequired'));
      pushToast(t('platformWarehouse.scanCorrectionForm.correctionReasonIsRequired'), 'warn');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({ corrected_barcode: correctedBarcode, correction_reason: correctionReason });
    } catch (err) {
      const message = errorMessage(err);
      setFormError(message);
      pushToast(fill(t('platformWarehouse.scanCorrectionForm.scanCorrectionFailed'), { message: String(message) }), 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form data-testid={`warehouse-scan-correction-${mode}-modal`} onSubmit={submit}>
      <p className="state__hint" style={{ margin: '0 0 10px' }}>
        {mode === 'request'
          ? t('platformWarehouse.scanCorrectionForm.createsASupervisorApproval')
          : t('platformWarehouse.scanCorrectionForm.completesTheApprovalTask')}
      </p>
      {formError ? (
        <div className="state state--error" role="alert" style={{ marginBottom: '10px' }}>
          {formError}
        </div>
      ) : null}
      <div className="field">
        <label className="field__label" htmlFor={`warehouse-scan-correction-barcode-${mode}`}>
          {t('platformWarehouse.scanCorrectionForm.correctedBarcode')}
        </label>
        <input
          id={`warehouse-scan-correction-barcode-${mode}`}
          data-testid="warehouse-scan-correction-barcode"
          value={barcode}
          onChange={(event) => setBarcode(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`warehouse-scan-correction-reason-${mode}`}>
          {t('platformWarehouse.scanCorrectionForm.correctionReason')}
        </label>
        <textarea
          id={`warehouse-scan-correction-reason-${mode}`}
          data-testid="warehouse-scan-correction-reason"
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        <Button label={t('platformWarehouse.scanCorrectionForm.cancel')} kind="ghost" onClick={onCancel} disabled={submitting} />
        <Button
          label={submitting ? t('platformWarehouse.scanCorrectionForm.savingCorrection') : mode === 'request' ? t('platformWarehouse.scanCorrectionForm.requestCorrection') : t('platformWarehouse.scanCorrectionForm.recordCorrection')}
          iconName="edit"
          kind="primary"
          capability={mode === 'request' ? CAP.WAREHOUSE_WRITE : CAP.TASKS_COMPLETE}
          type="submit"
          disabled={submitting}
        />
      </div>
    </form>
  );
}

function transferColumns(t: Translate): DataTableColumn<TransferRow>[] {
  return [
    // W11-3: bind to canonical view columns. Legacy aliases (transfer_id /
    // origin_hub / destination_hub) remain on the seed-mode projection so
    // existing saved-view selectors keep resolving until the rename pass lands.
    { key: 'transfer_code', label: t('platformWarehouse.warehouseModule.colTransfer'), mono: true, sortable: true, filterable: true },
    { key: 'from_branch_id', label: t('platformWarehouse.warehouseModule.colOrigin'), sortable: true, filterable: true },
    { key: 'to_branch_id', label: t('platformWarehouse.warehouseModule.colDestination'), sortable: true, filterable: true },
    { key: 'item_count', label: t('platformWarehouse.warehouseModule.colItems'), align: 'right', sortable: true, type: 'number' },
    { key: 'received_count', label: t('platformWarehouse.warehouseModule.colReceived'), align: 'right', sortable: true, type: 'number' },
    { key: 'variance_count', label: t('platformWarehouse.warehouseModule.colVariance'), align: 'right', sortable: true, type: 'number' },
    {
      key: 'status',
      label: t('platformWarehouse.warehouseModule.colStatus'),
      lookup: 'warehouse_transfer_status',
      sortable: true,
      filterable: true,
      editable: false,
    },
    { key: 'posted_at', label: t('platformWarehouse.warehouseModule.colPosted'), format: 'datetime', sortable: true },
    { key: 'updated_at', label: t('platformWarehouse.warehouseModule.colUpdated'), format: 'datetime', sortable: true },
  ];
}

function itemColumns(t: Translate): DataTableColumn<TransferItem & Record<string, unknown>>[] {
  return [
    { key: 'shipment_id', label: t('platformWarehouse.warehouseModule.itemColShipment'), mono: true },
    { key: 'expected', label: t('platformWarehouse.warehouseModule.itemColExpected'), align: 'right' },
    { key: 'received', label: t('platformWarehouse.warehouseModule.itemColReceived'), align: 'right' },
    { key: 'status', label: t('platformWarehouse.warehouseModule.itemColStatus') },
  ];
}

function scanColumns(t: Translate): DataTableColumn<CheckpointScan & Record<string, unknown>>[] {
  return [
    { key: 'scan_type', label: t('platformWarehouse.warehouseModule.scanColType') },
    { key: 'sequence', label: '#', align: 'right' },
    { key: 'checkpoint', label: t('platformWarehouse.warehouseModule.scanColCheckpoint') },
    { key: 'barcode', label: t('platformWarehouse.warehouseModule.scanColBarcode'), mono: true },
    { key: 'shipment_id', label: t('platformWarehouse.warehouseModule.scanColShipment'), mono: true },
    { key: 'correction_reason', label: t('platformWarehouse.warehouseModule.scanColCorrectionReason') },
    { key: 'occurred_at', label: t('platformWarehouse.warehouseModule.scanColWhen'), format: 'datetime' },
  ];
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        padding: '4px 0',
        borderBottom: '1px solid var(--line)',
        fontSize: '11.5px',
      }}
    >
      <span className="mono" style={{ color: 'var(--ink-3)', minWidth: '140px' }}>
        {k}
      </span>
      <span>{v}</span>
    </div>
  );
}

function readbackString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function metadataRecord(row: { metadata?: Record<string, unknown> | null }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function warehouseTaskType(task: WarehouseTask): string {
  const metadata = metadataRecord(task);
  return (
    readbackString(task.task_type_key) ??
    readbackString(task.task_type) ??
    readbackString(metadata.task_type_key) ??
    readbackString(metadata.task_type) ??
    ''
  );
}

function warehouseTaskWorkflowRunId(task: WarehouseTask): string | null {
  const metadata = metadataRecord(task);
  return (
    readbackString(task.workflow_run_id) ??
    readbackString(metadata.parent_workflow_run_id) ??
    readbackString(metadata.workflow_run_id)
  );
}

function warehouseTaskLabel(task: WarehouseTask): string {
  const type = warehouseTaskType(task);
  const row = type ? lookupRow('task_type', type) : null;
  return row?.label ?? (type ? type.replace(/_/g, ' ') : 'Warehouse task');
}

function isActiveWarehouseTask(task: WarehouseTask): boolean {
  return ['open', 'assigned', 'pending', 'in_progress'].includes(String(task.status ?? '').toLowerCase());
}

function scanCorrectionTaskMetadata(task: WarehouseTask): Record<string, unknown> {
  const metadata = metadataRecord(task);
  return objectRecord(metadata.scan_correction);
}

function scanCorrectionTaskOriginalScanId(task: WarehouseTask): string | null {
  const metadata = metadataRecord(task);
  const correction = scanCorrectionTaskMetadata(task);
  return (
    readbackString(task.resource_id) ??
    readbackString(correction.original_scan_event_id) ??
    readbackString(correction.scan_event_id) ??
    readbackString(metadata.original_scan_event_id) ??
    readbackString(metadata.correction_of_scan_event_id)
  );
}

function exceptionHoldsFromTasks(tasks: WarehouseTask[]): ExceptionHold[] {
  return tasks
    .filter((task) => warehouseTaskType(task) === 'warehouse_supervisor_approval' && isActiveWarehouseTask(task))
    .map((task): ExceptionHold | null => {
      const metadata = metadataRecord(task);
      const transferId =
        readbackString(task.resource_id) ??
        readbackString(metadata.resource_id) ??
        readbackString(metadata.warehouse_transfer_id) ??
        readbackString(metadata.transfer_id);
      if (!transferId) return null;
      return {
        id: `task:${task.id}`,
        transfer_id: transferId,
        kind:
          readbackString(metadata.kind) ??
          readbackString(metadata.reason) ??
          'supervisor_approval',
        notes:
          readbackString(metadata.notes) ??
          readbackString(metadata.hold_reason) ??
          readbackString(task.subject) ??
          undefined,
        supervisor_approval_task_id: task.id,
        created_at: readbackString(task.created_at) ?? undefined,
      };
    })
    .filter((hold): hold is ExceptionHold => hold !== null);
}

function warehouseActionReadbackFrom(
  action: string,
  payload: Record<string, unknown>,
  fallback: Partial<WarehouseActionReadback> = {},
): WarehouseActionReadback {
  return {
    action,
    warehouse_transfer_id: readbackString(payload.warehouse_transfer_id) ?? readbackString(payload.transfer_id) ?? fallback.warehouse_transfer_id ?? null,
    transfer_code: readbackString(payload.transfer_code) ?? fallback.transfer_code ?? null,
    transfer_status: readbackString(payload.transfer_status) ?? fallback.transfer_status ?? null,
    workflow_run_id: readbackString(payload.workflow_run_id) ?? fallback.workflow_run_id ?? null,
    workflow_status: readbackString(payload.workflow_status) ?? (readbackString(payload.status)?.startsWith('workflow_') ? readbackString(payload.status) : null) ?? fallback.workflow_status ?? null,
    label: fallback.label ?? null,
    count: typeof payload.count === 'number' ? payload.count : fallback.count ?? null,
    item_count: typeof payload.item_count === 'number' ? payload.item_count : fallback.item_count ?? null,
    scan_event_id: readbackString(payload.scan_event_id) ?? fallback.scan_event_id ?? null,
    correction_scan_event_id: readbackString(payload.correction_scan_event_id) ?? fallback.correction_scan_event_id ?? null,
    correction_approval_task_id: readbackString(payload.correction_approval_task_id) ?? fallback.correction_approval_task_id ?? null,
    status: readbackString(payload.status) ?? fallback.status ?? null,
  };
}

function WarehouseActionReadbackPanel({ readback }: { readback: WarehouseActionReadback | null }) {
  const { t } = useI18n();
  if (!readback) return null;
  return (
    <div className="card" data-testid="warehouse-action-readback" style={{ marginBottom: '10px' }}>
      <div className="dt-toolbar">
        <span className="eyebrow">{t('platformWarehouse.warehouseActionReadbackPanel.actionConfirmation')}</span>
        <Chip label={readback.action} size="xs" kind="good" />
        {readback.status ? <Chip label={readback.status} size="xs" /> : null}
      </div>
      <div className="form-grid form-grid--3" style={{ marginTop: '8px' }}>
        <Kv k="Transfer" v={<span className="mono">{readback.transfer_code ?? readback.warehouse_transfer_id ?? t('platformWarehouse.warehouseActionReadbackPanel.pending')}</span>} />
        <Kv k="Transfer status" v={<span className="mono">{readback.transfer_status ?? t('platformWarehouse.warehouseActionReadbackPanel.pending')}</span>} />
        <Kv k="Workflow" v={<span className="mono">{readback.workflow_run_id ?? t('platformWarehouse.warehouseActionReadbackPanel.notStarted')}</span>} />
        {readback.workflow_status ? <Kv k="Workflow status" v={<span className="mono">{readback.workflow_status}</span>} /> : null}
        {readback.item_count != null ? <Kv k="Items" v={<span className="mono">{readback.item_count}</span>} /> : null}
        {readback.scan_event_id ? <Kv k="Scan event" v={<span className="mono">{readback.scan_event_id}</span>} /> : null}
        {readback.correction_scan_event_id ? <Kv k="Correction scan" v={<span className="mono">{readback.correction_scan_event_id}</span>} /> : null}
        {readback.correction_approval_task_id ? <Kv k="Correction task" v={<span className="mono">{readback.correction_approval_task_id}</span>} /> : null}
      </div>
    </div>
  );
}

export function WarehouseModule() {
  const { t } = useI18n();
  const transferTableColumns = useMemo(() => transferColumns(t), [t]);
  const itemTableColumns = useMemo(() => itemColumns(t), [t]);
  const scanTableColumns = useMemo(() => scanColumns(t), [t]);
  const canRead = useCapability(CAP.WAREHOUSE_READ);
  const canWriteWarehouse = useCapability(CAP.WAREHOUSE_WRITE);
  const canCompleteTasks = useCapability(CAP.TASKS_COMPLETE);
  const { scope, currentTenantId } = useIdentity();
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const drawer = useDrawer();
  const modal = useModal();
  const openedFocusRef = useRef<string | null>(null);
  const [openTransferId, setOpenTransferId] = useState<string | null>(null);
  const [lastActionReadback, setLastActionReadback] = useState<WarehouseActionReadback | null>(null);
  const [completedWarehouseTaskOverrides, setCompletedWarehouseTaskOverrides] = useState<
    Record<string, Partial<Pick<WarehouseTask, 'status' | 'status_reason'>>>
  >({});
  // W11-3 — read seam pinned to `warehouse_transfer_summary`, the paired
  // projection view (public.v_warehouse_transfer_summary, migration
  // 202604301500). The view derives the FE-shaped aggregates (item_count,
  // received_count, variance_count, variance_flag, posted_at, hold_reason)
  // from warehouse_transfers + warehouse_transfer_items + scan_events so the
  // module never reads non-canonical columns from the SSOT table directly.
  // Mutations stay on transition_warehouse_transfer_v1 /
  // warehouse_transfer_execute_v1 / record_scan_event_v1.
  const warehouseReadQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const transfersQuery = useResourceList<TransferRow>(
    'warehouse_transfer_summary',
    undefined,
    warehouseReadQueryOptions,
  );
  // W56-B-2 closure (F6) — `api.seed.warehouseSeed()` migrated to canonical
  // `useResourceList<T>('<resource_key>')` for warehouse detail projections.
  // Exception holds are task projections, not a standalone registry resource:
  // derive them from the backend-backed `tasks` read so live mode never calls a
  // seed-only `warehouse_exception_hold` key.
  const transferItemsQuery = useResourceList<TransferItem>(
    'warehouse_transfer_items',
    undefined,
    warehouseReadQueryOptions,
  );
  const checkpointScansQuery = useResourceList<CheckpointScan>(
    'warehouse_checkpoint_scans',
    undefined,
    warehouseReadQueryOptions,
  );
  const warehouseTasksQuery = useResourceList<WarehouseTask>(
    'tasks',
    { page_size: 200 },
    warehouseReadQueryOptions,
  );
  const createManifestMutation = useCreateWarehouseTransferManifest();
  const requestScanCorrectionMutation = useRequestWarehouseScanCorrection();
  const scanEventMutation = useScanEvent();
  const transitionTask = useTransitionTask();
  const dispatchTransferMutation = useWarehouseTransferDispatch();
  const checkpointMutation = useWarehouseTransferCheckpoint();
  const reconcileDestinationMutation = useWarehouseTransferReconcileDestination();
  const transfers = useMemo(() => transfersQuery.data?.rows ?? [], [transfersQuery.data]);
  const warehouseTasks = useMemo(
    () =>
      (warehouseTasksQuery.data?.rows ?? []).map((task) =>
        completedWarehouseTaskOverrides[task.id]
          ? { ...task, ...completedWarehouseTaskOverrides[task.id] }
          : task,
      ),
    [warehouseTasksQuery.data, completedWarehouseTaskOverrides],
  );
  const taskBackedExceptionHolds = useMemo(
    () => exceptionHoldsFromTasks(warehouseTasks),
    [warehouseTasks],
  );

  const seed = useMemo<WarehouseSeed | null>(() => {
    if (transferItemsQuery.isLoading || checkpointScansQuery.isLoading || warehouseTasksQuery.isLoading) {
      return null;
    }
    return {
      warehouse_transfer_items: transferItemsQuery.data?.rows ?? [],
      warehouse_checkpoint_scans: checkpointScansQuery.data?.rows ?? [],
      warehouse_exception_hold: taskBackedExceptionHolds,
    };
  }, [
    transferItemsQuery.isLoading,
    transferItemsQuery.data,
    checkpointScansQuery.isLoading,
    checkpointScansQuery.data,
    warehouseTasksQuery.isLoading,
    taskBackedExceptionHolds,
  ]);

  async function refetchWarehouseLists(): Promise<WarehouseListSnapshot> {
    const [
      transfersResult,
      transferItemsResult,
      checkpointScansResult,
      warehouseTasksResult,
    ] = await Promise.all([
      transfersQuery.refetch(),
      transferItemsQuery.refetch(),
      checkpointScansQuery.refetch(),
      warehouseTasksQuery.refetch(),
    ]);
    const refreshedTasks = warehouseTasksResult.data?.rows ?? [];
    return {
      transfers: transfersResult.data?.rows ?? [],
      transferItems: transferItemsResult.data?.rows ?? [],
      checkpointScans: checkpointScansResult.data?.rows ?? [],
      exceptionHolds: exceptionHoldsFromTasks(refreshedTasks),
      warehouseTasks: refreshedTasks,
    };
  }

  async function refetchWarehouseListsUntil(
    predicate: (snapshot: WarehouseListSnapshot) => boolean,
    attempts = 5,
  ): Promise<WarehouseListSnapshot> {
    let snapshot = await refetchWarehouseLists();
    for (let attempt = 1; attempt < attempts && !predicate(snapshot); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      snapshot = await refetchWarehouseLists();
    }
    return snapshot;
  }

  const kanbanColumns = useMemo(() => getKanbanColumns(), []);
  const grouped = useMemo<Record<string, TransferRow[]>>(() => {
    const m: Record<string, TransferRow[]> = {};
    kanbanColumns.forEach((s) => (m[s] = []));
    for (const entry of transfers) {
      (m[entry.status] = m[entry.status] || []).push(entry);
    }
    return m;
  }, [transfers, kanbanColumns]);

  // W35e-4 — canonical jsonb envelope per
  // supabase/migrations/202601261740_warehouse_transfer_reconcile_finalize_v1.sql.
  // The canonical RPC reads `p_input->>'warehouse_transfer_id'` and
  // `p_input->>'to_status'`. Closes REAUDIT3/PLATFORM.md P1-1.
  const tasksForTransfer = (transferId: string): WarehouseTask[] =>
    warehouseTasks
      .filter((task) => task.resource_id === transferId || metadataRecord(task).resource_id === transferId)
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  const activeTaskForType = (transferId: string, taskType: string): WarehouseTask | null =>
    tasksForTransfer(transferId).find(
      (task) => warehouseTaskType(task) === taskType && isActiveWarehouseTask(task),
    ) ?? null;

  const supervisorApprovalTaskForTransfer = (transferId: string): WarehouseTask | null => {
    const directTask = activeTaskForType(transferId, 'warehouse_supervisor_approval');
    if (directTask) return directTask;
    const holdTaskId = seed?.warehouse_exception_hold.find((h) => h.transfer_id === transferId)?.supervisor_approval_task_id;
    if (!holdTaskId) return null;
    return warehouseTasks.find(
      (task) =>
        task.id === holdTaskId &&
        warehouseTaskType(task) === 'warehouse_supervisor_approval' &&
        isActiveWarehouseTask(task),
    ) ?? null;
  };

  const completeWarehouseTask = async (transferId: string, task: WarehouseTask) => {
    if (!canCompleteTasks) {
      pushToast(t('platformWarehouse.warehouseModule.taskCompletionPermissionRequired'), 'warn');
      return;
    }
    const nextStatus = taskActionNextStatus('resolve');
    if (!nextStatus) {
      pushToast(t('platformWarehouse.warehouseModule.resolveStatusIsNot'), 'danger');
      return;
    }
    const workflowRunId = warehouseTaskWorkflowRunId(task);
    const payload = {
      warehouse_transfer_id: transferId,
      source: 'console_v2.warehouse.transfer_drawer',
      task_type_key: warehouseTaskType(task),
    };
    try {
      const result = await transitionTask.mutateAsync({
        taskId: task.id,
        transition: {
          next_status: nextStatus,
          action_kind: 'resolve',
          payload,
        },
      });
      let progressResult: Record<string, unknown> = {};
      if (workflowRunId) {
        progressResult = objectRecord(
          await progress_workflow_run_until_wait_v1(
            workflowRunId,
            {
              ...payload,
              completed_task_id: task.id,
              task_id: task.id,
              task_action_kind: 'resolve',
              task_payload: payload,
            },
            { budget_ms: 5000, max_steps: 8 },
          ),
        );
      }
      await refetchWarehouseLists();
      setLastActionReadback(warehouseActionReadbackFrom('task_completed', {
        ...objectRecord(result),
        ...progressResult,
      }, {
        warehouse_transfer_id: transferId,
        workflow_run_id: workflowRunId,
        workflow_status: readbackString(progressResult.status) ?? readbackString(progressResult.workflow_status),
        status: 'task_completed',
      }));
      pushToast(`${warehouseTaskLabel(task)} completed`, 'good');
    } catch (err) {
      pushToast(fill(t('platformWarehouse.warehouseModule.taskCompletionFailed'), { value: String(errorMessage(err)) }), 'danger');
    }
  };

  const dispatchTransfer = async (entry: TransferRow) => {
    if (!canWriteWarehouse) {
      pushToast(t('platformWarehouse.warehouseModule.warehouseUpdatePermissionRequired'), 'warn');
      return;
    }
    try {
      const result = await dispatchTransferMutation.mutateAsync({ warehouse_transfer_id: entry.id });
      await refetchWarehouseLists();
      setLastActionReadback(warehouseActionReadbackFrom('dispatch', result, {
        warehouse_transfer_id: entry.id,
        transfer_code: entry.transfer_code ?? entry.transfer_id ?? entry.id,
        transfer_status: entry.status,
      }));
      pushToast(fill(t('platformWarehouse.warehouseModule.dispatchStartedFor'), { value: String(entry.transfer_code ?? entry.id) }), 'good');
    } catch (err) {
      pushToast(fill(t('platformWarehouse.warehouseModule.dispatchWorkflowFailed'), { value: String(errorMessage(err)) }), 'danger');
    }
  };

  const openCreateManifestModal = () => {
    function ManifestCreateForm() {
      const { t } = useI18n();
      const manifestListOpts = useMemo(
        () => ({
          page_size: 100,
          ...(tenantId ? { filter: { organization_id: tenantId } } : {}),
        }),
        [tenantId],
      );
      const manifestBranchesQuery = useResourceList<BranchOptionRow>('branches', manifestListOpts);
      const manifestShipmentsQuery = useResourceList<ShipmentManifestOptionRow>('shipments', manifestListOpts);
      const branchOptions = useMemo(
        () =>
          (manifestBranchesQuery.data?.rows ?? []).filter(
            (row) => !tenantId || !row.organization_id || row.organization_id === tenantId,
          ),
        [manifestBranchesQuery.data, tenantId],
      );
      const shipmentOptions = useMemo(
        () =>
          (manifestShipmentsQuery.data?.rows ?? []).filter(
            (row) => !tenantId || !row.organization_id || row.organization_id === tenantId,
          ),
        [manifestShipmentsQuery.data, tenantId],
      );
      const [draft, setDraft] = useState({
        transfer_code: defaultTransferCode(),
        from_branch_id: '',
        to_branch_id: '',
        shipment_ids: [] as string[],
        notes: '',
      });
      const [formError, setFormError] = useState<string | null>(null);
      useEffect(() => {
        setDraft((current) => {
          if (current.from_branch_id || branchOptions.length === 0) return current;
          const fromBranch = branchOptions[0]?.id ?? '';
          const toBranch = branchOptions.find((branch) => branch.id !== fromBranch)?.id ?? '';
          return {
            ...current,
            from_branch_id: fromBranch,
            to_branch_id: toBranch,
          };
        });
      }, [branchOptions]);
      const toggleShipment = (shipmentId: string, checked: boolean) => {
        setDraft((current) => {
          const nextIds = checked
            ? Array.from(new Set([...current.shipment_ids, shipmentId]))
            : current.shipment_ids.filter((id) => id !== shipmentId);
          return { ...current, shipment_ids: nextIds };
        });
      };
      const canCreate =
        draft.transfer_code.trim() &&
        draft.from_branch_id &&
        draft.to_branch_id &&
        draft.from_branch_id !== draft.to_branch_id &&
        draft.shipment_ids.length > 0 &&
        !createManifestMutation.isPending;

      return (
        <div data-testid="warehouse-manifest-create-modal">
          <p className="state__hint" style={{ margin: '0 0 12px' }}>
            {t('platformWarehouse.manifestCreateForm.buildADraftTransfer')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '150px 1fr',
              gap: '8px',
              alignItems: 'center',
            }}
          >
            <label className="mono" htmlFor="warehouse-manifest-code">{t('platformWarehouse.manifestCreateForm.transferCode')}</label>
            <input
              id="warehouse-manifest-code"
              data-testid="warehouse-manifest-transfer-code"
              className="dt-inline-input"
              value={draft.transfer_code}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  transfer_code: e.target.value.toUpperCase(),
                }))
              }
            />
            <label className="mono" htmlFor="warehouse-manifest-origin">{t('platformWarehouse.manifestCreateForm.originBranch')}</label>
            <select
              id="warehouse-manifest-origin"
              data-testid="warehouse-manifest-from-branch"
              className="dt-inline-input"
              value={draft.from_branch_id}
              onChange={(e) =>
                setDraft((current) => ({ ...current, from_branch_id: e.target.value }))
              }
            >
              <option value="">{t('platformWarehouse.manifestCreateForm.chooseOrigin')}</option>
              {branchOptions.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branchLabel(branch)}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor="warehouse-manifest-destination">{t('platformWarehouse.manifestCreateForm.destinationBranch')}</label>
            <select
              id="warehouse-manifest-destination"
              data-testid="warehouse-manifest-to-branch"
              className="dt-inline-input"
              value={draft.to_branch_id}
              onChange={(e) =>
                setDraft((current) => ({ ...current, to_branch_id: e.target.value }))
              }
            >
              <option value="">{t('platformWarehouse.manifestCreateForm.chooseDestination')}</option>
              {branchOptions.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branchLabel(branch)}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="section-eyebrow">{t('platformWarehouse.manifestCreateForm.shipmentManifest')}</div>
            {manifestShipmentsQuery.isLoading ? (
              <StateView kind="loading" />
            ) : shipmentOptions.length === 0 ? (
              <StateView kind="empty" title={t('platformWarehouse.manifestCreateForm.noShipmentsAvailable')} hint={t('platformWarehouse.manifestCreateForm.createOrImportShipments')} />
            ) : (
              <div
                className="dt"
                data-testid="warehouse-manifest-shipment-list"
                style={{ maxHeight: 220, overflow: 'auto' }}
              >
                <table className="dt__table">
                  <thead>
                    <tr>
                      <th>{t('platformWarehouse.manifestCreateForm.select')}</th>
                      <th>{t('platformWarehouse.manifestCreateForm.shipment')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipmentOptions.map((shipment) => (
                      <tr key={shipment.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={fill(t('platformWarehouse.manifestCreateForm.selectShipment'), { value: String(shipmentManifestLabel(shipment)) })}
                            data-testid={`warehouse-manifest-shipment-${shipment.id}`}
                            checked={draft.shipment_ids.includes(shipment.id)}
                            onChange={(e) => toggleShipment(shipment.id, e.target.checked)}
                          />
                        </td>
                        <td>{shipmentManifestLabel(shipment)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label" htmlFor="warehouse-manifest-notes">{t('platformWarehouse.manifestCreateForm.notes')}</label>
            <textarea
              id="warehouse-manifest-notes"
              data-testid="warehouse-manifest-notes"
              rows={3}
              value={draft.notes}
              onChange={(e) => setDraft((current) => ({ ...current, notes: e.target.value }))}
            />
          </div>

          {draft.from_branch_id && draft.to_branch_id && draft.from_branch_id === draft.to_branch_id ? (
            <p className="state__hint" role="alert">
              {t('platformWarehouse.manifestCreateForm.originAndDestinationMust')}
            </p>
          ) : null}

          {formError ? (
            <StateView kind="error" title={t('platformWarehouse.manifestCreateForm.createManifestFailed')} hint={formError} />
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <Button label={t('platformWarehouse.manifestCreateForm.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('platformWarehouse.manifestCreateForm.createManifest')}
              iconName="plus"
              kind="primary"
              capability={CAP.WAREHOUSE_WRITE}
              disabled={!canCreate}
              onClick={async () => {
                setFormError(null);
                try {
                  const result = await createManifestMutation.mutateAsync({
                    transfer_code: draft.transfer_code.trim(),
                    from_branch_id: draft.from_branch_id,
                    to_branch_id: draft.to_branch_id,
                    shipment_ids: draft.shipment_ids,
                    ...(tenantId ? { organization_id: tenantId } : {}),
                    metadata: {
                      source: 'console_v2.warehouse.manifest_create',
                      notes: draft.notes.trim() || null,
                    },
                  });
                  await refetchWarehouseLists();
                  setLastActionReadback(warehouseActionReadbackFrom('manifest_created', result, {
                    transfer_code: result.transfer_code,
                    warehouse_transfer_id: result.warehouse_transfer_id,
                    transfer_status: readbackString((result as Record<string, unknown>).transfer_status) ?? 'draft',
                    item_count: result.item_count,
                  }));
                  pushToast(fill(t('platformWarehouse.manifestCreateForm.transferManifestCreated'), { transfer_code: String(result.transfer_code) }), 'good');
                  modal.close();
                } catch (err) {
                  const message = errorMessage(err);
                  setFormError(message);
                  pushToast(fill(t('platformWarehouse.manifestCreateForm.createManifestFailed2'), { message: String(message) }), 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({
      title: t('platformWarehouse.warehouseModule.createTransferManifest'),
      body: <ManifestCreateForm />,
    });
  };

  const openCheckpointModal = (entry: TransferRow, actionKey: WarehouseTransferCheckpointActionKey) => {
    const label = commandLabel(
      actionKey,
      actionKey === 'warehouse_transfers.scan_departure' ? 'Scan departure' : 'Scan arrival',
    );
    modal.open({
      title: `${label} - ${entry.transfer_code ?? entry.transfer_id ?? entry.id}`,
      body: (
        <CheckpointScanForm
          label={label}
          onCancel={() => modal.close()}
          onSubmit={async (payload) => {
            const result = await checkpointMutation.mutateAsync({
              action_key: actionKey,
              warehouse_transfer_id: entry.id,
              barcode: payload.barcode,
              handling_unit_code: payload.handling_unit_code,
              notes: payload.notes,
            });
            await refetchWarehouseLists();
            setLastActionReadback(warehouseActionReadbackFrom(actionKey, result, {
              warehouse_transfer_id: entry.id,
              transfer_code: entry.transfer_code ?? entry.transfer_id ?? entry.id,
              transfer_status: readbackString((result as Record<string, unknown>).transfer_status) ?? entry.status,
              scan_event_id: readbackString(result.scan_event_id),
            }));
            pushToast(fill(t('platformWarehouse.warehouseModule.checkpointScanRecorded'), { label: String(label) }), 'good');
            modal.close();
          }}
        />
      ),
    });
  };

  const openScanCorrectionRequestModal = (transfer: TransferRow, scan: CheckpointScan) => {
    modal.open({
      title: fill(t('platformWarehouse.warehouseModule.requestScanCorrection'), { value: String(scan.barcode ?? scan.id) }),
      body: (
        <ScanCorrectionForm
          mode="request"
          scan={scan}
          defaultBarcode={scan.barcode}
          onCancel={() => modal.close()}
          onSubmit={async (payload) => {
            const result = await requestScanCorrectionMutation.mutateAsync({
              scan_event_id: scan.id,
              correction_reason: payload.correction_reason,
              corrected_barcode: payload.corrected_barcode,
            });
            const refreshed = await refetchWarehouseListsUntil((snapshot) =>
              snapshot.warehouseTasks.some(
                (task) =>
                  warehouseTaskType(task) === 'warehouse_scan_supervisor_approval' &&
                  scanCorrectionTaskOriginalScanId(task) === scan.id &&
                  isActiveWarehouseTask(task),
              ),
            );
            const refreshedTransfer = refreshed.transfers.find((row) => row.id === transfer.id) ?? transfer;
            if (drawer.isOpen) {
              openTransferDrawer(refreshedTransfer, refreshed);
            }
            setLastActionReadback(warehouseActionReadbackFrom('request_scan_correction', objectRecord(result), {
              warehouse_transfer_id: transfer.id,
              transfer_code: transfer.transfer_code ?? transfer.transfer_id ?? transfer.id,
              transfer_status: refreshedTransfer.status,
              scan_event_id: scan.id,
              correction_approval_task_id: readbackString((result as Record<string, unknown>).task_id),
              status: readbackString((result as Record<string, unknown>).status) ?? 'requested',
            }));
            pushToast(t('platformWarehouse.warehouseModule.scanCorrectionApprovalRequested'), 'good');
            modal.close();
          }}
        />
      ),
    });
  };

  const openScanCorrectionRecordModal = (
    transfer: TransferRow,
    scan: CheckpointScan,
    task: WarehouseTask,
  ) => {
    const correction = scanCorrectionTaskMetadata(task);
    modal.open({
      title: fill(t('platformWarehouse.warehouseModule.recordScanCorrection'), { value: String(scan.barcode ?? scan.id) }),
      body: (
        <ScanCorrectionForm
          mode="record"
          scan={scan}
          defaultBarcode={readbackString(correction.corrected_barcode) ?? scan.barcode}
          defaultReason={readbackString(correction.correction_reason)}
          onCancel={() => modal.close()}
          onSubmit={async (payload) => {
            const nextStatus = taskActionNextStatus('approve');
            if (!nextStatus) {
              throw new Error('Approval status is not configured for scan correction');
            }
            const transitionResult = await transitionTask.mutateAsync({
              taskId: task.id,
              transition: {
                next_status: nextStatus,
                action_kind: 'approve',
                status_reason: 'warehouse scan correction approved',
                payload: {
                  source: 'console_v2.warehouse.scan_correction_approval',
                  task_type_key: warehouseTaskType(task),
                  scan_event_id: scan.id,
                  warehouse_transfer_id: transfer.id,
                  corrected_barcode: payload.corrected_barcode,
                  correction_reason: payload.correction_reason,
                },
              },
            });
            const correctionResult = await scanEventMutation.mutateAsync({
              scan_type: 'correction',
              barcode: payload.corrected_barcode,
              warehouse_transfer_id: transfer.id,
              correction_of_scan_event_id: scan.id,
              correction_reason: payload.correction_reason,
              correction_approval_task_id: task.id,
              metadata: {
                source: 'console_v2.warehouse.scan_correction_record',
                original_scan_event_id: scan.id,
                approval_task_id: task.id,
              },
            });
            const refreshed = await refetchWarehouseListsUntil((snapshot) =>
              snapshot.checkpointScans.some((row) => row.correction_of_scan_event_id === scan.id),
            );
            const refreshedTransfer = refreshed.transfers.find((row) => row.id === transfer.id) ?? transfer;
            if (drawer.isOpen) {
              openTransferDrawer(refreshedTransfer, refreshed);
            }
            const correctionRecord = objectRecord(correctionResult);
            setLastActionReadback(warehouseActionReadbackFrom('record_scan_correction', correctionRecord, {
              warehouse_transfer_id: transfer.id,
              transfer_code: transfer.transfer_code ?? transfer.transfer_id ?? transfer.id,
              transfer_status: refreshedTransfer.status,
              scan_event_id: scan.id,
              correction_scan_event_id: readbackString(correctionRecord.scan_event_id),
              correction_approval_task_id: task.id,
              status: readbackString(objectRecord(transitionResult).status) ?? 'correction_recorded',
            }));
            pushToast(t('platformWarehouse.warehouseModule.scanCorrectionRecorded'), 'good');
            modal.close();
          }}
        />
      ),
    });
  };

  const openReconcileModal = (entry: TransferRow) => {
    let received = String(entry.received_count ?? 0);
    let damaged = '0';
    let missing = String(entry.variance_count ?? 0);
    let unmanifested = '0';
    let notes = '';
    const label = commandLabel('warehouse_transfers.reconcile_destination', 'Reconcile transfer');
    modal.open({
      title: `${label} - ${entry.transfer_code ?? entry.transfer_id ?? entry.id}`,
      body: (
        <div data-testid="warehouse-reconcile-modal">
          <p className="state__hint" style={{ margin: '0 0 10px' }}>
            {t('platformWarehouse.warehouseModule.runsTheDestinationReconciliation')}
          </p>
          <div className="field">
            <label className="field__label">{t('platformWarehouse.warehouseModule.receivedShipmentCount')}</label>
            <input
              data-testid="warehouse-reconcile-received"
              type="number"
              min="0"
              defaultValue={received}
              onChange={(e) => {
                received = e.target.value;
              }}
            />
          </div>
          <div className="field">
            <label className="field__label">{t('platformWarehouse.warehouseModule.damagedShipmentCount')}</label>
            <input
              data-testid="warehouse-reconcile-damaged"
              type="number"
              min="0"
              defaultValue={damaged}
              onChange={(e) => {
                damaged = e.target.value;
              }}
            />
          </div>
          <div className="field">
            <label className="field__label">{t('platformWarehouse.warehouseModule.missingShipmentCount')}</label>
            <input
              data-testid="warehouse-reconcile-missing"
              type="number"
              min="0"
              defaultValue={missing}
              onChange={(e) => {
                missing = e.target.value;
              }}
            />
          </div>
          <div className="field">
            <label className="field__label">{t('platformWarehouse.warehouseModule.unmanifestedShipmentCount')}</label>
            <input
              data-testid="warehouse-reconcile-unmanifested"
              type="number"
              min="0"
              defaultValue={unmanifested}
              onChange={(e) => {
                unmanifested = e.target.value;
              }}
            />
          </div>
          <div className="field">
            <label className="field__label">{t('platformWarehouse.warehouseModule.reconcileNotes')}</label>
            <textarea
              rows={3}
              data-testid="warehouse-reconcile-notes"
              onChange={(e) => {
                notes = e.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformWarehouse.warehouseModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={label}
            iconName="check"
            kind="primary"
            capability={CAP.WAREHOUSE_WRITE}
            onClick={async () => {
              try {
                const result = await reconcileDestinationMutation.mutateAsync({
                  warehouse_transfer_id: entry.id,
                  received_shipment_count: parseNonNegativeInt(received, 'Received shipment count'),
                  damaged_shipment_count: parseNonNegativeInt(damaged, 'Damaged shipment count'),
                  missing_shipment_count: parseNonNegativeInt(missing, 'Missing shipment count'),
                  unmanifested_shipment_count: parseNonNegativeInt(unmanifested, 'Unmanifested shipment count'),
                  reconcile_notes: notes.trim() || null,
                });
                const refreshed = await refetchWarehouseListsUntil((snapshot) => {
                  const nextTransfer = snapshot.transfers.find((row) => row.id === entry.id);
                  return Boolean(
                    nextTransfer &&
                      (nextTransfer.status !== entry.status || nextTransfer.updated_at !== entry.updated_at),
                  );
                });
                const refreshedTransfer = refreshed.transfers.find((row) => row.id === entry.id);
                if (refreshedTransfer && drawer.isOpen) {
                  openTransferDrawer(refreshedTransfer, refreshed);
                }
                setLastActionReadback(warehouseActionReadbackFrom('reconcile_destination', result, {
                  warehouse_transfer_id: entry.id,
                  transfer_code: refreshedTransfer?.transfer_code ?? entry.transfer_code ?? entry.transfer_id ?? entry.id,
                  transfer_status:
                    refreshedTransfer?.status ??
                    readbackString((result as Record<string, unknown>).transfer_status) ??
                    entry.status,
                }));
                pushToast(t('platformWarehouse.warehouseModule.transferReconciliationRecorded'), 'good');
                modal.close();
              } catch (err) {
                pushToast(fill(t('platformWarehouse.warehouseModule.reconcileWorkflowFailed'), { value: String(errorMessage(err)) }), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  };

  const openBulkReconcileModal = (rows: TransferRow[]) => {
    if (rows.length === 0) return;
    if (rows.length === 1) {
      openReconcileModal(rows[0]!);
      return;
    }

    let notes = '';
    const label = commandLabel('warehouse_transfers.reconcile_destination', 'Reconcile transfers');
    modal.open({
      title: `${label} - ${rows.length} selected`,
      body: (
        <div data-testid="warehouse-bulk-reconcile-modal">
          <div className="state__hint" style={{ margin: '0 0 10px' }}>
            {fill(t('platformWarehouse.warehouseModule.destinationReconcileWorkflowsWill'), { length: String(rows.length) })}
          </div>
          <div className="dt" style={{ maxHeight: 220, overflow: 'auto' }}>
            <table className="dt__table">
              <thead>
                <tr>
                  <th>{t('platformWarehouse.warehouseModule.transfer')}</th>
                  <th>{t('platformWarehouse.warehouseModule.received')}</th>
                  <th>{t('platformWarehouse.warehouseModule.missing')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.transfer_code ?? row.transfer_id ?? row.id}</td>
                    <td className="mono">{row.received_count ?? 0}</td>
                    <td className="mono">{row.variance_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label className="field__label">{t('platformWarehouse.warehouseModule.reconcileNotes')}</label>
            <textarea
              rows={3}
              data-testid="warehouse-bulk-reconcile-notes"
              onChange={(e) => {
                notes = e.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformWarehouse.warehouseModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={label}
            iconName="check"
            kind="primary"
            capability={CAP.WAREHOUSE_WRITE}
            onClick={async () => {
              const results = await Promise.allSettled(
                rows.map((row) =>
                  reconcileDestinationMutation.mutateAsync({
                    warehouse_transfer_id: row.id,
                    received_shipment_count: parseNonNegativeInt(
                      String(row.received_count ?? 0),
                      'Received shipment count',
                    ),
                    damaged_shipment_count: 0,
                    missing_shipment_count: parseNonNegativeInt(
                      String(row.variance_count ?? 0),
                      'Missing shipment count',
                    ),
                    unmanifested_shipment_count: 0,
                    reconcile_notes: notes.trim() || null,
                  }),
                ),
              );
              await refetchWarehouseLists();
              const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
              const okCount = results.length - failures.length;
              if (failures.length > 0) {
                pushToast(
                  fill(t('platformWarehouse.warehouseModule.reconciledTransfersFailed'), { okCount: String(okCount), length: String(rows.length), length2: String(failures.length), value: String(errorMessage(failures[0]?.reason)) }),
                  okCount > 0 ? 'warn' : 'danger',
                );
                return;
              }
              pushToast(fill(t('platformWarehouse.warehouseModule.transferReconciliationRecordedTransfers'), { okCount: String(okCount) }), 'good');
              modal.close();
            }}
          />
        </div>
      ),
    });
  };

  const approveVariance = async (transfer: TransferRow, task: WarehouseTask) => {
    if (!canCompleteTasks) {
      pushToast(t('platformWarehouse.warehouseModule.taskCompletionPermissionRequired'), 'warn');
      return;
    }
    const nextStatus = taskActionNextStatus('approve');
    if (!nextStatus) {
      pushToast(t('platformWarehouse.warehouseModule.approvalStatusIsNot'), 'danger');
      return;
    }
    const workflowRunId = warehouseTaskWorkflowRunId(task);
    const payload = {
      warehouse_transfer_id: transfer.id,
      source: 'console_v2.warehouse.variance_approval',
      task_type_key: warehouseTaskType(task),
      task_action_kind: 'approve',
    };
    try {
      const result = await transitionTask.mutateAsync({
        taskId: task.id,
        transition: {
          next_status: nextStatus,
          action_kind: 'approve',
          status_reason: 'warehouse variance approved',
          payload,
        },
      });
      let progressResult: Record<string, unknown> = {};
      if (workflowRunId) {
        progressResult = objectRecord(
          await progress_workflow_run_until_wait_v1(
            workflowRunId,
            {
              ...payload,
              task_id: task.id,
              completed_task_id: task.id,
            },
            { budget_ms: 12000, max_steps: 16 },
          ),
        );
      }
      setCompletedWarehouseTaskOverrides((current) => ({
        ...current,
        [task.id]: {
          status: nextStatus,
          status_reason: 'warehouse variance approved',
        },
      }));
      const refreshed = await refetchWarehouseListsUntil((snapshot) => {
        const nextTransfer = snapshot.transfers.find((row) => row.id === transfer.id);
        const stillHasApprovalTask = snapshot.warehouseTasks.some(
          (nextTask) =>
            (nextTask.resource_id === transfer.id || metadataRecord(nextTask).resource_id === transfer.id) &&
            warehouseTaskType(nextTask) === 'warehouse_supervisor_approval' &&
            isActiveWarehouseTask(nextTask),
        );
        return Boolean(
          nextTransfer &&
            !stillHasApprovalTask &&
            (nextTransfer.status === 'reconciled' || nextTransfer.updated_at !== transfer.updated_at),
        );
      });
      const reconciledTasks = refreshed.warehouseTasks.map((nextTask) =>
        nextTask.id === task.id
          ? {
              ...nextTask,
              status: nextStatus,
              status_reason: 'warehouse variance approved',
            }
          : nextTask,
      );
      const reconciledSnapshot: WarehouseListSnapshot = {
        ...refreshed,
        warehouseTasks: reconciledTasks,
        exceptionHolds: exceptionHoldsFromTasks(reconciledTasks),
      };
      const refreshedTransfer = refreshed.transfers.find((row) => row.id === transfer.id);
      if (refreshedTransfer && drawer.isOpen) {
        openTransferDrawer(refreshedTransfer, reconciledSnapshot);
      }
      setLastActionReadback(warehouseActionReadbackFrom('approve_variance', {
        ...objectRecord(result),
        ...progressResult,
      }, {
        warehouse_transfer_id: transfer.id,
        transfer_code: refreshedTransfer?.transfer_code ?? transfer.transfer_code ?? transfer.transfer_id ?? transfer.id,
        transfer_status: refreshedTransfer?.status ?? transfer.status,
        workflow_run_id: workflowRunId,
        workflow_status: readbackString(progressResult.status) ?? readbackString(progressResult.workflow_status),
        status: 'task_completed',
      }));
      pushToast(t('platformWarehouse.warehouseModule.varianceApprovalRecorded'), 'good');
    } catch (err) {
      pushToast(fill(t('platformWarehouse.warehouseModule.varianceApprovalFailed'), { value: String(errorMessage(err)) }), 'danger');
    }
  };

  const openTransferDrawer = (entry: TransferRow, snapshot?: WarehouseListSnapshot) => {
    setOpenTransferId(entry.id);
    const items =
      (snapshot?.transferItems ?? seed?.warehouse_transfer_items ?? []).filter((i) => i.transfer_id === entry.id);
    const scans =
      (snapshot?.checkpointScans ?? seed?.warehouse_checkpoint_scans ?? []).filter((s) => s.transfer_id === entry.id);
    const holds =
      (snapshot?.exceptionHolds ?? seed?.warehouse_exception_hold ?? []).filter((h) => h.transfer_id === entry.id);
    const scanIds = new Set(scans.map((scan) => scan.id));
    const scanCorrectionTasks = (snapshot?.warehouseTasks ?? warehouseTasks)
      .filter(
        (task) =>
          warehouseTaskType(task) === 'warehouse_scan_supervisor_approval' &&
          isActiveWarehouseTask(task) &&
          Boolean(scanCorrectionTaskOriginalScanId(task)) &&
          scanIds.has(scanCorrectionTaskOriginalScanId(task) ?? ''),
      )
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const scanCorrectionTaskForScan = (scanId: string): WarehouseTask | null =>
      scanCorrectionTasks.find((task) => scanCorrectionTaskOriginalScanId(task) === scanId) ?? null;
    const holdTaskIds = new Set(holds.map((h) => h.supervisor_approval_task_id).filter(Boolean));
    const transferTasks = (snapshot?.warehouseTasks ?? warehouseTasks)
      .filter((task) => task.resource_id === entry.id || metadataRecord(task).resource_id === entry.id || holdTaskIds.has(task.id))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const activeTasks = transferTasks.filter(isActiveWarehouseTask);
    const activeTaskForDrawer = (taskType: string): WarehouseTask | null =>
      transferTasks.find(
        (task) => warehouseTaskType(task) === taskType && isActiveWarehouseTask(task),
      ) ?? null;
    const activeDispatchTask = activeTaskForDrawer('warehouse_transfer_dispatch');
    const activeReceiveTask = activeTaskForDrawer('warehouse_transfer_receive');
    const activeReconcileTask = activeTaskForDrawer('warehouse_transfer_reconcile');
    const activeSupervisorApprovalTask = activeTaskForDrawer('warehouse_supervisor_approval');
    const supervisorApprovalTask =
      activeSupervisorApprovalTask ??
      (holds[0]?.supervisor_approval_task_id
        ? transferTasks.find((candidate) => candidate.id === holds[0]?.supervisor_approval_task_id) ?? null
        : null);
    const hasSupervisorApprovalGate = Boolean(supervisorApprovalTask);
    const canDispatch = entry.status === 'draft' && !activeTasks.length;
    const canScanDeparture = entry.status === 'draft' && Boolean(activeDispatchTask);
    const canScanArrival = entry.status === 'in_transit' && Boolean(activeReceiveTask);
    const canReconcile = entry.status === 'received' && Boolean(activeReconcileTask);
    drawer.open({
      title: `${entry.transfer_code ?? entry.transfer_id ?? entry.id} · ${entry.from_branch_id ?? entry.origin_hub ?? '—'} → ${entry.to_branch_id ?? entry.destination_hub ?? '—'}`,
      size: 'lg',
      onClose: () => setOpenTransferId(null),
      body: (
        <div>
          {/*
            W27-cycle-D §5 — drawer header status chip resolves through the
            canonical `warehouse_transfer_status` lookup catalog so the tone
            tracks the lifecycle (planned → in_transit → received → reconciled
            with on_hold / cancelled side states). The "(missing)" suffix
            surfaces an unrecognized status loudly instead of silently
            rendering `kind="info"`.
          */}
          <div className="card">
            {(() => {
              const statusRow = lookupRow('warehouse_transfer_status', entry.status);
              const statusTone: ChipKind =
                (statusRow?.tone as ChipKind | undefined) ?? 'neutral';
              const statusLabel = statusRow
                ? statusRow.label ?? entry.status
                : `${entry.status} (missing)`;
              return (
                <Kv
                  k="Status"
                  v={<Chip label={statusLabel} kind={statusTone} size="xs" />}
                />
              );
            })()}
            <Kv k="Items" v={`${entry.received_count} received / ${entry.item_count} expected`} />
            {entry.variance_flag ? (
              <Kv
                k="Variance"
                v={
                  <span style={{ color: 'var(--danger-ink, var(--ink-1))' }}>
                    {(() => {
                      // W11-3: variance_pct dropped from canonical view shape.
                      // Derive client-side from variance_count / item_count.
                      const pct =
                        entry.item_count > 0
                          ? Math.round(((entry.variance_count ?? 0) / entry.item_count) * 1000) / 10
                          : 0;
                      return `${pct}% · ${entry.hold_reason ?? '—'}`;
                    })()}
                  </span>
                }
              />
            ) : null}
          </div>

          <div className="card" data-testid="warehouse-active-task-panel" style={{ marginTop: '10px' }}>
            <div className="dt-toolbar">
              <span className="eyebrow">{t('platformWarehouse.warehouseModule.activeWorkflowTask')}</span>
              {activeTasks.length ? (
                <Chip label={fill(t('platformWarehouse.warehouseModule.open'), { length: String(activeTasks.length) })} size="xs" kind="info" />
              ) : (
                <Chip label={t('platformWarehouse.warehouseModule.none')} size="xs" kind="neutral" />
              )}
            </div>
            {activeTasks.length ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {activeTasks.map((task) => (
                  <div
                    key={task.id}
                    data-testid={`warehouse-active-task-${warehouseTaskType(task) || task.id}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      gap: 8,
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div className="mono" style={{ fontSize: '11.5px' }}>
                        {warehouseTaskLabel(task)}
                      </div>
                      <div style={{ color: 'var(--ink-3)', fontSize: '11px' }}>
                        {`${task.task_id ?? task.id} · ${task.status}`}
                      </div>
                    </div>
                    <Button
                      label={t('platformWarehouse.warehouseModule.completeTask')}
                      iconName="check"
                      kind="primary"
                      capability={CAP.TASKS_COMPLETE}
                      disabled={transitionTask.isPending || warehouseTaskType(task) !== 'warehouse_transfer_pack'}
                      title={
                        warehouseTaskType(task) === 'warehouse_transfer_pack'
                          ? undefined
                          : t('platformWarehouse.warehouseModule.useTheDedicatedScan')
                      }
                      onClick={() => void completeWarehouseTask(entry.id, task)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="state__hint" style={{ margin: '8px 0 0' }}>
                {t('platformWarehouse.warehouseModule.noOpenWarehouseWorkflow')}
              </p>
            )}
          </div>

          {holds.length ? (
            <>
              <h4 className="eyebrow" style={{ marginTop: '14px' }}>
                {t('platformWarehouse.warehouseModule.exceptionHolds')}
              </h4>
              {holds.map((h) => (
                <div key={h.id} className="card" style={{ marginTop: '6px' }}>
                  <div className="mono" style={{ fontSize: '11px' }}>
                    {`${h.kind} · ${h.notes ?? ''}`}
                  </div>
                  {h.supervisor_approval_task_id ? (
                    <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
                      {fill(t('platformWarehouse.warehouseModule.task'), { supervisor_approval_task_id: String(h.supervisor_approval_task_id) })}
                    </div>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}

          <h4 className="eyebrow" style={{ marginTop: '14px' }}>
            {t('platformWarehouse.warehouseModule.itemsManifestVsReceived')}
          </h4>
          <div style={{ maxHeight: '200px', overflow: 'auto' }}>
            <DataTable<TransferItem & Record<string, unknown>>
              columns={itemTableColumns}
              rows={items as (TransferItem & Record<string, unknown>)[]}
              allowSelection={false}
              virtualize={false}
            />
          </div>

          <h4 className="eyebrow" style={{ marginTop: '14px' }}>
            {t('platformWarehouse.warehouseModule.checkpointScansSequenceEnforced')}
          </h4>
          <div style={{ maxHeight: '200px', overflow: 'auto' }}>
            <DataTable<CheckpointScan & Record<string, unknown>>
              columns={scanTableColumns}
              rows={scans as (CheckpointScan & Record<string, unknown>)[]}
              allowSelection={false}
              virtualize={false}
              emptyText={t('platformWarehouse.warehouseModule.noScansRecordedYet')}
              rowActions={[
                {
                  label: t('platformWarehouse.warehouseModule.requestCorrection'),
                  icon: 'edit',
                  capability: CAP.WAREHOUSE_WRITE,
                  hidden: (scan) => Boolean(scan.correction_of_scan_event_id),
                  disabled: (scan) => Boolean(scanCorrectionTaskForScan(scan.id)),
                  disabledReason: () => 'A scan correction approval task is already open for this scan.',
                  onClick: (scan) => openScanCorrectionRequestModal(entry, scan),
                },
                {
                  label: t('platformWarehouse.warehouseModule.recordCorrection'),
                  icon: 'shield',
                  capability: CAP.TASKS_COMPLETE,
                  hidden: (scan) => !scanCorrectionTaskForScan(scan.id),
                  disabled: () => transitionTask.isPending || scanEventMutation.isPending,
                  disabledReason: () => 'Scan correction approval is already being recorded.',
                  onClick: (scan) => {
                    const task = scanCorrectionTaskForScan(scan.id);
                    if (!task) return;
                    openScanCorrectionRecordModal(entry, scan, task);
                  },
                },
              ]}
            />
          </div>

          {scanCorrectionTasks.length ? (
            <div className="card" data-testid="warehouse-scan-correction-panel" style={{ marginTop: '10px' }}>
              <div className="dt-toolbar">
                <span className="eyebrow">{t('platformWarehouse.warehouseModule.scanCorrectionApprovals')}</span>
                <Chip label={fill(t('platformWarehouse.warehouseModule.open'), { length: String(scanCorrectionTasks.length) })} size="xs" kind="warn" />
              </div>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {scanCorrectionTasks.map((task) => {
                  const correction = scanCorrectionTaskMetadata(task);
                  return (
                    <div key={task.id}>
                      <div className="mono" style={{ fontSize: '11.5px' }}>
                        {warehouseTaskLabel(task)}
                      </div>
                      <div style={{ color: 'var(--ink-3)', fontSize: '11px' }}>
                        {fill(t('platformWarehouse.warehouseModule.scan'), { value: String(task.task_id ?? task.id), status: String(task.status), value2: String(scanCorrectionTaskOriginalScanId(task) ?? 'pending') })}
                      </div>
                      {readbackString(correction.correction_reason) ? (
                        <div style={{ color: 'var(--ink-3)', fontSize: '11px' }}>
                          {readbackString(correction.correction_reason)}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <Button
            label={commandLabel('warehouse_transfers.dispatch', 'Dispatch transfer')}
            iconName="play"
            kind="ghost"
            capability={CAP.WAREHOUSE_WRITE}
            disabled={dispatchTransferMutation.isPending || !canDispatch}
            title={canDispatch ? undefined : t('platformWarehouse.warehouseModule.dispatchIsAvailableOnly')}
            onClick={() => void dispatchTransfer(entry)}
          />
          <Button
            label={commandLabel('warehouse_transfers.scan_departure', 'Scan departure')}
            iconName="scan"
            kind="ghost"
            capability={CAP.WAREHOUSE_WRITE}
            disabled={checkpointMutation.isPending || !canScanDeparture}
            title={canScanDeparture ? undefined : t('platformWarehouse.warehouseModule.completeTheActivePack')}
            onClick={() => openCheckpointModal(entry, 'warehouse_transfers.scan_departure')}
          />
          <Button
            label={commandLabel('warehouse_transfers.scan_arrival', 'Scan arrival')}
            iconName="scan"
            kind="ghost"
            capability={CAP.WAREHOUSE_WRITE}
            disabled={checkpointMutation.isPending || !canScanArrival}
            title={canScanArrival ? undefined : t('platformWarehouse.warehouseModule.departureMustCreateAn')}
            onClick={() => openCheckpointModal(entry, 'warehouse_transfers.scan_arrival')}
          />
          <Button
            label={t('platformWarehouse.warehouseModule.receive')}
            iconName="check"
            kind="primary"
            capability={CAP.WAREHOUSE_WRITE}
            // W37 — canonical past-tense `to_status` value per the
            // `warehouse_transfer_status` lookup catalog
            // (supabase/migrations/202604301500_v_warehouse_transfer_summary.sql:
            // status IN ('received', 'reconciled', 'on_hold')). Closes REAUDIT4
            // PLATFORM P1 (W35e-4 partial closure).
            disabled
            title={t('platformWarehouse.warehouseModule.receiveIsCompletedBy')}
            onClick={() => undefined}
          />
          <Button
            label={commandLabel('warehouse_transfers.reconcile_destination', 'Reconcile transfer')}
            iconName="check"
            kind="ghost"
            capability={CAP.WAREHOUSE_WRITE}
            // W37 — canonical past-tense `to_status` value (same rationale).
            disabled={reconcileDestinationMutation.isPending || !canReconcile}
            title={canReconcile ? undefined : t('platformWarehouse.warehouseModule.reconciliationRequiresAReceived')}
            onClick={() => openReconcileModal(entry)}
          />
          <div style={{ flex: 1 }} />
          {hasSupervisorApprovalGate ? (() => {
            // W-Cycle-E2 (P1 #5) — Approve button disables when there is no
            // canonical `supervisor_approval_task_id` to act upon. Previous
            // implementation silently fired a "good"-tone toast on a missing
            // task id, which masked the projection gap. The button now stays
            // inert with a tooltip explaining the gap until a canonical task
            // id is projected. Resolves W-Cycle-E2 strict-isolation finding.
            const task = supervisorApprovalTask;
            return (
              <Button
                label={t('platformWarehouse.warehouseModule.approveVariance')}
                iconName="shield"
                kind="ghost"
                capability={CAP.TASKS_COMPLETE}
                disabled={!task}
                title={task ? undefined : t('platformWarehouse.warehouseModule.noActiveSupervisorApproval')}
                onClick={() => {
                  if (!task) return;
                  void approveVariance(entry, task);
                }}
              />
            );
          })() : null}
        </div>
      ),
    });
  };

  useEffect(() => {
    const focus = readUrlParam('task') ?? readUrlParam('focus');
    if (!focus || transfersQuery.isLoading || openedFocusRef.current === focus) return;
    const hold = seed?.warehouse_exception_hold.find(
      (row) => row.supervisor_approval_task_id === focus || row.id === focus,
    );
    const transferFocus = hold?.transfer_id ?? focus;
    const transfer = transfers.find(
      (row) =>
        row.id === transferFocus ||
        row.transfer_id === transferFocus ||
        row.transfer_code === transferFocus,
    );
    if (!transfer) return;
    openedFocusRef.current = focus;
    openTransferDrawer(transfer);
  }, [seed, transfers, transfersQuery.isLoading]);

  useEffect(() => {
    if (!openTransferId || !drawer.isOpen) return;
    const transfer = transfers.find((row) => row.id === openTransferId);
    if (!transfer) return;
    openTransferDrawer(transfer);
  }, [openTransferId, drawer.isOpen, transfers, seed, warehouseTasks]);

  // W38-PLATFORM closure: removed synthetic-id `onScan` page-header CTA
  // (previously fired record_scan_event_v1 with hardcoded
  // `transfer_id: 'wtr_synth'`). Per AGENTS.md "no defensive
  // backwards-compat shims for hypothetical future requirements", a
  // page-header button with a synthetic transfer_id was structurally
  // invalid: it could not bind to a real transfer at click time.
  // Per-row scan flows route through the drawer / rowAction surfaces
  // bound to the real transfer.id (see onClick handlers in the kanban
  // card body + drawer footer below).

  const variancePendingCount = useMemo(
    () => transfers.filter((entry) => entry.variance_flag).length,
    [transfers],
  );

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="warehouse"
          eyebrow={t('platformWarehouse.warehouseModule.platform')}
          titleAccent={t('platformWarehouse.warehouseModule.titleAccent')}
          titlePlain={t('platformWarehouse.warehouseModule.titlePlain')}
          pills={[
            <span key="v1" className="chip chip--xs">{t('platformWarehouse.warehouseModule.transferWorkflowScanSequence')}</span>,
            variancePendingCount > 0 ? (
              <span key="vr" className="chip chip--xs chip--warn">{fill(t('platformWarehouse.warehouseModule.atRisk'), { variancePendingCount: String(variancePendingCount) })}</span>
            ) : null,
          ].filter(Boolean) as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.WAREHOUSE_READ}
          hint={t('platformWarehouse.warehouseModule.youDoNotHave')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="warehouse"
        eyebrow={t('platformWarehouse.warehouseModule.platform')}
        titleAccent={t('platformWarehouse.warehouseModule.titleAccent')}
        titlePlain={t('platformWarehouse.warehouseModule.titlePlain')}
        pills={[
          <span key="v1" className="chip chip--xs">{t('platformWarehouse.warehouseModule.transferWorkflowScanSequence')}</span>,
          variancePendingCount > 0 ? (
            <span key="vr" className="chip chip--xs chip--warn">{fill(t('platformWarehouse.warehouseModule.atRisk'), { variancePendingCount: String(variancePendingCount) })}</span>
          ) : null,
        ].filter(Boolean) as ReactNode[]}
        // W38-PLATFORM closure: scan/execute remain row-bound only because
        // they require an existing transfer id. Manifest creation is allowed
        // here because it creates a new transfer through the canonical branch
        // + shipment membership RPC.
        actions={[
          <Button
            key="create-manifest"
            label={t('platformWarehouse.warehouseModule.createManifest')}
            iconName="plus"
            kind="primary"
            capability={CAP.WAREHOUSE_WRITE}
            onClick={openCreateManifestModal}
          />,
        ]}
      />

      <WarehouseActionReadbackPanel readback={lastActionReadback} />

      <div className="section-eyebrow">{t('platformWarehouse.warehouseModule.transferBoard')}</div>
      {transfersQuery.isLoading ? (
        <StateView kind="loading" />
      ) : (
        <div className="kanban">
          {kanbanColumns.map((stage) => {
            const items = grouped[stage] ?? [];
            return (
              <div key={stage} className="kanban__col">
                <div className="kanban__col-head">
                  <span className="kanban__col-title">{stage.replace(/_/g, ' ')}</span>
                  <span className="kanban__col-count">{`· ${items.length}`}</span>
                </div>
                <div className="kanban__col-body">
                  {items.map((entry) => (
                    <div
                      key={entry.id}
                      className={`kanban__card ${entry.variance_flag ? 'is-risk' : ''}`}
                      onClick={() => openTransferDrawer(entry)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="kanban__card-head">
                        <span className="kanban__card-id mono">
                          {entry.transfer_code ?? entry.transfer_id ?? entry.id}
                        </span>
                        {entry.variance_flag ? (
                          <Chip
                            label={(() => {
                              const pct =
                                entry.item_count > 0
                                  ? Math.round(
                                      ((entry.variance_count ?? 0) / entry.item_count) * 1000,
                                    ) / 10
                                  : 0;
                              return `Δ ${pct}%`;
                            })()}
                            kind="warn"
                            size="xs"
                          />
                        ) : null}
                      </div>
                      <div style={{ fontWeight: 500, fontSize: '11.5px' }}>
                        {`${entry.from_branch_id ?? entry.origin_hub ?? '—'} → ${entry.to_branch_id ?? entry.destination_hub ?? '—'}`}
                      </div>
                      <div className="kanban__card-meta mono">
                        {fill(t('platformWarehouse.warehouseModule.items'), { received_count: String(entry.received_count), item_count: String(entry.item_count) })}
                      </div>
                      {entry.hold_reason ? (
                        <div className="kanban__card-meta mono" style={{ color: 'var(--warn-ink, var(--ink-2))' }}>
                          {entry.hold_reason}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="section-eyebrow">{t('platformWarehouse.warehouseModule.allTransfers')}</div>
      {transfersQuery.isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<TransferRow>
          columns={transferTableColumns}
          rows={transfers}
          viewKey="warehouse_transfers"
          entityKind="warehouse_transfers"
          onRowClick={openTransferDrawer}
          getRowClass={(r) => (r.variance_flag ? 'is-risk' : undefined)}
          onCellEdit={async (_row, key, _value) => {
            if (key === 'status') {
              // W35e-4 — canonical jsonb envelope; the cell value IS the
              // canonical `to_status` (lookup chip already constrains values).
              return { ok: false, error: 'Warehouse status changes must use the workflow actions.' };
            }
            return { ok: true };
          }}
          rowActions={[
            {
              label: t('platformWarehouse.warehouseModule.openDetail'),
              icon: 'right',
              onClick: openTransferDrawer,
            },
            {
              label: commandLabel('warehouse_transfers.dispatch', 'Dispatch transfer'),
              icon: 'play',
              capability: CAP.WAREHOUSE_WRITE,
              disabled: (r) => r.status !== 'draft' || tasksForTransfer(r.id).some(isActiveWarehouseTask),
              disabledReason: () => 'Dispatch is available only for a draft transfer with no active workflow task.',
              onClick: (r) => void dispatchTransfer(r),
            },
            {
              label: commandLabel('warehouse_transfers.scan_departure', 'Scan departure'),
              icon: 'scan',
              capability: CAP.WAREHOUSE_WRITE,
              disabled: (r) => r.status !== 'draft' || !activeTaskForType(r.id, 'warehouse_transfer_dispatch'),
              disabledReason: () => 'Complete the active pack task before scanning departure.',
              onClick: (r) => openCheckpointModal(r, 'warehouse_transfers.scan_departure'),
            },
            {
              label: commandLabel('warehouse_transfers.scan_arrival', 'Scan arrival'),
              icon: 'scan',
              capability: CAP.WAREHOUSE_WRITE,
              disabled: (r) => r.status !== 'in_transit' || !activeTaskForType(r.id, 'warehouse_transfer_receive'),
              disabledReason: () => 'Departure must create an active receive task before arrival scan.',
              onClick: (r) => openCheckpointModal(r, 'warehouse_transfers.scan_arrival'),
            },
            {
              label: t('platformWarehouse.warehouseModule.receive'),
              icon: 'check',
              capability: CAP.WAREHOUSE_WRITE,
              hidden: true,
              // W37 — canonical past-tense `to_status` per the
              // warehouse_transfer_status lookup catalog. Closes REAUDIT4
              // PLATFORM P1.
              onClick: () => undefined,
            },
            {
              label: commandLabel('warehouse_transfers.reconcile_destination', 'Reconcile transfer'),
              icon: 'check',
              capability: CAP.WAREHOUSE_WRITE,
              // W37 — canonical past-tense `to_status` (same rationale).
              onClick: (r) => {
                if (r.status !== 'received' || !activeTaskForType(r.id, 'warehouse_transfer_reconcile')) {
                  pushToast(t('platformWarehouse.warehouseModule.reconciliationRequiresAReceived'), 'warn');
                  return;
                }
                openReconcileModal(r);
              },
            },
            {
              label: t('platformWarehouse.warehouseModule.approveVariance'),
              icon: 'shield',
              capability: CAP.TASKS_COMPLETE,
              hidden: (r) => !supervisorApprovalTaskForTransfer(r.id),
              disabled: (r) => !supervisorApprovalTaskForTransfer(r.id),
              disabledReason: () => 'Variance approval requires an active supervisor approval task.',
              // W61 Cycle F-R Platform+Insights closure (P1-1) — row-level
              // Approve variance previously fired an unconditional "good"-tone
              // toast, which masked the projection gap when no canonical
              // supervisor_approval_task_id was available. Mirrors the
              // drawer-footer guard (lines 363-388): derive taskId from the
              // canonical exception_hold projection (filtered by transfer_id),
              // fail loud when the projection is empty, and otherwise echo the
              // task id so the resolution is auditable. AGENTS.md §2 (NO
              // WORKAROUNDS / SSOT), §6 (row-driven parity between two surfaces
              // invoking the same supervisor approval semantics).
              onClick: (r) => {
                const task = supervisorApprovalTaskForTransfer(r.id);
                if (!task) {
                  pushToast(t('platformWarehouse.warehouseModule.noActiveSupervisorApproval'), 'warn');
                  return;
                }
                void approveVariance(r, task);
              },
            },
          ]}
          bulkActions={[
            {
              label: t('platformWarehouse.warehouseModule.receive'),
              icon: 'check',
              kind: 'primary',
              capability: CAP.WAREHOUSE_WRITE,
              disabled: true,
              disabledReason: 'Receive is completed by the arrival scan workflow.',
              onClick: (rs) => {
                // W35e-4 — canonical jsonb envelope; bulk path now sends
                // `{ warehouse_transfer_id, to_status }` per row.
                void rs;
              },
            },
            {
              label: t('platformWarehouse.warehouseModule.reconcile'),
              icon: 'check',
              capability: CAP.WAREHOUSE_WRITE,
              onClick: (rs) => {
                // Destination reconcile stays on the canonical modal/RPC path.
                openBulkReconcileModal(rs);
              },
            },
          ]}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

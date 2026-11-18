// amend-cancel.tsx — TS/React port of demo-v2/assets/js/modules/op-amend-cancel.js
// Workflow-engine-first amend/cancel **review queue** (AGENTS.md line 30).
// Backed by tasks (task_type='shipment_amend_review') +
//   shipment_amend_cancel_v1 + ui_execute_shipment_batch_operation_v1 +
//   resolve_settings('shipment_operation_policy') + transition_task_v1.
//
// CLAIM C hardening sweep:
//   • replaced SEED_QUEUE const with useTasks({task_type:'shipment_amend_review'})
//     so the queue reflects real backed customer/sender amend requests
//     (e.g. seeded TSK-3001 in domain-tasks.js)
//   • Pre-flight policy now calls resolveSettings('shipment_operation_policy')
//     instead of toasting hardcoded values
//   • drawer dry-run renders the live diff from the RPC response (NOT a
//     hardcoded {before,after}) and shows live policy values from the response
//   • Reject and onCellEdit('status') now call transition_task_v1 (not local
//     state mutation only)

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useDrawer } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useTasks,
  useTransitionTask,
  useShipmentAmendCancel,
  useShipmentBatchOp,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import * as api from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';

interface AmendRequestMetadata {
  requested_op?: 'amend_address' | 'amend_cod' | 'cancel' | 'reschedule' | string;
  requested_by?: 'sender' | 'recipient' | 'support' | string;
  requested_payload?: Record<string, unknown>;
  // Forward-compat — the canonical jsonb may carry additional intake context.
  [k: string]: unknown;
}
// Wave 6 schema-drift remediation (OPERATIONS Section 6):
// AmendTaskRow annotated against canonical `public.tasks`.
// See __audit__/SCHEMA-DRIFT/OPERATIONS.md §6 (mirrors §4 TaskRow).
export interface AmendTaskRow extends Record<string, unknown> {
  id: string;                       // SSOT: tasks.id
  task_id: string;                  // SSOT: REMOVE — alias of `id` (W7 cascade)
  task_type: string;                // SSOT: tasks.task_type_id (FK; registry projection NOT yet exposing task_type_key — paired registry task deferred)
  subject?: string;                 // SSOT: REMOVE — not a column; resolve via metadata.subject
  shipment_id?: string;             // SSOT: tasks.resource_id (when resource_type='shipment') — RENAME deferred W7
  status: string;                   // SSOT: tasks.status
  sla_due_at?: string;              // SSOT: tasks.sla_due_at (W14-3 rename applied)
  allowed_actions?: string[];       // SSOT: REMOVE — projection (computed via task_type_catalog/ndr_policy)
  metadata?: AmendRequestMetadata;  // SSOT: tasks.metadata (typed JSONB refinement)
}

// CLAIM-OPERATIONS-WIRING (Phase C1) — `task.metadata.requested_op` is the
// canonical seam (per __audit__/CROSSWALK/OPERATIONS.md gap row for
// amend-cancel.tsx).
//
// W54-C closure — subject-substring inference removed. The fallback
// keyword → op mapping was a brittle hardcode that would silently
// misroute when the operator/portal subject text drifted. We now ONLY
// trust the canonical `metadata.requested_op` value; missing metadata
// returns `null` so consumers render a `(metadata missing)` chip.
function readRequestedOp(task: AmendTaskRow): 'amend_address' | 'amend_cod' | 'cancel' | 'reschedule' | null {
  // W71-Operate (Cycle F-R-11) closure — valid-op gate resolves through the
  // canonical lookup taxonomy `shipment_amend_op.metadata.is_valid_op` instead of an
  // inline 4-way `===` literal disjunction. Adding a new amend op
  // requires only a new row + matching backend enum extension.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
  const meta = task.metadata?.requested_op;
  if (typeof meta !== 'string') return null;
  if (api.lookupRow('shipment_amend_op', meta)?.metadata?.is_valid_op === true) {
    return meta as 'amend_address' | 'amend_cod' | 'cancel' | 'reschedule';
  }
  return null;
}

function readRequestedBy(task: AmendTaskRow): string | null {
  const meta = task.metadata?.requested_by;
  if (typeof meta === 'string' && meta.length > 0) return meta;
  return null;
}

function displayReferenceValue(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '—';
  const shipment = value.match(/^shp[_-](.+)$/i);
  if (shipment) return `SHP-${shipment[1]}`;
  const task = value.match(/^tsk[_-](.+)$/i);
  if (task) return `TSK-${task[1]}`;
  const compact = value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
  return compact;
}

function compactReference(raw: unknown): ReactNode {
  const value = String(raw ?? '').trim();
  const display = displayReferenceValue(raw);
  return (
    <span className="mono" title={value}>
      {display}
    </span>
  );
}

function compactReferenceText(raw: unknown): string {
  return displayReferenceValue(raw);
}

function requestedOpLabel(op: string | null): string {
  if (!op) return 'Missing details';
  const row = api.lookupRow('shipment_amend_op', op) as { label?: string } | null;
  return row?.label ?? op.replace(/_/g, ' ');
}

export function requestedBackendOperation(op: string | null): string | null {
  if (!op) return null;
  const row = api.lookupRow('shipment_amend_op', op) as
    | { metadata?: { backend_operation?: unknown; is_valid_op?: unknown } }
    | null;
  if (row?.metadata?.is_valid_op !== true) return null;
  const backendOperation = row.metadata.backend_operation;
  return typeof backendOperation === 'string' && backendOperation.length > 0
    ? backendOperation
    : null;
}

function readRequestedPayload(task: AmendTaskRow): Record<string, unknown> {
  const payload = task.metadata?.requested_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

export function buildAmendMutationArgs(task: AmendTaskRow, dryRun?: boolean) {
  const op = readRequestedOp(task);
  const backendOperation = requestedBackendOperation(op);
  if (!op || !backendOperation) return null;
  const shipmentId = task.shipment_id?.trim();
  if (!shipmentId) return null;
  return {
    shipmentId,
    op: backendOperation,
    payload: readRequestedPayload(task),
    ...(dryRun !== undefined ? { dryRun } : {}),
  };
}

export function canEditAmendReviewStatus(canWriteTasks: boolean, canCompleteTasks: boolean): boolean {
  void canWriteTasks;
  return canCompleteTasks;
}

function stablePayloadKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePayloadKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stablePayloadKey((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function summarizeReviewValue(value: unknown): string {
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.replace(/[_-]+/g, ' ');
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `${count} detail${count === 1 ? '' : 's'}`;
  }
  return String(value);
}

function summarizeReviewEntries(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 8)
    .map(([key, raw]) => ({
      key,
      value: summarizeReviewValue(raw),
    }));
}

export function canUseBatchForRequests(rows: AmendTaskRow[]): { ok: true; op: string; payload: Record<string, unknown>; ids: string[] } | { ok: false; reason: string } {
  const prepared = rows
    .map((row) => {
      const args = buildAmendMutationArgs(row);
      return args && args.shipmentId ? { row, args } : null;
    })
    .filter(Boolean) as Array<{ row: AmendTaskRow; args: NonNullable<ReturnType<typeof buildAmendMutationArgs>> }>;
  if (prepared.length !== rows.length || prepared.length === 0) {
    return { ok: false, reason: 'Some selected requests are missing operation or shipment details.' };
  }
  const first = prepared[0]!.args;
  const firstPayload = stablePayloadKey(first.payload);
  const sameContract = prepared.every(({ args }) => args.op === first.op && stablePayloadKey(args.payload) === firstPayload);
  if (!sameContract) {
    return { ok: false, reason: 'Selected requests have different operations or payloads.' };
  }
  if (first.op !== 'cancel' && first.op !== 'reschedule') {
    return { ok: false, reason: 'Selected amend requests need individual workflow review.' };
  }
  return {
    ok: true,
    op: first.op,
    payload: first.payload,
    ids: prepared.map(({ args }) => args.shipmentId),
  };
}

export function shipmentFocusPath(task: AmendTaskRow): string | null {
  const shipmentId = task.shipment_id?.trim();
  if (!shipmentId) return null;
  return `/operate/shipments?focus=${encodeURIComponent(shipmentId)}`;
}

// W79 (Cycle F-R-19) closure — `next_status` for review-queue transitions
// resolves through canonical `task_action_kind.next_status` SSOT instead of
// inline `'completed'`/`'rejected'` literals. Adding/renaming a terminal
// status (e.g., a future `withdrawn` action) is then a single seed update.
// Strict no-fallback: if the canonical row is missing `next_status`, the
// empty string surfaces as a loud RPC error instead of a silent default.
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
function taskActionNextStatus(kind: 'approve' | 'reject'): string {
  const row = api.lookupRow('task_action_kind', kind) as
    | { next_status?: string; metadata?: { next_status?: string } }
    | null;
  return row?.next_status ?? row?.metadata?.next_status ?? '';
}

export function AmendCancelModule() {
  const { scope } = useIdentity();
  const go = useConsoleNavigator();
  const canRead = useCapability(CAP.SHIPMENTS_READ);
  const canWriteTasks = useCapability(CAP.TASKS_WRITE);
  const canCompleteTasks = useCapability(CAP.TASKS_COMPLETE);
  const canTransitionTask = canEditAmendReviewStatus(canWriteTasks, canCompleteTasks);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const drawer = useDrawer();
  const transition = useTransitionTask();
  const amend = useShipmentAmendCancel();
  const batchOp = useShipmentBatchOp();

  const { data: tasksData, isLoading } = useTasks({ task_type: 'shipment_amend_review' }, readQueryOptions);
  const queue = useMemo(() => (tasksData ?? []) as AmendTaskRow[], [tasksData]);
  const openedFocusRef = useRef<string | null>(null);

  const columns: Array<DataTableColumn<AmendTaskRow>> = useMemo(
    () => [
      { key: 'task_id', label: 'Task', sortable: true, render: compactReference },
      { key: 'shipment_id', label: 'Shipment', sortable: true, filterable: true, render: compactReference },
      {
        key: 'op',
        label: 'Operation',
        sortable: true,
        filterable: true,
        render: (_raw: unknown, row: AmendTaskRow) => {
          const op = readRequestedOp(row);
          // W54-C — render an explicit `(metadata missing)` chip when
          // canonical `tasks.metadata.requested_op` is absent.
          return op
            ? <Chip size="xs" label={requestedOpLabel(op)} />
            : <Chip size="xs" kind="warn" label="(metadata missing)" />;
        },
      },
      {
        key: 'requested_by',
        label: 'Requested by',
        sortable: true,
        filterable: true,
        render: (_raw: unknown, row: AmendTaskRow) => {
          const requestedBy = readRequestedBy(row);
          return <span>{requestedBy ?? '(metadata missing)'}</span>;
        },
      },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'task_status', editable: canTransitionTask },
    ],
    [canTransitionTask],
  );

  function openAmendDrawer(row: AmendTaskRow) {
    drawer.open({
      title: `${compactReferenceText(row.task_id)} · ${compactReferenceText(row.shipment_id)}`,
      size: 'lg',
      body: <AmendDrawerBody task={row} />,
      footer: <AmendDrawerFooter task={row} />,
    });
  }

  useEffect(() => {
    const focus = readUrlParam('focus');
    if (!focus || isLoading || openedFocusRef.current === focus) return;
    const match = queue.find((row) => row.id === focus || row.task_id === focus || row.shipment_id === focus);
    if (!match) return;
    openedFocusRef.current = focus;
    openAmendDrawer(match);
  }, [isLoading, queue]);

  // Drawer body — runs the dry-run on mount and renders the live diff +
  // resolved policy values from the response. No hardcoded values.
  function AmendDrawerBody({ task }: { task: AmendTaskRow }) {
    const op = readRequestedOp(task);
    const requestedBy = readRequestedBy(task);
    const [preview, setPreview] = useState<{
      workflow_template?: string;
      diff?: unknown;
      settings_resolution_id?: string;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Fire dry-run once on mount via useMemo([]) (component instance fresh per drawer.open).
    // W54-C — only fire dry-run when canonical metadata.requested_op is
    // present. NO inference fallback.
    useMemo(() => {
      if (!op) return null;
      void (async () => {
        try {
          const args = buildAmendMutationArgs(task, true);
          if (!args) return;
          const res = await amend.mutateAsync(args);
          setPreview(res as typeof preview);
        } catch {
          setError('Preview changes could not be prepared. Try again.');
        }
      })();
      return null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!op) {
      return (
        <StateView
          kind="error"
          title="Missing amend request details"
          hint="This request is missing the operation details needed for preview."
        />
      );
    }

    return (
      <div>
        <p className="state__hint">
          Access, lock checks, preview, and final apply run through the approved shipment-change workflow.
        </p>
        <div className="card" style={{ marginTop: '12px' }}>
          <Kv k="Operation" v={requestedOpLabel(op)} />
          <Kv k="Requested by" v={requestedBy ?? 'Not recorded'} />
          <Kv
            k="Workflow"
            v={preview?.workflow_template ? 'Ready' : <span className="state__hint">Checking...</span>}
          />
          <Kv
            k="Policy check"
            v={preview?.settings_resolution_id ? 'Passed' : <span className="state__hint">Checking...</span>}
          />
        </div>
        <h4 className="eyebrow" style={{ marginTop: '14px' }}>Preview changes</h4>
        {error ? (
          <div className="state state--denied">
            <p className="state__hint">{error}</p>
          </div>
        ) : preview?.diff != null ? (
          <div className="card" style={{ marginTop: '8px' }}>
            {summarizeReviewEntries(preview.diff).map((entry) => (
              <Kv key={entry.key} k={entry.key.replace(/[_-]+/g, ' ')} v={entry.value} />
            ))}
          </div>
        ) : (
          <div className="state__hint">Preparing preview...</div>
        )}
      </div>
    );
  }

  function AmendDrawerFooter({ task }: { task: AmendTaskRow }) {
    const op = readRequestedOp(task);
    const mutationArgs = buildAmendMutationArgs(task);
    // W54-C — actions disabled when canonical requested_op is missing.
    const opMissing = !op || !mutationArgs;
    return (
      <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
        <Button
          label="Reject"
          iconName="close"
          kind="ghost"
          capability={CAP.TASKS_COMPLETE}
          onClick={async () => {
            await transition.mutateAsync({ taskId: task.id, transition: { next_status: taskActionNextStatus('reject') } });
            pushToast('Review rejected', 'info');
            drawer.close();
          }}
        />
        <div style={{ flex: 1 }} />
        <Button
          label="Preview again"
          iconName="check"
          kind="ghost"
          disabled={opMissing}
          onClick={async () => {
            const args = buildAmendMutationArgs(task, true);
            if (!args) return;
            const res = await amend.mutateAsync(args);
            // W54-C — strict no-fallback: surface a danger toast when
            // canonical workflow_template id is missing.
            const tpl = (res as { workflow_template?: string }).workflow_template;
            if (!tpl) {
              pushToast('Shipment-change workflow is not configured.', 'danger');
              return;
            }
            pushToast('Preview refreshed', 'info');
          }}
        />
        <Button
          label="Apply change"
          iconName="play"
          kind="primary"
          capabilities={[CAP.SHIPMENTS_WRITE, CAP.TASKS_COMPLETE]}
          disabled={opMissing}
          onClick={async () => {
            const args = buildAmendMutationArgs(task);
            if (!args) return;
            const res = await amend.mutateAsync(args);
            // W54-C — strict no-fallback: surface a danger toast when
            // canonical workflow_run_id is missing.
            const wf = (res as { workflow_run_id?: string }).workflow_run_id;
            if (!wf) {
              pushToast('Shipment-change workflow could not be started.', 'danger');
              return;
            }
            pushToast('Shipment-change workflow started', 'good');
            // After apply, transition the review task to completed so the
            // queue reflects reality.
            await transition.mutateAsync({ taskId: task.id, transition: { next_status: taskActionNextStatus('approve') } });
            drawer.close();
          }}
        />
      </div>
    );
  }

  // W54-C — strict no-fallback. Missing canonical
  // shipment_operation_policy keys surface as a loud StateView in the
  // drawer, NOT a silent default to inline 'route_freeze'/24-hour
  // literals.
  async function openPreflightPolicy() {
    try {
      const res = await api.resolveSettings('shipment_operation_policy', { tenant_id: scope.tenant?.id });
      const value = (res as { value?: Record<string, unknown> }).value ?? {};
      const resolvedFrom = (res as { resolved_from?: string }).resolved_from ?? '—';
      const lockAfter =
        (value.amend_lock_after as string | undefined) ??
        ((value.modify as Record<string, unknown> | undefined)?.lock_after as string | undefined);
      const cancelWindowHours =
        (value.cancel_window_hours as number | undefined) ??
        ((value.delete as Record<string, unknown> | undefined)?.window_hours as number | undefined);
      if (lockAfter == null || cancelWindowHours == null) {
        drawer.open({
          title: 'Shipment-change policy',
          body: (
            <StateView
              kind="error"
              title="Shipment-change policy is incomplete"
              hint="Configure the amend lock point and cancel window before pre-flight review."
            />
          ),
        });
        return;
      }
      pushToast(
        `Shipment-change policy ready · ${resolvedFrom} · amend lock ${lockAfter} · cancel window ${cancelWindowHours}h`,
        'info',
      );
    } catch {
      pushToast('Policy check could not be completed. Try again.', 'warn');
    }
  }

  const pills: ReactNode[] = [
    // W56-C closure — `scopeType="tenant"` is the canonical resource-tier literal
    // (amend/cancel review queue scopes via current_user_org_id()).
    // `scopeId` is identity-derived. See shipments.tsx top-of-file SSOT note.
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip key="seam" size="xs" label="Workflow-backed review queue" />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="amendCancel"
          eyebrow="Operate"
          titleAccent="Amend"
          titlePlain="& cancel · review queue"
        />
        <StateView
          kind="denied"
          capability={CAP.SHIPMENTS_READ}
          hint="You do not have permission to view the amend & cancel queue."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="amendCancel"
        eyebrow="Operate"
        titleAccent="Amend"
        titlePlain="& cancel · review queue"
        pills={pills}
        actions={[
          <Button
            key="preflight"
            label="Pre-flight policy"
            iconName="check"
            kind="ghost"
            onClick={openPreflightPolicy}
          />,
        ]}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<AmendTaskRow>
          columns={columns}
          rows={queue}
          viewKey="amend_cancel_queue"
          entityKind="amend_request"
          onRowClick={openAmendDrawer}
          rowDeepLink={(r) => `/operate/amend-cancel?focus=${encodeURIComponent(r.id)}`}
          onCellEdit={canTransitionTask
            ? async (row, key, val) => {
                if (key === 'status') {
                  await transition.mutateAsync({ taskId: row.id, transition: { next_status: String(val) } });
                }
                return { ok: true };
              }
            : undefined}
          rowActions={[
            { label: 'Open review', icon: 'eye', onClick: openAmendDrawer },
            {
              label: 'Preview change',
              icon: 'check',
              onClick: async (r) => {
                // W54-C — strict no-fallback. NO inline 'tpl_amend_cancel'.
                const op = readRequestedOp(r);
                if (!op) {
                  pushToast('Missing amend request details; cannot preview.', 'danger');
                  return;
                }
                const args = buildAmendMutationArgs(r, true);
                if (!args) return;
                const res = await amend.mutateAsync(args);
                const tpl = (res as { workflow_template?: string }).workflow_template;
                if (!tpl) {
                  pushToast('Shipment-change workflow is not configured.', 'danger');
                  return;
                }
                pushToast('Preview ready', 'info');
              },
            },
            {
              label: 'Apply change',
              icon: 'play',
              kind: 'primary',
              capabilities: [CAP.SHIPMENTS_WRITE, CAP.TASKS_COMPLETE],
              onClick: async (r) => {
                // W54-C — strict no-fallback. NO inline 'wfr_unknown'.
                const op = readRequestedOp(r);
                if (!op) {
                  pushToast('Missing amend request details; cannot apply.', 'danger');
                  return;
                }
                const args = buildAmendMutationArgs(r);
                if (!args) return;
                const res = await amend.mutateAsync(args);
                const wf = (res as { workflow_run_id?: string }).workflow_run_id;
                if (!wf) {
                  pushToast('Shipment-change workflow could not be started.', 'danger');
                  return;
                }
                pushToast('Shipment-change workflow started', 'good');
                await transition.mutateAsync({ taskId: r.id, transition: { next_status: taskActionNextStatus('approve') } });
              },
            },
            {
              label: 'Open shipment',
              icon: 'right',
              onClick: (r) => {
                const path = shipmentFocusPath(r);
                if (!path) {
                  pushToast('Missing shipment details; cannot open shipment.', 'danger');
                  return;
                }
                go(path);
              },
            },
            {
              label: 'Reject',
              icon: 'close',
              kind: 'danger',
              capability: CAP.TASKS_COMPLETE,
              onClick: async (r) => {
                await transition.mutateAsync({ taskId: r.id, transition: { next_status: taskActionNextStatus('reject') } });
                pushToast('Review rejected', 'warn');
              },
            },
          ]}
          bulkActions={[
            {
              label: 'Bulk preview',
              icon: 'check',
              kind: 'ghost',
              onClick: async (rs) => {
                const batch = canUseBatchForRequests(rs);
                if (batch.ok) {
                  await batchOp.mutateAsync({
                    ids: batch.ids,
                    op: batch.op,
                    payload: batch.payload,
                    dryRun: true,
                  });
                } else {
                  const args = rs.map((r) => buildAmendMutationArgs(r, true));
                  if (args.some((arg) => !arg)) {
                    pushToast(batch.reason, 'danger');
                    return;
                  }
                  await Promise.all(args.map((arg) => amend.mutateAsync(arg!)));
                }
                pushToast(`Previewed ${rs.length} requests`, 'info');
              },
            },
            {
              label: 'Bulk apply',
              icon: 'play',
              kind: 'primary',
              capabilities: [CAP.SHIPMENTS_WRITE, CAP.TASKS_COMPLETE],
              onClick: async (rs) => {
                const batch = canUseBatchForRequests(rs);
                if (batch.ok) {
                  await batchOp.mutateAsync({
                    ids: batch.ids,
                    op: batch.op,
                    payload: batch.payload,
                  });
                } else {
                  const args = rs.map((r) => buildAmendMutationArgs(r));
                  if (args.some((arg) => !arg)) {
                    pushToast(batch.reason, 'danger');
                    return;
                  }
                  await Promise.all(args.map((arg) => amend.mutateAsync(arg!)));
                }
                pushToast(`Started ${rs.length} workflow runs`, 'good');
                await Promise.all(
                  rs.map((r) => transition.mutateAsync({ taskId: r.id, transition: { next_status: taskActionNextStatus('approve') } })),
                );
              },
            },
          ]}
        />
      )}

      {drawer.node}
    </div>
  );
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

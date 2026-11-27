// exceptions.tsx — TS/React port of demo-v2/assets/js/modules/op-exceptions.js
// NDR resolution canonical seam (AGENTS.md line 38).
// Backed by tasks (task_type='dispatch_exception_review') +
//   ui_execute_dispatch_exception_resolution_v1 (preview/apply) +
//   preview_dispatch_exception_resolution_v1 + ndr_policy.
//
// CLAIM C hardening sweep:
//   • removed synthetic Attempts + Comms tabs (fabricated rows breached
//     "no synthetic data" rule; replaced with task_events-derived Attempts)
//   • removed orphan Notes textarea (no save handler)
//   • removed duplicate top "Bulk reschedule" button (DataTable bulk covers it)
//   • wired Escalate button to transition_task_v1
//   • per-row Apply now uses the chip-selected resolution from drawer state,
//     and is hidden if the row's allowed_actions does not include 'reschedule'
//   • added relative SLA countdown chip to each row (Linear/Stripe pattern)
//   • bulk dry-run now opens a summary modal with per-row results
//     (ShipStation pattern), then a single Confirm to apply

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { CapabilityLock } from '@/components/CapabilityLock';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Icon } from '@/components/Icon';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { RelatedRail, type RelatedTab } from '@/components/RelatedRail';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import * as api from '@/lib/api';
import {
  useTasks,
  useTransitionTask,
  useDispatchExceptionResolution,
  useCompleteResourceList,
  useResolveSettings,
  useNdrBranchNextAction,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
// W54-C — strict canonical lookup resolver for chip tone (NO inline ternaries).
import { lookupRow } from '@/lib/api';
import { readUrlParam } from '@/lib/url-params';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';

// Wave 6 schema-drift remediation (OPERATIONS Section 4):
// FE TaskRow annotated against canonical `public.tasks` (registry projection
// at supabase/migrations/202602041430_ui_read_registry_tasks_v1.sql:16-53).
// See __audit__/SCHEMA-DRIFT/OPERATIONS.md §4.
interface TaskRow extends Record<string, unknown> {
  id: string;                       // SSOT: tasks.id
  task_id: string;                  // SSOT: REMOVE — alias of `id` (W7 cascade)
  task_type: string;                // SSOT: tasks.task_type_id (FK to task_types); registry projection NOT yet exposing task_type_key (deferred — paired registry projection task)
  subject?: string;                 // SSOT: REMOVE — not a column; resolve via metadata.subject
  attempt_count?: number;           // SSOT: REMOVE — projection (compute via task_events)
  sla_due_at: string;               // SSOT: tasks.sla_due_at (W14-3 rename applied)
  status: string;                   // SSOT: tasks.status
  shipment_id?: string;             // SSOT: tasks.resource_id (when resource_type='shipment') — RENAME deferred W7
  allowed_actions?: string[];       // SSOT: REMOVE — projection (computed via task_type_catalog.allowed_actions or ndr_policy)
  evidence_required?: boolean;      // SSOT: REMOVE — projection (computed via task_type policy)
  metadata?: Record<string, unknown> | null; // SSOT: tasks.metadata jsonb (carries dispatch_exception_reason)
}

interface ExceptionActionButtonProps {
  label: ReactNode;
  iconName?: string;
  kind?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md';
  canWrite: boolean;
  onClick: () => void;
}

function ExceptionActionButton({
  label,
  iconName,
  kind = 'ghost',
  disabled,
  title,
  size = 'md',
  canWrite,
  onClick,
}: ExceptionActionButtonProps) {
  const isDisabled = !!disabled || !canWrite;
  const classes = ['btn', kind ? `btn--${kind}` : '', size === 'sm' ? 'btn--sm' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      title={!canWrite ? 'Requires tasks.write' : title}
      onClick={() => {
        if (isDisabled) return;
        onClick();
      }}
    >
      {iconName ? <Icon name={iconName} size={12} /> : null}
      <span>{label}</span>
      {!canWrite ? <CapabilityLock capability={CAP.TASKS_WRITE} /> : null}
    </button>
  );
}

// Local helpers (no shared primitive churn). Mirrors the relative-time
// formatter pattern already used by workflows/review-queue.tsx.
//
// AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): the warn-window
// boundary is sourced from canonical `task_sla_thresholds.sla_warn_minutes_before_breach`
// (W30 policy seed); callers pass the resolved threshold so a single
// row mutation flips the chip behavior across every consumer.
function formatSlaCountdown(
  iso: string,
  warnMinutesBeforeBreach: number,
): { label: string; tone: 'good' | 'warn' | 'danger' } {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) {
    const m = Math.max(1, Math.floor(-ms / 60000));
    return { label: `${m}m overdue`, tone: 'danger' };
  }
  const warnMs = warnMinutesBeforeBreach * 60_000;
  if (ms < warnMs) return { label: `in ${Math.floor(ms / 60000)}m`, tone: 'warn' };
  if (ms < 3_600_000) return { label: `in ${Math.floor(ms / 60000)}m`, tone: 'good' };
  if (ms < 86_400_000) return { label: `in ${Math.floor(ms / 3_600_000)}h`, tone: 'good' };
  return { label: `in ${Math.floor(ms / 86_400_000)}d`, tone: 'good' };
}

interface BulkSummaryRow extends Record<string, unknown> {
  task_id: string;
  shipment_id?: string;
  outcome: 'ok' | 'blocked' | 'error';
  reason?: string;
}

interface ExceptionResolutionReadback {
  taskId: string;
  taskLabel: string;
  subject: string;
  action: string;
  rpc: string;
  canonicalEntrypoint: string;
  settingsResolutionId: string;
  applyStatus: string;
  taskEventId: string;
  workflowRunId: string;
  shipmentActionId: string;
  rowStatus: string;
  queueCount: number;
  rowVisible: boolean;
}

interface ExceptionResolutionPreviewReadback {
  taskLabel: string;
  action: string;
  canonicalEntrypoint: string;
  settingsResolutionId: string;
  policy: string;
  applyStatus: string;
  resultCount: number;
}

// W81-Operate (Cycle F-R-21 P1) closure — `next_status` for transition
// payloads resolves through canonical `task_action_kind.next_status` /
// `task_action_kind.metadata.next_status` SSOT instead of inline
// `'escalated'` literals. Mirrors the W79 pattern in amend-cancel.tsx.
// Adding/renaming a terminal status (e.g., a future `paused` action) is a
// single seed update. Strict no-fallback: if the canonical row is missing
// `next_status`, the empty string surfaces as a loud RPC error instead
// of silently masking the gap. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT)
// + §6 (row-driven by configuration).
function taskActionNextStatus(kind: string): string {
  const row = lookupRow('task_action_kind', kind) as
    | { next_status?: string; metadata?: { next_status?: string } }
    | null;
  return row?.next_status ?? row?.metadata?.next_status ?? '';
}

const NDR_RETURN_TO_BRANCH_ACTION = 'hold_at_branch';

function ndrActionLabel(action: string): string {
  if (action === NDR_RETURN_TO_BRANCH_ACTION) return 'Return to branch';
  const row = lookupRow('ndr_action', action) as { label?: string } | null;
  return row?.label ?? action.replace(/_/g, ' ');
}

// CLAIM-OPERATIONS-WIRING (Phase C1) — recommendation chip per task row.
// Reads through the canonical `resolve_ndr_branch_next_action_v1` RPC
// (supabase/migrations/202604101380_b09_return_to_branch_intake_visibility_replay_v1.sql:271)
// so the operator sees the policy-resolved next action without leaving the
// queue. Falls back to a `(metadata missing)` chip when the row carries no
// canonical `tasks.metadata.dispatch_exception_reason` so operators see
// the gap rather than a silent neutral default.
//
// W54-C closure — subject-substring inference removed. The previous
// inline switch hardcoded a brittle keyword → reason mapping that would
// silently misroute when the operator/portal subject text drifted. We
// now read the canonical `metadata.dispatch_exception_reason` directly,
// and the chip tone resolves via the canonical `ndr_branch_next_action`
// lookup_values metadata.tone (NO inline ternary).
function RecommendedChip({ task }: { task: TaskRow }) {
  const { scope } = useIdentity();
  const meta = (task.metadata ?? {}) as { dispatch_exception_reason?: string };
  const reason = meta.dispatch_exception_reason ?? null;
  const orgId = scope.tenant?.id ?? null;
  const { data, isLoading } = useNdrBranchNextAction(
    {
      organization_id: orgId,
      dispatch_exception_reason: reason,
      task_type_key: task.task_type,
      allowed_ndr_actions: task.allowed_actions ?? null,
    },
    !!orgId && !!reason,
  );
  if (!reason) {
    return <Chip size="xs" kind="warn" label="(metadata missing)" />;
  }
  if (!orgId) {
    return <span className="state__hint" style={{ fontSize: '11px' }}>—</span>;
  }
  if (isLoading || !data) {
    return <span className="state__hint" style={{ fontSize: '11px' }}>resolving…</span>;
  }
  const row = lookupRow('ndr_branch_next_action', data) as { tone?: string; label?: string } | null;
  const tone = (row?.tone as 'good' | 'warn' | 'danger' | 'info' | undefined) ?? 'danger';
  // Chip label keeps the raw canonical action value (e.g. `reschedule`)
  // so the operator sees the SSOT enum identifier directly.
  return <Chip size="xs" kind={tone} label={data} />;
}

export function ExceptionsModule() {
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.SHIPMENTS_READ);
  const canWriteTasks = useCapability(CAP.TASKS_WRITE);
  const drawer = useDrawer();
  const modal = useModal();
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const transition = useTransitionTask();
  const resolveExc = useDispatchExceptionResolution();
  const tasksQuery = useTasks({ task_type: 'dispatch_exception_review' }, readQueryOptions);
  const { data: tasksData, isLoading } = tasksQuery;
  const [resolutionReadback, setResolutionReadback] = useState<ExceptionResolutionReadback | null>(null);
  // AGENTS.md §2/§3: SLA-warn boundary resolves strictly from canonical
  // `task_sla_thresholds.sla_warn_minutes_before_breach` (W30 policy seed).
  const slaPolicy = useResolveSettings('task_sla_thresholds', undefined, readQueryOptions);
  const slaWarnMinutes = (slaPolicy.data?.value as { sla_warn_minutes_before_breach?: number } | undefined)?.sla_warn_minutes_before_breach;

  const tasks = (tasksData ?? []) as TaskRow[];
  const openedFocusRef = useRef<string | null>(null);

  const columns: Array<DataTableColumn<TaskRow>> = useMemo(
    () => [
      { key: 'task_id', label: 'Task', mono: true, sortable: true },
      { key: 'subject', label: 'Subject', sortable: true, filterable: true },
      { key: 'attempt_count', label: 'Attempts', align: 'right', sortable: true, type: 'number' },
      {
        key: 'sla_due_at',
        label: 'SLA',
        sortable: true,
        // Render the absolute timestamp + a relative countdown chip so operators
        // can scan urgency without doing the math. Datatype stays datetime so
        // sort works correctly.
        render: (raw) => {
          const iso = String(raw ?? '');
          if (!iso) return <span className="state__hint">—</span>;
          if (slaWarnMinutes == null) {
            return <span className="state__hint" title="SLA timing settings are unavailable">—</span>;
          }
          const { label, tone } = formatSlaCountdown(iso, slaWarnMinutes);
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                {new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <Chip size="xs" kind={tone} label={label} />
            </span>
          );
        },
      },
      // CLAIM-OPERATIONS-WIRING (Phase C1) — render a "Recommended" chip
      // sourced from the canonical resolve_ndr_branch_next_action_v1 RPC
      // (per __audit__/CROSSWALK/OPERATIONS.md gap row). The chip shows the
      // operator the policy-resolved next action so they don't have to guess.
      {
        key: 'recommended',
        label: 'Recommended',
        sortable: false,
        filterable: false,
        render: (_raw, row) => <RecommendedChip task={row} />,
      },
      { key: 'status', label: 'Status', lookup: 'task_status', sortable: true, filterable: true, editable: true },
    ],
    [slaWarnMinutes],
  );

  function openShipmentContext(shipmentId: string) {
    openShipmentContextDrawer(drawer, shipmentId);
  }

  async function recordExceptionResolutionReadback(
    task: TaskRow,
    action: string,
    result: unknown,
  ): Promise<ExceptionResolutionReadback> {
    const refreshed = await tasksQuery.refetch();
    const nextTasks = (refreshed.data ?? []) as TaskRow[];
    const refreshedTask = nextTasks.find((candidate) => candidate.id === task.id);
    const rec = result as {
      canonical_entrypoint?: string;
      settings_resolution_id?: string;
      apply_status?: string;
      results?: Array<Record<string, unknown>>;
    };
    const firstResult = rec.results?.[0] ?? {};
    const readback: ExceptionResolutionReadback = {
      taskId: task.id,
      taskLabel: task.task_id ?? task.id,
      subject: task.subject ?? '',
      action,
      rpc: 'ui_execute_dispatch_exception_resolution_v1',
      canonicalEntrypoint: rec.canonical_entrypoint ?? '',
      settingsResolutionId: rec.settings_resolution_id ?? '',
      applyStatus: rec.apply_status ?? '',
      taskEventId: String(firstResult.task_event_id ?? firstResult.resolution_task_event_id ?? ''),
      workflowRunId: String(firstResult.workflow_run_id ?? firstResult.resolution_workflow_run_id ?? ''),
      shipmentActionId: String(firstResult.shipment_action_id ?? firstResult.resolution_direct_shipment_action_id ?? ''),
      rowStatus: refreshedTask?.status ?? 'not visible',
      queueCount: nextTasks.length,
      rowVisible: Boolean(refreshedTask),
    };
    const terminalStatus = String(readback.rowStatus).toLowerCase();
    if (!readback.rowVisible || !['completed', 'resolved', 'closed'].includes(terminalStatus)) {
      throw new Error(
        `Exception resolution status is not current for ${readback.taskLabel}: ${readback.rowStatus}`,
      );
    }
    setResolutionReadback(readback);
    return readback;
  }

  async function applyExceptionResolutionWithReadback(task: TaskRow, resolution: unknown) {
    const action =
      typeof resolution === 'string'
        ? resolution
        : resolution && typeof resolution === 'object'
          ? String((resolution as Record<string, unknown>).resolution_action ?? '')
          : '';
    if (!action) throw new Error('resolution_action is required');
    const result = await resolveExc.mutateAsync({ taskId: task.id, resolution });
    return recordExceptionResolutionReadback(task, action, result);
  }

  function notifyExceptionResolutionError(err: unknown) {
    pushToast('Exception resolution could not be completed. Try again.', 'danger');
  }

  function openExceptionDrawer(task: TaskRow) {
    drawer.open({
      title: `${task.task_id} · ${task.subject ?? ''}`,
      size: 'xl',
      body: <ExceptionDetail task={task} />,
    });
  }

  useEffect(() => {
    const focus = readUrlParam('task') ?? readUrlParam('focus');
    if (!focus || isLoading || openedFocusRef.current === focus) return;
    const match = tasks.find(
      (task) =>
        task.id === focus ||
        task.task_id === focus ||
        task.resource_id === focus ||
        task.shipment_id === focus,
    );
    if (!match) return;
    openedFocusRef.current = focus;
    openExceptionDrawer(match);
  }, [isLoading, tasks]);

  // Resolution controls are rendered in the drawer body so Browser/IAB clicks
  // exercise the same visible workflow without competing with the status rail.
  function ExceptionResolutionControls({ task }: { task: TaskRow }) {
    const allowed = task.allowed_actions ?? [];
    const status = String(task.status ?? '').toLowerCase();
    const isTerminal = ['completed', 'resolved', 'closed', 'cancelled', 'canceled'].includes(status);
    // CYCLE-E2 STRICT-ISOLATION (P2 #4) — drop the silent default literal so
    // the chip group + Apply button stay disabled when the canonical
    // `task_type_catalog.allowed_actions` row is empty. The control surfaces a
    // fail-loud StateView in that case rather than masking missing config.
    const [chosen, setChosen] = useState<string>(allowed[0] ?? '');
    const [notes, setNotes] = useState<string>('');
    const [applying, setApplying] = useState(false);
    const [previewing, setPreviewing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [previewReadback, setPreviewReadback] = useState<ExceptionResolutionPreviewReadback | null>(null);
    const applyingRef = useRef(false);
    const previewingRef = useRef(false);
    const evidenceMissing = !!task.evidence_required && notes.trim().length === 0;
    const noActionsAllowed = allowed.length === 0;

    if (isTerminal) {
      return (
        <StateView
          kind="empty"
          title="Resolved"
          hint={`Recovery action is already resolved for this task (${status}).`}
        />
      );
    }

    if (noActionsAllowed) {
      return (
        <StateView
          kind="error"
          hint="No recovery actions are configured for this exception."
        />
      );
    }

    const applyCurrentResolution = async () => {
      if (!chosen || applyingRef.current) return;
      applyingRef.current = true;
      setApplying(true);
      setError(null);
      try {
        const readback = await applyExceptionResolutionWithReadback(task, {
          resolution_action: chosen,
          notes: notes.trim() || null,
        });
        pushToast(`Resolution applied - ${ndrActionLabel(chosen)}`, 'good');
        drawer.close();
      } catch (err) {
        setError('Exception resolution could not be completed. Try again.');
        notifyExceptionResolutionError(err);
      } finally {
        applyingRef.current = false;
        setApplying(false);
      }
    };

    const previewCurrentResolution = async () => {
      if (!chosen || previewingRef.current) return;
      previewingRef.current = true;
      setPreviewing(true);
      setError(null);
      try {
        const result = await resolveExc.mutateAsync({
          taskId: task.id,
          resolution: {
            resolution_action: chosen,
            notes: notes.trim() || null,
          },
          dryRun: true,
        });
        const rec = result as {
          canonical_entrypoint?: string;
          settings_resolution_id?: string;
          policy?: string;
          apply_status?: string;
          dry_run?: boolean;
          results?: Array<unknown>;
        };
        setPreviewReadback({
          taskLabel: task.task_id ?? task.id,
          action: chosen,
          canonicalEntrypoint: rec.canonical_entrypoint ?? 'public.ui_execute_dispatch_exception_resolution_v1',
          settingsResolutionId: rec.settings_resolution_id ?? '-',
          policy: rec.policy ?? 'ndr_policy',
          applyStatus: 'preview',
          resultCount: Array.isArray(rec.results) ? rec.results.length : 0,
        });
        pushToast(`Preview ready - ${ndrActionLabel(chosen)}`, 'info');
      } catch (err) {
        setPreviewReadback(null);
        setError('Preview could not be prepared. Try again.');
        notifyExceptionResolutionError(err);
      } finally {
        previewingRef.current = false;
        setPreviewing(false);
      }
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {allowed.map((a) => (
            <button
              key={a}
              type="button"
              className={`chip ${a === chosen ? 'chip--info' : ''}`}
              style={{ cursor: 'pointer', padding: '6px 10px' }}
              title={a}
              onClick={() => setChosen(a)}
            >
              {ndrActionLabel(a)}
            </button>
          ))}
        </div>
        <div className="field">
          <label className="field__label">
            Notes
            {task.evidence_required ? (
              <span className="mono" style={{ color: 'var(--ink-3)', marginLeft: '6px' }}>
                - required
              </span>
            ) : null}
          </label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Driver verified address with recipient. Reschedule to tomorrow 14:00–16:00."
          />
        </div>
        <div style={{ display: 'flex', gap: '8px', width: '100%', flexWrap: 'wrap' }}>
          <ExceptionActionButton
            label="Escalate"
            iconName="warn"
            kind="ghost"
            size="sm"
            canWrite={canWriteTasks}
            onClick={async () => {
              await transition.mutateAsync({ taskId: task.id, transition: { next_status: taskActionNextStatus('escalate') } });
              pushToast('Exception escalated', 'warn');
              drawer.close();
            }}
          />
          <ExceptionActionButton
            label={chosen ? (previewing ? `Previewing ${ndrActionLabel(chosen)}` : `Preview ${ndrActionLabel(chosen)}`) : 'Preview'}
            iconName="play"
            kind="ghost"
            size="sm"
            canWrite={canWriteTasks}
            disabled={!chosen || previewing}
            onClick={() => void previewCurrentResolution()}
          />
          <ExceptionActionButton
            label={chosen ? (applying ? `Applying ${ndrActionLabel(chosen)}` : `Apply ${ndrActionLabel(chosen)}`) : 'Apply'}
            iconName="check"
            kind="primary"
            size="sm"
            canWrite={canWriteTasks}
            disabled={applying || evidenceMissing || !chosen}
            title={
              !chosen
                ? 'Select an action before apply'
                : evidenceMissing
                  ? 'Evidence required: add notes before apply'
                  : undefined
            }
            onClick={() => void applyCurrentResolution()}
          />
        </div>
        {evidenceMissing ? (
          <StateView
            kind="error"
            title="Evidence required"
            hint="Evidence required: add notes before apply."
          />
        ) : null}
        {previewReadback ? (
          <section
            className="panel"
            aria-label="Exception resolution preview"
            style={{ display: 'grid', gap: '8px', padding: '10px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Chip size="sm" kind="info" label="Preview ready" />
              <span className="state__hint">
                {ndrActionLabel(previewReadback.action)} will be applied through the canonical NDR path.
              </span>
            </div>
            <div className="card">
              <Kv k="Task" v={<span className="mono">{previewReadback.taskLabel}</span>} />
              <Kv k="Action" v={ndrActionLabel(previewReadback.action)} />
              <Kv k="Canonical path" v={previewReadback.canonicalEntrypoint} />
              <Kv k="Policy" v={previewReadback.policy} />
              <Kv k="Policy check" v={previewReadback.settingsResolutionId !== '-' ? 'Passed' : 'Pending'} />
              <Kv k="Preview status" v={previewReadback.applyStatus || 'preview'} />
              <Kv k="Rows affected after commit" v={String(previewReadback.resultCount)} />
            </div>
          </section>
        ) : null}
        {error ? <StateView kind="error" hint={error} /> : null}
      </div>
    );
  }

  function ExceptionDetail({ task }: { task: TaskRow }) {
    const openLinkedShipment = () => {
      if (!task.shipment_id) {
        pushToast('No shipment is linked to this exception task.', 'warn');
        return;
      }
      openShipmentContext(task.shipment_id);
    };
    const summaryRows: KvRow[] = [
      { key: 'task_id', label: 'Task ID', value: task.task_id, mono: true, editable: false },
      { key: 'task_type', label: 'Type', value: task.task_type, lookup: 'task_type' },
      { key: 'shipment_id', label: 'Shipment', value: task.shipment_id ?? '—', mono: true },
      { key: 'attempt_count', label: 'Attempt #', value: String(task.attempt_count ?? 0), mono: true },
      { key: 'sla_due_at', label: 'SLA due', value: new Date(task.sla_due_at).toLocaleString() },
      { key: 'status', label: 'Status', value: task.status, lookup: 'task_status' },
    ];

    const tabs: RelatedTab[] = [
      // W56-B-2 closure (F6) — Shipment tab is now a React component
      // (ShipmentSnapshotTab) that consumes the canonical
      // `useResourceList<Record<string, unknown>>('shipments')` registry seam
      // instead of `api.seed.shipments()`.
      { id: 'shipment', label: 'Shipment', count: 1, render: () => <ShipmentSnapshotTab task={task} /> },
      // CLAIM-OPERATIONS-WIRING (Phase C1) — Attempts + Events tabs now use
      // canonical resource registry (`useResourceList('task_events')`) instead
      // of `api.seed.taskEvents()`. Both surfaces are React components so the
      // hook can subscribe to the correct query key.
      { id: 'attempts', label: 'Attempts', count: task.attempt_count ?? 0, render: () => <AttemptsTab task={task} /> },
      { id: 'task_events', label: 'Events', render: () => <TaskEventsTab task={task} /> },
      { id: 'related', label: 'Related tasks', render: () => renderRelatedTasksTab(task) },
      { id: 'decisions', label: 'Decisions', render: () => renderDecisionsTab(task) },
      { id: 'audit', label: 'Audit', render: () => renderAuditTab(task) },
    ];

    const summary: ReactNode = (
      <div className="rail-body" style={{ paddingBottom: 0 }}>
        <h4 className="eyebrow">Task</h4>
        <KvGrid
          rows={summaryRows}
          onEdit={async (key, value) => {
            if (key === 'status') {
              await transition.mutateAsync({ taskId: task.id, transition: { next_status: String(value) } });
            }
            pushToast(`Saved · ${key}`, 'good');
          }}
        />
        <h4 className="eyebrow" style={{ marginTop: '14px' }}>
          Resolution options
        </h4>
        <p className="state__hint" style={{ marginTop: '6px' }}>
          Pick an action and notes below. Preview checks the recommendation without changing state.
          Apply records the final decision and evidence trail.
        </p>
        <ExceptionResolutionControls task={task} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
          <Button
            label="Open shipment"
            iconName="package"
            kind="ghost"
            capability={CAP.SHIPMENTS_READ}
            onClick={openLinkedShipment}
          />
        </div>
      </div>
    );

    return <RelatedRail summary={summary} tabs={tabs} defaultTab="shipment" />;
  }

  // Bulk dry-run summary modal — reuses existing Modal primitive.
  function openBulkSummary(rs: TaskRow[], resolution: string, results: BulkSummaryRow[]) {
    const okCount = results.filter((r) => r.outcome === 'ok').length;
    const blockedCount = results.filter((r) => r.outcome === 'blocked').length;
    const errorCount = results.filter((r) => r.outcome === 'error').length;
    const confirmBulkApply = async () => {
      if (okCount === 0) return;
      // Apply only the rows that previewed ok.
      const okRows = results
        .filter((r) => r.outcome === 'ok')
        .map((r) => rs.find((rr) => rr.id === r.task_id))
        .filter((r): r is TaskRow => Boolean(r));
      try {
        await Promise.all(okRows.map((r) => applyExceptionResolutionWithReadback(r, resolution)));
        pushToast(`Bulk resolution applied - ${okRows.length} exceptions`, 'good');
        modal.close();
      } catch (err) {
        notifyExceptionResolutionError(err);
      }
    };
    modal.open({
      title: `Bulk ${ndrActionLabel(resolution)} · preview`,
      body: (
        <div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <Chip size="sm" kind="good" label={`${okCount} ok`} />
            {blockedCount > 0 ? <Chip size="sm" kind="warn" label={`${blockedCount} blocked`} /> : null}
            {errorCount > 0 ? <Chip size="sm" kind="danger" label={`${errorCount} error`} /> : null}
          </div>
          <DataTable
            columns={[
              { key: 'task_id', label: 'Task', mono: true },
              { key: 'shipment_id', label: 'Shipment', mono: true },
              { key: 'outcome', label: 'Outcome' },
              { key: 'reason', label: 'Reason' },
            ]}
            rows={results}
            allowSelection={false}
          />
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' }}>
            <Button label="Close" kind="ghost" onClick={() => modal.close()} />
            <ExceptionActionButton
              label={`Confirm apply · ${okCount}`}
              iconName="play"
              kind="primary"
              canWrite={canWriteTasks}
              disabled={okCount === 0}
              onClick={() => void confirmBulkApply()}
            />
          </div>
        </div>
      ),
    });
  }

  async function runBulkPreview(rs: TaskRow[], resolution: string) {
    // Build per-row preview results. Row is "blocked" if it doesn't list the
    // chosen resolution in allowed_actions; otherwise dry-run hits the canonical
    // RPC. We don't currently have a per-row error path from the synthetic
    // adapter, so error is a future-proof category.
    const results: BulkSummaryRow[] = await Promise.all(
      rs.map(async (r): Promise<BulkSummaryRow> => {
        if (!(r.allowed_actions ?? []).includes(resolution)) {
          return {
            task_id: r.id,
            shipment_id: r.shipment_id,
            outcome: 'blocked',
            reason: 'This action is not available for the selected exception.',
          };
        }
        try {
          await resolveExc.mutateAsync({ taskId: r.id, resolution, dryRun: true });
          return { task_id: r.id, shipment_id: r.shipment_id, outcome: 'ok' };
        } catch (e) {
          return {
            task_id: r.id,
            shipment_id: r.shipment_id,
            outcome: 'error',
            reason: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    openBulkSummary(rs, resolution, results);
  }

  const pills: ReactNode[] = [
    // W56-C closure — `scopeType="tenant"` is the canonical resource-tier literal
    // (NDR exception review queue scopes via current_user_org_id()).
    // `scopeId` is identity-derived. See shipments.tsx top-of-file SSOT note.
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip
      key="seam"
      size="xs"
      label="Exception recovery policy"
    />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="exceptions"
          eyebrow="Operate"
          titleAccent="Exceptions"
          titlePlain="queue (NDR)"
        />
        <StateView
          kind="denied"
          capability={CAP.SHIPMENTS_READ}
          hint="You do not have permission to view the exceptions queue."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="exceptions"
        eyebrow="Operate"
        titleAccent="Exceptions"
        titlePlain="queue (NDR)"
        pills={pills}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<TaskRow>
          columns={columns}
          rows={tasks}
          viewKey="tasks_ndr"
          entityKind="task"
          onRowClick={openExceptionDrawer}
          getRowClass={(tk) => (new Date(tk.sla_due_at).getTime() < Date.now() ? 'is-risk' : undefined)}
          onCellEdit={async (row, key, value) => {
            // W19-4 schema-drift closure (OPERATIONS §4): align cell-edit
            // contract with the canonical W16-1 TasksTab pattern in
            // shipments.tsx. Status edits route through the canonical
            // `transition_task_v1` RPC; non-status keys fail-closed (the
            // remaining columns — task_id, subject, attempt_count, sla_due_at,
            // recommended — are either canonical PK aliases, projection-derived,
            // or driven by policy resolution and have no safe direct-write
            // mutator). Failures roll back the optimistic edit.
            if (key !== 'status') {
              return { ok: false, message: `Field ${key} is read-only` };
            }
            try {
              await transition.mutateAsync({
                taskId: row.id,
                transition: { next_status: String(value) },
              });
              pushToast('Status saved', 'good');
              return { ok: true };
            } catch {
              pushToast('Status could not be saved. Try again.', 'danger');
              return { ok: false, message: 'Status could not be saved. Try again.' };
            }
          }}
          bulkActions={[
            {
              label: 'Bulk reschedule (preview)',
              icon: 'history',
              kind: 'primary',
              capability: CAP.TASKS_WRITE,
              onClick: (rs) => runBulkPreview(rs, 'reschedule'),
            },
            {
              label: 'Return to branch (preview)',
              icon: 'rotate',
              capability: CAP.TASKS_WRITE,
              onClick: (rs) => runBulkPreview(rs, NDR_RETURN_TO_BRANCH_ACTION),
            },
            {
              label: 'Escalate',
              icon: 'warn',
              capability: CAP.TASKS_WRITE,
              onClick: async (rs) => {
                const nextStatus = taskActionNextStatus('escalate');
                if (!nextStatus) {
                  pushToast('task_action_kind.escalate next_status missing', 'danger');
                  return;
                }
                await Promise.all(
                  rs.map((r) => transition.mutateAsync({ taskId: r.id, transition: { next_status: nextStatus } })),
                );
                pushToast(`Escalated ${rs.length} tasks`, 'warn');
              },
            },
          ]}
          rowActions={[
            { label: 'Open task', icon: 'eye', onClick: openExceptionDrawer },
            {
              label: 'Open shipment',
              icon: 'package',
              capability: CAP.SHIPMENTS_READ,
              onClick: (r) => {
                if (!r.shipment_id) {
                  pushToast('No shipment is linked to this exception task.', 'warn');
                  return;
                }
                openShipmentContext(r.shipment_id);
              },
            },
            {
              label: 'Preview reschedule',
              icon: 'check',
              capability: CAP.TASKS_WRITE,
              onClick: async (r) => {
                if (!(r.allowed_actions ?? []).includes('reschedule')) {
                  pushToast('Reschedule is not available for this exception.', 'warn');
                  return;
                }
                await resolveExc.mutateAsync({ taskId: r.id, resolution: 'reschedule', dryRun: true });
                pushToast('Preview · ok', 'info');
              },
            },
            {
              label: 'Apply (reschedule)',
              icon: 'play',
              kind: 'primary',
              capability: CAP.TASKS_WRITE,
              onClick: async (r) => {
                if (!(r.allowed_actions ?? []).includes('reschedule')) {
                  pushToast('Reschedule is not available for this exception.', 'warn');
                  return;
                }
                try {
                  await applyExceptionResolutionWithReadback(r, 'reschedule');
                  pushToast('Applied | reschedule', 'good');
                } catch (err) {
                  notifyExceptionResolutionError(err);
                }
              },
            },
            {
              label: 'Preview cancel',
              icon: 'close',
              capability: CAP.TASKS_WRITE,
              onClick: async (r) => {
                if (!(r.allowed_actions ?? []).includes('cancel')) {
                  pushToast('Cancel is not available for this exception.', 'warn');
                  return;
                }
                await resolveExc.mutateAsync({ taskId: r.id, resolution: 'cancel', dryRun: true });
                pushToast('Cancel preview - ok', 'warn');
              },
            },
            {
              label: 'Apply cancel',
              icon: 'close',
              kind: 'danger',
              capability: CAP.TASKS_WRITE,
              onClick: async (r) => {
                if (!(r.allowed_actions ?? []).includes('cancel')) {
                  pushToast('Cancel is not available for this exception.', 'warn');
                  return;
                }
                try {
                  await applyExceptionResolutionWithReadback(r, 'cancel');
                  pushToast('Applied - cancel', 'good');
                } catch (err) {
                  notifyExceptionResolutionError(err);
                }
              },
            },
          ]}
        />
      )}

      {resolutionReadback ? <ExceptionResolutionReadbackPanel readback={resolutionReadback} /> : null}

      {drawer.node}
      {modal.node}
    </div>
  );
}

function ExceptionResolutionReadbackPanel({ readback }: { readback: ExceptionResolutionReadback }) {
  return (
    <section
      className="panel"
      aria-label="Exception resolution status"
      style={{ marginTop: '14px', display: 'grid', gap: '10px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 14px' }}>
        <Chip size="sm" kind="good" label="Exception resolution updated" />
        <span className="state__hint">Action completed and the exception queue was refreshed</span>
      </div>
      <div className="card">
        <Kv k="Task" v={<span className="mono">{readback.taskLabel}</span>} />
        <Kv k="Subject" v={readback.subject || '-'} />
        <Kv k="Action" v={ndrActionLabel(readback.action)} />
        <Kv k="Policy check" v={readback.settingsResolutionId ? 'Passed' : 'Pending'} />
        <Kv k="Result" v={readback.applyStatus ? 'Applied' : 'Pending'} />
        <Kv k="Activity" v={readback.taskEventId || readback.shipmentActionId ? 'Recorded' : 'Pending'} />
        <Kv k="Workflow" v={readback.workflowRunId ? 'Updated' : 'Pending'} />
        <Kv
          k="Queue status"
          v={`${readback.queueCount} tasks; selected exception ${readback.rowVisible ? `updated (${readback.rowStatus})` : 'awaiting refresh'}`}
        />
      </div>
    </section>
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

// ---------- Tab renderers (pure functions returning ReactNodes) ----------

// W56-B-2 closure (F6) — converted from `async function renderShipmentTab(task)`
// (which read `api.seed.shipments()` directly) to a canonical React component
// that consumes `useResourceList<Record<string, unknown>>('shipments')`. The
// shipment row is filtered client-side because the task surface holds a
// shipment id OR a tracking number (legacy projection).
function ShipmentSnapshotTab({ task }: { task: TaskRow }): ReactNode {
  const shipmentsQuery = useCompleteResourceList<Record<string, unknown>>('shipments');
  if (!task.shipment_id) return <div className="state__hint">No shipment linked.</div>;
  if (shipmentsQuery.isLoading) return <StateView kind="loading" />;
  const ships = shipmentsQuery.data?.rows ?? [];
  const s = ships.find((sh) => sh.id === task.shipment_id || sh.tracking_number === task.shipment_id);
  if (!s) return <div className="state__hint">{`Shipment ${task.shipment_id} not found through shipment registry.`}</div>;
  // W13-5 — closes OPERATIONS D3 §6 (Exceptions ShipmentSnapshotTab orphan-toast).
  // Per the deferred decision doc (`__audit__/DECISIONS/SHIPMENTS-DRAWER-CELL-EDITS.md`
  // §5), the exceptions surface is a read-only context panel; per-field
  // amend-cancel must happen on the shipments-drawer (where amend
  // capabilities/policy gates are surfaced together). Flipping all rows to
  // `editable: false` removes the orphan-toast affordance and forces the
  // canonical write path through the shipments surface.
  const rows: KvRow[] = [
    { key: 'tracking_number', label: 'Tracking', value: s.tracking_number, mono: true, editable: false },
    { key: 'status', label: 'Status', value: s.status, lookup: 'shipment_status', editable: false },
    { key: 'service_type', label: 'Service', value: s.service_type, lookup: 'service_type', editable: false },
    { key: 'destination_city', label: 'Destination', value: s.destination_city, editable: false },
    { key: 'cod_amount', label: 'COD', value: s.cod_amount, editable: false },
  ];
  return (
    <div>
      <div className="state__hint" style={{ padding: '6px 14px' }}>
        Read-only shipment snapshot. Edit fields on the Shipments surface
        drawer to route through `shipment_amend_cancel_v1` policy/lock gates.
      </div>
      <KvGrid rows={rows} />
    </div>
  );
}

// CLAIM-OPERATIONS-WIRING (Phase C1) — AttemptsTab + TaskEventsTab now read
// task_events through the canonical resource registry
// (`useResourceList('task_events', { filter: { task_id }})`). The legacy
// async render helpers consumed `api.seed.taskEvents()` directly which
// would have returned empty rows on production swap (gap row in
// __audit__/CROSSWALK/OPERATIONS.md).
function AttemptsTab({ task }: { task: TaskRow }) {
  const { data, isLoading } = useCompleteResourceList<Record<string, unknown>>('task_events', {
    filter: { task_id: task.id },
    sort: { key: 'occurred_at', dir: 'asc' },
  });
  if (isLoading) return <StateView kind="loading" />;
  const events = data?.rows ?? [];
  if (events.length === 0) {
    return (
      <div className="state__hint">
        No activity has been recorded for this task yet. Driver attempt outcomes will appear here when delivery attempts are completed.
      </div>
    );
  }
  return (
    <div className="timeline" style={{ padding: 0 }}>
      {events.map((e, i) => (
        <div key={String((e as { id?: string }).id ?? i)} className="timeline__row">
          <span className="timeline__node" />
          <span className="timeline__time mono">
            {new Date(String((e as { occurred_at?: string }).occurred_at ?? '')).toLocaleString()}
          </span>
          <div className="timeline__body">
            <div className="timeline__action">{`${String((e as { event?: string }).event ?? '')} · ${String((e as { actor?: string }).actor ?? '')}`}</div>
            {(e as { notes?: string }).notes ? (
              <div className="timeline__detail">{String((e as { notes: string }).notes)}</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskEventsTab({ task }: { task: TaskRow }) {
  const { data, isLoading } = useCompleteResourceList<Record<string, unknown>>('task_events', {
    filter: { task_id: task.id },
  });
  if (isLoading) return <StateView kind="loading" />;
  return (
    <DataTable
      columns={[
        { key: 'occurred_at', label: 'When', format: 'datetime' },
        { key: 'event', label: 'Event' },
        { key: 'actor', label: 'Actor', mono: true },
        { key: 'notes', label: 'Notes' },
      ]}
      rows={data?.rows ?? []}
      allowSelection={false}
      emptyText="No activity recorded yet."
    />
  );
}

async function renderRelatedTasksTab(task: TaskRow): Promise<ReactNode> {
  const all = (await api.listTasks()) as TaskRow[];
  const related = all.filter((tt) => tt.shipment_id === task.shipment_id && tt.id !== task.id);
  return (
    <DataTable
      columns={[
        { key: 'task_id', label: 'Task', mono: true },
        { key: 'task_type', label: 'Type', lookup: 'task_type' },
        { key: 'subject', label: 'Subject' },
        { key: 'status', label: 'Status', lookup: 'task_status' },
      ]}
      rows={related}
      allowSelection={false}
      emptyText="No other tasks for this shipment."
    />
  );
}

async function renderDecisionsTab(task: TaskRow): Promise<ReactNode> {
  const all = await api.listDecisionLog({});
  // W71-Operate (Cycle F-R-11) closure — NDR-related decision filter
  // resolves through canonical `decision_category.metadata.is_ndr_related`
  // instead of an inline `'ndr_resolution'` literal compare. AGENTS.md §2
  // (ZERO HARDCODING) + §6 (row-driven by configuration).
  const rows = all
    .filter(
      (d) =>
        lookupRow('decision_category', d.decision_category)?.metadata?.is_ndr_related === true ||
        d.resource_id === task.id ||
        d.resource_id === task.shipment_id,
    )
    .slice(0, 10);
  return (
    <DataTable
      columns={[
        { key: 'occurred_at', label: 'When', format: 'datetime' },
        { key: 'decision_category', label: 'Category', lookup: 'decision_category' },
        { key: 'resolved_from', label: 'Scope' },
        { key: 'settings_resolution_id', label: 'Resolution', mono: true },
      ]}
      rows={rows.length ? rows : all.slice(0, 4)}
      allowSelection={false}
    />
  );
}

async function renderAuditTab(task: TaskRow): Promise<ReactNode> {
  try {
    const all = await api.listAuditLog({});
    const rows = (all as Array<Record<string, unknown>>)
      .filter((a) => a.pk === task.id || a.table === 'tasks')
      .slice(0, 20);
    return (
      <DataTable
        columns={[
          { key: 'occurred_at', label: 'When', format: 'datetime' },
          { key: 'op', label: 'Op' },
          { key: 'actor', label: 'Actor', mono: true },
        ]}
        rows={rows.length ? rows : (all as Array<Record<string, unknown>>).slice(0, 4)}
        allowSelection={false}
      />
    );
  } catch {
    return (
      <div className="state state--denied">
        <h3 className="state__title">Audit access denied</h3>
        <p className="state__hint">Audit activity permission is required.</p>
      </div>
    );
  }
}

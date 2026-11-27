// workflows/review-queue.tsx — Linear-style two-pane manual review queue.
// Filter chips · per-row SLA ring · keyboard nav · bulk action bar.
// Ports apps/console/demo-v2/assets/js/modules/wf-review-queue.js to TypeScript/React.
//
// Action surface is row-driven: `task.allowed_actions` is the source of truth
// (no hardcoded task_type switch). The deterministic fallback is the
// `task_type_catalog` defaults map in `_review-queue/views.ts` — kept as a
// catalog lookup, not behavior in code. Snooze persists `snooze_until` ISO
// through `useTransitionTask` so the seam mock (and eventually the real
// `transition_task_v1` RPC) lands the duration on the task row.

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Dot } from '@/components/Dot';
import { Icon } from '@/components/Icon';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import { useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useTasks,
  useTransitionTask,
  useAssignTask,
  useResource,
  useResourceList,
  useResolveSettings,
  useBulkTransitionTasks,
  refreshFinanceWorkflowReadModels,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { getLookups, lookupRow, open_ops_session_v1, progress_workflow_run_until_wait_v1 } from '@/lib/api';
import { readUrlParam } from '@/lib/url-params';
import type { ChipKind } from '@/components/Chip';
import {
  listSavedViews,
  saveView,
  deleteView,
  matchesSearch,
  resolveAllowedActions,
  nextStatusForAction,
  snoozeUntil,
  formatTimeUntilCanonical,
  type ActionDescriptor,
  type DurationFormatPolicy,
  type SavedView,
} from './_review-queue/views';
import { fill, useI18n } from '@/lib/i18n';

type FilterId = 'mine' | 'queue' | 'all' | 'breach' | 'snoozed';
type SortMode = 'sla_due' | 'priority' | 'created';

// Wave 10 schema-drift close-out (W10-6) + W16-3 verification — see
// __audit__/SCHEMA-DRIFT/WORKFLOWS.md §7 + W16-3 closure note. W16-3 verified
// every Task / WorkflowRun field on this surface is canonical, a fabricated
// display alias, or a documented projection. Renames stay deferred for RPC
// contract switches (queue→queue_key, status→workflow_status,
// template_id→workflow_template_id).
// W6 annotations are now applied. Display-only and projection-shaped fields
// (task_id/subject/description/snooze_until/allowed_actions) remain on the
// interface as projections (sourced via task_type_catalog policy or
// metadata access patterns); the production swap to `ui_read_registry.tasks`
// projection RPC will continue to honor these field names.
//
// Renames deferred (consumer cascade + RPC contract):
//   - Task.queue                  -> queue_key
//   - WorkflowRun.template_id     -> workflow_template_id
//   - WorkflowRun.status          -> workflow_status
// Renames applied (W14-3):
//   - Task.sla_breach_at          -> sla_due_at (canonical column on public.tasks
//                                    per supabase/migrations/202601212300_tasks_ssot_core.sql:377)
interface Task extends Record<string, unknown> {
  id: string;                             // SSOT: tasks.id
  task_id: string;                        // SSOT: display alias (FE-fabricated TSK-* code; tests + filter chips)
  task_type: string;                      // SSOT: tasks.task_type_id (FK to task_types); registry projection deferred — extend ui_read_registry.tasks for task_type_key
  task_type_key?: string;                 // SSOT: api.tasks task_type_key projection
  status: string;                         // SSOT: tasks.status
  subject?: string;                       // SSOT: projection — metadata.subject
  description?: string;                   // SSOT: projection — metadata.description
  queue?: string;                         // SSOT: tasks.queue_key (RENAME deferred — RPC contract switch)
  queue_key?: string;                     // SSOT: api.tasks queue_key projection
  assigned_to?: string | null;            // SSOT: tasks.assigned_to
  priority?: string | number;             // SSOT: tasks.priority (canonical: integer; FE uses string label via lookup)
  created_at?: string;                    // SSOT: tasks.created_at
  sla_due_at?: string;                    // SSOT: tasks.sla_due_at (W14-3 rename applied)
  snooze_until?: string | null;           // SSOT: projection — metadata.snooze_until
  allowed_actions?: readonly string[] | null; // SSOT: projection — computed via task_type_catalog.allowed_actions or ndr_policy
  workflow_run_id?: string;               // SSOT: tasks.workflow_run_id
  metadata?: Record<string, unknown>;      // SSOT: tasks.metadata JSONB projection
}

interface WorkflowRun extends Record<string, unknown> {
  id: string;                             // SSOT: workflow_runs.id
  run_id: string;                         // SSOT: display alias (FE-fabricated WFR-* code)
  template_id: string;                    // SSOT: workflow_runs.workflow_template_id (RENAME deferred — RPC contract switch)
  template_name: string;                  // SSOT: projection — workflow_templates.name via join
  status: string;                         // SSOT: workflow_runs.workflow_status (RENAME deferred — RPC contract switch)
  correlation_id?: string | null;          // SSOT: workflow_runs.triggered_by_request_id -> request_contexts.correlation_id projection
  context?: Record<string, unknown>;       // SSOT: workflow_runs.context
}

interface CompletionPayloadField {
  key?: string;
  label?: string;
  type?: 'text' | 'number' | 'textarea';
  required?: boolean;
  min?: number;
  max?: number;
  step?: number | string;
  placeholder?: string;
  default_value?: unknown;
  default_from?: string;
}

interface CompletionPayloadSchema {
  action_kind?: string;
  next_status?: string;
  title?: string;
  description?: string;
  submit_label?: string;
  requires_session_type?: string;
  fields?: CompletionPayloadField[];
}

// Canonical audit ledger shape from public.audit_table_changes. Review queue
// consumes this through the existing ui_read_registry path instead of the
// legacy `useAuditLog()` adapter.
interface AuditTableChangeRow extends Record<string, unknown> {
  id?: string;
  table_name?: string;
  op?: string;
  pk?: unknown;
  row_old?: unknown;
  row_new?: unknown;
  changed_by?: string | null;
  correlation_id?: string | null;
  created_at?: string;
  subject_id?: string | null;
}

interface TaskEventRow extends Record<string, unknown> {
  id?: string;
  task_id?: string;
  event_type?: string;
  event?: string;
  from_status?: string | null;
  to_status?: string | null;
  actor_user_id?: string | null;
  actor_system?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown> | null;
  created_at?: string;
  occurred_at?: string;
  ops_session_id?: string | null;
}

type BulkTaskActionKind = 'claim' | 'resolve' | 'escalate' | 'reassign' | 'snooze';

interface BulkTaskActionReadback {
  kind: BulkTaskActionKind;
  total: number;
  taskIds: string[];
  confirmedTaskIds: string[];
  taskEventIds: string[];
  expectedAssignedTo?: string | null;
  expectedStatus?: string | null;
  expectedSnoozeUntil?: string | null;
  confirmedSnoozeUntil?: string | null;
  requestedAt: string;
}

interface TaskActionReadback {
  kind: string;
  taskId: string;
  taskDisplayId: string;
  taskEventId?: string | null;
  expectedAssignedTo?: string | null;
  expectedStatus?: string | null;
  expectedSnoozeUntil?: string | null;
  confirmedSnoozeUntil?: string | null;
  confirmed: boolean;
  requestedAt: string;
}

// Strict canonical resolver — `task_status` lookup_values.metadata.tone is the
// SSOT for status chip presentation. Missing canonical row returns
// `{ tone: null, label: null }` so callsites render an explicit
// danger-toned `(missing)` chip instead of silently masking the gap with a
// neutral default. See AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
function statusTone(s: string): { tone: ChipKind | null; label: string | null } {
  const row = lookupRow('task_status', s);
  return {
    tone: (row?.tone as ChipKind | undefined) ?? null,
    label: row?.label ?? null,
  };
}

// W64-Workflows (Cycle F-R-4 P1) — canonical "is this status snoozed?" reader.
// Replaces literal `t.status === 'snoozed'` checks across the review-queue
// surface (snoozed-tab filter, snoozed counter, wakes-in chips, snooze action
// pressed state). SSOT lives on the `task_status` lookup row's
// `metadata.is_snoozed` flag; adding a new snoozed-equivalent status flips a
// single seed bit instead of touching call sites. AGENTS.md §2/§4/§6.
function isTaskSnoozed(status: string): boolean {
  const row = lookupRow('task_status', status) as
    | { metadata?: { is_snoozed?: boolean } }
    | null;
  return row?.metadata?.is_snoozed === true;
}

function isTaskTerminal(status: string): boolean {
  const row = lookupRow('task_status', status) as
    | { metadata?: { is_terminal?: boolean } }
    | null;
  return row?.metadata?.is_terminal === true;
}

function stringFromUnknown(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordsFromUnknown(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    : [];
}

function readObjectPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  let cursor: unknown = root;
  for (const part of parts) {
    const obj = recordFromUnknown(cursor);
    if (!obj) return undefined;
    cursor = obj[part];
  }
  return cursor;
}

function taskParentWorkflowRunId(task: Task): string {
  return (
    stringFromUnknown(task.workflow_run_id) ||
    stringFromUnknown(task.metadata?.parent_workflow_run_id)
  );
}

function workflowRunStatusValue(run: WorkflowRun): string {
  return (
    stringFromUnknown(run.status) ||
    stringFromUnknown(run.workflow_status)
  );
}

function taskCompletionSchema(task: Task, action?: ActionDescriptor | null): CompletionPayloadSchema | null {
  const metadata = recordFromUnknown(task.metadata);
  if (!metadata) return null;
  const actionKind = action?.kind;
  const byAction = recordFromUnknown(metadata.completion_payload_schemas);
  const scoped = actionKind ? recordFromUnknown(byAction?.[actionKind]) : null;
  const direct = recordFromUnknown(metadata.completion_payload_schema);
  const raw = scoped ?? direct;
  if (!raw) return null;
  const schema = raw as CompletionPayloadSchema;
  if (schema.action_kind && actionKind && schema.action_kind !== actionKind) return null;
  return Array.isArray(schema.fields) && schema.fields.length > 0 ? schema : null;
}

function fieldDefaultValue(
  field: CompletionPayloadField,
  task: Task,
  settlement: Record<string, unknown> | null,
  workflowRun: WorkflowRun | null,
): unknown {
  if (field.default_value !== undefined) return field.default_value;
  const source = stringFromUnknown(field.default_from);
  if (!source) return undefined;
  const workflowContext = recordFromUnknown(workflowRun?.context);
  const workflowPayload = recordFromUnknown(workflowContext?.payload);
  const workflowSettlement =
    recordFromUnknown(workflowContext?.settlement) ??
    recordFromUnknown(workflowPayload?.settlement) ??
    {};
  return readObjectPath(
    {
      task,
      metadata: recordFromUnknown(task.metadata) ?? {},
      workflow_run: workflowRun ?? {},
      workflow_context: workflowContext ?? {},
      settlement: { ...workflowSettlement, ...(settlement ?? {}) },
    },
    source,
  );
}

function normalizeFieldValue(field: CompletionPayloadField, value: string): unknown {
  if (field.type === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value.trim();
}

function taskTypeValue(task: Task): string {
  return (
    stringFromUnknown(task.task_type) ||
    stringFromUnknown(task.task_type_key) ||
    stringFromUnknown(task.metadata?.task_type_key) ||
    stringFromUnknown(task.metadata?.task_type) ||
    ''
  );
}

function taskTypeRow(task: Task) {
  const value = taskTypeValue(task);
  return value ? lookupRow('task_type', value) : null;
}

function taskTypeLabel(task: Task): string {
  const value = taskTypeValue(task);
  const row = value ? lookupRow('task_type', value) : null;
  return row?.label ?? (value ? value.replace(/_/g, ' ') : 'Review task');
}

function taskSubject(task: Task): string {
  return (
    stringFromUnknown(task.subject) ||
    stringFromUnknown(task.metadata?.subject) ||
    stringFromUnknown(task.metadata?.title) ||
    taskTypeLabel(task)
  );
}

function taskQueueValue(task: Task): string {
  return (
    stringFromUnknown(task.queue) ||
    stringFromUnknown(task.queue_key) ||
    stringFromUnknown(task.metadata?.queue_key) ||
    stringFromUnknown(task.metadata?.queue) ||
    ''
  );
}

function taskPriorityValue(task: Task): string {
  if (task.priority !== null && task.priority !== undefined && String(task.priority).trim()) {
    return String(task.priority).trim();
  }
  return (
    (getLookups('task_priority') as Array<{ value: string; is_default?: boolean; metadata?: { is_default?: boolean } }> | undefined)
      ?.find((row) => row.is_default === true || row.metadata?.is_default === true)?.value ?? ''
  );
}

// AGENTS.md §2/§3: SLA percentage uses canonical
// `task_sla_thresholds.no_sla_default_percent` for tasks lacking
// sla_due_at/created_at. Caller passes the resolved default.
function slaPercent(t: Task, noSlaDefaultPct: number, nowMs: number = Date.now()): number {
  if (!t.sla_due_at || !t.created_at) return noSlaDefaultPct;
  const created = new Date(t.created_at).getTime();
  const breach = new Date(t.sla_due_at).getTime();
  const total = breach - created;
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, ((nowMs - created) / total) * 100));
}

// W63 (Workflows Cycle F-R-3 P1-1/P1-2) — local `formatTimeUntil` ladder
// retired. The canonical formatter is `formatTimeUntilCanonical(ms,
// policy)` (in `_review-queue/views.ts`), driven by
// `ui_presentation_policy.{duration_buckets,overdue_label}`. The thin
// wrapper below stitches the iso-string + nowMs API used by the row /
// detail-pane chips while the underlying ladder is fully row-driven.
// When the canonical policy is missing or the iso is falsy, returns the
// canonical placeholder so the gap surfaces (no inline FE-literal mask).
function formatSlaCountdown(
  iso: string | null | undefined,
  policy: DurationFormatPolicy | null | undefined,
  nowMs: number,
): string {
  if (!iso) return 'no SLA';
  const ms = new Date(iso).getTime() - nowMs;
  return formatTimeUntilCanonical(ms, policy);
}

// W34c — task description hint resolves from canonical `task_type` lookup
// metadata (`reviewer_description`). No inline literal branches; missing
// rows surface a deterministic placeholder so the operator sees the gap.
function synthesizeDescription(t: Task): string {
  const row = taskTypeRow(t) as { reviewer_description?: string; metadata?: { reviewer_description?: string } } | null;
  const description = row?.reviewer_description ?? row?.metadata?.reviewer_description;
  if (description) return description;
  return `task_type/${taskTypeValue(t) || 'unset'} (missing reviewer_description in canonical lookup)`;
}

interface SLARingProps {
  percent: number;
  /** Canonical thresholds from `task_sla_thresholds`. */
  warnPct: number;
  dangerPct: number;
  variant?: 'list' | 'inline';
}

function SLARing({ percent, warnPct, dangerPct, variant = 'list' }: SLARingProps) {
  const { t } = useI18n();
  const r = 8;
  const c = 2 * Math.PI * r;
  const off = c - (Math.min(100, percent) / 100) * c;
  const tone: 'good' | 'warn' | 'danger' = percent >= dangerPct ? 'danger' : percent >= warnPct ? 'warn' : 'good';
  const size = variant === 'inline' ? 14 : 22;
  return (
    <span
      className={`wf-sla-ring wf-sla-ring--${tone} wf-sla-ring--${variant}`}
      title={fill(t('workflowReviewQueue.slaRing.toSlaBreach'), { value: String(percent.toFixed(0)) })}
    >
      <svg viewBox="0 0 22 22" width={size} height={size}>
        <circle cx="11" cy="11" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2" />
        <circle
          cx="11"
          cy="11"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
          transform="rotate(-90 11 11)"
        />
      </svg>
    </span>
  );
}

// W27 Cycle D closure: `timelineRow` helper retired with the synthetic
// timestamp Activity panel in the task detail view. The canonical activity
// source is now `audit_table_changes` through `useResourceList`, matched by
// task pk / subject_id / correlation_id. Missing rows still fail loud instead
// of fabricating timeline evidence.

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function auditPkId(row: AuditTableChangeRow): string | null {
  if (typeof row.pk === 'string') return row.pk;
  const pk = recordOf(row.pk);
  const id = pk?.id;
  return typeof id === 'string' ? id : null;
}

function auditChangedKeys(row: AuditTableChangeRow): string {
  const before = recordOf(row.row_old) ?? {};
  const after = recordOf(row.row_new) ?? {};
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  return keys.length ? keys.slice(0, 4).join(', ') : 'row metadata';
}

function taskAuditCorrelationIds(task: Task, linkedRun: WorkflowRun | false | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (linkedRun && typeof linkedRun === 'object' && typeof linkedRun.correlation_id === 'string') {
    ids.add(linkedRun.correlation_id);
  }
  const metaCorrelationId = task.metadata?.correlation_id;
  if (typeof metaCorrelationId === 'string') ids.add(metaCorrelationId);
  return ids;
}

function auditMatchesTask(row: AuditTableChangeRow, task: Task, correlationIds: Set<string>): boolean {
  const pkId = auditPkId(row);
  if (row.table_name === 'tasks' && (pkId === task.id || pkId === task.task_id)) return true;
  if (row.subject_id === task.id || row.subject_id === task.task_id) return true;
  return typeof row.correlation_id === 'string' && correlationIds.has(row.correlation_id);
}

function auditSubjectLabel(tableName: unknown): string {
  const key = String(tableName ?? '').toLowerCase();
  if (key === 'tasks') return 'Review task';
  if (key === 'workflow_runs') return 'Workflow run';
  if (key === 'workflow_run_steps') return 'Workflow step';
  return 'Activity record';
}

function auditActionLabel(op: unknown): string {
  const key = String(op ?? '').toLowerCase();
  if (key === 'insert') return 'Created';
  if (key === 'update') return 'Updated';
  if (key === 'delete') return 'Removed';
  return 'Changed';
}

function taskEventTimestamp(row: TaskEventRow): string | undefined {
  return row.created_at ?? row.occurred_at;
}

function taskEventMatchesTask(row: TaskEventRow, task: Task): boolean {
  return row.task_id === task.id || row.task_id === task.task_id;
}

function taskEventActionLabel(row: TaskEventRow): string {
  const key = String(row.event_type ?? row.event ?? '').toLowerCase();
  if (key === 'created') return 'Created - Task event';
  if (key === 'assigned') return 'Assigned - Task event';
  if (key === 'status_changed') return 'Status changed - Task event';
  if (key) return `${key.replace(/_/g, ' ')} - Task event`;
  return 'Task event';
}

function taskEventDetail(row: TaskEventRow): string {
  const payload = recordOf(row.payload) ?? {};
  const parts: string[] = [];
  const actor = row.actor_user_id ?? row.actor_system ?? row.actor;
  if (actor) parts.push(`Actor ${compactActivityReference(actor)}`);
  if (row.from_status || row.to_status) {
    parts.push(`Status ${String(row.from_status ?? 'new')} -> ${String(row.to_status ?? 'unknown')}`);
  }
  const amount = payload.amount;
  const currency = payload.currency;
  if (amount !== undefined && amount !== null) {
    parts.push(`Amount ${String(amount)}${currency ? ` ${String(currency)}` : ''}`);
  }
  const receiptContext = payload.receipt_context ?? payload.deposit_slip_ref;
  if (receiptContext) parts.push(`Reference ${String(receiptContext)}`);
  if (row.ops_session_id) parts.push(`Session ${compactActivityReference(row.ops_session_id)}`);
  return parts.join(' - ') || 'Activity recorded';
}

function compactActivityReference(raw: unknown): string {
  const parts = String(raw ?? '')
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const meaningful = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const value = String(meaningful ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return value ? `#${value.slice(-6)}` : 'unknown';
}

function AuditActivityPanel({
  canReadAuditLog,
  canReadTaskEvents,
  isLoading,
  isError,
  rows,
  taskEvents,
}: {
  canReadAuditLog: boolean;
  canReadTaskEvents: boolean;
  isLoading: boolean;
  isError: boolean;
  rows: AuditTableChangeRow[];
  taskEvents: TaskEventRow[];
}) {
  const { t } = useI18n();
  if (!canReadAuditLog && !canReadTaskEvents) {
    return (
      <div className="timeline" data-testid="wf-rq-audit-activity" style={{ padding: '0 14px 14px' }}>
        <StateView
          kind="denied"
          hint={t('workflowReviewQueue.auditActivityPanel.taskOrAuditActivity')}
        />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="timeline" data-testid="wf-rq-audit-activity" style={{ padding: '0 14px 14px' }}>
        <StateView kind="loading" hint={t('workflowReviewQueue.auditActivityPanel.loadingOperatorActivity')} />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="timeline" data-testid="wf-rq-audit-activity" style={{ padding: '0 14px 14px' }}>
        <StateView kind="error" hint={t('workflowReviewQueue.auditActivityPanel.couldNotLoadOperator')} />
      </div>
    );
  }
  if (rows.length === 0 && taskEvents.length === 0) {
    return (
      <div className="timeline" data-testid="wf-rq-audit-activity" style={{ padding: '0 14px 14px' }}>
        <StateView
          kind="empty"
          title={t('workflowReviewQueue.auditActivityPanel.noOperatorActivity')}
          hint={t('workflowReviewQueue.auditActivityPanel.noMatchingTaskSubject')}
        />
      </div>
    );
  }
  return (
    <div className="timeline" data-testid="wf-rq-audit-activity" style={{ padding: '0 14px 14px' }}>
      {taskEvents.map((row) => (
        <div key={row.id ?? `${row.task_id}-${taskEventTimestamp(row)}`} className="timeline__row">
          <span className="timeline__node" />
          <span className="timeline__time mono">
            {taskEventTimestamp(row) ? new Date(taskEventTimestamp(row)!).toLocaleString() : t('workflowReviewQueue.auditActivityPanel.unknown')}
          </span>
          <div className="timeline__body">
            <div className="timeline__action">{taskEventActionLabel(row)}</div>
            <div className="timeline__detail mono">{taskEventDetail(row)}</div>
          </div>
        </div>
      ))}
      {rows.map((row) => (
        <div key={row.id ?? `${row.table_name}-${row.created_at}`} className="timeline__row">
          <span className="timeline__node" />
          <span className="timeline__time mono">
            {row.created_at ? new Date(row.created_at).toLocaleString() : t('workflowReviewQueue.auditActivityPanel.unknown')}
          </span>
          <div className="timeline__body">
            <div className="timeline__action">{`${auditActionLabel(row.op)} - ${auditSubjectLabel(row.table_name)}`}</div>
            <div className="timeline__detail mono">
              {fill(t('workflowReviewQueue.auditActivityPanel.actorRecord'), { value: String(compactActivityReference(row.changed_by)), value2: String(compactActivityReference(auditPkId(row))), value3: String(auditChangedKeys(row)) })}
            </div>
            {row.correlation_id ? <div className="timeline__detail mono">{t('workflowReviewQueue.auditActivityPanel.activityReferenceRecorded')}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// Labels come from the workflowReviewQueue.filters and .sortModes catalog entries.
const FILTERS: Array<{ id: FilterId; tone?: string; icon?: string }> = [
  { id: 'mine', icon: 'user' },
  { id: 'queue', icon: 'inbox' },
  { id: 'all' },
  { id: 'breach', tone: 'danger' },
  { id: 'snoozed', tone: 'neutral' },
];

const SORT_MODES: Array<{ id: SortMode }> = [{ id: 'sla_due' }, { id: 'priority' }, { id: 'created' }];

function prioritySortOrder(task: Task): number {
  const row = lookupRow('task_priority', String(task.priority ?? '')) as
    | { metadata?: { sort_order?: number } }
    | null;
  const sortOrder = row?.metadata?.sort_order;
  return typeof sortOrder === 'number' && Number.isFinite(sortOrder) ? sortOrder : Number.MAX_SAFE_INTEGER;
}

function timestampMs(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

// W52 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
// SAMPLE_USERS and SNOOZE_OPTIONS were hardcoded inline. Both now read
// from canonical sources:
//   - assign / reassign pickers consume `useResourceList<UserRow>('users')`
//     (registry-driven, mirrors public.users)
//   - snooze picker reads `ui_presentation_policy.task_snooze.options`
//     (W52 backend mirror: 202605021100_w52_ui_presentation_policy_task_snooze_options.sql).
// Missing canonical row renders an error StateView in-place — no inline
// fallback consts here.
interface UserRow {
  id: string;
  full_name?: string | null;
  email?: string | null;
}

export function ReviewQueueModule() {
  const { t } = useI18n();
  const modal = useModal();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, scope } = useIdentity();
  const me = user.id;
  // W35c-2 — bulk transitions and write actions resolve through
  // `bulk_transition_tasks_v1` / `transition_task_v1`, both server-asserting
  // `tasks.write`. Gate the FE bulk affordances and keyboard shortcuts on the
  // same capability so the UI fail-closes optimistically and never invokes
  // mutations the server will reject. Closes REAUDIT3/WORKFLOWS.md P1-2.
  const canWriteTasks = useCapability(CAP.TASKS_WRITE);
  const canRead = useCapability(CAP.TASKS_READ);
  const canReadAuditLog = useCapability(CAP.AUDIT_LOG_READ);
  const taskReadQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  // AGENTS.md §2/§3: SLA ring + percent thresholds resolve strictly from
  // canonical `task_sla_thresholds` (W30 policy seed).
  const slaPolicy = useResolveSettings('task_sla_thresholds', undefined, taskReadQueryOptions);
  const slaThresholds = slaPolicy.data?.value as
    | { sla_warn_minutes_before_breach?: number; sla_ring_warn_pct?: number; sla_ring_danger_pct?: number; no_sla_default_percent?: number }
    | undefined;
  const slaRingWarnPct = slaThresholds?.sla_ring_warn_pct;
  const slaRingDangerPct = slaThresholds?.sla_ring_danger_pct;
  const noSlaDefaultPct = slaThresholds?.no_sla_default_percent;
  const noSlaDefaultPctResolved =
    typeof noSlaDefaultPct === 'number' ? noSlaDefaultPct : Number.NaN;

  // W49/W52 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
  // default snooze duration key + snooze picker options resolve strictly
  // from canonical `ui_presentation_policy.task_snooze.{default_key,
  // options}`. Missing canonical row surfaces a page-level danger
  // StateView so the gap is visible — no inline `'1h'` fallback or
  // SNOOZE_OPTIONS const.
  const uiPresentationPolicy = useResolveSettings('ui_presentation_policy', undefined, taskReadQueryOptions);
  const uiPresentationValue = uiPresentationPolicy.data?.value as
    | {
        task_snooze?: { default_key?: string; options?: Array<{ value: string; label: string; duration_seconds: number }> };
        // W61 (Workflows P2-4) — SLA tick cadence row-driven from
        // canonical `ui_presentation_policy.sla_tick_interval_ms`.
        // Replaces inline `setInterval(..., 1000)` magic literal.
        sla_tick_interval_ms?: number;
        // W63 (Workflows Cycle F-R-3 P1-1/P1-2) — duration bucket
        // ladder + overdue label consumed by the SLA-countdown chip
        // formatter. Replaces duplicated 60000/3600000/86400000 magic-
        // ms ladders in `formatTimeUntil` (retired) — see
        // `formatTimeUntilCanonical` in `_review-queue/views.ts`.
        duration_buckets?: Array<{ unit: string; threshold_ms: number; label: string }>;
        overdue_label?: string;
      }
    | undefined;
  const defaultSnoozeKey = uiPresentationValue?.task_snooze?.default_key;
  const snoozeOptions = useMemo(
    () => uiPresentationValue?.task_snooze?.options ?? [],
    [uiPresentationValue?.task_snooze?.options],
  );
  // W61 (Workflows P2-4) — strict no-fallback. Missing canonical row →
  // tick disabled (SLA percent stays static between backend re-fetches)
  // so the gap surfaces via the rest of the canonical policy ladder.
  const slaTickIntervalMs = uiPresentationValue?.sla_tick_interval_ms;
  // W63 (Workflows Cycle F-R-3 P1-1/P1-2) — canonical duration policy
  // for SLA-countdown chip rendering. Strict no-fallback: when the
  // canonical row is missing, `formatTimeUntilCanonical` returns the
  // `'—'` placeholder so the gap surfaces visibly.
  const durationFormatPolicy = useMemo<DurationFormatPolicy | null>(() => {
    const buckets = uiPresentationValue?.duration_buckets;
    const overdueLabel = uiPresentationValue?.overdue_label;
    if (!Array.isArray(buckets) || buckets.length === 0) return null;
    if (typeof overdueLabel !== 'string' || !overdueLabel) return null;
    return { duration_buckets: buckets, overdue_label: overdueLabel };
  }, [uiPresentationValue?.duration_buckets, uiPresentationValue?.overdue_label]);

  // W52 strict closure: assign / reassign pickers consume the canonical
  // `users` resource (mirrors public.users). NO inline SAMPLE_USERS const
  // — missing/empty resource surfaces an error StateView via the modal
  // body instead of falling through to FE-fictional rows.
  const usersQuery = useResourceList<UserRow>('users', undefined, taskReadQueryOptions);
  const usersList = useMemo<UserRow[]>(
    () => usersQuery.data?.rows ?? [],
    [usersQuery.data?.rows],
  );
  const auditChangesQuery = useResourceList<AuditTableChangeRow>(
    'audit_table_changes',
    { page_size: 100 },
    { enabled: canRead && canReadAuditLog },
  );
  const auditChanges = useMemo<AuditTableChangeRow[]>(
    () => auditChangesQuery.data?.rows ?? [],
    [auditChangesQuery.data?.rows],
  );

  const tasksQuery = useTasks(undefined, taskReadQueryOptions);
  const runsQuery = useResourceList<WorkflowRun>('workflow_runs', undefined, taskReadQueryOptions);
  const transitionTask = useTransitionTask();
  const assignTask = useAssignTask();
  // Phase C5: bulk operations route through the canonical
  // bulk_transition_tasks_v1 RPC so the queue stays consistent end-to-end
  // (closes WORKFLOWS.md §3 P1 review-queue bulk-* uses optimistic only).
  const bulkTransitionTasks = useBulkTransitionTasks();

  // Local-mutable copy for post-mutation reconciliation while TanStack Query refetches canonical rows.
  const [overrides, setOverrides] = useState<Record<string, Partial<Task>>>({});
  const inFlightTaskActionsRef = useRef<Set<string>>(new Set());

  const allTasks = useMemo<Task[]>(() => {
    const base = (tasksQuery.data ?? []) as Task[];
    return base.map((taskRow) => ({ ...taskRow, ...(overrides[taskRow.id] || {}) }));
  }, [tasksQuery.data, overrides]);

  const runs = (runsQuery.data?.rows ?? []) as WorkflowRun[];

  const [activeFilter, setActiveFilter] = useState<FilterId>('mine');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState<string>('');
  const [sortMode, setSortMode] = useState<SortMode>('sla_due');
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => listSavedViews());
  const [bulkTaskReadback, setBulkTaskReadback] = useState<BulkTaskActionReadback | null>(null);
  const [taskActionReadback, setTaskActionReadback] = useState<TaskActionReadback | null>(null);
  // 1Hz tick — re-evaluates SLA percentages and `formatTimeUntil` strings so
  // countdown chips stay live without a backend re-fetch.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusedTaskParamRef = useRef<string | null>(null);

  // W61 (Workflows P2-4) — SLA tick cadence resolves through canonical
  // `ui_presentation_policy.sla_tick_interval_ms`. Replaces inline
  // `setInterval(..., 1000)` magic literal. Strict no-fallback: when the
  // canonical row is missing or non-positive, the tick is skipped (SLA
  // chips stay static between backend re-fetches) so the gap surfaces
  // instead of being masked by a silent FE default.
  useEffect(() => {
    if (typeof slaTickIntervalMs !== 'number' || !Number.isFinite(slaTickIntervalMs) || slaTickIntervalMs <= 0) {
      return;
    }
    const id = window.setInterval(() => setNowTick(Date.now()), slaTickIntervalMs);
    return () => window.clearInterval(id);
  }, [slaTickIntervalMs]);

  const filteredTasks = useMemo<Task[]>(() => {
    let rows: Task[];
    if (activeFilter === 'mine') rows = allTasks.filter((taskRow) => taskRow.assigned_to === me);
    else if (activeFilter === 'queue') rows = allTasks.filter((taskRow) => !taskRow.assigned_to);
    else if (activeFilter === 'breach')
      rows = allTasks.filter((taskRow) => slaPercent(taskRow, noSlaDefaultPctResolved, nowTick) >= 100);
    else if (activeFilter === 'snoozed') rows = allTasks.filter((taskRow) => isTaskSnoozed(taskRow.status));
    else rows = allTasks;
    const searched = search.trim() ? rows.filter((taskRow) => matchesSearch(taskRow, search)) : rows;
    return [...searched].sort((left, right) => {
      if (sortMode === 'priority') {
        return prioritySortOrder(left) - prioritySortOrder(right)
          || timestampMs(left.sla_due_at, Number.MAX_SAFE_INTEGER) - timestampMs(right.sla_due_at, Number.MAX_SAFE_INTEGER);
      }
      if (sortMode === 'created') {
        return timestampMs(right.created_at, 0) - timestampMs(left.created_at, 0);
      }
      return timestampMs(left.sla_due_at, Number.MAX_SAFE_INTEGER) - timestampMs(right.sla_due_at, Number.MAX_SAFE_INTEGER)
        || prioritySortOrder(left) - prioritySortOrder(right);
    });
  }, [allTasks, activeFilter, me, search, nowTick, noSlaDefaultPctResolved, sortMode]);

  // Auto-select first if active disappears.
  useEffect(() => {
    if (!filteredTasks.length) {
      setActiveTaskId(null);
      return;
    }
    if (!activeTaskId || !filteredTasks.find((taskRow) => taskRow.id === activeTaskId)) {
      setActiveTaskId(filteredTasks[0]!.id);
    }
  }, [filteredTasks, activeTaskId]);

  useEffect(() => {
    const focus = readUrlParam('focus') ?? readUrlParam('task');
    if (!focus) return;
    if (focusedTaskParamRef.current === focus) return;
    const match = allTasks.find((task) => task.id === focus || task.task_id === focus);
    if (!match) return;
    focusedTaskParamRef.current = focus;
    if (activeTaskId === match.id) return;
    setSearch('');
    setActiveFilter('all');
    setActiveTaskId(match.id);
  }, [allTasks, activeTaskId]);

  const activeTask = useMemo(
    () => filteredTasks.find((taskRow) => taskRow.id === activeTaskId) || null,
    [filteredTasks, activeTaskId]
  );
  const activeSettlementId = useMemo(() => {
    if (!activeTask) return undefined;
    const resourceType = stringFromUnknown(activeTask.resource_type);
    const resourceId = stringFromUnknown(activeTask.resource_id);
    return resourceType === 'settlement_batch' && resourceId ? resourceId : undefined;
  }, [activeTask]);
  const activeSettlementQuery = useResource<Record<string, unknown>>('settlement_batch_summary', activeSettlementId);
  const activeSettlement = activeSettlementQuery.data ?? null;
  const activeTaskEventsQuery = useResourceList<TaskEventRow>(
    'task_events',
    { filter: { task_id: activeTask?.id ?? '' }, page_size: 20 },
    { enabled: canRead && Boolean(activeTask?.id) },
  );
  const activeTaskEventRows = useMemo<TaskEventRow[]>(() => {
    return activeTask
      ? (activeTaskEventsQuery.data?.rows ?? [])
          .filter((row) => taskEventMatchesTask(row, activeTask))
          .sort((a, b) => String(taskEventTimestamp(b) ?? '').localeCompare(String(taskEventTimestamp(a) ?? '')))
      : [];
  }, [activeTask, activeTaskEventsQuery.data?.rows]);
  const latestTaskStatusEvent = useMemo(() => {
    return activeTaskEventRows.find((row) => {
      return stringFromUnknown(row.event_type) === 'status_changed'
        && stringFromUnknown(row.to_status);
    }) ?? null;
  }, [activeTaskEventRows]);

  useEffect(() => {
    if (!activeTask || !latestTaskStatusEvent) return;
    const toStatus = stringFromUnknown(latestTaskStatusEvent.to_status);
    if (!toStatus) return;
    const payload = recordFromUnknown(latestTaskStatusEvent.payload);
    const statusReason = stringFromUnknown(payload?.status_reason);
    const snoozeUntil = stringFromUnknown(payload?.snooze_until);
    const patch: Partial<Task> = {};
    if (toStatus !== activeTask.status) patch.status = toStatus;
    if (statusReason && statusReason !== activeTask.status_reason) patch.status_reason = statusReason;
    if (snoozeUntil && snoozeUntil !== activeTask.snooze_until) patch.snooze_until = snoozeUntil;
    if (Object.keys(patch).length > 0) patchTask(activeTask.id, patch);
  }, [activeTask, latestTaskStatusEvent]);

  useEffect(() => {
    if (taskActionReadback && activeTaskId && taskActionReadback.taskId !== activeTaskId) {
      setTaskActionReadback(null);
    }
  }, [activeTaskId, taskActionReadback]);

  const counts = useMemo(
    () => ({
      mine: allTasks.filter((taskRow) => taskRow.assigned_to === me).length,
      queue: allTasks.filter((taskRow) => !taskRow.assigned_to).length,
      all: allTasks.length,
      breach: allTasks.filter((taskRow) => slaPercent(taskRow, noSlaDefaultPctResolved, nowTick) >= 100).length,
      snoozed: allTasks.filter((taskRow) => isTaskSnoozed(taskRow.status)).length,
    }),
    [allTasks, me, nowTick, noSlaDefaultPctResolved]
  );

  function patchTask(id: string, patch: Partial<Task>) {
    setOverrides((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }

  function taskReadbackPatch(task: unknown): Partial<Task> | null {
    const readback = recordFromUnknown(task);
    if (!readback || !stringFromUnknown(readback.id)) return null;
    return readback as Partial<Task>;
  }

  function taskEventIdFromReadback(result: unknown): string | null {
    return stringFromUnknown(recordFromUnknown(result)?.task_event_id) || null;
  }

  function bulkOutcomeRows(result: unknown): Array<Record<string, unknown>> {
    return recordsFromUnknown(recordFromUnknown(result)?.outcomes);
  }

  function bulkOutcomePayload(row: Record<string, unknown>): Record<string, unknown> | null {
    return recordFromUnknown(row.task_event_payload) ?? recordFromUnknown(row.payload);
  }

  async function refetchTaskQueueReadback(): Promise<Task[]> {
    const taskReadback = await tasksQuery.refetch();
    if (activeTask?.id) {
      await activeTaskEventsQuery.refetch();
    }
    return ((taskReadback.data ?? tasksQuery.data ?? []) as Task[]);
  }

  function taskReadbackMap(rows: Task[]): Map<string, Task> {
    return new Map(rows.map((row) => [row.id, row]));
  }

  function recordBulkTaskReadback(args: {
    kind: BulkTaskActionKind;
    tasks: Task[];
    refreshedTasks: Task[];
    taskEventIds: Array<string | null | undefined>;
    taskEventPayloads?: Array<Record<string, unknown> | null | undefined>;
    expectedAssignedTo?: string | null;
    expectedStatus?: string | null;
    expectedSnoozeUntil?: string | null;
  }) {
    const byId = taskReadbackMap(args.refreshedTasks);
    const confirmedSnoozeUntil = args.expectedSnoozeUntil
      ? args.taskEventPayloads
          ?.map((payload) => stringFromUnknown(payload?.snooze_until) || null)
          .find((value) => value === args.expectedSnoozeUntil) ?? null
      : null;
    const confirmedTaskIds = args.tasks
      .filter((task) => {
        const readback = byId.get(task.id);
        if (!readback) return false;
        if (args.expectedAssignedTo) return stringFromUnknown(readback.assigned_to) === args.expectedAssignedTo;
        if (args.expectedStatus) return stringFromUnknown(readback.status) === args.expectedStatus;
        return true;
      })
      .map((task) => task.id);
    setBulkTaskReadback({
      kind: args.kind,
      total: args.tasks.length,
      taskIds: args.tasks.map((task) => task.id),
      confirmedTaskIds,
      taskEventIds: args.taskEventIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
      expectedAssignedTo: args.expectedAssignedTo,
      expectedStatus: args.expectedStatus,
      expectedSnoozeUntil: args.expectedSnoozeUntil,
      confirmedSnoozeUntil,
      requestedAt: new Date().toISOString(),
    });
  }

  function recordTaskActionReadback(args: {
    kind: string;
    task: Task;
    refreshedTasks: Task[];
    taskEventId?: string | null;
    expectedAssignedTo?: string | null;
    expectedStatus?: string | null;
    expectedSnoozeUntil?: string | null;
    confirmedSnoozeUntil?: string | null;
  }) {
    const readback = taskReadbackMap(args.refreshedTasks).get(args.task.id);
    const assignedMatches = args.expectedAssignedTo
      ? stringFromUnknown(readback?.assigned_to) === args.expectedAssignedTo
      : true;
    const statusMatches = args.expectedStatus
      ? stringFromUnknown(readback?.status) === args.expectedStatus
      : true;
    const wakeMatches = args.expectedSnoozeUntil
      ? stringFromUnknown(readback?.snooze_until) === args.expectedSnoozeUntil
        || args.confirmedSnoozeUntil === args.expectedSnoozeUntil
      : true;
    setTaskActionReadback({
      kind: args.kind,
      taskId: args.task.id,
      taskDisplayId: stringFromUnknown(args.task.task_id) || args.task.id,
      taskEventId: args.taskEventId ?? null,
      expectedAssignedTo: args.expectedAssignedTo,
      expectedStatus: args.expectedStatus,
      expectedSnoozeUntil: args.expectedSnoozeUntil,
      confirmedSnoozeUntil: args.confirmedSnoozeUntil
        ?? (stringFromUnknown(readback?.snooze_until) || null),
      confirmed: Boolean(readback) && assignedMatches && statusMatches && wakeMatches,
      requestedAt: new Date().toISOString(),
    });
  }

  function bulkTaskActionLabel(kind: BulkTaskActionKind): string {
    const row = lookupRow('task_action_kind', kind);
    return stringFromUnknown(row?.label) || kind;
  }

  function taskActionLabel(kind: string): string {
    if (kind === 'assign') return 'Assign';
    const row = lookupRow('task_action_kind', kind);
    return stringFromUnknown(row?.label) || kind;
  }

  function startTaskAction(actionKey: string): boolean {
    if (inFlightTaskActionsRef.current.has(actionKey)) return false;
    inFlightTaskActionsRef.current.add(actionKey);
    return true;
  }

  function finishTaskAction(actionKey: string) {
    inFlightTaskActionsRef.current.delete(actionKey);
  }

  const claim = useCallback(
    async (taskRow: Task) => {
      // Claim persists through canonical assign_task_v1; the local mirror only
      // reconciles visible state after the backend accepts the assignment.
      try {
        const assigned = await assignTask.mutateAsync({
          task_id: taskRow.id,
          assigned_to: me,
          idempotency_key: `console-review-queue:claim:${taskRow.id}:${me}`,
          notes: 'Claimed from Console V2 review queue',
        });
        patchTask(taskRow.id, taskReadbackPatch(assigned.task) ?? { assigned_to: me });
        const refreshedTasks = await refetchTaskQueueReadback();
        recordTaskActionReadback({
          kind: 'claim',
          task: taskRow,
          refreshedTasks,
          taskEventId: taskEventIdFromReadback(assigned),
          expectedAssignedTo: me,
        });
        pushToast(fill(t('workflowReviewQueue.reviewQueueModule.claimed'), { task_id: String(taskRow.task_id) }), 'good');
      } catch (err) {
        pushToast(t('workflowReviewQueue.reviewQueueModule.taskClaimCouldNot'), 'danger');
        return;
      }
    },
    [assignTask, me, t]
  );

  const completeTaskAction = useCallback(
    async (
      taskEntry: Task,
      action: ActionDescriptor,
      payload: Record<string, unknown> = {},
      configuredNextStatus?: string,
    ) => {
      const next_status = stringFromUnknown(configuredNextStatus) || nextStatusForAction(action.kind);
      if (!next_status) {
        pushToast(fill(t('workflowReviewQueue.reviewQueueModule.failedTheNextStatus'), { label: String(action.label) }), 'danger');
        return false;
      }
      const actionPayload = { ...payload };
      const isSnoozeAction = lookupRow('task_action_kind', action.kind)?.metadata?.is_snooze_action === true;
      let actionSnoozeUntil = stringFromUnknown(actionPayload.snooze_until);
      if (isSnoozeAction && !actionSnoozeUntil) {
        const option = defaultSnoozeKey
          ? snoozeOptions.find((entry) => entry.value === defaultSnoozeKey)
          : null;
        if (!option) {
          pushToast(fill(t('workflowReviewQueue.reviewQueueModule.failedDefaultSnoozeOption'), { label: String(action.label) }), 'danger');
          return false;
        }
        const computedSnoozeUntil = snoozeUntil(option);
        if (!computedSnoozeUntil) {
          pushToast(fill(t('workflowReviewQueue.reviewQueueModule.failedOptionHasInvalid'), { label: String(action.label), value: String(option.value) }), 'danger');
          return false;
        }
        actionSnoozeUntil = computedSnoozeUntil;
        actionPayload.snooze_until = computedSnoozeUntil;
      }
      try {
        const transitioned = await transitionTask.mutateAsync({
          taskId: taskEntry.id,
          transition: { next_status, action_kind: action.kind, payload: actionPayload },
        });
        const patch: Partial<Task> = taskReadbackPatch(transitioned.task) ?? { status: next_status };
        if (actionSnoozeUntil && !stringFromUnknown(patch.snooze_until)) {
          patch.snooze_until = actionSnoozeUntil;
        }
        patchTask(taskEntry.id, patch);
        const refreshedTasks = await refetchTaskQueueReadback();
        recordTaskActionReadback({
          kind: action.kind,
          task: taskEntry,
          refreshedTasks,
          taskEventId: taskEventIdFromReadback(transitioned),
          expectedStatus: next_status,
          expectedSnoozeUntil: actionSnoozeUntil || null,
          confirmedSnoozeUntil: actionSnoozeUntil || null,
        });
        const parentRunId = taskParentWorkflowRunId(taskEntry);
        let workflowWakeError: Error | null = null;
        const shouldWakeParentWorkflow =
          parentRunId && ['completed', 'rejected', 'canceled', 'cancelled'].includes(next_status);
        if (shouldWakeParentWorkflow) {
          const progressPayload = {
            task_id: taskEntry.id,
            completed_task_id: taskEntry.id,
            task_action_kind: action.kind,
            task_payload: actionPayload,
          };
          try {
            await progress_workflow_run_until_wait_v1(parentRunId, progressPayload, {
              budget_ms: 5000,
              max_steps: 8,
            });
          } catch (err) {
            workflowWakeError = err as Error;
          }
          if (!workflowWakeError || next_status !== 'completed') {
            await Promise.allSettled([
              workflowWakeError ? Promise.resolve() : refreshFinanceWorkflowReadModels(queryClient),
              tasksQuery.refetch(),
              runsQuery.refetch(),
            ]);
          }
        }
        if (workflowWakeError) {
          pushToast(
            fill(t('workflowReviewQueue.reviewQueueModule.taskCompletedWorkflowWake'), { value: String(workflowWakeError.message ?? 'unknown error') }),
            'danger',
          );
        } else {
          pushToast(fill(t('workflowReviewQueue.reviewQueueModule.applied'), { label: String(action.label) }), 'good');
        }
        return true;
      } catch (err) {
        pushToast(t('workflowReviewQueue.reviewQueueModule.taskActionCouldNot'), 'danger');
        return false;
      }
    },
    [defaultSnoozeKey, queryClient, runsQuery, snoozeOptions, tasksQuery, transitionTask, t]
  );

  const resolve = useCallback(
    async (taskEntry: Task) => {
      const action = resolveAllowedActions(taskEntry).find((entry) => entry.kind === 'resolve');
      if (!action) {
        pushToast(t('workflowReviewQueue.reviewQueueModule.resolveFailedResolveIs'), 'danger');
        return;
      }
      await completeTaskAction(taskEntry, action);
    },
    [completeTaskAction, t]
  );

  const openCompletionPayloadModal = useCallback(
    (taskRow: Task, action: ActionDescriptor, schema: CompletionPayloadSchema) => {
      const fields = (schema.fields ?? []).filter((field) => stringFromUnknown(field.key));
      const parentWorkflowRunId = taskParentWorkflowRunId(taskRow);
      const parentWorkflowRun = parentWorkflowRunId
        ? runs.find((run) => run.id === parentWorkflowRunId) ?? null
        : null;
      const payload: Record<string, unknown> = {};
      for (const field of fields) {
        const key = stringFromUnknown(field.key);
        const value = fieldDefaultValue(field, taskRow, activeSettlement, parentWorkflowRun);
        if (value !== undefined && value !== null) payload[key] = value;
      }

      const renderInput = (field: CompletionPayloadField) => {
        const key = stringFromUnknown(field.key);
        const label = stringFromUnknown(field.label) || key;
        const defaultValue = payload[key] == null ? '' : String(payload[key]);
        const commonProps = {
          id: `wf-task-completion-${key}`,
          className: 'dt-inline-input',
          defaultValue,
          placeholder: stringFromUnknown(field.placeholder),
          onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            payload[key] = normalizeFieldValue(field, event.target.value);
          },
        };
        return (
          <label key={key} className="wf-rq-completion-field" htmlFor={`wf-task-completion-${key}`}>
            <span className="mono">
              {label}
              {field.required ? ' *' : ''}
            </span>
            {field.type === 'textarea' ? (
              <textarea {...commonProps} rows={3} />
            ) : (
              <input
                {...commonProps}
                type={field.type === 'number' ? 'number' : 'text'}
                min={field.min}
                max={field.max}
                step={field.step}
              />
            )}
          </label>
        );
      };

      modal.open({
        title: schema.title ?? action.label,
        body: (
          <div style={{ padding: '8px 14px', display: 'grid', gap: 12 }}>
            {schema.description ? (
              <p style={{ margin: 0, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.45 }}>
                {schema.description}
              </p>
            ) : null}
            {schema.requires_session_type ? (
              <div className="chip chip--xs chip--info">
                {fill(t('workflowReviewQueue.reviewQueueModule.sessionRequired'), { value: String(schema.requires_session_type.replace(/_/g, ' ')) })}
              </div>
            ) : null}
            {fields.map(renderInput)}
          </div>
        ),
        footer: (
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button label={t('workflowReviewQueue.reviewQueueModule.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={schema.submit_label ?? action.label}
              kind="primary"
              capability={CAP.TASKS_COMPLETE}
              onClick={async () => {
                try {
                  for (const field of fields) {
                    const key = stringFromUnknown(field.key);
                    const input = document.getElementById(`wf-task-completion-${key}`) as
                      | HTMLInputElement
                      | HTMLTextAreaElement
                      | null;
                    const value = input ? normalizeFieldValue(field, input.value) : payload[key];
                    payload[key] = value;
                    if (field.required && (value === undefined || value === null || String(value).trim() === '')) {
                      pushToast(fill(t('workflowReviewQueue.reviewQueueModule.isRequired'), { value: String(field.label ?? key) }), 'danger');
                      return;
                    }
                    if (field.type === 'number' && typeof value !== 'number') {
                      pushToast(fill(t('workflowReviewQueue.reviewQueueModule.mustBeNumeric'), { value: String(field.label ?? key) }), 'danger');
                      return;
                    }
                  }
                  const requiredSessionType = stringFromUnknown(schema.requires_session_type);
                  if (requiredSessionType) {
                    const opened = await open_ops_session_v1({
                      session_type: requiredSessionType,
                      branch_id: stringFromUnknown(activeSettlement?.branch_id) || null,
                      idempotency_key: `console-review-queue:${taskRow.id}:${requiredSessionType}`,
                      metadata: {
                        source: 'console-v2/workflows/review-queue',
                        task_id: taskRow.id,
                        task_type_key: taskTypeValue(taskRow),
                        settlement_batch_id: activeSettlementId ?? null,
                      },
                    });
                    payload.ops_session_id = opened.ops_session_id;
                  }
                  const completed = await completeTaskAction(taskRow, action, payload, schema.next_status);
                  if (completed) modal.close();
                } catch (err) {
                  pushToast(t('workflowReviewQueue.reviewQueueModule.taskActionCouldNot'), 'danger');
                }
              }}
            />
          </div>
        ),
      });
    },
    [activeSettlement, activeSettlementId, completeTaskAction, modal, runs, t],
  );

  const apply = useCallback(
    async (taskRow: Task, action: ActionDescriptor) => {
      const schema = taskCompletionSchema(taskRow, action);
      if (schema) {
        openCompletionPayloadModal(taskRow, action, schema);
        return;
      }
      await completeTaskAction(taskRow, action);
    },
    [completeTaskAction, openCompletionPayloadModal]
  );

  /** Snooze a single task — resolves the option via canonical
   *  `ui_presentation_policy.task_snooze.options` and computes `snooze_until`
   *  ISO via `snoozeUntil(option, base)` (W27 Cycle D closure: no inline
   *  label-keyed map / silent `?? HOUR` fallback). Missing/malformed option
   *  surfaces a danger toast and aborts; persists through `useTransitionTask`
   *  so the seam mock receives the row-driven payload. */
  const snoozeOne = useCallback(
    async (taskRow: Task, durationKey: string | undefined) => {
      if (!durationKey) {
      pushToast(t('workflowReviewQueue.reviewQueueModule.snoozeFailedDefaultSnooze'), 'danger');
        return;
      }
      const option = snoozeOptions.find((o) => o.value === durationKey);
      if (!option) {
      pushToast(fill(t('workflowReviewQueue.reviewQueueModule.snoozeFailedSnoozeOption'), { durationKey: String(durationKey) }), 'danger');
        return;
      }
      const snooze_until = snoozeUntil(option);
      if (!snooze_until) {
        pushToast(fill(t('workflowReviewQueue.reviewQueueModule.snoozeFailedOptionHas'), { durationKey: String(durationKey) }), 'danger');
        return;
      }
      // Cycle E2 (Workflows P1 #6) — `next_status` for the snooze
      // transition resolves canonically through `nextStatusForAction
      // ('snooze')`. Replaces the literal `next_status: 'snoozed'` so the
      // snooze→status mapping is SSOT-driven (single seed insert to
      // re-route).
      const nextStatus = nextStatusForAction('snooze');
      const actionKey = `${taskRow.id}:snooze`;
      if (!startTaskAction(actionKey)) return;
      try {
        const transitioned = await transitionTask.mutateAsync({
          taskId: taskRow.id,
          transition: {
            next_status: nextStatus,
            action_kind: 'snooze',
            payload: { snooze_until },
          },
        });
        patchTask(taskRow.id, {
          ...(taskReadbackPatch(transitioned.task) ?? {}),
          snooze_until,
        });
        const refreshedTasks = await refetchTaskQueueReadback();
        recordTaskActionReadback({
          kind: 'snooze',
          task: taskRow,
          refreshedTasks,
          taskEventId: taskEventIdFromReadback(transitioned),
          expectedStatus: nextStatus,
          expectedSnoozeUntil: snooze_until,
          confirmedSnoozeUntil: snooze_until,
        });
        pushToast(fill(t('workflowReviewQueue.reviewQueueModule.snoozedFor'), { task_id: String(taskRow.task_id), durationKey: String(durationKey) }), 'info');
      } catch (err) {
        pushToast(t('workflowReviewQueue.reviewQueueModule.taskSnoozeCouldNot'), 'danger');
      }
      finishTaskAction(actionKey);
    },
    [transitionTask, snoozeOptions, t]
  );

  const escalateOne = useCallback(
    async (taskRow: Task) => {
      // Cycle E2 (Workflows P1 #6) — `next_status` for the escalate
      // transition resolves canonically through `nextStatusForAction
      // ('escalate')`. Replaces the literal `next_status: 'escalated'`.
      const nextStatus = nextStatusForAction('escalate');
      try {
        const transitioned = await transitionTask.mutateAsync({
          taskId: taskRow.id,
          transition: { next_status: nextStatus, action_kind: 'escalate' },
        });
        patchTask(taskRow.id, taskReadbackPatch(transitioned.task) ?? { status: nextStatus });
        const refreshedTasks = await refetchTaskQueueReadback();
        recordTaskActionReadback({
          kind: 'escalate',
          task: taskRow,
          refreshedTasks,
          taskEventId: taskEventIdFromReadback(transitioned),
          expectedStatus: nextStatus,
        });
        pushToast(fill(t('workflowReviewQueue.reviewQueueModule.escalated'), { task_id: String(taskRow.task_id) }), 'warn');
      } catch (err) {
        pushToast(t('workflowReviewQueue.reviewQueueModule.taskEscalationCouldNot'), 'danger');
      }
    },
    [transitionTask, t]
  );

  function openAssignPicker(taskRow: Task) {
    if (usersList.length === 0) {
      modal.open({
        title: t('workflowReviewQueue.reviewQueueModule.assignToUser'),
        body: (
          <StateView
            kind="error"
            title={t('workflowReviewQueue.reviewQueueModule.userSelectionIsNot')}
            hint={t('workflowReviewQueue.reviewQueueModule.userOptionsMustBe')}
          />
        ),
        footer: (
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button label={t('workflowReviewQueue.reviewQueueModule.close')} kind="ghost" onClick={() => modal.close()} />
          </div>
        ),
      });
      return;
    }
    let pickedId = usersList[0]!.id;
    modal.open({
      title: t('workflowReviewQueue.reviewQueueModule.assignToUser'),
      body: (
        <div style={{ padding: '8px 14px' }}>
          <select
            aria-label={t('workflowReviewQueue.reviewQueueModule.assignReviewTaskUser')}
            className="dt-inline-input"
            defaultValue={pickedId}
            onChange={(e) => {
              pickedId = e.target.value;
            }}
          >
            {usersList.map((u) => (
              <option key={u.id} value={u.id}>
                {(u.full_name ?? u.email ?? u.id)} · {u.id}
              </option>
            ))}
          </select>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowReviewQueue.reviewQueueModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.assign')}
            kind="primary"
            capability={CAP.TASKS_WRITE}
            onClick={async () => {
              try {
                const assigned = await assignTask.mutateAsync({
                  task_id: taskRow.id,
                  assigned_to: pickedId,
                  idempotency_key: `console-review-queue:assign:${taskRow.id}:${pickedId}`,
                  notes: 'Assigned from Console V2 review queue',
                });
                patchTask(taskRow.id, taskReadbackPatch(assigned.task) ?? { assigned_to: pickedId });
                const refreshedTasks = await refetchTaskQueueReadback();
                recordTaskActionReadback({
                  kind: 'assign',
                  task: taskRow,
                  refreshedTasks,
                  taskEventId: taskEventIdFromReadback(assigned),
                  expectedAssignedTo: pickedId,
                });
                modal.close();
                pushToast(fill(t('workflowReviewQueue.reviewQueueModule.assignedTo'), { task_id: String(taskRow.task_id), pickedId: String(pickedId) }), 'good');
              } catch (err) {
                pushToast(t('workflowReviewQueue.reviewQueueModule.taskAssignmentCouldNot'), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  async function bulkAction(kind: 'claim' | 'resolve' | 'escalate') {
    if (!selected.size) {
      pushToast(t('workflowReviewQueue.reviewQueueModule.noTasksSelected'), 'info');
      return;
    }
    const tasks = filteredTasks.filter((taskRow) => selected.has(taskRow.id));
    // W62-Workflows (Cycle F-R-2 P1-1) — bulk dispatch is row-driven via
    // `task_action_kind.<kind>.metadata.bulk_strategy`:
    //   • `assignment`        → canonical assign_task_v1, then local mirror.
    //   • `status_transition` → bulk RPC through `bulk_transition_tasks_v1`
    //                           with `to_status = nextStatusForAction(kind)`.
    // Replaces the literal `kind === 'claim'` / `kind === 'resolve' ||
    // kind === 'escalate'` branches (and the inline ternary
    // `kind === 'resolve' ? 'completed' : 'escalated'`) so adding a new
    // bulk-eligible action is a single seed insert. Fail-loud when the
    // canonical row is missing or carries an unrecognised strategy.
    const actionRow = lookupRow('task_action_kind', kind) as { metadata?: { bulk_strategy?: string } } | null;
    const strategy = actionRow?.metadata?.bulk_strategy;
    if (strategy === 'assignment') {
      try {
        const assignmentResults = await Promise.all(
          tasks.map((taskRow) =>
            assignTask.mutateAsync({
              task_id: taskRow.id,
              assigned_to: me,
              idempotency_key: `console-review-queue:bulk-claim:${taskRow.id}:${me}`,
              notes: 'Bulk claimed from Console V2 review queue',
            }),
          ),
        );
        tasks.forEach((taskRow, index) => {
          patchTask(taskRow.id, taskReadbackPatch(assignmentResults[index]?.task) ?? { assigned_to: me });
        });
        const refreshedTasks = await refetchTaskQueueReadback();
        recordBulkTaskReadback({
          kind,
          tasks,
          refreshedTasks,
          taskEventIds: assignmentResults.map((result) => taskEventIdFromReadback(result)),
          expectedAssignedTo: me,
        });
      } catch (err) {
        pushToast(t('workflowReviewQueue.reviewQueueModule.bulkTaskActionCould'), 'danger');
        return;
      }
    } else if (strategy === 'status_transition') {
      const to_status = nextStatusForAction(kind);
      if (!to_status) {
        pushToast(fill(t('workflowReviewQueue.reviewQueueModule.failedTheNextStatus2'), { kind: String(kind) }), 'danger');
        return;
      }
      // Phase C5: route through the canonical bulk_transition_tasks_v1 RPC
      // so the queue stays consistent end-to-end. Optimistic mirror still
      // updates so the UI feels instant.
      //
      // Wave 5 RE-AUDIT (WORKFLOWS.md P0 #3): canonical Phase B6 RPC contract
      // key is `to_status` (migration 202604280223), not `next_status`. The
      // api facade adapter still translates `next_status` defensively, but
      // call sites send the canonical key.
      try {
        const result = await bulkTransitionTasks.mutateAsync({
          task_ids: tasks.map((taskRow) => taskRow.id),
          to_status,
          action_kind: kind,
        });
        tasks.forEach((taskRow) => patchTask(taskRow.id, { status: to_status }));
        const refreshedTasks = await refetchTaskQueueReadback();
        const outcomes = bulkOutcomeRows(result);
        recordBulkTaskReadback({
          kind,
          tasks,
          refreshedTasks,
          taskEventIds: outcomes.map((row) => stringFromUnknown(row.task_event_id) || null),
          expectedStatus: to_status,
        });
      } catch (err) {
        pushToast(t('workflowReviewQueue.reviewQueueModule.bulkTaskActionCould'), 'danger');
        return;
      }
    } else {
      pushToast(fill(t('workflowReviewQueue.reviewQueueModule.failedTheBulkAction'), { kind: String(kind) }), 'danger');
      return;
    }
    setSelected(new Set());
    pushToast(`${kind} · ${tasks.length} tasks`, 'good');
  }

  function bulkReassign() {
    if (!selected.size) {
      pushToast(t('workflowReviewQueue.reviewQueueModule.noTasksSelected'), 'info');
      return;
    }
    if (usersList.length === 0) {
      modal.open({
        title: t('workflowReviewQueue.reviewQueueModule.reassignSelectedTo'),
        body: (
          <StateView
            kind="error"
            title={t('workflowReviewQueue.reviewQueueModule.userSelectionIsNot')}
            hint={t('workflowReviewQueue.reviewQueueModule.userOptionsMustBe2')}
          />
        ),
        footer: (
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button label={t('workflowReviewQueue.reviewQueueModule.close')} kind="ghost" onClick={() => modal.close()} />
          </div>
        ),
      });
      return;
    }
    let pickedId = usersList[0]!.id;
    modal.open({
      title: t('workflowReviewQueue.reviewQueueModule.reassignSelectedTo'),
      body: (
        <div style={{ padding: '8px 14px' }}>
          <select
            aria-label={t('workflowReviewQueue.reviewQueueModule.reassignSelectedReviewTasks')}
            className="dt-inline-input"
            defaultValue={pickedId}
            onChange={(e) => {
              pickedId = e.target.value;
            }}
          >
            {usersList.map((u) => (
              <option key={u.id} value={u.id}>
                {(u.full_name ?? u.email ?? u.id)} · {u.id}
              </option>
            ))}
          </select>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowReviewQueue.reviewQueueModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.reassign')}
            kind="primary"
            capability={CAP.TASKS_WRITE}
            onClick={async () => {
              const tasks = filteredTasks.filter((taskRow) => selected.has(taskRow.id));
              try {
                const assignmentResults = await Promise.all(
                  tasks.map((taskRow) =>
                    assignTask.mutateAsync({
                      task_id: taskRow.id,
                      assigned_to: pickedId,
                      idempotency_key: `console-review-queue:bulk-reassign:${taskRow.id}:${pickedId}`,
                      notes: 'Bulk reassigned from Console V2 review queue',
                    }),
                  ),
                );
                tasks.forEach((taskRow, index) => {
                  patchTask(taskRow.id, taskReadbackPatch(assignmentResults[index]?.task) ?? { assigned_to: pickedId });
                });
                const refreshedTasks = await refetchTaskQueueReadback();
                recordBulkTaskReadback({
                  kind: 'reassign',
                  tasks,
                  refreshedTasks,
                  taskEventIds: assignmentResults.map((result) => taskEventIdFromReadback(result)),
                  expectedAssignedTo: pickedId,
                });
                setSelected(new Set());
                modal.close();
                pushToast(fill(t('workflowReviewQueue.reviewQueueModule.reassignedTo'), { length: String(tasks.length), pickedId: String(pickedId) }), 'good');
              } catch (err) {
                pushToast(t('workflowReviewQueue.reviewQueueModule.taskReassignmentCouldNot'), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  function openSnoozePicker() {
    if (!selected.size) {
      pushToast(t('workflowReviewQueue.reviewQueueModule.noTasksSelected'), 'info');
      return;
    }
    if (snoozeOptions.length === 0) {
      modal.open({
        title: t('workflowReviewQueue.reviewQueueModule.snoozeFor'),
        body: (
          <StateView
            kind="error"
      title={t('workflowReviewQueue.reviewQueueModule.snoozeOptionsAreNot')}
      hint={t('workflowReviewQueue.reviewQueueModule.thisOptionIsNot')}
          />
        ),
        footer: (
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button label={t('workflowReviewQueue.reviewQueueModule.close')} kind="ghost" onClick={() => modal.close()} />
          </div>
        ),
      });
      return;
    }
    let pickedId = snoozeOptions[0]!.value;
    modal.open({
      title: t('workflowReviewQueue.reviewQueueModule.snoozeFor'),
      body: (
        <div style={{ padding: '8px 14px' }}>
          <select
            className="dt-inline-input"
            defaultValue={pickedId}
            onChange={(e) => {
              pickedId = e.target.value;
            }}
          >
            {snoozeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowReviewQueue.reviewQueueModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.snooze')}
            kind="primary"
            capability={CAP.TASKS_WRITE}
            onClick={async () => {
              const tasks = filteredTasks.filter((taskRow) => selected.has(taskRow.id));
              // W27 Cycle D closure: resolve the canonical option (with
              // duration_seconds) before computing the offset. Missing or
              // malformed canonical row aborts the bulk action with a
              // danger toast — no silent fallback.
              const option = snoozeOptions.find((o) => o.value === pickedId);
              if (!option) {
      pushToast(fill(t('workflowReviewQueue.reviewQueueModule.snoozeFailedSnoozeOption2'), { pickedId: String(pickedId) }), 'danger');
                return;
              }
              const snooze_until = snoozeUntil(option);
              if (!snooze_until) {
                pushToast(fill(t('workflowReviewQueue.reviewQueueModule.snoozeFailedOptionHas2'), { pickedId: String(pickedId) }), 'danger');
                return;
              }
              // Phase C5: route through canonical bulk_transition_tasks_v1.
              //
              // Wave 5 RE-AUDIT (WORKFLOWS.md P0 #3): canonical Phase B6 RPC
              // contract key is `to_status` (migration 202604280223), not
              // `next_status`. The api facade adapter still translates
              // `next_status` defensively, but call sites send the canonical
              // key.
              //
              // Cycle E2 (Workflows P1 #6) — `to_status` for the bulk
              // snooze resolves canonically through `nextStatusForAction
              // ('snooze')`. Replaces the literal `to_status: 'snoozed'`
              // and the optimistic-patch literal so adding a new snooze-
              // equivalent next_status is a single seed update.
              const bulkNextStatus = nextStatusForAction('snooze');
              try {
                const result = await bulkTransitionTasks.mutateAsync({
                  task_ids: tasks.map((taskRow) => taskRow.id),
                  to_status: bulkNextStatus,
                  payload: { snooze_until },
                  action_kind: 'snooze',
                });
                tasks.forEach((taskRow) => patchTask(taskRow.id, { status: bulkNextStatus, snooze_until }));
                const refreshedTasks = await refetchTaskQueueReadback();
                const outcomes = bulkOutcomeRows(result);
                recordBulkTaskReadback({
                  kind: 'snooze',
                  tasks,
                  refreshedTasks,
                  taskEventIds: outcomes.map((row) => stringFromUnknown(row.task_event_id) || null),
                  taskEventPayloads: outcomes.map((row) => bulkOutcomePayload(row)),
                  expectedStatus: bulkNextStatus,
                  expectedSnoozeUntil: snooze_until,
                });
                setSelected(new Set());
                modal.close();
                pushToast(fill(t('workflowReviewQueue.reviewQueueModule.snoozedTasksFor'), { length: String(tasks.length), pickedId: String(pickedId) }), 'good');
              } catch (err) {
                pushToast(t('workflowReviewQueue.reviewQueueModule.taskSnoozeCouldNot'), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  function openContextMenu(taskRow: Task) {
    // W27 Cycle D closure: write actions (claim/resolve/snooze/escalate)
    // are gated on `canWriteTasks` (CAP.TASKS_WRITE) so the FE matches
    // the server-side `tasks.write` enforcement and the operator never
    // sees an action they cannot complete. The "Snooze 4h" literal is
    // replaced with the canonical default key from
    // `ui_presentation_policy.task_snooze.default_key` (resolved label
    // from the matching option row). When the policy default key is
    // missing, the snooze entry is omitted rather than falling through
    // to a hardcoded label.
    const defaultOption = defaultSnoozeKey
      ? snoozeOptions.find((o) => o.value === defaultSnoozeKey)
      : null;
    const acts: Array<{ label: string; onPick: () => void }> = [
      { label: t('workflowReviewQueue.reviewQueueModule.openDetail'), onPick: () => setActiveTaskId(taskRow.id) },
    ];
    if (canWriteTasks) {
      acts.push({ label: t('workflowReviewQueue.reviewQueueModule.claim'), onPick: () => claim(taskRow) });
      acts.push({ label: t('workflowReviewQueue.reviewQueueModule.resolve'), onPick: () => void resolve(taskRow) });
      if (defaultOption) {
        acts.push({
          label: fill(t('workflowReviewQueue.reviewQueueModule.snooze2'), { label: String(defaultOption.label) }),
          onPick: () => void snoozeOne(taskRow, defaultOption.value),
        });
      }
      acts.push({
        label: t('workflowReviewQueue.reviewQueueModule.escalate'),
        onPick: () => void escalateOne(taskRow),
      });
    }
    acts.push({
      label: t('workflowReviewQueue.reviewQueueModule.openInNewTab'),
            onPick: () => window.open(`/workflows/review-queue?focus=${encodeURIComponent(taskRow.id)}`, '_blank'),
    });
    modal.open({
      title: taskRow.task_id,
      body: (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {acts.map((a) => (
            <button
              key={a.label}
              type="button"
              className="btn btn--ghost"
              style={{ justifyContent: 'flex-start' }}
              onClick={() => {
                modal.close();
                a.onPick();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ),
      footer: <Button label={t('workflowReviewQueue.reviewQueueModule.close')} kind="ghost" onClick={() => modal.close()} />,
    });
  }

  function openSaveViewPicker() {
    let nameInput = '';
    modal.open({
      title: t('workflowReviewQueue.reviewQueueModule.saveView'),
      body: (
        <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label
            htmlFor="wf-rq-view-name"
            style={{ fontSize: '11px', color: 'var(--ink-3)' }}
          >
            {t('workflowReviewQueue.reviewQueueModule.viewName')}
          </label>
          <input
            id="wf-rq-view-name"
            type="text"
            className="dt-inline-input"
            placeholder={t('workflowReviewQueue.reviewQueueModule.eGNdrMy')}
            onChange={(e) => {
              nameInput = e.target.value;
            }}
            autoFocus
          />
          <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
            {fill(t('workflowReviewQueue.reviewQueueModule.capturesFilter'), { activeFilter: String(activeFilter) })}
            {search ? <> {fill(t('workflowReviewQueue.reviewQueueModule.search'), { search: String(search) })}</> : null}
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowReviewQueue.reviewQueueModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.save')}
            kind="primary"
            onClick={() => {
              const label = nameInput.trim();
              if (!label) {
                pushToast(t('workflowReviewQueue.reviewQueueModule.viewNameIsRequired'), 'warn');
                return;
              }
              saveView(label, activeFilter, search);
              setSavedViews(listSavedViews());
              modal.close();
              pushToast(fill(t('workflowReviewQueue.reviewQueueModule.savedView'), { label: String(label) }), 'good');
            }}
          />
        </div>
      ),
    });
  }

  function applySavedView(view: SavedView) {
    setActiveFilter(view.filter as FilterId);
    setSearch(view.search);
    setActiveTaskId(null);
  }

  function removeSavedView(id: string) {
    deleteView(id);
    setSavedViews(listSavedViews());
  }

  // Keyboard navigation. Any handler that fires while focus sits in an
  // INPUT/TEXTAREA/contentEditable is short-circuited so reviewers can type
  // freely. Action keys 1..9 read directly from the row-driven action list.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const focused = document.activeElement as HTMLElement | null;
      const inField =
        focused &&
        (focused.tagName === 'INPUT' ||
          focused.tagName === 'TEXTAREA' ||
          focused.isContentEditable);

      if (e.key === 'Escape') {
        // Esc always works — blurs whichever field is focused so the rest of
        // the keyboard surface re-engages.
        if (inField && focused) focused.blur();
        return;
      }

      if (e.key === '/') {
        // Focus the search input. Skip when already typing somewhere.
        if (!inField) {
          searchRef.current?.focus();
          e.preventDefault();
        }
        return;
      }

      if (inField) return;

      const tasks = filteredTasks;
      if (!tasks.length) return;
      const idx = tasks.findIndex((tt) => tt.id === activeTaskId);

      if (e.key === 'j' || e.key === 'ArrowDown') {
        const next = tasks[Math.min(tasks.length - 1, idx + 1)];
        if (next) setActiveTaskId(next.id);
        e.preventDefault();
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        const next = tasks[Math.max(0, idx - 1)];
        if (next) setActiveTaskId(next.id);
        e.preventDefault();
        return;
      }
      if (e.key === 'x' || e.key === 'X') {
        if (activeTask) {
          setSelected((prev) => {
            const n = new Set(prev);
            if (n.has(activeTask.id)) n.delete(activeTask.id);
            else n.add(activeTask.id);
            return n;
          });
        }
        e.preventDefault();
        return;
      }
      // W35c-2 — write-action keyboard shortcuts gate on `tasks.write`. The
      // canonical RPCs (`bulk_transition_tasks_v1` / `transition_task_v1`)
      // server-assert this capability, so the FE shortcut surface fail-closes
      // optimistically and surfaces a permission-denied toast instead of
      // dispatching a mutation the server will reject. Navigation/selection
      // keys (j/k/x/Arrow*/Escape/`/`) remain read-only and are never gated.
      // Closes REAUDIT3/WORKFLOWS.md P1-2.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (!canWriteTasks) {
          pushToast(t('workflowReviewQueue.reviewQueueModule.permissionDeniedTaskUpdate'), 'warn');
          e.preventDefault();
          return;
        }
        if (activeTask) void resolve(activeTask);
        e.preventDefault();
        return;
      }
      if (!activeTask) return;
      if (e.key === 'c' || e.key === 'C') {
        if (!canWriteTasks) {
          pushToast(t('workflowReviewQueue.reviewQueueModule.permissionDeniedTaskUpdate2'), 'warn');
          e.preventDefault();
          return;
        }
        claim(activeTask);
        e.preventDefault();
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        if (!canWriteTasks) {
          pushToast(t('workflowReviewQueue.reviewQueueModule.permissionDeniedTaskUpdate3'), 'warn');
          e.preventDefault();
          return;
        }
        void escalateOne(activeTask);
        e.preventDefault();
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        if (!canWriteTasks) {
          pushToast(t('workflowReviewQueue.reviewQueueModule.permissionDeniedTaskUpdate4'), 'warn');
          e.preventDefault();
          return;
        }
        if (defaultSnoozeKey == null) {
          // Page-level strict guard renders a danger StateView when this is
          // unresolved, but the keyboard listener is registered before that
          // guard returns; surface explicitly instead of synthesising a key.
          pushToast(t('workflowReviewQueue.reviewQueueModule.snoozeUnavailableDefaultSnooze'), 'danger');
          e.preventDefault();
          return;
        }
        void snoozeOne(activeTask, defaultSnoozeKey);
        e.preventDefault();
        return;
      }
      if (e.key >= '1' && e.key <= '9') {
        const acts = resolveAllowedActions(activeTask);
        const a = acts[parseInt(e.key, 10) - 1];
        if (a) {
          if (!canWriteTasks) {
            pushToast(fill(t('workflowReviewQueue.reviewQueueModule.permissionDeniedTaskUpdate5'), { label: String(a.label) }), 'warn');
            e.preventDefault();
            return;
          }
          void apply(activeTask, a);
          e.preventDefault();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [filteredTasks, activeTaskId, activeTask, resolve, apply, claim, escalateOne, snoozeOne, canWriteTasks, defaultSnoozeKey, t]);

  if (!canRead) {
    return (
      <div className="page wf-rq">
        <PageHeader
          moduleKey="wf-review"
          eyebrow={t('workflowReviewQueue.reviewQueueModule.workflows')}
          titleAccent="Review"
          titlePlain="queue"
        />
        <StateView
          kind="denied"
          capability={CAP.TASKS_READ}
          hint={t('workflowReviewQueue.reviewQueueModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (slaPolicy.isLoading || uiPresentationPolicy.isLoading) {
    return (
      <div className="page wf-rq">
        <PageHeader moduleKey="wf-review" eyebrow={t('workflowReviewQueue.reviewQueueModule.workflows')} titleAccent="Review" titlePlain="queue" />
        <StateView kind="loading" />
      </div>
    );
  }

  if (slaRingWarnPct == null || slaRingDangerPct == null || noSlaDefaultPct == null) {
    return (
      <div className="page wf-rq">
        <PageHeader moduleKey="wf-review" eyebrow={t('workflowReviewQueue.reviewQueueModule.workflows')} titleAccent="Review" titlePlain="queue" />
        <StateView
          kind="error"
          title={t('workflowReviewQueue.reviewQueueModule.reviewQueueTimingSettings')}
          hint={t('workflowReviewQueue.reviewQueueModule.askAnAdministratorTo')}
        />
      </div>
    );
  }

  // W49 strict closure: snooze default key must come from canonical
  // `ui_presentation_policy.task_snooze.default_key`. Missing canonical row
  // surfaces this danger StateView so operators see the gap.
  if (!uiPresentationPolicy.isLoading && defaultSnoozeKey == null) {
    return (
      <div className="page wf-rq">
        <PageHeader moduleKey="wf-review" eyebrow={t('workflowReviewQueue.reviewQueueModule.workflows')} titleAccent="Review" titlePlain="queue" />
        <StateView
          kind="error"
        title={t('workflowReviewQueue.reviewQueueModule.defaultSnoozeOptionIs')}
        hint={t('workflowReviewQueue.reviewQueueModule.thisOptionIsNot')}
        />
      </div>
    );
  }

  if (tasksQuery.isLoading) {
    return (
      <div className="page wf-rq">
        <PageHeader
          moduleKey="wf-review"
          eyebrow={t('workflowReviewQueue.reviewQueueModule.workflows')}
          titleAccent="Review"
          titlePlain="queue"
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (tasksQuery.error) {
    return (
      <div className="page wf-rq">
        <PageHeader
          moduleKey="wf-review"
          eyebrow={t('workflowReviewQueue.reviewQueueModule.workflows')}
          titleAccent="Review"
          titlePlain="queue"
          pills={[]}
        />
        <StateView kind="error" hint={String(tasksQuery.error)} />
      </div>
    );
  }

  const item = activeTask;
  const parentWorkflowRunId = item ? taskParentWorkflowRunId(item) : '';
  const linkedRun =
    item &&
    runs.find(
      (r) =>
        (parentWorkflowRunId && r.id === parentWorkflowRunId) ||
        r.id === item.workflow_run_id ||
        (typeof r.template_id === 'string' &&
          taskTypeValue(item) &&
          r.template_id.includes(taskTypeValue(item).split('_')[0] ?? ''))
    );
  const activeTaskTerminal = item ? isTaskTerminal(item.status) : false;
  const activeTaskActions = item && !activeTaskTerminal ? resolveAllowedActions(item) : [];
  const completionPrimaryAction = item && !activeTaskTerminal
    ? activeTaskActions.find((action) => taskCompletionSchema(item, action))
    : null;
  const primaryTaskAction = completionPrimaryAction
    ?? activeTaskActions.find((action) => action.kind === 'resolve')
    ?? null;
  const completionPrimarySchema = item && completionPrimaryAction
    ? taskCompletionSchema(item, completionPrimaryAction)
    : null;

  // Decision evidence chip target — prefer the explicit workflow_run_id
  // (canonical FK once `tasks.workflow_run_id` is wired) and fall back to the
  // task_id so the link is always meaningful.
  const evidenceFocusId = item ? (item.workflow_run_id ?? item.task_id ?? item.id) : null;
  const activeAuditCorrelationIds = item ? taskAuditCorrelationIds(item, linkedRun) : new Set<string>();
  const activeAuditRows = item
    ? auditChanges
        .filter((row) => auditMatchesTask(row, item, activeAuditCorrelationIds))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    : [];
  const bulkTaskReadbackComplete = bulkTaskReadback
    ? bulkTaskReadback.confirmedTaskIds.length === bulkTaskReadback.total
      && bulkTaskReadback.taskEventIds.length >= bulkTaskReadback.total
      && (!bulkTaskReadback.expectedSnoozeUntil || bulkTaskReadback.confirmedSnoozeUntil === bulkTaskReadback.expectedSnoozeUntil)
    : false;
  const taskActionReadbackComplete = taskActionReadback
    ? taskActionReadback.confirmed
      && Boolean(taskActionReadback.taskEventId)
      && (!taskActionReadback.expectedSnoozeUntil || taskActionReadback.confirmedSnoozeUntil === taskActionReadback.expectedSnoozeUntil)
    : false;
  const activeTaskEventsLoading = canRead && activeTaskEventsQuery.isLoading;
  const activeTaskEventsError = canRead && activeTaskEventsQuery.isError;
  const auditActivityLoading = canReadAuditLog && auditChangesQuery.isLoading && activeTaskEventRows.length === 0;
  const auditActivityError = canReadAuditLog && auditChangesQuery.isError && activeTaskEventRows.length === 0;

  return (
    <div className="page wf-rq">
      <PageHeader
        moduleKey="wf-review"
        eyebrow={t('workflowReviewQueue.reviewQueueModule.workflows')}
        titleAccent="Review"
        titlePlain="queue"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="src" className="chip chip--xs mono">{t('workflowReviewQueue.reviewQueueModule.taskQueueTaskCatalog')}</span>,
        ]}
        actions={[
          <Button
            key="bulk-claim"
            label={t('workflowReviewQueue.reviewQueueModule.bulkClaim')}
            iconName="check"
            kind="ghost"
            capability={CAP.TASKS_WRITE}
            onClick={() => void bulkAction('claim')}
          />,
          <Button
            key="filter"
            label={t('workflowReviewQueue.reviewQueueModule.filter')}
            iconName="filter"
            kind="ghost"
            onClick={() => pushToast(t('workflowReviewQueue.reviewQueueModule.useFilterChipsAbove'), 'info')}
          />,
        ]}
      />
      <div className="wf-rq-filterbar">
        {FILTERS.map((f) => {
          const count = (counts as Record<FilterId, number>)[f.id];
          return (
            <button
              key={f.id}
              type="button"
              className={`wf-rq-filterchip ${activeFilter === f.id ? 'is-active' : ''} ${f.tone ? `wf-rq-filterchip--${f.tone}` : ''}`}
              onClick={() => {
                setActiveFilter(f.id);
                setActiveTaskId(null);
              }}
            >
              <span>{t(`workflowReviewQueue.filters.${f.id}`)}</span>
              <span className="mono" style={{ color: 'var(--ink-2)' }}>
                {String(count)}
              </span>
            </button>
          );
        })}
        {savedViews.map((v) => (
          <button
            key={v.id}
            type="button"
            className="wf-rq-filterchip wf-rq-filterchip--saved"
            onClick={() => applySavedView(v)}
            onContextMenu={(e) => {
              e.preventDefault();
              removeSavedView(v.id);
              pushToast(fill(t('workflowReviewQueue.reviewQueueModule.removedView'), { label: String(v.label) }), 'info');
            }}
            title={t('workflowReviewQueue.reviewQueueModule.clickToApplyRight')}
          >
            <Icon name="check" size={10} />
            <span>{v.label}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <input
          ref={searchRef}
          type="text"
          data-testid="wf-rq-search"
          className="wf-rq-search"
          placeholder={t('workflowReviewQueue.reviewQueueModule.searchTaskIdSubject')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActiveTaskId(null);
          }}
          aria-label={t('workflowReviewQueue.reviewQueueModule.searchTasks')}
        />
        <Button
          label={t('workflowReviewQueue.reviewQueueModule.saveView')}
          iconName="check"
          kind="ghost"
          onClick={() => openSaveViewPicker()}
        />
        <div className="wf-rq-shortcut-hint mono">
          {t('workflowReviewQueue.reviewQueueModule.jKNavigateC')}
        </div>
      </div>
      <div className="wf-rq-body">
        <aside className="wf-rq-list">
          {filteredTasks.length === 0 ? (
            <StateView
              kind="empty"
              title={t('workflowReviewQueue.reviewQueueModule.noTasks')}
              hint={
                activeFilter === 'mine'
                  ? t('workflowReviewQueue.reviewQueueModule.nothingAssignedToYou')
                  : t('workflowReviewQueue.reviewQueueModule.noTasksMatchThis')
              }
            />
          ) : (
            <>
              <div className="wf-rq-list__head">
                <span className="mono">
                  {fill(filteredTasks.length === 1 ? t('workflowReviewQueue.reviewQueueModule.taskCountOne') : t('workflowReviewQueue.reviewQueueModule.taskCountOther'), { count: String(filteredTasks.length) })}
                </span>
                <div style={{ flex: 1 }} />
                <select
                  aria-label={t('workflowReviewQueue.reviewQueueModule.sortReviewQueue')}
                  className="dt-inline-input"
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  style={{ width: 120 }}
                >
                  {SORT_MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {t(`workflowReviewQueue.sortModes.${mode.id}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="wf-rq-list__items" role="list" aria-label={t('workflowReviewQueue.reviewQueueModule.reviewQueueTasks')}>
                {filteredTasks.map((task) => {
                  // W34c bug fix: slaPercent signature is
                  // (task, noSlaDefaultPct, nowMs?). The prior call passed
                  // (task, nowTick) which silently fed nowTick (Date.now())
                  // into the noSlaDefaultPct slot, producing percent values
                  // ~1.7e12 for tasks without sla_due_at and breaking the SLA
                  // ring rendering. Pass the canonical resolved noSlaDefaultPct.
                  const slaPct = slaPercent(task, noSlaDefaultPct, nowTick);
                  const isActive = activeTaskId === task.id;
                  const isSelected = selected.has(task.id);
                  return (
                    <div
                      key={task.id}
                      role="listitem"
                      aria-current={isActive ? 'true' : undefined}
                      aria-label={fill(t('workflowReviewQueue.reviewQueueModule.task2'), { value: String(task.task_id ?? task.id), value2: String(taskSubject(task)) })}
                      tabIndex={0}
                      className={`wf-rq-row ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''} ${lookupRow('task_status', task.status)?.metadata?.is_terminal === true ? 'is-completed' : ''}`}
                      onClick={(e) => {
                        // Skip if click came from inner interactive elements (input/button)
                        const target = e.target as HTMLElement;
                        if (target.closest('input,button,a,select,textarea')) return;
                        if (e.shiftKey) {
                          setSelected((prev) => {
                            const n = new Set(prev);
                            if (n.has(task.id)) n.delete(task.id);
                            else n.add(task.id);
                            return n;
                          });
                          return;
                        }
                        setActiveTaskId(task.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setActiveTaskId(task.id);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openContextMenu(task);
                      }}
                    >
                      <input
                        type="checkbox"
                        className="wf-rq-row__check"
                        aria-label={fill(t('workflowReviewQueue.reviewQueueModule.selectTask'), { value: String(task.task_id ?? task.id) })}
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => {
                          setSelected((prev) => {
                            const n = new Set(prev);
                            if (n.has(task.id)) n.delete(task.id);
                            else n.add(task.id);
                            return n;
                          });
                        }}
                      />
                      <SLARing percent={slaPct} warnPct={slaRingWarnPct} dangerPct={slaRingDangerPct} />
                      <div className="wf-rq-row__body">
                        <div className="wf-rq-row__head">
                          <span
                            className="mono"
                            style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}
                          >
                            {task.task_id}
                          </span>
                          {(() => {
                            // W34c — task_type chip tone resolves from canonical
                            // `task_type` lookup metadata.tone. Missing rows fail
                            // loud as a danger chip with the (missing) marker.
                            const row = taskTypeRow(task);
                            if (!row) {
                              return (
                                <Chip
                                  label={fill(t('workflowReviewQueue.reviewQueueModule.taskTypeMissing'), { value: String(taskTypeValue(task) || 'unset') })}
                                  kind="danger"
                                  size="xs"
                                />
                              );
                            }
                            const tone = (row.tone as ChipKind | undefined) ?? 'neutral';
                            const label = row.label ?? taskTypeLabel(task);
                            return <Chip label={label} kind={tone} size="xs" />;
                          })()}
                          <div style={{ flex: 1 }} />
                          {(() => {
                            const r = statusTone(task.status);
                            return r.tone && r.label
                              ? <Chip label={r.label} kind={r.tone} size="xs" />
                              : <Chip label={fill(t('workflowReviewQueue.reviewQueueModule.taskStatusMissing'), { status: String(task.status) })} kind="danger" size="xs" />;
                          })()}
                        </div>
                        <div className="wf-rq-row__subject">{taskSubject(task)}</div>
                        <div className="wf-rq-row__meta mono">
                          <span>{taskQueueValue(task) || '—'}</span>
                          <span style={{ opacity: 0.4, margin: '0 6px' }}>·</span>
                          <span>
                            {isTaskSnoozed(task.status) && task.snooze_until
                              ? fill(t('workflowReviewQueue.reviewQueueModule.wakesIn'), { value: String(formatSlaCountdown(task.snooze_until, durationFormatPolicy, nowTick)) })
                              : task.sla_due_at
                                ? fill(t('workflowReviewQueue.reviewQueueModule.slaIn'), { value: String(formatSlaCountdown(task.sla_due_at, durationFormatPolicy, nowTick)) })
                                : t('workflowReviewQueue.reviewQueueModule.noSla')}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </aside>
        <section className="wf-rq-detail">
          {!item ? (
            <StateView
              kind="empty"
              title={t('workflowReviewQueue.reviewQueueModule.noTaskSelected')}
              hint={t('workflowReviewQueue.reviewQueueModule.pickATaskFrom')}
            />
          ) : (
            <>
              <header className="wf-rq-detail__head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '11px',
                      color: 'var(--ink-3)',
                    }}
                  >
                    <span className="mono">{item.task_id}</span>
                    <span>·</span>
                    <span>{taskTypeLabel(item)}</span>
                  </div>
                  <h2 className="wf-rq-detail__title">{taskSubject(item)}</h2>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      marginTop: '4px',
                    }}
                  >
                    {(() => {
                      const r = statusTone(item.status);
                      return r.tone && r.label
                        ? <Chip label={r.label} kind={r.tone} size="xs" />
                        : <Chip label={fill(t('workflowReviewQueue.reviewQueueModule.taskStatusMissing'), { status: String(item.status) })} kind="danger" size="xs" />;
                    })()}
                    {isTaskSnoozed(item.status) && item.snooze_until ? (
                      <Chip
                        label={fill(t('workflowReviewQueue.reviewQueueModule.wakesIn'), { value: String(formatSlaCountdown(item.snooze_until, durationFormatPolicy, nowTick)) })}
                        kind="info"
                        size="xs"
                      />
                    ) : null}
                    <SLARing percent={slaPercent(item, noSlaDefaultPct, nowTick)} warnPct={slaRingWarnPct} dangerPct={slaRingDangerPct} variant="inline" />
                    <span
                      className="mono"
                      style={{ fontSize: '11px', color: 'var(--ink-3)' }}
                    >
                      {item.sla_due_at
                        ? fill(t('workflowReviewQueue.reviewQueueModule.sla'), { value: String(new Date(item.sla_due_at).toLocaleString()) })
                        : t('workflowReviewQueue.reviewQueueModule.noSla')}
                    </span>
                    <button
                      type="button"
                      data-testid="wf-rq-evidence"
                      className="wf-rq-evidence-btn"
                      title={t('workflowReviewQueue.reviewQueueModule.openDecisionEvidenceTrail')}
                      onClick={() => {
                        if (!evidenceFocusId) return;
                        navigate({
                          to: '/insights/decisions',
                          search: { focus: String(evidenceFocusId) } as never,
                        });
                      }}
                    >
                      <Chip
                        label={fill(t('workflowReviewQueue.reviewQueueModule.evidence'), { value: String(evidenceFocusId ?? '—') })}
                        kind="info"
                        size="xs"
                      />
                    </button>
                  </div>
                </div>
                {!activeTaskTerminal ? (
                  <div className="wf-rq-detail__actions">
                    <Button
                      label={t('workflowReviewQueue.reviewQueueModule.claim')}
                      iconName="check"
                      kind="ghost"
                      capability={CAP.TASKS_WRITE}
                      onClick={() => void claim(item)}
                    />
                    <Button
                      label={completionPrimarySchema?.submit_label ?? primaryTaskAction?.label ?? t('workflowReviewQueue.reviewQueueModule.noTaskAction')}
                      iconName="check"
                      kind="primary"
                      disabled={!primaryTaskAction}
                      title={primaryTaskAction ? undefined : t('workflowReviewQueue.reviewQueueModule.noRowAllowedTask')}
                      capability={CAP.TASKS_WRITE}
                      onClick={() => {
                        if (completionPrimaryAction) {
                          void apply(item, completionPrimaryAction);
                          return;
                        }
                        if (primaryTaskAction) void apply(item, primaryTaskAction);
                      }}
                    />
                  </div>
                ) : (
                  <Chip label={t('workflowReviewQueue.reviewQueueModule.noActionsAvailable')} kind="neutral" size="xs" />
                )}
              </header>
              <div className="wf-rq-detail__kv">
                <div className="wf-rq-detail__kv-row">
                  <span className="wf-rq-detail__kv-key mono">{t('workflowReviewQueue.reviewQueueModule.queue')}</span>
                  <span className="mono">{taskQueueValue(item) || '—'}</span>
                </div>
                <div className="wf-rq-detail__kv-row">
                  <span className="wf-rq-detail__kv-key mono">{t('workflowReviewQueue.reviewQueueModule.assignedTo2')}</span>
                  {item.assigned_to ? (
                    <span className="mono">{item.assigned_to}</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={!canWriteTasks || usersQuery.isPending}
                      title={canWriteTasks ? t('workflowReviewQueue.reviewQueueModule.assignTask') : t('workflowReviewQueue.reviewQueueModule.taskUpdatePermissionRequired')}
                      onClick={() => openAssignPicker(item)}
                    >
                      {t('workflowReviewQueue.reviewQueueModule.assign2')}
                    </button>
                  )}
                </div>
                <div className="wf-rq-detail__kv-row">
                  <span className="wf-rq-detail__kv-key mono">{t('workflowReviewQueue.reviewQueueModule.created')}</span>
                  <span className="mono" style={{ fontSize: '11px' }}>
                    {item.created_at ? new Date(item.created_at).toLocaleString() : '—'}
                  </span>
                </div>
                <div className="wf-rq-detail__kv-row">
                  <span className="wf-rq-detail__kv-key mono">{t('workflowReviewQueue.reviewQueueModule.priority')}</span>
                  {(() => {
                    // W76 (Cycle F-R-16 P1) — canonical default priority resolves
                    // through `task_priority` row `is_default: true` (mirrors W75
                    // templates.tsx:1314 / W68 runs.tsx defaultStepKind pattern).
                    // Replaces literal `|| 'normal'` fallback past `_default`.
                    // AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6 row-driven.
                    const priorityValue = taskPriorityValue(item);
                    const priorityRow = lookupRow('task_priority', priorityValue);
                    if (!priorityRow) {
                      return (
                        <Chip
                          label={fill(t('workflowReviewQueue.reviewQueueModule.taskPriorityMissing'), { priorityValue: String(priorityValue) })}
                          kind="danger"
                          size="xs"
                        />
                      );
                    }
                    return (
                      <Chip
                        label={priorityRow.label ?? priorityValue}
                        kind={(priorityRow.tone as ChipKind) ?? 'neutral'}
                        size="xs"
                      />
                    );
                  })()}
                </div>
              </div>
              {linkedRun ? (
                <>
                  <div className="wf-insp__section-eyebrow">{t('workflowReviewQueue.reviewQueueModule.linkedWorkflowRun')}</div>
                  <div style={{ padding: '0 14px 10px' }}>
                    <button
                      type="button"
                      className="wf-run-corr__chip"
                      onClick={() => {
                        void navigate({
                          to: '/workflows/runs',
                          search: { focus: linkedRun.id } as never,
                        });
                      }}
                    >
                      {(() => {
                        const runStatus = workflowRunStatusValue(linkedRun);
                        const runRow = lookupRow('workflow_run_status', runStatus);
                        if (!runRow) {
                          return (
                            <Chip
                              label={t('workflowReviewQueue.reviewQueueModule.runStatusLabelIs')}
                              kind="danger"
                              size="xs"
                            />
                          );
                        }
                        const tone = (runRow.tone as ChipKind | undefined) ?? null;
                        const dotKind: 'good' | 'warn' | 'danger' | 'neutral' =
                          tone === 'good' || tone === 'warn' || tone === 'danger'
                            ? tone
                            : 'neutral';
                        return (
                          <>
                            <Dot kind={dotKind} />
                            <Chip
                              label={runRow.label ?? runStatus}
                              kind={tone ?? 'neutral'}
                              size="xs"
                            />
                          </>
                        );
                      })()}
                      <span className="mono">{stringFromUnknown(linkedRun.run_id) || linkedRun.id}</span>
                      <span>
                        {stringFromUnknown(linkedRun.template_name) ||
                          stringFromUnknown(linkedRun.workflow_template_id) ||
                          stringFromUnknown(linkedRun.template_id) ||
                          t('workflowReviewQueue.reviewQueueModule.workflowRun')}
                      </span>
                    </button>
                  </div>
                </>
              ) : null}
              <div className="wf-insp__section-eyebrow">{t('workflowReviewQueue.reviewQueueModule.description')}</div>
              <div
                style={{
                  padding: '0 14px 12px',
                  fontSize: '12.5px',
                  color: 'var(--ink-2)',
                  lineHeight: 1.5,
                }}
              >
                {item.description || synthesizeDescription(item)}
              </div>
              <div className="wf-insp__section-eyebrow">{t('workflowReviewQueue.reviewQueueModule.allowedActions')}</div>
              <div className="wf-rq-actions-grid">
                {activeTaskActions.length === 0 ? (
                  <p className="state__hint" style={{ margin: 0 }}>
                    {activeTaskTerminal
                      ? t('workflowReviewQueue.reviewQueueModule.noActionsAvailableFor')
                      : t('workflowReviewQueue.reviewQueueModule.noRowAllowedTask2')}
                  </p>
                ) : activeTaskActions.map((a) => {
                  // W74-Workflows (Cycle F-R-14 P2-1) — row-driven snooze gating.
                  // Resolve the canonical `task_action_kind` row and consult
                  // `metadata.is_snooze_action` instead of comparing against the
                  // literal `'snooze'` string. The row is added in
                  // lib/seed-raw/lookups.js and the boolean flag is the canonical
                  // SSOT for "is this the snooze action?" so a future spelling
                  // (e.g. `defer`) flows through one source.
                  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
                  const isSnoozed =
                    lookupRow('task_action_kind', a.kind)?.metadata?.is_snooze_action === true
                    && isTaskSnoozed(item.status);
                  return (
                    <button
                      key={a.kind}
                      type="button"
                      data-testid={`wf-rq-action-${a.kind}`}
                      data-action-kind={a.kind}
                      aria-pressed={isSnoozed ? 'true' : undefined}
                      className="wf-rq-action"
                      onClick={() => void apply(item, a)}
                    >
                      <Icon name={a.icon} size={12} />
                      <span>{a.label}</span>
                      {a.shortcut ? <span className="kbd">{a.shortcut}</span> : null}
                    </button>
                  );
                })}
              </div>
              <div className="wf-insp__section-eyebrow">{t('workflowReviewQueue.reviewQueueModule.activity')}</div>
              <AuditActivityPanel
                canReadAuditLog={canReadAuditLog}
                canReadTaskEvents={canRead}
                isLoading={activeTaskEventsLoading || auditActivityLoading}
                isError={activeTaskEventsError || auditActivityError}
                rows={activeAuditRows}
                taskEvents={activeTaskEventRows}
              />
            </>
          )}
        </section>
      </div>
      {selected.size > 0 ? (
        <div className="wf-rq-bulkbar">
          <span className="mono" style={{ fontWeight: 600 }}>
            {fill(t('workflowReviewQueue.reviewQueueModule.selected'), { size: String(selected.size) })}
          </span>
          <div style={{ flex: 1 }} />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.claim')}
            iconName="check"
            kind="ghost"
            capability={CAP.TASKS_WRITE}
            onClick={() => void bulkAction('claim')}
          />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.resolve')}
            iconName="check"
            kind="primary"
            capability={CAP.TASKS_WRITE}
            onClick={() => void bulkAction('resolve')}
          />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.snooze3')}
            iconName="lock"
            kind="ghost"
            capability={CAP.TASKS_WRITE}
            onClick={() => openSnoozePicker()}
          />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.escalate')}
            iconName="warn"
            kind="danger"
            capability={CAP.TASKS_WRITE}
            onClick={() => void bulkAction('escalate')}
          />
          <Button
            label={t('workflowReviewQueue.reviewQueueModule.reassign')}
            iconName="shuffle"
            kind="ghost"
            capability={CAP.TASKS_WRITE}
            disabled={usersQuery.isPending}
            onClick={() => bulkReassign()}
          />
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setSelected(new Set())}
          >
            {t('workflowReviewQueue.reviewQueueModule.clear')}
          </button>
        </div>
      ) : null}
      {taskActionReadback ? (
        <section
          className="wf-rq-bulkbar"
          data-testid="wf-rq-task-readback"
          aria-label={t('workflowReviewQueue.reviewQueueModule.taskActionSavedResult')}
          style={{
            bottom: selected.size > 0 ? (bulkTaskReadback ? '126px' : '58px') : (bulkTaskReadback ? '84px' : '16px'),
            alignItems: 'flex-start',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
            <Chip label={t('workflowReviewQueue.reviewQueueModule.taskActionResult')} kind="info" size="xs" />
            <Chip
              label={taskActionReadbackComplete ? t('workflowReviewQueue.reviewQueueModule.confirmedFromSavedData') : t('workflowReviewQueue.reviewQueueModule.waitingForSavedData')}
              kind={taskActionReadbackComplete ? 'good' : 'warn'}
              size="xs"
            />
            <span className="mono" style={{ fontWeight: 700 }}>
              {taskActionLabel(taskActionReadback.kind)}
            </span>
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              {taskActionReadback.taskDisplayId}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setTaskActionReadback(null)}
            >
              {t('workflowReviewQueue.reviewQueueModule.dismiss')}
            </button>
          </div>
          <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
            {t('workflowReviewQueue.reviewQueueModule.taskConfirmed')}
          </div>
          {taskActionReadback.taskEventId ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {t('workflowReviewQueue.reviewQueueModule.activityRecorded')}
            </div>
          ) : null}
          {taskActionReadback.expectedAssignedTo ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {fill(t('workflowReviewQueue.reviewQueueModule.assignmentConfirmed'), { expectedAssignedTo: String(taskActionReadback.expectedAssignedTo) })}
            </div>
          ) : null}
          {taskActionReadback.expectedStatus ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {fill(t('workflowReviewQueue.reviewQueueModule.statusConfirmed'), { expectedStatus: String(taskActionReadback.expectedStatus) })}
            </div>
          ) : null}
          {taskActionReadback.expectedSnoozeUntil ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {fill(t('workflowReviewQueue.reviewQueueModule.wakeTimeConfirmed'), { value: String(taskActionReadback.confirmedSnoozeUntil ?? t('workflowReviewQueue.reviewQueueModule.pending')) })}
            </div>
          ) : null}
        </section>
      ) : null}
      {bulkTaskReadback ? (
        <section
          className="wf-rq-bulkbar"
          data-testid="wf-rq-bulk-readback"
          aria-label={t('workflowReviewQueue.reviewQueueModule.bulkTaskActionSaved')}
          style={{
            bottom: selected.size > 0 ? '58px' : '16px',
            alignItems: 'flex-start',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
            <Chip label={t('workflowReviewQueue.reviewQueueModule.bulkActionResult')} kind="info" size="xs" />
            <Chip
              label={bulkTaskReadbackComplete ? t('workflowReviewQueue.reviewQueueModule.confirmedFromSavedData') : t('workflowReviewQueue.reviewQueueModule.waitingForSavedData')}
              kind={bulkTaskReadbackComplete ? 'good' : 'warn'}
              size="xs"
            />
            <span className="mono" style={{ fontWeight: 700 }}>
              {bulkTaskActionLabel(bulkTaskReadback.kind)}
            </span>
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              {fill(t('workflowReviewQueue.reviewQueueModule.confirmedActivity'), { length: String(bulkTaskReadback.confirmedTaskIds.length), total: String(bulkTaskReadback.total), length2: String(bulkTaskReadback.taskEventIds.length), total2: String(bulkTaskReadback.total) })}
            </span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setBulkTaskReadback(null)}
            >
              {t('workflowReviewQueue.reviewQueueModule.dismiss')}
            </button>
          </div>
          <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
            {t('workflowReviewQueue.reviewQueueModule.tasksConfirmed')}
          </div>
          {bulkTaskReadback.taskEventIds.length > 0 ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {t('workflowReviewQueue.reviewQueueModule.activityRecorded')}
            </div>
          ) : null}
          {bulkTaskReadback.expectedAssignedTo ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {fill(t('workflowReviewQueue.reviewQueueModule.assignmentConfirmed'), { expectedAssignedTo: String(bulkTaskReadback.expectedAssignedTo) })}
            </div>
          ) : null}
          {bulkTaskReadback.expectedStatus ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {fill(t('workflowReviewQueue.reviewQueueModule.statusConfirmed'), { expectedStatus: String(bulkTaskReadback.expectedStatus) })}
            </div>
          ) : null}
          {bulkTaskReadback.expectedSnoozeUntil ? (
            <div className="mono" style={{ color: 'var(--ink-2)', fontSize: '11px' }}>
              {fill(t('workflowReviewQueue.reviewQueueModule.wakeTimeConfirmed'), { value: String(bulkTaskReadback.confirmedSnoozeUntil ?? t('workflowReviewQueue.reviewQueueModule.pending')) })}
            </div>
          ) : null}
        </section>
      ) : null}
      {modal.node}
    </div>
  );
}

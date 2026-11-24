// workflows/runs.tsx — Run history. Drawer-based Gantt timeline + step inspector + replay.
// Ports apps/console/demo-v2/assets/js/modules/wf-runs.js to TypeScript/React.
//
// Backed by canonical RPCs (verified in supabase/migrations/**):
//   • workflow_runs                   (table; read via ui_list_resource_v1)
//   • workflow_run_steps              (table; read via ui_list_resource_v1 — see api.ui_get_workflow_run_steps_v1)
//   • public.progress_workflow_run(uuid, jsonb) RETURNS jsonb
//       Operator progress variants (`retry`, `pause`, `resume`) ride through
//       the same RPC via the jsonb `action` key. Replay starts a new
//       backend run from the original template through ui_start_workflow_run_v1.
//   • public.close_workflow_run(uuid, text) RETURNS void  — aborts/finalizes a run.
//
// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — adds Triggers + Schedules sub-tabs:
//   • workflow_run_triggers           (table; supabase/migrations/202601281600_workflow_run_triggers.sql:14)
//       Workflow→workflow chaining (Zapier/Make-style). Read seam exposes
//       inter-workflow chains scoped to the current run's source_workflow_template_id.
//   • workflow_schedule_triggers      (table; supabase/migrations/202601212101_workflow_schedule_triggers.sql:14)
//       Cron-shaped scheduled runs (Zapier/Make-style time-based triggers).
//   • domain_events filtered by workflow_run_id
//       Replaces the prior FE-only `recent_workflow_events` seed for the
//       per-run drilldown. The Inbound events drawer tab now consumes
//       `useResourceList('domain_events', { filter: { workflow_run_id } })`
//       so production swap is a single getSupabaseClient() branch flip in
//       ui_list_resource_v1 (see __audit__/CROSSWALK/WORKFLOWS.md §"Important
//       gaps (P1)" — `recent_workflow_events` mock-only resolution).

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CAP } from "@/lib/capabilities";
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { Dot } from '@/components/Dot';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import {
  DataTable,
  type DataTableColumn,
  type DataTableAction,
  type DataTableBulkAction,
} from '@/components/DataTable';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useReplayWorkflowRun,
  useCancelWorkflowRun,
  useResolveSettings,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';
import { workflowRunTraceSearch } from './_runs/trace-search';
import { fill, useI18n } from '@/lib/i18n';

// Cycle E (Workflows P2 #6) — canonical replay-playback animation budget
// shape. Resolved through `useResolveSettings('ui_presentation_policy')
// .workflow_replay_animation`. Strict no-fallback: when the canonical row
// is missing, the replay path skips the cursor walk timing instead of
// falling back to FE literals. The Gantt bars degrade to null (no
// `|| 100` synthetic default) when canonical durations are missing.
interface WorkflowReplayAnimation {
  cursor_min_ms: number;
  cursor_default_ms: number;
  cursor_divisor: number;
  cursor_release_ms: number;
  autoplay_delay_ms: number;
  fallback_step_ms: number;
}

function readReplayAnimation(value: unknown): WorkflowReplayAnimation | null {
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, unknown>;
  const cfg = root.workflow_replay_animation as Record<string, unknown> | undefined;
  if (!cfg) return null;
  const num = (k: string): number | null => {
    const v = cfg[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    return v;
  };
  const cursor_min_ms = num('cursor_min_ms');
  const cursor_default_ms = num('cursor_default_ms');
  const cursor_divisor = num('cursor_divisor');
  const cursor_release_ms = num('cursor_release_ms');
  const autoplay_delay_ms = num('autoplay_delay_ms');
  const fallback_step_ms = num('fallback_step_ms');
  if (
    cursor_min_ms === null ||
    cursor_default_ms === null ||
    cursor_divisor === null ||
    cursor_release_ms === null ||
    autoplay_delay_ms === null ||
    fallback_step_ms === null
  ) {
    return null;
  }
  return {
    cursor_min_ms,
    cursor_default_ms,
    cursor_divisor,
    cursor_release_ms,
    autoplay_delay_ms,
    fallback_step_ms,
  };
}

// Wave 10 schema-drift close-out (W10-6) + W16-3 verification — see
// __audit__/SCHEMA-DRIFT/WORKFLOWS.md (sections 3, 4 + W10-6/W16-3 closure
// notes; W11-6 added Triggers/Schedules sections 8/9). W16-3 confirmed all
// extended WorkflowRun + WorkflowRunTrigger + WorkflowScheduleTrigger fields
// are either canonical, fabricated display aliases, or marked projections.
// W6 annotations are now applied as actual REMOVE/RENAME on the FE row
// interfaces. Display-only and projection-shaped fields (label/sub/icon/branch
// /error_path/manual_path/duration_ms/template_name/correlation_id) remain on
// the interface — they're sourced from `metadata.kind|label|sub`,
// `condition_jsonlogic`, joined queries, or computed locally.
//
// Drops applied (W10-6):
//   - RunStep.decision_log_id      — moved to optional metadata access pattern in deep-link logic
// Drops deferred (consumer cascade > W10 scope; verified by W16-3):
//   - WorkflowRun.run_id           — primary display + multiple test references
//   - WorkflowRun.template_id      — used by template join + tests
//   - WorkflowRun.template_name    — used by drawer/table column
//   - WorkflowRun.duration_ms      — column + drawer header chip
// Renames deferred (consumer cascade + seed update + RPC contract):
//   - WorkflowRun.status           -> workflow_status
//   - WorkflowRun.template_id      -> workflow_template_id
//   - WorkflowRun.triggered_by     -> entry_point
//   - WorkflowRun.error            -> failure_reason
//   - WorkflowTemplateStep.op      -> operation_name
//   - WorkflowTemplateStep.manual_path -> manual_action_required (semantics: bool)
//   - RunStep.status               -> step_status
//   - RunStep.error                -> last_error
interface WorkflowRun extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_runs.id
  run_id: string;                     // SSOT: display alias (FE-fabricated WFR-* code; tests + table primary key)
  template_id: string;                // SSOT: workflow_runs.workflow_template_id (RENAME deferred — RPC contract switch)
  template_name: string;              // SSOT: projection — workflow_templates.name via join
  started_at: string;                 // SSOT: workflow_runs.started_at
  completed_at?: string | null;       // SSOT: workflow_runs.completed_at
  duration_ms?: number | null;        // SSOT: projection — `completed_at - started_at`
  status: string;                     // SSOT: workflow_runs.workflow_status (RENAME deferred — RPC contract switch)
  correlation_id: string;             // SSOT: projection — triggered_by_request_id -> request_contexts.correlation_id
  triggered_by?: string;              // SSOT: workflow_runs.entry_point (RENAME deferred — RPC contract switch)
  error?: string;                     // SSOT: workflow_runs.failure_reason (RENAME deferred — RPC contract switch)
}

interface WorkflowRunInspectionReadback {
  inspectedAt: string;
  count: number;
  rows: Array<{
    workflowRunId: string;
    runDisplayId: string;
    correlationId: string | null;
    eventId: string;
    loggedAt: string;
  }>;
}

interface WorkflowTemplateStep extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_template_steps.id
  kind: string;                       // SSOT: projection — metadata.kind | computed from operation_name
  label: string;                      // SSOT: projection — metadata.label
  sub?: string;                       // SSOT: projection — metadata.sub (display sub-text)
  op?: string;                        // SSOT: workflow_template_steps.operation_name (RENAME deferred — heavy consumer cascade)
  icon?: string;                      // SSOT: projection — metadata.icon
  branch?: string;                    // SSOT: projection — derived from next_operation_name + condition_jsonlogic
  error_path?: string;                // SSOT: projection — computed via condition_jsonlogic error branch
  manual_path?: string;               // SSOT: workflow_template_steps.manual_action_required (RENAME deferred — semantics differ)
}

interface WorkflowTemplate extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_templates.id
  template_id: string;                // SSOT: display alias (FE-fabricated TPL-* code)
  name: string;                       // SSOT: workflow_templates.name
  version: string;                    // SSOT: workflow_templates.version (canonical: integer)
  scope_type?: string | null;
  scope_id?: string | null;
  steps?: WorkflowTemplateStep[];     // SSOT: projection — workflow_template_steps[] joined separately
}

// W35c-1: `decision_log_id` is a real canonical column on `workflow_run_steps`
// (`supabase/migrations/202510110005_*.sql:336`, with a comment at `:358`
// documenting it links to the decision that created/transitioned the step).
// W10-6 had previously dropped this from the FE row interface, forcing consumers
// to read `s.metadata?.decision_log_id`. Now restored as a canonical-first
// optional field; the metadata fallback remains for legacy seed rows that may
// still carry the value under `metadata`. Closes REAUDIT3/WORKFLOWS.md P1-1.
interface RunStep extends WorkflowTemplateStep {
  status: string;                     // SSOT: workflow_run_steps.step_status (RENAME deferred — RPC contract switch)
  duration_ms: number | null;         // SSOT: workflow_run_steps.duration_ms
  error?: string;                     // SSOT: workflow_run_steps.last_error (RENAME deferred — RPC contract switch)
  retry_attempt?: number;             // SSOT: workflow_run_steps.retry_attempt
  enqueued_at?: string;               // SSOT: workflow_run_steps.enqueued_at
  decision_log_id?: string | null;    // SSOT: workflow_run_steps.decision_log_id (W35c-1)
}

// W22 — paired projection view `public.v_workflow_run_directory`
// (read-only). Surfaces canonical workflow_runs columns AND projection
// fields (template_name, template_version, duration_ms computed from
// started_at/completed_at, correlation_id from triggered_by_request_id)
// AND legacy display aliases (run_id, status, template_id, error,
// triggered_by) on the same projection seam. The runs surface consumes
// this projection additively for derived chips so the operator drawer
// shows canonical-sourced data without inventing FE-only joins. See
// supabase/migrations/202604302100_v_workflow_run_directory.sql.
interface WorkflowRunDirectoryRow extends Record<string, unknown> {
  id: string;
  run_id: string | null;                      // SSOT: display alias (WFR-XXXX)
  workflow_template_id: string | null;
  template_id: string | null;                 // legacy alias
  template_name: string | null;               // SSOT: projection — workflow_templates.name
  template_version: string | number | null;   // SSOT: projection
  workflow_status: string | null;
  status: string | null;                      // legacy alias
  entry_point: string | null;
  triggered_by: string | null;                // legacy alias
  failure_reason: string | null;
  error: string | null;                       // legacy alias
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;                 // SSOT: projection — computed
  correlation_id: string | null;              // SSOT: projection — request_contexts.id
  retry_count: number | null;
  max_retries: number | null;
}

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_run_triggers row shape.
// Mirrors public.workflow_run_triggers from
// supabase/migrations/202601281600_workflow_run_triggers.sql:14.
interface WorkflowRunTrigger extends Record<string, unknown> {
  id: string;
  source_workflow_template_id: string;
  source_template_name?: string;     // SSOT: projection — workflow_templates.name via join
  target_workflow_template_id: string;
  target_template_name?: string;     // SSOT: projection — workflow_templates.name via join
  source_statuses: string[];
  scope_type: string;
  scope_id: string;
  enabled: boolean;
  deleted_at?: string | null;
  last_scanned_completed_at?: string | null;
  context_patch?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  notes?: string;
}

type WorkflowRunTriggerCreateReadback = {
  triggerId: string;
  sourceWorkflowTemplateId: string | null;
  targetWorkflowTemplateId: string | null;
  sourceLabel: string;
  targetLabel: string;
  sourceStatuses: string[];
  enabled: boolean;
  scopeLabel: string | null;
  notes: string | null;
  requestedAt: string;
};

type WorkflowRunTriggerLifecycleReadback = WorkflowRunTriggerCreateReadback & {
  action: 'updated' | 'enabled' | 'disabled' | 'deleted';
  workflowTriggerFiresCount?: number | null;
};

function isWorkflowRunTriggerActive(row: WorkflowRunTrigger): boolean {
  return !String(row.deleted_at ?? '').trim();
}

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_schedule_triggers row shape.
// Mirrors public.workflow_schedule_triggers from
// supabase/migrations/202601212101_workflow_schedule_triggers.sql:14.
interface WorkflowScheduleTrigger extends Record<string, unknown> {
  id: string;
  workflow_template_id: string;
  template_name?: string;            // SSOT: projection — workflow_templates.name via join
  schedule: Record<string, unknown>;
  schedule_summary?: string;         // SSOT: projection — humanized from schedule jsonb
  context_patch?: Record<string, unknown>;
  scope_type: string;
  scope_id: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at?: string | null;
  last_run_id?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
  notes?: string;
}

// Strict canonical resolver — `workflow_run_status` lookup_values.metadata.tone
// is the SSOT for run/step status chip presentation. Missing canonical row
// returns `{ tone: null, label: null }` so callsites render an explicit
// danger-toned `(missing)` chip instead of silently masking the gap with a
// neutral default. See AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
function statusTone(
  category: 'workflow_run_status' | 'workflow_step_status',
  s: string,
): { tone: ChipKind | null; label: string | null } {
  const row = lookupRow(category, s);
  return {
    tone: (row?.tone as ChipKind | undefined) ?? null,
    label: row?.label ?? null,
  };
}

interface ScheduleRunNowReadback {
  scheduleId: string;
  workflowTemplateId: string | null;
  workflowRunId: string | null;
  status: string | null;
  templateLabel: string;
  lastRunAt: string | null;
  error: string | null;
  errorAt: string | null;
  requestedAt: string;
}

interface ScheduleCreateReadback {
  scheduleId: string;
  workflowTemplateId: string | null;
  templateLabel: string;
  scheduleLabel: string;
  enabled: boolean;
  nextRunAt: string | null;
  scopeLabel: string | null;
  notes: string | null;
  requestedAt: string;
}

interface ScheduleTaskRepairReadback {
  scheduleId: string;
  workflowTemplateId: string | null;
  workflowTemplateStepId: string | null;
  status: string | null;
  templateLabel: string;
  operationName: string | null;
  taskTypeKey: string | null;
  queueKey: string | null;
  priority: number | null;
  slaMinutes: number | null;
  resourceType: string | null;
  resourceId: string | null;
  updatedAt: string | null;
  requestedAt: string;
}

function workflowRunAllowsAbort(status: string): boolean {
  return lookupRow('workflow_run_status', status)?.metadata?.allows_abort === true;
}

function workflowRunDisplayId(id: string): string {
  return `WFR-${id.slice(0, 8).toUpperCase()}`;
}

function workflowRunAbortDisabledReason(status: string): string {
  const label = statusTone('workflow_run_status', status).label ?? status;
  return `Workflow status ${label} cannot be cancelled`;
}

function workflowRunStatusValue(run: WorkflowRunDirectoryRow | WorkflowRun | undefined): string | null {
  const raw = run?.workflow_status ?? run?.status;
  const value = String(raw ?? '').trim();
  return value || null;
}

function workflowRunErrorValue(run: WorkflowRunDirectoryRow | WorkflowRun | undefined): string | null {
  const raw = run?.failure_reason ?? run?.error;
  const value = String(raw ?? '').trim();
  return value || null;
}

function workflowRunDateLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function parseRouteQuery(): Record<string, string> {
  const q = window.location.search.slice(1) || window.location.hash.split('?')[1] || '';
  return Object.fromEntries(
    q
      .split('&')
      .filter(Boolean)
      .map((kv) => kv.split('=').map(decodeURIComponent) as [string, string])
  );
}

interface RunDrawerBodyProps {
  run: WorkflowRun;
  template?: WorkflowTemplate;
  onNavigateRun: (href: string) => void;
  initialReplay?: boolean;
}

function RunDrawerBody({ run, template, onNavigateRun, initialReplay }: RunDrawerBodyProps) {
  const { t } = useI18n();
  const tplSteps = useMemo(() => template?.steps || [], [template]);
  // Phase C5: hook-driven cancel + replay so cache invalidates after the
  // canonical RPC settles. The progress/abort actions still ride through the
  // same `progress_workflow_run` / `close_workflow_run` RPCs but the parent
  // workflow_runs list now refetches on completion.
  const replayRun = useReplayWorkflowRun();
  const cancelRun = useCancelWorkflowRun();

  // Cycle E (Workflows P2 #6) — canonical replay-playback animation
  // budget. Strict no-fallback: missing canonical row → null replay
  // animation; replay path skips the cursor walk timing instead of
  // synthesising literal `Math.max(120, ...) / 4` / `setTimeout(800)`
  // fallbacks. The Gantt bars also degrade to null-render on missing
  // canonical durations (no `|| 100` silent default).
  const uiPresentationPolicy = useResolveSettings('ui_presentation_policy', undefined);
  const replayAnimation = useMemo<WorkflowReplayAnimation | null>(
    () => readReplayAnimation(uiPresentationPolicy.data?.value),
    [uiPresentationPolicy.data],
  );

  // Bind the Gantt to the canonical workflow_run_steps read (sourced through
  // api.ui_get_workflow_run_steps_v1 → ui_list_resource_v1('workflow_run_steps', { filter })).
  // For freshly-minted runs that don't yet have rows materialized in workflow_run_steps,
  // fall back to template-step synthesis so the drawer stays visually consistent during
  // the first render after start_workflow_run.
  const stepsQuery = useQuery({
    queryKey: ['workflow_run_steps', run.id],
    queryFn: () => api.ui_get_workflow_run_steps_v1(run.id),
    staleTime: 5_000,
  });
  const liveSteps = useMemo(() => stepsQuery.data?.rows ?? [], [stepsQuery.data]);

  // W68 (Workflows Cycle F-R-8 P1-1) — canonical default step kind resolves
  // through `workflow_step_kind` row metadata flag (`is_default: true` /
  // `metadata.is_default: true`). Replaces literal `?? 'action'` fallback.
  // Mirrors the workflow_binding_status defaultBindingStatus pattern in
  // bindings.tsx#decoratedBindings (AGENTS.md §2 ZERO HARDCODING + §6
  // row-driven config). Missing canonical row → empty string surfaces a
  // fail-loud `(missing)` chip in the kind column.
  const defaultStepKind =
    (api.getLookups('workflow_step_kind') as Array<{ value: string; is_default?: boolean; metadata?: { is_default?: boolean } }> | undefined)
      ?.find((r) => r.is_default === true || r.metadata?.is_default === true)?.value ?? '';

  const trace = useMemo<RunStep[]>(() => {
    // Prefer canonical workflow_run_steps when available.
    if (liveSteps.length) {
      const tplById = new Map<string, WorkflowTemplateStep>();
      tplSteps.forEach((s) => tplById.set(s.id, s));
      return liveSteps.map((s) => {
        const tplStep = tplById.get(String((s as Record<string, unknown>).step_id ?? '')) ?? {
          id: String((s as Record<string, unknown>).step_id ?? (s as Record<string, unknown>).id ?? ''),
          kind: String((s as Record<string, unknown>).kind ?? defaultStepKind),
          label: String((s as Record<string, unknown>).label ?? ''),
        };
        return {
          ...tplStep,
          // W68 (Workflows Cycle F-R-8 P1-2) — strict no-fallback. Missing
          // canonical `step_status` surfaces as empty string and renders a
          // fail-loud `(missing)` chip via lookupRow('workflow_step_status', '')
          // returning null (W26 contract). Replaces literal
          // `?? 'succeeded'` synthesis which silently coerced
          // unknown step state into a green "succeeded" chip.
          status: String(
            (s as Record<string, unknown>).step_status ??
            (s as Record<string, unknown>).status ??
            '',
          ),
          duration_ms:
            (s as Record<string, unknown>).duration_ms != null
              ? Number((s as Record<string, unknown>).duration_ms)
              : null,
          error:
            ((s as Record<string, unknown>).last_error as string | undefined) ??
            ((s as Record<string, unknown>).error as string | undefined) ??
            undefined,
          // W35c-1: decision_log_id IS a canonical workflow_run_steps column
          // (202510110005_*.sql:336). Forward both the canonical column and the
          // raw row metadata so the deep-link handler can read canonical-first
          // and fall back to legacy `metadata.decision_log_id` for seed rows.
          decision_log_id:
            ((s as Record<string, unknown>).decision_log_id as string | null | undefined) ??
            null,
          metadata:
            ((s as Record<string, unknown>).metadata as Record<string, unknown> | undefined) ??
            undefined,
          retry_attempt: (s as Record<string, unknown>).retry_attempt as number | undefined,
          enqueued_at: (s as Record<string, unknown>).enqueued_at as string | undefined,
        };
      });
    }
    // W54-A — no synthetic fabrication. When canonical workflow_run_steps
    // returns no rows (newly-minted run, not yet materialized), return an
    // empty trace and let the consumer surface render an explicit
    // `<StateView kind="empty" hint="Workflow steps not yet materialized" />`
    // block instead of fake durations + error strings.
    return [];
  }, [liveSteps, tplSteps, defaultStepKind]);

  // W61 (Workflows P1-1) — `is_failed` resolves through canonical
  // `workflow_run_status.metadata.is_failed`. Replaces inline literal
  // `s.status === 'failed'` compare. Strict no-fallback: missing
  // canonical row → step is treated as not-failed (initialFailed = -1)
  // so the gap surfaces via the rest of the canonical-row chip rendering.
  const initialFailed = trace.findIndex(
    (s) => lookupRow('workflow_run_status', s.status)?.metadata?.is_failed === true,
  );
  const [selectedIdx, setSelectedIdx] = useState<number>(
    initialFailed >= 0 ? initialFailed : 0
  );
  const [playbackIdx, setPlaybackIdx] = useState<number>(-1);
  const selectedStep = trace[selectedIdx];

  // Cycle E (Workflows P2 #6) — strict no-fallback. `totalDuration`
  // sums only canonical durations (`s.duration_ms`); steps with missing
  // durations contribute zero (they render at zero width below). The
  // `Math.max(1, ...)` floor stays only because the SVG width must be
  // strictly positive — when no canonical durations are present at all,
  // the bars render at zero width.
  const totalDuration = Math.max(
    1,
    trace.reduce(
      (acc, s) =>
        acc + (typeof s.duration_ms === 'number' && s.duration_ms > 0 ? s.duration_ms : 0),
      0,
    ),
  );

  /**
   * Replay starts a new backend run from the same template and preserves the
   * original run lineage in payload.ui.replay_of.
   * The animated playback (setPlaybackIdx ticks) is a UX progress indicator only;
   * the authoritative call is the useReplayWorkflowRun hook (which wraps
   * api.progress_workflow_run with cache invalidation).
   */
  async function replayFromStep(startIdx: number) {
    pushToast(fill(t('workflowRuns.runDrawerBody.replayingFromStep'), { value: String(startIdx + 1), run_id: String(run.run_id) }), 'info');
    const startStep = trace[startIdx];
    try {
      const replay = await replayRun.mutateAsync({
        run_id: run.id,
        template_id: run.template_id,
        payload: { from_step_id: startStep?.id, replay_of: run.id },
      });
      // Cycle E (Workflows P2 #6) — visual progress walk uses canonical
      // animation budget. When the policy is missing, we still tick the
      // cursor through the trace (to surface progress) but with zero-ms
      // pauses so no FE-fabricated `Math.max(120, ...) / 4` literal is
      // injected. A toast warning surfaces the missing canonical row.
      if (!replayAnimation) {
        pushToast(
          t('workflowRuns.runDrawerBody.replayAnimationPolicyMissing'),
          'warn',
        );
      }
      for (let i = startIdx; i < trace.length; i++) {
        setPlaybackIdx(i);
        const stepDur =
          typeof trace[i]?.duration_ms === 'number' && trace[i]!.duration_ms! > 0
            ? trace[i]!.duration_ms!
            : null;
        const pauseMs = replayAnimation
          ? Math.max(
              replayAnimation.cursor_min_ms,
              (stepDur ?? replayAnimation.cursor_default_ms) / replayAnimation.cursor_divisor,
            )
          : 0;
        if (pauseMs > 0) {
          await new Promise((r) => setTimeout(r, pauseMs));
        }
      }
      setPlaybackIdx(trace.length);
      pushToast(fill(t('workflowRuns.runDrawerBody.replayStarted'), { value: String(workflowRunDisplayId(replay.workflow_run_id)) }), 'good');
      void stepsQuery.refetch();
    } catch (err) {
      pushToast(t('workflowRuns.runDrawerBody.replayCouldNotBe'), 'danger');
    } finally {
      const releaseMs = replayAnimation?.cursor_release_ms ?? 0;
      if (releaseMs > 0) {
        setTimeout(() => setPlaybackIdx(-1), releaseMs);
      } else {
        setPlaybackIdx(-1);
      }
    }
  }

  async function retryStep(stepIdx: number) {
    const step = trace[stepIdx];
    if (!step) return;
    pushToast(fill(t('workflowRuns.runDrawerBody.retryQueued'), { label: String(step.label) }), 'info');
    try {
      await api.progress_workflow_run(run.id, { from_step_id: step.id }, 'retry');
      pushToast(fill(t('workflowRuns.runDrawerBody.retrySucceeded'), { label: String(step.label) }), 'good');
      void stepsQuery.refetch();
    } catch (err) {
      pushToast(t('workflowRuns.runDrawerBody.retryCouldNotBe'), 'danger');
    }
  }

  async function abortRun() {
    pushToast(fill(t('workflowRuns.runDrawerBody.aborting'), { run_id: String(run.run_id) }), 'info');
    try {
      // Canonical entrypoint: useCancelWorkflowRun → close_workflow_run.
      await cancelRun.mutateAsync({ run_id: run.id });
      pushToast(fill(t('workflowRuns.runDrawerBody.abortConfirmed'), { run_id: String(run.run_id) }), 'good');
      void stepsQuery.refetch();
    } catch (err) {
      pushToast(t('workflowRuns.runDrawerBody.cancellationCouldNotBe'), 'danger');
    }
  }

  useEffect(() => {
    if (initialReplay) {
      // Cycle E (Workflows P2 #6) — autoplay delay reads from canonical
      // policy. Missing canonical row → invoke replay immediately (zero
      // delay) instead of falling back to a literal `400ms`.
      const delay = replayAnimation?.autoplay_delay_ms ?? 0;
      if (delay > 0) {
        const entry = setTimeout(() => void replayFromStep(0), delay);
        return () => clearTimeout(entry);
      }
      void replayFromStep(0);
    }
    return undefined;
  }, [initialReplay, replayAnimation]); // eslint-disable-line react-hooks/exhaustive-deps

  // W56-D (closure) — Correlation breadcrumbs no longer fabricate FE-side
  // resource ids (`wbk_inbound_${...}` / `audit_${...}`). The canonical
  // SSOT linking workflow_runs to webhook ingestion + audit/decision/trace
  // surfaces is `triggered_by_request_id -> request_contexts.correlation_id`
  // (projected onto WorkflowRun.correlation_id via `v_workflow_run_directory`).
  // All four cross-surface breadcrumbs deep-link by `run.correlation_id`;
  // the target surfaces resolve their own canonical row sets (webhook_inbox,
  // audit_log, decision_log, traces) via `?correlation_id=<id>` filters
  // rather than relying on FE-fabricated synthetic ids.
  const correlationItems = [
    {
      label: t('workflowRuns.runDrawerBody.webhookActivity'),
      href: `/integrations/webhook-tester?correlation_id=${encodeURIComponent(run.correlation_id)}`,
    },
    {
      label: t('workflowRuns.runDrawerBody.auditActivity'),
      href: `/insights/audit?correlation_id=${encodeURIComponent(run.correlation_id)}`,
    },
    {
      label: t('workflowRuns.runDrawerBody.decisionHistory'),
      href: `/insights/decisions?correlation_id=${encodeURIComponent(run.correlation_id)}`,
    },
    {
      label: t('workflowRuns.runDrawerBody.activityHistory'),
      href: `/insights/traces?correlation_id=${encodeURIComponent(run.correlation_id)}`,
    },
  ];

  let cumulative = 0;
  const traceRows = trace.map((s, i) => {
    // W27 Cycle D closure: playback no longer rewrites the canonical
    // `s.status` projection of `workflow_run_steps.step_status`. Instead we
    // compute a presentation-only `phase` (pre|cursor|post) and dim the
    // row visually while leaving the canonical chip + bar status intact.
    // The authoritative read after replay completes is `stepsQuery.refetch()`
    // (already wired in `replayFromStep`).
    const status = s.status;
    let phase: 'pre' | 'cursor' | 'post' | 'idle' = 'idle';
    if (playbackIdx >= 0) {
      if (i < playbackIdx) phase = 'pre';
      else if (i === playbackIdx) phase = 'cursor';
      else phase = 'post';
    }
    // Cycle E (Workflows P2 #6) — strict null handling. Canonical
    // duration projection (`s.duration_ms`) → `dur`. Missing/zero =>
    // bar renders at zero width and the cumulative cursor does not
    // advance. No `|| 100` silent fallback.
    const dur = typeof s.duration_ms === 'number' && s.duration_ms > 0 ? s.duration_ms : 0;
    const widthPct = dur > 0 ? (dur / totalDuration) * 100 : 0;
    const offsetPct = (cumulative / totalDuration) * 100;
    cumulative += dur;
    const isSelected = selectedIdx === i;
    // W27 Cycle D closure: phase-driven opacity for replay playback (no
    // canonical-status rewrite). `pre`=visited, `cursor`=current, `post`=
    // upcoming. Idle (no playback in progress) renders at full opacity.
    const phaseOpacity = phase === 'post' ? 0.45 : phase === 'cursor' ? 1.0 : phase === 'pre' ? 0.85 : 1.0;
    const phaseClass = phase === 'cursor' ? ' is-replay-cursor' : '';
    return (
      <button
        key={s.id}
        type="button"
        className={`wf-run-gantt__row ${isSelected ? 'is-selected' : ''}${phaseClass}`}
        onClick={() => setSelectedIdx(i)}
        data-replay-phase={phase}
        style={{ opacity: phaseOpacity }}
      >
        <span className="wf-run-gantt__idx mono">{String(i + 1)}</span>
        <span className="wf-run-gantt__label">{s.label}</span>
        <div className="wf-run-gantt__bar-track">
          {widthPct > 0 ? (
            <span
              className={`wf-run-gantt__bar wf-run-gantt__bar--${status}`}
              style={{
                left: `${offsetPct.toFixed(2)}%`,
                width: `${widthPct.toFixed(2)}%`,
              }}
            />
          ) : null}
        </div>
        <span className="wf-run-gantt__dur mono">{dur > 0 ? fill(t('workflowRuns.runDrawerBody.ms'), { dur: String(dur) }) : '—'}</span>
        {(() => {
          const r = statusTone('workflow_step_status', status);
          return r.tone && r.label
            ? (
              <span className={`wf-run-gantt__pill chip chip--${r.tone} chip--xs`}>
                {r.label}
              </span>
            )
            : (
              <span className="wf-run-gantt__pill chip chip--danger chip--xs">
                {t('workflowRuns.runDrawerBody.statusLabelIsNot')}
              </span>
            );
        })()}
      </button>
    );
  });

  return (
    <div>
      <div className="wf-run-head">
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '11px',
              color: 'var(--ink-3)',
            }}
          >
            <span className="mono">{run.run_id}</span>
            <span>·</span>
            <span>{template?.name || run.template_name}</span>
          </div>
          <div style={{ marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {(() => {
              const r = statusTone('workflow_run_status', run.status);
              return r.tone && r.label
                ? <Chip label={r.label} kind={r.tone} size="xs" />
                : <Chip label={t('workflowRuns.runDrawerBody.statusLabelIsNot')} kind="danger" size="xs" />;
            })()}
            <span
              className="mono"
              style={{ fontSize: '11px', color: 'var(--ink-3)' }}
            >
              {run.duration_ms ? fill(t('workflowRuns.runDrawerBody.ms2'), { duration_ms: String(run.duration_ms) }) : '—'}
            </span>
            <span
              className="mono"
              style={{ fontSize: '11px', color: 'var(--ink-3)', marginLeft: '4px' }}
            >
              {workflowRunDateLabel(run.started_at)}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            label={t('workflowRuns.runDrawerBody.viewTrace')}
            iconName="trace_tree"
            kind="ghost"
            onClick={() => onNavigateRun('/insights/traces')}
          />
          <Button
            label={t('workflowRuns.runDrawerBody.replayRun')}
            iconName="rotate"
            kind="primary"
            // W37 — replay routes through the canonical workflow lifecycle
            // RPC chain (capability `workflows.write` server-asserted). Gate
            // the FE so the button fail-closes optimistically and renders a
            // CapabilityLock chip when missing instead of clicking through to
            // a generic toast failure. Closes REAUDIT4 WORKFLOWS NEW P1.
            capability={CAP.WORKFLOWS_WRITE}
            onClick={() => void replayFromStep(0)}
          />
        </div>
      </div>

      <div className="wf-insp__section-eyebrow">{t('workflowRuns.runDrawerBody.requestTrail')}</div>
      <div className="wf-run-corr">
        {correlationItems.map((c) => (
          <button
            key={c.label}
            type="button"
            className="wf-run-corr__chip"
            onClick={() => onNavigateRun(c.href)}
          >
            <span>🔗</span>
            <span>{c.label}</span>
          </button>
        ))}
      </div>

      <div className="wf-insp__section-eyebrow">{t('workflowRuns.runDrawerBody.stepTimeline')}</div>
      {trace.length === 0 ? (
        <StateView kind="empty" hint={t('workflowRuns.runDrawerBody.workflowStepsNotYet')} />
      ) : (
      <div className="wf-run-split">
        <div className="wf-run-gantt">{traceRows}</div>
        <div className="wf-run-inspector">
          {selectedStep ? (
            <>
              <div className="wf-insp__step-kind mono">
                {(selectedStep.kind || 'step').toUpperCase()}
              </div>
              <h3 className="wf-insp__step-title">{selectedStep.label}</h3>
              <div className="wf-insp__step-id mono">
                {selectedStep.id} · {selectedStep.op || ''}
              </div>
              <div style={{ padding: '0 0 6px' }}>
                {(() => {
                  const r = statusTone('workflow_step_status', selectedStep.status);
                  return r.tone && r.label
                    ? <Chip label={r.label} kind={r.tone} size="xs" />
                    : <Chip label={t('workflowRuns.runDrawerBody.statusLabelIsNot')} kind="danger" size="xs" />;
                })()}
              </div>
              {selectedStep.error ? (
                <div className="wf-step-error">
                  <span className="mono">{t('workflowRuns.runDrawerBody.error')}</span>
                  <div>{selectedStep.error}</div>
                </div>
              ) : null}
              <div className="wf-insp__section-eyebrow">{t('workflowRuns.runDrawerBody.input')}</div>
              {(() => {
                // W27 Cycle D closure: read step input strictly from
                // canonical `workflow_run_steps` projection (`input`,
                // `payload`, or `metadata.input`). The previous
                // hardcoded `{tracking_number: 'EXAMPLEMARKET-99281', sender:
                // 'exampleparcel_ksa'}` literal was customer-facing fictitious
                // data — replaced with a canonical-only render path
                // that surfaces `<StateView kind="empty" />` when the
                // projection has not yet been wired (AGENTS.md §2/§4).
                const stepRecord = selectedStep as Record<string, unknown>;
                const stepMeta = (stepRecord.metadata as Record<string, unknown> | undefined) ?? {};
                const stepInput = stepRecord.input ?? stepRecord.payload ?? stepMeta.input;
                if (stepInput === undefined || stepInput === null) {
                  return (
                    <div style={{ padding: '0 14px 12px' }}>
                      <StateView
                        kind="empty"
                        title={t('workflowRuns.runDrawerBody.noInputCaptured')}
                        hint={t('workflowRuns.runDrawerBody.thisStepHasNot')}
                      />
                    </div>
                  );
                }
                return (
                  <pre className="wf-code-block">
                    {JSON.stringify(stepInput, null, 2)}
                  </pre>
                );
              })()}
              <div className="wf-insp__section-eyebrow">{t('workflowRuns.runDrawerBody.output')}</div>
              {(() => {
                // Cycle E (Workflows P2 #5) — read step output strictly
                // from the canonical `workflow_run_steps` projection
                // (`output` then `metadata.output`). The previous status-
                // branched fabrication (`{ok:false,error}` /
                // `{ok:true,duration_ms}`) violated AGENTS.md §2 (ZERO
                // HARDCODING) + §4 (SSOT) — the OK shape mirrored a
                // synthetic JSON envelope that doesn't match any
                // canonical step output. Missing canonical projection
                // renders an explicit `<StateView kind="empty"/>` block
                // instead of synthesising a plausible-but-fake payload.
                const stepRecord = selectedStep as Record<string, unknown>;
                const stepMeta = (stepRecord.metadata as Record<string, unknown> | undefined) ?? {};
                const stepOutput = stepRecord.output ?? stepMeta.output;
                if (stepOutput === undefined || stepOutput === null) {
                  return (
                    <div style={{ padding: '0 14px 12px' }}>
                      <StateView
                        kind="empty"
                        title={t('workflowRuns.runDrawerBody.noOutputCaptured')}
                        hint={t('workflowRuns.runDrawerBody.thisStepHasNot2')}
                      />
                    </div>
                  );
                }
                return (
                  <pre className="wf-code-block">
                    {JSON.stringify(stepOutput, null, 2)}
                  </pre>
                );
              })()}
              <div className="wf-insp__section-eyebrow">{t('workflowRuns.runDrawerBody.actions')}</div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px',
                  padding: '0 14px 14px',
                }}
              >
                <Button
                  label={t('workflowRuns.runDrawerBody.replayFromThisStep')}
                  iconName="rotate"
                  kind="primary"
                  // W37 — same gating as drawer-header "Replay run" Button.
                  // Closes REAUDIT4 WORKFLOWS NEW P1.
                  capability={CAP.WORKFLOWS_WRITE}
                  onClick={() => void replayFromStep(selectedIdx)}
                />
                <Button
                  label={t('workflowRuns.runDrawerBody.openOperationTemplate')}
                  iconName="right"
                  kind="ghost"
                  onClick={() =>
                    pushToast(fill(t('workflowRuns.runDrawerBody.openOpTemplate'), { op: String(selectedStep.op) }), 'info')
                  }
                />
                <Button
                  label={t('workflowRuns.runDrawerBody.decisionTrail')}
                  iconName="audit"
                  kind="ghost"
                  onClick={() => {
                    // Deep-link to /insights/decisions filtered by this step's
                    // decision_log_id (when available) or the run's correlation_id.
                    // W35c-1: read canonical-first from `selectedStep.decision_log_id`
                    // (workflow_run_steps.decision_log_id, 202510110005_*.sql:336),
                    // falling back to legacy `metadata.decision_log_id` for any seed
                    // rows that haven't been re-projected through the canonical column yet.
                    const meta = (selectedStep as Record<string, unknown>).metadata as
                      | Record<string, unknown>
                      | undefined;
                    const dlog =
                      selectedStep.decision_log_id
                      ?? (meta?.decision_log_id as string | undefined);
                    onNavigateRun(
                      dlog
                        ? `/insights/decisions?decision_log_id=${encodeURIComponent(dlog)}`
                        : `/insights/decisions?correlation_id=${encodeURIComponent(run.correlation_id)}`,
                    );
                  }}
                />
                {/* W61 (Workflows P1-1) — Retry/Abort gating resolves through
                    canonical `workflow_run_status.metadata.{allows_retry,
                    allows_abort}`. Replaces inline literal compares
                    (`selectedStep.status === 'failed'` and
                    `run.status === 'running'`). Strict no-fallback:
                    missing canonical row → button hidden so the gap surfaces
                    via the existing canonical-row chip rendering. */}
                {lookupRow('workflow_step_status', selectedStep.status)?.metadata?.allows_retry === true ? (
                  <Button
                    label={t('workflowRuns.runDrawerBody.retry')}
                    iconName="refresh"
                    kind="ghost"
                    capability={CAP.WORKFLOWS_WRITE}
                    onClick={() => void retryStep(selectedIdx)}
                  />
                ) : null}
                {workflowRunAllowsAbort(run.status) ? (
                  <Button
                    label={t('workflowRuns.runDrawerBody.abortRun')}
                    iconName="x"
                    kind="ghost"
                    capability={CAP.WORKFLOWS_WRITE}
                    onClick={() => void abortRun()}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <StateView
              kind="empty"
              title={t('workflowRuns.runDrawerBody.noStepSelected')}
              hint={t('workflowRuns.runDrawerBody.clickAStepOn')}
            />
          )}
        </div>
      </div>
      )}
    </div>
  );
}

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — page-level tab system. Lets the operator
// switch between live workflow_runs, workflow→workflow chaining triggers
// (workflow_run_triggers), and cron-shaped scheduled runs
// (workflow_schedule_triggers) without leaving /workflows/runs. Active tab
// is persisted in the hash so deep links survive page reloads.
type RunsTab = 'runs' | 'triggers' | 'schedules';

// Labels come from the workflowRuns.tabs catalog entries.
const RUNS_TABS: Array<{ key: RunsTab }> = [{ key: 'runs' }, { key: 'triggers' }, { key: 'schedules' }];

// Cycle E2 (Workflows P1 #3) — `scheduleSummary` is canonical-driven
// through the `workflow_schedule_type` lookup. Each row carries
// `metadata.summary_template` (a deterministic format token) plus
// `metadata.thresholds` (interval bucketing constants 3600 / 60).
// Replaces the inline `type === 'interval' / 'daily' / 'weekly'`
// switch and the magic 3600/60 second-bucket constants. Missing
// canonical row → renders the raw `type` value (loud surface; the
// operator sees the un-mapped key string instead of a fabricated
// summary).
function scheduleSummary(schedule: Record<string, unknown> | undefined): string {
  if (!schedule) return '—';
  const type = String(schedule.type ?? '');
  if (!type) return '—';
  type ScheduleTypeRow = {
    value: string;
    label: string;
    metadata?: {
      summary_template?: string;
      thresholds?: { hour_seconds?: number; minute_seconds?: number };
    };
  };
  const row = lookupRow('workflow_schedule_type', type) as ScheduleTypeRow | null;
  const template = row?.metadata?.summary_template;
  if (!template) return type;

  if (template === 'every') {
    const sec = Number(schedule.interval_seconds ?? 0);
    const hourSec = row?.metadata?.thresholds?.hour_seconds;
    const minuteSec = row?.metadata?.thresholds?.minute_seconds;
    if (typeof hourSec === 'number' && hourSec > 0 && sec >= hourSec) {
      return `Every ${Math.round(sec / hourSec)}h`;
    }
    if (typeof minuteSec === 'number' && minuteSec > 0 && sec >= minuteSec) {
      return `Every ${Math.round(sec / minuteSec)}m`;
    }
    return `Every ${sec}s`;
  }
  if (template === 'daily') {
    const at = String(schedule.at_time ?? '—');
    const tz = String(schedule.timezone ?? 'UTC');
    return `Daily ${at} ${tz}`;
  }
  if (template === 'weekly') {
    const days = Array.isArray(schedule.days) ? (schedule.days as string[]).join('/') : '—';
    const at = String(schedule.at_time ?? '—');
    const tz = String(schedule.timezone ?? 'UTC');
    return `${days} ${at} ${tz}`;
  }
  if (template === 'cron') {
    return String(schedule.cron ?? '—');
  }
  return type;
}

function titleFromToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const words = value
    .replace(/[_./:-]+/g, ' ')
    .replace(/\bv\d+\b/gi, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return undefined;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

function workflowTemplateOperatorLabel(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  const canonicalName = raw.split('__tenant__')[0] ?? raw;
  if (canonicalName.startsWith('workflow_binding.')) {
    const [, binding, stage] = canonicalName.split('.');
    const bindingLabel = titleFromToken(binding);
    const stageLabel = titleFromToken(stage);
    if (bindingLabel && stageLabel) return `${bindingLabel} - ${stageLabel}`;
    return bindingLabel ?? stageLabel ?? raw;
  }
  return raw;
}

function normalizeWorkflowTemplate(row: WorkflowTemplate): WorkflowTemplate {
  return { ...row, name: workflowTemplateOperatorLabel(row.name) };
}

function normalizeWorkflowRun(row: WorkflowRun, templatesById: Map<string, WorkflowTemplate>): WorkflowRun {
  const template = templatesById.get(row.template_id);
  return {
    ...row,
    template_name: workflowTemplateOperatorLabel(row.template_name ?? template?.name ?? row.template_id),
  };
}

type ScheduleTypeOption = {
  value: string;
  label: string;
  rank?: number;
  metadata?: Record<string, unknown>;
};

function defaultWorkflowScheduleTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function parseJsonObjectInput(value: string, label: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

type WorkflowStatusOption = {
  value: string;
  label: string;
  rank?: number;
  tone?: string;
  metadata?: Record<string, unknown>;
};

function workflowRunStatusOptions(): WorkflowStatusOption[] {
  return api.getLookups('workflow_run_status')
    .map((row) => ({
      value: String(row.value),
      label: String(row.label ?? row.value),
      rank: row.rank,
      tone: row.tone,
      metadata: row.metadata,
    }))
    .filter((row) => row.value.length > 0)
    .sort((a, b) => Number(a.rank ?? 0) - Number(b.rank ?? 0));
}

function defaultWorkflowRunTriggerStatuses(statusOptions: WorkflowStatusOption[]): string[] {
  const defaultRows = statusOptions.filter((row) => {
    const metadata = row.metadata ?? {};
    return metadata.allows_abort === false && metadata.is_failed === false && row.tone === 'good';
  });
  return defaultRows[0]?.value ? [defaultRows[0].value] : [];
}

function normalizeWorkflowRunTriggerStatus(status: string): string {
  const value = status.trim().toLowerCase();
  return value === 'completed' ? 'succeeded' : value;
}

function workflowRunTriggerStatusesForSubmit(statuses: string[], statusOptions: WorkflowStatusOption[]): string[] {
  const allowed = new Set(statusOptions.map((option) => normalizeWorkflowRunTriggerStatus(option.value)));
  const normalized = statuses
    .map((status) => normalizeWorkflowRunTriggerStatus(status))
    .filter((status) => status.length > 0 && allowed.has(status));
  return [...new Set(normalized)];
}

function workflowRunTriggerStatusKey(statuses: string[]): string {
  return [...new Set(statuses.map((status) => normalizeWorkflowRunTriggerStatus(status)).filter(Boolean))]
    .sort()
    .join('\u0000');
}

function workflowRunTriggerBindingExists(
  triggers: WorkflowRunTrigger[],
  sourceTemplateId: string,
  targetTemplateId: string,
  sourceStatuses: string[],
  ignoreTriggerId?: string | null,
): boolean {
  const sourceKey = workflowRunTriggerStatusKey(sourceStatuses);
  return triggers.some((trigger) => {
    if (ignoreTriggerId && trigger.id === ignoreTriggerId) return false;
    const triggerStatuses = Array.isArray(trigger.source_statuses)
      ? trigger.source_statuses.map((status) => String(status))
      : [];
    return trigger.source_workflow_template_id === sourceTemplateId
      && trigger.target_workflow_template_id === targetTemplateId
      && workflowRunTriggerStatusKey(triggerStatuses) === sourceKey;
  });
}

function WorkflowRunTriggerComposer({
  templates,
  statusOptions,
  existingTriggers,
  initialTrigger,
  submitLabel = 'Create trigger',
  onCancel,
  onSubmit,
}: {
  templates: WorkflowTemplate[];
  statusOptions: WorkflowStatusOption[];
  existingTriggers: WorkflowRunTrigger[];
  initialTrigger?: WorkflowRunTrigger | null;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (args: {
    source_workflow_template_id: string;
    target_workflow_template_id: string;
    source_statuses: string[] | null;
    context_patch: Record<string, unknown>;
    enabled: boolean;
    notes: string | null;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [sourceTemplateId, setSourceTemplateId] = useState(
    initialTrigger?.source_workflow_template_id ?? templates[0]?.id ?? '',
  );
  const [targetTemplateId, setTargetTemplateId] = useState(
    initialTrigger?.target_workflow_template_id
      ?? templates.find((template) => template.id !== (initialTrigger?.source_workflow_template_id ?? templates[0]?.id))?.id
      ?? '',
  );
  const [sourceStatuses, setSourceStatuses] = useState<string[]>(() =>
    Array.isArray(initialTrigger?.source_statuses) && initialTrigger.source_statuses.length > 0
      ? initialTrigger.source_statuses.map((status) => normalizeWorkflowRunTriggerStatus(String(status)))
      : defaultWorkflowRunTriggerStatuses(statusOptions),
  );
  const [contextPatch, setContextPatch] = useState(() =>
    JSON.stringify(initialTrigger?.context_patch ?? {}, null, 2),
  );
  const [notes, setNotes] = useState(initialTrigger?.notes ?? '');
  const [enabled, setEnabled] = useState(initialTrigger?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (targetTemplateId && targetTemplateId !== sourceTemplateId) return;
    setTargetTemplateId(templates.find((template) => template.id !== sourceTemplateId)?.id ?? '');
  }, [sourceTemplateId, targetTemplateId, templates]);

  function toggleStatus(status: string, checked: boolean) {
    setSourceStatuses((current) => (
      checked
        ? [...new Set([...current, status])]
        : current.filter((value) => value !== status)
    ));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      if (templates.length < 2) throw new Error('At least two workflow templates are required');
      if (!sourceTemplateId) throw new Error('Select a source workflow template');
      if (!targetTemplateId) throw new Error('Select a target workflow template');
      if (sourceTemplateId === targetTemplateId) throw new Error('Source and target templates must differ');
      const statusesForSubmit = workflowRunTriggerStatusesForSubmit(sourceStatuses, statusOptions);
      if (statusesForSubmit.length === 0) throw new Error('Select at least one source status');
      if (
        workflowRunTriggerBindingExists(
          existingTriggers,
          sourceTemplateId,
          targetTemplateId,
          statusesForSubmit,
          initialTrigger?.id ?? null,
        )
      ) {
        throw new Error(
          'A workflow trigger for this source, target, and status already exists. Choose another status or target template.',
        );
      }
      const parsedContext = parseJsonObjectInput(contextPatch, 'Context patch');
      setSubmitting(true);
      await onSubmit({
        source_workflow_template_id: sourceTemplateId,
        target_workflow_template_id: targetTemplateId,
        source_statuses: statusesForSubmit,
        context_patch: parsedContext,
        enabled,
        notes: notes.trim() || null,
      });
    } catch (err) {
      setError((err as Error)?.message ?? t('workflowRuns.workflowRunTriggerComposer.workflowTriggerCouldNot'));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '12px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '140px 1fr',
          gap: '10px',
          alignItems: 'center',
          padding: '0 4px',
        }}
      >
        <label className="mono" htmlFor="workflow-run-trigger-source">{t('workflowRuns.workflowRunTriggerComposer.sourceTemplate')}</label>
        <select
          id="workflow-run-trigger-source"
          className="dt-inline-input"
          value={sourceTemplateId}
          onChange={(event) => setSourceTemplateId(event.target.value)}
          aria-label={t('workflowRuns.workflowRunTriggerComposer.sourceWorkflowTemplate')}
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="workflow-run-trigger-target">{t('workflowRuns.workflowRunTriggerComposer.targetTemplate')}</label>
        <select
          id="workflow-run-trigger-target"
          className="dt-inline-input"
          value={targetTemplateId}
          onChange={(event) => setTargetTemplateId(event.target.value)}
          aria-label={t('workflowRuns.workflowRunTriggerComposer.targetWorkflowTemplate')}
        >
          {templates
            .filter((template) => template.id !== sourceTemplateId)
            .map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
        </select>
      </div>
      <fieldset
        style={{
          border: '1px solid var(--line)',
          borderRadius: '8px',
          padding: '10px',
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
        }}
      >
        <legend className="mono" style={{ padding: '0 4px' }}>{t('workflowRuns.workflowRunTriggerComposer.sourceStatus')}</legend>
        {statusOptions.map((option) => (
          <label key={option.value} className="chip chip--xs" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={sourceStatuses.includes(option.value)}
              onChange={(event) => toggleStatus(option.value, event.target.checked)}
              aria-label={fill(t('workflowRuns.workflowRunTriggerComposer.triggerOn'), { label: String(option.label) })}
            />{' '}
            {option.label}
          </label>
        ))}
      </fieldset>
      <label className="mono" htmlFor="workflow-run-trigger-context" style={{ padding: '0 4px' }}>
        {t('workflowRuns.workflowRunTriggerComposer.contextPatch')}
      </label>
      <textarea
        id="workflow-run-trigger-context"
        className="dt-inline-input mono"
        rows={4}
        value={contextPatch}
        onChange={(event) => setContextPatch(event.target.value)}
        aria-label={t('workflowRuns.workflowRunTriggerComposer.triggerContextPatchJson')}
      />
      <label className="mono" htmlFor="workflow-run-trigger-notes" style={{ padding: '0 4px' }}>
        {t('workflowRuns.workflowRunTriggerComposer.notes')}
      </label>
      <input
        id="workflow-run-trigger-notes"
        className="dt-inline-input"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        aria-label={t('workflowRuns.workflowRunTriggerComposer.triggerNotes')}
      />
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '0 4px' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          aria-label={t('workflowRuns.workflowRunTriggerComposer.triggerEnabled')}
        />
        <span>{t('workflowRuns.workflowRunTriggerComposer.enabled')}</span>
      </label>
      {error ? (
        <div role="alert" className="state__hint" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button label={t('workflowRuns.workflowRunTriggerComposer.cancel')} kind="ghost" onClick={onCancel} disabled={submitting} />
        <Button
          label={submitLabel}
          iconName="plus"
          kind="primary"
          capability={CAP.WORKFLOWS_WRITE}
          type="submit"
          disabled={submitting || templates.length < 2}
        />
      </div>
    </form>
  );
}

function WorkflowScheduleComposer({
  templates,
  scheduleTypeOptions,
  onCancel,
  onSubmit,
}: {
  templates: WorkflowTemplate[];
  scheduleTypeOptions: ScheduleTypeOption[];
  onCancel: () => void;
  onSubmit: (args: {
    workflow_template_id: string;
    schedule: Record<string, unknown>;
    context_patch: Record<string, unknown>;
    enabled: boolean;
    notes: string | null;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [scheduleType, setScheduleType] = useState(scheduleTypeOptions[0]?.value ?? '');
  const [intervalSeconds, setIntervalSeconds] = useState('3600');
  const [atTime, setAtTime] = useState('04:00');
  const [timezone, setTimezone] = useState(defaultWorkflowScheduleTimezone());
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1]);
  const [contextPatch, setContextPatch] = useState('{}');
  const [notes, setNotes] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      if (!templateId) throw new Error('Select a workflow template');
      if (!scheduleType) throw new Error('Select a schedule type');
      let schedule: Record<string, unknown>;
      if (scheduleType === 'interval') {
        const parsed = Number(intervalSeconds);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('Interval seconds must be greater than zero');
        }
        schedule = { type: scheduleType, interval_seconds: Math.floor(parsed) };
      } else if (scheduleType === 'daily') {
        if (!/^\d{2}:\d{2}$/.test(atTime)) throw new Error('Run time must use HH:MM');
        schedule = { type: scheduleType, at_time: atTime, timezone };
      } else if (scheduleType === 'weekly') {
        if (!/^\d{2}:\d{2}$/.test(atTime)) throw new Error('Run time must use HH:MM');
        if (daysOfWeek.length === 0) throw new Error('Select at least one day');
        schedule = { type: scheduleType, at_time: atTime, timezone, days_of_week: daysOfWeek };
      } else {
        throw new Error('This schedule type is not supported by the workflow schedule worker');
      }
      const parsedContext = parseJsonObjectInput(contextPatch, 'Context patch');
      setSubmitting(true);
      await onSubmit({
        workflow_template_id: templateId,
        schedule,
        context_patch: parsedContext,
        enabled,
        notes: notes.trim() || null,
      });
    } catch (err) {
      setError((err as Error)?.message ?? t('workflowRuns.workflowScheduleComposer.scheduleCouldNotBe'));
      setSubmitting(false);
    }
  }

  const dayOptions = [
    { value: 0, label: t('workflowRuns.workflowScheduleComposer.sun') },
    { value: 1, label: t('workflowRuns.workflowScheduleComposer.mon') },
    { value: 2, label: t('workflowRuns.workflowScheduleComposer.tue') },
    { value: 3, label: t('workflowRuns.workflowScheduleComposer.wed') },
    { value: 4, label: t('workflowRuns.workflowScheduleComposer.thu') },
    { value: 5, label: t('workflowRuns.workflowScheduleComposer.fri') },
    { value: 6, label: t('workflowRuns.workflowScheduleComposer.sat') },
  ];

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '12px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '140px 1fr',
          gap: '10px',
          alignItems: 'center',
          padding: '0 4px',
        }}
      >
        <label className="mono" htmlFor="workflow-schedule-template">{t('workflowRuns.workflowScheduleComposer.template')}</label>
        <select
          id="workflow-schedule-template"
          className="dt-inline-input"
          value={templateId}
          onChange={(event) => setTemplateId(event.target.value)}
          aria-label={t('workflowRuns.workflowScheduleComposer.workflowTemplate')}
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="workflow-schedule-type">{t('workflowRuns.workflowScheduleComposer.scheduleType')}</label>
        <select
          id="workflow-schedule-type"
          className="dt-inline-input"
          value={scheduleType}
          onChange={(event) => setScheduleType(event.target.value)}
          aria-label={t('workflowRuns.workflowScheduleComposer.scheduleType')}
        >
          {scheduleTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {scheduleType === 'interval' ? (
          <>
            <label className="mono" htmlFor="workflow-schedule-interval">{t('workflowRuns.workflowScheduleComposer.everySeconds')}</label>
            <input
              id="workflow-schedule-interval"
              className="dt-inline-input"
              type="number"
              min={1}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
              aria-label={t('workflowRuns.workflowScheduleComposer.intervalSeconds')}
            />
          </>
        ) : null}
        {scheduleType === 'daily' || scheduleType === 'weekly' ? (
          <>
            <label className="mono" htmlFor="workflow-schedule-at-time">{t('workflowRuns.workflowScheduleComposer.runTime')}</label>
            <input
              id="workflow-schedule-at-time"
              className="dt-inline-input"
              type="time"
              value={atTime}
              onChange={(event) => setAtTime(event.target.value)}
              aria-label={t('workflowRuns.workflowScheduleComposer.runTime')}
            />
            <label className="mono" htmlFor="workflow-schedule-timezone">{t('workflowRuns.workflowScheduleComposer.timezone')}</label>
            <input
              id="workflow-schedule-timezone"
              className="dt-inline-input mono"
              type="text"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              aria-label={t('workflowRuns.workflowScheduleComposer.timezone')}
            />
          </>
        ) : null}
      </div>
      {scheduleType === 'weekly' ? (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '0 4px' }} aria-label={t('workflowRuns.workflowScheduleComposer.daysOfWeek')}>
          {dayOptions.map((day) => (
            <label key={day.value} className="chip chip--xs" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={daysOfWeek.includes(day.value)}
                onChange={(event) => {
                  setDaysOfWeek((current) =>
                    event.target.checked
                      ? [...new Set([...current, day.value])].sort()
                      : current.filter((value) => value !== day.value),
                  );
                }}
                aria-label={fill(t('workflowRuns.workflowScheduleComposer.runOn'), { label: String(day.label) })}
              />{' '}
              {day.label}
            </label>
          ))}
        </div>
      ) : null}
      <label className="mono" htmlFor="workflow-schedule-context" style={{ padding: '0 4px' }}>
        {t('workflowRuns.workflowScheduleComposer.contextPatch')}
      </label>
      <textarea
        id="workflow-schedule-context"
        className="dt-inline-input mono"
        rows={4}
        value={contextPatch}
        onChange={(event) => setContextPatch(event.target.value)}
        aria-label={t('workflowRuns.workflowScheduleComposer.contextPatchJson')}
      />
      <label className="mono" htmlFor="workflow-schedule-notes" style={{ padding: '0 4px' }}>
        {t('workflowRuns.workflowScheduleComposer.notes')}
      </label>
      <input
        id="workflow-schedule-notes"
        className="dt-inline-input"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        aria-label={t('workflowRuns.workflowScheduleComposer.scheduleNotes')}
      />
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '0 4px' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          aria-label={t('workflowRuns.workflowScheduleComposer.enabled')}
        />
        <span>{t('workflowRuns.workflowScheduleComposer.enabled')}</span>
      </label>
      {error ? (
        <div role="alert" className="state__hint" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button label={t('workflowRuns.workflowScheduleComposer.cancel')} kind="ghost" onClick={onCancel} disabled={submitting} />
        <Button
          label={t('workflowRuns.workflowScheduleComposer.createSchedule')}
          iconName="plus"
          kind="primary"
          capability={CAP.WORKFLOWS_WRITE}
          type="submit"
          disabled={submitting || templates.length === 0 || scheduleTypeOptions.length === 0}
        />
      </div>
    </form>
  );
}

export function RunsModule() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const go = useConsoleNavigator();
  const drawer = useDrawer();
  const modal = useModal();
  const identity = useIdentity();
  const { scope } = identity;
  const canRead = useCapability(CAP.WORKFLOWS_READ);
  const canWrite = useCapability(CAP.WORKFLOWS_WRITE);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  // Cycle E2 (Workflows P2 #12) — canonical drawer auto-open delay
  // (`ui_presentation_policy.workflow_drawer_open_delay_ms`). Replaces
  // the inline 200ms `setTimeout` literal. Missing canonical row → the
  // drawer opens immediately (no fabricated delay).
  const presentationPolicy = useResolveSettings('ui_presentation_policy', undefined, readQueryOptions);
  const drawerOpenDelayMs = useMemo(() => {
    const value = (presentationPolicy.data?.value as Record<string, unknown> | undefined)
      ?.workflow_drawer_open_delay_ms;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }, [presentationPolicy.data]);
  const runsQuery = useResourceList<WorkflowRun>('workflow_run_directory', undefined, readQueryOptions);
  const templatesQuery = useResourceList<WorkflowTemplate>('workflow_templates', undefined, readQueryOptions);
  const triggersQuery = useResourceList<WorkflowRunTrigger>('workflow_run_triggers', undefined, readQueryOptions);
  const schedulesQuery = useResourceList<WorkflowScheduleTrigger>(
    'workflow_schedule_triggers',
    undefined,
    readQueryOptions,
  );
  // W22 — paired projection view consumption. The table itself reads the
  // directory projection so operators see workflow labels and lifecycle state,
  // not raw base-table columns.
  // Phase C5: bulk replay rides through the same canonical RPC hook so the
  // workflow_runs list refetches once the batch settles.
  const replayRun = useReplayWorkflowRun();

  const rawRuns = useMemo(() => runsQuery.data?.rows ?? [], [runsQuery.data]);
  const activeScopeType = identity.currentScopeType();
  const activeScopeId = identity.currentScopeId();
  const activeTenantId = identity.currentTenantId();
  const allTemplates = useMemo(
    () => (templatesQuery.data?.rows ?? []).map((row) => normalizeWorkflowTemplate(row)),
    [templatesQuery.data],
  );
  const templates = useMemo(
    () => allTemplates.filter((template) => {
      const scopeType = String(template.scope_type ?? 'global').trim() || 'global';
      const scopeId = String(template.scope_id ?? '').trim();
      if (scopeType === 'global') return true;
      if (scopeType === 'tenant') return Boolean(activeTenantId) && scopeId === activeTenantId;
      if (scopeType === 'client' || scopeType === 'sender') {
        return scopeType === activeScopeType && Boolean(activeScopeId) && scopeId === activeScopeId;
      }
      return false;
    }),
    [allTemplates, activeScopeId, activeScopeType, activeTenantId],
  );
  const tplById = useMemo(() => {
    const m = new Map<string, WorkflowTemplate>();
    templates.forEach((entry) => m.set(entry.id, entry));
    return m;
  }, [templates]);
  const allRuns = useMemo(
    () => rawRuns.map((row) => normalizeWorkflowRun(row, tplById)),
    [rawRuns, tplById],
  );
  const activeTriggerRows = useMemo(
    () => (triggersQuery.data?.rows ?? []).filter((row) => isWorkflowRunTriggerActive(row)),
    [triggersQuery.data],
  );
  const directoryByRunId = useMemo(() => {
    const m = new Map<string, WorkflowRunDirectoryRow>();
    for (const r of allRuns as WorkflowRunDirectoryRow[]) m.set(r.id, r);
    return m;
  }, [allRuns]);

  const [hashQ, setHashQ] = useState<Record<string, string>>(() => parseRouteQuery());
  // W11-6 active tab. `tab=triggers|schedules` deep-link keeps focus tab on reload.
  const initialTab: RunsTab = (() => {
    const fromHash = parseRouteQuery().tab;
    return fromHash === 'triggers' || fromHash === 'schedules' ? fromHash : 'runs';
  })();
  const [activeTab, setActiveTab] = useState<RunsTab>(initialTab);
  const [triggerCreateReadback, setTriggerCreateReadback] = useState<WorkflowRunTriggerCreateReadback | null>(null);
  const [triggerLifecycleReadback, setTriggerLifecycleReadback] = useState<WorkflowRunTriggerLifecycleReadback | null>(null);
  const [scheduleCreateReadback, setScheduleCreateReadback] = useState<ScheduleCreateReadback | null>(null);
  const [scheduleRunNowReadback, setScheduleRunNowReadback] = useState<ScheduleRunNowReadback | null>(null);
  const [scheduleRunNowRunReadback, setScheduleRunNowRunReadback] = useState<WorkflowRunDirectoryRow | null>(null);
  const [scheduleTaskRepairReadback, setScheduleTaskRepairReadback] = useState<ScheduleTaskRepairReadback | null>(null);
  const [inspectionReadback, setInspectionReadback] = useState<WorkflowRunInspectionReadback | null>(null);
  const scheduleRunNowTimers = useRef<number[]>([]);
  const scheduleTypeOptions = useMemo<ScheduleTypeOption[]>(() => {
    return api.getLookups('workflow_schedule_type')
      .filter((row) => row.metadata?.summary_template !== 'cron')
      .sort((a, b) => Number(a.rank ?? 0) - Number(b.rank ?? 0))
      .map((row) => ({
        value: row.value,
        label: row.label,
        rank: row.rank,
        metadata: row.metadata,
      }));
  }, []);
  const triggerStatusOptions = useMemo(() => workflowRunStatusOptions(), []);

  function updateRunsRoute(nextQuery: Record<string, string>) {
    setHashQ(nextQuery);
    const qs = new URLSearchParams(nextQuery).toString();
    go(qs ? `/workflows/runs?${qs}` : '/workflows/runs');
  }

  function filterByTemplate(templateId: string) {
    setActiveTab('runs');
    updateRunsRoute({ template: templateId });
  }

  function switchTab(next: RunsTab) {
    setActiveTab(next);
    // Mirror state into the hash so deep links survive reloads, while keeping
    // the existing ?focus= query intact for runs drawer auto-open behavior.
    const q = parseRouteQuery();
    if (next === 'runs') delete q.tab;
    else q.tab = next;
    updateRunsRoute(q);
  }

  // Track URL changes for ?focus= deep links, with legacy hash fallback.
  useEffect(() => {
    const onLocation = () => setHashQ(parseRouteQuery());
    window.addEventListener('hashchange', onLocation);
    window.addEventListener('popstate', onLocation);
    return () => {
      window.removeEventListener('hashchange', onLocation);
      window.removeEventListener('popstate', onLocation);
    };
  }, []);

  useEffect(
    () => () => {
      scheduleRunNowTimers.current.forEach((timer) => window.clearTimeout(timer));
      scheduleRunNowTimers.current = [];
    },
    [],
  );

  const filtered = hashQ.template
    ? allRuns.filter((r) => r.template_id === hashQ.template)
    : allRuns;

  const activeScheduleRunNowSchedule = useMemo(() => {
    if (!scheduleRunNowReadback) return null;
    return (schedulesQuery.data?.rows ?? []).find((row) => row.id === scheduleRunNowReadback.scheduleId) ?? null;
  }, [scheduleRunNowReadback, schedulesQuery.data]);

  const activeScheduleRunNowRun = scheduleRunNowReadback?.workflowRunId
    ? (
      scheduleRunNowRunReadback?.id === scheduleRunNowReadback.workflowRunId
        ? scheduleRunNowRunReadback
        : directoryByRunId.get(scheduleRunNowReadback.workflowRunId)
    )
    : undefined;
  const activeScheduleRunNowPreflightFailed = scheduleRunNowReadback?.status === 'preflight_failed';
  const activeScheduleRunNowStatus = activeScheduleRunNowPreflightFailed
    ? 'preflight_failed'
    : workflowRunStatusValue(activeScheduleRunNowRun);
  const activeScheduleRunNowError =
    workflowRunErrorValue(activeScheduleRunNowRun) ||
    String(activeScheduleRunNowSchedule?.last_error ?? '').trim() ||
    String(scheduleRunNowReadback?.error ?? '').trim() ||
    null;
  const activeScheduleRunNowLastRunAt =
    activeScheduleRunNowPreflightFailed
      ? null
      : activeScheduleRunNowSchedule?.last_run_at ?? scheduleRunNowReadback?.lastRunAt ?? null;

  const activeScheduleTaskRepairSchedule = useMemo(() => {
    if (!scheduleTaskRepairReadback) return null;
    return (schedulesQuery.data?.rows ?? []).find((row) => row.id === scheduleTaskRepairReadback.scheduleId) ?? null;
  }, [scheduleTaskRepairReadback, schedulesQuery.data]);

  async function refetchScheduleRunNowReadback(workflowRunId?: string | null) {
    try {
      await Promise.all([schedulesQuery.refetch(), runsQuery.refetch()]);
    } catch {
      // The timed exact-run readback below keeps retrying so a started run is
      // not reported as a failed action because a projection refresh was late.
    }
    if (!workflowRunId) return;
    try {
      const row = await api.ui_get_resource_v1<WorkflowRunDirectoryRow>('workflow_run_directory', workflowRunId);
      setScheduleRunNowRunReadback(row);
    } catch {
      // Leave the panel in Awaiting readback; queued timers will retry the same
      // exact run id without forcing an operator reload.
    }
  }

  function queueScheduleRunNowReadbackRefetches(workflowRunId: string) {
    scheduleRunNowTimers.current.forEach((timer) => window.clearTimeout(timer));
    scheduleRunNowTimers.current = [];
    [1500, 5000, 15000, 30000, 45000, 60000, 90000].forEach((delayMs) => {
      const timer = window.setTimeout(() => {
        void refetchScheduleRunNowReadback(workflowRunId);
      }, delayMs);
      scheduleRunNowTimers.current.push(timer);
    });
  }

  async function runScheduleNow(row: WorkflowScheduleTrigger) {
    try {
      const result = await api.ui_run_workflow_schedule_trigger_v1(row.id);
      setScheduleRunNowReadback({
        scheduleId: row.id,
        workflowTemplateId: result.workflow_template_id ?? row.workflow_template_id ?? null,
        workflowRunId: result.workflow_run_id ?? null,
        status: String(result.status ?? '') || null,
        templateLabel: workflowTemplateOperatorLabel(row.template_name || row.workflow_template_id),
        lastRunAt: result.status === 'preflight_failed'
          ? null
          : String(result.last_run_at ?? row.last_run_at ?? '') || null,
        error: String(result.last_error ?? '') || null,
        errorAt: String(result.last_error_at ?? '') || null,
        requestedAt: new Date().toISOString(),
      });
      setScheduleRunNowRunReadback(null);
      await refetchScheduleRunNowReadback(result.workflow_run_id ?? null);
      if (result.workflow_run_id) queueScheduleRunNowReadbackRefetches(result.workflow_run_id);
      if (result.status === 'preflight_failed') {
        pushToast(
          t('workflowRuns.runsModule.runNowSetupCheck'),
          'danger',
        );
      } else {
        pushToast(
          t('workflowRuns.runsModule.queuedScheduleRun'),
          'good',
        );
      }
    } catch (err) {
      pushToast(t('workflowRuns.runsModule.runNowCouldNot'), 'danger');
    }
  }

  async function repairScheduleTaskPayload(row: WorkflowScheduleTrigger) {
    try {
      const result = await api.ui_repair_workflow_schedule_task_payload_v1(row.id);
      setScheduleTaskRepairReadback({
        scheduleId: row.id,
        workflowTemplateId: result.workflow_template_id ?? row.workflow_template_id ?? null,
        workflowTemplateStepId: result.workflow_template_step_id ?? null,
        status: String(result.status ?? '') || null,
        templateLabel: workflowTemplateOperatorLabel(row.template_name || row.workflow_template_id),
        operationName: result.operation_name ?? null,
        taskTypeKey: result.task_type_key ?? null,
        queueKey: result.queue_key ?? null,
        priority: result.priority ?? null,
        slaMinutes: result.sla_minutes ?? null,
        resourceType: result.resource_type ?? null,
        resourceId: result.resource_id ?? null,
        updatedAt: result.updated_at ?? null,
        requestedAt: new Date().toISOString(),
      });
      setScheduleRunNowReadback(null);
      setScheduleRunNowRunReadback(null);
      await schedulesQuery.refetch();
      pushToast(
        t('workflowRuns.runsModule.taskDetailsRepaired'),
        'good',
      );
    } catch (err) {
      pushToast(t('workflowRuns.runsModule.scheduleRepairCouldNot'), 'danger');
    }
  }

  function triggerReadbackFromRow(
    row: WorkflowRunTrigger,
    action: WorkflowRunTriggerLifecycleReadback['action'],
  ): WorkflowRunTriggerLifecycleReadback {
    const sourceLabel = workflowTemplateOperatorLabel(
      row.source_template_name
        || tplById.get(row.source_workflow_template_id)?.name
        || row.source_workflow_template_id,
    );
    const targetLabel = workflowTemplateOperatorLabel(
      row.target_template_name
        || tplById.get(row.target_workflow_template_id)?.name
        || row.target_workflow_template_id,
    );
    return {
      action,
      triggerId: row.id,
      sourceWorkflowTemplateId: row.source_workflow_template_id ?? null,
      targetWorkflowTemplateId: row.target_workflow_template_id ?? null,
      sourceLabel,
      targetLabel,
      sourceStatuses: Array.isArray(row.source_statuses)
        ? row.source_statuses.map((status) => String(status))
        : [],
      enabled: Boolean(row.enabled),
      scopeLabel: row.scope_type && row.scope_id ? `${row.scope_type}:${row.scope_id}` : null,
      notes: String(row.notes ?? '').trim() || null,
      requestedAt: new Date().toISOString(),
    };
  }

  function clearTriggerSiblingReadbacks() {
    setTriggerCreateReadback(null);
    setScheduleCreateReadback(null);
    setScheduleRunNowReadback(null);
    setScheduleRunNowRunReadback(null);
    setScheduleTaskRepairReadback(null);
  }

  function activeTenantScopeIdForWorkflowTrigger(): string | null {
    const scopeType = identity.currentScopeType();
    return scopeType === 'platform' || scopeType === 'tenant'
      ? identity.currentTenantId() || null
      : null;
  }

  async function refetchTriggerRow(triggerId: string): Promise<WorkflowRunTrigger | null> {
    const refreshed = await triggersQuery.refetch();
    const rows = (refreshed.data?.rows ?? triggersQuery.data?.rows ?? []).filter((row) =>
      isWorkflowRunTriggerActive(row),
    );
    return rows.find((row) => row.id === triggerId) ?? null;
  }

  async function updateWorkflowRunTrigger(
    row: WorkflowRunTrigger,
    args: Parameters<typeof api.ui_update_workflow_run_trigger_v1>[0],
    action: WorkflowRunTriggerLifecycleReadback['action'],
  ) {
    const result = await api.ui_update_workflow_run_trigger_v1(args);
    const readbackRow = await refetchTriggerRow(row.id);
    if (!readbackRow) {
      throw new Error('Updated workflow trigger was not visible in the refreshed Triggers list');
    }
    clearTriggerSiblingReadbacks();
    setTriggerLifecycleReadback(triggerReadbackFromRow(readbackRow, action));
    setActiveTab('triggers');
    pushToast(
      fill(t('workflowRuns.runsModule.workflowTrigger'), { action: String(action), value: String(workflowTemplateOperatorLabel(readbackRow.source_template_name || readbackRow.source_workflow_template_id)) }),
      'good',
    );
    return result;
  }

  function openEditRunTrigger(row: WorkflowRunTrigger) {
    if (!canWrite) return;
    modal.open({
      title: t('workflowRuns.runsModule.editWorkflowTrigger'),
      body: (
        <WorkflowRunTriggerComposer
          templates={templates}
          statusOptions={triggerStatusOptions}
          existingTriggers={activeTriggerRows}
          initialTrigger={row}
          submitLabel={t('workflowRuns.runsModule.saveTrigger')}
          onCancel={() => modal.close()}
          onSubmit={async (args) => {
            await updateWorkflowRunTrigger(
              row,
              {
                workflow_run_trigger_id: row.id,
                ...args,
                scope_id: activeTenantScopeIdForWorkflowTrigger(),
              },
              'updated',
            );
            modal.close();
          }}
        />
      ),
    });
  }

  async function toggleRunTrigger(row: WorkflowRunTrigger) {
    try {
      await updateWorkflowRunTrigger(
        row,
        {
          workflow_run_trigger_id: row.id,
          enabled: !row.enabled,
          scope_id: activeTenantScopeIdForWorkflowTrigger(),
        },
        row.enabled ? 'disabled' : 'enabled',
      );
    } catch (err) {
      pushToast(t('workflowRuns.runsModule.workflowTriggerUpdateCould'), 'danger');
    }
  }

  function confirmDeleteRunTrigger(row: WorkflowRunTrigger) {
    if (!canWrite) return;
    const sourceLabel = workflowTemplateOperatorLabel(row.source_template_name || row.source_workflow_template_id);
    const targetLabel = workflowTemplateOperatorLabel(row.target_template_name || row.target_workflow_template_id);
    modal.open({
      title: t('workflowRuns.runsModule.deleteWorkflowTrigger'),
      body: (
        <div style={{ display: 'grid', gap: '10px' }}>
          <p style={{ margin: 0 }}>
            {fill(t('workflowRuns.runsModule.deleteTheTriggerFrom'), { sourceLabel, targetLabel })}
          </p>
          <p style={{ margin: 0, color: 'var(--ink-3)' }}>
            {t('workflowRuns.runsModule.existingActivityHistoryStays')}
          </p>
        </div>
      ),
      footer: (
        <>
          <Button label={t('workflowRuns.runsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowRuns.runsModule.deleteTrigger')}
            iconName="trash"
            kind="danger"
            capability={CAP.WORKFLOWS_WRITE}
            onClick={async () => {
              try {
                const result = await api.ui_delete_workflow_run_trigger_v1(
                  row.id,
                  activeTenantScopeIdForWorkflowTrigger(),
                );
                const refreshed = await triggersQuery.refetch();
                const stillVisible = (refreshed.data?.rows ?? [])
                  .filter((candidate) => isWorkflowRunTriggerActive(candidate))
                  .some((candidate) => candidate.id === row.id);
                if (stillVisible) {
                  throw new Error('Deleted workflow trigger was still visible in the refreshed Triggers list');
                }
                clearTriggerSiblingReadbacks();
                setTriggerLifecycleReadback({
                  ...triggerReadbackFromRow(row, 'deleted'),
                  enabled: false,
                  workflowTriggerFiresCount: Number(result.workflow_trigger_fires_count ?? 0),
                });
                modal.close();
                setActiveTab('triggers');
                pushToast(fill(t('workflowRuns.runsModule.workflowTriggerDeleted'), { sourceLabel: String(sourceLabel) }), 'good');
              } catch (err) {
                pushToast(t('workflowRuns.runsModule.workflowTriggerCouldNot'), 'danger');
              }
            }}
          />
        </>
      ),
    });
  }

  function openNewRunTrigger() {
    if (!canWrite) return;
    if (templates.length < 2) {
      modal.open({
        title: t('workflowRuns.runsModule.newWorkflowTrigger'),
        body: (
          <StateView
            kind="error"
            title={t('workflowRuns.runsModule.workflowTriggerNeedsTwo')}
            hint={t('workflowRuns.runsModule.createOrSyncAnother')}
          />
        ),
        footer: <Button label={t('workflowRuns.runsModule.close')} kind="ghost" onClick={() => modal.close()} />,
      });
      return;
    }
    if (triggerStatusOptions.length === 0) {
      modal.open({
        title: t('workflowRuns.runsModule.newWorkflowTrigger'),
        body: (
          <StateView
            kind="error"
            title={t('workflowRuns.runsModule.workflowRunStatusesAre')}
            hint={t('workflowRuns.runsModule.refreshAfterWorkflowStatus')}
          />
        ),
        footer: <Button label={t('workflowRuns.runsModule.close')} kind="ghost" onClick={() => modal.close()} />,
      });
      return;
    }
    modal.open({
      title: t('workflowRuns.runsModule.newWorkflowTrigger'),
      body: (
        <WorkflowRunTriggerComposer
          templates={templates}
          statusOptions={triggerStatusOptions}
          existingTriggers={activeTriggerRows}
          onCancel={() => modal.close()}
          onSubmit={async (args) => {
            const result = await api.ui_create_workflow_run_trigger_v1({
              ...args,
              scope_id: activeTenantScopeIdForWorkflowTrigger(),
            });
            const refreshed = await triggersQuery.refetch();
            const rows = (refreshed.data?.rows ?? triggersQuery.data?.rows ?? []).filter((row) =>
              isWorkflowRunTriggerActive(row),
            );
            const readbackRow = rows.find((row) => row.id === result.workflow_run_trigger_id);
            if (!readbackRow) {
              throw new Error('Created workflow trigger was not visible in the refreshed Triggers list');
            }
            const sourceLabel = workflowTemplateOperatorLabel(
              readbackRow.source_template_name
                || tplById.get(readbackRow.source_workflow_template_id)?.name
                || readbackRow.source_workflow_template_id,
            );
            const targetLabel = workflowTemplateOperatorLabel(
              readbackRow.target_template_name
                || tplById.get(readbackRow.target_workflow_template_id)?.name
                || readbackRow.target_workflow_template_id,
            );
            setTriggerCreateReadback({
              triggerId: readbackRow.id,
              sourceWorkflowTemplateId: readbackRow.source_workflow_template_id ?? null,
              targetWorkflowTemplateId: readbackRow.target_workflow_template_id ?? null,
              sourceLabel,
              targetLabel,
              sourceStatuses: Array.isArray(readbackRow.source_statuses)
                ? readbackRow.source_statuses.map((status) => String(status))
                : result.source_statuses,
              enabled: Boolean(readbackRow.enabled),
              scopeLabel: readbackRow.scope_type && readbackRow.scope_id
                ? `${readbackRow.scope_type}:${readbackRow.scope_id}`
                : null,
              notes: String(readbackRow.notes ?? '').trim() || null,
              requestedAt: new Date().toISOString(),
            });
            setTriggerLifecycleReadback(null);
            setScheduleCreateReadback(null);
            setScheduleRunNowReadback(null);
            setScheduleRunNowRunReadback(null);
            setScheduleTaskRepairReadback(null);
            modal.close();
            setActiveTab('triggers');
            pushToast(fill(t('workflowRuns.runsModule.workflowTriggerCreated'), { sourceLabel: String(sourceLabel), targetLabel: String(targetLabel) }), 'good');
          }}
        />
      ),
    });
  }

  function openNewSchedule() {
    if (!canWrite) return;
    if (templates.length === 0) {
      modal.open({
        title: t('workflowRuns.runsModule.newSchedule'),
        body: (
          <StateView
            kind="error"
            title={t('workflowRuns.runsModule.workflowTemplatesAreUnavailable')}
            hint={t('workflowRuns.runsModule.refreshAfterWorkflowTemplate')}
          />
        ),
        footer: <Button label={t('workflowRuns.runsModule.close')} kind="ghost" onClick={() => modal.close()} />,
      });
      return;
    }
    if (scheduleTypeOptions.length === 0) {
      modal.open({
        title: t('workflowRuns.runsModule.newSchedule'),
        body: (
          <StateView
            kind="error"
            title={t('workflowRuns.runsModule.scheduleTypesAreUnavailable')}
            hint={t('workflowRuns.runsModule.theWorkflowScheduleType')}
          />
        ),
        footer: <Button label={t('workflowRuns.runsModule.close')} kind="ghost" onClick={() => modal.close()} />,
      });
      return;
    }
    modal.open({
      title: t('workflowRuns.runsModule.newSchedule'),
      body: (
        <WorkflowScheduleComposer
          templates={templates}
          scheduleTypeOptions={scheduleTypeOptions}
          onCancel={() => modal.close()}
          onSubmit={async (args) => {
            const result = await api.ui_create_workflow_schedule_trigger_v1(args);
            const refreshed = await schedulesQuery.refetch();
            const rows = refreshed.data?.rows ?? schedulesQuery.data?.rows ?? [];
            const readbackRow = rows.find((row) => row.id === result.workflow_schedule_trigger_id);
            if (!readbackRow) {
              throw new Error('Created schedule was not visible in the refreshed Schedules list');
            }
            setScheduleCreateReadback({
              scheduleId: readbackRow.id,
              workflowTemplateId: readbackRow.workflow_template_id ?? null,
              templateLabel: workflowTemplateOperatorLabel(readbackRow.template_name || readbackRow.workflow_template_id),
              scheduleLabel: String(readbackRow.schedule_summary ?? scheduleSummary(readbackRow.schedule as Record<string, unknown>)),
              enabled: Boolean(readbackRow.enabled),
              nextRunAt: readbackRow.next_run_at || null,
              scopeLabel: readbackRow.scope_type && readbackRow.scope_id
                ? `${readbackRow.scope_type}:${readbackRow.scope_id}`
                : null,
              notes: String(readbackRow.notes ?? '').trim() || null,
              requestedAt: new Date().toISOString(),
            });
            setScheduleRunNowReadback(null);
            setScheduleRunNowRunReadback(null);
            setScheduleTaskRepairReadback(null);
            setTriggerLifecycleReadback(null);
            modal.close();
            setActiveTab('schedules');
            pushToast(fill(t('workflowRuns.runsModule.scheduleCreated'), { value: String(workflowTemplateOperatorLabel(readbackRow.template_name || readbackRow.workflow_template_id)) }), 'good');
          }}
        />
      ),
    });
  }

  function openRunDrawer(run: WorkflowRun, opts: { replay?: boolean } = {}) {
    const tpl = tplById.get(run.template_id);
    // W22 — prefer canonical projection (template_name from join via
    // v_workflow_run_directory) when available; fall back to legacy seed
    // shape otherwise.
    const directoryRow = directoryByRunId.get(run.id);
    const titleTemplateName = workflowTemplateOperatorLabel(
      directoryRow?.template_name ?? tpl?.name ?? run.template_name,
    );
    drawer.open({
      title: `${run.run_id} · ${titleTemplateName}`,
      size: 'lg',
      deepLink: `/workflows/runs?focus=${encodeURIComponent(run.id)}`,
      body: (
        <RunDrawerBody
          run={run}
          template={tpl}
          initialReplay={opts.replay}
          onNavigateRun={(href) => go(href)}
        />
      ),
    });
  }

  // Auto-open if focus query is present.
  // Cycle E2 (Workflows P2 #12) — `drawerOpenDelayMs` resolves through
  // canonical `ui_presentation_policy.workflow_drawer_open_delay_ms`.
  // Missing/invalid canonical value → opens immediately (no fabricated
  // 200ms literal default).
  useEffect(() => {
    if (!hashQ.focus || !allRuns.length) return;
    const r = allRuns.find((x) => x.id === hashQ.focus);
    if (!r) return undefined;
    if (drawerOpenDelayMs === null || drawerOpenDelayMs === 0) {
      openRunDrawer(r);
      return undefined;
    }
    const entry = setTimeout(() => openRunDrawer(r), drawerOpenDelayMs);
    return () => clearTimeout(entry);
  }, [hashQ.focus, allRuns, drawerOpenDelayMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const COLUMNS: Array<DataTableColumn<WorkflowRun>> = [
    { key: 'run_id', label: t('workflowRuns.runsModule.run'), mono: true, sortable: true, filterable: true },
    { key: 'template_name', label: t('workflowRuns.runsModule.template'), sortable: true, filterable: true },
    { key: 'started_at', label: t('workflowRuns.runsModule.started'), format: 'datetime', sortable: true },
    { key: 'duration_ms', label: t('workflowRuns.runsModule.duration'), align: 'right', format: 'ms', sortable: true, type: 'number' },
    {
      key: 'status',
      label: t('workflowRuns.runsModule.status'),
      sortable: true,
      filterable: true,
      render: (raw) => {
        const v = String(raw);
        const r = statusTone('workflow_run_status', v);
        return r.tone && r.label
          ? <Chip label={r.label} kind={r.tone} size="xs" />
          : <Chip label={t('workflowRuns.runsModule.statusLabelIsNot')} kind="danger" size="xs" />;
      },
    },
    { key: 'triggered_by', label: t('workflowRuns.runsModule.triggeredBy'), sortable: true, filterable: true, mono: true },
    { key: 'correlation_id', label: t('workflowRuns.runsModule.requestTrail'), mono: true, sortable: true, filterable: true },
  ];

  const cancelRunBulk = useCancelWorkflowRun();
  const ROW_ACTIONS: Array<DataTableAction<WorkflowRun>> = [
    {
      // Cycle E2 (Workflows P1 #8) — Replay row action gates on
      // `workflows.write` so the FE matches the canonical
      // `progress_workflow_run` (action='manual_override' / 'replay')
      // server-side capability assertion.
      label: t('workflowRuns.runsModule.replay'),
      icon: 'rotate',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (r) => openRunDrawer(r, { replay: true }),
    },
    {
      label: t('workflowRuns.runsModule.viewTrace'),
      icon: 'trace_tree',
      onClick: (r) =>
        navigate({
          to: '/insights/traces' as never,
          search: workflowRunTraceSearch(r) as never,
        }),
    },
    {
      label: t('workflowRuns.runsModule.filterByTemplate'),
      icon: 'right',
      onClick: (r) => filterByTemplate(r.template_id),
    },
    {
      label: t('workflowRuns.runsModule.drillIntoStep'),
      icon: 'right',
      onClick: (r) => openRunDrawer(r),
    },
    {
      label: t('workflowRuns.runsModule.cancelRun'),
      icon: 'x',
      kind: 'danger',
      capability: CAP.WORKFLOWS_WRITE,
      disabled: (r) => !workflowRunAllowsAbort(r.status),
      disabledReason: (r) => workflowRunAbortDisabledReason(r.status),
      onClick: async (r) => {
        try {
          await cancelRunBulk.mutateAsync({ run_id: r.id });
          pushToast(fill(t('workflowRuns.runsModule.cancelled'), { run_id: String(r.run_id) }), 'warn');
        } catch (err) {
          pushToast(t('workflowRuns.runsModule.cancellationCouldNotBe'), 'danger');
        }
      },
    },
  ];

  async function markRunsInspected(rs: WorkflowRun[]) {
    if (!rs.length) return;
    try {
      const inspectedAt = new Date().toISOString();
      const rows = await Promise.all(
        rs.map(async (r) => {
          const runDisplayId = r.run_id || workflowRunDisplayId(r.id);
          const result = await api.ui_log_event_v1(
            {
              type: 'workflow_run.inspected',
              event: 'workflow_run.inspected',
              workflow_run_id: r.id,
              run_id: runDisplayId,
              correlation_id: r.correlation_id,
              payload: {
                workflow_run_id: r.id,
                run_id: runDisplayId,
                correlation_id: r.correlation_id,
                surface: 'console_v2.workflow_runs.bulk_mark_inspected',
              },
            },
            'console',
            { requireReadback: true },
          );
          const eventId = String(result.event_id ?? result.readback?.id ?? '').trim();
          if (!eventId) {
            throw new Error(`Missing saved inspection activity for ${runDisplayId}`);
          }
          return {
            workflowRunId: r.id,
            runDisplayId,
            correlationId: r.correlation_id || null,
            eventId,
            loggedAt: result.logged_at,
          };
        }),
      );
      setInspectionReadback({ inspectedAt, count: rows.length, rows });
      pushToast(fill(t('workflowRuns.runsModule.markedRunsInspected'), { length: String(rows.length) }), 'good');
    } catch (err) {
      setInspectionReadback(null);
      pushToast(t('workflowRuns.runsModule.inspectionConfirmationCouldNot'), 'danger');
    }
  }

  // Bulk actions wired to canonical entrypoint progress_workflow_run with
  // action='manual_override' (replay-of). Each call is independent so a single
  // failure does not cancel the rest of the batch.
  const BULK_ACTIONS: Array<DataTableBulkAction<WorkflowRun>> = [
    {
      label: t('workflowRuns.runsModule.replaySelected'),
      icon: 'rotate',
      kind: 'primary',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (rs) => {
        pushToast(fill(t('workflowRuns.runsModule.queuedReplayRuns'), { length: String(rs.length) }), 'info');
        void Promise.allSettled(
          rs.map((r) =>
            replayRun.mutateAsync({ run_id: r.id, template_id: r.template_id, payload: { replay_of: r.id } }),
          ),
        ).then((results) => {
          const ok = results.filter((x) => x.status === 'fulfilled').length;
          const fail = results.length - ok;
          pushToast(
            fail ? fill(t('workflowRuns.runsModule.replayBatchOkFailed'), { ok: String(ok), fail: String(fail) }) : fill(t('workflowRuns.runsModule.replayBatchOk'), { ok: String(ok) }),
            fail ? 'warn' : 'good',
          );
        });
      },
    },
    {
      // Cycle E2 (Workflows P1 #9) — Mark inspected bulk action gates on
      // `workflows.write` so the FE matches the canonical
      // `ui_log_event_v1` server-side capability assertion (telemetry
      // mutation through `decision_log` ladder writes).
      label: t('workflowRuns.runsModule.markInspected'),
      icon: 'check',
      kind: 'ghost',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (rs) => {
        void markRunsInspected(rs);
      },
    },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="wf-runs"
          eyebrow={t('workflowRuns.runsModule.workflows')}
          titleAccent="Run"
          titlePlain="history"
        />
        <StateView
          kind="denied"
          capability={CAP.WORKFLOWS_READ}
          hint={t('workflowRuns.runsModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (runsQuery.isLoading || templatesQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="wf-runs"
          eyebrow={t('workflowRuns.runsModule.workflows')}
          titleAccent="Run"
          titlePlain="history"
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (runsQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="wf-runs"
          eyebrow={t('workflowRuns.runsModule.workflows')}
          titleAccent="Run"
          titlePlain="history"
          pills={[]}
        />
        <StateView kind="error" hint={String(runsQuery.error)} />
      </div>
    );
  }

  // W11-6 columns for the new tabs.
  const TRIGGER_COLUMNS: Array<DataTableColumn<WorkflowRunTrigger>> = [
    {
      key: 'source_template_name',
      label: t('workflowRuns.runsModule.sourceTemplate'),
      sortable: true,
      filterable: true,
      render: (raw, row) => {
        const tplId = String(row?.source_workflow_template_id ?? '');
        return (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              filterByTemplate(tplId);
            }}
          >
            {workflowTemplateOperatorLabel(raw ?? tplId)}
          </button>
        );
      },
    },
    {
      key: 'target_template_name',
      label: t('workflowRuns.runsModule.targetTemplate'),
      sortable: true,
      filterable: true,
      render: (raw, row) => workflowTemplateOperatorLabel(raw ?? row?.target_workflow_template_id),
    },
    {
      key: 'source_statuses',
      label: t('workflowRuns.runsModule.onStatus'),
      filterable: true,
      render: (raw) => {
        const arr = Array.isArray(raw)
          ? [...new Set((raw as string[]).map((status) => normalizeWorkflowRunTriggerStatus(String(status))))]
          : [];
        return (
          <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
            {arr.map((s) => {
              const r = statusTone('workflow_run_status', s);
              return r.tone && r.label
                ? <Chip key={s} label={r.label} kind={r.tone} size="xs" />
                : <Chip key={s} label={t('workflowRuns.runsModule.statusLabelIsNot')} kind="danger" size="xs" />;
            })}
          </span>
        );
      },
    },
    { key: 'scope_type', label: t('workflowRuns.runsModule.scope'), filterable: true, lookup: 'workflow_trigger_scope_type' },
    {
      key: 'enabled',
      label: t('workflowRuns.runsModule.enabled'),
      filterable: true,
      // W56-D (closure) — workflow_run_triggers canonical lookup category is
      // `workflow_binding_enabled_state` (enabled/disabled). Domain language
      // for trigger bindings is "disabled" when off (operator-authored OFF
      // posture), distinct from schedule triggers which use "paused".
      render: (raw) => {
        const value = raw ? 'enabled' : 'disabled';
        const row = lookupRow('workflow_binding_enabled_state', value);
        if (!row) {
          return (
            <Chip
              label={t('workflowRuns.runsModule.statusLabelIsNot')}
              kind="danger"
              size="xs"
            />
          );
        }
        return (
          <Chip
            label={row.label ?? value}
            kind={(row.tone as ChipKind) ?? 'neutral'}
            size="xs"
          />
        );
      },
    },
    { key: 'last_scanned_completed_at', label: t('workflowRuns.runsModule.lastScan'), format: 'datetime', sortable: true },
    { key: 'updated_at', label: t('workflowRuns.runsModule.updated'), format: 'datetime', sortable: true },
  ];

  const SCHEDULE_COLUMNS: Array<DataTableColumn<WorkflowScheduleTrigger>> = [
    {
      key: 'template_name',
      label: t('workflowRuns.runsModule.template'),
      sortable: true,
      filterable: true,
      render: (raw, row) => {
        const tplId = String(row?.workflow_template_id ?? '');
        return (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              filterByTemplate(tplId);
            }}
          >
            {workflowTemplateOperatorLabel(raw ?? tplId)}
          </button>
        );
      },
    },
    {
      key: 'schedule_summary',
      label: t('workflowRuns.runsModule.schedule'),
      sortable: true,
      render: (raw, row) =>
        String(raw ?? scheduleSummary(row?.schedule as Record<string, unknown> | undefined)),
    },
    { key: 'scope_type', label: t('workflowRuns.runsModule.scope'), filterable: true, lookup: 'workflow_trigger_scope_type' },
    {
      key: 'enabled',
      label: t('workflowRuns.runsModule.enabled'),
      filterable: true,
      // W56-D (closure) — workflow_schedule_triggers canonical lookup category
      // is `workflow_schedule_enabled_state` (enabled/paused). Schedule triggers
      // render "paused" when off (warn tone — the schedule still exists but is
      // suppressed), distinct from binding triggers which use "disabled".
      render: (raw) => {
        const value = raw ? 'enabled' : 'paused';
        const row = lookupRow('workflow_schedule_enabled_state', value);
        if (!row) {
          return (
            <Chip
              label={t('workflowRuns.runsModule.statusLabelIsNot')}
              kind="danger"
              size="xs"
            />
          );
        }
        return (
          <Chip
            label={row.label ?? value}
            kind={(row.tone as ChipKind) ?? 'neutral'}
            size="xs"
          />
        );
      },
    },
    { key: 'next_run_at', label: t('workflowRuns.runsModule.nextRun'), format: 'datetime', sortable: true },
    { key: 'last_run_at', label: t('workflowRuns.runsModule.lastRun'), format: 'datetime', sortable: true },
    {
      key: 'last_error',
      label: t('workflowRuns.runsModule.lastError'),
      render: (raw) => {
        const err = String(raw ?? '');
        if (!err) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        return <Chip label={err.slice(0, 32)} kind="danger" size="xs" />;
      },
    },
  ];

  // Schedule row actions — fire-now rides through the canonical
  // ui_run_workflow_schedule_trigger_v1 RPC. Capability gate: workflows.write.
  const SCHEDULE_ROW_ACTIONS: Array<DataTableAction<WorkflowScheduleTrigger>> = [
    {
      label: t('workflowRuns.runsModule.viewRuns'),
      icon: 'right',
      onClick: (row) => {
        filterByTemplate(row.workflow_template_id);
      },
    },
    {
      label: t('workflowRuns.runsModule.runNow'),
      icon: 'play',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (row) => {
        void runScheduleNow(row);
      },
    },
    {
      label: t('workflowRuns.runsModule.repairTaskDetails'),
      icon: 'settings',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (row) => {
        void repairScheduleTaskPayload(row);
      },
    },
  ];

  const TRIGGER_ROW_ACTIONS: Array<DataTableAction<WorkflowRunTrigger>> = [
    {
      label: t('workflowRuns.runsModule.editTrigger'),
      icon: 'settings',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (row) => {
        openEditRunTrigger(row);
      },
    },
    {
      label: t('workflowRuns.runsModule.disableTrigger'),
      icon: 'power',
      capability: CAP.WORKFLOWS_WRITE,
      hidden: (row) => !row.enabled,
      onClick: (row) => {
        void toggleRunTrigger(row);
      },
    },
    {
      label: t('workflowRuns.runsModule.enableTrigger'),
      icon: 'power',
      capability: CAP.WORKFLOWS_WRITE,
      hidden: (row) => row.enabled,
      onClick: (row) => {
        void toggleRunTrigger(row);
      },
    },
    {
      label: t('workflowRuns.runsModule.viewSourceRuns'),
      icon: 'right',
      onClick: (row) => {
        filterByTemplate(row.source_workflow_template_id);
      },
    },
    {
      label: t('workflowRuns.runsModule.filterByTargetTemplate'),
      icon: 'right',
      onClick: (row) => filterByTemplate(row.target_workflow_template_id),
    },
    {
      label: t('workflowRuns.runsModule.deleteTrigger'),
      icon: 'trash',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (row) => {
        confirmDeleteRunTrigger(row);
      },
    },
  ];

  let filterBanner: ReactNode = null;
  if (hashQ.template) {
    const tpl = tplById.get(hashQ.template);
    filterBanner = (
      <div className="wf-runs-filter-banner">
        <span>{t('workflowRuns.runsModule.filteredByTemplate')}</span>
        <Chip label={tpl?.name || workflowTemplateOperatorLabel(hashQ.template)} kind="info" />
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => {
            setActiveTab('runs');
            updateRunsRoute({});
          }}
        >
          {t('workflowRuns.runsModule.clearFilter')}
        </button>
      </div>
    );
  }

  // W11-6 page-level tab strip: switches between Runs / Triggers / Schedules.
  const tabBar: ReactNode = (
    <div
      className="tabs"
      role="tablist"
      aria-label={t('workflowRuns.runsModule.workflowRunsTabs')}
      data-testid="wf-runs-tabs"
    >
      {RUNS_TABS.map((entry) => {
        const countLabel =
          entry.key === 'runs'
            ? hashQ.template
              ? `${filtered.length} / ${allRuns.length}`
              : String(allRuns.length)
            : entry.key === 'triggers'
              ? String(activeTriggerRows.length)
              : String((schedulesQuery.data?.rows ?? []).length);
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={activeTab === entry.key}
            aria-label={t(`workflowRuns.tabs.${entry.key}.aria`)}
            data-testid={`wf-runs-tab-${entry.key}`}
            className={`tabs__tab ${activeTab === entry.key ? 'is-active' : ''}`}
            onClick={() => switchTab(entry.key)}
          >
            {t(`workflowRuns.tabs.${entry.key}.label`)}{' '}
            <span className="mono" style={{ color: 'var(--ink-3)', fontSize: '11px' }}>
              · {countLabel}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="page">
      <PageHeader
        moduleKey="wf-runs"
        eyebrow={t('workflowRuns.runsModule.workflows')}
        titleAccent="Run"
        titlePlain="history"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="src" className="chip chip--xs mono">
            {activeTab === 'runs'
              ? t('workflowRuns.runsModule.runHistoryStepTimeline')
              : activeTab === 'triggers'
                ? t('workflowRuns.runsModule.workflowChaining')
                : t('workflowRuns.runsModule.scheduledRuns')}
          </span>,
        ]}
        actions={[
          ...(activeTab === 'triggers'
            ? [
                <Button
                  key="new-trigger"
                  label={t('workflowRuns.runsModule.newTrigger')}
                  iconName="plus"
                  kind="primary"
                  capability={CAP.WORKFLOWS_WRITE}
                  onClick={openNewRunTrigger}
                />,
              ]
            : []),
          ...(activeTab === 'schedules'
            ? [
                <Button
                  key="new-schedule"
                  label={t('workflowRuns.runsModule.newSchedule')}
                  iconName="plus"
                  kind="primary"
                  capability={CAP.WORKFLOWS_WRITE}
                  onClick={openNewSchedule}
                />,
              ]
            : []),
          <Button
            key="refresh"
            label={t('workflowRuns.runsModule.refreshRuns')}
            iconName="refresh"
            kind="ghost"
            onClick={() => {
              void runsQuery.refetch();
              void triggersQuery.refetch();
              void schedulesQuery.refetch();
              pushToast(t('workflowRuns.runsModule.workflowRunsRefreshed'), 'info');
            }}
          />,
        ]}
      />
      {tabBar}
      {activeTab === 'runs' ? (
        <>
          {filterBanner}
          {inspectionReadback ? (
            <section
              data-testid="workflow-run-inspection-readback"
              aria-label={t('workflowRuns.runsModule.workflowRunInspectionResult')}
              style={{
                border: '1px solid var(--line)',
                borderRadius: '8px',
                background: 'var(--panel)',
                padding: '12px',
                marginBottom: '12px',
                display: 'grid',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.inspectionResult')}</div>
                  <strong>{fill(inspectionReadback.count === 1 ? t('workflowRuns.runsModule.workflowRunInspectedOne') : t('workflowRuns.runsModule.workflowRunInspectedOther'), { count: String(inspectionReadback.count) })}</strong>
                </div>
                <Chip label={t('workflowRuns.runsModule.confirmedFromSavedData')} kind="good" size="xs" />
              </div>
              <div style={{ display: 'grid', gap: '6px' }}>
                {inspectionReadback.rows.map((row) => (
                  <div
                    key={`${row.workflowRunId}-${row.eventId}`}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
                  >
                    <span className="mono">{row.runDisplayId}</span>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.activityRecorded')}</span>
                    {row.correlationId ? (
                      <>
                        <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.referenceRecorded')}</span>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
              <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>
                {fill(t('workflowRuns.runsModule.checkedAt'), { inspectedAt: String(inspectionReadback.inspectedAt) })}
              </div>
            </section>
          ) : null}
          <DataTable<WorkflowRun>
            columns={COLUMNS}
            rows={filtered}
            viewKey="workflow_run_history"
            entityKind="workflow run"
            onRowClick={(r) => openRunDrawer(r)}
            rowDeepLink={(r) => `/workflows/runs?focus=${encodeURIComponent(r.id)}`}
            rowActions={ROW_ACTIONS}
            bulkActions={BULK_ACTIONS}
          />
        </>
      ) : null}
      {activeTab === 'triggers' ? (
        triggersQuery.isLoading ? (
          <StateView kind="loading" />
        ) : triggersQuery.error ? (
          <StateView kind="error" hint={String(triggersQuery.error)} />
        ) : (
          <>
            {triggerCreateReadback ? (
              <section
                data-testid="workflow-run-trigger-create-readback"
                aria-label={t('workflowRuns.runsModule.workflowRunTriggerCreate')}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  background: 'var(--panel)',
                  padding: '12px',
                  marginBottom: '12px',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.triggerCreateResult')}</div>
                    <strong>{fill(t('workflowRuns.runsModule.to'), { sourceLabel: String(triggerCreateReadback.sourceLabel), targetLabel: String(triggerCreateReadback.targetLabel) })}</strong>
                  </div>
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip label={triggerCreateReadback.enabled ? t('workflowRuns.runsModule.enabled') : t('workflowRuns.runsModule.disabled')} kind={triggerCreateReadback.enabled ? 'good' : 'warn'} size="xs" />
                    <Chip label={t('workflowRuns.runsModule.confirmedFromSavedData')} kind="good" size="xs" />
                  </span>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '8px',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.trigger')}</span>
                    <div>{t('workflowRuns.runsModule.created')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.sourceStatus')}</span>
                    <div style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
                      {triggerCreateReadback.sourceStatuses.map((status) => {
                        const resolved = statusTone('workflow_run_status', status);
                        return resolved.tone && resolved.label ? (
                          <Chip key={status} label={resolved.label} kind={resolved.tone} size="xs" />
                        ) : (
                          <Chip key={status} label={t('workflowRuns.runsModule.statusLabelIsNot')} kind="danger" size="xs" />
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.scope')}</span>
                    <div>{triggerCreateReadback.scopeLabel ? t('workflowRuns.runsModule.configured') : t('workflowRuns.runsModule.defaultWorkflowScope')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.requested')}</span>
                    <div>{workflowRunDateLabel(triggerCreateReadback.requestedAt)}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.notes')}</span>
                    <div>{triggerCreateReadback.notes ?? '-'}</div>
                  </div>
                </div>
              </section>
            ) : null}
            {triggerLifecycleReadback ? (
              <section
                data-testid="workflow-run-trigger-lifecycle-readback"
                aria-label={t('workflowRuns.runsModule.workflowRunTriggerLifecycle')}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  background: 'var(--panel)',
                  padding: '12px',
                  marginBottom: '12px',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.triggerLifecycleResult')}</div>
                    <strong>{fill(t('workflowRuns.runsModule.to'), { sourceLabel: String(triggerLifecycleReadback.sourceLabel), targetLabel: String(triggerLifecycleReadback.targetLabel) })}</strong>
                  </div>
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip
                      label={triggerLifecycleReadback.action}
                      kind={triggerLifecycleReadback.action === 'deleted' ? 'warn' : 'good'}
                      size="xs"
                    />
                    <Chip label={t('workflowRuns.runsModule.confirmedFromSavedData')} kind="good" size="xs" />
                  </span>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '8px',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.trigger')}</span>
                    <div>{t('workflowRuns.runsModule.saved')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.currentState')}</span>
                    <div>
                      {triggerLifecycleReadback.action === 'deleted'
                        ? t('workflowRuns.runsModule.deletedFromTriggerList')
                        : triggerLifecycleReadback.enabled ? t('workflowRuns.runsModule.enabled') : t('workflowRuns.runsModule.disabled')}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.sourceStatus')}</span>
                    <div style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
                      {triggerLifecycleReadback.sourceStatuses.map((status) => {
                        const resolved = statusTone('workflow_run_status', status);
                        return resolved.tone && resolved.label ? (
                          <Chip key={status} label={resolved.label} kind={resolved.tone} size="xs" />
                        ) : (
                          <Chip key={status} label={t('workflowRuns.runsModule.statusLabelIsNot')} kind="danger" size="xs" />
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.scope')}</span>
                    <div>{triggerLifecycleReadback.scopeLabel ? t('workflowRuns.runsModule.configured') : t('workflowRuns.runsModule.defaultWorkflowScope')}</div>
                  </div>
                  {triggerLifecycleReadback.workflowTriggerFiresCount !== undefined ? (
                    <div>
                      <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.fireLineageRows')}</span>
                      <div>{triggerLifecycleReadback.workflowTriggerFiresCount}</div>
                    </div>
                  ) : null}
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.requested')}</span>
                    <div>{workflowRunDateLabel(triggerLifecycleReadback.requestedAt)}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.notes')}</span>
                    <div>{triggerLifecycleReadback.notes ?? '-'}</div>
                  </div>
                </div>
              </section>
            ) : null}
            <DataTable<WorkflowRunTrigger>
              columns={TRIGGER_COLUMNS}
              rows={activeTriggerRows}
              viewKey="workflow_run_triggers"
              entityKind="workflow_run_trigger"
              rowActions={TRIGGER_ROW_ACTIONS}
            />
          </>
        )
      ) : null}
      {activeTab === 'schedules' ? (
        schedulesQuery.isLoading ? (
          <StateView kind="loading" />
        ) : schedulesQuery.error ? (
          <StateView kind="error" hint={String(schedulesQuery.error)} />
        ) : (
          <>
            {scheduleCreateReadback ? (
              <section
                data-testid="workflow-schedule-create-readback"
                aria-label={t('workflowRuns.runsModule.workflowScheduleCreateResult')}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  background: 'var(--panel)',
                  padding: '12px',
                  marginBottom: '12px',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.scheduleCreateResult')}</div>
                    <strong>{scheduleCreateReadback.templateLabel}</strong>
                  </div>
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip label={scheduleCreateReadback.enabled ? t('workflowRuns.runsModule.enabled') : t('workflowRuns.runsModule.paused')} kind={scheduleCreateReadback.enabled ? 'good' : 'warn'} size="xs" />
                    <Chip label={t('workflowRuns.runsModule.confirmedFromSavedData')} kind="good" size="xs" />
                  </span>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '8px',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.schedule')}</span>
                    <div>{t('workflowRuns.runsModule.created')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.cadence')}</span>
                    <div>{scheduleCreateReadback.scheduleLabel}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.nextRun')}</span>
                    <div>{workflowRunDateLabel(scheduleCreateReadback.nextRunAt)}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.scope')}</span>
                    <div>{scheduleCreateReadback.scopeLabel ? t('workflowRuns.runsModule.configured') : t('workflowRuns.runsModule.defaultWorkflowScope')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.requested')}</span>
                    <div>{workflowRunDateLabel(scheduleCreateReadback.requestedAt)}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.notes')}</span>
                    <div>{scheduleCreateReadback.notes ?? '—'}</div>
                  </div>
                </div>
              </section>
            ) : null}
            {scheduleTaskRepairReadback ? (
              <section
                data-testid="workflow-schedule-task-payload-repair-readback"
                aria-label={t('workflowRuns.runsModule.workflowScheduleTaskSetup')}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  background: 'var(--panel)',
                  padding: '12px',
                  marginBottom: '12px',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.taskSetupResult')}</div>
                    <strong>{scheduleTaskRepairReadback.templateLabel}</strong>
                  </div>
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip label={t('workflowRuns.runsModule.taskDetailsRepaired2')} kind="good" size="xs" />
                    <Button
                      label={t('workflowRuns.runsModule.runRepairedSchedule')}
                      iconName="play"
                      size="sm"
                      kind="primary"
                      disabled={!activeScheduleTaskRepairSchedule}
                      onClick={() => {
                        if (activeScheduleTaskRepairSchedule) void runScheduleNow(activeScheduleTaskRepairSchedule);
                      }}
                    />
                  </span>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '8px',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.schedule')}</span>
                    <div>{t('workflowRuns.runsModule.updated')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.taskType')}</span>
                    <div>
                      {scheduleTaskRepairReadback.taskTypeKey
                        ? workflowTemplateOperatorLabel(scheduleTaskRepairReadback.taskTypeKey)
                        : t('workflowRuns.runsModule.taskRoutingSaved')}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.queue')}</span>
                    <div>
                      {scheduleTaskRepairReadback.queueKey
                        ? workflowTemplateOperatorLabel(scheduleTaskRepairReadback.queueKey)
                        : t('workflowRuns.runsModule.defaultRouting')}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.prioritySla')}</span>
                    <div>
                      {scheduleTaskRepairReadback.priority ?? t('workflowRuns.runsModule.defaultPriority')} /{' '}
                      {scheduleTaskRepairReadback.slaMinutes ?? t('workflowRuns.runsModule.defaultSla')}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.operation')}</span>
                    <div>
                      {scheduleTaskRepairReadback.operationName
                        ? workflowTemplateOperatorLabel(scheduleTaskRepairReadback.operationName)
                        : t('workflowRuns.runsModule.repairApplied')}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.updated')}</span>
                    <div>{workflowRunDateLabel(scheduleTaskRepairReadback.updatedAt)}</div>
                  </div>
                </div>
                <div
                  role="status"
                  style={{
                    border: '1px solid var(--success-line, var(--line))',
                    borderRadius: '6px',
                    padding: '8px',
                    color: 'var(--success, var(--ink-1))',
                    background: 'var(--success-bg, rgba(22, 163, 74, 0.08))',
                  }}
                >
                  {t('workflowRuns.runsModule.savedTaskDetailsAre')}
                </div>
              </section>
            ) : null}
            {scheduleRunNowReadback ? (
              <section
                data-testid="workflow-schedule-run-now-readback"
                aria-label={t('workflowRuns.runsModule.workflowScheduleRunNow')}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  background: 'var(--panel)',
                  padding: '12px',
                  marginBottom: '12px',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.runNowResult')}</div>
                    <strong>{scheduleRunNowReadback.templateLabel}</strong>
                  </div>
                  {activeScheduleRunNowStatus === 'preflight_failed' ? (
                    <Chip label={t('workflowRuns.runsModule.setupCheckFailed')} kind="danger" size="xs" />
                  ) : activeScheduleRunNowStatus ? (() => {
                    const resolved = statusTone('workflow_run_status', activeScheduleRunNowStatus);
                    return resolved.tone && resolved.label ? (
                      <Chip label={resolved.label} kind={resolved.tone} size="xs" />
                    ) : (
                      <Chip label={t('workflowRuns.runsModule.statusLabelIsNot')} kind="danger" size="xs" />
                    );
                  })() : (
                    <Chip label={t('workflowRuns.runsModule.waitingForSavedData')} kind="info" size="xs" />
                  )}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '8px',
                    fontSize: '12px',
                  }}
                >
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.schedule')}</span>
                    <div>{t('workflowRuns.runsModule.queued')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.workflowRun')}</span>
                    <div>{scheduleRunNowReadback.workflowRunId ? t('workflowRuns.runsModule.started') : t('workflowRuns.runsModule.waitingForSavedData')}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.lastRun')}</span>
                    <div>{workflowRunDateLabel(activeScheduleRunNowLastRunAt)}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--ink-3)' }}>{t('workflowRuns.runsModule.requested')}</span>
                    <div>{workflowRunDateLabel(scheduleRunNowReadback.requestedAt)}</div>
                  </div>
                </div>
                {activeScheduleRunNowError ? (
                  <div
                    role="status"
                    style={{
                      border: '1px solid var(--danger-line, var(--line))',
                      borderRadius: '6px',
                      padding: '8px',
                      color: 'var(--danger, var(--ink-1))',
                      background: 'var(--danger-bg, rgba(220, 38, 38, 0.08))',
                    }}
                  >
                    <strong>{t('workflowRuns.runsModule.runOutcome')}</strong> {t('workflowRuns.runsModule.theRunNeedsAttention')}
                  </div>
                ) : null}
              </section>
            ) : null}
            <DataTable<WorkflowScheduleTrigger>
              columns={SCHEDULE_COLUMNS}
              rows={schedulesQuery.data?.rows ?? []}
              viewKey="workflow_schedule_triggers"
              entityKind="workflow_schedule_trigger"
              rowActions={SCHEDULE_ROW_ACTIONS}
            />
          </>
        )
      ) : null}
      {drawer.node}
      {modal.node}
      {/* Hidden helper kept to silence unused warning if Dot becomes orphaned. */}
      <span style={{ display: 'none' }}>
        <Dot kind="neutral" />
      </span>
    </div>
  );
}

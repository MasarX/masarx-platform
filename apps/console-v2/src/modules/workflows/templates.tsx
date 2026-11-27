// workflows/templates.tsx — Workflow Studio (3-pane: palette + bezier canvas + tabbed inspector).
// Ports apps/console/demo-v2/assets/js/modules/wf-template-studio.js to TypeScript/React.
//
// Backed by canonical RPCs (verified in supabase/migrations/**):
//   • workflow_templates / workflow_template_steps / mapping_configs / workflow_bindings /
//     recent_workflow_events  — read via ui_list_resource_v1
//   • operation_templates                              — read via ui_list_resource_v1
//   • public.start_workflow_run(uuid, jsonb) RETURNS uuid
//   • public.progress_workflow_run(uuid, jsonb) RETURNS jsonb
//       Operator action variants (manual_override, retry, etc.) ride through the
//       same RPC via the jsonb `action` key — no dedicated `_manual_override` /
//       `_reopen_pending` functions exist.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CAP } from "@/lib/capabilities";
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { Button, type ButtonKind } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { Dot } from '@/components/Dot';
import { Icon } from '@/components/Icon';
import { buildDecisionTrailDrawerSpec } from '@/components/decisionTrail';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal, usePalette } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useCreateWorkflowTemplate,
  useSetWorkflowTemplateStatus,
  useRestoreWorkflowTemplateVersion,
  useCreateWorkflowTemplateStep,
  useUpdateWorkflowTemplateStep,
  useDuplicateWorkflowTemplateStep,
  useDeleteWorkflowTemplateStep,
  useResolveSettings,
  refreshWorkflowRunReadModels,
  useStartWorkflowRun,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';
import { fill, useI18n } from '@/lib/i18n';
import {
  discoverFields,
  inferType,
  operatorsFor,
  toJsonLogic,
  type ConditionGroup,
  type Operator,
  valueSamples,
} from '@/modules/workflows/_bindings/condition-model';
// W70 (Workflows Cycle F-R-10 P2-1) — canonical "time ago" formatter
// reuses `ui_presentation_policy.duration_buckets`. Replaces the inline
// `fmtTimeAgo` ladder that hardcoded 60000/3600000/86400000 thresholds.
import {
  formatTimeAgoCanonical,
  type DurationFormatPolicy,
} from '@/modules/workflows/_review-queue/views';

// Cycle E (Workflows P2 #7) — canvas layout budget shape used by Canvas
// + InspectorTab consumers. Resolved canonically through
// `useResolveSettings('ui_presentation_policy').workflow_canvas_layout`.
// Strict no-fallback: when the canonical row is absent the consumer
// renders a danger StateView (no silent FE-literal default).
interface WorkflowCanvasLayout {
  node_w: number;
  node_h: number;
  col_gap: number;
  row_gap: number;
  test_trace_max_width: number;
  test_trace_divisor: number;
  test_trace_default_height_px: number;
  // W70 (Workflows Cycle F-R-10 P2-2) — canvas SVG bbox budget. Replaces
  // the inline `+ 60` (right-edge gutter on the rightmost node) and
  // `: 400` (zero-state canvas width) literals in `Canvas#maxX`.
  workflow_canvas_node_right_gutter_px: number;
  workflow_canvas_empty_width_px: number;
}

// Wave 10 schema-drift close-out (W10-6) + W16-3 verification + W19-3 cascade
// closure — see __audit__/SCHEMA-DRIFT/WORKFLOWS.md (§§ 1, 2, 3, 6 + W10-6 /
// W16-3 / W19-3 closure notes).
//
// W19-3 cascade closure status (2026-04-27): all 5 W10-6-deferred cascade
// items in templates.tsx scope have been re-verified against canonical
// SSOT and explicitly annotated either as `// SSOT: projection` (joined or
// computed at the BE) or `// SSOT: display alias` (FE-fabricated for UX),
// with the production-swap path documented inline. The drops and renames
// remain deferred until the RPC contract switch lands; the row shapes here
// are stable production-target projections, not fictional drift.
//
// W19-3 cascade items closed (templates.tsx scope):
//   1. WorkflowTemplate.template_id   — display alias (FE-fabricated TPL-* code)
//   2. WorkflowTemplate.trigger       — projection (workflow_bindings_registry.entrypoint_type)
//   3. WorkflowTemplate.versions      — projection (workflow_templates version history)
//   4. WorkflowTemplateStep.{icon,sub,label,error_path,manual_path}
//                                     — projection (metadata.* + condition_jsonlogic branches)
//   5. RecentEvent.matched_template   — projection (webhook_rules → workflow_templates join)
//
// Drops applied (W10-6, kept):
//   - WorkflowTemplate.author       — never displayed; resolve via users join when needed
//   - WorkflowTemplate.updated_at   — never displayed; canonical has published_at
// Drops deferred (consumer cascade > W10/W19 scope; promotion to canonical
// column names lands with the RPC-contract switch):
//   - WorkflowTemplate.template_id  — used as display label across studio UI
//   - WorkflowTemplate.trigger      — used in studio search/filter + composer
//   - WorkflowTemplate.versions     — used by version menu + diff modal
//   - WorkflowTemplateStep.icon/sub/label/error_path/manual_path — display-only
//   - WorkflowRun.run_id            — used as primary display + tested
//   - WorkflowRun.duration_ms       — used in Gantt + history rows
//   - RecentEvent.matched_template  — used by trigger composer match indicator
// Renames deferred (consumer cascade + seed update > W10/W19 scope):
//   - WorkflowRun.status            -> workflow_status (RPC contract switch only)
//   - WorkflowRun.template_id       -> workflow_template_id (RPC contract switch)
//   - WorkflowTemplateStep.op       -> operation_name
//   - RecentEvent.event             -> event_type
//   - RecentEvent.received_at       -> occurred_at
interface WorkflowTemplateStep extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_template_steps.id
  workflow_template_id?: string;       // SSOT: workflow_template_steps.workflow_template_id
  sequence_order?: number;             // SSOT: workflow_template_steps.sequence_order
  kind: string;                       // SSOT: projection — metadata.kind
  label: string;                      // SSOT: projection — metadata.label
  sub?: string;                       // SSOT: projection — metadata.sub
  op?: string;                        // SSOT: workflow_template_steps.operation_name (RENAME deferred — heavy consumer cascade)
  icon?: string;                      // SSOT: projection — metadata.icon (display-only)
  branch?: string;                    // SSOT: projection — derived from condition_jsonlogic + next_operation_name
  error_path?: string;                // SSOT: projection — computed via condition_jsonlogic error branch
  manual_path?: string;               // SSOT: workflow_template_steps.manual_action_required (RENAME deferred — semantics differ)
  condition_jsonlogic?: Record<string, unknown> | null; // SSOT: workflow_template_steps.condition_jsonlogic
  metadata?: Record<string, unknown> | null;            // SSOT: workflow_template_steps.metadata
}

interface WorkflowTemplateStepRow extends Record<string, unknown> {
  id: string;
  workflow_template_id?: string;
  sequence_order?: number | string | null;
  operation_name?: string | null;
  operation_settings_category?: string | null;
  condition_jsonlogic?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

interface WorkflowTemplate extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_templates.id
  template_id: string;                // SSOT: display alias (FE-fabricated TPL-* code; not on canonical schema)
  name: string;                       // SSOT: workflow_templates.name
  version: string;                    // SSOT: workflow_templates.version (canonical: integer)
  status: string;                     // SSOT: workflow_templates.status
  trigger: string;                    // SSOT: projection — workflow_bindings_registry.entrypoint_type or webhook_rules
  // W10-6: dropped `author` and `updated_at` — never displayed in studio UI.
  versions?: string[];                // SSOT: projection — historical version list
  steps?: WorkflowTemplateStep[];     // SSOT: projection — workflow_template_steps[] joined separately
}

interface WorkflowRun extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_runs.id
  run_id?: string;                    // SSOT: display alias (projection-only WFR-* code)
  template_id: string;                // SSOT: workflow_runs.workflow_template_id (RENAME deferred — RPC contract switch)
  workflow_template_id?: string;
  status: string;                     // SSOT: workflow_runs.workflow_status (RENAME deferred — RPC contract switch)
  workflow_status?: string;
  started_at: string;                 // SSOT: workflow_runs.started_at
  duration_ms?: number | null;        // SSOT: projection — `completed_at - started_at`
}

// W54-A — canonical projection over `workflow_run_steps` consumed by the
// Canvas step status overlay. Uses `useResourceList<WorkflowRunStepRow>(
// 'workflow_run_steps', { filter: { workflow_run_id }})` so the canvas
// reflects real per-step lifecycle (pending/running/succeeded/failed/...).
// `step_status` is the canonical column; `status` is retained as a legacy
// projection alias because the seed currently uses that key.
interface WorkflowRunStepRow extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_run_steps.id
  step_id: string;                    // SSOT: workflow_run_steps.step_id
  status?: string;                    // SSOT: legacy seed projection alias for step_status
  step_status?: string;               // SSOT: workflow_run_steps.step_status
  duration_ms?: number | null;        // SSOT: workflow_run_steps.duration_ms
}

interface RecentEvent extends Record<string, unknown> {
  id: string;                         // SSOT: domain_events.id
  event: string;                      // SSOT: domain_events.event_type (RENAME deferred — RPC contract switch)
  received_at: string;                // SSOT: domain_events.occurred_at (RENAME deferred — RPC contract switch)
  payload: Record<string, unknown>;   // SSOT: domain_events.payload
  matched_template?: string;          // SSOT: projection — computed via webhook_rules -> workflow_templates join
}

// W22 — paired projection view `public.v_workflow_template_directory`
// (read-only). Surfaces canonical workflow_templates columns AND derived
// counter projections (step_count, active_run_count, total_run_count,
// last_run_at, last_run_status, binding_count, is_published) plus the FE
// display alias template_id (TPL-*-V*). The studio palette consumes this
// projection additively for per-template counters so the existing
// `lastRunByTemplate` Map can be replaced over time without disturbing
// the canvas / inspector callsites that already read the legacy seed
// shape. See supabase/migrations/202604302110_v_workflow_template_directory.sql.
interface WorkflowTemplateDirectoryRow extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_templates.id
  workflow_template_id: string;       // canonical alias
  template_id: string | null;         // SSOT: display alias (TPL-*-V*)
  name: string | null;
  version: string | number | null;
  status: string | null;
  step_count: number;                 // SSOT: projection — count of workflow_template_steps
  active_run_count: number;           // SSOT: projection — runs with workflow_status IN (pending,in_progress,running,queued)
  total_run_count: number;            // SSOT: projection — total run count
  last_run_at: string | null;         // SSOT: projection — MAX(workflow_runs.created_at)
  last_run_status: string | null;     // SSOT: projection — workflow_status of most recent run
  binding_count: number;              // SSOT: projection — count of workflow_binding_dispatches per template
  is_published: boolean;              // SSOT: projection — status='active' AND published_at IS NOT NULL
}

type WorkflowTemplatePromotionReadbackKind = 'create' | 'publish' | 'status';

interface WorkflowTemplatePromotionReadback {
  kind: WorkflowTemplatePromotionReadbackKind;
  templateId: string;
  templateLabel: string;
  sourceTemplateId?: string | null;
  expectedStatus?: string | null;
  expectedStepCount?: number | null;
  correlationId?: string | null;
  requestedAt: string;
}

interface WorkflowTemplateRestoreReadback {
  templateId: string;
  templateLabel: string;
  sourceTemplateId: string;
  sourceVersion?: string | null;
  restoredVersion?: string | null;
  restoredStepCount?: number | null;
  correlationId?: string | null;
  requestedAt: string;
}

interface WorkflowTemplateStepActionReadback {
  actionLabel: string;
  templateId: string;
  templateLabel: string;
  stepId: string;
  stepLabel: string;
  requestedAt: string;
  metadata: Record<string, unknown>;
}

type InspectorTab = 'config' | 'inputs' | 'outputs' | 'test' | 'history';

interface ValidationIssue {
  stepId: string | null;
  msg: string;
}

// Strict canonical resolver — `workflow_step_kind` lookup_values.metadata.tone
// is the SSOT for step-kind chip presentation. Missing canonical row returns
// `{ tone: null, label: null }` so callsites render an explicit
// danger-toned `(missing)` chip instead of silently masking the gap with a
// neutral default. See AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
function kindTone(k: string): { tone: ChipKind | null; label: string | null } {
  const row = lookupRow('workflow_step_kind', k);
  return {
    tone: (row?.tone as ChipKind | undefined) ?? null,
    label: row?.label ?? null,
  };
}

function resolveDefaultWorkflowBranchKind(): string {
  const rows = api.getLookups('workflow_branch_kind') as Array<{
    value: string;
    is_default?: boolean;
    metadata?: { lane_index?: number; is_default?: boolean };
  }>;
  return (
    rows.find((r) => r.is_default === true || r.metadata?.is_default === true)?.value
    ?? rows.find((r) => r.metadata?.lane_index === 0)?.value
    ?? ''
  );
}

function resolveErrorWorkflowBranchKind(): string {
  const rows = api.getLookups('workflow_branch_kind') as Array<{
    value: string;
    metadata?: { is_error_branch?: boolean };
  }>;
  return rows.find((r) => r.metadata?.is_error_branch === true)?.value ?? '';
}

function toWorkflowStepRpcPatch(
  patch: Partial<WorkflowTemplateStep>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const nextValue = value === undefined ? null : value;
    if (key === 'op') {
      out.operation_name = nextValue;
    } else {
      out[key] = nextValue;
    }
  }
  return out;
}

function compactReferenceText(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '—';
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function workflowTemplatePublishCloneName(template: Pick<WorkflowTemplate, 'id' | 'name' | 'template_id'>): string {
  const base =
    stringValue(template.name)
    ?? stringValue(template.template_id)
    ?? compactReferenceText(template.id);
  const suffix = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${compactReferenceText(template.id)}`;
  return `${base} copy ${suffix}`.slice(0, 240);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function workflowTemplateSourceCandidate(
  template: WorkflowTemplate,
  templates: WorkflowTemplate[],
): { id: string; version?: string | null; name?: string | null } | null {
  const metadata = recordValue(template.metadata);
  const sourceId = stringValue(metadata.source_template_id)
    ?? stringValue(metadata.restored_from_template_id);
  if (sourceId) {
    const source = templates.find((candidate) => candidate.id === sourceId);
    return {
      id: sourceId,
      version: source?.version ?? stringValue(metadata.source_version) ?? stringValue(metadata.restored_from_version) ?? null,
      name: source?.name ?? stringValue(metadata.source_template_name) ?? null,
    };
  }
  const versions = template.versions ?? [];
  const priorVersion = versions.find((version) => version !== template.version);
  if (!priorVersion) return null;
  const source = templates.find((candidate) =>
    candidate.id !== template.id
    && candidate.name === template.name
    && candidate.version === priorVersion,
  );
  return source ? { id: source.id, version: source.version, name: source.name } : null;
}

function compactReference(raw: unknown): ReactNode {
  const value = String(raw ?? '').trim();
  if (!value) return '—';
  return (
    <span className="mono" title={value}>
      {compactReferenceText(value)}
    </span>
  );
}

function displayLookupLabel(category: string, value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  return lookupRow(category, raw)?.label ?? compactReferenceText(raw);
}

function displayWorkflowEventLabel(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  return lookupRow('workflow_binding_event', raw)?.label ?? titleFromToken(raw) ?? compactReferenceText(raw);
}

function buttonKindFromLookup(raw: unknown): ButtonKind | null {
  return raw === 'primary' || raw === 'ghost' || raw === 'danger' ? raw : null;
}

function missingSetupLabel(label: string, raw: unknown): string {
  const value = compactReferenceText(raw);
  return value === '—' ? label : `${label} (${value})`;
}

// W70 (Workflows Cycle F-R-10 P2-1) — strict canonical "time ago"
// formatter. The previous inline ladder hardcoded 60000/3600000/86400000
// ms thresholds + the `'s ago'/'m ago'/'h ago'/'d ago'` literals,
// duplicating the bucket ladder already published in
// `ui_presentation_policy.duration_buckets` (sv_360). The policy-driven
// helper `formatTimeAgoCanonical` lives in `_review-queue/views.ts` and
// is imported above. Strict no-fallback: when the canonical row is
// missing (`policy === null`), the helper returns `'—'` so the gap
// surfaces visibly. AGENTS.md §2 (ZERO HARDCODING) + §2 (ZERO REDUNDANCY)
// + §4 (SSOT) + §6 (row-driven by configuration).
function fmtTimeAgo(
  iso: string,
  policy: DurationFormatPolicy | null | undefined,
): string {
  const ms = Date.now() - new Date(iso).getTime();
  return formatTimeAgoCanonical(ms, policy);
}

type TriggerConditionDraft = {
  field: string;
  operator: Operator | '';
  value: string;
};

function defaultTriggerCondition(events: RecentEvent[]): TriggerConditionDraft {
  const field = discoverFields(events)[0] ?? '';
  const samples = field ? valueSamples(field, events) : [];
  const operator = operatorsFor(inferType(samples))[0] ?? '';
  return { field, operator, value: '' };
}

function operatorOptionsForField(field: string, events: RecentEvent[]): Operator[] {
  if (!field) return [];
  return operatorsFor(inferType(valueSamples(field, events)));
}

function triggerDraftsToConditionNode(conditions: TriggerConditionDraft[]): ConditionGroup {
  return {
    kind: 'group',
    combinator: 'and',
    children: conditions
      .filter((condition) => condition.field && condition.operator)
      .map((condition) => ({
        kind: 'leaf',
        field: condition.field,
        op: condition.operator as Operator,
        value: condition.value,
      })),
  };
}

function triggerDraftsToJsonLogic(
  conditions: TriggerConditionDraft[],
): Record<string, unknown> | null {
  const node = triggerDraftsToConditionNode(conditions);
  if (node.children.length === 0) return null;
  const jsonLogic = toJsonLogic(node);
  return jsonLogic && typeof jsonLogic === 'object'
    ? (jsonLogic as Record<string, unknown>)
    : null;
}

function isTriggerStep(step: WorkflowTemplateStep): boolean {
  const metadata = lookupRow('workflow_step_kind', step.kind)?.metadata as
    | { is_trigger?: boolean }
    | undefined;
  return metadata?.is_trigger === true;
}

function isTriggerOperation(op: api.OperationTemplate): boolean {
  const metadata = lookupRow('workflow_step_kind', op.kind)?.metadata as
    | { is_trigger?: boolean }
    | undefined;
  return metadata?.is_trigger === true;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isUuidText(value: string | undefined): boolean {
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function workflowBindingDisplayName(metadata: Record<string, unknown>): string | undefined {
  const binding = titleFromToken(stringValue(metadata.binding_key));
  const stage = titleFromToken(stringValue(metadata.stage_key));
  if (binding && stage) return `${binding} - ${stage}`;
  return binding ?? stage;
}

function workflowTemplateOperatorName(row: WorkflowTemplate, metadata: Record<string, unknown>): string {
  const bindingName = workflowBindingDisplayName(metadata);
  if (bindingName) return bindingName;
  const sourceTemplate = stringValue(metadata.source_template_name);
  if (sourceTemplate?.startsWith('workflow_binding.')) {
    const [, binding, stage] = sourceTemplate.split('.');
    const sourceName = workflowBindingDisplayName({ binding_key: binding, stage_key: stage });
    if (sourceName) return sourceName;
  }
  return stringValue(row.description) ?? stringValue(row.name) ?? stringValue(row.template_id) ?? row.id;
}

function workflowTemplateDisplayCode(row: WorkflowTemplate, metadata: Record<string, unknown>, fallback: string): string {
  const templateKey = stringValue(row.template_key);
  const rawTemplateId = stringValue(row.template_id);
  const sourceVersion = stringValue(metadata.source_version) ?? String(row.version ?? '').trim();
  const scopeType = stringValue(row.scope_type) ?? stringValue(metadata.bootstrap_scope_type);
  if (templateKey && !templateKey.startsWith('workflow_binding.')) return templateKey;
  if (rawTemplateId && !rawTemplateId.startsWith('workflow_binding.')) return rawTemplateId;
  const stage = titleFromToken(stringValue(metadata.stage_key));
  const scopeLabel = titleFromToken(scopeType);
  const parts = [stage ? `${stage} flow` : 'Workflow', scopeLabel, sourceVersion ? `v${sourceVersion}` : '']
    .filter(Boolean);
  return parts.join(' - ') || fallback;
}

function isWorkflowTemplateVisibleForTenant(template: WorkflowTemplate, tenantId: string | undefined): boolean {
  if (!tenantId) return true;
  const scopeType = stringValue(template.scope_type);
  const scopeId = stringValue(template.scope_id);
  const metadata = recordValue(template.metadata);
  const bootstrapScopeId = stringValue(metadata.bootstrap_scope_id);
  if (!scopeId && !bootstrapScopeId) return true;
  if (scopeType === 'global') return true;
  return scopeId === tenantId || bootstrapScopeId === tenantId;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function fallbackStepKind(): string {
  const rows = api.getLookups('workflow_step_kind') as Array<{
    value: string;
    metadata?: { tone?: string };
  }>;
  const actionRow = rows.find((row) => row.value === 'action');
  return actionRow?.value ?? rows[0]?.value ?? 'step';
}

function normalizeWorkflowTemplateStepRow(
  row: WorkflowTemplateStepRow,
  fallbackWorkflowTemplateId?: string,
): WorkflowTemplateStep | null {
  const id = stringValue(row.id);
  const workflowTemplateId = stringValue(row.workflow_template_id) ?? fallbackWorkflowTemplateId;
  if (!id || !workflowTemplateId) return null;
  const metadata = recordValue(row.metadata);
  const operationName = stringValue(row.operation_name) ?? stringValue(row.op);
  const operationSettings = stringValue(row.operation_settings_category);
  const sequenceOrder = numberValue(row.sequence_order);
  const kind = stringValue(metadata.kind) ?? stringValue(row.kind) ?? fallbackStepKind();
  const label =
    stringValue(metadata.label) ??
    stringValue(row.label) ??
    operationName ??
    `Step ${sequenceOrder ?? id.slice(0, 8)}`;
  const sub = stringValue(metadata.sub) ?? operationSettings ?? operationName;
  return {
    ...row,
    id,
    workflow_template_id: workflowTemplateId,
    sequence_order: sequenceOrder,
    kind,
    label,
    sub,
    op: operationName,
    icon: stringValue(metadata.icon) ?? stringValue(row.icon),
    branch: stringValue(metadata.branch) ?? stringValue(row.branch),
    error_path: stringValue(metadata.error_path) ?? stringValue(row.error_path),
    manual_path: stringValue(metadata.manual_path) ?? stringValue(row.manual_path),
    condition_jsonlogic: row.condition_jsonlogic ?? null,
    metadata,
  };
}

function normalizeWorkflowTemplateRow(row: WorkflowTemplate): WorkflowTemplate {
  const metadata = recordValue(row.metadata);
  const rawTemplateId =
    stringValue(row.template_id) ??
    stringValue(row.template_key) ??
    stringValue(row.name) ??
    row.id;
  const trigger =
    stringValue(row.trigger) ??
    stringValue(metadata.trigger_event) ??
    stringValue(metadata.binding_key) ??
    stringValue(metadata.source_template_name) ??
    rawTemplateId;
  const version = String(row.version ?? '');
  const rawVersions = Array.isArray(row.versions) ? row.versions : [];
  const versions = rawVersions.map((value) => String(value)).filter(Boolean);
  const steps = Array.isArray(row.steps)
    ? row.steps
        .map((step) => normalizeWorkflowTemplateStepRow(step as WorkflowTemplateStepRow, row.id))
        .filter((step): step is WorkflowTemplateStep => step !== null)
    : [];
  const name = workflowTemplateOperatorName(row, metadata);
  const templateId = workflowTemplateDisplayCode(row, metadata, rawTemplateId);
  return {
    ...row,
    name,
    template_id: templateId,
    trigger,
    version,
    versions: versions.length > 0 ? versions : [version],
    steps,
  };
}

function workflowRunTemplateId(row: WorkflowRun): string | null {
  return stringValue(row.workflow_template_id) ?? stringValue(row.template_id) ?? null;
}

function workflowRunStatus(row: WorkflowRun): string {
  return stringValue(row.workflow_status) ?? stringValue(row.status) ?? 'unknown';
}

function workflowRunDisplayId(row: WorkflowRun): string {
  return stringValue(row.run_id) ?? stringValue(row.id) ?? 'unknown';
}

function TriggerComposerPreview({
  template,
  events,
  durationFormatPolicy,
  onSave,
}: {
  template: WorkflowTemplate;
  events: RecentEvent[];
  durationFormatPolicy: DurationFormatPolicy | null;
  onSave: (draft: {
    triggerEvent: string;
    conditions: TriggerConditionDraft[];
    conditionJsonLogic: Record<string, unknown> | null;
  }) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const fieldOptions = useMemo(() => discoverFields(events), [events]);
  const [triggerEvent, setTriggerEvent] = useState(template.trigger);
  const [conditions, setConditions] = useState<TriggerConditionDraft[]>(() => [
    defaultTriggerCondition(events),
  ]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const addCondition = () => {
    setConditions((current) => [...current, defaultTriggerCondition(events)]);
  };

  const updateCondition = (index: number, patch: Partial<TriggerConditionDraft>) => {
    setConditions((current) =>
      current.map((condition, i) => {
        if (i !== index) return condition;
        if (patch.field !== undefined && patch.field !== condition.field) {
          const nextOperators = operatorOptionsForField(patch.field, events);
          return {
            ...condition,
            ...patch,
            operator: nextOperators[0] ?? '',
          };
        }
        return { ...condition, ...patch };
      }),
    );
  };

  const removeCondition = (index: number) => {
    setConditions((current) => current.filter((_, i) => i !== index));
  };

  const saveTrigger = async () => {
    setSaveState('saving');
    const ok = await onSave({
      triggerEvent,
      conditions,
      conditionJsonLogic: triggerDraftsToJsonLogic(conditions),
    });
    if (ok) {
      setSaveState('saved');
      pushToast(t('workflowTemplates.trigger.saved'), 'good');
    } else {
      setSaveState('failed');
    }
  };

  return (
    <div>
      <p className="state__hint">
        {t('workflowTemplates.trigger.intro')}
      </p>
      <div className="wf-trigger-rule">
        <select
          className="dt-inline-input"
          value={triggerEvent}
          onChange={(e) => setTriggerEvent(e.target.value)}
          aria-label={t('workflowTemplates.trigger.eventAria')}
        >
          {api.getLookups('workflow_binding_event').map((row) => (
            <option key={String(row.value)} value={String(row.value)}>
              {String(row.label ?? row.value)}
            </option>
          ))}
        </select>
      </div>
      <div className="wf-insp__section-eyebrow" style={{ marginTop: '12px' }}>
        {t('workflowTemplates.trigger.conditionsHeading')}
      </div>
      {conditions.length === 0 ? (
        <StateView
          kind="empty"
          title={t('workflowTemplates.trigger.noConditionsTitle')}
          hint={t('workflowTemplates.trigger.noConditionsHint')}
        />
      ) : (
        conditions.map((condition, index) => {
          const operatorOptions = operatorOptionsForField(condition.field, events);
          return (
            <div className="wf-trigger-cond" key={`${condition.field}-${index}`}>
              <select
                className="dt-inline-input"
                value={condition.field}
                onChange={(e) => updateCondition(index, { field: e.target.value })}
                aria-label={t('workflowTemplates.trigger.fieldAria')}
              >
                {fieldOptions.length === 0 ? (
                  <option value="">{t('workflowTemplates.trigger.noFields')}</option>
                ) : (
                  fieldOptions.map((f) => <option key={f}>{f}</option>)
                )}
              </select>
              <select
                className="dt-inline-input"
                value={condition.operator}
                onChange={(e) => updateCondition(index, { operator: e.target.value as Operator | '' })}
                aria-label={t('workflowTemplates.trigger.operatorAria')}
              >
                {operatorOptions.map((o) => (
                  <option key={o} value={o}>
                    {o.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              <input
                className="dt-inline-input"
                type="text"
                placeholder={t('workflowTemplates.trigger.valuePlaceholder')}
                value={condition.value}
                onChange={(e) => updateCondition(index, { value: e.target.value })}
                aria-label={t('workflowTemplates.trigger.valueAria')}
              />
              <button
                type="button"
                className="icon-btn"
                title={t('workflowTemplates.trigger.removeTitle')}
                aria-label={t('workflowTemplates.trigger.removeAria')}
                onClick={() => removeCondition(index)}
              >
                ×
              </button>
            </div>
          );
        })
      )}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        style={{ marginTop: '6px' }}
        onClick={addCondition}
        disabled={fieldOptions.length === 0}
      >
        {t('workflowTemplates.trigger.addCondition')}
      </button>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
        <Button
          label={t('workflowTemplates.trigger.apply')}
          iconName="save"
          kind="primary"
          capability={CAP.WORKFLOWS_WRITE}
          disabled={saveState === 'saving'}
          onClick={saveTrigger}
        />
        {saveState !== 'idle' ? (
          <span className="state__hint" role="status">
            {saveState === 'saving'
              ? t('workflowTemplates.trigger.saving')
              : saveState === 'saved'
                ? t('workflowTemplates.trigger.saved')
                : t('workflowTemplates.trigger.notSaved')}
          </span>
        ) : null}
      </div>
      <div className="wf-insp__section-eyebrow" style={{ marginTop: '14px' }}>
        {t('workflowTemplates.trigger.testHeading')}
      </div>
      <div className="wf-recent-events">
        {events.slice(0, 4).map((e) => (
          <div key={e.id} className="wf-recent-event-row">
            <Dot
              kind={e.matched_template === template.id ? 'good' : 'neutral'}
            />
            <span className="mono" style={{ width: '120px' }}>
              {compactReference(e.id)}
            </span>
            <span style={{ flex: 1 }}>{displayLookupLabel('workflow_binding_event', e.event)}</span>
            <span
              className="mono"
              style={{ fontSize: '11px', color: 'var(--ink-3)' }}
            >
              {fmtTimeAgo(e.received_at, durationFormatPolicy)}
            </span>
            <Chip
              label={e.matched_template === template.id ? t('workflowTemplates.trigger.matches') : t('workflowTemplates.trigger.noMatch')}
              kind={e.matched_template === template.id ? 'good' : 'neutral'}
              size="xs"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// Cycle E (Workflows P1 #1) — `sampleOutputForOp` removed. The synthetic
// op-prefix-keyed schema/sample matrix (with fictional customer ids
// EXAMPLEMARKET-99281, snd_examplemarket, +966..., shp_9381418) violated AGENTS.md §2
// (ZERO HARDCODING) + §4 (SSOT). The OutputsTab + InputsTab now resolve
// `output_schema` / `output_sample` strictly from the canonical
// `operation_templates` row (threaded through `opsCatalog`). When the
// canonical row has no projection the consumer renders a `<StateView
// kind="empty" hint="operation_templates.output_schema not yet projected"
// />` block instead of fabricating a synthetic shape.
function resolveOpOutput(
  op: string | undefined,
  opsCatalog: api.OperationTemplate[],
): { schema: Record<string, unknown> | null; sample: Record<string, unknown> | null } {
  if (!op) return { schema: null, sample: null };
  const row = opsCatalog.find((o) => o.operation_name === op);
  if (!row) return { schema: null, sample: null };
  return {
    schema: (row.output_schema as Record<string, unknown> | null | undefined) ?? null,
    sample: (row.output_sample as Record<string, unknown> | null | undefined) ?? null,
  };
}

interface TemplateCardProps {
  template: WorkflowTemplate;
  isActive: boolean;
  matchedRunsCount: number;
  lastRunStatus?: string;
  // W22 — derived counters from `v_workflow_template_directory` (additive).
  // When populated, these source from the canonical projection seam; when
  // null/undefined the legacy `matchedRunsCount` + `lastRunStatus` remain
  // the visible source so the studio keeps rendering during cutover.
  directoryRow?: WorkflowTemplateDirectoryRow | null;
  onClick: () => void;
}

function TemplateCard({ template, isActive, matchedRunsCount, lastRunStatus, directoryRow, onClick }: TemplateCardProps) {
  const { t } = useI18n();
  // W22 — when the canonical projection row is present, prefer its
  // counters (active_run_count + total_run_count + last_run_status)
  // over the legacy FE-side join. Falls back to FE-side counters on
  // first render before the projection query resolves.
  const totalRuns = directoryRow?.total_run_count ?? matchedRunsCount;
  const activeRuns = directoryRow?.active_run_count ?? null;
  const lastStatus = directoryRow?.last_run_status ?? lastRunStatus ?? null;
  // W27 Cycle D closure: lastDot resolves through the canonical
  // `workflow_run_status` lookup (tone metadata) rather than an inline
  // 4-branch matrix. The Dot kind taxonomy (good|warn|danger|neutral) is
  // a strict subset of the lookup tone vocabulary; `info` collapses to
  // `neutral` for the dot indicator. Missing canonical row produces a
  // fail-loud `danger` dot so the gap stays visible (AGENTS.md §2/§4).
  const lastStatusRow = lastStatus
    ? lookupRow('workflow_run_status', lastStatus)
    : null;
  const lastDot: 'good' | 'warn' | 'danger' | 'neutral' = !lastStatus
    ? 'neutral'
    : !lastStatusRow
      ? 'danger'
      : ((): 'good' | 'warn' | 'danger' | 'neutral' => {
          const tone = lastStatusRow.tone as string | undefined;
          if (tone === 'good' || tone === 'warn' || tone === 'danger' || tone === 'neutral') {
            return tone;
          }
          // info / other tones project onto neutral for the dot indicator.
          return 'neutral';
        })();
  return (
    <button
      type="button"
      className={`wf-tpl-card ${isActive ? 'is-active' : ''}`}
      onClick={onClick}
    >
      <div className="wf-tpl-card__row1">
        <span className="wf-tpl-card__name">{template.name}</span>
        {(() => {
          const row = lookupRow('workflow_status', template.status);
          if (!row) {
            return (
              <Chip
                label={missingSetupLabel(t('workflowTemplates.card.statusMissing'), template.status)}
                kind="danger"
                size="xs"
              />
            );
          }
          return (
            <Chip
              label={row.label ?? template.status}
              kind={(row.tone as ChipKind) ?? 'neutral'}
              size="xs"
            />
          );
        })()}
      </div>
      <div className="wf-tpl-card__row2 mono">
        {compactReference(template.template_id)}
        <span style={{ opacity: 0.5, margin: '0 4px' }}>·</span>
        <span>{template.version}</span>
      </div>
      <div className="wf-tpl-card__row3">
        <Chip label={displayWorkflowEventLabel(template.trigger)} kind="info" size="xs" />
        <span className="wf-tpl-card__runs mono">{fill(t('workflowTemplates.card.runs'), { count: totalRuns })}</span>
        {activeRuns !== null && activeRuns > 0 ? (
          <Chip label={fill(t('workflowTemplates.card.active'), { count: activeRuns })} kind="info" size="xs" />
        ) : null}
        {lastStatus ? <Dot kind={lastDot} title={fill(t('workflowTemplates.card.last'), { status: lastStatus })} /> : null}
      </div>
    </button>
  );
}

interface CanvasNodeProps {
  step: WorkflowTemplateStep;
  x: number;
  y: number;
  isActive: boolean;
  runStatus: string | null;
  onClick: () => void;
}

// Cycle E (Workflows P2 #7) — strict canvas-layout reader. Resolves
// the canonical `ui_presentation_policy.workflow_canvas_layout` row from
// the SettingsResolution payload threaded into Canvas. Returns `null`
// when the canonical row is missing/incomplete so the caller can render
// a fail-loud StateView instead of mounting the canvas with synthetic
// dimensions. The helper enforces positive, finite numeric values on
// every field (no NaN, no negative widths).
function readCanvasLayout(value: unknown): WorkflowCanvasLayout | null {
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, unknown>;
  const layout = root.workflow_canvas_layout as Record<string, unknown> | undefined;
  if (!layout) return null;
  const num = (k: string): number | null => {
    const v = layout[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    return v;
  };
  const node_w = num('node_w');
  const node_h = num('node_h');
  const col_gap = num('col_gap');
  const row_gap = num('row_gap');
  const test_trace_max_width = num('test_trace_max_width');
  const test_trace_divisor = num('test_trace_divisor');
  const test_trace_default_height_px = num('test_trace_default_height_px');
  // W70 (Workflows Cycle F-R-10 P2-2) — strict canvas bbox budgets.
  const workflow_canvas_node_right_gutter_px = num('workflow_canvas_node_right_gutter_px');
  const workflow_canvas_empty_width_px = num('workflow_canvas_empty_width_px');
  if (
    node_w === null ||
    node_h === null ||
    col_gap === null ||
    row_gap === null ||
    test_trace_max_width === null ||
    test_trace_divisor === null ||
    test_trace_default_height_px === null ||
    workflow_canvas_node_right_gutter_px === null ||
    workflow_canvas_empty_width_px === null
  ) {
    return null;
  }
  return {
    node_w,
    node_h,
    col_gap,
    row_gap,
    test_trace_max_width,
    test_trace_divisor,
    test_trace_default_height_px,
    workflow_canvas_node_right_gutter_px,
    workflow_canvas_empty_width_px,
  };
}

function CanvasNode({ step, x, y, isActive, runStatus, onClick }: CanvasNodeProps) {
  const { t } = useI18n();
  const classes = [
    'wf-node',
    `wf-node--${step.kind}`,
    isActive ? 'is-active' : '',
    runStatus ? `wf-node--rs-${runStatus}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style: CSSProperties = { left: `${x}px`, top: `${y}px` };
  const aria = runStatus
    ? fill(t('workflowTemplates.node.ariaLastRun'), { kind: step.kind, label: step.label, status: runStatus })
    : fill(t('workflowTemplates.node.aria'), { kind: step.kind, label: step.label });
  return (
    <button
      type="button"
      className={classes}
      style={style}
      onClick={onClick}
      data-step-id={step.id}
      aria-label={aria}
      aria-pressed={isActive}
    >
      <span className="wf-node__head">
        <span className="wf-node__icon">
          <Icon name={step.icon || 'package'} size={14} />
        </span>
        <span className="wf-node__kind mono">{step.kind}</span>
        {runStatus ? (
          <span
            className={`wf-node__pulse wf-node__pulse--${runStatus}`}
            title={fill(t('workflowTemplates.node.lastRun'), { status: runStatus })}
          />
        ) : null}
      </span>
      <span className="wf-node__title">{step.label}</span>
      <span className="wf-node__sub mono">{step.sub || step.op || ''}</span>
    </button>
  );
}

interface CanvasProps {
  template: WorkflowTemplate;
  activeStepId: string | null;
  lastRun?: WorkflowRun;
  onSelectStep: (id: string) => void;
  onAddFirstStep: () => void;
  isCreatingStep?: boolean;
  // Cycle E (Workflows P2 #7) — canonical layout budget threaded from
  // the parent module. `null` indicates the canonical row is not yet
  // resolved or has missing fields; the canvas renders a fail-loud
  // StateView in that case instead of mounting with synthetic constants.
  layout: WorkflowCanvasLayout | null;
}

function Canvas({
  template,
  activeStepId,
  lastRun,
  onSelectStep,
  onAddFirstStep,
  isCreatingStep,
  layout,
}: CanvasProps) {
  const { t } = useI18n();
  const steps = template.steps ?? [];

  // Cycle E2 (Workflows P1 #1) — `branchLanes` is row-driven from the
  // canonical `workflow_branch_kind` lookup. Each row's
  // `metadata.lane_index` projects the FE canvas vertical lane (main = 0,
  // error/manual = 1). Replaces the inline `Record<string, number>` literal
  // and the literal `stepsByBranch` initial keys. Missing canonical rows
  // mean the canvas falls through to the StateView gate below.
  const branchKindRows = api.getLookups('workflow_branch_kind') as Array<{
    value: string;
    is_default?: boolean;
    metadata?: { lane_index?: number; label?: string; is_keyboard_secondary?: boolean; is_default?: boolean };
  }>;
  // W77 (Workflows Cycle F-R-17 P1) — canonical default branch resolves
  // through `workflow_branch_kind` row `is_default: true` /
  // `metadata.is_default: true`. Replaces literal `|| 'main'` fallback at
  // step-branch defaulting (canvas lane assignment + edge resolution +
  // ConfigTab branch render). Mirrors the W75 workflow_step_kind / W76
  // task_priority is_default pattern (AGENTS.md §2 ZERO HARDCODING + §4
  // SSOT + §6 row-driven config). Missing canonical row → empty string
  // surfaces a fail-loud `(missing)` chip downstream via `lookupRow(...)`
  // returning null. The `lane_index === 0` fallback preserves backwards
  // compatibility with seeds that may not yet carry `is_default`.
  const defaultBranchKind =
    branchKindRows.find((r) => r.is_default === true || r.metadata?.is_default === true)?.value
      ?? branchKindRows.find((r) => r.metadata?.lane_index === 0)?.value
      ?? '';
  const branchLanes: Record<string, number> = {};
  const stepsByBranch: Record<string, WorkflowTemplateStep[]> = {};
  for (const row of branchKindRows) {
    if (typeof row.metadata?.lane_index === 'number') {
      branchLanes[row.value] = row.metadata.lane_index;
    }
    stepsByBranch[row.value] = [];
  }
  steps.forEach((s) => {
    const branch = s.branch ?? defaultBranchKind;
    if (!stepsByBranch[branch]) stepsByBranch[branch] = [];
    stepsByBranch[branch]!.push(s);
  });

  // W54-A — read canonical workflow_run_steps to project step_status by step_id.
  // This hook must run before fail-closed canvas returns so React hook order
  // stays stable while layout/lookup seeds are being repaired.
  const lastRunStepsQuery = useResourceList<WorkflowRunStepRow>(
    'workflow_run_steps',
    lastRun ? { filter: { workflow_run_id: lastRun.id } } : undefined,
    { enabled: !!lastRun }
  );

  // Cycle E2 (Workflows P1 #1) — fail loud when the canonical
  // `workflow_branch_kind` lookup is missing. Without canonical lane
  // metadata, the canvas would silently mis-place steps; keep behaviour
  // explicit by rendering a danger StateView instead of relying on FE
  // literals.
  if (!branchKindRows.length) {
    return (
      <div className="wf-canvas">
        <div style={{ padding: '24px' }}>
          <StateView
            kind="error"
            title={t('workflowTemplates.canvas.lanesTitle')}
            hint={t('workflowTemplates.canvas.lanesHint')}
          />
        </div>
      </div>
    );
  }

  // Cycle E (Workflows P2 #7) — strict no-fallback. When the canonical
  // layout policy is missing the canvas surface renders an explicit
  // danger StateView and emits zero edges/nodes (no ghost layout that
  // could confuse authors during a drift incident).
  if (!layout) {
    return (
      <div className="wf-canvas">
        <div style={{ padding: '24px' }}>
          <StateView
            kind="error"
            title={t('workflowTemplates.canvas.layoutTitle')}
            hint={t('workflowTemplates.canvas.layoutHint')}
          />
        </div>
      </div>
    );
  }
  const NODE_W = layout.node_w;
  const NODE_H = layout.node_h;
  const COL_GAP = layout.col_gap;
  const ROW_GAP = layout.row_gap;

  const xMap: Record<string, number> = {};
  // Cycle E2 (Workflows P1 #1) — primary lane (lane_index 0) is row-driven.
  // The canvas projects every step in the main lane onto its column
  // position; secondary-lane steps (error+manual etc., flagged via
  // `metadata.is_keyboard_secondary`) anchor off their parent.
  const primaryLaneBranches = branchKindRows
    .filter((r) => r.metadata?.lane_index === 0)
    .map((r) => r.value);
  const secondaryBranches = branchKindRows
    .filter((r) => r.metadata?.is_keyboard_secondary === true)
    .map((r) => r.value);
  for (const branchKey of primaryLaneBranches) {
    (stepsByBranch[branchKey] || []).forEach((s, i) => {
      xMap[s.id] = 24 + i * (NODE_W + COL_GAP);
    });
  }
  for (const branchKey of secondaryBranches) {
    (stepsByBranch[branchKey] || []).forEach((s) => {
      const parent = steps.find(
        (p) => p.error_path === s.id || p.manual_path === s.id
      );
      xMap[s.id] = parent ? (xMap[parent.id] || 24) + (NODE_W + COL_GAP) : 24;
    });
  }

  // Replaces the prior position-heuristic synthesis (i === steps.length - 2 etc.)
  // with canonical-first projection. While the resource is loading or before
  // workflow_run_steps materialize, render placeholder 'pending' instead of
  // fabricating succeeded/failed/skipped based on index position.
  // W68 (Workflows Cycle F-R-8 P1-4) — canonical placeholder step status
  // resolves through `workflow_run_status.<status>.metadata.is_placeholder`
  // (currently `pending`). Replaces literal `?? 'pending'` fallback so
  // adding a new "not yet materialized" placeholder is a single seed
  // update. Missing canonical row → empty string surfaces a fail-loud
  // `(missing)` chip via lookupRow returning null (W26 contract).
  const placeholderStepStatus =
    (api.getLookups('workflow_run_status') as Array<{ value: string; metadata?: { is_placeholder?: boolean } }> | undefined)
      ?.find((r) => r.metadata?.is_placeholder === true)?.value ?? '';

  const stepStatusMap: Record<string, string> = {};
  if (lastRun) {
    const liveRows = lastRunStepsQuery.data?.rows ?? [];
    if (liveRows.length) {
      const byStepId = new Map<string, string>();
      liveRows.forEach((r) => {
        const stepId = String(
          (r as Record<string, unknown>).step_id ?? (r as Record<string, unknown>).id ?? ''
        );
        const status = String(
          (r as Record<string, unknown>).status ??
            (r as Record<string, unknown>).step_status ??
            placeholderStepStatus
        );
        if (stepId) byStepId.set(stepId, status);
      });
      steps.forEach((s) => {
        stepStatusMap[s.id] = byStepId.get(s.id) ?? placeholderStepStatus;
      });
    } else {
      // Resource not yet loaded or steps not yet materialized — canonical placeholder.
      steps.forEach((s) => {
        stepStatusMap[s.id] = placeholderStepStatus;
      });
    }
  }

  // W70 (Workflows Cycle F-R-10 P2-2) — canvas bbox budget is row-driven
  // via `ui_presentation_policy.workflow_canvas_layout.{workflow_canvas_node_right_gutter_px,
  // workflow_canvas_empty_width_px}`. Replaces the inline `+ 60` /
  // `: 400` magic literals (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6
  // row-driven by configuration). The strict null-guarded `layout` reader
  // above ensures we only reach this line when both fields are present.
  const NODE_RIGHT_GUTTER = layout.workflow_canvas_node_right_gutter_px;
  const EMPTY_CANVAS_WIDTH = layout.workflow_canvas_empty_width_px;
  const maxX = steps.length
    ? Math.max(...steps.map((s) => (xMap[s.id] ?? 0) + NODE_W + NODE_RIGHT_GUTTER))
    : EMPTY_CANVAS_WIDTH;
  const maxY = 28 + 2 * (NODE_H + ROW_GAP) + NODE_H;

  // Build edges.
  // Cycle E2 (Workflows P1 #1) — edge construction iterates the canonical
  // primary-lane branches (lane_index === 0). The `error`/`manual` edge
  // kinds remain the canonical taxonomy keys consumed by `renderEdge` as
  // CSS classes; their human labels are resolved via
  // `workflow_branch_kind.metadata.label` inside `renderEdge`.
  const edges: ReactNode[] = [];
  for (const branchKey of primaryLaneBranches) {
    const lane = stepsByBranch[branchKey];
    if (!lane) continue;
    lane.forEach((step, i) => {
      const next = lane[i + 1];
      if (next) edges.push(...renderEdge(step.id, next.id, branchKey as 'main' | 'error' | 'manual'));
      if (step.error_path) edges.push(...renderEdge(step.id, step.error_path, 'error'));
      if (step.manual_path) edges.push(...renderEdge(step.id, step.manual_path, 'manual'));
    });
  }

  function renderEdge(fromId: string, toId: string, kind: 'main' | 'error' | 'manual'): ReactNode[] {
    const fromX = (xMap[fromId] ?? 0) + NODE_W;
    const toX = xMap[toId] ?? 0;
    const fromBranch = steps.find((s) => s.id === fromId)?.branch ?? defaultBranchKind;
    const toBranch = steps.find((s) => s.id === toId)?.branch ?? defaultBranchKind;
    const fromY = 28 + (branchLanes[fromBranch] ?? 0) * (NODE_H + ROW_GAP) + NODE_H / 2;
    const toY = 28 + (branchLanes[toBranch] ?? 0) * (NODE_H + ROW_GAP) + NODE_H / 2;
    const dx = (toX - fromX) * 0.5;
    const out: ReactNode[] = [];
    out.push(
      <path
        key={`${fromId}-${toId}-p`}
        d={`M ${fromX} ${fromY} C ${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`}
        className={`wf-edge wf-edge--${kind}`}
        fill="none"
      />
    );
    // W78 (Workflows Cycle F-R-18 P1) — non-default-branch edge label
    // gating resolves through the canonical `workflow_branch_kind` row's
    // `is_default` flag. Replaces the literal `kind !== 'main'` compare so
    // adding/renaming the canonical default branch is a single seed update
    // (mirrors the W77 default-branch resolution at templates.tsx:480-483
    // and templates.tsx:1013-1016). AGENTS.md §2 ZERO HARDCODING + §4 SSOT
    // + §6 row-driven config. Missing canonical row → treat as non-default
    // so the edge label still renders (loud render via the existing
    // `metadata.label ?? kind` projection inside the block).
    const kindRow = lookupRow('workflow_branch_kind', kind) as
      | { is_default?: boolean; metadata?: { is_default?: boolean } }
      | null;
    const isDefaultBranch =
      kindRow?.is_default === true || kindRow?.metadata?.is_default === true;
    if (!isDefaultBranch) {
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2 - 6;
      out.push(
        <rect
          key={`${fromId}-${toId}-bg`}
          x={midX - 22}
          y={midY - 8}
          width={44}
          height={14}
          rx={7}
          className={`wf-edge-label-bg wf-edge-label-bg--${kind}`}
        />
      );
      // Cycle E2 (Workflows P1 #1) — edge-mid-label resolves canonically
      // via `workflow_branch_kind.metadata.label`. Replaces the inline
      // `kind === 'error' ? 'on error' : 'manual'` literal. Missing
      // canonical row falls through to the kind key (loud rendering: the
      // operator sees the un-mapped key string instead of a fabricated
      // label).
      out.push(
        <text
          key={`${fromId}-${toId}-label`}
          x={midX}
          y={midY + 2}
          className={`wf-edge-label wf-edge-label--${kind}`}
          textAnchor="middle"
        >
          {(lookupRow('workflow_branch_kind', kind)?.metadata?.label as string | undefined) ?? kind}
        </text>
      );
    }
    out.push(
      <polygon
        key={`${fromId}-${toId}-arrow`}
        points={`${toX - 6},${toY - 4} ${toX},${toY} ${toX - 6},${toY + 4}`}
        className={`wf-edge-arrow wf-edge-arrow--${kind}`}
      />
    );
    return out;
  }

  if (!steps.length) {
    return (
      <div className="wf-canvas">
        <div className="wf-canvas-empty wf-node-host">
          <div className="wf-canvas-empty__icon">
            <Icon name="package" size={32} />
          </div>
          <h3>{t('workflowTemplates.canvas.emptyTitle')}</h3>
          <p>
            {t('workflowTemplates.canvas.emptyHint')}
          </p>
          <Button
            label={t('workflowTemplates.canvas.addTrigger')}
            iconName="plus"
            kind="ghost"
            capability={CAP.WORKFLOWS_WRITE}
            disabled={isCreatingStep}
            onClick={onAddFirstStep}
            title={t('workflowTemplates.canvas.addTriggerTitle')}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="wf-canvas"
      style={{ minWidth: `${maxX}px`, minHeight: `${maxY + 40}px` }}
    >
      <svg className="wf-edges" width={maxX} height={maxY}>
        <g>{edges}</g>
      </svg>
      {steps.map((s) => {
        const x = xMap[s.id] ?? 0;
        const y = 28 + (branchLanes[s.branch ?? defaultBranchKind] ?? 0) * (NODE_H + ROW_GAP);
        return (
          <CanvasNode
            key={s.id}
            step={s}
            x={x}
            y={y}
            isActive={activeStepId === s.id}
            runStatus={stepStatusMap[s.id] || null}
            onClick={() => onSelectStep(s.id)}
          />
        );
      })}
      {lastRun ? (() => {
        const row = lookupRow('workflow_run_status', lastRun.status);
        if (!row) {
          return (
            <div className="wf-canvas-pulse">
              <Chip
                label={missingSetupLabel(t('workflowTemplates.canvas.runStatusMissing'), lastRun.status)}
                kind="danger"
                size="xs"
              />
              <span className="mono">
                {fill(t('workflowTemplates.canvas.lastRunRef'), { ref: compactReferenceText(lastRun.run_id) })}
              </span>
            </div>
          );
        }
        const tone = (row.tone as ChipKind) ?? 'neutral';
        const dotKind: 'good' | 'warn' | 'danger' | 'neutral' =
          tone === 'good' || tone === 'warn' || tone === 'danger' ? tone : 'neutral';
        return (
          <div className="wf-canvas-pulse">
            <Dot kind={dotKind} />
            <span className="mono">
              {fill(t('workflowTemplates.canvas.lastRunStatus'), { ref: lastRun.run_id, status: String(row.label ?? lastRun.status) })}
            </span>
          </div>
        );
      })() : null}
    </div>
  );
}

interface InspectorProps {
  template: WorkflowTemplate;
  step: WorkflowTemplateStep | null;
  events: RecentEvent[];
  runs: WorkflowRun[];
  inspectorTab: InspectorTab;
  // W27 Cycle D closure — canonical operation_templates catalog
  // (`api.ui_list_operation_templates_v1`) is threaded into the inspector
  // so the Config tab can resolve `timeout_seconds` and (when present)
  // `retry_policy` for the active step's `op` row. Replaces the hardcoded
  // "30000" timeout literal + "5 attempts · exponential 1s" retry literal.
  opsCatalog: api.OperationTemplate[];
  // Cycle E (Workflows P2 #8) — canonical canvas/test-trace layout
  // budget threaded into TestTab. `null` triggers a fail-loud
  // null-render path on the test-trace bar.
  layout: WorkflowCanvasLayout | null;
  // W70 (Workflows Cycle F-R-10 P2-1) — canonical duration policy
  // threaded down to HistoryTab so its "time ago" rendering reuses the
  // canonical `ui_presentation_policy.duration_buckets` ladder.
  durationFormatPolicy: DurationFormatPolicy | null;
  onChangeTab: (t: InspectorTab) => void;
  onPatchStep: (stepId: string, patch: Partial<WorkflowTemplateStep>) => void;
  onOpenStepActions: () => void;
  onPromptErrorPath: () => void;
  onOpenRun: (runId: string) => void;
}

function Inspector({
  template,
  step,
  events,
  runs,
  inspectorTab,
  opsCatalog,
  layout,
  durationFormatPolicy,
  onChangeTab,
  onPatchStep,
  onOpenStepActions,
  onPromptErrorPath,
  onOpenRun,
}: InspectorProps) {
  const { t } = useI18n();
  if (!step) {
    return (
      <aside className="wf-inspector">
        <StateView
          kind="empty"
          title={t('workflowTemplates.inspector.noStepTitle')}
          hint={t('workflowTemplates.inspector.noStepHint')}
        />
      </aside>
    );
  }

  const tabs: Array<[InspectorTab, string]> = [
    ['config', t('workflowTemplates.inspector.tabs.config')],
    ['inputs', t('workflowTemplates.inspector.tabs.inputs')],
    ['outputs', t('workflowTemplates.inspector.tabs.outputs')],
    ['test', t('workflowTemplates.inspector.tabs.test')],
    ['history', t('workflowTemplates.inspector.tabs.history')],
  ];

  return (
    <aside className="wf-inspector">
      <header className="wf-insp__head">
        <div>
          <div className="wf-insp__step-kind mono">{step.kind.toUpperCase()}</div>
          <h2 className="wf-insp__step-title">{step.label}</h2>
          <div className="wf-insp__step-id mono">
            {compactReference(step.id)} · {step.op || ''}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="wf-insp__more"
          title={t('workflowTemplates.inspector.stepActions')}
          onClick={onOpenStepActions}
        >
          ⋯
        </button>
      </header>
      <div className="wf-insp__tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`wf-insp__tab ${inspectorTab === id ? 'is-active' : ''}`}
            onClick={() => onChangeTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="wf-insp__panel">
        {inspectorTab === 'config' ? (
          <ConfigTab step={step} opsCatalog={opsCatalog} onPatch={(p) => onPatchStep(step.id, p)} onPromptErrorPath={onPromptErrorPath} />
        ) : null}
        {inspectorTab === 'inputs' ? (
          <InputsTab template={template} step={step} events={events} opsCatalog={opsCatalog} />
        ) : null}
        {inspectorTab === 'outputs' ? <OutputsTab step={step} opsCatalog={opsCatalog} /> : null}
        {inspectorTab === 'test' ? (
          <TestTab template={template} events={events} layout={layout} />
        ) : null}
        {inspectorTab === 'history' ? (
          <HistoryTab
            template={template}
            runs={runs}
            durationFormatPolicy={durationFormatPolicy}
            onOpenRun={onOpenRun}
          />
        ) : null}
      </div>
    </aside>
  );
}

function FieldRow({
  label,
  children,
  editable,
  onClick,
}: {
  label: string;
  children: ReactNode;
  editable?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="wf-field">
      <label className="wf-field__label mono">{label}</label>
      <div
        className={editable ? 'wf-field__val is-editable' : 'wf-field__val'}
        onClick={onClick}
      >
        {children}
      </div>
    </div>
  );
}

function EditableText({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState<boolean>(false);
  const [value, setValue] = useState<string>(initial);
  useEffect(() => {
    setValue(initial);
  }, [initial]);

  if (editing) {
    return (
      <input
        autoFocus
        className="dt-inline-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          onCommit(value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onCommit(value);
            setEditing(false);
          } else if (e.key === 'Escape') {
            setValue(initial);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span className="mono" onClick={() => setEditing(true)} style={{ cursor: 'pointer' }}>
      {value || '—'}
    </span>
  );
}

function ConfigTab({
  step,
  opsCatalog,
  onPatch,
  onPromptErrorPath,
}: {
  step: WorkflowTemplateStep;
  opsCatalog: api.OperationTemplate[];
  onPatch: (p: Partial<WorkflowTemplateStep>) => void;
  onPromptErrorPath: () => void;
}) {
  const { t } = useI18n();
  // W27 Cycle D closure: resolve canonical operation_templates row by op
  // name. The ConfigTab Timeout + Retry rows now project canonical fields
  // (operation_templates.timeout_seconds + workflow_template_steps.metadata
  // .max_retries / retry_policy). Missing canonical row produces a
  // fail-loud `(missing)` chip on the timeout row instead of a silent
  // "30000" / "5 attempts · exponential 1s" literal. The dead `onCommit
  // = () => undefined` no-op is removed; values are display-only here
  // until the persistence path is wired through workflow_template_steps
  // .metadata via a real RPC. Backend SSOT:
  //   - `public.operation_templates.timeout_seconds`
  //   - `workflow_template_steps.metadata.max_retries|retry_policy`
  const opRow = step.op
    ? opsCatalog.find((o) => o.operation_name === step.op) ?? null
    : null;
  // `metadata` is a free-form jsonb projection on workflow_template_steps
  // (canonical seed: 202510150223_seed_workflow_templates.sql). The
  // engine reads `max_retries` / `retry_policy` from there.
  const stepMeta = (step as { metadata?: Record<string, unknown> }).metadata ?? {};
  const maxRetries = (stepMeta.max_retries as number | undefined) ?? null;
  const retryPolicy = (stepMeta.retry_policy as string | undefined) ?? null;
  // W77 (Workflows Cycle F-R-17 P1) — canonical default branch + display
  // label resolve through `workflow_branch_kind` rows. `is_default: true`
  // / `metadata.is_default: true` selects the default value; the Branch
  // FieldRow renders `metadata.label` from the canonical row (mirrors
  // edge-mid-label resolution at templates.tsx:672). Replaces literal
  // `|| 'main'` fallback so adding/renaming the default branch is a
  // single seed update (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6
  // row-driven config). Missing canonical row → fail-loud `(missing)`
  // chip via the strict null guard below.
  const branchKindRowsForConfig = api.getLookups('workflow_branch_kind') as Array<{
    value: string;
    is_default?: boolean;
    metadata?: { lane_index?: number; label?: string; is_default?: boolean };
  }>;
  const defaultBranchKind =
    branchKindRowsForConfig.find((r) => r.is_default === true || r.metadata?.is_default === true)?.value
      ?? branchKindRowsForConfig.find((r) => r.metadata?.lane_index === 0)?.value
      ?? '';
  const branchValue = step.branch ?? defaultBranchKind;
  const branchRow = branchValue ? lookupRow('workflow_branch_kind', branchValue) : null;
  return (
    <>
      <FieldRow label={t('workflowTemplates.config.stepId')}>
        {compactReference(step.id)}
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.operation')} editable>
        <span className="mono">{step.op || '—'}</span>
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.kind')}>
        {(() => {
          const r = kindTone(step.kind);
          return r.tone && r.label
            ? <Chip label={r.label} kind={r.tone} size="xs" />
            : <Chip label={missingSetupLabel(t('workflowTemplates.config.stepTypeMissing'), step.kind)} kind="danger" size="xs" />;
        })()}
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.branch')}>
        {branchRow ? (
          <span className="mono">{(branchRow.metadata as { label?: string } | undefined)?.label ?? branchRow.label}</span>
        ) : (
          <Chip label={missingSetupLabel(t('workflowTemplates.config.branchMissing'), branchValue || t('workflowTemplates.config.unset'))} kind="danger" size="xs" />
        )}
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.displayLabel')}>
        <EditableText initial={step.label} onCommit={(v) => onPatch({ label: v })} />
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.subtitle')}>
        <EditableText initial={step.sub || ''} onCommit={(v) => onPatch({ sub: v })} />
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.onError')} editable onClick={onPromptErrorPath}>
        {compactReference(step.error_path)}
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.timeout')}>
        {step.op && !opRow ? (
          <Chip
            label={missingSetupLabel(t('workflowTemplates.config.operationMissing'), step.op)}
            kind="danger"
            size="xs"
          />
        ) : opRow ? (
          <span className="mono">{opRow.timeout_seconds * 1000}</span>
        ) : (
          <span className="mono">—</span>
        )}
      </FieldRow>
      <FieldRow label={t('workflowTemplates.config.retry')}>
        {retryPolicy || maxRetries !== null ? (
          <span className="mono">
            {maxRetries !== null ? fill(t('workflowTemplates.config.attempts'), { count: maxRetries }) : ''}
            {maxRetries !== null && retryPolicy ? ' · ' : ''}
            {retryPolicy ?? ''}
          </span>
        ) : step.op && !opRow ? (
          <Chip
            label={missingSetupLabel(t('workflowTemplates.config.operationMissing'), step.op)}
            kind="danger"
            size="xs"
          />
        ) : (
          <span className="mono">—</span>
        )}
      </FieldRow>
      <div className="wf-insp__hint">
        {t('workflowTemplates.config.hint')}
      </div>
    </>
  );
}

function InputsTab({
  template,
  step,
  events,
  opsCatalog,
}: {
  template: WorkflowTemplate;
  step: WorkflowTemplateStep;
  events: RecentEvent[];
  opsCatalog: api.OperationTemplate[];
}) {
  const { t } = useI18n();
  // Cycle E (Workflows P1 #2) — scope variable matrix is row-driven via the
  // canonical `workflow_expression_scope` lookup. Each row's
  // `metadata.variables` enumerates the variable identifiers exposed at
  // that scope. For `trigger`, the matched RecentEvent payload keys
  // override the canonical default (`['payload']`) when present. Missing
  // or empty canonical category renders a fail-loud `<StateView
  // kind="error" />` banner instead of fabricating a scope tree.
  const scopeRows = api.getLookups('workflow_expression_scope') as Array<{
    value: string;
    label?: string;
    metadata?: { variables?: string[]; is_trigger_scope?: boolean };
  }>;

  const evt = events.find((e) => e.matched_template === template.id);
  // W62-Workflows (Cycle F-R-2 P1-2) — main-branch filter resolves
  // canonically through `workflow_branch_kind.<branch>.metadata.lane_index`
  // (lane 0 = main, lane 1 = secondary error/manual). Replaces the
  // literal `s.branch !== 'error' && s.branch !== 'manual'` so the
  // canvas/scope tree main-lane filter is a single seed update.
  const main = (template.steps || []).filter(
    (s) => (lookupRow('workflow_branch_kind', s.branch ?? '') as { metadata?: { lane_index?: number } } | null)?.metadata?.lane_index === 0
  );

  const [fieldName, setFieldName] = useState<string>('');
  const [fieldExpr, setFieldExpr] = useState<string>('');

  if (!scopeRows.length) {
    return (
      <div style={{ padding: '0 14px 12px' }}>
        <StateView
          kind="error"
          title={t('workflowTemplates.inputs.scopesTitle')}
          hint={t('workflowTemplates.inputs.scopesHint')}
        />
      </div>
    );
  }

  // Build the scope tree strictly from the canonical lookup rows. The
  // trigger-scope row (flagged via `metadata.is_trigger_scope: true`)
  // substitutes matched-event payload keys when present.
  // W68 (Workflows Cycle F-R-8 P1-5) — replaces the literal
  // `row.value === 'trigger'` compare with a row metadata flag check
  // so adding a new trigger-equivalent scope is a single seed update.
  const scope: Array<{ key: string; items: string[] }> = scopeRows.map((row) => {
    const variables = Array.isArray(row.metadata?.variables) ? row.metadata!.variables! : [];
    if (row.metadata?.is_trigger_scope === true && evt) {
      const triggerKeys = Object.keys(evt.payload || {});
      return { key: row.value, items: triggerKeys.length ? triggerKeys : variables };
    }
    return { key: row.value, items: variables };
  });

  // Per-step output identifiers come from canonical `operation_templates
  // .output_schema`. When the canonical row has no projection the step
  // contributes no output identifiers (no FE-fabricated synthetic keys).
  for (const s of main) {
    if (s.id === step.id) break;
    const opOutput = resolveOpOutput(s.op, opsCatalog);
    const keys = opOutput.schema ? Object.keys(opOutput.schema) : [];
    scope.push({ key: `steps.${s.id}.output`, items: keys });
  }

  return (
    <>
      <div className="wf-insp__section-eyebrow">{t('workflowTemplates.inputs.available')}</div>
      <div className="wf-scope-tree">
        {scope.map(({ key: k, items }) => (
          <div key={k} className="wf-scope-tree__group">
            <div className="wf-scope-tree__group-name mono">{k}</div>
            <div className="wf-scope-tree__items">
              {items.length === 0 ? (
                <span className="mono" style={{ opacity: 0.5, fontSize: '11px' }}>
                  {t('workflowTemplates.inputs.none')}
                </span>
              ) : (
                items.map((it) => (
                  <button
                    key={it}
                    type="button"
                    className="wf-var-pill mono"
                    title={t('workflowTemplates.inputs.pillTitle')}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData('text/plain', `{{ ${k}.${it} }}`)
                    }
                    // WCAG 2.5.7: a click or Enter does what the drop does, and also copies.
                    onClick={() => {
                      setFieldExpr(`{{ ${k}.${it} }}`);
                      navigator.clipboard
                        ?.writeText(`{{ ${k}.${it} }}`)
                        .catch(() => undefined);
                      pushToast(fill(t('workflowTemplates.inputs.copied'), { expression: `{{ ${k}.${it} }}` }), 'good');
                    }}
                  >
                    {it}
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="wf-insp__section-eyebrow" style={{ marginTop: '12px' }}>
        {t('workflowTemplates.inputs.bindHeading')}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '160px 1fr',
          gap: '6px',
          padding: '8px 14px',
        }}
      >
        <input
          type="text"
          className="dt-inline-input"
          placeholder={t('workflowTemplates.inputs.namePlaceholder')}
          value={fieldName}
          onChange={(e) => setFieldName(e.target.value)}
        />
        <input
          type="text"
          className="dt-inline-input"
          placeholder={t('workflowTemplates.inputs.exprPlaceholder')}
          value={fieldExpr}
          onChange={(e) => setFieldExpr(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setFieldExpr(e.dataTransfer.getData('text/plain'));
          }}
        />
      </div>
      <div style={{ padding: '0 14px' }}>
        <Button
          label={t('workflowTemplates.inputs.bindButton')}
          kind="ghost"
          onClick={() =>
            pushToast(fill(t('workflowTemplates.inputs.bound'), { field: fieldName || '?', expression: fieldExpr || '?' }), 'good')
          }
        />
      </div>
    </>
  );
}

function OutputsTab({
  step,
  opsCatalog,
}: {
  step: WorkflowTemplateStep;
  opsCatalog: api.OperationTemplate[];
}) {
  const { t } = useI18n();
  // Cycle E (Workflows P1 #1) — read canonical `operation_templates
  // .output_schema` + `output_sample` strictly. Missing canonical row /
  // unprojected columns render `<StateView kind="empty" hint="..."/>`
  // instead of fabricating an op-prefix-keyed synthetic shape with
  // fictional customer identifiers (EXAMPLEMARKET-99281, snd_examplemarket, +966...,
  // shp_9381418). Mirror runs.tsx:585-594 pattern.
  const { schema, sample } = resolveOpOutput(step.op, opsCatalog);
  return (
    <>
      <div className="wf-insp__section-eyebrow">{t('workflowTemplates.outputs.schema')}</div>
      {schema ? (
        <pre className="wf-code-block">{JSON.stringify(schema, null, 2)}</pre>
      ) : (
        <div style={{ padding: '0 14px 12px' }}>
          <StateView
            kind="empty"
            title={t('workflowTemplates.outputs.noSchemaTitle')}
            hint={t('workflowTemplates.outputs.noSchemaHint')}
          />
        </div>
      )}
      <div className="wf-insp__section-eyebrow">{t('workflowTemplates.outputs.lastSample')}</div>
      {sample ? (
        <pre className="wf-code-block">{JSON.stringify(sample, null, 2)}</pre>
      ) : (
        <div style={{ padding: '0 14px 12px' }}>
          <StateView
            kind="empty"
            title={t('workflowTemplates.outputs.noSampleTitle')}
            hint={t('workflowTemplates.outputs.noSampleHint')}
          />
        </div>
      )}
      <div style={{ padding: '0 14px 14px' }}>
        <Button
          label={t('workflowTemplates.outputs.pin')}
          iconName="plus"
          kind="ghost"
          onClick={() => pushToast(t('workflowTemplates.outputs.pinned'), 'good')}
        />
      </div>
    </>
  );
}

interface TraceEntry {
  step: WorkflowTemplateStep;
  duration_ms: number;
  status: string;
}

function TestTab({
  template,
  events,
  layout,
}: {
  template: WorkflowTemplate;
  events: RecentEvent[];
  // Cycle E (Workflows P2 #8) — canonical test-trace bar dimensions.
  // `null` when the canonical row is missing; the trace bar renders at
  // zero width (no FE-fabricated `Math.min(160, ...) / 2` literal).
  layout: WorkflowCanvasLayout | null;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const startWorkflowRun = useStartWorkflowRun();
  const matchedEvent = events.find((e) => e.matched_template === template.id);
  const initialPayload = JSON.stringify(matchedEvent?.payload || { example: true }, null, 2);
  const [payload, setPayload] = useState<string>(initialPayload);
  const [running, setRunning] = useState<boolean>(false);
  const [result, setResult] = useState<{
    duration_ms: number;
    runId: string;
    correlationId: string;
    finalStatus: 'completed' | 'failed' | 'paused';
    trace: TraceEntry[];
  } | null>(null);

  async function handleRun() {
    setRunning(true);
    setResult(null);
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (err) {
      pushToast(t('workflowTemplates.test.invalidJson'), 'danger');
      setRunning(false);
      return;
    }
    try {
      // Canonical entrypoint: start_workflow_run({ui:{dry_run, sample_payload}}) -> poll progress.
      const start = await startWorkflowRun.mutateAsync({
        template_id: template.id,
        ui: { dry_run: true, sample_payload: parsedPayload },
      });
      const progress = await api.progress_workflow_run(start.workflow_run_id);
      await refreshWorkflowRunReadModels(queryClient);
      const tplById = new Map<string, WorkflowTemplateStep>();
      (template.steps || []).forEach((s) => tplById.set(s.id, s));
      // W75 (Workflows Cycle F-R-15 P1) — canonical default step kind resolves
      // through `workflow_step_kind` row metadata flag (`is_default: true` /
      // `metadata.is_default: true`). Replaces literal `|| 'action'` fallback
      // so the trace synthesis stays SSOT-aligned with the W68 runs.tsx pattern
      // (AGENTS.md §2 ZERO HARDCODING + §6 row-driven config). Missing
      // canonical row → empty string surfaces a fail-loud `(missing)` chip
      // downstream via `lookupRow('workflow_step_kind', '')` returning null
      // (mirrors the no-fallback pattern at templates.tsx:283-297, 1329-1333).
      const defaultStepKind =
        (api.getLookups('workflow_step_kind') as Array<{ value: string; is_default?: boolean; metadata?: { is_default?: boolean } }> | undefined)
          ?.find((r) => r.is_default === true || r.metadata?.is_default === true)?.value ?? '';
      const trace: TraceEntry[] = progress.steps.map((s) => ({
        step: tplById.get(s.step_id) ?? {
          id: s.step_id,
          kind: (s.kind as string) || defaultStepKind,
          label: s.label ?? s.step_id,
        },
        duration_ms: s.duration_ms ?? 0,
        status: s.step_status ?? s.status ?? '',
      }));
      setResult({
        duration_ms: progress.duration_ms,
        runId: start.workflow_run_id,
        correlationId: start.correlation_id,
        finalStatus: progress.workflow_status,
        trace,
      });
      // W61 (Workflows P1-2) — final-status toast tone resolves through
      // canonical `workflow_run_status.tone`. Replaces inline literal
      // `progress.workflow_status === 'failed' ? 'danger' : 'good'` compare.
      // Strict no-fallback: missing canonical row → `info` so the gap is
      // visible (no silent `good` mask). The cast narrows to the
      // ToastTone vocabulary; non-matching tones (`neutral`) collapse to
      // `info` for the toast surface.
      const finalToneRaw = lookupRow('workflow_run_status', progress.workflow_status)?.tone;
      const finalTone: 'good' | 'warn' | 'danger' | 'info' =
        finalToneRaw === 'good' || finalToneRaw === 'warn' || finalToneRaw === 'danger' || finalToneRaw === 'info'
          ? finalToneRaw
          : 'info';
      pushToast(
        fill(t('workflowTemplates.test.runToast'), { ref: compactReferenceText(start.workflow_run_id), status: progress.workflow_status, ms: progress.duration_ms }),
        finalTone,
      );
    } catch (err) {
      pushToast(t('workflowTemplates.test.startFailed'), 'danger');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <div className="wf-insp__section-eyebrow">{t('workflowTemplates.test.heading')}</div>
      <textarea
        className="wf-code-block wf-code-block--editable"
        rows={8}
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
      />
      <div className="wf-recent-bar">
        {events.slice(0, 4).map((evt) => (
          <button
            key={evt.id}
            type="button"
            className="wf-recent-bar__btn"
            title={fill(t('workflowTemplates.test.useAsInput'), { id: evt.id })}
            onClick={() => setPayload(JSON.stringify(evt.payload, null, 2))}
          >
            <span className="mono">{evt.id}</span>
            <span style={{ opacity: 0.6 }}>{evt.event}</span>
          </button>
        ))}
      </div>
      <div style={{ padding: '0 14px 0' }}>
        {/* W39 closure (REAUDIT5B WORKFLOWS P1-CF) — Test-panel "Run" Button
            now carries `capability={CAP.WORKFLOWS_WRITE}` to match the canonical
            `start_workflow_run` + `progress_workflow_run` server-side
            assertion (canonical RPCs gate on `workflows.write`). The Test
            panel intentionally starts in preview mode (`ui.dry_run: true`)
            against the focused template; the capability gate fail-closes
            the FE Button to mirror server behavior. */}
        <Button
          label={running ? t('workflowTemplates.test.running') : t('workflowTemplates.test.run')}
          iconName="play"
          kind="primary"
          capability={CAP.WORKFLOWS_WRITE}
          onClick={handleRun}
          disabled={running}
        />
      </div>
      <div className="wf-test-result" role="status" aria-live="polite">
        {running ? (
          <div className="wf-test-running">
            <span className="wf-spinner" />
            <span>{t('workflowTemplates.test.starting')}</span>
          </div>
        ) : null}
        {result ? (
          <>
            <div className="wf-test-summary mono">
              {/* W61 (Workflows P1-2) — final-status glyph resolves through
                  canonical `workflow_run_status.metadata.glyph`. Replaces
                  inline literal `result.finalStatus === 'failed' ? '✗' : '✓'`
                  compare. Strict no-fallback: missing canonical row → `?`
                  so the gap surfaces. */}
              <span>
                {(lookupRow('workflow_run_status', result.finalStatus)?.metadata?.glyph as string | undefined) ?? '?'}{' '}
              </span>
              <span>{fill(t('workflowTemplates.test.steps'), { count: result.trace.length })}</span>
              <span style={{ opacity: 0.5, margin: '0 6px' }}>·</span>
              <span>{fill(t('workflowTemplates.test.ms'), { ms: result.duration_ms })}</span>
              <span style={{ opacity: 0.5, margin: '0 6px' }}>·</span>
              {t('workflowTemplates.test.recorded')}
              <span style={{ opacity: 0.5, margin: '0 6px' }}>·</span>
              <span>{t('workflowTemplates.test.reference')}</span>
            </div>
            <ol className="wf-test-trace">
              {result.trace.map((entry, i) => {
                const stepRow = lookupRow('workflow_step_status', entry.status);
                // Cycle E (Workflows P2 #8) — strict null-render. Bar
                // width derives from canonical layout budget; when the
                // step has no canonical duration projection (or the
                // policy is missing), the bar is omitted instead of
                // padded to a synthetic `1ms / 2` minimum.
                const dur = typeof entry.duration_ms === 'number' && entry.duration_ms > 0
                  ? entry.duration_ms
                  : null;
                const barWidthPx =
                  layout && dur !== null
                    ? Math.min(layout.test_trace_max_width, dur / layout.test_trace_divisor)
                    : null;
                return (
                  <li key={i}>
                    {barWidthPx !== null ? (
                      <span
                        className={`wf-test-trace__bar wf-test-trace__bar--${entry.status}`}
                        style={{ width: `${barWidthPx}px` }}
                      />
                    ) : null}
                    <span className="wf-test-trace__step">{entry.step.label}</span>
                    {stepRow ? (
                      <Chip
                        label={stepRow.label ?? entry.status}
                        kind={(stepRow.tone as ChipKind) ?? 'neutral'}
                        size="xs"
                      />
                    ) : (
                      <Chip
                        label={missingSetupLabel(t('workflowTemplates.test.stepStatusMissing'), entry.status)}
                        kind="danger"
                        size="xs"
                      />
                    )}
                    <span className="wf-test-trace__dur mono">
                      {dur !== null ? fill(t('workflowTemplates.test.ms'), { ms: dur }) : '—'}
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        ) : null}
      </div>
    </>
  );
}

function HistoryTab({
  template,
  runs,
  durationFormatPolicy,
  onOpenRun,
}: {
  template: WorkflowTemplate;
  runs: WorkflowRun[];
  // W70 (Workflows Cycle F-R-10 P2-1) — canonical duration policy
  // threaded from TemplatesModule. `null` indicates the canonical row is
  // missing; downstream `fmtTimeAgo` returns `'—'` so the gap surfaces.
  durationFormatPolicy: DurationFormatPolicy | null;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const matched = runs.filter((r) => workflowRunTemplateId(r) === template.id);
  if (!matched.length) {
    return <div className="state__hint">{t('workflowTemplates.history.empty')}</div>;
  }
  return (
    <>
      <div className="wf-insp__section-eyebrow">{fill(t('workflowTemplates.history.recent'), { count: matched.length })}</div>
      <div className="wf-history-list">
        {matched.map((r) => {
          const status = workflowRunStatus(r);
          const row = lookupRow('workflow_run_status', status);
          const tone = (row?.tone as ChipKind | undefined) ?? null;
          const dotKind: 'good' | 'warn' | 'danger' | 'neutral' =
            tone === 'good' || tone === 'warn' || tone === 'danger' ? tone : 'neutral';
          return (
          <button
            key={r.id}
            type="button"
            className="wf-history-row"
            onClick={() => onOpenRun(r.id)}
            title={t('workflowTemplates.history.open')}
          >
            {row ? (
              <Dot kind={dotKind} />
            ) : (
              <Chip
                label={missingSetupLabel(t('workflowTemplates.canvas.runStatusMissing'), status)}
                kind="danger"
                size="xs"
              />
            )}
            <span className="mono" style={{ fontWeight: 600 }} title={workflowRunDisplayId(r)}>
              {compactReferenceText(workflowRunDisplayId(r))}
            </span>
            <span style={{ flex: 1, color: 'var(--ink-3)', fontSize: '11px' }}>
              {fmtTimeAgo(r.started_at, durationFormatPolicy)}
            </span>
            <span
              className="mono"
              style={{ fontSize: '11px', color: 'var(--ink-3)' }}
            >
              {r.duration_ms ? fill(t('workflowTemplates.test.ms'), { ms: r.duration_ms }) : '—'}
            </span>
          </button>
          );
        })}
      </div>
    </>
  );
}

type PaletteTab = 'templates' | 'operations' | 'snippets';

export function TemplatesModule() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const drawer = useDrawer();
  const modal = useModal();
  const palette = usePalette();
  const identity = useIdentity();
  const { hasCapability } = identity;
  const activeTenantId = identity.currentTenantId();
  const canRead = useCapability(CAP.WORKFLOWS_READ);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  // Wave 5 RE-AUDIT closure (W10-3): canonical capability gate is
  // `workflows.write` to match B6 RPCs (ui_set_workflow_template_status_v1,
  // register_workflow_binding_v1, simulate_binding_dispatch_v1). The Button
  // capability props throughout this module already use `workflows.write`;
  // the imperative `canWrite` gate must match so the operations-bind palette
  // does not desync from Activate/Deactivate/Publish gating.
  const canWrite = hasCapability(CAP.WORKFLOWS_WRITE);
  const createTemplate = useCreateWorkflowTemplate();
  const setTemplateStatus = useSetWorkflowTemplateStatus();
  const createTemplateStep = useCreateWorkflowTemplateStep();
  const updateTemplateStep = useUpdateWorkflowTemplateStep();
  const duplicateTemplateStep = useDuplicateWorkflowTemplateStep();
  const deleteTemplateStep = useDeleteWorkflowTemplateStep();
  const restoreTemplateVersion = useRestoreWorkflowTemplateVersion();

  const templateListOptions = useMemo(
    () => ({
      page_size: 200,
      ...(isUuidText(activeTenantId) ? { filter: { scope_id: activeTenantId } } : {}),
    }),
    [activeTenantId],
  );

  const templatesQuery = useResourceList<WorkflowTemplate>(
    'workflow_templates',
    templateListOptions,
    readQueryOptions,
  );
  const eventsQuery = useResourceList<RecentEvent>('recent_workflow_events', undefined, readQueryOptions);
  const runsQuery = useResourceList<WorkflowRun>('workflow_runs', undefined, readQueryOptions);
  // W22 — paired projection view consumption (additive). Provides canonical
  // counter projections per template so the studio palette can render
  // active_run_count / total_run_count / step_count / last_run_status /
  // is_published from the canonical seam without inventing FE-only joins.
  const directoryQuery = useResourceList<WorkflowTemplateDirectoryRow>(
    'workflow_template_directory',
    templateListOptions,
    readQueryOptions,
  );
  const opsCatalogQuery = useQuery({
    queryKey: ['workflow_operation_templates'],
    queryFn: () => api.ui_list_operation_templates_v1(),
    enabled: canRead,
    staleTime: 60_000,
  });

  // Cycle E (Workflows P2 #7 + #8) — canonical canvas/test-trace layout
  // budget. Resolved through `useResolveSettings('ui_presentation_policy')
  // .workflow_canvas_layout`. `null` here means the canonical row is not
  // resolved or has missing/non-positive fields; downstream consumers
  // render fail-loud StateView blocks instead of mounting with FE
  // literals.
  const uiPresentationPolicy = useResolveSettings('ui_presentation_policy', undefined, readQueryOptions);
  const canvasLayout = useMemo<WorkflowCanvasLayout | null>(
    () => readCanvasLayout(uiPresentationPolicy.data?.value),
    [uiPresentationPolicy.data],
  );
  // W70 (Workflows Cycle F-R-10 P2-1) — canonical duration policy slice
  // for the `fmtTimeAgo` formatter (HistoryTab + trigger-composer recent-
  // events list). Mirrors the review-queue.tsx derivation pattern so both
  // surfaces consume the same `ui_presentation_policy.duration_buckets`
  // ladder. Strict no-fallback: missing canonical row → `null`, which
  // surfaces `'—'` in the rendered timestamp instead of fabricating a
  // hardcoded ladder.
  const durationFormatPolicy = useMemo<DurationFormatPolicy | null>(() => {
    const value = uiPresentationPolicy.data?.value as
      | {
          duration_buckets?: Array<{ unit: string; threshold_ms: number; label: string }>;
          overdue_label?: string;
        }
      | undefined;
    const buckets = value?.duration_buckets;
    const overdueLabel = value?.overdue_label;
    if (!Array.isArray(buckets) || buckets.length === 0) return null;
    if (typeof overdueLabel !== 'string' || !overdueLabel) return null;
    return { duration_buckets: buckets, overdue_label: overdueLabel };
  }, [uiPresentationPolicy.data]);

  const templateRows = useMemo(() => templatesQuery.data?.rows ?? [], [templatesQuery.data]);
  const templates = useMemo(
    () => templateRows.map((template) => normalizeWorkflowTemplateRow(template)),
    [templateRows],
  );
  const scopedTemplates = useMemo(
    () => templates.filter((template) => isWorkflowTemplateVisibleForTenant(template, activeTenantId)),
    [activeTenantId, templates],
  );
  const events = useMemo(() => eventsQuery.data?.rows ?? [], [eventsQuery.data]);
  const runs = useMemo(() => runsQuery.data?.rows ?? [], [runsQuery.data]);
  const opsCatalog = useMemo(() => opsCatalogQuery.data?.rows ?? [], [opsCatalogQuery.data]);
  // W22 — directory projection by template id; used additively for per-card
  // counter chips so the rendered counts come from the canonical seam.
  const directoryByTemplateId = useMemo(() => {
    const m = new Map<string, WorkflowTemplateDirectoryRow>();
    for (const r of directoryQuery.data?.rows ?? []) m.set(r.id, r);
    return m;
  }, [directoryQuery.data]);

  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [activeVersion, setActiveVersion] = useState<string>('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('config');
  const [search, setSearch] = useState<string>('');
  const [paletteTab, setPaletteTab] = useState<PaletteTab>('templates');
  const [stepEdits, setStepEdits] = useState<Record<string, Partial<WorkflowTemplateStep>>>({});
  const [pendingStepFocusId, setPendingStepFocusId] = useState<string | null>(null);
  const [promotionReadback, setPromotionReadback] =
    useState<WorkflowTemplatePromotionReadback | null>(null);
  const [restoreReadback, setRestoreReadback] =
    useState<WorkflowTemplateRestoreReadback | null>(null);
  const [stepActionReadback, setStepActionReadback] =
    useState<WorkflowTemplateStepActionReadback | null>(null);

  const focusWorkflowTemplateMutationResult = useCallback((result: Record<string, unknown>) => {
    const nextTemplateId = stringValue(result.workflow_template_id) ?? stringValue(result.id);
    if (!nextTemplateId) return;
    setActiveTemplateId(nextTemplateId);
    setActiveStepId(null);
    setPendingStepFocusId(null);
    setStepEdits({});
  }, []);

  // Initialize active template on first load.
  const initRef = useRef(false);
  useEffect(() => {
    if (!scopedTemplates.length || initRef.current) return;
    initRef.current = true;
    const first = scopedTemplates[0]!;
    setActiveTemplateId(first.id);
    setActiveStepId(first.steps?.[0]?.id || null);
    setActiveVersion(first.version);
  }, [scopedTemplates]);

  useEffect(() => {
    if (!scopedTemplates.length) return;
    if (activeTemplateId && scopedTemplates.some((template) => template.id === activeTemplateId)) return;
    const preferred =
      promotionReadback
        ? scopedTemplates.find((template) => template.id === promotionReadback.templateId)
        : null;
    const next = preferred ?? scopedTemplates[0]!;
    setActiveTemplateId(next.id);
    setActiveStepId(next.steps?.[0]?.id || null);
    setActiveVersion(next.version);
  }, [activeTemplateId, promotionReadback, scopedTemplates]);

  const activeTemplate = useMemo(() => {
    const tpl = scopedTemplates.find((t) => t.id === activeTemplateId);
    if (!tpl) return null;
    // Apply local step edits.
    const steps = (tpl.steps || []).map((s) => ({ ...s, ...(stepEdits[s.id] || {}) }));
    return { ...tpl, steps };
  }, [scopedTemplates, activeTemplateId, stepEdits]);

  useEffect(() => {
    if (!activeTemplate) return;
    const steps = activeTemplate.steps ?? [];
    if (pendingStepFocusId && steps.some((step) => step.id === pendingStepFocusId)) {
      setActiveStepId(pendingStepFocusId);
      setPendingStepFocusId(null);
      return;
    }
    if (activeStepId && steps.some((step) => step.id === activeStepId)) return;
    if (pendingStepFocusId) return;
    setActiveStepId(steps[0]?.id ?? null);
  }, [activeTemplate, activeStepId, pendingStepFocusId]);

  useEffect(() => {
    if (!activeTemplate) return;
    const versions = activeTemplate.versions || [activeTemplate.version];
    setActiveVersion((current) =>
      current && versions.includes(current) ? current : activeTemplate.version,
    );
  }, [activeTemplate]);

  const activeStep = useMemo(() => {
    if (!activeTemplate || !activeStepId) return null;
    return activeTemplate.steps?.find((s) => s.id === activeStepId) || null;
  }, [activeTemplate, activeStepId]);

  const navigateToWorkflowRuns = useCallback(
    (search: Record<string, string>) => {
      void navigate({
        to: '/workflows/runs',
        search: search as never,
      });
    },
    [navigate],
  );

  const validationIssues = useMemo<ValidationIssue[]>(() => {
    if (!activeTemplate) return [];
    const issues: ValidationIssue[] = [];
    const steps = activeTemplate.steps ?? [];
    if (!steps.length) {
      issues.push({ stepId: null, msg: t('workflowTemplates.validation.noSteps') });
    }
    const idsInBranch = new Set(steps.map((s) => s.id));
    const validOps = new Set(opsCatalog.map((o) => o.operation_name));
    // W68 (Workflows Cycle F-R-8 P1-3) — main-branch filter resolves
    // canonically through `workflow_branch_kind.<branch>.metadata.lane_index`.
    // Mirrors the existing pattern at line ~1020 / 2095. Replaces the
    // literal `(s.branch ?? 'main') === 'main'` so the validation
    // main-lane filter is a single seed update.
    const main = steps.filter(
      (s) => (lookupRow('workflow_branch_kind', s.branch ?? '') as { metadata?: { lane_index?: number } } | null)?.metadata?.lane_index === 0
    );
    // Cycle E2 (Workflows P2 #14) — trigger detection is row-driven via
    // `workflow_step_kind.metadata.is_trigger`. Replaces the literal
    // `s.kind === 'trigger'` filter so adding a new trigger-equivalent
    // kind is a single seed update.
    const isTriggerKind = (kind: string | undefined): boolean => {
      if (!kind) return false;
      const row = lookupRow('workflow_step_kind', kind) as { metadata?: { is_trigger?: boolean } } | null;
      return row?.metadata?.is_trigger === true;
    };
    if (main.length && !isTriggerKind(main[0]?.kind)) {
      issues.push({ stepId: main[0]?.id ?? null, msg: t('workflowTemplates.validation.firstTrigger') });
    }
    if (steps.filter((s) => isTriggerKind(s.kind)).length > 1) {
      issues.push({ stepId: null, msg: t('workflowTemplates.validation.multipleTriggers') });
    }
    steps.forEach((s) => {
      // W62-Workflows (Cycle F-R-2 P1-4) — "requires error_path"
      // resolves canonically through `workflow_step_kind.<kind>.metadata.requires_error_path`.
      // Replaces the literal `s.kind === 'guard'` validation branch so
      // adding another kind that requires an error_path is a single
      // seed update.
      const stepKindMeta = (lookupRow('workflow_step_kind', s.kind) as { metadata?: { requires_error_path?: boolean } } | null)?.metadata;
      if (stepKindMeta?.requires_error_path === true && !s.error_path) {
        issues.push({ stepId: s.id, msg: fill(t('workflowTemplates.validation.guardErrorPath'), { label: s.label }) });
      }
      if (!s.op) {
        issues.push({ stepId: s.id, msg: fill(t('workflowTemplates.validation.missingOperation'), { label: s.label }) });
      } else if (validOps.size && !validOps.has(s.op)) {
        issues.push({
          stepId: s.id,
          msg: fill(t('workflowTemplates.validation.unknownOperation'), { label: s.label, operation: s.op }),
        });
      }
      if (s.error_path && !idsInBranch.has(s.error_path)) {
        issues.push({ stepId: s.id, msg: fill(t('workflowTemplates.validation.errorPath'), { ref: compactReferenceText(s.error_path) }) });
      }
      if (s.manual_path && !idsInBranch.has(s.manual_path)) {
        issues.push({ stepId: s.id, msg: fill(t('workflowTemplates.validation.manualPath'), { ref: compactReferenceText(s.manual_path) }) });
      }
    });
    return issues;
  }, [activeTemplate, opsCatalog, t]);

  const filteredTemplates = useMemo(() => {
    if (!search) return scopedTemplates;
    const q = search.toLowerCase();
    return scopedTemplates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.template_id.toLowerCase().includes(q) ||
        t.trigger.toLowerCase().includes(q)
    );
  }, [scopedTemplates, search]);

  const lastRunByTemplate = useMemo(() => {
    const m = new Map<string, WorkflowRun>();
    for (const r of runs) {
      const templateId = workflowRunTemplateId(r);
      if (templateId && !m.has(templateId)) m.set(templateId, r);
    }
    return m;
  }, [runs]);

  async function patchStep(
    stepId: string,
    patch: Partial<WorkflowTemplateStep>,
  ): Promise<boolean> {
    if (!activeTemplate) return false;
    if (!canWrite) {
      pushToast(t('workflowTemplates.toast.updatePermission'), 'danger');
      return false;
    }
    try {
      await updateTemplateStep.mutateAsync({
        workflow_template_id: activeTemplate.id,
        workflow_template_step_id: stepId,
        patch: toWorkflowStepRpcPatch(patch),
      });
      setStepEdits((prev) => ({
        ...prev,
        [stepId]: { ...(prev[stepId] || {}), ...patch },
      }));
      pushToast(t('workflowTemplates.toast.stepUpdated'), 'good');
      return true;
    } catch (err) {
      pushToast(t('workflowTemplates.toast.stepUpdateFailed'), 'danger');
      return false;
    }
  }

  function selectTemplate(t: WorkflowTemplate) {
    setActiveTemplateId(t.id);
    setActiveStepId(t.steps?.[0]?.id || null);
    setActiveVersion(t.version);
  }

  // Canvas keyboard navigation: Arrow keys walk between sibling steps; Home/End jump to first/last.
  const onCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!activeTemplate) return;
      const steps = activeTemplate.steps || [];
      if (!steps.length) return;
      // Cycle E2 (Workflows P1 #2) — keyboard-nav lane partitioning is
      // canonical-row-driven via `workflow_branch_kind.metadata.is_keyboard_secondary`.
      // The primary lane (lane_index 0) holds the main flow; every branch
      // flagged `is_keyboard_secondary === true` collapses into the
      // secondary lane. Replaces the literal `s.branch === 'error'` /
      // `s.branch === 'manual'` filter pair.
      const branchRows = api.getLookups('workflow_branch_kind') as Array<{
        value: string;
        metadata?: { lane_index?: number; is_keyboard_secondary?: boolean };
      }>;
      const primaryKeys = new Set(
        branchRows.filter((r) => r.metadata?.lane_index === 0).map((r) => r.value),
      );
      const main = steps.filter((s) => primaryKeys.has(s.branch ?? ''));
      const secondaryStepGroups = branchRows
        .filter((r) => r.metadata?.is_keyboard_secondary === true)
        .map((r) => steps.filter((s) => s.branch === r.value));
      const secondary = secondaryStepGroups.flat();
      const lanes: WorkflowTemplateStep[][] = [main, secondary];
      let lane = 0;
      let idx = 0;
      outer: for (let i = 0; i < lanes.length; i++) {
        for (let j = 0; j < (lanes[i]?.length ?? 0); j++) {
          if (lanes[i]![j]?.id === activeStepId) { lane = i; idx = j; break outer; }
        }
      }
      let next: WorkflowTemplateStep | undefined;
      switch (event.key) {
        case 'ArrowRight':
          next = lanes[lane]?.[idx + 1];
          break;
        case 'ArrowLeft':
          next = lanes[lane]?.[idx - 1];
          break;
        case 'ArrowDown':
          next = lanes[lane + 1]?.[Math.min(idx, (lanes[lane + 1]?.length ?? 1) - 1)];
          break;
        case 'ArrowUp':
          next = lanes[lane - 1]?.[Math.min(idx, (lanes[lane - 1]?.length ?? 1) - 1)];
          break;
        case 'Home':
          next = lanes[lane]?.[0];
          break;
        case 'End':
          next = lanes[lane]?.[(lanes[lane]?.length ?? 1) - 1];
          break;
        default:
          return;
      }
      if (next) {
        event.preventDefault();
        setActiveStepId(next.id);
      }
    },
    [activeTemplate, activeStepId],
  );


  function openVersionMenu() {
    if (!activeTemplate) return;
    const versions = activeTemplate.versions || [activeTemplate.version];
    palette.open({
      placeholder: t('workflowTemplates.version.placeholder'),
      items: versions.map((v, i) => ({
        label: `${v === activeVersion ? '✓ ' : '  '}${v}`,
        key: v,
        section: i === 0 ? t('workflowTemplates.version.current') : t('workflowTemplates.version.history'),
        meta: i === 0 ? t('workflowTemplates.version.active') : t('workflowTemplates.version.archived'),
      })),
      onPick: (it) => {
        const picked = String(it.key);
        setActiveVersion(picked);
        pushToast(fill(t('workflowTemplates.version.viewing'), { version: picked }), 'info');
      },
    });
  }

  function openValidationDrawer() {
    drawer.open({
      title: t('workflowTemplates.validation.drawerTitle'),
      size: 'md',
      body: (
        <div>
          <p className="state__hint">
            {t('workflowTemplates.validation.drawerHint')}
          </p>
          <ul className="wf-issues">
            {validationIssues.map((iss, i) => (
              <li key={i}>
                {iss.stepId ? (
                  <button
                    type="button"
                    className="wf-issues__step"
                    onClick={() => {
                      setActiveStepId(iss.stepId);
                      drawer.close();
                    }}
                  >
                    {compactReference(iss.stepId)}
                  </button>
                ) : null}
                <span>{iss.msg}</span>
              </li>
            ))}
          </ul>
        </div>
      ),
    });
  }

  async function openDiffModal() {
    if (!activeTemplate) return;
    const source = workflowTemplateSourceCandidate(activeTemplate, scopedTemplates);
    if (!source) {
      pushToast(t('workflowTemplates.diff.noLineage'), 'info');
      return;
    }
    const sourceVersion = source.version ?? 'source';
    const currentVersion = activeTemplate.version;
    let diff: api.WorkflowTemplateVersionDiffResult;
    try {
      diff = await api.workflow_template_version_diff_v1({
        workflow_template_id: activeTemplate.id,
        source_workflow_template_id: source.id,
      });
    } catch (err) {
      pushToast(t('workflowTemplates.diff.loadFailed'), 'danger');
      return;
    }
    const added = recordArray(diff.added_steps);
    const removed = recordArray(diff.removed_steps);
    const modified = recordArray(diff.modified_steps);
    const unchanged = recordArray(diff.unchanged_steps);
    const renderStepRow = (step: Record<string, unknown>, tone?: string, index = 0) => (
      <div
        key={`${stringValue(step.id) ?? stringValue(step.sequence_order) ?? stringValue(step.operation_name) ?? 'step'}-${index}`}
        className="wf-diff-row"
      >
        <span className="mono">{compactReferenceText(step.sequence_order ?? step.id)}</span>
        <span>{stringValue(step.label) ?? stringValue(step.operation_name) ?? t('workflowTemplates.diff.workflowStep')}</span>
        {tone ? <Chip label={t(`workflowTemplates.diff.tone.${tone}`)} kind={tone === 'modified' ? 'warn' : tone === 'added' ? 'good' : 'neutral'} size="xs" /> : null}
      </div>
    );
    modal.open({
      title: fill(t('workflowTemplates.diff.title'), { name: activeTemplate.name }),
      body: (
        <div>
          <div className="wf-diff-bar">
            <span className="mono">{sourceVersion}</span>
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              →
            </span>
            <span className="mono">{currentVersion}</span>
            <Chip
              label={fill(t('workflowTemplates.diff.sourceSteps'), { count: Number(diff.source_step_count ?? removed.length + modified.length + unchanged.length) })}
              kind="neutral"
              size="xs"
            />
            <Chip
              label={fill(t('workflowTemplates.diff.currentSteps'), { count: Number(diff.current_step_count ?? added.length + modified.length + unchanged.length) })}
              kind="neutral"
              size="xs"
            />
          </div>
          <div className="wf-diff-grid">
            <div className="wf-diff-pane">
              <div className="wf-insp__section-eyebrow">{fill(t('workflowTemplates.diff.source'), { version: sourceVersion })}</div>
              {removed.length || modified.length || unchanged.length ? (
                <>
                  {removed.map((step, index) => renderStepRow(step, 'removed', index))}
                  {modified.map((entry, index) => renderStepRow(recordValue(entry.source), 'modified', index))}
                  {unchanged.map((step, index) => renderStepRow(step, undefined, index))}
                </>
              ) : (
                <StateView kind="empty" title={t('workflowTemplates.diff.noSourceTitle')} hint={t('workflowTemplates.diff.noSourceHint')} />
              )}
            </div>
            <div className="wf-diff-pane">
              <div className="wf-insp__section-eyebrow">{fill(t('workflowTemplates.diff.current'), { version: currentVersion })}</div>
              {added.length || modified.length || unchanged.length ? (
                <>
                  {added.map((step, index) => renderStepRow(step, 'added', index))}
                  {modified.map((entry, index) => renderStepRow(recordValue(entry.current), 'modified', index))}
                  {unchanged.map((step, index) => renderStepRow(step, undefined, index))}
                </>
              ) : (
                <StateView kind="empty" title={t('workflowTemplates.diff.noCurrentTitle')} hint={t('workflowTemplates.diff.noCurrentHint')} />
              )}
            </div>
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            label={fill(t('workflowTemplates.diff.restore'), { version: sourceVersion })}
            kind="ghost"
            capability={CAP.WORKFLOWS_WRITE}
            disabled={restoreTemplateVersion.isPending}
            onClick={async () => {
              try {
                const result = await restoreTemplateVersion.mutateAsync({
                  workflow_template_id: activeTemplate.id,
                  source_workflow_template_id: source.id,
                  reason: `Console Template Studio restore from ${sourceVersion}`,
                });
                await Promise.all([templatesQuery.refetch(), directoryQuery.refetch()]);
                const resultRecord = result as Record<string, unknown>;
                const restoredVersion =
                  stringValue(resultRecord.restored_version)
                  ?? stringValue(resultRecord.current_version)
                  ?? currentVersion;
                setActiveVersion(restoredVersion);
                setStepEdits({});
                setPendingStepFocusId(null);
                setActiveStepId(null);
                setPromotionReadback(null);
                setRestoreReadback({
                  templateId: activeTemplate.id,
                  templateLabel: activeTemplate.name,
                  sourceTemplateId: source.id,
                  sourceVersion,
                  restoredVersion,
                  restoredStepCount: numberValue(resultRecord.restored_step_count) ?? null,
                  correlationId: stringValue(resultRecord.correlation_id) ?? null,
                  requestedAt: new Date().toISOString(),
                });
                modal.close();
                pushToast(fill(t('workflowTemplates.diff.restored'), { name: activeTemplate.name, version: sourceVersion }), 'good');
              } catch (err) {
                pushToast(t('workflowTemplates.diff.restoreFailed'), 'danger');
              }
            }}
          />
          <Button label={t('workflowTemplates.common.close')} kind="ghost" onClick={() => modal.close()} />
        </div>
      ),
    });
  }

  function openTriggerComposer() {
    if (!activeTemplate) return;
    const triggerStep =
      activeTemplate.steps?.find(isTriggerStep)
      ?? activeTemplate.steps?.[0]
      ?? activeStep
      ?? null;
    modal.open({
      title: t('workflowTemplates.trigger.title'),
      body: (
        <TriggerComposerPreview
          template={activeTemplate}
          events={events}
          durationFormatPolicy={durationFormatPolicy}
          onSave={async ({ triggerEvent, conditions, conditionJsonLogic }) => {
            if (!triggerStep) {
              pushToast(t('workflowTemplates.trigger.noStep'), 'danger');
              return false;
            }
            return patchStep(triggerStep.id, {
              condition_jsonlogic: conditionJsonLogic,
              metadata: {
                ...(triggerStep.metadata ?? {}),
                trigger_event: triggerEvent,
                trigger_conditions: conditions,
              },
            });
          }}
        />
      ),
      footer: <Button label={t('workflowTemplates.common.close')} kind="ghost" onClick={() => modal.close()} />,
    });
  }

  function openNewTemplate() {
    // Cycle E (Workflows P2 #9) — initial trigger value resolves from the
    // canonical `workflow_binding_event` lookup head (rank-ordered). The
    // previous hardcoded `'custom.event'` literal violated AGENTS.md §2
    // (ZERO HARDCODING) + §4 (SSOT). When the lookup is empty, the modal
    // renders a fail-loud StateView (mirrors bindings.tsx:1115-1128).
    const eventLookup = api.getLookups('workflow_binding_event') as Array<{
      value: string;
      label?: string;
    }>;
    if (eventLookup.length === 0) {
      modal.open({
        title: t('workflowTemplates.create.title'),
        body: (
          <StateView
            kind="error"
            title={t('workflowTemplates.create.noTriggersTitle')}
            hint={t('workflowTemplates.create.noTriggersHint')}
          />
        ),
        actions: [],
      });
      return;
    }
    let name = '';
    let trigger = String(eventLookup[0]!.value);
    modal.open({
      title: t('workflowTemplates.create.title'),
      body: (
        <div>
          <p className="state__hint">
            {t('workflowTemplates.create.intro')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '8px',
              alignItems: 'center',
            }}
          >
            <label className="mono">{t('workflowTemplates.create.name')}</label>
            <input
              className="dt-inline-input"
              placeholder={t('workflowTemplates.create.namePlaceholder')}
              onChange={(e) => {
                name = e.target.value;
              }}
            />
            <label className="mono">{t('workflowTemplates.create.triggerEvent')}</label>
            {/*
              W27 Cycle D closure: trigger event picker reads strictly from
              the canonical `workflow_binding_event` lookup. Replaces the
              inline literal `<option>` array (AGENTS.md §2 ZERO HARDCODING +
              §4 SSOT). Values are sorted canonically by the lookup `rank`.
            */}
            <select
              className="dt-inline-input"
              defaultValue={trigger}
              onChange={(e) => {
                trigger = e.target.value;
              }}
            >
              {eventLookup.map((row) => (
                <option key={String(row.value)} value={String(row.value)}>
                  {String(row.label ?? row.value)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowTemplates.common.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowTemplates.create.create')}
            kind="primary"
            capability={CAP.WORKFLOWS_WRITE}
            onClick={async () => {
              try {
                const result = await createTemplate.mutateAsync({
                  name: name || 'untitled',
                  trigger: trigger || null,
                  ...(isUuidText(activeTenantId)
                    ? { scope_type: 'tenant', scope_id: activeTenantId }
                    : {}),
                });
                await Promise.all([templatesQuery.refetch(), directoryQuery.refetch()]);
                focusWorkflowTemplateMutationResult(result);
                const resultRecord = result as Record<string, unknown>;
                const nextTemplateId =
                  stringValue(resultRecord.workflow_template_id) ?? stringValue(resultRecord.id);
                if (nextTemplateId) {
                  setRestoreReadback(null);
                  setPromotionReadback({
                    kind: 'create',
                    templateId: nextTemplateId,
                    templateLabel: name || 'untitled',
                    expectedStatus: stringValue(resultRecord.status) ?? null,
                    correlationId: stringValue(resultRecord.correlation_id) ?? null,
                    requestedAt: new Date().toISOString(),
                  });
                }
                modal.close();
                pushToast(
                  fill(t('workflowTemplates.create.created'), { name: name || 'untitled', event: displayLookupLabel('workflow_binding_event', trigger) }),
                  'good',
                );
              } catch (err) {
                pushToast(t('workflowTemplates.create.failed'), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  async function createWorkflowStepFromOperation(
    op: api.OperationTemplate,
    opts: { firstStep?: boolean } = {},
  ) {
    if (!activeTemplate) return;
    const steps = activeTemplate.steps ?? [];
    const activeIndex = activeStep
      ? steps.findIndex((s) => s.id === activeStep.id)
      : -1;
    const sequenceOrder = opts.firstStep
      ? 1
      : activeIndex >= 0
        ? activeIndex + 2
        : steps.length + 1;
    const branch = opts.firstStep
      ? resolveDefaultWorkflowBranchKind()
      : activeStep?.branch ?? resolveDefaultWorkflowBranchKind();
    const result = await createTemplateStep.mutateAsync({
      workflow_template_id: activeTemplate.id,
      step: {
        operation_name: op.operation_name,
        kind: op.kind,
        label: op.operation_name,
        sub: op.description || op.category,
        branch: branch || undefined,
        sequence_order: sequenceOrder,
        ...(opts.firstStep && activeTemplate.trigger
          ? { metadata: { trigger_event: activeTemplate.trigger } }
          : {}),
      },
    });
    setStepEdits({});
    setPendingStepFocusId(result.workflow_template_step_id);
    setActiveStepId(result.workflow_template_step_id);
    pushToast(
      fill(opts.firstStep ? t('workflowTemplates.steps.triggerCreated') : t('workflowTemplates.steps.created'), { operation: op.operation_name }),
      'good',
    );
  }

  function openAddStepPalette(opts: { firstStep?: boolean } = {}) {
    if (!activeTemplate) return;
    if (!canWrite) {
      pushToast(t('workflowTemplates.toast.createPermission'), 'danger');
      return;
    }
    const operations = opts.firstStep ? opsCatalog.filter(isTriggerOperation) : opsCatalog;
    if (!operations.length) {
      pushToast(
        opts.firstStep
          ? t('workflowTemplates.steps.noTriggerOperations')
          : t('workflowTemplates.steps.noOperations'),
        'danger',
      );
      return;
    }
    palette.open({
      placeholder: opts.firstStep ? t('workflowTemplates.steps.addFirstPlaceholder') : t('workflowTemplates.steps.addPlaceholder'),
      items: operations.map((op) => ({
        label: op.operation_name,
        key: op.id,
        section: op.category,
        meta: op.kind,
        value: op,
      })),
      onPick: async (it) => {
        const op = it.value as api.OperationTemplate | undefined;
        if (!op) return;
        try {
          await createWorkflowStepFromOperation(op, { firstStep: opts.firstStep });
        } catch (err) {
          pushToast(t('workflowTemplates.steps.createFailed'), 'danger');
        }
      },
    });
  }

  async function duplicateActiveStep() {
    if (!activeTemplate || !activeStep) return;
    if (!canWrite) {
      pushToast(t('workflowTemplates.toast.duplicatePermission'), 'danger');
      return;
    }
    try {
      const result = await duplicateTemplateStep.mutateAsync({
        workflow_template_id: activeTemplate.id,
        workflow_template_step_id: activeStep.id,
      });
      setStepEdits({});
      setPendingStepFocusId(result.workflow_template_step_id);
      setActiveStepId(result.workflow_template_step_id);
      pushToast(fill(t('workflowTemplates.steps.duplicated'), { label: activeStep.label }), 'good');
    } catch (err) {
      pushToast(t('workflowTemplates.steps.duplicateFailed'), 'danger');
    }
  }

  function confirmDeleteActiveStep() {
    if (!activeTemplate || !activeStep) return;
    modal.open({
      title: fill(t('workflowTemplates.steps.deleteTitle'), { label: activeStep.label }),
      body: (
        <p className="state__hint">
          {t('workflowTemplates.steps.deleteHint')}
        </p>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowTemplates.common.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowTemplates.steps.delete')}
            kind="danger"
            capability={CAP.WORKFLOWS_WRITE}
            onClick={async () => {
              try {
                const steps = activeTemplate.steps ?? [];
                const currentIndex = steps.findIndex((s) => s.id === activeStep.id);
                const nextStep =
                  steps[currentIndex + 1] ?? steps[currentIndex - 1] ?? null;
                await deleteTemplateStep.mutateAsync({
                  workflow_template_id: activeTemplate.id,
                  workflow_template_step_id: activeStep.id,
                });
                setStepEdits((prev) => {
                  const next = { ...prev };
                  delete next[activeStep.id];
                  return next;
                });
                setActiveStepId(nextStep?.id ?? null);
                modal.close();
                pushToast(fill(t('workflowTemplates.steps.deleted'), { label: activeStep.label }), 'good');
              } catch (err) {
                pushToast(t('workflowTemplates.steps.deleteFailed'), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  async function pinActiveStepSampleData() {
    if (!activeTemplate || !activeStep) return;
    const requestedAt = new Date().toISOString();
    const samplePin = {
      pinned_at: requestedAt,
      pinned_by_user_id: identity.user?.id || null,
      workflow_template_id: activeTemplate.id,
      workflow_template_step_id: activeStep.id,
      source: 'console_v2.workflow_template_step_action',
    };
    const metadata = {
      ...(activeStep.metadata ?? {}),
      console_sample_pin: samplePin,
    };
    const ok = await patchStep(activeStep.id, { metadata });
    if (!ok) return;
    setPromotionReadback(null);
    setRestoreReadback(null);
    setStepActionReadback({
      actionLabel: t('workflowTemplates.steps.pinSample'),
      templateId: activeTemplate.id,
      templateLabel: activeTemplate.name,
      stepId: activeStep.id,
      stepLabel: activeStep.label,
      requestedAt,
      metadata: samplePin,
    });
  }

  function openActiveStepDecisionTrail() {
    if (!activeTemplate || !activeStep) return;
    drawer.open(
      buildDecisionTrailDrawerSpec(
        {
          id: activeStep.id,
          workflow_template_id: activeTemplate.id,
          workflow_template_step_id: activeStep.id,
          resource_id: activeStep.id,
          resource_type: 'workflow_template_step',
          label: activeStep.label,
          name: activeStep.label,
        },
        'workflow template step',
        undefined,
        t,
      ),
    );
  }

  function openStepActions() {
    if (!activeStep || !activeTemplate) return;
    // Cycle E2 (Workflows P1 #10) — step-actions palette is row-driven
    // from the canonical `workflow_step_action` lookup. Each row carries
    // `metadata.section` (palette grouping) and `metadata.handler_kind`
    // (canonical action key). The dispatch table is a registry keyed by
    // `handler_kind` so adding a new action is a single seed insert plus
    // a registry entry — no inline literal palette items left.
    type StepActionRow = {
      value: string;
      label: string;
      metadata?: { section?: string; handler_kind?: string };
    };
    const stepActionRows = api.getLookups('workflow_step_action') as StepActionRow[];
    if (!stepActionRows.length) {
      pushToast(
        t('workflowTemplates.steps.actionsMissing'),
        'danger',
      );
      return;
    }
    const handlers: Record<string, () => void> = {
      duplicate: () => {
        void duplicateActiveStep();
      },
      delete: () => confirmDeleteActiveStep(),
      convert_error: () => {
        const errorBranch = resolveErrorWorkflowBranchKind();
        if (!errorBranch) {
          pushToast(t('workflowTemplates.steps.errorBranchMissing'), 'danger');
          return;
        }
        void patchStep(activeStep.id, { branch: errorBranch });
      },
      pin_sample: () => {
        void pinActiveStepSampleData();
      },
      view_runs: () => {
        navigateToWorkflowRuns({
          template: activeTemplate.id,
          step: activeStep.id,
        });
      },
      decision_trail: () => openActiveStepDecisionTrail(),
    };
    palette.open({
      placeholder: t('workflowTemplates.steps.actionsPlaceholder'),
      items: stepActionRows.map((row) => ({
        label: row.label,
        key: row.metadata?.handler_kind ?? row.value,
        section: row.metadata?.section ?? t('workflowTemplates.steps.actionSection'),
      })),
      onPick: (it) => {
        const handler = handlers[String(it.key)];
        if (handler) handler();
      },
    });
  }

  function promptErrorPath() {
    if (!activeTemplate || !activeStep) return;
    // W62-Workflows (Cycle F-R-2 P1-3) — error-branch candidates resolve
    // canonically through `workflow_branch_kind.<branch>.metadata.is_error_branch`.
    // Replaces the literal `s.branch === 'error'` so the error-branch
    // recogniser is row-driven and a single seed update redirects the
    // promptErrorPath palette to a renamed error-branch key.
    const candidates = (activeTemplate.steps || []).filter(
      (s) => (lookupRow('workflow_branch_kind', s.branch ?? '') as { metadata?: { is_error_branch?: boolean } } | null)?.metadata?.is_error_branch === true
    );
    palette.open({
      placeholder: t('workflowTemplates.config.onError'),
      items: [
        { label: t('workflowTemplates.steps.clear'), key: '__clear__', section: t('workflowTemplates.steps.actionSection') },
        ...candidates.map((s) => ({
          label: `${compactReferenceText(s.id)} · ${s.label}`,
          key: s.id,
          section: t('workflowTemplates.steps.errorBranch'),
        })),
      ],
      onPick: (it) => {
        const next = it.key === '__clear__' ? undefined : String(it.key);
        patchStep(activeStep.id, { error_path: next });
      },
    });
  }

  function viewRunsForTemplate() {
    if (!activeTemplate) return;
    navigateToWorkflowRuns({ template: activeTemplate.id });
  }

  function openTestPanelInline() {
    setInspectorTab('test');
    // The Test tab renders inside the right-pane Inspector, which only shows
    // step-level content once an operator clicks a step on the canvas. If
    // nothing is selected the click looked silent (Inspector kept showing
    // "No step selected"). Surface an explicit toast so the operator knows
    // what to do next.
    if (!activeStep) {
      pushToast(
        t('workflowTemplates.steps.selectForTest'),
        'info',
      );
    }
  }

  if (!canRead) {
    return (
      <div className="page wf-studio">
        <PageHeader
          moduleKey="wf-templates"
          eyebrow={t('workflowTemplates.header.eyebrow')}
          titleAccent={t('workflowTemplates.header.accent')}
          titlePlain={t('workflowTemplates.header.plain')}
        />
        <StateView
          kind="denied"
          capability={CAP.WORKFLOWS_READ}
          hint={t('workflowTemplates.header.denied')}
        />
      </div>
    );
  }

  if (templatesQuery.isLoading) {
    return (
      <div className="page wf-studio">
        <PageHeader
          moduleKey="wf-templates"
          eyebrow={t('workflowTemplates.header.eyebrow')}
          titleAccent={t('workflowTemplates.header.accent')}
          titlePlain={t('workflowTemplates.header.plain')}
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (templatesQuery.error) {
    return (
      <div className="page wf-studio">
        <PageHeader
          moduleKey="wf-templates"
          eyebrow={t('workflowTemplates.header.eyebrow')}
          titleAccent={t('workflowTemplates.header.accent')}
          titlePlain={t('workflowTemplates.header.plain')}
          pills={[]}
        />
        <StateView kind="error" hint={String(templatesQuery.error)} />
      </div>
    );
  }

  if (!templates.length || !activeTemplate) {
    return (
      <div className="page wf-studio">
        <PageHeader
          moduleKey="wf-templates"
          eyebrow={t('workflowTemplates.header.eyebrow')}
          titleAccent={t('workflowTemplates.header.accent')}
          titlePlain={t('workflowTemplates.header.plain')}
          pills={[]}
          actions={[
            <Button
              key="new"
              label={t('workflowTemplates.create.title')}
              iconName="plus"
              kind="primary"
              onClick={openNewTemplate}
            />,
          ]}
        />
        <StateView
          kind="empty"
          title={t('workflowTemplates.header.emptyTitle')}
          hint={t('workflowTemplates.header.emptyHint')}
        />
        {modal.node}
        {drawer.node}
        {palette.node}
      </div>
    );
  }

  const lastRun = lastRunByTemplate.get(activeTemplate.id);
  const activeTemplateDirectory = directoryByTemplateId.get(activeTemplate.id) ?? null;
  const promotionTemplate = promotionReadback
    ? scopedTemplates.find((template) => template.id === promotionReadback.templateId) ?? null
    : null;
  const promotionDirectory = promotionReadback
    ? directoryByTemplateId.get(promotionReadback.templateId) ?? null
    : null;
  const promotionDirectoryStatus = stringValue(promotionDirectory?.status);
  const promotionStatus = promotionDirectoryStatus ?? promotionTemplate?.status ?? null;
  const promotionStepCount = numberValue(promotionDirectory?.step_count) ?? null;
  const promotionSourceLineage = stringValue(recordValue(promotionTemplate?.metadata).source_template_id);
  const promotionHasExpectedStepReadback =
    promotionReadback?.expectedStepCount == null ||
    promotionReadback.expectedStepCount <= 0 ||
    (promotionStepCount != null && promotionStepCount === promotionReadback.expectedStepCount);
  const promotionHasExpectedSourceReadback =
    promotionReadback?.kind !== 'publish' ||
    !promotionReadback.sourceTemplateId ||
    promotionSourceLineage === promotionReadback.sourceTemplateId;
  const promotionConfirmed = promotionReadback
    ? promotionReadback.kind === 'status'
      ? Boolean(promotionDirectory)
        && promotionStatus === promotionReadback.expectedStatus
        && (
          promotionReadback.expectedStatus !== 'active' ||
          promotionDirectory?.is_published === true
        )
      : promotionReadback.kind === 'create'
        ? Boolean(promotionTemplate)
          && promotionHasExpectedStepReadback
          && (
            !promotionReadback.expectedStatus ||
            promotionStatus === promotionReadback.expectedStatus ||
            promotionTemplate?.status === promotionReadback.expectedStatus
          )
      : Boolean(promotionDirectory) && promotionHasExpectedStepReadback && promotionHasExpectedSourceReadback
    : false;
  const restoredTemplate = restoreReadback
    ? scopedTemplates.find((template) => template.id === restoreReadback.templateId) ?? null
    : null;
  const restoredDirectory = restoreReadback
    ? directoryByTemplateId.get(restoreReadback.templateId) ?? null
    : null;
  const restoredStepCount = numberValue(restoredDirectory?.step_count) ?? null;
  const restoredVersion =
    restoredTemplate?.version
    ?? (restoredDirectory?.version != null ? String(restoredDirectory.version) : null);
  const restoredSourceLineage = stringValue(recordValue(restoredTemplate?.metadata).source_template_id)
    ?? stringValue(recordValue(restoredTemplate?.metadata).restored_from_template_id);
  const restoreHasExpectedStepReadback =
    restoreReadback?.restoredStepCount == null ||
    restoreReadback.restoredStepCount <= 0 ||
    (restoredStepCount != null && restoredStepCount === restoreReadback.restoredStepCount);
  const restoreConfirmed = restoreReadback
    ? Boolean(restoredDirectory)
      && restoreHasExpectedStepReadback
      && restoredVersion === restoreReadback.restoredVersion
      && restoredSourceLineage === restoreReadback.sourceTemplateId
    : false;

  return (
    <div className="page wf-studio">
      <header className="wf-topbar">
        <div className="wf-topbar__brand">
          <span className="wf-topbar__eyebrow mono">{t('workflowTemplates.topbar.eyebrow')}</span>
          <span className="wf-topbar__title">{t('workflowTemplates.topbar.title')}</span>
        </div>
        <div className="wf-topbar__crumb mono">
          {compactReference(activeTemplate.template_id)}
          <span style={{ opacity: 0.4, margin: '0 6px' }}>·</span>
          <button
            type="button"
            className="wf-topbar__version"
            onClick={openVersionMenu}
            title={t('workflowTemplates.topbar.versionTitle')}
          >
            <span>{activeVersion}</span>
            <span style={{ fontSize: '8px', opacity: 0.6, marginLeft: '4px' }}>
              ▾
            </span>
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {validationIssues.length ? (
          <button
            type="button"
            className="wf-topbar__issues"
            onClick={openValidationDrawer}
            title={t('workflowTemplates.topbar.issuesTitle')}
          >
            <Icon name="warn" size={12} />
            <span>{fill(validationIssues.length === 1 ? t('workflowTemplates.topbar.issueOne') : t('workflowTemplates.topbar.issueOther'), { count: validationIssues.length })}</span>
          </button>
        ) : (
          <span className="wf-topbar__valid">
            <Icon name="check" size={11} />
            <span>{t('workflowTemplates.topbar.valid')}</span>
          </span>
        )}
        <Button label={t('workflowTemplates.topbar.diff')} iconName="list" kind="ghost" onClick={openDiffModal} />
        <Button label={t('workflowTemplates.topbar.viewRuns')} iconName="right" kind="ghost" onClick={viewRunsForTemplate} />
        <Button
          label={t('workflowTemplates.topbar.addStep')}
          iconName="plus"
          kind="ghost"
          onClick={() => openAddStepPalette()}
          capability={CAP.WORKFLOWS_WRITE}
          disabled={createTemplateStep.isPending}
        />
        {(() => {
          // Cycle E2 (Workflows P1 #5) — Activate/Deactivate label + next
          // status are row-driven from `workflow_status.metadata.toggle_to`
          // + `metadata.toggle_label`. Replaces the inline ternary and the
          // `next = 'active' ? 'inactive' : 'active'` literal branch.
          // Missing canonical row → button stays disabled with a danger
          // chip-style label so the operator sees the gap.
          // W61 (Workflows P2-3) — `toggle_icon` is also row-driven so the
          // Activate-vs-Deactivate icon is sourced from canonical metadata
          // instead of an inline `toggleTo === 'active' ? 'check' : 'lock'`
          // literal compare. Missing canonical metadata → button stays
          // disabled with a danger-chip-style label so the gap surfaces.
          const statusRow = lookupRow('workflow_status', activeTemplate.status) as
            | { metadata?: { toggle_to?: string; toggle_label?: string; toggle_icon?: string; toggle_kind?: string } }
            | null;
          const toggleTo = statusRow?.metadata?.toggle_to;
          const toggleLabel = statusRow?.metadata?.toggle_label;
          const toggleIcon = statusRow?.metadata?.toggle_icon;
          const toggleKind = buttonKindFromLookup(statusRow?.metadata?.toggle_kind);
          if (!toggleTo || !toggleLabel || !toggleIcon || !toggleKind) {
            return (
              <Button
                label={missingSetupLabel(t('workflowTemplates.topbar.statusActionMissing'), activeTemplate.status)}
                iconName="warn"
                kind="ghost"
                disabled
                capability={CAP.WORKFLOWS_WRITE}
              />
            );
          }
          return (
            <Button
              label={toggleLabel}
              iconName={toggleIcon}
              kind={toggleKind}
              capability={CAP.WORKFLOWS_WRITE}
              onClick={async () => {
                try {
                  await setTemplateStatus.mutateAsync({
                    template_id: activeTemplate.id,
                    status: toggleTo as 'active' | 'inactive',
                  });
                  await Promise.all([templatesQuery.refetch(), directoryQuery.refetch()]);
                  setRestoreReadback(null);
                  setPromotionReadback({
                    kind: 'status',
                    templateId: activeTemplate.id,
                    templateLabel: activeTemplate.name,
                    expectedStatus: toggleTo,
                    requestedAt: new Date().toISOString(),
                  });
                  const verb = lookupRow('workflow_status', toggleTo)?.label ?? toggleTo;
                  pushToast(`${verb} - ${activeTemplate.name}`, 'good');
                } catch (err) {
                  pushToast(
                    t('workflowTemplates.topbar.statusFailed'),
                    'danger',
                  );
                }
              }}
            />
          );
        })()}
        <Button
          label={t('workflowTemplates.topbar.testRun')}
          iconName="play"
          kind="ghost"
          onClick={openTestPanelInline}
          capability={CAP.WORKFLOWS_WRITE}
        />
        <Button
          label={t('workflowTemplates.topbar.publish')}
          iconName="check"
          kind="ghost"
          onClick={async () => {
            try {
              const cloneName = workflowTemplatePublishCloneName(activeTemplate);
              const result = await createTemplate.mutateAsync({
                name: cloneName,
                clone_from: activeTemplate.id,
                ...(isUuidText(activeTenantId)
                  ? { scope_type: 'tenant', scope_id: activeTenantId }
                  : {}),
              });
              await Promise.all([templatesQuery.refetch(), directoryQuery.refetch()]);
              focusWorkflowTemplateMutationResult(result);
              const resultRecord = result as Record<string, unknown>;
              const nextTemplateId = stringValue(resultRecord.workflow_template_id) ?? stringValue(resultRecord.id);
              if (nextTemplateId) {
                setRestoreReadback(null);
                setPromotionReadback({
                  kind: 'publish',
                  templateId: nextTemplateId,
                  templateLabel: cloneName,
                  sourceTemplateId: activeTemplate.id,
                  expectedStatus: stringValue(resultRecord.status) ?? null,
                  expectedStepCount: activeTemplate.steps?.length ?? null,
                  correlationId: stringValue(resultRecord.correlation_id) ?? null,
                  requestedAt: new Date().toISOString(),
                });
              }
              pushToast(
                fill(t('workflowTemplates.topbar.cloneCreated'), { name: cloneName, ref: compactReferenceText(activeTemplate.id) }),
                'good',
              );
            } catch (err) {
              pushToast(t('workflowTemplates.topbar.publishFailed'), 'danger');
            }
          }}
          capability={CAP.WORKFLOWS_WRITE}
        />
        <Button
          label={t('workflowTemplates.create.title')}
          iconName="plus"
          kind="primary"
          onClick={openNewTemplate}
          capability={CAP.WORKFLOWS_WRITE}
        />
      </header>
      {promotionReadback ? (
        <section
          className="wf-promotion-readback"
          data-testid="workflow-template-promotion-readback"
          aria-label={t('workflowTemplates.readback.promotionAria')}
        >
          <div className="wf-promotion-readback__head">
            <div>
              <div className="wf-promotion-readback__label">{t('workflowTemplates.readback.promotionTitle')}</div>
              <strong>{promotionReadback.templateLabel}</strong>
            </div>
            <Chip
              label={promotionConfirmed ? t('workflowTemplates.readback.confirmed') : t('workflowTemplates.readback.waiting')}
              kind={promotionConfirmed ? 'good' : 'info'}
              size="xs"
            />
          </div>
          <div className="wf-promotion-readback__grid">
            <div>
              <span>{t('workflowTemplates.readback.action')}</span>
              <div>
                {promotionReadback.kind === 'publish'
                  ? t('workflowTemplates.readback.cloneDraft')
                  : promotionReadback.kind === 'create'
                    ? t('workflowTemplates.readback.createDraft')
                    : t('workflowTemplates.readback.statusChange')}
              </div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.template')}</span>
              <div className="wf-promotion-readback__wrap">{t('workflowTemplates.readback.templateRecorded')}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.status')}</span>
              <div>
                {promotionStatus ? (
                  <Chip
                    label={lookupRow('workflow_status', promotionStatus)?.label ?? promotionStatus}
                    kind={(lookupRow('workflow_status', promotionStatus)?.tone as ChipKind | undefined) ?? 'neutral'}
                    size="xs"
                  />
                ) : (
                  <span>{t('workflowTemplates.readback.awaiting')}</span>
                )}
              </div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.published')}</span>
              <div>{promotionDirectory?.is_published ? t('workflowTemplates.readback.yes') : t('workflowTemplates.readback.no')}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.stepsBindings')}</span>
              <div>
                {promotionDirectory
                  ? `${promotionDirectory.step_count} / ${promotionDirectory.binding_count}${
                    promotionReadback.expectedStepCount != null
                      ? ` ${fill(t('workflowTemplates.readback.expectedSteps'), { count: promotionReadback.expectedStepCount })}`
                      : ''
                  }`
                  : t('workflowTemplates.readback.awaiting')}
              </div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.requested')}</span>
              <div>{promotionReadback.requestedAt}</div>
            </div>
          </div>
          {promotionReadback.kind === 'publish' || promotionReadback.correlationId ? (
            <div className="wf-promotion-readback__meta">
              {promotionReadback.kind === 'publish' ? (
                <>
                  {t('workflowTemplates.readback.sourceRecorded')}
                  {promotionSourceLineage ? (
                    <>
                      {' '}{t('workflowTemplates.readback.sourceConfirmed')}
                    </>
                  ) : null}
                </>
              ) : null}
              {promotionReadback.correlationId ? <> {t('workflowTemplates.readback.referenceRecorded')}</> : null}
            </div>
          ) : null}
          {activeTemplateDirectory && activeTemplate.id === promotionReadback.templateId ? (
            <div className="wf-promotion-readback__status" role="status">
              {t('workflowTemplates.readback.focusedSelected')}
            </div>
          ) : null}
        </section>
      ) : null}
      {restoreReadback ? (
        <section
          className="wf-promotion-readback"
          data-testid="workflow-template-restore-readback"
          aria-label={t('workflowTemplates.readback.restoreAria')}
        >
          <div className="wf-promotion-readback__head">
            <div>
              <div className="wf-promotion-readback__label">{t('workflowTemplates.readback.restoreTitle')}</div>
              <strong>{restoreReadback.templateLabel}</strong>
            </div>
            <Chip
              label={restoreConfirmed ? t('workflowTemplates.readback.confirmed') : t('workflowTemplates.readback.waiting')}
              kind={restoreConfirmed ? 'good' : 'info'}
              size="xs"
            />
          </div>
          <div className="wf-promotion-readback__grid">
            <div>
              <span>{t('workflowTemplates.readback.action')}</span>
              <div>{t('workflowTemplates.readback.restoreVersion')}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.template')}</span>
              <div className="wf-promotion-readback__wrap">{t('workflowTemplates.readback.templateRecorded')}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.version')}</span>
              <div>
                {restoredVersion ?? t('workflowTemplates.readback.awaiting')}
                {restoreReadback.restoredVersion ? ` ${fill(t('workflowTemplates.readback.expected'), { value: restoreReadback.restoredVersion })}` : ''}
              </div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.steps')}</span>
              <div>
                {restoredStepCount != null
                  ? `${restoredStepCount}${restoreReadback.restoredStepCount != null ? ` ${fill(t('workflowTemplates.readback.expected'), { value: restoreReadback.restoredStepCount })}` : ''}`
                  : t('workflowTemplates.readback.awaiting')}
              </div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.source')}</span>
              <div className="wf-promotion-readback__wrap">{t('workflowTemplates.readback.sourceRecorded')}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.requested')}</span>
              <div>{restoreReadback.requestedAt}</div>
            </div>
          </div>
          <div className="wf-promotion-readback__meta">
            {fill(t('workflowTemplates.readback.sourceVersion'), { version: restoreReadback.sourceVersion ?? t('workflowTemplates.readback.unknown') })}
            {restoredSourceLineage ? (
              <>
                {' '}{t('workflowTemplates.readback.sourceConfirmed')}
              </>
            ) : null}
            {restoreReadback.correlationId ? <> {t('workflowTemplates.readback.referenceRecorded')}</> : null}
          </div>
          {activeTemplateDirectory && activeTemplate.id === restoreReadback.templateId ? (
            <div className="wf-promotion-readback__status" role="status">
              {t('workflowTemplates.readback.focusedRestored')}
            </div>
          ) : null}
        </section>
      ) : null}
      {stepActionReadback ? (
        <section
          className="wf-promotion-readback"
          data-testid="workflow-template-step-action-readback"
          aria-label={t('workflowTemplates.readback.stepAria')}
        >
          <div className="wf-promotion-readback__head">
            <div>
              <div className="wf-promotion-readback__label">{t('workflowTemplates.readback.stepTitle')}</div>
              <strong>{stepActionReadback.stepLabel}</strong>
            </div>
            <Chip label={t('workflowTemplates.readback.confirmed')} kind="good" size="xs" />
          </div>
          <div className="wf-promotion-readback__grid">
            <div>
              <span>{t('workflowTemplates.readback.action')}</span>
              <div>{stepActionReadback.actionLabel}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.template')}</span>
              <div className="wf-promotion-readback__wrap">{t('workflowTemplates.readback.templateRecorded')}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.step')}</span>
              <div className="wf-promotion-readback__wrap">{t('workflowTemplates.readback.stepRecorded')}</div>
            </div>
            <div>
              <span>{t('workflowTemplates.readback.requested')}</span>
              <div>{stepActionReadback.requestedAt}</div>
            </div>
          </div>
          <div className="wf-promotion-readback__meta">
            {t('workflowTemplates.readback.stepSettingsRecorded')}
          </div>
        </section>
      ) : null}
      <div className="wf-body">
        <aside className="wf-palette">
          <div className="wf-palette__search">
            <Icon name="search" size={12} />
            <input
              type="text"
              placeholder={
                paletteTab === 'templates'
                  ? t('workflowTemplates.palette.searchTemplates')
                  : paletteTab === 'operations'
                    ? t('workflowTemplates.palette.searchOperations')
                    : t('workflowTemplates.palette.snippetsTitle')
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t('workflowTemplates.palette.searchAria')}
            />
          </div>
          <div className="wf-palette__tabs">
            <div role="tablist" aria-label={t('workflowTemplates.palette.sectionsAria')} style={{ display: 'contents' }}>
              <button
                type="button"
                role="tab"
                id="wf-palette-tab-templates"
                aria-selected={paletteTab === 'templates'}
                aria-controls="wf-palette-panel"
                tabIndex={paletteTab === 'templates' ? 0 : -1}
                className={`wf-palette__tab ${paletteTab === 'templates' ? 'is-active' : ''}`}
                onClick={() => setPaletteTab('templates')}
              >
                {t('workflowTemplates.palette.templates')}
              </button>
              <button
                type="button"
                role="tab"
                id="wf-palette-tab-operations"
                aria-selected={paletteTab === 'operations'}
                aria-controls="wf-palette-panel"
                tabIndex={paletteTab === 'operations' ? 0 : -1}
                className={`wf-palette__tab ${paletteTab === 'operations' ? 'is-active' : ''}`}
                onClick={() => setPaletteTab('operations')}
                title={t('workflowTemplates.palette.operationsTitle')}
              >
                {t('workflowTemplates.palette.operations')}
              </button>
              <button
                type="button"
                role="tab"
                id="wf-palette-tab-snippets"
                aria-selected={paletteTab === 'snippets'}
                aria-controls="wf-palette-panel"
                tabIndex={paletteTab === 'snippets' ? 0 : -1}
                className={`wf-palette__tab ${paletteTab === 'snippets' ? 'is-active' : ''}`}
                onClick={() => setPaletteTab('snippets')}
                disabled
                title={t('workflowTemplates.palette.snippetsUnavailable')}
              >
                {t('workflowTemplates.palette.snippets')}
              </button>
            </div>
            <button
              type="button"
              className="wf-palette__tab"
              onClick={openTriggerComposer}
              title={t('workflowTemplates.palette.triggersTitle')}
            >
              {t('workflowTemplates.palette.triggers')}
            </button>
          </div>
          <div
            className="wf-palette__list"
            id="wf-palette-panel"
            role="tabpanel"
            aria-labelledby={
              paletteTab === 'templates'
                ? 'wf-palette-tab-templates'
                : paletteTab === 'operations'
                  ? 'wf-palette-tab-operations'
                  : 'wf-palette-tab-snippets'
            }
          >
            {paletteTab === 'templates'
              ? filteredTemplates.map((tpl) => {
                  const matched = runs.filter((r) => workflowRunTemplateId(r) === tpl.id);
                  const last = matched[0];
                  // W22 — additive: pass the canonical directory projection
                  // row when available so counters source from the SSOT seam.
                  const directoryRow = directoryByTemplateId.get(tpl.id) ?? null;
                  return (
                    <TemplateCard
                      key={tpl.id}
                      template={tpl}
                      isActive={tpl.id === activeTemplate.id}
                      matchedRunsCount={matched.length}
                      lastRunStatus={last?.status}
                      directoryRow={directoryRow}
                      onClick={() => selectTemplate(tpl)}
                    />
                  );
                })
              : paletteTab === 'operations'
                ? (() => {
                    const q = search.toLowerCase();
                    const filtered = q
                      ? opsCatalog.filter(
                          (op) =>
                            op.operation_name.toLowerCase().includes(q) ||
                            op.category.toLowerCase().includes(q),
                        )
                      : opsCatalog;
                    if (!filtered.length) {
                      return (
                        <StateView
                          kind="empty"
                          title={t('workflowTemplates.palette.noOperationsTitle')}
                          hint={t('workflowTemplates.palette.noOperationsHint')}
                        />
                      );
                    }
                    return filtered.map((op) => (
                      <button
                        key={op.id}
                        type="button"
                        className="wf-tpl-card"
                        onClick={async () => {
                          if (!canWrite) {
                            pushToast(fill(t('workflowTemplates.palette.bindPermission'), { operation: op.operation_name }), 'danger');
                            return;
                          }
                          if (!activeStep) {
                            pushToast(fill(t('workflowTemplates.palette.selectStep'), { operation: op.operation_name }), 'info');
                            return;
                          }
                          await patchStep(activeStep.id, { op: op.operation_name });
                        }}
                        title={op.description}
                      >
                        <div className="wf-tpl-card__row1">
                          <span className="wf-tpl-card__name mono">{op.operation_name}</span>
                          {(() => {
                            const r = kindTone(op.kind);
                            return r.tone && r.label
                              ? <Chip label={r.label} kind={r.tone} size="xs" />
                              : <Chip label={missingSetupLabel(t('workflowTemplates.config.stepTypeMissing'), op.kind)} kind="danger" size="xs" />;
                          })()}
                        </div>
                        <div className="wf-tpl-card__row2 mono">{op.category}</div>
                        <div className="wf-tpl-card__row3">
                          <span className="wf-tpl-card__runs mono">{fill(t('workflowTemplates.palette.timeout'), { seconds: op.timeout_seconds })}</span>
                        </div>
                      </button>
                    ));
                  })()
                : (
                    <StateView
                      kind="empty"
                      title={t('workflowTemplates.palette.snippetsTitle')}
                      hint={t('workflowTemplates.palette.snippetsHint')}
                    />
                  )}
          </div>
        </aside>
        <section
          className="wf-canvas-wrap"
          tabIndex={0}
          role="region"
          aria-label={t('workflowTemplates.palette.canvasAria')}
          onKeyDown={onCanvasKeyDown}
        >
          <Canvas
            template={activeTemplate}
            activeStepId={activeStepId}
            lastRun={lastRun}
            onSelectStep={(id) => setActiveStepId(id)}
            onAddFirstStep={() => openAddStepPalette({ firstStep: true })}
            isCreatingStep={createTemplateStep.isPending}
            layout={canvasLayout}
          />
        </section>
        <Inspector
          template={activeTemplate}
          step={activeStep}
          events={events}
          runs={runs}
          inspectorTab={inspectorTab}
          opsCatalog={opsCatalog}
          layout={canvasLayout}
          durationFormatPolicy={durationFormatPolicy}
          onChangeTab={setInspectorTab}
          onPatchStep={patchStep}
          onOpenStepActions={openStepActions}
          onPromptErrorPath={promptErrorPath}
          onOpenRun={(runId) => navigateToWorkflowRuns({ focus: runId })}
        />
      </div>
      {drawer.node}
      {modal.node}
      {palette.node}
      {/* Hidden helpers to keep imports honest in the bundler */}
      <span style={{ display: 'none' }}>
        <Icon name="check" size={1} />
      </span>
    </div>
  );
}

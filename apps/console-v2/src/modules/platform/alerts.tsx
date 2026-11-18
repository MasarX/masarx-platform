// platform/alerts.tsx — CLAIM-PLATFORM-ALERTS (Wave 3, Phase C).
//
// Operator alerts management surface — Datadog/PagerDuty/Sentry parity.
// DataTable + Editor drawer that consumes the SHARED nested AND/OR/NOT
// JSONLogic condition builder primitive from
// `src/modules/workflows/_bindings/condition-model.ts`. This is a cross-module
// reuse: this module imports + uses the primitive but does NOT modify it (the
// shared primitive now serves both bindings and alerts; documented in
// __audit__/COVERAGE/PLATFORM-ALERTS.md).
//
// Backend invariants honored:
//   - Reads via `useResourceList('alert_rules' | 'alert_triggers' | 'ops_alerts')`
//     - typed through `lib/api` and gated by `alerts.read`.
//   - All write actions (`New rule`, `Pause`, `Resume`, `Delete`) are gated
//     by `alerts.write` via the shared `<Button capability={CAP.ALERTS_WRITE}>`.
//   - The `Test rule` action is read-only (uses `alerts.read`). It evaluates
//     the live condition tree against a sample picker over the rule's recent
//     alert_triggers payloads (or a manually pasted JSON payload) and shows
//     PASS/FAIL chips per row + an overall result.
//   - The `condition` column on alert_rules round-trips through the legacy
//     flat shape (`{field: value}`) so the same shared editor primitive
//     consumed by workflow_bindings renders correctly without breaking either
//     surface.
//
// Operator UX:
//   - KPI strip: total rules / enabled / triggered today / open ops_alerts.
//   - Page-header actions: "New rule" (alerts.write) / "Test rule"
//     (alerts.read; opens the most recently selected rule in test mode).
//   - DataTable: rule name + condition summary + severity chip + channel +
//     last triggered (relative time + age chip) + enabled toggle.
//   - Row actions: Edit / Test / Pause-Resume / Delete (capability-gated).
//   - Editor drawer (open via row click or "New rule"): tabs for
//     Condition / Severity & channel / Triggers history / Active alerts.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CAP } from "@/lib/capabilities";
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { Dot, type DotKind } from '@/components/Dot';
import { KPICard } from '@/components/KPICard';
import { lookupRow } from '@/lib/api';
import { StateView } from '@/components/StateView';
import {
  DataTable,
  type DataTableColumn,
  type DataTableAction,
} from '@/components/DataTable';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useCreateAlertRule,
  useUpdateAlertRule,
  usePauseAlertRule,
  useResumeAlertRule,
  useDeleteAlertRule,
  useTestAlertRule,
  useAcknowledgeOpsAlert,
  useResolveOpsAlert,
  useResolveSettings,
} from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { getLookups } from '@/lib/api';
// Shared cross-module primitive — the same nested AND/OR/NOT JSONLogic
// condition builder primitive consumed by workflow_bindings. CONSUME-ONLY:
// do not modify the shared file. See __audit__/COVERAGE/PLATFORM-ALERTS.md.
import {
  type ConditionGroup,
  type ConditionLeaf,
  type ConditionNode,
  type Operator,
  NULLARY_OPS,
  MAX_DEPTH,
  discoverFields,
  evalCondition,
  fromLegacyFlat,
  inferType,
  makeGroup,
  makeLeaf,
  operatorsFor,
  summarize as summarizeNode,
  toJsonLogic,
  toLegacyFlatIfPossible,
  validate,
  valueSamples,
} from '@/modules/workflows/_bindings/condition-model';

// ---------- Domain types (UI-shaped) ----------
//
// SCHEMA-DRIFT NOTE (Wave 6 / W6-6 — see __audit__/SCHEMA-DRIFT/PLATFORM.md §1-§3):
// FE row interfaces below are documented FE-friendly shapes over canonical
// alert tables. The actual REMOVE/RENAME work is deferred to G1 because the
// AlertTrigger interface depends on a backend gap resolution (no canonical
// `alert_triggers` table — may map to ops_alerts via registry alias) and
// AlertRule renames (`name` → `rule_name`, `condition` → `trigger_conditions`)
// cascade through alerts.tsx body, alert seed, and drawer renders.

// W13-3 — canonical column names (`rule_name`, `trigger_conditions`,
// `alert_channels`) surfaced as additive optional fields. Full rename
// cascade still deferred per W10-5 closure; lookup-FK semantics for
// `severity` (literal vs alert_severity_lookup_id FK) tracked on the audit.
//
// W14-7 close-out — dropped FE-fictional `last_triggered_at` (PLATFORM.md §1).
// `alert_rules` has NO `last_triggered_at` column; canonical resolution is
// `MAX(alert_triggers.fired_at) WHERE rule_id = alert_rules.id`. The FE now
// derives this value via `lastTriggeredAtOf(rule, triggers)` in `decoratedRules`,
// so the row interface no longer surfaces a top-level alias and the seed no
// longer carries the fictional column.
// W28 — `AlertRuleDirectoryRow` mirrors the SQL view
// `public.v_alert_rule_directory` (supabase/migrations/202604302600_v_alert_rule_directory.sql).
// Read-only projection; pairs with `AlertRule` (canonical SSOT row interface)
// for derivation-heavy operator decorations (severity_label / created_by_label
// / condition_summary / last_triggered_at / trigger_count_24h / is_throttled /
// is_paused). Consumed additively — `AlertRule` remains the canonical seam.
interface AlertRuleDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id: string | null;
  rule_name: string;
  enabled: boolean;
  priority: number;
  trigger_source: string | null;
  trigger_conditions: Record<string, unknown> | null;
  throttle_window_minutes: number;
  alert_channels: string[];
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  // W28 projections (derived; not on alert_rules SSOT directly).
  severity_label: string | null;
  created_by_label: string | null;
  created_by_email: string | null;
  condition_summary: string;
  alert_channels_count: number;
  last_triggered_at: string | null;
  trigger_count_24h: number;
  ack_count_24h: number;
  resolved_count_24h: number;
  is_throttled: boolean;
  is_paused: boolean;
}

interface AlertRule extends Record<string, unknown> {
  id: string;                         // SSOT: alert_rules.id
  organization_id: string;            // SSOT: alert_rules.organization_id
  name: string;                       // Legacy alias for alert_rules.rule_name
  rule_name?: string;                 // SSOT: alert_rules.rule_name (canonical)
  /** Legacy flat condition shape (`{field: value}`). Stored verbatim so we can
   *  round-trip through the shared editor primitive without breaking either
   *  surface. */
  condition: Record<string, unknown> | null;  // Legacy alias for alert_rules.trigger_conditions
  trigger_conditions?: Record<string, unknown> | null;  // SSOT: alert_rules.trigger_conditions (canonical)
  severity: 'info' | 'warn' | 'critical' | string;  // SSOT: projection from alert_severity_lookup_id (FE renders literal; backend stores FK)
  channel: 'slack' | 'email' | 'pagerduty' | 'webhook' | string;  // Legacy alias — canonical is alert_rules.alert_channels (jsonb array)
  alert_channels?: string[];          // SSOT: alert_rules.alert_channels (canonical jsonb array)
  enabled: boolean;                   // SSOT: alert_rules.enabled
  created_by?: string;                // SSOT: alert_rules.created_by (uuid; FE displays string)
  created_at?: string;                // SSOT: alert_rules.created_at
}

/** W14-7 — Resolve "last triggered at" from canonical sibling reads.
 *  `alert_rules` has no such column; canonical resolution joins through
 *  `alert_triggers` and aggregates `MAX(fired_at)` per `rule_id`. */
function lastTriggeredAtOf(
  rule: { id: string },
  triggers: ReadonlyArray<{ rule_id: string; fired_at: string }>,
): string | null {
  let max: string | null = null;
  for (const t of triggers) {
    if (t.rule_id !== rule.id) continue;
    if (max === null || Date.parse(t.fired_at) > Date.parse(max)) {
      max = t.fired_at;
    }
  }
  return max;
}

// W13-5 — closes PLATFORM alert_triggers FE-shape gap (W7 audit + W10-5 deferred).
// SSOT: `public.alert_triggers` (migration 202510110003) — canonical columns
// are (alert_rule_id, organization_id, resource_type, resource_id, severity,
// message, context, notified_at, acknowledged_by, acknowledged_at,
// resolution_notes, timestamp). The FE-friendly shape is exposed via the
// paired projection view `public.v_alert_trigger_summary` (migration
// 202604301700) which projects alert_rule_id→rule_id, timestamp→fired_at,
// context→payload, and derives status (fired|acknowledged|resolved|silenced)
// from acknowledged_at/resolution_notes/context flags. The FE consumes via
// `useResourceList('alert_triggers')`; production swap is a single
// registry-key→view alias on the read seam.
interface AlertTrigger extends Record<string, unknown> {
  id: string;                         // SSOT: alert_triggers.id
  rule_id: string;                    // Projection alias for alert_triggers.alert_rule_id
  fired_at: string;                   // Projection alias for alert_triggers.timestamp
  payload: Record<string, unknown>;   // Projection alias for alert_triggers.context
  status: 'fired' | 'acknowledged' | 'resolved' | 'silenced' | string;  // Derived from acknowledged_at/resolution_notes/context flags via v_alert_trigger_summary
}

// W13-3 — canonical column aliases (`created_at`, `alert_type`) surfaced
// alongside legacy FE field names (`opened_at`, `source`).
//
// Ops-alert lifecycle reads canonical top-level columns first and keeps the
// older `details.resolved_at` projection as a fixture/backfill fallback.
interface OpsAlert extends Record<string, unknown> {
  id: string;                         // SSOT: ops_alerts.id
  severity: string;                   // SSOT: ops_alerts.severity
  opened_at: string;                  // Legacy alias for ops_alerts.created_at
  created_at?: string;                // SSOT: ops_alerts.created_at (canonical)
  /** Canonical jsonb column from `public.ops_alerts.details` — projection
   *  source for FE-derived lifecycle fields like `resolved_at`. */
  details?: Record<string, unknown> | null;  // SSOT: ops_alerts.details (canonical jsonb)
  // Canonical column from `public.ops_alerts` (migration 202512011801) — used
  // by the drawer Acknowledge / Resolve actions to gate the "Ack" CTA so
  // already-acknowledged alerts do not re-prompt.
  acknowledged_at?: string | null;    // SSOT: ops_alerts.acknowledged_at
  resolved_at?: string | null;        // SSOT: ops_alerts.resolved_at
  source: string;                     // Legacy alias for ops_alerts.alert_type
  alert_type?: string;                // SSOT: ops_alerts.alert_type (canonical)
  message: string;                    // SSOT: ops_alerts.message
}

/** W14-7/ops-alert-resolve — resolve from canonical top-level
 *  `ops_alerts.resolved_at`, with details jsonb kept as a legacy projection
 *  fallback for older local fixtures. */
function resolvedAtOf(alert: OpsAlert): string | null {
  if (typeof alert.resolved_at === 'string' && alert.resolved_at) return alert.resolved_at;
  const v = alert.details?.['resolved_at'];
  if (typeof v === 'string') return v;
  return null;
}

interface DecoratedRule extends AlertRule {
  condition_summary: string;
  /** Derived projection — `MAX(alert_triggers.fired_at) WHERE rule_id = id`.
   *  Replaces the dropped FE-fictional `AlertRule.last_triggered_at` (W14-7). */
  last_triggered_at: string | null;
  last_triggered_relative: string;
  triggered_today: number;
  open_alerts: number;
}

// W54-D — option lists derive from canonical lookups SSOT
// (`alert_severity` / `alert_channel`). Modules call `getLookups(...)`
// instead of declaring inline TS literal arrays so adding a new severity
// tier or channel is a row mutation, not a source change. Rank-sort keeps
// the option order deterministic across surfaces. AGENTS.md §2 (ZERO
// HARDCODING) + §4 (SSOT).
function severityOptions(): Array<{ value: AlertRule['severity']; label: string }> {
  return getLookups('alert_severity')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((r) => ({ value: r.value as AlertRule['severity'], label: r.label }));
}
function channelOptions(): Array<{ value: AlertRule['channel']; label: string }> {
  return getLookups('alert_channel')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((r) => ({ value: r.value as AlertRule['channel'], label: r.label }));
}

// W-Cycle-E (P2 #5) — chip tone for the shared condition-builder
// `Issue.severity` (error|warn) resolves through the canonical
// `validation_issue_severity` lookup catalog. Replaces the inline
// `iss.severity === 'error' ? danger : warn` ternary at the two render sites.
// Missing canonical row falls through to `neutral` so the gap is visible.
function issueSeverityKind(severity: 'error' | 'warn'): ChipKind {
  const tone = lookupRow('validation_issue_severity', severity)?.tone as
    | ChipKind
    | undefined;
  return tone ?? 'neutral';
}

// W-Cycle-E2 (P2 #7) — The previous `SAMPLE_PAYLOAD_FALLBACK` constant has
// been removed. The canonical sample payload now resolves strictly through
// `useResolveSettings('alert_rule_test_payload_template')` (`policies.js#sv_390`).
// When the policy is missing, TestRuleBody surfaces a `(missing-policy)` chip
// rather than masking the gap with an inline default.

// ---------- Helpers ----------

function summarizeFlat(c: Record<string, unknown> | null | undefined): string {
  if (!c || !Object.keys(c).length) return '— always —';
  return summarizeNode(fromLegacyFlat(c));
}

function relativeFromNow(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const ms = Date.now() - t;
  if (ms < 0) return 'in the future';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// W-Cycle-E2 (P2 #8) — `ageChip` accepts canonical thresholds resolved from
// `alerts_age_thresholds` settings policy (`policies.js#sv_391`). Previous
// implementation hardcoded the 60-min/24-hour bins inline. When thresholds
// are missing, the chip surfaces a `(missing-policy)` neutral marker rather
// than masking the gap. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
interface AlertsAgeThresholds {
  minor_minutes: number;
  major_hours: number;
}

function ageChip(
  iso: string | null | undefined,
  thresholds: AlertsAgeThresholds | null,
): { label: string; kind: 'good' | 'warn' | 'danger' | 'neutral' } {
  if (!iso) return { label: 'never', kind: 'neutral' };
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { label: 'unknown', kind: 'neutral' };
  if (!thresholds) {
    return { label: 'age (missing-policy)', kind: 'neutral' };
  }
  const ms = Date.now() - t;
  const min = ms / 60000;
  if (min < thresholds.minor_minutes) return { label: 'fresh', kind: 'danger' };
  if (min < thresholds.minor_minutes * thresholds.major_hours) return { label: 'recent', kind: 'warn' };
  return { label: 'old', kind: 'good' };
}

function sourceToRuleId(src: string | undefined | null): string | null {
  if (!src || !src.startsWith('rule:')) return null;
  return src.slice('rule:'.length);
}

// ---------- Condition Builder (consumes shared primitive) ----------

interface ConditionBuilderProps {
  rule: DecoratedRule;
  triggers: AlertTrigger[];
  onSave: (cond: Record<string, unknown> | null, jsonlogic: unknown) => void;
  onCancel: () => void;
}

function OperatorPicker({
  op,
  field,
  triggers,
  onChange,
}: {
  op: Operator;
  field: string;
  triggers: AlertTrigger[];
  onChange: (op: Operator) => void;
}) {
  // Treat trigger payloads as the field-discovery and type-inference corpus,
  // mirroring the bindings editor's `recent_workflow_events` source.
  const eventsLike = useMemo(
    () => triggers.map((t) => ({ payload: t.payload })),
    [triggers],
  );
  const samples = useMemo(() => valueSamples(field, eventsLike), [field, eventsLike]);
  const inferred = useMemo(() => inferType(samples), [samples]);
  const opts = operatorsFor(inferred);
  return (
    <select
      className="dt-inline-input"
      value={op}
      onChange={(e) => onChange(e.target.value as Operator)}
      aria-label="Operator"
    >
      {opts.map((o) => (
        <option key={o} value={o}>
          {o.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}

function ConditionRow({
  node,
  pathLabel,
  fieldOptions,
  triggers,
  onChange,
  onRemove,
  evalPass,
  evalTotal,
  issue,
}: {
  node: ConditionLeaf;
  pathLabel: string;
  fieldOptions: string[];
  triggers: AlertTrigger[];
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
  evalPass: number;
  evalTotal: number;
  issue: { severity: 'error' | 'warn'; message: string } | null;
}) {
  const datalistId = `alerts-cond-fields-${pathLabel.replace(/\W+/g, '-')}`;
  return (
    <div
      className="wf-cond-row wf-cond-row--rich"
      data-severity={issue?.severity ?? 'ok'}
      data-testid="alerts-cond-row"
    >
      <input
        list={datalistId}
        className="dt-inline-input mono"
        value={node.field}
        onChange={(e) => onChange({ ...node, field: e.target.value })}
        aria-label="Field"
        placeholder="payload.field"
      />
      <datalist id={datalistId}>
        {fieldOptions.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <OperatorPicker
        op={node.op}
        field={node.field}
        triggers={triggers}
        onChange={(op) => onChange({ ...node, op })}
      />
      <input
        className="dt-inline-input"
        type="text"
        value={node.value}
        placeholder={NULLARY_OPS.includes(node.op) ? 'n/a' : 'value'}
        disabled={NULLARY_OPS.includes(node.op)}
        onChange={(e) => onChange({ ...node, value: e.target.value })}
        aria-label="Value"
      />
      <div className="wf-cond-row__meta">
        <Chip
          label={evalTotal === 0 ? 'no sample' : `${evalPass}/${evalTotal} pass`}
          kind={evalTotal === 0 ? 'neutral' : evalPass === evalTotal ? 'good' : evalPass === 0 ? 'danger' : 'warn'}
          size="xs"
        />
        {issue ? (
          <Chip
            label={issue.message}
            kind={issueSeverityKind(issue.severity)}
            size="xs"
            title={issue.message}
          />
        ) : null}
      </div>
      <button
        type="button"
        className="icon-btn"
        title="Remove row"
        aria-label="Remove condition row"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

function GroupBlock({
  node,
  path,
  depth,
  fieldOptions,
  triggers,
  onChange,
  onRemove,
  isRoot,
  issues,
}: {
  node: ConditionGroup;
  path: number[];
  depth: number;
  fieldOptions: string[];
  triggers: AlertTrigger[];
  onChange: (next: ConditionGroup) => void;
  onRemove?: () => void;
  isRoot?: boolean;
  issues: ReturnType<typeof validate>;
}) {
  function patchChild(idx: number, child: ConditionNode | null) {
    if (child === null) {
      onChange({ ...node, children: node.children.filter((_, i) => i !== idx) });
      return;
    }
    onChange({
      ...node,
      children: node.children.map((c, i) => (i === idx ? child : c)),
    });
  }

  function addLeaf() {
    onChange({ ...node, children: [...node.children, makeLeaf()] });
  }
  function addGroup() {
    if (depth >= MAX_DEPTH) return;
    onChange({ ...node, children: [...node.children, makeGroup('and')] });
  }

  return (
    <div
      className={`wf-cond-group ${node.combinator === 'or' ? 'wf-cond-group--or' : node.combinator === 'not' ? 'wf-cond-group--not' : ''}`}
      data-testid="alerts-cond-group"
      data-depth={depth}
    >
      <div className="wf-cond-group__head">
        <select
          className="dt-inline-input wf-cond-group__combinator"
          value={node.combinator}
          onChange={(e) =>
            onChange({ ...node, combinator: e.target.value as 'and' | 'or' | 'not' })
          }
          aria-label="Combinator"
        >
          <option value="and">ALL of (AND)</option>
          <option value="or">ANY of (OR)</option>
          <option value="not">NONE of (NOT)</option>
        </select>
        <span className="state__hint" style={{ fontSize: '11px' }}>
          {node.combinator === 'not'
            ? 'Pass when the inner expression is false.'
            : node.combinator === 'or'
              ? 'Pass when at least one row passes.'
              : 'Pass when every row passes.'}
        </span>
        <div style={{ flex: 1 }} />
        {!isRoot && onRemove ? (
          <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove group">
            ×
          </button>
        ) : null}
      </div>
      <div className="wf-cond-group__body">
        {node.children.length === 0 ? (
          <div className="state__hint" style={{ padding: '6px 4px' }}>
            Empty group — add a row.
          </div>
        ) : (
          node.children.map((child, idx) => {
            const childPath = [...path, idx];
            const childIssue =
              issues.find(
                (i) =>
                  i.path.length === childPath.length &&
                  i.path.every((p, k) => p === childPath[k]),
              ) || null;
            if (child.kind === 'group') {
              return (
                <GroupBlock
                  key={idx}
                  node={child}
                  path={childPath}
                  depth={depth + 1}
                  fieldOptions={fieldOptions}
                  triggers={triggers}
                  onChange={(next) => patchChild(idx, next)}
                  onRemove={() => patchChild(idx, null)}
                  issues={issues}
                />
              );
            }
            const passCount = triggers.filter((t) => evalCondition(child, t.payload)).length;
            return (
              <ConditionRow
                key={idx}
                node={child}
                pathLabel={childPath.join('-')}
                fieldOptions={fieldOptions}
                triggers={triggers}
                onChange={(next) => patchChild(idx, next)}
                onRemove={() => patchChild(idx, null)}
                evalPass={passCount}
                evalTotal={triggers.length}
                issue={childIssue ? { severity: childIssue.severity, message: childIssue.message } : null}
              />
            );
          })
        )}
        <div className="wf-cond-group__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={addLeaf}
            disabled={node.combinator === 'not' && node.children.length >= 1}
          >
            + Row
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={addGroup}
            disabled={depth >= MAX_DEPTH || (node.combinator === 'not' && node.children.length >= 1)}
            title={depth >= MAX_DEPTH ? `Max depth ${MAX_DEPTH}` : 'Add nested group'}
          >
            + Group
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionEditor({ rule, triggers, onSave, onCancel }: ConditionBuilderProps) {
  const [tree, setTree] = useState<ConditionGroup>(() => fromLegacyFlat(rule.condition));

  const sourceTriggers = triggers.filter((t) => t.rule_id === rule.id);
  const recentForRule = sourceTriggers.length ? sourceTriggers : triggers;

  const fieldOptions = useMemo(
    () => discoverFields(recentForRule.map((t) => ({ payload: t.payload }))),
    [recentForRule],
  );

  const issues = useMemo(() => validate(tree), [tree]);
  const errors = issues.filter((i) => i.severity === 'error');
  const jsonlogic = useMemo(() => toJsonLogic(tree), [tree]);
  const flatLegacy = useMemo(() => toLegacyFlatIfPossible(tree), [tree]);

  const totalSample = recentForRule.length;
  const overallPass = useMemo(
    () => recentForRule.filter((t) => evalCondition(tree, t.payload)).length,
    [tree, recentForRule],
  );

  function save() {
    if (errors.length) {
      pushToast(`Fix ${errors.length} validation error${errors.length === 1 ? '' : 's'} before saving`, 'danger');
      return;
    }
    onSave(flatLegacy ?? { jsonlogic }, jsonlogic);
  }

  return (
    <div className="wf-cond-builder" data-testid="alerts-cond-builder">
      <p className="state__hint">
        Visual condition builder (AND / OR / NOT). Conditions are stored as
        legacy flat shape on <span className="mono">alert_rules.condition</span>{' '}
        when round-trippable, otherwise as JSONLogic. Same primitive used by{' '}
        <span className="mono">workflow_bindings</span>.
      </p>
      <div className="wf-cond-builder__grid">
        <div className="wf-cond-builder__main">
          <div className="section-eyebrow">Conditions</div>
          <GroupBlock
            node={tree}
            path={[]}
            depth={0}
            fieldOptions={fieldOptions}
            triggers={recentForRule}
            onChange={(next) => setTree(next)}
            isRoot
            issues={issues}
          />
        </div>
        <aside className="wf-cond-builder__aside">
          <div className="section-eyebrow">Live evaluation</div>
          <div className="wf-cond-aside__metric">
            <Chip
              label={
                totalSample === 0
                  ? 'No recent triggers for this rule'
                  : `${overallPass} / ${totalSample} recent triggers match`
              }
              kind={
                totalSample === 0
                  ? 'neutral'
                  : overallPass === totalSample
                    ? 'good'
                    : overallPass === 0
                      ? 'danger'
                      : 'info'
              }
              size="xs"
            />
          </div>
          <div className="section-eyebrow">Rule preview</div>
          <div className="wf-code-block" data-testid="alerts-cond-rule-preview">
            {summarizeNode(tree)}
          </div>
          <div className="section-eyebrow">Validation</div>
          <div className="wf-cond-issues">
            {issues.length === 0 ? (
              <div className="state__hint">All rows look good.</div>
            ) : (
              issues.map((iss, k) => (
                <div key={k} className="wf-cond-issue">
                  <Chip
                    label={lookupRow('validation_issue_severity', iss.severity)?.label ?? iss.severity}
                    kind={issueSeverityKind(iss.severity)}
                    size="xs"
                  />
                  <span style={{ fontSize: '11.5px' }}>
                    {iss.path.length ? `[${iss.path.join('.')}] ` : ''}
                    {iss.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
      <div className="section-eyebrow">Test against recent triggers</div>
      <div className="wf-recent-events">
        {recentForRule.length === 0 ? (
          <div className="state__hint">No recent triggers for this rule</div>
        ) : (
          recentForRule.slice(0, 5).map((t) => {
            const matches = evalCondition(tree, t.payload);
            return (
              <div key={t.id} className="wf-recent-event-row" data-testid="alerts-cond-test-row">
                <Dot kind={matches ? 'good' : 'danger'} />
                <span className="mono" style={{ width: '110px' }}>
                  {t.id}
                </span>
                <span style={{ flex: 1, fontSize: '11.5px', color: 'var(--ink-2)' }}>
                  {JSON.stringify(t.payload).slice(0, 60)}
                </span>
                <Chip
                  label={matches ? 'pass' : 'fail'}
                  kind={matches ? 'good' : 'neutral'}
                  size="xs"
                />
              </div>
            );
          })
        )}
      </div>
      <div className="wf-cond-builder__footer">
        <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
          {errors.length ? `${errors.length} blocker${errors.length === 1 ? '' : 's'}` : 'Ready to save'}
        </span>
        <div style={{ flex: 1 }} />
        <Button label="Cancel" kind="ghost" onClick={onCancel} />
        <Button label="Save" kind="primary" capability={CAP.ALERTS_WRITE} onClick={save} />
      </div>
    </div>
  );
}

// ---------- Test Rule modal body (sample picker + manual payload) ----------

interface TestRuleBodyProps {
  rule: DecoratedRule;
  triggers: AlertTrigger[];
}

function TestRuleBody({ rule, triggers }: TestRuleBodyProps) {
  const ruleTriggers = triggers.filter((t) => t.rule_id === rule.id);
  // W-Cycle-E2 (P2 #7) — sample payload resolves strictly through canonical
  // `alert_rule_test_payload_template` policy. When the policy is missing
  // (no inline fallback), the modal surfaces a `(missing-policy)` chip and
  // seeds the editor with `{}` so the operator gap is visible.
  const { data: tmplResolution } = useResolveSettings('alert_rule_test_payload_template', undefined);
  const tmplPayload =
    tmplResolution &&
    typeof tmplResolution.value === 'object' &&
    tmplResolution.value !== null &&
    'payload' in (tmplResolution.value as Record<string, unknown>)
      ? (tmplResolution.value as { payload: unknown }).payload
      : null;
  const policyMissing = !tmplPayload;
  const samplePayloadDefault = tmplPayload
    ? JSON.stringify(tmplPayload, null, 2)
    : '{}';
  const [payloadText, setPayloadText] = useState<string>(() =>
    ruleTriggers.length
      ? JSON.stringify(ruleTriggers[0]!.payload, null, 2)
      : samplePayloadDefault,
  );

  const tree = useMemo(() => fromLegacyFlat(rule.condition), [rule.condition]);

  const parsed = useMemo<{ ok: true; value: Record<string, unknown> } | { ok: false; err: string }>(() => {
    try {
      return { ok: true, value: JSON.parse(payloadText) as Record<string, unknown> };
    } catch (err) {
      return { ok: false, err: (err as Error).message };
    }
  }, [payloadText]);

  const matches = parsed.ok ? evalCondition(tree, parsed.value) : null;

  return (
    <div data-testid="alerts-test-rule">
      <p className="state__hint">
        Read-only evaluation against the persisted rule condition. Pick a recent
        trigger payload or paste your own; preview-only (no mutation).
      </p>
      <div className="section-eyebrow">Recent trigger payloads</div>
      <div className="wf-recent-bar">
        {ruleTriggers.slice(0, 4).map((t) => (
          <button
            key={t.id}
            type="button"
            className="wf-recent-bar__btn"
            onClick={() => setPayloadText(JSON.stringify(t.payload, null, 2))}
          >
            <span className="mono">{t.id}</span>
            <span style={{ opacity: 0.6 }}>{relativeFromNow(t.fired_at)}</span>
          </button>
        ))}
        {ruleTriggers.length === 0 ? (
          <div className="state__hint">No prior triggers for this rule.</div>
        ) : null}
      </div>
      <div className="section-eyebrow">
        Payload
        {policyMissing ? (
          <Chip
            label="alert_rule_test_payload_template (missing-policy)"
            kind="danger"
            size="xs"
            className="mono"
          />
        ) : null}
        {!parsed.ok ? (
          <Chip label="invalid details" kind="danger" size="xs" />
        ) : (
          <Chip label="valid details" kind="good" size="xs" />
        )}
      </div>
      <textarea
        className="wf-code-block wf-code-block--editable"
        rows={8}
        value={payloadText}
        onChange={(e) => setPayloadText(e.target.value)}
        aria-label="Trigger details"
      />
      <div className="section-eyebrow">Result</div>
      <div style={{ padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
        {matches === null ? (
          <Chip label="invalid payload" kind="danger" size="sm" />
        ) : matches ? (
          <Chip label="PASS · would fire" kind="good" size="sm" />
        ) : (
          <Chip label="FAIL · would not fire" kind="neutral" size="sm" />
        )}
        <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
          {summarizeFlat(rule.condition)}
        </span>
      </div>
    </div>
  );
}

// ---------- Module ----------

export function AlertsModule() {
  const drawer = useDrawer();
  const modal = useModal();
  const [focusedRuleId, setFocusedRuleId] = useState<string | null>(null);

  const rulesQuery = useResourceList<AlertRule>('alert_rules');
  const triggersQuery = useResourceList<AlertTrigger>('alert_triggers');
  const opsAlertsQuery = useResourceList<OpsAlert>('ops_alerts');
  // W28 — paired projection view `public.v_alert_rule_directory`
  // (supabase/migrations/202604302600_v_alert_rule_directory.sql) surfaces
  // FE-friendly per-rule derivations: severity_label (lookup_values FK),
  // created_by_label (users FK), condition_summary (jsonb textual summary),
  // alert_channels_count, last_triggered_at + trigger_count_24h +
  // ack_count_24h + resolved_count_24h (alert_triggers aggregates),
  // is_throttled (throttle-window aware), is_paused. Consumed additively as
  // a decoration source — the canonical SSOT seam stays
  // useResourceList<AlertRule>('alert_rules') so existing Edit/Pause/Delete
  // mutations don't change shape. Production cutover: a single
  // getSupabaseClient() branch flip in ui_list_resource_v1 returns the
  // canonical projection; module consumers stay registry-driven.
  const ruleDirectoryQuery = useResourceList<AlertRuleDirectoryRow>('alert_rule_directory');

  const canRead = useCapability(CAP.ALERTS_READ);
  const canWrite = useCapability(CAP.ALERTS_WRITE);

  // W-Cycle-E2 (P2 #8) — `alerts_age_thresholds` policy. Drives the per-rule
  // `Last triggered` chip thresholds (fresh/recent/old). Strict no-fallback:
  // when missing the chip surfaces a `(missing-policy)` neutral marker.
  const ageThresholdsResolution = useResolveSettings('alerts_age_thresholds', undefined);
  const ageThresholds: AlertsAgeThresholds | null = useMemo(() => {
    const v = ageThresholdsResolution.data?.value;
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as Record<string, unknown>).minor_minutes === 'number' &&
      typeof (v as Record<string, unknown>).major_hours === 'number'
    ) {
      return v as AlertsAgeThresholds;
    }
    return null;
  }, [ageThresholdsResolution.data]);
  // W-Cycle-E2 (P2 #9) — `live_tail_buffer_size` policy. Drives the
  // alerts-side live tail cap when wired (no live tail UI in this module
  // today; resolved here so the policy seam is always loaded for cross-page
  // probes). Strict no-fallback: surfaced as `null` when missing.
  // (Reserved for future use — `live_tail_policy` is consumed today by
  // decisions.tsx + api-gateway.tsx.)

  // CLAIM-PLATFORM-ALERTS / Phase C6 — canonical mutation hooks. Each call
  // routes through the swap-seam so the FE stays a single env-flip away from
  // production. Operator messages stay friendly; diagnostics stay in the action result.
  const createMutation = useCreateAlertRule();
  const updateMutation = useUpdateAlertRule();
  const pauseMutation = usePauseAlertRule();
  const resumeMutation = useResumeAlertRule();
  const deleteMutation = useDeleteAlertRule();
  const testMutation = useTestAlertRule();
  const ackOpsMutation = useAcknowledgeOpsAlert();
  const resolveOpsMutation = useResolveOpsAlert();

  const rawRules = useMemo(() => rulesQuery.data?.rows ?? [], [rulesQuery.data]);
  const triggers = useMemo(() => triggersQuery.data?.rows ?? [], [triggersQuery.data]);
  const opsAlerts = useMemo(() => opsAlertsQuery.data?.rows ?? [], [opsAlertsQuery.data]);
  // W28 — decorate decoratedRules with v_alert_rule_directory derivations.
  // Indexed by rule id so the DataTable column renderers + drawer chips can
  // consume the projection without re-deriving in-memory aggregates.
  const ruleDirectory = useMemo(
    () => ruleDirectoryQuery.data?.rows ?? [],
    [ruleDirectoryQuery.data],
  );
  const ruleDirectoryById = useMemo(() => {
    const m = new Map<string, AlertRuleDirectoryRow>();
    for (const r of ruleDirectory) m.set(r.id, r);
    return m;
  }, [ruleDirectory]);

  // Local in-memory mutation mirror — same pattern as workflows/bindings.tsx.
  const decoratedRules = useMemo<DecoratedRule[]>(() => {
    return rawRules.map((r) => {
      const merged = r as AlertRule;
      const ruleTriggers = triggers.filter((t) => t.rule_id === r.id);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const triggered_today = ruleTriggers.filter((t) => Date.parse(t.fired_at) >= today.getTime()).length;
      // W14-7 — derive the canonical "last triggered" from the alert_triggers
      // sibling reads (MAX(fired_at) per rule_id) instead of the dropped
      // FE-fictional `AlertRule.last_triggered_at` column.
      const last_triggered_at = lastTriggeredAtOf(merged, triggers);
      const open_alerts = opsAlerts.filter(
        (a) => sourceToRuleId(a.source) === r.id && !resolvedAtOf(a),
      ).length;
      return {
        ...merged,
        condition_summary: summarizeFlat(merged.condition),
        last_triggered_at,
        last_triggered_relative: relativeFromNow(last_triggered_at),
        triggered_today,
        open_alerts,
      };
    });
  }, [rawRules, triggers, opsAlerts]);

  // ---- KPIs ----
  // W-Cycle-E (P2 #6) — KPI tone thresholds resolve through the canonical
  // `alerts_kpi_thresholds` settings policy (policies.js sv_530). Replaces
  // the inline `triggeredToday > 5` and `openOps > 0` magic literals so
  // operators can override at tenant scope. Missing canonical row falls
  // through to `neutral` so the gap is visible instead of silently using
  // FE constants.
  const { data: kpiThresholdsResolution } = useResolveSettings(
    'alerts_kpi_thresholds',
    undefined,
  );
  const kpiThresholds = (kpiThresholdsResolution?.value ?? null) as
    | { triggered_today_warn_threshold?: number; open_ops_danger_threshold?: number }
    | null;
  const kpiRows = useMemo(() => {
    const total = decoratedRules.length;
    const enabled = decoratedRules.filter((r) => r.enabled).length;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const triggeredToday = triggers.filter((t) => Date.parse(t.fired_at) >= today.getTime()).length;
    const openOps = opsAlerts.filter((a) => !resolvedAtOf(a)).length;
    const triggeredWarn = kpiThresholds?.triggered_today_warn_threshold;
    const openDanger = kpiThresholds?.open_ops_danger_threshold;
    return [
      { label: 'Alert rules', key: 'total', value: total, tone: 'neutral' as const },
      { label: 'Enabled', key: 'enabled', value: enabled, tone: 'good' as const, delta: `${total - enabled} paused` },
      {
        label: 'Triggered today',
        key: 'today',
        value: triggeredToday,
        tone:
          triggeredWarn == null
            ? ('neutral' as const)
            : triggeredToday > triggeredWarn
              ? ('warn' as const)
              : ('info' as const),
      },
      {
        label: 'Open ops alerts',
        key: 'open',
        value: openOps,
        tone:
          openDanger == null
            ? ('neutral' as const)
            : openOps > openDanger
              ? ('danger' as const)
              : ('good' as const),
      },
    ];
  }, [decoratedRules, triggers, opsAlerts, kpiThresholds]);

  // ---- Drawer / modal openers ----

  function openConditionEditor(rule: DecoratedRule) {
    modal.open({
      title: `Condition · ${rule.name}`,
      body: (
        <ConditionEditor
          rule={rule}
          triggers={triggers}
          onCancel={() => modal.close()}
          onSave={(cond) => {
            modal.close();
            updateMutation.mutate(
              { alert_rule_id: rule.id, trigger_conditions: cond as Record<string, unknown> },
              {
                onSuccess: () => pushToast(`update_alert_rule_v1 · condition saved · ${rule.name}`, 'good'),
                onError: (err: Error) => pushToast(err.message, 'danger'),
              },
            );
          }}
        />
      ),
    });
  }

  function openTestRule(rule: DecoratedRule) {
    modal.open({
      title: `Test rule · ${rule.name}`,
      body: <TestRuleBody rule={rule} triggers={triggers} />,
      footer: (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button label="Close" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Fire server test"
            iconName="play"
            kind="primary"
            capability={CAP.ALERTS_READ}
            onClick={() => {
              testMutation.mutate(
                { alert_rule_id: rule.id },
                {
                  onSuccess: () => pushToast(`Rule test completed - ${rule.name}`, 'good'),
                  onError: (err: Error) => pushToast(err.message, 'danger'),
                },
              );
            }}
          />
        </div>
      ),
    });
  }

  function openRuleDrawer(rule: DecoratedRule) {
    setFocusedRuleId(rule.id);
    const ruleTriggers = triggers.filter((t) => t.rule_id === rule.id);
    const ruleOpsAlerts = opsAlerts.filter((a) => sourceToRuleId(a.source) === rule.id);
    drawer.open({
      title: `Rule · ${rule.name}`,
      size: 'lg',
      onClose: () => setFocusedRuleId(null),
      body: (
        <div data-testid="alerts-rule-drawer">
          <div className="kvgrid">
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">Severity</span>
              <span className="kvgrid__val">
                {/* W54-D — severity tone resolves through canonical
                    `alert_severity` lookup row (info/warn/critical →
                    info/warn/danger). Missing canonical row falls through
                    to `danger` so the gap is visible, not silently masked. */}
                <Chip
                  label={lookupRow('alert_severity', rule.severity)?.label ?? rule.severity}
                  kind={(lookupRow('alert_severity', rule.severity)?.tone as ChipKind | undefined) ?? 'danger'}
                  size="xs"
                />
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">Channel</span>
              <span className="kvgrid__val mono" data-testid="alerts-rule-drawer-channel-value">
                {rule.channel}
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">Enabled</span>
              <span className="kvgrid__val">
                <Chip
                  label={rule.enabled ? 'enabled' : 'paused'}
                  kind={rule.enabled ? 'good' : 'neutral'}
                  size="xs"
                />
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">Last triggered</span>
              <span className="kvgrid__val mono">
                {rule.last_triggered_relative}
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">Created</span>
              <span className="kvgrid__val mono">
                {rule.created_at?.split('T')[0] ?? '—'}
              </span>
            </div>
          </div>

          <div className="section-eyebrow">Severity & channel</div>
          <div style={{ padding: '0 14px 8px', display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center' }}>
            <label className="mono">Severity</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {severityOptions().map((opt) => (
                <label key={opt.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="radio"
                    name={`alerts-severity-${rule.id}`}
                    value={opt.value}
                    defaultChecked={rule.severity === opt.value}
                    aria-label={`Severity ${opt.label}`}
                    disabled={!canWrite}
                    onChange={() => {
                      updateMutation.mutate(
                        { alert_rule_id: rule.id, severity: opt.value },
                        {
                          onSuccess: () => pushToast(`update_alert_rule_v1 · severity → ${opt.value}`, 'info'),
                          onError: (err: Error) => pushToast(err.message, 'danger'),
                        },
                      );
                    }}
                  />
                  <span style={{ fontSize: 12 }}>{opt.label}</span>
                </label>
              ))}
            </div>
            <label className="mono">Channel</label>
            <select
              className="dt-inline-input"
              defaultValue={rule.channel}
              aria-label="Channel"
              disabled={!canWrite}
              onChange={(e) => {
                const nextChannel = e.target.value;
                updateMutation.mutate(
                  { alert_rule_id: rule.id, alert_channels: [nextChannel] },
                  {
                    onSuccess: () => pushToast(`update_alert_rule_v1 · channel → ${nextChannel}`, 'info'),
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              }}
            >
              {channelOptions().map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="section-eyebrow">Condition</div>
          <div className="wf-code-block" data-testid="alerts-rule-cond-summary">
            {summarizeFlat(rule.condition)}
          </div>
          <div style={{ padding: '8px 14px', display: 'flex', gap: '8px' }}>
            <Button
              label="Edit condition (visual builder)"
              iconName="edit"
              kind="ghost"
              capability={CAP.ALERTS_WRITE}
              onClick={() => openConditionEditor(rule)}
            />
            <Button
              label="Test rule"
              iconName="play"
              kind="ghost"
              onClick={() => openTestRule(rule)}
            />
          </div>

          <div className="section-eyebrow">Triggers history · alert_triggers</div>
          <div className="wf-recent-events" data-testid="alerts-triggers-history">
            {ruleTriggers.length === 0 ? (
              <div className="state__hint">No prior triggers.</div>
            ) : (
              ruleTriggers.slice(0, 8).map((t) => {
                // W27-cycle-D §4 — alert_triggers lifecycle (fired|acknowledged|
                // resolved|silenced) drives both the leading status Dot and
                // the trailing label Chip. Tones resolve through the canonical
                // `alert_trigger_status` lookup catalog so adding a new status
                // upstream lights up here without code changes. ChipKind and
                // DotKind share the same tone vocabulary (good/warn/danger/
                // info/neutral) so a single resolved tone drives both
                // surfaces.
                const triggerToneRaw = lookupRow('alert_trigger_status', t.status)?.tone as
                  | string
                  | undefined;
                const dotTone: DotKind =
                  (triggerToneRaw as DotKind | undefined) ?? 'neutral';
                const chipTone: ChipKind =
                  (triggerToneRaw as ChipKind | undefined) ?? 'neutral';
                return (
                  <div key={t.id} className="wf-recent-event-row">
                    <Dot kind={dotTone} />
                    <span className="mono" style={{ width: 110 }}>{t.id}</span>
                    <span style={{ flex: 1, fontSize: 11.5, color: 'var(--ink-2)' }}>
                      {JSON.stringify(t.payload).slice(0, 60)}
                    </span>
                    <Chip label={t.status} kind={chipTone} size="xs" />
                    <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginLeft: 6 }}>
                      {relativeFromNow(t.fired_at)}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="section-eyebrow">Active alerts · ops_alerts (open + resolved)</div>
          <div className="wf-recent-events" data-testid="alerts-active-ops-alerts">
            {ruleOpsAlerts.length === 0 ? (
              <div className="state__hint">No ops alerts have been opened from this rule.</div>
            ) : (
              ruleOpsAlerts.map((a) => {
                // Read canonical top-level `resolved_at` first; older rows can
                // still project the resolved marker through `details`.
                const resolvedAt = resolvedAtOf(a);
                const acknowledged = Boolean(a.acknowledged_at);
                return (
                  <div key={a.id} className="wf-recent-event-row">
                    <Dot kind={resolvedAt ? 'good' : acknowledged ? 'warn' : 'danger'} />
                    <span className="mono" style={{ width: 200 }}>{a.id}</span>
                    <span style={{ flex: 1, fontSize: 11.5, color: 'var(--ink-2)' }}>
                      {a.message}
                    </span>
                    <Chip
                      label={resolvedAt ? 'resolved' : acknowledged ? 'acknowledged' : 'open'}
                      kind={resolvedAt ? 'good' : acknowledged ? 'warn' : 'danger'}
                      size="xs"
                    />
                    {!resolvedAt && !acknowledged ? (
                      <Button
                        label="Ack"
                        kind="ghost"
                        size="sm"
                        capability={CAP.ALERTS_WRITE}
                        onClick={() => {
                          void (async () => {
                            try {
                              await ackOpsMutation.mutateAsync({ ops_alert_id: a.id });
                              pushToast(`Ops alert acknowledged - ${a.id}`, 'good');
                            } catch (err) {
                              const message = err instanceof Error ? err.message : 'Unable to acknowledge ops alert';
                              pushToast(message, 'danger');
                            }
                          })();
                        }}
                      />
                    ) : null}
                    {!resolvedAt ? (
                      <Button
                        label="Resolve"
                        kind="ghost"
                        size="sm"
                        capability={CAP.ALERTS_WRITE}
                        onClick={() => {
                          resolveOpsMutation.mutate(
                            { ops_alert_id: a.id },
                            {
                              onSuccess: () => pushToast(`resolve_ops_alert_v1 · ${a.id}`, 'good'),
                              onError: (err: Error) => pushToast(err.message, 'danger'),
                            },
                          );
                        }}
                      />
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            label={rule.enabled ? 'Pause' : 'Resume'}
            iconName={rule.enabled ? 'pause' : 'play'}
            kind={rule.enabled ? 'ghost' : 'primary'}
            capability={CAP.ALERTS_WRITE}
            onClick={() => {
              const next = !rule.enabled;
              const mutation = next ? resumeMutation : pauseMutation;
              const verb = next ? 'resume_alert_rule_v1' : 'pause_alert_rule_v1';
              mutation.mutate(
                { alert_rule_id: rule.id },
                {
                  onSuccess: () => pushToast(`${verb} · ${rule.name}`, next ? 'good' : 'warn'),
                  onError: (err: Error) => pushToast(err.message, 'danger'),
                },
              );
              drawer.close();
            }}
          />
          <Button
            label="Delete"
            iconName="trash"
            kind="danger"
            capability={CAP.ALERTS_WRITE}
            onClick={() => {
              deleteMutation.mutate(
                { alert_rule_id: rule.id },
                {
                  onSuccess: () => pushToast(`delete_alert_rule_v1 · ${rule.name}`, 'danger'),
                  onError: (err: Error) => pushToast(err.message, 'danger'),
                },
              );
              drawer.close();
            }}
          />
        </div>
      ),
    });
  }

  useEffect(() => {
    if (!focusedRuleId || !drawer.isOpen) return;
    const latestRule = decoratedRules.find((rule) => rule.id === focusedRuleId);
    if (!latestRule) {
      drawer.close();
      return;
    }
    openRuleDrawer(latestRule);
    // The drawer body is an imperative snapshot. Re-open from the refreshed
    // backend row whenever the active read models change so drawer summaries
    // reconcile with the table without a browser reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoratedRules, triggers, opsAlerts, focusedRuleId, drawer.isOpen]);

  function openNewRule() {
    let name = 'New alert rule';
    let severity: AlertRule['severity'] = 'warn';
    let channel: AlertRule['channel'] = 'slack';
    modal.open({
      title: 'New alert rule',
      body: (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: 10,
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono">Name</label>
            <input
              className="dt-inline-input"
              type="text"
              defaultValue={name}
              onChange={(e) => {
                name = e.target.value;
              }}
              aria-label="Rule name"
            />
            <label className="mono">Severity</label>
            <select
              className="dt-inline-input"
              defaultValue={severity}
              onChange={(e) => {
                severity = e.target.value as AlertRule['severity'];
              }}
              aria-label="Severity"
            >
              {severityOptions().map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <label className="mono">Channel</label>
            <select
              className="dt-inline-input"
              defaultValue={channel}
              onChange={(e) => {
                channel = e.target.value as AlertRule['channel'];
              }}
              aria-label="Channel"
            >
              {channelOptions().map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="state__hint" style={{ padding: '8px 4px 0' }}>
            Routes through{' '}
            <span className="mono">alerts.create_rule</span> when connected;
            preview-only in this build. After create, open the Editor drawer
            and use the visual condition builder.
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Create"
            kind="primary"
            capability={CAP.ALERTS_WRITE}
            onClick={() => {
              modal.close();
              createMutation.mutate(
                {
                  rule_name: name,
                  trigger_source: 'console.alerts.new_rule',
                  trigger_conditions: {},
                  alert_channels: [channel],
                  severity,
                  enabled: true,
                },
                {
                  onSuccess: () => pushToast(
                    `create_alert_rule_v1 · ${name} · ${severity} · ${channel}`,
                    'good',
                  ),
                  onError: (err: Error) => pushToast(err.message, 'danger'),
                },
              );
            }}
          />
        </div>
      ),
    });
  }

  // Keyboard surface — `n` opens new rule, `t` opens test (against first row).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = document.activeElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable)) return;
      if ((e.key === 'n' || e.key === 'N') && canWrite) {
        openNewRule();
        e.preventDefault();
      } else if ((e.key === 't' || e.key === 'T') && decoratedRules[0]) {
        openTestRule(decoratedRules[0]);
        e.preventDefault();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoratedRules, canWrite]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Platform"
          titleAccent="Alerts"
          titlePlain=""
          pills={[<span key="src" className="chip chip--xs">Rules / triggers / operations alerts</span>]}
        />
        <StateView
          kind="denied"
          capability={CAP.ALERTS_READ}
          hint="Alerts management requires the alerts.read capability."
        />
      </div>
    );
  }

  if (rulesQuery.isLoading || triggersQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Platform"
          titleAccent="Alerts"
          titlePlain=""
          pills={[<span key="src" className="chip chip--xs">Rules / triggers / operations alerts</span>]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (rulesQuery.error) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Platform"
          titleAccent="Alerts"
          titlePlain=""
          pills={[]}
        />
        <StateView kind="error" hint={String(rulesQuery.error)} />
      </div>
    );
  }

  // ---- DataTable columns ----
  const COLUMNS: Array<DataTableColumn<DecoratedRule>> = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      filterable: true,
      width: '240px',
      render: (raw, row) => (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 500 }}>{String(raw ?? '')}</span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
            {row.condition_summary}
          </span>
        </div>
      ),
    },
    {
      key: 'severity',
      label: 'Severity',
      sortable: true,
      filterable: true,
      lookup: 'alert_severity',
      render: (raw) => {
        const v = String(raw ?? '');
        // W27-cycle-D §3 — tone resolves through the canonical
        // `alert_severity` lookup catalog (info/warn/critical) instead of
        // an inline equality branch. Default to `'danger'` so an
        // unrecognized severity surfaces loudly.
        return (
          <Chip
            label={v}
            kind={(lookupRow('alert_severity', v)?.tone as ChipKind | undefined) ?? 'danger'}
            size="xs"
          />
        );
      },
    },
    {
      key: 'channel',
      label: 'Channel',
      sortable: true,
      filterable: true,
      lookup: 'alert_channel',
      render: (raw) => {
        const v = String(raw ?? '');
        return <Chip label={v} kind="neutral" size="xs" />;
      },
    },
    {
      key: 'last_triggered_at',
      label: 'Last triggered',
      sortable: true,
      render: (_raw, row) => {
        const age = ageChip(row.last_triggered_at, ageThresholds);
        return (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 11 }}>{row.last_triggered_relative}</span>
            <Chip label={age.label} kind={age.kind} size="xs" />
          </span>
        );
      },
    },
    // W28 — directory-derived "Fires 24h" column reads from
    // v_alert_rule_directory.trigger_count_24h. Column resolves to "—" when
    // the directory projection has no entry for the rule (e.g. fresh rule
    // before backend aggregation runs).
    {
      key: 'trigger_count_24h',
      label: 'Fires 24h',
      mono: true,
      align: 'right',
      sortable: true,
      type: 'number',
      render: (_raw, row) => {
        const dir = ruleDirectoryById.get(row.id);
        const count = dir?.trigger_count_24h ?? 0;
        return (
          <span
            className="mono"
            style={{ fontSize: 11, color: count > 0 ? 'var(--ink-1)' : 'var(--ink-3)' }}
          >
            {count}
          </span>
        );
      },
    },
    {
      key: 'enabled',
      label: 'Enabled',
      sortable: true,
      filterable: true,
      render: (_raw, row) => (
        <button
          type="button"
          className={`btn btn--sm ${row.enabled ? 'btn--ghost' : ''}`}
          aria-label={row.enabled ? 'Pause rule' : 'Resume rule'}
          disabled={!canWrite}
          onClick={(e) => {
            e.stopPropagation();
            const next = !row.enabled;
            const mutation = next ? resumeMutation : pauseMutation;
            const verb = next ? 'resume_alert_rule_v1' : 'pause_alert_rule_v1';
            mutation.mutate(
              { alert_rule_id: row.id },
              {
                onSuccess: () => pushToast(`${verb} · ${row.name}`, next ? 'good' : 'warn'),
                onError: (err: Error) => pushToast(err.message, 'danger'),
              },
            );
          }}
        >
          {row.enabled ? 'Enabled' : 'Paused'}
        </button>
      ),
    },
  ];

  const ROW_ACTIONS: Array<DataTableAction<DecoratedRule>> = [
    {
      label: 'Edit condition',
      icon: 'edit',
      capability: CAP.ALERTS_WRITE,
      onClick: (row) => openConditionEditor(row),
    },
    {
      label: 'Test rule',
      icon: 'play',
      onClick: (row) => openTestRule(row),
    },
    {
      label: 'Pause',
      icon: 'pause',
      capability: CAP.ALERTS_WRITE,
      onClick: (row) => {
        pauseMutation.mutate(
          { alert_rule_id: row.id },
          {
            onSuccess: () => pushToast(`pause_alert_rule_v1 · ${row.name}`, 'warn'),
            onError: (err: Error) => pushToast(err.message, 'danger'),
          },
        );
      },
    },
    {
      label: 'Delete',
      icon: 'trash',
      kind: 'danger',
      capability: CAP.ALERTS_WRITE,
      onClick: (row) => {
        deleteMutation.mutate(
          { alert_rule_id: row.id },
          {
            onSuccess: () => pushToast(`delete_alert_rule_v1 · ${row.name}`, 'danger'),
            onError: (err: Error) => pushToast(err.message, 'danger'),
          },
        );
      },
    },
  ];

  // W28 — directory pill announces the paired projection seam so the
  // operator surface can see at a glance that severity_label /
  // created_by_label / condition_summary / last_triggered_at / etc. are
  // derived on the canonical view (not in-memory FE computation).
  const directoryThrottledCount = ruleDirectory.filter((r) => r.is_throttled).length;
  const recentOpsAlerts = [...opsAlerts].sort((a, b) => {
    const aTime = Date.parse(a.opened_at ?? a.created_at ?? '');
    const bTime = Date.parse(b.opened_at ?? b.created_at ?? '');
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
  const headerPills: ReactNode[] = [
    <span key="src" className="chip chip--xs">Rules / triggers / operations alerts</span>,
    <span
      key="dir"
      className="chip chip--xs"
      title="Rule analytics view derives severity, condition summary, recent trigger counts, and throttle state"
    >
      Rule analytics
    </span>,
    directoryThrottledCount > 0 ? (
      <span key="throttle" className="chip chip--xs chip--warn">
        {`${directoryThrottledCount} throttled`}
      </span>
    ) : null,
    <span key="parity" className="chip chip--xs mono" title="Datadog/PagerDuty/Sentry parity">parity · DD/PD/Sentry</span>,
  ].filter(Boolean) as ReactNode[];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Platform"
        titleAccent="Alerts"
        titlePlain="management"
        pills={headerPills}
        actions={[
          <Button
            key="test"
            label="Test rule"
            iconName="play"
            kind="ghost"
            onClick={() => decoratedRules[0] && openTestRule(decoratedRules[0])}
            disabled={!decoratedRules.length}
            title="t"
          />,
          <Button
            key="new"
            label="New rule"
            iconName="plus"
            kind="primary"
            capability={CAP.ALERTS_WRITE}
            onClick={openNewRule}
            title="n"
          />,
        ]}
      />

      <div className="kpi-strip" data-testid="alerts-kpi-strip">
        {kpiRows.map((k) => (
          <KPICard key={k.key} label={k.label} value={k.value} tone={k.tone} delta={(k as { delta?: string }).delta} />
        ))}
      </div>

      <DataTable<DecoratedRule>
        columns={COLUMNS}
        rows={decoratedRules}
        viewKey="alert_rules"
        entityKind="alert_rule"
        onRowClick={(row) => openRuleDrawer(row)}
        rowActions={ROW_ACTIONS}
      />

      <section aria-label="Operations alerts" data-testid="alerts-global-ops-alerts">
        <div className="section-eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
          Operations alerts
        </div>
        <div className="wf-recent-events" style={{ padding: 0, maxHeight: 260 }}>
          {recentOpsAlerts.length === 0 ? (
            <div className="state__hint">No active operations alerts.</div>
          ) : (
            recentOpsAlerts.map((alert) => {
              const resolvedAt = resolvedAtOf(alert);
              const acknowledged = Boolean(alert.acknowledged_at);
              return (
                <div
                  key={alert.id}
                  className="wf-recent-event-row"
                  data-testid={`alerts-global-ops-alert-${alert.id}`}
                >
                  <Dot kind={resolvedAt ? 'good' : acknowledged ? 'warn' : 'danger'} />
                  <span className="mono" style={{ width: 200 }}>{alert.id}</span>
                  <span style={{ flex: 1, fontSize: 11.5, color: 'var(--ink-2)' }}>
                    {alert.message}
                  </span>
                  <Chip
                    label={resolvedAt ? 'resolved' : acknowledged ? 'acknowledged' : 'open'}
                    kind={resolvedAt ? 'good' : acknowledged ? 'warn' : 'danger'}
                    size="xs"
                  />
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    {relativeFromNow(alert.opened_at ?? alert.created_at)}
                  </span>
                  {!resolvedAt && !acknowledged ? (
                    <Button
                      label="Ack"
                      kind="ghost"
                      size="sm"
                      capability={CAP.ALERTS_WRITE}
                      onClick={() => {
                        void (async () => {
                          try {
                            await ackOpsMutation.mutateAsync({ ops_alert_id: alert.id });
                            pushToast(`Ops alert acknowledged - ${alert.id}`, 'good');
                          } catch (err) {
                            const message = err instanceof Error ? err.message : 'Unable to acknowledge ops alert';
                            pushToast(message, 'danger');
                          }
                        })();
                      }}
                    />
                  ) : null}
                  {!resolvedAt ? (
                    <Button
                      label="Resolve"
                      kind="ghost"
                      size="sm"
                      capability={CAP.ALERTS_WRITE}
                      onClick={() => {
                        resolveOpsMutation.mutate(
                          { ops_alert_id: alert.id },
                          {
                            onSuccess: () => pushToast(`resolve_ops_alert_v1 · ${alert.id}`, 'good'),
                            onError: (err: Error) => pushToast(err.message, 'danger'),
                          },
                        );
                      }}
                    />
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>

      {drawer.node}
      {modal.node}
    </div>
  );
}

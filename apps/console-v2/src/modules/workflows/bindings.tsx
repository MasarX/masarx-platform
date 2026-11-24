// workflows/bindings.tsx — Bindings & triggers (event-driven attachments).
//
// Two-pane: events catalog (left) + bindings table + visual condition builder
// + recent-event tester. The condition builder has been hardened to a nested
// AND/OR/NOT model with JSONLogic emit, per-row validation, type-narrowed
// operators, payload-derived field autosuggest, and a live evaluation pane
// against `recent_workflow_events`. The drawer surfaces a real LadderViz of
// the binding's policy resolution and a JSONLogic preview.
//
// Backend invariants honored:
//   - Reads via `useResourceList` (workflow_bindings, workflow_templates,
//     recent_workflow_events) — typed through `lib/api`.
//   - Mutations call `register_workflow_binding_v1` so condition, lifecycle,
//     and template persistence write the canonical workflow_binding_policy plus
//     workflow_binding_registry / workflow_binding_stage_registry projections.
//     The local override map is kept ONLY after saved-state reconciliation.
//   - LadderViz consumes `useResolveSettings('workflow_binding_policy', scope)`
//     (read-only). This is the canonical override-ladder visualisation.
//   - Decision-evidence pill links to /insights/decisions filtered by
//     binding_key (best-effort).
// Originally ported from apps/console/demo-v2/assets/js/modules/wf-bindings.js.
//
// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — adds a Dispatches tab that exposes the
// canonical workflow_binding_dispatches ledger to the operator surface:
//   • workflow_binding_dispatches    (table; supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql:224)
//       Dispatch ledger for resolved binding executions (outcome ∈ {started,
//       completed, waiting, failed}). Read seam exposes recent dispatches by
//       binding_key + stage_key + outcome so operators can audit what
//       resolved through each binding without leaving the page.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CAP } from "@/lib/capabilities";
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { Dot } from '@/components/Dot';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import { LadderViz } from '@/components/LadderViz';
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
  useResolveSettings,
  useRegisterWorkflowBinding,
  useSimulateBindingDispatch,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { getLookups, isConsoleSeedModeEnabled, lookupRow } from '@/lib/api';
import {
  type ConditionGroup,
  type ConditionLeaf,
  type ConditionNode,
  type Operator,
  NULLARY_OPS,
  // W63 (Workflows Cycle F-R-3 P2-3) — `MAX_DEPTH` import retired
  // from this module. The UI surface now resolves the depth cap
  // through `workflow_binding_defaults.condition_max_depth` (passed
  // as `maxDepth` prop to `ConditionBuilder`/`GroupBlock`). The
  // pure `validate(...)` helper in `_bindings/condition-model.ts`
  // continues to reference its module-local `MAX_DEPTH` baseline
  // internally so it stays callable without a query subscription.
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
} from './_bindings/condition-model';
import { fill, useI18n } from '@/lib/i18n';

// ---------- Domain types (UI-shaped) ----------
//
// Wave 10 schema-drift close-out (W10-6) + W16-3 verification — see
// __audit__/SCHEMA-DRIFT/WORKFLOWS.md (§§ 5, 6, 10 + W10-6/W16-3 closure
// notes). W16-3 confirmed: WorkflowBinding remains a legacy seed projection
// awaiting `ui_list_workflow_bindings_v1` projection RPC + seed update.
// WorkflowBindingDispatch (W11-6) is canonical-aligned 1:1 with two clearly-
// marked join projections (event from workflow_binding_registry, template_name
// from workflow_templates) — no drift.
// W6 annotations are now applied. The FE binding shape (event/template_id/
// condition/priority) is a legacy seed projection; canonical is
// `workflow_binding_registry` keyed by `binding_key` with policy/dispatch
// resolution living in stage-registry tables. The structural rename
// (binding_key as PK, conditions/priority moved to policy resolution) requires
// a backend projection RPC + seed update — deferred beyond W10. The fields
// remain on the interface as legacy seed projections so the studio surface
// keeps round-tripping without breaking the existing register_workflow_binding_v1
// contract.

interface WorkflowTemplate extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_templates.id
  template_id: string;                // SSOT: display alias (FE-fabricated TPL-* code)
  name: string;                       // SSOT: workflow_templates.name
}

interface WorkflowBinding extends Record<string, unknown> {
  id: string;                         // SSOT: workflow_binding_registry.binding_key (RENAME deferred — backend projection RPC + seed update)
  event: string;                      // SSOT: legacy seed projection — canonical resolves via webhook_rules.event_type
  template_id: string;                // SSOT: legacy seed projection — registry resolves templates via dispatch policy
  /** Canonical stage key used to compose `${event}.${stage_key}` -> binding_key
   *  for backend RPCs (`simulate_binding_dispatch_v1`, `register_workflow_binding_v1`).
   *  Defaults to 'default' for legacy seed rows that don't specify a stage. */
  stage_key?: string;                 // SSOT: workflow_binding_stage_registry.stage_key
  /** Legacy flat condition shape (`{field: value}`). Stored verbatim so we can
   *  round-trip without breaking the existing seed/contract. */
  condition: Record<string, unknown> | null;  // SSOT: legacy seed projection — canonical lives in policy resolution
  priority: number;                   // SSOT: legacy seed projection — canonical resolves via workflow_binding_stage_registry.sequence_order
  status?: string;                    // SSOT: workflow_binding_registry.configurability_status (RENAME deferred — backend RPC contract switch)
}

interface RecentEvent extends Record<string, unknown> {
  id: string;                         // SSOT: domain_events.id
  event: string;                      // SSOT: domain_events.event_type (RENAME deferred — RPC contract switch)
  received_at: string;                // SSOT: domain_events.occurred_at (RENAME deferred — RPC contract switch)
  payload: Record<string, unknown>;   // SSOT: domain_events.payload
  matched_template?: string;          // SSOT: projection — computed via webhook_rules -> workflow_templates join
}

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_binding_dispatches row shape.
// Mirrors public.workflow_binding_dispatches from
// supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql:224.
// `outcome` enum is the canonical CHECK constraint (started|completed|waiting|failed)
// and `event` is a projection joined from workflow_binding_registry.
interface WorkflowBindingDispatch extends Record<string, unknown> {
  id: string;
  binding_key: string;
  stage_key: string;
  event?: string;                    // SSOT: projection — workflow_binding_registry.event_type via join
  workflow_template_id: string;
  template_name?: string;            // SSOT: projection — workflow_templates.name via join
  workflow_run_id: string;
  resolved_scope_type: string;
  resolved_scope_id?: string | null;
  outcome: string;                   // SSOT: CHECK constraint — started|completed|waiting|failed
  actor_system?: string | null;
  source_function?: string | null;
  idempotency_key?: string | null;
  created_at: string;
  updated_at: string;
  settings_resolution_id?: string | null;
  context?: Record<string, unknown>;
}

// W22 — paired projection view `public.v_workflow_binding_directory`
// (read-only). Surfaces canonical workflow_binding_registry columns AND
// derived projections (stage_count, dispatch_count, last_dispatch_at,
// last_dispatch_outcome, default_workflow_template_id resolved from the
// most recent dispatch, default_template_name via FK join to
// workflow_templates, per-outcome dispatch counters, and the derived
// is_active boolean). Bindings surface consumes this projection
// additively for canonical-sourced counter chips. See
// supabase/migrations/202604302120_v_workflow_binding_directory.sql.
interface WorkflowBindingDirectoryRow extends Record<string, unknown> {
  binding_key: string;
  id: string;
  label: string | null;
  configurability_status: string | null;
  stage_count: number;
  dispatch_count: number;
  last_dispatch_at: string | null;
  last_dispatch_outcome: string | null;
  default_workflow_template_id: string | null;
  default_template_name: string | null;
  last_workflow_run_id: string | null;
  completed_dispatch_count: number;
  failed_dispatch_count: number;
  waiting_dispatch_count: number;
  started_dispatch_count: number;
  is_active: boolean;
}

interface DecoratedBinding extends WorkflowBinding {
  template_name: string;
  condition_summary: string;
  status: string;
}

function summarizeFlat(c: Record<string, unknown> | null | undefined): string {
  if (!c || !Object.keys(c).length) return '— always —';
  return summarizeNode(fromLegacyFlat(c));
}

function legacyMatches(
  payload: Record<string, unknown>,
  cond: Record<string, unknown> | null | undefined,
): boolean {
  if (!cond || !Object.keys(cond).length) return true;
  return evalCondition(fromLegacyFlat(cond), payload);
}

// ---------- Condition Builder ----------

interface ConditionBuilderProps {
  row: DecoratedBinding;
  events: RecentEvent[];
  onSave: (cond: Record<string, unknown> | null, jsonlogic: unknown) => void;
  onCancel: () => void;
  /** Same SettingsResolution payload the drawer uses, so the editor can pin
   *  the override-ladder visualisation at the top of the form. */
  ladder?: Parameters<typeof LadderViz>[0]['resolution'];
  /** W63 (Workflows Cycle F-R-3 P2-3) — canonical depth cap resolved
   *  through `workflow_binding_defaults.condition_max_depth`. The UI
   *  surface (`+ Group` button enable/disable + tooltip) uses this
   *  value strictly; `null` disables depth-cap gating in the UI so
   *  the gap surfaces visibly. The pure `validate(...)` helper in
   *  `_bindings/condition-model.ts` keeps its module-local
   *  baseline constant as a deterministic fallback. */
  maxDepth: number | null;
}

function OperatorPicker({
  op,
  field,
  events,
  onChange,
}: {
  op: Operator;
  field: string;
  events: RecentEvent[];
  onChange: (op: Operator) => void;
}) {
  const { t } = useI18n();
  const samples = useMemo(() => valueSamples(field, events), [field, events]);
  const inferred = useMemo(() => inferType(samples), [samples]);
  const opts = operatorsFor(inferred);
  return (
    <select
      className="dt-inline-input"
      value={op}
      onChange={(e) => onChange(e.target.value as Operator)}
      aria-label={t('workflowBindings.operatorPicker.operator')}
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
  events,
  onChange,
  onRemove,
  evalPass,
  evalTotal,
  issue,
}: {
  node: ConditionLeaf;
  pathLabel: string;
  fieldOptions: string[];
  events: RecentEvent[];
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
  evalPass: number;
  evalTotal: number;
  issue: { severity: 'error' | 'warn'; message: string } | null;
}) {
  const { t } = useI18n();
  const datalistId = `wf-cond-fields-${pathLabel.replace(/\W+/g, '-')}`;
  return (
    <div
      className="wf-cond-row wf-cond-row--rich"
      data-severity={issue?.severity ?? 'ok'}
      data-testid="wf-cond-row"
    >
      <input
        list={datalistId}
        className="dt-inline-input mono"
        value={node.field}
        onChange={(e) => onChange({ ...node, field: e.target.value })}
        aria-label={t('workflowBindings.conditionRow.field')}
        placeholder={t('workflowBindings.conditionRow.payloadField')}
      />
      <datalist id={datalistId}>
        {fieldOptions.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <OperatorPicker
        op={node.op}
        field={node.field}
        events={events}
        onChange={(op) => onChange({ ...node, op })}
      />
      <input
        className="dt-inline-input"
        type="text"
        value={node.value}
        placeholder={NULLARY_OPS.includes(node.op) ? 'n/a' : t('workflowBindings.conditionRow.value')}
        disabled={NULLARY_OPS.includes(node.op)}
        onChange={(e) => onChange({ ...node, value: e.target.value })}
        aria-label={t('workflowBindings.conditionRow.value2')}
      />
      <div className="wf-cond-row__meta">
        <Chip
          label={evalTotal === 0 ? t('workflowBindings.conditionRow.noSample') : fill(t('workflowBindings.conditionRow.pass'), { evalPass: String(evalPass), evalTotal: String(evalTotal) })}
          kind={evalTotal === 0 ? 'neutral' : evalPass === evalTotal ? 'good' : evalPass === 0 ? 'danger' : 'warn'}
          size="xs"
        />
        {issue ? (
          <Chip
            label={issue.message}
            kind={issue.severity === 'error' ? 'danger' : 'warn'}
            size="xs"
            title={issue.message}
          />
        ) : null}
      </div>
      <button
        type="button"
        className="icon-btn"
        title={t('workflowBindings.conditionRow.removeRow')}
        aria-label={t('workflowBindings.conditionRow.removeConditionRow')}
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
  maxDepth,
  fieldOptions,
  events,
  onChange,
  onRemove,
  isRoot,
  issues,
}: {
  node: ConditionGroup;
  path: number[];
  depth: number;
  /** W63 (Workflows Cycle F-R-3 P2-3) — canonical depth cap resolved
   *  through `workflow_binding_defaults.condition_max_depth`. `null`
   *  disables depth-cap gating in the UI so a missing canonical row
   *  surfaces the gap rather than masking it with the imported
   *  `MAX_DEPTH` constant. */
  maxDepth: number | null;
  fieldOptions: string[];
  events: RecentEvent[];
  onChange: (next: ConditionGroup) => void;
  onRemove?: () => void;
  isRoot?: boolean;
  issues: ReturnType<typeof validate>;
}) {
  const { t } = useI18n();
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
    // W63 (Workflows Cycle F-R-3 P2-3) — canonical depth cap.
    // `maxDepth == null` → no policy resolved; allow add (the gap
    // is surfaced by the rest of the canonical ladder). Otherwise
    // gate the action against the policy-resolved value (no inline
    // `MAX_DEPTH` literal here).
    if (maxDepth != null && depth >= maxDepth) return;
    onChange({ ...node, children: [...node.children, makeGroup('and')] });
  }

  // W63 (Workflows Cycle F-R-3 P2-3) — depth-cap UI gate uses the
  // policy-resolved value (`maxDepth`); pure `validate(...)` keeps
  // the imported `MAX_DEPTH` as its deterministic baseline.
  const atDepthCap = maxDepth != null && depth >= maxDepth;

  return (
    <div
      className={`wf-cond-group ${node.combinator === 'or' ? 'wf-cond-group--or' : node.combinator === 'not' ? 'wf-cond-group--not' : ''}`}
      data-testid="wf-cond-group"
      data-depth={depth}
    >
      <div className="wf-cond-group__head">
        <select
          className="dt-inline-input wf-cond-group__combinator"
          value={node.combinator}
          onChange={(e) =>
            onChange({ ...node, combinator: e.target.value as 'and' | 'or' | 'not' })
          }
          aria-label={t('workflowBindings.groupBlock.combinator')}
        >
          <option value="and">{t('workflowBindings.groupBlock.allOfAnd')}</option>
          <option value="or">{t('workflowBindings.groupBlock.anyOfOr')}</option>
          <option value="not">{t('workflowBindings.groupBlock.noneOfNot')}</option>
        </select>
        <span className="state__hint" style={{ fontSize: '11px' }}>
          {node.combinator === 'not'
            ? t('workflowBindings.groupBlock.passWhenTheInner')
            : node.combinator === 'or'
              ? t('workflowBindings.groupBlock.passWhenAtLeast')
              : t('workflowBindings.groupBlock.passWhenEveryRow')}
        </span>
        <div style={{ flex: 1 }} />
        {!isRoot && onRemove ? (
          <button type="button" className="icon-btn" onClick={onRemove} aria-label={t('workflowBindings.groupBlock.removeGroup')}>
            ×
          </button>
        ) : null}
      </div>
      <div className="wf-cond-group__body">
        {node.children.length === 0 ? (
          <div className="state__hint" style={{ padding: '6px 4px' }}>
            {t('workflowBindings.groupBlock.emptyGroupAddA')}
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
                  maxDepth={maxDepth}
                  fieldOptions={fieldOptions}
                  events={events}
                  onChange={(next) => patchChild(idx, next)}
                  onRemove={() => patchChild(idx, null)}
                  issues={issues}
                />
              );
            }
            const passCount = events.filter((e) => evalCondition(child, e.payload)).length;
            return (
              <ConditionRow
                key={idx}
                node={child}
                pathLabel={childPath.join('-')}
                fieldOptions={fieldOptions}
                events={events}
                onChange={(next) => patchChild(idx, next)}
                onRemove={() => patchChild(idx, null)}
                evalPass={passCount}
                evalTotal={events.length}
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
            {t('workflowBindings.groupBlock.row')}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={addGroup}
            disabled={atDepthCap || (node.combinator === 'not' && node.children.length >= 1)}
            title={atDepthCap ? fill(t('workflowBindings.groupBlock.maxDepth'), { maxDepth: String(maxDepth) }) : t('workflowBindings.groupBlock.addNestedGroup')}
          >
            {t('workflowBindings.groupBlock.group')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionBuilder({ row, events, onSave, onCancel, ladder, maxDepth }: ConditionBuilderProps) {
  const { t } = useI18n();
  // Initialise from legacy flat shape for round-trip compatibility.
  const [tree, setTree] = useState<ConditionGroup>(() => fromLegacyFlat(row.condition));

  const recentForEvent = useMemo(
    () => events.filter((e) => e.event === row.event),
    [events, row.event],
  );

  const fieldOptions = useMemo(
    () => discoverFields(recentForEvent.length ? recentForEvent : events),
    [events, recentForEvent],
  );

  const issues = useMemo(() => validate(tree), [tree]);
  const errors = issues.filter((i) => i.severity === 'error');

  const jsonlogic = useMemo(() => toJsonLogic(tree), [tree]);
  const flatLegacy = useMemo(() => toLegacyFlatIfPossible(tree), [tree]);

  const totalSample = recentForEvent.length;
  const overallPass = useMemo(
    () => recentForEvent.filter((e) => evalCondition(tree, e.payload)).length,
    [tree, recentForEvent],
  );

  function save() {
    if (errors.length) {
      pushToast(fill(t(errors.length === 1 ? 'workflowBindings.conditionBuilder.fixErrorsOne' : 'workflowBindings.conditionBuilder.fixErrorsOther'), { count: errors.length }), 'danger');
      return;
    }
    // Persist legacy flat shape when possible (preserves backward compatibility);
    // otherwise persist the JSONLogic tree as a single-key object.
    onSave(flatLegacy ?? { jsonlogic }, jsonlogic);
  }

  return (
    <div className="wf-cond-builder">
      <p className="state__hint">
        {t('workflowBindings.conditionBuilder.buildConditionsVisuallyGroups')}
      </p>
      {ladder ? (
        <div className="wf-cond-builder__ladder" data-testid="wf-cond-builder-ladder">
          <div className="section-eyebrow">{t('workflowBindings.conditionBuilder.overrideLadder')}</div>
          <div style={{ padding: '0 0 4px' }}>
            <LadderViz resolution={ladder} />
          </div>
        </div>
      ) : null}
      <div className="wf-cond-builder__grid">
        <div className="wf-cond-builder__main">
          <div className="section-eyebrow">{t('workflowBindings.conditionBuilder.conditions')}</div>
          <GroupBlock
            node={tree}
            path={[]}
            depth={0}
            maxDepth={maxDepth}
            fieldOptions={fieldOptions}
            events={recentForEvent}
            onChange={(next) => setTree(next)}
            isRoot
            issues={issues}
          />
        </div>
        <aside className="wf-cond-builder__aside">
          <div className="section-eyebrow">{t('workflowBindings.conditionBuilder.liveEvaluation')}</div>
          <div className="wf-cond-aside__metric">
            <Chip
              label={
                totalSample === 0
                  ? t('workflowBindings.conditionBuilder.noRecentEventsFor')
                  : fill(t('workflowBindings.conditionBuilder.recentEventsMatch'), { overallPass: String(overallPass), totalSample: String(totalSample) })
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
          <div className="section-eyebrow">{t('workflowBindings.conditionBuilder.rulePreview')}</div>
          <div className="wf-code-block" data-testid="wf-cond-rule-preview">
            {summarizeNode(tree)}
          </div>
          <div className="section-eyebrow">{t('workflowBindings.conditionBuilder.validation')}</div>
          <div className="wf-cond-issues">
            {issues.length === 0 ? (
              <div className="state__hint">{t('workflowBindings.conditionBuilder.allRowsLookGood')}</div>
            ) : (
              issues.map((iss, k) => (
                <div key={k} className="wf-cond-issue">
                  <Chip
                    label={iss.severity === 'error' ? t('workflowBindings.conditionBuilder.error') : t('workflowBindings.conditionBuilder.warn')}
                    kind={iss.severity === 'error' ? 'danger' : 'warn'}
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
      <div className="section-eyebrow">{t('workflowBindings.conditionBuilder.testAgainstRecentEvents')}</div>
      <div className="wf-recent-events">
        {recentForEvent.length === 0 ? (
          <div className="state__hint">{fill(t('workflowBindings.conditionBuilder.noRecentEventsFor2'), { event: String(row.event) })}</div>
        ) : (
          recentForEvent.slice(0, 5).map((e) => {
            const matches = evalCondition(tree, e.payload);
            return (
              <div key={e.id} className="wf-recent-event-row" data-testid="wf-cond-test-row">
                <Dot kind={matches ? 'good' : 'danger'} />
                <span className="mono" style={{ width: '110px' }}>
                  {e.id}
                </span>
                <span style={{ flex: 1, fontSize: '11.5px', color: 'var(--ink-2)' }}>
                  {JSON.stringify(e.payload).slice(0, 60)}
                </span>
                <Chip
                  label={matches ? t('workflowBindings.conditionBuilder.pass') : t('workflowBindings.conditionBuilder.fail')}
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
          {errors.length ? fill(t(errors.length === 1 ? 'workflowBindings.conditionBuilder.blockerOne' : 'workflowBindings.conditionBuilder.blockerOther'), { count: errors.length }) : t('workflowBindings.conditionBuilder.readyToSave')}
        </span>
        <div style={{ flex: 1 }} />
        <Button label={t('workflowBindings.conditionBuilder.cancel')} kind="ghost" onClick={onCancel} />
        <Button
          label={t('workflowBindings.conditionBuilder.save')}
          kind="primary"
          // Condition policy edits persist through the settings ladder; the
          // same capability gates the visible operator action fail-closed.
          capability={CAP.WORKFLOWS_WRITE}
          onClick={save}
        />
      </div>
    </div>
  );
}

// ---------- Event tester ----------

interface EventTesterBodyProps {
  bindings: DecoratedBinding[];
  events: RecentEvent[];
}

function EventTesterBody({ bindings, events }: EventTesterBodyProps) {
  const { t } = useI18n();
  const eventOptions = useMemo(
    () => Array.from(new Set(bindings.map((b) => b.event))).sort(),
    [bindings],
  );
  const [selectedEvent, setSelectedEvent] = useState<string>(eventOptions[0] || '');
  const [payloadText, setPayloadText] = useState<string>(
    JSON.stringify(events[0]?.payload || {}, null, 2),
  );

  const parsed = useMemo<{ ok: true; value: Record<string, unknown> } | { ok: false; err: string }>(() => {
    try {
      return { ok: true, value: JSON.parse(payloadText) as Record<string, unknown> };
    } catch (err) {
      return { ok: false, err: (err as Error).message };
    }
  }, [payloadText]);

  const matches = useMemo(() => {
    if (!parsed.ok) return [];
    return bindings
      .filter((b) => b.event === selectedEvent)
      .slice()
      .sort((a, b) => b.priority - a.priority);
  }, [bindings, selectedEvent, parsed]);

  const winnerIdx = useMemo(
    () => (parsed.ok ? matches.findIndex((b) => legacyMatches(parsed.value, b.condition)) : -1),
    [matches, parsed],
  );

  return (
    <div>
      <p className="state__hint">
        {t('workflowBindings.eventTesterBody.pickAnEventPayload')}
      </p>
      <div className="section-eyebrow">{t('workflowBindings.eventTesterBody.event')}</div>
      <div style={{ padding: '0 14px 8px' }}>
        <select
          className="dt-inline-input"
          value={selectedEvent}
          onChange={(e) => setSelectedEvent(e.target.value)}
          aria-label={t('workflowBindings.eventTesterBody.event')}
        >
          {eventOptions.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
      <div className="section-eyebrow">
        {t('workflowBindings.eventTesterBody.eventDetails')}
        {!parsed.ok ? (
          <Chip label={t('workflowBindings.eventTesterBody.invalidDetails')} kind="danger" size="xs" />
        ) : (
          <Chip label={t('workflowBindings.eventTesterBody.validDetails')} kind="good" size="xs" />
        )}
      </div>
      <textarea
        className="wf-code-block wf-code-block--editable"
        rows={5}
        value={payloadText}
        onChange={(e) => setPayloadText(e.target.value)}
        aria-label={t('workflowBindings.eventTesterBody.eventDetails')}
      />
      <div className="wf-recent-bar">
        {events.slice(0, 4).map((e) => (
          <button
            key={e.id}
            type="button"
            className="wf-recent-bar__btn"
            onClick={() => {
              setSelectedEvent(e.event);
              setPayloadText(JSON.stringify(e.payload, null, 2));
            }}
          >
            <span className="mono">{e.id}</span>
            <span style={{ opacity: 0.6 }}>{e.event}</span>
          </button>
        ))}
      </div>
      <div className="section-eyebrow">{t('workflowBindings.eventTesterBody.resolution')}</div>
      <div className="wf-recent-events">
        {!parsed.ok ? (
          <div className="state__hint">{fill(t('workflowBindings.eventTesterBody.invalidJson'), { error: String(parsed.err) })}</div>
        ) : matches.length === 0 ? (
          <div className="state__hint">{fill(t('workflowBindings.eventTesterBody.noBindingsFor'), { selectedEvent: String(selectedEvent) })}</div>
        ) : (
          matches.map((b, i) => {
            const cond = legacyMatches(parsed.value, b.condition);
            const winner = cond && i === winnerIdx;
            return (
              <div key={b.id} className="wf-recent-event-row">
                <Dot kind={winner ? 'good' : cond ? 'warn' : 'danger'} />
                <span className="mono" style={{ width: '160px', fontSize: '11px' }}>
                  {b.template_name}
                </span>
                <span style={{ flex: 1, fontSize: '11.5px', color: 'var(--ink-2)' }}>
                  {summarizeFlat(b.condition)}
                </span>
                <Chip
                  label={winner ? t('workflowBindings.eventTesterBody.wins') : cond ? t('workflowBindings.eventTesterBody.matches') : t('workflowBindings.eventTesterBody.noMatch')}
                  kind={winner ? 'good' : cond ? 'info' : 'neutral'}
                  size="xs"
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------- Module ----------

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — page-level tab system. Lets the operator
// switch between live bindings and the workflow_binding_dispatches ledger
// without leaving /workflows/bindings. Active tab is persisted in the hash so
// deep links survive page reloads.
type BindingsTab = 'bindings' | 'dispatches';

// Tab names and labels come from workflowBindings.tabs.<key>.
const BINDINGS_TABS: Array<{ key: BindingsTab }> = [{ key: 'bindings' }, { key: 'dispatches' }];

function bindingsRouteQuery(): Record<string, string> {
  const q = window.location.search.slice(1) || window.location.hash.split('?')[1] || '';
  return Object.fromEntries(
    q
      .split('&')
      .filter(Boolean)
      .map((kv) => kv.split('=').map(decodeURIComponent) as [string, string]),
  );
}

interface WorkflowBindingSimulationReadback {
  id?: string;
  workflow_binding_simulation_id?: string;
  binding_key?: string;
  stage_key?: string;
  event?: string;
  resolved_template_id?: string | null;
  correlation_id?: string;
}

type WorkflowBindingMutationReadbackKind = 'create' | 'status' | 'template' | 'condition';

interface WorkflowBindingMutationReadback {
  kind: WorkflowBindingMutationReadbackKind;
  bindingKey: string;
  stageKey: string;
  expectedStatus?: string | null;
  expectedTemplateId?: string | null;
  expectedCondition?: Record<string, unknown> | null;
  expectedConditionSummary?: string | null;
  confirmedStatus?: string | null;
  confirmedTemplateId?: string | null;
  confirmedCondition?: Record<string, unknown> | null;
  confirmedConditionSummary?: string | null;
  registrationId?: string | null;
  correlationId?: string | null;
  visibleInList: boolean;
  visibleInDirectory: boolean;
  conditionMatches?: boolean;
  confirmed: boolean;
  error?: string | null;
  requestedAt: string;
}

function bindingsHashTab(): BindingsTab {
  const v = bindingsRouteQuery().tab ?? '';
  return v === 'dispatches' ? 'dispatches' : 'bindings';
}

function workflowBindingLabel(value: unknown, fallback = 'Workflow option'): string {
  const token = String(value ?? '').trim();
  if (!token) return fallback;
  return token
    .replace(/[._/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function workflowBindingStatusLabel(value: unknown): string {
  const token = String(value ?? '').trim();
  if (!token) return 'Not reported';
  const row = lookupRow('workflow_binding_status', token);
  return (row?.label as string | undefined) ?? workflowBindingLabel(token);
}

function readWorkflowBindingStatus(row: WorkflowBinding | WorkflowBindingDirectoryRow | null | undefined): string | null {
  if (!row) return null;
  const explicit = typeof row.status === 'string' && row.status.trim() ? row.status.trim() : null;
  if (explicit) return explicit;
  if ('is_active' in row && typeof row.is_active === 'boolean') {
    const statusRows =
      (getLookups('workflow_binding_status') as Array<{ value: string; metadata?: { is_enabled?: boolean } }> | undefined) ?? [];
    return statusRows.find((candidate) => candidate.metadata?.is_enabled === row.is_active)?.value ?? null;
  }
  return null;
}

function readWorkflowBindingTemplateId(row: WorkflowBinding | WorkflowBindingDirectoryRow | null | undefined): string | null {
  if (!row) return null;
  return (
    (typeof row.workflow_template_id === 'string' && row.workflow_template_id.trim()
      ? row.workflow_template_id.trim()
      : null) ??
    (typeof row.template_id === 'string' && row.template_id.trim() ? row.template_id.trim() : null) ??
    (typeof row.default_workflow_template_id === 'string' && row.default_workflow_template_id.trim()
      ? row.default_workflow_template_id.trim()
      : null)
  );
}

function normalizeWorkflowBindingCondition(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length ? record : null;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

function workflowBindingConditionKey(value: unknown): string {
  return JSON.stringify(sortJsonValue(normalizeWorkflowBindingCondition(value) ?? {}));
}

function readWorkflowBindingCondition(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return normalizeWorkflowBindingCondition(row?.condition);
}

function readWorkflowBindingKey(row: WorkflowBinding | WorkflowBindingDirectoryRow | null | undefined): string | null {
  if (!row) return null;
  const explicit = typeof row.binding_key === 'string' && row.binding_key.trim() ? row.binding_key.trim() : null;
  if (explicit) return explicit;
  const event = typeof row.event === 'string' && row.event.trim() ? row.event.trim() : null;
  if (event) {
    const stage = typeof row.stage_key === 'string' && row.stage_key.trim() ? row.stage_key.trim() : 'default';
    return `${event}.${stage}`;
  }
  return typeof row.id === 'string' && row.id.trim() ? row.id.trim() : null;
}

// W27 Cycle D closure: row-driven dispatch outcome chip via canonical
// `workflow_binding_dispatch_outcome` lookup (tone in metadata). Missing
// canonical row renders a fail-loud `(missing)` danger chip rather than a
// silent `neutral` default. Replaces the inline switch over outcome
// literals (AGENTS.md §2 ZERO HARDCODING + §4 SSOT).
function DispatchOutcomeChip({ outcome }: { outcome: string }) {
  const { t } = useI18n();
  const row = lookupRow('workflow_binding_dispatch_outcome', outcome);
  if (!row) {
    return (
      <Chip
        label={fill(t('workflowBindings.dispatchOutcomeChip.missingDispatchOutcome'), { value: String(workflowBindingLabel(outcome)) })}
        kind="danger"
        size="xs"
      />
    );
  }
  return (
    <Chip
      label={(row.label as string | undefined) ?? outcome}
      kind={(row.tone as ChipKind | undefined) ?? 'neutral'}
      size="xs"
    />
  );
}

export function BindingsModule() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const go = useConsoleNavigator();
  const drawer = useDrawer();
  const modal = useModal();
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.WORKFLOWS_READ);
  const canWrite = useCapability(CAP.WORKFLOWS_WRITE);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);

  const bindingsQuery = useResourceList<WorkflowBinding>('workflow_bindings', undefined, readQueryOptions);
  const templatesQuery = useResourceList<WorkflowTemplate>('workflow_templates', undefined, readQueryOptions);
  const eventsQuery = useResourceList<RecentEvent>('recent_workflow_events', undefined, readQueryOptions);
  const dispatchesQuery = useResourceList<WorkflowBindingDispatch>(
    'workflow_binding_dispatches',
    undefined,
    readQueryOptions,
  );
  // W22 — paired projection view consumption (additive). Provides canonical
  // SSOT (binding_key) AND derived counters (stage_count, dispatch_count,
  // per-outcome counters, last_dispatch_outcome, default_template_name)
  // resolved from the canonical seam.
  const directoryQuery = useResourceList<WorkflowBindingDirectoryRow>(
    'workflow_binding_directory',
    undefined,
    readQueryOptions,
  );

  // W11-6 active tab state, persisted in hash query so deep links survive reload.
  const [activeTab, setActiveTab] = useState<BindingsTab>(() => bindingsHashTab());

  function switchTab(next: BindingsTab) {
    setActiveTab(next);
    const params = bindingsRouteQuery();
    if (next === 'bindings') delete params.tab;
    else params.tab = next;
    const qs = new URLSearchParams(params).toString();
    go(qs ? `/workflows/bindings?${qs}` : '/workflows/bindings');
  }

  // Settings ladder context for the active tenant — displayed in the binding
  // drawer and editor as the canonical override-ladder visualisation.
  const ladderQuery = useResolveSettings(
    'workflow_binding_policy',
    { tenant_id: scope.tenant?.id },
    readQueryOptions,
  );
  // Cycle E2 (Workflows P1 #7) — canonical binding defaults
  // (priority/stage/scope_type) resolved through the settings ladder.
  // Replaces the inline `priority='10'`, `stage='default'`,
  // `scope_type='tenant'`, and `parseInt(priority, 10) || 10` literals.
  const bindingDefaultsQuery = useResolveSettings(
    'workflow_binding_defaults',
    { tenant_id: scope.tenant?.id },
    readQueryOptions,
  );
  const bindingDefaults = useMemo(() => {
    const value = bindingDefaultsQuery.data?.value as
      | {
          default_priority?: number;
          default_stage?: string;
          default_scope_type?: string;
          // W63 (Workflows Cycle F-R-3 P2-3) — canonical condition
          // depth cap consumed by `ConditionBuilder` / `GroupBlock`.
          // Replaces the inline `MAX_DEPTH` literal usages in the UI
          // surface (the imported constant remains scoped to the
          // pure `validate(...)` helper for type-safety baseline).
          condition_max_depth?: number;
        }
      | undefined;
    return {
      defaultPriority:
        typeof value?.default_priority === 'number' ? value.default_priority : null,
      defaultStage:
        typeof value?.default_stage === 'string' && value.default_stage ? value.default_stage : null,
      defaultScopeType:
        typeof value?.default_scope_type === 'string' && value.default_scope_type
          ? value.default_scope_type
          : null,
      conditionMaxDepth:
        typeof value?.condition_max_depth === 'number' && Number.isFinite(value.condition_max_depth)
          ? value.condition_max_depth
          : null,
    };
  }, [bindingDefaultsQuery.data]);
  // Phase C5: canonical binding lifecycle through register_workflow_binding_v1
  // (covers Create / Edit / Activate / Pause) + simulate_binding_dispatch_v1
  // (covers Test-condition). Closes WORKFLOWS.md §3 P0 'Bindings module
  // consumes a non-existent shape'.
  const registerBinding = useRegisterWorkflowBinding();
  const simulateDispatch = useSimulateBindingDispatch();
  const seedDiagnosticsEnabled = isConsoleSeedModeEnabled();

  const templates = useMemo(() => templatesQuery.data?.rows ?? [], [templatesQuery.data]);
  const rawBindings = useMemo(() => bindingsQuery.data?.rows ?? [], [bindingsQuery.data]);
  const events = useMemo(() => eventsQuery.data?.rows ?? [], [eventsQuery.data]);

  // Local copy so confirmed edits stay visible while the cache refreshes.
  const [overrides, setOverrides] = useState<Record<string, Partial<DecoratedBinding>>>({});
  const [simulationReadback, setSimulationReadback] =
    useState<WorkflowBindingSimulationReadback | null>(null);
  const [mutationReadback, setMutationReadback] =
    useState<WorkflowBindingMutationReadback | null>(null);

  const tplById = useMemo(() => {
    const m = new Map<string, WorkflowTemplate>();
    templates.forEach((entry) => m.set(entry.id, entry));
    return m;
  }, [templates]);

  // W22 — directory projection by binding_key; used additively for
  // dispatch_count / last_dispatch_outcome chips on the binding list.
  const directoryByBindingKey = useMemo(() => {
    const m = new Map<string, WorkflowBindingDirectoryRow>();
    for (const r of directoryQuery.data?.rows ?? []) m.set(r.binding_key, r);
    return m;
  }, [directoryQuery.data]);

  // W67 (Workflows Cycle F-R-7 P2-3) — canonical default `workflow_binding_status`
  // resolved via `is_default: true` row (mirrors plugin_studio_plugin_kind /
  // service_offering_status pattern; AGENTS.md §2 ZERO HARDCODING + §6
  // row-driven by configuration). Replaces literal `merged.status || 'active'`
  // fallback. Missing canonical row → empty string surfaces a fail-loud
  // `(missing)` chip in the status column instead of silently coercing.
  const defaultBindingStatus =
    (getLookups('workflow_binding_status') as Array<{ value: string; is_default?: boolean; metadata?: { is_default?: boolean } }> | undefined)
      ?.find((r) => r.is_default === true || r.metadata?.is_default === true)?.value ?? '';

  const decoratedBindings = useMemo<DecoratedBinding[]>(() => {
    return rawBindings.map((b) => {
      const ov = overrides[b.id] || {};
      const merged = { ...b, ...ov };
      // W22 — when canonical projection row exists, prefer its
      // default_template_name (resolved from most recent dispatch FK
      // join) over the legacy seed template_id lookup.
      const stageKey = merged.stage_key ?? 'default';
      const canonicalBindingKey = merged.event ? `${merged.event}.${stageKey}` : merged.id;
      const directoryRow = directoryByBindingKey.get(canonicalBindingKey);
      const projectedName =
        directoryRow?.default_template_name ?? tplById.get(merged.template_id)?.name;
      return {
        ...merged,
        template_name: projectedName || merged.template_id,
        condition_summary: summarizeFlat(merged.condition),
        status: merged.status || defaultBindingStatus,
      };
    });
  }, [rawBindings, overrides, tplById, directoryByBindingKey, defaultBindingStatus]);

  function patchBinding(id: string, patch: Partial<DecoratedBinding>) {
    setOverrides((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), ...patch },
    }));
  }

  async function refreshBindingMutationReadback({
    kind,
    bindingKey,
    stageKey,
    expectedStatus,
    expectedTemplateId,
    expectedCondition,
    result,
  }: {
    kind: WorkflowBindingMutationReadbackKind;
    bindingKey: string;
    stageKey: string;
    expectedStatus?: string | null;
    expectedTemplateId?: string | null;
    expectedCondition?: Record<string, unknown> | null;
    result?: Record<string, unknown> | null;
  }) {
    const requestedAt = new Date().toISOString();
    const expectedConditionSummary =
      expectedCondition === undefined ? null : summarizeFlat(expectedCondition);
    const registrationId =
      typeof result?.workflow_binding_registration_id === 'string'
        ? result.workflow_binding_registration_id
        : typeof result?.id === 'string'
          ? result.id
          : null;
    const correlationId = typeof result?.correlation_id === 'string' ? result.correlation_id : null;
    setMutationReadback({
      kind,
      bindingKey,
      stageKey,
      expectedStatus,
      expectedTemplateId,
      expectedCondition: expectedCondition === undefined ? undefined : expectedCondition,
      expectedConditionSummary,
      registrationId,
      correlationId,
      visibleInList: false,
      visibleInDirectory: false,
      confirmed: false,
      requestedAt,
    });

    let readbackError: string | null = null;

    const [bindingsResult, directoryListResult] = await Promise.allSettled([
      bindingsQuery.refetch(),
      directoryQuery.refetch(),
    ]);

    if (dispatchesQuery.data || activeTab === 'dispatches') {
      await dispatchesQuery.refetch().catch(() => undefined);
    }

    if (bindingsResult.status === 'rejected') {
      readbackError = bindingsResult.reason instanceof Error ? bindingsResult.reason.message : String(bindingsResult.reason);
    }
    if (directoryListResult.status === 'rejected') {
      readbackError =
        readbackError ??
        (directoryListResult.reason instanceof Error ? directoryListResult.reason.message : String(directoryListResult.reason));
    }

    const refreshedBindings =
      bindingsResult.status === 'fulfilled'
        ? bindingsResult.value.data?.rows ?? []
        : bindingsQuery.data?.rows ?? [];
    const refreshedDirectory =
      directoryListResult.status === 'fulfilled'
        ? directoryListResult.value.data?.rows ?? []
        : directoryQuery.data?.rows ?? [];
    const visibleBinding =
      refreshedBindings.find((row) => readWorkflowBindingKey(row) === bindingKey) ?? null;
    const visibleDirectory =
      refreshedDirectory.find((row) => readWorkflowBindingKey(row) === bindingKey) ?? null;
    const bindingReadback = visibleBinding;
    const directoryReadback = visibleDirectory;
    const confirmedStatus =
      readWorkflowBindingStatus(bindingReadback) ?? readWorkflowBindingStatus(directoryReadback);
    const confirmedTemplateId =
      readWorkflowBindingTemplateId(bindingReadback) ?? readWorkflowBindingTemplateId(directoryReadback);
    const confirmedCondition =
      readWorkflowBindingCondition(bindingReadback) ?? readWorkflowBindingCondition(directoryReadback);
    const visibleInList = Boolean(visibleBinding);
    const visibleInDirectory = Boolean(visibleDirectory);
    const statusMatches = expectedStatus ? confirmedStatus === expectedStatus : true;
    const templateMatches = expectedTemplateId ? confirmedTemplateId === expectedTemplateId : true;
    const conditionMatches =
      expectedCondition === undefined
        ? true
        : workflowBindingConditionKey(confirmedCondition) === workflowBindingConditionKey(expectedCondition);

    setMutationReadback({
      kind,
      bindingKey,
      stageKey,
      expectedStatus,
      expectedTemplateId,
      expectedCondition: expectedCondition === undefined ? undefined : expectedCondition,
      expectedConditionSummary,
      confirmedStatus,
      confirmedTemplateId,
      confirmedCondition,
      confirmedConditionSummary:
        expectedCondition === undefined
          ? null
          : summarizeFlat(confirmedCondition),
      registrationId,
      correlationId,
      visibleInList,
      visibleInDirectory,
      conditionMatches,
      confirmed: visibleInList && visibleInDirectory && statusMatches && templateMatches && conditionMatches,
      error: readbackError,
      requestedAt,
    });
  }

  /** Single point of truth for binding mutation: every binding edit writes
   *  through the registration RPC, then reconciles visible state from backend
   *  list and directory readback before patching the local row mirror. */
  async function persistBindingChange(
    row: DecoratedBinding,
    patch: Partial<DecoratedBinding>,
    label: string,
  ) {
    try {
      // W67 (Workflows Cycle F-R-7 P1-1) — `enabled` payload is row-driven
      // via canonical `workflow_binding_status[<value>].metadata.is_enabled`
      // (replaces inline `(status) !== 'disabled'` literal compare).
      // AGENTS.md §2 ZERO HARDCODING + §6 row-driven by configuration.
      // Missing canonical row → `enabled: false` (fail-closed: a status the
      // FE doesn't recognize is treated as not-enabled by the RPC, matching
      // the principle-of-least-privilege posture).
      const effectiveStatus = patch.status ?? row.status;
      const statusMeta = lookupRow('workflow_binding_status', effectiveStatus)?.metadata as
        | { is_enabled?: boolean }
        | undefined;
      const enabled = statusMeta?.is_enabled === true;
      const stageKey = patch.stage_key ?? row.stage_key ?? 'default';
      const scopeType =
        (typeof row.scope_type === 'string' && row.scope_type ? row.scope_type : null) ??
        bindingDefaults.defaultScopeType;
      if (!scopeType) {
        throw new Error('Workflow binding defaults are not configured yet.');
      }
      const bindingKey = String(row.binding_key ?? `${row.event}.${stageKey}`);
      const isConditionPatch = patch.condition !== undefined || patch.condition_summary !== undefined;
      const result = await registerBinding.mutateAsync({
        binding_key: bindingKey,
        stage_key: stageKey,
        scope_type: scopeType,
        scope_id: scope.tenant?.id ?? null,
        event: row.event,
        workflow_template_id: patch.template_id ?? row.template_id,
        condition: patch.condition ?? row.condition,
        priority: patch.priority ?? row.priority,
        enabled,
      });
      await refreshBindingMutationReadback({
        kind: isConditionPatch ? 'condition' : patch.template_id || patch.template_name ? 'template' : 'status',
        bindingKey,
        stageKey,
        expectedStatus: patch.status ?? null,
        expectedTemplateId: patch.template_id ?? row.template_id,
        expectedCondition: isConditionPatch ? (patch.condition ?? null) : undefined,
        result,
      });
      patchBinding(row.id, patch);
      pushToast(label, 'good');
      return true;
    } catch (err) {
      const message = (err as Error)?.message ?? '';
      if (seedDiagnosticsEnabled) {
        patchBinding(row.id, patch);
        pushToast(fill(t('workflowBindings.bindingsModule.previewCouldNotBe'), { label: String(label), message: String(message) }), 'warn');
        return false;
      }
      pushToast(`${label} failed · ${message}`, 'danger');
      return false;
    }
  }

  function openConditionBuilder(row: DecoratedBinding) {
    modal.open({
      title: fill(t('workflowBindings.bindingsModule.condition'), { event: String(row.event) }),
      body: (
        <ConditionBuilder
          row={row}
          events={events}
          ladder={ladderQuery.data}
          maxDepth={bindingDefaults.conditionMaxDepth}
          onCancel={() => modal.close()}
          onSave={(cond) => {
            modal.close();
            void persistBindingChange(
              row,
              {
                condition: cond,
                condition_summary: summarizeFlat(cond),
              },
              'Condition saved',
            );
          }}
        />
      ),
    });
  }

  function openBindingDrawer(row: DecoratedBinding) {
    const tpl = tplById.get(row.template_id);
    const recentMatching = events.filter((e) => e.event === row.event);
    drawer.open({
      title: fill(t('workflowBindings.bindingsModule.binding'), { event: String(row.event) }),
      size: 'lg',
      body: (
        <div>
          <div className="kvgrid">
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('workflowBindings.bindingsModule.event')}</span>
              <span className="kvgrid__val mono">{row.event}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('workflowBindings.bindingsModule.template')}</span>
              <span className="kvgrid__val">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    drawer.close();
                    navigate({ to: '/workflows/templates' });
                  }}
                >
                  {tpl?.name || '—'}
                </button>
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('workflowBindings.bindingsModule.priority')}</span>
              <span className="kvgrid__val mono">{String(row.priority)}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('workflowBindings.bindingsModule.status')}</span>
              <span className="kvgrid__val">
                {(() => {
                  const statusRow = lookupRow('workflow_binding_status', row.status ?? '');
                  if (!statusRow) {
                    return (
                      <Chip
                        label={fill(t('workflowBindings.bindingsModule.workflowBindingStatusMissing'), { value: String(row.status ?? '(unset)') })}
                        kind="danger"
                        size="xs"
                      />
                    );
                  }
                  return (
                    <Chip
                      label={statusRow.label ?? row.status ?? ''}
                      kind={(statusRow.tone as ChipKind) ?? 'neutral'}
                      size="xs"
                    />
                  );
                })()}
              </span>
            </div>
          </div>
          <div className="section-eyebrow">{t('workflowBindings.bindingsModule.overrideLadder')}</div>
          <div style={{ padding: '0 14px 8px' }}>
            <LadderViz resolution={ladderQuery.data} />
          </div>
          <div className="section-eyebrow">{t('workflowBindings.bindingsModule.condition2')}</div>
          <pre className="wf-code-block" data-testid="wf-binding-cond-pre">
{JSON.stringify(row.condition || {}, null, 2)}
          </pre>
          <div className="section-eyebrow">{t('workflowBindings.bindingsModule.rulePreview')}</div>
          <div className="wf-code-block">
            {summarizeFlat(row.condition)}
          </div>
          <div style={{ padding: '8px 14px', display: 'flex', gap: '8px' }}>
            <Button
              label={t('workflowBindings.bindingsModule.editConditionVisually')}
              iconName="edit"
              kind="ghost"
              // W37 — opens the condition builder modal whose Save dispatches
              // `register_workflow_binding_v1`. Gate the entry point so the
              // FE surface fail-closes optimistically instead of letting the
              // operator reach a Save they can't execute. Closes REAUDIT4
              // WORKFLOWS NEW P1.
              capability={CAP.WORKFLOWS_WRITE}
              onClick={() => openConditionBuilder(row)}
            />
            <Button
              label={t('workflowBindings.bindingsModule.decisionEvidence')}
              iconName="right"
              kind="ghost"
              onClick={() => {
                drawer.close();
                navigate({ to: '/insights/decisions' });
              }}
              title={t('workflowBindings.bindingsModule.openInsightsDecisionsFor')}
            />
          </div>
          <div className="section-eyebrow">{t('workflowBindings.bindingsModule.testAgainstRecentEvents')}</div>
          <div className="wf-recent-events">
            {recentMatching.slice(0, 6).map((e) => {
              const matches = legacyMatches(e.payload, row.condition);
              return (
                <div key={e.id} className="wf-recent-event-row">
                  <Dot kind={matches ? 'good' : 'danger'} />
                  <span className="mono" style={{ width: '120px' }}>
                    {e.id}
                  </span>
                  <span style={{ flex: 1, fontSize: '11.5px', color: 'var(--ink-2)' }}>
                    {JSON.stringify(e.payload).slice(0, 60)}
                  </span>
                  <Chip
                    label={matches ? t('workflowBindings.bindingsModule.matches') : t('workflowBindings.bindingsModule.noMatch')}
                    kind={matches ? 'good' : 'neutral'}
                    size="xs"
                  />
                </div>
              );
            })}
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            label={t('workflowBindings.bindingsModule.viewRuns')}
            iconName="right"
            kind="ghost"
            onClick={() => {
              drawer.close();
              go(`/workflows/runs?template=${encodeURIComponent(row.template_id)}`);
            }}
          />
          {(() => {
            // Cycle E2 (Workflows P1 #4) — Re-enable/Disable button is
            // canonical-row-driven via `workflow_binding_status.metadata
            // .toggle_to` + `metadata.toggle_label`. Replaces the inline
            // `row.status === 'disabled' ? 'Re-enable' : 'Disable'` ternary
            // and the literal `next = 'active' / 'disabled'` branch.
            // Missing canonical row → button stays disabled (no fabricated
            // toggle).
            // W61 (Workflows P2-3) — `toggle_kind` is also row-driven so the
            // Re-enable-vs-Disable button kind is sourced from canonical
            // metadata instead of an inline `toggleTo === 'active' ? 'primary'
            // : 'danger'` literal compare. Missing canonical metadata →
            // button stays disabled (no fabricated kind).
            const statusRow = lookupRow('workflow_binding_status', row.status) as
              | { metadata?: { toggle_to?: string; toggle_label?: string; toggle_kind?: 'primary' | 'ghost' | 'danger' } }
              | null;
            const toggleTo = statusRow?.metadata?.toggle_to;
            const toggleLabel = statusRow?.metadata?.toggle_label;
            const toggleKind = statusRow?.metadata?.toggle_kind;
            if (!toggleTo || !toggleLabel || !toggleKind) {
              return (
                <Button
                  label={fill(t('workflowBindings.bindingsModule.workflowBindingStatusMissing2'), { status: String(row.status) })}
                  kind="ghost"
                  disabled
                  capability={CAP.WORKFLOWS_WRITE}
                />
              );
            }
            return (
              <Button
                label={toggleLabel}
                kind={toggleKind}
                // W37 — persistBindingChange dispatches register_workflow_binding_v1
                // (server-asserts workflows.write). Closes REAUDIT4 WORKFLOWS NEW P1.
                capability={CAP.WORKFLOWS_WRITE}
                onClick={() => {
                  const verb = lookupRow('workflow_binding_status', toggleTo)?.label ?? toggleTo;
                  void persistBindingChange(row, { status: toggleTo }, verb);
                  drawer.close();
                }}
              />
            );
          })()}
        </div>
      ),
    });
  }

  function openNewBinding() {
    if (!canWrite) return;
    // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): the event picker
    // sources strictly from the canonical `workflow_binding_event` lookup
    // (W17 backend seed; mirrored in `seed-raw/lookups.js`). NO fallback —
    // if the category is not seeded the modal renders a loud error state
    // so the gap surfaces instead of silently presenting a stale FE list.
    const eventLookup =
      (getLookups('workflow_binding_event') as Array<{ value: string }> | undefined) ?? [];
    if (eventLookup.length === 0) {
      modal.open({
        title: t('workflowBindings.bindingsModule.newBinding'),
        body: (
          <StateView
            kind="error"
            title={t('workflowBindings.bindingsModule.workflowEventOptionsAre')}
            hint={t('workflowBindings.bindingsModule.theEventCatalogIs')}
          />
        ),
        actions: [],
      });
      return;
    }
    // Cycle E2 (Workflows P1 #7) — modal defaults (priority/stage/
    // scope_type) come from canonical `workflow_binding_defaults`. The
    // modal fails loud when defaults are missing so the gap is visible
    // instead of silently fabricating literals.
    if (
      bindingDefaults.defaultPriority === null ||
      bindingDefaults.defaultStage === null ||
      bindingDefaults.defaultScopeType === null
    ) {
      modal.open({
        title: t('workflowBindings.bindingsModule.newBinding'),
        body: (
          <StateView
            kind="error"
            title={t('workflowBindings.bindingsModule.bindingDefaultsAreNot')}
            hint={t('workflowBindings.bindingsModule.defaultPriorityStageAnd')}
          />
        ),
        actions: [],
      });
      return;
    }
    const eventOptions: ReadonlyArray<string> = eventLookup.map((r) => r.value);
    let event = eventOptions[0]!;
    let template_id = templates[0]?.id || '';
    let priority = String(bindingDefaults.defaultPriority);
    let stage = bindingDefaults.defaultStage;
    const defaultScopeType = bindingDefaults.defaultScopeType;
    modal.open({
      title: t('workflowBindings.bindingsModule.newBinding'),
      body: (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '10px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono">{t('workflowBindings.bindingsModule.event')}</label>
            <select
              className="dt-inline-input"
              defaultValue={event}
              onChange={(e) => {
                event = e.target.value;
              }}
              aria-label={t('workflowBindings.bindingsModule.event')}
            >
              {eventOptions.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <label className="mono">{t('workflowBindings.bindingsModule.stage')}</label>
            <input
              className="dt-inline-input mono"
              type="text"
              defaultValue={stage}
              onChange={(e) => {
                stage = e.target.value;
              }}
              aria-label={t('workflowBindings.bindingsModule.stageKey')}
            />
            <label className="mono">{t('workflowBindings.bindingsModule.template')}</label>
            <select
              className="dt-inline-input"
              defaultValue={template_id}
              onChange={(e) => {
                template_id = e.target.value;
              }}
              aria-label={t('workflowBindings.bindingsModule.template')}
            >
              {templates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <label className="mono">{t('workflowBindings.bindingsModule.priority')}</label>
            <input
              className="dt-inline-input"
              type="number"
              defaultValue={priority}
              onChange={(e) => {
                priority = e.target.value;
              }}
              aria-label={t('workflowBindings.bindingsModule.priority')}
            />
          </div>
          <div className="state__hint" style={{ padding: '8px 4px 0' }}>
            {t('workflowBindings.bindingsModule.createsTheBindingThrough')}
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowBindings.bindingsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('workflowBindings.bindingsModule.create')}
            kind="primary"
            capability={CAP.WORKFLOWS_WRITE}
            onClick={async () => {
              try {
                // Wave 5 RE-AUDIT (WORKFLOWS.md P0 #2): canonical Phase B6
                // RPC contract key is `workflow_template_id` (migration
                // 202604280221), not `template_id`. The api facade adapter
                // still translates `template_id` defensively, but call sites
                // send the canonical key.
                //
                // Cycle E2 (Workflows P1 #7) — priority parses to canonical
                // default from `workflow_binding_defaults` (no `|| 10`
                // literal fallback). When the user clears the input the
                // canonical default applies; an invalid number surfaces
                // a danger toast instead of silently writing `10`.
                const parsedPriority = parseInt(priority, 10);
                const finalPriority = Number.isFinite(parsedPriority)
                  ? parsedPriority
                  : (bindingDefaults.defaultPriority as number);
                const bindingKey = `${event}.${stage}`;
                const result = await registerBinding.mutateAsync({
                  binding_key: bindingKey,
                  stage_key: stage,
                  scope_type: defaultScopeType,
                  scope_id: scope.tenant?.id ?? null,
                  event,
                  workflow_template_id: template_id,
                  priority: finalPriority,
                  enabled: true,
                });
                const enabledStatus =
                  ((getLookups('workflow_binding_status') as Array<{ value: string; metadata?: { is_enabled?: boolean; is_default?: boolean } }> | undefined) ?? [])
                    .find((row) => row.metadata?.is_enabled === true && row.metadata?.is_default === true)?.value ??
                  defaultBindingStatus;
                await refreshBindingMutationReadback({
                  kind: 'create',
                  bindingKey,
                  stageKey: stage,
                  expectedStatus: enabledStatus || null,
                  expectedTemplateId: template_id,
                  result,
                });
                modal.close();
                pushToast(
                  fill(t('workflowBindings.bindingsModule.bindingCreated'), { event: String(event), stage: String(stage), value: String(tplById.get(template_id)?.name || template_id), finalPriority: String(finalPriority) }),
                  'good',
                );
              } catch (err) {
                pushToast(t('workflowBindings.bindingsModule.workflowBindingCouldNot'), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  function openEventTester() {
    modal.open({
      title: t('workflowBindings.bindingsModule.eventTester'),
      body: <EventTesterBody bindings={decoratedBindings} events={events} />,
      footer: (
        <Button label={t('workflowBindings.bindingsModule.close')} kind="ghost" onClick={() => modal.close()} />
      ),
    });
  }

  function bulkReassignTemplate(rows: DecoratedBinding[]) {
    if (!templates.length) {
      pushToast(t('workflowBindings.bindingsModule.noTemplatesAvailable'), 'warn');
      return;
    }
    let pickedId = templates[0]!.id;
    modal.open({
      title: t('workflowBindings.bindingsModule.pickTemplate'),
      body: (
        <div style={{ padding: '8px 14px' }}>
          <select
            className="dt-inline-input"
            defaultValue={pickedId}
            onChange={(e) => {
              pickedId = e.target.value;
            }}
            aria-label={t('workflowBindings.bindingsModule.template')}
          >
            {templates.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('workflowBindings.bindingsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={fill(t('workflowBindings.bindingsModule.reassign'), { length: String(rows.length) })}
            kind="primary"
            // W37 — bulk reassign dispatches register_workflow_binding_v1 per
            // row (server-asserts workflows.write). Closes REAUDIT4 WORKFLOWS
            // NEW P1.
            capability={CAP.WORKFLOWS_WRITE}
            onClick={async () => {
              const tpl = tplById.get(pickedId);
              const results = await Promise.all(
                rows.map((r) =>
                  persistBindingChange(
                    r,
                    {
                      template_id: pickedId,
                      template_name: tpl?.name || pickedId,
                    },
                    `Reassigned ${r.event}`,
                  ),
                ),
              );
              modal.close();
              const ok = results.filter(Boolean).length;
              pushToast(
                fill(t('workflowBindings.bindingsModule.reassignedBindings'), { ok: String(ok), length: String(rows.length) }),
                ok === rows.length ? 'good' : 'warn',
              );
            }}
          />
        </div>
      ),
    });
  }

  // ---- Events catalog (left pane) ----
  const eventGroups = useMemo(() => {
    const groups: Record<string, WorkflowBinding[]> = {};
    rawBindings.forEach((b) => {
      const root = b.event.split('.')[0]!;
      groups[root] = groups[root] || [];
      groups[root]!.push(b);
    });
    return groups;
  }, [rawBindings]);

  const COLUMNS: Array<DataTableColumn<DecoratedBinding>> = [
    { key: 'event', label: t('workflowBindings.bindingsModule.event'), sortable: true, filterable: true, mono: true, width: '240px' },
    { key: 'stage_key', label: t('workflowBindings.bindingsModule.stage'), sortable: true, filterable: true, mono: true, width: '140px' },
    {
      key: 'template_name',
      label: t('workflowBindings.bindingsModule.template'),
      sortable: true,
      filterable: true,
      reference: {
        items: templates,
        display: (entry) => (entry as WorkflowTemplate).name,
        value: (entry) => (entry as WorkflowTemplate).id,
        sub: (entry) => (entry as WorkflowTemplate).template_id,
      },
    },
    {
      key: 'condition_summary',
      label: t('workflowBindings.bindingsModule.condition2'),
      sortable: false,
      filterable: false,
    },
    { key: 'priority', label: t('workflowBindings.bindingsModule.priority'), align: 'right', sortable: true, type: 'number' },
    {
      key: 'status',
      label: t('workflowBindings.bindingsModule.status'),
      sortable: true,
      filterable: true,
      editable: true,
      render: (raw) => {
        // W27 Cycle D closure: row-driven binding status chip via canonical
        // `workflow_binding_status` lookup. Missing canonical row renders a
        // fail-loud `(missing)` danger chip — no inline ternary that
        // silently coerces unknown values to `neutral`.
        const v = String(raw ?? '');
        const row = lookupRow('workflow_binding_status', v);
        if (!row) {
          return (
            <Chip
              label={fill(t('workflowBindings.bindingsModule.missingBindingStatus'), { value: String(workflowBindingLabel(v)) })}
              kind="danger"
              size="xs"
            />
          );
        }
        return (
          <Chip
            label={(row.label as string | undefined) ?? v}
            kind={(row.tone as ChipKind | undefined) ?? 'neutral'}
            size="xs"
          />
        );
      },
    },
  ];

  // W67 (Workflows Cycle F-R-7 P1-2) — per-status row action buttons are
  // derived from the canonical `workflow_binding_status` lookup rows. Each
  // row's `metadata.action_label` / `metadata.action_icon` /
  // `metadata.action_kind` describe the button that transitions a binding
  // INTO that status. Replaces the literal three-button matrix
  // (Activate/Pause/Disable) so adding/removing a canonical status row is a
  // single seed update — no FE branch changes. AGENTS.md §2 ZERO HARDCODING
  // + §4 SSOT + §6 row-driven by configuration. Status rows missing
  // `action_label` are skipped (fail-loud: missing seed surfaces a gap, no
  // fabricated default button).
  const statusActionRows =
    (getLookups('workflow_binding_status') as
      | Array<{
          value: string;
          label?: string;
          rank?: number;
          metadata?: {
            action_label?: string;
            action_icon?: string;
            action_kind?: 'primary' | 'danger' | 'ghost';
          };
        }>
      | undefined) ?? [];
  const statusRowActions: Array<DataTableAction<DecoratedBinding>> = statusActionRows
    .filter((r) => typeof r.metadata?.action_label === 'string' && r.metadata.action_label.length > 0)
    .map((r) => {
      const targetStatus = r.value;
      const meta = r.metadata ?? {};
      const action: DataTableAction<DecoratedBinding> = {
        label: meta.action_label as string,
        icon: meta.action_icon,
        capability: CAP.WORKFLOWS_WRITE,
        onClick: (row) => {
          const verb = lookupRow('workflow_binding_status', targetStatus)?.metadata as
            | { action_label?: string }
            | undefined;
          const verbLabel = verb?.action_label ?? targetStatus;
          void persistBindingChange(row, { status: targetStatus }, `${verbLabel}d ${row.event}`);
        },
      };
      if (meta.action_kind) {
        action.kind = meta.action_kind;
      }
      return action;
    });

  const ROW_ACTIONS: Array<DataTableAction<DecoratedBinding>> = [
    {
      label: t('workflowBindings.bindingsModule.editCondition'),
      icon: 'edit',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (row) => openConditionBuilder(row),
    },
    {
      label: t('workflowBindings.bindingsModule.testAgainstRecentEvent'),
      icon: 'play',
      onClick: (row) => openBindingDrawer(row),
    },
    {
      label: t('workflowBindings.bindingsModule.testCondition'),
      icon: 'play',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: async (row) => {
        try {
          // Phase C5: simulate dispatch routes through the canonical
          // simulate_binding_dispatch_v1 RPC so the operator sees the resolved
          // binding without firing a real workflow run.
          //
          // Wave 5 RE-AUDIT (WORKFLOWS.md P1): the canonical RPC at
          // 202604280222 requires `binding_key` (composed `${event}.${stage}`,
          // not the row UUID) AND `stage_key`. We derive the canonical pair
          // from the row's event + stage_key (defaulting to 'default' for
          // legacy seed rows that don't carry an explicit stage).
          // W35c-3: the canonical RPC reads simulation inputs from
          // `p_args->'inputs'` (supabase/migrations/202604280222_*.sql:30),
          // not `payload`. Wrap the sample under `inputs` directly at the
          // callsite so the FE payload matches the canonical contract; the
          // legacy `payload` key would silently produce empty-input simulation
          // runs after cutover. Closes REAUDIT3/WORKFLOWS.md P1-3.
          const sample = events.find((e) => e.event === row.event)?.payload ?? {};
          const stage_key = row.stage_key || 'default';
          const result = await simulateDispatch.mutateAsync({
            binding_key: `${row.event}.${stage_key}`,
            stage_key,
            event: row.event,
            inputs: sample,
          }) as WorkflowBindingSimulationReadback;
          setSimulationReadback({
            workflow_binding_simulation_id: String(
              result.workflow_binding_simulation_id ?? result.id ?? '',
            ),
            binding_key: String(result.binding_key ?? `${row.event}.${stage_key}`),
            stage_key: String(result.stage_key ?? stage_key),
            event: row.event,
            resolved_template_id: result.resolved_template_id
              ? String(result.resolved_template_id)
              : null,
            correlation_id: result.correlation_id ? String(result.correlation_id) : undefined,
          });
          pushToast(fill(t('workflowBindings.bindingsModule.simulated'), { event: String(row.event) }), 'good');
        } catch (err) {
          pushToast(t('workflowBindings.bindingsModule.simulationCouldNotBe'), 'danger');
        }
      },
    },
    ...statusRowActions,
  ];

  const BULK_ACTIONS: Array<DataTableBulkAction<DecoratedBinding>> = [
    {
      label: t('workflowBindings.bindingsModule.disableSelected'),
      icon: 'lock',
      kind: 'danger',
      // W27 Cycle D closure: bulk write affordances must declare the
      // canonical capability so DataTable hides the action from operators
      // without `workflows.write` (mirrors the per-row Disable action's
      // capability). Closes the FE/BE permission drift gap.
      capability: CAP.WORKFLOWS_WRITE,
      onClick: async (rs) => {
        const results = await Promise.all(
          rs.map((r) => persistBindingChange(r, { status: 'disabled' }, `Disabled ${r.event}`)),
        );
        const ok = results.filter(Boolean).length;
        pushToast(fill(t('workflowBindings.bindingsModule.disabledBindings'), { ok: String(ok), length: String(rs.length) }), ok === rs.length ? 'info' : 'warn');
      },
    },
    {
      label: t('workflowBindings.bindingsModule.bulkReassignTemplate'),
      icon: 'shuffle',
      kind: 'ghost',
      capability: CAP.WORKFLOWS_WRITE,
      onClick: (rs) => bulkReassignTemplate(rs),
    },
  ];

  // Keyboard surface — `n` opens new binding, `t` opens tester. Skips when an
  // input/textarea/contentEditable is focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const entry = document.activeElement;
      if (entry && (entry.tagName === 'INPUT' || entry.tagName === 'TEXTAREA' || (entry as HTMLElement).isContentEditable)) return;
      if (e.key === 'n' || e.key === 'N') {
        if (canWrite) openNewBinding();
        e.preventDefault();
      } else if (e.key === 't' || e.key === 'T') {
        openEventTester();
        e.preventDefault();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, decoratedBindings, events, templates]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="wf-bindings"
          eyebrow={t('workflowBindings.bindingsModule.workflows')}
          titleAccent="Bindings"
          titlePlain="& triggers"
        />
        <StateView
          kind="denied"
          capability={CAP.WORKFLOWS_READ}
          hint={t('workflowBindings.bindingsModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (bindingsQuery.isLoading || templatesQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="wf-bindings"
          eyebrow={t('workflowBindings.bindingsModule.workflows')}
          titleAccent="Bindings"
          titlePlain="& triggers"
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (bindingsQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="wf-bindings"
          eyebrow={t('workflowBindings.bindingsModule.workflows')}
          titleAccent="Bindings"
          titlePlain="& triggers"
          pills={[]}
        />
        <StateView kind="error" hint={String(bindingsQuery.error)} />
      </div>
    );
  }

  const eventsCatalog: ReactNode = (
    <aside className="wf-bindings-events" aria-label={t('workflowBindings.bindingsModule.eventCatalog')}>
      <div className="section-eyebrow">{t('workflowBindings.bindingsModule.eventCatalog')}</div>
      <div
        className="state__hint"
        style={{ padding: '0 14px 8px', fontSize: '11px' }}
      >
        {t('workflowBindings.bindingsModule.dragAnEventTo')}
      </div>
      {Object.entries(eventGroups).map(([root, group]) => (
        <div key={root} className="wf-evt-group">
          <div className="wf-evt-group__head">
            <span className="mono">{root}</span>
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              · {group.length}
            </span>
          </div>
          {group.map((b) => {
            const recent = events.filter((e) => e.event === b.event);
            const decorated = decoratedBindings.find((x) => x.id === b.id);
            return (
              <button
                key={b.id}
                type="button"
                className="wf-evt-card"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', b.event)}
                onClick={() => decorated && openBindingDrawer(decorated)}
                aria-label={fill(t('workflowBindings.bindingsModule.openBinding'), { event: String(b.event) })}
              >
                <div className="wf-evt-card__name mono">{b.event}</div>
                <div className="wf-evt-card__meta">
                  <Chip label={fill(t('workflowBindings.bindingsModule.prio'), { priority: String(b.priority) })} kind="info" size="xs" />
                  <span style={{ color: 'var(--ink-3)', fontSize: '10.5px' }}>
                    {fill(t('workflowBindings.bindingsModule.recentCount'), { count: recent.length })}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      ))}
      <div className="section-eyebrow">{t('workflowBindings.bindingsModule.liveInbound')}</div>
      <div className="wf-evt-stream">
        {events.slice(0, 5).map((e) => (
          <div key={e.id} className="wf-evt-stream__row">
            <Dot kind={e.matched_template ? 'good' : 'warn'} />
            <span className="mono" style={{ fontSize: '10.5px' }}>
              {t('workflowBindings.bindingsModule.activityRecorded')}
            </span>
            <span
              style={{
                fontSize: '11px',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {e.event}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );

  // W11-6 page-level tab strip — Bindings vs Dispatches ledger.
  const tabBar: ReactNode = (
    <div
      className="tabs"
      role="tablist"
      aria-label={t('workflowBindings.bindingsModule.workflowBindingsTabs')}
      data-testid="wf-bindings-tabs"
    >
      {BINDINGS_TABS.map((entry) => {
        const count =
          entry.key === 'bindings'
            ? decoratedBindings.length
            : (dispatchesQuery.data?.rows ?? []).length;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={activeTab === entry.key}
            aria-label={t(`workflowBindings.tabs.${entry.key}.aria`)}
            data-testid={`wf-bindings-tab-${entry.key}`}
            className={`tabs__tab ${activeTab === entry.key ? 'is-active' : ''}`}
            onClick={() => switchTab(entry.key)}
          >
            {t(`workflowBindings.tabs.${entry.key}.label`)}{' '}
            <span className="mono" style={{ color: 'var(--ink-3)', fontSize: '11px' }}>
              · {count}
            </span>
          </button>
        );
      })}
    </div>
  );

  // W11-6 columns for the dispatches ledger.
  const DISPATCH_COLUMNS: Array<DataTableColumn<WorkflowBindingDispatch>> = [
    { key: 'created_at', label: t('workflowBindings.bindingsModule.when'), format: 'datetime', sortable: true },
    { key: 'binding_key', label: t('workflowBindings.bindingsModule.binding2'), mono: true, sortable: true, filterable: true },
    { key: 'stage_key', label: t('workflowBindings.bindingsModule.stage'), mono: true, filterable: true },
    { key: 'event', label: t('workflowBindings.bindingsModule.event'), mono: true, sortable: true, filterable: true },
    { key: 'template_name', label: t('workflowBindings.bindingsModule.template'), sortable: true, filterable: true },
    {
      key: 'workflow_run_id',
      label: t('workflowBindings.bindingsModule.run'),
      mono: true,
      render: (raw) => {
        const id = String(raw ?? '');
        if (!id) return '—';
        return (
          <button
            type="button"
            className="btn btn--ghost btn--sm mono"
            onClick={() => {
              go(`/workflows/runs?focus=${encodeURIComponent(id)}`);
            }}
          >
            {id}
          </button>
        );
      },
    },
    {
      key: 'outcome',
      label: t('workflowBindings.bindingsModule.outcome'),
      filterable: true,
      render: (raw) => <DispatchOutcomeChip outcome={String(raw ?? '')} />,
    },
    { key: 'resolved_scope_type', label: t('workflowBindings.bindingsModule.scope'), filterable: true, lookup: 'workflow_trigger_scope_type' },
    { key: 'idempotency_key', label: t('workflowBindings.bindingsModule.idempotency'), mono: true },
  ];

  const DISPATCH_ROW_ACTIONS: Array<DataTableAction<WorkflowBindingDispatch>> = [
    {
      label: t('workflowBindings.bindingsModule.openRun'),
      icon: 'right',
      onClick: (row) => {
        go(`/workflows/runs?focus=${encodeURIComponent(row.workflow_run_id)}`);
      },
    },
    {
      label: t('workflowBindings.bindingsModule.openBinding2'),
      icon: 'right',
      onClick: (row) => {
        // Flip back to the Bindings tab and try to open the matching binding drawer.
        switchTab('bindings');
        const binding = decoratedBindings.find(
          (b) => b.event === row.event && (b.stage_key || 'default') === row.stage_key,
        );
        if (binding) openBindingDrawer(binding);
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="wf-bindings"
        eyebrow={t('workflowBindings.bindingsModule.workflows')}
        titleAccent="Bindings"
        titlePlain="& triggers"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="src" className="chip chip--xs mono">
            {activeTab === 'bindings'
              ? t('workflowBindings.bindingsModule.bindingPolicySettingsLadder')
              : t('workflowBindings.bindingsModule.dispatchOutcomes')}
          </span>,
        ]}
        actions={[
          <Button
            key="test"
            label={t('workflowBindings.bindingsModule.testEvent')}
            iconName="play"
            kind="ghost"
            onClick={openEventTester}
            title="t"
          />,
          <Button
            key="new"
            label={t('workflowBindings.bindingsModule.newBinding')}
            iconName="plus"
            kind="primary"
            capability={CAP.WORKFLOWS_WRITE}
            onClick={openNewBinding}
            title="n"
          />,
        ]}
      />
      {tabBar}
      {activeTab === 'bindings' ? (
        <div className="wf-bindings-layout">
          {eventsCatalog}
          <section className="wf-bindings-right">
            {simulationReadback ? (
              <div
                className="card"
                data-testid="workflow-binding-simulation-readback"
                style={{
                  display: 'grid',
                  gap: 8,
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  marginBottom: 10,
                  padding: 12,
                }}
              >
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.simulation')}</div>
                  <div style={{ overflowWrap: 'anywhere' }}>
                    {simulationReadback.workflow_binding_simulation_id ? t('workflowBindings.bindingsModule.simulationRecorded') : t('workflowBindings.bindingsModule.pending')}
                  </div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.binding2')}</div>
                  <div style={{ overflowWrap: 'anywhere' }}>
                    {simulationReadback.binding_key ? t('workflowBindings.bindingsModule.bindingMatched') : t('workflowBindings.bindingsModule.pending')}
                  </div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.stage')}</div>
                  <div style={{ overflowWrap: 'anywhere' }}>
                    {simulationReadback.stage_key ? t('workflowBindings.bindingsModule.stageMatched') : t('workflowBindings.bindingsModule.pending')}
                  </div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.template')}</div>
                  <div style={{ overflowWrap: 'anywhere' }}>
                    {simulationReadback.resolved_template_id ? t('workflowBindings.bindingsModule.templateResolved') : t('workflowBindings.bindingsModule.notResolved')}
                  </div>
                </div>
              </div>
            ) : null}
            {mutationReadback ? (
              <div
                className="card"
                data-testid="workflow-binding-mutation-readback"
                aria-live="polite"
                style={{
                  display: 'grid',
                  gap: 8,
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  marginBottom: 10,
                  padding: 12,
                }}
              >
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.bindingAction')}</div>
                  <div>{workflowBindingLabel(mutationReadback.kind)}</div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.savedResult')}</div>
                  <Chip
                    label={mutationReadback.confirmed ? t('workflowBindings.bindingsModule.confirmedFromSavedData') : t('workflowBindings.bindingsModule.waitingForSavedData')}
                    kind={mutationReadback.confirmed ? 'good' : 'warn'}
                    size="xs"
                  />
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.binding2')}</div>
                  <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {mutationReadback.bindingKey}
                  </div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.stage')}</div>
                  <div className="mono">{mutationReadback.stageKey}</div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.status')}</div>
                  <div data-testid="workflow-binding-mutation-status">
                    {workflowBindingStatusLabel(mutationReadback.confirmedStatus ?? mutationReadback.expectedStatus)}
                  </div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.template')}</div>
                  <div style={{ overflowWrap: 'anywhere' }}>
                    {tplById.get(mutationReadback.confirmedTemplateId ?? mutationReadback.expectedTemplateId ?? '')?.name ??
                      mutationReadback.confirmedTemplateId ??
                      mutationReadback.expectedTemplateId ??
                      t('workflowBindings.bindingsModule.notReported')}
                  </div>
                </div>
                {mutationReadback.expectedCondition !== undefined ? (
                  <div>
                    <div className="field__label">{t('workflowBindings.bindingsModule.condition2')}</div>
                    <div
                      data-testid="workflow-binding-mutation-condition"
                      style={{ overflowWrap: 'anywhere' }}
                    >
                      {mutationReadback.confirmedConditionSummary ??
                        mutationReadback.expectedConditionSummary ??
                        t('workflowBindings.bindingsModule.notReported')}
                    </div>
                  </div>
                ) : null}
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.listView')}</div>
                  <div data-testid="workflow-binding-mutation-visible-table">
                    {mutationReadback.visibleInList ? t('workflowBindings.bindingsModule.refreshed') : t('workflowBindings.bindingsModule.pending')}
                  </div>
                </div>
                <div>
                  <div className="field__label">{t('workflowBindings.bindingsModule.workflowDirectory')}</div>
                  <div data-testid="workflow-binding-mutation-directory">
                    {mutationReadback.visibleInDirectory ? t('workflowBindings.bindingsModule.refreshed') : t('workflowBindings.bindingsModule.pending')}
                  </div>
                </div>
                {mutationReadback.registrationId ? (
                  <div>
                    <div className="field__label">{t('workflowBindings.bindingsModule.registration')}</div>
                    <div style={{ overflowWrap: 'anywhere' }}>
                      {t('workflowBindings.bindingsModule.registrationRecorded')}
                    </div>
                  </div>
                ) : null}
                {mutationReadback.correlationId ? (
                  <div>
                    <div className="field__label">{t('workflowBindings.bindingsModule.reference')}</div>
                    <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {t('workflowBindings.bindingsModule.recorded')}
                    </div>
                  </div>
                ) : null}
                {mutationReadback.error ? (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div className="field__label">{t('workflowBindings.bindingsModule.saveNote')}</div>
                    <div>{mutationReadback.error}</div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <DataTable<DecoratedBinding>
              columns={COLUMNS}
              rows={decoratedBindings}
              viewKey="workflow_bindings"
              entityKind="workflow_binding"
              onRowClick={(row) => openBindingDrawer(row)}
              rowActions={ROW_ACTIONS}
              bulkActions={BULK_ACTIONS}
              onCellEdit={async (row, key, val) => {
                await persistBindingChange(row, { [key]: val } as Partial<DecoratedBinding>, `Updated ${key}`);
                return { ok: true };
              }}
            />
          </section>
        </div>
      ) : null}
      {activeTab === 'dispatches' ? (
        dispatchesQuery.isLoading ? (
          <StateView kind="loading" />
        ) : dispatchesQuery.error ? (
          <StateView kind="error" hint={String(dispatchesQuery.error)} />
        ) : (
          <DataTable<WorkflowBindingDispatch>
            columns={DISPATCH_COLUMNS}
            rows={dispatchesQuery.data?.rows ?? []}
            viewKey="workflow_binding_dispatches"
            entityKind="workflow_binding_dispatch"
            rowActions={DISPATCH_ROW_ACTIONS}
          />
        )
      ) : null}
      {drawer.node}
      {modal.node}
    </div>
  );
}

// settlements.tsx — TS/React port of demo-v2/assets/js/modules/finance-settlements.js
// Settlement batches kanban (open/locked/approved/posted/canceled). Backed by:
//   - public.settlement_batches (RLS authenticated SELECT)
//   - public.ui_create_settlement_batch_v1 / public.ui_transition_settlement_batch_v1
//     (Console-safe wrappers over canonical service write paths)
//   - workflow_handlers.execute_settlement_batch_v1
//   - workflow_handlers.execute_variance_gate_v3
//   - public.compute_cod_payment_collection_summary_v1
//   - cod_driver_shift_settlement_v2 operation_template
//
// Hardening per __audit__/F:
//   - Canceled column added (terminal state visibility).
//   - Variance flag derived from settlement_policy.locking.max_variance_amount
//     (not from a hardcoded seed boolean).
//   - Aging chip on Locked cards (time since updated_at).
//   - scope_type select sourced from settlement_scope_type lookup, not hardcoded.
//   - Capability fixed to 'settlements.write' (registry-correct), no more 'finance.write'.
//   - Detail rows extracted to shared _shared.tsx (zero redundancy).
//
// W11-1 / W8-4 closure:
//   - The five FE-derived fields (expected_amount, collected_amount,
//     remitted_amount, posted_at, variance_flag) and the legacy
//     `batch_id`/`scope` aliases are dropped from the FE row interface.
//     Modules read derived totals from the paired registry resource
//     `settlement_batch_summary` (canonical view
//     `public.v_settlement_batch_summary`, migration
//     202604301120_v_settlement_batch_summary.sql) joined to each row by id.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Stepper, type StepperStage } from '@/components/Stepper';
import { StateView } from '@/components/StateView';
import {
  useCompleteResourceList,
  useResourceRowsByIds,
  useResourceListsByFilters,
  useResolveSettings,
  useCreateSettlementBatch,
  useTransitionSettlementBatch,
  useApplySettlement,
  useRejectSettlement,
} from '@/lib/queries';
import { useDrawer, useModal, type OpenDrawerOptions } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useI18n } from '@/lib/i18n';
import { getLookups, lookupRow, type CreateSettlementBatchArgs } from '@/lib/api';
import { getSupabaseClient } from '@/lib/supabase';
import { DetailRow, SeamLine } from './_shared';
import { agingBucket, varianceState } from './_matcher';
import {
  type FinanceScopeLabelRow,
  financeUrlScopeLabel,
  readFinanceUrlScope,
  settlementScopeFilters,
} from './_scope';

/**
 * Derive the settlement detail-drawer Stepper stages from canonical
 * `settlement_status` lookup rows.
 *
 * W75-Finance Cycle F-R-15 closure (P2): replaces the inline literal
 * `STAGES: StepperStage[] = [...]` array with row-driven derivation. Each
 * stepper-eligible status row carries `metadata.is_stepper_stage: true`
 * (open/locked/approved/posted); the terminal `canceled` row stays `false`
 * because it is not part of the linear progression. Ordering follows
 * canonical `rank` so adding/removing a stepper stage is a metadata-only
 * seed update. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) +
 * §6 (row-driven by configuration).
 */
function deriveStepperStages(): StepperStage[] {
  type StatusLookupRow = {
    value: string;
    label?: string;
    rank?: number;
    metadata?: { is_stepper_stage?: boolean };
  };
  const rows = (getLookups('settlement_status') as StatusLookupRow[] | undefined) ?? [];
  return rows
    .filter((r) => r.metadata?.is_stepper_stage === true)
    .slice()
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .map((r) => ({ id: r.value, label: r.label ?? r.value }));
}

/**
 * All status columns we render in the kanban (terminal `canceled` included for visibility).
 *
 * W73-Finance Cycle F-R-13 closure (P2-3): kanban columns derive from canonical
 * `settlement_status` lookup rows (apps/console-v2/src/lib/seed-raw/lookups.js).
 * Each row carries `metadata.is_kanban_column` (filter) + `rank` (ordering)
 * so adding/removing a column is metadata-only and stays SSOT-aligned with
 * settlements migration 202601212860 / W57b canonical pack.
 * AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
 */
type KanbanColumn = { id: string; label: string };
function deriveKanbanColumns(): ReadonlyArray<KanbanColumn> {
  type StatusLookupRow = {
    value: string;
    label: string;
    rank?: number;
    metadata?: { is_kanban_column?: boolean };
  };
  const rows = (getLookups('settlement_status') as StatusLookupRow[] | undefined) ?? [];
  return rows
    .filter((r) => r.metadata?.is_kanban_column === true)
    .slice()
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .map((r) => ({ id: r.value, label: r.label }));
}

// W11-1 / W8-4 — schema-drift closure per `__audit__/SCHEMA-DRIFT/FINANCE.md` §10.
//
//   Canonical `public.settlement_batches` (id, organization_id, kind, scope_type,
//   branch_id, client_id, sender_id, subject_type, subject_id, window_start_at,
//   window_end_at, status, status_reason, idempotency_key, version, metadata,
//   created_at, updated_at). The five derived fields (`expected_amount`,
//   `collected_amount`, `remitted_amount`, `posted_at`, `variance_flag`) and
//   the duplicate `batch_id`/`scope` aliases are NOT columns on
//   `settlement_batches` — they project from
//   `settlement_batch_finance_events` + `finance_events` + `settlement_events`
//   via the canonical view `public.v_settlement_batch_summary`
//   (supabase/migrations/202604301120_v_settlement_batch_summary.sql).
interface SettlementBatchRow extends Record<string, unknown> {
  id: string;                    // → settlement_batches.id
  organization_id?: string | null; // → settlement_batches.organization_id
  kind: string;                  // → settlement_batches.kind
  scope_type?: string;           // → settlement_batches.scope_type
  status: string;                // → settlement_batches.status
  status_reason?: string | null; // → settlement_batches.status_reason
  updated_at?: string;           // → settlement_batches.updated_at
  // NOTE (W11-1): `expected_amount`, `collected_amount`, `remitted_amount`,
  // `posted_at`, `variance_flag`, `batch_id`, `scope` are intentionally
  // absent — they project from `v_settlement_batch_summary` (registry key
  // `settlement_batch_summary`).
}

/**
 * Canonical projection from `public.v_settlement_batch_summary`
 * (supabase/migrations/202604301120). Exposes the five derived totals that
 * previously lived inline on the FE row. Joined to `SettlementBatchRow` by id.
 */
interface SettlementBatchSummaryRow extends Record<string, unknown> {
  id: string;
  organization_id: string | null;
  kind: string | null;
  scope_type: string | null;
  status: string | null;
  expected_amount: number;
  collected_amount: number;
  remitted_amount: number;
  posted_at: string | null;
  variance_flag: boolean;
  window_start_at?: string | null;
  window_end_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Default zeroed projection used while the canonical view is loading. */
const EMPTY_SUMMARY: SettlementBatchSummaryRow = {
  id: '',
  organization_id: null,
  kind: null,
  scope_type: null,
  status: null,
  expected_amount: 0,
  collected_amount: 0,
  remitted_amount: 0,
  posted_at: null,
  variance_flag: false,
};

interface NewBatchSeed {
  kind: string;
  scope_type: string;
  date: string;
  context: Record<string, string>;
}

type SettlementDrawerState =
  | { kind: 'batch'; batchId: string }
  | null;

interface ScopeLookup {
  value: string;
  label: string;
  metadata?: Record<string, unknown>;
}

interface SettlementContextRequirement {
  payload_key: string;
  label: string;
  resource: string;
  value_key?: string;
  subject_type?: string;
  hint?: string;
}

interface SettlementScopeMetadata {
  console_context?: {
    required?: SettlementContextRequirement[];
    unsupported_message?: string;
  };
}

interface BranchOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  code?: string | null;
  name?: string | null;
}

interface ClientOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  name?: string | null;
  slug?: string | null;
  status?: string | null;
}

interface DriverOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  user_id?: string | null;
  user_full_name?: string | null;
  user_email?: string | null;
  driver_code?: string | null;
  status?: string | null;
  is_active?: boolean | null;
}

// W58-Finance+Support REDO closure: settlement_status lifecycle helper.
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): every "is the batch in
// state X" branch resolves through canonical `settlement_status` lookup
// rows. The `metadata.lifecycle` and `metadata.allows_*` flags drive
// button-disabled semantics. Missing/malformed rows leave `null` so the
// canonical RPC remains the final gate (UI never silently disables on
// phantom data).
type SettlementLifecycle = 'working' | 'terminal';
type SettlementLifecycleMetadata = {
  lifecycle?: SettlementLifecycle;
  is_terminal?: boolean;
  allows_approve?: boolean;
  allows_reject?: boolean;
};
function settlementLifecycle(status: unknown): SettlementLifecycleMetadata | null {
  if (status == null) return null;
  const list = (getLookups('settlement_status') as ScopeLookup[] | undefined) ?? [];
  const row = list.find((r) => r.value === String(status));
  if (!row) return null;
  const m = row.metadata as SettlementLifecycleMetadata | undefined;
  return m ?? null;
}
function settlementAllows(
  status: unknown,
  capability: keyof Pick<SettlementLifecycleMetadata, 'allows_approve' | 'allows_reject'>,
): boolean {
  return settlementLifecycle(status)?.[capability] === true;
}

function settlementStatusLabel(status: unknown): string {
  const value = String(status ?? '');
  return lookupRow('settlement_status', value)?.label ?? value;
}

type SettlementTransitionAction = {
  value: string;
  label: string;
  rank?: number;
  metadata?: {
    from_status?: string;
    to_status?: string;
    console_visible?: boolean;
  };
};
function settlementTransitionActions(status: unknown): SettlementTransitionAction[] {
  if (status == null) return [];
  const list =
    (getLookups('settlement_batch_transition_action') as SettlementTransitionAction[] | undefined) ??
    [];
  return list
    .filter((row) => {
      const m = row.metadata;
      return m?.from_status === String(status) && m.to_status && m.console_visible !== false;
    })
    .slice()
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
}

function scopeMetadata(scopeType: unknown): SettlementScopeMetadata | null {
  if (scopeType == null) return null;
  const list = (getLookups('settlement_scope_type') as ScopeLookup[] | undefined) ?? [];
  const row = list.find((r) => r.value === String(scopeType));
  return (row?.metadata as SettlementScopeMetadata | undefined) ?? null;
}

function scopeContextRequirements(scopeType: unknown): SettlementContextRequirement[] {
  const required = scopeMetadata(scopeType)?.console_context?.required;
  return Array.isArray(required) ? required.filter((r) => r.payload_key && r.resource) : [];
}

function scopeUnsupportedMessage(scopeType: unknown): string | null {
  return scopeMetadata(scopeType)?.console_context?.unsupported_message ?? null;
}

function optionLabel(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return String(row.id ?? row.user_id ?? 'Option');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function SettlementsModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.SETTLEMENTS_READ);
  const { scope, currentTenantId } = useIdentity();
  const { fmtCurrency } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const [activeDrawer, setActiveDrawer] = useState<SettlementDrawerState>(null);
  const [pendingCreatedBatchId, setPendingCreatedBatchId] = useState<string | null>(null);
  const backendSafeFilters = Boolean(getSupabaseClient());
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const settingsScope = useMemo(
    () =>
      tenantId
        ? {
            tenant: { id: tenantId, rank: 2 },
            organization_id: tenantId,
          }
        : undefined,
    [tenantId],
  );

  // AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): lock-approval SLA +
  // variance threshold resolve STRICTLY from canonical `settlement_policy`
  // via the settings ladder. NO fallback constants — a missing canonical
  // row means the seed is broken, not that the FE should pick a default.
  // Render a loud error state (below) so the operator sees the gap instead
  // of silently using stale data.
  const settlementPolicy = useResolveSettings('settlement_policy', settingsScope);
  const settlementPolicyValue = settlementPolicy.data?.value as
    | { lock_approval_sla_hours?: number; variance_threshold_sar?: number; batch_scopes?: unknown }
    | undefined;
  const lockApprovalSlaHours = settlementPolicyValue?.lock_approval_sla_hours;
  const varianceThresholdSar = settlementPolicyValue?.variance_threshold_sar;
  const policyBatchScopes = useMemo(() => {
    return Array.isArray(settlementPolicyValue?.batch_scopes)
      ? settlementPolicyValue.batch_scopes.filter(
          (scope): scope is string => typeof scope === 'string' && scope.trim().length > 0,
        )
      : [];
  }, [settlementPolicyValue?.batch_scopes]);

  const urlScope = readFinanceUrlScope();
  const baseRowsQuery = useCompleteResourceList<SettlementBatchRow>('settlement_batches', undefined, {
    enabled: !urlScope,
  });
  const scopedSummaryListQuery = useResourceListsByFilters<SettlementBatchSummaryRow>(
    'settlement_batch_summary',
    urlScope ? settlementScopeFilters(urlScope, { backendSafe: backendSafeFilters }) : [],
    undefined,
    { enabled: Boolean(urlScope) },
  );
  const clientScopeQuery = useResourceRowsByIds<FinanceScopeLabelRow>(
    'clients',
    urlScope?.kind === 'client' ? [urlScope.id] : [],
    { enabled: urlScope?.kind === 'client' },
  );
  const partnerScopeQuery = useResourceRowsByIds<FinanceScopeLabelRow>(
    'marketplace_participants',
    urlScope?.kind === 'partner' ? [urlScope.id] : [],
    { enabled: urlScope?.kind === 'partner' },
  );
  const scopeLabelRows = useMemo(
    () => [
      ...(clientScopeQuery.data?.rows ?? []),
      ...(partnerScopeQuery.data?.rows ?? []),
    ],
    [clientScopeQuery.data?.rows, partnerScopeQuery.data?.rows],
  );
  const rows = urlScope
    ? ((scopedSummaryListQuery.data?.rows ?? []) as SettlementBatchRow[])
    : (baseRowsQuery.data?.rows ?? []);

  // W11-1 / W8-4 — join the canonical projection view
  // `public.v_settlement_batch_summary` (registry resource key
  // `settlement_batch_summary`) to surface derived totals (expected_amount,
  // collected_amount, remitted_amount, posted_at, variance_flag) without
  // duplicating them onto the canonical row interface.
  const baseSummaryQuery = useCompleteResourceList<SettlementBatchSummaryRow>(
    'settlement_batch_summary',
    undefined,
    { enabled: !urlScope },
  );
  const summaryRows = (urlScope ? scopedSummaryListQuery.data?.rows : baseSummaryQuery.data?.rows) ?? [];
  const summaryById = useMemo(() => {
    const map = new Map<string, SettlementBatchSummaryRow>();
    for (const s of summaryRows) map.set(s.id, s);
    return map;
  }, [summaryRows]);
  function summaryFor(id: string): SettlementBatchSummaryRow {
    return summaryById.get(id) ?? { ...EMPTY_SUMMARY, id };
  }
  const isLoading =
    (urlScope ? scopedSummaryListQuery.isLoading : baseRowsQuery.isLoading) ||
    (!urlScope && baseSummaryQuery.isLoading);
  const readError =
    (urlScope ? scopedSummaryListQuery.error : baseRowsQuery.error) ??
    (!urlScope ? baseSummaryQuery.error : null);

  const now = useMemo(() => new Date(), []);

  // W73-Finance Cycle F-R-13 closure (P2-3): kanban columns derived from
  // canonical `settlement_status` lookup rows. Computed once per mount;
  // backing seed-raw rows are static so no extra deps are required.
  const kanbanColumns = useMemo<ReadonlyArray<KanbanColumn>>(() => deriveKanbanColumns(), []);

  // W75-Finance Cycle F-R-15 closure (P2): detail-drawer Stepper stages
  // derived from canonical `settlement_status.metadata.is_stepper_stage`.
  // Computed once per mount; backing seed-raw rows are static so no extra
  // deps are required. AGENTS.md §2 + §4 + §6.
  const stepperStages = useMemo<StepperStage[]>(() => deriveStepperStages(), []);

  // Phase B5/C4 mutation hooks — Approve (apply_settlement_v1) and Reject
  // (reject_settlement_v1). Each invalidates `settlement_batches` on success
  // so the kanban re-reads with the new status. Caller drives toast UX.
  const createMutation = useCreateSettlementBatch();
  const transitionMutation = useTransitionSettlementBatch();
  const applyMutation = useApplySettlement();
  const rejectMutation = useRejectSettlement();
  const varianceThreshold = varianceThresholdSar ?? 0;

  useEffect(() => {
    if (
      !pendingCreatedBatchId ||
      lockApprovalSlaHours == null ||
      varianceThresholdSar == null
    ) {
      return;
    }
    const item = rows.find((row) => row.id === pendingCreatedBatchId);
    if (!item) return;
    setActiveDrawer({ kind: 'batch', batchId: item.id });
    drawer.open(cardDrawerOptions(item));
    setPendingCreatedBatchId(null);
  }, [
    pendingCreatedBatchId,
    rows,
    summaryRows,
    varianceThreshold,
    lockApprovalSlaHours,
    varianceThresholdSar,
    transitionMutation.isPending,
    applyMutation.isPending,
    rejectMutation.isPending,
  ]);

  useEffect(() => {
    if (
      !activeDrawer ||
      lockApprovalSlaHours == null ||
      varianceThresholdSar == null
    ) {
      return;
    }
    const item = rows.find((row) => row.id === activeDrawer.batchId);
    if (!item) return;
    if (activeDrawer.kind === 'batch') {
      drawer.open(cardDrawerOptions(item));
    }
  }, [
    activeDrawer,
    rows,
    summaryRows,
    varianceThreshold,
    lockApprovalSlaHours,
    varianceThresholdSar,
    transitionMutation.isPending,
    applyMutation.isPending,
    rejectMutation.isPending,
  ]);

  // ─── Strict guards BEFORE any policy-dependent computation ─────────────
  // (All hooks above; non-hook logic + JSX below are now safe to assume
  // non-null policy values.)
  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="settlements"
          eyebrow="Finance"
          titleAccent="Settlements"
          titlePlain="— batch lifecycle"
        />
        <StateView
          kind="denied"
          capability={CAP.SETTLEMENTS_READ}
          hint="You do not have permission to view settlements (settlements.read)."
        />
      </div>
    );
  }
  if (settlementPolicy.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="settlements"
          eyebrow="Finance"
          titleAccent="Settlements"
          titlePlain="— batch lifecycle"
        />
        <StateView kind="loading" />
      </div>
    );
  }
  if (readError) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="settlements"
          eyebrow="Finance"
          titleAccent="Settlements"
          titlePlain="— batch lifecycle"
        />
        <StateView
          kind="error"
          title="Unable to load settlement batches"
          hint={(readError as Error).message}
        />
      </div>
    );
  }
  if (lockApprovalSlaHours == null || varianceThresholdSar == null) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="settlements"
          eyebrow="Finance"
          titleAccent="Settlements"
          titlePlain="— batch lifecycle"
        />
        <StateView
          kind="error"
          title="Settlement policy missing"
          hint="Configure settlement approval SLA and variance thresholds before using this surface."
        />
      </div>
    );
  }

  function deriveVariance(b: SettlementBatchRow) {
    const s = summaryFor(b.id);
    return varianceState(s.expected_amount, s.collected_amount, varianceThreshold);
  }

  function settlementTenantActionDisabledReason(item: SettlementBatchRow): string | undefined {
    const rowTenantId = textOf(item.organization_id) || textOf(summaryFor(item.id).organization_id);
    const activeTenantId = textOf(tenantId);
    if (rowTenantId && (!activeTenantId || rowTenantId !== activeTenantId)) {
      return "Switch to this settlement batch's tenant before changing settlement lifecycle.";
    }
    return undefined;
  }

  function transitionDisabledReason(item: SettlementBatchRow): string | undefined {
    const tenantReason = settlementTenantActionDisabledReason(item);
    if (tenantReason) return tenantReason;
    return transitionMutation.isPending ? 'Settlement transition is already running.' : undefined;
  }

  function approveDisabledReason(item: SettlementBatchRow): string | undefined {
    const tenantReason = settlementTenantActionDisabledReason(item);
    if (tenantReason) return tenantReason;
    if (applyMutation.isPending) return 'Settlement approval is already running.';
    return settlementAllows(item.status, 'allows_approve')
      ? undefined
      : 'This settlement status does not allow approval.';
  }

  function rejectDisabledReason(item: SettlementBatchRow): string | undefined {
    const tenantReason = settlementTenantActionDisabledReason(item);
    if (tenantReason) return tenantReason;
    if (rejectMutation.isPending) return 'Settlement rejection is already running.';
    return settlementAllows(item.status, 'allows_reject')
      ? undefined
      : 'This settlement status does not allow rejection.';
  }

  function variantBatches(): SettlementBatchRow[] {
    return rows.filter(
      (b) => summaryFor(b.id).variance_flag || deriveVariance(b).exceeds_threshold,
    );
  }

  function openVarianceSummary() {
    const variant = variantBatches();
    drawer.open({
      title: 'Variance summary',
      size: 'md',
      body: (
        <div>
          <p className="state__hint">
            {`${variant.length} batch${variant.length === 1 ? '' : 'es'} with variance escalated to manual review.`}
          </p>
          <div className="state__hint" style={{ marginTop: '6px', fontSize: '11px' }}>
            Threshold:{' '}
            <span className="mono">{fmtCurrency(varianceThreshold)}</span>
          </div>
          <div className="card" style={{ marginTop: '12px' }}>
            {variant.map((b) => {
              const v = deriveVariance(b);
              const s = summaryFor(b.id);
              return (
                <div
                  key={b.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 0',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <span className="mono" style={{ width: '120px' }}>{b.id}</span>
                  <span style={{ flex: 1, fontSize: '11.5px' }}>{`${b.kind} · ${s.scope_type ?? b.scope_type ?? '—'}`}</span>
                  <span
                    className="mono"
                    style={{ color: v.tone === 'danger' ? 'var(--danger-ink)' : undefined }}
                  >
                    {fmtCurrency(v.delta)}
                  </span>
                </div>
              );
            })}
            {variant.length === 0 ? (
              <div className="state__hint" style={{ padding: '8px 0' }}>
                No batches in variance.
              </div>
            ) : null}
          </div>
        </div>
      ),
    });
  }

  function openRejectBatchModal(item: SettlementBatchRow) {
    const disabledReason = rejectDisabledReason(item);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    function RejectBatchForm() {
      const [reason, setReason] = useState('');
      const trimmedReason = reason.trim();
      return (
        <div>
          <p className="state__hint">
            Record a rejection reason before canceling this settlement batch.
          </p>
          <div style={{ display: 'grid', gap: '8px', marginTop: '12px' }}>
            <label className="mono" htmlFor="settlement-reject-reason">
              Rejection reason
            </label>
            <textarea
              id="settlement-reject-reason"
              className="dt-inline-input"
              rows={4}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Reject batch"
              kind="danger"
              capability={CAP.SETTLEMENTS_WRITE}
              disabled={!trimmedReason || rejectMutation.isPending}
              onClick={() => {
                rejectMutation.mutate(
                  { settlement_batch_id: item.id, rejection_reason: trimmedReason },
                  {
                    onSuccess: (res) => {
                      modal.close();
                      setActiveDrawer({ kind: 'batch', batchId: item.id });
                      pushToast(`Settlement rejected - ${res.settlement_batch_id}`, 'warn');
                    },
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: 'Reject settlement batch', body: <RejectBatchForm /> });
  }

  function openNewBatchModal() {
    function NewBatchForm() {
      // AGENTS.md §2 (ZERO HARDCODING) — `scope_type` and `kind` resolve
      // exclusively from the canonical lookup categories
      // (`settlement_scope_type`, `settlement_kind`). When the lookup is
      // empty we fail closed: the modal disables the Open batch action and
      // surfaces an explicit "not configured" hint instead of inventing
      // option lists. Single SSOT — no shadow defaults in client code.
      const scopeTypes = useMemo<ScopeLookup[]>(() => {
        const rows = (getLookups('settlement_scope_type') as ScopeLookup[] | undefined) ?? [];
        const allowed = new Set(policyBatchScopes);
        return rows.filter((row) => allowed.has(row.value));
      }, [policyBatchScopes]);

      const kinds = useMemo<ScopeLookup[]>(() => {
        return (getLookups('settlement_kind') as ScopeLookup[] | undefined) ?? [];
      }, []);

      const tenantResourceOpts = useMemo(
        () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
        [tenantId],
      );
      const branchesQuery = useCompleteResourceList<BranchOptionRow>('branches', tenantResourceOpts);
      const clientsQuery = useCompleteResourceList<ClientOptionRow>('clients', tenantResourceOpts);
      const driversQuery = useCompleteResourceList<DriverOptionRow>('drivers', tenantResourceOpts);

      const policyScopesConfigured = policyBatchScopes.length > 0;
      const lookupsConfigured = policyScopesConfigured && scopeTypes.length > 0 && kinds.length > 0;

      const [seed, setSeed] = useState<NewBatchSeed>({
        kind: kinds[0]?.value ?? '',
        scope_type: scopeTypes[0]?.value ?? '',
        date: new Date().toISOString().slice(0, 10),
        context: {},
      });
      const contextRequirements = useMemo(
        () => scopeContextRequirements(seed.scope_type),
        [seed.scope_type],
      );
      const unsupportedMessage = useMemo(
        () => scopeUnsupportedMessage(seed.scope_type),
        [seed.scope_type],
      );
      const contextComplete = contextRequirements.every((req) => Boolean(seed.context[req.payload_key]));
      const optionRowsFor = (req: SettlementContextRequirement) => {
        if (req.resource === 'branches') return branchesQuery.data?.rows ?? [];
        if (req.resource === 'clients') {
          return (clientsQuery.data?.rows ?? []).filter((row) => row.status !== 'inactive');
        }
        if (req.resource === 'drivers') {
          return (driversQuery.data?.rows ?? []).filter((row) => row.is_active !== false);
        }
        return [];
      };
      const optionValueFor = (req: SettlementContextRequirement, row: Record<string, unknown>) => {
        const key = req.value_key || 'id';
        const value = row[key];
        return typeof value === 'string' ? value : String(value ?? '');
      };
      const optionLabelFor = (req: SettlementContextRequirement, row: Record<string, unknown>) => {
        if (req.resource === 'branches') {
          const name = optionLabel(row, ['name', 'code']);
          const code = typeof row.code === 'string' && row.code.trim() ? row.code.trim() : '';
          return code && code !== name ? `${name} - ${code}` : name;
        }
        if (req.resource === 'clients') return optionLabel(row, ['name', 'slug']);
        if (req.resource === 'drivers') return optionLabel(row, ['user_full_name', 'driver_code', 'user_email']);
        return optionLabel(row, ['name', 'label']);
      };
      const requiredOptionsReady = contextRequirements.every((req) => optionRowsFor(req).length > 0);
      const canOpenBatch =
        lookupsConfigured &&
        !unsupportedMessage &&
        requiredOptionsReady &&
        contextComplete &&
        Boolean(seed.date) &&
        !createMutation.isPending;

      function buildCreatePayload(): CreateSettlementBatchArgs {
        const payload: CreateSettlementBatchArgs = {
          kind: seed.kind,
          scope_type: seed.scope_type,
          window_start_at: `${seed.date}T00:00:00.000Z`,
          window_end_at: `${seed.date}T23:59:59.999Z`,
          idempotency_key: `console-v2:settlement-batch:${seed.kind}:${seed.scope_type}:${seed.date}:${Object.values(seed.context).filter(Boolean).join(':') || 'tenant'}`,
          metadata: { source: 'console-v2/finance/settlements' },
        };
        for (const req of contextRequirements) {
          const value = seed.context[req.payload_key];
          if (!value) continue;
          payload[req.payload_key] = value;
          if (req.subject_type) payload.subject_type = req.subject_type;
        }
        return payload;
      }

      return (
        <div>
          <p className="state__hint">
            Opens a settlement batch in open status after the required scope context is selected.
          </p>
          {!lookupsConfigured ? (
            <p
              data-testid="settlement-new-lookups-missing"
              className="state__hint"
              style={{ color: 'var(--danger)', marginTop: '8px' }}
            >
              Settlement scope types, allowed policy scopes, or kinds are not configured. Contact a platform administrator.
            </p>
          ) : null}
          {unsupportedMessage ? (
            <p
              data-testid="settlement-new-scope-unsupported"
              className="state__hint"
              style={{ color: 'var(--danger)', marginTop: '8px' }}
            >
              {unsupportedMessage}
            </p>
          ) : null}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono" htmlFor="settlement-new-kind">Kind</label>
            <select
              id="settlement-new-kind"
              className="dt-inline-input"
              value={seed.kind}
              disabled={kinds.length === 0}
              onChange={(e) => setSeed((s) => ({ ...s, kind: e.target.value }))}
            >
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor="settlement-new-scope">Scope</label>
            <select
              id="settlement-new-scope"
              className="dt-inline-input"
              value={seed.scope_type}
              disabled={scopeTypes.length === 0}
              onChange={(e) => setSeed((s) => ({ ...s, scope_type: e.target.value, context: {} }))}
            >
              {scopeTypes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor="settlement-new-date">Period date</label>
            <input
              id="settlement-new-date"
              className="dt-inline-input"
              type="date"
              value={seed.date}
              onChange={(e) => setSeed((s) => ({ ...s, date: e.target.value }))}
            />
            {contextRequirements.map((req) => {
              const options = optionRowsFor(req);
              return (
                <Fragment key={req.payload_key}>
                  <label className="mono" htmlFor={`settlement-new-${req.payload_key}`}>
                    {req.label}
                  </label>
                  <select
                    id={`settlement-new-${req.payload_key}`}
                    className="dt-inline-input"
                    value={seed.context[req.payload_key] ?? ''}
                    disabled={options.length === 0}
                    onChange={(e) =>
                      setSeed((s) => ({
                        ...s,
                        context: { ...s.context, [req.payload_key]: e.target.value },
                      }))
                    }
                  >
                    <option value="">{`Select ${req.label.toLowerCase()}`}</option>
                    {options.map((row) => {
                      const value = optionValueFor(req, row);
                      if (!value) return null;
                      return (
                        <option key={`${req.payload_key}-${value}`} value={value}>
                          {optionLabelFor(req, row)}
                        </option>
                      );
                    })}
                  </select>
                  {req.hint ? (
                    <>
                      <span />
                      <span className="state__hint">{req.hint}</span>
                    </>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Open batch"
              kind="primary"
              capability={CAP.SETTLEMENTS_WRITE}
              disabled={!canOpenBatch}
              onClick={() => {
                createMutation.mutate(
                  buildCreatePayload(),
                  {
                    onSuccess: (res) => {
                      modal.close();
                      setActiveDrawer({ kind: 'batch', batchId: res.settlement_batch_id });
                      setPendingCreatedBatchId(res.settlement_batch_id);
                      pushToast(`Batch opened - ${res.settlement_batch_id}`, 'good');
                    },
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: 'New settlement batch', body: <NewBatchForm /> });
  }

  function openCardDrawer(item: SettlementBatchRow) {
    setActiveDrawer({ kind: 'batch', batchId: item.id });
    drawer.open(cardDrawerOptions(item));
  }

  function cardDrawerOptions(item: SettlementBatchRow): OpenDrawerOptions {
    const v = deriveVariance(item);
    const s = summaryFor(item.id);
    const transitionActions = settlementTransitionActions(item.status);
    return {
      title: item.id,
      size: 'lg',
      onClose: () => setActiveDrawer(null),
      body: (
        <div>
          <Stepper stages={stepperStages} current={item.status} />
          <div className="card" style={{ marginTop: '14px' }}>
            <DetailRow k="Status" v={settlementStatusLabel(item.status)} />
            {typeof item.status_reason === 'string' && item.status_reason.trim() ? (
              <DetailRow k="Status reason" v={item.status_reason.trim()} />
            ) : null}
            <DetailRow k="Kind" v={item.kind} />
            <DetailRow k="Scope" v={s.scope_type ?? item.scope_type ?? '—'} />
            <DetailRow k="Expected" v={fmtCurrency(s.expected_amount)} />
            <DetailRow k="Collected" v={fmtCurrency(s.collected_amount)} />
            <DetailRow k="Remitted" v={fmtCurrency(s.remitted_amount)} />
            {v.delta !== 0 ? (
              <DetailRow
                k="Variance"
                v={`${fmtCurrency(v.delta)} · threshold ${fmtCurrency(varianceThreshold)} · ${v.exceeds_threshold ? 'manual review required' : 'within tolerance'}`}
                danger={v.tone === 'danger'}
              />
            ) : null}
            <DetailRow k="Posted" v={s.posted_at ? String(s.posted_at) : '—'} />
          </div>
          <h4 className="eyebrow" style={{ marginTop: '14px' }}>Operational backing</h4>
          <div className="card mono" style={{ fontSize: '11px', lineHeight: 1.6 }}>
            <SeamLine k="Summary" v="Settlement summary" />
            <SeamLine k="Expected amount" v="COD collection summary" />
            <SeamLine k="Lifecycle" v="Settlement workflow" />
            <SeamLine k="Variance" v="Manual review gate" />
            <SeamLine k="Threshold" v={fmtCurrency(varianceThreshold)} />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%', flexWrap: 'wrap' }}>
          {transitionActions.map((action) => {
            const toStatus = action.metadata?.to_status;
            const disabledReason = transitionDisabledReason(item);
            if (!toStatus) return null;
            return (
              <Button
                key={action.value}
                label={action.label}
                iconName="arrowR"
                kind="ghost"
                capability={CAP.SETTLEMENTS_WRITE}
                disabled={Boolean(disabledReason)}
                title={disabledReason}
                onClick={() => {
                  const currentDisabledReason = transitionDisabledReason(item);
                  if (currentDisabledReason) {
                    pushToast(currentDisabledReason, 'warn');
                    return;
                  }
                  transitionMutation.mutate(
                    {
                      settlement_batch_id: item.id,
                      to_status: toStatus,
                      payload: {
                        action_key: action.value,
                        source: 'console-v2/finance/settlements',
                      },
                      idempotency_key: `console-v2:settlement-transition:${item.id}:${action.value}:${item.status}:${toStatus}`,
                    },
                    {
                      onSuccess: (res) => {
                        setActiveDrawer({ kind: 'batch', batchId: item.id });
                        pushToast(
                          `Settlement moved to ${res.status ?? toStatus} - ${res.settlement_batch_id}`,
                          'good',
                        );
                      },
                      onError: (err: Error) => pushToast(err.message, 'danger'),
                    },
                  );
                }}
              />
            );
          })}
          <Button
            label="Approve"
            iconName="check"
            kind="ghost"
            capability={CAP.SETTLEMENTS_WRITE}
            disabled={Boolean(approveDisabledReason(item))}
            title={approveDisabledReason(item)}
            onClick={() => {
              const disabledReason = approveDisabledReason(item);
              if (disabledReason) {
                pushToast(disabledReason, 'warn');
                return;
              }
              applyMutation.mutate(
                { settlement_batch_id: item.id },
                {
                  onSuccess: (res) => {
                    setActiveDrawer({ kind: 'batch', batchId: item.id });
                    pushToast(`Settlement applied · ${res.settlement_batch_id}`, 'good');
                  },
                  onError: (err: Error) => pushToast(err.message, 'danger'),
                },
              );
            }}
          />
          <Button
            label="Reject"
            iconName="close"
            kind="danger"
            capability={CAP.SETTLEMENTS_WRITE}
            disabled={Boolean(rejectDisabledReason(item))}
            title={rejectDisabledReason(item)}
            onClick={() => openRejectBatchModal(item)}
          />
        </div>
      ),
    };
  }

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={tenantId ?? ''} />,
    ...(urlScope
      ? [
          <Chip
            key="url-scope"
            label={financeUrlScopeLabel(urlScope, scopeLabelRows)}
            kind="info"
            size="xs"
          />,
        ]
      : []),
    <span key="seam" className="chip chip--xs mono">
      settlement batches · summary
    </span>,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="settlements"
        eyebrow="Finance"
        titleAccent="Settlements"
        titlePlain="— batch lifecycle"
        pills={pills}
        actions={[
          <Button key="variance" label="Variance summary" iconName="alert" kind="ghost" onClick={openVarianceSummary} />,
          <Button key="new" label="New batch" iconName="plus" kind="primary" capability={CAP.SETTLEMENTS_WRITE} onClick={openNewBatchModal} />,
        ]}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <div className="kanban">
          {kanbanColumns.map((stage) => {
            const items = rows.filter((r) => r.status === stage.id);
            // W73-Finance Cycle F-R-13 closure (P1-2): aging chip eligibility
            // resolves through canonical `settlement_status` metadata
            // (`is_aging_eligible: true` on `locked`). Previously gated by
            // an inline `stage.id === 'locked'` literal.
            const stageRow = lookupRow('settlement_status', stage.id);
            const stageAgingEligible =
              (stageRow?.metadata as { is_aging_eligible?: boolean } | undefined)
                ?.is_aging_eligible === true;
            return (
              <div key={stage.id} className="kanban__col">
                <div className="kanban__col-head">
                  <span className="kanban__col-title">{stage.label}</span>
                  <span className="kanban__col-count">{`· ${items.length}`}</span>
                </div>
                <div className="kanban__col-body">
                  {items.map((item) => {
                    const s = summaryFor(item.id);
                    const v = deriveVariance(item);
                    const showVariance = s.variance_flag || v.exceeds_threshold;
                    const aging =
                      stageAgingEligible && item.updated_at
                        ? agingBucket(item.updated_at, now, lockApprovalSlaHours)
                        : null;
                    return (
                      <div
                        key={item.id}
                        className="kanban__card"
                        onClick={() => openCardDrawer(item)}
                      >
                        <div className="kanban__card-head">
                          <span className="kanban__card-id mono">{item.id}</span>
                        </div>
                        <div className="kanban__card-meta mono">
                          {item.kind} · {s.scope_type ?? item.scope_type ?? '—'}
                        </div>
                        <div style={{ fontWeight: 600, marginTop: '4px' }}>
                          {fmtCurrency(s.expected_amount)}
                        </div>
                        <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                          {showVariance ? (
                            <Chip
                              label={`variance ${fmtCurrency(v.delta)}`}
                              kind={v.tone}
                              size="xs"
                              title="Variance against the allowed settlement threshold"
                            />
                          ) : null}
                          {aging ? (
                            <Chip
                              label={`awaiting ${aging.label}`}
                              kind={aging.tone}
                              size="xs"
                              title={`Locked for ${aging.label} · SLA ${lockApprovalSlaHours}h`}
                            />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {items.length === 0 ? (
                    <div
                      className="state__hint"
                      style={{ fontSize: '11px', padding: '12px', textAlign: 'center' }}
                    >
                      No batches
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

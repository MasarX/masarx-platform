// bank-recon.tsx — TS/React port of demo-v2/assets/js/modules/finance-bank-recon.js
// bank_accounts + bank_reconciliation_policy projection.
//
// Hardening per __audit__/F:
//   - HARDCODED ACCOUNTS array removed; account list now comes from
//     useResourceList<BankAccount>('bank_accounts') (canonical RLS-protected projection).
//   - Resolved bank_reconciliation_policy block surfaced (window_days, amount_tolerance, require_unique).
//   - Open items drawer uses the shared `matchBankStatementLines` matcher to
//     mirror workflow_handlers.execute_bank_statement_match_v1 behavior.
//   - Aging chip on suspense / negative-balance accounts.
//   - Detail/seam helpers now from finance/_shared.tsx (no more duplication).
//
// W11-1 / W8-4 closure:
//   - The three FE-derived fields (balance / last_match_at / open_items) are
//     no longer carried on the FE row interface. They project from the
//     canonical RPC `compute_bank_account_balance_v1` (migration
//     202604301110_compute_bank_account_balance_v1.sql) via the paired hook
//     `useBankAccountBalance(account_id)` (queries.ts). Each card subcomponent
//     owns its own hook so React Query caches per-account independently and
//     match/unmatch mutations only refetch the affected account.

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { useDrawer, type OpenDrawerOptions } from '@/hooks/useOverlay';
import {
  useResourceList,
  useCompleteResourceList,
  useResolveSettings,
  useBankAccountBalance,
  useBankReconMatch,
  useBankReconUnmatch,
  useRecordBankStatementEvent,
  useCreateBankAccount,
  useStartWorkflowRun,
} from '@/lib/queries';
import type { BankAccountBalanceResolution } from '@/lib/api';
import { getLookups, resolve_workflow_template_id_v1, lookupRow } from '@/lib/api';
import { ui_list_resource_v1 } from '@/lib/api';
import { pushToast } from '@/components/toastStore';
import { fill, useI18n } from '@/lib/i18n';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  openWorkflowRunContextDrawer,
  type WorkflowRunContextRecord,
  type WorkflowRunDomainEvent,
} from '@/modules/workflows/workflow-run-context';
import { DetailRow, SeamLine } from './_shared';
import {
  agingBucket,
  matchBankStatementLines,
  type FinanceEventLine,
} from './_matcher';

// W11-1 / W8-4 — schema-drift closure per `__audit__/SCHEMA-DRIFT/FINANCE.md` §8:
//
//   The FE row interface mirrors `public.bank_accounts` (canonical columns
//   only). The three previously inlined derived totals (`balance`,
//   `last_match_at`, `open_items`) are NOT columns on `bank_accounts` — they
//   project from `finance_events` + `bank_recon_matches` via the canonical
//   projection RPC `compute_bank_account_balance_v1`.
//
//   Modules consume the projection through `useBankAccountBalance(id)`; the
//   FE row interface no longer carries fictional columns. This keeps the FE
//   row aligned with the backend SSOT and makes the production swap a single
//   `getSupabaseClient()` branch in `data-source.ts:compute_bank_account_balance_v1`.
interface BankAccountRow extends Record<string, unknown> {
  id: string;                    // → bank_accounts.id
  organization_id: string;       // → bank_accounts.organization_id
  key: string;                   // → bank_accounts.key
  name: string;                  // → bank_accounts.name
  bank_name?: string;            // → bank_accounts.bank_name
  currency: string;              // → bank_accounts.currency
  iban_last4?: string | null;    // → bank_accounts.iban_last4
  account_last4?: string | null; // → bank_accounts.account_last4
  is_active: boolean;            // → bank_accounts.is_active
  // NOTE (W11-1): `balance`, `last_match_at`, `open_items` are intentionally
  // absent from this interface — read them via `useBankAccountBalance(id)`.
}

interface BranchOptionRow extends Record<string, unknown> {
  id: string;
  code?: string | null;
  name?: string | null;
  is_active?: boolean | null;
}

type BankReconMatchPolicy = {
  window_days_before: number;
  window_days_after: number;
  amount_tolerance: number;
  require_unique: boolean;
};

type BankReconciliationWorkflowPolicy = {
  enabled?: boolean | null;
  default_bank_account_key?: string | null;
  bank_statement_event_type?: string | null;
};

type SettlementPolicy = {
  batch_scopes?: unknown;
};

// bank_deposit_reconciliation_v2 creates a branch-day settlement batch; broader
// settlement scopes stay available in the Settlements workspace.
const BANK_DEPOSIT_RECONCILIATION_KINDS = new Set(['deposit']);
const BANK_DEPOSIT_RECONCILIATION_SCOPE_TYPES = new Set(['branch_day']);

interface SettlementBatchTargetRow extends Record<string, unknown> {
  id: string;
  status: string;
  kind?: string | null;
  scope_type?: string | null;
  expected_amount?: number | null;
  collected_amount?: number | null;
  currency?: string | null;
}

interface BillingInvoiceTargetRow extends Record<string, unknown> {
  id: string;
  invoice_id?: string | null;
  invoice_number?: string | null;
  client_label?: string | null;
  total?: number | null;
  total_amount?: number | null;
  amount_paid?: number | null;
  amount_due?: number | null;
  currency?: string | null;
  status?: string | null;
  payment_status?: string | null;
  paid_at?: string | null;
}

type BankReconTargetResourceType = 'settlement_batch' | 'billing_invoice';

type BankReconMatchTarget = {
  key: string;
  id: string;
  resourceType: BankReconTargetResourceType;
  label: string;
  status: string;
  expectedAmount: number;
  currency?: string | null;
};

type FinanceDirectionOption = {
  value: string;
  label: string;
};

type LookupOption = {
  value: string;
  label: string;
  rank?: number;
  sort_order?: number;
};

type BankReconDrawerState =
  | { kind: 'account'; accountId: string }
  | { kind: 'openItems'; accountId: string }
  | { kind: 'unmatch'; accountId: string }
  | { kind: 'workflow'; accountId: string }
  | null;

interface BankReconMatchRow extends Record<string, unknown> {
  id: string;
  bank_statement_event_id: string;
  resource_type: string;
  resource_id: string;
  matched_amount: number;
  currency: string;
  status: string;
}

interface WorkflowRunStepReadback extends Record<string, unknown> {
  id: string;
  label?: string | null;
  step_key?: string | null;
  status?: string | null;
  step_status?: string | null;
  sequence?: number | null;
  sort_order?: number | null;
}

/** Default zeroed projection used while the canonical RPC is loading. */
const EMPTY_BALANCE: BankAccountBalanceResolution = {
  ok: true,
  bank_account_id: '',
  organization_id: null,
  currency: null,
  balance: 0,
  last_match_at: null,
  open_items: 0,
};

function financeDirectionOptions(): FinanceDirectionOption[] {
  return getLookups('finance_direction')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((row) => ({ value: row.value, label: row.label || row.value }));
}

function lookupOptions(category: string): LookupOption[] {
  return (getLookups(category) as LookupOption[] | undefined ?? [])
    .slice()
    .sort((a, b) => (a.rank ?? a.sort_order ?? 0) - (b.rank ?? b.sort_order ?? 0))
    .map((row) => ({ value: row.value, label: row.label || row.value }));
}

function defaultOccurredAtInput(): string {
  return new Date().toISOString().slice(0, 16);
}

function datetimeLocalToIso(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// W70-Finance Cycle F-R-10 closure (P1-1): settlement_status lifecycle helper.
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): the "is the batch terminal"
// branch in the open-items drawer's reconcile-target picker resolves through
// canonical `settlement_status` lookup rows. Mirrors the existing
// `settlementLifecycle` helper in finance/settlements.tsx but co-located here
// to avoid a cross-module import for a single utility. Returns `null` for
// unknown/missing values so callers fail loud (do not silently treat
// unknown statuses as either "terminal" or "working").
type SettlementLifecycle = 'working' | 'terminal';
type SettlementLifecycleMetadata = {
  lifecycle?: SettlementLifecycle;
  is_terminal?: boolean;
};
function settlementLifecycle(status: unknown): SettlementLifecycleMetadata | null {
  const row = lookupRow('settlement_status', String(status ?? ''));
  if (!row) return null;
  const m = row.metadata as SettlementLifecycleMetadata | undefined;
  return m ?? null;
}

type InvoiceLifecycleMetadata = {
  lifecycle?: 'working' | 'paid' | 'void';
  is_final?: boolean;
  allows_refund?: boolean;
};

function invoiceLifecycle(status: unknown): InvoiceLifecycleMetadata | null {
  const row = lookupRow('invoice_status', String(status ?? ''));
  if (!row) return null;
  const m = row.metadata as InvoiceLifecycleMetadata | undefined;
  return m ?? null;
}

// W70-Finance Cycle F-R-10 closure (P1-2): bank_recon_match_status lifecycle
// helper. Replaces inline `m.status === 'matched'` literal in
// `openUnmatchPicker`. Returns the canonical metadata so callers can filter by
// `is_active` (active matches eligible for unmatch action).
type BankReconMatchStatusMetadata = {
  is_active?: boolean;
  is_terminal?: boolean;
};
function bankReconMatchStatusMeta(
  status: unknown,
): BankReconMatchStatusMetadata | null {
  const row = lookupRow('bank_recon_match_status', String(status ?? ''));
  if (!row) return null;
  const m = row.metadata as BankReconMatchStatusMetadata | undefined;
  return m ?? null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function activeMatchKey(resourceType: string, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

function billingInvoiceReconciliationAmount(invoice: BillingInvoiceTargetRow): number {
  const paid = numberOf(invoice.amount_paid);
  return paid > 0 ? paid : numberOf(invoice.total ?? invoice.total_amount);
}

function billingInvoiceIsReconcilable(invoice: BillingInvoiceTargetRow): boolean {
  const status = invoice.payment_status ?? invoice.status;
  const lifecycle = invoiceLifecycle(status);
  const isPaidProjection =
    (lifecycle?.lifecycle === 'paid' && lifecycle.allows_refund === true) ||
    ((textOf(invoice.payment_status) === 'paid' || textOf(invoice.status) === 'paid') &&
      textOf(invoice.status) !== 'refunded');
  return (
    isPaidProjection &&
    billingInvoiceReconciliationAmount(invoice) > 0 &&
    numberOf(invoice.amount_due) === 0
  );
}

function OpenItemsMatchForm({
  account,
  accountActionDisabledReason,
  candidates,
  targets,
  matchPolicy,
  matchMutation,
  fmtCurrency,
  fmtDateTime,
  onMatched,
}: {
  account: BankAccountRow;
  accountActionDisabledReason?: string;
  candidates: FinanceEventLine[];
  targets: BankReconMatchTarget[];
  matchPolicy: BankReconMatchPolicy;
  matchMutation: ReturnType<typeof useBankReconMatch>;
  fmtCurrency: (amount: number, currency?: string) => string;
  fmtDateTime: (iso: string | number | Date) => string;
  onMatched: (accountId: string) => void;
}) {
  const { t } = useI18n();
  const [selectedStatementId, setSelectedStatementId] = useState('');
  const [selectedTargetKey, setSelectedTargetKey] = useState('');
  const matchDisabledReason = (() => {
    if (accountActionDisabledReason) return accountActionDisabledReason;
    if (matchMutation.isPending) return t('bankRecon.reasons.matchRunning');
    if (candidates.length === 0) return t('bankRecon.reasons.noCandidates');
    if (!selectedStatementId) return t('bankRecon.reasons.selectLine');
    if (targets.length === 0) return t('bankRecon.reasons.noTargets');
    if (!selectedTargetKey) return t('bankRecon.reasons.selectTarget');
    return undefined;
  })();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accountActionDisabledReason) {
      pushToast(accountActionDisabledReason, 'warn');
      return;
    }
    const selectedLine =
      candidates.find((line) => line.id === selectedStatementId) ?? null;
    if (!selectedLine) {
      pushToast(t('bankRecon.toast.selectLine'), 'warn');
      return;
    }
    const target =
      targets.find((candidate) => candidate.key === selectedTargetKey) ??
      null;
    if (!target) {
      pushToast(t('bankRecon.toast.selectTarget'), 'warn');
      return;
    }
    const targetExpectedAmount = Number(target.expectedAmount);
    if (!Number.isFinite(targetExpectedAmount)) {
      pushToast(t('bankRecon.toast.targetNoAmount'), 'warn');
      return;
    }

    const result = matchBankStatementLines({
      anchor_at: selectedLine.occurred_at,
      expected_amount: targetExpectedAmount,
      expected_currency: target.currency ?? selectedLine.currency,
      direction: selectedLine.direction,
      bank_account_id: account.id,
      candidates: [selectedLine],
      policy: matchPolicy,
    });
    if (result.status === 'ambiguous') {
      pushToast(fill(t('bankRecon.toast.ambiguous'), { n: result.match_count }), 'warn');
      return;
    }
    if (result.status !== 'matched') {
      pushToast(t('bankRecon.toast.noMatch'), 'info');
      return;
    }

    matchMutation.mutate(
      {
        bank_statement_event_id: result.match.id,
        bank_statement_occurred_at: result.match.occurred_at,
        resource_type: target.resourceType,
        resource_id: target.id,
        matched_amount: result.match.amount,
        currency: result.match.currency,
        match_reason: result.reason,
      },
      {
        onSuccess: (res) => {
          setSelectedStatementId('');
          setSelectedTargetKey('');
          onMatched(account.id);
          pushToast(fill(t('bankRecon.toast.matched'), { id: res.bank_recon_match_id }), 'good');
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <p className="state__hint">{t('bankRecon.match.intro')}</p>
      <div className="card mono" style={{ fontSize: '11px', marginTop: '8px', padding: '10px' }}>
        <SeamLine
          k={t('bankRecon.match.window')}
          v={`${matchPolicy.window_days_before} / ${matchPolicy.window_days_after}`}
        />
        <SeamLine k={t('bankRecon.match.tolerance')} v={fmtCurrency(matchPolicy.amount_tolerance)} />
        <SeamLine k={t('bankRecon.match.requireUnique')} v={String(matchPolicy.require_unique)} />
      </div>
      <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
        <label className="mono" htmlFor="bank-recon-statement-line">
          {t('bankRecon.match.statementLine')}
        </label>
        <select
          id="bank-recon-statement-line"
          className="dt-inline-input"
          value={selectedStatementId}
          onChange={(event) => setSelectedStatementId(event.target.value)}
          disabled={candidates.length === 0}
        >
          <option value="">{t('bankRecon.match.selectLine')}</option>
          {candidates.map((line) => (
            <option key={line.id} value={line.id}>
              {line.id} - {line.direction} - {fmtDateTime(line.occurred_at)} -{' '}
              {fmtCurrency(line.amount, line.currency)}
            </option>
          ))}
        </select>

        <label className="mono" htmlFor="bank-recon-target">
          {t('bankRecon.match.target')}
        </label>
        <select
          id="bank-recon-target"
          className="dt-inline-input"
          value={selectedTargetKey}
          onChange={(event) => setSelectedTargetKey(event.target.value)}
          disabled={targets.length === 0}
        >
          <option value="">{t('bankRecon.match.selectTarget')}</option>
          {targets.map((target) => (
            <option key={target.key} value={target.key}>
              {target.label} - {target.status} -{' '}
              {fill(t('bankRecon.match.expected'), {
                amount: fmtCurrency(target.expectedAmount, target.currency ?? undefined),
              })}
            </option>
          ))}
        </select>
      </div>
      <div className="card" style={{ marginTop: '12px' }}>
        {candidates.length === 0 ? (
          <div className="state__hint" style={{ padding: '10px 0' }}>
            {t('bankRecon.match.noLines')}
          </div>
        ) : (
          candidates.map((line) => (
            <div
              key={line.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '6px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span className="mono" style={{ width: '120px' }}>{line.id}</span>
              <span className="mono" style={{ flex: 1, fontSize: '11px' }}>
                {line.direction} · {fmtDateTime(line.occurred_at)}
              </span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {fmtCurrency(line.amount, line.currency)}
              </span>
            </div>
          ))
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: '8px',
          justifyContent: 'flex-end',
          marginTop: '12px',
        }}
      >
        <Button
          label={t('bankRecon.actions.tryMatch')}
          iconName="check"
          kind="primary"
          capability={CAP.FINANCE_WRITE}
          disabled={Boolean(matchDisabledReason)}
          title={matchDisabledReason}
          type="submit"
        />
      </div>
    </form>
  );
}

function ActiveMatchesUnmatchForm({
  account,
  accountActionDisabledReason,
}: {
  account: BankAccountRow;
  accountActionDisabledReason?: string;
}) {
  const { t, fmtCurrency } = useI18n();
  const resourceTypeLabel = (resourceType: string) =>
    t(`bankRecon.resourceType.${resourceType}`, resourceType.replace(/_/g, ' '));
  const { data: bankStatementsResp } =
    useResourceList<FinanceEventLine>('finance_events_bank_statement');
  const { data: matchesResp } =
    useResourceList<BankReconMatchRow>('bank_recon_matches');
  const bankStatements = bankStatementsResp?.rows ?? [];
  const matches = matchesResp?.rows ?? [];
  const unmatchMutation = useBankReconUnmatch();
  const [selectedMatchId, setSelectedMatchId] = useState('');
  const [reason, setReason] = useState('');
  const activeMatches = useMemo(
    () =>
      matches.filter(
        (m) =>
          bankStatements.some(
            (s) => s.id === m.bank_statement_event_id && s.account_id === account.id,
          ) && bankReconMatchStatusMeta(m.status)?.is_active === true,
      ),
    [account.id, bankStatements, matches],
  );
  const selectedMatch =
    activeMatches.find((m) => m.id === selectedMatchId) ?? null;
  const trimmedReason = reason.trim();
  const unmatchDisabledReason = (() => {
    if (accountActionDisabledReason) return accountActionDisabledReason;
    if (unmatchMutation.isPending) return t('bankRecon.reasons.unmatchRunning');
    if (activeMatches.length === 0) return t('bankRecon.reasons.noActiveMatches');
    if (!selectedMatch) return t('bankRecon.reasons.selectActiveMatch');
    if (!trimmedReason) return t('bankRecon.reasons.enterReason');
    return undefined;
  })();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accountActionDisabledReason) {
      pushToast(accountActionDisabledReason, 'warn');
      return;
    }
    if (!selectedMatch) {
      pushToast(t('bankRecon.toast.selectActiveMatch'), 'warn');
      return;
    }
    if (!trimmedReason) {
      pushToast(t('bankRecon.toast.reasonRequired'), 'warn');
      return;
    }
    unmatchMutation.mutate(
      {
        bank_recon_match_id: selectedMatch.id,
        unmatch_reason: trimmedReason,
      },
      {
        onSuccess: (res) => {
          setSelectedMatchId('');
          setReason('');
          pushToast(fill(t('bankRecon.toast.unmatched'), { id: res.bank_recon_match_id }), 'warn');
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} data-testid="bank-recon-unmatch-form">
      <p className="state__hint">{t('bankRecon.unmatch.intro')}</p>
      <div className="card" style={{ marginTop: '12px' }}>
        {activeMatches.length === 0 ? (
          <div className="state__hint" style={{ padding: '10px 0' }}>
            {t('bankRecon.unmatch.none')}
          </div>
        ) : (
          activeMatches.map((m) => (
            <div
              key={m.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(150px, 1fr) minmax(180px, 2fr) auto',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span className="mono" style={{ fontSize: '11px' }}>
                {m.id}
              </span>
              <span style={{ fontSize: '11.5px' }}>
                {resourceTypeLabel(m.resource_type)} - <bdi>{m.resource_id}</bdi>
              </span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {fmtCurrency(m.matched_amount, m.currency)}
              </span>
            </div>
          ))
        )}
      </div>
      <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
        <label className="mono" htmlFor="bank-recon-unmatch-match">
          {t('bankRecon.unmatch.activeMatch')}
        </label>
        <select
          id="bank-recon-unmatch-match"
          className="dt-inline-input"
          value={selectedMatchId}
          onChange={(event) => setSelectedMatchId(event.target.value)}
          disabled={activeMatches.length === 0}
        >
          <option value="">{t('bankRecon.unmatch.selectMatch')}</option>
          {activeMatches.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} - {resourceTypeLabel(m.resource_type)} - {fmtCurrency(m.matched_amount, m.currency)}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="bank-recon-unmatch-reason">
          {t('bankRecon.unmatch.reason')}
        </label>
        <textarea
          id="bank-recon-unmatch-reason"
          data-testid="bank-recon-unmatch-reason"
          className="dt-inline-input"
          rows={4}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('bankRecon.unmatch.reasonPlaceholder')}
        />
      </div>
      <div
        style={{
          display: 'flex',
          gap: '8px',
          justifyContent: 'flex-end',
          marginTop: '12px',
        }}
      >
        <Button
          label={t('bankRecon.actions.unmatch')}
          iconName="close"
          kind="danger"
          capability={CAP.FINANCE_WRITE}
          disabled={Boolean(unmatchDisabledReason)}
          title={unmatchDisabledReason}
          type="submit"
        />
      </div>
    </form>
  );
}

function ReconciliationWorkflowStartForm({
  account,
  accountActionDisabledReason,
  workflowPolicyReady,
  workflowPolicyBlockReason,
  allowedSettlementScopeTypes,
  onClose,
  onStarted,
}: {
  account: BankAccountRow;
  accountActionDisabledReason?: string;
  workflowPolicyReady: boolean;
  workflowPolicyBlockReason: string | null;
  allowedSettlementScopeTypes: string[];
  onClose: () => void;
  onStarted: (input: {
    account: BankAccountRow;
    workflowRunId: string | null;
    payload: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const startWorkflowRun = useStartWorkflowRun();
  const branchesQuery = useResourceList<BranchOptionRow>('branches');
  const branches = useMemo(
    () => (branchesQuery.data?.rows ?? []).filter((branch) => branch.is_active !== false),
    [branchesQuery.data?.rows],
  );
  const kinds = useMemo(
    () => lookupOptions('settlement_kind').filter((kind) => BANK_DEPOSIT_RECONCILIATION_KINDS.has(kind.value)),
    [],
  );
  const scopeTypes = useMemo(() => {
    const allowed = new Set(allowedSettlementScopeTypes);
    return lookupOptions('settlement_scope_type').filter(
      (scope) => allowed.has(scope.value) && BANK_DEPOSIT_RECONCILIATION_SCOPE_TYPES.has(scope.value),
    );
  }, [allowedSettlementScopeTypes]);
  const [seed, setSeed] = useState({
    kind: '',
    scope_type: '',
    branch_id: '',
    date: new Date().toISOString().slice(0, 10),
  });
  const policyScopesConfigured = allowedSettlementScopeTypes.length > 0;
  const lookupsConfigured = policyScopesConfigured && kinds.length > 0 && scopeTypes.length > 0;
  const startDisabledReason = (() => {
    if (accountActionDisabledReason) return accountActionDisabledReason;
    if (!policyScopesConfigured) return t('bankRecon.reasons.scopesMissing');
    if (!lookupsConfigured) return t('bankRecon.reasons.lookupsMissing');
    if (!seed.kind) return t('bankRecon.reasons.selectKind');
    if (!seed.scope_type) return t('bankRecon.reasons.selectScope');
    if (
      !allowedSettlementScopeTypes.includes(seed.scope_type) ||
      !BANK_DEPOSIT_RECONCILIATION_SCOPE_TYPES.has(seed.scope_type)
    ) {
      return t('bankRecon.reasons.scopeNotAllowed');
    }
    if (!seed.date) return t('bankRecon.reasons.selectDate');
    if (seed.scope_type === 'branch_day' && !seed.branch_id) {
      return t('bankRecon.reasons.selectBranch');
    }
    if (!workflowPolicyReady) {
      return workflowPolicyBlockReason ?? t('bankRecon.reasons.workflowNotReady');
    }
    if (startWorkflowRun.isPending) return t('bankRecon.reasons.workflowStarting');
    return undefined;
  })();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accountActionDisabledReason) {
      pushToast(accountActionDisabledReason, 'warn');
      return;
    }
    if (!workflowPolicyReady) {
      pushToast(workflowPolicyBlockReason ?? t('bankRecon.toast.workflowNotReady'), 'warn');
      return;
    }
    const tplId = resolve_workflow_template_id_v1('bank_deposit_reconciliation_v2');
    if (!tplId) {
      pushToast(t('bankRecon.toast.templateMissing'), 'danger');
      return;
    }
    if (!seed.kind || !seed.scope_type || !seed.date) {
      pushToast(t('bankRecon.toast.contextIncomplete'), 'warn');
      return;
    }
    const branch = branches.find((row) => row.id === seed.branch_id) ?? null;
    if (seed.scope_type === 'branch_day' && !branch) {
      pushToast(t('bankRecon.toast.selectBranch'), 'warn');
      return;
    }
    const payload = {
      bank_account_id: account.id,
      bank_account_key: account.key,
      kind: seed.kind,
      scope_type: seed.scope_type,
      branch_id: branch?.id,
      subject_type: branch ? 'branch' : undefined,
      subject_id: branch?.id,
      window_start_at: `${seed.date}T00:00:00.000Z`,
      window_end_at: `${seed.date}T23:59:59.999Z`,
    };
    try {
      const res = await startWorkflowRun.mutateAsync({
        template_id: tplId,
        payload,
        invalidate: [
          'workflow_run_directory',
          'workflow_runs',
          'workflow_run_steps',
          'domain_events',
          'settlement_batches',
          'settlement_batch_summary',
        ],
      });
      await onStarted({
        account,
        workflowRunId: textOf(res.workflow_run_id),
        payload,
      });
      pushToast(
        fill(t('bankRecon.toast.started'), { id: res.workflow_run_id ?? t('bankRecon.toast.pendingId') }),
        'good',
      );
    } catch (err) {
      pushToast(
        fill(t('bankRecon.toast.startFailed'), {
          message: (err as Error)?.message ?? t('bankRecon.toast.unknownError'),
        }),
        'danger',
      );
    }
  }

  return (
    <form onSubmit={handleSubmit} data-testid="bank-recon-workflow-start-form">
      <p className="state__hint">{t('bankRecon.workflow.intro')}</p>
      {!lookupsConfigured ? (
        <p className="state__hint" style={{ color: 'var(--danger)', marginTop: '8px' }}>
          {t('bankRecon.workflow.notConfigured')}
        </p>
      ) : null}
      {workflowPolicyBlockReason ? (
        <p className="state__hint" style={{ color: 'var(--danger)', marginTop: '8px' }}>
          {workflowPolicyBlockReason}
        </p>
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '130px 1fr',
          gap: '8px',
          alignItems: 'center',
          marginTop: '12px',
        }}
      >
        <label className="mono" htmlFor="bank-recon-workflow-kind">
          {t('bankRecon.workflow.kind')}
        </label>
        <select
          id="bank-recon-workflow-kind"
          className="dt-inline-input"
          value={seed.kind}
          disabled={kinds.length === 0}
          onChange={(event) => setSeed((s) => ({ ...s, kind: event.target.value }))}
        >
          <option value="">{t('bankRecon.workflow.selectKind')}</option>
          {kinds.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="bank-recon-workflow-scope">
          {t('bankRecon.workflow.scope')}
        </label>
        <select
          id="bank-recon-workflow-scope"
          className="dt-inline-input"
          value={seed.scope_type}
          disabled={scopeTypes.length === 0}
          onChange={(event) => setSeed((s) => ({ ...s, scope_type: event.target.value }))}
        >
          <option value="">{t('bankRecon.workflow.selectScope')}</option>
          {scopeTypes.map((scope) => (
            <option key={scope.value} value={scope.value}>
              {scope.label}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="bank-recon-workflow-branch">
          {t('bankRecon.workflow.branch')}
        </label>
        <select
          id="bank-recon-workflow-branch"
          className="dt-inline-input"
          value={seed.branch_id}
          disabled={branches.length === 0}
          onChange={(event) => setSeed((s) => ({ ...s, branch_id: event.target.value }))}
        >
          <option value="">{t('bankRecon.workflow.selectBranch')}</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {textOf(branch.code) || branch.id} - {textOf(branch.name) || t('bankRecon.workflow.branch')}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="bank-recon-workflow-date">
          {t('bankRecon.workflow.periodDate')}
        </label>
        <input
          id="bank-recon-workflow-date"
          className="dt-inline-input"
          type="date"
          value={seed.date}
          onChange={(event) => setSeed((s) => ({ ...s, date: event.target.value }))}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={t('bankRecon.actions.startRecon')}
          kind="primary"
          iconName="refresh"
          capability={CAP.FINANCE_WRITE}
          disabled={Boolean(startDisabledReason)}
          title={startDisabledReason}
          type="submit"
        />
      </div>
    </form>
  );
}

function BankStatementIngestForm({
  accounts,
  directionOptions,
  ingestMutation,
  onClose,
  onRecorded,
}: {
  accounts: BankAccountRow[];
  directionOptions: FinanceDirectionOption[];
  ingestMutation: ReturnType<typeof useRecordBankStatementEvent>;
  onClose: () => void;
  onRecorded: (bankAccountId: string) => void;
}) {
  const { t } = useI18n();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [direction, setDirection] = useState(directionOptions[0]?.value ?? '');
  const [amount, setAmount] = useState('');
  const [occurredAt, setOccurredAt] = useState(defaultOccurredAtInput);
  const [statementReference, setStatementReference] = useState('');
  const [description, setDescription] = useState('');

  const selectedAccount = accounts.find((account) => account.id === accountId) ?? null;
  const currency = selectedAccount?.currency ?? '';
  const reference = statementReference.trim();
  const canSubmit =
    Boolean(selectedAccount) &&
    Boolean(direction) &&
    Boolean(currency) &&
    Boolean(amount) &&
    Boolean(occurredAt) &&
    Boolean(reference) &&
    !ingestMutation.isPending;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAccount) {
      pushToast(t('bankRecon.toast.selectAccount'), 'warn');
      return;
    }
    if (!direction) {
      pushToast(t('bankRecon.toast.selectDirection'), 'warn');
      return;
    }
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      pushToast(t('bankRecon.toast.amountPositive'), 'warn');
      return;
    }
    const occurredIso = datetimeLocalToIso(occurredAt);
    if (!occurredIso) {
      pushToast(t('bankRecon.toast.occurredInvalid'), 'warn');
      return;
    }
    if (!reference) {
      pushToast(t('bankRecon.toast.referenceRequired'), 'warn');
      return;
    }

    ingestMutation.mutate(
      {
        bank_account_id: selectedAccount.id,
        bank_account_key: selectedAccount.key,
        direction,
        amount: parsedAmount,
        currency,
        occurred_at: occurredIso,
        idempotency_key: `bank_statement:${selectedAccount.id}:${reference}`,
        metadata: {
          statement_reference: reference,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      },
      {
        onSuccess: (res) => {
          pushToast(fill(t('bankRecon.toast.recorded'), { id: res.finance_event_id }), 'good');
          onRecorded(selectedAccount.id);
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} data-testid="bank-statement-ingest-form">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '140px 1fr',
          gap: '10px',
          alignItems: 'center',
        }}
      >
        <label className="mono" htmlFor="bank-statement-account">
          {t('bankRecon.fields.bankAccount')}
        </label>
        <select
          id="bank-statement-account"
          className="dt-inline-input"
          value={accountId}
          aria-label={t('bankRecon.fields.bankAccount')}
          onChange={(event) => setAccountId(event.target.value)}
          disabled={accounts.length === 0 || ingestMutation.isPending}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.key} - {account.name}
            </option>
          ))}
        </select>

        <label className="mono" htmlFor="bank-statement-direction">
          {t('bankRecon.fields.direction')}
        </label>
        <select
          id="bank-statement-direction"
          className="dt-inline-input"
          value={direction}
          aria-label={t('bankRecon.fields.direction')}
          onChange={(event) => setDirection(event.target.value)}
          disabled={directionOptions.length === 0 || ingestMutation.isPending}
        >
          {directionOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="mono" htmlFor="bank-statement-amount">
          {t('bankRecon.fields.amount')}
        </label>
        <input
          id="bank-statement-amount"
          className="dt-inline-input"
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          aria-label={t('bankRecon.fields.amount')}
          onChange={(event) => setAmount(event.target.value)}
          disabled={ingestMutation.isPending}
        />

        <label className="mono" htmlFor="bank-statement-currency">
          {t('bankRecon.fields.currency')}
        </label>
        <input
          id="bank-statement-currency"
          className="dt-inline-input"
          value={currency}
          aria-label={t('bankRecon.fields.currency')}
          readOnly
        />

        <label className="mono" htmlFor="bank-statement-occurred-at">
          {t('bankRecon.fields.occurredAt')}
        </label>
        <input
          id="bank-statement-occurred-at"
          className="dt-inline-input"
          type="datetime-local"
          value={occurredAt}
          aria-label={t('bankRecon.fields.occurredAt')}
          onChange={(event) => setOccurredAt(event.target.value)}
          disabled={ingestMutation.isPending}
        />

        <label className="mono" htmlFor="bank-statement-reference">
          {t('bankRecon.fields.reference')}
        </label>
        <input
          id="bank-statement-reference"
          className="dt-inline-input"
          value={statementReference}
          aria-label={t('bankRecon.fields.reference')}
          onChange={(event) => setStatementReference(event.target.value)}
          disabled={ingestMutation.isPending}
        />

        <label className="mono" htmlFor="bank-statement-description">
          {t('bankRecon.fields.description')}
        </label>
        <input
          id="bank-statement-description"
          className="dt-inline-input"
          value={description}
          aria-label={t('bankRecon.fields.description')}
          onChange={(event) => setDescription(event.target.value)}
          disabled={ingestMutation.isPending}
        />
      </div>
      <div
        style={{
          display: 'flex',
          gap: '8px',
          justifyContent: 'flex-end',
          marginTop: '14px',
        }}
      >
        <Button
          label={t('common.cancel')}
          kind="ghost"
          disabled={ingestMutation.isPending}
          onClick={onClose}
        />
        <Button
          label={t('bankRecon.actions.recordStatement')}
          iconName="upload"
          kind="primary"
          capability={CAP.FINANCE_WRITE}
          disabled={!canSubmit}
          type="submit"
        />
      </div>
    </form>
  );
}

function BankAccountSetupForm({
  activeTenantId,
  createMutation,
  onClose,
  onCreated,
}: {
  activeTenantId: string | null;
  createMutation: ReturnType<typeof useCreateBankAccount>;
  onClose: () => void;
  onCreated: (bankAccountId: string) => void;
}) {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [bankName, setBankName] = useState('');
  const [currency, setCurrency] = useState('');
  const [ibanLast4, setIbanLast4] = useState('');
  const [accountLast4, setAccountLast4] = useState('');

  const normalizedKey = key.trim().toLowerCase();
  const normalizedName = name.trim();
  const normalizedCurrency = currency.trim().toUpperCase();
  const cleanIbanLast4 = ibanLast4.trim().toUpperCase();
  const cleanAccountLast4 = accountLast4.trim().toUpperCase();
  const last4Ok =
    (!cleanIbanLast4 || /^[0-9A-Z]{4}$/.test(cleanIbanLast4)) &&
    (!cleanAccountLast4 || /^[0-9A-Z]{4}$/.test(cleanAccountLast4));
  const canSubmit =
    Boolean(normalizedKey) &&
    Boolean(normalizedName) &&
    Boolean(normalizedCurrency) &&
    Boolean(activeTenantId) &&
    last4Ok &&
    !createMutation.isPending;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      pushToast(t('bankRecon.toast.accountInvalid'), 'warn');
      return;
    }
    createMutation.mutate(
      {
        organization_id: activeTenantId,
        key: normalizedKey,
        name: normalizedName,
        bank_name: bankName.trim() || null,
        currency: normalizedCurrency,
        iban_last4: cleanIbanLast4 || null,
        account_last4: cleanAccountLast4 || null,
        metadata: {
          source: 'console_v2_bank_recon_setup',
        },
      },
      {
        onSuccess: (res) => {
          pushToast(fill(t('bankRecon.toast.accountCreated'), { key: res.key }), 'good');
          onCreated(res.bank_account_id);
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} data-testid="bank-account-setup-form">
      <p className="state__hint">{t('bankRecon.setup.intro')}</p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '140px 1fr',
          gap: '10px',
          alignItems: 'center',
          marginTop: '12px',
        }}
      >
        <label className="mono" htmlFor="bank-account-key">{t('bankRecon.fields.accountKey')}</label>
        <input
          id="bank-account-key"
          className="dt-inline-input"
          value={key}
          aria-label={t('bankRecon.fields.accountKey')}
          placeholder="main-clearing" // i18n-literal-ok example account key
          onChange={(event) => setKey(event.target.value)}
          disabled={createMutation.isPending}
        />

        <label className="mono" htmlFor="bank-account-name">{t('bankRecon.fields.name')}</label>
        <input
          id="bank-account-name"
          className="dt-inline-input"
          value={name}
          aria-label={t('bankRecon.fields.name')}
          onChange={(event) => setName(event.target.value)}
          disabled={createMutation.isPending}
        />

        <label className="mono" htmlFor="bank-account-bank-name">{t('bankRecon.fields.bank')}</label>
        <input
          id="bank-account-bank-name"
          className="dt-inline-input"
          value={bankName}
          aria-label={t('bankRecon.fields.bank')}
          onChange={(event) => setBankName(event.target.value)}
          disabled={createMutation.isPending}
        />

        <label className="mono" htmlFor="bank-account-currency">{t('bankRecon.fields.currency')}</label>
        <input
          id="bank-account-currency"
          className="dt-inline-input"
          value={currency}
          aria-label={t('bankRecon.fields.currency')}
          maxLength={3}
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          disabled={createMutation.isPending}
        />

        <label className="mono" htmlFor="bank-account-iban-last4">{t('bankRecon.fields.ibanLast4')}</label>
        <input
          id="bank-account-iban-last4"
          className="dt-inline-input"
          value={ibanLast4}
          aria-label={t('bankRecon.fields.ibanLast4')}
          maxLength={4}
          onChange={(event) => setIbanLast4(event.target.value.toUpperCase())}
          disabled={createMutation.isPending}
        />

        <label className="mono" htmlFor="bank-account-account-last4">{t('bankRecon.fields.accountLast4')}</label>
        <input
          id="bank-account-account-last4"
          className="dt-inline-input"
          value={accountLast4}
          aria-label={t('bankRecon.fields.accountLast4')}
          maxLength={4}
          onChange={(event) => setAccountLast4(event.target.value.toUpperCase())}
          disabled={createMutation.isPending}
        />
      </div>
      {!last4Ok ? (
        <div className="state__hint" style={{ marginTop: '10px', color: 'var(--danger-ink)' }}>
          {t('bankRecon.setup.last4Invalid')}
        </div>
      ) : null}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          justifyContent: 'flex-end',
          marginTop: '14px',
        }}
      >
        <Button
          label={t('common.cancel')}
          kind="ghost"
          disabled={createMutation.isPending}
          onClick={onClose}
        />
        <Button
          label={t('bankRecon.actions.createAccount')}
          iconName="plus"
          kind="primary"
          capability={CAP.FINANCE_WRITE}
          disabled={!canSubmit}
          type="submit"
        />
      </div>
    </form>
  );
}

export function BankReconModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.FINANCE_READ);
  const { t, fmtCurrency, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const [activeDrawer, setActiveDrawer] = useState<BankReconDrawerState>(null);
  const now = useMemo(() => new Date(), []);
  const directionOptions = useMemo(() => financeDirectionOptions(), []);
  const { scope, currentTenantId } = useIdentity();
  const activeTenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const settingsScope = useMemo(
    () =>
      activeTenantId
        ? {
            tenant: { id: activeTenantId, rank: 2 },
            organization_id: activeTenantId,
          }
        : undefined,
    [activeTenantId],
  );

  // AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): match policy fields +
  // suspense aging SLA resolve STRICTLY from canonical `bank_recon_policy.*`
  // via the settings ladder. NO fallback constants — a missing canonical row
  // means the seed is broken, not that the FE should pick a default. Render a
  // loud error state (below) so the operator sees the gap instead of
  // silently using stale data.
  const bankReconPolicy = useResolveSettings('bank_recon_policy', settingsScope);
  const bankReconciliationPolicy = useResolveSettings('bank_reconciliation_policy', settingsScope);
  const settlementPolicy = useResolveSettings('settlement_policy', settingsScope);
  const bankReconPolicyValue = bankReconPolicy.data?.value as
    | {
        suspense_aging_sla_hours?: number;
        // W58-Finance+Support REDO closure: badge tone threshold for the
        // "open items" chip in BankAccountCard. Replaces inline `> 3` literal.
        open_items_warn_threshold?: number;
        match?: {
          window_days_before?: number;
          window_days_after?: number;
          amount_tolerance?: number;
          require_unique?: boolean;
        };
      }
    | undefined;
  const bankReconciliationPolicyValue = bankReconciliationPolicy.data?.value as
    | BankReconciliationWorkflowPolicy
    | undefined;
  const settlementPolicyValue = settlementPolicy.data?.value as SettlementPolicy | undefined;
  const allowedSettlementScopeTypes = useMemo(() => {
    return Array.isArray(settlementPolicyValue?.batch_scopes)
      ? settlementPolicyValue.batch_scopes.filter(
          (scope): scope is string => typeof scope === 'string' && scope.trim().length > 0,
        )
      : [];
  }, [settlementPolicyValue?.batch_scopes]);
  const suspenseAgingSlaHours = bankReconPolicyValue?.suspense_aging_sla_hours;
  const openItemsWarnThreshold = bankReconPolicyValue?.open_items_warn_threshold;
  const matchWindowDaysBefore = bankReconPolicyValue?.match?.window_days_before;
  const matchWindowDaysAfter = bankReconPolicyValue?.match?.window_days_after;
  const matchAmountTolerance = bankReconPolicyValue?.match?.amount_tolerance;
  const matchRequireUnique = bankReconPolicyValue?.match?.require_unique;
  const reconciliationWorkflowPolicyReady = bankReconciliationPolicyValue?.enabled === true;
  const reconciliationWorkflowBlockReason = bankReconciliationPolicy.isLoading
    ? t('bankRecon.reasons.workflowLoading')
    : bankReconciliationPolicy.isError
      ? t('bankRecon.reasons.workflowError')
      : reconciliationWorkflowPolicyReady
        ? null
        : t('bankRecon.reasons.workflowDisabled');
  const bankReconciliationPolicyHref = `/platform/config?category=bank_reconciliation_policy${
    activeTenantId
      ? `&scope_type=tenant&scope_id=${encodeURIComponent(activeTenantId)}`
      : ''
  }`;

  const reconciliationReadbackPollingMs = activeDrawer ? 10_000 : false;

  const { data: accountsResp, isLoading: accountsLoading } =
    useResourceList<BankAccountRow>('bank_accounts', undefined, {
      refetchInterval: reconciliationReadbackPollingMs,
    });
  const accounts = accountsResp?.rows ?? [];

  const { data: bankStatementsResp } =
    useResourceList<FinanceEventLine>('finance_events_bank_statement', undefined, {
      refetchInterval: reconciliationReadbackPollingMs,
    });
  const bankStatements = bankStatementsResp?.rows ?? [];

  const { data: bankReconMatchesResp } =
    useResourceList<BankReconMatchRow>('bank_recon_matches', undefined, {
      refetchInterval: reconciliationReadbackPollingMs,
    });
  const bankReconMatches = bankReconMatchesResp?.rows ?? [];
  const activeMatchedStatementIds = useMemo(
    () =>
      new Set(
        bankReconMatches
          .filter((match) => bankReconMatchStatusMeta(match.status)?.is_active === true)
          .map((match) => match.bank_statement_event_id),
      ),
    [bankReconMatches],
  );
  const activeMatchedTargetKeys = useMemo(
    () =>
      new Set(
        bankReconMatches
          .filter((match) => bankReconMatchStatusMeta(match.status)?.is_active === true)
          .map((match) => activeMatchKey(match.resource_type, match.resource_id)),
      ),
    [bankReconMatches],
  );

  // Settlement batches as default reconciliation targets (when the operator
  // confirms a match, link the bank_statement event to an open/locked batch).
  // W11-1: read through the projection view `settlement_batch_summary`
  // (paired view shipped in 202604301120_v_settlement_batch_summary.sql) so
  // derived totals project canonically rather than from FE-fictional columns.
  const { data: batchesResp } =
    useResourceList<SettlementBatchTargetRow>('settlement_batch_summary', undefined, {
      refetchInterval: reconciliationReadbackPollingMs,
    });
  const settlementBatches = batchesResp?.rows ?? [];

  const { data: billingInvoiceRowsResp } =
    useCompleteResourceList<BillingInvoiceTargetRow>(
      'billing_invoice_directory',
      undefined,
      {
        refetchInterval: reconciliationReadbackPollingMs,
      },
    );
  const billingInvoices = useMemo(() => {
    const byId = new Map<string, BillingInvoiceTargetRow>();
    for (const invoice of billingInvoiceRowsResp?.rows ?? []) byId.set(invoice.id, invoice);
    return Array.from(byId.values());
  }, [billingInvoiceRowsResp?.rows]);

  // Phase B5/C4 mutation hooks — bank_recon_match_v1 / bank_recon_unmatch_v1.
  // Both invalidate bank_accounts + finance_events_bank_statement +
  // bank_recon_matches lists on success so the surface re-reads. W11-1 also
  // invalidates the paired `bank_account_balance` projection cache.
  const matchMutation = useBankReconMatch();
  const ingestMutation = useRecordBankStatementEvent();
  const createBankAccountMutation = useCreateBankAccount();
  const policyReady =
    suspenseAgingSlaHours != null &&
    openItemsWarnThreshold != null &&
    matchWindowDaysBefore != null &&
    matchWindowDaysAfter != null &&
    matchAmountTolerance != null &&
    matchRequireUnique != null;

  const matchPolicy: BankReconMatchPolicy = {
    window_days_before: matchWindowDaysBefore ?? 0,
    window_days_after: matchWindowDaysAfter ?? 0,
    amount_tolerance: matchAmountTolerance ?? 0,
    require_unique: matchRequireUnique ?? false,
  };

  useEffect(() => {
    if (!drawer.isOpen || !activeDrawer || !policyReady) return;
    const account = accounts.find((a) => a.id === activeDrawer.accountId);
    if (!account) return;
    if (activeDrawer.kind === 'account') {
      drawer.open(accountDrawerOptions(account));
    } else if (activeDrawer.kind === 'openItems') {
      drawer.open(openItemsDrawerOptions(account));
    } else if (activeDrawer.kind === 'unmatch') {
      drawer.open(unmatchDrawerOptions(account));
    } else if (activeDrawer.kind === 'workflow') {
      drawer.open(reconciliationWorkflowDrawerOptions(account));
    }
  }, [
    drawer.isOpen,
    activeDrawer,
    accounts,
    bankStatements,
    activeMatchedStatementIds,
    activeMatchedTargetKeys,
    bankReconMatches,
    settlementBatches,
    billingInvoices,
    matchPolicy.window_days_before,
    matchPolicy.window_days_after,
    matchPolicy.amount_tolerance,
    matchPolicy.require_unique,
    policyReady,
  ]);

  // ─── Strict guards BEFORE any policy-dependent computation ─────────────
  // (All hooks above; non-hook logic + JSX below are now safe to assume
  // non-null policy values.)
  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="bankRecon"
        />
        <StateView
          kind="denied"
          capability={CAP.FINANCE_READ}
          hint={t('bankRecon.denied')}
        />
      </div>
    );
  }
  if (bankReconPolicy.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="bankRecon"
        />
        <StateView kind="loading" />
      </div>
    );
  }
  if (!policyReady) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="bankRecon"
        />
        <StateView
          kind="error"
          title={t('bankRecon.policyMissing.title')}
          hint={t('bankRecon.policyMissing.hint')}
        />
      </div>
    );
  }

  // matchPolicy is now safe — TS-narrowed to non-null after the strict
  // guards above. Shape mirrors `bank_recon_policy.match.*` from the
  // canonical settings ladder; the matcher receives the resolved object
  // exactly as the backend RPC consumes it.
  function bankAccountTenantActionDisabledReason(account: BankAccountRow): string | undefined {
    const rowTenantId = textOf(account.organization_id);
    const activeId = textOf(activeTenantId);
    if (rowTenantId && (!activeId || rowTenantId !== activeId)) {
      return t('bankRecon.reasons.tenantAction');
    }
    return undefined;
  }

  function statementIngestDisabledReason(): string | undefined {
    if (accounts.length === 0) return t('bankRecon.reasons.ingestNoAccounts');
    if (directionOptions.length === 0) return t('bankRecon.reasons.ingestNoDirections');
    if (!accounts.some((account) => !bankAccountTenantActionDisabledReason(account))) {
      return t('bankRecon.reasons.ingestTenant');
    }
    return undefined;
  }

  function openStatementIngestDrawer() {
    const disabledReason = statementIngestDisabledReason();
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    const mutableAccounts = accounts.filter((account) => !bankAccountTenantActionDisabledReason(account));
    setActiveDrawer(null);
    drawer.open({
      title: t('bankRecon.drawer.ingest'),
      size: 'md',
      body: (
        <BankStatementIngestForm
          accounts={mutableAccounts}
          directionOptions={directionOptions}
          ingestMutation={ingestMutation}
          onClose={drawer.close}
          onRecorded={(bankAccountId) => {
            const account = accounts.find((a) => a.id === bankAccountId);
            setActiveDrawer({ kind: 'openItems', accountId: bankAccountId });
            if (account) drawer.open(openItemsDrawerOptions(account));
          }}
        />
      ),
    });
  }

  function openOpenItemsDrawer(account: BankAccountRow) {
    setActiveDrawer({ kind: 'openItems', accountId: account.id });
    drawer.open(openItemsDrawerOptions(account));
  }

  function openBankAccountSetupDrawer() {
    setActiveDrawer(null);
    drawer.open({
      title: t('bankRecon.actions.newAccount'),
      size: 'md',
      body: (
        <BankAccountSetupForm
          activeTenantId={activeTenantId}
          createMutation={createBankAccountMutation}
          onClose={drawer.close}
          onCreated={(bankAccountId) => {
            const account = accounts.find((a) => a.id === bankAccountId);
            setActiveDrawer({ kind: 'account', accountId: bankAccountId });
            if (account) drawer.open(accountDrawerOptions(account));
          }}
        />
      ),
    });
  }

  function openAccountDrawer(account: BankAccountRow) {
    setActiveDrawer({ kind: 'account', accountId: account.id });
    drawer.open(accountDrawerOptions(account));
  }

  function openItemsDrawerOptions(account: BankAccountRow): OpenDrawerOptions {
    const candidates = bankStatements.filter(
      (s) =>
        s.account_id === account.id &&
        s.attached !== true &&
        !activeMatchedStatementIds.has(s.id),
    );
    const settlementTargets: BankReconMatchTarget[] = settlementBatches
      .filter(
        (batch) =>
          settlementLifecycle(batch.status)?.lifecycle === 'working' &&
          !activeMatchedTargetKeys.has(activeMatchKey('settlement_batch', batch.id)),
      )
      .map((batch) => ({
        key: activeMatchKey('settlement_batch', batch.id),
        id: batch.id,
        resourceType: 'settlement_batch',
        label: fill(t('bankRecon.target.settlementBatch'), { id: batch.id }),
        status: batch.status,
        expectedAmount: numberOf(batch.expected_amount),
        currency: batch.currency,
      }));
    const billingInvoiceTargets: BankReconMatchTarget[] = billingInvoices
      .filter(
        (invoice) =>
          billingInvoiceIsReconcilable(invoice) &&
          !activeMatchedTargetKeys.has(activeMatchKey('billing_invoice', invoice.id)),
      )
      .map((invoice) => ({
        key: activeMatchKey('billing_invoice', invoice.id),
        id: invoice.id,
        resourceType: 'billing_invoice',
        label: fill(t('bankRecon.target.billingInvoice'), { id: invoice.invoice_number ?? invoice.id }),
        status: textOf(invoice.payment_status ?? invoice.status) || t('bankRecon.target.unknownStatus'),
        expectedAmount: billingInvoiceReconciliationAmount(invoice),
        currency: invoice.currency,
      }));
    const targets = [...settlementTargets, ...billingInvoiceTargets];
    return {
      title: fill(t('bankRecon.drawer.openItems'), { key: account.key }),
      size: 'md',
      onClose: () => setActiveDrawer(null),
      body: (
        <OpenItemsMatchForm
          account={account}
          accountActionDisabledReason={bankAccountTenantActionDisabledReason(account)}
          candidates={candidates}
          targets={targets}
          matchPolicy={matchPolicy}
          matchMutation={matchMutation}
          fmtCurrency={fmtCurrency}
          fmtDateTime={fmtDateTime}
          onMatched={(accountId) => setActiveDrawer({ kind: 'openItems', accountId })}
        />
      ),
    };
  }

  function unmatchDrawerOptions(account: BankAccountRow): OpenDrawerOptions {
    return {
      title: fill(t('bankRecon.drawer.activeMatches'), { key: account.key }),
      size: 'md',
      onClose: () => setActiveDrawer(null),
      body: (
        <ActiveMatchesUnmatchForm
          account={account}
          accountActionDisabledReason={bankAccountTenantActionDisabledReason(account)}
        />
      ),
    };
  }

  function openUnmatchPicker(account: BankAccountRow) {
    setActiveDrawer({ kind: 'unmatch', accountId: account.id });
    drawer.open(unmatchDrawerOptions(account));
  }

  async function openStartedReconciliationWorkflowContext({
    account,
    workflowRunId,
    payload,
  }: {
    account: BankAccountRow;
    workflowRunId: string | null;
    payload: Record<string, unknown>;
  }) {
    const runId = textOf(workflowRunId);
    if (!runId) {
      pushToast(t('bankRecon.toast.workflowRefMissing'), 'warn');
      return;
    }

    let latestRun: WorkflowRunContextRecord | null = {
      id: runId,
      workflow_status: 'pending',
      workflow_template_key: 'bank_deposit_reconciliation_v2',
    };
    let latestEvents: WorkflowRunDomainEvent[] = [];
    let firstStep: WorkflowRunStepReadback | null = null;
    try {
      const [runReadback, stepReadback, eventReadback] = await Promise.all([
        ui_list_resource_v1<WorkflowRunContextRecord>('workflow_run_directory', {
          filter: { id: runId },
          page_size: 1,
        }),
        ui_list_resource_v1<WorkflowRunStepReadback>('workflow_run_steps', {
          filter: { workflow_run_id: runId },
          page_size: 25,
        }),
        ui_list_resource_v1<WorkflowRunDomainEvent>('domain_events', {
          filter: { workflow_run_id: runId },
          page_size: 25,
        }),
      ]);
      latestRun = (runReadback.rows?.[0] ?? latestRun) as WorkflowRunContextRecord | null;
      latestEvents = eventReadback.rows ?? [];
      firstStep = (stepReadback.rows ?? [])
        .slice()
        .sort((a, b) => Number(a.sequence ?? a.sort_order ?? 0) - Number(b.sequence ?? b.sort_order ?? 0))[0] ?? null;
    } catch (err) {
      pushToast((err as Error)?.message ?? t('bankRecon.toast.contextUnavailable'), 'warn');
    }

    setActiveDrawer(null);
    openWorkflowRunContextDrawer(drawer, {
      workflowRunId: runId,
      run: latestRun,
      events: latestEvents,
      contextRows: [
        { label: t('bankRecon.fields.bankAccount'), value: <bdi className="mono">{account.key}</bdi> },
        { label: t('bankRecon.context.accountId'), value: <bdi className="mono">{account.id}</bdi> },
        { label: t('bankRecon.context.settlementKind'), value: <bdi className="mono">{textOf(payload.kind)}</bdi> },
        { label: t('bankRecon.context.scopeType'), value: <bdi className="mono">{textOf(payload.scope_type)}</bdi> },
        {
          label: t('bankRecon.context.window'),
          value: (
            <span className="mono">
              <bdi>{textOf(payload.window_start_at)}</bdi> {t('bankRecon.context.to')} <bdi>{textOf(payload.window_end_at)}</bdi>
            </span>
          ),
        },
        {
          label: t('bankRecon.context.firstStep'),
          value: firstStep ? (
            <span className="mono">
              <bdi>{`${firstStep.label ?? firstStep.step_key ?? firstStep.id} - ${firstStep.status ?? firstStep.step_status ?? t('bankRecon.context.pending')}`}</bdi>
            </span>
          ) : (
            <span className="mono">{t('bankRecon.context.pendingConfirmation')}</span>
          ),
        },
      ],
      deepLink: `/workflows/runs?focus=${encodeURIComponent(runId)}`,
      onOpenWorkflowModule: () => {
        window.history.pushState(null, '', `/workflows/runs?focus=${encodeURIComponent(runId)}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
    });
  }

  function reconciliationWorkflowDrawerOptions(account: BankAccountRow): OpenDrawerOptions {
    return {
      title: fill(t('bankRecon.drawer.startRecon'), { key: account.key }),
      size: 'md',
      onClose: () => setActiveDrawer(null),
      body: (
        <ReconciliationWorkflowStartForm
          account={account}
          accountActionDisabledReason={bankAccountTenantActionDisabledReason(account)}
          workflowPolicyReady={reconciliationWorkflowPolicyReady}
          workflowPolicyBlockReason={reconciliationWorkflowBlockReason}
          allowedSettlementScopeTypes={allowedSettlementScopeTypes}
          onClose={drawer.close}
          onStarted={openStartedReconciliationWorkflowContext}
        />
      ),
    };
  }

  function openReconciliationWorkflowStart(account: BankAccountRow) {
    const disabledReason = bankAccountTenantActionDisabledReason(account);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    setActiveDrawer({ kind: 'workflow', accountId: account.id });
    drawer.open(reconciliationWorkflowDrawerOptions(account));
  }

  /**
   * Drawer body for an account detail view. Implemented as a sub-component
   * so it can own its own `useBankAccountBalance(id)` hook — the projection
   * re-fetches when match/unmatch invalidates the `bank_account_balance`
   * cache, and the drawer body re-renders with fresh totals automatically.
   */
  function AccountDrawerBody({ account }: { account: BankAccountRow }) {
    const { data: balance } = useBankAccountBalance(account.id);
    const projection = balance ?? EMPTY_BALANCE;
    const aging =
      projection.balance < 0 && projection.last_match_at
        ? agingBucket(projection.last_match_at, now, suspenseAgingSlaHours ?? 0)
        : null;
    return (
      <div>
        <p className="state__hint">{t('bankRecon.account.intro')}</p>
        <div className="card" style={{ marginTop: '12px' }}>
          <DetailRow k={t('bankRecon.fields.key')} v={<bdi>{account.key}</bdi>} mono />
          <DetailRow k={t('bankRecon.fields.name')} v={<bdi>{account.name}</bdi>} />
          <DetailRow k={t('bankRecon.fields.bank')} v={<bdi>{account.bank_name ?? '—'}</bdi>} />
          <DetailRow k={t('bankRecon.fields.currency')} v={<bdi>{account.currency}</bdi>} mono />
          <DetailRow
            k={t('bankRecon.fields.balance')}
            v={<bdi>{fmtCurrency(projection.balance)}</bdi>}
            danger={projection.balance < 0}
          />
          <DetailRow k={t('bankRecon.actions.openItems')} v={String(projection.open_items)} />
          <DetailRow
            k={t('bankRecon.fields.lastMatch')}
            v={projection.last_match_at ? fmtDateTime(projection.last_match_at) : '—'}
          />
          {account.iban_last4 ? <DetailRow k={t('bankRecon.fields.ibanShort')} v={<bdi>{account.iban_last4}</bdi>} mono /> : null}
          {account.account_last4 ? <DetailRow k={t('bankRecon.fields.acctShort')} v={<bdi>{account.account_last4}</bdi>} mono /> : null}
          {aging ? (
            <DetailRow
              k={t('bankRecon.fields.aging')}
              v={fill(t('bankRecon.account.agingValue'), { age: aging.label, hours: suspenseAgingSlaHours ?? '' })}
              danger={aging.tone === 'danger'}
            />
          ) : null}
        </div>
        <h4 className="eyebrow" style={{ marginTop: '14px' }}>{t('bankRecon.account.resolvedPolicy')}</h4>
        <div className="card mono" style={{ fontSize: '11px', lineHeight: 1.6 }}>
          <SeamLine
            k="window_days_before/after"
            v={`${matchPolicy.window_days_before} / ${matchPolicy.window_days_after}`}
          />
          <SeamLine
            k="amount_tolerance"
            v={fmtCurrency(matchPolicy.amount_tolerance)}
          />
          <SeamLine
            k="require_unique"
            v={String(matchPolicy.require_unique)}
          />
        </div>
        <h4 className="eyebrow" style={{ marginTop: '14px' }}>{t('bankRecon.account.connected')}</h4>
        <div className="card" style={{ fontSize: '11px', lineHeight: 1.6 }}>
          <SeamLine k={t('bankRecon.fields.balance')} v={t('bankRecon.account.balanceValue')} />
          <SeamLine k={t('bankRecon.account.policy')} v={t('bankRecon.account.policyValue')} />
          <SeamLine
            k={t('bankRecon.account.workflowPolicy')}
            v={reconciliationWorkflowPolicyReady ? t('bankRecon.account.enabled') : t('bankRecon.account.disabled')}
          />
          <SeamLine k={t('bankRecon.account.matching')} v={t('bankRecon.account.matchingValue')} />
          <SeamLine k={t('bankRecon.account.settlement')} v={t('bankRecon.account.settlementValue')} />
          <SeamLine k={t('bankRecon.account.variance')} v={t('bankRecon.account.varianceValue')} />
        </div>
        {reconciliationWorkflowBlockReason ? (
          <div style={{ marginTop: '12px' }}>
            <p className="state__hint" style={{ color: 'var(--danger)' }}>
              {reconciliationWorkflowBlockReason}
            </p>
            <a
              className="chip chip--xs mono"
              data-testid="bank-recon-policy-config-link"
              href={bankReconciliationPolicyHref}
              style={{ display: 'inline-flex', marginTop: '8px', textDecoration: 'none' }}
            >
              {t('bankRecon.actions.openPolicy')}
            </a>
          </div>
        ) : null}
      </div>
    );
  }

  function accountDrawerOptions(account: BankAccountRow): OpenDrawerOptions {
    return {
      title: `${account.key} · ${account.name}`,
      size: 'md',
      onClose: () => setActiveDrawer(null),
      body: <AccountDrawerBody account={account} />,
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%', flexWrap: 'wrap' }}>
          <Button
            label={t('bankRecon.actions.runRecon')}
            iconName="refresh"
            kind="ghost"
            capability={CAP.FINANCE_WRITE}
            disabled={Boolean(bankAccountTenantActionDisabledReason(account) ?? reconciliationWorkflowBlockReason)}
            title={bankAccountTenantActionDisabledReason(account) ?? reconciliationWorkflowBlockReason ?? undefined}
            onClick={() => openReconciliationWorkflowStart(account)}
          />
          <Button
            label={t('bankRecon.actions.manageMatches')}
            iconName="link"
            kind="ghost"
            capability={CAP.FINANCE_WRITE}
            onClick={() => {
              openUnmatchPicker(account);
            }}
          />
          <div style={{ flex: 1 }} />
          <Button
            label={t('bankRecon.actions.openItems')}
            iconName="list"
            kind="primary"
            onClick={() => {
              openOpenItemsDrawer(account);
            }}
          />
        </div>
      ),
    };
  }

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={activeTenantId ?? ''} />,
    <span key="seam" className="chip chip--xs">{t('bankRecon.seamChip')}</span>,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="bankRecon"
        pills={pills}
        actions={[
          <Button
            key="new-bank-account"
            label={t('bankRecon.actions.newAccount')}
            iconName="plus"
            kind="ghost"
            capability={CAP.FINANCE_WRITE}
            onClick={openBankAccountSetupDrawer}
          />,
          <Button
            key="ingest-statement"
            label={t('bankRecon.actions.ingestStatement')}
            iconName="upload"
            kind="primary"
            capability={CAP.FINANCE_WRITE}
            disabled={Boolean(statementIngestDisabledReason())}
            title={statementIngestDisabledReason()}
            onClick={openStatementIngestDrawer}
          />,
        ]}
      />

      {accountsLoading ? (
        <StateView kind="loading" />
      ) : (
        <div
          style={{
            padding: '16px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '12px',
          }}
        >
          {accounts.map((a) => (
            <BankAccountCard
              key={a.id}
              account={a}
              now={now}
              suspenseAgingSlaHours={suspenseAgingSlaHours}
              openItemsWarnThreshold={openItemsWarnThreshold}
              onOpen={openAccountDrawer}
            />
          ))}
          {accounts.length === 0 ? (
            <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
              <div className="state__hint">{t('bankRecon.empty.accounts')}</div>
              <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'center' }}>
                <Button
                  label={t('bankRecon.actions.newAccount')}
                  iconName="plus"
                  kind="primary"
                  capability={CAP.FINANCE_WRITE}
                  onClick={openBankAccountSetupDrawer}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}

      {drawer.node}
    </div>
  );
}

/**
 * BankAccountCard — single grid card. Owns its own `useBankAccountBalance(id)`
 * hook so each card caches/refetches independently and match/unmatch
 * mutations only refresh the affected account through the
 * `bank_account_balance` query-key invalidation in queries.ts.
 */
function BankAccountCard({
  account,
  now,
  suspenseAgingSlaHours,
  openItemsWarnThreshold,
  onOpen,
}: {
  account: BankAccountRow;
  now: Date;
  suspenseAgingSlaHours: number;
  openItemsWarnThreshold: number;
  onOpen: (a: BankAccountRow) => void;
}) {
  const { t, fmtCurrency, fmtTime } = useI18n();
  const { data: balance } = useBankAccountBalance(account.id);
  const projection = balance ?? EMPTY_BALANCE;
  const aging =
    projection.balance < 0 && projection.last_match_at
      ? agingBucket(projection.last_match_at, now, suspenseAgingSlaHours)
      : null;
  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={() => onOpen(account)}>
      <div className="eyebrow"><bdi>{account.key.toUpperCase()}</bdi></div>
      <div className="serif" style={{ fontSize: '20px', marginTop: '4px' }}><bdi>{account.name}</bdi></div>
      <div
        style={{
          marginTop: '12px',
          fontSize: '20px',
          fontWeight: 600,
          color: projection.balance < 0 ? 'var(--danger-ink)' : 'var(--ink)',
        }}
      >
        <bdi>{fmtCurrency(projection.balance)}</bdi>
      </div>
      <div
        className="mono"
        style={{ marginTop: '4px', fontSize: '10.5px', color: 'var(--ink-3)' }}
      >
        {fill(t('bankRecon.card.openItems'), { n: projection.open_items })}
        {projection.last_match_at
          ? fill(t('bankRecon.card.lastMatch'), { time: fmtTime(projection.last_match_at) })
          : null}
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
        {projection.open_items > 0 ? (
          <Chip
            label={fill(t('bankRecon.card.openChip'), { n: projection.open_items })}
            kind={projection.open_items > openItemsWarnThreshold ? 'warn' : 'info'}
            size="xs"
            title={fill(t('bankRecon.card.openThreshold'), { n: openItemsWarnThreshold })}
          />
        ) : (
          <Chip label={t('bankRecon.card.reconciled')} kind="good" size="xs" />
        )}
        {aging ? (
          <Chip
            label={fill(t('bankRecon.card.unresolved'), { age: aging.label })}
            kind={aging.tone}
            size="xs"
            title={fill(t('bankRecon.card.unresolvedTitle'), { age: aging.label, hours: suspenseAgingSlaHours })}
          />
        ) : null}
      </div>
    </div>
  );
}

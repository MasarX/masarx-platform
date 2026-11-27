// ledger.tsx — TS/React port of demo-v2/assets/js/modules/finance-ledger.js
// public.finance_events (debits/credits) DataTable.
//
// Hardening per __audit__/F:
//   - Double-entry balance assertion footer (sum debits == sum credits).
//   - `direction` column visible (`in`/`out`) — operators must distinguish at a glance.
//
// CLAIM-FINANCE-WIRING (Phase C4) verdict: READ-ONLY journal surface.
// The audit (apps/console-v2/__audit__/CROSSWALK/FINANCE.md section FB-18,
// 5.5 ledger_entries) confirms `record_finance_event_v1` is service-only
// (no public-callable wrapper in Phase B5).
//
// W58-Finance+Support REDO closure (per AGENTS.md "NO WORKAROUNDS"):
//   • The Reverse-with-reason modal previously emitted a `simulated` toast
//     advertising a `record_finance_event_v1` call without backend wiring.
//     The affordance is REMOVED to avoid silent no-ops; it will return as
//     a wired action when the canonical public-callable wrapper (or an
//     edge function intermediary) lands.
//   • The "Export ledger" bulk affordance previously emitted an `Exported N
//     ledger rows` toast without producing a download. Replaced with a real
//     client-side CSV export using `Blob` + `URL.createObjectURL` — no
//     canonical RPC required for a read-only journal export.

// Current COD closeout slice wires Reverse to the canonical API-wrapper path;
// toast-only reversal simulations stay absent.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Chip, type ChipKind } from '@/components/Chip';
import {
  useCompleteResourceList,
  useResourceList,
  useResourceRowsByIds,
  useResourceListsByFilters,
  useReverseFinanceEvent,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { useModal } from '@/hooks/useOverlay';
import { CAP } from '@/lib/capabilities';
import { fill, useI18n, type Translate } from '@/lib/i18n';
import { lookupRow } from '@/lib/api';
import { getSupabaseClient } from '@/lib/supabase';
import { ledgerBalance } from './_matcher';
import {
  type FinanceScopeLabelRow,
  financeUrlScopeLabel,
  financeEventScopeFilters,
  readFinanceUrlScope,
  settlementScopeFilters,
} from './_scope';

// Phase G1 (Wave 6) / W17-1 / W19-4 — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/FINANCE.md` §9 (FinanceEventRow):
//
//   Canonical `public.finance_events` uses `direction` ('in' | 'out') plus
//   `amount`, with `account_id` (uuid). The FE row here is strictly
//   canonical: `direction` + `amount` are mandatory, and debit/credit
//   display columns are computed via `debitOf` / `creditOf` helpers below.
//   The `batch_id` lookup is derived via
//   `settlement_batch_finance_events` join (no batch_id column on
//   finance_events itself); seed nests it under `metadata.batch_id` and
//   FE resolves via `batchIdOf(row)`.
//
// W17-1 close-out: dropped FE-flattened `debit`/`credit` numeric fields
// and top-level `batch_id` from the row interface. Reads now flow through
// canonical `direction`+`amount` and `metadata.batch_id`.
//
// W19-4 close-out: renamed `account` (display label) → `account_id`
// (canonical column on `public.finance_events`). The display label still
// shows the GL account chart-of-accounts key string; production resolves
// the human label via account lookup join. Seed factory `_fel(...)` now
// emits canonical `account_id`.
interface FinanceEventRow extends Record<string, unknown> {
  id: string;                    // → finance_events.id
  occurred_at: string;           // → finance_events.occurred_at
  /** SSOT: finance_events.account_id (canonical column; W19-4 rename from `account`).
   *  Display label resolves via account/chart-of-accounts lookup in production. */
  account_id: string;
  /** Canonical finance_direction enum ('in' | 'out'); debit/credit tolerated for legacy seed rows. */
  direction: 'in' | 'out' | 'debit' | 'credit';
  /** Canonical signed amount. Mandatory per finance_events.amount. */
  amount: number;
  organization_id?: string | null;
  settlement_batch_id?: string | null;
  event_type?: string;           // → finance_events.event_type
  /** Canonical metadata jsonb (resolves derived join fields like batch_id).
   *  W17-1 — top-level `batch_id` alias dropped per
   *  `__audit__/SCHEMA-DRIFT/FINANCE.md` §9. The settlement-batch link
   *  resolves via `settlement_batch_finance_events` join; FE reads through
   *  `metadata.batch_id` until a paired projection view lands. */
  metadata?: Record<string, unknown>;
}

interface SettlementScopeRow extends Record<string, unknown> {
  id: string;
  scope?: string | null;
  scope_type?: string | null;
  client_id?: string | null;
  sender_id?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  partner_id?: string | null;
  participant_id?: string | null;
  supplier_participant_profile_id?: string | null;
  metadata?: Record<string, unknown>;
}

interface ReversalReadback {
  financeEventId: string;
  reversedFinanceEventId: string;
  reason: string;
}

/** FE flatten: amount when direction='debit', 0 otherwise (W17-1).
 *  Replaces the dropped top-level `debit` field. */
function debitOf(r: FinanceEventRow): number {
  return r.direction === 'out' || r.direction === 'debit' ? Math.abs(r.amount) : 0;
}

/** FE flatten: amount when direction='credit', 0 otherwise (W17-1).
 *  Replaces the dropped top-level `credit` field. */
function creditOf(r: FinanceEventRow): number {
  return r.direction === 'in' || r.direction === 'credit' ? Math.abs(r.amount) : 0;
}

function financeDirectionKey(direction: FinanceEventRow['direction']): 'in' | 'out' {
  return direction === 'credit' || direction === 'in' ? 'in' : 'out';
}

function financeDirectionTone(direction: FinanceEventRow['direction']): ChipKind {
  const directionRow = lookupRow('finance_direction', financeDirectionKey(direction)) as
    | { tone?: ChipKind; metadata?: { tone?: ChipKind } }
    | null;
  return directionRow?.tone ?? directionRow?.metadata?.tone ?? (financeDirectionKey(direction) === 'in' ? 'good' : 'info');
}

/** Resolve batch_id via canonical metadata jsonb (W17-1).
 *  Production path: `settlement_batch_finance_events` join. */
function batchIdOf(r: FinanceEventRow): string | undefined {
  if (typeof r.settlement_batch_id === 'string' && r.settlement_batch_id) {
    return r.settlement_batch_id;
  }
  const v = r.metadata?.['batch_id'];
  return typeof v === 'string' ? v : undefined;
}

function isSettlementLinked(row: FinanceEventRow): boolean {
  return Boolean(batchIdOf(row));
}

function isReversalEvent(row: FinanceEventRow): boolean {
  return (
    String(row.event_type ?? '').toLowerCase() === 'adjustment' &&
    typeof row.metadata?.['reverses_finance_event_id'] === 'string' &&
    row.metadata['reverses_finance_event_id'].trim().length > 0
  );
}

function reverseDisabledReason(row: FinanceEventRow, t: Translate): string | undefined {
  if (isReversalEvent(row)) return t('ledger.disabled.alreadyReversal');
  if (isSettlementLinked(row)) return t('ledger.disabled.settlementLinked');
  return undefined;
}

function reversedOriginalIds(rows: FinanceEventRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const reversedId = row.metadata?.['reverses_finance_event_id'];
    if (typeof reversedId === 'string' && reversedId.trim()) {
      ids.add(reversedId.trim());
    }
  }
  return ids;
}

export function LedgerModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.FINANCE_READ);
  const { scope, currentTenantId } = useIdentity();
  const { t, fmtCurrency } = useI18n();
  const modal = useModal();
  const [recentReversal, setRecentReversal] = useState<ReversalReadback | null>(null);
  const urlScope = readFinanceUrlScope();
  const backendSafeFilters = Boolean(getSupabaseClient());
  const baseRowsQuery = useResourceList<FinanceEventRow>('finance_events_ledger', undefined, {
    enabled: !urlScope,
  });
  const reversalIndexQuery = useCompleteResourceList<FinanceEventRow>(
    'finance_events_ledger',
    { filter: { event_type: 'adjustment' } },
    { enabled: canRead },
  );
  const scopedSettlementsQuery = useResourceListsByFilters<SettlementScopeRow>(
    'settlement_batch_summary',
    urlScope ? settlementScopeFilters(urlScope, { backendSafe: backendSafeFilters }) : [],
    undefined,
    { enabled: Boolean(urlScope) },
  );
  const scopedBatchIds = useMemo(
    () => (scopedSettlementsQuery.data?.rows ?? []).map((row) => row.id),
    [scopedSettlementsQuery.data?.rows],
  );
  const scopedRowsQuery = useResourceListsByFilters<FinanceEventRow>(
    'finance_events_ledger',
    urlScope ? financeEventScopeFilters(urlScope, scopedBatchIds, { backendSafe: backendSafeFilters }) : [],
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
  const reverseMutation = useReverseFinanceEvent();
  const actionLocks = useRef<Set<string>>(new Set());
  const activeTenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const rows = useMemo(
    () => (urlScope ? scopedRowsQuery.data?.rows ?? [] : baseRowsQuery.data?.rows ?? []),
    [baseRowsQuery.data?.rows, scopedRowsQuery.data?.rows, urlScope],
  );
  const reversalIndexRows = reversalIndexQuery.data?.rows ?? [];
  const isLoading = urlScope
    ? scopedSettlementsQuery.isLoading || scopedRowsQuery.isLoading || reversalIndexQuery.isLoading
    : baseRowsQuery.isLoading || reversalIndexQuery.isLoading;
  const readError = urlScope
    ? scopedSettlementsQuery.error ?? scopedRowsQuery.error ?? reversalIndexQuery.error
    : baseRowsQuery.error ?? reversalIndexQuery.error;

  // W17-1 — derive debit/credit from canonical direction+amount for the
  // double-entry balance assertion. ledgerBalance still consumes the
  // BalanceRow shape; we project at the boundary so the FE row interface
  // can stay strictly canonical.
  const balanceRows = useMemo(
    () => rows.map((r) => ({ debit: debitOf(r), credit: creditOf(r) })),
    [rows],
  );
  const balance = useMemo(() => ledgerBalance(balanceRows), [balanceRows]);
  const reversedSourceIds = useMemo(
    () => reversedOriginalIds([...rows, ...reversalIndexRows]),
    [reversalIndexRows, rows],
  );

  function reverseDisabledReasonForRow(row: FinanceEventRow): string | undefined {
    const baseReason = reverseDisabledReason(row, t);
    if (baseReason) return baseReason;
    const rowTenantId = typeof row.organization_id === 'string' && row.organization_id.trim()
      ? row.organization_id.trim()
      : null;
    if (rowTenantId && activeTenantId && rowTenantId !== activeTenantId) {
      return t('ledger.disabled.otherTenant');
    }
    if (reversedSourceIds.has(row.id)) return t('ledger.disabled.alreadyReversed');
    return undefined;
  }

  // W58-Finance+Support REDO closure: real client-side CSV export. Replaces
  // the prior toast-only `Export ledger` simulation. The DataTable bulk
  // action passes `rs` (the selected rows). We project canonical fields
  // (id, occurred_at, account_id, direction, amount, event_type,
  // metadata.batch_id) to a CSV blob and trigger an anchor-click download.
  // The hidden anchor is rendered below; revoking the object URL on the
  // next animation frame prevents the leak.
  const downloadAnchorRef = useRef<HTMLAnchorElement | null>(null);
  function exportLedgerCsv(selected: FinanceEventRow[]) {
    if (selected.length === 0) {
      pushToast(t('ledger.toast.selectRows'), 'warn');
      return;
    }
    const header = ['id', 'occurred_at', 'account_id', 'direction', 'amount', 'event_type', 'batch_id'];
    const escape = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [
      header.join(','),
      ...selected.map((r) =>
        [
          escape(r.id),
          escape(r.occurred_at),
          escape(r.account_id),
          escape(r.direction),
          escape(r.amount),
          escape(r.event_type ?? ''),
          escape(batchIdOf(r) ?? ''),
        ].join(','),
      ),
    ];
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = downloadAnchorRef.current;
    if (anchor) {
      anchor.href = url;
      anchor.download = `finance-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      // Revoke on the next tick so the click handler completes first.
      const revoke = () => URL.revokeObjectURL(url);
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(revoke);
      } else {
        window.setTimeout(revoke, 0);
      }
    }
    pushToast(fill(t('ledger.toast.exported'), { n: selected.length }), 'good');
  }

  async function reverseEvent(row: FinanceEventRow, reason: string): Promise<boolean> {
    const lockKey = `reverse:${row.id}`;
    if (actionLocks.current.has(lockKey)) return false;
    actionLocks.current.add(lockKey);
    try {
      const trimmedReason = reason.trim();
      if (!trimmedReason) {
        pushToast(t('ledger.toast.reasonRequired'), 'warn');
        return false;
      }
      const res = await reverseMutation.mutateAsync({
        organization_id: activeTenantId,
        finance_event_id: row.id,
        finance_occurred_at: row.occurred_at,
        reason: trimmedReason,
      });
      setRecentReversal({
        financeEventId: res.finance_event_id ?? t('ledger.toast.pending'),
        reversedFinanceEventId: res.reversed_finance_event_id ?? row.id,
        reason: trimmedReason,
      });
      pushToast(fill(t('ledger.toast.recorded'), { id: res.finance_event_id ?? t('ledger.toast.pending') }), 'good');
      return true;
    } catch (err) {
      pushToast(fill(t('ledger.toast.failed'), { error: (err as Error)?.message ?? t('ledger.toast.unknownError') }), 'danger');
      return false;
    } finally {
      actionLocks.current.delete(lockKey);
    }
  }

  function openReversalModal(row: FinanceEventRow) {
    function LedgerReversalForm() {
      const [reason, setReason] = useState('');
      const trimmedReason = reason.trim();
      const submitDisabledReason = reverseMutation.isPending
        ? t('ledger.reversal.running')
        : trimmedReason
          ? undefined
          : t('ledger.reversal.reasonMissing');

      return (
        <div>
          <p className="state__hint">
            {t('ledger.reversal.intro')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '160px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="ledger-reversal-event">{t('ledger.reversal.financeEvent')}</label>
            <input id="ledger-reversal-event" className="dt-inline-input" value={row.id} readOnly />
            <label className="mono" htmlFor="ledger-reversal-account">{t('ledger.reversal.account')}</label>
            <input id="ledger-reversal-account" className="dt-inline-input" value={row.account_id} readOnly />
            <label className="mono" htmlFor="ledger-reversal-amount">{t('ledger.reversal.amount')}</label>
            <input id="ledger-reversal-amount" className="dt-inline-input" value={fmtCurrency(row.amount)} readOnly />
            <label className="mono" htmlFor="ledger-reversal-reason">{t('ledger.reversal.reason')}</label>
            <input
              id="ledger-reversal-reason"
              data-testid="ledger-reversal-reason"
              className="dt-inline-input"
              placeholder={t('ledger.reversal.reasonPlaceholder')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('ledger.reversal.submit')}
              kind="danger"
              capability={CAP.FINANCE_WRITE}
              disabled={Boolean(submitDisabledReason)}
              title={submitDisabledReason}
              onClick={async () => {
                const ok = await reverseEvent(row, trimmedReason);
                if (ok) modal.close();
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({ title: fill(t('ledger.reversal.title'), { id: row.id }), body: <LedgerReversalForm /> });
  }

  const columns: Array<DataTableColumn<FinanceEventRow>> = [
    { key: 'occurred_at', label: t('ledger.columns.when'), format: 'datetime', sortable: true },
    { key: 'event_type', label: t('ledger.columns.event'), sortable: true, filterable: true },
    { key: 'account_id', label: t('ledger.columns.account'), mono: true, sortable: true, filterable: true },
    {
      key: 'direction',
      label: t('ledger.columns.direction'),
      sortable: true,
      filterable: true,
      render: (_raw: unknown, row: FinanceEventRow): ReactNode => {
        // Render the live canonical finance_direction value; debit/credit rows
        // are normalized only for legacy seed/test compatibility.
        const directionKey = financeDirectionKey(row.direction);
        const dirRow = lookupRow('finance_direction', directionKey) as
          | { label?: string; description?: string; tone?: ChipKind; metadata?: { title?: string; tone?: ChipKind } }
          | null;
        const chipLabel = dirRow?.label ?? directionKey;
        const chipTone = financeDirectionTone(row.direction);
        const chipTitle = dirRow?.metadata?.title ?? dirRow?.description ?? directionKey;
        return (
          <Chip
            label={chipLabel}
            kind={chipTone}
            size="xs"
            title={chipTitle}
          />
        );
      },
    },
    // W17-1 — `debit`/`credit` flatten dropped from row interface; computed
    // via helpers from canonical direction+amount. Render-only columns.
    {
      key: 'debit',
      label: t('ledger.columns.debit'),
      align: 'right',
      sortable: true,
      render: (_raw, row) => fmtCurrency(debitOf(row)),
    },
    {
      key: 'credit',
      label: t('ledger.columns.credit'),
      align: 'right',
      sortable: true,
      render: (_raw, row) => fmtCurrency(creditOf(row)),
    },
    // W17-1 — `batch_id` resolves through metadata.batch_id (no top-level
    // column on canonical finance_events). Production path:
    // `settlement_batch_finance_events` join.
    {
      key: 'metadata.batch_id',
      label: t('ledger.columns.batch'),
      mono: true,
      sortable: false,
      filterable: false,
      render: (_raw, row) => {
        const bid = batchIdOf(row);
        return bid ? <span className="mono">{bid}</span> : <span>—</span>;
      },
    },
  ];

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={activeTenantId ?? ''} />,
    ...(urlScope
      ? [
          <Chip
            key="url-scope"
            label={financeUrlScopeLabel(urlScope, scopeLabelRows, t)}
            kind="info"
            size="xs"
          />,
        ]
      : []),
    <span key="seam" className="chip chip--xs mono">{t('ledger.seamChip')}</span>,
    <Chip
      key="balance"
      label={
        balance.balanced
          ? fill(t('ledger.balance.balanced'), { amount: fmtCurrency(balance.total_debit) })
          : fill(t('ledger.balance.drift'), { amount: fmtCurrency(balance.drift) })
      }
      kind={balance.balanced ? 'good' : 'danger'}
      size="xs"
      title={fill(t('ledger.balance.sums'), { debit: fmtCurrency(balance.total_debit), credit: fmtCurrency(balance.total_credit) })}
    />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="ledger"
        />
        <StateView
          kind="denied"
          capability={CAP.FINANCE_READ}
          hint={t('ledger.denied')}
        />
      </div>
    );
  }
  if (readError) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="ledger"
          pills={pills}
        />
        <StateView
          kind="error"
          title={t('ledger.loadError')}
          hint={(readError as Error).message}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="ledger"
        pills={pills}
      />

      {recentReversal ? (
        <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
          <div className="section-title">{t('ledger.confirmed.title')}</div>
          <div className="state__hint">
            {t('ledger.confirmed.event')}{' '}
            <bdi className="mono">{recentReversal.financeEventId}</bdi> {t('ledger.confirmed.source')}{' '}
            <bdi className="mono">{recentReversal.reversedFinanceEventId}</bdi>.
          </div>
          <bdi className="mono" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
            {recentReversal.reason}
          </bdi>
        </div>
      ) : null}

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <>
          <DataTable<FinanceEventRow>
            columns={columns}
            rows={rows}
            viewKey="finance_events_ledger"
            entityKind="finance_event"
            rowActions={[
              {
                label: t('ledger.actions.reverse'),
                icon: 'rotate',
                kind: 'danger',
                capability: CAP.FINANCE_WRITE,
                disabled: (row) => Boolean(reverseDisabledReasonForRow(row)),
                disabledReason: reverseDisabledReasonForRow,
                onClick: (row) => openReversalModal(row),
              },
            ]}
            bulkActions={[
              {
                label: t('ledger.actions.exportLedger'),
                icon: 'download',
                kind: 'ghost',
                onClick: exportLedgerCsv,
              },
            ]}
          />
          {modal.node}
          {/* Hidden anchor used by the CSV export bulk action. Refs through
              `downloadAnchorRef` so the click handler can mutate `href` +
              `download` at export time and trigger a real browser download
              (no canonical RPC required for read-only journal export). */}
          <a ref={downloadAnchorRef} style={{ display: 'none' }} aria-hidden="true" />
          <div
            className="card mono"
            style={{
              marginTop: '12px',
              padding: '10px 14px',
              display: 'flex',
              gap: '16px',
              fontSize: '11.5px',
              alignItems: 'center',
            }}
          >
            <span style={{ color: 'var(--ink-3)' }}>{t('ledger.balance.sumDebit')}</span>
            <span style={{ fontWeight: 600 }}>{fmtCurrency(balance.total_debit)}</span>
            <span style={{ color: 'var(--ink-3)' }}>{t('ledger.balance.sumCredit')}</span>
            <span style={{ fontWeight: 600 }}>{fmtCurrency(balance.total_credit)}</span>
            <span style={{ flex: 1 }} />
            <Chip
              label={balance.balanced ? t('ledger.balance.balancedMark') : fill(t('ledger.balance.drift'), { amount: fmtCurrency(balance.drift) })}
              kind={balance.balanced ? 'good' : 'danger'}
              size="xs"
            />
          </div>
        </>
      )}
    </div>
  );
}

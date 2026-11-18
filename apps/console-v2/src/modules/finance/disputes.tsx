// disputes.tsx — TS/React port of demo-v2/assets/js/modules/finance-disputes.js
// public.marketplace_disputes — DataTable with row + bulk actions.
//
// Hardening per __audit__/F:
//   - Drawer footer `Mark resolved` button with explicit resolution-kind picker
//     (credit / reject / partial · amount · notes), required by
//     marketplace.resolve_dispute_v1.
//   - Bulk `Mark resolved` opens a small modal collecting the same fields —
//     never silently submit.
//   - Aging chip on `submitted` and `under_review` rows derived from a tenant SLA.
//   - Status chip tone derived from lookup `dispute_status` (added to lookups.js).
//   - Row "Open shipment" deeplink to the related operate/shipments view.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import {
  useResourceList,
  useResourceRowsByIds,
  useResourceListsByFilters,
  useResolveSettings,
  useResolveDispute,
  useRejectDispute,
  useBulkDisputeAction,
  useEscalateDispute,
  useAcknowledgeDispute,
} from '@/lib/queries';
import { useDrawer, useModal, type OpenDrawerOptions } from '@/hooks/useOverlay';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useI18n } from '@/lib/i18n';
import * as api from '@/lib/api';
import { getSupabaseClient } from '@/lib/supabase';
import { DetailRow, SeamLine } from './_shared';
import { agingBucket } from './_matcher';
import {
  disputeDirectoryScopeFilters,
  type FinanceScopeLabelRow,
  financeUrlScopeLabel,
  readFinanceUrlScope,
} from './_scope';

// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/FINANCE.md` §12 / `NETWORK.md` §20 (DisputeRow):
//
//   Canonical `public.marketplace_disputes` (id, created_at, updated_at,
//   request_id, contract_id, work_package_id, opened_by_organization_id,
//   counterparty_organization_id, opened_by_user_id, resolved_by_user_id,
//   status, category, title, description, resolution, resolved_at, metadata)
//   per supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:816-835.
//
// W13-1 close-out: dropped FE-fictional `shipment_ref` and `amount_sar`
// top-level keys per __audit__/SCHEMA-DRIFT/NETWORK.md §20 — both live
// in `metadata` jsonb on the canonical table. Reads now flow through
// `shipmentRefOf(d)` / `amountSarOf(d)` helpers; seed mirrors the
// canonical metadata-only shape.
//
// W19-4 close-out: applied the deferred RENAMEs `kind` → `category` and
// `filed_at` → `created_at` per __audit__/SCHEMA-DRIFT/FINANCE.md §12.
// Seed (marketplace.js) emits canonical column names directly; the FE
// `dispute_kind` lookup is reused as-is since the canonical `category`
// column carries the same enum values (commercial / execution / other).
interface DisputeRow extends Record<string, unknown> {
  id: string;                    // → marketplace_disputes.id
  contract_id: string;           // → marketplace_disputes.contract_id
  opened_by_organization_id?: string | null;
  counterparty_organization_id?: string | null;
  /** SSOT: marketplace_disputes.category (canonical column; W19-4 rename from `kind`). */
  category: string;
  status: string;                // → marketplace_disputes.status
  /** SSOT: marketplace_disputes.created_at (canonical column; W19-4 rename from `filed_at`). */
  created_at: string;
  resolution?: string;           // → marketplace_disputes.resolution
  /** Canonical metadata jsonb (resolves shipment_ref + amount_sar). */
  metadata?: Record<string, unknown>;
}

/**
 * W25 — Canonical projection from `public.v_dispute_directory`
 * (supabase/migrations/202604302310_v_dispute_directory.sql). Joined to
 * `DisputeRow` by id to surface derived joins (opened_by_label,
 * counterparty_label, opened_by_user_label, resolved_by_user_label) and
 * derived state (escalation_count, is_escalated, is_terminal, age_seconds,
 * age_hours) without duplicating them onto the canonical row interface.
 */
interface DisputeDirectoryRow extends Record<string, unknown> {
  dispute_id: string;
  opened_by_organization_id?: string | null;
  counterparty_organization_id?: string | null;
  opened_by_label?: string | null;
  counterparty_label?: string | null;
  opened_by_user_label?: string | null;
  resolved_by_user_label?: string | null;
  shipment_ref?: string | null;
  amount_sar: number;
  escalation_count: number;
  escalation_at?: string | null;
  is_escalated: boolean;
  is_terminal: boolean;
  age_seconds: number;
  age_hours: number;
}

/** Resolve `shipment_ref` from canonical metadata jsonb (W13-1). */
function shipmentRefOf(d: DisputeRow): string | undefined {
  const v = d.metadata?.['shipment_ref'];
  return typeof v === 'string' ? v : undefined;
}

/** Resolve `amount_sar` from canonical metadata jsonb (W13-1). */
function amountSarOf(d: DisputeRow): number {
  const v = d.metadata?.['amount_sar'];
  return typeof v === 'number' ? v : Number(v) || 0;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface LookupRow {
  value: string;
  label: string;
  tone?: ChipKind;
  metadata?: Record<string, unknown>;
}

// W52 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): tone for
// dispute kind/status chips comes strictly from the canonical lookup
// (`zone_color_token`-style row carrying tone). Returning `null` instead
// of a silent fallback ChipKind makes a missing lookup row visible —
// callers paint a `danger` chip so the gap surfaces in the UI.
function lookupTone(category: string, value: unknown): ChipKind | null {
  const list = (api.getLookups(category) as LookupRow[] | undefined) ?? [];
  const row = list.find((r) => r.value === value);
  return row?.tone ?? null;
}

function lookupRow(category: string, value: unknown): LookupRow | null {
  if (value == null) return null;
  const list = (api.getLookups(category) as LookupRow[] | undefined) ?? [];
  return list.find((r) => r.value === String(value)) ?? null;
}

// W58-Finance+Support REDO closure: dispute_status lifecycle helper.
// AGENTS.md §2 + §4: every "is the dispute in state X" branch resolves
// through canonical `dispute_status` lookup rows. The `metadata.lifecycle`
// + `metadata.allows_*` flags drive button `disabled` semantics.
// 'resolved' and 'rejected' are terminal — a missing/malformed row leaves
// `null` so the canonical RPC remains the final gate (UI never silently
// disables the button on phantom data).
type DisputeLifecycle = 'working' | 'terminal';
type DisputeLifecycleMetadata = {
  lifecycle?: DisputeLifecycle;
  is_terminal?: boolean;
  allows_acknowledge?: boolean;
  allows_escalate?: boolean;
  allows_reject?: boolean;
  allows_resolve?: boolean;
};
function disputeLifecycle(status: unknown): DisputeLifecycleMetadata | null {
  const row = lookupRow('dispute_status', status);
  if (!row) return null;
  const m = row.metadata as DisputeLifecycleMetadata | undefined;
  return m ?? null;
}
function disputeIsTerminal(status: unknown): boolean {
  return disputeLifecycle(status)?.is_terminal === true;
}

function canAcknowledgeDispute(d: DisputeRow): boolean {
  return disputeLifecycle(d.status)?.allows_acknowledge === true;
}

function canEscalateDispute(d: DisputeRow): boolean {
  return disputeLifecycle(d.status)?.allows_escalate === true;
}

function canRejectDispute(d: DisputeRow): boolean {
  return disputeLifecycle(d.status)?.allows_reject === true;
}

function canResolveDispute(d: DisputeRow): boolean {
  return disputeLifecycle(d.status)?.allows_resolve === true;
}

function disputeActionDisabledReason(d: DisputeRow, action: string): string | undefined {
  if (disputeLifecycle(d.status) == null) return 'Dispute status is not configured for this action.';
  if (disputeIsTerminal(d.status)) return `Dispute is ${String(d.status)}; ${action} is not allowed.`;
  return `Dispute status ${String(d.status)} does not allow ${action}.`;
}

function actionableDisputesFor(
  rows: DisputeRow[],
  predicate: (row: DisputeRow) => boolean,
): DisputeRow[] {
  return rows.filter(predicate);
}

// W58-Finance+Support REDO closure: dispute_resolution metadata helpers.
// `metadata.target_rpc` resolves which canonical RPC the FE should fan out
// to (replaces the inline `draft.resolution === 'reject'` branch). The
// `metadata.requires_amount` flag drives the modal's "Amount required"
// indicator (replaces the inline `draft.resolution === 'partial'` branch).
type DisputeResolutionMetadata = {
  target_rpc?: 'marketplace_dispute_resolution_v1' | 'dispute_reject_v1';
  requires_amount?: boolean;
  requires_notes?: boolean;
};
function disputeResolutionMeta(value: unknown): DisputeResolutionMetadata | null {
  const row = lookupRow('dispute_resolution', value);
  if (!row) return null;
  const m = row.metadata as DisputeResolutionMetadata | undefined;
  return m ?? null;
}

// W52 strict closure (AGENTS.md §2 ZERO HARDCODING + §3 ROW-DRIVEN):
// dispute resolution options come strictly from canonical
// `dispute_resolution` lookup rows (apps/console-v2/src/lib/seed-raw/
// lookups.js, seeded by W24b). NO inline fallback array — downstream
// consumers (ResolveForm) render an error StateView when the lookup is
// not seeded so the gap surfaces in the UI.
function resolutionLookups(): LookupRow[] {
  return (api.getLookups('dispute_resolution') as LookupRow[] | undefined) ?? [];
}

interface ResolveDraft {
  resolution: string;
  amount: string;
  notes: string;
}

export function DisputesModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.DISPUTES_READ);
  const { scope, currentTenantId } = useIdentity();
  const { fmtCurrency, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const navigate = useNavigate();
  const [openDisputeId, setOpenDisputeId] = useState<string | null>(null);
  const [disputeReadbacks, setDisputeReadbacks] = useState<Record<string, DisputeRow>>({});
  const [directoryReadbacks, setDirectoryReadbacks] = useState<Record<string, DisputeDirectoryRow>>({});
  const now = useMemo(() => new Date(), []);
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

  // AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): dispute SLA resolves
  // STRICTLY from canonical `dispute_resolution_policy` via the settings
  // ladder. NO fallback constant — a missing canonical row means the seed
  // is broken, not that the FE should pick a default. Render a loud error
  // state (below) so the operator sees the gap instead of silently using
  // stale data.
  const disputePolicy = useResolveSettings('dispute_resolution_policy', settingsScope);
  const disputePolicyValue = disputePolicy.data?.value as
    | { sla_hours?: number }
    | undefined;
  const disputeSlaHours = disputePolicyValue?.sla_hours;

  const urlScope = readFinanceUrlScope();
  const backendSafeFilters = Boolean(getSupabaseClient());
  const baseRowsQuery = useResourceList<DisputeRow>('marketplace_disputes', undefined, {
    enabled: !urlScope,
  });

  // W25 — paired projection view `public.v_dispute_directory`
  // (supabase/migrations/202604302310_v_dispute_directory.sql). Surfaces
  // derived joins (opened_by_label / counterparty_label / opened_by_user_label
  // / resolved_by_user_label) and derived state (escalation_count /
  // is_escalated / is_terminal / age_*) without duplicating them onto the
  // canonical row interface.
  const baseDirectoryQuery = useResourceList<DisputeDirectoryRow>('dispute_directory', undefined, {
    enabled: !urlScope,
  });
  const scopedDirectoryQuery = useResourceListsByFilters<DisputeDirectoryRow>(
    'dispute_directory',
    urlScope ? disputeDirectoryScopeFilters(urlScope, { backendSafe: backendSafeFilters }) : [],
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
  const rawDirectoryRows = (urlScope ? scopedDirectoryQuery.data?.rows : baseDirectoryQuery.data?.rows) ?? [];
  const directoryRows = useMemo(
    () =>
      rawDirectoryRows.map((row) => {
        const readback = directoryReadbacks[row.dispute_id];
        return readback ? { ...row, ...readback } : row;
      }),
    [directoryReadbacks, rawDirectoryRows],
  );
  const directoryById = useMemo(() => {
    const map = new Map<string, DisputeDirectoryRow>();
    for (const d of directoryRows) map.set(d.dispute_id, d);
    return map;
  }, [directoryRows]);
  const rows = useMemo(
    () => {
      const baseRows = urlScope
        ? (directoryRows as unknown as DisputeRow[])
        : baseRowsQuery.data?.rows ?? [];
      return baseRows.map((row) => {
        const readback = disputeReadbacks[row.id];
        return readback ? { ...row, ...readback } : row;
      });
    },
    [baseRowsQuery.data?.rows, directoryRows, disputeReadbacks, urlScope],
  );
  const isLoading = urlScope
    ? scopedDirectoryQuery.isLoading
    : baseRowsQuery.isLoading || baseDirectoryQuery.isLoading;
  const readError = urlScope
    ? scopedDirectoryQuery.error
    : baseRowsQuery.error ?? baseDirectoryQuery.error;

  // Phase B5/C4 mutation hooks — dispute_resolve_v1 / dispute_reject_v1.
  // Both invalidate `marketplace_disputes` on success so the table re-reads
  // with the new status. Caller drives toast UX.
  const resolveMutation = useResolveDispute();
  const rejectMutation = useRejectDispute();
  const bulkDisputeActionMutation = useBulkDisputeAction();
  // W9-3 — non-terminal Escalate path (capability: disputes.write). Records
  // the escalation marker on the dispute row + emits decision/domain events;
  // open → under_review (otherwise idempotent, increments escalation_count).
  // Replaces the toast-only seam at drawer + row + bulk action sites.
  const escalateMutation = useEscalateDispute();
  function escalateDispute(d: DisputeRow, source: 'drawer' | 'row') {
    const disabledReason = escalateDisabledReason(d);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    openEscalateModal([d], { keepDrawerOpen: source === 'drawer' });
  }

  // W31 / FB-07 — non-terminal Acknowledge path (capability: disputes.write).
  // Transitions open → under_review and stamps `metadata.acknowledged_at` +
  // `metadata.acknowledged_by_user_id`. Idempotent: under_review/resolved/
  // rejected return success without state change. Replaces the prior
  // toast-only seam at the drawer + row action sites and routes through
  // the canonical RPC `dispute_acknowledge_v1`
  // (supabase/migrations/202604301140_dispute_acknowledge_v1.sql).
  const acknowledgeMutation = useAcknowledgeDispute();
  function disputeTenantActionDisabledReason(d: DisputeRow): string | undefined {
    const proj = directoryById.get(d.id);
    const openedById =
      textOf(d.opened_by_organization_id) || textOf(proj?.opened_by_organization_id);
    const counterpartyId =
      textOf(d.counterparty_organization_id) || textOf(proj?.counterparty_organization_id);
    const activeId = textOf(activeTenantId);
    if ((openedById || counterpartyId) && (!activeId || (openedById !== activeId && counterpartyId !== activeId))) {
      return "Switch to this dispute's tenant before changing dispute lifecycle.";
    }
    return undefined;
  }

  function acknowledgeDisabledReason(d: DisputeRow): string | undefined {
    const tenantReason = disputeTenantActionDisabledReason(d);
    if (tenantReason) return tenantReason;
    if (acknowledgeMutation.isPending) return 'Dispute acknowledgement is already running.';
    return canAcknowledgeDispute(d)
      ? undefined
      : disputeActionDisabledReason(d, 'acknowledgement');
  }

  function escalateDisabledReason(d: DisputeRow): string | undefined {
    const tenantReason = disputeTenantActionDisabledReason(d);
    if (tenantReason) return tenantReason;
    if (escalateMutation.isPending) return 'Dispute escalation is already running.';
    return canEscalateDispute(d)
      ? undefined
      : disputeActionDisabledReason(d, 'escalation');
  }

  function rejectDisabledReason(d: DisputeRow): string | undefined {
    const tenantReason = disputeTenantActionDisabledReason(d);
    if (tenantReason) return tenantReason;
    if (rejectMutation.isPending) return 'Dispute rejection is already running.';
    return canRejectDispute(d)
      ? undefined
      : disputeActionDisabledReason(d, 'rejection');
  }

  function resolveDisabledReason(d: DisputeRow): string | undefined {
    const tenantReason = disputeTenantActionDisabledReason(d);
    if (tenantReason) return tenantReason;
    if (resolveMutation.isPending) return 'Dispute resolution is already running.';
    return canResolveDispute(d)
      ? undefined
      : disputeActionDisabledReason(d, 'resolution');
  }

  async function reconcileDisputeFromBackend(disputeId: string) {
    const [disputeList, directoryList] = await Promise.all([
      api.ui_list_resource_v1<DisputeRow>('marketplace_disputes', {
        filter: { id: disputeId },
        page_size: 1,
      }),
      api.ui_list_resource_v1<DisputeDirectoryRow>('dispute_directory', {
        filter: { dispute_id: disputeId },
        page_size: 1,
      }),
    ]);
    const dispute = disputeList.rows[0];
    const directory = directoryList.rows[0];
    if (dispute) {
      setDisputeReadbacks((current) => ({ ...current, [dispute.id]: dispute }));
    }
    if (directory) {
      setDirectoryReadbacks((current) => ({ ...current, [directory.dispute_id]: directory }));
    }
  }

  function scheduleDisputeBackendReconciliation(disputeId: string) {
    [750, 2000, 5000, 8000].forEach((delay) => {
      window.setTimeout(() => {
        void reconcileDisputeFromBackend(disputeId).catch(() => undefined);
      }, delay);
    });
  }

  function acknowledgeDispute(d: DisputeRow, source: 'drawer' | 'row') {
    const disabledReason = acknowledgeDisabledReason(d);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    acknowledgeMutation.mutate(
      { dispute_id: d.id },
      {
        onSuccess: (res) => {
          void reconcileDisputeFromBackend(res.dispute_id);
          if (source === 'drawer') setOpenDisputeId(d.id);
          if (res.already_processed) {
            pushToast(`Dispute already acknowledged · ${res.dispute_id}`, 'info');
          } else {
            pushToast(`Dispute acknowledged · ${res.dispute_id}`, 'good');
          }
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }

  // ─── Strict guards BEFORE any policy-dependent computation ─────────────
  // (All hooks above; non-hook logic + JSX below are now safe to assume
  // non-null policy values.)
  useEffect(() => {
    if (!drawer.isOpen || !openDisputeId) return;
    const freshDispute = rows.find((row) => row.id === openDisputeId);
    if (!freshDispute) return;
    drawer.open(disputeDrawerOptions(freshDispute));
  }, [drawer.isOpen, openDisputeId, rows, directoryById, disputeSlaHours]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="disputes"
          eyebrow="Finance"
          titleAccent="Disputes"
          titlePlain=""
        />
        <StateView
          kind="denied"
          capability={CAP.DISPUTES_READ}
          hint="You do not have permission to view disputes (disputes.read)."
        />
      </div>
    );
  }
  if (disputePolicy.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="disputes"
          eyebrow="Finance"
          titleAccent="Disputes"
          titlePlain=""
        />
        <StateView kind="loading" />
      </div>
    );
  }
  if (readError) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="disputes"
          eyebrow="Finance"
          titleAccent="Disputes"
          titlePlain=""
        />
        <StateView
          kind="error"
          title="Unable to load disputes"
          hint={(readError as Error).message}
        />
      </div>
    );
  }
  if (disputeSlaHours == null) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="disputes"
          eyebrow="Finance"
          titleAccent="Disputes"
          titlePlain=""
        />
        <StateView
          kind="error"
          title="Dispute resolution policy missing"
          hint="Configure dispute resolution SLA before using this surface."
        />
      </div>
    );
  }

  function openShipment(ref: string) {
    void navigate({ to: '/operate/shipments', search: { focus: ref } as never });
  }

  function ResolveForm({
    rs,
    onSubmit,
  }: {
    rs: DisputeRow[];
    onSubmit: (draft: ResolveDraft, rs: DisputeRow[]) => void;
  }) {
    const options = resolutionLookups();
    const [draft, setDraft] = useState<ResolveDraft>({
      resolution: options[0]?.value ?? '',
      amount: '',
      notes: '',
    });
    if (options.length === 0) {
      // W52 strict closure: missing canonical `dispute_resolution` lookup
      // surfaces as a danger StateView so the gap is visible — no inline
      // ['credit','reject','partial'] fallback array.
      return (
        <StateView
          kind="error"
          title="Dispute resolution options missing"
          hint="Configure dispute resolution options before resolving disputes."
        />
      );
    }
    // W58-Finance+Support REDO closure: validation resolves through
    // canonical `dispute_resolution.metadata` instead of resolution literals.
    const resolutionMeta = disputeResolutionMeta(draft.resolution);
    const isDispatchConfigured = Boolean(resolutionMeta?.target_rpc);
    const isAmountRequired = resolutionMeta?.requires_amount === true;
    const isNotesRequired = resolutionMeta?.requires_notes === true;
    const amountOk = !isAmountRequired || parseFloat(draft.amount) > 0;
    const notesOk = !isNotesRequired || draft.notes.trim().length > 0;
    const valid = !!draft.resolution && isDispatchConfigured && amountOk && notesOk;
    return (
      <div>
        <p className="state__hint">
          Resolves <strong>{rs.length}</strong> dispute{rs.length === 1 ? '' : 's'}.
          Choose a resolution kind; required fields are loaded from dispute resolution settings.
        </p>
        {!isDispatchConfigured ? (
          <p className="state__hint" style={{ color: 'var(--danger)', marginTop: '8px' }}>
            Selected resolution is missing its action settings.
          </p>
        ) : null}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '120px 1fr',
            gap: '8px',
            alignItems: 'center',
            padding: '0 4px',
            marginTop: '12px',
          }}
        >
          <label className="mono" htmlFor="dispute-resolution-kind">Resolution</label>
          <select
            id="dispute-resolution-kind"
            className="dt-inline-input"
            value={draft.resolution}
            onChange={(e) => setDraft((d) => ({ ...d, resolution: e.target.value }))}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <label className="mono" htmlFor="dispute-resolution-amount">
            Amount {isAmountRequired ? '*' : ''}
          </label>
          <input
            id="dispute-resolution-amount"
            className="dt-inline-input"
            type="number"
            step="0.01"
            min="0"
            value={draft.amount}
            onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
            placeholder={isAmountRequired ? 'Required for partial' : 'Optional'}
          />
          <label className="mono" htmlFor="dispute-resolution-notes">
            Notes {isNotesRequired ? '*' : ''}
          </label>
          <textarea
            id="dispute-resolution-notes"
            className="dt-inline-input"
            rows={2}
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder={isNotesRequired ? 'Required for this resolution' : 'Optional context for audit log'}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Mark resolved"
            kind="primary"
            capability={CAP.DISPUTES_WRITE}
            disabled={!valid || resolveMutation.isPending || bulkDisputeActionMutation.isPending}
            onClick={() => {
              onSubmit(draft, rs);
            }}
          />
        </div>
      </div>
    );
  }

  function openResolveModal(rs: DisputeRow[], opts?: { keepDrawerOpen?: boolean }) {
    const blockedReason = rs.map((row) => resolveDisabledReason(row)).find(Boolean);
    if (blockedReason) {
      pushToast(blockedReason, 'warn');
      return;
    }
    const actionableRows = actionableDisputesFor(rs, canResolveDispute);
    if (actionableRows.length !== rs.length) {
      pushToast('Selected disputes include a status that cannot be resolved.', 'warn');
      return;
    }
    modal.open({
      title: rs.length === 1 ? `Resolve · ${rs[0]!.id}` : `Resolve ${rs.length} disputes`,
      body: (
        <ResolveForm
          rs={actionableRows}
          onSubmit={(draft, list) => {
            modal.close();
            const amount = draft.amount ? parseFloat(draft.amount) : null;
            const metadata: Record<string, unknown> = {};
            if (amount && Number.isFinite(amount)) metadata.amount = amount;
            if (draft.notes && draft.notes.trim()) metadata.notes = draft.notes.trim();

            const targetRpc = disputeResolutionMeta(draft.resolution)?.target_rpc;
            if (!targetRpc) {
              pushToast('Selected dispute resolution is not configured yet.', 'danger');
              return;
            }
            const operation = targetRpc === 'dispute_reject_v1' ? 'reject' : 'resolve';
            bulkDisputeActionMutation.mutate(
              {
                dispute_ids: list.map((d) => d.id),
                operation,
                ...(operation === 'reject'
                  ? { rejection_reason: draft.notes?.trim() || 'reject' }
                  : { resolution: draft.resolution }),
                ...(Object.keys(metadata).length ? { metadata } : {}),
              },
              {
                onSuccess: (res) => {
                  const successfulIds = res.results
                    .filter((row) => row.ok)
                    .map((row) => {
                      const result = row.result as Record<string, unknown> | undefined;
                      return typeof row.dispute_id === 'string'
                        ? row.dispute_id
                        : typeof result?.dispute_id === 'string'
                          ? result.dispute_id
                          : null;
                    })
                    .filter((id): id is string => Boolean(id));
                  const idsToReconcile = successfulIds.length ? successfulIds : list.map((d) => d.id);
                  idsToReconcile.forEach((id) => {
                    void reconcileDisputeFromBackend(id);
                  });
                  if (opts?.keepDrawerOpen && list.length === 1) setOpenDisputeId(list[0]!.id);
                  pushToast(
                    `Disputes ${operation === 'reject' ? 'rejected' : 'resolved'} · ${res.succeeded_count} succeeded${res.failed_count ? ` · ${res.failed_count} failed` : ''}`,
                    res.failed_count ? 'warn' : operation === 'reject' ? 'warn' : 'good',
                  );
                },
                onError: (err: Error) => pushToast(err.message, 'danger'),
              },
            );
          }}
        />
      ),
    });
  }

  function ReasonActionForm({
    inputId,
    label,
    summary,
    submitLabel,
    submitKind = 'primary',
    isPending,
    onSubmit,
  }: {
    inputId: string;
    label: string;
    summary: string;
    submitLabel: string;
    submitKind?: 'primary' | 'danger';
    isPending: boolean;
    onSubmit: (reason: string) => void;
  }) {
    const [reason, setReason] = useState('');
    const trimmedReason = reason.trim();
    return (
      <div>
        <p className="state__hint">{summary}</p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '140px 1fr',
            gap: '8px',
            alignItems: 'start',
            padding: '0 4px',
            marginTop: '12px',
          }}
        >
          <label className="mono" htmlFor={inputId}>{label}</label>
          <textarea
            id={inputId}
            className="dt-inline-input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required context for audit log"
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
          <Button
            label={submitLabel}
            kind={submitKind}
            capability={CAP.DISPUTES_WRITE}
            disabled={!trimmedReason || isPending}
            onClick={() => onSubmit(trimmedReason)}
          />
        </div>
      </div>
    );
  }

  function openEscalateModal(
    rs: DisputeRow[],
    opts?: { keepDrawerOpen?: boolean; forceBulk?: boolean },
  ) {
    const blockedReason = rs.map((row) => escalateDisabledReason(row)).find(Boolean);
    if (blockedReason) {
      pushToast(blockedReason, 'warn');
      return;
    }
    const actionableRows = actionableDisputesFor(rs, canEscalateDispute);
    if (actionableRows.length !== rs.length) {
      pushToast('Selected disputes include a status that cannot be escalated.', 'warn');
      return;
    }
    const useBulk = opts?.forceBulk === true || actionableRows.length > 1;
    const title = useBulk
      ? `Escalate ${actionableRows.length} dispute${actionableRows.length === 1 ? '' : 's'}`
      : `Escalate - ${actionableRows[0]!.id}`;
    modal.open({
      title,
      body: (
        <ReasonActionForm
          inputId={useBulk ? 'bulk-dispute-escalation-reason' : 'dispute-escalation-reason'}
          label="Escalation reason"
          summary={
            useBulk
              ? `Escalates ${actionableRows.length} dispute${actionableRows.length === 1 ? '' : 's'} for manager review.`
              : `Escalates dispute ${actionableRows[0]!.id} for manager review.`
          }
          submitLabel={useBulk ? 'Escalate disputes' : 'Escalate dispute'}
          isPending={escalateMutation.isPending || bulkDisputeActionMutation.isPending}
          onSubmit={(reason) => {
            modal.close();
            if (useBulk) {
              bulkDisputeActionMutation.mutate(
                {
                  dispute_ids: actionableRows.map((d) => d.id),
                  operation: 'escalate',
                  escalation_reason: reason,
                },
                {
                  onSuccess: (res) => {
                    const successfulIds = res.results
                      .filter((row) => row.ok)
                      .map((row) => {
                        const result = row.result as Record<string, unknown> | undefined;
                        return typeof row.dispute_id === 'string'
                          ? row.dispute_id
                          : typeof result?.dispute_id === 'string'
                            ? result.dispute_id
                            : null;
                      })
                      .filter((id): id is string => Boolean(id));
                    const idsToReconcile = successfulIds.length
                      ? successfulIds
                      : actionableRows.map((d) => d.id);
                    idsToReconcile.forEach((id) => {
                      void reconcileDisputeFromBackend(id);
                    });
                    if (opts?.keepDrawerOpen && actionableRows.length === 1) {
                      setOpenDisputeId(actionableRows[0]!.id);
                    }
                    pushToast(
                      `Disputes escalated · ${res.succeeded_count} succeeded${res.failed_count ? ` · ${res.failed_count} failed` : ''}`,
                      res.failed_count ? 'warn' : 'good',
                    );
                  },
                  onError: (err: Error) => pushToast(err.message, 'danger'),
                },
              );
              return;
            }
            const dispute = actionableRows[0]!;
            escalateMutation.mutate(
              { dispute_id: dispute.id, escalation_reason: reason },
              {
                onSuccess: (res) => {
                  void reconcileDisputeFromBackend(res.dispute_id);
                  if (opts?.keepDrawerOpen) setOpenDisputeId(dispute.id);
                  pushToast(`Dispute escalated · ${res.dispute_id}`, 'warn');
                },
                onError: (err: Error) => pushToast(err.message, 'danger'),
              },
            );
          }}
        />
      ),
    });
  }

  function openRejectModal(d: DisputeRow) {
    const disabledReason = rejectDisabledReason(d);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    modal.open({
      title: `Reject - ${d.id}`,
      body: (
        <ReasonActionForm
          inputId="dispute-rejection-reason"
          label="Rejection reason"
          summary={`Rejects dispute ${d.id} and records the reason in the decision trail.`}
          submitLabel="Reject dispute"
          submitKind="danger"
          isPending={rejectMutation.isPending}
          onSubmit={(reason) => {
            modal.close();
            scheduleDisputeBackendReconciliation(d.id);
            rejectMutation.mutate(
              { dispute_id: d.id, rejection_reason: reason },
              {
                onSuccess: (res) => {
                  const confirmedStatus = res.status || 'rejected';
                  const resolvedAt = new Date().toISOString();
                  const currentDirectory = directoryById.get(d.id);
                  setDisputeReadbacks((current) => ({
                    ...current,
                    [res.dispute_id]: {
                      ...d,
                      status: confirmedStatus,
                      resolution: reason,
                      resolved_at: resolvedAt,
                    },
                  }));
                  if (currentDirectory) {
                    setDirectoryReadbacks((current) => ({
                      ...current,
                      [res.dispute_id]: {
                        ...currentDirectory,
                        status: confirmedStatus,
                        resolution: reason,
                        resolved_at: resolvedAt,
                        is_terminal: disputeIsTerminal(confirmedStatus),
                      },
                    }));
                  }
                  void reconcileDisputeFromBackend(res.dispute_id);
                  setOpenDisputeId(d.id);
                  pushToast(`Dispute rejected · ${res.dispute_id}`, 'warn');
                },
                onError: (err: Error) => pushToast(err.message, 'danger'),
              },
            );
          }}
        />
      ),
    });
  }

  function openDisputeDrawer(d: DisputeRow) {
    setOpenDisputeId(d.id);
    drawer.open(disputeDrawerOptions(d));
  }

  function disputeDrawerOptions(d: DisputeRow): OpenDrawerOptions {
    // W58-Finance+Support REDO closure: aging only applies to non-terminal
    // (working) disputes. Resolves through canonical
    // `dispute_status.metadata.lifecycle === 'working'` (replaces inline
    // `d.status === 'submitted' || d.status === 'under_review'` literal).
    const aging =
      disputeLifecycle(d.status)?.lifecycle === 'working'
        ? agingBucket(d.created_at, now, disputeSlaHours ?? 0)
        : null;
    // W25 — surface canonical projection-derived labels (opened_by /
    // counterparty / opened_by_user) when present.
    const proj = directoryById.get(d.id);
    return {
      title: `Dispute · ${d.id}`,
      size: 'md',
      onClose: () => setOpenDisputeId(null),
      body: (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Chip label={d.category} kind={lookupTone('dispute_kind', d.category) ?? 'danger'} size="xs" />
            <Chip label={d.status} kind={lookupTone('dispute_status', d.status) ?? 'danger'} size="xs" />
            {aging ? (
              <Chip
                label={`aging ${aging.label}`}
                kind={aging.tone}
                size="xs"
                title={`Filed ${aging.label} ago · SLA ${disputeSlaHours}h`}
              />
            ) : null}
            {proj && proj.is_escalated ? (
              <Chip
                label={`escalated ×${proj.escalation_count}`}
                kind="warn"
                size="xs"
                title={
                  proj.escalation_at
                    ? `Last escalation ${proj.escalation_at}`
                    : 'Escalated for review'
                }
              />
            ) : null}
          </div>
          <div className="card">
            <DetailRow k="Contract" v={d.contract_id} mono />
            <DetailRow k="Shipment" v={shipmentRefOf(d) ?? '—'} mono />
            <DetailRow k="Amount" v={fmtCurrency(amountSarOf(d))} />
            <DetailRow k="Filed" v={fmtDateTime(d.created_at)} />
            {proj?.opened_by_label ? (
              <DetailRow k="Opened by" v={proj.opened_by_label} />
            ) : null}
            {proj?.counterparty_label ? (
              <DetailRow k="Counterparty" v={proj.counterparty_label} />
            ) : null}
            {proj?.opened_by_user_label ? (
              <DetailRow k="Filed by" v={proj.opened_by_user_label} />
            ) : null}
            {proj?.resolved_by_user_label ? (
              <DetailRow k="Resolved by" v={proj.resolved_by_user_label} />
            ) : null}
            {d.resolution ? <DetailRow k="Resolution" v={String(d.resolution)} /> : null}
          </div>
          <h4 className="eyebrow" style={{ marginTop: '14px' }}>Operational backing</h4>
          <div className="card mono" style={{ fontSize: '11px', lineHeight: 1.6 }}>
            <SeamLine k="Case record" v="Marketplace dispute" />
            <SeamLine k="Resolution" v="Resolution workflow" />
            <SeamLine k="Audit" v="Audit and decision history" />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <Button
            label="Open shipment"
            iconName="right"
            kind="ghost"
            onClick={() => {
              drawer.close();
              const ref = shipmentRefOf(d);
              if (ref) openShipment(ref);
            }}
          />
          <Button
            label="Acknowledge"
            iconName="check"
            kind="ghost"
            capability={CAP.DISPUTES_WRITE}
            disabled={Boolean(acknowledgeDisabledReason(d))}
            title={acknowledgeDisabledReason(d)}
            onClick={() => acknowledgeDispute(d, 'drawer')}
          />
          <div style={{ flex: 1 }} />
          <Button
            label="Escalate"
            iconName="alert"
            kind="ghost"
            capability={CAP.DISPUTES_WRITE}
            disabled={Boolean(escalateDisabledReason(d))}
            title={escalateDisabledReason(d)}
            onClick={() => escalateDispute(d, 'drawer')}
          />
          <Button
            label="Reject"
            iconName="close"
            kind="danger"
            capability={CAP.DISPUTES_WRITE}
            disabled={Boolean(rejectDisabledReason(d))}
            title={rejectDisabledReason(d)}
            onClick={() => openRejectModal(d)}
          />
          <Button
            label="Mark resolved"
            iconName="check"
            kind="primary"
            capability={CAP.DISPUTES_WRITE}
            disabled={Boolean(resolveDisabledReason(d))}
            title={resolveDisabledReason(d)}
            onClick={() => {
              openResolveModal([d], { keepDrawerOpen: true });
            }}
          />
        </div>
      ),
    };
  }

  const columns: Array<DataTableColumn<DisputeRow>> = [
    { key: 'id', label: 'ID', mono: true, sortable: true },
    // W13-1 — `shipment_ref` and `amount_sar` resolve through metadata jsonb
    // (no top-level columns on canonical marketplace_disputes). Per-projection
    // keys keep React key uniqueness across columns.
    {
      key: 'metadata.shipment_ref',
      label: 'Shipment',
      mono: true,
      sortable: false,
      filterable: false,
      render: (_raw, row) => {
        const ref = shipmentRefOf(row);
        return ref ? <span className="mono">{ref}</span> : <span>—</span>;
      },
    },
    { key: 'category', label: 'Kind', sortable: true, filterable: true, lookup: 'dispute_kind' },
    {
      key: 'metadata.amount_sar',
      label: 'Amount',
      align: 'right',
      sortable: false,
      render: (_raw, row) => fmtCurrency(amountSarOf(row)),
    },
    { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'dispute_status' },
    {
      key: 'aging',
      label: 'Aging',
      sortable: false,
      render: (_raw: unknown, row: DisputeRow): ReactNode => {
        if (disputeLifecycle(row.status)?.lifecycle !== 'working') return null;
        const a = agingBucket(row.created_at, now, disputeSlaHours);
        return (
          <Chip
            label={a.label}
            kind={a.tone}
            size="xs"
            title={`Filed ${a.label} ago · SLA ${disputeSlaHours}h`}
          />
        );
      },
    },
    { key: 'created_at', label: 'Filed', format: 'datetime', sortable: true },
  ];

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={activeTenantId ?? ''} />,
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
    <span key="seam" className="chip chip--xs mono">dispute cases</span>,
    <Chip
      key="sla"
      label={`SLA ${disputeSlaHours}h`}
      kind="neutral"
      size="xs"
      title="Resolved dispute SLA from tenant settings"
    />,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="disputes"
        eyebrow="Finance"
        titleAccent="Disputes"
        titlePlain=""
        pills={pills}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<DisputeRow>
          columns={columns}
          rows={rows}
          viewKey="marketplace_disputes"
          entityKind="marketplace_dispute"
          getRowClass={(r) => {
            // W58-Finance+Support REDO closure: row-class risk gating
            // resolves through canonical `dispute_status.metadata.lifecycle
            // === 'working'` (replaces inline `r.status === 'submitted' ||
            // r.status === 'under_review'` literal).
            if (disputeLifecycle(r.status)?.lifecycle === 'working') {
              const a = agingBucket(r.created_at, now, disputeSlaHours);
              if (a.tone === 'danger') return 'is-risk';
            }
            return '';
          }}
          onRowClick={openDisputeDrawer}
          rowActions={[
            {
              label: 'Open dispute',
              icon: 'eye',
              kind: 'primary',
              onClick: openDisputeDrawer,
            },
            {
              label: 'Open shipment',
              icon: 'right',
              onClick: (r) => {
                const ref = shipmentRefOf(r);
                if (ref) openShipment(ref);
              },
            },
            {
              label: 'Acknowledge',
              icon: 'check',
              capability: CAP.DISPUTES_WRITE,
              disabled: (r) => Boolean(acknowledgeDisabledReason(r)),
              disabledReason: acknowledgeDisabledReason,
              onClick: (r) => acknowledgeDispute(r, 'row'),
            },
            {
              label: 'Escalate',
              icon: 'alert',
              kind: 'danger',
              capability: CAP.DISPUTES_WRITE,
              disabled: (r) => Boolean(escalateDisabledReason(r)),
              disabledReason: escalateDisabledReason,
              onClick: (r) => escalateDispute(r, 'row'),
            },
            {
              label: 'Mark resolved',
              icon: 'check',
              capability: CAP.DISPUTES_WRITE,
              disabled: (r) => Boolean(resolveDisabledReason(r)),
              disabledReason: resolveDisabledReason,
              onClick: (r) => openResolveModal([r]),
            },
          ]}
          bulkActions={[
            {
              label: 'Mark resolved',
              icon: 'check',
              kind: 'primary',
              capability: CAP.DISPUTES_WRITE,
              disabled: (rs) => rs.length === 0 || rs.some((r) => Boolean(resolveDisabledReason(r))),
              disabledReason: (rs) => {
                if (rs.some((r) => disputeTenantActionDisabledReason(r))) {
                  return "Switch to each selected dispute's tenant before changing dispute lifecycle.";
                }
                return rs.some((r) => !canResolveDispute(r))
                  ? 'Selected disputes include a status that cannot be resolved.'
                  : undefined;
              },
              onClick: (rs) => openResolveModal(rs),
            },
            {
              label: 'Escalate',
              icon: 'alert',
              capability: CAP.DISPUTES_WRITE,
              disabled: (rs) => rs.length === 0 || rs.some((r) => Boolean(escalateDisabledReason(r))),
              disabledReason: (rs) => {
                if (rs.some((r) => disputeTenantActionDisabledReason(r))) {
                  return "Switch to each selected dispute's tenant before changing dispute lifecycle.";
                }
                return rs.some((r) => !canEscalateDispute(r))
                  ? 'Selected disputes include a status that cannot be escalated.'
                  : undefined;
              },
              onClick: (rs) => openEscalateModal(rs, { forceBulk: true }),
            },
          ]}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

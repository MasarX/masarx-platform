// cod.tsx — TS/React port of demo-v2/assets/js/modules/finance-cod.js
// COD reconciliation. delivery_completion.payment_collection canonical truth.
// AGENTS.md lines 16-17.
//
// Hardening per __audit__/F:
//   - Aging chip on `pending` and `shortfall` rows derived from cod_policy.handover.window_hours.
//   - Status chip tone via lookup `cod_entry_status` (added to seed-raw/lookups.js).
//   - Resolved policy chip emitted in the page header pills.
//
// CLAIM-FINANCE-WIRING (Phase C4) verdict: READ-ONLY surface.
// The audit (apps/console-v2/__audit__/CROSSWALK/FINANCE.md sections BF-08,
// BF-14, BF-15, BF-16) confirms there is no canonical write RPC in the
// Phase B5 contract for COD reconcile actions: the canonical projection is
// `compute_cod_payment_collection_summary_v1` (read-only), and operator
// adjustments append finance_events via `record_finance_event_v1`
// (service-only — not exposed in B5). Unsupported cell edits / Mark
// remitted simulations are intentionally absent. The surviving workflow write
// action starts the canonical COD settlement flow.

// Current COD closeout slice adds canonical API-wrapper actions for remittance
// and collected-amount adjustment; local-state-only reconcile edits stay absent.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '@/lib/api';
import { Button } from '@/components/Button';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { KPICard } from '@/components/KPICard';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Chip } from '@/components/Chip';
import { pushToast } from '@/components/toastStore';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { englishT, fill, useI18n, type Translate } from '@/lib/i18n';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  useAdjustCodCollection,
  useCodSummary,
  useCompleteResourceList,
  useRecordCodRemittance,
  useResolveSettings,
  useStartWorkflowRun,
} from '@/lib/queries';
import { agingBucket, varianceState } from './_matcher';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import {
  openWorkflowRunContextDrawer,
  type WorkflowRunContextRecord,
  type WorkflowRunDomainEvent,
} from '@/modules/workflows/workflow-run-context';
import { SeamLine } from './_shared';

// Phase G1 (Wave 6) / W17-1 — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/FINANCE.md` §11 (CodEntryRow):
//
//   No standalone `cod_payments` canonical table exists. CoD entries are
//   filtered/aggregated views over `finance_events` (event_type 'cod_*')
//   joined to `shipments`/`tasks`/`route_runs` for tracking + driver labels.
//   The canonical projection RPC is `compute_cod_payment_collection_summary_v1`.
//
//   W17-1 close-out: every derived/joined field (`tracking`, `expected`,
//   `collected`, `remitted`, `status`, `driver`, `discrepancy`) is removed
//   from the FE row interface and read through canonical metadata jsonb +
//   helpers. Only canonical finance_events columns remain at the top level.
//   Seed mirrors that shape: derived values nest under `metadata`.
interface CodEntryRow extends Record<string, unknown> {
  id?: string;                   // → finance_events.id
  organization_id?: string | null; // → finance_events.organization_id
  /** Canonical finance_events.subject_id when subject_type='shipment'. */
  subject_id?: string;
  /** Backwards-compat alias for canonical subject_id (kept while seed transitions). */
  shipment_id?: string;
  currency: string;              // → finance_events.currency
  /** FE alias for canonical occurred_at when status='collected'. */
  collected_at?: string;
  created_at?: string;           // → finance_events.created_at
  /** Canonical metadata jsonb. All derived/join fields nest here:
   *  - metadata.tracking            → shipments.tracking_number join
   *  - metadata.expected            → shipments.cod_amount or sum projection
   *  - metadata.collected           → sum of finance_events 'cod_collected' credits
   *  - metadata.remitted            → sum of finance_events 'cod_remitted'
   *  - metadata.status              → derived state (collected/pending/shortfall/remitted)
   *  - metadata.driver              → tasks/route_runs/users join label
   *  - metadata.discrepancy         → collected − expected derivation
   *  None of these are columns on `finance_events`. */
  metadata?: Record<string, unknown>;
}

interface SettlementBatchGuardRow extends Record<string, unknown> {
  id?: string;
  organization_id?: string | null;
  kind?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface WorkflowRunGuardRow extends Record<string, unknown> {
  id?: string;
  workflow_template_id?: string | null;
  workflow_status?: string | null;
  context?: {
    organization_id?: string | null;
    payload?: {
      organization_id?: string | null;
      cod_entry_id?: string | null;
      metadata?: { cod_entry_id?: string | null } | null;
    } | null;
  } | null;
}

// Workflow handler named in the variance KPI; a code token, shown isolated.
const VARIANCE_GATE_HANDLER = 'variance_gate_v3';

// ─── W17-1 metadata helpers ──────────────────────────────────────────────
function trackingOf(r: CodEntryRow): string {
  const v = r.metadata?.['tracking'];
  return typeof v === 'string' ? v : '';
}
function expectedOf(r: CodEntryRow): number {
  const v = r.metadata?.['expected'];
  return typeof v === 'number' ? v : Number(v) || 0;
}
function collectedOf(r: CodEntryRow): number {
  const v = r.metadata?.['collected'];
  return typeof v === 'number' ? v : Number(v) || 0;
}
function remittedOf(r: CodEntryRow): number {
  const v = r.metadata?.['remitted'];
  return typeof v === 'number' ? v : Number(v) || 0;
}
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function codEntryIdOf(row: CodEntryRow): string {
  return textOf(row.id);
}
function codSettlementBatchEntryId(batch: SettlementBatchGuardRow): string {
  return textOf(batch.metadata?.cod_entry_id);
}
function settlementBatchBlocksCodRestart(batch: SettlementBatchGuardRow): boolean {
  if (String(batch.kind ?? '').trim().toLowerCase() !== 'cod') return false;
  const status = textOf(batch.status).toLowerCase();
  if (!status) return true;
  const metadata = api.lookupRow('settlement_status', status)?.metadata as
    | { allows_cod_restart?: boolean }
    | undefined;
  return metadata?.allows_cod_restart !== true;
}
function settlementBatchLabel(batch: SettlementBatchGuardRow, t: Translate = englishT): string {
  const status = textOf(batch.status);
  const label = status ? (api.lookupRow('settlement_status', status)?.label ?? status) : t('cod.unknownStatus');
  return `${label}${batch.id ? ` ${batch.id}` : ''}`;
}
function codSettlementWorkflowRunEntryId(run: WorkflowRunGuardRow): string {
  return textOf(run.context?.payload?.cod_entry_id ?? run.context?.payload?.metadata?.cod_entry_id);
}
function workflowRunTenantId(run: WorkflowRunGuardRow): string {
  return textOf(run.context?.organization_id ?? run.context?.payload?.organization_id);
}
function workflowRunBlocksCodRestart(run: WorkflowRunGuardRow): boolean {
  const status = textOf(run.workflow_status).toLowerCase();
  if (!status) return true;
  const metadata = api.lookupRow('workflow_run_status', status)?.metadata as
    | { blocks_cod_restart?: boolean }
    | undefined;
  return metadata?.blocks_cod_restart !== false;
}
function workflowRunLabel(run: WorkflowRunGuardRow, t: Translate = englishT): string {
  const status = textOf(run.workflow_status);
  const label = status ? (api.lookupRow('workflow_run_status', status)?.label ?? status) : t('cod.unknownStatus');
  return `${label}${run.id ? ` ${run.id}` : ''}`;
}
function statusOf(r: CodEntryRow): string {
  const v = r.metadata?.['status'];
  return typeof v === 'string' ? v : '';
}
function driverOf(r: CodEntryRow): string {
  const v = r.metadata?.['driver'];
  return typeof v === 'string' ? v : '';
}
function settlementContextDisabledReason(row: CodEntryRow, t: Translate = englishT): string | undefined {
  const metadata = row.metadata ?? {};
  if (metadata.settlement_context_ready !== false) return undefined;
  const branchMissing = !textOf(metadata.branch_id);
  const driverMissing = !textOf(metadata.driver_user_id);
  // Only one part missing names that part; both or neither keep the full phrase, as before.
  if (branchMissing && !driverMissing) return t('cod.reasons.contextMissingBranch');
  if (driverMissing && !branchMissing) return t('cod.reasons.contextMissingDriver');
  return t('cod.reasons.contextMissingBoth');
}
function discrepancyOf(r: CodEntryRow): number | undefined {
  const v = r.metadata?.['discrepancy'];
  if (typeof v === 'number') return v;
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
// Note: `shipmentIdOf` would resolve canonical subject_id (with legacy
// shipment_id fallback while seed transitions). The cod surface currently
// uses `tracking` for navigation; subject resolution lands when
// finance_events projection paths consume real shipments join data.

// W58-Finance+Support REDO closure: cod_entry_status lifecycle helper.
// AGENTS.md §2 + §4: aging-chip suppression and risk derivation resolve
// through canonical `cod_entry_status` lookup metadata. Replaces inline
// `s === 'collected' || s === 'remitted' || s === 'handed_over'` literal
// disjunctions and the `statusOf(r) === 'shortfall'` risk check with
// `metadata.suppress_aging_chip` / `metadata.risk` row-driven flags.
type CodEntryLifecycleMetadata = {
  lifecycle?: 'pending' | 'collected' | 'reconciled' | 'shortfall';
  risk?: 'none' | 'warn' | 'danger';
  suppress_aging_chip?: boolean;
};
function codEntryLifecycle(status: unknown): CodEntryLifecycleMetadata | null {
  if (status == null) return null;
  type LookupRowLike = { value: string; metadata?: CodEntryLifecycleMetadata };
  const list = (api.getLookups('cod_entry_status') as LookupRowLike[] | undefined) ?? [];
  const row = list.find((r) => r.value === String(status));
  if (!row) return null;
  return row.metadata ?? null;
}

export function CodModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.COD_READ);
  const { t, fmtCurrency } = useI18n();
  const identity = useIdentity();
  const { scope } = identity;
  const activeTenantId = scope.tenant?.id ?? identity.currentTenantId();
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
  const now = useMemo(() => new Date(), []);
  const drawer = useDrawer();
  const modal = useModal();
  const actionLocks = useRef<Set<string>>(new Set());

  // AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): handover SLA + variance
  // tolerance resolve STRICTLY from canonical `cod_policy` via the settings
  // ladder. NO fallback constants — a missing canonical row means the seed is
  // broken, not that the FE should pick a default. Render a loud error state
  // (below) so the operator sees the gap instead of silently using stale data.
  const codPolicy = useResolveSettings('cod_policy', settingsScope);
  const codPolicyValue = codPolicy.data?.value as
    | { handover_sla_hours?: number; variance_tolerance_sar?: number }
    | undefined;
  const handoverSlaHours = codPolicyValue?.handover_sla_hours;
  const varianceToleranceSar = codPolicyValue?.variance_tolerance_sar;

  // W39 closure (REAUDIT5B FINANCE NEW P2) — wire the per-row + bulk
  // "Start COD settlement" actions through the canonical public-callable
  // workflow-start seam `public.ui_start_workflow_run_v1` (asserts
  // `workflow_runs.write` server-side per
  // supabase/migrations/202601192200_ui_start_workflow_run_v1.sql:200).
  // Targets the `cod_driver_shift_settlement_v2` workflow template
  // (active per supabase/migrations/202601212897_settlement_workflow_driver_shift_cod_v2.sql:26-49).
  // The `variance_gate_v3` step lives inside this workflow as
  // `workflow_handlers.execute_variance_gate_v3` (handler schema, not
  // PostgREST-callable directly), so the canonical entrypoint is the
  // workflow start — which kicks off the same downstream gate logic.
  const startWorkflowRun = useStartWorkflowRun();
  const remittanceMutation = useRecordCodRemittance();
  const adjustmentMutation = useAdjustCodCollection();
  const codSettlementWorkflowTemplateId = api.resolve_workflow_template_id_v1('cod_driver_shift_settlement_v2');

  // W56-B-2 closure (F6) — `api.seed.codEntries()` migrated to canonical
  // `useResourceList<CodEntryRow>('cod_entries')`. The registry entry +
  // RESOURCE_DATA pass-through resolve through `ui_list_resource_v1` so
  // production cutover remains a single getSupabaseClient() branch flip
  // (FE call sites stay stable).
  const codEntriesQuery = useCompleteResourceList<CodEntryRow>('cod_entries');
  const settlementBatchGuardQuery = useCompleteResourceList<SettlementBatchGuardRow>(
    'settlement_batches',
    activeTenantId ? { filter: { organization_id: activeTenantId } } : undefined,
    { enabled: canRead && Boolean(activeTenantId), retry: false },
  );
  const settlementWorkflowRunGuardQuery = useCompleteResourceList<WorkflowRunGuardRow>(
    'workflow_run_directory',
    codSettlementWorkflowTemplateId ? { filter: { workflow_template_id: codSettlementWorkflowTemplateId } } : undefined,
    { enabled: canRead && Boolean(activeTenantId) && Boolean(codSettlementWorkflowTemplateId), retry: false },
  );
  const codSummaryQuery = useCodSummary({ organization_id: activeTenantId });
  const rawEntries = codEntriesQuery.data?.rows;
  const isLoading = codEntriesQuery.isLoading;
  const blockingSettlementByCodEntryId = useMemo(() => {
    const map = new Map<string, SettlementBatchGuardRow>();
    for (const batch of settlementBatchGuardQuery.data?.rows ?? []) {
      if (!settlementBatchBlocksCodRestart(batch)) continue;
      const codEntryId = codSettlementBatchEntryId(batch);
      if (!codEntryId || map.has(codEntryId)) continue;
      map.set(codEntryId, batch);
    }
    return map;
  }, [settlementBatchGuardQuery.data?.rows]);
  const blockingWorkflowRunByCodEntryId = useMemo(() => {
    const map = new Map<string, WorkflowRunGuardRow>();
    const scopedTenantId = textOf(activeTenantId);
    for (const run of settlementWorkflowRunGuardQuery.data?.rows ?? []) {
      if (!workflowRunBlocksCodRestart(run)) continue;
      if (scopedTenantId && workflowRunTenantId(run) !== scopedTenantId) continue;
      const codEntryId = codSettlementWorkflowRunEntryId(run);
      if (!codEntryId || map.has(codEntryId)) continue;
      map.set(codEntryId, run);
    }
    return map;
  }, [activeTenantId, settlementWorkflowRunGuardQuery.data?.rows]);

  // ─── Strict guards BEFORE any policy-dependent computation ─────────────
  // (All hooks above; non-hook logic + JSX below are now safe to assume
  // non-null policy values.)
  if (!canRead) {
    return (
      <div className="page">
        <PageHeader moduleKey="cod" />
        <StateView
          kind="denied"
          capability={CAP.COD_READ}
          hint={t('cod.denied')}
        />
      </div>
    );
  }
  if (codPolicy.isLoading) {
    return (
      <div className="page">
        <PageHeader moduleKey="cod" />
        <StateView kind="loading" />
      </div>
    );
  }
  if (handoverSlaHours == null || varianceToleranceSar == null) {
    return (
      <div className="page">
        <PageHeader moduleKey="cod" />
        <StateView
          kind="error"
          title={t('cod.policy.notReadyTitle')}
          hint={t('cod.policy.notReadyHint')}
        />
      </div>
    );
  }
  if (codSummaryQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader moduleKey="cod" />
        <StateView kind="loading" title={t('cod.summary.loadingTitle')} hint={t('cod.summary.loadingHint')} />
      </div>
    );
  }
  if (codSummaryQuery.error) {
    return (
      <div className="page">
        <PageHeader moduleKey="cod" />
        <StateView
          kind="error"
          title={t('cod.summary.unavailableTitle')}
          hint={(codSummaryQuery.error as Error).message || t('cod.summary.unreadable')}
        />
      </div>
    );
  }
  const summary = codSummaryQuery.data;
  const expected = Number(summary?.expected);
  const collected = Number(summary?.collected);
  const remitted = Number(summary?.remitted);
  const variance = Number(summary?.variance);
  if (
    !summary ||
    !Number.isFinite(expected) ||
    !Number.isFinite(collected) ||
    !Number.isFinite(remitted) ||
    !Number.isFinite(variance)
  ) {
    return (
      <div className="page">
        <PageHeader moduleKey="cod" />
        <StateView
          kind="error"
          title={t('cod.summary.unavailableTitle')}
          hint={t('cod.summary.incomplete')}
        />
      </div>
    );
  }
  if (codEntriesQuery.isError) {
    return (
      <div className="page">
        <PageHeader moduleKey="cod" />
        <StateView
          kind="error"
          title={t('cod.entriesUnavailable')}
          hint={(codEntriesQuery.error as Error).message}
        />
      </div>
    );
  }

  const rows = rawEntries ?? [];

  // W17-1 — derived sums via canonical metadata helpers (no top-level
  const collectedPct = expected > 0 ? Math.round((collected / expected) * 100) : 0;
  const remittedPct = expected > 0 ? Math.round((remitted / expected) * 100) : 0;

  const aggregateVariance = varianceState(expected, collected, varianceToleranceSar);

  function openShipment(r: CodEntryRow) {
    const shipmentId = String(r.subject_id ?? r.shipment_id ?? trackingOf(r));
    openShipmentContextDrawer(drawer, shipmentId, {
      fallbackShipment: {
        id: shipmentId,
        tracking_number: trackingOf(r),
        cod_amount: expectedOf(r),
        cod_currency: r.currency,
      },
    });
  }

  function ageOf(r: CodEntryRow) {
    const anchor = r.collected_at ?? r.created_at;
    if (!anchor) return null;
    return agingBucket(anchor, now, handoverSlaHours ?? 0);
  }

  function outstandingRemittanceOf(row: CodEntryRow): number {
    return Math.max(collectedOf(row) - remittedOf(row), 0);
  }

  function codTenantActionDisabledReason(row: CodEntryRow): string | undefined {
    const rowTenantId = textOf(row.organization_id);
    const scopedTenantId = textOf(activeTenantId);
    if (rowTenantId && (!scopedTenantId || rowTenantId !== scopedTenantId)) {
      return t('cod.reasons.switchTenant');
    }
    return undefined;
  }

  function cashierCountDisabledReason(row: CodEntryRow): string | undefined {
    const tenantReason = codTenantActionDisabledReason(row);
    if (tenantReason) return tenantReason;
    if (!row.id) return t('cod.reasons.missingEventRef');
    if (outstandingRemittanceOf(row) <= 0) {
      return t('cod.reasons.noOutstanding');
    }
    return undefined;
  }

  function adjustCollectedDisabledReason(row: CodEntryRow): string | undefined {
    const tenantReason = codTenantActionDisabledReason(row);
    if (tenantReason) return tenantReason;
    if (!row.id) return t('cod.reasons.missingEventRef');
    return undefined;
  }

  function settlementWorkflowDisabledReason(row: CodEntryRow): string | undefined {
    const tenantReason = codTenantActionDisabledReason(row);
    if (tenantReason) return tenantReason;
    if (!row.id) return t('cod.reasons.missingEventRef');
    const existingSettlement = blockingSettlementByCodEntryId.get(codEntryIdOf(row));
    if (existingSettlement) {
      return fill(t('cod.reasons.settlementExists'), { label: settlementBatchLabel(existingSettlement, t) });
    }
    const existingRun = blockingWorkflowRunByCodEntryId.get(codEntryIdOf(row));
    if (existingRun) {
      return fill(t('cod.reasons.runActive'), { label: workflowRunLabel(existingRun, t) });
    }
    if (!textOf(row.subject_id ?? row.shipment_id)) {
      return t('cod.reasons.needsShipment');
    }
    const contextReason = settlementContextDisabledReason(row, t);
    if (contextReason) return contextReason;
    const varianceAmount = collectedOf(row) - expectedOf(row);
    if (outstandingRemittanceOf(row) <= 0 && Math.abs(varianceAmount) < 0.01) {
      return t('cod.reasons.balanced');
    }
    return undefined;
  }

  function settlementWorkflowTriggerSummary(row: CodEntryRow): string {
    const outstanding = outstandingRemittanceOf(row);
    const variance = collectedOf(row) - expectedOf(row);
    const parts: string[] = [];
    if (outstanding > 0) parts.push(fill(t('cod.trigger.outstanding'), { amount: fmtCurrency(outstanding) }));
    if (Math.abs(variance) >= 0.01) parts.push(fill(t('cod.trigger.variance'), { amount: fmtCurrency(variance) }));
    return parts.join(' · ') || t('cod.trigger.needsSettlement');
  }

  function bulkCashierCountDisabledReason(rows: CodEntryRow[]): string | undefined {
    if (rows.some((row) => Boolean(codTenantActionDisabledReason(row)))) {
      return t('cod.reasons.bulkSwitchTenantCount');
    }
    if (rows.every((row) => Boolean(cashierCountDisabledReason(row)))) {
      return t('cod.reasons.bulkNoOutstanding');
    }
    return undefined;
  }

  function bulkSettlementWorkflowDisabledReason(rows: CodEntryRow[]): string | undefined {
    if (rows.some((row) => Boolean(codTenantActionDisabledReason(row)))) {
      return t('cod.reasons.bulkSwitchTenantSettlement');
    }
    if (rows.every((row) => Boolean(settlementWorkflowDisabledReason(row)))) {
      return t('cod.reasons.bulkNoSettlement');
    }
    return undefined;
  }

  async function buildSettlementWorkflowPayload(row: CodEntryRow): Promise<Record<string, unknown>> {
    const shipmentId = textOf(row.subject_id ?? row.shipment_id);
    if (!shipmentId) {
      throw new Error(t('cod.reasons.needsShipment'));
    }
    const shipment = await api.ui_get_resource_v1<Record<string, unknown>>('shipments', shipmentId);
    const branchId = textOf(shipment?.branch_id) || textOf(row.metadata?.branch_id);
    const driverUserId = textOf(shipment?.driver_user_id) || textOf(row.metadata?.driver_user_id);
    if (!branchId || !driverUserId) {
      throw new Error(t('cod.reasons.contextMissingBoth'));
    }
    const anchor = row.collected_at ?? row.created_at ?? new Date().toISOString();
    const periodDate = anchor.slice(0, 10);
    const tracking = trackingOf(row) || textOf(shipment?.tracking_number);
    const expectedAmount = expectedOf(row);
    const collectedAmount = collectedOf(row);
    const remittedAmount = remittedOf(row);
    const currency = row.currency || textOf(shipment?.cod_currency);
    if (!activeTenantId || !currency) {
      throw new Error(t('cod.reasons.needsOrgCurrency'));
    }
    return {
      organization_id: activeTenantId,
      kind: 'cod',
      scope_type: 'driver_shift',
      subject_type: 'driver',
      subject_id: driverUserId,
      branch_id: branchId,
      client_id: textOf(shipment?.client_id) || undefined,
      window_start_at: `${periodDate}T00:00:00.000Z`,
      window_end_at: `${periodDate}T23:59:59.999Z`,
      cod_entry_id: row.id,
      shipment_id: shipmentId,
      tracking,
      settlement: {
        expected_amount: expectedAmount,
        collected_amount: collectedAmount,
        remitted_amount: remittedAmount,
        variance_amount: collectedAmount - expectedAmount,
        outstanding_handover_amount: Math.max(collectedAmount - remittedAmount, 0),
        currency,
      },
      metadata: {
        source: 'console-v2/finance/cod',
        cod_entry_id: row.id,
        shipment_id: shipmentId,
        tracking,
      },
    };
  }

  async function openStartedWorkflowContext(
    row: CodEntryRow,
    workflowRunId: string | null | undefined,
    payload: Record<string, unknown>,
  ) {
    const runId = textOf(workflowRunId);
    if (!runId) return;
    let latestRun: WorkflowRunContextRecord | null = {
      id: runId,
      workflow_status: 'pending',
      workflow_template_key: 'cod_driver_shift_settlement_v2',
    };
    let latestEvents: WorkflowRunDomainEvent[] = [];
    try {
      const [runReadback, eventReadback] = await Promise.all([
        api.ui_list_resource_complete<WorkflowRunContextRecord>('workflow_run_directory', {
          filter: { id: runId },
          page_size: 1,
        }),
        api.ui_list_resource_complete<WorkflowRunDomainEvent>('domain_events', {
          filter: { workflow_run_id: runId },
          page_size: 25,
        }),
      ]);
      latestRun = (runReadback.rows?.[0] ?? latestRun) as WorkflowRunContextRecord | null;
      latestEvents = eventReadback.rows ?? [];
    } catch (err) {
      pushToast((err as Error)?.message ?? t('cod.toast.contextUnavailable'), 'warn');
    }
    const settlement = payload.settlement as Record<string, unknown> | undefined;
    openWorkflowRunContextDrawer(drawer, {
      workflowRunId: runId,
      run: latestRun,
      events: latestEvents,
      contextRows: [
        { label: t('cod.context.codEntry'), value: <bdi className="mono">{row.id}</bdi> },
        { label: t('cod.context.tracking'), value: <bdi className="mono">{textOf(payload.tracking) || trackingOf(row)}</bdi> },
        { label: t('cod.context.scope'), value: t('cod.context.scopeValue') },
        { label: t('cod.context.driver'), value: <bdi className="mono">{textOf(payload.subject_id)}</bdi> },
        { label: t('cod.context.branch'), value: <bdi className="mono">{textOf(payload.branch_id)}</bdi> },
        {
          label: t('cod.context.amounts'),
          value: fill(t('cod.context.amountsValue'), {
            expected: fmtCurrency(Number(settlement?.expected_amount ?? expectedOf(row))),
            collected: fmtCurrency(Number(settlement?.collected_amount ?? collectedOf(row))),
            remitted: fmtCurrency(Number(settlement?.remitted_amount ?? remittedOf(row))),
          }),
        },
      ],
      deepLink: `/workflows/runs?focus=${encodeURIComponent(runId)}`,
      onOpenWorkflowModule: () => {
        window.history.pushState(null, '', `/workflows/runs?focus=${encodeURIComponent(runId)}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
    });
  }

  async function startCodSettlementWorkflow(
    row: CodEntryRow,
    opts?: { showToast?: boolean; openContext?: boolean },
  ): Promise<boolean> {
    const showToast = opts?.showToast !== false;
    const openContext = opts?.openContext !== false;
    const disabledReason = settlementWorkflowDisabledReason(row);
    if (disabledReason) {
      if (showToast) pushToast(disabledReason, 'warn');
      return false;
    }
    const tplId = codSettlementWorkflowTemplateId;
    if (!tplId) {
      if (showToast) {
        pushToast(
          t('cod.toast.notConfigured'),
          'danger',
        );
      }
      return false;
    }
    try {
      const payload = await buildSettlementWorkflowPayload(row);
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
      const runId = textOf(res.workflow_run_id);
      if (runId) {
        try {
          await api.progress_workflow_run_until_wait_v1(
            runId,
            {
              source: 'console-v2/finance/cod',
              cod_entry_id: row.id,
              shipment_id: textOf(payload.shipment_id),
              tracking: textOf(payload.tracking),
            },
            {
              budget_ms: 5000,
              max_steps: 10,
            },
          );
        } catch (err) {
          pushToast(
            fill(t('cod.toast.advanceFailed'), { error: (err as Error)?.message ?? t('cod.toast.unknownError') }),
            'danger',
          );
        }
      }
      if (showToast) {
        pushToast(
          fill(t('cod.toast.started'), { tracking: trackingOf(row), runId: res.workflow_run_id ?? t('cod.toast.pending') }),
          'good',
        );
      }
      if (openContext) await openStartedWorkflowContext(row, res.workflow_run_id, payload);
      return true;
    } catch (err) {
      if (showToast) {
        pushToast(
          fill(t('cod.toast.startFailed'), { error: (err as Error)?.message ?? t('cod.toast.unknownError') }),
          'danger',
        );
      }
      return false;
    }
  }

  function openBulkSettlementWorkflowModal(selectedRows: CodEntryRow[]) {
    const disabledReason = bulkSettlementWorkflowDisabledReason(selectedRows);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    const eligible = selectedRows.filter((row) => !settlementWorkflowDisabledReason(row));
    const skipped = selectedRows
      .map((row) => ({ row, reason: settlementWorkflowDisabledReason(row) }))
      .filter((entry): entry is { row: CodEntryRow; reason: string } => Boolean(entry.reason));
    if (eligible.length === 0) {
      pushToast(t('cod.reasons.bulkNoSettlement'), 'warn');
      return;
    }

    function BulkSettlementWorkflowForm() {
      return (
        <div>
          <p className="state__hint">
            {fill(t(eligible.length === 1 ? 'cod.bulkSettlement.introOne' : 'cod.bulkSettlement.introOther'), { n: eligible.length })}
            {skipped.length
              ? ` ${fill(t(skipped.length === 1 ? 'cod.bulkSettlement.skippedOne' : 'cod.bulkSettlement.skippedOther'), { n: skipped.length })}`
              : ''}
          </p>
          <div className="card mono" style={{ fontSize: '11px', lineHeight: 1.6, marginTop: 10 }}>
            {eligible.slice(0, 5).map((row) => (
              <SeamLine
                key={row.id}
                k={t('cod.bulkSettlement.eligible')}
                v={`${trackingOf(row)} - ${settlementWorkflowTriggerSummary(row)}`}
              />
            ))}
            {eligible.length > 5 ? <SeamLine k={t('cod.bulkSettlement.moreEligible')} v={String(eligible.length - 5)} /> : null}
            {skipped.slice(0, 3).map(({ row, reason }) => (
              <SeamLine key={row.id} k={t('cod.bulkSettlement.skipped')} v={`${trackingOf(row)} - ${reason}`} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('cod.bulkSettlement.confirm')}
              iconName="alert"
              kind="primary"
              capability={CAP.FINANCE_WRITE}
              disabled={startWorkflowRun.isPending}
              onClick={async () => {
                modal.close();
                const results = await Promise.all(
                  eligible.map((row) =>
                    startCodSettlementWorkflow(row, {
                      showToast: false,
                      openContext: eligible.length === 1,
                    }),
                  ),
                );
                const succeeded = results.filter(Boolean).length;
                pushToast(
                  fill(t(eligible.length === 1 ? 'cod.toast.bulkStartedOne' : 'cod.toast.bulkStartedOther'), {
                    n: succeeded,
                    total: eligible.length,
                  }),
                  succeeded === eligible.length ? 'good' : 'warn',
                );
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({
      title: fill(t('cod.bulkSettlement.title'), { n: eligible.length }),
      body: <BulkSettlementWorkflowForm />,
    });
  }

  async function recordRemittance(
    row: CodEntryRow,
    amount: number,
    reason: string,
  ): Promise<boolean> {
    const disabledReason = cashierCountDisabledReason(row);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return false;
    }
    const rowId = row.id as string;
    const lockKey = `remittance:${rowId}`;
    if (actionLocks.current.has(lockKey)) return false;
    actionLocks.current.add(lockKey);
    try {
      const enteredAmount = Number(amount);
      if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
        pushToast(t('cod.toast.enterPositive'), 'warn');
        return false;
      }
      if (enteredAmount > outstandingRemittanceOf(row)) {
        pushToast(t('cod.toast.exceedsOutstanding'), 'warn');
        return false;
      }
      const trimmedReason = reason.trim();
      if (!trimmedReason) {
        pushToast(t('cod.toast.remittanceReasonRequired'), 'warn');
        return false;
      }
      const res = await remittanceMutation.mutateAsync({
        cod_entry_id: rowId,
        amount: enteredAmount,
        currency: row.currency,
        reason: trimmedReason,
      });
      pushToast(
        fill(t('cod.toast.remittanceRecorded'), { ref: res.transfer_id ?? res.to_finance_event_id ?? t('cod.toast.pending') }),
        'good',
      );
      return true;
    } catch (err) {
      pushToast(fill(t('cod.toast.remittanceFailed'), { error: (err as Error)?.message ?? t('cod.toast.unknownError') }), 'danger');
      return false;
    } finally {
      actionLocks.current.delete(lockKey);
    }
  }

  async function adjustCollected(
    row: CodEntryRow,
    adjustmentAmount: number,
    reason: string,
  ): Promise<boolean> {
    const disabledReason = adjustCollectedDisabledReason(row);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return false;
    }
    const rowId = row.id as string;
    const lockKey = `adjust:${rowId}`;
    if (actionLocks.current.has(lockKey)) return false;
    actionLocks.current.add(lockKey);
    try {
      const enteredAmount = Number(adjustmentAmount);
      if (!Number.isFinite(enteredAmount) || enteredAmount === 0) {
        pushToast(t('cod.toast.enterNonZero'), 'warn');
        return false;
      }
      const trimmedReason = reason.trim();
      if (!trimmedReason) {
        pushToast(t('cod.toast.adjustmentReasonRequired'), 'warn');
        return false;
      }
      const res = await adjustmentMutation.mutateAsync({
        cod_entry_id: rowId,
        adjustment_amount: enteredAmount,
        currency: row.currency,
        reason: trimmedReason,
      });
      pushToast(fill(t('cod.toast.adjustmentRecorded'), { ref: res.finance_event_id ?? t('cod.toast.pending') }), 'good');
      return true;
    } catch (err) {
      pushToast(fill(t('cod.toast.adjustmentFailed'), { error: (err as Error)?.message ?? t('cod.toast.unknownError') }), 'danger');
      return false;
    } finally {
      actionLocks.current.delete(lockKey);
    }
  }

  function openCashierCountModal(row: CodEntryRow) {
    const disabledReason = cashierCountDisabledReason(row);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    const suggested = outstandingRemittanceOf(row);
    const reference = trackingOf(row) || row.id || t('cod.form.codRow');

    function CashierCountForm() {
      const [draft, setDraft] = useState({
        amount: suggested > 0 ? String(suggested) : '',
        reason: '',
      });
      const amount = Number(draft.amount);
      const canSubmit =
        Number.isFinite(amount) && amount > 0 && amount <= suggested && !!draft.reason.trim();

      const submit = async () => {
        if (!canSubmit || remittanceMutation.isPending) return;
        const ok = await recordRemittance(row, amount, draft.reason);
        if (ok) modal.close();
      };

      return (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await submit();
          }}
        >
          <p className="state__hint">
            {t('cod.cashier.intro')}
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
            <label className="mono" htmlFor="cod-cashier-count-ref">{t('cod.form.codRow')}</label>
            <input
              id="cod-cashier-count-ref"
              className="dt-inline-input"
              value={reference}
              readOnly
            />
            <label className="mono" htmlFor="cod-cashier-count-expected">{t('cod.form.outstanding')}</label>
            <input
              id="cod-cashier-count-expected"
              className="dt-inline-input"
              value={fmtCurrency(suggested)}
              readOnly
            />
            <label className="mono" htmlFor="cod-cashier-count-amount">{t('cod.cashier.amount')}</label>
            <input
              id="cod-cashier-count-amount"
              data-testid="cod-cashier-count-amount"
              className="dt-inline-input"
              type="number"
              min="0"
              max={suggested > 0 ? suggested : undefined}
              step="0.01"
              value={draft.amount}
              onChange={(e) => setDraft((s) => ({ ...s, amount: e.target.value }))}
            />
            <label className="mono" htmlFor="cod-cashier-count-reason">{t('cod.form.reason')}</label>
            <input
              id="cod-cashier-count-reason"
              data-testid="cod-cashier-count-reason"
              className="dt-inline-input"
              placeholder={t('cod.cashier.reasonPlaceholder')}
              value={draft.reason}
              onChange={(e) => setDraft((s) => ({ ...s, reason: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('cod.actions.recordCashierCount')}
              kind="primary"
              capability={CAP.FINANCE_WRITE}
              type="submit"
              disabled={!canSubmit || remittanceMutation.isPending}
              onClick={async () => {
                await submit();
              }}
            />
          </div>
        </form>
      );
    }

    modal.open({ title: fill(t('cod.cashier.title'), { ref: reference }), body: <CashierCountForm /> });
  }

  function openAdjustmentModal(row: CodEntryRow) {
    const disabledReason = adjustCollectedDisabledReason(row);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    const reference = trackingOf(row) || row.id || t('cod.form.codRow');

    function AdjustmentForm() {
      const [draft, setDraft] = useState({ amount: '', reason: '' });
      const amount = Number(draft.amount);
      const canSubmit = Number.isFinite(amount) && amount !== 0 && !!draft.reason.trim();

      const submit = async () => {
        if (!canSubmit || adjustmentMutation.isPending) return;
        const ok = await adjustCollected(row, amount, draft.reason);
        if (ok) modal.close();
      };

      return (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await submit();
          }}
        >
          <p className="state__hint">
            {t('cod.adjust.intro')}
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
            <label className="mono" htmlFor="cod-adjust-ref">{t('cod.form.codRow')}</label>
            <input id="cod-adjust-ref" className="dt-inline-input" value={reference} readOnly />
            <label className="mono" htmlFor="cod-adjust-amount">{t('cod.adjust.amount')}</label>
            <input
              id="cod-adjust-amount"
              data-testid="cod-adjust-amount"
              className="dt-inline-input"
              type="number"
              step="0.01"
              value={draft.amount}
              onChange={(e) => setDraft((s) => ({ ...s, amount: e.target.value }))}
            />
            <label className="mono" htmlFor="cod-adjust-reason">{t('cod.form.reason')}</label>
            <input
              id="cod-adjust-reason"
              data-testid="cod-adjust-reason"
              className="dt-inline-input"
              placeholder={t('cod.adjust.reasonPlaceholder')}
              value={draft.reason}
              onChange={(e) => setDraft((s) => ({ ...s, reason: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('cod.adjust.submit')}
              kind="primary"
              capability={CAP.FINANCE_WRITE}
              type="submit"
              disabled={!canSubmit || adjustmentMutation.isPending}
              onClick={async () => {
                await submit();
              }}
            />
          </div>
        </form>
      );
    }

    modal.open({ title: fill(t('cod.adjust.title'), { ref: reference }), body: <AdjustmentForm /> });
  }

  function openBulkCashierCountModal(selectedRows: CodEntryRow[]) {
    const disabledReason = bulkCashierCountDisabledReason(selectedRows);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    const remittable = selectedRows
      .map((row) => ({ row, amount: outstandingRemittanceOf(row), reason: cashierCountDisabledReason(row) }))
      .filter((item) => !item.reason && item.amount > 0);
    const totalAmount = remittable.reduce((sum, item) => sum + item.amount, 0);

    function BulkCashierCountForm() {
      const [reason, setReason] = useState('');
      const canSubmit = remittable.length > 0 && !!reason.trim();

      if (remittable.length === 0) {
        return (
          <div>
            <StateView
              kind="empty"
              title={t('cod.bulkCount.emptyTitle')}
              hint={t('cod.bulkCount.emptyHint')}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <Button label={t('cod.form.close')} kind="ghost" onClick={() => modal.close()} />
            </div>
          </div>
        );
      }

      return (
        <div>
          <p className="state__hint">
            {fill(t('cod.bulkCount.intro'), { n: remittable.length })}
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
            <label className="mono" htmlFor="cod-bulk-count-total">{t('cod.bulkCount.total')}</label>
            <input
              id="cod-bulk-count-total"
              className="dt-inline-input"
              value={fmtCurrency(totalAmount)}
              readOnly
            />
            <label className="mono" htmlFor="cod-bulk-count-reason">{t('cod.form.reason')}</label>
            <input
              id="cod-bulk-count-reason"
              data-testid="cod-bulk-count-reason"
              className="dt-inline-input"
              placeholder={t('cod.bulkCount.reasonPlaceholder')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('cod.bulkCount.submit')}
              kind="primary"
              capability={CAP.FINANCE_WRITE}
              disabled={!canSubmit || remittanceMutation.isPending}
              onClick={async () => {
                const results = await Promise.all(
                  remittable.map((item) => recordRemittance(item.row, item.amount, reason)),
                );
                if (results.every(Boolean)) modal.close();
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({ title: t('cod.bulkCount.title'), body: <BulkCashierCountForm /> });
  }

  // W17-1 — every derived column reads through metadata helpers; per-projection
  // keys keep React key uniqueness across columns.
  const columns: Array<DataTableColumn<CodEntryRow>> = [
    {
      key: 'metadata.tracking',
      label: t('cod.columns.tracking'),
      mono: true,
      sortable: false,
      filterable: false,
      render: (_raw, row) => {
        const tracking = trackingOf(row);
        return tracking ? <span className="mono">{tracking}</span> : <span>—</span>;
      },
    },
    {
      key: 'metadata.driver',
      label: t('cod.columns.driver'),
      sortable: false,
      filterable: false,
      render: (_raw, row) => driverOf(row) || '—',
    },
    {
      key: 'metadata.expected',
      label: t('cod.columns.expected'),
      align: 'right',
      sortable: false,
      render: (_raw, row) => fmtCurrency(expectedOf(row)),
    },
    {
      key: 'metadata.collected',
      label: t('cod.columns.collected'),
      align: 'right',
      sortable: false,
      render: (_raw, row) => fmtCurrency(collectedOf(row)),
    },
    {
      key: 'metadata.remitted',
      label: t('cod.columns.remitted'),
      align: 'right',
      sortable: false,
      render: (_raw, row) => fmtCurrency(remittedOf(row)),
    },
    {
      key: 'metadata.discrepancy',
      label: t('cod.columns.discrepancy'),
      align: 'right',
      sortable: false,
      render: (_raw, row) => {
        const d = discrepancyOf(row);
        return d == null ? '—' : fmtCurrency(d);
      },
    },
    {
      key: 'metadata.status',
      label: t('cod.columns.status'),
      sortable: false,
      filterable: false,
      lookup: 'cod_entry_status',
      render: (_raw, row) => statusOf(row) || '—',
    },
    {
      key: 'aging',
      label: t('cod.columns.aging'),
      sortable: false,
      render: (_raw: unknown, row: CodEntryRow): ReactNode => {
        // W58-Finance+Support REDO closure: aging-chip suppression resolves
        // through canonical `cod_entry_status.metadata.suppress_aging_chip`
        // (replaces inline `s === 'collected' || s === 'remitted' ||
        // s === 'handed_over'` literal disjunction).
        if (codEntryLifecycle(statusOf(row))?.suppress_aging_chip === true) {
          return null;
        }
        const a = ageOf(row);
        if (!a) return null;
        return (
          <Chip
            label={a.label}
            kind={a.tone}
            size="xs"
            title={fill(t('cod.agingTitle'), { age: a.label, hours: String(handoverSlaHours) })}
          />
        );
      },
    },
    { key: 'collected_at', label: t('cod.columns.collectedAt'), format: 'datetime', sortable: true },
  ];

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={activeTenantId ?? ''} />,
    <span key="seam" className="chip chip--xs mono">
      {t('cod.pills.seam')}
    </span>,
    <Chip
      key="policy"
      label={fill(t('cod.pills.policy'), { hours: String(handoverSlaHours), amount: fmtCurrency(varianceToleranceSar) })}
      kind="neutral"
      size="xs"
      title={t('cod.pills.policyTitle')}
    />,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="cod"
        pills={pills}
      />

      <div className="kpi-strip">
        <KPICard
          label={t('cod.columns.expected')}
          value={fmtCurrency(expected)}
          tone="neutral"
          delta={t('cod.kpi.expectedDelta')}
        />
        <KPICard
          label={t('cod.columns.collected')}
          value={fmtCurrency(collected)}
          tone="good"
          delta={`${collectedPct}%`}
        />
        <KPICard
          label={t('cod.columns.remitted')}
          value={fmtCurrency(remitted)}
          tone="info"
          delta={`${remittedPct}%`}
        />
        <KPICard
          label={t('cod.kpi.variance')}
          value={fmtCurrency(variance)}
          tone={
            aggregateVariance.tone === 'warn'
              ? 'warn'
              : aggregateVariance.tone === 'danger'
                ? 'danger'
                : 'good'
          }
          delta={
            aggregateVariance.exceeds_threshold ? (
              <>
                {t('cod.kpi.gateTriggers')} <bdi className="mono">{VARIANCE_GATE_HANDLER}</bdi>
              </>
            ) : (
              fill(t('cod.kpi.tolerance'), { amount: fmtCurrency(varianceToleranceSar) })
            )
          }
        />
      </div>

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<CodEntryRow>
          columns={columns}
          rows={rows}
          viewKey="cod"
          entityKind="cod_entry"
          getRowClass={(r) => {
            // W58-Finance+Support REDO closure: row-class risk gating resolves
            // through canonical `cod_entry_status.metadata.risk` (replaces
            // inline `statusOf(r) === 'shortfall'` literal).
            if (codEntryLifecycle(statusOf(r))?.risk === 'danger') return 'is-risk';
            const a = ageOf(r);
            return a?.tone === 'danger' ? 'is-risk' : '';
          }}
          onRowClick={openShipment}
          rowDeepLink={(r) => `/operate/shipments?focus=${encodeURIComponent(trackingOf(r))}`}
          // COD closeout writes are routed through canonical browser-safe
          // API-schema wrappers. Local-state-only reconcile simulations stay
          // absent.
          rowActions={[
            {
              label: t('cod.actions.recordCashierCount'),
              icon: 'check',
              capability: CAP.FINANCE_WRITE,
              disabled: (r) => Boolean(cashierCountDisabledReason(r)),
              disabledReason: (r) => cashierCountDisabledReason(r),
              onClick: (r) => openCashierCountModal(r),
            },
            {
              label: t('cod.actions.adjustCollected'),
              icon: 'edit',
              capability: CAP.FINANCE_WRITE,
              disabled: (r) => Boolean(adjustCollectedDisabledReason(r)),
              disabledReason: (r) => adjustCollectedDisabledReason(r),
              onClick: (r) => openAdjustmentModal(r),
            },
            {
              label: t('cod.actions.startSettlement'),
              icon: 'alert',
              capability: CAP.FINANCE_WRITE,
              disabled: (r) => Boolean(settlementWorkflowDisabledReason(r)),
              disabledReason: (r) => settlementWorkflowDisabledReason(r),
              onClick: (r) => startCodSettlementWorkflow(r),
            },
            {
              label: t('cod.actions.openShipment'),
              icon: 'right',
              onClick: (r) => openShipment(r),
            },
          ]}
          bulkActions={[
            {
              label: t('cod.actions.recordCashierCounts'),
              icon: 'check',
              capability: CAP.FINANCE_WRITE,
              disabled: (rs) => Boolean(bulkCashierCountDisabledReason(rs)),
              disabledReason: (rs) => bulkCashierCountDisabledReason(rs),
              onClick: (rs) => openBulkCashierCountModal(rs),
            },
            {
              label: t('cod.actions.startSettlement'),
              icon: 'alert',
              capability: CAP.FINANCE_WRITE,
              disabled: (rs) => Boolean(bulkSettlementWorkflowDisabledReason(rs)),
              disabledReason: (rs) => bulkSettlementWorkflowDisabledReason(rs),
              onClick: (rs) => openBulkSettlementWorkflowModal(rs),
            },
          ]}
        />
      )}
      {drawer.node}
      {modal.node}
    </div>
  );
}

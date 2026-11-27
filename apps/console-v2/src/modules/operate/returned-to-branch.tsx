// returned-to-branch.tsx — TS/React port of demo-v2/assets/js/modules/op-returned-to-branch.js
// Backed by record_scan_event_v1 (scan_type='return_to_branch_intake') and
// api.return_to_branch_shipments_v1 (view; canonical migrations
// 202604101131 + 202604101380).
//
// CLAIM C hardening sweep:
//   • Intake scan now opens a small modal asking for a tracking number /
//     shipment id before calling record_scan_event_v1 (canonical RPC needs
//     a payload to actually flip a shipment; fire-and-forget was a no-op)
//   • removed unbacked "Initiate refund (COD)" row action — refund initiation
//     belongs in finance/cod or settlement reversal, not warehouse list
//   • wired Reschedule + Re-attempt to shipment_amend_cancel_v1
//   • wired bulk Reschedule + Re-attempt to ui_execute_shipment_batch_operation_v1

import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useReturnToBranch,
  useScanEvent,
  useShipmentAmendCancel,
  useShipmentBatchOp,
  useNdrBranchNextAction,
  useResourceList,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
// W54-C — strict canonical lookup resolver + settings policy.
import { lookupRow } from '@/lib/api';
import { useResolveSettings } from '@/lib/queries';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import { englishT, fill, useT, type Translate } from '@/lib/i18n';

const DAY_MS = 86_400_000;

type DeliverySlotPolicyValue = {
  default_reschedule_offsets?: Array<number | string>;
};

function offsetDaysFromPolicy(value: number | string): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const match = /^P(\d+)D$/.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isFinite(days) ? days : null;
}

function defaultRescheduleOffsets(value: unknown): number[] {
  const offsets = (value as DeliverySlotPolicyValue | undefined)?.default_reschedule_offsets;
  return Array.isArray(offsets)
    ? offsets.map(offsetDaysFromPolicy).filter((offset): offset is number => offset !== null)
    : [];
}

function slotDateFromOffset(offsetDays: number, now = new Date()): string {
  return new Date(now.getTime() + DAY_MS * offsetDays).toISOString().slice(0, 10);
}

function defaultSlotDate(value: unknown): string {
  const offset = defaultRescheduleOffsets(value)[0];
  return typeof offset === 'number' ? slotDateFromOffset(offset) : '';
}

function reschedulePayload(slotDate: string, source: string): Record<string, string> {
  return { slot_date: slotDate, source };
}

function recoveryActionErrorMessage(error: unknown, t: Translate = englishT): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/branch_unmapped/i.test(raw)) {
    return t('returnedToBranch.errors.branchUnmapped');
  }
  if (/policy|configured|settings/i.test(raw)) {
    return t('returnedToBranch.errors.policy');
  }
  return t('returnedToBranch.errors.generic');
}

// Wave 6 schema-drift remediation (OPERATIONS Section 11), W10-5 update:
// FE ReturnedRow annotated against canonical view `api.return_to_branch_shipments_v1`
// (supabase/migrations/202604101131_b09_return_to_branch_intake_visibility_v1.sql:743).
// `destination_city` is treated as an OPTIONAL display alias projected from
// `addresses.city` (joined via shipments.destination_address_id) — same
// pattern as the parent `Shipment` interface in operate/shipments.tsx.
// G1 verifies view returns the column directly or extends it via address join.
// See __audit__/SCHEMA-DRIFT/OPERATIONS.md §11.
interface ReturnedRow extends Record<string, unknown> {
  id: string;                       // SSOT: shipments.id (view-projected)
  tracking_number: string;          // SSOT: shipments.tracking_number
  destination_city?: string;        // SSOT: derived projection alias from addresses.city (joined via destination_address_id)
  cod_amount?: number;              // SSOT: shipments.cod_amount (verify against view)
  cod_currency?: string;            // SSOT: shipments.cod_currency (verify against view)
  service_type: string;             // SSOT: shipments.service_type (verify against view)
  updated_at: string;               // SSOT: shipments.updated_at (verify against view)
}

interface ReturnActionReadback {
  trackingNumber: string;
  action: string;
  rpc: string;
  source: string;
  workflowRunId: string;
  workflowTemplate: string;
  canonicalEntrypoint: string;
  settingsResolutionId: string;
  queueCount: number;
  rowPresent: boolean;
  rowUpdatedAt: string;
}

export function ReturnedToBranchModule() {
  const t = useT();
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.SHIPMENTS_READ);
  const { data, isLoading, refetch } = useReturnToBranch();
  const scan = useScanEvent();
  const amend = useShipmentAmendCancel();
  const batchOp = useShipmentBatchOp();
  const slotPolicy = useResolveSettings('delivery_slot_policy', undefined);
  const drawer = useDrawer();
  const modal = useModal();
  const [actionReadback, setActionReadback] = useState<ReturnActionReadback | null>(null);

  const rows = (data ?? []) as ReturnedRow[];

  async function resolveNextSlotDate(): Promise<string> {
    const loaded = defaultSlotDate(slotPolicy.data?.value);
    if (loaded) return loaded;
    const refreshed = await slotPolicy.refetch();
    return defaultSlotDate(refreshed.data?.value);
  }

  const columns: Array<DataTableColumn<ReturnedRow>> = useMemo(
    () => [
      { key: 'tracking_number', label: t('returnedToBranch.columns.tracking'), mono: true, sortable: true, filterable: true },
      { key: 'destination_city', label: t('returnedToBranch.columns.destination'), sortable: true, filterable: true },
      { key: 'cod_amount', label: t('returnedToBranch.columns.cod'), align: 'right', format: 'currency', type: 'number', sortable: true },
      { key: 'service_type', label: t('returnedToBranch.columns.service'), lookup: 'service_type', sortable: true, filterable: true },
      // CLAIM-OPERATIONS-WIRING (Phase C1) — recommendation chip sourced from
      // the canonical resolve_ndr_branch_next_action_v1 RPC. Closes the P2 gap
      // row in __audit__/CROSSWALK/OPERATIONS.md (operators previously had no
      // hint for which lever to pull on a returned-to-branch shipment).
      {
        key: 'recommended',
        label: t('returnedToBranch.columns.recommended'),
        sortable: false,
        filterable: false,
        render: (_raw, row) => (
          <RecommendedReturnChip
            shipment={row}
            organizationId={scope.tenant?.id ?? null}
          />
        ),
      },
      { key: 'updated_at', label: t('returnedToBranch.columns.updated'), format: 'datetime', sortable: true },
    ],
    [scope.tenant?.id, t],
  );

  function openShipmentContext(row: ReturnedRow) {
    openShipmentContextDrawer(drawer, row.id, {
      fallbackShipment: {
        id: row.id,
        tracking_number: row.tracking_number,
        cod_amount: row.cod_amount,
        cod_currency: row.cod_currency,
        destination_city: row.destination_city,
      },
    });
  }

  async function recordActionReadback(
    row: ReturnedRow,
    action: string,
    rpc: string,
    source: string,
    result: unknown,
  ): Promise<ReturnActionReadback> {
    const refreshed = await refetch();
    const nextRows = (refreshed.data ?? []) as ReturnedRow[];
    const refreshedRow = nextRows.find((candidate) => candidate.id === row.id);
    const rec = result as {
      workflow_run_id?: string;
      workflow_template?: string;
      canonical_entrypoint?: string;
      settings_resolution_id?: string;
    };
    const readback: ReturnActionReadback = {
      trackingNumber: row.tracking_number,
      action,
      rpc,
      source,
      workflowRunId: rec.workflow_run_id || '',
      workflowTemplate: rec.workflow_template || '',
      canonicalEntrypoint: rec.canonical_entrypoint || '',
      settingsResolutionId: rec.settings_resolution_id || '',
      queueCount: nextRows.length,
      rowPresent: Boolean(refreshedRow),
      rowUpdatedAt: refreshedRow?.updated_at ?? 'not visible',
    };
    setActionReadback(readback);
    return readback;
  }

  const pills: ReactNode[] = [
    // W56-C closure — `scopeType="tenant"` is the canonical resource-tier literal
    // (return-to-branch handover scopes via current_user_org_id()).
    // `scopeId` is identity-derived. See shipments.tsx top-of-file SSOT note.
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip key="seam" size="xs" label={<span>{t('returnedToBranch.seamChip')}</span>} />,
  ];

  function openIntakeScanModal() {
    modal.open({
      title: t('returnedToBranch.intake.title'),
      body: <IntakeScanBody scan={scan} onDone={() => { modal.close(); refetch(); }} />,
    });
  }

  function openRescheduleModal(r: ReturnedRow) {
    modal.open({
      title: fill(t('returnedToBranch.reschedule.title'), { tracking: r.tracking_number }),
      body: (
        <RescheduleBody
          shipment={r}
          amend={amend}
          onApplied={(result) =>
            recordActionReadback(r, t('returnedToBranch.actions.reschedule'), 'shipment_amend_cancel_v1', 'Returned shipment', result)
          }
          onDone={() => { modal.close(); }}
        />
      ),
    });
  }

  function openReattemptDrawer(r: ReturnedRow) {
    drawer.open({
      title: fill(t('returnedToBranch.reattempt.title'), { tracking: r.tracking_number }),
      size: 'md',
      body: (
        <div>
          <p className="state__hint">{t('returnedToBranch.reattempt.hint')}</p>
          <div className="card" style={{ marginTop: '12px' }}>
            <Kv k={t('returnedToBranch.columns.tracking')} v={<span className="mono">{r.tracking_number}</span>} />
            <Kv k={t('returnedToBranch.columns.destination')} v={<bdi>{r.destination_city ?? '—'}</bdi>} />
            <Kv k={t('returnedToBranch.columns.service')} v={<bdi>{r.service_type}</bdi>} />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <div style={{ flex: 1 }} />
          <Button label={t('common.cancel')} kind="ghost" onClick={() => drawer.close()} />
          <Button
            label={t('returnedToBranch.reattempt.queue')}
            iconName="rotate"
            kind="primary"
            capability={CAP.SHIPMENTS_WRITE}
            onClick={async () => {
              const slotDate = await resolveNextSlotDate();
              if (!slotDate) {
                pushToast(t('returnedToBranch.reattempt.policyMissing'), 'warn');
                return;
              }
              const result = await amend.mutateAsync({
                shipmentId: r.id,
                op: 'reschedule',
                payload: reschedulePayload(slotDate, 'returned_to_branch_reattempt'),
              });
              await recordActionReadback(
                r,
                t('returnedToBranch.actions.reattempt'),
                'shipment_amend_cancel_v1',
                'Returned shipment',
                result,
              );
              pushToast(fill(t('returnedToBranch.reattempt.queued'), { tracking: r.tracking_number }), 'good');
              drawer.close();
            }}
          />
        </div>
      ),
    });
  }

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader moduleKey="returnedToBranch" />
        <StateView
          kind="denied"
          capability={CAP.SHIPMENTS_READ}
          hint={t('returnedToBranch.denied')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="returnedToBranch"
        pills={pills}
        actions={[
          <Button
            key="intake"
            label={t('returnedToBranch.intakeScan')}
            iconName="scan"
            kind="primary"
            capability={CAP.WAREHOUSE_SCAN}
            onClick={openIntakeScanModal}
          />,
        ]}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<ReturnedRow>
          columns={columns}
          rows={rows}
          viewKey="returned_to_branch"
          entityKind="shipment"
          emptyText={t('returnedToBranch.empty')}
          onRowClick={openShipmentContext}
          rowDeepLink={(r) => `/operate/shipments?focus=${encodeURIComponent(r.tracking_number)}`}
          rowActions={[
            {
              label: t('returnedToBranch.actions.reschedule'),
              icon: 'history',
              kind: 'primary',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: openRescheduleModal,
            },
            {
              label: t('returnedToBranch.actions.reattempt'),
              icon: 'rotate',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: openReattemptDrawer,
            },
            {
              label: t('returnedToBranch.actions.openShipment'),
              icon: 'eye',
              onClick: openShipmentContext,
            },
          ]}
          bulkActions={[
            {
              label: t('returnedToBranch.actions.bulkReschedule'),
              icon: 'history',
              kind: 'primary',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: async (rs) => {
                const slotDate = await resolveNextSlotDate();
                if (!slotDate) {
                  pushToast(t('returnedToBranch.bulk.previewPolicyMissing'), 'warn');
                  return;
                }
                await batchOp.mutateAsync({
                  ids: rs.map((r) => r.id),
                  op: 'reschedule',
                  payload: reschedulePayload(slotDate, 'returned_to_branch_bulk_reschedule'),
                  dryRun: true,
                });
                pushToast(fill(t('returnedToBranch.bulk.previewPassed'), { n: rs.length }), 'info');
              },
            },
            {
              label: t('returnedToBranch.actions.bulkReattempt'),
              icon: 'rotate',
              capability: CAP.SHIPMENTS_WRITE,
              onClick: async (rs) => {
                const slotDate = await resolveNextSlotDate();
                if (!slotDate) {
                  pushToast(t('returnedToBranch.bulk.reattemptPolicyMissing'), 'warn');
                  return;
                }
              const result = await batchOp.mutateAsync({
                ids: rs.map((r) => r.id),
                op: 'reschedule',
                payload: reschedulePayload(slotDate, 'returned_to_branch_reattempt'),
              });
              const firstRow = rs[0];
              if (firstRow) {
                await recordActionReadback(
                  firstRow,
                  fill(t('returnedToBranch.actions.bulkReattemptCount'), { n: rs.length }),
                  'ui_execute_shipment_batch_operation_v1',
                  'returned_to_branch_reattempt',
                  result,
                );
              }
              pushToast(fill(t('returnedToBranch.bulk.queued'), { n: rs.length }), 'good');
            },
          },
          ]}
        />
      )}

      {actionReadback ? <ReturnActionReadbackPanel readback={actionReadback} /> : null}

      {drawer.node}
      {modal.node}
    </div>
  );
}

function ReturnActionReadbackPanel({ readback }: { readback: ReturnActionReadback }) {
  const t = useT();
  return (
    <section
      className="panel"
      aria-label={t('returnedToBranch.readback.label')}
      style={{ marginTop: '14px', display: 'grid', gap: '10px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 14px' }}>
        <Chip size="sm" kind="good" label={t('returnedToBranch.readback.label')} />
        <span className="state__hint">{t('returnedToBranch.readback.done')}</span>
      </div>
      <div className="card">
        <Kv k={t('returnedToBranch.columns.tracking')} v={<span className="mono">{readback.trackingNumber}</span>} />
        <Kv k={t('returnedToBranch.readback.action')} v={readback.action} />
        <Kv k={t('returnedToBranch.readback.workflow')} v={readback.workflowRunId ? t('returnedToBranch.readback.started') : t('returnedToBranch.readback.pending')} />
        <Kv k={t('returnedToBranch.readback.policyCheck')} v={readback.settingsResolutionId ? t('returnedToBranch.readback.passed') : t('returnedToBranch.readback.pending')} />
        <Kv
          k={t('returnedToBranch.readback.queueStatus')}
          v={readback.rowPresent
            ? fill(t('returnedToBranch.readback.queueUpdated'), { n: readback.queueCount, at: readback.rowUpdatedAt })
            : fill(t('returnedToBranch.readback.queueAwaiting'), { n: readback.queueCount })}
        />
      </div>
    </section>
  );
}

function IntakeScanBody({
  scan,
  onDone,
}: {
  scan: ReturnType<typeof useScanEvent>;
  onDone: () => void;
}) {
  const t = useT();
  const branchesQuery = useResourceList<{ id: string; code?: string; name?: string }>('branches');
  const branches = branchesQuery.data?.rows ?? [];
  const [tracking, setTracking] = useState<string>('');
  const [branchId, setBranchId] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const effectiveBranchId = branchId || branches[0]?.id || '';
  const valid = tracking.trim().length >= 4 && effectiveBranchId.length > 0;

  async function submit() {
    setBusy(true);
    try {
      const cleanTracking = tracking.trim();
      await scan.mutateAsync({
        scan_type: 'return_to_branch_intake',
        tracking_number: cleanTracking,
        barcode: cleanTracking,
        branch_id: effectiveBranchId,
        idempotency_key: `console-v2:return-to-branch:${effectiveBranchId}:${cleanTracking}`,
        metadata: {
          source: 'console_v2.returned_to_branch.intake_scan',
          tracking_number: cleanTracking,
        },
      });
      pushToast(fill(t('returnedToBranch.intake.recorded'), { tracking: tracking.trim() }), 'good');
      onDone();
    } catch {
      pushToast(t('returnedToBranch.intake.failed'), 'warn');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="state__hint">{t('returnedToBranch.intake.hint')}</p>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('returnedToBranch.intake.branch')}</label>
        <select
          value={effectiveBranchId}
          onChange={(e) => setBranchId(e.target.value)}
          disabled={branchesQuery.isLoading || busy}
        >
          {branches.length === 0 ? (
            <option value="" disabled>
              {branchesQuery.isLoading ? t('returnedToBranch.intake.loadingBranches') : t('returnedToBranch.intake.noBranches')}
            </option>
          ) : (
            branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.code && branch.name ? `${branch.code} · ${branch.name}` : branch.name ?? branch.code ?? branch.id}
              </option>
            ))
          )}
        </select>
      </div>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('returnedToBranch.intake.trackingNumber')}</label>
        <input
          autoFocus
          type="text"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          dir="ltr"
          placeholder="SHP-9381201" /* i18n-literal-ok: tracking-number format example */
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid && !busy) {
              void submit();
            }
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('returnedToBranch.intake.recordScan')}
          iconName="scan"
          kind="primary"
          capability={CAP.WAREHOUSE_SCAN}
          disabled={!valid || busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function RescheduleBody({
  shipment,
  amend,
  onApplied,
  onDone,
}: {
  shipment: ReturnedRow;
  amend: ReturnType<typeof useShipmentAmendCancel>;
  onApplied?: (result: unknown) => Promise<unknown> | unknown;
  onDone: () => void;
}) {
  // W54-C — reschedule offsets resolved strictly from canonical
  // `delivery_slot_policy.default_reschedule_offsets`. Replaces inline
  // ±1/2/3 day offset literals.
  const t = useT();
  const slotPolicy = useResolveSettings('delivery_slot_policy', undefined);
  const offsets = defaultRescheduleOffsets(slotPolicy.data?.value);
  const dateOpts = offsets.map((offset) => slotDateFromOffset(offset));
  const [pickedDate, setPickedDate] = useState<string>('');
  const effectivePickedDate = pickedDate || dateOpts[0] || '';
  // W54-C — strict no-fallback: surface a loud StateView when the
  // canonical delivery_slot_policy.default_reschedule_offsets row is
  // missing rather than silently substituting FE literals.
  const [error, setError] = useState<string | null>(null);
  if (offsets.length === 0) {
    return (
      <StateView
        kind="error"
        title={t('returnedToBranch.reschedule.policyMissingTitle')}
        hint={t('returnedToBranch.reschedule.policyMissingHint')}
      />
    );
  }
  return (
    <div>
      <p className="state__hint">{t('returnedToBranch.reschedule.hint')}</p>
      {error ? (
        <div style={{ marginTop: '12px' }}>
          <StateView
            kind="error"
            title={t('returnedToBranch.reschedule.blocked')}
            hint={error}
          />
        </div>
      ) : null}
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('returnedToBranch.reschedule.to')}</label>
        <select value={effectivePickedDate} onChange={(e) => setPickedDate(e.target.value)}>
          {dateOpts.map((iso) => (
            <option key={iso} value={iso}>{iso}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('returnedToBranch.reschedule.apply')}
          kind="primary"
          capability={CAP.SHIPMENTS_WRITE}
          disabled={amend.isPending}
          onClick={() => {
            setError(null);
            amend.mutate(
              {
                shipmentId: shipment.id,
                op: 'reschedule',
                payload: reschedulePayload(effectivePickedDate, 'returned_to_branch'),
              },
              {
                onSuccess: async (result) => {
                  await onApplied?.(result);
                  pushToast(fill(t('returnedToBranch.reschedule.done'), { tracking: shipment.tracking_number, date: effectivePickedDate }), 'good');
                  onDone();
                },
                onError: (err) => {
                  setError(recoveryActionErrorMessage(err, t));
                  pushToast(t('returnedToBranch.reschedule.blockedToast'), 'warn');
                },
              },
            );
          }}
        />
      </div>
    </div>
  );
}

// CLAIM-OPERATIONS-WIRING (Phase C1) — recommendation chip per returned-to-
// branch row. Reads through `resolve_ndr_branch_next_action_v1` so the
// operator sees the policy-driven next action (reschedule / re-attempt /
// return / cancel / hold). Tone derives from the action: cancel = danger,
// customer_pickup / hold = warn, others = good.
function RecommendedReturnChip({
  shipment,
  organizationId,
}: {
  shipment: ReturnedRow;
  organizationId: string | null;
}) {
  const t = useT();
  const { data, isLoading } = useNdrBranchNextAction(
    {
      organization_id: organizationId,
      service_type: shipment.service_type,
      shipment_action_type: 'return_to_branch_intake',
      review_status: 'open',
    },
    !!organizationId,
  );
  if (!organizationId) {
    return <span className="state__hint" style={{ fontSize: '11px' }}>—</span>;
  }
  if (isLoading || !data) {
    return <span className="state__hint" style={{ fontSize: '11px' }}>{t('returnedToBranch.resolving')}</span>;
  }
  // W54-C — tone via canonical `ndr_branch_next_action` lookup_values.
  // metadata.tone (NO inline ternary). Chip label keeps the raw canonical
  // action value (e.g. `reschedule`) so the operator sees the SSOT enum
  // identifier directly. Missing canonical row resolves to a `danger` chip.
  const row = lookupRow('ndr_branch_next_action', data) as { tone?: string; label?: string } | null;
  const tone = (row?.tone as 'good' | 'warn' | 'danger' | 'info' | undefined) ?? 'danger';
  return <Chip size="xs" kind={tone} label={data} />;
}

interface KvProps { k: string; v: ReactNode }
function Kv({ k, v }: KvProps) {
  return (
    <div style={{ display: 'flex', padding: '4px 0', borderBottom: '1px solid var(--line)', fontSize: '11.5px' }}>
      <span className="mono" style={{ color: 'var(--ink-3)', minWidth: '160px' }}>{k}</span>
      <span>{v}</span>
    </div>
  );
}

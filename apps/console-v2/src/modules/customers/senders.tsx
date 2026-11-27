// senders.tsx — Operator-managed shipment sources (public.senders).
//
// Backend SSOT
//   • Table: public.senders (supabase/migrations/202510110002_configuration_core.sql, lines 103-126)
//   • RLS:   public.senders_select|insert|update|delete (202601022114_access_control_rls.sql, lines 162-275)
//            + RBAC capability gates (senders.read / senders.write) per
//              202601300360_rbac_clients_senders_write_gates_v1.sql.
//   • Status enum: lookup category `sender_status` (active|inactive|suspended). Migration:
//                  202601202320_lookup_column_contracts_and_enforcement.sql lines 161-162.
//   • Ladder rank for sender scope is resolved from the canonical `scope_type` lookup (rank 3),
//     not hardcoded as a string on the page header.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { Chip } from '@/components/Chip';
import { useResource, useResourceList, useSuspendSender, useReactivateSender, useSenderCreate, useSenderUpdate } from '@/lib/queries';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { getLookups } from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';
import { englishT, fill, useT, type Translate } from '@/lib/i18n';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import { RelatedShipmentsPanel, type CustomerRelatedShipmentRow } from './related-shipments';

// Phase G1 schema-drift fix: dropped fictional `organization_id` (resolved via
// clients.organization_id join) and `source` (no `source` column on senders;
// metadata.source if needed). See __audit__/SCHEMA-DRIFT/CUSTOMERS.md §3.
interface SenderRow extends Record<string, unknown> {
  id: string;
  name: string;
  brand_name?: string | null;
  client_id: string;
  client_label?: string | null;
  client_slug?: string | null;
  auto_provisioned: boolean;
  auto_recreate?: boolean;
  status: string;
  suspension_reason?: string | null;
  settings_override?: Record<string, unknown> | null;
}

// W21: paired projection view `public.v_sender_summary` (read-only).
// Mirrors the SQL view shape — additive context for the operator drawer
// (client_label, sla_tier_inherited, effective_warehouse_id, shipment
// counters). No FE-only invented fields; every column has a canonical
// source. SSOT remains public.senders via the registry seam.
// See supabase/migrations/202604302010_v_sender_summary.sql.
interface SenderSummaryRow extends Record<string, unknown> {
  sender_id: string;
  id?: string;
  name?: string;
  brand_name?: string | null;
  client_id?: string;
  auto_provisioned?: boolean;
  auto_recreate?: boolean;
  warehouse_address_id?: string | null;
  settings_override?: Record<string, unknown> | null;
  status?: string;
  client_label?: string | null;
  client_slug?: string | null;
  sla_tier_inherited?: string | null;
  organization_id_resolved?: string | null;
  effective_warehouse_id?: string | null;
  has_warehouse?: boolean;
  active_shipments?: number;
  total_shipments?: number;
  last_shipment_at?: string | null;
}

// Phase G1: dropped fictional `code` field (canonical key is `slug`).
interface ClientRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug?: string;
}

// AGENTS.md §4 (SSOT): canonical key sourced from src/lib/capabilities.ts.
const WRITE_CAP = CAP.SENDERS_WRITE;

function statusLookup() {
  return (getLookups('sender_status') ?? []) as Array<{
    value: string;
    label: string;
    tone?: string;
    is_default?: boolean;
    metadata?: { lifecycle?: string };
  }>;
}

// W56-A closure: derive default status strictly from canonical seed rows
// flagged `is_default: true` (lookup_values.metadata.is_default — see
// src/lib/seed-raw/lookups.js#sender_status). Returns null when the seed is
// missing the canonical default row, surfacing the gap instead of silently
// masking it with a hardcoded `'active'` literal.
function defaultStatus(): string | null {
  return statusLookup().find((s) => s.is_default)?.value ?? null;
}

function senderLifecycle(status: string | null | undefined): string | null {
  return status ? statusLookup().find((row) => row.value === status)?.metadata?.lifecycle ?? null : null;
}

function canSuspendSender(row: SenderRow): boolean {
  return senderLifecycle(row.status) === 'active';
}

function canReactivateSender(row: SenderRow): boolean {
  return senderLifecycle(row.status) === 'suspended';
}

function formatSenderCreateError(err: unknown, t: Translate = englishT): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const lower = message.toLowerCase();
  if (
    lower.includes('sender_create_v1 duplicate active sender name')
    || (lower.includes('duplicate') && lower.includes('sender') && lower.includes('name'))
  ) {
    return t('senders.error.duplicateName');
  }
  return message;
}

function senderFieldLabel(key: string, t: Translate = englishT): string {
  const labels: Record<string, string> = {
    name: t('customers.field.name'),
    brand_name: t('customers.field.brand'),
    status: t('customers.field.status'),
  };
  return labels[key] ?? key;
}

function scopeRank(scopeType: string): number | null {
  const list = (getLookups('scope_type') ?? []) as Array<{ value: string; rank?: number }>;
  const row = list.find((r) => r.value === scopeType);
  return typeof row?.rank === 'number' ? row.rank : null;
}

function humanizeSettingKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatSummaryValue(value: unknown, t: Translate = englishT): string {
  if (value == null || value === '') return t('customers.settings.notConfigured');
  if (typeof value === 'boolean') return value ? t('customers.settings.enabled') : t('customers.settings.disabled');
  if (Array.isArray(value)) return fill(t(value.length === 1 ? 'customers.settings.itemOne' : 'customers.settings.itemOther'), { n: value.length });
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return fill(t(count === 1 ? 'customers.settings.nestedOne' : 'customers.settings.nestedOther'), { n: count });
  }
  return String(value);
}

function objectSummaryRows(value: Record<string, unknown> | null | undefined, prefix: string, t: Translate = englishT): KvRow[] {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0) {
    return [{ key: `${prefix}-empty`, label: t('customers.field.status'), value: t('customers.settings.none'), editable: false }];
  }
  return entries.map(([key, val]) => ({
    key: `${prefix}-${key}`,
    label: humanizeSettingKey(key),
    value: formatSummaryValue(val, t),
    editable: false,
  }));
}

function senderRowFromSummary(row: SenderSummaryRow): SenderRow {
  return {
    ...row,
    id: row.sender_id ?? row.id ?? '',
    name: row.name ?? '',
    brand_name: row.brand_name ?? null,
    client_id: row.client_id ?? '',
    auto_provisioned: row.auto_provisioned ?? false,
    auto_recreate: row.auto_recreate ?? true,
    warehouse_address_id: row.warehouse_address_id ?? row.effective_warehouse_id ?? null,
    settings_override: row.settings_override ?? null,
    status: row.status ?? defaultStatus() ?? 'unknown',
  };
}

interface SenderSuspendDraft {
  reason: string;
}

interface NewSenderDraft {
  client_id: string;
  name: string;
  brand_name: string;
}

export function SendersModule() {
  const { scope, currentTenantId } = useIdentity();
  const t = useT();
  const drawer = useDrawer();
  const modal = useModal();
  const go = useConsoleNavigator();
  const canRead = useCapability(CAP.SENDERS_READ);
  const canReadShipments = useCapability(CAP.SHIPMENTS_READ);
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const clientParam = readUrlParam('client');
  const focusParam = readUrlParam('focus');
  const openedFocusRef = useRef<string | null>(null);
  const [openSenderId, setOpenSenderId] = useState<string | null>(null);
  const [pendingCreatedSenderId, setPendingCreatedSenderId] = useState<string | null>(null);
  const openSenderSignatureRef = useRef<string | null>(null);
  const tenantClientOpts = useMemo(
    () => {
      const filter: Record<string, string> = {};
      if (tenantId) filter.organization_id = tenantId;
      if (clientParam) filter.id = clientParam;
      return Object.keys(filter).length ? { filter } : undefined;
    },
    [tenantId, clientParam],
  );
  const senderSummaryOpts = useMemo(
    () => {
      const filter: Record<string, string> = {};
      if (tenantId) filter.organization_id_resolved = tenantId;
      if (clientParam) filter.client_id = clientParam;
      return Object.keys(filter).length ? { filter } : undefined;
    },
    [tenantId, clientParam],
  );
  const senderListOpts = useMemo(
    () => (clientParam && !tenantId ? { filter: { client_id: clientParam } } : undefined),
    [clientParam, tenantId],
  );
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const suspendMut = useSuspendSender();
  const reactivateMut = useReactivateSender();
  const createMut = useSenderCreate();
  const updateMut = useSenderUpdate();

  const sendersQuery = useResourceList<SenderRow>(
    'senders',
    senderListOpts,
    { enabled: canRead && !tenantId },
  );
  const clientsQuery = useResourceList<ClientRow>('clients', tenantClientOpts, readQueryOptions);
  // W21: consume canonical paired projection for derived context (client
  // label, sla_tier_inherited, effective_warehouse_id, shipment counters).
  const summaryQuery = useResourceList<SenderSummaryRow>(
    'sender_summary',
    senderSummaryOpts,
    readQueryOptions,
  );

  const { data: sendersData, isLoading: sendersLoading, error: sendersError } = sendersQuery;
  const { data: clientsData, error: clientsError } = clientsQuery;
  const { data: summaryData, isLoading: summaryLoading, error: summaryError } = summaryQuery;

  const visibleSenderIds = useMemo(
    () => new Set((summaryData?.rows ?? []).map((row) => row.sender_id)),
    [summaryData],
  );
  const senders = useMemo(() => {
    const rows = sendersData?.rows ?? [];
    if (!tenantId) return rows;
    const summaryRows = summaryData?.rows ?? [];
    if (summaryRows.length > 0) return summaryRows.map(senderRowFromSummary);
    return [];
  }, [sendersData, summaryData, tenantId, visibleSenderIds]);
  const clients = useMemo(() => clientsData?.rows ?? [], [clientsData]);

  const clientById = useMemo(() => new Map<string, ClientRow>(clients.map((c) => [c.id, c])), [clients]);
  const summaryById = useMemo(
    () => new Map<string, SenderSummaryRow>((summaryData?.rows ?? []).map((s) => [s.sender_id, s])),
    [summaryData],
  );
  const displaySenders = useMemo(
    () =>
      senders.map((sender) => {
        const summary = summaryById.get(sender.id);
        const client = clientById.get(sender.client_id);
        const client_label = summary?.client_label ?? sender.client_label ?? client?.name ?? sender.client_id;
        const client_slug = summary?.client_slug ?? sender.client_slug ?? client?.slug ?? null;
        return { ...sender, client_label, client_slug };
      }),
    [senders, summaryById, clientById],
  );
  const rank = scopeRank('sender');
  const noClientsVisible = clientsData != null && clients.length === 0;
  const openSenderShipmentsQuery = useResourceList<CustomerRelatedShipmentRow>(
    'shipment_directory',
    openSenderId
      ? { filter: { sender_id: openSenderId }, sort: { key: 'created_at', dir: 'desc' }, page_size: 3 }
      : undefined,
    { enabled: canRead && canReadShipments && Boolean(openSenderId) },
  );
  const openSenderShipments = openSenderShipmentsQuery.data?.rows ?? [];
  const openSenderShipmentSignature = JSON.stringify({
    loading: openSenderShipmentsQuery.isLoading,
    error: openSenderShipmentsQuery.error instanceof Error ? openSenderShipmentsQuery.error.message : null,
    rows: openSenderShipments.map((shipment) => [
      shipment.id,
      shipment.tracking_number ?? null,
      shipment.status ?? null,
      shipment.client_reference_number ?? null,
    ]),
  });
  const focusInRows = focusParam ? displaySenders.some((row) => row.id === focusParam) : false;
  const focusedSenderQuery = useResource<SenderRow>(
    'senders',
    focusParam && canRead && !focusInRows ? focusParam : undefined,
  );
  const focusedSenderData = focusedSenderQuery.data ?? null;
  const focusTarget = focusParam
    ? displaySenders.find((row) => row.id === focusParam) ?? focusedSenderData
    : null;

  async function refetchSenderForReadback(
    senderId: string,
    validate?: (row: SenderRow) => boolean,
  ): Promise<SenderRow> {
    const [sendersResult, summaryResult] = await Promise.all([
      sendersQuery.refetch(),
      summaryQuery.refetch(),
      clientsQuery.refetch(),
    ]);
    const summaryRow = summaryResult.data?.rows.find((row) => row.sender_id === senderId);
    const refreshed = summaryRow
      ? senderRowFromSummary(summaryRow)
      : sendersResult.data?.rows.find((row) => row.id === senderId);
    if (!refreshed || (validate && !validate(refreshed))) {
      throw new Error(t('senders.error.readback'));
    }
    return refreshed;
  }

  function senderFieldMatches(key: string, expected: unknown) {
    return (row: SenderRow) => {
      const actual = row[key];
      if (expected == null || expected === '') return actual == null || actual === '';
      return String(actual) === String(expected);
    };
  }

  function openNewSender() {
    function NewSenderForm() {
      const clientGap = noClientsVisible;
      const [draft, setDraft] = useState<NewSenderDraft>({
        client_id: clients[0]?.id ?? '',
        name: '',
        brand_name: '',
      });
      const [formError, setFormError] = useState<string>('');
      function surfaceFormError(message: string, tone: 'warn' | 'danger' = 'danger') {
        setFormError(message);
        pushToast(message, tone);
      }
      return (
        <div>
          {clientGap ? (
            <StateView kind="error" hint={t('senders.error.noClients')} />
          ) : null}
          {formError ? (
            <StateView kind="error" hint={formError} />
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
            <label className="mono" htmlFor="new-sender-client">{t('customers.field.client')}</label>
            <select
              id="new-sender-client"
              className="dt-inline-input"
              value={draft.client_id}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, client_id: e.target.value }));
              }}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.slug ? ` · ${c.slug}` : ''}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor="new-sender-name">{t('customers.field.name')}</label>
            <input
              id="new-sender-name"
              className="dt-inline-input"
              placeholder={t('senders.namePlaceholder')}
              value={draft.name}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, name: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="new-sender-brand">{t('customers.field.brand')}</label>
            <input
              id="new-sender-brand"
              className="dt-inline-input"
              placeholder={t('senders.brandPlaceholder')}
              value={draft.brand_name}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, brand_name: e.target.value }));
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('common.create')}
              kind="primary"
              capability={WRITE_CAP}
              disabled={clientGap}
              onClick={async () => {
                if (!draft.client_id) {
                  surfaceFormError(t('customers.msg.clientRequired'), 'warn');
                  return;
                }
                if (!draft.name.trim()) {
                  surfaceFormError(t('customers.msg.nameRequired'), 'warn');
                  return;
                }
                try {
                  const res = await createMut.mutateAsync({
                    client_id: draft.client_id,
                    name: draft.name.trim(),
                    brand_name: draft.brand_name.trim() || undefined,
                  });
                  const createdId =
                    typeof res.sender_id === 'string'
                      ? res.sender_id
                      : typeof res.id === 'string'
                        ? res.id
                        : null;
                  if (!createdId) throw new Error(t('senders.error.createNoId'));
                  await refetchSenderForReadback(
                    createdId,
                    (row) =>
                      row.name === draft.name.trim()
                      && row.client_id === draft.client_id
                      && (
                        draft.brand_name.trim()
                          ? row.brand_name === draft.brand_name.trim()
                          : row.brand_name == null || row.brand_name === ''
                      ),
                  );
                  if (createdId) setPendingCreatedSenderId(createdId);
                  modal.close();
                  pushToast(fill(t('senders.created'), { name: draft.name }), 'good');
                } catch (err) {
                  surfaceFormError(formatSenderCreateError(err, t));
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: t('senders.newSender'), body: <NewSenderForm /> });
  }

  function openSuspendSender(s: SenderRow) {
    function SuspendForm() {
      const [draft, setDraft] = useState<SenderSuspendDraft>({ reason: '' });
      return (
        <div>
          <p className="state__hint">
            {t('senders.suspendIntro')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="sender-suspend-reason">{t('customers.field.reason')}</label>
            <input
              id="sender-suspend-reason"
              className="dt-inline-input"
              placeholder={t('senders.reasonPlaceholder')}
              value={draft.reason}
              onChange={(e) => setDraft((cur) => ({ ...cur, reason: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('common.confirm')}
              kind="danger"
              capability={WRITE_CAP}
              onClick={async () => {
                if (!draft.reason.trim()) {
                  pushToast(t('customers.msg.reasonRequired'), 'warn');
                  return;
                }
                try {
                  await suspendMut.mutateAsync({ sender_id: s.id, reason: draft.reason });
                  modal.close();
                  pushToast(fill(t('senders.suspended'), { name: s.name }), 'info');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: fill(t('customers.msg.suspendTitle'), { name: s.name }), body: <SuspendForm /> });
  }

  function senderDrawerSignature(s: SenderRow): string {
    const summary = summaryById.get(s.id);
    return JSON.stringify({
      id: s.id,
      name: s.name,
      brand_name: s.brand_name ?? null,
      client_id: s.client_id ?? null,
      status: s.status ?? null,
      auto_provisioned: s.auto_provisioned ?? null,
      auto_recreate: s.auto_recreate ?? null,
      suspension_reason: s.suspension_reason ?? null,
      settings_override: s.settings_override ?? null,
      summary_client_label: summary?.client_label ?? null,
      summary_client_slug: summary?.client_slug ?? null,
      summary_active_shipments: summary?.active_shipments ?? null,
      summary_total_shipments: summary?.total_shipments ?? null,
      summary_sla_tier: summary?.sla_tier_inherited ?? null,
      summary_has_warehouse: summary?.has_warehouse ?? null,
      related_shipments: openSenderShipmentSignature,
    });
  }

  function openSenderDrawer(s: SenderRow, options?: { track?: boolean }) {
    if (options?.track !== false) {
      setOpenSenderId(s.id);
    }
    openSenderSignatureRef.current = senderDrawerSignature(s);
    const client = clientById.get(s.client_id);
    const summary = summaryById.get(s.id);
    const kvRows: KvRow[] = [
      { key: 'name', label: t('customers.field.name'), value: s.name, capability: WRITE_CAP },
      { key: 'brand_name', label: t('customers.field.brand'), value: s.brand_name ?? '—', capability: WRITE_CAP },
      {
        key: 'client_id',
        label: t('customers.field.client'),
        // W21: prefer canonical projection client_label when present, fall
        // back to in-memory clientById join for legacy demo paths.
        value: summary?.client_label
          ? `${summary.client_label}${summary.client_slug ? ` · ${summary.client_slug}` : ''}`
          : (client ? `${client.name}${client.slug ? ` · ${client.slug}` : ''}` : s.client_id),
        mono: true,
        editable: false,
      },
      { key: 'status', label: t('customers.field.status'), value: s.status, lookup: 'sender_status', editable: false },
      { key: 'suspension_reason', label: t('customers.field.suspensionReason'), value: s.suspension_reason ?? '—', editable: false },
      { key: 'auto_provisioned', label: t('senders.autoProvisioned'), value: s.auto_provisioned ? t('common.yes') : t('common.no'), editable: false },
      { key: 'auto_recreate', label: t('senders.autoRecreate'), value: s.auto_recreate ? t('common.yes') : t('common.no'), editable: false },
    ];

    drawer.open({
      title: s.name,
      size: 'md',
      deepLink: `/customers/senders?focus=${s.id}`,
      onClose: () => {
        setOpenSenderId(null);
        openSenderSignatureRef.current = null;
      },
      body: (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            {s.auto_provisioned ? <Chip label={t('senders.chip.autoProvisioned')} kind="neutral" size="xs" /> : null}
            {rank != null ? <Chip label={fill(t('senders.chip.scopePriority'), { rank })} kind="info" size="xs" /> : null}
            {summary ? (
              <>
                <Chip
                  label={fill(t('customers.msg.shipmentsChip'), { active: summary.active_shipments ?? 0, total: summary.total_shipments ?? 0 })}
                  kind="info"
                  size="xs"
                />
                {summary.sla_tier_inherited ? (
                  <Chip
                    label={fill(t('senders.chip.sla'), { tier: summary.sla_tier_inherited })}
                    kind="neutral"
                    size="xs"
                  />
                ) : null}
                {summary.has_warehouse ? (
                  <Chip label={t('senders.chip.warehouseOverride')} kind="neutral" size="xs" />
                ) : null}
              </>
            ) : null}
          </div>
          <KvGrid
            rows={kvRows}
            onEdit={async (key, value) => {
              if (key === 'status') {
                pushToast(t('senders.statusUseActions'), 'warn');
                return;
              }
              try {
                await updateMut.mutateAsync({
                  sender_id: s.id,
                  [key]: value,
                } as { sender_id: string } & Record<string, unknown>);
                await refetchSenderForReadback(s.id, senderFieldMatches(key, value));
                pushToast(fill(t('customers.msg.saved'), { field: senderFieldLabel(key, t) }), 'good');
              } catch (err) {
                pushToast((err as Error).message, 'danger');
              }
            }}
          />

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('senders.settings')}</div>
          <KvGrid rows={objectSummaryRows(s.settings_override, 'sender-setting', t)} />

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('customers.section.relatedShipments')}</div>
          <div style={{ padding: '0 14px' }}>
            <RelatedShipmentsPanel
              canReadShipments={canReadShipments}
              error={openSenderShipmentsQuery.error}
              isLoading={openSenderShipmentsQuery.isLoading}
              rows={openSenderShipments}
              scopeLabel={t('customers.related.scopeSender')}
              onOpenShipment={(shipment) => openShipmentContextDrawer(drawer, shipment.id, {
                fallbackShipment: {
                  id: shipment.id,
                  tracking_number: shipment.tracking_number ?? shipment.id,
                  client_reference_number: shipment.client_reference_number ?? undefined,
                  status: shipment.status ?? undefined,
                  service_type: shipment.service_type ?? undefined,
                  destination_city: shipment.destination_city ?? undefined,
                  promised_delivery_date: shipment.promised_delivery_date ?? undefined,
                },
                deepLink: false,
              })}
            />
          </div>

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('customers.section.quickLinks')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 14px' }}>
            <Button label={t('senders.shipmentsFromSender')} iconName="package" kind="ghost" onClick={() => go(`/operate/shipments?sender=${s.id}`)} />
            {client ? (
              <Button label={t('customers.action.openClient')} iconName="building" kind="ghost" onClick={() => go(`/customers/clients?focus=${client.id}`)} />
            ) : null}
          </div>

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('customers.section.operationalControls')}</div>
          <div className="card mono" style={{ fontSize: 11, lineHeight: 1.6, padding: 10 }}>
            <SeamLine k={t('customers.seam.directory')} v={t('senders.seam.directory')} />
            <SeamLine k={t('senders.seam.webhookIntake')} v={t('senders.seam.webhookResolver')} />
            <SeamLine k={t('senders.seam.overridePriority')} v={rank != null ? fill(t('senders.seam.scopePriority'), { rank }) : t('senders.seam.scope')} />
          </div>
        </div>
      ),
    });
  }

  useEffect(() => {
    if (!focusParam) {
      openedFocusRef.current = null;
      return undefined;
    }
    if (openedFocusRef.current === focusParam) return undefined;
    if (!focusTarget) return undefined;
    const timer = window.setTimeout(() => {
      openSenderDrawer(focusTarget);
      openedFocusRef.current = focusParam;
    }, 100);
    return () => window.clearTimeout(timer);
    // openSenderDrawer closes over drawer/query state; focus target is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, focusTarget]);

  useEffect(() => {
    if (!drawer.isOpen || !openSenderId) return;
    const refreshed =
      displaySenders.find((row) => row.id === openSenderId)
      ?? (focusedSenderData?.id === openSenderId ? focusedSenderData : null);
    if (!refreshed) return;
    const nextSignature = senderDrawerSignature(refreshed);
    if (openSenderSignatureRef.current === nextSignature) return;
    openSenderSignatureRef.current = nextSignature;
    openSenderDrawer(refreshed, { track: false });
    // openSenderDrawer rebuilds the current drawer from backend-refreshed state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer.isOpen, openSenderId, displaySenders, focusedSenderData, summaryById, openSenderShipmentSignature]);

  useEffect(() => {
    if (!pendingCreatedSenderId) return;
    const created = displaySenders.find((row) => row.id === pendingCreatedSenderId);
    if (!created) return;
    openSenderDrawer(created);
    setPendingCreatedSenderId(null);
    // openSenderDrawer opens the backend-read row after create refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreatedSenderId, displaySenders, summaryById]);

  const columns: Array<DataTableColumn<SenderRow>> = [
    { key: 'name', label: t('customers.field.name'), sortable: true, filterable: true },
    {
      key: 'client_label',
      label: t('customers.field.client'),
      sortable: true,
    },
    { key: 'status', label: t('customers.field.status'), sortable: true, filterable: true, lookup: 'sender_status', editable: false },
    { key: 'auto_provisioned', label: t('senders.autoProvisioned'), align: 'right', type: 'boolean', sortable: true, filterable: true },
  ];

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
        <Chip key="cap" label={t('senders.capPill')} kind="info" size="xs" />,
    <span key="seam" className="chip chip--xs mono">
            {rank != null ? fill(t('senders.pillPriority'), { rank }) : t('senders.pill')}
    </span>,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="senders"
          titlePlain={t('senders.titlePlain')}
        />
        <StateView
          kind="denied"
          capability={CAP.SENDERS_READ}
          hint={t('senders.denied')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="senders"
        titlePlain={t('senders.titlePlain')}
        pills={pills}
        actions={[
          <Button
            key="new"
            label={t('senders.newSender')}
            iconName="plus"
            kind="primary"
            capability={WRITE_CAP}
            disabled={noClientsVisible}
            onClick={openNewSender}
          />,
        ]}
      />

      {clientsError ? (
        <StateView
          kind="error"
          title={t('senders.error.clientDirectory')}
          hint={(clientsError as Error).message}
        />
      ) : sendersError && !tenantId ? (
        <StateView
          kind="error"
          title={t('senders.error.directory')}
          hint={(sendersError as Error).message}
        />
      ) : tenantId && summaryError ? (
        <StateView
          kind="error"
          title={t('senders.error.directory')}
          hint={(summaryError as Error).message}
        />
      ) : sendersLoading || (tenantId && summaryLoading) ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<SenderRow>
          columns={columns}
          rows={displaySenders}
          viewKey="senders"
          entityKind="sender"
          onRowClick={openSenderDrawer}
          rowDeepLink={(s) => `/customers/senders?focus=${s.id}`}
          onCellEdit={async (row, key, val) => {
            if (key === 'status') {
              return {
                ok: false,
                error: t('senders.statusUseActions'),
              };
            }
            try {
              await updateMut.mutateAsync({
                sender_id: row.id,
                [key]: val,
              } as { sender_id: string } & Record<string, unknown>);
              await refetchSenderForReadback(row.id, senderFieldMatches(key, val));
              return { ok: true };
            } catch (err) {
              return { ok: false, error: (err as Error).message };
            }
          }}
          rowActions={[
            { label: t('customers.action.openDetail'), icon: 'eye', kind: 'primary', onClick: openSenderDrawer },
            { label: t('customers.action.openClient'), icon: 'building', onClick: (s) => go(`/customers/clients?focus=${s.client_id}`) },
            { label: t('customers.action.viewShipments'), icon: 'package', onClick: (s) => go(`/operate/shipments?sender=${s.id}`) },
            {
              label: t('customers.action.reactivate'),
              icon: 'refresh',
              capability: WRITE_CAP,
              disabled: (s) => !canReactivateSender(s),
              disabledReason: t('senders.onlySuspended'),
              onClick: async (s) => {
                try {
                  await reactivateMut.mutateAsync({ sender_id: s.id });
                  pushToast(fill(t('customers.msg.reactivated'), { name: s.name }), 'good');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              },
            },
            {
              label: t('customers.action.suspend'),
              icon: 'lock',
              kind: 'danger',
              capability: WRITE_CAP,
              disabled: (s) => !canSuspendSender(s),
              disabledReason: t('senders.onlyActive'),
              onClick: openSuspendSender,
            },
          ]}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

interface SeamLineProps { k: string; v: string }
function SeamLine({ k, v }: SeamLineProps) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--ink-3)', minWidth: 140, fontSize: 10.5 }}>{k}</span>
      <span>{v}</span>
    </div>
  );
}

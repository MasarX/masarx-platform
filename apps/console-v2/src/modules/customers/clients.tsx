// clients.tsx — Operator-managed customer accounts (public.clients).
//
// Backend SSOT
//   • Table: public.clients (supabase/migrations/202510110002_configuration_core.sql, lines 66-97)
//   • RLS:   public.clients_select|insert|update|delete (202601022114_access_control_rls.sql, lines 91-159)
//            + RBAC capability gates (clients.read / clients.write) per
//              202601300360_rbac_clients_senders_write_gates_v1.sql.
//   • Status enum: lookup category `client_status` (active|suspended|terminated).
//                  Migration: 202601202320_lookup_column_contracts_and_enforcement.sql lines 78-80.
//   • SLA tier:    lookup category `sla_tier` (economy|standard|premium). Same migration, lines 170-172.
//
// Surface contract
//   • DataTable + drawer + modal — all overlays are local to this module via useDrawer/useModal.
//   • Capability gating uses the canonical capability strings (`clients.write`) so role gates are real;
//     the previous `customers.write` was not in registry.capabilities and silently locked all roles.
//   • Status changes funnel through explicit row actions: "Suspend" captures
//     `suspension_reason`, while "Reactivate" clears it through the canonical lifecycle RPC.
//   • Drawer surfaces every backed column we have today: name/code/slug/sla_tier/status,
//     account_manager_id, contract_start_date, contract_end_date, suspension_reason, settings_override.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { useResource, useResourceList, useSuspendClient, useReactivateClient, useClientCreate, useClientUpdate } from '@/lib/queries';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { getLookups, lookupRow } from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';

// Phase G1 schema-drift fix: dropped fictional `code` column. Canonical key is
// `slug` (public.clients has no `code`). All references below were migrated to
// consume `slug` directly. See __audit__/SCHEMA-DRIFT/CUSTOMERS.md §1.
interface ClientRow extends Record<string, unknown> {
  id: string;
  organization_id?: string;
  name: string;
  slug?: string;
  sla_tier: string;
  status: string;
  account_manager_id?: string | null;
  contract_start_date?: string | null;
  contract_end_date?: string | null;
  suspension_reason?: string | null;
  settings_override?: Record<string, unknown> | null;
}

// W21: paired projection view `public.v_client_summary` (read-only).
// Mirrors the SQL view shape — additive context for the operator drawer
// (counters + derived booleans). No FE-only invented fields; every column
// has a canonical source. SSOT remains public.clients via the registry
// seam. See supabase/migrations/202604302000_v_client_summary.sql.
interface ClientSummaryRow extends Record<string, unknown> {
  client_id: string;
  sender_count?: number;
  recipient_count?: number;
  active_shipments?: number;
  total_shipments?: number;
  last_shipment_at?: string | null;
  contract_active?: boolean;
  has_warehouse?: boolean;
}

interface NewClientDraft {
  name: string;
  slug: string;
  sla_tier: string;
}

interface SuspendDraft {
  reason: string;
}

// AGENTS.md §4 (SSOT): canonical key sourced from src/lib/capabilities.ts;
// the literal string `'clients.write'` is no longer hardcoded at module scope.
const WRITE_CAP = CAP.CLIENTS_WRITE;

function statusLookup() {
  return (getLookups('client_status') ?? []) as Array<{ value: string; label: string; tone?: string; is_default?: boolean }>;
}

function slaLookup() {
  return (getLookups('sla_tier') ?? []) as Array<{ value: string; label: string; tone?: string; is_default?: boolean }>;
}

// W26+ no-fallback: derive defaults strictly from canonical seed rows flagged
// `is_default: true` (lookup_values.metadata.is_default — see
// src/lib/seed-raw/lookups.js + paired migration 202605020100). Returns null
// when the seed is missing the canonical default row, surfacing the gap
// instead of silently masking it with a hardcoded literal.
function defaultSla(): string | null {
  return slaLookup().find((s) => s.is_default)?.value ?? null;
}

// W66-Catalog+Customers closure: derive the initial suspended-status value
// row-driven via `lookupRow('client_status', value)?.metadata?.lifecycle`
// instead of the previous order-dependent heuristic ("first lookup row whose
// value differs from active"). Mirrors `defaultOfferingStatusForLifecycle`
// in catalog/service-offerings.tsx — picks the canonical row carrying
// `metadata.lifecycle === 'suspended'`. Returns null when no row carries the
// canonical token so the surface fails loud (no silent default lifecycle).
// AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
function defaultClientStatusForLifecycle(lifecycle: string): string | null {
  for (const row of statusLookup()) {
    const meta = lookupRow('client_status', row.value)?.metadata as
      | { lifecycle?: string }
      | undefined;
    if (meta?.lifecycle === lifecycle) return row.value;
  }
  return null;
}

function defaultSuspendedStatus(): string | null {
  return defaultClientStatusForLifecycle('suspended');
}

function clientLifecycle(status: string | null | undefined): string | null {
  const meta = status
    ? lookupRow('client_status', status)?.metadata as { lifecycle?: string } | undefined
    : undefined;
  return meta?.lifecycle ?? null;
}

function canSuspendClient(row: ClientRow): boolean {
  return clientLifecycle(row.status) === 'active';
}

function canReactivateClient(row: ClientRow): boolean {
  return clientLifecycle(row.status) === 'suspended';
}

function formatDate(value: unknown): string {
  if (!value) return '—';
  return String(value);
}

function humanizeSettingKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatSummaryValue(value: unknown): string {
  if (value == null || value === '') return 'Not configured';
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `${count} nested setting${count === 1 ? '' : 's'}`;
  }
  return String(value);
}

function clientMutationErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const message = raw.trim();
  const lower = message.toLowerCase();
  if (
    lower.includes('clients_organization_id_slug_key')
    || (lower.includes('duplicate key') && lower.includes('slug'))
    || (lower.includes('slug') && lower.includes('already'))
  ) {
    return 'A client with this slug already exists for the selected tenant.';
  }
  if (lower.includes('duplicate key')) {
    return 'A client with these unique details already exists. Search the client list or use different values.';
  }
  return message || 'Client action failed. Try again or check the client details.';
}

function objectSummaryRows(value: Record<string, unknown> | null | undefined, prefix: string): KvRow[] {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0) {
    return [{ key: `${prefix}-empty`, label: 'Status', value: 'No custom settings configured', editable: false }];
  }
  return entries.map(([key, val]) => ({
    key: `${prefix}-${key}`,
    label: humanizeSettingKey(key),
    value: formatSummaryValue(val),
    editable: false,
  }));
}

export function ClientsModule() {
  const { scope, currentTenantId } = useIdentity();
  const drawer = useDrawer();
  const modal = useModal();
  const go = useConsoleNavigator();
  const canRead = useCapability(CAP.CLIENTS_READ);
  // W56-A closure: FE capability gate for inline cell edits + drawer KvGrid
  // edits. Backend RLS still enforces `clients.write`; the FE check keeps the
  // surface consistent so users without write capability cannot trigger an
  // RLS-rejected mutation from the surface.
  const canWrite = useCapability(CAP.CLIENTS_WRITE);
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);

  const clientsQuery = useResourceList<ClientRow>('clients', tenantListOpts, readQueryOptions);
  // W21: consume canonical paired projection for derived context (sender/recipient
  // counts, active shipments, contract_active flag) on the operator drawer.
  const summaryQuery = useResourceList<ClientSummaryRow>('client_summary', tenantListOpts, readQueryOptions);
  const suspendMut = useSuspendClient();
  const reactivateMut = useReactivateClient();
  const createMut = useClientCreate();
  const updateMut = useClientUpdate();
  const openedFocusRef = useRef<string | null>(null);
  const [openClientId, setOpenClientId] = useState<string | null>(null);
  const [pendingCreatedClientId, setPendingCreatedClientId] = useState<string | null>(null);
  const openClientSignatureRef = useRef<string | null>(null);

  const { data, isLoading, error: clientsError } = clientsQuery;
  const { data: summaryData, error: summaryError } = summaryQuery;

  const summaryById = useMemo(
    () => new Map<string, ClientSummaryRow>((summaryData?.rows ?? []).map((s) => [s.client_id, s])),
    [summaryData],
  );

  const rows: ClientRow[] = data?.rows ?? [];
  const focusParam = readUrlParam('focus');
  const focusInRows = focusParam ? rows.some((row) => row.id === focusParam) : false;
  const focusedClientQuery = useResource<ClientRow>(
    'clients',
    focusParam && canRead && !focusInRows ? focusParam : undefined,
  );
  const focusedClientData = focusedClientQuery.data ?? null;
  const focusedClientAllowed =
    focusedClientData != null && (!tenantId || focusedClientData.organization_id === tenantId);
  const focusedClient = focusedClientAllowed && focusedClientData ? focusedClientData : null;
  const focusTarget = focusParam
    ? rows.find((row) => row.id === focusParam) ?? focusedClient
    : null;

  async function refetchClientForReadback(
    clientId: string,
    validate?: (row: ClientRow) => boolean,
  ): Promise<ClientRow> {
    const [clientResult] = await Promise.all([
      clientsQuery.refetch(),
      summaryQuery.refetch(),
    ]);
    const refreshed = clientResult.data?.rows.find((row) => row.id === clientId);
    if (!refreshed || (validate && !validate(refreshed))) {
      throw new Error('The updated client was not available yet.');
    }
    return refreshed;
  }

  function clientFieldMatches(key: string, expected: unknown) {
    return (row: ClientRow) => {
      const actual = row[key];
      if (expected == null || expected === '') return actual == null || actual === '';
      return String(actual) === String(expected);
    };
  }

  function clientDrawerSignature(r: ClientRow): string {
    const summary = summaryById.get(r.id);
    return JSON.stringify({
      id: r.id,
      name: r.name,
      slug: r.slug ?? null,
      status: r.status ?? null,
      sla_tier: r.sla_tier ?? null,
      suspension_reason: r.suspension_reason ?? null,
      account_manager_id: r.account_manager_id ?? null,
      contract_start_date: r.contract_start_date ?? null,
      contract_end_date: r.contract_end_date ?? null,
      settings_override: r.settings_override ?? null,
      summary_sender_count: summary?.sender_count ?? null,
      summary_recipient_count: summary?.recipient_count ?? null,
      summary_active_shipments: summary?.active_shipments ?? null,
      summary_total_shipments: summary?.total_shipments ?? null,
      summary_contract_active: summary?.contract_active ?? null,
      summary_has_warehouse: summary?.has_warehouse ?? null,
    });
  }

  function openClientDrawer(r: ClientRow, options?: { track?: boolean }) {
    if (options?.track !== false) {
      setOpenClientId(r.id);
    }
    openClientSignatureRef.current = clientDrawerSignature(r);
    const summary = summaryById.get(r.id);
    const kvRows: KvRow[] = [
      { key: 'name', label: 'Name', value: r.name, capability: WRITE_CAP },
      {
        key: 'slug',
        label: 'Slug',
        value: r.slug ?? '—',
        mono: true,
        editable: false,
      },
      { key: 'sla_tier', label: 'SLA tier', value: r.sla_tier, lookup: 'sla_tier', capability: WRITE_CAP },
      { key: 'status', label: 'Status', value: r.status, lookup: 'client_status', editable: false },
      {
        key: 'suspension_reason',
        label: 'Suspension reason',
        value: r.suspension_reason ?? '—',
        editable: false,
      },
      {
        key: 'account_manager_id',
        label: 'Account manager',
        value: r.account_manager_id ? 'Assigned account manager' : 'Unassigned',
        editable: false,
      },
      { key: 'contract_start_date', label: 'Contract start', value: formatDate(r.contract_start_date), mono: true, editable: false },
      { key: 'contract_end_date', label: 'Contract end', value: formatDate(r.contract_end_date), mono: true, editable: false },
    ];

    drawer.open({
      title: r.name,
      size: 'lg',
      deepLink: `/customers/clients?focus=${r.id}`,
      onClose: () => {
        setOpenClientId(null);
        openClientSignatureRef.current = null;
      },
      body: (
        <div>
          {summary ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              <Chip
                label={`${summary.sender_count ?? 0} senders`}
                kind="neutral"
                size="xs"
              />
              <Chip
                label={`${summary.recipient_count ?? 0} recipients`}
                kind="neutral"
                size="xs"
              />
              <Chip
                label={`${summary.active_shipments ?? 0} active · ${summary.total_shipments ?? 0} total shipments`}
                kind="info"
                size="xs"
              />
              {summary.contract_active === false ? (
                <Chip label="contract inactive" kind="warn" size="xs" />
              ) : null}
              {summary.has_warehouse ? (
                <Chip label="default warehouse" kind="neutral" size="xs" />
              ) : null}
            </div>
          ) : null}
          <KvGrid
            rows={kvRows}
            onEdit={async (key, value) => {
              try {
                if (key === 'status') {
                  pushToast(
                    'Use Reactivate or Suspend so the client status change has a real audit reason.',
                    'warn',
                  );
                  return;
                }
                await updateMut.mutateAsync({
                  client_id: r.id,
                  [key]: value,
                } as { client_id: string } & Record<string, unknown>);
                await refetchClientForReadback(r.id, clientFieldMatches(key, value));
                pushToast(`Saved · ${key}`, 'good');
              } catch (err) {
                pushToast(clientMutationErrorMessage(err), 'danger');
              }
            }}
          />

          <div className="section-eyebrow" style={{ marginTop: 12 }}>Client settings</div>
          <KvGrid rows={objectSummaryRows(r.settings_override, 'client-setting')} />

          <div className="section-eyebrow" style={{ marginTop: 12 }}>Quick links</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '0 14px' }}>
            <Button label="Shipments" iconName="package" kind="ghost" onClick={() => go(`/operate/shipments?client=${r.id}`)} />
            <Button label="Senders" iconName="right" kind="ghost" onClick={() => go(`/customers/senders?client=${r.id}`)} />
            <Button label="Recipients" iconName="user_in" kind="ghost" onClick={() => go(`/customers/recipients?client=${r.id}`)} />
            <Button label="Settlements" iconName="wallet" kind="ghost" onClick={() => go(`/finance/settlements?client=${r.id}`)} />
            <Button label="Disputes" iconName="alert" kind="ghost" onClick={() => go(`/finance/disputes?client=${r.id}`)} />
            <Button label="Ledger" iconName="file" kind="ghost" onClick={() => go(`/finance/ledger?client=${r.id}`)} />
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
      openClientDrawer(focusTarget);
      openedFocusRef.current = focusParam;
    }, 100);
    return () => window.clearTimeout(timer);
    // openClientDrawer closes over drawer/query state; focus target is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, focusTarget]);

  useEffect(() => {
    if (!drawer.isOpen || !openClientId) return;
    const refreshed =
      rows.find((row) => row.id === openClientId)
      ?? (focusedClient?.id === openClientId ? focusedClient : null);
    if (!refreshed) return;
    const nextSignature = clientDrawerSignature(refreshed);
    if (openClientSignatureRef.current === nextSignature) return;
    openClientSignatureRef.current = nextSignature;
    openClientDrawer(refreshed, { track: false });
    // openClientDrawer rebuilds the current drawer from backend-refreshed state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer.isOpen, openClientId, rows, focusedClient, summaryById]);

  useEffect(() => {
    if (!pendingCreatedClientId) return;
    const created = rows.find((row) => row.id === pendingCreatedClientId);
    if (!created) return;
    openClientDrawer(created);
    setPendingCreatedClientId(null);
    // openClientDrawer opens the backend-read row after create refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreatedClientId, rows, summaryById]);

  function openNewClient() {
    function NewClientForm() {
      // W26+ no-fallback: seed gap (no `is_default` row) is surfaced explicitly
      // via a StateView error instead of masking it with a hardcoded literal.
      // Form draft starts with empty string so the operator must pick a value
      // from the canonical lookup.
      const sla = defaultSla();
      const [draft, setDraft] = useState<NewClientDraft>({
        name: '',
        slug: '',
        sla_tier: sla ?? '',
      });
      const [formError, setFormError] = useState<string>('');
      function surfaceFormError(message: string, tone: 'warn' | 'danger' = 'danger') {
        setFormError(message);
        pushToast(message, tone);
      }
      return (
        <div>
          {sla === null ? (
            <StateView
              kind="error"
              hint="Default SLA tier is missing. Pick a value below."
            />
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
            <label className="mono" htmlFor="new-client-name">Name</label>
            <input
              id="new-client-name"
              className="dt-inline-input"
              placeholder="e.g. Riyadh Express LLC"
              value={draft.name}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, name: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="new-client-slug">Slug</label>
            <input
              id="new-client-slug"
              className="dt-inline-input"
              placeholder="e.g. riyadh-express"
              value={draft.slug}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, slug: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="new-client-sla">SLA tier</label>
            <select
              id="new-client-sla"
              className="dt-inline-input"
              value={draft.sla_tier}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, sla_tier: e.target.value }));
              }}
            >
              {slaLookup().map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Create"
              kind="primary"
              capability={WRITE_CAP}
              onClick={async () => {
                if (!draft.name.trim()) {
                  surfaceFormError('Name is required', 'warn');
                  return;
                }
                if (!draft.slug.trim()) {
                  surfaceFormError('Slug is required', 'warn');
                  return;
                }
                try {
                  const res = await createMut.mutateAsync({
                    name: draft.name.trim(),
                    slug: draft.slug.trim().toLowerCase(),
                    sla_tier: draft.sla_tier,
                    ...(tenantId ? { organization_id: tenantId } : {}),
                  });
                  const createdId =
                    typeof res.client_id === 'string'
                      ? res.client_id
                      : typeof res.id === 'string'
                        ? res.id
                        : null;
                  if (!createdId) throw new Error('Client create did not return a client id.');
                  await refetchClientForReadback(
                    createdId,
                    (row) =>
                      row.name === draft.name.trim()
                      && row.slug === draft.slug.trim().toLowerCase()
                      && row.sla_tier === draft.sla_tier,
                  );
                  if (createdId) setPendingCreatedClientId(createdId);
                  modal.close();
                  pushToast(`Client created · ${draft.name}`, 'good');
                } catch (err) {
                  surfaceFormError(clientMutationErrorMessage(err));
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: 'New client', body: <NewClientForm /> });
  }

  function openSuspendClient(r: ClientRow) {
    function SuspendForm() {
      // W66-Catalog+Customers closure: derive the initial suspended target via
      // canonical `client_status.metadata.lifecycle === 'suspended'` row instead
      // of the order-dependent heuristic ("first row whose value differs from
      // active"). This makes the resolver robust against seed reordering /
      // additional active-equivalent rows. Mirrors the
      // `defaultOfferingStatusForLifecycle('terminal')` pattern in
      // catalog/service-offerings.tsx. AGENTS.md §2 + §6.
      const suspendedStatus = defaultSuspendedStatus();
      const [draft, setDraft] = useState<SuspendDraft>({ reason: '' });
      if (suspendedStatus == null) {
        return (
          <div>
            <StateView
              kind="error"
              title="Suspended client status is missing"
              hint="Configure the suspended client status before suspending clients."
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <Button label="Close" kind="ghost" onClick={() => modal.close()} />
            </div>
          </div>
        );
      }
      return (
        <div>
          <p className="state__hint">
            Suspending pauses the client account and records the required suspension reason.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <span className="mono">New status</span>
            <Chip label={lookupRow('client_status', suspendedStatus)?.label ?? suspendedStatus} kind="warn" size="xs" />
            <label className="mono" htmlFor="suspend-reason">Reason</label>
            <input
              id="suspend-reason"
              className="dt-inline-input"
              placeholder="e.g. Outstanding balance > 30 days"
              value={draft.reason}
              onChange={(e) => setDraft((s) => ({ ...s, reason: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Confirm"
              kind="danger"
              capability={WRITE_CAP}
              onClick={async () => {
                if (!draft.reason.trim()) {
                  pushToast('Reason is required', 'warn');
                  return;
                }
                try {
                  await suspendMut.mutateAsync({ client_id: r.id, reason: draft.reason });
                  modal.close();
                  pushToast(`Client suspended - ${r.name}`, 'info');
                } catch (err) {
                  pushToast(clientMutationErrorMessage(err), 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: `Suspend · ${r.name}`, body: <SuspendForm /> });
  }

  const columns: Array<DataTableColumn<ClientRow>> = [
    { key: 'name', label: 'Name', sortable: true, filterable: true },
    { key: 'slug', label: 'Slug', mono: true, sortable: true, filterable: true },
    // W56-A closure: inline editable columns gate on `canWrite` so users
    // without `clients.write` cannot trigger an RLS-rejected mutation from
    // the surface (FE parity with backend RBAC; reads stay unaffected).
    { key: 'sla_tier', label: 'SLA tier', sortable: true, filterable: true, lookup: 'sla_tier', editable: canWrite },
    { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'client_status', editable: false },
    {
      key: 'contract_end_date',
      label: 'Contract end',
      sortable: true,
      mono: true,
      render: (raw) => (raw ? <span className="mono">{String(raw)}</span> : <span style={{ color: 'var(--ink-3)' }}>open</span>),
    },
  ];

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
        <Chip key="cap" label="Client access · client update" kind="info" size="xs" />,
        <span key="seam" className="chip chip--xs mono">Client registry · status · SLA tier</span>,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="clients"
          eyebrow="Customers"
          titleAccent="Clients"
          titlePlain="— operator-managed customer accounts"
        />
        <StateView
          kind="denied"
          capability={CAP.CLIENTS_READ}
          hint="You do not have permission to view clients."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="clients"
        eyebrow="Customers"
        titleAccent="Clients"
        titlePlain="— operator-managed customer accounts"
        pills={pills}
        actions={[
          <Button
            key="new"
            label="New client"
            iconName="plus"
            kind="primary"
            capability={WRITE_CAP}
            onClick={openNewClient}
          />,
        ]}
      />

      {clientsError ? (
        <StateView
          kind="error"
          title="Client directory unavailable"
          hint={(clientsError as Error).message}
        />
      ) : summaryError ? (
        <StateView
          kind="error"
          title="Client summary unavailable"
          hint={(summaryError as Error).message}
        />
      ) : isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<ClientRow>
          columns={columns}
          rows={rows}
          viewKey="clients"
          entityKind="client"
          onRowClick={openClientDrawer}
          rowDeepLink={(r) => `/customers/clients?focus=${r.id}`}
          onCellEdit={async (row, key, val) => {
            // Block writes to enum columns that are not in the canonical lookup so we never persist
            // values like "disabled" that violate the client_status contract.
            if (key === 'status') {
              return {
                ok: false,
                error:
                  'Use Reactivate or Suspend so the client status change has a real audit reason.',
              };
            }
            if (key === 'sla_tier') {
              const allowed = slaLookup().map((s) => s.value);
              if (!allowed.includes(String(val))) {
                return { ok: false, error: `Invalid SLA tier — pick one of ${allowed.join(', ')}` };
              }
            }
            // All other editable fields go through client_update_v1 (Wave 6).
            try {
              await updateMut.mutateAsync({
                client_id: row.id,
                [key]: val,
              } as { client_id: string } & Record<string, unknown>);
              await refetchClientForReadback(row.id, clientFieldMatches(key, val));
              return { ok: true };
            } catch (err) {
              return { ok: false, error: clientMutationErrorMessage(err) };
            }
          }}
          rowActions={[
            { label: 'Open detail', icon: 'eye', kind: 'primary', onClick: openClientDrawer },
            { label: 'View shipments', icon: 'package', onClick: (r) => go(`/operate/shipments?client=${r.id}`) },
            { label: 'View senders', icon: 'right', onClick: (r) => go(`/customers/senders?client=${r.id}`) },
            { label: 'View recipients', icon: 'user_in', onClick: (r) => go(`/customers/recipients?client=${r.id}`) },
            { label: 'View settlements', icon: 'wallet', onClick: (r) => go(`/finance/settlements?client=${r.id}`) },
            { label: 'View disputes', icon: 'alert', onClick: (r) => go(`/finance/disputes?client=${r.id}`) },
            { label: 'View ledger', icon: 'file', onClick: (r) => go(`/finance/ledger?client=${r.id}`) },
            {
              label: 'Reactivate',
              icon: 'refresh',
              capability: WRITE_CAP,
              disabled: (r) => !canReactivateClient(r),
              disabledReason: 'Only suspended clients can be reactivated.',
              onClick: async (r) => {
                try {
                  await reactivateMut.mutateAsync({ client_id: r.id });
                  pushToast(`Reactivated ${r.name}`, 'good');
                } catch (err) {
                  pushToast(clientMutationErrorMessage(err), 'danger');
                }
              },
            },
            {
              label: 'Suspend',
              icon: 'lock',
              kind: 'danger',
              capability: WRITE_CAP,
              disabled: (r) => !canSuspendClient(r),
              disabledReason: 'Only active clients can be suspended.',
              onClick: openSuspendClient,
            },
          ]}
          // W35e-1: removed the "Bulk SLA tier" pushToast-only orphan. There is
          // no canonical bulk-SLA RPC (`bulk_set_sla_tier_v1` /
          // `propose_settings_change_v1` do not exist in supabase/migrations/);
          // the only canonical mutation that touches `clients.sla_tier` is the
          // per-row `client_update_v1` (`supabase/migrations/202604301010_client_update_v1.sql`).
          // Per AGENTS.md "no defensive backwards-compat shims for hypothetical
          // future requirements", absent-affordance is the correct surface
          // when no canonical RPC backs the action. Closes REAUDIT3
          // CUSTOMERS.md P1-1.
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

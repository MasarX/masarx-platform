// recipients.tsx — Operator-managed recipient contacts (public.recipients).
//
// Backend SSOT
//   • Table: public.recipients (supabase/migrations/202510110006_domain_tables_partitioned.sql, lines 15-46)
//   • RLS:   public.recipients_select|insert|update|delete (202601022114_access_control_rls.sql, lines 337-416)
//   • Lookups in play:
//       phone_validation_status — column COMMENT (line 44): valid|invalid|unverified|pending
//       communication_channel  — migration 202601202320 lines 82-84
//       preferred_language     — column CHECK (line 34): 'ar' or 'en'
//   • Wave 6 RPC: public.recipient_update_v1 (supabase/migrations/202604301040_recipient_update_v1.sql)
//                 — operator-side correction (NDR triage); distinct from any future portal self-edit.
//
// Scope verdict
//   Recipients stay in Console (operator-managed list/detail). Operator-side correction
//   is now wired through `recipient_update_v1` (Wave 6). Portal-side recipient
//   *self-edit* remains SPLIT to portal per audit verdict
//   (apps/console-v2/__audit__/G/scope-verdict.md and __audit__/CROSSWALK/CUSTOMERS.md §4.3) —
//   it would require new RLS policies for client/sender scope writes that do not yet
//   exist. The console surface now exposes operator NDR-triage edits (phone, language,
//   channel, quiet hours) via a capability-gated drawer; the SPLIT chip is preserved to
//   document that *self-edit* is still future work.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { Chip, type ChipKind } from '@/components/Chip';
import {
  useResourceList,
  useResource,
  useRecipientCreate,
  useRecipientDelete,
  useRecipientUpdate,
  useResolveSettings,
} from '@/lib/queries';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { getLookups, lookupRow } from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';
import { e164PhoneError, isE164PhoneNumber } from '@/lib/phone';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import { RelatedShipmentsPanel, type CustomerRelatedShipmentRow } from './related-shipments';
import { englishT, fill, useT, type Translate } from '@/lib/i18n';

// Phase G1 schema-drift fix: dropped legacy aliases (`phone_e164`, `language`,
// `preferred_channel`) that are not canonical columns. Canonical columns are
// `phone_number`, `preferred_language`, `preferred_comm_channel`. See
// __audit__/SCHEMA-DRIFT/CUSTOMERS.md §4.
interface RecipientRow extends Record<string, unknown> {
  id: string;
  organization_id?: string;
  client_id?: string;
  external_id?: string | null;
  name: string;
  email?: string | null;
  phone_number?: string;
  phone_validation_status?: string | null;
  preferred_language?: string;
  preferred_comm_channel?: string;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  communication_preferences?: Record<string, unknown> | null;
}

// W21: paired projection view `public.v_recipient_directory` (read-only).
// Mirrors the SQL view shape — additive context for the operator drawer
// (client_label, total_shipments, last_shipment_at/status, derived
// booleans). No FE-only invented fields; every column has a canonical
// source. SSOT remains public.recipients via the registry seam.
// See supabase/migrations/202604302020_v_recipient_directory.sql.
interface RecipientDirectoryRow extends Record<string, unknown> {
  recipient_id: string;
  client_label?: string | null;
  client_slug?: string | null;
  total_shipments?: number;
  last_shipment_at?: string | null;
  last_shipment_status?: string | null;
  phone_validated?: boolean;
  has_quiet_hours?: boolean;
}

// Phase G1: dropped fictional `code` field (canonical key is `slug`).
interface ClientRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug?: string;
}

// Wave 6: `recipients.write` is now consumed by the operator-correction drawer
// (recipient_update_v1). The capability remains gated for portal/self-edit
// routes when those land in apps/portal/.
// AGENTS.md §4 (SSOT): canonical key sourced from src/lib/capabilities.ts.
const WRITE_CAP = CAP.RECIPIENTS_WRITE;
const LANGUAGE_LOOKUP_CATEGORY = 'language_code';
const PREFERENCES_JSON_PLACEHOLDER = '{"whatsapp_opt_in": true}'; // i18n-literal-ok technical JSON example

// W54-E closure: NO silent fallback. Returns null when the canonical row is
// missing so the caller can render an explicit `(missing)` danger chip,
// mirroring the strict pattern in service-offerings.tsx#statusTone.
function lookupTone(category: string, value: unknown): ChipKind | null {
  if (value == null) return null;
  return ((lookupRow(category, String(value))?.tone as ChipKind | undefined) ?? null);
}

function lookupLabel(category: string, value: unknown): string {
  return lookupRow(category, String(value))?.label ?? (value == null ? '—' : String(value));
}

// W26+ no-fallback: derive canonical defaults from `is_default: true` rows in
// the seed (lookup_values.metadata.is_default). Returns null when the seed is
// missing the canonical default row, surfacing the gap instead of masking it
// with a hardcoded literal.
function lookupDefault(category: string): string | null {
  const list = (getLookups(category) ?? []) as Array<{ value: string; is_default?: boolean }>;
  return list.find((r) => r.is_default)?.value ?? null;
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
    return [{ key: `${prefix}-empty`, label: t('customers.field.status'), value: t('recipients.noPreferences'), editable: false }];
  }
  return entries.map(([key, val]) => ({
    key: `${prefix}-${key}`,
    label: humanizeSettingKey(key),
    value: formatSummaryValue(val, t),
    editable: false,
  }));
}

function stringifyJsonForTextarea(value: Record<string, unknown> | null | undefined): string {
  if (value == null || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}

function parseOptionalJsonObject(value: string, t: Translate = englishT): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as unknown;
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(t('recipients.error.prefsNotObject'));
  }
  return parsed as Record<string, unknown>;
}

function externalReferenceLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '—';
  return value.trim();
}

function recipientMutationErrorMessage(err: unknown, t: Translate = englishT): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const message = raw.trim();
  const lower = message.toLowerCase();
  if (
    lower.includes('uq_recipients_client_phone_number_normalized')
    || (lower.includes('duplicate key') && lower.includes('phone'))
    || (lower.includes('recipient') && lower.includes('phone') && lower.includes('already'))
  ) {
    return t('recipients.error.duplicatePhone');
  }
  if (lower.includes('duplicate key')) {
    return t('recipients.error.duplicate');
  }
  if (
    lower.includes('recipients_phone_number_e164_chk')
    || lower.includes('e.164')
    || (lower.includes('phone') && lower.includes('format'))
  ) {
    return e164PhoneError();
  }
  return message || t('recipients.error.generic');
}

interface RecipientEditDraft {
  name: string;
  phone_number: string;
  email: string;
  external_id: string;
  preferred_language: string;
  preferred_comm_channel: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  communication_preferences_json: string;
}

interface RecipientCreateDraft {
  client_id: string;
  name: string;
  phone_number: string;
  email: string;
  external_id: string;
  preferred_language: string;
  preferred_comm_channel: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
}

function useRecipientPhonePlaceholder(): string {
  const phoneCountryQuery = useResolveSettings('tenant_phone_country_code');
  const phoneCountryValue = phoneCountryQuery.data?.value as
    | { iso_code?: string; e164_prefix?: string }
    | undefined;
  const e164Prefix = typeof phoneCountryValue?.e164_prefix === 'string'
    ? phoneCountryValue.e164_prefix
    : '';
  return e164Prefix ? `${e164Prefix}5XXXXXXXX` : '+E.164';
}

export function RecipientsModule() {
  const { scope } = useIdentity();
  const t = useT();
  const drawer = useDrawer();
  const modal = useModal();
  const go = useConsoleNavigator();
  const canRead = useCapability(CAP.RECIPIENTS_READ);
  const canReadShipments = useCapability(CAP.SHIPMENTS_READ);
  const tenantId = scope.tenant?.id ?? null;
  const clientParam = readUrlParam('client');
  const focusParam = readUrlParam('focus');
  const openedFocusRef = useRef<string | null>(null);
  const [openRecipientId, setOpenRecipientId] = useState<string | null>(null);
  const [pendingCreatedRecipientId, setPendingCreatedRecipientId] = useState<string | null>(null);
  const openRecipientSignatureRef = useRef<string | null>(null);
  const tenantListOpts = useMemo(
    () => {
      const filter: Record<string, string> = {};
      if (tenantId) filter.organization_id = tenantId;
      if (clientParam) filter.client_id = clientParam;
      return Object.keys(filter).length ? { filter } : undefined;
    },
    [tenantId, clientParam],
  );
  const clientListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const createMut = useRecipientCreate();
  const updateMut = useRecipientUpdate();
  const deleteMut = useRecipientDelete();
  const phonePlaceholder = useRecipientPhonePlaceholder();

  const recipientsQuery = useResourceList<RecipientRow>('recipients', tenantListOpts, readQueryOptions);
  const clientsQuery = useResourceList<ClientRow>('clients', clientListOpts, readQueryOptions);
  // W21: consume canonical paired projection for derived context (client
  // label, shipment counters, last_shipment_status, phone_validated,
  // has_quiet_hours) on the operator drawer.
  const directoryQuery = useResourceList<RecipientDirectoryRow>('recipient_directory', tenantListOpts, readQueryOptions);
  const openRecipientShipmentsQuery = useResourceList<CustomerRelatedShipmentRow>(
    'shipment_directory',
    openRecipientId
      ? { filter: { recipient_id: openRecipientId }, sort: { key: 'created_at', dir: 'desc' }, page_size: 3 }
      : undefined,
    { enabled: canRead && canReadShipments && Boolean(openRecipientId) },
  );
  const openRecipientShipments = openRecipientShipmentsQuery.data?.rows ?? [];
  const openRecipientShipmentSignature = JSON.stringify({
    loading: openRecipientShipmentsQuery.isLoading,
    error: openRecipientShipmentsQuery.error instanceof Error ? openRecipientShipmentsQuery.error.message : null,
    rows: openRecipientShipments.map((shipment) => [
      shipment.id,
      shipment.tracking_number ?? null,
      shipment.status ?? null,
      shipment.client_reference_number ?? null,
    ]),
  });
  const { data, isLoading, error: recipientsError } = recipientsQuery;
  const { data: clientsData, error: clientsError } = clientsQuery;
  const { data: directoryData, error: directoryError } = directoryQuery;
  const rows = data?.rows ?? [];
  const clients = useMemo(() => clientsData?.rows ?? [], [clientsData]);
  const clientById = useMemo(() => new Map<string, ClientRow>(clients.map((c) => [c.id, c])), [clients]);
  const clientLabel = (clientId: unknown): string => {
    if (typeof clientId !== 'string' || !clientId.trim()) return t('recipients.unassignedClient');
    const client = clientById.get(clientId);
    return client ? `${client.name}${client.slug ? ` · ${client.slug}` : ''}` : t('recipients.unassignedClient');
  };
  const directoryById = useMemo(
    () => new Map<string, RecipientDirectoryRow>(
      (directoryData?.rows ?? []).map((d) => [d.recipient_id, d]),
    ),
    [directoryData],
  );
  const focusInRows = focusParam ? rows.some((row) => row.id === focusParam) : false;
  const focusedRecipientQuery = useResource<RecipientRow>(
    'recipients',
    focusParam && canRead && !focusInRows ? focusParam : undefined,
  );
  const focusedRecipientData = focusedRecipientQuery.data ?? null;
  const focusTarget = focusParam
    ? rows.find((row) => row.id === focusParam) ?? focusedRecipientData
    : null;

  async function refetchRecipientForReadback(
    recipientId: string,
    validate?: (row: RecipientRow) => boolean,
  ): Promise<RecipientRow> {
    const [recipientResult] = await Promise.all([
      recipientsQuery.refetch(),
      directoryQuery.refetch(),
      clientsQuery.refetch(),
    ]);
    const refreshed = recipientResult.data?.rows.find((row) => row.id === recipientId);
    if (!refreshed || (validate && !validate(refreshed))) {
      throw new Error(t('recipients.error.readback'));
    }
    return refreshed;
  }

  async function refetchRecipientDeletedForReadback(recipientId: string): Promise<void> {
    const [recipientResult, directoryResult] = await Promise.all([
      recipientsQuery.refetch(),
      directoryQuery.refetch(),
      clientsQuery.refetch(),
    ]);
    const stillVisible = recipientResult.data?.rows.some((row) => row.id === recipientId);
    const stillInDirectory = directoryResult.data?.rows.some((row) => row.recipient_id === recipientId);
    if (stillVisible || stillInDirectory) {
      throw new Error(t('recipients.error.deleteReadback'));
    }
  }

  function openCreateRecipient() {
    function CreateForm() {
      const defaultLang = lookupDefault(LANGUAGE_LOOKUP_CATEGORY);
      const defaultChannel = lookupDefault('communication_channel');
      const defaultClientId = clients.some((client) => client.id === clientParam)
        ? clientParam ?? ''
        : clients[0]?.id ?? '';
      const [draft, setDraft] = useState<RecipientCreateDraft>({
        client_id: defaultClientId,
        name: '',
        phone_number: '',
        email: '',
        external_id: '',
        preferred_language: defaultLang ?? '',
        preferred_comm_channel: defaultChannel ?? '',
        quiet_hours_start: '',
        quiet_hours_end: '',
      });
      const [formError, setFormError] = useState<string>('');
      function surfaceFormError(message: string, tone: 'warn' | 'danger' = 'danger') {
        setFormError(message);
        pushToast(message, tone);
      }
      const channelLookup = (getLookups('communication_channel') ?? []) as Array<{ value: string; label: string }>;
      const langLookup = (getLookups(LANGUAGE_LOOKUP_CATEGORY) ?? []) as Array<{ value: string; label: string }>;
      const seedGap = defaultLang === null || defaultChannel === null;
      const clientGap = clients.length === 0;
      const selectedClientId = draft.client_id || defaultClientId;

      return (
        <div>
          <p className="state__hint">
            {t('recipients.createIntro')}
          </p>
          {clientGap ? (
            <StateView kind="error" hint={t('recipients.error.noClients')} />
          ) : null}
          {seedGap ? (
            <StateView
              kind="error"
              hint={t('recipients.error.seedGap')}
            />
          ) : null}
          {formError ? (
            <StateView kind="error" hint={formError} />
          ) : null}
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
            <label className="mono" htmlFor="rec-create-client">{t('customers.field.client')}</label>
            <select
              id="rec-create-client"
              className="dt-inline-input"
              value={selectedClientId}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, client_id: e.target.value }));
              }}
            >
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor="rec-create-name">{t('customers.field.name')}</label>
            <input
              id="rec-create-name"
              className="dt-inline-input"
              value={draft.name}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, name: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="rec-create-phone">{t('recipients.phoneE164')}</label>
            <input
              id="rec-create-phone"
              className="dt-inline-input"
              placeholder={phonePlaceholder}
              value={draft.phone_number}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, phone_number: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="rec-create-email">{t('customers.field.email')}</label>
            <input
              id="rec-create-email"
              className="dt-inline-input"
              value={draft.email}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, email: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="rec-create-external">{t('customers.field.externalId')}</label>
            <input
              id="rec-create-external"
              className="dt-inline-input"
              value={draft.external_id}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, external_id: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="rec-create-lang">{t('customers.field.language')}</label>
            <select
              id="rec-create-lang"
              className="dt-inline-input"
              value={draft.preferred_language}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, preferred_language: e.target.value }));
              }}
            >
              {langLookup.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <label className="mono" htmlFor="rec-create-channel">{t('customers.field.channel')}</label>
            <select
              id="rec-create-channel"
              className="dt-inline-input"
              value={draft.preferred_comm_channel}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, preferred_comm_channel: e.target.value }));
              }}
            >
              {channelLookup.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <label className="mono" htmlFor="rec-create-quiet-from">{t('customers.field.quietFrom')}</label>
            <input
              id="rec-create-quiet-from"
              className="dt-inline-input"
              placeholder="22:00"
              value={draft.quiet_hours_start}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, quiet_hours_start: e.target.value }));
              }}
            />
            <label className="mono" htmlFor="rec-create-quiet-to">{t('customers.field.quietTo')}</label>
            <input
              id="rec-create-quiet-to"
              className="dt-inline-input"
              placeholder="08:00"
              value={draft.quiet_hours_end}
              onChange={(e) => {
                setFormError('');
                setDraft((s) => ({ ...s, quiet_hours_end: e.target.value }));
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('recipients.createRecipient')}
              kind="primary"
              capability={WRITE_CAP}
              disabled={clientGap}
              onClick={async () => {
                if (!selectedClientId) {
                  surfaceFormError(t('customers.msg.clientRequired'), 'warn');
                  return;
                }
                if (!draft.name.trim()) {
                  surfaceFormError(t('customers.msg.nameRequired'), 'warn');
                  return;
                }
                if (!draft.phone_number.trim()) {
                  surfaceFormError(t('recipients.error.phoneRequired'), 'warn');
                  return;
                }
                if (!isE164PhoneNumber(draft.phone_number)) {
                  surfaceFormError(e164PhoneError(), 'warn');
                  return;
                }
                try {
                  const result = await createMut.mutateAsync({
                    client_id: selectedClientId,
                    name: draft.name.trim(),
                    phone_number: draft.phone_number.trim(),
                    email: draft.email.trim() || null,
                    external_id: draft.external_id.trim() || null,
                    preferred_language: draft.preferred_language || undefined,
                    preferred_comm_channel: draft.preferred_comm_channel || undefined,
                    quiet_hours_start: draft.quiet_hours_start || null,
                    quiet_hours_end: draft.quiet_hours_end || null,
                  });
                  await refetchRecipientForReadback(
                    result.recipient_id,
                    (row) =>
                      row.name === draft.name.trim()
                      && row.client_id === selectedClientId
                      && row.phone_number === draft.phone_number.trim(),
                  );
                  setPendingCreatedRecipientId(result.recipient_id);
                  modal.close();
                  pushToast(fill(t('recipients.created'), { name: draft.name.trim() }), 'good');
                } catch (err) {
                  surfaceFormError(recipientMutationErrorMessage(err, t));
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: t('recipients.createRecipient'), body: <CreateForm /> });
  }

  function openDeleteRecipient(r: RecipientRow) {
    const directory = directoryById.get(r.id);
    const client = r.client_id ? clientById.get(r.client_id) : undefined;
    function DeleteForm() {
      const [reason, setReason] = useState('');
      return (
        <div>
          <p className="state__hint">
            {t('recipients.deleteIntro')}
          </p>
          <div className="card" style={{ fontSize: 11, lineHeight: 1.55, padding: 10 }}>
            <SeamLine k={t('recipients.seam.recipient')} v={r.name} />
            <SeamLine k={t('customers.field.client')} v={client?.name ?? t('recipients.seam.clientRecord')} />
            <SeamLine k={t('recipients.seam.shipmentRefs')} v={String(directory?.total_shipments ?? 0)} />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label" htmlFor="rec-delete-reason">{t('customers.field.reason')}</label>
            <textarea
              id="rec-delete-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={t('recipients.deleteReasonPlaceholder')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('recipients.deleteRecipient')}
              kind="danger"
              capability={WRITE_CAP}
              onClick={async () => {
                try {
                  await deleteMut.mutateAsync({
                    recipient_id: r.id,
                    reason: reason.trim() || undefined,
                  });
                  await refetchRecipientDeletedForReadback(r.id);
                  modal.close();
                  if (openRecipientId === r.id) {
                    drawer.close();
                    setOpenRecipientId(null);
                    openRecipientSignatureRef.current = null;
                  }
                  pushToast(fill(t('recipients.deleted'), { name: r.name }), 'warn');
                } catch (err) {
                  pushToast(recipientMutationErrorMessage(err, t), 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({
      title: fill(t('recipients.deleteTitle'), { name: r.name }),
      body: <DeleteForm />,
    });
  }

  function openOperatorCorrection(r: RecipientRow) {
    function CorrectionForm() {
      // W26+ no-fallback: form draft seeds preferred_language /
      // preferred_comm_channel from canonical `is_default: true` lookup rows.
      // When the seed is missing the canonical default row we render a
      // StateView error instead of masking the gap with a hardcoded literal.
      const defaultLang = lookupDefault(LANGUAGE_LOOKUP_CATEGORY);
      const defaultChannel = lookupDefault('communication_channel');
      const [draft, setDraft] = useState<RecipientEditDraft>({
        name: r.name,
        phone_number: r.phone_number ?? '',
        email: r.email ?? '',
        external_id: r.external_id ?? '',
        preferred_language: r.preferred_language ?? defaultLang ?? '',
        preferred_comm_channel: r.preferred_comm_channel ?? defaultChannel ?? '',
        quiet_hours_start: r.quiet_hours_start ?? '',
        quiet_hours_end: r.quiet_hours_end ?? '',
        communication_preferences_json: stringifyJsonForTextarea(r.communication_preferences),
      });
      const channelLookup = (getLookups('communication_channel') ?? []) as Array<{ value: string; label: string }>;
      const langLookup = (getLookups(LANGUAGE_LOOKUP_CATEGORY) ?? []) as Array<{ value: string; label: string }>;
      const seedGap = (defaultLang === null && !r.preferred_language)
        || (defaultChannel === null && !r.preferred_comm_channel);
      return (
        <div>
          <p className="state__hint">
            {t('recipients.correctionIntro')}
          </p>
          {seedGap ? (
            <StateView
              kind="error"
              hint={t('recipients.error.seedGap')}
            />
          ) : null}
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
            <label className="mono" htmlFor="rec-name">{t('customers.field.name')}</label>
            <input
              id="rec-name"
              className="dt-inline-input"
              value={draft.name}
              onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
            />
            <label className="mono" htmlFor="rec-phone">{t('recipients.phoneE164')}</label>
            <input
              id="rec-phone"
              className="dt-inline-input"
              placeholder={phonePlaceholder}
              value={draft.phone_number}
              onChange={(e) => setDraft((s) => ({ ...s, phone_number: e.target.value }))}
            />
            <label className="mono" htmlFor="rec-email">{t('customers.field.email')}</label>
            <input
              id="rec-email"
              className="dt-inline-input"
              value={draft.email}
              onChange={(e) => setDraft((s) => ({ ...s, email: e.target.value }))}
            />
            <label className="mono" htmlFor="rec-external-id">{t('customers.field.externalId')}</label>
            <input
              id="rec-external-id"
              className="dt-inline-input"
              value={draft.external_id}
              onChange={(e) => setDraft((s) => ({ ...s, external_id: e.target.value }))}
            />
            <label className="mono" htmlFor="rec-lang">{t('customers.field.language')}</label>
            <select
              id="rec-lang"
              className="dt-inline-input"
              value={draft.preferred_language}
              onChange={(e) => setDraft((s) => ({ ...s, preferred_language: e.target.value }))}
            >
              {langLookup.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <label className="mono" htmlFor="rec-channel">{t('customers.field.channel')}</label>
            <select
              id="rec-channel"
              className="dt-inline-input"
              value={draft.preferred_comm_channel}
              onChange={(e) => setDraft((s) => ({ ...s, preferred_comm_channel: e.target.value }))}
            >
              {channelLookup.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <label className="mono" htmlFor="rec-quiet-from">{t('customers.field.quietFrom')}</label>
            <input
              id="rec-quiet-from"
              className="dt-inline-input"
              placeholder="22:00"
              value={draft.quiet_hours_start}
              onChange={(e) => setDraft((s) => ({ ...s, quiet_hours_start: e.target.value }))}
            />
            <label className="mono" htmlFor="rec-quiet-to">{t('customers.field.quietTo')}</label>
            <input
              id="rec-quiet-to"
              className="dt-inline-input"
              placeholder="08:00"
              value={draft.quiet_hours_end}
              onChange={(e) => setDraft((s) => ({ ...s, quiet_hours_end: e.target.value }))}
            />
            <label className="mono" htmlFor="rec-communication-preferences">{t('recipients.preferencesJson')}</label>
            <textarea
              id="rec-communication-preferences"
              className="dt-inline-input"
              rows={4}
              placeholder={PREFERENCES_JSON_PLACEHOLDER}
              value={draft.communication_preferences_json}
              onChange={(e) => setDraft((s) => ({ ...s, communication_preferences_json: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('common.save')}
              kind="primary"
              capability={WRITE_CAP}
              onClick={async () => {
                if (!draft.name.trim()) {
                  pushToast(t('customers.msg.nameRequired'), 'warn');
                  return;
                }
                if (draft.phone_number.trim() && !isE164PhoneNumber(draft.phone_number)) {
                  pushToast(e164PhoneError(), 'warn');
                  return;
                }
                try {
                  const communicationPreferences = parseOptionalJsonObject(draft.communication_preferences_json, t);
                  await updateMut.mutateAsync({
                    recipient_id: r.id,
                    name: draft.name.trim(),
                    phone_number: draft.phone_number.trim() || undefined,
                    email: draft.email.trim() || null,
                    external_id: draft.external_id.trim() || null,
                    preferred_language: draft.preferred_language,
                    preferred_comm_channel: draft.preferred_comm_channel,
                    quiet_hours_start: draft.quiet_hours_start || null,
                    quiet_hours_end: draft.quiet_hours_end || null,
                    communication_preferences: communicationPreferences,
                  });
                  await refetchRecipientForReadback(
                    r.id,
                    (row) =>
                      row.name === draft.name.trim()
                      && (!draft.phone_number.trim() || row.phone_number === draft.phone_number.trim())
                      && (row.email ?? null) === (draft.email.trim() || null)
                      && (row.external_id ?? null) === (draft.external_id.trim() || null)
                      && row.preferred_language === draft.preferred_language
                      && row.preferred_comm_channel === draft.preferred_comm_channel
                      && (row.quiet_hours_start ?? null) === (draft.quiet_hours_start || null)
                      && (row.quiet_hours_end ?? null) === (draft.quiet_hours_end || null),
                  );
                  modal.close();
                  pushToast(fill(t('recipients.updated'), { name: r.name }), 'good');
                } catch (err) {
                  pushToast(recipientMutationErrorMessage(err, t), 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: fill(t('recipients.correctionTitle'), { name: r.name }), body: <CorrectionForm /> });
  }

  function recipientDrawerSignature(r: RecipientRow): string {
    const directory = directoryById.get(r.id);
    return JSON.stringify({
      id: r.id,
      name: r.name,
      client_id: r.client_id ?? null,
      external_id: r.external_id ?? null,
      email: r.email ?? null,
      phone_number: r.phone_number ?? null,
      phone_validation_status: r.phone_validation_status ?? null,
      preferred_language: r.preferred_language ?? null,
      preferred_comm_channel: r.preferred_comm_channel ?? null,
      quiet_hours_start: r.quiet_hours_start ?? null,
      quiet_hours_end: r.quiet_hours_end ?? null,
      communication_preferences: r.communication_preferences ?? null,
      directory_total_shipments: directory?.total_shipments ?? null,
      directory_last_shipment_status: directory?.last_shipment_status ?? null,
      directory_has_quiet_hours: directory?.has_quiet_hours ?? null,
      related_shipments: openRecipientShipmentSignature,
    });
  }

  function openRecipientDrawer(r: RecipientRow, options?: { track?: boolean }) {
    if (options?.track !== false) {
      setOpenRecipientId(r.id);
    }
    openRecipientSignatureRef.current = recipientDrawerSignature(r);
    const client = r.client_id ? clientById.get(r.client_id) : undefined;
    const directory = directoryById.get(r.id);
    const phone = r.phone_number ?? '';
    const language = r.preferred_language ?? '';
    const channel = r.preferred_comm_channel ?? '';
    const validation = r.phone_validation_status ?? null;

    // Console-side writes are operator corrections through recipient_update_v1.
    // Portal self-edit remains split to Portal.
    const kvRows: KvRow[] = [
      { key: 'name', label: t('customers.field.name'), value: r.name, editable: false },
      {
        key: 'client_id',
        label: t('customers.field.client'),
        value: client ? clientLabel(r.client_id) : t('recipients.unassignedClient'),
        editable: false,
      },
      { key: 'external_id', label: t('customers.field.externalId'), value: externalReferenceLabel(r.external_id), mono: true, editable: false },
      { key: 'email', label: t('customers.field.email'), value: r.email ?? '—', mono: true, editable: false },
      { key: 'phone_number', label: t('customers.field.phone'), value: phone || '—', mono: true, editable: false },
      {
        // W54-E closure: NO hardcoded `'unverified'` literal — fall through to
        // the canonical missing-data marker `'—'` so the gap is visible to
        // operators when phone_validation_status is unset.
        key: 'phone_validation_status',
        label: t('recipients.phoneValidation'),
        value: validation ?? '—',
        lookup: 'phone_validation_status',
        editable: false,
      },
      // W26+ no-fallback: read-side displays derive missing values from
      // canonical `is_default: true` lookup rows, then fall through to '—'
      // (no hardcoded locale/channel literal). Drop the `lookup` chip when
      // both the row value and seed default are absent so the dash renders
      // unambiguously instead of through the lookup-label resolver.
      ...(language || lookupDefault(LANGUAGE_LOOKUP_CATEGORY)
        ? [{
            key: 'preferred_language',
            label: t('customers.field.language'),
            value: language || (lookupDefault(LANGUAGE_LOOKUP_CATEGORY) ?? '—'),
            lookup: LANGUAGE_LOOKUP_CATEGORY,
            editable: false,
          } as KvRow]
        : [{
            key: 'preferred_language',
            label: t('customers.field.language'),
            value: '—',
            mono: true,
            editable: false,
          } as KvRow]),
      ...(channel || lookupDefault('communication_channel')
        ? [{
            key: 'preferred_comm_channel',
            label: t('customers.field.channel'),
            value: channel || (lookupDefault('communication_channel') ?? '—'),
            lookup: 'communication_channel',
            editable: false,
          } as KvRow]
        : [{
            key: 'preferred_comm_channel',
            label: t('customers.field.channel'),
            value: '—',
            mono: true,
            editable: false,
          } as KvRow]),
      { key: 'quiet_hours_start', label: t('customers.field.quietFrom'), value: r.quiet_hours_start ?? '—', mono: true, editable: false },
      { key: 'quiet_hours_end', label: t('customers.field.quietTo'), value: r.quiet_hours_end ?? '—', mono: true, editable: false },
    ];

    drawer.open({
      title: r.name,
      size: 'md',
      deepLink: `/customers/recipients?focus=${r.id}`,
      onClose: () => {
        setOpenRecipientId(null);
        openRecipientSignatureRef.current = null;
      },
      body: (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {validation ? (() => {
              const tone = lookupTone('phone_validation_status', validation);
              return tone == null ? (
                <Chip
                  label={fill(t('recipients.chip.unknownValidation'), { value: String(validation) })}
                  kind="danger"
                  size="xs"
                />
              ) : (
                <Chip
                  label={fill(t('recipients.chip.phone'), { label: lookupLabel('phone_validation_status', validation) })}
                  kind={tone}
                  size="xs"
                />
              );
            })() : null}
            {language ? (
              <Chip label={fill(t('recipients.chip.lang'), { label: lookupLabel(LANGUAGE_LOOKUP_CATEGORY, language) })} kind="neutral" size="xs" />
            ) : null}
            {channel ? (() => {
              const tone = lookupTone('communication_channel', channel);
              return tone == null ? (
                <Chip
                  label={fill(t('recipients.chip.unknownChannel'), { value: channel })}
                  kind="danger"
                  size="xs"
                />
              ) : (
                <Chip
                  label={fill(t('recipients.chip.channel'), { label: lookupLabel('communication_channel', channel) })}
                  kind={tone}
                  size="xs"
                />
              );
            })() : null}
            {directory ? (
              <>
                <Chip
                  label={fill(t('recipients.chip.shipments'), { n: directory.total_shipments ?? 0 })}
                  kind="info"
                  size="xs"
                />
                {directory.last_shipment_status ? (() => {
                  const tone = lookupTone('shipment_status', directory.last_shipment_status);
                  return tone == null ? (
                    <Chip
                      label={fill(t('recipients.chip.unknownStatus'), { value: String(directory.last_shipment_status) })}
                      kind="danger"
                      size="xs"
                    />
                  ) : (
                    <Chip
                      label={fill(t('recipients.chip.last'), { label: lookupLabel('shipment_status', directory.last_shipment_status) })}
                      kind={tone}
                      size="xs"
                    />
                  );
                })() : null}
                {directory.has_quiet_hours ? (
                  <Chip label={t('recipients.chip.quietHours')} kind="neutral" size="xs" />
                ) : null}
              </>
            ) : null}
          </div>

          <KvGrid rows={kvRows} />

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('recipients.section.preferences')}</div>
          <KvGrid rows={objectSummaryRows(r.communication_preferences, 'recipient-preference', t)} />

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('customers.section.relatedShipments')}</div>
          <div style={{ padding: '0 14px' }}>
            <RelatedShipmentsPanel
              canReadShipments={canReadShipments}
              error={openRecipientShipmentsQuery.error}
              isLoading={openRecipientShipmentsQuery.isLoading}
              rows={openRecipientShipments}
              scopeLabel={t('customers.related.scopeRecipient')}
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

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('recipients.section.actions')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 14px' }}>
            <Button
              label={t('recipients.correctRecipient')}
              iconName="edit"
              kind="ghost"
              capability={WRITE_CAP}
              onClick={() => openOperatorCorrection(r)}
            />
            <Button
              label={t('recipients.deleteRecipient')}
              iconName="trash"
              kind="danger"
              capability={WRITE_CAP}
              onClick={() => openDeleteRecipient(r)}
            />
            <Button
              label={t('customers.action.openClient')}
              iconName="building"
              kind="ghost"
              capability={CAP.CLIENTS_READ}
              disabled={!r.client_id}
              onClick={() => {
                if (r.client_id) go(`/customers/clients?focus=${encodeURIComponent(r.client_id)}`);
              }}
            />
            <Button
              label={t('customers.link.shipments')}
              iconName="package"
              kind="ghost"
              capability={CAP.SHIPMENTS_READ}
              onClick={() => go(`/operate/shipments?recipient=${encodeURIComponent(r.id)}`)}
            />
          </div>

          <div className="section-eyebrow" style={{ marginTop: 12 }}>{t('customers.section.operationalControls')}</div>
          <div className="card mono" style={{ fontSize: 11, lineHeight: 1.6, padding: 10 }}>
            <SeamLine k={t('customers.seam.directory')} v={t('recipients.seam.directory')} />
            <SeamLine k={t('recipients.phoneValidation')} v={t('recipients.seam.phoneValidation')} />
            <SeamLine k={t('recipients.seam.channelRouting')} v={t('recipients.seam.channelPolicy')} />
            <SeamLine k={t('recipients.seam.quietHours')} v={t('recipients.seam.quietPolicy')} />
            <SeamLine k={t('customers.field.language')} v={t('recipients.seam.language')} />
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
      openRecipientDrawer(focusTarget);
      openedFocusRef.current = focusParam;
    }, 100);
    return () => window.clearTimeout(timer);
    // openRecipientDrawer closes over drawer/query state; focus target is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, focusTarget]);

  useEffect(() => {
    if (!pendingCreatedRecipientId) return;
    const created = rows.find((row) => row.id === pendingCreatedRecipientId);
    if (!created) return;
    openRecipientDrawer(created);
    setPendingCreatedRecipientId(null);
    // openRecipientDrawer uses the latest backend-read row as the post-create operator context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreatedRecipientId, rows, directoryById]);

  useEffect(() => {
    if (!drawer.isOpen || !openRecipientId) return;
    const refreshed =
      rows.find((row) => row.id === openRecipientId)
      ?? (focusedRecipientData?.id === openRecipientId ? focusedRecipientData : null);
    if (!refreshed) {
      const focusedReadSettled =
        focusParam !== openRecipientId || !focusedRecipientQuery.isFetching;
      if (data && focusedReadSettled) {
        drawer.close();
        setOpenRecipientId(null);
        openRecipientSignatureRef.current = null;
      }
      return;
    }
    const nextSignature = recipientDrawerSignature(refreshed);
    if (openRecipientSignatureRef.current === nextSignature) return;
    openRecipientSignatureRef.current = nextSignature;
    openRecipientDrawer(refreshed, { track: false });
    // openRecipientDrawer rebuilds the current drawer from backend-refreshed state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer.isOpen, openRecipientId, rows, focusedRecipientData, focusedRecipientQuery.isFetching, data, focusParam, directoryById, openRecipientShipmentSignature]);

  const columns: Array<DataTableColumn<RecipientRow>> = [
    { key: 'name', label: t('customers.field.name'), sortable: true, filterable: true },
    {
      key: 'client_id',
      label: t('customers.field.client'),
      sortable: true,
      filterable: true,
      render: (raw) => clientLabel(raw),
      reference: {
        items: clients,
        display: (c) => (c as ClientRow).name,
        value: (c) => (c as ClientRow).id,
        sub: (c) => (c as ClientRow).slug ?? '',
      },
    },
    {
      key: 'phone_number',
      label: t('customers.field.phone'),
      mono: true,
      sortable: true,
      filterable: true,
      render: (raw) => <span className="mono">{(raw as string) || '—'}</span>,
    },
    {
      key: 'email',
      label: t('customers.field.email'),
      mono: true,
      filterable: true,
      render: (raw) => <span className="mono">{(raw as string) || '—'}</span>,
    },
    {
      key: 'phone_validation_status',
      label: t('recipients.col.validation'),
      sortable: true,
      filterable: true,
      lookup: 'phone_validation_status',
    },
    {
      key: 'preferred_language',
      label: t('recipients.col.lang'),
      sortable: true,
      filterable: true,
      lookup: LANGUAGE_LOOKUP_CATEGORY,
      render: (raw) => {
        const value = raw as string | undefined;
        if (!value) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        return <Chip label={lookupLabel(LANGUAGE_LOOKUP_CATEGORY, value)} kind="neutral" size="xs" />;
      },
    },
    {
      key: 'preferred_comm_channel',
      label: t('customers.field.channel'),
      sortable: true,
      filterable: true,
      lookup: 'communication_channel',
      render: (raw) => {
        const value = raw as string | undefined;
        if (!value) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        const tone = lookupTone('communication_channel', value);
        if (tone == null) {
          return <Chip label={fill(t('recipients.chip.unknownChannel'), { value })} kind="danger" size="xs" />;
        }
        return <Chip label={lookupLabel('communication_channel', value)} kind={tone} size="xs" />;
      },
    },
    {
      key: 'external_id',
      label: t('customers.field.externalId'),
      mono: true,
      filterable: true,
      render: (raw) => externalReferenceLabel(raw),
    },
    { key: 'quiet_hours_start', label: t('customers.field.quietFrom'), mono: true },
    { key: 'quiet_hours_end', label: t('customers.field.quietTo'), mono: true },
  ];

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
        <Chip key="cap" label={t('recipients.capPill')} kind="info" size="xs" />,
    <Chip
      key="split"
      label={t('recipients.splitChip')}
      kind="warn"
      size="xs"
      title={t('recipients.splitTitle')}
    />,
    <span key="seam" className="chip chip--xs mono">
              {t('recipients.pill')}
    </span>,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="recipients"
          titlePlain={t('recipients.titlePlain')}
        />
        <StateView
          kind="denied"
          capability={CAP.RECIPIENTS_READ}
          hint={t('recipients.denied')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="recipients"
          titlePlain={t('recipients.titlePlain')}
          pills={pills}
          actions={[
            <Button
              key="create"
              label={t('recipients.newRecipient')}
              iconName="plus"
              kind="primary"
              capability={WRITE_CAP}
              disabled={clients.length === 0}
              onClick={openCreateRecipient}
            />,
          ]}
        />

      {recipientsError ? (
        <StateView
          kind="error"
          title={t('recipients.error.directory')}
          hint={(recipientsError as Error).message}
        />
      ) : clientsError ? (
        <StateView
          kind="error"
          title={t('recipients.error.clientDirectory')}
          hint={(clientsError as Error).message}
        />
      ) : directoryError ? (
        <StateView
          kind="error"
          title={t('recipients.error.related')}
          hint={(directoryError as Error).message}
        />
      ) : isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<RecipientRow>
          columns={columns}
          rows={rows}
          viewKey="recipients"
          entityKind="recipient"
          onRowClick={openRecipientDrawer}
          rowDeepLink={(r) => `/customers/recipients?focus=${r.id}`}
          rowActions={[
            { label: t('customers.action.openDetail'), icon: 'eye', kind: 'primary', onClick: openRecipientDrawer },
            {
              label: t('recipients.action.viewClient'),
              icon: 'building',
              capability: CAP.CLIENTS_READ,
              onClick: (r) => {
                if (r.client_id) go(`/customers/clients?focus=${encodeURIComponent(r.client_id)}`);
              },
            },
            {
              label: t('customers.action.viewShipments'),
              icon: 'package',
              capability: CAP.SHIPMENTS_READ,
              onClick: (r) => go(`/operate/shipments?recipient=${encodeURIComponent(r.id)}`),
            },
            {
              label: t('recipients.action.correction'),
              icon: 'edit',
              capability: WRITE_CAP,
              onClick: openOperatorCorrection,
            },
            {
              label: t('recipients.action.delete'),
              icon: 'trash',
              kind: 'danger',
              capability: WRITE_CAP,
              onClick: openDeleteRecipient,
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

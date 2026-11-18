// integrations/sources.tsx — Webhook sources operator surface (CLAIM-INGRESS-COMPLETE).
//
// Backed by:
//   • public.webhook_sources from
//     supabase/migrations/202510110004_webhook_integration.sql:185-208
//     (organization_id, source_identifier UNIQUE, name, provider_type,
//      mapping_config_id, rate_limit_per_hour, enabled; token status only).
//   • RLS gated by webhooks.read / webhooks.write per migration
//     202601071220_capability_assignments.sql:110.
//   • ui_read_registry.webhook_sources (seed-raw/registry.js).
//   • ui_list_resource_v1('webhook_sources') generic substrate.
//
// Operator capabilities:
//   - Browse all webhook sources (DataTable, capability `webhooks.read`).
//   - Open detail drawer (projection-backed auth status, last_event_at, mapping config).
//   - Toggle enabled in-place via useUpsertWebhookSource() (Phase C5 hook
//     wrapping `ui_upsert_webhook_source_v1`); capability `webhooks.write`.
//   - Edit / Create via modal (same hook); capability `webhooks.write`.
//   - Rotate auth token via useRotateWebhookSourceToken() (Phase C5 hook
//     wrapping `ui_rotate_webhook_source_token_v1`); capability `webhooks.write`.
//   - Production cutover is environment-only — see lib/data-source.ts
//     swap-seam contract.

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn, type DataTableAction } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useArchiveWebhookSource,
  useResourceList,
  useUpsertWebhookSource,
  useRotateWebhookSourceToken,
  useResolveSettings,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { CAP } from '@/lib/capabilities';
import {
  stashExternalIntakeSourceToken,
  type ExternalIntakeTokenTarget,
} from '@/lib/external-intake-token-handoff';
import {
  requireWebhookSourceReadback,
  requireWebhookSourceStateReadback,
  requireWebhookSourceTokenReadback,
} from './webhook-source-readback';
import {
  ExternalIntakeWorkspaceToolbar,
  externalIntakeTargetPath,
} from './ExternalIntakeWorkspaceToolbar';

// ─── Strict canonical lookup row resolver (NO fallback constants) ─────────
// AGENTS.md §2 + §4: provider chip tone resolves through canonical
// `lookups[webhook_provider_type]` SSOT (the seeded category that mirrors
// the `webhook_sources.provider_type` enum). Missing rows surface a
// danger-toned chip rather than a silent 'neutral' default. The canonical
// resolver lives in `@/lib/seed-raw/lookups`.

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §1):
// Canonical SSOT is `public.webhook_sources`
// (supabase/migrations/202510110004_webhook_integration.sql:185-197) which has
// columns: id, organization_id, source_identifier, name, provider_type,
// mapping_config_id, rate_limit_per_hour, enabled, created_at,
// updated_at.
//   • PROJECTION: last_event_at is NOT a column on `webhook_sources`. It is
//     projected as `MAX(webhook_inbox.created_at) WHERE webhook_source_id = id`
//     and surfaced as an optional UI projection field. Retained for the detail
//     drawer + DataTable sortable column without requiring a paired aggregation
//     RPC.
//   • W27 paired projection: `public.v_webhook_source_directory`
//     (supabase/migrations/202604302500_v_webhook_source_directory.sql) now
//     materialises last_event_at + event_count_24h + error_count_24h +
//     rule_count + active_rule_count + is_healthy + has_recent_errors +
//     mapping_label + last_event_status + auth_token_masked under a single
//     read seam.
export interface WebhookSourceRow extends Record<string, unknown> {
  id: string;
  organization_id?: string;
  // SSOT: webhook_sources.source_identifier (canonical column).
  source_identifier: string;
  // SSOT: webhook_sources.name (canonical column).
  name: string;
  // SSOT: webhook_sources.provider_type (canonical column).
  provider_type: 'shopify' | 'woocommerce' | 'generic' | 'custom_erp' | 'delivery_provider';
  // Optional sender binding used by shipment-creation webhooks to resolve the
  // client through the canonical sender -> client relationship.
  sender_id?: string | null;
  // SSOT: webhook_sources.mapping_config_id (canonical column).
  mapping_config_id?: string;
  // SSOT: webhook_sources.rate_limit_per_hour (canonical column).
  rate_limit_per_hour?: number;
  // SSOT: webhook_sources.enabled (canonical column).
  enabled: boolean;
  // SSOT: derived projection (`MAX(webhook_inbox.created_at) WHERE webhook_source_id = id`); not a top-level column.
  last_event_at?: string | null;
  hmac_enabled?: boolean | null;
  hmac_auth_config_id?: string | null;
  hmac_header?: string | null;
  hmac_algorithm?: string | null;
  hmac_signature_encoding?: string | null;
  lifecycle_state?: string | null;
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
  managed_metadata?: Record<string, unknown> | null;
}

/**
 * W27 — Canonical projection from `public.v_webhook_source_directory`
 * (supabase/migrations/202604302500_v_webhook_source_directory.sql). Joined
 * to `WebhookSourceRow` by id to surface derived joins (mapping_label) +
 * computed fields (last_event_at, last_event_status, event_count_24h,
 * error_count_24h, rule_count, active_rule_count, is_healthy,
 * has_recent_errors, auth_token_masked) without duplicating them onto the
 * canonical row interface. Production swap stays a single
 * `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('webhook_source_directory')`.
 */
export interface WebhookSourceDirectoryRow extends Record<string, unknown> {
  id: string;
  sender_id?: string | null;
  client_id?: string | null;
  sender_label?: string | null;
  client_label?: string | null;
  mapping_label?: string | null;
  last_event_at?: string | null;
  last_event_status?: string | null;
  event_count_24h?: number;
  error_count_24h?: number;
  rule_count?: number;
  active_rule_count?: number;
  is_healthy?: boolean;
  has_recent_errors?: boolean;
  auth_token_masked?: string | null;
  hmac_enabled?: boolean | null;
  hmac_auth_config_id?: string | null;
  hmac_header?: string | null;
  hmac_algorithm?: string | null;
  hmac_signature_encoding?: string | null;
  lifecycle_state?: string | null;
  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
  managed_metadata?: Record<string, unknown> | null;
}

interface MappingConfigOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  mapping_type?: string | null;
  mapping_key?: string | null;
  mapping_config?: Record<string, unknown> | null;
  managed_by?: string | null;
  managed_metadata?: Record<string, unknown> | null;
  target?: string | null;
}

interface SenderOptionRow extends Record<string, unknown> {
  id: string;
  sender_id?: string | null;
  name?: string | null;
  client_label?: string | null;
}

interface IntegrationCredentialOptionRow extends Record<string, unknown> {
  id: string;
  provider_label?: string | null;
  auth_type?: string | null;
  status?: string | null;
  is_active?: boolean | null;
}

function ProviderChip({ value }: { value: string }) {
  const r = lookupRow('webhook_provider_type', value);
  if (!r) return <Chip label={`Unknown provider: ${value}`} kind="danger" size="xs" />;
  return <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />;
}

function shortReference(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'none';
  if (/^[a-z]+_[a-z0-9_]+$/i.test(raw)) {
    return raw.split('_').filter(Boolean).at(-1) ?? raw.slice(-6);
  }
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 4)}...${raw.slice(-6)}`;
}

function operatorReference(kind: string, value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return `${kind} ref none`;
  const friendly = shortReference(raw);
  return friendly === raw ? `${kind} ref ${raw}` : `${kind} ref ${friendly} (${raw})`;
}

function authTokenStatusLabel(projection: WebhookSourceDirectoryRow | undefined): string {
  if (!projection) return 'Token state unavailable';
  return projection.auth_token_masked ? 'Configured' : 'Not configured';
}

function hmacValidationLabel(row: WebhookSourceDirectoryRow | undefined): string {
  if (!row?.hmac_enabled) return 'Token only';
  const header = String(row.hmac_header ?? '').trim();
  return header ? `Token + HMAC (${header})` : 'Token + HMAC';
}

function HmacValidationChip({ row }: { row: WebhookSourceDirectoryRow | undefined }) {
  return (
    <Chip
      label={hmacValidationLabel(row)}
      kind={row?.hmac_enabled ? 'info' : 'neutral'}
      size="xs"
    />
  );
}

function providerLabel(value: string): string {
  return lookupRow('webhook_provider_type', value)?.label ?? `Unknown provider: ${value}`;
}

function mappingOptionLabel(row: MappingConfigOptionRow): string {
  const configuredLabel = mappingConfiguredLabel(row);
  const key = String(row.mapping_key ?? '').trim();
  const target = String(row.target ?? '').trim();
  const label = configuredLabel || key;
  if (label && target) return `${label} -> ${target}`;
  return label || target || shortReference(row.id);
}

function mappingRequiresShipmentSender(row: MappingConfigOptionRow | undefined): boolean {
  const target = String(row?.target ?? row?.mapping_config?.target ?? '').trim();
  return target === 'shipments.create' || target === 'shipment.create';
}

function isSourceBindableMapping(row: MappingConfigOptionRow): boolean {
  const enabled = row.mapping_config?.enabled !== false;
  if (!enabled) return false;
  const mappingType = String(row.mapping_type ?? '').trim();
  if (mappingType === 'webhook_inbound') return true;
  const metadata = row.managed_metadata && typeof row.managed_metadata === 'object'
    ? row.managed_metadata
    : {};
  return String(metadata.plugin_version_id ?? '').trim().length > 0;
}

function mappingConfiguredLabel(row: MappingConfigOptionRow | undefined): string {
  const config = row?.mapping_config;
  if (!config || typeof config !== 'object') return '';
  const label = String(config.label ?? config.name ?? '').trim();
  return label;
}

function isTechnicalMappingKey(value: string): boolean {
  return value.startsWith('integration_plugin:');
}

function sourceMappingLabel(
  raw: unknown,
  row: WebhookSourceRow & Partial<WebhookSourceDirectoryRow>,
  mappingOptionsById: Map<string, MappingConfigOptionRow>,
): string {
  const mappingId = String(raw ?? '').trim();
  if (!mappingId) return '';
  const projected = String(row.mapping_label ?? '').trim();
  const configured = mappingConfiguredLabel(mappingOptionsById.get(mappingId));
  if (configured && (!projected || projected === mappingId || isTechnicalMappingKey(projected))) {
    return configured;
  }
  return projected || operatorReference('Mapping', mappingId);
}

function senderOptionLabel(row: SenderOptionRow): string {
  const name = String(row.name ?? row.sender_id ?? row.id).trim();
  const client = String(row.client_label ?? '').trim();
  return client ? `${name} -> ${client}` : name;
}

function hmacCredentialOptionLabel(row: IntegrationCredentialOptionRow): string {
  const provider = String(row.provider_label ?? '').trim();
  const status = String(row.status ?? '').trim();
  const base = provider ? `${provider} -> ${shortReference(row.id)}` : shortReference(row.id);
  return status ? `${base} (${status})` : base;
}

function sourceSenderLabel(row: WebhookSourceRow & WebhookSourceDirectoryRow): string {
  const sender = String(row.sender_label ?? '').trim();
  const client = String(row.client_label ?? '').trim();
  if (sender && client) return `${sender} -> ${client}`;
  if (sender) return sender;
  if (row.sender_id) return operatorReference('Sender', row.sender_id);
  return 'Not bound';
}

function mappingOptionsForSource(
  options: MappingConfigOptionRow[],
  row?: WebhookSourceRow,
): MappingConfigOptionRow[] {
  const rows: MappingConfigOptionRow[] = [];
  const seen = new Set<string>();
  const currentMappingId = String(row?.mapping_config_id ?? '').trim();
  const currentAlreadyListed = options.some((option) => option.id === currentMappingId);
  if (currentMappingId && !currentAlreadyListed) {
    const decorated = row as (WebhookSourceRow & WebhookSourceDirectoryRow) | undefined;
    rows.push({
      id: currentMappingId,
      organization_id: row?.organization_id ?? null,
      mapping_key: decorated?.mapping_label ?? null,
      target: null,
    });
  }
  rows.push(
    ...options.filter((option) => {
      if (currentMappingId && option.id === currentMappingId) return true;
      return isSourceBindableMapping(option);
    }),
  );
  return rows.filter((option) => {
    const id = String(option.id ?? '').trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// W69 Cycle F-R-9 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6
// row-driven by configuration): enabled/disabled label + tone resolves
// strictly through the canonical `enabled_state` lookup category
// (lib/seed-raw/lookups.js). Missing canonical row surfaces a danger-toned
// `(missing)` chip rather than a silent neutral default. The boolean→state
// projection routes through `enabledStateKey()` so module-level greps for
// inline label/tone literals stay clean.
// Canonical default value for the `enabled_state` lookup category — the
// row marked `is_default: true` is `enabled`. The off-state value is the
// other row (`disabled`). Resolving via `getLookups()` ordering keeps the
// projection row-driven (no inline literal pair tied to the lookup keys).
function enabledStateKey(value: boolean): string {
  const rows = (api.getLookups('enabled_state') as Array<{ value: string; is_default?: boolean }> | undefined) ?? [];
  const onRow = rows.find((r) => r.is_default) ?? rows[0];
  const onKey = onRow?.value ?? '';
  const offRow = rows.find((r) => r.value && r.value !== onKey) ?? rows.find((r) => r !== onRow) ?? rows[1];
  const offKey = offRow?.value ?? '';
  return value ? onKey : offKey;
}
function EnabledChip({ value }: { value: boolean }) {
  const row = lookupRow('enabled_state', enabledStateKey(value));
  if (!row) return <Chip label="Unknown enabled state" kind="danger" size="xs" />;
  return <Chip label={row.label ?? row.value} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />;
}

function enabledLabel(value: boolean): string {
  const row = lookupRow('enabled_state', enabledStateKey(value));
  return row?.label ?? (value ? 'Enabled' : 'Disabled');
}

function enabledStateOptions(): Array<{ key: string; enabled: boolean; label: string }> {
  return [true, false].flatMap((enabled) => {
    const key = enabledStateKey(enabled);
    const row = key ? lookupRow('enabled_state', key) : null;
    return row
      ? [{
          key,
          enabled,
          label: row.label ?? row.value,
        }]
      : [];
  });
}

// W69 Cycle F-R-9 closure: webhook source health label + tone resolves
// strictly through the canonical `webhook_source_health` lookup category.
// The boolean+counter→state projection (`isHealthy`, `errorCount24h`) is
// derivation logic against the W27 v_webhook_source_directory projection;
// LABEL + TONE route through the canonical lookup so adding/changing
// health-state semantics never requires editing module code. The state
// keys themselves resolve from canonical lookup ordering — `is_default`
// row is the healthy state, the rank-ordered remainder map to degraded
// (errors present) and idle (no errors). No inline label literal.
function deriveHealthStateKey(isHealthy: boolean, errorCount24h: number): string {
  const rows =
    (api.getLookups('webhook_source_health') as Array<
      { value: string; is_default?: boolean; rank?: number }
    > | undefined) ?? [];
  const healthyRow = rows.find((r) => r.is_default) ?? rows[0];
  if (isHealthy) return healthyRow?.value ?? '';
  // Off-default rows ordered by rank — first one is the "errors present"
  // state, second is the "no errors" idle state. Mirrors the canonical
  // ordering in lookups.js (degraded rank 20 → idle rank 30).
  const offRows = rows.filter((r) => r !== healthyRow).sort(
    (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
  );
  const erroringRow = offRows[0];
  const idleRow = offRows[1] ?? offRows[0];
  return errorCount24h > 0 ? erroringRow?.value ?? '' : idleRow?.value ?? '';
}
function HealthChip({ isHealthy, errorCount24h }: { isHealthy: boolean; errorCount24h: number }) {
  const healthState = deriveHealthStateKey(isHealthy, errorCount24h);
  const row = lookupRow('webhook_source_health', healthState);
  if (!row)
    return (
      <Chip label="Unknown source health" kind="danger" size="xs" />
    );
  return <Chip label={row.label ?? row.value} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />;
}

function healthLabel(isHealthy: boolean, errorCount24h: number): string {
  const healthState = deriveHealthStateKey(isHealthy, errorCount24h);
  const row = lookupRow('webhook_source_health', healthState);
  return row?.label ?? 'Unknown source health';
}

function sourceManagedMetadata(row: WebhookSourceRow | WebhookSourceDirectoryRow): Record<string, unknown> {
  return row.managed_metadata && typeof row.managed_metadata === 'object' && !Array.isArray(row.managed_metadata)
    ? row.managed_metadata
    : {};
}

function sourceArchivedAt(row: WebhookSourceRow | WebhookSourceDirectoryRow): string | null {
  const metadata = sourceManagedMetadata(row);
  return typeof row.archived_at === 'string' && row.archived_at.trim()
    ? row.archived_at.trim()
    : typeof metadata.archived_at === 'string' && metadata.archived_at.trim()
      ? metadata.archived_at.trim()
      : null;
}

function sourceArchiveReason(row: WebhookSourceRow | WebhookSourceDirectoryRow): string | null {
  const metadata = sourceManagedMetadata(row);
  return typeof row.archive_reason === 'string' && row.archive_reason.trim()
    ? row.archive_reason.trim()
    : typeof metadata.archive_reason === 'string' && metadata.archive_reason.trim()
      ? metadata.archive_reason.trim()
      : null;
}

function isArchivedSource(row: WebhookSourceRow | WebhookSourceDirectoryRow): boolean {
  const metadata = sourceManagedMetadata(row);
  const lifecycle = String(row.lifecycle_state ?? metadata.lifecycle ?? '').trim().toLowerCase();
  return lifecycle === 'archived' || Boolean(sourceArchivedAt(row));
}

function SourceLifecycleChip({ row }: { row: WebhookSourceRow | WebhookSourceDirectoryRow }) {
  return isArchivedSource(row)
    ? <Chip label="Archived" kind="warn" size="xs" />
    : <Chip label="Open" kind="good" size="xs" />;
}

export function SourcesModule() {
  const drawer = useDrawer();
  const modal = useModal();
  const navigate = useConsoleNavigator();
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.WEBHOOKS_READ);
  const tenantId = scope.tenant?.id ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const settingsScope = useMemo(
    () => (tenantId ? { tenant: { id: tenantId } } : undefined),
    [tenantId],
  );
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const sourcesQuery = useResourceList<WebhookSourceRow>('webhook_sources', tenantListOpts, readQueryOptions);
  // W27 — paired projection view `public.v_webhook_source_directory`
  // (supabase/migrations/202604302500_v_webhook_source_directory.sql). Surfaces
  // mapping_label / last_event_at / last_event_status / event_count_24h /
  // error_count_24h / rule_count / active_rule_count / is_healthy /
  // has_recent_errors / auth_token_masked. Production swap stays a single
  // `getSupabaseClient()` branch in
  // `data-source.ts:ui_list_resource_v1('webhook_source_directory')`.
  const sourceDirectoryQuery =
    useResourceList<WebhookSourceDirectoryRow>('webhook_source_directory', tenantListOpts, readQueryOptions);
  const mappingDirectoryQuery =
    useResourceList<MappingConfigOptionRow>('mapping_config_directory', tenantListOpts, readQueryOptions);
  const senderDirectoryQuery = useResourceList<SenderOptionRow>(
    'sender_summary',
    tenantId ? { filter: { organization_id_resolved: tenantId } } : undefined,
    readQueryOptions,
  );
  const credentialDirectoryQuery =
    useResourceList<IntegrationCredentialOptionRow>('integration_credential_directory', tenantListOpts, readQueryOptions);
  const upsertSource = useUpsertWebhookSource();
  const rotateToken = useRotateWebhookSourceToken();
  const archiveSource = useArchiveWebhookSource();

  // Cycle E P2 #14 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the
  // default rate limit for new webhook sources resolves through canonical
  // `webhook_source_default_policy.default_rate_limit_per_hour`.
  // Replaces the inline `?? 1000` literal in the new-source form.
  const sourceDefaultPolicy = useResolveSettings('webhook_source_default_policy', settingsScope, readQueryOptions);
  const sourceDefaultPolicyValue = sourceDefaultPolicy.data?.value as
    | { default_rate_limit_per_hour?: number }
    | undefined;
  const defaultRateLimitPerHour =
    sourceDefaultPolicyValue?.default_rate_limit_per_hour ?? null;

  function applyTokenToTester(
    target: ExternalIntakeTokenTarget,
    token: string,
    sourceName: string,
    sourceId?: string | null,
  ) {
    const stashed = stashExternalIntakeSourceToken(target, {
      token,
      source_id: sourceId ?? null,
      source_name: sourceName,
    });
    if (!stashed) {
      pushToast('Token handoff is unavailable in this browser session. Copy the token manually.', 'warn');
      return;
    }
    modal.close();
    navigate(externalIntakeTargetPath(target));
  }

  function openOneTimeTokenModal(sourceName: string, token: string, tokenStatus?: string, sourceId?: string | null) {
    modal.open({
      title: `Rotated token - ${sourceName}`,
      body: (
        <div className="card" style={{ background: 'var(--paper-2)' }}>
          <div className="eyebrow">One-time source token</div>
          <p className="state__hint" style={{ margin: '4px 0 8px' }}>
            Use this once in External Intake &gt; Test webhook intake or API request intake. It will not be shown again.
          </p>
          {tokenStatus ? (
            <p className="state__hint" style={{ margin: '0 0 8px' }}>
              Token state: {tokenStatus}
            </p>
          ) : null}
          <code className="mono" style={{ wordBreak: 'break-all' }}>{token}</code>
        </div>
      ),
      footer: (
        <>
          <Button
            label="Use in Test webhook intake"
            iconName="webhook"
            kind="ghost"
            onClick={() => applyTokenToTester('webhook-tester', token, sourceName, sourceId)}
          />
          <Button
            label="Use in API request intake"
            iconName="plug"
            kind="ghost"
            onClick={() => applyTokenToTester('api-gateway', token, sourceName, sourceId)}
          />
          <Button label="Done" kind="primary" onClick={() => modal.close()} />
        </>
      ),
    });
  }

  async function rotateSourceToken(row: WebhookSourceRow, options?: { refreshDrawer?: boolean }): Promise<void> {
    const result = await rotateToken.mutateAsync({ source_id: row.id });
    const directory = await requireWebhookSourceTokenReadback(row.id);
    if (options?.refreshDrawer) {
      openSourceDrawer(row, directory);
    }
    const mintedToken = typeof result.auth_token === 'string' && result.auth_token.trim()
      ? result.auth_token.trim()
      : '';
    if (mintedToken) {
      openOneTimeTokenModal(row.name, mintedToken, authTokenStatusLabel(directory), row.id);
    }
    pushToast(`Rotated · ${row.name}`, 'good');
  }

  const rawSources = useMemo(
    () => sourcesQuery.data?.rows ?? [],
    [sourcesQuery.data],
  );
  const sourceDirectoryById = useMemo(() => {
    const map = new Map<string, WebhookSourceDirectoryRow>();
    for (const r of sourceDirectoryQuery.data?.rows ?? []) {
      map.set(r.id, r);
    }
    return map;
  }, [sourceDirectoryQuery.data]);
  const mappingOptions = useMemo(
    () => mappingDirectoryQuery.data?.rows ?? [],
    [mappingDirectoryQuery.data],
  );
  const mappingOptionsById = useMemo(() => {
    const map = new Map<string, MappingConfigOptionRow>();
    for (const option of mappingOptions) {
      map.set(option.id, option);
    }
    return map;
  }, [mappingOptions]);

  // Decorate each source row with the W27 projection-derived fields. Prefer
  // projection values over the canonical row's optional last_event_at so the
  // demo + production behave the same.
  const sources = useMemo(
    () =>
      rawSources.map((s) => {
        const proj = sourceDirectoryById.get(s.id);
        if (!proj) return s;
        return {
          ...s,
          last_event_at: proj.last_event_at ?? s.last_event_at ?? null,
          // Carry the projection counters through for column rendering.
          mapping_label: proj.mapping_label ?? null,
          last_event_status: proj.last_event_status ?? null,
          event_count_24h: proj.event_count_24h ?? 0,
          error_count_24h: proj.error_count_24h ?? 0,
          rule_count: proj.rule_count ?? 0,
          active_rule_count: proj.active_rule_count ?? 0,
          is_healthy: proj.is_healthy ?? false,
          has_recent_errors: proj.has_recent_errors ?? false,
          auth_token_masked: proj.auth_token_masked ?? null,
          sender_id: proj.sender_id ?? s.sender_id ?? null,
          client_id: proj.client_id ?? null,
          sender_label: proj.sender_label ?? null,
          client_label: proj.client_label ?? null,
          hmac_enabled: proj.hmac_enabled ?? false,
          hmac_auth_config_id: proj.hmac_auth_config_id ?? null,
          hmac_header: proj.hmac_header ?? null,
          hmac_algorithm: proj.hmac_algorithm ?? null,
          hmac_signature_encoding: proj.hmac_signature_encoding ?? null,
          lifecycle_state: proj.lifecycle_state ?? s.lifecycle_state ?? null,
          archived_at: proj.archived_at ?? s.archived_at ?? null,
          archived_by: proj.archived_by ?? s.archived_by ?? null,
          archive_reason: proj.archive_reason ?? s.archive_reason ?? null,
          managed_metadata: proj.managed_metadata ?? s.managed_metadata ?? null,
        } as WebhookSourceRow & WebhookSourceDirectoryRow;
      }),
    [rawSources, sourceDirectoryById],
  );
  const senderOptions = useMemo(
    () => senderDirectoryQuery.data?.rows ?? [],
    [senderDirectoryQuery.data],
  );
  const hmacCredentialOptions = useMemo(
    () =>
      (credentialDirectoryQuery.data?.rows ?? []).filter((row) => {
        if (String(row.auth_type ?? '').toLowerCase() !== 'hmac') return false;
        if (row.is_active === false) return false;
        return String(row.status ?? '').toLowerCase() !== 'revoked';
      }),
    [credentialDirectoryQuery.data],
  );

  function openSourceForm(row?: WebhookSourceRow) {
    function SourceForm() {
      const formId = useId();
      const displayNameId = `${formId}-display-name`;
      const sourceReferenceId = `${formId}-source-reference`;
      const sourceReferenceHintId = `${formId}-source-reference-hint`;
      const providerId = `${formId}-provider`;
      const mappingId = `${formId}-mapping`;
      const senderId = `${formId}-sender`;
      const rateLimitId = `${formId}-rate-limit`;
      const enabledId = `${formId}-enabled`;
      const enabledLabelId = `${enabledId}-label`;
      const hmacModeId = `${formId}-hmac-mode`;
      const hmacCredentialId = `${formId}-hmac-credential`;
      const hmacHeaderId = `${formId}-hmac-header`;
      // Canonical default: first row of `webhook_provider_type` lookup
      // (rank-ordered SSOT). No hardcoded 'shopify' default — when the row is
      // missing the form simply has no preselected provider, which is honest
      // (the operator must choose) rather than silently coercing to a value
      // that may not match the canonical lookup ordering.
      const lookups = api.getLookups('webhook_provider_type') ?? [];
      const canonicalDefaultProvider = (lookups[0]?.value ?? '') as WebhookSourceRow['provider_type'];
      const formMappingOptions = useMemo(
        () => mappingOptionsForSource(mappingOptions, row),
        [mappingOptions, row],
      );
      const enabledOptions = useMemo(() => enabledStateOptions(), []);
      const [formState, setFormState] = useState<Partial<WebhookSourceRow>>({
        name: row?.name ?? '',
        source_identifier: row?.source_identifier ?? '',
        provider_type: row?.provider_type ?? canonicalDefaultProvider,
        mapping_config_id: row?.mapping_config_id ?? formMappingOptions[0]?.id ?? '',
        sender_id: row ? (row.sender_id ?? '') : (senderOptions[0]?.id ?? ''),
        // Cycle E P2 #14 closure: rate limit default from canonical
        // `webhook_source_default_policy.default_rate_limit_per_hour`.
        // No inline `?? 1000` literal.
        rate_limit_per_hour: row?.rate_limit_per_hour ?? defaultRateLimitPerHour ?? undefined,
        enabled: row?.enabled ?? true,
        hmac_enabled: row?.hmac_enabled ?? false,
        hmac_auth_config_id: row?.hmac_auth_config_id ?? '',
        hmac_header: row?.hmac_header ?? '',
      });
      useEffect(() => {
        setFormState((prev) => {
          if (prev.mapping_config_id || !formMappingOptions[0]?.id) return prev;
          return { ...prev, mapping_config_id: formMappingOptions[0].id };
        });
      }, [formMappingOptions]);
      useEffect(() => {
        if (row || defaultRateLimitPerHour == null) return;
        setFormState((prev) => {
          if (prev.rate_limit_per_hour != null) return prev;
          return { ...prev, rate_limit_per_hour: defaultRateLimitPerHour };
        });
      }, [defaultRateLimitPerHour, row]);
      const [err, setErr] = useState<string>('');
      const [submitting, setSubmitting] = useState<boolean>(false);
      const [oneTimeToken, setOneTimeToken] = useState<string>('');
      const [oneTimeSourceId, setOneTimeSourceId] = useState<string | null>(row?.id ?? null);
      const [oneTimeSourceName, setOneTimeSourceName] = useState<string>(row?.name ?? 'Intake source');
      const selectedMappingOption = formMappingOptions.find(
        (option) => option.id === formState.mapping_config_id,
      );
      const senderRequired = mappingRequiresShipmentSender(selectedMappingOption);
      const hmacEnabled = Boolean(formState.hmac_enabled);

      function update<K extends keyof WebhookSourceRow>(key: K, value: WebhookSourceRow[K]) {
        setFormState((prev) => ({ ...prev, [key]: value }));
      }

      async function submit() {
        setErr('');
        const name = String(formState.name ?? '').trim();
        const sourceIdentifier = String(formState.source_identifier ?? '').trim();
        if (!name) {
          setErr('Display name is required.');
          return;
        }
        if (!sourceIdentifier) {
          setErr('Source reference is required.');
          return;
        }
        if (!/[A-Za-z]/.test(sourceIdentifier) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sourceIdentifier)) {
          setErr('Source reference must be an operator key with letters and optional numbers, dots, hyphens, underscores, or colons.');
          return;
        }
        if (!formState.mapping_config_id) {
          setErr('Mapping profile is required.');
          return;
        }
        if (senderRequired && !formState.sender_id) {
          setErr('Shipment-create mappings require a shipment sender so webhook intake can resolve client scope.');
          return;
        }
        if (hmacEnabled && !formState.hmac_auth_config_id) {
          setErr('Choose an HMAC credential before requiring receiver signatures.');
          return;
        }
        setSubmitting(true);
        try {
          const expected = {
            source_id: row?.id ?? null,
            name,
            source_identifier: sourceIdentifier,
            provider_type: formState.provider_type,
            mapping_config_id: formState.mapping_config_id || null,
            sender_id: formState.sender_id || null,
            rate_limit_per_hour: formState.rate_limit_per_hour ?? null,
            enabled: formState.enabled ?? true,
            hmac_enabled: hmacEnabled,
            hmac_auth_config_id: hmacEnabled ? formState.hmac_auth_config_id || null : null,
            hmac_header: hmacEnabled ? String(formState.hmac_header ?? '').trim() || null : null,
          };
          const result = await upsertSource.mutateAsync({
            source_id: row?.id ?? null,
            ...(tenantId ? { organization_id: tenantId } : {}),
            name: expected.name,
            source_identifier: expected.source_identifier,
            provider_type: expected.provider_type,
            mapping_config_id: expected.mapping_config_id,
            sender_id: expected.sender_id,
            rate_limit_per_hour: expected.rate_limit_per_hour,
            enabled: expected.enabled,
            hmac_enabled: expected.hmac_enabled,
            hmac_auth_config_id: expected.hmac_auth_config_id,
            hmac_header: expected.hmac_header,
          });
          await requireWebhookSourceReadback({ result, expected });
          const mintedToken = typeof result.auth_token === 'string' && result.auth_token.trim()
            ? result.auth_token.trim()
            : '';
          if (mintedToken) {
            const resultSourceId =
              typeof result.webhook_source_id === 'string' && result.webhook_source_id.trim()
                ? result.webhook_source_id.trim()
                : typeof result.source_id === 'string' && result.source_id.trim()
                  ? result.source_id.trim()
                  : typeof result.id === 'string' && result.id.trim()
                    ? result.id.trim()
                    : row?.id ?? null;
            setOneTimeSourceId(resultSourceId);
            setOneTimeSourceName(name);
            setOneTimeToken(mintedToken);
          } else {
            modal.close();
          }
          pushToast(
            row ? `Updated · ${name}` : `Created intake source · ${name}`,
            'good',
          );
        } catch (e) {
          setErr((e as Error)?.message ?? 'Save failed');
        } finally {
          setSubmitting(false);
        }
      }

      return (
        <>
          <p className="state__hint">
            {row
          ? 'Edits are dispatched through the canonical source toggle path.'
          : 'New sources are created through the canonical webhook-source upsert path.'}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '160px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: '12px',
            }}
          >
            <label className="mono" htmlFor={displayNameId}>Display name</label>
            <input
              id={displayNameId}
              aria-label="Intake source display name"
              className="dt-inline-input"
              type="text"
              placeholder="e.g. Exampleparcel KSA production"
              value={formState.name ?? ''}
              onChange={(e) => update('name', e.target.value)}
            />
            <label className="mono" htmlFor={sourceReferenceId}>Source reference</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <input
                id={sourceReferenceId}
                aria-label="Intake source reference"
                aria-describedby={sourceReferenceHintId}
                className="dt-inline-input"
                type="text"
                placeholder="e.g. exampleparcel-ksa-prod"
                value={formState.source_identifier ?? ''}
                onChange={(e) => update('source_identifier', e.target.value)}
              />
              <p id={sourceReferenceHintId} className="state__hint" style={{ margin: 0 }}>
                Stable source reference used when partners send intake requests.
              </p>
            </div>
            <label className="mono" htmlFor={providerId}>Provider</label>
            <select
              id={providerId}
              aria-label="Intake source provider"
              className="dt-inline-input"
              value={formState.provider_type ?? canonicalDefaultProvider}
              onChange={(e) =>
                update('provider_type', e.target.value as WebhookSourceRow['provider_type'])
              }
            >
              {lookups.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor={mappingId}>Mapping profile</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <select
                id={mappingId}
                aria-label="Intake source mapping profile"
                className="dt-inline-input"
                value={formState.mapping_config_id ?? ''}
                onChange={(e) => update('mapping_config_id', e.target.value)}
                disabled={formMappingOptions.length === 0}
              >
                {formMappingOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {mappingOptionLabel(option)}
                  </option>
                ))}
              </select>
              {formMappingOptions.length === 0 ? (
                <StateView
                  kind="error"
                  title="No source-bindable mapping profile"
                  hint="Activate an intake plugin binding before creating an intake source."
                />
              ) : null}
            </div>
            <label className="mono" htmlFor={senderId}>Shipment sender</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <select
                id={senderId}
                aria-label="Intake source shipment sender"
                className="dt-inline-input"
                value={formState.sender_id ?? ''}
                onChange={(e) => update('sender_id', e.target.value || null)}
              >
                <option value="">No shipment sender</option>
                {senderOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {senderOptionLabel(option)}
                  </option>
                ))}
              </select>
              {senderRequired ? (
                <p className="state__hint" style={{ margin: 0 }}>
                  Required for shipment-create mappings so intake resolves the client and materializes shipments.
                </p>
              ) : null}
            </div>
            <label className="mono" htmlFor={rateLimitId}>Rate limit / hr</label>
            <input
              id={rateLimitId}
              aria-label="Intake source hourly rate limit"
              className="dt-inline-input"
              type="number"
              value={formState.rate_limit_per_hour ?? ''}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                update(
                  'rate_limit_per_hour',
                  (Number.isFinite(parsed) ? parsed : undefined) as WebhookSourceRow['rate_limit_per_hour'],
                );
              }}
            />
            <span className="mono" id={enabledLabelId}>Enabled</span>
            <div style={{ display: 'grid', gap: '6px' }}>
              <div
                id={enabledId}
                role="radiogroup"
                aria-label="Intake source enabled state"
                style={{
                  display: 'grid',
                  gridTemplateColumns: enabledOptions.length > 1 ? `repeat(${enabledOptions.length}, minmax(0, 1fr))` : '1fr',
                  gap: '6px',
                }}
              >
                {enabledOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={Boolean(formState.enabled ?? true) === option.enabled}
                    className={`btn btn--sm ${
                      Boolean(formState.enabled ?? true) === option.enabled ? 'btn--primary' : 'btn--ghost'
                    }`}
                    onClick={() => update('enabled', option.enabled)}
                    style={{ justifyContent: 'center' }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {enabledOptions.length === 0 ? (
                <StateView
                  kind="error"
                  title="Enabled-state lookup missing"
                  hint="Enabled-state options are not configured. Finish intake source setup before saving source state."
                />
              ) : null}
            </div>
            <label className="mono" htmlFor={hmacModeId}>Receiver auth</label>
            <select
              id={hmacModeId}
              className="dt-inline-input"
              aria-label="Intake source HMAC validation"
              value={hmacEnabled ? 'hmac' : 'token'}
              onChange={(e) => {
                const nextEnabled = e.target.value === 'hmac';
                update('hmac_enabled', nextEnabled);
                if (nextEnabled && !formState.hmac_auth_config_id && hmacCredentialOptions[0]?.id) {
                  update('hmac_auth_config_id', hmacCredentialOptions[0].id);
                }
              }}
            >
              <option value="token">Token only</option>
              <option value="hmac">Token + HMAC signature</option>
            </select>
            <label className="mono" htmlFor={hmacCredentialId}>HMAC credential</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <select
                id={hmacCredentialId}
                className="dt-inline-input"
                aria-label="Intake source HMAC credential"
                value={formState.hmac_auth_config_id ?? ''}
                onChange={(e) => update('hmac_auth_config_id', e.target.value || null)}
                disabled={!hmacEnabled || hmacCredentialOptions.length === 0}
              >
                <option value="">No HMAC credential</option>
                {hmacCredentialOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {hmacCredentialOptionLabel(option)}
                  </option>
                ))}
              </select>
              {hmacEnabled && hmacCredentialOptions.length === 0 ? (
                <StateView
                  kind="error"
                  title="No HMAC credential"
                  hint="Create an HMAC provider credential before requiring receiver signatures."
                />
              ) : null}
            </div>
            <label className="mono" htmlFor={hmacHeaderId}>Signature header</label>
            <input
              id={hmacHeaderId}
              aria-label="Intake source HMAC signature header"
              className="dt-inline-input"
              type="text"
              placeholder="x-signature"
              value={formState.hmac_header ?? ''}
              onChange={(e) => update('hmac_header', e.target.value)}
              disabled={!hmacEnabled}
            />
          </div>
          <div style={{ color: 'var(--danger-ink)', fontSize: '11px', padding: '0 14px', minHeight: '14px' }}>
            {err}
          </div>
          {oneTimeToken ? (
            <div className="card" style={{ background: 'var(--paper-2)', marginTop: '10px' }}>
              <div className="eyebrow">One-time source token</div>
              <p className="state__hint" style={{ margin: '4px 0 8px' }}>
                Use this once in External Intake &gt; Test webhook intake or API request intake. It will not be shown again.
              </p>
              <code className="mono" style={{ wordBreak: 'break-all' }}>{oneTimeToken}</code>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
                <Button
                  label="Use in Test webhook intake"
                  iconName="webhook"
                  kind="ghost"
                  onClick={() => applyTokenToTester('webhook-tester', oneTimeToken, oneTimeSourceName, oneTimeSourceId)}
                />
                <Button
                  label="Use in API request intake"
                  iconName="plug"
                  kind="ghost"
                  onClick={() => applyTokenToTester('api-gateway', oneTimeToken, oneTimeSourceName, oneTimeSourceId)}
                />
              </div>
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={oneTimeToken ? 'Done' : 'Cancel'} kind="ghost" onClick={() => modal.close()} disabled={submitting} />
            <Button
              label={submitting ? 'Saving…' : row ? 'Save' : 'Create'}
              kind="primary"
              capability={CAP.WEBHOOKS_WRITE}
              onClick={submit}
              disabled={submitting || Boolean(oneTimeToken) || formMappingOptions.length === 0 || enabledOptions.length === 0}
            />
          </div>
        </>
      );
    }
    modal.open({ title: row ? `Edit · ${row.name}` : 'New intake source', body: <SourceForm /> });
  }

  function openArchiveSourceModal(row: WebhookSourceRow) {
    function ArchiveSourceForm() {
      const [reason, setReason] = useState('');
      return (
        <div>
          <p className="state__hint">
            Archiving keeps source history visible, disables intake, and records the operator reason.
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
            <label className="mono" htmlFor="webhook-source-archive-reason">Reason</label>
            <input
              id="webhook-source-archive-reason"
              className="dt-inline-input"
              placeholder="e.g. Tenant moved to a new integration source"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Archive source"
              iconName="trash"
              kind="danger"
              capability={CAP.WEBHOOKS_WRITE}
              onClick={async () => {
                const trimmedReason = reason.trim();
                if (!trimmedReason) {
                  pushToast('Archive reason is required', 'warn');
                  return;
                }
                try {
                  await archiveSource.mutateAsync({ source_id: row.id, reason: trimmedReason });
                  await requireWebhookSourceStateReadback(row.id, { enabled: false, archived: true });
                  modal.close();
                  pushToast(`Archived · ${row.name}`, 'warn');
                } catch (e) {
                  pushToast(`Archive failed · ${(e as Error)?.message ?? ''}`, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: `Archive · ${row.name}`, body: <ArchiveSourceForm /> });
  }

  function openSourceDrawer(row: WebhookSourceRow, projectionOverride?: WebhookSourceDirectoryRow) {
    // W27 projection — additive directory join for KvRow rendering.
    const proj = projectionOverride ?? sourceDirectoryById.get(row.id);
    const eventCount24h = proj?.event_count_24h ?? 0;
    const errorCount24h = proj?.error_count_24h ?? 0;
    const ruleCount = proj?.rule_count ?? 0;
    const activeRuleCount = proj?.active_rule_count ?? 0;
    const isHealthy = proj?.is_healthy ?? false;
    const tokenStatus = authTokenStatusLabel(proj);
    const tokenStatusReadback = proj
      ? `Token status confirmed: ${tokenStatus}`
      : 'Token status confirmation pending';
    const summaryRows: KvRow[] = [
      { key: 'name', label: 'Name', value: row.name },
      { key: 'id', label: 'Source confirmation', value: row.id ? 'Available' : '—' },
      { key: 'source_id', label: 'Source ID', value: row.id, mono: true },
      { key: 'source_identifier', label: 'Source reference', value: operatorReference('Source', row.source_identifier), mono: true },
      {
        key: 'provider_type',
        label: 'Provider',
        value: providerLabel(row.provider_type),
      },
      {
        key: 'auth_token_status',
        label: 'Auth token status',
        value: tokenStatus,
      },
      {
        key: 'hmac_validation',
        label: 'Receiver auth',
        value: hmacValidationLabel(row as WebhookSourceRow & WebhookSourceDirectoryRow),
      },
      {
        key: 'mapping_config_id',
        label: 'Mapping',
        value: row.mapping_config_id
          ? sourceMappingLabel(row.mapping_config_id, row as WebhookSourceRow & WebhookSourceDirectoryRow, mappingOptionsById)
          : '—',
      },
      {
        key: 'sender_id',
        label: 'Shipment sender',
        value: sourceSenderLabel(row as WebhookSourceRow & WebhookSourceDirectoryRow),
      },
      {
        key: 'rate_limit_per_hour',
        label: 'Rate / hr',
        value: row.rate_limit_per_hour != null ? String(row.rate_limit_per_hour) : '—',
        mono: true,
      },
      {
        key: 'enabled',
        label: 'Enabled',
        value: enabledLabel(row.enabled),
      },
      {
        key: 'lifecycle',
        label: 'Lifecycle',
        value: isArchivedSource(row) ? 'Archived' : 'Open',
      },
      ...(isArchivedSource(row)
        ? [
            {
              key: 'archived_at',
              label: 'Archived at',
              value: sourceArchivedAt(row) ? new Date(sourceArchivedAt(row) as string).toLocaleString() : '—',
              mono: true,
            },
            {
              key: 'archive_reason',
              label: 'Archive reason',
              value: sourceArchiveReason(row) ?? '—',
            },
          ] satisfies KvRow[]
        : []),
      {
        key: 'health',
        label: 'Health',
        value: healthLabel(isHealthy, errorCount24h),
      },
      {
        key: 'event_count_24h',
        label: 'Events 24h',
        value: String(eventCount24h),
        mono: true,
      },
      {
        key: 'error_count_24h',
        label: 'Errors 24h',
        value: String(errorCount24h),
        mono: true,
      },
      {
        key: 'rule_count',
        label: 'Routing rules',
        value: `${activeRuleCount} active · ${ruleCount} total`,
        mono: true,
      },
      {
        key: 'last_event_at',
        label: 'Last event',
        value: row.last_event_at ? new Date(row.last_event_at).toLocaleString() : '—',
        mono: true,
      },
      {
        key: 'last_event_status',
        label: 'Last status',
        value: proj?.last_event_status ?? '—',
        mono: true,
      },
    ];
    drawer.open({
      title: `${row.name} · ${operatorReference('Source', row.source_identifier)}`,
      size: 'lg',
      deepLink: `/integrations/sources?focus=${row.id}`,
      body: (
        <div className="rail-body" style={{ padding: '0 0 8px' }}>
          <h4 className="eyebrow">Intake source</h4>
          <KvGrid rows={summaryRows} />
          <p
            className="state__hint"
            data-testid="source-token-readback-status"
            style={{ margin: '8px 14px 0' }}
          >
            {tokenStatusReadback}
          </p>
          <div className="section-eyebrow" style={{ marginTop: '14px' }}>
            Routing
          </div>
          <p className="state__hint" style={{ padding: '0 14px' }}>
            See{' '}
            <a
              href="/integrations/rules"
              onClick={(e) => {
                e.stopPropagation();
                drawer.close();
                navigate('/integrations/rules');
              }}
            >
              routing rules
            </a>{' '}
            scoped to this source for the dispatch matrix.
          </p>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <Button
            label="Rotate token"
            iconName="refresh"
            kind="ghost"
            capability={CAP.WEBHOOKS_WRITE}
            disabled={isArchivedSource(row)}
            onClick={async () => {
              try {
                await rotateSourceToken(row, { refreshDrawer: true });
              } catch (e) {
                pushToast(`Rotate failed · ${(e as Error)?.message ?? ''}`, 'danger');
              }
            }}
          />
          <div style={{ flex: 1 }} />
          <Button
            label="Archive"
            iconName="trash"
            kind="danger"
            capability={CAP.WEBHOOKS_WRITE}
            disabled={isArchivedSource(row)}
            onClick={() => {
              drawer.close();
              openArchiveSourceModal(row);
            }}
          />
          <Button
            label="Edit"
            iconName="edit"
            kind="primary"
            capability={CAP.WEBHOOKS_WRITE}
            disabled={isArchivedSource(row)}
            onClick={() => {
              drawer.close();
              openSourceForm(row);
            }}
          />
        </div>
      ),
    });
  }

  // Deep-link: open drawer if URL has ?focus=<id>.
  // Cycle E P2 #16 closure (AGENTS.md §2 ZERO HARDCODING): defer drawer open
  // to the next animation frame instead of a magic-number `setTimeout(100)`.
  // requestAnimationFrame waits for layout commit so the drawer mounts
  // after sources finish rendering — same effect, no magic constant.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focus = params.get('focus');
    if (!focus || !sources.length) return;
    const target = sources.find((s) => s.id === focus || s.source_identifier === focus);
    if (target) {
      const handle = window.requestAnimationFrame(() => openSourceDrawer(target));
      return () => window.cancelAnimationFrame(handle);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  const COLUMNS: Array<DataTableColumn<WebhookSourceRow>> = [
    { key: 'name', label: 'Name', sortable: true },
    {
      key: 'source_identifier',
      label: 'Source reference',
      mono: true,
      sortable: true,
      filterable: true,
      render: (raw) => <span className="mono">{operatorReference('Source', raw)}</span>,
    },
    {
      key: 'provider_type',
      label: 'Provider',
      filterable: true,
      sortable: true,
      render: (raw) => <ProviderChip value={String(raw)} />,
    },
    {
      key: 'mapping_config_id',
      label: 'Mapping',
      render: (raw, row) => {
        const v = String(raw ?? '');
        if (!v) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        const label = sourceMappingLabel(v, row as WebhookSourceRow & WebhookSourceDirectoryRow, mappingOptionsById);
        const href = `/integrations/mapping?focus=${encodeURIComponent(v)}`;
        return (
          <a
            href={href}
            onClick={(e) => {
              e.stopPropagation();
              navigate(href);
            }}
            className={isTechnicalMappingKey(label) ? 'mono' : undefined}
          >
            {label}
          </a>
        );
      },
    },
    {
      key: 'sender_id',
      label: 'Sender / client',
      render: (_raw, row) => sourceSenderLabel(row as WebhookSourceRow & WebhookSourceDirectoryRow),
    },
    { key: 'rate_limit_per_hour', label: 'Rate / hr', align: 'right', mono: true, sortable: true },
    {
      key: 'enabled',
      label: 'Enabled',
      filterable: true,
      sortable: true,
      render: (raw) => <EnabledChip value={!!raw} />,
    },
    {
      key: 'lifecycle_state',
      label: 'Lifecycle',
      filterable: true,
      render: (_raw, row) => <SourceLifecycleChip row={row as WebhookSourceRow & WebhookSourceDirectoryRow} />,
    },
    {
      key: 'hmac_enabled',
      label: 'Receiver auth',
      filterable: true,
      render: (_raw, row) => (
        <HmacValidationChip row={row as WebhookSourceRow & WebhookSourceDirectoryRow} />
      ),
    },
    {
      key: 'auth_token_masked',
      label: 'Token',
      filterable: true,
      render: (_raw, row) => (
        <Chip
          size="xs"
          kind={(row as WebhookSourceRow & WebhookSourceDirectoryRow).auth_token_masked ? 'good' : 'warn'}
          label={authTokenStatusLabel(row as WebhookSourceRow & WebhookSourceDirectoryRow)}
        />
      ),
    },
    // W27 projection-derived columns. Render uses the row's `is_healthy` /
    // `event_count_24h` / `error_count_24h` / `rule_count` shadows that the
    // memoized decorator above attaches when v_webhook_source_directory is
    // available.
    {
      key: 'is_healthy',
      label: 'Healthy',
      filterable: true,
      sortable: true,
      render: (raw, row) => {
        const errors = (row as { error_count_24h?: number }).error_count_24h ?? 0;
        return <HealthChip isHealthy={!!raw} errorCount24h={errors} />;
      },
    },
    {
      key: 'event_count_24h',
      label: 'Events 24h',
      align: 'right',
      mono: true,
      sortable: true,
      type: 'number',
    },
    {
      key: 'error_count_24h',
      label: 'Errors 24h',
      align: 'right',
      mono: true,
      sortable: true,
      type: 'number',
    },
    {
      key: 'rule_count',
      label: 'Rules',
      align: 'right',
      mono: true,
      sortable: true,
      type: 'number',
    },
    { key: 'last_event_at', label: 'Last event', format: 'datetime', sortable: true },
  ];

  const ROW_ACTIONS: Array<DataTableAction<WebhookSourceRow>> = [
    { label: 'Open detail', icon: 'eye', onClick: openSourceDrawer },
    {
      label: 'Edit',
      icon: 'edit',
      kind: 'primary',
      capability: CAP.WEBHOOKS_WRITE,
      disabled: (row) => isArchivedSource(row),
      disabledReason: 'Archived sources are retained for audit and cannot be edited.',
      onClick: openSourceForm,
    },
    {
      label: 'Rotate token',
      icon: 'refresh',
      capability: CAP.WEBHOOKS_WRITE,
      disabled: (row) => isArchivedSource(row),
      disabledReason: 'Archived sources are retained for audit and cannot rotate tokens.',
      onClick: async (row) => {
        try {
          await rotateSourceToken(row);
        } catch (e) {
          pushToast(`Rotate failed · ${(e as Error)?.message ?? ''}`, 'danger');
        }
      },
    },
    {
      label: 'Toggle enabled',
      icon: 'bolt',
      capability: CAP.WEBHOOKS_WRITE,
      disabled: (row) => isArchivedSource(row),
      disabledReason: 'Archived sources are already disabled for intake.',
      onClick: async (row) => {
        const nextEnabled = !row.enabled;
        try {
          await upsertSource.mutateAsync({
            source_id: row.id,
            ...(tenantId ? { organization_id: tenantId } : {}),
            enabled: nextEnabled,
          });
          await requireWebhookSourceStateReadback(row.id, { enabled: nextEnabled });
          pushToast(
            `${row.name} · ${nextEnabled ? 'enabled' : 'disabled'}`,
            nextEnabled ? 'good' : 'warn',
          );
        } catch (e) {
          pushToast(`Toggle failed · ${(e as Error)?.message ?? ''}`, 'danger');
        }
      },
    },
    {
      label: 'Archive source',
      icon: 'trash',
      kind: 'danger',
      capability: CAP.WEBHOOKS_WRITE,
      hidden: (row) => isArchivedSource(row),
      onClick: openArchiveSourceModal,
    },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="integrations-sources"
          eyebrow="External intake"
          titleAccent="Sources"
          titlePlain="& tokens"
          pills={[]}
        />
        <StateView
          kind="denied"
          capability={CAP.WEBHOOKS_READ}
          hint="You do not have permission to view intake sources."
        />
      </div>
    );
  }

  if (sourcesQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="integrations-sources"
          eyebrow="External intake"
          titleAccent="Sources"
          titlePlain="& tokens"
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (sourcesQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="integrations-sources"
          eyebrow="External intake"
          titleAccent="Sources"
          titlePlain="& tokens"
          pills={[]}
        />
        <StateView kind="error" hint={String(sourcesQuery.error)} />
      </div>
    );
  }

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip key="reg" size="xs" label="Source list" />,
    <Chip
      key="dir"
      size="xs"
      label="Health summary"
      kind="info"
    />,
    <Chip key="rls" size="xs" label="Access controlled" kind="info" />,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="integrations-sources"
        eyebrow="External intake"
        titleAccent="Sources"
        titlePlain="& tokens"
        pills={pills}
        actions={[
          <Button
            key="new"
            label="New intake source"
            iconName="plus"
            kind="primary"
            capability={CAP.WEBHOOKS_WRITE}
            onClick={() => openSourceForm()}
          />,
        ]}
      />
      <ExternalIntakeWorkspaceToolbar activePath="/integrations/sources" />
      <DataTable<WebhookSourceRow>
        columns={COLUMNS}
        rows={sources}
        viewKey="webhook_sources"
        entityKind="webhook_source"
        searchKeys={['name', 'source_identifier', 'mapping_config_id']}
        onRowClick={openSourceDrawer}
        rowDeepLink={(r) => `/integrations/sources?focus=${r.id}`}
        getRowClass={(r) => (!r.enabled ? 'is-risk' : undefined)}
        rowActions={ROW_ACTIONS}
      />
      {drawer.node}
      {modal.node}
    </div>
  );
}

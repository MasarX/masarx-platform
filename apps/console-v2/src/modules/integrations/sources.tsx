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
import { fill, useI18n, type Translate } from '@/lib/i18n';

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
  const { t } = useI18n();
  const r = lookupRow('webhook_provider_type', value);
  if (!r) return <Chip label={fill(t('integrationsSources.providerChip.unknownProvider'), { value: String(value) })} kind="danger" size="xs" />;
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

type ReferenceKind = 'mapping' | 'sender' | 'source';

function operatorReference(t: Translate, kind: ReferenceKind, value: unknown): string {
  const raw = String(value ?? '').trim();
  const friendly = shortReference(raw);
  const shown = !raw ? t('integrationsSources.reference.none') : friendly === raw ? raw : `${friendly} (${raw})`;
  return fill(t(`integrationsSources.reference.${kind}`), { value: shown });
}

function authTokenStatusLabel(t: Translate, projection: WebhookSourceDirectoryRow | undefined): string {
  if (!projection) return t('integrationsSources.sourcesModule.tokenStateUnavailable');
  return projection.auth_token_masked
    ? t('integrationsSources.sourcesModule.tokenConfigured')
    : t('integrationsSources.sourcesModule.tokenNotConfigured');
}

function hmacValidationLabel(t: Translate, row: WebhookSourceDirectoryRow | undefined): string {
  if (!row?.hmac_enabled) return t('integrationsSources.sourceForm.tokenOnly');
  const header = String(row.hmac_header ?? '').trim();
  return header
    ? fill(t('integrationsSources.sourcesModule.tokenHmacHeader'), { header })
    : t('integrationsSources.sourcesModule.tokenHmac');
}

function HmacValidationChip({ row }: { row: WebhookSourceDirectoryRow | undefined }) {
  const { t } = useI18n();
  return (
    <Chip
      label={hmacValidationLabel(t, row)}
      kind={row?.hmac_enabled ? 'info' : 'neutral'}
      size="xs"
    />
  );
}

function providerLabel(t: Translate, value: string): string {
  return lookupRow('webhook_provider_type', value)?.label ?? fill(t('integrationsSources.providerChip.unknownProvider'), { value });
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
  t: Translate,
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
  return projected || operatorReference(t, 'mapping', mappingId);
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

function sourceSenderLabel(t: Translate, row: WebhookSourceRow & WebhookSourceDirectoryRow): string {
  const sender = String(row.sender_label ?? '').trim();
  const client = String(row.client_label ?? '').trim();
  if (sender && client) return `${sender} -> ${client}`;
  if (sender) return sender;
  if (row.sender_id) return operatorReference(t, 'sender', row.sender_id);
  return t('integrationsSources.sourcesModule.notBound');
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
  const { t } = useI18n();
  const row = lookupRow('enabled_state', enabledStateKey(value));
  if (!row) return <Chip label={t('integrationsSources.enabledChip.unknownEnabledState')} kind="danger" size="xs" />;
  return <Chip label={row.label ?? row.value} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />;
}

function enabledLabel(t: Translate, value: boolean): string {
  const row = lookupRow('enabled_state', enabledStateKey(value));
  return row?.label ?? (value ? t('integrationsSources.sourcesModule.enabledFallback') : t('integrationsSources.sourcesModule.disabledFallback'));
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
  const { t } = useI18n();
  const healthState = deriveHealthStateKey(isHealthy, errorCount24h);
  const row = lookupRow('webhook_source_health', healthState);
  if (!row)
    return (
      <Chip label={t('integrationsSources.healthChip.unknownSourceHealth')} kind="danger" size="xs" />
    );
  return <Chip label={row.label ?? row.value} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />;
}

function healthLabel(t: Translate, isHealthy: boolean, errorCount24h: number): string {
  const healthState = deriveHealthStateKey(isHealthy, errorCount24h);
  const row = lookupRow('webhook_source_health', healthState);
  return row?.label ?? t('integrationsSources.healthChip.unknownSourceHealth');
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
  const { t } = useI18n();
  return isArchivedSource(row)
    ? <Chip label={t('integrationsSources.sourceLifecycleChip.archived')} kind="warn" size="xs" />
    : <Chip label={t('integrationsSources.sourceLifecycleChip.open')} kind="good" size="xs" />;
}

export function SourcesModule() {
  const { t } = useI18n();
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
      pushToast(t('integrationsSources.sourcesModule.tokenHandoffIsUnavailable'), 'warn');
      return;
    }
    modal.close();
    navigate(externalIntakeTargetPath(target));
  }

  function openOneTimeTokenModal(sourceName: string, token: string, tokenStatus?: string, sourceId?: string | null) {
    modal.open({
      title: fill(t('integrationsSources.sourcesModule.rotatedToken'), { sourceName: String(sourceName) }),
      body: (
        <div className="card" style={{ background: 'var(--paper-2)' }}>
          <div className="eyebrow">{t('integrationsSources.sourcesModule.oneTimeSourceToken')}</div>
          <p className="state__hint" style={{ margin: '4px 0 8px' }}>
            {t('integrationsSources.sourcesModule.useThisOnce')}
          </p>
          {tokenStatus ? (
            <p className="state__hint" style={{ margin: '0 0 8px' }}>
              {fill(t('integrationsSources.sourcesModule.tokenState'), { tokenStatus: String(tokenStatus) })}
            </p>
          ) : null}
          <code className="mono" style={{ wordBreak: 'break-all' }}>{token}</code>
        </div>
      ),
      footer: (
        <>
          <Button
            label={t('integrationsSources.sourcesModule.useInTestWebhook')}
            iconName="webhook"
            kind="ghost"
            onClick={() => applyTokenToTester('webhook-tester', token, sourceName, sourceId)}
          />
          <Button
            label={t('integrationsSources.sourcesModule.useInApiRequest')}
            iconName="plug"
            kind="ghost"
            onClick={() => applyTokenToTester('api-gateway', token, sourceName, sourceId)}
          />
          <Button label={t('integrationsSources.sourcesModule.done')} kind="primary" onClick={() => modal.close()} />
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
      openOneTimeTokenModal(row.name, mintedToken, authTokenStatusLabel(t, directory), row.id);
    }
    pushToast(fill(t('integrationsSources.sourcesModule.rotated'), { name: String(row.name) }), 'good');
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
      const { t } = useI18n();
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
      const [oneTimeSourceName, setOneTimeSourceName] = useState<string>(row?.name ?? t('integrationsSources.sourcesModule.intakeSource'));
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
          setErr(t('integrationsSources.sourceForm.displayNameRequired'));
          return;
        }
        if (!sourceIdentifier) {
          setErr(t('integrationsSources.sourceForm.sourceReferenceRequired'));
          return;
        }
        if (!/[A-Za-z]/.test(sourceIdentifier) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sourceIdentifier)) {
          setErr(t('integrationsSources.sourceForm.sourceReferenceFormat'));
          return;
        }
        if (!formState.mapping_config_id) {
          setErr(t('integrationsSources.sourceForm.mappingProfileRequired'));
          return;
        }
        if (senderRequired && !formState.sender_id) {
          setErr(t('integrationsSources.sourceForm.shipmentSenderRequired'));
          return;
        }
        if (hmacEnabled && !formState.hmac_auth_config_id) {
          setErr(t('integrationsSources.sourceForm.chooseHmacCredential'));
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
            row ? fill(t('integrationsSources.sourceForm.updated'), { name: String(name) }) : fill(t('integrationsSources.sourceForm.createdIntakeSource'), { name: String(name) }),
            'good',
          );
        } catch (e) {
          setErr((e as Error)?.message ?? t('integrationsSources.sourceForm.saveFailed'));
        } finally {
          setSubmitting(false);
        }
      }

      return (
        <>
          <p className="state__hint">
            {row
          ? t('integrationsSources.sourceForm.editsAreDispatchedThrough')
          : t('integrationsSources.sourceForm.newSourcesAreCreated')}
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
            <label className="mono" htmlFor={displayNameId}>{t('integrationsSources.sourceForm.displayName')}</label>
            <input
              id={displayNameId}
              aria-label={t('integrationsSources.sourceForm.intakeSourceDisplayName')}
              className="dt-inline-input"
              type="text"
              placeholder={t('integrationsSources.sourceForm.eGExampleparcelKsa')}
              value={formState.name ?? ''}
              onChange={(e) => update('name', e.target.value)}
            />
            <label className="mono" htmlFor={sourceReferenceId}>{t('integrationsSources.sourceForm.sourceReference')}</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <input
                id={sourceReferenceId}
                aria-label={t('integrationsSources.sourceForm.intakeSourceReference')}
                aria-describedby={sourceReferenceHintId}
                className="dt-inline-input"
                type="text"
                placeholder={t('integrationsSources.sourceForm.eGExampleparcelKsa2')}
                value={formState.source_identifier ?? ''}
                onChange={(e) => update('source_identifier', e.target.value)}
              />
              <p id={sourceReferenceHintId} className="state__hint" style={{ margin: 0 }}>
                {t('integrationsSources.sourceForm.stableSourceReferenceUsed')}
              </p>
            </div>
            <label className="mono" htmlFor={providerId}>{t('integrationsSources.sourceForm.provider')}</label>
            <select
              id={providerId}
              aria-label={t('integrationsSources.sourceForm.intakeSourceProvider')}
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
            <label className="mono" htmlFor={mappingId}>{t('integrationsSources.sourceForm.mappingProfile')}</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <select
                id={mappingId}
                aria-label={t('integrationsSources.sourceForm.intakeSourceMappingProfile')}
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
                  title={t('integrationsSources.sourceForm.noSourceBindableMapping')}
                  hint={t('integrationsSources.sourceForm.activateAnIntakePlugin')}
                />
              ) : null}
            </div>
            <label className="mono" htmlFor={senderId}>{t('integrationsSources.sourceForm.shipmentSender')}</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <select
                id={senderId}
                aria-label={t('integrationsSources.sourceForm.intakeSourceShipmentSender')}
                className="dt-inline-input"
                value={formState.sender_id ?? ''}
                onChange={(e) => update('sender_id', e.target.value || null)}
              >
                <option value="">{t('integrationsSources.sourceForm.noShipmentSender')}</option>
                {senderOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {senderOptionLabel(option)}
                  </option>
                ))}
              </select>
              {senderRequired ? (
                <p className="state__hint" style={{ margin: 0 }}>
                  {t('integrationsSources.sourceForm.requiredForShipmentCreate')}
                </p>
              ) : null}
            </div>
            <label className="mono" htmlFor={rateLimitId}>{t('integrationsSources.sourceForm.rateLimitHr')}</label>
            <input
              id={rateLimitId}
              aria-label={t('integrationsSources.sourceForm.intakeSourceHourlyRate')}
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
            <span className="mono" id={enabledLabelId}>{t('integrationsSources.sourceForm.enabled')}</span>
            <div style={{ display: 'grid', gap: '6px' }}>
              <div
                id={enabledId}
                role="radiogroup"
                aria-label={t('integrationsSources.sourceForm.intakeSourceEnabledState')}
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
                  title={t('integrationsSources.sourceForm.enabledStateLookupMissing')}
                  hint={t('integrationsSources.sourceForm.enabledStateOptionsAre')}
                />
              ) : null}
            </div>
            <label className="mono" htmlFor={hmacModeId}>{t('integrationsSources.sourceForm.receiverAuth')}</label>
            <select
              id={hmacModeId}
              className="dt-inline-input"
              aria-label={t('integrationsSources.sourceForm.intakeSourceHmacValidation')}
              value={hmacEnabled ? 'hmac' : 'token'}
              onChange={(e) => {
                const nextEnabled = e.target.value === 'hmac';
                update('hmac_enabled', nextEnabled);
                if (nextEnabled && !formState.hmac_auth_config_id && hmacCredentialOptions[0]?.id) {
                  update('hmac_auth_config_id', hmacCredentialOptions[0].id);
                }
              }}
            >
              <option value="token">{t('integrationsSources.sourceForm.tokenOnly')}</option>
              <option value="hmac">{t('integrationsSources.sourceForm.tokenHmacSignature')}</option>
            </select>
            <label className="mono" htmlFor={hmacCredentialId}>{t('integrationsSources.sourceForm.hmacCredential')}</label>
            <div style={{ display: 'grid', gap: '6px' }}>
              <select
                id={hmacCredentialId}
                className="dt-inline-input"
                aria-label={t('integrationsSources.sourceForm.intakeSourceHmacCredential')}
                value={formState.hmac_auth_config_id ?? ''}
                onChange={(e) => update('hmac_auth_config_id', e.target.value || null)}
                disabled={!hmacEnabled || hmacCredentialOptions.length === 0}
              >
                <option value="">{t('integrationsSources.sourceForm.noHmacCredential')}</option>
                {hmacCredentialOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {hmacCredentialOptionLabel(option)}
                  </option>
                ))}
              </select>
              {hmacEnabled && hmacCredentialOptions.length === 0 ? (
                <StateView
                  kind="error"
                  title={t('integrationsSources.sourceForm.noHmacCredential')}
                  hint={t('integrationsSources.sourceForm.createAnHmacProvider')}
                />
              ) : null}
            </div>
            <label className="mono" htmlFor={hmacHeaderId}>{t('integrationsSources.sourceForm.signatureHeader')}</label>
            <input
              id={hmacHeaderId}
              aria-label={t('integrationsSources.sourceForm.intakeSourceHmacSignature')}
              className="dt-inline-input"
              type="text"
              placeholder={t('integrationsSources.sourceForm.xSignature')}
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
              <div className="eyebrow">{t('integrationsSources.sourceForm.oneTimeSourceToken')}</div>
              <p className="state__hint" style={{ margin: '4px 0 8px' }}>
                {t('integrationsSources.sourcesModule.useThisOnce')}
              </p>
              <code className="mono" style={{ wordBreak: 'break-all' }}>{oneTimeToken}</code>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
                <Button
                  label={t('integrationsSources.sourceForm.useInTestWebhook')}
                  iconName="webhook"
                  kind="ghost"
                  onClick={() => applyTokenToTester('webhook-tester', oneTimeToken, oneTimeSourceName, oneTimeSourceId)}
                />
                <Button
                  label={t('integrationsSources.sourceForm.useInApiRequest')}
                  iconName="plug"
                  kind="ghost"
                  onClick={() => applyTokenToTester('api-gateway', oneTimeToken, oneTimeSourceName, oneTimeSourceId)}
                />
              </div>
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={oneTimeToken ? t('integrationsSources.sourceForm.done') : t('integrationsSources.sourceForm.cancel')} kind="ghost" onClick={() => modal.close()} disabled={submitting} />
            <Button
              label={submitting ? t('integrationsSources.sourceForm.saving') : row ? t('integrationsSources.sourceForm.save') : t('integrationsSources.sourceForm.create')}
              kind="primary"
              capability={CAP.WEBHOOKS_WRITE}
              onClick={submit}
              disabled={submitting || Boolean(oneTimeToken) || formMappingOptions.length === 0 || enabledOptions.length === 0}
            />
          </div>
        </>
      );
    }
    modal.open({ title: row ? fill(t('integrationsSources.sourcesModule.edit'), { name: String(row.name) }) : t('integrationsSources.sourcesModule.newIntakeSource'), body: <SourceForm /> });
  }

  function openArchiveSourceModal(row: WebhookSourceRow) {
    function ArchiveSourceForm() {
      const { t } = useI18n();
      const [reason, setReason] = useState('');
      return (
        <div>
          <p className="state__hint">
            {t('integrationsSources.archiveSourceForm.archivingKeepsSourceHistory')}
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
            <label className="mono" htmlFor="webhook-source-archive-reason">{t('integrationsSources.archiveSourceForm.reason')}</label>
            <input
              id="webhook-source-archive-reason"
              className="dt-inline-input"
              placeholder={t('integrationsSources.archiveSourceForm.eGTenantMoved')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('integrationsSources.archiveSourceForm.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('integrationsSources.archiveSourceForm.archiveSource')}
              iconName="trash"
              kind="danger"
              capability={CAP.WEBHOOKS_WRITE}
              onClick={async () => {
                const trimmedReason = reason.trim();
                if (!trimmedReason) {
                  pushToast(t('integrationsSources.archiveSourceForm.archiveReasonIsRequired'), 'warn');
                  return;
                }
                try {
                  await archiveSource.mutateAsync({ source_id: row.id, reason: trimmedReason });
                  await requireWebhookSourceStateReadback(row.id, { enabled: false, archived: true });
                  modal.close();
                  pushToast(fill(t('integrationsSources.archiveSourceForm.archived'), { name: String(row.name) }), 'warn');
                } catch (e) {
                  pushToast(fill(t('integrationsSources.archiveSourceForm.archiveFailed'), { value: String((e as Error)?.message ?? '') }), 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: fill(t('integrationsSources.sourcesModule.archive'), { name: String(row.name) }), body: <ArchiveSourceForm /> });
  }

  function openSourceDrawer(row: WebhookSourceRow, projectionOverride?: WebhookSourceDirectoryRow) {
    // W27 projection — additive directory join for KvRow rendering.
    const proj = projectionOverride ?? sourceDirectoryById.get(row.id);
    const eventCount24h = proj?.event_count_24h ?? 0;
    const errorCount24h = proj?.error_count_24h ?? 0;
    const ruleCount = proj?.rule_count ?? 0;
    const activeRuleCount = proj?.active_rule_count ?? 0;
    const isHealthy = proj?.is_healthy ?? false;
    const tokenStatus = authTokenStatusLabel(t, proj);
    const tokenStatusReadback = proj
      ? fill(t('integrationsSources.sourcesModule.tokenStatusConfirmed'), { status: tokenStatus })
      : t('integrationsSources.sourcesModule.tokenStatusPending');
    const summaryRows: KvRow[] = [
      { key: 'name', label: t('integrationsSources.sourcesModule.name'), value: row.name },
      { key: 'id', label: t('integrationsSources.sourcesModule.sourceConfirmation'), value: row.id ? t('integrationsSources.sourcesModule.available') : '—' },
      { key: 'source_id', label: t('integrationsSources.sourcesModule.sourceId'), value: row.id, mono: true },
      { key: 'source_identifier', label: t('integrationsSources.sourcesModule.sourceReference'), value: operatorReference(t, 'source', row.source_identifier), mono: true },
      {
        key: 'provider_type',
        label: t('integrationsSources.sourcesModule.provider'),
        value: providerLabel(t, row.provider_type),
      },
      {
        key: 'auth_token_status',
        label: t('integrationsSources.sourcesModule.authTokenStatus'),
        value: tokenStatus,
      },
      {
        key: 'hmac_validation',
        label: t('integrationsSources.sourcesModule.receiverAuth'),
        value: hmacValidationLabel(t, row as WebhookSourceRow & WebhookSourceDirectoryRow),
      },
      {
        key: 'mapping_config_id',
        label: t('integrationsSources.sourcesModule.mapping'),
        value: row.mapping_config_id
          ? sourceMappingLabel(t, row.mapping_config_id, row as WebhookSourceRow & WebhookSourceDirectoryRow, mappingOptionsById)
          : '—',
      },
      {
        key: 'sender_id',
        label: t('integrationsSources.sourcesModule.shipmentSender'),
        value: sourceSenderLabel(t, row as WebhookSourceRow & WebhookSourceDirectoryRow),
      },
      {
        key: 'rate_limit_per_hour',
        label: t('integrationsSources.sourcesModule.rateHr'),
        value: row.rate_limit_per_hour != null ? String(row.rate_limit_per_hour) : '—',
        mono: true,
      },
      {
        key: 'enabled',
        label: t('integrationsSources.sourcesModule.enabled'),
        value: enabledLabel(t, row.enabled),
      },
      {
        key: 'lifecycle',
        label: t('integrationsSources.sourcesModule.lifecycle'),
        value: isArchivedSource(row) ? t('integrationsSources.sourceLifecycleChip.archived') : t('integrationsSources.sourceLifecycleChip.open'),
      },
      ...(isArchivedSource(row)
        ? [
            {
              key: 'archived_at',
              label: t('integrationsSources.sourcesModule.archivedAt'),
              value: sourceArchivedAt(row) ? new Date(sourceArchivedAt(row) as string).toLocaleString() : '—',
              mono: true,
            },
            {
              key: 'archive_reason',
              label: t('integrationsSources.sourcesModule.archiveReason'),
              value: sourceArchiveReason(row) ?? '—',
            },
          ] satisfies KvRow[]
        : []),
      {
        key: 'health',
        label: t('integrationsSources.sourcesModule.health'),
        value: healthLabel(t, isHealthy, errorCount24h),
      },
      {
        key: 'event_count_24h',
        label: t('integrationsSources.sourcesModule.events24h'),
        value: String(eventCount24h),
        mono: true,
      },
      {
        key: 'error_count_24h',
        label: t('integrationsSources.sourcesModule.errors24h'),
        value: String(errorCount24h),
        mono: true,
      },
      {
        key: 'rule_count',
        label: t('integrationsSources.sourcesModule.routingRules'),
        value: fill(t('integrationsSources.sourcesModule.ruleCounts'), { active: String(activeRuleCount), total: String(ruleCount) }),
        mono: true,
      },
      {
        key: 'last_event_at',
        label: t('integrationsSources.sourcesModule.lastEvent'),
        value: row.last_event_at ? new Date(row.last_event_at).toLocaleString() : '—',
        mono: true,
      },
      {
        key: 'last_event_status',
        label: t('integrationsSources.sourcesModule.lastStatus'),
        value: proj?.last_event_status ?? '—',
        mono: true,
      },
    ];
    drawer.open({
      title: fill(t('integrationsSources.sourcesModule.drawerTitle'), { name: String(row.name), reference: operatorReference(t, 'source', row.source_identifier) }),
      size: 'lg',
      deepLink: `/integrations/sources?focus=${row.id}`,
      body: (
        <div className="rail-body" style={{ padding: '0 0 8px' }}>
          <h4 className="eyebrow">{t('integrationsSources.sourcesModule.intakeSource')}</h4>
          <KvGrid rows={summaryRows} />
          <p
            className="state__hint"
            data-testid="source-token-readback-status"
            style={{ margin: '8px 14px 0' }}
          >
            {tokenStatusReadback}
          </p>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <Button
            label={t('integrationsSources.sourcesModule.rotateToken')}
            iconName="refresh"
            kind="ghost"
            capability={CAP.WEBHOOKS_WRITE}
            disabled={isArchivedSource(row)}
            onClick={async () => {
              try {
                await rotateSourceToken(row, { refreshDrawer: true });
              } catch (e) {
                pushToast(fill(t('integrationsSources.sourcesModule.rotateFailed'), { value: String((e as Error)?.message ?? '') }), 'danger');
              }
            }}
          />
          <div style={{ flex: 1 }} />
          <Button
            label={t('integrationsSources.sourcesModule.archive2')}
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
            label={t('integrationsSources.sourcesModule.edit2')}
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
    { key: 'name', label: t('integrationsSources.sourcesModule.name'), sortable: true },
    {
      key: 'source_identifier',
      label: t('integrationsSources.sourcesModule.sourceReference'),
      mono: true,
      sortable: true,
      filterable: true,
      render: (raw) => <span className="mono">{operatorReference(t, 'source', raw)}</span>,
    },
    {
      key: 'provider_type',
      label: t('integrationsSources.sourcesModule.provider'),
      filterable: true,
      sortable: true,
      render: (raw) => <ProviderChip value={String(raw)} />,
    },
    {
      key: 'mapping_config_id',
      label: t('integrationsSources.sourcesModule.mapping'),
      render: (raw, row) => {
        const v = String(raw ?? '');
        if (!v) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        const label = sourceMappingLabel(t, v, row as WebhookSourceRow & WebhookSourceDirectoryRow, mappingOptionsById);
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
      label: t('integrationsSources.sourcesModule.senderClient'),
      render: (_raw, row) => sourceSenderLabel(t, row as WebhookSourceRow & WebhookSourceDirectoryRow),
    },
    { key: 'rate_limit_per_hour', label: t('integrationsSources.sourcesModule.rateHr'), align: 'right', mono: true, sortable: true },
    {
      key: 'enabled',
      label: t('integrationsSources.sourcesModule.enabled'),
      filterable: true,
      sortable: true,
      render: (raw) => <EnabledChip value={!!raw} />,
    },
    {
      key: 'lifecycle_state',
      label: t('integrationsSources.sourcesModule.lifecycle'),
      filterable: true,
      render: (_raw, row) => <SourceLifecycleChip row={row as WebhookSourceRow & WebhookSourceDirectoryRow} />,
    },
    {
      key: 'hmac_enabled',
      label: t('integrationsSources.sourcesModule.receiverAuth'),
      filterable: true,
      render: (_raw, row) => (
        <HmacValidationChip row={row as WebhookSourceRow & WebhookSourceDirectoryRow} />
      ),
    },
    {
      key: 'auth_token_masked',
      label: t('integrationsSources.sourcesModule.token'),
      filterable: true,
      render: (_raw, row) => (
        <Chip
          size="xs"
          kind={(row as WebhookSourceRow & WebhookSourceDirectoryRow).auth_token_masked ? 'good' : 'warn'}
          label={authTokenStatusLabel(t, row as WebhookSourceRow & WebhookSourceDirectoryRow)}
        />
      ),
    },
    // W27 projection-derived columns. Render uses the row's `is_healthy` /
    // `event_count_24h` / `error_count_24h` / `rule_count` shadows that the
    // memoized decorator above attaches when v_webhook_source_directory is
    // available.
    {
      key: 'is_healthy',
      label: t('integrationsSources.sourcesModule.healthy'),
      filterable: true,
      sortable: true,
      render: (raw, row) => {
        const errors = (row as { error_count_24h?: number }).error_count_24h ?? 0;
        return <HealthChip isHealthy={!!raw} errorCount24h={errors} />;
      },
    },
    {
      key: 'event_count_24h',
      label: t('integrationsSources.sourcesModule.events24h'),
      align: 'right',
      mono: true,
      sortable: true,
      type: 'number',
    },
    {
      key: 'error_count_24h',
      label: t('integrationsSources.sourcesModule.errors24h'),
      align: 'right',
      mono: true,
      sortable: true,
      type: 'number',
    },
    {
      key: 'rule_count',
      label: t('integrationsSources.sourcesModule.rules'),
      align: 'right',
      mono: true,
      sortable: true,
      type: 'number',
    },
    { key: 'last_event_at', label: t('integrationsSources.sourcesModule.lastEvent'), format: 'datetime', sortable: true },
  ];

  const ROW_ACTIONS: Array<DataTableAction<WebhookSourceRow>> = [
    { label: t('integrationsSources.sourcesModule.openDetail'), icon: 'eye', onClick: openSourceDrawer },
    {
      label: t('integrationsSources.sourcesModule.edit2'),
      icon: 'edit',
      kind: 'primary',
      capability: CAP.WEBHOOKS_WRITE,
      disabled: (row) => isArchivedSource(row),
      disabledReason: t('integrationsSources.sourcesModule.archivedCannotEdit'),
      onClick: openSourceForm,
    },
    {
      label: t('integrationsSources.sourcesModule.rotateToken'),
      icon: 'refresh',
      capability: CAP.WEBHOOKS_WRITE,
      disabled: (row) => isArchivedSource(row),
      disabledReason: t('integrationsSources.sourcesModule.archivedCannotRotate'),
      onClick: async (row) => {
        try {
          await rotateSourceToken(row);
        } catch (e) {
          pushToast(fill(t('integrationsSources.sourcesModule.rotateFailed'), { value: String((e as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsSources.sourcesModule.toggleEnabled'),
      icon: 'bolt',
      capability: CAP.WEBHOOKS_WRITE,
      disabled: (row) => isArchivedSource(row),
      disabledReason: t('integrationsSources.sourcesModule.archivedAlreadyDisabled'),
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
          pushToast(fill(t('integrationsSources.sourcesModule.toggleFailed'), { value: String((e as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsSources.sourcesModule.archiveSource'),
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
          eyebrow={t('integrationsSources.sourcesModule.externalIntake')}
          titleAccent={t('integrationsSources.sourcesModule.titleAccent')}
          titlePlain={t('integrationsSources.sourcesModule.titlePlain')}
          pills={[]}
        />
        <StateView
          kind="denied"
          capability={CAP.WEBHOOKS_READ}
          hint={t('integrationsSources.sourcesModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (sourcesQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="integrations-sources"
          eyebrow={t('integrationsSources.sourcesModule.externalIntake')}
          titleAccent={t('integrationsSources.sourcesModule.titleAccent')}
          titlePlain={t('integrationsSources.sourcesModule.titlePlain')}
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
          eyebrow={t('integrationsSources.sourcesModule.externalIntake')}
          titleAccent={t('integrationsSources.sourcesModule.titleAccent')}
          titlePlain={t('integrationsSources.sourcesModule.titlePlain')}
          pills={[]}
        />
        <StateView kind="error" hint={String(sourcesQuery.error)} />
      </div>
    );
  }

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip key="reg" size="xs" label={t('integrationsSources.sourcesModule.sourceList')} />,
    <Chip
      key="dir"
      size="xs"
      label={t('integrationsSources.sourcesModule.healthSummary')}
      kind="info"
    />,
    <Chip key="rls" size="xs" label={t('integrationsSources.sourcesModule.accessControlled')} kind="info" />,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="integrations-sources"
        eyebrow={t('integrationsSources.sourcesModule.externalIntake')}
        titleAccent={t('integrationsSources.sourcesModule.titleAccent')}
        titlePlain={t('integrationsSources.sourcesModule.titlePlain')}
        pills={pills}
        actions={[
          <Button
            key="new"
            label={t('integrationsSources.sourcesModule.newIntakeSource')}
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

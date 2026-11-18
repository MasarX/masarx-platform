// integrations/catalog.tsx — Plugin catalog (card grid view).
// Ports apps/console/demo-v2/assets/js/modules/int-catalog.js to TypeScript/React.
// Backed by: integration_plugins + integration_plugin_versions.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useResource,
  useInstallIntegrationPlugin,
  useUninstallIntegrationPlugin,
  // Wave 9 W9-2 (CLAIM-INTEGRATIONS REVISION 36% — W7 audit P0 #4): missing
  // 4 lifecycle transitions wired into catalog drawer footer.
  useSubmitIntegrationPlugin,
  useApproveIntegrationPlugin,
  useActivateIntegrationPlugin,
  useDeactivateIntegrationPlugin,
  useSetIntegrationPluginBinding,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';
import { stashExternalIntakeSourceToken } from '@/lib/external-intake-token-handoff';
import type { ChipKind } from '@/components/Chip';
import {
  displayRedactedIntegrationJson,
  isRedactedIntegrationSecret,
} from './secret-redaction';

type LookupOption = ReturnType<typeof api.getLookups>[number];

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §7):
// Canonical SSOT is `public.integration_plugins`
// (supabase/migrations/202602220010_integration_plugin_control_plane_v1.sql:445-468)
// which has columns: id, organization_id, plugin_key, name, description,
// plugin_kind, status, rollout_tier, reusable_within_tenant, base_plugin_id,
// active_version_id, managed_by, metadata, created_by, updated_by,
// created_at, updated_at.
//   • RENAMED: kind -> plugin_kind (canonical column name).
//   • PROJECTION: vendor resolves from `metadata.vendor`; retained as
//     optional derived UI field (catalog card sub-line render).
//   • PROJECTION: version is a display alias for the canonical
//     `integration_plugin_versions.version_no` joined via
//     `active_version_id`; retained as optional derived UI field.
//   • PROJECTION: health / last_event_at / events_24h are aggregates over
//     `provider_health_logs` + `webhook_inbox`; retained as optional
//     derived UI fields for the catalog card stats. Production resolves
//     through paired aggregation projections.
//   • PROJECTION: binding resolves from
//     `integration_plugin_versions.workflow_binding` jsonb; retained as
//     optional derived UI field.
interface IntegrationPlugin extends Record<string, unknown> {
  id: string;
  // SSOT: integration_plugins.name (canonical column).
  name: string;
  // SSOT: derived projection (`metadata.vendor`); not a top-level column.
  vendor?: string;
  // SSOT: derived projection (integration_plugin_versions.version_no via active_version_id join).
  version?: string;
  // SSOT: integration_plugins.status (canonical column).
  status: string;
  // SSOT: derived projection (rolling aggregate over provider_health_logs).
  health?: number | null;
  // SSOT: derived projection (MAX(webhook_inbox.created_at) per plugin).
  last_event_at?: string;
  // SSOT: derived projection (COUNT(webhook_inbox) over rolling 24h).
  events_24h?: number;
  // SSOT: integration_plugins.plugin_kind (canonical column).
  plugin_kind: string;
  // SSOT: derived projection (integration_plugin_versions.workflow_binding jsonb).
  binding?: string;
  // SSOT: integration_plugins.active_version_id (canonical column).
  active_version_id?: string | null;
}

/**
 * W27 — Canonical projection from `public.v_integration_plugin_directory`
 * (supabase/migrations/202604302540_v_integration_plugin_directory.sql).
 * Surfaces vendor (metadata.vendor; closes W18-4 §7 deferral), version_label
 * (active version display), version_count, latest_version_no/status,
 * active_version_status, binding/active/install counts, has_active_version,
 * is_pending_review without duplicating them onto the canonical row interface.
 * Production swap stays a single `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('integration_plugin_directory')`.
 */
interface IntegrationPluginDirectoryRow extends Record<string, unknown> {
  id: string;
  vendor?: string | null;
  version_label?: string | null;
  active_version_status?: string | null;
  version_count?: number;
  latest_version_no?: number | null;
  latest_version_status?: string | null;
  binding_count?: number;
  install_count?: number;
  active_binding_count?: number;
  has_active_version?: boolean;
  is_pending_review?: boolean;
}

interface ManualDraftFormValues {
  pluginName: string;
  vendor: string;
  pluginKind: string;
  sourceType: string;
  authMode: string;
}

interface ManualDraftReadback {
  pluginId: string | null;
  pluginVersionId: string | null;
  name: string;
  vendor: string;
  pluginKind: string;
  sourceType: string;
  authMode: string;
  status: string | null;
  visibleInCatalog: boolean;
  visibleInDirectory: boolean;
  directoryStatus: string | null;
}

function pickStringValue(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function defaultLookupValue(options: LookupOption[]) {
  return options.find((option) => option.is_default)?.value ?? options[0]?.value ?? '';
}

function normalizeLookupOptions(options: LookupOption[]) {
  return [...options]
    .filter((option) => option.value)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.label.localeCompare(b.label));
}

function lookupLabel(options: LookupOption[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function manualDraftReadbackFromOutcome(
  outcome: Record<string, unknown>,
  values: ManualDraftFormValues,
): ManualDraftReadback {
  return {
    pluginId: pickStringValue(outcome, ['integration_plugin_id', 'plugin_id', 'id']),
    pluginVersionId: pickStringValue(outcome, [
      'integration_plugin_version_id',
      'plugin_version_id',
      'version_id',
    ]),
    name: pickStringValue(outcome, ['plugin_name', 'name']) ?? values.pluginName,
    vendor: pickStringValue(outcome, ['vendor']) ?? values.vendor,
    pluginKind: pickStringValue(outcome, ['plugin_kind', 'kind']) ?? values.pluginKind,
    sourceType: pickStringValue(outcome, ['source_type']) ?? values.sourceType,
    authMode:
      pickStringValue(outcome, ['auth_mode'])
      ?? pickStringValue(outcome.inbound_config, ['auth_mode'])
      ?? values.authMode,
    status: pickStringValue(outcome, ['status']),
    visibleInCatalog: false,
    visibleInDirectory: false,
    directoryStatus: null,
  };
}

function ManualIntegrationDraftModal({
  pluginKindOptions,
  sourceTypeOptions,
  authModeOptions,
  defaultPluginKind,
  defaultSourceType,
  defaultAuthMode,
  onCancel,
  onCreate,
}: {
  pluginKindOptions: LookupOption[];
  sourceTypeOptions: LookupOption[];
  authModeOptions: LookupOption[];
  defaultPluginKind: string;
  defaultSourceType: string;
  defaultAuthMode: string;
  onCancel: () => void;
  onCreate: (values: ManualDraftFormValues) => Promise<boolean>;
}) {
  const [pluginName, setPluginName] = useState('');
  const [vendor, setVendor] = useState('');
  const [pluginKind, setPluginKind] = useState(defaultPluginKind);
  const [authMode, setAuthMode] = useState(defaultAuthMode);
  const [busy, setBusy] = useState(false);
  const sourceType = defaultSourceType;
  const canCreate =
    !busy
    && !!pluginKind
    && !!sourceType
    && !!authMode
    && (!!pluginName.trim() || !!vendor.trim());

  async function submitDraft() {
    if (!canCreate) {
      pushToast('Display name or vendor is required', 'warn');
      return;
    }
    setBusy(true);
    const created = await onCreate({
      pluginName: pluginName.trim(),
      vendor: vendor.trim(),
      pluginKind,
      sourceType,
      authMode,
    });
    if (created) {
      onCancel();
      return;
    }
    setBusy(false);
  }

  return (
    <div>
      <p className="state__hint">
        Registers a new provider integration. Author mappings in Intake mappings after creation.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr',
          gap: '8px',
          alignItems: 'center',
          padding: '0 4px',
        }}
      >
        <label className="mono" htmlFor="manual-plugin-name">Display name</label>
        <input
          id="manual-plugin-name"
          className="dt-inline-input"
          placeholder="e.g. Examplecourier KSA"
          value={pluginName}
          onChange={(e) => setPluginName(e.target.value)}
        />
        <label className="mono" htmlFor="manual-plugin-vendor">Vendor</label>
        <input
          id="manual-plugin-vendor"
          className="dt-inline-input"
          placeholder="e.g. Examplecourier KSA"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
        />
        <label className="mono" htmlFor="manual-plugin-kind">Kind</label>
        <select
          id="manual-plugin-kind"
          className="dt-inline-input"
          value={pluginKind}
          onChange={(e) => setPluginKind(e.target.value)}
        >
          {pluginKindOptions.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label ?? k.value}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="manual-plugin-source">Draft source</label>
        <input
          id="manual-plugin-source"
          className="dt-inline-input"
          readOnly
          value={lookupLabel(sourceTypeOptions, sourceType)}
        />
        <label className="mono" htmlFor="manual-plugin-auth">Auth</label>
        <select
          id="manual-plugin-auth"
          className="dt-inline-input"
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value)}
        >
          {authModeOptions.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label ?? a.value}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
        <Button label="Cancel" kind="ghost" disabled={busy} onClick={onCancel} />
        <Button
          label={busy ? 'Creating...' : 'Create'}
          kind="primary"
          capability={CAP.INTEGRATION_PLUGINS_WRITE}
          disabled={!canCreate}
          onClick={() => void submitDraft()}
        />
      </div>
    </div>
  );
}

// W19-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §8):
// Canonical SSOT is `public.integration_plugin_versions`
// (supabase/migrations/202602220010_integration_plugin_control_plane_v1.sql:475-508)
// which has columns: id, plugin_id, organization_id, version_no (INTEGER),
// status, source_type, source_payload, ..., submitted_at, submitted_by,
// approved_at, approved_by, activated_at, activated_by, ..., created_by,
// updated_by, created_at, updated_at.
//   • RENAMED: created_by -> submitted_by (canonical column for "who submitted
//     this version for approval"). Both `created_by` and `submitted_by` exist
//     on the canonical table, but the version-history surface is semantically
//     about submission, not row creation.
//   • PROJECTION: `version` is retained as the FE display label (e.g.
//     'v3.4.1'). Canonical column is `version_no INTEGER`; the display
//     label resolution lands when the projection RPC exposes a derived
//     `version_label` column. For now the FE seed populates the display
//     string directly.
interface IntegrationPluginVersion extends Record<string, unknown> {
  id: string;
  plugin_id: string;
  /** Display label (e.g. 'v3.4.1'). Canonical column is `version_no INTEGER`;
   *  derivation lands when the projection RPC exposes a `version_label`. */
  version: string;
  version_no?: number | string | null;
  status: string;
  created_at: string;
  /** SSOT: integration_plugin_versions.submitted_by (canonical column;
   *  W19-4 rename from `created_by`). Resolves to the user UUID who
   *  submitted this version for approval. */
  submitted_by?: string;
}

interface IntegrationPluginValidationRun extends Record<string, unknown> {
  id: string;
  plugin_version_id: string;
  run_type: string;
  status: string;
  sandbox_mode?: boolean;
  correlation_id?: string | null;
  evidence_hash?: string | null;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
}

interface IntegrationPluginApprovalEvent extends Record<string, unknown> {
  id: string;
  plugin_version_id: string;
  action: string;
  actor_user_id?: string | null;
  reason?: string | null;
  diff_hash?: string | null;
  artifact_hash?: string | null;
  created_at: string;
}

interface IntegrationPluginBinding extends Record<string, unknown> {
  id: string;
  plugin_version_id: string;
  scope_type?: string | null;
  scope_id?: string | null;
  binding_type?: string | null;
  runtime_resource_type?: string | null;
  runtime_resource_id?: string | null;
  enabled?: boolean | null;
  activation_payload?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

type PluginLifecycleScope = { scope_type: string; scope_id: string | null };

function resolvePluginBindingScope(
  bindingRows: IntegrationPluginBinding[],
  fallback: PluginLifecycleScope,
): PluginLifecycleScope {
  const scopedBinding = bindingRows.find((binding) =>
    typeof binding.scope_type === 'string'
    && binding.scope_type.trim()
    && typeof binding.scope_id === 'string'
    && binding.scope_id.trim(),
  ) ?? bindingRows.find((binding) =>
    typeof binding.scope_type === 'string' && binding.scope_type.trim(),
  );
  if (!scopedBinding) return fallback;
  return {
    scope_type: String(scopedBinding.scope_type).trim(),
    scope_id: typeof scopedBinding.scope_id === 'string' && scopedBinding.scope_id.trim()
      ? scopedBinding.scope_id.trim()
      : null,
  };
}

function runtimeBindingResourceType(row: IntegrationPluginBinding | null | undefined): string {
  return String(row?.runtime_resource_type ?? '').trim().toLowerCase();
}

function isApiRouteRuntimeBinding(row: IntegrationPluginBinding | null | undefined): boolean {
  const type = runtimeBindingResourceType(row);
  return type === 'api_route' || type === 'api_routes';
}

function isWebhookSourceRuntimeBinding(row: IntegrationPluginBinding | null | undefined): boolean {
  const type = runtimeBindingResourceType(row);
  return type === 'webhook_source' || type === 'webhook_sources';
}

function runtimeBindingPayloadText(
  row: IntegrationPluginBinding | null | undefined,
  key: string,
): string {
  const value = row?.activation_payload?.[key];
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return isRedactedIntegrationSecret(trimmed) ? '' : trimmed;
}

function runtimeBindingConfigPreview(binding: IntegrationPluginBinding): string {
  return displayRedactedIntegrationJson({
    activation_payload: binding.activation_payload ?? {},
    metadata: binding.metadata ?? {},
  });
}

function runtimeSourceTokenBindingForApiRoute(
  bindings: IntegrationPluginBinding[],
  apiRouteBinding: IntegrationPluginBinding,
): IntegrationPluginBinding | null {
  return bindings.find((binding) =>
    binding.plugin_version_id === apiRouteBinding.plugin_version_id
    && isWebhookSourceRuntimeBinding(binding)
    && binding.enabled !== false
    && typeof binding.runtime_resource_id === 'string'
    && binding.runtime_resource_id.trim()
    && runtimeBindingPayloadText(binding, 'issued_token'),
  ) ?? bindings.find((binding) =>
    isWebhookSourceRuntimeBinding(binding)
    && binding.enabled !== false
    && typeof binding.runtime_resource_id === 'string'
    && binding.runtime_resource_id.trim()
    && runtimeBindingPayloadText(binding, 'issued_token'),
  ) ?? null;
}

function statBox(label: string, value: ReactNode): ReactNode {
  return (
    <div
      style={{
        background: 'var(--paper-2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-2)',
        padding: '6px 8px',
      }}
    >
      <div className="eyebrow" style={{ fontSize: '8.5px' }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

function LookupChip({
  category,
  value,
}: {
  category: string;
  value?: string | null;
}) {
  if (!value) return <Chip label="-" kind="neutral" size="xs" />;
  const row = lookupRow(category, value);
  return (
    <Chip
      label={row?.label ?? value}
      kind={(row?.tone as ChipKind | undefined) ?? 'neutral'}
      size="xs"
    />
  );
}

function formatAuditTimestamp(value?: string | null): string {
  if (!value) return '-';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleString();
}

function hashPreview(value?: string | null): string {
  if (!value) return '-';
  return value.length > 16 ? `${value.slice(0, 12)}...` : value;
}

function pluginKindLabel(value?: string | null): string {
  if (!value) return '-';
  return lookupRow('integration_plugin_kind', value)?.label ?? value;
}

function formatRuntimeBindingSummary(activeCount: number, totalCount: number): string | null {
  if (totalCount <= 0) return null;
  const noun = totalCount === 1 ? 'runtime binding' : 'runtime bindings';
  return `${activeCount}/${totalCount} ${noun}`;
}

const EMPTY_PLUGIN_BINDING_LABELS = new Set(['-', '\u2014', '\u00e2\u20ac\u201d']);

function normalizePluginBindingLabel(pluginBinding?: string | null): string | null {
  const trimmed = pluginBinding?.trim();
  if (!trimmed || EMPTY_PLUGIN_BINDING_LABELS.has(trimmed)) return null;
  return trimmed;
}

function formatPluginBindingLabel(
  pluginBinding?: string | null,
  activeRuntimeBindingCount = 0,
  runtimeBindingCount = 0,
): string {
  return normalizePluginBindingLabel(pluginBinding)
    || formatRuntimeBindingSummary(activeRuntimeBindingCount, runtimeBindingCount)
    || '-';
}

function sortPluginVersions(versions: IntegrationPluginVersion[]): IntegrationPluginVersion[] {
  return [...versions].sort((a, b) => {
    const aVersion = Number(a.version_no ?? 0);
    const bVersion = Number(b.version_no ?? 0);
    if (Number.isFinite(aVersion) && Number.isFinite(bVersion) && aVersion !== bVersion) {
      return bVersion - aVersion;
    }
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

function pluginVersionDisplay(version: IntegrationPluginVersion | null | undefined): string {
  if (!version) return '-';
  const versionNo = Number(version.version_no);
  if (Number.isFinite(versionNo) && versionNo > 0) return `v${versionNo}`;
  return version.version || version.id;
}

function resolveRollbackTargetVersion(
  plugin: IntegrationPlugin,
  versions: IntegrationPluginVersion[],
  bindings: IntegrationPluginBinding[],
): IntegrationPluginVersion | null {
  if (!plugin.active_version_id) return null;
  const reusableVersionIds = new Set(
    bindings
      .filter((binding) =>
        typeof binding.plugin_version_id === 'string'
        && typeof binding.scope_type === 'string'
        && binding.scope_type.trim()
        && typeof binding.scope_id === 'string'
        && binding.scope_id.trim(),
      )
      .map((binding) => binding.plugin_version_id),
  );
  return versions.find((version) =>
    version.id !== plugin.active_version_id && reusableVersionIds.has(version.id),
  ) ?? null;
}

function AuditMetaRow({ label, value }: { label: string; value?: ReactNode }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
      {label}: {value}
    </div>
  );
}

function PluginAuditTrail({
  validationRuns,
  approvalEvents,
}: {
  validationRuns: IntegrationPluginValidationRun[];
  approvalEvents: IntegrationPluginApprovalEvent[];
}) {
  if (!validationRuns.length && !approvalEvents.length) return null;

  return (
    <div data-testid="plugin-audit-trail">
      {validationRuns.length ? (
        <>
          <h4 className="eyebrow" style={{ marginTop: '14px' }}>
            Validation history
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {validationRuns.map((run) => (
              <div key={run.id} className="card" style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <LookupChip
                    category="integration_plugin_validation_type"
                    value={run.run_type}
                  />
                  <LookupChip
                    category="integration_plugin_run_status"
                    value={run.status}
                  />
                  <div style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
                    {formatAuditTimestamp(run.created_at)}
                  </span>
                </div>
                <div style={{ marginTop: '6px', display: 'grid', gap: '2px' }}>
                  <AuditMetaRow label="Validation reference" value={run.id} />
                  <AuditMetaRow label="Version reference" value={run.plugin_version_id} />
                  <AuditMetaRow label="Request reference" value={run.correlation_id} />
                  <AuditMetaRow label="Completed" value={formatAuditTimestamp(run.completed_at)} />
                  <AuditMetaRow label="Review note" value={run.error_message} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {approvalEvents.length ? (
        <>
          <h4 className="eyebrow" style={{ marginTop: '14px' }}>
            Approval history
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {approvalEvents.map((event) => (
              <div key={event.id} className="card" style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <LookupChip
                    category="integration_plugin_approval_action"
                    value={event.action}
                  />
                  <div style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
                    {formatAuditTimestamp(event.created_at)}
                  </span>
                </div>
                <div style={{ marginTop: '6px', display: 'grid', gap: '2px' }}>
                  <AuditMetaRow label="Decision reference" value={event.id} />
                  <AuditMetaRow label="Version reference" value={event.plugin_version_id} />
                  <AuditMetaRow label="Handled by" value={event.actor_user_id} />
                  <AuditMetaRow label="Reason" value={event.reason} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// Canonical-tone chip for `integration_plugins.status`. Tone + label resolve
// strictly through the `plugin_status` lookup category (lib/seed-raw/lookups.js).
// Missing canonical row renders a danger-toned `(missing)` chip so operators
// see the seed gap rather than a silent neutral default.
function PluginStatusChip({ value }: { value: string }) {
  const row = lookupRow('plugin_status', value);
  return row ? (
    <Chip label={row.label} kind={row.tone as ChipKind} size="xs" />
  ) : (
    <Chip label={`Unknown plugin status: ${value}`} kind="danger" size="xs" />
  );
}

// W70 (Cycle F-R-10 P2-1/P2-2/P2-3 closure): visibility-gated canonical chip
// for the version-row badge in the plugin drawer + the plugin card header
// pending-review badge. Renders strictly when the canonical `plugin_status`
// lookup row for `value` carries `metadata.is_chip_visible === true`. Missing
// canonical row surfaces a danger-toned `(missing)` chip so seed gaps fail
// loud (parity with `PluginStatusChip`); rows without `is_chip_visible: true`
// render nothing — this is row-driven by configuration, not a code branch.
function PluginVersionRowChip({ value }: { value: string }) {
  const row = lookupRow('plugin_status', value);
  if (!row) {
    return (
      <Chip label={`Unknown plugin status: ${value}`} kind="danger" size="xs" />
    );
  }
  if (row.metadata?.is_chip_visible !== true) {
    return null;
  }
  return <Chip label={row.label} kind={row.tone as ChipKind} size="xs" />;
}

type PluginExportHandoffReadback = api.IntegrationPluginExportHandoffResult;

function handoffText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function redactHandoffText(value: unknown, token?: string | null): string | null {
  const raw = handoffText(value);
  if (!raw) return null;
  let redacted = raw;
  if (token && token !== '{{TOKEN}}') {
    redacted = redacted.split(token).join('redacted-token');
  }
  return redacted
    .replace(/Bearer\s+[^"'\s]+/gi, 'Bearer redacted-token')
    .replace(/\/t\/[^/"'\s]+/gi, '/t/redacted-token');
}

function integrationPluginHandoffBaseUrl(): string | null {
  const baseUrl = typeof import.meta.env.VITE_SUPABASE_URL === 'string'
    ? import.meta.env.VITE_SUPABASE_URL.trim().replace(/\/+$/, '')
    : '';
  return baseUrl || null;
}

function PluginExportHandoffCard({
  handoff,
}: {
  handoff: PluginExportHandoffReadback;
}) {
  const token = handoffText(handoff.token);
  const endpoint = redactHandoffText(handoff.endpoint, token) ?? '-';
  const sampleCurl = redactHandoffText(handoff.sample_curl, token);
  const instructions = Array.isArray(handoff.instructions)
    ? handoff.instructions
      .map((item) => redactHandoffText(item, token))
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return (
    <div
      className="card"
      data-testid="plugin-export-handoff-readback"
      style={{ marginTop: '12px', padding: '10px 12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <Chip label="Export handoff ready" kind="good" size="xs" />
        <span style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
          Instructions ready
        </span>
        {handoff.method ? (
          <span style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
            Request method set
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: '8px', display: 'grid', gap: '3px' }}>
        <AuditMetaRow label="Export setup confirmed" value="Ready" />
        <AuditMetaRow label="Integration reference" value={handoff.plugin_id} />
        <AuditMetaRow label="Version reference" value={handoff.plugin_version_id} />
        <AuditMetaRow label="Export request" value={endpoint ? 'Configured' : 'Pending setup'} />
        <AuditMetaRow label="Token" value={token && token !== '{{TOKEN}}' ? 'Issued - redacted' : 'Not issued'} />
      </div>
      {sampleCurl ? (
        <StateView
          kind="empty"
          title="Export request prepared"
          hint="Use the generated integration instructions to send the export request with the issued token."
        />
      ) : null}
      {instructions.length ? (
        <div className="state__hint" style={{ marginTop: '8px' }}>
          {instructions.join(' ')}
        </div>
      ) : null}
    </div>
  );
}

interface PluginDrawerProps {
  plugin: IntegrationPlugin;
  versions: IntegrationPluginVersion[];
  validationRuns: IntegrationPluginValidationRun[];
  approvalEvents: IntegrationPluginApprovalEvent[];
  bindings: IntegrationPluginBinding[];
  lifecycleScope: PluginLifecycleScope;
  onOpenMapping: () => void;
  onRunValidation: (latest: IntegrationPluginVersion) => Promise<void>;
  onRunTest: () => void;
  onAfterBindingToggle: () => Promise<void>;
}

interface PluginBindingToggleProps {
  plugin: IntegrationPlugin;
  latest: IntegrationPluginVersion;
  latestBindings: IntegrationPluginBinding[];
  lifecycleScope: PluginLifecycleScope;
  onAfterToggle: () => Promise<void>;
}

function PluginBindingToggle({
  plugin,
  latest,
  latestBindings,
  lifecycleScope,
  onAfterToggle,
}: PluginBindingToggleProps) {
  const setPluginBinding = useSetIntegrationPluginBinding();
  const inFlightRef = useRef(false);
  const [isToggling, setIsToggling] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const enabled = latestBindings.some((binding) => binding.enabled !== false);
  const bindingScope = useMemo(
    () => resolvePluginBindingScope(latestBindings, lifecycleScope),
    [latestBindings, lifecycleScope.scope_id, lifecycleScope.scope_type],
  );

  const busy = isToggling || setPluginBinding.isPending;

  const runToggle = async () => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setIsToggling(true);
    setStatusMessage('Updating runtime binding...');
    try {
      await setPluginBinding.mutateAsync({
        plugin_version_id: latest.id,
        enabled: !enabled,
        scope_type: bindingScope.scope_type,
        scope_id: bindingScope.scope_id,
      });
      pushToast(
        `${enabled ? 'Disabled' : 'Enabled'} binding · ${plugin.name} v${latest.version}`,
        enabled ? 'warn' : 'good',
      );
      await onAfterToggle();
      setStatusMessage(null);
    } catch (err) {
      const message = (err as Error)?.message ?? '';
      setStatusMessage(`Set binding failed${message ? `: ${message}` : ''}`);
      pushToast(`Set binding failed · ${message}`, 'danger');
    } finally {
      inFlightRef.current = false;
      setIsToggling(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      <Button
        label={enabled ? 'Disable binding' : 'Enable binding'}
        iconName={enabled ? 'lock' : 'unlock'}
        kind={enabled ? 'danger' : 'primary'}
        capability={CAP.INTEGRATION_PLUGINS_ACTIVATE}
        disabled={busy}
        onPointerDown={(event) => {
          event.preventDefault();
          void runToggle();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          void runToggle();
        }}
        onClick={() => {
          void runToggle();
        }}
      />
      {statusMessage ? (
        <span className="state__hint" role="status" style={{ margin: 0 }}>
          {statusMessage}
        </span>
      ) : null}
    </div>
  );
}

function PluginDrawerBody({
  plugin,
  versions,
  validationRuns,
  approvalEvents,
  bindings,
  lifecycleScope,
  onOpenMapping,
  onRunValidation,
  onRunTest,
  onAfterBindingToggle,
}: PluginDrawerProps) {
  const latest = versions[0] ?? null;
  const activeVersion = versions.find((version) => version.id === plugin.active_version_id) ?? null;
  const latestBindings = latest
    ? bindings.filter((binding) => binding.plugin_version_id === latest.id)
    : [];
  const latestVersionStatusRow = latest
    ? lookupRow('plugin_status', latest.status) as { metadata?: { next_actions?: string[] } } | null
    : null;
  const canToggleBinding = !!latest && (latestVersionStatusRow?.metadata?.next_actions ?? []).includes('set_binding');
  const activeRuntimeBindingCount = bindings.filter((binding) => binding.enabled !== false).length;
  const bindingLabel = formatPluginBindingLabel(
    plugin.binding,
    activeRuntimeBindingCount,
    bindings.length,
  );
  const activeVersionLabel = activeVersion ? pluginVersionDisplay(activeVersion) : plugin.version || '-';
  const [exportHandoff, setExportHandoff] = useState<PluginExportHandoffReadback | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isRunningValidation, setIsRunningValidation] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function runExportHandoff() {
    if (!activeVersion || isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const baseUrl = integrationPluginHandoffBaseUrl();
      const result = await api.integration_plugin_export_handoff_v1({
        plugin_version_id: activeVersion.id,
        ...(baseUrl ? { base_url: baseUrl } : {}),
      });
      setExportHandoff(result);
      pushToast(`Export handoff ready · ${plugin.name} ${pluginVersionDisplay(activeVersion)}`, 'good');
    } catch (err) {
      const message = (err as Error)?.message ?? 'export handoff failed';
      setExportError(message);
      pushToast(`Export handoff failed · ${message}`, 'danger');
    } finally {
      setIsExporting(false);
    }
  }

  async function runValidation() {
    if (!latest || isRunningValidation) return;
    setIsRunningValidation(true);
    setValidationError(null);
    try {
      await onRunValidation(latest);
    } catch (err) {
      const message = (err as Error)?.message ?? 'validation failed';
      setValidationError(message);
      pushToast(`Validation failed · ${message}`, 'danger');
    } finally {
      setIsRunningValidation(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        Plugin authoring lives in Intake mappings. Versioning and active release selection stay governed here.
      </p>
      <div className="card" style={{ marginTop: '10px' }}>
        <KvRow label="Vendor" value={plugin.vendor} />
        <KvRow label="Version" value={plugin.version} />
        <KvRow label="Kind" value={pluginKindLabel(plugin.plugin_kind)} />
        <KvRow label="Binding" value={bindingLabel} />
        <KvRow
          label="Status"
          value={<PluginStatusChip value={plugin.status} />}
        />
        <KvRow
          label="Latest version"
          value={latest ? pluginVersionDisplay(latest) : '—'}
        />
        <KvRow
          label="Latest version status"
          value={latest ? <PluginStatusChip value={latest.status} /> : '—'}
        />
        <KvRow
          label="Health (24h)"
          value={plugin.health == null ? '—' : `${(plugin.health * 100).toFixed(1)}%`}
        />
        <KvRow label="Active version" value={activeVersionLabel} />
      </div>
      <h4 className="eyebrow" style={{ marginTop: '14px' }}>
        Version history
      </h4>
      {versions.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {versions.map((v) => (
            <div
              key={v.id}
              className="card"
              style={{
                padding: '10px 12px',
                borderColor: v.id === plugin.active_version_id ? 'var(--accent)' : 'var(--line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {v.version}
                </span>
                {/* W70 (Cycle F-R-10 P2-1 closure): "active version" badge
                    sources label/tone strictly from the canonical
                    `plugin_status='active'` lookup row (no inline
                    `label="active"` literal). */}
                {v.id === plugin.active_version_id ? (
                  <PluginStatusChip value="active" />
                ) : null}
                {/* W70 (Cycle F-R-10 P2-2 closure): version-row chip renders
                    only when the canonical `plugin_status` lookup row for
                    `v.status` carries `metadata.is_chip_visible === true`
                    (e.g. `archived`). Replaces the inline
                    `v.status === 'archived'` literal compare + `<Chip
                    label="archived" />` literal label/tone. */}
                <PluginVersionRowChip value={v.status} />
                <div style={{ flex: 1 }} />
                <span
                  className="mono"
                  style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}
                >
                  {new Date(v.created_at).toLocaleDateString()}
                </span>
              </div>
              <div
                className="mono"
                style={{ fontSize: '10.5px', color: 'var(--ink-3)', marginTop: '4px' }}
              >
                {v.id}
              </div>
              {v.submitted_by ? (
                <div
                  style={{ fontSize: '10.5px', color: 'var(--ink-2)', marginTop: '2px' }}
                >
                  submitted by {v.submitted_by}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="state__hint">No version history is available for this plugin.</div>
      )}
      <PluginAuditTrail validationRuns={validationRuns} approvalEvents={approvalEvents} />
      {bindings.length ? (
        <>
          <h4 className="eyebrow" style={{ marginTop: '14px' }}>
            Runtime bindings
          </h4>
          {latest && canToggleBinding ? (
            <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '8px 0' }}>
              <PluginBindingToggle
                plugin={plugin}
                latest={latest}
                latestBindings={latestBindings}
                lifecycleScope={lifecycleScope}
                onAfterToggle={onAfterBindingToggle}
              />
            </div>
          ) : null}
          <div
            data-testid="plugin-runtime-bindings"
            style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
          >
            {bindings.map((binding) => (
              <div key={binding.id} className="card" style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Chip
                    label={binding.enabled === false ? 'Disabled' : 'Enabled'}
                    kind={binding.enabled === false ? 'neutral' : 'good'}
                    size="xs"
                  />
                  <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
                    {binding.scope_type ?? 'scope'} / {binding.binding_type ?? 'binding'}
                  </span>
                  <div style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
                    {formatAuditTimestamp(binding.updated_at ?? binding.created_at)}
                  </span>
                </div>
                <div style={{ marginTop: '6px', display: 'grid', gap: '2px' }}>
                  <AuditMetaRow label="binding" value={binding.id} />
                  <AuditMetaRow label="version" value={binding.plugin_version_id} />
                  <AuditMetaRow label="scope" value={binding.scope_id} />
                  <AuditMetaRow label="runtime" value={binding.runtime_resource_type} />
                  <AuditMetaRow label="runtime id" value={binding.runtime_resource_id} />
                </div>
                <pre
                  className="wf-code-block"
                  aria-label="Runtime binding config"
                  style={{ marginTop: '8px', whiteSpace: 'pre-wrap' }}
                >
                  {runtimeBindingConfigPreview(binding)}
                </pre>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        <Button label="Open in Intake mappings" iconName="edit" kind="ghost" onClick={onOpenMapping} />
        <Button
          label={isExporting ? 'Exporting handoff...' : 'Export handoff'}
          iconName="download"
          kind="ghost"
          capability={CAP.INTEGRATION_PLUGINS_WRITE}
          disabled={!activeVersion || isExporting}
          onClick={() => void runExportHandoff()}
        />
        <div style={{ flex: 1 }} />
        <Button
          label={isRunningValidation ? 'Running validation...' : 'Run validation'}
          iconName="play"
          kind="primary"
          capability={CAP.INTEGRATION_PLUGINS_TEST}
          disabled={!latest || isRunningValidation}
          onClick={() => void runValidation()}
        />
        <Button
          label="Run test event"
          iconName="play"
          kind="ghost"
          capability={CAP.INTEGRATION_PLUGINS_TEST}
          onClick={onRunTest}
        />
      </div>
      {validationError ? (
        <div className="state__hint" role="status" style={{ color: 'var(--danger)', marginTop: '8px' }}>
          Validation failed: {validationError}
        </div>
      ) : null}
      {exportError ? (
        <div className="state__hint" role="status" style={{ color: 'var(--danger)', marginTop: '8px' }}>
          Export handoff failed: {exportError}
        </div>
      ) : null}
      {exportHandoff ? <PluginExportHandoffCard handoff={exportHandoff} /> : null}
    </div>
  );
}

function KvRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        padding: '4px 0',
        borderBottom: '1px solid var(--line)',
        fontSize: '11.5px',
      }}
    >
      <span className="mono" style={{ color: 'var(--ink-3)', minWidth: '140px' }}>
        {label}
      </span>
      <span>{value ?? ''}</span>
    </div>
  );
}

export function CatalogModule() {
  const navigate = useNavigate();
  const consoleNavigate = useConsoleNavigator();
  const drawer = useDrawer();
  const modal = useModal();
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.INTEGRATION_PLUGINS_READ);
  const installPlugin = useInstallIntegrationPlugin();
  const uninstallPlugin = useUninstallIntegrationPlugin();
  // Wave 9 W9-2 lifecycle transitions wired into the catalog drawer footer.
  const submitPlugin = useSubmitIntegrationPlugin();
  const approvePlugin = useApproveIntegrationPlugin();
  const activatePlugin = useActivateIntegrationPlugin();
  const deactivatePlugin = useDeactivateIntegrationPlugin();
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const pluginsQuery = useResourceList<IntegrationPlugin>(
    'integration_plugins',
    undefined,
    readQueryOptions,
  );
  // W27 — paired projection view `public.v_integration_plugin_directory`
  // (supabase/migrations/202604302540_v_integration_plugin_directory.sql).
  // Surfaces vendor (metadata.vendor) + version_label + version_count +
  // latest_version_no/status + active_version_status + binding/active counts
  // + has_active_version + is_pending_review. Production swap stays a single
  // `getSupabaseClient()` branch in
  // `data-source.ts:ui_list_resource_v1('integration_plugin_directory')`.
  const pluginDirectoryQuery =
    useResourceList<IntegrationPluginDirectoryRow>(
      'integration_plugin_directory',
      undefined,
      readQueryOptions,
    );
  const pluginDirectoryById = useMemo(() => {
    const map = new Map<string, IntegrationPluginDirectoryRow>();
    for (const r of pluginDirectoryQuery.data?.rows ?? []) {
      map.set(r.id, r);
    }
    return map;
  }, [pluginDirectoryQuery.data]);
  const plugins = pluginsQuery.data?.rows ?? [];
  const focusParam = readUrlParam('focus');
  const focusInRows = focusParam ? plugins.some((plugin) => plugin.id === focusParam) : false;
  const focusedPluginQuery = useResource<IntegrationPlugin>(
    'integration_plugins',
    canRead && focusParam && !focusInRows ? focusParam : undefined,
  );
  const focusedPlugin = focusParam
    ? plugins.find((plugin) => plugin.id === focusParam) ?? focusedPluginQuery.data ?? null
    : null;
  const displayedPlugins = useMemo(() => {
    if (!focusedPlugin) return plugins;
    return plugins.some((plugin) => plugin.id === focusedPlugin.id)
      ? plugins
      : [focusedPlugin, ...plugins];
  }, [focusedPlugin, plugins]);
  const openedFocusRef = useRef<string | null>(null);

  // Strict canonical option lists. Plugin kind, source type, and auth mode resolve through
  // `integration_plugin_kind` / `integration_plugin_source_type` / `integration_plugin_auth_mode`
  // lookup categories
  // (lib/seed-raw/lookups.js). Defaults derive from the first canonical row
  // flagged as default, falling back to lookup ordering authority via `rank`.
  const liveLookupEnabled = api.hasConsoleLiveBackend();
  const pluginKindLookupQuery = useQuery({
    queryKey: ['lookup', 'integration_plugin_kind', 'live'],
    queryFn: () => api.getLookupsLive('integration_plugin_kind'),
    enabled: liveLookupEnabled,
  });
  const sourceTypeLookupQuery = useQuery({
    queryKey: ['lookup', 'integration_plugin_source_type', 'live'],
    queryFn: () => api.getLookupsLive('integration_plugin_source_type'),
    enabled: liveLookupEnabled,
  });
  const authModeLookupQuery = useQuery({
    queryKey: ['lookup', 'integration_plugin_auth_mode', 'live'],
    queryFn: () => api.getLookupsLive('integration_plugin_auth_mode'),
    enabled: liveLookupEnabled,
  });
  const pluginKindOptions = useMemo(
    () => {
      const liveRows = normalizeLookupOptions((pluginKindLookupQuery.data ?? []) as LookupOption[]);
      if (liveRows.length > 0) return liveRows;
      return normalizeLookupOptions(api.getLookups('integration_plugin_kind') ?? []);
    },
    [pluginKindLookupQuery.data],
  );
  const sourceTypeOptions = useMemo(
    () => {
      const liveRows = normalizeLookupOptions((sourceTypeLookupQuery.data ?? []) as LookupOption[]);
      if (liveRows.length > 0) return liveRows;
      return normalizeLookupOptions(api.getLookups('integration_plugin_source_type') ?? []);
    },
    [sourceTypeLookupQuery.data],
  );
  const authModeOptions = useMemo(
    () => {
      const liveRows = normalizeLookupOptions((authModeLookupQuery.data ?? []) as LookupOption[]);
      if (liveRows.length > 0) return liveRows;
      return normalizeLookupOptions(api.getLookups('integration_plugin_auth_mode') ?? []);
    },
    [authModeLookupQuery.data],
  );
  const defaultPluginKind = defaultLookupValue(pluginKindOptions);
  const defaultSourceType = defaultLookupValue(sourceTypeOptions);
  const defaultAuthMode = defaultLookupValue(authModeOptions);
  const [manualDraftReadback, setManualDraftReadback] = useState<ManualDraftReadback | null>(null);

  function resolvePluginLifecycleScope(): { scope_type: string; scope_id: string | null } {
    if (scope.resource?.id) return { scope_type: 'resource', scope_id: scope.resource.id };
    if (scope.source?.id) return { scope_type: 'source', scope_id: scope.source.id };
    if (scope.sender?.id) return { scope_type: 'sender', scope_id: scope.sender.id };
    if (scope.client?.id) return { scope_type: 'client', scope_id: scope.client.id };
    if (scope.tenant?.id) return { scope_type: 'tenant', scope_id: scope.tenant.id };
    return { scope_type: 'global', scope_id: null };
  }

  function openAddIntegration() {
    if (!defaultPluginKind || !defaultSourceType || !defaultAuthMode) {
      pushToast('Integration lookup options are still loading', 'warn');
      return;
    }
    setManualDraftReadback(null);
    modal.open({
      title: 'Add integration',
      body: (
        <ManualIntegrationDraftModal
          pluginKindOptions={pluginKindOptions}
          sourceTypeOptions={sourceTypeOptions}
          authModeOptions={authModeOptions}
          defaultPluginKind={defaultPluginKind}
          defaultSourceType={defaultSourceType}
          defaultAuthMode={defaultAuthMode}
          onCancel={() => modal.close()}
          onCreate={async (values) => {
            try {
              const outcome = await installPlugin.mutateAsync({
                plugin_name: values.pluginName,
                plugin_kind: values.pluginKind,
                source_type: values.sourceType,
                inbound_config: { auth_mode: values.authMode },
                vendor: values.vendor,
              });
              const initialReadback = manualDraftReadbackFromOutcome(outcome, values);
              const [pluginsResult, directoryResult] = await Promise.allSettled([
                pluginsQuery.refetch(),
                pluginDirectoryQuery.refetch(),
              ]);
              const refreshedPlugins =
                pluginsResult.status === 'fulfilled' ? (pluginsResult.value.data?.rows ?? []) : [];
              const refreshedDirectory =
                directoryResult.status === 'fulfilled' ? (directoryResult.value.data?.rows ?? []) : [];
              const pluginId = initialReadback.pluginId;
              const refreshedPlugin = pluginId
                ? refreshedPlugins.find((plugin) => plugin.id === pluginId) ?? null
                : null;
              const refreshedDirectoryRow = pluginId
                ? refreshedDirectory.find((row) => row.id === pluginId) ?? null
                : null;
              setManualDraftReadback({
                ...initialReadback,
                status: refreshedPlugin?.status ?? initialReadback.status,
                visibleInCatalog: Boolean(refreshedPlugin),
                visibleInDirectory: Boolean(refreshedDirectoryRow),
                directoryStatus:
                  refreshedDirectoryRow?.latest_version_status
                  ?? refreshedDirectoryRow?.active_version_status
                  ?? null,
              });
              pushToast(`Plugin draft created - ${values.pluginName || values.vendor}`, 'good');
              return true;
            } catch (err) {
              pushToast(`Create failed - ${(err as Error)?.message ?? ''}`, 'danger');
              return false;
            }
          }}
        />
      ),
    });
  }

  async function openPluginDrawer(p: IntegrationPlugin) {
    const [freshPluginResult, directoryResult, versionsResult] = await Promise.allSettled([
      api.ui_get_resource_v1<IntegrationPlugin>('integration_plugins', p.id),
      api.ui_get_resource_v1<IntegrationPluginDirectoryRow>('integration_plugin_directory', p.id),
      api.ui_list_resource_v1<IntegrationPluginVersion>('integration_plugin_versions'),
    ]);
    const freshPlugin =
      freshPluginResult.status === 'fulfilled' && freshPluginResult.value
        ? freshPluginResult.value
        : null;
    const directory =
      directoryResult.status === 'fulfilled' && directoryResult.value
        ? directoryResult.value
        : pluginDirectoryById.get(p.id) ?? null;
    const plugin: IntegrationPlugin = {
      ...p,
      ...(freshPlugin ?? {}),
      vendor: directory?.vendor ?? freshPlugin?.vendor ?? p.vendor,
      version: directory?.version_label ?? freshPlugin?.version ?? p.version,
      binding: freshPlugin?.binding ?? p.binding,
      status: freshPlugin?.status ?? p.status,
      active_version_id:
        freshPlugin && Object.prototype.hasOwnProperty.call(freshPlugin, 'active_version_id')
          ? freshPlugin.active_version_id
          : p.active_version_id,
    };

    const versions: IntegrationPluginVersion[] =
      versionsResult.status === 'fulfilled'
        ? sortPluginVersions((versionsResult.value.rows || []).filter((v) => v.plugin_id === plugin.id))
        : [];
    let validationRuns: IntegrationPluginValidationRun[] = [];
    let approvalEvents: IntegrationPluginApprovalEvent[] = [];
    let bindings: IntegrationPluginBinding[] = [];
    const versionIds = new Set(
      [
        ...versions.map((v) => v.id),
        typeof plugin.active_version_id === 'string' ? plugin.active_version_id : null,
      ].filter((id): id is string => Boolean(id)),
    );
    if (versionIds.size > 0) {
      const versionIdList = Array.from(versionIds);
      const listPluginVersionRows = async <T extends { id?: string | null },>(
        resource: string,
        sort: { key: string; dir?: 'asc' | 'desc' },
      ): Promise<T[]> => {
        const results = await Promise.allSettled(
          versionIdList.map((pluginVersionId) =>
            api.ui_list_resource_v1<T>(
              resource,
              {
                filter: { plugin_version_id: pluginVersionId },
                page_size: 50,
                sort,
              },
            ),
          ),
        );
        const rows = results.flatMap((result) =>
          result.status === 'fulfilled' ? (result.value.rows || []) : [],
        );
        const seen = new Set<string>();
        return rows.filter((row) => {
          const id = typeof row.id === 'string' ? row.id : '';
          if (!id) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      };
      const [validationResult, approvalResult, bindingResult] = await Promise.allSettled([
        listPluginVersionRows<IntegrationPluginValidationRun>(
          'integration_plugin_validation_runs',
          { key: 'created_at', dir: 'desc' },
        ),
        listPluginVersionRows<IntegrationPluginApprovalEvent>(
          'integration_plugin_approval_events',
          { key: 'created_at', dir: 'desc' },
        ),
        listPluginVersionRows<IntegrationPluginBinding>(
          'integration_plugin_bindings',
          { key: 'updated_at', dir: 'desc' },
        ),
      ]);
      if (validationResult.status === 'fulfilled') {
        validationRuns = validationResult.value.filter((row) =>
          versionIds.has(row.plugin_version_id),
        );
      }
      if (approvalResult.status === 'fulfilled') {
        approvalEvents = approvalResult.value.filter((row) =>
          versionIds.has(row.plugin_version_id),
        );
      }
      if (bindingResult.status === 'fulfilled') {
        bindings = bindingResult.value.filter((row) =>
          versionIds.has(row.plugin_version_id),
        );
      }
    }
    const rollbackTarget = resolveRollbackTargetVersion(plugin, versions, bindings);
    const rollbackTargetLabel = pluginVersionDisplay(rollbackTarget);
    const rollbackDisabledReason = !plugin.active_version_id
      ? 'Rollback unavailable until this plugin has an active version.'
      : !rollbackTarget
        ? 'Rollback unavailable until another version has reusable runtime bindings.'
        : null;
    drawer.open({
      title: plugin.name,
      size: 'lg',
      body: (
        <PluginDrawerBody
          plugin={plugin}
          versions={versions}
          validationRuns={validationRuns}
          approvalEvents={approvalEvents}
          bindings={bindings}
          lifecycleScope={resolvePluginLifecycleScope()}
          onOpenMapping={() => {
            drawer.close();
            navigate({ to: '/integrations/mapping' });
          }}
          onRunValidation={async (latest) => {
            await api.runPluginTest(
              plugin.id,
              {
                event: { type: 'shipment.created' },
                metadata: { source: 'console_v2_catalog_validation' },
              },
              latest.id,
            );
            pushToast(`Validation run recorded · ${plugin.name} ${pluginVersionDisplay(latest)}`, 'good');
            await openPluginDrawer(plugin);
          }}
          onRunTest={() => {
            drawer.close();
            const apiRouteBinding = bindings.find((binding) =>
              isApiRouteRuntimeBinding(binding)
              && typeof binding.runtime_resource_id === 'string'
              && binding.runtime_resource_id.trim(),
            );
            if (apiRouteBinding) {
              const apiSourceBinding = runtimeSourceTokenBindingForApiRoute(bindings, apiRouteBinding);
              const issuedToken = runtimeBindingPayloadText(apiSourceBinding, 'issued_token');
              if (issuedToken) {
                const sourceName = runtimeBindingPayloadText(apiSourceBinding, 'source_identifier') || plugin.name;
                const stashed = stashExternalIntakeSourceToken('api-gateway', {
                  token: issuedToken,
                  source_id: apiSourceBinding?.runtime_resource_id
                    ? String(apiSourceBinding.runtime_resource_id)
                    : null,
                  source_name: sourceName,
                });
                if (!stashed) {
                  pushToast('Token handoff is unavailable in this browser session. Copy the token manually.', 'warn');
                }
              }
              const search = new URLSearchParams({
                view: 'routes',
                focusRoute: String(apiRouteBinding.runtime_resource_id),
              });
              const packId = runtimeBindingPayloadText(apiRouteBinding, 'pack_id');
              if (packId) search.set('routePackId', packId);
              consoleNavigate(`/insights/api-gateway?${search.toString()}`);
              return;
            }
            const webhookSourceBinding = bindings.find((binding) =>
              isWebhookSourceRuntimeBinding(binding)
              && binding.enabled !== false
              && typeof binding.runtime_resource_id === 'string'
              && binding.runtime_resource_id.trim(),
            );
            const search = new URLSearchParams({ plugin_id: plugin.id });
            if (webhookSourceBinding?.runtime_resource_id) {
              search.set('source_id', String(webhookSourceBinding.runtime_resource_id));
            }
            const issuedToken = runtimeBindingPayloadText(webhookSourceBinding, 'issued_token');
            if (issuedToken) {
              const sourceName = runtimeBindingPayloadText(webhookSourceBinding, 'source_identifier') || plugin.name;
              const stashed = stashExternalIntakeSourceToken('webhook-tester', {
                token: issuedToken,
                source_id: webhookSourceBinding?.runtime_resource_id
                  ? String(webhookSourceBinding.runtime_resource_id)
                  : null,
                source_name: sourceName,
              });
              if (!stashed) {
                pushToast('Token handoff is unavailable in this browser session. Copy the token manually.', 'warn');
              }
            }
            consoleNavigate(`/integrations/webhook-tester?${search.toString()}`);
          }}
          onAfterBindingToggle={() => openPluginDrawer(plugin)}
        />
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%', flexWrap: 'wrap' }}>
          {/* Cycle E P1 #5 + P1 #6 closure (AGENTS.md §2 ZERO HARDCODING +
              §4 SSOT): lifecycle CTAs project from canonical
              `plugin_status.metadata.next_actions` (see lookups.js). The
              status->action transitions live on the canonical lookup row,
              not in an inline `switch (latest.status)` ladder. The
              `scope_type` for activate/set-binding derives from the
              caller's resolved identity scope chain (lowest non-empty
              ladder rung wins) — no inline `'tenant'` literal. Both
              capability gates remain in place; inner RPCs assert the
              granular `.approve` / `.activate` capability per row. */}
          {(() => {
            const latest = versions[0];
            if (!latest) return null;
            const activeVersion = plugin.active_version_id
              ? versions.find((version) => version.id === plugin.active_version_id) ?? null
              : null;
            // SSOT — canonical next_actions for this version's status.
            const statusRow = lookupRow('plugin_status', latest.status) as
              | { metadata?: { next_actions?: string[] } }
              | null;
            const nextActions: string[] = statusRow?.metadata?.next_actions ?? [];
            const activeStatusRow = activeVersion
              ? lookupRow('plugin_status', activeVersion.status) as
                | { metadata?: { next_actions?: string[] } }
                | null
              : null;
            const activeNextActions: string[] = activeStatusRow?.metadata?.next_actions ?? [];
            // Scope type derives from the resolved scope chain (lowest
            // non-empty ladder rung wins). Falls back to 'global' only if
            // the operator has no scope selected, which is a safe default
            // for activation/binding (the inner RPC re-validates).
            const lifecycleScope = resolvePluginLifecycleScope();

            const buttons: Array<JSX.Element> = [];
            if (nextActions.includes('submit')) {
              buttons.push(
                <Button
                  key="submit"
                  label="Submit for review"
                  iconName="upload"
                  kind="primary"
                  capability={CAP.INTEGRATION_PLUGINS_WRITE}
                  onClick={async () => {
                    try {
                      await submitPlugin.mutateAsync({ plugin_version_id: latest.id });
                      pushToast(`Submitted · ${plugin.name} v${latest.version}`, 'good');
                      await openPluginDrawer(plugin);
                    } catch (err) {
                      pushToast(`Submit failed · ${(err as Error)?.message ?? ''}`, 'danger');
                    }
                  }}
                />,
              );
            }
            if (nextActions.includes('approve')) {
              buttons.push(
                <Button
                  key="approve"
                  label="Approve"
                  iconName="check"
                  kind="primary"
                  capability={CAP.INTEGRATION_PLUGINS_APPROVE}
                  onClick={async () => {
                    try {
                      await approvePlugin.mutateAsync({
                        plugin_version_id: latest.id,
                        decision: 'approved',
                      });
                      pushToast(`Approved · ${plugin.name} v${latest.version}`, 'good');
                      await openPluginDrawer(plugin);
                    } catch (err) {
                      pushToast(`Approve failed · ${(err as Error)?.message ?? ''}`, 'danger');
                    }
                  }}
                />,
              );
            }
            if (nextActions.includes('reject')) {
              buttons.push(
                <Button
                  key="reject"
                  label="Reject"
                  iconName="x"
                  kind="ghost"
                  capability={CAP.INTEGRATION_PLUGINS_APPROVE}
                  onClick={async () => {
                    try {
                      await approvePlugin.mutateAsync({
                        plugin_version_id: latest.id,
                        decision: 'rejected',
                      });
                      pushToast(`Rejected · ${plugin.name} v${latest.version}`, 'warn');
                      await openPluginDrawer(plugin);
                    } catch (err) {
                      pushToast(`Reject failed · ${(err as Error)?.message ?? ''}`, 'danger');
                    }
                  }}
                />,
              );
            }
            if (nextActions.includes('activate')) {
              buttons.push(
                <Button
                  key="activate"
                  label="Activate"
                  iconName="bolt"
                  kind="primary"
                  capability={CAP.INTEGRATION_PLUGINS_ACTIVATE}
                  onClick={async () => {
                    try {
                      await activatePlugin.mutateAsync({
                        plugin_version_id: latest.id,
                        scope_type: lifecycleScope.scope_type,
                        scope_id: lifecycleScope.scope_id,
                      });
                      pushToast(`Activated · ${plugin.name} v${latest.version}`, 'good');
                      await openPluginDrawer(plugin);
                    } catch (err) {
                      pushToast(`Activate failed · ${(err as Error)?.message ?? ''}`, 'danger');
                    }
                  }}
                />,
              );
            }
            if (activeVersion && activeNextActions.includes('deactivate')) {
              buttons.push(
                <Button
                  key="deactivate"
                  label="Deactivate plugin"
                  iconName="pause"
                  kind="danger"
                  capability={CAP.INTEGRATION_PLUGINS_ACTIVATE}
                  disabled={!plugin.active_version_id}
                  onClick={async () => {
                    try {
                      await deactivatePlugin.mutateAsync({
                        plugin_id: plugin.id,
                        plugin_version_id: activeVersion.id,
                        reason: `Console deactivate ${plugin.name} ${pluginVersionDisplay(activeVersion)}`,
                      });
                      pushToast(`Deactivated · ${plugin.name} ${pluginVersionDisplay(activeVersion)}`, 'warn');
                      await openPluginDrawer(plugin);
                    } catch (err) {
                      pushToast(`Deactivate failed · ${(err as Error)?.message ?? ''}`, 'danger');
                    }
                  }}
                />,
              );
            }
            return buttons.length > 0 ? <>{buttons}</> : null;
          })()}
          <div style={{ flex: 1 }} />
          {rollbackDisabledReason ? (
            <span className="state__hint" role="status" style={{ margin: 0 }}>
              {rollbackDisabledReason}
            </span>
          ) : null}
          <Button
            label={rollbackTarget ? `Rollback to ${rollbackTargetLabel}` : 'Rollback unavailable'}
            iconName="history"
            kind="danger"
            capability={CAP.INTEGRATION_PLUGINS_ACTIVATE}
            disabled={!rollbackTarget}
            title={rollbackDisabledReason ?? `Rollback ${plugin.name} to ${rollbackTargetLabel}`}
            onClick={async () => {
              if (!rollbackTarget) return;
              try {
                await uninstallPlugin.mutateAsync({
                  plugin_id: plugin.id,
                  target_plugin_version_id: rollbackTarget.id,
                  reason: `Console rollback to ${rollbackTargetLabel}`,
                });
                pushToast(`Rollback applied - ${plugin.name} -> ${rollbackTargetLabel}`, 'warn');
                await openPluginDrawer(plugin);
              } catch (err) {
                pushToast(`Rollback failed - ${(err as Error)?.message ?? ''}`, 'danger');
              }
            }}
          />
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
    if (!focusedPlugin) return undefined;
    const frame = window.requestAnimationFrame(() => {
      void openPluginDrawer(focusedPlugin);
      openedFocusRef.current = focusParam;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusParam, focusedPlugin]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-catalog"
          eyebrow="Integrations"
          titleAccent="Plugin"
          titlePlain="catalog"
          pills={[]}
        />
        <StateView
          kind="denied"
          capability={CAP.INTEGRATION_PLUGINS_READ}
          hint="You do not have permission to view the plugin catalog."
        />
      </div>
    );
  }

  if (pluginsQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-catalog"
          eyebrow="Integrations"
          titleAccent="Plugin"
          titlePlain="catalog"
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (pluginsQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-catalog"
          eyebrow="Integrations"
          titleAccent="Plugin"
          titlePlain="catalog"
          pills={[]}
        />
        <StateView kind="error" hint={String(pluginsQuery.error)} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="int-catalog"
        eyebrow="Integrations"
        titleAccent="Plugin"
        titlePlain="catalog"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="src" className="chip chip--xs mono">Plugin lifecycle · versions</span>,
          <span key="dir" className="chip chip--xs mono">Catalog directory</span>,
        ]}
        actions={[
          <Button
            key="add"
            label="Add integration"
            iconName="plus"
            kind="primary"
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            disabled={!defaultPluginKind || !defaultSourceType || !defaultAuthMode}
            onClick={openAddIntegration}
          />,
        ]}
      />
      {manualDraftReadback ? (
        <section
          className="card"
          data-testid="integration-catalog-manual-draft-readback"
          style={{ margin: '0 16px 12px', display: 'grid', gap: '8px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <Chip
              label={
                manualDraftReadback.visibleInCatalog && manualDraftReadback.visibleInDirectory
                  ? 'Integration confirmed'
                  : 'Finishing integration confirmation'
              }
              kind={
                manualDraftReadback.visibleInCatalog && manualDraftReadback.visibleInDirectory
                  ? 'good'
                  : 'warn'
              }
            />
            <Chip
              label={manualDraftReadback.visibleInCatalog ? 'Catalog available' : 'Catalog updating'}
              kind={manualDraftReadback.visibleInCatalog ? 'good' : 'warn'}
              size="xs"
            />
            <Chip
              label={manualDraftReadback.visibleInDirectory ? 'Directory available' : 'Directory updating'}
              kind={manualDraftReadback.visibleInDirectory ? 'good' : 'warn'}
              size="xs"
            />
            <span style={{ fontWeight: 600 }}>{manualDraftReadback.name || manualDraftReadback.vendor}</span>
            {manualDraftReadback.status ? (
              <span className="mono" style={{ color: 'var(--ink-3)' }}>
                {manualDraftReadback.status}
              </span>
            ) : null}
          </div>
          <div className="state__hint" style={{ color: 'var(--ink-3)', fontSize: '12px' }}>
            {[
              'Integration details confirmed',
              manualDraftReadback.vendor ? `Vendor: ${manualDraftReadback.vendor}` : null,
              manualDraftReadback.pluginKind ? `Type: ${manualDraftReadback.pluginKind}` : null,
              manualDraftReadback.sourceType ? `Source: ${manualDraftReadback.sourceType}` : null,
              manualDraftReadback.authMode ? `Security: ${manualDraftReadback.authMode}` : null,
              manualDraftReadback.directoryStatus ? `Directory: ${manualDraftReadback.directoryStatus}` : null,
              manualDraftReadback.pluginId ? `Integration reference: ${manualDraftReadback.pluginId}` : null,
              manualDraftReadback.visibleInCatalog ? 'Catalog listing confirmed' : null,
              manualDraftReadback.visibleInDirectory ? 'Directory listing confirmed' : null,
            ].filter(Boolean).join(' | ')}
          </div>
        </section>
      ) : null}
      {displayedPlugins.length === 0 ? (
        <StateView
          kind="empty"
          title="No plugins registered"
          hint="Add an integration to start receiving webhooks."
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
            gap: '12px',
            padding: '16px',
            overflow: 'auto',
            flex: 1,
          }}
        >
          {displayedPlugins.map((p) => {
            // W27 — read projection-derived fields when available.
            const proj = pluginDirectoryById.get(p.id);
            const vendorLabel = proj?.vendor ?? p.vendor ?? null;
            const versionLabel = proj?.version_label ?? p.version ?? null;
            const versionCount = proj?.version_count ?? 0;
            const bindingCount = proj?.binding_count ?? 0;
            const activeBindingCount = proj?.active_binding_count ?? 0;
            const bindingLabel = formatPluginBindingLabel(
              p.binding,
              activeBindingCount,
              bindingCount,
            );
            const isPendingReview = proj?.is_pending_review ?? false;
            return (
              <div
                key={p.id}
                className="card"
                aria-current={focusParam === p.id ? 'true' : undefined}
                data-testid={`integration-plugin-card-${p.id}`}
                style={{ cursor: 'pointer' }}
                onClick={() => void openPluginDrawer(p)}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '8px',
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: '13.5px' }}>{p.name}</span>
                  <span
                    className="mono"
                    style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}
                  >
                    {versionLabel}
                  </span>
                  <div style={{ flex: 1 }} />
                  {/* W70 (Cycle F-R-10 P2-3 closure): pending-review badge
                      sources label/tone strictly from the canonical
                      `plugin_status='pending_review'` lookup row (no inline
                      `label="pending review"` / `kind="warn"` literals).
                      Visibility is policy-driven — the row is only rendered
                      when `metadata.is_chip_visible === true`. */}
                  {isPendingReview ? (
                    <PluginVersionRowChip value="pending_review" />
                  ) : null}
                  <PluginStatusChip value={p.status} />
                </div>
                <div
                  className="mono"
                  style={{ fontSize: '10.5px', color: 'var(--ink-2)', marginBottom: '8px' }}
                >
                  {vendorLabel ?? '—'} · {pluginKindLabel(p.plugin_kind)}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '6px',
                    marginTop: '6px',
                  }}
                >
                  {statBox(
                    'Versions',
                    versionCount > 0 ? versionCount.toLocaleString() : '—',
                  )}
                  {statBox(
                    'Bindings',
                    bindingCount > 0
                      ? `${activeBindingCount}/${bindingCount}`
                      : '—',
                  )}
                  {statBox(
                    'Health',
                    p.health == null ? '—' : `${(p.health * 100).toFixed(0)}%`,
                  )}
                </div>
                <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--ink-2)' }}>
                  Binding: {bindingLabel}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {drawer.node}
      {modal.node}
    </div>
  );
}

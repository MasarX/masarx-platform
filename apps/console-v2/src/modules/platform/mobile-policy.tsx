// mobile-policy.tsx — Tabbed editor for the canonical mobile policies + Resolved-View
// Preview pane (synthetic FieldOps shell) + Devices subview with attestation filter +
// per-card scope ladder visualizer + per-policy "Request change" CTA wired through
// the same `request_settings_change_v1` flow as platform/config.

import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { PageHeader } from '@/components/PageHeader';
import { ScopePill } from '@/components/ScopePill';
import { LadderViz } from '@/components/LadderViz';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import {
  useResourceList,
  useResolveMobilePolicy,
  useRevokeDevice,
  useProposeSettingsChange,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { getLookups } from '@/lib/api';
import type { Scope, SettingsResolution, ScopeType } from '@/types/domain';
import { fill, useI18n, type Translate } from '@/lib/i18n';

// W-Cycle-E2 (P2 #11) — resolves the canonical scope identifier for a given
// ladder tier from the active identity scope chain. Mirrors the helper at
// `feature-flags.tsx#resolveScopeId`. Replaces the prior hardcoded
// `tenant ? tenantId : (global ? 'global' : tenantId)` ternary cascade in
// PolicyEditorCard. Returns an empty string when the scope chain has no entry
// for the resolved tier — callers render an empty ScopePill ID rather than
// silently falling through to tenantId for unknown tiers.
function resolveScopeId(scopeType: string, scope: Scope): string {
  if (scopeType === 'global') return 'global';
  const target = (scope as Record<string, { id?: string } | undefined>)[scopeType];
  return target?.id ?? '';
}

function formatResolutionReference(value: string | null | undefined): string {
  const id = value?.trim();
  if (!id) return 'Resolution pending';
  if (id.length <= 12) return id;
  return `Resolution ${id.slice(0, 4)}...${id.slice(-4)}`;
}

// 10 canonical policy categories. Attestation is included so the
// CLAUDE.md mobile attestation contract is visible without leaving the page.
function policyCategories(t: Translate) {
  return [
    { key: 'mobile_visibility_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryVisibility'), resolver: 'resolve_mobile_visibility_policy' },
    { key: 'mobile_diagnostics_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryDiagnostics'), resolver: 'resolve_mobile_diagnostics_policy' },
    { key: 'device_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryDevice'), resolver: 'resolve_device_policy' },
    { key: 'navigation_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryNavigation'), resolver: 'resolve_navigation_policy' },
    { key: 'map_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryMap'), resolver: 'resolve_map_policy' },
    { key: 'communication_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryCommunication'), resolver: 'resolve_communication_policy' },
    { key: 'address_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryAddress'), resolver: 'resolve_address_policy' },
    { key: 'driver_safety_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryDriverSafety'), resolver: 'resolve_driver_safety_policy' },
    { key: 'ux_safety_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryUxSafety'), resolver: 'resolve_ux_safety_policy' },
    { key: 'mobile_attestation_policy', label: t('platformMobilePolicy.mobilePolicyModule.categoryAttestation'), resolver: 'resolve_mobile_attestation_policy' },
  ] as const;
}

// SCHEMA-DRIFT NOTE (Wave 6 / W6-6, updated W13-3 + W14-7 — see
// __audit__/SCHEMA-DRIFT/PLATFORM.md §5):
// FE shape on canonical `user_devices`. W13-3 surfaces canonical column
// names (`device_identifier_sha256`, `device_platform`) as additive optional
// fields alongside the legacy FE aliases.
//
// W14-7 close-out — dropped FE-fictional `model` / `attestation_status` /
// `trusted_at` from the row interface:
//   • `model` → resolves through canonical `metadata` jsonb projection
//     (`metadata->>'model'`) via `modelOf(d)`; the seed has been migrated to
//     nest the device model under canonical `metadata.model`.
//   • `attestation_status` + `trusted_at` → resolve through the canonical
//     `v_user_device_summary` paired projection view (W39 closure;
//     supabase/migrations/202604303100_v_user_device_summary.sql). The view
//     projects `metadata.model` → top-level `model`,
//     `metadata.attestation.status` → top-level `attestation_status`, and
//     `metadata.attestation.trusted_at` → top-level `attestation_trusted_at`
//     so the FE row consumer no longer needs metadata-helper bridges in
//     production. The `modelOf` / `attestationStatusOf` helpers below
//     remain as fallback for legacy seed-mode rows that still nest the
//     fields under `metadata.*`.
interface DeviceRow extends Record<string, unknown> {
  id: string;                     // SSOT: user_devices.id
  user_id: string;                // SSOT: user_devices.user_id
  device_id: string;              // Legacy alias for user_devices.device_identifier_sha256
  device_identifier_sha256?: string;  // SSOT: user_devices.device_identifier_sha256 (canonical)
  platform: string;               // Legacy alias for user_devices.device_platform
  device_platform?: string;       // SSOT: user_devices.device_platform (canonical)
  os_version?: string;            // SSOT: user_devices.os_version
  last_seen_at?: string;          // SSOT: user_devices.last_seen_at
  revoked_at?: string | null;
  revoked_reason?: string | null;
  is_revoked?: boolean | null;
  /** W39 — projected from `v_user_device_summary.model`
   *  (`user_devices.metadata->>'model'`). Fallback resolver `modelOf(row)`
   *  reads the metadata jsonb when this top-level field is absent. */
  model?: string | null;
  /** W39 — projected from `v_user_device_summary.attestation_status`
   *  (`user_devices.metadata->'attestation'->>'status'`). Fallback resolver
   *  `attestationStatusOf(row)` reads the metadata jsonb when this
   *  top-level field is absent. */
  attestation_status?: string | null;
  /** W39 — projected from `v_user_device_summary.attestation_trusted_at`
   *  (`user_devices.metadata->'attestation'->>'trusted_at'`). */
  attestation_trusted_at?: string | null;
  /** Canonical jsonb column from `public.user_devices.metadata` — retained
   *  on the projection view as `metadata` for surfaces that need to
   *  inspect the full jsonb (capability chips, additional drawer
   *  projections). */
  metadata?: Record<string, unknown> | null;
}

/** W14-7 / W39 — Resolve device `model`, preferring the canonical
 *  `v_user_device_summary.model` projection (W39 paired view) and falling
 *  back to `user_devices.metadata->>'model'` for legacy seed rows. */
function modelOf(row: DeviceRow): string | undefined {
  if (typeof row.model === 'string' && row.model.length > 0) return row.model;
  const v = row.metadata?.['model'];
  return typeof v === 'string' ? v : undefined;
}

/** W14-7 / W39 — Resolve attestation status, preferring the canonical
 *  `v_user_device_summary.attestation_status` projection (W39 paired
 *  view) and falling back to `metadata.attestation.status` for legacy
 *  seed rows. */
function attestationStatusOf(row: DeviceRow): string | undefined {
  if (typeof row.attestation_status === 'string' && row.attestation_status.length > 0) {
    return row.attestation_status;
  }
  const att = row.metadata?.['attestation'];
  if (att && typeof att === 'object' && !Array.isArray(att)) {
    const v = (att as Record<string, unknown>)['status'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function isDeviceRevoked(row: DeviceRow): boolean {
  return row.is_revoked === true || Boolean(row.revoked_at);
}

function deviceAccessStateOf(row: DeviceRow): string {
  return isDeviceRevoked(row) ? 'revoked' : 'active';
}

// W38-PLATFORM closure: removed `trustedAtOf` helper which was defined
// but had ZERO consumers in this module (verified via grep). Per
// AGENTS.md "no defensive backwards-compat shims for hypothetical
// future requirements", the helper is removed. If a future revision
// surfaces `trusted_at` from `mobile_attestation_records`, a paired
// projection view consumed via `useResourceList` is the canonical path
// rather than a metadata-projection helper.

// W50 — Attestation filter chips derive from canonical
// `mobile_attestation_status` lookup (`getLookups('mobile_attestation_status')`)
// with an `'all'` sentinel prepended for the "show all" chip. No hardcoded
// status array; if the lookup is empty (canonical seed gap), the device tab
// renders a `<StateView kind="error" />` instead of a degraded chip set.
type AttestationFilter = string;

// W14-7 / W39 — `model` + `attestation_status` are projected as top-level
// columns by the canonical paired view `v_user_device_summary` (W39
// closure). DataTable column keys now point to the canonical projection
// columns; the `render` callbacks fall through `modelOf` /
// `attestationStatusOf` so legacy seed rows that still nest the values
// under `metadata.*` continue to render identically.
function deviceColumns(t: Translate): DataTableColumn<DeviceRow>[] {
  return [
    { key: 'device_id', label: t('platformMobilePolicy.mobilePolicyModule.colDevice'), mono: true, sortable: true, filterable: true },
    { key: 'user_id', label: t('platformMobilePolicy.mobilePolicyModule.colUser'), mono: true, sortable: true, filterable: true },
    { key: 'platform', label: t('platformMobilePolicy.mobilePolicyModule.colPlatform'), sortable: true, filterable: true },
    {
      key: 'model',
      label: t('platformMobilePolicy.mobilePolicyModule.colModel'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => modelOf(row) ?? '—',
    },
    { key: 'os_version', label: t('platformMobilePolicy.mobilePolicyModule.colOs'), sortable: true },
    {
      key: 'attestation_status',
      label: t('platformMobilePolicy.mobilePolicyModule.colAttestation'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => attestationStatusOf(row) ?? '—',
    },
    {
      key: 'access_state',
      label: t('platformMobilePolicy.mobilePolicyModule.colAccess'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => deviceAccessStateOf(row),
    },
    {
      key: 'revoked_reason',
      label: t('platformMobilePolicy.mobilePolicyModule.colRevocation'),
      filterable: true,
      render: (_raw, row) => {
        if (!isDeviceRevoked(row)) return t('platformMobilePolicy.mobilePolicyModule.notRevoked');
        return row.revoked_reason ?? t('platformMobilePolicy.mobilePolicyModule.revokedByBackend');
      },
    },
    { key: 'last_seen_at', label: t('platformMobilePolicy.mobilePolicyModule.colLastSeen'), format: 'datetime', sortable: true },
  ];
}

interface PolicyResolutionShape {
  category: string;
  value: Record<string, unknown> | unknown[] | string | number | boolean | null;
  resolved_from: string;
  ladder_path?: SettingsResolution['ladder_path'];
  settings_resolution_id?: string;
  override_of?: string | null;
  resolver?: string;
  // legacy backward-compat field names
  srlv?: string;
  overrides?: string;
}

// W54-D — `scope_type_registry` row shape mirrors the canonical SSOT seed
// (`scope_type_registry` in policies.js + the paired backend migration
// 202601301100_scope_registry_ssot.sql). Drives the Scope <select> options
// for the Change-request form so the option list stays row-driven instead
// of an inline `<option>` literal cluster.
interface ScopeTypeRegistryRow {
  id: string;
  scope_type: string;
  description?: string;
  ladder_rank: number;
  is_enabled?: boolean;
}

function ChangeRequestForm({
  category,
  resolverName,
  onClose,
}: {
  category: string;
  resolverName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const propose = useProposeSettingsChange();
  const { scope } = useIdentity();
  const tenantId = scope.tenant?.id ?? '';
  const [scopeType, setScopeType] = useState<ScopeType>('tenant');
  const [value, setValue] = useState('{\n  "example": true\n}');
  const [justification, setJustification] = useState('');

  // W54-D — Scope dropdown options derive from canonical
  // `scope_type_registry` (rank-sorted ascending; only enabled rows). The
  // proposeSettingsChange RPC accepts the canonical scope_type values
  // (global/tenant/client/sender/source/resource) so any registry-enabled
  // scope is a valid target. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
  const scopeRegistryQuery = useResourceList<ScopeTypeRegistryRow>('scope_type_registry');
  const scopeOptions = useMemo<Array<{ value: string; label: string }>>(() => {
    const rows = scopeRegistryQuery.data?.rows ?? [];
    return rows
      .filter((r) => r.is_enabled !== false)
      .slice()
      .sort((a, b) => a.ladder_rank - b.ladder_rank)
      .map((r) => ({
        value: r.scope_type,
        label: r.scope_type.charAt(0).toUpperCase() + r.scope_type.slice(1),
      }));
  }, [scopeRegistryQuery.data]);

  const submit = async (dryRun: boolean) => {
    try {
      const parsed: unknown = JSON.parse(value);
      const res = await propose.mutateAsync({
        category,
        scope: { [scopeType]: { id: tenantId } },
        value: parsed,
        dryRun,
        justification,
      });
      const srlv = (res as { settings_resolution_id?: string } | undefined)?.settings_resolution_id ?? 'queued';
      pushToast(
        `request_settings_change_v1 · ${dryRun ? 'dry-run' : 'submitted'} · ${srlv}`,
        'good',
      );
      if (!dryRun) onClose();
    } catch (err) {
      pushToast(fill(t('platformMobilePolicy.changeRequestForm.proposeFailed'), { value: String((err as Error)?.message || 'invalid JSON') }), 'danger');
    }
  };

  return (
    <div>
      <p className="state__hint">
        {fill(t('platformMobilePolicy.changeRequestForm.submitsViaRequestSettings'), { resolverName: String(resolverName) })}
      </p>
      <div className="field">
        <label className="field__label">{t('platformMobilePolicy.changeRequestForm.scope')}</label>
        <select className="field" value={scopeType} onChange={(e) => setScopeType(e.target.value as ScopeType)}>
          {scopeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label">{t('platformMobilePolicy.changeRequestForm.proposedValueJsonValidated')}</label>
        <textarea
          rows={5}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', width: '100%' }}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('platformMobilePolicy.changeRequestForm.justification')}</label>
        <input
          type="text"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          placeholder={t('platformMobilePolicy.changeRequestForm.requiredByKsaDriver')}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
        <Button label={t('platformMobilePolicy.changeRequestForm.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={t('platformMobilePolicy.changeRequestForm.previewImpactDryRun')}
          iconName="search"
          kind="primary"
          capability={CAP.SETTINGS_WRITE}
          onClick={() => submit(true)}
        />
        <Button
          label={t('platformMobilePolicy.changeRequestForm.submit')}
          iconName="check"
          kind="primary"
          capability={CAP.SETTINGS_WRITE}
          onClick={() => submit(false)}
        />
      </div>
    </div>
  );
}

function DeviceRevokeForm({
  row,
  onClose,
}: {
  row: DeviceRow;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const revokeDevice = useRevokeDevice();
  const [reason, setReason] = useState('');
  const deviceId = String(row.device_id ?? row.device_identifier_sha256 ?? row.id);
  const trimmedReason = reason.trim();

  const submit = async () => {
    if (!trimmedReason) {
      pushToast(t('platformMobilePolicy.deviceRevokeForm.revocationReasonRequired'), 'warn');
      return;
    }
    try {
      await revokeDevice.mutateAsync({ deviceId: row.id, revokedReason: trimmedReason });
      pushToast(`ui_execute_user_device_revoke_v1 - ${deviceId} - revoked`, 'good');
      onClose();
    } catch (err) {
      pushToast(fill(t('platformMobilePolicy.deviceRevokeForm.revokeFailed'), { value: String((err as Error)?.message || t('platformMobilePolicy.deviceRevokeForm.unknownError')) }), 'danger');
    }
  };

  return (
    <div className="form-grid" data-testid="mobile-device-revoke-form">
      <p className="state__hint">
        {t('platformMobilePolicy.deviceRevokeForm.revokeBackendAccessFor')} <span className="mono">{deviceId}</span>
        {t('platformMobilePolicy.deviceRevokeForm.theDevicesTableRefreshes')}
      </p>
      <label className="field__label" htmlFor={`mobile-device-revoke-reason-${row.id}`}>
        {t('platformMobilePolicy.deviceRevokeForm.revocationReason')}
      </label>
      <input
        id={`mobile-device-revoke-reason-${row.id}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('platformMobilePolicy.deviceRevokeForm.lostDeviceReplacedScanner')}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Button label={t('platformMobilePolicy.deviceRevokeForm.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={revokeDevice.isPending ? t('platformMobilePolicy.deviceRevokeForm.revoking') : t('platformMobilePolicy.deviceRevokeForm.confirmRevoke')}
          kind="danger"
          capability={CAP.USER_DEVICES_WRITE}
          disabled={!trimmedReason || revokeDevice.isPending}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}

function PolicyEditorCard({
  category,
  resolverName,
  label,
  tenantId,
  scope,
  onRequestChange,
}: {
  category: string;
  resolverName: string;
  label: string;
  tenantId: string;
  scope: Scope;
  onRequestChange: () => void;
}) {
  const { t } = useI18n();
  const { data, isLoading } = useResolveMobilePolicy(category);
  const resolved = data as PolicyResolutionShape | undefined;

  const valueObj =
    resolved && typeof resolved.value === 'object' && resolved.value && !Array.isArray(resolved.value)
      ? (resolved.value as Record<string, unknown>)
      : null;
  const rows: KvRow[] = valueObj
    ? Object.entries(valueObj).map(([k, v]) => ({
        key: k,
        label: k,
        value: typeof v === 'object' ? JSON.stringify(v) : (v as unknown),
        mono: true,
      }))
    : [];

  const resolvedFrom = resolved?.resolved_from || 'global';
  const overrides = resolved?.overrides ?? resolved?.override_of ?? null;
  const resolutionRef = formatResolutionReference(resolved?.settings_resolution_id ?? resolved?.srlv);

  // W-Cycle-E2 (P2 #11) — resolved scope ID derives from the canonical
  // identity scope chain via `resolveScopeId(resolvedFrom, scope)`. Replaces
  // the prior `tenant ? tenantId : (global ? 'global' : tenantId)` ternary
  // cascade that fell through to tenantId for unknown tiers.
  const resolvedScopeId = resolveScopeId(resolvedFrom, scope);

  return (
    <div className="card" data-testid={`policy-card-${category}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className="eyebrow">{label}</span>
        <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
          {category}
        </span>
        <div style={{ flex: 1 }} />
        <ScopePill
          scopeType={resolvedFrom}
          scopeId={resolvedScopeId}
        />
        {overrides ? (
          <Chip
            label={fill(t('platformMobilePolicy.policyEditorCard.overrides'), { resolvedFrom: String(resolvedFrom), overrides: String(overrides) })}
            kind="warn"
            size="xs"
          />
        ) : null}
        <Button
          label={t('platformMobilePolicy.policyEditorCard.requestChange')}
          iconName="edit"
          kind="ghost"
          size="sm"
          capability={CAP.SETTINGS_WRITE}
          onClick={onRequestChange}
        />
      </div>

      {isLoading ? (
        <StateView kind="loading" />
      ) : !resolved ? (
        <StateView kind="empty" hint={t('platformMobilePolicy.policyEditorCard.noPolicyResolved')} />
      ) : rows.length ? (
        <KvGrid rows={rows} />
      ) : (
        <pre
          className="mono"
          style={{
            background: 'var(--paper-3)',
            padding: '8px',
            borderRadius: '4px',
            fontSize: '11px',
            marginTop: '8px',
            overflow: 'auto',
          }}
        >
          {JSON.stringify(resolved.value ?? {}, null, 2)}
        </pre>
      )}

      {resolved?.ladder_path?.length ? (
        <>
          <div className="eyebrow" style={{ marginTop: '10px', fontSize: '10.5px' }}>{t('platformMobilePolicy.policyEditorCard.scopeLadder')}</div>
          <LadderViz resolution={resolved as unknown as SettingsResolution} />
        </>
      ) : null}

      <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)', marginTop: '6px' }}>
        {`${resolverName}() · ${resolutionRef}`}
      </div>
    </div>
  );
}

function MobileShellPreview() {
  const { t } = useI18n();
  const { data: visibility } = useResolveMobilePolicy('mobile_visibility_policy');
  const { data: safety } = useResolveMobilePolicy('driver_safety_policy');
  const visRes = visibility as PolicyResolutionShape | undefined;
  const safetyRes = safety as PolicyResolutionShape | undefined;
  const surfaces = (() => {
    const v = visRes?.value;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const surfacesUnknown = (v as Record<string, unknown>)['surfaces'];
      if (Array.isArray(surfacesUnknown)) return surfacesUnknown.filter(Boolean) as string[];
    }
    return [] as string[];
  })();
  const lockKph = (() => {
    const v = safetyRes?.value;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entry = (v as Record<string, unknown>)['lock_threshold_kph'];
      if (typeof entry === 'number') return entry;
    }
    return null;
  })();

  return (
    <div className="mobile-preview" style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
      <div className="eyebrow">{t('platformMobilePolicy.mobileShellPreview.resolvedViewPreview')}</div>
      <div
        style={{
          width: '280px',
          height: '560px',
          background: 'var(--paper-3)',
          border: '1px solid var(--line-strong)',
          borderRadius: '24px',
          padding: '20px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: '15px',
            letterSpacing: '-0.012em',
            textAlign: 'center',
          }}
        >
          {t('platformMobilePolicy.mobileShellPreview.fieldOps')}
        </div>
        <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)', textAlign: 'center' }}>
          {t('platformMobilePolicy.mobileShellPreview.driverKhalidAlOtaibi')}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
          {surfaces.length === 0 ? (
            <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)', textAlign: 'center' }}>
              {t('platformMobilePolicy.mobileShellPreview.noSurfacesResolved')}
            </div>
          ) : (
            surfaces.map((s) => (
              <div
                key={s}
                className="card"
                style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 500 }}
              >
                {s}
              </div>
            ))
          )}
        </div>
        <div className="mono" style={{ fontSize: '9.5px', color: 'var(--ink-3)', textAlign: 'center', marginTop: '8px' }}>
          {lockKph != null ? fill(t('platformMobilePolicy.mobileShellPreview.lockThresholdKphDriver'), { lockKph: String(lockKph) }) : t('platformMobilePolicy.mobileShellPreview.driverSafetyPolicyPending')}
        </div>
      </div>
      <p className="state__hint" style={{ textAlign: 'center', maxWidth: '300px' }}>
        {t('platformMobilePolicy.mobileShellPreview.simulatedFieldopsShell')}
      </p>
    </div>
  );
}

export function MobilePolicyModule() {
  const { t } = useI18n();
  const categories = useMemo(() => policyCategories(t), [t]);
  const deviceTableColumns = useMemo(() => deviceColumns(t), [t]);
  const canRead = useCapability(CAP.SETTINGS_READ);
  const canReadDevices = useCapability(CAP.USER_DEVICES_READ);
  const { scope } = useIdentity();
  const tenantId = scope.tenant?.id ?? '';
  const [activeTab, setActiveTab] = useState<string>('policies');

  // W39 PLATFORM closure — consume canonical paired projection view
  // `public.v_user_device_summary` (supabase/migrations/
  // 202604303100_v_user_device_summary.sql) for top-level `model` /
  // `attestation_status` / `attestation_trusted_at` projections, eliminating
  // the long-standing metadata-helper bridge. SSOT remains user_devices;
  // resolver helpers (modelOf / attestationStatusOf) prefer the
  // top-level projection columns, falling back to metadata jsonb for
  // back-compat with legacy seed rows.
  const devicesQuery = useResourceList<DeviceRow>(
    'user_device_summary',
    undefined,
    { enabled: canRead && canReadDevices },
  );
  const modal = useModal();

  const [attestationFilter, setAttestationFilter] = useState<AttestationFilter>('all');
  // W50 — Resolve filter chips from canonical `mobile_attestation_status`
  // lookup (no hardcoded status array). `'all'` sentinel prepends the
  // canonical values so the "show all" chip always exists; if the canonical
  // lookup is missing, the chip toolbar surfaces a `<StateView kind="error"/>`
  // instead of degrading silently to an empty filter set.
  const attestationFilters = useMemo<string[]>(() => {
    const rows = (getLookups('mobile_attestation_status') ?? []) as Array<{ value: string }>;
    return ['all', ...rows.map((r) => r.value)];
  }, []);
  const filteredDevices = useMemo(() => {
    const rows = devicesQuery.data?.rows ?? [];
    if (attestationFilter === 'all') return rows;
    if (attestationFilter === 'revoked') return rows.filter((d) => isDeviceRevoked(d));
    // W14-7 — read canonical projection (metadata.attestation.status) instead
    // of the dropped top-level FE alias `attestation_status`.
    return rows.filter((d) => !isDeviceRevoked(d) && (attestationStatusOf(d) ?? '').toLowerCase() === attestationFilter);
  }, [devicesQuery.data, attestationFilter]);

  const onRevoke = (row: DeviceRow) => {
    const deviceId = String(row.device_id ?? row.device_identifier_sha256 ?? row.id);
    modal.open({
      title: fill(t('platformMobilePolicy.mobilePolicyModule.revokeDevice'), { deviceId: String(deviceId) }),
      body: <DeviceRevokeForm row={row} onClose={() => modal.close()} />,
    });
  };

  const openRequestChange = (category: string, resolverName: string, label: string) => {
    modal.open({
      title: fill(t('platformMobilePolicy.mobilePolicyModule.requestChange'), { label: String(label) }),
      body: (
        <ChangeRequestForm
          category={category}
          resolverName={resolverName}
          onClose={() => modal.close()}
        />
      ),
    });
  };

  const tabs: { id: string; label: string }[] = [
    { id: 'policies', label: fill(t('platformMobilePolicy.mobilePolicyModule.policies'), { length: String(categories.length) }) },
    { id: 'devices', label: t('platformMobilePolicy.mobilePolicyModule.devices') },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="mobilePolicy"
          eyebrow={t('platformMobilePolicy.mobilePolicyModule.platform')}
          titleAccent={t('platformMobilePolicy.mobilePolicyModule.titleAccent')}
          titlePlain={t('platformMobilePolicy.mobilePolicyModule.titlePlain')}
          pills={[
            <ScopePill scopeType="tenant" scopeId={tenantId} />,
            <span className="chip chip--xs mono">{fill(t('platformMobilePolicy.mobilePolicyModule.canonicalCategoriesResolverDriven'), { length: String(categories.length) })}</span>,
          ] as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.SETTINGS_READ}
          hint={t('platformMobilePolicy.mobilePolicyModule.youDoNotHave')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="mobilePolicy"
        eyebrow={t('platformMobilePolicy.mobilePolicyModule.platform')}
        titleAccent={t('platformMobilePolicy.mobilePolicyModule.titleAccent')}
        titlePlain={t('platformMobilePolicy.mobilePolicyModule.titlePlain')}
        pills={[
          <ScopePill scopeType="tenant" scopeId={tenantId} />,
          <span className="chip chip--xs mono">{fill(t('platformMobilePolicy.mobilePolicyModule.canonicalCategoriesResolverDriven'), { length: String(categories.length) })}</span>,
        ] as ReactNode[]}
        // W38-PLATFORM closure: header-level "Revoke (synthetic)" CTA
        // removed because it called onRevoke('dev_synth') with a hardcoded
        // synthetic device_id that cannot bind to a real user_device at
        // click time. Per AGENTS.md "no defensive backwards-compat shims
        // for hypothetical future requirements", per-row Revoke flows
        // already exist in the rowActions wired to the canonical r.id
        // (see DataTable rowActions below at line 573 — onClick: (r) =>
        // onRevoke(r.id)).
        actions={[]}
      />

      <div className="dt-toolbar" style={{ borderBottom: '1px solid var(--line)' }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`dt-tb-view-tab ${activeTab === tab.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            data-testid={`mobile-policy-tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'policies' ? (
        <div
          className="policy-editor"
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '1fr 360px',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '16px',
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            {categories.map((c) => (
              <PolicyEditorCard
                key={c.key}
                category={c.key}
                resolverName={c.resolver}
                label={c.label}
                tenantId={tenantId}
                scope={scope}
                onRequestChange={() => openRequestChange(c.key, c.resolver, c.label)}
              />
            ))}
          </div>
          <div
            style={{
              borderLeft: '1px solid var(--line)',
              background: 'var(--paper)',
              padding: '16px',
              overflow: 'auto',
            }}
          >
            <MobileShellPreview />
          </div>
        </div>
      ) : (
        <div style={{ padding: '0 16px 16px', overflow: 'auto', flex: 1 }}>
          {!canReadDevices ? (
            <StateView
              kind="denied"
              capability={CAP.USER_DEVICES_READ}
              hint={t('platformMobilePolicy.mobilePolicyModule.youDoNotHave2')}
            />
          ) : attestationFilters.length <= 1 ? (
            <StateView
              kind="error"
              hint={t('platformMobilePolicy.mobilePolicyModule.mobileAttestationStatusOptions')}
            />
          ) : (
            <div className="dt-toolbar" style={{ marginBottom: '6px' }}>
              <span className="eyebrow">{t('platformMobilePolicy.mobilePolicyModule.attestationFilter')}</span>
              {attestationFilters.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`dt-tb-view-tab ${attestationFilter === f ? 'is-active' : ''}`}
                  onClick={() => setAttestationFilter(f)}
                  data-testid={`attestation-filter-${f}`}
                >
                  {f}
                </button>
              ))}
              <span className="dt-tb-spacer" />
              <span className="dt-tb-count mono">{`${filteredDevices.length}/${devicesQuery.data?.rows?.length ?? 0}`}</span>
            </div>
          )}
          <div className="section-eyebrow">{t('platformMobilePolicy.mobilePolicyModule.userDevicesAttestationGoverned')}</div>
          {canReadDevices ? devicesQuery.isLoading ? (
            <StateView kind="loading" />
          ) : devicesQuery.isError ? (
            <StateView
              kind="error"
              title={t('platformMobilePolicy.mobilePolicyModule.deviceActivityUnavailable')}
              hint={(devicesQuery.error as Error | undefined)?.message ?? t('platformMobilePolicy.mobilePolicyModule.theDeviceRegistryCould')}
            />
          ) : (
            <DataTable<DeviceRow>
              columns={deviceTableColumns}
              rows={filteredDevices}
              viewKey="user_devices"
              entityKind="user_devices"
              rowActions={[
                {
                  label: t('platformMobilePolicy.mobilePolicyModule.revokeDevice2'),
                  icon: 'lock',
                  kind: 'danger',
                  capability: CAP.USER_DEVICES_WRITE,
                  disabled: (r) => isDeviceRevoked(r),
                  disabledReason: 'Device is already revoked',
                  onClick: (r) => onRevoke(r),
                },
              ]}
            />
          ) : null}
        </div>
      )}

      {modal.node}
    </div>
  );
}

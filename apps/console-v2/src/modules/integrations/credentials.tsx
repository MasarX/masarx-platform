// integrations/credentials.tsx — provider_auth_configs (scoped secrets vault).
// Backed by:
//   - public.provider_auth_configs (id, provider_id, auth_type, credentials JSONB,
//     expires_at, created_at) — supabase/migrations/202510110004_webhook_integration.sql:42
//   - public.providers (id, organization_id, name, provider_type, …) — same migration L12
//
// Important: `status` is not a real column on provider_auth_configs; it is
// derived by the credential directory. `last_rotated_at` is backend-maintained
// for credential-material replacements and still falls back to `created_at`
// for older rows.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn, type DataTableAction, type DataTableBulkAction } from '@/components/DataTable';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useResolveSettings,
  useBindProviderAccountCredential,
  useUnbindProviderAccountCredential,
  useUpsertProviderAuthConfig,
  useRotateProviderCredentials,
  useRevokeProviderAuthConfig,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import {
  DEFAULT_DANGER_DAYS_THRESHOLD,
  DEFAULT_EXPIRING_DAYS_THRESHOLD,
  deriveCredStatus,
  deriveLastRotatedAt,
} from './_credentials/derive';
import { ExternalIntakeWorkspaceToolbar } from './ExternalIntakeWorkspaceToolbar';
import { fill, useI18n } from '@/lib/i18n';

interface ProviderAuthConfigRaw extends Record<string, unknown> {
  id: string;
  provider_id: string;
  auth_type: string;
  status?: string;
  last_rotated_at?: string;
  expires_at?: string;
  created_at?: string;
}

interface ProviderAuthConfig extends ProviderAuthConfigRaw {
  status: string; // always populated after derivation
  // W27 — projection-derived fields from v_integration_credential_directory
  days_until_expiry?: number | null;
  provider_label?: string | null;
  provider_kind?: string | null;
  provider_vendor?: string | null;
  is_expiring?: boolean;
  is_expired?: boolean;
  is_active?: boolean;
}

/**
 * W27 — Canonical projection from `public.v_integration_credential_directory`
 * (supabase/migrations/202604302530_v_integration_credential_directory.sql).
 * Joined to `ProviderAuthConfigRaw` by id to surface derived joins
 * (provider_label / provider_kind / provider_vendor) + computed fields
 * (status / days_until_expiry / is_expiring / is_expired / is_active /
 * last_rotated_at with create-time fallback) without duplicating them onto the canonical row
 * interface. Production swap stays a single `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('integration_credential_directory')`.
 */
interface IntegrationCredentialDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  provider_id?: string | null;
  auth_type?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
  status?: 'active' | 'expiring' | 'expired' | 'revoked';
  days_until_expiry?: number | null;
  provider_label?: string | null;
  provider_kind?: string | null;
  provider_vendor?: string | null;
  is_expiring?: boolean;
  is_expired?: boolean;
  is_active?: boolean;
  provider_account_category?: string | null;
  company_id?: string | null;
  bound_scope_type?: string | null;
  bound_scope_id?: string | null;
  bound_settings_version_id?: string | null;
  last_rotated_at?: string | null;
}

// EXPORTED FOR UNIT TESTS — pure helpers.
//
// W26 Cycle B closure: `expiringDaysThreshold` is now a parameter (default 30)
// resolved at call site through the canonical `provider_credential_policy`
// settings category. Tests rely on the default for determinism; the live
// component reads the resolved value via `useResolveSettings`.
// Cycle E2 P2 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the imminent-
// expiry escalation window resolves through the canonical
// `provider_credential_policy` settings category (`danger_days_threshold`).
// `_FALLBACK` constants are acceptable only when consumed via
// `(resolved ?? FALLBACK)` — no silent `?? 0` defaults. The default of 7 days
// matches the established imminent-expiry pattern across the integrations
// catalog and is documented as the test-seam fallback when the resolved
// policy row is unavailable.

/*
function _legacyDeriveCredStatus(
  row: { status?: string; expires_at?: string; created_at?: string },
  nowMs: number = Date.now(),
  expiringDaysThreshold: number = DEFAULT_EXPIRING_DAYS_THRESHOLD,
): 'active' | 'expiring' | 'expired' | 'revoked' | 'unknown' {
  // W71-Integrations (Cycle F-R-11) closure — honour an explicit status when
  // the data-source provided one. Lifecycle resolution flows through the
  // canonical `provider_auth_status.metadata.lifecycle` token instead of
  // inline `row.status === 'revoked'|'active'` literal compares. AGENTS.md
  // §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  const lifecycle = lookupRow('provider_auth_status', row.status ?? '')?.metadata?.lifecycle;
  if (lifecycle === 'revoked') return 'revoked';
  if (!row.expires_at) return lifecycle === 'active' ? 'active' : 'unknown';
  const exp = Date.parse(row.expires_at);
  if (Number.isNaN(exp)) return 'unknown';
  if (exp <= nowMs) return 'expired';
  const daysLeft = Math.floor((exp - nowMs) / (1000 * 60 * 60 * 24));
  if (daysLeft <= expiringDaysThreshold) return 'expiring';
  return 'active';
}

function _legacyDeriveLastRotatedAt(row: { last_rotated_at?: string; created_at?: string }): string | undefined {
  return row.last_rotated_at ?? row.created_at;
}

*/

// Canonical-tone chip for `provider_auth_configs.status`. Tone + label resolve
// strictly through the `provider_auth_status` lookup category. Missing rows
// surface a danger-toned `(missing)` chip rather than a silent neutral default.
function CredStatusChip({ value }: { value: string }) {
  const { t } = useI18n();
  const row = lookupRow('provider_auth_status', value);
  return row ? (
    <Chip label={row.label} kind={row.tone as ChipKind} size="xs" />
  ) : (
    <Chip label={fill(t('integrationsCredentials.credStatusChip.unknownCredentialStatus'), { value: String(value) })} kind="danger" size="xs" />
  );
}

function isCredentialRevoked(row: { status?: string }): boolean {
  const metadata = lookupRow('provider_auth_status', row.status ?? '')?.metadata;
  return metadata?.is_revoked === true || metadata?.lifecycle === 'revoked';
}

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §12):
// Canonical SSOT is `public.providers`
// (supabase/migrations/202510110004_webhook_integration.sql:12-23) which has
// columns: id, organization_id, name, provider_type, enabled, priority_rank,
// health_status, metadata, created_at, updated_at.
//   • RENAMED: kind -> provider_type (canonical column name).
//   • PROJECTION: vendor resolves from `metadata.vendor`; retained as optional
//     derived UI projection so the DataTable reference sub-line keeps parity
//     with the existing seed shape (vendor lives on `providers` rows in the
//     demo seed under canonical metadata jsonb).
interface Provider extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  name: string;
  // SSOT: providers.provider_type (canonical column).
  provider_type: string;
  // SSOT: derived projection (`metadata.vendor`); not a top-level column.
  vendor?: string;
}

interface LookupValueRow extends Record<string, unknown> {
  value: string;
  label?: string | null;
  rank?: number | null;
  is_default?: boolean | null;
}

interface ProviderAccountSettingsValue {
  enabled?: boolean | null;
  company_id?: string | number | null;
  auth_config_id?: string | null;
  notes?: string | null;
}

interface ApiGatewayRouteRow extends Record<string, unknown> {
  id: string;
  route_name?: string | null;
  enabled?: boolean | null;
  method?: string | null;
  path_template?: string | null;
  path_pattern?: string | null;
  provider_id?: string | null;
  policy?: {
    provider_account?: {
      category?: string | null;
      required?: boolean | null;
      require_company_id?: boolean | null;
    } | null;
    auth?: {
      auth_type?: string | null;
    } | null;
  } | null;
}

interface ProviderAccountRouteOption {
  id: string;
  label: string;
  method: string;
  path: string;
  providerAccountCategory: string;
  providerId?: string | null;
  authType?: string | null;
  requireCompanyId: boolean;
}

function routePath(row: ApiGatewayRouteRow): string {
  return String(row.path_template ?? row.path_pattern ?? '').trim();
}

function providerAccountRoutePriority(route: ProviderAccountRouteOption): number {
  const searchable = `${route.id} ${route.label} ${route.method} ${route.path}`.toLowerCase();
  let score = 0;
  if (route.method === 'POST') score += 30;
  if (route.method === 'PUT' || route.method === 'PATCH') score -= 10;
  if (route.method === 'DELETE') score -= 30;
  if (/\b(create|request|intake|submit|new)\b/.test(searchable)) score += 50;
  if (/\b(ship|shipment|shipments|package|packages)\b/.test(searchable)) score += 12;
  if (/\b(update|amend|cancel|delete|status|track|tracking|callback)\b/.test(searchable)) score -= 24;
  if (route.requireCompanyId) score += 4;
  return score;
}

function providerAccountRouteOptions(rows: ApiGatewayRouteRow[]): ProviderAccountRouteOption[] {
  return rows
    .filter((row) => row.enabled !== false)
    .flatMap((row) => {
      const method = String(row.method ?? '').trim().toUpperCase();
      const path = routePath(row);
      const providerAccount = row.policy?.provider_account ?? null;
      const category = String(providerAccount?.category ?? '').trim();
      if (!method || !path || !category) return [];
      const authType = String(row.policy?.auth?.auth_type ?? '').trim();
      const routeName = String(row.route_name ?? '').trim();
      return [{
        id: row.id,
        label: routeName ? `${routeName} - ${method} ${path}` : `${method} ${path}`,
        method,
        path,
        providerAccountCategory: category,
        providerId: row.provider_id ?? null,
        authType: authType || null,
        requireCompanyId: providerAccount?.require_company_id === true,
      }];
    })
    .sort((a, b) => {
      const priority = providerAccountRoutePriority(b) - providerAccountRoutePriority(a);
      if (priority !== 0) return priority;
      return a.label.localeCompare(b.label);
    });
}

function toDatetimeLocal(value?: string | null): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 16);
}

export function CredentialsModule() {
  const { t } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.PROVIDER_AUTH_READ);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const tenantId = scope.tenant?.id ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const providersQuery = useResourceList<Provider>('providers', tenantListOpts, readQueryOptions);
  const authTypesQuery = useResourceList<LookupValueRow>('lookup_values', {
    filter: { category: 'provider_auth_type' },
    sort: { key: 'rank', dir: 'asc' },
    page_size: 50,
  }, readQueryOptions);
  const apiRoutesQuery = useResourceList<ApiGatewayRouteRow>('api_routes', {
    page_size: 100,
  }, readQueryOptions);
  // W27 — paired projection view `public.v_integration_credential_directory`
  // (supabase/migrations/202604302530_v_integration_credential_directory.sql).
  // Surfaces canonical status enum + provider_label/kind/vendor +
  // days_until_expiry + is_expiring/is_expired/is_active flags. Production
  // swap stays a single `getSupabaseClient()` branch in
  // `data-source.ts:ui_list_resource_v1('integration_credential_directory')`.
  const credDirectoryQuery =
    useResourceList<IntegrationCredentialDirectoryRow>(
      'integration_credential_directory',
      tenantListOpts,
      readQueryOptions,
    );
  // W26 Cycle B closure (AGENTS.md §2 ZERO HARDCODING): expiry thresholds
  // resolve through canonical `provider_credential_policy`
  // (lib/seed-raw/policies.js) — no inline `30` literal in component code.
  const credentialPolicy = useResolveSettings(
    'provider_credential_policy',
    tenantId ? { tenant: { id: tenantId } } : undefined,
    readQueryOptions,
  );
  const credentialPolicyValue = credentialPolicy.data?.value as
    | { expiring_days_threshold?: number; danger_days_threshold?: number }
    | undefined;
  const expiringDaysThreshold =
    credentialPolicyValue?.expiring_days_threshold ?? DEFAULT_EXPIRING_DAYS_THRESHOLD;
  const dangerDaysThreshold =
    credentialPolicyValue?.danger_days_threshold ?? DEFAULT_DANGER_DAYS_THRESHOLD;
  const bindProviderAccount = useBindProviderAccountCredential();
  const unbindProviderAccount = useUnbindProviderAccountCredential();
  const rotateCreds = useRotateProviderCredentials();
  const upsertCreds = useUpsertProviderAuthConfig();
  const revokeCreds = useRevokeProviderAuthConfig();

  const providers = useMemo(
    () => providersQuery.data?.rows ?? [],
    [providersQuery.data],
  );
  const providerAccountRoutes = useMemo(
    () => providerAccountRouteOptions(apiRoutesQuery.data?.rows ?? []),
    [apiRoutesQuery.data],
  );
  const [selectedProviderAccountRouteId, setSelectedProviderAccountRouteId] = useState<string>('');
  useEffect(() => {
    if (!providerAccountRoutes.length) {
      if (selectedProviderAccountRouteId) setSelectedProviderAccountRouteId('');
      return;
    }
    if (
      !selectedProviderAccountRouteId ||
      !providerAccountRoutes.some((route) => route.id === selectedProviderAccountRouteId)
    ) {
      setSelectedProviderAccountRouteId(providerAccountRoutes[0]!.id);
    }
  }, [providerAccountRoutes, selectedProviderAccountRouteId]);
  const selectedProviderAccountRoute = useMemo(
    () =>
      providerAccountRoutes.find((route) => route.id === selectedProviderAccountRouteId) ??
      providerAccountRoutes[0] ??
      null,
    [providerAccountRoutes, selectedProviderAccountRouteId],
  );
  const providerAccountSettingsCategory = selectedProviderAccountRoute?.providerAccountCategory ?? '';
  const providerAccountSettingsScope = useMemo(
    () => (tenantId ? { tenant: { id: tenantId } } : undefined),
    [tenantId],
  );
  const providerAccountQuery = useResolveSettings(
    providerAccountSettingsCategory,
    providerAccountSettingsScope,
    { enabled: canRead && Boolean(providerAccountSettingsCategory && tenantId) },
  );
  const providerAccountValue = providerAccountQuery.data?.value as ProviderAccountSettingsValue | undefined;
  const rawCredentials = useMemo(
    () =>
      (credDirectoryQuery.data?.rows ?? []).map((row) => ({
        id: row.id,
        provider_id: String(row.provider_id ?? ''),
        auth_type: String(row.auth_type ?? ''),
        status: row.status,
        last_rotated_at: row.last_rotated_at ?? row.created_at ?? undefined,
        expires_at: row.expires_at ?? undefined,
        created_at: row.created_at ?? undefined,
      })),
    [credDirectoryQuery.data],
  );

  const credDirectoryById = useMemo(() => {
    const map = new Map<string, IntegrationCredentialDirectoryRow>();
    for (const r of credDirectoryQuery.data?.rows ?? []) {
      map.set(r.id, r);
    }
    return map;
  }, [credDirectoryQuery.data]);

  // Derive status + last_rotated_at for every row before render. Prefer
  // projection-derived values when available (W27); fall back to client-side
  // derivation otherwise so the demo + production behave the same.
  const credentials = useMemo<ProviderAuthConfig[]>(
    () =>
      rawCredentials.map((r) => {
        const proj = credDirectoryById.get(r.id);
        return {
          ...r,
          status: proj?.status ?? deriveCredStatus(r, Date.now(), expiringDaysThreshold),
          last_rotated_at: proj?.last_rotated_at ?? deriveLastRotatedAt(r),
          // Carry projection-derived fields through for column rendering.
          days_until_expiry: proj?.days_until_expiry ?? null,
          provider_label: proj?.provider_label ?? null,
          provider_kind: proj?.provider_kind ?? null,
          provider_vendor: proj?.provider_vendor ?? null,
          is_expiring: proj?.is_expiring ?? false,
          is_expired: proj?.is_expired ?? false,
          is_active: proj?.is_active ?? false,
        };
      }),
    [rawCredentials, credDirectoryById, expiringDaysThreshold],
  );

  const providerById = useMemo(() => {
    const map = new Map<string, Provider>();
    providers.forEach((p) => map.set(p.id, p));
    return map;
  }, [providers]);
  const authTypes = useMemo(
    () => authTypesQuery.data?.rows ?? [],
    [authTypesQuery.data],
  );
  const readinessHref = tenantId
    ? `/platform/onboarding-readiness?scope_type=tenant&scope_id=${encodeURIComponent(tenantId)}`
    : '/platform/onboarding-readiness';
  const providerSetupBlocked = providers.length === 0;
  const createDisabledReason = providerSetupBlocked
    ? 'Complete tenant provider setup before creating credentials.'
    : authTypes.length === 0
      ? 'Provider auth type lookups are missing.'
      : undefined;
  const providerAccountRouteBlockedReason = apiRoutesQuery.isLoading
    ? 'Loading API gateway route policy.'
    : providerAccountRoutes.length === 0
      ? 'No API gateway route with provider-account policy is visible to this operator.'
      : undefined;
  const providerAccountCompanyId = providerAccountValue?.company_id == null
    ? ''
    : String(providerAccountValue.company_id);
  const providerAccountAuthConfigId = String(providerAccountValue?.auth_config_id ?? '').trim();
  const providerAccountBound = providerAccountAuthConfigId.length > 0;
  const providerAccountCredential = providerAccountAuthConfigId
    ? credentials.find((credential) => credential.id === providerAccountAuthConfigId)
    : undefined;
  function navigateToReadiness() {
    window.history.pushState(null, '', readinessHref);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  function openCredentialEditor(row?: ProviderAuthConfig) {
    const defaultProviderId = row?.provider_id ?? providers[0]?.id ?? '';
    const defaultAuthType =
      row?.auth_type
      ?? authTypes.find((item) => item.is_default)?.value
      ?? authTypes[0]?.value
      ?? '';

    async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const credentialsText = String(data.get('credentials') ?? '').trim();
      const expiresAt = String(data.get('expires_at') ?? '').trim();
      let credentials: Record<string, unknown> | undefined;

      if (credentialsText) {
        try {
          const parsed = JSON.parse(credentialsText) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Credential details must be a valid object.');
          }
          credentials = parsed as Record<string, unknown>;
        } catch (error) {
          pushToast(fill(t('integrationsCredentials.credentialsModule.credentialsJson'), { value: String((error as Error).message || 'Credential details are invalid.') }), 'danger');
          return;
        }
      }
      if (!row && !credentials) {
        pushToast(t('integrationsCredentials.credentialsModule.credentialDetailsAreRequired'), 'danger');
        return;
      }

      try {
        await upsertCreds.mutateAsync({
          ...(row ? { config_id: row.id } : {}),
          provider_id: String(data.get('provider_id') ?? defaultProviderId),
          auth_type: String(data.get('auth_type') ?? defaultAuthType),
          ...(credentials ? { credentials } : {}),
          ...(expiresAt || !row ? { expires_at: expiresAt ? new Date(expiresAt).toISOString() : null } : {}),
        });
        pushToast(fill(t('integrationsCredentials.credentialsModule.credential'), { value: String(row ? 'updated' : 'created') }), 'good');
        modal.close();
      } catch (error) {
        pushToast(fill(t('integrationsCredentials.credentialsModule.credentialSaveFailed'), { value: String((error as Error)?.message ?? '') }), 'danger');
      }
    }

    modal.open({
      title: row ? t('integrationsCredentials.credentialsModule.editCredential') : t('integrationsCredentials.credentialsModule.newCredential'),
      body: (
        <form id="provider-auth-config-form" data-testid="provider-auth-config-form" onSubmit={submit} className="form-grid">
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.provider')}</span>
            <select name="provider_id" defaultValue={defaultProviderId} required>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.authType')}</span>
            <select name="auth_type" defaultValue={defaultAuthType} required>
              {authTypes.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label ?? item.value}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.credentialDetails')}</span>
            <textarea
              name="credentials"
              rows={6}
              placeholder={t('integrationsCredentials.credentialsModule.text')}
              required={!row}
            />
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.expiresAt')}</span>
            <input name="expires_at" type="datetime-local" defaultValue={toDatetimeLocal(row?.expires_at)} />
          </label>
        </form>
      ),
      footer: (
        <>
          <Button size="sm" kind="ghost" onClick={() => modal.close()}>{t('integrationsCredentials.credentialsModule.cancel')}</Button>
          <Button
            size="sm"
            kind="primary"
            disabled={upsertCreds.isPending || providers.length === 0 || authTypes.length === 0}
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            className="provider-auth-config-save"
            ariaLabel={t('integrationsCredentials.credentialsModule.saveCredential')}
            onClick={() => {
              const form = document.getElementById('provider-auth-config-form') as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          >
            {upsertCreds.isPending ? t('integrationsCredentials.credentialsModule.saving') : t('integrationsCredentials.credentialsModule.saveCredential')}
          </Button>
        </>
      ),
    });
  }

  function openDeliveryApiAccountBinding() {
    async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const routeId = String(data.get('route_id') ?? selectedProviderAccountRoute?.id ?? '').trim();
      const selectedRoute =
        providerAccountRoutes.find((route) => route.id === routeId) ??
        selectedProviderAccountRoute;
      const companyId = String(data.get('company_id') ?? '').trim();
      const credentialsText = String(data.get('credentials') ?? '').trim();
      const expiresAt = String(data.get('expires_at') ?? '').trim();
      const reason = String(data.get('reason') ?? '').trim();
      let credentials: Record<string, unknown>;

      if (!selectedRoute) {
        pushToast(t('integrationsCredentials.credentialsModule.chooseAnApiGateway'), 'danger');
        return;
      }
      if (!companyId) {
        pushToast(t('integrationsCredentials.credentialsModule.companyIdIsRequired'), 'danger');
        return;
      }
      if (!credentialsText) {
        pushToast(t('integrationsCredentials.credentialsModule.basicAuthUsernameAnd'), 'danger');
        return;
      }

      try {
        const parsed = JSON.parse(credentialsText) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Delivery API credential details must be a valid object.');
        }
        credentials = parsed as Record<string, unknown>;
      } catch (error) {
        pushToast((error as Error).message || t('integrationsCredentials.credentialsModule.deliveryApiCredentialDetails'), 'danger');
        return;
      }

      if (!credentials.username || !credentials.password) {
        pushToast(t('integrationsCredentials.credentialsModule.deliveryApiBasicAuth'), 'danger');
        return;
      }

      try {
        await bindProviderAccount.mutateAsync({
          route_id: selectedRoute.id,
          route_method: selectedRoute.method,
          route_path: selectedRoute.path,
          provider_account_category: selectedRoute.providerAccountCategory,
          ...(tenantId ? { organization_id: tenantId } : {}),
          scope_type: 'tenant',
          company_id: companyId,
          auth_type: selectedRoute.authType ?? 'basic_auth',
          credentials,
          ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
          reason: reason || 'Console V2 delivery API account binding',
        });
        pushToast(t('integrationsCredentials.credentialsModule.deliveryApiAccountBound'), 'good');
        modal.close();
      } catch (error) {
        pushToast(fill(t('integrationsCredentials.credentialsModule.deliveryApiAccountBinding'), { value: String((error as Error)?.message ?? '') }), 'danger');
      }
    }

    modal.open({
      title: providerAccountBound ? t('integrationsCredentials.credentialsModule.updateDeliveryApiAccount') : t('integrationsCredentials.credentialsModule.setDeliveryApiAccount'),
      body: (
        <form id="provider-account-binding-form" data-testid="provider-account-binding-form" onSubmit={submit} className="form-grid">
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.apiRoute')}</span>
            <select
              name="route_id"
              defaultValue={selectedProviderAccountRoute?.id ?? ''}
              onChange={(event) => setSelectedProviderAccountRouteId(event.target.value)}
              required
              disabled={providerAccountRoutes.length === 0}
            >
              {providerAccountRoutes.map((route) => (
                <option key={route.id} value={route.id}>
                  {route.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.companyId')}</span>
            <input name="company_id" defaultValue={providerAccountCompanyId} required />
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.basicAuthCredentials')}</span>
            <textarea
              name="credentials"
              rows={6}
              placeholder={t('integrationsCredentials.credentialsModule.text2')}
              required
            />
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.expiresAt')}</span>
            <input name="expires_at" type="datetime-local" />
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.changeReason')}</span>
            <input name="reason" placeholder={t('integrationsCredentials.credentialsModule.firstTenantApiShipment')} />
          </label>
        </form>
      ),
      footer: (
        <>
          <Button size="sm" kind="ghost" onClick={() => modal.close()}>{t('integrationsCredentials.credentialsModule.cancel')}</Button>
          <Button
            size="sm"
            kind="primary"
            disabled={bindProviderAccount.isPending || providerAccountRoutes.length === 0}
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            ariaLabel={t('integrationsCredentials.credentialsModule.bindDeliveryApiAccount')}
            onClick={() => {
              const form = document.getElementById('provider-account-binding-form') as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          >
            {bindProviderAccount.isPending ? t('integrationsCredentials.credentialsModule.binding') : t('integrationsCredentials.credentialsModule.bindDeliveryApiAccount')}
          </Button>
        </>
      ),
    });
  }

  function openDeliveryApiAccountUnbind() {
    if (!selectedProviderAccountRoute) {
      pushToast(t('integrationsCredentials.credentialsModule.chooseAnApiGateway2'), 'danger');
      return;
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const reason = String(data.get('reason') ?? '').trim();
      if (!reason) {
        pushToast(t('integrationsCredentials.credentialsModule.unbindReasonIsRequired'), 'danger');
        return;
      }

      try {
        await unbindProviderAccount.mutateAsync({
          route_id: selectedProviderAccountRoute.id,
          route_method: selectedProviderAccountRoute.method,
          route_path: selectedProviderAccountRoute.path,
          provider_account_category: selectedProviderAccountRoute.providerAccountCategory,
          ...(tenantId ? { organization_id: tenantId } : {}),
          scope_type: 'tenant',
          ...(providerAccountCompanyId ? { company_id: providerAccountCompanyId } : {}),
          reason,
        });
        pushToast(t('integrationsCredentials.credentialsModule.deliveryApiAccountUnbound'), 'warn');
        modal.close();
      } catch (error) {
        pushToast(fill(t('integrationsCredentials.credentialsModule.deliveryApiAccountUnbind'), { value: String((error as Error)?.message ?? '') }), 'danger');
      }
    }

    modal.open({
      title: t('integrationsCredentials.credentialsModule.unbindDeliveryApiAccount'),
      body: (
        <form id="provider-account-unbind-form" data-testid="provider-account-unbind-form" onSubmit={submit} className="form-grid">
          <div className="state state--warn">
            <div className="state__title">{t('integrationsCredentials.credentialsModule.providerDispatchForThis')}</div>
            <div className="state__hint mono">
              {selectedProviderAccountRoute.method} {selectedProviderAccountRoute.path}
            </div>
          </div>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.unbindReason')}</span>
            <input name="reason" placeholder={t('integrationsCredentials.credentialsModule.credentialRetiredForThis')} required />
          </label>
        </form>
      ),
      footer: (
        <>
          <Button size="sm" kind="ghost" onClick={() => modal.close()}>{t('integrationsCredentials.credentialsModule.cancel')}</Button>
          <Button
            size="sm"
            kind="danger"
            disabled={unbindProviderAccount.isPending}
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            ariaLabel={t('integrationsCredentials.credentialsModule.unbindDeliveryApiAccount')}
            onClick={() => {
              const form = document.getElementById('provider-account-unbind-form') as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          >
            {unbindProviderAccount.isPending ? t('integrationsCredentials.credentialsModule.unbinding') : t('integrationsCredentials.credentialsModule.unbindDeliveryApiAccount')}
          </Button>
        </>
      ),
    });
  }

  function openCredentialRotation(row: ProviderAuthConfig) {
    async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const credentialsText = String(data.get('credentials') ?? '').trim();
      const vaultId = String(data.get('credentials_vault_id') ?? '').trim();
      const expiresAt = String(data.get('expires_at') ?? '').trim();
      const reason = String(data.get('reason') ?? '').trim();
      let credentials: Record<string, unknown> | undefined;

      if (credentialsText) {
        try {
          const parsed = JSON.parse(credentialsText) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Replacement credential details must be a valid object.');
          }
          credentials = parsed as Record<string, unknown>;
        } catch (error) {
          pushToast((error as Error).message || t('integrationsCredentials.credentialsModule.replacementCredentialDetailsAre'), 'danger');
          return;
        }
      }

      if (!credentials && !vaultId) {
        pushToast(t('integrationsCredentials.credentialsModule.replacementCredentialDetailsOr'), 'danger');
        return;
      }

      try {
        await rotateCreds.mutateAsync({
          config_id: row.id,
          auth_type: row.auth_type,
          ...(credentials ? { credentials } : {}),
          ...(vaultId ? { credentials_vault_id: vaultId } : {}),
          ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
          ...(reason ? { reason } : {}),
        });
        pushToast(fill(t('integrationsCredentials.credentialsModule.rotatedCredential'), { id: String(row.id) }), 'good');
        modal.close();
      } catch (err) {
        pushToast(fill(t('integrationsCredentials.credentialsModule.rotateFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
      }
    }

    modal.open({
      title: t('integrationsCredentials.credentialsModule.rotateCredential'),
      body: (
        <form id="provider-auth-config-rotate-form" data-testid="provider-auth-config-rotate-form" onSubmit={submit} className="form-grid">
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.replacementCredentialDetails')}</span>
            <textarea
              name="credentials"
              rows={6}
              placeholder={t('integrationsCredentials.credentialsModule.text3')}
            />
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.credentialVaultReference')}</span>
            <input name="credentials_vault_id" placeholder={t('integrationsCredentials.credentialsModule.vaultProviderCredentialVersion')} />
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.expiresAt')}</span>
            <input name="expires_at" type="datetime-local" defaultValue={toDatetimeLocal(row.expires_at)} />
          </label>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.rotationReason')}</span>
            <input name="reason" placeholder={t('integrationsCredentials.credentialsModule.scheduledRotation')} />
          </label>
        </form>
      ),
      footer: (
        <>
          <Button size="sm" kind="ghost" onClick={() => modal.close()}>{t('integrationsCredentials.credentialsModule.cancel')}</Button>
          <Button
            size="sm"
            kind="primary"
            disabled={rotateCreds.isPending}
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            ariaLabel={t('integrationsCredentials.credentialsModule.rotateCredential')}
            onClick={() => {
              const form = document.getElementById('provider-auth-config-rotate-form') as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          >
            {rotateCreds.isPending ? t('integrationsCredentials.credentialsModule.rotating') : t('integrationsCredentials.credentialsModule.rotateCredential')}
          </Button>
        </>
      ),
    });
  }

  function openCredentialRevoke(row: ProviderAuthConfig) {
    openCredentialRevokeDialog([row]);
  }

  function openCredentialRevokeDialog(rows: ProviderAuthConfig[]) {
    const revocableRows = rows.filter((row) => !isCredentialRevoked(row));
    if (!revocableRows.length) {
      pushToast(t('integrationsCredentials.credentialsModule.selectedCredentialsAreAlready'), 'warn');
      return;
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const reason = String(data.get('reason') ?? '').trim();
      if (!reason) {
        pushToast(t('integrationsCredentials.credentialsModule.revokeReasonIsRequired'), 'danger');
        return;
      }

      let ok = 0;
      for (const row of revocableRows) {
        try {
          await revokeCreds.mutateAsync({ config_id: row.id, reason });
          ok += 1;
        } catch {
          // Continue revoking the remaining selected credentials.
        }
      }
      pushToast(
        rows.length === 1
          ? ok === 1
            ? fill(t('integrationsCredentials.credentialsModule.revoked'), { id: String(rows[0]!.id) })
            : fill(t('integrationsCredentials.credentialsModule.revokeFailed'), { id: String(rows[0]!.id) })
          : fill(t('integrationsCredentials.credentialsModule.revokedCredentials'), { ok: String(ok), length: String(rows.length) }),
        ok === rows.length ? 'warn' : 'danger',
      );
      if (ok > 0) modal.close();
    }

    const title = rows.length === 1 ? 'Revoke credential' : `Revoke ${rows.length} credentials`;
    modal.open({
      title,
      body: (
        <form id="provider-auth-config-revoke-form" data-testid="provider-auth-config-revoke-form" onSubmit={submit} className="form-grid">
          <div className="state state--warn">
            <div className="state__title">{t('integrationsCredentials.credentialsModule.revocationDisablesLiveProvider')}</div>
            <div className="state__hint mono">
              {rows.length === 1 ? rows[0]!.id : fill(t('integrationsCredentials.credentialsModule.selectedCredentials'), { length: String(rows.length) })}
            </div>
          </div>
          <label className="field">
            <span className="field__label">{t('integrationsCredentials.credentialsModule.revokeReason')}</span>
            <input name="reason" placeholder={t('integrationsCredentials.credentialsModule.rotatedIntoAReplacement')} required />
          </label>
        </form>
      ),
      footer: (
        <>
          <Button size="sm" kind="ghost" onClick={() => modal.close()}>{t('integrationsCredentials.credentialsModule.cancel')}</Button>
          <Button
            size="sm"
            kind="danger"
            disabled={revokeCreds.isPending}
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            ariaLabel={t('integrationsCredentials.credentialsModule.revokeCredential')}
            onClick={() => {
              const form = document.getElementById('provider-auth-config-revoke-form') as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          >
            {revokeCreds.isPending ? t('integrationsCredentials.credentialsModule.revoking') : t('integrationsCredentials.credentialsModule.revokeCredential')}
          </Button>
        </>
      ),
    });
  }

  function openRotationHistory(row: ProviderAuthConfig) {
    const provider = providerById.get(row.provider_id);
    const providerName = row.provider_label ?? provider?.name ?? row.provider_id;
    const revoked = isCredentialRevoked(row);
    drawer.open({
      title: fill(t('integrationsCredentials.credentialsModule.rotationHistory'), { providerName: String(providerName) }),
      size: 'lg',
      body: (
        <div>
          <div className="kvgrid">
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsCredentials.credentialsModule.configId')}</span>
              <span className="kvgrid__val mono">{row.id}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsCredentials.credentialsModule.provider')}</span>
              <span className="kvgrid__val">{providerName}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsCredentials.credentialsModule.authType')}</span>
              <span className="kvgrid__val">
                {(() => {
                  // Cycle E P2 #18 closure (AGENTS.md §2 ZERO HARDCODING +
                  // §4 SSOT): auth-type chip tone resolves through canonical
                  // `provider_auth_type` lookup row (no inline 'info' literal).
                  // Missing canonical row fails loud as a danger chip.
                  const r = lookupRow('provider_auth_type', row.auth_type);
                  return r ? (
                    <Chip label={r.label ?? row.auth_type} kind={r.tone as ChipKind} size="xs" />
                  ) : (
                    <Chip label={fill(t('integrationsCredentials.credentialsModule.unknownAuthType'), { auth_type: String(row.auth_type) })} kind="danger" size="xs" />
                  );
                })()}
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsCredentials.credentialsModule.status')}</span>
              <span className="kvgrid__val">
                <CredStatusChip value={row.status} />
                <span className="chip chip--xs" style={{ marginInlineStart: '6px' }} title={t('integrationsCredentials.credentialsModule.calculatedFromCredentialExpiry')}>{t('integrationsCredentials.credentialsModule.calculated')}</span>
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsCredentials.credentialsModule.lastRotated')}</span>
              <span className="kvgrid__val mono">
                {row.last_rotated_at ? new Date(row.last_rotated_at).toLocaleString() : '—'}
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsCredentials.credentialsModule.expires')}</span>
              <span className="kvgrid__val mono">
                {row.expires_at ? new Date(row.expires_at).toLocaleString() : '—'}
              </span>
            </div>
          </div>
          <div className="section-eyebrow">
            {t('integrationsCredentials.credentialsModule.rotationHistory2')}
            <span className="chip chip--xs" style={{ marginInlineStart: '8px' }} title={t('integrationsCredentials.credentialsModule.summarizedFromAvailableCredential')}>{t('integrationsCredentials.credentialsModule.calculated')}</span>
          </div>
          <div className="timeline" style={{ padding: '0 14px 14px' }}>
            <div className="timeline__row">
              <span className="timeline__node" />
              <span className="timeline__time mono">{t('integrationsCredentials.credentialsModule.now')}</span>
              <div className="timeline__body">
                <div className="timeline__action">{revoked ? t('integrationsCredentials.credentialsModule.revoked2') : t('integrationsCredentials.credentialsModule.current')}</div>
                {revoked ? (
                  <div className="timeline__detail">{t('integrationsCredentials.credentialsModule.revokedCredentialProviderOperations')}</div>
                ) : (
                  <div className="timeline__detail">
                  {fill(t('integrationsCredentials.credentialsModule.activeCredentialExpires'), { value: String(row.expires_at ? new Date(row.expires_at).toLocaleDateString() : '—') })}
                  </div>
                )}
              </div>
            </div>
            <div className="timeline__row">
              <span className="timeline__node" />
              <span className="timeline__time mono">
                {row.last_rotated_at ? new Date(row.last_rotated_at).toLocaleDateString() : '—'}
              </span>
              <div className="timeline__body">
                <div className="timeline__action">{t('integrationsCredentials.credentialsModule.rotated')}</div>
                <div className="timeline__detail">
                  {t('integrationsCredentials.credentialsModule.lastRotationIsCalculated')}
                </div>
              </div>
            </div>
            <div className="timeline__row">
              <span className="timeline__node" />
              <span className="timeline__time mono">{t('integrationsCredentials.credentialsModule.created')}</span>
              <div className="timeline__body">
                <div className="timeline__action">{t('integrationsCredentials.credentialsModule.issued')}</div>
                <div className="timeline__detail">{t('integrationsCredentials.credentialsModule.initialCredentialIssuedAt')}</div>
              </div>
            </div>
          </div>
        </div>
      ),
    });
  }

  const COLUMNS: Array<DataTableColumn<ProviderAuthConfig>> = [
    { key: 'id', label: t('integrationsCredentials.credentialsModule.credential2'), mono: true, sortable: true },
    {
      key: 'provider_id',
      label: t('integrationsCredentials.credentialsModule.provider'),
      mono: true,
      sortable: true,
      filterable: true,
      reference: {
        items: providers,
        display: (p) => (p as Provider).name,
        value: (p) => (p as Provider).id,
        sub: (p) => (p as Provider).provider_type,
      },
      render: (raw, row) => {
        // W27 projection: prefer canonical provider_label when available,
        // fallback to provider's name from the local map.
        const projLabel = (row as { provider_label?: string | null }).provider_label;
        if (projLabel) return <span className="mono">{projLabel}</span>;
        const provider = providerById.get(String(raw));
        return <span className="mono">{provider?.name ?? String(raw)}</span>;
      },
    },
    {
      key: 'auth_type',
      label: t('integrationsCredentials.credentialsModule.authType'),
      sortable: true,
      filterable: true,
      // Cycle E P2 #18 closure: tone resolves through canonical
      // `provider_auth_type` lookup row (no inline 'info' literal).
      // Missing canonical row fails loud as a danger chip.
      render: (raw) => {
        const v = String(raw ?? '');
        const r = lookupRow('provider_auth_type', v);
        return r ? (
          <Chip label={r.label ?? v} kind={r.tone as ChipKind} size="xs" />
        ) : (
          <Chip label={fill(t('integrationsCredentials.credentialsModule.unknownAuthType2'), { v: String(v) })} kind="danger" size="xs" />
        );
      },
    },
    {
      key: 'status',
      label: t('integrationsCredentials.credentialsModule.status'),
      sortable: true,
      filterable: true,
      render: (raw) => {
        const v = String(raw ?? '');
        return <CredStatusChip value={v} />;
      },
    },
    // W27 projection-derived column. `days_until_expiry` populated from the
    // v_integration_credential_directory join; renders '—' when the canonical
    // expires_at is null.
    {
      key: 'days_until_expiry',
      label: t('integrationsCredentials.credentialsModule.daysLeft'),
      align: 'right',
      mono: true,
      sortable: true,
      type: 'number',
      render: (raw) => {
        if (raw == null) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        const n = Number(raw);
        if (!Number.isFinite(n)) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        // W26 Cycle B closure: thresholds resolve through canonical
        // `provider_credential_policy` (no inline `30` / `0` literals).
        // `n < 0` is the past-expiry boundary (always danger);
        // `n <= dangerDaysThreshold` is the imminent-expiry escalation;
        // `n <= expiringDaysThreshold` is the warn window. Falls through
        // to `good` outside those windows.
        const tone: ChipKind =
          n < 0
            ? 'danger'
            : n <= dangerDaysThreshold
              ? 'danger'
              : n <= expiringDaysThreshold
                ? 'warn'
                : 'good';
        return <Chip label={String(n)} kind={tone} size="xs" />;
      },
    },
    { key: 'last_rotated_at', label: t('integrationsCredentials.credentialsModule.lastRotated'), format: 'datetime', sortable: true },
    { key: 'expires_at', label: t('integrationsCredentials.credentialsModule.expires'), format: 'datetime', sortable: true },
  ];

  const ROW_ACTIONS: Array<DataTableAction<ProviderAuthConfig>> = [
    {
      label: t('integrationsCredentials.credentialsModule.editCredential'),
      icon: 'edit',
      capability: CAP.INTEGRATION_PLUGINS_WRITE,
      hidden: isCredentialRevoked,
      onClick: (row) => openCredentialEditor(row),
    },
    {
      label: t('integrationsCredentials.credentialsModule.rotate'),
      icon: 'refresh',
      kind: 'primary',
      capability: CAP.INTEGRATION_PLUGINS_WRITE,
      hidden: isCredentialRevoked,
      onClick: (row) => openCredentialRotation(row),
    },
    {
      label: t('integrationsCredentials.credentialsModule.viewRotationHistory'),
      icon: 'history',
      onClick: (row) => openRotationHistory(row),
    },
    {
      label: t('integrationsCredentials.credentialsModule.revoke'),
      icon: 'lock',
      kind: 'danger',
      capability: CAP.INTEGRATION_PLUGINS_WRITE,
      hidden: isCredentialRevoked,
      onClick: (row) => openCredentialRevoke(row),
    },
  ];

  const BULK_ACTIONS: Array<DataTableBulkAction<ProviderAuthConfig>> = [
    {
      label: t('integrationsCredentials.credentialsModule.revokeSelected'),
      icon: 'lock',
      kind: 'danger',
      capability: CAP.INTEGRATION_PLUGINS_WRITE,
      onClick: (rs) => openCredentialRevokeDialog(rs),
    },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-credentials"
          eyebrow={t('integrationsCredentials.credentialsModule.externalIntake')}
          titleAccent={t('integrationsCredentials.credentialsModule.titleAccent')}
          titlePlain={t('integrationsCredentials.credentialsModule.titlePlain')}
          pills={[
            <span key="src" className="chip chip--xs mono">{t('integrationsCredentials.credentialsModule.providerCredentialVault')}</span>,
            <span key="dir" className="chip chip--xs mono">{t('integrationsCredentials.credentialsModule.credentialHealthDirectory')}</span>,
          ]}
        />
        <StateView
          kind="denied"
          capability={CAP.PROVIDER_AUTH_READ}
          hint={t('integrationsCredentials.credentialsModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (credDirectoryQuery.isLoading || providersQuery.isLoading || apiRoutesQuery.isLoading || providerAccountQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-credentials"
          eyebrow={t('integrationsCredentials.credentialsModule.externalIntake')}
          titleAccent={t('integrationsCredentials.credentialsModule.titleAccent')}
          titlePlain={t('integrationsCredentials.credentialsModule.titlePlain')}
          pills={[
            <span key="src" className="chip chip--xs mono">{t('integrationsCredentials.credentialsModule.providerCredentialVault')}</span>,
            <span key="dir" className="chip chip--xs mono">{t('integrationsCredentials.credentialsModule.credentialHealthDirectory')}</span>,
          ]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (credDirectoryQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-credentials"
          eyebrow={t('integrationsCredentials.credentialsModule.externalIntake')}
          titleAccent={t('integrationsCredentials.credentialsModule.titleAccent')}
          titlePlain={t('integrationsCredentials.credentialsModule.titlePlain')}
          pills={[]}
        />
        <StateView kind="error" hint={String(credDirectoryQuery.error)} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="int-credentials"
        eyebrow={t('integrationsCredentials.credentialsModule.externalIntake')}
        titleAccent={t('integrationsCredentials.credentialsModule.titleAccent')}
        titlePlain={t('integrationsCredentials.credentialsModule.titlePlain')}
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="src" className="chip chip--xs mono">{t('integrationsCredentials.credentialsModule.providerCredentialVault')}</span>,
          <span key="dir" className="chip chip--xs mono">{t('integrationsCredentials.credentialsModule.credentialHealthDirectory')}</span>,
        ]}
        actions={[
          <Button
            key="bind-delivery-api"
            size="sm"
            kind={providerAccountBound ? 'ghost' : 'primary'}
            iconName="key"
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            disabled={bindProviderAccount.isPending || Boolean(providerAccountRouteBlockedReason)}
            title={providerAccountRouteBlockedReason}
            onClick={openDeliveryApiAccountBinding}
          >
            {providerAccountBound ? t('integrationsCredentials.credentialsModule.updateDeliveryApiAccount') : t('integrationsCredentials.credentialsModule.setDeliveryApiAccount')}
          </Button>,
          <Button
            key="new"
            size="sm"
            kind="primary"
            iconName="plus"
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            disabled={providerSetupBlocked || authTypes.length === 0}
            title={createDisabledReason}
            onClick={() => openCredentialEditor()}
          >
            {t('integrationsCredentials.credentialsModule.newCredential')}
          </Button>,
        ]}
      />
      <ExternalIntakeWorkspaceToolbar activePath="/integrations/credentials" />
      <div
        data-testid="delivery-api-account-status"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: '12px 14px',
          marginBottom: 14,
          background: 'var(--paper)',
        }}
      >
        <div>
          <div className="section-eyebrow" style={{ padding: 0 }}>{t('integrationsCredentials.credentialsModule.apiShipmentIntakeAccount')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <Chip
              label={providerAccountBound ? t('integrationsCredentials.credentialsModule.credentialBound') : t('integrationsCredentials.credentialsModule.credentialMissing')}
              kind={providerAccountBound ? 'good' : 'warn'}
              size="xs"
            />
            <span className="chip chip--xs mono">
              {selectedProviderAccountRoute
                ? `${selectedProviderAccountRoute.method} ${selectedProviderAccountRoute.path}`
                : t('integrationsCredentials.credentialsModule.apiRoutePolicyMissing')}
            </span>
            {providerAccountSettingsCategory ? (
              <span className="chip chip--xs mono">{providerAccountSettingsCategory}</span>
            ) : null}
            {providerAccountCompanyId ? (
              <span className="chip chip--xs">{t('integrationsCredentials.credentialsModule.companyAccountLinked')}</span>
            ) : null}
            {providerAccountCredential?.provider_label ? (
              <span className="chip chip--xs mono">{providerAccountCredential.provider_label}</span>
            ) : null}
            {providerAccountCredential?.status ? (
              <CredStatusChip value={providerAccountCredential.status} />
            ) : providerAccountBound ? (
              <Chip label={t('integrationsCredentials.credentialsModule.credentialConfirmationPending')} kind="warn" size="xs" />
            ) : null}
            {providerAccountBound ? (
              <span className="chip chip--xs">{t('integrationsCredentials.credentialsModule.credentialSelected')}</span>
            ) : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button
            size="sm"
            kind={providerAccountBound ? 'ghost' : 'primary'}
            iconName="key"
            capability={CAP.INTEGRATION_PLUGINS_WRITE}
            disabled={bindProviderAccount.isPending || Boolean(providerAccountRouteBlockedReason)}
            title={providerAccountRouteBlockedReason}
            onClick={openDeliveryApiAccountBinding}
          >
            {providerAccountBound ? t('integrationsCredentials.credentialsModule.updateAccount') : t('integrationsCredentials.credentialsModule.setAccount')}
          </Button>
          {providerAccountBound ? (
            <Button
              size="sm"
              kind="danger"
              iconName="lock"
              capability={CAP.INTEGRATION_PLUGINS_WRITE}
              disabled={unbindProviderAccount.isPending || Boolean(providerAccountRouteBlockedReason)}
              title={providerAccountRouteBlockedReason}
              onClick={openDeliveryApiAccountUnbind}
            >
              {t('integrationsCredentials.credentialsModule.unbindAccount')}
            </Button>
          ) : null}
        </div>
      </div>
      {providerSetupBlocked ? (
        <StateView
          kind="empty"
          title={t('integrationsCredentials.credentialsModule.providerCatalogNeedsOnboarding')}
          hint={t('integrationsCredentials.credentialsModule.credentialsAreAttachedTo')}
          action={(
            <Button
              size="sm"
              kind="primary"
              iconName="check"
              onClick={navigateToReadiness}
            >
              {t('integrationsCredentials.credentialsModule.openSetup')}
            </Button>
          )}
        />
      ) : null}
      <DataTable<ProviderAuthConfig>
        columns={COLUMNS}
        rows={credentials}
        viewKey="provider_auth_configs"
        entityKind="provider_auth_config"
        rowActions={ROW_ACTIONS}
        bulkActions={BULK_ACTIONS}
        // W70 (Cycle F-R-10 P2-4 closure — AGENTS.md §2 ZERO HARDCODING + §6
        // row-driven by configuration): risk escalation resolves through the
        // canonical `provider_auth_status` lookup `metadata.is_risk` boolean
        // (no inline `r.status === 'expiring' || r.status === 'expired'`
        // literal compare). The taxonomy of risk states lives in
        // lib/seed-raw/lookups.js; adding a new escalation status (e.g.
        // `compromised`) only requires a seed row update, not code change.
        getRowClass={(r) =>
          lookupRow('provider_auth_status', r.status)?.metadata?.is_risk === true
            ? 'is-risk'
            : undefined
        }
        onRowClick={openRotationHistory}
      />
      {drawer.node}
      {modal.node}
    </div>
  );
}

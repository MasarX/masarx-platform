import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { pushToast } from '@/components/toastStore';
import { useModal } from '@/hooks/useOverlay';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useOnboardingReadiness, useResourceList } from '@/lib/queries';
import { readUrlParam } from '@/lib/url-params';
import * as api from '@/lib/api';
import type {
  OnboardingReadinessComponent,
  OnboardingReadinessFinding,
  OnboardingReadinessPluginItem,
  UiOnboardingReadiness,
} from '@/types/domain';
import { fill, useI18n, type Translate } from '@/lib/i18n';

type ReadinessScopeType = UiOnboardingReadiness['scope_type'];

interface ScopeTypeRegistryRow extends Record<string, unknown> {
  scope_type: string;
  ladder_rank: number;
  is_enabled?: boolean;
}

interface ScopeReferenceRow extends Record<string, unknown> {
  id?: string | null;
  name?: string | null;
  display_name?: string | null;
  label?: string | null;
}

function scopeTypeLabel(scopeType: string): string {
  return scopeType
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function scopeName(scopeType: string, t: Translate): string {
  return t(`scope.${scopeType}`, scopeTypeLabel(scopeType));
}

function fallbackScopeReferenceLabel(scopeType: string, t: Translate): string {
  return fill(t('platformOnboardingReadiness.helpers.scopeOf'), { scope: scopeName(scopeType, t) });
}

function urlScopeOverride(): { type: ReadinessScopeType; id: string | null } | null {
  const requestedType = readUrlParam('scope_type')?.toLowerCase().trim();
  if (!requestedType) return null;
  if (requestedType === 'global') return { type: requestedType, id: null };

  const requestedId = readUrlParam('scope_id');
  if (!requestedId) return null;
  return {
    type: requestedType,
    id: requestedId,
  };
}

function readinessLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .trim()
    .replace(/^plg[_-]/i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function readinessMessage(value: unknown, t: Translate): string {
  if (typeof value !== 'string' || !value.trim()) return t('platformOnboardingReadiness.helpers.noReadinessMessage');
  return value
    .trim()
    .replace(/\b(tenant|client|sender)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (_match, scope: string) => t(`platformOnboardingReadiness.helpers.inlineScope.${scope.toLowerCase()}`))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, t('platformOnboardingReadiness.helpers.selectedScope'))
    .replace(/\b[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+\b/gi, (token) => readinessLabel(token, token));
}

function queryErrorHint(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function chipKindForStatus(status?: string | null): ChipKind {
  if (status === 'healthy' || status === 'ready' || status === 'active' || status === 'approved') return 'good';
  if (status === 'pending_credentials' || status === 'warning' || status === 'pending' || status === 'degraded') return 'warn';
  if (status === 'blocked' || status === 'disabled' || status === 'rollback') return 'danger';
  return 'neutral';
}

function countLabel(component: OnboardingReadinessComponent): string {
  const present = component.present_count ?? component.healthy_count ?? 0;
  const required = component.required_count ?? present;
  return `${present}/${required}`;
}

function asResultRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function asSkippedRows(value: unknown): Array<{ category: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const rec = asResultRecord(entry);
      if (!rec) return null;
      const category = typeof rec.category === 'string' ? rec.category.trim() : '';
      const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
      if (!category) return null;
      return { category, reason };
    })
    .filter((entry): entry is { category: string; reason: string } => entry !== null);
}

interface BootstrapResultEvidence {
  ok: boolean;
  enabled: boolean;
  reason: string | null;
  scopeType: string;
  scopeId: string;
  scopeDefaults: { seeded: string[] };
  globalDefaults: { seeded: string[]; skipped: Array<{ category: string; reason: string }> };
  rbacTemplates: string[];
  readiness: UiOnboardingReadiness | null;
  generatedAt: string;
  raw: Record<string, unknown>;
}

function summarizeBootstrapResult(
  payload: Record<string, unknown>,
  fallbackScopeType: string,
  fallbackScopeId: string,
): BootstrapResultEvidence {
  const result = asResultRecord(payload.result) ?? payload;
  const scopeDefaults = asResultRecord(result.scope_defaults);
  const globalDefaults = asResultRecord(result.global_defaults);
  const readinessRaw = asResultRecord(payload.readiness);
  const readiness = readinessRaw as UiOnboardingReadiness | null;
  return {
    ok: payload.ok !== false,
    enabled: result.enabled !== false,
    reason: typeof result.reason === 'string' && result.reason.trim() ? result.reason.trim() : null,
    scopeType: typeof payload.scope_type === 'string' && payload.scope_type.trim() ? payload.scope_type : fallbackScopeType,
    scopeId: typeof payload.scope_id === 'string' && payload.scope_id.trim() ? payload.scope_id : fallbackScopeId,
    scopeDefaults: { seeded: asStringArray(scopeDefaults?.seeded_categories) },
    globalDefaults: {
      seeded: asStringArray(globalDefaults?.seeded_categories),
      skipped: asSkippedRows(globalDefaults?.skipped_categories),
    },
    rbacTemplates: asStringArray(result.rbac_templates_provisioned),
    readiness,
    generatedAt: new Date().toISOString(),
    raw: payload,
  };
}

function BootstrapEvidencePanel({
  evidence,
  scopeLabel,
}: {
  evidence: BootstrapResultEvidence;
  scopeLabel: string;
}) {
  const { t } = useI18n();
  const seededCount = evidence.scopeDefaults.seeded.length;
  const globalSeededCount = evidence.globalDefaults.seeded.length;
  const globalSkippedCount = evidence.globalDefaults.skipped.length;
  const templatesCount = evidence.rbacTemplates.length;
  const readiness = evidence.readiness;
  return (
    <div data-testid="onboarding-bootstrap-result" style={{ display: 'grid', gap: 14 }}>
      <div className="kvgrid">
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.status')}</span>
          <span className="kvgrid__val">
            <Chip
              label={evidence.ok ? (evidence.enabled ? t('platformOnboardingReadiness.bootstrapEvidencePanel.bootstrapCompleted') : t('platformOnboardingReadiness.bootstrapEvidencePanel.bootstrapSkippedByPolicy')) : t('platformOnboardingReadiness.bootstrapEvidencePanel.bootstrapFailed')}
              kind={evidence.ok ? (evidence.enabled ? 'good' : 'warn') : 'danger'}
            />
          </span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.scope')}</span>
          <span className="kvgrid__val">{scopeLabel}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.scopeId')}</span>
          <span className="kvgrid__val mono">{evidence.scopeId || '—'}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.scopeDefaultsSeeded')}</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-scope-defaults-count">{seededCount}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.globalDefaultsSeeded')}</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-global-defaults-count">{globalSeededCount}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.globalDefaultsSkipped')}</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-global-defaults-skipped">{globalSkippedCount}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.rbacTemplatesProvisioned')}</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-rbac-templates-count">{templatesCount}</span>
        </div>
        {readiness ? (
          <div className="kvgrid__row">
            <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.readinessAfterBootstrap')}</span>
            <span className="kvgrid__val">{readinessLabel(readiness.overall_status, t('platformOnboardingReadiness.helpers.unknown'))}</span>
          </div>
        ) : null}
        {evidence.reason ? (
          <div className="kvgrid__row">
            <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.skipReason')}</span>
            <span className="kvgrid__val">{readinessLabel(evidence.reason, evidence.reason)}</span>
          </div>
        ) : null}
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.bootstrapEvidencePanel.recordedAt')}</span>
          <span className="kvgrid__val mono">{evidence.generatedAt}</span>
        </div>
      </div>
      {seededCount > 0 ? (
        <div>
          <div className="wf-insp__section-eyebrow">{t('platformOnboardingReadiness.bootstrapEvidencePanel.scopeDefaultsApplied')}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {evidence.scopeDefaults.seeded.map((category) => (
              <li key={category}>{category}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {templatesCount > 0 ? (
        <div>
          <div className="wf-insp__section-eyebrow">{t('platformOnboardingReadiness.bootstrapEvidencePanel.rbacTemplatesProvisioned')}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {evidence.rbacTemplates.map((template) => (
              <li key={template}>{template}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {globalSkippedCount > 0 ? (
        <div>
          <div className="wf-insp__section-eyebrow">{t('platformOnboardingReadiness.bootstrapEvidencePanel.globalDefaultsSkipped')}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {evidence.globalDefaults.skipped.map((entry) => (
              <li key={entry.category}>
                {entry.category}: {entry.reason || t('platformOnboardingReadiness.helpers.skippedWithoutReason')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <div className="wf-insp__section-eyebrow">{t('platformOnboardingReadiness.bootstrapEvidencePanel.backendResponse')}</div>
        <pre className="wf-code-block">
{JSON.stringify(evidence.raw, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function ReadinessCard({
  title,
  component,
}: {
  title: string;
  component: OnboardingReadinessComponent;
}) {
  const { t } = useI18n();
  return (
    <div className="card" style={{ padding: 14, minHeight: 118 }}>
      <div className="section-eyebrow" style={{ padding: 0, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Chip label={readinessLabel(component.status, t('platformOnboardingReadiness.helpers.unknown'))} kind={chipKindForStatus(component.status)} />
        <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{countLabel(component)}</span>
      </div>
      <div className="kvgrid" style={{ marginTop: 12 }}>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.readinessCard.blocking')}</span>
          <span className="kvgrid__val mono">{component.blocking_count ?? 0}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">{t('platformOnboardingReadiness.readinessCard.warning')}</span>
          <span className="kvgrid__val mono">{component.warning_count ?? 0}</span>
        </div>
      </div>
    </div>
  );
}

export function OnboardingReadinessModule() {
  const { t } = useI18n();
  const canReadSettings = useCapability(CAP.SETTINGS_READ);
  const canWriteSettings = useCapability(CAP.SETTINGS_WRITE);
  const canWriteSystem = useCapability(CAP.SYSTEM_WRITE);
  const identity = useIdentity();
  const modal = useModal();
  const initialScope = useMemo(() => {
    const requestedScope = urlScopeOverride();
    if (requestedScope) return requestedScope;

    const user = identity.user;
    if ((user.access_scope_type === 'client' || user.access_scope_type === 'sender') && user.access_scope_id) {
      return {
        type: user.access_scope_type as ReadinessScopeType,
        id: user.access_scope_id,
      };
    }
    if (user.organization_id) return { type: 'tenant' as const, id: user.organization_id };
    return { type: 'global' as const, id: null };
  }, [identity.user]);
  const [scopeType, setScopeType] = useState<ReadinessScopeType>(initialScope.type);
  const [scopeId, setScopeId] = useState<string>(initialScope.id ?? '');
  const scopeRegistryQuery = useResourceList<ScopeTypeRegistryRow>('scope_type_registry', undefined, {
    enabled: canReadSettings,
  });
  const tenantReferenceQuery = useResourceList<ScopeReferenceRow>(
    'organizations',
    undefined,
    { enabled: canReadSettings && scopeType === 'tenant' },
  );
  const scopeOptions = useMemo<Array<{ value: ReadinessScopeType; label: string }>>(() => {
    const rows = scopeRegistryQuery.data?.rows ?? [];
    return rows
      .filter((row) => row.is_enabled !== false)
      .slice()
      .sort((a, b) => a.ladder_rank - b.ladder_rank)
      .map((row) => ({
        value: row.scope_type,
        label: scopeName(row.scope_type, t),
      }));
  }, [scopeRegistryQuery.data, t]);
  const tenantReferenceLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of tenantReferenceQuery.data?.rows ?? []) {
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      if (!id) continue;
      const label = [row.display_name, row.name, row.label]
        .find((value) => typeof value === 'string' && value.trim());
      if (typeof label === 'string') map.set(id, label.trim());
    }
    return map;
  }, [tenantReferenceQuery.data]);
  const scopeReferenceOptions = useMemo<Array<{ value: string; label: string }>>(() => {
    if (scopeType === 'global') return [];

    const rows: Array<{ value: string; label: string }> = [];
    const scopedEntry = identity.scope?.[scopeType as keyof typeof identity.scope];
    const scopedId = typeof scopedEntry?.id === 'string' ? scopedEntry.id : null;
    const scopedLabel = typeof scopedEntry?.label === 'string' ? scopedEntry.label.trim() : '';
    const add = (value: string | null | undefined, label: string | null | undefined) => {
      const cleanValue = typeof value === 'string' ? value.trim() : '';
      if (!cleanValue || rows.some((row) => row.value === cleanValue)) return;
      const cleanLabel = typeof label === 'string' ? label.trim() : '';
      rows.push({
        value: cleanValue,
        label: cleanLabel || fallbackScopeReferenceLabel(scopeType, t),
      });
    };

    add(scopedId, scopedLabel);
    if (scopeType === 'tenant') {
      add(identity.user.organization_id, scopedLabel || t('platformOnboardingReadiness.helpers.currentTenant'));
    } else {
      add(identity.user.access_scope_type === scopeType ? identity.user.access_scope_id : null, scopedLabel);
    }
    if (scopeId.trim()) {
      add(
        scopeId,
        scopeType === 'tenant'
          ? tenantReferenceLabelById.get(scopeId.trim()) ?? fallbackScopeReferenceLabel(scopeType, t)
          : fallbackScopeReferenceLabel(scopeType, t),
      );
    }

    return rows;
  }, [identity.scope, identity.user.access_scope_id, identity.user.access_scope_type, identity.user.organization_id, scopeId, scopeType, t, tenantReferenceLabelById]);
  const effectiveScopeId = scopeType === 'global' ? null : scopeId.trim();
  const hasScope = scopeType === 'global' || Boolean(effectiveScopeId);
  const scopeRegistryReady = scopeRegistryQuery.isSuccess;
  const tenantReferenceReady = scopeType !== 'tenant' || tenantReferenceQuery.isSuccess;
  const canRunReadinessCheck =
    canReadSettings &&
    hasScope &&
    scopeRegistryReady &&
    scopeOptions.length > 0 &&
    tenantReferenceReady;
  const readiness = useOnboardingReadiness(scopeType, effectiveScopeId, canRunReadinessCheck);
  const scopeReferenceLabelById = useMemo(() => {
    const map = new Map<string, string>(tenantReferenceLabelById);
    for (const option of scopeReferenceOptions) {
      if (!map.has(option.value) && option.label) map.set(option.value, option.label);
    }
    return map;
  }, [scopeReferenceOptions, tenantReferenceLabelById]);
  const resolvedScopeLabel = useMemo(() => {
    if (scopeType === 'global') return t('platformOnboardingReadiness.onboardingReadinessModule.globalReadiness');
    const id = effectiveScopeId ?? '';
    return scopeReferenceLabelById.get(id) || fallbackScopeReferenceLabel(scopeType, t);
  }, [effectiveScopeId, scopeReferenceLabelById, scopeType, t]);
  const bootstrapMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveScopeId) throw new Error(t('platformOnboardingReadiness.helpers.selectScopeBeforeBootstrap'));
      return api.ui_execute_onboarding_bootstrap_v1({
        scope_type: scopeType,
        scope_id: effectiveScopeId,
      });
    },
    onSuccess: (payload) => {
      const evidence = summarizeBootstrapResult(
        payload as Record<string, unknown>,
        scopeType,
        effectiveScopeId ?? '',
      );
      const scopeLabel = scopeReferenceLabelById.get(evidence.scopeId) || resolvedScopeLabel;
      const tone = evidence.ok ? (evidence.enabled ? 'good' : 'info') : 'danger';
      const message = evidence.ok
        ? evidence.enabled
          ? fill(t('platformOnboardingReadiness.helpers.bootstrapCompleted'), { scopeLabel })
          : fill(t('platformOnboardingReadiness.helpers.bootstrapSkipped'), { scopeLabel })
        : fill(t('platformOnboardingReadiness.helpers.bootstrapFailed'), { scopeLabel });
      pushToast(message, tone);
      void readiness.refetch();
      modal.open({
        title: fill(t('platformOnboardingReadiness.onboardingReadinessModule.onboardingBootstrapResult'), { scopeLabel: String(scopeLabel) }),
        body: <BootstrapEvidencePanel evidence={evidence} scopeLabel={scopeLabel} />,
        footer: (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button label={t('platformOnboardingReadiness.onboardingReadinessModule.close')} kind="primary" onClick={() => modal.close()} />
          </div>
        ),
      });
    },
    onError: (error: Error) => {
      pushToast(fill(t('platformOnboardingReadiness.onboardingReadinessModule.onboardingBootstrapFailed'), { message: String(error.message) }), 'danger');
    },
  });
  const canRunBootstrap = (canWriteSettings || canWriteSystem) && scopeType !== 'global' && Boolean(effectiveScopeId);

  const findingColumns = useMemo<Array<DataTableColumn<OnboardingReadinessFinding>>>(() => [
    { key: 'severity', label: t('platformOnboardingReadiness.onboardingReadinessModule.severity'), type: 'text', render: (raw) => readinessLabel(raw, t('platformOnboardingReadiness.onboardingReadinessModule.severity')) },
    { key: 'component', label: t('platformOnboardingReadiness.onboardingReadinessModule.area'), type: 'text', render: (raw) => readinessLabel(raw, t('platformOnboardingReadiness.helpers.readinessItem')) },
    { key: 'code', label: t('platformOnboardingReadiness.onboardingReadinessModule.finding'), type: 'text', render: (raw) => readinessLabel(raw, t('platformOnboardingReadiness.helpers.readinessItem')) },
    { key: 'message', label: t('platformOnboardingReadiness.onboardingReadinessModule.message'), type: 'text', render: (raw) => readinessMessage(raw, t) },
    { key: 'action', label: t('platformOnboardingReadiness.onboardingReadinessModule.action'), type: 'text', render: (raw) => readinessMessage(raw, t) },
  ], [t]);

  const pluginColumns = useMemo<Array<DataTableColumn<OnboardingReadinessPluginItem>>>(() => [
    { key: 'plugin_key', label: t('platformOnboardingReadiness.onboardingReadinessModule.integration'), type: 'text', render: (raw) => readinessLabel(raw, t('platformOnboardingReadiness.helpers.readinessItem')) },
    { key: 'status', label: t('platformOnboardingReadiness.onboardingReadinessModule.status'), type: 'text', render: (raw) => readinessLabel(raw, t('platformOnboardingReadiness.helpers.unknown')) },
    { key: 'credentials_status', label: t('platformOnboardingReadiness.onboardingReadinessModule.credentials'), type: 'text', render: (raw) => readinessLabel(raw, t('platformOnboardingReadiness.helpers.notRequired')) },
    { key: 'enabled', label: t('platformOnboardingReadiness.onboardingReadinessModule.enabled'), type: 'boolean' },
    { key: 'blocking', label: t('platformOnboardingReadiness.onboardingReadinessModule.blocking'), type: 'boolean' },
  ], [t]);

  const data = readiness.data;
  const pluginItems = data?.integration_plugins.items ?? [];

  if (!canReadSettings) {
    return (
      <div className="page">
        <PageHeader eyebrow={t('platformOnboardingReadiness.onboardingReadinessModule.platform')} titleAccent={t('platformOnboardingReadiness.onboardingReadinessModule.titleAccent')} titlePlain={t('platformOnboardingReadiness.onboardingReadinessModule.titlePlain')} />
        <StateView kind="denied" capability={CAP.SETTINGS_READ} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('platformOnboardingReadiness.onboardingReadinessModule.platform')}
        titleAccent={t('platformOnboardingReadiness.onboardingReadinessModule.titleAccent')}
        titlePlain={t('platformOnboardingReadiness.onboardingReadinessModule.titlePlain')}
        pills={[
          <span key="readiness" className="chip chip--xs">{t('platformOnboardingReadiness.onboardingReadinessModule.readinessChecks')}</span>,
          <span key="settings" className="chip chip--xs mono">{t('platformOnboardingReadiness.onboardingReadinessModule.settingsDefaults')}</span>,
          <span key="workflows" className="chip chip--xs mono">{t('platformOnboardingReadiness.onboardingReadinessModule.workflowBindings')}</span>,
          <span key="plugins" className="chip chip--xs mono">{t('platformOnboardingReadiness.onboardingReadinessModule.integrationPlugins')}</span>,
          <span key="labels" className="chip chip--xs mono">{t('platformOnboardingReadiness.onboardingReadinessModule.labelDesign')}</span>,
        ]}
        actions={[
          <Button
            key="bootstrap"
            size="sm"
            kind="primary"
            anyCapabilities={[CAP.SETTINGS_WRITE, CAP.SYSTEM_WRITE]}
            onClick={() => bootstrapMutation.mutate()}
            disabled={!canRunBootstrap || bootstrapMutation.isPending}
          >
            {bootstrapMutation.isPending ? t('platformOnboardingReadiness.onboardingReadinessModule.running') : t('platformOnboardingReadiness.onboardingReadinessModule.runBootstrap')}
          </Button>,
          <Button key="refresh" size="sm" kind="ghost" onClick={() => readiness.refetch()} disabled={!hasScope}>
            {t('platformOnboardingReadiness.onboardingReadinessModule.refresh')}
          </Button>,
        ]}
      />

      <div className="dt-toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 180 }}>
          <span className="field__label">{t('platformOnboardingReadiness.onboardingReadinessModule.scopeType')}</span>
          <select
            value={scopeType}
            onChange={(event) => {
              const next = event.target.value as ReadinessScopeType;
              setScopeType(next);
              if (next === 'global') setScopeId('');
              else if (!scopeId.trim() && initialScope.id) setScopeId(initialScope.id);
            }}
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ minWidth: 320, flex: '1 1 320px' }}>
          <span className="field__label">{t('platformOnboardingReadiness.onboardingReadinessModule.scopeReference')}</span>
          {scopeType === 'global' ? (
            <input value="" disabled placeholder={t('platformOnboardingReadiness.onboardingReadinessModule.globalReadiness')} />
          ) : scopeReferenceOptions.length > 0 ? (
            <select
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
              aria-label={t('platformOnboardingReadiness.onboardingReadinessModule.scopeReference')}
            >
              {scopeReferenceOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : (
            <input
              value=""
              disabled
              placeholder={t('platformOnboardingReadiness.onboardingReadinessModule.noSelectableScopeAvailable')}
            />
          )}
        </label>
        {data ? (
          <Chip
            label={readinessLabel(data.overall_status, t('platformOnboardingReadiness.helpers.unknownReadiness'))}
            kind={chipKindForStatus(data.overall_status)}
            data-testid="onboarding-readiness-status"
          />
        ) : null}
      </div>

      {scopeRegistryQuery.isLoading ? (
        <StateView kind="loading" title={t('platformOnboardingReadiness.onboardingReadinessModule.loadingReadinessScopeRegistry')} />
      ) : scopeRegistryQuery.isError ? (
        <StateView
          kind="error"
          title={t('platformOnboardingReadiness.onboardingReadinessModule.readinessScopeRegistryFailed')}
          hint={queryErrorHint(scopeRegistryQuery.error, t('platformOnboardingReadiness.helpers.scopeRegistryLoadFailed'))}
        />
      ) : scopeOptions.length === 0 ? (
        <StateView
          kind="error"
          title={t('platformOnboardingReadiness.onboardingReadinessModule.readinessScopeRegistryEmpty')}
          hint={t('platformOnboardingReadiness.onboardingReadinessModule.configureEnabledScopeType')}
        />
      ) : scopeType === 'tenant' && tenantReferenceQuery.isLoading ? (
        <StateView kind="loading" title={t('platformOnboardingReadiness.onboardingReadinessModule.loadingTenantScopeReference')} />
      ) : scopeType === 'tenant' && tenantReferenceQuery.isError ? (
        <StateView
          kind="error"
          title={t('platformOnboardingReadiness.onboardingReadinessModule.tenantScopeReferenceFailed')}
          hint={queryErrorHint(tenantReferenceQuery.error, t('platformOnboardingReadiness.helpers.tenantReferenceLoadFailed'))}
        />
      ) : !hasScope ? (
        <StateView
          kind="empty"
          title={t('platformOnboardingReadiness.onboardingReadinessModule.selectAScope')}
          hint={t('platformOnboardingReadiness.onboardingReadinessModule.chooseTheTenantClient')}
        />
      ) : readiness.isLoading ? (
        <StateView kind="loading" title={t('platformOnboardingReadiness.onboardingReadinessModule.checkingOnboardingReadiness')} />
      ) : readiness.isError ? (
        <StateView
          kind="error"
          title={t('platformOnboardingReadiness.onboardingReadinessModule.readinessCheckFailed')}
          hint={readiness.error instanceof Error ? readiness.error.message : t('platformOnboardingReadiness.onboardingReadinessModule.readinessChecksCouldNot')}
        />
      ) : data ? (
        <>
          <div className="status-grid">
            <ReadinessCard title={t('platformOnboardingReadiness.onboardingReadinessModule.settingsDefaults2')} component={data.settings_defaults} />
            <ReadinessCard title={t('platformOnboardingReadiness.onboardingReadinessModule.workflowBindings2')} component={data.workflow_bindings} />
            <ReadinessCard title={t('platformOnboardingReadiness.onboardingReadinessModule.integrationPlugins2')} component={data.integration_plugins} />
            {data.label_design ? (
              <ReadinessCard title={t('platformOnboardingReadiness.onboardingReadinessModule.labelDesign2')} component={data.label_design} />
            ) : null}
          </div>

          <div className="section-eyebrow">{t('platformOnboardingReadiness.onboardingReadinessModule.blockingFindings')}</div>
          <DataTable
            viewKey="platform.onboarding-readiness.findings"
            columns={findingColumns}
            rows={data.blocking_findings}
            emptyText={t('platformOnboardingReadiness.onboardingReadinessModule.noBlockingOnboardingFindings')}
            searchKeys={['component', 'code', 'message', 'action']}
          />

          <div className="section-eyebrow">{t('platformOnboardingReadiness.onboardingReadinessModule.integrationPluginReadiness')}</div>
          <DataTable
            viewKey="platform.onboarding-readiness.plugins"
            columns={pluginColumns}
            rows={pluginItems}
            emptyText={t('platformOnboardingReadiness.onboardingReadinessModule.noPluginReadinessRows')}
            searchKeys={['plugin_key', 'status', 'credentials_status']}
          />
        </>
      ) : null}
      {modal.node}
    </div>
  );
}

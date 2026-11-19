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

function fallbackScopeReferenceLabel(scopeType: string): string {
  return `${scopeTypeLabel(scopeType)} scope`;
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

function readinessLabel(value: unknown, fallback = 'Readiness item'): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .trim()
    .replace(/^plg[_-]/i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function readinessMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'No readiness message provided.';
  return value
    .trim()
    .replace(/\b(tenant|client|sender)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (_match, scope) => `${scope} scope`)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'selected scope')
    .replace(/\b[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+\b/gi, (token) => readinessLabel(token));
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
      return { category, reason: reason || 'Skipped without reason' };
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
  const seededCount = evidence.scopeDefaults.seeded.length;
  const globalSeededCount = evidence.globalDefaults.seeded.length;
  const globalSkippedCount = evidence.globalDefaults.skipped.length;
  const templatesCount = evidence.rbacTemplates.length;
  const readiness = evidence.readiness;
  return (
    <div data-testid="onboarding-bootstrap-result" style={{ display: 'grid', gap: 14 }}>
      <div className="kvgrid">
        <div className="kvgrid__row">
          <span className="kvgrid__key">Status</span>
          <span className="kvgrid__val">
            <Chip
              label={evidence.ok ? (evidence.enabled ? 'Bootstrap completed' : 'Bootstrap skipped by policy') : 'Bootstrap failed'}
              kind={evidence.ok ? (evidence.enabled ? 'good' : 'warn') : 'danger'}
            />
          </span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">Scope</span>
          <span className="kvgrid__val">{scopeLabel}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">Scope id</span>
          <span className="kvgrid__val mono">{evidence.scopeId || '—'}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">Scope defaults seeded</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-scope-defaults-count">{seededCount}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">Global defaults seeded</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-global-defaults-count">{globalSeededCount}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">Global defaults skipped</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-global-defaults-skipped">{globalSkippedCount}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">RBAC templates provisioned</span>
          <span className="kvgrid__val mono" data-testid="bootstrap-rbac-templates-count">{templatesCount}</span>
        </div>
        {readiness ? (
          <div className="kvgrid__row">
            <span className="kvgrid__key">Readiness after bootstrap</span>
            <span className="kvgrid__val">{readinessLabel(readiness.overall_status, 'Unknown')}</span>
          </div>
        ) : null}
        {evidence.reason ? (
          <div className="kvgrid__row">
            <span className="kvgrid__key">Skip reason</span>
            <span className="kvgrid__val">{readinessLabel(evidence.reason, evidence.reason)}</span>
          </div>
        ) : null}
        <div className="kvgrid__row">
          <span className="kvgrid__key">Recorded at</span>
          <span className="kvgrid__val mono">{evidence.generatedAt}</span>
        </div>
      </div>
      {seededCount > 0 ? (
        <div>
          <div className="wf-insp__section-eyebrow">Scope defaults applied</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {evidence.scopeDefaults.seeded.map((category) => (
              <li key={category}>{category}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {templatesCount > 0 ? (
        <div>
          <div className="wf-insp__section-eyebrow">RBAC templates provisioned</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {evidence.rbacTemplates.map((template) => (
              <li key={template}>{template}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {globalSkippedCount > 0 ? (
        <div>
          <div className="wf-insp__section-eyebrow">Global defaults skipped</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {evidence.globalDefaults.skipped.map((entry) => (
              <li key={entry.category}>
                {entry.category}: {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <div className="wf-insp__section-eyebrow">Backend response</div>
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
  return (
    <div className="card" style={{ padding: 14, minHeight: 118 }}>
      <div className="section-eyebrow" style={{ padding: 0, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Chip label={readinessLabel(component.status, 'Unknown')} kind={chipKindForStatus(component.status)} />
        <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{countLabel(component)}</span>
      </div>
      <div className="kvgrid" style={{ marginTop: 12 }}>
        <div className="kvgrid__row">
          <span className="kvgrid__key">Blocking</span>
          <span className="kvgrid__val mono">{component.blocking_count ?? 0}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key">Warning</span>
          <span className="kvgrid__val mono">{component.warning_count ?? 0}</span>
        </div>
      </div>
    </div>
  );
}

export function OnboardingReadinessModule() {
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
        label: scopeTypeLabel(row.scope_type),
      }));
  }, [scopeRegistryQuery.data]);
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
        label: cleanLabel || fallbackScopeReferenceLabel(scopeType),
      });
    };

    add(scopedId, scopedLabel);
    if (scopeType === 'tenant') {
      add(identity.user.organization_id, scopedLabel || 'Current tenant');
    } else {
      add(identity.user.access_scope_type === scopeType ? identity.user.access_scope_id : null, scopedLabel);
    }
    if (scopeId.trim()) {
      add(
        scopeId,
        scopeType === 'tenant'
          ? tenantReferenceLabelById.get(scopeId.trim()) ?? fallbackScopeReferenceLabel(scopeType)
          : fallbackScopeReferenceLabel(scopeType),
      );
    }

    return rows;
  }, [identity.scope, identity.user.access_scope_id, identity.user.access_scope_type, identity.user.organization_id, scopeId, scopeType, tenantReferenceLabelById]);
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
    if (scopeType === 'global') return 'Global readiness';
    const id = effectiveScopeId ?? '';
    return scopeReferenceLabelById.get(id) || fallbackScopeReferenceLabel(scopeType);
  }, [effectiveScopeId, scopeReferenceLabelById, scopeType]);
  const bootstrapMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveScopeId) throw new Error('Select a tenant, client, or sender before running bootstrap');
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
          ? `Onboarding bootstrap completed - ${scopeLabel}`
          : `Onboarding bootstrap skipped by policy - ${scopeLabel}`
        : `Onboarding bootstrap failed - ${scopeLabel}`;
      pushToast(message, tone);
      void readiness.refetch();
      modal.open({
        title: `Onboarding bootstrap result - ${scopeLabel}`,
        body: <BootstrapEvidencePanel evidence={evidence} scopeLabel={scopeLabel} />,
        footer: (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button label="Close" kind="primary" onClick={() => modal.close()} />
          </div>
        ),
      });
    },
    onError: (error: Error) => {
      pushToast(`Onboarding bootstrap failed - ${error.message}`, 'danger');
    },
  });
  const canRunBootstrap = (canWriteSettings || canWriteSystem) && scopeType !== 'global' && Boolean(effectiveScopeId);

  const findingColumns = useMemo<Array<DataTableColumn<OnboardingReadinessFinding>>>(() => [
    { key: 'severity', label: 'Severity', type: 'text', render: (raw) => readinessLabel(raw, 'Severity') },
    { key: 'component', label: 'Area', type: 'text', render: (raw) => readinessLabel(raw) },
    { key: 'code', label: 'Finding', type: 'text', render: (raw) => readinessLabel(raw) },
    { key: 'message', label: 'Message', type: 'text', render: (raw) => readinessMessage(raw) },
    { key: 'action', label: 'Action', type: 'text', render: (raw) => readinessMessage(raw) },
  ], []);

  const pluginColumns = useMemo<Array<DataTableColumn<OnboardingReadinessPluginItem>>>(() => [
    { key: 'plugin_key', label: 'Integration', type: 'text', render: (raw) => readinessLabel(raw) },
    { key: 'status', label: 'Status', type: 'text', render: (raw) => readinessLabel(raw, 'Unknown') },
    { key: 'credentials_status', label: 'Credentials', type: 'text', render: (raw) => readinessLabel(raw, 'Not required') },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'blocking', label: 'Blocking', type: 'boolean' },
  ], []);

  const data = readiness.data;
  const pluginItems = data?.integration_plugins.items ?? [];

  if (!canReadSettings) {
    return (
      <div className="page">
        <PageHeader eyebrow="Platform" titleAccent="Onboarding" titlePlain="readiness" />
        <StateView kind="denied" capability={CAP.SETTINGS_READ} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Platform"
        titleAccent="Onboarding"
        titlePlain="readiness"
        pills={[
          <span key="readiness" className="chip chip--xs">readiness checks</span>,
          <span key="settings" className="chip chip--xs mono">settings defaults</span>,
          <span key="workflows" className="chip chip--xs mono">workflow bindings</span>,
          <span key="plugins" className="chip chip--xs mono">integration plugins</span>,
          <span key="labels" className="chip chip--xs mono">label design</span>,
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
            {bootstrapMutation.isPending ? 'Running' : 'Run bootstrap'}
          </Button>,
          <Button key="refresh" size="sm" kind="ghost" onClick={() => readiness.refetch()} disabled={!hasScope}>
            Refresh
          </Button>,
        ]}
      />

      <div className="dt-toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 180 }}>
          <span className="field__label">Scope type</span>
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
          <span className="field__label">Scope reference</span>
          {scopeType === 'global' ? (
            <input value="" disabled placeholder="Global readiness" />
          ) : scopeReferenceOptions.length > 0 ? (
            <select
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
              aria-label="Scope reference"
            >
              {scopeReferenceOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : (
            <input
              value=""
              disabled
              placeholder="No selectable scope available"
            />
          )}
        </label>
        {data ? (
          <Chip
            label={readinessLabel(data.overall_status, 'Unknown readiness')}
            kind={chipKindForStatus(data.overall_status)}
            data-testid="onboarding-readiness-status"
          />
        ) : null}
      </div>

      {scopeRegistryQuery.isLoading ? (
        <StateView kind="loading" title="Loading readiness scope registry" />
      ) : scopeRegistryQuery.isError ? (
        <StateView
          kind="error"
          title="Readiness scope registry failed"
          hint={queryErrorHint(scopeRegistryQuery.error, 'Scope type registry could not be loaded')}
        />
      ) : scopeOptions.length === 0 ? (
        <StateView
          kind="error"
          title="Readiness scope registry empty"
          hint="Configure enabled scope_type_registry rows before running onboarding readiness."
        />
      ) : scopeType === 'tenant' && tenantReferenceQuery.isLoading ? (
        <StateView kind="loading" title="Loading tenant scope reference" />
      ) : scopeType === 'tenant' && tenantReferenceQuery.isError ? (
        <StateView
          kind="error"
          title="Tenant scope reference failed"
          hint={queryErrorHint(tenantReferenceQuery.error, 'Tenant scope reference could not be loaded')}
        />
      ) : !hasScope ? (
        <StateView
          kind="empty"
          title="Select a scope"
          hint="Choose the tenant, client, or sender record to inspect readiness before traffic starts."
        />
      ) : readiness.isLoading ? (
        <StateView kind="loading" title="Checking onboarding readiness" />
      ) : readiness.isError ? (
        <StateView
          kind="error"
          title="Readiness check failed"
          hint={readiness.error instanceof Error ? readiness.error.message : 'Readiness checks could not be loaded'}
        />
      ) : data ? (
        <>
          <div className="status-grid">
            <ReadinessCard title="Settings defaults" component={data.settings_defaults} />
            <ReadinessCard title="Workflow bindings" component={data.workflow_bindings} />
            <ReadinessCard title="Integration plugins" component={data.integration_plugins} />
            {data.label_design ? (
              <ReadinessCard title="Label design" component={data.label_design} />
            ) : null}
          </div>

          <div className="section-eyebrow">Blocking findings</div>
          <DataTable
            viewKey="platform.onboarding-readiness.findings"
            columns={findingColumns}
            rows={data.blocking_findings}
            emptyText="No blocking onboarding findings."
            searchKeys={['component', 'code', 'message', 'action']}
          />

          <div className="section-eyebrow">Integration plugin readiness</div>
          <DataTable
            viewKey="platform.onboarding-readiness.plugins"
            columns={pluginColumns}
            rows={pluginItems}
            emptyText="No plugin readiness rows returned."
            searchKeys={['plugin_key', 'status', 'credentials_status']}
          />
        </>
      ) : null}
      {modal.node}
    </div>
  );
}

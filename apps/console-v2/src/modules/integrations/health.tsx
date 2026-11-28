// integrations/health.tsx - Provider health and circuit breaker dashboard.
// Backed by registry reads for provider_health_latest and circuit_breaker_dashboard.

import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { KPICard } from '@/components/KPICard';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { Chip } from '@/components/Chip';
import { Button } from '@/components/Button';
import { Drawer } from '@/components/Drawer';
import { useProbeProviderCircuit, useResourceList, useResetProviderCircuit } from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { fill, useI18n, type Translate } from '@/lib/i18n';

interface ProviderHealthRow extends Record<string, unknown> {
  provider_id: string;
  provider_name?: string | null;
  status: string;
  error_message?: string | null;
  decision_log_id?: string | null;
  correlation_id?: string | null;
  metadata?: Record<string, unknown> | null;
  success_rate_24h?: number;
  avg_latency_ms?: number;
  error_rate_24h?: number;
  created_at: string;
}

interface CircuitBreakerRow extends Record<string, unknown> {
  provider_id: string;
  provider_name?: string | null;
  operation_name: string;
  state: string;
  failure_rate?: number;
  updated_at: string;
  half_open_test_at?: string | null;
  opened_at?: string | null;
  last_failure_at?: string | null;
  last_success_at?: string | null;
  last_health_status?: string | null;
  last_health_error?: string | null;
  last_health_at?: string | null;
  reopen_count?: number;
  manual_intervention_required?: boolean;
}

type ActiveDrawer =
  | { kind: 'health'; providerId: string }
  | { kind: 'breaker'; providerId: string; operationName: string };

interface ResetReadback {
  provider_id?: string;
  operation_name?: string;
  state?: string;
  health_status?: string;
  decision_log_id?: string;
  correlation_id?: string;
  decision_point?: 'operator_reset' | 'recovery_probe';
}

function formatDateTime(value: unknown): string {
  if (!value) return '-';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatPercentValue(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(1)}%`;
}

function providerLabel(row: ProviderHealthRow | CircuitBreakerRow): string {
  return row.provider_name || row.provider_id;
}

function lookupChip(category: string, value: unknown, t: Translate, emptyLabel = '-'): ReactNode {
  const v = String(value ?? '');
  if (!v) return <Chip label={emptyLabel} kind="neutral" size="xs" />;
  const row = lookupRow(category, v);
  if (!row) return <Chip label={fill(t('integrationsHealth.lookupChip.unknown'), { category, value: v })} kind="danger" size="xs" />;
  return <Chip label={row.label ?? v} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />;
}

function DetailGrid({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, 0.4fr) minmax(0, 1fr)',
        gap: '8px 12px',
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <div className="eyebrow">{label}</div>
          <div className="mono" style={{ fontSize: '12px', overflowWrap: 'anywhere' }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function interventionChip(t: Translate, required?: boolean) {
  return required ? (
    <Chip label={t('integrationsHealth.interventionChip.required')} kind="danger" size="xs" />
  ) : (
    <Chip label={t('integrationsHealth.interventionChip.notRequired')} kind="good" size="xs" />
  );
}

function ProviderHealthDrawer({
  row,
  breakers,
}: {
  row: ProviderHealthRow;
  breakers: CircuitBreakerRow[];
}) {
  const { t } = useI18n();
  return (
    <div data-testid="provider-health-drawer">
      <div className="section-eyebrow">{t('integrationsHealth.providerHealthDrawer.latestProviderSignal')}</div>
      <div className="card">
        <DetailGrid
          rows={[
            [t('integrationsHealth.detail.provider'), providerLabel(row)],
            [t('integrationsHealth.detail.providerReference'), providerLabel(row)],
            [t('integrationsHealth.detail.status'), lookupChip('provider_health', row.status, t)],
            [t('integrationsHealth.detail.success24h'), formatPercentValue(row.success_rate_24h)],
            [t('integrationsHealth.detail.errorRate24h'), formatPercentValue(row.error_rate_24h)],
            [t('integrationsHealth.detail.averageLatency'), row.avg_latency_ms == null ? '-' : `${Number(row.avg_latency_ms).toFixed(0)} ms`],
            [t('integrationsHealth.detail.lastCheck'), formatDateTime(row.created_at)],
            [t('integrationsHealth.detail.error'), row.error_message || '-'],
            [t('integrationsHealth.detail.correlation'), row.correlation_id || '-'],
            [t('integrationsHealth.detail.decisionLog'), row.decision_log_id || '-'],
          ]}
        />
      </div>

      <div className="section-eyebrow" style={{ marginTop: '14px' }}>
        {t('integrationsHealth.providerHealthDrawer.relatedCircuitBreakers')}
      </div>
      {breakers.length ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          {breakers.map((breaker) => (
            <div className="card" key={`${breaker.provider_id}:${breaker.operation_name}`}>
              <DetailGrid
                rows={[
                  [t('integrationsHealth.detail.operation'), breaker.operation_name],
                  [t('integrationsHealth.detail.state'), lookupChip('circuit_state', breaker.state, t)],
                  [t('integrationsHealth.detail.failureRate'), formatPercentValue(breaker.failure_rate)],
                  [t('integrationsHealth.detail.reopens'), String(breaker.reopen_count ?? 0)],
                  [t('integrationsHealth.detail.intervention'), interventionChip(t, breaker.manual_intervention_required)],
                  [t('integrationsHealth.detail.changed'), formatDateTime(breaker.updated_at)],
                  [t('integrationsHealth.detail.nextProbe'), formatDateTime(breaker.half_open_test_at)],
                  [t('integrationsHealth.detail.lastHealth'), breaker.last_health_status || '-'],
                  [t('integrationsHealth.detail.lastError'), breaker.last_health_error || '-'],
                ]}
              />
            </div>
          ))}
        </div>
      ) : (
        <StateView kind="empty" hint={t('integrationsHealth.providerHealthDrawer.noCircuitBreakerIs')} />
      )}
    </div>
  );
}

function CircuitBreakerDrawer({ row }: { row: CircuitBreakerRow }) {
  const { t } = useI18n();
  return (
    <div data-testid="circuit-breaker-drawer">
      <div className="section-eyebrow">{t('integrationsHealth.circuitBreakerDrawer.circuitBreakerState')}</div>
      <div className="card">
        <DetailGrid
          rows={[
            [t('integrationsHealth.detail.provider'), providerLabel(row)],
            [t('integrationsHealth.detail.providerId'), row.provider_id],
            [t('integrationsHealth.detail.operation'), row.operation_name],
            [t('integrationsHealth.detail.state'), lookupChip('circuit_state', row.state, t)],
            [t('integrationsHealth.detail.failureRate'), formatPercentValue(row.failure_rate)],
            [t('integrationsHealth.detail.reopens'), String(row.reopen_count ?? 0)],
            [t('integrationsHealth.detail.intervention'), interventionChip(t, row.manual_intervention_required)],
            [t('integrationsHealth.detail.opened'), formatDateTime(row.opened_at)],
            [t('integrationsHealth.detail.changed'), formatDateTime(row.updated_at)],
            [t('integrationsHealth.detail.nextProbe'), formatDateTime(row.half_open_test_at)],
            [t('integrationsHealth.detail.lastFailure'), formatDateTime(row.last_failure_at)],
            [t('integrationsHealth.detail.lastSuccess'), formatDateTime(row.last_success_at)],
            [t('integrationsHealth.detail.lastHealth'), row.last_health_status || '-'],
            [t('integrationsHealth.detail.lastHealthAt'), formatDateTime(row.last_health_at)],
            [t('integrationsHealth.detail.lastError'), row.last_health_error || '-'],
          ]}
        />
      </div>
    </div>
  );
}

function healthColumns(t: Translate): Array<DataTableColumn<ProviderHealthRow>> {
  return [
    {
      key: 'provider_name',
      label: t('integrationsHealth.columns.provider'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => (
        <span>
          {providerLabel(row)}
          <span className="mono" style={{ color: 'var(--ink-3)', marginLeft: 6, fontSize: '11px' }}>
            {row.provider_id}
          </span>
        </span>
      ),
    },
    { key: 'status', label: t('integrationsHealth.columns.status'), sortable: true, filterable: true, render: (raw) => lookupChip('provider_health', raw, t) },
    { key: 'success_rate_24h', label: t('integrationsHealth.columns.success'), align: 'right', format: 'percent', sortable: true },
    { key: 'avg_latency_ms', label: t('integrationsHealth.columns.avgLatency'), align: 'right', format: 'ms', sortable: true },
    { key: 'error_rate_24h', label: t('integrationsHealth.columns.errorRate'), align: 'right', format: 'percent', sortable: true },
    {
      key: 'error_message',
      label: t('integrationsHealth.columns.lastError'),
      sortable: true,
      filterable: true,
      render: (raw) => (raw ? <span>{String(raw)}</span> : <span className="mono">-</span>),
    },
    { key: 'created_at', label: t('integrationsHealth.columns.lastCheck'), format: 'datetime' },
  ];
}

function breakerColumns(t: Translate): Array<DataTableColumn<CircuitBreakerRow>> {
  return [
    {
      key: 'provider_name',
      label: t('integrationsHealth.columns.provider'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => (
        <span>
          {providerLabel(row)}
          <span className="mono" style={{ color: 'var(--ink-3)', marginLeft: 6, fontSize: '11px' }}>
            {row.provider_id}
          </span>
        </span>
      ),
    },
    { key: 'operation_name', label: t('integrationsHealth.columns.operation'), sortable: true, filterable: true },
    { key: 'state', label: t('integrationsHealth.columns.state'), sortable: true, filterable: true, render: (raw) => lookupChip('circuit_state', raw, t) },
    { key: 'failure_rate', label: t('integrationsHealth.columns.failureRate'), align: 'right', format: 'percent', sortable: true },
    {
      key: 'reopen_count',
      label: t('integrationsHealth.columns.reopens'),
      align: 'right',
      sortable: true,
      render: (raw) => <span className="mono">{Number(raw ?? 0)}</span>,
    },
    {
      key: 'manual_intervention_required',
      label: t('integrationsHealth.columns.intervention'),
      sortable: true,
      render: (raw) => interventionChip(t, Boolean(raw)),
    },
    { key: 'updated_at', label: t('integrationsHealth.columns.changed'), format: 'datetime', sortable: true },
    { key: 'half_open_test_at', label: t('integrationsHealth.columns.nextProbe'), format: 'datetime', sortable: true },
  ];
}

export function HealthModule() {
  const { t } = useI18n();
  const healthCols = useMemo(() => healthColumns(t), [t]);
  const breakerCols = useMemo(() => breakerColumns(t), [t]);
  const canRead = useCapability(CAP.INTEGRATIONS_READ);
  const canWriteIntegrations = useCapability(CAP.INTEGRATIONS_WRITE);
  const canWriteIntegrationPlugins = useCapability(CAP.INTEGRATION_PLUGINS_WRITE);
  const canReset = canWriteIntegrations || canWriteIntegrationPlugins;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [resetReadback, setResetReadback] = useState<ResetReadback | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer | null>(null);
  const resetMutation = useResetProviderCircuit();
  const probeMutation = useProbeProviderCircuit();
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const healthQuery = useResourceList<ProviderHealthRow>('provider_health_latest', undefined, readQueryOptions);
  const breakerQuery = useResourceList<CircuitBreakerRow>('circuit_breaker_dashboard', undefined, readQueryOptions);

  const headerPills = [
    <span key="src" className="chip chip--xs">{t('integrationsHealth.healthModule.providerTelemetryCircuitBreaker')}</span>,
    refreshedAt ? <span key="refresh" className="chip chip--xs mono">{fill(t('integrationsHealth.healthModule.refreshed'), { value: String(formatDateTime(refreshedAt)) })}</span> : null,
  ].filter(Boolean) as ReactNode[];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-health"
          eyebrow={t('integrationsHealth.healthModule.integrations')}
          titleAccent={t('integrationsHealth.healthModule.titleAccent')}
          titlePlain={t('integrationsHealth.healthModule.titlePlain')}
          pills={[<span key="src" className="chip chip--xs">{t('integrationsHealth.healthModule.providerTelemetryCircuitBreaker')}</span>]}
        />
        <StateView
          kind="denied"
          capability={CAP.INTEGRATIONS_READ}
          hint={t('integrationsHealth.healthModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (healthQuery.isLoading || breakerQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-health"
          eyebrow={t('integrationsHealth.healthModule.integrations')}
          titleAccent={t('integrationsHealth.healthModule.titleAccent')}
          titlePlain={t('integrationsHealth.healthModule.titlePlain')}
          pills={[<span key="src" className="chip chip--xs">{t('integrationsHealth.healthModule.providerTelemetryCircuitBreaker')}</span>]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (healthQuery.error || breakerQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-health"
          eyebrow={t('integrationsHealth.healthModule.integrations')}
          titleAccent={t('integrationsHealth.healthModule.titleAccent')}
          titlePlain={t('integrationsHealth.healthModule.titlePlain')}
          pills={[]}
        />
        <StateView kind="error" hint={String(healthQuery.error || breakerQuery.error)} />
      </div>
    );
  }

  const health = healthQuery.data?.rows ?? [];
  const breakers = breakerQuery.data?.rows ?? [];
  const healthyCount = health.filter((h) => lookupRow('provider_health', h.status)?.tone === 'good').length;
  const degradedCount = health.filter((h) => lookupRow('provider_health', h.status)?.tone === 'warn').length;
  const openBreakerCount = breakers.filter((b) => String(b.state ?? '').toLowerCase() !== 'closed').length;
  const interventionCount = breakers.filter((b) => b.manual_intervention_required).length;

  const refreshTelemetry = async () => {
    setRefreshing(true);
    try {
      await Promise.all([healthQuery.refetch(), breakerQuery.refetch()]);
      setRefreshedAt(new Date().toISOString());
    } finally {
      setRefreshing(false);
    }
  };

  const openHealthDrawer = (row: ProviderHealthRow) => {
    setResetError(null);
    setResetReadback(null);
    setActiveDrawer({ kind: 'health', providerId: row.provider_id });
  };

  const openBreakerDrawer = (row: CircuitBreakerRow) => {
    setResetError(null);
    setResetReadback(null);
    setActiveDrawer({
      kind: 'breaker',
      providerId: row.provider_id,
      operationName: row.operation_name,
    });
  };

  const selectedHealthRow =
    activeDrawer?.kind === 'health'
      ? health.find((row) => row.provider_id === activeDrawer.providerId) ?? null
      : null;
  const selectedBreakerRow =
    activeDrawer?.kind === 'breaker'
      ? breakers.find(
          (row) =>
            row.provider_id === activeDrawer.providerId &&
            row.operation_name === activeDrawer.operationName,
        ) ?? null
      : null;
  const drawerTitle = selectedHealthRow
    ? fill(t('integrationsHealth.healthModule.providerHealthFor'), { provider: providerLabel(selectedHealthRow) })
    : selectedBreakerRow
      ? fill(t('integrationsHealth.healthModule.circuitBreakerFor'), { provider: providerLabel(selectedBreakerRow) })
      : activeDrawer?.kind === 'health'
        ? t('integrationsHealth.healthModule.providerHealth')
        : t('integrationsHealth.healthModule.circuitBreaker');
  const drawerBody = selectedHealthRow ? (
    <ProviderHealthDrawer
      row={selectedHealthRow}
      breakers={breakers.filter((breaker) => breaker.provider_id === selectedHealthRow.provider_id)}
    />
  ) : selectedBreakerRow ? (
    <>
      <CircuitBreakerDrawer row={selectedBreakerRow} />
      {resetReadback ? (
        <div className="card" style={{ marginTop: '14px' }} data-testid="provider-circuit-reset-readback">
          <div className="section-eyebrow">
            {resetReadback.decision_point === 'recovery_probe' ? t('integrationsHealth.healthModule.recoveryProbeConfirmed') : t('integrationsHealth.healthModule.resetConfirmed')}
          </div>
          <DetailGrid
            rows={[
              [t('integrationsHealth.detail.provider'), resetReadback.provider_id || '-'],
              [t('integrationsHealth.detail.operation'), resetReadback.operation_name || '-'],
              [t('integrationsHealth.detail.circuitState'), lookupChip('circuit_state', resetReadback.state, t)],
              [t('integrationsHealth.detail.providerHealth'), lookupChip('provider_health', resetReadback.health_status, t)],
              [t('integrationsHealth.detail.correlation'), resetReadback.correlation_id || '-'],
              [t('integrationsHealth.detail.decisionLog'), resetReadback.decision_log_id || '-'],
            ]}
          />
        </div>
      ) : null}
      {resetError ? (
        <StateView kind="error" hint={resetError} />
      ) : null}
    </>
  ) : (
    <StateView kind="empty" hint={t('integrationsHealth.healthModule.theSelectedProviderSignal')} />
  );

  const resetSelectedBreaker = async () => {
    if (!selectedBreakerRow || !canReset || resetMutation.isPending) return;
    setResetError(null);
    setResetReadback(null);
    try {
      const result = await resetMutation.mutateAsync({
        provider_id: selectedBreakerRow.provider_id,
        operation_name: selectedBreakerRow.operation_name,
        reason: 'Console Provider Health operator reset',
      });
      await refreshTelemetry();
      setResetReadback({
        provider_id: String(result.provider_id ?? selectedBreakerRow.provider_id),
        operation_name: String(result.operation_name ?? selectedBreakerRow.operation_name),
        state: String(result.state ?? 'closed'),
        health_status: String(result.health_status ?? 'healthy'),
        decision_log_id: result.decision_log_id ? String(result.decision_log_id) : undefined,
        correlation_id: result.correlation_id ? String(result.correlation_id) : undefined,
        decision_point: 'operator_reset',
      });
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
    }
  };

  const probeSelectedBreaker = async () => {
    if (!selectedBreakerRow || !canReset || probeMutation.isPending) return;
    setResetError(null);
    setResetReadback(null);
    try {
      const result = await probeMutation.mutateAsync({
        provider_id: selectedBreakerRow.provider_id,
        operation_name: selectedBreakerRow.operation_name,
        reason: 'Console Provider Health recovery probe',
      });
      await refreshTelemetry();
      setResetReadback({
        provider_id: String(result.provider_id ?? selectedBreakerRow.provider_id),
        operation_name: String(result.operation_name ?? selectedBreakerRow.operation_name),
        state: String(result.state ?? 'closed'),
        health_status: String(result.health_status ?? 'healthy'),
        decision_log_id: result.decision_log_id ? String(result.decision_log_id) : undefined,
        correlation_id: result.correlation_id ? String(result.correlation_id) : undefined,
        decision_point: 'recovery_probe',
      });
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
    }
  };

  const showResetAction =
    selectedBreakerRow && String(selectedBreakerRow.state ?? '').toLowerCase() === 'open';
  const showProbeAction =
    selectedBreakerRow && String(selectedBreakerRow.state ?? '').toLowerCase() === 'half_open';

  return (
    <div className="page">
      <PageHeader
        moduleKey="int-health"
        eyebrow={t('integrationsHealth.healthModule.integrations')}
        titleAccent={t('integrationsHealth.healthModule.titleAccent')}
        titlePlain={t('integrationsHealth.healthModule.titlePlain')}
        pills={headerPills}
        actions={[
          <Button
            key="refresh"
            label={refreshing ? t('integrationsHealth.healthModule.refreshing') : t('integrationsHealth.healthModule.refreshTelemetry')}
            iconName="refresh"
            kind="ghost"
            disabled={refreshing}
            onClick={() => void refreshTelemetry()}
          />,
        ]}
      />
      <div className="kpi-strip">
        <KPICard label={t('integrationsHealth.healthModule.providers')} value={health.length} tone="neutral" />
        <KPICard label={t('integrationsHealth.healthModule.healthy')} value={healthyCount} tone="good" />
        <KPICard label={t('integrationsHealth.healthModule.degraded')} value={degradedCount} tone="warn" />
        <KPICard label={t('integrationsHealth.healthModule.openBreakers')} value={openBreakerCount} tone={openBreakerCount ? 'danger' : 'good'} />
        <KPICard label={t('integrationsHealth.healthModule.needsIntervention')} value={interventionCount} tone={interventionCount ? 'danger' : 'good'} />
      </div>
      <div className="section-eyebrow">{t('integrationsHealth.healthModule.providerHealth24h')}</div>
      <DataTable<ProviderHealthRow>
        columns={healthCols}
        rows={health}
        viewKey="provider_health_latest"
        entityKind="provider_health"
        onRowClick={openHealthDrawer}
      />
      <div className="section-eyebrow">{t('integrationsHealth.healthModule.circuitBreakers')}</div>
      <DataTable<CircuitBreakerRow>
        columns={breakerCols}
        rows={breakers}
        viewKey="circuit_breaker"
        entityKind="circuit_breaker"
        emptyText={t('integrationsHealth.healthModule.allCircuitsClosed')}
        onRowClick={openBreakerDrawer}
      />
      <Drawer
        open={Boolean(activeDrawer)}
        title={drawerTitle}
        size="lg"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, width: '100%' }}>
            {showProbeAction ? (
              <Button
                label={probeMutation.isPending ? t('integrationsHealth.healthModule.probing') : t('integrationsHealth.healthModule.runRecoveryProbe')}
                iconName="play"
                kind="primary"
                disabled={probeMutation.isPending}
                anyCapabilities={[CAP.INTEGRATIONS_WRITE, CAP.INTEGRATION_PLUGINS_WRITE]}
                title={canReset ? undefined : t('integrationsHealth.healthModule.integrationUpdatePermissionRequired')}
                onClick={() => void probeSelectedBreaker()}
              />
            ) : null}
            {showResetAction ? (
              <Button
                label={resetMutation.isPending ? t('integrationsHealth.healthModule.resetting') : t('integrationsHealth.healthModule.resetBreaker')}
                iconName="check"
                kind="primary"
                disabled={resetMutation.isPending}
                anyCapabilities={[CAP.INTEGRATIONS_WRITE, CAP.INTEGRATION_PLUGINS_WRITE]}
                title={canReset ? undefined : t('integrationsHealth.healthModule.integrationUpdatePermissionRequired')}
                onClick={() => void resetSelectedBreaker()}
              />
            ) : null}
            <Button
              label={refreshing ? t('integrationsHealth.healthModule.refreshing') : t('integrationsHealth.healthModule.refreshTelemetry')}
              iconName="refresh"
              kind="ghost"
              disabled={refreshing}
              onClick={() => void refreshTelemetry()}
            />
          </div>
        }
        onClose={() => setActiveDrawer(null)}
      >
        {drawerBody}
      </Drawer>
    </div>
  );
}

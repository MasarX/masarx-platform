// Statusbar.tsx — 28px footer with eight semantic segments. Mirrors the demo's
// statusbar including a live decision_log heartbeat segment subscribed via
// api.streamEvidence(). Click handlers route to the relevant module or surface
// a placeholder toast (until drawers are wired by App).
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n';
import { CAP } from '@/lib/capabilities';
import { useCapability, useIdentity } from '@/lib/identity';
import * as api from '@/lib/api';
import { useResourceList, useTasks } from '@/lib/queries';
import type { DecisionLogEntry, ScopeType } from '@/types/domain';

/** Cap the rolling decision_log buffer; latest entry is what shows in the cell. */
const MAX_RECENT = 5;

// SCHEMA-DRIFT NOTE (Wave 11 / W11-5 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §6):
// `resolved_from` is NOT a direct column on `public.decision_log`. It is
// projected at the FE/seed seam from a join with
// `settings_resolution_log.winning_scope_type`. The base `DecisionLogEntry`
// drops it; consumers that render scope context use this extended shape.
type DecisionLogRecent = DecisionLogEntry & { resolved_from?: ScopeType };

interface StatusState {
  recent: DecisionLogRecent[];
  lastSync?: number;
}

const INITIAL_STATE: StatusState = {
  recent: [],
};

type CommandRegistryLike =
  | { commands?: Array<{ key?: string; label?: string }> }
  | Array<{ key?: string; label?: string }>
  | null
  | undefined;

interface ProviderHealthRow extends Record<string, unknown> {
  status?: string | null;
  latency_ms?: number | null;
  avg_latency_ms?: number | null;
  success_rate?: number | null;
  success_rate_24h?: number | null;
  metadata?: Record<string, unknown> | null;
}

interface WorkflowRunRow extends Record<string, unknown> {
  status?: string | null;
  workflow_status?: string | null;
  is_active?: boolean | null;
}

interface CommsAttemptRow extends Record<string, unknown> {
  status?: string | null;
}

interface StatusbarMetricInputs {
  providerHealthRows?: ProviderHealthRow[];
  workflowRunRows?: WorkflowRunRow[];
  commsAttemptRows?: CommsAttemptRow[];
  ndrTaskRows?: Record<string, unknown>[];
  atRiskTaskRows?: Record<string, unknown>[];
}

interface StatusbarMetricSummary {
  latencyMs: number | null;
  integrationOk: number;
  integrationTotal: number;
  queuedComms: number;
  activeWorkflowRuns: number;
  ndrTasks: number;
  atRiskTasks: number;
}

interface TelemetryDisplayInput {
  canRead: boolean;
  isLoading?: boolean;
  isError?: boolean;
  metrics: Pick<StatusbarMetricSummary, 'latencyMs' | 'integrationOk' | 'integrationTotal'>;
}

function titleCaseToken(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function lookupLifecycle(category: string, value: string | null | undefined): string | null {
  if (!value) return null;
  const row = api.getLookups(category).find((entry) => entry.value === value);
  return typeof row?.metadata?.lifecycle === 'string' ? row.metadata.lifecycle : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function providerLatency(row: ProviderHealthRow): number | null {
  return numericValue(row.latency_ms)
    ?? numericValue(row.avg_latency_ms)
    ?? numericValue(row.metadata?.latency_ms)
    ?? numericValue(row.metadata?.avg_latency_ms);
}

function providerIsHealthy(row: ProviderHealthRow): boolean {
  const lifecycle = lookupLifecycle('provider_health_status', row.status);
  if (lifecycle) return lifecycle === 'active' || lifecycle === 'healthy';
  const lookup = row.status
    ? api.getLookups('provider_health_status').find((entry) => entry.value === row.status)
    : null;
  return lookup?.tone === 'good';
}

function workflowRunIsActive(row: WorkflowRunRow): boolean {
  if (typeof row.is_active === 'boolean') return row.is_active;
  const status = row.status ?? row.workflow_status;
  const lifecycle = lookupLifecycle('workflow_run_status', status);
  return lifecycle === 'active' || lifecycle === 'pending' || lifecycle === 'running';
}

export function deriveStatusbarMetrics(input: StatusbarMetricInputs): StatusbarMetricSummary {
  const providerRows = input.providerHealthRows ?? [];
  const latencies = providerRows
    .map(providerLatency)
    .filter((value): value is number => value != null);
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : null;
  return {
    latencyMs: avgLatency,
    integrationOk: providerRows.filter(providerIsHealthy).length,
    integrationTotal: providerRows.length,
    queuedComms: (input.commsAttemptRows ?? []).filter((row) => row.status?.toLowerCase() === 'queued').length,
    activeWorkflowRuns: (input.workflowRunRows ?? []).filter(workflowRunIsActive).length,
    ndrTasks: input.ndrTaskRows?.length ?? 0,
    atRiskTasks: input.atRiskTaskRows?.length ?? 0,
  };
}

export function formatProviderTelemetryLatency(input: TelemetryDisplayInput): string {
  if (!input.canRead) return 'restricted';
  if (input.isLoading) return 'loading';
  if (input.isError) return 'unavailable';
  if (input.metrics.integrationTotal === 0) return 'not configured';
  return input.metrics.latencyMs != null ? `${input.metrics.latencyMs}ms` : 'no latency';
}

export function formatProviderTelemetryHealth(input: TelemetryDisplayInput): string {
  if (!input.canRead) return 'restricted';
  if (input.isLoading) return 'loading';
  if (input.isError) return 'unavailable';
  if (input.metrics.integrationTotal === 0) return '0 providers';
  return `${input.metrics.integrationOk}/${input.metrics.integrationTotal} ok`;
}

export function formatDecisionCategory(
  category: string | null | undefined,
  commandRegistry: CommandRegistryLike = api.getCommandRegistry() as CommandRegistryLike,
): string {
  const raw = String(category ?? '').trim();
  if (!raw) return 'Decision';
  const commands = Array.isArray(commandRegistry)
    ? commandRegistry
    : Array.isArray(commandRegistry?.commands)
      ? commandRegistry.commands
      : [];
  const command = commands.find((entry) => entry.key === raw);
  if (command?.label?.trim()) return command.label.trim();
  return raw
    .split(/[._-]+/)
    .filter(Boolean)
    .map(titleCaseToken)
    .join(' ');
}

function fmtTimeShort(input: string | number | Date | undefined): string {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export interface StatusbarProps {
  /** Open the scope palette (clicking the env segment). */
  onOpenScopePalette?: () => void;
  /** Open the keyboard shortcuts modal (clicking help / ?). */
  onOpenShortcuts?: () => void;
  /** Optional toast emitter (placeholder drawer fallback). */
  onToast?: (message: string, tone?: 'good' | 'warn' | 'danger' | 'info') => void;
  /** Optional drawer opener for the evidence trail expand action. */
  onOpenEvidenceTrail?: (recent: DecisionLogRecent[]) => void;
}

export function Statusbar({
  onOpenScopePalette,
  onOpenShortcuts,
  onToast,
  onOpenEvidenceTrail,
}: StatusbarProps) {
  const router = useRouter();
  const { t } = useI18n();
  const { scope } = useIdentity();
  const canReadProviderHealth = useCapability(CAP.INTEGRATIONS_READ);
  const [state, setState] = useState<StatusState>(INITIAL_STATE);
  const providerHealth = useResourceList<ProviderHealthRow>(
    'provider_health_latest',
    { page_size: 50 },
    { retry: false, enabled: canReadProviderHealth },
  );
  const workflowRuns = useResourceList<WorkflowRunRow>('workflow_runs', { page_size: 50 }, { retry: false });
  const queuedComms = useResourceList<CommsAttemptRow>(
    'comms_attempts',
    { filter: { status: 'queued' }, page_size: 50 },
    { retry: false },
  );
  const ndrTasks = useTasks({ task_type: 'dispatch_exception_review' });
  const atRiskTasks = useTasks({ at_risk: true });

  // Subscribe to evidence stream; status counters below come from registry-backed reads.
  useEffect(() => {
    const unsubscribe = api.streamEvidence((entry: DecisionLogEntry) => {
      setState((prev) => {
        const next = [entry as DecisionLogRecent, ...prev.recent];
        if (next.length > MAX_RECENT) next.length = MAX_RECENT;
        return { ...prev, recent: next, lastSync: Date.now() };
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const latestQuerySync = Math.max(
    providerHealth.dataUpdatedAt,
    workflowRuns.dataUpdatedAt,
    queuedComms.dataUpdatedAt,
    ndrTasks.dataUpdatedAt,
    atRiskTasks.dataUpdatedAt,
  );

  useEffect(() => {
    if (latestQuerySync > 0) setState((prev) => ({ ...prev, lastSync: latestQuerySync }));
  }, [latestQuerySync]);

  const metrics = useMemo(() => deriveStatusbarMetrics({
    providerHealthRows: providerHealth.data?.rows,
    workflowRunRows: workflowRuns.data?.rows,
    commsAttemptRows: queuedComms.data?.rows,
    ndrTaskRows: ndrTasks.data,
    atRiskTaskRows: atRiskTasks.data,
  }), [
    providerHealth.data?.rows,
    workflowRuns.data?.rows,
    queuedComms.data?.rows,
    ndrTasks.data,
    atRiskTasks.data,
  ]);

  const tenantShort = scope?.tenant?.label?.split(' ')[0] ?? 'Tenant';
  const latest: DecisionLogRecent | undefined = state.recent[0];
  const secondsSinceSync = state.lastSync
    ? Math.max(0, Math.floor((Date.now() - state.lastSync) / 1000))
    : null;

  const navigateTo = (path: string) => {
    router.navigate({ to: path as never });
  };

  const handleRefresh = () => {
    void Promise.allSettled([
      ...(canReadProviderHealth ? [providerHealth.refetch()] : []),
      workflowRuns.refetch(),
      queuedComms.refetch(),
      ndrTasks.refetch(),
      atRiskTasks.refetch(),
    ]).then(() => {
      setState((prev) => ({ ...prev, lastSync: Date.now() }));
      onToast?.('Refreshed', 'good');
    });
  };

  const handleLink = () => {
    const telemetryState = formatProviderTelemetryLatency({
      canRead: canReadProviderHealth,
      isLoading: providerHealth.isLoading,
      isError: providerHealth.isError,
      metrics,
    });
    onToast?.(
      `Provider telemetry · ${telemetryState} · last readback ${
        secondsSinceSync != null ? `${secondsSinceSync}s ago` : 'not received'
      }`,
      'info'
    );
  };

  const evidenceText = useMemo(() => {
    if (!latest) return null;
    return (
      <span className="status-evidence__text">
        <span className="mono">{fmtTimeShort(latest.timestamp)}</span>
        {' · '}
        <span className="ev-cat">{formatDecisionCategory(latest.decision_category)}</span>
        {' · '}
        <span className="ev-scope">
          {t('common.resolved_from', 'Resolved from')} {latest.resolved_from ?? ''}
        </span>
        {latest.settings_resolution_id ? (
          <>
            {' · '}
            <span className="ev-srlv">policy evidence</span>
          </>
        ) : null}
      </span>
    );
  }, [latest, t]);

  return (
    <footer className="statusbar" role="status" aria-label="System status">
      <button
        className="status-seg status-seg--env"
        type="button"
        title="Environment + tenant scope"
        onClick={onOpenScopePalette}
      >
        <span className="status-seg__dot" aria-hidden="true" data-tone="good" />
        <span className="status-seg__label mono">dev</span>
        <span className="status-seg__sep">·</span>
        <span className="status-seg__value">{tenantShort}</span>
      </button>

      <button
        className="status-seg"
        type="button"
        title="Provider telemetry latency"
        onClick={handleLink}
      >
        <span className="status-seg__dot" aria-hidden="true" data-tone="good" />
        <span className="status-seg__label mono">telemetry</span>
        <span className="status-seg__value mono">
          {formatProviderTelemetryLatency({
            canRead: canReadProviderHealth,
            isLoading: providerHealth.isLoading,
            isError: providerHealth.isError,
            metrics,
          })}
        </span>
      </button>

      <button
        className="status-seg"
        type="button"
        title="Integration health · click to open"
        onClick={() => navigateTo('/integrations/health')}
      >
        <span className="status-seg__icon" aria-hidden="true">⚡</span>
        <span className="status-seg__value mono">
          {formatProviderTelemetryHealth({
            canRead: canReadProviderHealth,
            isLoading: providerHealth.isLoading,
            isError: providerHealth.isError,
            metrics,
          })}
        </span>
      </button>

      <button
        className="status-seg"
        type="button"
        title="Open exceptions / SLA-at-risk · click to open"
        onClick={() => navigateTo('/operate/exceptions')}
      >
        <span className="status-seg__icon" aria-hidden="true">⚠</span>
        <span className="status-seg__value mono">
          {metrics.ndrTasks} NDR · {metrics.atRiskTasks} at-risk
        </span>
      </button>

      <button
        className="status-seg"
        type="button"
        title="Outbox / sync state"
        onClick={() => navigateTo('/integrations/intake')}
      >
        <span className="status-seg__icon" aria-hidden="true">↻</span>
        <span className="status-seg__value mono">
          {metrics.queuedComms} queued · synced {secondsSinceSync != null ? `${secondsSinceSync}s` : '—'}
        </span>
      </button>

      <button
        className="status-seg"
        type="button"
        title="Background workflow runs · click to open log"
        onClick={() => navigateTo('/workflows/runs')}
      >
        <span className="status-seg__icon" aria-hidden="true">▷</span>
        <span className="status-seg__value mono">{metrics.activeWorkflowRuns} runs</span>
      </button>

      <div className="statusbar__spacer" />

      <span
        className="status-evidence mono"
        role="button"
        tabIndex={0}
        title="Latest decision evidence · click to expand"
        onClick={() =>
          onOpenEvidenceTrail
            ? onOpenEvidenceTrail(state.recent)
            : onToast?.(t('evidence.expand', 'Expand decision trail'), 'info')
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            (onOpenEvidenceTrail ?? (() => onToast?.(t('evidence.expand', 'Expand decision trail'), 'info')))(state.recent);
          }
        }}
      >
        <span className="status-evidence__dot" aria-hidden="true" />
        {evidenceText ?? <span className="status-evidence__text">awaiting…</span>}
      </span>

      <button
        className="status-seg"
        type="button"
        title="Data freshness · click to refresh"
        onClick={handleRefresh}
      >
        <span className="status-seg__icon" aria-hidden="true">⟳</span>
        <span className="status-seg__value mono">as of {fmtTimeShort(state.lastSync)}</span>
      </button>

      <button
        className="status-seg"
        type="button"
        title="Keyboard shortcuts (?)"
        onClick={onOpenShortcuts}
      >
        <span className="status-seg__value mono">⌘K · ?</span>
      </button>
    </footer>
  );
}

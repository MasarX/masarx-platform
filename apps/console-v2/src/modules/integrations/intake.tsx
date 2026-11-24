// integrations/intake.tsx — Inbound intake monitor.
// Ports apps/console/demo-v2/assets/js/modules/int-intake-monitor.js to TypeScript/React.
// Backed by: webhook-receiver, marketing-lead-intake, marketing_demo_intake_policy, tenant_signup_requests.
//
// Provenance enrichment (CLAIM-LIFECYCLE-LINK Gap 1):
//   Each `webhook_inbox` row has a `workflow_run_id` that processed it
//   (supabase/migrations/202510110004_webhook_integration.sql:214+). The run
//   in turn produces a `domain_events` row whose `event_type='shipment.*'`
//   carries the resulting `resource_id` (= shipment_id; canonical column
//   naming per supabase/migrations/202511160100_domain_events_core.sql, was
//   `aggregate_id` pre-W14-4). We compose this chain via the pure helper
//   `_inbox-provenance.ts` so operators get a one-click jump from raw inbox
//   row → live shipment in the Operate registry, plus a separate jump to the
//   full trace by correlation id.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { KPICard } from '@/components/KPICard';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn, type DataTableAction } from '@/components/DataTable';
import { Button } from '@/components/Button';
import { pushToast } from '@/components/toastStore';
import {
  useCompleteResourceList,
  useResourceList,
  useResourceListsByFilters,
  useReplayWebhookInbox,
  useRetryWebhookInboxAsNewIntake,
  useForceWebhookInboxStatus,
  useResolveSettings,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useDrawer } from '@/hooks/useOverlay';
import { lookupRow, getLookups, ui_get_resource_v1, ui_list_resource_complete } from '@/lib/api';
import { redactSensitiveText } from '@/lib/operator-redaction';
import type { ChipKind } from '@/components/Chip';
import {
  deriveInboxProvenance,
  buildTraceDeepLink,
  type WorkflowRunLite,
  type DomainEventLite,
  type InboxProvenance,
} from './_inbox-provenance';
import { formatWebhookReplayToast } from './_webhook-replay-outcome';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import { openWorkflowRunContextDrawer } from '@/modules/workflows/workflow-run-context';
import { ExternalIntakeWorkspaceToolbar } from './ExternalIntakeWorkspaceToolbar';
import { fill, useI18n, type Translate } from '@/lib/i18n';

const CONSOLE_LOCATION_CHANGE_EVENT = 'console-v2:locationchange';

function dispatchConsoleLocationChange() {
  window.dispatchEvent(new Event(CONSOLE_LOCATION_CHANGE_EVENT));
}

// Phase G1 schema-drift fix per __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §4:
// Renamed FE fields to canonical column names from public.webhook_inbox:
//   source_id        -> webhook_source_id
//   received_at      -> created_at
//   status           -> processing_status
//   dedupe_key       -> external_id
//   error            -> error_message
// `payload_size` is retained as a derived UI projection — canonical schema
// computes via length(raw_payload::text). `workflow_run_id` is retained as
// a derived UI projection — resolved via domain_events.correlation_id join.
//
// W27 paired projection: `public.v_webhook_inbox_directory`
// (supabase/migrations/202604302510_v_webhook_inbox_directory.sql) now
// materialises payload_size (length(raw_payload::text)), source_label /
// source_identifier / provider_type_label (webhook_sources joins),
// replay_count + force_status_count + last_replay_at + last_replay_action +
// last_replay_actor (replay-ledger joins), is_terminal + is_actionable,
// age_seconds + age_hours under a single read seam.
interface WebhookInboxRow extends Record<string, unknown> {
  id: string;
  webhook_source_id: string;
  created_at: string;
  processing_status: string;
  event_type: string;
  external_id: string;
  // Derived (not canonical columns; populated server-side via projection RPC).
  payload_size?: number;
  workflow_run_id?: string;
  error_message?: string;
  idempotency_key?: string | null;
  ack_outcome?: string | null;
  ack_status_code?: number | null;
  ack_reason?: string | null;
  response_outcome?: string | null;
  response_status_code?: number | null;
  response_reason?: string | null;
  response_mode?: string | null;
}

/**
 * W27 — Canonical projection from `public.v_webhook_inbox_directory`
 * (supabase/migrations/202604302510_v_webhook_inbox_directory.sql).
 * Surfaces source_label / source_identifier / provider_type_label (canonical
 * webhook_sources joins) + replay_count / force_status_count /
 * last_replay_at / last_replay_action / last_replay_actor (replay-ledger
 * joins) + is_terminal / is_actionable (status booleans) + age_seconds /
 * age_hours (now-aware derivation). Production swap stays a single
 * `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('webhook_inbox_directory')`.
 */
interface WebhookInboxDirectoryRow extends Record<string, unknown> {
  id: string;
  source_label?: string | null;
  source_identifier?: string | null;
  provider_type_label?: string | null;
  mapping_config_id?: string | null;
  mapping_label?: string | null;
  mapping_target?: string | null;
  mapping_version?: number | null;
  mapping_rules_count?: number | null;
  shipment_id?: string | null;
  tracking_number?: string | null;
  shipment_status?: string | null;
  workflow_run_status?: string | null;
  idempotency_key?: string | null;
  ack_outcome?: string | null;
  ack_status_code?: number | null;
  ack_reason?: string | null;
  response_outcome?: string | null;
  response_status_code?: number | null;
  response_reason?: string | null;
  response_mode?: string | null;
  payload_size?: number;
  replay_count?: number;
  force_status_count?: number;
  last_replay_at?: string | null;
  last_replay_action?: string | null;
  last_replay_actor?: string | null;
  is_terminal?: boolean;
  is_actionable?: boolean;
  age_seconds?: number;
  age_hours?: number;
}

interface WebhookAuthRejectionRow extends Record<string, unknown> {
  id: string;
  service: 'webhook_receiver';
  credential_kind?: string | null;
  failure_code: string;
  failure_message?: string | null;
  http_status: number;
  organization_id?: string | null;
  source_id?: string | null;
  source_label?: string | null;
  source_identifier?: string | null;
  client_id?: string | null;
  client_label?: string | null;
  sender_id?: string | null;
  sender_label?: string | null;
  correlation_id?: string | null;
  request_id?: string | null;
  method?: string | null;
  path?: string | null;
  token_fingerprint?: string | null;
  request_headers?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  occurred_at: string;
  source_resolved?: boolean | null;
}

interface IntakeActionReadback {
  actionLabel: string;
  eventId: string;
  processingStatus: string;
  replayCount: number;
  forceStatusCount: number;
  lastReplayAction?: string | null;
  lastReplayActor?: string | null;
  lastReplayAt?: string | null;
  newInboxId?: string | null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function inboxRowFromDirectory(row: WebhookInboxDirectoryRow): WebhookInboxRow {
  const record = row as Record<string, unknown>;
  return {
    ...row,
    id: row.id,
    webhook_source_id: readOptionalString(record, 'webhook_source_id') ?? '',
    created_at:
      readOptionalString(record, 'created_at') ??
      readOptionalString(record, 'processed_at') ??
      new Date(0).toISOString(),
    processing_status: readOptionalString(record, 'processing_status') ?? 'pending',
    event_type:
      readOptionalString(record, 'event_type') ??
      readOptionalString(record, 'canonical_intent') ??
      'webhook.event',
    external_id: readOptionalString(record, 'external_id') ?? row.id,
    workflow_run_id: readOptionalString(record, 'workflow_run_id') ?? undefined,
    payload_size: typeof row.payload_size === 'number' ? row.payload_size : undefined,
  };
}

// Synthetic marketing intake events (data lives in legacy demo intake.js).
// We synthesize a representative slice here so the React module is functional without
// requiring a new resource registration in the data-source.
interface MarketingIntakeEvent extends Record<string, unknown> {
  id: string;
  received_at: string;
  email: string;
  company?: string | null;
  volume?: string | null;
  role?: string | null;
  source?: string | null;
  ip_hash: string;
  turnstile_status: string;
  dedupe_status: string;
  rate_limit_status: string;
  decision: string;
  task_id?: string | null;
  workflow_run_id?: string | null;
  dispatch_id?: string | null;
  task_status?: string | null;
}

// W31 (G5) — SAMPLE_INTAKE_EVENTS + INTAKE_METRICS_24H removed. The
// canonical projections `marketing_intake_recent` +
// `marketing_intake_metrics_24h` resolve via `useResourceList(...)` from
// `data-source.ts` (which mirrors the `marketing_intake_recent_v1` view +
// 24h aggregation in cloud mode and the canonical seed-raw rows in
// in-memory mode).

// Strict canonical-tone chip helpers. Tone + label resolve through canonical
// lookup categories (`turnstile_status`, `dedupe_status`, `rate_limit_status`,
// `marketing_decision`, `processing_status`, `workflow_run_status`). Missing
// canonical rows render danger-toned `(missing)` chips so operators see the
// seed gap rather than a silent neutral default. AGENTS.md §2 (ZERO
// HARDCODING) + §4 (SSOT): no inline tone ternaries — every domain enum →
// presentation tone mapping delegates to `lookupRow`.
function lookupCategoryLabels(t: Translate): Record<string, string> {
  return {
    turnstile_status: t('integrationsIntake.lookupCategory.turnstileStatus'),
    dedupe_status: t('integrationsIntake.lookupCategory.dedupeStatus'),
    rate_limit_status: t('integrationsIntake.lookupCategory.rateLimitStatus'),
    marketing_decision: t('integrationsIntake.lookupCategory.marketingDecision'),
    processing_status: t('integrationsIntake.lookupCategory.processingStatus'),
    workflow_run_status: t('integrationsIntake.lookupCategory.workflowRunStatus'),
  };
}

function CanonicalChip({ category, value }: { category: string; value: string }) {
  const { t } = useI18n();
  const row = lookupRow(category, value);
  return row ? (
    <Chip label={row.label ?? value} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />
  ) : (
    <Chip label={fill(t('integrationsIntake.canonicalChip.unknown'), { category: lookupCategoryLabels(t)[category] ?? t('integrationsIntake.lookupCategory.status'), value: String(value) })} kind="danger" size="xs" />
  );
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

function humanizeWebhookOutcome(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'No acknowledgement yet';
  if (raw === 'ack_replayed' || raw === 'response_replayed') return 'Duplicate replayed';
  return raw
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function receiverOutcomeTone(value: unknown): ChipKind {
  const raw = String(value ?? '').trim();
  if (raw === 'ack_replayed' || raw === 'response_replayed') return 'warn';
  if (raw === 'ack_sent' || raw === 'accepted') return 'good';
  if (raw.includes('failed') || raw.includes('rejected') || raw.includes('invalid')) return 'danger';
  return raw ? 'info' : 'neutral';
}

function receiverOutcomeValue(row: Partial<WebhookInboxDirectoryRow>): unknown {
  return row.ack_outcome ?? row.response_outcome;
}

function receiverStatusCode(row: Partial<WebhookInboxDirectoryRow>): number | null {
  return row.ack_status_code ?? row.response_status_code ?? null;
}

function receiverReason(row: Partial<WebhookInboxDirectoryRow>): string | null {
  return row.ack_reason ?? row.response_reason ?? null;
}

function ReceiverOutcomeCell({ row }: { row: Partial<WebhookInboxDirectoryRow> }) {
  const outcome = receiverOutcomeValue(row);
  const idempotencyKey = row.idempotency_key;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <Chip label={humanizeWebhookOutcome(outcome)} kind={receiverOutcomeTone(outcome)} size="xs" />
      {idempotencyKey ? (
        <span className="mono" style={{ color: 'var(--ink-3)' }}>
          {operatorReference('Idempotency', idempotencyKey)}
        </span>
      ) : null}
    </span>
  );
}

function replayLedgerCount(row: Partial<WebhookInboxDirectoryRow>): number {
  const value = Number(row.replay_count ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function replayLedgerAction(row: Partial<WebhookInboxDirectoryRow>): string {
  return typeof row.last_replay_action === 'string' ? row.last_replay_action.trim() : '';
}

function replayLedgerTimestamp(row: Partial<WebhookInboxDirectoryRow>): string {
  return typeof row.last_replay_at === 'string' ? row.last_replay_at.trim() : '';
}

function ReplayLedgerCell({ row }: { row: Partial<WebhookInboxDirectoryRow> }) {
  const { t } = useI18n();
  const replayCount = replayLedgerCount(row);
  const ledgerDetails = [row.last_replay_action, row.last_replay_actor, row.last_replay_at]
    .filter(Boolean)
    .join(' · ');
  if (!Number.isFinite(replayCount) || replayCount <= 0) {
    if (ledgerDetails) {
      return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
          <Chip label={t('integrationsIntake.replayLedgerCell.ledgerUpdate')} kind="info" size="xs" />
          <span className="mono" style={{ color: 'var(--ink-3)' }}>
            {ledgerDetails}
          </span>
        </span>
      );
    }
    return <span className="mono" style={{ color: 'var(--ink-3)' }}>{t('integrationsIntake.replayLedgerCell.noReplay')}</span>;
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <Chip label={fill(t(replayCount === 1 ? 'integrationsIntake.replayLedgerCell.replayOne' : 'integrationsIntake.replayLedgerCell.replayOther'), { replayCount: String(replayCount) })} kind="info" size="xs" />
      <span className="mono" style={{ color: 'var(--ink-3)' }}>
        {ledgerDetails}
      </span>
    </span>
  );
}

function sourceReference(row: WebhookInboxRow & Partial<WebhookInboxDirectoryRow>): string {
  return operatorReference('Source', row.source_identifier ?? row.webhook_source_id);
}

function ShipmentReferenceButton({
  shipmentId,
  onOpen,
  testId,
}: {
  shipmentId: string;
  onOpen: (shipmentId: string) => void;
  testId: string;
}) {
  const { t } = useI18n();
  const openContext = () => onOpen(shipmentId);
  return (
    <Button
      className="mono"
      testId={testId}
      iconName="package"
      kind="ghost"
      size="sm"
      label={operatorReference('Shipment', shipmentId)}
      title={fill(t('integrationsIntake.shipmentReferenceButton.openContext'), { value: String(operatorReference('Shipment', shipmentId)) })}
      onClick={(event) => {
        event.stopPropagation();
        openContext();
      }}
    />
  );
}

// Canonical-tone chip for marketing intake decisions. Tone + label resolve
// strictly through the `marketing_decision` lookup category (mirrors
// marketing_demo_intake_policy decision outcomes). Missing canonical row
// renders a danger-toned `(missing)` chip rather than a silent default.
function DecisionChip({ value }: { value: string }) {
  return <CanonicalChip category="marketing_decision" value={value} />;
}

function marketingColumns(t: Translate): Array<DataTableColumn<MarketingIntakeEvent>> {
  return [
    { key: 'received_at', label: t('integrationsIntake.marketingColumns.when'), format: 'datetime', sortable: true },
    {
      key: 'company',
      label: t('integrationsIntake.marketingColumns.company'),
      sortable: true,
      filterable: true,
      render: (raw, row) => (
        <span>
          <span style={{ fontWeight: 500 }}>{String(raw ?? t('integrationsIntake.marketingColumns.unknownCompany'))}</span>
          {row.role ? <span style={{ color: 'var(--ink-3)' }}> - {row.role}</span> : null}
        </span>
      ),
    },
    { key: 'email', label: t('integrationsIntake.marketingColumns.email'), sortable: true, filterable: true },
    { key: 'ip_hash', label: t('integrationsIntake.marketingColumns.ipHash'), mono: true },
    {
      key: 'turnstile_status',
      label: t('integrationsIntake.marketingColumns.turnstile'),
      sortable: true,
      filterable: true,
      render: (raw) => <CanonicalChip category="turnstile_status" value={String(raw)} />,
    },
    {
      key: 'dedupe_status',
      label: t('integrationsIntake.marketingColumns.dedupe'),
      sortable: true,
      filterable: true,
      render: (raw) => <CanonicalChip category="dedupe_status" value={String(raw)} />,
    },
    {
      key: 'rate_limit_status',
      label: t('integrationsIntake.marketingColumns.rate'),
      sortable: true,
      filterable: true,
      render: (raw) => <CanonicalChip category="rate_limit_status" value={String(raw)} />,
    },
    {
      key: 'decision',
      label: t('integrationsIntake.marketingColumns.decision'),
      sortable: true,
      filterable: true,
      render: (raw) => <DecisionChip value={String(raw)} />,
    },
    {
      key: 'task_id',
      label: t('integrationsIntake.marketingColumns.followUp'),
      sortable: true,
      render: (_raw, row) => {
        const taskId = readOptionalString(row, 'task_id');
        const workflowRunId = readOptionalString(row, 'workflow_run_id');
        const dispatchId = readOptionalString(row, 'dispatch_id');
        if (!taskId && !workflowRunId && !dispatchId) {
          return <span className="mono" style={{ color: 'var(--ink-3)' }}>{t('integrationsIntake.marketingColumns.pendingLineage')}</span>;
        }
        return (
          <span className="mono">
            {taskId ? operatorReference('Task', taskId) : t('integrationsIntake.marketingColumns.taskPending')}
            {workflowRunId ? ` - ${operatorReference('Workflow', workflowRunId)}` : ''}
            {dispatchId ? ` - ${operatorReference('Dispatch', dispatchId)}` : ''}
          </span>
        );
      },
    },
  ];
}

const WEBHOOK_INBOX_SEARCH_KEYS = [
  'id',
  'webhook_source_id',
  'source_label',
  'source_identifier',
  'provider_type_label',
  'mapping_config_id',
  'mapping_label',
  'mapping_target',
  'event_type',
  'external_id',
  'idempotency_key',
  'ack_outcome',
  'response_outcome',
  'processing_status',
  'workflow_run_id',
  'shipment_id',
  'tracking_number',
] as const;

export function IntakeModule() {
  const { t } = useI18n();
  const marketingCols = useMemo(() => marketingColumns(t), [t]);
  // CLAIM-INTEGRATIONS-WORKFLOWS-WIRING (Phase C5): Retry now routes through
  // the canonical `webhook_inbox_replay_v1` (resets processing_status +
  // re-enqueues the worker). Force-status routes to `webhook_inbox_force_status_v1`
  // for triage. Both close the audit gap §3 P0 'webhook_inbox Replay +
  // Force-status missing' and §4 P1 'integrations.retry_inbox is mock-only'.
  const navigate = useNavigate();
  const go = useConsoleNavigator();
  const canRead = useCapability(CAP.WEBHOOKS_READ);
  const canReadWorkflows = useCapability(CAP.WORKFLOWS_READ);
  const { scope } = useIdentity();
  const tenantId = scope.tenant?.id ?? null;
  const [focusedInboxId, setFocusedInboxId] = useState(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('inbox_id');
  });
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const authRejectionListOpts = useMemo(
    () => ({ sort: { key: 'occurred_at', dir: 'desc' as const }, page_size: 50 }),
    [],
  );
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const liveTailPolicy = useResolveSettings('live_tail_policy', undefined, readQueryOptions);
  const liveTailPolicyValue = liveTailPolicy.data?.value as
    | {
        api_gateway_synthesizer_interval_ms?: number;
        marketing_intake_refetch_interval_ms?: number;
        webhook_inbox_refetch_interval_ms?: number;
        webhook_auth_rejection_refetch_interval_ms?: number;
      }
    | undefined;
  const authRejectionRefreshIntervalMs =
    liveTailPolicyValue?.webhook_auth_rejection_refetch_interval_ms ??
    liveTailPolicyValue?.api_gateway_synthesizer_interval_ms;
  const marketingIntakeRefreshIntervalMs =
    liveTailPolicyValue?.marketing_intake_refetch_interval_ms ??
    liveTailPolicyValue?.webhook_auth_rejection_refetch_interval_ms ??
    liveTailPolicyValue?.api_gateway_synthesizer_interval_ms;
  const webhookInboxRefreshIntervalMs =
    liveTailPolicyValue?.webhook_inbox_refetch_interval_ms ??
    liveTailPolicyValue?.api_gateway_synthesizer_interval_ms;
  const webhookInboxReadQueryOptions = useMemo(
    () => ({
      enabled: canRead,
      staleTime: 0,
      refetchOnMount: 'always' as const,
      refetchInterval: webhookInboxRefreshIntervalMs,
      refetchIntervalInBackground: Boolean(webhookInboxRefreshIntervalMs),
    }),
    [canRead, webhookInboxRefreshIntervalMs],
  );
  const authRejectionReadQueryOptions = useMemo(
    () => ({
      enabled: canRead,
      staleTime: 0,
      refetchOnMount: 'always' as const,
    }),
    [canRead],
  );
  // AGENTS.md §2/§3 (W31/G5): canonical marketing intake recent + 24h
  // metrics resolve via `useResourceList`. NO inline SAMPLE_INTAKE_EVENTS
  // / INTAKE_METRICS_24H constants — the canonical projections live in
  // `data-source.ts` (mirrors `marketing_intake_recent_v1` view +
  // `marketing_intake_metrics_24h` aggregation).
  const intakeRecentQuery = useResourceList<MarketingIntakeEvent>('marketing_intake_recent', undefined, readQueryOptions);
  const intakeMetricsQuery = useResourceList<{ total: number; verified: number; turnstile_failed: number; rate_limited: number; dedupe_dropped: number }>('marketing_intake_metrics_24h', undefined, readQueryOptions);
  const intakeRecent = intakeRecentQuery.data?.rows ?? [];
  const intakeMetrics = intakeMetricsQuery.data?.rows?.[0];
  // W27 — paired projection view `public.v_webhook_inbox_directory`
  // (supabase/migrations/202604302510_v_webhook_inbox_directory.sql).
  // Surfaces source_label / source_identifier + replay-ledger counters +
  // is_terminal / is_actionable + age_seconds. Production swap stays a single
  // `getSupabaseClient()` branch in
  // `data-source.ts:ui_list_resource_v1('webhook_inbox_directory')`.
  const inboxDirectoryQuery =
    useCompleteResourceList<WebhookInboxDirectoryRow>('webhook_inbox_directory', tenantListOpts, webhookInboxReadQueryOptions);
  const authRejectionsQuery =
    useCompleteResourceList<WebhookAuthRejectionRow>('webhook_auth_rejections', authRejectionListOpts, authRejectionReadQueryOptions);
  const focusedInboxDirectoryQuery = useResourceList<WebhookInboxDirectoryRow>(
    'webhook_inbox_directory',
    focusedInboxId ? { filter: { id: focusedInboxId }, page_size: 1 } : undefined,
    { enabled: Boolean(canRead && focusedInboxId) },
  );
  const replayInbox = useReplayWebhookInbox();
  const retryInboxAsNewIntake = useRetryWebhookInboxAsNewIntake();
  const forceInboxStatus = useForceWebhookInboxStatus();
  const drawer = useDrawer();
  const autoOpenedInboxId = useRef<string | null>(null);
  const [intakeActionReadback, setIntakeActionReadback] = useState<IntakeActionReadback | null>(null);

  useEffect(() => {
    if (!canRead || !authRejectionRefreshIntervalMs) return undefined;

    const refetchAuthRejections = () => {
      void authRejectionsQuery.refetch();
    };

    refetchAuthRejections();
    const id = window.setInterval(refetchAuthRejections, authRejectionRefreshIntervalMs);
    return () => window.clearInterval(id);
  }, [authRejectionRefreshIntervalMs, authRejectionsQuery.refetch, canRead]);

  useEffect(() => {
    if (!canRead || !marketingIntakeRefreshIntervalMs) return undefined;

    const refetchMarketingIntake = () => {
      void intakeRecentQuery.refetch();
      void intakeMetricsQuery.refetch();
    };

    refetchMarketingIntake();
    const id = window.setInterval(refetchMarketingIntake, marketingIntakeRefreshIntervalMs);
    return () => window.clearInterval(id);
  }, [
    canRead,
    intakeMetricsQuery.refetch,
    intakeRecentQuery.refetch,
    marketingIntakeRefreshIntervalMs,
  ]);

  // Memoize each list against the underlying query result so the provenance
  // derivation downstream doesn't re-run when an unrelated render happens.
  const rawInbox = useMemo(() => {
    const merged = new Map<string, WebhookInboxRow>();
    for (const row of (inboxDirectoryQuery.data?.rows ?? []) as WebhookInboxDirectoryRow[]) {
      merged.set(row.id, inboxRowFromDirectory(row));
    }
    for (const row of (focusedInboxDirectoryQuery.data?.rows ?? []) as WebhookInboxDirectoryRow[]) {
      if (!merged.has(row.id)) merged.set(row.id, inboxRowFromDirectory(row));
    }
    return Array.from(merged.values());
  }, [inboxDirectoryQuery.data, focusedInboxDirectoryQuery.data]);
  const workflowRunFilters = useMemo(() => {
    const ids = Array.from(
      new Set(
        rawInbox
          .map((row) => row.workflow_run_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    return ids.map((id) => ({ id }));
  }, [rawInbox]);
  // Provenance derivation reads only the workflow/domain rows referenced by
  // the tenant-scoped inbox, preventing broad cross-tenant history reads.
  const runsQuery = useResourceListsByFilters<WorkflowRunLite>(
    'workflow_run_directory',
    workflowRunFilters,
    { page_size: 1 },
    { enabled: canRead && canReadWorkflows && workflowRunFilters.length > 0, retry: false },
  );
  const eventsQuery = useResourceListsByFilters<DomainEventLite>(
    'domain_events',
    workflowRunFilters.map((filter) => ({ workflow_run_id: filter.id })),
    { page_size: 25 },
    { enabled: canRead && canReadWorkflows && workflowRunFilters.length > 0, retry: false },
  );
  const refreshWebhookInbox = useCallback(async () => {
    const [directoryReadback, focusedReadback] = await Promise.all([
      inboxDirectoryQuery.refetch(),
      focusedInboxDirectoryQuery.refetch(),
      runsQuery.refetch(),
      eventsQuery.refetch(),
    ]);
    const rows = new Map<string, WebhookInboxDirectoryRow>();
    for (const row of directoryReadback.data?.rows ?? []) {
      rows.set(row.id, row);
    }
    for (const row of focusedReadback.data?.rows ?? []) {
      rows.set(row.id, row);
    }
    return Array.from(rows.values());
  }, [eventsQuery, focusedInboxDirectoryQuery, inboxDirectoryQuery, runsQuery]);

  async function requireInboxDirectoryReadback(
    inboxId: string,
    check: (row: WebhookInboxDirectoryRow) => string | null,
  ): Promise<WebhookInboxDirectoryRow> {
    const rows = await refreshWebhookInbox();
    const readback = rows.find((row) => row.id === inboxId);
    if (!readback) {
      throw new Error(`Webhook inbox ${inboxId} is not readable from the backend directory.`);
    }
    const mismatch = check(readback);
    if (mismatch) {
      throw new Error(`Webhook inbox ${inboxId} confirmation did not ${mismatch}.`);
    }
    return readback;
  }

  async function requireReplayReadback(
    row: WebhookInboxRow,
    result: Record<string, unknown>,
    previousReplayCount: number,
  ): Promise<WebhookInboxDirectoryRow> {
    const replayQueued = result.replay_queued === true;
    return requireInboxDirectoryReadback(row.id, (readback) => {
      const nextReplayCount = replayLedgerCount(readback);
      if (!replayQueued) {
        const preservedStatus = String(result.preserved_status ?? row.processing_status ?? '').trim();
        if (preservedStatus && readback.processing_status !== preservedStatus) {
          return `preserve status ${preservedStatus}`;
        }
        return nextReplayCount > previousReplayCount ? null : 'show replay ledger increment';
      }
      return nextReplayCount > previousReplayCount ? null : 'show replay ledger increment';
    });
  }

  async function executeReplayInboxEvent(
    row: WebhookInboxRow,
    reason: 'operator_retry' | 'operator_replay',
    label: 'Retry' | 'Replay',
    refreshOpenProvenance = false,
  ) {
    const previousReplayCount = Number((row as Partial<WebhookInboxDirectoryRow>).replay_count ?? 0);
    const result = await replayInbox.mutateAsync({ webhook_inbox_id: row.id, reason });
    const readback = await requireReplayReadback(row, result, previousReplayCount);
    if (refreshOpenProvenance) {
      openProvenanceDrawer(readback as WebhookInboxRow);
    }
    setIntakeActionReadback({
      actionLabel: label,
      eventId: row.id,
      processingStatus: String(readback.processing_status ?? row.processing_status ?? 'pending'),
      replayCount: Number(readback.replay_count ?? 0),
      forceStatusCount: Number(readback.force_status_count ?? 0),
      lastReplayAction: readback.last_replay_action ?? null,
      lastReplayActor: readback.last_replay_actor ?? null,
      lastReplayAt: readback.last_replay_at ?? null,
    });
    const toast = formatWebhookReplayToast(label, result, operatorReference('Event', row.id));
    pushToast(toast.message, toast.tone);
  }

  async function requireForceStatusReadback(
    row: WebhookInboxRow,
    targetStatus: string,
    previousForceStatusCount: number,
  ): Promise<WebhookInboxDirectoryRow> {
    return requireInboxDirectoryReadback(row.id, (readback) => {
      if (String(readback.processing_status ?? '') !== targetStatus) {
        return `reflect forced status ${targetStatus}`;
      }
      const nextForceStatusCount = Number(readback.force_status_count ?? 0);
      return nextForceStatusCount > previousForceStatusCount
        ? null
        : 'show force-status ledger increment';
    });
  }

  async function requireFreshIntakeReadback(
    row: WebhookInboxRow,
    result: Record<string, unknown>,
    previousLastReplayAt: string,
  ): Promise<WebhookInboxDirectoryRow> {
    const newInboxId = typeof result.new_webhook_inbox_id === 'string' && result.new_webhook_inbox_id.trim()
      ? result.new_webhook_inbox_id.trim()
      : null;
    if (newInboxId) {
      return requireInboxDirectoryReadback(newInboxId, (readback) =>
        readback.id === newInboxId ? null : 'show the fresh intake row',
      );
    }
    return requireInboxDirectoryReadback(row.id, (readback) => {
      const action = replayLedgerAction(readback);
      const lastReplayAt = replayLedgerTimestamp(readback);
      return action === 'retry_as_new_intake' && lastReplayAt && lastReplayAt !== previousLastReplayAt
        ? null
        : 'show a new retry-as-new-intake remediation ledger';
    });
  }
  const inboxDirectoryById = useMemo(() => {
    const map = new Map<string, WebhookInboxDirectoryRow>();
    for (const r of inboxDirectoryQuery.data?.rows ?? []) {
      map.set(r.id, r);
    }
    for (const r of focusedInboxDirectoryQuery.data?.rows ?? []) {
      map.set(r.id, r);
    }
    return map;
  }, [inboxDirectoryQuery.data, focusedInboxDirectoryQuery.data]);
  // W27 — decorate inbox rows with projection-derived fields when available.
  const inbox = useMemo(
    () =>
      rawInbox.map((r) => {
        const proj = inboxDirectoryById.get(r.id);
        if (!proj) return r;
        return {
          ...r,
          source_label: proj.source_label ?? null,
          source_identifier: proj.source_identifier ?? null,
          provider_type_label: proj.provider_type_label ?? null,
          mapping_config_id: proj.mapping_config_id ?? null,
          mapping_label: proj.mapping_label ?? null,
          mapping_target: proj.mapping_target ?? null,
          mapping_version: proj.mapping_version ?? null,
          mapping_rules_count: proj.mapping_rules_count ?? null,
          replay_count: proj.replay_count ?? 0,
          force_status_count: proj.force_status_count ?? 0,
          last_replay_at: proj.last_replay_at ?? null,
          last_replay_action: proj.last_replay_action ?? null,
          last_replay_actor: proj.last_replay_actor ?? null,
          shipment_id: proj.shipment_id ?? null,
          tracking_number: proj.tracking_number ?? null,
          shipment_status: proj.shipment_status ?? null,
          workflow_run_status: proj.workflow_run_status ?? null,
          idempotency_key: proj.idempotency_key ?? r.idempotency_key ?? null,
          ack_outcome: proj.ack_outcome ?? proj.response_outcome ?? r.ack_outcome ?? null,
          ack_status_code: proj.ack_status_code ?? proj.response_status_code ?? r.ack_status_code ?? null,
          ack_reason: proj.ack_reason ?? proj.response_reason ?? r.ack_reason ?? null,
          response_outcome: proj.response_outcome ?? r.response_outcome ?? null,
          response_status_code: proj.response_status_code ?? r.response_status_code ?? null,
          response_reason: proj.response_reason ?? r.response_reason ?? null,
          response_mode: proj.response_mode ?? r.response_mode ?? null,
          is_terminal: proj.is_terminal ?? false,
          is_actionable: proj.is_actionable ?? true,
          age_seconds: proj.age_seconds ?? 0,
          age_hours: proj.age_hours ?? 0,
          // Prefer projection's payload_size when available.
          payload_size: proj.payload_size ?? r.payload_size,
        } as WebhookInboxRow & WebhookInboxDirectoryRow;
      }),
    [rawInbox, inboxDirectoryById],
  );
  const authRejections = useMemo(
    () => (authRejectionsQuery.data?.rows ?? []) as WebhookAuthRejectionRow[],
    [authRejectionsQuery.data],
  );
  const runs = useMemo(() => (runsQuery.data?.rows ?? []) as WorkflowRunLite[], [runsQuery.data]);
  const events = useMemo(() => (eventsQuery.data?.rows ?? []) as DomainEventLite[], [eventsQuery.data]);

  // Pure derivation: one provenance record per inbox row, indexed by id so
  // the column renderer is O(1).
  const provenanceByInboxId = useMemo<Record<string, InboxProvenance>>(() => {
    const out: Record<string, InboxProvenance> = {};
    for (const row of inbox) {
      out[row.id] = deriveInboxProvenance(row, runs, events);
    }
    return out;
  }, [inbox, runs, events]);

  function openShipmentContext(shipmentId: string) {
    openShipmentContextDrawer(drawer, shipmentId);
  }

  function openMappingContext(mappingConfigId: string, inboxId?: string | null) {
    const path =
      `/integrations/mapping?focus=${encodeURIComponent(mappingConfigId)}${inboxId ? `&inbox_id=${encodeURIComponent(inboxId)}` : ''}`;
    try {
      void navigate({
        to: '/integrations/mapping',
        search: { focus: mappingConfigId, ...(inboxId ? { inbox_id: inboxId } : {}) } as never,
      })
        .then(dispatchConsoleLocationChange)
        .catch(() => {
          go(path);
          queueMicrotask(dispatchConsoleLocationChange);
        });
    } catch {
      go(path);
      queueMicrotask(dispatchConsoleLocationChange);
    }
  }

  function openProvenanceDrawer(row: WebhookInboxRow) {
    setFocusedInboxId(row.id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('inbox_id', row.id);
      window.history.replaceState(window.history.state ?? {}, '', `${url.pathname}${url.search}${url.hash}`);
    }
    const prov = provenanceByInboxId[row.id] ?? deriveInboxProvenance(row, runs, events);
    drawer.open({
      title: fill(t('integrationsIntake.intakeModule.event'), { value: String(operatorReference('Event', row.id)) }),
      size: 'md',
      body: (
        <ProvenanceDrawerBody
          row={row}
          prov={prov ?? null}
          onOpenShipment={openShipmentContext}
          onOpenMapping={openMappingContext}
        />
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <Button
            label={t('integrationsIntake.intakeModule.retryInbox')}
            iconName="refresh"
            kind="ghost"
            capability={CAP.WEBHOOKS_WRITE}
            disabled={replayInbox.isPending}
            onClick={() => {
              void executeReplayInboxEvent(row, 'operator_retry', 'Retry', true).catch((err) => {
                pushToast(fill(t('integrationsIntake.intakeModule.retryFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
              });
            }}
          />
          <Button
            label={t('integrationsIntake.intakeModule.replayInbox')}
            iconName="rotate"
            kind="ghost"
            capability={CAP.WEBHOOKS_WRITE}
            disabled={replayInbox.isPending}
            onClick={() => {
              void executeReplayInboxEvent(row, 'operator_replay', 'Replay', true).catch((err) => {
                pushToast(fill(t('integrationsIntake.intakeModule.replayFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
              });
            }}
          />
          <Button
            label={t('integrationsIntake.intakeModule.openActivity')}
            iconName="trace_tree"
            kind="ghost"
            onClick={() => {
              if (!prov?.correlation_id) {
                pushToast(t('integrationsIntake.intakeModule.noActivityLinkYet'), 'warn');
                return;
              }
              navigate({ to: '/insights/traces', search: { cor: prov.correlation_id } as never }).catch(() => {
                go(buildTraceDeepLink(prov.correlation_id!));
              });
            }}
          />
          <div style={{ flex: 1 }} />
          {prov?.shipment_id ? (
            <Button
              label={t('integrationsIntake.intakeModule.openShipment')}
              iconName="package"
              kind="primary"
              onClick={() => {
                openShipmentContext(prov.shipment_id!);
              }}
            />
          ) : null}
        </div>
      ),
    });
  }

  async function openWorkflowRunContext(row: WebhookInboxRow) {
    const prov = provenanceByInboxId[row.id];
    const rowProjection = row as Partial<WebhookInboxDirectoryRow>;
    const workflowRunId =
      typeof row.workflow_run_id === 'string' && row.workflow_run_id.trim()
        ? row.workflow_run_id.trim()
        : typeof rowProjection.workflow_run_id === 'string' && rowProjection.workflow_run_id.trim()
        ? rowProjection.workflow_run_id.trim()
        : null;
    const run = prov?.workflow_run ?? runs.find((candidate) => candidate.id === workflowRunId) ?? null;
    if (!workflowRunId) {
      pushToast(t('integrationsIntake.intakeModule.noWorkflowRunReference'), 'warn');
      return;
    }
    let latestRun = run;
    let latestEvents = events.filter((event) => event.workflow_run_id === workflowRunId);
    try {
      const [runReadback, eventReadback] = await Promise.all([
        ui_list_resource_complete<WorkflowRunLite>('workflow_run_directory', {
          filter: { id: workflowRunId },
          page_size: 1,
        }),
        ui_list_resource_complete<DomainEventLite>('domain_events', {
          filter: { workflow_run_id: workflowRunId },
          page_size: 25,
        }),
      ]);
      latestRun = (runReadback.rows?.[0] ?? latestRun) as WorkflowRunLite | null;
      latestEvents = eventReadback.rows ?? [];
    } catch (err) {
      pushToast((err as Error)?.message ?? t('integrationsIntake.intakeModule.workflowActivityContextUnavailable'), 'warn');
    }
    openWorkflowRunContextDrawer(drawer, {
      workflowRunId,
      run: latestRun,
      events: latestEvents,
      contextRows: [
        {
          label: t('integrationsIntake.intakeModule.inboxEvent'),
          value: (
            <>
              {operatorReference('Event', row.id)} · <CanonicalChip category="processing_status" value={row.processing_status} />
            </>
          ),
        },
        { label: t('integrationsIntake.intakeModule.receiverOutcome'), value: <ReceiverOutcomeCell row={rowProjection} /> },
        {
          label: t('integrationsIntake.intakeModule.mapping'),
          value: rowProjection.mapping_label ?? rowProjection.mapping_config_id ?? 'pending confirmation',
        },
      ],
      deepLink: `/workflows/runs?focus=${encodeURIComponent(workflowRunId)}`,
      onOpenTrace: prov?.correlation_id
        ? () => {
            navigate({ to: '/insights/traces', search: { cor: prov.correlation_id } as never }).catch(() => {
              go(buildTraceDeepLink(prov.correlation_id!));
            });
          }
        : null,
      onOpenWorkflowModule: () => {
        go(`/workflows/runs?focus=${encodeURIComponent(workflowRunId)}`);
      },
    });
  }

  async function openAuthRejectionDrawer(row: WebhookAuthRejectionRow) {
    let latest: WebhookAuthRejectionRow;
    try {
      const readback = await ui_get_resource_v1<WebhookAuthRejectionRow>('webhook_auth_rejections', row.id);
      if (!readback?.id || readback.id !== row.id) {
        throw new Error('Rejected access confirmation did not return the selected record.');
      }
      latest = readback;
    } catch (err) {
      pushToast((err as Error)?.message ?? t('integrationsIntake.intakeModule.rejectedAccessConfirmationUnavailable'), 'danger');
      return;
    }
    drawer.open({
      title: t('integrationsIntake.intakeModule.rejectedWebhookRequest'),
      size: 'md',
      body: <WebhookAuthRejectionDrawerBody row={latest} />,
    });
  }

  useEffect(() => {
    if (!focusedInboxId || autoOpenedInboxId.current === focusedInboxId) return;
    if (!focusedInboxDirectoryQuery.isFetched && !inboxDirectoryById.has(focusedInboxId)) return;
    const row = inbox.find((item) => item.id === focusedInboxId);
    if (!row) return;
    autoOpenedInboxId.current = focusedInboxId;
    openProvenanceDrawer(row);
  }, [focusedInboxId, focusedInboxDirectoryQuery.isFetched, inbox, inboxDirectoryById, provenanceByInboxId]);

  const inboxColumns: Array<DataTableColumn<WebhookInboxRow>> = [
    { key: 'created_at', label: t('integrationsIntake.intakeModule.when'), format: 'datetime', sortable: true },
    {
      key: 'webhook_source_id',
      label: t('integrationsIntake.intakeModule.source'),
      sortable: true,
      filterable: true,
      // W27 — prefer projection-derived source_label (canonical join from
      // v_webhook_inbox_directory) over raw webhook_source_id when available.
      render: (raw, row) => {
        const sourceLabel = (row as { source_label?: string | null }).source_label;
        const providerLabel = (row as { provider_type_label?: string | null }).provider_type_label;
        const ref = sourceReference(row as WebhookInboxRow & Partial<WebhookInboxDirectoryRow>);
        if (sourceLabel) {
          return (
            <span>
              <span style={{ fontWeight: 500 }}>{sourceLabel}</span>{' '}
              {providerLabel ? (
                <span style={{ color: 'var(--ink-3)' }}>{providerLabel} </span>
              ) : null}
              <span className="mono" style={{ color: 'var(--ink-3)' }}>
                · {ref}
              </span>
            </span>
          );
        }
        return <span className="mono">{ref}</span>;
      },
    },
    {
      key: 'mapping_config_id',
      label: t('integrationsIntake.intakeModule.mapping'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => {
        const mappingLabel = (row as { mapping_label?: string | null }).mapping_label;
        const mappingTarget = (row as { mapping_target?: string | null }).mapping_target;
        const mappingId = (row as { mapping_config_id?: string | null }).mapping_config_id;
        if (!mappingLabel && !mappingTarget && !mappingId) {
          return <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>;
        }
        return (
          <span>
            <span className="mono">{mappingLabel ?? operatorReference('Mapping', mappingId)}</span>
            {mappingTarget ? (
              <span className="mono" style={{ color: 'var(--ink-3)' }}> · {mappingTarget}</span>
            ) : null}
          </span>
        );
      },
    },
    { key: 'event_type', label: t('integrationsIntake.intakeModule.event2'), sortable: true, filterable: true },
    { key: 'payload_size', label: t('integrationsIntake.intakeModule.size'), align: 'right', sortable: true },
    {
      key: 'external_id',
      label: t('integrationsIntake.intakeModule.externalReference'),
      mono: true,
      render: (raw) => <span className="mono">{operatorReference('External', raw)}</span>,
    },
    {
      key: 'ack_outcome',
      label: t('integrationsIntake.intakeModule.receiverOutcome'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => <ReceiverOutcomeCell row={row as Partial<WebhookInboxDirectoryRow>} />,
    },
    {
      key: 'replay_count',
      label: t('integrationsIntake.intakeModule.replay'),
      align: 'right',
      sortable: true,
      render: (_raw, row) => <ReplayLedgerCell row={row as Partial<WebhookInboxDirectoryRow>} />,
    },
    {
      key: 'processing_status',
      label: t('integrationsIntake.intakeModule.status'),
      sortable: true,
      filterable: true,
      // Canonical processing_status (per supabase/migrations/202510110004_webhook_integration.sql:240):
      //   pending | processing | succeeded | failed (+ legacy: processed, dead_letter)
      // Strict canonical resolution via `processing_status` lookup category;
      // missing rows surface a danger-toned `(missing)` chip rather than a
      // silent neutral default.
      render: (raw) => <CanonicalChip category="processing_status" value={String(raw ?? '')} />,
    },
    {
      key: 'workflow_run_id',
      label: t('integrationsIntake.intakeModule.workflowReference'),
      mono: true,
      render: (raw) => (
        raw
          ? <span className="mono">{operatorReference('Run', raw)}</span>
          : <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>
      ),
    },
    {
      // CLAIM-LIFECYCLE-LINK Gap 1: derived shipment_id → deep-link.
      key: 'shipment_id',
      label: t('integrationsIntake.intakeModule.shipment'),
      mono: true,
      render: (_raw, row) => {
        const prov = provenanceByInboxId[row.id];
        if (!prov?.shipment_id) {
          return (
            <span className="mono" style={{ color: 'var(--ink-3)' }} title={t('integrationsIntake.intakeModule.noShipmentEventYet')}>
              —
            </span>
          );
        }
        return (
          <ShipmentReferenceButton
            shipmentId={prov.shipment_id}
            onOpen={openShipmentContext}
            testId="inbox-shipment-context-button"
          />
        );
      },
    },
  ];

  const inboxRowActions: Array<DataTableAction<WebhookInboxRow>> = [
    {
      label: t('integrationsIntake.intakeModule.viewProvenance'),
      icon: 'eye',
      kind: 'primary',
      onClick: openProvenanceDrawer,
    },
    {
      label: t('integrationsIntake.intakeModule.retryInboxEvent'),
      icon: 'refresh',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: async (row) => {
        try {
          // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #1): canonical Phase B6 RPC
          // contract key is `webhook_inbox_id` (migration 202604280219),
          // not `inbox_id`. Send canonical key directly; the api facade
          // adapter still translates `inbox_id` defensively.
          await executeReplayInboxEvent(row, 'operator_retry', 'Retry');
        } catch (err) {
          pushToast(fill(t('integrationsIntake.intakeModule.retryFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsIntake.intakeModule.replayInboxEvent'),
      icon: 'rotate',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: async (row) => {
        try {
          await executeReplayInboxEvent(row, 'operator_replay', 'Replay');
        } catch (err) {
          pushToast(fill(t('integrationsIntake.intakeModule.replayFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsIntake.intakeModule.createFreshIntake'),
      icon: 'plus',
      capability: CAP.WEBHOOKS_WRITE,
      disabled: (row) => !['failed', 'dead_letter'].includes(row.processing_status),
      disabledReason: () => 'Fresh intake is only available for failed webhook inbox rows.',
      onClick: async (row) => {
        try {
          const previousLastReplayAt = replayLedgerTimestamp(row as Partial<WebhookInboxDirectoryRow>);
          const result = await retryInboxAsNewIntake.mutateAsync({
            webhook_inbox_id: row.id,
            reason: 'operator_create_fresh_intake',
          });
          const readback = await requireFreshIntakeReadback(row, result, previousLastReplayAt);
          const newInboxId =
            typeof result.new_webhook_inbox_id === 'string' && result.new_webhook_inbox_id.trim()
              ? result.new_webhook_inbox_id.trim()
              : null;
          setIntakeActionReadback({
            actionLabel: t('integrationsIntake.intakeModule.createFreshIntake'),
            eventId: row.id,
            processingStatus: String(readback.processing_status ?? row.processing_status ?? 'pending'),
            replayCount: Number(readback.replay_count ?? 0),
            forceStatusCount: Number(readback.force_status_count ?? 0),
            lastReplayAction: readback.last_replay_action ?? null,
            lastReplayActor: readback.last_replay_actor ?? null,
            lastReplayAt: readback.last_replay_at ?? null,
            newInboxId,
          });
          if (newInboxId) {
            pushToast(
              fill(t('integrationsIntake.intakeModule.freshIntakeCreated'), { value: String(operatorReference('Event', newInboxId)) }),
              'good',
            );
            return;
          }
          const reason = typeof result.reason === 'string' ? result.reason : 'external resend required';
          pushToast(fill(t('integrationsIntake.intakeModule.freshIntakeRequiresExternal'), { reason: String(reason) }), 'warn');
        } catch (err) {
          pushToast(fill(t('integrationsIntake.intakeModule.freshIntakeFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsIntake.intakeModule.openInTestWebhook'),
      icon: 'play',
      capability: CAP.WEBHOOKS_READ,
      onClick: (row) => {
        go(`/integrations/webhook-tester?inbox_id=${encodeURIComponent(row.id)}`);
      },
    },
    {
      label: t('integrationsIntake.intakeModule.forceStatusFailed'),
      icon: 'lock',
      kind: 'danger',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: async (row) => {
        try {
          // Cycle E P1 #11 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
          // target_status resolves through canonical `processing_status`
          // lookup row. Missing canonical row fails loud (toast + abort)
          // so the seed gap is visible to operators.
          // Cycle F-R Integrations P2-3 closure: terminal-failure row
          // resolution now reads `metadata.is_terminal_failure: true`
          // from the canonical lookup rows (no hardcoded `'failed'`
          // lookup key). One SSOT for the terminal-failure taxonomy.
          const rows = (getLookups('processing_status') ?? []) as Array<{
            value: string;
            metadata?: { is_terminal_failure?: boolean };
          }>;
          const failedRow = rows.find((r) => r.metadata?.is_terminal_failure === true);
          if (!failedRow?.value) {
            pushToast(
              t('integrationsIntake.intakeModule.terminalFailureStatusIs'),
              'danger',
            );
            return;
          }
          // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #2): canonical RPC keys are
          // `webhook_inbox_id` + `target_status` (migration 202604280220).
          const previousForceStatusCount = Number((row as Partial<WebhookInboxDirectoryRow>).force_status_count ?? 0);
          await forceInboxStatus.mutateAsync({
            webhook_inbox_id: row.id,
            target_status: failedRow.value,
            reason: `operator_force_${failedRow.value}`,
          });
          const readback = await requireForceStatusReadback(row, failedRow.value, previousForceStatusCount);
          setIntakeActionReadback({
            actionLabel: t('integrationsIntake.intakeModule.forceStatus'),
            eventId: row.id,
            processingStatus: String(readback.processing_status ?? failedRow.value),
            replayCount: Number(readback.replay_count ?? 0),
            forceStatusCount: Number(readback.force_status_count ?? 0),
            lastReplayAction: readback.last_replay_action ?? null,
            lastReplayActor: readback.last_replay_actor ?? null,
            lastReplayAt: readback.last_replay_at ?? null,
          });
          pushToast(fill(t('integrationsIntake.intakeModule.forced'), { value: String(lookupRow('processing_status', failedRow.value)?.label ?? failedRow.value), value2: String(operatorReference('Event', row.id)) }), 'warn');
        } catch (err) {
          pushToast(fill(t('integrationsIntake.intakeModule.forceStatusFailed2'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsIntake.intakeModule.viewWorkflowRun'),
      icon: 'history',
      disabled: (row) => !row.workflow_run_id,
      disabledReason: () => 'No workflow run reference yet.',
      onClick: openWorkflowRunContext,
    },
  ];

  const authRejectionColumns: Array<DataTableColumn<WebhookAuthRejectionRow>> = [
    { key: 'occurred_at', label: t('integrationsIntake.intakeModule.when'), format: 'datetime', sortable: true },
    {
      key: 'http_status',
      label: t('integrationsIntake.intakeModule.status'),
      align: 'right',
      mono: true,
      sortable: true,
      render: (raw) => (
        <Chip
          label={raw ? t('integrationsIntake.intakeModule.rejected') : t('integrationsIntake.intakeModule.rejected')}
          kind={Number(raw) === 403 ? 'warn' : 'danger'}
          size="xs"
          className="mono"
        />
      ),
    },
    {
      key: 'failure_code',
      label: t('integrationsIntake.intakeModule.failure'),
      mono: true,
      sortable: true,
      filterable: true,
      render: (raw) => <Chip label={raw ? t('integrationsIntake.intakeModule.requestRejected') : t('integrationsIntake.intakeModule.rejected')} kind="danger" size="xs" />,
    },
    {
      key: 'source_label',
      label: t('integrationsIntake.intakeModule.source'),
      sortable: true,
      filterable: true,
      render: (raw, row) => (
        <span>{raw ? String(raw) : row.source_resolved ? t('integrationsIntake.intakeModule.linkedSource') : t('integrationsIntake.intakeModule.unresolvedSource')}</span>
      ),
    },
    { key: 'method', label: t('integrationsIntake.intakeModule.method'), mono: true, sortable: true, filterable: true },
    {
      key: 'path',
      label: t('integrationsIntake.intakeModule.path'),
      mono: true,
      sortable: true,
      filterable: true,
      render: (raw) => redactSensitiveText(String(raw ?? '—')),
    },
    { key: 'correlation_id', label: t('integrationsIntake.intakeModule.trackingKey'), mono: true, sortable: true, filterable: true },
  ];

  const authRejectionRowActions: Array<DataTableAction<WebhookAuthRejectionRow>> = [
    {
      label: t('integrationsIntake.intakeModule.viewRejection'),
      icon: 'eye',
      kind: 'primary',
      onClick: openAuthRejectionDrawer,
    },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-intake"
          eyebrow={t('integrationsIntake.intakeModule.externalIntake')}
          titleAccent={t('integrationsIntake.intakeModule.titleAccent')}
          titlePlain={t('integrationsIntake.intakeModule.titlePlain')}
          pills={[]}
        />
        <StateView
          kind="denied"
          capability={CAP.WEBHOOKS_READ}
          hint={t('integrationsIntake.intakeModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (inboxDirectoryQuery.isLoading || (Boolean(focusedInboxId) && focusedInboxDirectoryQuery.isLoading)) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-intake"
          eyebrow={t('integrationsIntake.intakeModule.externalIntake')}
          titleAccent={t('integrationsIntake.intakeModule.titleAccent')}
          titlePlain={t('integrationsIntake.intakeModule.titlePlain')}
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (focusedInboxDirectoryQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-intake"
          eyebrow={t('integrationsIntake.intakeModule.externalIntake')}
          titleAccent={t('integrationsIntake.intakeModule.titleAccent')}
          titlePlain={t('integrationsIntake.intakeModule.titlePlain')}
          pills={[]}
        />
        <StateView kind="error" hint={String(focusedInboxDirectoryQuery.error)} />
      </div>
    );
  }

  const intakeRelatedError =
    runsQuery.error ??
    eventsQuery.error;
  const m = intakeMetrics;
  const verifiedPct = m && m.total > 0 ? Math.round((m.verified / m.total) * 100) : null;
  const intakeRelatedWarning = intakeRelatedError
    ? (intakeRelatedError as Error).message
    : canRead && workflowRunFilters.length > 0 && !canReadWorkflows
      ? `Capability denied: ${CAP.WORKFLOWS_READ}`
      : null;

  return (
    <div className="page">
      <PageHeader
        moduleKey="int-intake"
        eyebrow={t('integrationsIntake.intakeModule.externalIntake')}
        titleAccent={t('integrationsIntake.intakeModule.titleAccent')}
        titlePlain={t('integrationsIntake.intakeModule.titlePlain')}
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="dir" className="chip chip--xs mono" title={t('integrationsIntake.intakeModule.webhookInboxProjection')}>
            {t('integrationsIntake.intakeModule.webhookInboxDirectory')}
          </span>,
          <span key="policy" className="chip chip--xs mono" title={t('integrationsIntake.intakeModule.resolvedFromMarketingIntake')}>
            {t('integrationsIntake.intakeModule.policyFailClosedTurnstile')}
          </span>,
        ]}
      />
      <ExternalIntakeWorkspaceToolbar activePath="/integrations/intake" />
      {intakeRelatedWarning ? (
        <div
          className="state state--warn"
          data-testid="inbound-intake-related-data-warning"
          role="status"
          style={{ padding: '10px 12px', borderRadius: 8 }}
        >
          <div className="state__title">{t('integrationsIntake.intakeModule.inboundIntakeRelatedData')}</div>
          <div className="state__hint">{intakeRelatedWarning}</div>
        </div>
      ) : null}
      {intakeActionReadback ? (
        <div
          className="state state--good"
          data-testid="inbound-intake-action-readback"
          role="status"
          style={{ padding: '10px 12px', borderRadius: 8 }}
        >
          <div className="state__title">{t('integrationsIntake.intakeModule.inboundActionConfirmed')}</div>
          <div className="state__hint">
            <span className="mono">{intakeActionReadback.actionLabel}</span>
            {t('integrationsIntake.intakeModule.event3')}
            <span className="mono">{operatorReference('Event', intakeActionReadback.eventId)}</span>
            {t('integrationsIntake.intakeModule.status2')}
            <span className="mono">{intakeActionReadback.processingStatus}</span>
            {t('integrationsIntake.intakeModule.replay2')}
            <span className="mono">{intakeActionReadback.replayCount}</span>
            {t('integrationsIntake.intakeModule.force')}
            <span className="mono">{intakeActionReadback.forceStatusCount}</span>
            {intakeActionReadback.lastReplayAction ? (
              <>
                {t('integrationsIntake.intakeModule.ledger')}
                <span className="mono">{intakeActionReadback.lastReplayAction}</span>
              </>
            ) : null}
            {intakeActionReadback.newInboxId ? (
              <>
                {t('integrationsIntake.intakeModule.fresh')}
                <span className="mono">{operatorReference('Event', intakeActionReadback.newInboxId)}</span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      <div
        className="section-eyebrow"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <span>{t('integrationsIntake.intakeModule.webhookInbox')}</span>
        <Button
          kind="ghost"
          size="sm"
          iconName="refresh"
          label={inboxDirectoryQuery.isFetching ? t('integrationsIntake.intakeModule.refreshing') : t('integrationsIntake.intakeModule.refresh')}
          onClick={() => void refreshWebhookInbox()}
          disabled={inboxDirectoryQuery.isFetching}
          ariaLabel={t('integrationsIntake.intakeModule.refreshWebhookInbox')}
        />
      </div>
      <div className="intake-table-frame intake-table-frame--primary">
        {inboxDirectoryQuery.isError ? (
          <StateView
            kind="error"
            title={t('integrationsIntake.intakeModule.webhookInboxUnavailable')}
            hint={t('integrationsIntake.intakeModule.webhookInboxDirectoryCould')}
          />
        ) : (
          <DataTable<WebhookInboxRow>
            columns={inboxColumns}
            rows={inbox}
            viewKey="webhook_inbox"
            entityKind="webhook_inbox"
            // Risk row class derives from canonical tone (`danger`) — no inline
            // value branch. Mirrors the chip resolution so seed updates flow
            // through one SSOT.
            getRowClass={(r) =>
              lookupRow('processing_status', r.processing_status)?.tone === 'danger' ? 'is-risk' : undefined
            }
            searchKeys={[...WEBHOOK_INBOX_SEARCH_KEYS]}
            rowActions={inboxRowActions}
            onRowClick={openProvenanceDrawer}
          />
        )}
      </div>
      <div
        className="section-eyebrow"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <span>{t('integrationsIntake.intakeModule.rejectedWebhookRequests')}</span>
        <Button
          kind="ghost"
          size="sm"
          iconName="refresh"
          label={authRejectionsQuery.isFetching ? t('integrationsIntake.intakeModule.refreshing') : t('integrationsIntake.intakeModule.refresh')}
          onClick={() => void authRejectionsQuery.refetch()}
          disabled={authRejectionsQuery.isFetching}
          ariaLabel={t('integrationsIntake.intakeModule.refreshRejectedWebhookRequests')}
        />
      </div>
      {authRejectionsQuery.isError ? (
        <StateView
          kind="error"
          title={t('integrationsIntake.intakeModule.rejectedWebhookRequestsUnavailable')}
          hint={t('integrationsIntake.intakeModule.rejectedSourceTokenAttempts')}
        />
      ) : authRejectionsQuery.isLoading ? (
        <StateView kind="loading" hint={t('integrationsIntake.intakeModule.loadingRejectedWebhookRequests')} />
      ) : authRejections.length === 0 ? (
        <StateView
          kind="empty"
          title={t('integrationsIntake.intakeModule.noRejectedWebhookRequests')}
          hint={t('integrationsIntake.intakeModule.missingInvalidDisabledOr')}
        />
      ) : (
        <DataTable<WebhookAuthRejectionRow>
          columns={authRejectionColumns}
          rows={authRejections}
          viewKey="webhook_auth_rejections"
          entityKind="webhook_auth_rejection"
          rowActions={authRejectionRowActions}
          onRowClick={openAuthRejectionDrawer}
        />
      )}
      <div
        className="section-eyebrow"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <span>{t('integrationsIntake.intakeModule.marketingLeadIntakeRecent')}</span>
        <Button
          kind="ghost"
          size="sm"
          iconName="refresh"
          label={intakeRecentQuery.isFetching || intakeMetricsQuery.isFetching ? t('integrationsIntake.intakeModule.refreshing') : t('integrationsIntake.intakeModule.refresh')}
          onClick={() => {
            void intakeRecentQuery.refetch();
            void intakeMetricsQuery.refetch();
          }}
          disabled={intakeRecentQuery.isFetching || intakeMetricsQuery.isFetching}
          ariaLabel={t('integrationsIntake.intakeModule.refreshMarketingLeadIntake')}
        />
      </div>
      {m ? (
        <div className="kpi-strip">
          <KPICard label={t('integrationsIntake.intakeModule.totalEvents24h')} value={m.total} tone="neutral" />
          <KPICard label={t('integrationsIntake.intakeModule.verified')} value={verifiedPct == null ? `${m.verified}` : `${m.verified} (${verifiedPct}%)`} tone="good" />
          <KPICard label={t('integrationsIntake.intakeModule.turnstileFailed')} value={m.turnstile_failed} tone="warn" />
          <KPICard label={t('integrationsIntake.intakeModule.rateLimited')} value={m.rate_limited} tone="warn" />
          <KPICard label={t('integrationsIntake.intakeModule.dedupeDropped')} value={m.dedupe_dropped} tone="info" />
        </div>
      ) : (
        <StateView
          kind="error"
          title={t('integrationsIntake.intakeModule.marketingIntakeMetricsUnavailable')}
          hint={t('integrationsIntake.intakeModule.the24HourAggregate')}
        />
      )}
      <DataTable<MarketingIntakeEvent>
        columns={marketingCols}
        rows={intakeRecent}
        viewKey="marketing_intake"
        entityKind="marketing_intake_event"
        // Cycle E P1 #2 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
        // risk row class derives from canonical `marketing_decision` tone
        // — `tone === 'danger'` (turnstile_failed/rejected) is the
        // canonical risk signal; missing canonical row also flags risk so
        // operators see the seed gap. No inline 'accepted' literal.
        getRowClass={(r) =>
          lookupRow('marketing_decision', r.decision)?.tone === 'danger' ? 'is-risk' : undefined
        }
      />
      {drawer.node}
    </div>
  );
}

/* ---------- Provenance drawer ---------- */

function WebhookAuthRejectionDrawerBody({ row }: { row: WebhookAuthRejectionRow }) {
  const { t } = useI18n();
  const headerEntries = Object.entries(row.request_headers ?? {}).filter(([, value]) => value != null);
  const kvRows = [
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.correlationId'), value: row.correlation_id ?? '-', mono: true },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.rejectionConfirmation'), value: row.id ? 'Available' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.requestConfirmation'), value: row.request_id ? 'Available' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.trackingKey'), value: row.correlation_id ? 'Linked' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.status'), value: row.http_status ? 'Rejected' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.failureType'), value: row.failure_code ? 'Request rejected' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.failureMessage'), value: row.failure_message ? 'Source check failed' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.credential'), value: row.credential_kind ? 'Source credential checked' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.method'), value: row.method ? 'Received' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.path'), value: row.path ? 'Protected' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.source'), value: row.source_label ?? (row.source_id ? 'Linked source' : 'Unresolved source') },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.sourceReference'), value: row.source_identifier ? 'Matched' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.client'), value: row.client_label ?? (row.client_id ? 'Linked client' : '—') },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.sender'), value: row.sender_label ?? (row.sender_id ? 'Linked sender' : '—') },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.tokenCheck'), value: row.token_fingerprint ? 'Completed' : '—' },
    { label: t('integrationsIntake.webhookAuthRejectionDrawerBody.rejectedAt'), value: row.occurred_at, mono: true },
  ];

  return (
    <div data-testid="webhook-auth-rejection-drawer-body">
      <div className="chain" style={{ marginBottom: 14 }}>
        {kvRows.map((item) => (
          <div key={item.label} className="chain__row">
            <span>{item.label}</span>
            <span className={item.mono ? 'mono' : undefined}>{item.value}</span>
          </div>
        ))}
      </div>
      <h4 className="eyebrow" style={{ marginTop: 14 }}>{t('integrationsIntake.webhookAuthRejectionDrawerBody.requestProtection')}</h4>
      <StateView
        kind="empty"
        title={headerEntries.length ? t('integrationsIntake.webhookAuthRejectionDrawerBody.requestDetailsProtected') : t('integrationsIntake.webhookAuthRejectionDrawerBody.noRequestDetailsAvailable')}
        hint={t('integrationsIntake.webhookAuthRejectionDrawerBody.sensitiveRequestHeadersAnd')}
      />
    </div>
  );
}

function ProvenanceDrawerBody({
  row,
  prov,
  onOpenShipment,
  onOpenMapping,
}: {
  row: WebhookInboxRow;
  prov: InboxProvenance | null;
  onOpenShipment: (shipmentId: string) => void;
  onOpenMapping: (mappingConfigId: string, inboxId?: string | null) => void;
}) {
  const { t } = useI18n();
  // Strict canonical-tone resolution (no inline ternaries). Falls back to
  // 'neutral' when the value is absent OR the canonical row is missing
  // (the rendered chip surfaces the gap as `<category>/<value> (missing)`).
  type ChainTone = 'good' | 'warn' | 'danger' | 'info' | 'neutral';
  // Cycle E P2 #15 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): source
  // chip tone resolves through canonical `webhook_source_state` lookup —
  // when the projection row exposes `source_state`, tone reflects
  // operational health (enabled/disabled/throttled/down). The default
  // (`enabled`) is the lookup row marked `is_default: true`. No inline
  // 'good' literal.
  // W79 (Cycle F-R-19) closure — the default value itself is now resolved
  // from the canonical `webhook_source_state` row carrying
  // `is_default: true` (mirrors W76 task_priority + W77 workflow_branch_kind
  // defaults pattern). Replaces the inline `?? 'enabled'` literal so adding
  // a new default state is a single seed update.
  const defaultWebhookSourceState =
    (getLookups('webhook_source_state') as Array<{ value: string; is_default?: boolean; metadata?: { is_default?: boolean } }> | undefined)
      ?.find((r) => r.is_default === true || r.metadata?.is_default === true)?.value ?? '';
  const sourceState =
    (row as { source_state?: string | null }).source_state ?? defaultWebhookSourceState;
  const sourceLookup = lookupRow('webhook_source_state', String(sourceState));
  const sourceTone: ChainTone =
    (sourceLookup?.tone as ChainTone | undefined) ?? 'neutral';
  const inboxLookup = lookupRow('processing_status', row.processing_status);
  const inboxTone: ChainTone = (inboxLookup?.tone as ChainTone | undefined) ?? 'neutral';
  const projectedWorkflowRunId =
    (row as Partial<WebhookInboxDirectoryRow>).workflow_run_id ?? row.workflow_run_id ?? null;
  const runStatus =
    prov?.workflow_run?.status ?? (row as Partial<WebhookInboxDirectoryRow>).workflow_run_status ?? null;
  const runLookup = runStatus ? lookupRow('workflow_run_status', runStatus) : null;
  const hasWorkflowRun = Boolean(prov?.workflow_run || projectedWorkflowRunId);
  const runTone: ChainTone = !hasWorkflowRun
    ? 'neutral'
    : ((runLookup?.tone as ChainTone | undefined) ?? 'neutral');
  // W69 Cycle F-R-9 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6
  // row-driven by configuration): shipment-match tone resolves through the
  // canonical `provenance_shipment_state` lookup category. The
  // boolean→state projection (`prov?.shipment_id ?? null` → matched /
  // unmatched) stays in code; tone routes through the canonical lookup so
  // adding/changing match-state semantics never requires editing module
  // code.
  const shipmentState = prov?.shipment_id ? 'matched' : 'unmatched';
  const shipmentLookup = lookupRow('provenance_shipment_state', shipmentState);
  const shipmentTone: ChainTone =
    (shipmentLookup?.tone as ChainTone | undefined) ?? 'neutral';
  const replayCount = Number((row as Partial<WebhookInboxDirectoryRow>).replay_count ?? 0);
  const hasReplay = Number.isFinite(replayCount) && replayCount > 0;
  const mappingConfigId = (row as Partial<WebhookInboxDirectoryRow>).mapping_config_id;

  const chain: Array<{
    key: string;
    label: ReactNode;
    detail: ReactNode;
    tone: ChainTone;
  }> = [
    {
      key: 'source',
      label: t('integrationsIntake.provenanceDrawerBody.source'),
      detail: (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' }}>
          <span>{(row as Partial<WebhookInboxDirectoryRow>).source_label ?? t('integrationsIntake.provenanceDrawerBody.intakeSource')}</span>
          <span className="mono" style={{ color: 'var(--ink-3)' }}>
            {sourceReference(row as WebhookInboxRow & Partial<WebhookInboxDirectoryRow>)}
          </span>
          <span className="mono" style={{ color: 'var(--ink-3)' }}>
            {fill(t('integrationsIntake.provenanceDrawerBody.id'), { webhook_source_id: String(row.webhook_source_id) })}
          </span>
        </span>
      ),
      tone: sourceTone,
    },
    {
      key: 'inbox',
      label: t('integrationsIntake.provenanceDrawerBody.inboxEvent'),
      detail: (
        <span className="mono">
          {operatorReference('Event', row.id)} · <CanonicalChip category="processing_status" value={row.processing_status} />
        </span>
      ),
      tone: inboxTone,
    },
    {
      key: 'ack',
      label: t('integrationsIntake.provenanceDrawerBody.receiverAcknowledgement'),
      detail: (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' }}>
          <ReceiverOutcomeCell row={row as Partial<WebhookInboxDirectoryRow>} />
          {receiverStatusCode(row as Partial<WebhookInboxDirectoryRow>) != null ? (
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              {fill(t('integrationsIntake.provenanceDrawerBody.http'), { value: String(receiverStatusCode(row as Partial<WebhookInboxDirectoryRow>)) })}
            </span>
          ) : null}
          {receiverReason(row as Partial<WebhookInboxDirectoryRow>) ? (
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              {receiverReason(row as Partial<WebhookInboxDirectoryRow>)}
            </span>
          ) : null}
        </span>
      ),
      tone: receiverOutcomeTone(receiverOutcomeValue(row as Partial<WebhookInboxDirectoryRow>)) as ChainTone,
    },
    ...(hasReplay
      ? [{
          key: 'replay',
          label: t('integrationsIntake.provenanceDrawerBody.replayHistory'),
          detail: <ReplayLedgerCell row={row as Partial<WebhookInboxDirectoryRow>} />,
          tone: 'info' as ChainTone,
        }]
      : []),
    {
      key: 'mapping',
      label: t('integrationsIntake.provenanceDrawerBody.mapping'),
      detail: (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' }}>
          {(row as Partial<WebhookInboxDirectoryRow>).mapping_label ? (
            <span className="mono">{(row as Partial<WebhookInboxDirectoryRow>).mapping_label}</span>
          ) : (
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              {operatorReference('Mapping', (row as Partial<WebhookInboxDirectoryRow>).mapping_config_id)}
            </span>
          )}
          {(row as Partial<WebhookInboxDirectoryRow>).mapping_target ? (
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              {fill(t('integrationsIntake.provenanceDrawerBody.target'), { mapping_target: String((row as Partial<WebhookInboxDirectoryRow>).mapping_target) })}
            </span>
          ) : null}
          {(row as Partial<WebhookInboxDirectoryRow>).mapping_version != null ? (
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              v{(row as Partial<WebhookInboxDirectoryRow>).mapping_version}
            </span>
          ) : null}
          {(row as Partial<WebhookInboxDirectoryRow>).mapping_rules_count != null ? (
            <span className="mono" style={{ color: 'var(--ink-3)' }}>
              {fill(t('integrationsIntake.provenanceDrawerBody.rules'), { mapping_rules_count: String((row as Partial<WebhookInboxDirectoryRow>).mapping_rules_count) })}
            </span>
          ) : null}
          {mappingConfigId ? (
            <Button
              label={t('integrationsIntake.provenanceDrawerBody.openMapping')}
              iconName="edit"
              kind="ghost"
              capability={CAP.MAPPINGS_READ}
              onClick={() => onOpenMapping(mappingConfigId, row.id)}
            />
          ) : null}
        </span>
      ),
      tone: 'info',
    },
    {
      key: 'run',
      label: t('integrationsIntake.provenanceDrawerBody.workflowRun'),
      detail: hasWorkflowRun ? (
        <span className="mono">
          {operatorReference('Run', prov?.workflow_run?.id ?? projectedWorkflowRunId)}
          {runStatus ? (
            <>
              {' · '}
              <CanonicalChip category="workflow_run_status" value={runStatus} />
            </>
          ) : null}
        </span>
      ) : (
        <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>
      ),
      tone: runTone,
    },
    {
      key: 'shipment',
      label: t('integrationsIntake.provenanceDrawerBody.shipment'),
      detail: prov?.shipment_id ? (
        <ShipmentReferenceButton
          shipmentId={prov.shipment_id}
          onOpen={onOpenShipment}
          testId="prov-shipment-context-button"
        />
      ) : (
        <span className="mono" style={{ color: 'var(--ink-3)' }}>{t('integrationsIntake.provenanceDrawerBody.notYetEmitted')}</span>
      ),
      tone: shipmentTone,
    },
  ];

  return (
    <div className="rail-body" style={{ paddingBottom: 0 }}>
      <h4 className="eyebrow">{t('integrationsIntake.provenanceDrawerBody.ingestProvenance')}</h4>
      <p className="state__hint" style={{ marginBottom: '12px' }}>
        {t('integrationsIntake.provenanceDrawerBody.showsHowTheInbound')}
      </p>
      <ol style={{ display: 'flex', flexDirection: 'column', gap: '6px', listStyle: 'none', padding: 0, margin: 0 }}>
        {chain.map((s, i) => (
          <li key={s.key} className="card" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              className="mono"
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                background: 'var(--surface-2)',
                color: 'var(--ink-2)',
                fontSize: '11px',
              }}
            >
              {i + 1}
            </span>
            <Chip label={s.label} kind={s.tone as ChipKind} size="sm" />
            <span style={{ flex: 1 }} />
            {s.detail}
          </li>
        ))}
      </ol>
      {prov?.correlation_id ? (
        <p className="state__hint" style={{ marginTop: '12px' }}>
          {t('integrationsIntake.provenanceDrawerBody.activityReference')}{' '}
          <a className="mono" href={buildTraceDeepLink(prov.correlation_id)}>
            {operatorReference('Activity', prov.correlation_id)}
          </a>
        </p>
      ) : null}
      {row.error_message ? (
        <div className="card" style={{ marginTop: '12px' }}>
          <h4 className="eyebrow" style={{ color: 'var(--danger-ink)' }}>{t('integrationsIntake.provenanceDrawerBody.error')}</h4>
          <p className="mono" style={{ fontSize: '12px' }}>{redactSensitiveText(row.error_message)}</p>
        </div>
      ) : null}
    </div>
  );
}

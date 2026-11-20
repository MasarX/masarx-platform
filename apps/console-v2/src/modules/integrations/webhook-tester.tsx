// integrations/webhook-tester.tsx — webhook-receiver tester with request/response inspector.
// Backed by:
//   - integration_plugins (read) — supabase/migrations/202602220010_integration_plugin_control_plane_v1.sql
//   - api.runPluginTest (data-source seam → backend plugin diagnostic RPC)
//   - api.runWebhookReceiverTest (real webhook-receiver POST for intake proof)
//   - canonical webhook trace step shape: { name, ms, ok, ...meta }
//
// 2025-2026 market parity (Stripe / GitHub / HookListener / Postman):
//   - Request inspector tab: METHOD / URL / Headers / Body of the synthesised webhook envelope.
//   - Response inspector tab: derived status (200 / 4xx / 5xx) + headers + body from the trace.
//   - Replay diagnostic button: rerun the same payload against the plugin diagnostic RPC (counter visible).
//   - Force-status select (200 / 400 / 422 / 500 / 503): seed mode uses an
//     explicit local diagnostic response override; live mode requires a linked
//     webhook_inbox row and persists through webhook_inbox_force_status_v1.
//
// All data shown is derived from real backend response — no fictional fields.
// See apps/console-v2/__audit__/I/{backend-evidence,user-flows,market-benchmark}.md.

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useReplayWebhookInbox,
  useForceWebhookInboxStatus,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { useDrawer } from '@/hooks/useOverlay';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import {
  buildRequestEnvelope,
  buildResponseEnvelope,
  type ForcedStatus,
  type TraceStep,
} from './_webhook-tester/envelopes';
import { formatWebhookReplayToast, webhookReplayWasPreserved } from './_webhook-replay-outcome';
import { isShipmentCreateIntent } from '@/lib/webhook-intents';
import { redactJsonForOperator, redactSensitiveText } from '@/lib/operator-redaction';
import {
  clearExternalIntakeSourceToken,
  peekExternalIntakeSourceToken,
} from '@/lib/external-intake-token-handoff';
import { ExternalIntakeWorkspaceToolbar } from './ExternalIntakeWorkspaceToolbar';
import { readUrlParam } from '@/lib/url-params';

interface IntegrationPlugin extends Record<string, unknown> {
  id: string;
  name: string;
  version: string;
  vendor?: string;
}

interface WebhookSourceDirectoryRow extends Record<string, unknown> {
  id: string;
  source_label?: string | null;
  name?: string | null;
  source_identifier?: string | null;
}

interface TraceResult {
  duration_ms: number;
  steps: TraceStep[];
}

interface LookupValueRow extends Record<string, unknown> {
  id: string;
  value: string;
  label?: string | null;
  is_default?: boolean;
  metadata?: {
    payload?: unknown;
  } | null;
}

type InspectorTab = 'request' | 'response';
type ReceiverResult = api.RunWebhookReceiverTestResult;
type ReceiverDirectoryReadbackRow = Record<string, unknown>;
interface ReceiverFailure {
  message: string;
  idempotency_key: string;
  occurred_at: string;
}
interface LinkedInboxContextRow extends Record<string, unknown> {
  id: string;
  source_label?: string | null;
  source_identifier?: string | null;
  provider_type_label?: string | null;
  mapping_config_id?: string | null;
  mapping_label?: string | null;
  mapping_target?: string | null;
  mapping_version?: number | null;
  processing_status?: string | null;
  workflow_run_id?: string | null;
  shipment_id?: string | null;
  tracking_number?: string | null;
  replay_count?: number | null;
  error_message?: string | null;
}
const RECEIVER_READBACK_REFRESH_TIMEOUT_MS = 120_000;
const RECEIVER_READBACK_REFRESH_INTERVAL_MS = 2_000;
const RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS = 45_000;
const RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS = 1_000;
const RECEIVER_INBOX_CACHE_RESOURCES = ['webhook_inbox', 'webhook_inbox_directory'] as const;
const RECEIVER_IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isReceiverFailedStatus(value: unknown): boolean {
  const status = String(value ?? '').trim().toLowerCase();
  return (
    status.includes('fail') ||
    status === 'error' ||
    status === 'errored' ||
    status === 'rejected' ||
    status === 'dead_lettered'
  );
}

function hasReceiverShipmentReadback(
  result: ReceiverResult | null | undefined,
): result is ReceiverResult & { shipment_id: string } {
  return Boolean(
    result &&
      result.is_terminal === true &&
      typeof result.shipment_id === 'string' &&
      result.shipment_id.trim() &&
      !isReceiverFailedStatus(result.webhook_processing_status),
  );
}

function isReceiverAuthRejectionResult(result: ReceiverResult | null | undefined): boolean {
  return Boolean(result?.auth_rejection_id);
}
// W26 Cycle B closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): forced
// status options resolve through the canonical `webhook_forced_status`
// lookup category (lib/seed-raw/lookups.js) rather than a hardcoded array.
// `ForcedStatus` is widened to `string` so getLookups-derived values from
// future seed updates do not require a type literal change. The tester
// still treats `'auto'` as the special "do not force" sentinel.

// Cycle E P2 #17 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the
// tester sample payload now resolves through the canonical
// `webhook_sample_payload` lookup category. The default row carries
// `metadata.payload` with the JSON envelope.
// Cycle F-R Integrations P1-2 closure (AGENTS.md §2 ZERO HARDCODING +
// §4 SSOT): default row resolution now reads `is_default: true` from the
// canonical lookup rows (no hardcoded `shopify_default` lookup key).
// When the canonical default row is missing, the tester opens with `'{}'`
// so the operator sees a clean editable buffer rather than seed leakage.
function isReceiverShipmentCreateResult(result: ReceiverResult | null | undefined): boolean {
  return Boolean(
    result &&
      (isShipmentCreateIntent(result.canonical_intent) || isShipmentCreateIntent(result.mapping_target)),
  );
}

function guardReceiverShipmentReadback(result: ReceiverResult): ReceiverResult {
  if (
    isReceiverShipmentCreateResult(result) &&
    result.is_terminal === true &&
    !hasReceiverShipmentReadback(result) &&
    !isReceiverFailedStatus(result.webhook_processing_status)
  ) {
    return {
      ...result,
      webhook_processing_status: 'failed_missing_shipment_readback',
      tracking_number: null,
      error_message:
        result.error_message ??
        'Terminal shipment intake completed without shipment confirmation',
    };
  }
  return result;
}

function isDiagnosticReceiverResult(result: ReceiverResult | null | undefined): boolean {
  return Boolean(result?.diagnostic_only || result?.response?.diagnostic_only);
}

function humanizeReceiverOutcome(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized === 'ack_replayed' || normalized === 'response_replayed') return 'Duplicate replayed';
  if (normalized === 'ack_sent' || normalized === 'accepted') return 'Accepted';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTraceStepLabel(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Step completed';
  return raw
    .replace(/^(webhook|receiver|api_gateway|workflow)[._:-]+/i, '')
    .replace(/[._:-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function receiverOutcomeValue(result: ReceiverResult | null | undefined): string | null {
  const ackOutcome = String(result?.ack_outcome ?? '').trim().toLowerCase();
  const responseOutcome = String(result?.response_outcome ?? '').trim().toLowerCase();
  if (isReceiverAuthRejectionResult(result)) return 'Auth rejected';
  if (ackOutcome === 'ack_replayed' || responseOutcome === 'response_replayed') return 'Duplicate replayed';
  if (isReceiverFailedStatus(result?.webhook_processing_status)) return 'Terminal failure';
  return humanizeReceiverOutcome(result?.ack_outcome) ?? humanizeReceiverOutcome(result?.response_outcome);
}

function receiverOutcomeTone(result: ReceiverResult | null | undefined): ChipKind {
  const ackOutcome = String(result?.ack_outcome ?? '').trim().toLowerCase();
  const responseOutcome = String(result?.response_outcome ?? '').trim().toLowerCase();
  if (isReceiverAuthRejectionResult(result)) return 'danger';
  if (ackOutcome === 'ack_replayed' || responseOutcome === 'response_replayed') return 'warn';
  if (isReceiverFailedStatus(result?.webhook_processing_status)) return 'danger';
  const normalized = ackOutcome || responseOutcome;
  if (!normalized) return 'neutral';
  if (normalized === 'ack_sent' || normalized === 'accepted') return 'good';
  if (normalized.includes('fail') || normalized.includes('reject') || normalized.includes('invalid')) return 'danger';
  return 'info';
}

function isPermissionDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /42501|permission denied|capability denied|requires .*permission|requires .*capability/i.test(message);
}

function receiverStatusLabel(result: ReceiverResult): string {
  const status = result.ack_status_code ?? result.receiver_status ?? 202;
  return `${status} ${isReceiverAuthRejectionResult(result) || isReceiverFailedStatus(result.webhook_processing_status) ? 'Needs attention' : 'OK'}`;
}

function receiverPostToast(result: ReceiverResult): [string, 'good' | 'warn' | 'danger' | 'info'] {
  const ackOutcome = String(result.ack_outcome ?? '').trim().toLowerCase();
  const responseOutcome = String(result.response_outcome ?? '').trim().toLowerCase();
  if (ackOutcome.includes('replayed') || responseOutcome.includes('replayed')) {
    return ['Receiver duplicate replayed', 'warn'];
  }
  if (hasReceiverShipmentReadback(result)) {
    return [`Receiver materialized shipment - ${result.tracking_number || result.shipment_id}`, 'good'];
  }
  if (isReceiverAuthRejectionResult(result)) {
    return ['Receiver authentication rejected', 'danger'];
  }
  if (isReceiverFailedStatus(result.webhook_processing_status)) {
    return ['Receiver request failed', 'danger'];
  }
  if (result.is_terminal === true) {
    return ['Receiver completed without shipment confirmation', 'warn'];
  }
  return ['Receiver queued - shipment confirmation pending', 'info'];
}

function receiverEventReference(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'pending confirmation';
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function linkedReplayOutcomeLabel(result: Record<string, unknown> | null | undefined): string {
  if (!result) return 'pending confirmation';
  if (webhookReplayWasPreserved(result)) return 'Terminal failure preserved';
  if (result.replay_queued === true) return 'Replay queued';
  const status = typeof result.status === 'string' && result.status.trim() ? result.status.trim() : null;
  return status ? humanizeReceiverOutcome(status) ?? status : 'Replay confirmation received';
}

function ReceiverInboxEventDrawerBody({ result }: { result: ReceiverResult }) {
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <h4 className="eyebrow">Inbox event confirmation</h4>
      <div className="kvgrid" aria-label="Receiver inbox event context">
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Event</span>
          <span className="kvgrid__val mono">{result.webhook_id ?? 'pending confirmation'}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Status</span>
          <span className="kvgrid__val mono">
            {result.webhook_processing_status ?? 'pending confirmation'}
            {typeof result.is_terminal === 'boolean' ? (
              <span style={{ color: 'var(--ink-3)' }}>
                {' '}
                {result.is_terminal ? 'terminal' : 'not terminal'}
              </span>
            ) : null}
          </span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Receiver outcome</span>
          <span className="kvgrid__val mono">
            <Chip kind={receiverOutcomeTone(result)} label={receiverOutcomeValue(result) ?? 'pending confirmation'} />
            {result.ack_status_code != null ? (
              <span style={{ color: 'var(--ink-3)' }}> HTTP {result.ack_status_code}</span>
            ) : null}
            {result.idempotency_key ? (
              <span style={{ color: 'var(--ink-3)' }}> · Idempotency {result.idempotency_key}</span>
            ) : null}
          </span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Workflow</span>
          <span className="kvgrid__val mono">{result.workflow_run_id ?? 'pending confirmation'}</span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Source</span>
          <span className="kvgrid__val mono">
            {result.source_label ?? result.source_identifier ?? 'pending confirmation'}
          </span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Mapping</span>
          <span className="kvgrid__val mono">
            {result.mapping_label ?? result.mapping_config_id ?? 'pending confirmation'}
          </span>
        </div>
        <div className="kvgrid__row">
          <span className="kvgrid__key mono">Shipment</span>
          <span className="kvgrid__val mono">
            {hasReceiverShipmentReadback(result)
              ? result.tracking_number ?? result.shipment_id
              : isReceiverAuthRejectionResult(result)
              ? 'not created - authentication rejected'
              : isReceiverFailedStatus(result.webhook_processing_status)
              ? 'not created - failed'
              : 'not created yet'}
          </span>
        </div>
        {result.error_message ? (
          <div className="kvgrid__row">
            <span className="kvgrid__key mono">Error</span>
            <span className="kvgrid__val mono">{redactSensitiveText(result.error_message)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function resolveWebhookSamplePayload(rows: LookupValueRow[] | undefined): string | null {
  if (!rows?.length) return null;
  const defaultRow = rows.find((r) => r.is_default);
  const row = defaultRow ?? rows[0];
  const payload = row?.metadata?.payload;
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') return JSON.stringify(payload, null, 2);
  return null;
}

export type WebhookSampleTemplateContext = {
  idempotency_key: string;
  event_id: string;
  timestamp_iso: string;
  shipment_external_id: string;
  shipment_reference_number: string;
  recipient_external_id: string;
  recipient_phone: string;
  recipient_email: string;
};

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start++;
  while (end > start && value[end - 1] === '-') end--;
  return value.slice(start, end);
}

function sampleTokenBase(idempotencyKey: string): string {
  const trimmed = idempotencyKey.trim() || `console-v2-${Date.now()}`;
  return trimHyphens(trimmed.replace(/[^A-Za-z0-9_-]+/g, '-')).slice(0, 72) || 'console-v2-sample';
}

export function createReceiverIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  const timestampHex = Date.now().toString(16).padStart(12, '0').slice(-12);
  const randomHex = Math.random().toString(16).slice(2).padEnd(20, '0').slice(0, 20);
  return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-4${randomHex.slice(0, 3)}-8${randomHex.slice(3, 6)}-${randomHex.slice(6, 18)}`;
}

function isReceiverIdempotencyKeyValid(value: string): boolean {
  return RECEIVER_IDEMPOTENCY_KEY_PATTERN.test(value.trim());
}

export function buildWebhookSampleTemplateContext(
  idempotencyKey: string,
  now: Date = new Date(),
): WebhookSampleTemplateContext {
  const base = sampleTokenBase(idempotencyKey);
  const numericTail = base.replace(/\D/g, '').slice(-8).padStart(8, '0');
  const emailToken = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'sample';
  return {
    idempotency_key: base,
    event_id: base,
    timestamp_iso: now.toISOString(),
    shipment_external_id: `${base}-ORDER`,
    shipment_reference_number: `${base}-REF`,
    recipient_external_id: `${base}-REC`,
    recipient_phone: `+9665${numericTail}`,
    recipient_email: `recipient+${emailToken}@example.com`,
  };
}

export function renderWebhookSamplePayloadTemplate(
  template: string,
  context: WebhookSampleTemplateContext,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = context[key as keyof WebhookSampleTemplateContext];
    return typeof value === 'string' ? value : match;
  });
}

export function isRenderedWebhookSamplePayload(
  current: string,
  template: string,
  idempotencyKey: string,
): boolean {
  const trimmed = current.trim();
  if (!trimmed) return true;
  if (trimmed === template.trim()) return true;
  const context = buildWebhookSampleTemplateContext(idempotencyKey);
  try {
    const parsed = JSON.parse(trimmed) as { event?: { timestamp?: unknown } };
    if (typeof parsed?.event?.timestamp === 'string' && parsed.event.timestamp.trim()) {
      context.timestamp_iso = parsed.event.timestamp;
    }
  } catch {
    // Non-JSON payloads are compared directly against the rendered template.
  }
  return trimmed === renderWebhookSamplePayloadTemplate(template, context).trim();
}

function receiverString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function receiverNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function receiverBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function receiverWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function buildReceiverAuthRejectionResult(row: ReceiverDirectoryReadbackRow, idempotencyKey: string): ReceiverResult {
  const correlationId = receiverString(row.correlation_id) ?? idempotencyKey;
  const failureCode = receiverString(row.failure_code);
  const failureMessage = receiverString(row.failure_message) ?? failureCode ?? 'Unauthorized webhook source';
  const httpStatus = receiverNumber(row.http_status) ?? 401;
  return {
    ok: true,
    receiver_status: httpStatus,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    ack_outcome: 'auth_rejected',
    response_outcome: 'auth_rejected',
    ack_status_code: httpStatus,
    ack_reason: failureMessage,
    workflow_run_id: null,
    followup_workflow_run_id: null,
    webhook_id: null,
    canonical_intent: null,
    webhook_processing_status: 'auth_rejected',
    source_label: receiverString(row.source_label) ?? null,
    source_identifier: receiverString(row.source_identifier) ?? null,
    provider_type_label: null,
    mapping_config_id: null,
    mapping_label: null,
    mapping_target: null,
    mapping_version: null,
    mapping_rules_count: null,
    error_message: failureMessage,
    is_terminal: true,
    is_actionable: false,
    shipment_id: null,
    tracking_number: null,
    auth_rejection_id: receiverString(row.id) ?? null,
    auth_rejection_failure_code: failureCode,
    auth_rejection_failure_message: failureMessage,
    auth_rejection_http_status: httpStatus,
    auth_rejection_source_label: receiverString(row.source_label) ?? null,
    auth_rejection_source_identifier: receiverString(row.source_identifier) ?? null,
    auth_rejection_source_resolved: receiverBoolean(row.source_resolved),
    auth_rejection_token_fingerprint: null,
    auth_rejection_rejection_class: receiverString(row.rejection_class) ?? null,
    response: {
      status: 'auth_rejected',
      correlation_id: correlationId,
      idempotency_key: idempotencyKey,
    },
    workflow_steps: [],
  };
}

async function waitForReceiverAuthRejectionReadback(
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ReceiverResult | null> {
  const deadline = Date.now() + RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS;
  while (!signal?.aborted && Date.now() <= deadline) {
    const readback = await api.ui_list_resource_v1<ReceiverDirectoryReadbackRow>(
      'webhook_auth_rejections',
      {
        filter: { correlation_id: idempotencyKey },
        page_size: 1,
      },
    );
    const row = readback.rows[0];
    if (row) return buildReceiverAuthRejectionResult(row, idempotencyKey);
    if (signal?.aborted || Date.now() >= deadline) break;
    await receiverWait(RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS, signal);
  }
  return null;
}

function mergeReceiverDirectoryReadback(
  current: ReceiverResult,
  row: ReceiverDirectoryReadbackRow,
): ReceiverResult {
  return guardReceiverShipmentReadback({
    ...current,
    webhook_id: receiverString(row.id) ?? current.webhook_id ?? null,
    canonical_intent: receiverString(row.canonical_intent) ?? current.canonical_intent ?? null,
    webhook_processing_status:
      receiverString(row.processing_status) ?? current.webhook_processing_status ?? null,
    source_label: receiverString(row.source_label) ?? current.source_label ?? null,
    source_identifier: receiverString(row.source_identifier) ?? current.source_identifier ?? null,
    provider_type_label: receiverString(row.provider_type_label) ?? current.provider_type_label ?? null,
    mapping_config_id: receiverString(row.mapping_config_id) ?? current.mapping_config_id ?? null,
    mapping_label: receiverString(row.mapping_label) ?? current.mapping_label ?? null,
    mapping_target: receiverString(row.mapping_target) ?? current.mapping_target ?? null,
    mapping_version: receiverNumber(row.mapping_version) ?? current.mapping_version ?? null,
    mapping_rules_count: receiverNumber(row.mapping_rules_count) ?? current.mapping_rules_count ?? null,
    idempotency_key: receiverString(row.idempotency_key) ?? current.idempotency_key ?? null,
    ack_outcome: receiverString(row.ack_outcome) ?? current.ack_outcome ?? null,
    response_outcome: receiverString(row.response_outcome) ?? current.response_outcome ?? null,
    ack_status_code: receiverNumber(row.ack_status_code) ?? current.ack_status_code ?? null,
    ack_reason: receiverString(row.ack_reason) ?? current.ack_reason ?? null,
    error_message: receiverString(row.error_message) ?? current.error_message ?? null,
    is_terminal:
      typeof row.is_terminal === 'boolean' ? row.is_terminal : current.is_terminal ?? null,
    is_actionable:
      typeof row.is_actionable === 'boolean' ? row.is_actionable : current.is_actionable ?? null,
    shipment_id: receiverString(row.shipment_id) ?? current.shipment_id ?? null,
    tracking_number: receiverString(row.tracking_number) ?? current.tracking_number ?? null,
  });
}

async function refreshReceiverDirectoryReadback(
  current: ReceiverResult,
  idempotencyKey: string,
): Promise<ReceiverResult | null> {
  const filters = [
    current.webhook_id ? { id: current.webhook_id } : null,
    current.workflow_run_id ? { workflow_run_id: current.workflow_run_id } : null,
    idempotencyKey.trim() ? { idempotency_key: idempotencyKey.trim() } : null,
    current.correlation_id ? { correlation_id: current.correlation_id } : null,
  ].filter(Boolean) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  for (const filter of filters) {
    const key = JSON.stringify(filter);
    if (seen.has(key)) continue;
    seen.add(key);
    const readback = await api.ui_list_resource_v1<ReceiverDirectoryReadbackRow>(
      'webhook_inbox_directory',
      {
        filter,
        page_size: 1,
      },
    );
    const row = readback.rows[0];
    if (row) return mergeReceiverDirectoryReadback(current, row);
  }
  return null;
}

// ---------- helpers (testable, exported for unit tests) ----------

// Cycle E P1 #8 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): canonical
// failure-class taxonomy lives in `lookups.trace_step_failure_class` with
// `metadata.http_status` per row. The trace emitter SHOULD populate
// `failure_class` on failed steps; when it does, the resolver below picks
// the canonical HTTP status code. Until the emitter ships, the legacy
// substring-on-step-name fallback below is the documented P3-deferred path
// (TODO: drop once `failure_class` is universally emitted).
/*
function _legacyDeriveResponseStatus(steps: TraceStep[]): number {
  if (!steps.length) return 0;
  const failed = steps.find((s) => !s.ok);
  if (!failed) return 200;

  // Canonical-first: read failure_class metadata when present.
  const failureClass = (failed as { failure_class?: string }).failure_class;
  if (failureClass) {
    const row = lookupRow('trace_step_failure_class', String(failureClass)) as
      | { metadata?: { http_status?: number } }
      | null;
    const code = row?.metadata?.http_status;
    if (typeof code === 'number') return code;
  }

  // TODO (P3-deferred): drop this substring fallback once the trace
  // emitter consistently populates `failure_class` from
  // `trace_step_failure_class`. Tracked in
  // __audit__/SCHEMA-DRIFT/INTEGRATIONS.md.
  const name = String(failed.name).toLowerCase();
  if (name.includes('parse') || name.includes('verify')) return 400;
  if (name.includes('validate') || name.includes('mapping')) return 422;
  return 500;
}

function _legacyBuildRequestEnvelope(plugin: IntegrationPlugin | undefined, payloadJson: string) {
  // Cycle E P3 #19 closure: surface absent plugin selection explicitly via
  // `<no-plugin>` rather than the silent `unknown` fallback that masked
  // the gap. Header still strips an empty x-webhook-source.
  const id = plugin?.id ?? '<no-plugin>';
  return {
    method: 'POST',
    url: `/webhook-receiver/${id}`,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': '<uuid>',
      'x-webhook-source': plugin?.id ?? '',
    },
    body: payloadJson,
  };
}

function _legacyBuildResponseEnvelope(
  steps: TraceStep[],
  durationMs: number,
  forcedStatus: ForcedStatus,
) {
  const status = forcedStatus === 'auto' ? _legacyDeriveResponseStatus(steps) : Number(forcedStatus);
  const ok = status >= 200 && status < 300;
  const body =
    status === 0
      ? { ok: false, message: 'no run yet' }
      : ok
      ? { accepted: true, processed_steps: steps.length, duration_ms: durationMs }
      : {
          accepted: false,
          status,
          failed_step: steps.find((s) => !s.ok)?.name ?? null,
          duration_ms: durationMs,
        };
  return {
    status,
    ok,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': '<uuid>',
      'x-trace-step-count': String(steps.length),
    },
    body,
  };
}

*/

// ---------- module ----------

export function WebhookTesterModule() {
  const identity = useIdentity();
  const canReadWebhooks = useCapability(CAP.WEBHOOKS_READ);
  const canReadPluginDiagnostics = useCapability(CAP.INTEGRATION_PLUGINS_READ);
  const canAccessTester = canReadWebhooks || canReadPluginDiagnostics;
  const canRunPluginDiagnostics = useCapability(CAP.INTEGRATION_PLUGINS_TEST);
  // Receiver POST, linked inbox replay, and force status mutate webhook
  // resources; plugin diagnostics use the narrower integration plugin test cap.
  const canWriteWebhooks = useCapability(CAP.WEBHOOKS_WRITE);
  const seedDiagnosticsEnabled = api.isConsoleSeedModeEnabled();
  const liveBackendUnavailable = !seedDiagnosticsEnabled && !api.hasConsoleLiveBackend();
  const drawer = useDrawer();
  const go = useConsoleNavigator();
  const queryClient = useQueryClient();
  const tenantId = identity.currentTenantId();
  const pluginsListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const readQueryOptions = useMemo(() => ({ enabled: canAccessTester }), [canAccessTester]);
  const pluginsQuery = useResourceList<IntegrationPlugin>(
    'integration_plugins',
    pluginsListOpts,
    readQueryOptions,
  );
  const samplePayloadQuery = useResourceList<LookupValueRow>('lookup_values', {
    filter: {
      category: 'webhook_sample_payload',
      status: 'active',
    },
    sort: { key: 'sort_order', dir: 'asc' },
    page_size: 50,
  }, readQueryOptions);
  const [requestedPluginId] = useState<string | null>(() => readUrlParam('plugin_id'));
  const [requestedSourceId] = useState<string | null>(() => readUrlParam('source_id'));
  const [linkedInboxId] = useState<string | null>(() => readUrlParam('inbox_id'));
  const requestedSourceQueryOptions = useMemo(
    () => ({ enabled: canReadWebhooks && Boolean(requestedSourceId) }),
    [canReadWebhooks, requestedSourceId],
  );
  const requestedSourceQuery = useResourceList<WebhookSourceDirectoryRow>(
    'webhook_source_directory',
    requestedSourceId
      ? {
        filter: { id: requestedSourceId },
        page_size: 1,
      }
      : undefined,
    requestedSourceQueryOptions,
  );
  const linkedInboxQueryOptions = useMemo(
    () => ({ enabled: canReadWebhooks && Boolean(linkedInboxId) }),
    [canReadWebhooks, linkedInboxId],
  );
  const linkedInboxQuery = useResourceList<LinkedInboxContextRow>(
    'webhook_inbox_directory',
    linkedInboxId
      ? {
        filter: { id: linkedInboxId },
        page_size: 1,
      }
      : undefined,
    linkedInboxQueryOptions,
  );
  // W56-E — wrap in useMemo so the `?? []` fallback identity is stable across
  // renders; this lets the downstream useMemo (`activePlugin`) deps narrow to
  // the actual rows array instead of recomputing every render.
  const plugins = useMemo(() => pluginsQuery.data?.rows ?? [], [pluginsQuery.data]);
  const samplePayload = useMemo(
    () => resolveWebhookSamplePayload(samplePayloadQuery.data?.rows),
    [samplePayloadQuery.data],
  );
  const replayInbox = useReplayWebhookInbox();
  const forceInboxStatus = useForceWebhookInboxStatus();
  // Canonical forced-status options resolved through `webhook_forced_status`
  // lookup category (lib/seed-raw/lookups.js). Hardcoded array eliminated;
  // future tone/value updates flow through the canonical seed.
  const forcedStatusOptions = useMemo<Array<{ value: string; label?: string; tone?: string }>>(
    () => api.getLookups('webhook_forced_status') ?? [],
    [],
  );

  const [selectedPlugin, setSelectedPlugin] = useState<string>(requestedPluginId ?? '');
  const [payload, setPayload] = useState<string>('{}');
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [running, setRunning] = useState<boolean>(false);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [tab, setTab] = useState<InspectorTab>('request');
  const [forcedStatus, setForcedStatus] = useState<ForcedStatus>('auto');
  const [replayCount, setReplayCount] = useState<number>(0);
  const [linkedReplayResult, setLinkedReplayResult] = useState<Record<string, unknown> | null>(null);
  const [receiverToken, setReceiverToken] = useState<string>('');
  const [receiverReplayToken, setReceiverReplayToken] = useState<string | null>(null);
  const [receiverSignature, setReceiverSignature] = useState<string>('');
  const [receiverIdempotencyKey, setReceiverIdempotencyKey] = useState<string>(() => createReceiverIdempotencyKey());
  const [receiverRunning, setReceiverRunning] = useState<boolean>(false);
  const [receiverResult, setReceiverResult] = useState<ReceiverResult | null>(null);
  const [receiverReadbackRefreshing, setReceiverReadbackRefreshing] = useState<boolean>(false);
  const [receiverFailure, setReceiverFailure] = useState<ReceiverFailure | null>(null);
  function clearPluginRunEvidence() {
    setTrace([]);
    setLastDuration(null);
    setReplayCount(0);
    setLinkedReplayResult(null);
  }
  function clearReceiverPostEvidence() {
    setReceiverResult(null);
    setReceiverFailure(null);
    setReceiverReadbackRefreshing(false);
    setReceiverReplayToken(null);
  }
  function clearWebhookExecutionEvidence() {
    clearPluginRunEvidence();
    clearReceiverPostEvidence();
  }
  const receiverPendingMaterialization = Boolean(
    receiverResult &&
      !hasReceiverShipmentReadback(receiverResult) &&
      receiverResult.is_terminal !== true &&
      !isReceiverFailedStatus(receiverResult.webhook_processing_status),
  );
  const receiverTokenReady = receiverToken.trim().length > 0;

  useEffect(() => {
    const handoff = peekExternalIntakeSourceToken('webhook-tester');
    if (!handoff) return;
    setReceiverToken(handoff.token);
    setReceiverResult(null);
    setReceiverFailure(null);
    clearExternalIntakeSourceToken('webhook-tester');
    pushToast(
      handoff.source_name
        ? `Loaded one-time token for ${handoff.source_name}`
        : 'Loaded one-time source token',
      'good',
    );
  }, []);

  // Phase C5: when an operator opens the tester with a real `inbox_id`
  // (deep-link from /integrations/intake or Mapping remediation), Replay
  // routes to the canonical webhook_inbox_replay_v1 RPC instead of the
  // synthetic plugin trace, and the linked backend row remains visible before
  // another mutation is attempted.
  const headerPills = [
    <span key="src" className="chip chip--xs">Webhook receiver - mapping profiles</span>,
    <span key="mode" className="chip chip--xs mono">
      {seedDiagnosticsEnabled ? 'Review checks' : 'Hosted confirmation'}
    </span>,
  ];

  useEffect(() => {
    if (!plugins.length) return;
    if (requestedPluginId) {
      if (plugins.some((plugin) => plugin.id === requestedPluginId)) {
        if (selectedPlugin !== requestedPluginId) setSelectedPlugin(requestedPluginId);
        return;
      }
      if (selectedPlugin === requestedPluginId) setSelectedPlugin('');
      return;
    }
    if (!selectedPlugin || !plugins.some((plugin) => plugin.id === selectedPlugin)) {
      setSelectedPlugin(plugins[0]!.id);
    }
  }, [plugins, requestedPluginId, selectedPlugin]);

  useEffect(() => {
    if (!samplePayload) return;
    setPayload((current) => {
      const trimmed = current.trim();
      return trimmed === '' || trimmed === '{}'
        ? renderWebhookSamplePayloadTemplate(
            samplePayload,
            buildWebhookSampleTemplateContext(receiverIdempotencyKey),
          )
        : current;
    });
  }, [receiverIdempotencyKey, samplePayload]);

  useEffect(() => {
    if (
      !receiverResult ||
      receiverRunning ||
      receiverResult.is_terminal === true ||
      hasReceiverShipmentReadback(receiverResult) ||
      liveBackendUnavailable
    ) {
      setReceiverReadbackRefreshing(false);
      return undefined;
    }
    if (!receiverResult.webhook_id && !receiverResult.workflow_run_id && !receiverResult.correlation_id) {
      setReceiverReadbackRefreshing(false);
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      setReceiverReadbackRefreshing(true);
      try {
        const next = await refreshReceiverDirectoryReadback(receiverResult, receiverIdempotencyKey);
        if (cancelled) return;
        if (next) {
          setReceiverResult(next);
          if (hasReceiverShipmentReadback(next) || next.is_terminal === true) {
            setReceiverReadbackRefreshing(false);
            if (hasReceiverShipmentReadback(next)) {
              pushToast(
                `Receiver shipment confirmed - ${next.tracking_number ?? next.shipment_id}`,
                'good',
              );
            }
            return;
          }
        }
      } catch {
        // Keep accepted receiver evidence visible while the bounded readback loop
        // continues against the canonical inbox directory.
      }

      if (Date.now() - startedAt < RECEIVER_READBACK_REFRESH_TIMEOUT_MS) {
        timer = window.setTimeout(() => void poll(), RECEIVER_READBACK_REFRESH_INTERVAL_MS);
      } else {
        setReceiverReadbackRefreshing(false);
      }
    };

    timer = window.setTimeout(() => void poll(), RECEIVER_READBACK_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    liveBackendUnavailable,
    receiverIdempotencyKey,
    receiverResult,
    receiverRunning,
  ]);

  const activePlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPlugin),
    [plugins, selectedPlugin],
  );
  const requestedPluginMissing = Boolean(
    requestedPluginId &&
      plugins.length > 0 &&
      !plugins.some((plugin) => plugin.id === requestedPluginId),
  );
  const requestedSource = requestedSourceQuery.data?.rows?.[0] ?? null;
  const requestedSourceLabel =
    receiverString(requestedSource?.source_label) ??
    receiverString(requestedSource?.name) ??
    receiverString(requestedSource?.source_identifier) ??
    requestedSourceId;
  const linkedInboxContext = linkedInboxQuery.data?.rows?.[0] ?? null;
  const linkedInboxSourceLabel =
    receiverString(linkedInboxContext?.source_label) ??
    receiverString(linkedInboxContext?.source_identifier) ??
    'Webhook source';
  const linkedInboxMappingLabel =
    receiverString(linkedInboxContext?.mapping_label) ??
    receiverString(linkedInboxContext?.mapping_config_id) ??
    null;

  const requestEnvelope = useMemo(
    () => buildRequestEnvelope(activePlugin, payload),
    [activePlugin, payload],
  );

  const responseEnvelope = useMemo(
    () => buildResponseEnvelope(trace, lastDuration ?? 0, seedDiagnosticsEnabled ? forcedStatus : 'auto'),
    [trace, lastDuration, forcedStatus, seedDiagnosticsEnabled],
  );

  async function refreshReceiverInboxCaches() {
    await Promise.all(
      RECEIVER_INBOX_CACHE_RESOURCES.flatMap((resource) => [
        queryClient.invalidateQueries({ queryKey: ['list', resource], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: ['lists_by_filters', resource], refetchType: 'active' }),
      ]),
    );
    await Promise.all(
      RECEIVER_INBOX_CACHE_RESOURCES.flatMap((resource) => [
        queryClient.refetchQueries({ queryKey: ['list', resource], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['lists_by_filters', resource], type: 'active' }),
      ]),
    );
  }

  function openReceiverInboxEvent() {
    if (!receiverResult?.webhook_id) {
      pushToast('No inbox event confirmation yet.', 'warn');
      return;
    }
    const inboxPath = `/integrations/intake?inbox_id=${encodeURIComponent(receiverResult.webhook_id)}`;
    drawer.open({
      title: `Inbox event · ${receiverEventReference(receiverResult.webhook_id)}`,
      size: 'md',
      body: <ReceiverInboxEventDrawerBody result={receiverResult} />,
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <Button
            label="Open Intake module"
            iconName="inbox"
            kind="ghost"
            onClick={() => go(inboxPath)}
          />
          <div style={{ flex: 1 }} />
          {hasReceiverShipmentReadback(receiverResult) ? (
            <Button
              label="Open shipment drawer"
              iconName="package"
              kind="primary"
              onClick={openReceiverShipmentContext}
            />
          ) : null}
        </div>
      ),
    });
  }

  function openReceiverShipmentContext() {
    if (!hasReceiverShipmentReadback(receiverResult)) {
      pushToast('No successful shipment confirmation yet.', 'warn');
      return;
    }
    openShipmentContextDrawer(drawer, receiverResult.shipment_id, {
      fallbackShipment: receiverResult.tracking_number
        ? { tracking_number: receiverResult.tracking_number }
        : null,
    });
  }

  async function executeReceiverPost(options: { replayLastToken?: boolean } = {}) {
    if (receiverRunning) return;
    setReceiverFailure(null);
    let parsedPayload: unknown = {};
    const idempotencyForSubmit = receiverIdempotencyKey.trim() || createReceiverIdempotencyKey();
    if (!isReceiverIdempotencyKeyValid(idempotencyForSubmit)) {
      const message = 'Idempotency value must be a UUID. Use New idempotency before sending.';
      setReceiverFailure({
        message,
        idempotency_key: idempotencyForSubmit || 'not submitted',
        occurred_at: new Date().toISOString(),
      });
      setTab('response');
      pushToast(message, 'warn');
      return;
    }
    const payloadForSubmit = renderWebhookSamplePayloadTemplate(
      payload,
      buildWebhookSampleTemplateContext(idempotencyForSubmit),
    );
    try {
      parsedPayload = JSON.parse(payloadForSubmit);
      if (payloadForSubmit !== payload) {
        setPayload(payloadForSubmit);
      }
    } catch (err) {
      const message = `Invalid JSON - ${(err as Error).message}`;
      setReceiverFailure({
        message,
        idempotency_key: idempotencyForSubmit || 'not submitted',
        occurred_at: new Date().toISOString(),
      });
      setTab('response');
      pushToast(`Invalid JSON - ${(err as Error).message}`, 'danger');
      return;
    }
    const token = options.replayLastToken ? receiverReplayToken?.trim() ?? '' : receiverToken.trim();
    if (!token) {
      const message = options.replayLastToken
        ? 'Replay token is no longer available; rotate or paste a source token first'
        : 'Source token is required for a real receiver POST';
      setReceiverFailure({
        message,
        idempotency_key: receiverIdempotencyKey.trim() || 'not submitted',
        occurred_at: new Date().toISOString(),
      });
      setTab('response');
      pushToast(message, 'warn');
      return;
    }
    if (liveBackendUnavailable) {
      const message = 'Receiver request blocked - hosted intake is not configured';
      setReceiverFailure({
        message,
        idempotency_key: receiverIdempotencyKey.trim() || 'not submitted',
        occurred_at: new Date().toISOString(),
      });
      setTab('response');
      pushToast('Receiver request blocked - hosted intake is not configured', 'danger');
      return;
    }
    setReceiverRunning(true);
    setReceiverResult(null);
    setReceiverFailure(null);
    setReceiverReplayToken(token);
    let authRejectionReadbackAbort: AbortController | null = null;
    try {
      const receiverPostPromise = api.runWebhookReceiverTest({
        auth_token: token,
        payload: parsedPayload,
        idempotency_key: idempotencyForSubmit,
        signature: receiverSignature.trim() || undefined,
      }).then((result) => guardReceiverShipmentReadback(result));
      receiverPostPromise.catch(() => undefined);
      authRejectionReadbackAbort = new AbortController();
      const authRejectionReadbackPromise = waitForReceiverAuthRejectionReadback(
        idempotencyForSubmit,
        authRejectionReadbackAbort.signal,
      ).catch(() => null);
      const guardedResult = await Promise.race([
        receiverPostPromise,
        authRejectionReadbackPromise.then((result) => result ?? receiverPostPromise),
      ]);
      authRejectionReadbackAbort.abort();
      setReceiverResult(guardedResult);
      await refreshReceiverInboxCaches();
      const [message, tone] = receiverPostToast(guardedResult);
      pushToast(message, tone);
    } catch (err) {
      const message = (err as Error)?.message || 'Receiver request failed';
      setReceiverFailure({
        message,
        idempotency_key: receiverIdempotencyKey.trim() || 'not submitted',
        occurred_at: new Date().toISOString(),
      });
      setTab('response');
      pushToast(`Receiver request failed - ${(err as Error)?.message ?? ''}`, 'danger');
    } finally {
      authRejectionReadbackAbort?.abort();
      if (!options.replayLastToken) {
        clearExternalIntakeSourceToken('webhook-tester');
        setReceiverToken('');
      }
      setReceiverRunning(false);
    }
  }

  async function executeRun(isReplay: boolean) {
    if (running) return;
    if (isReplay && linkedInboxId && !canWriteWebhooks) {
      pushToast('Replay requires webhook update permission', 'danger');
      return;
    }
    if ((!isReplay || !linkedInboxId) && !canRunPluginDiagnostics) {
      pushToast('Plugin check requires integration plugin test permission', 'danger');
      return;
    }
    let parsedPayload: unknown = {};
    try {
      parsedPayload = JSON.parse(payload);
    } catch (err) {
      pushToast(`Invalid input · ${(err as Error).message}`, 'danger');
      return;
    }
    if (!activePlugin) {
      pushToast('Pick a plugin first', 'warn');
      return;
    }
    if (liveBackendUnavailable) {
      pushToast('Run blocked - live intake connection is not configured', 'danger');
      return;
    }
    setRunning(true);
    setTrace([]);
    setLastDuration(null);
    try {
      // CLAIM-INTEGRATIONS-WORKFLOWS-WIRING (Phase C5): if the tester is
      // deep-linked to a real `inbox_id`, Replay fires the canonical
      // webhook_inbox_replay_v1 RPC. Seed mode keeps the local diagnostic
      // plugin trace for ad-hoc payload testing without readiness proof.
      if (isReplay && linkedInboxId) {
        // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #1): canonical Phase B6 RPC
        // contract key is `webhook_inbox_id` (migration 202604280219). Send
        // canonical key directly; the api facade adapter still translates
        // `inbox_id` defensively.
        const replayResult = await replayInbox.mutateAsync({ webhook_inbox_id: linkedInboxId, reason: 'operator_replay' });
        setTrace([]);
        setLastDuration(null);
        setReplayCount((n) => n + 1);
        setLinkedReplayResult(replayResult);
        await refreshReceiverInboxCaches();
        const toast = formatWebhookReplayToast('Replay', replayResult, `Inbox event ${linkedInboxId}`);
        pushToast(toast.message, toast.tone);
        setTab('response');
        return;
      }
      const res = (await api.runPluginTest(activePlugin.id, parsedPayload)) as unknown as TraceResult;
      setTrace(res.steps ?? []);
      setLastDuration(res.duration_ms ?? 0);
      if (isReplay) {
        setReplayCount((n) => n + 1);
        pushToast(`Replay #${replayCount + 1} · ${res.duration_ms}ms`, 'good');
      } else {
        setReplayCount(0);
        pushToast(`Plugin check completed · ${res.duration_ms}ms`, 'good');
      }
    } catch (err) {
      pushToast(`Plugin check failed · ${(err as Error)?.message ?? ''}`, 'danger');
    } finally {
      setRunning(false);
    }
  }

  // Phase C5: when forcedStatus is changed and the tester is linked to a real
  // inbox row, persist the override via webhook_inbox_force_status_v1 so the
  // next worker pulse honours it. Cycle E P1 #7 closure: target_status
  // resolves through canonical `webhook_forced_status.metadata.target_status`
  // (no inline ternary on HTTP code). Missing canonical row fails loud
  // (toast + abort) so seed gaps are visible.
  async function persistForceStatus(next: ForcedStatus) {
    setForcedStatus(next);
    if (next === 'auto') return;
    if (!linkedInboxId) {
      if (seedDiagnosticsEnabled) {
        pushToast(`Outcome set · ${next}`, 'info');
      } else {
        pushToast('Changing outcome requires a linked webhook inbox.', 'danger');
      }
      return;
    }
    try {
      const canonicalRow = lookupRow('webhook_forced_status', String(next)) as
        | { metadata?: { target_status?: string } }
        | null;
      const status = canonicalRow?.metadata?.target_status;
      if (!status) {
        pushToast('Outcome option is missing; update webhook outcome lookups.', 'danger');
        return;
      }
      // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #2): canonical Phase B6 RPC
      // contract keys are `webhook_inbox_id` + `target_status` (migration
      // 202604280220). Send canonical keys directly.
      await forceInboxStatus.mutateAsync({
        webhook_inbox_id: linkedInboxId,
        target_status: status,
        reason: `operator_force_${next}`,
      });
      pushToast(
        seedDiagnosticsEnabled
          ? `Outcome set · ${next}`
          : `Outcome change requested · ${next}`,
        'info',
      );
    } catch (err) {
      pushToast(`Outcome change failed · ${(err as Error)?.message ?? ''}`, 'danger');
    }
  }

  function loadSample() {
    if (!samplePayload) {
      pushToast('Webhook sample payload lookup is missing', 'danger');
      return;
    }
    clearWebhookExecutionEvidence();
    setPayload(
      renderWebhookSamplePayloadTemplate(
        samplePayload,
        buildWebhookSampleTemplateContext(receiverIdempotencyKey),
      ),
    );
    pushToast('Sample payload loaded', 'info');
  }

  function refreshReceiverIdempotencyKey() {
    const previous = receiverIdempotencyKey;
    const next = createReceiverIdempotencyKey();
    setReceiverIdempotencyKey(next);
    clearReceiverPostEvidence();
    if (samplePayload) {
      setPayload((current) =>
        isRenderedWebhookSamplePayload(current, samplePayload, previous)
          ? renderWebhookSamplePayloadTemplate(samplePayload, buildWebhookSampleTemplateContext(next))
          : current,
      );
    }
  }

  if (!canAccessTester) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-webhook"
          eyebrow="External intake"
          titleAccent="Webhook"
          titlePlain="test requests"
          pills={headerPills}
        />
        <StateView
          kind="denied"
          capability={CAP.INTEGRATION_PLUGINS_READ}
          hint="You do not have permission to view webhook testing or plugin checks."
        />
      </div>
    );
  }

  if (pluginsQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-webhook"
          eyebrow="External intake"
          titleAccent="Webhook"
          titlePlain="test requests"
          pills={headerPills}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (pluginsQuery.error) {
    const pluginPermissionDenied = isPermissionDeniedError(pluginsQuery.error);
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-webhook"
          eyebrow="External intake"
          titleAccent="Webhook"
          titlePlain="test requests"
          pills={headerPills}
        />
        <StateView
          kind={pluginPermissionDenied ? 'denied' : 'error'}
          capability={pluginPermissionDenied ? CAP.INTEGRATION_PLUGINS_READ : undefined}
          title={pluginPermissionDenied ? 'Webhook plugin access required' : 'Webhook plugins unavailable'}
          hint={
            pluginPermissionDenied
              ? 'You do not have permission to read webhook test plugins.'
              : (pluginsQuery.error as Error).message
          }
        />
      </div>
    );
  }

  if (!plugins.length) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-webhook"
          eyebrow="External intake"
          titleAccent="Webhook"
          titlePlain="test requests"
          pills={headerPills}
        />
        <StateView
          kind="empty"
          title="No webhook test plugins"
          hint="Add an integration plugin before running provider intake tests."
        />
      </div>
    );
  }

  const hasRun = trace.length > 0 || lastDuration != null;
  const hasLinkedReplayReadback = Boolean(linkedReplayResult);
  const hasReceiverPostResponse = Boolean(receiverResult || receiverFailure);
  const hasInspectorResponse = hasRun || hasLinkedReplayReadback || hasReceiverPostResponse;
  const diagnosticReplayLabel = `Replay plugin check${replayCount ? ` (${replayCount})` : ''}`;
  const replayButtonLabel = linkedInboxId ? `Replay inbox${replayCount ? ` (${replayCount})` : ''}` : diagnosticReplayLabel;
  const forceStatusDisabled =
    !hasRun || !canWriteWebhooks || liveBackendUnavailable || (!seedDiagnosticsEnabled && !linkedInboxId);
  const replayCapability = linkedInboxId ? CAP.WEBHOOKS_WRITE : CAP.INTEGRATION_PLUGINS_TEST;
  const replayDenied = linkedInboxId ? !canWriteWebhooks : !canRunPluginDiagnostics;
  // Status tone resolution — canonical-first, HTTP-class second.
  //   1. When the response status equals a canonical `webhook_forced_status`
  //      value (200/400/422/500/503), tone resolves through the lookup row.
  //   2. Otherwise (status 0 = "no run yet", or any non-canonical HTTP code),
  //      fall back to HTTP status-class derivation (1xx/2xx/3xx → good,
  //      4xx → warn, 5xx → danger, 0 → neutral). No hardcoded value-to-tone
  //      ternary on canonical values.
  const statusTone: ChipKind = (() => {
    const code = responseEnvelope.status;
    if (code === 0) return 'neutral';
    const canonical = lookupRow('webhook_forced_status', String(code));
    if (canonical) return (canonical.tone as ChipKind | undefined) ?? 'neutral';
    if (code >= 500) return 'danger';
    if (code >= 400) return 'warn';
    return 'good';
  })();

  return (
    <div className="page">
      <PageHeader
        moduleKey="int-webhook"
        eyebrow="External intake"
        titleAccent="Test webhook"
        titlePlain="intake"
        pills={headerPills}
      />
      <ExternalIntakeWorkspaceToolbar activePath="/integrations/webhook-tester" />
      {liveBackendUnavailable ? (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          <StateView
            kind="error"
            title="Live intake setup required"
            hint="Live webhook testing is unavailable until the hosted intake connection is configured."
          />
        </div>
      ) : null}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* LEFT — payload editor */}
        <div
          style={{
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            borderRight: '1px solid var(--line)',
            overflow: 'auto',
          }}
        >
          <label className="eyebrow" htmlFor="webhook-tester-plugin">Plugin</label>
          {(requestedPluginId || requestedSourceId) ? (
            <div
              className="card"
              data-testid="webhook-tester-catalog-handoff"
              style={{ background: 'var(--paper-2)', display: 'grid', gap: '6px' }}
            >
              <div className="dt-toolbar" style={{ margin: 0 }}>
                <span className="eyebrow">Catalog handoff</span>
                <Chip
                  label={
                    requestedPluginMissing
                      ? `plugin unavailable - ${requestedPluginId}`
                      : activePlugin
                        ? `plugin - ${activePlugin.name}`
                        : `plugin - ${requestedPluginId ?? 'pending'}`
                  }
                  size="xs"
                  kind={requestedPluginMissing ? 'danger' : activePlugin ? 'good' : 'warn'}
                />
                {requestedSourceId ? (
                  <Chip
                    label={`source - ${requestedSourceLabel ?? requestedSourceId}`}
                    size="xs"
                    kind={requestedSource ? 'good' : 'warn'}
                  />
                ) : null}
              </div>
              {requestedPluginMissing ? (
                <p className="state__hint" style={{ margin: 0 }}>
                  The selected catalog plugin is no longer visible in this tester scope. Choose another visible plugin before running checks.
                </p>
              ) : null}
            </div>
          ) : null}
          {linkedInboxId ? (
            <div
              className="card"
              data-testid="webhook-tester-linked-inbox-context"
              aria-label="Linked inbox remediation context"
              style={{ background: 'var(--paper-2)', display: 'grid', gap: '8px' }}
            >
              <div className="dt-toolbar" style={{ margin: 0 }}>
                <span className="eyebrow">Linked inbox remediation</span>
                <Chip
                  label={
                    linkedInboxQuery.isLoading
                      ? 'loading confirmation'
                      : linkedInboxContext
                        ? String(linkedInboxContext.processing_status ?? 'status pending')
                        : 'not visible'
                  }
                  size="xs"
                  kind={
                    linkedInboxQuery.isLoading
                      ? 'neutral'
                      : linkedInboxContext
                        ? receiverOutcomeTone({
                          webhook_processing_status: linkedInboxContext.processing_status,
                        } as ReceiverResult)
                        : 'danger'
                  }
                />
                <Chip label={linkedInboxSourceLabel} size="xs" kind={linkedInboxContext ? 'info' : 'warn'} />
              </div>
              <div className="kvgrid">
                <div className="kvgrid__row">
                  <span className="kvgrid__key mono">Event</span>
                  <span className="kvgrid__val mono">{linkedInboxId}</span>
                </div>
                <div className="kvgrid__row">
                  <span className="kvgrid__key mono">Mapping</span>
                  <span className="kvgrid__val mono">
                    {linkedInboxMappingLabel ?? 'pending confirmation'}
                    {linkedInboxContext?.mapping_target ? (
                      <span style={{ color: 'var(--ink-3)' }}> - {linkedInboxContext.mapping_target}</span>
                    ) : null}
                  </span>
                </div>
                <div className="kvgrid__row">
                  <span className="kvgrid__key mono">Replay</span>
                  <span className="kvgrid__val mono">
                    {linkedInboxContext?.replay_count != null ? `${linkedInboxContext.replay_count} attempts` : 'pending confirmation'}
                  </span>
                </div>
                <div className="kvgrid__row">
                  <span className="kvgrid__key mono">Last error</span>
                  <span className="kvgrid__val mono">
                    {redactSensitiveText(receiverString(linkedInboxContext?.error_message) ?? 'none projected')}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {linkedInboxContext?.mapping_config_id ? (
                  <Button
                    label="Open mapping remediation"
                    iconName="edit"
                    kind="ghost"
                    capability={CAP.MAPPINGS_READ}
                    onClick={() => {
                      go(
                        `/integrations/mapping?focus=${encodeURIComponent(linkedInboxContext.mapping_config_id!)}&inbox_id=${encodeURIComponent(linkedInboxId)}`,
                      );
                    }}
                  />
                ) : null}
                <Button
                  label="Open linked inbox event"
                  iconName="eye"
                  kind="ghost"
                  capability={CAP.WEBHOOKS_READ}
                  onClick={() => go(`/integrations/intake?inbox_id=${encodeURIComponent(linkedInboxId)}`)}
                />
              </div>
            </div>
          ) : null}
          <select
            id="webhook-tester-plugin"
            className="field"
            value={selectedPlugin}
            onChange={(e) => {
              clearWebhookExecutionEvidence();
              setSelectedPlugin(e.target.value);
            }}
          >
            {requestedPluginMissing ? (
              <option value="">Catalog plugin unavailable</option>
            ) : null}
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.version}
              </option>
            ))}
          </select>
          <label className="eyebrow" htmlFor="webhook-tester-payload">Sample payload</label>
          <textarea
            id="webhook-tester-payload"
            rows={16}
            className="wf-code-block wf-code-block--editable"
            style={{
              width: '100%',
              fontFamily: 'var(--font-mono)',
              fontSize: '11.5px',
            }}
            value={payload}
            onChange={(e) => {
              clearWebhookExecutionEvidence();
              setPayload(e.target.value);
            }}
          />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              label={running ? 'Running…' : 'Run plugin check'}
              iconName="play"
              kind="primary"
              capability={CAP.INTEGRATION_PLUGINS_TEST}
              onClick={() => void executeRun(false)}
              disabled={running || !activePlugin || liveBackendUnavailable}
            />
            <Button
              label={replayButtonLabel}
              iconName="refresh"
              kind="ghost"
              capability={replayCapability}
              onClick={() => void executeRun(true)}
              disabled={running || !activePlugin || !hasRun || liveBackendUnavailable || replayDenied}
            />
            <Button label="Load sample" iconName="copy" kind="ghost" onClick={loadSample} />
            <div style={{ flex: 1 }} />
            <label
              className="mono"
              style={{ fontSize: '10.5px', color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: '6px' }}
              htmlFor="webhook-tester-force-status"
            >
              {seedDiagnosticsEnabled ? 'Set expected outcome' : 'Set inbox outcome'}
              <select
                id="webhook-tester-force-status"
                className="field"
                style={{ fontSize: '11px', padding: '2px 6px' }}
                value={forcedStatus}
                onChange={(e) => void persistForceStatus(e.target.value as ForcedStatus)}
                disabled={forceStatusDisabled}
                title={
                  !canWriteWebhooks
                    ? 'Requires webhook update permission'
                    : liveBackendUnavailable
                      ? 'Configure hosted intake before changing the outcome'
                      : !seedDiagnosticsEnabled && !linkedInboxId
                      ? 'Open from an inbox row to change the outcome'
                      : undefined
                }
              >
                {forcedStatusOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label ?? s.value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="card" style={{ background: 'var(--paper-2)', display: 'grid', gap: '8px' }}>
            <div>
              <div className="eyebrow">Receiver request</div>
              <p className="state__hint" style={{ margin: '4px 0 0' }}>
                Sends this test data through the webhook receiver using a one-time source token from Sources & tokens.
              </p>
            </div>
            <label className="field" htmlFor="webhook-receiver-token">
              <span className="field__label">Source token</span>
              <input
                id="webhook-receiver-token"
                type="password"
                autoComplete="off"
                value={receiverToken}
                onChange={(event) => {
                  clearReceiverPostEvidence();
                  clearExternalIntakeSourceToken('webhook-tester');
                  setReceiverToken(event.target.value);
                }}
                placeholder="Paste source token returned on create/rotate"
              />
              {!receiverTokenReady ? (
                <span className="field__hint">Rotate or create a source token before sending a receiver POST.</span>
              ) : null}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <label className="field" htmlFor="webhook-receiver-idempotency">
                <span className="field__label">Idempotency key</span>
                <input
                  id="webhook-receiver-idempotency"
                  value={receiverIdempotencyKey}
                  aria-invalid={
                    receiverIdempotencyKey.trim() !== '' && !isReceiverIdempotencyKeyValid(receiverIdempotencyKey)
                      ? true
                      : undefined
                  }
                  onChange={(event) => {
                    clearReceiverPostEvidence();
                    setReceiverIdempotencyKey(event.target.value);
                  }}
                />
                {receiverIdempotencyKey.trim() !== '' && !isReceiverIdempotencyKeyValid(receiverIdempotencyKey) ? (
                  <span className="field__hint">Use a UUID idempotency key for receiver backend readback.</span>
                ) : null}
              </label>
              <label className="field" htmlFor="webhook-receiver-signature">
                <span className="field__label">HMAC signature</span>
                <input
                  id="webhook-receiver-signature"
                  value={receiverSignature}
                  onChange={(event) => {
                    clearReceiverPostEvidence();
                    setReceiverSignature(event.target.value);
                  }}
                  placeholder="Optional x-signature"
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                label={receiverRunning ? 'Sending' : 'Send receiver request'}
                iconName="send"
                kind="primary"
                capability={CAP.WEBHOOKS_WRITE}
                onClick={() => void executeReceiverPost()}
                disabled={receiverRunning || liveBackendUnavailable || !receiverTokenReady}
                title={!receiverTokenReady ? 'Paste a source token before sending a receiver POST' : undefined}
              />
              <Button
                label="New idempotency key"
                iconName="refresh"
                kind="ghost"
                onClick={refreshReceiverIdempotencyKey}
                disabled={receiverRunning}
              />
              <Button
                label="Replay receiver POST"
                iconName="rotate-cw"
                kind="ghost"
                capability={CAP.WEBHOOKS_WRITE}
                onClick={() => void executeReceiverPost({ replayLastToken: true })}
                disabled={receiverRunning || liveBackendUnavailable || !receiverReplayToken}
                title={
                  receiverReplayToken
                    ? 'Replay the last receiver POST with the same idempotency key'
                    : 'Send a receiver POST before replaying'
                }
              />
            </div>
            {receiverRunning ? (
              <div
                className="state state--info"
                aria-label="Receiver request progress"
                style={{ padding: '10px 12px', borderRadius: '8px' }}
              >
                <div className="state__title">Receiver request in progress</div>
                <div className="state__hint">
                  Waiting for webhook receiver and backend readback for idempotency {receiverIdempotencyKey.trim() || '-'}.
                </div>
              </div>
            ) : null}
            {receiverResult ? (
              <div style={{ display: 'grid', gap: '8px' }}>
                <div className="kvgrid" aria-label="Receiver request evidence">
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Workflow</span>
                    <span className="kvgrid__val mono">{receiverResult.workflow_run_id ?? '-'}</span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Webhook</span>
                    <span className="kvgrid__val mono">{receiverResult.webhook_id ?? 'pending confirmation'}</span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Correlation</span>
                    <span className="kvgrid__val mono">{receiverResult.correlation_id ?? '-'}</span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Status</span>
                    <span className="kvgrid__val mono">
                      {humanizeReceiverOutcome(receiverResult.webhook_processing_status) ?? 'pending confirmation'}
                      {typeof receiverResult.is_terminal === 'boolean' ? (
                        <span style={{ color: 'var(--ink-3)' }}>
                          {' '}
                          {receiverResult.is_terminal ? 'terminal' : 'not terminal'}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Receiver outcome</span>
                    <span className="kvgrid__val mono">
                      <Chip kind={receiverOutcomeTone(receiverResult)} label={receiverOutcomeValue(receiverResult) ?? 'pending confirmation'} />
                      {receiverResult.ack_status_code != null ? (
                        <span style={{ color: 'var(--ink-3)' }}> HTTP {receiverResult.ack_status_code}</span>
                      ) : null}
                      {receiverResult.idempotency_key ? (
                        <span style={{ color: 'var(--ink-3)' }}> · Idempotency {receiverResult.idempotency_key}</span>
                      ) : null}
                      {receiverResult.ack_reason && !isReceiverAuthRejectionResult(receiverResult) ? (
                        <span style={{ color: 'var(--ink-3)' }}> · {receiverResult.ack_reason}</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Source</span>
                    <span className="kvgrid__val mono">
                      {receiverResult.source_label ??
                        receiverResult.auth_rejection_source_label ??
                        receiverResult.source_identifier ??
                        receiverResult.auth_rejection_source_identifier ??
                        'pending confirmation'}
                      {receiverResult.provider_type_label ? (
                        <span style={{ color: 'var(--ink-3)' }}> · {receiverResult.provider_type_label}</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Mapping</span>
                    <span className="kvgrid__val mono">
                      {receiverResult.mapping_label ?? receiverResult.mapping_config_id ?? 'pending confirmation'}
                      {receiverResult.mapping_target ? (
                        <span style={{ color: 'var(--ink-3)' }}> · {receiverResult.mapping_target}</span>
                      ) : null}
                      {receiverResult.mapping_version != null ? (
                        <span style={{ color: 'var(--ink-3)' }}> · v{receiverResult.mapping_version}</span>
                      ) : null}
                    </span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Shipment</span>
                    <span className="kvgrid__val mono">
                      {hasReceiverShipmentReadback(receiverResult)
                        ? receiverResult.tracking_number ?? receiverResult.shipment_id
                        : isReceiverAuthRejectionResult(receiverResult)
                        ? 'not created - authentication rejected'
                        : isReceiverFailedStatus(receiverResult.webhook_processing_status)
                        ? 'not created - failed'
                        : receiverResult.tracking_number
                        ? `${receiverResult.tracking_number} (pending shipment confirmation)`
                        : 'not created yet'}
                    </span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Intent</span>
                    <span className="kvgrid__val mono">{receiverResult.canonical_intent ?? '-'}</span>
                  </div>
                  {receiverResult.error_message ? (
                    <div className="kvgrid__row">
                      <span className="kvgrid__key mono">Error</span>
                      <span className="kvgrid__val mono">{redactSensitiveText(receiverResult.error_message)}</span>
                    </div>
                  ) : null}
                  {isReceiverAuthRejectionResult(receiverResult) ? (
                    <>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Authentication check</span>
                        <span className="kvgrid__val mono">
                          Rejected
                          {receiverResult.auth_rejection_http_status != null ? (
                            <span style={{ color: 'var(--ink-3)' }}> · HTTP {receiverResult.auth_rejection_http_status}</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Source match</span>
                        <span className="kvgrid__val mono">
                          {receiverResult.auth_rejection_source_resolved === true ? 'Matched source' : 'Source could not be matched'}
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
                {isDiagnosticReceiverResult(receiverResult) ? (
                  <div className="state state--warn" style={{ padding: '10px 12px', borderRadius: '8px' }}>
                    <div className="state__title">Check only</div>
                    <div className="state__hint">
                      This receiver result is for review only.
                    </div>
                  </div>
                ) : null}
                {receiverPendingMaterialization || receiverReadbackRefreshing ? (
                  <div className="state state--info" style={{ padding: '10px 12px', borderRadius: '8px' }}>
                    <div className="state__title">Shipment confirmation pending</div>
                    <div className="state__hint">
                      Shipment confirmation is still being completed.
                    </div>
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }} aria-label="Receiver request actions">
                  <Button
                    label="Open receiver inbox event"
                    iconName="inbox"
                    kind="ghost"
                    onClick={openReceiverInboxEvent}
                    disabled={!receiverResult.webhook_id}
                  />
                  <Button
                    label="Open shipment drawer"
                    iconName="package"
                    kind="primary"
                    onClick={openReceiverShipmentContext}
                    disabled={!hasReceiverShipmentReadback(receiverResult)}
                  />
                </div>
              </div>
            ) : null}
            {receiverFailure ? (
              <div
                className="state state--error"
                aria-label="Receiver request failure"
                style={{ padding: '10px 12px', borderRadius: '8px' }}
              >
                <div className="state__title">Receiver request failed</div>
                <div className="state__hint">{redactSensitiveText(receiverFailure.message)}</div>
                <div className="kvgrid" style={{ marginTop: '8px' }}>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Idempotency</span>
                    <span className="kvgrid__val mono">{receiverFailure.idempotency_key}</span>
                  </div>
                  <div className="kvgrid__row">
                    <span className="kvgrid__key mono">Time</span>
                    <span className="kvgrid__val mono">{receiverFailure.occurred_at}</span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          {lastDuration != null ? (
            <div className="card" style={{ background: 'var(--paper-2)', minHeight: '40px' }}>
              <div className="mono" style={{ fontSize: '11px' }}>
                <span style={{ color: 'var(--ink-3)' }}>Last run · </span>
                <span style={{ fontWeight: 600 }}>{lastDuration}ms</span>
                <span style={{ color: 'var(--ink-3)', marginLeft: '6px' }}>
                  ({trace.length} step{trace.length === 1 ? '' : 's'})
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {/* RIGHT — run review + request/response summary */}
        <div style={{ padding: '16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <section aria-label="Run review">
            <div className="eyebrow">Run steps</div>
            <div className="timeline" style={{ padding: '8px 0', minHeight: '120px' }}>
              {trace.length === 0 ? (
                <StateView
                  kind="empty"
                  title="No run yet"
                  hint="Run a plugin check, or use Receiver request for webhook intake and shipment confirmation."
                />
              ) : (
                trace.map((s, i) => (
                  <div
                    key={i}
                    className={`timeline__row ${s.ok ? '' : 'is-failed'}`}
                  >
                    <span className="timeline__node" />
                    <span className="timeline__time mono">{s.ms}ms</span>
                    <div className="timeline__body">
                      <div className="timeline__action">{formatTraceStepLabel(s.name)}</div>
                      <div className="timeline__detail mono">
                        {s.ok ? 'Completed' : 'Needs attention'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section aria-label="Request and response summary" data-testid="inspector">
            <div
              role="tablist"
              aria-label="Summary tabs"
              style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--line)' }}
            >
              <InspectorTabButton id="request" active={tab === 'request'} onSelect={setTab}>
                Request
              </InspectorTabButton>
              <InspectorTabButton id="response" active={tab === 'response'} onSelect={setTab}>
                Response
                {hasRun ? (
                  <span style={{ marginInlineStart: '6px' }}>
                    <Chip
                      label={responseEnvelope.ok ? 'Completed' : 'Needs attention'}
                      kind={statusTone}
                      size="xs"
                    />
                  </span>
                ) : hasLinkedReplayReadback ? (
                  <span style={{ marginInlineStart: '6px' }}>
                    <Chip
                      label={linkedReplayOutcomeLabel(linkedReplayResult)}
                      kind={webhookReplayWasPreserved(linkedReplayResult) ? 'warn' : 'good'}
                      size="xs"
                    />
                  </span>
                ) : receiverResult ? (
                  <span style={{ marginInlineStart: '6px' }}>
                    <Chip
                      label={receiverOutcomeValue(receiverResult) ?? String(receiverResult.receiver_status ?? 202)}
                      kind={receiverOutcomeTone(receiverResult)}
                      size="xs"
                    />
                  </span>
                ) : receiverFailure ? (
                  <span style={{ marginInlineStart: '6px' }}>
                    <Chip label="Receiver failed" kind="danger" size="xs" />
                  </span>
                ) : null}
              </InspectorTabButton>
            </div>

            {tab === 'request' ? (
              <div id="inspector-request" role="tabpanel" aria-label="Request summary" data-testid="inspector-request">
                <StateView
                  kind="empty"
                  title="Request prepared"
                  hint="The receiver request is ready. Sensitive headers and request content stay hidden in this summary."
                />
              </div>
            ) : (
              <div id="inspector-response" role="tabpanel" aria-label="Response summary" data-testid="inspector-response">
                {receiverResult ? (
                  <>
                    <h4 className="eyebrow">Receiver request confirmation</h4>
                    <div className="kvgrid" aria-label="Receiver request confirmation">
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Status</span>
                        <span className="kvgrid__val mono">
                          <Chip
                            label={receiverStatusLabel(receiverResult)}
                            kind={receiverOutcomeTone(receiverResult)}
                            size="xs"
                          />
                        </span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Outcome</span>
                        <span className="kvgrid__val mono">
                          <Chip
                            kind={receiverOutcomeTone(receiverResult)}
                            label={receiverOutcomeValue(receiverResult) ?? 'Accepted'}
                          />
                          {receiverResult.ack_reason && !isReceiverAuthRejectionResult(receiverResult) ? (
                            <span style={{ color: 'var(--ink-3)' }}> - {receiverResult.ack_reason}</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Idempotency</span>
                        <span className="kvgrid__val mono">{receiverResult.idempotency_key ?? '-'}</span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Webhook</span>
                        <span className="kvgrid__val mono">
                          {receiverResult.webhook_id ??
                            (isReceiverAuthRejectionResult(receiverResult) ? 'not created - auth rejected' : 'pending confirmation')}
                        </span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Correlation</span>
                        <span className="kvgrid__val mono">{receiverResult.correlation_id ?? '-'}</span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Shipment</span>
                        <span className="kvgrid__val mono">
                          {hasReceiverShipmentReadback(receiverResult)
                            ? receiverResult.tracking_number ?? receiverResult.shipment_id
                            : isReceiverAuthRejectionResult(receiverResult)
                            ? 'not created - authentication rejected'
                            : isReceiverFailedStatus(receiverResult.webhook_processing_status)
                            ? 'not created - failed'
                            : 'not created yet'}
                        </span>
                      </div>
                      {isReceiverAuthRejectionResult(receiverResult) ? (
                        <div className="kvgrid__row">
                          <span className="kvgrid__key mono">Authentication check</span>
                          <span className="kvgrid__val mono">
                            Rejected
                          </span>
                        </div>
                      ) : null}
                    </div>
                    <div className="eyebrow" style={{ marginTop: '10px' }}>Body</div>
                    <pre className="wf-code-block" tabIndex={0} aria-label="Receiver response body">
{JSON.stringify(redactJsonForOperator(receiverResult.response ?? {}), null, 2)}
                    </pre>
                  </>
                ) : receiverFailure ? (
                  <>
                    <StateView
                      kind="error"
                      title="Receiver request failed"
                      hint={redactSensitiveText(receiverFailure.message)}
                    />
                    <div className="kvgrid" aria-label="Receiver request failure details" style={{ marginTop: '10px' }}>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Idempotency</span>
                        <span className="kvgrid__val mono">{receiverFailure.idempotency_key}</span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Occurred</span>
                        <span className="kvgrid__val mono">{receiverFailure.occurred_at}</span>
                      </div>
                    </div>
                  </>
                ) : hasLinkedReplayReadback ? (
                  <>
                    <h4 className="eyebrow">Linked inbox replay confirmation</h4>
                    <div className="kvgrid" aria-label="Linked inbox replay confirmation">
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Event</span>
                        <span className="kvgrid__val mono">
                          {String(linkedReplayResult?.webhook_inbox_id ?? linkedInboxId ?? 'pending confirmation')}
                        </span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Outcome</span>
                        <span className="kvgrid__val mono">{linkedReplayOutcomeLabel(linkedReplayResult)}</span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Prior status</span>
                        <span className="kvgrid__val mono">
                          {String(linkedReplayResult?.prior_status ?? linkedReplayResult?.preserved_status ?? '-')}
                        </span>
                      </div>
                      <div className="kvgrid__row">
                        <span className="kvgrid__key mono">Confirmation</span>
                        <span className="kvgrid__val mono">Inbox and directory updated</span>
                      </div>
                    </div>
                    <div className="state__hint" style={{ marginTop: '8px' }}>
                      Linked inbox replay uses the saved inbox event; plugin checks are not rerun.
                    </div>
                  </>
                ) : hasRun ? (
                  <>
                    <div className="state__hint" style={{ marginBottom: '8px' }}>
                      Plugin checks validate the plugin contract only. Use Receiver request for webhook intake and shipment confirmation.
                    </div>
                    <KvLine
                      label="Outcome"
                      value={
                        <Chip
                          label={responseEnvelope.ok ? 'Completed' : 'Needs attention'}
                          kind={statusTone}
                          size="xs"
                        />
                      }
                    />
                    {forcedStatus !== 'auto' ? (
                      <div className="state__hint" style={{ marginTop: '4px' }}>
                        {seedDiagnosticsEnabled
                          ? 'Showing the selected test response.'
                          : 'Inbox outcome change requested. The last actual response is preserved.'}
                      </div>
                    ) : null}
                    <StateView
                      kind={responseEnvelope.ok ? 'empty' : 'error'}
                      title="Plugin check completed"
                      hint="Sensitive response headers and body content stay hidden in this summary."
                    />
                  </>
                ) : (
                  <StateView
                    kind="empty"
                    title="No response yet"
                    hint={
                      seedDiagnosticsEnabled
                        ? 'Run a test to see the webhook response.'
                        : 'Run a test to see the webhook response.'
                    }
                  />
                )}
              </div>
            )}
          </section>
        </div>
      </div>
      {drawer.node}
    </div>
  );
}

interface InspectorTabButtonProps {
  id: InspectorTab;
  active: boolean;
  onSelect: (tab: InspectorTab) => void;
  children: React.ReactNode;
}

function InspectorTabButton({ id, active, onSelect, children }: InspectorTabButtonProps) {
  return (
    <button
      role="tab"
      aria-selected={active}
      aria-controls={`inspector-${id}`}
      type="button"
      onClick={() => onSelect(id)}
      style={{
        background: 'transparent',
        border: 0,
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        padding: '6px 10px',
        fontSize: '12px',
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--ink-1)' : 'var(--ink-3)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function KvLine({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '4px 0', fontSize: '11.5px' }}>
      <span className="mono" style={{ color: 'var(--ink-3)', minWidth: '70px' }}>{label}</span>
      <span className={mono ? 'mono' : undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </span>
    </div>
  );
}

// api-gateway.tsx — Insights · API gateway observability (Wave 3, Phase C / F).
//
// Datadog APM / Honeycomb / Postman observability parity surface for the
// canonical API gateway tables:
//   • api_call_log              (per-request execution log)
//   • api_gateway_requests      (route/route_pack joined projection)
//   • api_gateway_rate_limits   (current per-source × route windowed counters)
//   • api_routes                (registered routes per route_pack)
//   • api_route_packs           (versioned route bundles)
//   • provider_health_logs      (downstream provider latency cross-link)
//
// Capability gating:
//   • api_gateway.read   — list/inspect this surface (page, drawer, KPI strip)
//   • api_gateway.write  — block source / adjust rate limit
//
// Layout:
//   1. PageHeader with KPI-summary pills + 2 capability-gated actions
//      (Block source / Adjust rate limit).
//   2. KPI strip (4 cards): requests last 1h / error rate last 1h /
//      p95 latency last 1h / rate-limited count last 1h.
//   3. Filter chips bar: time range (1h/6h/24h/7d), route_pack, status class
//      (2xx/4xx/5xx), source, "rate-limited only" toggle, live-tail toggle.
//   4. DataTable (most-recent first) with method/path/status/duration/source
//      columns. Live-tail prepends new rows when toggled on (see below).
//   5. Multi-tab Drawer per row: Request / Response / Latency / Rate limit /
//      Replay. Authorization header is redacted in the Request tab.
//
// ============================================================================
// LIVE-TAIL ENV CONTRACT (Phase F)
// ============================================================================
// The live-tail behaviour is environment-conditional and zero-hardcoded:
//
//   • DEV PREVIEW mode: when `VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL=true`
//     and the app runs in development/test, the surface uses the deterministic
//     `synthesizeRow` generator on the row-driven preview interval so local
//     operators can exercise the live-tail UI without a backend.
//
//   • LIVE mode: when `VITE_REALTIME_ENABLED=true` AND a Supabase client is
//     available, the surface subscribes to `postgres_changes` on
//     `public.api_call_log` via `client.channel('api_call_log')`. INSERT
//     payloads are shaped through `shapeRealtimePayload` and prepended onto
//     the live buffer (capped at 250 rows). The synthesizer is bypassed.
//
// Production has no synthetic fallback: when Realtime is unavailable, live-tail
// is disabled and base rows still render from canonical api_call_log reads.
// Both active modes obey the same filter chips, buffer cap, and drawer header
// redaction rules. See `apps/console-v2/.env.example` for the env contract and
// `apps/console-v2/src/lib/supabase.ts` for the factory.
// ============================================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { PageHeader } from '@/components/PageHeader';
import { CAP } from "@/lib/capabilities";
import { Chip, type ChipKind } from '@/components/Chip';
import { Button } from '@/components/Button';
import { KPICard, type KPITone } from '@/components/KPICard';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import {
  DataTable,
  type DataTableColumn,
  type DataTableAction,
} from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { sanitizeOperatorMessage } from '@/components/operatorMessages';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useAdjustApiGatewayRateLimit,
  useBlockApiGatewaySource,
  useRunApiGatewayRequestTest,
  useUpsertApiGatewayRouteMapping,
  useResource,
  useResourceList,
  useResolveSettings,
} from '@/lib/queries';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { useCapability, useIdentity } from '@/lib/identity';
import { pushToast } from '@/components/toastStore';
import { clampByRange, RANGE_OPTIONS, type RangeKey } from './_shared';
import { formatApiGatewayRoutePayloadTemplate } from './_api-gateway.payload';
import {
  clearExternalIntakeSourceToken,
  peekExternalIntakeSourceToken,
  type ExternalIntakeTokenHandoff,
} from '@/lib/external-intake-token-handoff';
import { prettyOperatorJson as prettyJson } from '@/lib/operator-redaction';
import {
  lookupRow,
  ui_get_resource_v1,
  ui_list_resource_v1,
  type RunApiGatewayRequestTestResult,
} from '@/lib/api';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import {
  openWorkflowRunContextDrawer,
  type WorkflowRunContextRecord,
  type WorkflowRunDomainEvent,
} from '@/modules/workflows/workflow-run-context';
import { openApiGatewayOutboundLifecycleDrawer } from './_api-gateway.lifecycle';
import {
  API_GATEWAY_TEST_READBACK_MAX_ATTEMPTS,
  API_GATEWAY_TEST_READBACK_POLL_INTERVAL_MS,
  apiGatewayRequestReadbackIsTerminal,
  mergeApiGatewayTestResultWithReadback,
  readApiGatewayTestRequestReadback,
  requestReadbackFromGatewayTestResult,
  type ApiGatewayRequestReadback,
} from './_api-gateway.request-polling';
import {
  isRealtimeEnabled,
  isSyntheticLiveTailAllowed,
  latencyKind,
  methodKind,
  p95,
  pct,
  prettyOperatorJson,
  redactHeader,
  redactSensitiveText,
  shapeRealtimePayload,
  statusClass,
  statusKind,
  synthesizeRow,
} from './_api-gateway.helpers';
import { getSupabaseClient } from '@/lib/supabase';
import { ExternalIntakeWorkspaceToolbar } from '@/modules/integrations/ExternalIntakeWorkspaceToolbar';
import { fill, useI18n, type Translate } from '@/lib/i18n';
import { scopeT } from '@/lib/i18n-catalog';

const API_GATEWAY_TEST_UI_TIMEOUT_MS = 35_000;
const API_GATEWAY_VIEW_KEYS = ['live', 'requests', 'auth', 'routes', 'sources'] as const;
type ApiGatewayView = (typeof API_GATEWAY_VIEW_KEYS)[number];

function apiCallLiveRowKey(row: ApiCallRow): string | null {
  const key = row.id ?? row.request_id;
  return key == null ? null : String(key);
}

function prependApiCallLiveRow(rows: ApiCallRow[], next: ApiCallRow, cap: number): ApiCallRow[] {
  const nextKey = apiCallLiveRowKey(next);
  const deduped = nextKey == null ? rows : rows.filter((row) => apiCallLiveRowKey(row) !== nextKey);
  return [next, ...deduped].slice(0, cap);
}

function isApiGatewayView(value: unknown): value is ApiGatewayView {
  return typeof value === 'string' && API_GATEWAY_VIEW_KEYS.includes(value as ApiGatewayView);
}

function apiGatewayViewFromLocation(): ApiGatewayView {
  if (typeof window === 'undefined') return 'live';
  const requested = new URLSearchParams(window.location.search).get('view');
  return isApiGatewayView(requested) ? requested : 'live';
}

function apiGatewayWorkspaceActivePath(view: ApiGatewayView): string {
  if (view === 'requests') return '/insights/api-gateway?view=requests';
  if (view === 'auth') return '/insights/api-gateway?view=auth';
  return '/insights/api-gateway';
}

function apiGatewayRoutePackFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('routePackId')?.trim() ?? '';
}

function apiGatewayFocusRouteFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('focusRoute')?.trim() ?? '';
}

function withApiGatewayTestUiTimeout<T>(promise: Promise<T>, t: Translate): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(t('insightsApiGateway.withApiGatewayTestUiTimeout.apiGatewayTestDid')));
    }, API_GATEWAY_TEST_UI_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ─── Types ───────────────────────────────────────────────────────────────
//
// W14-2 closure (see __audit__/SCHEMA-DRIFT/INSIGHTS.md §1-§2):
//
// The FE row interfaces below now consume canonical projection views which
// close the W11/W13-deferred ApiCallRow (8 REMOVE + 6 RENAME) and RateLimitRow
// (4 REMOVE + 2 RENAME) drift items:
//
//   • `ApiCallRow` reads from `public.v_api_gateway_observability` (joined
//     projection over api_call_log + api_gateway_requests + api_routes +
//     webhook_sources). Fictional fields (`source_kind`, `source_ip`) are
//     dropped. Projection-derived fields (`request_id`, `path`, `status_code`,
//     `error_code`, `source_id`, `source_label`, `source_org_id`, `route_id`,
//     `route_pack_id`, `occurred_at`, `response_size_bytes`,
//     `response_body_sample`) all resolve via the view; FE consumes them
//     by their canonical projection name.
//
//   • `RateLimitRow` reads from `public.v_api_gateway_rate_limits_summary`
//     (joined projection over api_gateway_rate_limits + webhook_sources).
//     Fictional per-route fields (`route_id`, `route_path`, `route_method`)
//     are dropped — backend rate-limit is per-source, not per-route.
//     `limit_per_min` is computed (floor(rate_limit_per_hour / 60));
//     `saturated` is computed (request_count >= rate_limit_per_hour).
//
// SSOT remains the underlying canonical tables (`api_call_log`,
// `api_gateway_rate_limits`, `webhook_sources`); the views are additive.
// Migration: `supabase/migrations/202604301800_v_api_gateway_observability.sql`.

export interface ApiCallRow extends Record<string, unknown> {
  id: string;                                        // SSOT: api_call_log.id
  // request_id projects from api_gateway_requests.id; NULL when no joined
  // request row exists (api_call_log can fire without an upstream request).
  request_id: string | null;                         // SSOT: v_api_gateway_observability.request_id
  method: string;                                    // SSOT: api_call_log.method
  path: string;                                      // SSOT: v_api_gateway_observability.path (url with query stripped)
  status_code: number;                               // SSOT: v_api_gateway_observability.status_code (= response_status)
  error_code?: string | null;                        // SSOT: v_api_gateway_observability.error_code (derived)
  duration_ms: number;                               // SSOT: api_call_log.duration_ms
  source_id: string | null;                          // SSOT: v_api_gateway_observability.source_id (projection)
  source_label: string | null;                       // SSOT: v_api_gateway_observability.source_label (= webhook_sources.name)
  source_org_id?: string | null;                     // SSOT: v_api_gateway_observability.source_org_id
  route_id: string | null;                           // SSOT: v_api_gateway_observability.route_id
  route_pack_id: string | null;                      // SSOT: v_api_gateway_observability.route_pack_id
  occurred_at: string;                               // SSOT: v_api_gateway_observability.occurred_at (= timestamp)
  has_request_headers?: boolean;                    // SSOT: v_api_gateway_observability.has_request_headers
  request_headers?: Record<string, string | null | undefined>; // SSOT: api_call_log.request_headers
  request_body?: Record<string, unknown> | string | null; // SSOT: api_call_log.request_body (redacted)
  response_size_bytes: number;                       // SSOT: v_api_gateway_observability.response_size_bytes (derived)
  response_body_sample?: string | null;              // SSOT: v_api_gateway_observability.response_body_sample
}

interface RateLimitRow extends Record<string, unknown> {
  id: string;                                        // SSOT: api_gateway_rate_limits.id
  source_id: string;                                 // SSOT: api_gateway_rate_limits.source_id
  source_label: string | null;                       // SSOT: v_api_gateway_rate_limits_summary.source_label
  limit_per_min: number;                             // SSOT: v_api_gateway_rate_limits_summary.limit_per_min (computed)
  limit_per_hour?: number;                           // SSOT: v_api_gateway_rate_limits_summary.limit_per_hour
  current_usage: number;                             // SSOT: v_api_gateway_rate_limits_summary.current_usage (= request_count)
  request_count?: number;                            // SSOT: api_gateway_rate_limits.request_count
  saturated: boolean;                                // SSOT: v_api_gateway_rate_limits_summary.saturated (computed)
  window_start: string;                              // SSOT: api_gateway_rate_limits.window_start
}

// W13-2: dropped top-level `latency_ms` per __audit__/SCHEMA-DRIFT/INSIGHTS.md §3.
// Canonical `public.provider_health_logs` stores latency only in `metadata`
// jsonb. The FE row interface mirrors that; consumers read via
// `latencyOf(row)` which extracts `metadata.latency_ms`.
interface ProviderHealthRow extends Record<string, unknown> {
  id: string;                                        // SSOT: provider_health_logs.id
  provider_id: string;                               // SSOT: provider_health_logs.provider_id
  occurred_at: string;                               // SSOT: provider_health_logs.created_at (RENAME deferred — cascades through 4 surfaces)
  status: string;                                    // SSOT: provider_health_logs.status
  error_message?: string | null;                     // SSOT: provider_health_logs.error_message
  metadata?: { latency_ms?: number } & Record<string, unknown>;  // SSOT: provider_health_logs.metadata (jsonb; latency lives here)
}

/**
 * Resolve provider latency through the canonical `metadata.latency_ms` jsonb
 * path. W13-2 closure: there is no top-level `latency_ms` column on
 * `public.provider_health_logs` (per __audit__/SCHEMA-DRIFT/INSIGHTS.md §3).
 *
 * Reads `metadata.latency_ms` first (canonical jsonb path) and falls back to
 * a legacy top-level `latency_ms` so this loader works whether the seed has
 * been migrated to the canonical shape or not. The fallback is removed once
 * the seed-side migration lands fully (paired with the projection RPC).
 */
function latencyOf(row: ProviderHealthRow | null | undefined): number {
  if (!row) return 0;
  const meta = row.metadata;
  const fromMeta = meta && typeof meta === 'object'
    ? (meta as { latency_ms?: unknown }).latency_ms
    : undefined;
  if (typeof fromMeta === 'number') return fromMeta;
  // Legacy top-level fallback (transitional; canonical column does NOT exist).
  const fromTop = (row as { latency_ms?: unknown }).latency_ms;
  return typeof fromTop === 'number' ? fromTop : 0;
}

// W13-2: dropped fictional `version` per __audit__/SCHEMA-DRIFT/INSIGHTS.md §4.
// `public.api_route_packs` has no `version` column (only id/name/description/
// enabled/created_at/updated_at). The route-pack <option> renders `name` only.
interface RoutePackRow extends Record<string, unknown> {
  id: string;                                        // SSOT: api_route_packs.id
  name: string;                                      // SSOT: api_route_packs.name
  description: string;                               // SSOT: api_route_packs.description
}

// W7 D1-A — api_gateway_requests joined projection (route + route_pack + source).
// Mirrors public.api_gateway_requests table; canonical projection RPC will arrive
// in Phase G1 (api_gateway_observability_v1) at which point the FE row interface
// will trim to canonical-only fields.
export interface ApiGatewayRequestRow extends Record<string, unknown> {
  request_id: string;                                // SSOT: api_gateway_requests.id
  organization_id?: string | null;                   // SSOT: api_gateway_requests.organization_id
  client_id?: string | null;                         // SSOT: api_gateway_requests.client_id
  client_label?: string | null;                      // SSOT: clients.name (projection)
  sender_id?: string | null;                         // SSOT: api_gateway_requests.sender_id
  sender_label?: string | null;                      // SSOT: senders.name (projection)
  route_id: string | null;                           // SSOT: api_gateway_requests.route_id
  route_name?: string | null;                        // SSOT: api_routes.route_name
  route_pack_id: string | null;                      // SSOT: api_routes.pack_id (projection)
  route_pack_name?: string | null;                   // SSOT: api_route_packs.name
  method: string;                                    // SSOT: api_gateway_requests.method
  path: string;                                      // SSOT: api_gateway_requests.path
  query_string?: string | null;                      // SSOT: api_gateway_requests.query_string
  request_headers?: Record<string, unknown> | null;  // SSOT: api_gateway_requests.request_headers (redacted)
  request_body?: Record<string, unknown> | null;     // SSOT: api_gateway_requests.request_body (redacted)
  source_id?: string | null;                         // SSOT: api_gateway_requests.source_id
  source_label?: string | null;                      // SSOT: webhook_sources.name
  correlation_id?: string | null;                    // SSOT: api_gateway_requests.correlation_id
  settings_resolution_id?: string | null;            // SSOT: api_gateway_requests.settings_resolution_id
  status_code: number | null;                        // SSOT: outbound_calls.response_status_code
  error_code?: string | null;                        // SSOT: derived from outbound or intake state
  outbound_error_message?: string | null;             // SSOT: outbound_calls.error_message
  intake_state?: string | null;                      // SSOT: v_api_gateway_request_directory.intake_state
  outbound_status?: string | null;                   // SSOT: outbound_calls.status
  workflow_run_id?: string | null;                   // SSOT: api_gateway_requests.workflow_run_id
  outbound_call_id?: string | null;                  // SSOT: api_gateway_requests.outbound_call_id
  shipment_id?: string | null;                       // SSOT: shipments.metadata.source.api_gateway_request_id
  tracking_number?: string | null;                   // SSOT: shipments.tracking_number
  shipment_status?: string | null;                   // SSOT: shipments.status
  idempotency_key?: string | null;                   // SSOT: api_gateway_requests.request_headers
  replay_of_request_id?: string | null;              // SSOT: api_gateway_requests.request_headers.x-masarx-replay-of
  mutation_intent?: string | null;                   // SSOT: api_routes.policy via api_gateway_route_canonical_intent_v1
  request_mapping_config_id?: string | null;         // SSOT: api_routes.policy.request_mapping / decision_log
  request_mapping_key?: string | null;               // SSOT: api_routes.policy.request_mapping / decision_log
  request_mapping_type?: string | null;              // SSOT: api_routes.policy.request_mapping / decision_log
  request_mapping_target?: string | null;            // SSOT: api_routes.policy.request_mapping / decision_log
  request_mapping_applied?: boolean | null;          // SSOT: decision_log api_gateway_request_mapping=applied
  materialization_action_id?: string | null;         // SSOT: shipment_actions.api_gateway_materialized
  materialization_operation?: string | null;         // SSOT: shipment_actions.action_data.operation
  recipient_id?: string | null;                      // SSOT: shipments.recipient_id
  recipient_label?: string | null;                   // SSOT: recipients.name
  recipient_external_id?: string | null;             // SSOT: recipients.external_id
  destination_address_id?: string | null;            // SSOT: shipments.destination_address_id
  destination_city?: string | null;                  // SSOT: addresses.city
  destination_validation_status?: string | null;     // SSOT: addresses.validation_status
  occurred_at: string;                               // SSOT: api_gateway_requests.occurred_at
}

// W7 D1-B — api_routes registry (per-route_pack). Mirrors public.api_routes.
export interface ApiGatewayAuthRejectionRow extends Record<string, unknown> {
  id: string;
  service: 'api_gateway';
  surface?: string | null;
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
  query_string?: string | null;
  token_fingerprint?: string | null;
  request_headers?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  occurred_at: string;
  rejection_class?: string | null;
  source_resolved?: boolean | null;
}

export interface ApiRouteRow extends Record<string, unknown> {
  id: string;                                        // SSOT: api_routes.id
  method: string;                                    // SSOT: api_routes.method
  path_pattern: string;                              // SSOT: api_routes.path_pattern
  path_template?: string | null;                     // transitional projection alias
  route_pack_id: string;                             // SSOT: api_routes.pack_id (RENAME — FE displays canonical alias)
  deprecated: boolean;                               // SSOT: api_routes.deprecated
  scope_type?: string | null;                        // SSOT: api_routes.scope_type
  scope_id?: string | null;                          // SSOT: api_routes.scope_id
  policy?: Record<string, unknown> | null;            // SSOT: api_routes.policy
}

interface ProviderAccountSettingsValue {
  enabled?: boolean | null;
  company_id?: string | number | null;
  auth_config_id?: string | null;
}

interface ProviderCredentialDirectoryRow extends Record<string, unknown> {
  id?: string | null;
  auth_config_id?: string | null;
  provider_auth_config_id?: string | null;
  status?: string | null;
}

interface ProviderCredentialReadback {
  rows: ProviderCredentialDirectoryRow[];
  loaded: boolean;
  error: boolean;
}

interface WebhookSourceDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  name?: string | null;
  source_identifier?: string | null;
  provider_type?: string | null;
  enabled?: boolean | null;
  rate_limit_per_hour?: number | null;
  auth_token_masked?: string | null;
  sender_id?: string | null;
  sender_label?: string | null;
  client_id?: string | null;
  client_label?: string | null;
  lifecycle_state?: string | null;
  archived_at?: string | null;
  mapping_config_id?: string | null;
  mapping_label?: string | null;
}

interface MappingConfigDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  mapping_type?: string | null;
  mapping_key?: string | null;
  target?: string | null;
  notes_excerpt?: string | null;
  enabled?: boolean | null;
}

interface ApiGatewaySourceControlRow extends Record<string, unknown> {
  id: string;
  source_id: string;
  source_label: string;
  source_identifier?: string | null;
  provider_type?: string | null;
  enabled?: boolean | null;
  lifecycle_state?: string | null;
  archived_at?: string | null;
  client_label?: string | null;
  sender_label?: string | null;
  limit_per_min?: number | null;
  limit_per_hour?: number | null;
  current_usage?: number | null;
  saturated?: boolean | null;
}

// ─── Filter / live-tail state ─────────────────────────────────────────────

const STATUS_CLASSES: Array<'2xx' | '3xx' | '4xx' | '5xx'> = ['2xx', '3xx', '4xx', '5xx'];

function requestStatusLabel(t: Translate, code: number | null | undefined, state?: string | null): string {
  if (typeof code === 'number' && Number.isFinite(code)) {
    if (code >= 200 && code < 300) return t('insightsApiGateway.requestStatusLabel.completed');
    if (code >= 300 && code < 400) return t('insightsApiGateway.requestStatusLabel.redirected');
    return t('insightsApiGateway.requestStatusLabel.needsReview');
  }
  return requestIntakeLabel(t, state);
}

function requestStatusTone(code: number | null | undefined, state?: string | null): ChipKind {
  if (typeof code === 'number' && Number.isFinite(code)) return statusKind(code);
  if (state === 'shipment_materialized') return 'good';
  if (state === 'not_dispatched') return 'warn';
  if (state === 'timeout' || state === 'timed_out') return 'danger';
  if (state === 'workflow_queued' || state === 'pending') return 'info';
  return 'neutral';
}

function requestIntakeTone(state: unknown): ChipKind {
  if (state === 'shipment_materialized') return 'good';
  if (state === 'provider_failed') return 'danger';
  if (state === 'timeout' || state === 'timed_out') return 'danger';
  if (state === 'not_dispatched') return 'warn';
  if (state === 'workflow_queued' || state === 'pending') return 'info';
  return 'neutral';
}

function requestIntakeLabel(t: Translate, state: unknown): string {
  const tl = scopeT(t, 'insightsApiGateway.requestIntakeLabel');
  switch (state) {
    case 'shipment_materialized':
      return tl('shipmentConfirmed');
    case 'provider_failed':
      return tl('providerNeedsReview');
    case 'source_binding_rejected':
      return tl('requestRejected');
    case 'workflow_queued':
      return tl('processing');
    case 'timeout':
    case 'timed_out':
      return tl('providerTimedOut');
    case 'not_dispatched':
      return tl('notSent');
    case 'pending':
      return tl('pending');
    default:
      return state ? tl('requestReceived') : tl('intake');
  }
}

function providerStatusLabel(t: Translate, status: unknown): string {
  const tl = scopeT(t, 'insightsApiGateway.providerStatusLabel');
  switch (status) {
    case 'completed':
      return tl('completed');
    case 'failed':
    case 'permanently_failed':
      return tl('needsReview');
    case 'timed_out':
      return tl('timedOut');
    case 'pending':
      return tl('pending');
    default:
      return status ? tl('updated') : '—';
  }
}

function formatOptionalDurationMs(value: unknown, t: Translate): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? fill(t('insightsApiGateway.units.ms'), { ms: String(Math.round(numeric)) }) : '—';
}

function redactGatewayTokenPath(value: string): string {
  return redactSensitiveText(value);
}

function parseJsonObjectInput(value: string, t: Translate): Record<string, unknown> {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(t('insightsApiGateway.parseJsonObjectInput.payloadMustBeA'));
  }
  return parsed as Record<string, unknown>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

function apiGatewayTestCorrelationId(): string {
  const randomUuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : null;
  return randomUuid ?? `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0').slice(-12)}`;
}

function routeDisplayPath(row: ApiRouteRow | null | undefined): string {
  return String(row?.path_pattern ?? row?.path_template ?? '').trim();
}

function routePolicyString(row: ApiRouteRow | null | undefined, path: Array<string>): string {
  let cursor: unknown = row?.policy;
  for (const part of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return '';
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === 'string' ? cursor.trim() : '';
}

function routeCanonicalIntent(row: ApiRouteRow | null | undefined): string {
  const explicit = [
    ['workflow', 'intent'],
    ['workflow', 'canonical_intent'],
    ['postprocess', 'canonical_intent'],
    ['postprocess', 'intent'],
    ['intake', 'canonical_intent'],
    ['intake', 'intent'],
    ['canonical_intent'],
  ]
    .map((path) => routePolicyString(row, path))
    .find(Boolean);
  if (explicit) return normalizeShipmentRouteIntent(explicit);
  const postprocessMode = routePolicyString(row, ['postprocess', 'mode']);
  return shipmentRouteIntentFromPostprocessMode(postprocessMode);
}

function normalizeShipmentRouteIntent(value: string): string {
  const intent = value.toLowerCase().trim().replace(/_/g, '.');
  if (intent === 'shipment.create' || intent === 'shipments.create' || intent === 'shipment.created') {
    return 'shipment.create';
  }
  if (
    intent === 'shipment.update'
    || intent === 'shipments.update'
    || intent === 'shipment.updated'
    || intent === 'shipments.updated'
  ) {
    return 'shipment.update';
  }
  if (
    intent === 'shipment.cancel'
    || intent === 'shipment.canceled'
    || intent === 'shipment.cancelled'
    || intent === 'shipment.delete'
    || intent === 'shipments.cancel'
    || intent === 'shipments.canceled'
    || intent === 'shipments.cancelled'
    || intent === 'shipments.delete'
  ) {
    return 'shipment.delete';
  }
  if (
    intent === 'shipment.reschedule'
    || intent === 'shipment.rescheduled'
    || intent === 'shipments.reschedule'
    || intent === 'shipments.rescheduled'
  ) {
    return 'shipment.reschedule';
  }
  if (
    intent === 'shipments.update.status'
    || intent === 'shipment.update.status'
    || intent === 'shipment.status.update'
  ) {
    return 'update.status';
  }
  if (
    intent === 'shipments.update.address'
    || intent === 'shipment.update.address'
    || intent === 'shipment.address.update'
  ) {
    return 'update.address';
  }
  return intent;
}

function shipmentRouteIntentFromPostprocessMode(value: string): string {
  const mode = value.toLowerCase().trim();
  switch (mode) {
    case 'shipment_create_v1':
      return 'shipment.create';
    case 'shipment_update_v1':
      return 'shipment.update';
    case 'shipment_update_status_v1':
      return 'update.status';
    case 'shipment_update_address_v1':
      return 'update.address';
    case 'shipment_update_geocode_v1':
      return 'update.geocode';
    case 'shipment_update_driver_v1':
      return 'update.driver';
    case 'shipment_update_action_v1':
      return 'update.action';
    case 'shipment_update_attachment_v1':
      return 'update.attachment';
    case 'shipment_cancel_v1':
    case 'shipment_delete_v1':
      return 'shipment.delete';
    case 'shipment_reschedule_v1':
      return 'shipment.reschedule';
    default:
      return '';
  }
}

function routeIsShipmentMutation(row: ApiRouteRow | null | undefined): boolean {
  const intent = routeCanonicalIntent(row);
  return (
    intent === 'shipment.create'
    || intent === 'shipment.update'
    || intent === 'shipment.delete'
    || intent === 'shipment.reschedule'
    || intent.startsWith('update.')
  );
}

function routePostprocessPolicy(row: ApiRouteRow | null | undefined): Record<string, unknown> | null {
  const postprocess = row?.policy?.postprocess;
  return postprocess && typeof postprocess === 'object' && !Array.isArray(postprocess)
    ? (postprocess as Record<string, unknown>)
    : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function routeRequestMappingPolicy(row: ApiRouteRow | null | undefined): Record<string, unknown> | null {
  const policy = objectValue(row?.policy);
  const direct = objectValue(policy?.request_mapping);
  if (direct) return direct;
  const studio = objectValue(policy?.mapping_studio);
  const studioRequestMapping = objectValue(studio?.request_mapping);
  if (studioRequestMapping) return studioRequestMapping;
  const requestConfig = objectValue(studio?.request_config);
  return objectValue(requestConfig?.request_mapping);
}

function routeRequestMappingRef(row: ApiRouteRow | null | undefined): {
  id: string;
  key: string;
  type: string;
  target: string;
  scope: string;
  scopeId: string | null;
} | null {
  const mapping = routeRequestMappingPolicy(row);
  const id = stringValue(mapping?.mapping_config_id);
  const key = stringValue(mapping?.mapping_key);
  if (!id && !key) return null;
  return {
    id,
    key,
    type: stringValue(mapping?.mapping_type) || 'api_gateway_inbound',
    target: stringValue(mapping?.target),
    scope: stringValue(mapping?.route_scope_type) || stringValue(row?.scope_type) || 'global',
    scopeId: stringValue(mapping?.route_scope_id) || stringValue(row?.scope_id) || null,
  };
}

function apiGatewayRouteScopeLabel(
  t: Translate,
  route: ApiRouteRow | null | undefined,
  source?: WebhookSourceDirectoryRow | null,
): string {
  const tl = scopeT(t, 'insightsApiGateway.routeScopeLabel');
  const scopeType = stringValue(route?.scope_type).toLowerCase();
  const scopeId = stringValue(route?.scope_id);
  if (!scopeType || scopeType === 'global') return tl('globalDefault');
  if (scopeType === 'tenant') return tl('tenantDefault');
  if (scopeType === 'client') {
    if (source?.client_id && scopeId && source.client_id === scopeId) {
      return fill(tl('clientException'), { value: String(source.client_label ?? scopeId) });
    }
    return fill(tl('clientException'), { value: scopeId || tl('unscoped') });
  }
  if (scopeType === 'sender') {
    if (source?.sender_id && scopeId && source.sender_id === scopeId) {
      return fill(tl('senderException'), { value: String(source.sender_label ?? scopeId) });
    }
    return fill(tl('senderException'), { value: scopeId || tl('unscoped') });
  }
  if (scopeType === 'source') {
    if (source?.id && scopeId && source.id === scopeId) {
      return fill(tl('sourceException'), { value: String(source.name ?? source.source_identifier ?? scopeId) });
    }
    return fill(tl('sourceException'), { value: scopeId || tl('unscoped') });
  }
  return `${scopeType}: ${scopeId || tl('unscoped')}`;
}

function apiGatewayRouteOptionLabel(
  t: Translate,
  route: ApiRouteRow,
  source?: WebhookSourceDirectoryRow | null,
): string {
  const methodPath = `${String(route.method ?? '').toUpperCase()} ${routeDisplayPath(route) || route.id}`.trim();
  const routeName = stringValue(route.route_name) || stringValue(route.name);
  const scopeLabel = apiGatewayRouteScopeLabel(t, route, source);
  const parts = [methodPath];
  if (routeName && routeName !== methodPath) parts.push(routeName);
  parts.push(scopeLabel);
  return parts.join(' - ');
}

function mappingDirectoryLabel(row: MappingConfigDirectoryRow | null | undefined): string {
  if (!row) return '';
  const key = stringValue(row.mapping_key);
  const target = stringValue(row.target);
  return target ? `${key || row.id} -> ${target}` : key || row.id;
}

function mappingTargetIntent(row: MappingConfigDirectoryRow | null | undefined): string {
  return normalizeShipmentRouteIntent(stringValue(row?.target));
}

function routeAndMappingIntentsCompatible(routeIntent: string, mappingIntent: string): boolean {
  if (!routeIntent || !mappingIntent) return false;
  if (routeIntent === mappingIntent) return true;
  return routeIntent === 'shipment.update' && mappingIntent.startsWith('update.');
}

function routeCompatibleMappingRows(
  route: ApiRouteRow | null | undefined,
  mappings: MappingConfigDirectoryRow[],
): MappingConfigDirectoryRow[] {
  const routeIntent = routeCanonicalIntent(route);
  return mappings.filter((row) => routeAndMappingIntentsCompatible(routeIntent, mappingTargetIntent(row)));
}

function routeMappingSummaryRows(route: ApiRouteRow | null | undefined, t: Translate): KvRow[] {
  const tl = scopeT(t, 'insightsApiGateway.routeMappingSummaryRows');
  const postprocess = routePostprocessPolicy(route);
  const extract = postprocess?.extract && typeof postprocess.extract === 'object' && !Array.isArray(postprocess.extract)
    ? (postprocess.extract as Record<string, unknown>)
    : {};
  const routeIntent = route ? routeCanonicalIntent(route) : '';
  const requestMapping = routeRequestMappingRef(route);
  return [
    { key: 'route_id', label: tl('routeId'), value: route?.id ?? tl('notProjected'), mono: true },
    { key: 'route_path', label: tl('routePath'), value: routeDisplayPath(route), mono: true },
    { key: 'intent', label: tl('intent'), value: routeIntent || tl('notDeclared'), mono: true },
    { key: 'request_mapping', label: tl('requestMapping'), value: requestMapping?.id || requestMapping?.key || tl('notLinked'), mono: true },
    { key: 'request_mapping_type', label: tl('requestMappingType'), value: requestMapping?.type ?? tl('notLinked'), mono: true },
    { key: 'request_mapping_target', label: tl('requestMappingTarget'), value: requestMapping?.target || tl('notDeclared'), mono: true },
    { key: 'postprocess_mode', label: tl('postprocessMode'), value: String(postprocess?.mode ?? tl('notDeclared')), mono: true },
    { key: 'client_reference_path', label: tl('clientReferencePath'), value: String(extract.client_reference_path ?? tl('notDeclared')), mono: true },
    { key: 'recipient_name_path', label: tl('recipientNamePath'), value: String(extract.recipient_name_path ?? tl('notDeclared')), mono: true },
    { key: 'recipient_phone_path', label: tl('recipientPhonePath'), value: String(extract.recipient_phone_path ?? tl('notDeclared')), mono: true },
    { key: 'destination_line1_path', label: tl('addressLinePath'), value: String(extract.destination_line1_path ?? extract.address_line1_path ?? tl('notDeclared')), mono: true },
    { key: 'destination_city_path', label: tl('addressCityPath'), value: String(extract.destination_city_path ?? extract.address_city_path ?? tl('notDeclared')), mono: true },
    { key: 'destination_country_path', label: tl('addressCountryPath'), value: String(extract.destination_country_path ?? extract.address_country_path ?? tl('notDeclared')), mono: true },
    { key: 'tracking_path', label: tl('trackingPath'), value: String(extract.provider_tracking_number_path ?? extract.tracking_number_path ?? tl('notDeclared')), mono: true },
    { key: 'shipment_identifier_path', label: tl('shipmentIdentifierPath'), value: String(extract.shipment_id_path ?? extract.shipment_identifier_path ?? extract.provider_shipment_id_path ?? tl('notDeclared')), mono: true },
    { key: 'status_path', label: tl('statusPath'), value: String(extract.status_path ?? extract.shipment_status_path ?? tl('notDeclared')), mono: true },
    { key: 'reason_path', label: tl('reasonPath'), value: String(extract.cancel_reason_path ?? extract.delete_reason_path ?? extract.reason_path ?? tl('notDeclared')), mono: true },
    { key: 'reschedule_path', label: tl('rescheduleDatePath'), value: String(extract.reschedule_date_path ?? extract.promised_delivery_date_path ?? tl('notDeclared')), mono: true },
  ];
}

function requestMaterializationSummaryRows(row: ApiGatewayRequestRow | ApiGatewayRequestReadback | null | undefined, t: Translate): KvRow[] {
  const tl = scopeT(t, 'insightsApiGateway.requestMaterializationSummaryRows');
  const mappingRef = row?.request_mapping_config_id || row?.request_mapping_key;
  return [
    {
      key: 'idempotency_key',
      label: tl('retryProtection'),
      value: row?.idempotency_key ?? tl('notProjected'),
      mono: Boolean(row?.idempotency_key),
    },
    {
      key: 'replay_of_request_id',
      label: tl('replayOf'),
      value: row?.replay_of_request_id ?? tl('notReplayed'),
      mono: Boolean(row?.replay_of_request_id),
    },
    { key: 'mutation_intent', label: tl('mutationIntent'), value: row?.mutation_intent ?? tl('notDeclared'), mono: true },
    {
      key: 'request_mapping',
      label: tl('appliedMapping'),
      value: mappingRef ?? tl('notLinked'),
      mono: Boolean(mappingRef),
    },
    {
      key: 'request_mapping_state',
      label: tl('mappingState'),
      value: row?.request_mapping_applied ? 'applied' : tl('notApplied'),
      mono: true,
    },
    { key: 'request_mapping_type', label: tl('mappingType'), value: row?.request_mapping_type ?? tl('notLinked'), mono: true },
    { key: 'request_mapping_target', label: tl('mappingTarget'), value: row?.request_mapping_target ?? tl('notDeclared'), mono: true },
    {
      key: 'materialization_action_id',
      label: tl('shipmentAction'),
      value: row?.materialization_action_id ?? tl('notCreated'),
      mono: Boolean(row?.materialization_action_id),
    },
    { key: 'materialization_operation', label: tl('shipmentOperation'), value: row?.materialization_operation ?? tl('notCreated'), mono: true },
    {
      key: 'recipient',
      label: tl('recipient'),
      value: row?.recipient_label ?? row?.recipient_id ?? tl('notProjected'),
      mono: Boolean(!row?.recipient_label && row?.recipient_id),
    },
    {
      key: 'recipient_external_id',
      label: tl('recipientReference'),
      value: row?.recipient_external_id ?? tl('notProjected'),
      mono: Boolean(row?.recipient_external_id),
    },
    { key: 'destination', label: tl('destination'), value: row?.destination_city ?? row?.destination_address_id ?? tl('notProjected'), mono: !row?.destination_city },
    { key: 'destination_validation_status', label: tl('destinationStatus'), value: row?.destination_validation_status ?? tl('notProjected'), mono: true },
  ];
}

function shipmentTestRouteRank(row: ApiRouteRow): number {
  const routeText = [
    routeDisplayPath(row),
    String(row.route_name ?? ''),
    String(row.name ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  if (/\b(success|happy[-_\s]?path)\b|\/success(?:\/|$)/i.test(routeText)) return 0;
  if (/\b(failure|fail|error|rejection|timeout)\b|\/failure(?:\/|$)/i.test(routeText)) return 20;
  return 10;
}

function shipmentTestRouteScopeRank(
  row: ApiRouteRow,
  source: WebhookSourceDirectoryRow | null | undefined,
  tenantId: string | null | undefined,
): number {
  const scopeType = String(row.scope_type ?? '').trim().toLowerCase();
  const scopeId = String(row.scope_id ?? '').trim();
  if (!scopeType || scopeType === 'global') return 30;
  if (!scopeId) return 70;
  if (scopeType === 'source' && source?.id === scopeId) return 0;
  if (scopeType === 'sender' && source?.sender_id === scopeId) return 1;
  if (scopeType === 'client' && source?.client_id === scopeId) return 2;
  const sourceTenantId = String(source?.organization_id ?? '').trim();
  const activeTenantId = String(tenantId ?? '').trim();
  if (scopeType === 'tenant' && (sourceTenantId === scopeId || activeTenantId === scopeId)) return 3;
  return 80;
}

function compareShipmentTestRoutes(
  a: ApiRouteRow,
  b: ApiRouteRow,
  source?: WebhookSourceDirectoryRow | null,
  tenantId?: string | null,
): number {
  const scopeRank = shipmentTestRouteScopeRank(a, source, tenantId) - shipmentTestRouteScopeRank(b, source, tenantId);
  if (scopeRank !== 0) return scopeRank;
  const rank = shipmentTestRouteRank(a) - shipmentTestRouteRank(b);
  if (rank !== 0) return rank;
  return routeDisplayPath(a).localeCompare(routeDisplayPath(b));
}

function apiGatewayRouteSourceMismatchReason(
  route: ApiRouteRow | null | undefined,
  source: WebhookSourceDirectoryRow | null | undefined,
  t: Translate,
): string | null {
  if (!route || !source) return null;
  const scopeType = String(route.scope_type ?? '').trim().toLowerCase();
  const scopeId = String(route.scope_id ?? '').trim();
  if (!scopeType || scopeType === 'global' || !scopeId) return null;

  const sourceContext: Record<string, string> = {
    source: String(source.id ?? '').trim(),
    sender: String(source.sender_id ?? '').trim(),
    client: String(source.client_id ?? '').trim(),
    tenant: String(source.organization_id ?? '').trim(),
  };
  if (sourceContext[scopeType] === scopeId) return null;

  const routeLabel = routeDisplayPath(route) || route.route_name || route.id;
  const sourceLabel = source.name || source.source_identifier || source.id;
  return fill(t('insightsApiGateway.routeSourceMismatch.reason'), { route: String(routeLabel), scopeType, scopeId, source: String(sourceLabel) });
}

function requestRowFromGatewayTestResult(
  result: RunApiGatewayRequestTestResult | null,
): ApiGatewayRequestRow | null {
  return requestReadbackFromGatewayTestResult(result) as ApiGatewayRequestRow | null;
}

function apiGatewayRequestIsTerminal(row: ApiGatewayRequestRow): boolean {
  return apiGatewayRequestReadbackIsTerminal(row);
}

function missingGatewayActionDisabledReason(
  t: Translate,
  row: ApiGatewayRequestRow,
  kind: 'outbound' | 'shipment' | 'workflow',
): string | undefined {
  const hasCanonicalReadback =
    kind === 'shipment'
      ? Boolean(row.shipment_id)
      : kind === 'workflow'
        ? Boolean(row.workflow_run_id)
        : Boolean(row.outbound_call_id);
  if (hasCanonicalReadback) return undefined;
  if (!apiGatewayRequestIsTerminal(row)) return undefined;
  if (kind === 'shipment') return t('insightsApiGateway.disabledReason.noShipmentConfirmation');
  if (kind === 'workflow') return t('insightsApiGateway.disabledReason.noWorkflowConfirmation');
  return t('insightsApiGateway.disabledReason.noProviderHandoffConfirmation');
}

function apiGatewayReplayDisabledReason(t: Translate, row: ApiGatewayRequestRow): string | undefined {
  if (!row.route_id) return t('insightsApiGateway.disabledReason.noRouteConfirmation');
  if (!row.source_id) return t('insightsApiGateway.disabledReason.noSourceConfirmation');
  if (!row.path) return t('insightsApiGateway.disabledReason.noRequestPathConfirmation');
  return undefined;
}

function providerAccountPolicy(row: ApiRouteRow): {
  category: string;
  requireAuthConfig: boolean;
} | null {
  const raw = row.policy?.provider_account;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const policy = raw as { category?: unknown; require_auth_config_id?: unknown; required?: unknown };
  const category = typeof policy.category === 'string' ? policy.category.trim() : '';
  if (!category) return null;
  return {
    category,
    requireAuthConfig: policy.require_auth_config_id === true || policy.required === true,
  };
}

function routeProviderAccountReadiness(
  row: ApiRouteRow,
  providerAccountValue: ProviderAccountSettingsValue | undefined,
  credentialReadback: ProviderCredentialReadback | undefined,
  t: Translate,
): { label: string; tone: ChipKind; blockingReason?: string } {
  const tl = scopeT(t, 'insightsApiGateway.routeProviderAccountReadiness');
  const policy = providerAccountPolicy(row);
  if (!policy) return { label: tl('notRequired'), tone: 'neutral' };
  if (policy.category !== 'logestechs_v2_account') {
    return {
      label: policy.category,
      tone: policy.requireAuthConfig ? 'warn' : 'info',
      blockingReason: policy.requireAuthConfig
        ? fill(tl('providerAccountPolicyCategory'), { category: String(policy.category) })
        : undefined,
    };
  }
  const authConfigId = String(providerAccountValue?.auth_config_id ?? '').trim();
  if (policy.requireAuthConfig && !authConfigId) {
    return {
      label: tl('credentialMissing'),
      tone: 'warn',
      blockingReason: tl('bindTheDeliveryApi'),
    };
  }
  if (authConfigId) {
    if (credentialReadback && !credentialReadback.loaded) {
      return {
        label: tl('checkingCredential'),
        tone: 'info',
        blockingReason: tl('credentialConfirmationIsStill'),
      };
    }
    if (credentialReadback?.error) {
      return {
        label: tl('credentialUnreadable'),
        tone: 'danger',
        blockingReason: tl('credentialConfirmationFailedRetry'),
      };
    }
    const credential = credentialReadback?.rows.find((row) => {
      const ids = [row.id, row.auth_config_id, row.provider_auth_config_id].map((value) =>
        String(value ?? '').trim(),
      );
      return ids.includes(authConfigId);
    });
    if (credentialReadback?.loaded && !credential) {
      return {
        label: tl('credentialMissing'),
        tone: 'danger',
        blockingReason: tl('theSelectedCredentialIs'),
      };
    }
    const status = String(credential?.status ?? '').trim().toLowerCase();
    if (status === 'expired' || status === 'revoked') {
      return {
        label: fill(tl('credentialStatus'), { status: String(status) }),
        tone: 'danger',
        blockingReason: fill(tl('theSelectedCredentialIs2'), { status: String(status) }),
      };
    }
    if (status === 'expiring') return { label: tl('credentialExpiring'), tone: 'warn' };
    return { label: tl('credentialBound'), tone: 'good' };
  }
  return { label: tl('accountConfigured'), tone: 'info' };
}

function operatorReference(kind: string, value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  return `${kind} ${raw.slice(0, 8)}`;
}

function sourceDisplayLabel(row: WebhookSourceDirectoryRow | null | undefined, t: Translate): string {
  if (!row) return t('insightsApiGateway.sourceDisplayLabel.selectSource');
  const name = String(row.name ?? '').trim();
  const identifier = String(row.source_identifier ?? '').trim();
  if (name && identifier) return `${name} · ${operatorReference(t('insightsApiGateway.sourceDisplayLabel.source'), identifier)}`;
  return name || operatorReference(t('insightsApiGateway.sourceDisplayLabel.source'), identifier || row.id);
}

function isArchivedApiGatewaySource(row: WebhookSourceDirectoryRow | null | undefined): boolean {
  if (!row) return false;
  return Boolean(row.archived_at) || String(row.lifecycle_state ?? '').toLowerCase() === 'archived';
}

function apiGatewaySourceReadiness(
  row: WebhookSourceDirectoryRow | null | undefined,
  selectedRoute: ApiRouteRow | null,
  t: Translate,
): { label: string; tone: ChipKind; blockingReason?: string; blockingTitle?: string } {
  const tl = scopeT(t, 'insightsApiGateway.apiGatewaySourceReadiness');
  if (!row) {
    return {
      label: tl('sourceRequired'),
      tone: 'warn',
      blockingTitle: tl('apiSourceRequired'),
      blockingReason: tl('chooseAnIntakeSource'),
    };
  }
  if (isArchivedApiGatewaySource(row)) {
    return {
      label: tl('sourceArchived'),
      tone: 'danger',
      blockingTitle: tl('apiSourceArchived'),
      blockingReason: tl('archivedSourcesAreRetained'),
    };
  }
  if (row.enabled === false) {
    return {
      label: tl('sourceDisabled'),
      tone: 'danger',
      blockingTitle: tl('apiSourceDisabled'),
      blockingReason: tl('enableTheSelectedSource'),
    };
  }
  if (!String(row.auth_token_masked ?? '').trim()) {
    return {
      label: tl('tokenMissing'),
      tone: 'danger',
      blockingTitle: tl('apiSourceTokenMissing'),
      blockingReason: tl('rotateOrCreateA'),
    };
  }
  if (routeIsShipmentMutation(selectedRoute) && (!row.sender_id || !row.client_id)) {
    return {
      label: tl('senderBindingMissing'),
      tone: 'danger',
      blockingTitle: tl('senderAndClientBinding'),
      blockingReason: tl('shipmentMutationApiRoutes'),
    };
  }
  return {
    label: row.sender_label || row.client_label ? tl('sourceReady') : tl('sourceTokenStored'),
    tone: 'good',
  };
}

function isCapabilityDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === 'capability_denied') return true;
  const message = (err as { message?: string }).message ?? '';
  return /Capability denied/i.test(message);
}

// ─── Module ──────────────────────────────────────────────────────────────

export function ApiGatewayModule() {
  const { t, fmtRelative } = useI18n();
  const tl = useMemo(() => scopeT(t, 'insightsApiGateway.apiGatewayModule'), [t]);
  // Capability gate at the module entry — fail-closed, per AGENTS.md
  // ladder/identity policy. The data-source seam exposes the api_gateway_*
  // resources unconditionally (no per-resource RPC capability check is
  // wired into ui_list_resource_v1 today), so the surface guard is the
  // operator UX truth here.
  const canRead = useCapability(CAP.API_GATEWAY_READ);
  const canReadWebhookSources = useCapability(CAP.WEBHOOKS_READ);
  const canReadMappings = useCapability(CAP.MAPPINGS_READ);
  const canWriteMappings = useCapability(CAP.MAPPINGS_WRITE);
  const canWriteGateway = useCapability(CAP.API_GATEWAY_WRITE);
  const canReadWorkflows = useCapability(CAP.WORKFLOWS_READ);
  const canReadObservability = useCapability(CAP.OBSERVABILITY_READ);
  const canOpenWorkflowContext = canReadWorkflows && canReadObservability;
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const recentGatewayListOpts = useMemo(
    () => ({ sort: { key: 'occurred_at', dir: 'desc' as const }, page_size: 50 }),
    [],
  );
  const identity = useIdentity();
  const drawer = useDrawer();
  const modal = useModal();
  const go = useConsoleNavigator();
  const tenantId = identity.scope.tenant?.id ?? identity.currentTenantId();
  const bindRouteMapping = useUpsertApiGatewayRouteMapping();

  // AGENTS.md §2/§3: api-gateway tone bands resolve strictly from canonical
  // `api_gateway_thresholds` (W48 policy seed; expanded by W54-D to cover
  // KPI strip + downstream waterfall + latency band thresholds). No inline
  // magic numbers anywhere in the surface.
  const apiGwPolicy = useResolveSettings('api_gateway_thresholds', undefined, readQueryOptions);
  const apiGwThresholds = apiGwPolicy.data?.value as
    | {
        usage_pct_warn?: number;
        latency_band_warn_ms?: number;
        latency_band_danger_ms?: number;
        latency_p95_warn_ms?: number;
        latency_p95_danger_ms?: number;
        error_rate_warn_pct?: number;
        error_rate_danger_pct?: number;
        rate_limited_warn_count?: number;
        rate_limited_danger_count?: number;
        downstream_dominance_pct?: number;
        // W-Cycle-E2 (P2 #10) — canonical observation windows.
        provider_health_correlation_window_ms?: number;
        kpi_window_ms?: number;
      }
    | undefined;
  const deliveryProviderAccount = useResolveSettings(
    'logestechs_v2_account',
    tenantId ? { tenant: { id: tenantId } } : undefined,
    readQueryOptions,
  );
  const deliveryProviderAccountValue = deliveryProviderAccount.data?.value as
    | ProviderAccountSettingsValue
    | undefined;
  const tenantDirectoryListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId }, page_size: 200 } : { page_size: 200 }),
    [tenantId],
  );
  const credentialDirectoryListOpts = useMemo(
    () => ({ page_size: 200 }),
    [],
  );
  const usagePctWarn = apiGwThresholds?.usage_pct_warn;
  // W-Cycle-E2 (P2 #9) — `live_tail_policy.api_gateway_buffer_size`.
  // W73-Insights Cycle F-R-13 closure (P2-6) — extends the same canonical
  // policy with `api_gateway_synthesizer_interval_ms` to drive the
  // DEMO-mode synthesizer tick (replaces the inline 2000ms literal).
  const liveTailPolicy = useResolveSettings('live_tail_policy', undefined, readQueryOptions);
  const liveTailPolicyValue = liveTailPolicy.data?.value as
    | { api_gateway_buffer_size?: number; api_gateway_synthesizer_interval_ms?: number }
    | undefined;
  const liveTailBufferSize = liveTailPolicyValue?.api_gateway_buffer_size;
  const synthesizerIntervalMs = liveTailPolicyValue?.api_gateway_synthesizer_interval_ms;

  // Filter state — local only. URL-scoped persistence is a follow-up; the
  // page intentionally remains URL-light so the live tail does not thrash
  // the router on every prepend.
  const [range, setRange] = useState<RangeKey>('1h');
  const [routePackId, setRoutePackId] = useState<string>(() => apiGatewayRoutePackFromLocation());
  const [focusRouteId] = useState<string>(() => apiGatewayFocusRouteFromLocation());
  const [statusKlass, setStatusKlass] = useState<'' | '2xx' | '3xx' | '4xx' | '5xx'>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [rateLimitOnly, setRateLimitOnly] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const [liveRows, setLiveRows] = useState<ApiCallRow[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [routeMappingReadbackByRouteId, setRouteMappingReadbackByRouteId] = useState<
    Record<string, Record<string, unknown>>
  >({});

  // Data fetches (capability gated upstream — useResourceList errors with
  // code: 'capability_denied' when the role lacks api_gateway.read).
  //
  // W14-2: ApiCallRow now reads from `public.v_api_gateway_observability`
  // (registered as resource `api_gateway_observability`) — joined projection
  // over api_call_log + api_gateway_requests + api_routes + webhook_sources.
  // RateLimitRow reads from `public.v_api_gateway_rate_limits_summary`
  // (registered as `api_gateway_rate_limits_summary`). Both views close the
  // W11/W13 deferred drift per `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1-§2`.
  const callsQ = useResourceList<ApiCallRow>('api_gateway_observability', recentGatewayListOpts, readQueryOptions);
  const rateLimitsQ = useResourceList<RateLimitRow>('api_gateway_rate_limits_summary', undefined, readQueryOptions);
  const providerHealthQ = useResourceList<ProviderHealthRow>('provider_health_logs', recentGatewayListOpts, readQueryOptions);
  const routePacksQ = useResourceList<RoutePackRow>('api_route_packs', undefined, readQueryOptions);
  // W7 D1-A + D1-B: registered in data-source.ts:515-517 — back-fills the
  // 'requests' (joined projection) and 'routes' (registry) view tabs.
  const requestsQ = useResourceList<ApiGatewayRequestRow>('api_gateway_requests', recentGatewayListOpts, readQueryOptions);
  const authRejectionsQ = useResourceList<ApiGatewayAuthRejectionRow>('api_gateway_auth_rejections', recentGatewayListOpts, readQueryOptions);
  const routesQ = useResourceList<ApiRouteRow>('api_routes', undefined, readQueryOptions);
  const mappingDirectoryQ = useResourceList<MappingConfigDirectoryRow>(
    'mapping_config_directory',
    tenantDirectoryListOpts,
    { enabled: canRead && canReadMappings },
  );
  const sourceDirectoryQ = useResourceList<WebhookSourceDirectoryRow>(
    'webhook_source_directory',
    tenantDirectoryListOpts,
    { enabled: canRead && canReadWebhookSources },
  );
  const credentialsQ = useResourceList<ProviderCredentialDirectoryRow>(
    'integration_credential_directory',
    credentialDirectoryListOpts,
    { enabled: canRead && Boolean(deliveryProviderAccountValue?.auth_config_id) },
  );

  // Stable references — the in-memory data-source returns a new array on
  // every refetch, so wrap each in useMemo keyed on the query data so hook
  // dependencies do not flap on every render.
  const callRows = useMemo<ApiCallRow[]>(() => callsQ.data?.rows ?? [], [callsQ.data]);
  const rateLimitRows = useMemo<RateLimitRow[]>(
    () => rateLimitsQ.data?.rows ?? [],
    [rateLimitsQ.data],
  );
  const providerHealthRows = useMemo<ProviderHealthRow[]>(
    () => (providerHealthQ.data?.rows ?? []).map((row) => ({
      ...row,
      occurred_at: String(row.occurred_at ?? row.created_at ?? ''),
    })),
    [providerHealthQ.data],
  );
  const routePackRows = useMemo<RoutePackRow[]>(
    () => routePacksQ.data?.rows ?? [],
    [routePacksQ.data],
  );
  const requestRows = useMemo<ApiGatewayRequestRow[]>(
    () => requestsQ.data?.rows ?? [],
    [requestsQ.data],
  );
  const authRejectionRows = useMemo<ApiGatewayAuthRejectionRow[]>(
    () => authRejectionsQ.data?.rows ?? [],
    [authRejectionsQ.data],
  );
  const sourceDirectoryRows = useMemo<WebhookSourceDirectoryRow[]>(
    () => sourceDirectoryQ.data?.rows ?? [],
    [sourceDirectoryQ.data],
  );
  const mappingDirectoryRows = useMemo<MappingConfigDirectoryRow[]>(
    () => (mappingDirectoryQ.data?.rows ?? []).filter((row) => (
      String(row.mapping_type ?? '').trim() === 'api_gateway_inbound'
    )),
    [mappingDirectoryQ.data],
  );
  const mappingDirectoryById = useMemo(() => {
    const map = new Map<string, MappingConfigDirectoryRow>();
    for (const row of mappingDirectoryRows) {
      if (row.id) map.set(row.id, row);
    }
    return map;
  }, [mappingDirectoryRows]);
  const mappingDirectoryByKey = useMemo(() => {
    const map = new Map<string, MappingConfigDirectoryRow>();
    for (const row of mappingDirectoryRows) {
      const key = stringValue(row.mapping_key);
      if (key) map.set(key, row);
    }
    return map;
  }, [mappingDirectoryRows]);
  const routeRows = useMemo<ApiRouteRow[]>(
    () => (routesQ.data?.rows ?? []).map((row) => {
      const requestMappingReadback = routeMappingReadbackByRouteId[row.id];
      const policy = requestMappingReadback
        ? {
            ...(objectValue(row.policy) ?? {}),
            request_mapping: requestMappingReadback,
          }
        : row.policy;
      return {
        ...row,
        policy,
        route_pack_id: String(row.route_pack_id ?? row.pack_id ?? ''),
        path_pattern: String(row.path_pattern ?? row.path_template ?? ''),
        deprecated: Boolean(row.deprecated ?? row.enabled === false),
      };
    }),
    [routeMappingReadbackByRouteId, routesQ.data],
  );
  const routeMappingDirectoryRow = useCallback(
    (route: ApiRouteRow | null | undefined) => {
      const ref = routeRequestMappingRef(route);
      if (!ref) return null;
      return (ref.id ? mappingDirectoryById.get(ref.id) : undefined)
        ?? (ref.key ? mappingDirectoryByKey.get(ref.key) : undefined)
        ?? null;
    },
    [mappingDirectoryById, mappingDirectoryByKey],
  );
  const routeMappingLabel = useCallback(
    (route: ApiRouteRow | null | undefined) => {
      const ref = routeRequestMappingRef(route);
      if (!ref) return tl('noRequestMapping');
      const row = routeMappingDirectoryRow(route);
      return mappingDirectoryLabel(row) || ref.key || ref.id || tl('requestMappingLinked');
    },
    [routeMappingDirectoryRow, tl],
  );
  const requireRouteMappingVisibleReadback = useCallback(
    async (
      routeId: string,
      expected: {
        mapping_config_id: string;
        target?: string | null;
      },
    ): Promise<Record<string, unknown>> => {
      const [routesReadback, mappingsReadback] = await Promise.all([
        routesQ.refetch(),
        mappingDirectoryQ.refetch(),
      ]);
      const route = (routesReadback.data?.rows ?? []).find((candidate) => candidate.id === routeId);
      if (!route) {
        throw new Error(fill(tl('apiRouteRouteidIs'), { routeId: String(routeId) }));
      }
      const ref = routeRequestMappingRef(route);
      if (!ref) {
        throw new Error(fill(tl('apiRouteRouteidRoute'), { routeId: String(routeId) }));
      }
      if (ref.id !== expected.mapping_config_id) {
        throw new Error(fill(tl('apiRouteRouteidRoute2'), { routeId: String(routeId) }));
      }
      const expectedTarget = stringValue(expected.target);
      const actualTarget = stringValue(ref.target);
      if (expectedTarget && actualTarget !== expectedTarget) {
        throw new Error(fill(tl('apiRouteRouteidRoute3'), { routeId: String(routeId) }));
      }
      const directoryRows = mappingsReadback.data?.rows ?? [];
      const directory = directoryRows.find((candidate) => candidate.id === expected.mapping_config_id);
      if (!directory) {
        throw new Error(tl('theSelectedMappingIs'));
      }
      return {
        mapping_config_id: ref.id,
        mapping_key: ref.key,
        mapping_type: ref.type,
        target: actualTarget || expectedTarget,
        route_scope_type: ref.scope,
        route_scope_id: ref.scopeId,
      };
    },
    [mappingDirectoryQ, routesQ, tl],
  );
  const providerCredentialReadback = useMemo<ProviderCredentialReadback>(
    () => ({
      rows: credentialsQ.data?.rows ?? [],
      loaded: !deliveryProviderAccountValue?.auth_config_id || credentialsQ.isSuccess,
      error: credentialsQ.isError,
    }),
    [
      credentialsQ.data,
      credentialsQ.isError,
      credentialsQ.isSuccess,
      deliveryProviderAccountValue?.auth_config_id,
    ],
  );
  const liveProjectionRefetchersRef = useRef({
    requests: requestsQ.refetch,
    authRejections: authRejectionsQ.refetch,
    calls: callsQ.refetch,
  });
  liveProjectionRefetchersRef.current = {
    requests: requestsQ.refetch,
    authRejections: authRejectionsQ.refetch,
    calls: callsQ.refetch,
  };

  // W7 D1-A + D1-B: which projection to render in the data area below.
  // 'live' = api_call_log + live-tail (default), 'requests' = api_gateway_requests
  // joined projection, 'routes' = api_routes registry.
  const [view, setView] = useState<ApiGatewayView>(() => apiGatewayViewFromLocation());
  useEffect(() => {
    const syncViewFromLocation = () => setView(apiGatewayViewFromLocation());
    window.addEventListener('popstate', syncViewFromLocation);
    return () => window.removeEventListener('popstate', syncViewFromLocation);
  }, []);

  // Combined rows: live-prepended first, then base rows. Apply filters.
  const rows = useMemo<ApiCallRow[]>(() => {
    let merged: ApiCallRow[] = [...liveRows, ...callRows];
    if (range) merged = clampByRange(merged, 'occurred_at', range);
    if (routePackId) merged = merged.filter((r) => r.route_pack_id === routePackId);
    if (statusKlass) merged = merged.filter((r) => statusClass(r.status_code) === statusKlass);
    if (sourceFilter) merged = merged.filter((r) => r.source_id === sourceFilter);
    if (rateLimitOnly) {
      merged = merged.filter((r) => r.status_code === 429 || r.error_code === 'rate_limited');
    }
    return merged;
  }, [callRows, liveRows, range, routePackId, statusKlass, sourceFilter, rateLimitOnly]);

  // Sources options. The block-source action resolves from the canonical
  // source directory first; quiet sources may have no recent call rows but
  // must still be visible to operator actions.
  const sourceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const source of sourceDirectoryRows) {
      if (!source.id || source.enabled === false || source.archived_at) continue;
      seen.set(
        source.id,
        source.name
          ?? source.source_identifier
          ?? source.id,
      );
    }
    for (const r of callRows) {
      // W14-2 view exposes source_id/source_label as nullable (api_call_log
      // rows can lack a joined webhook_sources row). Skip orphan rows here.
      if (r.source_id && !seen.has(r.source_id)) seen.set(r.source_id, r.source_label ?? r.source_id);
    }
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
  }, [callRows, sourceDirectoryRows]);

  useEffect(() => {
    if (!sourceFilter) return;
    if (sourceOptions.some((source) => source.id === sourceFilter)) return;
    setSourceFilter('');
  }, [sourceFilter, sourceOptions]);

  const sourceControlRows = useMemo<ApiGatewaySourceControlRow[]>(() => {
    const bySource = new Map<string, ApiGatewaySourceControlRow>();
    const rateBySource = new Map<string, RateLimitRow>();
    for (const rateRow of rateLimitRows) {
      if (rateRow.source_id) rateBySource.set(rateRow.source_id, rateRow);
    }

    for (const source of sourceDirectoryRows) {
      const rateRow = rateBySource.get(source.id);
      bySource.set(source.id, {
        id: source.id,
        source_id: source.id,
        source_label: source.name ?? source.source_identifier ?? source.id,
        source_identifier: source.source_identifier,
        provider_type: source.provider_type,
        enabled: source.enabled,
        lifecycle_state: source.lifecycle_state,
        archived_at: source.archived_at,
        client_label: source.client_label,
        sender_label: source.sender_label,
        limit_per_min: rateRow?.limit_per_min ?? (
          typeof source.rate_limit_per_hour === 'number'
            ? Math.floor(source.rate_limit_per_hour / 60)
            : null
        ),
        limit_per_hour: rateRow?.limit_per_hour ?? source.rate_limit_per_hour ?? null,
        current_usage: rateRow?.current_usage ?? rateRow?.request_count ?? null,
        saturated: rateRow?.saturated ?? null,
      });
    }

    for (const rateRow of rateLimitRows) {
      if (bySource.has(rateRow.source_id)) continue;
      bySource.set(rateRow.source_id, {
        id: rateRow.source_id,
        source_id: rateRow.source_id,
        source_label: rateRow.source_label ?? rateRow.source_id,
        limit_per_min: rateRow.limit_per_min,
        limit_per_hour: rateRow.limit_per_hour ?? null,
        current_usage: rateRow.current_usage ?? rateRow.request_count ?? null,
        saturated: rateRow.saturated ?? null,
      });
    }

    return Array.from(bySource.values()).sort((a, b) => (
      a.source_label.localeCompare(b.source_label)
    ));
  }, [rateLimitRows, sourceDirectoryRows]);

  // Live-tail tick — env-conditional per the LIVE-TAIL ENV CONTRACT above.
  //
  //   • LIVE mode: subscribe to Supabase Realtime `postgres_changes` on
  //     `api_call_log`. INSERTs are shaped through `shapeRealtimePayload`
  //     then prepended onto the live buffer.
  //   • DEV PREVIEW mode: schedule the synthesizer only when explicitly
  //     enabled in development/test.
  //
  // The mode is selected once per liveOn-toggle (not per render) by reading
  // `getSupabaseClient()` + import.meta env so the wiring stays zero-hardcoded.
  const syntheticLiveTailAllowed = isSyntheticLiveTailAllowed();
  const liveStartedRef = useRef(false);
  useEffect(() => {
    if (!liveOn || callRows.length === 0) {
      liveStartedRef.current = false;
      return undefined;
    }
    if (!liveStartedRef.current) {
      liveStartedRef.current = true;
      setLiveCount(0);
    }

    // W-Cycle-E2 (P2 #9) — live-tail buffer cap resolves through canonical
    // `live_tail_policy.api_gateway_buffer_size`. When missing, retain only
    // the latest single row so the gap is observable.
    const realtimeCap = liveTailBufferSize ?? 1;
    const client = getSupabaseClient();
    if (isRealtimeEnabled(client) && client) {
      // LIVE mode — subscribe to api_call_log inserts via Realtime.
      const channel = client
        .channel('api_call_log')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'api_call_log' },
          (payload: { new?: Record<string, unknown> | null }) => {
            const shaped = shapeRealtimePayload(payload?.new ?? null);
            if (!shaped) return;
            setLiveRows((prev) => prependApiCallLiveRow(prev, shaped as ApiCallRow, realtimeCap));
            setLiveCount((c) => c + 1);
          },
        )
        .subscribe();
      return () => {
        // Detach in both shapes (newer realtime APIs return a Promise from
        // removeChannel; older ones expose .unsubscribe directly).
        try {
          if (typeof (channel as { unsubscribe?: () => unknown }).unsubscribe === 'function') {
            (channel as { unsubscribe: () => unknown }).unsubscribe();
          }
          const remove = (client as { removeChannel?: (c: unknown) => unknown }).removeChannel;
          if (typeof remove === 'function') remove.call(client, channel);
        } catch {
          // intentional: tear-down is best-effort.
        }
      };
    }

    // DEV PREVIEW mode — synthesizer fallback. Production never enters this
    // branch; hosted lanes fail closed when Realtime is absent.
    if (!syntheticLiveTailAllowed) return undefined;

    // Dev-preview synthesizer.
    //
    // W73-Insights Cycle F-R-13 closure (P2-6): synthesizer tick resolves
    // through canonical `live_tail_policy.api_gateway_synthesizer_interval_ms`.
    // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
    // Strict fail-loud: when the policy value is missing the synthesizer
    // does NOT start (live-tail surface stays empty so the gap is
    // operator-visible) — never silently defaults.
    if (!synthesizerIntervalMs) return undefined;
    let ordinal = 1;
    const id = setInterval(() => {
      const anchor = callRows[ordinal % callRows.length] as ApiCallRow;
      // W-Cycle-E2 (P2 #9) — live-tail buffer cap resolves through canonical
      // `live_tail_policy.api_gateway_buffer_size`. When missing, retain only
      // the latest single row so the gap is observable but the live-tail does
      // not silently exhaust memory.
      const cap = liveTailBufferSize ?? 1;
      setLiveRows((prev) => prependApiCallLiveRow(prev, synthesizeRow(anchor, ordinal), cap));
      setLiveCount((c) => c + 1);
      ordinal++;
    }, synthesizerIntervalMs);
    return () => clearInterval(id);
  }, [liveOn, callRows, liveTailBufferSize, synthesizerIntervalMs, syntheticLiveTailAllowed]);

  // Live-tail events do not cover every canonical request/auth/call projection,
  // so the live view also refreshes backend rows on the row-driven interval.
  useEffect(() => {
    if (!liveOn || !synthesizerIntervalMs) return undefined;

    const refetchLiveProjections = () => {
      const { requests, authRejections, calls } = liveProjectionRefetchersRef.current;
      void requests();
      void authRejections();
      void calls();
    };

    refetchLiveProjections();
    const id = window.setInterval(refetchLiveProjections, synthesizerIntervalMs);
    return () => window.clearInterval(id);
  }, [liveOn, synthesizerIntervalMs]);

  // Operators watch the Requests inbox for external API calls before those
  // rows have matching live-tail events, so keep that projection current while
  // the inbox is open without requiring a manual refresh.
  useEffect(() => {
    if (view !== 'requests' || liveOn || !synthesizerIntervalMs) return undefined;

    const refetchRequests = () => {
      void liveProjectionRefetchersRef.current.requests();
    };

    refetchRequests();
    const id = window.setInterval(refetchRequests, synthesizerIntervalMs);
    return () => window.clearInterval(id);
  }, [view, liveOn, synthesizerIntervalMs]);

  // KPI strip — derived from the canonical KPI window. W-Cycle-E2 (P2 #10):
  // window resolves through `api_gateway_thresholds.kpi_window_ms` (default
  // 3_600_000 ms = 1h). When the policy is missing the strip surfaces 0/0
  // counters (no synthetic 1h fallback).
  // RFC-canonical HTTP status thresholds (>=400 errors, ===429 rate-limited)
  // are intentionally not policy-driven; see RFC 9110 §15 (4xx Client Error).
  const kpiWindowMs = apiGwThresholds?.kpi_window_ms;
  const last1h = useMemo(() => {
    if (kpiWindowMs == null) return [];
    const cutoff = Date.now() - kpiWindowMs;
    return [...liveRows, ...callRows].filter(
      (r) => new Date(r.occurred_at).getTime() >= cutoff,
    );
  }, [callRows, liveRows, kpiWindowMs]);

  const kpi = useMemo(() => {
    const total = last1h.length;
    // RFC 9110 §15: status codes >=400 indicate client/server errors.
    const errors = last1h.filter((r) => r.status_code >= 400).length;
    // RFC 6585 §4: HTTP 429 Too Many Requests is the canonical rate-limit code.
    const rateLimited = last1h.filter((r) => r.status_code === 429).length;
    const p95Latency = p95(last1h.map((r) => r.duration_ms));
    return { total, errors, rateLimited, p95Latency };
  }, [last1h]);

  // Action handlers ─ Block source + Adjust rate limit (capability-gated).
  const onBlockSource = useCallback(() => {
    modal.open({
      title: tl('blockSource'),
      body: <BlockSourceForm sources={sourceOptions} onClose={() => modal.close()} />,
    });
  }, [modal, sourceOptions, tl]);

  const onAdjustRateLimit = useCallback(() => {
    modal.open({
      title: tl('adjustRateLimit'),
      body: (
        <AdjustRateLimitForm rateLimits={rateLimitRows} onClose={() => modal.close()} />
      ),
    });
  }, [modal, rateLimitRows, tl]);
  const isRefreshingGatewayData =
    callsQ.isFetching ||
    requestsQ.isFetching ||
    authRejectionsQ.isFetching ||
    rateLimitsQ.isFetching ||
    providerHealthQ.isFetching ||
    routePacksQ.isFetching ||
    routesQ.isFetching ||
    mappingDirectoryQ.isFetching ||
    sourceDirectoryQ.isFetching ||
    credentialsQ.isFetching;
  const refreshGatewayData = useCallback(async () => {
    await Promise.allSettled([
      callsQ.refetch(),
      requestsQ.refetch(),
      authRejectionsQ.refetch(),
      rateLimitsQ.refetch(),
      providerHealthQ.refetch(),
      routePacksQ.refetch(),
      routesQ.refetch(),
      mappingDirectoryQ.refetch(),
      sourceDirectoryQ.refetch(),
      credentialsQ.refetch(),
    ]);
    pushToast(tl('apiGatewayDataRefreshed'), 'info');
  }, [
    authRejectionsQ.refetch,
    callsQ.refetch,
    credentialsQ.refetch,
    providerHealthQ.refetch,
    rateLimitsQ.refetch,
    requestsQ.refetch,
    routePacksQ.refetch,
    routesQ.refetch,
    mappingDirectoryQ.refetch,
    sourceDirectoryQ.refetch,
    tl,
  ]);

  // Drawer body builder. We hand it the related rate-limit + provider-health
  // rows so each tab can render without another network round-trip.
  //
  // W14-2: rate-limit lookup is now per-source only (canonical
  // public.api_gateway_rate_limits is a per-source × hour bucket; the
  // fictional per-route fields were dropped per
  // `__audit__/SCHEMA-DRIFT/INSIGHTS.md §2`).
  const openRow = useCallback(
    (row: ApiCallRow) => {
      const rateRow = row.source_id
        ? rateLimitRows.find((r) => r.source_id === row.source_id) ?? null
        : null;
      // W-Cycle-E2 (P2 #10) — provider-correlation window resolves through
      // canonical `api_gateway_thresholds.provider_health_correlation_window_ms`
      // (default 1800000 ms = 30 minutes). When the policy is missing the
      // join falls back to the explicit policy default; the page-level guard
      // already requires `usagePctWarn` non-null for render so policy presence
      // is asserted upstream.
      const corrWindowMs = apiGwThresholds?.provider_health_correlation_window_ms;
      const provider = corrWindowMs == null
        ? null
        : providerHealthRows
            .filter((r) => Math.abs(new Date(r.occurred_at).getTime() - new Date(row.occurred_at).getTime()) < corrWindowMs)
            .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())[0] ?? null;
      drawer.open({
        title: fill(tl('requestValue'), { value: String(row.request_id ?? row.id) }),
        size: 'lg',
        body: (
          <ApiCallDrawerBody
            row={row}
            rateRow={rateRow}
            provider={provider}
            // Page-level guard ensures usagePctWarn is non-null at render time.
            usagePctWarn={usagePctWarn as number}
            // W54-D — thread canonical `api_gateway_thresholds` keys.
            // W-Cycle-E2 (P1 #6) — strict no-fallback: pass `undefined` when
            // the canonical policy is missing. The LatencyTab consumer renders
            // a `(missing-policy)` chip in that case rather than masking the
            // gap with an inline literal default.
            downstreamDominancePct={apiGwThresholds?.downstream_dominance_pct}
          />
        ),
      });
    },
    [drawer, rateLimitRows, providerHealthRows, usagePctWarn, apiGwThresholds, tl],
  );

  const columns = useMemo<Array<DataTableColumn<ApiCallRow>>>(
    () => [
      {
        key: 'request_id',
        label: tl('request'),
        mono: true,
        sortable: true,
        filterable: true,
        // W-Cycle-E (P2 #4) — synthesizer rows carry `synthetic: true` so
        // the operator can distinguish demo-mode fabricated rows from real
        // Realtime payloads. Mirrors the decisions.tsx `PREVIEW · synthetic
        // stream` chip pattern at the row level.
        render: (raw, row) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="mono" title={String(raw)}>
              {String(raw).slice(0, 18)}
            </span>
            {row.synthetic ? (
              <Chip
                label={tl('test')}
                kind="info"
                size="xs"
                className="mono"
                title={tl('testPreviewRow')}
              />
            ) : null}
          </span>
        ),
      },
      {
        key: 'method',
        label: tl('method'),
        sortable: true,
        filterable: true,
        render: (raw) => (
          <Chip label={String(raw)} kind={methodKind(String(raw))} size="xs" className="mono" />
        ),
      },
      {
        key: 'path',
        label: tl('path'),
        mono: true,
        sortable: true,
        filterable: true,
      },
      {
        key: 'status_code',
        label: tl('status'),
        align: 'right',
        mono: true,
        sortable: true,
        filterable: true,
        type: 'number',
        render: (raw) => (
          <Chip
            label={String(raw)}
            kind={statusKind(Number(raw))}
            size="xs"
            className="mono"
          />
        ),
      },
      {
        key: 'duration_ms',
        label: tl('duration'),
        align: 'right',
        mono: true,
        sortable: true,
        type: 'number',
        render: (raw) => {
          // W-Cycle-E (P2 #3) — strict no-fallback contract. `latencyKind`
          // returns `null` when `api_gateway_thresholds` policy is missing
          // or incomplete. Render the chip with `neutral` tone in that
          // case so the operator sees the gap rather than a default-good
          // tone derived from inferred constants.
          const kind = latencyKind(Number(raw), apiGwThresholds ?? null);
          return (
            <Chip
              label={fill(t('insightsApiGateway.units.ms'), { ms: String(raw) })}
              kind={kind ?? 'neutral'}
              size="xs"
              className="mono"
              title={
                kind === null
                  ? tl('responseTimingThresholdsAre')
                  : undefined
              }
            />
          );
        },
      },
      {
        key: 'source_label',
        label: tl('source'),
        sortable: true,
        filterable: true,
      },
      {
        key: 'occurred_at',
        label: tl('when'),
        sortable: true,
        format: 'datetime',
        render: (raw) => (
          <span title={String(raw)} className="mono" style={{ fontSize: 11 }}>
            {fmtRelative(String(raw))}
          </span>
        ),
      },
    ],
    // W54-D — depend on resolved thresholds so the column tones recompute
    // when the canonical policy resolves after mount.
    [apiGwThresholds, t, fmtRelative],
  );

  const rowActions = useMemo<Array<DataTableAction<ApiCallRow>>>(
    () => [
      { label: tl('openDetail'), icon: 'eye', onClick: openRow },
      {
        label: tl('copyTrackingKey'),
        icon: 'copy',
        onClick: (row) => {
          try {
            navigator.clipboard?.writeText(row.request_id ?? row.id);
            pushToast(tl('copiedTrackingKey'), 'good');
          } catch {
            pushToast(tl('clipboardBlocked'), 'warn');
          }
        },
      },
    ],
    [openRow, t],
  );

  const readGatewayRequestReadback = useCallback(async (row: ApiGatewayRequestRow): Promise<ApiGatewayRequestRow> => {
    const requestId = String(row.request_id ?? '').trim();
    if (!requestId) {
      throw new Error(tl('requestConfirmationIsUnavailable'));
    }
    const latest = await ui_get_resource_v1<ApiGatewayRequestRow>('api_gateway_requests', requestId);
    if (!latest?.request_id) {
      throw new Error(tl('theLatestRequestConfirmation'));
    }
    if (latest.request_id !== requestId) {
      throw new Error(tl('theLatestRequestConfirmation2'));
    }
    return latest;
  }, [tl]);

  const readAuthRejectionReadback = useCallback(
    async (row: ApiGatewayAuthRejectionRow): Promise<ApiGatewayAuthRejectionRow> => {
      const id = String(row.id ?? '').trim();
      if (!id) {
        throw new Error(tl('theSelectedRejectedRequest'));
      }
      const latest = await ui_get_resource_v1<ApiGatewayAuthRejectionRow>('api_gateway_auth_rejections', id);
      if (!latest?.id) {
        throw new Error(tl('theSelectedRejectedRequest'));
      }
      if (latest.id !== id) {
        throw new Error(tl('theRejectedRequestConfirmation'));
      }
      return latest;
    },
    [tl],
  );

  const openAuthRejectionRow = useCallback(
    async (row: ApiGatewayAuthRejectionRow) => {
      let latest: ApiGatewayAuthRejectionRow;
      try {
        latest = await readAuthRejectionReadback(row);
      } catch (err) {
        pushToast(tl('couldNotOpenThe'), 'danger');
        return;
      }
      drawer.open({
        title: tl('rejectedRequest'),
        size: 'lg',
        body: <ApiGatewayAuthRejectionDrawerBody row={latest} />,
      });
    },
    [drawer, readAuthRejectionReadback, tl],
  );

  const openGatewayWorkflowRun = useCallback(
    async (row: ApiGatewayRequestRow) => {
      if (!canOpenWorkflowContext) {
        pushToast(tl('openingWorkflowContextRequires'), 'warn');
        return;
      }
      let latest: ApiGatewayRequestRow;
      try {
        latest = await readGatewayRequestReadback(row);
      } catch (err) {
        pushToast(tl('couldNotOpenThe2'), 'danger');
        return;
      }
      if (!latest.workflow_run_id) {
        pushToast(tl('noWorkflowActivityIs'), 'warn');
        return;
      }
      let run: WorkflowRunContextRecord | null = null;
      let events: WorkflowRunDomainEvent[] = [];
      try {
        const [runReadback, eventsReadback] = await Promise.all([
          ui_get_resource_v1<WorkflowRunContextRecord>('workflow_run_directory', latest.workflow_run_id),
          ui_list_resource_v1<WorkflowRunDomainEvent>('domain_events', {
            filter: { workflow_run_id: latest.workflow_run_id },
            page_size: 25,
          }),
        ]);
        run = runReadback;
        events = eventsReadback.rows ?? [];
      } catch (err) {
        pushToast(tl('couldNotOpenWorkflow'), 'danger');
        return;
      }
      if (!run?.id) {
        pushToast(tl('workflowActivityIsNot'), 'danger');
        return;
      }
      openWorkflowRunContextDrawer(drawer, {
        workflowRunId: latest.workflow_run_id,
        run,
        events,
        contextRows: [
          {
            label: tl('apiRequest'),
            value: (
              <>
                <span className="mono">{latest.request_id}</span> · {latest.path}
              </>
            ),
          },
          { label: tl('intakeState'), value: latest.intake_state ?? tl('pendingConfirmation') },
          { label: tl('providerHandoff'), value: latest.outbound_call_id ?? tl('pendingConfirmation') },
          { label: tl('shipment'), value: latest.tracking_number ?? latest.shipment_id ?? tl('pendingConfirmation') },
        ],
        deepLink: `/workflows/runs?focus=${encodeURIComponent(latest.workflow_run_id)}`,
        onOpenTrace: latest.correlation_id
          ? () => go(`/insights/traces?cor=${encodeURIComponent(latest.correlation_id!)}`)
          : null,
        onOpenWorkflowModule: () => {
          go(`/workflows/runs?focus=${encodeURIComponent(latest.workflow_run_id!)}`);
        },
      });
    },
    [canOpenWorkflowContext, drawer, go, readGatewayRequestReadback, tl],
  );

  const openGatewayOutboundLifecycle = useCallback(
    async (row: ApiGatewayRequestRow) => {
      let latest: ApiGatewayRequestRow;
      try {
        latest = await readGatewayRequestReadback(row);
      } catch (err) {
        pushToast(tl('couldNotOpenProvider'), 'danger');
        return;
      }
      if (!latest.outbound_call_id) {
        pushToast(tl('noProviderHandoffConfirmation'), 'warn');
        return;
      }
      openApiGatewayOutboundLifecycleDrawer(drawer, latest, t);
    },
    [drawer, readGatewayRequestReadback, t, tl],
  );

  const openGatewayRoutePlanning = useCallback(
    async (row: ApiGatewayRequestRow) => {
      let latest: ApiGatewayRequestRow;
      try {
        latest = await readGatewayRequestReadback(row);
      } catch (err) {
        pushToast(tl('couldNotOpenProvider'), 'danger');
        return;
      }
      if (!latest.shipment_id) {
        pushToast(tl('noShipmentHasMaterialized'), 'warn');
        return;
      }
      const params = new URLSearchParams({ shipment: latest.shipment_id });
      go(`/operate/route-plans?${params.toString()}`);
    },
    [go, readGatewayRequestReadback, tl],
  );

  const openGatewayRequestRow = useCallback(
    async (row: ApiGatewayRequestRow) => {
      let latest: ApiGatewayRequestRow;
      try {
        latest = await readGatewayRequestReadback(row);
      } catch (err) {
        pushToast(tl('couldNotOpenRoute'), 'danger');
        return;
      }
      const footer = (canOpenWorkflowContext && latest.workflow_run_id) || latest.outbound_call_id || latest.route_id || latest.shipment_id ? (
        <>
          {canOpenWorkflowContext && latest.workflow_run_id ? (
            <Button
              label={tl('openWorkflowActivity')}
              iconName="history"
              kind="ghost"
              onClick={() => openGatewayWorkflowRun(latest)}
            />
          ) : null}
          {latest.outbound_call_id ? (
            <Button
              label={tl('openProviderActivity')}
              iconName="trace"
              kind="ghost"
              onClick={() => openGatewayOutboundLifecycle(latest)}
            />
          ) : null}
          {latest.route_id ? (
            <Button
              label={tl('openRouteMapping')}
              iconName="route"
              kind="ghost"
              onClick={() => {
                drawer.close();
                if (latest.route_pack_id) setRoutePackId(latest.route_pack_id);
                setView('routes');
              }}
            />
          ) : null}
          {latest.shipment_id ? (
            <Button
              label={tl('planRoute')}
              iconName="route"
              kind="ghost"
              capabilities={[CAP.ROUTE_PLANS_READ, CAP.ROUTE_PLANS_WRITE]}
              onClick={() => {
                void openGatewayRoutePlanning(latest);
              }}
            />
          ) : null}
          {latest.shipment_id ? (
            <Button
              label={tl('openShipmentContext')}
              iconName="package"
              kind="primary"
              onClick={() => {
                openShipmentContextDrawer(drawer, latest.shipment_id!, {
                  fallbackShipment: {
                    tracking_number: latest.tracking_number ?? latest.shipment_id ?? undefined,
                    status: latest.shipment_status ?? undefined,
                  },
                  initialTab: 'timeline',
                });
              }}
            />
          ) : null}
        </>
      ) : undefined;

      drawer.open({
        title: fill(tl('gatewayRequestRequestId'), { request_id: String(latest.request_id) }),
        size: 'lg',
        body: (
          <ApiGatewayRequestDrawerBody
            row={latest}
            route={routeRows.find((route) => route.id === latest.route_id) ?? null}
          />
        ),
        footer,
      });
    },
    [
      canOpenWorkflowContext,
      drawer,
      openGatewayOutboundLifecycle,
      openGatewayRoutePlanning,
      openGatewayWorkflowRun,
      readGatewayRequestReadback,
      routeRows,
      tl,
    ],
  );

  const openGatewayShipment = useCallback(
    async (row: ApiGatewayRequestRow) => {
      let latest: ApiGatewayRequestRow;
      try {
        latest = await readGatewayRequestReadback(row);
      } catch (err) {
        pushToast(tl('couldNotOpenThis'), 'danger');
        return;
      }
      if (!latest.shipment_id) {
        pushToast(tl('noShipmentHasMaterialized'), 'warn');
        return;
      }
      openShipmentContextDrawer(drawer, latest.shipment_id, {
        fallbackShipment: {
          tracking_number: latest.tracking_number ?? latest.shipment_id ?? undefined,
          status: latest.shipment_status ?? undefined,
        },
        initialTab: 'timeline',
      });
    },
    [drawer, readGatewayRequestReadback, tl],
  );

  const openApiGatewayShipmentTestModal = useCallback((replayRequest?: ApiGatewayRequestRow | null) => {
    const refreshApiGatewayReadback = async () => {
      setView('requests');
      await Promise.all([
        requestsQ.refetch(),
        callsQ.refetch(),
        rateLimitsQ.refetch(),
      ]);
    };
    const openRequestFromTest = async (row: ApiGatewayRequestRow) => {
      modal.close();
      await openGatewayRequestRow(row);
    };
    const openWorkflowRunFromTest = async (row: ApiGatewayRequestRow) => {
      modal.close();
      await openGatewayWorkflowRun(row);
    };
    const openOutboundFromTest = async (row: ApiGatewayRequestRow) => {
      modal.close();
      await openGatewayOutboundLifecycle(row);
    };
    const openShipmentFromTest = async (row: ApiGatewayRequestRow) => {
      modal.close();
      await openGatewayShipment(row);
    };
    const openRoutePlanningFromTest = async (row: ApiGatewayRequestRow) => {
      modal.close();
      await openGatewayRoutePlanning(row);
    };
    modal.open({
      title: tl('apiGatewayShipmentTest'),
      body: (
        <ApiGatewayShipmentTestForm
          routes={routeRows}
          sourceRows={sourceDirectoryRows}
          tenantId={tenantId}
          sourceLookupLoaded={!canReadWebhookSources || sourceDirectoryQ.isSuccess}
          sourceLookupError={sourceDirectoryQ.isError}
          providerAccountValue={deliveryProviderAccountValue}
          credentialReadback={providerCredentialReadback}
          onClose={() => modal.close()}
          onRequestReadback={refreshApiGatewayReadback}
          onOpenRequest={openRequestFromTest}
          onOpenShipment={openShipmentFromTest}
          onOpenRoutePlanning={openRoutePlanningFromTest}
          onOpenWorkflowRun={openWorkflowRunFromTest}
          onOpenOutboundLifecycle={openOutboundFromTest}
          canOpenWorkflowContext={canOpenWorkflowContext}
          replayRequest={replayRequest ?? null}
          initialRouteId={focusRouteId}
          routeMappingLabel={routeMappingLabel}
        />
      ),
    });
  }, [
    modal,
    openGatewayOutboundLifecycle,
    openGatewayRequestRow,
    openGatewayRoutePlanning,
    openGatewayShipment,
    openGatewayWorkflowRun,
    requestsQ,
    callsQ,
    rateLimitsQ,
    routeRows,
    sourceDirectoryRows,
    sourceDirectoryQ.isError,
    sourceDirectoryQ.isSuccess,
    canReadWebhookSources,
    focusRouteId,
    canOpenWorkflowContext,
    tenantId,
    deliveryProviderAccountValue,
    providerCredentialReadback,
    routeMappingLabel,
    tl,
  ]);

  const onTestApiGatewayShipment = useCallback(() => {
    openApiGatewayShipmentTestModal(null);
  }, [openApiGatewayShipmentTestModal]);

  const replayGatewayRequestInTester = useCallback(
    async (row: ApiGatewayRequestRow) => {
      const disabledReason = apiGatewayReplayDisabledReason(t, row);
      if (disabledReason) {
        pushToast(disabledReason, 'warn');
        return;
      }
      let latest: ApiGatewayRequestRow;
      try {
        latest = await readGatewayRequestReadback(row);
      } catch (err) {
        const message = err instanceof Error ? err.message : tl('apiRequestConfirmationUnavailable');
        pushToast(message, 'danger');
        return;
      }
      const latestDisabledReason = apiGatewayReplayDisabledReason(t, latest);
      if (latestDisabledReason) {
        pushToast(latestDisabledReason, 'warn');
        return;
      }
      openApiGatewayShipmentTestModal(latest);
    },
    [openApiGatewayShipmentTestModal, readGatewayRequestReadback, t, tl],
  );

  const openRouteMappingInStudio = useCallback(
    (row: ApiRouteRow) => {
      const ref = routeRequestMappingRef(row);
      const focus = ref?.id || ref?.key;
      if (!focus) {
        pushToast(tl('thisApiRouteHas'), 'warn');
        return;
      }
      go(`/integrations/mapping?focus=${encodeURIComponent(focus)}`);
    },
    [go, tl],
  );

  const openRouteMappingForm = useCallback(
    (row: ApiRouteRow) => {
      modal.open({
        title: tl('configureRouteMapping'),
        body: (
          <ApiGatewayRouteMappingForm
            route={row}
            mappings={mappingDirectoryRows}
            currentMapping={routeMappingDirectoryRow(row)}
            disabled={!canWriteGateway || !canWriteMappings}
            onClose={() => modal.close()}
            onOpenMappingStudio={openRouteMappingInStudio}
            onSave={async (mappingConfigId, mappingTarget) => {
              const outcome = await bindRouteMapping.mutateAsync({
                api_route_id: row.id,
                mapping_config_id: mappingConfigId,
                organization_id: tenantId,
                target: mappingTarget || undefined,
              });
              const visibleReadback = await requireRouteMappingVisibleReadback(row.id, {
                mapping_config_id: String(outcome.mapping_config_id ?? mappingConfigId),
                target: String(outcome.mapping_target ?? mappingTarget ?? ''),
              });
              setRouteMappingReadbackByRouteId((current) => ({
                ...current,
                [row.id]: visibleReadback,
              }));
              pushToast(tl('routeRequestMappingSaved'), 'good');
              modal.close();
            }}
            saving={bindRouteMapping.isPending}
          />
        ),
      });
    },
    [
      bindRouteMapping,
      canWriteGateway,
      canWriteMappings,
      mappingDirectoryQ,
      mappingDirectoryRows,
      modal,
      openRouteMappingInStudio,
      requireRouteMappingVisibleReadback,
      routeMappingDirectoryRow,
      tenantId,
      tl,
    ],
  );

  const routeRowActions = useMemo<Array<DataTableAction<ApiRouteRow>>>(
    () => [
      {
        label: tl('configureMapping'),
        icon: 'settings',
        disabled: () => !canWriteGateway || !canWriteMappings,
        disabledReason: () => (
          !canWriteGateway
            ? tl('requiresApiGatewayWrite')
            : !canWriteMappings
              ? tl('requiresMappingsWrite')
              : undefined
        ),
        onClick: openRouteMappingForm,
      },
      {
        label: tl('openMappingProfile'),
        icon: 'external',
        disabled: (row) => !routeRequestMappingRef(row),
        disabledReason: () => tl('noRequestMappingProfile'),
        onClick: openRouteMappingInStudio,
      },
    ],
    [canWriteGateway, canWriteMappings, openRouteMappingForm, openRouteMappingInStudio, t],
  );

  const requestRowActions = useMemo<Array<DataTableAction<ApiGatewayRequestRow>>>(
    () => [
      { label: tl('openRequest'), icon: 'eye', onClick: openGatewayRequestRow },
      {
        label: tl('openWorkflowActivity'),
        icon: 'history',
        disabled: (row) => (
          !canOpenWorkflowContext || Boolean(missingGatewayActionDisabledReason(t, row, 'workflow'))
        ),
        disabledReason: (row) => (
          canOpenWorkflowContext
            ? missingGatewayActionDisabledReason(t, row, 'workflow')
            : tl('requiresWorkflowsReadAnd')
        ),
        onClick: openGatewayWorkflowRun,
      },
      {
        label: tl('openProviderActivity'),
        icon: 'trace',
        disabled: (row) => Boolean(missingGatewayActionDisabledReason(t, row, 'outbound')),
        disabledReason: (row) => missingGatewayActionDisabledReason(t, row, 'outbound'),
        onClick: openGatewayOutboundLifecycle,
      },
      {
        label: tl('openShipment'),
        icon: 'package',
        disabled: (row) => Boolean(missingGatewayActionDisabledReason(t, row, 'shipment')),
        disabledReason: (row) => missingGatewayActionDisabledReason(t, row, 'shipment'),
        onClick: openGatewayShipment,
      },
      {
        label: tl('replayInTester'),
        icon: 'plug',
        disabled: (row) => Boolean(apiGatewayReplayDisabledReason(t, row)),
        disabledReason: (row) => apiGatewayReplayDisabledReason(t, row),
        onClick: replayGatewayRequestInTester,
      },
      {
        label: tl('copyTrackingKey'),
        icon: 'copy',
        onClick: (row) => {
          try {
            navigator.clipboard?.writeText(row.correlation_id ?? row.request_id);
            pushToast(tl('copiedTrackingKey'), 'good');
          } catch {
            pushToast(tl('clipboardBlocked'), 'warn');
          }
        },
      },
    ],
    [
      canOpenWorkflowContext,
      openGatewayOutboundLifecycle,
      openGatewayRequestRow,
      openGatewayShipment,
      openGatewayWorkflowRun,
      replayGatewayRequestInTester,
      t,
    ],
  );

  const authRejectionRowActions = useMemo<Array<DataTableAction<ApiGatewayAuthRejectionRow>>>(
    () => [
      { label: tl('openRejection'), icon: 'eye', onClick: openAuthRejectionRow },
      {
        label: tl('copyTrackingKey'),
        icon: 'copy',
        disabled: (row) => !row.correlation_id,
        disabledReason: () => tl('noTrackingKeyIs'),
        onClick: (row) => {
          try {
            navigator.clipboard?.writeText(row.correlation_id ?? row.id);
            pushToast(tl('copiedTrackingKey'), 'good');
          } catch {
            pushToast(tl('clipboardBlocked'), 'warn');
          }
        },
      },
    ],
    [openAuthRejectionRow, t],
  );

  const authRejectionColumns = useMemo<Array<DataTableColumn<ApiGatewayAuthRejectionRow>>>(
    () => [
      {
        key: 'occurred_at',
        label: tl('when'),
        sortable: true,
        format: 'datetime',
        render: (raw) => (
          <span title={String(raw)} className="mono" style={{ fontSize: 11 }}>
            {fmtRelative(String(raw))}
          </span>
        ),
      },
      {
        key: 'http_status',
        label: tl('status'),
        align: 'right',
        mono: true,
        sortable: true,
        filterable: true,
        type: 'number',
        render: (raw) => {
          const code = typeof raw === 'number' ? raw : Number(raw);
          return (
            <Chip
              label={tl('rejected')}
              kind={Number.isFinite(code) ? statusKind(code) : 'danger'}
              size="xs"
            />
          );
        },
      },
      {
        key: 'failure_code',
        label: tl('failure'),
        sortable: true,
        filterable: true,
        render: () => <Chip label={tl('requestRejected')} kind="danger" size="xs" />,
      },
      {
        key: 'source_label',
        label: tl('source'),
        sortable: true,
        filterable: true,
        render: (raw, row) => (
          <span title={String(row.source_id ?? row.source_identifier ?? '')}>
            {raw ? String(raw) : row.source_resolved ? String(row.source_id ?? tl('resolvedSource')) : tl('unresolvedToken')}
          </span>
        ),
      },
      { key: 'method', label: tl('method'), mono: true, sortable: true, filterable: true },
      {
        key: 'path',
        label: tl('path'),
        mono: true,
        sortable: true,
        filterable: true,
        render: (raw) => redactGatewayTokenPath(String(raw ?? '—')),
      },
      { key: 'correlation_id', label: tl('trackingKey'), mono: true, sortable: true, filterable: true },
    ],
    [t, fmtRelative],
  );

  // W7 D1-A: column defs for the api_gateway_requests joined projection.
  const requestColumns = useMemo<Array<DataTableColumn<ApiGatewayRequestRow>>>(
    () => [
      {
        key: 'request_id',
        label: tl('requestConfirmation'),
        mono: true,
        sortable: true,
        filterable: true,
        render: (raw) => (
          <span>{raw ? tl('available') : '—'}</span>
        ),
      },
      {
        key: 'method',
        label: tl('method'),
        sortable: true,
        filterable: true,
        render: (raw) => (
          <Chip label={String(raw)} kind={methodKind(String(raw))} size="xs" className="mono" />
        ),
      },
      { key: 'path', label: tl('path'), mono: true, sortable: true, filterable: true },
      {
        key: 'source_label',
        label: tl('source'),
        sortable: true,
        filterable: true,
        render: (raw, row) => (
          <span title={String(row.source_id ?? '')}>
            {raw ? String(raw) : tl('unresolvedSource')}
          </span>
        ),
      },
      {
        key: 'route_name',
        label: tl('route'),
        sortable: true,
        filterable: true,
        render: (raw, row) => (
          <span title={String(row.route_id ?? '')}>
            {raw ? String(raw) : String(row.route_id ?? '').slice(0, 18)}
          </span>
        ),
      },
      {
        key: 'route_pack_name',
        label: tl('routePack'),
        sortable: true,
        filterable: true,
        render: (raw, row) => (
          <span title={String(row.route_pack_id ?? '')}>
            {raw ? String(raw) : String(row.route_pack_id ?? '').slice(0, 18)}
          </span>
        ),
      },
      {
        key: 'tracking_number',
        label: tl('shipment'),
        sortable: true,
        filterable: true,
        render: (raw, row) => {
          if (!row.shipment_id) {
            return <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>;
          }
          return (
            <button
              type="button"
              className="mono"
              style={{
                appearance: 'none',
                background: 'transparent',
                border: 0,
                color: 'var(--accent)',
                cursor: 'pointer',
                font: 'inherit',
                padding: 0,
                textDecoration: 'underline',
              }}
              title={fill(tl('openShipmentContextValue'), { value: String(raw ?? row.shipment_id) })}
              onClick={(event) => {
                event.stopPropagation();
                openGatewayShipment(row);
              }}
            >
              {String(raw ?? row.shipment_id)}
            </button>
          );
        },
      },
      {
        key: 'status_code',
        label: tl('status'),
        align: 'right',
        mono: true,
        sortable: true,
        filterable: true,
        type: 'number',
        render: (raw, row) => {
          const code = typeof raw === 'number' ? raw : null;
          return (
          <Chip
            label={requestStatusLabel(t, code, row.intake_state)}
            kind={requestStatusTone(code, row.intake_state)}
            size="xs"
            className="mono"
          />
          );
        },
      },
      {
        key: 'intake_state',
        label: tl('intakeState'),
        sortable: true,
        filterable: true,
        render: (raw) => (
          <Chip
            label={requestIntakeLabel(t, raw)}
            kind={requestIntakeTone(raw)}
            size="xs"
          />
        ),
      },
      {
        key: 'error_code',
        label: tl('requestOutcome'),
        sortable: true,
        filterable: true,
        render: (raw) => (raw ? <Chip label={tl('needsReview')} kind="warn" size="xs" /> : <span>—</span>),
      },
      {
        key: 'occurred_at',
        label: tl('when'),
        sortable: true,
        format: 'datetime',
        render: (raw) => (
          <span title={String(raw)} className="mono" style={{ fontSize: 11 }}>
            {fmtRelative(String(raw))}
          </span>
        ),
      },
    ],
    [openGatewayShipment, t, fmtRelative],
  );

  // W7 D1-B: column defs for the api_routes registry.
  const routeColumns = useMemo<Array<DataTableColumn<ApiRouteRow>>>(
    () => [
      {
        key: 'method',
        label: tl('method'),
        sortable: true,
        filterable: true,
        render: (raw) => (
          <Chip label={String(raw)} kind={methodKind(String(raw))} size="xs" className="mono" />
        ),
      },
      { key: 'path_pattern', label: tl('pathPattern'), mono: true, sortable: true, filterable: true },
      {
        key: 'scope_type',
        label: tl('scope'),
        sortable: true,
        filterable: true,
        render: (raw, row) => (
          <div style={{ display: 'grid', gap: 3 }}>
            <Chip label={String(raw ?? 'global')} kind={String(raw ?? 'global') === 'client' ? 'info' : 'neutral'} size="xs" />
            {row.scope_id ? (
              <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>{row.scope_id}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'route_intent',
        label: tl('intent'),
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const intent = routeCanonicalIntent(row);
          return (
            <Chip
              label={intent || tl('notDeclared')}
              kind={routeIsShipmentMutation(row) ? 'good' : 'warn'}
              size="xs"
              className="mono"
            />
          );
        },
      },
      {
        key: 'request_mapping',
        label: tl('requestMapping'),
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const ref = routeRequestMappingRef(row);
          const directory = routeMappingDirectoryRow(row);
          return (
            <div style={{ display: 'grid', gap: 4 }}>
              <Chip
                label={ref ? routeMappingLabel(row) : tl('notLinked')}
                kind={ref ? 'good' : 'warn'}
                size="xs"
                className={ref ? 'mono' : undefined}
              />
              {ref ? (
                <span className="state__hint">
                  {directory?.target ?? ref.target ?? tl('targetPending')} · {ref.scope}
                </span>
              ) : null}
            </div>
          );
        },
      },
      { key: 'route_pack_id', label: tl('routePack'), mono: true, sortable: true, filterable: true },
      {
        key: 'provider_account_readiness',
        label: tl('providerAccount'),
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const readiness = routeProviderAccountReadiness(
            row,
            deliveryProviderAccountValue,
            providerCredentialReadback,
            t,
          );
          return <Chip label={readiness.label} kind={readiness.tone} size="xs" />;
        },
      },
      {
        key: 'deprecated',
        label: tl('deprecated'),
        sortable: true,
        filterable: true,
        render: (raw) =>
          raw ? (
            <Chip label={tl('yes')} kind="warn" size="xs" className="mono" />
          ) : (
            <Chip label={tl('no')} kind="neutral" size="xs" className="mono" />
          ),
      },
    ],
    [deliveryProviderAccountValue, providerCredentialReadback, routeMappingDirectoryRow, routeMappingLabel, t],
  );

  const sourceControlColumns = useMemo<Array<DataTableColumn<ApiGatewaySourceControlRow>>>(
    () => [
      {
        key: 'source_label',
        label: tl('source'),
        sortable: true,
        filterable: true,
        render: (raw, row) => (
          <div>
            <strong>{String(raw)}</strong>
            {row.source_identifier ? (
              <div className="mono" style={{ fontSize: 11, opacity: 0.72 }}>
                {row.source_identifier}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        key: 'enabled',
        label: tl('status'),
        sortable: true,
        filterable: true,
        render: (raw, row) => {
          if (row.archived_at) return <Chip label={tl('archived')} kind="warn" size="xs" />;
          if (raw === false) return <Chip label={tl('disabled')} kind="danger" size="xs" />;
          return <Chip label={tl('enabled')} kind="good" size="xs" />;
        },
      },
      {
        key: 'provider_type',
        label: tl('provider'),
        sortable: true,
        filterable: true,
        render: (raw) => <span className="mono">{String(raw ?? '—')}</span>,
      },
      {
        key: 'limit_per_min',
        label: tl('limitMin'),
        align: 'right',
        sortable: true,
        type: 'number',
        render: (raw) => (
          <Chip
            label={typeof raw === 'number' ? fill(t('insightsApiGateway.units.perMinute'), { count: String(raw) }) : '—'}
            kind="info"
            size="xs"
            className="mono"
          />
        ),
      },
      {
        key: 'limit_per_hour',
        label: tl('limitHr'),
        align: 'right',
        sortable: true,
        type: 'number',
        render: (raw) => <span className="mono">{typeof raw === 'number' ? raw.toLocaleString() : '—'}</span>,
      },
      {
        key: 'current_usage',
        label: tl('currentUsage'),
        align: 'right',
        sortable: true,
        type: 'number',
        render: (raw, row) => (
          <Chip
            label={typeof raw === 'number' ? raw.toLocaleString() : '—'}
            kind={row.saturated ? 'danger' : 'neutral'}
            size="xs"
            className="mono"
          />
        ),
      },
      { key: 'client_label', label: tl('client'), sortable: true, filterable: true },
      { key: 'sender_label', label: tl('sender'), sortable: true, filterable: true },
    ],
    [t, tl],
  );

  // Filter requests by route_pack + status class (mirrors live tab where
  // applicable; source filter is not relevant on this projection because
  // api_gateway_requests does not carry source_id at this granularity).
  const filteredRequests = useMemo<ApiGatewayRequestRow[]>(() => {
    let merged = requestRows;
    if (routePackId) merged = merged.filter((r) => r.route_pack_id === routePackId);
    if (statusKlass) {
      merged = merged.filter((r) => (
        typeof r.status_code === 'number' && statusClass(r.status_code) === statusKlass
      ));
    }
    return merged;
  }, [requestRows, routePackId, statusKlass]);

  const filteredAuthRejections = useMemo<ApiGatewayAuthRejectionRow[]>(() => {
    let merged = authRejectionRows;
    if (sourceFilter) merged = merged.filter((r) => r.source_id === sourceFilter);
    if (statusKlass) {
      merged = merged.filter((r) => (
        typeof r.http_status === 'number' && statusClass(r.http_status) === statusKlass
      ));
    }
    return merged;
  }, [authRejectionRows, sourceFilter, statusKlass]);

  // Filter routes by route_pack only.
  const filteredRoutes = useMemo<ApiRouteRow[]>(() => {
    if (!routePackId) return routeRows;
    return routeRows.filter((r) => r.route_pack_id === routePackId);
  }, [routeRows, routePackId]);

  const isPolicyLoading = apiGwPolicy.isLoading && !apiGwPolicy.data;
  const isLoading = isPolicyLoading || callsQ.isLoading || rateLimitsQ.isLoading || routePacksQ.isLoading;
  const isError = callsQ.isError;
  const error = callsQ.error;

  // Mode reflection for the page-header pill (re-read on every render so it
  // stays in sync with env changes during HMR; the underlying client is
  // memoized inside the factory).
  const realtimeMode = isRealtimeEnabled(getSupabaseClient());
  const liveTailAvailable = realtimeMode || syntheticLiveTailAllowed;

  if (!canRead || (isError && isCapabilityDenied(error))) {
    return (
      <div className="page" data-testid="insights-api-gateway-page">
        <PageHeader
          eyebrow={tl('externalIntake')}
          titleAccent={tl('titleAccent')}
          titlePlain={tl('titlePlain')}
          pills={[]}
          actions={[]}
        />
        <StateView
          kind="denied"
          capability={CAP.API_GATEWAY_READ}
          hint={tl('apiGatewayPermissionIs')}
        />
      </div>
    );
  }

  if (isPolicyLoading) {
    return (
      <div className="page" data-testid="insights-api-gateway-page">
        <PageHeader
          eyebrow={tl('externalIntake')}
          titleAccent={tl('titleAccent')}
          titlePlain={tl('titlePlain')}
          pills={[]}
          actions={[]}
        />
        <StateView kind="loading" hint={tl('loadingApiGatewayPolicy')} />
      </div>
    );
  }

  if (usagePctWarn == null) {
    return (
      <div className="page" data-testid="insights-api-gateway-page">
        <PageHeader
          eyebrow={tl('externalIntake')}
          titleAccent={tl('titleAccent')}
          titlePlain={tl('titlePlain')}
          pills={[]}
          actions={[]}
        />
        <StateView
          kind="error"
          title={tl('gatewaySettingsUnavailable')}
          hint={tl('requiredGatewayAlertSettings')}
        />
      </div>
    );
  }

  return (
    <div className="page" data-testid="insights-api-gateway-page">
      <PageHeader
        eyebrow={tl('externalIntake')}
        titleAccent={tl('titleAccent')}
        titlePlain={tl('titlePlain')}
        pills={[
          <Chip
            key="src"
            label={tl('apiIntakeActivity')}
            kind="neutral"
            size="xs"
            className="mono"
          />,
          liveOn ? (
            <Chip
              key="live"
              label={fill(tl('liveUpdatesLivecountNew'), { liveCount: String(liveCount) })}
              kind="good"
              size="xs"
              className="mono"
            />
          ) : (
            <Chip key="live" label={tl('liveUpdatesPaused')} kind="neutral" size="xs" />
          ),
          realtimeMode ? (
            <Chip
              key="preview"
              label={tl('liveUpdatesActive')}
              kind="good"
              size="xs"
              className="mono"
              title={tl('liveUpdatesFollowIncoming')}
              data-testid="api-gateway-stream-mode"
            />
          ) : syntheticLiveTailAllowed ? (
            <Chip
              key="preview"
              label={tl('updateChecksActive')}
              kind="info"
              size="xs"
              className="mono"
              title={tl('updateChecksAreAvailable')}
              data-testid="api-gateway-stream-mode"
            />
          ) : (
            <Chip
              key="preview"
              label={tl('liveUpdatesUnavailable')}
              kind="warn"
              size="xs"
              className="mono"
              title={tl('liveUpdatesAreNot')}
              data-testid="api-gateway-stream-mode"
            />
          ),
        ]}
        actions={[
          <Button
            key="refresh"
            label={isRefreshingGatewayData ? tl('refreshing') : tl('refreshGatewayData')}
            iconName="refresh"
            kind="ghost"
            onClick={() => void refreshGatewayData()}
            disabled={!canRead || isRefreshingGatewayData}
          />,
          <Button
            key="test-api"
            label={tl('testShipmentApi')}
            iconName="plug"
            kind="primary"
            capability={CAP.API_GATEWAY_WRITE}
            onClick={onTestApiGatewayShipment}
          />,
          <Button
            key="block"
            label={tl('blockSource')}
            iconName="shield"
            kind="danger"
            capability={CAP.API_GATEWAY_WRITE}
            onClick={onBlockSource}
          />,
          <Button
            key="rate"
            label={tl('adjustRateLimit')}
            iconName="bolt"
            kind="ghost"
            capability={CAP.API_GATEWAY_WRITE}
            onClick={onAdjustRateLimit}
          />,
        ]}
      />

      <ExternalIntakeWorkspaceToolbar activePath={apiGatewayWorkspaceActivePath(view)} />

      <KpiStrip kpi={kpi} thresholds={apiGwThresholds ?? null} />

      <FilterBar
        range={range}
        onRangeChange={setRange}
        routePackId={routePackId}
        onRoutePackChange={setRoutePackId}
        routePacks={routePackRows}
        statusKlass={statusKlass}
        onStatusChange={setStatusKlass}
        sourceFilter={sourceFilter}
        onSourceChange={setSourceFilter}
        sourceOptions={sourceOptions}
        rateLimitOnly={rateLimitOnly}
        onRateLimitOnlyChange={setRateLimitOnly}
        liveOn={liveOn}
        onLiveChange={setLiveOn}
        liveTailAvailable={liveTailAvailable}
        realtimeMode={realtimeMode}
      />

      {/* W7 D1-A + D1-B: view-switcher tabs surface registered-but-unrendered
          api_gateway_requests + api_routes resources (registry.js:708 + 737). */}
      <div
        className="tabs"
        role="tablist"
        aria-label={tl('apiRequestEvidence')}
        data-testid="api-gateway-view-tabs"
        style={{ marginBottom: 12 }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'live'}
          data-key="live"
          className={`tabs__tab ${view === 'live' ? 'is-active' : ''}`}
          onClick={() => setView('live')}
        >
          {fill(tl('liveCallsCount'), { count: String(callRows.length + liveRows.length) })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'requests'}
          data-key="requests"
          className={`tabs__tab ${view === 'requests' ? 'is-active' : ''}`}
          onClick={() => setView('requests')}
        >
          {fill(tl('requestsCount'), { count: String(requestRows.length) })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'auth'}
          data-key="auth"
          className={`tabs__tab ${view === 'auth' ? 'is-active' : ''}`}
          onClick={() => setView('auth')}
        >
          {fill(tl('rejectedIntakeCount'), { count: String(authRejectionRows.length) })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'routes'}
          data-key="routes"
          className={`tabs__tab ${view === 'routes' ? 'is-active' : ''}`}
          onClick={() => setView('routes')}
        >
          {fill(tl('routesCount'), { count: String(routeRows.length) })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'sources'}
          data-key="sources"
          className={`tabs__tab ${view === 'sources' ? 'is-active' : ''}`}
          onClick={() => setView('sources')}
        >
          {fill(tl('sourcesCount'), { count: String(sourceControlRows.length) })}
        </button>
      </div>

      {view === 'auth' ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '-4px 0 10px' }}>
          <Button
            kind="ghost"
            size="sm"
            iconName="refresh"
            label={authRejectionsQ.isFetching ? tl('refreshing') : tl('refreshRejectedRequests')}
            onClick={() => void authRejectionsQ.refetch()}
            disabled={authRejectionsQ.isFetching}
            ariaLabel={tl('refreshRejectedApiRequests')}
          />
        </div>
      ) : null}

      {view === 'live' ? (
        isError ? (
          <StateView kind="error" hint={tl('couldNotLoadApi')} />
        ) : isLoading ? (
          <StateView kind="loading" hint={tl('loadingApiGatewayRequests')} />
        ) : rows.length === 0 ? (
          <StateView
            kind="empty"
            title={tl('noMatchingRequests')}
            hint={tl('tryAWiderWindow')}
          />
        ) : (
          <DataTable<ApiCallRow>
            columns={columns}
            rows={rows}
            viewKey="api_call_log"
            entityKind="api_request"
            onRowClick={openRow}
            rowActions={rowActions}
          />
        )
      ) : view === 'requests' ? (
        requestsQ.isError ? (
          <StateView kind="error" hint={tl('couldNotLoadSaved')} />
        ) : requestsQ.isLoading ? (
          <StateView kind="loading" hint={tl('loadingSavedIntakeRequests')} />
        ) : filteredRequests.length === 0 ? (
          <StateView
            kind="empty"
            title={tl('noMatchingRequests')}
            hint={tl('tryClearingTheRoute')}
          />
        ) : (
          <DataTable<ApiGatewayRequestRow>
            columns={requestColumns}
            rows={filteredRequests}
            viewKey="api_gateway_requests"
            entityKind="api_gateway_request"
            onRowClick={openGatewayRequestRow}
            rowActions={requestRowActions}
          />
        )
      ) : view === 'auth' ? (
        authRejectionsQ.isError ? (
          <StateView kind="error" hint={tl('couldNotLoadRejected')} />
        ) : authRejectionsQ.isLoading ? (
          <StateView kind="loading" hint={tl('loadingRejectedIntakeRequests')} />
        ) : filteredAuthRejections.length === 0 ? (
          <StateView
            kind="empty"
            title={tl('noRejectedApiRequests')}
            hint={tl('invalidOrDisabledSource')}
          />
        ) : (
          <DataTable<ApiGatewayAuthRejectionRow>
            columns={authRejectionColumns}
            rows={filteredAuthRejections}
            viewKey="api_gateway_auth_rejections"
            entityKind="api_gateway_auth_rejection"
            onRowClick={openAuthRejectionRow}
            rowActions={authRejectionRowActions}
          />
        )
      ) : view === 'routes' ? (
        routesQ.isError ? (
          <StateView kind="error" hint={tl('couldNotLoadApi2')} />
        ) : routesQ.isLoading ? (
          <StateView kind="loading" hint={tl('loadingApiRoutes')} />
        ) : filteredRoutes.length === 0 ? (
          <StateView
            kind="empty"
            title={tl('noMatchingRoutes')}
            hint={tl('tryClearingTheRoute2')}
          />
        ) : (
          <DataTable<ApiRouteRow>
            columns={routeColumns}
            rows={filteredRoutes}
            viewKey="api_routes"
            entityKind="api_route"
            rowActions={routeRowActions}
          />
        )
      ) : (
        sourceDirectoryQ.isError || rateLimitsQ.isError ? (
          <StateView kind="error" hint={tl('couldNotLoadApi3')} />
        ) : sourceDirectoryQ.isLoading || rateLimitsQ.isLoading ? (
          <StateView kind="loading" hint={tl('loadingApiGatewaySource')} />
        ) : sourceControlRows.length === 0 ? (
          <StateView
            kind="empty"
            title={tl('noApiSources')}
            hint={tl('createOrBindAn')}
          />
        ) : (
          <DataTable<ApiGatewaySourceControlRow>
            columns={sourceControlColumns}
            rows={sourceControlRows}
            viewKey="api_gateway_source_controls"
            entityKind="api_gateway_source"
          />
        )
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────────────

// W54-D — KPI tone band thresholds resolve through canonical
// `api_gateway_thresholds` policy. The `KpiStrip` component receives the
// resolved policy from its parent so the tone math stays declarative and
// easy to test in isolation. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
//
// W74-Insights closure (Cycle F-R-14 P1-9) — strict no-fallback contract.
// The DEFAULT_* constants previously masked missing
// `api_gateway_thresholds` fields with literal `2/5/3/10/900/2000`
// numbers (mirroring policies.js#sv_350). Closure drops every constant
// and renders a `(missing-policy)` marker in neutral tone instead, so a
// partially-seeded policy is observable rather than silently coerced
// into a positive default. Mirrors the existing `latencyKind`
// strict-no-fallback pattern in `_api-gateway.helpers.ts`.
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
interface KpiStripProps {
  kpi: { total: number; errors: number; rateLimited: number; p95Latency: number };
  thresholds: {
    error_rate_warn_pct?: number;
    error_rate_danger_pct?: number;
    rate_limited_warn_count?: number;
    rate_limited_danger_count?: number;
    latency_p95_warn_ms?: number;
    latency_p95_danger_ms?: number;
    kpi_window_ms?: number;
  } | null;
}

function kpiWindowLabel(windowMs: number | undefined, t: Translate): string {
  const tl = scopeT(t, 'insightsApiGateway.kpiWindowLabel');
  if (windowMs == null) return tl('policyWindowMissing');
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (windowMs % dayMs === 0) return fill(tl('lastDays'), { count: String(windowMs / dayMs) });
  if (windowMs % hourMs === 0) return fill(tl('lastHours'), { count: String(windowMs / hourMs) });
  if (windowMs % minuteMs === 0) return fill(tl('lastMinutes'), { count: String(windowMs / minuteMs) });
  return fill(tl('lastSeconds'), { count: String(Math.round(windowMs / 1000)) });
}

function KpiStrip({ kpi, thresholds }: KpiStripProps) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.kpiStrip');
  const errorPct = kpi.total === 0 ? 0 : (kpi.errors / kpi.total) * 100;
  // Strict no-fallback: pass thresholds through unchanged. When a
  // boundary is undefined, the corresponding tone falls through to
  // `'neutral'` and the KPI delta surfaces a `(missing-policy)` marker
  // so the operator sees the gap instead of a default-driven tone.
  const errorWarn = thresholds?.error_rate_warn_pct;
  const errorDanger = thresholds?.error_rate_danger_pct;
  const rateLimitedWarn = thresholds?.rate_limited_warn_count;
  const rateLimitedDanger = thresholds?.rate_limited_danger_count;
  const latencyWarn = thresholds?.latency_p95_warn_ms;
  const latencyDanger = thresholds?.latency_p95_danger_ms;
  const windowLabel = kpiWindowLabel(thresholds?.kpi_window_ms, t);

  const errorTone: KPITone =
    errorWarn == null || errorDanger == null
      ? 'neutral'
      : errorPct >= errorDanger
        ? 'danger'
        : errorPct >= errorWarn
          ? 'warn'
          : 'good';
  const rateTone: KPITone =
    rateLimitedWarn == null || rateLimitedDanger == null
      ? 'neutral'
      : kpi.rateLimited >= rateLimitedDanger
        ? 'danger'
        : kpi.rateLimited >= rateLimitedWarn
          ? 'warn'
          : 'neutral';
  const latencyTone: KPITone =
    latencyWarn == null || latencyDanger == null
      ? 'neutral'
      : kpi.p95Latency >= latencyDanger
        ? 'danger'
        : kpi.p95Latency >= latencyWarn
          ? 'warn'
          : 'good';

  const errorDelta =
    errorWarn == null || errorDanger == null
      ? fill(tl('errorsOfTotalApi'), { errors: String(kpi.errors), total: String(kpi.total) })
      : fill(tl('errorsOfTotal'), { errors: String(kpi.errors), total: String(kpi.total) });
  const latencyDelta =
    latencyWarn == null || latencyDanger == null
      ? fill(tl('policySettingMissing'), { setting: 'api_gateway_thresholds.latency_p95_warn_ms/danger_ms' })
      : kpi.p95Latency >= latencyWarn
        ? fill(tl('overSloLatencywarnMs'), { latencyWarn: String(latencyWarn) })
        : tl('withinSlo');
  const rateDelta =
    rateLimitedWarn == null || rateLimitedDanger == null
      ? fill(tl('policySettingMissing'), { setting: 'api_gateway_thresholds.rate_limited_warn_count/danger_count' })
      : kpi.rateLimited > 0
        ? tl('rateLimitedResponses')
        : tl('noSaturation');
  return (
    <div
      className="kpi-strip"
      data-testid="api-gateway-kpi-strip"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 12,
        marginBottom: 16,
      }}
    >
      <KPICard
        label={fill(tl('requestsWindowlabel'), { windowLabel: String(windowLabel) })}
        value={kpi.total.toLocaleString()}
        tone="info"
        delta={fill(tl('errorsCount'), { count: String(kpi.errors) })}
      />
      <KPICard
        label={fill(tl('errorRateWindowlabel'), { windowLabel: String(windowLabel) })}
        value={pct(kpi.errors, kpi.total)}
        tone={errorTone}
        delta={errorDelta}
      />
      <KPICard
        label={fill(tl('p95LatencyWindowlabel'), { windowLabel: String(windowLabel) })}
        value={fill(t('insightsApiGateway.units.ms'), { ms: kpi.p95Latency.toLocaleString() })}
        tone={latencyTone}
        delta={latencyDelta}
      />
      <KPICard
        label={fill(tl('rateLimitedWindowlabel'), { windowLabel: String(windowLabel) })}
        value={kpi.rateLimited.toLocaleString()}
        tone={rateTone}
        delta={rateDelta}
      />
    </div>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────

interface FilterBarProps {
  range: RangeKey;
  onRangeChange: (next: RangeKey) => void;
  routePackId: string;
  onRoutePackChange: (id: string) => void;
  routePacks: RoutePackRow[];
  statusKlass: '' | '2xx' | '3xx' | '4xx' | '5xx';
  onStatusChange: (next: '' | '2xx' | '3xx' | '4xx' | '5xx') => void;
  sourceFilter: string;
  onSourceChange: (next: string) => void;
  sourceOptions: Array<{ id: string; label: string }>;
  rateLimitOnly: boolean;
  onRateLimitOnlyChange: (next: boolean) => void;
  liveOn: boolean;
  onLiveChange: (next: boolean) => void;
  liveTailAvailable: boolean;
  realtimeMode: boolean;
}

const CHIP_BTN_STYLE: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  cursor: 'pointer',
};

function FilterBar({
  range,
  onRangeChange,
  routePackId,
  onRoutePackChange,
  routePacks,
  statusKlass,
  onStatusChange,
  sourceFilter,
  onSourceChange,
  sourceOptions,
  rateLimitOnly,
  onRateLimitOnlyChange,
  liveOn,
  onLiveChange,
  liveTailAvailable,
  realtimeMode,
}: FilterBarProps) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.filterBar');
  // W27-cycle-D §7 — derive the FilterBar range options from the canonical
  // `RANGE_OPTIONS` SSOT in `_shared.ts` instead of duplicating the key list +
  // label record inline. Filter to the four windows surfaced by the api-gateway
  // FilterBar (1h/24h/7d/all). New ranges added upstream automatically light
  // up the helper map; the FilterBar stays opt-in via this filter.
  const FILTER_BAR_RANGES = new Set<RangeKey>(['1h', '24h', '7d', 'all']);
  const ranges: RangeKey[] = RANGE_OPTIONS
    .filter((r) => FILTER_BAR_RANGES.has(r.key))
    .map((r) => r.key);
  const rangeLabel: Record<RangeKey, string> = RANGE_OPTIONS.reduce(
    (acc, r) => {
      acc[r.key] = r.label;
      return acc;
    },
    {} as Record<RangeKey, string>,
  );
  return (
    <div className="view-bar" data-testid="api-gateway-filter-bar">
      <div className="view-bar__group" role="group" aria-label={tl('timeRange')}>
        <span className="eyebrow" aria-hidden>{tl('window')}</span>
        {ranges.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={range === r}
            data-range={r}
            onClick={() => onRangeChange(r)}
            style={CHIP_BTN_STYLE}
          >
            <Chip
              label={rangeLabel[r] ?? r}
              kind={range === r ? 'info' : 'neutral'}
              size="xs"
              className="mono"
            />
          </button>
        ))}
      </div>
      <div className="view-bar__group" role="group" aria-label={tl('statusClass')}>
        <span className="eyebrow" aria-hidden>{tl('status')}</span>
        <button
          type="button"
          aria-pressed={statusKlass === ''}
          onClick={() => onStatusChange('')}
          style={CHIP_BTN_STYLE}
        >
          <Chip label={tl('all')} kind={statusKlass === '' ? 'info' : 'neutral'} size="xs" className="mono" />
        </button>
        {STATUS_CLASSES.map((s) => {
          // W27-cycle-D §6 — tone resolves through the canonical
          // `api_status_class` lookup catalog (2xx/3xx/4xx/5xx). The helper
          // mirrors `statusKind` from `_api-gateway.helpers.ts` (which
          // operates on integer status codes); here we resolve directly off
          // the class label since the FilterBar uses the class string.
          const tone: ChipKind =
            (lookupRow('api_status_class', s)?.tone as ChipKind | undefined) ?? 'danger';
          return (
            <button
              key={s}
              type="button"
              aria-pressed={statusKlass === s}
              data-status={s}
              onClick={() => onStatusChange(s)}
              style={CHIP_BTN_STYLE}
            >
              <Chip label={s} kind={statusKlass === s ? tone : 'neutral'} size="xs" className="mono" />
            </button>
          );
        })}
      </div>
      <div className="view-bar__group">
        <label className="eyebrow" htmlFor="apigw-route-pack">{tl('routePack')}</label>
        <select
          id="apigw-route-pack"
          value={routePackId}
          onChange={(e) => onRoutePackChange(e.target.value)}
        >
          <option value="">{tl('allPacks')}</option>
          {routePacks.map((p) => (
            <option key={p.id} value={p.id}>
              {/* W13-2: rendered name only — `version` was a fictional FE field. */}
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="view-bar__group">
        <label className="eyebrow" htmlFor="apigw-source">{tl('source')}</label>
        <select
          id="apigw-source"
          value={sourceFilter}
          onChange={(e) => onSourceChange(e.target.value)}
        >
          <option value="">{tl('allSources')}</option>
          {sourceOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className={`btn btn--sm ${rateLimitOnly ? 'btn--primary' : 'btn--ghost'}`}
        aria-pressed={rateLimitOnly}
        onClick={() => onRateLimitOnlyChange(!rateLimitOnly)}
        title={tl('filterToRateLimited')}
      >
        {rateLimitOnly ? tl('rateLimitedOnlyOn') : tl('rateLimitedOnly')}
      </button>
      <div className="view-bar__spacer" />
      <button
        type="button"
        className={`btn btn--sm ${liveOn ? 'btn--primary' : 'btn--ghost'}`}
        aria-pressed={liveOn}
        disabled={!liveTailAvailable}
        onClick={() => {
          if (liveTailAvailable) onLiveChange(!liveOn);
        }}
        title={
          liveTailAvailable
            ? realtimeMode
              ? tl('followsIncomingApiGateway')
              : tl('runsUpdateChecks')
            : tl('liveUpdatesAreNot')
        }
        data-testid="api-gateway-live-toggle"
      >
        {liveTailAvailable ? (liveOn ? tl('pauseLiveTail') : tl('startLiveTail')) : tl('liveTailUnavailable')}
      </button>
    </div>
  );
}

// ─── Drawer body (5 tabs) ─────────────────────────────────────────────────

type DrawerTab = 'request' | 'response' | 'latency' | 'rate' | 'replay';

function drawerTabs(t: Translate): Array<{ id: DrawerTab; label: string }> {
  const tl = scopeT(t, 'insightsApiGateway.drawerTabs');
  return [
    { id: 'request', label: tl('request') },
    { id: 'response', label: tl('response') },
    { id: 'latency', label: tl('latency') },
    { id: 'rate', label: tl('rateLimit') },
    { id: 'replay', label: tl('replay') },
  ];
}

interface ApiCallDrawerBodyProps {
  row: ApiCallRow;
  rateRow: RateLimitRow | null;
  provider: ProviderHealthRow | null;
  usagePctWarn: number;
  // W54-D — `downstream_dominance_pct` from canonical
  // `api_gateway_thresholds` policy. Drives the latency-waterfall warn
  // segment color when downstream provider time exceeds this percentage of
  // total request time.
  //
  // W-Cycle-E2 (P1 #6) — typed as `number | undefined` (no `?? 30` fallback).
  // When undefined, the LatencyTab surface fails loud with a `(missing-policy)`
  // chip rather than masking the gap with an inline literal default.
  downstreamDominancePct: number | undefined;
}

function ApiGatewayAuthRejectionDrawerBody({ row }: { row: ApiGatewayAuthRejectionRow }) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.apiGatewayAuthRejectionDrawerBody');
  const requestPath = redactGatewayTokenPath(
    row.query_string ? `${row.path ?? '—'}?${row.query_string}` : row.path ?? '—',
  );
  const headerEntries = Object.entries(row.request_headers ?? {}).filter(([, value]) => value != null);
  const kvRows: KvRow[] = [
    { key: 'request_id_value', label: tl('requestId'), value: row.request_id ?? '-', mono: true },
    { key: 'correlation_id_value', label: tl('correlationId'), value: row.correlation_id ?? '-', mono: true },
    { key: 'id', label: tl('rejectionConfirmation'), value: row.id ? tl('available') : '—' },
    { key: 'request_id', label: tl('requestConfirmation'), value: row.request_id ? tl('available') : '—' },
    { key: 'correlation_id', label: tl('trackingKey'), value: row.correlation_id ? tl('linked') : '—' },
    { key: 'status', label: tl('status'), value: requestStatusLabel(t, row.http_status, 'rejected') },
    { key: 'failure_code', label: tl('failureType'), value: row.failure_code ? tl('requestRejected') : '—' },
    { key: 'failure_message', label: tl('failureMessage'), value: row.failure_message ? tl('sourceCredentialCouldNot') : '—' },
    { key: 'credential_kind', label: tl('credential'), value: row.credential_kind ? tl('sourceCredentialChecked') : '—' },
    { key: 'method', label: tl('method'), value: row.method ?? '—', mono: true },
    { key: 'path', label: tl('path'), value: requestPath, mono: true },
    { key: 'source', label: tl('source'), value: row.source_label ?? (row.source_id ? tl('linkedSource') : tl('unresolvedSource')) },
    { key: 'source_identifier', label: tl('sourceReference'), value: row.source_identifier ? tl('matched') : '—' },
    { key: 'client', label: tl('client'), value: row.client_label ?? (row.client_id ? tl('linkedClient') : '—') },
    { key: 'sender', label: tl('sender'), value: row.sender_label ?? (row.sender_id ? tl('linkedSender') : '—') },
    { key: 'token_fingerprint', label: tl('tokenCheck'), value: row.token_fingerprint ? tl('completed') : '—' },
    { key: 'occurred_at', label: tl('rejectedAt'), value: row.occurred_at, mono: true },
  ];

  return (
    <div data-testid="api-gateway-rejected-request-drawer-body">
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: '0 14px 14px',
          borderBottom: '1px solid var(--line)',
          marginBottom: 14,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="eyebrow">{tl('rejectedBeforeIntake')}</div>
          <div className="serif" style={{ fontSize: 18 }}>{row.source_label ?? tl('unresolvedSourceToken')}</div>
          <div className="state__hint">{tl('requestWasStoppedBefore')}</div>
        </div>
        <Chip label={tl('rejected')} kind={statusKind(row.http_status)} size="xs" />
        <Chip label={tl('requestRejected')} kind="danger" size="xs" />
      </div>

      <KvGrid rows={kvRows} />

      <h4 className="eyebrow" style={{ marginTop: 14 }}>{tl('requestProtection')}</h4>
      <StateView
        kind="empty"
        title={headerEntries.length ? tl('requestDetailsProtected') : tl('noRequestDetailsAvailable')}
        hint={tl('sensitiveRequestHeadersAnd')}
      />
    </div>
  );
}

function ApiGatewayRequestDrawerBody({ row, route }: { row: ApiGatewayRequestRow; route?: ApiRouteRow | null }) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.apiGatewayRequestDrawerBody');
  const headerEntries = Object.entries(row.request_headers ?? {}).filter(([, value]) => value != null);
  const requestPath = redactGatewayTokenPath(row.query_string ? `${row.path}?${row.query_string}` : row.path);
  const isPostprocessFailure =
    row.intake_state === 'provider_failed' &&
    Boolean(row.outbound_error_message);
  const kvRows: KvRow[] = [
    { key: 'request_id_value', label: tl('requestId'), value: row.request_id ?? '-', mono: true },
    { key: 'correlation_id_value', label: tl('correlationId'), value: row.correlation_id ?? '-', mono: true },
    { key: 'request_id', label: tl('requestConfirmation'), value: row.request_id ? tl('available') : '—' },
    { key: 'correlation_id', label: tl('trackingKey'), value: row.correlation_id ? tl('linked') : '—' },
    { key: 'method', label: tl('method'), value: row.method, mono: true },
    { key: 'path', label: tl('path'), value: requestPath, mono: true },
    { key: 'source', label: tl('source'), value: row.source_label ?? (row.source_id ? tl('linkedSource') : '—') },
    { key: 'route', label: tl('route'), value: row.route_name ?? (row.route_id ? tl('linkedRoute') : '—') },
    { key: 'route_pack', label: tl('routePack'), value: row.route_pack_name ?? (row.route_pack_id ? tl('linkedRoutePack') : '—') },
    { key: 'client', label: tl('client'), value: row.client_label ?? (row.client_id ? tl('linkedClient') : '—') },
    { key: 'sender', label: tl('sender'), value: row.sender_label ?? (row.sender_id ? tl('linkedSender') : '—') },
    { key: 'intake_state', label: tl('intakeState'), value: requestIntakeLabel(t, row.intake_state) },
    { key: 'status', label: tl('status'), value: requestStatusLabel(t, row.status_code, row.intake_state) },
    { key: 'error_code', label: tl('requestOutcome'), value: row.error_code ? tl('needsReview') : tl('noIssueReported') },
    { key: 'outbound_error_message', label: tl('providerMessage'), value: row.outbound_error_message ? tl('needsReview') : '—' },
    { key: 'workflow_run_id', label: tl('workflowActivity'), value: row.workflow_run_id ? tl('linked') : '—' },
    { key: 'outbound_call_id', label: tl('providerActivity'), value: row.outbound_call_id ? tl('linked') : '—' },
    { key: 'workflow_run_id_value', label: tl('workflowRunId'), value: row.workflow_run_id ?? '-', mono: true },
    { key: 'outbound_call_id_value', label: tl('providerCallId'), value: row.outbound_call_id ?? '-', mono: true },
    { key: 'outbound_status', label: tl('providerStatus'), value: providerStatusLabel(t, row.outbound_status) },
    { key: 'shipment', label: tl('shipment'), value: row.tracking_number ?? row.shipment_id ?? '—', mono: !row.tracking_number },
    { key: 'shipment_status', label: tl('shipmentStatus'), value: row.shipment_status ?? '—', mono: true },
    { key: 'settings_resolution_id', label: tl('settingsConfirmation'), value: row.settings_resolution_id ? tl('confirmed') : '—' },
    { key: 'occurred_at', label: tl('received'), value: row.occurred_at, mono: true },
  ];

  return (
    <div data-testid="api-gateway-request-drawer-body">
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: '0 14px 14px',
          borderBottom: '1px solid var(--line)',
          marginBottom: 14,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="eyebrow">{tl('requestFirstIntake')}</div>
          <div className="serif" style={{ fontSize: 18 }}>{row.source_label ?? tl('unresolvedSource')}</div>
          <div className="state__hint">{tl('savedIntakeRequestSummary')}</div>
        </div>
        <Chip label={row.method} kind={methodKind(row.method)} size="xs" className="mono" />
        <Chip
          label={requestStatusLabel(t, row.status_code, row.intake_state)}
          kind={requestStatusTone(row.status_code, row.intake_state)}
          size="xs"
          className="mono"
        />
      </div>

      <KvGrid rows={kvRows} />

      <h4 className="eyebrow" style={{ marginTop: 14 }}>{tl('requestProtection')}</h4>
      <StateView
        kind="empty"
        title={headerEntries.length ? tl('requestDetailsProtected') : tl('noRequestDetailsAvailable')}
        hint={tl('sensitiveRequestHeadersAre')}
      />

      <h4 className="eyebrow" style={{ marginTop: 14 }}>{tl('shipmentConfirmation')}</h4>
      <div
        data-testid="api-gateway-materialization-readback-card"
        style={{
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: 12,
          display: 'grid',
          gap: 12,
          background: 'var(--paper-2)',
        }}
      >
        <KvGrid rows={requestMaterializationSummaryRows(row, t)} />
      </div>

      <h4 className="eyebrow" style={{ marginTop: 14 }}>{tl('routeMappingAndPostprocess')}</h4>
      {route ? (
        <div
          data-testid="api-gateway-route-mapping-card"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: 12,
            display: 'grid',
            gap: 12,
            background: 'var(--paper-2)',
          }}
        >
          {isPostprocessFailure ? (
            <StateView
              kind="error"
              title={tl('postprocessMappingNeedsAttention')}
              hint={tl('theProviderResponseWas')}
            />
          ) : null}
          <KvGrid rows={routeMappingSummaryRows(route, t)} />
          <StateView
            kind="empty"
            title={tl('routeSettingsApplied')}
            hint={tl('routeMappingAndProvider')}
          />
        </div>
      ) : row.route_id ? (
        <StateView
          kind="error"
          title={tl('routeMappingNotVisible')}
          hint={tl('thisRequestReferencesA')}
        />
      ) : (
        <StateView
          kind="empty"
          title={tl('noRouteMapping')}
          hint={tl('thisRequestDidNot')}
        />
      )}

      <h4 className="eyebrow" style={{ marginTop: 14 }}>{tl('requestPreview')}</h4>
      <StateView
        kind="empty"
        title={row.request_body ? tl('requestContentProtected') : tl('noRequestContentAvailable')}
        hint={tl('sensitiveRequestContentIs')}
      />
    </div>
  );
}

function ApiCallDrawerBody({ row, rateRow, provider, usagePctWarn, downstreamDominancePct }: ApiCallDrawerBodyProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<DrawerTab>('request');
  return (
    <div data-testid="api-gateway-drawer-body">
      {/* Header summary */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: '0 14px 14px',
          borderBottom: '1px solid var(--line)',
          marginBottom: 14,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div style={{ flex: 1, minWidth: 160 }}>
          <div className="eyebrow">{t('insightsApiGateway.apiCallDrawerBody.source')}</div>
          {/* W14-2: dropped fictional `source_ip` per
              `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1`. The canonical
              `api_call_log` table does not store source IP. */}
          <div className="serif" style={{ fontSize: 18 }}>{row.source_label ?? '—'}</div>
          <div className="mono" style={{ color: 'var(--ink-3)', fontSize: 10.5 }}>
            {row.source_id ?? ''}
          </div>
        </div>
        <div style={{ minWidth: 120 }}>
          <Chip label={row.method} kind={methodKind(row.method)} size="xs" className="mono" />
          <div className="mono" style={{ marginTop: 4, fontSize: 12 }}>{row.path}</div>
        </div>
        <div style={{ minWidth: 100 }}>
          <Chip label={String(row.status_code)} kind={statusKind(row.status_code)} size="xs" className="mono" />
          <div className="mono" style={{ marginTop: 4, fontSize: 11 }}>
            {formatOptionalDurationMs(row.duration_ms, t)}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" role="tablist" aria-label={t('insightsApiGateway.apiCallDrawerBody.apiRequestDrawerTabs')}>
        {drawerTabs(t).map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            data-key={entry.id}
            className={`tabs__tab ${tab === entry.id ? 'is-active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        {tab === 'request' ? <RequestTab row={row} /> : null}
        {tab === 'response' ? <ResponseTab row={row} /> : null}
        {tab === 'latency' ? <LatencyTab row={row} provider={provider} downstreamDominancePct={downstreamDominancePct} /> : null}
        {tab === 'rate' ? <RateLimitTab row={row} rateRow={rateRow} usagePctWarn={usagePctWarn} /> : null}
        {tab === 'replay' ? <ReplayTab row={row} /> : null}
      </div>
    </div>
  );
}

// ─── Tab: Request ─────────────────────────────────────────────────────────

function RequestTab({ row }: { row: ApiCallRow }) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.requestTab');
  // W14-2: dropped fictional `source_ip` + `source_kind` per
  // `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1`. The canonical projection view
  // does not expose these — they were FE-only synthesizer artefacts.
  // `headers` renamed to `request_headers` (canonical column name).
  const kvRows: KvRow[] = [
    { key: 'request_id', label: tl('requestConfirmation'), value: row.request_id ? tl('available') : '—' },
    { key: 'method', label: tl('method'), value: row.method, mono: true },
    { key: 'path', label: tl('path'), value: row.path, mono: true },
    { key: 'route_id', label: tl('route'), value: row.route_id ? tl('linkedRoute') : '—' },
    { key: 'route_pack_id', label: tl('routePack'), value: row.route_pack_id ? tl('linkedRoutePack') : '—' },
    { key: 'source_id', label: tl('source'), value: row.source_id ? tl('linkedSource') : '—' },
    { key: 'occurred_at', label: tl('when'), value: row.occurred_at, mono: true },
  ];
  const hasRequestHeaders = row.has_request_headers
    ?? Object.values(row.request_headers ?? {}).some((value) => value != null);
  return (
    <div data-testid="api-gateway-drawer-request-tab">
      <KvGrid rows={kvRows} />
      <h4 className="eyebrow" style={{ marginTop: 14 }}>{tl('requestProtection')}</h4>
      <StateView
        kind="empty"
        title={hasRequestHeaders ? tl('requestDetailsProtected') : tl('noRequestDetailsAvailable')}
        hint={tl('sensitiveRequestHeadersAre')}
      />
    </div>
  );
}

// ─── Tab: Response ────────────────────────────────────────────────────────

function ResponseTab({ row }: { row: ApiCallRow }) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.responseTab');
  const kvRows: KvRow[] = [
    { key: 'status_code', label: tl('status'), value: row.status_code, mono: true },
    { key: 'error_code', label: tl('requestOutcome'), value: row.error_code ? tl('needsReview') : '—' },
    { key: 'duration_ms', label: tl('duration'), value: formatOptionalDurationMs(row.duration_ms, t), mono: true },
    { key: 'response_size_bytes', label: tl('responseSize'), value: fill(t('insightsApiGateway.units.bytes'), { count: row.response_size_bytes.toLocaleString() }), mono: true },
  ];
  return (
    <div data-testid="api-gateway-drawer-response-tab">
      <KvGrid rows={kvRows} />
      <StateView
        kind="empty"
        title={row.response_size_bytes > 0 || row.response_body_sample ? tl('providerResponseRecorded') : tl('noProviderResponseAvailable')}
        hint={tl('sensitiveResponseContentIs')}
      />
    </div>
  );
}

// ─── Tab: Latency ─────────────────────────────────────────────────────────

function LatencyTab({
  row,
  provider,
  downstreamDominancePct,
}: {
  row: ApiCallRow;
  provider: ProviderHealthRow | null;
  // W54-D — canonical `api_gateway_thresholds.downstream_dominance_pct`.
  // Above this, the downstream segment of the waterfall renders the warn tone
  // instead of the good tone.
  //
  // W-Cycle-E2 (P1 #6) — `undefined` when the canonical policy is missing.
  // Tab renders a `(missing-policy)` chip in that case rather than falling back
  // to an inline `?? 30` literal.
  downstreamDominancePct: number | undefined;
}) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.latencyTab');
  // Segmented bar — gateway own time vs downstream provider time. The
  // canonical gateway projection does not yet split these explicitly so we
  // attribute provider latency to the most-recent provider_health_logs entry
  // within ±30 minutes (when present).
  // W13-2: latency resolves via `metadata.latency_ms` (canonical jsonb path).
  const downstream = latencyOf(provider);
  const total = Math.max(row.duration_ms, downstream);
  const ownMs = Math.max(0, row.duration_ms - downstream);
  const ownPct = total > 0 ? (ownMs / total) * 100 : 100;
  const downPct = 100 - ownPct;
  // W-Cycle-E2 (P1 #6) — neutral tone when the canonical threshold is missing
  // (renders alongside a `(missing-policy)` chip below). Strict no-fallback.
  const downstreamBackground =
    downstreamDominancePct == null
      ? 'var(--neutral, #8d8d8d)'
      : downPct > downstreamDominancePct
        ? 'var(--warn, #d4882a)'
        : 'var(--good, #48a06a)';
  return (
    <div data-testid="api-gateway-drawer-latency-tab">
      <div className="eyebrow">{tl('latencyBreakdown')}</div>
      {downstreamDominancePct == null ? (
        <Chip
          label={tl('gatewayTimingSettingsUnavailable')}
          kind="danger"
          size="xs"
          className="mono"
        />
      ) : null}
      <div
        aria-label={tl('latencyBreakdown2')}
        style={{
          marginTop: 8,
          display: 'flex',
          height: 14,
          background: 'var(--paper-3)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${ownPct}%`,
            background: 'var(--info, #5b8def)',
          }}
          title={fill(tl('gatewayOwnmsMs'), { ownMs: String(ownMs) })}
        />
        <div
          style={{
            width: `${downPct}%`,
            // W54-D — downstream dominance threshold resolves through
            // canonical `api_gateway_thresholds.downstream_dominance_pct`.
            background: downstreamBackground,
          }}
          title={fill(tl('providerTimeDownstreamMs'), { downstream: String(downstream) })}
        />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          fontSize: 11,
        }}
        className="mono"
      >
        <span>{fill(tl('gatewayOwnmsPct'), { ownMs: String(ownMs), pct: ownPct.toFixed(0) })}</span>
        <span>{fill(tl('providerTimeDownstreamPct'), { downstream: String(downstream), pct: downPct.toFixed(0) })}</span>
      </div>

      <h4 className="eyebrow" style={{ marginTop: 14 }}>{tl('providerHealthLast30')}</h4>
      {provider ? (
        <KvGrid
          rows={[
            { key: 'provider_id', label: tl('provider'), value: provider.provider_id, mono: true },
            { key: 'status', label: tl('status'), value: provider.status, lookup: 'provider_health_status' },
            // W13-2: latency lives in `metadata.latency_ms` jsonb on the canonical table.
            { key: 'latency_ms', label: tl('latency'), value: fill(t('insightsApiGateway.units.ms'), { ms: String(latencyOf(provider)) }), mono: true },
            { key: 'occurred_at', label: tl('when'), value: provider.occurred_at, mono: true },
            { key: 'error_message', label: tl('note'), value: provider.error_message ?? '—' },
          ]}
        />
      ) : (
        <div className="state__hint">{tl('noNearbyProviderTiming')}</div>
      )}
    </div>
  );
}

// ─── Tab: Rate limit ──────────────────────────────────────────────────────

function RateLimitTab({ row, rateRow, usagePctWarn }: { row: ApiCallRow; rateRow: RateLimitRow | null; usagePctWarn: number }) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.rateLimitTab');
  // W14-2: dropped fictional per-route fields (`route_id`, `route_path`,
  // `route_method`) per `__audit__/SCHEMA-DRIFT/INSIGHTS.md §2`. Canonical
  // `public.api_gateway_rate_limits` is per-source × hour bucket. The
  // projection view (`public.v_api_gateway_rate_limits_summary`) computes
  // `limit_per_min` (= rate_limit_per_hour / 60) and `saturated`
  // (= request_count >= rate_limit_per_hour).
  if (!rateRow) {
    return (
      <div data-testid="api-gateway-drawer-rate-tab" className="state__hint">
        {fill(tl('noRateLimitRow'), {
          source: String(row.source_label ?? row.source_id ?? tl('thisSource')),
        })}
      </div>
    );
  }
  const usagePct = rateRow.limit_per_min === 0
    ? 0
    : Math.min(100, (rateRow.current_usage / rateRow.limit_per_min) * 100);
  const tone: ChipKind = rateRow.saturated ? 'danger' : usagePct >= usagePctWarn ? 'warn' : 'good';
  return (
    <div data-testid="api-gateway-drawer-rate-tab">
      <KvGrid
        rows={[
          { key: 'source_label', label: tl('source'), value: rateRow.source_label ?? '—' },
          { key: 'limit_per_min', label: tl('limitMin'), value: rateRow.limit_per_min, mono: true },
          { key: 'limit_per_hour', label: tl('limitHour'), value: rateRow.limit_per_hour ?? rateRow.limit_per_min * 60, mono: true },
          { key: 'current_usage', label: tl('currentUsage'), value: rateRow.current_usage, mono: true },
          { key: 'window_start', label: tl('windowStart'), value: rateRow.window_start, mono: true },
        ]}
      />
      <div className="eyebrow" style={{ marginTop: 12 }}>{tl('windowSaturation')}</div>
      <div
        style={{
          marginTop: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          aria-label={tl('rateLimitSaturation')}
          style={{
            flex: 1,
            background: 'var(--paper-3)',
            height: 12,
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${usagePct}%`,
              height: '100%',
              background: tone === 'danger' ? 'var(--danger, #c0524a)' : tone === 'warn' ? 'var(--warn, #d4882a)' : 'var(--good, #48a06a)',
            }}
          />
        </div>
        <Chip label={`${usagePct.toFixed(0)}%`} kind={tone} size="xs" className="mono" />
      </div>
    </div>
  );
}

// ─── Tab: Replay (curl) ───────────────────────────────────────────────────

function ReplayTab({ row }: { row: ApiCallRow }) {
  const { t } = useI18n();
  return (
    <div data-testid="api-gateway-drawer-replay-tab">
      <StateView
        kind="empty"
        title={t('insightsApiGateway.replayTab.replayAvailableInTester')}
        hint={t('insightsApiGateway.replayTab.openTheTesterTo')}
      />
    </div>
  );
}

// ─── Modal: Block source ──────────────────────────────────────────────────
//
// REAUDIT INSIGHTS §D1 closure — the form now wires through the canonical
// `block_api_gateway_source_v1(p_args jsonb)` RPC via `useBlockApiGatewaySource`.
// On success, TanStack invalidates `webhook_sources` + `api_call_log` queries
// so the live-tail picks up the source's blocked state.
//
// Capability gate: `api_gateway.write` (canonical key registered in
// `202604280330_block_api_gateway_source_v1.sql`).

function ApiGatewayRouteMappingForm({
  route,
  mappings,
  currentMapping,
  disabled,
  saving,
  onSave,
  onClose,
  onOpenMappingStudio,
}: {
  route: ApiRouteRow;
  mappings: MappingConfigDirectoryRow[];
  currentMapping: MappingConfigDirectoryRow | null;
  disabled: boolean;
  saving: boolean;
  onSave: (mappingConfigId: string, mappingTarget: string) => Promise<void>;
  onClose: () => void;
  onOpenMappingStudio: (route: ApiRouteRow) => void;
}) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.apiGatewayRouteMappingForm');
  const currentRef = routeRequestMappingRef(route);
  const routeIntent = routeCanonicalIntent(route);
  const compatibleMappings = useMemo(
    () => routeCompatibleMappingRows(route, mappings),
    [mappings, route],
  );
  const initialMappingId = compatibleMappings.some((row) => row.id === currentMapping?.id)
    ? currentMapping?.id ?? ''
    : compatibleMappings.some((row) => row.id === currentRef?.id)
      ? currentRef?.id ?? ''
      : compatibleMappings[0]?.id ?? '';
  const [mappingId, setMappingId] = useState(initialMappingId);
  const [error, setError] = useState<string | null>(null);
  const selected = compatibleMappings.find((row) => row.id === mappingId) ?? null;
  useEffect(() => {
    if (mappingId && compatibleMappings.some((row) => row.id === mappingId)) return;
    setMappingId(compatibleMappings[0]?.id ?? '');
  }, [compatibleMappings, mappingId]);
  const canSubmit = Boolean(mappingId && selected) && !disabled && !saving;

  return (
    <form
      data-testid="api-gateway-route-mapping-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setError(null);
        try {
          await onSave(mappingId, stringValue(selected?.target));
        } catch (err) {
          const message = sanitizeOperatorMessage(
            err instanceof Error ? err.message : '',
            tl('routeMappingCouldNotBeSaved'),
          );
          setError(message);
          pushToast(message, 'danger');
        }
      }}
      style={{ display: 'grid', gap: 14, minWidth: 480, maxWidth: 680 }}
    >
      <KvGrid
        rows={[
          { key: 'route', label: tl('route'), value: `${route.method} ${routeDisplayPath(route)}`, mono: true },
          { key: 'scope', label: tl('scope'), value: `${route.scope_type ?? 'global'} ${route.scope_id ?? ''}`.trim(), mono: true },
          { key: 'intent', label: tl('intent'), value: routeIntent || tl('notDeclared'), mono: true },
          { key: 'current', label: tl('currentMapping'), value: currentRef?.id || currentRef?.key || tl('notLinked'), mono: true },
        ]}
      />

      {disabled ? (
        <StateView
          kind="error"
          title={tl('mappingWriteAccessRequired')}
          hint={tl('routeMappingChangesRequire')}
        />
      ) : null}

      {mappings.length === 0 ? (
        <StateView
          kind="empty"
          title={tl('noApiGatewayInbound')}
          hint={tl('createAnApiGateway')}
        />
      ) : compatibleMappings.length === 0 ? (
        <StateView
          kind="empty"
          title={tl('noCompatibleApiGateway')}
          hint={tl('onlyMappingsWhoseTarget')}
        />
      ) : (
        <>
          <label className="eyebrow" htmlFor="api-gateway-route-mapping-profile">
            {tl('mappingProfile')}
          </label>
          <select
            id="api-gateway-route-mapping-profile"
            value={mappingId}
            onChange={(event) => setMappingId(event.target.value)}
            disabled={disabled || saving}
            required
          >
            {compatibleMappings.map((row) => (
              <option key={row.id} value={row.id}>
                {mappingDirectoryLabel(row)}
              </option>
            ))}
          </select>
        </>
      )}

      {selected ? (
        <KvGrid
          rows={[
            { key: 'mapping_id', label: tl('mappingId'), value: selected.id, mono: true },
            { key: 'mapping_key', label: tl('mappingKey'), value: selected.mapping_key ?? '-', mono: true },
            { key: 'mapping_target', label: tl('target'), value: selected.target ?? '-', mono: true },
          ]}
        />
      ) : null}

      {error ? <StateView kind="error" title={tl('routeMappingSaveFailed')} hint={error} /> : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <Button
          label={tl('openMapping')}
          iconName="external"
          kind="ghost"
          disabled={!currentRef}
          onClick={() => onOpenMappingStudio(route)}
        />
        <Button label={tl('cancel')} kind="ghost" onClick={onClose} disabled={saving} />
        <Button
          label={saving ? tl('saving') : tl('saveMapping')}
          iconName="save"
          kind="primary"
          disabled={!canSubmit}
          type="submit"
        />
      </div>
    </form>
  );
}

function ApiGatewayShipmentTestForm({
  routes,
  sourceRows = [],
  tenantId,
  sourceLookupLoaded = false,
  sourceLookupError = false,
  providerAccountValue,
  credentialReadback,
  onClose,
  onOpenRequest,
  onOpenShipment,
  onOpenRoutePlanning,
  onOpenWorkflowRun,
  onOpenOutboundLifecycle,
  onRequestReadback,
  canOpenWorkflowContext,
  replayRequest,
  initialRouteId,
  routeMappingLabel,
}: {
  routes: ApiRouteRow[];
  sourceRows: WebhookSourceDirectoryRow[];
  tenantId?: string | null;
  sourceLookupLoaded: boolean;
  sourceLookupError: boolean;
  providerAccountValue: ProviderAccountSettingsValue | undefined;
  credentialReadback: ProviderCredentialReadback;
  onClose: () => void;
  onOpenRequest: (row: ApiGatewayRequestRow) => void | Promise<void>;
  onOpenShipment: (row: ApiGatewayRequestRow) => void | Promise<void>;
  onOpenRoutePlanning: (row: ApiGatewayRequestRow) => void | Promise<void>;
  onOpenWorkflowRun: (row: ApiGatewayRequestRow) => void | Promise<void>;
  onOpenOutboundLifecycle: (row: ApiGatewayRequestRow) => void | Promise<void>;
  onRequestReadback: (row: ApiGatewayRequestReadback) => void | Promise<void>;
  canOpenWorkflowContext: boolean;
  replayRequest?: ApiGatewayRequestRow | null;
  initialRouteId?: string | null;
  routeMappingLabel?: (route: ApiRouteRow | null | undefined) => string;
}) {
  const { t } = useI18n();
  const tl = useMemo(() => scopeT(t, 'insightsApiGateway.apiGatewayShipmentTestForm'), [t]);
  const go = useConsoleNavigator();
  const allowed = useCapability(CAP.API_GATEWAY_WRITE);
  const testRequest = useRunApiGatewayRequestTest();
  const selectableSources = useMemo(
    () => sourceRows.filter((row) => !isArchivedApiGatewaySource(row)),
    [sourceRows],
  );
  const initialTokenHandoff = useMemo(() => peekExternalIntakeSourceToken('api-gateway'), []);
  const initialTokenHandoffSourceId = initialTokenHandoff?.source_id ?? '';
  const replaySourceId = String(replayRequest?.source_id ?? '').trim();
  const replayRouteId = String(replayRequest?.route_id ?? '').trim();
  const replayRoutePath = String(replayRequest?.path ?? '').trim();
  const replayRouteMethod = String(replayRequest?.method ?? '').trim().toUpperCase();
  const replayRoute = useMemo(
    () => (
      routes.find((route) => route.id === replayRouteId)
      ?? routes.find((route) => (
        routeDisplayPath(route) === replayRoutePath
        && (!replayRouteMethod || String(route.method ?? '').trim().toUpperCase() === replayRouteMethod)
      ))
      ?? null
    ),
    [replayRouteId, replayRouteMethod, replayRoutePath, routes],
  );
  const replayRouteInitialId = replayRoute?.id ?? replayRouteId;
  const requestedInitialRouteId = String(initialRouteId ?? '').trim();
  const [sourceId, setSourceId] = useState(
    initialTokenHandoffSourceId || replaySourceId || (selectableSources[0]?.id ?? ''),
  );
  const [sourceTouched, setSourceTouched] = useState(Boolean(initialTokenHandoffSourceId || replaySourceId));
  const selectedSourceFromId = selectableSources.find((row) => row.id === sourceId) ?? null;
  const routePreferenceSource = selectedSourceFromId ?? selectableSources[0] ?? null;
  const shipmentTestRoutes = useMemo(() => {
    const enabled = routes.filter((row) => !row.deprecated);
    return enabled
      .filter(routeIsShipmentMutation)
      .sort((a, b) => compareShipmentTestRoutes(a, b, routePreferenceSource, tenantId));
  }, [routePreferenceSource, routes, tenantId]);
  const selectableRoutes = useMemo(() => {
    if (!replayRoute || shipmentTestRoutes.some((row) => row.id === replayRoute.id)) {
      return shipmentTestRoutes;
    }
    return [replayRoute, ...shipmentTestRoutes];
  }, [replayRoute, shipmentTestRoutes]);
  const requestedInitialRoute = useMemo(
    () => selectableRoutes.find((row) => row.id === requestedInitialRouteId) ?? null,
    [requestedInitialRouteId, selectableRoutes],
  );
  const [routeId, setRouteId] = useState(
    replayRouteInitialId || requestedInitialRoute?.id || (selectableRoutes[0]?.id ?? ''),
  );
  const [routeTouched, setRouteTouched] = useState(Boolean(replayRouteInitialId || requestedInitialRoute?.id));
  const selectedRoute = selectableRoutes.find((row) => row.id === routeId) ?? selectableRoutes[0] ?? null;
  const preferredSource = useMemo(
    () => (
      selectableSources.find((row) => !apiGatewaySourceReadiness(row, selectedRoute, t).blockingReason)
      ?? selectableSources[0]
      ?? null
    ),
    [selectableSources, selectedRoute],
  );
  const selectedSource = selectedSourceFromId ?? (sourceTouched && sourceId ? null : preferredSource);
  const selectedSourceReadiness = apiGatewaySourceReadiness(selectedSource, selectedRoute, t);
  const selectedRouteProviderPolicy = selectedRoute ? providerAccountPolicy(selectedRoute) : null;
  const selectedProviderAccountScope = useMemo(
    () => {
      if (!selectedSource?.id) {
        return tenantId ? { tenant_id: tenantId, organization_id: tenantId } : undefined;
      }
      return {
        source_id: selectedSource.id,
        webhook_source_id: selectedSource.id,
        organization_id: selectedSource.organization_id ?? tenantId ?? undefined,
        tenant_id: selectedSource.organization_id ?? tenantId ?? undefined,
        sender_id: selectedSource.sender_id ?? undefined,
        client_id: selectedSource.client_id ?? undefined,
      };
    },
    [
      selectedSource?.client_id,
      selectedSource?.id,
      selectedSource?.organization_id,
      selectedSource?.sender_id,
      tenantId,
    ],
  );
  const selectedProviderAccountQuery = useResolveSettings(
    selectedRouteProviderPolicy?.category === 'logestechs_v2_account' ? 'logestechs_v2_account' : '',
    selectedProviderAccountScope,
    { enabled: Boolean(selectedRouteProviderPolicy?.category === 'logestechs_v2_account') },
  );
  const selectedProviderAccountValue =
    (selectedProviderAccountQuery.data?.value as ProviderAccountSettingsValue | undefined) ?? providerAccountValue;
  const selectedCredentialListOpts = useMemo(
    () => ({ page_size: 200 }),
    [],
  );
  const selectedAuthConfigId = String(selectedProviderAccountValue?.auth_config_id ?? '').trim();
  const selectedCredentialQ = useResource<ProviderCredentialDirectoryRow>(
    'integration_credential_directory',
    selectedAuthConfigId || undefined,
  );
  const selectedCredentialsQ = useResourceList<ProviderCredentialDirectoryRow>(
    'integration_credential_directory',
    selectedCredentialListOpts,
    {
      enabled:
        Boolean(selectedAuthConfigId)
        && selectedRouteProviderPolicy?.category === 'logestechs_v2_account',
    },
  );
  const selectedCredentialLoaded = selectedCredentialQ.isSuccess && Boolean(selectedCredentialQ.data);
  const selectedCredentialLookupActive =
    Boolean(selectedAuthConfigId)
    && selectedRouteProviderPolicy?.category === 'logestechs_v2_account';
  const selectedCredentialReadback = useMemo<ProviderCredentialReadback>(
    () => ({
      rows: selectedCredentialQ.data
        ? [selectedCredentialQ.data]
        : selectedCredentialsQ.data?.rows?.length
          ? selectedCredentialsQ.data.rows
          : credentialReadback.rows,
      loaded:
        !selectedAuthConfigId
        || selectedCredentialLoaded
        || selectedCredentialsQ.isSuccess
        || credentialReadback.loaded,
      error: selectedCredentialQ.isError || selectedCredentialsQ.isError || credentialReadback.error,
    }),
    [
      credentialReadback.error,
      credentialReadback.loaded,
      credentialReadback.rows,
      selectedAuthConfigId,
      selectedCredentialQ.data,
      selectedCredentialQ.isError,
      selectedCredentialLoaded,
      selectedCredentialLookupActive,
      selectedCredentialsQ.data,
      selectedCredentialsQ.isError,
      selectedCredentialsQ.isSuccess,
    ],
  );
  const selectedRouteReadiness = selectedRoute
    ? routeProviderAccountReadiness(selectedRoute, selectedProviderAccountValue, selectedCredentialReadback, t)
    : null;
  const selectedRouteRequestMapping = routeRequestMappingRef(selectedRoute);
  const selectedRouteRequestMappingLabel = routeMappingLabel?.(selectedRoute)
    ?? (selectedRouteRequestMapping?.key || selectedRouteRequestMapping?.id || tl('noRequestMapping'));
  const replayRouteBlockedReason = replayRequest
    ? !selectedRoute
      ? tl('theOriginalApiRoute')
      : !routeIsShipmentMutation(selectedRoute)
        ? tl('thisApiRequestUses')
        : null
    : null;
  const tokenHandoffRef = useRef<ExternalIntakeTokenHandoff | null>(initialTokenHandoff);
  const tokenHandoffNotifiedRef = useRef(false);
  const [token, setToken] = useState('');
  const [correlationId, setCorrelationId] = useState(apiGatewayTestCorrelationId);
  const [idempotencyKey, setIdempotencyKey] = useState(correlationId);
  const replayPayloadText = useMemo(
    () => (replayRequest ? prettyOperatorJson(replayRequest.request_body ?? {}) : '{}'),
    [replayRequest],
  );
  const [payloadText, setPayloadText] = useState(replayRequest ? replayPayloadText : '{}');
  const [payloadEdited, setPayloadEdited] = useState(Boolean(replayRequest));
  const [queryString, setQueryString] = useState(
    () => String(replayRequest?.query_string ?? '').replace(/^\?+/, ''),
  );
  const [expectShipment, setExpectShipment] = useState(true);
  const [result, setResult] = useState<RunApiGatewayRequestTestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const routePayloadTemplate = useMemo(
    () => formatApiGatewayRoutePayloadTemplate(selectedRoute, correlationId),
    [selectedRoute, correlationId],
  );

  useEffect(() => {
    if (!replayRouteInitialId && requestedInitialRoute?.id && routeId !== requestedInitialRoute.id) {
      setRouteId(requestedInitialRoute.id);
      setRouteTouched(true);
      return;
    }
    const preferredRouteId = selectableRoutes[0]?.id;
    if (replayRouteInitialId && routeId === replayRouteInitialId) return;
    if (!preferredRouteId) return;
    if (!routeId || !selectableRoutes.some((row) => row.id === routeId) || (!routeTouched && routeId !== preferredRouteId)) {
      setRouteId(preferredRouteId);
    }
  }, [replayRouteInitialId, requestedInitialRoute, routeId, routeTouched, selectableRoutes]);

  useEffect(() => {
    if (!preferredSource) return;
    const selectedSourceStillExists = selectableSources.some((row) => row.id === sourceId);
    if (!sourceId || !selectedSourceStillExists || (!sourceTouched && sourceId !== preferredSource.id)) {
      setSourceId(preferredSource.id);
    }
  }, [preferredSource, selectableSources, sourceId, sourceTouched]);

  useEffect(() => {
    const handoff = tokenHandoffRef.current;
    if (!handoff) return;
    const handoffSourceId = String(handoff.source_id ?? '').trim();
    const sourceMatched = handoffSourceId
      ? selectableSources.some((row) => row.id === handoffSourceId)
      : true;
    if (!sourceMatched) {
      if (!sourceLookupLoaded) return;
      clearExternalIntakeSourceToken('api-gateway');
      tokenHandoffRef.current = null;
      if (token) setToken('');
      if (handoffSourceId && sourceId === handoffSourceId) {
        setSourceTouched(false);
        setSourceId(preferredSource?.id ?? '');
      }
      if (!tokenHandoffNotifiedRef.current) {
        tokenHandoffNotifiedRef.current = true;
        pushToast(tl('oneTimeSourceToken'), 'warn');
      }
      return;
    }
    if (handoffSourceId) {
      setSourceTouched(true);
      if (!requestedInitialRouteId) setRouteTouched(false);
      setSourceId(handoffSourceId);
    }
    if (token !== handoff.token) {
      setToken(handoff.token);
    }
    clearExternalIntakeSourceToken('api-gateway');
    tokenHandoffRef.current = null;
    if (!tokenHandoffNotifiedRef.current) {
      tokenHandoffNotifiedRef.current = true;
      pushToast(
        handoff.source_name
          ? fill(tl('loadedOneTimeToken'), { source_name: String(handoff.source_name) })
          : tl('loadedOneTimeSource'),
        'good',
      );
    }
  }, [preferredSource?.id, requestedInitialRouteId, selectableSources, sourceId, sourceLookupLoaded, token, tl]);

  useEffect(() => {
    setExpectShipment(routeIsShipmentMutation(selectedRoute));
  }, [selectedRoute]);

  useEffect(() => {
    if (!payloadEdited) setPayloadText(routePayloadTemplate);
  }, [payloadEdited, routePayloadTemplate]);

  const resultRow = requestRowFromGatewayTestResult(result);
  const routePath = routeDisplayPath(selectedRoute);
  const selectedRouteIntent = routeCanonicalIntent(selectedRoute);
  const routeBlockedReason = replayRouteBlockedReason ?? selectedRouteReadiness?.blockingReason;
  const routeSourceMismatchReason = apiGatewayRouteSourceMismatchReason(selectedRoute, selectedSource, t);
  const sourceBlockedReason =
    !sourceLookupLoaded
      ? tl('sourceLookupIsStill')
      : sourceLookupError
        ? tl('sourceLookupFailedRetry')
        : selectedSourceReadiness.blockingReason;
  const correlationBlockedReason = isUuid(correlationId)
    ? null
    : tl('useAValidTracking');
  const canSubmit = allowed && Boolean(
    selectedRoute &&
    routePath &&
    selectedSource &&
    token.trim() &&
    !routeBlockedReason &&
    !routeSourceMismatchReason &&
    !sourceBlockedReason &&
    !correlationBlockedReason,
  );
  const clearPreviousResult = () => {
    setResult(null);
    setErrorMessage(null);
  };
  const openProviderCredentialSetup = useCallback(() => {
    go('/integrations/credentials');
  }, [go]);
  const openApiSourceSetup = useCallback(() => {
    go('/integrations/sources');
  }, [go]);

  useEffect(() => {
    if (!result || !resultRow || apiGatewayRequestIsTerminal(resultRow)) return undefined;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      attempts += 1;
      try {
        const row = await readApiGatewayTestRequestReadback(result);
        if (cancelled) return;
        if (row) {
          void onRequestReadback(row);
          setResult((current) => {
            if (!current) return current;
            const currentRequestId = String(current.api_gateway_request_id ?? '').trim();
            const nextRequestId = String(row.request_id ?? row.id ?? '').trim();
            if (currentRequestId && nextRequestId && currentRequestId !== nextRequestId) return current;
            const unchanged = [
              ['status_code', current.request_readback?.status_code, row.status_code],
              ['intake_state', current.intake_state, row.intake_state],
              ['outbound_status', current.outbound_status, row.outbound_status],
              ['outbound_call_id', current.outbound_call_id, row.outbound_call_id],
              ['error_code', current.error_code, row.error_code],
              ['outbound_error_message', current.outbound_error_message, row.outbound_error_message],
              ['workflow_run_id', current.workflow_run_id, row.workflow_run_id],
              ['shipment_id', current.shipment_id, row.shipment_id],
              ['tracking_number', current.tracking_number, row.tracking_number],
            ].every(([, before, after]) => String(before ?? '') === String(after ?? ''));
            if (unchanged) return current;
            return mergeApiGatewayTestResultWithReadback(current, row);
          });
          if (apiGatewayRequestReadbackIsTerminal(row)) {
            if (row.shipment_id) {
              pushToast(fill(tl('apiShipmentConfirmedValue'), { value: String(row.tracking_number ?? row.shipment_id) }), 'good');
            } else {
              pushToast(fill(tl('apiRequestConfirmationUpdated'), { value: String(requestIntakeLabel(t, row.intake_state ?? row.outbound_status)) }), row.error_code ? 'warn' : 'info');
            }
            return;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(tl('couldNotConfirmSavedRequest'));
        }
        return;
      }

      if (!cancelled && attempts < API_GATEWAY_TEST_READBACK_MAX_ATTEMPTS) {
        timer = setTimeout(poll, API_GATEWAY_TEST_READBACK_POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(poll, API_GATEWAY_TEST_READBACK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [onRequestReadback, result, resultRow, t, tl]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !selectedRoute) return;
    setErrorMessage(null);
    try {
      const payload = parseJsonObjectInput(payloadText, t);
      const next = await withApiGatewayTestUiTimeout(
        testRequest.mutateAsync({
          auth_token: token,
          source_id: selectedSource?.id,
          method: selectedRoute.method,
          path: routePath,
          query_string: queryString.trim() ? queryString.trim().replace(/^\?+/, '') : null,
          payload,
          correlation_id: correlationId,
          idempotency_key: idempotencyKey || correlationId,
          expect_shipment: expectShipment,
          replay_of: replayRequest?.request_id ?? null,
        }),
        t,
      );
      const nextReadback = requestReadbackFromGatewayTestResult(next);
      setResult(nextReadback ? mergeApiGatewayTestResultWithReadback(next, nextReadback) : next);
      if (nextReadback) void onRequestReadback(nextReadback);
      pushToast(
        next.shipment_id
          ? fill(tl('apiShipmentConfirmedValue'), { value: String(next.tracking_number ?? next.shipment_id) })
          : fill(tl('apiRequestConfirmedValue'), { value: String(requestIntakeLabel(t, next.intake_state)) }),
        next.shipment_id ? 'good' : next.error_code ? 'warn' : 'info',
      );
    } catch {
      const message = tl('shipmentTestCouldNotComplete');
      testRequest.reset();
      setErrorMessage(message);
      pushToast(message, 'danger');
    } finally {
      setToken('');
    }
  };

  return (
    <form
      data-testid="api-gateway-shipment-test-form"
      onSubmit={submit}
      style={{ display: 'grid', gap: 14, minWidth: 520, maxWidth: 720 }}
    >
      {selectableRoutes.length === 0 ? (
        <StateView
          kind="empty"
          title={tl('noApiRoutesAre')}
          hint={tl('createOrEnableAn')}
        />
      ) : null}

      <div className="state__hint">
        {tl('thisConsoleTesterSends')}
      </div>

      {replayRequest ? (
        <StateView
          kind="empty"
          title={tl('replayPreparedFromSaved')}
          hint={tl('theSavedRouteSource')}
        />
      ) : null}

      <label className="eyebrow" htmlFor="api-gateway-test-route">{tl('route')}</label>
      <select
        id="api-gateway-test-route"
        value={routeId}
        onChange={(event) => {
          clearPreviousResult();
          setRouteTouched(true);
          setRouteId(event.target.value);
          setPayloadEdited(false);
        }}
        required
        disabled={testRequest.isPending || selectableRoutes.length === 0}
      >
        {routeId && !selectableRoutes.some((route) => route.id === routeId) ? (
          <option value={routeId}>
            {fill(tl('originalRouteNotVisible'), { route: replayRoutePath || routeId })}
          </option>
        ) : null}
        {selectableRoutes.map((route) => {
          return (
            <option key={route.id} value={route.id}>
              {apiGatewayRouteOptionLabel(t, route, selectedSource)}
            </option>
          );
        })}
      </select>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="eyebrow">{tl('shipmentIntent')}</span>
        <Chip
          label={selectedRouteIntent || tl('notDeclared')}
          kind={routeIsShipmentMutation(selectedRoute) ? 'good' : 'warn'}
          size="xs"
          className="mono"
        />
        <span className="state__hint">
          {tl('testerRoutesAreResolved')}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="eyebrow">{tl('routeScope')}</span>
        <Chip
          label={apiGatewayRouteScopeLabel(t, selectedRoute, selectedSource)}
          kind={routeSourceMismatchReason ? 'warn' : 'good'}
          size="xs"
        />
        <span className="state__hint">
          {tl('tenantDefaultsAndClient')}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="eyebrow">{tl('requestMapping')}</span>
        <Chip
          label={selectedRouteRequestMapping ? selectedRouteRequestMappingLabel : tl('notLinked')}
          kind={selectedRouteRequestMapping ? 'good' : 'warn'}
          size="xs"
          className={selectedRouteRequestMapping ? 'mono' : undefined}
        />
        {selectedRouteRequestMapping ? (
          <span className="state__hint">
            {selectedRouteRequestMapping.type} · {selectedRouteRequestMapping.target || tl('targetPending')}
          </span>
        ) : null}
      </div>

      {selectedRouteReadiness ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="eyebrow">{tl('providerAccount')}</span>
          <Chip label={selectedRouteReadiness.label} kind={selectedRouteReadiness.tone} size="xs" />
        </div>
      ) : null}

      {routeBlockedReason ? (
        <StateView
          kind="error"
          title={replayRouteBlockedReason ? tl('replayRouteCannotBe') : tl('providerCredentialRequired')}
          hint={routeBlockedReason}
          action={
            !replayRouteBlockedReason && selectedRouteProviderPolicy?.category === 'logestechs_v2_account' ? (
              <Button
                size="sm"
                kind="primary"
                iconName="key"
                capability={CAP.INTEGRATION_PLUGINS_WRITE}
                onClick={openProviderCredentialSetup}
              >
                {tl('openProviderCredentials')}
              </Button>
            ) : null
          }
        />
      ) : null}

      {routeSourceMismatchReason ? (
        <StateView
          kind="error"
          title={tl('routeAndSourceDo')}
          hint={routeSourceMismatchReason}
        />
      ) : null}

      <label className="eyebrow" htmlFor="api-gateway-source">{tl('source')}</label>
      <select
        id="api-gateway-source"
        value={selectedSource?.id ?? ''}
        onChange={(event) => {
          clearPreviousResult();
          setSourceTouched(true);
          setRouteTouched(false);
          setSourceId(event.target.value);
        }}
        required
        disabled={testRequest.isPending || !sourceLookupLoaded || selectableSources.length === 0}
      >
        {selectableSources.length === 0 ? (
          <option value="">{tl('noEligibleApiSources')}</option>
        ) : selectableSources.map((row) => (
          <option key={row.id} value={row.id}>
            {sourceDisplayLabel(row, t)}
          </option>
        ))}
      </select>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="eyebrow">{tl('sourceConfirmation')}</span>
        <Chip label={selectedSourceReadiness.label} kind={selectedSourceReadiness.tone} size="xs" />
        {selectedSource?.sender_label || selectedSource?.client_label ? (
          <span className="state__hint">
            {selectedSource.sender_label ?? tl('sender')} · {selectedSource.client_label ?? tl('client')}
          </span>
        ) : null}
      </div>

      {sourceBlockedReason ? (
        <StateView
          kind={sourceLookupLoaded && !sourceLookupError ? 'error' : 'empty'}
          title={selectedSourceReadiness.blockingTitle ?? tl('apiSourceLookupRequired')}
          hint={sourceBlockedReason}
          action={
            sourceLookupLoaded && !sourceLookupError ? (
              <Button
                size="sm"
                kind="primary"
                iconName="webhook"
                capability={CAP.WEBHOOKS_WRITE}
                onClick={openApiSourceSetup}
              >
                {tl('openIntakeSources')}
              </Button>
            ) : null
          }
        />
      ) : null}

      <label className="eyebrow" htmlFor="api-gateway-source-token">{tl('sourceToken')}</label>
      <input
        id="api-gateway-source-token"
        type="password"
        value={token}
        onChange={(event) => {
          clearPreviousResult();
          setToken(event.target.value);
        }}
        placeholder={tl('pasteTheApiGateway')}
        required
        disabled={testRequest.isPending}
      />
      <div className="state__hint">
        {tl('sourceTokensAreSecret')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <label className="eyebrow" htmlFor="api-gateway-correlation">{tl('trackingKey')}</label>
          <input
            id="api-gateway-correlation"
            value={correlationId}
            onChange={(event) => {
              clearPreviousResult();
              setCorrelationId(event.target.value);
              if (!idempotencyKey || idempotencyKey === correlationId) {
                setIdempotencyKey(event.target.value);
              }
            }}
            required
            disabled={testRequest.isPending}
          />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <label className="eyebrow" htmlFor="api-gateway-idempotency">{tl('idempotency')}</label>
          <input
            id="api-gateway-idempotency"
            value={idempotencyKey}
            onChange={(event) => {
              clearPreviousResult();
              setIdempotencyKey(event.target.value);
            }}
            required
            disabled={testRequest.isPending}
          />
        </div>
      </div>

      {correlationBlockedReason ? (
        <StateView
          kind="error"
          title={tl('trackingKeyNeedsReview')}
          hint={correlationBlockedReason}
        />
      ) : null}

      <label className="eyebrow" htmlFor="api-gateway-query-string">{tl('queryString')}</label>
      <input
        id="api-gateway-query-string"
        value={queryString}
        onChange={(event) => {
          clearPreviousResult();
          setQueryString(event.target.value.replace(/^\?+/, ''));
        }}
        placeholder={tl('channelConsoleTesterProof')}
        disabled={testRequest.isPending}
      />
      <div className="state__hint">
        {tl('optionalRequestQueryParameters')}
      </div>

      <label className="eyebrow" htmlFor="api-gateway-payload">{tl('requestPayload')}</label>
      <textarea
        id="api-gateway-payload"
        value={payloadText}
        onChange={(event) => {
          clearPreviousResult();
          setPayloadEdited(true);
          setPayloadText(event.target.value);
        }}
        rows={9}
        className="mono"
        spellCheck={false}
        disabled={testRequest.isPending}
        required
      />

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={expectShipment}
          onChange={(event) => {
            clearPreviousResult();
            setExpectShipment(event.target.checked);
          }}
          disabled={testRequest.isPending}
        />
        {tl('requireShipmentConfirmationWhen')}
      </label>

      {errorMessage ? (
        <StateView
          kind="error"
          title={tl('apiGatewayTestFailed')}
          hint={errorMessage}
        />
      ) : null}

      {result ? (
        <div
          data-testid="api-gateway-shipment-test-result"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: 12,
            display: 'grid',
            gap: 12,
            background: 'var(--paper-2)',
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip
              label={result.diagnostic_only ? tl('checkOnly') : requestIntakeLabel(t, result.intake_state)}
              kind={result.diagnostic_only ? 'warn' : requestIntakeTone(result.intake_state)}
              size="xs"
              className="mono"
            />
            {result.shipment_id ? (
              <Chip label={tl('shipmentConfirmed')} kind="good" size="xs" />
            ) : (
              <Chip label={tl('noShipmentProofYet')} kind={result.error_code ? 'warn' : 'info'} size="xs" />
            )}
          </div>
          <KvGrid
            rows={[
              { key: 'request', label: tl('requestConfirmation'), value: result.api_gateway_request_id ?? '-', mono: true },
              { key: 'query_string', label: tl('queryString'), value: result.query_string ?? '-', mono: true },
              { key: 'correlation', label: tl('trackingKey'), value: result.correlation_id ?? '-', mono: true },
              { key: 'idempotency', label: tl('idempotency'), value: result.idempotency_key ?? '-', mono: true },
              { key: 'workflow', label: tl('workflowActivity'), value: result.workflow_run_id ?? '-', mono: true },
              { key: 'outbound', label: tl('providerActivity'), value: result.outbound_call_id ?? '-', mono: true },
              { key: 'outbound_status', label: tl('providerStatus'), value: providerStatusLabel(t, result.outbound_status), mono: true },
              { key: 'shipment', label: tl('shipment'), value: result.tracking_number ?? result.shipment_id ?? '-', mono: true },
              { key: 'error', label: tl('requestOutcome'), value: result.error_code ? tl('needsReview') : '-', mono: true },
              { key: 'error_detail', label: tl('providerMessage'), value: result.outbound_error_message ? tl('needsReview') : '-', mono: true },
              ...requestMaterializationSummaryRows(resultRow, t),
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <Button
              label={tl('openRequest')}
              iconName="eye"
              kind="ghost"
              disabled={!resultRow}
              onClick={() => { if (resultRow) void onOpenRequest(resultRow); }}
            />
            <Button
              label={tl('openWorkflowActivity')}
              iconName="history"
              kind="ghost"
              disabled={!canOpenWorkflowContext || !resultRow?.workflow_run_id}
              onClick={() => {
                if (canOpenWorkflowContext && resultRow?.workflow_run_id) void onOpenWorkflowRun(resultRow);
              }}
            />
            <Button
              label={tl('openProviderActivity')}
              iconName="trace"
              kind="ghost"
              disabled={!resultRow?.outbound_call_id}
              onClick={() => { if (resultRow?.outbound_call_id) void onOpenOutboundLifecycle(resultRow); }}
            />
            <Button
              label={tl('planRoute')}
              iconName="route"
              kind="ghost"
              capabilities={[CAP.ROUTE_PLANS_READ, CAP.ROUTE_PLANS_WRITE]}
              disabled={!resultRow?.shipment_id}
              onClick={() => { if (resultRow?.shipment_id) void onOpenRoutePlanning(resultRow); }}
            />
            <Button
              label={tl('openShipmentContext')}
              iconName="package"
              kind="primary"
              disabled={!resultRow?.shipment_id}
              onClick={() => { if (resultRow?.shipment_id) void onOpenShipment(resultRow); }}
            />
          </div>
          <StateView
            kind="empty"
            title={result.response ? tl('providerResponseRecorded') : tl('noProviderResponseAvailable')}
            hint={tl('sensitiveResponseContentIs')}
          />
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button label={tl('close')} kind="ghost" onClick={onClose} />
        <Button
          type="submit"
          label={testRequest.isPending ? tl('sending') : tl('sendApiGatewayTest')}
          iconName="plug"
          kind="primary"
          capability={CAP.API_GATEWAY_WRITE}
          disabled={!canSubmit || testRequest.isPending || selectableRoutes.length === 0}
        />
      </div>
    </form>
  );
}

function BlockSourceForm({
  sources,
  onClose,
}: {
  sources: Array<{ id: string; label: string }>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.blockSourceForm');
  const allowed = useCapability(CAP.API_GATEWAY_WRITE);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const blockSource = useBlockApiGatewaySource();
  return (
    <form
      data-testid="api-gateway-block-source-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!allowed) return;
        try {
          await blockSource.mutateAsync({
            source_id: sourceId,
            reason: reason || undefined,
          });
          pushToast(fill(tl('sourceBlockedSourceid'), { sourceId: String(sourceId) }), 'good');
          onClose();
        } catch (err) {
          const message = err instanceof Error ? err.message : tl('blockFailed');
          pushToast(message, 'danger');
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 320 }}
    >
      <label className="eyebrow" htmlFor="block-source">{tl('source')}</label>
      <select
        id="block-source"
        value={sourceId}
        onChange={(e) => setSourceId(e.target.value)}
        required
      >
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {sources.length === 0 ? (
        <Chip
          label={tl('noApiSourcesAvailable')}
          kind="warn"
          size="xs"
        />
      ) : null}
      <label className="eyebrow" htmlFor="block-reason">{tl('reason')}</label>
      <textarea
        id="block-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder={tl('operatorNoteRecordedWith')}
        required
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button label={tl('cancel')} kind="ghost" onClick={onClose} disabled={blockSource.isPending} />
        <Button
          type="submit"
          label={blockSource.isPending ? tl('blocking') : tl('blockSource')}
          kind="danger"
          capability={CAP.API_GATEWAY_WRITE}
          disabled={blockSource.isPending || !sourceId}
        />
      </div>
    </form>
  );
}

// ─── Modal: Adjust rate limit ─────────────────────────────────────────────
//
// REAUDIT INSIGHTS §D2 closure — the form now wires through the canonical
// `adjust_api_gateway_rate_limit_v1(p_args jsonb)` RPC via
// `useAdjustApiGatewayRateLimit`. The FE form's per-minute bucket value is
// passed through as `limit_per_min`; the backend derives `limit_per_hour =
// limit_per_min × 60` and writes the canonical column on
// `webhook_sources.rate_limit_per_hour`.
//
// Capability gate: `api_gateway.write` (canonical key registered in
// `202604280330_block_api_gateway_source_v1.sql`).

function AdjustRateLimitForm({
  rateLimits,
  onClose,
}: {
  rateLimits: RateLimitRow[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tl = scopeT(t, 'insightsApiGateway.adjustRateLimitForm');
  const allowed = useCapability(CAP.API_GATEWAY_WRITE);
  // W77 (Insights Cycle F-R-17 P2) — initial-limit fallback resolves
  // canonically through `api_gateway_thresholds.default_rate_limit_per_min`.
  // Replaces inline `?? 60` literal so the surface is row-driven (AGENTS.md
  // §2 ZERO HARDCODING + §4 SSOT + §6 row-driven config). Strict no-fallback:
  // when the policy is missing the Save button disables and the form
  // surfaces a `(missing-policy)` chip mirroring the usagePctWarn pattern at
  // line ~793.
  const apiGwPolicy = useResolveSettings('api_gateway_thresholds', undefined);
  const apiGwThresholds = apiGwPolicy.data?.value as
    | { default_rate_limit_per_min?: number }
    | undefined;
  const defaultRateLimitPerMin = apiGwThresholds?.default_rate_limit_per_min;
  const policyMissing = defaultRateLimitPerMin == null;
  const [bucketId, setBucketId] = useState(rateLimits[0]?.id ?? '');
  const bucket = rateLimits.find((b) => b.id === bucketId) ?? rateLimits[0] ?? null;
  const [limit, setLimit] = useState<number | null>(
    bucket?.limit_per_min ?? defaultRateLimitPerMin ?? null,
  );
  const [reason, setReason] = useState('');
  const adjustRateLimit = useAdjustApiGatewayRateLimit();
  useEffect(() => {
    if (bucket) setLimit(bucket.limit_per_min);
    else if (defaultRateLimitPerMin != null) setLimit(defaultRateLimitPerMin);
  }, [bucket, defaultRateLimitPerMin]);
  return (
    <form
      data-testid="api-gateway-adjust-rate-limit-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!allowed || !bucket || limit == null) return;
        try {
          await adjustRateLimit.mutateAsync({
            source_id: bucket.source_id,
            limit_per_min: limit,
            reason: reason || undefined,
          });
          pushToast(fill(tl('rateLimitSourceLabel'), { source_label: String(bucket.source_label), limit: String(limit) }), 'good');
          onClose();
        } catch (err) {
          const message = err instanceof Error ? err.message : tl('adjustFailed');
          pushToast(message, 'danger');
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 360 }}
    >
      {policyMissing ? (
        <Chip
          label={tl('defaultRateLimitPolicy')}
          kind="danger"
          size="xs"
        />
      ) : null}
      <label className="eyebrow" htmlFor="rate-bucket">{tl('bucket')}</label>
      <select
        id="rate-bucket"
        value={bucketId}
        onChange={(e) => setBucketId(e.target.value)}
        required
      >
        {rateLimits.map((r) => (
          <option key={r.id} value={r.id}>
            {/* W14-2: dropped fictional route_method / route_path per
                `__audit__/SCHEMA-DRIFT/INSIGHTS.md §2`. Canonical bucket
                is per-source × hour, not per-route. */}
            {fill(tl('bucketOption'), { source: String(r.source_label ?? r.source_id), limit: String(r.limit_per_min) })}
          </option>
        ))}
      </select>
      <label className="eyebrow" htmlFor="rate-limit">{tl('limitMin')}</label>
      <input
        id="rate-limit"
        type="number"
        min={1}
        value={limit ?? ''}
        onChange={(e) => setLimit(Number(e.target.value))}
        required
      />
      <label className="eyebrow" htmlFor="rate-reason">{tl('reason')}</label>
      <textarea
        id="rate-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder={tl('operatorNoteRecordedWith')}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button label={tl('cancel')} kind="ghost" onClick={onClose} disabled={adjustRateLimit.isPending} />
        <Button
          type="submit"
          label={adjustRateLimit.isPending ? tl('applying') : tl('apply')}
          kind="primary"
          capability={CAP.API_GATEWAY_WRITE}
          disabled={adjustRateLimit.isPending || policyMissing || limit == null || !bucket}
        />
      </div>
    </form>
  );
}

// Pure-function re-exports for tests live in `./_api-gateway.helpers.ts`
// (kept out of this file so `react-refresh/only-export-components` stays
// satisfied and HMR remains healthy).

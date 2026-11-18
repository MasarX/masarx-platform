// _api-gateway.helpers.ts — CLAIM-INSIGHTS-API-GW (Wave 3, Phase C).
//
// Pure helpers for the API gateway observability module. Lives in a `.ts`
// sibling so the JSX module file (`api-gateway.tsx`) only re-exports
// components, keeping `react-refresh/only-export-components` happy.
//
// All helpers are deterministic, side-effect free, and unit-tested under
// `__tests__/api-gateway.test.tsx` via the `__test` re-export.
//
// ============================================================================
// REALTIME LIVE-TAIL CONTRACT (Phase F)
// ============================================================================
// Two modes are supported, env-gated and zero-hardcoded:
//
//   1. DEV PREVIEW mode (`VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL=true` AND
//      mode is development/test):
//      The module schedules `synthesizeRow` against a row-driven interval so
//      local previews can exercise live-tail UI without backend Realtime.
//
//   2. LIVE mode (`VITE_REALTIME_ENABLED=true` AND a Supabase client is
//      available): the module subscribes to `postgres_changes` on the
//      `api_call_log` table via Supabase Realtime channels. Each INSERT is
//      shaped into an `ApiCallRow` and prepended onto the live-rows buffer.
//      The synthetic generator is fully bypassed.
//
// The seam reads strictly via `import.meta.env`/`getSupabaseClient()` and
// never starts synthetic rows in production, in line with the AGENTS.md
// zero-hardcoding objective.
// ============================================================================

import type { ChipKind } from '@/components/Chip';
import { lookupRow } from '@/lib/api';

// W14-2 (api-gateway-observability projection): drop fictional fields
// (`source_kind`, `source_ip`) per `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1`.
// The remaining fields are exposed by `public.v_api_gateway_observability`
// (joined projection over api_call_log + api_gateway_requests + api_routes
// + webhook_sources). FE consumers route through the
// `api_gateway_observability` resource key.
export interface ApiCallRowLite {
  id: string;
  // request_id projects from api_gateway_requests.id; NULL when no joined
  // request row exists (api_call_log can fire without an upstream request).
  request_id: string | null;
  method: string;
  // path projects from api_call_log.url with the query string stripped.
  path: string;
  // status_code aliases api_call_log.response_status.
  status_code: number;
  // error_code derives from response_status / error_message in the view.
  error_code?: string | null;
  duration_ms: number;
  // source_id / source_label / route_id / route_pack_id project from the
  // joined api_gateway_requests + api_routes + webhook_sources rows.
  source_id: string | null;
  source_label: string | null;
  source_org_id?: string | null;
  route_id: string | null;
  route_pack_id: string | null;
  // occurred_at aliases api_call_log.timestamp.
  occurred_at: string;
  // request_headers / response_body / response_body_sample project from
  // canonical api_call_log columns; the view truncates response_body_sample
  // to LEFT(response_body::text, 4096).
  request_headers?: Record<string, string | null | undefined>;
  request_body?: Record<string, unknown> | string | null;
  response_size_bytes: number;
  response_body_sample?: string | null;
  // W-Cycle-E (P2 #4) — when set, marks the row as fabricated by the
  // demo-mode `synthesizeRow` generator (no canonical projection backing).
  // Consumed by api-gateway.tsx to render a "PREVIEW · synthetic" badge so
  // operators can distinguish demo-mode rows from real Realtime payloads.
  synthetic?: boolean;
}

// ---------- Status / latency / method classification ----------

// W54-D — `statusClass` stays a deterministic numeric → status-class mapper
// (no row lookup) since the 2xx/3xx/4xx/5xx boundaries are HTTP RFC
// invariants, not policy. The downstream `statusKind` resolves the chip
// tone through the canonical `api_status_class` lookup so the tone palette
// stays row-driven.
export function statusClass(code: number): '2xx' | '3xx' | '4xx' | '5xx' {
  if (code < 300) return '2xx';
  if (code < 400) return '3xx';
  if (code < 500) return '4xx';
  return '5xx';
}

// W54-D — chip tone resolves through canonical `api_status_class` lookup
// (2xx=good / 3xx=neutral / 4xx=warn / 5xx=danger). Missing canonical row
// falls through to `danger` so the gap surfaces visibly. AGENTS.md §2
// (ZERO HARDCODING) + §4 (SSOT).
export function statusKind(code: number): ChipKind {
  const c = statusClass(code);
  const tone = lookupRow('api_status_class', c)?.tone as ChipKind | undefined;
  return tone ?? 'danger';
}

/**
 * Latency-band thresholds — canonical SSOT is the
 * `api_gateway_thresholds` settings policy
 * (`latency_band_warn_ms` / `latency_band_danger_ms`). Helpers accept the
 * resolved policy object as an optional argument so the same pure helper
 * can be unit-tested in isolation while production callers (api-gateway.tsx)
 * resolve via `useResolveSettings('api_gateway_thresholds')` and pass the
 * canonical thresholds in. Defaults mirror policies.js#sv_350 for the
 * fallback path (registry not yet resolved during initial mount).
 */
export interface ApiGatewayThresholds {
  latency_band_good_boundary_ms?: number;
  latency_band_warn_ms?: number;
  latency_band_danger_ms?: number;
  latency_p95_warn_ms?: number;
  latency_p95_danger_ms?: number;
  error_rate_warn_pct?: number;
  error_rate_danger_pct?: number;
  rate_limited_warn_count?: number;
  rate_limited_danger_count?: number;
  downstream_dominance_pct?: number;
}

// W-Cycle-E (P2 #3) — strict no-fallback contract. The prior
// `DEFAULT_API_GATEWAY_THRESHOLDS` exported constant + `??` fallback ladder
// silently masked an unresolved policy state behind canonical-looking band
// numbers. Helpers now REQUIRE the resolved policy and return `null` when
// any boundary is missing, so consumers (api-gateway.tsx) surface an
// explicit `<StateView kind="error" hint="api_gateway_thresholds policy not
// seeded"/>` rather than rendering a green chip from inferred defaults.
// SSOT lives at `policies.js#sv_350` — operators and tenants configure
// thresholds there and the FE contract is fail-loud when missing.
export function latencyKind(
  ms: number,
  thresholds: ApiGatewayThresholds | null | undefined,
): ChipKind | null {
  if (
    !thresholds ||
    thresholds.latency_band_good_boundary_ms == null ||
    thresholds.latency_band_warn_ms == null ||
    thresholds.latency_band_danger_ms == null
  ) {
    return null;
  }
  if (ms < thresholds.latency_band_good_boundary_ms) return 'good';
  if (ms < thresholds.latency_band_warn_ms) return 'info';
  if (ms < thresholds.latency_band_danger_ms) return 'warn';
  return 'danger';
}

// W54-D — chip tone resolves through canonical `http_method` lookup
// (GET=info / POST=good / PUT=warn / PATCH=warn / DELETE=danger). Missing
// canonical row falls through to `warn` (the historical "unknown verb"
// tone) so the surface still renders without breaking layout.
export function methodKind(m: string): ChipKind {
  const tone = lookupRow('http_method', m)?.tone as ChipKind | undefined;
  return tone ?? 'warn';
}

export {
  SENSITIVE_HEADERS,
  prettyOperatorJson,
  redactHeader,
  redactSensitiveText,
} from '@/lib/operator-redaction';

// ---------- Numeric helpers ----------

/** Compute the p95 over a numeric set. Returns 0 for an empty set. */
export function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
}

/** Format a percentage with one decimal. Returns "0%" when denominator is 0. */
export function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Short relative-time formatter ("just now" / "12m ago" / "3h ago" / "2d ago"). */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ---------- Live-tail synthesizer ----------
//
// W-Cycle-E2 (P2 #12) — DEV-PREVIEW-MODE-ONLY constants. The numeric
// literals below (status distribution percentages 84/92, base latency 60ms,
// jitter constants 113/320, ordinal hash multiplier 7919, body sample size
// constants 220/17/1800, slow-path penalty 1200ms, etc) are illustrative
// constants for the live-tail demo synthesizer when no Realtime client is
// available in local development/test. They never reach production paths:
// production consumes canonical `public.api_call_log` projection rows via the
// data-source seam (see `decisions.tsx` / `api-gateway.tsx#openRow`). The
// synthesizer remains gated behind `isSyntheticLiveTailAllowed()` and exists
// only so local preview surfaces can exercise the live-tail UI. Magic
// literals here are intentionally retained as dev-preview illustrative
// constants.

/**
 * Generate a deterministic synthetic api_call_log row from an anchor row +
 * an ordinal. Status distribution is skewed toward 200 with a small (8%)
 * 429 tail and a smaller (8%) 5xx tail so the live-tail demo always has a
 * believable trickle of warnings/errors without flooding the table.
 *
 * Authorization is intentionally REPLACED with a fresh live-token marker so
 * the redaction path in the drawer stays exercised.
 *
 * NOTE: this function is dev-preview-mode only — see the block comment above.
 */
export function synthesizeRow<T extends ApiCallRowLite>(anchor: T, ordinal: number): T {
  const r = (ordinal * 7919) % 100;
  let status = 200;
  let errCode: string | null = null;
  if (r < 84) status = 200;
  else if (r < 92) {
    status = 429;
    errCode = 'rate_limited';
  } else {
    status = 502;
    errCode = 'upstream_error';
  }
  const duration = 60 + ((ordinal * 113) % 320);
  const requestId = `req_live_${ordinal.toString(16)}`;
  return {
    ...anchor,
    id: `cal_live_${ordinal.toString(16)}`,
    request_id: requestId,
    status_code: status,
    error_code: errCode,
    duration_ms: status >= 500 ? duration + 1200 : duration,
    occurred_at: new Date().toISOString(),
    request_headers: {
      ...(anchor.request_headers ?? {}),
      Authorization: `Bearer sk_live_${requestId}`,
      'x-correlation-id': `cor_live_${ordinal.toString(16)}`,
    },
    response_size_bytes: 220 + ((ordinal * 17) % 1800),
    response_body_sample:
      status >= 400
        ? JSON.stringify({ error: errCode, message: `${errCode} for ${anchor.path}` })
        : JSON.stringify({ ok: true, request_id: requestId }),
    // W-Cycle-E (P2 #4) — flag the row as fabricated so the operator can
    // distinguish synthesizer demo-mode rows from real Realtime payloads
    // when LIVE mode kicks in. Consumed by api-gateway.tsx row renderer.
    synthetic: true,
  };
}

// ---------- Realtime envelope shaping ----------

/**
 * Shape a Supabase Realtime `postgres_changes` payload row into the FE
 * `ApiCallRowLite` contract. The Realtime row mirrors the canonical
 * `public.api_call_log` columns; we map column names directly and fall back
 * to safe defaults for the FE-only join columns (`source_label` /
 * `source_kind`) which are populated by the gateway projection joins on the
 * read side. Returns null when the payload is missing required fields so the
 * caller can skip the prepend.
 */
export function shapeRealtimePayload(
  newRow: Record<string, unknown> | null | undefined,
): ApiCallRowLite | null {
  if (!newRow || typeof newRow !== 'object') return null;
  const r = newRow as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  const method = typeof r.method === 'string' ? r.method : null;
  // `path` projects from `v_api_gateway_observability.path` (URL with query
  // stripped). When the realtime envelope is api_call_log raw, derive path
  // from the canonical `url` column.
  const rawUrl = typeof r.url === 'string' ? r.url : null;
  const path =
    typeof r.path === 'string'
      ? r.path
      : rawUrl
        ? rawUrl.split('?')[0] ?? rawUrl
        : null;
  if (!id || !method || !path) return null;

  // Canonical api_call_log uses `request_headers`; the projection view
  // exposes the same column name. Older envelopes may use `headers`.
  const headersRaw = r.request_headers ?? r.headers;
  const requestHeaders =
    headersRaw && typeof headersRaw === 'object' && !Array.isArray(headersRaw)
      ? (headersRaw as Record<string, string | null | undefined>)
      : undefined;
  const requestBody =
    typeof r.request_body === 'string' ||
    (r.request_body && typeof r.request_body === 'object' && !Array.isArray(r.request_body))
      ? (r.request_body as Record<string, unknown> | string)
      : null;

  // status_code aliases response_status in the projection; older envelopes
  // may use response_status directly.
  const statusCode =
    typeof r.status_code === 'number'
      ? r.status_code
      : typeof r.response_status === 'number'
        ? r.response_status
        : 0;

  // occurred_at aliases timestamp in the projection.
  const occurredAt =
    typeof r.occurred_at === 'string'
      ? r.occurred_at
      : typeof r.timestamp === 'string'
        ? r.timestamp
        : new Date().toISOString();

  return {
    id,
    request_id: typeof r.request_id === 'string' ? r.request_id : null,
    method,
    path,
    status_code: statusCode,
    error_code: typeof r.error_code === 'string' ? r.error_code : null,
    duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : 0,
    source_id: typeof r.source_id === 'string' ? r.source_id : null,
    source_label:
      typeof r.source_label === 'string'
        ? r.source_label
        : typeof r.source_id === 'string'
          ? r.source_id
          : null,
    source_org_id: typeof r.source_org_id === 'string' ? r.source_org_id : null,
    route_id: typeof r.route_id === 'string' ? r.route_id : null,
    route_pack_id: typeof r.route_pack_id === 'string' ? r.route_pack_id : null,
    occurred_at: occurredAt,
    request_headers: requestHeaders,
    request_body: requestBody,
    response_size_bytes:
      typeof r.response_size_bytes === 'number' ? r.response_size_bytes : 0,
    response_body_sample:
      typeof r.response_body_sample === 'string' ? r.response_body_sample : null,
  };
}

/**
 * Pure environment probe — returns true when `VITE_REALTIME_ENABLED=true`
 * (case-insensitive) and `getSupabaseClient()` returns a non-null client.
 * Kept here so it can be unit-tested without mounting the React surface.
 *
 * The lookup is deliberately lazy: callers re-read each render so that env
 * stubbing in tests (`vi.stubEnv`) and runtime client memoization both stay
 * authoritative — there is no per-module cached boolean.
 */
export function isRealtimeEnabled(
  client: { channel: (name: string) => unknown } | null,
): boolean {
  if (!client) return false;
  const raw = (import.meta.env as Record<string, string | undefined>)
    .VITE_REALTIME_ENABLED;
  if (typeof raw !== 'string') return false;
  return raw.toLowerCase() === 'true';
}

/**
 * Synthetic live-tail is an explicit local-development affordance, never a
 * production fallback. Requiring both a dev/test mode and an opt-in flag keeps
 * hosted lanes fail-closed if Realtime is missing or disabled.
 */
export function isSyntheticLiveTailAllowed(): boolean {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  const mode = typeof env.MODE === 'string' ? env.MODE.toLowerCase() : '';
  if (mode === 'production') return false;
  const explicit =
    typeof env.VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL === 'string' &&
    env.VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL.toLowerCase() === 'true';
  if (!explicit) return false;
  return mode === 'development' || mode === 'test' || env.DEV === true;
}

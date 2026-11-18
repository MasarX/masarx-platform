// insights-apigw.js — CLAIM-INSIGHTS-API-GW (Wave 3, Phase C).
//
// Operator API gateway observability surface seed. Mirrors the canonical API
// gateway tables from supabase/migrations:
//   • api_call_log              (per-request execution log)
//   • api_gateway_requests      (joined route/route_pack request projection)
//   • api_gateway_rate_limits   (current per-source × route windowed counters)
//   • api_routes                (registered routes per route_pack)
//   • api_route_packs           (versioned route bundles — public/internal/partner)
//   • provider_health_logs      (downstream provider latency cross-link)
//
// Capability gating (registry.js):
//   • api_gateway.read   — list/inspect this surface
//   • api_gateway.write  — block source / adjust rate limit
//
// SSOT contract:
//   - All rows are deterministic given the anchor `now`. No `Math.random`.
//   - Status codes/methods/paths/source classes are spread across the 24h
//     window so the live-tail demo and chip filters always have data.
//
// Lookups: `api_method` + `provider_health_status` are injected via the
// additive `Object.assign(seed.lookups, …)` pattern (same as fleet-vehicles.js
// / network-zones.js / catalog-offerings.js). DataTable lookup chips +
// KvGrid tones resolve consistently with the rest of the surface.

import { lookups } from './lookups.js';

Object.assign(lookups, {
  api_method: [
    { value: 'GET', label: 'GET', tone: 'info' },
    { value: 'POST', label: 'POST', tone: 'good' },
    { value: 'PUT', label: 'PUT', tone: 'warn' },
    { value: 'PATCH', label: 'PATCH', tone: 'warn' },
    { value: 'DELETE', label: 'DELETE', tone: 'danger' },
  ],
  provider_health_status: [
    { value: 'healthy', label: 'Healthy', tone: 'good' },
    { value: 'degraded', label: 'Degraded', tone: 'warn' },
    { value: 'critical', label: 'Critical', tone: 'danger' },
    { value: 'unknown', label: 'Unknown', tone: 'neutral' },
  ],
});

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();
const hoursAgo = (h) => new Date(now - h * 60 * 60 * 1000).toISOString();

// ---------- Route packs ----------
// W13-2: dropped fictional `version` per __audit__/SCHEMA-DRIFT/INSIGHTS.md §4.
// `public.api_route_packs` has no `version` column. The version intent is
// captured in the pack name (`public_v1`, `internal_v2`, `partner_v3`).
export const api_route_packs = [
  {
    id: 'rpk_public_v1',
    name: 'public_v1',
    description: 'Public sender/recipient REST surface (rate-limited, partner-friendly).',
  },
  {
    id: 'rpk_internal_v2',
    name: 'internal_v2',
    description: 'Operator-only console RPCs (high-trust, low-volume, capability gated).',
  },
  {
    id: 'rpk_partner_v3',
    name: 'partner_v3',
    description: 'Partner integration ingress (webhook + outbound delivery callbacks).',
  },
];

// ---------- Routes (15-20 spread across the 3 packs) ----------
export const api_routes = [
  // public_v1 — sender-facing
  { id: 'rt_pub_shipments_create', method: 'POST', path_pattern: '/v1/shipments', route_pack_id: 'rpk_public_v1', deprecated: false },
  { id: 'rt_pub_shipments_get', method: 'GET', path_pattern: '/v1/shipments/{id}', route_pack_id: 'rpk_public_v1', deprecated: false },
  { id: 'rt_pub_shipments_track', method: 'GET', path_pattern: '/v1/shipments/{id}/track', route_pack_id: 'rpk_public_v1', deprecated: false },
  { id: 'rt_pub_pickups_create', method: 'POST', path_pattern: '/v1/pickups', route_pack_id: 'rpk_public_v1', deprecated: false },
  { id: 'rt_pub_labels_print', method: 'POST', path_pattern: '/v1/labels/print', route_pack_id: 'rpk_public_v1', deprecated: false },
  { id: 'rt_pub_addresses_validate', method: 'POST', path_pattern: '/v1/addresses/validate', route_pack_id: 'rpk_public_v1', deprecated: false },
  { id: 'rt_pub_legacy_recipients_list', method: 'GET', path_pattern: '/v1/recipients', route_pack_id: 'rpk_public_v1', deprecated: true },
  // internal_v2 — operator-only
  { id: 'rt_int_dispatch_assign', method: 'POST', path_pattern: '/v2/dispatch/assign', route_pack_id: 'rpk_internal_v2', deprecated: false },
  { id: 'rt_int_route_publish', method: 'POST', path_pattern: '/v2/routes/{id}/publish', route_pack_id: 'rpk_internal_v2', deprecated: false },
  { id: 'rt_int_settings_resolve', method: 'GET', path_pattern: '/v2/settings/resolve', route_pack_id: 'rpk_internal_v2', deprecated: false },
  { id: 'rt_int_decisions_query', method: 'POST', path_pattern: '/v2/decisions/query', route_pack_id: 'rpk_internal_v2', deprecated: false },
  // partner_v3 — partner ingress + callbacks
  { id: 'rt_par_webhook_inbound', method: 'POST', path_pattern: '/v3/partners/{partner}/webhook', route_pack_id: 'rpk_partner_v3', deprecated: false },
  { id: 'rt_par_status_callback', method: 'POST', path_pattern: '/v3/partners/{partner}/status', route_pack_id: 'rpk_partner_v3', deprecated: false },
  { id: 'rt_par_pod_upload', method: 'POST', path_pattern: '/v3/partners/{partner}/pod', route_pack_id: 'rpk_partner_v3', deprecated: false },
  { id: 'rt_par_legacy_handover', method: 'PUT', path_pattern: '/v3/partners/handover', route_pack_id: 'rpk_partner_v3', deprecated: true },
  {
    id: 'rt_logestechs_ship_request_by_email',
    route_name: 'Logestechs shipment create by email',
    method: 'POST',
    path_pattern: '/api/ship/request/by-email',
    path_template: '/api/ship/request/by-email',
    route_pack_id: 'rpk_partner_v3',
    deprecated: false,
    enabled: true,
    provider_id: 'prv_exampledepot',
    policy: {
      provider_account: {
        category: 'logestechs_v2_account',
        required: true,
        require_company_id: true,
      },
      auth: { auth_type: 'basic_auth' },
      postprocess: {
        mode: 'shipment_create_v1',
        enabled: true,
        service_type: 'delivery',
        shipment_status: 'pending',
        extract: {
          box_count_path: 'pkg.quantity',
          cod_amount_path: 'pkg.toCollectFromReceiver|pkg.cod',
          service_type_path: 'pkg.shipmentType',
          service_level_path: 'pkg.serviceType',
          recipient_name_path: 'pkg.receiverName',
          recipient_phone_path: 'pkg.receiverPhone|pkg.receiverPhone2',
          client_reference_path: 'pkg.invoiceNumber|pkg.supplierInvoice',
          destination_city_path: 'destinationAddress.city|destinationAddress.arabicCityName',
          destination_line1_path: 'destinationAddress.addressLine1|destinationAddress.street',
          destination_line2_path: 'destinationAddress.addressLine2',
          destination_country_path: 'destinationAddress.country',
          destination_district_path: 'destinationAddress.district',
          destination_province_path: 'destinationAddress.region|destinationAddress.arabicRegionName',
          destination_postal_path: 'destinationAddress.zipCode',
          promised_delivery_date_path: 'expectedDeliveryDate|data.expectedDeliveryDate',
          provider_tracking_number_path: 'barcode|trackingNumber|tracking_number|data.trackingNumber|data.tracking_number|id|data.shipmentId|data.shipment_id',
        },
      },
    },
  },
];

// ---------- Sources (mix of orgs + external) ----------
const SOURCES = [
  { id: 'src_exampleparcel_ksa', label: 'Exampleparcel · KSA', org_id: 'org_exampleparcel_ksa', kind: 'org' },
  { id: 'src_examplemart_uae', label: 'Examplemart · UAE', org_id: 'org_examplemart_uae', kind: 'org' },
  { id: 'src_examplecommerce_internal', label: 'Examplecommerce · Internal', org_id: 'org_examplecommerce', kind: 'org' },
  { id: 'src_partner_exampledepot', label: 'Partner · Exampledepot', org_id: null, kind: 'partner' },
  { id: 'src_partner_examplecourier', label: 'Partner · Examplecourier', org_id: null, kind: 'partner' },
  { id: 'src_external_curl', label: 'External · curl/7.88', org_id: null, kind: 'external' },
  { id: 'src_console_ops', label: 'Console · Ops', org_id: 'org_rashed', kind: 'internal' },
];

// Deterministic pseudo-random helpers (LCG so seed.js stays pure).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------- api_call_log (60-80 rows, varied across 24h) ----------
//
// W14-2: dropped fictional FE-only fields (`source_kind`, `source_ip`,
// `headers`, `response_size_bytes`, `response_body_sample`,
// `source_label`, `source_org_id`, `route_id`, `route_pack_id`, `path`,
// `status_code`, `error_code`, `occurred_at`, `request_id`) per
// `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1`. The canonical
// `public.api_call_log` row shape is `(id, organization_id, provider_id,
// operation, method, url, request_headers, request_body, response_status,
// response_headers, response_body, duration_ms, error_message,
// circuit_breaker_state, timestamp)` — every other field is a
// projection-derived view column exposed by `v_api_gateway_observability`
// (joined projection over api_call_log + api_gateway_requests + api_routes
// + webhook_sources).
//
// FE consumers now route through the `api_gateway_observability` resource
// key (registry.js) which is backed by the projection seed below. The raw
// `api_call_log` seed retains the FE-friendly fields strictly for
// backwards compatibility with the joined projection (the projection adapts
// from the raw seed when the SQL view is unavailable in DEMO mode).
function buildCallLog() {
  const rng = lcg(0xa1b2c3d4);
  const out = [];
  // Spread evenly: every ~22-24 minutes over 24h => ~64 rows.
  for (let i = 0; i < 70; i++) {
    const minOffset = Math.round(i * 20.5 + (rng() - 0.5) * 8);
    const occurredAt = new Date(now - clamp(minOffset, 0, 24 * 60) * 60000).toISOString();
    const route = pick(rng, api_routes);
    const source = pick(rng, SOURCES);
    // Status code distribution: 78% 2xx, 6% 3xx, 12% 4xx, 4% 5xx (steady-state SLOs).
    const r = rng();
    let status;
    let errMsg = null;
    if (r < 0.78) status = pick(rng, [200, 200, 201, 204]);
    else if (r < 0.84) status = pick(rng, [301, 304]);
    else if (r < 0.96) {
      status = pick(rng, [400, 401, 403, 404, 409, 422, 429]);
      errMsg = status === 429 ? 'rate_limited' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 422 ? 'validation_failed' : 'bad_request';
    } else {
      status = pick(rng, [500, 502, 503, 504]);
      errMsg = status === 504 ? 'upstream_timeout' : status === 503 ? 'service_unavailable' : 'internal_error';
    }
    // Latency: bimodal — 70% fast (40-300ms), 20% medium (300-900ms), 10% slow (900-3500ms).
    const lr = rng();
    let durationMs;
    if (lr < 0.7) durationMs = Math.round(40 + rng() * 260);
    else if (lr < 0.9) durationMs = Math.round(300 + rng() * 600);
    else durationMs = Math.round(900 + rng() * 2600);
    if (status >= 500) durationMs = Math.max(durationMs, 800);
    const requestId = `req_${(0x10000 + i).toString(16)}`;
    // Build canonical url (path + ?query when applicable). The view derives
    // `path` by stripping the query string.
    const renderedPath = route.path_pattern
      .replace('{id}', `shp_${938_000 + i}`)
      .replace('{partner}', source.id.replace('src_partner_', ''));
    const queryString = i % 5 === 0 ? `source=${source.id}` : '';
    const url = queryString ? `${renderedPath}?${queryString}` : renderedPath;
    // request_headers — canonical column name. Authorization is intentionally
    // PRESENT so the redaction test can verify the drawer never renders the
    // raw value.
    const requestHeaders = {
      'user-agent': source.kind === 'external' ? 'curl/7.88.1' : source.kind === 'partner' ? 'ExampLepartner/2.1' : 'masarx-sdk/1.4.0',
      'content-type': route.method === 'GET' ? null : 'application/json',
      Authorization: source.kind === 'org' ? `Bearer sk_live_${requestId}` : `Bearer pk_partner_${source.id}`,
      'x-correlation-id': `cor_${(0x9a00 + i).toString(16)}`,
      'x-source-id': source.id,
    };
    const responseBody =
      status === 204
        ? null
        : status >= 400
          ? { error: errMsg, message: `${errMsg} for ${route.path_pattern}` }
          : { ok: true, request_id: requestId, processed_at: occurredAt };
    out.push({
      // Canonical public.api_call_log columns (SSOT shape).
      id: `cal_${(0x4000 + i).toString(16)}`,
      organization_id: source.org_id,
      provider_id: route.id,
      operation: route.id,
      method: route.method,
      url,
      request_headers: requestHeaders,
      request_body: route.method === 'GET' ? null : { request_id: requestId, source_id: source.id },
      response_status: status,
      response_headers: { 'content-type': 'application/json' },
      response_body: responseBody,
      duration_ms: durationMs,
      error_message: errMsg,
      circuit_breaker_state: status >= 500 ? 'half_open' : 'closed',
      timestamp: occurredAt,
      // -------- Projection helpers (derived in the view; retained here for
      // the in-memory data-source that does not run SQL in DEMO mode). --------
      request_id: requestId,
      path: renderedPath,
      status_code: status,
      error_code: errMsg,
      occurred_at: occurredAt,
      source_id: source.id,
      source_label: source.label,
      source_org_id: source.org_id,
      route_id: route.id,
      route_pack_id: route.route_pack_id,
      response_size_bytes: status === 204 || responseBody == null ? 0 : JSON.stringify(responseBody).length,
      response_body_sample: responseBody == null ? null : JSON.stringify(responseBody),
    });
  }
  // Most-recent first.
  out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return out;
}

export const api_call_log = buildCallLog();

// ---------- v_api_gateway_observability (W14-2 paired projection seed) ------
// Mirrors the SQL view shape (joined projection over api_call_log +
// api_gateway_requests + api_routes + webhook_sources). FE consumes via
// `useResourceList<ApiCallRow>('api_gateway_observability')`.
export const api_gateway_observability = api_call_log.map((row) => ({
  id: row.id,
  request_id: row.request_id,
  organization_id: row.organization_id,
  provider_id: row.provider_id,
  operation: row.operation,
  method: row.method,
  url: row.url,
  path: row.path,
  request_headers: row.request_headers,
  response_status: row.response_status,
  status_code: row.status_code,
  response_headers: row.response_headers,
  response_body: row.response_body,
  response_body_sample: row.response_body_sample,
  response_size_bytes: row.response_size_bytes,
  duration_ms: row.duration_ms,
  error_message: row.error_message,
  error_code: row.error_code,
  circuit_breaker_state: row.circuit_breaker_state,
  timestamp: row.timestamp,
  occurred_at: row.occurred_at,
  route_id: row.route_id,
  route_pack_id: row.route_pack_id,
  source_id: row.source_id,
  source_label: row.source_label,
  source_org_id: row.source_org_id,
}));

// ---------- api_gateway_requests (mirrors api_call_log, joined projection) ----------
export const api_gateway_requests = api_call_log.map((row) => ({
  id: `gwr_${row.id.slice(4)}`,
  request_id: row.request_id,
  method: row.method,
  path: row.path,
  source_id: row.source_id,
  source_label: row.source_label,
  route_id: row.route_id,
  route_name: api_routes.find((route) => route.id === row.route_id)?.route_name ?? null,
  route_pack_id: row.route_pack_id,
  route_pack_name: api_route_packs.find((pack) => pack.id === row.route_pack_id)?.name ?? null,
  status_code: row.status_code,
  error_code: row.error_code,
  intake_state: 'outbound_created',
  outbound_status: row.status_code >= 400 ? 'failed' : 'completed',
  occurred_at: row.occurred_at,
}));

// ---------- api_gateway_rate_limits (10-12 entries per source × route bucket) ----------
export const api_gateway_auth_rejections = [
  {
    id: 'iar_api_invalid_source_token',
    service: 'api_gateway',
    surface: 'api_gateway',
    credential_kind: 'source_token',
    failure_code: 'invalid_token',
    failure_message: 'API gateway source token was invalid or disabled.',
    http_status: 401,
    organization_id: 'org_exampleparcel_ksa',
    source_id: 'src_exampleparcel_ksa',
    source_label: 'Exampleparcel KSA',
    source_identifier: 'exampleparcel-ksa-prod',
    client_id: null,
    client_label: null,
    sender_id: null,
    sender_label: null,
    correlation_id: '6f7b6a49-2c2a-4f51-b4fd-90a3d7cabc42',
    request_id: 'req_api_invalid_source_token',
    method: 'POST',
    path: '/v1/shipments',
    query_string: null,
    token_fingerprint: 'sha256:68f9d2a2dd0b5d0f',
    request_headers: {
      authorization: 'REDACTED',
      'x-correlation-id': '6f7b6a49-2c2a-4f51-b4fd-90a3d7cabc42',
    },
    metadata: {
      edge_stage: 'workflow_intake_api_gateway_v1',
      response_action: 'error',
    },
    occurred_at: minutesAgo(18),
    source_resolved: true,
    rejection_class: 'unauthorized',
  },
];

function buildRateLimits() {
  const rng = lcg(0x55aa55aa);
  const out = [];
  // 11 source × route buckets across the most-used routes.
  const buckets = [
    { source: SOURCES[0], route: api_routes[0], limit: 240 },
    { source: SOURCES[0], route: api_routes[1], limit: 600 },
    { source: SOURCES[1], route: api_routes[0], limit: 180 },
    { source: SOURCES[1], route: api_routes[2], limit: 480 },
    { source: SOURCES[2], route: api_routes[3], limit: 60 },
    { source: SOURCES[3], route: api_routes[11], limit: 120 },
    { source: SOURCES[3], route: api_routes[12], limit: 240 },
    { source: SOURCES[4], route: api_routes[11], limit: 90 },
    { source: SOURCES[4], route: api_routes[13], limit: 30 },
    { source: SOURCES[5], route: api_routes[1], limit: 30 },
    { source: SOURCES[6], route: api_routes[8], limit: 600 },
  ];
  buckets.forEach((b, i) => {
    // Window: 60s windows; current_usage within [0, limit + 20%] so a few are
    // saturated (exceeded), making the "rate-limited" filter meaningful.
    const usage = Math.round(b.limit * (0.18 + rng() * 1.05));
    const windowStart = new Date(now - (i * 90 + Math.round(rng() * 40)) * 1000).toISOString();
    out.push({
      id: `rl_${(0x3000 + i).toString(16)}`,
      source_id: b.source.id,
      source_label: b.source.label,
      route_id: b.route.id,
      route_path: b.route.path_pattern,
      route_method: b.route.method,
      limit_per_min: b.limit,
      current_usage: usage,
      saturated: usage >= b.limit,
      window_start: windowStart,
    });
  });
  return out;
}

export const api_gateway_rate_limits = buildRateLimits();

// ---------- v_api_gateway_rate_limits_summary (W14-2 paired projection seed) ----
// Mirrors the SQL view shape (joined projection over api_gateway_rate_limits +
// webhook_sources). The fictional per-route fields (`route_id`, `route_path`,
// `route_method`) are dropped per `__audit__/SCHEMA-DRIFT/INSIGHTS.md §2`;
// canonical `public.api_gateway_rate_limits` is per-source × hour, not
// per-route. `limit_per_min` and `saturated` are computed from
// `webhook_sources.rate_limit_per_hour`. The DEMO seed approximates this by
// collapsing per-route buckets to one summary row per source_id (preserving
// the largest `limit_per_min` to keep the chip surface meaningful).
const _rateLimitsBySource = new Map();
for (const r of api_gateway_rate_limits) {
  const existing = _rateLimitsBySource.get(r.source_id);
  if (!existing || r.current_usage > existing.current_usage) {
    _rateLimitsBySource.set(r.source_id, r);
  }
}
export const api_gateway_rate_limits_summary = Array.from(_rateLimitsBySource.values()).map((r) => ({
  id: r.id,
  source_id: r.source_id,
  source_label: r.source_label,
  source_org_id: SOURCES.find((s) => s.id === r.source_id)?.org_id ?? null,
  limit_per_hour: r.limit_per_min * 60,
  limit_per_min: r.limit_per_min,
  request_count: r.current_usage,
  current_usage: r.current_usage,
  saturated: r.saturated,
  window_start: r.window_start,
  updated_at: r.window_start,
}));

// ---------- provider_health_logs (downstream latency cross-link, 20-25 rows) ----------
// W13-2: canonical `public.provider_health_logs` has no top-level `latency_ms`
// column; latency lives in `metadata` jsonb. Seed nests `latency_ms` under
// `metadata`; FE resolves through `latencyOf(row)` reading
// `row.metadata?.latency_ms`. Per __audit__/SCHEMA-DRIFT/INSIGHTS.md §3.
const _phl = (id, provider_id, occurred_at, status, latency_ms, error_message = null) => ({
  id,
  provider_id,
  occurred_at,
  status,
  error_message,
  metadata: { latency_ms },
});
export const provider_health_logs = [
  _phl('phl_1', 'prv_exampledepot', minutesAgo(0), 'healthy', 320),
  _phl('phl_2', 'prv_exampledepot', minutesAgo(8), 'healthy', 305),
  _phl('phl_3', 'prv_examplecourier', minutesAgo(2), 'healthy', 410),
  _phl('phl_4', 'prv_examplecourier', minutesAgo(14), 'healthy', 388),
  _phl('phl_5', 'prv_examplecourier_rto', minutesAgo(1), 'degraded', 1840, 'upstream slow (p95 over SLO)'),
  _phl('phl_6', 'prv_examplecourier_rto', minutesAgo(11), 'degraded', 2102, 'upstream slow (p95 over SLO)'),
  _phl('phl_7', 'prv_examplecourier_rto', minutesAgo(28), 'critical', 4022, 'circuit half-open'),
  _phl('phl_8', 'prv_examplefleet', minutesAgo(3), 'healthy', 520),
  _phl('phl_9', 'prv_examplefleet', minutesAgo(17), 'healthy', 488),
  _phl('phl_10', 'prv_stc_pay', minutesAgo(0), 'healthy', 280),
  _phl('phl_11', 'prv_stc_pay', minutesAgo(22), 'healthy', 271),
  _phl('phl_12', 'prv_google_geo', minutesAgo(1), 'healthy', 180),
  _phl('phl_13', 'prv_google_geo', minutesAgo(13), 'healthy', 174),
  _phl('phl_14', 'prv_here_geo', minutesAgo(2), 'healthy', 240),
  _phl('phl_15', 'prv_here_geo', minutesAgo(19), 'healthy', 232),
  _phl('phl_16', 'prv_twilio', minutesAgo(0), 'healthy', 110),
  _phl('phl_17', 'prv_twilio', minutesAgo(9), 'healthy', 104),
  _phl('phl_18', 'prv_exampledepot', hoursAgo(2), 'healthy', 290),
  _phl('phl_19', 'prv_examplecourier', hoursAgo(3), 'degraded', 1410, 'transient upstream stall'),
  _phl('phl_20', 'prv_examplecourier_rto', hoursAgo(4), 'critical', 5012, '504 from origin'),
  _phl('phl_21', 'prv_exampledepot', hoursAgo(6), 'healthy', 318),
  _phl('phl_22', 'prv_examplefleet', hoursAgo(8), 'healthy', 540),
  _phl('phl_23', 'prv_stc_pay', hoursAgo(10), 'healthy', 263),
  _phl('phl_24', 'prv_google_geo', hoursAgo(12), 'healthy', 198),
];

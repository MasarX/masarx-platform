// platform-alerts.js — CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) seed snapshot.
//
// Mirrors the canonical alerts/observability tables:
//
//   public.alert_rules
//     (id, organization_id, name, condition jsonb, severity, channel, enabled,
//      created_by, created_at)
//     NOTE: `last_triggered_at` is NOT a canonical column; the FE derives it
//     via `MAX(alert_triggers.fired_at) WHERE rule_id = id` (W14-7 close-out).
//
//   public.alert_triggers
//     (id, rule_id, fired_at, payload jsonb, status)
//
//   public.ops_alerts
//     (id, severity, opened_at, source, message, details jsonb)
//     NOTE: `resolved_at` is NOT a canonical column; the FE derives it from
//     `details.resolved_at` (jsonb projection) per W14-7 close-out.
//
// Capabilities: `alerts.read` / `alerts.write` (declared in registry.js).
// Demo grants: super_admin (wildcard), ops_admin (read + write),
// account_manager (read only). Mirrors the Datadog/PagerDuty/Sentry parity
// brief — operator-grade alerting management.
//
// Cross-references:
//   • `condition` jsonb is **legacy flat shape** (`{field: value}`) so it
//     round-trips through the shared `_bindings/condition-model.ts`
//     (fromLegacyFlat -> visual builder -> toLegacyFlatIfPossible). This is
//     the same contract the workflow_bindings condition column uses, so the
//     same shared editor primitive renders both surfaces.
//   • `ops_alerts` rows reference `alert_rules` via `source` (e.g.
//     'rule:alr_high_error_rate') so the drawer "Active alerts" tab can
//     deep-link active+resolved alerts back to the rule.
//   • `alert_triggers.payload` mirrors a representative event payload that
//     would have caused the rule's condition to evaluate true. This drives
//     the editor's Test rule action (samples picker + per-row PASS/FAIL).
//
// Backend SSOT note: the canonical migration for these tables is in flight at
// the time of this claim (referenced as `alerts_baseline_v1` in the planning
// queue). Demo seam matches the field set the migration is expected to ship.

import { lookups } from './lookups.js';

// alert_severity / alert_channel / alert_trigger_status / ops_alert_status
// lookup catalogs — additive Object.assign pattern so other Wave 3 agents
// can land additively without collision.
Object.assign(lookups, {
  alert_severity: [
    { value: 'info', label: 'Info', tone: 'info', rank: 10 },
    { value: 'warn', label: 'Warning', tone: 'warn', rank: 20 },
    { value: 'critical', label: 'Critical', tone: 'danger', rank: 30 },
  ],
  alert_channel: [
    { value: 'slack', label: 'Slack', tone: 'info', rank: 10 },
    { value: 'email', label: 'Email', tone: 'neutral', rank: 20 },
    { value: 'pagerduty', label: 'PagerDuty', tone: 'danger', rank: 30 },
    { value: 'webhook', label: 'Webhook', tone: 'neutral', rank: 40 },
  ],
  // W27-cycle-D §4 — tone alignment: alert_triggers lifecycle drives chip
  // colour on platform/alerts.tsx (Recent triggers + Active alerts panes).
  // Tones mirror the operator severity expectation that an unhandled `fired`
  // trigger MUST read as a danger state until the operator acknowledges or
  // resolves it.
  alert_trigger_status: [
    { value: 'fired', label: 'Fired', tone: 'danger', rank: 10 },
    { value: 'acknowledged', label: 'Acknowledged', tone: 'warn', rank: 20 },
    { value: 'resolved', label: 'Resolved', tone: 'good', rank: 30 },
    { value: 'silenced', label: 'Silenced', tone: 'neutral', rank: 40 },
  ],
  ops_alert_status: [
    { value: 'open', label: 'Open', tone: 'danger', rank: 10 },
    { value: 'acknowledged', label: 'Acknowledged', tone: 'warn', rank: 20 },
    { value: 'resolved', label: 'Resolved', tone: 'good', rank: 30 },
  ],
});

// ---------- alert_rules (10 rows) ----------
// `condition` is stored as the legacy flat shape `{ field: value }` so the
// shared visual builder (consumed by workflow_bindings + alerts) round-trips
// without breaking either surface. Builder converts to JSONLogic on emit.
// W14-7: `last_triggered_at` is no longer seeded here; the FE derives it
// dynamically from `alert_triggers` (MAX(fired_at) per rule_id) so the table
// still renders fresh "x minutes ago" relative timestamps without a fictional
// column on the canonical SSOT.
const NOW = new Date('2026-04-26T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400_000).toISOString();

export const alert_rules = [
  {
    id: 'alr_high_error_rate',
    organization_id: 'org_rashed',
    name: 'High error rate · API ingress',
    // condition values are stored as flat `{field: value}` so the shared
    // editor primitive (fromLegacyFlat) can prefix `payload.` automatically
    // and emit JSONLogic `{">=": [{"var": "payload.error_rate"}, 0.05]}` on
    // resave. Demo seed keeps initial conditions as equality-style guards
    // (lowest common denominator that round-trips through the visual builder
    // without losing fidelity); operators upgrade to >=/<=/regex/etc. via the
    // editor on first edit.
    condition: { error_rate: '0.05' },
    severity: 'critical',
    channel: 'pagerduty',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-02-12T09:24:00Z',
  },
  {
    id: 'alr_p95_latency_breach',
    organization_id: 'org_rashed',
    name: 'p95 latency breach · webhook ingest',
    condition: { p95_ms: '1200' },
    severity: 'warn',
    channel: 'slack',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-02-18T11:02:00Z',
  },
  {
    id: 'alr_settlement_delay',
    organization_id: 'org_rashed',
    name: 'Settlement run delayed > 30m',
    condition: { delay_minutes: '30' },
    severity: 'warn',
    channel: 'email',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-01-30T14:48:00Z',
  },
  {
    id: 'alr_route_solver_timeout',
    organization_id: 'org_rashed',
    name: 'Route solver timeout',
    condition: { duration_ms: '30000' },
    severity: 'critical',
    channel: 'pagerduty',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-02-22T10:18:00Z',
  },
  {
    id: 'alr_cod_collection_drop',
    organization_id: 'org_rashed',
    name: 'COD collection rate dropped',
    condition: { collection_pct: '85' },
    severity: 'warn',
    channel: 'slack',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-03-01T08:55:00Z',
  },
  {
    id: 'alr_disputes_spike',
    organization_id: 'org_rashed',
    name: 'Disputes opened in last hour',
    condition: { opened_count: '5' },
    severity: 'info',
    channel: 'email',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-03-12T13:42:00Z',
  },
  {
    id: 'alr_provider_circuit_open',
    organization_id: 'org_rashed',
    name: 'Provider circuit breaker opened',
    condition: { breaker_state: 'open' },
    severity: 'critical',
    channel: 'pagerduty',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-02-08T07:33:00Z',
  },
  {
    id: 'alr_unassigned_backlog',
    organization_id: 'org_rashed',
    name: 'Unassigned shipment backlog > 50',
    condition: { backlog_count: '50' },
    severity: 'warn',
    channel: 'slack',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-03-04T15:11:00Z',
  },
  {
    id: 'alr_geocoder_drift',
    organization_id: 'org_rashed',
    name: 'Geocoder confidence drift',
    condition: { confidence: '0.7' },
    severity: 'info',
    channel: 'webhook',
    enabled: false,
    created_by: 'usr_admin_rashed',
    created_at: '2026-03-09T16:25:00Z',
  },
  {
    id: 'alr_warehouse_transfer_stuck',
    organization_id: 'org_rashed',
    name: 'Warehouse transfer stuck > 4h',
    condition: { duration_hours: '4' },
    severity: 'warn',
    channel: 'webhook',
    enabled: true,
    created_by: 'usr_admin_rashed',
    created_at: '2026-02-25T09:09:00Z',
  },
];

// ---------- alert_triggers (18 rows distributed) ----------
// Each row records a representative payload — the editor's Test rule action
// uses recent payloads as samples so PASS/FAIL chips reflect real evaluation
// shape. Status flips through the lifecycle (fired -> acknowledged -> resolved
// -> silenced) so the drawer history tab renders all states.
export const alert_triggers = [
  // alr_high_error_rate (3 fires)
  {
    id: 'altrg_001',
    rule_id: 'alr_high_error_rate',
    fired_at: minutesAgo(8),
    payload: { error_rate: 0.087, surface: 'api-ingress', region: 'eu-west-1', sample_size: 4220 },
    status: 'fired',
  },
  {
    id: 'altrg_002',
    rule_id: 'alr_high_error_rate',
    fired_at: hoursAgo(3),
    payload: { error_rate: 0.062, surface: 'api-ingress', region: 'eu-west-1', sample_size: 3140 },
    status: 'acknowledged',
  },
  {
    id: 'altrg_003',
    rule_id: 'alr_high_error_rate',
    fired_at: hoursAgo(9),
    payload: { error_rate: 0.054, surface: 'api-ingress', region: 'us-east-1', sample_size: 2880 },
    status: 'resolved',
  },
  // alr_p95_latency_breach (3 fires)
  {
    id: 'altrg_004',
    rule_id: 'alr_p95_latency_breach',
    fired_at: minutesAgo(34),
    payload: { p95_ms: 1480, surface: 'webhook-ingest', endpoint: '/v1/intake', sample_size: 612 },
    status: 'fired',
  },
  {
    id: 'altrg_005',
    rule_id: 'alr_p95_latency_breach',
    fired_at: hoursAgo(4),
    payload: { p95_ms: 1310, surface: 'webhook-ingest', endpoint: '/v1/intake', sample_size: 504 },
    status: 'resolved',
  },
  {
    id: 'altrg_006',
    rule_id: 'alr_p95_latency_breach',
    fired_at: hoursAgo(14),
    payload: { p95_ms: 1255, surface: 'webhook-ingest', endpoint: '/v1/intake', sample_size: 488 },
    status: 'resolved',
  },
  // alr_settlement_delay (2 fires)
  {
    id: 'altrg_007',
    rule_id: 'alr_settlement_delay',
    fired_at: hoursAgo(2),
    payload: { delay_minutes: 42, batch_id: 'bch_2026_apr_w17', tenant_id: 'org_rashed' },
    status: 'acknowledged',
  },
  {
    id: 'altrg_008',
    rule_id: 'alr_settlement_delay',
    fired_at: daysAgo(1),
    payload: { delay_minutes: 36, batch_id: 'bch_2026_apr_w16', tenant_id: 'org_rashed' },
    status: 'resolved',
  },
  // alr_route_solver_timeout (2 fires)
  {
    id: 'altrg_009',
    rule_id: 'alr_route_solver_timeout',
    fired_at: hoursAgo(5),
    payload: { duration_ms: 41250, plan_id: 'plan_ruh_2026_04_26_w', stops: 184 },
    status: 'fired',
  },
  {
    id: 'altrg_010',
    rule_id: 'alr_route_solver_timeout',
    fired_at: daysAgo(1),
    payload: { duration_ms: 34800, plan_id: 'plan_jed_2026_04_25_e', stops: 156 },
    status: 'resolved',
  },
  // alr_cod_collection_drop (2 fires)
  {
    id: 'altrg_011',
    rule_id: 'alr_cod_collection_drop',
    fired_at: hoursAgo(11),
    payload: { collection_pct: 79, region: 'ksa-central', driver_count: 38 },
    status: 'acknowledged',
  },
  {
    id: 'altrg_012',
    rule_id: 'alr_cod_collection_drop',
    fired_at: daysAgo(2),
    payload: { collection_pct: 81, region: 'ksa-west', driver_count: 22 },
    status: 'resolved',
  },
  // alr_disputes_spike (1 fire)
  {
    id: 'altrg_013',
    rule_id: 'alr_disputes_spike',
    fired_at: hoursAgo(20),
    payload: { opened_count: 7, top_reason: 'damaged_in_transit' },
    status: 'silenced',
  },
  // alr_provider_circuit_open (1 fire)
  {
    id: 'altrg_014',
    rule_id: 'alr_provider_circuit_open',
    fired_at: daysAgo(1),
    payload: { breaker_state: 'open', provider: 'twilio', failure_streak: 12 },
    status: 'resolved',
  },
  // alr_unassigned_backlog (1 fire)
  {
    id: 'altrg_015',
    rule_id: 'alr_unassigned_backlog',
    fired_at: daysAgo(2),
    payload: { backlog_count: 67, hub: 'hub_ruh_n', service_type: 'standard' },
    status: 'resolved',
  },
  // alr_geocoder_drift (1 fire — disabled rule, last fire before disable)
  {
    id: 'altrg_016',
    rule_id: 'alr_geocoder_drift',
    fired_at: daysAgo(7),
    payload: { confidence: 0.62, provider: 'mapbox', region: 'ksa-east' },
    status: 'silenced',
  },
  // alr_warehouse_transfer_stuck (2 fires)
  {
    id: 'altrg_017',
    rule_id: 'alr_warehouse_transfer_stuck',
    fired_at: daysAgo(3),
    payload: { duration_hours: 6, transfer_id: 'wht_2026_apr_22_n', items: 84 },
    status: 'resolved',
  },
  {
    id: 'altrg_018',
    rule_id: 'alr_warehouse_transfer_stuck',
    fired_at: daysAgo(5),
    payload: { duration_hours: 5, transfer_id: 'wht_2026_apr_20_e', items: 55 },
    status: 'resolved',
  },
];

// ---------- ops_alerts (9 rows mix of open + resolved) ----------
// `source` deep-links back to the rule via the `rule:<rule_id>` convention
// the drawer's "Active alerts" tab parses. opened_at + details.resolved_at
// drive the duration display in the drawer (W14-7: `resolved_at` is no longer
// a top-level alias — canonical `details` jsonb projection is the single
// source of truth for the FE-derived "resolved" lifecycle field).
export const ops_alerts = [
  {
    id: 'ops_alr_2026_apr_26_001',
    severity: 'critical',
    opened_at: minutesAgo(8),
    details: { resolved_at: null },
    source: 'rule:alr_high_error_rate',
    message: 'API ingress error rate exceeded 5% (current 8.7%)',
  },
  {
    id: 'ops_alr_2026_apr_26_002',
    severity: 'warn',
    opened_at: minutesAgo(34),
    details: { resolved_at: null },
    source: 'rule:alr_p95_latency_breach',
    message: 'Webhook ingest p95 latency 1480ms (threshold 1200ms)',
  },
  {
    id: 'ops_alr_2026_apr_26_003',
    severity: 'warn',
    opened_at: hoursAgo(2),
    details: { resolved_at: null },
    source: 'rule:alr_settlement_delay',
    message: 'Settlement batch bch_2026_apr_w17 delayed 42 minutes',
  },
  {
    id: 'ops_alr_2026_apr_26_004',
    severity: 'critical',
    opened_at: hoursAgo(5),
    details: { resolved_at: null },
    source: 'rule:alr_route_solver_timeout',
    message: 'Route solver exceeded 30s on plan_ruh_2026_04_26_w (184 stops)',
  },
  {
    id: 'ops_alr_2026_apr_26_005',
    severity: 'warn',
    opened_at: hoursAgo(11),
    details: { resolved_at: null },
    source: 'rule:alr_cod_collection_drop',
    message: 'KSA-central COD collection rate dropped to 79%',
  },
  {
    id: 'ops_alr_2026_apr_25_006',
    severity: 'critical',
    opened_at: daysAgo(1),
    details: { resolved_at: hoursAgo(18) },
    source: 'rule:alr_provider_circuit_open',
    message: 'Twilio circuit breaker opened after 12 consecutive failures',
  },
  {
    id: 'ops_alr_2026_apr_25_007',
    severity: 'warn',
    opened_at: daysAgo(1),
    details: { resolved_at: hoursAgo(20) },
    source: 'rule:alr_settlement_delay',
    message: 'Settlement batch bch_2026_apr_w16 delayed 36 minutes',
  },
  {
    id: 'ops_alr_2026_apr_24_008',
    severity: 'warn',
    opened_at: daysAgo(2),
    details: { resolved_at: daysAgo(1) },
    source: 'rule:alr_unassigned_backlog',
    message: 'hub_ruh_n unassigned backlog reached 67',
  },
  {
    id: 'ops_alr_2026_apr_23_009',
    severity: 'warn',
    opened_at: daysAgo(3),
    details: { resolved_at: daysAgo(2) },
    source: 'rule:alr_warehouse_transfer_stuck',
    message: 'Warehouse transfer wht_2026_apr_22_n stuck for 6h',
  },
];

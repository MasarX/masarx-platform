// integrations.js — providers, provider_auth_configs, plugins, versions, circuit_breaker_state, provider_health_metrics
// Anchored: AGENTS.md webhook-receiver / api-gateway / api-caller edge contracts.

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §12):
// Aligned to canonical `public.providers` columns
// (supabase/migrations/202510110004_webhook_integration.sql:12-23):
//   • kind -> provider_type (canonical column).
//   • vendor retained as derived projection field (resolves from
//     `metadata.vendor` in production).
export const providers = [
  { id: 'prv_exampledepot', organization_id: 'org_rashed', name: 'Exampledepot Carrier API', vendor: 'Exampledepot', provider_type: 'shipper_api', integration: 'logistics' },
  { id: 'prv_examplecourier', organization_id: 'org_rashed', name: 'Examplecourier API', vendor: 'Examplecourier', provider_type: 'shipper_api', integration: 'logistics' },
  { id: 'prv_examplecourier_rto', organization_id: 'org_rashed', name: 'Examplecourier Returns', vendor: 'Examplecourier', provider_type: 'shipper_api', integration: 'returns' },
  { id: 'prv_examplefleet', organization_id: 'org_rashed', name: 'EXAMPLEFLEET API', vendor: 'EXAMPLEFLEET Express', provider_type: 'shipper_api', integration: 'logistics' },
  { id: 'prv_stc_pay', organization_id: 'org_rashed', name: 'STC Pay', vendor: 'stc', provider_type: 'payment_gateway', integration: 'payments' },
  { id: 'prv_google_geo', organization_id: 'org_rashed', name: 'Google Geocoding', vendor: 'Google', provider_type: 'geocoding', integration: 'geocoding' },
  { id: 'prv_here_geo', organization_id: 'org_rashed', name: 'HERE Geocoding', vendor: 'HERE', provider_type: 'geocoding', integration: 'geocoding' },
  { id: 'prv_twilio', organization_id: 'org_rashed', name: 'Twilio SMS/WhatsApp', vendor: 'Twilio', provider_type: 'comms', integration: 'comms' },
];

export const provider_auth_configs = [
  { id: 'pac_exampledepot', provider_id: 'prv_exampledepot', auth_type: 'api_key', status: 'active', last_rotated_at: '2026-03-01T00:00:00Z', expires_at: '2026-09-01T00:00:00Z' },
  { id: 'pac_examplecourier', provider_id: 'prv_examplecourier', auth_type: 'oauth', status: 'active', last_rotated_at: '2026-04-01T00:00:00Z', expires_at: '2026-10-01T00:00:00Z' },
  { id: 'pac_examplecourier_rto', provider_id: 'prv_examplecourier_rto', auth_type: 'oauth', status: 'expiring', last_rotated_at: '2025-11-01T00:00:00Z', expires_at: '2026-05-01T00:00:00Z' },
  { id: 'pac_stc_pay', provider_id: 'prv_stc_pay', auth_type: 'mtls', status: 'active', last_rotated_at: '2026-02-15T00:00:00Z', expires_at: '2027-02-15T00:00:00Z' },
  { id: 'pac_twilio', provider_id: 'prv_twilio', auth_type: 'api_key', status: 'active', last_rotated_at: '2026-03-15T00:00:00Z', expires_at: '2026-09-15T00:00:00Z' },
];

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §7):
// Aligned to canonical `public.integration_plugins` columns
// (supabase/migrations/202602220010_integration_plugin_control_plane_v1.sql:445-468):
//   • kind -> plugin_kind (canonical column).
//   • vendor / version / health / last_event_at / events_24h / binding
//     retained as derived projection fields for catalog card UI parity
//     (production resolves these via paired joins / aggregations).
export const integration_plugins = [
  { id: 'plg_exampleparcel_ksa', organization_id: 'org_rashed', name: 'Exampleparcel KSA Webhook', vendor: 'Exampleparcel · KSA', version: 'v3.4.1', status: 'active', health: 0.99, last_event_at: '12s ago', events_24h: 18432, plugin_kind: 'inbound · webhook', binding: 'Order intake', active_version_id: 'plgv_examplemarket_341' },
  { id: 'plg_examplemart_express', organization_id: 'org_rashed', name: 'Examplemart Express', vendor: 'Examplemart · UAE', version: 'v2.8.0', status: 'active', health: 0.97, last_event_at: '38s ago', events_24h: 9214, plugin_kind: 'inbound · webhook', binding: 'Order intake', active_version_id: 'plgv_examplemart_280' },
  { id: 'plg_exampledepot_api', organization_id: 'org_rashed', name: 'Exampledepot Carrier API', vendor: 'Exampledepot · KSA', version: 'v4.0.2', status: 'active', health: 1.00, last_event_at: '4s ago', events_24h: 22041, plugin_kind: 'outbound · API', binding: 'Partner handover', active_version_id: 'plgv_exampledepot_402' },
  { id: 'plg_examplecourier_rto', organization_id: 'org_rashed', name: 'Examplecourier Returns', vendor: 'Examplecourier', version: 'v1.6.0', status: 'degraded', health: 0.84, last_event_at: '2m ago', events_24h: 1108, plugin_kind: 'outbound · API', binding: 'Return flow', active_version_id: 'plgv_examplecourier_rto_160' },
  { id: 'plg_stc_pay', organization_id: 'org_rashed', name: 'STC Pay COD', vendor: 'stc · KSA', version: 'v2.1.0', status: 'active', health: 0.99, last_event_at: '21s ago', events_24h: 4421, plugin_kind: 'outbound · API', binding: 'Cash collection', active_version_id: 'plgv_stc_210' },
  { id: 'plg_examplecommerce', organization_id: 'org_rashed', name: 'Examplecommerce Storefront', vendor: 'Examplecommerce', version: 'v3.0.0', status: 'pending', health: null, last_event_at: '—', events_24h: 0, plugin_kind: 'inbound · webhook', binding: '—', active_version_id: null },
  { id: 'plg_zid_legacy', organization_id: 'org_rashed', name: 'Zid (legacy)', vendor: 'Zid', version: 'v1.2.0', status: 'rollback', health: 0.42, last_event_at: '1h ago', events_24h: 84, plugin_kind: 'inbound · webhook', binding: 'Order intake', active_version_id: 'plgv_zid_120' },
];

// W19-4 — renamed FE alias `created_by` → canonical `submitted_by` per
// __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §8. Canonical SSOT is
// `public.integration_plugin_versions.submitted_by` per
// supabase/migrations/202602220010_integration_plugin_control_plane_v1.sql:491
// (the user UUID who submitted this version for approval). The FE display
// `version` string is retained as a derived label until the projection RPC
// exposes a `version_label` derived from canonical `version_no INTEGER`.
export const integration_plugin_versions = [
  { id: 'plgv_examplemarket_341', plugin_id: 'plg_exampleparcel_ksa', version: 'v3.4.1', status: 'active', created_at: '2026-04-22T10:00:00Z', submitted_by: 'usr_admin_rashed' },
  { id: 'plgv_examplemarket_340', plugin_id: 'plg_exampleparcel_ksa', version: 'v3.4.0', status: 'archived', created_at: '2026-03-15T10:00:00Z', submitted_by: 'usr_admin_rashed' },
  { id: 'plgv_examplecourier_rto_160', plugin_id: 'plg_examplecourier_rto', version: 'v1.6.0', status: 'active', created_at: '2026-02-12T11:00:00Z' },
];

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §9):
// Aligned to canonical `public.provider_health_latest_v` view columns
// (supabase/migrations/202512132220_observability_dashboard_views.sql:53-74):
//   • last_check -> created_at (canonical column).
//   • success_rate_24h / avg_latency_ms / error_rate_24h are derived
//     projection fields (computed from provider_health_logs aggregation).
//     They live in the seed slice for demo parity with dashboard / health
//     surfaces; the underlying view does not surface them.
// Live validation/approval audit rows are read through the registry-backed
// resources below. Seed mode intentionally keeps them empty so the catalog
// drawer never displays fabricated lifecycle evidence.
export const integration_plugin_validation_runs = [];
export const integration_plugin_approval_events = [];
export const integration_plugin_bindings = [];

const _BASE_TS = Date.parse('2026-04-25T13:35:00Z');
const _secondsAgo = (s) => new Date(_BASE_TS - s * 1000).toISOString();
export const provider_health_metrics = [
  { provider_id: 'prv_exampledepot', success_rate_24h: 0.998, avg_latency_ms: 320, error_rate_24h: 0.002, created_at: _secondsAgo(4), status: 'healthy' },
  { provider_id: 'prv_examplecourier', success_rate_24h: 0.991, avg_latency_ms: 410, error_rate_24h: 0.009, created_at: _secondsAgo(12), status: 'healthy' },
  { provider_id: 'prv_examplecourier_rto', success_rate_24h: 0.84, avg_latency_ms: 1840, error_rate_24h: 0.16, created_at: _secondsAgo(120), status: 'degraded' },
  { provider_id: 'prv_examplefleet', success_rate_24h: 0.96, avg_latency_ms: 520, error_rate_24h: 0.04, created_at: _secondsAgo(32), status: 'healthy' },
  { provider_id: 'prv_stc_pay', success_rate_24h: 0.99, avg_latency_ms: 280, error_rate_24h: 0.01, created_at: _secondsAgo(21), status: 'healthy' },
  { provider_id: 'prv_google_geo', success_rate_24h: 0.999, avg_latency_ms: 180, error_rate_24h: 0.001, created_at: _secondsAgo(60), status: 'healthy' },
  { provider_id: 'prv_here_geo', success_rate_24h: 0.97, avg_latency_ms: 240, error_rate_24h: 0.03, created_at: _secondsAgo(180), status: 'healthy' },
  { provider_id: 'prv_twilio', success_rate_24h: 0.998, avg_latency_ms: 110, error_rate_24h: 0.002, created_at: _secondsAgo(8), status: 'healthy' },
];

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §10):
// Aligned to canonical `public.circuit_breaker_dashboard_v` view columns
// (supabase/migrations/202512132220_observability_dashboard_views.sql:83-111):
//   • operation -> operation_name (canonical column).
//   • last_state_change -> updated_at (canonical column).
//   • next_probe_at -> half_open_test_at (canonical column).
//   • failure_rate retained as derived projection (failure_count / total).
export const circuit_breaker_state = [
  { provider_id: 'prv_examplecourier_rto', operation_name: 'shipment_status_query', state: 'half_open', failure_rate: 0.16, updated_at: '2026-04-25T11:00:00Z', half_open_test_at: '2026-04-25T13:35:00Z', reopen_count: 2, manual_intervention_required: false },
];

export const rate_limits = [
  { provider_id: 'prv_exampledepot', operation: 'create_shipment', window: '60s', limit: 100, used: 78 },
  { provider_id: 'prv_examplecourier', operation: 'create_shipment', window: '60s', limit: 50, used: 22 },
  { provider_id: 'prv_twilio', operation: 'send_sms', window: '60s', limit: 200, used: 134 },
];

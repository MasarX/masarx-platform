// mobile.js — user_devices, location_pings, scan_events, ops_sessions
// Anchored: AGENTS.md mobile_attestation_policy + CLAUDE.md Mobile Field Ops Policy Contract.
//
// W14-7 — `model` / `attestation_status` / `trusted_at` are no longer
// top-level FE aliases on user_devices. Per __audit__/SCHEMA-DRIFT/PLATFORM.md
// §5, canonical `public.user_devices` has no such columns; the FE resolves:
//   • `model`      → `metadata.model`               (jsonb projection)
//   • `attestation_status` → `metadata.attestation.status`
//   • `trusted_at` → `metadata.attestation.trusted_at`
// The seed mirrors the join under canonical metadata jsonb until a
// dedicated `v_user_device_summary` projection view ships.

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();

export const user_devices = [
  { id: 'dev_4441', organization_id: 'org_rashed', user_id: 'usr_dr_khalid', device_id: 'AND-3F21-9911', platform: 'android', os_version: '14', last_seen_at: minutesAgo(2), metadata: { model: 'Samsung A54', attestation: { status: 'verified', trusted_at: '2026-03-01T08:00:00Z' } } },
  { id: 'dev_4442', organization_id: 'org_rashed', user_id: 'usr_dr_mohammed', device_id: 'AND-7B12-8821', platform: 'android', os_version: '14', last_seen_at: minutesAgo(8), metadata: { model: 'Pixel 7', attestation: { status: 'verified', trusted_at: '2026-02-18T08:00:00Z' } } },
  { id: 'dev_4443', organization_id: 'org_rashed', user_id: 'usr_dr_faisal', device_id: 'IOS-1A45-2233', platform: 'ios', os_version: '17.4', last_seen_at: minutesAgo(1), metadata: { model: 'iPhone 15', attestation: { status: 'verified', trusted_at: '2026-04-02T08:00:00Z' } } },
  { id: 'dev_4444', organization_id: 'org_rashed', user_id: 'usr_dr_tariq', device_id: 'AND-9F22-1144', platform: 'android', os_version: '14', last_seen_at: minutesAgo(40), metadata: { model: 'Samsung A35', attestation: { status: 'pending', trusted_at: null } } },
  { id: 'dev_4445', organization_id: 'org_rashed', user_id: 'usr_dr_yousef', device_id: 'AND-2C81-7711', platform: 'android', os_version: '14', last_seen_at: minutesAgo(4), metadata: { model: 'Samsung A54', attestation: { status: 'verified', trusted_at: '2026-01-12T08:00:00Z' } } },
];

export const location_pings = [
  { id: 'lp_99001', user_id: 'usr_dr_khalid', device_id: 'AND-3F21-9911', latitude: 24.7136, longitude: 46.6753, accuracy_m: 4, occurred_at: minutesAgo(0) },
  { id: 'lp_99000', user_id: 'usr_dr_khalid', device_id: 'AND-3F21-9911', latitude: 24.7140, longitude: 46.6750, accuracy_m: 5, occurred_at: minutesAgo(2) },
];

export const scan_events = [
  { id: 'sce_88121', shipment_id: 'shp_9381247', box_barcode: 'SHP-9381247:1', user_id: 'usr_dr_khalid', scan_type: 'load_scan_out', occurred_at: minutesAgo(45) },
  { id: 'sce_88120', shipment_id: 'shp_9381247', box_barcode: 'SHP-9381247:1', user_id: 'usr_dr_khalid', scan_type: 'destination_scan_in', occurred_at: minutesAgo(1) },
  { id: 'sce_88119', shipment_id: 'shp_9381201', box_barcode: 'SHP-9381201:1', user_id: 'usr_dr_yousef', scan_type: 'return_to_branch_intake', occurred_at: minutesAgo(180), notes: 'Customer refused (4th attempt)' },
];

export const ops_sessions = [
  { id: 'ops_77', user_id: 'usr_dr_khalid', shift_started_at: '2026-04-25T07:00:00Z', shift_planned_end_at: '2026-04-25T19:00:00Z', cod_float_start: 0, status: 'active' },
  { id: 'ops_76', user_id: 'usr_dr_mohammed', shift_started_at: '2026-04-25T07:00:00Z', shift_ended_at: '2026-04-25T11:30:00Z', cod_float_start: 0, status: 'closed' },
];

// Mobile policy snapshots (resolved with sample scope context)
export const mobile_policy_resolved = {
  mobile_visibility_policy: { value: { surfaces: ['dashboard', 'routes', 'scan', 'outbox', 'more'] }, resolved_from: 'global', srlv: 'srlv_mobile_001' },
  mobile_diagnostics_policy: { value: { enable_diagnostics: true, upload_interval_seconds: 300 }, resolved_from: 'global', srlv: 'srlv_mobile_002' },
  device_policy: { value: { requiresAttestation: true, allowed: ['android', 'ios'] }, resolved_from: 'global', srlv: 'srlv_mobile_003' },
  navigation_policy: { value: { allowed_routes: ['home', 'route', 'scan', 'outbox', 'more'] }, resolved_from: 'global', srlv: 'srlv_mobile_004' },
  map_policy: { value: { clustering: { enabled: true, grid: 24, min_count: 3, show_legend: true } }, resolved_from: 'tenant', srlv: 'srlv_mobile_005', overrides: 'global' },
  communication_policy: { value: { templates: ['delivery_eta', 'support_contact'], support_contacts: { tier: 'tenant' } }, resolved_from: 'global', srlv: 'srlv_mobile_006' },
  address_policy: { value: { required_fields: ['street', 'city'] }, resolved_from: 'global', srlv: 'srlv_mobile_007' },
  driver_safety_policy: {
    value: {
      lock_threshold_kph: 12,
      allowed_nav_keys_while_moving: ['emergency'],
      hos_limits: {
        daily: { driving: 660, on_duty: 840 },
        weekly: { driving: 4200, on_duty: 4800 },
      },
      hos_warn_pct: 80,
    },
    resolved_from: 'global',
    srlv: 'srlv_mobile_008',
  },
  ux_safety_policy: { value: { confirmBeforeDelete: true, sessionTimeoutMin: 60 }, resolved_from: 'global', srlv: 'srlv_mobile_009' },
  mobile_attestation_policy: { value: { mode: 'enforce', method: 'play_integrity_app_attest', challenge_ttl_seconds: 90 }, resolved_from: 'global', srlv: 'srlv_mobile_010' },
};

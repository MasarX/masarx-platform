// platform-flags.js — CLAIM-PLATFORM-FLAGS (Wave 3, Phase C).
//
// Operator-grade feature-flag projection for the demo. Mirrors the canonical
// `public.feature_flags` shape (id, key, label, description, status ∈
// {on, off, percentage}, rollout_percentage, targeting jsonb, scope_type,
// scope_id, kill_switch, last_updated_at, last_updated_by_user_id).
//
// LaunchDarkly / Unleash / GrowthBook parity: each flag may carry per-scope
// overrides via `targeting.scopes` so the LadderViz can render the resolved
// path without fabricating data at render time.
//
// Lookups are injected via the additive `Object.assign(lookups, ...)` pattern
// (same as fleet-vehicles.js / network-zones.js) so DataTable lookup chips
// and KvGrid lookup tones resolve consistently with the rest of the surface.

import { lookups } from './lookups.js';

// Lookup tones — drives the status pill colors in DataTable + KvGrid.
// W71-Platform (Cycle F-R-11) closure: each row carries
//   • `metadata.is_enabled`  — true on `on`
//   • `metadata.is_disabled` — true on `off`
//   • `metadata.is_rollout`  — true on `percentage`
// Replaces inline `flag.status === 'on'|'off'|'percentage'` literal compares
// in modules/platform/feature-flags.tsx (`statusPill` percentage branch
// and the KPI counters). AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) +
// §6 (row-driven by configuration).
const FEATURE_FLAG_STATUS_LOOKUPS = [
  { value: 'on', label: 'On', tone: 'good', rank: 10, metadata: { is_enabled: true,  is_disabled: false, is_rollout: false } },
  { value: 'off', label: 'Off', tone: 'neutral', rank: 20, metadata: { is_enabled: false, is_disabled: true,  is_rollout: false } },
  { value: 'percentage', label: 'Rollout', tone: 'info', rank: 30, metadata: { is_enabled: false, is_disabled: false, is_rollout: true  } },
];

const FEATURE_FLAG_SCOPE_LOOKUPS = [
  { value: 'global', label: 'Global', tone: 'neutral', rank: 1 },
  { value: 'tenant', label: 'Tenant', tone: 'info', rank: 2 },
  { value: 'client', label: 'Client', tone: 'warn', rank: 3 },
  { value: 'sender', label: 'Sender', tone: 'good', rank: 4 },
];

// Additive lookup injection (mirrors network-zones.js / fleet-vehicles.js).
Object.assign(lookups, {
  feature_flag_status: FEATURE_FLAG_STATUS_LOOKUPS,
  feature_flag_scope: FEATURE_FLAG_SCOPE_LOOKUPS,
});

// Canonical seed — 14 rows spanning all status variants (on/off/percentage),
// scope_types (global/tenant/client/sender), and kill-switch states. Each row
// includes a `targeting.scopes` array so the LadderViz can render per-scope
// overrides without fabricating ladder data at render time.
//
// `targeting.scopes` shape (per LaunchDarkly Targeting / Unleash Strategies):
//   [
//     { scope_type: 'global', scope_id: 'global',  enabled: false, rollout_pct: 0 },
//     { scope_type: 'tenant', scope_id: 'org_x',   enabled: true,  rollout_pct: 100 },
//     { scope_type: 'client', scope_id: 'cl_y',    enabled: true,  rollout_pct: 50 },
//     { scope_type: 'sender', scope_id: 'snd_z',   enabled: false, rollout_pct: 0 }
//   ]
//
// `targeting.summary` is the human-readable single-chip description rendered
// in the DataTable "Targeting" column (so it renders without a row-by-row
// summary derivation pass).
export const feature_flags = [
  {
    id: 'ff_unified_dispatch_v2',
    key: 'unified_dispatch_v2',
    label: 'Unified dispatch v2',
    description:
      'Switch the dispatcher console to the v2 unified pane. Backed by orchestrator/route_run_v2.',
    status: 'on',
    rollout_percentage: 100,
    targeting: {
      summary: 'all tenants',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: true, rollout_pct: 100 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-22T08:14:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_route_solver_optaplanner',
    key: 'route_solver_optaplanner',
    label: 'Route solver · OptaPlanner backend',
    description:
      'Route solver swaps from heuristic shortest-path to OptaPlanner constraint solver. Disabled until perf budget is approved.',
    status: 'off',
    rollout_percentage: 0,
    targeting: {
      summary: 'disabled globally',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example', 'noor@rashed-logistics.example'],
    last_updated_at: '2026-04-21T16:42:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_pod_evidence_strict',
    key: 'pod_evidence_strict',
    label: 'POD evidence · strict mode',
    description:
      'Require both photo + signature for every PROOF_OF_DELIVERY scan. Tenant-scoped pilot.',
    status: 'percentage',
    rollout_percentage: 50,
    targeting: {
      summary: '50% rollout · org_rashed',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
        { scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, rollout_pct: 50 },
      ],
    },
    scope_type: 'tenant',
    scope_id: 'org_rashed',
    kill_switch: false,
    owners: ['noor@rashed-logistics.example'],
    last_updated_at: '2026-04-25T11:08:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_marketplace_bidding_phase2',
    key: 'marketplace_bidding_phase2',
    label: 'Marketplace bidding · phase 2',
    description:
      'Enable secondary auction round for partner bids. Limited to Exampleparcel KSA pilot.',
    status: 'on',
    rollout_percentage: 100,
    targeting: {
      summary: 'client: cl_exampleparcel_ksa only',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
        { scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', enabled: true, rollout_pct: 100 },
      ],
    },
    scope_type: 'client',
    scope_id: 'cl_exampleparcel_ksa',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-23T09:30:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_mobile_offline_writes',
    key: 'mobile_offline_writes',
    label: 'Mobile · offline writes',
    description:
      'Field Ops driver app queues mutations when offline and replays on reconnect. Kill switch is engaged after a sync corruption incident.',
    status: 'off',
    rollout_percentage: 0,
    targeting: {
      summary: 'kill switch engaged',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: true,
    owners: ['noor@rashed-logistics.example'],
    last_updated_at: '2026-04-25T20:42:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_cod_split_settlement',
    key: 'cod_split_settlement',
    label: 'COD · split settlement',
    description:
      'Split COD remittance into client + sender share at posting time. Currently in 25% rollout for Exampleparcel KSA.',
    status: 'percentage',
    rollout_percentage: 25,
    targeting: {
      summary: '25% rollout · cl_exampleparcel_ksa',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
        { scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, rollout_pct: 0 },
        { scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', enabled: true, rollout_pct: 25 },
      ],
    },
    scope_type: 'client',
    scope_id: 'cl_exampleparcel_ksa',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-24T14:11:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_label_renderer_zpl_v2',
    key: 'label_renderer_zpl_v2',
    label: 'Label renderer · ZPL v2',
    description:
      'New ZPL renderer for thermal printers. Adds GS1-128 barcode and QR support.',
    status: 'on',
    rollout_percentage: 100,
    targeting: {
      summary: 'all tenants',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: true, rollout_pct: 100 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-15T07:20:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_workflow_studio_visual_v3',
    key: 'workflow_studio_visual_v3',
    label: 'Workflow studio · visual v3',
    description:
      'New canvas-based workflow editor with drag-and-drop nodes. Beta for super admins.',
    status: 'percentage',
    rollout_percentage: 10,
    targeting: {
      summary: '10% rollout · super_admin only',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: true, rollout_pct: 10 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-20T13:45:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_pickup_wave_auto_assign',
    key: 'pickup_wave_auto_assign',
    label: 'Pickup wave · auto-assign',
    description:
      'Auto-assign pickup waves to drivers based on territory + load. Tenant pilot for org_rashed.',
    status: 'on',
    rollout_percentage: 100,
    targeting: {
      summary: 'tenant: org_rashed only',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
        { scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, rollout_pct: 100 },
      ],
    },
    scope_type: 'tenant',
    scope_id: 'org_rashed',
    kill_switch: false,
    owners: ['noor@rashed-logistics.example'],
    last_updated_at: '2026-04-19T11:00:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_geocode_provider_mapbox',
    key: 'geocode_provider_mapbox',
    label: 'Geocode provider · Mapbox',
    description:
      'Switch primary geocode provider from Google to Mapbox. Currently disabled — Mapbox SLA pending.',
    status: 'off',
    rollout_percentage: 0,
    targeting: {
      summary: 'disabled globally',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-10T09:25:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_partner_handover_qr',
    key: 'partner_handover_qr',
    label: 'Partner handover · QR manifest',
    description:
      'Print QR-coded handover manifests instead of barcoded ones for partner pickups. 75% rollout.',
    status: 'percentage',
    rollout_percentage: 75,
    targeting: {
      summary: '75% rollout',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: true, rollout_pct: 75 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: false,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-22T17:18:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_sender_portal_kanban',
    key: 'sender_portal_kanban',
    label: 'Sender portal · kanban view',
    description:
      'New kanban-board view of sender shipments in the portal. Sender-scoped pilot for snd_exampleparcel_jed.',
    status: 'on',
    rollout_percentage: 100,
    targeting: {
      summary: 'sender: snd_exampleparcel_jed only',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
        { scope_type: 'tenant', scope_id: 'org_rashed', enabled: false, rollout_pct: 0 },
        { scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', enabled: false, rollout_pct: 0 },
        { scope_type: 'sender', scope_id: 'snd_exampleparcel_jed', enabled: true, rollout_pct: 100 },
      ],
    },
    scope_type: 'sender',
    scope_id: 'snd_exampleparcel_jed',
    kill_switch: false,
    owners: ['noor@rashed-logistics.example'],
    last_updated_at: '2026-04-18T12:33:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_ai_address_correction',
    key: 'ai_address_correction',
    label: 'AI · address correction',
    description:
      'Use ML model to suggest address corrections at intake. Killed after 4.6% false-positive rate.',
    status: 'off',
    rollout_percentage: 0,
    targeting: {
      summary: 'kill switch engaged',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: true,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-26T06:50:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
  {
    id: 'ff_partner_marketplace_bidding_v3',
    key: 'partner_marketplace_bidding_v3',
    label: 'Marketplace bidding · v3 (multi-round)',
    description:
      'Three-round sealed-bid auction for marketplace requests. Behind a kill switch — under review by legal.',
    status: 'off',
    rollout_percentage: 0,
    targeting: {
      summary: 'kill switch engaged',
      scopes: [
        { scope_type: 'global', scope_id: 'global', enabled: false, rollout_pct: 0 },
      ],
    },
    scope_type: 'global',
    scope_id: 'global',
    kill_switch: true,
    owners: ['rashed@rashed-logistics.example'],
    last_updated_at: '2026-04-26T05:10:00Z',
    last_updated_by_user_id: 'usr_admin_rashed',
  },
];

// network-branches.js — CLAIM-NETWORK-BRANCHES (Wave 1, Phase A) seed snapshot.
//
// Mirrors the canonical operational unit catalog from
// supabase/migrations/202601212340_branches_coverage_foundation.sql:
//   • public.branches                  (id, organization_id, code, name, branch_type, address jsonb, is_active)
//   • public.branch_zones              (branch_id, zone_id, role)
//   • public.branch_memberships        (branch_id, user_id, role)
//   • public.branch_capacity_windows   (branch_id, day_of_week, window_start_local TIME, window_end_local TIME, capacity JSONB)
//     -- W18-3: FE heatmap reads the paired projection view
//     -- `public.v_branch_capacity_heatmap` (registry key:
//     -- `branch_capacity_heatmap`) which fans canonical
//     -- (day_of_week, [start, end)) ranges into per-hour cells with
//     -- (weekday, hour, capacity_units, booked_units). The seed below
//     -- ships rows in heatmap-cell shape; data-source.ts
//     -- `_projectBranchCapacityHeatmap()` is a typed pass-through.
//   • public.branch_coverage_windows   (branch_id, effective_from, effective_to, reason)
//     -- W18-3: dropped FE-fictional `weekday` (canonical is a continuous
//     -- range, not day-bucketed). FE only counts coverage rows for the
//     -- KPI tile so no projection is needed; `open_at` / `close_at`
//     -- aliases continue to project canonical effective_from /
//     -- effective_to until the wider registry-alias contract refactor
//     -- lands.
// And the next-level capacity/coverage primitives in
// supabase/migrations/202601212700_branch_capacity_catalog.sql.
//
// Capability gating: branches.read / branches.write — added to registry.js
// alongside the existing 'network.read' surface. Existing fleet-vehicles seed
// already references branch ids by the same string id (`hub_ruh_n`, `hub_jed_n`,
// `hub_ruh_s`, `hub_dmm_c`) so the four canonical hubs are *promoted* to
// branches without breaking those joins. Four additional rows extend the roster
// (two depots, two drop-off points) so the surface has the full type-mix
// described in the claim brief: 2 hubs · 4 depots · 2 dropoff_points across
// Riyadh, Jeddah, Dammam, Mecca, Madinah and Tabuk.
//
// Lookups: this module mutates `seed.lookups` to add branch_type,
// branch_status, branch_zone_role, and branch_member_role. Mirrors how
// fleet-vehicles.js seeds its enums — keeps lookups.js untouched so concurrent
// Wave 1 agents land additively.

import { lookups } from './lookups.js';

Object.assign(lookups, {
  // E2 closure (P1 #4) — `metadata.kpi_card_key` declares the KPI tile a
  // branch_type counts toward (replaces inline `=== 'hub' / === 'depot' /
  // === 'dropoff_point'` literals at branches.tsx:666-668). The KPI strip
  // tone is also a row property: `metadata.kpi_card_tone` carries the
  // semantic-categorical tone (Hub=info because hubs are the primary
  // topology nodes; Depot=neutral because they are transitional staging;
  // Drop-off=good because they expand reach). Adding a new branch_type
  // requires extending metadata so the KPI strip + filter targeting stays
  // SSOT-bound.
  branch_type: [
    { value: 'hub', label: 'Hub', tone: 'info', rank: 10, metadata: { kpi_card_key: 'hubs', kpi_card_tone: 'info' } },
    { value: 'depot', label: 'Depot', tone: 'neutral', rank: 20, metadata: { kpi_card_key: 'depots', kpi_card_tone: 'neutral' } },
    { value: 'warehouse', label: 'Warehouse', tone: 'neutral', rank: 30, metadata: { kpi_card_key: 'branches', kpi_card_tone: 'neutral' } },
    { value: 'branch', label: 'Branch', tone: 'neutral', rank: 40, metadata: { kpi_card_key: 'branches', kpi_card_tone: 'neutral' } },
    { value: 'satellite', label: 'Satellite', tone: 'good', rank: 50, metadata: { kpi_card_key: 'branches', kpi_card_tone: 'good' } },
    { value: 'counter', label: 'Counter', tone: 'neutral', rank: 60, metadata: { kpi_card_key: 'dropoffs', kpi_card_tone: 'neutral' } },
    { value: 'dropoff_point', label: 'Drop-off', tone: 'good', rank: 70, metadata: { kpi_card_key: 'dropoffs', kpi_card_tone: 'good' } },
  ],
  // E2 closure (P1 #4) — `metadata.is_active_branch_status` declares
  // whether a branch_status counts toward the "active branches" filter set
  // (used by the bulk-mark-OOS targeting). Replaces inline `=== 'active'`
  // literals in branches.tsx and the FE-alias-based isActiveOf resolver.
  // The canonical SSOT for OOS remains `branches.is_active=false`; this
  // metadata is for surface-side filtering against the multi-state FE
  // status alias.
  branch_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, is_default: true, metadata: { is_active_branch_status: true } },
    { value: 'reduced', label: 'Reduced ops', tone: 'warn', rank: 20, metadata: { is_active_branch_status: true } },
    { value: 'out_of_service', label: 'Out of service', tone: 'danger', rank: 30, metadata: { is_active_branch_status: false } },
    { value: 'planned', label: 'Planned', tone: 'info', rank: 40, metadata: { is_active_branch_status: false } },
  ],
  branch_zone_role: [
    { value: 'primary', label: 'Primary', tone: 'good', rank: 10 },
    { value: 'secondary', label: 'Secondary', tone: 'info', rank: 20 },
    { value: 'fallback', label: 'Fallback', tone: 'warn', rank: 30 },
  ],
  branch_member_role: [
    { value: 'manager', label: 'Branch manager', tone: 'good', rank: 10 },
    { value: 'ops_lead', label: 'Ops lead', tone: 'info', rank: 20 },
    { value: 'cashier', label: 'Cashier', tone: 'neutral', rank: 30 },
    { value: 'sorter', label: 'Sorter', tone: 'neutral', rank: 40 },
    { value: 'dispatcher', label: 'Dispatcher', tone: 'info', rank: 50 },
    { value: 'security', label: 'Security', tone: 'warn', rank: 60 },
  ],
});

// branches — 8 rows. The first 4 IDs are intentionally aligned with the
// existing `hubs` seed (`hub_ruh_n` / `hub_ruh_s` / `hub_jed_n` / `hub_dmm_c`)
// so that vehicles.current_branch_id and route_runs.branch_id continue to
// resolve once the network/branches surface goes live. The remaining 4 rows
// add depots + drop-off points to round out the type mix.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §1):
//   • `branch_type` ← canonical (FE alias `type`)
//   • `is_active`   ← canonical (FE alias `status` — multi-state derived
//                     via metadata.lifecycle)
//   • `metadata.lifecycle` ← drives the FE multi-state status display
//                     ('active'|'reduced'|'planned'); SSOT for OOS is
//                     canonical is_active=false.
// Both shapes are seeded so the FE row resolvers (`branchTypeOf` /
// `branchStatusOf` / `isActiveOf`) hit the canonical path first while
// downstream consumers (cross-module deep-links, legacy view sorts) that
// still read the FE alias keys keep working. `slug` remains as a back-
// compat duplicate of canonical `code` until the next seed cleanup wave.
export const branches = [
  {
    id: 'hub_ruh_n',
    organization_id: 'org_rashed',
    code: 'ruh-n',
    slug: 'ruh-n',
    name: 'Riyadh North · Hub',
    branch_type: 'hub',
    type: 'hub',
    address: 'Olaya · King Fahd Road · Riyadh 12211',
    city: 'Riyadh',
    capacity_per_day: 600,
    booked_today: 524,
    active_vehicles: 4,
    active_routes: 6,
    status: 'active',
    metadata: { lifecycle: 'active' },
    cutoff_time: '07:00',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_admin_rashed',
    coordinates: { lat: 24.7136, lng: 46.6753 },
    is_active: true,
    created_at: '2025-09-12T08:00:00Z',
    updated_at: '2026-04-26T07:42:00Z',
  },
  {
    id: 'hub_jed_n',
    organization_id: 'org_rashed',
    code: 'jed-n',
    slug: 'jed-n',
    name: 'Jeddah North · Hub',
    branch_type: 'hub',
    type: 'hub',
    address: 'Al-Hamra · Tahlia Street · Jeddah 23323',
    city: 'Jeddah',
    capacity_per_day: 720,
    booked_today: 612,
    active_vehicles: 3,
    active_routes: 8,
    status: 'active',
    metadata: { lifecycle: 'active' },
    cutoff_time: '06:30',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_admin_rashed',
    coordinates: { lat: 21.5433, lng: 39.1728 },
    is_active: true,
    created_at: '2025-09-12T08:00:00Z',
    updated_at: '2026-04-26T07:38:00Z',
  },
  {
    id: 'hub_ruh_s',
    organization_id: 'org_rashed',
    code: 'ruh-s',
    slug: 'ruh-s',
    name: 'Riyadh South · Depot',
    branch_type: 'depot',
    type: 'depot',
    address: 'Al-Suwaidi · Industrial Area 2 · Riyadh 13243',
    city: 'Riyadh',
    capacity_per_day: 480,
    booked_today: 318,
    active_vehicles: 2,
    active_routes: 4,
    status: 'active',
    metadata: { lifecycle: 'active' },
    cutoff_time: '07:00',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_dr_yousef',
    coordinates: { lat: 24.5694, lng: 46.7333 },
    is_active: true,
    created_at: '2025-10-04T09:00:00Z',
    updated_at: '2026-04-26T07:48:00Z',
  },
  {
    id: 'hub_dmm_c',
    organization_id: 'org_rashed',
    code: 'dmm-c',
    slug: 'dmm-c',
    name: 'Dammam Central · Depot',
    branch_type: 'depot',
    type: 'depot',
    address: 'Al-Khalidiyah · King Saud Street · Dammam 32242',
    city: 'Dammam',
    capacity_per_day: 360,
    booked_today: 198,
    active_vehicles: 1,
    active_routes: 3,
    status: 'reduced',
    metadata: { lifecycle: 'reduced' },
    cutoff_time: '07:00',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_dr_tariq',
    coordinates: { lat: 26.4207, lng: 50.0888 },
    is_active: true,
    created_at: '2025-11-18T08:00:00Z',
    updated_at: '2026-04-25T19:11:00Z',
  },
  {
    id: 'br_jed_s_depot',
    organization_id: 'org_rashed',
    code: 'jed-s',
    slug: 'jed-s',
    name: 'Jeddah South · Depot',
    branch_type: 'depot',
    type: 'depot',
    address: 'Al-Aziziyah · Al-Madinah Road · Jeddah 22473',
    city: 'Jeddah',
    capacity_per_day: 320,
    booked_today: 252,
    active_vehicles: 2,
    active_routes: 4,
    status: 'active',
    metadata: { lifecycle: 'active' },
    cutoff_time: '06:45',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_dr_mohammed',
    coordinates: { lat: 21.4286, lng: 39.2289 },
    is_active: true,
    created_at: '2026-01-12T08:00:00Z',
    updated_at: '2026-04-26T07:31:00Z',
  },
  {
    id: 'br_mec_h_depot',
    organization_id: 'org_rashed',
    code: 'mec-h',
    slug: 'mec-h',
    name: 'Mecca Holy Precinct · Depot',
    branch_type: 'depot',
    type: 'depot',
    address: 'Al-Aziziyah Al-Janubiyah · Ibrahim Al-Khalil Road · Mecca 24341',
    city: 'Mecca',
    capacity_per_day: 280,
    booked_today: 161,
    active_vehicles: 1,
    active_routes: 2,
    status: 'active',
    metadata: { lifecycle: 'active' },
    cutoff_time: '05:30',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_dr_ahmed',
    coordinates: { lat: 21.3891, lng: 39.8579 },
    is_active: true,
    created_at: '2026-02-08T08:00:00Z',
    updated_at: '2026-04-26T05:44:00Z',
  },
  {
    id: 'br_mad_dropoff',
    organization_id: 'org_rashed',
    code: 'mad-d',
    slug: 'mad-d',
    name: 'Madinah Quba · Drop-off',
    branch_type: 'dropoff_point',
    type: 'dropoff_point',
    address: 'Quba District · Al-Hijrah Road · Madinah 42313',
    city: 'Madinah',
    capacity_per_day: 140,
    booked_today: 92,
    active_vehicles: 0,
    active_routes: 1,
    status: 'active',
    metadata: { lifecycle: 'active' },
    cutoff_time: '08:00',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_dr_khalid',
    coordinates: { lat: 24.444, lng: 39.605 },
    is_active: true,
    created_at: '2026-03-02T08:00:00Z',
    updated_at: '2026-04-26T08:02:00Z',
  },
  {
    id: 'br_tab_dropoff',
    organization_id: 'org_rashed',
    code: 'tab-d',
    slug: 'tab-d',
    name: 'Tabuk Industrial · Drop-off',
    branch_type: 'dropoff_point',
    type: 'dropoff_point',
    address: 'Industrial City Phase 2 · Tabuk 47913',
    city: 'Tabuk',
    capacity_per_day: 120,
    booked_today: 47,
    active_vehicles: 0,
    active_routes: 1,
    status: 'planned',
    metadata: { lifecycle: 'planned' },
    cutoff_time: '08:30',
    timezone: 'Asia/Riyadh',
    manager_user_id: 'usr_dr_faisal',
    coordinates: { lat: 28.3835, lng: 36.5662 },
    is_active: true,
    created_at: '2026-04-19T08:00:00Z',
    updated_at: '2026-04-26T06:11:00Z',
  },
];

// branch_zones (network-branches projection) — 14 rows. Mirrors
// public.branch_zones with branch ids in the canonical post-migration form
// (`hub_ruh_n`, `hub_ruh_s`, …) used by the /network/branches surface.
//
// Zone IDs reference the canonical seed in network-zones.js (`zn_ruh_north`,
// `zn_jed_north`, `zn_dmm_central`, …) so the chip list and zone deep-links
// both work without an extra lookup. When NETWORK-ZONES converges its
// `branch_zones` to canonical branch ids, the two surfaces will reconcile
// against the same row set.
//
// W17-2 — `role` dropped from rows. Canonical `public.branch_zones` has no
// `role` column; the FE renders priority bands (0=primary, 1-19=secondary,
// 20+=fallback) via `priorityToBand()` in branches.tsx, mirroring the legacy
// labels exactly with no fictional column.
//
// W18-1 — renamed export from `branch_zone_links` to canonical `branch_zones`
// (closes __audit__/DECISIONS/REGISTRY-ALIASES.md §2). The single registry
// entry now serves both /network/branches and /network/zones surfaces under
// the merged `branches.read` / `branches.write` capability gate. Each row
// also carries `branch_label` (FE-side join projection from `branches.name`)
// so the /network/zones drawer can render the linked-branch label without
// re-querying the branches resource. Labels mirror `branches[].name` (above)
// — keep them in lockstep when adding/renaming branches.
export const branch_zones = [
  // hub_ruh_n — Riyadh North hub anchors RUH-N + Diplomatic Quarter primaries
  { id: 'bzl_ruh_n_north_p', branch_id: 'hub_ruh_n', branch_label: 'Riyadh North · Hub', zone_id: 'zn_ruh_north', priority: 0, created_at: '2025-09-12T08:00:00Z' },
  { id: 'bzl_ruh_n_dq_p', branch_id: 'hub_ruh_n', branch_label: 'Riyadh North · Hub', zone_id: 'zn_ruh_diplomatic', priority: 0, created_at: '2025-09-12T08:00:00Z' },
  { id: 'bzl_ruh_n_south_f', branch_id: 'hub_ruh_n', branch_label: 'Riyadh North · Hub', zone_id: 'zn_ruh_south', priority: 30, created_at: '2025-09-12T08:00:00Z' },
  // hub_ruh_s — Riyadh South depot owns RUH-S primary + secondary on RUH-N
  { id: 'bzl_ruh_s_south_p', branch_id: 'hub_ruh_s', branch_label: 'Riyadh South · Depot', zone_id: 'zn_ruh_south', priority: 0, created_at: '2025-10-04T09:00:00Z' },
  { id: 'bzl_ruh_s_north_s', branch_id: 'hub_ruh_s', branch_label: 'Riyadh South · Depot', zone_id: 'zn_ruh_north', priority: 10, created_at: '2025-10-04T09:00:00Z' },
  // hub_jed_n — Jeddah North primary covers JED coastal + Mecca Haram, secondary on JED Heritage + Madinah
  { id: 'bzl_jed_n_north_p', branch_id: 'hub_jed_n', branch_label: 'Jeddah North · Hub', zone_id: 'zn_jed_north', priority: 0, created_at: '2025-09-12T08:00:00Z' },
  { id: 'bzl_jed_n_haram_p', branch_id: 'hub_jed_n', branch_label: 'Jeddah North · Hub', zone_id: 'zn_mec_haram', priority: 0, created_at: '2025-09-12T08:00:00Z' },
  { id: 'bzl_jed_n_heritage_s', branch_id: 'hub_jed_n', branch_label: 'Jeddah North · Hub', zone_id: 'zn_jed_south', priority: 10, created_at: '2025-09-12T08:00:00Z' },
  { id: 'bzl_jed_n_mad_s', branch_id: 'hub_jed_n', branch_label: 'Jeddah North · Hub', zone_id: 'zn_mad_central', priority: 15, created_at: '2025-09-12T08:00:00Z' },
  // hub_dmm_c — Dammam Central depot anchors DMM Central
  { id: 'bzl_dmm_c_central_p', branch_id: 'hub_dmm_c', branch_label: 'Dammam Central · Depot', zone_id: 'zn_dmm_central', priority: 0, created_at: '2025-11-18T08:00:00Z' },
  // br_jed_s_depot — Jeddah South depot picks up JED Heritage primary + JED coastal fallback
  { id: 'bzl_jed_s_heritage_p', branch_id: 'br_jed_s_depot', branch_label: 'Jeddah South · Depot', zone_id: 'zn_jed_south', priority: 0, created_at: '2026-01-12T08:00:00Z' },
  { id: 'bzl_jed_s_north_f', branch_id: 'br_jed_s_depot', branch_label: 'Jeddah South · Depot', zone_id: 'zn_jed_north', priority: 30, created_at: '2026-01-12T08:00:00Z' },
  // br_mec_h_depot — Mecca depot owns Mecca Haram secondary share
  { id: 'bzl_mec_haram_s', branch_id: 'br_mec_h_depot', branch_label: 'Mecca Holy Precinct · Depot', zone_id: 'zn_mec_haram', priority: 10, created_at: '2026-02-08T08:00:00Z' },
  // br_mad_dropoff — Madinah drop-off owns Madinah Central primary
  { id: 'bzl_mad_central_p', branch_id: 'br_mad_dropoff', branch_label: 'Madinah Central · Drop-off', zone_id: 'zn_mad_central', priority: 0, created_at: '2026-03-02T08:00:00Z' },
];

// branch_memberships — 12 rows. Mirrors public.branch_memberships
// (id, branch_id, user_id, role_key, effective_from, effective_to, is_active).
// Backed by canonical user ids from seed.js + domain-routes.js so the staff
// DataTable can resolve names.
//
// W17-2 — `user_name` dropped from rows. Canonical
// `public.branch_memberships` has no display-name column; resolution comes
// from a `users` join (or paired projection view in a future wave). The FE
// staff table renders `user_id` directly without the fictional alias.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §3):
//   • `role_key`        ← canonical (FE alias `role`)
//   • `effective_from`  ← canonical (FE alias `joined_at`)
//   • `effective_to`    ← canonical (open-ended when null)
// Both shapes are seeded so the FE row resolvers (`memberRoleOf` /
// `memberJoinedAtOf`) hit the canonical path first while view-saved
// sorts/filters keyed on the FE aliases keep working.
export const branch_memberships = [
  { id: 'bm_001', branch_id: 'hub_ruh_n', user_id: 'usr_admin_rashed', role_key: 'manager', role: 'manager', effective_from: '2025-09-12T08:00:00Z', joined_at: '2025-09-12T08:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_002', branch_id: 'hub_ruh_n', user_id: 'usr_dr_khalid', role_key: 'ops_lead', role: 'ops_lead', effective_from: '2025-10-15T07:00:00Z', joined_at: '2025-10-15T07:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_003', branch_id: 'hub_ruh_n', user_id: 'usr_dr_mohammed', role_key: 'dispatcher', role: 'dispatcher', effective_from: '2026-01-08T07:00:00Z', joined_at: '2026-01-08T07:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_004', branch_id: 'hub_jed_n', user_id: 'usr_admin_rashed', role_key: 'manager', role: 'manager', effective_from: '2025-09-12T08:00:00Z', joined_at: '2025-09-12T08:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_005', branch_id: 'hub_jed_n', user_id: 'usr_dr_tariq', role_key: 'ops_lead', role: 'ops_lead', effective_from: '2025-12-04T06:00:00Z', joined_at: '2025-12-04T06:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_006', branch_id: 'hub_ruh_s', user_id: 'usr_dr_yousef', role_key: 'manager', role: 'manager', effective_from: '2025-10-04T09:00:00Z', joined_at: '2025-10-04T09:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_007', branch_id: 'hub_ruh_s', user_id: 'usr_dr_ahmed', role_key: 'cashier', role: 'cashier', effective_from: '2026-02-14T07:00:00Z', joined_at: '2026-02-14T07:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_008', branch_id: 'hub_dmm_c', user_id: 'usr_dr_tariq', role_key: 'manager', role: 'manager', effective_from: '2025-11-18T08:00:00Z', joined_at: '2025-11-18T08:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_009', branch_id: 'br_jed_s_depot', user_id: 'usr_dr_mohammed', role_key: 'manager', role: 'manager', effective_from: '2026-01-12T08:00:00Z', joined_at: '2026-01-12T08:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_010', branch_id: 'br_jed_s_depot', user_id: 'usr_dr_faisal', role_key: 'sorter', role: 'sorter', effective_from: '2026-02-22T08:00:00Z', joined_at: '2026-02-22T08:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_011', branch_id: 'br_mec_h_depot', user_id: 'usr_dr_ahmed', role_key: 'manager', role: 'manager', effective_from: '2026-02-08T08:00:00Z', joined_at: '2026-02-08T08:00:00Z', effective_to: null, is_active: true },
  { id: 'bm_012', branch_id: 'br_mad_dropoff', user_id: 'usr_dr_khalid', role_key: 'manager', role: 'manager', effective_from: '2026-03-02T08:00:00Z', joined_at: '2026-03-02T08:00:00Z', effective_to: null, is_active: true },
];

// branch_capacity_windows — generated row-driven for two anchor branches
// (hub_ruh_n + hub_jed_n) across all 7 weekdays × a peak subset of hours
// (06–22). Provides one row per (branch, weekday, hour) so the FE heatmap
// can render directly.
//
// W18-3 — Canonical SSOT is `public.branch_capacity_windows` with
// (branch_id, day_of_week, window_start_local, window_end_local,
// capacity JSONB). The FE heatmap reads through paired projection view
// `public.v_branch_capacity_heatmap` (registry key:
// `branch_capacity_heatmap`) which fans the canonical
// [window_start_local, window_end_local) range into per-hour cells with
// (weekday, hour, capacity_units, booked_units) materialised from
// `capacity` jsonb. This seed continues to ship rows in the heatmap-cell
// shape so seed/dev mode mirrors the live projection 1:1; data-source.ts
// `_projectBranchCapacityHeatmap()` is a typed pass-through over these
// rows. Other branches inherit defaults via the resolver — no row noise
// needed for them in the demo.
const _capacityHours = [6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21];
function _seedBranchCapacity(branchId, peakUnits, troughUnits) {
  const out = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (const hour of _capacityHours) {
      // Wind capacity up around morning + evening peaks; apply a Friday-afternoon
      // dip to match the prayer pattern in KSA.
      const isMorningPeak = hour >= 7 && hour <= 10;
      const isEveningPeak = hour >= 17 && hour <= 20;
      const fridayDip = weekday === 4 && hour >= 12 && hour <= 14;
      const base = isMorningPeak || isEveningPeak ? peakUnits : troughUnits;
      const units = fridayDip ? Math.round(base * 0.4) : base;
      out.push({
        id: `bcw_${branchId}_${weekday}_${hour}`,
        branch_id: branchId,
        weekday,
        hour,
        capacity_units: units,
        booked_units: Math.round(units * (0.4 + ((weekday + hour) % 5) * 0.12)),
        is_active: true,
        created_at: '2026-01-21T23:40:00Z',
        updated_at: '2026-04-26T07:00:00Z',
      });
    }
  }
  return out;
}
export const branch_capacity_windows = [
  ..._seedBranchCapacity('hub_ruh_n', 60, 28),
  ..._seedBranchCapacity('hub_jed_n', 72, 34),
];

// branch_coverage_windows — one continuous coverage range per branch.
//
// W18-3 — Mirrors canonical `public.branch_coverage_windows`
// (branch_id, effective_from, effective_to, reason, is_active). Dropped
// FE-fictional `weekday` since the canonical contract is a continuous
// range, not day-bucketed (one row per weekday previously was an
// FE-side flattening). The FE only counts coverage rows for the KPI
// tile so the row-cardinality reduction is non-breaking; `open_at` /
// `close_at` aliases project canonical effective_from/effective_to as
// time strings for back-compat with consumers that may still read them.
function _seedBranchCoverage(branchId, openHour, closeHour) {
  return [
    {
      id: `bcvw_${branchId}`,
      branch_id: branchId,
      // Canonical fields (effective_from / effective_to) — open-ended range
      // anchors the coverage to "active from boot, no scheduled end".
      effective_from: '2026-01-21T00:00:00Z',
      effective_to: null,
      // FE-projection aliases (back-compat with consumers that read open_at/close_at).
      open_at: `${String(openHour).padStart(2, '0')}:00`,
      close_at: `${String(closeHour).padStart(2, '0')}:00`,
      is_active: true,
      reason: null,
      created_at: '2026-01-21T23:40:00Z',
      updated_at: '2026-04-26T07:00:00Z',
    },
  ];
}
export const branch_coverage_windows = [
  ..._seedBranchCoverage('hub_ruh_n', 6, 22),
  ..._seedBranchCoverage('hub_jed_n', 6, 22),
  ..._seedBranchCoverage('hub_ruh_s', 6, 21),
  ..._seedBranchCoverage('hub_dmm_c', 7, 20),
  ..._seedBranchCoverage('br_jed_s_depot', 6, 21),
];

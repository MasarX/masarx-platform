// fleet-vehicles.js — Fleet roster snapshot mirrors the canonical tables in
// supabase/migrations/202601231000_fleet_foundation_v1.sql:
//   • public.vehicles
//   • public.vehicle_types
//   • public.vehicle_assignments
//   • public.vehicle_events
//   • public.vehicle_maintenance_windows
//
// Capability gating: fleet.read / fleet.write (already declared in registry.js
// + dev_roles ops_admin scope). Plates use Saudi format (3 letters / 4 digits).
//
// Backward compatibility: this module RE-EXPORTS `vehicles` with a richer
// shape so dispatch.tsx (which still references seed.vehicles only via
// data-source.ts → RESOURCE_DATA) continues to work — every legacy field
// (`code`, `kind`, `capacity_kg`, `capacity_stops`) is preserved alongside the
// new canonical columns. Existing drivers in domain-routes.js point at
// `vehicle_id` values that match `id` here (`veh_van_*` / `veh_bike_*`),
// so cross-references stay live.
//
// Lookups: this module mutates `seed.lookups` to add vehicle_status,
// vehicle_event_type, vehicle_kind, vehicle_fuel_type,
// vehicle_maintenance_kind, vehicle_maintenance_window_status. We do this
// here (not lookups.js) so Wave 1 agents can land additive changes without
// stepping on each other.

import { lookups, lookup_definitions } from './lookups.js';

// W61-Operate (P2-1) — paired `lookup_definitions` entry for `vehicle_event_type`.
// Mirrors the canonical SQL backend in
// supabase/migrations/202601311230_enterprise_ops_v1.sql:184-189
// (owner_role='fleet', approval_policy='tier_1', is_mutable=TRUE).
// Pushed at module-load time so the fleet-domain lookup row set in
// `Object.assign(lookups, …)` below stays paired with its definition row
// without splitting the SSOT across two files. AGENTS.md §2 (ZERO HARDCODING)
// + §4 (SSOT).
lookup_definitions.push({
  category: 'vehicle_event_type',
  owner_role: 'fleet',
  approval_policy: 'tier_1',
  is_mutable: true,
  description: 'Vehicle event types (odometer/fuel/maintenance/incident) consumed by operate/fleet/vehicles.tsx EventsTab filter chips + RecordVehicleEventForm.',
});
lookup_definitions.push({
  category: 'vehicle_document_kind',
  owner_role: 'fleet',
  approval_policy: 'tier_1',
  is_mutable: true,
  description: 'Vehicle document taxonomy consumed by operate/fleet/vehicles.tsx DocumentsTab and upload_vehicle_document_v1.',
});
lookup_definitions.push({
  category: 'vehicle_document_status',
  owner_role: 'fleet',
  approval_policy: 'tier_1',
  is_mutable: true,
  description: 'Vehicle document review lifecycle consumed by operate/fleet/vehicles.tsx DocumentsTab.',
});

Object.assign(lookups, {
  // W74-Operate (Cycle F-R-14 P1-2/3/4) — `metadata.is_on_shift`,
  // `metadata.is_in_maintenance`, `metadata.is_oos` row-drive the KPI strip
  // counters in `operate/fleet/vehicles.tsx#kpis`. Replaces inline
  // `v.status === 'on_shift'` / `v.status === 'in_maintenance'` /
  // `v.status === 'oos'` literal compares so a future canonical rename
  // (e.g. `on_duty`) flows through this row set instead of every
  // consumer's filter predicate. The boolean projections (`is_oos`,
  // `is_in_maintenance`) on `v_vehicle_directory` remain the SSOT
  // when present; metadata is the canonical fallback when consumers
  // only have the raw `status` enum to work with.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  vehicle_status: [
    { value: 'in_service', label: 'In service', tone: 'good', rank: 10, is_default: true,
      metadata: { is_on_shift: false, is_in_maintenance: false, is_oos: false } },
    { value: 'on_shift', label: 'On shift', tone: 'info', rank: 20,
      metadata: { is_on_shift: true,  is_in_maintenance: false, is_oos: false } },
    { value: 'in_maintenance', label: 'In maintenance', tone: 'warn', rank: 30,
      metadata: { is_on_shift: false, is_in_maintenance: true,  is_oos: false } },
    // W35b — canonical lookup value. `vehicle_status` gained `'oos'` (rank 25,
    // label 'Out of Service') via `supabase/migrations/202604280020_mark_vehicle_oos_v1.sql:20`.
    // The canonical lookup never had `'out_of_service'`, so we align the seed to
    // canonical here. The display label keeps the existing wording so the KPI
    // strip and lookup chip text remain stable.
    { value: 'oos', label: 'Out of service', tone: 'danger', rank: 40,
      metadata: { is_on_shift: false, is_in_maintenance: false, is_oos: true  } },
    { value: 'reserve', label: 'Reserve', tone: 'neutral', rank: 50,
      metadata: { is_on_shift: false, is_in_maintenance: false, is_oos: false } },
  ],
  // W80 (Cycle F-R-20) closure — canonical `vehicle_assignment_state`
  // taxonomy for vehicle assignment row chips. Replaces inline label+tone
  // literals (`<Chip label="active" kind="good" />` /
  // `<Chip label="historical" kind="neutral" />`) in
  // operate/fleet/vehicles.tsx so adding/renaming an assignment state is
  // a single seed update. Each row carries `metadata.is_active` for the
  // call-site discriminator (active when ended_at == null, otherwise
  // historical).
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
  vehicle_assignment_state: [
    { value: 'active',     label: 'active',     tone: 'good',    rank: 10, is_default: true, metadata: { is_active: true  } },
    { value: 'historical', label: 'historical', tone: 'neutral', rank: 20,                   metadata: { is_active: false } },
  ],
  vehicle_kind: [
    { value: 'van', label: 'Van', tone: 'info', rank: 10 },
    { value: 'box_truck', label: 'Box truck', tone: 'info', rank: 20 },
    { value: 'refrigerated', label: 'Refrigerated', tone: 'good', rank: 30 },
    { value: 'car', label: 'Car', tone: 'neutral', rank: 40 },
    { value: 'motorbike', label: 'Motorbike', tone: 'neutral', rank: 50 },
    { value: 'pickup', label: 'Pickup', tone: 'neutral', rank: 60 },
  ],
  vehicle_fuel_type: [
    { value: 'diesel', label: 'Diesel', tone: 'neutral' },
    { value: 'gasoline', label: 'Gasoline', tone: 'neutral' },
    { value: 'electric', label: 'Electric', tone: 'good' },
    { value: 'hybrid', label: 'Hybrid', tone: 'info' },
  ],
  // Canonical lookup per supabase/migrations/202601311230_enterprise_ops_v1.sql:240-251
  // (FLEET Wave 5 RE-AUDIT D4 alignment): odometer | fuel | maintenance |
  // incident. The legacy FE-only values (`fueling` / `inspection` / `repair`
  // / `cleaning`) are remapped against the canonical 4-value enum:
  //   fueling     → fuel
  //   inspection  → maintenance
  //   repair      → maintenance
  //   cleaning    → maintenance
  //   incident    → incident (kept)
  // odometer is added so the canonical set is complete.
  vehicle_event_type: [
    { value: 'odometer', label: 'Odometer', tone: 'neutral', rank: 10, is_default: true },
    { value: 'fuel', label: 'Fuel', tone: 'neutral', rank: 20 },
    { value: 'maintenance', label: 'Maintenance', tone: 'info', rank: 30 },
    { value: 'incident', label: 'Incident', tone: 'danger', rank: 40 },
  ],
  vehicle_document_kind: [
    { value: 'registration', label: 'Registration', tone: 'info', rank: 10, is_default: true },
    { value: 'insurance', label: 'Insurance', tone: 'good', rank: 20 },
    { value: 'inspection', label: 'Inspection', tone: 'warn', rank: 30 },
    { value: 'permit', label: 'Permit', tone: 'neutral', rank: 40 },
    { value: 'other', label: 'Other', tone: 'neutral', rank: 50 },
  ],
  vehicle_document_status: [
    { value: 'submitted', label: 'Submitted', tone: 'info', rank: 10, is_default: true },
    { value: 'verified', label: 'Verified', tone: 'good', rank: 20 },
    { value: 'rejected', label: 'Rejected', tone: 'danger', rank: 30 },
    { value: 'expired', label: 'Expired', tone: 'warn', rank: 40 },
  ],
  vehicle_maintenance_kind: [
    { value: 'preventive', label: 'Preventive', tone: 'info', rank: 10 },
    { value: 'oil_change', label: 'Oil change', tone: 'neutral', rank: 20 },
    { value: 'tire_rotation', label: 'Tire rotation', tone: 'neutral', rank: 30 },
    { value: 'brake_service', label: 'Brake service', tone: 'warn', rank: 40 },
    { value: 'inspection', label: 'Inspection', tone: 'info', rank: 50 },
    { value: 'major_repair', label: 'Major repair', tone: 'danger', rank: 60 },
  ],
  vehicle_maintenance_window_status: [
    { value: 'planned', label: 'Planned', tone: 'info', rank: 10 },
    { value: 'in_progress', label: 'In progress', tone: 'warn', rank: 20 },
    { value: 'completed', label: 'Completed', tone: 'good', rank: 30 },
    { value: 'cancelled', label: 'Cancelled', tone: 'neutral', rank: 40 },
  ],
});

// vehicle_types — canonical table (id, name, key, metadata jsonb).
// W11-4 close-out: canonical column `key` is now the primary discriminator
// (renamed from FE-side `kind`); legacy `kind` retained as transitional alias
// for existing consumers until they migrate to `key`. Capacity/attribute
// fields (capacity_kg, capacity_m3, axles, max_speed_kph, fuel_type) are
// projection-shaped on the canonical table (live in `metadata` JSONB) — the
// seed surfaces them flat for FE rendering parity.
export const vehicle_types = [
  {
    id: 'vty_van_med',
    name: 'Medium van',
    key: 'van',
    kind: 'van',
    capacity_kg: 1200,
    capacity_m3: 8.5,
    axles: 2,
    max_speed_kph: 120,
    fuel_type: 'diesel',
  },
  {
    id: 'vty_van_lg',
    name: 'Large van',
    key: 'van',
    kind: 'van',
    capacity_kg: 1500,
    capacity_m3: 12,
    axles: 2,
    max_speed_kph: 110,
    fuel_type: 'diesel',
  },
  {
    id: 'vty_box_3t',
    name: 'Box truck — 3 ton',
    key: 'box_truck',
    kind: 'box_truck',
    capacity_kg: 3000,
    capacity_m3: 18,
    axles: 2,
    max_speed_kph: 100,
    fuel_type: 'diesel',
  },
  {
    id: 'vty_refer_2t',
    name: 'Refrigerated — 2 ton',
    key: 'refrigerated',
    kind: 'refrigerated',
    capacity_kg: 2000,
    capacity_m3: 14,
    axles: 2,
    max_speed_kph: 100,
    fuel_type: 'diesel',
  },
  {
    id: 'vty_car_sedan',
    name: 'Sedan',
    key: 'car',
    kind: 'car',
    capacity_kg: 250,
    capacity_m3: 0.6,
    axles: 2,
    max_speed_kph: 180,
    fuel_type: 'gasoline',
  },
  {
    id: 'vty_bike_125',
    name: 'Motorbike 125cc',
    key: 'motorbike',
    kind: 'motorbike',
    capacity_kg: 30,
    capacity_m3: 0.15,
    axles: 2,
    max_speed_kph: 90,
    fuel_type: 'gasoline',
  },
];

// vehicles — 9 rows. Mirrors public.vehicles canonical columns. Saudi plates
// use the official 3-letter Latin / 4-digit format. IDs (`veh_van_118` etc.)
// match the shipping driver→vehicle_id pointers in domain-routes.js so the
// existing dispatch module keeps resolving its joins correctly. Legacy fields
// (`code`, `kind`, `capacity_kg`, `capacity_stops`) are preserved so the
// pre-CLAIM-FLEET-VEHICLES dispatch surface continues to render.
export const vehicles = [
  {
    id: 'veh_van_118',
    organization_id: 'org_rashed',
    plate: 'RUH 1184',
    vin: 'JTHBE96S470118241',
    type_id: 'vty_van_med',
    type_name: 'Medium van',
    current_driver_user_id: 'usr_dr_khalid',
    current_branch_id: 'hub_ruh_n',
    status: 'on_shift',
    fuel_level: 0.74,
    odometer_km: 84_312,
    last_telemetry_at: '2026-04-26T07:42:00Z',
    // legacy (compat)
    code: 'VAN-118',
    kind: 'van',
    capacity_kg: 1200,
    capacity_stops: 30,
  },
  {
    id: 'veh_van_204',
    organization_id: 'org_rashed',
    plate: 'RUH 2044',
    vin: 'JTHBE96S470204582',
    type_id: 'vty_van_med',
    type_name: 'Medium van',
    current_driver_user_id: 'usr_dr_mohammed',
    current_branch_id: 'hub_ruh_n',
    status: 'on_shift',
    fuel_level: 0.31,
    odometer_km: 112_488,
    last_telemetry_at: '2026-04-26T07:55:00Z',
    code: 'VAN-204',
    kind: 'van',
    capacity_kg: 1200,
    capacity_stops: 30,
  },
  {
    id: 'veh_bike_22',
    organization_id: 'org_rashed',
    plate: 'RUH 0022',
    vin: 'MR1JC4111L0220041',
    type_id: 'vty_bike_125',
    type_name: 'Motorbike 125cc',
    current_driver_user_id: 'usr_dr_faisal',
    current_branch_id: 'hub_ruh_n',
    status: 'on_shift',
    fuel_level: 0.58,
    odometer_km: 21_405,
    last_telemetry_at: '2026-04-26T08:01:00Z',
    code: 'BIKE-22',
    kind: 'motorbike',
    capacity_kg: 30,
    capacity_stops: 18,
  },
  {
    id: 'veh_van_091',
    organization_id: 'org_rashed',
    plate: 'JED 0918',
    vin: 'JTHBE96S470091118',
    type_id: 'vty_van_lg',
    type_name: 'Large van',
    current_driver_user_id: 'usr_dr_tariq',
    current_branch_id: 'hub_jed_n',
    status: 'on_shift',
    fuel_level: 0.62,
    odometer_km: 96_104,
    last_telemetry_at: '2026-04-26T07:31:00Z',
    code: 'VAN-091',
    kind: 'van',
    capacity_kg: 1500,
    capacity_stops: 32,
  },
  {
    id: 'veh_van_156',
    organization_id: 'org_rashed',
    plate: 'RUH 1564',
    vin: 'JTHBE96S470156820',
    type_id: 'vty_van_med',
    type_name: 'Medium van',
    current_driver_user_id: 'usr_dr_yousef',
    current_branch_id: 'hub_ruh_s',
    status: 'on_shift',
    fuel_level: 0.46,
    odometer_km: 102_915,
    last_telemetry_at: '2026-04-26T07:48:00Z',
    code: 'VAN-156',
    kind: 'van',
    capacity_kg: 1200,
    capacity_stops: 30,
  },
  {
    id: 'veh_van_077',
    organization_id: 'org_rashed',
    plate: 'RUH 0774',
    vin: 'JTHBE96S470077553',
    type_id: 'vty_van_med',
    type_name: 'Medium van',
    current_driver_user_id: 'usr_dr_ahmed',
    current_branch_id: 'hub_ruh_s',
    status: 'in_service',
    fuel_level: 0.88,
    odometer_km: 67_251,
    last_telemetry_at: '2026-04-26T06:12:00Z',
    code: 'VAN-077',
    kind: 'van',
    capacity_kg: 1200,
    capacity_stops: 28,
  },
  {
    id: 'veh_box_312',
    organization_id: 'org_rashed',
    plate: 'DMM 3124',
    vin: 'WDB9710031L312045',
    type_id: 'vty_box_3t',
    type_name: 'Box truck — 3 ton',
    current_driver_user_id: null,
    current_branch_id: 'hub_dmm_c',
    status: 'in_maintenance',
    fuel_level: 0.18,
    odometer_km: 158_902,
    last_telemetry_at: '2026-04-25T18:04:00Z',
    code: 'BOX-312',
    kind: 'box_truck',
    capacity_kg: 3000,
    capacity_stops: 42,
  },
  {
    id: 'veh_refer_408',
    organization_id: 'org_rashed',
    plate: 'JED 4088',
    vin: 'WDB9710031L408902',
    type_id: 'vty_refer_2t',
    type_name: 'Refrigerated — 2 ton',
    current_driver_user_id: null,
    current_branch_id: 'hub_jed_n',
    status: 'in_service',
    fuel_level: 0.52,
    odometer_km: 41_204,
    last_telemetry_at: '2026-04-26T05:11:00Z',
    code: 'RFR-408',
    kind: 'refrigerated',
    capacity_kg: 2000,
    capacity_stops: 24,
  },
  {
    id: 'veh_car_512',
    organization_id: 'org_rashed',
    plate: 'RUH 5124',
    vin: '1HGBH41JXMN512318',
    type_id: 'vty_car_sedan',
    type_name: 'Sedan',
    current_driver_user_id: null,
    current_branch_id: 'hub_ruh_n',
    // W35b — canonical `vehicle_status` value (was 'out_of_service'; canonical
    // lookup uses 'oos' per supabase/migrations/202604280020_mark_vehicle_oos_v1.sql:20).
    status: 'oos',
    fuel_level: 0.04,
    odometer_km: 198_881,
    last_telemetry_at: '2026-04-22T11:48:00Z',
    code: 'CAR-512',
    kind: 'car',
    capacity_kg: 250,
    capacity_stops: 8,
  },
];

// vehicle_assignments — 12 rows (active + historical). Mirrors public.vehicle_assignments
// (id, vehicle_id, driver_user_id, started_at, ended_at). `ended_at = null`
// means the assignment is still active.
export const vehicle_assignments = [
  // Active
  { id: 'va_1001', vehicle_id: 'veh_van_118', driver_user_id: 'usr_dr_khalid', driver_name: 'Khalid Al-Otaibi', started_at: '2026-03-15T07:00:00Z', ended_at: null },
  { id: 'va_1002', vehicle_id: 'veh_van_204', driver_user_id: 'usr_dr_mohammed', driver_name: 'Mohammed Hassan', started_at: '2026-04-01T07:00:00Z', ended_at: null },
  { id: 'va_1003', vehicle_id: 'veh_bike_22', driver_user_id: 'usr_dr_faisal', driver_name: 'Faisal Al-Harbi', started_at: '2026-02-08T08:00:00Z', ended_at: null },
  { id: 'va_1004', vehicle_id: 'veh_van_091', driver_user_id: 'usr_dr_tariq', driver_name: 'Tariq Al-Mutairi', started_at: '2026-03-22T06:00:00Z', ended_at: null },
  { id: 'va_1005', vehicle_id: 'veh_van_156', driver_user_id: 'usr_dr_yousef', driver_name: 'Yousef Al-Shehri', started_at: '2026-01-12T07:00:00Z', ended_at: null },
  // Historical
  { id: 'va_1006', vehicle_id: 'veh_van_118', driver_user_id: 'usr_dr_ahmed', driver_name: 'Ahmed Bin Salem', started_at: '2025-11-04T07:00:00Z', ended_at: '2026-03-14T19:00:00Z' },
  { id: 'va_1007', vehicle_id: 'veh_van_204', driver_user_id: 'usr_dr_yousef', driver_name: 'Yousef Al-Shehri', started_at: '2025-12-15T07:00:00Z', ended_at: '2026-03-31T19:00:00Z' },
  { id: 'va_1008', vehicle_id: 'veh_van_077', driver_user_id: 'usr_dr_ahmed', driver_name: 'Ahmed Bin Salem', started_at: '2026-03-15T07:00:00Z', ended_at: '2026-04-22T19:00:00Z' },
  { id: 'va_1009', vehicle_id: 'veh_box_312', driver_user_id: 'usr_dr_tariq', driver_name: 'Tariq Al-Mutairi', started_at: '2025-09-01T06:00:00Z', ended_at: '2026-03-21T19:00:00Z' },
  { id: 'va_1010', vehicle_id: 'veh_refer_408', driver_user_id: 'usr_dr_mohammed', driver_name: 'Mohammed Hassan', started_at: '2025-08-12T07:00:00Z', ended_at: '2026-03-31T19:00:00Z' },
  { id: 'va_1011', vehicle_id: 'veh_car_512', driver_user_id: 'usr_dr_faisal', driver_name: 'Faisal Al-Harbi', started_at: '2025-06-01T08:00:00Z', ended_at: '2026-02-07T19:00:00Z' },
  { id: 'va_1012', vehicle_id: 'veh_bike_22', driver_user_id: 'usr_dr_khalid', driver_name: 'Khalid Al-Otaibi', started_at: '2025-07-01T07:00:00Z', ended_at: '2026-02-07T19:00:00Z' },
];

// vehicle_events — 18 rows. Mirrors public.vehicle_events
// (id, vehicle_id, event_type, occurred_at, actor_user_id, metadata jsonb).
// Renamed `payload` → `metadata` per W10-2 D4 closure to align with the
// canonical column name (record_vehicle_event_v1.sql:61 reads p_args->'metadata').
// Spread across multiple vehicles and event types so the type-filter chips
// + TimelineLog have meaningful content.
export const vehicle_events = [
  { id: 'vev_2001', vehicle_id: 'veh_van_118', event_type: 'fuel', occurred_at: '2026-04-25T18:30:00Z', actor_user_id: 'usr_dr_khalid', actor_name: 'Khalid Al-Otaibi', metadata: { liters: 48, amount_sar: 96.0, station: 'ARAMCO RUH-N' } },
  { id: 'vev_2002', vehicle_id: 'veh_van_118', event_type: 'maintenance', occurred_at: '2026-04-22T08:00:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { result: 'pass', notes: 'tires OK · brakes OK · lights OK' } },
  { id: 'vev_2003', vehicle_id: 'veh_van_204', event_type: 'incident', occurred_at: '2026-04-24T14:11:00Z', actor_user_id: 'usr_dr_mohammed', actor_name: 'Mohammed Hassan', metadata: { severity: 'minor', description: 'Bumper scrape · parking lot · no injuries', reported_to_insurance: true } },
  { id: 'vev_2004', vehicle_id: 'veh_van_204', event_type: 'fuel', occurred_at: '2026-04-25T19:02:00Z', actor_user_id: 'usr_dr_mohammed', actor_name: 'Mohammed Hassan', metadata: { liters: 52, amount_sar: 104.0, station: 'PETROMIN RUH' } },
  { id: 'vev_2005', vehicle_id: 'veh_bike_22', event_type: 'maintenance', occurred_at: '2026-04-15T09:30:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { result: 'pass', notes: 'chain replaced' } },
  { id: 'vev_2006', vehicle_id: 'veh_bike_22', event_type: 'fuel', occurred_at: '2026-04-26T07:11:00Z', actor_user_id: 'usr_dr_faisal', actor_name: 'Faisal Al-Harbi', metadata: { liters: 6, amount_sar: 12.0, station: 'ARAMCO RUH-N' } },
  { id: 'vev_2007', vehicle_id: 'veh_van_091', event_type: 'maintenance', occurred_at: '2026-04-19T11:00:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { component: 'rear suspension bushing', cost_sar: 480, vendor: 'AlNasser Motors' } },
  { id: 'vev_2008', vehicle_id: 'veh_van_091', event_type: 'fuel', occurred_at: '2026-04-25T17:48:00Z', actor_user_id: 'usr_dr_tariq', actor_name: 'Tariq Al-Mutairi', metadata: { liters: 60, amount_sar: 120.0, station: 'ARAMCO JED-N' } },
  { id: 'vev_2009', vehicle_id: 'veh_van_156', event_type: 'maintenance', occurred_at: '2026-04-23T20:00:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { kind: 'interior_deep', vendor: 'Sparkle Auto' } },
  { id: 'vev_2010', vehicle_id: 'veh_van_156', event_type: 'fuel', occurred_at: '2026-04-25T18:55:00Z', actor_user_id: 'usr_dr_yousef', actor_name: 'Yousef Al-Shehri', metadata: { liters: 44, amount_sar: 88.0, station: 'PETROMIN RUH-S' } },
  { id: 'vev_2011', vehicle_id: 'veh_van_077', event_type: 'maintenance', occurred_at: '2026-04-22T07:30:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { result: 'pass' } },
  { id: 'vev_2012', vehicle_id: 'veh_box_312', event_type: 'incident', occurred_at: '2026-04-21T16:42:00Z', actor_user_id: 'usr_dr_tariq', actor_name: 'Tariq Al-Mutairi', metadata: { severity: 'moderate', description: 'Hydraulic lift seal failure · driver safe', reported_to_insurance: false } },
  { id: 'vev_2013', vehicle_id: 'veh_box_312', event_type: 'maintenance', occurred_at: '2026-04-22T09:15:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { component: 'hydraulic lift seals', cost_sar: 1820, vendor: 'Mercedes-Benz Saudi' } },
  { id: 'vev_2014', vehicle_id: 'veh_box_312', event_type: 'maintenance', occurred_at: '2026-04-25T15:00:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { result: 'fail', notes: 'awaiting hydraulic part · ETA 2026-04-28' } },
  { id: 'vev_2015', vehicle_id: 'veh_refer_408', event_type: 'maintenance', occurred_at: '2026-04-20T08:00:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { result: 'pass', notes: 'cooling unit calibrated · -2°C steady' } },
  { id: 'vev_2016', vehicle_id: 'veh_refer_408', event_type: 'fuel', occurred_at: '2026-04-25T05:08:00Z', actor_user_id: 'usr_dr_mohammed', actor_name: 'Mohammed Hassan', metadata: { liters: 70, amount_sar: 140.0, station: 'ARAMCO JED-N' } },
  { id: 'vev_2017', vehicle_id: 'veh_car_512', event_type: 'incident', occurred_at: '2026-02-07T18:11:00Z', actor_user_id: 'usr_dr_faisal', actor_name: 'Faisal Al-Harbi', metadata: { severity: 'major', description: 'Engine seized · towed to vendor', reported_to_insurance: true } },
  { id: 'vev_2018', vehicle_id: 'veh_car_512', event_type: 'maintenance', occurred_at: '2026-02-09T10:00:00Z', actor_user_id: 'usr_admin_rashed', actor_name: 'Rashed Al-Otaibi', metadata: { component: 'engine block', cost_sar: 12_400, vendor: 'Toyota Saudi Arabia' } },
];

export const vehicle_documents = [
  {
    id: 'vdoc_van118_registration',
    organization_id: 'org_rashed',
    vehicle_id: 'veh_van_118',
    doc_type: 'registration',
    kind: 'registration',
    status: 'verified',
    issuer: 'Fleet Authority',
    issued_at: '2025-01-01',
    expires_at: '2027-01-01',
    artifact_id: 'art_vehicle_van118_registration',
    metadata: { source: 'seed', plate_number: 'RUH 1187' },
    created_at: '2026-04-01T08:00:00Z',
    updated_at: '2026-04-01T08:00:00Z',
  },
  {
    id: 'vdoc_van204_insurance',
    organization_id: 'org_rashed',
    vehicle_id: 'veh_van_204',
    doc_type: 'insurance',
    kind: 'insurance',
    status: 'submitted',
    issuer: 'Tawuniya Fleet',
    issued_at: '2026-02-01',
    expires_at: '2027-02-01',
    artifact_id: 'art_vehicle_van204_insurance',
    metadata: { source: 'seed', plate_number: 'RUH 2049' },
    created_at: '2026-04-03T08:00:00Z',
    updated_at: '2026-04-03T08:00:00Z',
  },
  {
    id: 'vdoc_box312_inspection',
    organization_id: 'org_rashed',
    vehicle_id: 'veh_box_312',
    doc_type: 'inspection',
    kind: 'inspection',
    status: 'expired',
    issuer: 'Vehicle Inspection Center',
    issued_at: '2025-04-01',
    expires_at: '2026-04-01',
    artifact_id: 'art_vehicle_box312_inspection',
    metadata: { source: 'seed', plate_number: 'DMM 3124' },
    created_at: '2026-04-05T08:00:00Z',
    updated_at: '2026-04-05T08:00:00Z',
  },
];

// vehicle_maintenance_windows — 9 rows (past + planned). Mirrors
// public.vehicle_maintenance_windows (id, vehicle_id, planned_start,
// planned_end, scheduled_kind, status). Used by the Maintenance tab calendar.
export const vehicle_maintenance_windows = [
  // Past
  { id: 'vmw_3001', vehicle_id: 'veh_van_118', planned_start: '2026-04-12T08:00:00Z', planned_end: '2026-04-12T11:00:00Z', scheduled_kind: 'oil_change', status: 'completed' },
  { id: 'vmw_3002', vehicle_id: 'veh_van_204', planned_start: '2026-04-15T13:00:00Z', planned_end: '2026-04-15T15:00:00Z', scheduled_kind: 'tire_rotation', status: 'completed' },
  { id: 'vmw_3003', vehicle_id: 'veh_box_312', planned_start: '2026-04-22T09:00:00Z', planned_end: '2026-04-22T17:00:00Z', scheduled_kind: 'major_repair', status: 'scheduled' },
  // Planned (this and next week)
  { id: 'vmw_3004', vehicle_id: 'veh_van_091', planned_start: '2026-04-27T08:00:00Z', planned_end: '2026-04-27T10:30:00Z', scheduled_kind: 'preventive', status: 'scheduled' },
  { id: 'vmw_3005', vehicle_id: 'veh_van_156', planned_start: '2026-04-28T14:00:00Z', planned_end: '2026-04-28T16:00:00Z', scheduled_kind: 'oil_change', status: 'scheduled' },
  { id: 'vmw_3006', vehicle_id: 'veh_refer_408', planned_start: '2026-04-29T07:00:00Z', planned_end: '2026-04-29T11:00:00Z', scheduled_kind: 'inspection', status: 'scheduled' },
  { id: 'vmw_3007', vehicle_id: 'veh_bike_22', planned_start: '2026-04-30T09:00:00Z', planned_end: '2026-04-30T10:00:00Z', scheduled_kind: 'tire_rotation', status: 'scheduled' },
  { id: 'vmw_3008', vehicle_id: 'veh_van_077', planned_start: '2026-05-02T08:00:00Z', planned_end: '2026-05-02T10:00:00Z', scheduled_kind: 'brake_service', status: 'scheduled' },
  { id: 'vmw_3009', vehicle_id: 'veh_car_512', planned_start: '2026-05-04T08:00:00Z', planned_end: '2026-05-04T17:00:00Z', scheduled_kind: 'major_repair', status: 'scheduled' },
];

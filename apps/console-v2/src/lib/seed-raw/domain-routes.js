// domain-routes.js — route_plans, route_runs, route_stops, drivers, vehicles, hubs, route_run_assignments
// Anchored: AGENTS.md lines 19-23, 45-48; supabase/migrations route plan SSOT.
//
// W17-5 — legacy `zones` export removed. The hub-keyed picker shape was a
// dead-code FE-only seed (only consumer was the deprecated `RESOURCE_DATA().zones`
// pass-through, which no `useResourceList<>('zones')` callsite ever requested).
// The canonical `zones` export now lives in `network-zones.js` and mirrors
// `public.zones`. See `__audit__/DECISIONS/REGISTRY-ALIASES.md` §1 closure.
// `lat` / `lng` mirror the canonical `branches.coordinates` JSONB column
// (seed-raw/network-branches.js — same hub_* IDs). Tracking-map renders
// hub markers strictly from these coordinates; missing lat/lng surfaces
// an explicit "missing-location" indicator (no synthetic substitution).
export const hubs = [
  { id: 'hub_ruh_n', code: 'RUH-N', name: 'Riyadh North', city: 'Riyadh', cutoff_time: '07:00', staging_capacity: 600, lat: 24.7136, lng: 46.6753 },
  { id: 'hub_ruh_s', code: 'RUH-S', name: 'Riyadh South', city: 'Riyadh', cutoff_time: '07:00', staging_capacity: 480, lat: 24.5694, lng: 46.7333 },
  { id: 'hub_jed_n', code: 'JED-N', name: 'Jeddah North', city: 'Jeddah', cutoff_time: '06:30', staging_capacity: 720, lat: 21.5433, lng: 39.1728 },
  { id: 'hub_dmm_c', code: 'DMM-C', name: 'Dammam Central', city: 'Dammam', cutoff_time: '07:00', staging_capacity: 360, lat: 26.4207, lng: 50.0888 },
];

// W19-5 — legacy `drivers` 6-row picker array removed. The picker shape is
// now produced by `_projectDriverPickers()` in `data-source.ts`, which
// derives `{ id: user_id, name, vehicle_id, skills }` rows from the canonical
// `driver_profiles` SSOT (seed-raw/fleet-drivers.js — 12 rows). The
// `useResourceList<DriverRow>('drivers')` resource registration in
// `data-source.ts` continues to work via that virtual projection, so
// dispatch.tsx / pickups.tsx / fleet/vehicles.tsx pickers stay functional
// without a parallel data source. See
// `__audit__/DECISIONS/REGISTRY-ALIASES.md` §4 closure (W19-5).
//
// Historical context (W13-2): the legacy array dropped a fictional `shift`
// column per __audit__/SCHEMA-DRIFT/OPERATIONS.md §9 (`driver_profiles` has
// no `shift` column). The pickups driver picker renders `id · vehicle_id`
// (canonical-only) instead of the synthetic shift.

export const vehicles = [
  { id: 'veh_van_118', code: 'VAN-118', kind: 'van', capacity_kg: 1200, capacity_stops: 30 },
  { id: 'veh_van_204', code: 'VAN-204', kind: 'van', capacity_kg: 1200, capacity_stops: 30 },
  { id: 'veh_bike_22', code: 'BIKE-22', kind: 'motorbike', capacity_kg: 30, capacity_stops: 18 },
  { id: 'veh_van_091', code: 'VAN-091', kind: 'van', capacity_kg: 1500, capacity_stops: 32 },
  { id: 'veh_van_156', code: 'VAN-156', kind: 'van', capacity_kg: 1200, capacity_stops: 30 },
  { id: 'veh_van_077', code: 'VAN-077', kind: 'van', capacity_kg: 1200, capacity_stops: 28 },
];

export const route_plans = [
  { id: 'rpl_2026_0418_ruh_n', plan_id: 'PLN-2026-0418-RUH-N', wave_label: 'RUH-N · Wave 2', hub: 'RUH-N', status: 'applied', stops: 142, runs: 18, drivers_notified: 18, applied: 14, updated_at: '2026-04-25T08:24:00Z', created_by: 'usr_admin_rashed' },
  { id: 'rpl_2026_0418_ruh_s', plan_id: 'PLN-2026-0418-RUH-S', wave_label: 'RUH-S · Wave 1', hub: 'RUH-S', status: 'published', stops: 96, runs: 12, drivers_notified: 12, applied: 0, updated_at: '2026-04-25T08:18:00Z', created_by: 'usr_admin_rashed' },
  { id: 'rpl_2026_0418_jed_n', plan_id: 'PLN-2026-0418-JED-N', wave_label: 'JED-N · Wave 1', hub: 'JED-N', status: 'frozen', stops: 184, runs: 22, drivers_notified: 0, applied: 0, updated_at: '2026-04-25T07:42:00Z', created_by: 'usr_admin_rashed' },
  { id: 'rpl_2026_0418_dmm_c', plan_id: 'PLN-2026-0418-DMM-C', wave_label: 'DMM-C · Wave 1', hub: 'DMM-C', status: 'solved', stops: 78, runs: 9, drivers_notified: 0, applied: 0, updated_at: '2026-04-25T07:15:00Z', created_by: 'usr_admin_rashed' },
  { id: 'rpl_2026_0418_ruh_n_w3', plan_id: 'PLN-2026-0418-RUH-N-W3', wave_label: 'RUH-N · Wave 3', hub: 'RUH-N', status: 'draft', stops: 64, runs: 0, drivers_notified: 0, applied: 0, updated_at: '2026-04-25T11:02:00Z', created_by: 'usr_admin_rashed' },
];

// W14-1 — route_runs seed shape now mirrors `public.route_runs` columns
// (organization_id, branch_id, driver_user_id, vehicle_id, status,
// planned_date, planned_*_at, started_at, ended_at, metadata) per migration
// 202601231130_route_runs_foundation_v1.sql. The dispatch FE consumes this
// shape directly and drops the prior FE aliases (run_id label, driver name,
// vehicle plate, stops/completed counts, sla/eta/risk/cod_total).
//
// Legacy aliases (`run_id`, `driver`, `vehicle`, `stops`, `completed`, `sla`,
// `eta`, `partner`, `risk`, `risk_note`, `cod_total`, `partner_id`,
// `distance_km`) are preserved on each row only because two non-dispatch
// callsites still read them in this wave:
//   • `apps/console-v2/src/lib/data-source.ts:dashboardKpis()` reads
//     `r.stops` and `r.risk` (KPI counters).
//   • `apps/console-v2/src/modules/network/branches.tsx:RouteRunRow` table
//     renders run_id / driver / vehicle / stops / completed.
// Their migration is tracked in the OPERATIONS schema-drift closure log; once
// they consume canonical projections the legacy aliases here can be removed.
export const route_runs = [
  {
    id: 'run_2841',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: 'usr_dr_khalid',
    vehicle_id: 'veh_van_118',
    status: 'in_progress',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T08:00:00Z',
    planned_end_at: '2026-04-25T14:00:00Z',
    started_at: '2026-04-25T08:12:00Z',
    ended_at: null,
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', distance_km: 184 },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T08:12:00Z',
    // legacy aliases retained for non-dispatch consumers (see header comment).
    run_id: 'RUN-2841',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Khalid Al-Otaibi',
    vehicle: 'VAN-118',
    stops: 22,
    completed: 14,
    sla: 0.92,
    cod_total: 4820,
    risk: false,
    partner: false,
    eta: '02:18 left',
    distance_km: 184,
  },
  {
    id: 'run_2842',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: 'usr_dr_mohammed',
    vehicle_id: 'veh_van_204',
    status: 'completed',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T08:00:00Z',
    planned_end_at: '2026-04-25T13:30:00Z',
    started_at: '2026-04-25T08:05:00Z',
    ended_at: '2026-04-25T13:42:00Z',
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', distance_km: 142 },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T13:42:00Z',
    run_id: 'RUN-2842',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Mohammed Hassan',
    vehicle: 'VAN-204',
    stops: 19,
    completed: 19,
    sla: 1.0,
    cod_total: 2110,
    risk: false,
    partner: false,
    eta: 'closed',
    distance_km: 142,
  },
  {
    id: 'run_2843',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: 'usr_dr_faisal',
    vehicle_id: 'veh_bike_22',
    status: 'at_risk',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T08:30:00Z',
    planned_end_at: '2026-04-25T13:00:00Z',
    started_at: '2026-04-25T08:48:00Z',
    ended_at: null,
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', distance_km: 38, risk_note: '5 stops past promise window' },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T11:42:00Z',
    run_id: 'RUN-2843',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Faisal Al-Harbi',
    vehicle: 'BIKE-22',
    stops: 14,
    completed: 6,
    sla: 0.71,
    cod_total: 980,
    risk: true,
    partner: false,
    eta: '01:42 left',
    distance_km: 38,
    risk_note: '5 stops past promise window',
  },
  {
    id: 'run_2844',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: 'usr_dr_tariq',
    vehicle_id: 'veh_van_091',
    status: 'in_progress',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T08:00:00Z',
    planned_end_at: '2026-04-25T14:30:00Z',
    started_at: '2026-04-25T08:18:00Z',
    ended_at: null,
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', distance_km: 212 },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T11:00:00Z',
    run_id: 'RUN-2844',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Tariq Al-Mutairi',
    vehicle: 'VAN-091',
    stops: 27,
    completed: 9,
    sla: 0.85,
    cod_total: 6240,
    risk: false,
    partner: false,
    eta: '03:04 left',
    distance_km: 212,
  },
  {
    id: 'run_2845',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: null,
    vehicle_id: null,
    status: 'awaiting',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T14:00:00Z',
    planned_end_at: '2026-04-25T18:00:00Z',
    started_at: null,
    ended_at: null,
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', partner_id: 'pool_exampledepot' },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T07:30:00Z',
    run_id: 'RUN-2845',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Exampledepot · Hub-3',
    vehicle: 'partner',
    stops: 31,
    completed: 0,
    sla: null,
    cod_total: 0,
    risk: false,
    partner: true,
    eta: 'pickup 14:00',
    distance_km: null,
    partner_id: 'pool_exampledepot',
  },
  {
    id: 'run_2846',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: 'usr_dr_yousef',
    vehicle_id: 'veh_van_156',
    status: 'in_progress',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T08:00:00Z',
    planned_end_at: '2026-04-25T13:30:00Z',
    started_at: '2026-04-25T08:08:00Z',
    ended_at: null,
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', distance_km: 156 },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T11:35:00Z',
    run_id: 'RUN-2846',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Yousef Al-Shehri',
    vehicle: 'VAN-156',
    stops: 18,
    completed: 11,
    sla: 0.94,
    cod_total: 3420,
    risk: false,
    partner: false,
    eta: '01:55 left',
    distance_km: 156,
  },
  {
    id: 'run_2847',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: 'usr_dr_ahmed',
    vehicle_id: 'veh_van_077',
    status: 'at_risk',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T08:00:00Z',
    planned_end_at: '2026-04-25T15:00:00Z',
    started_at: '2026-04-25T08:22:00Z',
    ended_at: null,
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', distance_km: 198, risk_note: 'Vehicle delay · 22m late start' },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T11:10:00Z',
    run_id: 'RUN-2847',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Ahmed Bin Salem',
    vehicle: 'VAN-077',
    stops: 24,
    completed: 4,
    sla: 0.62,
    cod_total: 5180,
    risk: true,
    partner: false,
    eta: '03:48 left',
    distance_km: 198,
    risk_note: 'Vehicle delay · 22m late start',
  },
  {
    id: 'run_2848',
    organization_id: 'org_rashed',
    branch_id: 'hub_ruh_n',
    driver_user_id: null,
    vehicle_id: null,
    status: 'in_progress',
    planned_date: '2026-04-25',
    planned_start_at: '2026-04-25T08:30:00Z',
    planned_end_at: '2026-04-25T13:30:00Z',
    started_at: '2026-04-25T08:42:00Z',
    ended_at: null,
    metadata: { plan_id: 'rpl_2026_0418_ruh_n', partner_id: 'pool_examplecourier' },
    created_at: '2026-04-25T07:30:00Z',
    updated_at: '2026-04-25T10:55:00Z',
    run_id: 'RUN-2848',
    plan_id: 'rpl_2026_0418_ruh_n',
    driver: 'Examplecourier · East',
    vehicle: 'partner',
    stops: 16,
    completed: 12,
    sla: 0.88,
    cod_total: 0,
    risk: false,
    partner: true,
    eta: '02:30 left',
    distance_km: null,
    partner_id: 'pool_examplecourier',
  },
];

// W14-1 — route_stops seed shape now mirrors `public.route_stops` columns
// (organization_id, route_run_id, client_id, shipment_id, stop_kind,
// sequence_order, planned_window_*_at, metadata) per migration
// 202601231130_route_runs_foundation_v1.sql:192-219.
//
// Dropped FE-fictional fields:
//   • recipient_name → not a column; resolve via shipments.recipient_id join.
//   • district → not a column; resolve via addresses.district join.
//   • cod_amount → not a column; resolve via shipments.cod_amount join.
//   • sla_tone → computed (no canonical anchor).
//   • status → no status on route_stops (lives on parent route_run/task).
//   • conflict → computed (window/sequence conflict detection).
//   • tags → fictional.
//
// Renamed FE aliases:
//   • run_id → route_run_id (canonical FK).
//   • window_start / window_end → planned_window_start_at / planned_window_end_at.
//
// The planned_window_*_at values are full ISO timestamps so the FE can render
// localized HH:MM via `Date.toLocaleTimeString`. Per-stop COD amounts now flow
// from the canonical `shipments.cod_amount` column (the FE joins on
// `route_stops.shipment_id`).
export const route_stops = (() => {
  const out = [];
  let stopId = 0;
  // Window slot pool — gives stops varied planned windows around the run's
  // planned_start_at so the dispatch surface shows realistic time ranges.
  const WINDOW_SLOTS = [
    { startISO: '2026-04-25T11:00:00Z', endISO: '2026-04-25T13:00:00Z' },
    { startISO: '2026-04-25T13:00:00Z', endISO: '2026-04-25T15:00:00Z' },
    { startISO: '2026-04-25T15:00:00Z', endISO: '2026-04-25T17:00:00Z' },
  ];
  for (const run of route_runs) {
    for (let i = 0; i < run.stops; i++) {
      const seq = i + 1;
      const slot = WINDOW_SLOTS[i % WINDOW_SLOTS.length];
      out.push({
        id: `rs_${44000 + stopId++}`,
        organization_id: run.organization_id,
        route_run_id: run.id,
        client_id: 'client_demo',
        shipment_id: `shp_938${String(1200 + (stopId % 60)).padStart(4, '0')}`,
        stop_kind: 'delivery',
        sequence_order: seq,
        planned_window_start_at: slot.startISO,
        planned_window_end_at: slot.endISO,
        metadata: {},
        created_at: run.created_at,
        updated_at: run.updated_at,
      });
    }
  }
  return out;
})();

// OPERATIONS REAUDIT D4 (W9-4) — canonical assignment projection mirrors
// public.route_run_assignments (202604061430:49). Replaces the prior FE-only
// shape so registry-driven `useResourceList('route_run_assignments')` resolves
// against the same column shape used by the canonical RPCs (assignment_status,
// assignment_mode, driver_user_id, vehicle_id, partner JSONB, version).
export const route_run_assignments = route_runs.map((r) => ({
  id: `rra_${r.id}`,
  organization_id: 'org_rashed',
  route_run_id: r.id,
  // Legacy FE alias preserved for any downstream consumers that still read
  // `run_id` instead of `route_run_id`.
  run_id: r.id,
  assignment_status: r.partner
    ? 'assigned'
    : r.status === 'completed'
      ? 'completed'
      : r.status === 'awaiting'
        ? 'pending'
        : 'assigned',
  assignment_mode: r.partner ? 'partner_fleet' : 'internal_driver',
  driver_user_id: r.partner ? null : r.driver_user_id,
  // W14-1 — assignment vehicle_id now mirrors the run's canonical vehicle_id
  // (uuid FK to public.vehicles) instead of the synthetic `veh_<run_id>`
  // string. Partner-owned runs intentionally leave this null.
  vehicle_id: r.partner ? null : (r.vehicle_id ?? null),
  partner: r.partner ? { partner_id: r.partner_id || null, partner_name: r.driver } : null,
  assignment_version: 1,
  assigned_by_user_id: 'usr_admin_rashed',
  assigned_at: '2026-04-25T07:30:00Z',
  responded_by_user_id: null,
  acknowledged_at: null,
  accepted_at: null,
  refused_at: null,
  refusal_reason: null,
  response_notes: null,
  response_metadata: {},
  notes: null,
  metadata: {},
  created_at: '2026-04-25T07:30:00Z',
  updated_at: '2026-04-25T07:30:00Z',
  // Legacy FE field preserved for back-compat.
  assignment_kind: r.partner ? 'partner_pool' : 'internal',
}));

// OPERATIONS REAUDIT D4 (W9-4) — append-only assignment event ledger mirrors
// public.route_run_assignment_events (202604061430:173). Surfaces every
// transition (assigned, departed, handed_off, cancelled) for operator audit.
export const route_run_assignment_events = route_run_assignments.flatMap((rra) => [
  {
    id: `rrae_${rra.route_run_id}_init`,
    organization_id: rra.organization_id,
    route_run_assignment_id: rra.id,
    route_run_id: rra.route_run_id,
    assignment_version: 1,
    event_type: 'assigned',
    from_status: null,
    to_status: 'assigned',
    assignment_mode: rra.assignment_mode,
    driver_user_id: rra.driver_user_id,
    vehicle_id: rra.vehicle_id,
    partner: rra.partner,
    actor_user_id: rra.assigned_by_user_id,
    actor_system: null,
    notes: 'Initial assignment',
    payload: { source: 'dispatch_canvas' },
    idempotency_key: `init_${rra.route_run_id}_v1`,
    decision_log_id: null,
    created_at: rra.assigned_at,
  },
  ...(rra.assignment_status === 'completed'
    ? [
        {
          id: `rrae_${rra.route_run_id}_done`,
          organization_id: rra.organization_id,
          route_run_assignment_id: rra.id,
          route_run_id: rra.route_run_id,
          assignment_version: 1,
          event_type: 'completed',
          from_status: 'departed',
          to_status: 'completed',
          assignment_mode: rra.assignment_mode,
          driver_user_id: rra.driver_user_id,
          vehicle_id: rra.vehicle_id,
          partner: rra.partner,
          actor_user_id: rra.driver_user_id,
          actor_system: 'route_run_lifecycle',
          notes: 'Run wrapped',
          payload: { source: 'mobile_field_ops' },
          idempotency_key: `done_${rra.route_run_id}_v1`,
          decision_log_id: null,
          created_at: '2026-04-25T17:42:00Z',
        },
      ]
    : []),
]);

// OPERATIONS REAUDIT D4 (W9-4) — append-only stop reassignment ledger mirrors
// public.route_stop_reassignment_events (202604101715:274). Capturing operator
// drag-drop and bulk reassign events so audit + retro tooling can reconstruct
// the route execution timeline. Read-only on operator surfaces; writes flow
// through ui_execute_route_stop_reassign_v1.
export const route_stop_reassignment_events = (() => {
  const out = [];
  // Synthesize 4 illustrative reassignments across distinct (source -> target)
  // run pairs so the operator-side ledger has visible data for the audit tab.
  const pairs = [
    { stop_idx: 3,  src: 'run_2843', tgt: 'run_2841', actor: 'usr_admin_rashed', note: 'Bike capacity exceeded — re-routed to van' },
    { stop_idx: 7,  src: 'run_2847', tgt: 'run_2842', actor: 'usr_admin_rashed', note: 'Vehicle delay — load-balance to completed run' },
    { stop_idx: 12, src: 'run_2845', tgt: 'run_2848', actor: 'usr_admin_rashed', note: 'Partner fleet handoff (pool_exampledepot → pool_examplecourier)' },
    { stop_idx: 18, src: 'run_2841', tgt: 'run_2846', actor: 'usr_admin_rashed', note: 'SLA risk mitigation' },
  ];
  let i = 0;
  for (const p of pairs) {
    out.push({
      id: `rsre_${1000 + i}`,
      organization_id: 'org_rashed',
      route_stop_id: `rs_${44000 + p.stop_idx}`,
      client_id: 'client_demo',
      shipment_id: `shp_938${String(1200 + p.stop_idx).padStart(4, '0')}`,
      source_route_run_id: p.src,
      target_route_run_id: p.tgt,
      source_route_run_assignment_id: `rra_${p.src}`,
      target_route_run_assignment_id: `rra_${p.tgt}`,
      event_type: 'reassigned',
      actor_user_id: p.actor,
      actor_system: null,
      notes: p.note,
      payload: { source: 'dispatch_canvas', method: 'drag_drop' },
      idempotency_key: `dnd_${i}_v1`,
      decision_log_id: null,
      created_at: `2026-04-25T${String(10 + i).padStart(2, '0')}:24:00Z`,
    });
    i++;
  }
  return out;
})();

// Plan lifecycle metadata for Route Plans page
export const PLAN_LIFECYCLE_STAGES = [
  { id: 'draft', label: 'Draft' },
  { id: 'solved', label: 'Solved' },
  { id: 'frozen', label: 'Frozen' },
  { id: 'published', label: 'Published' },
  { id: 'applied', label: 'Applied' },
  { id: 'executing', label: 'Executing' },
];

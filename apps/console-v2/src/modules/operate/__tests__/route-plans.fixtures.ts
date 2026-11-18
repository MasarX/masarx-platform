import * as ds from '@/lib/data-source';

type ListOpts = Parameters<typeof ds.ui_list_resource_v1>[1];
type ListResult<T extends Record<string, unknown>> = { rows: T[]; total: number };

export const ROUTE_PLAN_FIXTURE_IDS = {
  alpha: 'rpl_fixture_alpha',
  beta: 'rpl_fixture_beta',
  hub: 'hub_jed',
  runAlpha: 'run_fixture_alpha',
  runBeta: 'run_fixture_beta',
  shipmentAlpha: 'shp_route_plan_stop_1',
  shipmentBeta: 'shp_route_plan_stop_2',
} as const;

const routePlanRows = [
  {
    id: ROUTE_PLAN_FIXTURE_IDS.alpha,
    organization_id: 'org_rashed',
    branch_id: ROUTE_PLAN_FIXTURE_IDS.hub,
    planned_date: '2026-05-07',
    status: 'draft',
    updated_at: '2026-05-07T08:00:00.000Z',
    metadata: { wave_label: 'Morning', wave_key: 'wave_morning' },
    inputs: { wave_id: 'wave_morning', wave_label: 'Morning' },
    solution: { stops: [] },
  },
  {
    id: ROUTE_PLAN_FIXTURE_IDS.beta,
    organization_id: 'org_rashed',
    branch_id: ROUTE_PLAN_FIXTURE_IDS.hub,
    planned_date: '2026-05-07',
    status: 'solved',
    updated_at: '2026-05-07T08:05:00.000Z',
    metadata: { wave_label: 'Afternoon', wave_key: 'wave_afternoon' },
    inputs: { wave_id: 'wave_afternoon', wave_label: 'Afternoon' },
    solution: { stops: [] },
  },
];

const routePlanDirectoryRows = [
  {
    id: ROUTE_PLAN_FIXTURE_IDS.alpha,
    organization_id: 'org_rashed',
    branch_id: ROUTE_PLAN_FIXTURE_IDS.hub,
    planned_date: '2026-05-07',
    status: 'draft',
    plan_display_id: 'RPL-FIX-A',
    branch_label: 'JED Main Hub',
    branch_code: 'JED',
    wave_label: 'Morning',
    wave_key: 'wave_morning',
    stop_count: 1,
    run_count: 1,
    drivers_notified_count: 0,
    is_applied: false,
    updated_at: '2026-05-07T08:00:00.000Z',
  },
  {
    id: ROUTE_PLAN_FIXTURE_IDS.beta,
    organization_id: 'org_rashed',
    branch_id: ROUTE_PLAN_FIXTURE_IDS.hub,
    planned_date: '2026-05-07',
    status: 'solved',
    plan_display_id: 'RPL-FIX-B',
    branch_label: 'JED Main Hub',
    branch_code: 'JED',
    wave_label: 'Afternoon',
    wave_key: 'wave_afternoon',
    stop_count: 1,
    run_count: 1,
    drivers_notified_count: 1,
    is_applied: false,
    updated_at: '2026-05-07T08:05:00.000Z',
  },
];

const hubRows = [
  { id: ROUTE_PLAN_FIXTURE_IDS.hub, code: 'JED', name: 'JED Main Hub', city: 'Jeddah', cutoff_time: '18:00' },
];

const waveCatalogRows = [
  { id: 'wave_morning', label: 'Morning', window_start: '08:00', window_end: '12:00', active: true, sort_order: 10 },
  { id: 'wave_afternoon', label: 'Afternoon', window_start: '12:00', window_end: '16:00', active: true, sort_order: 20 },
  { id: 'wave_evening', label: 'Evening', window_start: '16:00', window_end: '20:00', active: true, sort_order: 30 },
];

const routeRunRows = [
  {
    id: ROUTE_PLAN_FIXTURE_IDS.runAlpha,
    route_plan_id: ROUTE_PLAN_FIXTURE_IDS.alpha,
    metadata: { plan_id: ROUTE_PLAN_FIXTURE_IDS.alpha },
  },
  {
    id: ROUTE_PLAN_FIXTURE_IDS.runBeta,
    route_plan_id: ROUTE_PLAN_FIXTURE_IDS.beta,
    metadata: { plan_id: ROUTE_PLAN_FIXTURE_IDS.beta },
  },
];

const routeStopRows = [
  {
    id: 'stop_fixture_alpha',
    route_run_id: ROUTE_PLAN_FIXTURE_IDS.runAlpha,
    shipment_id: ROUTE_PLAN_FIXTURE_IDS.shipmentAlpha,
    sequence_order: 1,
    planned_window_start_at: '2026-05-07T08:00:00.000Z',
    planned_window_end_at: '2026-05-07T10:00:00.000Z',
  },
  {
    id: 'stop_fixture_beta',
    route_run_id: ROUTE_PLAN_FIXTURE_IDS.runBeta,
    shipment_id: ROUTE_PLAN_FIXTURE_IDS.shipmentBeta,
    sequence_order: 1,
    planned_window_start_at: '2026-05-07T12:00:00.000Z',
    planned_window_end_at: '2026-05-07T14:00:00.000Z',
  },
];

function filterById<T extends Record<string, unknown>>(rows: T[], field: string, value: unknown): T[] {
  if (value == null || value === '') return rows;
  return rows.filter((row) => row[field] === value);
}

function fixtureForResource(resource: string, opts?: ListOpts): ListResult<Record<string, unknown>> | null {
  const filter = opts?.filter ?? {};
  if (resource === 'route_plans') return { rows: routePlanRows, total: routePlanRows.length };
  if (resource === 'route_plan_directory') return { rows: routePlanDirectoryRows, total: routePlanDirectoryRows.length };
  if (resource === 'hubs') return { rows: hubRows, total: hubRows.length };
  if (resource === 'wave_catalog') return { rows: waveCatalogRows, total: waveCatalogRows.length };
  if (resource === 'route_runs') {
    const rows = filterById(routeRunRows, 'route_plan_id', filter.route_plan_id);
    return { rows, total: rows.length };
  }
  if (resource === 'route_stops') {
    const rows = filterById(routeStopRows, 'route_run_id', filter.route_run_id);
    return { rows, total: rows.length };
  }
  return null;
}

export function routePlanningListResource<T extends Record<string, unknown>>(
  resource: string,
  opts: ListOpts,
  fallback: typeof ds.ui_list_resource_v1,
): ReturnType<typeof ds.ui_list_resource_v1<T>> {
  const fixture = fixtureForResource(resource, opts);
  if (fixture) return Promise.resolve(fixture as ListResult<T>) as ReturnType<typeof ds.ui_list_resource_v1<T>>;
  return fallback<T>(resource, opts);
}

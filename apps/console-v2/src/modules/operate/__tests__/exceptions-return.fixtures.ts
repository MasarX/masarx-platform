import * as ds from '@/lib/data-source';

type CompleteOpts = Parameters<typeof ds.ui_list_resource_complete>[1];
type CompleteResult<T extends Record<string, unknown>> = { rows: T[]; total: number };

export const EXCEPTION_RETURN_FIXTURE_IDS = {
  organization: 'org_exception_return_fixture',
  task: 'tsk_exception_refused_fixture',
  shipment: 'shp_return_fixture_1',
  branch: 'br_jed_fixture',
} as const;

export const exceptionReturnOperatorIdentity = {
  capabilities: ['all'],
  scope: {
    tenant: {
      id: EXCEPTION_RETURN_FIXTURE_IDS.organization,
      label: 'Exception Return Fixture Tenant',
      rank: 2 as const,
    },
  },
};

export const exceptionTaskRows = [
  {
    id: EXCEPTION_RETURN_FIXTURE_IDS.task,
    task_id: 'TSK-NDR-FIXTURE',
    task_type: 'dispatch_exception_review',
    task_type_key: 'dispatch_exception_review',
    subject: 'Delivery refused by recipient',
    attempt_count: 2,
    sla_due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'open',
    shipment_id: EXCEPTION_RETURN_FIXTURE_IDS.shipment,
    resource_id: EXCEPTION_RETURN_FIXTURE_IDS.shipment,
    allowed_actions: ['reschedule', 'hold_at_branch', 'cancel'],
    evidence_required: false,
    metadata: {
      dispatch_exception_reason: 'recipient_refused',
      subject: 'Delivery refused by recipient',
    },
  },
];

export const returnedToBranchRows = [
  {
    id: EXCEPTION_RETURN_FIXTURE_IDS.shipment,
    tracking_number: 'RTB-FIXTURE-001',
    destination_city: 'Jeddah',
    cod_amount: 135,
    cod_currency: 'SAR',
    service_type: 'standard',
    updated_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  },
];

const taskEventRows = [
  {
    id: 'tev_exception_fixture_attempt_1',
    task_id: EXCEPTION_RETURN_FIXTURE_IDS.task,
    occurred_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    event: 'delivery_attempt_failed',
    actor: 'driver_fixture',
    notes: 'Recipient refused delivery at door.',
  },
];

const shipmentRows = [
  {
    id: EXCEPTION_RETURN_FIXTURE_IDS.shipment,
    tracking_number: 'RTB-FIXTURE-001',
    status: 'returned_to_branch',
    service_type: 'standard',
    destination_city: 'Jeddah',
    cod_amount: 135,
    cod_currency: 'SAR',
  },
];

const branchRows = [
  {
    id: EXCEPTION_RETURN_FIXTURE_IDS.branch,
    code: 'JED',
    name: 'JED Main Hub',
  },
];

function filteredRows<T extends Record<string, unknown>>(
  rows: T[],
  filter?: Record<string, unknown>,
): T[] {
  if (!filter) return rows;
  return rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => value == null || value === '' || row[key] === value),
  );
}

export function exceptionReturnCompleteResource<T extends Record<string, unknown>>(
  resource: string,
  opts: CompleteOpts,
  fallback: typeof ds.ui_list_resource_complete,
): ReturnType<typeof ds.ui_list_resource_complete<T>> {
  const filter = opts?.filter ?? {};
  if (resource === 'task_events') {
    const rows = filteredRows(taskEventRows, filter);
    return Promise.resolve({ rows, total: rows.length } as unknown as CompleteResult<T>) as ReturnType<typeof ds.ui_list_resource_complete<T>>;
  }
  if (resource === 'shipments') {
    const rows = filteredRows(shipmentRows, filter);
    return Promise.resolve({ rows, total: rows.length } as unknown as CompleteResult<T>) as ReturnType<typeof ds.ui_list_resource_complete<T>>;
  }
  return fallback<T>(resource, opts);
}

export function exceptionReturnListResource<T extends Record<string, unknown>>(
  resource: string,
  opts: Parameters<typeof ds.ui_list_resource_v1>[1],
  fallback: typeof ds.ui_list_resource_v1,
): ReturnType<typeof ds.ui_list_resource_v1<T>> {
  const filter = opts?.filter ?? {};
  if (resource === 'branches') {
    const rows = filteredRows(branchRows, filter);
    return Promise.resolve({ rows, total: rows.length } as unknown as CompleteResult<T>) as ReturnType<typeof ds.ui_list_resource_v1<T>>;
  }
  return fallback<T>(resource, opts);
}

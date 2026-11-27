import type { AmendTaskRow } from './amend-cancel';

export const AMEND_REVIEW_TASKS: AmendTaskRow[] = [
  {
    id: 'tsk_3001',
    task_id: 'TSK-3001',
    task_type: 'shipment_amend_review',
    subject: 'Amend address - SHP-9381322 - pending CS approval',
    shipment_id: 'shp_9381322',
    resource_type: 'shipment',
    resource_id: 'shp_9381322',
    assigned_to: 'usr_admin_rashed',
    queue: 'cs',
    queue_key: 'cs',
    priority: 1,
    sla_due_at: '2026-05-13T12:10:00.000Z',
    status: 'open',
    allowed_actions: ['approve', 'reject'],
    metadata: {
      subject: 'Amend address - SHP-9381322 - pending CS approval',
      requested_op: 'amend_address',
      requested_by: 'recipient',
      requested_payload: { destination_city: 'Riyadh' },
    },
  },
];

export const AMEND_OP_LOOKUPS = [
  { value: 'amend_address', label: 'Amend address', tone: 'info', rank: 10, metadata: { is_valid_op: true, backend_operation: 'address' } },
  { value: 'amend_cod', label: 'Amend COD', tone: 'info', rank: 20, metadata: { is_valid_op: true, backend_operation: 'modify' } },
  { value: 'cancel', label: 'Cancel', tone: 'danger', rank: 30, metadata: { is_valid_op: true, backend_operation: 'cancel' } },
  { value: 'reschedule', label: 'Reschedule', tone: 'warn', rank: 40, metadata: { is_valid_op: true, backend_operation: 'reschedule' } },
];

export const TASK_ACTION_KIND_LOOKUPS = [
  { value: 'approve', label: 'Approve', tone: 'good', rank: 10, next_status: 'completed', metadata: { next_status: 'completed' } },
  { value: 'reject', label: 'Reject', tone: 'danger', rank: 20, next_status: 'rejected', metadata: { next_status: 'rejected' } },
];

export function amendOpLookup(value: string) {
  return AMEND_OP_LOOKUPS.find((row) => row.value === value) ?? null;
}

export function taskActionKindLookup(value: string) {
  return TASK_ACTION_KIND_LOOKUPS.find((row) => row.value === value) ?? null;
}

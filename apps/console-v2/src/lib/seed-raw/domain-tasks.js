// domain-tasks.js — tasks SSOT, task_type_catalog, task_events, NDR sample
// AGENTS.md line 37: queue/SLA/owner defaults from task_type_catalog + assignment_defaults.
//
// W16-1 — `public.tasks` canonical projection per migration
// 202601212300_tasks_ssot_core.sql:362-390 + ui_read_registry projection
// 202602041430_ui_read_registry_tasks_v1.sql:16-53. Canonical columns:
// `id, organization_id, client_id, sender_id, task_type_id, resource_type,
// resource_id, status, status_reason, priority, queue_key, assigned_to,
// assigned_at, sla_minutes, sla_due_at, started_at, completed_at,
// canceled_at, workflow_run_id, idempotency_key, version, metadata,
// created_at, updated_at`.
//
// FE-only aliases retained on the seed for back-compat with non-task-row
// consumers (e.g. amend-cancel renders `task_id`, exceptions reads
// `task_type`/`subject`/`allowed_actions`/`evidence_required`/`attempt_count`):
//   - `task_id` → alias for canonical `id` (REMOVE deferred to G1; see
//     `__audit__/SCHEMA-DRIFT/OPERATIONS.md` §4 row 89).
//   - `task_type` → alias for canonical `task_type_id` + lookup
//     `task_type_catalog.task_type` (RENAME deferred to G1; registry
//     projection extension required to expose `task_type_key`).
//   - `subject` → projection from `metadata.subject` (REMOVE deferred to G1).
//   - `shipment_id` → alias when `resource_type='shipment' AND resource_id`
//     (RENAME deferred to G1).
//   - `queue` → alias for canonical `queue_key` (RENAME deferred to G1).
//   - `allowed_actions` → policy-derived (REMOVE deferred to G1; resolves
//     via `task_type_catalog.allowed_actions` or `ndr_policy.allowed_actions`).
//   - `evidence_required` → policy-derived (REMOVE deferred to G1).
//   - `attempt_count` → derived (REMOVE deferred to G1; computed from
//     `task_events`).
//
// Canonical fields populated for every row to keep the seed swap-ready:
// `id, status, priority, queue_key, sla_due_at, resource_type, resource_id,
// metadata`. The aliases above mirror the canonical projection so a single
// registry projection swap will eliminate them in G1.

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();

// W34c — `default_actions` added to each catalog row. SSOT mirror of
// `public.task_type_catalog.assignment_defaults.allowed_actions` (jsonb).
// The review-queue's `resolveAllowedActions` reads from this projection
// via `resolve_task_type_default_actions_v1(task_type)` instead of the
// previous inline `TASK_TYPE_DEFAULT_ACTIONS` Record literal in
// `_review-queue/views.ts` (which violated AGENTS.md §2 ZERO HARDCODING).
export const task_type_catalog = [
  { task_type: 'manual_review', queue: 'general', default_sla_minutes: 60, escalate_after_minutes: 120, default_actions: ['approve', 'decline', 'escalate'] },
  { task_type: 'dispatch_exception_review', queue: 'ndr', default_sla_minutes: 30, escalate_after_minutes: 60, default_assignee_role: 'ops_supervisor', default_actions: ['reschedule', 'reassign', 'rtb', 'resolve'] },
  { task_type: 'route_stop_execute', queue: 'driver', default_sla_minutes: null, escalate_after_minutes: null, default_actions: [] },
  { task_type: 'warehouse_supervisor_approval', queue: 'warehouse', default_sla_minutes: 15, escalate_after_minutes: 30, default_actions: ['approve', 'reject'] },
  { task_type: 'warehouse_scan_supervisor_approval', queue: 'warehouse', default_sla_minutes: 10, escalate_after_minutes: 20, default_actions: ['approve', 'reject'] },
  { task_type: 'warehouse_transfer_pack', queue: 'warehouse', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['resolve'] },
  { task_type: 'warehouse_transfer_dispatch', queue: 'warehouse', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['resolve'] },
  { task_type: 'warehouse_transfer_receive', queue: 'warehouse', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['resolve'] },
  { task_type: 'warehouse_transfer_reconcile', queue: 'warehouse', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['resolve'] },
  { task_type: 'shipment_amend_review', queue: 'cs', default_sla_minutes: 45, escalate_after_minutes: 90, default_actions: ['approve', 'reject'] },
  { task_type: 'tenant_signup_review', queue: 'admin', default_sla_minutes: 480, escalate_after_minutes: 1440, default_actions: ['approve', 'request_info', 'reject'] },
  { task_type: 'cod_cash_handover', queue: 'finance', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['record_handover'] },
  { task_type: 'cod_cashier_count', queue: 'finance', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['record_cashier_count'] },
  { task_type: 'cod_manager_approval', queue: 'finance', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['approve', 'reject'] },
  { task_type: 'bank_deposit_slip_create', queue: 'finance', default_sla_minutes: 30, escalate_after_minutes: 60, default_actions: ['record_deposit_slip'] },
];

const codDriverHandoverSchema = {
  action_kind: 'record_handover',
  next_status: 'completed',
  title: 'Record driver COD handover',
  description: 'Enter the cash amount handed over for this driver-shift settlement.',
  submit_label: 'Record handover',
  requires_session_type: 'driver_shift',
  fields: [
    { key: 'amount', label: 'Cash amount', type: 'number', required: true, min: 0, step: '0.01', default_from: 'settlement.expected_amount' },
    { key: 'currency', label: 'Currency', type: 'text', required: true, default_value: 'SAR' },
    { key: 'receipt_context', label: 'Receipt or bag reference', type: 'text', required: false },
  ],
};

const bankDepositSlipSchema = {
  action_kind: 'record_deposit_slip',
  next_status: 'completed',
  title: 'Record bank deposit slip',
  description: 'Enter the bank deposit slip details for this settlement batch.',
  submit_label: 'Record deposit slip',
  requires_session_type: 'branch_cash_drawer',
  fields: [
    { key: 'amount', label: 'Deposit amount', type: 'number', required: true, min: 0, step: '0.01', default_from: 'settlement.expected_amount' },
    { key: 'currency', label: 'Currency', type: 'text', required: true, default_value: 'SAR' },
    { key: 'deposit_slip_ref', label: 'Deposit slip reference', type: 'text', required: true },
    { key: 'notes', label: 'Notes', type: 'textarea', required: false },
  ],
};

export const tasks = [
  // NDR (dispatch_exception_review) — 6 open
  // W54-C closure — fixtures now carry canonical `metadata.dispatch_exception_reason`.
  // Subject-substring inference removed from operate/exceptions.tsx; the
  // FE strictly reads metadata.dispatch_exception_reason and renders a
  // `(metadata missing)` chip when the row lacks the canonical key.
  { id: 'tsk_2901', task_id: 'TSK-2901', task_type: 'dispatch_exception_review', subject: 'SHP-9381301 · Recipient unavailable (3rd attempt)', shipment_id: 'shp_9381301', resource_type: 'shipment', resource_id: 'shp_9381301', assigned_to: 'usr_admin_rashed', queue: 'ndr', queue_key: 'ndr', priority: 1, sla_due_at: minutesAgo(-15), status: 'open', allowed_actions: ['retry', 'reschedule', 'hold_at_branch', 'cancel'], evidence_required: true, attempt_count: 3, metadata: { subject: 'SHP-9381301 · Recipient unavailable (3rd attempt)', attempt_count: 3, dispatch_exception_reason: 'recipient_unavailable' } },
  { id: 'tsk_2902', task_id: 'TSK-2902', task_type: 'dispatch_exception_review', subject: 'SHP-9381247 · Address ambiguous · district mismatch', shipment_id: 'shp_9381247', resource_type: 'shipment', resource_id: 'shp_9381247', assigned_to: null, queue: 'ndr', queue_key: 'ndr', priority: 1, sla_due_at: minutesAgo(20), status: 'open', allowed_actions: ['reschedule', 'cancel'], evidence_required: true, attempt_count: 1, metadata: { subject: 'SHP-9381247 · Address ambiguous · district mismatch', attempt_count: 1, dispatch_exception_reason: 'address_or_zone_issue' } },
  { id: 'tsk_2903', task_id: 'TSK-2903', task_type: 'dispatch_exception_review', subject: 'SHP-9381418 · COD discrepancy · -180 SAR', shipment_id: 'shp_9381418', resource_type: 'shipment', resource_id: 'shp_9381418', assigned_to: 'usr_admin_rashed', queue: 'ndr', queue_key: 'ndr', priority: 1, sla_due_at: minutesAgo(-30), status: 'in_progress', allowed_actions: ['reschedule', 'cancel'], evidence_required: true, attempt_count: 1, metadata: { subject: 'SHP-9381418 · COD discrepancy · -180 SAR', attempt_count: 1, dispatch_exception_reason: 'cod_discrepancy' } },
  { id: 'tsk_2904', task_id: 'TSK-2904', task_type: 'dispatch_exception_review', subject: 'SHP-9381502 · Receipient refused · damaged goods', shipment_id: 'shp_9381502', resource_type: 'shipment', resource_id: 'shp_9381502', assigned_to: null, queue: 'ndr', queue_key: 'ndr', priority: 1, sla_due_at: minutesAgo(8), status: 'open', allowed_actions: ['hold_at_branch', 'cancel'], evidence_required: true, attempt_count: 1, metadata: { subject: 'SHP-9381502 · Receipient refused · damaged goods', attempt_count: 1, dispatch_exception_reason: 'recipient_refused_or_damaged' } },
  { id: 'tsk_2905', task_id: 'TSK-2905', task_type: 'dispatch_exception_review', subject: 'SHP-9381611 · Out of zone', shipment_id: 'shp_9381611', resource_type: 'shipment', resource_id: 'shp_9381611', assigned_to: null, queue: 'ndr', queue_key: 'ndr', priority: 1, sla_due_at: minutesAgo(-50), status: 'open', allowed_actions: ['retry', 'reschedule'], evidence_required: false, attempt_count: 0, metadata: { subject: 'SHP-9381611 · Out of zone', attempt_count: 0, dispatch_exception_reason: 'address_or_zone_issue' } },
  { id: 'tsk_2906', task_id: 'TSK-2906', task_type: 'dispatch_exception_review', subject: 'SHP-9381201 · Failed delivery · 4th attempt', shipment_id: 'shp_9381201', resource_type: 'shipment', resource_id: 'shp_9381201', assigned_to: null, queue: 'ndr', queue_key: 'ndr', priority: 0, sla_due_at: minutesAgo(60), status: 'escalated', allowed_actions: ['hold_at_branch'], evidence_required: true, attempt_count: 4, metadata: { subject: 'SHP-9381201 · Failed delivery · 4th attempt', attempt_count: 4, dispatch_exception_reason: 'recipient_unavailable' } },

  // Route stop execution closeout (Console supervision path)
  { id: 'tsk_route_stop_44000', task_id: 'TSK-RS-44000', task_type: 'route_stop_execute', subject: 'SHP-9381201 - route stop execution', shipment_id: 'shp_9381201', resource_type: 'route_stop', resource_id: 'rs_44000', assigned_to: 'usr_dr_khalid', queue: 'driver', queue_key: 'driver', priority: 1, sla_due_at: minutesAgo(120), status: 'in_progress', allowed_actions: ['resolve'], metadata: { subject: 'SHP-9381201 - route stop execution', route_stop_id: 'rs_44000', shipment_id: 'shp_9381201' } },
  { id: 'tsk_cod_handover_4521', task_id: 'TSK-COD-4521', task_type: 'cod_cash_handover', subject: 'COD driver cash handover', resource_type: 'settlement_batch', resource_id: 'sb_4521', assigned_to: null, queue: 'finance', queue_key: 'finance', priority: 1, sla_due_at: minutesAgo(-20), status: 'open', allowed_actions: ['record_handover'], metadata: { subject: 'COD driver cash handover', parent_workflow_run_id: 'wfr_cod_4521', allowed_actions: ['record_handover'], completion_payload_schema: codDriverHandoverSchema } },
  { id: 'tsk_cod_manager_4521', task_id: 'TSK-CODMGR-4521', task_type: 'cod_manager_approval', subject: 'COD manager approval', resource_type: 'settlement_batch', resource_id: 'sb_4521', assigned_to: null, queue: 'finance', queue_key: 'finance', priority: 1, sla_due_at: minutesAgo(-22), status: 'open', allowed_actions: ['approve', 'reject'], metadata: { subject: 'COD manager approval', description: 'Review the COD variance decision and approve or reject the settlement closeout.', parent_workflow_run_id: 'wfr_cod_4521', allowed_actions: ['approve', 'reject'] } },
  { id: 'tsk_bank_deposit_5700', task_id: 'TSK-BANK-5700', task_type: 'bank_deposit_slip_create', subject: 'Bank deposit slip', resource_type: 'settlement_batch', resource_id: 'sb_bank_5700', assigned_to: null, queue: 'finance', queue_key: 'finance', priority: 1, sla_due_at: minutesAgo(-18), status: 'open', allowed_actions: ['record_deposit_slip'], metadata: { subject: 'Bank deposit slip', parent_workflow_run_id: 'wfr_bank_deposit_5700', allowed_actions: ['record_deposit_slip'], completion_payload_schema: bankDepositSlipSchema } },

  // Manual review
  // CLAIM-OPERATIONS-WIRING (Phase C1) — `metadata.requested_op` is the
  // canonical seam (per __audit__/CROSSWALK/OPERATIONS.md gap row for
  // amend-cancel.tsx). FE uses metadata.requested_op now (no subject parsing).
  { id: 'tsk_3001', task_id: 'TSK-3001', task_type: 'shipment_amend_review', subject: 'Amend address · SHP-9381322 · pending CS approval', shipment_id: 'shp_9381322', resource_type: 'shipment', resource_id: 'shp_9381322', assigned_to: 'usr_admin_rashed', queue: 'cs', queue_key: 'cs', priority: 1, sla_due_at: minutesAgo(-10), status: 'open', allowed_actions: ['approve', 'reject'], metadata: { subject: 'Amend address · SHP-9381322 · pending CS approval', requested_op: 'amend_address', requested_by: 'recipient', requested_payload: { destination_city: 'Riyadh' } } },
  { id: 'tsk_3002', task_id: 'TSK-3002', task_type: 'manual_review', subject: 'Customer change request · contact escalation', assigned_to: null, queue: 'general', queue_key: 'general', priority: 2, sla_due_at: minutesAgo(-25), status: 'open', metadata: { subject: 'Customer change request · contact escalation' } },
  { id: 'tsk_3003', task_id: 'TSK-3003', task_type: 'tenant_signup_review', subject: 'Riyadh Express LLC · KYC docs review', assigned_to: 'usr_admin_rashed', queue: 'admin', queue_key: 'admin', priority: 2, sla_due_at: minutesAgo(-200), status: 'open', metadata: { subject: 'Riyadh Express LLC · KYC docs review' } },

  // Warehouse
  { id: 'tsk_4001', task_id: 'TSK-4001', task_type: 'warehouse_supervisor_approval', task_type_key: 'warehouse_supervisor_approval', subject: 'WTR-2026-0481 · variance 3% · approve receive', resource_type: 'warehouse_transfer', resource_id: 'wtr_2026_0481', assigned_to: null, queue: 'warehouse', queue_key: 'warehouse', priority: 1, sla_due_at: minutesAgo(-5), status: 'open', metadata: { subject: 'WTR-2026-0481 · variance 3% · approve receive', resource_id: 'wtr_2026_0481', task_type_key: 'warehouse_supervisor_approval', hold_reason: '4 missing items · 2.8% variance · awaiting recount' } },
  { id: 'tsk_4002', task_id: 'TSK-4002', task_type: 'warehouse_scan_supervisor_approval', subject: 'Out-of-sequence checkpoint scan correction · BIN-77', assigned_to: null, queue: 'warehouse', queue_key: 'warehouse', priority: 1, sla_due_at: minutesAgo(-2), status: 'open', metadata: { subject: 'Out-of-sequence checkpoint scan correction · BIN-77' } },
  { id: 'tsk_wh_reconcile_0479', task_id: 'TSK-WH-RECONCILE-0479', task_type: 'warehouse_transfer_reconcile', task_type_key: 'warehouse_transfer_reconcile', subject: 'WTR-2026-0479 - reconcile destination', resource_type: 'warehouse_transfer', resource_id: 'wtr_2026_0479', workflow_run_id: 'wfr_wh_0479', assigned_to: null, queue: 'warehouse', queue_key: 'warehouse', priority: 1, sla_due_at: minutesAgo(-4), status: 'in_progress', allowed_actions: ['resolve'], metadata: { subject: 'WTR-2026-0479 - reconcile destination', parent_workflow_run_id: 'wfr_wh_0479', task_type_key: 'warehouse_transfer_reconcile' } },
  { id: 'tsk_wh_dispatch_0476', task_id: 'TSK-WH-DISPATCH-0476', task_type: 'warehouse_transfer_dispatch', task_type_key: 'warehouse_transfer_dispatch', subject: 'WTR-2026-0476 - scan departure', resource_type: 'warehouse_transfer', resource_id: 'wtr_2026_0476', workflow_run_id: 'wfr_wh_0476', assigned_to: null, queue: 'warehouse', queue_key: 'warehouse', priority: 1, sla_due_at: minutesAgo(-3), status: 'open', allowed_actions: ['resolve'], metadata: { subject: 'WTR-2026-0476 - scan departure', parent_workflow_run_id: 'wfr_wh_0476', task_type_key: 'warehouse_transfer_dispatch' } },
  { id: 'tsk_wh_pack_0475', task_id: 'TSK-WH-PACK-0475', task_type: 'warehouse_transfer_pack', task_type_key: 'warehouse_transfer_pack', subject: 'WTR-2026-0475 - pack transfer', resource_type: 'warehouse_transfer', resource_id: 'wtr_2026_0475', workflow_run_id: 'wfr_wh_0475', assigned_to: null, queue: 'warehouse', queue_key: 'warehouse', priority: 1, sla_due_at: minutesAgo(-2), status: 'open', allowed_actions: ['resolve'], metadata: { subject: 'WTR-2026-0475 - pack transfer', parent_workflow_run_id: 'wfr_wh_0475', task_type_key: 'warehouse_transfer_pack' } },
];

export const task_events = [
  { id: 'tev_9901', task_id: 'tsk_2901', occurred_at: minutesAgo(45), event: 'created', actor: 'system' },
  { id: 'tev_9902', task_id: 'tsk_2901', occurred_at: minutesAgo(20), event: 'assigned', actor: 'usr_admin_rashed' },
  { id: 'tev_9903', task_id: 'tsk_2903', occurred_at: minutesAgo(60), event: 'created', actor: 'system' },
  { id: 'tev_9904', task_id: 'tsk_2903', occurred_at: minutesAgo(15), event: 'in_progress', actor: 'usr_admin_rashed', notes: 'Calling driver to verify cash count' },
];

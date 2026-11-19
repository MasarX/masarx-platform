// workflows.js — workflow_templates, workflow_runs, workflow_run_steps, mapping_configs (event_extraction), bindings
// Anchored: AGENTS.md lines 11-13 (workflow-engine SSOT, progress_workflow_run canonical entrypoint).

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();

// W34c — `template_key` + `canonical_uuid` added to every workflow_templates
// row so finance/cod.tsx + finance/bank-recon.tsx can resolve a canonical
// workflow id through `resolve_workflow_template_id_v1(template_key)`
// instead of inlining cloud-side UUID literals (`99990000-...-570002`,
// `99990000-...-570004`, etc.). Mirrors `public.workflow_templates.template_key`
// + canonical `id` UUID. The FE seam returns `id` (workspace seed id)
// in demo mode and the cloud UUID in live mode — module call sites stay
// stable.
export const workflow_templates = [
  { id: 'tpl_intake_exampleparcel', template_id: 'TPL-INTAKE-EXAMPLEMARKET-V3', template_key: 'exampleparcel_ksa_inbound_intake_v3', canonical_uuid: '99990000-0000-0000-0000-000000570001', name: 'Exampleparcel KSA inbound intake', version: 'v3.4.1', status: 'active', trigger: 'webhook.shipment.created', updated_at: '2026-04-22T10:00:00Z', author: 'ops-lead@masarx', versions: ['v3.4.1','v3.4.0','v3.3.0','v3.2.0','v3.1.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Webhook in', sub: 'JSON · signed', op: 'webhook.receive', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'transform', label: 'Field map', sub: 'exampleparcel_ksa_v3.shipment_inbound', op: 'mapping.apply', icon: 'shuffle', branch: 'main' },
    { id: 'st_3', kind: 'guard', label: 'Validate', sub: 'schema_registry: shipment.v6', op: 'schema.validate', icon: 'check', branch: 'main', error_path: 'st_err' },
    { id: 'st_4', kind: 'action', label: 'Create shipment', sub: 'shipments.create', op: 'shipments.create_v1', icon: 'package', branch: 'main' },
    { id: 'st_5', kind: 'action', label: 'Notify recipient', sub: 'comms_scheduling · whatsapp', op: 'comms.notify', icon: 'bell', branch: 'main' },
    { id: 'st_6', kind: 'action', label: 'Acknowledge sender', sub: 'webhook reply', op: 'webhook.respond', icon: 'check', branch: 'main' },
    { id: 'st_err', kind: 'error', label: 'Reject + log', sub: 'decision_log · validation_failed', op: 'decision.log', icon: 'warn', branch: 'error' },
  ]},
  { id: 'tpl_ndr_resolution', template_id: 'TPL-NDR-RES-V2', template_key: 'ndr_resolution_v2', canonical_uuid: '99990000-0000-0000-0000-000000570003', name: 'NDR resolution workflow', version: 'v2.1.0', status: 'active', trigger: 'task.dispatch_exception_review.resolved', updated_at: '2026-04-18T08:30:00Z', author: 'ops-lead@masarx', versions: ['v2.1.0','v2.0.0','v1.9.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Task resolved', sub: 'task.dispatch_exception_review', op: 'task.transition', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'transform', label: 'Resolve resolution policy', sub: 'ndr_policy', op: 'policy.resolve', icon: 'shuffle', branch: 'main' },
    { id: 'st_3', kind: 'guard', label: 'Preview impact', sub: 'preview_dispatch_exception_resolution_v1', op: 'rpc.call', icon: 'eye', branch: 'main' },
    { id: 'st_4', kind: 'action', label: 'Apply resolution', sub: 'apply_dispatch_exception_resolution_v1', op: 'rpc.call', icon: 'check', branch: 'main' },
    { id: 'st_5', kind: 'action', label: 'Emit decision_log', sub: 'category=ndr_resolution', op: 'decision.log', icon: 'audit', branch: 'main' },
  ]},
  { id: 'tpl_cod_settlement', template_id: 'TPL-COD-SETTLE-V2', template_key: 'cod_driver_shift_settlement_v2', canonical_uuid: '99990000-0000-0000-0000-000000570002', name: 'COD driver shift settlement', version: 'v2.0.0', status: 'active', trigger: 'shift.closed', updated_at: '2026-04-12T13:20:00Z', author: 'finance-lead@masarx', versions: ['v2.0.0','v1.5.0','v1.0.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Shift closed', sub: 'shift.closed event', op: 'event.consume', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'transform', label: 'Compute expected', sub: 'compute_cod_payment_collection_summary_v1', op: 'rpc.call', icon: 'wallet', branch: 'main' },
    { id: 'st_3', kind: 'guard', label: 'Variance gate', sub: 'execute_variance_gate_v3', op: 'workflow_handlers.run', icon: 'shield', branch: 'main', error_path: 'st_var' },
    { id: 'st_4', kind: 'action', label: 'Open settlement_batch', sub: 'kind=cod · status=open', op: 'rpc.call', icon: 'package', branch: 'main' },
    { id: 'st_5', kind: 'action', label: 'Lock + post', sub: 'execute_settlement_batch_v1', op: 'workflow_handlers.run', icon: 'check', branch: 'main' },
    { id: 'st_var', kind: 'manual', label: 'Manual review', sub: 'task_type=variance_review', op: 'task.create', icon: 'flag', branch: 'manual' },
  ]},
  { id: 'tpl_route_publish', template_id: 'TPL-ROUTE-PUB-V1', template_key: 'route_plan_publish_v1', canonical_uuid: '99990000-0000-0000-0000-000000570005', name: 'Route plan publish', version: 'v1.4.2', status: 'active', trigger: 'route_plans.publish', updated_at: '2026-04-20T11:00:00Z', author: 'ops-lead@masarx', versions: ['v1.4.2','v1.4.1','v1.4.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Publish requested', sub: 'route_plans.publish', op: 'command.execute', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'guard', label: 'Validate constraints', sub: 'route_plan_validate_constraints_v1', op: 'rpc.call', icon: 'check', branch: 'main' },
    { id: 'st_3', kind: 'transform', label: 'Solve sequence', sub: 'solve_route_plan_v1', op: 'rpc.call', icon: 'shuffle', branch: 'main' },
    { id: 'st_4', kind: 'action', label: 'Freeze plan', sub: 'freeze_route_plan_v1', op: 'rpc.call', icon: 'lock', branch: 'main' },
    { id: 'st_5', kind: 'action', label: 'Apply to runs', sub: 'apply_route_plan_v1', op: 'rpc.call', icon: 'package', branch: 'main' },
  ]},
  { id: 'tpl_warehouse_xfer', template_id: 'TPL-WHS-XFER-V1', template_key: 'warehouse_transfer_execute_v1', canonical_uuid: '99990000-0000-0000-0000-000000570006', name: 'Warehouse transfer execute', version: 'v1.2.0', status: 'active', trigger: 'warehouse.transfer.execute', updated_at: '2026-04-15T09:00:00Z', author: 'whs-lead@masarx', versions: ['v1.2.0','v1.1.0','v1.0.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Transfer execute', sub: 'warehouse.transfer.execute', op: 'command.execute', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'guard', label: 'Scan sequence check', sub: 'scan_policy.warehouse_checkpoint', op: 'policy.resolve', icon: 'check', branch: 'main' },
    { id: 'st_3', kind: 'action', label: 'Move items', sub: 'warehouse_transfer_items', op: 'rpc.call', icon: 'package', branch: 'main' },
    { id: 'st_4', kind: 'guard', label: 'Reconcile', sub: 'item_count vs receive_count', op: 'rpc.call', icon: 'shield', branch: 'main', error_path: 'st_hold' },
    { id: 'st_5', kind: 'action', label: 'Mark received', sub: 'transition_warehouse_transfer_v1', op: 'rpc.call', icon: 'check', branch: 'main' },
    { id: 'st_hold', kind: 'manual', label: 'Exception hold', sub: 'warehouse_exception_hold', op: 'task.create', icon: 'flag', branch: 'manual' },
  ]},
  { id: 'tpl_amend_cancel', template_id: 'TPL-AMEND-CXL-V1', template_key: 'shipment_amend_cancel_v1', canonical_uuid: '99990000-0000-0000-0000-000000570007', name: 'Shipment amend & cancel', version: 'v1.3.0', status: 'active', trigger: 'shipment.amend_cancel', updated_at: '2026-04-19T16:30:00Z', author: 'ops-lead@masarx', versions: ['v1.3.0','v1.2.0','v1.1.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Amend requested', sub: 'shipment.amend_cancel', op: 'command.execute', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'transform', label: 'Resolve policy', sub: 'shipment_operation_policy', op: 'policy.resolve', icon: 'shuffle', branch: 'main' },
    { id: 'st_3', kind: 'guard', label: 'Lock state', sub: 'shipment.is_amendable', op: 'rpc.call', icon: 'lock', branch: 'main' },
    { id: 'st_4', kind: 'action', label: 'Apply mutations', sub: 'shipment_amend_cancel_v1', op: 'rpc.call', icon: 'package', branch: 'main' },
    { id: 'st_5', kind: 'action', label: 'Emit shipment.amended', sub: 'domain_events', op: 'event.emit', icon: 'check', branch: 'main' },
  ]},
  // Operator-initiated shipment creation. Same canonical entrypoint as the
  // intake template (start_workflow_run -> progress_workflow_run) but trigger
  // is `shipments.create` so the Create-shipment composer in
  // /operate/shipments has a dedicated lineage on the workflow_runs surface.
  // Anchored: AGENTS.md lines 11-13 (workflow-engine SSOT) + the create
  // composer help text in apps/console-v2/src/modules/operate/shipments.tsx.
  // W34c — bank deposit reconciliation template registered so finance/bank-recon.tsx
  // can resolve it through `resolve_workflow_template_id_v1('bank_deposit_reconciliation_v2')`.
  // Mirrors `public.workflow_templates` row keyed by template_key.
  { id: 'tpl_bank_deposit_recon', template_id: 'TPL-BANK-RECON-V2', template_key: 'bank_deposit_reconciliation_v2', canonical_uuid: '99990000-0000-0000-0000-000000570004', name: 'Bank deposit reconciliation', version: 'v2.0.0', status: 'active', trigger: 'finance.bank_recon.start', updated_at: '2026-04-22T08:00:00Z', author: 'finance-lead@masarx', versions: ['v2.0.0','v1.4.0','v1.0.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Recon requested', sub: 'bank_account_id payload', op: 'command.execute', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'transform', label: 'Pull statement window', sub: 'bank_statement_lines', op: 'rpc.call', icon: 'shuffle', branch: 'main' },
    { id: 'st_3', kind: 'guard', label: 'Match + variance', sub: 'execute_variance_gate_v3', op: 'workflow_handlers.run', icon: 'shield', branch: 'main', error_path: 'st_var' },
    { id: 'st_4', kind: 'action', label: 'Post to ledger', sub: 'execute_settlement_batch_v1', op: 'workflow_handlers.run', icon: 'check', branch: 'main' },
    { id: 'st_var', kind: 'manual', label: 'Manual review', sub: 'task_type=variance_review', op: 'task.create', icon: 'flag', branch: 'manual' },
  ]},
  { id: 'tpl_create_shipment', template_id: 'TPL-SHP-CREATE-V1', template_key: 'shipment_operator_create_v1', canonical_uuid: '99990000-0000-0000-0000-000000570008', name: 'Operator-initiated shipment creation', version: 'v1.0.0', status: 'active', trigger: 'shipments.create', updated_at: '2026-04-25T08:00:00Z', author: 'ops-lead@masarx', versions: ['v1.0.0'], steps: [
    { id: 'st_1', kind: 'trigger', label: 'Operator submit', sub: 'shipments.create command', op: 'command.execute', icon: 'inbox', branch: 'main' },
    { id: 'st_2', kind: 'guard', label: 'Validate shipment', sub: 'schema_registry: shipment.v6 + ladder constraints', op: 'schema.validate', icon: 'check', branch: 'main', error_path: 'st_err' },
    { id: 'st_3', kind: 'action', label: 'Create shipment record', sub: 'shipments.create_v1', op: 'shipments.create_v1', icon: 'package', branch: 'main' },
    { id: 'st_4', kind: 'action', label: 'Assign to first-mile', sub: 'route_assignment_policy', op: 'policy.resolve', icon: 'pin', branch: 'main' },
    { id: 'st_5', kind: 'action', label: 'Notify client', sub: 'comms_scheduling · webhook ack', op: 'comms.notify', icon: 'bell', branch: 'main' },
    { id: 'st_err', kind: 'error', label: 'Reject + log', sub: 'decision_log · validation_failed', op: 'decision.log', icon: 'warn', branch: 'error' },
  ]},
];

// Sample inbound events for "Recent events tester" panel
export const recent_workflow_events = [
  { id: 'evt_8821', event: 'webhook.shipment.created', received_at: minutesAgo(0), payload: { sender: 'exampleparcel_ksa', tracking_number: 'EXAMPLEMARKET-99281', cod: 0 }, matched_template: 'tpl_intake_exampleparcel' },
  { id: 'evt_8820', event: 'task.dispatch_exception_review.resolved', received_at: minutesAgo(2), payload: { task_id: 'tsk_2901', resolution: 'reschedule' }, matched_template: 'tpl_ndr_resolution' },
  { id: 'evt_8819', event: 'shipment.amend_cancel', received_at: minutesAgo(3), payload: { shipment_id: 'shp_9381418', op: 'cancel' }, matched_template: 'tpl_amend_cancel' },
  { id: 'evt_8818', event: 'shift.closed', received_at: minutesAgo(310), payload: { driver_id: 'drv_311', shift_date: '2026-04-25' }, matched_template: 'tpl_cod_settlement' },
  { id: 'evt_8817', event: 'route_plans.publish', received_at: minutesAgo(312), payload: { plan_id: 'plan_42', branch: 'rh_jed' }, matched_template: 'tpl_route_publish' },
  { id: 'evt_8816', event: 'warehouse.transfer.execute', received_at: minutesAgo(330), payload: { transfer_id: 'whx_88', items: 24 }, matched_template: 'tpl_warehouse_xfer' },
];

export const workflow_runs = [
  { id: 'wfr_3221', run_id: 'WFR-3221', template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', started_at: minutesAgo(0), completed_at: null, duration_ms: null, status: 'running', correlation_id: 'cor_9821', triggered_by: 'webhook.shipment.created' },
  { id: 'wfr_3220', run_id: 'WFR-3220', template_id: 'tpl_amend_cancel', template_name: 'Shipment amend & cancel', started_at: minutesAgo(2), completed_at: minutesAgo(2), duration_ms: 1820, status: 'succeeded', correlation_id: 'cor_9819', triggered_by: 'shipments.amend' },
  { id: 'wfr_3219', run_id: 'WFR-3219', template_id: 'tpl_ndr_resolution', template_name: 'NDR resolution workflow', started_at: minutesAgo(4), completed_at: minutesAgo(4), duration_ms: 940, status: 'succeeded', correlation_id: 'cor_9817', triggered_by: 'task.resolved' },
  { id: 'wfr_3218', run_id: 'WFR-3218', template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', started_at: minutesAgo(6), completed_at: minutesAgo(6), duration_ms: 720, status: 'succeeded', correlation_id: 'cor_9815', triggered_by: 'webhook.shipment.created' },
  { id: 'wfr_3217', run_id: 'WFR-3217', template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', started_at: minutesAgo(7), completed_at: minutesAgo(7), duration_ms: 9210, status: 'failed', correlation_id: 'cor_9814', triggered_by: 'webhook.shipment.created', error: 'schema_registry validation failed: shipment.v6.address.country missing' },
  { id: 'wfr_3216', run_id: 'WFR-3216', template_id: 'tpl_route_publish', template_name: 'Route plan publish', started_at: minutesAgo(308), completed_at: minutesAgo(307), duration_ms: 4220, status: 'succeeded', correlation_id: 'cor_9712', triggered_by: 'route_plans.publish' },
  { id: 'wfr_3215', run_id: 'WFR-3215', template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', started_at: minutesAgo(11), completed_at: minutesAgo(11), duration_ms: 690, status: 'succeeded', correlation_id: 'cor_9810' },
  { id: 'wfr_bank_deposit_5700', run_id: 'WFR-BANK-5700', template_id: '99990000-0000-0000-0000-000000570004', template_name: 'bank_deposit_reconciliation_v2', started_at: minutesAgo(18), completed_at: null, duration_ms: null, status: 'running', correlation_id: 'cor_bank_5700', triggered_by: 'manual' },
];

export const workflow_run_steps = {
  wfr_3220: [
    // W35c-1 — `decision_log_id` is the canonical workflow_run_steps column
    // per supabase/migrations/202510110005_*.sql:336. Seeding it here so the FE
    // canonical-first read at runs.tsx (Decision trail deep-link) has data to
    // render against. Older seed rows that only carry `metadata.decision_log_id`
    // are still supported via the metadata fallback in the read path.
    { id: 'wfs_1', step_id: 'st_1', label: 'Validate operation policy', status: 'succeeded', duration_ms: 180, started_at: minutesAgo(2), decision_log_id: 'dlog_wfr_3220_st_1' },
    { id: 'wfs_2', step_id: 'st_2', label: 'Resolve workflow template (shipment_operation_policy)', status: 'succeeded', duration_ms: 220 },
    { id: 'wfs_3', step_id: 'st_3', label: 'Apply amend mutations', status: 'succeeded', duration_ms: 1140 },
    { id: 'wfs_4', step_id: 'st_4', label: 'Emit domain event shipment.amended', status: 'succeeded', duration_ms: 280, metadata: { decision_log_id: 'dlog_wfr_3220_st_4_legacy' } },
  ],
  wfr_3217: [
    { id: 'wfs_5', step_id: 'st_1', label: 'Webhook in', status: 'succeeded', duration_ms: 60 },
    { id: 'wfs_6', step_id: 'st_2', label: 'Field map (exampleparcel_ksa_v3.shipment_inbound)', status: 'succeeded', duration_ms: 120 },
    { id: 'wfs_7', step_id: 'st_3', label: 'Validate (schema_registry shipment.v6)', status: 'failed', duration_ms: 220, error: 'address.country missing' },
  ],
};

export const mapping_configs = [
  { id: 'mc_examplemarket_ksa_v3_in', organization_id: 'org_rashed', mapping_type: 'webhook_inbound', mapping_key: 'exampleparcel_ksa_v3.shipment_inbound', target: 'shipments.create', updated_at: '2026-04-22T10:00:00Z' },
  { id: 'mc_examplemarket_ksa_v3_out', organization_id: 'org_rashed', mapping_type: 'webhook_response', mapping_key: 'exampleparcel_ksa_v3.ack', target: 'webhook_response', updated_at: '2026-04-22T10:00:00Z' },
  { id: 'mc_exampledepot_resp', organization_id: 'org_rashed', mapping_type: 'provider_response', mapping_key: 'exampledepot.shipment_status', target: 'shipments.update_status', updated_at: '2026-04-15T11:00:00Z' },
  { id: 'mc_event_shp_created', organization_id: 'org_rashed', mapping_type: 'event_extraction', mapping_key: 'shipment.created', target: 'domain_events', updated_at: '2026-04-20T08:00:00Z' },
  { id: 'mc_event_route_published', organization_id: 'org_rashed', mapping_type: 'event_extraction', mapping_key: 'route.published', target: 'domain_events', updated_at: '2026-04-20T08:00:00Z' },
];

export const workflow_bindings = [
  { id: 'wbn_1', event: 'webhook.shipment.created', template_id: 'tpl_intake_exampleparcel', condition: { sender: 'exampleparcel_ksa' }, priority: 10 },
  { id: 'wbn_2', event: 'task.dispatch_exception_review.resolved', template_id: 'tpl_ndr_resolution', condition: null, priority: 5 },
  { id: 'wbn_3', event: 'shift.closed', template_id: 'tpl_cod_settlement', condition: { driver_role: 'driver' }, priority: 5 },
  { id: 'wbn_4', event: 'route_plans.publish', template_id: 'tpl_route_publish', condition: null, priority: 10 },
  { id: 'wbn_5', event: 'warehouse.transfer.execute', template_id: 'tpl_warehouse_xfer', condition: null, priority: 10 },
  { id: 'wbn_6', event: 'shipment.amend_cancel', template_id: 'tpl_amend_cancel', condition: null, priority: 10 },
  { id: 'wbn_7', event: 'shipments.create', template_id: 'tpl_create_shipment', condition: null, priority: 10 },
];

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_run_triggers projection.
// Mirrors public.workflow_run_triggers from
// supabase/migrations/202601281600_workflow_run_triggers.sql:14
// (workflow→workflow chaining, Zapier/Make-style). Read seam exposes the
// canonical projection so the Triggers tab on /workflows/runs lists
// active inter-workflow chains scoped to the current run's template.
// Capability gating mirrors workflow_runs (workflows.read / workflows.write).
export const workflow_run_triggers = [
  { id: 'wrt_001', source_workflow_template_id: 'tpl_intake_exampleparcel', source_template_name: 'Exampleparcel KSA inbound intake', target_workflow_template_id: 'tpl_route_publish', target_template_name: 'Route plan publish', source_statuses: ['completed'], scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, last_scanned_completed_at: minutesAgo(2), context_patch: { auto_publish: true }, created_at: '2026-04-15T10:00:00Z', updated_at: '2026-04-22T11:00:00Z', notes: 'Auto-publish route plan after successful intake' },
  { id: 'wrt_002', source_workflow_template_id: 'tpl_amend_cancel', source_template_name: 'Shipment amend & cancel', target_workflow_template_id: 'tpl_ndr_resolution', target_template_name: 'NDR resolution workflow', source_statuses: ['failed'], scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, last_scanned_completed_at: minutesAgo(15), context_patch: {}, created_at: '2026-04-12T08:00:00Z', updated_at: '2026-04-20T09:00:00Z', notes: 'Open NDR review on amend failure' },
  { id: 'wrt_003', source_workflow_template_id: 'tpl_cod_settlement', source_template_name: 'COD driver shift settlement', target_workflow_template_id: 'tpl_warehouse_xfer', target_template_name: 'Warehouse transfer execute', source_statuses: ['completed', 'succeeded'], scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', enabled: true, last_scanned_completed_at: minutesAgo(45), context_patch: { warehouse: 'whs_jed_main' }, created_at: '2026-04-10T14:00:00Z', updated_at: '2026-04-18T11:30:00Z', notes: 'Trigger warehouse rebalance after COD settlement' },
  { id: 'wrt_004', source_workflow_template_id: 'tpl_route_publish', source_template_name: 'Route plan publish', target_workflow_template_id: 'tpl_intake_exampleparcel', target_template_name: 'Exampleparcel KSA inbound intake', source_statuses: ['completed'], scope_type: 'tenant', scope_id: 'org_rashed', enabled: false, last_scanned_completed_at: null, context_patch: {}, created_at: '2026-03-25T16:00:00Z', updated_at: '2026-04-01T10:00:00Z', notes: 'DISABLED — was triggering loop, retained for audit' },
  { id: 'wrt_005', source_workflow_template_id: 'tpl_warehouse_xfer', source_template_name: 'Warehouse transfer execute', target_workflow_template_id: 'tpl_create_shipment', target_template_name: 'Operator-initiated shipment creation', source_statuses: ['completed'], scope_type: 'sender', scope_id: 'snd_exampleparcel_jed', enabled: true, last_scanned_completed_at: minutesAgo(120), context_patch: { auto_create_return: true }, created_at: '2026-04-08T09:00:00Z', updated_at: '2026-04-22T16:00:00Z', notes: 'Auto-generate return shipment on transfer complete' },
  { id: 'wrt_006', source_workflow_template_id: 'tpl_create_shipment', source_template_name: 'Operator-initiated shipment creation', target_workflow_template_id: 'tpl_amend_cancel', target_template_name: 'Shipment amend & cancel', source_statuses: ['failed'], scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, last_scanned_completed_at: minutesAgo(8), context_patch: { reason: 'auto-cancel failed creation' }, created_at: '2026-04-18T11:00:00Z', updated_at: '2026-04-25T08:30:00Z', notes: 'Auto-cancel and clean up on creation failure' },
  { id: 'wrt_007', source_workflow_template_id: 'tpl_ndr_resolution', source_template_name: 'NDR resolution workflow', target_workflow_template_id: 'tpl_create_shipment', target_template_name: 'Operator-initiated shipment creation', source_statuses: ['completed'], scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', enabled: true, last_scanned_completed_at: minutesAgo(30), context_patch: { reschedule: true }, created_at: '2026-04-14T13:00:00Z', updated_at: '2026-04-22T14:00:00Z', notes: 'Auto-create reshipment when NDR resolution=reschedule' },
];

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_schedule_triggers projection.
// Mirrors public.workflow_schedule_triggers from
// supabase/migrations/202601212101_workflow_schedule_triggers.sql:14
// (cron-shaped scheduled runs, Zapier/Make-style). Read seam exposes the
// canonical projection so the Schedules tab on /workflows/runs lists
// active cron schedules per template/scope. Capability gating mirrors
// workflow_runs (workflows.read / workflows.write).
export const workflow_schedule_triggers = [
  { id: 'wst_001', workflow_template_id: 'tpl_route_publish', template_name: 'Route plan publish', schedule: { type: 'daily', at_time: '04:00', timezone: 'Asia/Riyadh' }, schedule_summary: 'Daily 04:00 Asia/Riyadh', context_patch: { branch: 'rh_jed' }, scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, next_run_at: '2026-04-28T01:00:00Z', last_run_at: '2026-04-27T01:00:00Z', last_run_id: 'wfr_3216', last_error: null, last_error_at: null, created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-25T08:00:00Z', notes: 'Nightly route plan publish for Jeddah branch' },
  { id: 'wst_002', workflow_template_id: 'tpl_cod_settlement', template_name: 'COD driver shift settlement', schedule: { type: 'daily', at_time: '23:00', timezone: 'Asia/Riyadh' }, schedule_summary: 'Daily 23:00 Asia/Riyadh', context_patch: {}, scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, next_run_at: '2026-04-27T20:00:00Z', last_run_at: '2026-04-26T20:00:00Z', last_run_id: 'wfr_3210', last_error: null, last_error_at: null, created_at: '2026-04-05T14:00:00Z', updated_at: '2026-04-26T20:00:00Z', notes: 'End-of-day driver shift COD settlement' },
  { id: 'wst_003', workflow_template_id: 'tpl_warehouse_xfer', template_name: 'Warehouse transfer execute', schedule: { type: 'interval', interval_seconds: 1800 }, schedule_summary: 'Every 30 min', context_patch: { transfer_kind: 'intra_hub' }, scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', enabled: true, next_run_at: '2026-04-27T11:00:00Z', last_run_at: '2026-04-27T10:30:00Z', last_run_id: 'wfr_3214', last_error: null, last_error_at: null, created_at: '2026-04-12T09:00:00Z', updated_at: '2026-04-27T10:30:00Z', notes: 'Continuous intra-hub rebalance — Exampleparcel KSA' },
  { id: 'wst_004', workflow_template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', schedule: { type: 'weekly', at_time: '09:00', timezone: 'Asia/Riyadh', days: ['mon', 'wed', 'fri'] }, schedule_summary: 'Mon/Wed/Fri 09:00 Asia/Riyadh', context_patch: { batch_mode: true }, scope_type: 'sender', scope_id: 'snd_exampleparcel_jed', enabled: false, next_run_at: '2026-04-29T06:00:00Z', last_run_at: '2026-04-22T06:00:00Z', last_run_id: null, last_error: 'rate_limit_exceeded: exampleparcel_ksa hourly cap', last_error_at: '2026-04-22T06:01:00Z', created_at: '2026-03-15T10:00:00Z', updated_at: '2026-04-22T06:01:00Z', notes: 'PAUSED — rate limit incident, owner reviewing' },
  { id: 'wst_005', workflow_template_id: 'tpl_amend_cancel', template_name: 'Shipment amend & cancel', schedule: { type: 'daily', at_time: '02:00', timezone: 'UTC' }, schedule_summary: 'Daily 02:00 UTC', context_patch: { sweep: 'stale_pending' }, scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, next_run_at: '2026-04-28T02:00:00Z', last_run_at: '2026-04-27T02:00:00Z', last_run_id: 'wfr_3208', last_error: null, last_error_at: null, created_at: '2026-04-02T11:00:00Z', updated_at: '2026-04-27T02:00:00Z', notes: 'Stale-pending sweep' },
  { id: 'wst_006', workflow_template_id: 'tpl_ndr_resolution', template_name: 'NDR resolution workflow', schedule: { type: 'interval', interval_seconds: 3600 }, schedule_summary: 'Hourly', context_patch: {}, scope_type: 'tenant', scope_id: 'org_rashed', enabled: true, next_run_at: '2026-04-27T11:30:00Z', last_run_at: '2026-04-27T10:30:00Z', last_run_id: 'wfr_3219', last_error: null, last_error_at: null, created_at: '2026-04-08T09:00:00Z', updated_at: '2026-04-27T10:30:00Z', notes: 'Hourly NDR queue sweep' },
];

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_binding_dispatches projection.
// Mirrors public.workflow_binding_dispatches from
// supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql:224
// (dispatch ledger; outcome ∈ {started, completed, waiting, failed}).
// Read seam exposes the canonical projection so the Dispatches tab on
// /workflows/bindings lists recent resolved binding executions per
// binding_key + stage_key. Capability gating mirrors workflow_bindings
// (workflows.read / workflows.write — same RLS posture).
export const workflow_binding_dispatches = [
  { id: 'wbd_3221', binding_key: 'webhook.shipment.created.default', stage_key: 'default', event: 'webhook.shipment.created', workflow_template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', workflow_run_id: 'wfr_3221', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'started', actor_system: 'webhook-receiver', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_examplemarket_99281', created_at: minutesAgo(0), updated_at: minutesAgo(0), settings_resolution_id: 'sres_a01', context: { tracking_number: 'EXAMPLEMARKET-99281' } },
  { id: 'wbd_3220', binding_key: 'shipment.amend_cancel.default', stage_key: 'default', event: 'shipment.amend_cancel', workflow_template_id: 'tpl_amend_cancel', template_name: 'Shipment amend & cancel', workflow_run_id: 'wfr_3220', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'completed', actor_system: 'progress_workflow_run', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_amend_9381418', created_at: minutesAgo(2), updated_at: minutesAgo(2), settings_resolution_id: 'sres_a02', context: { shipment_id: 'shp_9381418', op: 'cancel' } },
  { id: 'wbd_3219', binding_key: 'task.dispatch_exception_review.resolved.default', stage_key: 'default', event: 'task.dispatch_exception_review.resolved', workflow_template_id: 'tpl_ndr_resolution', template_name: 'NDR resolution workflow', workflow_run_id: 'wfr_3219', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'completed', actor_system: 'progress_workflow_run', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_tsk_2901', created_at: minutesAgo(4), updated_at: minutesAgo(4), settings_resolution_id: 'sres_a03', context: { task_id: 'tsk_2901', resolution: 'reschedule' } },
  { id: 'wbd_3218', binding_key: 'webhook.shipment.created.default', stage_key: 'default', event: 'webhook.shipment.created', workflow_template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', workflow_run_id: 'wfr_3218', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'completed', actor_system: 'webhook-receiver', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_examplemarket_99280', created_at: minutesAgo(6), updated_at: minutesAgo(6), settings_resolution_id: 'sres_a04', context: { tracking_number: 'EXAMPLEMARKET-99280' } },
  { id: 'wbd_3217', binding_key: 'webhook.shipment.created.default', stage_key: 'default', event: 'webhook.shipment.created', workflow_template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', workflow_run_id: 'wfr_3217', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'failed', actor_system: 'webhook-receiver', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_examplemarket_99277', created_at: minutesAgo(7), updated_at: minutesAgo(7), settings_resolution_id: 'sres_a05', context: { tracking_number: 'EXAMPLEMARKET-99277', error: 'schema_registry validation failed' } },
  { id: 'wbd_3216', binding_key: 'route_plans.publish.default', stage_key: 'default', event: 'route_plans.publish', workflow_template_id: 'tpl_route_publish', template_name: 'Route plan publish', workflow_run_id: 'wfr_3216', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'completed', actor_system: 'workflow_schedule_trigger', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_plan_42', created_at: minutesAgo(308), updated_at: minutesAgo(307), settings_resolution_id: 'sres_a06', context: { plan_id: 'plan_42', branch: 'rh_jed' } },
  { id: 'wbd_3215', binding_key: 'webhook.shipment.created.default', stage_key: 'default', event: 'webhook.shipment.created', workflow_template_id: 'tpl_intake_exampleparcel', template_name: 'Exampleparcel KSA inbound intake', workflow_run_id: 'wfr_3215', resolved_scope_type: 'sender', resolved_scope_id: 'snd_exampleparcel_jed', outcome: 'completed', actor_system: 'webhook-receiver', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_examplemarket_99275', created_at: minutesAgo(11), updated_at: minutesAgo(11), settings_resolution_id: 'sres_a07', context: { tracking_number: 'EXAMPLEMARKET-99275' } },
  { id: 'wbd_3214', binding_key: 'shift.closed.default', stage_key: 'default', event: 'shift.closed', workflow_template_id: 'tpl_cod_settlement', template_name: 'COD driver shift settlement', workflow_run_id: 'wfr_3214', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'waiting', actor_system: 'event_consumer', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_shift_drv_311', created_at: minutesAgo(310), updated_at: minutesAgo(310), settings_resolution_id: 'sres_a08', context: { driver_id: 'drv_311', shift_date: '2026-04-25' } },
  { id: 'wbd_3213', binding_key: 'warehouse.transfer.execute.default', stage_key: 'default', event: 'warehouse.transfer.execute', workflow_template_id: 'tpl_warehouse_xfer', template_name: 'Warehouse transfer execute', workflow_run_id: 'wfr_3213', resolved_scope_type: 'tenant', resolved_scope_id: 'org_rashed', outcome: 'completed', actor_system: 'workflow_schedule_trigger', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_whx_88', created_at: minutesAgo(330), updated_at: minutesAgo(329), settings_resolution_id: 'sres_a09', context: { transfer_id: 'whx_88', items: 24 } },
  { id: 'wbd_3212', binding_key: 'shipments.create.default', stage_key: 'default', event: 'shipments.create', workflow_template_id: 'tpl_create_shipment', template_name: 'Operator-initiated shipment creation', workflow_run_id: 'wfr_3212', resolved_scope_type: 'client', resolved_scope_id: 'cl_exampleparcel_ksa', outcome: 'completed', actor_system: 'progress_workflow_run', source_function: 'register_workflow_binding_v1', idempotency_key: 'idem_shp_create_001', created_at: minutesAgo(28), updated_at: minutesAgo(28), settings_resolution_id: 'sres_a10', context: { client_id: 'cl_exampleparcel_ksa' } },
];

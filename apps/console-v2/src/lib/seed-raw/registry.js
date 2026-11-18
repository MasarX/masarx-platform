// registry.js — mirrors ui_read_registry + ui_command_registry + schema_registry + settings_category_registry
// Anchored in supabase/migrations/202601111100_ui_read_registry_columns.sql + 202601030900_ui_read_api_v2.sql
// AGENTS.md line 24: "shared UI read helpers must stay fail-closed but view-aware"

export const ui_read_registry = {
  shipments: {
    relation: 'shipments',
    id_column: 'id',
    capability_read: 'shipments.read',
    capability_write: 'shipments.write',
    scope_columns: { tenant: 'organization_id', client: 'client_id', sender: 'sender_id' },
    filters: [
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'client_id', column: 'client_id', op: 'eq' },
      { key: 'sender_id', column: 'sender_id', op: 'eq' },
      { key: 'identifier', column: 'id', op: 'eq' },
      { key: 'status', column: 'status', op: 'eq' },
    ],
    columns: [
      {
        key: 'tracking_number',
        label: 'Tracking #',
        sortable: true,
        mono: true,
        import: {
          enabled: true,
          required: true,
          identity: true,
          aliases: ['tracking_number', 'tracking', 'tracking #', 'awb', 'waybill', 'shipment_number'],
        },
      },
      { key: 'client_reference_number', label: 'Client ref', sortable: true, mono: true },
      {
        key: 'recipient_id',
        label: 'Recipient',
        mono: true,
        import: {
          enabled: true,
          aliases: ['recipient_id', 'recipient'],
          reference: {
            resource: 'recipients',
            allow_inline_node: true,
            inline_node_key: 'recipient',
            mapping_prefixes: ['recipient'],
          },
        },
      },
      {
        key: 'destination_address_id',
        label: 'Destination address',
        mono: true,
        import: {
          enabled: true,
          aliases: ['destination_address_id', 'destination_address', 'address'],
          reference: {
            resource: 'addresses',
            allow_inline_node: true,
            inline_node_key: 'destination_address',
            mapping_prefixes: ['destination_address', 'address'],
          },
        },
      },
      { key: 'service_type', label: 'Service', filterable: true, lookup: 'service_type' },
      { key: 'status', label: 'Status', filterable: true, lookup: 'shipment_status' },
      { key: 'origin_city', label: 'Origin' },
      { key: 'destination_city', label: 'Destination' },
      { key: 'cod_amount', label: 'COD', align: 'right', mono: true, format: 'currency' },
      { key: 'cod_currency', label: 'CCY' },
      { key: 'promised_delivery_date', label: 'Promised', format: 'date' },
      { key: 'updated_at', label: 'Updated', format: 'datetime' },
    ],
  },
  route_plans: {
    relation: 'route_plans',
    id_column: 'id',
    capability_read: 'route_plans.read',
    capability_write: 'route_plans.write',
    columns: [
      { key: 'plan_id', label: 'Plan', mono: true },
      { key: 'wave_label', label: 'Wave' },
      { key: 'hub', label: 'Hub' },
      { key: 'status', label: 'Status', filterable: true, lookup: 'route_plan_status' },
      { key: 'stops', label: 'Stops', align: 'right' },
      { key: 'runs', label: 'Runs', align: 'right' },
      { key: 'updated_at', label: 'Updated', format: 'datetime' },
    ],
  },
  route_runs: {
    relation: 'route_runs',
    id_column: 'id',
    capability_read: 'routes.read',
    capability_write: 'routes.write',
    columns: [
      { key: 'run_id', label: 'Run', mono: true },
      { key: 'driver', label: 'Driver' },
      { key: 'vehicle', label: 'Vehicle', mono: true },
      { key: 'partner', label: 'Partner', filterable: true },
      { key: 'stops', label: 'Stops', align: 'right' },
      { key: 'completed', label: 'Completed', align: 'right' },
      { key: 'sla', label: 'SLA', align: 'right' },
      { key: 'status', label: 'Status', filterable: true, lookup: 'route_run_status' },
      { key: 'eta', label: 'ETA' },
    ],
  },
  // OPERATIONS REAUDIT D4 (W9-4) — surface the canonical assignment projection
  // for dispatch insight rail. Backend SSOT: public.route_run_assignments
  // (supabase/migrations/202604061430_uc076_route_run_assignment_lifecycle_
  // foundation_v1.sql:49). Read-only on the operator surface; mutations route
  // through ui_execute_route_run_assign_v1 which writes to this table.
  route_run_assignments: {
    relation: 'route_run_assignments',
    id_column: 'id',
    capability_read: 'routes.read',
    capability_write: 'routes.write',
    columns: [
      { key: 'route_run_id', label: 'Run', mono: true },
      { key: 'assignment_status', label: 'Status', filterable: true, lookup: 'route_run_assignment_status' },
      { key: 'assignment_mode', label: 'Mode', filterable: true, lookup: 'route_assignment_mode' },
      { key: 'driver_user_id', label: 'Driver', mono: true },
      { key: 'vehicle_id', label: 'Vehicle', mono: true },
      { key: 'assignment_version', label: 'Version', align: 'right' },
      { key: 'assigned_at', label: 'Assigned', format: 'datetime' },
    ],
  },
  // OPERATIONS REAUDIT D4 (W9-4) — read-only ledger for assignment lifecycle.
  // Backend SSOT: public.route_run_assignment_events (same migration as above,
  // 202604061430:173). Append-only audit trail for every transition between
  // assigned / departed / handed_off / cancelled. Surfaced in dispatch tab.
  route_run_assignment_events: {
    relation: 'route_run_assignment_events',
    id_column: 'id',
    capability_read: 'routes.read',
    columns: [
      { key: 'route_run_id', label: 'Run', mono: true },
      { key: 'assignment_version', label: 'V', align: 'right' },
      { key: 'event_type', label: 'Event', filterable: true },
      { key: 'from_status', label: 'From', lookup: 'route_run_assignment_status' },
      { key: 'to_status', label: 'To', lookup: 'route_run_assignment_status' },
      { key: 'assignment_mode', label: 'Mode', lookup: 'route_assignment_mode' },
      { key: 'actor_user_id', label: 'Actor', mono: true },
      { key: 'created_at', label: 'When', format: 'datetime' },
    ],
  },
  // OPERATIONS REAUDIT D4 (W9-4) — read-only audit ledger for stop-level
  // mid-execution reassignments. Backend SSOT: public.route_stop_reassignment_
  // events (supabase/migrations/202604101715_uc078_route_stop_mid_execution_
  // reassignment_v1.sql:274). Append-only — write seam is
  // ui_execute_route_stop_reassign_v1.
  route_stop_reassignment_events: {
    relation: 'route_stop_reassignment_events',
    id_column: 'id',
    capability_read: 'routes.read',
    columns: [
      { key: 'route_stop_id', label: 'Stop', mono: true },
      { key: 'shipment_id', label: 'Shipment', mono: true },
      { key: 'source_route_run_id', label: 'From run', mono: true },
      { key: 'target_route_run_id', label: 'To run', mono: true },
      { key: 'event_type', label: 'Event', filterable: true },
      { key: 'actor_user_id', label: 'Actor', mono: true },
      { key: 'notes', label: 'Notes' },
      { key: 'created_at', label: 'When', format: 'datetime' },
    ],
  },
  baskets: {
    relation: 'baskets',
    id_column: 'id',
    capability_read: 'baskets.read',
    capability_write: 'baskets.write',
    columns: [
      { key: 'id', label: 'Basket', mono: true },
      { key: 'zone_id', label: 'Zone', mono: true, filterable: true },
      { key: 'basket_type', label: 'Type', filterable: true, lookup: 'basket_type' },
      { key: 'state', label: 'State', filterable: true, lookup: 'basket_state' },
      { key: 'current_count', label: 'Count', align: 'right' },
      { key: 'capacity_count', label: 'Capacity', align: 'right' },
      { key: 'expires_at', label: 'Expires', format: 'datetime' },
      { key: 'updated_at', label: 'Updated', format: 'datetime' },
    ],
  },
  basket_items: {
    relation: 'basket_items',
    id_column: 'id',
    capability_read: 'baskets.read',
    capability_write: 'baskets.write',
    columns: [
      { key: 'basket_id', label: 'Basket', mono: true, filterable: true },
      { key: 'shipment_id', label: 'Shipment', mono: true, filterable: true },
      { key: 'shipment_client_id', label: 'Client', mono: true },
      { key: 'added_at', label: 'Added', format: 'datetime' },
      { key: 'removed_at', label: 'Removed', format: 'datetime' },
    ],
  },
  basket_transitions: {
    relation: 'basket_transitions',
    id_column: 'id',
    capability_read: 'baskets.read',
    columns: [
      { key: 'basket_id', label: 'Basket', mono: true, filterable: true },
      { key: 'previous_state', label: 'From', lookup: 'basket_state' },
      { key: 'new_state', label: 'To', lookup: 'basket_state', filterable: true },
      { key: 'changed_at', label: 'Changed', format: 'datetime' },
      { key: 'changed_by', label: 'Changed by', mono: true },
      { key: 'notes', label: 'Notes' },
    ],
  },
  tasks: {
    relation: 'tasks',
    id_column: 'id',
    capability_read: 'tasks.read',
    capability_write: 'tasks.write',
    columns: [
      { key: 'task_id', label: 'Task', mono: true },
      { key: 'task_type', label: 'Type', filterable: true, lookup: 'task_type' },
      { key: 'subject', label: 'Subject' },
      { key: 'assigned_to', label: 'Assignee' },
      { key: 'queue', label: 'Queue' },
      { key: 'sla_due_at', label: 'SLA due', format: 'datetime' },
      { key: 'status', label: 'Status', filterable: true, lookup: 'task_status' },
    ],
  },
  settlement_batches: {
    relation: 'settlement_batches',
    id_column: 'id',
    capability_read: 'settlements.read',
    capability_write: 'settlements.write',
    columns: [
      { key: 'batch_id', label: 'Batch', mono: true },
      { key: 'kind', label: 'Kind', filterable: true, lookup: 'settlement_kind' },
      { key: 'scope', label: 'Scope' },
      { key: 'expected_amount', label: 'Expected', align: 'right', format: 'currency' },
      { key: 'collected_amount', label: 'Collected', align: 'right', format: 'currency' },
      { key: 'remitted_amount', label: 'Remitted', align: 'right', format: 'currency' },
      { key: 'status', label: 'Status', filterable: true, lookup: 'settlement_status' },
      { key: 'posted_at', label: 'Posted', format: 'datetime' },
    ],
  },
  // Paired projection view (W8-4): public.v_settlement_batch_summary projects
  // (expected_amount, collected_amount, remitted_amount, posted_at, variance_flag)
  // from settlement_batches + settlement_batch_finance_events + finance_events +
  // settlement_events. Read-only; SSOT remains settlement_batches.
  // FE consumption seam (G1 close-out W10-4): registry-only entry — settlements
  // module continues reading 'settlement_batches' until paired hook lands and
  // derived seed columns can be dropped.
  settlement_batch_summary: {
    relation: 'v_settlement_batch_summary',
    id_column: 'id',
    capability_read: 'settlements.read',
    columns: [
      { key: 'id', label: 'Batch', mono: true },
      { key: 'kind', label: 'Kind', filterable: true, lookup: 'settlement_kind' },
      { key: 'scope_type', label: 'Scope' },
      { key: 'expected_amount', label: 'Expected', align: 'right', format: 'currency' },
      { key: 'collected_amount', label: 'Collected', align: 'right', format: 'currency' },
      { key: 'remitted_amount', label: 'Remitted', align: 'right', format: 'currency' },
      { key: 'variance_flag', label: 'Variance', filterable: true },
      { key: 'status', label: 'Status', filterable: true, lookup: 'settlement_status' },
      { key: 'posted_at', label: 'Posted', format: 'datetime' },
    ],
  },
  workflow_templates: {
    relation: 'workflow_templates',
    id_column: 'id',
    capability_read: 'workflows.read',
    capability_write: 'workflows.write',
    filters: [
      { key: 'status', column: 'status', op: 'eq' },
      { key: 'scope_type', column: 'scope_type', op: 'eq' },
      { key: 'scope_id', column: 'scope_id', op: 'eq' },
      { key: 'name', column: 'name', op: 'ilike' },
    ],
    columns: [
      { key: 'template_id', label: 'Template', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'version', label: 'Version', mono: true },
      { key: 'trigger', label: 'Trigger' },
      { key: 'status', label: 'Status', lookup: 'workflow_run_status' },
      { key: 'updated_at', label: 'Updated', format: 'datetime' },
    ],
  },
  workflow_runs: {
    relation: 'workflow_runs',
    id_column: 'id',
    capability_read: 'workflows.read',
    columns: [
      { key: 'run_id', label: 'Run', mono: true },
      { key: 'template_name', label: 'Template' },
      { key: 'started_at', label: 'Started', format: 'datetime' },
      { key: 'duration_ms', label: 'Duration', align: 'right', format: 'ms' },
      { key: 'status', label: 'Status', lookup: 'workflow_run_status' },
      { key: 'correlation_id', label: 'Correlation', mono: true },
    ],
  },
  // W11-6 (CLAIM-WORKFLOWS-DEFERRED). Mirrors public.workflow_run_triggers from
  // supabase/migrations/202601281600_workflow_run_triggers.sql:14
  // (workflow→workflow chaining, Zapier/Make-style). RLS is gated by
  // workflows.read / workflows.write per the canonical policy
  // (supabase/migrations/202601201200_access_control_policy_client_admin_workflow_triggers.sql).
  workflow_run_triggers: {
    relation: 'workflow_run_triggers',
    id_column: 'id',
    capability_read: 'workflows.read',
    capability_write: 'workflows.write',
    columns: [
      { key: 'source_template_name', label: 'Source template', sortable: true, filterable: true },
      { key: 'target_template_name', label: 'Target template', sortable: true, filterable: true },
      { key: 'source_statuses', label: 'On status', filterable: true },
      { key: 'scope_type', label: 'Scope', filterable: true, lookup: 'workflow_trigger_scope_type' },
      { key: 'enabled', label: 'Enabled', filterable: true },
      { key: 'last_scanned_completed_at', label: 'Last scan', format: 'datetime', sortable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // W11-6 (CLAIM-WORKFLOWS-DEFERRED). Mirrors public.workflow_schedule_triggers from
  // supabase/migrations/202601212101_workflow_schedule_triggers.sql:14 (cron-shaped
  // scheduled runs). RLS is gated by workflows.read / workflows.write.
  workflow_schedule_triggers: {
    relation: 'workflow_schedule_triggers',
    id_column: 'id',
    capability_read: 'workflows.read',
    capability_write: 'workflows.write',
    columns: [
      { key: 'template_name', label: 'Template', sortable: true, filterable: true },
      { key: 'schedule_summary', label: 'Schedule', sortable: true },
      { key: 'scope_type', label: 'Scope', filterable: true, lookup: 'workflow_trigger_scope_type' },
      { key: 'enabled', label: 'Enabled', filterable: true },
      { key: 'next_run_at', label: 'Next run', format: 'datetime', sortable: true },
      { key: 'last_run_at', label: 'Last run', format: 'datetime', sortable: true },
      { key: 'last_error', label: 'Last error' },
    ],
  },
  // W11-6 (CLAIM-WORKFLOWS-DEFERRED). Mirrors public.workflow_binding_dispatches from
  // supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql:224
  // (dispatch ledger; outcome ∈ {started, completed, waiting, failed}).
  // RLS is gated by workflows.read / workflows.write (canonical posture for
  // workflow_binding_*; see same migration L284-296 for revoke posture and
  // explicit service-policy / authenticated read grants).
  workflow_binding_dispatches: {
    relation: 'workflow_binding_dispatches',
    id_column: 'id',
    capability_read: 'workflows.read',
    columns: [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'binding_key', label: 'Binding', mono: true, sortable: true, filterable: true },
      { key: 'stage_key', label: 'Stage', mono: true, filterable: true },
      { key: 'event', label: 'Event', mono: true, sortable: true, filterable: true },
      { key: 'template_name', label: 'Template', sortable: true, filterable: true },
      { key: 'workflow_run_id', label: 'Run', mono: true },
      { key: 'outcome', label: 'Outcome', filterable: true, lookup: 'workflow_binding_dispatch_outcome' },
      { key: 'resolved_scope_type', label: 'Scope', filterable: true, lookup: 'workflow_trigger_scope_type' },
      { key: 'idempotency_key', label: 'Idempotency', mono: true },
    ],
  },
  integration_plugins: {
    relation: 'integration_plugins',
    id_column: 'id',
    capability_read: 'integration_plugins.read',
    columns: [
      { key: 'name', label: 'Plugin' },
      { key: 'vendor', label: 'Vendor' },
      { key: 'version', label: 'Version', mono: true },
      { key: 'kind', label: 'Kind' },
      { key: 'status', label: 'Status', lookup: 'plugin_status' },
      { key: 'health', label: 'Health', align: 'right', format: 'percent' },
      { key: 'events_24h', label: 'Events 24h', align: 'right', mono: true },
    ],
  },
  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — domain_events read seam. Replaces the
  // FE-only `recent_workflow_events` mock surface for the per-run drilldown
  // in the workflow_runs drawer. The bindings event-tester surface still
  // consumes `recent_workflow_events` (intentionally retained as a permanent
  // FE-derived list because no canonical projection RPC exists yet — see
  // __audit__/CROSSWALK/WORKFLOWS.md §"Important gaps (P1)"). Capability gate
  // mirrors observability.read since the canonical SSOT is public.domain_events
  // (event log). filter: { workflow_run_id } scopes the consumer to a single run.
  domain_events: {
    relation: 'domain_events',
    id_column: 'id',
    capability_read: 'observability.read',
    columns: [
      // W16-2: canonical column key for time of event is `created_at` per
      // public.domain_events (supabase/migrations/202511160100_domain_events_core.sql).
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
      { key: 'resource_type', label: 'Resource type', mono: true, filterable: true },
      { key: 'resource_id', label: 'Resource', mono: true, filterable: true },
      { key: 'workflow_run_id', label: 'Run', mono: true, filterable: true },
      { key: 'correlation_id', label: 'Correlation', mono: true, filterable: true },
    ],
  },
  decision_log: {
    relation: 'decision_log',
    id_column: 'id',
    capability_read: 'observability.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime' },
      { key: 'decision_category', label: 'Category', filterable: true, lookup: 'decision_category' },
      { key: 'resource_type', label: 'Resource' },
      { key: 'resource_id', label: 'Resource ID', mono: true },
      { key: 'resolved_from', label: 'Scope' },
      { key: 'settings_resolution_id', label: 'Resolution', mono: true },
    ],
    filters: [
      { key: 'decision_category', column: 'decision_category', op: 'eq' },
      { key: 'resource_type', column: 'resource_type', op: 'eq' },
      { key: 'resource_id', column: 'resource_id', op: 'eq' },
      { key: 'decision_outcome', column: 'decision_outcome', op: 'eq' },
      { key: 'correlation_id', column: 'correlation_id', op: 'eq' },
    ],
  },
  // Wave 6 — INSIGHTS audit reconciliation. Mirrors the canonical
  // public.audit_table_changes ledger from
  // supabase/migrations/202512011211_audit_table_changes.sql:10-24
  // (HASH+RANGE partitioned). Capability gate `audit_log.read` is the
  // canonical capability key declared in
  // supabase/migrations/202601022113_access_control_policy_core.sql:215,241
  // (intentionally retains the `audit_log.*` namespace — only the
  // backing table name was reconciled). Replaces the prior FE-only
  // `seed.audit_log` read seam (which referenced a non-existent backend
  // table) so production swap routes through ui_list_resource_v1 against
  // the real ledger.
  audit_table_changes: {
    relation: 'audit_table_changes',
    id_column: 'id',
    capability_read: 'audit_log.read',
    columns: [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'schema_name', label: 'Schema', mono: true, sortable: true, filterable: true },
      { key: 'table_name', label: 'Table', mono: true, sortable: true, filterable: true },
      { key: 'op', label: 'Op', sortable: true, filterable: true },
      { key: 'pk', label: 'PK', mono: true, sortable: true, filterable: true },
      { key: 'changed_by', label: 'Actor', mono: true, sortable: true, filterable: true },
      { key: 'correlation_id', label: 'Correlation', mono: true, sortable: true, filterable: true },
    ],
  },
  warehouse_transfers: {
    relation: 'warehouse_transfers',
    id_column: 'id',
    capability_read: 'warehouse.read',
    columns: [
      { key: 'transfer_id', label: 'Transfer', mono: true },
      { key: 'origin_hub', label: 'Origin' },
      { key: 'destination_hub', label: 'Destination' },
      { key: 'item_count', label: 'Items', align: 'right' },
      { key: 'received_count', label: 'Received', align: 'right' },
      { key: 'status', label: 'Status', lookup: 'warehouse_transfer_status' },
      { key: 'updated_at', label: 'Updated', format: 'datetime' },
    ],
  },
  // Paired projection view (W11-3): public.v_warehouse_transfer_summary
  // (supabase/migrations/202604301500_v_warehouse_transfer_summary.sql)
  // projects per-transfer aggregates from warehouse_transfers +
  // warehouse_transfer_items + scan_events:
  //   • item_count       = COUNT(warehouse_transfer_items)
  //   • received_count   = COUNT(DISTINCT scan_events.shipment_id) WHERE
  //                        scan_type='warehouse_checkpoint' AND
  //                        metadata.checkpoint='destination_scan_in'
  //   • variance_count   = item_count - received_count (clamped >= 0)
  //   • variance_flag    = (variance_count > 0) AND status IN
  //                        ('received','reconciled','on_hold')
  //   • posted_at        = COALESCE(received_at, dispatched_at)
  //   • hold_reason      = metadata->>'hold_reason' (stop-gap)
  // Read-only; SSOT remains warehouse_transfers. View is security_invoker so
  // RLS on the underlying tables governs access. FE consumption seam:
  // warehouse.tsx reads via
  // useResourceList<TransferRow>('warehouse_transfer_summary') so the
  // operator surface consumes server-derived aggregates without FE-side
  // computation. Production cutover is a single getSupabaseClient() branch
  // flip in ui_list_resource_v1 — module call sites stay stable.
  warehouse_transfer_summary: {
    relation: 'v_warehouse_transfer_summary',
    allow_view_relation: true,
    id_column: 'id',
    capability_read: 'warehouse.read',
    columns: [
      { key: 'transfer_code', label: 'Transfer', mono: true, sortable: true, filterable: true },
      { key: 'from_branch_id', label: 'Origin', mono: true, sortable: true, filterable: true },
      { key: 'to_branch_id', label: 'Destination', mono: true, sortable: true, filterable: true },
      { key: 'item_count', label: 'Items', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'received_count', label: 'Received', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'variance_count', label: 'Variance', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'variance_flag', label: 'At risk', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'warehouse_transfer_status' },
      { key: 'posted_at', label: 'Posted', format: 'datetime', sortable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  handling_units: {
    relation: 'handling_units',
    id_column: 'id',
    capability_read: 'handling_units.read',
    capability_write: 'handling_units.write',
    columns: [
      { key: 'code', label: 'Code', mono: true, sortable: true, filterable: true },
      { key: 'unit_type', label: 'Type', sortable: true, filterable: true, lookup: 'handling_unit_type' },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'handling_unit_status' },
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'created_at', label: 'Created', format: 'datetime', sortable: true },
    ],
  },
  // Browser-safe projection over public.webhook_sources. Raw auth_token /
  // auth_token_hash never travel through generic Console V2 resource reads.
  webhook_sources: {
    relation: 'v_webhook_source_directory',
    allow_view_relation: true,
    id_column: 'id',
    capability_read: 'webhooks.read',
    capability_write: 'webhooks.write',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'source_identifier', label: 'Source', mono: true, sortable: true, filterable: true },
      { key: 'provider_type', label: 'Provider', filterable: true, lookup: 'webhook_provider_type' },
      { key: 'mapping_config_id', label: 'Mapping', mono: true },
      { key: 'rate_limit_per_hour', label: 'Rate / hr', align: 'right', mono: true, sortable: true },
      { key: 'enabled', label: 'Enabled', filterable: true },
      { key: 'last_event_at', label: 'Last event', format: 'datetime' },
      { key: 'auth_token_masked', label: 'Token', mono: true },
    ],
  },
  // CLAIM-INTEGRATIONS-MAPPING (Phase C5). Mirrors public.mapping_configs from
  // supabase/migrations/202510110003_mapping_lookup.sql:101+. RLS gated by
  // mappings.read / mappings.write per 202601071220_access_control_policy_ui_resources.sql:104.
  mapping_configs: {
    relation: 'mapping_configs',
    id_column: 'id',
    capability_read: 'mappings.read',
    capability_write: 'mappings.write',
    columns: [
      { key: 'mapping_type', label: 'Type', sortable: true, filterable: true, lookup: 'mapping_type' },
      { key: 'mapping_key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'mapping_version', label: 'Version', align: 'right', mono: true, sortable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // Mirrors public.webhook_rules from the same migration L248+.
  // RLS gated by webhooks.read / webhooks.write per 202601071220:113.
  webhook_rules: {
    relation: 'webhook_rules',
    id_column: 'id',
    capability_read: 'webhooks.read',
    capability_write: 'webhooks.write',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'webhook_source_id', label: 'Source', mono: true, sortable: true, filterable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
      { key: 'priority', label: 'Priority', align: 'right', mono: true, sortable: true },
      { key: 'mapping_config_id', label: 'Mapping', mono: true },
      { key: 'workflow_template_id', label: 'Workflow', mono: true },
      { key: 'domain_category', label: 'Domain', filterable: true },
      { key: 'enabled', label: 'Enabled', filterable: true },
    ],
  },
  // W27 — INTEGRATIONS paired projection views (read-only). Mirrors:
  //   • public.v_webhook_source_directory          (supabase/migrations/202604302500_v_webhook_source_directory.sql)
  //   • public.v_webhook_inbox_directory           (supabase/migrations/202604302510_v_webhook_inbox_directory.sql)
  //   • public.v_mapping_config_directory          (supabase/migrations/202604302520_v_mapping_config_directory.sql)
  //   • public.v_integration_credential_directory  (supabase/migrations/202604302530_v_integration_credential_directory.sql)
  //   • public.v_integration_plugin_directory      (supabase/migrations/202604302540_v_integration_plugin_directory.sql)
  // Capability gates mirror the underlying SSOT:
  //   - webhook_source_directory:           webhooks.read
  //   - webhook_inbox_directory:            webhooks.read
  //   - mapping_config_directory:           mappings.read
  //   - integration_credential_directory:   integrations.read
  //   - integration_plugin_directory:       integration_plugins.read
  // SSOT preserved on the underlying base tables; mutations continue via the
  // existing canonical RPCs (ui_upsert_webhook_source_v1 /
  // ui_rotate_webhook_source_token_v1 / ui_upsert_webhook_rule_v1 /
  // ui_delete_webhook_rule_v1 / ui_reorder_webhook_rule_v1 /
  // ui_upsert_mapping_artifact_v1 / mapping_config_promote_v1 /
  // webhook_inbox_replay_v1 / webhook_inbox_force_status_v1 /
  // integration_plugin_rotate_credentials_v1 /
  // ui_revoke_provider_auth_config_v1 / integration_plugin_generate_draft_v1 /
  // submit / approve / activate / set_binding / rollback).
  webhook_source_directory: {
    relation: 'v_webhook_source_directory',
    id_column: 'id',
    capability_read: 'webhooks.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'source_identifier', label: 'Source', mono: true, sortable: true, filterable: true },
      { key: 'provider_type', label: 'Provider', filterable: true, lookup: 'webhook_provider_type' },
      { key: 'mapping_label', label: 'Mapping', mono: true, sortable: true, filterable: true },
      { key: 'rate_limit_per_hour', label: 'Rate / hr', align: 'right', mono: true, sortable: true },
      { key: 'enabled', label: 'Enabled', filterable: true },
      { key: 'is_healthy', label: 'Healthy', filterable: true, sortable: true },
      { key: 'has_recent_errors', label: 'Errors 24h', filterable: true, sortable: true },
      { key: 'event_count_24h', label: 'Events 24h', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'error_count_24h', label: 'Errors 24h', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'rule_count', label: 'Rules', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'active_rule_count', label: 'Active rules', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_event_at', label: 'Last event', format: 'datetime', sortable: true },
      { key: 'last_event_status', label: 'Last status', sortable: true, filterable: true },
      { key: 'auth_token_masked', label: 'Token', mono: true },
    ],
  },
  webhook_inbox_directory: {
    relation: 'v_webhook_inbox_directory',
    id_column: 'id',
    capability_read: 'webhooks.read',
    scope_columns: { tenant: 'organization_id' },
    filters: [
      { key: 'id', column: 'id', op: 'eq' },
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'workflow_run_id', column: 'workflow_run_id', op: 'eq' },
      { key: 'idempotency_key', column: 'idempotency_key', op: 'eq' },
      { key: 'shipment_id', column: 'shipment_id', op: 'eq' },
      { key: 'mapping_config_id', column: 'mapping_config_id', op: 'eq' },
    ],
    columns: [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'source_label', label: 'Source', sortable: true, filterable: true },
      { key: 'source_identifier', label: 'Source ID', mono: true, sortable: true, filterable: true },
      { key: 'mapping_label', label: 'Mapping', mono: true, sortable: true, filterable: true },
      { key: 'mapping_target', label: 'Target', mono: true, sortable: true, filterable: true },
      { key: 'event_type', label: 'Event', sortable: true, filterable: true },
      { key: 'payload_size', label: 'Size', align: 'right', sortable: true },
      { key: 'external_id', label: 'External ID', mono: true },
      { key: 'processing_status', label: 'Status', sortable: true, filterable: true },
      { key: 'shipment_id', label: 'Shipment', mono: true, sortable: true, filterable: true },
      { key: 'tracking_number', label: 'Tracking', mono: true, sortable: true, filterable: true },
      { key: 'is_terminal', label: 'Terminal', filterable: true, sortable: true },
      { key: 'is_actionable', label: 'Actionable', filterable: true, sortable: true },
      { key: 'replay_count', label: 'Replays', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'force_status_count', label: 'Force-status', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_replay_at', label: 'Last replay', format: 'datetime', sortable: true },
      { key: 'last_replay_actor', label: 'Last actor', sortable: true, filterable: true },
      { key: 'age_seconds', label: 'Age (s)', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'age_hours', label: 'Age (h)', align: 'right', mono: true, sortable: true, type: 'number' },
    ],
  },
  webhook_auth_rejections: {
    relation: 'v_intake_auth_rejection_directory',
    id_column: 'id',
    capability_read: 'webhooks.read',
    scope_columns: { tenant: 'organization_id' },
    allow_view_relation: true,
    base_filter: {
      op: 'and',
      rules: [{ key: 'service', op: 'eq', value: 'webhook_receiver' }],
    },
    default_sort: { column: 'occurred_at', direction: 'desc' },
    filters: [
      { key: 'failure_code', column: 'failure_code', op: 'eq' },
      { key: 'http_status', column: 'http_status', op: 'eq' },
      { key: 'source_id', column: 'source_id', op: 'eq' },
      { key: 'correlation_id', column: 'correlation_id', op: 'eq' },
    ],
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'http_status', label: 'Status', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'failure_code', label: 'Failure', mono: true, sortable: true, filterable: true },
      { key: 'source_label', label: 'Source', sortable: true, filterable: true },
      { key: 'method', label: 'Method', mono: true, sortable: true, filterable: true },
      { key: 'path', label: 'Path', mono: true, sortable: true, filterable: true },
      { key: 'correlation_id', label: 'Correlation', mono: true, sortable: true, filterable: true },
    ],
  },
  mapping_config_directory: {
    relation: 'v_mapping_config_directory',
    id_column: 'id',
    capability_read: 'mappings.read',
    scope_columns: { tenant: 'organization_id' },
    filters: [
      { key: 'id', column: 'id', op: 'eq' },
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'mapping_type', column: 'mapping_type', op: 'eq' },
      { key: 'mapping_key', column: 'mapping_key', op: 'eq' },
      { key: 'target', column: 'target', op: 'eq' },
      { key: 'is_in_use', column: 'is_in_use', op: 'eq' },
    ],
    columns: [
      { key: 'mapping_type', label: 'Type', sortable: true, filterable: true, lookup: 'mapping_type' },
      { key: 'mapping_key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'target', label: 'Target', mono: true, sortable: true, filterable: true },
      { key: 'rules_count', label: 'Rules', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'source_count', label: 'Sources', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'rule_usage_count', label: 'Used by', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'is_in_use', label: 'In use', filterable: true, sortable: true },
      { key: 'has_rules', label: 'Has rules', filterable: true, sortable: true },
      { key: 'mapping_version', label: 'Version', align: 'right', mono: true, sortable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  integration_credential_directory: {
    relation: 'v_integration_credential_directory',
    id_column: 'id',
    capability_read: 'integrations.read',
    columns: [
      { key: 'id', label: 'Config', mono: true, sortable: true },
      { key: 'provider_label', label: 'Provider', sortable: true, filterable: true },
      { key: 'provider_kind', label: 'Provider kind', sortable: true, filterable: true },
      { key: 'provider_vendor', label: 'Vendor', sortable: true, filterable: true },
      { key: 'auth_type', label: 'Auth type', sortable: true, filterable: true, lookup: 'provider_auth_type' },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'is_expiring', label: 'Expiring', filterable: true, sortable: true },
      { key: 'is_expired', label: 'Expired', filterable: true, sortable: true },
      { key: 'days_until_expiry', label: 'Days', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_rotated_at', label: 'Last rotated', format: 'datetime', sortable: true },
      { key: 'expires_at', label: 'Expires', format: 'datetime', sortable: true },
    ],
  },
  integration_plugin_directory: {
    relation: 'v_integration_plugin_directory',
    id_column: 'id',
    capability_read: 'integration_plugins.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'plugin_key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'vendor', label: 'Vendor', sortable: true, filterable: true },
      { key: 'plugin_kind', label: 'Kind', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'version_label', label: 'Active version', mono: true, sortable: true },
      { key: 'active_version_status', label: 'Active status', sortable: true, filterable: true },
      { key: 'version_count', label: 'Versions', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'latest_version_status', label: 'Latest status', sortable: true, filterable: true },
      { key: 'binding_count', label: 'Bindings', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'active_binding_count', label: 'Active', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'install_count', label: 'Installs', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'has_active_version', label: 'Has active', filterable: true, sortable: true },
      { key: 'is_pending_review', label: 'Pending', filterable: true, sortable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // Mirrors public.bank_accounts (migration 202601221120). Authenticated SELECT for own org.
  bank_accounts: {
    relation: 'bank_accounts',
    id_column: 'id',
    capability_read: 'finance.read',
    columns: [
      { key: 'key', label: 'Key', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'bank_name', label: 'Bank' },
      { key: 'currency', label: 'Currency', mono: true },
      { key: 'balance', label: 'Balance', align: 'right', format: 'currency' },
      { key: 'open_items', label: 'Open items', align: 'right' },
      { key: 'last_match_at', label: 'Last match', format: 'datetime' },
    ],
  },
  // CLAIM-FLEET-DRIVERS (Wave 1, Phase A). Mirrors the canonical driver
  // projection introduced by supabase/migrations/202601311230_enterprise_ops_v1.sql
  // (driver_profiles L333-368, driver_documents L370-412,
  // driver_compliance_events L414-440). RLS / capability gating:
  // fleet.read / fleet.write (canonical SSOT — per FLEET Wave 5 re-audit
  // D3 closure, the FE-invented `drivers.read` / `drivers.write` keys do
  // NOT exist in the canonical rbac_permission lookup; cf.
  // supabase/migrations/202604280050_verify_driver_document_v1.sql:6
  // explicit disclaimer + verify_driver_document_v1.sql:43 capability
  // assertion against `fleet.write`).
  driver_profiles: {
    relation: 'driver_profiles',
    id_column: 'id',
    capability_read: 'fleet.read',
    capability_write: 'fleet.write',
    columns: [
      { key: 'name', label: 'Driver', sortable: true, filterable: true },
      { key: 'license_number', label: 'License #', mono: true, sortable: true, filterable: true },
      { key: 'license_expires_at', label: 'License expiry', format: 'date', sortable: true },
      { key: 'current_vehicle_id', label: 'Vehicle', mono: true, filterable: true },
      { key: 'current_branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'driver_status' },
      { key: 'compliance_score', label: 'Compliance', align: 'right', sortable: true, type: 'number' },
    ],
  },
  driver_documents: {
    relation: 'driver_documents',
    id_column: 'id',
    capability_read: 'fleet.read',
    capability_write: 'fleet.write',
    columns: [
      { key: 'kind', label: 'Kind', sortable: true, filterable: true, lookup: 'driver_document_kind' },
      { key: 'issuer', label: 'Issuer', sortable: true, filterable: true },
      { key: 'issued_at', label: 'Issued', format: 'date', sortable: true },
      { key: 'expires_at', label: 'Expires', format: 'date', sortable: true },
      { key: 'verified_at', label: 'Verified', format: 'datetime', sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'driver_document_status' },
    ],
  },
  driver_compliance_events: {
    relation: 'driver_compliance_events',
    id_column: 'id',
    capability_read: 'fleet.read',
    capability_write: 'fleet.write',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
      { key: 'severity', label: 'Severity', sortable: true, filterable: true, lookup: 'driver_compliance_severity' },
      { key: 'actor', label: 'Actor', mono: true, sortable: true, filterable: true },
    ],
  },
  // Paired projection view (W11-4): public.driver_profile_summary_v1 projects
  // the FE-friendly DriverProfileRow shape (name/initials/license_*/current_*/
  // hours_of_service_state/compliance_score/phone/emergency_*/deliveries_*/
  // on_time_pct/customer_rating) by joining driver_profiles + users +
  // driver_documents + vehicle_assignments. Read-only; SSOT remains
  // driver_profiles. FE consumption seam: drivers.tsx reads via
  // useResourceList<DriverProfileRow>('driver_profile_summary') so the operator
  // surface consumes server-derived projections without client-side joins.
  // Production cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable. See
  // supabase/migrations/202604301430_driver_profile_summary_v1.sql for the
  // canonical projection contract.
  driver_profile_summary: {
    relation: 'driver_profile_summary_v1',
    id_column: 'id',
      capability_read: 'fleet.read',
      filters: [
        { key: 'status', column: 'status', op: 'eq' },
        { key: 'plate_number', column: 'plate_number', op: 'ilike' },
        { key: 'branch_id', column: 'branch_id', op: 'eq' },
        { key: 'current_branch_id', column: 'current_branch_id', op: 'eq' },
      ],
      columns: [
      { key: 'name', label: 'Driver', sortable: true, filterable: true },
      { key: 'license_number', label: 'License #', mono: true, sortable: true, filterable: true },
      { key: 'license_expires_at', label: 'License expiry', format: 'date', sortable: true },
      { key: 'current_vehicle_id', label: 'Vehicle', mono: true, filterable: true },
      { key: 'current_branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'driver_status' },
      { key: 'hours_of_service_state', label: 'HOS', sortable: true, filterable: true },
      { key: 'compliance_score', label: 'Compliance', align: 'right', sortable: true, type: 'number' },
    ],
  },
  // Paired projection view (W11-4): public.vehicles_with_state_v1 projects the
  // FE-friendly VehicleRow.full shape (current_driver_user_id/
  // current_branch_id/fuel_level/odometer_km/last_telemetry_at/type_name) by
  // joining vehicles + vehicle_types + vehicle_assignments + vehicle_events.
  // Read-only; SSOT remains vehicles. FE consumption seam: vehicles.tsx reads
  // via useResourceList<VehicleRow>('vehicles_with_state') so the operator
  // surface consumes server-derived telemetry/state without client-side joins.
  // Production cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable. See
  // supabase/migrations/202604301440_vehicles_with_state_v1.sql for the
  // canonical projection contract.
  vehicles_with_state: {
    relation: 'vehicles_with_state_v1',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'plate_number', label: 'Plate', mono: true, sortable: true, filterable: true },
      { key: 'vin', label: 'VIN', mono: true, filterable: true },
      { key: 'type_name', label: 'Type', sortable: true, filterable: true },
      { key: 'current_driver_user_id', label: 'Driver', filterable: true, sortable: true },
      { key: 'current_branch_id', label: 'Branch', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'vehicle_status' },
      { key: 'fuel_level', label: 'Fuel', align: 'right', sortable: true },
      { key: 'odometer_km', label: 'Odometer (km)', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_telemetry_at', label: 'Last ping', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W29 FLEET closure):
  // public.v_vehicle_directory extends vehicles_with_state with branch +
  // vehicle_type label joins, active assignment resolution, telemetry
  // aggregates (last_event_at / event_count_24h), maintenance counters
  // (maintenance_window_count / active_maintenance_count / maintenance_due),
  // and status booleans (is_oos / is_in_maintenance). Read-only; SSOT
  // remains vehicles. See supabase/migrations/
  // 202604302700_v_vehicle_directory.sql for the projection contract +
  // supabase/tests/pgtap/zzw29_v_vehicle_directory.sql for shape/RLS tests.
  vehicle_directory: {
    relation: 'v_vehicle_directory',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'plate_number', label: 'Plate', mono: true, sortable: true, filterable: true },
      { key: 'vin', label: 'VIN', mono: true, filterable: true },
      { key: 'vehicle_type_label', label: 'Type', sortable: true, filterable: true },
      { key: 'current_driver_label', label: 'Driver', sortable: true, filterable: true },
      { key: 'branch_label', label: 'Branch', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'vehicle_status' },
      { key: 'event_count_24h', label: 'Events 24h', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'maintenance_due', label: 'Maint due', sortable: true, filterable: true },
      { key: 'is_oos', label: 'OOS', sortable: true, filterable: true },
      { key: 'last_event_at', label: 'Last event', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W29 FLEET closure):
  // public.v_driver_directory extends driver_profile_summary with active
  // assignment resolution, document/compliance/HOS counters, last_active_at,
  // status booleans (is_active / is_suspended / has_expired_documents),
  // and tenure_seconds. Read-only; SSOT remains driver_profiles. See
  // supabase/migrations/202604302710_v_driver_directory.sql for the
  // projection contract + supabase/tests/pgtap/zzw29_v_driver_directory.sql
  // for shape/RLS tests.
  driver_directory: {
    relation: 'v_driver_directory',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'user_full_name', label: 'Driver', sortable: true, filterable: true },
      { key: 'driver_code', label: 'Code', mono: true, sortable: true, filterable: true },
      { key: 'vehicle_label', label: 'Vehicle', mono: true, sortable: true, filterable: true },
      { key: 'branch_label', label: 'Branch', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'driver_status' },
      { key: 'document_count', label: 'Docs', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'expiring_document_count', label: 'Expiring', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'compliance_event_count_24h', label: 'Events 24h', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_active_at', label: 'Last active', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W29 FLEET closure):
  // public.v_driver_application_directory filters
  // marketplace_participant_requests to freelancer_driver applicants and
  // surfaces reviewer_label, capabilities/documents counts, lifecycle
  // booleans, age_seconds, sla_breach. Read-only; SSOT remains
  // marketplace_participant_requests. See supabase/migrations/
  // 202604302720_v_driver_application_directory.sql for the projection
  // contract + supabase/tests/pgtap/
  // zzw29_v_driver_application_directory.sql for shape/RLS tests.
  driver_application_directory: {
    relation: 'v_driver_application_directory',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'full_name', label: 'Applicant', sortable: true, filterable: true },
      { key: 'email', label: 'Email', mono: true, sortable: true, filterable: true },
      { key: 'phone', label: 'Phone', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'driver_application_status' },
      { key: 'reviewer_label', label: 'Reviewer', sortable: true, filterable: true },
      { key: 'verification_documents_count', label: 'Docs', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'submitted_document_count', label: 'Submitted', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'sla_breach', label: 'SLA breach', sortable: true, filterable: true },
      { key: 'created_at', label: 'Submitted', format: 'datetime', sortable: true },
      { key: 'reviewed_at', label: 'Decided', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W29 FLEET closure):
  // public.v_vehicle_maintenance_directory wraps vehicle_maintenance_windows
  // with vehicle/scheduled_by label joins, derived lifecycle booleans
  // (is_scheduled / is_completed / is_cancelled / is_in_progress /
  // is_overdue / is_terminal), and age/duration aggregates. Read-only;
  // SSOT remains vehicle_maintenance_windows. See supabase/migrations/
  // 202604302730_v_vehicle_maintenance_directory.sql for the projection
  // contract + supabase/tests/pgtap/
  // zzw29_v_vehicle_maintenance_directory.sql for shape/RLS tests.
  vehicle_maintenance_directory: {
    relation: 'v_vehicle_maintenance_directory',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'vehicle_label', label: 'Vehicle', mono: true, sortable: true, filterable: true },
      { key: 'reason', label: 'Reason', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'maintenance_window_status' },
      { key: 'window_start_at', label: 'Starts', format: 'datetime', sortable: true },
      { key: 'window_end_at', label: 'Ends', format: 'datetime', sortable: true },
      { key: 'is_overdue', label: 'Overdue', sortable: true, filterable: true },
      { key: 'is_in_progress', label: 'In progress', sortable: true, filterable: true },
      { key: 'scheduled_by_label', label: 'Scheduled by', sortable: true, filterable: true },
    ],
  },
  // CLAIM-NETWORK-ZONES (Wave 1, Phase A). Mirrors public.zones from
  // supabase/migrations/202512261200_zones_baskets.sql. RLS gated by
  // zones.read / zones.write (declared in the capability catalog below).
  //
  // W17-5 — alias `network_zones` retired in favor of canonical `zones` key
  // per `__audit__/DECISIONS/REGISTRY-ALIASES.md` §1 closure. The legacy
  // hub-keyed picker shape that previously occupied the `seed.zones` slot
  // (`domain-routes.js`) was removed in the same wave (dead code — no
  // `useResourceList<>('zones')` consumer ever existed). The canonical
  // `seed.zones` now sources from `network-zones.js` and mirrors
  // `public.zones` end-to-end.
  zones: {
    relation: 'zones',
    id_column: 'id',
    capability_read: 'zones.read',
    capability_write: 'zones.write',
    columns: [
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'slug', label: 'Slug', mono: true, sortable: true, filterable: true },
      { key: 'color_token', label: 'Color', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'zone_status' },
      { key: 'hub_code', label: 'Hub', mono: true, sortable: true, filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  zone_districts: {
    relation: 'zone_districts',
    id_column: 'zone_id',
    capability_read: 'zones.read',
    capability_write: 'zones.write',
    columns: [
      { key: 'zone_id', label: 'Zone', mono: true, sortable: true, filterable: true },
      { key: 'district_id', label: 'District', mono: true, sortable: true, filterable: true },
      { key: 'role', label: 'Role', sortable: true, filterable: true, lookup: 'zone_district_role' },
      { key: 'created_at', label: 'Linked', format: 'datetime', sortable: true },
    ],
  },
  zone_override_requests: {
    relation: 'zone_override_requests',
    id_column: 'id',
    capability_read: 'zones.read',
    capability_write: 'zones.write',
    columns: [
      { key: 'id', label: 'Request', mono: true, sortable: true },
      { key: 'zone_id', label: 'Zone', mono: true, sortable: true, filterable: true },
      { key: 'change_kind', label: 'Change', sortable: true, filterable: true, lookup: 'zone_override_kind' },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'zone_override_status' },
      { key: 'requested_by_user_id', label: 'Requested by', sortable: true, filterable: true },
      { key: 'created_at', label: 'Filed', format: 'datetime', sortable: true },
      { key: 'decision_at', label: 'Decided', format: 'datetime', sortable: true },
    ],
  },
  // W18-1 — Unified `branch_zones` registry entry (closes
  // `__audit__/DECISIONS/REGISTRY-ALIASES.md §2`). Previously two parallel
  // entries existed: `branch_zones` (capability_read: 'zones.read', columns:
  // branch_id/branch_label/zone_id/role) for the /network/zones surface and
  // `branch_zone_links` (capability_read: 'branches.read',
  // capability_write: 'branches.write', columns: branch_id/zone_id/priority)
  // for the /network/branches surface — both routed to the same canonical
  // backend table `public.branch_zones`. Merge resolution:
  //   • capability_read: 'branches.read' — branch zone assignment is a
  //     branch-management action; `branches.read` is granted to
  //     ops_admin + account_manager and is the more permissive read posture
  //     (super_admin wildcard already covers both). The /network/zones
  //     surface itself is gated on `zones.read` (only ops_admin), so
  //     dropping `zones.read` from this entry has no functional regression
  //     — operators that can render /network/zones already hold
  //     `branches.read` (ops_admin grants both per seed.js dev_roles).
  //   • capability_write: 'branches.write' — canonical write gate
  //     (`branch_zone_assign_v1` / `branch_zone_unassign_v1` are branch ops
  //     per supabase/migrations/202601300340_rbac_branches_write_gates_v1.sql).
  //   • columns: union of both prior projections (branch_id, branch_label,
  //     zone_id, priority). `role` was removed in W17-2 (canonical
  //     `public.branch_zones` has no `role` column; the FE renders priority
  //     bands instead).
  // Backend SSOT:
  //   supabase/migrations/202601212340_branches_coverage_foundation.sql:65
  branch_zones: {
    relation: 'branch_zones',
    id_column: 'zone_id',
    capability_read: 'branches.read',
    capability_write: 'branches.write',
    columns: [
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'branch_label', label: 'Label', sortable: true, filterable: true },
      { key: 'zone_id', label: 'Zone', mono: true, sortable: true, filterable: true },
      { key: 'priority', label: 'Priority', mono: true, sortable: true },
    ],
  },
  // Orchestrator patch: NETWORK-BRANCHES stalled before adding these. Mirrors
  // public.branches / branch_memberships / branch_capacity_windows / branch_coverage_windows
  // (supabase/migrations/202601212340_branches_coverage_foundation.sql).
  branches: {
    relation: 'branches',
    capability_read: 'branches.read',
    capability_write: 'branches.write',
    columns: [
      { key: 'name', label: 'Branch', sortable: true, filterable: true },
      { key: 'type', label: 'Type', sortable: true, filterable: true, lookup: 'branch_type' },
      { key: 'capacity_per_day', label: 'Capacity/day', mono: true, sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'branch_status' },
    ],
  },
  branch_memberships: {
    relation: 'branch_memberships',
    capability_read: 'branches.read',
    capability_write: 'branches.write',
    columns: [
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'user_id', label: 'User', mono: true, sortable: true, filterable: true },
      { key: 'role', label: 'Role', sortable: true, filterable: true },
    ],
  },
  // W18-3 — `branch_capacity_windows` registry remains a base-table
  // binding for inline-edit writes via `branch_capacity_window_set_v1`.
  // The FE heatmap reads through `branch_capacity_heatmap` (paired
  // projection view) which fans canonical
  // (day_of_week, [window_start_local, window_end_local)) ranges into
  // per-hour cells. The FE-fictional `weekday`/`hour`/`capacity_units`
  // columns are no longer declared on the base-table projection; the
  // canonical surface here is `day_of_week` + capacity jsonb.
  branch_capacity_windows: {
    relation: 'branch_capacity_windows',
    capability_read: 'branches.read',
    capability_write: 'branches.write',
    columns: [
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'day_of_week', label: 'Day of week', sortable: true, filterable: true, type: 'number', align: 'right' },
      { key: 'window_start_local', label: 'Start', mono: true, sortable: true },
      { key: 'window_end_local', label: 'End', mono: true, sortable: true },
      { key: 'priority', label: 'Priority', mono: true, sortable: true, type: 'number', align: 'right' },
    ],
  },
  // W18-3 — `weekday` column dropped (canonical
  // `public.branch_coverage_windows` is a continuous range with
  // `effective_from`/`effective_to` only — no day-of-week bucketing).
  // The FE only counts coverage rows for the KPI tile; the registry
  // surfaces canonical timestamps now.
  branch_coverage_windows: {
    relation: 'branch_coverage_windows',
    capability_read: 'branches.read',
    capability_write: 'branches.write',
    columns: [
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'effective_from', label: 'From', mono: true, sortable: true, format: 'datetime' },
      { key: 'effective_to', label: 'Until', mono: true, sortable: true, format: 'datetime' },
      { key: 'reason', label: 'Reason', sortable: true, filterable: true },
    ],
  },
  // Paired projection view (W11-2): public.v_branch_summary projects
  // (capacity_per_day, active_vehicles, active_routes, manager_user_id,
  // cutoff_time) from branches + branch_capacity_windows + vehicles +
  // route_runs + branch_memberships. Read-only; SSOT remains branches.
  // FE consumption seam: branches.tsx reads via
  // useResourceList<BranchSummaryRow>('branch_summary') for the derived
  // operational counters that the canonical `branches` table does not
  // store directly. Production cutover is a single getSupabaseClient()
  // branch flip in ui_list_resource_v1 — module call sites stay stable.
  // See supabase/migrations/202604301400_v_branch_summary.sql for the
  // canonical projection contract.
  branch_summary: {
    relation: 'v_branch_summary',
    id_column: 'branch_id',
    capability_read: 'branches.read',
    columns: [
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'code', label: 'Code', mono: true, sortable: true, filterable: true },
      { key: 'branch_type', label: 'Type', sortable: true, filterable: true, lookup: 'branch_type' },
      { key: 'capacity_per_day', label: 'Capacity/day', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'active_vehicles', label: 'Vehicles', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'active_routes', label: 'Routes', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'manager_user_id', label: 'Manager', mono: true, filterable: true },
      { key: 'cutoff_time', label: 'Cutoff', mono: true, sortable: true },
      { key: 'is_active', label: 'Active', filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W18-3): public.v_branch_capacity_heatmap fans
  // canonical (day_of_week, [window_start_local, window_end_local))
  // ranges from `public.branch_capacity_windows` into per-hour heatmap
  // cells with (weekday, hour, capacity_units, booked_units). Read-only;
  // SSOT remains branch_capacity_windows.
  //
  // FE consumption seam: branches.tsx reads through this projection key
  // so the heatmap renderer no longer depends on FE-fictional `hour` /
  // `capacity_units` columns on the base table. Production cutover is a
  // single getSupabaseClient() branch flip in ui_list_resource_v1 —
  // module call sites stay stable.
  // See supabase/migrations/202604301420_v_branch_capacity_heatmap.sql
  // for the canonical projection contract.
  branch_capacity_heatmap: {
    relation: 'v_branch_capacity_heatmap',
    id_column: 'id',
    capability_read: 'branches.read',
    columns: [
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'weekday', label: 'Weekday', mono: true, sortable: true, type: 'number', align: 'right' },
      { key: 'hour', label: 'Hour', mono: true, sortable: true, type: 'number', align: 'right' },
      { key: 'capacity_units', label: 'Capacity', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'booked_units', label: 'Booked', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'priority', label: 'Priority', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W11-2): public.v_zone_summary projects
  // (branch_count, district_count, pending_overrides, last_override_at,
  // hub_code, color_token) from zones + branch_zones + branches +
  // zone_districts + zone_override_requests. Read-only; SSOT remains zones.
  // FE consumption seam: zones.tsx reads via
  // useResourceList<ZoneSummaryRow>('zone_summary') for the derived counts
  // + hub_code projection that the canonical `zones` table does not store
  // directly. See supabase/migrations/202604301410_v_zone_summary.sql for
  // the canonical projection contract.
  zone_summary: {
    relation: 'v_zone_summary',
    id_column: 'zone_id',
    capability_read: 'zones.read',
    columns: [
      { key: 'zone_id', label: 'Zone', mono: true, sortable: true, filterable: true },
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'slug', label: 'Slug', mono: true, sortable: true, filterable: true },
      { key: 'is_active', label: 'Active', filterable: true },
      { key: 'branch_count', label: 'Branches', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'district_count', label: 'Districts', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'pending_overrides', label: 'Pending overrides', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_override_at', label: 'Last override', format: 'datetime', sortable: true },
      { key: 'hub_code', label: 'Hub', mono: true, sortable: true, filterable: true },
      { key: 'color_token', label: 'Color', sortable: true, filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  zone_performance_metrics: {
    relation: 'v_zone_performance_metrics',
    id_column: 'zone_id',
    capability_read: 'zones.read',
    columns: [
      { key: 'zone_id', label: 'Zone', mono: true, sortable: true, filterable: true },
      { key: 'shipments_today', label: 'Today', align: 'right', sortable: true, type: 'number' },
      { key: 'shipments_week', label: 'Week', align: 'right', sortable: true, type: 'number' },
      { key: 'on_time_pct', label: 'On time', align: 'right', sortable: true, type: 'number' },
      { key: 'capacity_saturation_pct', label: 'Capacity', align: 'right', sortable: true, type: 'number' },
    ],
  },
  // Paired projection view (W20): public.v_branch_zone_directory projects
  // per-row (branch_label, hub_code, branch_type, zone_label, zone_slug)
  // from branch_zones + branches + zones. Closes the deferred §10
  // BranchZoneRow.branch_label projection in
  // __audit__/SCHEMA-DRIFT/NETWORK.md (W18-3 deferral). Read-only; SSOT
  // remains branch_zones.
  // FE consumption seam: zones.tsx + zones-drawer.tsx Branches tab read
  // through useResourceList<>('branch_zone_directory') instead of inlining
  // the join in seed/render code. See
  // supabase/migrations/202604301800_v_branch_zone_directory.sql.
  branch_zone_directory: {
    relation: 'v_branch_zone_directory',
    id_column: 'id',
    capability_read: 'branches.read',
    scope_columns: { tenant: 'organization_id' },
    columns: [
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'branch_label', label: 'Label', sortable: true, filterable: true },
      { key: 'hub_code', label: 'Hub', mono: true, sortable: true, filterable: true },
      { key: 'branch_type', label: 'Type', sortable: true, filterable: true },
      { key: 'zone_id', label: 'Zone', mono: true, sortable: true, filterable: true },
      { key: 'zone_label', label: 'Zone label', sortable: true, filterable: true },
      { key: 'zone_slug', label: 'Zone slug', mono: true, sortable: true, filterable: true },
      { key: 'priority', label: 'Priority', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'created_at', label: 'Linked', format: 'datetime', sortable: true },
    ],
  },
  // CLAIM-FINANCE-BILLING (Wave 2, Phase B). Mirrors the canonical billing
  // projection contract:
  //   • billing_invoices / billing_invoice_lines / billing_invoice_events
  //   • subscriptions / subscription_events
  //   • usage_events
  //   • commercial_agreements / commercial_agreement_terms
  // RLS / capability gating: billing.read for SELECT, billing.write for
  // edits, invoices.send for the send-action gate, invoices.refund for the
  // refund-action gate (declared in the capability catalog below).
  billing_invoices: {
    relation: 'billing_invoices',
    id_column: 'id',
    capability_read: 'billing.read',
    capability_write: 'billing.write',
    columns: [
      { key: 'invoice_number', label: 'Invoice #', mono: true, sortable: true, filterable: true },
      { key: 'client_label', label: 'Customer', sortable: true, filterable: true },
      { key: 'period_start', label: 'Period start', format: 'date', sortable: true },
      { key: 'period_end', label: 'Period end', format: 'date', sortable: true },
      { key: 'total_amount', label: 'Total', mono: true, align: 'right', format: 'currency', sortable: true },
      { key: 'currency', label: 'CCY', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'invoice_status' },
      { key: 'due_date', label: 'Due', format: 'date', sortable: true },
      { key: 'sent_at', label: 'Issued', format: 'datetime', sortable: true },
      { key: 'paid_at', label: 'Paid', format: 'datetime', sortable: true },
    ],
  },
  billing_invoice_lines: {
    relation: 'billing_invoice_lines',
    id_column: 'id',
    capability_read: 'billing.read',
    capability_write: 'billing.write',
    columns: [
      { key: 'description', label: 'Description', sortable: true, filterable: true },
      { key: 'qty', label: 'Qty', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'unit_price', label: 'Unit price', mono: true, align: 'right', format: 'currency', sortable: true },
      { key: 'line_total', label: 'Line total', mono: true, align: 'right', format: 'currency', sortable: true },
    ],
  },
  billing_invoice_events: {
    relation: 'billing_invoice_events',
    id_column: 'id',
    capability_read: 'billing.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true, lookup: 'invoice_event_type' },
      { key: 'actor_user_id', label: 'Actor', mono: true, sortable: true, filterable: true },
    ],
  },
  subscriptions: {
    relation: 'subscriptions',
    id_column: 'id',
    capability_read: 'billing.read',
    capability_write: 'billing.write',
    // W17-1 — drop fictional/derived projection columns (`plan_label`,
    // `service_offering_id`, `billing_period`) per
    // __audit__/SCHEMA-DRIFT/FINANCE.md §4. Display labels resolve via
    // canonical metadata jsonb (or plan_key for label) in the FE module.
    columns: [
      { key: 'plan_key', label: 'Plan', mono: true, sortable: true, filterable: true },
      { key: 'client_id', label: 'Client', mono: true, sortable: true, filterable: true },
      { key: 'started_at', label: 'Started', format: 'datetime', sortable: true },
      { key: 'ended_at', label: 'Ended', format: 'datetime', sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'subscription_status' },
    ],
  },
  subscription_events: {
    relation: 'subscription_events',
    id_column: 'id',
    capability_read: 'billing.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'subscription_id', label: 'Subscription', mono: true, sortable: true, filterable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
    ],
  },
  usage_events: {
    relation: 'v_usage_event_directory',
    id_column: 'id',
    capability_read: 'billing.read',
    scope_columns: { tenant: 'organization_id', client: 'client_id', sender: 'sender_id' },
    columns: [
      { key: 'kind', label: 'Kind', sortable: true, filterable: true, lookup: 'usage_event_kind' },
      { key: 'qty', label: 'Qty', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'occurred_at', label: 'Occurred', format: 'datetime', sortable: true },
      { key: 'subscription_id', label: 'Subscription', mono: true, sortable: true, filterable: true },
    ],
  },
  commercial_agreements: {
    relation: 'v_commercial_agreement_directory',
    id_column: 'id',
    capability_read: 'billing.read',
    capability_write: 'billing.write',
    scope_columns: { tenant: 'organization_id', client: 'client_id', sender: 'sender_id' },
    // W17-1 — drop fictional `terms` display column per
    // __audit__/SCHEMA-DRIFT/FINANCE.md §6. Display label resolves via
    // canonical `title` / `agreement_code` (or `metadata.terms`) in the FE.
    columns: [
      { key: 'title', label: 'Title', sortable: true, filterable: true },
      { key: 'agreement_code', label: 'Code', mono: true, sortable: true, filterable: true },
      { key: 'client_id', label: 'Client', mono: true, sortable: true, filterable: true },
      { key: 'signed_at', label: 'Signed', format: 'date', sortable: true },
      { key: 'expires_at', label: 'Expires', format: 'date', sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'agreement_status' },
    ],
  },
  commercial_agreement_terms: {
    relation: 'v_commercial_agreement_term_directory',
    id_column: 'id',
    capability_read: 'billing.read',
    capability_write: 'billing.write',
    scope_columns: { tenant: 'organization_id', client: 'client_id', sender: 'sender_id' },
    // W17-1 — drop fictional `value` display column per
    // __audit__/SCHEMA-DRIFT/FINANCE.md §7. Canonical value resolves via
    // settings_versions.payload via settings_version_id; FE reads through
    // `metadata.value` until the settings_version_id projection lands.
    // W19-4 — rename column key `term_kind` → canonical `category` per
    // __audit__/SCHEMA-DRIFT/FINANCE.md §7. Canonical column is
    // `commercial_agreement_terms.category` (lowercase-only TEXT).
    columns: [
      { key: 'category', label: 'Term kind', sortable: true, filterable: true, lookup: 'agreement_term_kind' },
      { key: 'agreement_id', label: 'Agreement', mono: true, sortable: true, filterable: true },
    ],
  },
  // CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B). Mirrors the canonical service
  // catalog tables (public.service_levels + public.service_offerings) from
  // supabase/migrations/202601212700_branch_capacity_catalog.sql:68-180.
  // Write capability: canonical SSOT is `agreements.write` per
  // supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
  // (service_levels_write_policy + service_offerings_write_policy). Surface
  // aliases `service_offerings.read` / `service_offerings.write` are added in
  // the capability catalog below so the operator UI gating reads naturally;
  // grants are mirrored in seed.js (super_admin / ops_admin / account_manager).
  service_levels: {
    relation: 'service_levels',
    id_column: 'id',
    capability_read: 'service_offerings.read',
    capability_write: 'service_offerings.write',
    columns: [
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'description', label: 'Description' },
      { key: 'is_active', label: 'Active', filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  service_offerings: {
    relation: 'service_offerings',
    id_column: 'id',
    capability_read: 'service_offerings.read',
    capability_write: 'service_offerings.write',
    columns: [
      { key: 'service_level_id', label: 'Service level', mono: true, sortable: true, filterable: true },
      { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
      { key: 'zone_id', label: 'Zone', mono: true, sortable: true, filterable: true },
      { key: 'priority', label: 'Priority', align: 'right', sortable: true },
      { key: 'is_active', label: 'Active', sortable: true, filterable: true },
      { key: 'effective_from', label: 'Effective from', format: 'datetime', sortable: true },
      { key: 'effective_to', label: 'Effective to', format: 'datetime', sortable: true },
    ],
  },
  // CATALOG D3 close-out (W9-5). Mirrors the canonical lookup governance
  // tables (public.lookup_definitions + public.lookup_values) from
  // supabase/migrations/202510110003_mapping_lookup.sql lines 12-66. Surfaces
  // the canonical resource registry seam so /catalog/lookups can swap from
  // `api.seed.lookupsModule()` / `api.seed.lookupDefinitions()` to
  // `useResourceList('lookup_definitions')` / `useResourceList('lookup_values')`
  // — production swap is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1; module call sites stay stable.
  //
  // Capability gates:
  //   • lookups.read  → declared in the FE capabilities catalog below; backend
  //     RLS gate is `user_has_resource_capability_v1('lookup_values', 'read')`
  //     per supabase/migrations/202604031245_lookup_values_registry_capability_
  //     fallback_v1.sql.
  //   • lookups.write → FE-side gate today (the migration leaves
  //     lookup_definitions/lookup_values RLS write to default authenticated
  //     GRANT, see __audit__/CROSSWALK/CATALOG.md §3 row "lookups.write").
  lookup_definitions: {
    relation: 'lookup_definitions',
    id_column: 'id',
    capability_read: 'lookups.read',
    capability_write: 'lookups.write',
    columns: [
      { key: 'category', label: 'Category', mono: true, sortable: true, filterable: true },
      { key: 'description', label: 'Description', sortable: true, filterable: true },
      { key: 'owner_role', label: 'Owner', sortable: true, filterable: true },
      { key: 'approval_policy', label: 'Approval', sortable: true, filterable: true },
      { key: 'is_mutable', label: 'Mutable', filterable: true },
    ],
  },
  lookup_values: {
    relation: 'lookup_values',
    id_column: 'id',
    capability_read: 'lookups.read',
    capability_write: 'lookups.write',
    columns: [
      { key: 'lookup_definition_id', label: 'Definition', mono: true, sortable: true, filterable: true },
      { key: 'value', label: 'Value', mono: true, sortable: true, filterable: true },
      { key: 'label', label: 'Label', sortable: true, filterable: true },
      { key: 'sort_order', label: 'Sort order', align: 'right', sortable: true },
      { key: 'is_default', label: 'Default', filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'effective_from', label: 'From', format: 'datetime', sortable: true },
      { key: 'effective_until', label: 'Until', format: 'datetime', sortable: true },
    ],
  },
  // W31 — CATALOG paired projection views (read-only). Mirrors:
  //   • public.v_service_offering_directory   (supabase/migrations/202604302900_v_service_offering_directory.sql)
  //   • public.v_service_level_directory      (supabase/migrations/202604302910_v_service_level_directory.sql)
  //   • public.v_lookup_definition_directory  (supabase/migrations/202604302920_v_lookup_definition_directory.sql)
  // Capability gates mirror the underlying SSOT:
  //   - service_offering_directory:    service_offerings.read (alias to agreements.read)
  //   - service_level_directory:       service_offerings.read (alias to agreements.read)
  //   - lookup_definition_directory:   lookups.read
  // SSOT preserved on the underlying base tables; mutations continue via
  // the Phase B6 RPCs (service_offering_create/update/archive/toggle_v1,
  // service_level_create/update_v1, lookup_definition_create_v1,
  // lookup_value_create/update/archive/promote_v1).
  service_offering_directory: {
    relation: 'v_service_offering_directory',
    id_column: 'id',
    capability_read: 'service_offerings.read',
    scope_columns: { tenant: 'organization_id' },
    filters: [
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'id', column: 'id', op: 'eq' },
      { key: 'service_level_id', column: 'service_level_id', op: 'eq' },
      { key: 'branch_id', column: 'branch_id', op: 'eq' },
      { key: 'zone_id', column: 'zone_id', op: 'eq' },
      { key: 'level_key', column: 'level_key', op: 'eq' },
      { key: 'is_active', column: 'is_active', op: 'eq' },
      { key: 'effective_status', column: 'effective_status', op: 'eq' },
    ],
    columns: [
      { key: 'display_name', label: 'Name', sortable: true, filterable: true },
      { key: 'display_slug', label: 'Slug', mono: true, sortable: true, filterable: true },
      { key: 'level_key', label: 'Level', mono: true, sortable: true, filterable: true },
      { key: 'level_name', label: 'Level name', sortable: true },
      { key: 'tenant_label', label: 'Tenant', sortable: true, filterable: true },
      { key: 'branch_name', label: 'Branch', sortable: true, filterable: true },
      { key: 'zone_label', label: 'Zone', sortable: true, filterable: true },
      { key: 'effective_status', label: 'Status', sortable: true, filterable: true, lookup: 'service_offering_status' },
      { key: 'is_active_window', label: 'Window', filterable: true, sortable: true },
      { key: 'is_archived', label: 'Archived', filterable: true, sortable: true },
      { key: 'is_draft', label: 'Draft', filterable: true, sortable: true },
      { key: 'base_price', label: 'Price', align: 'right', mono: true, sortable: true, format: 'currency' },
      { key: 'currency', label: 'Currency', mono: true, sortable: true, filterable: true },
      { key: 'max_weight_kg', label: 'Max weight', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'priority', label: 'Priority', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'active_subscription_count', label: 'Active subs', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'effective_from', label: 'Effective from', format: 'datetime', sortable: true },
      { key: 'effective_to', label: 'Effective to', format: 'datetime', sortable: true },
      { key: 'last_updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  service_level_directory: {
    relation: 'v_service_level_directory',
    id_column: 'id',
    capability_read: 'service_offerings.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'tier', label: 'Tier', sortable: true, filterable: true, lookup: 'service_level_tier' },
      { key: 'priority_rank', label: 'Rank', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'sla_minutes', label: 'SLA (min)', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'sla_label', label: 'SLA label', sortable: true },
      { key: 'tenant_label', label: 'Tenant', sortable: true, filterable: true },
      { key: 'is_active', label: 'Active', filterable: true, sortable: true },
      { key: 'offering_count', label: 'Offerings', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'active_offering_count', label: 'Active offerings', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'active_subscription_count', label: 'Active subs', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  lookup_definition_directory: {
    relation: 'v_lookup_definition_directory',
    id_column: 'id',
    capability_read: 'lookups.read',
    columns: [
      { key: 'category', label: 'Category', mono: true, sortable: true, filterable: true },
      { key: 'description', label: 'Description', sortable: true, filterable: true },
      { key: 'owner_role', label: 'Owner', sortable: true, filterable: true },
      { key: 'approval_policy', label: 'Approval', sortable: true, filterable: true },
      { key: 'is_mutable', label: 'Mutable', filterable: true },
      { key: 'value_count', label: 'Values', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'active_value_count', label: 'Active', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'draft_value_count', label: 'Draft', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'archived_value_count', label: 'Archived', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'retired_value_count', label: 'Retired', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'has_default', label: 'Has default', filterable: true, sortable: true },
      { key: 'default_value', label: 'Default value', mono: true, sortable: true },
      { key: 'default_value_label', label: 'Default label', sortable: true },
      { key: 'last_value_updated_at', label: 'Last value', format: 'datetime', sortable: true },
      { key: 'last_updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // CLAIM-NETWORK-MARKETPLACE (Wave 2, Phase B). Mirrors the canonical
  // marketplace lifecycle projection contract:
  //   • marketplace_offers / marketplace_awards / marketplace_contracts
  //   • marketplace_requests / marketplace_request_items
  //   • marketplace_availability_windows
  //   • marketplace_reputation_snapshots / marketplace_events
  // RLS / capability gating: marketplace.read for SELECT, marketplace.write
  // for award/cancel/activate/refresh-reputation actions.
  // W18-3 — `lane`/`price`/`currency` registry columns dropped from the
  // canonical projection. Canonical `public.marketplace_offers` carries
  // them inside `terms` jsonb (lane) and `pricing` jsonb (price/currency).
  // The FE renders these via `laneOf` / `priceOf` / `currencyOf` helpers
  // (marketplace.tsx) under stable column keys; the registry no longer
  // declares them as base-table SELECT columns.
  marketplace_offers: {
    relation: 'marketplace_offers',
    id_column: 'id',
    capability_read: 'marketplace.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'id', label: 'Offer #', mono: true, sortable: true },
      { key: 'participant_id', label: 'Bidder', mono: true, sortable: true, filterable: true },
      { key: 'valid_until', label: 'Valid until', format: 'datetime', sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'marketplace_offer_status' },
      { key: 'submitted_at', label: 'Submitted', format: 'datetime', sortable: true },
    ],
  },
  marketplace_awards: {
    relation: 'marketplace_awards',
    id_column: 'id',
    capability_read: 'marketplace.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'id', label: 'Award #', mono: true, sortable: true },
      { key: 'offer_id', label: 'Offer', mono: true, sortable: true, filterable: true },
      { key: 'participant_id', label: 'Participant', mono: true, sortable: true, filterable: true },
      { key: 'awarded_at', label: 'Awarded', format: 'datetime', sortable: true },
      { key: 'awarded_by', label: 'Awarded by', sortable: true, filterable: true },
      { key: 'terms_summary', label: 'Terms', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'marketplace_award_status' },
    ],
  },
  // W18-2 — alias unification: `marketplace_contracts_v2` → canonical
  // `marketplace_contracts`. The legacy `marketplace_contracts` registry
  // entry (partial-roster shape consumed by /network/partners) was a seed
  // pass-through only (no separate registry entry); it has been retired
  // now that `partners.tsx` consumes the canonical lifecycle shape
  // (started_at / ends_at / terms / award_id / metadata.contract_no). The
  // single registry entry below is the SSOT for both /network/partners and
  // /network/marketplace contract reads. See
  // `__audit__/DECISIONS/REGISTRY-ALIASES.md` §3 closure.
  marketplace_contracts: {
    relation: 'marketplace_contracts',
    id_column: 'id',
    capability_read: 'marketplace.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'contract_no', label: 'Contract #', mono: true, sortable: true, filterable: true },
      { key: 'participant_id', label: 'Participant', mono: true, sortable: true, filterable: true },
      { key: 'started_at', label: 'Started', format: 'datetime', sortable: true },
      { key: 'ends_at', label: 'Ends', format: 'datetime', sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'marketplace_contract_status' },
      { key: 'terms', label: 'Terms', sortable: true, filterable: true },
    ],
  },
  marketplace_requests: {
    relation: 'marketplace_requests',
    id_column: 'id',
    capability_read: 'marketplace.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'id', label: 'Request #', mono: true, sortable: true },
      { key: 'request_kind', label: 'Kind', sortable: true, filterable: true, lookup: 'marketplace_request_kind' },
      { key: 'opener', label: 'Opened by', sortable: true, filterable: true },
      { key: 'opened_at', label: 'Opened', format: 'datetime', sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'marketplace_request_status' },
      { key: 'response_count', label: 'Bids', mono: true, align: 'right', sortable: true, type: 'number' },
    ],
  },
  // W18-3 — `qty` registry column dropped from the canonical projection.
  // Canonical `public.marketplace_request_items` carries qty inside
  // `payload` jsonb under `qty`. The FE renders it via `qtyOf(item)`
  // (marketplace.tsx) under a stable column key; the registry no longer
  // declares it as a base-table SELECT column.
  marketplace_request_items: {
    relation: 'marketplace_request_items',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'request_id', label: 'Request', mono: true, sortable: true, filterable: true },
      { key: 'item_kind', label: 'Item kind', mono: true, sortable: true, filterable: true },
    ],
  },
  marketplace_availability_windows: {
    relation: 'marketplace_availability_windows',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'participant_id', label: 'Participant', mono: true, sortable: true, filterable: true },
      { key: 'weekday', label: 'Weekday', sortable: true, filterable: true },
      { key: 'hour', label: 'Hour', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'capacity', label: 'Capacity', mono: true, align: 'right', sortable: true, type: 'number' },
    ],
  },
  marketplace_reputation_snapshots: {
    relation: 'marketplace_reputation_snapshots',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'participant_id', label: 'Participant', mono: true, sortable: true, filterable: true },
      { key: 'snapshot_at', label: 'Snapshot', format: 'datetime', sortable: true },
      { key: 'score', label: 'Score', mono: true, align: 'right', sortable: true, type: 'number' },
    ],
  },
  marketplace_events: {
    relation: 'marketplace_events',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'participant_id', label: 'Participant', mono: true, sortable: true, filterable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
    ],
  },
  // W13-4 — canonical marketplace participant graph (multi-table). Earlier
  // audits flagged FE flat shape on MarketplaceParticipantRow; canonical
  // graph is split across 4 tables in
  // supabase/migrations/202603071100_marketplace_network_foundation_v1.sql.
  // The participant drawer aggregates active memberships, active capabilities
  // and verification posture so operators see the full onboarding picture.
  marketplace_participant_profiles: {
    relation: 'marketplace_participant_profiles',
    id_column: 'id',
    capability_read: 'marketplace.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'id', label: 'Profile', mono: true, sortable: true },
      { key: 'display_name', label: 'Name', sortable: true, filterable: true },
      { key: 'participant_type_key', label: 'Type', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'listing_status', label: 'Listing', sortable: true, filterable: true },
      { key: 'compliance_state', label: 'Compliance', sortable: true, filterable: true },
      { key: 'rating_overall', label: 'Rating', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'rating_count', label: '# Ratings', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'last_verified_at', label: 'Last verified', format: 'datetime', sortable: true },
    ],
  },
  marketplace_participant_memberships: {
    relation: 'marketplace_participant_memberships',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'participant_profile_id', label: 'Profile', mono: true, sortable: true, filterable: true },
      { key: 'user_id', label: 'User', mono: true, sortable: true, filterable: true },
      { key: 'membership_role', label: 'Role', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'is_primary', label: 'Primary', filterable: true },
    ],
  },
  marketplace_participant_capabilities: {
    relation: 'marketplace_participant_capabilities',
    id_column: 'id',
    capability_read: 'marketplace.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'participant_profile_id', label: 'Profile', mono: true, sortable: true, filterable: true },
      { key: 'capability_key', label: 'Capability', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
    ],
  },
  marketplace_verification_records: {
    relation: 'marketplace_verification_records',
    id_column: 'id',
    capability_read: 'marketplace.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'participant_profile_id', label: 'Profile', mono: true, sortable: true, filterable: true },
      { key: 'document_type_key', label: 'Document', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'issued_at', label: 'Issued', format: 'datetime', sortable: true },
      { key: 'expires_at', label: 'Expires', format: 'datetime', sortable: true },
      { key: 'reviewed_at', label: 'Reviewed', format: 'datetime', sortable: true },
    ],
  },
  // W13-4 — canonical reputation event ledger. Per-event scoring deltas
  // drive the snapshot rollups; surfaces in the reputation drawer so
  // operators can see WHY a participant's score moved.
  marketplace_reputation_events: {
    relation: 'marketplace_reputation_events',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'participant_profile_id', label: 'Participant', mono: true, sortable: true, filterable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
      { key: 'metric_key', label: 'Metric', mono: true, sortable: true, filterable: true },
      { key: 'score_delta', label: 'Delta', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'weight', label: 'Weight', mono: true, align: 'right', sortable: true, type: 'number' },
    ],
  },
  // Phase D5 — pre-approval queue for marketplace participant onboarding.
  // Mirrors public.marketplace_participant_requests (canonical resource
  // registry entry seeded in
  // supabase/migrations/202603071140_marketplace_ui_access_v1.sql:198-212).
  // Capability split is canonical: `.read` gates the queue read, `.review`
  // gates Approve/Reject actions routed through
  // `marketplace_participant_request_review_apply_v1` (already wired via
  // api.ts + queries.ts hook `useReviewMarketplaceParticipantRequest`).
  marketplace_participant_requests: {
    relation: 'marketplace_participant_requests',
    id_column: 'id',
    capability_read: 'marketplace_participant_requests.read',
    capability_write: 'marketplace_participant_requests.review',
    columns: [
      { key: 'id', label: 'Request #', mono: true, sortable: true },
      { key: 'requested_participant_type_key', label: 'Type', mono: true, sortable: true, filterable: true },
      { key: 'organization_name', label: 'Organization', sortable: true, filterable: true },
      { key: 'full_name', label: 'Applicant', sortable: true, filterable: true },
      { key: 'email', label: 'Email', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'created_at', label: 'Submitted', format: 'datetime', sortable: true },
      { key: 'reviewed_at', label: 'Reviewed', format: 'datetime', sortable: true },
    ],
  },
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C). Mirrors the canonical API
  // gateway observability projection contract:
  //   • api_call_log / api_gateway_requests
  //   • api_gateway_rate_limits
  //   • api_routes / api_route_packs
  //   • provider_health_logs (downstream provider latency cross-link)
  // RLS / capability gating: api_gateway.read for SELECT, api_gateway.write
  // for block-source / adjust-rate-limit (declared in the capability catalog
  // below). Datadog APM / Honeycomb / Postman observability parity.
  api_call_log: {
    relation: 'api_call_log',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    columns: [
      // W14-2 — canonical SSOT columns from public.api_call_log + the
      // projection-friendly `path` / `status_code` / `occurred_at` aliases
      // exposed by `public.v_api_gateway_observability`. The FE consumes the
      // surface via the `api_gateway_observability` resource (below); the
      // legacy `api_call_log` resource remains for direct canonical reads.
      { key: 'method', label: 'Method', sortable: true, filterable: true, lookup: 'api_method' },
      { key: 'url', label: 'URL', mono: true, sortable: true, filterable: true },
      { key: 'response_status', label: 'Status', mono: true, align: 'right', sortable: true, filterable: true, type: 'number' },
      { key: 'duration_ms', label: 'Duration', mono: true, align: 'right', sortable: true, format: 'ms', type: 'number' },
      { key: 'timestamp', label: 'When', format: 'datetime', sortable: true },
    ],
  },
  // W14-2 — canonical projection view backing the FE `ApiCallRow` shape.
  // SSOT view: `public.v_api_gateway_observability` (joined projection over
  // api_call_log + api_gateway_requests + api_routes + webhook_sources).
  // Closes the W11/W13 deferred drift on `ApiCallRow` (8 REMOVE + 6 RENAME)
  // per `__audit__/SCHEMA-DRIFT/INSIGHTS.md §1`.
  api_gateway_observability: {
    relation: 'v_api_gateway_observability',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    columns: [
      { key: 'method', label: 'Method', sortable: true, filterable: true, lookup: 'api_method' },
      { key: 'path', label: 'Path', mono: true, sortable: true, filterable: true },
      { key: 'status_code', label: 'Status', mono: true, align: 'right', sortable: true, filterable: true, type: 'number' },
      { key: 'duration_ms', label: 'Duration', mono: true, align: 'right', sortable: true, format: 'ms', type: 'number' },
      { key: 'source_label', label: 'Source', sortable: true, filterable: true },
      { key: 'route_pack_id', label: 'Route pack', mono: true, sortable: true, filterable: true },
      { key: 'error_code', label: 'Error code', mono: true, sortable: true, filterable: true },
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
    ],
  },
  // W14-2 — paired projection view backing the FE `RateLimitRow` shape.
  // SSOT view: `public.v_api_gateway_rate_limits_summary` (joined projection
  // over api_gateway_rate_limits + webhook_sources). Closes the W11/W13
  // deferred drift on `RateLimitRow` (4 REMOVE + 2 RENAME) per
  // `__audit__/SCHEMA-DRIFT/INSIGHTS.md §2`.
  api_gateway_rate_limits_summary: {
    relation: 'v_api_gateway_rate_limits_summary',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    capability_write: 'api_gateway.write',
    columns: [
      { key: 'source_label', label: 'Source', sortable: true, filterable: true },
      { key: 'limit_per_min', label: 'Limit / min', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'limit_per_hour', label: 'Limit / hour', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'current_usage', label: 'Usage', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'saturated', label: 'Saturated', sortable: true, filterable: true },
      { key: 'window_start', label: 'Window start', format: 'datetime', sortable: true },
    ],
  },
  api_gateway_requests: {
    relation: 'api_gateway_requests',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    columns: [
      { key: 'request_id', label: 'Request ID', mono: true, sortable: true, filterable: true },
      { key: 'route_id', label: 'Route', mono: true, sortable: true, filterable: true },
      { key: 'route_pack_id', label: 'Route pack', mono: true, sortable: true, filterable: true },
      { key: 'status_code', label: 'Status', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'error_code', label: 'Error code', mono: true, sortable: true, filterable: true },
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
    ],
  },
  api_gateway_auth_rejections: {
    relation: 'v_intake_auth_rejection_directory',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    scope_columns: { tenant: 'organization_id' },
    allow_view_relation: true,
    base_filter: {
      op: 'and',
      rules: [{ key: 'service', op: 'eq', value: 'api_gateway' }],
    },
    default_sort: { column: 'occurred_at', direction: 'desc' },
    filters: [
      { key: 'failure_code', column: 'failure_code', op: 'eq' },
      { key: 'http_status', column: 'http_status', op: 'eq' },
      { key: 'source_id', column: 'source_id', op: 'eq' },
      { key: 'correlation_id', column: 'correlation_id', op: 'eq' },
    ],
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'http_status', label: 'Status', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'failure_code', label: 'Failure', mono: true, sortable: true, filterable: true },
      { key: 'source_label', label: 'Source', sortable: true, filterable: true },
      { key: 'method', label: 'Method', mono: true, sortable: true, filterable: true },
      { key: 'path', label: 'Path', mono: true, sortable: true, filterable: true },
      { key: 'correlation_id', label: 'Correlation', mono: true, sortable: true, filterable: true },
    ],
  },
  api_gateway_rate_limits: {
    relation: 'api_gateway_rate_limits',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    capability_write: 'api_gateway.write',
    columns: [
      { key: 'source_label', label: 'Source', sortable: true, filterable: true },
      { key: 'route_path', label: 'Route', mono: true, sortable: true, filterable: true },
      { key: 'route_method', label: 'Method', sortable: true, filterable: true },
      { key: 'limit_per_min', label: 'Limit / min', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'current_usage', label: 'Usage', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'saturated', label: 'Saturated', sortable: true, filterable: true },
      { key: 'window_start', label: 'Window start', format: 'datetime', sortable: true },
    ],
  },
  api_routes: {
    relation: 'api_routes',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    columns: [
      { key: 'method', label: 'Method', sortable: true, filterable: true },
      { key: 'path_pattern', label: 'Path pattern', mono: true, sortable: true, filterable: true },
      { key: 'route_pack_id', label: 'Route pack', mono: true, sortable: true, filterable: true },
      { key: 'deprecated', label: 'Deprecated', sortable: true, filterable: true },
    ],
  },
  api_route_packs: {
    relation: 'api_route_packs',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'version', label: 'Version', mono: true, sortable: true, filterable: true },
      { key: 'description', label: 'Description', sortable: true, filterable: true },
    ],
  },
  provider_health_logs: {
    relation: 'provider_health_logs',
    id_column: 'id',
    capability_read: 'api_gateway.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'provider_id', label: 'Provider', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'provider_health_status' },
      { key: 'latency_ms', label: 'Latency', mono: true, align: 'right', sortable: true, format: 'ms', type: 'number' },
      { key: 'error_message', label: 'Error', sortable: true, filterable: true },
    ],
  },
  // CLAIM-INSIGHTS-REPORTING (Phase F1). Mirrors the canonical KPI catalog +
  // daily rollups projection from supabase/migrations/
  // 202601311830_kpi_catalog_rollups_v1.sql:
  //   • kpi_definitions     (id, organization_id, key, name, description, unit,
  //                          definition jsonb, is_active, metadata, created_at)
  //   • kpi_rollups_daily   (id, organization_id, kpi_key, day, dimensions,
  //                          value_num, numerator, denominator, idempotency_key,
  //                          metadata, created_at)
  // Capability gate `insights.read` (already declared in the capabilities
  // catalog below + granted to super_admin / ops_admin / account_manager in
  // seed.js). Surfaced via `useResourceList('kpi_definitions')` /
  // `useResourceList('kpi_rollups_daily')` and the typed `useKpiRollup` hook.
  kpi_definitions: {
    relation: 'kpi_definitions',
    id_column: 'id',
    capability_read: 'insights.read',
    columns: [
      { key: 'key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'unit', label: 'Unit', sortable: true, filterable: true },
      { key: 'is_active', label: 'Active', sortable: true, filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  kpi_rollups_daily: {
    relation: 'kpi_rollups_daily',
    id_column: 'id',
    capability_read: 'insights.read',
    columns: [
      { key: 'kpi_key', label: 'KPI', mono: true, sortable: true, filterable: true },
      { key: 'day', label: 'Day', format: 'date', sortable: true },
      { key: 'value_num', label: 'Value', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'numerator', label: 'Numerator', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'denominator', label: 'Denominator', mono: true, align: 'right', sortable: true, type: 'number' },
    ],
  },
  // W30 — paired projection view backing the FE-friendly KPI directory shape.
  // SSOT view: `public.v_kpi_rollup_directory` (joined projection over
  // kpi_definitions + most-recent kpi_rollups_daily). Surfaces resolved
  // kpi_label / kpi_unit / group_label / format / tone (definition jsonb),
  // latest day / value_num / numerator / denominator, scope_label (derived
  // from dimensions JSONB), age_seconds, and lifecycle booleans
  // (is_active / is_fresh / is_stale / has_rollup). See
  // supabase/migrations/202604302800_v_kpi_rollup_directory.sql for the
  // projection contract + supabase/tests/pgtap/zzw30_v_kpi_rollup_directory.sql
  // for shape/RLS tests.
  kpi_rollup_directory: {
    relation: 'v_kpi_rollup_directory',
    id_column: 'id',
    capability_read: 'insights.read',
    columns: [
      { key: 'kpi_key', label: 'KPI', mono: true, sortable: true, filterable: true },
      { key: 'kpi_label', label: 'Label', sortable: true, filterable: true },
      { key: 'group_label', label: 'Group', sortable: true, filterable: true },
      { key: 'format', label: 'Format', mono: true, sortable: true, filterable: true },
      { key: 'value_num', label: 'Value', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'scope_label', label: 'Scope', mono: true, sortable: true, filterable: true },
      { key: 'is_fresh', label: 'Fresh', sortable: true, filterable: true },
      { key: 'has_rollup', label: 'Has rollup', sortable: true, filterable: true },
      { key: 'rollup_updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // W30 — paired projection view backing the FE-friendly decision_log
  // directory shape. SSOT view: `public.v_decision_log_directory` (joined
  // projection over decision_log + settings_resolution_log via
  // settings_resolution_id). Surfaces canonical decision_log columns plus
  // projected resolved_from / scope_path / scope_category / winning_*
  // and derived age_seconds / has_correlation / has_resolution. See
  // supabase/migrations/202604302810_v_decision_log_directory.sql for the
  // projection contract + supabase/tests/pgtap/zzw30_v_decision_log_directory.sql
  // for shape/RLS tests.
  decision_log_directory: {
    relation: 'v_decision_log_directory',
    id_column: 'id',
    capability_read: 'observability.read',
    columns: [
      { key: 'timestamp', label: 'When', format: 'datetime', sortable: true },
      { key: 'decision_category', label: 'Category', sortable: true, filterable: true, lookup: 'decision_category' },
      { key: 'resource_type', label: 'Resource', sortable: true, filterable: true },
      { key: 'resource_id', label: 'Resource ID', mono: true, filterable: true },
      { key: 'resolved_from', label: 'Scope', sortable: true, filterable: true },
      { key: 'scope_category', label: 'Scope category', mono: true, filterable: true },
      { key: 'has_correlation', label: 'Has trace', sortable: true, filterable: true },
      { key: 'has_resolution', label: 'Has resolution', sortable: true, filterable: true },
      { key: 'settings_resolution_id', label: 'Resolution', mono: true },
    ],
  },
  // W30 — paired projection view backing the FE-friendly
  // settings_resolution_log directory shape. SSOT view:
  // `public.v_settings_resolution_directory` (derived projection over
  // settings_resolution_log). Surfaces canonical columns plus derived
  // ladder_levels_visited (jsonb_array_length(scope_path)), override_count
  // (non-global has_value=true entries), age_seconds, and winner-bucket
  // booleans (is_global_winner / is_tenant_winner / is_client_winner /
  // is_sender_winner). See
  // supabase/migrations/202604302820_v_settings_resolution_directory.sql for
  // the projection contract + supabase/tests/pgtap/zzw30_v_settings_resolution_directory.sql
  // for shape/RLS tests.
  settings_resolution_directory: {
    relation: 'v_settings_resolution_directory',
    id_column: 'id',
    capability_read: 'observability.read',
    columns: [
      { key: 'resolved_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'category', label: 'Category', mono: true, sortable: true, filterable: true },
      { key: 'winning_scope_type', label: 'Scope', sortable: true, filterable: true },
      { key: 'ladder_levels_visited', label: 'Levels', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'override_count', label: 'Overrides', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'is_global_winner', label: 'Global', sortable: true, filterable: true },
      { key: 'is_tenant_winner', label: 'Tenant', sortable: true, filterable: true },
    ],
  },
  // W30 — paired projection view backing the FE-friendly ui_event_log
  // directory shape. SSOT view: `public.v_ui_event_log_directory` (derived
  // projection over ui_event_log). Surfaces canonical columns plus
  // path_label (= event_context OR meta->>path), command_label
  // (= event_name OR meta->>command), age_seconds, and lifecycle booleans
  // (is_action / has_resolution / has_scope). See
  // supabase/migrations/202604302830_v_ui_event_log_directory.sql for the
  // projection contract + supabase/tests/pgtap/zzw30_v_ui_event_log_directory.sql
  // for shape/RLS tests.
  ui_event_log_directory: {
    relation: 'v_ui_event_log_directory',
    id_column: 'id',
    capability_read: 'observability.read',
    columns: [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', sortable: true, filterable: true },
      { key: 'app', label: 'App', sortable: true, filterable: true },
      { key: 'path_label', label: 'Path', mono: true, sortable: true, filterable: true },
      { key: 'command_label', label: 'Command', mono: true, sortable: true, filterable: true },
      { key: 'user_id', label: 'User', mono: true, sortable: true, filterable: true },
      { key: 'is_action', label: 'Action', sortable: true, filterable: true },
      { key: 'has_resolution', label: 'Has resolution', sortable: true, filterable: true },
    ],
  },
  // CLAIM-SUPPORT-CASES (Wave 3, Phase C). Mirrors the canonical support
  // projection contract from
  // supabase/migrations/202601311720_support_cases_foundation_v1.sql:
  //   • support_cases               (projection)
  //   • support_messages            (immutable ledger)
  //   • support_case_events         (immutable status/lifecycle ledger)
  // RLS / capability gating: support.read for SELECT, support.write for
  // assignment / status / message authorship (declared in the capability
  // catalog below). Zendesk / Front / Linear-triage parity surface.
  //
  // Wave 5 RE-AUDIT (SUPPORT.md §8 D2) — relation pinned to
  // `v_support_case_summary` so the FE reads server-computed
  // `last_message_at` / `message_count` / `sla_breached` enrichment
  // (B3 migration 202604271210). The view is `security_invoker = true`,
  // so RLS on the underlying tables governs access. Seed mode mirrors the
  // view shape so the swap is transparent at the call site.
  support_cases: {
    relation: 'v_support_case_summary',
    id_column: 'id',
    capability_read: 'support.read',
    capability_write: 'support.write',
    columns: [
      { key: 'subject', label: 'Subject', sortable: true, filterable: true },
      { key: 'client_id', label: 'Client', mono: true, sortable: true, filterable: true },
      { key: 'channel', label: 'Channel', sortable: true, filterable: true, lookup: 'support_message_channel' },
      { key: 'priority', label: 'Priority', sortable: true, filterable: true, lookup: 'support_case_priority' },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'support_case_status' },
      { key: 'assigned_to', label: 'Assignee', mono: true, sortable: true, filterable: true },
      { key: 'opened_at', label: 'Opened', format: 'datetime', sortable: true },
      { key: 'sla_due_at', label: 'SLA due', format: 'datetime', sortable: true },
      { key: 'last_message_at', label: 'Last message', format: 'datetime', sortable: true },
      { key: 'message_count', label: 'Msgs', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'sla_breached', label: 'SLA breached', sortable: true, filterable: true },
    ],
  },
  support_messages: {
    relation: 'support_messages',
    id_column: 'id',
    capability_read: 'support.read',
    capability_write: 'support.write',
    columns: [
      { key: 'sent_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'author_role', label: 'Role', sortable: true, filterable: true, lookup: 'support_message_role' },
      { key: 'author_name', label: 'Author', sortable: true, filterable: true },
      { key: 'channel', label: 'Channel', sortable: true, filterable: true, lookup: 'support_message_channel' },
      { key: 'direction', label: 'Direction', sortable: true, filterable: true, lookup: 'support_message_direction' },
      { key: 'body', label: 'Body' },
    ],
  },
  // W18-4 schema-drift closure — canonical column on
  // public.support_case_events is `created_at` (not `occurred_at`); the FE
  // row interface (cases.tsx SupportCaseEventRow) and seed factory
  // (support.js makeEvent) both emit `created_at`. Registry column key
  // realigned so DataTable headers, sort, and live-mode reads stay
  // consistent with the canonical migration
  // (supabase/migrations/202601311720_support_cases_foundation_v1.sql:272-295).
  support_case_events: {
    relation: 'support_case_events',
    id_column: 'id',
    capability_read: 'support.read',
    columns: [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true, lookup: 'support_case_event_type' },
      { key: 'actor_user_id', label: 'Actor', mono: true, sortable: true, filterable: true },
      { key: 'from_status', label: 'From', sortable: true, filterable: true, lookup: 'support_case_status' },
      { key: 'to_status', label: 'To', sortable: true, filterable: true, lookup: 'support_case_status' },
    ],
  },
  // W26 paired projection — `public.v_support_case_directory` (read-only
  // canonical view, supabase/migrations/202604302400_v_support_case_directory.sql).
  // Surfaces FE-shaped derived fields (client_label / client_slug /
  // sender_label / sender_brand_label / assignee_label /
  // recipient_label / recipient_phone / shipment_tracking_number /
  // last_message_at / message_count / sla_breached / age_seconds /
  // age_hours / is_open / is_terminal / resolution_label) on top of the
  // canonical support_cases columns (subject / channel / tags / status /
  // priority / sla_due_at). Registry-only entry; live mode reads through
  // `v_support_case_directory`, seed mode through
  // `data-source._projectSupportCaseDirectory()`.
  support_case_directory: {
    relation: 'v_support_case_directory',
    id_column: 'id',
    capability_read: 'support.read',
    columns: [
      { key: 'subject', label: 'Subject', sortable: true, filterable: true },
      { key: 'client_label', label: 'Client', sortable: true, filterable: true },
      { key: 'sender_label', label: 'Sender', sortable: true, filterable: true },
      { key: 'recipient_label', label: 'Recipient', sortable: true, filterable: true },
      { key: 'shipment_tracking_number', label: 'Tracking', mono: true, sortable: true, filterable: true },
      { key: 'channel', label: 'Channel', sortable: true, filterable: true, lookup: 'support_message_channel' },
      { key: 'priority', label: 'Priority', sortable: true, filterable: true, lookup: 'support_case_priority' },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'support_case_status' },
      { key: 'assignee_label', label: 'Assignee', sortable: true, filterable: true },
      { key: 'opened_at', label: 'Opened', format: 'datetime', sortable: true },
      { key: 'sla_due_at', label: 'SLA due', format: 'datetime', sortable: true },
      { key: 'last_message_at', label: 'Last message', format: 'datetime', sortable: true },
      { key: 'message_count', label: 'Msgs', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'sla_breached', label: 'SLA breached', sortable: true, filterable: true },
      { key: 'age_hours', label: 'Age (h)', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'is_open', label: 'Open', sortable: true, filterable: true },
      { key: 'resolution_label', label: 'Resolution', sortable: true, filterable: true },
    ],
  },
  // W26 paired projection — `public.v_support_message_directory` (read-only
  // canonical view, supabase/migrations/202604302410_v_support_message_directory.sql).
  // Surfaces FE-shaped derived fields (sent_at / author_user_id alias
  // shadows; author_role enum derivation; author_label resolution from
  // users.full_name OR actor_system OR 'system'; has_artifact flag) on top
  // of canonical support_messages columns (direction / channel / body /
  // metadata). Registry-only entry; live mode reads through
  // `v_support_message_directory`, seed mode through
  // `data-source._projectSupportMessageDirectory()`.
  support_message_directory: {
    relation: 'v_support_message_directory',
    id_column: 'id',
    capability_read: 'support.read',
    columns: [
      { key: 'sent_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'author_role', label: 'Role', sortable: true, filterable: true, lookup: 'support_message_role' },
      { key: 'author_label', label: 'Author', sortable: true, filterable: true },
      { key: 'channel', label: 'Channel', sortable: true, filterable: true, lookup: 'support_message_channel' },
      { key: 'direction', label: 'Direction', sortable: true, filterable: true, lookup: 'support_message_direction' },
      { key: 'has_artifact', label: 'Artifact', sortable: true, filterable: true },
      { key: 'body', label: 'Body' },
    ],
  },
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C). Mirrors the canonical alerting
  // tables (alert_rules + alert_triggers + ops_alerts). RLS / capability
  // gating: alerts.read for SELECT, alerts.write for create/edit/pause/delete
  // (declared in the capability catalog below). Datadog/PagerDuty/Sentry
  // parity: severity + channel + JSONLogic-backed condition + last fire +
  // triggers history + active ops_alerts cross-link.
  //
  // W14-7 — `last_triggered_at` is no longer registered as an `alert_rules`
  // column. Canonical `public.alert_rules` (migration 202510110003) has no
  // such column; the FE derives the value via
  // `MAX(alert_triggers.fired_at) WHERE rule_id = alert_rules.id` and renders
  // it on the decorated row at render time (alerts.tsx `lastTriggeredAtOf`).
  alert_rules: {
    relation: 'alert_rules',
    id_column: 'id',
    capability_read: 'alerts.read',
    capability_write: 'alerts.write',
    columns: [
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'severity', label: 'Severity', sortable: true, filterable: true, lookup: 'alert_severity' },
      { key: 'channel', label: 'Channel', sortable: true, filterable: true, lookup: 'alert_channel' },
      { key: 'enabled', label: 'Enabled', sortable: true, filterable: true },
      { key: 'created_at', label: 'Created', format: 'datetime', sortable: true },
    ],
  },
  alert_triggers: {
    relation: 'alert_triggers',
    id_column: 'id',
    capability_read: 'alerts.read',
    columns: [
      { key: 'fired_at', label: 'Fired', format: 'datetime', sortable: true },
      { key: 'rule_id', label: 'Rule', mono: true, sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'alert_trigger_status' },
    ],
  },
  // Paired projection view (W13-3 close-out): public.v_alert_trigger_summary
  // (supabase/migrations/202604301700_v_alert_trigger_summary.sql) projects
  // the canonical alert_triggers SSOT onto the FE-friendly shape used by
  // alerts.tsx (rule_id, fired_at, payload, status). Closes the W7 audit gap
  // identified in __audit__/SCHEMA-DRIFT/PLATFORM.md §2 — the FE row interface
  // expected (id, rule_id, fired_at, payload, status); the view derives those
  // names from canonical (alert_rule_id, timestamp, context). Production
  // cutover is a single registry flip — module call sites stay stable.
  alert_trigger_summary: {
    relation: 'v_alert_trigger_summary',
    id_column: 'id',
    capability_read: 'alerts.read',
    columns: [
      { key: 'fired_at', label: 'Fired', format: 'datetime', sortable: true },
      { key: 'rule_id', label: 'Rule', mono: true, sortable: true, filterable: true },
      { key: 'severity', label: 'Severity', sortable: true, filterable: true, lookup: 'alert_severity' },
      { key: 'message', label: 'Message', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'alert_trigger_status' },
      { key: 'acknowledged_at', label: 'Acknowledged', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W28 close-out): public.v_alert_rule_directory
  // (supabase/migrations/202604302600_v_alert_rule_directory.sql) projects the
  // canonical alert_rules SSOT onto the operator-facing shape used by
  // alerts.tsx (rule_name, severity_label via lookup_values, created_by_label
  // via users join, condition_summary, alert_channels_count, last_triggered_at
  // + trigger_count_24h + ack_count_24h + resolved_count_24h via
  // alert_triggers aggregation, is_throttled, is_paused). Closes the
  // W10-5 §1 deferral on the fictional `last_triggered_at` column and the
  // severity lookup-FK semantics. Read-only; SSOT remains alert_rules.
  // FE consumption seam: alerts.tsx can read via
  // useResourceList<AlertRule>('alert_rule_directory') so the operator
  // surface consumes server-derived counters/labels without FE-side
  // computation. Production cutover is a single getSupabaseClient() branch
  // flip in ui_list_resource_v1 — module call sites stay stable.
  alert_rule_directory: {
    relation: 'v_alert_rule_directory',
    id_column: 'id',
    capability_read: 'alerts.read',
    columns: [
      { key: 'rule_name', label: 'Rule', mono: true, sortable: true, filterable: true },
      { key: 'severity_label', label: 'Severity', sortable: true, filterable: true, lookup: 'alert_severity' },
      { key: 'condition_summary', label: 'Condition', sortable: true, filterable: true },
      { key: 'alert_channels_count', label: 'Channels', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'trigger_count_24h', label: 'Fires 24h', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'ack_count_24h', label: 'Acks 24h', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'last_triggered_at', label: 'Last fired', format: 'datetime', sortable: true },
      { key: 'is_throttled', label: 'Throttled', sortable: true, filterable: true },
      { key: 'is_paused', label: 'Paused', sortable: true, filterable: true },
      { key: 'created_by_label', label: 'Owner', sortable: true, filterable: true },
    ],
  },
  // W14-7 — `resolved_at` dropped as a top-level column on ops_alerts; canonical
  // resolution is `details.resolved_at` (jsonb projection on canonical
  // `public.ops_alerts.details`). The registry now exposes the canonical
  // `details` jsonb column so the FE-side helper `resolvedAtOf()` (alerts.tsx)
  // can render the lifecycle without a fictional column on the SSOT.
  ops_alerts: {
    relation: 'ops_alerts',
    id_column: 'id',
    capability_read: 'alerts.read',
    columns: [
      { key: 'opened_at', label: 'Opened', format: 'datetime', sortable: true },
      { key: 'severity', label: 'Severity', sortable: true, filterable: true, lookup: 'alert_severity' },
      { key: 'source', label: 'Source', mono: true, sortable: true, filterable: true },
      { key: 'message', label: 'Message', sortable: true, filterable: true },
      { key: 'details', label: 'Details', mono: true },
    ],
  },
  // W16-5 (CLAIM-PLATFORM-IMPORTS) — operator import_jobs lifecycle surface.
  // Mirrors the canonical SSOT public.import_jobs from
  // supabase/migrations/202604301900_import_jobs.sql (id, organization_id,
  // kind, source, status ∈ {queued|running|completed|failed|cancelled},
  // submitted_at, started_at, completed_at, submitted_by_user_id, row_count,
  // error_count, error_summary jsonb, correlation_id, cancelled_reason).
  // RLS / capability gating: imports.read for SELECT, imports.write for
  // Submit / Cancel via canonical RPCs (import_job_create_v1,
  // import_job_cancel_v1) per
  // supabase/migrations/202604301905_import_job_rpcs_v1.sql. Replaces the
  // /platform/imports PREVIEW chip with a real DataTable + drawer + actions.
  import_jobs: {
    relation: 'import_jobs',
    id_column: 'id',
    capability_read: 'imports.read',
    capability_write: 'imports.write',
    columns: [
      { key: 'kind', label: 'Kind', sortable: true, filterable: true, lookup: 'import_job_kind' },
      { key: 'source', label: 'Source', sortable: true, filterable: true, lookup: 'import_job_source' },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'import_job_status' },
      { key: 'row_count', label: 'Rows', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'error_count', label: 'Errors', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'submitted_at', label: 'Submitted', format: 'datetime', sortable: true },
      { key: 'completed_at', label: 'Completed', format: 'datetime', sortable: true },
      { key: 'submitted_by_user_id', label: 'Submitted by', mono: true, sortable: true, filterable: true },
    ],
  },
  // Paired projection view (W28 close-out): public.v_import_job_directory
  // (supabase/migrations/202604302620_v_import_job_directory.sql) projects the
  // canonical import_jobs SSOT onto the operator-facing shape used by
  // imports.tsx (tenant_label / submitted_by_label / row_count_value /
  // error_count_value NULL-safe / lifecycle flags / timing aggregates /
  // error_summary_count). Read-only; SSOT remains import_jobs. Production
  // cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable.
  import_job_directory: {
    relation: 'v_import_job_directory',
    id_column: 'id',
    capability_read: 'imports.read',
    columns: [
      { key: 'kind', label: 'Kind', sortable: true, filterable: true, lookup: 'import_job_kind' },
      { key: 'source', label: 'Source', sortable: true, filterable: true, lookup: 'import_job_source' },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'import_job_status' },
      { key: 'row_count_value', label: 'Rows', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'error_count_value', label: 'Errors', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'submitted_at', label: 'Submitted', format: 'datetime', sortable: true },
      { key: 'completed_at', label: 'Completed', format: 'datetime', sortable: true },
      { key: 'submitted_by_label', label: 'Submitted by', sortable: true, filterable: true },
      { key: 'duration_seconds', label: 'Duration s', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'error_summary_count', label: 'Err entries', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'is_terminal', label: 'Terminal', sortable: true, filterable: true },
      { key: 'has_errors', label: 'Has errors', sortable: true, filterable: true },
    ],
  },
  // Paired projection view (W28 close-out): public.v_label_template_directory
  // (supabase/migrations/202604302610_v_label_template_directory.sql) projects
  // the canonical label_template_specs SSOT onto the operator-facing shape used
  // by labels.tsx (renderer_config jsonb-path projections — dimensions / dpi /
  // barcode_format / active_version_id closing the W10-5 §8 REMOVE deferral —
  // plus tenant_label, created_by_label, render_count + render_count_24h +
  // last_used_at + completed_count + failed_count via label_jobs aggregation,
  // version_count + is_active_version per (template_key, organization_id),
  // asset_count). Read-only; SSOT remains label_template_specs. Production
  // cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable.
  label_template_directory: {
    relation: 'v_label_template_directory',
    id_column: 'id',
    capability_read: 'labels.read',
    columns: [
      { key: 'template_key', label: 'Spec', mono: true, sortable: true, filterable: true },
      { key: 'dimensions', label: 'Dimensions', sortable: true, filterable: true },
      { key: 'dpi', label: 'DPI', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'barcode_format', label: 'Barcode', sortable: true, filterable: true },
      { key: 'active_version_id', label: 'Active version', mono: true, sortable: true, filterable: true },
      { key: 'render_count', label: 'Renders', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'render_count_24h', label: 'Renders 24h', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'last_used_at', label: 'Last used', format: 'datetime', sortable: true },
      { key: 'completed_count', label: 'Completed', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'failed_count', label: 'Failed', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'version_count', label: 'Versions', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'is_active_version', label: 'Active?', sortable: true, filterable: true },
      { key: 'tenant_label', label: 'Tenant', sortable: true, filterable: true },
    ],
  },
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C). Mirrors the canonical
  // public.feature_flags table (id, key, label, description, status ∈
  // {on, off, percentage}, rollout_percentage, targeting jsonb, scope_type,
  // scope_id, kill_switch, last_updated_at, last_updated_by_user_id).
  // RLS / capability gating: feature_flags.read for SELECT, feature_flags.write
  // for create / toggle / edit-targeting / kill-switch / bulk-toggle (declared
  // in the capability catalog below). LaunchDarkly / Unleash / GrowthBook
  // parity: status pill (on/off/percentage with mini bar) + targeting summary
  // chip + kill-switch indicator + per-scope override targeting via
  // `targeting.scopes` so the LadderViz can render the resolved Global →
  // Tenant → Client → Sender path without fabricating data at render time.
  feature_flags: {
    relation: 'feature_flags',
    id_column: 'id',
    capability_read: 'feature_flags.read',
    capability_write: 'feature_flags.write',
    columns: [
      { key: 'key', label: 'Flag key', mono: true, sortable: true, filterable: true },
      { key: 'label', label: 'Label', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'feature_flag_status' },
      { key: 'rollout_percentage', label: 'Rollout %', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'scope_type', label: 'Scope', sortable: true, filterable: true, lookup: 'feature_flag_scope' },
      { key: 'scope_id', label: 'Scope ID', mono: true, sortable: true, filterable: true },
      { key: 'kill_switch', label: 'Kill switch', sortable: true, filterable: true },
      { key: 'last_updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W6-6 / W11-3): public.v_feature_flag_summary
  // (supabase/migrations/202604300100_v_feature_flag_summary.sql) projects
  // feature_flags.name → key, humanized name → label, derived
  // (enabled, rollout_percentage) → status ∈ {on, off, percentage},
  // jsonb_build_object('summary', 'scopes') → targeting, NOT enabled →
  // kill_switch, COALESCE(conditions->'owners', '[]') → owners, updated_at →
  // last_updated_at, conditions->>'last_updated_by_user_id' →
  // last_updated_by_user_id. Read-only; SSOT remains feature_flags.
  // FE consumption seam: feature-flags.tsx reads via
  // useResourceList<FeatureFlag>('feature_flag_summary') so the operator
  // surface consumes server-derived fields without FE-side computation.
  // Production cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable.
  feature_flag_summary: {
    relation: 'v_feature_flag_summary',
    id_column: 'id',
    capability_read: 'feature_flags.read',
    columns: [
      { key: 'key', label: 'Flag key', mono: true, sortable: true, filterable: true },
      { key: 'label', label: 'Label', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'feature_flag_status' },
      { key: 'rollout_percentage', label: 'Rollout %', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'scope_type', label: 'Scope', sortable: true, filterable: true, lookup: 'feature_flag_scope' },
      { key: 'scope_id', label: 'Scope ID', mono: true, sortable: true, filterable: true },
      { key: 'kill_switch', label: 'Kill switch', sortable: true, filterable: true },
      { key: 'last_updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  // CLAIM-IDENTITY-SESSIONS (Phase E2) — operator-visible auth sessions roster.
  //
  // Architectural reality: Supabase manages user sessions in the server-internal
  // `auth.sessions` table (auth schema, not directly readable from public). The
  // canonical revoke path is the Phase B6 RPC `public.revoke_session_v1(p_args
  // jsonb)` which writes an INTENT row into `public.revocation_audit`
  // (status='pending') and emits `domain_events.session.revocation_requested`;
  // an out-of-band edge worker then calls Supabase Admin API
  // `auth.admin.signOut(user_id)`.
  //
  // Production cutover plan: expose a tenant-scoped RLS view
  // `public.user_sessions_v` that joins `auth.sessions` (read-only) with
  // `public.users` for visibility, gated by `users.manage` (any user) or
  // `users.read` (self only). Demo mode synthesizes a structurally identical
  // row shape so the swap-seam is environment-only.
  user_sessions: {
    relation: 'user_sessions',
    id_column: 'id',
    capability_read: 'users.read',
    capability_write: 'users.manage',
    columns: [
      { key: 'user_email', label: 'User', sortable: true, filterable: true },
      { key: 'user_agent', label: 'Device / Agent', sortable: true, filterable: true },
      { key: 'ip', label: 'IP', mono: true, sortable: true, filterable: true },
      { key: 'aal', label: 'AAL', sortable: true, filterable: true, lookup: 'session_aal' },
      { key: 'created_at', label: 'Started', format: 'datetime', sortable: true },
      { key: 'updated_at', label: 'Last seen', format: 'datetime', sortable: true },
      { key: 'not_after', label: 'Expires', format: 'datetime', sortable: true },
    ],
  },
  // Paired projection view (W39 PLATFORM P1 carry-forward closure):
  // public.v_user_device_summary projects public.user_devices with
  // metadata jsonb projections (model, attestation_status,
  // attestation_trusted_at) and derived attestation booleans
  // (is_attestation_trusted/pending/failed/revoked). Read-only; SSOT
  // remains user_devices. See supabase/migrations/
  // 202604303100_v_user_device_summary.sql for the projection contract +
  // supabase/tests/pgtap/zzw39_v_user_device_summary.sql for shape/RLS
  // tests.
  user_device_summary: {
    relation: 'v_user_device_summary',
    id_column: 'id',
    capability_read: 'user_devices.read',
    columns: [
      { key: 'device_id', label: 'Device', mono: true, sortable: true, filterable: true },
      { key: 'user_id', label: 'User', mono: true, sortable: true, filterable: true },
      { key: 'platform', label: 'Platform', sortable: true, filterable: true },
      { key: 'model', label: 'Model', sortable: true, filterable: true },
      { key: 'os_version', label: 'OS', sortable: true },
      { key: 'attestation_status', label: 'Attestation', sortable: true, filterable: true },
      { key: 'last_seen_at', label: 'Last seen', format: 'datetime', sortable: true },
    ],
  },
  // CLAIM-IDENTITY-RBAC (Phase E3) — RBAC role-management lifecycle.
  // Mirrors public.rbac_roles from supabase/migrations/202601300030_rbac_foundation_v1.sql:59-75.
  // Read gate `access_policy.read`; write gate `access_policy.approve`.
  rbac_roles: {
    relation: 'v_rbac_role_summary',
    id_column: 'id',
    capability_read: 'access_policy.read',
    capability_write: 'access_policy.approve',
    allow_view_relation: true,
    columns: [
      { key: 'key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'description', label: 'Description' },
      { key: 'permission_count', label: 'Permissions', align: 'right', sortable: true },
      { key: 'assignment_count', label: 'Assignees', align: 'right', sortable: true },
      { key: 'is_active', label: 'Active', sortable: true, filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  rbac_role_permissions: {
    relation: 'v_rbac_role_permission_directory',
    id_column: 'id',
    capability_read: 'access_policy.read',
    capability_write: 'access_policy.approve',
    allow_view_relation: true,
    columns: [
      { key: 'role_id', label: 'Role', mono: true, filterable: true },
      { key: 'permission_value', label: 'Permission', mono: true, sortable: true, filterable: true },
      { key: 'granted_by_user_id', label: 'Granted by', mono: true },
      { key: 'granted_at', label: 'Granted', format: 'datetime', sortable: true },
    ],
  },
  rbac_user_role_assignments: {
    relation: 'v_rbac_user_role_assignment_directory',
    id_column: 'id',
    capability_read: 'access_policy.read',
    capability_write: 'access_policy.approve',
    allow_view_relation: true,
    columns: [
      { key: 'user_email', label: 'User', mono: true, sortable: true, filterable: true },
      { key: 'user_full_name', label: 'Name', sortable: true, filterable: true },
      { key: 'role_key', label: 'Role', mono: true, sortable: true, filterable: true },
      { key: 'role_name', label: 'Role name', sortable: true },
      { key: 'assigned_at', label: 'Assigned', format: 'datetime', sortable: true },
      { key: 'revoked_at', label: 'Revoked', format: 'datetime', sortable: true },
    ],
  },
  rbac_role_templates: {
    relation: 'v_rbac_role_template_directory',
    id_column: 'id',
    capability_read: 'access_policy.read',
    capability_write: 'access_policy.approve',
    allow_view_relation: true,
    columns: [
      { key: 'key', label: 'Key', mono: true, sortable: true, filterable: true },
      { key: 'name', label: 'Name', sortable: true, filterable: true },
      { key: 'description', label: 'Description' },
      { key: 'permission_count', label: 'Permissions', align: 'right', sortable: true },
      { key: 'is_active', label: 'Active', sortable: true, filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  capability_grant_requests: {
    relation: 'v_capability_grant_request_directory',
    id_column: 'id',
    capability_read: 'access_policy.read',
    capability_write: 'access_policy.approve',
    allow_view_relation: true,
    columns: [
      { key: 'capability_key', label: 'Capability', mono: true, sortable: true, filterable: true },
      { key: 'target_user_email', label: 'Target user', sortable: true, filterable: true },
      { key: 'requested_by_email', label: 'Requested by', sortable: true, filterable: true },
      { key: 'scope_type', label: 'Scope', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'created_at', label: 'Created', format: 'datetime', sortable: true },
      { key: 'decided_at', label: 'Decided', format: 'datetime', sortable: true },
    ],
  },
  // CLAIM-OBJECTIVES-LADDER (Phase G3) — scope_type_registry projection.
  // Backend SSOT: supabase/migrations/202601301100_scope_registry_ssot.sql:24
  // (table) + 267 (seed). `ladder_rank` defines override-ladder precedence:
  // Global (0) < Tenant (10) < Client (20) < Sender (30) < Source/Resource
  // (40). The FE consumes this through `useResourceList('scope_type_registry')`
  // so config.tsx + feature-flags.tsx no longer embed inline SCOPE_RANK
  // literals. Capability gate `settings.read` mirrors how the canonical RLS
  // policy on `public.scope_type_registry` allows privileged writes and grants read access
  // to operators reviewing the ladder. No DataTable surface today (driven by
  // hooks, not list view) — `columns` are declared so downstream registry
  // tooling stays consistent if the row set is ever surfaced via DataTable.
  scope_type_registry: {
    relation: 'scope_type_registry',
    id_column: 'id',
    capability_read: 'settings.read',
    columns: [
      { key: 'scope_type', label: 'Scope', mono: true, sortable: true, filterable: true },
      { key: 'description', label: 'Description' },
      { key: 'ladder_rank', label: 'Ladder rank', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'entity_table', label: 'Entity table', mono: true },
      { key: 'is_enabled', label: 'Enabled', sortable: true, filterable: true },
    ],
  },
  // W54-F closure — registry entries for the previously unregistered
  // passthrough resources surfaced via `RESOURCE_DATA()` in
  // `data-source.ts:5124`. Aligns the FE registry SSOT with the actual
  // resolvable read keys so the registry-driven gating in
  // `ui_list_resource_v1` covers every resource (not only
  // `audit_table_changes`). Each entry mirrors the canonical capability
  // namespace already used by sibling resources in this file.
  //
  // CUSTOMERS / IDENTITY
  clients: {
    relation: 'clients',
    id_column: 'id',
    capability_read: 'clients.read',
    capability_write: 'clients.write',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'slug', label: 'Slug', mono: true },
      { key: 'sla_tier', label: 'Tier', filterable: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  client_summary: {
    relation: 'v_client_summary',
    id_column: 'client_id',
    capability_read: 'clients.read',
    scope_columns: { tenant: 'organization_id' },
    select: [
      'client_id',
      'id',
      'organization_id',
      'name',
      'slug',
      'sla_tier',
      'status',
      'sender_count',
      'recipient_count',
      'active_shipments',
      'total_shipments',
      'last_shipment_at',
      'contract_active',
      'has_warehouse',
    ],
    filters: [
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'name', column: 'name', op: 'ilike' },
      { key: 'status', column: 'status', op: 'eq' },
    ],
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'sender_count', label: 'Senders', align: 'right' },
      { key: 'recipient_count', label: 'Recipients', align: 'right' },
      { key: 'active_shipments', label: 'Active shipments', align: 'right' },
    ],
  },
  senders: {
    relation: 'senders',
    id_column: 'id',
    capability_read: 'senders.read',
    capability_write: 'senders.write',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'client_id', label: 'Client', mono: true },
      { key: 'brand_name', label: 'Brand' },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  sender_summary: {
    relation: 'v_sender_summary',
    id_column: 'sender_id',
    capability_read: 'senders.read',
    scope_columns: { tenant: 'organization_id_resolved', client: 'client_id' },
    select: [
      'sender_id',
      'id',
      'client_id',
      'organization_id_resolved',
      'name',
      'brand_name',
      'client_label',
      'client_slug',
      'sla_tier_inherited',
      'status',
      'active_shipments',
      'total_shipments',
      'last_shipment_at',
      'effective_warehouse_id',
      'has_warehouse',
      'updated_at',
    ],
    filters: [
      { key: 'organization_id_resolved', column: 'organization_id_resolved', op: 'eq' },
      { key: 'client_id', column: 'client_id', op: 'eq' },
      { key: 'name', column: 'name', op: 'ilike' },
      { key: 'status', column: 'status', op: 'eq' },
    ],
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'client_label', label: 'Client' },
      { key: 'active_shipments', label: 'Active shipments', align: 'right' },
    ],
  },
  recipients: {
    relation: 'recipients',
    id_column: 'id',
    capability_read: 'recipients.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true, import: { enabled: true, aliases: ['name', 'recipient_name'] } },
      { key: 'phone_number', label: 'Phone', mono: true },
      { key: 'email', label: 'Email' },
    ],
  },
  recipient_directory: {
    relation: 'v_recipient_directory',
    id_column: 'recipient_id',
    capability_read: 'recipients.read',
    scope_columns: { tenant: 'organization_id', client: 'client_id' },
    select: [
      'recipient_id',
      'id',
      'organization_id',
      'client_id',
      'name',
      'phone_number',
      'phone_validation_status',
      'email',
      'preferred_language',
      'preferred_comm_channel',
      'client_label',
      'client_slug',
      'total_shipments',
      'last_shipment_at',
      'last_shipment_status',
      'phone_validated',
      'has_quiet_hours',
      'updated_at',
    ],
    filters: [
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'client_id', column: 'client_id', op: 'eq' },
      { key: 'name', column: 'name', op: 'ilike' },
      { key: 'phone_number', column: 'phone_number', op: 'ilike' },
      { key: 'email', column: 'email', op: 'ilike' },
    ],
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'phone_number', label: 'Phone', mono: true },
      { key: 'last_shipment_at', label: 'Last shipment', format: 'datetime' },
    ],
  },
  addresses: {
    relation: 'addresses',
    id_column: 'id',
    capability_read: 'addresses.read',
    columns: [
      { key: 'raw_input', label: 'Raw input', import: { enabled: true, aliases: ['address_line_1', 'address', 'raw_input'] } },
      { key: 'street_line_1', label: 'Street' },
      { key: 'city', label: 'City' },
      { key: 'country', label: 'Country' },
    ],
  },
  geocodes: {
    relation: 'geocodes',
    id_column: 'id',
    capability_read: 'addresses.read',
    columns: [
      { key: 'address_id', label: 'Address', mono: true },
      { key: 'lat', label: 'Lat', align: 'right' },
      { key: 'lng', label: 'Lng', align: 'right' },
    ],
  },
  geocoding_attempts: {
    relation: 'geocoding_attempts',
    id_column: 'id',
    capability_read: 'addresses.read',
    columns: [
      { key: 'address_id', label: 'Address', mono: true },
      { key: 'provider', label: 'Provider' },
      { key: 'created_at', label: 'When', format: 'datetime' },
    ],
  },
  canonical_cities: {
    relation: 'canonical_cities',
    id_column: 'id',
    capability_read: 'addresses.read',
    columns: [
      { key: 'name_en', label: 'City (en)', sortable: true },
      { key: 'country', label: 'Country' },
    ],
  },
  canonical_districts: {
    relation: 'canonical_districts',
    id_column: 'id',
    capability_read: 'addresses.read',
    columns: [
      { key: 'name_en', label: 'District (en)', sortable: true },
      { key: 'city_id', label: 'City', mono: true },
    ],
  },
  // PLATFORM / IDENTITY USERS
  users: {
    relation: 'users',
    id_column: 'id',
    capability_read: 'users.read',
    capability_write: 'users.manage',
    columns: [
      { key: 'email', label: 'Email', sortable: true, mono: true },
      { key: 'full_name', label: 'Name' },
      { key: 'user_type', label: 'Type', filterable: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  fleet_user_options: {
    relation: 'users',
    id_column: 'id',
    capability_read: 'fleet.write',
    columns: [
      { key: 'email', label: 'Email', sortable: true, mono: true },
      { key: 'full_name', label: 'Name' },
      { key: 'user_type', label: 'Type', filterable: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  user_directory: {
    relation: 'v_user_directory',
    id_column: 'id',
    capability_read: 'users.read',
    columns: [
      { key: 'email', label: 'Email', sortable: true, mono: true },
      { key: 'organization_label', label: 'Org' },
      { key: 'active_role_keys', label: 'Roles' },
    ],
  },
  user_devices: {
    relation: 'user_devices',
    id_column: 'id',
    capability_read: 'user_devices.read',
    columns: [
      { key: 'user_id', label: 'User', mono: true },
      { key: 'device_label', label: 'Device' },
      { key: 'last_seen_at', label: 'Last seen', format: 'datetime' },
    ],
  },
  ops_sessions: {
    relation: 'ops_sessions',
    id_column: 'id',
    capability_read: 'tasks.read',
    scope_columns: { tenant: 'organization_id' },
    filters: [
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'actor_user_id', column: 'actor_user_id', op: 'eq' },
      { key: 'session_type', column: 'session_type', op: 'eq' },
      { key: 'status', column: 'status', op: 'eq' },
      { key: 'idempotency_key', column: 'idempotency_key', op: 'eq' },
    ],
    columns: [
      { key: 'session_type', label: 'Session type', filterable: true },
      { key: 'status', label: 'Status', filterable: true },
      { key: 'actor_user_id', label: 'Actor', mono: true },
      { key: 'opened_at', label: 'Opened', format: 'datetime', sortable: true },
      { key: 'closed_at', label: 'Closed', format: 'datetime', sortable: true },
      { key: 'idempotency_key', label: 'Idempotency key', mono: true },
    ],
  },
  organizations: {
    relation: 'organizations',
    id_column: 'id',
    capability_read: 'organizations.read',
    capability_write: 'organizations.write',
    scope_columns: { tenant: 'id' },
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'slug', label: 'Slug', mono: true, sortable: true, filterable: true },
      { key: 'timezone', label: 'Timezone', sortable: true, filterable: true },
      { key: 'locale', label: 'Locale', sortable: true, filterable: true },
      { key: 'billing_status', label: 'Billing', sortable: true, filterable: true },
      { key: 'created_at', label: 'Created', format: 'datetime', sortable: true },
    ],
  },
  tenant_signup_requests: {
    relation: 'tenant_signup_requests',
    id_column: 'id',
    capability_read: 'tenant_signup_requests.read',
    capability_write: 'tenant_signup_requests.review',
    columns: [
      { key: 'organization_name', label: 'Organization', sortable: true, filterable: true },
      { key: 'email', label: 'Admin email', mono: true, sortable: true, filterable: true },
      { key: 'full_name', label: 'Admin name', sortable: true, filterable: true },
      { key: 'status', label: 'Status', filterable: true },
      { key: 'created_at', label: 'Received', format: 'datetime', sortable: true },
    ],
  },
  tenant_signup_request_summary: {
    relation: 'v_tenant_signup_request_summary',
    id_column: 'id',
    capability_read: 'tenant_signup_requests.read',
    columns: [
      { key: 'organization_name', label: 'Organization', sortable: true, filterable: true },
      { key: 'status', label: 'Status', filterable: true },
      { key: 'reviewer_label', label: 'Reviewer' },
    ],
  },
  rbac_role_summary: {
    relation: 'v_rbac_role_summary',
    id_column: 'id',
    capability_read: 'access_policy.read',
    allow_view_relation: true,
    columns: [
      { key: 'key', label: 'Role', mono: true },
      { key: 'permission_count', label: 'Permissions', align: 'right' },
      { key: 'assignment_count', label: 'Assignments', align: 'right' },
    ],
  },
  // FLEET (additional)
  drivers: {
    relation: 'v_fleet_driver_options',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'vehicle_id', label: 'Vehicle', mono: true },
    ],
  },
  driver_applications: {
    relation: 'marketplace_participant_requests',
    id_column: 'id',
    capability_read: 'fleet.read',
    capability_write: 'marketplace.write',
    columns: [
      { key: 'requested_at', label: 'When', format: 'datetime' },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  vehicles: {
    relation: 'vehicles',
    id_column: 'id',
    capability_read: 'fleet.read',
    capability_write: 'fleet.write',
    columns: [
      { key: 'plate', label: 'Plate', mono: true, sortable: true },
      { key: 'vin', label: 'VIN', mono: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  vehicle_types: {
    relation: 'v_vehicle_type_directory',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
    ],
  },
  vehicle_assignments: {
    relation: 'v_vehicle_assignment_directory',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'vehicle_id', label: 'Vehicle', mono: true },
      { key: 'driver_name', label: 'Driver' },
      { key: 'started_at', label: 'Started', format: 'datetime' },
    ],
  },
  vehicle_events: {
    relation: 'v_vehicle_event_directory',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'vehicle_id', label: 'Vehicle', mono: true },
      { key: 'event_type', label: 'Event', filterable: true },
      { key: 'actor_name', label: 'Actor' },
      { key: 'occurred_at', label: 'When', format: 'datetime' },
    ],
  },
  vehicle_documents: {
    relation: 'vehicle_documents',
    id_column: 'id',
    capability_read: 'fleet.read',
    capability_write: 'fleet.write',
    columns: [
      { key: 'vehicle_id', label: 'Vehicle', mono: true, filterable: true },
      { key: 'doc_type', label: 'Type', sortable: true, filterable: true, lookup: 'vehicle_document_kind' },
      { key: 'issuer', label: 'Issuer', sortable: true, filterable: true },
      { key: 'expires_at', label: 'Expires', format: 'date', sortable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'vehicle_document_status' },
    ],
  },
  vehicle_maintenance_windows: {
    relation: 'vehicle_maintenance_windows',
    id_column: 'id',
    capability_read: 'fleet.read',
    capability_write: 'fleet.write',
    columns: [
      { key: 'vehicle_id', label: 'Vehicle', mono: true },
      { key: 'window_start_at', label: 'Start', format: 'datetime' },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  // OPERATE — shipments / routes / pickups
  shipment_directory: {
    relation: 'v_shipment_directory',
    id_column: 'shipment_id',
    capability_read: 'shipments.read',
    scope_columns: { tenant: 'organization_id', client: 'client_id', sender: 'sender_id' },
    filters: [
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'client_id', column: 'client_id', op: 'eq' },
      { key: 'sender_id', column: 'sender_id', op: 'eq' },
      { key: 'id', column: 'id', op: 'eq' },
      { key: 'tracking_number', column: 'tracking_number', op: 'ilike' },
      { key: 'client_reference_number', column: 'client_reference_number', op: 'ilike' },
      { key: 'carrier_reference_number', column: 'carrier_reference_number', op: 'ilike' },
      { key: 'status', column: 'status', op: 'eq' },
    ],
    columns: [
      { key: 'tracking_number', label: 'Tracking', mono: true, sortable: true },
      { key: 'service_type', label: 'Service', filterable: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  shipment_boxes: {
    relation: 'shipment_boxes',
    id_column: 'id',
    capability_read: 'shipments.read',
    columns: [
      { key: 'shipment_id', label: 'Shipment', mono: true },
      { key: 'box_number', label: '#', align: 'right' },
      { key: 'weight_kg', label: 'Weight (kg)', align: 'right', mono: true },
    ],
  },
  scan_events: {
    relation: 'scan_events',
    id_column: 'id',
    capability_read: 'shipments.read',
    columns: [
      { key: 'shipment_id', label: 'Shipment', mono: true },
      { key: 'scan_type', label: 'Type', filterable: true },
      { key: 'occurred_at', label: 'When', format: 'datetime' },
    ],
  },
  comms_attempts: {
    relation: 'comms_attempts',
    id_column: 'id',
    capability_read: 'shipments.read',
    columns: [
      { key: 'shipment_id', label: 'Shipment', mono: true },
      { key: 'channel', label: 'Channel', filterable: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  task_events: {
    relation: 'task_events',
    id_column: 'id',
    capability_read: 'tasks.read',
    columns: [
      { key: 'task_id', label: 'Task', mono: true },
      { key: 'event_type', label: 'Event', filterable: true },
      { key: 'created_at', label: 'When', format: 'datetime' },
    ],
  },
  route_stops: {
    relation: 'route_stops',
    id_column: 'id',
    capability_read: 'routes.read',
    columns: [
      { key: 'route_run_id', label: 'Run', mono: true },
      { key: 'sequence', label: 'Seq', align: 'right' },
      { key: 'shipment_id', label: 'Shipment', mono: true },
    ],
  },
  route_plan_directory: {
    relation: 'v_route_plan_directory',
    id_column: 'plan_id',
    capability_read: 'route_plans.read',
    columns: [
      { key: 'plan_display_id', label: 'Plan', mono: true },
      { key: 'wave_label', label: 'Wave' },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  route_run_directory: {
    relation: 'v_route_run_directory',
    id_column: 'id',
    capability_read: 'routes.read',
    columns: [
      { key: 'run_display_id', label: 'Run', mono: true },
      { key: 'driver_label', label: 'Driver' },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  wave_catalog: {
    relation: 'wave_catalog',
    id_column: 'id',
    capability_read: 'route_plans.read',
    columns: [
      { key: 'wave_key', label: 'Wave', mono: true, sortable: true },
      { key: 'label', label: 'Label' },
    ],
  },
  hubs: {
    relation: 'hubs',
    id_column: 'id',
    capability_read: 'fleet.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'code', label: 'Code', mono: true },
      { key: 'city', label: 'City' },
    ],
  },
  // FINANCE
  finance_events_ledger: {
    relation: 'finance_events_ledger',
    id_column: 'id',
    capability_read: 'finance.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime' },
      { key: 'event_type', label: 'Event', filterable: true },
      { key: 'amount', label: 'Amount', align: 'right', mono: true },
    ],
  },
  finance_events_bank_statement: {
    relation: 'finance_events_bank_statement',
    id_column: 'id',
    capability_read: 'finance.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime' },
      { key: 'amount', label: 'Amount', align: 'right', mono: true },
      { key: 'description', label: 'Description' },
    ],
  },
  bank_recon_matches: {
    relation: 'bank_recon_matches',
    id_column: 'id',
    capability_read: 'finance.read',
    columns: [
      { key: 'bank_statement_event_id', label: 'Statement', mono: true },
      { key: 'matched_amount', label: 'Amount', align: 'right', mono: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  billing_invoice_directory: {
    relation: 'v_billing_invoice_directory',
    id_column: 'billing_invoice_id',
    capability_read: 'billing.read',
    columns: [
      { key: 'invoice_number', label: 'Invoice', mono: true, sortable: true },
      { key: 'client_label', label: 'Client' },
      { key: 'total', label: 'Total', align: 'right', mono: true },
      { key: 'status', label: 'Status', filterable: true, lookup: 'invoice_status' },
    ],
  },
  dispute_directory: {
    relation: 'v_dispute_directory',
    id_column: 'dispute_id',
    capability_read: 'disputes.read',
    columns: [
      { key: 'opened_at', label: 'Opened', format: 'datetime' },
      { key: 'opened_by_label', label: 'Opened by' },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  // INTEGRATIONS / WORKFLOWS / PLUGINS
  integration_plugin_versions: {
    relation: 'integration_plugin_versions',
    id_column: 'id',
    capability_read: 'integration_plugins.read',
    columns: [
      { key: 'plugin_id', label: 'Plugin', mono: true },
      { key: 'version_label', label: 'Version' },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  integration_plugin_validation_runs: {
    relation: 'integration_plugin_validation_runs',
    id_column: 'id',
    capability_read: 'integration_plugins.read',
    capability_write: 'integration_plugins.test',
    columns: [
      { key: 'plugin_version_id', label: 'Version', mono: true, filterable: true },
      { key: 'run_type', label: 'Type', lookup: 'integration_plugin_validation_type', filterable: true },
      { key: 'status', label: 'Status', lookup: 'integration_plugin_run_status', filterable: true },
      { key: 'correlation_id', label: 'Correlation', mono: true },
      { key: 'evidence_hash', label: 'Evidence', mono: true },
      { key: 'created_at', label: 'Created', format: 'datetime', sortable: true },
      { key: 'completed_at', label: 'Completed', format: 'datetime' },
    ],
  },
  integration_plugin_approval_events: {
    relation: 'integration_plugin_approval_events',
    id_column: 'id',
    capability_read: 'integration_plugins.read',
    capability_write: 'integration_plugins.approve',
    columns: [
      { key: 'plugin_version_id', label: 'Version', mono: true, filterable: true },
      { key: 'action', label: 'Action', lookup: 'integration_plugin_approval_action', filterable: true },
      { key: 'actor_user_id', label: 'Actor', mono: true },
      { key: 'reason', label: 'Reason' },
      { key: 'diff_hash', label: 'Diff', mono: true },
      { key: 'artifact_hash', label: 'Artifact', mono: true },
      { key: 'created_at', label: 'Created', format: 'datetime', sortable: true },
    ],
  },
  integration_plugin_bindings: {
    relation: 'integration_plugin_bindings',
    id_column: 'id',
    capability_read: 'integration_plugins.read',
    capability_write: 'integration_plugins.activate',
    columns: [
      { key: 'plugin_version_id', label: 'Version', mono: true, filterable: true },
      { key: 'scope_type', label: 'Scope type', filterable: true },
      { key: 'scope_id', label: 'Scope', mono: true },
      { key: 'binding_type', label: 'Binding type', filterable: true },
      { key: 'runtime_resource_type', label: 'Runtime type', filterable: true },
      { key: 'runtime_resource_id', label: 'Runtime id', mono: true },
      { key: 'enabled', label: 'Enabled', filterable: true },
      { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
    ],
  },
  webhook_inbox: {
    relation: 'webhook_inbox',
    id_column: 'id',
    capability_read: 'webhooks.read',
    scope_columns: { tenant: 'organization_id' },
    filters: [
      { key: 'id', column: 'id', op: 'eq' },
      { key: 'organization_id', column: 'organization_id', op: 'eq' },
      { key: 'webhook_source_id', column: 'webhook_source_id', op: 'eq' },
      { key: 'workflow_run_id', column: 'workflow_run_id', op: 'eq' },
      { key: 'idempotency_key', column: 'idempotency_key', op: 'eq' },
    ],
    columns: [
      { key: 'received_at', label: 'Received', format: 'datetime' },
      { key: 'source_id', label: 'Source', mono: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  workflow_bindings: {
    relation: 'workflow_bindings',
    id_column: 'id',
    capability_read: 'workflows.read',
    capability_write: 'workflows.write',
    columns: [
      { key: 'binding_key', label: 'Binding', mono: true },
      { key: 'workflow_template_id', label: 'Template', mono: true },
      { key: 'enabled', label: 'Enabled' },
    ],
  },
  workflow_run_directory: {
    relation: 'v_workflow_run_directory',
    id_column: 'id',
    capability_read: 'workflows.read',
    columns: [
      { key: 'run_id', label: 'Run', mono: true },
      { key: 'workflow_template_id', label: 'Template', mono: true },
      { key: 'workflow_status', label: 'Status', filterable: true },
      { key: 'started_at', label: 'Started', format: 'datetime' },
    ],
  },
  workflow_template_directory: {
    relation: 'v_workflow_template_directory',
    id_column: 'workflow_template_id',
    capability_read: 'workflows.read',
    filters: [
      { key: 'id', column: 'id', op: 'eq' },
      { key: 'workflow_template_id', column: 'workflow_template_id', op: 'eq' },
      { key: 'status', column: 'status', op: 'eq' },
      { key: 'scope_type', column: 'scope_type', op: 'eq' },
      { key: 'scope_id', column: 'scope_id', op: 'eq' },
      { key: 'name', column: 'name', op: 'ilike' },
    ],
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  workflow_binding_directory: {
    relation: 'v_workflow_binding_directory',
    id_column: 'binding_id',
    capability_read: 'workflows.read',
    columns: [
      { key: 'binding_key', label: 'Binding', mono: true },
      { key: 'event', label: 'Event', filterable: true },
      { key: 'enabled', label: 'Enabled' },
    ],
  },
  workflow_run_steps: {
    relation: 'workflow_run_steps',
    id_column: 'id',
    capability_read: 'workflows.read',
    columns: [
      { key: 'workflow_run_id', label: 'Run', mono: true },
      { key: 'step_id', label: 'Step', mono: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  recent_workflow_events: {
    relation: 'recent_workflow_events',
    id_column: 'id',
    capability_read: 'workflows.read',
    columns: [
      { key: 'workflow_run_id', label: 'Run', mono: true },
      { key: 'event_type', label: 'Event', filterable: true },
      { key: 'created_at', label: 'When', format: 'datetime' },
    ],
  },
  operation_templates: {
    relation: 'public.v_operation_template_directory',
    id_column: 'id',
    capability_read: 'workflows.read',
    columns: [
      { key: 'operation_name', label: 'Name', sortable: true, mono: true },
      { key: 'kind', label: 'Kind', filterable: true },
      { key: 'category', label: 'Category', filterable: true },
      { key: 'description', label: 'Description' },
    ],
    filters: [
      { key: 'operation_name', column: 'operation_name', op: 'eq' },
      { key: 'kind', column: 'kind', op: 'eq' },
      { key: 'category', column: 'category', op: 'eq' },
    ],
  },
  provider_auth_configs: {
    relation: 'v_integration_credential_directory',
    allow_view_relation: true,
    id_column: 'id',
    capability_read: 'integrations.read',
    capability_write: 'integrations.write',
    columns: [
      { key: 'id', label: 'Config', mono: true, sortable: true },
      { key: 'provider_label', label: 'Provider', sortable: true, filterable: true },
      { key: 'auth_type', label: 'Auth type', sortable: true, filterable: true, lookup: 'provider_auth_type' },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'days_until_expiry', label: 'Days', align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'last_rotated_at', label: 'Last rotated', format: 'datetime', sortable: true },
      { key: 'expires_at', label: 'Expires', format: 'datetime', sortable: true },
    ],
  },
  providers: {
    relation: 'providers',
    id_column: 'id',
    capability_read: 'integrations.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'kind', label: 'Kind', filterable: true },
    ],
  },
  provider_health_latest: {
    relation: 'provider_health_metrics',
    id_column: 'provider_id',
    capability_read: 'integrations.read',
    columns: [
      { key: 'provider_id', label: 'Provider', mono: true },
      { key: 'success_rate', label: 'Success', align: 'right' },
      { key: 'latency_ms', label: 'Latency (ms)', align: 'right' },
    ],
  },
  circuit_breaker_dashboard: {
    relation: 'circuit_breaker_state',
    id_column: 'id',
    capability_read: 'integrations.read',
    columns: [
      { key: 'breaker_key', label: 'Breaker', mono: true },
      { key: 'state', label: 'State', filterable: true },
      { key: 'opened_at', label: 'Opened', format: 'datetime' },
    ],
  },
  // MARKETPLACE
  marketplace_participants: {
    relation: 'marketplace_participants',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'participant_type', label: 'Type', filterable: true },
    ],
  },
  marketplace_disputes: {
    relation: 'marketplace_disputes',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'opened_at', label: 'Opened', format: 'datetime' },
      { key: 'category', label: 'Category', filterable: true },
      { key: 'status', label: 'Status', filterable: true },
    ],
  },
  marketplace_request_kinds: {
    relation: 'marketplace_request_kinds',
    id_column: 'id',
    capability_read: 'marketplace.read',
    columns: [
      { key: 'request_kind_key', label: 'Kind', mono: true },
      { key: 'label', label: 'Label' },
    ],
  },
  // LABELS / IMPORTS / MARKETING / UI EVENTS / SUPPORT users
  labels: {
    relation: 'labels',
    id_column: 'id',
    capability_read: 'labels.read',
    scope_columns: { tenant: 'organization_id', client: 'client_id' },
    columns: [
      { key: 'id', label: 'Label', mono: true },
      { key: 'shipment_id', label: 'Shipment', mono: true },
      { key: 'active_version_id', label: 'Active version', mono: true },
      { key: 'active_version_number', label: 'Version', align: 'right' },
      { key: 'label_type', label: 'Type', filterable: true },
      { key: 'barcode', label: 'Barcode', mono: true, filterable: true },
      { key: 'generated_at', label: 'Generated', format: 'datetime' },
    ],
  },
  label_jobs: {
    relation: 'label_jobs',
    id_column: 'id',
    capability_read: 'labels.read',
    scope_columns: { tenant: 'organization_id', client: 'client_id' },
    columns: [
      { key: 'id', label: 'Job', mono: true },
      { key: 'target_type', label: 'Target type', filterable: true },
      { key: 'target_id', label: 'Target', mono: true, filterable: true },
      { key: 'target_box_id', label: 'Box', mono: true, filterable: true },
      { key: 'template_id', label: 'Template', mono: true },
      { key: 'label_id', label: 'Label', mono: true },
      { key: 'status', label: 'Status', filterable: true },
      { key: 'job_purpose', label: 'Purpose', filterable: true },
      { key: 'scheduled_at', label: 'Queued', format: 'datetime' },
      { key: 'completed_at', label: 'Completed', format: 'datetime' },
    ],
  },
  label_template_specs: {
    relation: 'label_template_specs',
    id_column: 'id',
    capability_read: 'labels.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'tenant_id', label: 'Tenant', mono: true },
    ],
  },
  label_versions: {
    relation: 'label_versions',
    id_column: 'id',
    capability_read: 'labels.read',
    columns: [
      { key: 'template_id', label: 'Template', mono: true },
      { key: 'version', label: 'Version', align: 'right' },
      { key: 'created_at', label: 'When', format: 'datetime' },
    ],
  },
  marketing_intake_recent: {
    relation: 'marketing_intake_recent_v1',
    id_column: 'id',
    capability_read: 'webhooks.read',
    columns: [
      { key: 'received_at', label: 'When', format: 'datetime' },
      { key: 'company', label: 'Company' },
      { key: 'email', label: 'Email' },
      { key: 'task_id', label: 'Follow-up task', mono: true },
      { key: 'workflow_run_id', label: 'Workflow run', mono: true },
    ],
  },
  marketing_intake_metrics_24h: {
    relation: 'marketing_intake_metrics_24h',
    id_column: 'id',
    capability_read: 'webhooks.read',
    columns: [
      { key: 'total', label: 'Intake (24h)', align: 'right' },
      { key: 'verified', label: 'Verified', align: 'right' },
      { key: 'dedupe_dropped', label: 'Dedupe dropped', align: 'right' },
    ],
  },
  ui_event_log: {
    relation: 'ui_event_log',
    id_column: 'id',
    capability_read: 'observability.read',
    columns: [
      { key: 'occurred_at', label: 'When', format: 'datetime' },
      { key: 'event_type', label: 'Event', filterable: true },
    ],
  },
  support_users: {
    relation: 'support_users',
    id_column: 'id',
    capability_read: 'support.read',
    columns: [
      { key: 'name', label: 'Name', sortable: true },
      { key: 'role', label: 'Role', filterable: true },
    ],
  },
  // SETTINGS — versions
  settings_versions: {
    relation: 'settings_versions',
    id_column: 'id',
    capability_read: 'settings.read',
    capability_write: 'settings.write',
    columns: [
      { key: 'category', label: 'Category', filterable: true, sortable: true },
      { key: 'scope_type', label: 'Scope', filterable: true },
      { key: 'created_at', label: 'When', format: 'datetime' },
    ],
  },
  // W56-B-2 closure (F6) — registry seams for legacy `api.seed.*` accessors,
  // ported to the canonical `useResourceList<T>('<resource_key>')` contract.
  // Each entry mirrors the shape the previous `api.seed.*` accessor returned;
  // production cutover is a single getSupabaseClient() branch flip in
  // ui_list_resource_v1 — module call sites stay stable.
  //
  // FINANCE — synthetic projection over finance_events + shipments/tasks/
  // route_runs (see seed-raw/marketplace.js cod_entries). Capability gate is
  // `cod.read` (mirrors the surface guard in /finance/cod).
  cod_entries: {
    relation: 'cod_entries',
    id_column: 'id',
    capability_read: 'cod.read',
    columns: [
      { key: 'subject_id', label: 'Shipment', mono: true, sortable: true, filterable: true },
      { key: 'currency', label: 'CCY', mono: true, sortable: true, filterable: true },
      { key: 'collected_at', label: 'Collected', format: 'datetime', sortable: true },
      { key: 'created_at', label: 'Created', format: 'datetime', sortable: true },
    ],
  },
  // PLATFORM — Planning OS read-only mirror of GitHub Project 6
  // (project_items + execution_cards). Source: seed-raw/planning-os.js.
  // Capability gate is `audit_log.read` (matches the planning-os surface
  // capability gate and the broader Platform read surface).
  planning_os_project_items: {
    relation: 'planning_os_project_items',
    id_column: 'id',
    capability_read: 'audit_log.read',
    columns: [
      { key: 'title', label: 'Title', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'kind', label: 'Kind', sortable: true, filterable: true },
      { key: 'priority', label: 'Priority', sortable: true, filterable: true },
      { key: 'spec_issue', label: 'Spec issue', mono: true, sortable: true },
      { key: 'execution_card', label: 'Execution card', mono: true, sortable: true },
      { key: 'pr', label: 'PR', mono: true, sortable: true },
      { key: 'worker_id', label: 'Worker', mono: true, sortable: true, filterable: true },
      { key: 'worktree', label: 'Worktree', mono: true, sortable: true },
    ],
  },
  planning_os_execution_cards: {
    relation: 'planning_os_execution_cards',
    id_column: 'id',
    capability_read: 'audit_log.read',
    columns: [
      { key: 'issue_number', label: 'Issue', mono: true, sortable: true },
      { key: 'title', label: 'Title', sortable: true, filterable: true },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
      { key: 'priority', label: 'Priority', sortable: true, filterable: true },
      { key: 'spec_issue', label: 'Spec issue', mono: true, sortable: true },
      { key: 'work_key', label: 'Work key', mono: true, sortable: true },
      { key: 'worker_id', label: 'Worker', mono: true, sortable: true, filterable: true },
      { key: 'step', label: 'Step', mono: true, sortable: true },
      { key: 'review_policy', label: 'Review', sortable: true, filterable: true },
    ],
  },
  // PLATFORM — Auth email URL policy (single-row config). Source:
  // seed-raw/planning-os.js#auth_email_url_policy. Capability gate is
  // `settings.read` (matches /platform/auth-email surface).
  auth_email_url_policy: {
    relation: 'auth_email_url_policy',
    id_column: 'env',
    capability_read: 'settings.read',
    columns: [
      { key: 'env', label: 'Env', mono: true, sortable: true, filterable: true },
      { key: 'audit_status', label: 'Audit', sortable: true, filterable: true },
      { key: 'last_audit_at', label: 'Audited', format: 'datetime', sortable: true },
    ],
  },
  // PLATFORM - Release / same-SHA proof governance. Source:
  // seed-raw/release-proof.js + public.release_deploy_proof_governance_v1.
  // Capability gate is `settings.read`; the surface is read-only.
  release_deploy_proof_governance: {
    relation: 'public.release_deploy_proof_governance_v1',
    id_column: 'id',
    allow_view_relation: true,
    capability_read: 'settings.read',
    columns: [
      { key: 'surface_label', label: 'Surface', sortable: true, filterable: true },
      { key: 'surface_id', label: 'Surface key', mono: true, sortable: true, filterable: true },
      { key: 'stage', label: 'Stage', mono: true, sortable: true, filterable: true },
      { key: 'deploy_environment', label: 'Deploy env', mono: true, sortable: true, filterable: true },
      { key: 'evidence_status', label: 'Evidence', sortable: true, filterable: true },
      { key: 'stage_workflow_file', label: 'Stage workflow', mono: true, sortable: true, filterable: true },
      { key: 'evidence_workflow_file', label: 'Evidence workflow', mono: true, sortable: true, filterable: true },
      { key: 'artifact_name', label: 'Artifact', mono: true, sortable: true, filterable: true },
      { key: 'json_entry_suffix', label: 'Manifest', mono: true, sortable: true, filterable: true },
    ],
  },
  // PLATFORM - Warehouse transfer detail tables. SSOT mirrors
  // public.warehouse_transfer_items + public.warehouse_checkpoint_scans +
  // public.warehouse_exception_hold from the canonical warehouse migrations
  // (202510110006_domain_tables_partitioned.sql etc.). Source:
  // seed-raw/warehouse.js. Capability gate is `warehouse.read`.
  warehouse_transfer_items: {
    relation: 'warehouse_transfer_items',
    id_column: 'id',
    capability_read: 'warehouse.read',
    columns: [
      { key: 'transfer_id', label: 'Transfer', mono: true, sortable: true, filterable: true },
      { key: 'shipment_id', label: 'Shipment', mono: true, sortable: true, filterable: true },
      { key: 'expected', label: 'Expected', align: 'right', sortable: true, type: 'number' },
      { key: 'received', label: 'Received', align: 'right', sortable: true, type: 'number' },
      { key: 'status', label: 'Status', sortable: true, filterable: true },
    ],
  },
  warehouse_checkpoint_scans: {
    relation: 'warehouse_checkpoint_scans',
    id_column: 'id',
    capability_read: 'warehouse.read',
    columns: [
      { key: 'transfer_id', label: 'Transfer', mono: true, sortable: true, filterable: true },
      { key: 'shipment_id', label: 'Shipment', mono: true, sortable: true, filterable: true },
      { key: 'checkpoint', label: 'Checkpoint', sortable: true, filterable: true },
      { key: 'sequence', label: '#', align: 'right', sortable: true, type: 'number' },
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
    ],
  },
  warehouse_exception_hold: {
    relation: 'warehouse_exception_hold',
    id_column: 'id',
    capability_read: 'warehouse.read',
    columns: [
      { key: 'transfer_id', label: 'Transfer', mono: true, sortable: true, filterable: true },
      { key: 'kind', label: 'Kind', sortable: true, filterable: true },
      { key: 'notes', label: 'Notes', sortable: true },
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
    ],
  },
};

const COMMAND_CONSOLE_ROUTE_TARGETS = {
  'shipments.create': '/operate/shipments',
  'shipments.amend': '/operate/shipments',
  'shipments.cancel': '/operate/shipments',
  'shipments.resort': '/operate/shipments',
  'shipments.batch_operation': '/operate/shipments',
  'shipments.return_to_branch': '/operate/shipments',
  'route_plans.solve_sequence': '/operate/route-plans',
  'route_plans.publish': '/operate/route-plans',
  'route_plans.rebalance': '/operate/route-plans',
  'pickups.create_request': '/operate/pickups',
  'pickups.create_wave': '/operate/pickups',
  'pickups.assign_wave': '/operate/pickups',
  'exceptions.resolve': '/operate/exceptions',
  'labels.reprint': '/platform/labels',
  'warehouse.transfer_execute': '/platform/warehouse',
  'warehouse_transfers.dispatch': '/platform/warehouse',
  'warehouse_transfers.scan_departure': '/platform/warehouse',
  'warehouse_transfers.scan_arrival': '/platform/warehouse',
  'warehouse_transfers.reconcile_destination': '/platform/warehouse',
  'settings.request_change': '/platform/config',
  'user_devices.revoke': '/platform/mobile-policy',
  'webhooks.rotate_token': '/integrations/sources',
  'webhooks.toggle_source': '/integrations/sources',
  'webhooks.upsert_source': '/integrations/sources',
  'webhooks.archive_source': '/integrations/sources',
  'webhooks.toggle_rule': '/integrations/rules',
  'webhooks.upsert_rule': '/integrations/rules',
  'webhooks.delete_rule': '/integrations/rules',
  'webhooks.reorder_rule': '/integrations/rules',
  'mappings.upsert': '/integrations/mapping',
  'mappings.promote_version': '/integrations/mapping',
  'mappings.disable': '/integrations/mapping',
  'integrations.create_credential': '/integrations/credentials',
  'integrations.update_credential': '/integrations/credentials',
  'integrations.rotate_credential': '/integrations/credentials',
  'integrations.revoke_credential': '/integrations/credentials',
  'integrations.install_plugin': '/integrations/catalog',
  'integrations.create_plugin': '/integrations/plugin-studio',
  'integrations.uninstall_plugin': '/integrations/catalog',
  'integrations.retry_inbox': '/integrations/intake',
  'integrations.replay_inbox': '/integrations/intake',
  'integrations.force_inbox_status': '/integrations/intake',
  'workflow_templates.create': '/workflows/templates',
  'workflow_templates.activate': '/workflows/templates',
  'workflow_templates.deactivate': '/workflows/templates',
  'workflow_runs.replay': '/workflows/runs',
  'workflow_runs.cancel': '/workflows/runs',
  'workflow_bindings.register': '/workflows/bindings',
  'workflow_bindings.simulate': '/workflows/bindings',
  'workflow_tasks.bulk_transition': '/workflows/review-queue',
  'drivers.create': '/operate/fleet/drivers',
  'drivers.suspend': '/operate/fleet/drivers',
  'drivers.reinstate': '/operate/fleet/drivers',
  'drivers.upload_document': '/operate/fleet/drivers',
  'drivers.approve_document': '/operate/fleet/drivers',
  'drivers.reject_document': '/operate/fleet/drivers',
  'drivers.log_duty_change': '/operate/fleet/drivers',
  'invoices.create_draft': '/finance/billing',
  'invoices.send': '/finance/billing',
  'invoices.mark_paid': '/finance/billing',
  'invoices.record_refund': '/finance/billing',
  'invoices.void': '/finance/billing',
  'service_offerings.create': '/catalog/service-offerings',
  'service_offerings.edit_price': '/catalog/service-offerings',
  'service_offerings.toggle_availability': '/catalog/service-offerings',
  'service_offerings.archive': '/catalog/service-offerings',
  'marketplace.award_offer': '/network/marketplace',
  'marketplace.cancel_award': '/network/marketplace',
  'marketplace.activate_contract': '/network/marketplace',
  'marketplace.renegotiate_contract': '/network/marketplace',
  'marketplace.terminate_contract': '/network/marketplace',
  'marketplace.create_request': '/network/marketplace',
  'marketplace.refresh_reputation': '/network/marketplace',
};

function withCommandConsoleRouteTarget(command) {
  const path = COMMAND_CONSOLE_ROUTE_TARGETS[command?.key];
  if (!path) return command;
  return {
    ...command,
    route_targets: {
      ...(command.route_targets ?? {}),
      console: { path },
    },
  };
}

// ui_command_registry — drives Cmd+K palette + every action button
export const ui_command_registry = [
  { key: 'shipments.create', label: 'Create shipment', section: 'Shipments', execution: 'workflow', capability: 'shipments.write' },
  { key: 'shipments.amend', label: 'Amend shipment', section: 'Shipments', execution: 'rpc', target: 'shipment_amend_cancel_v1', capability: 'shipments.write' },
  { key: 'shipments.cancel', label: 'Cancel shipment', section: 'Shipments', execution: 'rpc', target: 'shipment_amend_cancel_v1', capability: 'shipments.write' },
  { key: 'shipments.resort', label: 'Resort shipment', section: 'Shipments', execution: 'rpc', target: 'ui_execute_shipment_resort_v1', capability: 'shipments.write' },
  { key: 'shipments.batch_operation', label: 'Bulk amend / cancel', section: 'Shipments', execution: 'rpc', target: 'ui_execute_shipment_batch_operation_v1', capability: 'shipments.write' },
  { key: 'route_plans.solve_sequence', label: 'Solve plan sequence', section: 'Route plans', execution: 'rpc', target: 'ui_solve_route_plan_v1', capability: 'route_plans.write' },
  { key: 'route_plans.publish', label: 'Publish plan', section: 'Route plans', execution: 'rpc', target: 'ui_publish_route_plan_v1', capability: 'route_plans.write' },
  { key: 'route_plans.rebalance', label: 'Rebalance plan', section: 'Route plans', execution: 'rpc', target: 'ui_rebalance_route_plan_v1', capability: 'route_plans.write' },
  { key: 'route_runs.assign', label: 'Assign run', section: 'Routes', execution: 'rpc', target: 'ui_execute_route_run_assign_v1', capability: 'routes.write', route_targets: { console: { path: '/operate/dispatch' } } },
  { key: 'route_runs.acknowledge_assignment', label: 'Acknowledge assignment', section: 'Routes', execution: 'rpc', target: 'ui_execute_route_run_assignment_response_v1', capability: 'routes.write', route_targets: { console: { path: '/operate/dispatch' } } },
  { key: 'route_runs.accept_assignment', label: 'Accept assignment', section: 'Routes', execution: 'rpc', target: 'ui_execute_route_run_assignment_response_v1', capability: 'routes.write', route_targets: { console: { path: '/operate/dispatch' } } },
  { key: 'route_runs.refuse_assignment', label: 'Refuse assignment', section: 'Routes', execution: 'rpc', target: 'ui_execute_route_run_assignment_response_v1', capability: 'routes.write', route_targets: { console: { path: '/operate/dispatch' } }, input_schema: { version: 1, fields: [{ key: 'refusal_reason', label: 'Refusal reason', type: 'textarea', required: true }] } },
  { key: 'route_runs.confirm_departure', label: 'Confirm departure', section: 'Routes', execution: 'rpc', target: 'ui_confirm_route_run_departure_v1', capability: 'routes.write', route_targets: { console: { path: '/operate/dispatch' } } },
  { key: 'route_stops.reassign', label: 'Reassign stops', section: 'Routes', execution: 'rpc', target: 'ui_execute_route_stop_reassign_v1', capability: 'routes.write', route_targets: { console: { path: '/operate/dispatch' } } },
  // Pickups RPCs gate on fleet.write per migration 202603191130_pickup_batch2_foundation_v1.sql
  // (create_pickup_wave_v1 line 1581-1582; assign_pickup_wave_v1 line 1982-1983).
  // No `pickups.write` capability is registered in any backend migration.
  { key: 'pickups.create_request', label: 'Create pickup request', section: 'Pickups', execution: 'rpc', target: 'create_pickup_request_v1', capability: 'fleet.write' },
  { key: 'pickups.create_wave', label: 'Create pickup wave', section: 'Pickups', execution: 'rpc', target: 'create_pickup_wave_v1', capability: 'fleet.write' },
  { key: 'pickups.assign_wave', label: 'Assign pickup wave', section: 'Pickups', execution: 'rpc', target: 'assign_pickup_wave_v1', capability: 'fleet.write' },
  { key: 'exceptions.resolve', label: 'Resolve exception (NDR)', section: 'Exceptions', execution: 'rpc', target: 'ui_execute_dispatch_exception_resolution_v1', capability: 'tasks.write' },
  { key: 'shipments.return_to_branch', label: 'Return to branch', section: 'Shipments', execution: 'rpc', target: 'record_scan_event_v1', capability: 'shipments.write' },
  { key: 'labels.reprint', label: 'Reprint label', section: 'Labels', execution: 'rpc', target: 'request_label_reprint', capability: 'labels.reprint' },
  { key: 'warehouse.transfer_execute', label: 'Execute warehouse transfer', section: 'Warehouse', execution: 'rpc', target: 'warehouse_transfer_execute_v1', capability: 'warehouse.write' },
  { key: 'warehouse_transfers.dispatch', label: 'Dispatch transfer', section: 'Warehouse', execution: 'rpc', target: 'ui_execute_warehouse_transfer_dispatch_v1', capability: 'warehouse.write' },
  { key: 'warehouse_transfers.scan_departure', label: 'Scan departure', section: 'Warehouse', execution: 'rpc', target: 'ui_execute_warehouse_transfer_checkpoint_v1', capability: 'warehouse.write' },
  { key: 'warehouse_transfers.scan_arrival', label: 'Scan arrival', section: 'Warehouse', execution: 'rpc', target: 'ui_execute_warehouse_transfer_checkpoint_v1', capability: 'warehouse.write' },
  { key: 'warehouse_transfers.reconcile_destination', label: 'Reconcile transfer', section: 'Warehouse', execution: 'rpc', target: 'ui_execute_warehouse_transfer_reconcile_v1', capability: 'warehouse.write' },
  { key: 'settings.request_change', label: 'Request settings change', section: 'Platform', execution: 'rpc', target: 'request_settings_change_v1', capability: 'settings.write' },
  { key: 'tasks.transition', label: 'Transition task', section: 'Tasks', execution: 'rpc', target: 'transition_task_v1', capability: 'tasks.write', route_targets: { console: { path: '/workflows/review-queue' } } },
  { key: 'user_devices.revoke', label: 'Revoke device', section: 'Mobile', execution: 'rpc', target: 'ui_execute_user_device_revoke_v1', capability: 'user_devices.write' },
  // Webhook ingress operator commands (webhook_sources + webhook_rules surfaces).
  // No dedicated rotate RPC exists in the demo seam yet — runCommand routes the
  // call through the generic command runner, mirroring how the canonical
  // `webhooks.rotate_token` would behave once shipped.
  { key: 'webhooks.rotate_token', label: 'Rotate webhook token', section: 'External Intake', execution: 'rpc', target: 'ui_rotate_webhook_source_token_v1', capability: 'webhooks.write' },
  { key: 'webhooks.toggle_source', label: 'Toggle webhook source', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_webhook_source_v1', capability: 'webhooks.write' },
  { key: 'webhooks.upsert_source', label: 'Create or update webhook source', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_webhook_source_v1', capability: 'webhooks.write' },
  { key: 'webhooks.archive_source', label: 'Archive webhook source', section: 'External Intake', execution: 'rpc', target: 'ui_archive_webhook_source_v1', capability: 'webhooks.write' },
  { key: 'webhooks.toggle_rule', label: 'Toggle webhook rule', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_webhook_rule_v1', capability: 'webhooks.write' },
  { key: 'webhooks.upsert_rule', label: 'Create or update webhook rule', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_webhook_rule_v1', capability: 'webhooks.write' },
  { key: 'webhooks.delete_rule', label: 'Delete webhook rule', section: 'External Intake', execution: 'rpc', target: 'ui_delete_webhook_rule_v1', capability: 'webhooks.write' },
  { key: 'webhooks.reorder_rule', label: 'Reorder webhook rule priority', section: 'External Intake', execution: 'rpc', target: 'ui_reorder_webhook_rule_v1', capability: 'webhooks.write' },
  // CLAIM-INTEGRATIONS-MAPPING (Phase C5) — Mapping Studio canonical commands.
  // Backend RPCs: api.ui_upsert_mapping_artifact_v1 (create/edit) +
  // api.ui_create_mapping_operation_report_v1 (audit) +
  // public.mapping_config_promote_v1 (promote version) per Phase B6.
  { key: 'mappings.upsert', label: 'Save intake mapping', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_mapping_artifact_v1', capability: 'mappings.write' },
  { key: 'mappings.promote_version', label: 'Promote intake mapping version', section: 'External Intake', execution: 'rpc', target: 'mapping_config_promote_v1', capability: 'mappings.write' },
  { key: 'mappings.disable', label: 'Disable intake mapping', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_mapping_artifact_v1', capability: 'mappings.write' },
  // CLAIM-INTEGRATIONS-CREDENTIALS (Phase C5) — provider_auth_configs lifecycle.
  { key: 'integrations.create_credential', label: 'Create provider credential', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_provider_auth_config_v1', capability: 'integration_plugins.write' },
  { key: 'integrations.update_credential', label: 'Update provider credential', section: 'External Intake', execution: 'rpc', target: 'ui_upsert_provider_auth_config_v1', capability: 'integration_plugins.write' },
  { key: 'integrations.rotate_credential', label: 'Rotate provider credential', section: 'External Intake', execution: 'rpc', target: 'integration_plugin_rotate_credentials_v1', capability: 'integration_plugins.write' },
  { key: 'integrations.revoke_credential', label: 'Revoke provider credential', section: 'External Intake', execution: 'rpc', target: 'ui_revoke_provider_auth_config_v1', capability: 'integration_plugins.write' },
  // CLAIM-INTEGRATIONS-CATALOG (Phase C5) — integration_plugins lifecycle.
  { key: 'integrations.install_plugin', label: 'Install integration plugin', section: 'Integrations', execution: 'rpc', target: 'integration_plugin_generate_draft_v1', capability: 'integration_plugins.write' },
  { key: 'integrations.create_plugin', label: 'Create integration plugin', section: 'Integrations', execution: 'rpc', target: 'integration_plugin_generate_draft_v1', capability: 'integration_plugins.write' },
  { key: 'integrations.uninstall_plugin', label: 'Rollback integration plugin release', section: 'Integrations', execution: 'rpc', target: 'integration_plugin_rollback_v1', capability: 'integration_plugins.write' },
  // CLAIM-INTEGRATIONS-WEBHOOK-INBOX (Phase C5) — webhook_inbox replay + force-status.
  { key: 'integrations.retry_inbox', label: 'Retry inbox event', section: 'External Intake', execution: 'rpc', target: 'webhook_inbox_replay_v1', capability: 'webhooks.write' },
  { key: 'integrations.replay_inbox', label: 'Replay inbox event', section: 'External Intake', execution: 'rpc', target: 'webhook_inbox_replay_v1', capability: 'webhooks.write' },
  { key: 'integrations.force_inbox_status', label: 'Force inbox status', section: 'External Intake', execution: 'rpc', target: 'webhook_inbox_force_status_v1', capability: 'webhooks.write' },
  // CLAIM-WORKFLOWS-TEMPLATES (Phase C5) — template lifecycle.
  // Wave 5 RE-AUDIT (WORKFLOWS.md P1): canonical surface gate is
  // `workflows.write` — matches B6 RPCs (ui_set_workflow_template_status_v1 +
  // register_workflow_binding_v1 + simulate_binding_dispatch_v1) and the
  // seed-raw/navigation.js workflow nav. The legacy per-resource RLS key
  // `workflow_runs.write` is preserved in the FE registry waiver list as
  // a backend-only-accepted entry.
  { key: 'workflow_templates.create', label: 'New workflow template', section: 'Workflows', execution: 'rpc', target: 'ui_create_workflow_template_v1', capability: 'workflows.write' },
  { key: 'workflow_templates.activate', label: 'Activate workflow template', section: 'Workflows', execution: 'rpc', target: 'ui_set_workflow_template_status_v1', capability: 'workflows.write' },
  { key: 'workflow_templates.deactivate', label: 'Deactivate workflow template', section: 'Workflows', execution: 'rpc', target: 'ui_set_workflow_template_status_v1', capability: 'workflows.write' },
  // CLAIM-WORKFLOWS-RUNS (Phase C5) — run lifecycle (cancel + replay).
  { key: 'workflow_runs.replay', label: 'Replay workflow run', section: 'Workflows', execution: 'rpc', target: 'progress_workflow_run', capability: 'workflows.write' },
  { key: 'workflow_runs.cancel', label: 'Cancel workflow run', section: 'Workflows', execution: 'rpc', target: 'close_workflow_run', capability: 'workflows.write' },
  // CLAIM-WORKFLOWS-BINDINGS (Phase C5) — binding lifecycle.
  { key: 'workflow_bindings.register', label: 'Register workflow binding', section: 'Workflows', execution: 'rpc', target: 'register_workflow_binding_v1', capability: 'workflows.write' },
  { key: 'workflow_bindings.simulate', label: 'Simulate binding dispatch', section: 'Workflows', execution: 'rpc', target: 'simulate_binding_dispatch_v1', capability: 'workflows.write' },
  // CLAIM-WORKFLOWS-REVIEW (Phase C5) — task transitions + bulk.
  { key: 'workflow_tasks.bulk_transition', label: 'Bulk transition tasks', section: 'Workflows', execution: 'rpc', target: 'bulk_transition_tasks_v1', capability: 'tasks.write' },
  // CLAIM-FLEET-DRIVERS — operator commands for the drivers roster. The
  // canonical RPCs are not yet registered in api.ts; runCommand is used as a
  // generic dispatcher so the demo can demonstrate flow without inventing
  // backend RPC names. Capability gate: `fleet.write` (canonical SSOT —
  // per FLEET Wave 5 re-audit D3 closure, the prior FE-invented
  // `drivers.write` / `compliance.write` keys do NOT exist in the canonical
  // rbac_permission lookup; cf. supabase/migrations/202604280050_verify_driver_document_v1.sql:6).
  { key: 'drivers.create', label: 'Add new driver', section: 'Fleet', execution: 'rpc', target: 'runCommand', capability: 'fleet.write' },
  { key: 'drivers.suspend', label: 'Suspend driver(s)', section: 'Fleet', execution: 'rpc', target: 'runCommand', capability: 'fleet.write' },
  { key: 'drivers.reinstate', label: 'Reinstate driver', section: 'Fleet', execution: 'rpc', target: 'runCommand', capability: 'fleet.write' },
  { key: 'drivers.upload_document', label: 'Upload driver document', section: 'Fleet', execution: 'rpc', target: 'runCommand', capability: 'fleet.write' },
  { key: 'drivers.approve_document', label: 'Approve driver document', section: 'Fleet', execution: 'rpc', target: 'runCommand', capability: 'fleet.write' },
  { key: 'drivers.reject_document', label: 'Reject driver document', section: 'Fleet', execution: 'rpc', target: 'runCommand', capability: 'fleet.write' },
  { key: 'drivers.log_duty_change', label: 'Log duty change', section: 'Fleet', execution: 'rpc', target: 'runCommand', capability: 'fleet.write' },
  // CLAIM-NETWORK-ZONES — operator commands for the zones surface. The
  // canonical RPCs are not yet registered in api.ts; runCommand is used as a
  // generic dispatcher so the demo can demonstrate flow without inventing
  // backend RPC names.
  { key: 'zones.create', label: 'Create zone', section: 'Network', execution: 'rpc', target: 'runCommand', capability: 'zones.write', route_targets: { console: { path: '/network/zones' } } },
  { key: 'zones.suspend', label: 'Suspend zone', section: 'Network', execution: 'rpc', target: 'runCommand', capability: 'zones.write', route_targets: { console: { path: '/network/zones' } } },
  { key: 'zones.add_district', label: 'Add district to zone', section: 'Network', execution: 'rpc', target: 'runCommand', capability: 'zones.write', route_targets: { console: { path: '/network/zones' } } },
  { key: 'zones.remove_district', label: 'Remove district from zone', section: 'Network', execution: 'rpc', target: 'runCommand', capability: 'zones.write', route_targets: { console: { path: '/network/zones' } } },
  { key: 'zones.approve_override', label: 'Approve override request', section: 'Network', execution: 'rpc', target: 'runCommand', capability: 'zones.write', route_targets: { console: { path: '/network/zones' } } },
  { key: 'zones.deny_override', label: 'Deny override request', section: 'Network', execution: 'rpc', target: 'runCommand', capability: 'zones.write', route_targets: { console: { path: '/network/zones' } } },
  // CLAIM-FINANCE-BILLING — operator commands for the billing/invoices
  // surface. The canonical RPCs are not yet registered in api.ts; runCommand
  // is used as a generic dispatcher so the demo can demonstrate flow without
  // inventing backend RPC names. Note the explicit split between billing.write
  // (draft/edit/void/cancel subscription), invoices.send (broadcast), and
  // invoices.refund (issued-invoice refund) so a junior accountant can manage
  // drafts without the broadcast or refund authority.
  { key: 'invoices.create_draft', label: 'New invoice (draft)', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'billing.write' },
  { key: 'invoices.add_line', label: 'Add invoice line', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'billing.write' },
  { key: 'invoices.remove_line', label: 'Remove invoice line', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'billing.write' },
  { key: 'invoices.send', label: 'Send invoice', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'invoices.send' },
  { key: 'invoices.mark_paid', label: 'Record invoice payment', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'billing.write' },
  { key: 'invoices.record_refund', label: 'Record refund', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'invoices.refund' },
  { key: 'invoices.void', label: 'Void invoice', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'billing.write' },
  { key: 'invoices.reissue', label: 'Re-issue invoice', section: 'Billing', execution: 'rpc', target: 'runCommand', capability: 'invoices.send' },
  // CLAIM-CATALOG-OFFERINGS — operator commands for the service catalog
  // surface (service_levels + service_offerings). Canonical write capability
  // is `agreements.write` per supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql,
  // exposed on the operator surface as the alias `service_offerings.write`.
  // The canonical RPCs are not yet registered in api.ts; runCommand acts as a
  // generic dispatcher so the demo demonstrates flow without inventing
  // backend RPC names.
  { key: 'service_offerings.create', label: 'New offering', section: 'Catalog', execution: 'rpc', target: 'runCommand', capability: 'service_offerings.write' },
  { key: 'service_offerings.edit_price', label: 'Edit offering price', section: 'Catalog', execution: 'rpc', target: 'runCommand', capability: 'service_offerings.write' },
  { key: 'service_offerings.toggle_availability', label: 'Toggle offering availability', section: 'Catalog', execution: 'rpc', target: 'runCommand', capability: 'service_offerings.write' },
  { key: 'service_offerings.archive', label: 'Archive offering', section: 'Catalog', execution: 'rpc', target: 'runCommand', capability: 'service_offerings.write' },
  // CLAIM-NETWORK-MARKETPLACE — operator commands for the marketplace surface
  // (offers / awards / contracts / requests / reputation). Canonical RPCs are
  // not yet registered in api.ts; runCommand acts as a generic dispatcher so
  // the demo demonstrates flow without inventing backend RPC names.
  { key: 'marketplace.award_offer', label: 'Award offer', section: 'Marketplace', execution: 'rpc', target: 'runCommand', capability: 'marketplace.write' },
  { key: 'marketplace.cancel_award', label: 'Cancel award', section: 'Marketplace', execution: 'rpc', target: 'runCommand', capability: 'marketplace.write' },
  { key: 'marketplace.activate_contract', label: 'Activate contract', section: 'Marketplace', execution: 'rpc', target: 'runCommand', capability: 'marketplace.write' },
  { key: 'marketplace.renegotiate_contract', label: 'Renegotiate contract', section: 'Marketplace', execution: 'rpc', target: 'runCommand', capability: 'marketplace.write' },
  { key: 'marketplace.terminate_contract', label: 'Terminate contract', section: 'Marketplace', execution: 'rpc', target: 'runCommand', capability: 'marketplace.write' },
  { key: 'marketplace.create_request', label: 'New marketplace request', section: 'Marketplace', execution: 'rpc', target: 'runCommand', capability: 'marketplace.write' },
  { key: 'marketplace.refresh_reputation', label: 'Refresh reputation snapshots', section: 'Marketplace', execution: 'rpc', target: 'runCommand', capability: 'marketplace.write' },
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — operator commands for the API
  // gateway observability surface (Datadog APM / Honeycomb / Postman parity).
  // Canonical RPCs not yet registered in api.ts; runCommand acts as a generic
  // dispatcher so the demo demonstrates flow without inventing backend RPC
  // names. Note the explicit split between read-only investigations (replay,
  // copy curl) which require api_gateway.read, and operational levers
  // (block source, adjust rate limit) which require api_gateway.write so a
  // junior on-call engineer can investigate without the block authority.
  { key: 'api_gateway.block_source', label: 'Block API source', section: 'External Intake', execution: 'rpc', target: 'runCommand', capability: 'api_gateway.write', route_targets: { console: { path: '/insights/api-gateway' } } },
  { key: 'api_gateway.adjust_rate_limit', label: 'Adjust API rate limit', section: 'External Intake', execution: 'rpc', target: 'runCommand', capability: 'api_gateway.write', route_targets: { console: { path: '/insights/api-gateway' } } },
  { key: 'api_gateway.replay_request', label: 'Replay API request (curl)', section: 'External Intake', execution: 'rpc', target: 'runCommand', capability: 'api_gateway.read', route_targets: { console: { path: '/insights/api-gateway' } } },
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — operator commands for alerts
  // management. Canonical RPCs not yet registered in api.ts; runCommand acts
  // as a generic dispatcher so the demo demonstrates flow without inventing
  // backend RPC names. Datadog/PagerDuty/Sentry parity surface.
  { key: 'alerts.create_rule', label: 'New alert rule', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'alerts.write', route_targets: { console: { path: '/platform/alerts' } } },
  { key: 'alerts.pause_rule', label: 'Pause alert rule', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'alerts.write', route_targets: { console: { path: '/platform/alerts' } } },
  { key: 'alerts.resume_rule', label: 'Resume alert rule', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'alerts.write', route_targets: { console: { path: '/platform/alerts' } } },
  { key: 'alerts.delete_rule', label: 'Delete alert rule', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'alerts.write', route_targets: { console: { path: '/platform/alerts' } } },
  { key: 'alerts.test_rule', label: 'Test alert rule against payload', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'alerts.read', route_targets: { console: { path: '/platform/alerts' } } },
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — operator commands for the
  // feature-flags surface (LaunchDarkly/Unleash/GrowthBook parity). Canonical
  // RPCs not yet registered in api.ts; runCommand acts as a generic dispatcher
  // so the demo demonstrates flow without inventing backend RPC names.
  { key: 'feature_flags.create', label: 'New feature flag', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'feature_flags.write', route_targets: { console: { path: '/platform/feature-flags' } } },
  { key: 'feature_flags.toggle', label: 'Toggle feature flag', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'feature_flags.write', route_targets: { console: { path: '/platform/feature-flags' } } },
  { key: 'feature_flags.set_rollout', label: 'Set flag rollout %', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'feature_flags.write', route_targets: { console: { path: '/platform/feature-flags' } } },
  { key: 'feature_flags.engage_kill_switch', label: 'Engage flag kill switch', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'feature_flags.write', route_targets: { console: { path: '/platform/feature-flags' } } },
  { key: 'feature_flags.release_kill_switch', label: 'Release flag kill switch', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'feature_flags.write', route_targets: { console: { path: '/platform/feature-flags' } } },
  { key: 'feature_flags.bulk_toggle', label: 'Bulk toggle feature flags', section: 'Platform', execution: 'rpc', target: 'runCommand', capability: 'feature_flags.write', route_targets: { console: { path: '/platform/feature-flags' } } },
  // CLAIM-IDENTITY-RBAC (Phase E3) — RBAC role-management lifecycle commands.
  // Backend RPC verification status:
  //   - rbac_create_role_v1 / rbac_update_role_v1 / rbac_delete_role_v1 — SHIPPED (202604290100..202604290120)
  //   - rbac_grant_role_v1 / rbac_revoke_role_v1 — SHIPPED (202604290130..202604290140)
  //   - provision_rbac_roles_from_templates_v1 — SHIPPED (supabase/migrations/202601300050_rbac_role_templates_v1.sql:215)
  // Command-palette rows route to /platform/access and advertise the typed RPC
  // target; they must not point at the generic runCommand substrate.
  { key: 'rbac_roles.create', label: 'Create RBAC role', section: 'Platform', execution: 'rpc', target: 'rbac_create_role_v1', capability: 'access_policy.approve', route_targets: { console: { path: '/platform/access' } } },
  { key: 'rbac_roles.edit', label: 'Edit RBAC role', section: 'Platform', execution: 'rpc', target: 'rbac_update_role_v1', capability: 'access_policy.approve', route_targets: { console: { path: '/platform/access' } } },
  { key: 'rbac_roles.delete', label: 'Delete RBAC role', section: 'Platform', execution: 'rpc', target: 'rbac_delete_role_v1', capability: 'access_policy.approve', route_targets: { console: { path: '/platform/access' } } },
  { key: 'rbac_roles.grant', label: 'Grant role to user', section: 'Platform', execution: 'rpc', target: 'rbac_grant_role_v1', capability: 'access_policy.approve', route_targets: { console: { path: '/platform/access' } } },
  { key: 'rbac_roles.revoke', label: 'Revoke role from user', section: 'Platform', execution: 'rpc', target: 'rbac_revoke_role_v1', capability: 'access_policy.approve', route_targets: { console: { path: '/platform/access' } } },
  { key: 'rbac_roles.apply_template', label: 'Apply RBAC role template', section: 'Platform', execution: 'rpc', target: 'provision_rbac_roles_from_templates_v1', capability: 'access_policy.approve', route_targets: { console: { path: '/platform/access' } } },
].map(withCommandConsoleRouteTarget);

// settings_category_registry — drives the Configuration tree
export const settings_category_registry = [
  { category: 'route_assignment_policy', domain: 'Operations', scopes: ['global', 'tenant', 'client', 'sender'], approval_required: true, schema_id: 'route_assignment_policy.v1' },
  { category: 'dispatch_policy', domain: 'Operations', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'dispatch_policy.v1' },
  { category: 'shipment_operation_policy', domain: 'Operations', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'shipment_operation_policy.v1' },
  { category: 'basket_policy', domain: 'Operations', scopes: ['global', 'tenant', 'client', 'sender'], approval_required: true, schema_id: 'basket_policy.v1', request_capability: 'baskets.write' },
  { category: 'pickup_policy', domain: 'Operations', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'pickup_policy.v1' },
  { category: 'ndr_policy', domain: 'Operations', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'ndr_policy.v1' },
  { category: 'pod.required_evidence', domain: 'Operations', scopes: ['global', 'tenant', 'client', 'sender', 'resource'], approval_required: false, schema_id: 'pod_evidence.v1' },
  { category: 'route.allow_partial_publish', domain: 'Operations', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'route_partial.v1' },
  { category: 'route.solver.timeout_seconds', domain: 'Operations', scopes: ['global', 'tenant'], approval_required: false, schema_id: 'solver_timeout.v1' },
  { category: 'webhook_ingest_policy', domain: 'Integrations', scopes: ['global', 'tenant', 'client', 'sender'], approval_required: true, schema_id: 'webhook_ingest_policy.v1' },
  // W26 Cycle B closure — provider_credential_policy.expiring_days_threshold
  // governs the days-until-expiry chip warn/danger thresholds on the
  // integrations/credentials.tsx surface. Replaces inline `30` literal in
  // `deriveCredStatus` and the days-left chip render branch.
  { category: 'provider_credential_policy', domain: 'Integrations', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'provider_credential_policy.v1' },
  { category: 'marketing_demo_intake_policy', domain: 'Marketing', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'marketing_demo_intake.v1' },
  { category: 'marketing_landing_clients_policy', domain: 'Marketing', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'marketing_landing_clients.v1' },
  { category: 'mobile_visibility_policy', domain: 'Mobile', scopes: ['global', 'tenant', 'client', 'sender', 'resource'], approval_required: true, schema_id: 'mobile_visibility.v1' },
  { category: 'mobile_diagnostics_policy', domain: 'Mobile', scopes: ['global', 'tenant'], approval_required: false, schema_id: 'mobile_diagnostics.v1' },
  { category: 'device_policy', domain: 'Mobile', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'device_policy.v1' },
  { category: 'navigation_policy', domain: 'Mobile', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'navigation_policy.v1' },
  { category: 'map_policy', domain: 'Mobile', scopes: ['global', 'tenant', 'client'], approval_required: false, schema_id: 'map_policy.v1' },
  { category: 'communication_policy', domain: 'Mobile', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'communication_policy.v1' },
  { category: 'address_policy', domain: 'Mobile', scopes: ['global', 'tenant', 'client'], approval_required: false, schema_id: 'address_policy.v1' },
  { category: 'driver_safety_policy', domain: 'Mobile', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'driver_safety.v1' },
  { category: 'ux_safety_policy', domain: 'Mobile', scopes: ['global', 'tenant'], approval_required: false, schema_id: 'ux_safety.v1' },
  { category: 'mobile_attestation_policy', domain: 'Mobile', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'mobile_attestation.v1' },
  { category: 'cod.collection.method', domain: 'Finance', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'cod_collection.v1' },
  { category: 'cod.float.max_per_driver', domain: 'Finance', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'cod_float.v1' },
  { category: 'settlement.frequency', domain: 'Finance', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'settlement_freq.v1' },
  { category: 'settlement.holdback_pct', domain: 'Finance', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'settlement_holdback.v1' },
  { category: 'bank_reconciliation_policy', domain: 'Finance', scopes: ['global', 'tenant', 'client', 'sender', 'source', 'resource'], approval_required: false, schema_id: 'bank_reconciliation_policy.v1' },
  { category: 'bank_recon_policy', domain: 'Finance', scopes: ['global', 'tenant', 'client', 'sender', 'source', 'resource'], approval_required: false, schema_id: 'bank_recon_policy.v1' },
  { category: 'live_tail_policy', domain: 'Observability', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'live_tail_policy.v1' },
  { category: 'warehouse_transfer_policy', domain: 'Warehouse', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'warehouse_transfer.v1' },
  { category: 'scan_policy', domain: 'Warehouse', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'scan_policy.v1' },
  { category: 'task_policy', domain: 'Tasks', scopes: ['global', 'tenant'], approval_required: false, schema_id: 'task_policy.v1' },
  { category: 'task_sla_policy', domain: 'Tasks', scopes: ['global', 'tenant', 'client'], approval_required: true, schema_id: 'task_sla.v1' },
  // Cycle E2 (Workflows P1 #7 + P2 #11) — workflow_binding_defaults
  // canonical policy registration. Backs the Workflows binding modal
  // (default priority/stage/scope_type) and the condition editor
  // depth cap (replaces MAX_DEPTH module constant).
  { category: 'workflow_binding_defaults', domain: 'Workflows', scopes: ['global', 'tenant'], approval_required: true, schema_id: 'workflow_binding_defaults.v1' },
];

// Capability catalog (subset that matters for the demo)
export const capabilities = [
  'shipments.read', 'shipments.write',
  'routes.read', 'routes.write', 'routes.scan_load', 'routes.confirm_departure',
  'route_plans.read', 'route_plans.write',
  'baskets.read', 'baskets.write',
  // Pickups read seam stays distinct; write seam is canonical fleet.write
  // (no pickups.write capability registered in any migration).
  'pickups.read',
  // CLAIM-FLEET — canonical RBAC keys for the fleet/driver surfaces. These
  // gate every read on `vehicles` / `vehicle_*` / `driver_profiles` /
  // `driver_documents` / `driver_compliance_events` plus every write on
  // those tables (including pickup write RPCs). Matches the canonical
  // backend RBAC policy at
  // supabase/migrations/202601300050_rbac_role_templates_v1.sql.
  'fleet.read', 'fleet.write',
  'tasks.read', 'tasks.write', 'tasks.complete',
  'settlements.read', 'settlements.write',
  'cod.read',
  'finance.read', 'finance.write',
  // CLAIM-FINANCE-DISPUTES (Phase B5/C4) — `disputes.read` gates the operator
  // dispute queue. `disputes.write` is the canonical FINANCE-domain write
  // capability for resolve/reject mutations introduced in Phase B5
  // (supabase/migrations/202604281000_phase_b5_finance_caps_v1.sql:60-61
  // — keys registered in access_control_policy SSOT). It is distinct from
  // marketplace_disputes.write, which lives in the MARKETPLACE namespace and
  // gates `/console/marketplace/disputes`. The FINANCE seam routes through
  // `dispute_resolve_v1` / `dispute_reject_v1` per
  // supabase/migrations/202604281100_dispute_resolve_v1.sql + 202604281110_dispute_reject_v1.sql.
  'disputes.read', 'disputes.write',
  'workflows.read', 'workflows.write',
  'integrations.read', 'integrations.write',
  // webhook ingress operator surfaces — webhook_sources + webhook_rules
  // (mirrors RLS gate on those tables per supabase/migrations/202601071220:110/113).
  'webhooks.read', 'webhooks.write',
  // CLAIM-INTEGRATIONS-MAPPING (Phase B6/C5) — canonical mapping_configs
  // capability gates. Mirrors the RLS policy on public.mapping_configs per
  // supabase/migrations/202601071220_access_control_policy_ui_resources.sql:104.
  // `mappings.read` gates the Mapping Studio table + drawer; `mappings.write`
  // gates Create / Edit / Promote-version / Disable actions. The surface is
  // distinct from the `integrations.*` umbrella so a junior integrator can
  // edit mappings without holding broader integration plugin authority.
  'mappings.read', 'mappings.write',
  // Wave 9 W9-2 (CLAIM-INTEGRATIONS REVISION 36%) — canonical integration
  // plugin capability gates per
  // supabase/migrations/202602220020_access_control_policy_integration_plugins_v1.sql.
  // `integration_plugins.read` gates the Plugin catalog list/drawer;
  // `integration_plugins.write` gates Install/Create/Submit authoring;
  // `integration_plugins.test|approve|activate` gate validation runs,
  // approval decisions, activation and runtime binding changes. Distinct from
  // `integrations.*` umbrella so plugin lifecycle authority can be granted
  // without all of integrations or draft authoring.
  'integration_plugins.read',
  'integration_plugins.write',
  'integration_plugins.test',
  'integration_plugins.approve',
  'integration_plugins.activate',
  // Wave 9 W9-2 — canonical provider_auth capability per
  // supabase/migrations/202601022113_access_control_policy_core.sql:221.
  // `provider_auth.read` gates the Credentials list/drawer reads; write
  // actions on the page (Rotate / Revoke) continue to use the canonical
  // plugin/system write capabilities consumed by the underlying RPCs.
  'provider_auth.read',
  'observability.read',
  'audit_log.read',
  'settings.read', 'settings.write',
  'system.write',
  'console_metadata.read',
  // CLAIM-IDENTITY-CAPS — canonical access policy capability (mirrors backend
  // SSOT in supabase/migrations/202601022113_access_control_policy_core.sql:209
  // — `access_policy.read`). Earlier the FE shipped a non-canonical alias
  // `access.read` which would have failed-closed against the backend
  // capability catalog. Renamed in lockstep with the navigation/module/test
  // call-sites.
  'access_policy.read',
  // CLAIM-IDENTITY-RBAC (Phase E3) — canonical write capability for the RBAC
  // role-management lifecycle on `/platform/access`. Gates Create/Edit/Delete
  // role + Grant/Revoke role + Apply template (governance-grade write
  // authority — split from .read per the A1 capability alignment audit).
  'access_policy.approve',
  'organizations.read', 'organizations.write',
  // CLAIM-PLATFORM-ORG-SIGNUP — tenant signup intake review queue capabilities
  // (mirrors backend SSOT in
  // supabase/migrations/202602201020_access_control_policy_tenant_signup_requests_v1.sql:38-66
  // — `tenant_signup_requests.read` + `tenant_signup_requests.review`). The
  // surface is consumed by `/platform/organizations` Signup-requests tab.
  'tenant_signup_requests.read', 'tenant_signup_requests.review',
  // CLAIM-NETWORK-MARKETPLACE — marketplace participant request review queue
  // (mirrors backend SSOT for `marketplace_participant_requests`). Surface
  // is `/network/marketplace/participant-applications`. The participant
  // create RPCs ride on the same canonical category.
  'marketplace_participant_requests.read', 'marketplace_participant_requests.review',
  'clients.read', 'clients.write',
  'senders.read', 'senders.write',
  'recipients.read', 'recipients.write',
  'lookups.read', 'lookups.write',
  'addresses.read',
  'network.read',
  // CLAIM-NETWORK-MARKETPLACE — explicit marketplace capability gate (mirrors
  // the RLS policy on public.marketplace_offers / marketplace_awards /
  // marketplace_contracts / marketplace_requests / reputation_snapshots).
  // marketplace.read existed pre-Wave-2 (consumed by /network/partners);
  // marketplace.write is added here so award/cancel/activate/renegotiate/
  // terminate/refresh-reputation actions can be policy-gated.
  'marketplace.read', 'marketplace.write',
  'labels.read', 'labels.write', 'labels.download',
  'label_design.read', 'label_design.write',
  'warehouse.read', 'warehouse.write',
  // W16-5 (CLAIM-PLATFORM-IMPORTS) — imports.read gates the canonical
  // import_jobs DataTable + drawer; imports.write gates Submit / Cancel
  // through canonical RPCs (import_job_create_v1 / import_job_cancel_v1)
  // per supabase/migrations/202604301905_import_job_rpcs_v1.sql.
  'imports.read', 'imports.write',
  'devices.write',
  'user_devices.read',
  'user_devices.write',
  'insights.read',
  // CLAIM-FLEET-DRIVERS — driver tables (driver_profiles / driver_documents /
  // driver_compliance_events from supabase/migrations/202601311230_enterprise_ops_v1.sql)
  // gate on canonical `fleet.read` / `fleet.write` per the registry's
  // resource entries (`capability_read: 'fleet.read'`, `capability_write:
  // 'fleet.write'` at lines 318-319, 333-334, 347-348). Per FLEET Wave 10 D3
  // closure, the FE-invented `drivers.read` / `drivers.write` /
  // `compliance.write` keys do NOT exist in the canonical rbac_permission
  // lookup (cf. supabase/migrations/202604280050_verify_driver_document_v1.sql:6
  // explicit disclaimer + line 43 capability assertion against `fleet.write`)
  // and have been retired from this catalog. `fleet.read` / `fleet.write` are
  // already declared above (CLAIM-FLEET) and grant the full driver/vehicle
  // RBAC surface.
  // CLAIM-NETWORK-BRANCHES — explicit branches capability gate (mirrors the
  // RLS policy on public.branches / public.branch_memberships /
  // public.branch_capacity_windows / public.branch_coverage_windows /
  // public.branch_zones in
  // supabase/migrations/202601212340_branches_coverage_foundation.sql and
  // supabase/migrations/202601300340_rbac_branches_write_gates_v1.sql).
  'branches.read', 'branches.write',
  // CLAIM-NETWORK-ZONES — explicit zones capability gate (mirrors the RLS
  // policy on public.zones / public.zone_districts / public.zone_override_requests
  // in supabase/migrations/202512261200_zones_baskets.sql).
  'zones.read', 'zones.write',
  // CLAIM-FINANCE-BILLING — explicit billing capability gates (mirrors the
  // canonical access_control_policy_core entries that gate billing_invoices /
  // billing_invoice_lines / billing_invoice_events / subscriptions /
  // usage_events / commercial_agreements). `invoices.send` and
  // `invoices.refund` are split from `billing.write` so a junior accountant can
  // edit drafts without holding the broadcast/refund authority.
  'billing.read', 'billing.write',
  'invoices.send', 'invoices.refund',
  // CLAIM-CATALOG-OFFERINGS — service catalog capability gates. Canonical
  // backend SSOT for writes is `agreements.write` per
  // supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
  // (service_levels_write_policy + service_offerings_write_policy). The
  // surface aliases `service_offerings.read` / `service_offerings.write` keep
  // the operator UI gating descriptive at the call-site; both are granted
  // alongside `agreements.write` in seed.js for super_admin / ops_admin /
  // account_manager so the surface flows end-to-end without role drift.
  'service_offerings.read', 'service_offerings.write',
  'agreements.write',
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — API gateway observability
  // capabilities. Mirrors the RLS policy on public.api_call_log /
  // public.api_gateway_requests / public.api_gateway_rate_limits /
  // public.api_routes / public.api_route_packs / public.provider_health_logs.
  // `api_gateway.read` gates the live-tail DataTable + KPI strip + drawer
  // (Request / Response / Latency / Rate limit / Replay tabs).
  // `api_gateway.write` gates the operational levers (block source, adjust
  // rate limit). Demo grants: super_admin (wildcard), ops_admin
  // (read + write), account_manager (read only) — see seed.js dev_roles.
  'api_gateway.read', 'api_gateway.write',
  // CLAIM-SUPPORT-CASES (Wave 3, Phase C) — Zendesk/Front/Linear-triage parity
  // capabilities. Mirrors the RLS policy on public.support_cases /
  // public.support_case_messages / public.support_case_assignments.
  // `support.read` gates the queue + thread + customer profile + KPI strip.
  // `support.write` gates assignment / status / bulk / message-send actions.
  // `manual_review.resolve` gates public-tracking customer change review.
  // Demo grants: super_admin (wildcard), ops_admin (read + write),
  // account_manager (read only) — see seed.js dev_roles.
  'support.read', 'support.write', 'manual_review.resolve',
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — alerts management capabilities.
  // Mirrors the RLS policy on public.alert_rules / public.alert_triggers /
  // public.ops_alerts. `alerts.read` gates rule + trigger + ops_alert listing
  // (table + drawer history + active alerts cross-link). `alerts.write` gates
  // create/edit/pause/resume/delete actions. Demo grants: super_admin
  // (wildcard), ops_admin (read + write), account_manager (read only) — see
  // seed.js dev_roles.
  'alerts.read', 'alerts.write',
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — feature-flag management
  // capabilities. Mirrors the RLS policy on public.feature_flags.
  // `feature_flags.read` gates the flag table + drawer (Profile/Targeting/
  // Rollout/History tabs) + KPI strip. `feature_flags.write` gates create /
  // toggle / set-rollout / engage-kill-switch / release-kill-switch /
  // bulk-toggle actions. Demo grants: super_admin (wildcard), ops_admin
  // (read + write), account_manager (read only) — see seed.js dev_roles.
  'feature_flags.read', 'feature_flags.write',
  // CLAIM-IDENTITY-SESSIONS (Phase E2) — operator-visible auth sessions
  // capabilities. Mirrors the canonical access_control_policy_core entries
  // (supabase/migrations/202601022113_access_control_policy_core.sql:216-217).
  // `users.read` gates self-only session visibility (UserMenuDrawer "Your
  // sessions" tab + per-user drilldown read). `users.manage` gates the per-
  // row Revoke action which routes through the Phase B6 RPC
  // `revoke_session_v1` (supabase/migrations/202604280212). Cross-tenant
  // targets are rejected at the RPC unless the caller is a platform user.
  'users.read', 'users.manage',
  // W38-OPERATIONS P2-1 closure — register operator-surface capability
  // strings used by FE Buttons that previously had no FE registry entry,
  // so the per-operator UX gating fail-closes consistently in CI test
  // harnesses that don't pass the wildcard `'all'` capability.
  //
  // `comms.write` is canonical (per
  // supabase/migrations/202604301600_enqueue_comms_attempt_v1.sql:122-126
  // `enqueue_comms_attempt_v1` enforces
  // `user_has_resource_capability_v1('comms', 'write')`). FE callsite:
  // shipments.tsx CommsTab "Send now".
  //
  // `warehouse.scan` is FE-only UX gating for warehouse intake/return
  // scan affordances (returned-to-branch.tsx Intake scan + Record scan).
  // The backend does not explicitly assert this string in any RPC;
  // record_scan_event_v1 validates auth + tenant scope only. Registered
  // here as a defense-in-depth UX gate so operators without scan rights
  // see the affordance disabled rather than always-enabled. Aligned with
  // the canonical `warehouse.read|write` resource family.
  //
  // `labels.reprint` is the canonical UX gate for label reprint affordances
  // (shipments.tsx LabelsTab + bulk + drawer + command palette). The
  // canonical `request_label_reprint` RPC relies on labels-table RLS + actor
  // scope, while Console V2 uses this capability to keep operator entry
  // points aligned with the access policy.
  'comms.write',
  'warehouse.scan',
  'labels.reprint',
];

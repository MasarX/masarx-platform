// lookups.js — mirrors lookup_definitions + lookup_values
// SSOT for status enums, decision categories, scope types, settlement_kinds, task statuses, etc.
// Anchored in supabase/migrations/202510110003_mapping_lookup.sql + scope_type_registry seed.

const integrationPluginSourceTypeRows = [
  { value: 'manual', label: 'Manual', tone: 'neutral', rank: 10, is_default: true },
  { value: 'webhook_sample', label: 'Webhook Sample', tone: 'info', rank: 20 },
  { value: 'curl', label: 'cURL', tone: 'info', rank: 30 },
  { value: 'openapi', label: 'OpenAPI', tone: 'info', rank: 40 },
];

const integrationPluginAuthModeRows = [
  { value: 'api_key_header', label: 'API Key Header', tone: 'neutral', rank: 10, is_default: true },
  { value: 'bearer_token_header', label: 'Bearer Header', tone: 'neutral', rank: 20 },
  { value: 'basic_auth_header', label: 'Basic Header', tone: 'neutral', rank: 30 },
];

export const lookups = {
  // Shipment lifecycle
  // W71-Operate (Cycle F-R-11) closure: each row carries
  //   • `metadata.is_at_risk_eligible` — flagged on `failed_attempt` so the
  //     `isShipmentRisk` derivation in operate/shipments.tsx no longer compares
  //     against an inline `'failed_attempt'` literal.
  //   • `metadata.requires_promised_check` — flagged on `out_for_delivery` so
  //     the OFD-past-promise risk path also resolves through canonical SSOT.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  shipment_status: [
    { value: 'pending', label: 'Pending', tone: 'info', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'awaiting_pickup', label: 'Awaiting pickup', tone: 'info', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'picked_up', label: 'Picked up', tone: 'info', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'in_transit', label: 'In transit', tone: 'info', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'out_for_delivery', label: 'Out for delivery', tone: 'info', metadata: { is_at_risk_eligible: false, requires_promised_check: true } },
    { value: 'delivered', label: 'Delivered', tone: 'good', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'failed_attempt', label: 'Failed attempt', tone: 'warn', metadata: { is_at_risk_eligible: true, requires_promised_check: false } },
    { value: 'rto_in_progress', label: 'RTO in progress', tone: 'warn', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'returned_to_branch', label: 'Returned to branch', tone: 'warn', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'rto_completed', label: 'RTO completed', tone: 'neutral', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
    { value: 'cancelled', label: 'Cancelled', tone: 'neutral', metadata: { is_at_risk_eligible: false, requires_promised_check: false } },
  ],

  // W71-Operate (Cycle F-R-11) closure — canonical `shipment_amend_op`
  // taxonomy. Mirrors the canonical amend-cancel op enum used by
  // `metadata.requested_op` on shipment_amend_review tasks. Each row carries
  // `metadata.is_valid_op: true` so the `readRequestedOp` helper in
  // operate/amend-cancel.tsx resolves valid ops via canonical SSOT instead
  // of an inline 4-way `===` literal disjunction. `metadata.backend_operation`
  // is the live shipment_amend_cancel_v1 operation contract, so Console can
  // keep operator-facing request taxonomy separate from backend enum names.
  // Adding a new amend op requires only a new row + matching backend enum
  // extension.
  // The `_default` row carries `is_valid_op: false` so unknown values
  // fail-loud (helper returns null). AGENTS.md §2 (ZERO HARDCODING) +
  // §4 (SSOT) + §6 (row-driven by configuration).
  shipment_amend_op: [
    { value: 'amend_address', label: 'Amend address', tone: 'info', rank: 10, metadata: { is_valid_op: true, backend_operation: 'address' } },
    { value: 'amend_cod',     label: 'Amend COD',     tone: 'info', rank: 20, metadata: { is_valid_op: true, backend_operation: 'modify' } },
    { value: 'cancel',        label: 'Cancel',        tone: 'danger', rank: 30, metadata: { is_valid_op: true, backend_operation: 'cancel' } },
    { value: 'reschedule',    label: 'Reschedule',    tone: 'warn', rank: 40, metadata: { is_valid_op: true, backend_operation: 'reschedule' } },
    { value: '_default',      label: 'Unknown',       tone: 'neutral', rank: 99, metadata: { is_valid_op: false } },
  ],

  // W77 (Operate Cycle F-R-17 P1) — canonical `shipment_timeline_status`
  // taxonomy. Mirrors the union of statuses emitted by the canonical
  // `ui_get_shipment_timeline_v1` RPC (see
  // supabase/migrations/202604071000_uc222_shipment_timeline_v1.sql), which
  // unions `shipment_actions.canonical_status`, `decision_log.decision_outcome`,
  // `domain_events.status`, and `outbound_calls.status`. The FE rendered a
  // visual `is-pending` modifier class on rows whose status was `'pending'`
  // (terminal-but-not-yet-confirmed). `metadata.is_pending: true` flags those
  // rows so `modules/operate/shipments.tsx#TimelineTab` resolves the modifier
  // through canonical SSOT instead of comparing against an inline `'pending'`
  // literal. Adding/renaming a pending-equivalent status is a single seed
  // update. AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6 row-driven config.
  shipment_timeline_status: [
    { value: 'pending', label: 'Pending', tone: 'info',    rank: 10, metadata: { is_pending: true  } },
    { value: 'done',    label: 'Done',    tone: 'good',    rank: 20, metadata: { is_pending: false } },
  ],

  // Service type
  service_type: [
    { value: 'standard', label: 'Standard', tone: 'neutral' },
    { value: 'express', label: 'Express', tone: 'info' },
    { value: 'same_day', label: 'Same day', tone: 'good' },
    { value: 'pickup', label: 'Pickup', tone: 'info' },
    { value: 'swap', label: 'Swap', tone: 'info' },
    { value: 'rto', label: 'Return', tone: 'warn' },
  ],

  // Webhook provider types — mirrors public.webhook_sources.provider_type
  // enum allowlist per supabase/migrations/202510110004_webhook_integration.sql:185-208.
  webhook_provider_type: [
    { value: 'shopify', label: 'Shopify', tone: 'info' },
    { value: 'woocommerce', label: 'WooCommerce', tone: 'info' },
    { value: 'generic', label: 'Generic JSON', tone: 'neutral' },
    { value: 'custom_erp', label: 'Custom ERP', tone: 'neutral' },
    { value: 'delivery_provider', label: 'Delivery provider', tone: 'warn' },
  ],

  // Route run status
  route_run_status: [
    { value: 'pending', label: 'Pending', tone: 'info' },
    { value: 'awaiting', label: 'Awaiting', tone: 'info' },
    { value: 'in_progress', label: 'In progress', tone: 'info' },
    { value: 'at_risk', label: 'At risk', tone: 'warn' },
    { value: 'completed', label: 'Completed', tone: 'good' },
    { value: 'cancelled', label: 'Cancelled', tone: 'neutral' },
  ],

  // Route plan lifecycle (AGENTS.md lines 45-48)
  // W54-C closure — `metadata.stage` projects each cloud `route_plans.status`
  // value onto the canonical six-stage UX lifecycle stepper (draft / solved /
  // frozen / published / applied / executing). Cloud lookup values
  // (created/submitted/solved/applied/failed/canceled) collapse onto the
  // richer FE stage taxonomy so the stepper highlights the cloud-authoritative
  // progress without duplicating the mapping in module code. Consumed by
  // operate/route-plans.tsx (replaces inline mapDbStatusToStage switch).
  // W71-Operate (Cycle F-R-11) closure: `metadata.is_sla_breach_eligible`
  // flags the `published` row so the SLA breach derivation in
  // operate/route-plans.tsx (`isSlaBreach`) resolves via canonical SSOT
  // instead of comparing against an inline `'published'` literal.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  route_plan_status: [
    { value: 'draft',     label: 'Draft',     tone: 'neutral', is_default: true, metadata: { stage: 'draft', is_sla_breach_eligible: false } },
    { value: 'solved',    label: 'Solved',    tone: 'info',    metadata: { stage: 'solved', is_sla_breach_eligible: false } },
    { value: 'frozen',    label: 'Frozen',    tone: 'info',    metadata: { stage: 'frozen', is_sla_breach_eligible: false } },
    { value: 'published', label: 'Published', tone: 'good',    metadata: { stage: 'published', is_sla_breach_eligible: true } },
    { value: 'applied',   label: 'Applied',   tone: 'good',    metadata: { stage: 'applied', is_sla_breach_eligible: false } },
    { value: 'executing', label: 'Executing', tone: 'info',    metadata: { stage: 'executing', is_sla_breach_eligible: false } },
    { value: 'archived',  label: 'Archived',  tone: 'neutral', metadata: { stage: 'draft', is_sla_breach_eligible: false } },
    // Cloud lookup values projected onto FE stage taxonomy.
    { value: 'created',   label: 'Created',   tone: 'neutral', metadata: { stage: 'draft', is_sla_breach_eligible: false } },
    { value: 'submitted', label: 'Submitted', tone: 'info',    metadata: { stage: 'draft', is_sla_breach_eligible: false } },
    { value: 'failed',    label: 'Failed',    tone: 'danger',  metadata: { stage: 'draft', is_sla_breach_eligible: false } },
    { value: 'canceled',  label: 'Canceled',  tone: 'neutral', metadata: { stage: 'draft', is_sla_breach_eligible: false } },
  ],

  // CYCLE-E2 STRICT-ISOLATION (P2 #5) — constraint_check_status. Drives the
  // `Dot kind=` tone for each route-plan validator row in route-plans.tsx
  // (`pass | warn | danger`), removing the inline `c.status === 'pass' ? ...`
  // ternary from the operator surface. New constraint outcomes only require
  // a seed row to acquire the right chip tone (no client branching).
  constraint_check_status: [
    { value: 'pass',   label: 'Pass',   tone: 'good' },
    { value: 'warn',   label: 'Warn',   tone: 'warn' },
    { value: 'danger', label: 'Danger', tone: 'danger' },
  ],

  // W27 Cycle D — `route_run_assignment_status` canonical taxonomy. Mirrors
  // the cloud `route_run_assignments.assignment_status` enum projected by
  // operate/dispatch.tsx insight-card. Replaces the inline ternary tone
  // branch (`completed → good / cancelled → danger / else → info`).
  route_run_assignment_status: [
    { value: 'assigned',     label: 'Assigned',     tone: 'info', is_default: true },
    { value: 'accepted',     label: 'Accepted',     tone: 'good' },
    { value: 'acknowledged', label: 'Acknowledged', tone: 'info' },
    { value: 'refused',      label: 'Refused',      tone: 'danger' },
  ],

  // W59 Cycle E2 closure (P2-1) — `route_assignment_mode` canonical taxonomy.
  // Mirrors backend SSOT seed in
  // supabase/migrations/202604061430_uc076_route_run_assignment_lifecycle_foundation_v1.sql:39-40
  // (`internal_driver` is_default=TRUE / `partner_fleet` is_default=FALSE).
  // Consumed by registry.js for the `assignment_mode` column on the
  // route_run_assignments + route_run_assignment_events views (registry.js:69, 90).
  // W71-Operate (Cycle F-R-11) closure: `metadata.is_partner` flags the
  // partner_fleet row so the `isPartnerRun` derivation in
  // operate/dispatch.tsx no longer compares against an inline
  // `'partner_fleet'` literal. AGENTS.md §2 (ZERO HARDCODING) + §6
  // (row-driven by configuration).
  route_assignment_mode: [
    { value: 'internal_driver',        label: 'Internal driver',        rank: 10, is_default: true,  metadata: { is_partner: false } },
    { value: 'partner_fleet',          label: 'Partner fleet',          rank: 20, is_default: false, metadata: { is_partner: true } },
    { value: 'alternate_capacity_pool', label: 'Alternate capacity pool', rank: 30, is_default: false, metadata: { is_partner: true } },
  ],

  // W27 Cycle D — `stop_sla_tone` canonical taxonomy. Mirrors the
  // route-plan stop SLA tone projection (`at-risk` / `on-time` /
  // `breached`) consumed by operate/route-plans.tsx stop list. Replaces
  // the inline ternary `s.sla_tone === 'at-risk' ? 'warn' : 'good'` and
  // the silent `|| '—'` fallback. Missing canonical row renders a
  // danger-toned chip with `(missing)` marker (no neutral default).
  stop_sla_tone: [
    { value: 'on-time',  label: 'On-time',  tone: 'good' },
    { value: 'at-risk',  label: 'At risk',  tone: 'warn' },
    { value: 'breached', label: 'Breached', tone: 'danger' },
  ],

  // W56-A — canonical `chip_tone` taxonomy. SSOT for the FE `ChipKind`
  // literal type (`'good' | 'warn' | 'danger' | 'info' | 'neutral' | 'ink'`)
  // exported from src/components/Chip.tsx. Consumed by the catalog/lookups
  // editor "Tone" select so the inline `<option>` literal list is gone.
  // `is_default: true` flags the canonical default tone (`neutral`) so the
  // new-value draft seeds via `getLookups('chip_tone').find(r => r.is_default)`
  // (no inline `'neutral'` literal). Missing canonical row surfaces a
  // fail-loud StateView in the New value form (no silent fallback).
  //
  // W78 (Cross-cutting Cycle F-R-18 P2) — extended each row with
  // `metadata.swatch_token` (CSS variable name used by the ZoneMap legend
  // swatch fill/border) and `metadata.is_zone_tone` (flags rows that the
  // ZoneMap polygon canvas uses for region tone painting). Replaces the
  // inline `['good', 'warn', 'danger', 'neutral']` literal array + ternary
  // swatch/borderColor mapping in `components/ZoneMap.tsx` so adding a new
  // zone tone (or renaming the canonical neutral swatch token) becomes a
  // single seed update (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6
  // row-driven config). The `neutral` row's `swatch_token: 'ink-3'`
  // preserves the prior CSS mapping (neutral zones use the `--ink-3`
  // variable, not `--neutral`).
  chip_tone: [
    { value: 'neutral', label: 'Neutral', tone: 'neutral', rank: 10, is_default: true, metadata: { swatch_token: 'ink-3', is_zone_tone: true  } },
    { value: 'info',    label: 'Info',    tone: 'info',    rank: 20,                     metadata: { swatch_token: 'info',  is_zone_tone: false } },
    { value: 'good',    label: 'Good',    tone: 'good',    rank: 30,                     metadata: { swatch_token: 'good',  is_zone_tone: true  } },
    { value: 'warn',    label: 'Warn',    tone: 'warn',    rank: 40,                     metadata: { swatch_token: 'warn',  is_zone_tone: true  } },
    { value: 'danger',  label: 'Danger',  tone: 'danger',  rank: 50,                     metadata: { swatch_token: 'danger', is_zone_tone: true  } },
    { value: 'ink',     label: 'Ink',     tone: 'ink',     rank: 60,                     metadata: { swatch_token: 'ink',   is_zone_tone: false } },
  ],

  // Settlement (AGENTS.md lines 16-17)
  settlement_kind: [
    { value: 'cod', label: 'COD' },
    { value: 'deposit', label: 'Deposit' },
    { value: 'billing', label: 'Billing' },
    { value: 'payout', label: 'Payout' },
  ],
  // W58-Finance+Support REDO closure: each row carries `metadata.lifecycle`
  // (working|terminal) plus `allows_*` flags so settlements.tsx button-disabled
  // branches resolve through canonical SSOT instead of inline status literals.
  // 'posted' and 'canceled' are terminal — no Approve / Reject allowed.
  //
  // W73-Finance Cycle F-R-13 closure (P1-2 + P2-3):
  //   • `metadata.is_aging_eligible` — drives the aging chip in
  //     modules/finance/settlements.tsx kanban (only `locked` shows the
  //     "awaiting Nh" aging tone). Replaces the inline `stage.id === 'locked'`
  //     literal at line 574 with row-driven gating.
  //   • `metadata.is_kanban_column` — drives the KANBAN_COLUMNS derivation in
  //     modules/finance/settlements.tsx so column ids/labels resolve through
  //     this canonical lookup (with rank-based ordering) instead of an inline
  //     literal array. AGENTS.md §2 + §4 + §6.
  // W75 (Finance Cycle F-R-15 P2) closure:
  //   • `metadata.is_stepper_stage` — drives the STAGES derivation in
  //     modules/finance/settlements.tsx detail-drawer Stepper. Only the
  //     four working/posting stages (open/locked/approved/posted) flag
  //     `true`; the terminal `canceled` row stays out of the stepper
  //     because it is not part of the linear progression. Replaces the
  //     inline `STAGES: StepperStage[] = [...]` literal array at
  //     settlements.tsx:50-55 with row-driven SSOT-aligned ordering.
  settlement_status: [
    { value: 'open',     label: 'Open',     tone: 'info',    rank: 10, metadata: { lifecycle: 'working',  is_terminal: false, allows_approve: false, allows_reject: true,  allows_cod_restart: false, is_aging_eligible: false, is_kanban_column: true, is_stepper_stage: true  } },
    { value: 'locked',   label: 'Locked',   tone: 'info',    rank: 20, metadata: { lifecycle: 'working',  is_terminal: false, allows_approve: true,  allows_reject: true,  allows_cod_restart: false, is_aging_eligible: true,  is_kanban_column: true, is_stepper_stage: true  } },
    { value: 'approved', label: 'Approved', tone: 'good',    rank: 30, metadata: { lifecycle: 'working',  is_terminal: false, allows_approve: false, allows_reject: false, allows_cod_restart: false, is_aging_eligible: false, is_kanban_column: true, is_stepper_stage: true  } },
    { value: 'posted',   label: 'Posted',   tone: 'good',    rank: 40, metadata: { lifecycle: 'terminal', is_terminal: true,  allows_approve: false, allows_reject: false, allows_cod_restart: false, is_aging_eligible: false, is_kanban_column: true, is_stepper_stage: true  } },
    { value: 'canceled', label: 'Canceled', tone: 'neutral', rank: 50, metadata: { lifecycle: 'terminal', is_terminal: true,  allows_approve: false, allows_reject: false, allows_cod_restart: true,  is_aging_eligible: false, is_kanban_column: true, is_stepper_stage: false } },
  ],

  settlement_batch_transition_action: [
    { value: 'lock', label: 'Lock', rank: 10, metadata: { from_status: 'open', to_status: 'locked', console_visible: true } },
    { value: 'post', label: 'Post', rank: 20, metadata: { from_status: 'approved', to_status: 'posted', console_visible: true } },
  ],

  // W70-Finance Cycle F-R-10 closure (P1-2): canonical bank_recon_match_status
  // taxonomy. Replaces inline `m.status === 'matched'` literal in
  // modules/finance/bank-recon.tsx#openUnmatchPicker. Each row carries
  // `metadata.is_active` so the FE can filter "active" reconciliation
  // matches without an inline string comparison. AGENTS.md §2 (ZERO
  // HARDCODING) + §4 (SSOT). FE-side declaration: the unmatched/ambiguous
  // rows surface in the manage-matches drawer for fail-loud display when a
  // `bank_recon_matches.status` projection ever surfaces a non-active row.
  bank_recon_match_status: [
    { value: 'matched',   label: 'Matched',   tone: 'good',    metadata: { is_active: true,  is_terminal: false } },
    { value: 'unmatched', label: 'Unmatched', tone: 'neutral', metadata: { is_active: false, is_terminal: true  } },
    { value: 'ambiguous', label: 'Ambiguous', tone: 'warn',    metadata: { is_active: false, is_terminal: false } },
  ],

  // Mirrors public.lookup_definitions.category='settlement_scope_type' (migration 202601212860)
  settlement_scope_type: [
    {
      value: 'driver_shift',
      label: 'Driver Shift',
      metadata: {
        console_context: {
          required: [
            {
              payload_key: 'subject_id',
              label: 'Driver',
              resource: 'drivers',
              value_key: 'user_id',
              subject_type: 'driver',
              hint: 'Driver shift settlements must name the driver being settled.',
            },
          ],
        },
      },
    },
    {
      value: 'branch_day',
      label: 'Branch Day',
      metadata: {
        console_context: {
          required: [
            {
              payload_key: 'branch_id',
              label: 'Branch',
              resource: 'branches',
              value_key: 'id',
              hint: 'Branch day settlements must name the branch being reconciled.',
            },
          ],
        },
      },
    },
    {
      value: 'client_cycle',
      label: 'Client Cycle',
      metadata: {
        console_context: {
          required: [
            {
              payload_key: 'client_id',
              label: 'Client',
              resource: 'clients',
              value_key: 'id',
              hint: 'Client cycle settlements must name the client account.',
            },
          ],
        },
      },
    },
    { value: 'accounting_period', label: 'Accounting Period' },
  ],

  // COD entry status — projection over delivery_completion.payment_collection canonical truth.
  // W58-Finance+Support REDO closure: each row carries:
  //   • `metadata.lifecycle` (pending|collected|reconciled|shortfall) — drives
  //     aging-chip suppression in cod.tsx (collected/remitted/handed_over hide
  //     the aging chip).
  //   • `metadata.risk` (none|warn|danger) — used for chip tone selection.
  //   • `metadata.suppress_aging_chip` — boolean shortcut for the aging-chip gate.
  // Editable-column gating for the cod cell-edit branch resolves via the
  // separate `cod_entry_editable_columns` lookup category below — column
  // editability is a column property, not a row-status property.
  cod_entry_status: [
    { value: 'pending',     label: 'Pending',     tone: 'info',    metadata: { lifecycle: 'pending',    risk: 'none',   suppress_aging_chip: false } },
    { value: 'collected',   label: 'Collected',   tone: 'good',    metadata: { lifecycle: 'collected',  risk: 'none',   suppress_aging_chip: true  } },
    { value: 'shortfall',   label: 'Shortfall',   tone: 'danger',  metadata: { lifecycle: 'shortfall',  risk: 'danger', suppress_aging_chip: false } },
    { value: 'remitted',    label: 'Remitted',    tone: 'good',    metadata: { lifecycle: 'reconciled', risk: 'none',   suppress_aging_chip: true  } },
    { value: 'handed_over', label: 'Handed over', tone: 'info',    metadata: { lifecycle: 'reconciled', risk: 'none',   suppress_aging_chip: true  } },
  ],

  // W58-Finance+Support REDO closure: canonical declaration of which
  // numeric COD columns are operator-editable. Replaces the inline
  // `baseKey === 'collected' || baseKey === 'remitted' || baseKey === 'expected'`
  // literal branch in modules/finance/cod.tsx#onCellEdit. Each row carries
  // `metadata.routes_to_metadata: true` so the cod patch helper knows the
  // value lives under `metadata.<key>` (W17-1 schema-drift) plus
  // `metadata.numeric: true` so non-numeric inputs are coerced to 0.
  cod_entry_editable_columns: [
    { value: 'collected', label: 'Collected', metadata: { routes_to_metadata: true, numeric: true } },
    { value: 'remitted',  label: 'Remitted',  metadata: { routes_to_metadata: true, numeric: true } },
    { value: 'expected',  label: 'Expected',  metadata: { routes_to_metadata: true, numeric: true } },
  ],

  // marketplace_dispute_status (migration 202603091191 / marketplace_table_contracts_reconcile_v1)
  // W58-Finance+Support REDO closure: each row carries `metadata.lifecycle`
  // (working|terminal) plus `allows_*` flags so disputes.tsx button-disabled
  // branches resolve through canonical SSOT instead of inline status literals.
  // 'resolved' and 'rejected' are terminal — no further actions allowed.
  dispute_status: [
    { value: 'open',         label: 'Open',         tone: 'info',    metadata: { lifecycle: 'working',  is_terminal: false, allows_acknowledge: true,  allows_escalate: true,  allows_reject: true,  allows_resolve: true  } },
    { value: 'submitted',    label: 'Submitted',    tone: 'info',    metadata: { lifecycle: 'working',  is_terminal: false, allows_acknowledge: true,  allows_escalate: true,  allows_reject: true,  allows_resolve: true  } },
    { value: 'under_review', label: 'Under review', tone: 'warn',    metadata: { lifecycle: 'working',  is_terminal: false, allows_acknowledge: true,  allows_escalate: true,  allows_reject: true,  allows_resolve: true  } },
    { value: 'resolved',     label: 'Resolved',     tone: 'good',    metadata: { lifecycle: 'terminal', is_terminal: true,  allows_acknowledge: false, allows_escalate: false, allows_reject: false, allows_resolve: false } },
    { value: 'rejected',     label: 'Rejected',     tone: 'neutral', metadata: { lifecycle: 'terminal', is_terminal: true,  allows_acknowledge: false, allows_escalate: false, allows_reject: false, allows_resolve: false } },
  ],

  // marketplace_participant_request_status — canonical SSOT for the
  // /network/participant-applications status filter chips. Mirrors the
  // backend lookup category (W17 marketplace network foundation +
  // marketplace_table_contracts_reconcile_v1) used by
  // public.marketplace_participant_requests.status.
  //
  // E2 closure (P1 #1) — `metadata.allowed_actions` declares which mutation
  // buttons may render for a participant request row. Replaces inline
  // `row.status === 'pending'` literal at participant-applications.tsx:478.
  // Backend RPC `marketplace_participant_request_review_apply_v1` accepts
  // decision `'approve'|'reject'|'request_additional_docs'`; the FE only
  // surfaces buttons when the canonical lifecycle row authorizes it.
  //
  // W75 (Operate Cycle F-R-15 P1) — additional metadata flags drive
  // driver-applications.tsx decisions-tab timeline event synthesis:
  //   • `metadata.review_summary_template` — formatter template for the
  //     decided-event summary line. Placeholders `{invite_redirect_to|<fb>}`
  //     and `{review_reason|<fb>}` resolve to the corresponding fields on
  //     the application row, with the literal after `|` used when the field
  //     is null/empty. Replaces inline `application.review_decision === 'approved'
  //     ? 'Application approved · invite redirected to ...' : ...` ternary at
  //     driver-applications.tsx:842.
  //   • `metadata.decision_event_type` — canonical event_type string emitted
  //     into the timeline (`application.approved` / `application.rejected`).
  //     Replaces inline literal ternary at driver-applications.tsx:849.
  // Non-decision rows (pending/withdrawn) carry `null` for both fields so
  // missing template/event_type surfaces fail-loud at consumer call sites.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  marketplace_participant_request_status: [
    { value: 'pending',   label: 'Pending',   tone: 'warn',    rank: 10, metadata: { allowed_actions: ['approve', 'reject', 'request_additional_docs'], review_summary_template: null, decision_event_type: null } },
    { value: 'approved',  label: 'Approved',  tone: 'good',    rank: 20, metadata: { allowed_actions: [], review_summary_template: 'Application approved · invite redirected to {invite_redirect_to|driver}', decision_event_type: 'application.approved' } },
    { value: 'rejected',  label: 'Rejected',  tone: 'danger',  rank: 30, metadata: { allowed_actions: [], review_summary_template: 'Application rejected · {review_reason|no reason}', decision_event_type: 'application.rejected' } },
    { value: 'withdrawn', label: 'Withdrawn', tone: 'neutral', rank: 40, metadata: { allowed_actions: [], review_summary_template: null, decision_event_type: null } },
  ],

  marketplace_participant_application_doc_kind: [
    { value: 'commercial_registration', label: 'Commercial registration', tone: 'info', rank: 10, is_default: true },
    { value: 'vat_certificate', label: 'VAT certificate', tone: 'info', rank: 20 },
    { value: 'operating_license', label: 'Operating license', tone: 'info', rank: 30 },
    { value: 'insurance_certificate', label: 'Insurance certificate', tone: 'info', rank: 40 },
    { value: 'bank_account_letter', label: 'Bank account letter', tone: 'neutral', rank: 50 },
  ],

  // dispute_kind (migration 202603091191)
  dispute_kind: [
    { value: 'commercial', label: 'Commercial' },
    { value: 'execution', label: 'Execution' },
    { value: 'other', label: 'Other' },
  ],

  // dispute_resolution kinds (input enum for marketplace_dispute_resolution_v1)
  // W58-Finance+Support REDO closure: each resolution row carries
  // `metadata.target_rpc` (the canonical RPC the FE should fan out to) and
  // `metadata.requires_amount` / `metadata.requires_notes` (whether the modal
  // must collect non-zero amount or audit notes). Replaces inline
  // `draft.resolution === 'partial'`/`reject'` branches in
  // modules/finance/disputes.tsx with row-driven dispatch.
  dispute_resolution: [
    { value: 'credit',  label: 'Credit',         metadata: { target_rpc: 'marketplace_dispute_resolution_v1', requires_amount: false, requires_notes: false } },
    { value: 'reject',  label: 'Reject',         metadata: { target_rpc: 'dispute_reject_v1',                 requires_amount: false, requires_notes: true  } },
    { value: 'partial', label: 'Partial credit', metadata: { target_rpc: 'marketplace_dispute_resolution_v1', requires_amount: true,  requires_notes: false } },
  ],

  // finance_event_type — mirrors public.lookup_definitions.category='finance_event_type' (migration 202601212830)
  finance_event_type: [
    { value: 'charge', label: 'Charge' },
    { value: 'refund', label: 'Refund' },
    { value: 'fee', label: 'Fee' },
    { value: 'tax', label: 'Tax' },
    { value: 'cod_collected', label: 'COD Collected' },
    { value: 'cod_handover', label: 'COD Handover' },
    { value: 'deposit', label: 'Deposit' },
    { value: 'payout', label: 'Payout' },
    { value: 'adjustment', label: 'Adjustment' },
    { value: 'bank_statement', label: 'Bank Statement' },
  ],

  // finance_direction - mirrors public.lookup_definitions.category='finance_direction'
  // (migration 202601212830_finance_events_ledger_foundation.sql). Bank
  // statement ingestion sends this value to record_bank_statement_event_v1.
  finance_direction: [
    { value: 'in', label: 'In', metadata: { is_inflow: true } },
    { value: 'out', label: 'Out', metadata: { is_inflow: false } },
  ],

  // W75-Finance Cycle F-R-15 closure (P2): canonical `finance_event_direction`
  // taxonomy. Mirrors public.finance_events.direction enum (`debit`/`credit`).
  // Each row carries the chip surface contract:
  //   • `label` — directional flow chip text rendered in the ledger Dir column
  //     (`in` for credit/inflow, `out` for debit/outflow).
  //   • `tone`  — chip kind (`good` for inflow, `info` for outflow).
  //   • `metadata.title` — chip tooltip ("Increases account balance" /
  //     "Decreases account balance").
  //   • `metadata.is_inflow` — convenience boolean for downstream callers
  //     that need direction polarity without a string compare.
  // Replaces the inline `d === 'in' ? 'good' : 'info'` ternary plus the
  // hardcoded title literals in modules/finance/ledger.tsx with row-driven
  // SSOT lookup. The `_default` row keeps unknown directions visible
  // (label `?`, tone `neutral`) without silently masking the gap.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  finance_event_direction: [
    { value: 'credit',   label: 'in', tone: 'good',    metadata: { title: 'Increases account balance', is_inflow: true } },
    { value: 'debit',    label: 'out', tone: 'info',   metadata: { title: 'Decreases account balance', is_inflow: false } },
    { value: '_default', label: '?',  tone: 'neutral', metadata: { title: 'Unknown direction',         is_inflow: null } },
  ],

  // Tasks SSOT (AGENTS.md line 37)
  // W62-Workflows (Cycle F-R-2 P1-5) — `metadata.is_terminal` flags the
  // terminal/done states (completed/rejected/cancelled). The review-queue
  // row CSS-class resolver reads this row metadata instead of comparing
  // `task.status === 'completed'` so the visual "completed" treatment is
  // a single seed update (e.g., to also style `cancelled` rows the same).
  // W64-Workflows (Cycle F-R-4 P1) — `metadata.is_snoozed` flags the snoozed
  // state. The review-queue snoozed-tab filter, snoozed counter, snooze-until
  // chips, and snooze-action pressed state read this row metadata instead of
  // comparing `task.status === 'snoozed'`. Adding a new snoozed-equivalent
  // status now flips a single seed flag rather than touching call sites.
  task_status: [
    { value: 'open',           label: 'Open',           tone: 'info',    metadata: { is_terminal: false, is_snoozed: false } },
    { value: 'assigned',       label: 'Assigned',       tone: 'info',    metadata: { is_terminal: false, is_snoozed: false } },
    { value: 'in_progress',    label: 'In progress',    tone: 'info',    metadata: { is_terminal: false, is_snoozed: false } },
    { value: 'awaiting_input', label: 'Awaiting input', tone: 'warn',    metadata: { is_terminal: false, is_snoozed: false } },
    { value: 'completed',      label: 'Completed',      tone: 'good',    metadata: { is_terminal: true,  is_snoozed: false } },
    { value: 'escalated',      label: 'Escalated',      tone: 'danger',  metadata: { is_terminal: false, is_snoozed: false } },
    { value: 'snoozed',        label: 'Snoozed',        tone: 'neutral', metadata: { is_terminal: false, is_snoozed: true  } },
    { value: 'rejected',       label: 'Rejected',       tone: 'danger',  metadata: { is_terminal: true,  is_snoozed: false } },
    { value: 'cancelled',      label: 'Cancelled',      tone: 'neutral', metadata: { is_terminal: true,  is_snoozed: false } },
  ],
  // W34c — canonical `task_action_kind` registry. Replaces the inline
  // ACTION_REGISTRY (label/icon) Record literal AND the inline
  // `nextStatusForAction` switch in `modules/workflows/_review-queue/views.ts`.
  // Each row carries `label`, `icon`, and `next_status` metadata so the
  // describeAction + nextStatusForAction resolvers become row-driven lookups.
  // Backend mirror in W53: lookup_values rows with metadata
  // {icon, next_status, ?confirmation, ?destructive}.
  // W62-Workflows (Cycle F-R-2 P1-1) — `metadata.bulk_strategy` row-drives
  // the bulk-action dispatch in `review-queue.tsx#bulkAction`. Replaces
  // the literal `if (kind === 'claim')` / `if (kind === 'resolve' ||
  // kind === 'escalate')` branches:
  //   • `assignment`         — bulk patches `assigned_to`; no status RPC
  //                            (currently only `claim`).
  //   • `status_transition`  — bulk-routes through
  //                            `bulk_transition_tasks_v1` with
  //                            `to_status = next_status`.
  //   • absent / `none`      — action is not eligible for the bulk surface;
  //                            single-task code paths still apply.
  // W74-Workflows (Cycle F-R-14 P2-1) — `metadata.is_snooze_action: true`
  // marks the canonical snooze-action row consumed by review-queue.tsx
  // aria-pressed gating. Replaces inline `a.kind === 'snooze'` literal
  // compare so the pressed state resolves through canonical SSOT
  // (AGENTS.md §2 ZERO HARDCODING + §6 row-driven by configuration).
  task_action_kind: [
    // Default fallback row (when an unrecognised action kind is encountered):
    { value: '_default',         label: '—',                        icon: 'right',   tone: 'neutral', next_status: 'in_progress' },
    // dispatch_exception_review canonical actions
    { value: 'retry',            label: 'Retry delivery',           icon: 'right',   tone: 'info',    next_status: 'in_progress' },
    { value: 'reschedule',       label: 'Reschedule',               icon: 'right',   tone: 'info',    next_status: 'in_progress' },
    { value: 'reassign',         label: 'Reassign driver',          icon: 'shuffle', tone: 'info',    next_status: 'in_progress' },
    { value: 'hold_at_branch',   label: 'Return to branch',         icon: 'package', tone: 'warn',    next_status: 'in_progress' },
    { value: 'rtb',              label: 'Return to branch',         icon: 'package', tone: 'warn',    next_status: 'in_progress' },
    { value: 'cancel',           label: 'Cancel',                   icon: 'warn',    tone: 'danger',  next_status: 'rejected' },
    { value: 'resolve',          label: 'Close as resolved',        icon: 'check',   tone: 'good',    next_status: 'completed',    metadata: { bulk_strategy: 'status_transition' } },
    { value: 'record_handover',  label: 'Record handover',          icon: 'check',   tone: 'good',    next_status: 'completed' },
    { value: 'record_cashier_count', label: 'Record cashier count', icon: 'check',   tone: 'good',    next_status: 'completed' },
    { value: 'record_deposit_slip', label: 'Record deposit slip',   icon: 'check',   tone: 'good',    next_status: 'completed' },
    // shipment_amend_review / tenant_signup_review / manual_review actions
    { value: 'approve',          label: 'Approve',                  icon: 'check',   tone: 'good',    next_status: 'completed' },
    { value: 'reject',           label: 'Reject',                   icon: 'warn',    tone: 'danger',  next_status: 'rejected' },
    { value: 'decline',          label: 'Decline',                  icon: 'warn',    tone: 'danger',  next_status: 'rejected' },
    { value: 'request_info',     label: 'Request more info',        icon: 'edit',    tone: 'info',    next_status: 'in_progress' },
    // generic operator actions (keyboard surface c/e/s)
    { value: 'claim',            label: 'Claim',                    icon: 'check',   tone: 'good',    next_status: 'in_progress', metadata: { bulk_strategy: 'assignment' } },
    { value: 'escalate',         label: 'Escalate',                 icon: 'warn',    tone: 'warn',    next_status: 'escalated',    metadata: { bulk_strategy: 'status_transition' } },
    { value: 'snooze',           label: 'Snooze',                   icon: 'lock',    tone: 'neutral', next_status: 'snoozed',      metadata: { is_snooze_action: true } },
  ],

  // W34c — `tone` + `reviewer_description` added so the review-queue chip
  // and the operator-facing description hint resolve canonically. Mirrors
  // `public.task_type_catalog.tone` + `task_type_catalog.reviewer_description`
  // (paired backend backfill in W53). Replaces the inline `task_type === '...'`
  // branches in `modules/workflows/review-queue.tsx`.
  task_type: [
    { value: 'manual_review', label: 'Manual review', tone: 'neutral',
      reviewer_description: 'Manual review required. Workflow paused awaiting reviewer decision. Resume via transition_task_v1 with chosen next_status.',
      metadata: { console_path: '/workflows/review-queue', console_focus_param: 'focus', console_focus_source: 'id' } },
    { value: 'dispatch_exception_review', label: 'Dispatch exception (NDR)', tone: 'warn',
      reviewer_description: 'Driver attempted delivery and recorded a non-final outcome. Review the resolution policy ladder result and apply the chosen action via apply_dispatch_exception_resolution_v1. The decision will write to decision_log with category=ndr_resolution.',
      metadata: { console_path: '/operate/exceptions', console_focus_param: 'task', console_focus_source: 'id' } },
    { value: 'route_stop_execute', label: 'Route stop execute', tone: 'info',
      reviewer_description: 'Driver-side route stop execution task. Reviewed in driver console, not the operator review queue.',
      metadata: { console_path: '/operate/dispatch', console_focus_param: 'route_stop', console_focus_source: 'resource_id' } },
    { value: 'warehouse_supervisor_approval', label: 'Warehouse approval', tone: 'info',
      reviewer_description: 'Warehouse supervisor variance approval. Review variance summary + linked transfer and approve or reject.',
      metadata: { console_path: '/platform/warehouse', console_focus_param: 'task', console_focus_source: 'id' } },
    { value: 'warehouse_scan_supervisor_approval', label: 'Warehouse scan approval', tone: 'info',
      reviewer_description: 'Out-of-sequence checkpoint scan correction. Review the scan trail and approve the override.',
      metadata: { console_path: '/platform/warehouse', console_focus_param: 'task', console_focus_source: 'id' } },
    { value: 'shipment_amend_review', label: 'Shipment amend review', tone: 'warn',
      reviewer_description: 'Customer-requested shipment amendment. Validate the requested operation against amend policy and approve or reject.',
      metadata: { console_path: '/operate/amend-cancel', console_focus_param: 'focus', console_focus_source: 'id' } },
    { value: 'tenant_signup_review', label: 'Tenant signup review', tone: 'info',
      reviewer_description: 'Inbound tenant signup request. Verify business name, billing details, and KYC docs before approval. Approval triggers tenant_signup_intake_apply_v1 + initial settings_versions seeding.',
      metadata: { console_path: '/platform/organizations', console_focus_param: 'task', console_focus_source: 'id' } },
    { value: 'marketing_lead_followup', label: 'Marketing lead follow-up', tone: 'info',
      reviewer_description: 'Follow up on inbound Contact Sales leads from Landing. Review captured company, contact, request context, and workflow lineage before completing or reassigning the task.',
      metadata: { console_path: '/workflows/review-queue', console_focus_param: 'focus', console_focus_source: 'id' } },
    { value: 'cod_cash_handover', label: 'COD cash handover', tone: 'warn',
      reviewer_description: 'Record the driver handover amount for the COD settlement batch. Completion opens the required operational session and wakes the parent settlement workflow.',
      metadata: { console_path: '/workflows/review-queue', console_focus_param: 'focus', console_focus_source: 'id' } },
    { value: 'cod_cashier_count', label: 'COD cashier count', tone: 'warn',
      reviewer_description: 'Record the branch cashier counted amount for the COD settlement batch. Completion opens the required operational session and wakes the parent settlement workflow.',
      metadata: { console_path: '/workflows/review-queue', console_focus_param: 'focus', console_focus_source: 'id' } },
    { value: 'cod_manager_approval', label: 'COD manager approval', tone: 'danger',
      reviewer_description: 'Review the COD variance decision and approve or reject the settlement closeout.',
      metadata: { console_path: '/workflows/review-queue', console_focus_param: 'focus', console_focus_source: 'id' } },
    { value: 'bank_deposit_slip_create', label: 'Bank deposit slip', tone: 'warn',
      reviewer_description: 'Record the branch bank deposit slip amount, currency, and reference for the settlement batch. Completion opens the required operational session and wakes the parent reconciliation workflow.',
      metadata: { console_path: '/workflows/review-queue', console_focus_param: 'focus', console_focus_source: 'id' } },
  ],

  delivery_completion_kind: [
    { value: 'full', label: 'Full delivery', tone: 'good', rank: 10, is_default: true },
    { value: 'partial', label: 'Partial delivery', tone: 'warn', rank: 20, is_default: false },
  ],

  delivery_handover_mode: [
    { value: 'named_recipient', label: 'Named recipient', tone: 'good', rank: 10, is_default: true, metadata: { requires_signature: true } },
    { value: 'recipient_class', label: 'Recipient class', tone: 'info', rank: 20, is_default: false, metadata: { requires_signature: true } },
    { value: 'safe_drop', label: 'Safe drop', tone: 'warn', rank: 30, is_default: false, metadata: { requires_signature: false } },
    { value: 'locker', label: 'Locker', tone: 'info', rank: 40, is_default: false, metadata: { requires_signature: false } },
    { value: 'mailroom', label: 'Mailroom', tone: 'neutral', rank: 50, is_default: false, metadata: { requires_signature: false } },
  ],

  payment_collection_outcome: [
    { value: 'collected', label: 'Collected', tone: 'good', rank: 10, is_default: true },
    { value: 'refused', label: 'Refused', tone: 'danger', rank: 20, is_default: false },
  ],

  payment_collection_method: [
    { value: 'cash', label: 'Cash', tone: 'good', rank: 10, is_default: true },
    { value: 'card', label: 'Card', tone: 'info', rank: 20, is_default: false },
    { value: 'bank_transfer', label: 'Bank transfer', tone: 'neutral', rank: 30, is_default: false },
    { value: 'wallet', label: 'Wallet', tone: 'info', rank: 40, is_default: false },
    { value: 'other', label: 'Other', tone: 'neutral', rank: 90, is_default: false },
  ],

  // Decision categories (decision_log)
  // W71-Operate (Cycle F-R-11) closure: `metadata.is_ndr_related` flags the
  // ndr_resolution row so the exceptions decisions tab filter resolves via
  // canonical SSOT instead of comparing against an inline `'ndr_resolution'`
  // literal. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  decision_category: [
    { value: 'geocoding', label: 'Geocoding', metadata: { is_ndr_related: false } },
    { value: 'transformation', label: 'Transformation', metadata: { is_ndr_related: false } },
    { value: 'settings_resolution', label: 'Settings resolution', metadata: { is_ndr_related: false } },
    { value: 'rate_limiting', label: 'Rate limiting', metadata: { is_ndr_related: false } },
    { value: 'campaign_enrollment', label: 'Campaign enrollment', metadata: { is_ndr_related: false } },
    { value: 'circuit_breaker', label: 'Circuit breaker', metadata: { is_ndr_related: false } },
    { value: 'comms_scheduling', label: 'Comms scheduling', metadata: { is_ndr_related: false } },
    { value: 'retry_logic', label: 'Retry logic', metadata: { is_ndr_related: false } },
    { value: 'provider_selection', label: 'Provider selection', metadata: { is_ndr_related: false } },
    { value: 'provider_budget', label: 'Provider budget', metadata: { is_ndr_related: false } },
    { value: 'webhook_routing', label: 'Webhook routing', metadata: { is_ndr_related: false } },
    { value: 'api_response_handled', label: 'API response handled', metadata: { is_ndr_related: false } },
    { value: 'workflow_trigger', label: 'Workflow trigger', metadata: { is_ndr_related: false } },
    { value: 'route_assignment', label: 'Route assignment', metadata: { is_ndr_related: false } },
    { value: 'ndr_resolution', label: 'NDR resolution', metadata: { is_ndr_related: true } },
    { value: 'cod_collection', label: 'COD collection', metadata: { is_ndr_related: false } },
    { value: 'integration_plugin.set_binding', label: 'Plugin binding changed', metadata: { is_ndr_related: false } },
  ],

  // W74 Cycle F-R-14 closure (P1-7) — canonical `decision_verdict` taxonomy.
  // Replaces the inline `v === 'allowed' || v === 'pass' || v === 'matched'`
  // ternary in components/decisionTrail.tsx#verdictKind. Each row carries a
  // canonical `tone` (chip palette) and `metadata.is_positive` flag projecting
  // the binary outcome semantic; consumers resolve via
  // `lookupRow('decision_verdict', v)?.tone` so a future verdict spelling
  // (e.g. `accepted`, `granted`) flows through one source.
  // The `_default` row carries `tone: 'neutral'` so a missing/unknown verdict
  // renders neutrally rather than masking the gap with a literal default.
  // Strict no-fallback: any verdict not in this canonical list resolves to
  // null tone and the chip surfaces the missing canonical metadata.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
  decision_verdict: [
    { value: '_default',  label: '—',         tone: 'neutral', rank: 0,   metadata: { is_positive: false } },
    { value: 'allowed',   label: 'Allowed',   tone: 'good',    rank: 10,  metadata: { is_positive: true  } },
    { value: 'pass',      label: 'Pass',      tone: 'good',    rank: 20,  metadata: { is_positive: true  } },
    { value: 'matched',   label: 'Matched',   tone: 'good',    rank: 30,  metadata: { is_positive: true  } },
    { value: 'denied',    label: 'Denied',    tone: 'danger',  rank: 40,  metadata: { is_positive: false } },
    { value: 'fail',      label: 'Fail',      tone: 'danger',  rank: 50,  metadata: { is_positive: false } },
    { value: 'unmatched', label: 'Unmatched', tone: 'warn',    rank: 60,  metadata: { is_positive: false } },
  ],

  // Scope ladder (scope_type_registry)
  // W56-B (F3) — `metadata.rank_letter` projects each scope_type onto its
  // canonical single-letter abbreviation consumed by the ScopePill component.
  // Replaces the inline `RANK_LETTER: Record<string, string>` in
  // components/ScopePill.tsx. `source` collapses to `X` (not `S`) because
  // `sender` already owns `S` in the override ladder.
  // W-Cycle-E (P2 #7) — `metadata.impact_tone` + `metadata.impact_label`
  // project each ladder tier onto its canonical "blast radius" chip palette
  // consumed by platform/feature-flags.tsx `impactEstimate`. Tones grade the
  // exposure of a scope-level toggle: global=warn (largest blast radius),
  // tenant=info (medium), client/sender=good (narrow). Replaces the prior
  // inline `enabled.some(s.scope_type === 'global') ? warn : ...` ladder.
  scope_type: [
    { value: 'global',   label: 'Global',   rank: 0, metadata: { rank_letter: 'G', impact_tone: 'warn', impact_label: 'all sessions' } },
    { value: 'tenant',   label: 'Tenant',   rank: 1, metadata: { rank_letter: 'T', impact_tone: 'info', impact_label: 'tenant sessions' } },
    { value: 'client',   label: 'Client',   rank: 2, metadata: { rank_letter: 'C', impact_tone: 'good', impact_label: 'client sessions' } },
    { value: 'sender',   label: 'Sender',   rank: 3, metadata: { rank_letter: 'S', impact_tone: 'good', impact_label: 'sender sessions' } },
    { value: 'source',   label: 'Source',   rank: 4, metadata: { rank_letter: 'X', impact_tone: 'good', impact_label: 'source sessions' } },
    { value: 'resource', label: 'Resource', rank: 5, metadata: { rank_letter: 'R', impact_tone: 'good', impact_label: 'resource sessions' } },
  ],

  // W-Cycle-E2 (P1 #4) — `time_range_options` canonical taxonomy. Replaces
  // the inline `RANGE_OPTIONS` constant (`5m/1h/24h/7d/all` literal cluster +
  // hardcoded ms multipliers) in modules/insights/_shared.ts. Each row carries
  // `metadata.window_ms` projecting the canonical millisecond window (null for
  // the `'all'` sentinel). Insights surfaces (decisions/api-gateway/audit/etc)
  // resolve range chips through this lookup; new windows added here light up
  // the FilterBar automatically. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
  time_range_options: [
    { value: '5m',  label: '5m',  rank: 10, metadata: { window_ms: 5 * 60 * 1000 } },
    { value: '1h',  label: '1h',  rank: 20, metadata: { window_ms: 60 * 60 * 1000 } },
    { value: '24h', label: '24h', rank: 30, metadata: { window_ms: 24 * 60 * 60 * 1000 } },
    { value: '7d',  label: '7d',  rank: 40, metadata: { window_ms: 7 * 24 * 60 * 60 * 1000 } },
    { value: 'all', label: 'All', rank: 99, metadata: { window_ms: null } },
  ],

  // Provider health — canonical SSOT for `public.provider_health_logs.status`
  // text values rendered by integrations/health.tsx. Tone metadata mirrors the
  // operator-facing semantics (good/warn/danger/neutral). The backend
  // canonical mirror is paired in W53 (lookup_values + metadata.tone backfill).
  provider_health: [
    { value: 'healthy',   label: 'Healthy',   tone: 'good',    rank: 10 },
    { value: 'degraded',  label: 'Degraded',  tone: 'warn',    rank: 20 },
    { value: 'unhealthy', label: 'Unhealthy', tone: 'danger',  rank: 30 },
    { value: 'down',      label: 'Down',      tone: 'danger',  rank: 31 },
    { value: 'critical',  label: 'Critical',  tone: 'danger',  rank: 32 },
    { value: 'unknown',   label: 'Unknown',   tone: 'neutral', rank: 40 },
  ],

  // Circuit breaker state — canonical SSOT for
  // `public.circuit_breaker_state.state` (and `circuit_breaker_dashboard_v.state`).
  // Mirrors the existing canonical seed in
  // supabase/migrations/202601202320_lookup_column_contracts_and_enforcement.sql:74-76
  // with metadata.tone added (paired backfill in W53). Used by
  // integrations/health.tsx breaker chip rendering — replaces the prior inline
  // tone branch (closed/half_open/open).
  circuit_state: [
    { value: 'closed',    label: 'Closed',    tone: 'good',   rank: 10 },
    { value: 'half_open', label: 'Half open', tone: 'warn',   rank: 20 },
    { value: 'open',      label: 'Open',      tone: 'danger', rank: 30 },
  ],

  // Plugin status — also carries `metadata.next_actions` (W-Cycle-E P1 #5):
  // the canonical lifecycle CTA taxonomy projected by integrations/catalog.tsx
  // drawer footer. Each `next_actions` array lists the canonical action keys
  // valid from that status (`submit`, `approve`, `reject`, `activate`,
  // `set_binding`). Replaces the inline `switch (latest.status)` ladder.
  // SSOT for both `plugin_status` (status taxonomy) and the status->action
  // transitions; backend mirror lands in lookup_values metadata.
  //
  // W70 (Cycle F-R-10 P2-1/P2-2/P2-3 closure — AGENTS.md §2 ZERO HARDCODING +
  // §6 row-driven by configuration): `metadata.is_chip_visible` (boolean)
  // controls whether the version-row badge in `integrations/catalog.tsx`
  // renders for a given `integration_plugin_versions.status`. Replaces the
  // inline `v.status === 'archived'` literal branch + `<Chip label="archived" />`
  // and the `isPendingReview` `<Chip label="pending review" />` literal at the
  // plugin card header. Set true for statuses that should surface a row badge
  // (`archived`, `pending_review`); false/omitted for statuses where the
  // dedicated PluginStatusChip handles rendering elsewhere or no chip is shown.
  plugin_status: [
    { value: 'active',    label: 'Active',      tone: 'good',    metadata: { next_actions: ['set_binding', 'deactivate'], is_chip_visible: true } },
    { value: 'pending',   label: 'Pending',     tone: 'info',    metadata: { next_actions: [], is_chip_visible: false } },
    { value: 'degraded',  label: 'Degraded',    tone: 'warn',    metadata: { next_actions: [], is_chip_visible: false } },
    { value: 'rollback',  label: 'Rolled back', tone: 'danger',  metadata: { next_actions: [], is_chip_visible: false } },
    { value: 'disabled',  label: 'Disabled',    tone: 'neutral', metadata: { next_actions: [], is_chip_visible: false } },
    // Version-lifecycle states (mirrors integration_plugin_versions.status)
    // — used by the catalog drawer footer to drive the CTA shown for the
    // *latest version* of the plugin. Distinct from the plugin lifecycle
    // chip (`active|pending|...`) which renders on the plugin row itself.
    { value: 'draft',     label: 'Draft',     tone: 'neutral', metadata: { next_actions: ['submit'], is_chip_visible: false } },
    { value: 'rejected',  label: 'Rejected',  tone: 'danger',  metadata: { next_actions: ['submit'], is_chip_visible: false } },
    { value: 'submitted', label: 'Submitted', tone: 'info',    metadata: { next_actions: ['approve', 'reject'], is_chip_visible: false } },
    { value: 'approved',  label: 'Approved',  tone: 'good',    metadata: { next_actions: ['activate'], is_chip_visible: false } },
    // W70 — version-row badge statuses (chip visible on the version history
    // row inside the plugin drawer + plugin card header).
    { value: 'archived',       label: 'Archived',       tone: 'neutral', metadata: { next_actions: [], is_chip_visible: true } },
    { value: 'pending_review', label: 'Pending review', tone: 'warn',    metadata: { next_actions: ['approve', 'reject'], is_chip_visible: true } },
  ],

  // Workflow run status
  // W61 (Workflows P1-1 + P1-2 closure) — metadata.{allows_retry,allows_abort,
  // is_failed,glyph} drive Retry/Abort gating + final-status glyph rendering
  // in `modules/workflows/runs.tsx` (initialFailed + Retry + Abort buttons)
  // and `modules/workflows/templates.tsx` (test-panel finalStatus toast tone +
  // glyph). Replaces inline `s.status === 'failed'`,
  // `selectedStep.status === 'failed'`, `run.status === 'running'`,
  // `progress.workflow_status === 'failed' ? 'danger' : 'good'`, and
  // `result.finalStatus === 'failed' ? '✗' : '✓'` literal compares.
  // Strict no-fallback: missing metadata → consumer treats action as
  // disallowed / glyph as `?` so the gap surfaces.
  // W68 (Workflows Cycle F-R-8 P1-4) — `metadata.is_placeholder: true` flags
  // the canonical "not yet materialized" placeholder step status (`pending`).
  // Replaces literal `?? 'pending'` fallback in
  // `modules/workflows/templates.tsx#stepStatusMap` (Canvas projection
  // when workflow_run_steps rows are loading or not yet materialized).
  // Missing canonical placeholder row → empty string surfaces a fail-loud
  // `(missing)` chip via lookupRow returning null (W26 contract).
  workflow_run_status: [
    { value: 'pending',     label: 'Pending',     tone: 'neutral', metadata: { allows_retry: false, allows_abort: true,  blocks_cod_restart: true,  is_failed: false, is_placeholder: true, glyph: '·' } },
    { value: 'running',     label: 'Running',     tone: 'info',    metadata: { allows_retry: false, allows_abort: true,  blocks_cod_restart: true,  is_failed: false, glyph: '⟳' } },
    { value: 'in_progress', label: 'In Progress', tone: 'info',    metadata: { allows_retry: false, allows_abort: true,  blocks_cod_restart: true,  is_failed: false, glyph: '⟳' } },
    { value: 'succeeded',   label: 'Succeeded',   tone: 'good',    metadata: { allows_retry: false, allows_abort: false, blocks_cod_restart: false, is_failed: false, glyph: '✓' } },
    { value: 'failed',      label: 'Failed',      tone: 'danger',  metadata: { allows_retry: true,  allows_abort: false, blocks_cod_restart: false, is_failed: true,  glyph: '✗' } },
    { value: 'timeout',     label: 'Timeout',     tone: 'danger',  metadata: { allows_retry: true,  allows_abort: false, blocks_cod_restart: false, is_failed: true,  glyph: '⏱' } },
    { value: 'timed_out',   label: 'Timed out',   tone: 'warn',    metadata: { allows_retry: true,  allows_abort: false, blocks_cod_restart: false, is_failed: true,  glyph: '⏱' } },
    { value: 'skipped',     label: 'Skipped',     tone: 'neutral', metadata: { allows_retry: false, allows_abort: false, blocks_cod_restart: false, is_failed: false, glyph: '↷' } },
    { value: 'cancelled',   label: 'Cancelled',   tone: 'neutral', metadata: { allows_retry: false, allows_abort: false, blocks_cod_restart: false, is_failed: false, glyph: '⊘' } },
    { value: 'canceled',    label: 'Canceled',    tone: 'neutral', metadata: { allows_retry: false, allows_abort: false, blocks_cod_restart: false, is_failed: false, glyph: '⊘' } },
    { value: 'stopped',     label: 'Stopped',     tone: 'neutral', metadata: { allows_retry: false, allows_abort: false, blocks_cod_restart: false, is_failed: false, glyph: '⊘' } },
  ],

  // W54-A — workflow_templates.status canonical row set. Values mirror the
  // FE typing (`'draft' | 'active' | 'inactive' | 'retired'`) used by
  // `lib/api.ts` + `lib/data-source.ts`. Backend canonical mirror lives in
  // `lookup_definitions.category='workflow_status'`. Replaces the inline
  // `template.status === 'active' ? 'good' : 'neutral'` branch in
  // `modules/workflows/templates.tsx`.
  //
  // Cycle E2 (Workflows P1 #5) — `metadata.toggle_to` + `metadata.toggle_label`
  // make the Activate/Deactivate top-bar button row-driven. Replaces the
  // inline `activeTemplate.status === 'active' ? 'Deactivate' : 'Activate'`
  // ternary + `next = 'active' ? 'inactive' : 'active'` literal branch in
  // `modules/workflows/templates.tsx`. Missing canonical row → button stays
  // disabled (no FE-fabricated default).
  // W61 (Workflows P2-3) — `metadata.toggle_kind` + `metadata.toggle_icon`
  // make the Activate/Deactivate top-bar Button presentation row-driven.
  // Replaces inline `toggleTo === 'active' ? 'check' : 'lock'` icon literal
  // in `modules/workflows/templates.tsx`. The current row's metadata
  // describes how *its* toggle button should appear (Activate-styled when
  // toggling toward `active`, Disable-styled when toggling away).
  workflow_status: [
    { value: 'draft',    label: 'Draft',    tone: 'neutral', rank: 10, metadata: { toggle_to: 'active',   toggle_label: 'Activate',   toggle_kind: 'primary', toggle_icon: 'check' } },
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 20, metadata: { toggle_to: 'inactive', toggle_label: 'Deactivate', toggle_kind: 'danger',  toggle_icon: 'lock'  } },
    { value: 'inactive', label: 'Inactive', tone: 'neutral', rank: 30, metadata: { toggle_to: 'active',   toggle_label: 'Activate',   toggle_kind: 'primary', toggle_icon: 'check' } },
    { value: 'retired',  label: 'Retired',  tone: 'warn',    rank: 40, metadata: { toggle_to: 'active',   toggle_label: 'Activate',   toggle_kind: 'primary', toggle_icon: 'check' } },
  ],

  // W54-A — workflow_run_steps.step_status canonical row set. Values mirror
  // the seed in `seed-raw/workflows.js` workflow_run_steps + canonical
  // `workflow_run_steps.step_status` column (RENAME deferred). Used by
  // canvas stepStatusMap projection (replaces position-heuristic synthesis)
  // and any per-step chip rendering.
  workflow_step_status: [
    { value: 'pending',     label: 'Pending',     tone: 'neutral', rank: 10, metadata: { allows_retry: false } },
    { value: 'in_progress', label: 'In progress', tone: 'info',    rank: 15, metadata: { allows_retry: false } },
    { value: 'running',     label: 'Running',     tone: 'info',    rank: 20, metadata: { allows_retry: false } },
    { value: 'completed',   label: 'Completed',   tone: 'good',    rank: 25, metadata: { allows_retry: false } },
    { value: 'succeeded',   label: 'Succeeded',   tone: 'good',    rank: 30, metadata: { allows_retry: false } },
    { value: 'failed',      label: 'Failed',      tone: 'danger',  rank: 40, metadata: { allows_retry: true } },
    { value: 'skipped',     label: 'Skipped',     tone: 'neutral', rank: 50, metadata: { allows_retry: false } },
    { value: 'cancelled',   label: 'Cancelled',   tone: 'neutral', rank: 60, metadata: { allows_retry: false } },
    { value: 'timed_out',   label: 'Timed out',   tone: 'warn',    rank: 70, metadata: { allows_retry: true } },
  ],

  // W54-A — workflow_binding_registry.configurability_status canonical row
  // set (FE-shaped). Used by `modules/workflows/bindings.tsx` Status chip in
  // the binding inspector. Replaces the inline
  // `row.status === 'active' ? 'good' : 'neutral'` branch.
  //
  // Cycle E2 (Workflows P1 #4) — `metadata.toggle_to` + `metadata.toggle_label`
  // make the Re-enable/Disable footer button row-driven. Replaces the inline
  // `row.status === 'disabled' ? 'Re-enable' : 'Disable'` ternary +
  // `next = row.status === 'disabled' ? 'active' : 'disabled'` literal branch
  // in `modules/workflows/bindings.tsx`. Missing canonical row → button stays
  // disabled (no FE-fabricated default).
  // W61 (Workflows P2-3) — `metadata.toggle_kind` + `metadata.toggle_icon`
  // make the Re-enable/Disable footer Button presentation row-driven.
  // Replaces inline `toggleTo === 'active' ? 'primary' : 'danger'` literal
  // in `modules/workflows/bindings.tsx`. Re-enable-styled when toggling
  // toward `active`, Disable-styled when toggling away.
  //
  // W67 (Workflows Cycle F-R-7 P1+P2) — `metadata.is_enabled` flags
  // whether a status row corresponds to an "enabled" binding for the
  // canonical RPC `enabled` payload field (replaces inline
  // `(status) !== 'disabled'` in bindings.tsx#persistBindingChange).
  // `metadata.action_label` + `metadata.action_icon` + `metadata.action_kind`
  // make per-status row action buttons (Activate/Pause/Disable) row-driven
  // (replaces literal `<Activate>/<Pause>/<Disable>` button labels in
  // bindings.tsx#ROW_ACTIONS). `is_default: true` on the canonical
  // baseline row (`active`) replaces the literal `merged.status || 'active'`
  // fallback in bindings.tsx#decoratedBindings (mirrors the
  // plugin_studio_plugin_kind / service_offering_status `is_default` pattern).
  workflow_binding_status: [
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 10, is_default: true, metadata: { toggle_to: 'disabled', toggle_label: 'Disable',   toggle_kind: 'danger',  toggle_icon: 'lock', is_enabled: true,  is_default: true, action_label: 'Activate', action_icon: 'check', action_kind: 'primary' } },
    { value: 'paused',   label: 'Paused',   tone: 'warn',    rank: 20,                   metadata: { toggle_to: 'disabled', toggle_label: 'Disable',   toggle_kind: 'danger',  toggle_icon: 'lock', is_enabled: true,                    action_label: 'Pause',    action_icon: 'lock',  action_kind: 'ghost'   } },
    { value: 'disabled', label: 'Disabled', tone: 'neutral', rank: 30,                   metadata: { toggle_to: 'active',   toggle_label: 'Re-enable', toggle_kind: 'primary', toggle_icon: 'check', is_enabled: false,                   action_label: 'Disable',  action_icon: 'lock',  action_kind: 'danger'  } },
  ],
  // Workflow template step kind taxonomy (consumed by workflows/templates.tsx
  // step chips). Mirrors the canonical engine kinds: trigger | transform |
  // guard | action | error | manual.
  //
  // Cycle E2 (Workflows P2 #14) — `metadata.is_trigger` flag enables row-
  // driven validation (`steps.filter((s) => is_trigger).length > 1`)
  // instead of literal `s.kind === 'trigger'` filter in
  // `modules/workflows/templates.tsx#validationIssues`.
  // W62-Workflows (Cycle F-R-2 P1-4) — `metadata.requires_error_path`
  // flags step kinds that must declare an `error_path` (currently only
  // `guard`). Replaces the literal `s.kind === 'guard'` validation
  // branch in templates.tsx#validationIssues so adding another kind
  // that requires an error_path is a single seed update.
  // W68 (Workflows Cycle F-R-8 P1-1) — `is_default: true` + `metadata.is_default: true`
  // flag the canonical neutral fallback step kind (`action`). Replaces the
  // literal `?? 'action'` fallback in `modules/workflows/runs.tsx` step
  // synthesis. Mirrors the workflow_binding_status / plugin_studio_plugin_kind
  // is_default pattern (AGENTS.md §2 ZERO HARDCODING + §6 row-driven config).
  workflow_step_kind: [
    { value: 'trigger',   label: 'Trigger',   tone: 'info',    rank: 10, metadata: { is_trigger: true,  requires_error_path: false } },
    { value: 'transform', label: 'Transform', tone: 'neutral', rank: 20, metadata: { is_trigger: false, requires_error_path: false } },
    { value: 'guard',     label: 'Guard',     tone: 'warn',    rank: 30, metadata: { is_trigger: false, requires_error_path: true  } },
    { value: 'action',    label: 'Action',    tone: 'good',    rank: 40, is_default: true, metadata: { is_trigger: false, requires_error_path: false, is_default: true } },
    { value: 'error',     label: 'Error',     tone: 'danger',  rank: 50, metadata: { is_trigger: false, requires_error_path: false } },
    { value: 'manual',    label: 'Manual',    tone: 'warn',    rank: 60, metadata: { is_trigger: false, requires_error_path: false } },
  ],

  // Cycle E2 (Workflows P1 #1 + #2) — `workflow_branch_kind` canonical
  // taxonomy. Mirrors the canonical workflow_template_steps.branch values
  // (`main` / `error` / `manual`) and projects each onto:
  //   • `metadata.lane_index`           — canvas vertical lane (0 = main, 1 = secondary)
  //   • `metadata.label`                — edge mid-label rendered on the canvas
  //   • `metadata.is_keyboard_secondary`— true when the keyboard nav lane
  //                                       collapses error+manual into one secondary lane
  // Replaces:
  //   • templates.tsx:430 `branchLanes: Record<string, number> = { main: 0, error: 1, manual: 1 }`
  //   • templates.tsx:431-435 `stepsByBranch` initial keys
  //   • templates.tsx:565 `kind === 'error' ? 'on error' : 'manual'` literal labels
  //   • templates.tsx:1537/1958 `s.branch === 'error' || 'manual'` keyboard-lane filter
  // Missing canonical row → consumer fails loud (canvas null-renders or
  // raises a danger StateView, no FE-fabricated default lane mapping).
  // W62-Workflows (Cycle F-R-2 P1-3) — `metadata.is_error_branch` flags
  // the canonical "error" branch row so consumers (e.g.,
  // templates.tsx#promptErrorPath) can resolve "is this an error
  // branch?" through a row metadata flag instead of comparing
  // `s.branch === 'error'`. Adding a new error-equivalent branch
  // becomes a single seed update.
  // W77 (Workflows Cycle F-R-17 P1) — `is_default: true` + `metadata.is_default: true`
  // flag the canonical default branch (`main`). Replaces the literal
  // `|| 'main'` fallback in `modules/workflows/templates.tsx` (canvas
  // lane projection, edge resolution, branch label render). Mirrors the
  // W75 workflow_step_kind / W76 task_priority is_default pattern
  // (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6 row-driven config).
  workflow_branch_kind: [
    { value: 'main',   label: 'Main',     tone: 'neutral', rank: 10, is_default: true, metadata: { lane_index: 0, label: 'main',     is_keyboard_secondary: false, is_error_branch: false, is_default: true } },
    { value: 'error',  label: 'On error', tone: 'danger',  rank: 20, metadata: { lane_index: 1, label: 'on error', is_keyboard_secondary: true,  is_error_branch: true  } },
    { value: 'manual', label: 'Manual',   tone: 'warn',    rank: 30, metadata: { lane_index: 1, label: 'manual',   is_keyboard_secondary: true,  is_error_branch: false } },
  ],

  // Cycle E2 (Workflows P1 #3) — `workflow_schedule_type` canonical taxonomy.
  // Mirrors the canonical `workflow_schedule_triggers.schedule.type` values
  // (`interval` / `daily` / `weekly` / `cron`) consumed by the Schedules
  // sub-tab summary builder in `modules/workflows/runs.tsx#scheduleSummary`.
  // `metadata.summary_template` is a deterministic format token referenced
  // by the FE to render the summary cell:
  //   • interval — `Every {interval_seconds_h}h` / `Every {interval_seconds_m}m` /
  //                `Every {interval_seconds_s}s` (chosen by `bucket_seconds(...)`)
  //   • daily    — `Daily {at_time} {timezone}`
  //   • weekly   — `{days} {at_time} {timezone}`
  //   • cron     — `{cron}` (raw expression)
  // The bucketing constants (3600 sec/h, 60 sec/m) live as `metadata.thresholds`
  // so the FE can resolve them through the canonical row instead of inlining.
  workflow_schedule_type: [
    { value: 'interval', label: 'Interval', tone: 'info',    rank: 10, metadata: { summary_template: 'every', thresholds: { hour_seconds: 3600, minute_seconds: 60 } } },
    { value: 'daily',    label: 'Daily',    tone: 'info',    rank: 20, metadata: { summary_template: 'daily' } },
    { value: 'weekly',   label: 'Weekly',   tone: 'info',    rank: 30, metadata: { summary_template: 'weekly' } },
    { value: 'cron',     label: 'Cron',     tone: 'neutral', rank: 40, metadata: { summary_template: 'cron' } },
  ],

  // Cycle E2 (Workflows P1 #10) — `workflow_step_action` canonical row set.
  // Drives the `openStepActions` palette in
  // `modules/workflows/templates.tsx`. Replaces the hardcoded inline array
  // of menu items + the literal `switch (it.key)` handler dispatch.
  // `metadata.section` groups items in the palette UI; `metadata.handler_kind`
  // tags each row with the canonical action kind so the dispatch is row-
  // driven. Missing canonical row → palette opens empty with a danger
  // StateView (no synthetic items).
  workflow_step_action: [
    { value: 'duplicate',      label: 'Duplicate step',                 tone: 'neutral', rank: 10, metadata: { section: 'Edit',      handler_kind: 'duplicate' } },
    { value: 'delete',         label: 'Delete step',                    tone: 'danger',  rank: 20, metadata: { section: 'Edit',      handler_kind: 'delete' } },
    { value: 'convert_error',  label: 'Convert to error branch',        tone: 'warn',    rank: 30, metadata: { section: 'Branch',    handler_kind: 'convert_error' } },
    { value: 'pin_sample',     label: 'Pin sample data',                tone: 'good',    rank: 40, metadata: { section: 'Data',      handler_kind: 'pin_sample' } },
    { value: 'view_runs',      label: 'View runs that hit this step',   tone: 'info',    rank: 50, metadata: { section: 'Telemetry', handler_kind: 'view_runs' } },
    { value: 'decision_trail', label: 'Decision trail',                 tone: 'info',    rank: 60, metadata: { section: 'Audit',     handler_kind: 'decision_trail' } },
  ],

  // Cycle E2 (Workflows P2 #11) — `condition_operator_by_type` canonical
  // matrix. Replaces the hardcoded `Operator[]` arrays per `FieldType`
  // returned by `_bindings/condition-model.ts#operatorsFor`. Each row
  // pairs `(field_type, operator)` so `operatorsFor(t)` becomes a
  // canonical-driven filter (`getLookups(...).filter(r => r.metadata.field_type === t)`).
  // Used by the bindings condition editor.
  condition_operator_by_type: [
    // string
    { value: 'string:equals',      label: 'String · equals',      tone: 'neutral', rank: 10,  metadata: { field_type: 'string',  operator: 'equals'      } },
    { value: 'string:not_equals',  label: 'String · not equals',  tone: 'neutral', rank: 20,  metadata: { field_type: 'string',  operator: 'not_equals'  } },
    { value: 'string:in',          label: 'String · in',          tone: 'neutral', rank: 30,  metadata: { field_type: 'string',  operator: 'in'          } },
    { value: 'string:not_in',      label: 'String · not in',      tone: 'neutral', rank: 40,  metadata: { field_type: 'string',  operator: 'not_in'      } },
    { value: 'string:matches',     label: 'String · matches',     tone: 'neutral', rank: 50,  metadata: { field_type: 'string',  operator: 'matches'     } },
    { value: 'string:exists',      label: 'String · exists',      tone: 'neutral', rank: 60,  metadata: { field_type: 'string',  operator: 'exists'      } },
    { value: 'string:not_exists',  label: 'String · not exists',  tone: 'neutral', rank: 70,  metadata: { field_type: 'string',  operator: 'not_exists'  } },
    // number
    { value: 'number:equals',      label: 'Number · equals',      tone: 'neutral', rank: 80,  metadata: { field_type: 'number',  operator: 'equals'      } },
    { value: 'number:not_equals',  label: 'Number · not equals',  tone: 'neutral', rank: 90,  metadata: { field_type: 'number',  operator: 'not_equals'  } },
    { value: 'number:gt',          label: 'Number · gt',          tone: 'neutral', rank: 100, metadata: { field_type: 'number',  operator: 'gt'          } },
    { value: 'number:gte',         label: 'Number · gte',         tone: 'neutral', rank: 110, metadata: { field_type: 'number',  operator: 'gte'         } },
    { value: 'number:lt',          label: 'Number · lt',          tone: 'neutral', rank: 120, metadata: { field_type: 'number',  operator: 'lt'          } },
    { value: 'number:lte',         label: 'Number · lte',         tone: 'neutral', rank: 130, metadata: { field_type: 'number',  operator: 'lte'         } },
    { value: 'number:exists',      label: 'Number · exists',      tone: 'neutral', rank: 140, metadata: { field_type: 'number',  operator: 'exists'      } },
    { value: 'number:not_exists',  label: 'Number · not exists',  tone: 'neutral', rank: 150, metadata: { field_type: 'number',  operator: 'not_exists'  } },
    // boolean
    { value: 'boolean:equals',     label: 'Boolean · equals',     tone: 'neutral', rank: 160, metadata: { field_type: 'boolean', operator: 'equals'      } },
    { value: 'boolean:not_equals', label: 'Boolean · not equals', tone: 'neutral', rank: 170, metadata: { field_type: 'boolean', operator: 'not_equals'  } },
    { value: 'boolean:exists',     label: 'Boolean · exists',     tone: 'neutral', rank: 180, metadata: { field_type: 'boolean', operator: 'exists'      } },
    { value: 'boolean:not_exists', label: 'Boolean · not exists', tone: 'neutral', rank: 190, metadata: { field_type: 'boolean', operator: 'not_exists'  } },
    // unknown — superset (everything)
    { value: 'unknown:equals',     label: 'Any · equals',         tone: 'neutral', rank: 200, metadata: { field_type: 'unknown', operator: 'equals'      } },
    { value: 'unknown:not_equals', label: 'Any · not equals',     tone: 'neutral', rank: 210, metadata: { field_type: 'unknown', operator: 'not_equals'  } },
    { value: 'unknown:in',         label: 'Any · in',             tone: 'neutral', rank: 220, metadata: { field_type: 'unknown', operator: 'in'          } },
    { value: 'unknown:not_in',     label: 'Any · not in',         tone: 'neutral', rank: 230, metadata: { field_type: 'unknown', operator: 'not_in'      } },
    { value: 'unknown:matches',    label: 'Any · matches',        tone: 'neutral', rank: 240, metadata: { field_type: 'unknown', operator: 'matches'     } },
    { value: 'unknown:gt',         label: 'Any · gt',             tone: 'neutral', rank: 250, metadata: { field_type: 'unknown', operator: 'gt'          } },
    { value: 'unknown:gte',        label: 'Any · gte',            tone: 'neutral', rank: 260, metadata: { field_type: 'unknown', operator: 'gte'         } },
    { value: 'unknown:lt',         label: 'Any · lt',             tone: 'neutral', rank: 270, metadata: { field_type: 'unknown', operator: 'lt'          } },
    { value: 'unknown:lte',        label: 'Any · lte',            tone: 'neutral', rank: 280, metadata: { field_type: 'unknown', operator: 'lte'         } },
    { value: 'unknown:exists',     label: 'Any · exists',         tone: 'neutral', rank: 290, metadata: { field_type: 'unknown', operator: 'exists'      } },
    { value: 'unknown:not_exists', label: 'Any · not exists',     tone: 'neutral', rank: 300, metadata: { field_type: 'unknown', operator: 'not_exists'  } },
  ],

  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_binding_dispatches.outcome.
  // Mirrors the canonical CHECK constraint
  // (supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql:261-263).
  workflow_binding_dispatch_outcome: [
    { value: 'started', label: 'Started', tone: 'info' },
    { value: 'completed', label: 'Completed', tone: 'good' },
    { value: 'waiting', label: 'Waiting', tone: 'warn' },
    { value: 'failed', label: 'Failed', tone: 'danger' },
  ],

  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — workflow_run_triggers + workflow_schedule_triggers
  // share a tenant/client/sender scope_type lookup.
  workflow_trigger_scope_type: [
    { value: 'tenant', label: 'Tenant', tone: 'info' },
    { value: 'client', label: 'Client', tone: 'good' },
    { value: 'sender', label: 'Sender', tone: 'neutral' },
  ],

  // Warehouse transfer status
  // W54-D — ranks added so kanban column order derives directly from the
  // canonical lookup (rank-sorted) rather than an inline literal array in
  // platform/warehouse.tsx#KANBAN_COLUMNS.
  warehouse_transfer_status: [
    { value: 'planned',    label: 'Planned',    tone: 'info',    rank: 10 },
    { value: 'in_transit', label: 'In transit', tone: 'info',    rank: 20 },
    { value: 'received',   label: 'Received',   tone: 'good',    rank: 30 },
    { value: 'reconciled', label: 'Reconciled', tone: 'good',    rank: 40 },
    { value: 'on_hold',    label: 'On hold',    tone: 'warn',    rank: 50 },
    { value: 'cancelled',  label: 'Cancelled',  tone: 'neutral', rank: 60 },
  ],

  // Currency
  currency: [
    { value: 'SAR', label: 'SAR' },
    { value: 'AED', label: 'AED' },
    { value: 'USD', label: 'USD' },
  ],

  // Customer / catalog domain — mirrors supabase/migrations/202601202320_lookup_column_contracts_and_enforcement.sql
  // (lines 78-80, 82-84, 161-162, 170-172) plus baseline values for phone validation states observed in
  // supabase/migrations/202510110006_domain_tables_partitioned.sql (recipients.phone_validation_status COMMENT).
  //
  // W66-Catalog+Customers closure: each row carries a canonical `metadata.lifecycle`
  // token (`active`/`suspended`/`terminal`) so the FE
  // (`apps/console-v2/src/modules/customers/clients.tsx`) consumes lifecycle gating
  // row-driven via `lookupRow('client_status', value)?.metadata?.lifecycle` instead
  // of the order-dependent "first row whose value differs from active" heuristic.
  // Mirrors the `service_offering_status` / `service_level_status` pattern in
  // catalog-offerings.js. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  client_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, is_default: true, metadata: { lifecycle: 'active' } },
    { value: 'suspended', label: 'Suspended', tone: 'warn', rank: 20, metadata: { lifecycle: 'suspended' } },
    { value: 'terminated', label: 'Terminated', tone: 'danger', rank: 30, metadata: { lifecycle: 'terminal' } },
  ],
  sender_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, is_default: true, metadata: { lifecycle: 'active' } },
    { value: 'inactive', label: 'Inactive', tone: 'neutral', rank: 20, metadata: { lifecycle: 'inactive' } },
    { value: 'suspended', label: 'Suspended', tone: 'warn', rank: 30, metadata: { lifecycle: 'suspended' } },
  ],
  sla_tier: [
    { value: 'economy', label: 'Economy', tone: 'neutral', rank: 10 },
    { value: 'standard', label: 'Standard', tone: 'info', rank: 20, is_default: true },
    { value: 'premium', label: 'Premium', tone: 'good', rank: 30 },
  ],
  communication_channel: [
    { value: 'sms', label: 'SMS', tone: 'info', rank: 10 },
    { value: 'whatsapp', label: 'WhatsApp', tone: 'good', rank: 20, is_default: true },
    { value: 'email', label: 'Email', tone: 'neutral', rank: 30 },
  ],
  // Phone validation states are documented in
  // supabase/migrations/202510110006_domain_tables_partitioned.sql (line 44 COMMENT) — values: valid, invalid, unverified, pending.
  phone_validation_status: [
    { value: 'valid', label: 'Valid', tone: 'good', rank: 10 },
    { value: 'pending', label: 'Pending', tone: 'info', rank: 20 },
    { value: 'unverified', label: 'Unverified', tone: 'warn', rank: 30 },
    { value: 'invalid', label: 'Invalid', tone: 'danger', rank: 40 },
  ],
  language_code: [
    { value: 'en', label: 'English', tone: 'neutral', rank: 10, is_default: true },
    { value: 'ar', label: 'Arabic', tone: 'neutral', rank: 20 },
  ],
  preferred_language: [
    { value: 'en', label: 'English', tone: 'neutral', rank: 10, is_default: true },
    { value: 'ar', label: 'العربية', tone: 'neutral', rank: 20 },
  ],

  // CLAIM-FLEET-DRIVERS — driver lifecycle + documents + compliance lookups.
  // Mirrors canonical lookup categories registered in
  // supabase/migrations/202601311230_enterprise_ops_v1.sql:
  //   • driver_status         (line 185)
  //   • driver_document_type  (driver_documents.doc_type, line 391)
  //   • driver_document_status(driver_documents.status, line 392)
  // driver_compliance_severity is a UI-side derived category for severity tone
  // mapping (the canonical event ledger leaves severity computation to the
  // resolver; the lookup here keeps the chip palette consistent).
  // Canonical 3-value enum per supabase/migrations/202601311230_enterprise_ops_v1.sql:205-214
  // (FLEET Wave 5 RE-AUDIT D4 alignment): active | inactive | suspended.
  // The legacy FE-only 4-value enum (on_shift|on_break|off_duty|suspended)
  // conflated driver lifecycle (active/inactive/suspended) with live duty
  // state (on_shift/on_break/off_duty). Duty state has moved to the
  // `hours_of_service_state` column on the driver_profiles seed (which
  // mirrors the canonical projection from public.driver_hours_of_service).
  // W71-Operate (Cycle F-R-11) closure: each row carries
  //   • `metadata.is_active` (true on `active`)
  //   • `metadata.is_inactive` (true on `inactive`)
  //   • `metadata.is_suspended` (true on `suspended`)
  // so the KPI counters and reinstate-action gating in
  // operate/fleet/drivers.tsx resolve via canonical SSOT instead of
  // comparing against inline `'active'`/`'inactive'`/`'suspended'` literals.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  driver_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, is_default: true, metadata: { is_active: true,  is_inactive: false, is_suspended: false } },
    { value: 'inactive', label: 'Inactive', tone: 'neutral', rank: 20, metadata: { is_active: false, is_inactive: true,  is_suspended: false } },
    { value: 'suspended', label: 'Suspended', tone: 'danger', rank: 30, metadata: { is_active: false, is_inactive: false, is_suspended: true  } },
  ],
  // W71-Operate (Cycle F-R-11) closure — canonical
  // `driver_hours_of_service_state` taxonomy. Mirrors
  // public.driver_hours_of_service.segment_type projected onto the
  // driver_profiles seed (`hours_of_service_state` column). Each row
  // carries `metadata.counts_for_on_road` (true for active duty states
  // that count toward the on-shift KPI) and `metadata.is_on_break`
  // (true for break/off-duty states) plus `metadata.lifecycle` token.
  // Replaces inline `hours_of_service_state === 'driving'|'on_duty'|'on_break'`
  // literal compares in operate/fleet/drivers.tsx KPI derivation.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
  driver_hours_of_service_state: [
    { value: 'driving',  label: 'Driving',  tone: 'info',    rank: 10, is_default: true, metadata: { counts_for_on_road: true,  is_on_break: false, lifecycle: 'on_road' } },
    { value: 'on_duty',  label: 'On duty',  tone: 'info',    rank: 20, metadata: { counts_for_on_road: true,  is_on_break: false, lifecycle: 'on_road' } },
    { value: 'on_break', label: 'On break', tone: 'warn',    rank: 30, metadata: { counts_for_on_road: false, is_on_break: true,  lifecycle: 'paused' } },
    { value: 'off_duty', label: 'Off duty', tone: 'neutral', rank: 40, metadata: { counts_for_on_road: false, is_on_break: false, lifecycle: 'off_duty' } },
    { value: '_default', label: 'Unknown', tone: 'neutral', rank: 99, metadata: { counts_for_on_road: false, is_on_break: false, lifecycle: 'unknown' } },
  ],
  driver_document_kind: [
    { value: 'license', label: 'License', tone: 'info', rank: 10 },
    { value: 'insurance', label: 'Insurance', tone: 'info', rank: 20 },
    { value: 'medical', label: 'Medical', tone: 'info', rank: 30 },
    { value: 'permit', label: 'Permit', tone: 'info', rank: 40 },
  ],
  driver_document_status: [
    { value: 'submitted', label: 'Submitted', tone: 'info', rank: 10 },
    { value: 'verified', label: 'Verified', tone: 'good', rank: 20 },
    { value: 'rejected', label: 'Rejected', tone: 'danger', rank: 30 },
    { value: 'expired', label: 'Expired', tone: 'warn', rank: 40 },
  ],
  driver_compliance_severity: [
    { value: 'info', label: 'Info', tone: 'info', rank: 10, is_default: true },
    { value: 'warn', label: 'Warn', tone: 'warn', rank: 20 },
    { value: 'critical', label: 'Critical', tone: 'danger', rank: 30 },
  ],

  // ─── W54-C canonical-tone seed expansion (no-fallback campaign) ────
  // Closes hardcoded option-list / tone-branch clusters in
  // apps/console-v2/src/modules/operate/{fleet,...} surfaces. Modules now
  // read tone and option labels via `getLookups(category)` /
  // `lookupRow(category, value)` instead of inline TS literal arrays.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).

  // driver_compliance_event_type — canonical event_type taxonomy consumed by
  // operate/fleet/drivers.tsx CreateComplianceEventBody event-type input
  // default + describeEvent() summary template resolution. Consumers read
  // `metadata.label_template` for event summary; missing rows fall back to
  // raw event_type for forward-compat.
  driver_compliance_event_type: [
    { value: 'manual_note',           label: 'Manual note',           tone: 'neutral', rank: 10, is_default: true,
      metadata: { label_template: 'Manual note' } },
    { value: 'license.expiry_warning', label: 'License expiry warning', tone: 'warn',    rank: 20,
      metadata: { label_template: 'License expires in {days_until} days' } },
    { value: 'document.submitted',    label: 'Document submitted',    tone: 'info',    rank: 30,
      metadata: { label_template: 'Submitted {kind} for review' } },
    { value: 'document.rejected',     label: 'Document rejected',     tone: 'danger',  rank: 40,
      metadata: { label_template: 'Document rejected · {reason}' } },
    { value: 'document.verified',     label: 'Document verified',     tone: 'good',    rank: 50,
      metadata: { label_template: 'Document verified by reviewer' } },
    { value: 'driver.suspended',      label: 'Driver suspended',      tone: 'danger',  rank: 60,
      metadata: { label_template: 'Driver suspended · reason {reason}' } },
    { value: 'inspection.passed',     label: 'Inspection passed',     tone: 'good',    rank: 70,
      metadata: { label_template: 'Vehicle inspection passed' } },
    { value: 'training.completed',    label: 'Training completed',    tone: 'good',    rank: 80,
      metadata: { label_template: 'Training completed · {training_id}' } },
    { value: 'incident.minor',        label: 'Minor incident',        tone: 'warn',    rank: 90,
      metadata: { label_template: 'Minor incident · {impact}' } },
    { value: 'incident.major',        label: 'Major incident',        tone: 'danger',  rank: 100,
      metadata: { label_template: 'Major incident · {impact}' } },
    { value: 'compliance.score_change', label: 'Compliance score change', tone: 'info', rank: 110,
      metadata: { label_template: 'Compliance score {from} → {to}' } },
  ],

  // driver_suspend_reason — canonical reason taxonomy consumed by
  // operate/fleet/drivers.tsx BulkSuspendBody reason picker. Replaces
  // inline `<option value="compliance_review|...">` literal arrays.
  driver_suspend_reason: [
    { value: 'compliance_review', label: 'Compliance review',     tone: 'warn',    rank: 10, is_default: true },
    { value: 'expired_license',   label: 'Expired license',       tone: 'danger',  rank: 20 },
    { value: 'incident_pending',  label: 'Incident pending review', tone: 'warn',  rank: 30 },
    { value: 'hr_request',        label: 'HR request',            tone: 'neutral', rank: 40 },
    { value: 'other',             label: 'Other',                 tone: 'neutral', rank: 50 },
  ],

  // driver_document_rejection_reason — canonical rejection taxonomy
  // consumed by operate/fleet/drivers.tsx RejectDocumentBody. Replaces
  // inline `<option value="illegible_scan|...">` literal arrays.
  driver_document_rejection_reason: [
    { value: 'illegible_scan',  label: 'Illegible scan',     tone: 'warn',    rank: 10, is_default: true },
    { value: 'expired',         label: 'Already expired',    tone: 'warn',    rank: 20 },
    { value: 'wrong_kind',      label: 'Wrong document kind', tone: 'warn',   rank: 30 },
    { value: 'other',           label: 'Other',              tone: 'neutral', rank: 40 },
  ],

  // vehicle_maintenance_reason — canonical kind taxonomy consumed by
  // operate/fleet/vehicles.tsx ScheduleMaintenanceForm kind picker.
  // Replaces inline MAINT_KIND_OPTIONS array literal.
  vehicle_maintenance_reason: [
    { value: 'preventive',     label: 'Preventive',     tone: 'good',    rank: 10, is_default: true },
    { value: 'oil_change',     label: 'Oil change',     tone: 'info',    rank: 20 },
    { value: 'tire_rotation',  label: 'Tire rotation',  tone: 'info',    rank: 30 },
    { value: 'brake_service',  label: 'Brake service',  tone: 'warn',    rank: 40 },
    { value: 'inspection',     label: 'Inspection',     tone: 'info',    rank: 50 },
    { value: 'major_repair',   label: 'Major repair',   tone: 'danger',  rank: 60 },
  ],

  // maintenance_cancel_reason — canonical reason taxonomy consumed by
  // operate/fleet/vehicles.tsx Maintenance Cancel action. Replaces
  // hardcoded `'operator_cancelled'` literal in cancelMutation.mutateAsync.
  maintenance_cancel_reason: [
    { value: 'operator_cancelled', label: 'Operator cancelled', tone: 'neutral', rank: 10, is_default: true },
    { value: 'window_changed',     label: 'Window changed',     tone: 'info',    rank: 20 },
    { value: 'policy_breach',      label: 'Policy breach',      tone: 'warn',    rank: 30 },
  ],

  // marketplace_participant_review_reason — canonical reason taxonomy for
  // operate/fleet/driver-applications.tsx Approve/Reject actions.
  // `metadata.decision` distinguishes approve-only vs reject-only rows; the
  // neutral `other` row is surfaced for both flows.
  marketplace_participant_review_reason: [
    { value: 'background_check_clear', label: 'Background check clear', tone: 'good',    rank: 10,  is_default: true, metadata: { decision: 'approve' } },
    { value: 'capacity_available',      label: 'Capacity available',      tone: 'good',    rank: 20,  metadata: { decision: 'approve' } },
    { value: 'qualification_gap',       label: 'Qualification gap',       tone: 'danger',  rank: 110, is_default: true, metadata: { decision: 'reject' } },
    { value: 'compliance_gap',          label: 'Compliance gap',          tone: 'danger',  rank: 120, metadata: { decision: 'reject' } },
    { value: 'duplicate_identity',      label: 'Duplicate identity',      tone: 'danger',  rank: 130, metadata: { decision: 'reject', edge_case: 'duplicate_identity' } },
    { value: 'compliance_document_mismatch', label: 'Compliance document mismatch', tone: 'danger', rank: 140, metadata: { decision: 'reject', edge_case: 'compliance_denied' } },
    { value: 'other',                   label: 'Other',                   tone: 'neutral', rank: 200 },
  ],

  // driver_application_doc_kind — canonical document kind taxonomy consumed
  // by operate/fleet/driver-applications.tsx RequestDocsModalBody picker.
  // Replaces inline `docKinds` literal array. Mirrors the canonical
  // driver_document_kind taxonomy plus marketplace-onboarding extensions
  // (national_id, vehicle_inspection, hazmat_endorsement) used during the
  // initial intake flow.
  driver_application_doc_kind: [
    { value: 'license',             label: 'Driver license',     tone: 'info',    rank: 10 },
    { value: 'national_id',         label: 'National ID',        tone: 'info',    rank: 20 },
    { value: 'medical',             label: 'Medical certificate', tone: 'info',   rank: 30, is_default: true },
    { value: 'vehicle_inspection',  label: 'Vehicle inspection', tone: 'info',    rank: 40 },
    { value: 'insurance',           label: 'Insurance',          tone: 'info',    rank: 50 },
    { value: 'hazmat_endorsement',  label: 'Hazmat endorsement', tone: 'warn',    rank: 60 },
  ],

  // ndr_branch_next_action — canonical next-action taxonomy projected by
  // resolve_ndr_branch_next_action_v1. Consumed by operate/exceptions.tsx
  // RecommendedChip + operate/returned-to-branch.tsx RecommendedReturnChip
  // for tone resolution. Replaces inline `data === 'cancel' ? 'danger' :
  // data === 'customer_pickup' ? 'warn' : 'good'` ternaries.
  ndr_branch_next_action: [
    { value: 'reschedule',         label: 'Reschedule',         tone: 'good',    rank: 10 },
    { value: 'retry',              label: 'Retry',              tone: 'good',    rank: 20 },
    { value: 'hold',               label: 'Hold',               tone: 'warn',    rank: 30 },
    { value: 'customer_pickup',    label: 'Customer pickup',    tone: 'warn',    rank: 40 },
    { value: 'return_to_branch',   label: 'Return to branch',   tone: 'warn',    rank: 45 },
    { value: 'cancel',             label: 'Cancel',             tone: 'danger',  rank: 50 },
  ],

  // pickup_request_status — canonical pickup request lifecycle status.
  // Mirrors api.pickup_requests_list_v1 status projection. Consumed by
  // operate/pickups.tsx requests tab DataTable (column lookup attribute).
  pickup_request_status: [
    { value: 'pending',          label: 'Pending',          tone: 'info',    rank: 10, is_default: true, metadata: { lifecycle: 'requested' } },
    { value: 'pickup_requested', label: 'Pickup requested', tone: 'info',    rank: 11, metadata: { lifecycle: 'requested' } },
    { value: 'scheduled',        label: 'Scheduled',        tone: 'info',    rank: 20, metadata: { lifecycle: 'scheduled' } },
    { value: 'pickup_scheduled', label: 'Pickup scheduled', tone: 'info',    rank: 21, metadata: { lifecycle: 'scheduled' } },
    { value: 'assigned',         label: 'Assigned',         tone: 'good',    rank: 30, metadata: { lifecycle: 'assigned' } },
    { value: 'completed',        label: 'Completed',        tone: 'good',    rank: 40, metadata: { lifecycle: 'completed', is_terminal: true } },
    { value: 'failed',           label: 'Failed',           tone: 'danger',  rank: 50, metadata: { lifecycle: 'failed', is_terminal: true } },
    { value: 'pickup_failed',    label: 'Pickup failed',    tone: 'danger',  rank: 51, metadata: { lifecycle: 'failed', is_terminal: true } },
    { value: 'cancelled',        label: 'Cancelled',        tone: 'neutral', rank: 60, metadata: { lifecycle: 'cancelled', is_terminal: true } },
  ],

  // pickup_wave_status — canonical pickup wave lifecycle status. Mirrors
  // api.pickup_waves_list_v1 status projection. Consumed by
  // operate/pickups.tsx waves tab DataTable (column lookup attribute).
  // W71-Operate (Cycle F-R-11) closure: `metadata.is_assignable` flags the
  // `planned` row so the AddToWavePicker resolves which waves accept new
  // requests through canonical SSOT instead of inline `'planned'` literal.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  pickup_wave_status: [
    { value: 'planned',     label: 'Planned',     tone: 'neutral', rank: 10, is_default: true, metadata: { is_assignable: true  } },
    { value: 'assigned',    label: 'Assigned',    tone: 'info',    rank: 20, metadata: { is_assignable: false } },
    { value: 'in_progress', label: 'In progress', tone: 'info',    rank: 30, metadata: { is_assignable: false } },
    { value: 'completed',   label: 'Completed',   tone: 'good',    rank: 40, metadata: { is_assignable: false } },
    { value: 'cancelled',   label: 'Cancelled',   tone: 'neutral', rank: 50, metadata: { is_assignable: false } },
  ],

  // pickup_failure_reason — canonical pickup failure reason taxonomy.
  // Mirrors api.pickup_failures_list_v1 failure_reason projection.
  // Consumed by operate/pickups.tsx failures tab DataTable filter chips.
  pickup_failure_reason: [
    { value: 'sender_not_ready',     label: 'Sender not ready',     tone: 'warn',    rank: 10, is_default: true, metadata: { retryable: true } },
    { value: 'sender_unavailable',   label: 'Sender unavailable',   tone: 'warn',    rank: 11, metadata: { retryable: true } },
    { value: 'pickup_not_ready',     label: 'Pickup not ready',     tone: 'warn',    rank: 12, metadata: { retryable: true } },
    { value: 'business_closed',      label: 'Business closed',      tone: 'warn',    rank: 13, metadata: { retryable: true } },
    { value: 'no_answer',            label: 'No answer',            tone: 'warn',    rank: 14, metadata: { retryable: true } },
    { value: 'phone_unreachable',    label: 'Phone unreachable',    tone: 'warn',    rank: 15, metadata: { retryable: true } },
    { value: 'address_invalid',      label: 'Address invalid',      tone: 'danger',  rank: 20, metadata: { retryable: false } },
    { value: 'address_not_found',    label: 'Address not found',    tone: 'danger',  rank: 21, metadata: { retryable: false } },
    { value: 'driver_unavailable',   label: 'Driver unavailable',   tone: 'warn',    rank: 30, metadata: { retryable: true } },
    { value: 'vehicle_unavailable',  label: 'Vehicle unavailable',  tone: 'warn',    rank: 40, metadata: { retryable: true } },
    { value: 'access_restricted',    label: 'Access restricted',    tone: 'danger',  rank: 50, metadata: { retryable: false } },
    { value: 'quantity_mismatch',    label: 'Quantity mismatch',    tone: 'danger',  rank: 60, metadata: { retryable: false } },
    { value: 'other',                label: 'Other',                tone: 'neutral', rank: 90, metadata: { retryable: true } },
  ],

  // CLAIM-PLATFORM-USERS (Phase D4) — operator users admin lookup palette.
  // Mirrors backend SSOT for the canonical 5-role set seeded in
  // supabase/migrations/202601022113_access_control_policy_core.sql lines
  // 49-53 (lookup_definitions[user_type]) plus the lifecycle status enum
  // (active / invited / suspended) consumed by the registry-driven users
  // table. Tone palette aligns with the backend role rank (super_admin →
  // platform/info; ops_admin/account_manager → tenant/good/info;
  // client_admin/sender_user → portal/neutral) so the chip color reads
  // consistently against the canonical 4-tier scope ladder.
  user_type: [
    { value: 'super_admin', label: 'Super Admin', tone: 'info', rank: 1 },
    { value: 'ops_admin', label: 'Ops Admin', tone: 'good', rank: 2, is_default: true },
    { value: 'account_manager', label: 'Account Manager', tone: 'good', rank: 3 },
    { value: 'client_admin', label: 'Client Admin', tone: 'neutral', rank: 4 },
    { value: 'sender_user', label: 'Sender User', tone: 'neutral', rank: 5 },
  ],
  access_scope_type: [
    { value: 'platform', label: 'Platform', tone: 'info', rank: 10, is_default: true, metadata: { requires_scope_id: false } },
    { value: 'tenant', label: 'Tenant', tone: 'good', rank: 20, metadata: { requires_scope_id: false } },
    { value: 'client', label: 'Client', tone: 'neutral', rank: 30, metadata: { requires_scope_id: true } },
    { value: 'sender', label: 'Sender', tone: 'neutral', rank: 40, metadata: { requires_scope_id: true } },
  ],
  // W71-Platform (Cycle F-R-11) closure: each row carries
  //   • `metadata.is_active` (true on `active`)
  //   • `metadata.is_invited` (true on `invited`)
  //   • `metadata.is_suspended` (true on `suspended`)
  // so the KPI counters and drawer "isSuspended" derivation in
  // platform/users.tsx resolve via canonical SSOT instead of comparing
  // against inline `'active'`/`'invited'`/`'suspended'` literals.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  user_status: [
    { value: 'active', label: 'Active', tone: 'good', rank: 10, metadata: { is_active: true,  is_invited: false, is_suspended: false } },
    { value: 'invited', label: 'Invited', tone: 'info', rank: 20, metadata: { is_active: false, is_invited: true,  is_suspended: false } },
    { value: 'suspended', label: 'Suspended', tone: 'danger', rank: 30, metadata: { is_active: false, is_invited: false, is_suspended: true  } },
  ],

  // W43 canonical seed mirrors — supabase/migrations/202605020100_w43_console_v2_canonical_seeds.sql
  // approval_policy taxonomy (governance tiers used by lookup_definitions.approval_policy).
  approval_policy: [
    { value: 'tier_1', label: 'Tier 1', tone: 'danger', rank: 10 },
    { value: 'tier_2', label: 'Tier 2', tone: 'warn', rank: 20 },
    { value: 'tier_3', label: 'Tier 3', tone: 'neutral', rank: 30 },
  ],
  // owner_role taxonomy (which team owns a given lookup category).
  owner_role: [
    { value: 'operations', label: 'Operations', tone: 'good', rank: 10 },
    { value: 'engineering', label: 'Engineering', tone: 'info', rank: 20 },
    { value: 'finance', label: 'Finance', tone: 'warn', rank: 30 },
    { value: 'product', label: 'Product', tone: 'neutral', rank: 40 },
  ],

  // ─── W24b canonical-tone seed expansion (no-fallback campaign) ──────
  // Every category below replaces an inline `*_TONE: Record<...>` map in
  // a console-v2 module. Modules now read tone via `lookups[category]`
  // (the SSOT) instead of hardcoded TS literals. Backend mirror lands
  // via a paired migration (202605020300_w45_*).
  // W56-B (F1) — `branch_type` canonical row set is owned by
  // `network-branches.js` (Object.assign extension) so the SSOT is not
  // split. Previously declared here AND there with DIVERGENT VALUE SETS;
  // the per-feature seed wins per the W34c precedent. This comment
  // intentionally marks the slot to make the dependency obvious.

  // W34c — `branch_status` canonical row set is owned by `network-branches.js`
  // (Object.assign extension) so the SSOT is not split. The category lives
  // there alongside other branch-domain canonical rows; this comment intentionally
  // marks the slot to make the dependency obvious to future contributors.

  branch_role: [
    { value: 'canonical_hub', label: 'Canonical hub', tone: 'good',    rank: 10 },
    { value: 'regional',      label: 'Regional',      tone: 'info',    rank: 20 },
    { value: 'local',         label: 'Local',         tone: 'neutral', rank: 30 },
    { value: 'satellite',     label: 'Satellite',     tone: 'neutral', rank: 40 },
  ],
  // W56-B (F1) — `marketplace_offer_status`, `marketplace_award_status`,
  // `marketplace_contract_status`, `marketplace_request_status` canonical
  // row sets are owned by `network-marketplace.js` (Object.assign extension)
  // so the SSOT is not split. Per-feature seed wins per W34c precedent.
  partner_compliance_status: [
    { value: 'compliant',     label: 'Compliant',     tone: 'good',    rank: 10 },
    { value: 'expiring_soon', label: 'Expiring soon', tone: 'warn',    rank: 20 },
    { value: 'expired',       label: 'Expired',       tone: 'danger',  rank: 30 },
    { value: 'pending_kyc',   label: 'Pending KYC',   tone: 'info',    rank: 40 },
    { value: 'rejected',      label: 'Rejected',      tone: 'danger',  rank: 50 },
    { value: 'suspended',     label: 'Suspended',     tone: 'danger',  rank: 60 },
  ],
  // W27 Cycle E closure (P0 #1) — `partner_listing_status` SSOT-drift
  // reconciliation. Canonical values aligned to migration
  // 202603071100_marketplace_network_foundation_v1.sql:579 CHECK constraint
  // (`listing_status IN ('private','curated_network','public')`). The legacy
  // `[listed|unlisted|blacklisted]` row set was unreachable: the underlying
  // table only ever stores `private/curated_network/public`. The seed rows in
  // network-marketplace.js + marketplace.js (legacy `'pending'`/`'active'`
  // literals) are reconciled in the same closure to canonical values.
  // `metadata.is_active_listing` flags the publicly-visible terminal so
  // consumers (partners.tsx KPI strip) resolve "Active listings" through the
  // canonical lookup metadata rather than a hardcoded enum literal.
  partner_listing_status: [
    { value: 'private',         label: 'Private',         tone: 'neutral', rank: 10, metadata: { is_active_listing: false } },
    { value: 'curated_network', label: 'Curated network', tone: 'info',    rank: 20, metadata: { is_active_listing: true } },
    { value: 'public',          label: 'Public',          tone: 'good',    rank: 30, metadata: { is_active_listing: true } },
  ],
  // W34c — `zone_status` canonical row set is owned by `network-zones.js`
  // (Object.assign extension) so the SSOT is not split. See network-zones.js
  // for the canonical values + tones (active/draft/suspended/retired).
  // W56-B (F1) — `zone_override_status` and `zone_color_token` canonical
  // row sets are owned by `network-zones.js` (Object.assign extension) so
  // the SSOT is not split. Previously declared here AND there with
  // DIVERGENT values; per-feature seed wins per W34c precedent.
  zone_change_kind: [
    { value: 'created',          label: 'Created',          tone: 'good',    rank: 10 },
    { value: 'district_added',   label: 'District added',   tone: 'info',    rank: 20 },
    { value: 'district_removed', label: 'District removed', tone: 'warn',    rank: 30 },
    { value: 'archived',         label: 'Archived',         tone: 'neutral', rank: 40 },
    { value: 'override_applied', label: 'Override applied', tone: 'info',    rank: 50 },
  ],
  // W65 closure (Cycle F-R-5 P1): `metadata.is_valid_validation_status`
  // marks the canonical "validated" row so KPI counters resolve via
  // canonical metadata instead of comparing the literal `'valid'`.
  address_validation_status: [
    { value: 'valid',           label: 'Valid',           tone: 'good',    rank: 10, metadata: { is_valid_validation_status: true } },
    { value: 'invalid',         label: 'Invalid',         tone: 'danger',  rank: 20, metadata: { is_valid_validation_status: false } },
    { value: 'requires_review', label: 'Requires review', tone: 'warn',    rank: 30, metadata: { is_valid_validation_status: false } },
    { value: 'pending',         label: 'Pending',         tone: 'info',    rank: 40, metadata: { is_valid_validation_status: false } },
  ],
  geocoding_attempt_status: [
    { value: 'success',  label: 'Success',  tone: 'good',    rank: 10 },
    { value: 'succeeded', label: 'Succeeded', tone: 'good', rank: 11, metadata: { canonical_execution_status: true, terminal: true } },
    { value: 'failure',  label: 'Failure',  tone: 'danger',  rank: 20 },
    { value: 'failed', label: 'Failed', tone: 'danger', rank: 21, metadata: { canonical_execution_status: true, terminal: true } },
    { value: 'permanently_failed', label: 'Permanently failed', tone: 'danger', rank: 22, metadata: { canonical_execution_status: true, terminal: true } },
    { value: 'skipped', label: 'Skipped', tone: 'neutral', rank: 23, metadata: { canonical_execution_status: true, terminal: true } },
    { value: 'deferred', label: 'Deferred', tone: 'warn', rank: 24, metadata: { canonical_execution_status: true, terminal: false } },
    { value: 'pending',  label: 'Pending',  tone: 'info',    rank: 30 },
    { value: 'queued', label: 'Queued', tone: 'info', rank: 31, metadata: { canonical_execution_status: true, terminal: false } },
    { value: 'in_progress', label: 'In progress', tone: 'info', rank: 32, metadata: { canonical_execution_status: true, terminal: false } },
    { value: 'manual_review', label: 'Manual review', tone: 'warn', rank: 35, metadata: { canonical_execution_status: true, terminal: false } },
    { value: 'rate_limited', label: 'Rate limited', tone: 'warn', rank: 40 },
  ],
  webhook_rule_domain: [
    { value: 'shipment',    label: 'Shipment',     tone: 'info',    rank: 10 },
    { value: 'route',       label: 'Route',        tone: 'info',    rank: 20 },
    { value: 'cod',         label: 'COD',          tone: 'good',    rank: 30 },
    { value: 'webhook',     label: 'Webhook',      tone: 'neutral', rank: 40 },
    { value: 'integration', label: 'Integration',  tone: 'neutral', rank: 50 },
  ],
  billing_invoice_event_type: [
    { value: 'created',   label: 'Created',   tone: 'info',    rank: 10 },
    { value: 'billing_invoice.created', label: 'Created', tone: 'info', rank: 11 },
    { value: 'drafted',   label: 'Drafted',                  tone: 'neutral', rank: 12 },
    { value: 'sent',      label: 'Sent',      tone: 'good',    rank: 20 },
    { value: 'sent_to_customer', label: 'Sent to customer',  tone: 'good',    rank: 22 },
    { value: 'billing_invoice.issued', label: 'Issued', tone: 'good', rank: 24 },
    { value: 'billing_invoice.updated', label: 'Updated', tone: 'info', rank: 26 },
    { value: 'billing_invoice.paid', label: 'Paid', tone: 'good', rank: 28, metadata: { lifecycle: 'paid', is_terminal: true } },
    { value: 'paid',      label: 'Paid',      tone: 'good',    rank: 30 },
    { value: 'overdue',   label: 'Overdue',   tone: 'warn',    rank: 40 },
    { value: 'refunded',  label: 'Refunded',  tone: 'neutral', rank: 50 },
    { value: 'billing_invoice.refunded', label: 'Refunded', tone: 'neutral', rank: 52 },
    { value: 'cancelled', label: 'Cancelled', tone: 'neutral', rank: 60 },
    { value: 'disputed',  label: 'Disputed',  tone: 'danger',  rank: 70 },
    { value: 'voided',    label: 'Voided',                    tone: 'neutral', rank: 80 },
    { value: 'billing_invoice.voided', label: 'Voided', tone: 'neutral', rank: 82 },
  ],

  // W34c — additional canonical categories surfaced by Cycle C audits.
  // Each replaces an inline ternary tone branch / hardcoded option array
  // somewhere in modules/finance/, modules/integrations/, modules/workflows/,
  // modules/customers/, or modules/network/. Every category carries
  // `value`, `label`, `tone`, `rank` (and optional `lifecycle`).

  // W56-B (F1) — `invoice_status`, `subscription_status`, `agreement_status`,
  // `usage_event_kind` canonical row sets are owned by `finance-billing.js`
  // (Object.assign extension) so the SSOT is not split. Previously declared
  // here AND there with DIVERGENT values/lifecycle; the per-feature seed wins
  // per the W34c precedent (extension is domain-owned and was updated more
  // recently). Loud no-fallback: any consumer reading `lookups.invoice_status`
  // without finance-billing.js loaded will see no row.

  // service_level_status — owned by `catalog-offerings.js` (Object.assign
  // extension). W61-Catalog+Customers closure: SSOT consolidated there with
  // canonical `metadata.lifecycle` tokens (active/terminal). Loud no-fallback:
  // catalog-offerings.js MUST be loaded for the Manage-levels chip + boolean→key
  // mapping to render — declaring the same key here would split the SSOT.

  // webhook_inbox.processing_status — integrations/intake.tsx tone branches.
  // Cycle F-R Integrations P2-3 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
  // `metadata.is_terminal_failure: true` marks the canonical terminal-failure
  // row consumed by integrations/intake.tsx Force-status action. The action
  // resolves the target status through the metadata flag instead of the
  // literal lookup key 'failed'. `dead_letter` is also a terminal failure
  // taxonomy member (DLQ); when intake needs the operator-driven force
  // action, the canonical terminal-failure row is `failed` (rank 40).
  processing_status: [
    { value: 'pending',     label: 'Pending',     tone: 'warn',    rank: 10 },
    { value: 'processing',  label: 'Processing',  tone: 'info',    rank: 20 },
    { value: 'processed',   label: 'Processed',   tone: 'good',    rank: 30 },
    { value: 'succeeded',   label: 'Succeeded',   tone: 'good',    rank: 31 },
    { value: 'failed',      label: 'Failed',      tone: 'danger',  rank: 40, metadata: { is_terminal_failure: true } },
    { value: 'dead_letter', label: 'Dead letter', tone: 'danger',  rank: 50 },
  ],

  // integrations/intake — turnstile verification tone.
  turnstile_status: [
    { value: 'verified', label: 'Verified', tone: 'good',    rank: 10 },
    { value: 'pending',  label: 'Pending',  tone: 'warn',    rank: 20 },
    { value: 'failed',   label: 'Failed',   tone: 'danger',  rank: 30 },
    { value: 'unknown',  label: 'Unknown',  tone: 'neutral', rank: 40 },
  ],

  // integrations/intake — dedupe outcome tone.
  dedupe_status: [
    { value: 'new',       label: 'New',       tone: 'good',    rank: 10 },
    { value: 'duplicate', label: 'Duplicate', tone: 'warn',    rank: 20 },
    { value: 'unknown',   label: 'Unknown',   tone: 'neutral', rank: 30 },
  ],

  // integrations/intake — rate limit decision tone.
  rate_limit_status: [
    { value: 'ok',      label: 'OK',      tone: 'good',    rank: 10 },
    { value: 'limited', label: 'Limited', tone: 'warn',    rank: 20 },
    { value: 'unknown', label: 'Unknown', tone: 'neutral', rank: 30 },
  ],

  // integrations/catalog — plugin kind option list.
  integration_plugin_kind: [
    { value: 'carrier',     label: 'Carrier',     tone: 'info',    rank: 10 },
    { value: 'marketplace', label: 'Marketplace', tone: 'info',    rank: 20 },
    { value: 'crm',         label: 'CRM',         tone: 'neutral', rank: 30 },
    { value: 'erp',         label: 'ERP',         tone: 'neutral', rank: 40 },
    { value: 'comms',       label: 'Comms',       tone: 'info',    rank: 50 },
    { value: 'payment',     label: 'Payment',     tone: 'info',    rank: 60 },
  ],

  // integrations/catalog — source/auth option lists.
  integration_plugin_source_type: integrationPluginSourceTypeRows,
  integration_plugin_auth_mode: integrationPluginAuthModeRows,
  integration_auth_mode: integrationPluginAuthModeRows,

  // integrations/webhook-tester — forced status option list.
  // Cycle E P1 #7 closure (AGENTS.md §2 ZERO HARDCODING): each row carries
  // `metadata.target_status` to project the HTTP code onto the canonical
  // `processing_status` taxonomy that webhook_inbox_force_status_v1 expects
  // (`succeeded` for 2xx, `failed` for 4xx/5xx). Replaces the inline
  // `next === '200' ? 'succeeded' : ...` ternary in webhook-tester.tsx.
  // `auto` carries no target_status (sentinel — no force action).
  webhook_forced_status: [
    { value: 'auto', label: 'Auto', tone: 'neutral', rank: 10, metadata: {} },
    { value: '200',  label: '200',  tone: 'good',    rank: 20, metadata: { target_status: 'succeeded' } },
    { value: '400',  label: '400',  tone: 'warn',    rank: 30, metadata: { target_status: 'failed' } },
    { value: '422',  label: '422',  tone: 'warn',    rank: 40, metadata: { target_status: 'failed' } },
    { value: '500',  label: '500',  tone: 'danger',  rank: 50, metadata: { target_status: 'failed' } },
    { value: '503',  label: '503',  tone: 'danger',  rank: 60, metadata: { target_status: 'failed' } },
  ],

  // integrations/webhook-tester — trace step failure-class taxonomy.
  // Cycle E P1 #8 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
  // each row maps a canonical failure class to its HTTP status code via
  // `metadata.http_status`. Trace steps populate `failure_class` on
  // failed steps; consumer reads via `lookupRow('trace_step_failure_class',
  // step.failure_class).metadata.http_status`. Until the trace emitter ships
  // `failure_class`, the substring fallback in webhook-tester.tsx /
  // _helpers.ts is the documented P3-deferred path with TODO marker.
  trace_step_failure_class: [
    { value: 'parse_error',      label: 'Parse error',      tone: 'warn',   rank: 10, metadata: { http_status: 400 } },
    { value: 'verify_error',     label: 'Verify error',     tone: 'warn',   rank: 20, metadata: { http_status: 400 } },
    { value: 'mapping_error',    label: 'Mapping error',    tone: 'warn',   rank: 30, metadata: { http_status: 422 } },
    { value: 'validate_error',   label: 'Validate error',   tone: 'warn',   rank: 40, metadata: { http_status: 422 } },
    { value: 'downstream_error', label: 'Downstream error', tone: 'danger', rank: 50, metadata: { http_status: 500 } },
  ],

  // integrations/plugin-studio — source-type taxonomy.
  // Cycle E P1 #12 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
  // each row carries `metadata.sample` so the studio source-payload
  // textarea seed projects from the canonical row, not from an inline
  // SAMPLE_BY_SOURCE Record. Default selection uses the first row.
  // Cycle F-R Integrations P1-1 closure: each row also carries
  // `metadata.payload_mode` so plugin-studio.tsx#buildSourcePayload reads
  // the canonical wrap/parse mode through the lookup row instead of a
  // literal `sourceType === 'curl'` branch. `wrap_curl` wraps the raw
  // text in `{ curl: <text> }`; `parse_json` JSON.parses the buffer.
  plugin_studio_source_type: [
    { value: 'curl', label: 'cURL command', tone: 'info', rank: 10, is_default: true,
      metadata: { payload_mode: 'wrap_curl', sample: 'curl -X POST https://api.example.com/v1/orders \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"id":"ORD-1","status":"created","customer_phone":"+12025550123"}\'' } },
    { value: 'openapi', label: 'OpenAPI document', tone: 'info', rank: 20,
      metadata: { payload_mode: 'parse_json', sample: '{\n  "openapi": "3.0.0",\n  "info": { "title": "Example API", "version": "1.0.0" },\n  "paths": {\n    "/orders": {\n      "post": {\n        "summary": "Create order",\n        "requestBody": { "content": { "application/json": { "schema": { "type": "object" } } } }\n      }\n    }\n  }\n}' } },
    { value: 'webhook_sample', label: 'Webhook sample payload', tone: 'info', rank: 30,
      metadata: { payload_mode: 'parse_json', sample: '{\n  "event": "shipment.created",\n  "shipment": {\n    "tracking_number": "TRK-99281",\n    "external_id": "EXT-12345",\n    "status": "created",\n    "customer_phone": "+12025550123"\n  }\n}' } },
    { value: 'manual', label: 'Manual config', tone: 'neutral', rank: 40,
      metadata: { payload_mode: 'parse_json', sample: '{\n  "webhook": {\n    "sample_payload": { "event": "demo", "data": {} }\n  }\n}' } },
  ],

  // integrations/plugin-studio — plugin-kind taxonomy.
  // Cycle E2 P2 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the
  // studio's semantic plugin-kind selection (api outbound vs webhook
  // inbound) resolves through the canonical lookup category. Default
  // selection comes from the `is_default: true` row (no inline 'api'
  // literal). The edge-fn contract still requires one of these values.
  // Distinct from the `integration_plugin_kind` carrier/marketplace/crm
  // taxonomy — that is a different domain enum.
  plugin_studio_plugin_kind: [
    { value: 'api',     label: 'API',     tone: 'info', rank: 10, is_default: true,
      metadata: { hint: 'outbound HTTP' } },
    { value: 'webhook', label: 'Webhook', tone: 'info', rank: 20,
      metadata: { hint: 'inbound' } },
  ],

  // integrations/intake — webhook source operational state.
  // Cycle E P2 #15 closure: canonical taxonomy projecting webhook source
  // health (enabled/disabled/throttled/down) onto operator-facing tone.
  // Replaces the hardcoded `sourceTone: ChainTone = 'good'` in
  // intake.tsx ProvenanceDrawer.
  webhook_source_state: [
    { value: 'enabled',   label: 'Enabled',   tone: 'good',    rank: 10, is_default: true },
    { value: 'disabled',  label: 'Disabled',  tone: 'neutral', rank: 20 },
    { value: 'throttled', label: 'Throttled', tone: 'warn',    rank: 30 },
    { value: 'down',      label: 'Down',      tone: 'danger',  rank: 40 },
  ],

  // integrations/webhook-tester — canonical sample payload row set.
  // Cycle E P2 #17 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
  // each row carries `metadata.payload` with a JSON-stringified envelope
  // demonstrating the canonical webhook shape per provider. Replaces the
  // top-of-module SAMPLE constant. The default row drives the tester's
  // initial textarea seed.
  webhook_sample_payload: [
    { value: 'shipment_created_default', label: 'Shipment created (default)', tone: 'info', rank: 10, is_default: true,
      metadata: { payload: '{\n  "event": {\n    "id": "{{event_id}}",\n    "type": "shipment.created",\n    "timestamp": "{{timestamp_iso}}"\n  },\n  "shipment": {\n    "external_id": "{{shipment_external_id}}",\n    "reference_number": "{{shipment_reference_number}}",\n    "service_type": "standard",\n    "service_level": "next_day",\n    "cod_amount": 125.5,\n    "currency": "SAR"\n  },\n  "recipient": {\n    "external_id": "{{recipient_external_id}}",\n    "name": "Noura Launch Customer",\n    "phone": "{{recipient_phone}}",\n    "email": "{{recipient_email}}"\n  },\n  "address": {\n    "line1": "King Fahd Road",\n    "line2": "Building 12",\n    "district": "Al Olaya",\n    "city": "Riyadh",\n    "province": "Riyadh",\n    "country_code": "SA",\n    "lat": 24.7136,\n    "lng": 46.6753\n  }\n}' } },
  ],

  // W69 Cycle F-R-9 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6
  // row-driven by configuration): canonical enabled/disabled lifecycle
  // taxonomy with operator-facing tone metadata. Replaces the inline
  // `value ? 'enabled' : 'disabled'` label + `value ? 'good' : 'neutral'`
  // tone literals in `integrations/sources.tsx#EnabledChip` and
  // `integrations/rules.tsx#EnabledChip`. Distinct from
  // `workflow_binding_enabled_state` / `workflow_schedule_enabled_state`
  // (those project domain-specific off-state semantics; this category is
  // the integrations toggle-state SSOT for webhook sources + routing
  // rules). Backend mirror is paired in `lookup_definitions` below.
  enabled_state: [
    { value: 'enabled',  label: 'Enabled',  tone: 'good',    rank: 10, is_default: true, metadata: { tone: 'good' } },
    { value: 'disabled', label: 'Disabled', tone: 'neutral', rank: 20, metadata: { tone: 'neutral' } },
  ],

  // W69 Cycle F-R-9 closure: canonical webhook source health-state taxonomy
  // projecting `(is_healthy, error_count_24h)` derived from
  // `v_webhook_source_directory` (W27) onto operator-facing tone. Replaces
  // the inline `isHealthy ? 'healthy' : errorCount24h > 0 ? 'degraded' :
  // 'idle'` ladder in `integrations/sources.tsx` (drawer KvRow + DataTable
  // Healthy column render). The boolean→state derivation stays in code
  // (it is projection logic, not presentation), but LABEL + TONE route
  // through this canonical lookup. Backend mirror paired below.
  webhook_source_health: [
    { value: 'healthy',  label: 'Healthy',  tone: 'good',    rank: 10, is_default: true, metadata: { tone: 'good' } },
    { value: 'degraded', label: 'Degraded', tone: 'danger',  rank: 20, metadata: { tone: 'danger' } },
    { value: 'idle',     label: 'Idle',     tone: 'neutral', rank: 30, metadata: { tone: 'neutral' } },
  ],

  // W69 Cycle F-R-9 closure: canonical mapping-config usage taxonomy.
  // Replaces inline `proj.is_in_use ? 'in use' : 'unused'` label +
  // `proj.is_in_use ? 'good' : 'neutral'` tone in
  // `integrations/mapping.tsx` drawer KvRow Status. Backend mirror paired
  // below.
  mapping_usage_state: [
    { value: 'in_use', label: 'In use', tone: 'good',    rank: 10, is_default: true, metadata: { tone: 'good' } },
    { value: 'unused', label: 'Unused', tone: 'neutral', rank: 20, metadata: { tone: 'neutral' } },
  ],

  // W69 Cycle F-R-9 closure: canonical provenance shipment-state taxonomy.
  // Replaces the inline `prov?.shipment_id ? 'good' : 'neutral'` literal
  // (`shipmentTone`) in `integrations/intake.tsx` ProvenanceDrawerBody.
  // The boolean→state derivation (matched/unmatched) stays in code; tone
  // routes through this canonical lookup. Backend mirror paired below.
  provenance_shipment_state: [
    { value: 'matched',   label: 'Matched',   tone: 'good',    rank: 10, is_default: true, metadata: { tone: 'good' } },
    { value: 'unmatched', label: 'Unmatched', tone: 'neutral', rank: 20, metadata: { tone: 'neutral' } },
  ],

  // workflows/review-queue — task priority tone (replaces inline 'high' branch).
  // W76 (Cycle F-R-16) closure: `is_default: true` on `normal` lets
  // review-queue resolve missing-priority defaults through canonical lookup
  // metadata instead of literal `|| 'normal'` synthesis.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
  task_priority: [
    { value: 'urgent', label: 'urgent', tone: 'danger',  rank: 10 },
    { value: 'high',   label: 'high',   tone: 'warn',    rank: 20 },
    { value: 'normal', label: 'normal', tone: 'neutral', rank: 30, is_default: true },
    { value: 'medium', label: 'medium', tone: 'info',    rank: 31 },
    { value: 'low',    label: 'low',    tone: 'neutral', rank: 40 },
  ],

  // network/marketplace — participant compliance / capability state.
  marketplace_participant_status: [
    { value: 'pending',   label: 'Pending',   tone: 'warn',    rank: 10 },
    { value: 'approved',  label: 'Approved',  tone: 'good',    rank: 20 },
    { value: 'rejected',  label: 'Rejected',  tone: 'danger',  rank: 30 },
    { value: 'suspended', label: 'Suspended', tone: 'warn',    rank: 40 },
    { value: 'expired',   label: 'Expired',   tone: 'neutral', rank: 50 },
  ],
  marketplace_capability_status: [
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 10 },
    { value: 'pending',  label: 'Pending',  tone: 'warn',    rank: 20 },
    { value: 'expired',  label: 'Expired',  tone: 'neutral', rank: 30 },
    { value: 'rejected', label: 'Rejected', tone: 'danger',  rank: 40 },
  ],

  // network/marketplace — weekday short labels (operator i18n SSOT).
  weekday_short: [
    { value: '0', label: 'Sun', rank: 0 },
    { value: '1', label: 'Mon', rank: 1 },
    { value: '2', label: 'Tue', rank: 2 },
    { value: '3', label: 'Wed', rank: 3 },
    { value: '4', label: 'Thu', rank: 4 },
    { value: '5', label: 'Fri', rank: 5 },
    { value: '6', label: 'Sat', rank: 6 },
  ],

  // W56-D (closure) — context-specific enabled state lookups so the same
  // boolean (`enabled`) projects to the correct domain language without
  // FE-side branching. Workflow run-trigger bindings render `enabled` /
  // `disabled` (neutral when off — operator authored the binding to be
  // off). Workflow schedule triggers render `enabled` / `paused` (warn
  // when off — schedule still exists but is suppressed). Two categories
  // replace the prior ambiguous `enabled_state` row set so the value
  // domain matches the canonical lookup category 1:1 (no shared row that
  // diverges across call sites).
  //
  // Backend mirror is paired so both categories project canonically:
  //   • `lookup_definitions.category = 'workflow_binding_enabled_state'`
  //   • `lookup_definitions.category = 'workflow_schedule_enabled_state'`
  workflow_binding_enabled_state: [
    { value: 'enabled',  label: 'enabled',  tone: 'good',    rank: 10 },
    { value: 'disabled', label: 'disabled', tone: 'neutral', rank: 20 },
  ],
  workflow_schedule_enabled_state: [
    { value: 'enabled', label: 'enabled', tone: 'good', rank: 10 },
    { value: 'paused',  label: 'paused',  tone: 'warn', rank: 20 },
  ],
  // W34c — `support_case_status` canonical row set is owned by `support.js`
  // (Object.assign extension) so the SSOT is not split. See support.js for
  // the canonical values, tones, and lifecycle metadata.
  // W56-B (F1) — `support_case_priority`, `support_case_event_type`,
  // `support_message_channel` canonical row sets are owned by `support.js`
  // (Object.assign extension) so the SSOT is not split. Previously declared
  // here AND there (support_case_event_type DIVERGENT — different values;
  // support_message_channel DIVERGENT TONE — sms/email tones differed); the
  // per-feature seed wins per W34c precedent (domain-owned, more recent).
  // W27 Cycle D closure — workflow_binding_event lookup is now the SSOT
  // for the trigger composer + new-template event picker drop-downs in
  // `modules/workflows/templates.tsx`. Replaces inline literal `<option>`
  // arrays. Each row carries `tone` for chip rendering when used as a
  // status pill. Backend mirror: `lookup_definitions.category =
  // 'workflow_binding_event'` (paired with the FE seed below).
  workflow_binding_event: [
    { value: 'webhook.shipment.created',                label: 'Webhook: Shipment created',          tone: 'info',    rank: 10 },
    { value: 'shipment.created',                        label: 'Shipment: Created',                  tone: 'info',    rank: 20 },
    { value: 'shipment.amended',                        label: 'Shipment: Amended',                  tone: 'info',    rank: 30 },
    { value: 'shipment.cancelled',                      label: 'Shipment: Cancelled',                tone: 'warn',    rank: 40 },
    { value: 'shipment.amend_cancel',                   label: 'Shipment: Amend / cancel',           tone: 'warn',    rank: 50 },
    { value: 'shipments.create',                        label: 'Shipments: Create (operator)',       tone: 'info',    rank: 60 },
    { value: 'dispatch.exception_recorded',             label: 'Dispatch: Exception recorded',       tone: 'danger',  rank: 70 },
    { value: 'task.dispatch_exception_review.resolved', label: 'Task: Dispatch exception resolved',  tone: 'good',    rank: 80 },
    { value: 'task.escalated',                          label: 'Task: Escalated',                    tone: 'danger',  rank: 90 },
    { value: 'route_run.assigned',                      label: 'Route run: Assigned',                tone: 'info',    rank: 100 },
    { value: 'route_run.completed',                     label: 'Route run: Completed',               tone: 'good',    rank: 110 },
    { value: 'route_plans.publish',                     label: 'Route plans: Publish',               tone: 'info',    rank: 120 },
    { value: 'shift.closed',                            label: 'Shift: Closed',                      tone: 'info',    rank: 130 },
    { value: 'cod.collected',                           label: 'COD: Collected',                     tone: 'good',    rank: 140 },
    { value: 'pickup.requested',                        label: 'Pickup: Requested',                  tone: 'info',    rank: 150 },
    { value: 'warehouse.transfer.execute',              label: 'Warehouse transfer: Execute',        tone: 'info',    rank: 160 },
    { value: 'custom.event',                            label: 'Custom event',                       tone: 'neutral', rank: 200 },
  ],
  // Cycle E (Workflows P1 #2) — canonical `workflow_expression_scope`
  // taxonomy. SSOT for the InputsTab "Available variables at this step"
  // tree in modules/workflows/templates.tsx. Replaces the inline literal
  // scope matrix `{ trigger: ['payload'], run: ['id', 'started_at',
  // 'correlation_id'], context: ['scope', 'tenant_id', 'client_id'],
  // vars: ['now', 'env'] }`. Each row's `metadata.variables` enumerates
  // the variable identifiers available at that scope. The InputsTab
  // resolves trigger payload keys live from the matched RecentEvent;
  // the canonical row for `trigger` exposes the deterministic fallback
  // (`['payload']`) when no matched event is present. Backend mirror:
  // `lookup_definitions.category = 'workflow_expression_scope'` (paired
  // with the FE seed below).
  // W68 (Workflows Cycle F-R-8 P1-5) — `metadata.is_trigger_scope: true` flags
  // the canonical scope row that consumes matched-event payload keys (currently
  // `trigger`). Replaces literal `row.value === 'trigger'` compare in
  // `modules/workflows/templates.tsx#scope` so the trigger-scope recogniser is
  // row-driven and adding a new trigger-equivalent scope is a single seed
  // update.
  workflow_expression_scope: [
    { value: 'trigger', label: 'Trigger', tone: 'info',    rank: 10, metadata: { variables: ['payload'], is_trigger_scope: true } },
    { value: 'run',     label: 'Run',     tone: 'info',    rank: 20, metadata: { variables: ['id', 'started_at', 'correlation_id'] } },
    { value: 'context', label: 'Context', tone: 'neutral', rank: 30, metadata: { variables: ['scope', 'tenant_id', 'client_id'] } },
    { value: 'vars',    label: 'Vars',    tone: 'neutral', rank: 40, metadata: { variables: ['now', 'env'] } },
  ],
  // W56-B (F2) — `metadata.swatch_token` projects each duty status to a
  // canonical CSS variable token consumed by the HoursOfServiceMeter legend
  // swatches. Replaces the inline `SWATCH_VAR: Record<DutyStatus, string>`
  // in components/HoursOfServiceMeter.tsx (which had a raw oklch literal
  // for `sleeper`). Tokens use the shared tone palette so the swatch
  // matches the chip rendering elsewhere on the surface.
  // W72 (Cycle F-R-12) closure — adds `metadata.counts_for_drive_time`
  // and `metadata.counts_for_on_duty` boolean flags so the
  // HoursOfServiceMeter accumulator can route through canonical
  // `lookupRow('duty_status', ...)` instead of literal-compare branches
  // (`s.type === 'driving' || s.type === 'on_duty'`). Driving counts toward
  // both drive-time and on-duty totals; on_duty counts toward on-duty only;
  // off_duty/sleeper count toward neither. AGENTS.md §2 (ZERO HARDCODING)
  // + §4 (SSOT) + §6 (row-driven).
  duty_status: [
    { value: 'driving',  label: 'Driving',  tone: 'info',    rank: 10, metadata: { swatch_token: 'var(--info)', counts_for_drive_time: true,  counts_for_on_duty: true  } },
    { value: 'on_duty',  label: 'On duty',  tone: 'warn',    rank: 20, metadata: { swatch_token: 'var(--warn)', counts_for_drive_time: false, counts_for_on_duty: true  } },
    { value: 'off_duty', label: 'Off duty', tone: 'neutral', rank: 30, metadata: { swatch_token: 'var(--ink-3)', counts_for_drive_time: false, counts_for_on_duty: false } },
    { value: 'sleeper',  label: 'Sleeper',  tone: 'info',    rank: 40, metadata: { swatch_token: 'var(--ink-2)', counts_for_drive_time: false, counts_for_on_duty: false } },
  ],
  auth_assurance_level: [
    { value: 'aal1', label: 'AAL1', tone: 'warn', rank: 10 },
    { value: 'aal2', label: 'AAL2', tone: 'good', rank: 20 },
    { value: 'aal3', label: 'AAL3', tone: 'info', rank: 30 },
  ],
  // ─── W28a canonical-tone seed expansion ────────────────────────────
  // Vehicle maintenance window status — canonical CHECK constraint values:
  // scheduled / completed / cancelled (supabase/migrations/202604280030_*.sql).
  // `planned`/`in_progress` retained as transitional aliases; backend
  // migration of those will remove them additively.
  //
  // W74-Operate (Cycle F-R-14 P1-5) — `metadata.is_terminal` row-drives
  // the "actionable maintenance window" filter in
  // `operate/fleet/vehicles.tsx#actionable`. Replaces the inline
  // `m.status === 'planned' || m.status === 'scheduled' || m.status === 'in_progress'`
  // literal disjunction. The projection boolean
  // (`v_vehicle_maintenance_directory.is_terminal`) remains the SSOT when
  // present; metadata is the canonical fallback when consumers only have
  // the raw `status` enum to work with. Strict no-fallback: a status
  // outside this canonical set yields `undefined` and is filtered out
  // (gap is observable instead of silently allowed by a literal allowlist).
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  maintenance_window_status: [
    { value: 'scheduled',   label: 'Scheduled',   tone: 'neutral', rank: 10, metadata: { is_terminal: false } },
    { value: 'in_progress', label: 'In progress', tone: 'warn',    rank: 20, metadata: { is_terminal: false } },
    { value: 'completed',   label: 'Completed',   tone: 'good',    rank: 30, metadata: { is_terminal: true  } },
    { value: 'cancelled',   label: 'Cancelled',   tone: 'neutral', rank: 40, metadata: { is_terminal: true  } },
    { value: 'planned',     label: 'Planned',     tone: 'neutral', rank: 50, metadata: { is_terminal: false } },
  ],
  // W56-B (F1) — `vehicle_event_type` canonical row set is owned by
  // `fleet-vehicles.js` (Object.assign extension) so the SSOT is not split.
  // Previously declared here AND there with DIVERGENT tones/values; the
  // per-feature seed wins per W34c precedent (canonical 4-value enum per
  // supabase/migrations/202601311230_enterprise_ops_v1.sql:240-251).
  // Provider auth lifecycle status (consumed by integrations/credentials.tsx).
  // Mirrors `public.provider_auth_configs.status` enum.
  //
  // W70 (Cycle F-R-10 P2-4 closure — AGENTS.md §2 ZERO HARDCODING + §6
  // row-driven by configuration): `metadata.is_risk` (boolean) drives the
  // `is-risk` table-row class in `integrations/credentials.tsx` DataTable.
  // Replaces the inline `r.status === 'expiring' || r.status === 'expired'`
  // literal compare. Set true for statuses that should escalate the row
  // (`expiring`, `expired`); false/omitted for healthy or terminal-but-not-
  // urgent states. The `expiring` row is also added here to mirror the
  // canonical derived status returned by `deriveCredStatus` (was missing).
  // W71-Integrations (Cycle F-R-11) closure: each row carries
  //   • `metadata.lifecycle` (active|pending|rotating|expiring|revoked|expired)
  //     — drives the `deriveCredStatus` projection in
  //     `modules/integrations/credentials.tsx` and `modules/integrations/_helpers.ts`.
  //   • `metadata.is_active` / `metadata.is_revoked` boolean shorthand —
  //     replaces inline `row.status === 'revoked'` / `row.status === 'active'`
  //     literal compares.
  //   • `metadata.is_terminal` — true for revoked/expired (no further state
  //     transitions allowed).
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
  provider_auth_status: [
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 10, metadata: { is_risk: false, lifecycle: 'active',   is_active: true,  is_revoked: false, is_terminal: false } },
    { value: 'pending',  label: 'Pending',  tone: 'info',    rank: 20, metadata: { is_risk: false, lifecycle: 'pending',  is_active: false, is_revoked: false, is_terminal: false } },
    { value: 'rotating', label: 'Rotating', tone: 'warn',    rank: 30, metadata: { is_risk: false, lifecycle: 'rotating', is_active: false, is_revoked: false, is_terminal: false } },
    { value: 'expiring', label: 'Expiring', tone: 'warn',    rank: 35, metadata: { is_risk: true,  lifecycle: 'expiring', is_active: false, is_revoked: false, is_terminal: false } },
    { value: 'revoked',  label: 'Revoked',  tone: 'danger',  rank: 40, metadata: { is_risk: false, lifecycle: 'revoked',  is_active: false, is_revoked: true,  is_terminal: true  } },
    { value: 'expired',  label: 'Expired',  tone: 'danger',  rank: 50, metadata: { is_risk: true,  lifecycle: 'expired',  is_active: false, is_revoked: false, is_terminal: true  } },
  ],
  // Marketing intake decision taxonomy (consumed by integrations/intake.tsx).
  // Mirrors marketing_demo_intake_policy decision outcomes.
  marketing_decision: [
    { value: 'accepted',     label: 'Accepted',      tone: 'good',    rank: 10 },
    { value: 'verified',     label: 'Verified',      tone: 'good',    rank: 20 },
    { value: 'rate_limited', label: 'Rate limited',  tone: 'warn',    rank: 30 },
    { value: 'turnstile_failed', label: 'Turnstile failed', tone: 'danger', rank: 40 },
    { value: 'dedupe_dropped',   label: 'Dedupe dropped',   tone: 'neutral', rank: 50 },
    { value: 'rejected',     label: 'Rejected',      tone: 'danger',  rank: 60 },
  ],
  // Mapping artifact type taxonomy (consumed by integrations/mapping.tsx).
  // Mirrors `public.mapping_configs.mapping_type` CHECK enum.
  mapping_type: [
    { value: 'webhook_inbound',   label: 'Webhook inbound',   tone: 'info',    rank: 10 },
    { value: 'webhook_outbound',  label: 'Webhook outbound',  tone: 'info',    rank: 20 },
    { value: 'webhook_response',  label: 'Webhook response',  tone: 'neutral', rank: 30 },
    { value: 'provider_response', label: 'Provider response', tone: 'neutral', rank: 40 },
    { value: 'event_extraction',  label: 'Event extraction',  tone: 'good',    rank: 50 },
    { value: 'tabular_import',    label: 'Tabular import',    tone: 'info',    rank: 60 },
    { value: 'api_gateway_inbound', label: 'API Gateway inbound', tone: 'info', rank: 70 },
  ],
  mapping_target: [
    {
      value: 'shipments.create',
      label: 'Shipment create',
      tone: 'info',
      rank: 10,
      is_default: true,
      metadata: {
        target_resource: 'shipments',
        target_action: 'create',
        canonical_intent: 'shipment.create',
        backend_operation: 'create',
        workflow_template_name: 'webhook_shipment_create_v1',
        api_gateway_workflow_template_name: 'api_gateway_shipment_create_default_v1',
        workflow_templates_by_mapping_type: {
          webhook_inbound: 'webhook_shipment_create_v1',
          api_gateway_inbound: 'api_gateway_shipment_create_default_v1',
        },
        allowed_mapping_types: ['api_gateway_inbound', 'webhook_inbound', 'tabular_import'],
        required_output_paths: [
          { path: 'recipient.name', label: 'Recipient name' },
          { path: 'recipient.phone', label: 'Recipient phone' },
          { path: 'address.line1', label: 'Address line 1' },
          { path: 'address.city', label: 'Address city' },
          { path: 'address.country_code', label: 'Address country' },
        ],
      },
    },
    { value: 'webhook_response', label: 'Webhook response', tone: 'neutral', rank: 20, metadata: { target_resource: 'webhook_response', target_action: 'build', allowed_mapping_types: ['webhook_response', 'webhook_outbound'] } },
    { value: 'shipments.update_status', label: 'Shipment status update', tone: 'warn', rank: 30, metadata: { target_resource: 'shipments', target_action: 'update_status', allowed_mapping_types: ['api_gateway_inbound', 'provider_response', 'webhook_inbound'] } },
    { value: 'shipments.update', label: 'Shipment update', tone: 'warn', rank: 31, metadata: { target_resource: 'shipments', target_action: 'update', canonical_intent: 'shipment.update', backend_operation: 'update', workflow_template_name: 'api_gateway_shipment_update_default_v1', allowed_mapping_types: ['api_gateway_inbound'] } },
    { value: 'shipments.delete', label: 'Shipment delete', tone: 'danger', rank: 34, metadata: { target_resource: 'shipments', target_action: 'delete', canonical_intent: 'shipment.delete', backend_operation: 'delete', workflow_template_name: 'api_gateway_shipment_cancel_default_v1', allowed_mapping_types: ['api_gateway_inbound'] } },
    { value: 'shipments.cancel', label: 'Shipment cancel', tone: 'danger', rank: 35, metadata: { target_resource: 'shipments', target_action: 'cancel', canonical_intent: 'shipment.delete', backend_operation: 'cancel', workflow_template_name: 'shipment_delete_v1', api_gateway_workflow_template_name: 'api_gateway_shipment_cancel_default_v1', workflow_templates_by_mapping_type: { webhook_inbound: 'shipment_delete_v1', api_gateway_inbound: 'api_gateway_shipment_cancel_default_v1' }, allowed_mapping_types: ['api_gateway_inbound', 'webhook_inbound'] } },
    { value: 'shipments.reschedule', label: 'Shipment reschedule', tone: 'warn', rank: 36, metadata: { target_resource: 'shipments', target_action: 'reschedule', canonical_intent: 'shipment.reschedule', backend_operation: 'reschedule', workflow_template_name: 'shipment_reschedule_v1', allowed_mapping_types: ['api_gateway_inbound', 'webhook_inbound'] } },
    { value: 'domain_events', label: 'Domain event extraction', tone: 'good', rank: 40, metadata: { target_resource: 'domain_events', target_action: 'extract', allowed_mapping_types: ['event_extraction'] } },
  ],

  // ─── W50 canonical-tone seed expansion (no-fallback campaign) ──────────
  // Closes 4 hardcoded inline filter arrays in apps/console-v2/src/modules.
  // Backend mirror lands in supabase/migrations/202605020800_w50_*.sql.

  // mobile_attestation_status — canonical attestation lifecycle for
  // public.user_devices.metadata->'attestation'->>'status' (projected as
  // top-level `attestation_status` by v_user_device_summary). Consumed by
  // platform/mobile-policy.tsx attestation filter chips.
  mobile_attestation_status: [
    { value: 'trusted', label: 'Trusted', tone: 'good',    rank: 10 },
    { value: 'pending', label: 'Pending', tone: 'info',    rank: 20 },
    { value: 'failed',  label: 'Failed',  tone: 'danger',  rank: 30 },
    { value: 'revoked', label: 'Revoked', tone: 'neutral', rank: 40 },
  ],

  // label_render_job_status — operator-facing filter labels used by
  // platform/labels.tsx print-queue chips. Each row carries the backend
  // label_jobs.status values it matches so the UI stays lookup-driven while
  // the canonical database enum remains pending/in_progress/succeeded/failed.
  label_render_job_status: [
    { value: 'queued',     label: 'Queued',     tone: 'info',   rank: 10, metadata: { backend_values: ['pending'] } },
    { value: 'rendering',  label: 'Rendering',  tone: 'warn',   rank: 20, metadata: { backend_values: ['in_progress'] } },
    { value: 'completed',  label: 'Completed',  tone: 'good',   rank: 30, metadata: { backend_values: ['succeeded'] } },
    { value: 'failed',     label: 'Failed',     tone: 'danger', rank: 40, metadata: { backend_values: ['failed'] } },
  ],

  // label_type — canonical label design / label_jobs target taxonomy.
  // Mirrors lookup_contracts_domain_enums.sql plus target-neutral route /
  // container / transfer expansions so platform/labels.tsx uses a backend
  // lookup instead of a free-text label_type input.
  label_type: [
    { value: 'shipping',  label: 'Shipping',  tone: 'good',    rank: 10, is_default: true, metadata: { compatible_target_types: ['shipment'] } },
    { value: 'return',    label: 'Return',    tone: 'warn',    rank: 20 },
    { value: 'customs',   label: 'Customs',   tone: 'neutral', rank: 30 },
    { value: 'route',     label: 'Route',     tone: 'info',    rank: 40, metadata: { compatible_target_types: ['route_run'] } },
    { value: 'container', label: 'Container', tone: 'info',    rank: 50, metadata: { compatible_target_types: ['handling_unit'] } },
    { value: 'transfer',  label: 'Transfer',  tone: 'info',    rank: 60, metadata: { compatible_target_types: ['warehouse_transfer'] } },
  ],

  // tenant_signup_request_status — canonical lifecycle enum already
  // registered in supabase/migrations/202602211145_tenant_signup_lookup_contracts_status_decision_v1.sql.
  // FE mirror adds `metadata.tone` so platform/organizations.tsx filter
  // chips and the drawer surface stay row-driven. The paired W50 backend
  // migration adds `metadata` jsonb to the existing rows.
  // W71-Platform (Cycle F-R-11) closure: each row carries
  //   • `metadata.lifecycle` (pending|approved|rejected) — drives lifecycle
  //     projection in platform/organizations.tsx.
  //   • `metadata.is_terminal` — true on approved/rejected.
  //   • `metadata.allows_review` — true on pending (gates review actions).
  // The `_default` row (`is_default: true`) is `pending`, so callers fall
  // back via `.find((r) => r.is_default)?.value` instead of inline
  // `?? 'pending'` literals. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT)
  // + §6 (row-driven by configuration).
  label_reprint_reason: [
    { value: 'operator_request', label: 'Operator request', tone: 'neutral', rank: 10, is_default: true },
    { value: 'damaged',          label: 'Damaged',          tone: 'warn',    rank: 20 },
    { value: 'lost',             label: 'Lost',             tone: 'warn',    rank: 30 },
    { value: 'unreadable',       label: 'Unreadable',       tone: 'danger',  rank: 40 },
    { value: 'address_changed',  label: 'Address changed',  tone: 'info',    rank: 50 },
    { value: 'misprinted',       label: 'Misprinted',       tone: 'danger',  rank: 60 },
  ],

  tenant_signup_request_status: [
    { value: 'pending',  label: 'Pending',  tone: 'warn',   rank: 10, is_default: true, metadata: { lifecycle: 'pending',  is_terminal: false, allows_review: true  } },
    { value: 'approved', label: 'Approved', tone: 'good',   rank: 20, metadata: { lifecycle: 'approved', is_terminal: true,  allows_review: false } },
    { value: 'rejected', label: 'Rejected', tone: 'danger', rank: 30, metadata: { lifecycle: 'rejected', is_terminal: true,  allows_review: false } },
  ],

  // kpi_group — canonical group-section taxonomy mirroring
  // kpi_definitions.definition.group. Consumed by insights/reporting.tsx
  // for section eyebrow labels (no parallel registry in module code).
  kpi_group: [
    { value: 'operations',   label: 'Operations',   tone: 'info',    rank: 10 },
    { value: 'marketplace',  label: 'Marketplace',  tone: 'good',    rank: 20 },
    { value: 'integrations', label: 'Integrations', tone: 'neutral', rank: 30 },
    { value: 'workflows',    label: 'Workflows',    tone: 'warn',    rank: 40 },
  ],

  // ─── W54-D canonical-tone seed expansion (no-fallback campaign) ─────
  // Closes hardcoded option-list / tone-branch clusters in
  // apps/console-v2/src/modules/{platform,insights}. Modules now read tone
  // and option labels via `getLookups(category)` / `lookupRow(category, value)`
  // instead of TS literal arrays. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).

  // W56-B (F1) — `alert_severity` and `alert_channel` canonical row sets are
  // owned by `platform-alerts.js` (Object.assign extension) so the SSOT is
  // not split. Previously declared here AND there (alert_channel DIVERGENT
  // TONE — slack=info, pagerduty=danger in the per-feature seed vs all
  // neutral here); the per-feature seed wins per the W34c precedent.

  // priority — canonical priority taxonomy consumed by
  // platform/planning-os.tsx project-item priority chips + the planning-os
  // execution-card detail drawer. Replaces inline `priorityKind` /
  // `priorityBar` helpers (p0=danger / p1=warn / p2=info / p3=neutral).
  priority: [
    { value: 'p0', label: 'P0', tone: 'danger',  rank: 10 },
    { value: 'p1', label: 'P1', tone: 'warn',    rank: 20 },
    { value: 'p2', label: 'P2', tone: 'info',    rank: 30 },
    { value: 'p3', label: 'P3', tone: 'neutral', rank: 40 },
  ],

  // http_method — canonical HTTP verb taxonomy consumed by
  // insights/api-gateway.tsx + _api-gateway.helpers.ts methodKind() chip
  // tone resolution. Verbs follow the standard HTTP semantics: GET=info
  // (safe/idempotent reads), POST=good (resource creation), PUT/PATCH=warn
  // (resource mutation), DELETE=danger (destructive). lookup_definitions
  // entry already exists at row 907 in this file.
  http_method: [
    { value: 'GET',    label: 'GET',    tone: 'info',   rank: 10 },
    { value: 'POST',   label: 'POST',   tone: 'good',   rank: 20 },
    { value: 'PUT',    label: 'PUT',    tone: 'warn',   rank: 30 },
    { value: 'PATCH',  label: 'PATCH',  tone: 'warn',   rank: 40 },
    { value: 'DELETE', label: 'DELETE', tone: 'danger', rank: 50 },
  ],

  // api_status_class — canonical HTTP status-code class taxonomy consumed
  // by insights/api-gateway.tsx + _api-gateway.helpers.ts statusKind() chip
  // tone resolution. Mirrors the standard HTTP class semantics:
  // 2xx=good (success), 3xx=neutral (redirect), 4xx=warn (client error),
  // 5xx=danger (server error).
  api_status_class: [
    { value: '2xx', label: '2xx', tone: 'good',    rank: 10 },
    { value: '3xx', label: '3xx', tone: 'neutral', rank: 20 },
    { value: '4xx', label: '4xx', tone: 'warn',    rank: 30 },
    { value: '5xx', label: '5xx', tone: 'danger',  rank: 40 },
  ],

  // ─── W27 Cycle D Network closure — branch_zone_band ──────────────────
  // Canonical visual band taxonomy for `branch_zones.priority` projection.
  // The FE projects priority (0 = primary, 1..fallback_min-1 = secondary,
  // >= fallback_min = fallback) via `priorityToBand()` and renders a chip
  // through this category. Replaces the prior misuse of `branch_role`
  // (which has its own canonical values) for visual band rendering.
  // Priority threshold itself is row-driven via the
  // `branch_zone_band_priority_threshold` settings policy (policies.js).
  // E2 closure (P2 #7) — `no_policy` sentinel surfaces when the canonical
  // `branch_zone_band_priority_threshold` settings policy row is missing.
  // `priorityToBand` returns this sentinel so the chip renders a danger
  // tone (fail-loud) rather than silently using a hardcoded baseline.
  branch_zone_band: [
    { value: 'primary',   label: 'Primary',   tone: 'good',   rank: 10 },
    { value: 'secondary', label: 'Secondary', tone: 'info',   rank: 20 },
    { value: 'fallback',  label: 'Fallback',  tone: 'warn',   rank: 30 },
    { value: 'no_policy', label: 'No policy', tone: 'danger', rank: 40 },
  ],

  // ─── W27 Cycle D Platform+Insights closure ───────────────────────────
  // Canonical lookup catalogs for the cluster-D fixes — keep tones aligned
  // with the operator-severity expectation surfaced in
  // platform/auth-email.tsx and insights/traces.tsx. Categories register on
  // lookup_definitions below so the metadata mirror stays in sync.

  // email_auth_audit_status — drives the audit chip on platform/auth-email.
  // Tone alignment mirrors the policy traffic-light convention (green /
  // yellow / red) projected from auth-email-url-policy.<env>.json.
  email_auth_audit_status: [
    { value: 'green',  label: 'Green',  tone: 'good',   rank: 10 },
    { value: 'yellow', label: 'Yellow', tone: 'warn',   rank: 20 },
    { value: 'red',    label: 'Red',    tone: 'danger', rank: 30 },
  ],

  // trace_event_source — drives the chip tone on insights/traces timeline
  // rows. Mirrors observability_events.event_source values returned by
  // public.ui_get_trace_v1 (decision_log, audit_log, error_log, system_log,
  // api_call_log).
  trace_event_source: [
    { value: 'decision_log', label: 'decision_log', tone: 'info',    rank: 10 },
    { value: 'audit_log',    label: 'audit_log',    tone: 'neutral', rank: 20 },
    { value: 'error_log',    label: 'error_log',    tone: 'danger',  rank: 30 },
    { value: 'system_log',   label: 'system_log',   tone: 'neutral', rank: 40 },
    { value: 'api_call_log', label: 'api_call_log', tone: 'neutral', rank: 50 },
  ],

  // ─── W-Cycle-E (P2 #9) trace_event_status ───────────────────────────────
  // Canonical chip / timeline-bar tone for `observability_events.status`
  // values returned by `public.ui_get_trace_v1`. Replaces the inline
  // `row.ev.status === 'failed' ? danger : accent` ternary in
  // insights/traces.tsx ObservabilityRow timeline-bar fill. `metadata.bar_var`
  // projects the canonical CSS variable consumed by the SVG bar fill so the
  // visual stays in sync with the chip palette.
  trace_event_status: [
    { value: 'success',   label: 'success',   tone: 'good',    rank: 10, metadata: { bar_var: 'var(--accent)' } },
    { value: 'completed', label: 'completed', tone: 'good',    rank: 20, metadata: { bar_var: 'var(--accent)' } },
    { value: 'pending',   label: 'pending',   tone: 'info',    rank: 30, metadata: { bar_var: 'var(--accent)' } },
    { value: 'running',   label: 'running',   tone: 'info',    rank: 40, metadata: { bar_var: 'var(--accent)' } },
    { value: 'warning',   label: 'warning',   tone: 'warn',    rank: 50, metadata: { bar_var: 'var(--warn)' } },
    { value: 'failed',    label: 'failed',    tone: 'danger',  rank: 60, metadata: { bar_var: 'var(--danger)' } },
    { value: 'error',     label: 'error',     tone: 'danger',  rank: 70, metadata: { bar_var: 'var(--danger)' } },
  ],

  // ─── W-Cycle-E (P2 #5) validation_issue_severity ────────────────────────
  // Canonical chip palette for the shared condition-builder
  // (`modules/workflows/_bindings/condition-model.ts`) `Issue.severity` values
  // (`error|warn`). Consumed by platform/alerts.tsx + workflows/bindings.tsx
  // condition editors so the inline `iss.severity === 'error' ? danger : warn`
  // ternary can resolve through the lookup catalog.
  // W81-Platform+Insights (Cycle F-R-21 P1) — `metadata.is_blocking` flags the
  // severities that should fail the save action (`error`). Replaces the inline
  // `i.severity === 'error'` literal compare in platform/alerts.tsx so adding
  // a new blocking severity (e.g. a future `fatal` slot) is a single seed
  // insert. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  validation_issue_severity: [
    { value: 'error', label: 'error', tone: 'danger', rank: 10, metadata: { is_blocking: true  } },
    { value: 'warn',  label: 'warn',  tone: 'warn',   rank: 20, metadata: { is_blocking: false } },
  ],

  // ─── W-Cycle-E (P2 #10) kpi_format ──────────────────────────────────────
  // Canonical formatting metadata for the KPI catalog
  // (`kpi_definitions.format` projection consumed by insights/reporting.tsx).
  // Replaces the inline `switch (data.format) { case 'percent': ... }` block.
  // `metadata.suffix` is the unit suffix appended to the formatted value;
  // `metadata.decimals` is the rounding precision passed to `roundTo` (or
  // null for `Math.round` integer formatting).
  kpi_format: [
    { value: 'percent',          label: 'Percent',          rank: 10, metadata: { suffix: '%', decimals: 1 } },
    { value: 'duration_minutes', label: 'Duration (min)',   rank: 20, metadata: { suffix: 'm', decimals: null } },
    { value: 'duration_seconds', label: 'Duration (sec)',   rank: 30, metadata: { suffix: 's', decimals: 1 } },
    { value: 'integer',          label: 'Integer',          rank: 40, metadata: { suffix: '',  decimals: null } },
    { value: 'numeric',          label: 'Numeric',          rank: 50, metadata: { suffix: '',  decimals: 2 } },
  ],

  // ─── W-Cycle-E (P2 #11) manifest_kind ───────────────────────────────────
  // Canonical taxonomy for `label_jobs.renderer_metadata.manifest_kind`
  // (and `target_metadata.manifest_kind`). `metadata.target_type` projects
  // each manifest kind onto the canonical `target_type` literal consumed
  // by platform/labels.tsx#targetTypeOf — replaces the inline
  // `kind === 'partner_handover' ? 'route_run' : ...` ternary so adding a
  // new manifest kind (e.g. `cod_settlement` → `settlement_run`) is a
  // lookup mutation rather than a source edit.
  manifest_kind: [
    { value: 'partner_handover',  label: 'Partner handover',  rank: 10, metadata: { target_type: 'route_run' } },
    { value: 'transfer_summary',  label: 'Transfer summary',  rank: 20, metadata: { target_type: 'warehouse_transfer' } },
  ],

  // ─── W56-B (F7) canonical-mirror seed expansion ─────────────────────────
  // SSOT for the categories below is the backend
  // `supabase/migrations/202601202320_lookup_column_contracts_and_enforcement.sql`
  // lookup_values seed (rows 116-220). The FE mirrors them so a parity test
  // can assert that every entry in `lookup_definitions` has at least one
  // canonical row — closes the long-standing F7 gap (definition without
  // values fails the no-fallback contract).

  // public.settings_versions.approval_status (canonical CHECK enum)
  approval_status: [
    { value: 'pending',   label: 'Pending',   tone: 'warn',    rank: 10, is_default: true },
    { value: 'approved',  label: 'Approved',  tone: 'good',    rank: 20 },
    { value: 'rejected',  label: 'Rejected',  tone: 'danger',  rank: 30 },
    { value: 'withdrawn', label: 'Withdrawn', tone: 'neutral', rank: 40 },
  ],

  // public.settings_versions.backoff_strategy (rate-limit retry policies)
  backoff_strategy: [
    { value: 'linear',      label: 'Linear',      tone: 'info',    rank: 10, is_default: true },
    { value: 'exponential', label: 'Exponential', tone: 'warn',    rank: 20 },
    { value: 'fibonacci',   label: 'Fibonacci',   tone: 'neutral', rank: 30 },
  ],

  // public.organizations.billing_status (org-level billing posture)
  billing_status: [
    { value: 'active',    label: 'Active',    tone: 'good',    rank: 10, is_default: true },
    { value: 'suspended', label: 'Suspended', tone: 'danger',  rank: 20 },
    { value: 'trial',     label: 'Trial',     tone: 'info',    rank: 30 },
  ],

  // public.component_health_logs.status (observability component health)
  component_health_status: [
    { value: 'healthy',  label: 'Healthy',  tone: 'good',   rank: 10, is_default: true },
    { value: 'degraded', label: 'Degraded', tone: 'warn',   rank: 20 },
    { value: 'down',     label: 'Down',     tone: 'danger', rank: 30 },
  ],

  // public.webhook_sources.domain_category (webhook routing domain)
  domain_category: [
    { value: 'shipment',      label: 'Shipment',      tone: 'info',    rank: 10, is_default: true },
    { value: 'tracking',      label: 'Tracking',      tone: 'info',    rank: 20 },
    { value: 'communication', label: 'Communication', tone: 'good',    rank: 30 },
    { value: 'delivery_sync', label: 'Delivery Sync', tone: 'neutral', rank: 40 },
  ],

  // public.feature_flags.scope_type subset (override ladder)
  feature_flag_scope: [
    { value: 'global', label: 'Global', tone: 'info',    rank: 10, is_default: true },
    { value: 'tenant', label: 'Tenant', tone: 'good',    rank: 20 },
    { value: 'client', label: 'Client', tone: 'neutral', rank: 30 },
  ],

  // public.geocoding_attempts.attempt_type (canonical attempt taxonomy)
  geocoding_attempt_type: [
    { value: 'primary',       label: 'Primary',       tone: 'good',    rank: 10, is_default: true },
    { value: 'fallback',      label: 'Fallback',      tone: 'warn',    rank: 20 },
    { value: 'retry',         label: 'Retry',         tone: 'info',    rank: 30 },
    { value: 'manual_review', label: 'Manual Review', tone: 'warn',    rank: 40 },
    { value: 'cache_hit',     label: 'Cache Hit',     tone: 'neutral', rank: 50 },
  ],

  // canonical job lifecycle (jobs table / generic worker queues)
  job_status: [
    { value: 'pending',            label: 'Pending',            tone: 'info',    rank: 10, is_default: true },
    { value: 'in_progress',        label: 'In Progress',        tone: 'info',    rank: 20 },
    { value: 'completed',          label: 'Completed',          tone: 'good',    rank: 30 },
    { value: 'failed',             label: 'Failed',             tone: 'danger',  rank: 40 },
    { value: 'permanently_failed', label: 'Permanently Failed', tone: 'danger',  rank: 50 },
  ],

  // public.lookup_values.status (governance lifecycle on lookup rows themselves)
  // W81-Catalog+Customers (Cycle F-R-21 P1) — `metadata.lifecycle` token is the
  // canonical governance-lifecycle classifier consumed by catalog/lookups.tsx
  // for the create-draft / promoted-active / archived-terminal post-mutation
  // local-state mirrors. Rows are also flagged with `is_default: true` on the
  // canonical pending row so `defaultLookupValueStatus()` resolves the new-row
  // default through SSOT instead of an inline `'draft'` literal. Adding a
  // future lifecycle slot (e.g., `superseded`) is then a single seed insert.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  lookup_value_status: [
    { value: 'draft',    label: 'Draft',    tone: 'neutral', rank: 10, is_default: true, metadata: { lifecycle: 'pending' } },
    { value: 'active',   label: 'Active',   tone: 'good',    rank: 20,                   metadata: { lifecycle: 'active' } },
    { value: 'archived', label: 'Archived', tone: 'warn',    rank: 30,                   metadata: { lifecycle: 'terminal' } },
  ],

  // public.mapping_configs.mapping_domain (translation taxonomy)
  mapping_domain: [
    { value: 'status',          label: 'Status',          tone: 'info',    rank: 10, is_default: true },
    { value: 'service_level',   label: 'Service Level',   tone: 'info',    rank: 20 },
    { value: 'country_code',    label: 'Country Code',    tone: 'neutral', rank: 30 },
    { value: 'payment_method',  label: 'Payment Method',  tone: 'good',    rank: 40 },
    { value: 'currency',        label: 'Currency',        tone: 'good',    rank: 50 },
    { value: 'unit_of_measure', label: 'Unit Of Measure', tone: 'neutral', rank: 60 },
  ],

  // public.messages.status (delivery/comms message lifecycle)
  message_status: [
    { value: 'sent',      label: 'Sent',      tone: 'info',    rank: 10, is_default: true },
    { value: 'delivered', label: 'Delivered', tone: 'good',    rank: 20 },
    { value: 'failed',    label: 'Failed',    tone: 'danger',  rank: 30 },
    { value: 'bounce',    label: 'Bounce',    tone: 'warn',    rank: 40 },
  ],

  // public.provider_auth_configs.auth_type (provider auth mechanisms)
  provider_auth_type: [
    { value: 'api_key',      label: 'API Key',      tone: 'neutral', rank: 10, is_default: true },
    { value: 'oauth2',       label: 'OAuth 2.0',    tone: 'good',    rank: 20 },
    { value: 'bearer_token', label: 'Bearer Token', tone: 'info',    rank: 30 },
    { value: 'basic_auth',   label: 'Basic Auth',   tone: 'warn',    rank: 40 },
    { value: 'hmac',         label: 'HMAC',         tone: 'good',    rank: 50 },
    { value: 'custom',       label: 'Custom',       tone: 'neutral', rank: 60 },
  ],

  // public.providers.provider_type (canonical provider taxonomy)
  provider_type: [
    { value: 'comms',     label: 'Comms',     tone: 'good',    rank: 10 },
    { value: 'geocoding', label: 'Geocoding', tone: 'info',    rank: 20, is_default: true },
    { value: 'routing',   label: 'Routing',   tone: 'info',    rank: 30 },
    { value: 'webhook',   label: 'Webhook',   tone: 'neutral', rank: 40 },
    { value: 'payment',   label: 'Payment',   tone: 'good',    rank: 50 },
    { value: 'delivery',  label: 'Delivery',  tone: 'info',    rank: 60 },
  ],

  // public.rate_limit_policies.window_unit (canonical bucket sizes)
  rate_limit_window: [
    { value: 'second', label: 'Second', tone: 'warn',    rank: 10 },
    { value: 'minute', label: 'Minute', tone: 'info',    rank: 20, is_default: true },
    { value: 'hour',   label: 'Hour',   tone: 'good',    rank: 30 },
    { value: 'day',    label: 'Day',    tone: 'neutral', rank: 40 },
  ],

  // public.workflow_runs.entry_point (workflow ingress taxonomy)
  request_entry_point: [
    { value: 'webhook', label: 'Webhook', tone: 'info',    rank: 10, is_default: true },
    { value: 'api',     label: 'API',     tone: 'good',    rank: 20 },
    { value: 'worker',  label: 'Worker',  tone: 'neutral', rank: 30 },
    { value: 'manual',  label: 'Manual',  tone: 'warn',    rank: 40 },
  ],

  // public.settings_audit_log.action (canonical settings audit ledger actions)
  settings_audit_action: [
    { value: 'created',     label: 'Created',     tone: 'info',    rank: 10, is_default: true },
    { value: 'approved',    label: 'Approved',    tone: 'good',    rank: 20 },
    { value: 'applied',     label: 'Applied',     tone: 'good',    rank: 30 },
    { value: 'rolled_back', label: 'Rolled Back', tone: 'warn',    rank: 40 },
    { value: 'reverted',    label: 'Reverted',    tone: 'danger',  rank: 50 },
  ],

  // public.tasks.urgency (canonical operator urgency taxonomy)
  urgency_level: [
    { value: 'low',      label: 'Low',      tone: 'neutral', rank: 10 },
    { value: 'medium',   label: 'Medium',   tone: 'info',    rank: 20, is_default: true },
    { value: 'high',     label: 'High',     tone: 'warn',    rank: 30 },
    { value: 'critical', label: 'Critical', tone: 'danger',  rank: 40 },
  ],

  // public.workflow_template_steps.transition (canonical step transitions)
  workflow_transition: [
    { value: 'success', label: 'Success', tone: 'good',    rank: 10 },
    { value: 'failure', label: 'Failure', tone: 'danger',  rank: 20 },
    { value: 'always',  label: 'Always',  tone: 'info',    rank: 30, is_default: true },
    { value: 'custom',  label: 'Custom',  tone: 'neutral', rank: 40 },
  ],

  // ─── W81-Workflows (Cycle F-R-21 P2) task_review_queue_filter ─────────────
  // Canonical filter-chip catalogue for the workflows/review-queue.tsx
  // FILTERS array (mine / queue / all / breach / snoozed). Replaces the
  // inline TS-literal array so adding a new filter chip (e.g., a future
  // `escalated` view) is a single seed insert rather than a code change.
  // `icon` + `tone` carry the chip presentation metadata; `rank` keeps the
  // canonical render order. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven
  // by configuration).
  task_review_queue_filter: [
    { value: 'mine',    label: 'Assigned to me', tone: 'neutral', icon: 'user',  rank: 10, is_default: true },
    { value: 'queue',   label: 'Unassigned',     tone: 'neutral', icon: 'inbox', rank: 20 },
    { value: 'all',     label: 'All',            tone: 'neutral',                rank: 30 },
    { value: 'breach',  label: 'SLA breached',   tone: 'danger',                 rank: 40 },
    { value: 'snoozed', label: 'Snoozed',        tone: 'neutral',                rank: 50 },
  ],
};

// lookup_definitions metadata (mirrors public.lookup_definitions: owner_role, approval_policy, is_mutable).
// SSOT: supabase/migrations/202601202320_lookup_column_contracts_and_enforcement.sql lines 22-54.
// Categories not listed default to mutable + tenant-owned (matches migration default for new categories).
export const lookup_definitions = [
  { category: 'approval_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Settings approval workflow status' },
  { category: 'access_scope_type', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'User access scope type' },
  { category: 'backoff_strategy', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Rate limit backoff strategy' },
  { category: 'billing_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Organization billing status' },
  { category: 'circuit_state', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Circuit breaker state' },
  { category: 'client_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Client lifecycle status' },
  { category: 'communication_channel', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Communication channel' },
  { category: 'component_health_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Component health status' },
  { category: 'constraint_check_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Route-plan validator constraint outcome (pass/warn/danger) consumed by route-plans.tsx Validator chip tone' },
  { category: 'delivery_handover_mode', owner_role: 'dispatch', approval_policy: 'tier_1', is_mutable: true, description: 'Delivery handover mode taxonomy with row-driven proof requirements for route-stop closeout.' },
  { category: 'domain_category', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Webhook domain category' },
  { category: 'feature_flag_scope', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Feature flag scope ladder' },
  { category: 'geocoding_attempt_type', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Geocoding attempt type' },
  { category: 'http_method', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'HTTP method' },
  { category: 'job_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Job status' },
  { category: 'lookup_value_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Lookup value status' },
  { category: 'mapping_domain', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Mapping domain' },
  { category: 'message_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Message delivery status' },
  { category: 'preferred_language', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Recipient preferred language' },
  { category: 'phone_validation_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Phone validation state' },
  { category: 'processing_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Webhook processing status' },
  { category: 'provider_auth_type', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Provider authentication type' },
  { category: 'provider_health', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Provider health status (provider_health_logs.status) with operator-facing tone metadata.' },
  { category: 'provider_type', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Provider type' },
  { category: 'rate_limit_window', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Rate limit window unit' },
  { category: 'request_entry_point', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow entry point' },
  { category: 'sender_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Sender lifecycle status' },
  { category: 'settings_audit_action', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Settings audit log action' },
  { category: 'sla_tier', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Client SLA tier' },
  { category: 'task_action_kind', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Task action kind registry (label/icon/tone/next_status) consumed by review-queue describeAction + nextStatusForAction.' },
  { category: 'task_review_queue_filter', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Review-queue filter chip catalogue (mine/queue/all/breach/snoozed) consumed by workflows/review-queue.tsx FILTERS derivation. Replaces inline TS-literal array per AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).' },
  { category: 'urgency_level', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Message urgency level' },
  { category: 'user_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'User lifecycle status' },
  { category: 'user_type', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'User type / platform role' },
  { category: 'workflow_run_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow run status' },
  { category: 'workflow_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow template status' },
  { category: 'workflow_step_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow run step status' },
  { category: 'workflow_binding_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow binding configurability status (active/paused/disabled).' },
  { category: 'workflow_transition', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow step transition condition' },
  // W27 Cycle D closure — canonical lookup_definitions paired with the
  // W27 workflows option-list / tone-branch closure (consumed by
  // `modules/workflows/templates.tsx` + `modules/workflows/bindings.tsx`).
  // Backend mirror in paired migration (lookup_definitions seed).
  { category: 'workflow_binding_event', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow binding event taxonomy (canonical event names that can drive a binding) consumed by workflows/templates.tsx TriggerComposer + NewTemplate event pickers.' },
  { category: 'workflow_expression_scope', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow template-step expression scope taxonomy (trigger/run/context/vars) with metadata.variables[] enumerating variable identifiers per scope; consumed by workflows/templates.tsx InputsTab "Available variables" tree.' },
  { category: 'workflow_binding_dispatch_outcome', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow binding dispatch ledger outcome taxonomy (started/completed/waiting/failed) consumed by workflows/bindings.tsx Dispatches tab tone resolution.' },
  { category: 'workflow_step_kind', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow template step kind taxonomy (trigger/transform/guard/action/error/manual) consumed by workflows/templates.tsx step chips.' },
  { category: 'workflow_trigger_scope_type', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow run/schedule trigger scope_type taxonomy (tenant/client/sender) consumed by workflows/runs.tsx Triggers + Schedules sub-tabs.' },
  // Cycle E2 (Workflows P1 #1 + #2) — workflow_branch_kind canonical
  // taxonomy. Replaces inline `branchLanes` Record + `'on error'` /
  // `'manual'` literal labels + lane-2 keyboard-nav filter in
  // workflows/templates.tsx.
  { category: 'workflow_branch_kind', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow template step branch taxonomy (main/error/manual) with metadata.lane_index for canvas vertical positioning, metadata.label for edge labelling, and metadata.is_keyboard_secondary for keyboard-nav lane collapsing.' },
  // Cycle E2 (Workflows P1 #3) — workflow_schedule_type canonical
  // taxonomy. Replaces inline interval/daily/weekly switch in
  // workflows/runs.tsx#scheduleSummary.
  { category: 'workflow_schedule_type', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow schedule trigger type taxonomy (interval/daily/weekly/cron) with metadata.summary_template + metadata.thresholds (interval bucketing constants) consumed by workflows/runs.tsx scheduleSummary.' },
  // Cycle E2 (Workflows P1 #10) — workflow_step_action canonical
  // taxonomy. Replaces inline 6-item palette array in
  // workflows/templates.tsx#openStepActions.
  { category: 'workflow_step_action', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Workflow step actions taxonomy (duplicate/delete/convert_error/pin_sample/view_runs/decision_trail) with metadata.section + metadata.handler_kind consumed by workflows/templates.tsx#openStepActions palette.' },
  // Cycle E2 (Workflows P2 #11) — condition_operator_by_type matrix.
  // Replaces inline operator arrays per FieldType in
  // workflows/_bindings/condition-model.ts#operatorsFor.
  { category: 'condition_operator_by_type', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Condition operator allowlist per inferred FieldType (string/number/boolean/unknown × operator) consumed by workflows/_bindings/condition-model.ts#operatorsFor.' },
  // W43 canonical lookup_definitions for approval_policy + owner_role
  // (supabase/migrations/202605020100_w43_console_v2_canonical_seeds.sql lines 412-417).
  { category: 'approval_policy', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Approval tier taxonomy used by lookup governance (tier_1=light, tier_2=standard, tier_3=high-risk).' },
  { category: 'owner_role', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Lookup ownership taxonomy (which team is accountable for changes to a given lookup category).' },
  // W50 canonical lookup_definitions paired with the W50 backend migration
  // (supabase/migrations/202605020800_w50_console_v2_status_filter_lookup_seeds.sql).
  { category: 'mobile_attestation_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Mobile device attestation lifecycle (trusted/pending/failed/revoked).' },
  { category: 'label_render_job_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Label render job pipeline state (queued/rendering/completed/failed).' },
  { category: 'label_type', owner_role: 'operations', approval_policy: 'tier_2', is_mutable: true, description: 'Label design and label_jobs target taxonomy consumed by Console V2 label design publishing.' },
  { category: 'label_reprint_reason', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Label reprint reason taxonomy consumed by Console V2 label reprint flows.' },
  { category: 'kpi_group', owner_role: 'product', approval_policy: 'tier_1', is_mutable: false, description: 'KPI grouping taxonomy mirroring kpi_definitions.definition.group (operations/marketplace/integrations/workflows).' },
  // W54-D canonical lookup_definitions paired with the W54-D platform +
  // insights option-list / tone-branch closure.
  { category: 'alert_severity', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Alert rule severity ladder (info/warn/critical) consumed by platform/alerts.tsx.' },
  { category: 'alert_channel', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Alert delivery channel taxonomy (slack/email/pagerduty/webhook) consumed by platform/alerts.tsx.' },
  { category: 'priority', owner_role: 'product', approval_policy: 'tier_1', is_mutable: false, description: 'Generic priority ladder (p0/p1/p2/p3) consumed by platform/planning-os.tsx project items.' },
  { category: 'api_status_class', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'HTTP status class taxonomy (2xx/3xx/4xx/5xx) consumed by insights/api-gateway.tsx tone resolution.' },
  // W54-C canonical lookup_definitions paired with the W54-C operate fleet +
  // tracking surfaces option-list / tone-branch closure.
  { category: 'driver_compliance_event_type', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Driver compliance event type taxonomy with metadata.label_template templates consumed by operate/fleet/drivers.tsx CreateComplianceEventBody + describeEvent.' },
  { category: 'driver_suspend_reason', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Driver suspension reason taxonomy consumed by operate/fleet/drivers.tsx BulkSuspendBody.' },
  { category: 'driver_document_rejection_reason', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Driver document rejection reason taxonomy consumed by operate/fleet/drivers.tsx RejectDocumentBody.' },
  { category: 'vehicle_maintenance_reason', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Vehicle maintenance kind taxonomy consumed by operate/fleet/vehicles.tsx ScheduleMaintenanceForm.' },
  { category: 'maintenance_cancel_reason', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Maintenance window cancellation reason taxonomy consumed by operate/fleet/vehicles.tsx Cancel action.' },
  { category: 'marketplace_participant_review_reason', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Marketplace participant request review reason taxonomy (approve/reject metadata.decision split) consumed by operate/fleet/driver-applications.tsx review actions.' },
  { category: 'driver_application_doc_kind', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Driver application document kind taxonomy consumed by operate/fleet/driver-applications.tsx RequestDocsModalBody.' },
  { category: 'marketplace_participant_application_doc_kind', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Non-driver marketplace participant application document kind taxonomy consumed by network/participant-applications.tsx request-docs review action.' },
  { category: 'ndr_branch_next_action', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'NDR branch next-action taxonomy projected by resolve_ndr_branch_next_action_v1; consumed by operate/exceptions.tsx + operate/returned-to-branch.tsx tone resolution.' },
  { category: 'pickup_request_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Pickup request lifecycle status (api.pickup_requests_list_v1 projection) consumed by operate/pickups.tsx requests tab.' },
  { category: 'pickup_wave_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Pickup wave lifecycle status (api.pickup_waves_list_v1 projection) consumed by operate/pickups.tsx waves tab.' },
  { category: 'pickup_failure_reason', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Pickup failure reason taxonomy (api.pickup_failures_list_v1 projection) consumed by operate/pickups.tsx failures tab.' },
  // Console V2 basket policy lifecycle closure: paired definitions for the
  // operations basket seed and backend lookup catalog used by the basket
  // policy editor. The frontend imports values from seed-raw/baskets.js; the
  // backend mirror is 202605052010_console_v2_basket_policy_lookup_options_v1.
  { category: 'basket_state', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: true, description: 'Basket lifecycle state taxonomy consumed by operate/baskets.tsx row chips and drawer summaries.' },
  { category: 'basket_type', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: true, description: 'Basket type taxonomy consumed by operate/baskets.tsx and basket policy configuration.' },
  { category: 'basket_policy_service_match_field', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: true, description: 'Service discriminator fields allowed by basket_policy grouping and consumed by operate/baskets.tsx policy editor.' },
  { category: 'basket_policy_route_key_path', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: true, description: 'Route discriminator paths allowed by basket_policy grouping and consumed by operate/baskets.tsx policy editor.' },
  // W27 Cycle D canonical lookup_definitions paired with the W27 Cycle D
  // operate option-list / tone-branch closure (route assignment + stop SLA).
  { category: 'route_run_assignment_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Route run assignment lifecycle (route_run_assignments.assignment_status projection) consumed by operate/dispatch.tsx insight-card tone resolution.' },
  // W59 Cycle E2 closure (P2-1) — paired definition for the route_assignment_mode
  // taxonomy seeded above. Mirrors the lookup_definitions row in
  // supabase/migrations/202604061430_uc076_route_run_assignment_lifecycle_foundation_v1.sql:17-21
  // (owner_role=dispatch, approval_policy=tier_1, is_mutable=TRUE).
  { category: 'route_assignment_mode', owner_role: 'dispatch', approval_policy: 'tier_1', is_mutable: true, description: 'Route assignment ownership mode taxonomy (internal_driver/partner_fleet/alternate_capacity_pool) consumed by registry.js route_run_assignments + route_run_assignment_events column lookups.' },
  { category: 'stop_sla_tone', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Route plan stop SLA tone projection (on-time/at-risk/breached) consumed by operate/route-plans.tsx stop list tone resolution.' },
  // W27 Cycle D Network closure: visual band taxonomy paired with the
  // canonical `branch_zones.priority` projection (no canonical `role`
  // column on the table). Replaces prior misuse of `branch_role` as a
  // chip category for band rendering in branches.tsx + zones-drawer.tsx.
  { category: 'branch_zone_band', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Visual branch-zone band taxonomy (primary/secondary/fallback) projected from canonical branch_zones.priority. Threshold lives in settings policy `branch_zone_band_priority_threshold`.' },
  // W27 Cycle D Platform+Insights closure: canonical lookup_definitions
  // paired with the W27 Cycle D Platform + Insights option-list / tone-branch
  // closure (auth-email audit chip + traces event-source chip).
  { category: 'email_auth_audit_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'auth-email-url-policy audit traffic-light taxonomy (green/yellow/red) consumed by platform/auth-email.tsx audit chip tone resolution.' },
  { category: 'trace_event_source', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'observability_events.event_source classifier (decision_log/audit_log/error_log/system_log/api_call_log) consumed by insights/traces.tsx timeline chip tone resolution.' },
  { category: 'chip_tone', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Canonical chip tone taxonomy mirroring src/components/Chip.tsx ChipKind literal (neutral/info/good/warn/danger/ink). Drives the catalog/lookups editor Tone select; default tone resolves via the is_default flag (no inline literal).' },
  // W-Cycle-E canonical lookup_definitions paired with the W-Cycle-E
  // integrations option-list / tone-branch / lifecycle-CTA closure.
  { category: 'trace_step_failure_class', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Webhook trace step failure-class taxonomy (parse_error/verify_error/mapping_error/validate_error/downstream_error). metadata.http_status maps each class to its HTTP code projection consumed by webhook-tester.tsx#deriveResponseStatus when the trace emitter populates failure_class.' },
  { category: 'webhook_forced_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Webhook tester force-status options. metadata.target_status maps HTTP status choices to processing_status.' },
  { category: 'plugin_studio_source_type', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Integrations plugin-studio source-type taxonomy (curl/openapi/webhook_sample/manual). metadata.sample carries the canonical sample payload string for each source type. Replaces inline SOURCE_TYPES + SAMPLE_BY_SOURCE constants in plugin-studio.tsx.' },
  { category: 'plugin_studio_plugin_kind', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Integrations plugin-studio plugin-kind taxonomy (api outbound / webhook inbound) consumed by the studio kind selector. Default selection resolves via the is_default flag — no inline literal-union or "api" default in plugin-studio.tsx. Distinct from the integration_plugin_kind carrier/marketplace/crm domain enum.' },
  { category: 'webhook_source_state', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Webhook source operational state taxonomy (enabled/disabled/throttled/down) with canonical tone metadata. Consumed by integrations/intake.tsx ProvenanceDrawer source chip tone.' },
  { category: 'webhook_sample_payload', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Canonical sample webhook payloads for the integrations/webhook-tester. Each row carries metadata.payload with a JSON envelope. The default row seeds the tester textarea.' },
  // W-Cycle-E canonical lookup_definitions paired with the platform+insights
  // strict-isolation closure (no-fallback campaign — P2 #5/#9/#10/#11).
  { category: 'validation_issue_severity', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Shared condition-builder validation Issue.severity taxonomy (error/warn) consumed by platform/alerts.tsx + workflows/bindings.tsx condition editor chip tones.' },
  { category: 'trace_event_status', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'observability_events.status canonical chip + timeline-bar palette consumed by insights/traces.tsx ObservabilityRow. metadata.bar_var projects the canonical CSS variable for the SVG bar fill so chip + bar stay synchronized.' },
  { category: 'kpi_format', owner_role: 'product', approval_policy: 'tier_1', is_mutable: false, description: 'kpi_definitions.format formatting taxonomy with metadata.suffix + metadata.decimals consumed by insights/reporting.tsx renderKpiValue (replaces the inline format-switch block).' },
  { category: 'manifest_kind', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'label_jobs.renderer_metadata.manifest_kind taxonomy with metadata.target_type projection (consumed by platform/labels.tsx#targetTypeOf to replace the inline kind→target_type ternary).' },
  // W-Cycle-E2 (P1 #4) — canonical lookup_definition for the time-range
  // chip taxonomy used across insights surfaces (replaces inline RANGE_OPTIONS
  // literal cluster + magic ms multipliers in _shared.ts).
  { category: 'time_range_options', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Insights time-range chip taxonomy (5m/1h/24h/7d/all) with metadata.window_ms projecting the canonical millisecond window (null for the all sentinel) consumed by modules/insights/_shared.ts.' },
  // W69 Cycle F-R-9 closure (Integrations) — canonical lookup_definitions
  // paired with the four new W69 categories above. Replaces inline
  // label/tone literals in integrations/{sources,rules,mapping,intake}.tsx.
  { category: 'enabled_state', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Generic enabled/disabled lifecycle taxonomy with canonical tone metadata. Consumed by integrations/sources.tsx + integrations/rules.tsx EnabledChip (webhook source + routing rule toggle state). Distinct from workflow_binding_enabled_state / workflow_schedule_enabled_state which carry domain-specific off-state semantics.' },
  { category: 'webhook_source_health', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Webhook source health-state taxonomy (healthy/degraded/idle) with operator-facing tone metadata. Projection logic (is_healthy + error_count_24h derived from v_webhook_source_directory) maps to canonical state; LABEL+TONE route through this lookup. Consumed by integrations/sources.tsx drawer KvRow + DataTable Healthy column.' },
  { category: 'mapping_usage_state', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Mapping config usage-state taxonomy (in_use/unused) projecting v_mapping_config_directory.is_in_use onto canonical tone. Consumed by integrations/mapping.tsx drawer KvRow Status.' },
  { category: 'provenance_shipment_state', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Webhook inbox provenance shipment-match taxonomy (matched/unmatched). Projects (prov.shipment_id ?? null) onto canonical tone. Consumed by integrations/intake.tsx ProvenanceDrawerBody chain shipment chip.' },
  // W70-Finance Cycle F-R-10 closure (P1-2): canonical lookup_definition for
  // the bank_recon_match_status taxonomy seeded above. Replaces inline
  // `m.status === 'matched'` literal in modules/finance/bank-recon.tsx.
  { category: 'bank_recon_match_status', owner_role: 'operations', approval_policy: 'tier_1', is_mutable: false, description: 'Bank reconciliation match status taxonomy (matched/unmatched/ambiguous) with metadata.is_active flag consumed by modules/finance/bank-recon.tsx#openUnmatchPicker active-match filter. Replaces inline status-literal compare per AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).' },
  { category: 'finance_direction', owner_role: 'finance', approval_policy: 'tier_1', is_mutable: true, description: 'Direction relative to the account for finance_events ledger and bank statement ingestion. Mirrors 202601212830_finance_events_ledger_foundation.sql and is consumed by modules/finance/bank-recon.tsx ingestion form.' },
  // W74 Cycle F-R-14 closure (P1-7): canonical lookup_definition for the
  // decision_verdict taxonomy seeded above. Replaces the inline
  // `v === 'allowed' || v === 'pass' || v === 'matched'` triple-OR ternary
  // in components/decisionTrail.tsx#verdictKind.
  { category: 'decision_verdict', owner_role: 'engineering', approval_policy: 'tier_1', is_mutable: false, description: 'Decision verdict taxonomy (allowed/pass/matched/denied/fail/unmatched) with canonical tone metadata + metadata.is_positive flag. Consumed by components/decisionTrail.tsx#verdictKind for chip tone resolution. Replaces inline triple-OR ternary per AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).' },
];

// W56-B (F1) — Snapshot of the base lookup category keys defined here in
// lookups.js. Per-feature seed files (network-branches.js, network-zones.js,
// support.js, finance-billing.js, network-marketplace.js, fleet-vehicles.js,
// platform-alerts.js, etc.) extend `lookups` via `Object.assign(lookups, …)`
// at import time; that pattern is the canonical SSOT for domain-owned
// categories. The runtime guard below + a paired vitest assert that an
// extension never SILENTLY OVERRIDES a category already declared here, which
// is what produced the long tail of divergent tones / values closed in W56-B.
//
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): a category should be declared
// in EXACTLY ONE place. New domain-owned categories should live in the
// per-feature seed; cross-cutting / lifecycle categories live here.
lookups.hours_of_service_duty_status = lookups.duty_status;
export const BASE_LOOKUP_CATEGORIES = Object.freeze(Object.keys(lookups));

// Runtime guard — call this before extending `lookups` to fail loud if the
// extension would shadow an already-defined category. Use in production seed
// files via `assertNoLookupCollision(extension); Object.assign(lookups, extension);`
// (the dual-step form is necessary because `Object.assign` itself silently
// overrides — that's the bug class this guard closes).
//
// Usage example:
//   import { lookups, assertNoLookupCollision } from './lookups.js';
//   const ext = { my_new_category: [...] };
//   assertNoLookupCollision(ext, 'my-feature.js');
//   Object.assign(lookups, ext);
export function assertNoLookupCollision(extension, sourceFile) {
  if (!extension || typeof extension !== 'object') {
    throw new TypeError(`assertNoLookupCollision: extension must be an object, got ${typeof extension}`);
  }
  const collisions = [];
  for (const key of Object.keys(extension)) {
    if (Object.prototype.hasOwnProperty.call(lookups, key)) {
      collisions.push(key);
    }
  }
  if (collisions.length > 0) {
    const where = sourceFile ? ` (in ${sourceFile})` : '';
    throw new Error(
      `Lookup collision${where}: categor${collisions.length === 1 ? 'y' : 'ies'} `
      + `[${collisions.join(', ')}] already declared in lookups.js. `
      + `Either remove from lookups.js (per-feature owns the SSOT) or remove from `
      + `the extension. Silent overrides are the bug class W56-B closed.`,
    );
  }
}

// Strict lookup row resolver. Returns the canonical row or null when the
// (category, value) pair is not seeded. NO silent fallback — callers
// decide how to surface missing canonical metadata (typically a
// "danger"-toned chip with the missing key as label so the operator sees
// the gap rather than a neutral-toned silent default).
//
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): this is the only
// FE-side seam that maps a domain enum value to its presentation tone /
// label. Every module that previously declared an inline `*_TONE` or
// `*_LABEL` Record now delegates to this resolver.
export function lookupRow(category, value) {
  const list = lookups[category];
  if (!list) return null;
  return list.find((r) => r.value === value) ?? null;
}

// Convenience wrappers — both return null on missing so callers can
// render an explicit error chip (`<Chip kind="danger" label={...} />`)
// instead of silently masking the gap with a neutral default.
export function statusTone(category, value) {
  return lookupRow(category, value)?.tone ?? null;
}

export function statusLabel(category, value) {
  return lookupRow(category, value)?.label ?? null;
}

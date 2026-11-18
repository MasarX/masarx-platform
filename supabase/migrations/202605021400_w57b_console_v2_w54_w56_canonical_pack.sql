-- Spec-Issue: W57-B console-v2 W34c -> W56-E backend canonical pack
-- Step: W57-B-CANONICAL-SEEDS
-- Migration: Backend SSOT mirror for the FE seed extensions added across the
--   W34c -> W56-E wave arc (apps/console-v2/src/lib/seed-raw/lookups.js +
--   per-feature lookup-extension files + apps/console-v2/src/lib/seed-raw/policies.js).
--
-- Companion to:
--   - 202605020100_w43_console_v2_canonical_seeds.sql              (W43)
--   - 202605020800_w50_console_v2_status_filter_lookup_seeds.sql   (W50)
--   - 202605020900_w51_service_levels_metadata_tone.sql            (W51)
--   - 202605021000_w52_tenant_default_timezone_policy.sql          (W52)
--   - 202605021100_w52_ui_presentation_policy_task_snooze_options.sql (W52)
--   - 202605021200_w53_console_v2_strict_canonical_metadata_pack.sql (W53)
--   - 202605021300_w57a_planning_os_config_seed.sql                (W57-A)
--
-- Coverage map (FE wave -> categories landed in this pack):
--   * Core lookups.js (categories never seeded by earlier packs):
--       - api_status_class           (W11 / FE chip palette for HTTP class)
--       - email_auth_audit_status    (W11 / auth-email policy traffic-light)
--       - trace_event_source         (W11 / observability_events.event_source)
--       - workflow_binding_dispatch_outcome (W11-6 / CLAIM-WORKFLOWS)
--       - workflow_trigger_scope_type (W11-6)
--       - dispute_kind               (W26 / marketplace_disputes)
--       - dispute_resolution         (W26)
--       - finance_event_type         (W26)
--       - settlement_kind            (W26)
--       - cod_entry_status           (W26)
--       - settlement_status          (W26)
--       - route_plan_status          (W34c)
--       - driver_compliance_severity (FLEET Wave 5)
--       - driver_document_kind       (FLEET Wave 5)
--       - plugin_status              (W26 / integration plugins)
--   * support.js extensions (W34c):
--       - support_message_direction
--       - support_message_role
--   * network-branches.js extensions (W34c):
--       - branch_type
--       - branch_status
--       - branch_zone_role
--       - branch_member_role
--   * network-zones.js extensions (W34c):
--       - zone_status
--       - zone_district_role
--       - zone_override_status
--       - zone_override_kind
--       - zone_color_token
--   * network-marketplace.js extensions (W34c):
--       - marketplace_offer_status
--       - marketplace_award_status
--       - marketplace_contract_status
--       - marketplace_request_status
--       - marketplace_request_kind
--   * platform-alerts.js extensions (W34c, W27-cycle-D):
--       - alert_severity
--       - alert_channel
--       - alert_trigger_status
--       - ops_alert_status
--   * platform-flags.js extensions (W34c):
--       - feature_flag_status
--       - feature_flag_scope
--   * fleet-vehicles.js extensions (W35b, FLEET Wave 5):
--       - vehicle_status
--       - vehicle_kind
--       - vehicle_fuel_type
--       - vehicle_event_type
--       - vehicle_maintenance_kind
--       - vehicle_maintenance_window_status
--   * finance-billing.js extensions (W26):
--       - invoice_status
--       - invoice_event_type
--       - subscription_status
--       - agreement_status
--       - agreement_term_kind
--       - usage_event_kind
--   * insights-apigw.js extensions (W34c):
--       - api_method
--       - provider_health_status
--   * imports.js extensions (W16-5):
--       - import_job_status
--       - import_job_source
--       - import_job_kind
--   * driver-applications.js extensions (W34c):
--       - driver_application_status
--       - driver_application_doc_status
--   * identity-sessions.js extensions (W34c):
--       - session_aal
--   * catalog-offerings.js extensions (W51):
--       - service_offering_status
--       - service_level_tier
--   * Settings policies new in W54+W55+W27-cycle-D:
--       - provider_credential_policy        (W54-B)
--       - api_gateway_thresholds            (W27-cycle-D)
--       - delivery_slot_policy              (W54-C)
--       - geocoding_policy                  (W55-Network)
--
-- AGENTS.md objectives honored:
--   §1 (SCALABLE/DYNAMIC):  zero hardcoded UUIDs; all rows resolve via
--                           VALUES + WHERE-NOT-EXISTS / ON-CONFLICT clauses.
--   §2 (ZERO REDUNDANCY):   reuses canonical lookup_definitions, lookup_values,
--                           settings_category_registry, schema_registry,
--                           settings_versions, settings; introduces zero new
--                           tables, zero new RPCs.
--   §3 (ROW-DRIVEN / SSOT): FE categories now have canonical DB rows; FE
--                           strict no-fallback guards never fire in production
--                           once these rows exist for the active scope.
--   §5 (APPEND-ONLY):       new timestamped fixup migration; no edits to
--                           historical migration files; ON CONFLICT clauses
--                           keep this safe to re-run alongside earlier
--                           per-category packs that may also seed the same
--                           rows (e.g. W43 partial overlap on a subset of
--                           support/network categories).
--   §6 (RLS POSTURE):       touches only existing tables that already have
--                           correct RLS + service-role policies; no new
--                           objects.
--   §10 (NO WORKAROUNDS):   no flag-driven seeds, no temporary categories,
--                           no shadow tables; the rows written here are the
--                           canonical SSOT.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605021400_w57b_console_v2_w54_w56_canonical_pack'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

-- =============================================================================
-- SECTION 1: lookup_definitions (idempotent register for every new category)
-- =============================================================================
-- Pattern mirrors W43 (202605020100_w43_console_v2_canonical_seeds.sql:401-427)
-- and W50 (202605020800_w50_console_v2_status_filter_lookup_seeds.sql:32-52):
-- system-seed lookups live at scope_type='global' with organization_id=NULL.

INSERT INTO public.lookup_definitions (
  category, description, owner_role, approval_policy, is_mutable,
  organization_id, scope_type
)
VALUES
  -- ---- Core lookups.js ----
  ('api_status_class',
   'HTTP response status class for api_call_log chip rendering (2xx/3xx/4xx/5xx). FE consumer: insights/api-gateway FilterBar + drawer.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('email_auth_audit_status',
   'auth-email-url-policy audit traffic-light status (green/yellow/red). FE consumer: platform/auth-email audit chip.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('trace_event_source',
   'observability_events.event_source classifier consumed by ui_get_trace_v1 and rendered as a tone-coded chip on insights/traces timeline rows.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('workflow_binding_dispatch_outcome',
   'workflow_binding_dispatches.outcome canonical taxonomy (started/completed/waiting/failed). Mirrors the canonical CHECK constraint in 202603091331_workflow_binding_policy_substrate_v1.sql:261-263.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('workflow_trigger_scope_type',
   'Scope type taxonomy for workflow_run_triggers + workflow_schedule_triggers (tenant/client/sender). FE chip on workflows/triggers surfaces.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('dispute_kind',
   'marketplace_disputes.kind canonical taxonomy (commercial/execution/other). Mirrors marketplace_table_contracts_reconcile_v1 (202603091191).',
   'finance', 'tier_2', FALSE, NULL, 'global'),
  ('dispute_resolution',
   'marketplace_dispute_resolution_v1 input enum (credit/reject/partial). FE chip + drawer.',
   'finance', 'tier_2', FALSE, NULL, 'global'),
  ('finance_event_type',
   'finance_events_ledger.event_type canonical taxonomy (charge/refund/fee/tax/cod_collected/cod_handover/deposit/payout/adjustment/bank_statement). Mirrors 202601212830 lookup contract.',
   'finance', 'tier_1', FALSE, NULL, 'global'),
  ('settlement_kind',
   'settlement_batches.kind canonical taxonomy (cod/billing/payout). FE chip on finance/settlements.',
   'finance', 'tier_1', FALSE, NULL, 'global'),
  ('cod_entry_status',
   'cod_entries.status projection over delivery_completion.payment_collection canonical truth (pending/collected/shortfall/remitted/handed_over).',
   'finance', 'tier_2', FALSE, NULL, 'global'),
  ('settlement_status',
   'settlement_batches.status canonical taxonomy (open/locked/approved/posted/canceled). FE chip on finance/settlements.',
   'finance', 'tier_1', FALSE, NULL, 'global'),
  ('route_plan_status',
   'route_plans.status canonical lifecycle (draft/solved/frozen/published/applied/executing/archived). FE chip on operate/route-plans.',
   'operations', 'tier_1', FALSE, NULL, 'global'),
  ('driver_compliance_severity',
   'driver_compliance_events derived severity bucket (info/warn/critical) consumed by FE chip palette on fleet/drivers compliance drawer.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('driver_document_kind',
   'driver_documents.doc_type canonical taxonomy (license/insurance/medical/permit). Mirrors 202601311230_enterprise_ops_v1.sql:391.',
   'operations', 'tier_1', FALSE, NULL, 'global'),
  ('plugin_status',
   'integration_plugins.status canonical lifecycle (active/pending/degraded/rollback/disabled). FE chip on integrations/plugins.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),

  -- ---- support.js extensions ----
  ('support_message_direction',
   'support_messages.direction taxonomy (inbound/outbound/internal). Mirrors 202601311720_support_cases_foundation_v1.sql:83-89.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('support_message_role',
   'Author role helper derived from support_messages direction + actor (operator/customer/system). Drives MessageThread bubble alignment + tone.',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- network-branches.js extensions ----
  ('branch_type',
   'branches.type canonical taxonomy (hub/depot/branch/dropoff_point). FE chip on network/branches DataTable.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('branch_status',
   'branches.status canonical lifecycle (active/reduced/out_of_service/planned). FE chip on network/branches DataTable.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('branch_zone_role',
   'branch_zones.role canonical taxonomy (primary/secondary/fallback). FE chip on network/branches detail drawer.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('branch_member_role',
   'branch_memberships.role canonical taxonomy (manager/ops_lead/cashier/sorter/dispatcher/security). FE chip on network/branches members tab.',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- network-zones.js extensions ----
  ('zone_status',
   'zones.status canonical lifecycle (active/draft/suspended/retired). FE chip on network/zones DataTable.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('zone_district_role',
   'zone_districts.role canonical taxonomy (primary/secondary). FE chip on network/zones detail drawer.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('zone_override_status',
   'zone_override_requests.status canonical lifecycle (pending/approved/denied). FE chip on network/zones override tab.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('zone_override_kind',
   'zone_override_requests.kind canonical taxonomy (add_district/remove_district/reassign_role/rename/suspend_zone/restore_zone). FE chip on network/zones override tab.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('zone_color_token',
   'zones.color_token 6-token palette mirroring shared tone vocabulary (good/info/warn/danger/neutral). FE chip on network/zones map legend.',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- network-marketplace.js extensions ----
  ('marketplace_offer_status',
   'marketplace_offers.status canonical lifecycle (pending/shortlisted/awarded/rejected/expired/withdrawn). FE chip on network/marketplace.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('marketplace_award_status',
   'marketplace_awards.status canonical lifecycle (active/cancelled/completed). FE chip on network/marketplace.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('marketplace_contract_status',
   'marketplace_contracts.status canonical lifecycle (draft/active/expiring_soon/expired/terminated). FE chip on network/marketplace.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('marketplace_request_status',
   'marketplace_requests.status canonical lifecycle (open/in_review/awarded/closed/cancelled). FE chip on network/marketplace.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('marketplace_request_kind',
   'marketplace_requests.kind canonical taxonomy (same_day_capacity/refrigerated/hazmat/bulk_freight/return_pickup). FE chip on network/marketplace.',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- platform-alerts.js extensions ----
  ('alert_severity',
   'alert_rules.severity canonical taxonomy (info/warn/critical). FE chip on platform/alerts.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('alert_channel',
   'alert_rules.channel canonical taxonomy (slack/email/pagerduty/webhook). FE chip on platform/alerts.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('alert_trigger_status',
   'alert_triggers.status canonical lifecycle (fired/acknowledged/resolved/silenced). W27-cycle-D §4 — fired must read as danger until acknowledged.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('ops_alert_status',
   'ops_alerts.status canonical lifecycle (open/acknowledged/resolved). FE chip on operate dashboards.',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- platform-flags.js extensions ----
  ('feature_flag_status',
   'feature_flags.status canonical taxonomy (on/off/percentage). FE chip on platform/feature-flags DataTable.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('feature_flag_scope',
   'feature_flags.scope canonical ladder (global/tenant/client/sender). Mirrors scope_type_registry ladder ranks. FE chip on platform/feature-flags.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),

  -- ---- fleet-vehicles.js extensions ----
  ('vehicle_status',
   'vehicles.status canonical lifecycle (in_service/on_shift/in_maintenance/oos/reserve). W35b alignment — canonical lookup is `oos` not `out_of_service`.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('vehicle_kind',
   'vehicles.kind canonical taxonomy (van/box_truck/refrigerated/car/motorbike/pickup). FE chip on fleet/vehicles.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('vehicle_fuel_type',
   'vehicles.fuel_type canonical taxonomy (diesel/gasoline/electric/hybrid). FE chip on fleet/vehicles.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('vehicle_event_type',
   'vehicle_events.event_type canonical taxonomy (odometer/fuel/maintenance/incident). FLEET Wave 5 RE-AUDIT D4 alignment per 202601311230_enterprise_ops_v1.sql:240-251.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('vehicle_maintenance_kind',
   'vehicle_maintenance_windows.kind canonical taxonomy (preventive/oil_change/tire_rotation/brake_service/inspection/major_repair).',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('vehicle_maintenance_window_status',
   'vehicle_maintenance_windows.status canonical lifecycle (planned/in_progress/completed/cancelled).',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- finance-billing.js extensions ----
  ('invoice_status',
   'billing_invoices.status canonical lifecycle (draft/sent/paid/overdue/voided/refunded). FE chip on finance/billing DataTable.',
   'finance', 'tier_1', FALSE, NULL, 'global'),
  ('invoice_event_type',
   'billing_invoice_events.event_type canonical taxonomy (drafted/sent/paid/refunded/voided/reissued). FE timeline on finance/billing.',
   'finance', 'tier_1', FALSE, NULL, 'global'),
  ('subscription_status',
   'subscriptions.status canonical lifecycle (active/paused/ended/pending). FE chip on finance/subscriptions.',
   'finance', 'tier_1', FALSE, NULL, 'global'),
  ('agreement_status',
   'commercial_agreements.status canonical lifecycle (active/expired/pending/terminated). FE chip on finance/agreements.',
   'finance', 'tier_1', FALSE, NULL, 'global'),
  ('agreement_term_kind',
   'commercial_agreement_terms.kind canonical taxonomy (price_per_shipment/monthly_minimum/sla_pct/cod_handover_window/fuel_surcharge/volume_tier/payment_terms_days/late_fee_pct).',
   'finance', 'tier_2', FALSE, NULL, 'global'),
  ('usage_event_kind',
   'usage_events.kind canonical taxonomy (shipment_delivered/shipment_pickup/cod_handover/rto_processed/extra_attempt/storage_day/subscription_fee).',
   'finance', 'tier_2', FALSE, NULL, 'global'),

  -- ---- insights-apigw.js extensions ----
  ('api_method',
   'api_routes.method canonical taxonomy (GET/POST/PUT/PATCH/DELETE). FE chip on insights/api-gateway DataTable.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),
  ('provider_health_status',
   'provider_health_metrics.status canonical taxonomy (healthy/degraded/critical/unknown). FE chip on integrations/health.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),

  -- ---- imports.js extensions ----
  ('import_job_status',
   'import_jobs.status canonical lifecycle (queued/running/completed/failed/cancelled). Mirrors 202604301900_import_jobs.sql.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('import_job_source',
   'import_jobs.source canonical taxonomy (file_upload/api/manual). FE chip on platform/imports.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('import_job_kind',
   'import_jobs.kind canonical taxonomy (shipments/clients/senders/recipients). FE chip on platform/imports.',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- driver-applications.js extensions ----
  ('driver_application_status',
   'marketplace_participant_requests.status canonical lifecycle for driver applications (pending/approved/rejected/withdrawn). Withdrawn = applicant rescinded; terminal informational.',
   'operations', 'tier_2', FALSE, NULL, 'global'),
  ('driver_application_doc_status',
   'marketplace_verification_records.status canonical taxonomy for per-document attestation (submitted/approved/rejected/expired/missing). Mirrors 202603071100_marketplace_network_foundation_v1.sql:672 CHECK.',
   'operations', 'tier_2', FALSE, NULL, 'global'),

  -- ---- identity-sessions.js extensions ----
  ('session_aal',
   'auth.sessions AAL (Authenticator Assurance Level) taxonomy (aal1/aal2/aal3). FE chip on identity/sessions.',
   'engineering', 'tier_1', FALSE, NULL, 'global'),

  -- ---- catalog-offerings.js extensions ----
  ('service_offering_status',
   'service_offerings.status canonical lifecycle (active/draft/archived). FE chip on catalog/service-offerings.',
   'product', 'tier_2', FALSE, NULL, 'global'),
  ('service_level_tier',
   'service_levels.tier canonical taxonomy (economy/standard/express/same_day/white_glove). W51 backfilled tone metadata; this row registers the lookup category for FE chip resolution.',
   'product', 'tier_2', FALSE, NULL, 'global')

ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

-- =============================================================================
-- SECTION 2: lookup_values (one INSERT per category, CROSS JOIN against
-- lookup_definitions so we never hardcode lookup_definition_id UUIDs).
-- =============================================================================
-- Pattern mirrors W43:467-670 + W50:60-126 — emit one INSERT per category for
-- scannability; ON CONFLICT (lookup_definition_id, value) DO UPDATE keeps
-- metadata.tone fresh on re-runs.

-- ---- api_status_class ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('2xx', '2xx', 10, FALSE, '{"tone":"good"}'),
  ('3xx', '3xx', 20, FALSE, '{"tone":"neutral"}'),
  ('4xx', '4xx', 30, FALSE, '{"tone":"warn"}'),
  ('5xx', '5xx', 40, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'api_status_class'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- email_auth_audit_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('green',  'Green',  10, FALSE, '{"tone":"good"}'),
  ('yellow', 'Yellow', 20, FALSE, '{"tone":"warn"}'),
  ('red',    'Red',    30, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'email_auth_audit_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- trace_event_source ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('decision_log', 'decision_log', 10, FALSE, '{"tone":"info"}'),
  ('audit_log',    'audit_log',    20, FALSE, '{"tone":"neutral"}'),
  ('error_log',    'error_log',    30, FALSE, '{"tone":"danger"}'),
  ('system_log',   'system_log',   40, FALSE, '{"tone":"neutral"}'),
  ('api_call_log', 'api_call_log', 50, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'trace_event_source'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- workflow_binding_dispatch_outcome ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('started',   'Started',   10, FALSE, '{"tone":"info"}'),
  ('completed', 'Completed', 20, FALSE, '{"tone":"good"}'),
  ('waiting',   'Waiting',   30, FALSE, '{"tone":"warn"}'),
  ('failed',    'Failed',    40, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'workflow_binding_dispatch_outcome'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- workflow_trigger_scope_type ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('tenant', 'Tenant', 10, FALSE, '{"tone":"info"}'),
  ('client', 'Client', 20, FALSE, '{"tone":"good"}'),
  ('sender', 'Sender', 30, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'workflow_trigger_scope_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- dispute_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('commercial', 'Commercial', 10, FALSE, '{}'),
  ('execution',  'Execution',  20, FALSE, '{}'),
  ('other',      'Other',      30, FALSE, '{}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'dispute_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- dispute_resolution ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('credit',  'Credit',          10, FALSE, '{}'),
  ('reject',  'Reject',          20, FALSE, '{}'),
  ('partial', 'Partial credit',  30, FALSE, '{}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'dispute_resolution'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- finance_event_type ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('charge',         'Charge',          10, FALSE, '{}'),
  ('refund',         'Refund',          20, FALSE, '{}'),
  ('fee',            'Fee',             30, FALSE, '{}'),
  ('tax',            'Tax',             40, FALSE, '{}'),
  ('cod_collected',  'COD Collected',   50, FALSE, '{}'),
  ('cod_handover',   'COD Handover',    60, FALSE, '{}'),
  ('deposit',        'Deposit',         70, FALSE, '{}'),
  ('payout',         'Payout',          80, FALSE, '{}'),
  ('adjustment',     'Adjustment',      90, FALSE, '{}'),
  ('bank_statement', 'Bank Statement', 100, FALSE, '{}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'finance_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- settlement_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('cod',     'COD',     10, FALSE, '{}'),
  ('billing', 'Billing', 20, FALSE, '{}'),
  ('payout',  'Payout',  30, FALSE, '{}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'settlement_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- cod_entry_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',     'Pending',      10, FALSE, '{"tone":"info"}'),
  ('collected',   'Collected',    20, FALSE, '{"tone":"good"}'),
  ('shortfall',   'Shortfall',    30, FALSE, '{"tone":"danger"}'),
  ('remitted',    'Remitted',     40, FALSE, '{"tone":"good"}'),
  ('handed_over', 'Handed over',  50, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'cod_entry_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- settlement_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('open',     'Open',     10, FALSE, '{"tone":"info"}'),
  ('locked',   'Locked',   20, FALSE, '{"tone":"info"}'),
  ('approved', 'Approved', 30, FALSE, '{"tone":"good"}'),
  ('posted',   'Posted',   40, FALSE, '{"tone":"good"}'),
  ('canceled', 'Canceled', 50, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'settlement_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- route_plan_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('draft',     'Draft',     10, FALSE, '{"tone":"neutral"}'),
  ('solved',    'Solved',    20, FALSE, '{"tone":"info"}'),
  ('frozen',    'Frozen',    30, FALSE, '{"tone":"info"}'),
  ('published', 'Published', 40, FALSE, '{"tone":"good"}'),
  ('applied',   'Applied',   50, FALSE, '{"tone":"good"}'),
  ('executing', 'Executing', 60, FALSE, '{"tone":"info"}'),
  ('archived',  'Archived',  70, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'route_plan_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- driver_compliance_severity ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('info',     'Info',     10, FALSE, '{"tone":"neutral"}'),
  ('warn',     'Warn',     20, FALSE, '{"tone":"warn"}'),
  ('critical', 'Critical', 30, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'driver_compliance_severity'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- driver_document_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('license',   'License',   10, FALSE, '{"tone":"info"}'),
  ('insurance', 'Insurance', 20, FALSE, '{"tone":"info"}'),
  ('medical',   'Medical',   30, FALSE, '{"tone":"info"}'),
  ('permit',    'Permit',    40, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'driver_document_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- plugin_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',   'Active',      10, FALSE, '{"tone":"good"}'),
  ('pending',  'Pending',     20, FALSE, '{"tone":"info"}'),
  ('degraded', 'Degraded',    30, FALSE, '{"tone":"warn"}'),
  ('rollback', 'Rolled back', 40, FALSE, '{"tone":"danger"}'),
  ('disabled', 'Disabled',    50, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'plugin_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- support_message_direction ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('inbound',  'Inbound',  10, FALSE, '{"tone":"neutral"}'),
  ('outbound', 'Outbound', 20, FALSE, '{"tone":"good"}'),
  ('internal', 'Internal', 30, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'support_message_direction'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- support_message_role ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('operator', 'Operator', 10, FALSE, '{"tone":"good"}'),
  ('customer', 'Customer', 20, FALSE, '{"tone":"neutral"}'),
  ('system',   'System',   30, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'support_message_role'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- branch_type ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('hub',           'Hub',       10, FALSE, '{"tone":"info"}'),
  ('depot',         'Depot',     20, FALSE, '{"tone":"neutral"}'),
  ('branch',        'Branch',    30, FALSE, '{"tone":"neutral"}'),
  ('dropoff_point', 'Drop-off',  40, FALSE, '{"tone":"good"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'branch_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- branch_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',         'Active',         10, TRUE,  '{"tone":"good"}'),
  ('reduced',        'Reduced ops',    20, FALSE, '{"tone":"warn"}'),
  ('out_of_service', 'Out of service', 30, FALSE, '{"tone":"danger"}'),
  ('planned',        'Planned',        40, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'branch_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- branch_zone_role ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('primary',   'Primary',   10, FALSE, '{"tone":"good"}'),
  ('secondary', 'Secondary', 20, FALSE, '{"tone":"info"}'),
  ('fallback',  'Fallback',  30, FALSE, '{"tone":"warn"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'branch_zone_role'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- branch_member_role ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('manager',    'Branch manager', 10, FALSE, '{"tone":"good"}'),
  ('ops_lead',   'Ops lead',       20, FALSE, '{"tone":"info"}'),
  ('cashier',    'Cashier',        30, FALSE, '{"tone":"neutral"}'),
  ('sorter',     'Sorter',         40, FALSE, '{"tone":"neutral"}'),
  ('dispatcher', 'Dispatcher',     50, FALSE, '{"tone":"info"}'),
  ('security',   'Security',       60, FALSE, '{"tone":"warn"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'branch_member_role'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- zone_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',    'Active',    10, TRUE,  '{"tone":"good"}'),
  ('draft',     'Draft',     20, FALSE, '{"tone":"info"}'),
  ('suspended', 'Suspended', 30, FALSE, '{"tone":"warn"}'),
  ('retired',   'Retired',   40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'zone_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- zone_district_role ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('primary',   'Primary',   10, FALSE, '{"tone":"good"}'),
  ('secondary', 'Secondary', 20, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'zone_district_role'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- zone_override_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',  'Pending',  10, FALSE, '{"tone":"warn"}'),
  ('approved', 'Approved', 20, FALSE, '{"tone":"good"}'),
  ('denied',   'Denied',   30, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'zone_override_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- zone_override_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('add_district',    'Add district',    10, FALSE, '{"tone":"info"}'),
  ('remove_district', 'Remove district', 20, FALSE, '{"tone":"warn"}'),
  ('reassign_role',   'Reassign role',   30, FALSE, '{"tone":"info"}'),
  ('rename',          'Rename',          40, FALSE, '{"tone":"neutral"}'),
  ('suspend_zone',    'Suspend',         50, FALSE, '{"tone":"warn"}'),
  ('restore_zone',    'Restore',         60, FALSE, '{"tone":"good"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'zone_override_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- zone_color_token ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('good',    'Green · ops nominal',  10, FALSE, '{"tone":"good"}'),
  ('info',    'Blue · informational', 20, FALSE, '{"tone":"info"}'),
  ('warn',    'Amber · attention',    30, FALSE, '{"tone":"warn"}'),
  ('danger',  'Red · escalation',     40, FALSE, '{"tone":"danger"}'),
  ('neutral', 'Grey · idle',          50, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'zone_color_token'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- marketplace_offer_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',     'Pending',     10, TRUE,  '{"tone":"warn"}'),
  ('shortlisted', 'Shortlisted', 20, FALSE, '{"tone":"info"}'),
  ('awarded',     'Awarded',     30, FALSE, '{"tone":"good"}'),
  ('rejected',    'Rejected',    40, FALSE, '{"tone":"danger"}'),
  ('expired',     'Expired',     50, FALSE, '{"tone":"neutral"}'),
  ('withdrawn',   'Withdrawn',   60, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'marketplace_offer_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- marketplace_award_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',    'Active',    10, TRUE,  '{"tone":"good"}'),
  ('cancelled', 'Cancelled', 20, FALSE, '{"tone":"danger"}'),
  ('completed', 'Completed', 30, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'marketplace_award_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- marketplace_contract_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('draft',         'Draft',         10, FALSE, '{"tone":"info"}'),
  ('active',        'Active',        20, TRUE,  '{"tone":"good"}'),
  ('expiring_soon', 'Expiring soon', 30, FALSE, '{"tone":"warn"}'),
  ('expired',       'Expired',       40, FALSE, '{"tone":"neutral"}'),
  ('terminated',    'Terminated',    50, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'marketplace_contract_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- marketplace_request_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('open',      'Open',      10, TRUE,  '{"tone":"info"}'),
  ('in_review', 'In review', 20, FALSE, '{"tone":"warn"}'),
  ('awarded',   'Awarded',   30, FALSE, '{"tone":"good"}'),
  ('closed',    'Closed',    40, FALSE, '{"tone":"neutral"}'),
  ('cancelled', 'Cancelled', 50, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'marketplace_request_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- marketplace_request_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('same_day_capacity', 'Same-day capacity', 10, FALSE, '{"tone":"info"}'),
  ('refrigerated',      'Refrigerated',      20, FALSE, '{"tone":"info"}'),
  ('hazmat',            'Hazmat',            30, FALSE, '{"tone":"warn"}'),
  ('bulk_freight',      'Bulk freight',      40, FALSE, '{"tone":"neutral"}'),
  ('return_pickup',     'Return pickup',     50, FALSE, '{"tone":"good"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'marketplace_request_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- alert_severity ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('info',     'Info',     10, FALSE, '{"tone":"info"}'),
  ('warn',     'Warning',  20, FALSE, '{"tone":"warn"}'),
  ('critical', 'Critical', 30, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'alert_severity'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- alert_channel ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('slack',      'Slack',      10, FALSE, '{"tone":"info"}'),
  ('email',      'Email',      20, FALSE, '{"tone":"neutral"}'),
  ('pagerduty',  'PagerDuty',  30, FALSE, '{"tone":"danger"}'),
  ('webhook',    'Webhook',    40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'alert_channel'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- alert_trigger_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('fired',        'Fired',        10, FALSE, '{"tone":"danger"}'),
  ('acknowledged', 'Acknowledged', 20, FALSE, '{"tone":"warn"}'),
  ('resolved',     'Resolved',     30, FALSE, '{"tone":"good"}'),
  ('silenced',     'Silenced',     40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'alert_trigger_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- ops_alert_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('open',         'Open',         10, FALSE, '{"tone":"danger"}'),
  ('acknowledged', 'Acknowledged', 20, FALSE, '{"tone":"warn"}'),
  ('resolved',     'Resolved',     30, FALSE, '{"tone":"good"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'ops_alert_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- feature_flag_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('on',         'On',      10, FALSE, '{"tone":"good"}'),
  ('off',        'Off',     20, FALSE, '{"tone":"neutral"}'),
  ('percentage', 'Rollout', 30, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'feature_flag_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- feature_flag_scope ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('global', 'Global', 10, FALSE, '{"tone":"neutral"}'),
  ('tenant', 'Tenant', 20, FALSE, '{"tone":"info"}'),
  ('client', 'Client', 30, FALSE, '{"tone":"warn"}'),
  ('sender', 'Sender', 40, FALSE, '{"tone":"good"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'feature_flag_scope'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- vehicle_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('in_service',     'In service',     10, TRUE,  '{"tone":"good"}'),
  ('on_shift',       'On shift',       20, FALSE, '{"tone":"info"}'),
  ('in_maintenance', 'In maintenance', 30, FALSE, '{"tone":"warn"}'),
  ('oos',            'Out of service', 40, FALSE, '{"tone":"danger"}'),
  ('reserve',        'Reserve',        50, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- vehicle_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('van',          'Van',          10, FALSE, '{"tone":"info"}'),
  ('box_truck',    'Box truck',    20, FALSE, '{"tone":"info"}'),
  ('refrigerated', 'Refrigerated', 30, FALSE, '{"tone":"good"}'),
  ('car',          'Car',          40, FALSE, '{"tone":"neutral"}'),
  ('motorbike',    'Motorbike',    50, FALSE, '{"tone":"neutral"}'),
  ('pickup',       'Pickup',       60, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- vehicle_fuel_type ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('diesel',   'Diesel',   10, FALSE, '{"tone":"neutral"}'),
  ('gasoline', 'Gasoline', 20, FALSE, '{"tone":"neutral"}'),
  ('electric', 'Electric', 30, FALSE, '{"tone":"good"}'),
  ('hybrid',   'Hybrid',   40, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_fuel_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- vehicle_event_type ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('odometer',    'Odometer',    10, TRUE,  '{"tone":"neutral"}'),
  ('fuel',        'Fuel',        20, FALSE, '{"tone":"neutral"}'),
  ('maintenance', 'Maintenance', 30, FALSE, '{"tone":"info"}'),
  ('incident',    'Incident',    40, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- vehicle_maintenance_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('preventive',     'Preventive',     10, FALSE, '{"tone":"info"}'),
  ('oil_change',     'Oil change',     20, FALSE, '{"tone":"neutral"}'),
  ('tire_rotation',  'Tire rotation',  30, FALSE, '{"tone":"neutral"}'),
  ('brake_service',  'Brake service',  40, FALSE, '{"tone":"warn"}'),
  ('inspection',     'Inspection',     50, FALSE, '{"tone":"info"}'),
  ('major_repair',   'Major repair',   60, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_maintenance_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- vehicle_maintenance_window_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('planned',     'Planned',     10, FALSE, '{"tone":"info"}'),
  ('in_progress', 'In progress', 20, FALSE, '{"tone":"warn"}'),
  ('completed',   'Completed',   30, FALSE, '{"tone":"good"}'),
  ('cancelled',   'Cancelled',   40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_maintenance_window_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- invoice_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('draft',    'Draft',    10, FALSE, '{"tone":"neutral"}'),
  ('sent',     'Sent',     20, FALSE, '{"tone":"info"}'),
  ('paid',     'Paid',     30, FALSE, '{"tone":"good"}'),
  ('overdue',  'Overdue',  40, FALSE, '{"tone":"danger"}'),
  ('voided',   'Voided',   50, FALSE, '{"tone":"neutral"}'),
  ('refunded', 'Refunded', 60, FALSE, '{"tone":"warn"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'invoice_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- invoice_event_type ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('drafted',  'Drafted',     10, FALSE, '{"tone":"neutral"}'),
  ('sent',     'Sent',        20, FALSE, '{"tone":"info"}'),
  ('paid',     'Paid',        30, FALSE, '{"tone":"good"}'),
  ('refunded', 'Refunded',    40, FALSE, '{"tone":"warn"}'),
  ('voided',   'Voided',      50, FALSE, '{"tone":"danger"}'),
  ('reissued', 'Re-issued',   60, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'invoice_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- subscription_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',  'Active',  10, FALSE, '{"tone":"good"}'),
  ('paused',  'Paused',  20, FALSE, '{"tone":"warn"}'),
  ('ended',   'Ended',   30, FALSE, '{"tone":"neutral"}'),
  ('pending', 'Pending', 40, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'subscription_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- agreement_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',     'Active',     10, FALSE, '{"tone":"good"}'),
  ('expired',    'Expired',    20, FALSE, '{"tone":"danger"}'),
  ('pending',    'Pending',    30, FALSE, '{"tone":"info"}'),
  ('terminated', 'Terminated', 40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'agreement_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- agreement_term_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('price_per_shipment',   'Price per shipment',     10, FALSE, '{}'),
  ('monthly_minimum',      'Monthly minimum',        20, FALSE, '{}'),
  ('sla_pct',              'SLA target',             30, FALSE, '{}'),
  ('cod_handover_window',  'COD handover window',    40, FALSE, '{}'),
  ('fuel_surcharge',       'Fuel surcharge',         50, FALSE, '{}'),
  ('volume_tier',          'Volume tier discount',   60, FALSE, '{}'),
  ('payment_terms_days',   'Payment terms (days)',   70, FALSE, '{}'),
  ('late_fee_pct',         'Late fee %',             80, FALSE, '{}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'agreement_term_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- usage_event_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('shipment_delivered', 'Shipment delivered', 10, FALSE, '{}'),
  ('shipment_pickup',    'Pickup',             20, FALSE, '{}'),
  ('cod_handover',       'COD handover',       30, FALSE, '{}'),
  ('rto_processed',      'RTO processed',      40, FALSE, '{}'),
  ('extra_attempt',      'Extra attempt',      50, FALSE, '{}'),
  ('storage_day',        'Storage day',        60, FALSE, '{}'),
  ('subscription_fee',   'Subscription fee',   70, FALSE, '{}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'usage_event_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- api_method ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('GET',    'GET',    10, FALSE, '{"tone":"info"}'),
  ('POST',   'POST',   20, FALSE, '{"tone":"good"}'),
  ('PUT',    'PUT',    30, FALSE, '{"tone":"warn"}'),
  ('PATCH',  'PATCH',  40, FALSE, '{"tone":"warn"}'),
  ('DELETE', 'DELETE', 50, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'api_method'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- provider_health_status ----
-- Note: distinct from `provider_health` (W53 canonical pack which carries
-- `down/critical` for live monitoring); this category mirrors the FE seed in
-- insights-apigw.js used for the api_call_log / provider_health_metrics chip.
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('healthy',  'Healthy',  10, FALSE, '{"tone":"good"}'),
  ('degraded', 'Degraded', 20, FALSE, '{"tone":"warn"}'),
  ('critical', 'Critical', 30, FALSE, '{"tone":"danger"}'),
  ('unknown',  'Unknown',  40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'provider_health_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- import_job_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('queued',    'Queued',    10, FALSE, '{"tone":"info"}'),
  ('running',   'Running',   20, FALSE, '{"tone":"warn"}'),
  ('completed', 'Completed', 30, FALSE, '{"tone":"good"}'),
  ('failed',    'Failed',    40, FALSE, '{"tone":"danger"}'),
  ('cancelled', 'Cancelled', 50, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'import_job_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- import_job_source ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('file_upload', 'File upload', 10, FALSE, '{"tone":"info"}'),
  ('api',         'API',         20, FALSE, '{"tone":"neutral"}'),
  ('manual',      'Manual',      30, FALSE, '{"tone":"warn"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'import_job_source'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- import_job_kind ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('shipments',  'Shipments',  10, FALSE, '{"tone":"info"}'),
  ('clients',    'Clients',    20, FALSE, '{"tone":"neutral"}'),
  ('senders',    'Senders',    30, FALSE, '{"tone":"neutral"}'),
  ('recipients', 'Recipients', 40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'import_job_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- driver_application_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending',   'Pending review', 10, TRUE,  '{"tone":"info"}'),
  ('approved',  'Approved',       20, FALSE, '{"tone":"good"}'),
  ('rejected',  'Rejected',       30, FALSE, '{"tone":"danger"}'),
  ('withdrawn', 'Withdrawn',      40, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'driver_application_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- driver_application_doc_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('submitted', 'Submitted', 10, FALSE, '{"tone":"info"}'),
  ('approved',  'Approved',  20, FALSE, '{"tone":"good"}'),
  ('rejected',  'Rejected',  30, FALSE, '{"tone":"danger"}'),
  ('expired',   'Expired',   40, FALSE, '{"tone":"warn"}'),
  ('missing',   'Missing',   50, FALSE, '{"tone":"warn"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'driver_application_doc_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- session_aal ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('aal1', 'AAL1', 10, FALSE, '{"tone":"warn"}'),
  ('aal2', 'AAL2', 20, FALSE, '{"tone":"good"}'),
  ('aal3', 'AAL3', 30, FALSE, '{"tone":"info"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'session_aal'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- service_offering_status ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',   'Active',   10, TRUE,  '{"tone":"good"}'),
  ('draft',    'Draft',    20, FALSE, '{"tone":"info"}'),
  ('archived', 'Archived', 30, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'service_offering_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- ---- service_level_tier ----
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('economy',     'Economy',     10, FALSE, '{"tone":"neutral"}'),
  ('standard',    'Standard',    20, FALSE, '{"tone":"info"}'),
  ('express',     'Express',     30, FALSE, '{"tone":"good"}'),
  ('same_day',    'Same day',    40, FALSE, '{"tone":"warn"}'),
  ('white_glove', 'White glove', 50, FALSE, '{"tone":"danger"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'service_level_tier'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata, updated_at = now();

-- =============================================================================
-- SECTION 3: Settings policies — settings_category_registry + schema_registry
--             + settings_versions + settings (one per new policy).
-- =============================================================================
-- Pattern mirrors W43:126-317 + W57-A:91-219 — single category registration
-- with schema_registry active row and global default settings_versions row.

-- ---- 3.1 settings_category_registry rows ----

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
)
VALUES
  ('provider_credential_policy',
   'Provider credential policy (drives expiring-soon threshold for integrations/credentials surface). W54-B canonical row.',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb),
  ('api_gateway_thresholds',
   'API gateway latency band classification (drives tone bucket boundaries on insights/api-gateway). W27-cycle-D §11 canonical row.',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb),
  ('delivery_slot_policy',
   'Delivery slot policy (drives operate/shipments reschedule slot offsets and warm-window minutes). W54-C canonical row.',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb),
  ('geocoding_policy',
   'Geocoding policy (drives network/geocoding confidence threshold + provider routing decisions). W55-Network canonical row.',
   TRUE, TRUE, FALSE, 'skip',
   '["global","tenant","client","sender","source","resource"]'::jsonb)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

-- ---- 3.2 schema_registry rows ----

WITH category_seed(category, description, schema_doc, example_doc) AS (
  VALUES
    ('provider_credential_policy',
     'Provider credential policy (drives expiring-soon threshold for integrations/credentials surface).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Provider Credential Policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "expiring_days_threshold": { "type": ["integer", "null"], "minimum": 0 }
        }
      }'::jsonb,
     '[ { "version": 1, "expiring_days_threshold": 30 } ]'::jsonb),
    ('api_gateway_thresholds',
     'API gateway latency band classification (drives tone bucket boundaries on insights/api-gateway).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "API Gateway Thresholds",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "latency_band_good_boundary_ms": { "type": ["integer", "null"], "minimum": 0 },
          "latency_band_info_boundary_ms": { "type": ["integer", "null"], "minimum": 0 },
          "latency_band_warn_boundary_ms": { "type": ["integer", "null"], "minimum": 0 }
        }
      }'::jsonb,
     '[ { "version": 1, "latency_band_good_boundary_ms": 300, "latency_band_info_boundary_ms": 900, "latency_band_warn_boundary_ms": 2000 } ]'::jsonb),
    ('delivery_slot_policy',
     'Delivery slot policy (drives operate/shipments reschedule slot offsets and warm-window minutes).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Delivery Slot Policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "default_reschedule_offsets": {
            "type": ["array", "null"],
            "items": { "type": "string" }
          },
          "warm_window_minutes": { "type": ["integer", "null"], "minimum": 0 }
        }
      }'::jsonb,
     '[ { "version": 1, "default_reschedule_offsets": ["P1D", "P2D", "P3D"], "warm_window_minutes": 90 } ]'::jsonb),
    ('geocoding_policy',
     'Geocoding policy (drives network/geocoding confidence threshold + provider routing decisions).',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Geocoding Policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "confidence_threshold": { "type": ["number", "null"], "minimum": 0, "maximum": 1 },
          "min_provider_quorum": { "type": ["integer", "null"], "minimum": 1 }
        }
      }'::jsonb,
     '[ { "version": 1, "confidence_threshold": 0.85, "min_provider_quorum": 2 } ]'::jsonb)
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT cs.category, 1, cs.schema_doc, cs.description, cs.example_doc, TRUE
FROM category_seed cs
ON CONFLICT (category, version) DO NOTHING;

-- ---- 3.3 settings_versions + settings — global defaults ----

WITH default_payload(category, body) AS (
  VALUES
    ('provider_credential_policy', jsonb_build_object(
      'version', 1,
      'expiring_days_threshold', 30
    )),
    ('api_gateway_thresholds', jsonb_build_object(
      'version', 1,
      'latency_band_good_boundary_ms', 300,
      'latency_band_info_boundary_ms', 900,
      'latency_band_warn_boundary_ms', 2000
    )),
    ('delivery_slot_policy', jsonb_build_object(
      'version', 1,
      'default_reschedule_offsets', jsonb_build_array('P1D', 'P2D', 'P3D'),
      'warm_window_minutes', 90
    )),
    ('geocoding_policy', jsonb_build_object(
      'version', 1,
      'confidence_threshold', 0.85,
      'min_provider_quorum', 2
    ))
),
inserted_versions AS (
  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version, approved_at
  )
  SELECT dp.category, 'global', NULL::uuid, 1, dp.body, 1, now()
  FROM default_payload dp
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = dp.category
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
  )
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (
  category, scope_type, scope_id, settings_version_id, cached_value, last_updated
)
SELECT iv.category, iv.scope_type, iv.scope_id, iv.id, iv.value, now()
FROM inserted_versions iv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = iv.category
    AND s.scope_type = iv.scope_type
    AND s.scope_id IS NULL
);

SELECT pg_advisory_unlock(hashtext('202605021400_w57b_console_v2_w54_w56_canonical_pack'));

COMMIT;

-- Spec-Issue: REAUDIT3 cross-cutting P1 (system-wide security_invoker = true)
-- Step: W35d
-- Migration: Align ALL public views to `security_invoker = true`.
--
-- Purpose:
--   Postgres views default to running with the OWNER's privileges (typically
--   `postgres`/`supabase_admin`), bypassing Row Level Security on the underlying
--   tables. PG >= 15 introduced `WITH (security_invoker = true)` so the view
--   query runs with the INVOKER's privileges and RLS is enforced as expected.
--
--   Many paired projection views from earlier closure waves (W11-2 through W31)
--   were created without this clause. The W34 fresh re-audit (REAUDIT3) flagged
--   this as a system-wide cross-cutting P1 risk:
--     - apps/console-v2/__audit__/REAUDIT3/FLEET.md (P1-2)
--     - apps/console-v2/__audit__/REAUDIT3/CUSTOMERS.md (cross-cutting)
--     - apps/console-v2/__audit__/REAUDIT3/NETWORK.md (cross-cutting)
--   Plus: scan of supabase/migrations/ shows 80+ public views missing the
--   clause across SUPPORT/INSIGHTS/INTEGRATIONS/PLATFORM/WORKFLOWS as well.
--
-- Behavior:
--   Append-only, idempotent. ALTER VIEW SET (security_invoker = true) is a
--   no-op if the view already has it. Each ALTER is wrapped in an existence
--   guard so dropped views (or views pending future creation) do not abort
--   the migration.
--
--   In live mode this strengthens RLS posture across the entire view surface
--   without changing column projection or grant posture; pgTAP regression
--   guard at `supabase/tests/pgtap/zzw35d_security_invoker_alignment.sql`
--   asserts the relreloptions invariant for each altered view.
--
-- Notes:
--   * `vehicles_with_state_v1` is included even though it was created at
--     202604301440 — the W11-4 closure correctly added GRANT but missed the
--     invoker opt-in (REAUDIT3/FLEET.md P1-2 explicit cite).
--   * `pg_policies` here is the project's compatibility view at
--     202510261335_pg_policies_compat_view.sql, NOT the system catalog.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604302345_w35d_security_invoker_alignment'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $w35d$
DECLARE
  view_name TEXT;
  view_list TEXT[] := ARRAY[
    'alert_delivery_status_v',
    'circuit_breaker_dashboard_v',
    'comms_reply_events_v',
    'comms_reply_failures_v',
    'comms_reply_latency_v',
    'dispatch_exception_review_backlog_v',
    'dispatch_exception_review_sla_breaches_v',
    'driver_profile_summary_v1',
    'edge_job_health',
    'geocoding_cache_metrics_v',
    'geocoding_provider_spend_v',
    'geocoding_queue_status_v',
    'inventory_balances_v1',
    'label_bundle_merge_metrics_v',
    'label_job_barcode_blocks_v',
    'label_job_barcode_summary_v',
    'label_render_job_timings_v',
    'marketplace_private_pool_memberships',
    'non_engine_outbound_calls_v',
    'observability_sink_v',
    'partition_inventory',
    'pg_policies',
    'pickup_failures',
    'pickup_requests',
    'pickup_waves',
    'provider_health_latest_v',
    'return_to_branch_shipments_v1',
    'route_runs_visible_v1',
    'route_stops_visible_v1',
    'security_rls_user_facing',
    'shipment_label_payload_v',
    'v_alert_rule_directory',
    'v_alert_trigger_summary',
    'v_api_gateway_observability',
    'v_api_gateway_rate_limits_summary',
    'v_benchmark_failures',
    'v_benchmark_failures_latest_run',
    'v_benchmark_latest_run',
    'v_benchmark_plugin_metrics',
    'v_benchmark_plugin_metrics_latest_run',
    'v_billing_invoice_directory',
    'v_branch_capacity_heatmap',
    'v_branch_summary',
    'v_branch_zone_directory',
    'v_client_summary',
    'v_decision_log_directory',
    'v_dispute_directory',
    'v_driver_application_directory',
    'v_driver_directory',
    'v_feature_flag_summary',
    'v_import_job_directory',
    'v_integration_credential_directory',
    'v_integration_plugin_directory',
    'v_kpi_rollup_directory',
    'v_label_template_directory',
    'v_lookup_definition_directory',
    'v_mapping_config_directory',
    'v_rbac_role_summary',
    'v_recipient_directory',
    'v_route_plan_directory',
    'v_route_run_directory',
    'v_sender_summary',
    'v_service_level_directory',
    'v_service_offering_directory',
    'v_settings_resolution_directory',
    'v_settlement_batch_summary',
    'v_shipment_directory',
    'v_support_case_directory',
    'v_support_case_summary',
    'v_support_message_directory',
    'v_tenant_signup_request_summary',
    'v_ui_event_log_directory',
    'v_user_directory',
    'v_vehicle_directory',
    'v_vehicle_maintenance_directory',
    'v_warehouse_transfer_summary',
    'v_webhook_inbox_directory',
    'v_webhook_source_directory',
    'v_workflow_binding_directory',
    'v_workflow_run_directory',
    'v_workflow_template_directory',
    'v_zone_summary',
    'vehicles_with_state_v1',
    'webhook_ack_history',
    'webhook_ack_metrics_5m_v',
    'workflow_business_action_inventory_v1'
  ];
BEGIN
  FOREACH view_name IN ARRAY view_list
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_views
      WHERE schemaname = 'public' AND viewname = view_name
    ) THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', view_name);
    END IF;
  END LOOP;
END
$w35d$;

SELECT pg_advisory_unlock(hashtext('202604302345_w35d_security_invoker_alignment'));

COMMIT;

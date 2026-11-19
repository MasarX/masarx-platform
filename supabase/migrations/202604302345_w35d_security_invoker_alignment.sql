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
  v_view_name TEXT;
  v_statement TEXT;
BEGIN
  FOR v_view_name, v_statement IN VALUES
    ('alert_delivery_status_v', 'ALTER VIEW public.alert_delivery_status_v SET (security_invoker = true)'),
    ('circuit_breaker_dashboard_v', 'ALTER VIEW public.circuit_breaker_dashboard_v SET (security_invoker = true)'),
    ('comms_reply_events_v', 'ALTER VIEW public.comms_reply_events_v SET (security_invoker = true)'),
    ('comms_reply_failures_v', 'ALTER VIEW public.comms_reply_failures_v SET (security_invoker = true)'),
    ('comms_reply_latency_v', 'ALTER VIEW public.comms_reply_latency_v SET (security_invoker = true)'),
    ('dispatch_exception_review_backlog_v', 'ALTER VIEW public.dispatch_exception_review_backlog_v SET (security_invoker = true)'),
    ('dispatch_exception_review_sla_breaches_v', 'ALTER VIEW public.dispatch_exception_review_sla_breaches_v SET (security_invoker = true)'),
    ('driver_profile_summary_v1', 'ALTER VIEW public.driver_profile_summary_v1 SET (security_invoker = true)'),
    ('edge_job_health', 'ALTER VIEW public.edge_job_health SET (security_invoker = true)'),
    ('geocoding_cache_metrics_v', 'ALTER VIEW public.geocoding_cache_metrics_v SET (security_invoker = true)'),
    ('geocoding_provider_spend_v', 'ALTER VIEW public.geocoding_provider_spend_v SET (security_invoker = true)'),
    ('geocoding_queue_status_v', 'ALTER VIEW public.geocoding_queue_status_v SET (security_invoker = true)'),
    ('inventory_balances_v1', 'ALTER VIEW public.inventory_balances_v1 SET (security_invoker = true)'),
    ('label_bundle_merge_metrics_v', 'ALTER VIEW public.label_bundle_merge_metrics_v SET (security_invoker = true)'),
    ('label_job_barcode_blocks_v', 'ALTER VIEW public.label_job_barcode_blocks_v SET (security_invoker = true)'),
    ('label_job_barcode_summary_v', 'ALTER VIEW public.label_job_barcode_summary_v SET (security_invoker = true)'),
    ('label_render_job_timings_v', 'ALTER VIEW public.label_render_job_timings_v SET (security_invoker = true)'),
    ('marketplace_private_pool_memberships', 'ALTER VIEW public.marketplace_private_pool_memberships SET (security_invoker = true)'),
    ('non_engine_outbound_calls_v', 'ALTER VIEW public.non_engine_outbound_calls_v SET (security_invoker = true)'),
    ('observability_sink_v', 'ALTER VIEW public.observability_sink_v SET (security_invoker = true)'),
    ('partition_inventory', 'ALTER VIEW public.partition_inventory SET (security_invoker = true)'),
    ('pg_policies', 'ALTER VIEW public.pg_policies SET (security_invoker = true)'),
    ('pickup_failures', 'ALTER VIEW public.pickup_failures SET (security_invoker = true)'),
    ('pickup_requests', 'ALTER VIEW public.pickup_requests SET (security_invoker = true)'),
    ('pickup_waves', 'ALTER VIEW public.pickup_waves SET (security_invoker = true)'),
    ('provider_health_latest_v', 'ALTER VIEW public.provider_health_latest_v SET (security_invoker = true)'),
    ('return_to_branch_shipments_v1', 'ALTER VIEW public.return_to_branch_shipments_v1 SET (security_invoker = true)'),
    ('route_runs_visible_v1', 'ALTER VIEW public.route_runs_visible_v1 SET (security_invoker = true)'),
    ('route_stops_visible_v1', 'ALTER VIEW public.route_stops_visible_v1 SET (security_invoker = true)'),
    ('security_rls_user_facing', 'ALTER VIEW public.security_rls_user_facing SET (security_invoker = true)'),
    ('shipment_label_payload_v', 'ALTER VIEW public.shipment_label_payload_v SET (security_invoker = true)'),
    ('v_alert_rule_directory', 'ALTER VIEW public.v_alert_rule_directory SET (security_invoker = true)'),
    ('v_alert_trigger_summary', 'ALTER VIEW public.v_alert_trigger_summary SET (security_invoker = true)'),
    ('v_api_gateway_observability', 'ALTER VIEW public.v_api_gateway_observability SET (security_invoker = true)'),
    ('v_api_gateway_rate_limits_summary', 'ALTER VIEW public.v_api_gateway_rate_limits_summary SET (security_invoker = true)'),
    ('v_benchmark_failures', 'ALTER VIEW public.v_benchmark_failures SET (security_invoker = true)'),
    ('v_benchmark_failures_latest_run', 'ALTER VIEW public.v_benchmark_failures_latest_run SET (security_invoker = true)'),
    ('v_benchmark_latest_run', 'ALTER VIEW public.v_benchmark_latest_run SET (security_invoker = true)'),
    ('v_benchmark_plugin_metrics', 'ALTER VIEW public.v_benchmark_plugin_metrics SET (security_invoker = true)'),
    ('v_benchmark_plugin_metrics_latest_run', 'ALTER VIEW public.v_benchmark_plugin_metrics_latest_run SET (security_invoker = true)'),
    ('v_billing_invoice_directory', 'ALTER VIEW public.v_billing_invoice_directory SET (security_invoker = true)'),
    ('v_branch_capacity_heatmap', 'ALTER VIEW public.v_branch_capacity_heatmap SET (security_invoker = true)'),
    ('v_branch_summary', 'ALTER VIEW public.v_branch_summary SET (security_invoker = true)'),
    ('v_branch_zone_directory', 'ALTER VIEW public.v_branch_zone_directory SET (security_invoker = true)'),
    ('v_client_summary', 'ALTER VIEW public.v_client_summary SET (security_invoker = true)'),
    ('v_decision_log_directory', 'ALTER VIEW public.v_decision_log_directory SET (security_invoker = true)'),
    ('v_dispute_directory', 'ALTER VIEW public.v_dispute_directory SET (security_invoker = true)'),
    ('v_driver_application_directory', 'ALTER VIEW public.v_driver_application_directory SET (security_invoker = true)'),
    ('v_driver_directory', 'ALTER VIEW public.v_driver_directory SET (security_invoker = true)'),
    ('v_feature_flag_summary', 'ALTER VIEW public.v_feature_flag_summary SET (security_invoker = true)'),
    ('v_import_job_directory', 'ALTER VIEW public.v_import_job_directory SET (security_invoker = true)'),
    ('v_integration_credential_directory', 'ALTER VIEW public.v_integration_credential_directory SET (security_invoker = true)'),
    ('v_integration_plugin_directory', 'ALTER VIEW public.v_integration_plugin_directory SET (security_invoker = true)'),
    ('v_kpi_rollup_directory', 'ALTER VIEW public.v_kpi_rollup_directory SET (security_invoker = true)'),
    ('v_label_template_directory', 'ALTER VIEW public.v_label_template_directory SET (security_invoker = true)'),
    ('v_lookup_definition_directory', 'ALTER VIEW public.v_lookup_definition_directory SET (security_invoker = true)'),
    ('v_mapping_config_directory', 'ALTER VIEW public.v_mapping_config_directory SET (security_invoker = true)'),
    ('v_rbac_role_summary', 'ALTER VIEW public.v_rbac_role_summary SET (security_invoker = true)'),
    ('v_recipient_directory', 'ALTER VIEW public.v_recipient_directory SET (security_invoker = true)'),
    ('v_route_plan_directory', 'ALTER VIEW public.v_route_plan_directory SET (security_invoker = true)'),
    ('v_route_run_directory', 'ALTER VIEW public.v_route_run_directory SET (security_invoker = true)'),
    ('v_sender_summary', 'ALTER VIEW public.v_sender_summary SET (security_invoker = true)'),
    ('v_service_level_directory', 'ALTER VIEW public.v_service_level_directory SET (security_invoker = true)'),
    ('v_service_offering_directory', 'ALTER VIEW public.v_service_offering_directory SET (security_invoker = true)'),
    ('v_settings_resolution_directory', 'ALTER VIEW public.v_settings_resolution_directory SET (security_invoker = true)'),
    ('v_settlement_batch_summary', 'ALTER VIEW public.v_settlement_batch_summary SET (security_invoker = true)'),
    ('v_shipment_directory', 'ALTER VIEW public.v_shipment_directory SET (security_invoker = true)'),
    ('v_support_case_directory', 'ALTER VIEW public.v_support_case_directory SET (security_invoker = true)'),
    ('v_support_case_summary', 'ALTER VIEW public.v_support_case_summary SET (security_invoker = true)'),
    ('v_support_message_directory', 'ALTER VIEW public.v_support_message_directory SET (security_invoker = true)'),
    ('v_tenant_signup_request_summary', 'ALTER VIEW public.v_tenant_signup_request_summary SET (security_invoker = true)'),
    ('v_ui_event_log_directory', 'ALTER VIEW public.v_ui_event_log_directory SET (security_invoker = true)'),
    ('v_user_directory', 'ALTER VIEW public.v_user_directory SET (security_invoker = true)'),
    ('v_vehicle_directory', 'ALTER VIEW public.v_vehicle_directory SET (security_invoker = true)'),
    ('v_vehicle_maintenance_directory', 'ALTER VIEW public.v_vehicle_maintenance_directory SET (security_invoker = true)'),
    ('v_warehouse_transfer_summary', 'ALTER VIEW public.v_warehouse_transfer_summary SET (security_invoker = true)'),
    ('v_webhook_inbox_directory', 'ALTER VIEW public.v_webhook_inbox_directory SET (security_invoker = true)'),
    ('v_webhook_source_directory', 'ALTER VIEW public.v_webhook_source_directory SET (security_invoker = true)'),
    ('v_workflow_binding_directory', 'ALTER VIEW public.v_workflow_binding_directory SET (security_invoker = true)'),
    ('v_workflow_run_directory', 'ALTER VIEW public.v_workflow_run_directory SET (security_invoker = true)'),
    ('v_workflow_template_directory', 'ALTER VIEW public.v_workflow_template_directory SET (security_invoker = true)'),
    ('v_zone_summary', 'ALTER VIEW public.v_zone_summary SET (security_invoker = true)'),
    ('vehicles_with_state_v1', 'ALTER VIEW public.vehicles_with_state_v1 SET (security_invoker = true)'),
    ('webhook_ack_history', 'ALTER VIEW public.webhook_ack_history SET (security_invoker = true)'),
    ('webhook_ack_metrics_5m_v', 'ALTER VIEW public.webhook_ack_metrics_5m_v SET (security_invoker = true)'),
    ('workflow_business_action_inventory_v1', 'ALTER VIEW public.workflow_business_action_inventory_v1 SET (security_invoker = true)')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_views
      WHERE schemaname = 'public' AND viewname = v_view_name
    ) THEN
      EXECUTE v_statement;
    END IF;
  END LOOP;
END
$w35d$;

SELECT pg_advisory_unlock(hashtext('202604302345_w35d_security_invoker_alignment'));

COMMIT;

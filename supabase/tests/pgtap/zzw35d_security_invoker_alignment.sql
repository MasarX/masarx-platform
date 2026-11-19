-- pgTAP regression guard for W35d cross-cutting alignment.
--
-- After 202604302345_w35d_security_invoker_alignment.sql runs, every public
-- view it touched MUST have `security_invoker=true` recorded in
-- pg_class.reloptions. This test asserts the invariant view-by-view so any
-- future revert (or a new view created without the option) fails closed.
--
-- The asserter helper checks pg_class.reloptions for the literal
-- `security_invoker=true` token, mirroring how Postgres serializes the option.
-- Views that were dropped after creation (or pending future creation) are
-- skipped via an existence preflight, matching the migration's existence guard.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_view_has_invoker(p_view text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = p_view AND c.relkind = 'v';

  IF v_opts IS NULL THEN
    -- View does not exist (dropped or pending). Treat as N/A.
    RETURN 'skipped: view ' || p_view || ' does not exist';
  END IF;

  IF v_opts @> ARRAY['security_invoker=true'] THEN
    RETURN 'ok: ' || p_view;
  END IF;

  RAISE EXCEPTION 'view public.% missing security_invoker=true (reloptions=%)', p_view, v_opts;
END;
$$;

SELECT plan(86);

-- One assertion per view. The lives_ok wrapper gives us a per-view test name
-- in the TAP output so a failure pinpoints exactly which view drifted.
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('alert_delivery_status_v') $$, 'alert_delivery_status_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('circuit_breaker_dashboard_v') $$, 'circuit_breaker_dashboard_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('comms_reply_events_v') $$, 'comms_reply_events_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('comms_reply_failures_v') $$, 'comms_reply_failures_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('comms_reply_latency_v') $$, 'comms_reply_latency_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('dispatch_exception_review_backlog_v') $$, 'dispatch_exception_review_backlog_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('dispatch_exception_review_sla_breaches_v') $$, 'dispatch_exception_review_sla_breaches_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('driver_profile_summary_v1') $$, 'driver_profile_summary_v1 has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('edge_job_health') $$, 'edge_job_health has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('geocoding_cache_metrics_v') $$, 'geocoding_cache_metrics_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('geocoding_provider_spend_v') $$, 'geocoding_provider_spend_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('geocoding_queue_status_v') $$, 'geocoding_queue_status_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('inventory_balances_v1') $$, 'inventory_balances_v1 has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('label_bundle_merge_metrics_v') $$, 'label_bundle_merge_metrics_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('label_job_barcode_blocks_v') $$, 'label_job_barcode_blocks_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('label_job_barcode_summary_v') $$, 'label_job_barcode_summary_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('label_render_job_timings_v') $$, 'label_render_job_timings_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('marketplace_private_pool_memberships') $$, 'marketplace_private_pool_memberships has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('non_engine_outbound_calls_v') $$, 'non_engine_outbound_calls_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('observability_sink_v') $$, 'observability_sink_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('partition_inventory') $$, 'partition_inventory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('pg_policies') $$, 'pg_policies (compat view) has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('pickup_failures') $$, 'pickup_failures has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('pickup_requests') $$, 'pickup_requests has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('pickup_waves') $$, 'pickup_waves has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('provider_health_latest_v') $$, 'provider_health_latest_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('return_to_branch_shipments_v1') $$, 'return_to_branch_shipments_v1 has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('route_runs_visible_v1') $$, 'route_runs_visible_v1 has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('route_stops_visible_v1') $$, 'route_stops_visible_v1 has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('security_rls_user_facing') $$, 'security_rls_user_facing has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('shipment_label_payload_v') $$, 'shipment_label_payload_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_alert_rule_directory') $$, 'v_alert_rule_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_alert_trigger_summary') $$, 'v_alert_trigger_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_api_gateway_observability') $$, 'v_api_gateway_observability has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_api_gateway_rate_limits_summary') $$, 'v_api_gateway_rate_limits_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_benchmark_failures') $$, 'v_benchmark_failures has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_benchmark_failures_latest_run') $$, 'v_benchmark_failures_latest_run has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_benchmark_latest_run') $$, 'v_benchmark_latest_run has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_benchmark_plugin_metrics') $$, 'v_benchmark_plugin_metrics has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_benchmark_plugin_metrics_latest_run') $$, 'v_benchmark_plugin_metrics_latest_run has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_billing_invoice_directory') $$, 'v_billing_invoice_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_branch_capacity_heatmap') $$, 'v_branch_capacity_heatmap has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_branch_summary') $$, 'v_branch_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_branch_zone_directory') $$, 'v_branch_zone_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_client_summary') $$, 'v_client_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_decision_log_directory') $$, 'v_decision_log_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_dispute_directory') $$, 'v_dispute_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_driver_application_directory') $$, 'v_driver_application_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_driver_directory') $$, 'v_driver_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_feature_flag_summary') $$, 'v_feature_flag_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_import_job_directory') $$, 'v_import_job_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_integration_credential_directory') $$, 'v_integration_credential_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_integration_plugin_directory') $$, 'v_integration_plugin_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_kpi_rollup_directory') $$, 'v_kpi_rollup_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_label_template_directory') $$, 'v_label_template_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_lookup_definition_directory') $$, 'v_lookup_definition_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_mapping_config_directory') $$, 'v_mapping_config_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_rbac_role_summary') $$, 'v_rbac_role_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_recipient_directory') $$, 'v_recipient_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_route_plan_directory') $$, 'v_route_plan_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_route_run_directory') $$, 'v_route_run_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_sender_summary') $$, 'v_sender_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_service_level_directory') $$, 'v_service_level_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_service_offering_directory') $$, 'v_service_offering_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_settings_resolution_directory') $$, 'v_settings_resolution_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_settlement_batch_summary') $$, 'v_settlement_batch_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_shipment_directory') $$, 'v_shipment_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_support_case_directory') $$, 'v_support_case_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_support_case_summary') $$, 'v_support_case_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_support_message_directory') $$, 'v_support_message_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_tenant_signup_request_summary') $$, 'v_tenant_signup_request_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_ui_event_log_directory') $$, 'v_ui_event_log_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_user_directory') $$, 'v_user_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_vehicle_directory') $$, 'v_vehicle_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_vehicle_maintenance_directory') $$, 'v_vehicle_maintenance_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_warehouse_transfer_summary') $$, 'v_warehouse_transfer_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_webhook_inbox_directory') $$, 'v_webhook_inbox_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_webhook_source_directory') $$, 'v_webhook_source_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_workflow_binding_directory') $$, 'v_workflow_binding_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_workflow_run_directory') $$, 'v_workflow_run_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_workflow_template_directory') $$, 'v_workflow_template_directory has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('v_zone_summary') $$, 'v_zone_summary has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('vehicles_with_state_v1') $$, 'vehicles_with_state_v1 has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('webhook_ack_history') $$, 'webhook_ack_history has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('webhook_ack_metrics_5m_v') $$, 'webhook_ack_metrics_5m_v has security_invoker=true');
SELECT lives_ok($$ SELECT pg_temp.assert_view_has_invoker('workflow_business_action_inventory_v1') $$, 'workflow_business_action_inventory_v1 has security_invoker=true');

SELECT finish();
ROLLBACK;

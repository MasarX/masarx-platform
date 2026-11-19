BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(144);

CREATE TEMP TABLE console_v2_backend_api_wrapper_contracts (
  rpc_name TEXT NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (rpc_name, signature)
) ON COMMIT DROP;

INSERT INTO console_v2_backend_api_wrapper_contracts(rpc_name, signature)
VALUES
  ('ui_list_resource_v1', 'api.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'),
  ('ui_get_resource_v1', 'api.ui_get_resource_v1(text,uuid)'),
  ('ui_resource_metrics_v1', 'api.ui_resource_metrics_v1(text,jsonb,text[])'),
  ('ui_filter_distinct_values_v1', 'api.ui_filter_distinct_values_v1(text,text,text,integer)'),
  ('create_billing_invoice_v1', 'api.create_billing_invoice_v1(jsonb)'),
  ('update_billing_invoice_v1', 'api.update_billing_invoice_v1(jsonb)'),
  ('void_billing_invoice_v1', 'api.void_billing_invoice_v1(jsonb)'),
  ('billing_invoice_send_v1', 'api.billing_invoice_send_v1(jsonb)'),
  ('billing_invoice_refund_v1', 'api.billing_invoice_refund_v1(jsonb)'),
  ('billing_invoice_mark_paid_v1', 'api.billing_invoice_mark_paid_v1(jsonb)'),
  ('cancel_subscription_v1', 'api.cancel_subscription_v1(jsonb)'),
  ('apply_settlement_v1', 'api.apply_settlement_v1(jsonb)'),
  ('reject_settlement_v1', 'api.reject_settlement_v1(jsonb)'),
  ('bank_recon_match_v1', 'api.bank_recon_match_v1(jsonb)'),
  ('bank_recon_unmatch_v1', 'api.bank_recon_unmatch_v1(jsonb)'),
  ('dispute_resolve_v1', 'api.dispute_resolve_v1(jsonb)'),
  ('dispute_reject_v1', 'api.dispute_reject_v1(jsonb)'),
  ('dispute_acknowledge_v1', 'api.dispute_acknowledge_v1(jsonb)'),
  ('dispute_escalate_v1', 'api.dispute_escalate_v1(jsonb)'),
  ('warehouse_transfer_execute_v1', 'api.warehouse_transfer_execute_v1(jsonb)'),
  ('ui_log_event_v1', 'api.ui_log_event_v1(jsonb,text)'),
  ('ui_start_workflow_run_v1', 'api.ui_start_workflow_run_v1(uuid,jsonb,boolean)'),
  ('progress_workflow_run_until_wait_v1', 'api.progress_workflow_run_until_wait_v1(uuid,jsonb,integer,integer)'),
  ('bulk_transition_tasks_v1', 'api.bulk_transition_tasks_v1(jsonb)'),
  ('ui_upsert_webhook_source_v1', 'api.ui_upsert_webhook_source_v1(jsonb)'),
  ('ui_rotate_webhook_source_token_v1', 'api.ui_rotate_webhook_source_token_v1(jsonb)'),
  ('ui_archive_webhook_source_v1', 'api.ui_archive_webhook_source_v1(jsonb)'),
  ('ui_upsert_webhook_rule_v1', 'api.ui_upsert_webhook_rule_v1(jsonb)'),
  ('ui_delete_webhook_rule_v1', 'api.ui_delete_webhook_rule_v1(jsonb)'),
  ('ui_reorder_webhook_rule_v1', 'api.ui_reorder_webhook_rule_v1(jsonb)'),
  ('webhook_inbox_replay_v1', 'api.webhook_inbox_replay_v1(jsonb)'),
  ('ui_retry_webhook_inbox_as_new_intake_v1', 'api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb)'),
  ('webhook_inbox_force_status_v1', 'api.webhook_inbox_force_status_v1(jsonb)'),
  ('integration_plugin_export_handoff_v1', 'api.integration_plugin_export_handoff_v1(uuid,text)'),
  ('block_api_gateway_source_v1', 'api.block_api_gateway_source_v1(jsonb)'),
  ('adjust_api_gateway_rate_limit_v1', 'api.adjust_api_gateway_rate_limit_v1(jsonb)');

SELECT ok(
  to_regprocedure(signature) IS NOT NULL,
  format('%s wrapper exists in api schema', rpc_name)
)
FROM console_v2_backend_api_wrapper_contracts;

SELECT ok(
  CASE
    WHEN to_regprocedure(signature) IS NULL THEN FALSE
    ELSE has_function_privilege('authenticated', to_regprocedure(signature)::oid, 'EXECUTE')
  END,
  format('authenticated can execute %s', signature)
)
FROM console_v2_backend_api_wrapper_contracts;

SELECT ok(
  CASE
    WHEN to_regprocedure(signature) IS NULL THEN FALSE
    ELSE has_function_privilege('service_role', to_regprocedure(signature)::oid, 'EXECUTE')
  END,
  format('service_role can execute %s', signature)
)
FROM console_v2_backend_api_wrapper_contracts;

SELECT ok(
  CASE
    WHEN to_regprocedure(signature) IS NULL THEN FALSE
    ELSE NOT has_function_privilege('anon', to_regprocedure(signature)::oid, 'EXECUTE')
  END,
  format('anon cannot execute %s', signature)
)
FROM console_v2_backend_api_wrapper_contracts;

SELECT * FROM finish();

ROLLBACK;

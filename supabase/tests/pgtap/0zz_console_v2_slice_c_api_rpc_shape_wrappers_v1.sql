-- Slice C: Console V2 API-schema wrapper shape coverage.
--
-- pgTAP proves that browser/server UI clients can resolve the API-schema
-- RPC signatures they call and that renderer-only completion stays locked
-- down behind service/renderer roles.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(109);

CREATE TEMP TABLE console_v2_slice_c_jsonb_wrappers (
  rpc_name text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO console_v2_slice_c_jsonb_wrappers(rpc_name)
VALUES
  ('ui_upsert_webhook_source_v1'),
  ('ui_rotate_webhook_source_token_v1'),
  ('ui_upsert_webhook_rule_v1'),
  ('ui_delete_webhook_rule_v1'),
  ('ui_reorder_webhook_rule_v1'),
  ('ui_upsert_provider_auth_config_v1'),
  ('ui_revoke_provider_auth_config_v1'),
  ('integration_plugin_generate_draft_v1'),
  ('integration_plugin_rollback_v1'),
  ('integration_plugin_rotate_credentials_v1'),
  ('webhook_inbox_replay_v1'),
  ('webhook_inbox_force_status_v1'),
  ('import_job_create_v1'),
  ('import_job_cancel_v1'),
  ('ui_set_workflow_template_status_v1'),
  ('register_workflow_binding_v1'),
  ('simulate_binding_dispatch_v1'),
  ('bulk_transition_tasks_v1');

SELECT ok(
  to_regprocedure(format('api.%I(jsonb)', rpc_name)) IS NOT NULL,
  format('api.%s(jsonb) resolves for Console V2 api-schema RPC calls', rpc_name)
)
FROM console_v2_slice_c_jsonb_wrappers;

SELECT ok(
  COALESCE(has_function_privilege('authenticated', to_regprocedure(format('api.%I(jsonb)', rpc_name))::oid, 'EXECUTE'), FALSE),
  format('authenticated can execute api.%s(jsonb)', rpc_name)
)
FROM console_v2_slice_c_jsonb_wrappers;

SELECT ok(
  COALESCE(has_function_privilege('service_role', to_regprocedure(format('api.%I(jsonb)', rpc_name))::oid, 'EXECUTE'), FALSE),
  format('service_role can execute api.%s(jsonb)', rpc_name)
)
FROM console_v2_slice_c_jsonb_wrappers;

SELECT ok(
  NOT COALESCE(has_function_privilege('anon', to_regprocedure(format('api.%I(jsonb)', rpc_name))::oid, 'EXECUTE'), FALSE),
  format('anon cannot execute api.%s(jsonb)', rpc_name)
)
FROM console_v2_slice_c_jsonb_wrappers;

CREATE TEMP TABLE console_v2_slice_c_label_designer_wrappers (
  rpc_name text NOT NULL,
  signature text NOT NULL,
  PRIMARY KEY (rpc_name, signature)
) ON COMMIT DROP;

INSERT INTO console_v2_slice_c_label_designer_wrappers(rpc_name, signature)
VALUES
  ('label_designer_list_drafts', 'api.label_designer_list_drafts(text,uuid)'),
  ('label_designer_create_draft', 'api.label_designer_create_draft(text,uuid,text,text,jsonb)'),
  ('label_designer_update_draft', 'api.label_designer_update_draft(uuid,text,text,jsonb)'),
  ('label_designer_archive_draft', 'api.label_designer_archive_draft(uuid,text)'),
  ('label_designer_validate_label_design_draft', 'api.label_designer_validate_label_design_draft(uuid)'),
  ('label_designer_publish_label_design_draft', 'api.label_designer_publish_label_design_draft(uuid,text)');

SELECT ok(
  to_regprocedure(signature) IS NOT NULL,
  format('%s resolves in api schema', signature)
)
FROM console_v2_slice_c_label_designer_wrappers;

SELECT ok(
  COALESCE(has_function_privilege('authenticated', to_regprocedure(signature)::oid, 'EXECUTE'), FALSE),
  format('authenticated can execute %s', signature)
)
FROM console_v2_slice_c_label_designer_wrappers;

SELECT ok(
  COALESCE(has_function_privilege('service_role', to_regprocedure(signature)::oid, 'EXECUTE'), FALSE),
  format('service_role can execute %s', signature)
)
FROM console_v2_slice_c_label_designer_wrappers;

SELECT ok(
  NOT COALESCE(has_function_privilege('anon', to_regprocedure(signature)::oid, 'EXECUTE'), FALSE),
  format('anon cannot execute %s', signature)
)
FROM console_v2_slice_c_label_designer_wrappers;

SELECT ok(
  to_regprocedure('api.complete_label_job(jsonb)') IS NOT NULL,
  'api.complete_label_job(jsonb) resolves for jsonb completion payloads'
);

SELECT ok(
  COALESCE(has_function_privilege('service_role', to_regprocedure('api.complete_label_job(jsonb)')::oid, 'EXECUTE'), FALSE),
  'service_role can execute api.complete_label_job(jsonb)'
);

SELECT ok(
  NOT COALESCE(has_function_privilege('authenticated', to_regprocedure('api.complete_label_job(jsonb)')::oid, 'EXECUTE'), FALSE),
  'authenticated cannot execute renderer-only api.complete_label_job(jsonb)'
);

SELECT ok(
  NOT COALESCE(has_function_privilege('anon', to_regprocedure('api.complete_label_job(jsonb)')::oid, 'EXECUTE'), FALSE),
  'anon cannot execute renderer-only api.complete_label_job(jsonb)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('api.integration_plugin_generate_draft_v1(jsonb)'))
    LIKE '%public.integration_plugin_generate_draft_v1%',
  'api.integration_plugin_generate_draft_v1(jsonb) forwards to public.integration_plugin_generate_draft_v1'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('api.integration_plugin_rollback_v1(jsonb)'))
    LIKE '%public.integration_plugin_rollback_v1%',
  'api.integration_plugin_rollback_v1(jsonb) forwards to public.integration_plugin_rollback_v1'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('api.integration_plugin_rotate_credentials_v1(jsonb)'))
    LIKE '%public.integration_plugin_rotate_credentials_v1%',
  'api.integration_plugin_rotate_credentials_v1(jsonb) supports plugin-version credential rotation forwarding'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('api.integration_plugin_rotate_credentials_v1(jsonb)'))
    LIKE '%public.ui_upsert_provider_auth_config_v1%',
  'api.integration_plugin_rotate_credentials_v1(jsonb) supports provider-auth-config credential updates'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('api.complete_label_job(jsonb)'))
    LIKE '%public.complete_label_job%',
  'api.complete_label_job(jsonb) forwards to public.complete_label_job'
);

SELECT throws_ok(
  $$ SELECT api.integration_plugin_rotate_credentials_v1('{}'::jsonb) $$,
  '23502',
  'integration_plugin_rotate_credentials_v1 requires plugin_version_id or config_id'
);

SELECT throws_ok(
  $$ SELECT api.integration_plugin_rotate_credentials_v1('{"config_id":"00000000-0000-4000-8000-000000000001"}'::jsonb) $$,
  '23502',
  'integration_plugin_rotate_credentials_v1 requires credentials or credentials_vault_id for config rotation'
);

SELECT throws_ok(
  $$ SELECT api.integration_plugin_rollback_v1('{}'::jsonb) $$,
  'P0001',
  'integration_plugin_rollback_v1 requires plugin_id'
);

SELECT throws_ok(
  $$ SELECT api.complete_label_job('{}'::jsonb) $$,
  '23502',
  'complete_label_job requires label_job_id'
);

SELECT * FROM finish();

ROLLBACK;

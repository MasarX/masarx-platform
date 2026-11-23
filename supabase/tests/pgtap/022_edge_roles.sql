BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(19);

-- Edge Webhook Role: should execute selected RPCs, hidden from anon/authenticated
SELECT ok(has_function_privilege('edge_webhook_role', 'public.get_webhook_source_by_token(text)', 'EXECUTE'), 'edge_webhook_role can EXECUTE get_webhook_source_by_token(text)');
SELECT ok(has_function_privilege('edge_webhook_role', 'public.resolve_webhook_ingest_policy(uuid)', 'EXECUTE'), 'edge_webhook_role can EXECUTE resolve_webhook_ingest_policy(uuid)');
SELECT ok(has_function_privilege('edge_webhook_role', 'public.get_webhook_edge_dispatch_jobs(uuid)', 'EXECUTE'), 'edge_webhook_role can EXECUTE get_webhook_edge_dispatch_jobs(uuid)');
SELECT ok(NOT has_function_privilege('anon', 'public.get_webhook_source_by_token(text)', 'EXECUTE'), 'anon cannot EXECUTE get_webhook_source_by_token(text)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.get_webhook_source_by_token(text)', 'EXECUTE'), 'authenticated cannot EXECUTE get_webhook_source_by_token(text)');
SELECT ok(NOT has_function_privilege('anon', 'public.get_webhook_edge_dispatch_jobs(uuid)', 'EXECUTE'), 'anon cannot EXECUTE get_webhook_edge_dispatch_jobs(uuid)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.get_webhook_edge_dispatch_jobs(uuid)', 'EXECUTE'), 'authenticated cannot EXECUTE get_webhook_edge_dispatch_jobs(uuid)');

-- Edge API Caller Role
SELECT ok(
  NOT has_function_privilege('edge_api_caller_role', 'public.get_job_call_spec(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('edge_api_caller_role', 'api.get_job_call_spec(uuid)', 'EXECUTE')
  AND has_function_privilege('edge_api_caller_role', 'api.get_claimed_edge_job_call_spec_v1(uuid,uuid)', 'EXECUTE'),
  'the Edge API caller can execute the leased spec wrapper only'
);
SELECT ok(has_function_privilege('edge_api_caller_role', 'public.mark_outbound_call_success(uuid, integer, jsonb, jsonb, integer)', 'EXECUTE'), 'edge_api_caller_role can EXECUTE mark_outbound_call_success');
SELECT ok(NOT has_function_privilege('anon', 'public.get_job_call_spec(uuid)', 'EXECUTE'), 'anon cannot EXECUTE get_job_call_spec(uuid)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.get_job_call_spec(uuid)', 'EXECUTE'), 'authenticated cannot EXECUTE get_job_call_spec(uuid)');

-- Edge API Gateway Role
SELECT ok(has_function_privilege('edge_api_gateway_role', 'public.workflow_intake_api_gateway_v1(text, text, text, text, jsonb, jsonb)', 'EXECUTE'), 'edge_api_gateway_role can EXECUTE workflow_intake_api_gateway_v1');
SELECT ok(has_schema_privilege('edge_api_gateway_role', 'public', 'USAGE'), 'edge_api_gateway_role has USAGE on schema public');
SELECT ok(NOT has_function_privilege('anon', 'public.workflow_intake_api_gateway_v1(text, text, text, text, jsonb, jsonb)', 'EXECUTE'), 'anon cannot EXECUTE workflow_intake_api_gateway_v1');
SELECT ok(NOT has_function_privilege('authenticated', 'public.workflow_intake_api_gateway_v1(text, text, text, text, jsonb, jsonb)', 'EXECUTE'), 'authenticated cannot EXECUTE workflow_intake_api_gateway_v1');

-- Edge Label Renderer Role
SELECT ok(has_function_privilege('edge_label_renderer_role', 'public.lease_label_job(uuid, integer, uuid)', 'EXECUTE'), 'edge_label_renderer_role can EXECUTE lease_label_job(uuid,integer,uuid)');
SELECT ok(has_function_privilege('edge_label_renderer_role', 'public.compose_label_payload(uuid)', 'EXECUTE'), 'edge_label_renderer_role can EXECUTE compose_label_payload(uuid)');
SELECT ok(NOT has_function_privilege('anon', 'public.lease_label_job(uuid, integer, uuid)', 'EXECUTE'), 'anon cannot EXECUTE lease_label_job');
SELECT ok(NOT has_function_privilege('authenticated', 'public.lease_label_job(uuid, integer, uuid)', 'EXECUTE'), 'authenticated cannot EXECUTE lease_label_job');

SELECT finish();

ROLLBACK;


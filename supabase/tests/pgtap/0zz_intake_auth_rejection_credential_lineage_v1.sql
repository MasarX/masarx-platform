BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(49);

SELECT has_table('public', 'intake_auth_rejections', 'append-only auth rejection ledger exists');
SELECT has_table('public', 'webhook_source_token_history', 'append-only source-token history exists');
SELECT has_view('public', 'v_intake_auth_rejection_directory', 'scoped rejection directory exists');
SELECT has_function('public', 'record_intake_auth_rejection_v1', ARRAY['jsonb'], 'public rejection recorder exists');
SELECT has_function('api', 'record_intake_auth_rejection_v1', ARRAY['jsonb'], 'api rejection recorder wrapper exists');
SELECT has_function('public', 'resolve_retired_webhook_source_by_token_v1', ARRAY['text'], 'retired-token resolver exists');
SELECT has_function('public', 'ui_rotate_webhook_source_token_v1', ARRAY['jsonb'], 'public rotation function exists');
SELECT has_function('api', 'ui_rotate_webhook_source_token_v1', ARRAY['jsonb'], 'api rotation wrapper exists');
SELECT has_function('public', 'redact_intake_auth_secret_text', ARRAY['text'], 'text redactor exists');
SELECT has_function('public', 'redact_intake_auth_secret_json', ARRAY['jsonb'], 'recursive JSON redactor exists');

SELECT has_trigger(
  'public',
  'intake_auth_rejections',
  'intake_auth_rejections_immutable_trg',
  'rejection ledger has an immutability trigger'
);
SELECT has_trigger(
  'public',
  'webhook_source_token_history',
  'webhook_source_token_history_immutable_trg',
  'token history has an immutability trigger'
);
SELECT has_trigger(
  'public',
  'webhook_sources',
  'webhook_sources_capture_token_lineage_trg',
  'source changes append credential lineage centrally'
);
SELECT has_trigger(
  'public',
  'decision_log',
  'decision_log_mirror_webhook_hmac_auth_rejection_trg',
  'real terminal HMAC decisions mirror rejection evidence'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'intake_auth_rejections'),
  'rejection ledger has RLS enabled'
);
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'webhook_source_token_history'),
  'token history has RLS enabled'
);
SELECT ok(
  (
    SELECT COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'v_intake_auth_rejection_directory'
  ),
  'rejection directory is security-invoker'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.intake_auth_rejections', 'SELECT'),
  'authenticated may read the RLS-scoped rejection ledger'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.webhook_source_token_history', 'SELECT'),
  'authenticated cannot read bcrypt token history'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.intake_auth_rejections', 'SELECT'),
  'anon cannot read the rejection ledger'
);
SELECT ok(
  has_function_privilege('service_role', 'api.record_intake_auth_rejection_v1(jsonb)', 'EXECUTE'),
  'service role may execute the API recorder'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'api.record_intake_auth_rejection_v1(jsonb)', 'EXECUTE'),
  'authenticated cannot execute the ingress recorder'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.ui_rotate_webhook_source_token_v1(jsonb)', 'EXECUTE'),
  'authenticated may call the capability-gated rotation wrapper'
);

CREATE TEMP TABLE pgtap_auth_rejection_counts AS
SELECT
  (SELECT COUNT(*) FROM public.api_gateway_requests) AS api_gateway_requests,
  (SELECT COUNT(*) FROM public.webhook_inbox) AS webhook_inbox,
  (SELECT COUNT(*) FROM public.outbound_calls) AS outbound_calls,
  (SELECT COUNT(*) FROM public.workflow_runs) AS workflow_runs,
  (SELECT COUNT(*) FROM public.shipments) AS shipments;

WITH recorded AS (
  SELECT public.record_intake_auth_rejection_v1(
    jsonb_build_object(
      'service', 'api_gateway',
      'surface', 'api_gateway',
      'token', 'plain-secret-token-never-persist',
      'http_status', 401,
      'failure_code', 'source_token_mismatch',
      'failure_message', 'Rejected /api-gateway/t/plain-secret-token-never-persist/v1?signature=hidden-signature',
      'method', 'POST',
      'path', '/api-gateway/t/plain-secret-token-never-persist/v1?api_key=hidden-key',
      'query_string', 'token=plain-secret-token-never-persist&signature=hidden-signature&keep=value',
      'headers', jsonb_build_object(
        'authorization', 'Bearer plain-secret-token-never-persist',
        'x-forwarded-url', '/api-gateway/t/plain-secret-token-never-persist/v1?signature=hidden-signature'
      ),
      'request_id', 'pgtap-auth-rejection-mismatch',
      'metadata', jsonb_build_object(
        'credential', 'plain-secret-token-never-persist',
        'retired_token_history_id', gen_random_uuid()::TEXT,
        'nested', jsonb_build_object('password', 'hidden-password')
      )
    )
  ) AS payload
)
SELECT is(
  (SELECT payload->>'status' FROM recorded),
  'recorded',
  'mismatched source token writes one rejection event'
);

SELECT is(
  (SELECT failure_code FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  'source_token_mismatch',
  'mismatch lineage keeps its failure code'
);
SELECT is(
  (SELECT metadata->>'source_resolution' FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  'unresolved_source_token',
  'unknown presented token is classified without source fabrication'
);
SELECT ok(
  (SELECT token_fingerprint IS NOT NULL AND token_fingerprint <> 'plain-secret-token-never-persist'
     FROM public.intake_auth_rejections
    WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  'raw source token is replaced by a one-way fingerprint'
);
SELECT is(
  (SELECT request_headers->>'authorization' FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  NULL::TEXT,
  'authorization header is removed'
);
SELECT is(
  (SELECT request_headers->>'x-forwarded-url' FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  '/api-gateway/t/[redacted]/v1?signature=[redacted]',
  'nested forwarded URL secrets are redacted'
);
SELECT is(
  (SELECT path FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  '/api-gateway/t/[redacted]/v1?api_key=[redacted]',
  'path token and query secret are redacted'
);
SELECT is(
  (SELECT query_string FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  'token=[redacted]&signature=[redacted]&keep=value',
  'query-string secrets are redacted'
);
SELECT is(
  (SELECT metadata->>'credential' FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  'REDACTED',
  'credential metadata is redacted recursively'
);
SELECT is(
  (SELECT metadata->>'retired_token_history_id' FROM public.intake_auth_rejections WHERE request_id = 'pgtap-auth-rejection-mismatch'),
  'REDACTED',
  'internal retired-token history identifiers are redacted'
);

SELECT is(
  (
    public.record_intake_auth_rejection_v1(jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'credential_kind', 'hmac_signature',
      'failure_code', 'hmac_signature_mismatch',
      'request_id', 'pgtap-hmac-mismatch'
    ))
  )->>'status',
  'recorded',
  'HMAC mismatch lineage is recordable without operational state'
);
SELECT is(
  (
    public.record_intake_auth_rejection_v1(jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'credential_kind', 'hmac_signature',
      'failure_code', 'hmac_credential_expired',
      'request_id', 'pgtap-hmac-expired'
    ))
  )->>'status',
  'recorded',
  'expired HMAC credential lineage is recordable'
);
SELECT is(
  (
    public.record_intake_auth_rejection_v1(jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'credential_kind', 'hmac_signature',
      'failure_code', 'hmac_credential_unavailable',
      'request_id', 'pgtap-hmac-unavailable'
    ))
  )->>'status',
  'recorded',
  'unavailable HMAC credential lineage is recordable'
);
SELECT is(
  (SELECT metadata->>'provider_credential_state' FROM public.intake_auth_rejections WHERE request_id = 'pgtap-hmac-unavailable'),
  'missing_reference',
  'HMAC rejection without an auth-config reference remains explicit'
);

SELECT throws_ok(
  $$ UPDATE public.intake_auth_rejections
        SET failure_message = 'mutated'
      WHERE request_id = 'pgtap-auth-rejection-mismatch' $$,
  '2F003',
  'intake_auth_rejections is append-only and immutable'
);
SELECT throws_ok(
  $$ DELETE FROM public.intake_auth_rejections
      WHERE request_id = 'pgtap-auth-rejection-mismatch' $$,
  '2F003',
  'intake_auth_rejections is append-only and immutable'
);

SELECT ok(
  (SELECT COUNT(*) FROM public.api_gateway_requests) = (SELECT api_gateway_requests FROM pgtap_auth_rejection_counts)
  AND (SELECT COUNT(*) FROM public.webhook_inbox) = (SELECT webhook_inbox FROM pgtap_auth_rejection_counts)
  AND (SELECT COUNT(*) FROM public.outbound_calls) = (SELECT outbound_calls FROM pgtap_auth_rejection_counts)
  AND (SELECT COUNT(*) FROM public.workflow_runs) = (SELECT workflow_runs FROM pgtap_auth_rejection_counts)
  AND (SELECT COUNT(*) FROM public.shipments) = (SELECT shipments FROM pgtap_auth_rejection_counts),
  'rejection recording never fabricates request, inbox, outbound, workflow, or shipment truth'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND COALESCE(sv.value->'resources', '[]'::jsonb) @> '[{"key":"api_gateway_auth_rejections"}]'::jsonb
  ),
  'API gateway rejection resource is row-driven in ui_read_registry'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND COALESCE(sv.value->'resources', '[]'::jsonb) @> '[{"key":"webhook_auth_rejections"}]'::jsonb
  ),
  'webhook rejection resource is row-driven in ui_read_registry'
);

-- Actual terminal-decision trigger proof. All owned rows and onboarding
-- isolation are restored by the enclosing ROLLBACK; this is not HTTP proof.
SELECT public.create_next_partitions();
CREATE FUNCTION pg_temp.f225_terminal_mirror_proof()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $fixture$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_provider_id UUID := gen_random_uuid();
  v_auth UUID := gen_random_uuid();
  v_inbox UUID := gen_random_uuid();
  v_context UUID := gen_random_uuid();
  v_replay UUID := gen_random_uuid();
  v_request TEXT := 'pgtap-f225-' || gen_random_uuid()::text;
  v_provider TEXT;
  v_policy UUID;
  v_inputs JSONB := '{"status":400,"validation_results":{"hmac":{"status":"failed","message":"HMAC signature mismatch"}}}';
  v_before BIGINT;
BEGIN
  -- Same rollback-only isolation as 025_webhook_policy_ladder.sql.
  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy', public.get_root_scope_type_key_v1(), NULL,
    jsonb_build_object(
      'version',1,'enabled',FALSE,'ensure_global_required_defaults',FALSE,
      'materialize_defaults',jsonb_build_object(
        'tenant',jsonb_build_object('use_registry_required_defaults',FALSE,'strict_required_coverage',FALSE,'include_categories','[]'::jsonb,'exclude_categories','[]'::jsonb),
        'client',jsonb_build_object('use_registry_required_defaults',FALSE,'strict_required_coverage',FALSE,'include_categories','[]'::jsonb,'exclude_categories','[]'::jsonb),
        'sender',jsonb_build_object('use_registry_required_defaults',FALSE,'strict_required_coverage',FALSE,'include_categories','[]'::jsonb,'exclude_categories','[]'::jsonb)),
      'rbac',jsonb_build_object('provision_templates',FALSE,'template_keys','[]'::jsonb),
      'client_defaults',jsonb_build_object('create_default_sender',FALSE,'default_sender_name','Default Sender','default_sender_brand_name',NULL)),
    1,'pgTAP F225 rollback-only fixture isolation');
  SELECT lv.value INTO STRICT v_provider
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id=ld.id
   WHERE ld.category='integration_type' AND COALESCE(lv.status,'active')='active'
   ORDER BY COALESCE(lv.sort_order,2147483647),lv.value LIMIT 1;
  INSERT INTO public.organizations(id,name,slug,timezone,locale,billing_status,default_settings)
  VALUES(v_org,'pgTAP F225','pgtap-'||v_org::text,'Asia/Riyadh','en-US','active','{}');
  INSERT INTO public.clients(id,organization_id,name,slug,sla_tier,status,settings_override)
  VALUES(v_client,v_org,'pgTAP F225','pgtap-'||v_client::text,'standard','active','{}');
  INSERT INTO public.senders(id,client_id,name,brand_name,auto_provisioned,auto_recreate,status,settings_override)
  VALUES(v_sender,v_client,'pgTAP F225','pgTAP',FALSE,TRUE,'active','{}');
  INSERT INTO public.mapping_configs(id,organization_id,mapping_type,mapping_key,mapping_config,mapping_version,notes)
  VALUES(v_mapping,v_org,'webhook_inbound','pgtap-'||v_mapping::text,
    '{"external_id_path":"event.id","event_type_path":"event.type"}',1,'Rollback-only F225 fixture');
  INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id,enabled,sender_id,rate_limit_per_hour)
  VALUES(v_source,v_org,'pgtap-'||v_source::text,'pgTAP F225',v_provider,'pgtap-f225-token',v_mapping,TRUE,v_sender,1000);
  INSERT INTO public.providers(id,organization_id,name,provider_type,metadata)
  VALUES(v_provider_id,v_org,'pgTAP F225','3pl','{}');
  INSERT INTO public.provider_auth_configs(id,provider_id,auth_type,credentials_vault_id,credentials,expires_at)
  VALUES(v_auth,v_provider_id,'hmac',NULL,'{"signing_secret":"pgtap-f225-signing-secret"}',NULL);
  v_policy := public.upsert_webhook_ingest_policy('source',v_source,
    jsonb_build_object('version',1,
      'ack',jsonb_build_object('mode','synchronous_success','status_code',200),
      'validation',jsonb_build_object('hmac',jsonb_build_object(
        'enabled',TRUE,'header','x-signature','algorithm','HMAC-SHA256',
        'signature_encoding','hex','auth_config_id',v_auth))));
  INSERT INTO public.request_contexts(id,entry_point) VALUES(v_context,'webhook'),(v_replay,'webhook');
  INSERT INTO public.webhook_inbox(id,organization_id,webhook_source_id,provider_type,
    external_id,idempotency_key,raw_payload,headers,processing_status,correlation_id,
    policy_scope_type,policy_scope_id,policy_settings_id,policy_version)
  VALUES(v_inbox,v_org,v_source,v_provider,v_request,v_request,'{}',
    '{"x-signature":"pgtap-f225-signature","authorization":"Bearer pgtap-f225-token"}',
    'failed',v_context,'source',v_source,v_policy,1);
  PERFORM public.log_decision(v_org,'http_response_emitted','webhook_inbox',v_inbox,
    'pgtap-f225','response_failed','workflow_intake_webhook_core_v1',v_context,v_inputs);
  RETURN NEXT is((SELECT count(*) FROM public.intake_auth_rejections
    WHERE source_id=v_source AND metadata->>'webhook_inbox_id'=v_inbox::text),1::bigint,
    'terminal HMAC decision creates exactly one rejection for its actual inbox');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.intake_auth_rejections
    WHERE source_id=v_source AND metadata->>'webhook_inbox_id'=v_inbox::text
      AND service='webhook_receiver' AND surface='webhook_receiver'
      AND credential_kind='hmac_signature' AND failure_code='hmac_signature_mismatch' AND http_status=400),
    'terminal HMAC mirror preserves classification and HTTP status');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.intake_auth_rejections
    WHERE source_id=v_source AND metadata->>'webhook_inbox_id'=v_inbox::text
      AND organization_id=v_org AND correlation_id=v_context AND request_id=v_request
      AND provider_auth_config_id=v_auth AND metadata->>'provider_credential_state'='available'),
    'terminal HMAC mirror retains canonical source request and provider credential lineage');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.intake_auth_rejections
    WHERE source_id=v_source AND metadata->>'webhook_inbox_id'=v_inbox::text
      AND metadata->>'edge_stage'='workflow_intake_webhook_core_v1'
      AND metadata->>'auth_surface'='hmac_signature'),
    'terminal HMAC mirror identifies its canonical intake stage');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.intake_auth_rejections r
    WHERE source_id=v_source AND metadata->>'webhook_inbox_id'=v_inbox::text
      AND (to_jsonb(r)::text LIKE '%pgtap-f225-signature%'
        OR to_jsonb(r)::text LIKE '%pgtap-f225-token%'
        OR to_jsonb(r)::text LIKE '%pgtap-f225-signing-secret%')),
    'terminal HMAC mirror does not persist synthetic signature token or signing secret');
  SELECT count(*) INTO v_before FROM public.intake_auth_rejections
    WHERE source_id=v_source AND metadata->>'webhook_inbox_id'=v_inbox::text;
  PERFORM public.log_decision(v_org,'http_response_emitted','webhook_inbox',v_inbox,
    'pgtap-f225-replay','response_replayed','workflow_intake_webhook_core_v1',v_replay,v_inputs);
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.decision_log
    WHERE resource_id=v_inbox AND correlation_id=v_replay
      AND decision_category='http_response_emitted' AND decision_outcome='response_replayed'),
    'different-correlation replay decision is actually persisted');
  RETURN NEXT is((SELECT count(*) FROM public.intake_auth_rejections
    WHERE source_id=v_source AND metadata->>'webhook_inbox_id'=v_inbox::text),v_before,
    'different-correlation replay does not duplicate terminal HMAC rejection');
END;
$fixture$;
SELECT * FROM pg_temp.f225_terminal_mirror_proof();

SELECT finish();

ROLLBACK;

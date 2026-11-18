BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(63);

SELECT has_table('public', 'intake_auth_rejections', 'intake auth rejection ledger exists');
SELECT has_view('public', 'v_intake_auth_rejection_directory', 'intake auth rejection directory view exists');
SELECT has_function('public', 'record_intake_auth_rejection_v1', ARRAY['jsonb'], 'public record_intake_auth_rejection_v1 exists');
SELECT has_function('api', 'record_intake_auth_rejection_v1', ARRAY['jsonb'], 'api record_intake_auth_rejection_v1 wrapper exists');
SELECT has_function('public', 'redact_intake_auth_secret_text', ARRAY['text'], 'public redact_intake_auth_secret_text exists');
SELECT has_function('public', 'redact_intake_auth_secret_json', ARRAY['jsonb'], 'public redact_intake_auth_secret_json exists');
SELECT has_table('public', 'webhook_source_token_history', 'retired webhook source token lineage table exists');
SELECT has_function('public', 'resolve_retired_webhook_source_by_token_v1', ARRAY['text'], 'retired webhook source token resolver exists');

SELECT col_not_null('public', 'intake_auth_rejections', 'service', 'service is required');
SELECT col_not_null('public', 'intake_auth_rejections', 'failure_code', 'failure_code is required');
SELECT col_not_null('public', 'intake_auth_rejections', 'http_status', 'http_status is required');
SELECT col_not_null('public', 'intake_auth_rejections', 'request_headers', 'request_headers is required');

WITH recorded AS (
  SELECT public.record_intake_auth_rejection_v1(
    jsonb_build_object(
      'service', 'api_gateway',
      'surface', 'api_gateway',
      'token', 'plain-secret-token-never-persist',
      'http_status', 401,
      'failure_code', 'invalid_token',
      'failure_message', 'Invalid API gateway token',
      'method', 'POST',
      'path', '/api-gateway/t/plain-secret-token-never-persist/v1/shipments?api_key=leaky-api-key&signature=leaky-signature',
      'query_string', 'token=plain-secret-token-never-persist&api_key=leaky-api-key&signature=leaky-signature&keep=value',
      'headers', jsonb_build_object(
        'authorization', 'Bearer plain-secret-token-never-persist',
        'x-webhook-token', 'plain-secret-token-never-persist',
        'x-forwarded-url', '/api-gateway/t/plain-secret-token-never-persist/v1/shipments?api_key=leaky-api-key&signature=leaky-signature&keep=value',
        'x-correlation-id', 'd92bfc4d-f370-456c-8c60-8a0272819ab4'
      ),
      'correlation_id', 'd92bfc4d-f370-456c-8c60-8a0272819ab4',
      'request_id', 'req_auth_rejection_contract',
      'metadata', jsonb_build_object(
        'edge_stage', 'pgtap',
        'retired_token_history_id', gen_random_uuid()::text,
        'nested', jsonb_build_object(
          'signature', 'nested-signature-secret',
          'forwarded', '/api-gateway/t/plain-secret-token-never-persist/v1/shipments?token=plain-secret-token-never-persist'
        )
      )
    )
  ) AS payload
),
row_id AS (
  SELECT (payload->>'id')::uuid AS id FROM recorded
)
SELECT is(
  (SELECT payload->>'status' FROM recorded),
  'recorded',
  'record function returns recorded status'
);

SELECT is(
  (SELECT failure_code FROM public.intake_auth_rejections WHERE request_id = 'req_auth_rejection_contract'),
  'invalid_token',
  'ledger persists failure code'
);

SELECT is(
  (SELECT request_headers->>'authorization' FROM public.intake_auth_rejections WHERE request_id = 'req_auth_rejection_contract'),
  'REDACTED',
  'authorization header is redacted'
);

SELECT is(
  (SELECT request_headers->>'x-webhook-token' FROM public.intake_auth_rejections WHERE request_id = 'req_auth_rejection_contract'),
  'REDACTED',
  'source token header is redacted'
);

SELECT is(
  (SELECT request_headers->>'x-forwarded-url' FROM public.intake_auth_rejections WHERE request_id = 'req_auth_rejection_contract'),
  '/api-gateway/t/[redacted]/v1/shipments?api_key=[redacted]&signature=[redacted]&keep=value',
  'forwarded URL header secret values are redacted'
);

SELECT ok(
  (SELECT token_fingerprint IS NOT NULL AND token_fingerprint <> 'plain-secret-token-never-persist'
     FROM public.intake_auth_rejections
    WHERE request_id = 'req_auth_rejection_contract'),
  'raw token is replaced by a fingerprint'
);

SELECT is(
  (SELECT path FROM public.intake_auth_rejections WHERE request_id = 'req_auth_rejection_contract'),
  '/api-gateway/t/[redacted]/v1/shipments?api_key=[redacted]&signature=[redacted]',
  'path token segment and secret query values are redacted'
);

SELECT is(
  (SELECT query_string FROM public.intake_auth_rejections WHERE request_id = 'req_auth_rejection_contract'),
  'token=[redacted]&api_key=[redacted]&signature=[redacted]&keep=value',
  'query-string secret values are redacted'
);

SELECT is(
  (SELECT metadata #>> '{nested,signature}' FROM public.intake_auth_rejections WHERE request_id = 'req_auth_rejection_contract'),
  'REDACTED',
  'nested metadata secret keys are redacted'
);

SELECT is(
  (SELECT metadata #>> '{nested,forwarded}' FROM public.v_intake_auth_rejection_directory WHERE request_id = 'req_auth_rejection_contract'),
  '/api-gateway/t/[redacted]/v1/shipments?token=[redacted]',
  'directory projection redacts nested metadata URL values'
);

SELECT is(
  (SELECT metadata->>'retired_token_history_id' FROM public.v_intake_auth_rejection_directory WHERE request_id = 'req_auth_rejection_contract'),
  'REDACTED',
  'directory projection redacts retired token history lineage ids'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory
     WHERE request_id = 'req_auth_rejection_contract'
       AND service = 'api_gateway'
       AND http_status = 401
  ),
  'directory view exposes the recorded rejection'
);

WITH recorded AS (
  SELECT public.record_intake_auth_rejection_v1(
    jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'token', 'webhook-secret-token-never-persist',
      'http_status', 403,
      'failure_code', 'disabled_source',
      'failure_message', 'Webhook source token was invalid or disabled',
      'method', 'POST',
      'path', '/functions/v1/webhook-receiver?api_key=webhook-api-key&signature=webhook-signature',
      'headers', jsonb_build_object(
        'authorization', 'Bearer webhook-secret-token-never-persist',
        'x-webhook-token', 'webhook-secret-token-never-persist',
        'x-forwarded-url', '/functions/v1/webhook-receiver?token=webhook-secret-token-never-persist&api_key=webhook-api-key&keep=value'
      ),
      'request_id', 'req_webhook_auth_rejection_contract',
      'metadata', jsonb_build_object(
        'edge_stage', 'pgtap',
        'credential', 'webhook-secret-token-never-persist',
        'nested', jsonb_build_object(
          'password', 'nested-password-secret',
          'callback', '/functions/v1/webhook-receiver?signature=webhook-signature'
        )
      )
    )
  ) AS payload
)
SELECT is(
  (SELECT payload->>'status' FROM recorded),
  'recorded',
  'webhook rejection record function returns recorded status'
);

SELECT is(
  (SELECT failure_code FROM public.intake_auth_rejections WHERE request_id = 'req_webhook_auth_rejection_contract'),
  'disabled_source',
  'webhook ledger persists failure code'
);

SELECT is(
  (SELECT path FROM public.intake_auth_rejections WHERE request_id = 'req_webhook_auth_rejection_contract'),
  '/functions/v1/webhook-receiver?api_key=[redacted]&signature=[redacted]',
  'webhook path secret query values are redacted'
);

SELECT is(
  (SELECT request_headers->>'x-forwarded-url' FROM public.intake_auth_rejections WHERE request_id = 'req_webhook_auth_rejection_contract'),
  '/functions/v1/webhook-receiver?token=[redacted]&api_key=[redacted]&keep=value',
  'webhook forwarded URL header secret values are redacted'
);

SELECT is(
  (SELECT metadata->>'credential' FROM public.intake_auth_rejections WHERE request_id = 'req_webhook_auth_rejection_contract'),
  'REDACTED',
  'webhook metadata credential value is redacted'
);

SELECT is(
  (SELECT metadata #>> '{nested,password}' FROM public.v_intake_auth_rejection_directory WHERE request_id = 'req_webhook_auth_rejection_contract'),
  'REDACTED',
  'webhook directory projection redacts nested metadata secrets'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory
     WHERE request_id = 'req_webhook_auth_rejection_contract'
       AND service = 'webhook_receiver'
       AND http_status = 403
  ),
  'directory view exposes the recorded webhook rejection'
);

DO $disabled_seed$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000f981';
  v_client UUID := '00000000-0000-0000-0000-00000000f982';
  v_sender UUID := '00000000-0000-0000-0000-00000000f983';
  v_mapping UUID := '00000000-0000-0000-0000-00000000f984';
  v_source UUID := '00000000-0000-0000-0000-00000000f985';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Auth Rejection Disabled Source Org', 'auth-rejection-disabled-source')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Disabled Source Client', 'disabled-source-client', 'active')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
  VALUES (v_sender, v_client, 'Disabled Source Sender', 'Disabled Source Sender', false, true, 'active')
  ON CONFLICT (id) DO UPDATE
  SET client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'disabled-source-token-lineage::default',
    '{}'::jsonb,
    1,
    'Disabled source token lineage pgTAP mapping'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    sender_id,
    enabled
  )
  VALUES (
    v_source,
    v_org,
    'disabled-source-token-lineage',
    'Disabled Source Token Lineage Source',
    'generic',
    'pgtap-disabled-source-token',
    v_mapping,
    v_sender,
    FALSE
  )
  ON CONFLICT (id) DO UPDATE
  SET auth_token = EXCLUDED.auth_token,
      sender_id = EXCLUDED.sender_id,
      enabled = FALSE,
      updated_at = now();

  PERFORM set_config('test.disabled_token_org', v_org::text, true);
  PERFORM set_config('test.disabled_token_client', v_client::text, true);
  PERFORM set_config('test.disabled_token_sender', v_sender::text, true);
  PERFORM set_config('test.disabled_token_source', v_source::text, true);
END;
$disabled_seed$;

WITH recorded AS (
  SELECT public.record_intake_auth_rejection_v1(
    jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'token', 'pgtap-disabled-source-token',
      'http_status', 401,
      'failure_code', 'unauthorized webhook source',
      'failure_message', 'Unauthorized webhook source',
      'method', 'POST',
      'path', '/functions/v1/webhook-receiver',
      'headers', jsonb_build_object('x-webhook-token', 'pgtap-disabled-source-token'),
      'request_id', 'req_disabled_source_token_rejection_contract',
      'metadata', jsonb_build_object('edge_stage', 'pgtap')
    )
  ) AS payload
)
SELECT is(
  (SELECT payload->>'source_id' FROM recorded),
  current_setting('test.disabled_token_source'),
  'disabled source token rejection resolves the original source id'
);

SELECT is(
  (SELECT organization_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_disabled_source_token_rejection_contract'),
  current_setting('test.disabled_token_org'),
  'disabled source token rejection resolves tenant organization for Console readback'
);

SELECT is(
  (SELECT client_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_disabled_source_token_rejection_contract'),
  current_setting('test.disabled_token_client'),
  'disabled source token rejection resolves client context'
);

SELECT is(
  (SELECT sender_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_disabled_source_token_rejection_contract'),
  current_setting('test.disabled_token_sender'),
  'disabled source token rejection resolves sender context'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory
     WHERE request_id = 'req_disabled_source_token_rejection_contract'
       AND source_resolved IS TRUE
       AND source_identifier = 'disabled-source-token-lineage'
       AND http_status = 401
       AND failure_code = 'unauthorized webhook source'
  ),
  'directory view exposes disabled-source-token rejection with resolved source label'
);

SELECT is(
  (SELECT count(*)::integer FROM public.webhook_inbox WHERE idempotency_key = 'req_disabled_source_token_rejection_contract'),
  0,
  'disabled source token rejection does not create a webhook inbox row'
);

DO $retired_seed$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000f941';
  v_user UUID := '00000000-0000-0000-0000-00000000f942';
  v_client UUID := '00000000-0000-0000-0000-00000000f943';
  v_sender UUID := '00000000-0000-0000-0000-00000000f944';
  v_mapping UUID := '00000000-0000-0000-0000-00000000f945';
  v_source UUID := '00000000-0000-0000-0000-00000000f946';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Auth Rejection Retired Token Org', 'auth-rejection-retired-token')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES (
    v_user,
    v_org,
    'auth-rejection-retired-token@example.test',
    'Auth Rejection Retired Token Admin',
    'ops_admin',
    'tenant',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      status = EXCLUDED.status;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Retired Token Client', 'retired-token-client', 'active')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
  VALUES (v_sender, v_client, 'Retired Token Sender', 'Retired Token Sender', false, true, 'active')
  ON CONFLICT (id) DO UPDATE
  SET client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'retired-token-lineage::default',
    '{}'::jsonb,
    1,
    'Retired token lineage pgTAP mapping'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    sender_id,
    enabled
  )
  VALUES (
    v_source,
    v_org,
    'retired-token-lineage',
    'Retired Token Lineage Source',
    'generic',
    'pgtap-retired-lineage-token',
    v_mapping,
    v_sender,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
  SET auth_token = EXCLUDED.auth_token,
      sender_id = EXCLUDED.sender_id,
      enabled = TRUE,
      updated_at = now();

  PERFORM set_config('test.retired_token_org', v_org::text, true);
  PERFORM set_config('test.retired_token_user', v_user::text, true);
  PERFORM set_config('test.retired_token_client', v_client::text, true);
  PERFORM set_config('test.retired_token_sender', v_sender::text, true);
  PERFORM set_config('test.retired_token_source', v_source::text, true);
END;
$retired_seed$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.retired_token_user'), true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE _retired_token_rotation AS
SELECT public.ui_rotate_webhook_source_token_v1(
  jsonb_build_object('source_id', current_setting('test.retired_token_source'))
) AS payload;
RESET ROLE;

SELECT ok(
  (SELECT (payload->>'ok')::boolean FROM _retired_token_rotation),
  'rotating a source token succeeds before retired-token rejection proof'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.webhook_source_token_history
     WHERE source_id = current_setting('test.retired_token_source')::uuid
       AND organization_id = current_setting('test.retired_token_org')::uuid
       AND retired_reason = 'rotated'
  ),
  'source token rotation preserves retired token hash lineage'
);

SELECT isnt(
  (SELECT retired_auth_token_hash
     FROM public.webhook_source_token_history
    WHERE source_id = current_setting('test.retired_token_source')::uuid
    ORDER BY retired_at DESC
    LIMIT 1),
  'pgtap-retired-lineage-token',
  'retired token lineage never stores the raw token'
);

WITH recorded AS (
  SELECT public.record_intake_auth_rejection_v1(
    jsonb_build_object(
      'service', 'webhook_receiver',
      'surface', 'webhook_receiver',
      'token', 'pgtap-retired-lineage-token',
      'http_status', 401,
      'failure_code', 'unauthorized webhook source',
      'failure_message', 'Unauthorized webhook source',
      'method', 'POST',
      'path', '/functions/v1/webhook-receiver',
      'headers', jsonb_build_object('x-webhook-token', 'pgtap-retired-lineage-token'),
      'request_id', 'req_retired_token_rejection_contract',
      'metadata', jsonb_build_object('edge_stage', 'pgtap')
    )
  ) AS payload
)
SELECT is(
  (SELECT payload->>'source_id' FROM recorded),
  current_setting('test.retired_token_source'),
  'retired token rejection resolves the original source id'
);

SELECT is(
  (SELECT organization_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_retired_token_rejection_contract'),
  current_setting('test.retired_token_org'),
  'retired token rejection resolves tenant organization for Console readback'
);

SELECT is(
  (SELECT client_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_retired_token_rejection_contract'),
  current_setting('test.retired_token_client'),
  'retired token rejection resolves client context'
);

SELECT is(
  (SELECT sender_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_retired_token_rejection_contract'),
  current_setting('test.retired_token_sender'),
  'retired token rejection resolves sender context'
);

SELECT is(
  (SELECT metadata->>'source_resolution' FROM public.intake_auth_rejections WHERE request_id = 'req_retired_token_rejection_contract'),
  'retired_webhook_source_token',
  'retired token rejection records lineage resolution metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory
     WHERE request_id = 'req_retired_token_rejection_contract'
       AND source_resolved IS TRUE
       AND source_identifier = 'retired-token-lineage'
  ),
  'directory view exposes retired-token rejection with resolved source label'
);

WITH recorded AS (
  SELECT public.record_intake_auth_rejection_v1(
    jsonb_build_object(
      'service', 'api_gateway',
      'surface', 'api_gateway',
      'token', 'pgtap-retired-lineage-token',
      'http_status', 401,
      'failure_code', 'invalid_token',
      'failure_message', 'invalid_token',
      'method', 'POST',
      'path', '/api/ship/request/by-email',
      'headers', jsonb_build_object(
        'authorization', 'Bearer pgtap-retired-lineage-token',
        'x-webhook-token', 'pgtap-retired-lineage-token'
      ),
      'request_id', 'req_retired_api_gateway_token_contract',
      'metadata', jsonb_build_object('edge_stage', 'workflow_intake_api_gateway_v1')
    )
  ) AS payload
)
SELECT is(
  (SELECT payload->>'source_id' FROM recorded),
  current_setting('test.retired_token_source'),
  'api gateway retired token rejection resolves the original source id'
);

SELECT is(
  (SELECT organization_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_retired_api_gateway_token_contract'),
  current_setting('test.retired_token_org'),
  'api gateway retired token rejection resolves tenant organization'
);

SELECT is(
  (SELECT metadata->>'source_resolution' FROM public.intake_auth_rejections WHERE request_id = 'req_retired_api_gateway_token_contract'),
  'retired_webhook_source_token',
  'api gateway retired token rejection records lineage resolution metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory
     WHERE request_id = 'req_retired_api_gateway_token_contract'
       AND service = 'api_gateway'
       AND source_resolved IS TRUE
       AND source_identifier = 'retired-token-lineage'
       AND request_headers::text NOT LIKE '%pgtap-retired-lineage-token%'
  ),
  'api gateway directory exposes retired-token rejection with source context and redacted headers'
);

DO $api_disabled_seed$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000fa81';
  v_client UUID := '00000000-0000-0000-0000-00000000fa82';
  v_sender UUID := '00000000-0000-0000-0000-00000000fa83';
  v_mapping UUID := '00000000-0000-0000-0000-00000000fa84';
  v_source UUID := '00000000-0000-0000-0000-00000000fa85';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Auth Rejection API Disabled Source Org', 'auth-rejection-api-disabled-source')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'API Disabled Source Client', 'api-disabled-source-client', 'active')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
  VALUES (v_sender, v_client, 'API Disabled Source Sender', 'API Disabled Source Sender', false, true, 'active')
  ON CONFLICT (id) DO UPDATE
  SET client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'api-disabled-source-token-lineage::default',
    '{}'::jsonb,
    1,
    'API disabled source token lineage pgTAP mapping'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    sender_id,
    enabled
  )
  VALUES (
    v_source,
    v_org,
    'api-disabled-source-token-lineage',
    'API Disabled Source Token Lineage Source',
    'api_gateway',
    'pgtap-api-disabled-source-token',
    v_mapping,
    v_sender,
    FALSE
  )
  ON CONFLICT (id) DO UPDATE
  SET provider_type = EXCLUDED.provider_type,
      auth_token = EXCLUDED.auth_token,
      sender_id = EXCLUDED.sender_id,
      enabled = FALSE,
      updated_at = now();

  PERFORM set_config('test.api_disabled_token_org', v_org::text, true);
  PERFORM set_config('test.api_disabled_token_client', v_client::text, true);
  PERFORM set_config('test.api_disabled_token_sender', v_sender::text, true);
  PERFORM set_config('test.api_disabled_token_source', v_source::text, true);
END;
$api_disabled_seed$;

WITH recorded AS (
  SELECT public.record_intake_auth_rejection_v1(
    jsonb_build_object(
      'service', 'api_gateway',
      'surface', 'api_gateway',
      'token', 'pgtap-api-disabled-source-token',
      'http_status', 401,
      'failure_code', 'invalid_token',
      'failure_message', 'invalid_token',
      'method', 'POST',
      'path', '/api/demo/disabled-source/pgtap',
      'headers', jsonb_build_object(
        'authorization', 'Bearer pgtap-api-disabled-source-token',
        'x-webhook-token', 'pgtap-api-disabled-source-token'
      ),
      'request_id', 'req_api_disabled_source_token_rejection_contract',
      'correlation_id', '00000000-0000-4000-8000-00000000fa85',
      'metadata', jsonb_build_object('edge_stage', 'workflow_intake_api_gateway_v1')
    )
  ) AS payload
)
SELECT is(
  (SELECT payload->>'source_id' FROM recorded),
  current_setting('test.api_disabled_token_source'),
  'api gateway disabled source token rejection resolves the original source id'
);

SELECT is(
  (SELECT organization_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_api_disabled_source_token_rejection_contract'),
  current_setting('test.api_disabled_token_org'),
  'api gateway disabled source token rejection resolves tenant organization'
);

SELECT is(
  (SELECT client_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_api_disabled_source_token_rejection_contract'),
  current_setting('test.api_disabled_token_client'),
  'api gateway disabled source token rejection resolves client context'
);

SELECT is(
  (SELECT sender_id::text FROM public.intake_auth_rejections WHERE request_id = 'req_api_disabled_source_token_rejection_contract'),
  current_setting('test.api_disabled_token_sender'),
  'api gateway disabled source token rejection resolves sender context'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory
     WHERE request_id = 'req_api_disabled_source_token_rejection_contract'
       AND service = 'api_gateway'
       AND source_resolved IS TRUE
       AND source_identifier = 'api-disabled-source-token-lineage'
       AND http_status = 401
       AND failure_code = 'invalid_token'
       AND request_headers::text NOT LIKE '%pgtap-api-disabled-source-token%'
  ),
  'api gateway directory exposes disabled-source-token rejection with source context and redacted headers'
);

SELECT is(
  (SELECT count(*)::integer FROM public.api_gateway_requests WHERE path = '/api/demo/disabled-source/pgtap'),
  0,
  'api gateway disabled source token rejection does not create an API gateway request row'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbound_calls WHERE correlation_id = '00000000-0000-4000-8000-00000000fa85'),
  0,
  'api gateway disabled source token rejection does not create an outbound call row'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND resource->>'key' = 'api_gateway_auth_rejections'
       AND resource->>'relation' = 'public.v_intake_auth_rejection_directory'
  ),
  'api gateway auth rejections are registered for Console reads'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND resource->>'key' = 'webhook_auth_rejections'
       AND resource->>'relation' = 'public.v_intake_auth_rejection_directory'
  ),
  'webhook auth rejections are registered for Console reads'
);

DO $$
DECLARE
  v_org_api_only UUID := gen_random_uuid();
  v_org_webhook_only UUID := gen_random_uuid();
  v_user_api_only UUID := gen_random_uuid();
  v_user_webhook_only UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_api_only, 'Auth Rejection API Only Org', 'auth-rejection-api-only-' || left(v_org_api_only::text, 8)),
    (v_org_webhook_only, 'Auth Rejection Webhook Only Org', 'auth-rejection-webhook-only-' || left(v_org_webhook_only::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_api_only, v_org_api_only, 'auth-api-only-' || left(v_user_api_only::text, 8) || '@example.com', 'Auth API Only', 'ops_admin', 'tenant', NULL),
    (v_user_webhook_only, v_org_webhook_only, 'auth-webhook-only-' || left(v_user_webhook_only::text, 8) || '@example.com', 'Auth Webhook Only', 'ops_admin', 'tenant', NULL);

  INSERT INTO public.intake_auth_rejections (
    service,
    surface,
    credential_kind,
    failure_code,
    failure_message,
    http_status,
    organization_id,
    request_id,
    method,
    path,
    request_headers,
    metadata
  )
  VALUES
    ('api_gateway', 'api_gateway', 'source_token', 'invalid_token', 'api visible to api capability only', 401, v_org_api_only, 'req_rls_api_visible', 'POST', '/api-gateway/t/[redacted]', '{}'::jsonb, '{}'::jsonb),
    ('webhook_receiver', 'webhook_receiver', 'source_token', 'disabled_source', 'webhook hidden from api capability only', 403, v_org_api_only, 'req_rls_webhook_hidden_from_api', 'POST', '/webhook', '{}'::jsonb, '{}'::jsonb),
    ('api_gateway', 'api_gateway', 'source_token', 'invalid_token', 'api hidden from webhook capability only', 401, v_org_webhook_only, 'req_rls_api_hidden_from_webhook', 'POST', '/api-gateway/t/[redacted]', '{}'::jsonb, '{}'::jsonb),
    ('webhook_receiver', 'webhook_receiver', 'source_token', 'disabled_source', 'webhook visible to webhook capability only', 403, v_org_webhook_only, 'req_rls_webhook_visible', 'POST', '/webhook', '{}'::jsonb, '{}'::jsonb);

  PERFORM 1
  FROM public.upsert_settings_value_v1(
    'access_control_policy',
    'tenant',
    v_org_api_only,
    jsonb_build_object(
      'denies',
      jsonb_build_array(
        jsonb_build_object('capability_key', 'webhooks.read', 'scope_type', 'tenant', 'scope_id', v_org_api_only::text, 'reason', 'test deny webhooks')
      )
    ),
    1,
    'test auth rejection api-only split'
  );

  PERFORM 1
  FROM public.upsert_settings_value_v1(
    'access_control_policy',
    'tenant',
    v_org_webhook_only,
    jsonb_build_object(
      'denies',
      jsonb_build_array(
        jsonb_build_object('capability_key', 'api_gateway.read', 'scope_type', 'tenant', 'scope_id', v_org_webhook_only::text, 'reason', 'test deny api gateway')
      )
    ),
    1,
    'test auth rejection webhook-only split'
  );

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';

  PERFORM set_config('request.jwt.claim.sub', v_user_api_only::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM is(
    (SELECT count(*)::integer FROM public.v_intake_auth_rejection_directory WHERE request_id = 'req_rls_api_visible'),
    1,
    'api_gateway.read user sees api gateway rejection rows'
  );
  PERFORM is(
    (SELECT count(*)::integer FROM public.v_intake_auth_rejection_directory WHERE request_id = 'req_rls_webhook_hidden_from_api'),
    0,
    'api_gateway.read user cannot see webhook rejection rows without webhooks.read'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_webhook_only::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM is(
    (SELECT count(*)::integer FROM public.v_intake_auth_rejection_directory WHERE request_id = 'req_rls_webhook_visible'),
    1,
    'webhooks.read user sees webhook rejection rows'
  );
  PERFORM is(
    (SELECT count(*)::integer FROM public.v_intake_auth_rejection_directory WHERE request_id = 'req_rls_api_hidden_from_webhook'),
    0,
    'webhooks.read user cannot see api gateway rejection rows without api_gateway.read'
  );
  EXECUTE 'RESET ROLE';
END $$;

SELECT finish();

ROLLBACK;

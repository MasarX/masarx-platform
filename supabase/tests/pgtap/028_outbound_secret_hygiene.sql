-- Test Suite: Outbound secret hygiene (auth injection + redacted logs)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

-- Ensure time partitions exist for api_call_log inserts during the test window.
SELECT public.create_next_partitions();

-- ----------------------------------------------------------------------------
-- Pure redaction helpers
-- ----------------------------------------------------------------------------

SELECT is(
  public.redact_sensitive_headers('{"authorization":"Bearer secret","content-type":"application/json"}'::jsonb)->>'authorization',
  'REDACTED',
  'redact_sensitive_headers redacts Authorization'
);

SELECT is(
  public.redact_sensitive_headers('{"authorization":"Bearer secret","content-type":"application/json"}'::jsonb)->>'content-type',
  'application/json',
  'redact_sensitive_headers preserves non-sensitive headers'
);

SELECT is(
  public.redact_sensitive_json('{"token":"secret","nested":{"api_key":"secret2"}}'::jsonb)->>'token',
  'REDACTED',
  'redact_sensitive_json redacts token keys'
);

SELECT is(
  public.redact_sensitive_json('{"authToken":"secret"}'::jsonb)->>'authToken',
  'REDACTED',
  'redact_sensitive_json redacts authToken keys'
);

SELECT is(
  (public.redact_sensitive_json('{"token":"secret","nested":{"api_key":"secret2"}}'::jsonb)->'nested'->>'api_key'),
  'REDACTED',
  'redact_sensitive_json redacts nested api_key keys'
);

SELECT is(
  public.redact_sensitive_url('https://example.test?apiKey=secret&x=1'),
  'https://example.test?apiKey=REDACTED&x=1',
  'redact_sensitive_url redacts apiKey query param'
);

-- ----------------------------------------------------------------------------
-- Auth injection via get_job_call_spec (no secrets stored in outbound_calls)
-- ----------------------------------------------------------------------------

-- This fixture owns provider/plugin activation context. Defer organization
-- bootstrap until source-binding context exists, then run onboarding explicitly.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO organizations (id, name, slug)
VALUES ('aaaa0000-0000-0000-0000-000000000028', 'Secret Hygiene Org', 'secret-hygiene-org')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    updated_at = now();
SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO clients (id, organization_id, name, slug, status)
VALUES (
  'aaaa0000-0000-0000-0000-000000000128',
  'aaaa0000-0000-0000-0000-000000000028',
  'Secret Hygiene Client',
  'secret-hygiene-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  'aaaa0000-0000-0000-0000-000000000228',
  'aaaa0000-0000-0000-0000-000000000128',
  'Secret Hygiene Sender',
  'Secret Hygiene Sender',
  false,
  true,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    brand_name = EXCLUDED.brand_name,
    status = EXCLUDED.status,
    updated_at = now();

SELECT public.bootstrap_tenant_onboarding_v1(
  'aaaa0000-0000-0000-0000-000000000028',
  'pgtap:outbound-secret-hygiene-fixture-bootstrap'
);

INSERT INTO providers (id, organization_id, name, provider_type, metadata)
VALUES (
  'bbbb0000-0000-0000-0000-000000000028',
  'aaaa0000-0000-0000-0000-000000000028',
  'secret_hygiene_provider',
  'comms',
  jsonb_build_object('base_url', 'https://example.test')
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config)
VALUES (
  'cccc0000-0000-0000-0000-000000000028',
  'provider_response',
  'bbbb0000-0000-0000-0000-000000000028',
  '{"field_mappings": {"status": "$.status"}}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Two auth configs for injection tests.
WITH secret AS (
  SELECT vault.create_secret(
    '{"api_key":"super-secret-api-key"}',
    'provider_auth_configs/dddd0000-0000-0000-0000-000000000028',
    'pgtap outbound secret hygiene api_key',
    NULL
  ) AS id
)
INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
SELECT
  'dddd0000-0000-0000-0000-000000000028',
  'bbbb0000-0000-0000-0000-000000000028',
  'api_key',
  secret.id,
  NULL,
  NULL
FROM secret
ON CONFLICT (id) DO NOTHING;

WITH secret AS (
  SELECT vault.create_secret(
    '{"username":"user","password":"pass"}',
    'provider_auth_configs/eeee0000-0000-0000-0000-000000000028',
    'pgtap outbound secret hygiene basic_auth',
    NULL
  ) AS id
)
INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
SELECT
  'eeee0000-0000-0000-0000-000000000028',
  'bbbb0000-0000-0000-0000-000000000028',
  'basic_auth',
  secret.id,
  NULL,
  NULL
FROM secret
ON CONFLICT (id) DO NOTHING;

SELECT ok(
  (SELECT credentials IS NULL FROM provider_auth_configs WHERE id = 'dddd0000-0000-0000-0000-000000000028'),
  'provider_auth_configs.credentials is NULL (Vault contract)'
);

SELECT is(
  public.get_provider_auth_credentials('dddd0000-0000-0000-0000-000000000028')->>'api_key',
  'super-secret-api-key',
  'get_provider_auth_credentials resolves api_key from Vault'
);

SELECT is(
  public.get_provider_auth_credentials('eeee0000-0000-0000-0000-000000000028')->>'username',
  'user',
  'get_provider_auth_credentials resolves basic_auth username from Vault'
);

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'cccc0280-0000-0000-0000-000000000028', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'aaaa0280-0000-0000-0000-000000000028',
  'pgtap_outbound_secret_hygiene',
  'Fixture workflow for outbound guard context',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
)
VALUES (
  'bbbb0280-0000-0000-0000-000000000028',
  'aaaa0280-0000-0000-0000-000000000028',
  1,
  'workflow_control',
  'always',
  'workflow_control',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'cccc0280-0000-0000-0000-000000000028',
  'aaaa0280-0000-0000-0000-000000000028',
  1,
  'test',
  'pending',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'dddd0280-0000-0000-0000-000000000028',
  'cccc0280-0000-0000-0000-000000000028',
  'bbbb0280-0000-0000-0000-000000000028',
  1,
  'pending',
  'workflow_control',
  'workflow_control',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', 'dddd0280-0000-0000-0000-000000000028', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'dddd0280-0000-0000-0000-000000000028', true);

-- Job-scoped auth injection (context.auth).
INSERT INTO outbound_calls (
  id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  headers,
  body,
  status,
  priority,
  retry_count,
  max_retries,
  scheduled_at,
  created_at,
  context,
  workflow_run_step_id
)
VALUES (
  'ffff0000-0000-0000-0000-000000000028',
  'provider_api',
  'provider',
  'bbbb0000-0000-0000-0000-000000000028',
  'POST',
  'https://example.test/echo',
  '{"content-type":"application/json"}'::jsonb,
  '{}'::jsonb,
  'pending',
  100,
  0,
  1,
  now(),
  now(),
  jsonb_build_object(
    'auth',
    jsonb_build_object(
      'mode', 'api_key_header',
      'auth_type', 'api_key',
      'auth_config_id', 'dddd0000-0000-0000-0000-000000000028',
      'header', 'x-api-key',
      'credential_key', 'api_key'
    )
  ),
  'dddd0280-0000-0000-0000-000000000028'
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (public.get_job_call_spec('ffff0000-0000-0000-0000-000000000028') -> 'headers' ->> 'x-api-key'),
  'super-secret-api-key',
  'get_job_call_spec injects api_key_header from outbound_calls.context.auth'
);

SELECT ok(
  NOT (SELECT COALESCE(headers, '{}'::jsonb) ? 'x-api-key' FROM outbound_calls WHERE id = 'ffff0000-0000-0000-0000-000000000028'),
  'outbound_calls.headers does not persist injected API key'
);

-- Template-scoped auth injection (operation_templates.metadata.auth).
INSERT INTO operation_templates (
  id,
  provider_id,
  operation_name,
  method,
  url_template,
  headers_template,
  handler_key,
  body_template,
  request_mappings,
  mapping_config_id,
  timeout_seconds,
  metadata
)
VALUES (
  '99990000-0000-0000-0000-000000000028',
  'bbbb0000-0000-0000-0000-000000000028',
  'secret_hygiene_basic_auth_v1',
  'POST',
  'https://example.test/basic',
  '{"content-type":"application/json"}'::jsonb,
  'outbound_http',
  '{}'::jsonb,
  NULL,
  'cccc0000-0000-0000-0000-000000000028',
  30,
  jsonb_build_object(
    'auth',
    jsonb_build_object(
      'mode', 'basic_auth_header',
      'auth_type', 'basic_auth',
      'header', 'authorization',
      'scheme', 'Basic',
      'username_key', 'username',
      'password_key', 'password'
    )
  )
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbound_calls (
  id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  headers,
  body,
  status,
  priority,
  retry_count,
  max_retries,
  scheduled_at,
  created_at,
  context,
  workflow_run_step_id
)
VALUES (
  '11110000-0000-0000-0000-000000000028',
  'provider_api',
  'provider',
  'bbbb0000-0000-0000-0000-000000000028',
  'POST',
  'https://example.test/basic',
  '{"content-type":"application/json"}'::jsonb,
  '{}'::jsonb,
  'pending',
  100,
  0,
  1,
  now(),
  now(),
  jsonb_build_object('operation_template_id', '99990000-0000-0000-0000-000000000028'),
  'dddd0280-0000-0000-0000-000000000028'
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (public.get_job_call_spec('11110000-0000-0000-0000-000000000028') -> 'headers' ->> 'authorization'),
  'Basic ' || encode(convert_to('user:pass', 'utf8'), 'base64'),
  'get_job_call_spec injects basic auth header from operation_templates.metadata.auth'
);

-- ----------------------------------------------------------------------------
-- log_api_call_event redacts sensitive request/response values before persistence
-- ----------------------------------------------------------------------------

SELECT public.log_api_call_event(
  'ffff0000-0000-0000-0000-000000000028',
  jsonb_build_object(
    'method', 'POST',
    'url', 'https://example.test/echo?token=topsecret',
    'headers', jsonb_build_object('authorization', 'Bearer topsecret', 'content-type', 'application/json'),
    'body', jsonb_build_object('marker', 'secret-hygiene-test', 'token', 'topsecret')
  ),
  jsonb_build_object(
    'headers', jsonb_build_object('set-cookie', 'session=topsecret'),
    'body', jsonb_build_object('access_token', 'topsecret')
  ),
  200,
  12,
  NULL
);

SELECT is(
  (
    SELECT url
    FROM api_call_log
    WHERE request_body->>'marker' = 'secret-hygiene-test'
    ORDER BY timestamp DESC
    LIMIT 1
  ),
  'https://example.test/echo?token=REDACTED',
  'log_api_call_event redacts sensitive query params in URL'
);

SELECT is(
  (
    SELECT request_headers->>'authorization'
    FROM api_call_log
    WHERE request_body->>'marker' = 'secret-hygiene-test'
    ORDER BY timestamp DESC
    LIMIT 1
  ),
  'REDACTED',
  'log_api_call_event redacts sensitive request headers'
);

SELECT is(
  (
    SELECT request_body->>'token'
    FROM api_call_log
    WHERE request_body->>'marker' = 'secret-hygiene-test'
    ORDER BY timestamp DESC
    LIMIT 1
  ),
  'REDACTED',
  'log_api_call_event redacts sensitive request body keys'
);

SELECT is(
  (
    SELECT response_headers->>'set-cookie'
    FROM api_call_log
    WHERE request_body->>'marker' = 'secret-hygiene-test'
    ORDER BY timestamp DESC
    LIMIT 1
  ),
  'REDACTED',
  'log_api_call_event redacts sensitive response headers'
);

SELECT is(
  (
    SELECT response_body->>'access_token'
    FROM api_call_log
    WHERE request_body->>'marker' = 'secret-hygiene-test'
    ORDER BY timestamp DESC
    LIMIT 1
  ),
  'REDACTED',
  'log_api_call_event redacts sensitive response body keys'
);

SELECT finish();

ROLLBACK;

-- Test Suite: API gateway core (routing, intake, auth injection)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(70);

-- Ensure time partitions exist for decision_log/settings_resolution_log inserts.
SELECT public.create_next_partitions();

-- ----------------------------------------------------------------------------
-- Redaction helpers (token safety)
-- ----------------------------------------------------------------------------

SELECT is(
  public.redact_sensitive_headers('{"x-webhook-token":"secret","content-type":"application/json"}'::jsonb)->>'x-webhook-token',
  'REDACTED',
  'redact_sensitive_headers redacts x-webhook-token'
);

SELECT ok(
  NOT public.api_gateway_sanitize_outbound_headers_v1(
    '{"apikey":"anon","x-api-key":"client","x-client-info":"console","idempotency-key":"idem","x-idempotency-key":"xidem","x-webhook-token":"secret","company-id":"362","x-correlation-id":"corr","content-type":"application/json"}'::jsonb
  ) ?| ARRAY['apikey','x-api-key','x-client-info','idempotency-key','x-idempotency-key','x-webhook-token'],
  'api_gateway_sanitize_outbound_headers_v1 strips gateway/runtime headers'
);

SELECT ok(
  NOT public.api_gateway_sanitize_outbound_headers_v1(
    '{"origin":"http://127.0.0.1:5175","referer":"http://127.0.0.1:5175/","sec-ch-ua":"Chromium","sec-ch-ua-mobile":"?0","sec-ch-ua-platform":"Windows","accept":"*/*","accept-language":"en-US","company-id":"362","x-correlation-id":"corr","content-type":"application/json"}'::jsonb
  ) ?| ARRAY['origin','referer','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','accept','accept-language'],
  'api_gateway_sanitize_outbound_headers_v1 strips browser-origin headers from Console tester calls'
);

SELECT is(
  public.api_gateway_sanitize_outbound_headers_v1(
    '{"apikey":"anon","company-id":"362","x-correlation-id":"corr","content-type":"application/json"}'::jsonb
  )->>'company-id',
  '362',
  'api_gateway_sanitize_outbound_headers_v1 preserves provider company-id'
);

SELECT ok(
  NOT public.api_gateway_sanitize_outbound_headers_v1(
    '{"apikey":"anon","company-id":"362","x-correlation-id":"corr","content-type":"application/json"}'::jsonb
  ) ? 'x-correlation-id',
  'api_gateway_sanitize_outbound_headers_v1 strips gateway correlation header before provider dispatch'
);

SELECT ok(
  NOT public.api_gateway_sanitize_outbound_headers_v1(
    '{"baggage":"sentry-environment=production","sentry-trace":"trace","traceparent":"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01","content-type":"application/json"}'::jsonb
  ) ?| ARRAY['baggage','sentry-trace'],
  'api_gateway_sanitize_outbound_headers_v1 strips Sentry propagation headers'
);

SELECT ok(
  NOT public.api_gateway_sanitize_outbound_headers_v1(
    '{"baggage":"sentry-environment=production","sentry-trace":"trace","traceparent":"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01","content-type":"application/json"}'::jsonb
  ) ? 'traceparent',
  'api_gateway_sanitize_outbound_headers_v1 strips traceparent before provider dispatch'
);

SELECT ok(
  NOT public.api_gateway_sanitize_outbound_headers_v1(
    '{"x-masarx-replay-of":"req-api-gateway-original","company-id":"362","content-type":"application/json"}'::jsonb
  ) ? 'x-masarx-replay-of',
  'api_gateway_sanitize_outbound_headers_v1 strips internal replay lineage before provider dispatch'
);

-- ----------------------------------------------------------------------------
-- Setup minimal entities for API gateway intake
-- ----------------------------------------------------------------------------

SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO organizations (id, name, slug)
VALUES ('aaaa0000-0000-0000-0000-000000000049', 'API Gateway Org', 'pgtap-api-gateway-org-049')
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO clients (id, organization_id, name, slug)
VALUES (
  'bbbb0000-0000-0000-0000-000000000049',
  'aaaa0000-0000-0000-0000-000000000049',
  'API Gateway Client',
  'pgtap-api-gateway-client-049'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES (
  'cccc0000-0000-0000-0000-000000000049',
  'bbbb0000-0000-0000-0000-000000000049',
  'API Gateway Sender',
  'API Gateway Sender',
  TRUE,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT bootstrap_tenant_onboarding_v1(
  'aaaa0000-0000-0000-0000-000000000049',
  'pgtap:api-gateway-core-fixture-bootstrap'
);

INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
VALUES (
  'dddd0000-0000-0000-0000-000000000049',
  'webhook_inbound',
  'pgtap-api-gateway-049::default',
  '{}'::jsonb,
  1,
  'pgTAP api gateway source mapping'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  'eeee0000-0000-0000-0000-000000000049',
  'aaaa0000-0000-0000-0000-000000000049',
  'pgtap-api-gateway-source-049',
  'API Gateway Source',
  'api_gateway',
  'token-api-gateway-049',
  'dddd0000-0000-0000-0000-000000000049',
  1000,
  TRUE,
  'cccc0000-0000-0000-0000-000000000049'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO providers (id, organization_id, name, provider_type, metadata)
VALUES (
  'ffff0000-0000-0000-0000-000000000049',
  'aaaa0000-0000-0000-0000-000000000049',
  'pgtap_api_gateway_provider_049',
  '3pl',
  jsonb_build_object('base_url', 'https://example.test')
)
ON CONFLICT (id) DO NOTHING;

WITH secret AS (
  SELECT vault.create_secret(
    '{"username":"user049@example.test","password":"pass049"}',
    'provider_auth_configs/11110000-0000-0000-0000-000000000049',
    'pgtap api gateway core basic_auth 049',
    NULL
  ) AS id
)
INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
SELECT
  '11110000-0000-0000-0000-000000000049',
  'ffff0000-0000-0000-0000-000000000049',
  'basic_auth',
  secret.id,
  NULL,
  NULL
FROM secret
ON CONFLICT (id) DO NOTHING;

-- Second auth config to validate per-scope auth_config_id selection (avoid "latest wins").
WITH secret AS (
  SELECT vault.create_secret(
    '{"username":"user050@example.test","password":"pass050"}',
    'provider_auth_configs/11110000-0000-0000-0000-000000000050',
    'pgtap api gateway core basic_auth 050',
    NULL
  ) AS id
)
INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
SELECT
  '11110000-0000-0000-0000-000000000050',
  'ffff0000-0000-0000-0000-000000000049',
  'basic_auth',
  secret.id,
  NULL,
  NULL
FROM secret
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_route_packs (id, name, description, enabled)
VALUES (
  '22220000-0000-0000-0000-000000000049',
  'pgtap_api_gateway_pack_049',
  'pgTAP route pack for api gateway tests',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Global cancel route + source override to assert ladder precedence.
INSERT INTO api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '33330000-0000-0000-0000-000000000049',
  '22220000-0000-0000-0000-000000000049',
  'cancel_global',
  TRUE,
  'PUT',
  '/api/guests/{companyId}/packages/{shipmentId}/cancel',
  'global',
  NULL,
  'ffff0000-0000-0000-0000-000000000049',
  'PUT',
  '/api/guests/{companyId}/packages/{shipmentId}/cancel',
  '{}'::jsonb
)
ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
SET pack_id = EXCLUDED.pack_id,
    route_name = EXCLUDED.route_name,
    enabled = EXCLUDED.enabled,
    provider_id = EXCLUDED.provider_id,
    upstream_method = EXCLUDED.upstream_method,
    upstream_path_template = EXCLUDED.upstream_path_template,
    policy = EXCLUDED.policy,
    updated_at = now();

INSERT INTO api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '44440000-0000-0000-0000-000000000049',
  '22220000-0000-0000-0000-000000000049',
  'cancel_source_override',
  TRUE,
  'PUT',
  '/api/guests/{companyId}/packages/{shipmentId}/cancel',
  'source',
  'eeee0000-0000-0000-0000-000000000049',
  'ffff0000-0000-0000-0000-000000000049',
  'PUT',
  '/api/guests/{companyId}/packages/{shipmentId}/cancel',
  jsonb_build_object(
    'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
    'provider_account', jsonb_build_object(
      'category', 'logestechs_v2_account',
      'required', TRUE,
      'require_company_id', TRUE,
      'require_auth_config_id', TRUE
    ),
    'headers', jsonb_build_object(
      'overrides', jsonb_build_object(
        'company-id', '{{provider_account.company_id}}'
      )
    ),
    'auth', jsonb_build_object(
      'mode', 'body_fields',
      'auth_type', 'basic_auth',
      'fields', jsonb_build_object('email', 'username', 'password', 'password')
    )
  )
)
ON CONFLICT (id) DO UPDATE
SET pack_id = EXCLUDED.pack_id,
    route_name = EXCLUDED.route_name,
    enabled = EXCLUDED.enabled,
    provider_id = EXCLUDED.provider_id,
    upstream_method = EXCLUDED.upstream_method,
    upstream_path_template = EXCLUDED.upstream_path_template,
    policy = EXCLUDED.policy,
    updated_at = now();

-- Intake route for create shipment by email (source scoped).
-- Also configure a provider_account binding via settings for this source so auth selection is deterministic.

INSERT INTO settings_versions_p0 (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
VALUES (
  '77770000-0000-0000-0000-000000000049',
  'logestechs_v2_account',
  'source',
  'eeee0000-0000-0000-0000-000000000049',
  'eeee0000-0000-0000-0000-000000000049',
  1,
  jsonb_build_object(
    'auth_config_id', '11110000-0000-0000-0000-000000000049',
    'company_id', '362',
    'enabled', TRUE
  ),
  1,
  'pgTAP seed logestechs_v2_account for source',
  now(),
  now()
)
ON CONFLICT (id, scope_hash) DO NOTHING;

INSERT INTO settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
VALUES (
  'logestechs_v2_account',
  'source',
  'eeee0000-0000-0000-0000-000000000049',
  'eeee0000-0000-0000-0000-000000000049',
  '77770000-0000-0000-0000-000000000049',
  jsonb_build_object(
    'auth_config_id', '11110000-0000-0000-0000-000000000049',
    'company_id', '362',
    'enabled', TRUE
  ),
  now()
)
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

INSERT INTO api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '55550000-0000-0000-0000-000000000049',
  '22220000-0000-0000-0000-000000000049',
  'create_shipment_by_email_source',
  TRUE,
  'POST',
  '/api/ship/request/by-email',
  'source',
  'eeee0000-0000-0000-0000-000000000049',
  'ffff0000-0000-0000-0000-000000000049',
  'POST',
  '/api/ship/request/by-email',
  jsonb_build_object(
    'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
    'provider_account', jsonb_build_object(
      'category', 'logestechs_v2_account',
      'required', TRUE,
      'require_company_id', TRUE,
      'require_auth_config_id', TRUE
    ),
    'headers', jsonb_build_object(
      'overrides', jsonb_build_object(
        'company-id', '{{provider_account.company_id}}'
      )
    ),
    'auth', jsonb_build_object(
      'mode', 'body_fields',
      'auth_type', 'basic_auth',
      'fields', jsonb_build_object('email', 'username', 'password', 'password')
    )
  )
)
ON CONFLICT (id) DO NOTHING;

-- Global create shipment route (used to validate ambiguity safety when no per-scope auth_config_id is configured).
INSERT INTO api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '55551000-0000-0000-0000-000000000049',
  '22220000-0000-0000-0000-000000000049',
  'create_shipment_by_email_global',
  TRUE,
  'POST',
  '/api/ship/request/by-email',
  'global',
  NULL,
  'ffff0000-0000-0000-0000-000000000049',
  'POST',
  '/api/ship/request/by-email',
  jsonb_build_object(
    'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
    'provider_account', jsonb_build_object(
      'category', 'logestechs_v2_account',
      'required', TRUE,
      'require_company_id', TRUE,
      'require_auth_config_id', TRUE
    ),
    'headers', jsonb_build_object(
      'overrides', jsonb_build_object(
        'company-id', '{{provider_account.company_id}}'
      )
    ),
    'auth', jsonb_build_object(
      'mode', 'body_fields',
      'auth_type', 'basic_auth',
      'fields', jsonb_build_object('email', 'username', 'password', 'password')
    )
  )
)
ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
SET pack_id = EXCLUDED.pack_id,
    route_name = EXCLUDED.route_name,
    enabled = EXCLUDED.enabled,
    provider_id = EXCLUDED.provider_id,
    upstream_method = EXCLUDED.upstream_method,
    upstream_path_template = EXCLUDED.upstream_path_template,
    policy = EXCLUDED.policy,
    updated_at = now();

-- ----------------------------------------------------------------------------
-- Route resolution (ladder + path params)
-- ----------------------------------------------------------------------------

-- Static GET route match (no path params)
INSERT INTO api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '66660000-0000-0000-0000-000000000049',
  '22220000-0000-0000-0000-000000000049',
  'get_villages_source',
  TRUE,
  'GET',
  '/api/addresses/villages',
  'source',
  'eeee0000-0000-0000-0000-000000000049',
  'ffff0000-0000-0000-0000-000000000049',
  'GET',
  '/api/addresses/villages',
  '{}'::jsonb
)
ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
SET pack_id = EXCLUDED.pack_id,
    route_name = EXCLUDED.route_name,
    enabled = EXCLUDED.enabled,
    provider_id = EXCLUDED.provider_id,
    upstream_method = EXCLUDED.upstream_method,
    upstream_path_template = EXCLUDED.upstream_path_template,
    policy = EXCLUDED.policy,
    updated_at = now();

SELECT is(
  (public.resolve_api_route_v1(
    'GET',
    '/api/addresses/villages',
    'aaaa0000-0000-0000-0000-000000000049',
    'bbbb0000-0000-0000-0000-000000000049',
    'cccc0000-0000-0000-0000-000000000049',
    'eeee0000-0000-0000-0000-000000000049'
  )->>'route_id'),
  '66660000-0000-0000-0000-000000000049',
  'resolve_api_route_v1 matches static GET route'
);

SELECT is(
  (public.resolve_api_route_v1(
    'GET',
    '/api/addresses/villages',
    'aaaa0000-0000-0000-0000-000000000049',
    'bbbb0000-0000-0000-0000-000000000049',
    'cccc0000-0000-0000-0000-000000000049',
    'eeee0000-0000-0000-0000-000000000049'
  )->'path_params')::text,
  '{}'::text,
  'resolve_api_route_v1 returns empty path_params for static GET route'
);

SELECT is(
  (public.resolve_api_route_v1(
    'PUT',
    '/api/guests/362/packages/SHIP049/cancel',
    'aaaa0000-0000-0000-0000-000000000049',
    'bbbb0000-0000-0000-0000-000000000049',
    'cccc0000-0000-0000-0000-000000000049',
    'eeee0000-0000-0000-0000-000000000049'
  )->>'route_id'),
  '44440000-0000-0000-0000-000000000049',
  'resolve_api_route_v1 chooses source-scoped override'
);

SELECT is(
  (public.resolve_api_route_v1(
    'PUT',
    '/api/guests/362/packages/SHIP049/cancel',
    'aaaa0000-0000-0000-0000-000000000049',
    'bbbb0000-0000-0000-0000-000000000049',
    'cccc0000-0000-0000-0000-000000000049',
    'eeee0000-0000-0000-0000-000000000049'
  )->'path_params'->>'companyId'),
  '362',
  'resolve_api_route_v1 extracts companyId param'
);

-- ----------------------------------------------------------------------------
-- Intake RPC: enqueue outbound call and strip secrets
-- ----------------------------------------------------------------------------

-- Seed workflow context so workflow_intake_api_gateway_v1 outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'cccc0490-0000-0000-0000-000000000049', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'aaaa0490-0000-0000-0000-000000000049',
  'pgtap_api_gateway_core',
  'Fixture workflow for API gateway intake tests',
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
  'bbbb0490-0000-0000-0000-000000000049',
  'aaaa0490-0000-0000-0000-000000000049',
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
  'cccc0490-0000-0000-0000-000000000049',
  'aaaa0490-0000-0000-0000-000000000049',
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
  'dddd0490-0000-0000-0000-000000000049',
  'cccc0490-0000-0000-0000-000000000049',
  'bbbb0490-0000-0000-0000-000000000049',
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

SELECT set_config('app.workflow_run_step_id', 'dddd0490-0000-0000-0000-000000000049', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'dddd0490-0000-0000-0000-000000000049', true);

INSERT INTO webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  'eeee0000-0000-0000-0000-000000000052',
  'aaaa0000-0000-0000-0000-000000000049',
  'pgtap-api-gateway-source-052',
  'API Gateway Source 052 Missing Sender',
  'api_gateway',
  'token-api-gateway-052',
  'dddd0000-0000-0000-0000-000000000049',
  1000,
  TRUE,
  NULL
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '55552000-0000-0000-0000-000000000049',
  '22220000-0000-0000-0000-000000000049',
  'create_shipment_by_email_missing_sender_guard',
  TRUE,
  'POST',
  '/api/ship/request/by-email',
  'source',
  'eeee0000-0000-0000-0000-000000000052',
  'ffff0000-0000-0000-0000-000000000049',
  'POST',
  '/api/ship/request/by-email',
  jsonb_build_object(
    'delivery', jsonb_build_object('mode', 'accepted_async', 'status_code', 202),
    'workflow', jsonb_build_object(
      'enabled', TRUE,
      'template_name', 'pgtap_api_gateway_core',
      'intent', 'shipment.create'
    ),
    'provider_account', jsonb_build_object('required', FALSE)
  )
)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE tmp_api_gateway_missing_sender AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-052',
  'POST',
  '/api/ship/request/by-email',
  '',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'pkg', jsonb_build_object('receiverName', 'QA Receiver 052', 'receiverPhone', '+12025550123')
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_missing_sender),
  'error',
  'workflow_intake_api_gateway_v1 rejects shipment-create source missing sender/client'
);

SELECT is(
  (SELECT result->'body'->>'error' FROM tmp_api_gateway_missing_sender),
  'api_gateway_source_missing_sender_client',
  'workflow_intake_api_gateway_v1 returns api_gateway_source_missing_sender_client'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.api_gateway_requests
     WHERE source_id = 'eeee0000-0000-0000-0000-000000000052'
       AND id::text = (SELECT result->'body'->>'api_gateway_request_id' FROM tmp_api_gateway_missing_sender)
       AND outbound_call_id IS NULL
       AND workflow_run_id IS NULL
  ),
  'missing sender/client guard persists a redacted request row before rejecting'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.outbound_calls oc
     WHERE oc.context->>'source_id' = 'eeee0000-0000-0000-0000-000000000052'
  ),
  'missing sender/client guard rejects before outbound enqueue'
);

INSERT INTO webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  'eeee0000-0000-0000-0000-000000000053',
  'aaaa0000-0000-0000-0000-000000000049',
  'pgtap-api-gateway-source-053',
  'API Gateway Source 053 Missing Sender Postprocess Mode',
  'api_gateway',
  'token-api-gateway-053',
  'dddd0000-0000-0000-0000-000000000049',
  1000,
  TRUE,
  NULL
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '55553000-0000-0000-0000-000000000049',
  '22220000-0000-0000-0000-000000000049',
  'create_shipment_by_email_missing_sender_postprocess_mode_guard',
  TRUE,
  'POST',
  '/api/ship/request/by-email',
  'source',
  'eeee0000-0000-0000-0000-000000000053',
  'ffff0000-0000-0000-0000-000000000049',
  'POST',
  '/api/ship/request/by-email',
  jsonb_build_object(
    'delivery', jsonb_build_object('mode', 'accepted_async', 'status_code', 202),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1'),
    'provider_account', jsonb_build_object('required', FALSE)
  )
)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE tmp_api_gateway_missing_sender_postprocess_mode AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-053',
  'POST',
  '/api/ship/request/by-email',
  '',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'pkg', jsonb_build_object('receiverName', 'QA Receiver 053', 'receiverPhone', '0500000053')
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_missing_sender_postprocess_mode),
  'error',
  'workflow_intake_api_gateway_v1 rejects postprocess-mode shipment-create source missing sender/client'
);

SELECT is(
  (SELECT result->'body'->>'error' FROM tmp_api_gateway_missing_sender_postprocess_mode),
  'api_gateway_source_missing_sender_client',
  'postprocess-mode shipment-create guard returns api_gateway_source_missing_sender_client'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.api_gateway_requests
     WHERE source_id = 'eeee0000-0000-0000-0000-000000000053'
       AND id::text = (SELECT result->'body'->>'api_gateway_request_id' FROM tmp_api_gateway_missing_sender_postprocess_mode)
       AND outbound_call_id IS NULL
       AND workflow_run_id IS NULL
  ),
  'postprocess-mode missing sender/client guard persists a redacted request row before rejecting'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.outbound_calls oc
     WHERE oc.context->>'source_id' = 'eeee0000-0000-0000-0000-000000000053'
  ),
  'postprocess-mode missing sender/client guard rejects before outbound enqueue'
);

CREATE TEMP TABLE tmp_api_gateway_intake AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-049',
  'POST',
  '/api/ship/request/by-email',
  '?a=1&b=2',
  jsonb_build_object(
    'content-type', 'application/json',
    'authorization', 'Bearer client-token',
    'apikey', 'supabase-anon-should-not-forward',
    'x-api-key', 'browser-api-key-should-not-forward',
    'x-client-info', 'console-v2-direct-powershell',
    'idempotency-key', 'gateway-idempotency-should-not-forward',
    'x-idempotency-key', 'gateway-x-idempotency-should-not-forward',
    'x-correlation-id', '99990000-0000-0000-0000-000000000049',
    'x-webhook-token', 'token-api-gateway-049',
    'accept', '*/*',
    'accept-language', 'en-US',
    'origin', 'http://127.0.0.1:5175',
    'referer', 'http://127.0.0.1:5175/insights/api-gateway',
    'sec-ch-ua', '"Chromium";v="136", "Not A Brand";v="99"',
    'sec-ch-ua-mobile', '?0',
    'sec-ch-ua-platform', '"Windows"',
    'x-forwarded-path', '/functions/v1/api-gateway/t/token-api-gateway-049/api/ship/request/by-email'
  ),
  jsonb_build_object(
    'email', 'client@example.test',
    'password', 'client-pass-should-not-persist',
    'pkg', jsonb_build_object(
      'receiverName', 'QA Receiver',
      'receiverPhone', '0500000049'
    ),
    'destinationAddress', jsonb_build_object(
      'addressLine1', 'Test street 1',
      'city', 'Riyadh',
      'latitude', 24.7,
      'longitude', 46.7
    )
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_intake),
  'proxy',
  'workflow_intake_api_gateway_v1 returns action=proxy'
);

SELECT matches(
  (SELECT result->>'outbound_call_id' FROM tmp_api_gateway_intake),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text,
  'workflow_intake_api_gateway_v1 returns outbound_call_id (uuid)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_gateway_rate_limits rl
    WHERE rl.source_id = 'eeee0000-0000-0000-0000-000000000049'
      AND rl.request_count >= 1
  ),
  'api_gateway_rate_limits increments for source'
);

SELECT is(
  (SELECT result->>'correlation_id' FROM tmp_api_gateway_intake),
  '99990000-0000-0000-0000-000000000049',
  'workflow_intake_api_gateway_v1 preserves x-correlation-id'
);

SELECT is(
  (
    SELECT correlation_id::text
    FROM public.api_gateway_requests
    WHERE id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_intake)
  ),
  '99990000-0000-0000-0000-000000000049',
  'api_gateway_requests stores correlation_id'
);

SELECT is(
  (
    SELECT correlation_id::text
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
  ),
  '99990000-0000-0000-0000-000000000049',
  'outbound_calls stores correlation_id'
);

-- Stored request headers are redacted and token header is removed.
SELECT is(
  (
    SELECT request_headers->>'authorization'
    FROM public.api_gateway_requests
    WHERE id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_intake)
  ),
  'REDACTED',
  'api_gateway_requests stores redacted Authorization header'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.api_gateway_requests
    WHERE id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_intake)
      AND (request_headers ? 'x-webhook-token')
  ),
  'api_gateway_requests does not persist x-webhook-token'
);

SELECT ok(
  (
    SELECT request_headers->>'x-forwarded-path'
    FROM public.api_gateway_requests
    WHERE id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_intake)
  ) NOT LIKE '%token-api-gateway-049%',
  'api_gateway_requests redacts path-token material from forwarded path headers'
);

SELECT ok(
  (
    SELECT COALESCE(headers->>'x-forwarded-path', '')
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
  ) NOT LIKE '%token-api-gateway-049%',
  'outbound_calls redacts path-token material from forwarded path headers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.outbound_calls oc,
           jsonb_object_keys(COALESCE(oc.headers, '{}'::jsonb)) AS header_name
     WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
       AND lower(header_name) IN (
         'host',
         'connection',
         'content-length',
         'accept',
         'accept-encoding',
         'accept-language',
         'origin',
         'referer',
         'sec-ch-ua',
         'sec-ch-ua-mobile',
         'sec-ch-ua-platform',
         'sec-fetch-mode',
         'x-forwarded-for',
         'x-forwarded-host',
         'x-forwarded-path',
         'x-forwarded-port',
         'x-forwarded-prefix',
         'x-forwarded-proto',
         'x-real-ip',
         'apikey',
         'x-api-key',
         'x-client-info',
         'idempotency-key',
         'x-idempotency-key'
       )
  ),
  'outbound_calls strips gateway/runtime, hop-by-hop, browser-only, and edge-forwarded headers before provider dispatch'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_object_keys(COALESCE(
        public.get_job_call_spec((SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake))->'headers',
        '{}'::jsonb
      )) AS header_name
     WHERE lower(header_name) IN (
       'origin',
       'referer',
       'sec-ch-ua',
       'sec-ch-ua-mobile',
       'sec-ch-ua-platform',
       'accept',
       'accept-language'
     )
  ),
  'get_job_call_spec returns provider-safe headers without browser-origin request headers'
);

SELECT ok(
  (
    SELECT COALESCE(public.get_job_call_spec(oc.id)->'headers'->>'x-forwarded-path', '')
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
  ) NOT LIKE '%token-api-gateway-049%',
  'get_job_call_spec does not return forwarded path-token material'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_object_keys(COALESCE(
        public.get_job_call_spec((SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake))->'headers',
        '{}'::jsonb
      )) AS header_name
     WHERE lower(header_name) IN (
       'host',
       'connection',
       'content-length',
       'accept',
       'accept-encoding',
       'accept-language',
       'origin',
       'referer',
       'sec-ch-ua',
       'sec-ch-ua-mobile',
       'sec-ch-ua-platform',
       'sec-fetch-mode',
       'x-forwarded-for',
       'x-forwarded-host',
       'x-forwarded-path',
       'x-forwarded-port',
       'x-forwarded-prefix',
       'x-forwarded-proto',
       'x-real-ip',
       'apikey',
       'x-api-key',
       'x-client-info',
       'idempotency-key',
       'x-idempotency-key'
     )
  ),
  'get_job_call_spec returns a provider-safe header set without gateway/runtime headers'
);

SELECT is(
  (
    SELECT headers->>'company-id'
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
  ),
  '362',
  'workflow_intake_api_gateway_v1 applies policy header overrides (company-id)'
);

SELECT ok(
  to_regprocedure('api.resolve_effective_outbound_egress_policy_v1(uuid)') IS NOT NULL,
  'api schema exposes resolve_effective_outbound_egress_policy_v1 for edge api-caller'
);

SELECT ok(
  (
    api.resolve_effective_outbound_egress_policy_v1(
      (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
    ) #> '{policy,header_allowlist}'
  ) ? 'company-id',
  'effective outbound egress policy allows provider company-id header'
);

SELECT ok(
  (
    api.resolve_effective_outbound_egress_policy_v1(
      (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
    ) #> '{policy,header_allowlist}'
  ) ? 'traceparent',
  'effective outbound egress policy allows trace propagation header'
);

SELECT is(
  (
    SELECT context->>'provider_account_category'
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
  ),
  'logestechs_v2_account',
  'outbound_calls context includes provider_account_category'
);

SELECT matches(
  (
    SELECT context->>'provider_account_settings_resolution_id'
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
  ),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text,
  'outbound_calls context includes provider_account_settings_resolution_id'
);

-- Outbound call body should not store email/password (body_fields injected at dispatch time).
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake)
      AND (oc.body ? 'email' OR oc.body ? 'password')
  ),
  'outbound_calls body strips email/password for body_fields auth'
);

-- Dispatch-time auth injection places credentials into the outgoing body.
SELECT is(
  (public.get_job_call_spec((SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake))->'body'->>'email'),
  'user049@example.test',
  'get_job_call_spec injects email using auth_config_id binding'
);

SELECT is(
  (public.get_job_call_spec((SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake))->'body'->>'password'),
  'pass049',
  'get_job_call_spec injects password using auth_config_id binding'
);

SELECT is(
  (public.get_job_call_spec((SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake))->>'url'),
  'https://example.test/api/ship/request/by-email?a=1&b=2',
  'outbound URL composed from provider base_url + path + query'
);

UPDATE public.provider_auth_configs
   SET expires_at = now() - INTERVAL '1 minute'
 WHERE id = '11110000-0000-0000-0000-000000000049'::uuid;

SELECT is(
  public.get_provider_auth_credentials('11110000-0000-0000-0000-000000000049'::uuid),
  NULL::jsonb,
  'expired provider_auth_configs do not resolve dispatch credentials'
);

SELECT throws_ok(
  format(
    'SELECT public.get_job_call_spec(%L::uuid)',
    (SELECT result->>'outbound_call_id' FROM tmp_api_gateway_intake)
  ),
  'get_job_call_spec: credentials_missing (auth_config_id=11110000-0000-0000-0000-000000000049 job_id=' || (SELECT result->>'outbound_call_id' FROM tmp_api_gateway_intake) || ')',
  'API Gateway dispatch fails closed when the bound provider credential is expired'
);

CREATE TEMP TABLE tmp_api_gateway_intake_expired_provider_credential AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-049',
  'POST',
  '/api/ship/request/by-email',
  '',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'pkg', jsonb_build_object('receiverName', 'Expired Credential Receiver', 'receiverPhone', '0500000149'),
    'destinationAddress', jsonb_build_object('addressLine1', 'Expired credential test', 'city', 'Riyadh')
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_intake_expired_provider_credential),
  'error',
  'workflow_intake_api_gateway_v1 fails closed before provider dispatch when bound provider credential is expired'
);

SELECT is(
  (SELECT (result->>'status')::int FROM tmp_api_gateway_intake_expired_provider_credential),
  424,
  'workflow_intake_api_gateway_v1 returns 424 for unavailable provider credential'
);

SELECT is(
  (SELECT result->'body'->>'error' FROM tmp_api_gateway_intake_expired_provider_credential),
  'provider_auth_config_unavailable',
  'workflow_intake_api_gateway_v1 returns provider_auth_config_unavailable'
);

SELECT is(
  (
    SELECT oc.status
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_expired_provider_credential)
  ),
  'permanently_failed',
  'unavailable provider credential creates terminal outbound readback, not pending provider dispatch'
);

SELECT is(
  (
    SELECT oc.response_status_code
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_expired_provider_credential)
  ),
  424,
  'unavailable provider credential outbound readback records 424'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log dl
    WHERE dl.resource_type = 'api_gateway_request'
      AND dl.resource_id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_intake_expired_provider_credential)
      AND dl.decision_point = 'api_gateway_provider_account_credential_available'
      AND dl.decision_outcome = 'rejected'
  ),
  'unavailable provider credential writes canonical credential-availability decision'
);

UPDATE public.provider_auth_configs
   SET expires_at = now() + INTERVAL '30 days'
 WHERE id = '11110000-0000-0000-0000-000000000049'::uuid;

INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials, expires_at)
VALUES (
  '11110000-0000-0000-0000-000000000051'::uuid,
  'ffff0000-0000-0000-0000-000000000049'::uuid,
  'basic_auth',
  jsonb_build_object('revoked', true, 'username', 'revoked@example.test', 'password', 'do-not-use'),
  now() + INTERVAL '30 days'
)
ON CONFLICT (id) DO UPDATE
   SET provider_id = EXCLUDED.provider_id,
       auth_type = EXCLUDED.auth_type,
       credentials = EXCLUDED.credentials,
       credentials_vault_id = NULL,
       expires_at = EXCLUDED.expires_at;

SELECT is(
  public.get_provider_auth_credentials('11110000-0000-0000-0000-000000000051'::uuid),
  NULL::jsonb,
  'revoked provider_auth_configs tombstones do not resolve dispatch credentials'
);

UPDATE public.settings_versions_p0
   SET value = jsonb_build_object(
       'auth_config_id', '11110000-0000-0000-0000-000000000051',
       'company_id', '362',
       'enabled', TRUE
     )
 WHERE id = '77770000-0000-0000-0000-000000000049'
   AND scope_hash = 'eeee0000-0000-0000-0000-000000000049';

UPDATE public.settings
   SET cached_value = jsonb_build_object(
       'auth_config_id', '11110000-0000-0000-0000-000000000051',
       'company_id', '362',
       'enabled', TRUE
     ),
       last_updated = now()
 WHERE category = 'logestechs_v2_account'
   AND scope_type = 'source'
   AND scope_hash = 'eeee0000-0000-0000-0000-000000000049';

CREATE TEMP TABLE tmp_api_gateway_intake_revoked_provider_credential AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-049',
  'POST',
  '/api/ship/request/by-email',
  '',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'pkg', jsonb_build_object('receiverName', 'Revoked Credential Receiver', 'receiverPhone', '0500000249'),
    'destinationAddress', jsonb_build_object('addressLine1', 'Revoked credential test', 'city', 'Riyadh')
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_intake_revoked_provider_credential),
  'error',
  'workflow_intake_api_gateway_v1 fails closed before provider dispatch when bound provider credential is revoked'
);

SELECT is(
  (SELECT (result->>'status')::int FROM tmp_api_gateway_intake_revoked_provider_credential),
  424,
  'workflow_intake_api_gateway_v1 returns 424 for revoked provider credential'
);

SELECT is(
  (SELECT result->'body'->>'error' FROM tmp_api_gateway_intake_revoked_provider_credential),
  'provider_auth_config_unavailable',
  'workflow_intake_api_gateway_v1 returns provider_auth_config_unavailable for revoked credential'
);

SELECT is(
  (
    SELECT oc.status
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_revoked_provider_credential)
  ),
  'permanently_failed',
  'revoked provider credential creates terminal outbound readback, not pending provider dispatch'
);

SELECT is(
  (
    SELECT oc.response_status_code
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_revoked_provider_credential)
  ),
  424,
  'revoked provider credential outbound readback records 424'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log dl
    WHERE dl.resource_type = 'api_gateway_request'
      AND dl.resource_id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_intake_revoked_provider_credential)
      AND dl.decision_point = 'api_gateway_provider_account_credential_available'
      AND dl.decision_outcome = 'rejected'
  ),
  'revoked provider credential writes canonical credential-availability decision'
);

UPDATE public.settings_versions_p0
   SET value = jsonb_build_object(
       'auth_config_id', '11110000-0000-0000-0000-000000000049',
       'company_id', '362',
       'enabled', TRUE
     )
 WHERE id = '77770000-0000-0000-0000-000000000049'
   AND scope_hash = 'eeee0000-0000-0000-0000-000000000049';

UPDATE public.settings
   SET cached_value = jsonb_build_object(
       'auth_config_id', '11110000-0000-0000-0000-000000000049',
       'company_id', '362',
       'enabled', TRUE
     ),
       last_updated = now()
 WHERE category = 'logestechs_v2_account'
   AND scope_type = 'source'
   AND scope_hash = 'eeee0000-0000-0000-0000-000000000049';

-- Query string should also work when provided without a leading '?' (no unintended trimming).
CREATE TEMP TABLE tmp_api_gateway_intake_query_no_qmark AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-049',
  'POST',
  '/api/ship/request/by-email',
  'a=1&b=2',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'pkg', jsonb_build_object('receiverName', 'QA Receiver', 'receiverPhone', '0500000049'),
    'destinationAddress', jsonb_build_object('addressLine1', 'Test', 'city', 'Riyadh')
  )
) AS result;

SELECT is(
  (
    SELECT query_string
    FROM public.api_gateway_requests
    WHERE id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_intake_query_no_qmark)
  ),
  'a=1&b=2',
  'api_gateway_requests stores query_string without trimming first char'
);

SELECT is(
  (public.get_job_call_spec((SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_query_no_qmark))->>'url'),
  'https://example.test/api/ship/request/by-email?a=1&b=2',
  'outbound URL composes query_string correctly without leading ?'
);

-- ----------------------------------------------------------------------------
-- Company-id safety: when a route carries {companyId} and provider_account.company_id is configured,
-- refuse mismatched companyId in the inbound path.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE tmp_api_gateway_intake_company_mismatch AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-049',
  'PUT',
  '/api/guests/999/packages/SHIP049/cancel',
  '',
  jsonb_build_object('content-type', 'application/json'),
  '{}'::jsonb
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_intake_company_mismatch),
  'error',
  'workflow_intake_api_gateway_v1 rejects provider companyId mismatch in path'
);

SELECT is(
  (SELECT result->'body'->>'error' FROM tmp_api_gateway_intake_company_mismatch),
  'provider_company_id_mismatch',
  'workflow_intake_api_gateway_v1 returns provider_company_id_mismatch'
);

-- ----------------------------------------------------------------------------
-- Ambiguity safety: when multiple auth configs exist and no auth_config_id is bound, reject.
-- ----------------------------------------------------------------------------

INSERT INTO webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  'eeee0000-0000-0000-0000-000000000050',
  'aaaa0000-0000-0000-0000-000000000049',
  'pgtap-api-gateway-source-050',
  'API Gateway Source 050',
  'api_gateway',
  'token-api-gateway-050',
  'dddd0000-0000-0000-0000-000000000049',
  1000,
  TRUE,
  'cccc0000-0000-0000-0000-000000000049'
)
ON CONFLICT (id) DO NOTHING;

-- Seed provider_account for source-050 WITHOUT auth_config_id to force ambiguity handling.
-- This makes the test robust even if a global logestechs_v2_account exists outside this transaction.
INSERT INTO settings_versions_p0 (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
VALUES (
  '77770000-0000-0000-0000-000000000050',
  'logestechs_v2_account',
  'source',
  'eeee0000-0000-0000-0000-000000000050',
  'eeee0000-0000-0000-0000-000000000050',
  1,
  jsonb_build_object(
    'company_id', '362',
    'enabled', TRUE
  ),
  1,
  'pgTAP seed logestechs_v2_account for source-050 (no auth_config_id)',
  now(),
  now()
)
ON CONFLICT (id, scope_hash) DO NOTHING;

INSERT INTO settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
VALUES (
  'logestechs_v2_account',
  'source',
  'eeee0000-0000-0000-0000-000000000050',
  'eeee0000-0000-0000-0000-000000000050',
  '77770000-0000-0000-0000-000000000050',
  jsonb_build_object(
    'company_id', '362',
    'enabled', TRUE
  ),
  now()
)
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

CREATE TEMP TABLE tmp_api_gateway_intake_ambiguous AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-050',
  'POST',
  '/api/ship/request/by-email',
  '',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'pkg', jsonb_build_object(
      'receiverName', 'QA Receiver',
      'receiverPhone', '0500000049'
    )
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_intake_ambiguous),
  'error',
  'workflow_intake_api_gateway_v1 rejects ambiguous provider auth without binding'
);

SELECT is(
  (SELECT result->'body'->>'error' FROM tmp_api_gateway_intake_ambiguous),
  'provider_auth_config_ambiguous',
  'workflow_intake_api_gateway_v1 returns provider_auth_config_ambiguous'
);

-- ----------------------------------------------------------------------------
-- Merged provider-account safety: Console V2 may bind provider credentials at
-- tenant scope while sender/source settings carry operational account fields
-- such as company_id. Dispatch must use the merged row-driven value.
-- ----------------------------------------------------------------------------

DELETE FROM public.settings
 WHERE category = 'logestechs_v2_account'
   AND scope_type = 'tenant'
   AND scope_hash = 'aaaa0000-0000-0000-0000-000000000049';

DELETE FROM public.settings_versions_p0
 WHERE category = 'logestechs_v2_account'
   AND scope_type = 'tenant'
   AND scope_hash = 'aaaa0000-0000-0000-0000-000000000049';

DELETE FROM public.settings
 WHERE category = 'logestechs_v2_account'
   AND scope_type = 'sender'
   AND scope_hash = 'cccc0000-0000-0000-0000-000000000049';

DELETE FROM public.settings_versions_p0
 WHERE category = 'logestechs_v2_account'
   AND scope_type = 'sender'
   AND scope_hash = 'cccc0000-0000-0000-0000-000000000049';

INSERT INTO webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  'eeee0000-0000-0000-0000-000000000051',
  'aaaa0000-0000-0000-0000-000000000049',
  'pgtap-api-gateway-source-051',
  'API Gateway Source 051',
  'api_gateway',
  'token-api-gateway-051',
  'dddd0000-0000-0000-0000-000000000049',
  1000,
  TRUE,
  'cccc0000-0000-0000-0000-000000000049'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO settings_versions_p0 (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
VALUES (
  '77770000-0000-0000-0000-000000000051',
  'logestechs_v2_account',
  'tenant',
  'aaaa0000-0000-0000-0000-000000000049',
  'aaaa0000-0000-0000-0000-000000000049',
  1,
  jsonb_build_object(
    'auth_config_id', '11110000-0000-0000-0000-000000000049',
    'enabled', TRUE
  ),
  1,
  'pgTAP seed tenant auth_config_id for merged provider account',
  now(),
  now()
)
ON CONFLICT (id, scope_hash) DO NOTHING;

INSERT INTO settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
VALUES (
  'logestechs_v2_account',
  'tenant',
  'aaaa0000-0000-0000-0000-000000000049',
  'aaaa0000-0000-0000-0000-000000000049',
  '77770000-0000-0000-0000-000000000051',
  jsonb_build_object(
    'auth_config_id', '11110000-0000-0000-0000-000000000049',
    'enabled', TRUE
  ),
  now()
)
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

INSERT INTO settings_versions_p0 (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
VALUES (
  '77771000-0000-0000-0000-000000000051',
  'logestechs_v2_account',
  'sender',
  'cccc0000-0000-0000-0000-000000000049',
  'cccc0000-0000-0000-0000-000000000049',
  1,
  jsonb_build_object(
    'company_id', '362',
    'enabled', TRUE
  ),
  1,
  'pgTAP seed sender company_id for merged provider account',
  now(),
  now()
)
ON CONFLICT (id, scope_hash) DO NOTHING;

INSERT INTO settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
VALUES (
  'logestechs_v2_account',
  'sender',
  'cccc0000-0000-0000-0000-000000000049',
  'cccc0000-0000-0000-0000-000000000049',
  '77771000-0000-0000-0000-000000000051',
  jsonb_build_object(
    'company_id', '362',
    'enabled', TRUE
  ),
  now()
)
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

CREATE TEMP TABLE tmp_api_gateway_intake_merged_provider_account AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-051',
  'POST',
  '/api/ship/request/by-email',
  '',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'pkg', jsonb_build_object(
      'receiverName', 'QA Receiver 051',
      'receiverPhone', '0500000051'
    ),
    'destinationAddress', jsonb_build_object('addressLine1', 'Test', 'city', 'Riyadh')
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_intake_merged_provider_account),
  'proxy',
  'workflow_intake_api_gateway_v1 accepts merged tenant-auth plus sender-company provider account'
);

SELECT is(
  (
    SELECT headers->>'company-id'
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_merged_provider_account)
  ),
  '362',
  'merged provider account keeps sender-scoped company-id for dispatch'
);

SELECT is(
  (
    SELECT context->'auth'->>'auth_config_id'
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_merged_provider_account)
  ),
  '11110000-0000-0000-0000-000000000049',
  'merged provider account inherits tenant-scoped auth_config_id for dispatch'
);

SELECT is(
  (
    public.get_job_call_spec(
      (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_merged_provider_account)
    )->'body'->>'email'
  ),
  'user049@example.test',
  'dispatch-time auth injection resolves credentials from inherited tenant auth_config_id'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT (result->>'outbound_call_id')::uuid FROM tmp_api_gateway_intake_merged_provider_account)
      AND (oc.body ? 'email' OR oc.body ? 'password')
  ),
  'merged provider-account outbound payload still strips credential fields at rest'
);

SELECT * FROM finish();

ROLLBACK;

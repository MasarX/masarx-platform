-- pgTAP: Console V2 webhook source HMAC policy and Vault-backed receiver auth.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SELECT plan(30);

SELECT has_function(
  'public',
  'apply_webhook_source_hmac_policy_v1',
  ARRAY['uuid', 'boolean', 'uuid', 'text', 'text', 'text'],
  'public.apply_webhook_source_hmac_policy_v1 exists for source HMAC policy writes'
);

SELECT has_column(
  'public',
  'v_webhook_source_directory',
  'hmac_enabled',
  'webhook source directory exposes effective HMAC enabled state'
);

SELECT has_column(
  'public',
  'v_webhook_source_directory',
  'hmac_auth_config_id',
  'webhook source directory exposes the HMAC auth config binding without secret material'
);

SELECT ok(
  pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    LIKE '%public.get_provider_auth_credentials(v_auth_config_id)%',
  'workflow_intake_webhook_core_v1 resolves HMAC secrets through Vault-aware provider credentials'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01'::uuid,
  'Console V2 Webhook HMAC Org',
  'console-v2-webhook-hmac-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b10'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01'::uuid,
  'console-v2-webhook-hmac@example.test',
  'Console V2 Webhook HMAC Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    user_type = EXCLUDED.user_type,
    access_scope_type = EXCLUDED.access_scope_type,
    status = EXCLUDED.status;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b21'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01'::uuid,
  'Console HMAC Client',
  'console-hmac-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    status = EXCLUDED.status;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b31'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b21'::uuid,
  'Console HMAC Sender',
  'Console HMAC Sender',
  false,
  true,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    status = EXCLUDED.status;

INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status, metadata)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b41'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01'::uuid,
  'Console HMAC Provider',
  'webhook',
  TRUE,
  991,
  'healthy',
  jsonb_build_object('vendor', 'Console HMAC')
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    provider_type = EXCLUDED.provider_type,
    enabled = EXCLUDED.enabled,
    metadata = EXCLUDED.metadata;

WITH secret AS (
  SELECT vault.create_secret(
    jsonb_build_object('signing_secret', 'console-v2-hmac-secret')::text,
    'provider_auth_configs/c8f1d8f3-1e7f-4fb5-9f75-79f369473b42',
    'Console V2 webhook HMAC pgTAP secret',
    NULL
  ) AS vault_id
)
INSERT INTO public.provider_auth_configs (
  id,
  provider_id,
  auth_type,
  credentials,
  credentials_vault_id,
  expires_at
)
SELECT
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b41'::uuid,
  'hmac',
  NULL,
  secret.vault_id,
  now() + INTERVAL '180 days'
FROM secret
ON CONFLICT (id) DO UPDATE
SET provider_id = EXCLUDED.provider_id,
    auth_type = EXCLUDED.auth_type,
    credentials = NULL,
    credentials_vault_id = EXCLUDED.credentials_vault_id,
    expires_at = EXCLUDED.expires_at;

INSERT INTO public.integration_plugins (
  id,
  organization_id,
  plugin_key,
  name,
  plugin_kind,
  status,
  rollout_tier,
  reusable_within_tenant,
  managed_by
)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b51'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01'::uuid,
  'console-v2-webhook-hmac-source',
  'Console V2 Webhook HMAC Plugin',
  'webhook',
  'active',
  'tenant',
  true,
  'platform'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.integration_plugin_versions (
  id,
  plugin_id,
  organization_id,
  version_no,
  status,
  source_type,
  source_payload,
  normalized_contract,
  inbound_config,
  mapping_config,
  workflow_binding,
  outbound_operations,
  auth_bindings,
  validation_summary,
  metadata
)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b52'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b51'::uuid,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01'::uuid,
  1,
  'active',
  'webhook_sample',
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{"target":"shipments.create","rules":[]}'::jsonb,
  '{"template_name":"async_provider_dispatch_v1","intent":"shipment.create"}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    mapping_config = EXCLUDED.mapping_config,
    workflow_binding = EXCLUDED.workflow_binding,
    updated_at = now();

UPDATE public.integration_plugins
   SET active_version_id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b52'::uuid
 WHERE id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b51'::uuid;

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  organization_id,
  managed_by,
  managed_metadata,
  notes
)
VALUES (
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b53'::uuid,
  'webhook_inbound',
  'integration_plugin:c8f1d8f3-1e7f-4fb5-9f75-79f369473b52:source:tenant:c8f1d8f3-1e7f-4fb5-9f75-79f369473b01',
  '{"target":"shipments.create","rules":[]}'::jsonb,
  1,
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01'::uuid,
  'integration_plugin',
  jsonb_build_object('plugin_version_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b52'),
  'Console V2 webhook HMAC pgTAP mapping'
)
ON CONFLICT (id) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    mapping_key = EXCLUDED.mapping_key,
    organization_id = EXCLUDED.organization_id,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now();

SELECT set_config('request.jwt.claim.sub', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b10', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b10',
    'role', 'authenticated',
    'email', 'console-v2-webhook-hmac@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SET LOCAL search_path TO public, extensions, pg_temp;

CREATE TEMP TABLE _webhook_hmac_source_result AS
SELECT public.ui_upsert_webhook_source_v1(jsonb_build_object(
  'organization_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b01',
  'source_identifier', 'console-v2-webhook-hmac-source',
  'name', 'Console V2 HMAC Source',
  'provider_type', 'generic',
  'mapping_config_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b53',
  'sender_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b31',
  'rate_limit_per_hour', 1200,
  'enabled', true,
  'hmac_enabled', true,
  'hmac_auth_config_id', 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42',
  'hmac_header', 'x-signature'
)) AS result;

RESET ROLE;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE TEMP TABLE _webhook_hmac_policy_readback AS
SELECT p.policy
  FROM public.webhook_sources ws
  CROSS JOIN LATERAL public.resolve_webhook_ingest_policy(ws.id) p
 WHERE ws.source_identifier = 'console-v2-webhook-hmac-source'
 LIMIT 1;

CREATE TEMP TABLE _webhook_hmac_directory_readback AS
SELECT hmac_enabled, hmac_auth_config_id::text AS hmac_auth_config_id, hmac_header
  FROM public.v_webhook_source_directory
 WHERE source_identifier = 'console-v2-webhook-hmac-source'
 LIMIT 1;

CREATE TEMP TABLE _webhook_hmac_valid AS
WITH source AS (
  SELECT (r.result->>'auth_token') AS token
  FROM _webhook_hmac_source_result r
),
payload AS (
  SELECT '{"event":{"id":"console-v2-hmac-valid-1","type":"shipment.created"},"shipment":{"external_id":"console-v2-hmac-valid-1","recipient":{"name":"HMAC Valid","phone":"+12025550123"},"address":{"line1":"Riyadh","city":"Riyadh"},"cod":{"amount":0}}}'::text AS raw_body
),
signed AS (
  SELECT source.token,
         payload.raw_body,
         encode(hmac(payload.raw_body::bytea, 'console-v2-hmac-secret'::bytea, 'sha256'), 'hex') AS signature
    FROM source, payload
)
SELECT public.workflow_intake_webhook_core_v1(
  signed.token,
  jsonb_build_object(
    'x-signature', signed.signature,
    'idempotency-key', 'console-v2-hmac-valid-1'
  ),
  signed.raw_body,
  signed.raw_body::jsonb
) AS result
FROM signed;

CREATE TEMP TABLE _webhook_hmac_invalid AS
WITH source AS (
  SELECT (r.result->>'auth_token') AS token
  FROM _webhook_hmac_source_result r
),
payload AS (
  SELECT '{"event":{"id":"console-v2-hmac-invalid-1","type":"shipment.created"}}'::text AS raw_body
)
SELECT public.workflow_intake_webhook_core_v1(
  source.token,
  jsonb_build_object(
    'x-signature', 'not-a-valid-signature',
    'idempotency-key', 'console-v2-hmac-invalid-1'
  ),
  payload.raw_body,
  payload.raw_body::jsonb
) AS result
FROM source, payload;

CREATE TEMP TABLE _webhook_hmac_missing_signature AS
WITH source AS (
  SELECT (r.result->>'auth_token') AS token
  FROM _webhook_hmac_source_result r
),
payload AS (
  SELECT '{"event":{"id":"console-v2-hmac-missing-signature-1","type":"shipment.created"}}'::text AS raw_body
)
SELECT public.workflow_intake_webhook_core_v1(
  source.token,
  jsonb_build_object(
    'idempotency-key', 'console-v2-hmac-missing-signature-1'
  ),
  payload.raw_body,
  payload.raw_body::jsonb
) AS result
FROM source, payload;

CREATE TEMP TABLE _webhook_hmac_missing_auth_config_policy AS
WITH source AS (
  SELECT id
    FROM public.webhook_sources
   WHERE source_identifier = 'console-v2-webhook-hmac-source'
   LIMIT 1
),
updated_settings AS (
  UPDATE public.settings s
     SET cached_value = jsonb_set(
           s.cached_value,
           '{validation,hmac}',
           (s.cached_value#>'{validation,hmac}') - 'auth_config_id',
           TRUE
         ),
         last_updated = now()
    FROM source
   WHERE s.category = 'webhook_ingest_policy'
     AND s.scope_type = 'source'
     AND s.scope_id = source.id
  RETURNING s.id
),
updated_versions AS (
  UPDATE public.settings_versions sv
     SET value = jsonb_set(
           sv.value,
           '{validation,hmac}',
           (sv.value#>'{validation,hmac}') - 'auth_config_id',
           TRUE
         ),
         updated_at = now()
    FROM source
   WHERE sv.category = 'webhook_ingest_policy'
     AND sv.scope_type = 'source'
     AND sv.scope_id = source.id
  RETURNING sv.id
)
SELECT (SELECT count(*) FROM updated_settings)::int AS settings_rows,
       (SELECT count(*) FROM updated_versions)::int AS version_rows;

CREATE TEMP TABLE _webhook_hmac_missing_auth_config AS
WITH source AS (
  SELECT (r.result->>'auth_token') AS token
  FROM _webhook_hmac_source_result r
),
payload AS (
  SELECT '{"event":{"id":"console-v2-hmac-missing-auth-config-1","type":"shipment.created"}}'::text AS raw_body
)
SELECT public.workflow_intake_webhook_core_v1(
  source.token,
  jsonb_build_object(
    'x-signature', 'missing-auth-config-signature',
    'idempotency-key', 'console-v2-hmac-missing-auth-config-1'
  ),
  payload.raw_body,
  payload.raw_body::jsonb
) AS result
FROM source, payload;

CREATE TEMP TABLE _webhook_hmac_restored_policy AS
WITH source AS (
  SELECT id
    FROM public.webhook_sources
   WHERE source_identifier = 'console-v2-webhook-hmac-source'
   LIMIT 1
),
updated_settings AS (
  UPDATE public.settings s
     SET cached_value = jsonb_set(
           s.cached_value,
           '{validation,hmac,auth_config_id}',
           to_jsonb('c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::text),
           TRUE
         ),
         last_updated = now()
    FROM source
   WHERE s.category = 'webhook_ingest_policy'
     AND s.scope_type = 'source'
     AND s.scope_id = source.id
  RETURNING s.id
),
updated_versions AS (
  UPDATE public.settings_versions sv
     SET value = jsonb_set(
           sv.value,
           '{validation,hmac,auth_config_id}',
           to_jsonb('c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::text),
           TRUE
         ),
         updated_at = now()
    FROM source
   WHERE sv.category = 'webhook_ingest_policy'
     AND sv.scope_type = 'source'
     AND sv.scope_id = source.id
  RETURNING sv.id
)
SELECT (SELECT count(*) FROM updated_settings)::int AS settings_rows,
       (SELECT count(*) FROM updated_versions)::int AS version_rows;

UPDATE public.provider_auth_configs
   SET expires_at = now() - interval '1 minute'
 WHERE id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::uuid;

CREATE TEMP TABLE _webhook_hmac_expired AS
WITH source AS (
  SELECT (r.result->>'auth_token') AS token
  FROM _webhook_hmac_source_result r
),
payload AS (
  SELECT '{"event":{"id":"console-v2-hmac-expired-1","type":"shipment.created"}}'::text AS raw_body
)
SELECT public.workflow_intake_webhook_core_v1(
  source.token,
  jsonb_build_object(
    'x-signature', 'expired-credential-signature',
    'idempotency-key', 'console-v2-hmac-expired-1'
  ),
  payload.raw_body,
  payload.raw_body::jsonb
) AS result
FROM source, payload;

SELECT is(
  (SELECT result->>'ok' FROM _webhook_hmac_source_result LIMIT 1),
  'true',
  'ui_upsert_webhook_source_v1 accepts HMAC policy fields with a source upsert'
);

SELECT is(
  (SELECT result#>>'{hmac_policy,hmac_enabled}' FROM _webhook_hmac_source_result LIMIT 1),
  'true',
  'source upsert returns HMAC policy write evidence'
);

SELECT is(
  (SELECT policy#>>'{validation,hmac,auth_config_id}' FROM _webhook_hmac_policy_readback LIMIT 1),
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42',
  'source-level webhook_ingest_policy stores the selected HMAC auth config id'
);

SELECT is(
  (SELECT hmac_enabled::text FROM _webhook_hmac_directory_readback LIMIT 1),
  'true',
  'webhook source directory readback shows HMAC required'
);

SELECT is(
  (SELECT hmac_auth_config_id FROM _webhook_hmac_directory_readback LIMIT 1),
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42',
  'webhook source directory readback exposes only the HMAC credential id'
);

SELECT is(
  (SELECT result->>'ack_outcome' FROM _webhook_hmac_valid LIMIT 1),
  'ack_sent',
  'receiver accepts a valid HMAC signed payload using Vault-backed credentials'
);

SELECT is(
  (SELECT result->>'response_reason' FROM _webhook_hmac_invalid LIMIT 1),
  'HMAC signature mismatch',
  'receiver rejects an invalid HMAC signature without falling back to token-only intake'
);

SELECT is(
  (
    SELECT dl.decision_inputs#>>'{validation_results,hmac,status}'
      FROM public.decision_log dl
     WHERE dl.resource_type = 'webhook_inbox'
       AND dl.resource_id = ((SELECT result->>'webhook_id' FROM _webhook_hmac_valid LIMIT 1))::uuid
     ORDER BY dl.created_at DESC
     LIMIT 1
  ),
  'passed',
  'decision log records HMAC validation pass for governance readback'
);

SELECT is(
  (
    SELECT wi.ack_validation#>>'{hmac,status}'
      FROM public.webhook_inbox wi
     WHERE wi.id = ((SELECT result->>'webhook_id' FROM _webhook_hmac_valid LIMIT 1))::uuid
     LIMIT 1
  ),
  'passed',
  'webhook inbox readback persists HMAC validation pass for Console V2 governance proof'
);

SELECT is(
  (
    SELECT wi.ack_validation#>>'{hmac,message}'
      FROM public.webhook_inbox wi
     WHERE wi.id = ((SELECT result->>'webhook_id' FROM _webhook_hmac_invalid LIMIT 1))::uuid
     LIMIT 1
  ),
  'HMAC signature mismatch',
  'webhook inbox readback persists HMAC validation failure reason for Console V2 governance proof'
);

SELECT is(
  (
    SELECT wi.processing_status
      FROM public.webhook_inbox wi
     WHERE wi.id = ((SELECT result->>'webhook_id' FROM _webhook_hmac_invalid LIMIT 1))::uuid
     LIMIT 1
  ),
  'failed',
  'webhook inbox readback marks HMAC acknowledgement failures as terminal failed'
);

SELECT is(
  COALESCE((
    SELECT wi.workflow_run_id::text
      FROM public.webhook_inbox wi
     WHERE wi.id = ((SELECT result->>'webhook_id' FROM _webhook_hmac_invalid LIMIT 1))::uuid
     LIMIT 1
  ), ''),
  '',
  'HMAC acknowledgement failure does not attach a shipment workflow run'
);

SELECT is(
  (
    SELECT count(*)::text
      FROM public.shipments s
     WHERE s.metadata::text LIKE '%console-v2-hmac-invalid-1%'
  ),
  '0',
  'HMAC acknowledgement failure does not materialize a shipment'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory r
     WHERE r.request_id = 'console-v2-hmac-invalid-1'
       AND r.service = 'webhook_receiver'
       AND r.credential_kind = 'hmac_signature'
       AND r.failure_code = 'hmac_signature_mismatch'
       AND r.source_identifier = 'console-v2-webhook-hmac-source'
       AND r.provider_auth_config_id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::uuid
       AND NOT (r.request_headers ? 'x-signature')
       AND r.request_headers::text NOT LIKE '%not-a-valid-signature%'
       AND r.metadata#>>'{auth_surface}' = 'hmac_signature'
  ),
  'HMAC signature mismatch is visible in webhook auth rejections with source lineage and no stored signature header'
);

SELECT is(
  (SELECT count(*)::text FROM public.intake_auth_rejections WHERE request_id = 'console-v2-hmac-invalid-1'),
  '1',
  'HMAC signature mismatch records one auth-rejection row for the receiver attempt'
);

SELECT is(
  (SELECT result->>'response_reason' FROM _webhook_hmac_missing_signature LIMIT 1),
  'Missing signature header x-signature',
  'receiver rejects a missing HMAC signature header without falling back to token-only intake'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory r
     WHERE r.request_id = 'console-v2-hmac-missing-signature-1'
       AND r.service = 'webhook_receiver'
       AND r.credential_kind = 'hmac_signature'
       AND r.failure_code = 'hmac_signature_missing'
       AND r.source_identifier = 'console-v2-webhook-hmac-source'
       AND r.provider_auth_config_id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::uuid
       AND NOT (r.request_headers ? 'x-signature')
       AND r.metadata#>>'{provided_signature_present}' = 'false'
       AND r.metadata#>>'{auth_surface}' = 'hmac_signature'
  ),
  'missing HMAC signature is visible in webhook auth rejections with source lineage'
);

SELECT is(
  (SELECT result->>'response_reason' FROM _webhook_hmac_missing_auth_config LIMIT 1),
  'Missing auth_config reference for HMAC validation',
  'receiver rejects an HMAC-enabled source when the policy has no auth config reference'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory r
     WHERE r.request_id = 'console-v2-hmac-missing-auth-config-1'
       AND r.service = 'webhook_receiver'
       AND r.credential_kind = 'hmac_signature'
       AND r.failure_code = 'hmac_auth_config_missing'
       AND r.source_identifier = 'console-v2-webhook-hmac-source'
       AND r.provider_auth_config_id IS NULL
       AND NOT (r.request_headers ? 'x-signature')
       AND r.request_headers::text NOT LIKE '%missing-auth-config-signature%'
       AND r.metadata#>>'{provided_signature_present}' = 'true'
       AND r.metadata#>>'{auth_surface}' = 'hmac_signature'
  ),
  'missing HMAC auth config is visible in webhook auth rejections with no stored signature header'
);

SELECT is(
  (SELECT result->>'response_reason' FROM _webhook_hmac_expired LIMIT 1),
  'Signing secret missing',
  'receiver rejects expired HMAC credentials without accepting the signature'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_intake_auth_rejection_directory r
     WHERE r.request_id = 'console-v2-hmac-expired-1'
       AND r.service = 'webhook_receiver'
       AND r.credential_kind = 'hmac_signature'
       AND r.failure_code = 'hmac_credential_expired'
       AND r.source_identifier = 'console-v2-webhook-hmac-source'
       AND r.provider_auth_config_id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::uuid
       AND NOT (r.request_headers ? 'x-signature')
       AND r.request_headers::text NOT LIKE '%expired-credential-signature%'
  ),
  'expired HMAC credential failure is visible in webhook auth rejections with no stored signature header'
);

SELECT is(
  COALESCE((
    SELECT wi.workflow_run_id::text
      FROM public.webhook_inbox wi
     WHERE wi.id = ((SELECT result->>'webhook_id' FROM _webhook_hmac_expired LIMIT 1))::uuid
     LIMIT 1
  ), ''),
  '',
  'expired HMAC credential failure does not attach a shipment workflow run'
);

SELECT is(
  (
    SELECT count(*)::text
      FROM public.shipments s
     WHERE s.metadata::text LIKE '%console-v2-hmac-expired-1%'
  ),
  '0',
  'expired HMAC credential failure does not materialize a shipment'
);

SELECT is(
  (
    SELECT count(*)::text
      FROM public.provider_auth_configs pac
     WHERE pac.id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b42'::uuid
       AND pac.credentials IS NULL
       AND pac.credentials_vault_id IS NOT NULL
  ),
  '1',
  'HMAC credential remains Vault-backed with no plaintext provider_auth_configs credentials'
);

UPDATE public.integration_plugin_versions
   SET mapping_config = '{"target":"shipment.created","rules":[]}'::jsonb,
       workflow_binding = '{"template_name":"async_provider_dispatch_v1","intent":"shipment.created"}'::jsonb,
       updated_at = now()
 WHERE id = 'c8f1d8f3-1e7f-4fb5-9f75-79f369473b52'::uuid;

CREATE TEMP TABLE _webhook_created_alias_repair AS
SELECT public.repair_integration_plugin_webhook_policy_v1(
  (
    SELECT ws.id
      FROM public.webhook_sources ws
     WHERE ws.source_identifier = 'console-v2-webhook-hmac-source'
     LIMIT 1
  ),
  'c8f1d8f3-1e7f-4fb5-9f75-79f369473b52'::uuid
) AS result;

SELECT is(
  (SELECT result->>'canonical_intent' FROM _webhook_created_alias_repair LIMIT 1),
  'shipment.create',
  'webhook policy repair normalizes shipment.created plugin intent to canonical shipment.create'
);

SELECT is(
  (
    SELECT policy#>>'{workflow,intent}'
      FROM public.resolve_webhook_ingest_policy((
        SELECT ws.id
          FROM public.webhook_sources ws
         WHERE ws.source_identifier = 'console-v2-webhook-hmac-source'
         LIMIT 1
      ))
     LIMIT 1
  ),
  'shipment.create',
  'source-level webhook policy remains shipment.create after shipment.created alias repair'
);

SELECT * FROM finish();

ROLLBACK;

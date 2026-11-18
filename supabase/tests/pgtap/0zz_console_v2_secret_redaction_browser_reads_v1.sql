-- pgTAP: Console V2 browser-facing webhook/authentication reads stay redacted.
--
-- Scope:
--   - Generic ui_list/ui_get resource reads for webhook_sources and
--     provider_auth_configs must route through browser-safe projections.
--   - Credential write RPC must persist Vault-backed material without table
--     plaintext.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_secret_redaction_browser_reads_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000099104501';
  v_user UUID := '00000000-0000-0000-0000-000099104511';
  v_provider UUID := '00000000-0000-0000-0000-000099104521';
  v_mapping UUID := '00000000-0000-0000-0000-000099104531';
  v_source UUID := '00000000-0000-0000-0000-000099104541';
  v_config UUID := '00000000-0000-0000-0000-000099104551';
  v_created_config UUID;
  v_source_get JSONB;
  v_source_list JSONB;
  v_cred_get JSONB;
  v_cred_list JSONB;
  v_upsert JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Secret Redaction Org', 'console-v2-secret-redaction')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'console-v2-secret-redaction@example.com',
    'Console V2 Secret Redaction Admin',
    'super_admin',
    'active',
    'platform',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status, metadata)
  VALUES (
    v_provider,
    v_org,
    'Console V2 Redaction Provider',
    'http',
    TRUE,
    990,
    'healthy',
    jsonb_build_object('vendor', 'Redaction Test')
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         provider_type = EXCLUDED.provider_type,
         enabled = EXCLUDED.enabled,
         metadata = EXCLUDED.metadata;

  INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials, expires_at)
  VALUES (
    v_config,
    v_provider,
    'api_key',
    jsonb_build_object('api_key', 'raw-provider-secret-that-must-not-leak'),
    now() + INTERVAL '90 days'
  )
  ON CONFLICT (id) DO UPDATE
     SET provider_id = EXCLUDED.provider_id,
         auth_type = EXCLUDED.auth_type,
         credentials = EXCLUDED.credentials,
         credentials_vault_id = NULL,
         expires_at = EXCLUDED.expires_at;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'console-v2-secret-redaction-map',
    '{"target":"shipments.create","rules":[]}'::jsonb,
    1,
    'Console V2 secret redaction test mapping'
  )
  ON CONFLICT (mapping_type, mapping_key) DO UPDATE
     SET mapping_config = EXCLUDED.mapping_config,
         updated_at = now();

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    rate_limit_per_hour,
    enabled
  )
  VALUES (
    v_source,
    v_org,
    'console-v2-secret-redaction-source',
    'Console V2 Secret Redaction Source',
    'generic',
    'raw-webhook-token-that-must-not-leak',
    v_mapping,
    100,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         auth_token = EXCLUDED.auth_token,
         mapping_config_id = EXCLUDED.mapping_config_id,
         updated_at = now();

  RETURN NEXT is(
    (
      SELECT resource->>'relation'
        FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
       WHERE resource->>'key' = 'webhook_sources'
       LIMIT 1
    ),
    'public.v_webhook_source_directory',
    'webhook_sources generic read routes through the redacted source directory'
  );

  RETURN NEXT is(
    (
      SELECT resource->>'relation'
        FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
       WHERE resource->>'key' = 'provider_auth_configs'
       LIMIT 1
    ),
    'public.v_integration_credential_directory',
    'provider_auth_configs generic read routes through the redacted credential directory'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'v_webhook_source_directory'
         AND column_name IN ('auth_token', 'auth_token_hash')
    ),
    'webhook source directory does not expose raw token columns'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'v_integration_credential_directory'
         AND column_name IN ('credentials', 'credentials_vault_id')
    ),
    'credential directory does not expose raw credential columns'
  );

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_user::text,
      'organization_id', v_org::text,
      'access_scope_type', 'platform'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_source_get := public.ui_get_resource_v1('webhook_sources', v_source);
  v_source_list := public.ui_list_resource_v1(
    'webhook_sources',
    jsonb_build_object('organization_id', v_org::text),
    10,
    0,
    NULL::jsonb
  );

  RETURN NEXT ok(
    v_source_get->>'source_identifier' = 'console-v2-secret-redaction-source'
    AND NOT (v_source_get ? 'auth_token')
    AND NOT (v_source_get ? 'auth_token_hash')
    AND v_source_get->>'auth_token_masked' = 'stored',
    'ui_get_resource_v1(webhook_sources) returns source identity with token status only'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_source_list->'items', '[]'::jsonb)) AS item
       WHERE item ? 'auth_token'
          OR item ? 'auth_token_hash'
          OR item::text LIKE '%raw-webhook-token-that-must-not-leak%'
    ),
    'ui_list_resource_v1(webhook_sources) never includes raw token material'
  );

  v_cred_get := public.ui_get_resource_v1('provider_auth_configs', v_config);
  v_cred_list := public.ui_list_resource_v1(
    'provider_auth_configs',
    jsonb_build_object('organization_id', v_org::text),
    10,
    0,
    NULL::jsonb
  );

  RETURN NEXT ok(
    v_cred_get->>'provider_label' = 'Console V2 Redaction Provider'
    AND NOT (v_cred_get ? 'credentials')
    AND NOT (v_cred_get ? 'credentials_vault_id'),
    'ui_get_resource_v1(provider_auth_configs) returns credential metadata only'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_cred_list->'items', '[]'::jsonb)) AS item
       WHERE item ? 'credentials'
          OR item ? 'credentials_vault_id'
          OR item::text LIKE '%raw-provider-secret-that-must-not-leak%'
    ),
    'ui_list_resource_v1(provider_auth_configs) never includes credential material'
  );

  v_upsert := public.ui_upsert_provider_auth_config_v1(jsonb_build_object(
    'provider_id', v_provider,
    'auth_type', 'api_key',
    'credentials', jsonb_build_object('api_key', 'new-provider-secret-that-must-be-vaulted')
  ));
  v_created_config := NULLIF(v_upsert->>'provider_auth_config_id', '')::uuid;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    COALESCE((v_upsert->>'ok')::boolean, FALSE)
    AND v_created_config IS NOT NULL,
    'provider auth config write RPC returns backend credential id'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.provider_auth_configs pac
       WHERE pac.id = v_created_config
         AND pac.credentials IS NULL
         AND pac.credentials_vault_id IS NOT NULL
    ),
    'provider auth config write RPC stores new secret only in Vault'
  );

  RETURN NEXT is(
    public.get_provider_auth_credentials(v_created_config)->>'api_key',
    'new-provider-secret-that-must-be-vaulted',
    'Vault-backed credential resolves through the canonical helper'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  v_cred_get := public.ui_get_resource_v1('provider_auth_configs', v_created_config);

  RETURN NEXT ok(
    v_cred_get->>'provider_label' = 'Console V2 Redaction Provider'
    AND NOT (v_cred_get ? 'credentials')
    AND NOT (v_cred_get ? 'credentials_vault_id')
    AND v_cred_get::text NOT LIKE '%new-provider-secret-that-must-be-vaulted%',
    'newly vaulted credential remains redacted through generic browser readback'
  );

  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.ui_upsert_provider_auth_config_v1(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.ui_upsert_provider_auth_config_v1(jsonb)', 'EXECUTE'),
    'credential upsert RPC is available to authenticated callers only'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_secret_redaction_browser_reads_v1();

SELECT * FROM finish();
ROLLBACK;

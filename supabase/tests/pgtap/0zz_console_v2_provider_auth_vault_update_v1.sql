-- pgTAP: Console V2 provider credential edits replace the existing Vault
-- secret payload instead of creating duplicate canonical secret names.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

CREATE OR REPLACE FUNCTION pg_temp.test_provider_auth_vault_update_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000094000001';
  v_ops UUID := '00000000-0000-0000-0000-000094000011';
  v_provider UUID := '00000000-0000-0000-0000-000094000021';
  v_result JSONB := '{}'::jsonb;
  v_config_id UUID;
  v_initial_vault_id UUID;
  v_updated_vault_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Provider Auth Vault Update Org', 'console-v2-provider-auth-vault-update')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'console-v2-provider-auth-vault-update@example.com',
    'Console V2 Provider Auth Vault Update Ops',
    'ops_admin',
    'active',
    'tenant',
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
    'Console V2 Provider Auth Vault Update Provider',
    'webhook',
    TRUE,
    940,
    'healthy',
    jsonb_build_object('purpose', 'provider-auth-vault-update')
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         name = EXCLUDED.name,
         provider_type = EXCLUDED.provider_type,
         enabled = EXCLUDED.enabled,
         health_status = EXCLUDED.health_status;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_upsert_provider_auth_config_v1(jsonb_build_object(
    'provider_id', v_provider,
    'auth_type', 'api_key',
    'credentials', jsonb_build_object('api_key', 'pgtap-vault-created'),
    'expires_at', (now() + INTERVAL '90 days')::text
  ));
  v_config_id := NULLIF(v_result->>'provider_auth_config_id', '')::uuid;

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT pac.credentials_vault_id
    INTO v_initial_vault_id
    FROM public.provider_auth_configs pac
   WHERE pac.id = v_config_id;

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::boolean, FALSE)
    AND v_config_id IS NOT NULL
    AND v_initial_vault_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.provider_auth_configs pac
       WHERE pac.id = v_config_id
         AND pac.credentials IS NULL
    ),
    'provider credential create stores Vault pointer and redacts table credentials'
  );

  RETURN NEXT is(
    public.get_provider_auth_credentials(v_config_id)->>'api_key',
    'pgtap-vault-created',
    'created provider credential resolves through Vault helper'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_upsert_provider_auth_config_v1(jsonb_build_object(
    'config_id', v_config_id,
    'credentials', jsonb_build_object('api_key', 'pgtap-vault-updated'),
    'expires_at', (now() + INTERVAL '180 days')::text
  ));

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT pac.credentials_vault_id
    INTO v_updated_vault_id
    FROM public.provider_auth_configs pac
   WHERE pac.id = v_config_id;

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::boolean, FALSE)
    AND v_updated_vault_id = v_initial_vault_id
    AND EXISTS (
      SELECT 1
        FROM public.provider_auth_configs pac
       WHERE pac.id = v_config_id
         AND pac.credentials IS NULL
         AND pac.expires_at > now() + INTERVAL '170 days'
    ),
    'provider credential update reuses the existing Vault secret pointer and updates expiry'
  );

  RETURN NEXT is(
    public.get_provider_auth_credentials(v_config_id)->>'api_key',
    'pgtap-vault-updated',
    'updated provider credential resolves replacement payload through Vault helper'
  );

  RETURN NEXT ok(
    NOT COALESCE((
      SELECT to_jsonb(d)::text LIKE '%pgtap-vault-updated%'
        FROM public.v_integration_credential_directory d
       WHERE d.id = v_config_id
       LIMIT 1
    ), TRUE),
    'integration credential directory stays redacted after provider credential update'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_revoke_provider_auth_config_v1(jsonb_build_object(
    'config_id', v_config_id,
    'reason', 'pgtap provider auth vault update revoke proof'
  ));

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::boolean, FALSE)
    AND public.get_provider_auth_credentials(v_config_id) IS NULL,
    'revoked provider credential no longer resolves dispatch credentials'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.v_integration_credential_directory d
       WHERE d.id = v_config_id
         AND d.status = 'revoked'
         AND d.is_active = FALSE
         AND d.is_expired = FALSE
    ),
    'integration credential directory exposes revoked tombstone status distinctly from expired'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.ui_upsert_provider_auth_config_v1(jsonb_build_object(
           'config_id', %L,
           'credentials', jsonb_build_object('api_key', 'pgtap-reopened-revoked')
         )) $$,
      v_config_id::text
    ),
    '55000',
    NULL,
    'revoked provider credential cannot be updated through api upsert wrapper'
  );

  RETURN NEXT throws_ok(
    format(
      $$ SELECT api.integration_plugin_rotate_credentials_v1(jsonb_build_object(
           'config_id', %L,
           'credentials', jsonb_build_object('api_key', 'pgtap-rotated-revoked')
         )) $$,
      v_config_id::text
    ),
    '55000',
    NULL,
    'revoked provider credential cannot be rotated through config-id wrapper'
  );
END;
$function$;

SELECT * FROM pg_temp.test_provider_auth_vault_update_v1();

SELECT * FROM finish();
ROLLBACK;

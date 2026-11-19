-- pgTAP: Console V2 provider credential write actions deny lower-permission
-- users before mutating credential state or writing lifecycle/audit side effects.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(15);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000c751';
  v_ops UUID := '00000000-0000-0000-0000-00000000c752';
  v_limited UUID := '00000000-0000-0000-0000-00000000c753';
  v_provider UUID := '00000000-0000-0000-0000-00000000c754';
  v_config UUID := '00000000-0000-0000-0000-00000000c755';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Provider Credential Denied Org', 'console-v2-provider-credential-denied')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'provider-credential-denied-ops@example.com', 'Provider Credential Denied Ops', 'ops_admin', 'tenant', NULL),
    (v_limited, v_org, 'provider-credential-denied-limited@example.com', 'Provider Credential Denied Limited', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status, metadata)
  VALUES (
    v_provider,
    v_org,
    'Console V2 Provider Credential Denied Provider',
    'http',
    TRUE,
    910,
    'healthy',
    jsonb_build_object('purpose', 'provider-credential-denied-state')
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         enabled = EXCLUDED.enabled,
         health_status = EXCLUDED.health_status;

  INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials, credentials_vault_id, expires_at)
  VALUES (
    v_config,
    v_provider,
    'api_key',
    jsonb_build_object('api_key', 'provider-denied-original-secret'),
    NULL,
    '2026-07-15T10:15:00Z'::timestamptz
  )
  ON CONFLICT (id) DO UPDATE
     SET provider_id = EXCLUDED.provider_id,
         auth_type = EXCLUDED.auth_type,
         credentials = EXCLUDED.credentials,
         credentials_vault_id = NULL,
         expires_at = EXCLUDED.expires_at;

  PERFORM set_config('test.provider_credential_denied_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.provider_credential_denied_ops', v_ops::TEXT, TRUE);
  PERFORM set_config('test.provider_credential_denied_limited', v_limited::TEXT, TRUE);
  PERFORM set_config('test.provider_credential_denied_provider', v_provider::TEXT, TRUE);
  PERFORM set_config('test.provider_credential_denied_config', v_config::TEXT, TRUE);
  PERFORM set_config(
    'test.provider_credential_denied_count',
    (SELECT COUNT(*)::TEXT FROM public.provider_auth_configs WHERE provider_id = v_provider),
    TRUE
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  to_regprocedure('api.ui_upsert_provider_auth_config_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_upsert_provider_auth_config_v1(jsonb)', 'EXECUTE'),
  'api.ui_upsert_provider_auth_config_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.ui_revoke_provider_auth_config_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_revoke_provider_auth_config_v1(jsonb)', 'EXECUTE'),
  'api.ui_revoke_provider_auth_config_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.integration_plugin_rotate_credentials_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.integration_plugin_rotate_credentials_v1(jsonb)', 'EXECUTE'),
  'api.integration_plugin_rotate_credentials_v1 wrapper is available to authenticated users'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_credential_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_provider_auth_config_v1(jsonb_build_object(
       'provider_id', current_setting('test.provider_credential_denied_provider'),
       'auth_type', 'api_key',
       'credentials', jsonb_build_object('api_key', 'denied-public-create-secret')
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_upsert_provider_auth_config_v1 create'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_credential_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_upsert_provider_auth_config_v1(jsonb_build_object(
       'provider_id', current_setting('test.provider_credential_denied_provider'),
       'auth_type', 'api_key',
       'credentials', jsonb_build_object('api_key', 'denied-api-create-secret')
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_upsert_provider_auth_config_v1 create'
);
RESET ROLE;

SELECT is(
  (
    SELECT COUNT(*)::TEXT
      FROM public.provider_auth_configs
     WHERE provider_id = current_setting('test.provider_credential_denied_provider')::UUID
  ),
  current_setting('test.provider_credential_denied_count'),
  'denied provider credential create attempts write no provider_auth_configs rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_credential_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_provider_auth_config_v1(jsonb_build_object(
       'config_id', current_setting('test.provider_credential_denied_config'),
       'auth_type', 'api_key',
       'credentials', jsonb_build_object('api_key', 'denied-public-update-secret'),
       'expires_at', '2026-08-01T00:00:00Z'
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_upsert_provider_auth_config_v1 update'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_credential_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.integration_plugin_rotate_credentials_v1(jsonb_build_object(
       'config_id', current_setting('test.provider_credential_denied_config'),
       'auth_type', 'api_key',
       'credentials', jsonb_build_object('api_key', 'denied-api-rotate-secret'),
       'expires_at', '2026-08-02T00:00:00Z'
     )) $$,
  '42501',
  NULL,
  'limited user denied api integration_plugin_rotate_credentials_v1 config rotation'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.provider_auth_configs
     WHERE id = current_setting('test.provider_credential_denied_config')::UUID
       AND credentials = jsonb_build_object('api_key', 'provider-denied-original-secret')
       AND credentials_vault_id IS NULL
       AND expires_at = '2026-07-15T10:15:00Z'::timestamptz
  ),
  'denied update/rotate attempts leave provider credential material and expiry unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_credential_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_revoke_provider_auth_config_v1(jsonb_build_object(
       'config_id', current_setting('test.provider_credential_denied_config'),
       'reason', 'pgtap-denied-revoke-public'
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_revoke_provider_auth_config_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_credential_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_revoke_provider_auth_config_v1(jsonb_build_object(
       'config_id', current_setting('test.provider_credential_denied_config'),
       'reason', 'pgtap-denied-revoke-api'
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_revoke_provider_auth_config_v1'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.provider_auth_configs
     WHERE id = current_setting('test.provider_credential_denied_config')::UUID
       AND COALESCE((credentials->>'revoked')::BOOLEAN, FALSE) IS FALSE
       AND expires_at = '2026-07-15T10:15:00Z'::timestamptz
  ),
  'denied revoke attempts leave provider credential active and unrevoked'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_id = current_setting('test.provider_credential_denied_config')::UUID
       AND event_type = 'provider_auth_config.revoked'
  ),
  'denied revoke attempts write no provider_auth_config.revoked domain event'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE resource_id = current_setting('test.provider_credential_denied_config')::UUID
       AND decision_category = 'integrations.revoke_credential'
       AND performed_by_system = 'ui_revoke_provider_auth_config_v1'
  ),
  'denied revoke attempts write no provider credential lifecycle decision rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_credential_denied_ops'), TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.integration_plugin_rotate_credentials_v1(jsonb_build_object(
      'config_id', current_setting('test.provider_credential_denied_config'),
      'auth_type', 'api_key',
      'credentials', jsonb_build_object('api_key', 'provider-denied-ops-rotate-secret'),
      'expires_at', '2026-09-01T00:00:00Z',
      'reason', 'pgtap ops rotate path'
    ))->>'ok')::BOOLEAN
  ),
  'ops user can still reach provider credential rotate path'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;

BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(18);

SELECT has_function('public', 'get_provider_auth_credentials', ARRAY['uuid'], 'credential resolver exists');
SELECT is_definer('public', 'get_provider_auth_credentials', ARRAY['uuid'], 'credential resolver stays SECURITY DEFINER');
SELECT is(
  (SELECT proconfig FROM pg_proc WHERE oid = 'public.get_provider_auth_credentials(uuid)'::regprocedure),
  ARRAY['search_path=public, pg_temp'],
  'credential resolver keeps its pinned search_path'
);
SELECT ok(
  NOT has_function_privilege('public', 'public.get_provider_auth_credentials(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.get_provider_auth_credentials(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.get_provider_auth_credentials(uuid)', 'EXECUTE'),
  'PUBLIC, anon and authenticated cannot execute the resolver'
);
SELECT ok(has_function_privilege('service_role', 'public.get_provider_auth_credentials(uuid)', 'EXECUTE'),
  'service_role keeps EXECUTE on the resolver');

CREATE TEMP TABLE g1_ids (key TEXT PRIMARY KEY, id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO g1_ids(key) VALUES
  ('org'), ('provider'), ('vault_valid'), ('legacy_valid'), ('vault_expired'), ('legacy_expired'),
  ('expires_now'), ('revoked_bool'), ('revoked_text'), ('revoked_odd'), ('revoked_false'), ('secret_expired');

CREATE FUNCTION pg_temp.g1(p_key TEXT) RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT id FROM g1_ids WHERE key = p_key $$;

INSERT INTO public.organizations(id, name, slug, billing_status)
  VALUES (pg_temp.g1('org'), 'Provider auth expiry fixture', 'g1-expiry-' || pg_temp.g1('org'), 'active');
INSERT INTO public.providers(id, organization_id, name, provider_type, enabled)
  VALUES (pg_temp.g1('provider'), pg_temp.g1('org'), 'Provider auth expiry provider', 'http', TRUE);

UPDATE g1_ids SET id = vault.create_secret(jsonb_build_object('api_key', pg_temp.g1('vault_expired'))::TEXT, 'g1/' || gen_random_uuid(), 'Rollback-only G1 fixture', NULL)
  WHERE key = 'secret_expired';

INSERT INTO public.provider_auth_configs(id, provider_id, auth_type, credentials, credentials_vault_id, expires_at) VALUES
  (pg_temp.g1('vault_valid'), pg_temp.g1('provider'), 'api_key', NULL,
    vault.create_secret(jsonb_build_object('api_key', pg_temp.g1('vault_valid'))::TEXT, 'g1/' || gen_random_uuid(), 'Rollback-only G1 fixture', NULL),
    now() + interval '1 day'),
  (pg_temp.g1('legacy_valid'), pg_temp.g1('provider'), 'api_key', jsonb_build_object('api_key', pg_temp.g1('legacy_valid')), NULL, NULL),
  (pg_temp.g1('vault_expired'), pg_temp.g1('provider'), 'api_key', NULL, pg_temp.g1('secret_expired'), now() - interval '1 minute'),
  (pg_temp.g1('legacy_expired'), pg_temp.g1('provider'), 'api_key', jsonb_build_object('api_key', pg_temp.g1('legacy_expired')), NULL, now() - interval '1 day'),
  (pg_temp.g1('expires_now'), pg_temp.g1('provider'), 'api_key', jsonb_build_object('api_key', pg_temp.g1('expires_now')), NULL, now()),
  (pg_temp.g1('revoked_bool'), pg_temp.g1('provider'), 'api_key', jsonb_build_object('api_key', pg_temp.g1('revoked_bool'), 'revoked', true), NULL, NULL),
  (pg_temp.g1('revoked_text'), pg_temp.g1('provider'), 'api_key', jsonb_build_object('api_key', pg_temp.g1('revoked_text'), 'revoked', 'true'::TEXT), NULL, now() + interval '1 day'),
  (pg_temp.g1('revoked_odd'), pg_temp.g1('provider'), 'api_key', jsonb_build_object('api_key', pg_temp.g1('revoked_odd'), 'revoked', 'yes-please'::TEXT), NULL, NULL),
  (pg_temp.g1('revoked_false'), pg_temp.g1('provider'), 'api_key', jsonb_build_object('api_key', pg_temp.g1('revoked_false'), 'revoked', false), NULL, NULL);

SELECT is(public.get_provider_auth_credentials(pg_temp.g1('vault_valid')) ->> 'api_key', pg_temp.g1('vault_valid')::TEXT,
  'valid Vault-backed credentials with a future expiry are returned');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('legacy_valid')) ->> 'api_key', pg_temp.g1('legacy_valid')::TEXT,
  'valid legacy credentials without an expiry are returned');
SELECT is(public.get_provider_auth_credential(pg_temp.g1('vault_valid'), 'api_key'), pg_temp.g1('vault_valid')::TEXT,
  'single-key resolver returns valid credentials');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('vault_expired')), NULL::jsonb,
  'expired Vault-backed credentials resolve to nothing');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('legacy_expired')), NULL::jsonb,
  'expired legacy credentials resolve to nothing');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('expires_now')), NULL::jsonb,
  'credentials expiring at the current transaction time resolve to nothing');
SELECT is(public.get_provider_auth_credential(pg_temp.g1('vault_expired'), 'api_key'), NULL,
  'single-key resolver inherits the expiry fail-closed rule');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('revoked_bool')), NULL::jsonb,
  'revoked=true credentials resolve to nothing');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('revoked_text')), NULL::jsonb,
  'revoked="true" credentials resolve to nothing even with a future expiry');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('revoked_odd')), NULL::jsonb,
  'an unrecognised revoked marker fails closed without raising');
SELECT is(public.get_provider_auth_credentials(pg_temp.g1('revoked_false')) ->> 'api_key', pg_temp.g1('revoked_false')::TEXT,
  'an explicit revoked=false marker does not block valid credentials');
SELECT is(public.get_provider_auth_credentials(gen_random_uuid()), NULL::jsonb,
  'unknown configuration resolves to nothing');
SELECT is(
  (SELECT decrypted_secret::jsonb ->> 'api_key' FROM vault.decrypted_secrets WHERE id = pg_temp.g1('secret_expired')),
  pg_temp.g1('vault_expired')::TEXT,
  'expiry does not touch the Vault payload, so refresh flows that read Vault directly keep working'
);

SELECT * FROM finish();
ROLLBACK;

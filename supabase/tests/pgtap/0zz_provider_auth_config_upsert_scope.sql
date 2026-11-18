-- pgTAP: ui_upsert_provider_auth_config_v1 rejects cross-tenant config/provider mismatch.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

DO $$
DECLARE
  v_org_a UUID := '00000000-0000-0000-0000-00000000b701';
  v_org_b UUID := '00000000-0000-0000-0000-00000000b702';
  v_ops_a UUID := '00000000-0000-0000-0000-00000000b703';
  v_provider_a UUID := '00000000-0000-0000-0000-00000000b704';
  v_provider_b UUID := '00000000-0000-0000-0000-00000000b705';
  v_config_b UUID := '00000000-0000-0000-0000-00000000b706';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_a, 'Provider Upsert Scope A', 'provider-upsert-scope-a'),
    (v_org_b, 'Provider Upsert Scope B', 'provider-upsert-scope-b')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_a,
    v_org_a,
    'provider-upsert-scope-a@example.com',
    'Provider Upsert Scope A Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (id, organization_id, name, provider_type)
  VALUES
    (v_provider_a, v_org_a, 'Provider Upsert Scope A', 'http'),
    (v_provider_b, v_org_b, 'Provider Upsert Scope B', 'http')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials)
  VALUES (v_config_b, v_provider_b, 'api_key', jsonb_build_object('key', 'tenant-b-secret'))
  ON CONFLICT (id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        auth_type = EXCLUDED.auth_type,
        credentials = EXCLUDED.credentials;

  PERFORM set_config('test.provider_upsert_scope_ops_a', v_ops_a::text, true);
  PERFORM set_config('test.provider_upsert_scope_provider_a', v_provider_a::text, true);
  PERFORM set_config('test.provider_upsert_scope_config_b', v_config_b::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.provider_upsert_scope_ops_a'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_upsert_provider_auth_config_v1(jsonb_build_object(
       'config_id', current_setting('test.provider_upsert_scope_config_b'),
       'provider_id', current_setting('test.provider_upsert_scope_provider_a'),
       'auth_type', 'api_key',
       'credentials', jsonb_build_object('key', 'attempted-cross-tenant-update')
     )) $$,
  '42501',
  NULL,
  'upsert rejects cross-tenant config_id with in-scope provider_id'
);

RESET ROLE;

SELECT is(
  (
    SELECT credentials->>'key'
      FROM public.provider_auth_configs
     WHERE id = current_setting('test.provider_upsert_scope_config_b')::uuid
  ),
  'tenant-b-secret',
  'cross-tenant provider_auth_configs row remains unchanged'
);

SELECT * FROM finish();
ROLLBACK;

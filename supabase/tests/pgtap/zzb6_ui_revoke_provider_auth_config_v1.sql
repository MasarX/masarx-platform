-- pgTAP: public.ui_revoke_provider_auth_config_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b625';
  v_ops UUID := '00000000-0000-0000-0000-00000000b871';
  v_sender UUID := '00000000-0000-0000-0000-00000000b872';
  v_provider UUID := gen_random_uuid();
  v_config UUID := gen_random_uuid();
  v_config2 UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 PA Revoke Org', 'b6-pa-rev-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-pa-rev-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 PA Rev Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-pa-rev-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 PA Rev Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (id, organization_id, name, provider_type)
  VALUES (v_provider, v_org, 'B6 PA Rev Provider', 'http')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials)
  VALUES
    (v_config, v_provider, 'api_key', jsonb_build_object('key', 'live_secret_001')),
    (v_config2, v_provider, 'api_key', jsonb_build_object('key', 'live_secret_002'))
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_pa_rev_org', v_org::text, true);
  PERFORM set_config('test.b6_pa_rev_ops', v_ops::text, true);
  PERFORM set_config('test.b6_pa_rev_sender', v_sender::text, true);
  PERFORM set_config('test.b6_pa_rev_config', v_config::text, true);
  PERFORM set_config('test.b6_pa_rev_config2', v_config2::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_pa_rev_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.ui_revoke_provider_auth_config_v1(jsonb_build_object(
      'config_id', current_setting('test.b6_pa_rev_config'),
      'reason', 'pgtap-revoke'
    ))->>'ok')::bool
  ),
  'ops_admin can ui_revoke_provider_auth_config_v1'
);
RESET ROLE;

-- 2) Denied (sender_user lacks integration_plugins.write)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_pa_rev_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_revoke_provider_auth_config_v1(jsonb_build_object(
       'config_id', current_setting('test.b6_pa_rev_config2')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied ui_revoke_provider_auth_config_v1'
);
RESET ROLE;

-- 3) Audit / decision_log row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'integrations.revoke_credential'
       AND resource_id = current_setting('test.b6_pa_rev_config')::uuid
  ),
  'ui_revoke_provider_auth_config_v1 wrote decision_log row'
);

-- 4) RLS isolation on the underlying table
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_auth_configs'::regclass),
  'provider_auth_configs has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;

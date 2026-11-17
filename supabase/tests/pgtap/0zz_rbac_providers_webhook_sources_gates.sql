-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: RBAC gates for providers + webhook_sources (authenticated read/write)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

SELECT has_table('public', 'providers', 'providers table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='providers'), 'RLS enabled on providers');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='providers'), 'providers has policies');

SELECT has_table('public', 'webhook_sources', 'webhook_sources table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='webhook_sources'), 'RLS enabled on webhook_sources');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='webhook_sources'), 'webhook_sources has policies');

SELECT ok(has_table_privilege('authenticated', 'public.providers', 'SELECT'), 'authenticated can SELECT providers (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.providers', 'INSERT'), 'authenticated can INSERT providers (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.providers', 'UPDATE'), 'authenticated can UPDATE providers (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.providers', 'DELETE'), 'authenticated can DELETE providers (privilege exists)');

SELECT ok(has_table_privilege('authenticated', 'public.webhook_sources', 'SELECT'), 'authenticated can SELECT webhook_sources (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.webhook_sources', 'INSERT'), 'authenticated can INSERT webhook_sources (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.webhook_sources', 'UPDATE'), 'authenticated can UPDATE webhook_sources (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.webhook_sources', 'DELETE'), 'authenticated can DELETE webhook_sources (privilege exists)');

DO $$
DECLARE
  v_org UUID := '0cd00000-0000-0000-0000-000000000001'::uuid;
  v_user UUID := '0cd00000-0000-0000-0000-000000000101'::uuid;
  v_mapping UUID := '0cd00000-0000-0000-0000-000000000201'::uuid;
  v_provider1 UUID := '0cd00000-0000-0000-0000-000000000301'::uuid;
  v_provider2 UUID := '0cd00000-0000-0000-0000-000000000302'::uuid;
  v_source1 UUID := '0cd00000-0000-0000-0000-000000000401'::uuid;
  v_source2 UUID := '0cd00000-0000-0000-0000-000000000402'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Providers Org', 'providers-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'providers-' || left(v_user::text, 8) || '@example.com', 'Providers User', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'webhook_inbound::' || left(v_mapping::text, 8),
    '{}'::jsonb,
    1,
    'pgtap'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank)
  VALUES (v_provider1, v_org, 'provider-1', 'webhook', TRUE, 100)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled)
  VALUES (v_source1, v_org, 'source-1-' || left(v_source1::text, 8), 'Source 1', 'async_3pl', 'token-1-' || left(v_source1::text, 8), v_mapping, TRUE)
  ON CONFLICT (id) DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.providers WHERE organization_id = v_org) = 0,
    'RBAC: without agreements.read cannot read providers'
  );

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.webhook_sources WHERE organization_id = v_org) = 0,
    'RBAC: without agreements.read cannot read webhook_sources'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank)
      VALUES (%L::uuid, %L::uuid, 'provider-2', 'webhook', TRUE, 100)
    $sql$, v_provider2::text, v_org::text),
    '42501',
    'new row violates row-level security policy for table "providers"'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled)
      VALUES (%L::uuid, %L::uuid, %L, 'Source 2', 'async_3pl', %L, %L::uuid, TRUE)
    $sql$, v_source2::text, v_org::text, 'source-2-' || left(v_source2::text, 8), 'token-2-' || left(v_source2::text, 8), v_mapping::text),
    '42501',
    'new row violates row-level security policy for table "webhook_sources"'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['agreements_admin'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'agreements_admin'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.providers WHERE id = v_provider1) = 1,
    'RBAC: agreements_admin can read providers'
  );

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.webhook_sources WHERE id = v_source1) = 1,
    'RBAC: agreements_admin can read webhook_sources'
  );

  INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank)
  VALUES (v_provider2, v_org, 'provider-2', 'webhook', TRUE, 100);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.providers WHERE id = v_provider2) = 1,
    'RBAC: agreements_admin can write providers'
  );

  INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled)
  VALUES (v_source2, v_org, 'source-2-' || left(v_source2::text, 8), 'Source 2', 'async_3pl', 'token-2-' || left(v_source2::text, 8), v_mapping, TRUE);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.webhook_sources WHERE id = v_source2) = 1,
    'RBAC: agreements_admin can write webhook_sources'
  );
END $$;

SELECT finish();
ROLLBACK;


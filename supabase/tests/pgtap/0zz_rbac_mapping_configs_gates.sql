-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: RBAC gates for mapping_configs (authenticated reads/writes)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT has_table('public', 'mapping_configs', 'mapping_configs table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='mapping_configs'), 'RLS enabled on mapping_configs');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='mapping_configs'), 'mapping_configs has policies');

SELECT ok(has_table_privilege('authenticated', 'public.mapping_configs', 'SELECT'), 'authenticated can SELECT mapping_configs (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.mapping_configs', 'INSERT'), 'authenticated can INSERT mapping_configs (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.mapping_configs', 'UPDATE'), 'authenticated can UPDATE mapping_configs (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.mapping_configs', 'DELETE'), 'authenticated can DELETE mapping_configs (privilege exists)');

DO $$
DECLARE
  v_org UUID := '0ac00000-0000-0000-0000-000000000001'::uuid;
  v_user UUID := '0ac00000-0000-0000-0000-000000000101'::uuid;
  v_mc UUID := '0ac00000-0000-0000-0000-000000000201'::uuid;
  v_global UUID := '0ac00000-0000-0000-0000-000000000999'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Mapping Configs Org', 'mapping-configs-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'mapping-configs-' || left(v_user::text, 8) || '@example.com', 'Mapping Configs User', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  -- Create a global mapping config (organization_id NULL) to ensure tenant users cannot read it.
  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_global, 'provider_response', 'pgtap::global_mapping_config', '{}'::jsonb, 1, 'pgtap global mapping config')
  ON CONFLICT (id) DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
      VALUES (%L::uuid, %L::uuid, 'webhook_inbound', 'pgtap::mapping_configs::' || left(%L, 8), '{}'::jsonb, 1, 'pgtap mapping config')
    $sql$, v_mc::text, v_org::text, v_mc::text),
    '42501',
    'new row violates row-level security policy for table "mapping_configs"'
  );

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.mapping_configs WHERE id = v_global) = 0,
    'Tenant users cannot read global/shared mapping_configs rows'
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

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mc, v_org, 'webhook_inbound', 'pgtap::mapping_configs::' || left(v_mc::text, 8), '{}'::jsonb, 1, 'pgtap mapping config');
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.mapping_configs WHERE id = v_mc) = 1,
    'RBAC: agreements_admin can write mapping_configs'
  );

  UPDATE public.mapping_configs
     SET notes = 'pgtap mapping config updated'
   WHERE id = v_mc;
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.mapping_configs WHERE id = v_mc AND notes = 'pgtap mapping config updated') = 1,
    'RBAC: agreements_admin can update mapping_configs'
  );

  DELETE FROM public.mapping_configs WHERE id = v_mc;
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.mapping_configs WHERE id = v_mc) = 0,
    'RBAC: agreements_admin can delete mapping_configs'
  );
END $$;

SELECT finish();
ROLLBACK;

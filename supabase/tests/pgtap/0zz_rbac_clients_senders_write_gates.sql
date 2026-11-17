-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: RBAC gates for clients + senders (authenticated writes)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT plan(16);

SELECT has_table('public', 'clients', 'clients table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='clients'), 'RLS enabled on clients');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='clients'), 'clients has policies');

SELECT has_table('public', 'senders', 'senders table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='senders'), 'RLS enabled on senders');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='senders'), 'senders has policies');

SELECT ok(has_table_privilege('authenticated', 'public.clients', 'INSERT'), 'authenticated can INSERT clients (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.clients', 'UPDATE'), 'authenticated can UPDATE clients (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.clients', 'DELETE'), 'authenticated can DELETE clients (privilege exists)');

SELECT ok(has_table_privilege('authenticated', 'public.senders', 'INSERT'), 'authenticated can INSERT senders (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.senders', 'UPDATE'), 'authenticated can UPDATE senders (privilege exists)');
SELECT ok(has_table_privilege('authenticated', 'public.senders', 'DELETE'), 'authenticated can DELETE senders (privilege exists)');

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Clients Org', 'clients-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'clients-' || left(v_user::text, 8) || '@example.com', 'Clients User', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
      VALUES (%L::uuid, %L::uuid, 'Client A', %L, 'standard', 'active')
    $sql$, v_client::text, v_org::text, 'client-a-' || left(v_client::text, 8)),
    '42501',
    'new row violates row-level security policy for table "clients"'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.senders (id, client_id, name, status)
      VALUES (%L::uuid, %L::uuid, 'Sender A', 'active')
    $sql$, v_sender::text, v_client::text),
    '42501',
    'new row violates row-level security policy for table "senders"'
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

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'Client A', 'client-a-' || left(v_client::text, 8), 'standard', 'active');
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.clients WHERE id = v_client) = 1,
    'RBAC: agreements_admin can write clients'
  );

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Sender A', 'active');
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.senders WHERE id = v_sender) = 1,
    'RBAC: agreements_admin can write senders'
  );
END $$;

SELECT finish();
ROLLBACK;

-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: RBAC foundation v1 (roles + role_permissions + user_role_assignments)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

CREATE OR REPLACE FUNCTION test_rbac_foundation_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0b100000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0b200000-0000-0000-0000-000000000002'::uuid;

  v_client1 UUID := '0b100000-0000-0000-0000-000000000101'::uuid;
  v_sender1 UUID := '0b100000-0000-0000-0000-000000000102'::uuid;

  v_tenant_user1 UUID := '0b100000-0000-0000-0000-000000000201'::uuid;
  v_tenant_user2 UUID := '0b200000-0000-0000-0000-000000000202'::uuid;
  v_client_user1 UUID := '0b100000-0000-0000-0000-000000000203'::uuid;
  v_sender_user1 UUID := '0b100000-0000-0000-0000-000000000204'::uuid;

  v_role1 UUID := '0b100000-0000-0000-0000-000000000301'::uuid;
  v_role2 UUID := '0b200000-0000-0000-0000-000000000302'::uuid;

  v_perm_finance_read UUID;
  v_perm_finance_write UUID;

  v_mapping_id UUID := '0b100000-0000-0000-0000-000000000401'::uuid;
BEGIN
  RETURN NEXT has_table('public', 'rbac_roles', 'rbac_roles table exists');
  RETURN NEXT has_table('public', 'rbac_role_permissions', 'rbac_role_permissions table exists');
  RETURN NEXT has_table('public', 'rbac_user_role_assignments', 'rbac_user_role_assignments table exists');

  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rbac_roles'), 'RLS enabled on rbac_roles');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rbac_role_permissions'), 'RLS enabled on rbac_role_permissions');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rbac_user_role_assignments'), 'RLS enabled on rbac_user_role_assignments');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'rbac_roles'),
    'rbac_roles registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'rbac_role_permissions'),
    'rbac_role_permissions registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'rbac_user_role_assignments'),
    'rbac_user_role_assignments registered in table_contracts'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions ld
      WHERE ld.category = 'rbac_permission'
    ),
    'lookup_definitions has rbac_permission'
  );

  SELECT lv.id INTO v_perm_finance_read
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'rbac_permission'
    AND lv.value = 'finance.read'
  LIMIT 1;

  SELECT lv.id INTO v_perm_finance_write
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'rbac_permission'
    AND lv.value = 'finance.write'
  LIMIT 1;

  RETURN NEXT ok(v_perm_finance_read IS NOT NULL, 'rbac_permission includes finance.read');
  RETURN NEXT ok(v_perm_finance_write IS NOT NULL, 'rbac_permission includes finance.write');

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'RBAC Org 1', 'rbac-org-' || left(v_org1::text, 8)),
    (v_org2, 'RBAC Org 2', 'rbac-org-' || left(v_org2::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client1, v_org1, 'RBAC Client', 'rbac-client-' || left(v_client1::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender1, v_client1, 'RBAC Sender', 'RBAC Sender', TRUE, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES
    (v_tenant_user1, v_org1, 'rbac-u1-' || left(v_tenant_user1::text, 8) || '@example.com', 'RBAC Tenant 1', 'tenant', NULL),
    (v_tenant_user2, v_org2, 'rbac-u2-' || left(v_tenant_user2::text, 8) || '@example.com', 'RBAC Tenant 2', 'tenant', NULL),
    (v_client_user1, v_org1, 'rbac-cu-' || left(v_client_user1::text, 8) || '@example.com', 'RBAC Client User', 'client', v_client1),
    (v_sender_user1, v_org1, 'rbac-su-' || left(v_sender_user1::text, 8) || '@example.com', 'RBAC Sender User', 'sender', v_sender1);

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES
    (v_role1, v_org1, 'accounting', 'Accounting', TRUE),
    (v_role2, v_org2, 'accounting', 'Accounting', TRUE);

  INSERT INTO public.rbac_role_permissions (id, organization_id, role_id, permission_id)
  VALUES (v_mapping_id, v_org1, v_role1, v_perm_finance_read);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  VALUES (v_org1, v_tenant_user1, v_role1);

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
          VALUES (%L, %L, %L) $q$,
      v_org1,
      v_tenant_user2,
      v_role1
    ),
    '23514',
    format('rbac_user_role_assignments: organization mismatch (assignment org %s, user org %s)', v_org1, v_org2)
  );

  -- tenant user (org1) can read RBAC rows for own org only
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_tenant_user1::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
      FROM public.rbac_roles
      WHERE id IN (v_role1, v_role2)
    ),
    1,
    'tenant user sees own fixture org roles only'
  );
  RETURN NEXT ok(public.user_has_permission_v1('finance.read', v_org1), 'user_has_permission_v1: finance.read allowed for assigned role');
  RETURN NEXT ok(NOT public.user_has_permission_v1('finance.write', v_org1), 'user_has_permission_v1: finance.write denied when not assigned');
  RETURN NEXT ok(NOT public.user_has_permission_v1('finance.read', v_org2), 'user_has_permission_v1: cannot read other org permissions');

  -- client/sender users cannot read RBAC tables (tenant-only select policy)
  PERFORM set_config('request.jwt.claim.sub', v_client_user1::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_client_user1::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
      FROM public.rbac_roles
      WHERE id IN (v_role1, v_role2)
    ),
    0,
    'client user cannot read fixture rbac_roles'
  );

  PERFORM set_config('request.jwt.claim.sub', v_sender_user1::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_sender_user1::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
      FROM public.rbac_roles
      WHERE id IN (v_role1, v_role2)
    ),
    0,
    'sender user cannot read fixture rbac_roles'
  );

  -- service_role bypass (no auth.uid required)
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_permission_v1('finance.read', v_org2), 'service_role bypass: user_has_permission_v1 returns true');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN;
END;
$function$;

SELECT * FROM test_rbac_foundation_v1();

SELECT * FROM finish();

ROLLBACK;

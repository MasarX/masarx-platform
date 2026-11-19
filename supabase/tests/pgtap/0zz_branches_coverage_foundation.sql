-- Plan: PLAN-202601-branches-coverage-foundation / Step: S95
-- pgTAP: Branches + coverage foundation (RLS + invariants)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);

SELECT has_table('public', 'branches', 'branches table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='branches'), 'RLS enabled on branches');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='branches'), 'branches has policies');

SELECT has_table('public', 'branch_zones', 'branch_zones table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='branch_zones'), 'RLS enabled on branch_zones');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='branch_zones'), 'branch_zones has policies');

SELECT has_function('public', 'resolve_branch_id_for_zone', ARRAY['uuid'], 'resolve_branch_id_for_zone(uuid) exists');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'branches'
  ),
  'branches registered in table_contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'branch_zones'
  ),
  'branch_zones registered in table_contracts'
);

CREATE TEMP TABLE tmp_branches_coverage_ids AS
SELECT
  '0bb00000-0000-0000-0000-000000000001'::uuid AS org1_id,
  '0bc00000-0000-0000-0000-000000000002'::uuid AS org2_id,
  '0bb00000-0000-0000-0000-000000000401'::uuid AS client1_id,
  '0bc00000-0000-0000-0000-000000000402'::uuid AS client2_id,
  '0bb00000-0000-0000-0000-000000000501'::uuid AS sender1_id,
  '0bc00000-0000-0000-0000-000000000502'::uuid AS sender2_id,
  '0bb00000-0000-0000-0000-000000000101'::uuid AS zone1_id,
  '0bb00000-0000-0000-0000-000000000103'::uuid AS zone3_id,
  '0bc00000-0000-0000-0000-000000000102'::uuid AS zone2_id,
  '0bb00000-0000-0000-0000-000000000201'::uuid AS branch_id;

SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO public.organizations (id, name, slug)
SELECT org1_id, 'Branches Org 1', 'branches-org-' || left(org1_id::text, 8)
FROM tmp_branches_coverage_ids
UNION ALL
SELECT org2_id, 'Branches Org 2', 'branches-org-' || left(org2_id::text, 8)
FROM tmp_branches_coverage_ids;

INSERT INTO public.clients (id, organization_id, name, slug, status)
SELECT client1_id, org1_id, 'Branches Client 1', 'branches-client-' || left(client1_id::text, 8), 'active'
FROM tmp_branches_coverage_ids
UNION ALL
SELECT client2_id, org2_id, 'Branches Client 2', 'branches-client-' || left(client2_id::text, 8), 'active'
FROM tmp_branches_coverage_ids;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
SELECT sender1_id, client1_id, 'Branches Sender 1', 'Branches Sender 1', TRUE, 'active'
FROM tmp_branches_coverage_ids
UNION ALL
SELECT sender2_id, client2_id, 'Branches Sender 2', 'Branches Sender 2', TRUE, 'active'
FROM tmp_branches_coverage_ids;

SELECT set_config('app.organization_onboarding_source', '', true);
SELECT public.bootstrap_tenant_onboarding_v1(org1_id, 'pgtap:branches-coverage-fixture-bootstrap-org1')
FROM tmp_branches_coverage_ids;
SELECT public.bootstrap_tenant_onboarding_v1(org2_id, 'pgtap:branches-coverage-fixture-bootstrap-org2')
FROM tmp_branches_coverage_ids;

INSERT INTO public.zones (id, organization_id, name, slug, is_active)
SELECT zone1_id, org1_id, 'Zone 1', 'zone-1-' || left(zone1_id::text, 8), TRUE
FROM tmp_branches_coverage_ids
UNION ALL
SELECT zone3_id, org1_id, 'Zone 3', 'zone-3-' || left(zone3_id::text, 8), TRUE
FROM tmp_branches_coverage_ids
UNION ALL
SELECT zone2_id, org2_id, 'Zone 2', 'zone-2-' || left(zone2_id::text, 8), TRUE
FROM tmp_branches_coverage_ids;

INSERT INTO public.branches (id, organization_id, code, name, is_active)
SELECT branch_id, org1_id, 'branch-1', 'Branch 1', TRUE
FROM tmp_branches_coverage_ids;

SELECT lives_ok(
  $$
  INSERT INTO public.branch_zones (branch_id, zone_id)
  SELECT branch_id, zone1_id
  FROM tmp_branches_coverage_ids
  $$,
  'branch_zones insert allowed when org matches'
);

SELECT throws_ok(
  $$
  INSERT INTO public.branch_zones (branch_id, zone_id)
  SELECT branch_id, zone2_id
  FROM tmp_branches_coverage_ids
  $$,
  '23514',
  (
    SELECT
      'branch_zones: organization mismatch (branch org ' ||
      org1_id::text ||
      ', zone org ' ||
      org2_id::text ||
      ')'
    FROM tmp_branches_coverage_ids
  )
);

DO $$
DECLARE
  v_org UUID := (SELECT org1_id FROM tmp_branches_coverage_ids);
  v_branch UUID := (SELECT branch_id FROM tmp_branches_coverage_ids);
  v_zone3 UUID := (SELECT zone3_id FROM tmp_branches_coverage_ids);
  v_user UUID := '0bb00000-0000-0000-0000-000000000301'::uuid;
  v_branch2 UUID := '0bb00000-0000-0000-0000-000000000202'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'branches-' || left(v_user::text, 8) || '@example.com', 'Branches User', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branch_zones (branch_id, zone_id)
      VALUES (%L::uuid, %L::uuid)
    $sql$, v_branch::text, v_zone3::text),
    '42501',
    'new row violates row-level security policy for table "branch_zones"'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.branches (id, organization_id, code, name, is_active)
      VALUES (%L::uuid, %L::uuid, 'branch-2', 'Branch 2', TRUE)
    $sql$, v_branch2::text, v_org::text),
    '42501',
    'new row violates row-level security policy for table "branches"'
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

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch2, v_org, 'branch-2', 'Branch 2', TRUE);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.branches WHERE id = v_branch2) = 1,
    'RBAC: agreements_admin can write branches'
  );

  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES (v_branch, v_zone3);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.branch_zones WHERE branch_id = v_branch AND zone_id = v_zone3) = 1,
    'RBAC: agreements_admin can write branch_zones'
  );
END $$;

SELECT finish();
ROLLBACK;

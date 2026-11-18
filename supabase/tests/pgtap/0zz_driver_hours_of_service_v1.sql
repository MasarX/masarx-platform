-- Plan: PHASE B / B2 — pgTAP for driver_hours_of_service canonical table
-- Asserts: table exists, RLS enabled, table_contracts registered, lookup seeded,
--          tenant-only reads, fleet.write-gated writes, cross-tenant isolation.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

CREATE OR REPLACE FUNCTION test_driver_hours_of_service_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fa00000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0fa00000-0000-0000-0000-000000000002'::uuid;
  v_branch1 UUID := '0fa00000-0000-0000-0000-000000000101'::uuid;
  v_branch2 UUID := '0fa00000-0000-0000-0000-000000000102'::uuid;

  v_tenant_user1 UUID := '0fa00000-0000-0000-0000-000000000401'::uuid;
  v_tenant_user2 UUID := '0fa00000-0000-0000-0000-000000000402'::uuid;
  v_driver_user1 UUID := '0fa00000-0000-0000-0000-000000000501'::uuid;
  v_driver_user2 UUID := '0fa00000-0000-0000-0000-000000000502'::uuid;

  v_dp1 UUID := '0fa00000-0000-0000-0000-000000000601'::uuid;
  v_dp2 UUID := '0fa00000-0000-0000-0000-000000000602'::uuid;

  v_seg1 UUID := '0fa00000-0000-0000-0000-000000000701'::uuid;
  v_seg2 UUID := '0fa00000-0000-0000-0000-000000000702'::uuid;
BEGIN
  RETURN NEXT has_table('public', 'driver_hours_of_service', 'driver_hours_of_service table exists');
  RETURN NEXT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'driver_hours_of_service'),
    'RLS enabled on driver_hours_of_service'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'driver_hours_of_service'),
    'driver_hours_of_service registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'hours_of_service_duty_status'
         AND lv.value IN ('driving','on_duty','off_duty','sleeper')
       GROUP BY ld.id
       HAVING COUNT(*) = 4
    ),
    'hours_of_service_duty_status lookup seeded with all four canonical values'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_driver_hos_org_driver_start'),
    'driver_hours_of_service has idx_driver_hos_org_driver_start'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_driver_hos_open_segments'),
    'driver_hours_of_service has idx_driver_hos_open_segments (partial index for open segments)'
  );

  -- Seed orgs/users/driver_profiles
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'HOS Org 1', 'hos-org-' || right(replace(v_org1::text, '-', ''), 12)),
    (v_org2, 'HOS Org 2', 'hos-org-' || right(replace(v_org2::text, '-', ''), 12));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_branch1, v_org1, 'hos-b1', 'HOS Branch 1', 'UTC', TRUE),
    (v_branch2, v_org2, 'hos-b2', 'HOS Branch 2', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES
    (v_tenant_user1, v_org1, 'hos-tu1-' || left(v_tenant_user1::text, 8) || '@example.com', 'HOS Tenant 1', 'tenant', NULL),
    (v_tenant_user2, v_org2, 'hos-tu2-' || left(v_tenant_user2::text, 8) || '@example.com', 'HOS Tenant 2', 'tenant', NULL),
    (v_driver_user1, v_org1, 'hos-du1-' || left(v_driver_user1::text, 8) || '@example.com', 'HOS Driver 1', 'tenant', NULL),
    (v_driver_user2, v_org2, 'hos-du2-' || left(v_driver_user2::text, 8) || '@example.com', 'HOS Driver 2', 'tenant', NULL);

  INSERT INTO public.driver_profiles (id, organization_id, user_id, status)
  VALUES
    (v_dp1, v_org1, v_driver_user1, 'active'),
    (v_dp2, v_org2, v_driver_user2, 'active');

  -- Cross-org write should be blocked by enforce-org-match trigger
  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.driver_hours_of_service (organization_id, driver_id, segment_start, duty_status)
          VALUES (%L, %L, now(), 'driving') $q$,
      v_org1,
      v_dp2
    ),
    '23514',
    format('driver_hours_of_service: organization mismatch (segment org %s, driver org %s)', v_org1, v_org2)
  );

  -- Authenticated writes are blocked without fleet.write
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.driver_hours_of_service (organization_id, driver_id, segment_start, duty_status)
          VALUES (%L, %L, now(), 'driving') $q$,
      v_org1,
      v_dp1
    ),
    '42501',
    'new row violates row-level security policy for table "driver_hours_of_service"'
  );

  -- Provision fleet_manager and confirm authenticated write succeeds
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_tenant_user1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_tenant_user1, r.id, v_tenant_user1,
         jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  INSERT INTO public.driver_hours_of_service (id, organization_id, driver_id, segment_start, duty_status, recorded_by_user_id)
  VALUES (v_seg1, v_org1, v_dp1, now() - interval '2 hours', 'driving', v_tenant_user1);
  RETURN NEXT ok(
    (SELECT COUNT(*)::INT FROM public.driver_hours_of_service WHERE id = v_seg1) = 1,
    'fleet_manager (fleet.write) can insert driver_hours_of_service'
  );

  -- And another segment for the second org
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.driver_hours_of_service (id, organization_id, driver_id, segment_start, duty_status)
  VALUES (v_seg2, v_org2, v_dp2, now() - interval '1 hour', 'on_duty');
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org2, ARRAY['fleet_manager'], v_tenant_user2);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org2, v_tenant_user2, r.id, v_tenant_user2,
         jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org2 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  -- Tenant user (org1) sees only own org segments
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user1::text, true);
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.driver_hours_of_service),
    1,
    'tenant user (org1) sees own org HOS segments only'
  );

  -- Tenant user2 in org2 sees its own org row
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user2::text, true);
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.driver_hours_of_service),
    1,
    'tenant user (org2) sees own org HOS segments only'
  );

  -- Driver self-read: driver_user1 (org1) sees their own segment without fleet.read role
  PERFORM set_config('request.jwt.claim.sub', v_driver_user1::text, true);
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.driver_hours_of_service WHERE driver_id = v_dp1),
    1,
    'driver self-read: driver user can see own HOS segments via auth.uid match'
  );

  -- Cross-org read isolation: driver_user2 (org2) cannot see org1 segments
  PERFORM set_config('request.jwt.claim.sub', v_driver_user2::text, true);
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.driver_hours_of_service WHERE driver_id = v_dp1),
    0,
    'cross-org isolation: driver_user2 cannot see other tenant HOS rows'
  );

  -- Update auto-touches updated_at via trigger
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.driver_hours_of_service
     SET created_at = created_at - interval '1 minute'
   WHERE id = v_seg1;
  UPDATE public.driver_hours_of_service
     SET segment_end = now(), duty_status = 'off_duty'
   WHERE id = v_seg1;
  RETURN NEXT ok(
    (SELECT updated_at > created_at FROM public.driver_hours_of_service WHERE id = v_seg1),
    'updated_at trigger updates timestamp on UPDATE'
  );

  -- Constraint: segment_end >= segment_start
  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.driver_hours_of_service (organization_id, driver_id, segment_start, segment_end, duty_status)
          VALUES (%L, %L, now(), now() - interval '1 hour', 'driving') $q$,
      v_org1,
      v_dp1
    ),
    '23514',
    NULL,
    'driver_hours_of_service segment_range_ck rejects end < start'
  );

  -- Constraint: duty_status must be lowercase + non-empty
  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.driver_hours_of_service (organization_id, driver_id, segment_start, duty_status)
          VALUES (%L, %L, now(), '') $q$,
      v_org1,
      v_dp1
    ),
    '23514',
    NULL,
    'driver_hours_of_service duty_status_ck rejects empty value'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.driver_hours_of_service (organization_id, driver_id, segment_start, duty_status)
          VALUES (%L, %L, now(), 'DRIVING') $q$,
      v_org1,
      v_dp1
    ),
    '23514',
    NULL,
    'driver_hours_of_service duty_status_ck rejects upper-case value'
  );

  RETURN;
END;
$function$;

SELECT * FROM test_driver_hours_of_service_v1();

SELECT * FROM finish();

ROLLBACK;

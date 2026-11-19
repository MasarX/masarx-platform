-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- pgTAP: Enterprise ops v1 (warehouse locations + driver compliance + vehicle events)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(25);

-- 1) Existence + RLS posture
SELECT has_table('public', 'warehouse_locations', 'warehouse_locations table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='warehouse_locations'), 'RLS enabled on warehouse_locations');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='warehouse_locations'), 'warehouse_locations has policies');

SELECT has_table('public', 'driver_profiles', 'driver_profiles table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='driver_profiles'), 'RLS enabled on driver_profiles');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='driver_profiles'), 'driver_profiles has policies');

SELECT has_table('public', 'driver_documents', 'driver_documents table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='driver_documents'), 'RLS enabled on driver_documents');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='driver_documents'), 'driver_documents has policies');

SELECT has_table('public', 'driver_compliance_events', 'driver_compliance_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='driver_compliance_events'), 'RLS enabled on driver_compliance_events');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='driver_compliance_events'), 'driver_compliance_events has policies');

SELECT has_table('public', 'vehicle_events', 'vehicle_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='vehicle_events'), 'RLS enabled on vehicle_events');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='vehicle_events'), 'vehicle_events has policies');

SELECT has_function('public', 'refresh_api_contract_views_v1', ARRAY[]::text[], 'refresh_api_contract_views_v1() exists');

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.refresh_api_contract_views_v1()', 'execute'),
  'authenticated cannot execute refresh_api_contract_views_v1()'
);

SELECT ok(
  has_function_privilege('service_role', 'public.refresh_api_contract_views_v1()', 'execute'),
  'service_role can execute refresh_api_contract_views_v1()'
);

-- 2) RLS/RBAC behavior checks
SELECT set_config('test.enterprise_ops.org_id', '0e100000-0000-0000-0000-000000000001', TRUE);
SELECT set_config('test.enterprise_ops.branch_id', '0e100000-0000-0000-0000-000000000101', TRUE);
SELECT set_config('test.enterprise_ops.admin_user_id', '0e100000-0000-0000-0000-000000000201', TRUE);
SELECT set_config('test.enterprise_ops.driver_user_id', '0e100000-0000-0000-0000-000000000202', TRUE);
SELECT set_config('test.enterprise_ops.vehicle_id', '0e100000-0000-0000-0000-000000000301', TRUE);
SELECT set_config('test.enterprise_ops.loc_id', '0e100000-0000-0000-0000-000000000401', TRUE);
SELECT set_config('test.enterprise_ops.doc_id', '0e100000-0000-0000-0000-000000000501', TRUE);
SELECT set_config('test.enterprise_ops.event_id', '0e100000-0000-0000-0000-000000000601', TRUE);

-- Seed org + branch + users + vehicle as postgres (bypass RLS for setup).
DO $$
DECLARE
  v_org UUID := current_setting('test.enterprise_ops.org_id')::uuid;
  v_branch UUID := current_setting('test.enterprise_ops.branch_id')::uuid;
  v_admin UUID := current_setting('test.enterprise_ops.admin_user_id')::uuid;
  v_driver UUID := current_setting('test.enterprise_ops.driver_user_id')::uuid;
  v_vehicle UUID := current_setting('test.enterprise_ops.vehicle_id')::uuid;
  v_doc UUID := current_setting('test.enterprise_ops.doc_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Enterprise Ops Org', 'ent-ops-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  -- Organization onboarding may already create the canonical main branch.
  -- Reuse it when present so this enterprise ops test follows the same
  -- tenant-readiness default path as production.
  SELECT b.id
    INTO v_branch
    FROM public.branches b
   WHERE b.organization_id = v_org
     AND b.code = 'main'
   LIMIT 1;

  IF v_branch IS NULL THEN
    v_branch := current_setting('test.enterprise_ops.branch_id')::uuid;
    INSERT INTO public.branches (id, organization_id, code, name, is_active)
    VALUES (v_branch, v_org, 'main', 'Main Branch', TRUE)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  PERFORM set_config('test.enterprise_ops.branch_id', v_branch::text, TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_admin, v_org, 'admin-' || left(v_admin::text, 8) || '@example.com', 'Admin User', 'tenant'),
    (v_driver, v_org, 'driver-' || left(v_driver::text, 8) || '@example.com', 'Driver User', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicles (id, organization_id, branch_id, status, is_active)
  VALUES (v_vehicle, v_org, v_branch, 'active', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Seed driver profile + document for driver (setup only).
  INSERT INTO public.driver_profiles (organization_id, user_id, driver_code, status)
  VALUES (v_org, v_driver, 'drv-' || left(v_driver::text, 6), 'active')
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  INSERT INTO public.driver_documents (id, organization_id, user_id, doc_type, status)
  VALUES (v_doc, v_org, v_driver, 'driver_license', 'submitted')
  ON CONFLICT (id) DO NOTHING;

  -- Provision RBAC roles from templates (service-only function; postgres in tests).
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['agreements_admin', 'fleet_manager'], v_admin);
END $$;

-- As admin (no roles assigned yet), warehouse_locations insert should fail (requires agreements.write).
DO $$
DECLARE
  v_admin UUID := current_setting('test.enterprise_ops.admin_user_id')::uuid;
  v_org UUID := current_setting('test.enterprise_ops.org_id')::uuid;
  v_branch UUID := current_setting('test.enterprise_ops.branch_id')::uuid;
  v_loc UUID := current_setting('test.enterprise_ops.loc_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.warehouse_locations (id, organization_id, branch_id, code, name, location_type)
      VALUES (%L::uuid, %L::uuid, %L::uuid, 'stg-1', 'Stage 1', 'stage')
    $sql$, v_loc::text, v_org::text, v_branch::text),
    '42501',
    'new row violates row-level security policy for table "warehouse_locations"'
  );
END $$;

-- Assign agreements_admin to admin; warehouse_locations insert should succeed.
DO $$
DECLARE
  v_admin UUID := current_setting('test.enterprise_ops.admin_user_id')::uuid;
  v_org UUID := current_setting('test.enterprise_ops.org_id')::uuid;
  v_branch UUID := current_setting('test.enterprise_ops.branch_id')::uuid;
  v_loc UUID := current_setting('test.enterprise_ops.loc_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_admin, r.id, v_admin, jsonb_build_object('seed', TRUE, 'source', 'pgtap')
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org AND r.key = 'agreements_admin'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  INSERT INTO public.warehouse_locations (id, organization_id, branch_id, code, name, location_type)
  VALUES (v_loc, v_org, v_branch, 'stg-1', 'Stage 1', 'stage');

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.warehouse_locations WHERE id = v_loc) = 1,
    'warehouse_locations insert allowed with agreements.write'
  );
END $$;

-- As admin without fleet.read, driver_documents for other users should be filtered out by RLS.
DO $$
DECLARE
  v_admin UUID := current_setting('test.enterprise_ops.admin_user_id')::uuid;
  v_org UUID := current_setting('test.enterprise_ops.org_id')::uuid;
  v_driver UUID := current_setting('test.enterprise_ops.driver_user_id')::uuid;
  v_doc UUID := current_setting('test.enterprise_ops.doc_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.driver_documents WHERE id = v_doc AND organization_id = v_org AND user_id = v_driver) = 0,
    'driver_documents hidden from tenant users without fleet.read'
  );
END $$;

-- As driver, self documents should be visible even without fleet.read.
DO $$
DECLARE
  v_driver UUID := current_setting('test.enterprise_ops.driver_user_id')::uuid;
  v_doc UUID := current_setting('test.enterprise_ops.doc_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.driver_documents WHERE id = v_doc) = 1,
    'driver_documents visible to the owning driver (self access)'
  );
END $$;

-- Assign fleet_manager to admin; driver_documents for other users should be visible.
DO $$
DECLARE
  v_admin UUID := current_setting('test.enterprise_ops.admin_user_id')::uuid;
  v_org UUID := current_setting('test.enterprise_ops.org_id')::uuid;
  v_driver UUID := current_setting('test.enterprise_ops.driver_user_id')::uuid;
  v_doc UUID := current_setting('test.enterprise_ops.doc_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_admin, r.id, v_admin, jsonb_build_object('seed', TRUE, 'source', 'pgtap')
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.driver_documents WHERE id = v_doc AND organization_id = v_org AND user_id = v_driver) = 1,
    'driver_documents visible with fleet.read'
  );
END $$;

-- As tenant user without fleet.write, vehicle_events insert should fail.
DO $$
DECLARE
  v_driver UUID := current_setting('test.enterprise_ops.driver_user_id')::uuid;
  v_org UUID := current_setting('test.enterprise_ops.org_id')::uuid;
  v_vehicle UUID := current_setting('test.enterprise_ops.vehicle_id')::uuid;
  v_event UUID := current_setting('test.enterprise_ops.event_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.vehicle_events (id, organization_id, vehicle_id, event_type, occurred_at, odometer_km)
      VALUES (%L::uuid, %L::uuid, %L::uuid, 'odometer', now(), 123)
    $sql$, v_event::text, v_org::text, v_vehicle::text),
    '42501',
    'new row violates row-level security policy for table "vehicle_events"'
  );
END $$;

-- As admin with fleet.write, vehicle_events insert should succeed.
DO $$
DECLARE
  v_admin UUID := current_setting('test.enterprise_ops.admin_user_id')::uuid;
  v_org UUID := current_setting('test.enterprise_ops.org_id')::uuid;
  v_vehicle UUID := current_setting('test.enterprise_ops.vehicle_id')::uuid;
  v_event UUID := current_setting('test.enterprise_ops.event_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  INSERT INTO public.vehicle_events (id, organization_id, vehicle_id, event_type, occurred_at, odometer_km)
  VALUES (v_event, v_org, v_vehicle, 'odometer', now(), 123);

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.vehicle_events WHERE id = v_event) = 1,
    'vehicle_events insert allowed with fleet.write'
  );
END $$;

SELECT finish();
ROLLBACK;

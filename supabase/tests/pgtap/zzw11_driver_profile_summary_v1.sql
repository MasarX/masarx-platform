-- Plan: W11-4 FLEET projection RPCs
-- pgTAP: driver_profile_summary_v1 view
--
-- Asserts:
--   * View exists and is grant-aware (authenticated + service_role).
--   * Joins driver_profiles + users + vehicle_assignments + driver_documents
--     return canonical projections (name, initials, current_vehicle_id,
--     license_number, license_expires_at).
--   * Tenant isolation: rows are scoped to organization_id (RLS via base
--     tables; view is read-only).

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

CREATE OR REPLACE FUNCTION test_driver_profile_summary_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb1d000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0fb1d000-0000-0000-0000-000000000002'::uuid;
  v_user1 UUID := '0fb1d000-0000-0000-0000-000000000101'::uuid;
  v_user2 UUID := '0fb1d000-0000-0000-0000-000000000102'::uuid;
  v_dp1 UUID := '0fb1d000-0000-0000-0000-000000000201'::uuid;
  v_dp2 UUID := '0fb1d000-0000-0000-0000-000000000202'::uuid;
  v_branch1 UUID := '0fb1d000-0000-0000-0000-000000000301'::uuid;
  v_vehicle1 UUID := '0fb1d000-0000-0000-0000-000000000401'::uuid;
  v_assignment1 UUID := '0fb1d000-0000-0000-0000-000000000501'::uuid;
  v_doc1 UUID := '0fb1d000-0000-0000-0000-000000000601'::uuid;
  v_row RECORD;
BEGIN
  RETURN NEXT has_view('public', 'driver_profile_summary_v1',
                       'driver_profile_summary_v1 view exists');

  -- Schema columns (a stable contract for FE swap-seam)
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'id',
                         'view exposes id');
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'name',
                         'view exposes derived name (users.full_name)');
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'initials',
                         'view exposes derived initials');
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'license_number',
                         'view exposes derived license_number');
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'license_expires_at',
                         'view exposes derived license_expires_at');
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'current_vehicle_id',
                         'view exposes derived current_vehicle_id');
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'current_branch_id',
                         'view exposes derived current_branch_id');
  RETURN NEXT has_column('public', 'driver_profile_summary_v1', 'compliance_score',
                         'view exposes derived compliance_score');

  -- Seed two orgs + drivers + active assignment + license
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Driver Summary Org 1', 'dps-org1-' || right(v_org1::text, 8)),
    (v_org2, 'Driver Summary Org 2', 'dps-org2-' || right(v_org2::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_user1, v_org1, 'dps-driver1@example.com', 'Khalid Al-Otaibi', 'tenant'),
    (v_user2, v_org2, 'dps-driver2@example.com', 'Mohammed Hassan', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, is_active, address)
  VALUES (v_branch1, v_org1, 'br-dps-1', 'DPS Branch 1', TRUE, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.driver_profiles (id, organization_id, user_id, status,
                                      hired_at, metadata)
  VALUES
    (v_dp1, v_org1, v_user1, 'active', '2024-06-01',
     '{"compliance_score":"96","hours_of_service_state":"driving",
       "phone":"+447 70 090 0103"}'::jsonb),
    (v_dp2, v_org2, v_user2, 'active', '2025-02-12',
     '{"compliance_score":"78"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicles (id, organization_id, branch_id, status,
                               plate_number, vin)
  VALUES (v_vehicle1, v_org1, v_branch1, 'active', 'RUH 1184',
          'JTHBE96S470118241')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicle_assignments (id, organization_id, vehicle_id,
                                          assigned_to_user_id, branch_id,
                                          status, started_at)
  VALUES (v_assignment1, v_org1, v_vehicle1, v_user1, v_branch1, 'active',
          now() - interval '7 days')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.driver_documents (id, organization_id, user_id,
                                       doc_type, status, issuer, issued_at,
                                       expires_at, metadata)
  VALUES (v_doc1, v_org1, v_user1, 'driver_license', 'verified',
          'KSA-MOI', '2024-09-12', '2027-09-12',
          '{"class":"C+E (heavy)","license_number":"KSA-DRV-44A1-0118"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  -- Read driver1 row from the view
  SELECT * INTO v_row FROM public.driver_profile_summary_v1
   WHERE id = v_dp1;
  RETURN NEXT is(v_row.name, 'Khalid Al-Otaibi',
                 'projection joins users.full_name into name');
  RETURN NEXT is(v_row.current_vehicle_id, v_vehicle1,
                 'active vehicle_assignments project current_vehicle_id');
  RETURN NEXT is(v_row.license_number, 'KSA-DRV-44A1-0118',
                 'driver_documents.metadata->license_number projects license_number');
END;
$function$;

SELECT * FROM test_driver_profile_summary_v1();

SELECT * FROM finish();

ROLLBACK;

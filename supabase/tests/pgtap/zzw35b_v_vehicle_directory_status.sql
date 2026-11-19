-- pgTAP: public.v_vehicle_directory.is_oos canonicalization (W35b)
-- Spec-Issue: W35b - REAUDIT3 FLEET P1-1 closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-0000003fb001';
  v_branch   UUID := '00000000-0000-0000-0000-0000003fb002';
  v_vtype    UUID := '00000000-0000-0000-0000-0000003fb003';
  v_veh_oos  UUID := '00000000-0000-0000-0000-0000003fb004';
  v_veh_act  UUID := '00000000-0000-0000-0000-0000003fb005';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W35b OOS Org', 'w35b-oos-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'w35b-ruh', 'W35b Riyadh Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicle_types (id, organization_id, key, name)
  VALUES (v_vtype, v_org, 'box-van', 'W35b Box Van')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicles (
    id, organization_id, branch_id, vehicle_type_id, status,
    plate_number, vin, is_active
  )
  VALUES (
    v_veh_oos, v_org, v_branch, v_vtype, 'oos',
    'W35B-OOS-1', 'W35BVIN0000000001', TRUE
  )
  ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status;

  INSERT INTO public.vehicles (
    id, organization_id, branch_id, vehicle_type_id, status,
    plate_number, vin, is_active
  )
  VALUES (
    v_veh_act, v_org, v_branch, v_vtype, 'active',
    'W35B-ACT-1', 'W35BVIN0000000002', TRUE
  )
  ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_vehicle_directory
    WHERE id = '00000000-0000-0000-0000-0000003fb004'::UUID
      AND status = 'oos'
  ),
  'v_vehicle_directory projects canonical status=oos through unchanged'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_vehicle_directory
    WHERE id = '00000000-0000-0000-0000-0000003fb004'::UUID
      AND is_oos IS TRUE
  ),
  'v_vehicle_directory.is_oos = TRUE when vehicles.status = ''oos'''
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_vehicle_directory
    WHERE id = '00000000-0000-0000-0000-0000003fb005'::UUID
      AND status = 'active'
  ),
  'v_vehicle_directory projects canonical status=active through unchanged'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_vehicle_directory
    WHERE id = '00000000-0000-0000-0000-0000003fb005'::UUID
      AND is_oos IS FALSE
  ),
  'v_vehicle_directory.is_oos = FALSE when vehicles.status = ''active'''
);

SELECT * FROM finish();
ROLLBACK;

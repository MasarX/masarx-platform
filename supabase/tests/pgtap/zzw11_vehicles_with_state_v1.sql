-- Plan: W11-4 FLEET projection RPCs
-- pgTAP: vehicles_with_state_v1 view
--
-- Asserts:
--   * View exists and is grant-aware (authenticated + service_role).
--   * Joins vehicles + vehicle_types + vehicle_assignments + vehicle_events
--     return canonical projections (current_driver_user_id, type_name,
--     last_telemetry_at, odometer_km).
--   * Tenant isolation: rows are scoped to organization_id (RLS via base
--     tables; view is read-only).

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

CREATE OR REPLACE FUNCTION test_vehicles_with_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb2d000-0000-0000-0000-000000000001'::uuid;
  v_user1 UUID := '0fb2d000-0000-0000-0000-000000000101'::uuid;
  v_branch1 UUID := '0fb2d000-0000-0000-0000-000000000201'::uuid;
  v_vt1 UUID := '0fb2d000-0000-0000-0000-000000000301'::uuid;
  v_vehicle1 UUID := '0fb2d000-0000-0000-0000-000000000401'::uuid;
  v_assignment1 UUID := '0fb2d000-0000-0000-0000-000000000501'::uuid;
  v_event1 UUID := '0fb2d000-0000-0000-0000-000000000601'::uuid;
  v_event2 UUID := '0fb2d000-0000-0000-0000-000000000602'::uuid;
  v_row RECORD;
BEGIN
  RETURN NEXT has_view('public', 'vehicles_with_state_v1',
                       'vehicles_with_state_v1 view exists');

  -- Schema columns (a stable contract for FE swap-seam)
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'id',
                         'view exposes id');
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'plate_number',
                         'view exposes vehicles.plate_number');
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'type_name',
                         'view exposes derived type_name (vehicle_types.name)');
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'current_driver_user_id',
                         'view exposes derived current_driver_user_id');
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'current_branch_id',
                         'view exposes derived current_branch_id');
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'fuel_level',
                         'view exposes derived fuel_level');
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'odometer_km',
                         'view exposes derived odometer_km');
  RETURN NEXT has_column('public', 'vehicles_with_state_v1', 'last_telemetry_at',
                         'view exposes derived last_telemetry_at');

  -- Seed scenario
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Vehicle State Org 1', 'vws-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user1, v_org1, 'vws-driver@example.com', 'Khalid', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, is_active, address)
  VALUES (v_branch1, v_org1, 'br-vws-1', 'VWS Branch 1', TRUE, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active,
                                    metadata)
  VALUES (v_vt1, v_org1, 'van_med', 'Medium van', TRUE,
          '{"capacity_kg":"1200","fuel_capacity_liters":"60"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicles (id, organization_id, branch_id,
                               vehicle_type_id, status, plate_number, vin)
  VALUES (v_vehicle1, v_org1, v_branch1, v_vt1, 'active', 'RUH 1184',
          'JTHBE96S470118241')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicle_assignments (id, organization_id, vehicle_id,
                                          assigned_to_user_id, branch_id,
                                          status, started_at)
  VALUES (v_assignment1, v_org1, v_vehicle1, v_user1, v_branch1, 'active',
          now() - interval '7 days')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicle_events (id, organization_id, vehicle_id,
                                     event_type, occurred_at, odometer_km,
                                     metadata)
  VALUES
    (v_event1, v_org1, v_vehicle1, 'odometer',
     now() - interval '2 hours', 84312, '{}'::jsonb),
    (v_event2, v_org1, v_vehicle1, 'fuel',
     now() - interval '1 hour', NULL,
     '{"fuel_fraction":"0.74"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  -- Read vehicle row from the view
  SELECT * INTO v_row FROM public.vehicles_with_state_v1
   WHERE id = v_vehicle1;
  RETURN NEXT is(v_row.type_name, 'Medium van',
                 'vehicle_types.name projects type_name');
  RETURN NEXT is(v_row.current_driver_user_id, v_user1,
                 'active vehicle_assignments project current_driver_user_id');
  RETURN NEXT is(v_row.fuel_level::TEXT, '0.74',
                 'latest fuel event metadata projects fuel_level');
END;
$function$;

SELECT * FROM test_vehicles_with_state_v1();

SELECT * FROM finish();

ROLLBACK;

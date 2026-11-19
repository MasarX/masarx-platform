-- pgTAP: public.v_vehicle_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W29 (paired projection views — FLEET)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_vehicle_directory',
  'public.v_vehicle_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_vehicle_directory',
  ARRAY[
    'id', 'organization_id', 'branch_id', 'vehicle_type_id', 'status',
    'plate_number', 'plate', 'code', 'vin', 'make', 'model', 'model_year', 'color',
    'is_active', 'metadata', 'created_at', 'updated_at',
    'vehicle_type_label', 'type_name', 'vehicle_type_key',
    'current_driver_user_id', 'current_driver_label', 'current_branch_id',
    'active_assignment_branch_id', 'active_assignment_started_at', 'assignment_age_seconds',
    'branch_label', 'is_oos', 'is_in_maintenance',
    'plate_number_upper', 'acquired_at', 'retired_at', 'last_event_at', 'event_count_24h',
    'maintenance_window_count', 'active_maintenance_count', 'maintenance_due',
    'last_telemetry_at', 'odometer_km', 'fuel_level', 'last_fuel_event_at'
  ],
  'v_vehicle_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_vehicle_directory', 'SELECT'),
  'service_role has SELECT on v_vehicle_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_vehicle_directory', 'SELECT'),
  'anon has no SELECT on v_vehicle_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_vehicle_directory', 'SELECT'),
  'authenticated has SELECT on v_vehicle_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'vehicles'
       AND c.relkind = 'r'
  ),
  'public.vehicles remains a base table (SSOT preserved)'
);

-- 7) Projection: insert vehicle + active assignment + recent event +
--    upcoming maintenance window and verify branch_label / vehicle_type_label /
--    current_driver_label / event_count_24h / maintenance_due / is_oos /
--    is_in_maintenance.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000029a001';
  v_branch    UUID := '00000000-0000-0000-0000-00000029a002';
  v_user      UUID := '00000000-0000-0000-0000-00000029a003';
  v_vtype     UUID := '00000000-0000-0000-0000-00000029a004';
  v_vehicle   UUID := '00000000-0000-0000-0000-00000029a005';
  v_assign    UUID := '00000000-0000-0000-0000-00000029a006';
  v_event     UUID := '00000000-0000-0000-0000-00000029a007';
  v_maint     UUID := '00000000-0000-0000-0000-00000029a008';
  v_branch_label TEXT;
  v_vtype_label  TEXT;
  v_drv_label    TEXT;
  v_event_24h    INT;
  v_maint_count  INT;
  v_maint_due    BOOLEAN;
  v_is_oos       BOOLEAN;
  v_is_in_maint  BOOLEAN;
  v_assign_age   BIGINT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W29 Vehicle Org', 'w29-veh-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'w29-ruh', 'W29 Riyadh Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w29-veh-u-' || left(v_user::text, 8) || '@example.com',
    'W29 Vehicle Driver', 'driver', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicle_types (id, organization_id, key, name)
  VALUES (v_vtype, v_org, 'box-van', 'W29 Box Van')
  ON CONFLICT (id) DO NOTHING;

  -- Vehicle status='in_maintenance' to verify is_in_maintenance derivation.
  INSERT INTO public.vehicles (
    id, organization_id, branch_id, vehicle_type_id, status,
    plate_number, vin, is_active
  )
  VALUES (
    v_vehicle, v_org, v_branch, v_vtype, 'in_maintenance',
    'W29-1234', 'W29VIN0000000123', TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  -- Active assignment (started 3 hours ago).
  INSERT INTO public.vehicle_assignments (
    id, organization_id, vehicle_id, assigned_to_user_id, branch_id,
    status, started_at, ended_at
  )
  VALUES (
    v_assign, v_org, v_vehicle, v_user, v_branch,
    'active', now() - INTERVAL '3 hours', NULL
  )
  ON CONFLICT (id) DO NOTHING;

  -- Recent event (5 minutes ago) → counts in event_count_24h.
  INSERT INTO public.vehicle_events (
    id, organization_id, vehicle_id, event_type, occurred_at,
    odometer_km, actor_user_id
  )
  VALUES (
    v_event, v_org, v_vehicle, 'odometer', now() - INTERVAL '5 minutes',
    12345, v_user
  )
  ON CONFLICT (id) DO NOTHING;

  -- Maintenance window starting in 3 days → maintenance_due=TRUE.
  INSERT INTO public.vehicle_maintenance_windows (
    id, organization_id, vehicle_id, window_start_at, window_end_at,
    reason, status
  )
  VALUES (
    v_maint, v_org, v_vehicle,
    now() + INTERVAL '3 days', now() + INTERVAL '3 days 4 hours',
    'oil_change', 'scheduled'
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT
    branch_label, vehicle_type_label, current_driver_label,
    event_count_24h, maintenance_window_count, maintenance_due,
    is_oos, is_in_maintenance, assignment_age_seconds
    INTO
    v_branch_label, v_vtype_label, v_drv_label,
    v_event_24h, v_maint_count, v_maint_due,
    v_is_oos, v_is_in_maint, v_assign_age
    FROM public.v_vehicle_directory
   WHERE id = v_vehicle;

  PERFORM set_config('test.w29_vehicle_projection_ok', (
    v_branch_label = 'w29-ruh ' || chr(183) || ' W29 Riyadh Branch'
      AND v_vtype_label = 'W29 Box Van'
      AND v_drv_label = 'W29 Vehicle Driver'
      AND v_event_24h = 1
      AND v_maint_count = 1
      AND v_maint_due = TRUE
      AND v_is_oos = FALSE
      AND v_is_in_maint = TRUE
      AND v_assign_age IS NOT NULL
      AND v_assign_age > 60 * 60 * 2  -- > 2 hours
      AND v_assign_age < 60 * 60 * 4
    )::text, true
  );
END;
$$;

SELECT ok(
  current_setting('test.w29_vehicle_projection_ok')::boolean,
  'v_vehicle_directory derives branch_label + vehicle_type_label + current_driver_label + event_count_24h + maintenance_due + is_in_maintenance + assignment_age_seconds'
);

SELECT * FROM finish();
ROLLBACK;

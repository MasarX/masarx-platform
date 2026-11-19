-- pgTAP: public.v_vehicle_maintenance_directory projection contract
-- Spec-Issue: W29 (paired projection views — FLEET)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

-- 1) View exists
SELECT has_view(
  'public', 'v_vehicle_maintenance_directory',
  'public.v_vehicle_maintenance_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_vehicle_maintenance_directory',
  ARRAY[
    'id', 'organization_id', 'vehicle_id',
    'window_start_at', 'window_end_at',
    'reason', 'notes', 'status',
    'scheduled_by_user_id', 'completed_at', 'cancelled_at',
    'metadata', 'created_at', 'updated_at',
    'vehicle_label', 'vehicle_plate', 'vehicle_type_label',
    'scheduled_by_label', 'scheduled_by_email',
    'is_scheduled', 'is_completed', 'is_cancelled',
    'is_terminal', 'is_in_progress', 'is_overdue',
    'age_seconds', 'duration_seconds', 'starts_in_seconds',
    'completed_age_seconds', 'cancelled_age_seconds'
  ],
  'v_vehicle_maintenance_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_vehicle_maintenance_directory', 'SELECT'),
  'service_role has SELECT on v_vehicle_maintenance_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_vehicle_maintenance_directory', 'SELECT'),
  'anon has no SELECT on v_vehicle_maintenance_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_vehicle_maintenance_directory', 'SELECT'),
  'authenticated has SELECT on v_vehicle_maintenance_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'vehicle_maintenance_windows'
       AND c.relkind = 'r'
  ),
  'public.vehicle_maintenance_windows remains a base table (SSOT preserved)'
);

-- 7) Projection: insert vehicle + 3 windows (in-progress, overdue, completed)
--    and verify the lifecycle booleans + age/duration aggregates.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000029d001';
  v_user      UUID := '00000000-0000-0000-0000-00000029d002';
  v_vtype     UUID := '00000000-0000-0000-0000-00000029d003';
  v_vehicle   UUID := '00000000-0000-0000-0000-00000029d004';
  v_w_active  UUID := '00000000-0000-0000-0000-00000029d005';
  v_w_overdue UUID := '00000000-0000-0000-0000-00000029d006';
  v_w_done    UUID := '00000000-0000-0000-0000-00000029d007';
  v_label     TEXT;
  v_sched_by  TEXT;
  v_in_prog   BOOLEAN;
  v_overdue   BOOLEAN;
  v_done      BOOLEAN;
  v_terminal  BOOLEAN;
  v_dur_sec   BIGINT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W29 Maint Org', 'w29-mnt-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w29-mnt-u-' || left(v_user::text, 8) || '@example.com',
    'W29 Maint Operator', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicle_types (id, organization_id, key, name)
  VALUES (v_vtype, v_org, 'sedan', 'W29 Sedan')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.vehicles (
    id, organization_id, vehicle_type_id, status,
    plate_number, vin, is_active
  )
  VALUES (
    v_vehicle, v_org, v_vtype, 'active',
    'W29-7777', 'W29VIN0000007777', TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  -- Window 1: in-progress (started 1 hour ago, ends in 2 hours).
  INSERT INTO public.vehicle_maintenance_windows (
    id, organization_id, vehicle_id, window_start_at, window_end_at,
    reason, status, scheduled_by_user_id
  )
  VALUES (
    v_w_active, v_org, v_vehicle,
    now() - INTERVAL '1 hour', now() + INTERVAL '2 hours',
    'oil_change', 'scheduled', v_user
  )
  ON CONFLICT (id) DO NOTHING;

  -- Window 2: overdue (window_end_at in the past, still status='scheduled').
  INSERT INTO public.vehicle_maintenance_windows (
    id, organization_id, vehicle_id, window_start_at, window_end_at,
    reason, status, scheduled_by_user_id
  )
  VALUES (
    v_w_overdue, v_org, v_vehicle,
    now() - INTERVAL '3 days', now() - INTERVAL '2 days 23 hours',
    'tire_rotation', 'scheduled', v_user
  )
  ON CONFLICT (id) DO NOTHING;

  -- Window 3: completed 6 hours ago.
  INSERT INTO public.vehicle_maintenance_windows (
    id, organization_id, vehicle_id, window_start_at, window_end_at,
    reason, status, scheduled_by_user_id, completed_at
  )
  VALUES (
    v_w_done, v_org, v_vehicle,
    now() - INTERVAL '8 hours', now() - INTERVAL '7 hours',
    'inspection', 'completed', v_user, now() - INTERVAL '6 hours'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Verify in-progress window.
  SELECT
    vehicle_label, scheduled_by_label,
    is_in_progress, is_overdue, is_completed, is_terminal,
    duration_seconds
    INTO
    v_label, v_sched_by,
    v_in_prog, v_overdue, v_done, v_terminal, v_dur_sec
    FROM public.v_vehicle_maintenance_directory
   WHERE id = v_w_active;

  PERFORM ok(
    v_label = 'W29-7777'
      AND v_sched_by = 'W29 Maint Operator'
      AND v_in_prog = TRUE
      AND v_overdue = FALSE
      AND v_done = FALSE
      AND v_terminal = FALSE
      AND v_dur_sec IS NOT NULL
      AND v_dur_sec > 0
      AND v_dur_sec < 60 * 60 * 4,  -- < 4 hours
    'v_vehicle_maintenance_directory derives vehicle_label + scheduled_by_label + is_in_progress + duration_seconds; overdue and completed windows assert separately below'
  );

  -- Verify overdue window separately.
  SELECT is_overdue, is_in_progress, is_terminal
    INTO v_overdue, v_in_prog, v_terminal
    FROM public.v_vehicle_maintenance_directory
   WHERE id = v_w_overdue;

  PERFORM ok(
    v_overdue = TRUE AND v_in_prog = FALSE AND v_terminal = FALSE,
    'v_vehicle_maintenance_directory: overdue window flips is_overdue=TRUE while remaining is_terminal=FALSE'
  );

  -- Verify completed window separately.
  SELECT is_completed, is_terminal, is_overdue
    INTO v_done, v_terminal, v_overdue
    FROM public.v_vehicle_maintenance_directory
   WHERE id = v_w_done;

  PERFORM ok(
    v_done = TRUE AND v_terminal = TRUE AND v_overdue = FALSE,
    'v_vehicle_maintenance_directory: completed window has is_completed=TRUE + is_terminal=TRUE; is_overdue stays FALSE for terminal status'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;

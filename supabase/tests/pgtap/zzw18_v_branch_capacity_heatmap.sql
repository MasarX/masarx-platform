-- pgTAP: public.v_branch_capacity_heatmap projection contract (shape/RLS/projection)
-- Spec-Issue: W18-3 (paired projection views — NETWORK)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_branch_capacity_heatmap',
  'public.v_branch_capacity_heatmap view exists'
);

-- 2) View exposes the canonical FE-projection columns (heatmap cell shape)
SELECT columns_are(
  'public', 'v_branch_capacity_heatmap',
  ARRAY[
    'id', 'source_window_id', 'branch_id', 'zone_id',
    'weekday', 'hour', 'capacity_units', 'booked_units',
    'priority', 'updated_at'
  ],
  'v_branch_capacity_heatmap exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_branch_capacity_heatmap', 'SELECT'),
  'service_role has SELECT on v_branch_capacity_heatmap'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_branch_capacity_heatmap', 'SELECT'),
  'anon has no SELECT on v_branch_capacity_heatmap'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_branch_capacity_heatmap', 'SELECT'),
  'authenticated has SELECT on v_branch_capacity_heatmap'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'branch_capacity_windows'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.branch_capacity_windows remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a window with capacity.max_stops, verify projection.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-0000001cb301';
  v_branch UUID := '00000000-0000-0000-0000-0000001cb302';
  v_win    UUID := '00000000-0000-0000-0000-0000001cb303';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W18-3 Branch Heatmap Org', 'w183-bch-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type, timezone,
    operating_hours, address, is_active
  )
  VALUES (
    v_branch, v_org,
    'w183-test-' || left(v_branch::text, 8),
    'W18-3 Test Branch',
    'hub', 'Asia/Riyadh',
    jsonb_build_object('cutoff_time_local', '07:30'),
    jsonb_build_object('city', 'Riyadh'),
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  -- Insert a 3-hour capacity window (08:00..11:00) with capacity.max_stops=120
  INSERT INTO public.branch_capacity_windows (
    id, branch_id, day_of_week, window_start_local, window_end_local,
    effective_from, effective_to, capacity, is_active
  )
  VALUES (
    v_win, v_branch, 1,
    '08:00'::time, '11:00'::time,
    now() - interval '1 day', now() + interval '7 days',
    jsonb_build_object('max_stops', 120),
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w183_window', v_win::text, true);
  EXECUTE 'RESET ROLE';
END $$;

-- The 3-hour window should fan into 3 cells: hours 8, 9, 10 (end exclusive).
SELECT is(
  (SELECT COUNT(*)::INT FROM public.v_branch_capacity_heatmap
    WHERE source_window_id = current_setting('test.w183_window')::uuid),
  3,
  'v_branch_capacity_heatmap fans [08:00, 11:00) into 3 hourly cells'
);

-- 8) capacity_units projects from capacity.max_stops jsonb path
SELECT is(
  (SELECT capacity_units::TEXT FROM public.v_branch_capacity_heatmap
    WHERE source_window_id = current_setting('test.w183_window')::uuid
      AND hour = 8),
  '120',
  'v_branch_capacity_heatmap.capacity_units projects from capacity.max_stops'
);

SELECT * FROM finish();
ROLLBACK;

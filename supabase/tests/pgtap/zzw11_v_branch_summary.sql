-- pgTAP: public.v_branch_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W11-2 (paired projection views — NETWORK)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_branch_summary',
  'public.v_branch_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_branch_summary',
  ARRAY[
    'branch_id', 'organization_id', 'code', 'name', 'branch_type',
    'is_active', 'timezone', 'capacity_per_day', 'active_vehicles',
    'active_routes', 'manager_user_id', 'cutoff_time', 'updated_at',
    'booked_today', 'lat', 'lng'
  ],
  'v_branch_summary exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_branch_summary', 'SELECT'),
  'service_role has SELECT on v_branch_summary'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_branch_summary', 'SELECT'),
  'anon has no SELECT on v_branch_summary'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_branch_summary', 'SELECT'),
  'authenticated has SELECT on v_branch_summary'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'branches'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.branches remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a branch with operating_hours, verify cutoff_time is projected.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000011b201';
  v_branch UUID := '00000000-0000-0000-0000-00000011b202';
  v_client UUID := '00000000-0000-0000-0000-00000011b203';
  v_shipment UUID := '00000000-0000-0000-0000-00000011b204';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W11-2 Branch View Org', 'w112-bv-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (
    id, organization_id, code, name, branch_type, timezone,
    operating_hours, address, is_active
  )
  VALUES (
    v_branch, v_org,
    'w112-test-' || left(v_branch::text, 8),
    'W11-2 Test Branch',
    'hub', 'Asia/Riyadh',
    jsonb_build_object('cutoff_time_local', '07:30'),
    jsonb_build_object('city', 'Riyadh'),
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W11-2 Branch View Client', 'w112-bv-client-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number,
    box_count, promised_delivery_date, branch_id, status
  )
  VALUES (
    v_shipment, v_org, v_client, 'delivery', 'W112-BR-' || left(v_shipment::text, 8),
    1, ((now() AT TIME ZONE 'Asia/Riyadh')::date), v_branch, 'created'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  PERFORM set_config('test.w112b_branch', v_branch::text, true);
  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT cutoff_time::text FROM public.v_branch_summary
    WHERE branch_id = current_setting('test.w112b_branch')::uuid),
  '07:30',
  'v_branch_summary projects cutoff_time from operating_hours.cutoff_time_local'
);

SELECT is(
  (SELECT booked_today::int FROM public.v_branch_summary
    WHERE branch_id = current_setting('test.w112b_branch')::uuid),
  1,
  'v_branch_summary projects booked_today from branch promised shipments'
);

SELECT * FROM finish();
ROLLBACK;

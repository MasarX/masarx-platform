-- pgTAP: public.v_zone_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W11-2 (paired projection views — NETWORK)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_zone_summary',
  'public.v_zone_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_zone_summary',
  ARRAY[
    'zone_id', 'organization_id', 'name', 'slug', 'is_active',
    'description', 'created_at', 'updated_at',
    'branch_count', 'district_count', 'pending_overrides',
    'last_override_at', 'hub_code', 'color_token', 'geometry'
  ],
  'v_zone_summary exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_zone_summary', 'SELECT'),
  'service_role has SELECT on v_zone_summary'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_zone_summary', 'SELECT'),
  'anon has no SELECT on v_zone_summary'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_zone_summary', 'SELECT'),
  'authenticated has SELECT on v_zone_summary'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'zones'
       AND c.relkind = 'r'
  ),
  'public.zones remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a zone with metadata.color_token, verify echo.
DO $$
DECLARE
  v_org  UUID := '00000000-0000-0000-0000-00000011b211';
  v_zone UUID := '00000000-0000-0000-0000-00000011b212';
  v_city UUID := '00000000-0000-0000-0000-00000011b213';
  v_d1   UUID := '00000000-0000-0000-0000-00000011b214';
  v_d2   UUID := '00000000-0000-0000-0000-00000011b215';
  v_d3   UUID := '00000000-0000-0000-0000-00000011b216';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W11-2 Zone View Org', 'w112-zv-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.zones (
    id, organization_id, name, slug, description, is_active, metadata
  )
  VALUES (
    v_zone, v_org,
    'W11-2 Test Zone',
    'w112-test-' || left(v_zone::text, 8),
    'pgTAP zone for view projection',
    TRUE,
    jsonb_build_object('color_token', 'good')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.canonical_cities (
    id, organization_id, name_canonical, country_code, source
  )
  VALUES (
    v_city, v_org, 'W11-2 Geometry City', 'SA', 'ops_verified'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.canonical_districts (
    id, organization_id, city_id, name_canonical, source, centroid_lat, centroid_lng
  )
  VALUES
    (v_d1, v_org, v_city, 'W11-2 Geometry District A', 'ops_verified', 24.740000, 46.660000),
    (v_d2, v_org, v_city, 'W11-2 Geometry District B', 'ops_verified', 24.760000, 46.700000),
    (v_d3, v_org, v_city, 'W11-2 Geometry District C', 'ops_verified', 24.780000, 46.630000)
  ON CONFLICT (id) DO UPDATE
    SET centroid_lat = EXCLUDED.centroid_lat,
        centroid_lng = EXCLUDED.centroid_lng;

  INSERT INTO public.zone_districts (zone_id, canonical_district_id)
  VALUES (v_zone, v_d1), (v_zone, v_d2), (v_zone, v_d3)
  ON CONFLICT (zone_id, canonical_district_id) DO NOTHING;

  PERFORM set_config('test.w112z_zone', v_zone::text, true);
  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT color_token FROM public.v_zone_summary
    WHERE zone_id = current_setting('test.w112z_zone')::uuid),
  'good',
  'v_zone_summary projects color_token from metadata'
);

SELECT ok(
  (SELECT jsonb_array_length(geometry->'paths') >= 4
     FROM public.v_zone_summary
    WHERE zone_id = current_setting('test.w112z_zone')::uuid),
  'v_zone_summary projects geometry from canonical district centroids'
);

SELECT * FROM finish();
ROLLBACK;

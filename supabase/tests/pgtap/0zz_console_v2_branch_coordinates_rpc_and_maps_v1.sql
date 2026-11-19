-- pgTAP: Console V2 branch coordinate capture and map marker contract.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

SELECT ok(
  to_regprocedure('public.branch_coordinates_from_payload_v1(jsonb)') IS NOT NULL,
  'branch coordinate normalizer exists'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_coordinates_from_payload_v1(jsonb)')) ~ 'ST_MakePoint'
    AND pg_get_functiondef(to_regprocedure('public.branch_coordinates_from_payload_v1(jsonb)')) ~ 'latitude'
    AND pg_get_functiondef(to_regprocedure('public.branch_coordinates_from_payload_v1(jsonb)')) ~ 'longitude',
  'branch coordinate normalizer converts latitude/longitude into a PostGIS point'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_create_v1(jsonb)')) ~ 'branch_coordinates_from_payload_v1'
    AND pg_get_functiondef(to_regprocedure('public.branch_create_v1(jsonb)')) ~ 'coordinates',
  'branch_create_v1 persists coordinates through the canonical branches column'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_update_v1(jsonb)')) ~ 'branch_coordinates_from_payload_v1'
    AND pg_get_functiondef(to_regprocedure('public.branch_update_v1(jsonb)')) ~ 'coordinates',
  'branch_update_v1 patches coordinates through the canonical branches column'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hubs'
      AND column_name = 'lat'
      AND data_type = 'double precision'
  ),
  'public.hubs exposes lat for tracking map hub markers'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hubs'
      AND column_name = 'lng'
      AND data_type = 'double precision'
  ),
  'public.hubs exposes lng for tracking map hub markers'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_branch_summary'
      AND column_name IN ('lat', 'lng')
    GROUP BY table_schema, table_name
    HAVING COUNT(*) = 2
  ),
  'v_branch_summary exposes branch lat/lng for profile edit/readback'
);

SELECT ok(
  lower(pg_get_viewdef('public.hubs'::regclass, true)) ~ 'st_y'
    AND lower(pg_get_viewdef('public.hubs'::regclass, true)) ~ 'st_x',
  'public.hubs derives marker coordinates from branches.coordinates'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_branch_directory'
      AND column_name IN ('lat', 'lng')
    GROUP BY table_schema, table_name
    HAVING COUNT(*) = 2
  ),
  'v_branch_directory exposes branch lat/lng for Console V2 branch reads'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings setting
    WHERE setting.category = 'ui_read_registry'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        WHERE resource.value->>'key' = 'branches'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        WHERE resource.value->>'key' = 'branches'
          AND resource.value->>'relation' = 'public.v_branch_directory'
      )
  ),
  'branches read registry uses map-ready branch directory projection'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings setting
    WHERE setting.category = 'ui_read_registry'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        WHERE resource.value->>'key' = 'branches'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
        WHERE resource.value->>'key' = 'branches'
          AND filter.value->>'key' = 'organization_id'
          AND filter.value->>'column' = 'organization_id'
      )
  ),
  'branches registry accepts organization_id tenant-lens filters'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings setting
    WHERE setting.category = 'ui_read_registry'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        WHERE resource.value->>'key' = 'branch_summary'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
        WHERE resource.value->>'key' = 'branch_summary'
          AND filter.value->>'key' = 'organization_id'
          AND filter.value->>'column' = 'organization_id'
      )
  ),
  'branch_summary registry accepts organization_id tenant-lens filters'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings setting
    WHERE setting.category = 'ui_read_registry'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        WHERE resource.value->>'key' = 'hubs'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(setting.cached_value->'resources', '[]'::jsonb)) AS resource(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
        WHERE resource.value->>'key' = 'hubs'
          AND filter.value->>'key' = 'organization_id'
          AND filter.value->>'column' = 'organization_id'
      )
  ),
  'hubs registry accepts organization_id tenant-lens filters'
);

SELECT * FROM finish();

ROLLBACK;

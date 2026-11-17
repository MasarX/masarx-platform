-- Migration: Populate benchmark_sa_uuid_map from canonical_cities/canonical_districts (real UUIDs)
-- Purpose: Use existing canonical tables (source_* ids) to map SA polygons to real city/district UUIDs for benchmarks.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Overlay real canonical UUIDs where we have source mappings; keep deterministic rows for coverage
INSERT INTO public.benchmark_sa_uuid_map (sa_region_id, sa_city_id, sa_district_id, city_id, district_id, updated_at)
SELECT
    sd.region_id,
    sd.city_id,
    sd.id AS sa_district_id,
    cd.city_id,
    cd.id AS district_id,
    now()
FROM (
    SELECT DISTINCT ON (sd.id)
        sd.id,
        sd.city_id,
        sd.region_id,
        cd.city_id AS canonical_city_id,
        cd.id AS canonical_district_id,
        cd.organization_id
    FROM sa_districts sd
    JOIN canonical_districts cd
      ON cd.source_district_id = sd.id
    WHERE cd.is_active = TRUE
    ORDER BY sd.id, cd.organization_id
) x
JOIN sa_districts sd ON sd.id = x.id
JOIN canonical_districts cd ON cd.id = x.canonical_district_id
ON CONFLICT (sa_district_id) DO UPDATE
SET city_id = EXCLUDED.city_id,
    district_id = EXCLUDED.district_id,
    updated_at = now();

-- Backfill expected UUIDs in benchmark samples using the populated map
SELECT benchmark_backfill_expected_ids();

COMMIT;

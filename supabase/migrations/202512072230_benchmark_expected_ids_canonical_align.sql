-- Migration: Align benchmark expected IDs to canonical UUIDs
-- Purpose: Ensure benchmark_geocoding_samples expected_city_id/expected_district_id use canonical tables (no deterministic fallbacks),
--          so local lookup results match expected IDs and accuracy scoring is valid.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Rebuild benchmark_sa_uuid_map using canonical tables only; overwrite any deterministic UUIDs
DELETE FROM benchmark_sa_uuid_map;
WITH mapped AS (
    SELECT DISTINCT ON (sd.id)
        sd.region_id,
        sd.city_id AS sa_city_id,
        sd.id AS sa_district_id,
        cd.city_id AS canonical_city_id,
        cd.id AS district_id
    FROM sa_districts sd
    JOIN canonical_districts cd ON cd.source_district_id = sd.id
    WHERE cd.is_active = TRUE
    ORDER BY sd.id, cd.organization_id
)
INSERT INTO benchmark_sa_uuid_map (sa_region_id, sa_city_id, sa_district_id, city_id, district_id)
SELECT region_id, sa_city_id, sa_district_id, canonical_city_id, district_id FROM mapped
ON CONFLICT (sa_district_id) DO UPDATE
SET sa_region_id = EXCLUDED.sa_region_id,
    sa_city_id = EXCLUDED.sa_city_id,
    city_id = EXCLUDED.city_id,
    district_id = EXCLUDED.district_id,
    updated_at = now();

-- Realign expected IDs in benchmark_geocoding_samples to canonical IDs via the refreshed map
UPDATE benchmark_geocoding_samples s
SET expected_city_id = m.city_id,
    expected_district_id = m.district_id,
    expected_sa_city_id = m.sa_city_id,
    expected_sa_district_id = m.sa_district_id,
    updated_at = now()
FROM benchmark_sa_uuid_map m
WHERE s.expected_sa_district_id = m.sa_district_id;

-- For any rows still NULL (no SA match), attempt name-based fallback to canonical IDs
WITH fallback AS (
  SELECT s.id AS sample_id, cd.city_id, cd.id AS district_id
  FROM benchmark_geocoding_samples s
  JOIN canonical_districts cd
    ON (lower(cd.name_canonical) = lower(COALESCE(s.district, '')))
  WHERE s.expected_district_id IS NULL
)
UPDATE benchmark_geocoding_samples s
SET expected_city_id = f.city_id,
    expected_district_id = f.district_id,
    updated_at = now()
FROM fallback f
WHERE s.id = f.sample_id;

-- Clean up any remaining NULL expected IDs by mirroring SA UUID map where available
UPDATE benchmark_geocoding_samples s
SET expected_city_id = m.city_id,
    expected_district_id = m.district_id,
    updated_at = now()
FROM benchmark_sa_uuid_map m
WHERE s.expected_district_id IS NULL
  AND s.expected_sa_district_id = m.sa_district_id;

COMMIT;

-- Migration: Refresh benchmark expected IDs from SA mapping
-- Purpose: Align benchmark_geocoding_samples expected IDs with the latest benchmark_sa_uuid_map,
--          and fill missing SA IDs where possible. Ensures benchmarks score against current canonical mapping.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Ensure benchmark_sa_uuid_map covers all SA districts (insert missing with deterministic UUIDs)
INSERT INTO public.benchmark_sa_uuid_map (sa_region_id, sa_city_id, sa_district_id, city_id, district_id)
SELECT
    d.region_id,
    d.city_id,
    d.id,
    (format(
        '%s-%s-%s-%s-%s',
        substr(md5('sa_city_' || d.city_id), 1, 8),
        substr(md5('sa_city_' || d.city_id), 9, 4),
        '5' || substr(md5('sa_city_' || d.city_id), 14, 3),
        lpad(to_hex((('x' || substr(md5('sa_city_' || d.city_id), 17, 2))::bit(8)::int & 63) | 128), 2, '0') || substr(md5('sa_city_' || d.city_id), 19, 2),
        substr(md5('sa_city_' || d.city_id), 21, 12)
    ))::uuid AS city_uuid,
    (format(
        '%s-%s-%s-%s-%s',
        substr(md5('sa_district_' || d.id), 1, 8),
        substr(md5('sa_district_' || d.id), 9, 4),
        '5' || substr(md5('sa_district_' || d.id), 14, 3),
        lpad(to_hex((('x' || substr(md5('sa_district_' || d.id), 17, 2))::bit(8)::int & 63) | 128), 2, '0') || substr(md5('sa_district_' || d.id), 19, 2),
        substr(md5('sa_district_' || d.id), 21, 12)
    ))::uuid AS district_uuid
FROM sa_districts d
LEFT JOIN benchmark_sa_uuid_map m ON m.sa_district_id = d.id
WHERE m.sa_district_id IS NULL;

-- Fill missing SA IDs in samples using name-based match (bounded via CTE)
WITH missing AS (
    SELECT s.id AS sample_id, d.id AS sa_district_id, d.city_id, d.region_id
    FROM benchmark_geocoding_samples s
    JOIN (
        SELECT d.id, d.city_id, d.region_id, lower(coalesce(d.name_en, d.name_ar)) AS district_name, lower(coalesce(c.name_en, c.name_ar)) AS city_name
        FROM sa_districts d
        JOIN sa_cities c ON c.id = d.city_id
    ) d
      ON (
          (s.district IS NOT NULL AND lower(s.district) = d.district_name) OR
          (s.city IS NOT NULL AND lower(s.city) = d.city_name)
      )
    WHERE s.expected_sa_district_id IS NULL
    LIMIT 50
)
UPDATE benchmark_geocoding_samples s
SET expected_sa_district_id = m.sa_district_id,
    expected_sa_city_id = m.city_id,
    expected_sa_region_id = m.region_id
FROM missing m
WHERE s.id = m.sample_id;

-- Refresh expected UUIDs from the current SA→UUID map (override stale/deterministic values)
UPDATE benchmark_geocoding_samples s
SET expected_city_id = m.city_id,
    expected_district_id = m.district_id,
    updated_at = now()
FROM benchmark_sa_uuid_map m
WHERE s.expected_sa_district_id = m.sa_district_id
  AND (
       s.expected_city_id IS DISTINCT FROM m.city_id OR
       s.expected_district_id IS DISTINCT FROM m.district_id
  );

COMMIT;

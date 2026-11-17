-- Migration: Populate benchmark_sa_uuid_map using deterministic UUIDs per SA district
-- Purpose: Provide a full SA->UUID mapping for benchmarks without external data; UUIDs are derived deterministically from SA IDs (md5-based) and are suitable for benchmark-only correctness checks.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Ensure the mapping table exists (created in earlier migration)
-- Populate with deterministic UUIDs per district/city
TRUNCATE public.benchmark_sa_uuid_map;

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
FROM public.sa_districts d;

-- Backfill expected UUIDs in benchmark samples using the generated map
SELECT benchmark_backfill_expected_ids();

COMMIT;

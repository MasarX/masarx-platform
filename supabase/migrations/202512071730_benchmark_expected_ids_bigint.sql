-- Migration: Align benchmark expected SA IDs to bigint
-- Purpose: sa_regions/sa_cities/sa_districts IDs are bigint; benchmark_expected_* columns must match to avoid overflow on corpus generation.

BEGIN;

ALTER TABLE public.benchmark_geocoding_samples
  ALTER COLUMN expected_sa_region_id TYPE BIGINT USING expected_sa_region_id::BIGINT,
  ALTER COLUMN expected_sa_city_id TYPE BIGINT USING expected_sa_city_id::BIGINT,
  ALTER COLUMN expected_sa_district_id TYPE BIGINT USING expected_sa_district_id::BIGINT;

COMMIT;

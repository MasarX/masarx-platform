-- Migration: Saudi polygons IDs to bigint (seed compatibility)
-- Purpose: Align sa_* tables with upstream dataset identifiers that exceed 32-bit range.

BEGIN;

ALTER TABLE public.sa_cities DROP CONSTRAINT IF EXISTS sa_cities_region_id_fkey;
ALTER TABLE public.sa_districts DROP CONSTRAINT IF EXISTS sa_districts_city_id_fkey;
ALTER TABLE public.sa_districts DROP CONSTRAINT IF EXISTS sa_districts_region_id_fkey;

ALTER TABLE public.sa_regions
  ALTER COLUMN id TYPE BIGINT USING id::BIGINT;

ALTER TABLE public.sa_cities
  ALTER COLUMN id TYPE BIGINT USING id::BIGINT,
  ALTER COLUMN region_id TYPE BIGINT USING region_id::BIGINT;

ALTER TABLE public.sa_districts
  ALTER COLUMN id TYPE BIGINT USING id::BIGINT,
  ALTER COLUMN city_id TYPE BIGINT USING city_id::BIGINT,
  ALTER COLUMN region_id TYPE BIGINT USING region_id::BIGINT;

ALTER TABLE public.sa_cities
  ADD CONSTRAINT sa_cities_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.sa_regions(id);

ALTER TABLE public.sa_districts
  ADD CONSTRAINT sa_districts_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.sa_cities(id);

ALTER TABLE public.sa_districts
  ADD CONSTRAINT sa_districts_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.sa_regions(id);

COMMIT;

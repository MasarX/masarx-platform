-- Migration: Benchmark expected UUID mapping
-- Purpose: Provide a canonical mapping from SA polygons to city/district UUIDs for benchmark samples so provider/local matches can be validated via UUIDs (not just names).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Create mapping table (append-only, RLS enabled)
CREATE TABLE IF NOT EXISTS public.benchmark_sa_uuid_map (
    sa_region_id BIGINT NOT NULL,
    sa_city_id BIGINT NOT NULL,
    sa_district_id BIGINT NOT NULL,
    city_id UUID NOT NULL,
    district_id UUID NOT NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    PRIMARY KEY (sa_district_id)
);

COMMENT ON TABLE public.benchmark_sa_uuid_map IS 'Maps SA polygon IDs to canonical city/district UUIDs for benchmark validation.';

ALTER TABLE public.benchmark_sa_uuid_map ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'benchmark_sa_uuid_map' AND policyname = 'benchmark_sa_uuid_map_service_role_all'
  ) THEN
    EXECUTE 'CREATE POLICY benchmark_sa_uuid_map_service_role_all ON public.benchmark_sa_uuid_map FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END$$;

-- Helper to backfill expected_city_id/expected_district_id in benchmark_geocoding_samples using the map
CREATE OR REPLACE FUNCTION public.benchmark_backfill_expected_ids() RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INT := 0;
BEGIN
    UPDATE public.benchmark_geocoding_samples s
    SET expected_city_id = m.city_id,
        expected_district_id = m.district_id,
        updated_at = now()
    FROM public.benchmark_sa_uuid_map m
    WHERE s.expected_district_id IS NULL
      AND s.expected_sa_district_id = m.sa_district_id
      AND s.expected_sa_city_id = m.sa_city_id;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.benchmark_backfill_expected_ids() IS 'Populates expected_city_id/expected_district_id in benchmark_geocoding_samples using benchmark_sa_uuid_map.';

COMMIT;

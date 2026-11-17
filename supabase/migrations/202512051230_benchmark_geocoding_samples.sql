-- Migration: Benchmark geocoding samples table
-- Purpose: Store labeled benchmark rows (inputs + expected outputs) to evaluate plugins accuracy/latency.
-- Alignment: Row-driven, workflow-driven, no hardcoding.

BEGIN;

CREATE TABLE IF NOT EXISTS public.benchmark_geocoding_samples (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category text NOT NULL, -- e.g. perfect|typo|long_line|short_code|coords_only|reverse_only|edge_case
    language text, -- ar|en|mixed
    line1 text,
    line2 text,
    city text,
    district text,
    province text,
    country text,
    latitude numeric,
    longitude numeric,
    expected_city_id uuid,
    expected_district_id uuid,
    expected_sa_region_id integer,
    expected_sa_city_id integer,
    expected_sa_district_id integer,
    expected_plugin text, -- perfect|fuzzy|long_line|reverse_local|provider
    expected_outcome text, -- should_match|should_fallback|should_fail
    has_typos boolean DEFAULT false,
    has_extra_tokens boolean DEFAULT false,
    missing_city boolean DEFAULT false,
    missing_district boolean DEFAULT false,
    weight numeric DEFAULT 1,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

COMMENT ON TABLE public.benchmark_geocoding_samples IS 'Labeled benchmark corpus for geocoding plugins (inputs + expected outputs).';

ALTER TABLE public.benchmark_geocoding_samples ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'benchmark_geocoding_samples' AND policyname = 'benchmark_geocoding_samples_service_role_select'
  ) THEN
    EXECUTE 'CREATE POLICY benchmark_geocoding_samples_service_role_select ON public.benchmark_geocoding_samples FOR SELECT TO service_role USING (true)';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS benchmark_geocoding_samples_category_idx ON public.benchmark_geocoding_samples (category);
CREATE INDEX IF NOT EXISTS benchmark_geocoding_samples_expected_plugin_idx ON public.benchmark_geocoding_samples (expected_plugin);

COMMIT;

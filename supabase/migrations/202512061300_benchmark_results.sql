-- Migration: Benchmark results storage + metrics views
-- Purpose: Store benchmark execution outcomes (per policy variant) and expose per-plugin statistics with 95% CI and latency.
-- Alignment: workflow/row-driven, no hardcoding; single source of truth; RLS enabled.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE TABLE IF NOT EXISTS public.benchmark_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sample_id UUID NOT NULL REFERENCES public.benchmark_geocoding_samples(id) ON DELETE CASCADE,
    policy_scope_type TEXT, -- global|tenant|client|sender
    policy_scope_id UUID,
    policy_label TEXT, -- human-readable policy/tag for the run
    match_plugin TEXT, -- e.g. perfect|fuzzy|long_line|reverse_local|provider
    matched BOOLEAN, -- correct city/district vs ground truth
    confidence NUMERIC,
    selected_city_id UUID,
    selected_district_id UUID,
    expected_city_id UUID,
    expected_district_id UUID,
    local_latency_ms NUMERIC,
    provider_latency_ms NUMERIC,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.benchmark_results IS 'SSOT for benchmark runs: one row per sample+policy variant execution with accuracy/latency details.';

ALTER TABLE public.benchmark_results ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'benchmark_results' AND policyname = 'benchmark_results_service_role_select'
  ) THEN
    EXECUTE 'CREATE POLICY benchmark_results_service_role_select ON public.benchmark_results FOR SELECT TO service_role USING (true)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'benchmark_results' AND policyname = 'benchmark_results_service_role_insert'
  ) THEN
    EXECUTE 'CREATE POLICY benchmark_results_service_role_insert ON public.benchmark_results FOR INSERT TO service_role WITH CHECK (true)';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS benchmark_results_sample_idx ON public.benchmark_results (sample_id);
CREATE INDEX IF NOT EXISTS benchmark_results_plugin_idx ON public.benchmark_results (match_plugin);
CREATE INDEX IF NOT EXISTS benchmark_results_policy_idx ON public.benchmark_results (policy_scope_type, policy_scope_id);

-- Metrics view: per plugin + category accuracy with Wilson 95% CI and p95 latency
CREATE OR REPLACE VIEW public.v_benchmark_plugin_metrics AS
WITH z AS (SELECT 1.96::numeric AS z)
SELECT
  agg.match_plugin,
  agg.category,
  agg.n,
  agg.correct,
  agg.accuracy,
  (
    (agg.accuracy + z.z^2/(2*agg.n) - z.z * sqrt( (agg.accuracy*(1-agg.accuracy) + z.z^2/(4*agg.n)) / agg.n ))
    /
    (1 + z.z^2/agg.n)
  ) AS ci_low,
  (
    (agg.accuracy + z.z^2/(2*agg.n) + z.z * sqrt( (agg.accuracy*(1-agg.accuracy) + z.z^2/(4*agg.n)) / agg.n ))
    /
    (1 + z.z^2/agg.n)
  ) AS ci_high,
  agg.p95_latency_ms
FROM (
  SELECT
    br.match_plugin,
    s.category,
    COUNT(*) AS n,
    SUM(CASE WHEN br.matched THEN 1 ELSE 0 END)::numeric AS correct,
    SUM(CASE WHEN br.matched THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0) AS accuracy,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(br.local_latency_ms, br.provider_latency_ms)) AS p95_latency_ms
  FROM public.benchmark_results br
  JOIN public.benchmark_geocoding_samples s ON s.id = br.sample_id
  GROUP BY br.match_plugin, s.category
) agg
CROSS JOIN z;

COMMENT ON VIEW public.v_benchmark_plugin_metrics IS 'Per-plugin accuracy with 95% CI and p95 latency, grouped by benchmark category.';

-- Failure modes view: quick breakdown of top failure reasons per plugin/category
CREATE OR REPLACE VIEW public.v_benchmark_failures AS
SELECT
  br.match_plugin,
  s.category,
  br.failure_reason,
  COUNT(*) AS failures
FROM public.benchmark_results br
JOIN public.benchmark_geocoding_samples s ON s.id = br.sample_id
WHERE br.matched IS NOT TRUE
GROUP BY br.match_plugin, s.category, br.failure_reason
ORDER BY failures DESC;

COMMENT ON VIEW public.v_benchmark_failures IS 'Top failure reasons per plugin/category from benchmark_results.';

COMMIT;

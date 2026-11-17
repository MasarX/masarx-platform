-- Migration: Benchmark latest-run metrics views
-- Purpose: Provide per-plugin metrics and failures scoped to the latest benchmark_runs entry (no manual truncation required).

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE VIEW public.v_benchmark_latest_run AS
SELECT id AS run_id, benchmark_key, created_at, metadata
FROM public.benchmark_runs
WHERE benchmark_key = 'geocoding'
ORDER BY created_at DESC
LIMIT 1;

COMMENT ON VIEW public.v_benchmark_latest_run IS 'Latest benchmark_runs row for geocoding benchmarks.';

CREATE OR REPLACE VIEW public.v_benchmark_plugin_metrics_latest_run AS
WITH latest AS (
  SELECT run_id FROM public.v_benchmark_latest_run
),
z AS (SELECT 1.96::numeric AS z)
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
  JOIN latest l ON l.run_id = br.run_id
  JOIN public.benchmark_geocoding_samples s ON s.id = br.sample_id
  GROUP BY br.match_plugin, s.category
) agg
CROSS JOIN z;

COMMENT ON VIEW public.v_benchmark_plugin_metrics_latest_run IS 'Per-plugin accuracy with 95% CI and p95 latency for the latest geocoding benchmark run.';

CREATE OR REPLACE VIEW public.v_benchmark_failures_latest_run AS
WITH latest AS (
  SELECT run_id FROM public.v_benchmark_latest_run
)
SELECT
  br.match_plugin,
  s.category,
  br.failure_reason,
  COUNT(*) AS failures
FROM public.benchmark_results br
JOIN latest l ON l.run_id = br.run_id
JOIN public.benchmark_geocoding_samples s ON s.id = br.sample_id
WHERE br.matched IS NOT TRUE
GROUP BY br.match_plugin, s.category, br.failure_reason
ORDER BY failures DESC;

COMMENT ON VIEW public.v_benchmark_failures_latest_run IS 'Top failure reasons per plugin/category for the latest geocoding benchmark run.';

COMMIT;


-- pgTAP: Console V2 API gateway policy must expose every threshold key the
-- frontend reads. pgTAP is supporting proof only; live browser proof remains
-- required by the first-tenant readiness goal.

BEGIN;
SELECT plan(18);

SELECT is(
  (public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'version')::int,
  5,
  'api_gateway_thresholds resolved policy version = 5'
);

SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'usage_pct_warn')::int, 80, 'usage_pct_warn is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'latency_band_good_boundary_ms')::int, 300, 'latency_band_good_boundary_ms is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'latency_band_warn_ms')::int, 900, 'latency_band_warn_ms is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'latency_band_danger_ms')::int, 2000, 'latency_band_danger_ms is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'latency_p95_warn_ms')::int, 900, 'latency_p95_warn_ms is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'latency_p95_danger_ms')::int, 2000, 'latency_p95_danger_ms is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'error_rate_warn_pct')::int, 2, 'error_rate_warn_pct is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'error_rate_danger_pct')::int, 5, 'error_rate_danger_pct is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'rate_limited_warn_count')::int, 3, 'rate_limited_warn_count is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'rate_limited_danger_count')::int, 10, 'rate_limited_danger_count is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'downstream_dominance_pct')::int, 30, 'downstream_dominance_pct is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'provider_health_correlation_window_ms')::int, 1800000, 'provider_health_correlation_window_ms is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'kpi_window_ms')::int, 3600000, 'kpi_window_ms is resolved');
SELECT is((public.resolve_settings('api_gateway_thresholds', NULL, NULL)->>'default_rate_limit_per_min')::int, 60, 'default_rate_limit_per_min is resolved');

SELECT ok(
  (
    SELECT bool_and((schema->'properties') ? key)
    FROM public.schema_registry sr
    CROSS JOIN unnest(ARRAY[
      'usage_pct_warn',
      'latency_band_good_boundary_ms',
      'latency_band_warn_ms',
      'latency_band_danger_ms',
      'latency_p95_warn_ms',
      'latency_p95_danger_ms',
      'error_rate_warn_pct',
      'error_rate_danger_pct',
      'rate_limited_warn_count',
      'rate_limited_danger_count',
      'downstream_dominance_pct',
      'provider_health_correlation_window_ms',
      'kpi_window_ms',
      'default_rate_limit_per_min'
    ]) AS key
    WHERE sr.category = 'api_gateway_thresholds'
      AND sr.version = 1
      AND sr.is_active = TRUE
  ),
  'schema_registry exposes every Console V2 api_gateway_thresholds property'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'api_gateway_thresholds'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.value = s.cached_value
  ),
  'settings cached_value is aligned to the active settings_versions payload'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM jsonb_each_text(public.resolve_settings('api_gateway_thresholds', NULL, NULL)) AS policy(key, value)
    WHERE value IS NULL OR value = ''
  ),
  'resolved api_gateway_thresholds has no empty values'
);

SELECT * FROM finish();
ROLLBACK;

-- Console V2 API gateway policy repair.
--
-- Earlier policy migrations guaranteed the global api_gateway_thresholds row
-- existed, but drifted live databases can still carry only the initial
-- usage/latency subset. Console V2 now reads the full operator-facing policy
-- from this SSOT and fails loud when any required key is missing.

WITH full_payload AS (
  SELECT jsonb_build_object(
    'version', 5,
    'usage_pct_warn', 80,
    'latency_band_good_boundary_ms', 300,
    'latency_band_warn_ms', 900,
    'latency_band_danger_ms', 2000,
    'latency_p95_warn_ms', 900,
    'latency_p95_danger_ms', 2000,
    'error_rate_warn_pct', 2,
    'error_rate_danger_pct', 5,
    'rate_limited_warn_count', 3,
    'rate_limited_danger_count', 10,
    'downstream_dominance_pct', 30,
    'provider_health_correlation_window_ms', 1800000,
    'kpi_window_ms', 3600000,
    'default_rate_limit_per_min', 60
  ) AS body
)
UPDATE public.schema_registry
SET schema = COALESCE(schema, '{}'::jsonb)
      || jsonb_build_object(
        '$schema', 'http://json-schema.org/draft-07/schema#',
        'title', 'API Gateway Thresholds',
        'type', 'object',
        'additionalProperties', true,
        'properties', jsonb_build_object(
          'version', jsonb_build_object('type', 'integer', 'minimum', 1),
          'usage_pct_warn', jsonb_build_object('type', 'integer', 'minimum', 0),
          'latency_band_good_boundary_ms', jsonb_build_object('type', 'integer', 'minimum', 0),
          'latency_band_warn_ms', jsonb_build_object('type', 'integer', 'minimum', 0),
          'latency_band_danger_ms', jsonb_build_object('type', 'integer', 'minimum', 0),
          'latency_p95_warn_ms', jsonb_build_object('type', 'integer', 'minimum', 0),
          'latency_p95_danger_ms', jsonb_build_object('type', 'integer', 'minimum', 0),
          'error_rate_warn_pct', jsonb_build_object('type', 'number', 'minimum', 0),
          'error_rate_danger_pct', jsonb_build_object('type', 'number', 'minimum', 0),
          'rate_limited_warn_count', jsonb_build_object('type', 'integer', 'minimum', 0),
          'rate_limited_danger_count', jsonb_build_object('type', 'integer', 'minimum', 0),
          'downstream_dominance_pct', jsonb_build_object('type', 'number', 'minimum', 0),
          'provider_health_correlation_window_ms', jsonb_build_object('type', 'integer', 'minimum', 0),
          'kpi_window_ms', jsonb_build_object('type', 'integer', 'minimum', 0),
          'default_rate_limit_per_min', jsonb_build_object('type', 'integer', 'minimum', 0)
        )
      ),
    examples = jsonb_build_array((SELECT body FROM full_payload)),
    is_active = TRUE,
    deprecated_at = NULL,
    updated_at = now()
WHERE category = 'api_gateway_thresholds'
  AND version = 1;

WITH full_payload AS (
  SELECT jsonb_build_object(
    'version', 5,
    'usage_pct_warn', 80,
    'latency_band_good_boundary_ms', 300,
    'latency_band_warn_ms', 900,
    'latency_band_danger_ms', 2000,
    'latency_p95_warn_ms', 900,
    'latency_p95_danger_ms', 2000,
    'error_rate_warn_pct', 2,
    'error_rate_danger_pct', 5,
    'rate_limited_warn_count', 3,
    'rate_limited_danger_count', 10,
    'downstream_dominance_pct', 30,
    'provider_health_correlation_window_ms', 1800000,
    'kpi_window_ms', 3600000,
    'default_rate_limit_per_min', 60
  ) AS body
)
UPDATE public.settings_versions
SET value = (SELECT body FROM full_payload),
    updated_at = now()
WHERE category = 'api_gateway_thresholds'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND effective_until IS NULL
  AND approved_at IS NOT NULL;

WITH full_payload AS (
  SELECT jsonb_build_object(
    'version', 5,
    'usage_pct_warn', 80,
    'latency_band_good_boundary_ms', 300,
    'latency_band_warn_ms', 900,
    'latency_band_danger_ms', 2000,
    'latency_p95_warn_ms', 900,
    'latency_p95_danger_ms', 2000,
    'error_rate_warn_pct', 2,
    'error_rate_danger_pct', 5,
    'rate_limited_warn_count', 3,
    'rate_limited_danger_count', 10,
    'downstream_dominance_pct', 30,
    'provider_health_correlation_window_ms', 1800000,
    'kpi_window_ms', 3600000,
    'default_rate_limit_per_min', 60
  ) AS body
)
UPDATE public.settings s
SET cached_value = (SELECT body FROM full_payload),
    settings_version_id = sv.id,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.category = 'api_gateway_thresholds'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.category = s.category
  AND sv.scope_type = s.scope_type
  AND sv.scope_hash = s.scope_hash
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL;

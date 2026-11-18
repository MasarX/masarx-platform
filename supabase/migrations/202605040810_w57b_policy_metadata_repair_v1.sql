-- 202605031740_w57b_policy_metadata_repair_v1.sql
--
-- W57b introduced Console V2 canonical policy defaults, but existing active
-- api_gateway_thresholds / geocoding_policy rows can predate that pack. Repair
-- the active global settings rows and schema metadata without replacing tenant,
-- client, or sender overrides.

UPDATE public.schema_registry
SET schema = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(schema, '{}'::jsonb),
          '{properties,latency_band_good_boundary_ms}',
          '{"type":["integer","null"],"minimum":0}'::jsonb,
          TRUE
        ),
        '{properties,latency_band_info_boundary_ms}',
        '{"type":["integer","null"],"minimum":0}'::jsonb,
        TRUE
      ),
      '{properties,latency_band_warn_boundary_ms}',
      '{"type":["integer","null"],"minimum":0}'::jsonb,
      TRUE
    ),
    examples = '[{"version":1,"usage_pct_warn":80,"latency_band_good_boundary_ms":300,"latency_band_info_boundary_ms":900,"latency_band_warn_boundary_ms":2000}]'::jsonb,
    is_active = TRUE,
    deprecated_at = NULL
WHERE category = 'api_gateway_thresholds'
  AND version = 1;

WITH latest_geocoding_schema AS (
  SELECT max(version) AS version
  FROM public.schema_registry
  WHERE category = 'geocoding_policy'
)
UPDATE public.schema_registry sr
SET is_active = (sr.version = latest_geocoding_schema.version),
    deprecated_at = CASE WHEN sr.version = latest_geocoding_schema.version THEN NULL ELSE sr.deprecated_at END
FROM latest_geocoding_schema
WHERE sr.category = 'geocoding_policy';

UPDATE public.settings_versions
SET value = COALESCE(value, '{}'::jsonb)
      || jsonb_build_object(
        'version', COALESCE((value->>'version')::int, 1),
        'usage_pct_warn', COALESCE((value->>'usage_pct_warn')::int, 80),
        'latency_band_good_boundary_ms', 300,
        'latency_band_info_boundary_ms', 900,
        'latency_band_warn_boundary_ms', 2000
      ),
    updated_at = now()
WHERE category = 'api_gateway_thresholds'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND effective_until IS NULL
  AND approved_at IS NOT NULL;

UPDATE public.settings_versions
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{confidence_threshold}', to_jsonb(0.85::numeric), TRUE),
    updated_at = now()
WHERE category = 'geocoding_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND effective_until IS NULL
  AND approved_at IS NOT NULL
  AND COALESCE(value->>'confidence_threshold', '') IS DISTINCT FROM '0.85';

UPDATE public.settings s
SET cached_value = sv.value,
    settings_version_id = sv.id,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.category IN ('api_gateway_thresholds', 'geocoding_policy')
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.category = s.category
  AND sv.scope_type = s.scope_type
  AND sv.scope_hash = s.scope_hash
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL;

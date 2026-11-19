-- Test Suite: Geocoding policy configuration (open/local defaults & workflow wiring)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT ok(
  COALESCE(jsonb_array_length(policy.cfg->'provider_priority'), 0) = 0,
  'Global geocoding policy does not default to external providers'
)
FROM policy;

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT is(
  policy.cfg #>> '{metadata,external_provider_default}',
  'disabled_until_explicitly_configured',
  'Global geocoding policy requires explicit external provider configuration'
)
FROM policy;

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT is(
  policy.cfg #>> '{local_lookup,enabled}',
  'true',
  'Global geocoding policy enables local PostGIS lookup'
)
FROM policy;

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT is(
  policy.cfg #>> '{local_lookup,allow_provider_fallback}',
  'false',
  'Global geocoding policy does not fall back to unconfigured providers'
)
FROM policy;

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM policy, LATERAL jsonb_array_elements(COALESCE(policy.cfg->'matching_plugins', '[]'::jsonb)) AS plugin(value)
    WHERE plugin.value->>'name' = 'fuzzy'
      AND COALESCE((plugin.value->>'enabled')::BOOLEAN, FALSE)
      AND COALESCE((plugin.value #>> '{params,min_confidence}')::NUMERIC, 1) <= 0.7
      AND plugin.value #>> '{params,trigram_weight}' IS NOT NULL
      AND plugin.value #>> '{params,levenshtein_weight}' IS NOT NULL
  ),
  'Global geocoding policy keeps fuzzy matching row-driven'
);

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM policy, LATERAL jsonb_array_elements(COALESCE(policy.cfg->'matching_plugins', '[]'::jsonb)) AS plugin(value)
    WHERE plugin.value->>'name' = 'short_code'
      AND COALESCE((plugin.value->>'enabled')::BOOLEAN, FALSE)
      AND plugin.value #>> '{params,country}' = 'SA'
      AND plugin.value #>> '{params,code_type}' = 'sa_short_code'
      AND plugin.value #>> '{params,code_regex}' = '^[A-Z]{4}[0-9]{4}$'
      AND plugin.value #>> '{params,here_in}' = 'countryCode:SAU'
      AND plugin.value #>> '{params,here_types}' = 'address'
  ),
  'Global geocoding policy supports Saudi short national address codes'
);

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT ok(
  policy.cfg #>> '{coordinate_handling,country_boundary}' = 'SA'
  AND COALESCE((policy.cfg #>> '{coordinate_handling,use_provided_coordinates}')::BOOLEAN, FALSE)
  AND COALESCE((policy.cfg #>> '{coordinate_handling,validate_bounds}')::BOOLEAN, FALSE),
  'Global geocoding policy accepts provided coordinates with Saudi bounds validation'
)
FROM policy;

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT ok(
  policy.cfg #>> '{metadata,open_geocoding_stack,map_engine}' = 'maplibre'
  AND policy.cfg #>> '{metadata,open_geocoding_stack,map_data}' = 'openstreetmap'
  AND policy.cfg #>> '{metadata,open_geocoding_stack,geospatial_source_of_truth}' = 'postgis'
  AND policy.cfg #>> '{metadata,open_geocoding_stack,routing_engine}' = 'valhalla'
  AND policy.cfg #>> '{metadata,open_geocoding_stack,optimization_engine}' = 'vroom',
  'Global geocoding policy declares the approved open map/geospatial stack'
)
FROM policy;

WITH policy AS (
  SELECT resolve_settings('geocoding_policy', 'global', NULL) AS cfg
)
SELECT is(
  policy.cfg->>'decision_workflow_id',
  'workflow_geocoding_standard',
  'Global geocoding policy routes through workflow_geocoding_standard'
)
FROM policy;

WITH steps AS (
  SELECT operation_name
  FROM workflow_template_steps
  WHERE workflow_template_id = (
    SELECT id
    FROM workflow_templates
    WHERE name = 'workflow_geocoding_standard'
    LIMIT 1
  )
    AND operation_name IN ('local_lookup', 'short_code_lookup', 'manual_review')
)
SELECT ok(
  EXISTS (SELECT 1 FROM steps WHERE operation_name = 'local_lookup')
  AND EXISTS (SELECT 1 FROM steps WHERE operation_name = 'short_code_lookup')
  AND EXISTS (SELECT 1 FROM steps WHERE operation_name = 'manual_review'),
  'workflow_geocoding_standard includes local lookup, short-code lookup, and manual review'
);

SELECT finish();

ROLLBACK;

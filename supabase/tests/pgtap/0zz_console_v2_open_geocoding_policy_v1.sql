BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT has_function(
  'public',
  'console_v2_open_geocoding_policy_v1',
  ARRAY['jsonb'],
  'open geocoding policy normalizer exists'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sv.value->'provider_priority', '[]'::jsonb)) provider(key)
     WHERE sv.category = 'geocoding_policy'
       AND sv.scope_type = 'global'
       AND provider.key IN ('here_geocoding', 'here_maps', 'google_maps')
  ),
  'global geocoding policy version does not default to proprietary providers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(s.cached_value->'provider_priority', '[]'::jsonb)) provider(key)
     WHERE s.category = 'geocoding_policy'
       AND s.scope_type = 'global'
       AND provider.key IN ('here_geocoding', 'here_maps', 'google_maps')
  ),
  'global settings cache mirrors non-proprietary geocoding provider priority'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
     FROM public.settings_versions sv
     WHERE sv.category = 'geocoding_policy'
       AND COALESCE(sv.value #>> '{metadata,external_provider_default}', '') = 'disabled_until_explicitly_configured'
       AND COALESCE((sv.value #>> '{local_lookup,min_confidence}')::numeric, 1) > 0.6
  ),
  'local canonical geocoding can accept district centroid confidence at 0.6'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
     FROM public.settings_versions sv
     WHERE sv.category = 'geocoding_policy'
       AND COALESCE(sv.value #>> '{metadata,external_provider_default}', '') = 'disabled_until_explicitly_configured'
       AND COALESCE((sv.value #>> '{local_lookup,allow_provider_fallback}')::boolean, true)
  ),
  'default geocoding policy does not fall back to unconfigured external providers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
     FROM public.settings_versions sv
     WHERE sv.category = 'geocoding_policy'
       AND COALESCE(sv.value #>> '{metadata,external_provider_default}', '') = 'disabled_until_explicitly_configured'
       AND (
         sv.value #>> '{metadata,open_geocoding_stack,map_engine}' IS DISTINCT FROM 'maplibre'
         OR sv.value #>> '{metadata,open_geocoding_stack,map_data}' IS DISTINCT FROM 'openstreetmap'
         OR sv.value #>> '{metadata,open_geocoding_stack,geospatial_source_of_truth}' IS DISTINCT FROM 'postgis'
         OR sv.value #>> '{metadata,open_geocoding_stack,routing_engine}' IS DISTINCT FROM 'valhalla'
         OR sv.value #>> '{metadata,open_geocoding_stack,optimization_engine}' IS DISTINCT FROM 'vroom'
       )
  ),
  'geocoding policy declares the approved open logistics map stack'
);

SELECT ok(
  public.console_v2_open_geocoding_policy_v1(
    jsonb_build_object(
      'provider_priority', jsonb_build_array('here_geocoding', 'google_maps'),
      'local_lookup', jsonb_build_object('min_confidence', 0.9, 'allow_provider_fallback', true)
    )
  ) @> jsonb_build_object(
    'provider_priority', '[]'::jsonb,
    'local_lookup', jsonb_build_object('min_confidence', 0.6, 'allow_provider_fallback', false)
  ),
  'normalizer strips proprietary defaults and pins local/manual behavior'
);

SELECT finish();

ROLLBACK;

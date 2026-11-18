BEGIN;

SELECT plan(21);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND value #>> '{tile_provider,engine}' = 'maplibre'
      AND value #>> '{tile_provider,provider}' = 'openstreetmap'
      AND value #>> '{tile_provider,data_provider}' = 'openstreetmap'
  ),
  'active map_policy rows carry MapLibre engine over free/open OSM data'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND value #>> '{tile_provider,provider}' = 'openstreetmap'
  ),
  'active map_policy rows carry a free/open tile provider'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,url_template}', '') <> '/map-tiles/openstreetmap/{z}/{x}/{y}.png'
  ),
  'map tile URL template uses the approved same-origin OSM-derived endpoint'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,url_template}', '') LIKE '%tile.openstreetmap.org%'
  ),
  'active production map policies do not depend directly on public OSM tile servers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'map_policy'
      AND sv.effective_until IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(sv.value #> '{tile_provider,allowed_hosts}', '[]'::jsonb)) AS host(value)
        WHERE host.value = 'same-origin'
      )
  ),
  'map policy allow-list explicitly approves the same-origin tile endpoint'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND jsonb_typeof(value #> '{tile_provider,allowed_hosts}') IS DISTINCT FROM 'array'
  ),
  'map policy carries an explicit tile host allow-list'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,usage_tier}', '') <> 'production_cached'
  ),
  'map policy declares production cached tile usage tier'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,cache_required}', '') <> 'true'
  ),
  'map policy requires cached tiles for production use'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,same_origin_proxy_allowed}', '') <> 'true'
  ),
  'map policy explicitly allows the same-origin tile proxy'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,public_osm_tile_fallback_allowed}', '') <> 'false'
  ),
  'map policy disallows public OSM tile fallback for production rows'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,attribution_url}', '') <> 'https://www.openstreetmap.org/copyright'
  ),
  'map attribution URL points to OSM copyright terms'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,attribution_label}', '') <> CHR(169) || ' OpenStreetMap contributors'
  ),
  'map attribution label is stored without mojibake'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{tile_provider,license}', '') <> 'ODbL-1.0'
  ),
  'map policy records ODbL attribution/license lineage'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{logistics_stack,spatial_source_of_truth}', '') <> 'postgis'
  ),
  'map logistics stack declares PostGIS as spatial source of truth'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{logistics_stack,routing_engine}', '') <> 'valhalla'
  ),
  'map logistics stack declares Valhalla as routing engine'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND COALESCE(value #>> '{logistics_stack,optimization_engine}', '') <> 'vroom'
  ),
  'map logistics stack declares VROOM as optimization engine'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'postgis'
  ),
  'PostGIS extension is available for geospatial source-of-truth tables'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND effective_until IS NULL
      AND (
        value #> '{default_viewport}' IS NULL
        OR value #> '{zoom_padding}' IS NULL
      )
  ),
  'map policy includes canonical viewport and zoom padding for map screens'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
    WHERE sv.category = 'map_policy'
      AND sv.effective_until IS NULL
      AND s.cached_value IS DISTINCT FROM sv.value
  ),
  'settings cache mirrors patched active map_policy values'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND scope_type = 'global'
      AND effective_until IS NULL
      AND value #>> '{tile_provider,provider}' = 'openstreetmap'
  ),
  'global map_policy provides the first-tenant fallback'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'map_policy'
      AND scope_type = 'tenant'
      AND effective_until IS NULL
      AND value #>> '{tile_provider,provider}' = 'openstreetmap'
  ),
  'tenant map_policy rows inherit the free/open map provider'
);

SELECT * FROM finish();
ROLLBACK;

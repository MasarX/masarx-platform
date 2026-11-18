BEGIN;
SET search_path TO public, extensions, pg_temp;

WITH patch AS (
  SELECT jsonb_build_object(
    'tile_provider',
    jsonb_build_object(
      'engine', 'maplibre',
      'provider', 'openstreetmap',
      'data_provider', 'openstreetmap',
      'url_template', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      'attribution_label', '© OpenStreetMap contributors',
      'attribution_url', 'https://www.openstreetmap.org/copyright',
      'license', 'ODbL-1.0'
    ),
    'logistics_stack',
    jsonb_build_object(
      'spatial_source_of_truth', 'postgis',
      'routing_engine', 'valhalla',
      'optimization_engine', 'vroom'
    ),
    'default_viewport',
    jsonb_build_object('minLat', 24.62, 'maxLat', 24.81, 'minLng', 46.55, 'maxLng', 46.8),
    'zoom_padding',
    jsonb_build_object('lat', 0.004, 'lng', 0.005)
  ) AS value
),
updated_versions AS (
  UPDATE public.settings_versions sv
  SET
    value = sv.value || patch.value,
    version = sv.version + 1,
    change_reason = COALESCE(sv.change_reason, 'Console V2 free map policy') ||
      '; add MapLibre plus free/open OSM tiles, logistics map stack metadata, and canonical viewport defaults'
  FROM patch
  WHERE sv.category = 'map_policy'
    AND sv.effective_until IS NULL
  RETURNING sv.id, sv.scope_hash, sv.value
)
UPDATE public.settings s
SET
  cached_value = uv.value,
  last_updated = now()
FROM updated_versions uv
WHERE s.settings_version_id = uv.id
  AND s.scope_hash = uv.scope_hash;

COMMENT ON COLUMN public.settings_versions.value IS
  'Configuration value as JSON. Console map surfaces require map_policy.tile_provider for MapLibre plus free/open OSM tiles and attribution, logistics_stack for PostGIS/Valhalla/VROOM alignment, plus default_viewport/zoom_padding for map rendering.';

COMMIT;

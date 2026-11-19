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
      'attribution_label', CHR(169) || ' OpenStreetMap contributors',
      'attribution_url', 'https://www.openstreetmap.org/copyright',
      'license', 'ODbL-1.0'
    ),
    'logistics_stack',
    jsonb_build_object(
      'spatial_source_of_truth', 'postgis',
      'routing_engine', 'valhalla',
      'optimization_engine', 'vroom'
    )
  ) AS value
),
updated_versions AS (
  UPDATE public.settings_versions sv
  SET
    value = sv.value || patch.value,
    version = sv.version + 1,
    change_reason = COALESCE(sv.change_reason, 'Console V2 map stack policy') ||
      '; align map surfaces to MapLibre/OpenStreetMap/PostGIS/Valhalla/VROOM stack'
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

COMMIT;

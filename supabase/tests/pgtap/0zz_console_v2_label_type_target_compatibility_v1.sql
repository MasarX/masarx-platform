-- pgTAP: Console V2 Label Designer target-label selector metadata.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, extensions, pg_temp;

SELECT plan(7);

SELECT is(
  (
    SELECT lv.metadata->'compatible_target_types'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'label_type'
      AND lv.value = 'shipping'
  ),
  '["shipment"]'::jsonb,
  'shipping label type is compatible only with shipment targets'
);

SELECT is(
  (
    SELECT lv.metadata->'compatible_target_types'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'label_type'
      AND lv.value = 'route'
  ),
  '["route_run"]'::jsonb,
  'route label type is compatible with route_run targets'
);

SELECT is(
  (
    SELECT lv.metadata->'compatible_target_types'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'label_type'
      AND lv.value = 'container'
  ),
  '["handling_unit"]'::jsonb,
  'container label type is compatible with handling_unit targets'
);

SELECT is(
  (
    SELECT lv.metadata->'compatible_target_types'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'label_type'
      AND lv.value = 'transfer'
  ),
  '["warehouse_transfer"]'::jsonb,
  'transfer label type is compatible with warehouse_transfer targets'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'label_design'
      AND COALESCE(sv.value, s.cached_value, '{}'::jsonb) ? 'templates'
      AND COALESCE(sv.value, s.cached_value, '{}'::jsonb)#>'{templates,route}' IS NULL
  ),
  'current label_design settings with templates include route target template'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'label_design'
      AND COALESCE(sv.value, s.cached_value, '{}'::jsonb) ? 'templates'
      AND COALESCE(sv.value, s.cached_value, '{}'::jsonb)#>'{templates,container}' IS NULL
  ),
  'current label_design settings with templates include container target template'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'label_design'
      AND COALESCE(sv.value, s.cached_value, '{}'::jsonb) ? 'templates'
      AND COALESCE(sv.value, s.cached_value, '{}'::jsonb)#>'{templates,transfer}' IS NULL
  ),
  'current label_design settings with templates include transfer target template'
);

SELECT finish();
ROLLBACK;

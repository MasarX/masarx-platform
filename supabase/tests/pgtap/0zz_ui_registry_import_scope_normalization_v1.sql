BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT has_function(
  'public',
  'normalize_ui_read_registry_import_v1',
  ARRAY['jsonb'],
  'public.normalize_ui_read_registry_import_v1 exists'
);

SELECT has_function(
  'public',
  'normalize_settings_value_v1',
  ARRAY['text', 'jsonb'],
  'public.normalize_settings_value_v1 exists'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value) ON TRUE
     WHERE s.category = 'ui_read_registry'
       AND resource.value->>'key' = 'recipients'
       AND jsonb_typeof(resource.value->'import') IS DISTINCT FROM 'object'
  ),
  'current ui_read_registry rows keep recipients import metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value) ON TRUE
      JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_value(value) ON TRUE
     WHERE s.category = 'ui_read_registry'
       AND resource.value->>'key' = 'recipients'
       AND column_value.value->>'key' = 'external_id'
       AND jsonb_typeof(column_value.value->'import') IS DISTINCT FROM 'object'
  ),
  'current ui_read_registry rows keep recipients column import metadata'
);

SELECT * FROM finish();

ROLLBACK;

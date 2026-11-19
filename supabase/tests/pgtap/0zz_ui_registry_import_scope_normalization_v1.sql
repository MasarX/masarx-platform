BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

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

SELECT has_function(
  'public',
  'ui_read_registry_preserve_import_policy_limits_v1',
  ARRAY['jsonb', 'jsonb'],
  'public.ui_read_registry_preserve_import_policy_limits_v1 exists'
);

SELECT is(
  public.normalize_settings_value_v1(
    'ui_read_registry',
    jsonb_build_object(
      'resources',
      jsonb_build_array(
        jsonb_build_object(
          'key', 'shipments',
          'relation', 'public.shipments',
          'capability_write', 'shipments.write',
          'import', jsonb_build_object(
            'enabled', true,
            'accepted_formats', jsonb_build_array('csv'),
            'max_file_bytes', 12345,
            'max_rows', 67
          ),
          'columns', '[]'::jsonb
        )
      )
    )
  ) #>> '{resources,0,import,max_file_bytes}',
  '12345',
  'ui_read_registry normalization preserves import max_file_bytes'
);

SELECT is(
  public.normalize_settings_value_v1(
    'ui_read_registry',
    jsonb_build_object(
      'resources',
      jsonb_build_array(
        jsonb_build_object(
          'key', 'shipments',
          'relation', 'public.shipments',
          'capability_write', 'shipments.write',
          'import', jsonb_build_object(
            'enabled', true,
            'accepted_formats', jsonb_build_array('csv'),
            'max_file_bytes', 12345,
            'max_rows', 67
          ),
          'columns', '[]'::jsonb
        )
      )
    )
  ) #>> '{resources,0,import,max_rows}',
  '67',
  'ui_read_registry normalization preserves import max_rows'
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

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value) ON TRUE
     WHERE s.category = 'ui_read_registry'
       AND resource.value->>'key' = 'shipments'
       AND COALESCE(resource.value#>>'{import,max_file_bytes}', '') ~ '^[1-9][0-9]*$'
       AND COALESCE(resource.value#>>'{import,max_rows}', '') ~ '^[1-9][0-9]*$'
  ),
  'current ui_read_registry rows carry row-driven shipment import file and row limits'
);

SELECT * FROM finish();

ROLLBACK;

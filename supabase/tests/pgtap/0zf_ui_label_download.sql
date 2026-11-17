-- Test Suite: Label download registry config
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'labels'
            AND value ? 'download'
       )
  ),
  'labels resource includes download config'
);

SELECT is(
  (
    SELECT value->'download'->>'path_column'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'resources') AS value
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND value->>'key' = 'labels'
     LIMIT 1
  ),
  'file_url',
  'labels download uses file_url'
);

SELECT is(
  (
    SELECT value->'download'->>'capability'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'resources') AS value
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND value->>'key' = 'labels'
     LIMIT 1
  ),
  'labels.download',
  'labels download capability set'
);

SELECT finish();

ROLLBACK;

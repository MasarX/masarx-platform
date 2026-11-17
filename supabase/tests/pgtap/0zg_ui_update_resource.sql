-- Test Suite: UI update resource RPC
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT has_function(
  'public',
  'ui_update_resource_v1',
  ARRAY['text','text','jsonb'],
  'ui_update_resource_v1 exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_read_registry'
       AND schema #> '{properties,resources,items,properties,columns}' IS NOT NULL
  ),
  'ui_read_registry schema includes columns metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_read_registry'
       AND schema #> '{properties,resources,items,properties,capability_write}' IS NOT NULL
  ),
  'ui_read_registry schema includes capability_write'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value ? 'columns'
       )
  ),
  'ui_read_registry defaults include column metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value ? 'capability_write'
       )
  ),
  'ui_read_registry defaults include capability_write'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_update_resource_v1(text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute ui_update_resource_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_update_resource_v1(text,text,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute ui_update_resource_v1'
);

SELECT * FROM finish();
ROLLBACK;

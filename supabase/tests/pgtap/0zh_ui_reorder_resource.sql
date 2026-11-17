-- Test Suite: UI reorder resource RPC
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT has_function(
  'public',
  'ui_reorder_resource_v1',
  ARRAY['text','text[]'],
  'ui_reorder_resource_v1 exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_read_registry'
       AND schema #> '{properties,resources,items,properties,reorder,properties,order_column}' IS NOT NULL
  ),
  'ui_read_registry schema includes reorder config'
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
          WHERE value->>'key' = 'workflow_template_steps'
            AND value ? 'reorder'
       )
  ),
  'ui_read_registry includes workflow_template_steps reorder config'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_reorder_resource_v1(text,text[])',
    'EXECUTE'
  ),
  'authenticated can execute ui_reorder_resource_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_reorder_resource_v1(text,text[])',
    'EXECUTE'
  ),
  'anon cannot execute ui_reorder_resource_v1'
);

SELECT * FROM finish();
ROLLBACK;


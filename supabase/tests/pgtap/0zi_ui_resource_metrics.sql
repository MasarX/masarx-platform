-- Test Suite: UI resource metrics + pagination settings
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT has_function(
  'public',
  'ui_resource_metrics_v1',
  ARRAY['text','jsonb','text[]'],
  'ui_resource_metrics_v1 exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_resource_metrics_v1(text,jsonb,text[])',
    'EXECUTE'
  ),
  'authenticated can execute ui_resource_metrics_v1'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_pagination'),
  'ui_pagination category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_pagination'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'ui_pagination global defaults seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'ui_pagination'
      AND version = 1
      AND is_active = true
  ),
  'ui_pagination schema registered'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_resource_metrics_v1(text,jsonb,text[])',
    'EXECUTE'
  ),
  'anon cannot execute ui_resource_metrics_v1'
);

SELECT finish();

ROLLBACK;

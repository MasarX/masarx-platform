BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(3);

SELECT is((SELECT cached_value#>>'{status_map,assigned,tone}' FROM public.settings
  WHERE category = 'status_theme_policy' AND scope_type = 'global'), 'info',
  'assigned status uses the informational tone');
SELECT is((SELECT cached_value#>>'{status_map,completed,tone}' FROM public.settings
  WHERE category = 'status_theme_policy' AND scope_type = 'global'), 'success',
  'completed status uses the success tone');
SELECT ok(NOT has_function_privilege('anon', 'api.resolve_status_theme_policy(jsonb)', 'EXECUTE'),
  'anonymous callers cannot read a tenant status theme');

SELECT * FROM finish();
ROLLBACK;

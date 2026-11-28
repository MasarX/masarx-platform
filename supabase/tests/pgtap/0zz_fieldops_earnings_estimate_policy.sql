BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(2);

SELECT is((SELECT cached_value->>'enabled' FROM public.settings
  WHERE category = 'earnings_mirror_policy' AND scope_type = 'global'), 'false',
  'estimated earnings are disabled in the global default');
SELECT ok(NOT has_function_privilege('anon', 'api.resolve_earnings_mirror_policy(jsonb)', 'EXECUTE'),
  'anonymous callers do not receive earnings settings');

SELECT * FROM finish();
ROLLBACK;

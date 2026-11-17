-- Test: Settings request capability column + access policy override
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'settings_category_registry'
      AND column_name = 'request_capability'
  ),
  'settings_category_registry.request_capability column exists'
);

SELECT is(
  (SELECT request_capability FROM public.settings_category_registry WHERE category = 'access_control_policy'),
  'access_policy.request',
  'access_control_policy request capability set'
);

SELECT * FROM finish();
ROLLBACK;

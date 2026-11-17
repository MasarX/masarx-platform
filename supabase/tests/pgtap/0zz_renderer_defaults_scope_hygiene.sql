BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT is(
  (
    SELECT count(*)::bigint
    FROM public.settings_versions
    WHERE category = 'renderer_defaults'
      AND scope_type = 'tenant'
      AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid
  ),
  0::bigint,
  'renderer_defaults settings_versions has no tenant rows with sentinel scope_id'
);

SELECT is(
  (
    SELECT count(*)::bigint
    FROM public.settings
    WHERE category = 'renderer_defaults'
      AND scope_type = 'tenant'
      AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid
  ),
  0::bigint,
  'renderer_defaults settings has no tenant rows with sentinel scope_id'
);

SELECT finish();

ROLLBACK;

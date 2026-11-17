-- Plan: PLAN-202601-frontend-portal-phase-10-request-history / Step: S04
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_read_registry'
  ),
  'ui_read_registry category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(sv.value->'resources') AS item ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND item->>'key' = 'requests'
  ),
  'ui_read_registry includes requests resource'
);

SELECT is(
  (
    SELECT item->>'capability_read'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(sv.value->'resources') AS item ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND item->>'key' = 'requests'
    LIMIT 1
  ),
  'requests.read',
  'requests resource uses requests.read capability'
);

SELECT finish();
ROLLBACK;
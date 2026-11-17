-- Migration: ensure ui_table_views cached settings row exists
BEGIN;
SELECT pg_advisory_lock(hashtext('202601091230_ui_table_views_settings_cache'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH latest AS (
  SELECT id, value
  FROM public.settings_versions
  WHERE category = 'ui_table_views'
    AND scope_type = 'global'
    AND scope_id IS NULL
  ORDER BY version DESC
  LIMIT 1
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'ui_table_views',
  'global',
  NULL::uuid,
  latest.id,
  latest.value,
  now()
FROM latest
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'ui_table_views'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

SELECT pg_advisory_unlock(hashtext('202601091230_ui_table_views_settings_cache'));
COMMIT;

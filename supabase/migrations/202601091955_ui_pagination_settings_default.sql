SELECT pg_advisory_lock(hashtext('202601091955_ui_pagination_settings_default'));

WITH pagination_default AS (
  SELECT id, value
  FROM public.settings_versions
  WHERE category = 'ui_pagination'
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
  'ui_pagination',
  'global',
  NULL::uuid,
  pagination_default.id,
  pagination_default.value,
  now()
FROM pagination_default
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = 'ui_pagination'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

SELECT pg_advisory_unlock(hashtext('202601091955_ui_pagination_settings_default'));

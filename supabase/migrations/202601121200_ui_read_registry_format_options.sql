-- Migration: UI read registry format_options defaults
-- Purpose: Ensure column format_options key exists for ui_read_registry columns.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601121200_ui_read_registry_format_options'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH current AS (
  SELECT s.settings_version_id,
         sv.version,
         sv.value,
         sv.schema_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
resources AS (
  SELECT jsonb_agg(
    jsonb_set(resource, '{columns}', COALESCE(derived.columns, '[]'::jsonb), true)
  ) AS resources
  FROM current,
       jsonb_array_elements(current.value->'resources') AS resource
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(
      CASE
        WHEN col ? 'format_options' THEN col
        ELSE jsonb_set(col, '{format_options}', '{}'::jsonb, true)
      END
    ) AS columns
    FROM jsonb_array_elements(COALESCE(resource->'columns', '[]'::jsonb)) AS col
  ) AS derived
),
updated AS (
  SELECT current.*, jsonb_set(current.value, '{resources}', resources.resources, true) AS next_value
  FROM current, resources
),
applied AS (
  UPDATE public.settings_versions sv
  SET value = updated.next_value,
      version = updated.version + 1,
      change_reason = 'Ensure format_options keys on ui_read_registry columns',
      approved_at = now(),
      effective_from = now()
  FROM updated
  WHERE sv.id = updated.settings_version_id
    AND updated.next_value IS DISTINCT FROM updated.value
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = applied.value,
    last_updated = now()
FROM applied
WHERE s.category = 'ui_read_registry'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND s.settings_version_id = applied.id;

SELECT pg_advisory_unlock(hashtext('202601121200_ui_read_registry_format_options'));
COMMIT;

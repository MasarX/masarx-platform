-- Migration: Normalize ui_read_registry capability_write (no nulls; defaults where applicable)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601291900_ui_read_registry_fix_capability_write_null'));
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
    CASE
      WHEN resource ? 'capability_write'
        AND jsonb_typeof(resource->'capability_write') <> 'string' THEN
        -- Explicit null/non-string means "no write capability" (read-only). Remove the key entirely.
        jsonb_strip_nulls(resource - 'capability_write')
      WHEN NOT (resource ? 'capability_write')
        AND right(resource->>'capability_read', 5) = '.read' THEN
        -- Default write capability to a sibling .write when missing (common convention).
        jsonb_strip_nulls(
          jsonb_set(
            resource,
            '{capability_write}',
            to_jsonb(
              left(resource->>'capability_read', length(resource->>'capability_read') - 5) || '.write'
            ),
            true
          )
        )
      ELSE jsonb_strip_nulls(resource)
    END
  ) AS resources
  FROM current,
    jsonb_array_elements(current.value->'resources') AS resource
),
updated AS (
  SELECT current.*,
         jsonb_set(current.value, '{resources}', resources.resources, true) AS next_value
  FROM current, resources
),
applied AS (
  UPDATE public.settings_versions sv
  SET value = updated.next_value,
      version = updated.version + 1,
      change_reason = 'Normalize ui_read_registry capability_write (remove nulls; fill defaults)',
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

SELECT pg_advisory_unlock(hashtext('202601291900_ui_read_registry_fix_capability_write_null'));
COMMIT;

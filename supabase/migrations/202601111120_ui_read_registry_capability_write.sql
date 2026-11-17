-- Migration: UI read registry capability_write defaults and update RPC grants
BEGIN;
SELECT pg_advisory_lock(hashtext('202601111120_ui_read_registry_capability_write'));
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
      WHEN derived.capability_write IS NOT NULL THEN
        jsonb_set(resource, '{capability_write}', to_jsonb(derived.capability_write), true)
      ELSE resource
    END
  ) AS resources
  FROM current,
    jsonb_array_elements(current.value->'resources') AS resource
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN resource ? 'capability_write' THEN NULL
        WHEN right(resource->>'capability_read', 5) = '.read' THEN
          left(resource->>'capability_read', length(resource->>'capability_read') - 5) || '.write'
        ELSE NULL
      END AS capability_write
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
      change_reason = 'Add capability_write defaults to ui_read_registry',
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

REVOKE EXECUTE ON FUNCTION public.ui_update_resource_v1(TEXT, TEXT, JSONB) FROM anon;

SELECT pg_advisory_unlock(hashtext('202601111120_ui_read_registry_capability_write'));
COMMIT;

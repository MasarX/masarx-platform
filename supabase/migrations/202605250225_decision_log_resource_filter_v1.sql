-- Migration: Console V2 decision log resource filter
-- Purpose: Allow domain panes to read scoped decision rows by resource_id.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605250225_decision_log_resource_filter_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

WITH current_rows AS (
  SELECT
    sv.id AS settings_version_id,
    sv.scope_hash,
    sv.value,
    jsonb_agg(
      CASE
        WHEN resource->>'key' = 'decision_log'
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(resource->'filters', '[]'::jsonb)) filter_row
           WHERE filter_row->>'key' = 'resource_id'
         )
        THEN jsonb_set(
          resource,
          '{filters}',
          COALESCE(resource->'filters', '[]'::jsonb) ||
            jsonb_build_array(jsonb_build_object(
              'key', 'resource_id',
              'column', 'resource_id',
              'op', 'eq'
            )),
          true
        )
        ELSE resource
      END
      ORDER BY ordinality
    ) AS next_resources
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
   AND sv.scope_hash = s.scope_hash
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb))
    WITH ORDINALITY AS resource_rows(resource, ordinality)
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  GROUP BY sv.id, sv.scope_hash, sv.value
),
next_values AS (
  SELECT
    settings_version_id,
    scope_hash,
    jsonb_set(value, '{resources}', next_resources, true) AS next_value
  FROM current_rows
)
UPDATE public.settings_versions sv
SET value = nv.next_value,
    updated_at = now()
FROM next_values nv
WHERE sv.id = nv.settings_version_id
  AND sv.scope_hash = nv.scope_hash
  AND sv.value IS DISTINCT FROM nv.next_value;

UPDATE public.settings s
SET cached_value = sv.value,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.category = 'ui_read_registry'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND sv.id = s.settings_version_id
  AND sv.scope_hash = s.scope_hash
  AND s.cached_value IS DISTINCT FROM sv.value;

SELECT pg_advisory_unlock(hashtext('202605250225_decision_log_resource_filter_v1'));

COMMIT;

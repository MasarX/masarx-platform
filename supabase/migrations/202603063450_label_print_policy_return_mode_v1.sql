-- Migration: label print policy artifact return mode and edge DB mode defaults
-- Purpose:
--   - Make workflow-driven print artifact return mode row-driven (`file_path_only|signed_url`).
--   - Reserve a row-driven edge DB transport gate for later hot-path experiments without hardcoding.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063450_label_print_policy_return_mode_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
SET schema = jsonb_set(
      jsonb_set(
        COALESCE(schema, '{}'::jsonb),
        '{properties,print_sync_bundle_return_mode}',
        jsonb_build_object('type', 'string', 'enum', jsonb_build_array('file_path_only', 'signed_url')),
        true
      ),
      '{properties,edge_db_mode}',
      jsonb_build_object('type', 'string', 'enum', jsonb_build_array('rest_rpc', 'direct_pooler')),
      true
    ),
    updated_at = now()
WHERE category = 'label_print_policy';

WITH current_global AS (
  SELECT settings_version_id
  FROM public.settings
  WHERE category = 'label_print_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY last_updated DESC
  LIMIT 1
),
updated_version AS (
  UPDATE public.settings_versions sv
  SET value = jsonb_strip_nulls(
        COALESCE(sv.value, '{}'::jsonb)
        || jsonb_build_object(
          'print_sync_bundle_return_mode', COALESCE(sv.value->>'print_sync_bundle_return_mode', 'file_path_only'),
          'edge_db_mode', COALESCE(sv.value->>'edge_db_mode', 'rest_rpc')
        )
      ),
      change_reason = 'Add row-driven label print artifact return mode and edge DB mode defaults',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  FROM current_global cg
  WHERE sv.id = cg.settings_version_id
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = uv.value,
    last_updated = workflow_now()
FROM updated_version uv
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND s.settings_version_id = uv.id;

SELECT pg_advisory_unlock(hashtext('202603063450_label_print_policy_return_mode_v1'));
COMMIT;

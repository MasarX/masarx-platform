-- Migration: label_print_policy single-file passthrough knobs
BEGIN;

SET search_path TO public, pg_temp;

UPDATE schema_registry
SET schema = jsonb_set(
      jsonb_set(
        schema,
        '{properties,single_file_passthrough_enabled}',
        jsonb_build_object('type', 'boolean'),
        true
      ),
      '{properties,single_file_passthrough_max_bytes}',
      jsonb_build_object(
        'type', 'integer',
        'minimum', 1024,
        'maximum', 104857600
      ),
      true
    ),
    examples = CASE
      WHEN jsonb_typeof(examples) = 'array' AND jsonb_array_length(examples) > 0 THEN
        jsonb_set(
          jsonb_set(examples, '{0,single_file_passthrough_enabled}', to_jsonb(true), true),
          '{0,single_file_passthrough_max_bytes}', to_jsonb(4194304), true
        )
      ELSE examples
    END,
    description = COALESCE(description, '') ||
      ' Adds single_file_passthrough_enabled and single_file_passthrough_max_bytes for fresh single-label print passthrough optimization.',
    is_active = TRUE,
    created_at = workflow_now()
WHERE category = 'label_print_policy'
  AND version = 1;

WITH current_global AS (
  SELECT settings_version_id
  FROM settings
  WHERE category = 'label_print_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY last_updated DESC
  LIMIT 1
),
updated AS (
  UPDATE settings_versions sv
  SET value = jsonb_set(
        jsonb_set(
          sv.value,
          '{single_file_passthrough_enabled}',
          COALESCE(sv.value->'single_file_passthrough_enabled', to_jsonb(true)),
          true
        ),
        '{single_file_passthrough_max_bytes}',
        COALESCE(sv.value->'single_file_passthrough_max_bytes', to_jsonb(4194304)),
        true
      ),
      change_reason = 'Add label_print_policy single-file passthrough knobs',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  FROM current_global cg
  WHERE sv.id = cg.settings_version_id
  RETURNING sv.value
),
applied AS (
  UPDATE settings s
  SET cached_value = updated.value,
      last_updated = workflow_now()
  FROM updated
  WHERE s.category = 'label_print_policy'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  RETURNING s.id
)
SELECT 'label_print_policy single-file passthrough knobs applied' AS status;

COMMIT;

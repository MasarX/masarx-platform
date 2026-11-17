-- Migration: label_print_policy print_sync bundle strategy
-- Purpose:
--  - Add `print_sync_bundle_strategy` to label_print_policy schema (v1, additive).
--  - Default global policy to `direct` to avoid edge WORKER_LIMIT for large, image-heavy templates.
-- Notes:
--  - Row-driven: tenants/clients/senders can override via settings ladder.
--  - Backwards compatible: only adds an optional key; does not remove/rename existing keys.

BEGIN;

SET search_path TO public, pg_temp;

-- =============================================================================
-- Section 1: Extend schema_registry for label_print_policy (v1, additive)
-- =============================================================================
UPDATE schema_registry
SET schema = jsonb_set(
    schema,
    '{properties,print_sync_bundle_strategy}',
    jsonb_build_object(
      'type',
      'string',
      'enum',
      jsonb_build_array('merge', 'direct')
    ),
    true
  ),
  examples = CASE
    WHEN jsonb_typeof(examples) = 'array' AND jsonb_array_length(examples) > 0 THEN
      jsonb_set(examples, '{0,print_sync_bundle_strategy}', to_jsonb('direct'::text), true)
    ELSE
      examples
  END,
  description = COALESCE(description, '') ||
    ' Adds print_sync_bundle_strategy (merge|direct) to control synchronous rendering strategy.',
  is_active = TRUE,
  created_at = workflow_now()
WHERE category = 'label_print_policy'
  AND version = 1;

-- =============================================================================
-- Section 2: Default global policy to direct bundle print_sync (only when missing)
-- =============================================================================
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
  SET value =
    jsonb_set(
      sv.value,
      '{print_sync_bundle_strategy}',
      COALESCE(sv.value->'print_sync_bundle_strategy', to_jsonb('direct'::text)),
      true
    ),
    change_reason = 'Default print_sync_bundle_strategy=direct to reduce edge compute for large bundles',
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
SELECT 'label_print_policy print_sync_bundle_strategy applied' AS status;

COMMIT;


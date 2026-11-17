-- Migration: label_print_policy print_sync worker grace seconds
-- Purpose:
--  - Add `print_sync_worker_grace_seconds` to label_print_policy schema (v1, additive).
--  - Default global policy to 120s grace for print_sync worker leasing.
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
    '{properties,print_sync_worker_grace_seconds}',
    jsonb_build_object(
      'type',
      'integer',
      'minimum',
      0
    ),
    true
  ),
  examples = CASE
    WHEN jsonb_typeof(examples) = 'array' AND jsonb_array_length(examples) > 0 THEN
      jsonb_set(examples, '{0,print_sync_worker_grace_seconds}', to_jsonb(120), true)
    ELSE
      examples
  END,
  description = COALESCE(description, '') ||
    ' Adds print_sync_worker_grace_seconds (seconds) to delay worker leasing of print_sync jobs.',
  is_active = TRUE,
  created_at = workflow_now()
WHERE category = 'label_print_policy'
  AND version = 1;

-- =============================================================================
-- Section 2: Default global policy to print_sync worker grace (only when missing)
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
      '{print_sync_worker_grace_seconds}',
      COALESCE(sv.value->'print_sync_worker_grace_seconds', to_jsonb(120)),
      true
    ),
    change_reason = 'Add print_sync worker grace window (seconds) for worker leasing',
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
SELECT 'label_print_policy print_sync_worker_grace_seconds applied' AS status;

COMMIT;

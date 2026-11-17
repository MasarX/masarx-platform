-- Migration: Label print policy bundle perf knobs
-- Purpose: Add configuration knobs to label_print_policy for synchronous edge bundling performance.
-- Notes:
--  - Backwards compatible (adds optional keys; defaults applied only when missing).
--  - Keeps schema version = 1 (non-breaking additive update).

BEGIN;

SET search_path TO public, pg_temp;

-- =============================================================================
-- Section 1: Extend schema_registry for label_print_policy (v1, additive)
-- =============================================================================

WITH policy_schema AS (
  SELECT $$
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "label_print_policy.schema.json",
    "title": "label_print_policy",
    "type": "object",
    "required": ["version", "max_labels_per_bundle", "default_expires_seconds"],
    "additionalProperties": false,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "max_labels_per_bundle": { "type": "integer", "minimum": 1 },
      "max_pages_per_bundle": { "type": "integer", "minimum": 1 },
      "max_bytes_per_bundle": { "type": "integer", "minimum": 1024 },
      "default_expires_seconds": { "type": "integer", "minimum": 60 },
      "poll_interval_seconds": { "type": "integer", "minimum": 5 },
      "max_wait_seconds": { "type": "integer", "minimum": 60 },
      "max_failed_labels": { "type": "integer", "minimum": 0 },
      "bundle_download_concurrency": { "type": "integer", "minimum": 1, "maximum": 25 },
      "bundle_chunk_size": { "type": "integer", "minimum": 1, "maximum": 1000 }
    }
  }
  $$::jsonb AS schema_doc,
  $$[
    {
      "version": 1,
      "max_labels_per_bundle": 400,
      "max_pages_per_bundle": 400,
      "max_bytes_per_bundle": 26214400,
      "default_expires_seconds": 900,
      "poll_interval_seconds": 60,
      "max_wait_seconds": 900,
      "max_failed_labels": 10,
      "bundle_download_concurrency": 8,
      "bundle_chunk_size": 100
    }
  ]$$::jsonb AS examples
)
INSERT INTO schema_registry (
  id,
  category,
  version,
  schema,
  description,
  examples,
  is_active,
  created_at
)
SELECT
  'bbbb0000-0000-0000-0000-000000001111',
  'label_print_policy',
  1,
  policy_schema.schema_doc,
  'Governance policy for label print bundling (limits, expirations, wait strategy, performance knobs).',
  policy_schema.examples,
  TRUE,
  workflow_now()
FROM policy_schema
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

-- =============================================================================
-- Section 2: Apply defaults to active global policy (only when missing)
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
      jsonb_set(
        sv.value,
        '{bundle_download_concurrency}',
        COALESCE(sv.value->'bundle_download_concurrency', to_jsonb(8)),
        true
      ),
      '{bundle_chunk_size}',
      COALESCE(sv.value->'bundle_chunk_size', to_jsonb(100)),
      true
    ),
    change_reason = 'Add bundle performance knobs (download_concurrency, chunk_size)',
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
SELECT 'label_print_policy bundle perf knobs applied' AS status;

COMMIT;


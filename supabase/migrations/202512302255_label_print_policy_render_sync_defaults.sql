-- Migration: label_print_policy render sync defaults (batch + calls)
-- Purpose:
--  - Add render_max_calls knob to label_print_policy (schema v1 additive).
--  - Tune global defaults for synchronous rendering to avoid edge timeouts and
--    ensure 100-label bundles complete without leases getting stuck.
-- Notes:
--  - Row-driven: tenants/clients/senders can override via settings ladder.

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
      "bundle_chunk_size": { "type": "integer", "minimum": 1, "maximum": 1000 },
      "render_invoke_enabled": { "type": "boolean" },
      "render_max_jobs": { "type": "integer", "minimum": 1, "maximum": 100 },
      "render_job_concurrency": { "type": "integer", "minimum": 1, "maximum": 10 },
      "render_lease_seconds": { "type": "integer", "minimum": 60, "maximum": 600 },
      "render_max_calls": { "type": "integer", "minimum": 1, "maximum": 50 }
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
      "bundle_download_concurrency": 25,
      "bundle_chunk_size": 100,
      "render_invoke_enabled": true,
      "render_max_jobs": 25,
      "render_job_concurrency": 10,
      "render_lease_seconds": 60,
      "render_max_calls": 20
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
  'Governance policy for label print bundling and synchronous rendering (limits, expirations, wait strategy, performance knobs).',
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
-- Section 2: Tune active global policy defaults (sync render batching)
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
        jsonb_set(
          jsonb_set(
            jsonb_set(
              sv.value,
              '{render_invoke_enabled}',
              to_jsonb(true),
              true
            ),
            '{render_max_jobs}',
            to_jsonb(25),
            true
          ),
          '{render_job_concurrency}',
          to_jsonb(10),
          true
        ),
        '{render_lease_seconds}',
        to_jsonb(60),
        true
      ),
      '{render_max_calls}',
      to_jsonb(20),
      true
    ),
    change_reason = 'Tune label_print_policy render_* defaults for sync batching (max_jobs=25, max_calls=20, lease_seconds=60)',
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
SELECT 'label_print_policy sync render defaults applied' AS status;

COMMIT;


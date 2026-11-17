-- Migration: Increase label_provider timeout_ms for large synchronous batches
-- Purpose:
--  - Allow invoke_label_renderer() / label-renderer edge calls to complete when processing large bundles.
--  - Update only when the active global provider timeout is missing or below 30000ms.

BEGIN;

SET search_path TO public, pg_temp;

WITH current_settings AS (
  SELECT
    s.settings_version_id,
    s.id AS settings_id
  FROM settings s
  WHERE s.category = 'label_provider'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY s.last_updated DESC
  LIMIT 1
),
updated_versions AS (
  UPDATE settings_versions sv
  SET value = jsonb_set(
        sv.value,
        '{providers,0,timeout_ms}',
        to_jsonb(
          GREATEST(
            COALESCE(NULLIF((sv.value->'providers'->0->>'timeout_ms'), '')::INT, 0),
            30000
          )
        ),
        TRUE
      ),
      change_reason = 'Raise label_provider.providers[0].timeout_ms to 30000 (sync label batches)',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  WHERE sv.id IN (SELECT settings_version_id FROM current_settings)
    AND (
      (sv.value->'providers'->0->>'timeout_ms') IS NULL
      OR COALESCE(NULLIF((sv.value->'providers'->0->>'timeout_ms'), '')::INT, 0) < 30000
    )
  RETURNING sv.id, sv.value
),
effective_versions AS (
  SELECT * FROM updated_versions
),
applied AS (
  UPDATE settings s
  SET cached_value = ev.value,
      last_updated = workflow_now()
  FROM effective_versions ev
  WHERE s.category = 'label_provider'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
)
SELECT 'label_provider timeout_ms updated' AS status;

COMMIT;


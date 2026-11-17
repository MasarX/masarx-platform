-- Migration: label_print_policy fresh generation + compact sync + quick poll knobs
-- Purpose:
--  - Add row-driven knobs for print freshness and low-latency bundle polling.
--  - Keep defaults fail-closed for freshness while allowing scoped overrides.

BEGIN;

SET search_path TO public, pg_temp;

UPDATE schema_registry
SET schema = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            schema,
            '{properties,quick_poll_attempts}',
            jsonb_build_object(
              'type', 'integer',
              'minimum', 0,
              'maximum', 20
            ),
            true
          ),
          '{properties,quick_poll_interval_ms}',
          jsonb_build_object(
            'type', 'integer',
            'minimum', 25,
            'maximum', 2000
          ),
          true
        ),
        '{properties,fresh_generation_required}',
        jsonb_build_object('type', 'boolean'),
        true
      ),
      '{properties,print_sync_compact_enabled}',
      jsonb_build_object('type', 'boolean'),
      true
    ),
    examples = CASE
      WHEN jsonb_typeof(examples) = 'array' AND jsonb_array_length(examples) > 0 THEN
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(examples, '{0,quick_poll_attempts}', to_jsonb(3), true),
              '{0,quick_poll_interval_ms}', to_jsonb(75), true
            ),
            '{0,fresh_generation_required}', to_jsonb(true), true
          ),
          '{0,print_sync_compact_enabled}', to_jsonb(true), true
        )
      ELSE examples
    END,
    description = COALESCE(description, '') ||
      ' Adds quick_poll_attempts/quick_poll_interval_ms for bundle quick rechecks, fresh_generation_required for per-click new labels, and print_sync_compact_enabled for compact direct print path.',
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
          jsonb_set(
            jsonb_set(
              sv.value,
              '{quick_poll_attempts}',
              COALESCE(sv.value->'quick_poll_attempts', to_jsonb(3)),
              true
            ),
            '{quick_poll_interval_ms}',
            COALESCE(sv.value->'quick_poll_interval_ms', to_jsonb(75)),
            true
          ),
          '{fresh_generation_required}',
          COALESCE(sv.value->'fresh_generation_required', to_jsonb(true)),
          true
        ),
        '{print_sync_compact_enabled}',
        COALESCE(sv.value->'print_sync_compact_enabled', to_jsonb(true)),
        true
      ),
      change_reason = 'Add label_print_policy quick poll + fresh generation + compact sync knobs',
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
SELECT 'label_print_policy fresh/compact/quick-poll knobs applied' AS status;

COMMIT;

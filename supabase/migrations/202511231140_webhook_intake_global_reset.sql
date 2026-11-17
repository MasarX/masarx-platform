-- Migration: Reset global webhook_intake entry template to null
-- Purpose: maintain dynamic intake defaults without hardcoding template IDs.

BEGIN;

SET search_path TO public;

UPDATE settings_versions
SET value = jsonb_set(
        COALESCE(value, '{}'::jsonb),
        '{entry_template_id}',
        'null'::jsonb,
        TRUE
    )
WHERE category = 'webhook_intake'
  AND scope_type = 'global'
  AND scope_id IS NULL;

UPDATE settings
SET cached_value = jsonb_set(
        COALESCE(cached_value, '{}'::jsonb),
        '{entry_template_id}',
        'null'::jsonb,
        TRUE
    )
WHERE category = 'webhook_intake'
  AND scope_type = 'global'
  AND scope_id IS NULL;

COMMIT;

-- Migration: Webhook intake defaults seed fix
-- Purpose:
--   Ensure the global webhook_intake settings row always includes a complete
--   defaults block so resolve_webhook_intake_defaults() never fails for
--   seeded organizations. This is a fix-up on top of
--   202511231205_webhook_intake_dynamic_defaults.sql and is safe to apply
--   multiple times.

BEGIN;

SET search_path TO public;

WITH existing AS (
    SELECT
        sv.id AS settings_version_id,
        s.id  AS settings_id
    FROM settings_versions sv
    JOIN settings s
      ON s.settings_version_id = sv.id
     AND s.category = sv.category
     AND s.scope_type = sv.scope_type
     AND (s.scope_id IS NOT DISTINCT FROM sv.scope_id)
    WHERE sv.category = 'webhook_intake'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
    LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls(
        COALESCE(sv.value, '{}'::jsonb)
        || jsonb_build_object(
            'defaults',
            jsonb_build_object(
                'accepted_async_status', 202,
                'synchronous_success_status', 200,
                'bad_request_status', 400,
                'error_status', 500,
                'poll_attempts', 5,
                'poll_interval_ms', 50
            )
        )
    )
FROM existing e
WHERE sv.id = e.settings_version_id;

WITH existing AS (
    SELECT
        sv.id AS settings_version_id,
        s.id  AS settings_id
    FROM settings_versions sv
    JOIN settings s
      ON s.settings_version_id = sv.id
     AND s.category = sv.category
     AND s.scope_type = sv.scope_type
     AND (s.scope_id IS NOT DISTINCT FROM sv.scope_id)
    WHERE sv.category = 'webhook_intake'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
    LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls(
        COALESCE(s.cached_value, '{}'::jsonb)
        || jsonb_build_object(
            'defaults',
            jsonb_build_object(
                'accepted_async_status', 202,
                'synchronous_success_status', 200,
                'bad_request_status', 400,
                'error_status', 500,
                'poll_attempts', 5,
                'poll_interval_ms', 50
            )
        )
    ),
    last_updated = now()
FROM existing e
WHERE s.id = e.settings_id;

COMMIT;


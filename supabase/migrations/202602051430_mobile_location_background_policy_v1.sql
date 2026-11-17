-- Plan: PLAN-202602-fieldops-mobile-store-ga-v2 / Step: S04
-- Migration: Mobile location background policy extension v1
-- Date: 2026-02-05
--
-- Goal:
--   - Extend location_tracking_policy schema/defaults with background-tracking controls.
--   - Keep mobile background behavior fully row-driven via settings ladder.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602051430_mobile_location_background_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Extend location_tracking_policy schema v1 (non-breaking additive fields)
-------------------------------------------------------------------------------

UPDATE public.schema_registry
SET
  schema = jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Location Tracking Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'min_interval_seconds', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
      'min_accuracy_m', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
      'max_accuracy_m', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
      'retention_days', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
      'background_enabled', jsonb_build_object('type', jsonb_build_array('boolean','null')),
      'request_background_permission', jsonb_build_object('type', jsonb_build_array('boolean','null')),
      'background_distance_interval_m', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
      'background_time_interval_ms', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
      'background_deferred_updates_interval_ms', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0),
      'background_shows_indicator', jsonb_build_object('type', jsonb_build_array('boolean','null')),
      'background_pauses_updates_automatically', jsonb_build_object('type', jsonb_build_array('boolean','null')),
      'background_notification_title', jsonb_build_object('type', jsonb_build_array('string','null')),
      'background_notification_body', jsonb_build_object('type', jsonb_build_array('string','null')),
      'foreground_accuracy', jsonb_build_object(
        'type', jsonb_build_array('string','null'),
        'enum', jsonb_build_array('lowest','low','balanced','high','highest', NULL)
      ),
      'background_accuracy', jsonb_build_object(
        'type', jsonb_build_array('string','null'),
        'enum', jsonb_build_array('lowest','low','balanced','high','highest', NULL)
      )
    )
  ),
  examples = jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'min_interval_seconds', 15,
      'max_accuracy_m', 200,
      'background_enabled', FALSE,
      'request_background_permission', TRUE,
      'background_distance_interval_m', 50,
      'background_time_interval_ms', 60000,
      'background_deferred_updates_interval_ms', 60000,
      'background_shows_indicator', FALSE,
      'background_pauses_updates_automatically', TRUE,
      'background_notification_title', 'Fieldops location tracking',
      'background_notification_body', 'Fieldops captures location updates for operational tasks.',
      'foreground_accuracy', 'balanced',
      'background_accuracy', 'balanced'
    )
  ),
  updated_at = now()
WHERE category = 'location_tracking_policy'
  AND version = 1;

-------------------------------------------------------------------------------
-- 2) Ensure global default exists (if missing)
-------------------------------------------------------------------------------

WITH tracking_default AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'min_interval_seconds', 15,
    'max_accuracy_m', 200,
    'background_enabled', FALSE,
    'request_background_permission', TRUE,
    'background_distance_interval_m', 50,
    'background_time_interval_ms', 60000,
    'background_deferred_updates_interval_ms', 60000,
    'background_shows_indicator', FALSE,
    'background_pauses_updates_automatically', TRUE,
    'background_notification_title', 'Fieldops location tracking',
    'background_notification_body', 'Fieldops captures location updates for operational tasks.',
    'foreground_accuracy', 'balanced',
    'background_accuracy', 'balanced'
  ) AS body
),
inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'location_tracking_policy', 'global', NULL, 1, tracking_default.body, 1, now()
  FROM tracking_default
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'location_tracking_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
      AND sv.effective_until IS NULL
  )
  ON CONFLICT DO NOTHING
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'location_tracking_policy', 'global', NULL, inserted.id, inserted.value, now()
FROM inserted
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = 'location_tracking_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

-------------------------------------------------------------------------------
-- 3) Add missing keys to existing active global default rows (non-destructive)
-------------------------------------------------------------------------------

UPDATE public.settings_versions sv
SET value =
  sv.value
  || CASE WHEN sv.value ? 'background_enabled' THEN '{}'::jsonb ELSE jsonb_build_object('background_enabled', FALSE) END
  || CASE WHEN sv.value ? 'request_background_permission' THEN '{}'::jsonb ELSE jsonb_build_object('request_background_permission', TRUE) END
  || CASE WHEN sv.value ? 'background_distance_interval_m' THEN '{}'::jsonb ELSE jsonb_build_object('background_distance_interval_m', 50) END
  || CASE WHEN sv.value ? 'background_time_interval_ms' THEN '{}'::jsonb ELSE jsonb_build_object('background_time_interval_ms', 60000) END
  || CASE WHEN sv.value ? 'background_deferred_updates_interval_ms' THEN '{}'::jsonb ELSE jsonb_build_object('background_deferred_updates_interval_ms', 60000) END
  || CASE WHEN sv.value ? 'background_shows_indicator' THEN '{}'::jsonb ELSE jsonb_build_object('background_shows_indicator', FALSE) END
  || CASE WHEN sv.value ? 'background_pauses_updates_automatically' THEN '{}'::jsonb ELSE jsonb_build_object('background_pauses_updates_automatically', TRUE) END
  || CASE WHEN sv.value ? 'background_notification_title' THEN '{}'::jsonb ELSE jsonb_build_object('background_notification_title', 'Fieldops location tracking') END
  || CASE WHEN sv.value ? 'background_notification_body' THEN '{}'::jsonb ELSE jsonb_build_object('background_notification_body', 'Fieldops captures location updates for operational tasks.') END
  || CASE WHEN sv.value ? 'foreground_accuracy' THEN '{}'::jsonb ELSE jsonb_build_object('foreground_accuracy', 'balanced') END
  || CASE WHEN sv.value ? 'background_accuracy' THEN '{}'::jsonb ELSE jsonb_build_object('background_accuracy', 'balanced') END
WHERE sv.category = 'location_tracking_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND sv.effective_until IS NULL;

UPDATE public.settings s
SET cached_value =
  s.cached_value
  || CASE WHEN s.cached_value ? 'background_enabled' THEN '{}'::jsonb ELSE jsonb_build_object('background_enabled', FALSE) END
  || CASE WHEN s.cached_value ? 'request_background_permission' THEN '{}'::jsonb ELSE jsonb_build_object('request_background_permission', TRUE) END
  || CASE WHEN s.cached_value ? 'background_distance_interval_m' THEN '{}'::jsonb ELSE jsonb_build_object('background_distance_interval_m', 50) END
  || CASE WHEN s.cached_value ? 'background_time_interval_ms' THEN '{}'::jsonb ELSE jsonb_build_object('background_time_interval_ms', 60000) END
  || CASE WHEN s.cached_value ? 'background_deferred_updates_interval_ms' THEN '{}'::jsonb ELSE jsonb_build_object('background_deferred_updates_interval_ms', 60000) END
  || CASE WHEN s.cached_value ? 'background_shows_indicator' THEN '{}'::jsonb ELSE jsonb_build_object('background_shows_indicator', FALSE) END
  || CASE WHEN s.cached_value ? 'background_pauses_updates_automatically' THEN '{}'::jsonb ELSE jsonb_build_object('background_pauses_updates_automatically', TRUE) END
  || CASE WHEN s.cached_value ? 'background_notification_title' THEN '{}'::jsonb ELSE jsonb_build_object('background_notification_title', 'Fieldops location tracking') END
  || CASE WHEN s.cached_value ? 'background_notification_body' THEN '{}'::jsonb ELSE jsonb_build_object('background_notification_body', 'Fieldops captures location updates for operational tasks.') END
  || CASE WHEN s.cached_value ? 'foreground_accuracy' THEN '{}'::jsonb ELSE jsonb_build_object('foreground_accuracy', 'balanced') END
  || CASE WHEN s.cached_value ? 'background_accuracy' THEN '{}'::jsonb ELSE jsonb_build_object('background_accuracy', 'balanced') END,
  last_updated = now()
WHERE s.category = 'location_tracking_policy'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL;

SELECT pg_advisory_unlock(hashtext('202602051430_mobile_location_background_policy_v1'));
COMMIT;

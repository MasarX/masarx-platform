-- Test Suite: Mobile location background policy extension
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

SELECT has_function(
  'public',
  'resolve_location_tracking_policy',
  ARRAY['jsonb'],
  'resolve_location_tracking_policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'location_tracking_policy'
      AND requires_schema
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
  ),
  'location_tracking_policy category remains registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'location_tracking_policy'
      AND version = 1
      AND is_active
  ),
  'location_tracking_policy schema v1 active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'location_tracking_policy'
      AND version = 1
      AND schema->'properties' ? 'background_enabled'
      AND schema->'properties' ? 'request_background_permission'
      AND schema->'properties' ? 'background_distance_interval_m'
      AND schema->'properties' ? 'background_time_interval_ms'
      AND schema->'properties' ? 'background_notification_title'
      AND schema->'properties' ? 'background_notification_body'
      AND schema->'properties' ? 'foreground_accuracy'
      AND schema->'properties' ? 'background_accuracy'
  ),
  'location_tracking_policy schema includes background tracking fields'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'location_tracking_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND value ? 'background_enabled'
      AND value ? 'request_background_permission'
      AND value ? 'background_distance_interval_m'
      AND value ? 'background_time_interval_ms'
      AND value ? 'background_notification_title'
      AND value ? 'background_notification_body'
      AND value ? 'foreground_accuracy'
      AND value ? 'background_accuracy'
  ),
  'location_tracking_policy global settings_versions row has background defaults'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'location_tracking_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'background_enabled'
      AND cached_value ? 'request_background_permission'
      AND cached_value ? 'background_distance_interval_m'
      AND cached_value ? 'background_time_interval_ms'
      AND cached_value ? 'background_notification_title'
      AND cached_value ? 'background_notification_body'
      AND cached_value ? 'foreground_accuracy'
      AND cached_value ? 'background_accuracy'
  ),
  'location_tracking_policy settings cache has background defaults'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'location_tracking_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND jsonb_typeof(cached_value->'background_enabled') = 'boolean'
      AND jsonb_typeof(cached_value->'request_background_permission') = 'boolean'
      AND jsonb_typeof(cached_value->'background_distance_interval_m') = 'number'
      AND jsonb_typeof(cached_value->'background_time_interval_ms') = 'number'
      AND jsonb_typeof(cached_value->'background_notification_title') = 'string'
      AND jsonb_typeof(cached_value->'background_notification_body') = 'string'
      AND jsonb_typeof(cached_value->'foreground_accuracy') = 'string'
      AND jsonb_typeof(cached_value->'background_accuracy') = 'string'
  ),
  'location_tracking_policy cached background defaults have expected JSON types'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_location_tracking_policy(jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute resolve_location_tracking_policy'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_location_tracking_policy(jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute resolve_location_tracking_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'location_tracking_policy'
      AND version = 1
      AND examples @> jsonb_build_array(jsonb_build_object('background_enabled', FALSE))
  ),
  'location_tracking_policy examples document background defaults'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'location_tracking_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND (cached_value->>'background_notification_title') IS NOT NULL
      AND (cached_value->>'background_notification_body') IS NOT NULL
  ),
  'location_tracking_policy includes notification copy for android foreground service'
);

SELECT finish();

ROLLBACK;

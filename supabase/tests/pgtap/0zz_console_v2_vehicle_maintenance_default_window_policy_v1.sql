BEGIN;

SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'vehicle_maintenance_default_window'
       AND requires_schema
       AND requires_global_default
       AND safe_missing_behavior = 'hard_fail'
       AND allowed_scopes ? 'global'
  ),
  'vehicle_maintenance_default_window settings category is registered hard-fail'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'vehicle_maintenance_default_window'
       AND version = 1
       AND is_active
       AND schema ? 'required'
  ),
  'vehicle_maintenance_default_window schema contract is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'vehicle_maintenance_default_window'
       AND scope_type = 'global'
       AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
       AND value ? 'default_offset_hours'
       AND value ? 'default_window_start'
       AND value ? 'default_window_end'
  ),
  'global active vehicle maintenance default window contains all required keys'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'vehicle_maintenance_default_window'
       AND scope_type = 'global'
       AND cached_value ? 'default_offset_hours'
       AND cached_value ? 'default_window_start'
       AND cached_value ? 'default_window_end'
  ),
  'settings cached value exposes complete vehicle maintenance default window'
);

SELECT ok(
  (
    SELECT (value->>'default_window_start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      FROM public.resolve_settings_row_from_policy_context_v1(
        'vehicle_maintenance_default_window',
        '{}'::jsonb
      )
     LIMIT 1
  ),
  'public resolver returns a valid default_window_start'
);

SELECT ok(
  (
    SELECT (value->>'default_window_end') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      FROM public.resolve_settings_row_from_policy_context_v1(
        'vehicle_maintenance_default_window',
        '{}'::jsonb
      )
     LIMIT 1
  ),
  'public resolver returns a valid default_window_end'
);

SELECT ok(
  (
    SELECT (value ? 'default_window_start') AND (value ? 'default_window_end')
      FROM api.resolve_settings_row_from_policy_context_v1(
        'vehicle_maintenance_default_window',
        '{}'::jsonb
      )
     LIMIT 1
  ),
  'api resolver exposes the vehicle maintenance default window to browser clients'
);

SELECT * FROM finish();

ROLLBACK;

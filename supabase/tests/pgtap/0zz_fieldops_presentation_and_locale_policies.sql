BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(19);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_category_registry c USING (category)
      JOIN public.schema_registry r ON r.category = s.category AND r.version = 1 AND r.is_active
     WHERE s.category = p.category AND s.scope_type = 'global' AND s.scope_id IS NULL
       AND c.allowed_scopes = '["global","tenant"]'::jsonb
       AND s.cached_value->'version' = '1'::jsonb
  )
  AND has_function_privilege('authenticated', 'api.resolve_' || p.category || '()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_' || p.category || '()', 'EXECUTE'),
  p.category || ' has a versioned default and an authenticated resolver'
)
FROM unnest(ARRAY[
  'priority_display_policy', 'list_filter_policy', 'list_sort_policy', 'motion_token_policy',
  'haptic_event_policy', 'audio_cue_policy', 'primary_module_order_policy', 'brand_hero_policy',
  'prayer_time_policy', 'ramadan_mode_policy', 'currency_precision_policy', 'hijri_calendar_policy',
  'weekend_calendar_policy', 'address_landmark_policy', 'numeral_system_policy', 'sunlight_mode_policy'
]) AS p(category);

SELECT is(
  (SELECT cached_value #>> '{currencies,KWD,decimals}' FROM public.settings WHERE category = 'currency_precision_policy' AND scope_type = 'global' AND scope_id IS NULL),
  '3', 'currency presentation preserves three decimal places for KWD'
);
SELECT is(
  (SELECT cached_value #>> '{duration,instant}' FROM public.settings WHERE category = 'motion_token_policy' AND scope_type = 'global' AND scope_id IS NULL),
  '0', 'motion policy keeps an instantaneous duration'
);
SELECT is(
  (SELECT cached_value #>> '{auto_switch,enabled}' FROM public.settings WHERE category = 'sunlight_mode_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'false', 'sunlight mode does not auto-switch by default'
);

SELECT * FROM finish();
ROLLBACK;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_function(
  'public',
  'console_v2_address_policy_sa_capture_v1',
  ARRAY['jsonb'],
  'Console V2 address policy normalizer exists'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'address_policy'
      AND sv.effective_until IS NULL
      AND COALESCE(sv.value->>'country_default', '') <> 'SA'
  ),
  'active address_policy rows declare SA as country default'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'address_policy'
      AND sv.effective_until IS NULL
      AND NOT (
        COALESCE(sv.value->'capture_modes', '[]'::jsonb) ? 'short_national_address'
        AND COALESCE(sv.value->'capture_modes', '[]'::jsonb) ? 'coordinates'
        AND COALESCE(sv.value->'capture_modes', '[]'::jsonb) ? 'free_text'
      )
  ),
  'active address_policy rows expose short national address, coordinates, and free-text capture modes'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'address_policy'
      AND sv.effective_until IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(sv.value->'fields', '[]'::jsonb)) field(value)
        WHERE field.value->>'key' = 'sa_short_code'
          AND field.value->>'label' = 'Saudi short national address'
      )
  ),
  'active address_policy rows expose the Saudi short national address field'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'address_policy'
      AND sv.effective_until IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(sv.value->'fields', '[]'::jsonb)) field(value)
        WHERE field.value->>'key' = 'coordinates'
      )
  ),
  'active address_policy rows expose coordinate capture field'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'address_policy'
      AND sv.effective_until IS NULL
      AND (
        COALESCE((sv.value #>> '{coordinate_capture,accept_provided}')::boolean, FALSE) IS DISTINCT FROM TRUE
        OR sv.value #>> '{coordinate_capture,validate_bounds_country}' IS DISTINCT FROM 'SA'
        OR COALESCE((sv.value #>> '{coordinate_capture,manual_review_on_out_of_bounds}')::boolean, FALSE) IS DISTINCT FROM TRUE
      )
  ),
  'active address_policy rows require SA bounds validation and manual review on out-of-bounds coordinates'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
    WHERE sv.category = 'address_policy'
      AND sv.effective_until IS NULL
      AND s.cached_value IS DISTINCT FROM sv.value
  ),
  'settings cache mirrors active address_policy rows'
);

SELECT ok(
  public.console_v2_address_policy_sa_capture_v1(
    jsonb_build_object(
      'fields',
      jsonb_build_array(
        jsonb_build_object('key', 'address', 'label', 'Address', 'required', true),
        jsonb_build_object('key', 'building_number', 'label', 'Building', 'required', false)
      )
    )
  ) @> jsonb_build_object(
    'country_default', 'SA',
    'capture_modes', jsonb_build_array('short_national_address', 'coordinates', 'free_text'),
    'coordinate_capture', jsonb_build_object(
      'accept_provided', TRUE,
      'validate_bounds_country', 'SA',
      'manual_review_on_out_of_bounds', TRUE
    )
  ),
  'normalizer adds required Saudi address capture policy values'
);

SELECT finish();

ROLLBACK;

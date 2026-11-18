-- Migration: Console V2 Saudi address capture policy default
-- Purpose:
--   First-tenant Console V2 map/geocoding workflows must expose Saudi short
--   national address and coordinate capture from address_policy rows, not from
--   frontend literals. This normalizes active address_policy rows while keeping
--   additional tenant-defined fields intact.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606031830_console_v2_address_policy_sa_capture_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.console_v2_address_policy_sa_capture_v1(
  p_policy JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH base AS (
    SELECT COALESCE(p_policy, '{}'::jsonb) AS value
  ),
  existing_fields AS (
    SELECT COALESCE(
      (
        SELECT jsonb_agg(field.value)
        FROM base
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(base.value->'fields') = 'array' THEN base.value->'fields'
            ELSE '[]'::jsonb
          END
        ) AS field(value)
        WHERE COALESCE(field.value->>'key', field.value->>'name', '') NOT IN (
          'address',
          'sa_short_code',
          'coordinates'
        )
      ),
      '[]'::jsonb
    ) AS fields
  ),
  required_fields AS (
    SELECT jsonb_build_array(
      jsonb_build_object('key', 'address', 'label', 'Address', 'required', TRUE),
      jsonb_build_object(
        'key', 'sa_short_code',
        'label', 'Saudi short national address',
        'required', FALSE
      ),
      jsonb_build_object('key', 'coordinates', 'label', 'Coordinates', 'required', FALSE)
    ) AS fields
  ),
  patch AS (
    SELECT jsonb_build_object(
      'version', 1,
      'country_default', 'SA',
      'capture_modes', jsonb_build_array(
        'short_national_address',
        'coordinates',
        'free_text'
      ),
      'fields', existing_fields.fields || required_fields.fields,
      'show_coordinates', TRUE,
      'show_accuracy', TRUE,
      'coordinate_capture', jsonb_build_object(
        'accept_provided', TRUE,
        'validate_bounds_country', 'SA',
        'manual_review_on_out_of_bounds', TRUE
      )
    ) AS value
    FROM existing_fields, required_fields
  )
  SELECT base.value || patch.value
  FROM base, patch;
$function$;

WITH patched AS (
  UPDATE public.settings_versions sv
     SET value = public.console_v2_address_policy_sa_capture_v1(sv.value),
         change_reason = COALESCE(NULLIF(sv.change_reason, ''), 'address_policy')
           || '; Console V2 Saudi short address and coordinate capture default'
   WHERE sv.category = 'address_policy'
     AND sv.effective_until IS NULL
     AND sv.value IS DISTINCT FROM public.console_v2_address_policy_sa_capture_v1(sv.value)
   RETURNING sv.id, sv.scope_hash, sv.value
)
UPDATE public.settings s
   SET cached_value = p.value,
       last_updated = now()
  FROM patched p
 WHERE s.settings_version_id = p.id
   AND s.scope_hash = p.scope_hash
   AND s.category = 'address_policy';

UPDATE public.settings s
   SET cached_value = public.console_v2_address_policy_sa_capture_v1(s.cached_value),
       last_updated = now()
 WHERE s.category = 'address_policy'
   AND s.cached_value IS DISTINCT FROM public.console_v2_address_policy_sa_capture_v1(s.cached_value);

REVOKE ALL ON FUNCTION public.console_v2_address_policy_sa_capture_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_v2_address_policy_sa_capture_v1(JSONB) TO service_role;

COMMENT ON FUNCTION public.console_v2_address_policy_sa_capture_v1(JSONB) IS
  'Normalizes address_policy for Console V2 first-tenant map/geocoding workflows: Saudi short national address, coordinate capture, SA bounds validation, and manual review on out-of-bounds coordinates.';

COMMENT ON COLUMN public.settings_versions.value IS
  'Configuration value as JSON. Console map/geocoding surfaces require address_policy capture modes for Saudi short national address and coordinates, plus map_policy tile/provider settings and geocoding_policy resolver settings.';

SELECT pg_advisory_unlock(hashtext('202606031830_console_v2_address_policy_sa_capture_v1'));
COMMIT;

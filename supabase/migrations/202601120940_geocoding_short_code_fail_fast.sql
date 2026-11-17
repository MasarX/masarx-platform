-- Migration: Short-code reverse geocode fail-fast
-- Purpose:
--   - Ensure short-code reverse geocode always runs and fails fast on provider errors.
--   - Keep policy-driven behavior by patching geocoding_policy matching_plugins params.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-12
BEGIN;
SET search_path TO public, extensions, pg_temp;

WITH targets AS (
  SELECT
    sv.id AS settings_version_id,
    sv.value AS policy,
    s.id AS settings_id
  FROM public.settings_versions sv
  JOIN public.settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'geocoding_policy'
),
patched AS (
  SELECT
    settings_version_id,
    settings_id,
    CASE
      WHEN policy ? 'matching_plugins' THEN
        jsonb_set(
          policy,
          '{matching_plugins}',
          COALESCE((
            SELECT jsonb_agg(
              CASE
                WHEN lower(elem->>'name') = 'short_code' THEN
                  jsonb_set(
                    elem,
                    '{params}',
                    jsonb_set(
                      jsonb_set(
                        COALESCE(elem->'params', '{}'::jsonb),
                        '{reverse_geocode_on_hit}',
                        'true'::jsonb,
                        TRUE
                      ),
                      '{fail_on_reverse_error}',
                      'true'::jsonb,
                      TRUE
                    ),
                    TRUE
                  )
                ELSE elem
              END
            )
            FROM jsonb_array_elements(COALESCE(policy->'matching_plugins', '[]'::jsonb)) AS elem
          ), policy->'matching_plugins'),
          TRUE
        )
      ELSE policy
    END AS patched_policy
  FROM targets
)
UPDATE public.settings_versions sv
SET value = p.patched_policy,
    change_reason = COALESCE(sv.change_reason, '') || ' + short_code reverse fail-fast'
FROM patched p
WHERE sv.id = p.settings_version_id
  AND sv.value IS DISTINCT FROM p.patched_policy;

WITH latest AS (
  SELECT
    s.id AS settings_id,
    sv.value AS policy
  FROM public.settings_versions sv
  JOIN public.settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'geocoding_policy'
)
UPDATE public.settings s
SET cached_value = latest.policy,
    last_updated = now()
FROM latest
WHERE s.id = latest.settings_id;

COMMIT;

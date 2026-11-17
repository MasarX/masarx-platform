-- Migration: Ensure short_code plugin exists across all active geocoding_policy scopes
-- Purpose:
--   resolve_settings returns the most-specific geocoding_policy (sender/client/tenant/global) without merging.
--   To make Saudi short-code support truly system-wide, patch every *active* geocoding_policy (settings row)
--   so the short_code plugin exists unless explicitly configured otherwise.
--   Also ensures HERE hints + registry TTL params are present for the plugin (row-driven defaults).
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - ZERO HARD CODING - workflow-driven - SSOT.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH scoped AS (
  SELECT
    s.id AS settings_id,
    sv.id AS settings_version_id,
    sv.value AS policy
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'geocoding_policy'
),
patched AS (
  SELECT
    settings_id,
    settings_version_id,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(policy->'matching_plugins', '[]'::jsonb)) elem
        WHERE lower(elem->>'name') = 'short_code'
      ) THEN
        jsonb_set(
          policy,
          '{matching_plugins}',
          (
            SELECT jsonb_agg(
              CASE
                WHEN lower(elem->>'name') = 'short_code' THEN
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        elem,
                        '{params,here_in}',
                        to_jsonb(COALESCE(NULLIF(elem->'params'->>'here_in', ''), 'countryCode:SAU')),
                        TRUE
                      ),
                      '{params,here_types}',
                      to_jsonb(COALESCE(NULLIF(elem->'params'->>'here_types', ''), 'address')),
                      TRUE
                    ),
                    '{params,registry_ttl_minutes}',
                    to_jsonb(
                      CASE
                        WHEN COALESCE(elem->'params'->>'registry_ttl_minutes', '') ~ '^[0-9]+$' THEN (elem->'params'->>'registry_ttl_minutes')::INT
                        ELSE 0
                      END
                    ),
                    TRUE
                  )
                ELSE elem
              END
              ORDER BY ordinality
            )
            FROM jsonb_array_elements(COALESCE(policy->'matching_plugins', '[]'::jsonb)) WITH ORDINALITY AS a(elem, ordinality)
          ),
          TRUE
        )
      ELSE
        jsonb_set(
          policy,
          '{matching_plugins}',
          COALESCE(policy->'matching_plugins', '[]'::jsonb) || jsonb_build_array(
            jsonb_build_object(
              'name', 'short_code',
              'enabled', true,
              'params', jsonb_build_object(
                'code_type', 'sa_short_code',
                'country', 'SA',
                'code_regex', '^[A-Z]{4}[0-9]{4}$',
                'hydrate_address', true,
                'confidence', 0.99,
                'here_in', 'countryCode:SAU',
                'here_types', 'address',
                'registry_ttl_minutes', 0
              )
            )
          ),
          TRUE
        )
    END AS patched_policy
  FROM scoped
),
updated_versions AS (
  UPDATE public.settings_versions sv
  SET value = p.patched_policy,
      change_reason = COALESCE(sv.change_reason, '') || ' + ensure short_code plugin'
  FROM patched p
  WHERE sv.id = p.settings_version_id
    AND sv.value IS DISTINCT FROM p.patched_policy
  RETURNING sv.id
)
UPDATE public.settings s
SET cached_value = sv.value,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.settings_version_id = sv.id
  AND s.category = 'geocoding_policy'
  AND (
    sv.id IN (SELECT id FROM updated_versions)
    OR s.cached_value IS DISTINCT FROM sv.value
  );

COMMIT;

-- Migration: Geocoding policy default reverse_local plugin
-- Purpose: Make reverse_local explicit in global geocoding_policy.matching_plugins (avoid implicit code defaults).
-- Alignment: Row-driven policy, dynamic, no tenant hardcoding.
-- Date: 2025-12-14

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH base AS (
  SELECT
    sv.id AS settings_version_id,
    sv.value AS policy,
    s.id AS settings_id
  FROM public.settings_versions sv
  JOIN public.settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'geocoding_policy'
    AND sv.scope_type = 'global'
  ORDER BY sv.version DESC
  LIMIT 1
),
patched AS (
  SELECT
    settings_version_id,
    settings_id,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(policy->'matching_plugins', '[]'::jsonb)) elem
        WHERE lower(elem->>'name') = 'reverse_local'
      ) THEN policy
      ELSE jsonb_set(
        policy,
        '{matching_plugins}',
        COALESCE(policy->'matching_plugins', '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object(
            'name', 'reverse_local',
            'enabled', true,
            'params', jsonb_build_object(
              'confidence', 0.99
            )
          )
        ),
        true
      )
    END AS patched_policy
  FROM base
)
UPDATE public.settings_versions sv
SET value = p.patched_policy,
    change_reason = COALESCE(sv.change_reason, '') || ' + add reverse_local plugin'
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
    AND sv.scope_type = 'global'
  ORDER BY sv.version DESC
  LIMIT 1
)
UPDATE public.settings s
SET cached_value = latest.policy,
    last_updated = now()
FROM latest
WHERE s.id = latest.settings_id;

COMMIT;


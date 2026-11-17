-- Migration: Geocoding policy matching_plugins + logging knobs
-- Purpose: Add row-driven plugin config for perfect/fuzzy/long_line/reverse matching, logging toggles, and long-line heuristics.
-- Alignment: SIMPLE/SCALABLE/DYNAMIC, zero hardcoding. All behavior is policy-driven.

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH base AS (
  SELECT
    sv.id AS settings_version_id,
    sv.value AS policy,
    s.id AS settings_id
  FROM settings_versions sv
  JOIN settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'geocoding_policy'
    AND sv.scope_type = 'global'
  ORDER BY sv.version DESC
  LIMIT 1
),
patched AS (
  SELECT
    settings_version_id,
    jsonb_strip_nulls(
      policy
      || jsonb_build_object(
        'matching_plugins', COALESCE(
          policy->'matching_plugins',
          jsonb_build_array(
            jsonb_build_object(
              'name','perfect',
              'enabled',true,
              'params', jsonb_build_object('province_gate',true)
            ),
            jsonb_build_object(
              'name','fuzzy',
              'enabled',true,
              'params', jsonb_build_object(
                'min_confidence',0.7,
                'levenshtein_weight',0.4,
                'trigram_weight',0.6,
                'district_centroid_weight',0.2,
                'province_gate',true
              )
            ),
            jsonb_build_object(
              'name','long_line',
              'enabled',true,
              'params', jsonb_build_object(
                'long_line_min_tokens',6,
                'max_noise_ratio',0.5,
                'force_provider_below_score',0.6,
                'max_len_for_local',512
              )
            ),
            jsonb_build_object(
              'name','reverse',
              'enabled',true,
              'params', jsonb_build_object(
                'reverse_min_confidence',0.6,
                'reverse_bounds', jsonb_build_object(
                  'lat', jsonb_build_array(-90,90),
                  'lng', jsonb_build_array(-180,180)
                )
              )
            )
          )
        ),
        'logging', jsonb_build_object(
          'log_scoring_details', true,
          'log_tokens', true
        ),
        'auto_learning', jsonb_build_object(
          'alias_confidence_min', COALESCE(policy->'auto_learning'->>'alias_confidence_min','0.8')::numeric,
          'alias_review_threshold', COALESCE(policy->'auto_learning'->>'alias_review_threshold','0.6')::numeric,
          'alias_max_per_run', COALESCE(policy->'auto_learning'->>'alias_max_per_run','5')::int
        )
      )
    ) AS patched_policy
  FROM base
)
UPDATE settings_versions sv
SET value = patched.patched_policy,
    change_reason = 'Add matching_plugins + logging + alias knobs'
FROM patched
WHERE sv.id = patched.settings_version_id;

WITH base AS (
  SELECT
    s.id AS settings_id,
    sv.id AS settings_version_id,
    sv.value AS policy
  FROM settings_versions sv
  JOIN settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'geocoding_policy'
    AND sv.scope_type = 'global'
  ORDER BY sv.version DESC
  LIMIT 1
)
UPDATE settings s
SET cached_value = base.policy,
    last_updated = now()
FROM base
WHERE s.id = base.settings_id;

COMMIT;

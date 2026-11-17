-- Migration: Global geocoding policy seed + workflow metadata alignment
-- Purpose: Provide default provider priority and ensure workflow steps expose provider_key.

BEGIN;

WITH policy_body AS (
  SELECT jsonb_build_object(
    'version', 2,
    'confidence_threshold', 0.75,
    'provider_priority', jsonb_build_array('internal_cache', 'here_geocoding', 'google_maps'),
    'fallback_strategy', 'stop_on_confident_match',
    'provider_agreement_rules', jsonb_build_object(
      'max_distance_difference_m', 400,
      'min_confidence_delta', 0.1,
      'if_disagree', 'fallback_provider'
    ),
    'decision_workflow_id', 'workflow_geocoding_standard',
    'coordinate_handling', jsonb_build_object(
      'use_provided_coordinates', true,
      'skip_geocoding_if_provided', true,
      'validate_bounds', true,
      'country_boundary', 'SA',
      'max_coordinate_age_minutes', 180,
      'fallback_to_canonical_centroid', true
    ),
    'address_normalization', jsonb_build_object(
      'enabled', true,
      'component_matching', jsonb_build_object(
        'primary_strategy_lookup', '{{LOOKUP:match_strategy.trigram_similarity}}',
        'fallback_strategy_lookup', '{{LOOKUP:match_strategy.levenshtein}}',
        'primary_threshold', 0.85,
        'fallback_threshold', 3,
        'match_behavior', jsonb_build_object(
          'require_match', false,
          'on_no_match_action_lookup', '{{LOOKUP:no_match_action.proceed_to_api}}'
        ),
        'match_order', jsonb_build_array(
          jsonb_build_object(
            'strategy_lookup', '{{LOOKUP:match_strategy.exact_case_insensitive}}',
            'stop_on_failure', false
          ),
          jsonb_build_object(
            'strategy_lookup', '{{LOOKUP:match_strategy.trigram_similarity}}',
            'threshold', 0.85,
            'stop_on_failure', false
          ),
          jsonb_build_object(
            'strategy_lookup', '{{LOOKUP:match_strategy.levenshtein}}',
            'threshold', 3,
            'stop_on_failure', false
          )
        )
      )
    ),
    'manual_review', jsonb_build_object(
      'sla_minutes', 60,
      'queue_assignment', 'address_ops',
      'escalation_channel', 'geo_ops_daily_digest',
      'escalate_after_minutes', 120
    ),
    'auto_learning', jsonb_build_object(
      'enabled', true,
      'components', jsonb_build_object(
        'city', jsonb_build_object('action_lookup', '{{LOOKUP:auto_learn_action.add_immediately}}'),
        'district', jsonb_build_object('action_lookup', '{{LOOKUP:auto_learn_action.add_immediately}}')
      ),
      'confidence_threshold_for_auto_learn', 0.9
    ),
    'backpressure', jsonb_build_object(
      'max_queue_depth', 50,
      'throttle_ingest_at', 40,
      'pause_workflow_when_full', false,
      'notify_account_manager_at', 25
    ),
    'metadata', jsonb_build_object(
      'policy_profile', 'global_default',
      'workflow_template_id', '99990000-0000-0000-0000-000000400001'
    )
  ) AS body
),
insert_version AS (
  INSERT INTO settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    gen_random_uuid(),
    'geocoding_policy',
    'global',
    NULL::uuid,
    NULL::uuid,
    1,
    policy_body.body,
    1,
    'Seed global geocoding policy',
    now(),
    now()
  FROM policy_body
  WHERE NOT EXISTS (
    SELECT 1
    FROM settings_versions sv
    WHERE sv.category = 'geocoding_policy'
      AND sv.scope_type = 'global'
  )
  RETURNING id, value
)
INSERT INTO settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  gen_random_uuid(),
  'geocoding_policy',
  'global',
  NULL::uuid,
  NULL::uuid,
  insert_version.id,
  insert_version.value,
  now()
FROM insert_version
WHERE NOT EXISTS (
  SELECT 1
  FROM settings s
  WHERE s.category = 'geocoding_policy'
    AND s.scope_type = 'global'
);

WITH template AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1
)
UPDATE workflow_template_steps
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{provider_key}',
  to_jsonb('here_geocoding'::text),
  true
)
WHERE workflow_template_id = (SELECT id FROM template)
  AND operation_name = 'dispatch_provider'
  AND (metadata->>'provider_key') IS DISTINCT FROM 'here_geocoding';

WITH template AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1
)
UPDATE workflow_template_steps
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{provider_key}',
  to_jsonb('google_maps'::text),
  true
)
WHERE workflow_template_id = (SELECT id FROM template)
  AND operation_name = 'fallback_provider'
  AND (metadata->>'provider_key') IS DISTINCT FROM 'google_maps';

COMMIT;

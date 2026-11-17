-- Phase 5 - Geocoding policy configuration refresh
-- Aligns existing geocoding_policy settings rows with the declarative workflow blueprint:
--   * upgrades legacy provider_chain payloads to the v1 schema (provider_priority, workflow metadata)
--   * seeds metadata for auditability (legacy snapshot, workflow template reference)
--   * bumps settings_versions and refreshes settings/caches so workers resolve new configuration

BEGIN;

SET search_path TO public;

WITH current AS (
    SELECT
        sv.id AS old_settings_version_id,
        sv.scope_type,
        sv.scope_id,
        sv.scope_hash,
        sv.version AS current_version,
        sv.value AS old_value,
        s.id AS settings_id
    FROM settings_versions sv
    JOIN settings s
      ON s.settings_version_id = sv.id
     AND s.category = 'geocoding_policy'
    WHERE sv.category = 'geocoding_policy'
),
params AS (
    SELECT
        c.*,
        COALESCE((c.old_value->>'enabled')::boolean, true) AS old_enabled,
        COALESCE((c.old_value#>>'{manual_review,enabled}')::boolean, true) AS manual_enabled,
        COALESCE((c.old_value#>>'{manual_review,notify_ops}')::boolean, false) AS manual_notify,
        COALESCE((c.old_value#>>'{provider_chain,0,use_cache}')::boolean, true) AS use_cache,
        COALESCE((c.old_value#>>'{provider_chain,0,max_retries}')::int, 1) AS max_retries,
        COALESCE(NULLIF(c.old_value#>>'{provider_chain,0,provider_id}', ''), 'f36008ee-9f91-4f28-a1d4-ae331a42bdfc') AS primary_provider_id_text,
        COALESCE((c.old_value->>'confidence_threshold')::numeric, 0.75) AS confidence_threshold
    FROM current c
),
transformed AS (
    SELECT
        p.settings_id,
        p.scope_type,
        p.scope_id,
        p.scope_hash,
        p.old_settings_version_id,
        p.old_value,
        p.old_enabled,
        p.manual_enabled,
        p.manual_notify,
        p.use_cache,
        p.max_retries,
        p.primary_provider_id_text,
        p.confidence_threshold,
        p.current_version + 1 AS new_version,
        jsonb_strip_nulls(
            jsonb_build_object(
                'version', p.current_version + 1,
                'confidence_threshold', p.confidence_threshold,
                'provider_priority',
                    CASE
                        WHEN p.use_cache THEN jsonb_build_array('internal_cache', 'here_geocoding', 'google_maps')
                        ELSE jsonb_build_array('here_geocoding', 'google_maps', 'internal_cache')
                    END,
                'fallback_strategy', 'stop_on_confident_match',
                'provider_agreement_rules', jsonb_build_object(
                    'max_distance_difference_m', CASE WHEN p.manual_notify THEN 250 ELSE 400 END,
                    'min_confidence_delta', 0.1,
                    'if_disagree', CASE WHEN p.manual_notify THEN 'manual_review' ELSE 'fallback_provider' END
                ),
                'decision_workflow_id', 'workflow_geocoding_standard',
                'coordinate_handling', jsonb_build_object(
                    'use_provided_coordinates', true,
                    'skip_geocoding_if_provided', NOT p.old_enabled,
                    'validate_bounds', true,
                    'country_boundary', 'SA',
                    'max_coordinate_age_minutes', 180,
                    'fallback_to_canonical_centroid', true
                ),
                'address_normalization', jsonb_build_object(
                    'enabled', true,
                    'component_matching', jsonb_build_object(
                        'primary_strategy_lookup', '{{LOOKUP:match_strategy.trigram_similarity}}',
                        'primary_threshold', 0.85,
                        'fallback_strategy_lookup', '{{LOOKUP:match_strategy.levenshtein}}',
                        'fallback_threshold', 3,
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
                        ),
                        'match_behavior', jsonb_build_object(
                            'require_match', false,
                            'on_no_match_action_lookup', '{{LOOKUP:no_match_action.proceed_to_api}}'
                        )
                    )
                ),
                'manual_review', jsonb_build_object(
                    'sla_minutes', CASE WHEN p.manual_enabled THEN 60 ELSE 120 END,
                    'queue_assignment', 'address_ops',
                    'escalate_after_minutes', CASE WHEN p.manual_notify THEN 45 ELSE 120 END,
                    'escalation_channel', CASE WHEN p.manual_notify THEN 'geo_ops_on_call' ELSE 'geo_ops_daily_digest' END
                ),
                'auto_learning', jsonb_build_object(
                    'enabled', (p.old_enabled AND p.manual_enabled),
                    'confidence_threshold_for_auto_learn', 0.9,
                    'components', jsonb_build_object(
                        'city', jsonb_build_object(
                            'action_lookup', '{{LOOKUP:auto_learn_action.add_immediately}}'
                        ),
                        'district', jsonb_build_object(
                            'action_lookup', CASE WHEN p.manual_notify THEN '{{LOOKUP:auto_learn_action.queue_for_review}}' ELSE '{{LOOKUP:auto_learn_action.add_immediately}}' END
                        )
                    )
                ),
                'backpressure', jsonb_build_object(
                    'max_queue_depth', CASE WHEN p.old_enabled THEN 200 ELSE 10 END,
                    'throttle_ingest_at', CASE WHEN p.old_enabled THEN 150 ELSE 5 END,
                    'notify_account_manager_at', CASE WHEN p.old_enabled THEN 100 ELSE 2 END,
                    'pause_workflow_when_full', NOT p.old_enabled
                ),
                'metadata', jsonb_strip_nulls(
                    jsonb_build_object(
                        'policy_profile', CASE
                            WHEN NOT p.old_enabled THEN 'disabled'
                            WHEN p.use_cache THEN 'cache_first'
                            ELSE 'api_first'
                        END,
                        'legacy_enabled', p.old_enabled,
                        'legacy_manual_review_enabled', p.manual_enabled,
                        'legacy_notify_ops', p.manual_notify,
                        'legacy_provider_chain', p.old_value->'provider_chain',
                        'legacy_settings_version_id', p.old_settings_version_id,
                        'legacy_policy_snapshot', p.old_value,
                        'primary_provider_id', p.primary_provider_id_text,
                        'max_retries', p.max_retries,
                        'workflow_template_id', '99990000-0000-0000-0000-000000400001'
                    )
                )
            )
        ) AS new_value
    FROM params p
),
updated_versions AS (
    UPDATE settings_versions sv
    SET
        version = t.new_version,
        value = t.new_value,
        schema_version = 1,
        change_reason = 'Upgrade geocoding policy to workflow-driven configuration',
        approved_at = now(),
        effective_from = now()
    FROM transformed t
    WHERE sv.id = t.old_settings_version_id
    RETURNING sv.id
)
UPDATE settings s
SET
    cached_value = t.new_value,
    last_updated = now()
FROM transformed t
JOIN updated_versions uv ON uv.id = t.old_settings_version_id
WHERE s.id = t.settings_id;

DELETE FROM settings_cache sc
USING settings_versions sv
WHERE sc.settings_version_id = sv.id
  AND sv.category = 'geocoding_policy';

COMMIT;

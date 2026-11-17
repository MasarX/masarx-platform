-- Migration: Geocoding decision confidence default for succeeded attempts
-- Purpose:
--   - When a provider response succeeds but does not expose confidence_score,
--     default to policy threshold so fallback is not forced incorrectly.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-05

BEGIN;
SET search_path TO public, workflow_handlers, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_decision_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx RECORD;
    v_policy_record RECORD;
    v_policy JSONB;
    v_logging JSONB := '{}'::jsonb;
    v_primary_threshold NUMERIC(5,4);
    v_fallback_threshold NUMERIC(5,4);
    v_delta NUMERIC(5,4);
    v_attempt RECORD;
    v_success BOOLEAN := FALSE;
    v_requires_fallback BOOLEAN := COALESCE(p_run.context->'geocoding'->>'require_fallback', 'false')::BOOLEAN;
    v_manual_review BOOLEAN := COALESCE(p_run.context->'geocoding'->>'manual_review_required', 'false')::BOOLEAN;
    v_selected_confidence NUMERIC(5,4);
    v_response workflow_handler_response;
    v_attempt_json JSONB;
    v_attempt_id UUID;
    v_attempt_geocode JSONB;
    v_match JSONB;
    v_tokens JSONB := NULL;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', FALSE);

    IF COALESCE(p_run.context->'geocoding'->>'successful', 'false')::BOOLEAN AND NOT v_requires_fallback THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'success',
            'source', 'context'
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'successful', TRUE,
                'manual_review_required', FALSE,
                'require_fallback', FALSE
            ))
        );
        RETURN v_response;
    END IF;

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);
    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_geo_decision_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
    END IF;

    SELECT *
    INTO v_policy_record
    FROM public.geocoding_resolve_policy(
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id
    )
    LIMIT 1;

    v_policy := v_policy_record.policy;
    v_logging := COALESCE(v_policy->'logging', '{}'::jsonb);

    v_primary_threshold := COALESCE(
        (v_policy->>'confidence_threshold')::NUMERIC,
        (v_metadata->>'confidence_threshold')::NUMERIC,
        0.75
    );

    v_fallback_threshold := COALESCE(
        (v_policy->>'fallback_threshold')::NUMERIC,
        (v_metadata->>'fallback_threshold')::NUMERIC,
        NULL
    );

    IF v_fallback_threshold IS NULL AND v_primary_threshold IS NOT NULL THEN
        v_delta := COALESCE(
            (v_policy->'provider_agreement_rules'->>'min_confidence_delta')::NUMERIC,
            0.1
        );
        v_fallback_threshold := v_primary_threshold - v_delta;
    END IF;

    v_fallback_threshold := COALESCE(v_fallback_threshold, 0.65);
    IF v_primary_threshold IS NOT NULL THEN
        v_fallback_threshold := LEAST(v_primary_threshold, v_fallback_threshold);
    END IF;

    SELECT *
    INTO v_attempt
    FROM public.geocoding_attempts
    WHERE address_id = v_ctx.address_id
    ORDER BY attempt_order DESC, created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v_manual_review := TRUE;
        v_attempt_id := NULL;
        v_attempt_geocode := NULL;
    ELSE
        v_attempt_id := v_attempt.id;
        v_attempt_geocode := COALESCE(v_attempt.metadata->'geocode', NULL);
        v_selected_confidence := v_attempt.confidence;
        IF v_selected_confidence IS NULL AND v_attempt.status = 'succeeded' THEN
            v_selected_confidence := v_primary_threshold;
        END IF;
        v_selected_confidence := COALESCE(v_selected_confidence, 0);

        IF COALESCE(v_attempt.metadata->'tokens', '{}'::jsonb) <> '{}'::jsonb AND geocoding_should_log_tokens(v_policy) THEN
            v_tokens := v_attempt.metadata->'tokens';
        END IF;

        IF v_selected_confidence >= v_primary_threshold THEN
            v_success := TRUE;
        ELSIF v_selected_confidence >= v_fallback_threshold THEN
            IF v_attempt.attempt_type = 'fallback' THEN
                v_success := TRUE;
            ELSE
                v_requires_fallback := TRUE;
            END IF;
        ELSE
            IF v_attempt.attempt_type = 'fallback' THEN
                v_manual_review := TRUE;
            ELSE
                v_requires_fallback := TRUE;
            END IF;
        END IF;
    END IF;

    IF COALESCE(p_run.context->'geocoding'->>'manual_review_required', 'false')::BOOLEAN THEN
        v_manual_review := TRUE;
    END IF;

    -- `require_fallback` is a directive to run the fallback step; it must not
    -- prevent success evaluation once a fallback attempt exists.
    IF COALESCE(p_run.context->'geocoding'->>'require_fallback', 'false')::BOOLEAN THEN
        IF v_attempt_id IS NULL OR COALESCE(v_attempt.attempt_type, '') <> 'fallback' THEN
            v_success := FALSE;
            v_requires_fallback := TRUE;
        ELSE
            v_requires_fallback := FALSE;
        END IF;
    END IF;

    IF v_manual_review THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', COALESCE(v_attempt.metadata->>'match_plugin', 'fuzzy'),
            'match_type', 'manual_review',
            'score', v_selected_confidence,
            'routing_reason', 'confidence_below_threshold',
            'tokens', v_tokens
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'successful', FALSE,
                'manual_review_required', TRUE,
                'manual_review_reason', 'confidence_below_threshold',
                'selected_attempt_id', v_attempt_id,
                'selected_geocode', v_attempt_geocode,
                'require_fallback', FALSE,
                'thresholds', jsonb_build_object(
                    'primary', v_primary_threshold,
                    'fallback', v_fallback_threshold
                )
            ))
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'manual_review',
            'reason', 'confidence_below_threshold'
        );
        RETURN v_response;
    END IF;

    IF v_success THEN
        v_attempt_json := jsonb_build_object(
            'attempt_id', v_attempt_id,
            'provider_name', v_attempt.provider_name,
            'confidence', v_selected_confidence,
            'attempt_type', v_attempt.attempt_type,
            'geocode', v_attempt_geocode
        );

        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', COALESCE(v_attempt.metadata->>'match_plugin', 'perfect'),
            'match_type', COALESCE(v_attempt.metadata->>'match_type', v_attempt.attempt_type),
            'score', v_selected_confidence,
            'routing_reason', 'decision_success',
            'tokens', v_tokens
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'successful', TRUE,
                'selected_attempt_id', v_attempt_id,
                'selected_geocode', v_attempt_geocode,
                'manual_review_required', FALSE,
                'require_fallback', FALSE,
                'thresholds', jsonb_build_object(
                    'primary', v_primary_threshold,
                    'fallback', v_fallback_threshold
                )
            ))
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'success',
            'attempt', v_attempt_json
        );
        RETURN v_response;
    END IF;

    IF v_requires_fallback THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', COALESCE(v_attempt.metadata->>'match_plugin', 'fuzzy'),
            'match_type', COALESCE(v_attempt.metadata->>'match_type', 'fallback_required'),
            'score', v_selected_confidence,
            'routing_reason', 'fallback_required',
            'tokens', v_tokens
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'successful', FALSE,
                'selected_attempt_id', v_attempt_id,
                'selected_geocode', v_attempt_geocode,
                'manual_review_required', FALSE,
                'require_fallback', TRUE,
                'thresholds', jsonb_build_object(
                    'primary', v_primary_threshold,
                    'fallback', v_fallback_threshold
                )
            ))
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'fallback_required',
            'last_attempt_id', v_attempt_id
        );
        RETURN v_response;
    END IF;

    v_match := jsonb_strip_nulls(jsonb_build_object(
        'plugin', COALESCE(v_attempt.metadata->>'match_plugin', 'fuzzy'),
        'match_type', 'manual_review',
        'score', v_selected_confidence,
        'routing_reason', 'confidence_below_threshold',
        'tokens', v_tokens
    ));
    PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'successful', FALSE,
            'manual_review_required', TRUE,
            'manual_review_reason', 'confidence_below_threshold',
            'selected_attempt_id', v_attempt_id,
            'selected_geocode', v_attempt_geocode,
            'require_fallback', FALSE,
            'thresholds', jsonb_build_object(
                'primary', v_primary_threshold,
                'fallback', v_fallback_threshold
            )
        ))
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'decision', 'manual_review',
        'reason', 'confidence_below_threshold'
    );
    RETURN v_response;
END;
$$;

ALTER FUNCTION workflow_handlers.execute_geo_decision_v1(workflow_run_steps, workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, pg_temp;

COMMIT;

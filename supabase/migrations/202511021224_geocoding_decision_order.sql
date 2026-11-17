-- Migration 202511021224: Ensure geocoding decision prefers latest attempt
-- Purpose: Order attempts by created_at and attempt_order when evaluating outcomes.

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_decision_v1(p_step workflow_run_steps, p_run workflow_runs, p_operation_result jsonb DEFAULT '{}'::jsonb)
 RETURNS workflow_handler_response
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx RECORD;
    v_policy_record RECORD;
    v_policy JSONB;
    v_primary_threshold NUMERIC(5,4);
    v_fallback_threshold NUMERIC(5,4);
    v_delta NUMERIC(5,4);
    v_attempt RECORD;
    v_success BOOLEAN := FALSE;
    v_requires_fallback BOOLEAN := FALSE;
    v_manual_review BOOLEAN := FALSE;
    v_selected_confidence NUMERIC(5,4);
    v_response workflow_handler_response;
    v_attempt_json JSONB;
    v_attempt_id UUID;
    v_attempt_geocode JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

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

    v_primary_threshold := COALESCE(
        (v_policy->>'confidence_threshold')::NUMERIC,
        (v_metadata->>'confidence_threshold')::NUMERIC,
        0.75
    );

    v_fallback_threshold := COALESCE(
        (v_policy->>'fallback_threshold')::NUMERIC,
        (v_policy->'metadata'->>'fallback_threshold')::NUMERIC,
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
    ORDER BY created_at DESC, attempt_order DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v_manual_review := TRUE;
        v_attempt_id := NULL;
        v_attempt_geocode := NULL;
    ELSE
        v_attempt_id := v_attempt.id;
        v_attempt_geocode := COALESCE(v_attempt.metadata->'geocode', NULL);
        v_selected_confidence := COALESCE(v_attempt.confidence, 0);

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

    IF v_success THEN
        v_attempt_json := jsonb_build_object(
            'attempt_id', v_attempt_id,
            'provider_name', v_attempt.provider_name,
            'confidence', v_selected_confidence,
            'attempt_type', v_attempt.attempt_type,
            'geocode', v_attempt_geocode
        );

        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'successful', TRUE,
                'selected_attempt_id', v_attempt_id,
                'selected_geocode', v_attempt_geocode,
                'manual_review_required', FALSE,
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

    v_manual_review := TRUE;

    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'successful', FALSE,
            'manual_review_required', TRUE,
            'manual_review_reason', 'confidence_below_threshold',
            'selected_attempt_id', v_attempt_id,
            'selected_geocode', v_attempt_geocode,
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
$function$




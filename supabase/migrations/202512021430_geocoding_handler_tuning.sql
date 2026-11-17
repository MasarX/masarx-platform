-- Migration: Geocoding handler tuning
-- Purpose: Manual-review precedence fixes, long_line fallback gating, centroid preference, and provider dispatch hints.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - zero hardcoding.

BEGIN;

-- Decision handler: order attempts by attempt_order then created_at
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
                'manual_review_required', FALSE
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
        v_selected_confidence := COALESCE(v_attempt.confidence, 0);

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
    IF COALESCE(p_run.context->'geocoding'->>'require_fallback', 'false')::BOOLEAN THEN
        v_success := FALSE;
        v_requires_fallback := TRUE;
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

-- Local lookup: gate long_line fallback by provider availability and prefer district centroid
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_local_lookup_v1(
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
    v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_logging JSONB := COALESCE(v_policy->'logging', '{}'::jsonb);
    v_perfect JSONB := geocoding_get_plugin(v_policy, 'perfect');
    v_fuzzy JSONB := geocoding_get_plugin(v_policy, 'fuzzy');
    v_long JSONB := geocoding_get_plugin(v_policy, 'long_line');
    v_provider_count INT := COALESCE(jsonb_array_length(v_policy->'provider_priority'), 0);
    v_perfect_enabled BOOLEAN := COALESCE(v_perfect->>'enabled', 'true')::BOOLEAN;
    v_fuzzy_enabled BOOLEAN := COALESCE(v_fuzzy->>'enabled', 'true')::BOOLEAN;
    v_long_enabled BOOLEAN := COALESCE(v_long->>'enabled', 'true')::BOOLEAN;
    v_min_conf NUMERIC := COALESCE((v_perfect->'params'->>'min_confidence')::NUMERIC, 0.65);
    v_fuzzy_min NUMERIC := COALESCE((v_fuzzy->'params'->>'min_confidence')::NUMERIC, 0.6);
    v_prefer_district BOOLEAN := COALESCE((v_perfect->'params'->>'prefer_district_centroid')::BOOLEAN, FALSE);
    v_province_gate BOOLEAN := COALESCE((v_perfect->'params'->>'gate_by_province')::BOOLEAN, FALSE);
    v_long_min_tokens INT := COALESCE((v_long->'params'->>'long_line_min_tokens')::INT, 6);
    v_long_max_noise NUMERIC := COALESCE((v_long->'params'->>'max_noise_ratio')::NUMERIC, 0.5);
    v_long_force NUMERIC := (v_long->'params'->>'force_provider_below_score')::NUMERIC;
    v_long_max_len INT := COALESCE((v_long->'params'->>'max_len_for_local')::INT, 512);
    v_address RECORD;
    v_city RECORD;
    v_district RECORD;
    v_raw JSONB := '{}'::jsonb;
    v_line TEXT;
    v_city_text TEXT;
    v_district_text TEXT;
    v_country_text TEXT;
    v_province_text TEXT;
    v_confidence NUMERIC := 0;
    v_centroid GEOGRAPHY;
    v_city_score NUMERIC := 0;
    v_district_score NUMERIC := 0;
    v_match_plugin TEXT := 'perfect';
    v_match_type TEXT := 'local_match';
    v_routing_reason TEXT := 'local_match';
    v_geocode JSONB;
    v_response workflow_handler_response;
    v_attempt_id UUID;
    v_match JSONB;
    v_log_tokens BOOLEAN := geocoding_should_log_tokens(v_policy);
    v_line_tokens TEXT[] := ARRAY[]::TEXT[];
    v_token_count INT := 0;
    v_token_sample TEXT[] := ARRAY[]::TEXT[];
    v_noise_count INT := 0;
    v_noise_ratio NUMERIC := 0;
    v_long_line_detected BOOLEAN := FALSE;
    v_force_provider BOOLEAN := FALSE;
    v_tokens JSONB := NULL;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', FALSE);

    IF NOT COALESCE((v_perfect->>'enabled')::BOOLEAN, FALSE) AND NOT v_fuzzy_enabled AND NOT v_long_enabled THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'local_lookup_disabled'
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'local_lookup_disabled', TRUE,
                'require_fallback', v_provider_count > 0
            ))
        );
        RETURN v_response;
    END IF;

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'address_missing'
        );
        RETURN v_response;
    END IF;

    SELECT
        a.city,
        a.district,
        a.province,
        a.country,
        a.raw_input,
        a.normalized_line1,
        a.normalized_line2
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id
    LIMIT 1;

    v_raw := COALESCE(v_address.raw_input::jsonb, '{}'::jsonb);

    v_city_text := COALESCE(NULLIF(v_address.city, ''), NULLIF(v_raw->>'city', ''));
    v_district_text := COALESCE(NULLIF(v_address.district, ''), NULLIF(v_raw->>'district', ''));
    v_country_text := COALESCE(NULLIF(v_address.country, ''), NULLIF(v_raw->>'country', ''), 'SA');
    v_province_text := COALESCE(NULLIF(v_address.province, ''), NULLIF(v_raw->>'province', ''));

    v_line := trim(BOTH ' ' FROM COALESCE(v_address.normalized_line1, '') || ' ' || COALESCE(v_address.normalized_line2, ''));
    IF v_line IS NOT NULL AND v_line <> '' THEN
        v_line_tokens := regexp_split_to_array(lower(v_line), '[^[:alnum:]]+');
        v_line_tokens := ARRAY(SELECT t FROM unnest(v_line_tokens) t WHERE t IS NOT NULL AND t <> '');
        v_token_count := COALESCE(array_length(v_line_tokens, 1), 0);
        SELECT COUNT(*) INTO v_noise_count FROM unnest(v_line_tokens) t WHERE length(t) <= 2 OR t ~ '^[0-9]+$';
        v_noise_ratio := CASE WHEN v_token_count > 0 THEN v_noise_count::NUMERIC / v_token_count ELSE 0 END;
        v_token_sample := COALESCE(v_line_tokens[1:LEAST(5, GREATEST(1, v_token_count))], ARRAY[]::TEXT[]);
        v_long_line_detected := v_long_enabled AND (
            v_token_count >= v_long_min_tokens
            OR v_noise_ratio > v_long_max_noise
            OR length(v_line) > v_long_max_len
        );
        IF v_long_line_detected THEN
            v_routing_reason := 'long_line_detected';
            v_force_provider := v_provider_count > 0;
        END IF;
    END IF;

    IF v_city_text IS NULL THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
          'plugin', 'perfect',
          'match_type', 'city_missing',
          'routing_reason', 'city_missing',
          'tokens', CASE WHEN v_log_tokens THEN jsonb_build_object('line_tokens', v_token_sample) END
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'city_missing'
        );
        RETURN v_response;
    END IF;

    WITH city_matches AS (
        SELECT
            c.id,
            c.name_canonical,
            c.name_arabic,
            c.centroid,
            c.source_city_id,
            c.province,
            c.updated_at,
            GREATEST(
                similarity(lower(c.name_canonical), lower(v_city_text)),
                similarity(lower(COALESCE(c.name_arabic, '')), lower(v_city_text)),
                COALESCE((
                    SELECT MAX(similarity(lower(an), lower(v_city_text)))
                    FROM unnest(COALESCE(c.alternate_names, ARRAY[]::text[])) AS an
                ), 0)
            ) AS score,
            (
                lower(c.name_canonical) = lower(v_city_text)
                OR lower(COALESCE(c.name_arabic, '')) = lower(v_city_text)
                OR EXISTS (
                    SELECT 1
                    FROM unnest(COALESCE(c.alternate_names, ARRAY[]::text[])) AS an
                    WHERE lower(an) = lower(v_city_text)
                )
            ) AS exact_match
        FROM public.canonical_cities c
        WHERE c.organization_id = v_ctx.organization_id
          AND c.is_active = TRUE
          AND (v_country_text IS NULL OR lower(c.country_code) = lower(v_country_text))
          AND (
                NOT v_province_gate
                OR v_province_text IS NULL
                OR lower(c.province) = lower(v_province_text)
                OR lower(COALESCE(c.region_code, '')) = lower(v_province_text)
          )
    )
    SELECT *
    INTO v_city
    FROM city_matches
    ORDER BY exact_match DESC, score DESC, updated_at DESC
    LIMIT 1;

    IF NOT FOUND OR v_city.score IS NULL OR v_city.score < v_min_conf THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
          'plugin', CASE WHEN v_city.exact_match THEN 'perfect' ELSE 'fuzzy' END,
          'match_type', 'city_match_below_threshold',
          'score', v_city.score,
          'routing_reason', 'city_match_below_threshold',
          'tokens', CASE WHEN v_log_tokens THEN jsonb_build_object('city', v_city_text, 'line_tokens', v_token_sample) END
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'city_match_below_threshold',
            'score', v_city.score
        );
        RETURN v_response;
    END IF;

    v_city_score := COALESCE(v_city.score, 0);

    IF v_district_text IS NOT NULL THEN
        WITH district_matches AS (
            SELECT
                d.id,
                d.name_canonical,
                d.name_arabic,
                d.centroid,
                d.source_district_id,
                d.updated_at,
                GREATEST(
                    similarity(lower(d.name_canonical), lower(v_district_text)),
                    similarity(lower(COALESCE(d.name_arabic, '')), lower(v_district_text)),
                    COALESCE((
                        SELECT MAX(similarity(lower(an), lower(v_district_text)))
                        FROM unnest(COALESCE(d.alternate_names, ARRAY[]::text[])) AS an
                    ), 0)
                ) AS score,
                (
                    lower(d.name_canonical) = lower(v_district_text)
                    OR lower(COALESCE(d.name_arabic, '')) = lower(v_district_text)
                    OR EXISTS (
                        SELECT 1
                        FROM unnest(COALESCE(d.alternate_names, ARRAY[]::text[])) AS an
                        WHERE lower(an) = lower(v_district_text)
                    )
                ) AS exact_match
            FROM public.canonical_districts d
            WHERE d.city_id = v_city.id
              AND d.is_active = TRUE
        )
        SELECT *
        INTO v_district
        FROM district_matches
        ORDER BY exact_match DESC, score DESC, updated_at DESC
        LIMIT 1;

        IF FOUND AND v_district.score IS NOT NULL THEN
            v_district_score := v_district.score;
        END IF;
    END IF;

    IF v_district.id IS NULL AND v_prefer_district THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
          'plugin', 'fuzzy',
          'match_type', 'district_missing',
          'score', v_city_score,
          'routing_reason', 'district_missing',
          'tokens', CASE WHEN v_log_tokens THEN jsonb_build_object('city', v_city_text, 'district', v_district_text, 'line_tokens', v_token_sample) END
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'district_missing'
        );
        RETURN v_response;
    END IF;

    IF v_district.id IS NOT NULL THEN
        v_confidence := GREATEST(v_city_score, v_district_score);
        v_match_plugin := CASE WHEN v_district_score >= v_min_conf THEN 'perfect' ELSE 'fuzzy' END;
        v_match_type := CASE WHEN v_district_score >= v_min_conf THEN 'district_match' ELSE 'district_fuzzy_match' END;
    ELSE
        v_confidence := v_city_score;
        v_match_plugin := CASE WHEN v_city_score >= v_min_conf THEN 'perfect' ELSE 'fuzzy' END;
        v_match_type := CASE WHEN v_city_score >= v_min_conf THEN 'city_match' ELSE 'city_fuzzy_match' END;
    END IF;

    v_confidence := LEAST(v_confidence, 1);
    IF v_force_provider AND v_long_force IS NOT NULL THEN
        v_confidence := LEAST(v_confidence, v_long_force);
    END IF;
    IF NOT v_perfect_enabled THEN
        v_confidence := LEAST(v_confidence, v_fuzzy_min);
    END IF;
    v_confidence := COALESCE(v_confidence, 0);

    IF v_confidence < v_min_conf AND NOT v_fuzzy_enabled THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
          'plugin', 'perfect',
          'match_type', 'match_below_threshold',
          'score', v_confidence,
          'routing_reason', 'match_below_threshold',
          'tokens', CASE WHEN v_log_tokens THEN jsonb_build_object('city', v_city_text, 'district', v_district_text, 'line_tokens', v_token_sample) END,
          'noise_ratio', v_noise_ratio,
          'long_line_detected', v_long_line_detected
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'match_below_threshold',
            'score', v_confidence
        );
        RETURN v_response;
    END IF;

    v_centroid := COALESCE(v_district.centroid, v_city.centroid);

    IF v_centroid IS NULL THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
          'plugin', 'perfect',
          'match_type', 'centroid_missing',
          'routing_reason', 'centroid_missing',
          'tokens', CASE WHEN v_log_tokens THEN jsonb_build_object('city', v_city_text, 'district', v_district_text, 'line_tokens', v_token_sample) END
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'centroid_missing'
        );
        RETURN v_response;
    END IF;

    IF v_log_tokens THEN
        v_tokens := jsonb_strip_nulls(jsonb_build_object(
            'city', v_city_text,
            'district', v_district_text,
            'line_tokens', v_token_sample
        ));
    END IF;

    v_match := jsonb_strip_nulls(jsonb_build_object(
        'plugin', v_match_plugin,
        'match_type', v_match_type,
        'score', v_confidence,
        'routing_reason', COALESCE(v_routing_reason, 'local_match'),
        'tokens', v_tokens,
        'noise_ratio', v_noise_ratio,
        'long_line_detected', v_long_line_detected
    ));

    v_geocode := jsonb_strip_nulls(jsonb_build_object(
        'provider_name', 'canonical_lookup',
        'is_primary', TRUE,
        'confidence_score', v_confidence,
        'accuracy_type', 'canonical_centroid',
        'coordinates', jsonb_build_object(
            'latitude', ST_Y(v_centroid::geometry),
            'longitude', ST_X(v_centroid::geometry)
        ),
        'metadata', jsonb_strip_nulls(jsonb_build_object(
            'city_id', v_city.id,
            'source_city_id', v_city.source_city_id,
            'district_id', v_district.id,
            'source_district_id', v_district.source_district_id,
            'city_match', v_city.name_canonical,
            'district_match', v_district.name_canonical,
            'city_score', v_city_score,
            'district_score', v_district_score,
            'country', v_country_text,
            'province', v_province_text,
            'match_plugin', v_match_plugin,
            'match_type', v_match_type,
            'routing_reason', COALESCE(v_routing_reason, 'local_match'),
            'noise_ratio', v_noise_ratio,
            'long_line_detected', v_long_line_detected
        ))
    ));

    INSERT INTO public.geocoding_attempts (
        organization_id,
        client_id,
        sender_id,
        address_id,
        workflow_run_step_id,
        provider_name,
        attempt_order,
        attempt_type,
        status,
        confidence,
        duration_ms,
        metadata,
        created_at,
        updated_at
    )
    VALUES (
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id,
        v_ctx.address_id,
        p_step.id,
        'canonical_lookup',
        1,
        'local',
        'succeeded',
        v_confidence,
        0,
        jsonb_build_object(
            'geocode', v_geocode,
            'match_source', 'canonical_lookup',
            'match_plugin', v_match_plugin,
            'match_type', v_match_type,
            'routing_reason', COALESCE(v_routing_reason, 'local_match'),
            'noise_ratio', v_noise_ratio,
            'long_line_detected', v_long_line_detected,
            'tokens', v_tokens
        ),
        now(),
        now()
    )
    RETURNING id INTO v_attempt_id;

    v_match := v_match || jsonb_build_object('attempt_id', v_attempt_id);
    PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'matched', TRUE,
        'attempt_id', v_attempt_id,
        'confidence', v_confidence
    );
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'local_match', TRUE,
            'selected_geocode', v_geocode,
            'manual_review_required', FALSE,
            'successful', NOT v_force_provider,
            'require_fallback', v_force_provider,
            'match_plugin', v_match_plugin,
            'match_type', v_match_type,
            'geocoding_match', v_match
        ))
    );
    RETURN v_response;
END;
$$;

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT p.oid::regprocedure AS proc
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'workflow_handlers'
          AND proname IN (
              'execute_geocode_cache_v1',
              'execute_geo_local_lookup_v1',
              'execute_provider_dispatch_v1',
              'execute_geo_decision_v1',
              'execute_geo_coordinate_v1'
          )
    LOOP
        EXECUTE format(
            'ALTER FUNCTION %s SET search_path TO workflow_handlers, public, extensions, pg_temp',
            rec.proc
        );
    END LOOP;
END;
$$;

COMMIT;

-- Complete runtime failure-wave reconciliation.
-- Keeps the active history append-only and converges only current contracts.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- Free-form address input must not abort the canonical local lookup handler.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_local_lookup_v1(p_step workflow_run_steps, p_run workflow_runs, p_operation_result jsonb DEFAULT '{}'::jsonb)
 RETURNS workflow_handler_response
 LANGUAGE plpgsql
 SET search_path TO 'workflow_handlers', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx RECORD;
    v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_local_cfg JSONB := COALESCE(v_policy->'local_lookup', '{}'::jsonb);
    v_local_enabled BOOLEAN := COALESCE(v_local_cfg->>'enabled', 'true')::BOOLEAN;
    v_skip_local_when_short_code BOOLEAN := COALESCE((v_local_cfg->>'skip_when_short_code')::BOOLEAN, FALSE);
    v_logging JSONB := COALESCE(v_policy->'logging', '{}'::jsonb);
    v_perfect JSONB := geocoding_get_plugin(v_policy, 'perfect');
    v_fuzzy JSONB := geocoding_get_plugin(v_policy, 'fuzzy');
    v_long JSONB := geocoding_get_plugin(v_policy, 'long_line');
    v_short_plugin JSONB := geocoding_get_plugin(v_policy, 'short_code');
    v_short_params JSONB := NULL;
    v_short_enabled BOOLEAN := FALSE;
    v_short_code_regex TEXT := NULL;
    v_short_candidate TEXT := NULL;
    v_short_code TEXT := NULL;
    v_short_code_present BOOLEAN := FALSE;
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
    v_local_min_conf NUMERIC := NULL;
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
    BEGIN
        v_local_min_conf := NULLIF(v_local_cfg->>'min_confidence', '')::NUMERIC;
    EXCEPTION
        WHEN others THEN
            v_local_min_conf := NULL;
    END;
    IF v_local_min_conf IS NOT NULL THEN
        v_local_min_conf := LEAST(GREATEST(v_local_min_conf, 0), 1);
        v_min_conf := v_local_min_conf;
        v_fuzzy_min := v_local_min_conf;
    END IF;
    -- If geocoding is already resolved (e.g., reverse_local short-circuit), do not overwrite context.
    IF COALESCE(p_run.context->'geocoding'->>'successful', 'false')::BOOLEAN THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'skipped', TRUE,
            'reason', 'geocoding_already_resolved'
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'local_lookup_skipped', TRUE
            )
        );
        RETURN v_response;
    END IF;
    -- Guard: initialize optional match records so missing city/district or no-match paths do not error.
    SELECT
        NULL::uuid AS id,
        NULL::text AS name_canonical,
        NULL::text AS name_arabic,
        NULL::geography AS centroid,
        NULL::bigint AS source_city_id,
        NULL::text AS province,
        NULL::timestamptz AS updated_at,
        NULL::numeric AS score,
        FALSE AS exact_match
    INTO v_city;

    SELECT
        NULL::uuid AS id,
        NULL::text AS name_canonical,
        NULL::text AS name_arabic,
        NULL::geography AS centroid,
        NULL::bigint AS source_district_id,
        NULL::timestamptz AS updated_at,
        NULL::numeric AS score,
        FALSE AS exact_match
    INTO v_district;

    IF NOT v_local_enabled THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'local_lookup_disabled'
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'local_lookup_disabled', TRUE,
                'require_fallback', v_provider_count > 0,
                'successful', FALSE
            ))
        );
        RETURN v_response;
    END IF;

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
        a.sa_short_code,
        a.raw_input,
        a.normalized_line1,
        a.normalized_line2
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id
    LIMIT 1;

    BEGIN
      v_raw := COALESCE(v_address.raw_input::jsonb, '{}'::jsonb);
    EXCEPTION
      WHEN invalid_text_representation THEN
        v_raw := '{}'::jsonb;
    END;

    v_short_enabled := COALESCE((v_short_plugin->>'enabled')::BOOLEAN, FALSE);
    v_short_params := COALESCE(v_short_plugin->'params', '{}'::jsonb);
    v_short_code_regex := COALESCE(NULLIF(v_short_params->>'code_regex', ''), '^[A-Z]{4}[0-9]{4}$');
    v_short_candidate := COALESCE(
        NULLIF(v_context->'geocoding'->>'short_code', ''),
        NULLIF(v_address.sa_short_code, ''),
        NULLIF(v_raw->>'short_code', ''),
        NULLIF(v_raw->>'sa_short_code', ''),
        NULLIF(v_raw->'source_address'->>'nationalAddress', '')
    );
    v_short_code := public.geocoding_normalize_candidate_code(v_short_candidate, v_short_code_regex);
    v_short_code_present := v_short_enabled AND v_short_code IS NOT NULL;

    BEGIN
        v_min_conf := COALESCE(
            NULLIF(v_local_cfg->>'min_confidence', '')::NUMERIC,
            v_min_conf
        );
    EXCEPTION
        WHEN others THEN
            -- keep default v_min_conf on parse errors
            NULL;
    END;

    IF v_skip_local_when_short_code AND v_short_code_present THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', 'local_lookup',
            'match_type', 'local_lookup_skipped_short_code',
            'routing_reason', 'local_lookup_skipped_short_code',
            'short_code', v_short_code
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
            'matched', FALSE,
            'reason', 'local_lookup_skipped_short_code',
            'short_code_present', TRUE,
            'skip_local_when_short_code', TRUE
        ));
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'local_lookup_skipped', TRUE,
                'short_code', v_short_code
            ))
        );
        RETURN v_response;
    END IF;

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
          AND c.centroid IS NOT NULL
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
        GREATEST(0, floor(extract(epoch from clock_timestamp() - v_started_at) * 1000)::int),
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
$function$;

-------------------------------------------------------------------------------
-- Marketplace intake identity and approved-driver compliance handoff.
-------------------------------------------------------------------------------

ALTER FUNCTION public.marketplace_participant_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN
)
  RENAME TO marketplace_participant_request_create_v1_base_202608161860;

REVOKE ALL ON FUNCTION public.marketplace_participant_request_create_v1_base_202608161860(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.marketplace_participant_request_create_v1(
  p_requested_participant_type_key TEXT,
  p_email TEXT,
  p_full_name TEXT,
  p_organization_name TEXT,
  p_organization_slug TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_website_url TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT NULL,
  p_page_url TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT NULL,
  p_experience_summary TEXT DEFAULT NULL,
  p_capabilities_requested JSONB DEFAULT '[]'::jsonb,
  p_verification_documents JSONB DEFAULT '[]'::jsonb,
  p_marketing JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_requested_organization_id UUID DEFAULT NULL,
  p_requested_by_user_id UUID DEFAULT NULL,
  p_ip_hash TEXT DEFAULT NULL,
  p_turnstile_verified BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_type_key TEXT := lower(btrim(COALESCE(p_requested_participant_type_key, '')));
  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
  v_phone TEXT := NULLIF(regexp_replace(COALESCE(p_phone, ''), '[^0-9]+', '', 'g'), '');
  v_employee_id TEXT := NULLIF(lower(btrim(COALESCE(p_marketing->>'employee_or_contractor_id', ''))), '');
  v_policy JSONB;
  v_dedupe_seconds INT := 0;
  v_window_seconds INT := 60;
  v_max_requests INT := 10;
  v_recent_count INT := 0;
  v_existing public.marketplace_participant_requests%ROWTYPE;
  v_reason TEXT;
  v_scope_key TEXT;
BEGIN
  v_policy := public.marketplace_compliance_policy_v1(
    jsonb_build_object(
      'organization_id', p_requested_organization_id,
      'participant_type_key', v_type_key
    )
  );
  v_dedupe_seconds := public.tenant_signup_policy_int_v1(
    v_policy, ARRAY['dedupe', 'window_seconds'], 86400, 0, 31536000
  );
  v_window_seconds := public.tenant_signup_policy_int_v1(
    v_policy, ARRAY['rate_limit', 'window_seconds'], 60, 1, 86400
  );
  v_max_requests := public.tenant_signup_policy_int_v1(
    v_policy, ARRAY['rate_limit', 'max_requests'], 10, 0, 100000
  );

  IF NULLIF(btrim(COALESCE(p_ip_hash, '')), '') IS NOT NULL
     AND v_max_requests > 0 THEN
    SELECT count(*)
      INTO v_recent_count
      FROM public.marketplace_participant_requests r
     WHERE r.ip_hash = NULLIF(btrim(COALESCE(p_ip_hash, '')), '')
       AND r.created_at >= now() - make_interval(secs => v_window_seconds);
  END IF;

  IF public.tenant_signup_policy_bool_v1(v_policy, ARRAY['enabled'], FALSE)
     AND (
       p_requested_organization_id IS NOT NULL
       OR public.tenant_signup_policy_bool_v1(
         v_policy, ARRAY['participant_types', v_type_key, 'allow_public_intake'], FALSE
       )
     )
     AND (
       NOT public.tenant_signup_policy_bool_v1(v_policy, ARRAY['turnstile', 'required'], TRUE)
       OR COALESCE(p_turnstile_verified, FALSE)
     )
     AND v_type_key <> ''
     AND EXISTS (
       SELECT 1
       FROM public.marketplace_registry_entries e
       WHERE e.registry_type = 'participant_type'
         AND e.entry_key = v_type_key
         AND e.is_active
     )
     AND v_email <> ''
     AND position('@' IN v_email) >= 2
     AND btrim(COALESCE(p_full_name, '')) <> ''
     AND btrim(COALESCE(p_organization_name, '')) <> ''
     AND v_recent_count < v_max_requests
     AND v_dedupe_seconds > 0 THEN
    v_scope_key := CASE
      WHEN p_requested_organization_id IS NOT NULL
        THEN 'organization:' || p_requested_organization_id::TEXT
      ELSE 'public:'
        || lower(btrim(p_organization_name))
        || ':'
        || lower(btrim(COALESCE(p_organization_slug, '')))
    END;

    -- Serialize every identity independently and in a fixed order so retries
    -- sharing any canonical identity cannot both pass the existence check.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'marketplace_participant_request:' || v_scope_key || ':' || v_type_key || ':email:' || v_email,
      0
    ));
    IF v_phone IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'marketplace_participant_request:' || v_scope_key || ':' || v_type_key || ':phone:' || v_phone,
        0
      ));
    END IF;
    IF v_employee_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'marketplace_participant_request:' || v_scope_key || ':' || v_type_key || ':employee:' || v_employee_id,
        0
      ));
    END IF;

    SELECT r.*
      INTO v_existing
      FROM public.marketplace_participant_requests r
     WHERE r.requested_participant_type_key = v_type_key
       AND (
         (
           p_requested_organization_id IS NOT NULL
           AND r.requested_organization_id = p_requested_organization_id
         )
         OR (
           p_requested_organization_id IS NULL
           AND r.requested_organization_id IS NULL
           AND lower(btrim(r.organization_name)) = lower(btrim(p_organization_name))
           AND lower(btrim(COALESCE(r.organization_slug, '')))
             = lower(btrim(COALESCE(p_organization_slug, '')))
         )
       )
       AND r.created_at >= now() - make_interval(secs => v_dedupe_seconds)
       AND (
         lower(r.email) = v_email
         OR (
           v_phone IS NOT NULL
           AND regexp_replace(COALESCE(r.phone, ''), '[^0-9]+', '', 'g') = v_phone
         )
         OR (
           v_employee_id IS NOT NULL
           AND lower(btrim(COALESCE(r.marketing->>'employee_or_contractor_id', ''))) = v_employee_id
         )
       )
     ORDER BY
       CASE
         WHEN lower(r.email) = v_email THEN 1
         WHEN v_phone IS NOT NULL
           AND regexp_replace(COALESCE(r.phone, ''), '[^0-9]+', '', 'g') = v_phone THEN 2
         ELSE 3
       END,
       r.created_at DESC
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      v_reason := CASE
        WHEN lower(v_existing.email) = v_email THEN 'email'
        WHEN v_phone IS NOT NULL
          AND regexp_replace(COALESCE(v_existing.phone, ''), '[^0-9]+', '', 'g') = v_phone
          THEN 'phone'
        ELSE 'employee_or_contractor_id'
      END;
      RETURN jsonb_build_object(
        'ok', TRUE,
        'id', v_existing.id,
        'status', v_existing.status,
        'deduped', TRUE,
        'dedupe_reason', v_reason
      );
    END IF;
  END IF;

  RETURN public.marketplace_participant_request_create_v1_base_202608161860(
    p_requested_participant_type_key,
    p_email,
    p_full_name,
    p_organization_name,
    p_organization_slug,
    p_phone,
    p_website_url,
    p_locale,
    p_page_url,
    p_referrer,
    p_origin,
    p_experience_summary,
    p_capabilities_requested,
    p_verification_documents,
    p_marketing,
    p_metadata,
    p_requested_organization_id,
    p_requested_by_user_id,
    p_ip_hash,
    p_turnstile_verified
  );
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_participant_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_participant_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN
) TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_documents_marketplace_request_ref
  ON public.driver_documents (
    (metadata->>'marketplace_participant_request_id'),
    doc_type,
    document_ref_hash
  )
  WHERE metadata->>'marketplace_participant_request_id' IS NOT NULL
    AND document_ref_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_compliance_events_marketplace_request
  ON public.driver_compliance_events (
    (payload->>'marketplace_participant_request_id'),
    event_type
  )
  WHERE payload->>'marketplace_participant_request_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION public.marketplace_driver_compliance_from_participant_request_v1(
  p_request_id UUID,
  p_driver_profile_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_doc JSONB;
  v_doc_ordinal BIGINT;
  v_doc_type TEXT;
  v_doc_ref TEXT;
  v_doc_ref_hash TEXT;
  v_is_reviewer_verified BOOLEAN;
  v_verified_documents JSONB;
  v_document_count INT := 0;
  v_event_count INT := 0;
BEGIN
  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests
   WHERE id = p_request_id
     AND status = 'approved'
     AND approved_organization_id IS NOT NULL
     AND approved_user_id IS NOT NULL
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'approved driver participant request % is unavailable', p_request_id;
  END IF;

  PERFORM 1
    FROM public.driver_profiles profile
   WHERE profile.id = p_driver_profile_id
     AND profile.organization_id = v_req.approved_organization_id
     AND profile.user_id = v_req.approved_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'driver profile % does not belong to approved participant request %',
      p_driver_profile_id,
      p_request_id;
  END IF;

  v_verified_documents := CASE
    WHEN jsonb_typeof(v_req.decision_metadata->'verified_documents') = 'array'
      THEN v_req.decision_metadata->'verified_documents'
    ELSE '[]'::jsonb
  END;

  FOR v_doc, v_doc_ordinal IN
    SELECT value, ordinality
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(v_req.verification_documents) = 'array'
          THEN v_req.verification_documents
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY
  LOOP
    IF jsonb_typeof(v_doc) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION
        'verification document % for request % must be an object',
        v_doc_ordinal,
        v_req.id;
    END IF;

    v_doc_type := lower(COALESCE(
      NULLIF(btrim(v_doc->>'document_type_key'), ''),
      NULLIF(btrim(v_doc->>'doc_type'), '')
    ));
    IF v_doc_type IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.lookup_values value
        JOIN public.lookup_definitions definition
          ON definition.id = value.lookup_definition_id
       WHERE definition.category = 'driver_document_type'
         AND value.value = v_doc_type
         AND value.status = 'active'
    ) THEN
      RAISE EXCEPTION
        'verification document % for request % has unsupported document type',
        v_doc_ordinal,
        v_req.id;
    END IF;

    v_doc_ref := NULLIF(btrim(v_doc->>'document_ref'), '');
    IF v_doc_ref IS NULL THEN
      RAISE EXCEPTION
        'verification document % for request % requires document_ref',
        v_doc_ordinal,
        v_req.id;
    END IF;

    v_doc_ref_hash := encode(
      digest(v_doc_ref, 'sha256'),
      'hex'
    );
    SELECT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_verified_documents) reviewer_doc(value)
       WHERE jsonb_typeof(reviewer_doc.value) = 'object'
         AND lower(btrim(reviewer_doc.value->>'document_type_key')) = v_doc_type
         AND btrim(reviewer_doc.value->>'document_ref') = v_doc_ref
    ) INTO v_is_reviewer_verified;

    INSERT INTO public.driver_documents (
      organization_id,
      user_id,
      doc_type,
      status,
      document_ref_hash,
      verified_at,
      metadata
    )
    SELECT
      v_req.approved_organization_id,
      v_req.approved_user_id,
      v_doc_type,
      CASE WHEN v_is_reviewer_verified THEN 'verified' ELSE 'submitted' END,
      v_doc_ref_hash,
      CASE WHEN v_is_reviewer_verified THEN v_req.reviewed_at ELSE NULL END,
      jsonb_build_object(
        'source', 'marketplace_driver_compliance_from_participant_request_v1',
        'marketplace_participant_request_id', v_req.id,
        'document_ordinal', v_doc_ordinal,
        'reviewer_verified', v_is_reviewer_verified
      )
    ON CONFLICT (
      (metadata->>'marketplace_participant_request_id'),
      doc_type,
      document_ref_hash
    ) WHERE metadata->>'marketplace_participant_request_id' IS NOT NULL
      AND document_ref_hash IS NOT NULL
    DO NOTHING;
  END LOOP;

  INSERT INTO public.driver_compliance_events (
    organization_id,
    user_id,
    event_type,
    actor_system,
    payload
  )
  SELECT
    v_req.approved_organization_id,
    v_req.approved_user_id,
    'marketplace_driver_approved',
    'marketplace_driver_compliance_from_participant_request_v1',
    jsonb_strip_nulls(jsonb_build_object(
      'marketplace_participant_request_id', v_req.id,
      'driver_profile_id', p_driver_profile_id
    ))
  ON CONFLICT (
    (payload->>'marketplace_participant_request_id'),
    event_type
  ) WHERE payload->>'marketplace_participant_request_id' IS NOT NULL
  DO NOTHING;

  SELECT count(*)::INT
    INTO v_document_count
    FROM public.driver_documents d
   WHERE d.organization_id = v_req.approved_organization_id
     AND d.user_id = v_req.approved_user_id
     AND d.metadata->>'marketplace_participant_request_id' = v_req.id::text;

  SELECT count(*)::INT
    INTO v_event_count
    FROM public.driver_compliance_events e
   WHERE e.organization_id = v_req.approved_organization_id
     AND e.user_id = v_req.approved_user_id
     AND e.payload->>'marketplace_participant_request_id' = v_req.id::text;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'fleet_document_count', v_document_count,
    'fleet_compliance_event_count', v_event_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_driver_compliance_from_participant_request_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.marketplace_driver_profile_from_participant_request_v1(UUID)
  RENAME TO marketplace_driver_profile_from_request_base_1860;

REVOKE ALL ON FUNCTION public.marketplace_driver_profile_from_request_base_1860(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.marketplace_driver_profile_from_participant_request_v1(
  p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result JSONB;
  v_compliance JSONB;
BEGIN
  v_result := public.marketplace_driver_profile_from_request_base_1860(p_request_id);
  IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE)
     AND NOT COALESCE((v_result->>'skipped')::BOOLEAN, FALSE)
     AND NULLIF(v_result->>'driver_profile_id', '') IS NOT NULL THEN
    v_compliance := public.marketplace_driver_compliance_from_participant_request_v1(
      p_request_id,
      (v_result->>'driver_profile_id')::UUID
    );
    v_result := v_result || COALESCE(v_compliance - 'ok', '{}'::jsonb);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_driver_profile_from_participant_request_v1(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_driver_profile_from_participant_request_v1(UUID)
  TO service_role;

-------------------------------------------------------------------------------
-- Lookup, policy-schema, locality, API-view, and runtime privilege convergence.
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (
  category, description, owner_role, approval_policy, is_mutable
)
VALUES (
  'marketplace_participant_review_reason',
  'Marketplace participant review reason',
  'operations',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, metadata, sort_order, is_default, status
)
SELECT d.id, v.value, v.label, v.metadata, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    (
      'marketplace_participant_review_reason',
      'compliance_document_mismatch',
      'Compliance document mismatch',
      '{"edge_case":"compliance_denied"}'::jsonb,
      10,
      FALSE
    ),
    (
      'marketplace_participant_review_reason',
      'other',
      'Other',
      '{}'::jsonb,
      100,
      TRUE
    ),
    (
      'decision_category',
      'fleet.driver_assigned',
      'Fleet driver assigned',
      '{}'::jsonb,
      920,
      FALSE
    )
) AS v(category, value, label, metadata, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    metadata = EXCLUDED.metadata,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    updated_at = now();

UPDATE public.canonical_cities c
SET name_arabic = 'الرياض',
    province = 'Riyadh',
    alternate_names = ARRAY(
      SELECT DISTINCT value
      FROM unnest(
        COALESCE(c.alternate_names, ARRAY[]::TEXT[])
          || ARRAY['Riyadh', 'Riyadh City', 'الرياض']
      ) AS value
      WHERE btrim(value) <> ''
      ORDER BY value
    ),
    updated_at = now()
WHERE lower(c.name_canonical) = 'riyadh';

DROP POLICY IF EXISTS webhook_source_token_history_service_all
  ON public.webhook_source_token_history;
CREATE POLICY webhook_source_token_history_service_all
  ON public.webhook_source_token_history
  FOR ALL TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- Correct the 1850 geocoding decision-lineage definition without changing its
-- scope, ACL, or row-driven policy semantics.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_log_match(
  p_run_id UUID,
  p_step_id UUID,
  p_policy JSONB,
  p_match JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = workflow_handlers, public, extensions, pg_temp
AS $$
DECLARE
  v_can_log BOOLEAN := COALESCE(p_policy->'logging'->>'log_scoring_details','false')::BOOLEAN;
  v_run workflow_runs%ROWTYPE;
  v_ctx RECORD;
  v_policy_record RECORD;
  v_settings_id UUID := NULL;
  v_settings_version_id UUID := NULL;
  v_version INT := NULL;
  v_scope_path JSONB := '[]'::jsonb;
  v_inputs JSONB;
  v_settings_resolution_id UUID := NULL;
BEGIN
  IF NOT v_can_log THEN RETURN; END IF;
  SELECT * INTO v_run FROM workflow_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_ctx FROM geocoding_extract_context(v_run);
  IF v_ctx.organization_id IS NULL THEN RETURN; END IF;
  IF v_ctx.sender_id IS NOT NULL THEN v_scope_path := v_scope_path || to_jsonb('sender'::text); END IF;
  IF v_ctx.client_id IS NOT NULL THEN v_scope_path := v_scope_path || to_jsonb('client'::text); END IF;
  v_scope_path := v_scope_path || to_jsonb('tenant'::text) || to_jsonb('global'::text);
  SELECT * INTO v_policy_record
  FROM public.geocoding_resolve_policy(v_ctx.organization_id, v_ctx.client_id, v_ctx.sender_id)
  LIMIT 1;
  IF v_policy_record.scope_type IS NULL THEN
    v_policy_record.scope_type := 'global';
    v_policy_record.scope_id := NULL;
  END IF;
  v_inputs := jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', p_run_id,
    'workflow_step_id', p_step_id,
    'organization_id', v_ctx.organization_id,
    'client_id', v_ctx.client_id,
    'sender_id', v_ctx.sender_id,
    'decision_point', COALESCE(p_match->>'plugin', 'geocoding'),
    'decision_outcome', COALESCE(p_match->>'match_type', 'unknown')
  ));
  SELECT s.id, s.settings_version_id, sv.version
    INTO v_settings_id, v_settings_version_id, v_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'geocoding_policy'
    AND s.scope_type = v_policy_record.scope_type
    AND s.scope_id IS NOT DISTINCT FROM v_policy_record.scope_id
  ORDER BY s.last_updated DESC
  LIMIT 1;
  IF v_settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'geocoding_policy',
      p_winning_scope_type := v_policy_record.scope_type,
      p_winning_scope_id := v_policy_record.scope_id,
      p_winning_settings_id := v_settings_id,
      p_winning_settings_version_id := v_settings_version_id,
      p_winning_version := COALESCE(v_version, 1),
      p_scope_path := v_scope_path,
      p_inputs := v_inputs,
      p_merge_notes := NULL
    );
  END IF;
  INSERT INTO decision_log (
    organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason,
    performed_by_system, correlation_id, settings_resolution_id
  ) VALUES (
    v_ctx.organization_id, 'geocoding', 'workflow_run_step', p_step_id,
    COALESCE(p_match->>'plugin', 'geocoding'), COALESCE(p_match->>'match_type', 'unknown'),
    jsonb_strip_nulls(COALESCE(p_match, '{}'::jsonb) || v_inputs), p_match->>'routing_reason',
    'workflow_handlers', p_run_id, v_settings_resolution_id
  );
END;
$$;

-------------------------------------------------------------------------------
-- API-gateway route lineage and shipment action readback.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.outbound_call_fill_api_gateway_route_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_request_id UUID;
  v_route_id UUID;
BEGIN
  IF NULLIF(NEW.context->>'api_gateway_request_id', '') IS NULL
     OR NULLIF(NEW.context->>'api_gateway_route_id', '') IS NOT NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    v_request_id := (NEW.context->>'api_gateway_request_id')::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN NEW;
  END;
  SELECT r.route_id
    INTO v_route_id
    FROM public.api_gateway_requests r
   WHERE r.id = v_request_id;
  IF v_route_id IS NOT NULL THEN
    NEW.context := jsonb_set(
      COALESCE(NEW.context, '{}'::jsonb),
      '{api_gateway_route_id}',
      to_jsonb(v_route_id),
      TRUE
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.outbound_call_fill_api_gateway_route_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS a000_fill_api_gateway_route
  ON public.outbound_calls;
CREATE TRIGGER a000_fill_api_gateway_route
  BEFORE INSERT OR UPDATE ON public.outbound_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.outbound_call_fill_api_gateway_route_v1();

ALTER FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1(outbound_calls, JSONB)
  RENAME TO process_api_gateway_outbound_response_v1_base_202608161860;

REVOKE ALL ON FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1_base_202608161860(
  outbound_calls,
  JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1(
  p_job outbound_calls,
  p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_result JSONB;
  v_request_id UUID;
  v_shipment_id UUID;
  v_org_id UUID;
  v_client_id UUID;
BEGIN
  v_result := workflow_handlers.process_api_gateway_outbound_response_v1_base_202608161860(
    p_job,
    p_response
  );

  BEGIN
    v_request_id := NULLIF(p_job.context->>'api_gateway_request_id', '')::UUID;
    v_shipment_id := NULLIF(v_result#>>'{postprocess,shipment_id}', '')::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_request_id := NULL;
      v_shipment_id := NULL;
  END;

  IF COALESCE((v_result->>'handled')::BOOLEAN, FALSE)
     AND v_request_id IS NOT NULL
     AND v_shipment_id IS NOT NULL THEN
    SELECT s.organization_id, s.client_id
      INTO v_org_id, v_client_id
      FROM public.shipments s
     WHERE s.id = v_shipment_id;

    IF v_org_id IS NOT NULL AND v_client_id IS NOT NULL THEN
      INSERT INTO public.shipment_actions (
        shipment_id,
        action_type,
        action_category,
        performed_by_system,
        action_data,
        timestamp,
        organization_id,
        client_id
      )
      SELECT
        v_shipment_id,
        'api_gateway_materialized',
        'api_gateway',
        'workflow_handlers.process_api_gateway_outbound_response_v1',
        jsonb_strip_nulls(jsonb_build_object(
          'api_gateway_request_id', v_request_id,
          'api_gateway_route_id', NULLIF(p_job.context->>'api_gateway_route_id', ''),
          'outbound_call_id', p_job.id
        )),
        now(),
        v_org_id,
        v_client_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.shipment_actions sa
        WHERE sa.shipment_id = v_shipment_id
          AND sa.action_type = 'api_gateway_materialized'
          AND sa.action_data->>'api_gateway_request_id' = v_request_id::TEXT
      );

      IF NOT EXISTS (
        SELECT 1
        FROM public.decision_log dl
        WHERE dl.organization_id = v_org_id
          AND dl.resource_type = 'shipment'
          AND dl.resource_id = v_shipment_id
          AND dl.decision_point = 'api_gateway_materialization'
          AND dl.decision_inputs->>'api_gateway_request_id' = v_request_id::TEXT
      ) THEN
        PERFORM public.log_decision(
          v_org_id,
          'shipment_create',
          'shipment',
          v_shipment_id,
          'api_gateway_materialization',
          'materialized',
          'workflow_handlers.process_api_gateway_outbound_response_v1',
          COALESCE(p_job.correlation_id, gen_random_uuid()),
          jsonb_strip_nulls(jsonb_build_object(
            'api_gateway_request_id', v_request_id,
            'api_gateway_route_id', NULLIF(p_job.context->>'api_gateway_route_id', ''),
            'outbound_call_id', p_job.id
          )),
          NULL
        );
      END IF;
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1(outbound_calls, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1(outbound_calls, JSONB)
  TO service_role;

-------------------------------------------------------------------------------
-- Reconcile shipment-applicable webhook policies already present in a runtime
-- fixture database while preserving proven active compatible custom bindings.
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_binding RECORD;
  v_setting RECORD;
  v_value JSONB;
  v_workflow JSONB;
  v_templates JSONB;
  v_resolved UUID;
  v_template RECORD;
  v_changed BOOLEAN;
BEGIN
  FOR v_setting IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           s.scope_type,
           s.scope_id,
           sv.schema_version,
           COALESCE(s.cached_value, sv.value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'webhook_ingest_policy'
      AND public.webhook_policy_applies_to_shipment_intent_v1(
        COALESCE(s.cached_value, sv.value, '{}'::jsonb),
        'shipment.create'
      )
    FOR UPDATE OF s, sv
  LOOP
    v_value := v_setting.value;
    v_workflow := CASE
      WHEN jsonb_typeof(v_value->'workflow') = 'object' THEN v_value->'workflow'
      ELSE '{}'::jsonb
    END;
    v_templates := CASE
      WHEN jsonb_typeof(v_workflow->'templates_by_intent') = 'object'
        THEN v_workflow->'templates_by_intent'
      ELSE '{}'::jsonb
    END;
    v_changed := FALSE;

    FOR v_binding IN
      SELECT binding.intent, binding.template_name, wt.id AS template_id
      FROM (
        VALUES
          ('shipment.create'::TEXT, 'webhook_shipment_create_v1'::TEXT),
          ('shipment.delete'::TEXT, 'shipment_delete_v1'::TEXT),
          ('shipment.reschedule'::TEXT, 'shipment_reschedule_v1'::TEXT)
      ) AS binding(intent, template_name)
      LEFT JOIN LATERAL (
        SELECT candidate.id
        FROM public.workflow_templates candidate
        WHERE candidate.name = binding.template_name
          AND candidate.status = 'active'
        ORDER BY candidate.version DESC, candidate.updated_at DESC
        LIMIT 1
      ) wt ON TRUE
    LOOP
      IF NOT public.webhook_policy_applies_to_shipment_intent_v1(v_value, v_binding.intent) THEN
        CONTINUE;
      END IF;

      IF v_binding.template_id IS NULL THEN
        RAISE EXCEPTION 'canonical active % template is missing', v_binding.template_name;
      END IF;

      v_resolved := public.resolve_webhook_followup_template_id_v1(v_value, v_binding.intent);
      SELECT id, name, status
        INTO v_template
        FROM public.workflow_templates
       WHERE id = v_resolved;

      IF v_resolved IS NULL
         OR v_template.name IN ('async_provider_dispatch_v1', 'webhook_intake_v1') THEN
        v_templates := jsonb_set(
          v_templates,
          ARRAY[v_binding.intent],
          jsonb_build_object(
            'template_id', v_binding.template_id,
            'template_name', v_binding.template_name
          ),
          TRUE
        );
        v_changed := TRUE;
      ELSIF v_template.id IS NULL
         OR v_template.status <> 'active'
         OR NOT public.workflow_template_supports_shipment_intent_v1(v_template.id, v_binding.intent) THEN
        RAISE EXCEPTION
          'webhook % policy references unsupported template %',
          v_binding.intent,
          v_resolved;
      END IF;
    END LOOP;

    IF v_changed THEN
      v_workflow := v_workflow || jsonb_build_object(
        'intent', 'shipment.create',
        'templates_by_intent', v_templates
      );
      v_value := jsonb_set(v_value, '{workflow}', v_workflow, TRUE);
      PERFORM 1
        FROM public.upsert_settings_value_v1(
          'webhook_ingest_policy',
          v_setting.scope_type,
          v_setting.scope_id,
          v_value,
          GREATEST(v_setting.schema_version, 2),
          'runtime failure-wave shipment workflow binding reconciliation'
        );
    END IF;
  END LOOP;
END;
$$;

COMMIT;

-- Migration: Fix local lookup ordering (include updated_at) and JSON casting
-- Purpose: ensure execute_geo_local_lookup_v1 orders by updated_at without missing columns and parses raw_input safely.

BEGIN;

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
    v_policy_record RECORD;
    v_policy JSONB;
    v_local_cfg JSONB;
    v_enabled BOOLEAN := TRUE;
    v_min_conf NUMERIC := 0.7;
    v_prefer_district BOOLEAN := TRUE;
    v_address RECORD;
    v_raw JSONB := '{}'::jsonb;
    v_city_text TEXT;
    v_district_text TEXT;
    v_country_text TEXT;
    v_province_text TEXT;
    v_city RECORD;
    v_district RECORD;
    v_city_score NUMERIC := 0;
    v_district_score NUMERIC;
    v_confidence NUMERIC := 0;
    v_centroid GEOGRAPHY;
    v_attempt_id UUID;
    v_geocode JSONB;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'address_missing'
        );
        RETURN v_response;
    END IF;

    SELECT * INTO v_policy_record
    FROM public.geocoding_resolve_policy(
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id
    )
    LIMIT 1;

    IF NOT FOUND THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'policy_missing'
        );
        RETURN v_response;
    END IF;

    v_policy := v_policy_record.policy;
    v_local_cfg := COALESCE(v_policy->'local_lookup', '{}'::jsonb);
    v_enabled := COALESCE((v_local_cfg->>'enabled')::BOOLEAN, TRUE);
    v_min_conf := COALESCE((v_local_cfg->>'min_confidence')::NUMERIC, 0.7);
    v_prefer_district := COALESCE((v_local_cfg->>'prefer_district_centroid')::BOOLEAN, TRUE);

    IF NOT v_enabled THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'local_lookup_disabled'
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

    IF v_city_text IS NULL THEN
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
                v_province_text IS NULL
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
            WHERE d.organization_id = v_ctx.organization_id
              AND d.city_id = v_city.id
              AND d.is_active = TRUE
        )
        SELECT *
        INTO v_district
        FROM district_matches
        ORDER BY exact_match DESC, score DESC, updated_at DESC
        LIMIT 1;

        IF FOUND AND v_district.score IS NOT NULL THEN
            IF v_district.score >= v_min_conf THEN
                v_district_score := v_district.score;
            END IF;
        END IF;
    END IF;

    v_confidence := COALESCE(v_district_score, v_city_score);
    v_centroid := CASE
        WHEN v_prefer_district AND v_district.centroid IS NOT NULL THEN v_district.centroid
        ELSE v_city.centroid
    END;

    IF v_centroid IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'centroid_missing'
        );
        RETURN v_response;
    END IF;

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
            'province', v_province_text
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
        jsonb_build_object('geocode', v_geocode, 'match_source', 'canonical_lookup'),
        now(),
        now()
    )
    RETURNING id INTO v_attempt_id;

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
            'successful', TRUE,
            'require_fallback', FALSE
        ))
    );

    RETURN v_response;
END;
$$;

ALTER FUNCTION workflow_handlers.execute_geo_local_lookup_v1(workflow_run_steps, workflow_runs, JSONB)
    SET search_path = workflow_handlers, public, extensions, pg_temp;

COMMIT;

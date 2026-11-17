-- Migration: Geocoding local lookup + cache TTL + workflow update
-- Purpose:
--   - Add policy-driven cache TTL to geocode writes.
--   - Introduce canonical local lookup handler to support local-only / local-first workflows.
--   - Update workflow template to include the local lookup step and skip provider dispatch when resolved.
--   - Ensure provider dispatch respects early success and avoids unnecessary external calls.

BEGIN;

-- Allow local attempt_type in geocoding_attempts
ALTER TABLE public.geocoding_attempts
    DROP CONSTRAINT IF EXISTS geocoding_attempts_attempt_type_check;
ALTER TABLE public.geocoding_attempts
    ADD CONSTRAINT geocoding_attempts_attempt_type_check
    CHECK (attempt_type IN ('primary', 'fallback', 'retry', 'manual_review', 'cache_hit', 'local'));

-- =============================================================================
-- 1) Expand geocoding_policy with cache_ttl_minutes and local_lookup defaults
-- =============================================================================
WITH updated AS (
    UPDATE settings_versions sv
    SET value = jsonb_set(
                    jsonb_set(
                        sv.value,
                        '{cache_ttl_minutes}',
                        to_jsonb(COALESCE((sv.value->>'cache_ttl_minutes')::INT, 1440)),
                        true
                    ),
                    '{local_lookup}',
                    COALESCE(
                        sv.value->'local_lookup',
                        jsonb_build_object(
                            'enabled', true,
                            'min_confidence', 0.7,
                            'prefer_district_centroid', true,
                            'allow_provider_fallback', true
                        )
                    ),
                    true
                )
    WHERE sv.category = 'geocoding_policy'
    RETURNING sv.id, sv.value
)
UPDATE settings s
SET cached_value = u.value,
    last_updated = now()
FROM updated u
WHERE s.settings_version_id = u.id;

-- =============================================================================
-- 2) Insert local lookup step into workflow_geocoding_standard
-- =============================================================================
DO $$
DECLARE
    v_template_id UUID;
    v_local_step_id UUID := '99990000-0000-0000-0000-000000410003';
BEGIN
    SELECT id INTO v_template_id
    FROM workflow_templates
    WHERE name = 'workflow_geocoding_standard'
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard not found; skipping step insert';
        RETURN;
    END IF;

    -- Shift sequence_order for downstream steps to make room for local_lookup at position 4.
    UPDATE workflow_template_steps
    SET sequence_order = sequence_order + 1
    WHERE workflow_template_id = v_template_id
      AND sequence_order >= 4;

    -- Insert the local lookup step (idempotent).
    INSERT INTO workflow_template_steps (
        id,
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        handler_key,
        handler_version,
        metadata,
        manual_action_required,
        enabled
    )
    VALUES (
        v_local_step_id,
        v_template_id,
        4,
        'local_lookup',
        'geocoding',
        'always',
        'geo_local_lookup',
        'v1',
        jsonb_build_object(
            'decision_log_event', 'geocoding.local_lookup'
        ),
        FALSE,
        TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET sequence_order = EXCLUDED.sequence_order,
        metadata = EXCLUDED.metadata,
        updated_at = now();

    -- Recompute steps_checksum to keep workflow template consistent.
    WITH ordered_steps AS (
        SELECT
            sequence_order,
            jsonb_build_object(
                'sequence_order', sequence_order,
                'operation_name', operation_name,
                'handler_key', handler_key,
                'handler_version', handler_version,
                'metadata', COALESCE(metadata, '{}'::jsonb)
            ) AS payload
        FROM public.workflow_template_steps
        WHERE workflow_template_id = v_template_id
        ORDER BY sequence_order
    ),
    hashed AS (
        SELECT md5(coalesce(jsonb_agg(payload ORDER BY sequence_order)::text, '')) AS checksum
        FROM ordered_steps
    )
    UPDATE public.workflow_templates wt
    SET steps_checksum = hashed.checksum,
        updated_at = now()
    FROM hashed
    WHERE wt.id = v_template_id;
END
$$;

-- =============================================================================
-- 3) Local lookup handler (canonical city/district centroids)
-- =============================================================================
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

    v_city_text := COALESCE(NULLIF(v_address.city, ''), NULLIF(v_address.raw_input->>'city', ''));
    v_district_text := COALESCE(NULLIF(v_address.district, ''), NULLIF(v_address.raw_input->>'district', ''));
    v_country_text := COALESCE(NULLIF(v_address.country, ''), NULLIF(v_address.raw_input->>'country', ''), 'SA');
    v_province_text := COALESCE(NULLIF(v_address.province, ''), NULLIF(v_address.raw_input->>'province', ''));

    IF v_city_text IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'matched', FALSE,
            'reason', 'city_missing'
        );
        RETURN v_response;
    END IF;

    -- City match (exact preferred, trigram/alternate fallback)
    WITH city_matches AS (
        SELECT
            c.id,
            c.name_canonical,
            c.name_arabic,
            c.centroid,
            c.source_city_id,
            c.province,
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

    -- District match (if provided)
    IF v_district_text IS NOT NULL THEN
        WITH district_matches AS (
            SELECT
                d.id,
                d.name_canonical,
                d.name_arabic,
                d.centroid,
                d.source_district_id,
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

-- =============================================================================
-- 4) Cache handler: policy-driven TTL + coordinate validation
-- =============================================================================
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_cache_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_action TEXT := lower(COALESCE(NULLIF(v_metadata->>'action', ''), 'read'));
    v_ctx RECORD;
    v_policy_record RECORD;
    v_policy JSONB;
    v_cache_ttl INT := 1440;
    v_expires_at TIMESTAMPTZ;
    v_geocode RECORD;
    v_geocode_json JSONB;
    v_lat NUMERIC;
    v_lon NUMERIC;
    v_set_primary BOOLEAN := COALESCE((v_metadata->>'set_primary')::BOOLEAN, TRUE);
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'cache_hit', FALSE,
            'reason', 'address_missing'
        );
        RETURN v_response;
    END IF;

    IF v_action = 'read' THEN
        SELECT
            g.id,
            g.provider_name,
            g.confidence_score,
            g.accuracy_type,
            g.formatted_address,
            g.metadata,
            g.expires_at,
            ST_Y(g.coordinates::geometry) AS latitude,
            ST_X(g.coordinates::geometry) AS longitude,
            g.is_primary,
            g.geocoded_at
        INTO v_geocode
        FROM public.geocodes g
        WHERE g.address_id = v_ctx.address_id
          AND (g.expires_at IS NULL OR g.expires_at > now())
        ORDER BY g.is_primary DESC, g.geocoded_at DESC
        LIMIT 1;

        IF FOUND THEN
            v_geocode_json := jsonb_build_object(
                'id', v_geocode.id,
                'provider_name', v_geocode.provider_name,
                'confidence_score', v_geocode.confidence_score,
                'accuracy_type', v_geocode.accuracy_type,
                'formatted_address', v_geocode.formatted_address,
                'coordinates', jsonb_build_object(
                    'latitude', v_geocode.latitude,
                    'longitude', v_geocode.longitude
                ),
                'metadata', COALESCE(v_geocode.metadata, '{}'::jsonb),
                'is_primary', v_geocode.is_primary,
                'geocoded_at', v_geocode.geocoded_at,
                'expires_at', v_geocode.expires_at
            );

            v_response.operation_result := jsonb_build_object(
                'cache_hit', TRUE,
                'geocode', v_geocode_json
            );
        ELSE
            v_response.operation_result := jsonb_build_object(
                'cache_hit', FALSE
            );
        END IF;

        v_response.status := 'completed';
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'cache_hit', v_response.operation_result->>'cache_hit',
                'cache_geocode', v_geocode_json,
                'cache_expires_at', v_geocode.expires_at
            ))
        );
        RETURN v_response;
    ELSIF v_action = 'write' THEN
        v_geocode_json := COALESCE(
            p_operation_result->'geocode',
            v_metadata->'geocode',
            p_run.context->'geocoding'->'selected_geocode'
        );

        IF v_geocode_json IS NULL THEN
            v_response.status := 'completed';
            v_response.operation_result := jsonb_build_object(
                'written', FALSE,
                'reason', 'geocode_payload_missing'
            );
            RETURN v_response;
        END IF;

        v_lat := COALESCE(
            (v_geocode_json->'coordinates'->>'latitude')::NUMERIC,
            (v_geocode_json->'coordinates'->>'lat')::NUMERIC
        );
        v_lon := COALESCE(
            (v_geocode_json->'coordinates'->>'longitude')::NUMERIC,
            (v_geocode_json->'coordinates'->>'lng')::NUMERIC
        );

        IF v_lat IS NULL OR v_lon IS NULL OR v_lat = 0 OR v_lon = 0
           OR v_lat NOT BETWEEN -90 AND 90
           OR v_lon NOT BETWEEN -180 AND 180 THEN
            v_response.status := 'completed';
            v_response.operation_result := jsonb_build_object(
                'written', FALSE,
                'reason', 'invalid_coordinates'
            );
            RETURN v_response;
        END IF;

        SELECT *
        INTO v_policy_record
    FROM public.geocoding_resolve_policy(
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id
    )
    LIMIT 1;

        IF FOUND THEN
            v_policy := v_policy_record.policy;
            v_cache_ttl := COALESCE(
                (v_policy->>'cache_ttl_minutes')::INT,
                v_cache_ttl
            );
        END IF;

        v_cache_ttl := COALESCE(v_cache_ttl, 0);
        v_expires_at := CASE
            WHEN v_cache_ttl > 0 THEN now() + make_interval(mins => v_cache_ttl)
            ELSE NULL
        END;

        IF v_set_primary THEN
            UPDATE public.geocodes
            SET is_primary = FALSE,
                updated_at = now()
            WHERE address_id = v_ctx.address_id
              AND is_primary = TRUE;
        END IF;

        INSERT INTO public.geocodes (
            id,
            address_id,
            provider_name,
            coordinates,
            confidence_score,
            accuracy_type,
            formatted_address,
            metadata,
            is_primary,
            geocoded_at,
            organization_id,
            client_id,
            expires_at
        )
        VALUES (
            COALESCE((v_geocode_json->>'id')::UUID, gen_random_uuid()),
            v_ctx.address_id,
            COALESCE(v_geocode_json->>'provider_name', 'manual'),
            ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326)::geography,
            (v_geocode_json->>'confidence_score')::NUMERIC,
            v_geocode_json->>'accuracy_type',
            v_geocode_json->>'formatted_address',
            jsonb_strip_nulls(COALESCE(v_geocode_json->'metadata', '{}'::jsonb) || jsonb_build_object(
                'cache_policy', jsonb_build_object('ttl_minutes', v_cache_ttl)
            )),
            COALESCE((v_geocode_json->>'is_primary')::BOOLEAN, TRUE),
            COALESCE((v_geocode_json->>'geocoded_at')::TIMESTAMPTZ, now()),
            v_ctx.organization_id,
            v_ctx.client_id,
            v_expires_at
        )
        ON CONFLICT (id, address_id) DO UPDATE
        SET provider_name = EXCLUDED.provider_name,
            coordinates = EXCLUDED.coordinates,
            confidence_score = EXCLUDED.confidence_score,
            accuracy_type = EXCLUDED.accuracy_type,
            formatted_address = EXCLUDED.formatted_address,
            metadata = EXCLUDED.metadata,
            is_primary = EXCLUDED.is_primary,
            geocoded_at = EXCLUDED.geocoded_at,
            expires_at = EXCLUDED.expires_at,
            updated_at = now();

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'written', TRUE,
            'geocode', v_geocode_json,
            'expires_at', v_expires_at,
            'ttl_minutes', v_cache_ttl
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'cache_written', TRUE,
                'cache_expires_at', v_expires_at,
                'selected_geocode', v_geocode_json
            ))
        );
        RETURN v_response;
    ELSE
        RAISE EXCEPTION 'execute_geocode_cache_v1: unsupported action % for step %', v_action, p_step.id;
    END IF;
END;
$$;

-- =============================================================================
-- 5) Provider dispatch: skip when already resolved
-- =============================================================================
CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
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
    v_provider_candidates TEXT[];
    v_sequence_index INT;
    v_candidate_index INT;
    v_provider RECORD;
    v_provider_name TEXT;
    v_template operation_templates%ROWTYPE;
    v_template_metadata JSONB;
    v_template_query JSONB;
    v_query_context JSONB;
    v_query_element JSONB;
    v_query_string TEXT := '';
    v_address RECORD;
    v_address_text TEXT;
    v_lang TEXT := COALESCE(NULLIF(v_metadata->>'lang', ''), 'en');
    v_limit INT := COALESCE((v_metadata->>'limit')::INT, 1);
    v_attempt_type TEXT := COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary');
    v_step_record workflow_run_steps%ROWTYPE;
    v_api_key TEXT;
    v_backpressure JSONB;
    v_queue_depth INT := 0;
    v_max_queue_depth INT;
    v_throttle_depth INT;
    v_delay_seconds INT;
    v_resume_seconds INT;
    v_response workflow_handler_response;
    v_value JSONB;
    v_value_text TEXT;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    -- If geocoding already successful, skip outbound provider dispatch.
    IF COALESCE(p_run.context->'geocoding'->>'successful', 'false')::BOOLEAN THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'skipped', TRUE,
            'reason', 'geocoding_already_resolved'
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'dispatch_skipped', TRUE
            )
        );
        RETURN v_response;
    END IF;

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
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

    IF v_policy IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: geocoding_policy missing for workflow_run %', p_step.workflow_run_id;
    END IF;

    v_backpressure := COALESCE(v_policy->'backpressure', '{}'::jsonb);
    v_max_queue_depth := COALESCE((v_backpressure->>'max_queue_depth')::INT, NULL);
    v_throttle_depth := COALESCE((v_backpressure->>'throttle_ingest_at')::INT, NULL);
    v_delay_seconds := COALESCE((v_backpressure->>'throttle_delay_seconds')::INT, 30);
    v_resume_seconds := COALESCE((v_backpressure->>'resume_after_seconds')::INT, 120);

    IF v_max_queue_depth IS NOT NULL OR v_throttle_depth IS NOT NULL THEN
        SELECT COALESCE(COUNT(*), 0)
        INTO v_queue_depth
        FROM workflow_runs wr
        JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
        JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
        LEFT JOIN LATERAL geocoding_extract_context(wr) ctx ON TRUE
        WHERE wt.name LIKE 'workflow_geocoding%'
          AND wrs.operation_name IN ('dispatch_provider', 'fallback_provider')
          AND wrs.step_status IN ('pending', 'in_progress')
          AND wr.id <> p_run.id
          AND ctx.client_id IS NOT NULL
          AND ctx.client_id = v_ctx.client_id;

        IF v_max_queue_depth IS NOT NULL
           AND v_queue_depth >= v_max_queue_depth
           AND COALESCE((v_backpressure->>'pause_workflow_when_full')::BOOLEAN, FALSE) THEN
            v_response.status := 'pending';
            v_response.next_run_at := now() + make_interval(secs => GREATEST(v_resume_seconds, 30));
            v_response.operation_result := jsonb_build_object(
                'skipped', TRUE,
                'reason', 'backpressure_max_queue',
                'queue_depth', v_queue_depth,
                'max_queue_depth', v_max_queue_depth
            );
            v_response.context_patch := jsonb_build_object(
                'geocoding', jsonb_build_object(
                    'backpressure', jsonb_build_object(
                        'status', 'paused',
                        'queue_depth', v_queue_depth,
                        'max_queue_depth', v_max_queue_depth
                    )
                )
            );
            RETURN v_response;
        ELSIF v_throttle_depth IS NOT NULL AND v_queue_depth >= v_throttle_depth THEN
            v_response.status := 'pending';
            v_response.next_run_at := now() + make_interval(secs => GREATEST(v_delay_seconds, 10));
            v_response.operation_result := jsonb_build_object(
                'skipped', TRUE,
                'reason', 'backpressure_throttle',
                'queue_depth', v_queue_depth,
                'throttle_ingest_at', v_throttle_depth
            );
            v_response.context_patch := jsonb_build_object(
                'geocoding', jsonb_build_object(
                    'backpressure', jsonb_build_object(
                        'status', 'throttled',
                        'queue_depth', v_queue_depth,
                        'throttle_ingest_at', v_throttle_depth
                    )
                )
            );
            RETURN v_response;
        END IF;
    END IF;

    v_provider_candidates := ARRAY(
        SELECT elem::TEXT
        FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb)) AS elem
        WHERE elem::TEXT NOT IN ('internal_cache', 'manual_review_virtual')
    );

    v_sequence_index := COALESCE(
        NULLIF(v_metadata->>'provider_sequence_index', '')::INT,
        0
    );

    v_candidate_index := v_sequence_index;
    WHILE v_candidate_index < COALESCE(array_length(v_provider_candidates, 1), 0) LOOP
        v_provider_name := v_provider_candidates[v_candidate_index + 1];

        SELECT pr.* INTO v_provider
        FROM providers pr
        WHERE pr.name = v_provider_name
        LIMIT 1;

        IF v_provider.id IS NULL THEN
            v_candidate_index := v_candidate_index + 1;
            CONTINUE;
        END IF;

        SELECT *
        INTO v_template
        FROM operation_templates ot
        WHERE ot.provider_id = v_provider.id
          AND ot.operation_name = COALESCE(
                NULLIF(v_metadata->>'operation_name', ''),
                CASE
                    WHEN v_provider.name = 'google_maps' THEN 'geocoding_google_forward_v1'
                    ELSE 'geocoding_here_forward_v1'
                END
          )
          AND COALESCE(ot.metadata->>'operation_role', '') = 'geocoding_forward'
        ORDER BY ot.updated_at DESC
        LIMIT 1;

        IF v_template.id IS NOT NULL THEN
            EXIT;
        END IF;

        v_candidate_index := v_candidate_index + 1;
    END LOOP;

    IF v_template.id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: operation template missing for provider %', v_provider_name;
    END IF;

    SELECT credentials->>'api_key'
    INTO v_api_key
    FROM provider_auth_configs
    WHERE provider_id = v_provider.id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_api_key IS NULL OR v_api_key = '' THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: API key missing for provider %', v_provider.name;
    END IF;

    SELECT
        COALESCE(a.normalized_line1, a.line1, (a.raw_input::jsonb)->>'line1', '') AS line1,
        COALESCE(a.normalized_line2, a.line2, (a.raw_input::jsonb)->>'line2', '') AS line2,
        COALESCE(a.district, '') AS district,
        COALESCE(a.city, (a.raw_input::jsonb)->>'city', '') AS city,
        COALESCE(a.province, (a.raw_input::jsonb)->>'province', '') AS province,
        COALESCE(a.country, (a.raw_input::jsonb)->>'country', '') AS country
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id;

    v_address_text := COALESCE(
        NULLIF(p_run.context->'geocoding'->>'normalized_address', ''),
        NULLIF(trim(concat_ws(
            ' ',
            NULLIF(v_address.line1, ''),
            NULLIF(v_address.line2, ''),
            NULLIF(v_address.district, ''),
            NULLIF(v_address.city, ''),
            NULLIF(v_address.province, ''),
            NULLIF(v_address.country, '')
        )), '')
    );

    IF v_address_text IS NULL OR v_address_text = '' THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: normalized address unavailable for workflow_run_step %', p_step.id;
    END IF;

    v_template_metadata := COALESCE(v_template.metadata, '{}'::jsonb);
    v_template_query := COALESCE(v_template_metadata->'url_query_mapping', '[]'::jsonb);

    v_query_context := jsonb_strip_nulls(
        jsonb_build_object(
            'address', jsonb_strip_nulls(
                jsonb_build_object(
                    'text', v_address_text,
                    'lang', v_lang,
                    'limit', v_limit
                )
            ),
            'provider', jsonb_strip_nulls(
                jsonb_build_object(
                    'api_key', v_api_key,
                    'name', v_provider.name
                )
            ),
            'policy', v_policy,
            'step', COALESCE(p_step.metadata, '{}'::jsonb),
            'run', jsonb_strip_nulls(
                jsonb_build_object(
                    'id', p_run.id,
                    'attempt_type', v_attempt_type
                )
            )
        )
    );

    v_query_string := '';
    FOR v_query_element IN SELECT * FROM jsonb_array_elements(v_template_query)
    LOOP
        IF COALESCE(v_query_element->>'param', '') = '' THEN
            CONTINUE;
        END IF;

        v_value := safe_jsonpath_query_first(
            v_query_context,
            COALESCE(v_query_element->>'value_path', '')
        );

        IF v_value IS NULL OR v_value = 'null'::jsonb THEN
            CONTINUE;
        END IF;

        v_value_text := CASE jsonb_typeof(v_value)
            WHEN 'string' THEN trim(both '\"' FROM v_value::TEXT)
            ELSE v_value::TEXT
        END;

        IF v_value_text IS NULL OR v_value_text = '' THEN
            CONTINUE;
        END IF;

        v_query_string := v_query_string ||
            CASE WHEN v_query_string = '' THEN '' ELSE '&' END ||
            format('%s=%s',
                   COALESCE(v_query_element->>'param', ''),
                   public.urlencode(v_value_text));
    END LOOP;

    v_step_record := p_step;

    v_step_record.metadata := jsonb_strip_nulls(
        COALESCE(p_step.metadata, '{}'::jsonb)
        || jsonb_build_object(
            'operation_template_id', v_template.id::TEXT,
            'override_url',
                v_template.url_template ||
                CASE
                    WHEN v_query_string IS NULL OR v_query_string = '' THEN ''
                    WHEN position('?' IN v_template.url_template) > 0 THEN '&' || v_query_string
                    ELSE '?' || v_query_string
                END,
            'provider_id', v_provider.id::TEXT,
            'provider_name', v_provider.name,
            'provider_sequence_index', v_sequence_index,
            'attempt_type', v_attempt_type,
            'lang', v_lang,
            'limit', v_limit
        )
    );

    UPDATE workflow_run_steps
    SET metadata = v_step_record.metadata,
        updated_at = now()
    WHERE id = p_step.id;

    RETURN workflow_handlers.execute_outbound_http_v1(
        v_step_record,
        p_run,
        p_operation_result
    );
END;
$$;

-- =============================================================================
-- 6) Decision: respect early success and local attempts
-- =============================================================================
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

    -- If already successful (e.g., local lookup), short-circuit.
    IF COALESCE(p_run.context->'geocoding'->>'successful', 'false')::BOOLEAN THEN
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
    ORDER BY created_at DESC
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
$$;

-- Ensure search_path is set for all updated handlers
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
              'execute_geo_decision_v1'
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

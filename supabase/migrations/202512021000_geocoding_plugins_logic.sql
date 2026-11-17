-- Migration: Geocoding plugins logic + alias audit wiring
-- Purpose: Honor geocoding_policy.matching_plugins (perfect/fuzzy/long_line/reverse), enrich decision_log scoring payloads, and wire alias auto-learn audit.
-- Alignment: SIMPLE/SCALABLE/DYNAMIC, zero hardcoding. Behaviour remains workflow/row-driven.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- Helper: resolve geocoding policy for context (sender > client > tenant > global).
CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_resolve_policy_for_run(p_run workflow_runs)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_ctx RECORD;
  v_policy JSONB := NULL;
BEGIN
  SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

  IF v_ctx.sender_id IS NOT NULL THEN
    SELECT resolve_settings('geocoding_policy','sender',v_ctx.sender_id) INTO v_policy;
  END IF;
  IF v_policy IS NULL AND v_ctx.client_id IS NOT NULL THEN
    SELECT resolve_settings('geocoding_policy','client',v_ctx.client_id) INTO v_policy;
  END IF;
  IF v_policy IS NULL AND v_ctx.organization_id IS NOT NULL THEN
    SELECT resolve_settings('geocoding_policy','tenant',v_ctx.organization_id) INTO v_policy;
  END IF;
  IF v_policy IS NULL THEN
    SELECT resolve_settings('geocoding_policy','global',NULL) INTO v_policy;
  END IF;

  RETURN COALESCE(v_policy, '{}'::jsonb);
END;
$$;

COMMENT ON FUNCTION workflow_handlers.geocoding_resolve_policy_for_run(workflow_runs)
  IS 'Resolves geocoding_policy for a workflow_run (sender > client > tenant > global).';

-- Helper: fetch plugin config by name from geocoding_policy.matching_plugins
CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_get_plugin(p_policy JSONB, p_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_plugin JSONB;
BEGIN
  SELECT elem
  INTO v_plugin
  FROM jsonb_array_elements(COALESCE(p_policy->'matching_plugins', '[]'::jsonb)) elem
  WHERE lower(elem->>'name') = lower(p_name)
  LIMIT 1;

  RETURN v_plugin;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.geocoding_get_plugin(JSONB, TEXT)
  IS 'Returns the matching_plugins entry for the requested plugin name.';

-- Helper: coalesce logging flag (scoped by policy.logging.log_tokens)
CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_should_log_tokens(p_policy JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN COALESCE(p_policy->'logging'->>'log_tokens', 'false')::BOOLEAN;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.geocoding_should_log_tokens(JSONB)
  IS 'Returns TRUE when policy.logging.log_tokens is enabled.';

-- Helper: log scoring decision to decision_log if enabled in policy.logging.log_scoring_details.
CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_log_match(
  p_run_id UUID,
  p_step_id UUID,
  p_policy JSONB,
  p_match JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_can_log BOOLEAN := COALESCE(p_policy->'logging'->>'log_scoring_details','false')::BOOLEAN;
  v_org UUID;
BEGIN
  IF NOT v_can_log THEN
    RETURN;
  END IF;

  SELECT organization_id INTO v_org FROM workflow_runs WHERE id = p_run_id;
  IF v_org IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO decision_log (
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    decision_reason,
    performed_by_system,
    correlation_id,
    settings_resolution_id
  )
  VALUES (
    v_org,
    'geocoding',
    'workflow_run_step',
    p_step_id,
    COALESCE(p_match->>'plugin', 'geocoding'),
    COALESCE(p_match->>'match_type', 'unknown'),
    jsonb_strip_nulls(p_match),
    p_match->>'routing_reason',
    'workflow_handlers',
    NULL,
    NULL
  );
END;
$$;

COMMENT ON FUNCTION workflow_handlers.geocoding_log_match(UUID, UUID, JSONB, JSONB)
  IS 'Writes geocoding match details into decision_log when policy logging is enabled (noop if helper is absent).';

-- Cache handler with plugin-aware logging and schema-qualified policy resolver.
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
    v_policy JSONB := '{}'::jsonb;
    v_logging JSONB := '{}'::jsonb;
    v_geocode RECORD;
    v_response workflow_handler_response;
    v_result JSONB;
    v_geocode_json JSONB;
    v_match JSONB := NULL;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);
    v_policy := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_logging := COALESCE(v_policy->'logging','{}'::jsonb);

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
                'geocoded_at', v_geocode.geocoded_at
            );

            v_result := jsonb_build_object(
                'cache_hit', TRUE,
                'geocode', v_geocode_json
            );
        ELSE
            v_result := jsonb_build_object(
                'cache_hit', FALSE
            );
        END IF;

        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', 'cache',
            'match_type', CASE WHEN (v_result->>'cache_hit')::BOOLEAN THEN 'cache_hit' ELSE 'cache_miss' END,
            'routing_reason', CASE WHEN (v_result->>'cache_hit')::BOOLEAN THEN 'cache_short_circuit' ELSE 'cache_miss' END
        ));

        v_response.status := 'completed';
        v_response.operation_result := v_result;
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'cache_hit', v_result->>'cache_hit',
                'cache_geocode', v_result->'geocode'
            )
        );

        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);
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

        IF v_geocode_json ? 'is_primary' AND (v_geocode_json->>'is_primary')::BOOLEAN THEN
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
            client_id
        )
        VALUES (
            COALESCE((v_geocode_json->>'id')::UUID, gen_random_uuid()),
            v_ctx.address_id,
            COALESCE(v_geocode_json->>'provider_name', 'manual'),
            ST_SetSRID(
                ST_MakePoint(
                    COALESCE((v_geocode_json->'coordinates'->>'longitude')::DOUBLE PRECISION, 0),
                    COALESCE((v_geocode_json->'coordinates'->>'latitude')::DOUBLE PRECISION, 0)
                ),
                4326
            )::geography,
            (v_geocode_json->>'confidence_score')::NUMERIC,
            v_geocode_json->>'accuracy_type',
            v_geocode_json->>'formatted_address',
            COALESCE(v_geocode_json->'metadata', '{}'::jsonb),
            COALESCE((v_geocode_json->>'is_primary')::BOOLEAN, TRUE),
            COALESCE((v_geocode_json->>'geocoded_at')::TIMESTAMPTZ, now()),
            v_ctx.organization_id,
            v_ctx.client_id
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
            updated_at = now();

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'written', TRUE,
            'geocode', v_geocode_json
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'cache_written', TRUE,
                'selected_geocode', v_geocode_json
            )
        );
        RETURN v_response;
    ELSE
        RAISE EXCEPTION 'execute_geocode_cache_v1: unsupported action % for step %', v_action, p_step.id;
    END IF;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_geocode_cache_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Geocoding cache read/write handler (plugin-aware, logs cache hit/miss when enabled).';

-- Update reverse validator to honor reverse plugin enablement and log routing.
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_coordinate_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_require_bounds BOOLEAN := COALESCE((v_metadata->>'validate_bounds')::BOOLEAN, FALSE);
    v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_logging JSONB := COALESCE(v_policy->'logging', '{}'::jsonb);
    v_reverse_plugin JSONB := geocoding_get_plugin(v_policy, 'reverse');
    v_reverse_enabled BOOLEAN := COALESCE(v_reverse_plugin->>'enabled', 'true')::BOOLEAN;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_coordinates JSONB;
    v_lat NUMERIC;
    v_lon NUMERIC;
    v_within_bounds BOOLEAN := TRUE;
    v_response workflow_handler_response;
    v_match JSONB := NULL;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    v_coordinates := COALESCE(
        v_context->'shipment'->'coordinates',
        v_context->'geocoding'->'provided_coordinates',
        NULL
    );

    IF NOT v_reverse_enabled THEN
        v_within_bounds := FALSE;
    ELSIF v_coordinates IS NOT NULL THEN
        v_lat := COALESCE((v_coordinates->>'latitude')::NUMERIC, (v_coordinates->>'lat')::NUMERIC);
        v_lon := COALESCE((v_coordinates->>'longitude')::NUMERIC, (v_coordinates->>'lng')::NUMERIC);

        IF v_require_bounds THEN
            v_within_bounds := v_lat BETWEEN -90 AND 90 AND v_lon BETWEEN -180 AND 180;
        END IF;
    ELSE
        v_within_bounds := FALSE;
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'coordinates_present', v_coordinates IS NOT NULL,
        'within_bounds', v_within_bounds,
        'reverse_enabled', v_reverse_enabled
    );
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_build_object(
            'provided_coordinates', v_coordinates,
            'coordinates_valid', v_within_bounds,
            'reverse_plugin_enabled', v_reverse_enabled
        )
    );

    v_match := jsonb_strip_nulls(jsonb_build_object(
      'plugin', 'reverse',
      'match_type', CASE
                      WHEN NOT v_reverse_enabled THEN 'reverse_disabled'
                      WHEN v_coordinates IS NULL THEN 'reverse_missing'
                      ELSE 'reverse_bounds'
                    END,
      'coords_valid', v_within_bounds,
      'routing_reason', CASE
                          WHEN NOT v_reverse_enabled THEN 'reverse_plugin_disabled'
                          WHEN v_coordinates IS NULL THEN 'reverse_payload_missing'
                          WHEN NOT v_within_bounds THEN 'reverse_out_of_bounds'
                          ELSE 'reverse_ok'
                        END
    ));

    PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Validates provided coordinates, honours reverse plugin enablement, and logs reverse plugin routing.';

-- Update local lookup to include plugin-aware scoring and logging.
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
    v_log_tokens BOOLEAN := geocoding_should_log_tokens(v_policy);
    v_local_cfg JSONB;
    v_plugins JSONB := COALESCE(v_policy->'matching_plugins', '[]'::jsonb);
    v_perfect JSONB := geocoding_get_plugin(v_policy, 'perfect');
    v_fuzzy JSONB := geocoding_get_plugin(v_policy, 'fuzzy');
    v_long JSONB := geocoding_get_plugin(v_policy, 'long_line');
    v_perfect_enabled BOOLEAN := COALESCE(v_perfect->>'enabled', 'true')::BOOLEAN;
    v_fuzzy_enabled BOOLEAN := COALESCE(v_fuzzy->>'enabled', 'true')::BOOLEAN;
    v_long_enabled BOOLEAN := COALESCE(v_long->>'enabled', 'true')::BOOLEAN;
    v_long_min_tokens INT := COALESCE((v_long->'params'->>'long_line_min_tokens')::INT, 6);
    v_long_max_noise NUMERIC := COALESCE((v_long->'params'->>'max_noise_ratio')::NUMERIC, 0.5);
    v_long_force NUMERIC := (v_long->'params'->>'force_provider_below_score')::NUMERIC;
    v_long_max_len INT := COALESCE((v_long->'params'->>'max_len_for_local')::INT, 512);
    v_province_gate BOOLEAN := COALESCE(
        (v_perfect->'params'->>'province_gate')::BOOLEAN,
        (v_fuzzy->'params'->>'province_gate')::BOOLEAN,
        TRUE
    );
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
    v_line TEXT;
    v_line_tokens TEXT[] := ARRAY[]::TEXT[];
    v_token_sample TEXT[] := ARRAY[]::TEXT[];
    v_token_count INT := 0;
    v_noise_count INT := 0;
    v_noise_ratio NUMERIC := 0;
    v_long_line_detected BOOLEAN := FALSE;
    v_force_provider BOOLEAN := FALSE;
    v_routing_reason TEXT := NULL;
    v_match JSONB;
    v_tokens JSONB := NULL;
    v_match_plugin TEXT;
    v_match_type TEXT;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        v_match := jsonb_build_object(
          'plugin', 'perfect',
          'match_type', 'address_missing',
          'routing_reason', 'address_missing'
        );
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('matched', FALSE, 'reason', 'address_missing');
        RETURN v_response;
    END IF;

    v_local_cfg := COALESCE(v_policy->'local_lookup', '{}'::jsonb);
    v_enabled := COALESCE((v_local_cfg->>'enabled')::BOOLEAN, TRUE);
    v_min_conf := COALESCE((v_local_cfg->>'min_confidence')::NUMERIC, 0.7);
    v_prefer_district := COALESCE((v_local_cfg->>'prefer_district_centroid')::BOOLEAN, TRUE);

    IF NOT v_perfect_enabled AND NOT v_fuzzy_enabled THEN
        v_match := jsonb_build_object(
          'plugin', 'perfect',
          'match_type', 'plugins_disabled',
          'routing_reason', 'matching_plugins_disabled'
        );
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('matched', FALSE, 'reason', 'matching_plugins_disabled');
        RETURN v_response;
    END IF;

    IF NOT v_enabled THEN
        v_match := jsonb_build_object(
          'plugin', 'perfect',
          'match_type', 'local_lookup_disabled',
          'routing_reason', 'local_lookup_disabled'
        );
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

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
            v_force_provider := v_long_force IS NOT NULL AND v_long_force > 0;
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

    v_match_plugin := CASE
        WHEN v_city.exact_match AND v_perfect_enabled THEN 'perfect'
        WHEN NOT v_city.exact_match AND v_fuzzy_enabled THEN 'fuzzy'
        WHEN v_perfect_enabled THEN 'perfect'
        ELSE 'fuzzy'
    END;

    v_match_type := CASE
        WHEN v_city.exact_match AND v_district_score IS NOT NULL THEN 'district_exact'
        WHEN v_city.exact_match THEN 'city_exact'
        WHEN v_district_score IS NOT NULL THEN 'district_fuzzy'
        ELSE 'city_fuzzy'
    END;

    IF v_centroid IS NULL THEN
        v_match := jsonb_strip_nulls(jsonb_build_object(
          'plugin', v_match_plugin,
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

    IF v_force_provider AND v_long_force IS NOT NULL THEN
        v_confidence := LEAST(v_confidence, v_long_force);
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

COMMENT ON FUNCTION workflow_handlers.execute_geo_local_lookup_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Local canonical lookup with plugin-aware scoring (perfect/fuzzy/long_line), logging, and routing hints.';

-- Decision handler: respect force_fallback/manual flags in context and log scoring details.
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

    -- If already successful (e.g., local lookup), short-circuit unless force_fallback is set.
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

    -- Respect explicit require_fallback/manual flags from context
    IF COALESCE(p_run.context->'geocoding'->>'manual_review_required', 'false')::BOOLEAN THEN
        v_manual_review := TRUE;
    END IF;
    IF COALESCE(p_run.context->'geocoding'->>'require_fallback', 'false')::BOOLEAN THEN
        v_success := FALSE;
        v_requires_fallback := TRUE;
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

    v_manual_review := TRUE;

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

COMMENT ON FUNCTION workflow_handlers.execute_geo_decision_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Evaluates geocoding attempts with plugin-aware metadata, respects force_fallback/manual flags, and logs scoring details.';

-- Alias audit wiring: allow storing address_id
ALTER TABLE geocoding_alias_audit
  ADD COLUMN IF NOT EXISTS address_id UUID;

-- Extend auto_learn_geography to emit alias audit based on alias knobs.
CREATE OR REPLACE FUNCTION public.auto_learn_geography(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID,
    p_address_id UUID,
    p_geocode JSONB,
    p_policy JSONB,
    p_confidence NUMERIC,
    p_action TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_policy JSONB;
    v_auto JSONB;
    v_manual JSONB;
    v_threshold NUMERIC;
    v_enabled BOOLEAN;
    v_city_action TEXT;
    v_district_action TEXT;
    v_city_name TEXT;
    v_district_name TEXT;
    v_country_code TEXT;
    v_city_id UUID;
    v_result JSONB := jsonb_build_object(
        'processed', FALSE,
        'city_learned', FALSE,
        'district_learned', FALSE,
        'manual_review_enqueued', FALSE
    );
    v_sla_minutes INT;
    v_provider_payload JSONB := COALESCE(p_policy, '{}'::jsonb);
    v_provider_name TEXT := p_action;
    v_alias_conf_min NUMERIC := 0.8;
    v_alias_review_threshold NUMERIC := 0.6;
    v_alias_max INT := 5;
    v_alias_count INT := 0;
    v_alias_candidate JSONB;
BEGIN
    -- Resolve policy ladder: sender -> client -> tenant -> global
    v_policy := resolve_settings('geocoding_policy', 'sender', p_sender_id);
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('geocoding_policy', 'client', p_client_id);
    END IF;
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('geocoding_policy', 'tenant', p_organization_id);
    END IF;
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('geocoding_policy', 'global', NULL);
    END IF;

    IF v_policy IS NULL THEN
        RETURN v_result;
    END IF;

    v_auto := COALESCE(v_policy->'auto_learning', '{}'::jsonb);
    v_alias_conf_min := COALESCE((v_auto->>'alias_confidence_min')::NUMERIC, 0.8);
    v_alias_review_threshold := COALESCE((v_auto->>'alias_review_threshold')::NUMERIC, 0.6);
    v_alias_max := COALESCE((v_auto->>'alias_max_per_run')::INT, 5);

    v_enabled := COALESCE((v_auto->>'enabled')::BOOLEAN, FALSE);
    IF NOT v_enabled THEN
        RETURN v_result;
    END IF;

    v_threshold := COALESCE((v_auto->>'confidence_threshold_for_auto_learn')::NUMERIC, 0.9);
    IF p_confidence IS NULL OR p_confidence < v_threshold THEN
        RETURN v_result || jsonb_build_object('processed', TRUE, 'reason', 'confidence_below_threshold');
    END IF;

    v_city_action := COALESCE(v_auto->'components'->'city'->>'action_lookup', 'add_immediately');
    v_district_action := COALESCE(v_auto->'components'->'district'->>'action_lookup', 'queue_for_review');

    -- Parse city/district from provider payload
    IF v_provider_payload ? 'address_components' AND jsonb_typeof(v_provider_payload->'address_components') = 'object' THEN
        v_city_name := COALESCE(
            NULLIF(v_provider_payload->'address_components'->>'city', ''),
            NULLIF(v_provider_payload->'address_components'->>'municipality', ''),
            NULLIF(v_provider_payload->'address_components'->>'county', ''),
            NULLIF(v_provider_payload->'address_components'->>'state', '')
        );
        v_district_name := COALESCE(
            NULLIF(v_provider_payload->'address_components'->>'district', ''),
            NULLIF(v_provider_payload->'address_components'->>'county', '')
        );
        v_country_code := NULLIF(v_provider_payload->'address_components'->>'countryCode', '');
    ELSIF v_provider_payload ? 'address_components' AND jsonb_typeof(v_provider_payload->'address_components') = 'array' THEN
        FOR v_city_name IN
            SELECT elem->>'long_name'
            FROM jsonb_array_elements(v_provider_payload->'address_components') elem
            WHERE EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(elem->'types', '[]'::jsonb))
                WHERE value IN ('locality', 'postal_town', 'administrative_area_level_2')
            )
            LIMIT 1
        LOOP
            EXIT;
        END LOOP;

        FOR v_district_name IN
            SELECT elem->>'long_name'
            FROM jsonb_array_elements(v_provider_payload->'address_components') elem
            WHERE EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(elem->'types', '[]'::jsonb))
                WHERE value IN ('sublocality', 'administrative_area_level_3', 'administrative_area_level_2')
            )
            LIMIT 1
        LOOP
            EXIT;
        END LOOP;

        SELECT elem->>'short_name'
        INTO v_country_code
        FROM jsonb_array_elements(v_provider_payload->'address_components') elem
        WHERE EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(elem->'types', '[]'::jsonb)) WHERE value = 'country'
        )
        LIMIT 1;
    END IF;

    IF v_city_name IS NULL OR v_city_name = '' THEN
        v_city_name := COALESCE(NULLIF(p_geocode->>'city', ''), NULLIF(p_geocode->>'province', ''));
    END IF;

    IF v_district_name IS NULL OR v_district_name = '' THEN
        v_district_name := NULLIF(p_geocode->>'district', '');
    END IF;

    v_country_code := COALESCE(NULLIF(p_geocode->>'country', ''), v_country_code, 'SA');

    -- Alias audit (fire-and-forget, bounded by alias_max_per_run)
    IF p_confidence IS NOT NULL AND p_confidence >= v_alias_review_threshold THEN
        SELECT COUNT(*) INTO v_alias_count FROM geocoding_alias_audit WHERE address_id = p_address_id;
        IF v_alias_count < v_alias_max THEN
            v_alias_candidate := jsonb_strip_nulls(jsonb_build_object(
                'city', v_city_name,
                'district', v_district_name,
                'country', v_country_code,
                'policy_version', v_policy->>'version',
                'candidate_status', CASE WHEN p_confidence >= v_alias_conf_min THEN 'promote' ELSE 'review' END
            ));
            INSERT INTO geocoding_alias_audit (
                organization_id,
                client_id,
                sender_id,
                address_id,
                plugin,
                confidence,
                source,
                metadata
            )
            VALUES (
                p_organization_id,
                p_client_id,
                p_sender_id,
                p_address_id,
                NULL,
                p_confidence,
                v_provider_name,
                v_alias_candidate
            );
        END IF;
    END IF;

    -- Insert/Update city
    IF v_city_name IS NOT NULL AND POSITION('add_immediately' IN v_city_action) > 0 THEN
        INSERT INTO canonical_cities (
            organization_id,
            name_canonical,
            country_code,
            source,
            metadata
        )
        VALUES (
            p_organization_id,
            v_city_name,
            v_country_code,
            'auto_learn',
            jsonb_build_object(
                'confidence', p_confidence,
                'provider', v_provider_name,
                'learned_at', now()
            )
        )
        ON CONFLICT (organization_id, name_canonical) WHERE source_city_id IS NULL DO UPDATE
        SET metadata = canonical_cities.metadata || jsonb_build_object(
            'confidence', p_confidence,
            'provider', v_provider_name,
            'learned_at', now()
        ),
            updated_at = now()
        RETURNING canonical_cities.id INTO v_city_id;

        v_result := v_result || jsonb_build_object('city_learned', TRUE);
    ELSE
        SELECT id INTO v_city_id
        FROM canonical_cities
        WHERE organization_id = p_organization_id
          AND name_canonical = v_city_name;
    END IF;

    IF v_city_id IS NULL THEN
        SELECT id INTO v_city_id
        FROM canonical_cities
        WHERE organization_id = p_organization_id
        ORDER BY (name_canonical = v_city_name) DESC, created_at DESC
        LIMIT 1;
    END IF;

    -- District handling
    IF v_city_id IS NOT NULL
       AND v_district_name IS NOT NULL
       AND v_district_name <> ''
       AND POSITION('add_immediately' IN v_district_action) > 0 THEN
        INSERT INTO canonical_districts (
            organization_id,
            city_id,
            name_canonical,
            source,
            metadata
        )
        VALUES (
            p_organization_id,
            v_city_id,
            v_district_name,
            'auto_learn',
            jsonb_build_object(
            'confidence', p_confidence,
            'provider', v_provider_name,
            'learned_at', now()
        )
        )
        ON CONFLICT (organization_id, city_id, name_canonical) WHERE source_district_id IS NULL DO UPDATE
        SET metadata = canonical_districts.metadata || jsonb_build_object(
            'confidence', p_confidence,
            'provider', v_provider_name,
            'learned_at', now()
        ),
            updated_at = now();

        v_result := v_result || jsonb_build_object('district_learned', TRUE);
    ELSIF v_district_name IS NOT NULL
       AND POSITION('queue_for_review' IN v_district_action) > 0 THEN
        v_manual := COALESCE(v_policy->'manual_review', '{}'::jsonb);
        v_sla_minutes := COALESCE((v_manual->>'sla_minutes')::INT, 60);

        IF NOT EXISTS (
            SELECT 1
            FROM manual_review_tasks
            WHERE task_type = 'geocoding_auto_learn'
              AND status = 'pending'
              AND address_id = p_address_id
              AND queue_assignment = 'geo_ops_review'
        ) THEN
            INSERT INTO manual_review_tasks (
                organization_id,
                client_id,
                sender_id,
            address_id,
            task_type,
            reason,
            status,
            queue_assignment,
            sla_minutes,
            sla_due_at,
            metadata
        )
        VALUES (
            p_organization_id,
            p_client_id,
            p_sender_id,
            p_address_id,
            'geocoding_auto_learn',
            'Auto-learn district requires approval',
            'pending',
            'geo_ops_review',
            v_sla_minutes,
            now() + (v_sla_minutes || ' minutes')::INTERVAL,
            jsonb_strip_nulls(jsonb_build_object(
                    'provider', v_provider_name,
                    'confidence', p_confidence,
                    'candidate_district', v_district_name
                ))
            );

            v_result := v_result || jsonb_build_object('manual_review_enqueued', TRUE);
        END IF;
    END IF;

    v_result := v_result || jsonb_build_object('processed', TRUE);
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.auto_learn_geography(UUID, UUID, UUID, UUID, JSONB, JSONB, NUMERIC, TEXT)
    IS 'Promotes high-confidence geocodes, enqueues review, and records alias audit using policy alias knobs.';

-- Ensure updated handlers use workflow_handlers search_path
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

-- Plan: PLAN-202601-lex-mkt-live-pitch-demo / Step: S04
-- Migration: Restrict short-code registry reverse inference to missing reverse_geocode flag
-- Purpose:
--   - Preserve strict "reverse-only" semantics when reverse_geocode is explicitly false.
--   - Still allow cache_write to infer reverse-geocode for SSOT registry writes when the flag is absent
--     and the incoming payload contains parsed components for a short-code-only address.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-19

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_cache_v1_base(
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
    v_cache_ttl INT := 1440;
    v_expires_at TIMESTAMPTZ := NULL;
    v_lat NUMERIC;
    v_lon NUMERIC;

    -- short_code registry upsert/hydration (policy-driven)
    v_short_plugin JSONB := NULL;
    v_short_enabled BOOLEAN := FALSE;
    v_short_params JSONB := '{}'::jsonb;
    v_short_hydrate BOOLEAN := TRUE;
    v_code_type TEXT := 'sa_short_code';
    v_code_regex TEXT := '^[A-Z]{4}[0-9]{4}$';
    v_short_code TEXT := NULL;
    v_country_code TEXT := NULL;
    v_parsed JSONB := '{}'::jsonb;
    v_registry_id UUID := NULL;
    v_street TEXT := NULL;
    v_house_number TEXT := NULL;
    v_district TEXT := NULL;
    v_city TEXT := NULL;
    v_province TEXT := NULL;
    v_postal TEXT := NULL;
    v_country_from_parsed TEXT := NULL;
    v_formatted TEXT := NULL;
    v_address_line TEXT := NULL;

    -- registry overwrite guard: allow overriding reverse_local rows with non-reverse_local provider results
    v_existing_provider TEXT := NULL;
    v_incoming_provider TEXT := NULL;
    v_override_reverse_local BOOLEAN := FALSE;
    v_reverse_geocode_raw TEXT := NULL;
    v_reverse_geocode BOOLEAN := FALSE;
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

            v_result := jsonb_build_object(
                'cache_hit', TRUE,
                'geocode', v_geocode_json
            );
        ELSE
            v_result := jsonb_build_object('cache_hit', FALSE);
        END IF;

        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', 'cache',
            'match_type', CASE WHEN (v_result->>'cache_hit')::BOOLEAN THEN 'cache_hit' ELSE 'cache_miss' END,
            'routing_reason', CASE WHEN (v_result->>'cache_hit')::BOOLEAN THEN 'cache_short_circuit' ELSE 'cache_miss' END
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := v_result;
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'cache_hit', v_result->>'cache_hit',
                'cache_geocode', v_result->'geocode',
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

        v_cache_ttl := COALESCE(
            (v_policy->>'cache_ttl_minutes')::INT,
            v_cache_ttl
        );
        v_cache_ttl := COALESCE(v_cache_ttl, 0);
        v_expires_at := CASE
            WHEN v_cache_ttl > 0 THEN now() + make_interval(mins => v_cache_ttl)
            ELSE NULL
        END;

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
            client_id,
            expires_at
        )
        VALUES (
            COALESCE((v_geocode_json->>'id')::UUID, gen_random_uuid()),
            v_ctx.address_id,
            COALESCE(v_geocode_json->>'provider_name', 'manual'),
            ST_SetSRID(
                ST_MakePoint(
                    COALESCE((v_geocode_json->'coordinates'->>'longitude')::DOUBLE PRECISION, v_lon),
                    COALESCE((v_geocode_json->'coordinates'->>'latitude')::DOUBLE PRECISION, v_lat)
                ),
                4326
            )::geography,
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

        -- Short code SSOT cache: upsert into address_code_registry when enabled and address carries sa_short_code.
        v_short_plugin := workflow_handlers.geocoding_get_plugin(v_policy, 'short_code');
        v_short_enabled := COALESCE((v_short_plugin->>'enabled')::BOOLEAN, FALSE);
        v_short_params := COALESCE(v_short_plugin->'params', '{}'::jsonb);
        v_short_hydrate := COALESCE((v_short_params->>'hydrate_address')::BOOLEAN, TRUE);
        v_code_type := COALESCE(NULLIF(v_short_params->>'code_type', ''), v_code_type);
        v_code_regex := COALESCE(NULLIF(v_short_params->>'code_regex', ''), v_code_regex);

        IF v_short_enabled THEN
            SELECT
                upper(COALESCE(NULLIF(a.country, ''), NULLIF(v_short_params->>'country', ''))) AS country_code,
                NULLIF(a.sa_short_code, '') AS sa_short_code,
                COALESCE(NULLIF(a.normalized_line1, ''), NULLIF(a.line1, '')) AS address_line
            INTO v_country_code, v_short_code, v_address_line
            FROM public.addresses a
            WHERE a.id = v_ctx.address_id
              AND a.client_id = v_ctx.client_id
            LIMIT 1;

            v_short_code := public.geocoding_normalize_candidate_code(v_short_code, v_code_regex);

            IF v_short_code IS NOT NULL THEN
                v_reverse_geocode_raw := NULLIF(p_run.context->'geocoding'->>'reverse_geocode', '');
                BEGIN
                    v_reverse_geocode := COALESCE(v_reverse_geocode_raw::BOOLEAN, FALSE);
                EXCEPTION
                    WHEN OTHERS THEN
                        v_reverse_geocode := FALSE;
                END;

                -- Infer only when reverse_geocode is absent; explicit false must remain a hard stop.
                v_parsed := COALESCE(v_geocode_json->'metadata'->'parsed', '{}'::jsonb);
                IF v_reverse_geocode_raw IS NULL AND NOT v_reverse_geocode THEN
                    IF jsonb_typeof(v_parsed) = 'object' AND v_parsed <> '{}'::jsonb THEN
                        IF v_address_line IS NULL
                           OR v_address_line = ''
                           OR v_address_line = v_short_code
                           OR (
                                v_address_line ILIKE 'short address %'
                                AND v_address_line ILIKE ('%' || v_short_code || '%')
                           ) THEN
                            v_reverse_geocode := TRUE;
                        END IF;
                    END IF;
                END IF;

                IF NOT v_reverse_geocode THEN
                    v_match := jsonb_strip_nulls(jsonb_build_object(
                        'plugin', 'short_code',
                        'match_type', 'registry_skip',
                        'routing_reason', 'non_reverse_geocode',
                        'code_type', v_code_type,
                        'code_value', v_short_code
                    ));
                    PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);
                ELSE
                    v_formatted := NULLIF(v_geocode_json->>'formatted_address', '');
                    v_street := NULLIF(v_parsed->>'street', '');
                    v_house_number := NULLIF(v_parsed->>'house_number', '');
                    v_district := NULLIF(v_parsed->>'district', '');
                    v_city := NULLIF(v_parsed->>'city', '');
                    v_province := NULLIF(v_parsed->>'province', '');
                    v_postal := NULLIF(v_parsed->>'postal_code', '');
                    v_country_from_parsed := upper(NULLIF(v_parsed->>'country_code', ''));
                    v_country_from_parsed := COALESCE(v_country_from_parsed, v_country_code);

                    v_incoming_provider := COALESCE(NULLIF(v_geocode_json->>'provider_name', ''), 'manual');

                    -- Detect existing provider to decide if we should allow overwriting reverse_local rows.
                    SELECT NULLIF(r.provider_name, '')
                    INTO v_existing_provider
                    FROM public.address_code_registry r
                    WHERE r.country_code = v_country_from_parsed
                      AND r.code_type = v_code_type
                      AND r.code_value = v_short_code
                    LIMIT 1;

                    v_override_reverse_local := (v_existing_provider = 'reverse_local' AND v_incoming_provider <> 'reverse_local');

                    INSERT INTO public.address_code_registry (
                        country_code,
                        code_type,
                        code_value,
                        coordinates,
                        formatted_address,
                        street,
                        house_number,
                        district,
                        city,
                        province,
                        postal_code,
                        provider_name,
                        confidence_score,
                        accuracy_type,
                        provider_parsed,
                        resolved_at,
                        expires_at,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        v_country_from_parsed,
                        v_code_type,
                        v_short_code,
                        ST_SetSRID(ST_MakePoint(v_lon::DOUBLE PRECISION, v_lat::DOUBLE PRECISION), 4326)::geography,
                        v_formatted,
                        v_street,
                        v_house_number,
                        v_district,
                        v_city,
                        v_province,
                        v_postal,
                        v_incoming_provider,
                        NULLIF(v_geocode_json->>'confidence_score', '')::NUMERIC,
                        NULLIF(v_geocode_json->>'accuracy_type', ''),
                        NULLIF(v_parsed, '{}'::jsonb),
                        now(),
                        v_expires_at,
                        now(),
                        now()
                    )
                    ON CONFLICT (country_code, code_type, code_value) DO UPDATE
                    SET
                        coordinates = EXCLUDED.coordinates,
                        formatted_address = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.formatted_address, address_code_registry.formatted_address)
                          ELSE COALESCE(EXCLUDED.formatted_address, address_code_registry.formatted_address)
                        END,
                        street = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.street, address_code_registry.street)
                          ELSE COALESCE(EXCLUDED.street, address_code_registry.street)
                        END,
                        house_number = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.house_number, address_code_registry.house_number)
                          ELSE COALESCE(EXCLUDED.house_number, address_code_registry.house_number)
                        END,
                        district = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.district, address_code_registry.district)
                          ELSE COALESCE(EXCLUDED.district, address_code_registry.district)
                        END,
                        city = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.city, address_code_registry.city)
                          ELSE COALESCE(EXCLUDED.city, address_code_registry.city)
                        END,
                        province = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.province, address_code_registry.province)
                          ELSE COALESCE(EXCLUDED.province, address_code_registry.province)
                        END,
                        postal_code = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.postal_code, address_code_registry.postal_code)
                          ELSE COALESCE(EXCLUDED.postal_code, address_code_registry.postal_code)
                        END,
                        provider_name = CASE
                          WHEN v_override_reverse_local THEN EXCLUDED.provider_name
                          ELSE COALESCE(EXCLUDED.provider_name, address_code_registry.provider_name)
                        END,
                        confidence_score = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.confidence_score, address_code_registry.confidence_score)
                          ELSE COALESCE(EXCLUDED.confidence_score, address_code_registry.confidence_score)
                        END,
                        accuracy_type = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.accuracy_type, address_code_registry.accuracy_type)
                          ELSE COALESCE(EXCLUDED.accuracy_type, address_code_registry.accuracy_type)
                        END,
                        provider_parsed = CASE
                          WHEN v_override_reverse_local THEN COALESCE(EXCLUDED.provider_parsed, address_code_registry.provider_parsed)
                          ELSE COALESCE(EXCLUDED.provider_parsed, address_code_registry.provider_parsed)
                        END,
                        resolved_at = now(),
                        expires_at = COALESCE(EXCLUDED.expires_at, address_code_registry.expires_at),
                        updated_at = now()
                    WHERE address_code_registry.provider_name IS DISTINCT FROM 'here_reference'
                        OR EXCLUDED.provider_name = 'here_reference'
                    RETURNING id INTO v_registry_id;

                    IF v_short_hydrate THEN
                        UPDATE public.addresses a
                        SET
                            district = COALESCE(NULLIF(a.district, ''), v_district),
                            city = CASE
                                WHEN a.city IS NULL OR a.city = '' OR lower(a.city) = 'unknown' THEN COALESCE(v_city, a.city)
                                ELSE a.city
                            END,
                            province = CASE
                                WHEN a.province IS NULL OR a.province = '' OR lower(a.province) = 'unknown' THEN COALESCE(v_province, a.province)
                                ELSE a.province
                            END,
                            postal_code = COALESCE(NULLIF(a.postal_code, ''), v_postal),
                            country = COALESCE(NULLIF(a.country, ''), v_country_from_parsed),
                            normalized_line1 = CASE
                                WHEN a.normalized_line1 IS NULL
                                OR a.normalized_line1 = ''
                                OR a.normalized_line1 = v_short_code
                                OR (
                                    a.normalized_line1 ILIKE 'short address %'
                                    AND a.normalized_line1 ILIKE ('%' || v_short_code || '%')
                                ) THEN
                                    COALESCE(
                                        NULLIF(trim(concat_ws(' ', NULLIF(v_house_number, ''), NULLIF(v_street, ''))), ''),
                                        v_formatted,
                                        a.normalized_line1
                                    )
                                ELSE a.normalized_line1
                            END,
                            updated_at = now()
                        WHERE a.id = v_ctx.address_id
                          AND a.client_id = v_ctx.client_id;
                    END IF;
                END IF;
            END IF;
        END IF;

        v_match := jsonb_strip_nulls(jsonb_build_object(
            'plugin', 'cache',
            'match_type', 'cache_write',
            'routing_reason', 'cache_write',
            'tokens', NULL,
            'short_code_registry_id', v_registry_id
        ));
        PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

        v_response.status := 'completed';
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
            'written', TRUE,
            'geocode', v_geocode_json,
            'expires_at', v_expires_at,
            'ttl_minutes', v_cache_ttl,
            'short_code_registry_id', v_registry_id
        ));
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'cache_written', TRUE,
                'cache_expires_at', v_expires_at,
                'selected_geocode', v_geocode_json
            ))
        );
        RETURN v_response;
    ELSE
        RAISE EXCEPTION 'execute_geocode_cache_v1_base: unsupported action % for step %', v_action, p_step.id;
    END IF;
END;
$$;

ALTER FUNCTION workflow_handlers.execute_geocode_cache_v1_base(workflow_run_steps, workflow_runs, jsonb)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMIT;

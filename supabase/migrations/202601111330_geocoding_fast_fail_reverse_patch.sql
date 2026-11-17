-- Migration: Geocoding fast-fail + reverse address patch
-- Purpose:
--   - Fail fast when short-code reverse provider errors (policy-driven).
--   - Skip fallback provider dispatch unless required by the geocoding decision.
--   - Hydrate normalized address lines + coordinates from HERE reverse responses with short-code awareness.
-- Alignment: SIMPLE, SCALABLE, DYNAMIC, workflow-driven, SSOT, ZERO HARD CODING.
-- Date: 2026-01-11
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Geo decision wrapper: fail fast on short-code reverse provider errors
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('workflow_handlers.execute_geo_decision_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL
     AND to_regprocedure('workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb) RENAME TO execute_geo_decision_v1_base';
  END IF;

  IF to_regprocedure('workflow_handlers.execute_geo_decision_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'execute_geo_decision_v1_base missing; cannot apply fail-fast wrapper';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_decision_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
  v_short_plugin JSONB := workflow_handlers.geocoding_get_plugin(v_policy, 'short_code');
  v_fail_fast BOOLEAN := COALESCE((v_short_plugin->'params'->>'fail_on_reverse_error')::BOOLEAN, FALSE);
  v_ctx RECORD;
  v_short_code TEXT;
  v_attempt RECORD;
  v_response public.workflow_handler_response;
  v_match JSONB;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', FALSE);

  IF NOT v_fail_fast THEN
    RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
  END IF;

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);
  IF v_ctx.address_id IS NULL THEN
    RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
  END IF;

  v_short_code := NULLIF(p_run.context->'geocoding'->>'short_code', '');

  IF v_short_code IS NULL THEN
    SELECT NULLIF(a.sa_short_code, '')
    INTO v_short_code
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id
      AND (v_ctx.client_id IS NULL OR a.client_id = v_ctx.client_id)
    LIMIT 1;
  END IF;

  IF v_short_code IS NULL THEN
    RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
  END IF;

  SELECT *
  INTO v_attempt
  FROM public.geocoding_attempts
  WHERE address_id = v_ctx.address_id
  ORDER BY attempt_order DESC, created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
  END IF;

  IF COALESCE(v_attempt.status, '') <> 'succeeded' THEN
    v_match := jsonb_strip_nulls(jsonb_build_object(
      'plugin', 'short_code',
      'match_type', 'provider_failed',
      'routing_reason', 'short_code_reverse_failed',
      'provider_name', v_attempt.provider_name,
      'status', v_attempt.status
    ));
    PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_response.last_error := 'short_code_reverse_failed';
    v_response.operation_result := jsonb_build_object(
      'decision', 'failed',
      'reason', 'short_code_reverse_failed',
      'attempt_id', v_attempt.id,
      'provider_name', v_attempt.provider_name,
      'status', v_attempt.status
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_strip_nulls(jsonb_build_object(
        'successful', FALSE,
        'manual_review_required', FALSE,
        'require_fallback', FALSE,
        'fail_fast', TRUE,
        'fail_reason', 'short_code_reverse_failed',
        'short_code', v_short_code,
        'selected_attempt_id', v_attempt.id,
        'selected_geocode', v_attempt.metadata->'geocode'
      ))
    );
    RETURN v_response;
  END IF;

  RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path TO public, workflow_handlers, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Geo decision wrapper: optionally fail fast when short-code reverse provider errors (policy-driven).';

-- ---------------------------------------------------------------------------
-- 2) Provider dispatch wrapper: skip fallback unless required
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'execute_provider_dispatch_v1_base missing; cannot apply fallback skip wrapper';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
  v_attempt_type TEXT := lower(COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary'));
  v_require_fallback BOOLEAN := COALESCE((p_run.context->'geocoding'->>'require_fallback')::BOOLEAN, FALSE);
  v_provider_candidates TEXT[];
  v_sequence_index INT;
  v_response public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

  IF v_attempt_type = 'fallback' AND NOT v_require_fallback THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'fallback_not_required'
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_build_object(
        'fallback_skipped', TRUE
      )
    );
    RETURN v_response;
  END IF;

  v_provider_candidates := ARRAY(
    SELECT elem::TEXT
    FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb)) AS elem
    WHERE elem::TEXT NOT IN ('internal_cache', 'manual_review_virtual')
  );

  v_sequence_index := COALESCE(NULLIF(v_metadata->>'provider_sequence_index', '')::INT, 0);

  IF array_length(v_provider_candidates, 1) IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'provider_priority_empty'
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_build_object(
        'successful', FALSE,
        'manual_review_required', TRUE,
        'manual_review_reason', 'provider_priority_exhausted'
      )
    );
    RETURN v_response;
  END IF;

  IF v_sequence_index >= array_length(v_provider_candidates, 1) THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'provider_priority_exhausted',
      'provider_sequence_index', v_sequence_index
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_build_object(
        'successful', FALSE,
        'manual_review_required', TRUE,
        'manual_review_reason', 'provider_priority_exhausted'
      )
    );
    RETURN v_response;
  END IF;

  RETURN workflow_handlers.execute_provider_dispatch_v1_base(p_step, p_run, p_operation_result);
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_provider_dispatch_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_provider_dispatch_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Provider dispatch guard: skip fallback unless required and avoid out-of-range provider_sequence_index failures.';

-- ---------------------------------------------------------------------------
-- 3) Geocoding outbound response: hydrate address lines + coordinates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION workflow_handlers.process_geocoding_outbound_response_v1(
    p_job public.outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('handled', FALSE);
    v_template_id UUID;
    v_template public.operation_templates%ROWTYPE;
    v_step public.workflow_run_steps%ROWTYPE;
    v_run public.workflow_runs%ROWTYPE;
    v_ctx RECORD;
    v_parsed JSONB;
    v_attempt_order INT;
    v_attempt_status TEXT;
    v_attempt_type TEXT;
    v_provider_name TEXT;
    v_attempt_id UUID;
    v_latitude NUMERIC;
    v_longitude NUMERIC;
    v_geocode_json JSONB;
    v_cache_step public.workflow_run_steps%ROWTYPE;
    v_confidence NUMERIC;
    v_address_json JSONB;
    v_auto_learn_result JSONB;

    v_policy JSONB := NULL;
    v_country_gate TEXT := NULL;
    v_city_name TEXT := NULL;
    v_district_name TEXT := NULL;
    v_province_name TEXT := NULL;
    v_postal_code TEXT := NULL;
    v_similarity_threshold NUMERIC := NULL;
    v_local_min NUMERIC := NULL;
    v_delta NUMERIC := NULL;
    v_city_id UUID := NULL;
    v_city_source_id BIGINT := NULL;
    v_city_score NUMERIC := NULL;
    v_district_id UUID := NULL;
    v_district_source_id BIGINT := NULL;
    v_district_distance_m INT := NULL;
    v_point GEOGRAPHY;

    v_house_number TEXT := NULL;
    v_street TEXT := NULL;
    v_line1 TEXT := NULL;
    v_short_code TEXT := NULL;
    v_existing_short_code TEXT := NULL;
    v_country_code TEXT := NULL;
    v_is_reverse BOOLEAN := FALSE;
    v_source_type TEXT := NULL;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', FALSE);

    v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
    IF v_template_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_template
    FROM public.operation_templates
    WHERE id = v_template_id;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    IF p_job.workflow_run_step_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_step
    FROM public.workflow_run_steps
    WHERE id = p_job.workflow_run_step_id;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_run
    FROM public.workflow_runs
    WHERE id = v_step.workflow_run_id;
    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    -- Only handle geocoding templates here; other workflows fall back to handled=false.
    IF v_template.operation_name NOT LIKE 'geocoding_%' THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_ctx FROM public.geocoding_extract_context(v_run);

    IF v_template.mapping_config_id IS NOT NULL THEN
        v_parsed := public.apply_mapping_config(p_response, v_template.mapping_config_id);
    ELSE
        v_parsed := '{}'::jsonb;
    END IF;

    v_attempt_type := COALESCE(v_step.metadata->>'attempt_type', 'primary');
    v_provider_name := COALESCE(v_step.metadata->>'provider_name', v_template.operation_name);

    SELECT COALESCE(MAX(attempt_order), 0) + 1
    INTO v_attempt_order
    FROM public.geocoding_attempts
    WHERE address_id = v_ctx.address_id
      AND provider_name = v_provider_name;

    v_latitude := NULLIF(v_parsed->>'latitude', '')::NUMERIC;
    v_longitude := NULLIF(v_parsed->>'longitude', '')::NUMERIC;
    v_confidence := NULLIF(v_parsed->>'confidence_score', '')::NUMERIC;

    IF (p_job.response_status_code BETWEEN 200 AND 299)
       AND v_latitude IS NOT NULL
       AND v_longitude IS NOT NULL THEN
        v_attempt_status := 'succeeded';
    ELSE
        v_attempt_status := 'failed';
    END IF;

    INSERT INTO public.geocoding_attempts (
        organization_id,
        client_id,
        sender_id,
        address_id,
        shipment_id,
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
        v_ctx.shipment_id,
        v_step.id,
        v_provider_name,
        v_attempt_order,
        v_attempt_type,
        v_attempt_status,
        v_confidence,
        p_job.latency_ms,
        jsonb_build_object(
            'response_status_code', p_job.response_status_code,
            'provider_response', p_response,
            'parsed', v_parsed
        ),
        now(),
        now()
    )
    RETURNING id INTO v_attempt_id;

    IF v_attempt_status = 'succeeded' THEN
        v_policy := workflow_handlers.geocoding_resolve_policy_for_run(v_run);
        v_country_gate := upper(NULLIF(v_policy->'coordinate_handling'->>'country_boundary', ''));
        IF v_country_gate IS NULL OR length(v_country_gate) <> 2 THEN
            v_country_gate := upper(NULLIF((workflow_handlers.geocoding_get_plugin(v_policy, 'short_code')->'params'->>'country'), ''));
        END IF;
        IF v_country_gate IS NOT NULL AND length(v_country_gate) <> 2 THEN
            v_country_gate := NULL;
        END IF;

        v_city_name := NULLIF(v_parsed->>'city', '');
        v_district_name := NULLIF(v_parsed->>'district', '');
        v_province_name := NULLIF(v_parsed->>'province', '');
        v_postal_code := NULLIF(v_parsed->>'postal_code', '');

        v_house_number := NULLIF(v_parsed->>'house_number', '');
        v_street := NULLIF(v_parsed->>'street', '');
        v_line1 := NULLIF(trim(concat_ws(' ', v_house_number, v_street)), '');
        IF v_line1 IS NULL OR v_line1 = '' THEN
            v_line1 := NULLIF(v_parsed->>'formatted_address', '');
        END IF;

        v_country_code := upper(NULLIF(v_parsed->>'country_code', ''));
        IF v_country_code IS NULL OR length(v_country_code) <> 2 THEN
            v_country_code := v_country_gate;
        END IF;

        v_is_reverse := COALESCE(v_template.metadata->>'operation_role', '') = 'geocoding_reverse';

        v_short_code := NULLIF(v_run.context->'geocoding'->>'short_code', '');
        SELECT
            NULLIF(a.sa_short_code, '')
        INTO v_existing_short_code
        FROM public.addresses a
        WHERE a.id = v_ctx.address_id
          AND (v_ctx.client_id IS NULL OR a.client_id = v_ctx.client_id)
        LIMIT 1;

        v_short_code := COALESCE(v_short_code, v_existing_short_code);

        v_source_type := CASE
            WHEN v_short_code IS NOT NULL THEN 'short_code_reverse'
            WHEN v_is_reverse AND v_provider_name = 'here_geocoding' THEN 'here_reverse'
            WHEN v_is_reverse THEN 'provider_reverse'
            ELSE 'legacy'
        END;

        PERFORM set_config('app.address_version_source', COALESCE(v_source_type, 'legacy'), TRUE);

        UPDATE public.addresses a
        SET
            district = COALESCE(NULLIF(a.district, ''), v_district_name),
            city = CASE
                WHEN a.city IS NULL OR a.city = '' OR lower(a.city) = 'unknown' THEN COALESCE(v_city_name, a.city)
                ELSE a.city
            END,
            province = CASE
                WHEN a.province IS NULL OR a.province = '' OR lower(a.province) = 'unknown' THEN COALESCE(v_province_name, a.province)
                ELSE a.province
            END,
            postal_code = COALESCE(NULLIF(a.postal_code, ''), v_postal_code),
            country = CASE
                WHEN (a.country IS NULL OR a.country = '' OR length(a.country) <> 2)
                  AND v_country_code IS NOT NULL THEN v_country_code
                ELSE a.country
            END,
            building_number = COALESCE(NULLIF(a.building_number, ''), v_house_number),
            normalized_line1 = CASE
                WHEN v_line1 IS NULL OR v_line1 = '' THEN a.normalized_line1
                WHEN v_short_code IS NOT NULL THEN v_line1
                WHEN v_short_code IS NULL
                  AND (a.normalized_line1 IS NULL OR a.normalized_line1 = '') THEN v_line1
                ELSE a.normalized_line1
            END,
            line1 = CASE
                WHEN v_line1 IS NULL OR v_line1 = '' THEN a.line1
                WHEN v_short_code IS NOT NULL THEN v_line1
                WHEN v_short_code IS NULL
                  AND (a.line1 IS NULL OR a.line1 = '') THEN v_line1
                ELSE a.line1
            END,
            coordinates = CASE
                WHEN v_latitude IS NOT NULL AND v_longitude IS NOT NULL THEN ST_SetSRID(
                    ST_MakePoint(v_longitude::DOUBLE PRECISION, v_latitude::DOUBLE PRECISION),
                    4326
                )::geography
                ELSE a.coordinates
            END,
            updated_at = now()
        WHERE a.id = v_ctx.address_id
          AND (v_ctx.client_id IS NULL OR a.client_id = v_ctx.client_id);

        PERFORM set_config('app.address_version_source', '', TRUE);

        -- Canonical city match (text similarity) + district match (nearest centroid within city).
        v_local_min := NULL;
        v_delta := NULL;
        BEGIN
            v_local_min := NULLIF(v_policy->'local_lookup'->>'min_confidence', '')::NUMERIC;
        EXCEPTION
            WHEN others THEN
                v_local_min := NULL;
        END;
        BEGIN
            v_delta := NULLIF(v_policy->'provider_agreement_rules'->>'min_confidence_delta', '')::NUMERIC;
        EXCEPTION
            WHEN others THEN
                v_delta := NULL;
        END;

        v_similarity_threshold := GREATEST(
            0,
            LEAST(
                1,
                COALESCE(v_local_min, 0.7) - COALESCE(v_delta, 0.1)
            )
        );

        IF v_city_name IS NOT NULL AND v_city_name <> '' THEN
            SELECT
                c.id,
                c.source_city_id,
                GREATEST(
                    similarity(lower(c.name_canonical), lower(v_city_name)),
                    COALESCE((
                        SELECT MAX(similarity(lower(an), lower(v_city_name)))
                        FROM unnest(COALESCE(c.alternate_names, ARRAY[]::TEXT[])) AS an
                    ), 0)
                ) AS score
            INTO v_city_id, v_city_source_id, v_city_score
            FROM public.canonical_cities c
            WHERE c.organization_id = v_ctx.organization_id
              AND c.is_active = TRUE
              AND (v_country_gate IS NULL OR upper(c.country_code) = v_country_gate)
            ORDER BY score DESC, c.updated_at DESC NULLS LAST, c.id
            LIMIT 1;

            IF v_city_score IS NULL OR v_city_score < v_similarity_threshold THEN
                v_city_id := NULL;
                v_city_source_id := NULL;
                v_city_score := NULL;
            END IF;
        END IF;

        v_point := NULL;
        BEGIN
            v_point := ST_SetSRID(
                ST_MakePoint(v_longitude::DOUBLE PRECISION, v_latitude::DOUBLE PRECISION),
                4326
            )::geography;
        EXCEPTION
            WHEN others THEN
                v_point := NULL;
        END;

        IF v_city_id IS NOT NULL AND v_point IS NOT NULL THEN
            SELECT
                d.id,
                d.source_district_id,
                round(ST_Distance(d.centroid, v_point))::INT
            INTO v_district_id, v_district_source_id, v_district_distance_m
            FROM public.canonical_districts d
            WHERE d.organization_id = v_ctx.organization_id
              AND d.city_id = v_city_id
              AND d.is_active = TRUE
              AND d.centroid IS NOT NULL
            ORDER BY d.centroid <-> v_point, d.updated_at DESC NULLS LAST, d.id
            LIMIT 1;
        END IF;

        SELECT jsonb_strip_nulls(jsonb_build_object(
                   'line1', NULLIF(a.normalized_line1, ''),
                   'line2', NULLIF(a.normalized_line2, ''),
                   'district', NULLIF(a.district, ''),
                   'city', NULLIF(a.city, ''),
                   'province', NULLIF(a.province, ''),
                   'country', NULLIF(a.country, '')
               ))
        INTO v_address_json
        FROM public.addresses a
        WHERE a.id = v_ctx.address_id;

        v_geocode_json := jsonb_strip_nulls(jsonb_build_object(
            'provider_name', v_provider_name,
            'is_primary', v_attempt_type = 'primary',
            'confidence_score', v_confidence,
            'formatted_address', COALESCE(v_parsed->>'formatted_address', NULL),
            'accuracy_type', COALESCE(v_parsed->>'location_type', NULL),
            'metadata', jsonb_strip_nulls(jsonb_build_object(
                'attempt_id', v_attempt_id,
                'provider_name', v_provider_name,
                'parsed', v_parsed,
                'city_id', v_city_id,
                'source_city_id', v_city_source_id,
                'district_id', v_district_id,
                'source_district_id', v_district_source_id,
                'canonical_match', jsonb_strip_nulls(jsonb_build_object(
                    'city_score', v_city_score,
                    'district_distance_m', v_district_distance_m,
                    'threshold', v_similarity_threshold
                ))
            )),
            'coordinates', jsonb_build_object(
                'latitude', v_latitude,
                'longitude', v_longitude
            )
        ));

        UPDATE public.geocoding_attempts
        SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('geocode', v_geocode_json)),
            updated_at = now()
        WHERE id = v_attempt_id;

        v_cache_step := v_step;
        v_cache_step.metadata := jsonb_build_object('action', 'write');

        PERFORM workflow_handlers.execute_geocode_cache_v1(
            v_cache_step,
            v_run,
            jsonb_build_object('geocode', v_geocode_json)
        );

        IF to_regprocedure('public.auto_learn_geography(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,text)') IS NOT NULL THEN
            v_auto_learn_result := public.auto_learn_geography(
                v_ctx.organization_id,
                v_ctx.client_id,
                v_ctx.sender_id,
                v_ctx.address_id,
                COALESCE(v_address_json, '{}'::jsonb),
                v_parsed,
                v_confidence,
                v_provider_name
            );

            v_result := v_result || jsonb_build_object('auto_learn', v_auto_learn_result);
        END IF;
    END IF;

    UPDATE public.workflow_run_steps
    SET operation_result = jsonb_build_object(
            'attempt_id', v_attempt_id,
            'provider_name', v_provider_name,
            'status', v_attempt_status,
            'response_status_code', p_job.response_status_code
        ),
        updated_at = now()
    WHERE id = v_step.id;

    v_result := jsonb_build_object(
        'handled', TRUE,
        'attempt_id', v_attempt_id,
        'status', v_attempt_status
    );

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_geocoding_outbound_response_v1(public.outbound_calls, JSONB)
  IS 'Process outbound responses for geocoding templates (records attempts, hydrates address components/lines/coords with short-code awareness, enriches geocode with canonical city/district, and writes cache when successful).';

COMMIT;

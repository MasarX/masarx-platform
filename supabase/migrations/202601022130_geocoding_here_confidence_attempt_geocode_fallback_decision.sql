-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S04
-- Migration: Geocoding workflow fixes (HERE confidence, attempt geocode, fallback decision)
-- Purpose:
--   1) Fix HERE forward confidence_score extraction (queryScore vs relevance).
--   2) Persist `geocode` into geocoding_attempts.metadata so geo_decision can promote success.
--   3) Add a second decision step after fallback_provider in workflow_geocoding_standard.
--   4) Best-effort hydrate addresses district/city/province/postal_code from provider parse when missing.
-- Alignment: Row-driven workflows, SSOT, policy-driven behavior (no tenant hardcoding).
-- Date: 2026-01-02

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) HERE forward mapping: confidence_score path correction
-------------------------------------------------------------------------------

UPDATE public.mapping_configs
SET mapping_config = jsonb_set(
        COALESCE(mapping_config, '{}'::jsonb),
        '{field_mappings,confidence_score}',
        jsonb_build_array('$.items[0].scoring.relevance', '$.items[0].scoring.queryScore'),
        TRUE
    ),
    mapping_version = mapping_version + 1,
    updated_at = now()
WHERE mapping_type = 'provider_response'
  AND mapping_key = 'geocoding::here_forward::v1';

-------------------------------------------------------------------------------
-- 2) Geocoding outbound response handler: store attempt.metadata.geocode + hydrate
-------------------------------------------------------------------------------

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
    v_district_score NUMERIC := NULL;
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

        -- Hydrate address components from provider parse when missing/unknown.
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
                  AND v_country_gate IS NOT NULL THEN v_country_gate
                ELSE a.country
            END,
            updated_at = now()
        WHERE a.id = v_ctx.address_id
          AND (v_ctx.client_id IS NULL OR a.client_id = v_ctx.client_id);

        -- Best-effort canonical city/district match to support downstream zone assignment.
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

        IF v_city_id IS NOT NULL AND v_district_name IS NOT NULL AND v_district_name <> '' THEN
            SELECT
                d.id,
                d.source_district_id,
                GREATEST(
                    similarity(lower(d.name_canonical), lower(v_district_name)),
                    COALESCE((
                        SELECT MAX(similarity(lower(an), lower(v_district_name)))
                        FROM unnest(COALESCE(d.alternate_names, ARRAY[]::TEXT[])) AS an
                    ), 0)
                ) AS score
            INTO v_district_id, v_district_source_id, v_district_score
            FROM public.canonical_districts d
            WHERE d.organization_id = v_ctx.organization_id
              AND d.city_id = v_city_id
              AND d.is_active = TRUE
            ORDER BY score DESC, d.updated_at DESC NULLS LAST, d.id
            LIMIT 1;

            IF v_district_score IS NULL OR v_district_score < v_similarity_threshold THEN
                v_district_id := NULL;
                v_district_source_id := NULL;
                v_district_score := NULL;
            END IF;
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
                    'district_score', v_district_score,
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
  IS 'Process outbound responses for geocoding templates (records attempts, stores attempt.metadata.geocode, hydrates address components, and writes cache when successful).';

-------------------------------------------------------------------------------
-- 3) workflow_geocoding_standard: add evaluate_fallback_result after fallback_provider
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_template_id UUID;
  v_fallback_seq INT;
  v_exists BOOLEAN := FALSE;
  v_step_id UUID := '99990000-0000-0000-0000-000000410012'::uuid;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  SELECT id
  INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard not found; skipping fallback decision insertion';
    RETURN;
  END IF;

  SELECT TRUE
  INTO v_exists
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'evaluate_fallback_result'
  LIMIT 1;

  IF v_exists THEN
    RETURN;
  END IF;

  SELECT sequence_order
  INTO v_fallback_seq
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'fallback_provider'
  LIMIT 1;

  IF v_fallback_seq IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard fallback_provider step not found; skipping fallback decision insertion';
    RETURN;
  END IF;

  SELECT COALESCE(metadata, '{}'::jsonb)
  INTO v_metadata
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'evaluate_result'
  LIMIT 1;

  v_metadata := jsonb_set(
    COALESCE(v_metadata, '{}'::jsonb),
    '{decision_log_event}',
    to_jsonb('geocoding.evaluate_fallback_result'::text),
    TRUE
  );

  -- Shift steps after fallback_provider by +1 without violating uniqueness.
  UPDATE public.workflow_template_steps
  SET sequence_order = sequence_order + 1000,
      updated_at = now()
  WHERE workflow_template_id = v_template_id
    AND sequence_order > v_fallback_seq;

  INSERT INTO public.workflow_template_steps (
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
    v_step_id,
    v_template_id,
    v_fallback_seq + 1,
    'evaluate_fallback_result',
    'geocoding',
    'always',
    'geo_decision',
    'v1',
    v_metadata,
    FALSE,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
  SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    operation_settings_category = EXCLUDED.operation_settings_category,
    transition_condition = EXCLUDED.transition_condition,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    metadata = EXCLUDED.metadata,
    manual_action_required = EXCLUDED.manual_action_required,
    enabled = EXCLUDED.enabled,
    updated_at = now();

  UPDATE public.workflow_template_steps
  SET sequence_order = sequence_order - 999,
      updated_at = now()
  WHERE workflow_template_id = v_template_id
    AND sequence_order > v_fallback_seq + 1000;

  PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END $$;

COMMIT;


-- Migration: Geocoding outbound response handler
-- Purpose: Translate provider HTTP responses into geocoding attempts/cache writes.

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.process_outbound_response_v1(
    p_job outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('handled', FALSE);
    v_template_id UUID;
    v_template operation_templates%ROWTYPE;
    v_step workflow_run_steps%ROWTYPE;
    v_run workflow_runs%ROWTYPE;
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
    v_cache_step workflow_run_steps%ROWTYPE;
    v_confidence NUMERIC;
    v_address_json JSONB;
    v_auto_learn_result JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;

    IF v_template_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_template
    FROM operation_templates
    WHERE id = v_template_id;

    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    IF p_job.workflow_run_step_id IS NULL THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_step
    FROM workflow_run_steps
    WHERE id = p_job.workflow_run_step_id;

    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_run
    FROM workflow_runs
    WHERE id = v_step.workflow_run_id;

    IF NOT FOUND THEN
        RETURN v_result;
    END IF;

    -- Only handle geocoding templates here; other workflows fall back to previous behaviour.
    IF v_template.operation_name NOT LIKE 'geocoding_%' THEN
        RETURN v_result;
    END IF;

    SELECT * INTO v_ctx FROM geocoding_extract_context(v_run);

    IF v_template.mapping_config_id IS NOT NULL THEN
        v_parsed := apply_mapping_config(p_response, v_template.mapping_config_id);
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
            'metadata', jsonb_build_object(
                'attempt_id', v_attempt_id,
                'provider_name', v_provider_name,
                'parsed', v_parsed
            ),
            'coordinates', jsonb_build_object(
                'latitude', v_latitude,
                'longitude', v_longitude
            )
        ));

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

    UPDATE workflow_run_steps
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

COMMENT ON FUNCTION workflow_handlers.process_outbound_response_v1(outbound_calls, JSONB)
    IS 'Shared hook for outbound responses. Geocoding templates record provider attempts and cache hits.';

COMMIT;

-- Migration: Geocoding handler consolidation (final)
-- Purpose: Restore production implementations after stub override and remove provider name hardcoding.
-- Alignment: SIMPLE Â· SCALABLE Â· DYNAMIC Â· ZERO HARD CODING

BEGIN;

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
    v_geocode RECORD;
    v_response workflow_handler_response;
    v_result JSONB;
    v_geocode_json JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

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

        v_response.status := 'completed';
        v_response.operation_result := v_result;
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'cache_hit', v_result->>'cache_hit',
                'cache_geocode', v_result->'geocode'
            )
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
    IS 'Geocoding cache read/write handler (production implementation).';


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
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_coordinates JSONB;
    v_lat NUMERIC;
    v_lon NUMERIC;
    v_within_bounds BOOLEAN := TRUE;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    v_coordinates := COALESCE(
        v_context->'shipment'->'coordinates',
        v_context->'geocoding'->'provided_coordinates',
        NULL
    );

    IF v_coordinates IS NOT NULL THEN
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
        'within_bounds', v_within_bounds
    );
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_build_object(
            'provided_coordinates', v_coordinates,
            'coordinates_valid', v_within_bounds
        )
    );

    RETURN v_response;
END;
$$;



COMMENT ON FUNCTION workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Validates provided coordinates and records validation outcome in workflow context.';


CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_normalize_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx RECORD;
    v_address RECORD;
    v_normalized TEXT;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NOT NULL THEN
        SELECT
            a.normalized_line1,
            a.normalized_line2,
            a.city,
            a.district,
            a.province,
            a.country
        INTO v_address
        FROM public.addresses a
        WHERE a.id = v_ctx.address_id;
    END IF;

    v_normalized := trim(
        btrim(
            COALESCE(v_address.normalized_line1, '') || ' ' ||
            COALESCE(v_address.normalized_line2, '') || ' ' ||
            COALESCE(v_address.district, '') || ' ' ||
            COALESCE(v_address.city, '') || ' ' ||
            COALESCE(v_address.province, '') || ' ' ||
            COALESCE(v_address.country, '')
        )
    );

    IF v_normalized = '' THEN
        v_normalized := NULL;
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'normalized_address', v_normalized
    );
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_build_object(
            'normalized_address', v_normalized
        )
    );

    RETURN v_response;
END;
$$;



COMMENT ON FUNCTION workflow_handlers.execute_geo_normalize_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Builds a normalized address string from the addresses table for downstream provider dispatch.';







COMMENT ON FUNCTION workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Dispatch geocoding provider attempts via outbound_http handler using configuration metadata.';






COMMENT ON FUNCTION workflow_handlers.execute_geo_decision_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Evaluates geocoding attempts against policy thresholds to decide success, fallback, or manual review.';


CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_manual_review_enqueue_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_queue TEXT := COALESCE(v_metadata->>'queue_assignment', v_metadata->>'queue_key', 'address_ops');
    v_sla INTEGER := COALESCE((v_metadata->>'sla_minutes')::INT, 60);
    v_ctx RECORD;
    v_required BOOLEAN := COALESCE(
        p_run.context->'geocoding'->>'manual_review_required',
        'false'
    )::BOOLEAN;
    v_reason TEXT := COALESCE(
        p_run.context->'geocoding'->>'manual_review_reason',
        'geocoding_low_confidence'
    );
    v_task_id UUID;
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF NOT v_required THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'enqueued', FALSE,
            'reason', 'manual_review_not_required'
        );
        RETURN v_response;
    END IF;

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

    INSERT INTO public.manual_review_tasks (
        organization_id,
        client_id,
        sender_id,
        address_id,
        shipment_id,
        task_type,
        reason,
        status,
        queue_assignment,
        sla_minutes,
        sla_due_at,
        metadata
    )
    VALUES (
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id,
        v_ctx.address_id,
        v_ctx.shipment_id,
        'geocoding',
        v_reason,
        'pending',
        v_queue,
        v_sla,
        now() + (v_sla || ' minutes')::INTERVAL,
        jsonb_build_object(
            'workflow_run_id', p_step.workflow_run_id,
            'workflow_step_id', p_step.workflow_template_step_id
        )
    )
    RETURNING id INTO v_task_id;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'enqueued', TRUE,
        'task_id', v_task_id
    );
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_build_object(
            'manual_review_task_id', v_task_id
        )
    );

    RETURN v_response;
END;
$$;



COMMENT ON FUNCTION workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Enqueues a manual review task when geocoding policy requires human intervention.';


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
              'execute_geo_coordinate_v1',
              'execute_geo_normalize_v1',
              'execute_provider_dispatch_v1',
              'execute_geo_decision_v1',
              'execute_geocode_manual_review_enqueue_v1'
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


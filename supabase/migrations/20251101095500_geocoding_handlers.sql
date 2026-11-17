-- Migration: Geocoding handler suite and manual review queue
-- Purpose: Introduce manual review tasks ledger and PL/pgSQL workflow handlers
--          required for the geocoding restoration plan.
-- Date: 2025-11-01

BEGIN;

-- =============================================================================
-- Manual review tasks ledger
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.manual_review_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id),
    client_id UUID NOT NULL REFERENCES public.clients(id),
    sender_id UUID REFERENCES public.senders(id),
    address_id UUID,
    shipment_id UUID,
    task_type TEXT NOT NULL DEFAULT 'geocoding',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    queue_assignment TEXT,
    sla_minutes INTEGER,
    sla_due_at TIMESTAMPTZ,
    assigned_to UUID REFERENCES public.users(id),
    resolution_notes TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT manual_review_tasks_metadata_check CHECK (
        metadata IS NULL OR jsonb_typeof(metadata) = 'object'
    ),
    CONSTRAINT manual_review_tasks_address_fk FOREIGN KEY (address_id, client_id)
        REFERENCES public.addresses (id, client_id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_review_tasks_org_status
    ON public.manual_review_tasks (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_manual_review_tasks_queue
    ON public.manual_review_tasks (queue_assignment, status);

ALTER TABLE public.manual_review_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manual_review_tasks_service_policy ON public.manual_review_tasks;
CREATE POLICY manual_review_tasks_service_policy ON public.manual_review_tasks
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS manual_review_tasks_read_policy ON public.manual_review_tasks;
CREATE POLICY manual_review_tasks_read_policy ON public.manual_review_tasks
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

-- =============================================================================
-- Helper: Extract geocoding workflow context
-- =============================================================================

CREATE OR REPLACE FUNCTION public.geocoding_extract_context(p_run workflow_runs)
RETURNS TABLE (
    organization_id UUID,
    client_id UUID,
    sender_id UUID,
    shipment_id UUID,
    address_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_shipment_id UUID;
    v_address_id UUID;
    v_org UUID;
    v_client UUID;
    v_sender UUID;
    v_addr UUID;
BEGIN
    v_shipment_id := COALESCE(
        NULLIF(v_context->>'shipment_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->>'shipment_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'id', '')::UUID
    );

    v_address_id := COALESCE(
        NULLIF(v_context->>'address_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'destination_address_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'address_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'destination_address_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'address_id', '')::UUID
    );

    IF v_shipment_id IS NOT NULL THEN
        SELECT
            s.organization_id,
            s.client_id,
            s.sender_id,
            s.destination_address_id
        INTO v_org, v_client, v_sender, v_addr
        FROM public.shipments s
        WHERE s.id = v_shipment_id;
    END IF;

    v_org := COALESCE(
        v_org,
        NULLIF(v_context->>'organization_id', '')::UUID
    );

    v_client := COALESCE(
        v_client,
        NULLIF(v_context->>'client_id', '')::UUID
    );

    v_sender := COALESCE(
        v_sender,
        NULLIF(v_context->>'sender_id', '')::UUID
    );

    v_addr := COALESCE(v_addr, v_address_id);

    RETURN QUERY
    SELECT
        v_org,
        v_client,
        v_sender,
        v_shipment_id,
        v_addr;
END;
$$;

COMMENT ON FUNCTION public.geocoding_extract_context(workflow_runs)
    IS 'Derives organization, client, sender, shipment, and address identifiers from a workflow run context.';

-- Utility: deterministic pseudo coordinates for simulation environments
CREATE OR REPLACE FUNCTION public.geocoding_generate_point(p_address_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_hash BIGINT;
    v_lat NUMERIC;
    v_lon NUMERIC;
BEGIN
    IF p_address_id IS NULL THEN
        RETURN jsonb_build_object(
            'latitude', 0,
            'longitude', 0
        );
    END IF;

    v_hash := abs(hashtext(p_address_id::TEXT));
    v_lat := ((v_hash % 1800000)::NUMERIC / 10000.0) - 90.0;
    v_lon := (((v_hash / 1800000) % 3600000)::NUMERIC / 10000.0) - 180.0;

    RETURN jsonb_build_object(
        'latitude', round(v_lat::NUMERIC, 6),
        'longitude', round(v_lon::NUMERIC, 6)
    );
END;
$$;

COMMENT ON FUNCTION public.geocoding_generate_point(UUID)
    IS 'Generates deterministic pseudo coordinates for testing environments based on address UUID.';

-- =============================================================================
-- Handler: geocode_cache (read/write)
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
    IS 'Reads from and writes to the geocoding cache (geocodes table).';

-- =============================================================================
-- Handler: geo_coordinate_validator
-- =============================================================================

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
    IS 'Validates provided coordinates when present and records validation status.';

-- =============================================================================
-- Handler: geo_normalize (basic normalization stub)
-- =============================================================================

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
    IS 'Creates a simple normalized address string from the addresses table for downstream use.';

-- =============================================================================
-- Handler: provider_dispatch (simulated attempt)
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
    v_provider_id UUID := (v_metadata->>'provider_id')::UUID;
    v_provider_key TEXT := v_metadata->>'provider_key';
    v_attempt_type TEXT := COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary');
    v_confidence NUMERIC(5,4) := COALESCE((v_metadata->>'simulated_confidence')::NUMERIC, 0.65);
    v_response workflow_handler_response;
    v_ctx RECORD;
    v_provider RECORD;
    v_attempt_id UUID;
    v_attempt_order INT;
    v_coordinates JSONB;
    v_metadata_payload JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
    END IF;

    IF v_provider_id IS NULL AND v_provider_key IS NOT NULL THEN
        SELECT id, name
        INTO v_provider
        FROM public.providers
        WHERE name = v_provider_key;
    ELSE
        SELECT id, name
        INTO v_provider
        FROM public.providers
        WHERE id = v_provider_id;
    END IF;

    IF v_provider.id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: provider metadata missing for step %', p_step.id;
    END IF;

    SELECT COALESCE(MAX(attempt_order), 0)
    INTO v_attempt_order
    FROM public.geocoding_attempts
    WHERE address_id = v_ctx.address_id
      AND provider_name = v_provider.name;

    v_attempt_order := v_attempt_order + 1;
    v_coordinates := geocoding_generate_point(v_ctx.address_id);

    v_metadata_payload := jsonb_build_object(
        'geocode', jsonb_build_object(
            'provider_id', v_provider.id,
            'provider_name', v_provider.name,
            'coordinates', v_coordinates,
            'confidence_score', v_confidence,
            'is_primary_candidate', v_attempt_type = 'primary',
            'generated_at', now()
        )
    );

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
        metadata
    )
    VALUES (
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id,
        v_ctx.address_id,
        v_ctx.shipment_id,
        p_step.id,
        v_provider.name,
        v_attempt_order,
        v_attempt_type,
        'succeeded',
        v_confidence,
        350 + (random() * 150)::INT,
        v_metadata_payload
    )
    RETURNING id INTO v_attempt_id;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'attempt_id', v_attempt_id,
        'provider_name', v_provider.name,
        'confidence', v_confidence,
        'geocode', v_metadata_payload->'geocode'
    );
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_build_object(
            'latest_attempt_id', v_attempt_id,
            'latest_geocode', v_metadata_payload->'geocode',
            'last_provider', v_provider.name
        )
    );

    PERFORM log_decision(
        p_organization_id := v_ctx.organization_id,
        p_decision_category := 'geocoding_attempt',
        p_resource_type := 'geocoding_attempt',
        p_resource_id := v_attempt_id,
        p_decision_point := 'execute_provider_dispatch',
        p_decision_outcome := 'attempt_succeeded',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
            'address_id', v_ctx.address_id,
            'provider_name', v_provider.name,
            'confidence', v_confidence,
            'attempt_order', v_attempt_order,
            'attempt_type', v_attempt_type
        )
    );

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Simulates geocoding provider attempts and records entries in geocoding_attempts.';

-- =============================================================================
-- Handler: geo_decision (confidence evaluation)
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
    v_primary_threshold NUMERIC(5,4) := COALESCE((v_metadata->>'confidence_threshold')::NUMERIC, 0.75);
    v_fallback_threshold NUMERIC(5,4) := COALESCE((v_metadata->>'fallback_threshold')::NUMERIC, 0.65);
    v_ctx RECORD;
    v_attempt RECORD;
    v_success BOOLEAN := FALSE;
    v_requires_fallback BOOLEAN := FALSE;
    v_manual_review BOOLEAN := FALSE;
    v_selected_confidence NUMERIC(5,4);
    v_response workflow_handler_response;
    v_attempt_json JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_geo_decision_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
    END IF;

    SELECT *
    INTO v_attempt
    FROM public.geocoding_attempts
    WHERE address_id = v_ctx.address_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v_manual_review := TRUE;
    ELSE
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
            'attempt_id', v_attempt.id,
            'provider_name', v_attempt.provider_name,
            'confidence', v_selected_confidence,
            'attempt_type', v_attempt.attempt_type,
            'geocode', v_attempt.metadata->'geocode'
        );

        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'successful', TRUE,
                'selected_attempt_id', v_attempt.id,
                'selected_geocode', v_attempt.metadata->'geocode',
                'manual_review_required', FALSE
            )
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'success',
            'attempt', v_attempt_json
        );

        PERFORM log_decision(
            p_organization_id := v_ctx.organization_id,
            p_decision_category := 'geocoding',
            p_resource_type := 'address',
            p_resource_id := v_ctx.address_id,
            p_decision_point := 'geo_decision',
            p_decision_outcome := 'resolved',
            p_performed_by_system := 'workflow_engine',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_build_object(
                'attempt_id', v_attempt.id,
                'provider_name', v_attempt.provider_name,
                'confidence', v_selected_confidence,
                'attempt_type', v_attempt.attempt_type
            )
        );
        RETURN v_response;
    END IF;

    IF v_requires_fallback THEN
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'successful', FALSE,
                'selected_attempt_id', v_attempt.id,
                'selected_geocode', v_attempt.metadata->'geocode',
                'manual_review_required', FALSE,
                'require_fallback', TRUE
            )
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'fallback_required',
            'last_attempt_id', v_attempt.id
        );

        PERFORM log_decision(
            p_organization_id := v_ctx.organization_id,
            p_decision_category := 'geocoding',
            p_resource_type := 'address',
            p_resource_id := v_ctx.address_id,
            p_decision_point := 'geo_decision',
            p_decision_outcome := 'fallback_required',
            p_performed_by_system := 'workflow_engine',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_build_object(
                'last_attempt_id', v_attempt.id,
                'confidence', v_selected_confidence,
                'attempt_type', v_attempt.attempt_type
            )
        );
        RETURN v_response;
    END IF;

    v_manual_review := TRUE;

    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_build_object(
            'successful', FALSE,
            'manual_review_required', TRUE,
            'manual_review_reason', 'confidence_below_threshold',
            'selected_attempt_id', v_attempt.id
        )
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'decision', 'manual_review',
        'reason', 'confidence_below_threshold'
    );

    PERFORM log_decision(
        p_organization_id := v_ctx.organization_id,
        p_decision_category := 'geocoding',
        p_resource_type := 'address',
        p_resource_id := v_ctx.address_id,
        p_decision_point := 'geo_decision',
        p_decision_outcome := 'manual_review_required',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
            'last_attempt_id', v_attempt.id,
            'confidence', v_selected_confidence,
            'attempt_type', CASE WHEN v_attempt.id IS NULL THEN NULL ELSE v_attempt.attempt_type END
        )
    );
    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_geo_decision_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Evaluates geocoding attempts against configured thresholds to determine success, fallback, or manual review.';

-- =============================================================================
-- Handler: geocode_manual_review_enqueue
-- =============================================================================

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
    IS 'Queues a manual review task when geocoding requires human intervention.';

-- =============================================================================
-- Operation handler registry updates
-- =============================================================================

INSERT INTO public.operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES
    ('geocode_cache', 'workflow_handlers', 'execute_geocode_cache_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Geocoding cache read/write handler.', 'docs/ops/plans/geocoding_integration_plan.md'),
    ('geo_coordinate', 'workflow_handlers', 'execute_geo_coordinate_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Validates provided coordinates for geocoding workflows.', 'docs/ops/plans/geocoding_integration_plan.md'),
    ('geo_normalize', 'workflow_handlers', 'execute_geo_normalize_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Normalizes address components prior to provider dispatch.', 'docs/ops/plans/geocoding_integration_plan.md'),
    ('provider_dispatch', 'workflow_handlers', 'execute_provider_dispatch_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Dispatches geocoding provider attempts (simulated).', 'docs/ops/plans/geocoding_integration_plan.md'),
    ('geo_decision', 'workflow_handlers', 'execute_geo_decision_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Evaluates geocoding attempts and orchestrates fallback/manual review.', 'docs/ops/plans/geocoding_integration_plan.md'),
    ('geocode_manual_review_enqueue', 'workflow_handlers', 'execute_geocode_manual_review_enqueue_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Queues manual review tasks for geocoding outcomes.', 'docs/ops/plans/geocoding_integration_plan.md')
ON CONFLICT (handler_key) DO UPDATE
SET
    handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

COMMIT;

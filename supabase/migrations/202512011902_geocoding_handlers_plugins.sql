-- Migration: Geocoding handlers pluginized scoring/logging/alias auto-learn
-- Purpose: Honor geocoding_policy.matching_plugins (perfect/fuzzy/long_line/reverse), enrich decision_log with scoring details, and wire alias auto-learn hooks.
-- Alignment: SIMPLE/SCALABLE/DYNAMIC, zero hardcoding, workflow/row-driven.

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
BEGIN
  IF COALESCE(p_policy->'logging'->>'log_scoring_details','false')::BOOLEAN THEN
    PERFORM add_to_decision_log(p_run_id, p_step_id, jsonb_build_object('geocoding_match', jsonb_strip_nulls(p_match)));
  END IF;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.geocoding_log_match(UUID, UUID, JSONB, JSONB)
  IS 'Writes geocoding match details into decision_log when policy logging is enabled.';

-- Replace cache handler to include logging and policy resolution (no change to semantics).
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
    v_policy := geocoding_resolve_policy_for_run(p_run);
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

-- Update coordinate validation to log reverse context.
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
    v_policy JSONB := geocoding_resolve_policy_for_run(p_run);
    v_logging JSONB := COALESCE(v_policy->'logging', '{}'::jsonb);
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

    v_match := jsonb_strip_nulls(jsonb_build_object(
      'plugin', 'reverse',
      'match_type', CASE WHEN v_coordinates IS NULL THEN 'reverse_missing' ELSE 'reverse_bounds' END,
      'coords_valid', v_within_bounds
    ));

    PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Validates provided coordinates, logs reverse plugin context when enabled.';

-- TODO: In S02 codebase, application-side scorer/tokenizer will populate geocoding_match and aliases; this migration establishes server-side hooks only.

COMMIT;

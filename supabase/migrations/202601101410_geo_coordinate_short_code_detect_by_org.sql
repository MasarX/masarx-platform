-- Migration: Geocoding coordinate handler - short-code detection should not depend on client_id match
-- Purpose:
--   - Ensure Saudi short-code presence is detected even if workflow context has a client_id mismatch.
--   - Prevent reverse_local polygon short-circuit from being selected for short-code shipments.
-- Policy-driven:
--   - matching_plugins.reverse_local.params.skip_when_short_code (default TRUE)
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow-driven - ZERO HARD CODING.
-- Plan: PLAN-202601-sa-short-code-district-fix / Step: S04
-- Date: 2026-01-10

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_coordinate_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_require_bounds BOOLEAN := COALESCE((v_metadata->>'validate_bounds')::BOOLEAN, FALSE);
    v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_reverse_plugin JSONB := workflow_handlers.geocoding_get_plugin(v_policy, 'reverse');
    v_reverse_local_plugin JSONB := workflow_handlers.geocoding_get_plugin(v_policy, 'reverse_local');
    v_reverse_enabled BOOLEAN := COALESCE(v_reverse_plugin->>'enabled', 'true')::BOOLEAN;
    v_reverse_local_enabled BOOLEAN := COALESCE(v_reverse_local_plugin->>'enabled', 'true')::BOOLEAN;
    v_reverse_local_confidence NUMERIC := COALESCE((v_reverse_local_plugin->'params'->>'confidence')::NUMERIC, 0.99);
    v_skip_local_when_short_code BOOLEAN := COALESCE((v_reverse_local_plugin->'params'->>'skip_when_short_code')::BOOLEAN, TRUE);

    v_ctx RECORD;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_coordinates JSONB;
    v_lat NUMERIC;
    v_lon NUMERIC;
    v_within_bounds BOOLEAN := TRUE;
    v_local_match JSONB := NULL;
    v_attempt_id UUID := NULL;
    v_point GEOMETRY;
    v_loc RECORD;
    v_canonical RECORD;
    v_selected_geocode JSONB := NULL;
    v_response workflow_handler_response;
    v_reverse_flag BOOLEAN := FALSE;
    v_match JSONB := NULL;

    v_sa_short_code TEXT := NULL;
    v_short_code_present BOOLEAN := FALSE;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

    v_coordinates := COALESCE(
        v_context->'shipment'->'coordinates',
        v_context->'geocoding'->'provided_coordinates',
        NULL
    );

    -- Detect short-code presence (from context patch or persisted address). We only need a boolean guard.
    v_sa_short_code := NULLIF(v_context->'geocoding'->>'short_code', '');
    IF v_sa_short_code IS NULL AND v_ctx.address_id IS NOT NULL AND v_ctx.organization_id IS NOT NULL THEN
        SELECT NULLIF(a.sa_short_code, '')
        INTO v_sa_short_code
        FROM public.addresses a
        WHERE a.id = v_ctx.address_id
          AND a.organization_id = v_ctx.organization_id
        LIMIT 1;
    END IF;

    v_short_code_present := v_sa_short_code IS NOT NULL;

    IF NOT v_reverse_enabled THEN
        v_within_bounds := FALSE;
    ELSIF v_coordinates IS NOT NULL THEN
        v_lat := COALESCE((v_coordinates->>'latitude')::NUMERIC, (v_coordinates->>'lat')::NUMERIC);
        v_lon := COALESCE((v_coordinates->>'longitude')::NUMERIC, (v_coordinates->>'lng')::NUMERIC);

        IF v_lat IS NULL OR v_lon IS NULL THEN
            v_within_bounds := FALSE;
        ELSIF v_require_bounds THEN
            v_within_bounds := v_lat BETWEEN -90 AND 90 AND v_lon BETWEEN -180 AND 180;
        END IF;
    ELSE
        v_within_bounds := FALSE;
    END IF;

    -- Local reverse via polygons is skipped when short-code is present (policy-driven), even if polygons match.
    IF v_reverse_enabled
       AND v_reverse_local_enabled
       AND v_coordinates IS NOT NULL
       AND v_within_bounds
       AND NOT (v_short_code_present AND v_skip_local_when_short_code) THEN

        v_point := ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326)::geometry;

        SELECT
            d.id AS district_id,
            d.name_en AS district_en,
            d.name_ar AS district_ar,
            c.id AS city_id,
            c.name_en AS city_en,
            c.name_ar AS city_ar,
            r.id AS region_id,
            r.name_en AS region_en,
            r.name_ar AS region_ar,
            ST_CollectionExtract(d.geom::geometry, 3) AS district_geom,
            ST_PointOnSurface(ST_CollectionExtract(d.geom::geometry, 3)) AS district_point
        INTO v_loc
        FROM public.sa_districts d
        JOIN public.sa_cities c ON c.id = d.city_id
        JOIN public.sa_regions r ON r.id = d.region_id
        WHERE d.geom IS NOT NULL
          AND ST_CollectionExtract(d.geom::geometry, 3) IS NOT NULL
          AND ST_Covers(ST_CollectionExtract(d.geom::geometry, 3), v_point)
        ORDER BY ST_Area(ST_CollectionExtract(d.geom::geometry, 3)) ASC NULLS LAST, d.id DESC
        LIMIT 1;

        IF FOUND AND v_loc.district_point IS NOT NULL THEN
            SELECT
                NULL::uuid AS canonical_district_id,
                NULL::uuid AS canonical_city_id
            INTO v_canonical;

            SELECT
                cd.id AS canonical_district_id,
                cd.city_id AS canonical_city_id
            INTO v_canonical
            FROM public.canonical_districts cd
            WHERE cd.organization_id = v_ctx.organization_id
              AND cd.source_district_id = v_loc.district_id
              AND cd.is_active = TRUE
            ORDER BY cd.updated_at DESC NULLS LAST, cd.id
            LIMIT 1;

            v_selected_geocode := jsonb_strip_nulls(jsonb_build_object(
                'provider_name', 'reverse_local',
                'is_primary', TRUE,
                'confidence_score', v_reverse_local_confidence,
                'accuracy_type', 'reverse_local_polygon',
                'coordinates', jsonb_build_object(
                    'latitude', v_lat,
                    'longitude', v_lon
                ),
                'metadata', jsonb_strip_nulls(jsonb_build_object(
                    'city_id', v_canonical.canonical_city_id,
                    'district_id', v_canonical.canonical_district_id,
                    'sa_region_id', v_loc.region_id,
                    'sa_city_id', v_loc.city_id,
                    'sa_district_id', v_loc.district_id,
                    'region_name_en', v_loc.region_en,
                    'city_name_en', v_loc.city_en,
                    'district_name_en', v_loc.district_en,
                    'region_name_ar', v_loc.region_ar,
                    'city_name_ar', v_loc.city_ar,
                    'district_name_ar', v_loc.district_ar
                ))
            ));

            IF v_ctx.address_id IS NOT NULL AND v_ctx.organization_id IS NOT NULL THEN
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
                    'reverse_local',
                    1,
                    'local',
                    'succeeded',
                    v_reverse_local_confidence,
                    GREATEST(0, floor(extract(epoch from clock_timestamp() - v_started_at) * 1000)::int),
                    jsonb_strip_nulls(jsonb_build_object(
                        'geocode', v_selected_geocode,
                        'match_source', 'sa_polygons',
                        'match_plugin', 'reverse_local',
                        'match_type', 'reverse_local_polygon',
                        'routing_reason', 'reverse_local_polygon'
                    )),
                    now(),
                    now()
                )
                RETURNING id INTO v_attempt_id;
            END IF;

            v_local_match := jsonb_strip_nulls(jsonb_build_object(
                'plugin', 'reverse_local',
                'match_type', 'reverse_local_polygon',
                'routing_reason', 'reverse_local_polygon',
                'score', v_reverse_local_confidence,
                'attempt_id', v_attempt_id,
                'district_id', v_loc.district_id,
                'district_name_en', v_loc.district_en,
                'district_name_ar', v_loc.district_ar,
                'city_id', v_loc.city_id,
                'city_name_en', v_loc.city_en,
                'city_name_ar', v_loc.city_ar,
                'region_id', v_loc.region_id,
                'region_name_en', v_loc.region_en,
                'region_name_ar', v_loc.region_ar,
                'canonical_city_id', v_canonical.canonical_city_id,
                'canonical_district_id', v_canonical.canonical_district_id,
                'coordinates', jsonb_build_object(
                    'latitude', ST_Y(v_loc.district_point)::numeric,
                    'longitude', ST_X(v_loc.district_point)::numeric
                )
            ));

            PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_local_match);
        END IF;
    END IF;

    -- Flag reverse provider routing when coords exist, reverse is enabled, and local reverse did not succeed.
    v_reverse_flag := v_reverse_enabled AND v_within_bounds AND v_coordinates IS NOT NULL AND v_local_match IS NULL;

    v_match := jsonb_strip_nulls(jsonb_build_object(
        'plugin', 'reverse',
        'match_type', CASE
            WHEN NOT v_reverse_enabled THEN 'reverse_disabled'
            WHEN v_coordinates IS NULL THEN 'reverse_missing'
            WHEN NOT v_within_bounds THEN 'reverse_bounds'
            WHEN v_short_code_present AND v_skip_local_when_short_code THEN 'reverse_local_skipped_short_code'
            WHEN v_local_match IS NOT NULL THEN 'reverse_local_polygon'
            ELSE 'reverse_checked'
        END,
        'score', CASE WHEN v_local_match IS NOT NULL THEN v_reverse_local_confidence ELSE NULL END,
        'coords_valid', v_within_bounds,
        'routing_reason', CASE
            WHEN v_short_code_present AND v_skip_local_when_short_code THEN 'reverse_local_skipped_short_code'
            WHEN v_local_match IS NOT NULL THEN 'reverse_local_polygon'
            WHEN NOT v_reverse_enabled THEN 'reverse_plugin_disabled'
            WHEN v_coordinates IS NULL THEN 'reverse_payload_missing'
            WHEN NOT v_within_bounds THEN 'reverse_out_of_bounds'
            ELSE 'reverse_checked'
        END,
        'short_code_present', CASE WHEN v_short_code_present THEN TRUE ELSE NULL END
    ));
    PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'coordinates_present', v_coordinates IS NOT NULL,
        'within_bounds', v_within_bounds,
        'reverse_enabled', v_reverse_enabled,
        'reverse_local_enabled', v_reverse_local_enabled,
        'short_code_present', v_short_code_present,
        'skip_local_when_short_code', CASE WHEN v_short_code_present THEN v_skip_local_when_short_code ELSE NULL END,
        'local_reverse_match', v_local_match
    ));
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'provided_coordinates', v_coordinates,
            'coordinates_valid', v_within_bounds,
            'reverse_plugin_enabled', v_reverse_enabled,
            'reverse_local_plugin_enabled', v_reverse_local_enabled,
            'local_reverse_match', v_local_match,
            'reverse_geocode', CASE WHEN v_reverse_flag THEN TRUE ELSE NULL END,
            'successful', CASE WHEN v_local_match IS NOT NULL THEN TRUE ELSE NULL END,
            'selected_geocode', v_selected_geocode
        ))
    );

    RETURN v_response;
END;
$$;

ALTER FUNCTION workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps, workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMIT;

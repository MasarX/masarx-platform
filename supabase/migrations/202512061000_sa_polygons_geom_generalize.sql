-- Migration: Saudi polygons geometry generalization + reverse_local robustness
-- Purpose: Allow seeding GeometryCollection polygons and ensure reverse_local extracts polygons safely.
-- Alignment: SIMPLE · SCALABLE · DYNAMIC (no hardcoding; workflow + row driven)

BEGIN;

-- Allow GeometryCollection/MultiPolygon shapes from the seed data
ALTER TABLE public.sa_cities DROP CONSTRAINT IF EXISTS sa_cities_region_id_fkey;
ALTER TABLE public.sa_districts DROP CONSTRAINT IF EXISTS sa_districts_city_id_fkey;
ALTER TABLE public.sa_districts DROP CONSTRAINT IF EXISTS sa_districts_region_id_fkey;

ALTER TABLE public.sa_regions
  ALTER COLUMN id TYPE BIGINT USING id::BIGINT;

ALTER TABLE public.sa_cities
  ALTER COLUMN id TYPE BIGINT USING id::BIGINT,
  ALTER COLUMN region_id TYPE BIGINT USING region_id::BIGINT;

ALTER TABLE public.sa_districts
  ALTER COLUMN id TYPE BIGINT USING id::BIGINT,
  ALTER COLUMN city_id TYPE BIGINT USING city_id::BIGINT,
  ALTER COLUMN region_id TYPE BIGINT USING region_id::BIGINT;

ALTER TABLE public.sa_cities
  ADD CONSTRAINT sa_cities_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.sa_regions(id);

ALTER TABLE public.sa_districts
  ADD CONSTRAINT sa_districts_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.sa_cities(id);

ALTER TABLE public.sa_districts
  ADD CONSTRAINT sa_districts_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.sa_regions(id);

ALTER TABLE public.sa_regions
  ALTER COLUMN geom TYPE geometry USING geom::geometry,
  ALTER COLUMN bbox TYPE geometry USING bbox::geometry,
  ALTER COLUMN centroid TYPE geometry USING centroid::geometry;

ALTER TABLE public.sa_cities
  ALTER COLUMN bbox TYPE geometry USING bbox::geometry,
  ALTER COLUMN centroid TYPE geometry USING centroid::geometry;

ALTER TABLE public.sa_districts
  ALTER COLUMN geom TYPE geometry USING geom::geometry,
  ALTER COLUMN bbox TYPE geometry USING bbox::geometry,
  ALTER COLUMN centroid TYPE geometry USING centroid::geometry;

-- Harden reverse_local to extract polygons before containment/centroid
SET search_path TO public, workflow_handlers, extensions, pg_temp;

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
    v_reverse_local_plugin JSONB := geocoding_get_plugin(v_policy, 'reverse_local');
    v_reverse_enabled BOOLEAN := COALESCE(v_reverse_plugin->>'enabled', 'true')::BOOLEAN;
    v_reverse_local_enabled BOOLEAN := COALESCE(v_reverse_local_plugin->>'enabled', 'true')::BOOLEAN;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_coordinates JSONB;
    v_lat NUMERIC;
    v_lon NUMERIC;
    v_within_bounds BOOLEAN := TRUE;
    v_local_match JSONB := NULL;
    v_response workflow_handler_response;
    v_match JSONB := NULL;
    v_point GEOMETRY;
    v_loc RECORD;
    v_district_geom GEOMETRY;
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

    -- Local reverse via polygons (district -> city -> region) when enabled and coords are valid
    IF v_reverse_enabled AND v_reverse_local_enabled AND v_coordinates IS NOT NULL AND v_within_bounds THEN
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
            ST_Centroid(ST_CollectionExtract(d.geom::geometry, 3)) AS district_centroid
        INTO v_loc
        FROM public.sa_districts d
        JOIN public.sa_cities c ON c.id = d.city_id
        JOIN public.sa_regions r ON r.id = d.region_id
        WHERE d.geom IS NOT NULL
          AND ST_CollectionExtract(d.geom::geometry, 3) IS NOT NULL
          AND ST_Contains(ST_CollectionExtract(d.geom::geometry, 3), v_point)
        ORDER BY ST_Area(ST_CollectionExtract(d.geom::geometry, 3)) ASC NULLS LAST, d.id DESC
        LIMIT 1;

        IF FOUND AND v_loc.district_centroid IS NOT NULL THEN
            v_local_match := jsonb_strip_nulls(jsonb_build_object(
                'plugin', 'reverse_local',
                'match_type', 'reverse_local_polygon',
                'routing_reason', 'reverse_local_polygon',
                'district_id', v_loc.district_id,
                'district_name_en', v_loc.district_en,
                'district_name_ar', v_loc.district_ar,
                'city_id', v_loc.city_id,
                'city_name_en', v_loc.city_en,
                'city_name_ar', v_loc.city_ar,
                'region_id', v_loc.region_id,
                'region_name_en', v_loc.region_en,
                'region_name_ar', v_loc.region_ar,
                'coordinates', jsonb_build_object(
                    'latitude', ST_Y(v_loc.district_centroid),
                    'longitude', ST_X(v_loc.district_centroid)
                )
            ));
            PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_local_match);
        END IF;
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'coordinates_present', v_coordinates IS NOT NULL,
        'within_bounds', v_within_bounds,
        'reverse_enabled', v_reverse_enabled,
        'reverse_local_enabled', v_reverse_local_enabled,
        'local_reverse_match', v_local_match
    ));
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'provided_coordinates', v_coordinates,
            'coordinates_valid', v_within_bounds,
            'reverse_plugin_enabled', v_reverse_enabled,
            'reverse_local_plugin_enabled', v_reverse_local_enabled,
            'local_reverse_match', v_local_match
        ))
    );

    v_match := jsonb_strip_nulls(jsonb_build_object(
      'plugin', 'reverse',
      'match_type', CASE
        WHEN NOT v_reverse_enabled THEN 'reverse_disabled'
        WHEN v_coordinates IS NULL THEN 'reverse_missing'
        WHEN NOT v_within_bounds THEN 'reverse_bounds'
        ELSE 'reverse_checked'
      END,
      'score', NULL,
      'tokens', NULL,
      'coords_valid', v_within_bounds
    ));

    IF COALESCE(v_logging->>'log_scoring_details','false')::BOOLEAN THEN
      PERFORM geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);
    END IF;

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Validates provided coordinates, performs optional local reverse (polygon containment), and records outcome.';

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT p.oid::regprocedure AS proc
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'workflow_handlers'
          AND proname IN ('execute_geo_coordinate_v1')
    LOOP
        EXECUTE format(
            'ALTER FUNCTION %s SET search_path TO workflow_handlers, public, extensions, pg_temp',
            rec.proc
        );
    END LOOP;
END;
$$;

COMMIT;

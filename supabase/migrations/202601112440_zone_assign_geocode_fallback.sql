-- Migration: Zone assign fallbacks for geocode-first workflows
-- Purpose:
--   - Avoid blocking geocode-first workflows when shipment is created after dispatch.
--   - Resolve canonical district via geocoding_attempts/address fallback when context lacks it.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_zone_assign_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx RECORD;
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_success BOOLEAN := FALSE;
  v_canonical_district_text TEXT;
  v_canonical_district_id UUID;
  v_source_district_id BIGINT;
  v_zone_id UUID;
  v_updated INT := 0;
  v_now TIMESTAMPTZ := now();
  v_response public.workflow_handler_response;
  v_lat NUMERIC;
  v_lon NUMERIC;
  v_point GEOGRAPHY;
  v_attempt_meta JSONB;
  v_attempt_geo JSONB;
  v_attempt_geo_meta JSONB;
  v_address_district TEXT;
  v_address_city TEXT;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);

  IF v_ctx.organization_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'organization_missing');
    RETURN v_response;
  END IF;

  IF v_ctx.shipment_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  BEGIN
    v_success := COALESCE((v_context->'geocoding'->>'successful')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_success := FALSE;
  END;

  IF NOT v_success AND v_ctx.address_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.geocodes g
      WHERE g.address_id = v_ctx.address_id
        AND g.is_primary = TRUE
    )
    INTO v_success;
  END IF;

  IF NOT v_success THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'geocoding_not_successful');
    RETURN v_response;
  END IF;

  -- Prefer canonical UUID from workflow context; fallback to source_district_id mapping.
  v_canonical_district_text := NULLIF(v_context #>> '{geocoding,local_reverse_match,canonical_district_id}', '');
  IF v_canonical_district_text IS NULL THEN
    v_canonical_district_text := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,canonical_district_id}', '');
  END IF;
  IF v_canonical_district_text IS NULL THEN
    v_canonical_district_text := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,district_id}', '');
  END IF;
  IF v_canonical_district_text IS NULL THEN
    v_canonical_district_text := NULLIF(v_context #>> '{geocoding,local_reverse_match,district_id}', '');
  END IF;

  BEGIN
    v_canonical_district_id := NULLIF(v_canonical_district_text, '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_canonical_district_id := NULL;
  END;

  IF v_canonical_district_id IS NULL THEN
    v_source_district_id := NULL;

    BEGIN
      v_source_district_id := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,source_district_id}', '')::BIGINT;
    EXCEPTION
      WHEN others THEN
        v_source_district_id := NULL;
    END;

    IF v_source_district_id IS NULL THEN
      BEGIN
        v_source_district_id := NULLIF(v_context #>> '{geocoding,local_reverse_match,district_id}', '')::BIGINT;
      EXCEPTION
        WHEN others THEN
          v_source_district_id := NULL;
      END;
    END IF;

    IF v_source_district_id IS NULL THEN
      BEGIN
        v_source_district_id := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,district_id}', '')::BIGINT;
      EXCEPTION
        WHEN others THEN
          v_source_district_id := NULL;
      END;
    END IF;

    -- Fallback: look up latest successful geocoding_attempts metadata.
    IF v_ctx.address_id IS NOT NULL THEN
      SELECT ga.metadata
      INTO v_attempt_meta
      FROM public.geocoding_attempts ga
      WHERE ga.address_id = v_ctx.address_id
        AND ga.organization_id = v_ctx.organization_id
        AND ga.status = 'succeeded'
      ORDER BY ga.created_at DESC
      LIMIT 1;

      v_attempt_geo := COALESCE(v_attempt_meta->'geocode', v_attempt_meta);
      v_attempt_geo_meta := COALESCE(v_attempt_geo->'metadata', '{}'::jsonb);

      v_canonical_district_text := NULLIF(v_attempt_geo_meta->>'canonical_district_id', '');
      IF v_canonical_district_text IS NULL THEN
        v_canonical_district_text := NULLIF(v_attempt_geo_meta->>'district_id', '');
      END IF;

      BEGIN
        v_canonical_district_id := NULLIF(v_canonical_district_text, '')::UUID;
      EXCEPTION
        WHEN others THEN
          v_canonical_district_id := NULL;
      END;

      IF v_canonical_district_id IS NULL AND v_source_district_id IS NULL THEN
        BEGIN
          v_source_district_id := NULLIF(v_attempt_geo_meta->>'source_district_id', '')::BIGINT;
        EXCEPTION
          WHEN others THEN
            v_source_district_id := NULL;
        END;
      END IF;
    END IF;

    IF v_canonical_district_id IS NULL AND v_source_district_id IS NOT NULL THEN
      SELECT cd.id
      INTO v_canonical_district_id
      FROM public.canonical_districts cd
      WHERE cd.organization_id = v_ctx.organization_id
        AND cd.source_district_id = v_source_district_id
        AND cd.is_active = TRUE
      ORDER BY cd.updated_at DESC NULLS LAST, cd.id
      LIMIT 1;
    END IF;
  END IF;

  -- Fallback: match by address district name when canonical id is still missing.
  IF v_canonical_district_id IS NULL AND v_ctx.address_id IS NOT NULL THEN
    SELECT a.district, a.city
    INTO v_address_district, v_address_city
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id;

    IF v_address_district IS NOT NULL THEN
      SELECT cd.id
      INTO v_canonical_district_id
      FROM public.canonical_districts cd
      JOIN public.canonical_cities cc ON cc.id = cd.city_id
      WHERE cd.organization_id = v_ctx.organization_id
        AND cd.is_active = TRUE
        AND (
          lower(cd.name_canonical) = lower(v_address_district)
          OR EXISTS (
            SELECT 1
            FROM unnest(COALESCE(cd.alternate_names, ARRAY[]::text[])) alt(name)
            WHERE lower(alt.name) = lower(v_address_district)
          )
        )
        AND (v_address_city IS NULL OR lower(cc.name_canonical) = lower(v_address_city))
      ORDER BY cd.updated_at DESC NULLS LAST, cd.id
      LIMIT 1;
    END IF;
  END IF;

  -- Last-resort fallback: nearest canonical district centroid from coordinates.
  IF v_canonical_district_id IS NULL THEN
    BEGIN
      v_lat := NULLIF(v_context #>> '{geocoding,selected_geocode,coordinates,latitude}', '')::NUMERIC;
      v_lon := NULLIF(v_context #>> '{geocoding,selected_geocode,coordinates,longitude}', '')::NUMERIC;
    EXCEPTION
      WHEN others THEN
        v_lat := NULL;
        v_lon := NULL;
    END;

    IF v_lat IS NULL OR v_lon IS NULL THEN
      BEGIN
        v_lat := NULLIF(v_context #>> '{geocoding,local_reverse_match,coordinates,latitude}', '')::NUMERIC;
        v_lon := NULLIF(v_context #>> '{geocoding,local_reverse_match,coordinates,longitude}', '')::NUMERIC;
      EXCEPTION
        WHEN others THEN
          v_lat := NULL;
          v_lon := NULL;
      END;
    END IF;

    IF v_lat IS NULL OR v_lon IS NULL THEN
      BEGIN
        v_lat := NULLIF(v_context #>> '{geocoding,provided_coordinates,latitude}', '')::NUMERIC;
        v_lon := NULLIF(v_context #>> '{geocoding,provided_coordinates,longitude}', '')::NUMERIC;
      EXCEPTION
        WHEN others THEN
          v_lat := NULL;
          v_lon := NULL;
      END;
    END IF;

    IF v_lat IS NOT NULL AND v_lon IS NOT NULL THEN
      v_point := ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326)::geography;
      SELECT cd.id
      INTO v_canonical_district_id
      FROM public.canonical_districts cd
      WHERE cd.organization_id = v_ctx.organization_id
        AND cd.is_active = TRUE
        AND cd.centroid IS NOT NULL
      ORDER BY ST_Distance(cd.centroid, v_point)
      LIMIT 1;
    END IF;
  END IF;

  IF v_canonical_district_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'canonical_district_missing');
    RETURN v_response;
  END IF;

  v_zone_id := public.resolve_zone_id_for_canonical_district(v_ctx.organization_id, v_canonical_district_id);

  IF v_zone_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', 'zone_unmapped',
      'canonical_district_id', v_canonical_district_id
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'routing', jsonb_build_object(
        'canonical_district_id', v_canonical_district_id,
        'zone_id', NULL
      )
    ));
    RETURN v_response;
  END IF;

  UPDATE public.shipments s
  SET zone_id = v_zone_id,
      updated_at = v_now,
      version = s.version + 1
  WHERE s.id = v_ctx.shipment_id
    AND (v_ctx.client_id IS NULL OR s.client_id = v_ctx.client_id)
    AND s.zone_id IS DISTINCT FROM v_zone_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.shipment_actions (
      id,
      shipment_id,
      organization_id,
      client_id,
      action_type,
      action_category,
      action_data,
      timestamp,
      created_at,
      performed_by_system
    )
    VALUES (
      gen_random_uuid(),
      v_ctx.shipment_id,
      v_ctx.organization_id,
      v_ctx.client_id,
      'zone_assigned',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'zone_id', v_zone_id,
        'canonical_district_id', v_canonical_district_id,
        'workflow_run_id', p_step.workflow_run_id
      )),
      v_now,
      v_now,
      'workflow_engine'
    );
  END IF;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'assigned', TRUE,
    'zone_id', v_zone_id,
    'canonical_district_id', v_canonical_district_id,
    'shipment_updated', (v_updated > 0)
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'routing', jsonb_build_object(
      'canonical_district_id', v_canonical_district_id,
      'zone_id', v_zone_id
    )
  ));
  RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_zone_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Resolve shipments.zone_id from canonical_district_id (context + geocode fallback); safe when shipments created post-dispatch.';

COMMIT;

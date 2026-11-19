-- Maps/SNA readiness continuation: preserve operator-provided coordinates as
-- canonical address truth when the row-driven geocoding policy allows provided
-- coordinates. Later local/geocode projections may still update validation
-- status and metadata lineage, but must not replace the submitted pin with a
-- district centroid.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606151430_maps_sna_preserve_submitted_coordinates_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.project_address_from_primary_geocode_v1(
  p_address_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_address RECORD;
  v_geocode RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_min_confidence NUMERIC := NULL;
  v_validation_status TEXT := 'requires_review';
  v_raw_input JSONB := NULL;
  v_provided_coordinates GEOGRAPHY(POINT, 4326) := NULL;
  v_projected_coordinates GEOGRAPHY(POINT, 4326) := NULL;
  v_coordinate_source TEXT := 'primary_geocode';
  v_use_provided_coordinates BOOLEAN := FALSE;
BEGIN
  SELECT *
    INTO v_address
    FROM public.addresses
   WHERE id = p_address_id
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'projected', FALSE,
      'reason', 'address_missing',
      'address_id', p_address_id
    );
  END IF;

  SELECT
      g.id,
      g.coordinates,
      g.confidence_score,
      g.provider_name,
      g.geocoded_at
    INTO v_geocode
    FROM public.geocodes g
   WHERE g.address_id = v_address.id
     AND g.client_id = v_address.client_id
     AND g.is_primary IS TRUE
     AND (g.expires_at IS NULL OR g.expires_at > now())
   ORDER BY g.geocoded_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'projected', FALSE,
      'reason', 'primary_geocode_missing',
      'address_id', v_address.id
    );
  END IF;

  v_policy := COALESCE(
    public.resolve_settings('geocoding_policy', 'client', v_address.client_id),
    public.resolve_settings('geocoding_policy', 'tenant', v_address.organization_id),
    public.resolve_settings('geocoding_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_min_confidence := COALESCE(
    NULLIF(v_policy #>> '{local_lookup,min_confidence}', '')::NUMERIC,
    NULLIF(v_policy #>> '{provider_agreement_rules,primary_threshold}', '')::NUMERIC,
    NULLIF(v_policy ->> 'primary_threshold', '')::NUMERIC
  );

  v_use_provided_coordinates := COALESCE(
    NULLIF(v_policy #>> '{coordinate_handling,use_provided_coordinates}', '')::BOOLEAN,
    NULLIF(v_policy ->> 'use_provided_coordinates', '')::BOOLEAN,
    FALSE
  );

  IF v_use_provided_coordinates THEN
    BEGIN
      v_raw_input := v_address.raw_input::jsonb;
    EXCEPTION
      WHEN OTHERS THEN
        v_raw_input := NULL;
    END;

    IF v_raw_input IS NOT NULL THEN
      v_provided_coordinates := public.address_coordinates_from_payload_v1(v_raw_input);
    END IF;
  END IF;

  IF v_provided_coordinates IS NOT NULL THEN
    v_projected_coordinates := v_provided_coordinates;
    v_coordinate_source := 'provided_coordinates';
  ELSE
    v_projected_coordinates := v_geocode.coordinates;
  END IF;

  IF v_min_confidence IS NOT NULL
     AND COALESCE(v_geocode.confidence_score, 0) >= v_min_confidence THEN
    v_validation_status := 'valid';
  END IF;

  PERFORM set_config('app.address_versioning_skip', '1', true);
  BEGIN
    UPDATE public.addresses
       SET coordinates = v_projected_coordinates,
           validation_status = v_validation_status
     WHERE id = v_address.id
       AND client_id = v_address.client_id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('app.address_versioning_skip', '0', true);
      RAISE;
  END;
  PERFORM set_config('app.address_versioning_skip', '0', true);

  RETURN jsonb_build_object(
    'projected', TRUE,
    'address_id', v_address.id,
    'geocode_id', v_geocode.id,
    'provider_name', v_geocode.provider_name,
    'confidence_score', v_geocode.confidence_score,
    'min_confidence', v_min_confidence,
    'validation_status', v_validation_status,
    'geocoded_at', v_geocode.geocoded_at,
    'coordinate_source', v_coordinate_source,
    'provided_coordinates_preserved', v_provided_coordinates IS NOT NULL
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) IS
  'Projects canonical geocode validation onto addresses while preserving operator-provided coordinates when geocoding_policy.coordinate_handling.use_provided_coordinates is enabled.';

SELECT pg_advisory_unlock(hashtext('202606151430_maps_sna_preserve_submitted_coordinates_v1'));
COMMIT;

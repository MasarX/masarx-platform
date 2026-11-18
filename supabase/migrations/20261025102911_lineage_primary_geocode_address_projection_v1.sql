-- Project canonical geocode truth without replacing an allowed submitted pin.
-- Original donor: 759e5dfce0c365a54304d30d9b87a479a9c6b67f
-- Original blob: 1bdab293affcfba107f86a8355455f2b8cd166f1
-- Pin-preserving donor: afa501d0c87409b569d0cae891a7d6a2d140ee54
-- Pin-preserving blob: e3447ee0016ba15cdd00b70dba8d7f1f8d01dd21
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('lineage_primary_geocode_projection_v1'));

CREATE OR REPLACE FUNCTION public.project_address_from_primary_geocode_v1(
  p_address_id UUID, p_client_id UUID
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
  v_validation_status TEXT := 'needs_review';
  v_raw_input JSONB := NULL;
  v_provided_coordinates GEOGRAPHY(POINT, 4326) := NULL;
  v_projected_coordinates GEOGRAPHY(POINT, 4326) := NULL;
  v_coordinate_source TEXT := 'primary_geocode';
  v_use_provided_coordinates BOOLEAN := FALSE;
  v_previous_skip TEXT := COALESCE(current_setting('app.address_versioning_skip',true),'');
BEGIN
  SELECT * INTO v_address FROM public.addresses
    WHERE id=p_address_id AND client_id=p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('projected',FALSE,'reason','address_missing','address_id',p_address_id);
  END IF;
  -- Match the carrier addresses_update policy instead of elevating a scoped geocode writer.
  IF auth.uid() IS NOT NULL AND NOT COALESCE(public.request_is_service_role_v1(),FALSE)
    AND NOT COALESCE(public.user_has_resource_capability_v1('addresses','write')
      AND (public.is_platform_user() OR (public.current_user_scope_type()='tenant'
        AND v_address.organization_id=public.current_user_org_id())),FALSE) THEN
    RETURN jsonb_build_object('projected',FALSE,'reason','address_write_scope_denied','address_id',p_address_id);
  END IF;
  IF v_address.last_corrected_at IS NOT NULL OR v_address.correction_count>0 THEN
    RETURN jsonb_build_object('projected',FALSE,'reason','manual_correction_preserved','address_id',p_address_id);
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

  -- Carrier addresses.validation_status is TEXT: pending/valid/invalid/needs_review, not a lookup contract.

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
       AND client_id = v_address.client_id
       AND (coordinates IS DISTINCT FROM v_projected_coordinates
         OR validation_status IS DISTINCT FROM v_validation_status);
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('app.address_versioning_skip', v_previous_skip, true);
      RAISE;
  END;
  PERFORM set_config('app.address_versioning_skip', v_previous_skip, true);

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

REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_address_from_primary_geocode_v1(UUID,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.project_address_from_primary_geocode_v1(p_address_id UUID)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp
AS $compatibility$
DECLARE v_clients uuid[];
BEGIN
  SELECT array_agg(a.client_id) INTO v_clients FROM public.addresses a WHERE a.id=p_address_id;
  IF COALESCE(cardinality(v_clients),0)=0 THEN
    RETURN jsonb_build_object('projected',FALSE,'reason','address_missing','address_id',p_address_id);
  ELSIF cardinality(v_clients)>1 THEN
    RETURN jsonb_build_object('projected',FALSE,'reason','address_ambiguous','address_id',p_address_id);
  END IF;
  RETURN public.project_address_from_primary_geocode_v1(p_address_id,v_clients[1]);
END;
$compatibility$;
REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.geocodes_project_primary_address_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp
AS $trigger$
BEGIN
  IF NEW.is_primary IS TRUE OR (TG_OP='UPDATE' AND OLD.is_primary IS TRUE) THEN
    PERFORM public.project_address_from_primary_geocode_v1(NEW.address_id,NEW.client_id);
  END IF;
  RETURN NEW;
END;
$trigger$;
REVOKE ALL ON FUNCTION public.geocodes_project_primary_address_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS geocodes_project_primary_address ON public.geocodes;
CREATE TRIGGER geocodes_project_primary_address
  AFTER INSERT OR UPDATE OF is_primary,coordinates,confidence_score,expires_at,geocoded_at ON public.geocodes
  FOR EACH ROW EXECUTE FUNCTION public.geocodes_project_primary_address_v1();
-- Reconcile existing pending rows once; the predicate makes reruns harmless and preserves manual corrections.
DO $backfill$
DECLARE v_address record;
BEGIN
  FOR v_address IN SELECT a.id,a.client_id FROM public.addresses a
    WHERE a.validation_status='pending' AND a.last_corrected_at IS NULL AND a.correction_count=0
      AND EXISTS(SELECT 1 FROM public.geocodes g WHERE g.address_id=a.id AND g.client_id=a.client_id
        AND g.is_primary IS TRUE AND (g.expires_at IS NULL OR g.expires_at>now()))
  LOOP
    PERFORM public.project_address_from_primary_geocode_v1(v_address.id,v_address.client_id);
  END LOOP;
END;
$backfill$;
COMMIT;

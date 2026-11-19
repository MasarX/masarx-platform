-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: record_vehicle_event_v1 — generic vehicle_events ledger append
-- Date: 2026-04-28
--
-- Notes:
--   - Generic append for fueling/inspection/repair/incident events.
--   - event_type must exist in lookup vehicle_event_type (extended via prior migrations
--     202604280020 for inspection/repair).
--   - Validation guards numeric fields; allows odometer/fuel/cost/currency optional fields.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280045_record_vehicle_event_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.record_vehicle_event_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_vehicle_id UUID;
  v_event_type TEXT;
  v_occurred_at TIMESTAMPTZ;
  v_odometer_km INT;
  v_fuel_liters NUMERIC;
  v_cost_amount NUMERIC;
  v_cost_currency TEXT;
  v_notes TEXT;
  v_metadata JSONB;
  v_artifact_id UUID;

  v_vehicle public.vehicles%ROWTYPE;
  v_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
  v_lookup_exists BOOLEAN;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_vehicle_id := NULLIF(p_args->>'vehicle_id', '')::UUID;
  v_event_type := lower(NULLIF(btrim(COALESCE(p_args->>'event_type', '')), ''));
  v_occurred_at := COALESCE(NULLIF(p_args->>'occurred_at', '')::TIMESTAMPTZ, now());
  v_odometer_km := NULLIF(p_args->>'odometer_km', '')::INT;
  v_fuel_liters := NULLIF(p_args->>'fuel_liters', '')::NUMERIC;
  v_cost_amount := NULLIF(p_args->>'cost_amount', '')::NUMERIC;
  v_cost_currency := NULLIF(btrim(COALESCE(p_args->>'cost_currency', '')), '');
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_artifact_id := NULLIF(p_args->>'artifact_id', '')::UUID;

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: vehicle_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_event_type IS NULL THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: event_type is required' USING ERRCODE = '22023';
  END IF;

  -- event_type must be in lookup vehicle_event_type (row-driven validation; no hardcoded set)
  SELECT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'vehicle_event_type'
       AND lv.value = v_event_type
  ) INTO v_lookup_exists;

  IF NOT v_lookup_exists THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: event_type % not in lookup vehicle_event_type', v_event_type
      USING ERRCODE = '22023';
  END IF;

  IF v_odometer_km IS NOT NULL AND v_odometer_km < 0 THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: odometer_km must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_fuel_liters IS NOT NULL AND v_fuel_liters < 0 THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: fuel_liters must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_cost_amount IS NOT NULL AND v_cost_amount < 0 THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: cost_amount must be >= 0' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_vehicle
    FROM public.vehicles
   WHERE id = v_vehicle_id
   LIMIT 1;
  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: vehicle % not found', v_vehicle_id USING ERRCODE = 'P0002';
  END IF;
  IF v_vehicle.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'record_vehicle_event_v1: vehicle % belongs to another organization', v_vehicle_id USING ERRCODE = '42501';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('fleet_policy', 'tenant', v_org_id);

  INSERT INTO public.vehicle_events (
    id,
    organization_id,
    vehicle_id,
    event_type,
    occurred_at,
    odometer_km,
    fuel_liters,
    cost_amount,
    cost_currency,
    actor_user_id,
    actor_system,
    notes,
    artifact_id,
    metadata
  )
  VALUES (
    v_event_id,
    v_org_id,
    v_vehicle_id,
    v_event_type,
    v_occurred_at,
    v_odometer_km,
    v_fuel_liters,
    v_cost_amount,
    v_cost_currency,
    auth.uid(),
    'record_vehicle_event_v1',
    v_notes,
    v_artifact_id,
    v_metadata
      || jsonb_build_object(
           'correlation_id', v_correlation_id,
           'fleet_policy_resolution', COALESCE(v_resolved_settings, '{}'::jsonb)
         )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.vehicle_event_recorded',
    'vehicle_event',
    v_event_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'event_type', v_event_type,
      'occurred_at', v_occurred_at,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.vehicle_event_recorded',
    'vehicle_event',
    v_event_id,
    'rpc_dispatch',
    'recorded',
    'record_vehicle_event_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'event_type', v_event_type,
      'fleet_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_notes
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_event_id', v_event_id,
    'vehicle_id', v_vehicle_id,
    'event_type', v_event_type,
    'occurred_at', v_occurred_at,
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_vehicle_event_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_vehicle_event_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.record_vehicle_event_v1(JSONB)
  IS 'Canonical RPC: append a row to public.vehicle_events. event_type must be a value in lookup vehicle_event_type (row-driven). Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280045_record_vehicle_event_v1'));
COMMIT;

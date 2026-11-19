-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: assign_driver_to_vehicle_v1 — bind a driver to a vehicle (active assignment row)
-- Date: 2026-04-28
--
-- Contract:
--   - Capability gate: fleet.write (asserted via assert_capability_v1)
--   - Resolves fleet_policy via override ladder (resolve_settings_merged); records resolution context
--   - Idempotent semantics: closes any existing active assignment for the vehicle, then opens a new one
--   - Emits domain_events row + decision_log row (canonical envelope)
--   - Returns canonical envelope { ok, vehicle_assignment_id, vehicle_id, driver_user_id, correlation_id, ... }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280010_assign_driver_to_vehicle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.assign_driver_to_vehicle_v1(p_args JSONB)
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
  v_driver_user_id UUID;
  v_branch_id UUID;
  v_metadata JSONB;

  v_vehicle public.vehicles%ROWTYPE;
  v_driver_profile public.driver_profiles%ROWTYPE;

  v_assignment_id UUID := gen_random_uuid();
  v_closed_count INT := 0;
  v_correlation_id UUID := gen_random_uuid();

  v_resolved_settings JSONB;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: p_args must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: authenticated tenant user required'
      USING ERRCODE = '42501';
  END IF;

  -- 1) Capability gate (raises Capability denied / 42501 when missing)
  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  -- 2) Argument unpack + validate
  v_vehicle_id := NULLIF(p_args->>'vehicle_id', '')::UUID;
  v_driver_user_id := NULLIF(p_args->>'driver_user_id', '')::UUID;
  v_branch_id := NULLIF(p_args->>'branch_id', '')::UUID;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: vehicle_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: driver_user_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- 3) Resolve canonical rows + tenant scope guard
  SELECT *
    INTO v_vehicle
    FROM public.vehicles
   WHERE id = v_vehicle_id
   FOR UPDATE;

  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: vehicle % not found', v_vehicle_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_vehicle.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: vehicle % belongs to another organization', v_vehicle_id
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_driver_profile
    FROM public.driver_profiles
   WHERE user_id = v_driver_user_id
     AND organization_id = v_org_id
   LIMIT 1;

  IF v_driver_profile.id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: driver_profile for user % not found in organization %', v_driver_user_id, v_org_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_driver_profile.status <> 'active' THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: driver_profile % is not active (status=%)', v_driver_profile.id, v_driver_profile.status
      USING ERRCODE = '22023';
  END IF;

  -- 4) Resolve fleet_policy via override ladder (no inline literals)
  v_resolved_settings := public.resolve_settings_merged(
    'fleet_policy',
    'tenant',
    v_org_id
  );

  -- 5) Close any existing active assignment for this vehicle (single-active invariant)
  WITH closed AS (
    UPDATE public.vehicle_assignments
       SET status = 'ended',
           ended_at = now(),
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('closed_by_assign_v1', v_correlation_id, 'closed_reason', 'reassigned')
     WHERE vehicle_id = v_vehicle_id
       AND organization_id = v_org_id
       AND status = 'active'
       AND ended_at IS NULL
    RETURNING id
  )
  SELECT COUNT(*)::INT INTO v_closed_count FROM closed;

  -- 6) Insert the new active assignment
  INSERT INTO public.vehicle_assignments (
    id,
    organization_id,
    vehicle_id,
    assigned_to_user_id,
    branch_id,
    status,
    started_at,
    metadata
  )
  VALUES (
    v_assignment_id,
    v_org_id,
    v_vehicle_id,
    v_driver_user_id,
    COALESCE(v_branch_id, v_vehicle.branch_id),
    'active',
    now(),
    v_metadata
      || jsonb_build_object(
           'driver_profile_id', v_driver_profile.id,
           'correlation_id', v_correlation_id,
           'fleet_policy_resolution', COALESCE(v_resolved_settings, '{}'::jsonb)
         )
  );

  -- 7) Emit canonical domain_event (engine-first contract)
  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.driver_assigned',
    'vehicle_assignment',
    v_assignment_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'driver_user_id', v_driver_user_id,
      'driver_profile_id', v_driver_profile.id,
      'closed_prior_active', v_closed_count,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  -- 8) Emit decision_log row tied to resolution
  PERFORM public.log_decision(
    v_org_id,
    'fleet.driver_assigned',
    'vehicle_assignment',
    v_assignment_id,
    'rpc_dispatch',
    'assigned',
    'assign_driver_to_vehicle_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'driver_user_id', v_driver_user_id,
      'driver_profile_id', v_driver_profile.id,
      'closed_prior_active', v_closed_count,
      'fleet_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    NULL
  );

  -- 9) Canonical envelope
  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_assignment_id', v_assignment_id,
    'vehicle_id', v_vehicle_id,
    'driver_user_id', v_driver_user_id,
    'driver_profile_id', v_driver_profile.id,
    'closed_prior_active', v_closed_count,
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_driver_to_vehicle_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_driver_to_vehicle_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.assign_driver_to_vehicle_v1(JSONB)
  IS 'Canonical RPC: bind a driver (driver_user_id) to a vehicle. Closes any existing active vehicle_assignments row for the vehicle, then opens a new one. Capability-gated (fleet.write); emits domain_events + decision_log; resolves fleet_policy via the override ladder.';

SELECT pg_advisory_unlock(hashtext('202604280010_assign_driver_to_vehicle_v1'));
COMMIT;

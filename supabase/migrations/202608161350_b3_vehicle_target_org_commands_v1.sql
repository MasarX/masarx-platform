-- Console V2 vehicle creation: align selected-tenant platform Console writes
-- with create_driver_v1 target-organization semantics.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606120815_console_v2_vehicle_create_target_org_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_vehicle_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_caller_org_id UUID := public.current_user_org_id();
  v_target_org_id UUID;

  v_plate_number TEXT;
  v_vehicle_type_id UUID;
  v_branch_id UUID;
  v_status TEXT;
  v_vin TEXT;
  v_make TEXT;
  v_model TEXT;
  v_model_year INT;
  v_color TEXT;
  v_acquired_at TIMESTAMPTZ;
  v_metadata JSONB;

  v_vehicle_type public.vehicle_types%ROWTYPE;
  v_branch public.branches%ROWTYPE;
  v_vehicle_id UUID;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'create_vehicle_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_caller_org_id IS NULL THEN
    RAISE EXCEPTION 'create_vehicle_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_target_org_id := COALESCE(
    NULLIF(btrim(COALESCE(p_args->>'organization_id', p_args->>'tenant_organization_id', '')), '')::UUID,
    v_caller_org_id
  );
  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'create_vehicle_v1: organization_id could not be resolved' USING ERRCODE = '42501';
  END IF;
  IF v_target_org_id <> v_caller_org_id AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'create_vehicle_v1: organization % outside tenant scope', v_target_org_id USING ERRCODE = '42501';
  END IF;

  v_plate_number := NULLIF(btrim(COALESCE(p_args->>'plate_number', p_args->>'plate', '')), '');
  v_vehicle_type_id := NULLIF(btrim(COALESCE(p_args->>'vehicle_type_id', p_args->>'type_id', '')), '')::UUID;
  v_branch_id := NULLIF(btrim(COALESCE(p_args->>'branch_id', p_args->>'current_branch_id', '')), '')::UUID;
  v_status := lower(NULLIF(btrim(COALESCE(p_args->>'status', '')), ''));
  v_vin := NULLIF(btrim(COALESCE(p_args->>'vin', '')), '');
  v_make := NULLIF(btrim(COALESCE(p_args->>'make', '')), '');
  v_model := NULLIF(btrim(COALESCE(p_args->>'model', '')), '');
  v_color := NULLIF(btrim(COALESCE(p_args->>'color', '')), '');
  v_acquired_at := NULLIF(btrim(COALESCE(p_args->>'acquired_at', '')), '')::TIMESTAMPTZ;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  BEGIN
    v_model_year := NULLIF(btrim(COALESCE(p_args->>'model_year', '')), '')::INT;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'create_vehicle_v1: model_year must be an integer when provided' USING ERRCODE = '22023';
  END;

  IF v_plate_number IS NULL THEN
    RAISE EXCEPTION 'create_vehicle_v1: plate_number is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'create_vehicle_v1: metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;

  IF v_status IS NULL THEN
    SELECT lv.value
      INTO v_status
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'vehicle_status'
       AND lv.is_default IS TRUE
     ORDER BY lv.sort_order, lv.value
     LIMIT 1;
  END IF;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'create_vehicle_v1: no default vehicle_status lookup row is configured' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'vehicle_status'
       AND lv.value = v_status
  ) THEN
    RAISE EXCEPTION 'create_vehicle_v1: status % not in lookup vehicle_status', v_status USING ERRCODE = '22023';
  END IF;

  IF v_vehicle_type_id IS NOT NULL THEN
    SELECT *
      INTO v_vehicle_type
      FROM public.vehicle_types
     WHERE id = v_vehicle_type_id
     LIMIT 1;
    IF v_vehicle_type.id IS NULL THEN
      RAISE EXCEPTION 'create_vehicle_v1: vehicle_type % not found', v_vehicle_type_id USING ERRCODE = 'P0002';
    END IF;
    IF v_vehicle_type.organization_id <> v_target_org_id THEN
      RAISE EXCEPTION 'create_vehicle_v1: vehicle_type % belongs to another organization', v_vehicle_type_id USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_branch_id IS NOT NULL THEN
    SELECT *
      INTO v_branch
      FROM public.branches
     WHERE id = v_branch_id
     LIMIT 1;
    IF v_branch.id IS NULL THEN
      RAISE EXCEPTION 'create_vehicle_v1: branch % not found', v_branch_id USING ERRCODE = 'P0002';
    END IF;
    IF v_branch.organization_id <> v_target_org_id THEN
      RAISE EXCEPTION 'create_vehicle_v1: branch % belongs to another organization', v_branch_id USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.vehicles (
    organization_id,
    branch_id,
    vehicle_type_id,
    status,
    plate_number,
    vin,
    make,
    model,
    model_year,
    color,
    acquired_at,
    metadata
  )
  VALUES (
    v_target_org_id,
    v_branch_id,
    v_vehicle_type_id,
    v_status,
    v_plate_number,
    v_vin,
    v_make,
    v_model,
    v_model_year,
    v_color,
    v_acquired_at,
    v_metadata || jsonb_build_object(
      'created_by', 'create_vehicle_v1',
      'created_correlation_id', v_correlation_id,
      'requested_organization_id', v_target_org_id
    )
  )
  RETURNING id INTO v_vehicle_id;

  PERFORM public.enqueue_domain_event(
    v_target_org_id,
    'fleet.vehicle_created',
    'vehicle',
    v_vehicle_id,
    jsonb_build_object(
      'plate_number', v_plate_number,
      'vehicle_type_id', v_vehicle_type_id,
      'branch_id', v_branch_id,
      'status', v_status,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_target_org_id,
    'fleet.vehicle_created',
    'vehicle',
    v_vehicle_id,
    'rpc_dispatch',
    'created',
    'create_vehicle_v1',
    v_correlation_id,
    jsonb_build_object(
      'plate_number', v_plate_number,
      'vehicle_type_id', v_vehicle_type_id,
      'branch_id', v_branch_id,
      'vehicle_status_source', 'lookup_values.vehicle_status'
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_id', v_vehicle_id,
    'organization_id', v_target_org_id,
    'plate_number', v_plate_number,
    'vehicle_type_id', v_vehicle_type_id,
    'branch_id', v_branch_id,
    'status', v_status,
    'correlation_id', v_correlation_id,
    'resolved_from', 'vehicle_status/lookup'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.create_vehicle_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.create_vehicle_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.create_vehicle_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_vehicle_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_vehicle_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.create_vehicle_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.create_vehicle_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.create_vehicle_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_vehicle_v1(JSONB)
  IS 'Creates a fleet vehicle through the Console V2 product path. Tenant users stay scoped to their own org; platform users may target the selected tenant via organization_id after fleet.write capability.';
COMMENT ON FUNCTION api.create_vehicle_v1(JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.create_vehicle_v1(jsonb).';

SELECT pg_advisory_unlock(hashtext('202606120815_console_v2_vehicle_create_target_org_v1'));
COMMIT;

-- Console V2 vehicle assignment: align selected-tenant platform writes with
-- create_driver_v1/create_vehicle_v1 target-organization semantics.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606120830_console_v2_vehicle_assignment_target_org_v1'));
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
  v_caller_org_id UUID := public.current_user_org_id();
  v_target_org_id UUID;

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

  IF auth.uid() IS NULL OR v_caller_org_id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: authenticated tenant user required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_target_org_id := COALESCE(
    NULLIF(btrim(COALESCE(p_args->>'organization_id', p_args->>'tenant_organization_id', '')), '')::UUID,
    v_caller_org_id
  );
  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: organization_id could not be resolved'
      USING ERRCODE = '42501';
  END IF;
  IF v_target_org_id <> v_caller_org_id AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: organization % outside tenant scope', v_target_org_id
      USING ERRCODE = '42501';
  END IF;

  v_vehicle_id := NULLIF(btrim(COALESCE(p_args->>'vehicle_id', '')), '')::UUID;
  v_driver_user_id := NULLIF(btrim(COALESCE(p_args->>'driver_user_id', '')), '')::UUID;
  v_branch_id := NULLIF(btrim(COALESCE(p_args->>'branch_id', '')), '')::UUID;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: vehicle_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: driver_user_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: metadata must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_vehicle
    FROM public.vehicles
   WHERE id = v_vehicle_id
   FOR UPDATE;

  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: vehicle % not found', v_vehicle_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_vehicle.organization_id <> v_target_org_id THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: vehicle % belongs to another organization', v_vehicle_id
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_driver_profile
    FROM public.driver_profiles
   WHERE user_id = v_driver_user_id
     AND organization_id = v_target_org_id
   LIMIT 1;

  IF v_driver_profile.id IS NULL THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: driver_profile for user % not found in organization %', v_driver_user_id, v_target_org_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_driver_profile.status <> 'active' THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: driver_profile % is not active (status=%)', v_driver_profile.id, v_driver_profile.status
      USING ERRCODE = '22023';
  END IF;

  IF v_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.branches b
     WHERE b.id = v_branch_id
       AND b.organization_id = v_target_org_id
  ) THEN
    RAISE EXCEPTION 'assign_driver_to_vehicle_v1: branch % belongs to another organization', v_branch_id
      USING ERRCODE = '42501';
  END IF;

  v_resolved_settings := public.resolve_settings_merged(
    'fleet_policy',
    'tenant',
    v_target_org_id
  );

  WITH closed AS (
    UPDATE public.vehicle_assignments
       SET status = 'ended',
           ended_at = now(),
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('closed_by_assign_v1', v_correlation_id, 'closed_reason', 'reassigned')
     WHERE vehicle_id = v_vehicle_id
       AND organization_id = v_target_org_id
       AND status = 'active'
       AND ended_at IS NULL
    RETURNING id
  )
  SELECT COUNT(*)::INT INTO v_closed_count FROM closed;

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
    v_target_org_id,
    v_vehicle_id,
    v_driver_user_id,
    COALESCE(v_branch_id, v_vehicle.branch_id),
    'active',
    now(),
    v_metadata
      || jsonb_build_object(
           'driver_profile_id', v_driver_profile.id,
           'correlation_id', v_correlation_id,
           'fleet_policy_resolution', COALESCE(v_resolved_settings, '{}'::jsonb),
           'requested_organization_id', v_target_org_id
         )
  );

  PERFORM public.enqueue_domain_event(
    v_target_org_id,
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

  PERFORM public.log_decision(
    v_target_org_id,
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

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_assignment_id', v_assignment_id,
    'vehicle_id', v_vehicle_id,
    'driver_user_id', v_driver_user_id,
    'driver_profile_id', v_driver_profile.id,
    'organization_id', v_target_org_id,
    'closed_prior_active', v_closed_count,
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.assign_driver_to_vehicle_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.assign_driver_to_vehicle_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.assign_driver_to_vehicle_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_driver_to_vehicle_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_driver_to_vehicle_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.assign_driver_to_vehicle_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.assign_driver_to_vehicle_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.assign_driver_to_vehicle_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.assign_driver_to_vehicle_v1(JSONB)
  IS 'Canonical RPC: bind a driver to a vehicle. Tenant users stay scoped to their own org; platform users may target the selected tenant via organization_id after fleet.write capability.';
COMMENT ON FUNCTION api.assign_driver_to_vehicle_v1(JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.assign_driver_to_vehicle_v1(jsonb).';

SELECT pg_advisory_unlock(hashtext('202606120830_console_v2_vehicle_assignment_target_org_v1'));

COMMIT;

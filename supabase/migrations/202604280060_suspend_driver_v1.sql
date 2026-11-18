-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: suspend_driver_v1 — set driver_profiles.status='suspended'
-- Date: 2026-04-28

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280060_suspend_driver_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.suspend_driver_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_driver_profile_id UUID;
  v_driver_user_id UUID;
  v_reason TEXT;
  v_metadata JSONB;

  v_dp public.driver_profiles%ROWTYPE;
  v_compliance_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
  v_closed_assignment_count INT := 0;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'suspend_driver_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'suspend_driver_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_driver_profile_id := NULLIF(p_args->>'driver_profile_id', '')::UUID;
  v_driver_user_id := NULLIF(p_args->>'driver_user_id', '')::UUID;
  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_driver_profile_id IS NULL AND v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'suspend_driver_v1: driver_profile_id or driver_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'suspend_driver_v1: reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_dp
    FROM public.driver_profiles
   WHERE (v_driver_profile_id IS NOT NULL AND id = v_driver_profile_id)
      OR (v_driver_profile_id IS NULL AND user_id = v_driver_user_id AND organization_id = v_org_id)
   LIMIT 1
   FOR UPDATE;
  IF v_dp.id IS NULL THEN
    RAISE EXCEPTION 'suspend_driver_v1: driver_profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dp.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'suspend_driver_v1: driver_profile % belongs to another organization', v_dp.id USING ERRCODE = '42501';
  END IF;
  IF v_dp.status NOT IN ('active','inactive') THEN
    RAISE EXCEPTION 'suspend_driver_v1: driver_profile % is not in a suspendable state (status=%)', v_dp.id, v_dp.status
      USING ERRCODE = '22023';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('driver_compliance_policy', 'tenant', v_org_id);

  -- Suspend the driver
  UPDATE public.driver_profiles
     SET status = 'suspended',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'suspended_at', now(),
                         'suspended_reason', v_reason,
                         'suspended_correlation_id', v_correlation_id,
                         'suspended_by', auth.uid(),
                         'previous_status', v_dp.status
                       )
                    || COALESCE(v_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_dp.id;

  -- Close any active vehicle_assignments for this driver
  WITH closed AS (
    UPDATE public.vehicle_assignments
       SET status = 'ended',
           ended_at = now(),
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           'closed_by', 'suspend_driver_v1',
                           'closed_correlation_id', v_correlation_id,
                           'closed_reason', 'driver_suspended'
                         )
     WHERE assigned_to_user_id = v_dp.user_id
       AND organization_id = v_org_id
       AND status = 'active'
       AND ended_at IS NULL
    RETURNING id
  )
  SELECT COUNT(*)::INT INTO v_closed_assignment_count FROM closed;

  -- Emit compliance event in SSOT ledger
  INSERT INTO public.driver_compliance_events (
    id,
    organization_id,
    user_id,
    event_type,
    actor_user_id,
    actor_system,
    payload
  )
  VALUES (
    v_compliance_event_id,
    v_org_id,
    v_dp.user_id,
    'driver_suspended',
    auth.uid(),
    'suspend_driver_v1',
    jsonb_build_object(
      'driver_profile_id', v_dp.id,
      'previous_status', v_dp.status,
      'reason', v_reason,
      'closed_assignment_count', v_closed_assignment_count,
      'correlation_id', v_correlation_id,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.driver_suspended',
    'driver_profile',
    v_dp.id,
    jsonb_build_object(
      'driver_user_id', v_dp.user_id,
      'reason', v_reason,
      'closed_assignment_count', v_closed_assignment_count,
      'driver_compliance_event_id', v_compliance_event_id,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.driver_suspended',
    'driver_profile',
    v_dp.id,
    'rpc_dispatch',
    'suspended',
    'suspend_driver_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_user_id', v_dp.user_id,
      'previous_status', v_dp.status,
      'closed_assignment_count', v_closed_assignment_count,
      'driver_compliance_event_id', v_compliance_event_id,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_profile_id', v_dp.id,
    'driver_user_id', v_dp.user_id,
    'previous_status', v_dp.status,
    'status', 'suspended',
    'closed_assignment_count', v_closed_assignment_count,
    'driver_compliance_event_id', v_compliance_event_id,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_compliance_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.suspend_driver_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suspend_driver_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.suspend_driver_v1(JSONB)
  IS 'Canonical RPC: set driver_profiles.status=suspended with a required reason. Closes any active vehicle_assignments. Appends driver_compliance_events ledger row. Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280060_suspend_driver_v1'));
COMMIT;

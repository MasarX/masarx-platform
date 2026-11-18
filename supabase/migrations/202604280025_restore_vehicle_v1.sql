-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: restore_vehicle_v1 — OOS → active
-- Date: 2026-04-28
--
-- Notes:
--   - Restores a vehicle previously marked oos to status 'active' (canonical "in service" baseline).
--   - Idempotent: re-running on an already-active vehicle is a noop with auditable trail.
--   - Appends a vehicle_events row with event_type='oos_restored'.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280025_restore_vehicle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.restore_vehicle_v1(p_args JSONB)
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
  v_notes TEXT;
  v_metadata JSONB;

  v_vehicle public.vehicles%ROWTYPE;
  v_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
  v_was_oos BOOLEAN;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'restore_vehicle_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'restore_vehicle_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_vehicle_id := NULLIF(p_args->>'vehicle_id', '')::UUID;
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'restore_vehicle_v1: vehicle_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_vehicle
    FROM public.vehicles
   WHERE id = v_vehicle_id
   FOR UPDATE;

  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'restore_vehicle_v1: vehicle % not found', v_vehicle_id USING ERRCODE = 'P0002';
  END IF;
  IF v_vehicle.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'restore_vehicle_v1: vehicle % belongs to another organization', v_vehicle_id USING ERRCODE = '42501';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('fleet_policy', 'tenant', v_org_id);
  v_was_oos := (v_vehicle.status = 'oos');

  -- Restore status to active baseline (idempotent)
  UPDATE public.vehicles
     SET status = 'active',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'oos_restored_at', now(),
                         'oos_restored_correlation_id', v_correlation_id
                       ),
         updated_at = now()
   WHERE id = v_vehicle_id
     AND status <> 'active';

  -- Append vehicle_events row (always, even on noop, for auditability)
  INSERT INTO public.vehicle_events (
    id,
    organization_id,
    vehicle_id,
    event_type,
    occurred_at,
    actor_user_id,
    actor_system,
    notes,
    metadata
  )
  VALUES (
    v_event_id,
    v_org_id,
    v_vehicle_id,
    'oos_restored',
    now(),
    auth.uid(),
    'restore_vehicle_v1',
    v_notes,
    v_metadata
      || jsonb_build_object(
           'previous_status', v_vehicle.status,
           'was_oos', v_was_oos,
           'correlation_id', v_correlation_id,
           'fleet_policy_resolution', COALESCE(v_resolved_settings, '{}'::jsonb)
         )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.vehicle_oos_restored',
    'vehicle',
    v_vehicle_id,
    jsonb_build_object(
      'vehicle_event_id', v_event_id,
      'previous_status', v_vehicle.status,
      'was_oos', v_was_oos,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.vehicle_oos_restored',
    'vehicle',
    v_vehicle_id,
    'rpc_dispatch',
    CASE WHEN v_was_oos THEN 'restored' ELSE 'noop' END,
    'restore_vehicle_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_event_id', v_event_id,
      'previous_status', v_vehicle.status,
      'fleet_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_notes
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_id', v_vehicle_id,
    'vehicle_event_id', v_event_id,
    'previous_status', v_vehicle.status,
    'was_oos', v_was_oos,
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_vehicle_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_vehicle_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.restore_vehicle_v1(JSONB)
  IS 'Canonical RPC: restore a vehicle to status=active. Idempotent. Appends vehicle_events ledger row (event_type=oos_restored). Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280025_restore_vehicle_v1'));
COMMIT;

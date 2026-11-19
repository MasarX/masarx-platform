-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: complete_maintenance_v1 — close a scheduled maintenance window
-- Date: 2026-04-28

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280035_complete_maintenance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.complete_maintenance_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_window_id UUID;
  v_notes TEXT;
  v_metadata JSONB;

  v_window public.vehicle_maintenance_windows%ROWTYPE;
  v_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'complete_maintenance_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'complete_maintenance_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_window_id := NULLIF(p_args->>'vehicle_maintenance_window_id', '')::UUID;
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_window_id IS NULL THEN
    RAISE EXCEPTION 'complete_maintenance_v1: vehicle_maintenance_window_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_window
    FROM public.vehicle_maintenance_windows
   WHERE id = v_window_id
   FOR UPDATE;

  IF v_window.id IS NULL THEN
    RAISE EXCEPTION 'complete_maintenance_v1: window % not found', v_window_id USING ERRCODE = 'P0002';
  END IF;
  IF v_window.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'complete_maintenance_v1: window % belongs to another organization', v_window_id USING ERRCODE = '42501';
  END IF;
  IF v_window.status NOT IN ('scheduled') THEN
    RAISE EXCEPTION 'complete_maintenance_v1: window % is not in a completable state (status=%)', v_window_id, v_window.status
      USING ERRCODE = '22023';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('fleet_policy', 'tenant', v_org_id);

  UPDATE public.vehicle_maintenance_windows
     SET status = 'completed',
         completed_at = now(),
         notes = COALESCE(v_notes, notes),
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'completed_by', auth.uid(),
                         'completed_correlation_id', v_correlation_id
                       )
                    || COALESCE(v_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_window_id;

  -- Audit ledger row on the vehicle for cross-domain visibility
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
    v_window.vehicle_id,
    'maintenance',
    now(),
    auth.uid(),
    'complete_maintenance_v1',
    v_notes,
    jsonb_build_object(
      'maintenance_window_id', v_window_id,
      'window_start_at', v_window.window_start_at,
      'window_end_at', v_window.window_end_at,
      'reason', v_window.reason,
      'correlation_id', v_correlation_id,
      'fleet_policy_resolution', COALESCE(v_resolved_settings, '{}'::jsonb)
    )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.maintenance_completed',
    'vehicle_maintenance_window',
    v_window_id,
    jsonb_build_object(
      'vehicle_id', v_window.vehicle_id,
      'vehicle_event_id', v_event_id,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.maintenance_completed',
    'vehicle_maintenance_window',
    v_window_id,
    'rpc_dispatch',
    'completed',
    'complete_maintenance_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_id', v_window.vehicle_id,
      'vehicle_event_id', v_event_id,
      'fleet_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_notes
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_maintenance_window_id', v_window_id,
    'vehicle_id', v_window.vehicle_id,
    'vehicle_event_id', v_event_id,
    'status', 'completed',
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_maintenance_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_maintenance_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_maintenance_v1(JSONB)
  IS 'Canonical RPC: close a scheduled vehicle_maintenance_windows row (status=completed) and append vehicle_events maintenance row. Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280035_complete_maintenance_v1'));
COMMIT;

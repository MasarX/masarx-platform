-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: mark_vehicle_oos_v1 — take a vehicle Out-of-Service with a reason
-- Date: 2026-04-28
--
-- Notes:
--   - Adds 'oos' to lookup vehicle_status (additive, non-breaking).
--   - Adds 'oos_marked' to lookup vehicle_event_type (audit ledger event keyword).
--   - Sets public.vehicles.status='oos' and appends a vehicle_events row.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280020_mark_vehicle_oos_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Additive lookup seeds (idempotent)
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('oos', 'Out of Service', 'Vehicle marked out of service (manual or policy-driven)', 25, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('oos_marked', 'Marked Out of Service', 'Vehicle marked OOS via mark_vehicle_oos_v1', 50, FALSE, '{}'),
  ('oos_restored', 'Restored from Out of Service', 'Vehicle restored to service via restore_vehicle_v1', 60, FALSE, '{}'),
  ('inspection', 'Inspection', 'Inspection event', 70, FALSE, '{}'),
  ('repair', 'Repair', 'Repair event', 80, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_event_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mark_vehicle_oos_v1(p_args JSONB)
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
  v_reason TEXT;
  v_metadata JSONB;

  v_vehicle public.vehicles%ROWTYPE;
  v_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
  v_closed_assignment_count INT := 0;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'mark_vehicle_oos_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'mark_vehicle_oos_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_vehicle_id := NULLIF(p_args->>'vehicle_id', '')::UUID;
  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'mark_vehicle_oos_v1: vehicle_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'mark_vehicle_oos_v1: reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_vehicle
    FROM public.vehicles
   WHERE id = v_vehicle_id
   FOR UPDATE;

  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'mark_vehicle_oos_v1: vehicle % not found', v_vehicle_id USING ERRCODE = 'P0002';
  END IF;
  IF v_vehicle.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'mark_vehicle_oos_v1: vehicle % belongs to another organization', v_vehicle_id USING ERRCODE = '42501';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('fleet_policy', 'tenant', v_org_id);

  -- Set status='oos' (idempotent; only update if not already oos)
  UPDATE public.vehicles
     SET status = 'oos',
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'oos_marked_at', now(),
                         'oos_reason', v_reason,
                         'oos_correlation_id', v_correlation_id
                       ),
         updated_at = now()
   WHERE id = v_vehicle_id;

  -- Close any active assignments (vehicle is OOS — driver should be released)
  WITH closed AS (
    UPDATE public.vehicle_assignments
       SET status = 'ended',
           ended_at = now(),
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           'closed_by', 'mark_vehicle_oos_v1',
                           'closed_correlation_id', v_correlation_id,
                           'closed_reason', 'vehicle_oos'
                         )
     WHERE vehicle_id = v_vehicle_id
       AND organization_id = v_org_id
       AND status = 'active'
       AND ended_at IS NULL
    RETURNING id
  )
  SELECT COUNT(*)::INT INTO v_closed_assignment_count FROM closed;

  -- Append vehicle_events ledger row
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
    'oos_marked',
    now(),
    auth.uid(),
    'mark_vehicle_oos_v1',
    v_reason,
    v_metadata
      || jsonb_build_object(
           'previous_status', v_vehicle.status,
           'closed_assignment_count', v_closed_assignment_count,
           'correlation_id', v_correlation_id,
           'fleet_policy_resolution', COALESCE(v_resolved_settings, '{}'::jsonb)
         )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.vehicle_oos_marked',
    'vehicle',
    v_vehicle_id,
    jsonb_build_object(
      'vehicle_event_id', v_event_id,
      'reason', v_reason,
      'previous_status', v_vehicle.status,
      'closed_assignment_count', v_closed_assignment_count,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.vehicle_oos_marked',
    'vehicle',
    v_vehicle_id,
    'rpc_dispatch',
    'oos',
    'mark_vehicle_oos_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_event_id', v_event_id,
      'previous_status', v_vehicle.status,
      'closed_assignment_count', v_closed_assignment_count,
      'fleet_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_id', v_vehicle_id,
    'vehicle_event_id', v_event_id,
    'previous_status', v_vehicle.status,
    'closed_assignment_count', v_closed_assignment_count,
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_vehicle_oos_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_vehicle_oos_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.mark_vehicle_oos_v1(JSONB)
  IS 'Canonical RPC: set vehicles.status=oos with a required reason. Closes any active assignments and appends a vehicle_events ledger row. Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280020_mark_vehicle_oos_v1'));
COMMIT;

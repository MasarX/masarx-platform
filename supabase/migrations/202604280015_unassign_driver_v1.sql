-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: unassign_driver_v1 — close active driver↔vehicle binding
-- Date: 2026-04-28
--
-- Contract:
--   - Capability gate: fleet.write
--   - Closes the active vehicle_assignments row for the (vehicle_id) (and optionally the specific assignment_id)
--   - Idempotent: returns ok=TRUE with closed_count=0 when no active row exists
--   - Emits domain_events + decision_log; canonical envelope return shape

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280015_unassign_driver_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.unassign_driver_v1(p_args JSONB)
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
  v_assignment_id UUID;
  v_reason TEXT;

  v_vehicle public.vehicles%ROWTYPE;
  v_closed_ids UUID[];
  v_closed_count INT := 0;
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'unassign_driver_v1: p_args must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'unassign_driver_v1: authenticated tenant user required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_vehicle_id := NULLIF(p_args->>'vehicle_id', '')::UUID;
  v_assignment_id := NULLIF(p_args->>'vehicle_assignment_id', '')::UUID;
  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');

  IF v_vehicle_id IS NULL AND v_assignment_id IS NULL THEN
    RAISE EXCEPTION 'unassign_driver_v1: vehicle_id or vehicle_assignment_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- If a specific assignment id is provided, validate scope; else look up via vehicle
  IF v_assignment_id IS NOT NULL THEN
    PERFORM 1
       FROM public.vehicle_assignments
      WHERE id = v_assignment_id
        AND organization_id = v_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unassign_driver_v1: vehicle_assignment % not found in organization %', v_assignment_id, v_org_id
        USING ERRCODE = 'P0002';
    END IF;
  ELSE
    SELECT *
      INTO v_vehicle
      FROM public.vehicles
     WHERE id = v_vehicle_id
       AND organization_id = v_org_id
     FOR UPDATE;
    IF v_vehicle.id IS NULL THEN
      RAISE EXCEPTION 'unassign_driver_v1: vehicle % not found in organization %', v_vehicle_id, v_org_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  v_resolved_settings := public.resolve_settings_merged('fleet_policy', 'tenant', v_org_id);

  -- Close matching active rows
  IF v_assignment_id IS NOT NULL THEN
    UPDATE public.vehicle_assignments
       SET status = 'ended',
           ended_at = now(),
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           'closed_by', 'unassign_driver_v1',
                           'closed_correlation_id', v_correlation_id,
                           'closed_reason', COALESCE(v_reason, 'manual_unassign')
                         )
     WHERE id = v_assignment_id
       AND organization_id = v_org_id
       AND status = 'active'
       AND ended_at IS NULL
    RETURNING id INTO v_closed_ids;
  ELSE
    WITH closed AS (
      UPDATE public.vehicle_assignments
         SET status = 'ended',
             ended_at = now(),
             updated_at = now(),
             metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object(
                             'closed_by', 'unassign_driver_v1',
                             'closed_correlation_id', v_correlation_id,
                             'closed_reason', COALESCE(v_reason, 'manual_unassign')
                           )
       WHERE vehicle_id = v_vehicle_id
         AND organization_id = v_org_id
         AND status = 'active'
         AND ended_at IS NULL
      RETURNING id
    )
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_closed_ids FROM closed;
  END IF;

  v_closed_count := COALESCE(array_length(v_closed_ids, 1), 0);

  -- Audit even when nothing to close (idempotent)
  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.driver_unassigned',
    'vehicle_assignment',
    CASE WHEN v_closed_count > 0 THEN v_closed_ids[1] ELSE COALESCE(v_assignment_id, v_vehicle_id) END,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'vehicle_assignment_id', v_assignment_id,
      'closed_ids', to_jsonb(COALESCE(v_closed_ids, ARRAY[]::UUID[])),
      'closed_count', v_closed_count,
      'reason', v_reason,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.driver_unassigned',
    'vehicle_assignment',
    CASE WHEN v_closed_count > 0 THEN v_closed_ids[1] ELSE COALESCE(v_assignment_id, v_vehicle_id) END,
    'rpc_dispatch',
    CASE WHEN v_closed_count > 0 THEN 'closed' ELSE 'noop' END,
    'unassign_driver_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'vehicle_assignment_id', v_assignment_id,
      'closed_ids', to_jsonb(COALESCE(v_closed_ids, ARRAY[]::UUID[])),
      'closed_count', v_closed_count,
      'fleet_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_id', v_vehicle_id,
    'vehicle_assignment_id', v_assignment_id,
    'closed_count', v_closed_count,
    'closed_ids', to_jsonb(COALESCE(v_closed_ids, ARRAY[]::UUID[])),
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.unassign_driver_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unassign_driver_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.unassign_driver_v1(JSONB)
  IS 'Canonical RPC: close any active vehicle_assignments rows for a vehicle (or a specific assignment row). Idempotent. Capability-gated (fleet.write); emits domain_events + decision_log.';

SELECT pg_advisory_unlock(hashtext('202604280015_unassign_driver_v1'));
COMMIT;

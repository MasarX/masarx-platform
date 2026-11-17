-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Fix reserve_delivery_slot_v1 idempotency (repeat reserve)
-- Purpose:
--   - Prevent repeat reservations of the same slot from updating shipments/version and emitting
--     duplicate shipment_actions (delivery_slot_reserved).
--   - Avoid churn caused by re-logging settings provenance on no-op reservations.
-- Date: 2026-01-30

BEGIN;

CREATE OR REPLACE FUNCTION public.reserve_delivery_slot_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID;
  v_client_id UUID;
  v_slot_date DATE;
  v_branch_id UUID;

  v_performed_by_system TEXT := NULL;
  v_slot RECORD;
  v_current RECORD;
  v_slot_branch_id UUID := NULL;

  v_settings_resolution_id UUID := NULL;
  v_policy_settings_id UUID := NULL;
  v_policy_settings_version_id UUID := NULL;
  v_policy_scope_type TEXT := NULL;
  v_policy_scope_id UUID := NULL;
  v_policy_version INT := NULL;
  v_policy_scope_path JSONB := NULL;

  v_apply RECORD;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'reserve_delivery_slot_v1: input must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_slot_date := NULLIF(v_input->>'slot_date', '')::DATE; EXCEPTION WHEN others THEN v_slot_date := NULL; END;
  v_performed_by_system := NULLIF(v_input->>'performed_by_system', '');

  IF v_shipment_id IS NULL OR v_client_id IS NULL OR v_slot_date IS NULL THEN
    RAISE EXCEPTION 'reserve_delivery_slot_v1: shipment_id, client_id, slot_date are required'
      USING ERRCODE = '22023';
  END IF;

  -- Determine branch_id for lock scope (shipment.branch_id or derived from zone).
  SELECT COALESCE(s.branch_id, public.resolve_branch_id_for_zone(s.zone_id))
    INTO v_branch_id
    FROM public.shipments s
   WHERE s.id = v_shipment_id
     AND s.client_id = v_client_id
   LIMIT 1;

  IF v_branch_id IS NULL THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'reserved', FALSE,
      'reason', 'branch_unmapped',
      'shipment_id', v_shipment_id,
      'client_id', v_client_id
    ));
  END IF;

  -- Serialize reservations per (branch_id, slot_date) to avoid overselling capacity.
  PERFORM pg_advisory_xact_lock(hashtext('slot_reserve:' || v_branch_id::text || ':' || v_slot_date::text));

  -- Recompute availability inside the lock (authoritative decision).
  SELECT *
    INTO v_slot
    FROM public.compute_delivery_slot_v1(v_input)
   LIMIT 1;

  IF v_slot.is_available IS DISTINCT FROM TRUE THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'reserved', FALSE,
      'reason', COALESCE(v_slot.reason, 'unavailable'),
      'shipment_id', v_shipment_id,
      'client_id', v_client_id,
      'slot', to_jsonb(v_slot)
    ));
  END IF;

  -- Idempotency: if the shipment is already reserved to this exact slot window, return no-op.
  SELECT
    s.branch_id,
    s.promised_delivery_date,
    s.promised_delivery_at,
    s.promised_window_start_at,
    s.promised_window_end_at,
    s.promise_settings_resolution_id
  INTO v_current
  FROM public.shipments s
  WHERE s.id = v_shipment_id
    AND s.client_id = v_client_id
  LIMIT 1;

  BEGIN v_slot_branch_id := NULLIF(v_slot.debug->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_slot_branch_id := NULL; END;

  IF FOUND
     AND v_current.branch_id IS NOT DISTINCT FROM v_slot_branch_id
     AND v_current.promised_delivery_date IS NOT DISTINCT FROM v_slot.slot_date
     AND v_current.promised_delivery_at IS NOT DISTINCT FROM v_slot.slot_end_at
     AND v_current.promised_window_start_at IS NOT DISTINCT FROM v_slot.slot_start_at
     AND v_current.promised_window_end_at IS NOT DISTINCT FROM v_slot.slot_end_at THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'reserved', TRUE,
      'updated', FALSE,
      'reason', 'no_change',
      'shipment_id', v_shipment_id,
      'client_id', v_client_id,
      'settings_resolution_id', v_current.promise_settings_resolution_id,
      'slot', to_jsonb(v_slot)
    ));
  END IF;

  -- Extract policy provenance for logging when available.
  BEGIN v_policy_settings_id := NULLIF(v_slot.debug->>'policy_settings_id', '')::UUID; EXCEPTION WHEN others THEN v_policy_settings_id := NULL; END;
  BEGIN v_policy_settings_version_id := NULLIF(v_slot.debug->>'policy_settings_version_id', '')::UUID; EXCEPTION WHEN others THEN v_policy_settings_version_id := NULL; END;
  v_policy_scope_type := NULLIF(v_slot.debug->>'policy_scope_type', '');
  BEGIN v_policy_scope_id := NULLIF(v_slot.debug->>'policy_scope_id', '')::UUID; EXCEPTION WHEN others THEN v_policy_scope_id := NULL; END;
  BEGIN v_policy_version := NULLIF(v_slot.debug->>'policy_version', '')::INT; EXCEPTION WHEN others THEN v_policy_version := NULL; END;
  v_policy_scope_path := v_slot.debug->'policy_scope_path';

  IF v_policy_settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := NULLIF(v_slot.debug->>'organization_id', '')::UUID,
      p_category := 'shipment_promise_policy',
      p_winning_scope_type := COALESCE(v_policy_scope_type, 'global'),
      p_winning_scope_id := v_policy_scope_id,
      p_winning_settings_id := v_policy_settings_id,
      p_winning_settings_version_id := v_policy_settings_version_id,
      p_winning_version := COALESCE(v_policy_version, 1),
      p_scope_path := COALESCE(v_policy_scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_shipment_id,
        'shipment_client_id', v_client_id,
        'slot_date', v_slot.slot_date,
        'slot_start_at', v_slot.slot_start_at,
        'slot_end_at', v_slot.slot_end_at,
        'slot_debug', v_slot.debug
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Persist chosen slot as the shipment promise (force date overwrite).
  SELECT *
    INTO v_apply
    FROM public.apply_shipment_promise_v1(
      p_shipment_id := v_shipment_id,
      p_client_id := v_client_id,
      p_branch_id := NULLIF(v_slot.debug->>'branch_id', '')::UUID,
      p_promised_delivery_date := v_slot.slot_date,
      p_promised_delivery_at := v_slot.slot_end_at,
      p_promised_window_start_at := v_slot.slot_start_at,
      p_promised_window_end_at := v_slot.slot_end_at,
      p_promise_computed_at := public.workflow_now(),
      p_promise_settings_resolution_id := v_settings_resolution_id,
      p_set_promised_delivery_date_mode := 'force',
      p_action_type := 'delivery_slot_reserved',
      p_action_category := 'operational',
      p_action_data := jsonb_strip_nulls(jsonb_build_object(
        'slot_date', v_slot.slot_date,
        'slot_start_at', v_slot.slot_start_at,
        'slot_end_at', v_slot.slot_end_at,
        'capacity_window_id', v_slot.capacity_window_id,
        'settings_resolution_id', v_settings_resolution_id
      )),
      p_performed_by_system := COALESCE(v_performed_by_system, 'workflow_engine')
    )
   LIMIT 1;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'reserved', TRUE,
    'updated', COALESCE(v_apply.updated, FALSE),
    'reason', CASE WHEN COALESCE(v_apply.updated, FALSE) THEN NULL ELSE 'no_change' END,
    'shipment_id', v_shipment_id,
    'client_id', v_client_id,
    'action_id', v_apply.action_id,
    'settings_resolution_id', v_settings_resolution_id,
    'slot', to_jsonb(v_slot)
  ));
END;
$function$;

COMMIT;


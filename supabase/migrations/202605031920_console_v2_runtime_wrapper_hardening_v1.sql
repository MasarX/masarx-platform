-- Console V2 runtime wrapper hardening.
--
-- The canonical public helpers below are security-definer workflow/runtime
-- helpers. Browser calls must enter through api.* with explicit resource
-- visibility and capability checks before delegation.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031920_console_v2_runtime_wrapper_hardening_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.list_delivery_slots_v1(
  p_input JSONB
)
RETURNS TABLE (
  slot_date DATE,
  window_start_local TEXT,
  window_end_local TEXT,
  slot_start_at TIMESTAMPTZ,
  slot_end_at TIMESTAMPTZ,
  timezone TEXT,
  is_available BOOLEAN,
  reason TEXT,
  is_blackout BOOLEAN,
  calendar_event_id UUID,
  capacity_window_id UUID,
  capacity_limit NUMERIC,
  capacity_used NUMERIC,
  capacity_remaining NUMERIC,
  debug JSONB
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'list_delivery_slots_v1 expects JSON object input'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID;
  EXCEPTION WHEN others THEN
    v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'list_delivery_slots_v1 requires shipment_id'
      USING ERRCODE = '22023';
  END IF;

  IF public.ui_get_resource_v1('shipments', v_shipment_id) IS NULL THEN
    RAISE EXCEPTION 'list_delivery_slots_v1 shipment % is not visible', v_shipment_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT *
    FROM public.list_delivery_slots_v1(v_input);
END;
$function$;

CREATE OR REPLACE FUNCTION api.reserve_delivery_slot_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'reserve_delivery_slot_v1 expects JSON object input'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID;
  EXCEPTION WHEN others THEN
    v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'reserve_delivery_slot_v1 requires shipment_id'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_capability_v1(
    'shipments.write',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );

  IF public.ui_get_resource_v1('shipments', v_shipment_id) IS NULL THEN
    RAISE EXCEPTION 'reserve_delivery_slot_v1 shipment % is not visible', v_shipment_id
      USING ERRCODE = '42501';
  END IF;

  RETURN public.reserve_delivery_slot_v1(v_input);
END;
$function$;

CREATE OR REPLACE FUNCTION api.route_run_scan_out_reconciliation_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
BEGIN
  IF p_route_run_id IS NULL THEN
    RAISE EXCEPTION 'route_run_scan_out_reconciliation_v1 requires route_run_id'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_capability_v1(
    'routes.read',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );

  IF public.ui_get_resource_v1('route_runs', p_route_run_id) IS NULL THEN
    RAISE EXCEPTION 'route_run_scan_out_reconciliation_v1 route_run % is not visible', p_route_run_id
      USING ERRCODE = '42501';
  END IF;

  RETURN public.route_run_scan_out_reconciliation_v1(p_route_run_id);
END;
$function$;

REVOKE ALL ON FUNCTION api.list_delivery_slots_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.list_delivery_slots_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.list_delivery_slots_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.reserve_delivery_slot_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.reserve_delivery_slot_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.reserve_delivery_slot_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION api.list_delivery_slots_v1(JSONB) IS
  'Console V2 browser-safe delivery-slot listing wrapper. Verifies shipment visibility before delegating to the canonical public helper.';
COMMENT ON FUNCTION api.reserve_delivery_slot_v1(JSONB) IS
  'Console V2 browser-safe delivery-slot reservation wrapper. Requires shipments.write and visible shipment scope before delegating.';
COMMENT ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) IS
  'Console V2 browser-safe route scan-out reconciliation wrapper. Requires routes.read and visible route run scope before delegating.';

SELECT pg_advisory_unlock(hashtext('202605031920_console_v2_runtime_wrapper_hardening_v1'));

COMMIT;

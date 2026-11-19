-- Plan: Console V2 live backend substrate closure
-- Step: expose browser-safe api-schema wrappers for Console V2 operational RPCs.
--
-- The Console V2 Supabase client resolves browser RPCs through the api schema.
-- Older canonical functions below already exist in public, but several did
-- not have api wrappers, leaving the frontend adapter unable to call them in
-- shared/prod lanes without falling back to demo mode.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031200_console_v2_live_substrate_api_wrappers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.progress_workflow_run(
  p_workflow_run_id UUID,
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
  SELECT public.progress_workflow_run($1, COALESCE($2, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.close_workflow_run(
  p_workflow_run_id UUID,
  p_status TEXT
)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.close_workflow_run($1, $2);
$function$;

CREATE OR REPLACE FUNCTION api.route_plan_validate_constraints_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
BEGIN
  IF public.ui_get_resource_v1('route_plans', p_route_plan_id) IS NULL THEN
    RAISE EXCEPTION 'route_plan_validate_constraints_v1 route_plan % not visible', p_route_plan_id
      USING ERRCODE = '42501';
  END IF;

  RETURN public.route_plan_validate_constraints_v1(p_route_plan_id);
END;
$function$;

CREATE OR REPLACE FUNCTION api.route_run_scan_out_reconciliation_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.route_run_scan_out_reconciliation_v1($1);
$function$;

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
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.list_delivery_slots_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.reserve_delivery_slot_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.reserve_delivery_slot_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.request_label_reprint(
  p_label_id UUID,
  p_reprint_reason TEXT,
  p_actor_id UUID DEFAULT NULL::uuid,
  p_requested_source TEXT DEFAULT 'console-v2'::text
)
RETURNS UUID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.request_label_reprint(
    p_label_id := $1,
    p_reprint_reason := $2,
    p_actor_id := COALESCE($3, auth.uid()),
    p_requested_source := COALESCE(NULLIF($4, ''), 'console-v2')
  );
$function$;

REVOKE ALL ON FUNCTION api.progress_workflow_run(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.progress_workflow_run(UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.progress_workflow_run(UUID, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.close_workflow_run(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.close_workflow_run(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.close_workflow_run(UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.route_plan_validate_constraints_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.route_plan_validate_constraints_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.route_plan_validate_constraints_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.list_delivery_slots_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.list_delivery_slots_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.list_delivery_slots_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.reserve_delivery_slot_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.reserve_delivery_slot_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.reserve_delivery_slot_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.request_label_reprint(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_reprint(UUID, TEXT, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.request_label_reprint(UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION api.progress_workflow_run(UUID, JSONB)
  IS 'API-schema browser wrapper for the canonical workflow-engine progress entrypoint.';
COMMENT ON FUNCTION api.close_workflow_run(UUID, TEXT)
  IS 'API-schema browser wrapper for canonical workflow closeout.';
COMMENT ON FUNCTION api.route_plan_validate_constraints_v1(UUID)
  IS 'API-schema browser wrapper for route-plan constraint validation.';
COMMENT ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID)
  IS 'API-schema browser wrapper for route-run scan-out reconciliation.';
COMMENT ON FUNCTION api.list_delivery_slots_v1(JSONB)
  IS 'API-schema browser wrapper for delivery-slot listing.';
COMMENT ON FUNCTION api.reserve_delivery_slot_v1(JSONB)
  IS 'API-schema browser wrapper for delivery-slot reservation.';
COMMENT ON FUNCTION api.request_label_reprint(UUID, TEXT, UUID, TEXT)
  IS 'API-schema browser wrapper for label reprint requests with operator reason.';

SELECT pg_advisory_unlock(hashtext('202605031200_console_v2_live_substrate_api_wrappers_v1'));

COMMIT;

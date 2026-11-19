-- Migration: Shipment UC23 route-stop finalize definer repair
-- Purpose:
-- - Keep dispatch stop closeout workflow-engine-first under the active
--   route_stop_finalize handler.
-- - Let the active v11 wrapper execute the existing v10/v9/v8/v3 policy path
--   with the owner privileges required to update shipments and create
--   dispatch_exception_review follow-up tasks.
-- - Avoid widening table grants or adding test-only behavior.

BEGIN;
SELECT pg_advisory_lock(hashtext('202607052030_shipment_uc23_route_stop_finalize_definer_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION workflow_handlers.execute_route_stop_finalize_v11(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) SECURITY DEFINER;

ALTER FUNCTION workflow_handlers.execute_route_stop_finalize_v11(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) SET search_path = public, workflow_handlers, extensions, pg_temp;

REVOKE EXECUTE ON FUNCTION workflow_handlers.execute_route_stop_finalize_v11(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION workflow_handlers.execute_route_stop_finalize_v11(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) TO service_role;

COMMENT ON FUNCTION workflow_handlers.execute_route_stop_finalize_v11(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Active route-stop finalizer wrapper for Shipment UC18/UC23. Runs as SECURITY DEFINER so service-role workflow execution can apply dispatch_stop_policy shipment status and canonical dispatch_exception_review follow-up effects without broad table grants.';

SELECT pg_advisory_unlock(hashtext('202607052030_shipment_uc23_route_stop_finalize_definer_v1'));
COMMIT;

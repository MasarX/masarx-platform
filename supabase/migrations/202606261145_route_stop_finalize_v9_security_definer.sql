-- Migration: Route-stop finalizer service-role execution hardening
-- Purpose:
-- - Keep the active route-stop finalizer executable by the workflow engine
--   without granting service_role broad direct access to shipment tables.
-- - Pin the SECURITY DEFINER search_path and keep the handler internal-only.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606261145_route_stop_finalize_v9_security_definer'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION workflow_handlers.execute_route_stop_finalize_v9(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) SECURITY DEFINER;

ALTER FUNCTION workflow_handlers.execute_route_stop_finalize_v9(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) SET search_path TO public, workflow_handlers, extensions, pg_temp;

REVOKE ALL ON FUNCTION workflow_handlers.execute_route_stop_finalize_v9(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) FROM PUBLIC;

REVOKE ALL ON FUNCTION workflow_handlers.execute_route_stop_finalize_v9(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) FROM anon;

REVOKE ALL ON FUNCTION workflow_handlers.execute_route_stop_finalize_v9(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) FROM authenticated;

GRANT EXECUTE ON FUNCTION workflow_handlers.execute_route_stop_finalize_v9(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) TO service_role;

SELECT pg_advisory_unlock(hashtext('202606261145_route_stop_finalize_v9_security_definer'));

COMMIT;

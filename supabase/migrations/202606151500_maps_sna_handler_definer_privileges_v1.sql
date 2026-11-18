-- Migration: Maps/SNA workflow handler privilege lockdown
-- Purpose:
--   Keep internal SECURITY DEFINER workflow handlers off direct app/user RPC
--   surfaces while preserving service-role workflow-engine access.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202606151500_maps_sna_handler_definer_privileges_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION workflow_handlers.execute_shipment_create_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_shipment_create_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) TO service_role;

REVOKE EXECUTE ON FUNCTION workflow_handlers.execute_shipment_update_address_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_shipment_update_address_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) TO service_role;

REVOKE EXECUTE ON FUNCTION workflow_handlers.execute_address_intake_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_address_intake_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) TO service_role;

COMMIT;

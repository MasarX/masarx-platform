-- Migration: wait_for_shipment search_path pin
-- Purpose:
--   - Restore SECURITY DEFINER search_path for execute_wait_for_shipment_v1 after redefinition.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-16
BEGIN;
ALTER FUNCTION workflow_handlers.execute_wait_for_shipment_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) SET search_path TO public, workflow_handlers, extensions, pg_temp;
COMMIT;

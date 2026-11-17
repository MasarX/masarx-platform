-- Migration: restore search_path on wait_for_shipment handler after redefine
-- Purpose:
--   - Ensure SECURITY DEFINER function pins search_path to public + extensions.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-16
BEGIN;

ALTER FUNCTION workflow_handlers.execute_wait_for_shipment_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) SET search_path = public, workflow_handlers, extensions, pg_temp;

COMMIT;

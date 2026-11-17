-- Migration: Wait-for-shipment handler search_path pin
-- Purpose:
--   - Ensure SECURITY DEFINER handler uses a pinned search_path (secdef guard).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Plan: PLAN-202601-pgtap-outbound-worker-pending-edge / Step: S02
-- Date: 2026-01-12
BEGIN;

ALTER FUNCTION workflow_handlers.execute_wait_for_shipment_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMIT;

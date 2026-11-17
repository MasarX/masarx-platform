-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Migration: Reconcile workflow_handlers.record_shipment_action_v1 signature overlap
-- Purpose:
--   - Remove the legacy 8-argument overload that now conflicts with the canonical
--     timestamp-capable 9-argument version.
--   - Keep shipment action recording deterministic for public tracking and other
--     workflow handlers that call the function with 8 arguments.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603131240_workflow_handlers_record_shipment_action_signature_reconcile_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP FUNCTION IF EXISTS workflow_handlers.record_shipment_action_v1(
  UUID,
  TEXT,
  TEXT,
  JSONB,
  TEXT,
  TEXT,
  TEXT,
  UUID
);

SELECT pg_advisory_unlock(hashtext('202603131240_workflow_handlers_record_shipment_action_signature_reconcile_v1'));
COMMIT;

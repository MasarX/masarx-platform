-- Plan: PLAN-202603-runtime-deploy-health-mainline-convergence / Step: S06
-- Remove the obsolete 8-argument shipment action overload so defaulted calls
-- resolve to the canonical timestamp-capable signature without ambiguity.

BEGIN;

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

COMMIT;

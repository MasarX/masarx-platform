-- Migration: Shipment UC23 task completion effects definer repair
-- Purpose:
-- - Preserve task_completion_effects_policy as the row-driven source of truth
--   for follow-up task completion effects.
-- - Let the canonical task_completion_effects workflow handler update shipment
--   status/actions under owner privileges during service-role workflow execution.
-- - Avoid widening table grants or adding test-only behavior.

BEGIN;
SELECT pg_advisory_lock(hashtext('202607052045_shipment_uc23_task_completion_effects_definer_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) SECURITY DEFINER;

ALTER FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) SET search_path = public, workflow_handlers, extensions, pg_temp;

REVOKE EXECUTE ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) TO service_role;

COMMENT ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Canonical task completion effects handler. Runs as SECURITY DEFINER so service-role workflow execution can apply task_completion_effects_policy shipment status/actions without broad table grants.';

SELECT pg_advisory_unlock(hashtext('202607052045_shipment_uc23_task_completion_effects_definer_v1'));
COMMIT;

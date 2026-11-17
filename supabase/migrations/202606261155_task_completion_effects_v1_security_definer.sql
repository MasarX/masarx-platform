-- Migration: harden task_completion_effects_v1 workflow handler privileges
-- Purpose:
--   The workflow engine executes task_completion_effects_v1 as service_role, but
--   the handler applies internal shipment effects that require owner privileges.
--   Keep the service_role execution surface narrow by marking the handler
--   SECURITY DEFINER instead of granting broad table access to service_role.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606261155_task_completion_effects_v1_security_definer'));

ALTER FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) SECURITY DEFINER;

ALTER FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) SET search_path TO public, workflow_handlers, extensions, pg_temp;

REVOKE ALL ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) FROM PUBLIC;

REVOKE ALL ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) FROM anon;

REVOKE ALL ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) FROM authenticated;

GRANT EXECUTE ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) TO service_role;

SELECT pg_advisory_unlock(hashtext('202606261155_task_completion_effects_v1_security_definer'));

COMMIT;

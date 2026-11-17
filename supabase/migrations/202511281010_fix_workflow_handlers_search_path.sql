-- Migration: Re-pin search_path for workflow_handlers SECDEF functions
-- Purpose:
--   Ensure SECURITY DEFINER handlers in workflow_handlers set an explicit
--   search_path starting with public to satisfy 027_secdef_search_path.sql
--   and guard against future CREATE OR REPLACE definitions resetting it.

BEGIN;

DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER FUNCTION workflow_handlers.render_http_response_v1(workflow_run_steps, workflow_runs, jsonb) SET search_path TO public, pg_temp';
  EXCEPTION
    WHEN undefined_function THEN
      RAISE NOTICE 'render_http_response_v1 not present; skipping search_path pin';
  END;

  BEGIN
    EXECUTE 'ALTER FUNCTION workflow_handlers.dispatch_followup_workflow_v1(workflow_run_steps, workflow_runs, jsonb) SET search_path TO public, pg_temp';
  EXCEPTION
    WHEN undefined_function THEN
      RAISE NOTICE 'dispatch_followup_workflow_v1 not present; skipping search_path pin';
  END;
END;
$$;

COMMIT;


-- Migration: Pin search_path for SECURITY DEFINER functions in workflow_handlers
-- Purpose: Ensure all SECDEF functions have an explicit, safe search_path (engine-first security posture)
-- Date: 2025-10-29

BEGIN;

-- Allow either schema-first or public-first; we standardize on public,pg_temp for simplicity
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER FUNCTION workflow_handlers.dispatch_followup_workflow_v1(workflow_run_steps, workflow_runs, jsonb) SET search_path = public, pg_temp';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'dispatch_followup_workflow_v1 not present; skipping search_path pin';
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER FUNCTION workflow_handlers.render_http_response_v1(workflow_run_steps, workflow_runs, jsonb) SET search_path = public, pg_temp';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'render_http_response_v1 not present; skipping search_path pin';
  END;
END;
$$;

COMMIT;

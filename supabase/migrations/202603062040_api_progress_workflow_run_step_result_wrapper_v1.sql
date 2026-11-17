-- Migration: api wrapper for progress_workflow_run_step_result_v1
-- Purpose:
--  - Expose the generic external step-result progression helper through the api schema.
--  - Keep edge/PostgREST clients on the canonical api schema while reusing the public SSOT helper.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.progress_workflow_run_step_result_v1(
  p_workflow_run_id UUID,
  p_workflow_run_step_id UUID,
  p_operation_result JSONB DEFAULT '{}'::jsonb,
  p_budget_ms INTEGER DEFAULT NULL,
  p_max_steps INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.progress_workflow_run_step_result_v1(
    p_workflow_run_id,
    p_workflow_run_step_id,
    p_operation_result,
    p_budget_ms,
    p_max_steps
  );
$function$;

COMMENT ON FUNCTION api.progress_workflow_run_step_result_v1(UUID, UUID, JSONB, INTEGER, INTEGER)
  IS 'API schema wrapper for the generic workflow external step-result progression helper.';

REVOKE ALL ON FUNCTION api.progress_workflow_run_step_result_v1(UUID, UUID, JSONB, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.progress_workflow_run_step_result_v1(UUID, UUID, JSONB, INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION api.progress_workflow_run_step_result_v1(UUID, UUID, JSONB, INTEGER, INTEGER) FROM authenticated;

GRANT USAGE ON SCHEMA api TO service_role;
GRANT EXECUTE ON FUNCTION api.progress_workflow_run_step_result_v1(UUID, UUID, JSONB, INTEGER, INTEGER)
  TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.progress_workflow_run_step_result_v1(UUID, UUID, JSONB, INTEGER, INTEGER)
      TO label_renderer_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.progress_workflow_run_step_result_v1(UUID, UUID, JSONB, INTEGER, INTEGER)
      TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

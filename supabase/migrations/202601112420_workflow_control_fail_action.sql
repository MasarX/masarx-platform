-- Migration: Support workflow_control fail action
-- Purpose:
--   - Allow workflow_control handler to explicitly fail workflows (used by provider_error step).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_workflow_control_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_action TEXT := lower(COALESCE(NULLIF(v_metadata->>'action', ''), 'complete'));
  v_reason TEXT := NULL;
  v_response public.workflow_handler_response;
BEGIN
  IF v_action = 'complete' THEN
    v_response.status := 'completed';
    v_response.workflow_status := 'completed';
    v_response.operation_result := jsonb_build_object('status', 'completed');
    RETURN v_response;
  END IF;

  IF v_action = 'fail' THEN
    v_reason := COALESCE(
      NULLIF(v_metadata->>'reason', ''),
      NULLIF(v_metadata->>'status', ''),
      'workflow_control_failed'
    );
    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_response.last_error := v_reason;
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'failed',
      'reason', v_reason
    ));
    RETURN v_response;
  END IF;

  RAISE EXCEPTION 'execute_workflow_control_v1: unsupported action %', v_action;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_workflow_control_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Workflow control handler (complete or fail) with explicit workflow status override.';

COMMIT;

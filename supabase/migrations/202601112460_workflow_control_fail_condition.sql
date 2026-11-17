-- Migration: Workflow control conditional fail gating
-- Purpose:
--   - Allow workflow_control fail actions to be conditional on context flags.
--   - Keep geocoding provider_error from failing successful runs.
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
  v_fail_when TEXT := lower(COALESCE(NULLIF(v_metadata->>'fail_when', ''), 'always'));
  v_context_path TEXT := NULLIF(v_metadata->>'context_path', '');
  v_context_value TEXT;
  v_context_truthy BOOLEAN := NULL;
  v_response public.workflow_handler_response;
BEGIN
  IF v_action = 'complete' THEN
    v_response.status := 'completed';
    v_response.workflow_status := 'completed';
    v_response.operation_result := jsonb_build_object('status', 'completed');
    RETURN v_response;
  END IF;

  IF v_action = 'fail' THEN
    IF v_fail_when <> 'always' THEN
      IF v_context_path IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
          'status', 'skipped',
          'reason', 'fail_condition_missing'
        );
        RETURN v_response;
      END IF;

      v_context_value := NULLIF(p_run.context #>> string_to_array(v_context_path, '.'), '');
      IF v_context_value IS NULL THEN
        v_context_truthy := FALSE;
      ELSIF lower(v_context_value) IN ('true', '1', 'yes') THEN
        v_context_truthy := TRUE;
      ELSIF lower(v_context_value) IN ('false', '0', 'no') THEN
        v_context_truthy := FALSE;
      ELSE
        v_context_truthy := TRUE;
      END IF;

      IF v_fail_when = 'context_truthy' AND v_context_truthy IS DISTINCT FROM TRUE THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
          'status', 'skipped',
          'reason', 'fail_condition_not_met'
        );
        RETURN v_response;
      END IF;

      IF v_fail_when = 'context_falsey' AND v_context_truthy IS TRUE THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
          'status', 'skipped',
          'reason', 'fail_condition_not_met'
        );
        RETURN v_response;
      END IF;
    END IF;

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
  IS 'Workflow control handler (complete or fail) with conditional fail gating.';

UPDATE public.workflow_template_steps
SET metadata = jsonb_strip_nulls(
  COALESCE(metadata, '{}'::jsonb) ||
  jsonb_build_object(
    'fail_when', 'context_truthy',
    'context_path', 'geocoding.fail_fast'
  )
)
WHERE operation_name = 'provider_error'
  AND handler_key = 'workflow_control';

COMMIT;

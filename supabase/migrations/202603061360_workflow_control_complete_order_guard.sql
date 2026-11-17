-- Migration: workflow control complete-order guard
-- Purpose:
--  - Prevent terminal workflow_control steps from completing a run while earlier steps are still pending.
--  - Fail-closed if an earlier step has already failed.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061360_workflow_control_complete_order_guard'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_workflow_control_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result jsonb DEFAULT '{}'::jsonb
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
  v_prior_failed_count INT := 0;
  v_prior_incomplete_count INT := 0;
  v_prior_next_run_at TIMESTAMPTZ := NULL;
BEGIN
  IF v_action = 'complete' THEN
    SELECT
      COUNT(*) FILTER (WHERE step_status = 'failed')::INT,
      COUNT(*) FILTER (WHERE step_status IN ('pending', 'in_progress'))::INT,
      MIN(run_at) FILTER (WHERE step_status = 'pending')
    INTO v_prior_failed_count, v_prior_incomplete_count, v_prior_next_run_at
    FROM public.workflow_run_steps
    WHERE workflow_run_id = p_run.id
      AND sequence_order < p_step.sequence_order;

    IF v_prior_failed_count > 0 THEN
      v_response.status := 'failed';
      v_response.workflow_status := 'failed';
      v_response.last_error := 'workflow_control_blocked_by_failed_prior_step';
      v_response.operation_result := jsonb_build_object(
        'status', 'failed',
        'reason', 'workflow_control_blocked_by_failed_prior_step',
        'prior_failed_count', v_prior_failed_count
      );
      RETURN v_response;
    END IF;

    IF v_prior_incomplete_count > 0 THEN
      v_response.status := 'pending';
      v_response.next_run_at := COALESCE(v_prior_next_run_at, now() + interval '1 second');
      v_response.operation_result := jsonb_build_object(
        'status', 'pending',
        'reason', 'workflow_control_waiting_for_prior_steps',
        'prior_incomplete_count', v_prior_incomplete_count
      );
      RETURN v_response;
    END IF;

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

COMMENT ON FUNCTION workflow_handlers.execute_workflow_control_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Control workflow completion/failure with ordering guards so terminal steps wait for prior steps to finish.';

SELECT pg_advisory_unlock(hashtext('202603061360_workflow_control_complete_order_guard'));
COMMIT;

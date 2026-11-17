-- Migration: Wait workflow polling uses workflow defaults
-- Purpose:
--   - Use workflow_defaults poll bounds for wait_workflow when metadata is absent.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_wait_for_workflow_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'workflow_handlers', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_child_run_id UUID;
    v_child_run_id_metadata UUID;
    v_child_run workflow_runs%ROWTYPE;
    v_poll_seconds INT := NULL;
    v_poll_default INT := NULL;
    v_poll_min INT := NULL;
    v_poll_max INT := NULL;
    v_max_wait_seconds INT := COALESCE(NULLIF(v_metadata->>'max_wait_seconds', '')::INT, 900);
    v_elapsed_seconds INT := 0;
    v_policy_row RECORD;
    v_defaults JSONB;
    v_response workflow_handler_response;
    v_now TIMESTAMPTZ := now();
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row_from_context('workflow_defaults', COALESCE(p_run.context, '{}'::jsonb))
     LIMIT 1;
    v_defaults := v_policy_row.value;
    IF v_defaults IS NULL THEN
      v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
    END IF;

    BEGIN
      v_poll_seconds := NULLIF(v_metadata->>'poll_interval_seconds', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_poll_seconds := NULL;
    END;
    BEGIN
      v_poll_default := NULLIF(v_defaults->>'poll_seconds', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_poll_default := NULL;
    END;
    BEGIN
      v_poll_min := NULLIF(v_defaults->>'poll_seconds_min', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_poll_min := NULL;
    END;
    BEGIN
      v_poll_max := NULLIF(v_defaults->>'poll_seconds_max', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_poll_max := NULL;
    END;

    IF v_poll_seconds IS NULL THEN
      v_poll_seconds := COALESCE(v_poll_min, v_poll_default, 30);
    END IF;
    v_poll_min := COALESCE(v_poll_min, v_poll_seconds);
    v_poll_max := COALESCE(v_poll_max, v_poll_seconds);
    v_poll_seconds := LEAST(GREATEST(v_poll_seconds, v_poll_min), v_poll_max);

    SELECT
        (operation_result->>'child_workflow_run_id')::UUID,
        (metadata->>'child_workflow_run_id')::UUID
    INTO v_child_run_id, v_child_run_id_metadata
    FROM workflow_run_steps
    WHERE workflow_run_id = p_step.workflow_run_id
      AND sequence_order < p_step.sequence_order
      AND handler_key = 'start_workflow'
    ORDER BY sequence_order DESC
    LIMIT 1;

    IF v_child_run_id IS NULL THEN
        v_child_run_id := COALESCE(
            NULLIF(v_metadata->>'child_workflow_run_id', '')::UUID,
            NULLIF(p_operation_result->>'child_workflow_run_id', '')::UUID,
            NULLIF(p_run.context->>'latest_child_workflow_run_id', '')::UUID
        );
    END IF;

    IF v_child_run_id IS NULL THEN
        v_child_run_id := v_child_run_id_metadata;
    END IF;

    IF v_child_run_id IS NULL THEN
        SELECT id
        INTO v_child_run_id
        FROM workflow_runs
        WHERE metadata->>'started_by_run_id' = p_step.workflow_run_id::TEXT
          AND metadata->>'started_by_step_id' = p_step.workflow_template_step_id::TEXT
        ORDER BY created_at DESC
        LIMIT 1;
    END IF;

    IF v_child_run_id IS NULL THEN
        RAISE EXCEPTION 'execute_wait_for_workflow_v1: child workflow run id missing for step %', p_step.id;
    END IF;

    SELECT * INTO v_child_run FROM workflow_runs WHERE id = v_child_run_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_wait_for_workflow_v1: child workflow run % not found', v_child_run_id;
    END IF;

    IF p_step.operation_started_at IS NOT NULL THEN
        v_elapsed_seconds := GREATEST(0, (extract(epoch FROM (v_now - p_step.operation_started_at)))::INT);
    END IF;

    IF v_child_run.workflow_status = 'completed' THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'child_workflow_run_id', v_child_run_id,
            'status', v_child_run.workflow_status,
            'completed_at', v_child_run.completed_at
        );
        v_response.context_patch := jsonb_build_object(
            'latest_child_workflow_status', jsonb_build_object(
                'workflow_run_id', v_child_run_id,
                'status', v_child_run.workflow_status,
                'completed_at', v_child_run.completed_at
            )
        );
        RETURN v_response;
    ELSIF v_child_run.workflow_status IN ('failed', 'cancelled') THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := COALESCE(v_child_run.failure_reason, 'child_workflow_failed');
        v_response.operation_result := jsonb_build_object(
            'child_workflow_run_id', v_child_run_id,
            'status', v_child_run.workflow_status,
            'failure_reason', v_child_run.failure_reason
        );
        RETURN v_response;
    ELSIF v_elapsed_seconds >= v_max_wait_seconds THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := 'child_workflow_timeout';
        v_response.operation_result := jsonb_build_object(
            'child_workflow_run_id', v_child_run_id,
            'status', v_child_run.workflow_status,
            'timeout_seconds', v_max_wait_seconds
        );
        RETURN v_response;
    ELSE
        v_response.status := 'pending';
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.next_run_at := v_now + make_interval(secs => v_poll_seconds);
        v_response.operation_result := jsonb_build_object(
            'child_workflow_run_id', v_child_run_id,
            'status', v_child_run.workflow_status,
            'next_poll_seconds', v_poll_seconds
        );
        RETURN v_response;
    END IF;
END;
$function$;

COMMIT;

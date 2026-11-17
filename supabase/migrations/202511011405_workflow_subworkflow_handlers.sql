-- Migration: Workflow sub-workflow handlers
-- Purpose: Enable workflow steps to launch and await nested workflows dynamically.
-- Date: 2025-11-01

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_start_workflow_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_template_id UUID;
    v_child_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_context_patch JSONB := COALESCE(v_metadata->'context_patch', '{}'::jsonb);
    v_child_run_id UUID;
    v_now TIMESTAMPTZ := now();
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);
    v_template_id := COALESCE(
        NULLIF(v_metadata->>'child_workflow_template_id', '')::UUID,
        NULLIF(v_metadata->>'workflow_template_id', '')::UUID,
        NULLIF(p_operation_result->>'child_workflow_template_id', '')::UUID
    );

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'execute_start_workflow_v1: child workflow template id missing for step %', p_step.id;
    END IF;

    IF v_context_patch IS NOT NULL AND jsonb_typeof(v_context_patch) = 'object' THEN
        v_child_context := v_child_context || v_context_patch;
    END IF;

    v_child_run_id := start_workflow_run(v_template_id, v_child_context);

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'child_workflow_run_id', v_child_run_id,
        'child_workflow_template_id', v_template_id
    );
    v_response.context_patch := jsonb_build_object(
        'child_workflows',
            COALESCE(p_run.context->'child_workflows', '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
                'parent_step_id', p_step.workflow_template_step_id,
                'workflow_template_id', v_template_id,
                'workflow_run_id', v_child_run_id,
                'started_at', v_now
            )),
        'latest_child_workflow_run_id', v_child_run_id
    );

    UPDATE workflow_run_steps
    SET operation_result = v_response.operation_result,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('child_workflow_run_id', v_child_run_id),
        updated_at = v_now
    WHERE id = p_step.id;

    UPDATE workflow_runs
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'started_by_run_id', p_step.workflow_run_id,
            'started_by_step_id', p_step.workflow_template_step_id
        ),
        updated_at = v_now
    WHERE id = v_child_run_id;

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_start_workflow_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Launches a child workflow run via start_workflow_run and records linkage metadata.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_wait_for_workflow_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_child_run_id UUID;
    v_child_run_id_metadata UUID;
    v_child_run workflow_runs%ROWTYPE;
    v_poll_seconds INT := GREATEST(COALESCE(NULLIF(v_metadata->>'poll_interval_seconds', '')::INT, 30), 5);
    v_max_wait_seconds INT := COALESCE(NULLIF(v_metadata->>'max_wait_seconds', '')::INT, 900);
    v_elapsed_seconds INT := 0;
    v_response workflow_handler_response;
    v_now TIMESTAMPTZ := now();
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);
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
$$;

COMMENT ON FUNCTION workflow_handlers.execute_wait_for_workflow_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Polls a child workflow run until completion, failure, or timeout before continuing the parent workflow.';

INSERT INTO operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES
    (
        'start_workflow',
        'workflow_handlers',
        'execute_start_workflow_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Launches a child workflow run and records linkage metadata.',
        'docs/ops/runbooks/workflow_engine_runbook.md'
    ),
    (
        'wait_workflow',
        'workflow_handlers',
        'execute_wait_for_workflow_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Waits for a child workflow run to complete, fail, or timeout before continuing.',
        'docs/ops/runbooks/workflow_engine_runbook.md'
    )
ON CONFLICT (handler_key) DO UPDATE
SET
    handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

COMMIT;

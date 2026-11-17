-- Migration: Ensure workflow_mark_run_stopped sets workflow_status to 'stopped'
-- Date: 2025-12-01

BEGIN;

-- Align stop semantics with reply-intent expectations: stopped (not completed).
CREATE OR REPLACE FUNCTION public.workflow_mark_run_stopped(
    p_workflow_run_id UUID,
    p_reason TEXT,
    p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := public.workflow_now();
BEGIN
    IF to_regclass('public.workflow_run_steps') IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.workflow_run_steps
    SET step_status = 'skipped',
        operation_completed_at = COALESCE(operation_completed_at, v_now),
        operation_result = jsonb_build_object(
            'status', 'skipped',
            'reason', p_reason,
            'details', p_details
        ),
        updated_at = v_now
    WHERE workflow_run_id = p_workflow_run_id
      AND step_status IN ('pending', 'in_progress');

    UPDATE public.workflow_runs
    SET workflow_status = 'stopped',
        current_step_id = NULL,
        completed_at = COALESCE(completed_at, v_now),
        metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{stop_reason}',
            to_jsonb(COALESCE(p_reason, 'stop_condition_met')),
            TRUE
        ),
        context = jsonb_set(
            COALESCE(context, '{}'::jsonb),
            '{workflow,stop_reason}',
            to_jsonb(COALESCE(p_reason, 'stop_condition_met')),
            TRUE
        ),
        updated_at = v_now
    WHERE id = p_workflow_run_id;
END;
$$;

COMMIT;

-- Migration: Ensure webhook processor worker finalizes completed workflow runs
-- Date: 2025-12-16 11:10 UTC
--
-- Problem:
-- - progress_workflow_run() marks a run as completed only when invoked and it finds no pending steps.
-- - run_webhook_processor_worker() previously selected runs only when:
--     - current_step_id IS NULL, OR
--     - there is a pending step with run_at <= now(), OR
--     - there is an in_progress step without operation_completed_at.
-- - If a run completes its last step inside a worker tick, it can be left in workflow_status='in_progress'
--   with all steps completed and current_step_id still set; it is then never selected again, so it never
--   transitions to workflow_status='completed'.
--
-- Fix:
-- - Extend worker selection to also pick "finalizable" runs: in_progress with no pending steps and no
--   active in_progress steps, allowing progress_workflow_run() to mark them completed.

BEGIN;

CREATE OR REPLACE FUNCTION public.run_webhook_processor_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_pending_run RECORD;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('webhook_processor_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('webhook_processor_worker');

    FOR v_pending_run IN
        SELECT id
        FROM workflow_runs
        WHERE workflow_status IN ('pending', 'in_progress')
          AND (
                current_step_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM workflow_run_steps wrs
                    WHERE wrs.workflow_run_id = workflow_runs.id
                      AND wrs.step_status = 'pending'
                      AND wrs.run_at <= now()
                )
                OR EXISTS (
                    SELECT 1
                    FROM workflow_run_steps wrs
                    WHERE wrs.workflow_run_id = workflow_runs.id
                      AND wrs.step_status = 'in_progress'
                      AND wrs.operation_completed_at IS NULL
                )
                OR (
                    workflow_status = 'in_progress'
                    AND completed_at IS NULL
                    AND NOT EXISTS (
                        SELECT 1
                        FROM workflow_run_steps wrs
                        WHERE wrs.workflow_run_id = workflow_runs.id
                          AND wrs.step_status = 'pending'
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM workflow_run_steps wrs
                        WHERE wrs.workflow_run_id = workflow_runs.id
                          AND wrs.step_status = 'in_progress'
                          AND wrs.operation_completed_at IS NULL
                    )
                )
          )
        ORDER BY created_at ASC
        LIMIT v_throttle.batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            PERFORM progress_workflow_run(v_pending_run.id);
            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('webhook_processor_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error', v_error
    );
END;
$function$;

COMMIT;


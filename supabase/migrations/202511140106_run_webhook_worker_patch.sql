-- Migration: Update webhook processor worker to skip legacy start when actions exist
-- Purpose: Prevent duplicate workflow runs and preserve workflow follow-up run linkage
-- Date: 2025-11-14

BEGIN;

CREATE OR REPLACE FUNCTION run_webhook_processor_worker()
RETURNS JSON
LANGUAGE plpgsql
AS $function$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_row RECORD;
    v_result JSONB;
    v_processing_context JSONB;
    v_action_results JSONB := '[]'::jsonb;
    v_org UUID;
    v_action JSONB;
    v_additional_result JSONB;
    v_pending_run RECORD;
    v_workflow_progress_count INT := 0;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('webhook_processor_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('webhook_processor_worker');

    FOR v_row IN
        SELECT
            wi.id AS webhook_id,
            ws.organization_id,
            wi.ack_outcome,
            wi.ack_reason,
            wi.policy_settings_id,
            wi.policy_scope_type,
            wi.policy_scope_id,
            wi.policy_version
        FROM webhook_inbox wi
        JOIN webhook_sources ws ON ws.id = wi.webhook_source_id
        WHERE wi.processing_status = 'pending'
        ORDER BY wi.created_at ASC
        LIMIT v_throttle.batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            IF v_row.ack_outcome IS NOT NULL AND v_row.ack_outcome <> 'ack_sent' THEN
                UPDATE webhook_inbox
                SET processing_status = 'skipped',
                    processed_at = now()
                WHERE id = v_row.webhook_id;

                v_org := COALESCE(
                    v_row.organization_id,
                    resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                );

                v_processing_context := NULL;

                PERFORM create_ops_alert_for_webhook(
                    COALESCE(
                        v_row.organization_id,
                        resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                    ),
                    v_row.webhook_id,
                    format('Webhook processing skipped because acknowledgement outcome=%s', v_row.ack_outcome),
                    jsonb_build_object(
                        'ack_outcome', v_row.ack_outcome,
                        'ack_reason', v_row.ack_reason,
                        'policy_settings_id', v_row.policy_settings_id,
                        'policy_scope_type', v_row.policy_scope_type,
                        'policy_scope_id', v_row.policy_scope_id,
                        'policy_version', v_row.policy_version
                    ),
                    'critical'
                );

                CONTINUE;
            END IF;

            v_result := orchestrate_webhook_processing(v_row.webhook_id);

            v_processing_context := jsonb_build_object(
                'organization_id', COALESCE(
                    v_row.organization_id,
                    resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                ),
                'policy_settings_id', v_result->>'policy_settings_id',
                'policy_scope_type', v_result->>'policy_scope_type',
                'policy_scope_id', v_result->>'policy_scope_id',
                'policy_version', v_result->>'policy_version',
                'transformed_payload', v_result->'transformed_payload',
                'webhook', v_result->'webhook',
                'workflow_followup_workflow_id', v_result->'workflow_followup_workflow_id',
                'correlation_id', v_result->>'correlation_id'
            );

            v_action_results := execute_workflow_followup_actions(
                v_row.webhook_id,
                v_result->'workflow_followup_actions',
                v_processing_context
            );

            FOR v_action IN
                SELECT elem
                FROM jsonb_array_elements(v_action_results) elem
                WHERE elem->>'workflow_run_id' IS NOT NULL
            LOOP
                PERFORM progress_workflow_run((v_action->>'workflow_run_id')::UUID);
                v_workflow_progress_count := v_workflow_progress_count + 1;
            END LOOP;

            IF v_result->'workflow_followup_workflow_id' IS NOT NULL THEN
                IF jsonb_array_length(COALESCE(v_action_results, '[]'::jsonb)) = 0
                   AND NOT EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(COALESCE(v_result->'workflow_followup_actions', '[]'::jsonb)) elem
                        WHERE elem->>'handler_key' = 'start_workflow'
                   )
                THEN
                    v_additional_result := worker_action_start_workflow(
                        v_row.webhook_id,
                        jsonb_build_object('handler_key', 'start_workflow'),
                        v_processing_context
                    );
                    v_action_results := v_action_results || jsonb_build_array(v_additional_result);

                    IF v_additional_result ? 'workflow_run_id' THEN
                        PERFORM progress_workflow_run((v_additional_result->>'workflow_run_id')::UUID);
                        v_workflow_progress_count := v_workflow_progress_count + 1;
                    END IF;
                END IF;
            END IF;

            v_result := v_result || jsonb_build_object(
                'workflow_followup_action_results', v_action_results
            );

            IF COALESCE(v_result->>'status', 'unknown') NOT IN ('completed', 'success', 'processed', 'in_progress') THEN
                PERFORM create_ops_alert_for_webhook(
                    v_org,
                    v_row.webhook_id,
                    format('Webhook processing returned status=%s', COALESCE(v_result->>'status', 'unknown')),
                    jsonb_build_object(
                        'status', COALESCE(v_result->>'status', 'unknown'),
                        'policy_settings_id', v_result->>'policy_settings_id',
                        'policy_scope_type', v_result->>'policy_scope_type',
                        'policy_scope_id', v_result->>'policy_scope_id',
                        'action_results', v_action_results
                    ),
                    'critical'
                );
            END IF;

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                UPDATE webhook_inbox
                SET processing_status = 'failed',
                    error_message = SQLERRM,
                    processed_at = now()
                WHERE id = v_row.webhook_id;

                v_org := COALESCE(
                    v_row.organization_id,
                    resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                );

                PERFORM create_ops_alert_for_webhook(
                    COALESCE(
                        v_row.organization_id,
                        resolve_organization_id_strict('webhook_inbox', v_row.webhook_id)
                    ),
                    v_row.webhook_id,
                    format('Webhook processing error: %s', SQLERRM),
                    jsonb_build_object(
                        'error', SQLERRM,
                        'ack_outcome', v_row.ack_outcome
                    ),
                    'critical'
                );
        END;
    END LOOP;

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
          )
        ORDER BY created_at ASC
        LIMIT LEAST(v_throttle.batch_size, 5)
        FOR UPDATE SKIP LOCKED
    LOOP
        PERFORM progress_workflow_run(v_pending_run.id);
        v_workflow_progress_count := v_workflow_progress_count + 1;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('webhook_processor_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'workflow_progressed', v_workflow_progress_count,
        'error', v_error
    );
END;
$function$;

COMMENT ON FUNCTION run_webhook_processor_worker()
    IS 'Process webhook inbox rows and advance workflows while respecting scheduled run_at timestamps.';

COMMIT;



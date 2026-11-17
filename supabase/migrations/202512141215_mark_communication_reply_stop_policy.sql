-- Migration: Policy-driven workflow stop on inbound replies
-- Purpose:
--   - Update worker_action_mark_communication_reply to stop workflows only when instructed (stop_workflow=true)
--   - Preserve reply_received context/metadata updates for observability
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.worker_action_mark_communication_reply(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := public.workflow_now();
    v_transformed JSONB := COALESCE(p_context->'transformed_payload', '{}'::jsonb);
    v_comm JSONB := COALESCE(v_transformed->'communication', '{}'::jsonb);
    v_recipient TEXT := NULLIF(v_comm->>'recipient', '');
    v_correlation TEXT := NULLIF(v_comm->>'correlation_id', '');
    v_message_id TEXT := NULLIF(v_comm->>'message_id', '');
    v_run_id UUID;
    v_context_row JSONB;
    v_metadata JSONB;
    v_stop_reason TEXT := COALESCE(NULLIF(p_action->>'stop_reason', ''), 'reply_received');
    v_stop_workflow BOOLEAN := COALESCE(NULLIF(p_action->>'stop_workflow', '')::BOOLEAN, FALSE);
BEGIN
    IF v_recipient IS NULL AND v_correlation IS NULL THEN
        RETURN jsonb_build_object(
            'handler_key', 'mark_communication_reply',
            'status', 'skipped',
            'reason', 'missing_identifiers'
        );
    END IF;

    SELECT id
      INTO v_run_id
      FROM public.workflow_runs
     WHERE workflow_status IN ('pending', 'in_progress')
       AND (
            (v_correlation IS NOT NULL AND (
                context->>'correlation_id' = v_correlation
             OR context->'communication'->>'correlation_id' = v_correlation
            ))
         OR (v_recipient IS NOT NULL AND (
                context->'communication'->>'recipient' = v_recipient
             OR context->'transformed_payload'->'shipment'->'customer'->>'phone' = v_recipient
             OR context->'transformed_payload'->'payload'->'shipment'->'customer'->>'phone' = v_recipient
            ))
          )
     ORDER BY created_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'handler_key', 'mark_communication_reply',
            'status', 'skipped',
            'reason', 'workflow_not_found',
            'recipient', v_recipient,
            'correlation_id', v_correlation
        );
    END IF;

    SELECT context, metadata
      INTO v_context_row, v_metadata
      FROM public.workflow_runs
     WHERE id = v_run_id
     FOR UPDATE;

    v_context_row := COALESCE(v_context_row, '{}'::jsonb);
    v_context_row := jsonb_set(
        v_context_row,
        '{communication,reply_received}',
        'true'::jsonb,
        TRUE
    );
    v_context_row := jsonb_set(
        v_context_row,
        '{communication,last_reply}',
        jsonb_build_object(
            'received_at', v_now,
            'recipient', v_recipient,
            'correlation_id', v_correlation,
            'message_id', v_message_id,
            'payload', v_transformed
        ),
        TRUE
    );

    v_metadata := jsonb_set(
        COALESCE(v_metadata, '{}'::jsonb),
        '{last_reply}',
        jsonb_build_object(
            'received_at', v_now,
            'recipient', v_recipient,
            'correlation_id', v_correlation,
            'message_id', v_message_id,
            'webhook_id', p_webhook_id
        ),
        TRUE
    );

    UPDATE public.workflow_runs
       SET context = v_context_row,
           metadata = v_metadata,
           updated_at = v_now
     WHERE id = v_run_id;

    IF v_stop_workflow THEN
        PERFORM public.workflow_mark_run_stopped(
            v_run_id,
            v_stop_reason,
            jsonb_build_object(
                'source', 'communication_reply',
                'webhook_id', p_webhook_id,
                'recipient', v_recipient,
                'correlation_id', v_correlation
            )
        );
    END IF;

    RETURN jsonb_build_object(
        'handler_key', 'mark_communication_reply',
        'status', 'completed',
        'workflow_run_id', v_run_id,
        'recipient', v_recipient,
        'correlation_id', v_correlation,
        'stopped', v_stop_workflow
    );
END;
$$;

COMMENT ON FUNCTION public.worker_action_mark_communication_reply(UUID, JSONB, JSONB)
    IS 'Set communication.reply_received + last_reply; stop the run only when stop_workflow=true (policy-driven).';

COMMIT;


-- Migration: Communication reply stop automation
-- Purpose: Capture 360dialog WhatsApp replies and mark related workflows stopped via metadata.
-- Date: 2025-10-18

BEGIN;

-- ============================================================================
-- Worker action: mark communication reply
-- ============================================================================

CREATE OR REPLACE FUNCTION worker_action_mark_communication_reply(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now TIMESTAMPTZ := workflow_now();
    v_transformed JSONB := COALESCE(p_context->'transformed_payload', '{}'::jsonb);
    v_comm JSONB := COALESCE(v_transformed->'communication', '{}'::jsonb);
    v_recipient TEXT := NULLIF(v_comm->>'recipient', '');
    v_correlation TEXT := NULLIF(v_comm->>'correlation_id', '');
    v_message_id TEXT := NULLIF(v_comm->>'message_id', '');
    v_run_id UUID;
    v_context JSONB;
    v_metadata JSONB;
    v_stop_reason TEXT := COALESCE(NULLIF(p_action->>'stop_reason', ''), 'reply_received');
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
    FROM workflow_runs
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
    INTO v_context, v_metadata
    FROM workflow_runs
    WHERE id = v_run_id
    FOR UPDATE;

    v_context := COALESCE(v_context, '{}'::jsonb);
    v_context := jsonb_set(
        v_context,
        '{communication,reply_received}',
        'true'::jsonb,
        TRUE
    );
    v_context := jsonb_set(
        v_context,
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

    UPDATE workflow_runs
    SET context = v_context,
        metadata = v_metadata,
        updated_at = v_now
    WHERE id = v_run_id;

    PERFORM workflow_mark_run_stopped(
        v_run_id,
        v_stop_reason,
        jsonb_build_object(
            'source', 'communication_reply',
            'webhook_id', p_webhook_id,
            'recipient', v_recipient,
            'correlation_id', v_correlation
        )
    );

    RETURN jsonb_build_object(
        'handler_key', 'mark_communication_reply',
        'status', 'completed',
        'workflow_run_id', v_run_id,
        'recipient', v_recipient,
        'correlation_id', v_correlation
    );
END;
$$;

COMMENT ON FUNCTION worker_action_mark_communication_reply(UUID, JSONB, JSONB)
    IS 'Set communication.reply_received flag and mark workflow stopped when inbound replies arrive.';

INSERT INTO worker_action_handlers (handler_key, function_name, description, is_active)
VALUES (
    'mark_communication_reply',
    'public.worker_action_mark_communication_reply',
    'Mark workflow communication reply flag and stop the run dynamically.',
    TRUE
)
ON CONFLICT (handler_key) DO UPDATE
SET function_name = EXCLUDED.function_name,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active;

-- Pre-GA rebaseline note:
-- Dialog360 reply webhook source + policy fixture seeding was removed from
-- active migrations. Tests now seed these rows through bootstrap scripts.

COMMIT;

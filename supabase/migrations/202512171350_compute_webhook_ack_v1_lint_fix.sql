-- Migration: Fix compute_webhook_ack_v1 to avoid missing helper function
-- Purpose:
--   - Ensure workflow_handlers.compute_webhook_ack_v1 is lint-clean (no missing dependencies).
--   - Keep the handler safe/idempotent even if not used in the current webhook intake path.
-- Date: 2025-12-17

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.compute_webhook_ack_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_ack JSONB := COALESCE(v_context->'ack', '{}'::jsonb);
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_mode TEXT := COALESCE(v_ack->>'mode', 'accepted_async');
    v_status INT := COALESCE(
        NULLIF(v_ack->>'status', '')::INT,
        CASE WHEN v_mode = 'accepted_async' THEN 202 ELSE 200 END
    );
    v_outcome TEXT := COALESCE(v_ack->>'outcome', 'ack_sent');
    v_reason TEXT := NULLIF(v_ack->>'reason', '');
    v_header_defaults JSONB := COALESCE(v_ack->'header_defaults', v_ack->'default_headers', '{}'::jsonb);
    v_headers_final JSONB := COALESCE(v_header_defaults, '{}'::jsonb);
    v_body JSONB;
    v_response workflow_handler_response;
    v_ack_context JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_headers ? 'content-type' THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', v_headers->>'content-type');
    ELSIF NOT (v_headers_final ? 'content-type') THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', 'application/json');
    END IF;

    v_body := jsonb_strip_nulls(jsonb_build_object(
        'webhook_id', NULLIF(COALESCE(v_context->>'webhook_id', ''), '')::UUID,
        'correlation_id', NULLIF(COALESCE(v_context->>'correlation_id', ''), ''),
        'ack_outcome', v_outcome,
        'ack_reason', v_reason
    ));

    v_ack_context := jsonb_strip_nulls(jsonb_build_object(
        'mode', v_mode,
        'status', v_status,
        'headers', v_headers_final,
        'body', v_body,
        'outcome', v_outcome,
        'reason', v_reason
    ));

    v_response.status := 'completed';
    v_response.operation_result := v_ack_context;
    v_response.context_patch := jsonb_build_object('ack', v_ack_context);

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.compute_webhook_ack_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Compute webhook acknowledgement payload from workflow context (lint-safe fixup).';

COMMIT;


-- Migration: Pin compute_webhook_ack_v1 SECURITY DEFINER search_path
-- Purpose:
--   - pgTAP requires workflow_handlers SECURITY DEFINER functions to have
--     an explicit, safe search_path (proconfig) starting with public.
--   - Keeps compute_webhook_ack_v1 lint-safe and deterministic.
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
SET search_path TO public, extensions, pg_temp
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

COMMIT;


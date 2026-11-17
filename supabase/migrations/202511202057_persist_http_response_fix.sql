-- Migration: Align persist_http_response_v1 with new webhook_inbox schema
-- Date: 2025-11-20 20:57 UTC

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.persist_http_response_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_http JSONB := COALESCE(v_context->'http_response', '{}'::jsonb);
    v_validation JSONB := COALESCE(v_context->'validation', '{}'::jsonb);
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_transformed_payload JSONB := COALESCE(v_context->'transformed_payload', v_payload);
    v_followup_run_id UUID := NULLIF(v_context->>'followup_workflow_run_id', '')::UUID;
    v_webhook_id UUID := NULLIF(v_context->>'webhook_id', '')::UUID;
    v_source_id UUID := NULLIF(v_context->>'webhook_source_id', '')::UUID;
    v_provider_type TEXT := NULLIF(v_context->>'provider_type', '');
    v_correlation_id UUID := NULLIF(v_context->>'correlation_id', '')::UUID;
    v_idempotency_key TEXT := NULLIF(v_context->>'idempotency_key', '');
    v_policy_settings_id UUID := NULLIF(v_context->>'policy_settings_id', '')::UUID;
    v_policy_scope_type TEXT := NULLIF(v_context->>'policy_scope_type', '');
    v_policy_scope_id UUID := NULLIF(v_context->>'policy_scope_id', '')::UUID;
    v_policy_version INT := COALESCE((v_context->>'policy_version')::INT, 1);
    v_organization_id UUID := NULLIF(v_context->>'organization_id', '')::UUID;
    v_decision_point TEXT := COALESCE(
        NULLIF(v_context->>'response_decision_point', ''),
        NULLIF(v_context->>'ack_decision_point', ''),
        'workflow_intake_response'
    );
    v_mode TEXT := COALESCE(NULLIF(v_http->>'mode', ''), 'accepted_async');
    v_status INT := COALESCE((v_http->>'status')::INT, CASE WHEN v_mode = 'accepted_async' THEN 202 ELSE 200 END);
    v_headers_final JSONB := jsonb_strip_nulls(COALESCE(v_http->'headers', '{}'::jsonb));
    v_body JSONB := v_http->'body';
    v_outcome TEXT := COALESCE(NULLIF(v_http->>'outcome', ''), 'response_sent');
    v_reason TEXT := NULLIF(v_http->>'reason', '');
    v_sent_at TIMESTAMPTZ := now();
    v_processing_status TEXT;
    v_result workflow_handler_response;
    v_response_projection JSONB;
BEGIN
    IF v_webhook_id IS NULL OR v_source_id IS NULL THEN
        RAISE EXCEPTION 'persist_http_response_v1: webhook_id (%) and webhook_source_id (%) required', v_webhook_id, v_source_id;
    END IF;

    IF v_headers_final IS NULL OR v_headers_final::TEXT = 'null' THEN
        v_headers_final := '{}'::jsonb;
    END IF;

    IF NOT (v_headers_final ? 'content-type') THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', 'application/json');
    END IF;

    IF v_body IS NULL OR v_body::TEXT = 'null' THEN
        IF v_outcome = 'response_failed' THEN
            v_body := jsonb_build_object('error', COALESCE(v_reason, 'Webhook response failed'));
        ELSIF v_mode = 'accepted_async' THEN
            v_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_context->>'correlation_id'
            ));
        ELSE
            v_body := jsonb_build_object('status', 'accepted');
        END IF;
    END IF;

    IF v_outcome = 'response_failed' THEN
        v_status := GREATEST(v_status, 400);
    END IF;

    v_processing_status := CASE
        WHEN v_outcome = 'response_failed' THEN 'failed'
        ELSE 'in_progress'
    END;

    IF NOT EXISTS (SELECT 1 FROM webhook_inbox WHERE id = v_webhook_id) THEN
        PERFORM insert_webhook_inbox_record(
            v_webhook_id,
            v_source_id,
            COALESCE(v_provider_type, 'unknown'),
            v_payload,
            v_headers,
            v_processing_status,
            v_correlation_id,
            v_idempotency_key
        );
    END IF;

    UPDATE webhook_inbox
    SET
        idempotency_key = v_idempotency_key,
        policy_settings_id = v_policy_settings_id,
        policy_scope_type = v_policy_scope_type,
        policy_scope_id = v_policy_scope_id,
        policy_version = v_policy_version,
        workflow_run_id = p_run.id,
        provider_type = COALESCE(provider_type, v_provider_type),
        headers = v_headers,
        transformed_payload = v_transformed_payload,
        processing_status = v_processing_status,
        processed_at = CASE WHEN v_outcome = 'response_failed' THEN v_sent_at ELSE processed_at END,
        error_message = CASE WHEN v_outcome = 'response_failed' THEN v_reason ELSE NULL END
    WHERE id = v_webhook_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'persist_http_response_v1: webhook inbox % missing', v_webhook_id;
    END IF;

    PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := v_decision_point,
        p_decision_outcome := v_outcome,
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'headers', v_headers_final,
            'body', v_body,
            'mode', v_mode,
            'outcome', v_outcome,
            'reason', v_reason,
            'validation_results', v_validation,
            'idempotency_key', v_idempotency_key,
            'workflow_run_id', p_run.id,
            'workflow_run_step_id', p_step.id,
            'followup_workflow_run_id', v_followup_run_id,
            'sent_at', v_sent_at
        )),
        p_decision_reason := v_reason
    );

    v_response_projection := jsonb_strip_nulls(jsonb_build_object(
        'status', v_status,
        'headers', v_headers_final,
        'body', v_body,
        'mode', v_mode,
        'outcome', v_outcome,
        'reason', v_reason,
        'sent_at', v_sent_at
    ));

    v_result.status := 'completed';
    v_result.operation_result := v_response_projection;
    v_result.context_patch := jsonb_strip_nulls(
        jsonb_build_object(
            'http_response', v_response_projection,
            'followup_workflow_run_id', v_followup_run_id
        )
    );

    RETURN v_result;
END;
$function$;

COMMIT;

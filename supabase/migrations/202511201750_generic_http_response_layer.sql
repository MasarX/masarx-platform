-- Migration: Generic HTTP response foundation for webhook intake
-- Date: 2025-11-20 17:50 UTC

BEGIN;

-------------------------------------------------------------------------------
-- 1. Response history table (generic replacement for webhook_ack_history)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_response_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_inbox_id UUID NOT NULL REFERENCES webhook_inbox (id) ON DELETE CASCADE,
    webhook_source_id UUID NOT NULL REFERENCES webhook_sources (id) ON DELETE CASCADE,
    response_mode TEXT NOT NULL,
    http_status_code INT NOT NULL,
    http_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    http_body JSONB,
    response_outcome TEXT NOT NULL,
    response_reason TEXT,
    validation_results JSONB NOT NULL DEFAULT '{}'::jsonb,
    policy_settings_id UUID,
    policy_scope_type TEXT,
    policy_scope_id UUID,
    policy_version INT,
    idempotency_key TEXT,
    workflow_run_id UUID,
    workflow_run_step_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_response_history_inbox_id
    ON webhook_response_history (webhook_inbox_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_response_history_source_key
    ON webhook_response_history (webhook_source_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Seed from existing acknowledgement history if present.
INSERT INTO webhook_response_history (
    id,
    webhook_inbox_id,
    webhook_source_id,
    response_mode,
    http_status_code,
    http_headers,
    http_body,
    response_outcome,
    response_reason,
    validation_results,
    policy_settings_id,
    policy_scope_type,
    policy_scope_id,
    policy_version,
    idempotency_key,
    created_at
)
SELECT
    id,
    webhook_inbox_id,
    webhook_source_id,
    ack_mode,
    ack_status_code,
    COALESCE(ack_headers, '{}'::jsonb),
    ack_body,
    ack_outcome,
    ack_reason,
    COALESCE(validation_results, '{}'::jsonb),
    policy_settings_id,
    policy_scope_type,
    policy_scope_id,
    policy_version,
    idempotency_key,
    ack_sent_at
FROM webhook_ack_history
ON CONFLICT (id) DO NOTHING;

-------------------------------------------------------------------------------
-- 2. Trigger to keep legacy ack history and new response history in sync
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_webhook_ack_to_response_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
    INSERT INTO webhook_response_history (
        id,
        webhook_inbox_id,
        webhook_source_id,
        response_mode,
        http_status_code,
        http_headers,
        http_body,
        response_outcome,
        response_reason,
        validation_results,
        policy_settings_id,
        policy_scope_type,
        policy_scope_id,
        policy_version,
        idempotency_key,
        created_at
    )
    VALUES (
        NEW.id,
        NEW.webhook_inbox_id,
        NEW.webhook_source_id,
        NEW.ack_mode,
        NEW.ack_status_code,
        COALESCE(NEW.ack_headers, '{}'::jsonb),
        NEW.ack_body,
        NEW.ack_outcome,
        NEW.ack_reason,
        COALESCE(NEW.validation_results, '{}'::jsonb),
        NEW.policy_settings_id,
        NEW.policy_scope_type,
        NEW.policy_scope_id,
        NEW.policy_version,
        NEW.idempotency_key,
        NEW.ack_sent_at
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS webhook_ack_history_sync ON webhook_ack_history;
CREATE TRIGGER webhook_ack_history_sync
    AFTER INSERT ON webhook_ack_history
    FOR EACH ROW
    EXECUTE FUNCTION sync_webhook_ack_to_response_history();

-------------------------------------------------------------------------------
-- 3. Enforce idempotency per source/key on inbox (nullable friendly)
-------------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_inbox_source_idempotency
    ON webhook_inbox (webhook_source_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-------------------------------------------------------------------------------
-- 4. Generic HTTP response handlers (wrappers around existing ack handlers)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.render_http_response_v1(
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
    v_policy JSONB := COALESCE(v_context->'policy', '{}'::jsonb);
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_validation JSONB := COALESCE(v_context->'validation', '{}'::jsonb);
    v_response JSONB := COALESCE(v_context->'http_response', '{}'::jsonb);
    v_response_mapping_id UUID := NULLIF(v_context->>'response_mapping_id', '')::UUID;
    v_mapping JSONB;
    v_mode TEXT := COALESCE(v_response->>'mode', COALESCE(v_policy->'ack'->>'mode', 'accepted_async'));
    v_status INT := COALESCE(
        NULLIF(v_response->>'status', '')::INT,
        COALESCE((v_policy->'ack'->>'status_code')::INT, CASE WHEN v_mode = 'accepted_async' THEN 202 ELSE 200 END)
    );
    v_outcome TEXT := COALESCE(NULLIF(v_response->>'outcome', ''), COALESCE(v_policy->'ack'->>'default_outcome', 'response_sent'));
    v_reason TEXT := NULLIF(v_response->>'reason', '');
    v_header_defaults JSONB := COALESCE(v_policy->'ack'->'default_headers', '{}'::jsonb);
    v_headers_final JSONB := jsonb_strip_nulls(COALESCE(v_response->'headers', v_header_defaults, '{}'::jsonb));
    v_body JSONB := v_response->'body';
    v_result workflow_handler_response;
    v_http_context JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_response_mapping_id IS NOT NULL THEN
        SELECT mapping_config
        INTO v_mapping
        FROM mapping_configs
        WHERE id = v_response_mapping_id;
    END IF;

    IF v_mapping ? 'status_code' THEN
        v_status := COALESCE((v_mapping->>'status_code')::INT, v_status);
    END IF;

    IF v_mapping ? 'headers' THEN
        v_headers_final := jsonb_strip_nulls(COALESCE(v_mapping->'headers', '{}'::jsonb));
    END IF;

    IF v_mapping ? 'body' THEN
        v_body := render_template(
            v_mapping->'body',
            jsonb_build_object(
                'webhook', jsonb_strip_nulls(jsonb_build_object(
                    'id', v_context->>'webhook_id',
                    'correlation_id', v_context->>'correlation_id',
                    'source_identifier', v_context->>'source_identifier'
                )),
                'payload', v_payload,
                'headers', v_headers,
                'policy', v_policy,
                'validation', v_validation
            )
        );
    END IF;

    IF v_body IS NULL OR v_body::TEXT = 'null' THEN
        IF v_mode = 'accepted_async' THEN
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
        v_body := jsonb_build_object('error', COALESCE(v_reason, 'Webhook response failed'));
    END IF;

    IF v_headers_final IS NULL OR v_headers_final::TEXT = 'null' THEN
        v_headers_final := '{}'::jsonb;
    END IF;

    IF NOT (v_headers_final ? 'content-type') THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', 'application/json');
    END IF;

    v_http_context := jsonb_strip_nulls(jsonb_build_object(
        'status', v_status,
        'headers', v_headers_final,
        'body', v_body,
        'mode', v_mode,
        'outcome', v_outcome,
        'reason', v_reason
    ));

    v_result.status := 'completed';
    v_result.operation_result := v_http_context;
    v_result.context_patch := jsonb_build_object('http_response', v_http_context);

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.render_http_response_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Render provider webhook HTTP response (wrapper over legacy ack handler).';

CREATE OR REPLACE FUNCTION workflow_handlers.persist_http_response_v1(
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
    v_http JSONB := COALESCE(v_context->'http_response', '{}'::jsonb);
    v_validation JSONB := COALESCE(v_context->'validation', '{}'::jsonb);
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_transformed_payload JSONB := COALESCE(v_context->'transformed_payload', v_payload);
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
    v_history_id UUID;
    v_result workflow_handler_response;
    v_response_projection JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

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

    IF NOT EXISTS (SELECT 1 FROM webhook_inbox WHERE id = v_webhook_id) THEN
        PERFORM insert_webhook_inbox_record(
            v_webhook_id,
            v_source_id,
            COALESCE(v_provider_type, 'unknown'),
            v_payload,
            v_headers,
            'in_progress',
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
        processing_status = 'in_progress',
        organization_id = COALESCE(organization_id, v_organization_id),
        provider_type = COALESCE(provider_type, v_provider_type),
        headers = v_headers,
        transformed_payload = v_transformed_payload,
        updated_at = v_sent_at
    WHERE id = v_webhook_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'persist_http_response_v1: webhook inbox % missing', v_webhook_id;
    END IF;

    INSERT INTO webhook_response_history (
        id,
        webhook_inbox_id,
        webhook_source_id,
        response_mode,
        http_status_code,
        http_headers,
        http_body,
        response_outcome,
        response_reason,
        validation_results,
        policy_settings_id,
        policy_scope_type,
        policy_scope_id,
        policy_version,
        idempotency_key,
        workflow_run_id,
        workflow_run_step_id,
        created_at
    )
    VALUES (
        gen_random_uuid(),
        v_webhook_id,
        v_source_id,
        v_mode,
        v_status,
        v_headers_final,
        v_body,
        v_outcome,
        v_reason,
        COALESCE(v_validation, '{}'::jsonb),
        v_policy_settings_id,
        v_policy_scope_type,
        v_policy_scope_id,
        v_policy_version,
        v_idempotency_key,
        p_run.id,
        p_step.id,
        v_sent_at
    )
    RETURNING id INTO v_history_id;

    PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'webhook_http_response',
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
            'validation_results', v_validation,
            'idempotency_key', v_idempotency_key
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
        'history_id', v_history_id,
        'sent_at', v_sent_at
    ));

    v_result.status := 'completed';
    v_result.operation_result := v_response_projection;
    v_result.context_patch := jsonb_strip_nulls(
        COALESCE(v_result.context_patch, '{}'::jsonb) ||
        jsonb_build_object('http_response', v_response_projection)
    );

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.persist_http_response_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Persist webhook HTTP response snapshot/history owned by the workflow engine.';

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
        'render_http_response',
        'workflow_handlers',
        'render_http_response_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Render HTTP response payload for webhook intake (generic wrapper).',
        'docs/ops/runbooks/webhook_engine_runbook.md'
    ),
    (
        'persist_http_response',
        'workflow_handlers',
        'persist_http_response_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Persist HTTP response metadata and history (generic wrapper).',
        'docs/ops/runbooks/webhook_engine_runbook.md'
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

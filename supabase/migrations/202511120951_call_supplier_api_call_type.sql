-- Migration: call_supplier_api call type propagation
-- Purpose: Ensure worker_action_call_supplier_api respects operation_templates.call_type.
-- Date: 2025-11-12

BEGIN;

CREATE OR REPLACE FUNCTION worker_action_call_supplier_api(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_operation_text TEXT;
    v_operation_id UUID;
    v_operation operation_templates%ROWTYPE;
    v_call_type TEXT;
    v_outbound_id UUID;
    v_priority INT;
    v_max_retries INT;
    v_org UUID;
    v_correlation UUID;
BEGIN
    v_operation_text := COALESCE(
        p_action->>'operation_template_id',
        p_action->'arguments'->>'operation_template_id'
    );

    IF v_operation_text IS NULL OR trim(v_operation_text) = '' THEN
        RETURN jsonb_build_object(
            'handler_key', 'call_supplier_api',
            'status', 'skipped',
            'reason', 'missing_operation_template_id'
        );
    END IF;

    BEGIN
        v_operation_id := v_operation_text::UUID;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN jsonb_build_object(
                'handler_key', 'call_supplier_api',
                'status', 'skipped',
                'reason', 'invalid_operation_template_id'
            );
    END;

    SELECT *
    INTO v_operation
    FROM operation_templates
    WHERE id = v_operation_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'handler_key', 'call_supplier_api',
            'status', 'skipped',
            'reason', 'operation_template_not_found'
        );
    END IF;

    v_call_type := COALESCE(NULLIF(v_operation.call_type, ''), 'provider_api');

    BEGIN
        v_priority := COALESCE((p_action->'arguments'->>'priority')::INT, 100);
    EXCEPTION
        WHEN OTHERS THEN
            v_priority := 100;
    END;

    BEGIN
        v_max_retries := COALESCE((p_action->'arguments'->>'max_retries')::INT, 3);
    EXCEPTION
        WHEN OTHERS THEN
            v_max_retries := 3;
    END;

    INSERT INTO outbound_calls (
        call_type,
        target_type,
        target_id,
        method,
        url,
        headers,
        body,
        priority,
        max_retries,
        context,
        correlation_id
    )
    VALUES (
        v_call_type,
        'provider',
        v_operation.provider_id,
        v_operation.method,
        v_operation.url_template,
        COALESCE(v_operation.headers_template, '{}'::jsonb),
        COALESCE(v_operation.body_template, '{}'::jsonb),
        v_priority,
        v_max_retries,
        jsonb_build_object(
            'webhook_id', p_webhook_id,
            'action', p_action,
            'transformed_payload', p_context->'transformed_payload'
        ),
        CASE
            WHEN p_context ? 'correlation_id' AND (p_context->>'correlation_id') <> '' THEN
                (p_context->>'correlation_id')::UUID
            ELSE NULL
        END
    )
    RETURNING id INTO v_outbound_id;

    v_org := NULL;
    IF p_context ? 'organization_id' AND (p_context->>'organization_id') <> '' THEN
        BEGIN
            v_org := (p_context->>'organization_id')::UUID;
        EXCEPTION
            WHEN OTHERS THEN
                v_org := NULL;
        END;
    END IF;

    v_correlation := NULL;
    IF p_context ? 'correlation_id' AND (p_context->>'correlation_id') <> '' THEN
        BEGIN
            v_correlation := (p_context->>'correlation_id')::UUID;
        EXCEPTION
            WHEN OTHERS THEN
                v_correlation := NULL;
        END;
    END IF;

    IF v_org IS NOT NULL THEN
        PERFORM log_decision(
            p_organization_id := v_org,
            p_decision_category := 'webhook_processing',
            p_resource_type := 'webhook_inbox',
            p_resource_id := p_webhook_id,
            p_decision_point := 'workflow_followup_action:call_supplier_api',
            p_decision_outcome := 'create_job',
            p_performed_by_system := 'webhook_processor_worker',
            p_correlation_id := v_correlation,
            p_decision_inputs := jsonb_build_object(
                'action', p_action,
                'outbound_call_id', v_outbound_id
            ),
            p_decision_reason := NULL
        );
    END IF;

    RETURN jsonb_build_object(
        'handler_key', 'call_supplier_api',
        'status', 'queued',
        'outbound_call_id', v_outbound_id
    );
END;
$$;

COMMIT;

